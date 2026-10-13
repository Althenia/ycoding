use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, Weak},
};
use tokio::{sync::watch, task::JoinSet};
use ycoding_schema::{session, session_error};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InterruptReason {
    User,
    Shutdown,
    Superseded,
}

#[derive(Clone, Debug)]
pub enum Error {
    Store(Arc<ycoding_store::Error>),
    Runner(session_error::Error),
    Interrupted(InterruptReason),
    Panicked,
    Closed,
    AlreadyInstalled,
}

impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "Session execution: {self:?}")
    }
}
impl std::error::Error for Error {}
impl From<ycoding_store::Error> for Error {
    fn from(error: ycoding_store::Error) -> Self {
        Self::Store(Arc::new(error))
    }
}

pub type Outcome = Result<(), Error>;
pub type RunFuture = Pin<Box<dyn Future<Output = Outcome> + Send + 'static>>;

#[derive(Clone)]
pub struct Cancellation(watch::Receiver<Option<InterruptReason>>);
impl Cancellation {
    pub async fn cancelled(&mut self) -> InterruptReason {
        loop {
            if let Some(reason) = *self.0.borrow_and_update() {
                return reason;
            }
            if self.0.changed().await.is_err() {
                return InterruptReason::Shutdown;
            }
        }
    }
    pub fn reason(&self) -> Option<InterruptReason> {
        *self.0.borrow()
    }
}

#[derive(Clone)]
pub struct DrainRequest {
    pub session_id: session::Id,
    pub force: bool,
    pub cancellation: Cancellation,
}

pub trait Drain: Send + Sync + 'static {
    fn drain(&self, request: DrainRequest) -> RunFuture;
    fn started(&self, _id: session::Id) -> RunFuture {
        Box::pin(async { Ok(()) })
    }
    fn settled(&self, _id: session::Id, _outcome: Outcome) -> RunFuture {
        Box::pin(async { Ok(()) })
    }
}

struct Entry {
    generation: u64,
    done: watch::Sender<Option<Outcome>>,
    cancel: watch::Sender<Option<InterruptReason>>,
    stopping: bool,
    settling: bool,
    pending_wake: bool,
}
struct Transition {
    users: usize,
    doorbell: bool,
    done: watch::Sender<bool>,
    lock: Arc<tokio::sync::Mutex<()>>,
}
#[derive(Default)]
struct State {
    entries: BTreeMap<session::Id, Entry>,
    generation: u64,
    closed: bool,
    transitions: BTreeMap<session::Id, Transition>,
    panicked: bool,
}
struct Inner {
    state: Mutex<State>,
    tasks: Mutex<JoinSet<()>>,
    drain: Arc<dyn Drain>,
}

#[derive(Clone)]
pub struct Coordinator(Arc<Inner>);

impl Coordinator {
    pub fn new(drain: Arc<dyn Drain>) -> Self {
        Self(Arc::new(Inner {
            state: Mutex::new(State::default()),
            tasks: Mutex::new(JoinSet::new()),
            drain,
        }))
    }

    pub fn active(&self) -> Vec<session::Id> {
        self.0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .entries
            .keys()
            .cloned()
            .collect()
    }

    pub fn wake(&self, id: &session::Id) -> Outcome {
        self.reap();
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if state.closed {
            return Err(Error::Closed);
        }
        if let Some(transition) = state.transitions.get_mut(id) {
            transition.doorbell = true;
            return Ok(());
        }
        if let Some(entry) = state.entries.get_mut(id) {
            entry.pending_wake = true;
        } else {
            start(&self.0, &mut state, id.clone(), false);
        }
        Ok(())
    }

