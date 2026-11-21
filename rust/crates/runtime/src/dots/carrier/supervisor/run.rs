use super::{
    CleanupError, CleanupFailure, Opened, Shared,
    diagnostic::{Diagnostic, End, Summary},
    enroll::{self, Failure, Fence},
    sessions,
};
use crate::dots::carrier::{cancelled, relay, rendezvous, until};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;
use ycoding_core::{
    dots::{access, enrollment::registry, native, noise},
    ycoding_schema::{JsonValue, ObjectEncoder},
};

pub(super) const RECONNECT_INITIAL_MS: u64 = 1_000;
pub(super) const RECONNECT_MAX_MS: u64 = 30_000;
pub(super) const STABLE_CONNECTION_MS: u64 = 120_000;

pub(super) fn reconnect_delay(backoff_ms: u64, random: f64) -> u64 {
    let lower = backoff_ms / 2;
    lower + (random * (backoff_ms - lower + 1) as f64).floor() as u64
}

fn definitive_rejection(status: u16) -> bool {
    (400..500).contains(&status) && status != 408 && status != 429
}

fn status_detail(status: u16) -> Option<String> {
    (100..=599)
        .contains(&status)
        .then(|| format!("status={status}"))
}

pub(super) fn key_json(key: &noise::PublicKey) -> JsonValue {
    ObjectEncoder::new()
        .field("suite", key.suite.as_str())
        .field("x25519_public_key", key.x25519_public_key.as_str())
        .field("mlkem768_public_key", key.mlkem768_public_key.as_str())
        .finish()
}

enum Attempt {
    Stop,
    Cleanup(rendezvous::CleanupFailed),
    Retry { connected_ms: u64 },
}

struct State {
    identity: Option<Arc<noise::Identity>>,
    registration: Option<(String, registry::Registered)>,
    label_synced: bool,
    reconciled: bool,
    sessions: Arc<sessions::Registry>,
}

type Held = Arc<Mutex<Arc<native::ResolvedCredential>>>;

fn connection_failure(shared: &Shared, diagnostic: Diagnostic) {
    let problem = match diagnostic {
        Diagnostic::CredentialUnavailable => access::Problem::Authentication,
        Diagnostic::EnrollmentFailed
        | Diagnostic::EnrollmentRejected
        | Diagnostic::EnrollmentUncertain
        | Diagnostic::EnrollmentUnreadable
        | Diagnostic::EnrollmentAccountMismatch => access::Problem::Enrollment,
        _ => access::Problem::Connection,
    };
    shared.observe_connection(access::TransportStatus {
        state: "error".into(),
        problem: Some(problem),
        ..super::off_status()
    });
}

fn retry(shared: &Shared, cancel: &watch::Receiver<bool>, diagnostic: Diagnostic) -> Attempt {
    if *cancel.borrow() {
        return Attempt::Stop;
    }
    connection_failure(shared, diagnostic);
    shared.diagnostics.report(diagnostic);
    Attempt::Retry { connected_ms: 0 }
}

fn rejected(
    shared: &Shared,
    cancel: &watch::Receiver<bool>,
    diagnostic: Diagnostic,
    detail: Option<String>,
) -> Attempt {
    if !*cancel.borrow() {
        shared.observe_connection(access::TransportStatus {
            state: "error".into(),
            ..super::off_status()
        });
        match detail {
            Some(detail) => shared.diagnostics.report_detail(diagnostic, &detail),
            None => shared.diagnostics.report(diagnostic),
        }
    }
    Attempt::Stop
}

fn failed(shared: &Shared, cancel: &watch::Receiver<bool>, failure: Failure) -> Attempt {
    match failure {
        Failure::Stopped => Attempt::Stop,
        Failure::Retry(diagnostic) => retry(shared, cancel, diagnostic),
        Failure::Rejected(diagnostic) => rejected(shared, cancel, diagnostic, None),
    }
}

async fn wait(shared: &Shared, milliseconds: u64, cancel: &mut watch::Receiver<bool>) -> bool {
    let deadline = shared.ambient.clock.now() + milliseconds;
    until(cancel, shared.ambient.clock.sleep_until(deadline))
        .await
        .is_some()
}

