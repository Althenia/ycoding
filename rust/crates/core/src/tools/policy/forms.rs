mod validation;
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
    time::Instant,
};
use tokio::sync::oneshot;
pub use validation::{automatic_answer, validate_answer, validate_field, validate_fields};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, form, session_id::SessionId, session_review,
};

const RETENTION: u64 = 600_000;
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
    automatic: bool,
    visible: bool,
    failure: Option<Error>,
    timer: Option<timeout::Timer>,
    settled_at: Option<u64>,
    sender: Option<oneshot::Sender<form::State>>,
}
struct Inner {
    authority: Authority,
    publish: Publisher,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    forms: Mutex<BTreeMap<form::Id, Entry>>,
    reviews: OnceLock<Reviews>,
    decision: OnceLock<Arc<dyn Evaluator>>,
    deciding: Mutex<BTreeMap<form::Id, Cancellation>>,
    timeout_seconds: AtomicU64,
}
#[derive(Clone)]
pub struct Forms(Arc<Inner>);

impl Forms {
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
            let item_id = open(&reviews, &info, session_review::Reason::SleepEntry, true).await?;
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
            entry.state = form::State::Deferred { item_id };
            entry.settled_at = Some((self.0.clock)());
            entry.timer.take();
            if let Some(sender) = entry.sender.take() {
                let _ = sender.send(entry.state.clone());
            }
            deferred += 1;
        }
        Ok(deferred)
    }
    fn defer_asleep(&self, form: &form::Info) -> Result<Option<form::State>, Error> {
        let Some(reviews) = self.0.reviews.get() else {
            return Ok(None);
        };
        let Some(autonomy) = SessionId::decode(&JsonValue::String(form.session_id.clone()))
            .ok()
            .and_then(|session| self.0.authority.session(&session, None).ok())
            .map(|session| session.autonomy)
            .filter(|autonomy| autonomy.asleep)
        else {
            return Ok(None);
        };
        validate_fields(&form.fields.0).map_err(Error::InvalidForm)?;
        let reason = if !autonomy.can_auto_answer() {
            session_review::Reason::Disabled
        } else if form.fields.0.iter().any(required_free_text) {
            session_review::Reason::FreeText
        } else {
            session_review::Reason::Unavailable
        };
        if reason == session_review::Reason::Unavailable && self.0.decision.get().is_some() {
            return Ok(None);
        }
        let item_id = reviews
            .service
            .open_now(review_input(reviews, form, reason, false)?)
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
        Ok(Some(form::State::Deferred { item_id }))
    }
    fn expire(&self, forms: &mut BTreeMap<form::Id, Entry>) {
        let now = (self.0.clock)();
        forms.retain(|_, entry| {
            entry
                .settled_at
                .is_none_or(|settled| now.saturating_sub(settled) < RETENTION)
        });
    }
    pub fn create(&self, form: form::Info) -> Result<form::Info, Error> {
        self.create_pending(form, true, true)
    }
    fn create_pending(
        &self,
        form: form::Info,
        visible: bool,
        timed: bool,
    ) -> Result<form::Info, Error> {
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
                automatic: false,
                visible,
                failure: None,
                timer: None,
                settled_at: None,
                sender: None,
            },
        );
        if visible
            && let Err(error) = state::emit::<form::Created>(
                &self.0.publish,
                &form::CreatedData { form: form.clone() },
            )
        {
            forms.remove(&form.id);
            return Err(Error::Publish(error));
        }
        let entry = forms.get_mut(&form.id).expect("new Form");
        let order = entry.order;
        let id = form.id.clone();
        let weak = Arc::downgrade(&self.0);
        let seconds = if timed {
            self.0.timeout_seconds.load(Ordering::Relaxed)
        } else {
            0
        };
        entry.timer = timeout::arm(seconds, move || {
            if let Some(inner) = weak.upgrade()
                && let Err(error) = Forms(inner).timeout(&id, order, seconds)
            {
                tracing::warn!(?error, "Form timeout failed");
            }
        });
        Ok(form)
    }
    fn timeout(&self, id: &form::Id, order: u64, seconds: u64) -> Result<(), Error> {
        let mut forms = self
            .0
            .forms
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(entry) = forms
            .get_mut(id)
            .filter(|entry| entry.order == order && entry.state == form::State::Pending)
        else {
            return Ok(());
        };
        state::emit::<form::TimedOut>(
            &self.0.publish,
            &form::TimedOutData {
                id: id.clone(),
                session_id: entry.form.session_id.clone(),
            },
        )
        .map_err(Error::Publish)?;
        entry.state = form::State::TimedOut {
            seconds: ycoding_schema::schema::PositiveInt::new(seconds as i64)
                .expect("nonzero bounded timeout"),
        };
        entry.settled_at = Some((self.0.clock)());
        entry.timer.take();
        if let Some(sender) = entry.sender.take() {
            let _ = sender.send(entry.state.clone());
        }
        Ok(())
    }
    pub fn ask(&self, form: form::Info) -> Result<Wait<form::State>, Error> {
        if let Some(deferred) = self.defer_asleep(&form)? {
            let (sender, receiver) = oneshot::channel();
            let _ = sender.send(deferred);
            return Ok(Wait::new(receiver, || {}));
        }
        let autonomy = SessionId::decode(&JsonValue::String(form.session_id.clone()))
            .ok()
            .and_then(|session| self.0.authority.session(&session, None).ok())
            .map(|session| session.autonomy);
        let asleep_automatic = autonomy
            .is_some_and(|state| state.asleep && state.can_auto_answer())
            && self.0.decision.get().is_some()
            && self.0.reviews.get().is_some();
        let immediate_answer = autonomy
            .is_some_and(|state| !state.asleep && state.can_auto_answer())
            .then(|| automatic_answer(&form))
            .flatten();
        let form = self.create_pending(
            form,
            !asleep_automatic,
            !asleep_automatic && immediate_answer.is_none(),
        )?;
        let (sender, receiver) = oneshot::channel();
        {
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
        }
        if autonomy.is_some_and(|autonomy| autonomy.can_auto_answer() && autonomy.asleep)
            && let (Some(evaluator), Some(reviews)) = (
                self.0.decision.get().cloned(),
                self.0.reviews.get().cloned(),
            )
        {
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
                let mut result = automatic(evaluator.as_ref(), &form, &cancellation).await;
                if result.is_ok()
                    && !SessionId::new(form.session_id.clone())
                        .ok()
                        .and_then(|session| service.0.authority.session(&session, None).ok())
                        .is_some_and(|session| session.autonomy.can_auto_answer())
                {
                    result = Err(session_review::Reason::Disabled);
                }
                if cancellation.is_cancelled() {
                    return;
                }
                if let Err(error) = service.settle_automatic(&form, &reviews, result) {
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
        if let Some(answer) = immediate_answer {
            match self.reply_with_origin(&form.id, answer, true) {
                Ok(()) | Err(Error::AlreadySettled) => {}
                Err(error) => return Err(error),
            }
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
        pending.into_iter().map(|(_, form)| form).collect()
    }
    pub fn reply(&self, id: &form::Id, answer: form::Answer) -> Result<(), Error> {
        self.reply_with_origin(id, answer, false)
    }
    pub fn answered_automatically(&self, id: &form::Id) -> Result<bool, Error> {
        self.0
            .forms
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(id)
            .map(|entry| entry.automatic)
            .ok_or(Error::NotFound)
    }
    fn reply_with_origin(
        &self,
        id: &form::Id,
        answer: form::Answer,
        automatic: bool,
    ) -> Result<(), Error> {
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
        if !entry.visible {
            return Err(Error::NotFound);
        }
        validate_answer(&entry.form, &answer).map_err(Error::InvalidAnswer)?;
        state::emit::<form::Replied>(
            &self.0.publish,
            &form::RepliedData {
                id: id.clone(),
                session_id: entry.form.session_id.clone(),
                answer: answer.clone(),
            },
        )
        .map_err(Error::Publish)?;
        entry.state = form::State::Answered(answer);
        entry.automatic = automatic;
        entry.settled_at = Some((self.0.clock)());
        entry.timer.take();
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
        entry.state = form::State::Cancelled;
        entry.failure = failure;
        entry.settled_at = Some((self.0.clock)());
        entry.timer.take();
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

    fn settle_automatic(
        &self,
        form: &form::Info,
        reviews: &Reviews,
        result: Result<form::Answer, session_review::Reason>,
    ) -> Result<(), Error> {
        if let Ok(answer) = &result {
            {
                let mut forms = self
                    .0
                    .forms
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                let entry = forms.get_mut(&form.id).ok_or(Error::NotFound)?;
                if entry.state != form::State::Pending {
                    return Ok(());
                }
                if !entry.visible {
                    state::emit::<form::Created>(
                        &self.0.publish,
                        &form::CreatedData { form: form.clone() },
                    )
                    .map_err(Error::Publish)?;
                    entry.visible = true;
                }
            }
            return match self.reply_with_origin(&form.id, answer.clone(), true) {
                Ok(()) | Err(Error::AlreadySettled) => Ok(()),
                Err(error) => Err(error),
            };
        }
        let mut forms = self
            .0
            .forms
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let entry = forms.get_mut(&form.id).ok_or(Error::NotFound)?;
        if entry.state != form::State::Pending {
            return Err(Error::AlreadySettled);
        }
        let item = reviews
            .service
            .open_now(review_input(
                reviews,
                form,
                result.expect_err("unsettled answer"),
                false,
            )?)
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
        entry.state = form::State::Deferred { item_id };
        entry.settled_at = Some((self.0.clock)());
        entry.timer.take();
        if let Some(sender) = entry.sender.take() {
            let _ = sender.send(entry.state.clone());
        }
        Ok(())
    }
}

async fn automatic(
    evaluator: &dyn Evaluator,
    form: &form::Info,
    cancellation: &Cancellation,
) -> Result<form::Answer, session_review::Reason> {
    use ycoding_schema::{JsonObject, ObjectEncoder, session_review::Reason};
    let session = SessionId::new(form.session_id.clone()).map_err(|_| Reason::InvalidRequest)?;
    let mut questions = vec![];
    let mut keys = vec![];
    for (index, field) in form.fields.0.iter().enumerate() {
        let (base, options) = match field {
            form::Field::String(field) => (
                &field.base,
                field
                    .options
                    .as_ref()
                    .map(|options| {
                        options
                            .iter()
                            .map(|option| {
                                ObjectEncoder::new()
                                    .field("value", &option.value)
                                    .field("description", &option.label)
                                    .finish()
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default(),
            ),
            form::Field::Boolean(field) => (
                &field.base,
                [true, false]
                    .into_iter()
                    .map(|value| ObjectEncoder::new().field("value", &value).finish())
                    .collect(),
            ),
            form::Field::Multiselect(field) => {
                for (option, value) in field.options.iter().enumerate() {
                    questions.push(super::option_question(&format!("f{index}o{option}"), &format!("Decide whether this listed option should be selected: {}. Refuse when evidence is insufficient.", String::from_utf16_lossy(&value.label.code_units().collect::<Vec<_>>())), [true, false].into_iter().map(|value| ObjectEncoder::new().field("value", &value).finish()).collect()));
                }
                keys.push((index, field.base.key.clone()));
                continue;
            }
            form::Field::Number(field) if field.base.required != Some(true) => continue,
            form::Field::Integer(field) if field.base.required != Some(true) => continue,
            _ => return Err(Reason::FreeText),
        };
        if options.is_empty() {
            if base.required == Some(true) {
                return Err(Reason::FreeText);
            }
            continue;
        }
        questions.push(super::option_question(&format!("f{index}"), "Select one listed answer using the Form and available evidence. Refuse when evidence is insufficient.", options));
        keys.push((index, base.key.clone()));
    }
    let choices =
        super::answer_options(evaluator, &session, form.encode(), questions, cancellation).await?;
    let mut answer = form::Answer(JsonObject::new());
    for (index, key) in keys {
        let value = match &form.fields.0[index] {
            form::Field::Multiselect(field) => JsonValue::Array(
                field
                    .options
                    .iter()
                    .enumerate()
                    .filter(|(option, _)| {
                        choices.get(&format!("f{index}o{option}").into())
                            == Some(&JsonValue::Bool(true))
                    })
                    .map(|(_, option)| JsonValue::String(option.value.clone()))
                    .collect(),
            ),
            _ => choices
                .get(&format!("f{index}").into())
                .cloned()
                .ok_or(Reason::InvalidOutput)?,
        };
        answer.0.insert(key, value);
    }
    validate_answer(form, &answer).map_err(|_| Reason::InvalidOutput)?;
    Ok(answer)
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
