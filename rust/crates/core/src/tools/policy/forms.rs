mod validation;
use super::goal_answer::{GOAL_VIA, GoalReconsider};
use super::{
    ANSWER_THRESHOLD, Authority, Judged, Judgment, Publisher, Recommend, Recommended, Reviews,
    Wait, graded_question, judge_confident, option_question, predicate_question, recommend, state,
    text_question,
};
use crate::coordination::decisions::{
    Appended, Claim, EscalateRequest, Escalated, Reconsider, Reconsidered, Snapshot, append,
    id_text,
};
use crate::coordination::{Error as CoordError, runtime::DecisionOutcome};
use crate::{
    process::guardrails::decision::Evaluator, session::review, tools::code_mode::Cancellation,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex, OnceLock},
    time::Instant,
};
use tokio::sync::oneshot;
pub(crate) use validation::active;
pub use validation::{automatic_answer, validate_answer, validate_field, validate_fields};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, form, session_id::SessionId, session_review,
};

const RETENTION: u64 = 600_000;
const FIELD: &str = "Answer this field with a concrete valid value for the form's stated purpose and constraints. Choose a recommended option or valid default when evidence is incomplete. Never refuse, defer, or ask the user. Do not claim synthetic values are observed facts or human authorization.";

#[derive(Clone, PartialEq)]
struct Fence {
    autonomy: Option<crate::session::autonomy::Snapshot>,
    context: Option<String>,
}

