mod validation;
use super::{Authority, Publisher, Reviews, Wait, state};
use crate::{
    process::guardrails::decision::Evaluator, session::review, tools::code_mode::Cancellation,
};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, OnceLock},
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
            session_review::Reason::Error
        };
        if reason == session_review::Reason::Error && self.0.decision.get().is_some() {
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
                settled_at: None,
                sender: None,
            },
        );
        if let Err(error) =
            state::emit::<form::Created>(&self.0.publish, &form::CreatedData { form: form.clone() })
        {
            forms.remove(&form.id);
            return Err(Error::Publish(error));
        }
        Ok(form)
    }
    pub fn ask(&self, form: form::Info) -> Result<Wait<form::State>, Error> {
        if let Some(deferred) = self.defer_asleep(&form)? {
            let (sender, receiver) = oneshot::channel();
            let _ = sender.send(deferred);
            return Ok(Wait::new(receiver, || {}));
        }
        let form = self.create(form)?;
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
        let autonomy =
            SessionId::decode(&ycoding_schema::JsonValue::String(form.session_id.clone()))
                .ok()
                .and_then(|session| self.0.authority.session(&session, None).ok())
                .map(|session| session.autonomy);
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
                let result = automatic(evaluator.as_ref(), &form, &cancellation).await;
                if cancellation.is_cancelled() {
                    return;
                }
                if let Err(error) = service.settle_automatic(&form, &reviews, result) {
                    tracing::warn!(?error, "automatic Form settlement failed");
                    let _ = service.cancel(&form.id);
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
        let autonomous =
            autonomy.is_some_and(|autonomy| autonomy.can_auto_answer() && !autonomy.asleep);
        if autonomous && let Some(answer) = automatic_answer(&form) {
            self.reply(&form.id, answer)?;
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
                entry.state == form::State::Pending
                    && session.is_none_or(|session| &entry.form.session_id == session)
            })
            .map(|entry| (entry.order, entry.form.clone()))
            .collect::<Vec<_>>();
        pending.sort_by_key(|(order, _)| *order);
        pending.into_iter().map(|(_, form)| form).collect()
    }
    pub fn reply(&self, id: &form::Id, answer: form::Answer) -> Result<(), Error> {
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
        entry.settled_at = Some((self.0.clock)());
        if let Some(sender) = entry.sender.take() {
            let _ = sender.send(entry.state.clone());
        }
        Ok(())
    }
    pub fn cancel(&self, id: &form::Id) -> Result<(), Error> {
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
        state::emit::<form::Cancelled>(
            &self.0.publish,
            &form::CancelledData {
                id: id.clone(),
                session_id: entry.form.session_id.clone(),
            },
        )
        .map_err(Error::Publish)?;
        entry.state = form::State::Cancelled;
        entry.settled_at = Some((self.0.clock)());
        if let Some(sender) = entry.sender.take() {
            let _ = sender.send(entry.state.clone());
        }
        Ok(())
    }
    pub fn shutdown(&self) -> Vec<Error> {
        self.list(None)
            .into_iter()
            .filter_map(|form| self.cancel(&form.id).err())
            .collect()
    }

    fn settle_automatic(
        &self,
        form: &form::Info,
        reviews: &Reviews,
        result: Result<form::Answer, session_review::Reason>,
    ) -> Result<(), Error> {
        if let Ok(answer) = &result {
            return self.reply(&form.id, answer.clone());
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
    let session = SessionId::new(form.session_id.clone()).map_err(|_| Reason::Error)?;
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
                .ok_or(Reason::Error)?,
        };
        answer.0.insert(key, value);
    }
    validate_answer(form, &answer).map_err(|_| Reason::Error)?;
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
