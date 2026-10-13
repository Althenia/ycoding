mod validation;
use super::{Authority, Publisher, Wait, state};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Instant,
};
use tokio::sync::oneshot;
pub use validation::{automatic_answer, validate_answer, validate_field, validate_fields};
use ycoding_schema::{DomainDecode, form, session_id::SessionId};

const RETENTION: u64 = 600_000;
#[derive(Clone, Debug, PartialEq)]
pub enum Error {
    NotFound,
    AlreadyExists,
    AlreadySettled,
    InvalidForm(ycoding_schema::LosslessString),
    InvalidAnswer(ycoding_schema::LosslessString),
    Publish(String),
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
        }))
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
        let autonomous =
            SessionId::decode(&ycoding_schema::JsonValue::String(form.session_id.clone()))
                .ok()
                .and_then(|session| self.0.authority.session(&session, None).ok())
                .is_some_and(|session| session.autonomy.can_auto_answer());
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
}
