use super::{Authority, Publisher, Reviews, Wait, state, timeout};
use crate::{
    process::guardrails::decision::Evaluator, session::review, tools::code_mode::Cancellation,
};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::sync::oneshot;
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, ObjectEncoder, question, session_id::SessionId,
    session_review,
};

#[derive(Debug)]
pub enum Error {
    NotFound,
    Duplicate,
    Rejected,
    TimedOut { seconds: u64 },
    Publish(String),
    Deferred { item_id: session_review::Id },
    ReviewFull { limit: usize },
    Review(review::Error),
}
struct Pending {
    order: u64,
    request: question::Request,
    _timer: Option<timeout::Timer>,
    sender: oneshot::Sender<Result<Vec<question::Answer>, Error>>,
}
struct Inner {
    authority: Authority,
    publish: Publisher,
    pending: Mutex<BTreeMap<question::Id, Pending>>,
    reviews: OnceLock<Reviews>,
    decision: OnceLock<Arc<dyn Evaluator>>,
    deciding: Mutex<BTreeMap<question::Id, (SessionId, Cancellation)>>,
    timeout_seconds: AtomicU64,
}
#[derive(Clone)]
pub struct Questions(Arc<Inner>);
pub enum Admission {
    Answered(Vec<question::Answer>),
    Pending(Wait<Result<Vec<question::Answer>, Error>>),
}

