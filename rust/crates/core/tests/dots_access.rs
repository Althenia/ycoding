use std::sync::{Arc, Mutex};
use ycoding_core::dots::access::{
    Access, Computer, ComputerAttach, ComputerDetach, ComputerFuture, ComputerProblem,
    ComputerRemove, ComputerState, ComputerStatus, ComputerTarget, ConfigurationStatus,
    ConversationError, ConversationErrorCode, ConversationProblem, ConversationResult, Error,
    Preference, Transport, TransportStatus, UpstreamRejection,
};
use ycoding_schema::{DomainEncode, JsonValue, parse_json};
use ycoding_store::{Metadata, Options, Store, native, resources, session::Document};

fn store() -> Store {
    Store::disposable(
        Options::core(),
        native::catalog(native::DatabaseKind::Core),
        Metadata::new([91; 16], 1),
    )
    .unwrap()
}

fn ready() -> ConfigurationStatus {
    ConfigurationStatus {
        ready: true,
        profile: Some("synthetic".into()),
        message: None,
    }
}

fn access(store: &Store) -> Access {
    Access::new(store.client(), Arc::new(|| Ok(ready())))
}

fn put(store: &Store, key: &str, value: JsonValue) {
    let key = key.to_owned();
    store
        .submit(move |tx| {
            resources::set_kv(
                tx,
                &key.into(),
                &Document::from_domain(&ycoding_schema::domain::Json::new(value).unwrap())?,
                1,
            )
        })
        .unwrap()
        .wait()
        .unwrap();
}

#[tokio::test]
async fn global_access_defaults_off_persists_and_preserves_unrelated_data() {
    let store = store();
    put(
        &store,
        "synthetic.unrelated",
        parse_json(r#"{"keep":true}"#).unwrap(),
    );
    let first = access(&store);
    assert_eq!(
        first.get().unwrap(),
        Preference {
            enabled: false,
            revision: 0
        }
    );
    assert_eq!(first.set(false, 0).await.unwrap().revision, 0);
    assert_eq!(
        first.set(true, 0).await.unwrap(),
        Preference {
            enabled: true,
            revision: 1
        }
    );
    assert_eq!(
        access(&store).get().unwrap(),
        Preference {
            enabled: true,
            revision: 1
        }
    );
    assert_eq!(first.set(true, 1).await.unwrap().revision, 1);
    assert_eq!(first.set(false, 1).await.unwrap().revision, 2);
    assert_eq!(
        resources::get_kv(&store.snapshot().unwrap(), &"synthetic.unrelated".into())
            .unwrap()
            .unwrap()
            .domain()
            .unwrap()
            .into_value(),
        parse_json(r#"{"keep":true}"#).unwrap()
    );
}

#[tokio::test]
async fn concurrent_cas_has_one_winner_and_stale_noops_conflict() {
    let store = store();
    let left = access(&store);
    let right = access(&store);
    let (a, b) = tokio::join!(left.set(true, 0), right.set(true, 0));
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert!(matches!(a.err().or(b.err()), Some(Error::Conflict)));
    assert!(matches!(left.set(true, 0).await, Err(Error::Conflict)));
    assert_eq!(left.get().unwrap().revision, 1);
}

#[tokio::test]
async fn malformed_preference_fails_closed_without_overwrite() {
    for raw in [
        r#"{"enabled":true,"revision":-1}"#,
        r#"{"enabled":true}"#,
        r#"{"enabled":"true","revision":0}"#,
        r#"{"enabled":true,"revision":1.5}"#,
        "null",
    ] {
        let store = store();
        let value = parse_json(raw).unwrap();
        put(&store, "dots.native-access", value.clone());
        let service = access(&store);
        assert!(matches!(service.get(), Err(Error::Unavailable)));
        assert!(matches!(
            service.set(false, 0).await,
            Err(Error::Unavailable)
        ));
        assert!(matches!(service.status().await, Err(Error::Unavailable)));
        assert_eq!(
            resources::get_kv(&store.snapshot().unwrap(), &"dots.native-access".into())
                .unwrap()
                .unwrap()
                .domain()
                .unwrap()
                .into_value(),
            value
        );
    }
}

#[tokio::test]
async fn enabling_and_enabled_noops_require_current_trusted_configuration() {
    let store = store();
    let configuration = Arc::new(Mutex::new(ready()));
    let read = configuration.clone();
    let service = Access::new(
        store.client(),
        Arc::new(move || Ok(read.lock().unwrap().clone())),
    );
    service.set(true, 0).await.unwrap();
    configuration.lock().unwrap().ready = false;
    assert!(matches!(
        service.set(true, 1).await,
        Err(Error::Unavailable)
    ));
    assert_eq!(service.set(false, 1).await.unwrap().revision, 2);
    assert!(matches!(
        service.set(true, 2).await,
        Err(Error::Unavailable)
    ));
}

struct Status(TransportStatus);
fn detached() -> ComputerStatus {
    ComputerStatus::new(ComputerState::Detached, None)
}

impl Transport for Status {
    fn status(&self) -> ycoding_core::dots::access::StatusFuture<'_> {
        Box::pin(async { Ok(self.0.clone()) })
    }
    fn computer(&self) -> ComputerFuture<'_> {
        Box::pin(async { Ok(detached()) })
    }
    fn attach_computer(&self, _: ComputerAttach) -> ComputerFuture<'_> {
        Box::pin(async { Ok(detached()) })
    }
    fn detach_computer(&self, _: ComputerDetach) -> ComputerFuture<'_> {
        Box::pin(async { Ok(ComputerStatus::new(ComputerState::Detached, None)) })
    }
    fn remove_computer(&self, _: ComputerRemove) -> ComputerFuture<'_> {
        Box::pin(async { Ok(ComputerStatus::new(ComputerState::Detached, None)) })
    }
}