pub(super) async fn serve(
    shared: Arc<Shared>,
    configuration: native::Configuration,
    mut cancel: watch::Receiver<bool>,
    sessions: Arc<sessions::Registry>,
) -> Result<(), CleanupError> {
    let Some(fence) = Fence::new(configuration) else {
        return sessions.shutdown().await;
    };
    let fence = Arc::new(fence);
    let mut state = State {
        identity: None,
        registration: None,
        label_synced: false,
        reconciled: false,
        sessions,
    };
    let mut backoff = RECONNECT_INITIAL_MS;
    let mut failures = Vec::new();
    while !*cancel.borrow() {
        shared.observe_connection(access::TransportStatus::connecting());
        let connected_ms = match connect_once(&shared, &fence, &mut state, &mut cancel).await {
            Attempt::Stop => break,
            Attempt::Cleanup(error) => {
                shared.observe_connection(access::TransportStatus {
                    state: "error".into(),
                    ..super::off_status()
                });
                failures.push(CleanupFailure::Rendezvous(error));
                break;
            }
            Attempt::Retry { connected_ms } => connected_ms,
        };
        if *cancel.borrow() {
            break;
        }
        if connected_ms >= STABLE_CONNECTION_MS {
            backoff = RECONNECT_INITIAL_MS;
        }
        let pause = reconnect_delay(backoff, (shared.ambient.random)());
        backoff = (backoff * 2).min(RECONNECT_MAX_MS);
        wait(&shared, pause, &mut cancel).await;
    }
    if let Err(error) = state.sessions.shutdown().await {
        failures.extend(error.failures);
    }
    CleanupError::result(failures)
}

