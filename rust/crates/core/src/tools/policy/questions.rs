use super::{
    ANSWER_THRESHOLD, Authority, Publisher, Reviews, Wait,
    goal_answer::{GOAL_VIA, GoalReconsider},
    state,
};
use crate::{
    coordination::{
        Error as CoordError,
        decisions::{Claim, Reconsider, Reconsidered, Snapshot, id_text},
        runtime::DecisionOutcome,
    },
    process::guardrails::decision::Evaluator,
    session::{autonomy, review},
    tools::code_mode::Cancellation,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex, OnceLock},
};
use tokio::sync::oneshot;
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder, question,
    session_id::SessionId, session_review,
};

#[derive(Debug)]
pub enum Error {
    NotFound,
    Duplicate,
    Rejected,
    Publish(String),
    Deferred { item_id: session_review::Id },
    ReviewFull { limit: usize },
    Review(review::Error),
}
struct Pending {
    order: u64,
    request: question::Request,
    sender: oneshot::Sender<Result<Vec<question::Answer>, Error>>,
}
struct Inner {
    authority: Authority,
    publish: Publisher,
    pending: Mutex<BTreeMap<question::Id, Pending>>,
    reviews: OnceLock<Reviews>,
    decision: OnceLock<Arc<dyn Evaluator>>,
    deciding: Mutex<BTreeMap<question::Id, (SessionId, Cancellation)>>,
    reconsidering: Arc<Mutex<BTreeSet<question::Id>>>,
}
#[derive(Clone)]
pub struct Questions(Arc<Inner>);
pub enum Admission {
    Answered(Vec<question::Answer>),
    Pending(Wait<Result<Vec<question::Answer>, Error>>),
}

