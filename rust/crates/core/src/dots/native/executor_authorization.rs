use super::executor_scope::CurrentCheck;
use crate::{
    cca::error::{
        AuthorizationDenied, AuthorizationInput, Authorize, BoxFuture, DecisionBy, DecisionKind,
        DecisionReply, DecisionStep, DecisionTrace, ExecutorError, Grant, PendingDecision,
        PendingState,
    },
    process::guardrails::{self, Guardrails, Reservation},
    session::review::DeferOutcome,
    tools::policy::permissions::{self, Permissions},
};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use ycoding_schema::{
    DomainEncode, JsonObject, JsonValue, LosslessString, guardrail, permission, session,
};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

pub type ReviewDirectories =
    Arc<dyn Fn(String, String) -> BoxFuture<'static, Vec<String>> + Send + Sync>;

pub struct DeferredAuthorization(Arc<Inner>);

struct Inner {
    session_id: session::Id,
    permissions: Permissions,
    guardrails: Guardrails,
    current: CurrentCheck,
    review_directories: Option<ReviewDirectories>,
    timeout: Duration,
    closed: AtomicBool,
    cleanup_failed: AtomicBool,
    outstanding: Mutex<Vec<Arc<Held>>>,
}

struct Held {
    reservation: Reservation,
    released: AtomicBool,
}
impl Held {
    fn release(&self) {
        if !self.released.swap(true, Ordering::AcqRel) {
            self.reservation.release();
        }
    }
}

fn text(value: &LosslessString) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>()))
}
fn guardrail_request_text(id: &guardrail::RequestId) -> Option<String> {
    match id.encode() {
        JsonValue::String(value) => Some(text(&value)),
        _ => None,
    }
}
fn state_of(outcome: &DeferOutcome) -> (PendingState, Option<String>) {
    match outcome {
        DeferOutcome::Open { item_id, .. } => {
            (PendingState::Open, Some(text(item_id.as_lossless())))
        }
        DeferOutcome::Rejected { item_id } => {
            (PendingState::Rejected, Some(text(item_id.as_lossless())))
        }
        DeferOutcome::Full => (PendingState::Full, None),
    }
}
fn step(
    kind: DecisionKind,
    request_id: Option<String>,
    passed: bool,
    expired: bool,
) -> DecisionStep {
    if passed {
        DecisionStep {
            kind,
            request_id,
            reply: DecisionReply::Allow,
            by: DecisionBy::Rule,
        }
    } else if expired {
        DecisionStep {
            kind,
            request_id,
            reply: DecisionReply::Expired,
            by: DecisionBy::Expired,
        }
    } else {
        DecisionStep {
            kind,
            request_id,
            reply: DecisionReply::Reject,
            by: DecisionBy::Rule,
        }
    }
}

impl DeferredAuthorization {
    fn new(
        session_id: session::Id,
        permissions: Permissions,
        guardrails: Guardrails,
        current: CurrentCheck,
        review_directories: Option<ReviewDirectories>,
        timeout: Option<Duration>,
    ) -> Result<Arc<Self>, ExecutorError> {
        let timeout = timeout.unwrap_or(DEFAULT_TIMEOUT);
        if timeout.is_zero() {
            return Err(ExecutorError::new(
                -32602,
                "CCA authorization timeout must be positive",
            ));
        }
        Ok(Arc::new(Self(Arc::new(Inner {
            session_id,
            permissions,
            guardrails,
            current,
            review_directories,
            timeout,
            closed: AtomicBool::new(false),
            cleanup_failed: AtomicBool::new(false),
            outstanding: Mutex::new(vec![]),
        }))))
    }
}

impl Inner {
    fn metadata(input: &AuthorizationInput) -> Option<JsonObject> {
        input.metadata.clone()
    }