#[tokio::test]
async fn transport_attachment_has_one_owner_and_old_release_cannot_remove_replacement() {
    let store = store();
    let service = access(&store);
    assert_eq!(
        service.status().await.unwrap().connection.state,
        "unavailable"
    );
    let first = service
        .attach_transport(Arc::new(Status(TransportStatus::connected(
            "Synthetic.local",
        ))))
        .unwrap();
    assert!(
        service
            .attach_transport(Arc::new(Status(TransportStatus::connected("Other.local"))))
            .is_err()
    );
    assert_eq!(service.status().await.unwrap().connection.state, "off");
    service.set(true, 0).await.unwrap();
    assert_eq!(
        service.status().await.unwrap().connection.state,
        "connected"
    );
    first.release();
    let second = service
        .attach_transport(Arc::new(Status(TransportStatus::connecting())))
        .unwrap();
    first.release();
    assert_eq!(
        service.status().await.unwrap().connection.state,
        "connecting"
    );
    drop(second);
    assert_eq!(
        service.status().await.unwrap().connection.state,
        "unavailable"
    );
}

struct Delayed {
    entered: tokio::sync::Notify,
    proceed: tokio::sync::Notify,
}
impl Transport for Delayed {
    fn status(&self) -> ycoding_core::dots::access::StatusFuture<'_> {
        Box::pin(async {
            self.entered.notify_one();
            self.proceed.notified().await;
            Ok(TransportStatus::connected("Stale.local"))
        })
    }
    fn computer(&self) -> ComputerFuture<'_> {
        Box::pin(async { Ok(detached()) })
    }
    fn attach_computer(&self, _: ComputerAttach) -> ComputerFuture<'_> {
        Box::pin(async { Ok(detached()) })
    }
    fn detach_computer(&self, _: ComputerDetach) -> ComputerFuture<'_> {
        Box::pin(async { Ok(ComputerStatus::new(ComputerState::Detached, None)) })
    }
    fn remove_computer(&self, _: ComputerRemove) -> ComputerFuture<'_> {
        Box::pin(async { Ok(ComputerStatus::new(ComputerState::Detached, None)) })
    }
}