impl Questions {
    pub fn new(authority: Authority, publish: Publisher) -> Self {
        Self(Arc::new(Inner {
            authority,
            publish,
            pending: Mutex::new(BTreeMap::new()),
            reviews: OnceLock::new(),
            decision: OnceLock::new(),
            deciding: Mutex::new(BTreeMap::new()),
            timeout_seconds: AtomicU64::new(timeout::DEFAULT_SECONDS),
        }))
    }
    pub fn with_timeout_seconds(self, seconds: u64) -> Self {
        self.0
            .timeout_seconds
            .store(seconds.min(timeout::MAX_SECONDS), Ordering::Relaxed);
        self
    }
    pub fn with_reviews(self, reviews: Reviews) -> Self {
        let _ = self.0.reviews.set(reviews);
        self
    }
    pub fn with_decision(self, evaluator: Arc<dyn Evaluator>) -> Self {
        let _ = self.0.decision.set(evaluator);
        self
    }
    pub async fn defer_pending(&self, session: &SessionId) -> Result<usize, Error> {
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
                session_review::Reason::SleepEntry,
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
            .map(|session| session.autonomy);
        if autonomy.is_some_and(|autonomy| autonomy.asleep)
            && let Some(reviews) = self.0.reviews.get().cloned()
        {
            let reason = if !autonomy.is_some_and(|autonomy| autonomy.can_auto_answer()) {
                session_review::Reason::Disabled
            } else if request
                .questions
                .iter()
                .any(|question| question.options.is_empty())
            {
                session_review::Reason::FreeText
            } else {
                session_review::Reason::Error
            };
            let (sender, receiver) = oneshot::channel();
            let publish = self.0.publish.clone();
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
            let evaluator = self.0.decision.get().cloned();
            let authority = self.0.authority.clone();
            let cancel = cancellation.clone();
            let task = tokio::spawn(async move {
                let outcome = if reason == session_review::Reason::Error {
                    match evaluator {
                        Some(evaluator) => {
                            automatic(evaluator.as_ref(), &request, &cancellation).await
                        }
                        None => Err(session_review::Reason::Unavailable),
                    }
                } else {
                    Err(reason)
                };
                if cancellation.is_cancelled() {
                    return;
                }
                let outcome = if outcome.is_ok()
                    && !authority
                        .session(&request.session_id, None)
                        .is_ok_and(|session| session.autonomy.can_auto_answer())
                {
                    Err(session_review::Reason::Disabled)
                } else {
                    outcome
                };
                let outcome = match outcome {
                    Ok(answers) => state::emit::<question::Replied>(
                        &publish,
                        &question::RepliedData {
                            session_id: request.session_id.clone(),
                            request_id: request.id.clone(),
                            answers: answers.clone(),
                        },
                    )
                    .map(|_| answers)
                    .map_err(Error::Publish),
                    Err(reason) => defer(&publish, &reviews, &request, reason, false).await,
                };
                let _ = sender.send(outcome);
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
            });
            return Ok(Admission::Pending(Wait::new(receiver, move || drop(task))));
        }
        if self
            .0
            .authority
            .session(&request.session_id, None)
            .is_ok_and(|session| session.autonomy.can_auto_answer() && !session.autonomy.asleep)
        {
            return Ok(Admission::Answered(
                request
                    .questions
                    .iter()
                    .map(|question| {
                        vec![
                            question
                                .options
                                .first()
                                .filter(|option| !option.label.is_empty())
                                .map_or_else(
                                    || "Continue with the safest reasonable default.".into(),
                                    |option| option.label.clone(),
                                ),
                        ]
                    })
                    .collect(),
            ));
        }
        let id = request.id.clone();
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if pending.contains_key(&id) {
            return Err(Error::Duplicate);
        }
        let (sender, receiver) = oneshot::channel();
        pending.insert(
            id.clone(),
            Pending {
                order: state::next_order(),
                request: request.clone(),
                _timer: None,
                sender,
            },
        );
        if let Err(error) = state::emit::<question::Asked>(&self.0.publish, &request) {
            pending.remove(&id);
            return Err(Error::Publish(error));
        }
        let entry = pending.get_mut(&id).expect("new question");
        let order = entry.order;
        let timer_id = id.clone();
        let weak = Arc::downgrade(&self.0);
        let seconds = self.0.timeout_seconds.load(Ordering::Relaxed);
        entry._timer = timeout::arm(seconds, move || {
            if let Some(inner) = weak.upgrade()
                && let Err(error) = Questions(inner).timeout(&timer_id, order, seconds)
            {
                tracing::warn!(?error, "question timeout failed");
            }
        });
        let service = self.clone();
        Ok(Admission::Pending(Wait::new(receiver, move || {
            service.cancel(&id);
        })))
    }
    fn timeout(&self, id: &question::Id, order: u64, seconds: u64) -> Result<(), Error> {
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(item) = pending.get(id).filter(|item| item.order == order) else {
            return Ok(());
        };
        state::emit::<question::TimedOut>(
            &self.0.publish,
            &question::TimedOutData {
                session_id: item.request.session_id.clone(),
                request_id: id.clone(),
            },
        )
        .map_err(Error::Publish)?;
        let item = pending.remove(id).expect("question held by lock");
        let _ = item.sender.send(Err(Error::TimedOut { seconds }));
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
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .values()
            .map(|item| (item.order, item.request.clone()))
            .collect::<Vec<_>>();
        pending.sort_by_key(|(order, _)| *order);
        pending.into_iter().map(|(_, request)| request).collect()
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

async fn automatic(
    evaluator: &dyn Evaluator,
    request: &question::Request,
    cancellation: &Cancellation,
) -> Result<Vec<question::Answer>, session_review::Reason> {
    let questions = request.questions.iter().enumerate().flat_map(|(index, question)| {
        if question.multiple == Some(true) {
            return question.options.iter().enumerate().map(|(option, value)| super::option_question(
                &format!("q{index}o{option}"),
                &format!("Decide whether this listed option should be selected: {}. Refuse when the evidence is insufficient.", String::from_utf16_lossy(&value.label.code_units().collect::<Vec<_>>())),
                [true, false].into_iter().map(|value| ObjectEncoder::new().field("value", &value).finish()).collect(),
            )).collect::<Vec<_>>();
        }
        vec![super::option_question(&format!("q{index}"), "Select one listed answer using the question and available evidence. Refuse when the evidence is insufficient.", question.options.iter().map(|option| ObjectEncoder::new().field("value", &option.label).field("description", &option.description).finish()).collect())]
    }).collect();
    let answers = super::answer_options(
        evaluator,
        &request.session_id,
        request.encode(),
        questions,
        cancellation,
    )
    .await?;
    request
        .questions
        .iter()
        .enumerate()
        .map(|(index, question)| {
            if question.multiple == Some(true) {
                return Ok(question
                    .options
                    .iter()
                    .enumerate()
                    .filter(|(option, _)| {
                        answers.get(&format!("q{index}o{option}").into())
                            == Some(&JsonValue::Bool(true))
                    })
                    .map(|(_, option)| option.label.clone())
                    .collect());
            }
            match answers.get(&format!("q{index}").into()) {
                Some(JsonValue::String(value)) => Ok(vec![value.clone()]),
                _ => Err(session_review::Reason::InvalidOutput),
            }
        })
        .collect()
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