    async fn decide(
        &self,
        input: &AuthorizationInput,
        trace: &mut DecisionTrace,
        pending: &mut Vec<PendingDecision>,
    ) -> Result<Arc<Held>, ()> {
        let resources = input.resources.clone();
        let request = permission::Request {
            id: permission::Id::new(crate::platform::identifier("per_").map_err(|_| ())?)
                .map_err(|_| ())?,
            session_id: self.session_id.clone(),
            action: LosslessString::from(input.action.as_str()),
            resources: resources.clone(),
            save: Some(resources.clone()),
            metadata: Self::metadata(input),
            source: None,
            escalation: None,
            coordination_escalation: None,
        };
        let permission_request = text(request.id.as_lossless());
        let permission_deferred = match self.permissions.assert_deferred(request, None).await {
            Ok(()) => {
                trace.push(step(DecisionKind::Permission, None, true, false));
                false
            }
            Err(permissions::Error::DeferredReview(deferred)) => {
                let permissions::DeferredReview {
                    outcome,
                    action,
                    resources,
                    ..
                } = *deferred;
                let (state, item) = state_of(&outcome);
                trace.push(step(
                    DecisionKind::Permission,
                    Some(permission_request),
                    false,
                    false,
                ));
                pending.push(PendingDecision {
                    kind: DecisionKind::Permission,
                    session_id: text(self.session_id.as_lossless()),
                    item_id: item,
                    action: text(&action),
                    resources: resources.clone(),
                    hard_review: false,
                    state,
                    directories: vec![],
                });
                if state != PendingState::Open {
                    return Err(());
                }
                true
            }
            Err(_) => {
                trace.push(step(DecisionKind::Permission, None, false, false));
                return Err(());
            }
        };
        let guardrail_input = guardrails::Input {
            session_id: self.session_id.clone(),
            action: input
                .guardrail_action
                .clone()
                .unwrap_or_else(|| input.action.clone()),
            resources: resources.clone(),
            metadata: Self::metadata(input),
            skip_review: false,
            holder: Some(LosslessString::from(
                format!("cca:{}", crate::cca::encoding::uuid_v4()).as_str(),
            )),
            source: None,
        };
        let reservation = match self.guardrails.assert_deferred(guardrail_input) {
            Ok(admission) => match admission.wait {
                Some(wait) => wait
                    .await
                    .unwrap_or_else(|_| Err(guardrails::Error::Declined)),
                None => admission.reservation.ok_or(guardrails::Error::Declined),
            },
            Err(error) => Err(error),
        };
        match reservation {
            Ok(reservation) => {
                trace.push(step(DecisionKind::Guardrail, None, true, false));
                let held = Arc::new(Held {
                    reservation,
                    released: AtomicBool::new(false),
                });
                if permission_deferred {
                    held.release();
                    return Err(());
                }
                Ok(held)
            }
            Err(guardrails::Error::DeferredReview(deferred)) => {
                let guardrails::DeferredReview {
                    outcome,
                    action,
                    resources,
                    hard_review,
                    request_id,
                    ..
                } = *deferred;
                let (state, item) = state_of(&outcome);
                let directories = match (&state, &item, &self.review_directories) {
                    (PendingState::Open, Some(item), Some(lookup)) => {
                        lookup(text(self.session_id.as_lossless()), item.clone()).await
                    }
                    _ => vec![],
                };
                trace.push(step(
                    DecisionKind::Guardrail,
                    guardrail_request_text(&request_id),
                    false,
                    false,
                ));
                pending.push(PendingDecision {
                    kind: DecisionKind::Guardrail,
                    session_id: text(self.session_id.as_lossless()),
                    item_id: item,
                    action: text(&action),
                    resources: resources.clone(),
                    hard_review,
                    state,
                    directories,
                });
                Err(())
            }
            Err(_) => {
                trace.push(step(DecisionKind::Guardrail, None, false, false));
                pending.retain(|decision| decision.kind == DecisionKind::Guardrail);
                Err(())
            }
        }
    }
}

impl Authorize for DeferredAuthorization {
    fn authorize(
        &self,
        input: AuthorizationInput,
    ) -> BoxFuture<'static, Result<Grant, AuthorizationDenied>> {
        let this = self.0.clone();
        Box::pin(async move {
            if this.closed.load(Ordering::Acquire) || (this.current)().await.is_err() {
                return Err(AuthorizationDenied::default());
            }
            let mut trace: DecisionTrace = vec![];
            let mut pending: Vec<PendingDecision> = vec![];
            let outcome =
                tokio::time::timeout(this.timeout, this.decide(&input, &mut trace, &mut pending))
                    .await;
            let held = match outcome {
                Ok(Ok(held)) => held,
                Ok(Err(())) => {
                    return Err(AuthorizationDenied {
                        trace,
                        pending,
                        busy: false,
                    });
                }
                Err(_) => {
                    for step in &mut trace {
                        if step.reply == DecisionReply::Reject {
                            step.reply = DecisionReply::Expired;
                            step.by = DecisionBy::Expired;
                        }
                    }
                    let busy = pending.is_empty();
                    return Err(AuthorizationDenied {
                        trace,
                        pending,
                        busy,
                    });
                }
            };
            if this.closed.load(Ordering::Acquire) || (this.current)().await.is_err() {
                held.release();
                return Err(AuthorizationDenied {
                    trace,
                    pending: vec![],
                    busy: false,
                });
            }
            this.outstanding
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(held.clone());
            let owner = this.clone();
            let release_held = held.clone();
            Ok(Grant::new(trace, move || {
                Box::pin(async move {
                    release_held.release();
                    owner
                        .outstanding
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .retain(|candidate| !Arc::ptr_eq(candidate, &release_held));
                    Ok(())
                })
            }))
        })
    }

    fn defers(&self) -> bool {
        true
    }

    fn close(&self) -> BoxFuture<'static, Result<(), ExecutorError>> {
        let inner = &self.0;
        inner.closed.store(true, Ordering::Release);
        let held = std::mem::take(
            &mut *inner
                .outstanding
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        for entry in held {
            entry.release();
        }
        let failed = inner.cleanup_failed.load(Ordering::Acquire);
        Box::pin(async move {
            if failed {
                Err(ExecutorError::internal())
            } else {
                Ok(())
            }
        })
    }
}

pub fn deferred_authorization(
    session_id: session::Id,
    permissions: Permissions,
    guardrails: Guardrails,
    current: CurrentCheck,
    review_directories: Option<ReviewDirectories>,
    timeout: Option<Duration>,
) -> Result<Arc<dyn Authorize>, ExecutorError> {
    let adapter: Arc<dyn Authorize> = DeferredAuthorization::new(
        session_id,
        permissions,
        guardrails,
        current,
        review_directories,
        timeout,
    )?;
    Ok(adapter)
}