    pub async fn run(&self, id: &session::Id) -> Outcome {
        loop {
            self.reap();
            let transition = self
                .0
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .transitions
                .get(id)
                .map(|transition| transition.done.subscribe());
            if let Some(mut transition) = transition {
                while !*transition.borrow_and_update() {
                    if transition.changed().await.is_err() {
                        return Err(Error::Closed);
                    }
                }
                continue;
            }
            let (receiver, stopping) = {
                let mut state = self
                    .0
                    .state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                if state.closed {
                    return Err(Error::Closed);
                }
                if state.transitions.contains_key(id) {
                    continue;
                }
                if !state.entries.contains_key(id) {
                    start(&self.0, &mut state, id.clone(), true);
                }
                let entry = state.entries.get(id).expect("started execution exists");
                (entry.done.subscribe(), entry.stopping)
            };
            let outcome = wait(receiver).await;
            if !stopping {
                return outcome;
            }
            if !matches!(outcome, Ok(()) | Err(Error::Interrupted(_))) {
                return outcome;
            }
        }
    }

    pub fn request_interrupt(&self, id: &session::Id, reason: InterruptReason) -> Outcome {
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        stop(&mut state, id, reason);
        Ok(())
    }

    pub async fn interrupt(&self, id: &session::Id, reason: InterruptReason) -> Outcome {
        let receiver = {
            let mut state = self
                .0
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if stop(&mut state, id, reason) {
                state.entries.get(id).map(|entry| entry.done.subscribe())
            } else {
                None
            }
        };
        let Some(receiver) = receiver else {
            return Ok(());
        };
        match wait(receiver).await {
            Err(Error::Interrupted(_)) => Ok(()),
            outcome => outcome,
        }
    }

    pub async fn await_idle(&self, id: &session::Id) {
        loop {
            let receiver = self
                .0
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .entries
                .get(id)
                .map(|entry| entry.done.subscribe());
            let Some(receiver) = receiver else { return };
            let _outcome = wait(receiver).await;
        }
    }

    pub async fn shutdown(&self) -> Outcome {
        {
            let mut state = self
                .0
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            state.closed = true;
            for entry in state.entries.values_mut() {
                entry.stopping = true;
                entry.pending_wake = false;
                entry.cancel.send_replace(Some(InterruptReason::Shutdown));
            }
        }
        let mut tasks = std::mem::replace(
            &mut *self
                .0
                .tasks
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
            JoinSet::new(),
        );
        let mut outcome = if self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .panicked
        {
            Err(Error::Panicked)
        } else {
            Ok(())
        };
        while let Some(result) = tasks.join_next().await {
            if result.is_err() {
                outcome = Err(Error::Panicked);
            }
        }
        outcome
    }

    fn reap(&self) {
        let mut panicked = false;
        {
            let mut tasks = self
                .0
                .tasks
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            while let Some(result) = tasks.try_join_next() {
                panicked |= result.is_err();
            }
        }
        if panicked {
            self.0
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .panicked = true;
        }
    }

    pub async fn with_transition<T>(
        &self,
        id: &session::Id,
        effect: impl Future<Output = T>,
    ) -> Result<T, Error> {
        let lock = {
            let mut state = self
                .0
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if state.closed {
                return Err(Error::Closed);
            }
            let transition = state
                .transitions
                .entry(id.clone())
                .or_insert_with(|| Transition {
                    users: 0,
                    doorbell: false,
                    done: watch::channel(false).0,
                    lock: Arc::new(tokio::sync::Mutex::new(())),
                });
            transition.users += 1;
            transition.lock.clone()
        };
        let reservation = Reservation {
            inner: Arc::downgrade(&self.0),
            id: id.clone(),
        };
        let guard = lock.lock().await;
        let output = effect.await;
        drop(guard);
        drop(reservation);
        Ok(output)
    }
}

fn stop(state: &mut State, id: &session::Id, reason: InterruptReason) -> bool {
    if let Some(entry) = state.entries.get_mut(id) {
        if entry.stopping || entry.settling {
            return false;
        }
        entry.stopping = true;
        if entry.pending_wake
            && let Some(transition) = state.transitions.get_mut(id)
        {
            transition.doorbell = true;
        }
        entry.pending_wake = false;
        entry.cancel.send_replace(Some(reason));
        return true;
    }
    false
}