#[tokio::test]
async fn delayed_status_is_fenced_by_off_on_transport_and_configuration_replacement() {
    for change in ["access", "transport", "configuration"] {
        let store = store();
        let configuration = Arc::new(Mutex::new(ready()));
        let read = configuration.clone();
        let service = Access::new(
            store.client(),
            Arc::new(move || Ok(read.lock().unwrap().clone())),
        );
        service.set(true, 0).await.unwrap();
        let transport = Arc::new(Delayed {
            entered: Default::default(),
            proceed: Default::default(),
        });
        let attached = service.attach_transport(transport.clone()).unwrap();
        let reading = service.clone();
        let task = tokio::spawn(async move { reading.status().await.unwrap() });
        transport.entered.notified().await;
        match change {
            "access" => {
                service.set(false, 1).await.unwrap();
                service.set(true, 2).await.unwrap();
            }
            "transport" => attached.release(),
            _ => configuration.lock().unwrap().profile = Some("replacement".into()),
        }
        transport.proceed.notify_one();
        let status = task.await.unwrap();
        assert_eq!(
            status.connection.state,
            if change == "transport" {
                "unavailable"
            } else {
                "connecting"
            }
        );
        if change != "configuration" {
            assert_eq!(status.connection.hostname, None);
        }
    }
}

#[tokio::test]
async fn display_is_bounded_and_errors_use_fixed_guidance() {
    let store = store();
    let service = Access::new(
        store.client(),
        Arc::new(|| {
            Ok(ConfigurationStatus {
                ready: true,
                profile: Some(format!("\0{}", "p".repeat(300))),
                message: Some("m".repeat(600)),
            })
        }),
    );
    service.set(true, 0).await.unwrap();
    let _attached = service
        .attach_transport(Arc::new(Status(TransportStatus {
            state: "error".into(),
            hostname: Some(format!("\u{0080}{}", "h".repeat(300))),
            name: None,
            problem: Some(ycoding_core::dots::access::Problem::Authentication),
        })))
        .unwrap();
    let status = service.status().await.unwrap();
    assert_eq!(status.configuration.profile.unwrap().len(), 256);
    assert_eq!(status.configuration.message.unwrap().len(), 500);
    assert_eq!(status.connection.hostname.unwrap().len(), 256);
    assert_eq!(
        status.connection.message,
        Some(
            "The selected ChatGPT profile is unavailable. Check its authentication; the connector retries automatically."
                .into()
        )
    );
}

#[tokio::test]
async fn displayed_text_is_sliced_by_utf16_units_and_may_end_in_a_lone_surrogate() {
    let store = store();
    let cut = format!("{}\u{1f600}", "x".repeat(255));
    let configured = cut.clone();
    let service = Access::new(
        store.client(),
        Arc::new(move || {
            Ok(ConfigurationStatus {
                ready: true,
                profile: Some(configured.clone()),
                message: Some(format!("{}\u{1f600}", "m".repeat(499))),
            })
        }),
    );
    service.set(true, 0).await.unwrap();
    let _attached = service
        .attach_transport(Arc::new(Status(TransportStatus {
            state: "connected".into(),
            hostname: Some(cut.clone()),
            name: Some(format!(" \u{85}{cut}")),
            problem: None,
        })))
        .unwrap();
    let status = service.status().await.unwrap();
    let truncated = |filler: &str, count: usize| {
        ycoding_schema::LosslessString::from_utf16(
            filler
                .repeat(count)
                .encode_utf16()
                .chain([0xd83d])
                .collect(),
        )
    };
    assert_eq!(status.configuration.profile, Some(truncated("x", 255)));
    assert_eq!(status.configuration.message, Some(truncated("m", 499)));
    assert_eq!(status.connection.hostname, Some(truncated("x", 255)));
    assert_eq!(status.connection.name, Some(truncated("x", 255)));
}