struct Assessed {
    answer: Result<form::Answer, session_review::Reason>,
    fields: Option<Vec<form::FieldAssessment>>,
    confidence: Option<f64>,
    via: &'static str,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Automatic {
    pub via: &'static str,
    pub confidence: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Settlement {
    pub automatic: Option<Automatic>,
    pub assessment: Option<form::Assessment>,
    pub source: Option<form::ReplySource>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Error {
    NotFound,
    AlreadyExists,
    AlreadySettled,
    InvalidForm(ycoding_schema::LosslessString),
    InvalidAnswer(ycoding_schema::LosslessString),
    Publish(String),
    ReviewFull { limit: usize },
    Review(String),
}
struct Entry {
    order: u64,
    form: form::Info,
    state: form::State,
    automatic: Option<Automatic>,
    source: Option<form::ReplySource>,
    visible: bool,
    failure: Option<Error>,
    settled_at: Option<u64>,
    sender: Option<oneshot::Sender<form::State>>,
}

#[derive(Clone, Copy)]
enum Admission {
    Hidden,
    Visible,
    Restored,
}

struct Inner {
    authority: Authority,
    publish: Publisher,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    forms: Mutex<BTreeMap<form::Id, Entry>>,
    reviews: OnceLock<Reviews>,
    decision: OnceLock<Arc<dyn Evaluator>>,
    deciding: Mutex<BTreeMap<form::Id, Cancellation>>,
    reconsidering: Arc<Mutex<BTreeSet<form::Id>>>,
}
#[derive(Clone)]
pub struct Forms(Arc<Inner>);

impl Forms {
    pub(crate) fn native_identity(&self) -> usize {
        Arc::as_ptr(&self.0) as usize
    }
    pub(crate) fn reply_native(
        &self,
        id: &form::Id,
        fingerprint: &str,
        answer: Option<form::Answer>,
        gate: &crate::dots::authority::Gate,
    ) -> Result<(), Error> {
        let mut forms = self
            .0
            .forms
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.expire(&mut forms);
        let entry = forms
            .get_mut(id)
            .filter(|entry| {
                entry.state == form::State::Pending
                    && entry.visible
                    && crate::dots::authority::fingerprint(&entry.form) == fingerprint
            })
            .ok_or(Error::NotFound)?;
        if let Some(answer) = &answer {
            validate_answer(&entry.form, answer).map_err(Error::InvalidAnswer)?;
        }
        let owner = SessionId::new(entry.form.session_id.clone()).map_err(|_| Error::NotFound)?;
        gate.receipt(
            &self.0.authority.store,
            &owner,
            ycoding_schema::ObjectEncoder::new()
                .field("kind", "form")
                .field("formID", id)
                .field("fingerprint", fingerprint)
                .finish(),
            None,
        )
        .map_err(|_| Error::NotFound)?;
        let source = answer.as_ref().and(gate.source.as_ref()).map(|source| {
            form::ReplySource::decode(&source.encode()).expect("native reply source")
        });
        let published = match &answer {
            Some(answer) => state::emit::<form::Replied>(
                &self.0.publish,
                &form::RepliedData {
                    id: id.clone(),
                    session_id: entry.form.session_id.clone(),
                    answer: answer.clone(),
                    source: source.clone(),
                },
            ),
            None => state::emit::<form::Cancelled>(
                &self.0.publish,
                &form::CancelledData {
                    id: id.clone(),
                    session_id: entry.form.session_id.clone(),
                },
            ),
        };
        close_pending(entry, answer.is_some());
        entry.state = answer.map_or(form::State::Cancelled, form::State::Answered);
        entry.automatic = None;
        entry.source = source;
        entry.settled_at = Some((self.0.clock)());
        if let Some(sender) = entry.sender.take() {
            let _ = sender.send(entry.state.clone());
        }
        published.map_err(Error::Publish)
    }
    pub fn new(authority: Authority, publish: Publisher) -> Self {
        let start = Instant::now();
        Self::with_clock(
            authority,
            publish,
            Arc::new(move || start.elapsed().as_millis() as u64),
        )
    }
    pub fn with_clock(
        authority: Authority,
        publish: Publisher,
        clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        Self(Arc::new(Inner {
            authority,
            publish,
            clock,
            forms: Mutex::new(BTreeMap::new()),
            reviews: OnceLock::new(),
            decision: OnceLock::new(),
            deciding: Mutex::new(BTreeMap::new()),
            reconsidering: Arc::new(Mutex::new(BTreeSet::new())),
        }))
    }
    pub fn with_reviews(self, reviews: Reviews) -> Self {
        let _ = self.0.reviews.set(reviews);
        self
    }
    pub fn with_decision(self, evaluator: Arc<dyn Evaluator>) -> Self {
        let _ = self.0.decision.set(evaluator);
        self
    }
    pub async fn yolo_answer(&self, form: &form::Info) -> Option<form::Answer> {
        validation::validate_fields(&form.fields.0).ok()?;
        let answer = match self.0.decision.get() {
            Some(evaluator) => native(
                evaluator.as_ref(),
                form,
                false,
                &Cancellation::default(),
                &ycoding_schema::stringify_json(&form.id.encode()),
            )
            .await
            .answer
            .ok(),
            None => validation::fallback_answer(form),
        }?;
        validation::validate_answer(form, &answer).ok()?;
        Some(answer)
    }

    pub async fn reconcile_autonomy(&self, session: &SessionId) -> Result<(), Error> {
        if !self
            .0
            .authority
            .session(session, None)
            .map_err(|error| Error::Review(format!("{error:?}")))?
            .autonomy
            .can_yolo_answer()
        {
            return Ok(());
        }
        let entries = self
            .0
            .forms
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .values()
            .filter(|entry| {
                entry.form.session_id == *session.as_lossless()
                    && entry.state == form::State::Pending
            })
            .map(|entry| (entry.form.clone(), entry.order))
            .collect::<Vec<_>>();
        for (mut form, order) in entries {
            let Some(_claim) = Claim::acquire(&self.0.reconsidering, form.id.clone()) else {
                continue;
            };
            if self
                .0
                .deciding
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .contains_key(&form.id)
            {
                continue;
            }
            let fence = self.fence(session);
            let authority = self
                .0
                .authority
                .session(session, None)
                .map_err(|error| Error::Review(format!("{error:?}")))?;
            if fence.autonomy.is_none()
                || fence.context.is_none()
                || !authority.autonomy.can_yolo_answer()
            {
                continue;
            }
            if let Some(assessment) = self.initial_assessment(
                &form,
                Some(session),
                &authority.autonomy,
                explicit_decision(&form),
                self.0.decision.get().is_some(),
            ) {
                let mut forms = self
                    .0
                    .forms
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                let Some(entry) = forms
                    .get_mut(&form.id)
                    .filter(|entry| entry.order == order && entry.state == form::State::Pending)
                else {
                    continue;
                };
                if self.fence(session) != fence {
                    continue;
                }
                self.record(entry, assessment)?;
                form = entry.form.clone();
            }
            let assessed = match self.0.decision.get() {
                Some(evaluator) => {
                    native(
                        evaluator.as_ref(),
                        &form,
                        false,
                        &Cancellation::default(),
                        &ycoding_schema::stringify_json(&form.id.encode()),
                    )
                    .await
                }
                None => Assessed {
                    answer: validation::fallback_answer(&form)
                        .ok_or(session_review::Reason::Unavailable),
                    fields: None,
                    confidence: None,
                    via: "yolo",
                },
            };
            if assessed.answer.is_ok() {
                self.settle_automatic(&form, order, session, &fence, assessed)?;
            }
        }
        Ok(())
    }

    pub async fn defer_pending(&self, session: &SessionId) -> Result<usize, Error> {
        self.reconcile_autonomy(session).await?;
        let Some(reviews) = self.0.reviews.get().cloned() else {
            return Ok(0);
        };
        let asked = {
            let mut forms = self
                .0
                .forms
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            self.expire(&mut forms);
            forms
                .values()
                .filter(|entry| {
                    entry.sender.is_some()
                        && entry.visible
                        && entry.state == form::State::Pending
                        && &entry.form.session_id == session.as_lossless()
                })
                .map(|entry| entry.form.clone())
                .collect::<Vec<_>>()
        };
        let mut deferred = 0;
        for info in asked {
            let item_id = open(&reviews, &info, session_review::Reason::DeferEntry, true).await?;
            let mut forms = self
                .0
                .forms
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let Some(entry) = forms.get_mut(&info.id) else {
                continue;
            };
            if entry.state != form::State::Pending {
                continue;
            }
            state::emit::<form::Deferred>(
                &self.0.publish,
                &form::DeferredData {
                    id: info.id.clone(),
                    session_id: info.session_id.clone(),
                    item_id: item_id.clone(),
                },
            )
            .map_err(Error::Publish)?;
            close_pending(entry, false);
            entry.state = form::State::Deferred { item_id };
            entry.settled_at = Some((self.0.clock)());
            if let Some(sender) = entry.sender.take() {
                let _ = sender.send(entry.state.clone());
            }
            deferred += 1;
        }
        Ok(deferred)
    }
    fn expire(&self, forms: &mut BTreeMap<form::Id, Entry>) {
        let now = (self.0.clock)();
        forms.retain(|_, entry| {
            entry
                .settled_at
                .is_none_or(|settled| now.saturating_sub(settled) < RETENTION)
        });
    }
    pub fn create(&self, mut form: form::Info) -> Result<form::Info, Error> {
        form.assessment = None;
        self.create_pending(form, Admission::Visible)
    }
    pub fn restore(&self, form: form::Info) -> Result<(), Error> {
        self.create_pending(form, Admission::Restored).map(|_| ())
    }
    fn create_pending(&self, form: form::Info, admission: Admission) -> Result<form::Info, Error> {
        let mut forms = self
            .0
            .forms
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.expire(&mut forms);
        if forms.contains_key(&form.id) {
            return Err(Error::AlreadyExists);
        }
        validate_fields(&form.fields.0).map_err(Error::InvalidForm)?;
        forms.insert(
            form.id.clone(),
            Entry {
                order: state::next_order(),
                form: form.clone(),
                state: form::State::Pending,
                automatic: None,
                source: None,
                visible: !matches!(admission, Admission::Hidden),
                failure: None,
                settled_at: None,
                sender: None,
            },
        );
        if matches!(admission, Admission::Visible)
            && let Err(error) = state::emit::<form::Created>(
                &self.0.publish,
                &form::CreatedData { form: form.clone() },
            )
        {
            forms.remove(&form.id);
            return Err(Error::Publish(error));
        }
        Ok(form)
    }
    pub fn ask(&self, form: form::Info) -> Result<Wait<form::State>, Error> {
        validate_fields(&form.fields.0).map_err(Error::InvalidForm)?;
        let session = SessionId::decode(&JsonValue::String(form.session_id.clone())).ok();
        let autonomy = session
            .as_ref()
            .and_then(|session| self.0.authority.session(session, None).ok())
            .map(|session| session.autonomy)
            .unwrap_or_default();
        let explicit = explicit_decision(&form);
        let auto_answer = autonomy.can_auto_answer() && !explicit;
        let fence = session.as_ref().map(|session| self.fence(session));
        let evaluator = self.0.decision.get().cloned().filter(|_| {
            autonomy.can_yolo_answer()
                && fence.as_ref().is_some_and(|fence| fence.context.is_some())
        });
        let assessment = self.initial_assessment(
            &form,
            session.as_ref(),
            &autonomy,
            explicit,
            evaluator.is_some(),
        );
        let reviews = self.0.reviews.get().cloned();
        let deterministic = if auto_answer {
            automatic_answer(&form)
        } else if autonomy.can_yolo_answer() && evaluator.is_none() {
            validation::fallback_answer(&form)
        } else {
            None
        };
        let asleep = autonomy.deferred && reviews.is_some();
        if asleep && deterministic.is_none() && evaluator.is_none() {
            let reviews = reviews.expect("asleep with reviews");
            let reason = if autonomy.can_yolo_answer() {
                session_review::Reason::Unavailable
            } else if auto_answer && form.fields.0.iter().any(required_free_text) {
                session_review::Reason::FreeText
            } else {
                session_review::Reason::Disabled
            };
            let mut form = form;
            form.assessment = assessment;
            let mut forms = self
                .0
                .forms
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            self.expire(&mut forms);
            if forms.contains_key(&form.id) {
                return Err(Error::AlreadyExists);
            }
            let item_id = reviews
                .service
                .open_now(review_input(&reviews, &form, reason, false)?)
                .map(|item| item.deferral.item_id)
                .map_err(review_error)?;
            state::emit::<form::Deferred>(
                &self.0.publish,
                &form::DeferredData {
                    id: form.id.clone(),
                    session_id: form.session_id.clone(),
                    item_id: item_id.clone(),
                },
            )
            .map_err(Error::Publish)?;
            let deferred = form::State::Deferred { item_id };
            forms.insert(
                form.id.clone(),
                Entry {
                    order: state::next_order(),
                    form,
                    state: deferred.clone(),
                    automatic: None,
                    source: None,
                    visible: false,
                    failure: None,
                    settled_at: Some((self.0.clock)()),
                    sender: None,
                },
            );
            let (sender, receiver) = oneshot::channel();
            let _ = sender.send(deferred);
            return Ok(Wait::new(receiver, || {}));
        }
        let admission = if asleep && deterministic.is_none() {
            Admission::Hidden
        } else {
            Admission::Visible
        };
        let mut form = form;
        form.assessment = assessment;
        let form = self.create_pending(form, admission)?;
        let (sender, receiver) = oneshot::channel();
        let order = {
            let mut forms = self
                .0
                .forms
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let entry = forms.get_mut(&form.id).expect("just created form");
            if entry.state != form::State::Pending {
                let _ = sender.send(entry.state.clone());
            } else {
                entry.sender = Some(sender);
            }
            entry.order
        };
        if let Some(answer) = deterministic {
            let unchanged = || match (&session, &fence) {
                (Some(session), Some(fence)) => self.fence(session).autonomy == fence.autonomy,
                _ => true,
            };
            let origin = Automatic {
                via: if autonomy.can_yolo_answer() {
                    "yolo"
                } else {
                    "auto-answer"
                },
                confidence: None,
            };
            match self.reply_with_origin(&form.id, answer, Some(origin), unchanged) {
                Ok(()) | Err(Error::AlreadySettled) => {}
                Err(error) => return Err(error),
            }
        } else if let (Some(evaluator), Some(session), Some(fence)) = (evaluator, session, fence) {
            let cancellation = Cancellation::default();
            self.0
                .deciding
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(form.id.clone(), cancellation.clone());
            let service = self.clone();
            let cancel = cancellation.clone();
            let id = form.id.clone();
            let task = tokio::spawn(async move {
                let key = ycoding_schema::stringify_json(&form.id.encode());
                let assessed =
                    native(evaluator.as_ref(), &form, auto_answer, &cancellation, &key).await;
                service
                    .0
                    .deciding
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .remove(&form.id);
                if cancellation.is_cancelled() {
                    return;
                }
                if let Err(error) =
                    service.settle_automatic(&form, order, &session, &fence, assessed)
                {
                    tracing::warn!(?error, "automatic Form settlement failed");
                    let _ = service.cancel_with_failure(&form.id, Some(error));
                }
            });
            let service = self.clone();
            let task = state::Task::new(task, move || {
                cancel.cancel();
                service
                    .0
                    .deciding
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .remove(&id);
                let _ = service.cancel(&id);
            });
            return Ok(Wait::new(receiver, move || drop(task)));
        }
        let service = self.clone();
        let id = form.id;
        Ok(Wait::new(receiver, move || {
            let _ = service.cancel(&id);
        }))
    }
    pub fn get(&self, id: &form::Id) -> Result<form::Info, Error> {
        let mut forms = self
            .0
            .forms
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.expire(&mut forms);
        forms
            .get(id)
            .map(|entry| entry.form.clone())
            .ok_or(Error::NotFound)
    }
    pub fn state(&self, id: &form::Id) -> Result<form::State, Error> {
        let mut forms = self
            .0
            .forms
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.expire(&mut forms);
        forms
            .get(id)
            .map(|entry| entry.state.clone())
            .ok_or(Error::NotFound)
    }
    pub fn list(&self, session: Option<&ycoding_schema::LosslessString>) -> Vec<form::Info> {
        self.list_ordered(session)
            .into_iter()
            .map(|(_, form)| form)
            .collect()
    }
    pub fn list_ordered(
        &self,
        session: Option<&ycoding_schema::LosslessString>,
    ) -> Vec<(u64, form::Info)> {
        let mut forms = self
            .0
            .forms
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.expire(&mut forms);
        let mut pending = forms
            .values()
            .filter(|entry| {
                entry.visible
                    && entry.state == form::State::Pending
                    && session.is_none_or(|session| &entry.form.session_id == session)
            })
            .map(|entry| (entry.order, entry.form.clone()))
            .collect::<Vec<_>>();
        pending.sort_by_key(|(order, _)| *order);
        pending
    }
    pub fn snapshot(&self, id: &form::Id) -> Option<Snapshot<form::Info>> {
        let mut forms = self
            .0
            .forms
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.expire(&mut forms);
        forms
            .get(id)
            .filter(|entry| entry.visible && entry.state == form::State::Pending)
            .map(|entry| Snapshot {
                order: entry.order,
                fingerprint: fingerprint_of(&entry.form),
                request: entry.form.clone(),
            })
    }
    pub fn snapshots(&self, session: &SessionId, limit: usize) -> Vec<Snapshot<form::Info>> {
        self.snapshots_in(std::slice::from_ref(session), limit)
    }
    pub fn snapshots_in(&self, sessions: &[SessionId], limit: usize) -> Vec<Snapshot<form::Info>> {
        let mut snapshots = self
            .list_ordered(None)
            .into_iter()
            .filter(|(_, form)| {
                sessions
                    .iter()
                    .any(|session| session.as_lossless() == &form.session_id)
            })
            .map(|(order, form)| Snapshot {
                order,
                fingerprint: fingerprint_of(&form),
                request: form,
            })
            .collect::<Vec<_>>();
        snapshots.truncate(limit);
        snapshots
    }
    pub async fn reconsider(
        &self,
        id: &form::Id,
        input: Reconsider<form::Info>,
    ) -> Result<Reconsidered, CoordError> {
        let fingerprint = &input.fingerprint;
        let (info, order) = {
            let mut forms = self
                .0
                .forms
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            self.expire(&mut forms);
            let Some(entry) = forms.get(id).filter(|entry| {
                entry.state == form::State::Pending && &fingerprint_of(&entry.form) == fingerprint
            }) else {
                return Ok(Reconsidered::stale(fingerprint));
            };
            if !entry.visible {
                return Ok(Reconsidered::escalated(
                    fingerprint,
                    "native-assessment-in-progress",
                ));
            }
            (entry.form.clone(), entry.order)
        };
        let Some(_claim) = Claim::acquire(&self.0.reconsidering, id.clone()) else {
            return Ok(Reconsidered::escalated(
                fingerprint,
                "native-assessment-in-progress",
            ));
        };
        if !(input.gate.validate)(info.clone()).await {
            return Ok(Reconsidered::escalated(fingerprint, "delegation-invalid"));
        }
        let escalate = |reason: &str| Ok(Reconsidered::escalated(fingerprint, reason));
        let Ok(session) = SessionId::new(info.session_id.clone()) else {
            return Ok(Reconsidered::stale(fingerprint));
        };
        let authority = match self.0.authority.session(&session, None) {
            Ok(authority) => authority,
            Err(state::Error::NotFound(_)) => return Ok(Reconsidered::stale(fingerprint)),
            Err(state::Error::Store(error)) => return Err(CoordError::Store(error)),
            Err(error) => return Err(CoordError::refused(format!("{error:?}"))),
        };
        let fence = self.fence(&session);
        if fence.autonomy.is_none() {
            return escalate("native-assessment-unavailable");
        }
        let auto = authority.autonomy.can_auto_answer();
        let yolo = authority.autonomy.can_yolo_answer();
        let confident = input.confidence.is_none_or(|confidence| {
            confidence.is_finite() && confidence >= super::ANSWER_THRESHOLD
        });
        if !yolo && input.answer.is_some() && !confident {
            return escalate("low-confidence");
        }
        if explicit_decision(&info) && !yolo {
            return escalate("explicit-decision:request");
        }
        if input.answer.is_none() && !auto && !yolo {
            return escalate("answer-required");
        }
        let mut regrade = None;
        let mut context_fenced = false;
        let mut decided: Result<(form::Answer, &'static str, Option<f64>), String> =
            if let Some(answer) = input
                .answer
                .clone()
                .filter(|answer| !yolo || confident && validate_answer(&info, answer).is_ok())
            {
                Ok((answer, "coordination", input.confidence))
            } else if auto {
                match automatic_answer(&info) {
                    Some(answer) => Ok((answer, "auto-answer", None)),
                    None => {
                        return escalate(if info.fields.0.iter().any(required_free_text) {
                            "free_text"
                        } else {
                            "disabled"
                        });
                    }
                }
            } else {
                if fence.context.is_none() {
                    return escalate("native-assessment-unavailable");
                }
                context_fenced = true;
                let key = format!(
                    "{}:reconsider:{}",
                    ycoding_schema::stringify_json(&id.encode()),
                    state::next_order()
                );
                let assessed = match self.0.decision.get().cloned() {
                    Some(evaluator) => {
                        native(
                            evaluator.as_ref(),
                            &info,
                            false,
                            &Cancellation::default(),
                            &key,
                        )
                        .await
                    }
                    None => Assessed {
                        answer: validation::fallback_answer(&info)
                            .ok_or(session_review::Reason::Unavailable),
                        fields: None,
                        confidence: None,
                        via: "yolo",
                    },
                };
                regrade = assessed.fields;
                match assessed.answer {
                    Ok(answer) => Ok((answer, "yolo", assessed.confidence)),
                    Err(reason) => Err(reason.as_str().to_owned()),
                }
            };
        if regrade.is_none()
            && let Err(reason) = &decided
        {
            return escalate(reason);
        }
        if !(input.gate.validate)(info.clone()).await {
            return escalate("delegation-invalid");
        }
        let mut forms = self
            .0
            .forms
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.expire(&mut forms);
        let Some(entry) = forms.get_mut(id).filter(|entry| {
            entry.order == order
                && entry.visible
                && entry.state == form::State::Pending
                && &fingerprint_of(&entry.form) == fingerprint
        }) else {
            return Ok(Reconsidered::stale(fingerprint));
        };
        if !(input.gate.current)() {
            return escalate("delegation-invalid");
        }
        if explicit_decision(&entry.form) && !yolo {
            return escalate("explicit-decision:request");
        }
        let current = self.fence(&session);
        let stale = if context_fenced {
            current != fence
        } else {
            current.autonomy != fence.autonomy
        };
        let refreshed = stale
            && current.autonomy.is_some()
            && current.context.is_some()
            && current.context == fence.context
            && self
                .0
                .authority
                .session(&session, None)
                .is_ok_and(|authority| authority.autonomy.can_yolo_answer());
        if stale && !refreshed {
            return escalate("stale-assessment");
        }
        if refreshed {
            decided = validation::fallback_answer(&entry.form)
                .map(|answer| (answer, "yolo", None))
                .ok_or_else(|| "invalid-answer".to_owned());
            regrade = entry.form.assessment.as_ref().map(|assessment| assessment.fields.iter().map(|field| {
                field_entry(&field.key, form::FieldAssessmentStatus::NotAssessed, "Previous assessment was revoked; current YOLO uses a deterministic valid fallback.")
            }).collect());
        }
        if matches!(&decided, Ok((answer, _, _)) if validate_answer(&entry.form, answer).is_err()) {
            return escalate("invalid-answer");
        }
        if let Some(fields) = regrade {
            let assessment = form::Assessment {
                mode: form::AssessmentMode::Yolo,
                source_session_id: self.answers_source(&entry.form, Some(&session)),
                fields,
            };
            self.record(entry, assessment)
                .map_err(|error| CoordError::refused(format!("{error:?}")))?;
        }
        let (answer, via, confidence) = match decided {
            Ok(decided) => decided,
            Err(reason) => return escalate(&reason),
        };
        let source = input.source.reply_source(via, confidence)?;
        self.settle_answered(id, entry, answer, source.clone())?;
        let mut settled = Reconsidered::settled(fingerprint, DecisionOutcome::Allowed, via);
        settled.confidence = confidence;
        settled.source = Some(source);
        Ok(settled)
    }
    fn settle_answered(
        &self,
        id: &form::Id,
        entry: &mut Entry,
        answer: form::Answer,
        source: form::ReplySource,
    ) -> Result<(), CoordError> {
        state::emit::<form::Replied>(
            &self.0.publish,
            &form::RepliedData {
                id: id.clone(),
                session_id: entry.form.session_id.clone(),
                answer: answer.clone(),
                source: Some(source.clone()),
            },
        )
        .map_err(CoordError::refused)?;
        close_pending(entry, true);
        entry.state = form::State::Answered(answer);
        entry.source = Some(source);
        entry.settled_at = Some((self.0.clock)());
        if let Some(sender) = entry.sender.take() {
            let _ = sender.send(entry.state.clone());
        }
        Ok(())
    }
    pub async fn reconsider_goal(
        &self,
        id: &form::Id,
        input: GoalReconsider<form::Info, form::Answer>,
    ) -> Result<Reconsidered, CoordError> {
        let info = self
            .0
            .forms
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(id)
            .map(|entry| entry.form.clone());
        if info
            .as_ref()
            .and_then(|info| SessionId::new(info.session_id.clone()).ok())
            .is_some_and(|session| {
                self.0
                    .authority
                    .session(&session, None)
                    .is_ok_and(|authority| authority.autonomy.can_yolo_answer())
            })
        {
            return self
                .reconsider(
                    id,
                    Reconsider {
                        fingerprint: input.fingerprint,
                        source: input.source,
                        gate: input.gate,
                        decision: None,
                        answer: None,
                        confidence: None,
                    },
                )
                .await;
        }
        let fingerprint = &input.fingerprint;
        let escalate = |reason: &str| Ok(Reconsidered::escalated(fingerprint, reason));
        let (info, order) = {
            let mut forms = self
                .0
                .forms
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            self.expire(&mut forms);
            let Some(entry) = forms.get(id).filter(|entry| {
                entry.state == form::State::Pending && &fingerprint_of(&entry.form) == fingerprint
            }) else {
                return Ok(Reconsidered::stale(fingerprint));
            };
            if !entry.visible {
                return escalate("native-assessment-in-progress");
            }
            (entry.form.clone(), entry.order)
        };
        let Some(_claim) = Claim::acquire(&self.0.reconsidering, id.clone()) else {
            return escalate("native-assessment-in-progress");
        };
        if !(input.gate.validate)(info.clone()).await {
            return escalate("delegation-invalid");
        }
        if explicit_decision(&info) {
            return escalate("explicit-decision:request");
        }
        if input.answer.is_some()
            && input.confidence.is_some_and(|confidence| {
                !confidence.is_finite() || confidence < super::ANSWER_THRESHOLD
            })
        {
            return escalate("low-confidence");
        }
        let Ok(session) = SessionId::new(info.session_id.clone()) else {
            return Ok(Reconsidered::stale(fingerprint));
        };
        match self.0.authority.session(&session, None) {
            Ok(_) => {}
            Err(state::Error::NotFound(_)) => return Ok(Reconsidered::stale(fingerprint)),
            Err(state::Error::Store(error)) => return Err(CoordError::Store(error)),
            Err(error) => return Err(CoordError::refused(format!("{error:?}"))),
        }
        let fence = self.fence(&session);
        let (answer, via) = match input.answer.clone() {
            Some(answer) => {
                if validate_answer(&info, &answer).is_err() {
                    return escalate("invalid-answer");
                }
                (answer, GOAL_VIA)
            }
            None => match deterministic_goal_answer(&info) {
                Some(answer) => (answer, "auto-answer"),
                None => return escalate("refused"),
            },
        };
        if !(input.gate.validate)(info.clone()).await {
            return escalate("delegation-invalid");
        }
        let mut forms = self
            .0
            .forms
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.expire(&mut forms);
        let Some(entry) = forms.get_mut(id).filter(|entry| {
            entry.order == order
                && entry.visible
                && entry.state == form::State::Pending
                && &fingerprint_of(&entry.form) == fingerprint
        }) else {
            return Ok(Reconsidered::stale(fingerprint));
        };
        if !(input.gate.current)() {
            return escalate("delegation-invalid");
        }
        if fence.autonomy.is_none() || self.fence(&session).autonomy != fence.autonomy {
            return escalate("stale-assessment");
        }
        let confidence = (via == GOAL_VIA).then_some(input.confidence).flatten();
        let source = input.source.reply_source(via, confidence)?;
        self.settle_answered(id, entry, answer, source.clone())?;
        let mut settled = Reconsidered::settled(fingerprint, DecisionOutcome::Allowed, via);
        settled.confidence = confidence;
        settled.source = Some(source);
        Ok(settled)
    }
    pub fn escalate(&self, id: &form::Id, input: EscalateRequest) -> Result<Escalated, CoordError> {
        let mut forms = self
            .0
            .forms
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.expire(&mut forms);
        let Some(entry) = forms.get_mut(id).filter(|entry| {
            entry.visible
                && &entry.form.session_id == input.session_id.as_lossless()
                && fingerprint_of(&entry.form) == input.fingerprint
        }) else {
            return Ok(Escalated::stale());
        };
        if let form::State::Deferred { item_id } = &entry.state {
            return Ok(Escalated::deferred(
                item_id,
                entry.form.coordination_escalation.clone(),
            ));
        }
        if entry.state != form::State::Pending || !(input.current)() {
            return Ok(Escalated::stale());
        }
        let appended = append(entry.form.coordination_escalation.as_ref(), &input.source);
        let Appended::Added(value) = &appended else {
            return Ok(Escalated::appended(appended));
        };
        entry.form.coordination_escalation = Some(value.clone());
        state::emit::<ycoding_schema::coordination::event::RequestEscalated>(
            &self.0.publish,
            &ycoding_schema::coordination::RequestEscalatedData {
                session_id: input.session_id.clone(),
                root_session_id: None,
                kind: ycoding_schema::coordination::RequestKind::Question,
                request_id: id_text(id),
                coordination_escalation: value.clone(),
            },
        )
        .map_err(CoordError::refused)?;
        Ok(Escalated::appended(appended))
    }
    pub fn reply(&self, id: &form::Id, answer: form::Answer) -> Result<(), Error> {
        self.reply_with_origin(id, answer, None, || true)
    }
    pub fn answered_automatically(&self, id: &form::Id) -> Result<bool, Error> {
        self.settlement(id)
            .map(|settlement| settlement.automatic.is_some())
    }
    pub fn settlement(&self, id: &form::Id) -> Result<Settlement, Error> {
        let mut forms = self
            .0
            .forms
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.expire(&mut forms);
        forms
            .get(id)
            .map(|entry| Settlement {
                automatic: entry.automatic.clone(),
                assessment: entry.form.assessment.clone(),
                source: entry.source.clone(),
            })
            .ok_or(Error::NotFound)
    }
    fn reply_with_origin(
        &self,
        id: &form::Id,
        answer: form::Answer,
        automatic: Option<Automatic>,
        current: impl FnOnce() -> bool,
    ) -> Result<(), Error> {
        let mut forms = self
            .0
            .forms
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.expire(&mut forms);
        let entry = forms.get_mut(id).ok_or(Error::NotFound)?;
        if entry.state == form::State::Pending && !current() {
            return Ok(());
        }
        self.reply_entry(entry, answer, automatic)
    }
    fn reply_entry(
        &self,
        entry: &mut Entry,
        answer: form::Answer,
        automatic: Option<Automatic>,
    ) -> Result<(), Error> {
        if entry.state != form::State::Pending {
            return Err(Error::AlreadySettled);
        }
        if !entry.visible {
            return Err(Error::NotFound);
        }
        validate_answer(&entry.form, &answer).map_err(Error::InvalidAnswer)?;
        state::emit::<form::Replied>(
            &self.0.publish,
            &form::RepliedData {
                source: None,
                id: entry.form.id.clone(),
                session_id: entry.form.session_id.clone(),
                answer: answer.clone(),
            },
        )
        .map_err(Error::Publish)?;
        close_pending(entry, true);
        entry.state = form::State::Answered(answer);
        entry.automatic = automatic;
        entry.settled_at = Some((self.0.clock)());
        if let Some(sender) = entry.sender.take() {
            let _ = sender.send(entry.state.clone());
        }
        Ok(())
    }
    pub fn failure(&self, id: &form::Id) -> Option<Error> {
        self.0
            .forms
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(id)
            .and_then(|entry| entry.failure.clone())
    }
    pub fn cancel(&self, id: &form::Id) -> Result<(), Error> {
        self.cancel_with_failure(id, None)
    }
    fn cancel_with_failure(&self, id: &form::Id, failure: Option<Error>) -> Result<(), Error> {
        if let Some(cancellation) = self
            .0
            .deciding
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(id)
        {
            cancellation.cancel();
        }
        let mut forms = self
            .0
            .forms
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.expire(&mut forms);
        let entry = forms.get_mut(id).ok_or(Error::NotFound)?;
        if entry.state != form::State::Pending {
            return Err(Error::AlreadySettled);
        }
        if entry.visible {
            state::emit::<form::Cancelled>(
                &self.0.publish,
                &form::CancelledData {
                    id: id.clone(),
                    session_id: entry.form.session_id.clone(),
                },
            )
            .map_err(Error::Publish)?;
        }
        close_pending(entry, false);
        entry.state = form::State::Cancelled;
        entry.failure = failure;
        entry.settled_at = Some((self.0.clock)());
        if let Some(sender) = entry.sender.take() {
            let _ = sender.send(entry.state.clone());
        }
        Ok(())
    }
    pub fn has_pending(&self) -> bool {
        self.0
            .forms
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .values()
            .any(|entry| entry.state == form::State::Pending)
    }
    pub fn cancel_session(&self, session: &SessionId) -> Vec<Error> {
        let ids = self
            .0
            .forms
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .filter(|(_, entry)| {
                entry.state == form::State::Pending
                    && &entry.form.session_id == session.as_lossless()
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        ids.into_iter()
            .filter_map(|id| match self.cancel(&id) {
                Ok(()) | Err(Error::AlreadySettled) => None,
                Err(error) => Some(error),
            })
            .collect()
    }
    pub fn shutdown(&self) -> Vec<Error> {
        let pending = self
            .0
            .forms
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .filter(|(_, entry)| entry.state == form::State::Pending)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        pending
            .into_iter()
            .filter_map(|id| self.cancel(&id).err())
            .collect()
    }

    fn fence(&self, session: &SessionId) -> Fence {
        Fence {
            autonomy: self.0.authority.store.snapshot().ok().and_then(|snapshot| {
                crate::session::autonomy::inherited_in(&snapshot, session).ok()
            }),
            context: crate::coordination::decision_context::Service::new(
                self.0.authority.store.clone(),
            )
            .authority_digest(session)
            .ok(),
        }
    }
    fn answers_source(
        &self,
        form: &form::Info,
        session: Option<&SessionId>,
    ) -> ycoding_schema::LosslessString {
        session
            .and_then(|session| {
                crate::session::autonomy::Service::new(self.0.authority.store.clone())
                    .resolve(session)
                    .ok()
            })
            .and_then(|resolved| resolved.inherited.answers)
            .unwrap_or_else(|| form.session_id.clone())
    }
    fn initial_assessment(
        &self,
        form: &form::Info,
        session: Option<&SessionId>,
        autonomy: &crate::session::autonomy::Effective,
        explicit: bool,
        evaluating: bool,
    ) -> Option<form::Assessment> {
        if !assessable(form) {
            return None;
        }
        let mode = answers_mode(autonomy);
        let (status, reason) = if explicit && !autonomy.can_yolo_answer() {
            (
                form::FieldAssessmentStatus::NotAssessed,
                "This request requires an explicit decision; no model assessment.",
            )
        } else if autonomy.can_yolo_answer() {
            if evaluating {
                (
                    form::FieldAssessmentStatus::Pending,
                    "Answers evaluator is assessing the options.",
                )
            } else {
                (
                    form::FieldAssessmentStatus::Unavailable,
                    "The answers evaluator or its decision context is unavailable.",
                )
            }
        } else if autonomy.can_auto_answer() {
            (
                form::FieldAssessmentStatus::NotAssessed,
                "Auto uses only explicit defaults or a unique Recommended option; no model assessment.",
            )
        } else {
            (
                form::FieldAssessmentStatus::NotAssessed,
                "Manual answers require your decision; no model assessment.",
            )
        };
        Some(form::Assessment {
            mode,
            source_session_id: self.answers_source(form, session),
            fields: form
                .fields
                .0
                .iter()
                .filter(|field| option_field(field).is_some())
                .map(|field| field_entry(validation::field_key(field), status, reason))
                .collect(),
        })
    }
    fn record(&self, entry: &mut Entry, assessment: form::Assessment) -> Result<(), Error> {
        let assessment = match form::Assessment::decode(&assessment.encode()) {
            Ok(valid) => valid,
            Err(_) => form::Assessment {
                fields: assessment
                    .fields
                    .iter()
                    .map(|field| {
                        field_entry(
                            &field.key,
                            form::FieldAssessmentStatus::Unavailable,
                            "The assessment failed validation.",
                        )
                    })
                    .collect(),
                ..assessment
            },
        };
        entry.form.assessment = Some(assessment.clone());
        if entry.visible {
            state::emit::<form::Assessed>(
                &self.0.publish,
                &form::AssessedData {
                    id: entry.form.id.clone(),
                    session_id: entry.form.session_id.clone(),
                    assessment,
                },
            )
            .map_err(Error::Publish)?;
        }
        Ok(())
    }
    fn settle_automatic(
        &self,
        form: &form::Info,
        order: u64,
        session: &SessionId,
        fence: &Fence,
        mut assessed: Assessed,
    ) -> Result<(), Error> {
        let mut forms = self
            .0
            .forms
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let entry = forms.get_mut(&form.id).ok_or(Error::NotFound)?;
        if entry.order != order || entry.state != form::State::Pending {
            return Ok(());
        }
        let current = self.fence(session);
        let mut changed = fence.autonomy.is_none() || fence.context.is_none() || &current != fence;
        let revoked = if current.autonomy == fence.autonomy {
            "Authority changed; assessment not applied."
        } else {
            "Answers mode changed; assessment not applied."
        };
        if changed
            && fence.autonomy.is_some()
            && fence.context.is_some()
            && current.autonomy.is_some()
            && current.context == fence.context
            && self
                .0
                .authority
                .session(session, None)
                .is_ok_and(|authority| authority.autonomy.can_yolo_answer())
        {
            assessed = Assessed {
                answer: validation::fallback_answer(&entry.form).ok_or(session_review::Reason::Unavailable),
                fields: entry.form.assessment.as_ref().map(|assessment| assessment.fields.iter().map(|field| {
                    field_entry(&field.key, form::FieldAssessmentStatus::NotAssessed, "Previous assessment was revoked; current YOLO uses a deterministic valid fallback.")
                }).collect()),
                confidence: None,
                via: "yolo",
            };
            if let Some(assessment) = entry.form.assessment.as_mut() {
                assessment.mode = form::AssessmentMode::Yolo;
                assessment.source_session_id = self.answers_source(form, Some(session));
            }
            changed = false;
        }
        let Assessed {
            answer,
            fields,
            confidence,
            via,
        } = assessed;
        let result = if changed {
            Err(session_review::Reason::Disabled)
        } else {
            answer
        };
        if let (Some(fields), Some(current)) = (fields, entry.form.assessment.clone()) {
            let fields = if changed {
                fields
                    .iter()
                    .map(|field| {
                        field_entry(
                            &field.key,
                            form::FieldAssessmentStatus::Unavailable,
                            revoked,
                        )
                    })
                    .collect()
            } else {
                fields
            };
            self.record(entry, form::Assessment { fields, ..current })?;
        }
        let asleep = SessionId::new(form.session_id.clone())
            .ok()
            .and_then(|session| self.0.authority.session(&session, None).ok())
            .is_some_and(|session| session.autonomy.deferred);
        let reviews = self.0.reviews.get().cloned().filter(|_| asleep);
        if let (Err(reason), Some(reviews)) = (&result, reviews) {
            let item = reviews
                .service
                .open_now(review_input(&reviews, &entry.form, *reason, false)?)
                .map_err(review_error)?;
            let item_id = item.deferral.item_id;
            state::emit::<form::Deferred>(
                &self.0.publish,
                &form::DeferredData {
                    id: form.id.clone(),
                    session_id: form.session_id.clone(),
                    item_id: item_id.clone(),
                },
            )
            .map_err(Error::Publish)?;
            close_pending(entry, false);
            entry.state = form::State::Deferred { item_id };
            entry.settled_at = Some((self.0.clock)());
            if let Some(sender) = entry.sender.take() {
                let _ = sender.send(entry.state.clone());
            }
            return Ok(());
        }
        if !entry.visible {
            state::emit::<form::Created>(
                &self.0.publish,
                &form::CreatedData {
                    form: entry.form.clone(),
                },
            )
            .map_err(Error::Publish)?;
            entry.visible = true;
        }
        match result {
            Ok(answer) => self.reply_entry(entry, answer, Some(Automatic { via, confidence })),
            Err(_) => Ok(()),
        }
    }
}

pub fn deterministic_goal_answer(form: &form::Info) -> Option<form::Answer> {
    if form
        .fields
        .0
        .iter()
        .any(|field| matches!(field, form::Field::External(_)))
    {
        return None;
    }
    automatic_answer(form).filter(|answer| !answer.0.is_empty())
}

fn explicit_decision(form: &form::Info) -> bool {
    form.metadata
        .as_ref()
        .and_then(|metadata| metadata.get(&"requireExplicitDecision".into()))
        == Some(&JsonValue::Bool(true))
}

fn answers_mode(autonomy: &crate::session::autonomy::Effective) -> form::AssessmentMode {
    if autonomy.can_yolo_answer() {
        form::AssessmentMode::Yolo
    } else if autonomy.can_auto_answer() {
        form::AssessmentMode::Auto
    } else {
        form::AssessmentMode::Manual
    }
}

fn option_field(field: &form::Field) -> Option<(bool, &[form::Option])> {
    match field {
        form::Field::String(field) => field
            .options
            .as_deref()
            .filter(|options| !options.is_empty())
            .map(|options| (false, options)),
        form::Field::Multiselect(field) if !field.options.is_empty() => {
            Some((true, field.options.as_slice()))
        }
        _ => None,
    }
}

fn assessable(form: &form::Info) -> bool {
    validation::question_form(form)
        && form
            .fields
            .0
            .iter()
            .any(|field| option_field(field).is_some())
}

fn field_entry(
    key: &ycoding_schema::LosslessString,
    status: form::FieldAssessmentStatus,
    reason: &str,
) -> form::FieldAssessment {
    form::FieldAssessment {
        key: key.clone(),
        status,
        reason: reason.into(),
        grades: None,
        recommendation: None,
        confidence: None,
    }
}

fn close_pending(entry: &mut Entry, answered: bool) {
    let reason = if answered {
        "Answered before assessment settled."
    } else {
        "Request closed before assessment settled."
    };
    if let Some(assessment) = &mut entry.form.assessment {
        for field in &mut assessment.fields {
            if field.status == form::FieldAssessmentStatus::Pending {
                let key = field.key.clone();
                *field = field_entry(&key, form::FieldAssessmentStatus::NotAssessed, reason);
            }
        }
    }
}

fn choice_objects(options: &[form::Option]) -> Vec<JsonValue> {
    options
        .iter()
        .map(|option| {
            ycoding_schema::ObjectEncoder::new()
                .field("value", &option.value)
                .field(
                    "description",
                    option.description.as_ref().unwrap_or(&option.label),
                )
                .finish()
        })
        .collect()
}

fn evidence_of(form: &form::Info) -> JsonValue {
    let mut form = form.clone();
    form.assessment = None;
    form.encode()
}

fn field_question(field: &form::Field, name: &str, must: bool) -> Option<JsonValue> {
    match field {
        form::Field::Boolean(_) => Some(predicate_question(
            name,
            &format!(
                "{FIELD} Answer yes (true) or no (false) for this field; false is a real answer, distinct from refusing."
            ),
        )),
        form::Field::Number(_) | form::Field::Integer(_) if must => Some(text_question(
            name,
            &format!(
                "{FIELD} Respond with only the numeric value for this field, with no units or words."
            ),
            64,
        )),
        form::Field::Multiselect(field) if !field.options.is_empty() => Some(graded_question(
            name,
            &format!("{FIELD} Grade every option independently for whether it should be selected."),
            choice_objects(&field.options),
        )),
        form::Field::String(field) => match field.options.as_deref() {
            Some(choices) if !choices.is_empty() => {
                Some(option_question(name, FIELD, choice_objects(choices)))
            }
            _ if must => Some(text_question(
                name,
                FIELD,
                field
                    .max_length
                    .map_or(8192, |max| max.get() as usize)
                    .clamp(1, 8192),
            )),
            _ => None,
        },
        _ => None,
    }
}

fn custom_fallback(field: &form::Field) -> bool {
    matches!(field, form::Field::String(field)
        if field.options.as_deref().is_some_and(|options| !options.is_empty())
            && field.custom == Some(true))
}

fn field_value(
    field: &form::Field,
    must: bool,
    judged: Option<&Judged>,
) -> Result<Option<JsonValue>, session_review::Reason> {
    use session_review::Reason;
    Ok(match (field, judged) {
        (form::Field::External(_), _) => Some(JsonValue::Bool(true)),
        (
            form::Field::Number(_) | form::Field::Integer(_),
            Some(Judged::Value(JsonValue::String(text))),
        ) => {
            let number = text
                .to_utf8()
                .unwrap_or_default()
                .trim()
                .parse::<f64>()
                .map_err(|_| Reason::InvalidOutput)?;
            if !number.is_finite()
                || (matches!(field, form::Field::Integer(_)) && number.fract() != 0.0)
            {
                return Err(Reason::InvalidOutput);
            }
            Some(JsonValue::Number(number))
        }
        (form::Field::Multiselect(multiselect), Some(Judged::Grades(grades))) => {
            let selected = grades
                .iter()
                .filter(|grade| grade.confidence >= ANSWER_THRESHOLD)
                .map(|grade| grade.choice.clone())
                .collect::<Vec<_>>();
            if selected.is_empty() {
                if must || multiselect.min_items.is_some_and(|min| min.get() > 0) {
                    return Err(Reason::LowConfidence);
                }
                None
            } else {
                Some(JsonValue::Array(selected))
            }
        }
        (_, Some(Judged::Value(value))) => Some(value.clone()),
        (_, Some(Judged::Unsettled(reason))) => return Err(*reason),
        (_, Some(Judged::Grades(_))) => return Err(Reason::InvalidOutput),
        (form::Field::String(field), None)
            if must && field.options.as_deref().is_none_or(<[_]>::is_empty) =>
        {
            return Err(Reason::FreeText);
        }
        (_, None) if must => return Err(Reason::Disabled),
        (_, None) => None,
    })
}

fn option_grades(grades: &[super::Grade]) -> Vec<form::OptionGrade> {
    grades
        .iter()
        .filter_map(|grade| {
            let JsonValue::String(choice) = &grade.choice else {
                return None;
            };
            Some(form::OptionGrade {
                choice: choice.clone(),
                confidence: ycoding_schema::guardrail::Confidence::new(grade.confidence).ok()?,
                evidence: grade.evidence.clone(),
            })
        })
        .collect()
}

fn recommendation_entry(
    key: &ycoding_schema::LosslessString,
    recommended: &Recommended,
) -> form::FieldAssessment {
    let entry = field_entry(key, form::FieldAssessmentStatus::Assessed, "Assessed.");
    let reason = recommended.reason_text();
    match recommended {
        Recommended::Selected {
            grades,
            choices,
            confidence,
            ..
        } => form::FieldAssessment {
            reason,
            grades: Some(option_grades(grades)),
            recommendation: Some(
                choices
                    .iter()
                    .filter_map(|choice| match choice {
                        JsonValue::String(choice) => Some(choice.clone()),
                        _ => None,
                    })
                    .collect(),
            ),
            confidence: ycoding_schema::guardrail::Confidence::new(*confidence).ok(),
            ..entry
        },
        Recommended::Inconclusive { grades, .. } => form::FieldAssessment {
            reason,
            grades: Some(option_grades(grades)),
            ..entry
        },
        Recommended::Unavailable { grades, .. } => form::FieldAssessment {
            status: form::FieldAssessmentStatus::Unavailable,
            reason,
            grades: grades.as_deref().map(option_grades),
            ..entry
        },
    }
}

fn unavailable_fields(
    form: &form::Info,
    reason: session_review::Reason,
) -> Vec<form::FieldAssessment> {
    let recommended = Recommended::Unavailable {
        grades: None,
        reason,
    };
    form.fields
        .0
        .iter()
        .filter(|field| option_field(field).is_some())
        .map(|field| recommendation_entry(validation::field_key(field), &recommended))
        .collect()
}

async fn native(
    evaluator: &dyn Evaluator,
    form: &form::Info,
    auto_answer: bool,
    cancellation: &Cancellation,
    key: &str,
) -> Assessed {
    if assessable(form) {
        assess(evaluator, form, cancellation, key).await
    } else {
        match automatic(evaluator, form, auto_answer, cancellation, key).await {
            Ok((answer, via, confidence)) => Assessed {
                answer: Ok(answer),
                fields: None,
                confidence,
                via,
            },
            Err(reason) => Assessed {
                answer: Err(reason),
                fields: None,
                confidence: None,
                via: "yolo",
            },
        }
    }
}

fn lowest(current: Option<f64>, score: f64) -> Option<f64> {
    Some(current.map_or(score, |lowest| lowest.min(score)))
}

fn judged_confidence(judgment: Option<&Judgment>) -> Option<f64> {
    match judgment? {
        Judgment {
            judged: Judged::Value(_),
            confidence,
        } => Some(*confidence),
        Judgment {
            judged: Judged::Grades(grades),
            ..
        } => grades
            .iter()
            .filter(|grade| grade.confidence >= ANSWER_THRESHOLD)
            .map(|grade| grade.confidence)
            .reduce(f64::min),
        Judgment {
            judged: Judged::Unsettled(_),
            ..
        } => None,
    }
}

async fn assess(
    evaluator: &dyn Evaluator,
    form: &form::Info,
    cancellation: &Cancellation,
    key: &str,
) -> Assessed {
    use ycoding_schema::{JsonObject, session_review::Reason};
    let Ok(session) = SessionId::new(form.session_id.clone()) else {
        return Assessed {
            answer: Err(Reason::InvalidRequest),
            fields: Some(unavailable_fields(form, Reason::InvalidRequest)),
            confidence: None,
            via: "yolo",
        };
    };
    let evidence = evidence_of(form);
    let mut answer = form::Answer(JsonObject::new());
    let mut fields = vec![];
    let mut unsettled: Option<Reason> = None;
    let mut confidence: Option<f64> = None;
    let mut consulted = false;
    let mut fallback_used = false;
    for (index, field) in form.fields.0.iter().enumerate() {
        let name = format!("f{index}");
        let field_key = validation::field_key(field);
        let option = option_field(field);
        if !validation::active(field, &answer) {
            if option.is_some() {
                fields.push(field_entry(
                    field_key,
                    form::FieldAssessmentStatus::NotAssessed,
                    "Conditional field is inactive.",
                ));
            }
            continue;
        }
        let call = format!("{key}:{name}");
        if let Some((multiple, options)) = option {
            consulted = true;
            let instructions = format!(
                "{FIELD} Field key: {}.",
                field_key.to_utf8().unwrap_or_default()
            );
            let recommended = recommend(
                evaluator,
                &session,
                evidence.clone(),
                cancellation,
                Recommend {
                    name: &name,
                    instructions: &instructions,
                    choices: choice_objects(options),
                    multiple,
                    key: &call,
                },
            )
            .await;
            let entry = recommendation_entry(field_key, &recommended);
            match &recommended {
                Recommended::Selected {
                    choices,
                    confidence: score,
                    ..
                } => {
                    let value = if multiple {
                        JsonValue::Array(choices.clone())
                    } else {
                        choices.first().cloned().unwrap_or(JsonValue::Null)
                    };
                    if validate_field(field, &value).is_ok() {
                        confidence = lowest(confidence, *score);
                        answer.0.insert(field_key.clone(), value);
                        fields.push(entry);
                    } else {
                        if let Some(value) = validation::fallback_value(field) {
                            fallback_used = true;
                            answer.0.insert(field_key.clone(), value);
                        } else {
                            unsettled.get_or_insert(Reason::InvalidOutput);
                        }
                        fields.push(form::FieldAssessment {
                            status: form::FieldAssessmentStatus::Unavailable,
                            reason: "Recommendation does not satisfy the field constraints.".into(),
                            recommendation: None,
                            confidence: None,
                            ..entry
                        });
                    }
                }
                other => {
                    if let Some(value) = validation::fallback_value(field) {
                        fallback_used = true;
                        answer.0.insert(field_key.clone(), value);
                    } else if let Some(reason) = other.unsettled() {
                        unsettled.get_or_insert(reason);
                    }
                    fields.push(entry);
                }
            }
            continue;
        }
        let must = validation::must_answer(form, field);
        let judged = match field_question(field, &name, must) {
            Some(question) => {
                consulted = true;
                match judge_confident(
                    evaluator,
                    &session,
                    evidence.clone(),
                    vec![question],
                    cancellation,
                    &call,
                )
                .await
                {
                    Ok(mut judged) => {
                        judged.remove(&ycoding_schema::LosslessString::from(name.as_str()))
                    }
                    Err(reason) => {
                        if let Some(value) = validation::fallback_value(field) {
                            fallback_used = true;
                            answer.0.insert(field_key.clone(), value);
                        } else {
                            unsettled.get_or_insert(reason);
                        }
                        continue;
                    }
                }
            }
            None => None,
        };
        match field_value(
            field,
            must,
            judged.as_ref().map(|judgment| &judgment.judged),
        ) {
            Ok(Some(value)) if validate_field(field, &value).is_ok() => {
                if let Some(score) = judged_confidence(judged.as_ref()) {
                    confidence = lowest(confidence, score);
                }
                answer.0.insert(field_key.clone(), value);
            }
            Ok(Some(_)) => {
                if let Some(value) = validation::fallback_value(field) {
                    fallback_used = true;
                    answer.0.insert(field_key.clone(), value);
                } else {
                    unsettled.get_or_insert(Reason::InvalidOutput);
                }
            }
            Ok(None) => {
                if let Some(value) = validation::fallback_value(field) {
                    fallback_used = true;
                    answer.0.insert(field_key.clone(), value);
                }
            }
            Err(reason) => {
                if let Some(value) = validation::fallback_value(field) {
                    fallback_used = true;
                    answer.0.insert(field_key.clone(), value);
                } else {
                    unsettled.get_or_insert(reason);
                }
            }
        }
    }
    let result = if let Some(reason) = unsettled {
        Err(reason)
    } else if answer.0.is_empty() {
        Err(if consulted {
            Reason::LowConfidence
        } else {
            Reason::Disabled
        })
    } else {
        validate_answer(form, &answer)
            .map(|_| answer)
            .map_err(|_| Reason::InvalidOutput)
    };
    Assessed {
        answer: result,
        fields: Some(fields),
        confidence: if fallback_used { None } else { confidence },
        via: "yolo",
    }
}

async fn automatic(
    evaluator: &dyn Evaluator,
    form: &form::Info,
    auto_answer: bool,
    cancellation: &Cancellation,
    key: &str,
) -> Result<(form::Answer, &'static str, Option<f64>), session_review::Reason> {
    use ycoding_schema::{JsonObject, session_review::Reason};
    let session = SessionId::new(form.session_id.clone()).map_err(|_| Reason::InvalidRequest)?;
    let deterministic = if auto_answer {
        validation::rule_values(form)
    } else {
        Default::default()
    };
    let mut questions = vec![];
    let mut custom = vec![];
    for (index, field) in form.fields.0.iter().enumerate() {
        if deterministic.contains_key(&index) {
            continue;
        }
        let must = validation::must_answer(form, field);
        if let Some(question) = field_question(field, &format!("f{index}"), must) {
            questions.push(question);
            if custom_fallback(field) {
                custom.push(index);
            }
        }
    }
    let evidence = evidence_of(form);
    let consulted = !questions.is_empty();
    let mut judged = if questions.is_empty() {
        BTreeMap::new()
    } else {
        judge_confident(
            evaluator,
            &session,
            evidence.clone(),
            questions,
            cancellation,
            key,
        )
        .await
        .unwrap_or_default()
    };
    let unsettled_custom = custom
        .into_iter()
        .filter(|index| {
            matches!(
                judged
                    .get(&format!("f{index}").as_str().into())
                    .map(|judgment| &judgment.judged),
                Some(Judged::Unsettled(_))
            )
        })
        .collect::<Vec<_>>();
    if !unsettled_custom.is_empty() {
        let fallback = judge_confident(
            evaluator,
            &session,
            evidence,
            unsettled_custom
                .iter()
                .map(|index| text_question(&format!("f{index}"), &format!("{FIELD} No listed option was settled; give a custom answer only when the evidence clearly supports one."), 8192))
                .collect(),
            cancellation,
            &format!("{key}:custom"),
        )
        .await.unwrap_or_default();
        judged.extend(fallback);
    }
    let mut answer = form::Answer(JsonObject::new());
    let mut confidence: Option<f64> = None;
    let mut fallback_used = false;
    for (index, field) in form.fields.0.iter().enumerate() {
        if !validation::active(field, &answer) {
            continue;
        }
        let must = validation::must_answer(form, field);
        let judgment = judged.get(&format!("f{index}").as_str().into());
        let fixed = deterministic.get(&index);
        let value = if let Some(value) = fixed {
            Some(value.clone())
        } else {
            field_value(field, must, judgment.map(|judgment| &judgment.judged))
                .ok()
                .flatten()
                .filter(|value| validate_field(field, value).is_ok())
                .or_else(|| {
                    let fallback = validation::fallback_value(field);
                    fallback_used |= fallback.is_some();
                    fallback
                })
        };
        if let Some(value) = value {
            if validate_field(field, &value).is_err() {
                return Err(Reason::InvalidOutput);
            }
            if fixed.is_none()
                && let Some(score) = judged_confidence(judgment)
            {
                confidence = lowest(confidence, score);
            }
            answer.0.insert(validation::field_key(field).clone(), value);
        }
    }
    validate_answer(form, &answer).map_err(|_| Reason::InvalidOutput)?;
    Ok((
        answer,
        if auto_answer && !consulted {
            "auto-answer"
        } else {
            "yolo"
        },
        if fallback_used { None } else { confidence },
    ))
}

fn required_free_text(field: &form::Field) -> bool {
    let JsonValue::Object(encoded) = field.encode() else {
        return false;
    };
    encoded.get(&"type".into()) == Some(&JsonValue::String("string".into()))
        && encoded.get(&"required".into()) == Some(&JsonValue::Bool(true))
        && !matches!(encoded.get(&"options".into()), Some(JsonValue::Array(options)) if !options.is_empty())
}

fn review_input(
    reviews: &Reviews,
    form: &form::Info,
    reason: session_review::Reason,
    conversion: bool,
) -> Result<review::OpenInput, Error> {
    Ok(review::OpenInput {
        session_id: SessionId::decode(&JsonValue::String(form.session_id.clone()))
            .map_err(|_| Error::NotFound)?,
        kind: session_review::Kind::Question,
        reason,
        choice: None,
        confidence: None,
        grades: None,
        origin: super::request_origin(&form.id),
        payload: session_review::Payload::Form(session_review::FormPayload {
            title: form.title.clone(),
            fields: form.fields.0.clone(),
            question_tool: false,
            coordination_escalation: crate::process::guardrails::redacted_escalation(
                form.coordination_escalation.as_ref(),
            ),
        }),
        limit: reviews.limit,
        conversion,
        created: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_millis() as i64,
    })
}

async fn open(
    reviews: &Reviews,
    form: &form::Info,
    reason: session_review::Reason,
    conversion: bool,
) -> Result<session_review::Id, Error> {
    reviews
        .service
        .open(review_input(reviews, form, reason, conversion)?)
        .await
        .map(|item| item.deferral.item_id)
        .map_err(review_error)
}

fn review_error(error: review::Error) -> Error {
    match error {
        review::Error::Full { limit, .. } => Error::ReviewFull { limit },
        other => Error::Review(other.to_string()),
    }
}

fn fingerprint_of(form: &form::Info) -> ycoding_schema::LosslessString {
    let identity = ycoding_schema::ObjectEncoder::new()
        .field("sessionID", &form.session_id)
        .field("title", &form.title)
        .field("fields", &form.fields)
        .finish();
    crate::session::prompt_cache::sha256(&crate::session::prompt_cache::canonical_json(&identity))
        .into()
}