async fn register(
    shared: &Arc<Shared>,
    fence: &Arc<Fence>,
    state: &mut State,
    environment_id: &str,
    held: &Held,
    cancel: &mut watch::Receiver<bool>,
) -> Result<(), Attempt> {
    let Some(identity) = state.identity.clone() else {
        return Err(retry(shared, cancel, Diagnostic::ConnectionFailed));
    };
    let key = key_json(identity.public_key());
    let refresh = enroll::registry_refresh(shared, fence);
    let mut attempt = 0u32;
    loop {
        let mut credential = locked(held).clone();
        let outcome = until(
            cancel,
            shared.transport.registry.register(
                environment_id,
                &mut credential,
                Some(&refresh),
                key.clone(),
            ),
        )
        .await;
        let Some(outcome) = outcome else {
            return Err(Attempt::Stop);
        };
        *locked(held) = credential;
        match outcome {
            Ok(registered) => {
                state.registration = Some((environment_id.to_owned(), registered));
                return Ok(());
            }
            Err(_) if *cancel.borrow() => return Err(Attempt::Stop),
            Err(error) if registry::retryable(&error) => {
                let pause = registry::retry_delay_ms(attempt, (shared.ambient.random)());
                attempt = attempt.saturating_add(1);
                if !wait(shared, pause, cancel).await {
                    return Err(Attempt::Stop);
                }
            }
            Err(registry::Error::Http { status, .. }) if definitive_rejection(status) => {
                return Err(rejected(
                    shared,
                    cancel,
                    Diagnostic::RegistrationRejected,
                    status_detail(status),
                ));
            }
            Err(_) => return Err(retry(shared, cancel, Diagnostic::ConnectionFailed)),
        }
    }
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

async fn connect_once(
    shared: &Arc<Shared>,
    fence: &Arc<Fence>,
    state: &mut State,
    cancel: &mut watch::Receiver<bool>,
) -> Attempt {
    let resolved = until(
        cancel,
        (shared.source.credential)(fence.profile().to_owned(), None),
    )
    .await;
    let credential = match resolved {
        None => return Attempt::Stop,
        Some(Err(_)) => return retry(shared, cancel, Diagnostic::CredentialUnavailable),
        Some(Ok(credential)) => credential,
    };
    if *cancel.borrow() {
        return Attempt::Stop;
    }
    let Some(credential) = credential.filter(|credential| fence.admits(credential)) else {
        return rejected(shared, cancel, Diagnostic::CredentialUnavailable, None);
    };
    if !fence.current(shared) {
        return Attempt::Stop;
    }
    let credential = Arc::new(credential);

    let configured = (shared.source.name)();
    let executor_refresh = enroll::executor_refresh(shared, fence);
    let resolved = match enroll::resolve(
        shared,
        &credential,
        configured.as_ref(),
        &executor_refresh,
        &mut state.label_synced,
        &mut state.reconciled,
        cancel,
    )
    .await
    {
        Ok(resolved) => resolved,
        Err(failure) => return failed(shared, cancel, failure),
    };
    if *cancel.borrow() {
        return Attempt::Stop;
    }
    let Ok(mut environment_id) = resolved.executor_id.to_utf8() else {
        return rejected(shared, cancel, Diagnostic::EnrollmentUnreadable, None);
    };

    if state.identity.is_none() {
        state.identity = noise::Identity::generate().ok().map(Arc::new);
    }
    let Some(identity) = state.identity.clone() else {
        return retry(shared, cancel, Diagnostic::ConnectionFailed);
    };

    let held: Held = Arc::new(Mutex::new(credential.clone()));
    if state
        .registration
        .as_ref()
        .is_none_or(|(registered_for, _)| *registered_for != environment_id)
    {
        state.registration = None;
        if let Err(attempt) = register(shared, fence, state, &environment_id, &held, cancel).await {
            return attempt;
        }
    }
    let synced = enroll::sync_label(
        shared,
        &credential,
        &resolved.record,
        configured.as_ref(),
        &mut state.label_synced,
        cancel,
    )
    .await;
    if *cancel.borrow() {
        return Attempt::Stop;
    }
    if let Some(synced) = synced.and_then(|synced| synced.to_utf8().ok())
        && synced != environment_id
    {
        environment_id = synced;
        state.registration = None;
        if let Err(attempt) = register(shared, fence, state, &environment_id, &held, cancel).await {
            return attempt;
        }
    }

    let Some((_, registered)) = state.registration.clone() else {
        return retry(shared, cancel, Diagnostic::ConnectionFailed);
    };
    let Some(url) = registry::rendezvous_url(&registered.url) else {
        return retry(shared, cancel, Diagnostic::ConnectionFailed);
    };
    let (ended, ended_observed) = watch::channel(false);
    let carrier = {
        let (shared, fence, held, stop) =
            (shared.clone(), fence.clone(), held.clone(), cancel.clone());
        let (sessions, environment_id) = (state.sessions.clone(), environment_id.clone());
        let registration_id = registered.executor_registration_id.clone();
        move |output: relay::Output| {
            let mut status = access::TransportStatus::connected(&shared.hostname);
            status.name = (shared.source.name)().and_then(|name| name.to_utf8().ok());
            shared.observe_connection(status);
            shared.diagnostics.report(Diagnostic::Connected);
            relay::Settings {
                acceptor: (shared.transport.acceptors)(
                    identity,
                    environment_id.clone(),
                    registration_id.clone(),
                ),
                authorize: authorizer(
                    &shared,
                    &fence,
                    &held,
                    &environment_id,
                    registration_id,
                    stop.clone(),
                ),
                output,
                clock: shared.ambient.clock.clone(),
                on_channel: channel_handler(
                    &shared,
                    sessions,
                    environment_id,
                    stop,
                    ended_observed,
                ),
                max_stream_queued_bytes: relay::DEFAULT_MAX_STREAM_QUEUED_BYTES,
                max_carrier_inbound_bytes: relay::DEFAULT_MAX_CARRIER_INBOUND_BYTES,
            }
        }
    };
    let entropy = (shared.ambient.entropy)();
    let outcome = rendezvous::serve(
        &shared.transport.connect,
        &shared.ambient.clock,
        &url,
        &entropy,
        carrier,
        cancel,
        &ended,
    )
    .await;
    shared.observe_connection(if *cancel.borrow() {
        super::off_status()
    } else {
        access::TransportStatus::connecting()
    });
    if let Err(error) = outcome.cleanup {
        shared.diagnostics.report(Diagnostic::CleanupFailed);
        return Attempt::Cleanup(error);
    }
    match outcome.ended {
        rendezvous::Ended::Cancelled => Attempt::Stop,
        rendezvous::Ended::Dial { status } => {
            if status.is_some_and(|status| (400..500).contains(&status)) {
                state.registration = None;
                if let Err(attempt) =
                    register(shared, fence, state, &environment_id, &held, cancel).await
                {
                    return attempt;
                }
            }
            retry(shared, cancel, Diagnostic::ConnectionFailed)
        }
        rendezvous::Ended::Dropped { connected_ms } => {
            if *cancel.borrow() {
                return Attempt::Stop;
            }
            shared.diagnostics.report(Diagnostic::ConnectionDropped);
            Attempt::Retry { connected_ms }
        }
    }
}

fn authorizer(
    shared: &Arc<Shared>,
    fence: &Arc<Fence>,
    held: &Held,
    environment_id: &str,
    registration_id: String,
    stop: watch::Receiver<bool>,
) -> relay::Authorizer {
    let (shared, fence, held) = (shared.clone(), fence.clone(), held.clone());
    let environment_id = environment_id.to_owned();
    Arc::new(move |key, authorization, stream_id| {
        let (shared, fence, held) = (shared.clone(), fence.clone(), held.clone());
        let (environment_id, registration_id) = (environment_id.clone(), registration_id.clone());
        let mut stop = stop.clone();
        Box::pin(async move {
            if *stop.borrow() || !fence.current(&shared) {
                return Err(());
            }
            let mut credential = locked(&held).clone();
            let refresh = enroll::registry_refresh(&shared, &fence);
            let validated = until(
                &mut stop,
                shared.transport.registry.validate(
                    &environment_id,
                    &mut credential,
                    Some(&refresh),
                    &registration_id,
                    key_json(&key),
                    &authorization,
                    &stream_id,
                ),
            )
            .await;
            *locked(&held) = credential;
            match validated {
                Some(Ok(())) => Ok(()),
                _ => Err(()),
            }
        })
    })
}

fn channel_handler(
    shared: &Arc<Shared>,
    sessions: Arc<sessions::Registry>,
    environment_id: String,
    stop: watch::Receiver<bool>,
    ended: watch::Receiver<bool>,
) -> relay::OnChannel {
    let shared = shared.clone();
    Arc::new(move |channel| {
        let (shared, sessions) = (shared.clone(), sessions.clone());
        let (environment_id, stop) = (environment_id.clone(), stop.clone());
        let ended = ended.clone();
        Box::pin(async move {
            if *stop.borrow() {
                return;
            }
            shared.diagnostics.report(Diagnostic::ChannelOpened);
            bridge(&shared, sessions, environment_id, channel, stop, ended).await;
        })
    })
}

async fn bridge(
    shared: &Shared,
    sessions: Arc<sessions::Registry>,
    environment_id: String,
    channel: relay::Channel,
    mut stop: watch::Receiver<bool>,
    mut ended: watch::Receiver<bool>,
) {
    let summary = Summary::default();
    let mut closed = channel.closed();
    let opened = Opened {
        channel,
        sessions,
        environment_id,
        summary: summary.clone(),
        diagnostics: shared.diagnostics.clone(),
    };
    let outcome = tokio::select! {
        biased;
        _ = cancelled(&mut stop) => None,
        _ = cancelled(&mut ended) => None,
        _ = cancelled(&mut closed) => None,
        result = (shared.serve)(opened) => Some(result),
    };
    let over = *stop.borrow() || *ended.borrow();
    let end = match outcome {
        Some(Err(_)) if !over && !*closed.borrow() => {
            shared.diagnostics.report(Diagnostic::ChannelFailed);
            End::Failed
        }
        _ if over => End::Connection,
        _ => End::Channel,
    };
    shared.diagnostics.line(&summary.line(end));
}