struct Machine {
    computer: Mutex<Result<ComputerStatus, Error>>,
    attach: Mutex<Result<ComputerStatus, Error>>,
    attaches: std::sync::atomic::AtomicUsize,
    received: Mutex<Vec<ComputerAttach>>,
}
impl Machine {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            computer: Mutex::new(Ok(detached())),
            attach: Mutex::new(Ok(detached())),
            attaches: 0.into(),
            received: Mutex::new(Vec::new()),
        })
    }
    fn attaches(&self) -> usize {
        self.attaches.load(std::sync::atomic::Ordering::SeqCst)
    }
    fn received(&self) -> Vec<ComputerAttach> {
        self.received.lock().unwrap().clone()
    }
}

fn input(replace_others: bool, expected_target: Option<ComputerTarget>) -> ComputerAttach {
    ComputerAttach {
        replace_others,
        expected_target,
    }
}
impl Transport for Machine {
    fn status(&self) -> ycoding_core::dots::access::StatusFuture<'_> {
        Box::pin(async { Ok(TransportStatus::connected("Synthetic.local")) })
    }
    fn computer(&self) -> ComputerFuture<'_> {
        Box::pin(async { self.computer.lock().unwrap().clone() })
    }
    fn attach_computer(&self, input: ComputerAttach) -> ComputerFuture<'_> {
        self.attaches
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.received.lock().unwrap().push(input);
        Box::pin(async { self.attach.lock().unwrap().clone() })
    }
    fn detach_computer(&self, _: ComputerDetach) -> ComputerFuture<'_> {
        Box::pin(async { Ok(ComputerStatus::new(ComputerState::Detached, None)) })
    }
    fn remove_computer(&self, _: ComputerRemove) -> ComputerFuture<'_> {
        Box::pin(async { Ok(ComputerStatus::new(ComputerState::Detached, None)) })
    }
}

fn computer(state: ComputerState, problem: Option<ComputerProblem>) -> ComputerStatus {
    ComputerStatus::new(state, problem)
}

#[tokio::test]
async fn computer_status_uses_fixed_guidance_and_exists_only_while_a_transport_is_attached() {
    let store = store();
    let service = access(&store);
    assert_eq!(service.status().await.unwrap().computer, None);
    let machine = Machine::new();
    let _attached = service.attach_transport(machine.clone()).unwrap();
    *machine.computer.lock().unwrap() = Ok(computer(ComputerState::Attached, None));
    assert_eq!(
        service.status().await.unwrap().computer,
        Some(Computer {
            state: ComputerState::Attached,
            message: None,
            name: None,
            target: None,
            readiness: None,
            usable_for_tasks: None,
            dot_environment: None,
        })
    );
    for (problem, message) in [
        (
            ComputerProblem::Configuration,
            "Turn on Dots access with a ready ChatGPT profile to attach this computer.",
        ),
        (
            ComputerProblem::Authentication,
            "The selected ChatGPT profile could not be used. Check its sign-in.",
        ),
        (
            ComputerProblem::Enrollment,
            "This computer's Dots executor is not enrolled for the selected account yet. Keep Dots access on and try again.",
        ),
        (
            ComputerProblem::DotUnavailable,
            "No single active Dot was found for this account.",
        ),
        (
            ComputerProblem::NotListed,
            "This computer is not among your Dot's computers yet. Keep Dots access on and try again.",
        ),
        (
            ComputerProblem::AdminDisabled,
            "Your workspace administrator has disabled local computer access.",
        ),
        (
            ComputerProblem::NotConnectable,
            "ChatGPT does not allow attaching this computer right now.",
        ),
        (ComputerProblem::Rejected, "ChatGPT refused the request."),
        (
            ComputerProblem::Unconfirmed,
            "The outcome is unconfirmed. Do not repeat the request; refresh status and confirm the current computer before any new attempt.",
        ),
        (
            ComputerProblem::Connection,
            "Your Dot's computers could not be read. Try again.",
        ),
    ] {
        *machine.computer.lock().unwrap() = Ok(computer(ComputerState::Detached, Some(problem)));
        assert_eq!(
            service.status().await.unwrap().computer,
            Some(Computer {
                state: ComputerState::Detached,
                message: Some(message.into()),
                name: None,
                target: None,
                readiness: None,
                usable_for_tasks: None,
                dot_environment: None,
            }),
            "{problem:?}"
        );
    }
    *machine.computer.lock().unwrap() = Err(Error::Unavailable);
    assert_eq!(
        service.status().await.unwrap().computer,
        Some(Computer {
            state: ComputerState::Unavailable,
            message: Some("Your Dot's computers could not be read. Try again.".into()),
            name: None,
            target: None,
            readiness: None,
            usable_for_tasks: None,
            dot_environment: None,
        })
    );
    drop(_attached);
    assert_eq!(service.status().await.unwrap().computer, None);
}