impl Questions {
    pub(crate) fn native_identity(&self) -> usize {
        Arc::as_ptr(&self.0) as usize
    }
    pub(crate) fn reply_native(
        &self,
        id: &question::Id,
        fingerprint: &str,
        answers: Option<Vec<question::Answer>>,
        gate: &crate::dots::authority::Gate,
    ) -> Result<(), Error> {
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let item = pending
            .get(id)
            .filter(|item| crate::dots::authority::fingerprint(&item.request) == fingerprint)
            .ok_or(Error::NotFound)?;
        if let Some(answers) = &answers
            && invalid_answers(&item.request, answers)
        {
            return Err(Error::NotFound);
        }
        gate.receipt(
            &self.0.authority.store,
            &item.request.session_id,
            ObjectEncoder::new()
                .field("kind", "question")
                .field("requestID", id)
                .field("fingerprint", fingerprint)
                .finish(),
            None,
        )
        .map_err(|_| Error::NotFound)?;
        let published = match &answers {
            Some(answers) => state::emit::<question::Replied>(
                &self.0.publish,
                &question::RepliedData {
                    session_id: item.request.session_id.clone(),
                    request_id: id.clone(),
                    answers: answers.clone(),
                },
            ),
            None => state::emit::<question::Rejected>(
                &self.0.publish,
                &question::RejectedData {
                    session_id: item.request.session_id.clone(),
                    request_id: id.clone(),
                },
            ),
        };
        let item = pending.remove(id).expect("pending question held by lock");
        let _ = item.sender.send(answers.ok_or(Error::Rejected));
        published.map_err(Error::Publish)
    }
    pub fn new(authority: Authority, publish: Publisher) -> Self {
        Self(Arc::new(Inner {
            authority,
            publish,
            pending: Mutex::new(BTreeMap::new()),
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
    pub async fn yolo_answers(&self, request: &question::Request) -> Option<Vec<question::Answer>> {
        match self.0.decision.get() {
            Some(evaluator) => {
                automatic(evaluator.as_ref(), request, false, &Cancellation::default())
                    .await
                    .ok()
                    .map(|answer| answer.answers)
            }
            None => request.questions.iter().map(fallback_answer).collect(),
        }
    }

    pub async fn reconcile_autonomy(&self, session: &SessionId) -> Result<(), Error> {
        if !self
            .0
            .authority
            .session(session, None)
            .is_ok_and(|authority| authority.autonomy.can_yolo_answer())
        {
            return Ok(());
        }
        let entries = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .values()
            .filter(|entry| &entry.request.session_id == session)
            .map(|entry| (entry.request.clone(), entry.order))
            .collect::<Vec<_>>();
        for (request, order) in entries {
            let Some(_claim) = Claim::acquire(&self.0.reconsidering, request.id.clone()) else {
                continue;
            };
            let fence = {
                let snapshot = self
                    .0
                    .authority
                    .store
                    .snapshot()
                    .map_err(|error| Error::Review(review::Error::Store(error)))?;
                let fence = autonomy::inherited_in(&snapshot, session).map_err(|error| {
                    Error::Review(review::Error::InvalidDeferral(error.to_string()))
                })?;
                if !autonomy::effective_in(&snapshot, session)
                    .map_err(|error| {
                        Error::Review(review::Error::InvalidDeferral(error.to_string()))
                    })?
                    .can_yolo_answer()
                {
                    continue;
                }
                fence
            };
            let decided = match self.0.decision.get() {
                Some(evaluator) => automatic(
                    evaluator.as_ref(),
                    &request,
                    false,
                    &Cancellation::default(),
                )
                .await
                .ok(),
                None => request
                    .questions
                    .iter()
                    .map(fallback_answer)
                    .collect::<Option<Vec<_>>>()
                    .map(|answers| Automatic {
                        answers,
                        confidence: None,
                    }),
            };
            let Some(decided) = decided else { continue };
            self.settle_automatic(&request, order, &fence, decided, "yolo", || true)
                .map_err(|error| {
                    Error::Review(review::Error::InvalidDeferral(error.to_string()))
                })?;
        }
        Ok(())
    }

    pub async fn defer_pending(&self, session: &SessionId) -> Result<usize, Error> {
        self.reconcile_autonomy(session).await?;
        let Some(reviews) = self.0.reviews.get().cloned() else {
            return Ok(0);
        };
        let items = {
            let mut pending = self
                .0
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let ids = pending
                .iter()
                .filter(|(_, item)| &item.request.session_id == session)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.iter()
                .filter_map(|id| pending.remove(id))
                .collect::<Vec<_>>()
        };
        let mut deferred = 0;
        for item in items {
            let outcome = defer(
                &self.0.publish,
                &reviews,
                &item.request,
                session_review::Reason::DeferEntry,
                true,
            )
            .await;
            if matches!(outcome, Err(Error::Deferred { .. })) {
                deferred += 1;
            }
            let _ = item.sender.send(outcome);
        }
        Ok(deferred)
    }
    pub fn ask(&self, request: question::Request) -> Result<Admission, Error> {
        let autonomy = self
            .0
            .authority
            .session(&request.session_id, None)
            .ok()
            .map(|session| session.autonomy)
            .unwrap_or_default();
        let auto_answer = autonomy.can_auto_answer();
        if auto_answer && let Some(answers) = recommended_answers(&request) {
            return Ok(Admission::Answered(answers));
        }
        let evaluator = self
            .0
            .decision
            .get()
            .cloned()
            .filter(|_| autonomy.can_yolo_answer());
        let reviews = self.0.reviews.get().cloned();
        let Some(evaluator) = evaluator else {
            if autonomy.can_yolo_answer()
                && let Some(answers) = request.questions.iter().map(fallback_answer).collect()
            {
                return Ok(Admission::Answered(answers));
            }
            if autonomy.deferred
                && let Some(reviews) = reviews
            {
                let reason = if autonomy.can_yolo_answer() {
                    session_review::Reason::Unavailable
                } else if auto_answer
                    && request
                        .questions
                        .iter()
                        .any(|question| question.options.is_empty())
                {
                    session_review::Reason::FreeText
                } else {
                    session_review::Reason::Disabled
                };
                let (sender, receiver) = oneshot::channel();
                let publish = self.0.publish.clone();
                tokio::spawn(async move {
                    let _ = sender.send(defer(&publish, &reviews, &request, reason, false).await);
                });
                return Ok(Admission::Pending(Wait::new(receiver, || {})));
            }
            let (sender, receiver) = oneshot::channel();
            let id = request.id.clone();
            self.register(request, sender)?;
            let service = self.clone();
            return Ok(Admission::Pending(Wait::new(receiver, move || {
                service.cancel(&id);
            })));
        };
        let fence = {
            let snapshot = self
                .0
                .authority
                .store
                .snapshot()
                .map_err(|error| Error::Review(review::Error::Store(error)))?;
            let fence =
                autonomy::inherited_in(&snapshot, &request.session_id).map_err(|error| {
                    Error::Review(review::Error::InvalidDeferral(error.to_string()))
                })?;
            if !autonomy::effective_in(&snapshot, &request.session_id)
                .map_err(|error| Error::Review(review::Error::InvalidDeferral(error.to_string())))?
                .can_yolo_answer()
            {
                let (sender, receiver) = oneshot::channel();
                let id = request.id.clone();
                self.register(request, sender)?;
                let service = self.clone();
                return Ok(Admission::Pending(Wait::new(receiver, move || {
                    service.cancel(&id)
                })));
            }
            fence
        };
        let (sender, receiver) = oneshot::channel();
        let cancellation = Cancellation::default();
        let id = request.id.clone();
        self.0
            .deciding
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(
                id.clone(),
                (request.session_id.clone(), cancellation.clone()),
            );
        let service = self.clone();
        let cancel = cancellation.clone();
        let task = tokio::spawn(async move {
            let outcome = automatic(evaluator.as_ref(), &request, auto_answer, &cancellation)
                .await
                .map(|decided| decided.answers);
            service
                .0
                .deciding
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&request.id);
            if cancellation.is_cancelled() {
                return;
            }
            let snapshot = service.0.authority.store.snapshot().ok();
            let current = snapshot
                .as_ref()
                .and_then(|snapshot| autonomy::inherited_in(snapshot, &request.session_id).ok());
            let outcome = match outcome {
                Ok(answers) if current.as_ref() == Some(&fence) => Ok(answers),
                Ok(_)
                    if current.is_some()
                        && snapshot.as_ref().is_some_and(|snapshot| {
                            autonomy::effective_in(snapshot, &request.session_id)
                                .is_ok_and(|effective| effective.can_yolo_answer())
                        }) =>
                {
                    request
                        .questions
                        .iter()
                        .map(fallback_answer)
                        .collect::<Option<Vec<_>>>()
                        .ok_or(session_review::Reason::Unavailable)
                }
                Ok(_) => Err(session_review::Reason::Disabled),
                Err(reason) => Err(reason),
            };
            drop(snapshot);
            match outcome {
                Ok(answers) => {
                    let settled = state::emit::<question::Replied>(
                        &service.0.publish,
                        &question::RepliedData {
                            session_id: request.session_id.clone(),
                            request_id: request.id.clone(),
                            answers: answers.clone(),
                        },
                    )
                    .map(|_| answers)
                    .map_err(Error::Publish);
                    let _ = sender.send(settled);
                }
                Err(reason) => {
                    let asleep = service
                        .0
                        .authority
                        .session(&request.session_id, None)
                        .is_ok_and(|session| session.autonomy.deferred);
                    match (asleep, service.0.reviews.get().cloned()) {
                        (true, Some(reviews)) => {
                            let _ = sender.send(
                                defer(&service.0.publish, &reviews, &request, reason, false).await,
                            );
                        }
                        _ => {
                            let (forward, waiting) = oneshot::channel();
                            let session = request.session_id.clone();
                            match service.register(request, forward) {
                                Ok(()) => {
                                    if let Err(error) = service.reconcile_autonomy(&session).await {
                                        let _ = sender.send(Err(error));
                                        return;
                                    }
                                    let _ =
                                        sender.send(waiting.await.unwrap_or(Err(Error::Rejected)));
                                }
                                Err(error) => {
                                    let _ = sender.send(Err(error));
                                }
                            }
                        }
                    }
                }
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
            service.cancel(&id);
        });
        Ok(Admission::Pending(Wait::new(receiver, move || drop(task))))
    }

    fn register(
        &self,
        request: question::Request,
        sender: oneshot::Sender<Result<Vec<question::Answer>, Error>>,
    ) -> Result<(), Error> {
        let id = request.id.clone();
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if pending.contains_key(&id) {
            return Err(Error::Duplicate);
        }
        pending.insert(
            id.clone(),
            Pending {
                order: state::next_order(),
                request: request.clone(),
                sender,
            },
        );
        if let Err(error) = state::emit::<question::Asked>(&self.0.publish, &request) {
            pending.remove(&id);
            return Err(Error::Publish(error));
        }
        Ok(())
    }

    pub fn reply(&self, id: &question::Id, answers: Vec<question::Answer>) -> Result<(), Error> {
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let item = pending.get(id).ok_or(Error::NotFound)?;
        state::emit::<question::Replied>(
            &self.0.publish,
            &question::RepliedData {
                session_id: item.request.session_id.clone(),
                request_id: id.clone(),
                answers: answers.clone(),
            },
        )
        .map_err(Error::Publish)?;
        let item = pending.remove(id).expect("pending question held by lock");
        let _ = item.sender.send(Ok(answers));
        Ok(())
    }
    pub fn reject(&self, id: &question::Id) -> Result<(), Error> {
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let item = pending.get(id).ok_or(Error::NotFound)?;
        state::emit::<question::Rejected>(
            &self.0.publish,
            &question::RejectedData {
                session_id: item.request.session_id.clone(),
                request_id: id.clone(),
            },
        )
        .map_err(Error::Publish)?;
        let item = pending.remove(id).expect("pending question held by lock");
        let _ = item.sender.send(Err(Error::Rejected));
        Ok(())
    }
    pub fn list(&self) -> Vec<question::Request> {
        self.list_ordered()
            .into_iter()
            .map(|(_, request)| request)
            .collect()
    }
    pub fn list_ordered(&self) -> Vec<(u64, question::Request)> {
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .values()
            .map(|item| (item.order, item.request.clone()))
            .collect::<Vec<_>>();
        pending.sort_by_key(|(order, _)| *order);
        pending
    }
    pub fn snapshots(&self, session: &SessionId, limit: usize) -> Vec<Snapshot<question::Request>> {
        self.list_ordered()
            .into_iter()
            .filter(|(_, request)| &request.session_id == session)
            .take(limit)
            .map(|(order, request)| Snapshot {
                order,
                fingerprint: fingerprint(&request),
                request,
            })
            .collect()
    }
    pub async fn reconsider(
        &self,
        id: &question::Id,
        input: Reconsider<question::Request>,
    ) -> Result<Reconsidered, CoordError> {
        let fingerprint = &input.fingerprint;
        let escalate = |reason: &str| Ok(Reconsidered::escalated(fingerprint, reason));
        let (request, order) = {
            let pending = self
                .0
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let Some(item) = pending
                .get(id)
                .filter(|item| &self::fingerprint(&item.request) == fingerprint)
            else {
                return Ok(Reconsidered::stale(fingerprint));
            };
            (item.request.clone(), item.order)
        };
        let Some(_claim) = Claim::acquire(&self.0.reconsidering, id.clone()) else {
            return escalate("native-assessment-in-progress");
        };
        if !(input.gate.validate)(request.clone()).await {
            return escalate("delegation-invalid");
        }
        match self.0.authority.session(&request.session_id, None) {
            Ok(_) => {}
            Err(state::Error::NotFound(_)) => return Ok(Reconsidered::stale(fingerprint)),
            Err(state::Error::Store(error)) => return Err(CoordError::Store(error)),
            Err(error) => return Err(CoordError::refused(format!("{error:?}"))),
        }
        let snapshot = self.0.authority.store.snapshot()?;
        let fence = match autonomy::inherited_in(&snapshot, &request.session_id) {
            Ok(fence) => fence,
            Err(autonomy::Error::NotFound(_)) => return Ok(Reconsidered::stale(fingerprint)),
            Err(autonomy::Error::Store(error)) => return Err(CoordError::Store(error)),
        };
        let effective = autonomy::effective_in(&snapshot, &request.session_id)
            .map_err(|error| CoordError::refused(error.to_string()))?;
        drop(snapshot);
        let yolo = effective.can_yolo_answer();
        if !yolo && !effective.can_auto_answer() {
            return escalate("explicit-decision:manual-answers");
        }
        let (decided, via) = if yolo {
            let outcome = match self.0.decision.get().cloned() {
                Some(evaluator) => {
                    automatic(
                        evaluator.as_ref(),
                        &request,
                        false,
                        &Cancellation::default(),
                    )
                    .await
                }
                None => request
                    .questions
                    .iter()
                    .map(fallback_answer)
                    .collect::<Option<Vec<_>>>()
                    .map(|answers| Automatic {
                        answers,
                        confidence: None,
                    })
                    .ok_or(session_review::Reason::Unavailable),
            };
            match outcome {
                Ok(decided) => (decided, "yolo"),
                Err(reason) => return Ok(Reconsidered::escalated(fingerprint, id_text(&reason))),
            }
        } else {
            match deterministic(&request) {
                Ok(answers) => (
                    Automatic {
                        answers,
                        confidence: None,
                    },
                    "auto-answer",
                ),
                Err(reason) => return Ok(Reconsidered::escalated(fingerprint, reason)),
            }
        };
        let current = {
            let pending = self
                .0
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            pending
                .get(id)
                .filter(|item| {
                    item.order == order && &self::fingerprint(&item.request) == fingerprint
                })
                .map(|item| item.request.clone())
        };
        let Some(current) = current else {
            return Ok(Reconsidered::stale(fingerprint));
        };
        if !(input.gate.validate)(current).await {
            return escalate("delegation-invalid");
        }
        input.source.reply_source(via, decided.confidence)?;
        let mut settled = self.settle_automatic(&request, order, &fence, decided, via, || {
            (input.gate.current)()
        })?;
        if settled.settled {
            settled.source = Some(
                input
                    .source
                    .reply_source(settled.via.unwrap_or(via), settled.confidence)?,
            );
        }
        Ok(settled)
    }

    fn settle_automatic(
        &self,
        request: &question::Request,
        order: u64,
        fence: &autonomy::Snapshot,
        mut decided: Automatic,
        mut via: &'static str,
        current: impl FnOnce() -> bool,
    ) -> Result<Reconsidered, CoordError> {
        let id = &request.id;
        let fingerprint = &self::fingerprint(request);
        let escalate = |reason: &str| Ok(Reconsidered::escalated(fingerprint, reason));
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(item) = pending
            .get(id)
            .filter(|item| item.order == order && &self::fingerprint(&item.request) == fingerprint)
        else {
            return Ok(Reconsidered::stale(fingerprint));
        };
        if !current() {
            return escalate("delegation-invalid");
        }
        let snapshot = self.0.authority.store.snapshot()?;
        let current = autonomy::inherited_in(&snapshot, &request.session_id)
            .map_err(|error| CoordError::refused(error.to_string()))?;
        if &current != fence {
            if !autonomy::effective_in(&snapshot, &request.session_id)
                .map_err(|error| CoordError::refused(error.to_string()))?
                .can_yolo_answer()
            {
                return escalate("stale-assessment");
            }
            let Some(answers) = request.questions.iter().map(fallback_answer).collect() else {
                return escalate("invalid-answer");
            };
            decided = Automatic {
                answers,
                confidence: None,
            };
            via = "yolo";
        }
        if invalid_answers(&item.request, &decided.answers) {
            return escalate("invalid-answer");
        }
        state::emit::<question::Replied>(
            &self.0.publish,
            &question::RepliedData {
                session_id: item.request.session_id.clone(),
                request_id: id.clone(),
                answers: decided.answers.clone(),
            },
        )
        .map_err(CoordError::refused)?;
        let item = pending.remove(id).expect("pending question held by lock");
        let _ = item.sender.send(Ok(decided.answers));
        let mut settled = Reconsidered::settled(fingerprint, DecisionOutcome::Allowed, via);
        settled.confidence = decided.confidence;
        Ok(settled)
    }
    pub async fn reconsider_goal(
        &self,
        id: &question::Id,
        input: GoalReconsider<question::Request, Vec<question::Answer>>,
    ) -> Result<Reconsidered, CoordError> {
        let request = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(id)
            .map(|entry| entry.request.clone());
        if request.as_ref().is_some_and(|request| {
            self.0
                .authority
                .session(&request.session_id, None)
                .is_ok_and(|authority| authority.autonomy.can_yolo_answer())
        }) {
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
        let (request, order) = {
            let pending = self
                .0
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let Some(item) = pending
                .get(id)
                .filter(|item| &self::fingerprint(&item.request) == fingerprint)
            else {
                return Ok(Reconsidered::stale(fingerprint));
            };
            (item.request.clone(), item.order)
        };
        let Some(_claim) = Claim::acquire(&self.0.reconsidering, id.clone()) else {
            return escalate("native-assessment-in-progress");
        };
        if !(input.gate.validate)(request.clone()).await {
            return escalate("delegation-invalid");
        }
        match self.0.authority.session(&request.session_id, None) {
            Ok(_) => {}
            Err(state::Error::NotFound(_)) => return Ok(Reconsidered::stale(fingerprint)),
            Err(state::Error::Store(error)) => return Err(CoordError::Store(error)),
            Err(error) => return Err(CoordError::refused(format!("{error:?}"))),
        }
        let fence = crate::session::autonomy::inherited_in(
            &self.0.authority.store.snapshot()?,
            &request.session_id,
        )
        .map_err(|error| CoordError::refused(error.to_string()))?;
        if input
            .confidence
            .is_some_and(|confidence| !confidence.is_finite() || confidence < ANSWER_THRESHOLD)
        {
            return escalate("low_confidence");
        }
        let (answers, via) = match input.answer.clone() {
            Some(answers) => {
                if invalid_answers(&request, &answers) {
                    return escalate("invalid-answer");
                }
                (answers, GOAL_VIA)
            }
            None => match deterministic_goal_answers(&request) {
                Some(answers) => (answers, "auto-answer"),
                None => return escalate("refused"),
            },
        };
        let current = {
            let pending = self
                .0
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            pending
                .get(id)
                .filter(|item| {
                    item.order == order && &self::fingerprint(&item.request) == fingerprint
                })
                .map(|item| item.request.clone())
        };
        let Some(current) = current else {
            return Ok(Reconsidered::stale(fingerprint));
        };
        if !(input.gate.validate)(current).await {
            return escalate("delegation-invalid");
        }
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(item) = pending
            .get(id)
            .filter(|item| item.order == order && &self::fingerprint(&item.request) == fingerprint)
        else {
            return Ok(Reconsidered::stale(fingerprint));
        };
        if !(input.gate.current)() {
            return escalate("delegation-invalid");
        }
        if crate::session::autonomy::inherited_in(
            &self.0.authority.store.snapshot()?,
            &request.session_id,
        )
        .map_err(|error| CoordError::refused(error.to_string()))?
            != fence
        {
            return escalate("stale-assessment");
        }
        let confidence = (via == GOAL_VIA).then_some(input.confidence).flatten();
        let source = input.source.reply_source(via, confidence)?;
        state::emit::<question::Replied>(
            &self.0.publish,
            &question::RepliedData {
                session_id: item.request.session_id.clone(),
                request_id: id.clone(),
                answers: answers.clone(),
            },
        )
        .map_err(CoordError::refused)?;
        let item = pending.remove(id).expect("pending question held by lock");
        let _ = item.sender.send(Ok(answers));
        let mut settled = Reconsidered::settled(fingerprint, DecisionOutcome::Allowed, via);
        settled.confidence = confidence;
        settled.source = Some(source);
        Ok(settled)
    }
    pub fn cancel(&self, id: &question::Id) {
        if let Some((_, cancellation)) = self
            .0
            .deciding
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(id)
        {
            cancellation.cancel();
        }
        if let Some(item) = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(id)
        {
            let _ = item.sender.send(Err(Error::Rejected));
        }
    }
    pub fn has_pending(&self) -> bool {
        !self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .is_empty()
            || self
                .0
                .deciding
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .values()
                .any(|(_, cancellation)| !cancellation.is_cancelled())
    }
    pub fn shutdown(&self) {
        for (_, cancellation) in self
            .0
            .deciding
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .values()
        {
            cancellation.cancel();
        }
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for (_, item) in std::mem::take(&mut *pending) {
            let _ = item.sender.send(Err(Error::Rejected));
        }
    }

    pub fn cancel_session(&self, session: &SessionId) {
        for (id, cancellation) in self
            .0
            .deciding
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .values()
        {
            if id == session {
                cancellation.cancel();
            }
        }
        for request in self
            .list()
            .into_iter()
            .filter(|request| &request.session_id == session)
        {
            self.cancel(&request.id);
        }
    }
}

pub fn fingerprint(request: &question::Request) -> ycoding_schema::LosslessString {
    let identity = ObjectEncoder::new()
        .field("sessionID", &request.session_id)
        .field("questions", &request.questions)
        .finish();
    crate::session::prompt_cache::sha256(&crate::session::prompt_cache::canonical_json(&identity))
        .into()
}

fn duplicate_labels(question: &question::Info) -> bool {
    question.options.iter().enumerate().any(|(index, option)| {
        question.options[..index]
            .iter()
            .any(|prior| prior.label == option.label)
    })
}

fn invalid_answers(request: &question::Request, answers: &[question::Answer]) -> bool {
    answers.len() != request.questions.len()
        || request
            .questions
            .iter()
            .zip(answers)
            .any(|(question, answer)| {
                (question.multiple != Some(true) && answer.len() > 1)
                    || (question.custom == Some(false)
                        && answer.iter().any(|text| {
                            !question.options.iter().any(|option| &option.label == text)
                        }))
                    || answer
                        .iter()
                        .enumerate()
                        .any(|(index, text)| answer.iter().take(index).any(|prior| prior == text))
            })
}

pub fn deterministic_goal_answers(request: &question::Request) -> Option<Vec<question::Answer>> {
    deterministic(request)
        .ok()
        .filter(|answers| !invalid_answers(request, answers))
}

fn recommended_answers(request: &question::Request) -> Option<Vec<question::Answer>> {
    request.questions.iter().map(recommended_answer).collect()
}

fn recommended_answer(question: &question::Info) -> Option<question::Answer> {
    let marked = question
        .options
        .iter()
        .filter(|option| super::recommended(&option.label))
        .map(|option| option.label.clone())
        .collect::<Vec<_>>();
    (marked.len() == 1).then_some(marked)
}

struct Automatic {
    answers: Vec<question::Answer>,
    confidence: Option<f64>,
}

fn deterministic(request: &question::Request) -> Result<Vec<question::Answer>, LosslessString> {
    let mut answers = Vec::new();
    let mut unsettled = false;
    for question in &request.questions {
        if duplicate_labels(question) {
            unsettled = true;
            answers.push(Vec::new());
            continue;
        }
        match recommended_answer(question) {
            Some(answer) => answers.push(answer),
            None => {
                return Err(if question.options.is_empty() {
                    "free_text".into()
                } else {
                    "disabled".into()
                });
            }
        }
    }
    if unsettled {
        return Err(id_text(&session_review::Reason::InvalidRequest));
    }
    Ok(answers)
}

fn lower(confidence: &mut Option<f64>, score: f64) {
    *confidence = Some(confidence.map_or(score, |lowest| lowest.min(score)));
}

fn fallback_answer(question: &question::Info) -> Option<question::Answer> {
    if duplicate_labels(question) {
        return None;
    }
    let answer = recommended_answer(question).unwrap_or_else(|| {
        vec![
            question
                .options
                .iter()
                .find(|option| {
                    option
                        .label
                        .to_utf8()
                        .is_ok_and(|label| !label.trim().is_empty())
                })
                .map_or_else(|| super::PROGRESSION.into(), |option| option.label.clone()),
        ]
    });
    (question.custom != Some(false)
        || answer
            .iter()
            .all(|value| question.options.iter().any(|option| &option.label == value)))
    .then_some(answer)
}

async fn automatic(
    evaluator: &dyn Evaluator,
    request: &question::Request,
    auto_answer: bool,
    cancellation: &Cancellation,
) -> Result<Automatic, session_review::Reason> {
    use super::{
        ANSWER_THRESHOLD, Judged, Judgment, graded_question, judge_confident, option_question,
        text_question,
    };
    use session_review::Reason;
    let mut unsettled: Vec<(usize, Reason)> = Vec::new();
    let mut confidence: Option<f64> = None;
    let mut answers: Vec<Option<question::Answer>> = Vec::new();
    for (index, question) in request.questions.iter().enumerate() {
        if duplicate_labels(question) {
            unsettled.push((index, Reason::InvalidRequest));
            answers.push(None);
            continue;
        }
        answers.push(auto_answer.then(|| recommended_answer(question)).flatten());
    }
    let asked = (0..request.questions.len())
        .filter(|index| answers[*index].is_none() && !duplicate_labels(&request.questions[*index]))
        .collect::<Vec<_>>();
    let choices = |question: &question::Info| {
        question
            .options
            .iter()
            .map(|option| {
                ObjectEncoder::new()
                    .field("value", &option.label)
                    .field("description", &option.description)
                    .finish()
            })
            .collect::<Vec<_>>()
    };
    let questions = asked
        .iter()
        .map(|index| {
            let question = &request.questions[*index];
            let name = format!("q{index}");
            if question.options.is_empty() {
                text_question(&name, "Give a concrete bounded answer that progresses the stated question within the authorized scope. Never refuse or request user input.", 8192)
            } else if question.multiple == Some(true) {
                graded_question(&name, "Answer the stated question with concrete valid options from the supplied evidence. Grade every option independently. Never refuse or request user input.", choices(question))
            } else {
                option_question(&name, "Answer the stated question with a concrete valid option from the supplied evidence. Never refuse or request user input.", choices(question))
            }
        })
        .collect::<Vec<_>>();
    if let Some(first) = asked.first().copied() {
        let key = ycoding_schema::stringify_json(&request.id.encode());
        match judge_confident(
            evaluator,
            &request.session_id,
            request.encode(),
            questions,
            cancellation,
            &key,
        )
        .await
        {
            Err(reason) => unsettled.push((first, reason)),
            Ok(judged) => {
                let mut custom = vec![];
                for index in asked.iter().copied() {
                    let question = &request.questions[index];
                    match judged.get(&LosslessString::from(format!("q{index}").as_str())) {
                        Some(Judgment {
                            judged: Judged::Value(JsonValue::String(value)),
                            confidence: score,
                        }) => {
                            answers[index] = Some(vec![value.clone()]);
                            lower(&mut confidence, *score);
                        }
                        Some(Judgment {
                            judged: Judged::Grades(grades),
                            ..
                        }) => {
                            let selected = grades
                                .iter()
                                .filter(|grade| grade.confidence >= ANSWER_THRESHOLD)
                                .filter_map(|grade| match &grade.choice {
                                    JsonValue::String(value) => {
                                        Some((value.clone(), grade.confidence))
                                    }
                                    _ => None,
                                })
                                .collect::<Vec<_>>();
                            if selected.is_empty() {
                                unsettled.push((index, Reason::LowConfidence));
                                continue;
                            }
                            for (_, score) in &selected {
                                lower(&mut confidence, *score);
                            }
                            answers[index] =
                                Some(selected.into_iter().map(|(value, _)| value).collect());
                        }
                        Some(Judgment {
                            judged: Judged::Unsettled(reason),
                            ..
                        }) if question.options.is_empty()
                            || question.multiple == Some(true)
                            || question.custom == Some(false) =>
                        {
                            unsettled.push((index, *reason));
                        }
                        Some(Judgment {
                            judged: Judged::Unsettled(_),
                            ..
                        }) => custom.push(index),
                        _ => unsettled.push((index, Reason::InvalidOutput)),
                    }
                }
                if let Some(first) = custom.first().copied() {
                    let key = format!(
                        "{}:custom",
                        ycoding_schema::stringify_json(&request.id.encode())
                    );
                    match judge_confident(
                        evaluator,
                        &request.session_id,
                        request.encode(),
                        custom
                            .iter()
                            .map(|index| text_question(&format!("q{index}"), "The user cannot answer right now and no listed option was settled. Give a bounded custom free-text answer only when the evidence clearly supports one. Refuse otherwise; refusal asks the user instead.", 8192))
                            .collect(),
                        cancellation,
                        &key,
                    )
                    .await
                    {
                        Err(reason) => unsettled.push((first, reason)),
                        Ok(judged) => {
                            for index in custom {
                                match judged
                                    .get(&LosslessString::from(format!("q{index}").as_str()))
                                {
                                    Some(Judgment {
                                        judged: Judged::Value(JsonValue::String(value)),
                                        confidence: score,
                                    }) => {
                                        answers[index] = Some(vec![value.clone()]);
                                        lower(&mut confidence, *score);
                                    }
                                    Some(Judgment {
                                        judged: Judged::Unsettled(reason),
                                        ..
                                    }) => unsettled.push((index, *reason)),
                                    _ => unsettled.push((index, Reason::InvalidOutput)),
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    if request.questions.iter().any(duplicate_labels) {
        return Err(Reason::InvalidRequest);
    }
    let fallback_used = !unsettled.is_empty() || answers.iter().any(Option::is_none);
    for (answer, question) in answers.iter_mut().zip(&request.questions) {
        if answer.is_none() {
            *answer = fallback_answer(question);
        }
    }
    let answers = answers
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .ok_or(Reason::InvalidOutput)?;
    Ok(Automatic {
        answers,
        confidence: (!fallback_used).then_some(confidence).flatten(),
    })
}

async fn defer(
    publish: &Publisher,
    reviews: &Reviews,
    request: &question::Request,
    reason: session_review::Reason,
    conversion: bool,
) -> Result<Vec<question::Answer>, Error> {
    let origin = request
        .tool
        .as_ref()
        .and_then(|tool| {
            session_review::Origin::decode(
                &ObjectEncoder::new()
                    .field("messageID", &tool.message_id)
                    .field("callID", &tool.call_id)
                    .finish(),
            )
            .ok()
        })
        .unwrap_or_else(|| super::request_origin(&request.id));
    let item_id = match reviews
        .defer(
            &request.session_id,
            session_review::Kind::Question,
            reason,
            origin,
            session_review::Payload::Question(session_review::QuestionPayload {
                questions: request.questions.clone(),
            }),
            conversion,
        )
        .await
    {
        Ok(item_id) => item_id,
        Err(review::Error::Full { limit, .. }) => return Err(Error::ReviewFull { limit }),
        Err(error) => return Err(Error::Review(error)),
    };
    state::emit::<question::Deferred>(
        publish,
        &question::DeferredData {
            session_id: request.session_id.clone(),
            request_id: request.id.clone(),
            item_id: item_id.clone(),
        },
    )
    .map_err(Error::Publish)?;
    Err(Error::Deferred { item_id })
}
