use super::ceiling;
use crate::session::autonomy::{self, Effective, State};
use std::{
    collections::BTreeSet,
    future::Future,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};
use tokio::sync::oneshot;
use ycoding_schema::{DomainDecode, JsonValue, LosslessString, permission, session_id::SessionId};
use ycoding_store::{Client, KeyPart, session::SessionTable, tuple_key};

#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub type_: &'static str,
    pub data: JsonValue,
}
pub type Publisher = Arc<dyn Fn(Event) -> Result<(), String> + Send + Sync>;
pub type Agents = Arc<
    dyn Fn(Option<&LosslessString>) -> Option<(LosslessString, permission::Ruleset)> + Send + Sync,
>;

#[derive(Clone)]
pub struct Authority {
    pub store: Client,
    pub agents: Agents,
}

#[derive(Clone, Debug)]
pub struct SessionAuthority {
    pub session_id: SessionId,
    pub root_session_id: SessionId,
    pub agent: Option<LosslessString>,
    pub configured: permission::Ruleset,
    pub autonomy: Effective,
    pub root_autonomy: Effective,
}

#[derive(Debug)]
pub enum Error {
    Store(ycoding_store::Error),
    NotFound(SessionId),
    InvalidSession,
    ParentCycle,
}
impl From<ycoding_store::Error> for Error {
    fn from(value: ycoding_store::Error) -> Self {
        Self::Store(value)
    }
}

impl Authority {
    pub fn session(
        &self,
        id: &SessionId,
        selected_agent: Option<&LosslessString>,
    ) -> Result<SessionAuthority, Error> {
        let snapshot = self.store.snapshot()?;
        let session = snapshot
            .get::<SessionTable>(&tuple_key(&[KeyPart::String(id.as_lossless())]))?
            .ok_or_else(|| Error::NotFound(id.clone()))?;
        let mut root = session.clone();
        let mut seen = BTreeSet::from([session.id.clone()]);
        while let Some(parent) = &root.parent_id {
            if !seen.insert(parent.clone()) {
                return Err(Error::ParentCycle);
            }
            let parent_id = SessionId::new(parent.clone()).map_err(|_| Error::InvalidSession)?;
            root = snapshot
                .get::<SessionTable>(&tuple_key(&[KeyPart::String(parent)]))?
                .ok_or(Error::NotFound(parent_id))?;
        }
        let selected = selected_agent.or(session.agent.as_ref());
        let resolved = (self.agents)(selected);
        let agent = resolved.as_ref().map(|(agent, _)| agent.clone());
        let mut configured = resolved.map(|(_, rules)| rules).unwrap_or_else(|| {
            vec![permission::Rule {
                action: "*".into(),
                resource: "*".into(),
                effect: permission::Effect("deny".into()),
            }]
        });
        if let Some(ceiling) = &session.permission {
            configured.extend(ceiling::read(ceiling.value()));
        }
        Ok(SessionAuthority {
            session_id: id.clone(),
            root_session_id: SessionId::new(root.id).map_err(|_| Error::InvalidSession)?,
            agent,
            configured,
            autonomy: autonomy::effective_in(&snapshot, id).map_err(|error| match error {
                autonomy::Error::NotFound(id) => Error::NotFound(id),
                autonomy::Error::Store(error) => Error::Store(error),
            })?,
            root_autonomy: State::read(root.autonomy.as_ref()).effective(),
        })
    }
}

pub struct Wait<T> {
    receiver: oneshot::Receiver<T>,
    cancel: Option<Box<dyn FnOnce() + Send>>,
}

pub(crate) struct Task {
    handle: tokio::task::JoinHandle<()>,
    cancel: Box<dyn Fn() + Send>,
}

impl Task {
    pub(crate) fn new(
        handle: tokio::task::JoinHandle<()>,
        cancel: impl Fn() + Send + 'static,
    ) -> Self {
        Self {
            handle,
            cancel: Box::new(cancel),
        }
    }
}

impl Drop for Task {
    fn drop(&mut self) {
        (self.cancel)();
        self.handle.abort();
    }
}

impl<T> Wait<T> {
    pub(crate) fn new(
        receiver: oneshot::Receiver<T>,
        cancel: impl FnOnce() + Send + 'static,
    ) -> Self {
        Self {
            receiver,
            cancel: Some(Box::new(cancel)),
        }
    }
    pub(crate) fn on_cancel(mut self, cancel: impl FnOnce() + Send + 'static) -> Self {
        self.cancel = Some(Box::new(cancel));
        self
    }
}
impl<T> Future for Wait<T> {
    type Output = Result<T, oneshot::error::RecvError>;
    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let result = Pin::new(&mut self.receiver).poll(context);
        if result.is_ready() {
            self.cancel = None;
        }
        result
    }
}
impl<T> Drop for Wait<T> {
    fn drop(&mut self) {
        if let Some(cancel) = self.cancel.take() {
            cancel();
        }
    }
}

pub(crate) fn emit<T: ycoding_schema::event::EventType>(
    publish: &Publisher,
    data: &T::Data,
) -> Result<(), String> {
    use ycoding_schema::DomainEncode;
    publish(Event {
        type_: T::TYPE,
        data: data.encode(),
    })
}

pub(crate) fn decode_id<T: DomainDecode>(prefix: &str, next: u64) -> T {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    T::decode(&JsonValue::String(
        format!("{prefix}{time:032x}{sequence:016x}{next:016x}").into(),
    ))
    .expect("generated branded ID")
}

pub(crate) fn next_order() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    NEXT.fetch_add(1, Ordering::Relaxed)
}