#[tokio::test]
async fn attaching_a_computer_needs_an_owner_enabled_access_and_a_ready_configuration() {
    let store = store();
    let service = access(&store);
    assert_eq!(
        service.attach_computer(input(false, None)).await,
        Err(Error::Unavailable)
    );
    let machine = Machine::new();
    let _attached = service.attach_transport(machine.clone()).unwrap();
    let guidance = "Turn on Dots access with a ready ChatGPT profile to attach this computer.";
    let off = service.attach_computer(input(false, None)).await.unwrap();
    assert_eq!(
        off.computer,
        Some(Computer {
            state: ComputerState::Unavailable,
            message: Some(guidance.into()),
            name: None,
            target: None,
            readiness: None,
            usable_for_tasks: None,
            dot_environment: None,
        })
    );
    assert_eq!(machine.attaches(), 0);
    let unready = Access::new(
        store.client(),
        Arc::new(|| {
            Ok(ConfigurationStatus {
                ready: false,
                profile: None,
                message: None,
            })
        }),
    );
    let unready_machine = Machine::new();
    let _unready_attached = unready.attach_transport(unready_machine.clone()).unwrap();
    service.set(true, 0).await.unwrap();
    assert_eq!(
        unready
            .attach_computer(input(false, None))
            .await
            .unwrap()
            .computer,
        Some(Computer {
            state: ComputerState::Unavailable,
            message: Some(guidance.into()),
            name: None,
            target: None,
            readiness: None,
            usable_for_tasks: None,
            dot_environment: None,
        })
    );
    assert_eq!(unready_machine.attaches(), 0);
}

#[tokio::test]
async fn attaching_reports_the_transport_outcome_and_maps_failures_to_fixed_guidance() {
    let store = store();
    let service = access(&store);
    service.set(true, 0).await.unwrap();
    let machine = Machine::new();
    let _attached = service.attach_transport(machine.clone()).unwrap();
    *machine.attach.lock().unwrap() = Ok(computer(
        ComputerState::Detached,
        Some(ComputerProblem::Rejected),
    ));
    assert_eq!(
        service
            .attach_computer(input(false, None))
            .await
            .unwrap()
            .computer,
        Some(Computer {
            state: ComputerState::Detached,
            message: Some("ChatGPT refused the request.".into()),
            name: None,
            target: None,
            readiness: None,
            usable_for_tasks: None,
            dot_environment: None,
        })
    );
    *machine.attach.lock().unwrap() = Ok(computer(ComputerState::Attached, None));
    *machine.computer.lock().unwrap() = Ok(computer(ComputerState::Detached, None));
    let attached = service.attach_computer(input(false, None)).await.unwrap();
    assert_eq!(
        attached.computer,
        Some(Computer {
            state: ComputerState::Attached,
            message: None,
            name: None,
            target: None,
            readiness: None,
            usable_for_tasks: None,
            dot_environment: None,
        })
    );
    assert_eq!(attached.connection.state, "connected");
    assert_eq!(machine.attaches(), 2);
    *machine.attach.lock().unwrap() = Err(Error::Unavailable);
    assert_eq!(
        service
            .attach_computer(input(false, None))
            .await
            .unwrap()
            .computer,
        Some(Computer {
            state: ComputerState::Unavailable,
            message: Some("Your Dot's computers could not be read. Try again.".into()),
            name: None,
            target: None,
            readiness: None,
            usable_for_tasks: None,
            dot_environment: None,
        })
    );
}