fn start(inner: &Arc<Inner>, state: &mut State, id: session::Id, force: bool) {
    state.generation += 1;
    let generation = state.generation;
    let (done, _) = watch::channel(None);
    let (cancel, cancellation) = watch::channel(None);
    state.entries.insert(
        id.clone(),
        Entry {
            generation,
            done: done.clone(),
            cancel,
            stopping: false,
            settling: false,
            pending_wake: false,
        },
    );
    let owner = Owner {
        inner: Arc::downgrade(inner),
        id: id.clone(),
        generation,
        done,
        finished: false,
    };
    let drain = inner.drain.clone();
    inner
        .tasks
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .spawn(async move {
            let mut owner = owner;
            let mut cancellation = Cancellation(cancellation);
            let started = protect(async { drain.started(id.clone()).await }).await;
            let outcome = match started {
                Err(error) => Err(error),
                Ok(()) => {
                    let mut force = force;
                    loop {
                        let request = DrainRequest {
                            session_id: id.clone(),
                            force,
                            cancellation: cancellation.clone(),
                        };
                        let outcome = tokio::select! {
                            biased;
                            reason = cancellation.cancelled() => Err(Error::Interrupted(reason)),
                            outcome = protect(async { drain.drain(request).await }) => outcome,
                        };
                        if outcome.is_err() {
                            break outcome;
                        }
                        let again = owner.inner.upgrade().is_some_and(|inner| {
                            let mut state = inner
                                .state
                                .lock()
                                .unwrap_or_else(|error| error.into_inner());
                            state.entries.get_mut(&id).is_some_and(|entry| {
                                if entry.stopping || !entry.pending_wake {
                                    return false;
                                }
                                entry.pending_wake = false;
                                true
                            })
                        });
                        if !again {
                            break Ok(());
                        }
                        force = false;
                        tokio::task::yield_now().await;
                    }
                }
            };
            if let Some(inner) = owner.inner.upgrade()
                && let Some(entry) = inner
                    .state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .entries
                    .get_mut(&id)
            {
                entry.settling = true;
            }
            let outcome = match protect(async { drain.settled(id, outcome.clone()).await }).await {
                Ok(()) => outcome,
                Err(error) => Err(error),
            };
            owner.finish(outcome);
        });
}

struct Owner {
    inner: Weak<Inner>,
    id: session::Id,
    generation: u64,
    done: watch::Sender<Option<Outcome>>,
    finished: bool,
}
impl Owner {
    fn finish(&mut self, outcome: Outcome) {
        if let Some(inner) = self.inner.upgrade() {
            let mut state = inner
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if state
                .entries
                .get(&self.id)
                .is_some_and(|entry| entry.generation == self.generation)
            {
                let entry = state
                    .entries
                    .remove(&self.id)
                    .expect("owned execution exists");
                if entry.pending_wake && !state.closed {
                    if let Some(transition) = state.transitions.get_mut(&self.id) {
                        transition.doorbell = true;
                    } else {
                        start(&inner, &mut state, self.id.clone(), false);
                    }
                }
            }
        }
        self.done.send_replace(Some(outcome));
        self.finished = true;
    }
}

struct Reservation {
    inner: Weak<Inner>,
    id: session::Id,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.upgrade() {
            let mut state = inner
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let Some(transition) = state.transitions.get_mut(&self.id) else {
                return;
            };
            transition.users -= 1;
            if transition.users > 0 {
                return;
            }
            let transition = state
                .transitions
                .remove(&self.id)
                .expect("last transition exists");
            transition.done.send_replace(true);
            if transition.doorbell && !state.closed {
                if let Some(entry) = state.entries.get_mut(&self.id) {
                    entry.pending_wake = true;
                } else {
                    start(&inner, &mut state, self.id.clone(), false);
                }
            }
        }
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        if !self.finished {
            self.finish(Err(Error::Panicked));
        }
    }
}

async fn wait(mut receiver: watch::Receiver<Option<Outcome>>) -> Outcome {
    loop {
        if let Some(outcome) = receiver.borrow_and_update().clone() {
            return outcome;
        }
        if receiver.changed().await.is_err() {
            return Err(Error::Closed);
        }
    }
}

async fn protect(future: impl Future<Output = Outcome>) -> Outcome {
    let mut future = std::pin::pin!(future);
    std::future::poll_fn(|context| {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            future.as_mut().poll(context)
        }))
        .unwrap_or(std::task::Poll::Ready(Err(Error::Panicked)))
    })
    .await
}