#[tokio::test]
async fn computer_attachment_forwards_the_replace_others_consent_and_expected_target() {
    let store = store();
    let service = access(&store);
    service.set(true, 0).await.unwrap();
    let machine = Machine::new();
    let _attached = service.attach_transport(machine.clone()).unwrap();
    *machine.attach.lock().unwrap() = Ok(computer(ComputerState::Attached, None));
    let target = ComputerTarget {
        dot_id: "dot-a".into(),
        thread_id: "thread-a".into(),
        environment_id: "env-a".into(),
        revision: "a".repeat(64),
    };
    let first = input(false, Some(target.clone()));
    let second = input(true, Some(target));
    assert_eq!(
        service
            .attach_computer(first.clone())
            .await
            .unwrap()
            .computer
            .map(|computer| computer.state),
        Some(ComputerState::Attached)
    );
    assert_eq!(
        service
            .attach_computer(second.clone())
            .await
            .unwrap()
            .computer
            .map(|computer| computer.state),
        Some(ComputerState::Attached)
    );
    assert_eq!(machine.received(), vec![first, second]);
}

struct Gated {
    entered: tokio::sync::Notify,
    proceed: tokio::sync::Notify,
}
impl Transport for Gated {
    fn status(&self) -> ycoding_core::dots::access::StatusFuture<'_> {
        Box::pin(async { Ok(TransportStatus::connected("Gated.local")) })
    }
    fn computer(&self) -> ComputerFuture<'_> {
        Box::pin(async {
            self.entered.notify_one();
            self.proceed.notified().await;
            Ok(computer(ComputerState::Attached, None))
        })
    }
    fn attach_computer(&self, _: ComputerAttach) -> ComputerFuture<'_> {
        Box::pin(async { Ok(computer(ComputerState::Attached, None)) })
    }
    fn detach_computer(&self, _: ComputerDetach) -> ComputerFuture<'_> {
        Box::pin(async { Ok(ComputerStatus::new(ComputerState::Detached, None)) })
    }
    fn remove_computer(&self, _: ComputerRemove) -> ComputerFuture<'_> {
        Box::pin(async { Ok(ComputerStatus::new(ComputerState::Detached, None)) })
    }
}

#[tokio::test]
async fn a_revision_change_during_the_computer_read_reports_it_unavailable_without_guidance() {
    let store = store();
    let service = access(&store);
    service.set(true, 0).await.unwrap();
    let gated = Arc::new(Gated {
        entered: tokio::sync::Notify::new(),
        proceed: tokio::sync::Notify::new(),
    });
    let _attached = service.attach_transport(gated.clone()).unwrap();
    let reading = tokio::spawn({
        let service = service.clone();
        async move { service.status().await }
    });
    gated.entered.notified().await;
    service.set(false, 1).await.unwrap();
    gated.proceed.notify_one();
    let status = reading.await.unwrap().unwrap();
    assert_eq!(
        status.computer,
        Some(Computer {
            state: ComputerState::Unavailable,
            message: None,
            name: None,
            target: None,
            readiness: None,
            usable_for_tasks: None,
            dot_environment: None,
        })
    );
    assert_eq!(status.connection.hostname, None);
}

#[tokio::test]
async fn replacing_the_owner_during_the_computer_read_drops_the_computer() {
    let store = store();
    let service = access(&store);
    service.set(true, 0).await.unwrap();
    let gated = Arc::new(Gated {
        entered: tokio::sync::Notify::new(),
        proceed: tokio::sync::Notify::new(),
    });
    let attached = service.attach_transport(gated.clone()).unwrap();
    let reading = tokio::spawn({
        let service = service.clone();
        async move { service.status().await }
    });
    gated.entered.notified().await;
    attached.release();
    gated.proceed.notify_one();
    let status = reading.await.unwrap().unwrap();
    assert_eq!(status.computer, None);
    assert_eq!(status.connection.state, "unavailable");
}

fn refused(rejection: UpstreamRejection) -> ConversationError {
    ConversationResult::<()>::Failed {
        problem: ConversationProblem::Rejected,
        rejection: Some(rejection),
    }
    .into_result()
    .unwrap_err()
}

fn rejection_json(error: &ConversationError) -> Option<JsonValue> {
    error.rejection.as_ref().map(|rejection| rejection.encode())
}

#[test]
fn a_refused_dot_message_keeps_the_upstream_rejection_code_and_a_bounded_control_free_message() {
    let first = refused(UpstreamRejection {
        code: Some(-32602.0),
        message: Some("thread\u{7}busy".into()),
        ..UpstreamRejection::default()
    });
    assert_eq!(first.code, ConversationErrorCode::Unavailable);
    assert_eq!(first.message, "ChatGPT refused the request.");
    assert_eq!(
        rejection_json(&first),
        Some(parse_json(r#"{"code":-32602,"message":"thread busy"}"#).unwrap())
    );
    let long = refused(UpstreamRejection {
        message: Some("z".repeat(1500)),
        ..UpstreamRejection::default()
    });
    assert_eq!(
        rejection_json(&long),
        Some(parse_json(&format!(r#"{{"message":"{}"}}"#, "z".repeat(1000))).unwrap())
    );
    let empty = refused(UpstreamRejection {
        code: Some(2.5),
        message: Some("\u{0}".into()),
        ..UpstreamRejection::default()
    });
    assert_eq!(empty.rejection, None);
}

#[test]
fn rejection_labels_are_trimmed_bounded_and_dropped_when_blank() {
    let error = refused(UpstreamRejection {
        code: Some(9_007_199_254_740_992.0),
        error_code: Some(format!("  bad\u{1b}code{}", "x".repeat(200))),
        error_type: Some("   ".into()),
        message: Some("\u{85}spaced\u{9f}".into()),
    });
    let code = format!("bad code{}", "x".repeat(120));
    assert_eq!(
        rejection_json(&error),
        Some(parse_json(&format!(r#"{{"errorCode":"{code}","message":"spaced"}}"#)).unwrap())
    );
}

#[test]
fn only_a_rejected_problem_carries_a_rejection_and_every_problem_keeps_its_fixed_guidance() {
    let upstream = || {
        Some(UpstreamRejection {
            code: Some(1.0),
            ..UpstreamRejection::default()
        })
    };
    for (problem, code, message) in [
        (
            ConversationProblem::Connection,
            ConversationErrorCode::Unavailable,
            "Your Dot could not be reached. Try again.",
        ),
        (
            ConversationProblem::Stale,
            ConversationErrorCode::Conflict,
            "This request was already answered or is no longer pending. Refresh the pending requests.",
        ),
        (
            ConversationProblem::Unsupported,
            ConversationErrorCode::InvalidInput,
            "This request type cannot be answered from YCoding.",
        ),
        (
            ConversationProblem::InvalidAnswer,
            ConversationErrorCode::InvalidInput,
            "The answer does not match this request.",
        ),
    ] {
        let error = ConversationResult::<()>::Failed {
            problem,
            rejection: upstream(),
        }
        .into_result()
        .unwrap_err();
        assert_eq!(
            (error.code, error.message, error.rejection),
            (code, message, None)
        );
    }
    assert_eq!(ConversationResult::Ok(7).into_result(), Ok(7));
}
