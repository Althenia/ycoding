use crate::{Boxed, Core, Failure, Production};
use futures_util::{FutureExt, StreamExt, stream::FuturesUnordered};
use std::{
    collections::BTreeMap,
    future::Future,
    panic::{AssertUnwindSafe, catch_unwind},
    pin::Pin,
    sync::{
        Arc, Mutex, PoisonError, Weak,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    task::{Context as PollContext, Poll, Waker},
};
use tokio::{runtime::Runtime, sync::Notify, task::JoinHandle};
use ycoding_core::{cca::error::ExecutorError, ycoding_store::Client};

#[derive(Clone, Debug, PartialEq)]
pub enum OwnerFailure {
    Runtime(Failure),
    Library(ExecutorError),
    Join(String),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Report {
    pub failures: Vec<OwnerFailure>,
}

impl Report {
    pub fn runtime(result: Result<(), Failure>) -> Self {
        Self {
            failures: result
                .err()
                .map(OwnerFailure::Runtime)
                .into_iter()
                .collect(),
        }
    }

    pub fn library(result: Result<(), ExecutorError>) -> Self {
        Self {
            failures: result
                .err()
                .map(OwnerFailure::Library)
                .into_iter()
                .collect(),
        }
    }

    fn join(stage: &'static str) -> Self {
        Self {
            failures: vec![OwnerFailure::Join(stage.into())],
        }
    }

    pub fn result(&self) -> Result<(), Failure> {
        super::cleanup_results(self.failures.iter().map(|failure| {
            Err(match failure {
                OwnerFailure::Runtime(error) => error.clone(),
                OwnerFailure::Library(error) => {
                    Failure::Unavailable(format!("Native Library cleanup failed: {error}"))
                }
                OwnerFailure::Join(stage) => Failure::Unavailable(stage.clone()),
            })
        }))
    }
}

pub struct Joined<T> {
    pub body: std::thread::Result<T>,
    pub cleanup: Report,
}

pub struct ProductionOwner {
    shared: Arc<Shared>,
    driver: JoinHandle<()>,
}

impl ProductionOwner {
    pub fn scope<T>(runtime: &Runtime, body: impl FnOnce(Handle) -> T) -> Joined<T> {
        Self::scope_with_parent(runtime, None, body)
    }

    pub(crate) fn scope_with_parent<T>(
        runtime: &Runtime,
        parent: Option<Arc<ycoding_core::extension::ParentOwner>>,
        body: impl FnOnce(Handle) -> T,
    ) -> Joined<T> {
        let shared = Arc::new(Shared {
            parent,
            state: Mutex::new(State {
                admitting: true,
                next: 0,
                groups: Vec::new(),
                resources: BTreeMap::new(),
                queued: Vec::new(),
                failures: Vec::new(),
            }),
            wake: Notify::new(),
        });
        let driver = runtime.spawn(drive(shared.clone()));
        let owner = Self { shared, driver };
        let handle = Handle {
            shared: Arc::downgrade(&owner.shared),
            group: None,
        };
        let body = catch_unwind(AssertUnwindSafe(|| body(handle)));
        owner.shared.close();
        if runtime.block_on(owner.driver).is_err() {
            owner.shared.record(
                None,
                Class::Production,
                Report::join("production owner driver join failed"),
            );
        }
        let failures = owner
            .shared
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .failures
            .clone();
        Joined {
            body,
            cleanup: Report { failures },
        }
    }
}

#[derive(Clone)]
pub struct Handle {
    shared: Weak<Shared>,
    group: Option<Arc<Group>>,
}

#[derive(Clone, Copy, PartialEq)]
enum Class {
    Production,
    Library,
}

struct Shared {
    parent: Option<Arc<ycoding_core::extension::ParentOwner>>,
    state: Mutex<State>,
    wake: Notify,
}

struct State {
    admitting: bool,
    next: u64,
    groups: Vec<Arc<Group>>,
    resources: BTreeMap<u64, Arc<Record>>,
    queued: Vec<Boxed<()>>,
    failures: Vec<OwnerFailure>,
}

struct Group {
    shared: Weak<Shared>,
    admitting: AtomicBool,
    cancelled: AtomicBool,
    bootstrap_cancelled: AtomicBool,
    jobs: AtomicUsize,
    resources: AtomicUsize,
    records: Mutex<BTreeMap<u64, Weak<Record>>>,
    failures: Mutex<Vec<OwnerFailure>>,
    changed: Notify,
}

impl Group {
    fn close(&self) {
        self.stop(true);
    }

    fn stop(&self, cancel_results: bool) {
        let shared = self.shared.upgrade();
        if let Some(parent) = shared.as_ref().and_then(|shared| shared.parent.as_ref()) {
            parent.retire();
        }
        let admission = shared
            .as_ref()
            .map(|shared| shared.state.lock().unwrap_or_else(PoisonError::into_inner));
        self.admitting.store(false, Ordering::Release);
        self.cancelled.store(true, Ordering::Release);
        if cancel_results {
            self.bootstrap_cancelled.store(true, Ordering::Release);
        }
        drop(admission);
        let records = self
            .records
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .filter_map(Weak::upgrade)
            .collect::<Vec<_>>();
        for record in records {
            if record.class == Class::Library {
                record.signal();
            }
        }
        self.changed.notify_waiters();
        if let Some(shared) = shared {
            shared.wake.notify_one();
        }
    }

    async fn drain(&self) -> Report {
        self.stop(false);
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.jobs.load(Ordering::Acquire) == 0 && self.resources.load(Ordering::Acquire) == 0
            {
                return Report {
                    failures: self
                        .failures
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .clone(),
                };
            }
            changed.await;
        }
    }

    fn cancelled(&self, class: Class) -> bool {
        match class {
            Class::Library => self.cancelled.load(Ordering::Acquire),
            Class::Production => self.bootstrap_cancelled.load(Ordering::Acquire),
        }
    }
}

impl Shared {
    fn record(&self, group: Option<&Group>, class: Class, report: Report) {
        if class == Class::Library
            && let Some(group) = group
        {
            group
                .failures
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .extend(report.failures.clone());
        }
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .failures
            .extend(report.failures);
    }

    fn close(&self) {
        if let Some(parent) = &self.parent {
            parent.retire();
        }
        let (groups, records) = {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            state.admitting = false;
            (
                state.groups.clone(),
                state.resources.values().cloned().collect::<Vec<_>>(),
            )
        };
        for group in groups {
            group.close();
        }
        for record in records {
            record.signal();
        }
        self.wake.notify_one();
    }
}

impl Handle {
    fn new_group(&self) -> Result<Self, Failure> {
        if self.group.is_some() {
            return Err(closed());
        }
        let shared = self.shared.upgrade().ok_or_else(closed)?;
        let mut state = shared.state.lock().unwrap_or_else(PoisonError::into_inner);
        if !state.admitting {
            return Err(closed());
        }
        let group = Arc::new(Group {
            shared: self.shared.clone(),
            admitting: AtomicBool::new(true),
            cancelled: AtomicBool::new(false),
            bootstrap_cancelled: AtomicBool::new(false),
            jobs: AtomicUsize::new(0),
            resources: AtomicUsize::new(0),
            records: Mutex::new(BTreeMap::new()),
            failures: Mutex::new(Vec::new()),
            changed: Notify::new(),
        });
        state.groups.push(group.clone());
        Ok(Self {
            shared: self.shared.clone(),
            group: Some(group),
        })
    }

    #[cfg(test)]
    pub(crate) fn production_context(&self) -> Result<Request<Context>, Failure> {
        self.register_production(
            |context| Box::pin(async move { context }),
            |_| Box::pin(async { Report::default() }),
        )
    }

    pub(crate) fn admitting(&self) -> bool {
        let Some(shared) = self.shared.upgrade() else {
            return false;
        };
        shared
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .admitting
            && self
                .group
                .as_ref()
                .is_none_or(|group| group.admitting.load(Ordering::Acquire))
    }

    pub(crate) fn register_bootstrap(
        &self,
        client: Client,
        production: Production,
        recover: bool,
    ) -> Result<Request<Result<Core, Failure>>, Failure> {
        self.register_production(
            move |context| {
                Box::pin(Core::production_registered(
                    client, production, recover, context,
                ))
            },
            |result| {
                Box::pin(async move {
                    match result {
                        Ok(core) => {
                            let _recorded_shutdown = core.shutdown().await;
                            Report::default()
                        }
                        Err(error) => Report::runtime(Err(error)),
                    }
                })
            },
        )
    }

    fn register_production<T: Send + 'static>(
        &self,
        start: impl FnOnce(Context) -> Boxed<T> + Send + 'static,
        abandoned: impl FnOnce(T) -> Boxed<Report> + Send + 'static,
    ) -> Result<Request<T>, Failure> {
        self.new_group()?
            .submit(Class::Production, start, abandoned)
    }

    pub(crate) fn register<T: Send + 'static>(
        &self,
        start: impl FnOnce(Context) -> Boxed<T> + Send + 'static,
        abandoned: impl FnOnce(T) -> Boxed<Report> + Send + 'static,
    ) -> Result<Request<T>, Failure> {
        self.submit(Class::Library, start, abandoned)
    }

    fn submit<T: Send + 'static>(
        &self,
        class: Class,
        start: impl FnOnce(Context) -> Boxed<T> + Send + 'static,
        abandoned: impl FnOnce(T) -> Boxed<Report> + Send + 'static,
    ) -> Result<Request<T>, Failure> {
        let shared = self.shared.upgrade().ok_or_else(closed)?;
        let group = self.group.clone().ok_or_else(closed)?;
        let reply = Arc::new(Reply {
            state: Mutex::new(Response {
                value: None,
                failure: None,
                abandoned: false,
                observed: false,
                waker: None,
            }),
            changed: Notify::new(),
        });
        let mut state = shared.state.lock().unwrap_or_else(PoisonError::into_inner);
        if !state.admitting || !group.admitting.load(Ordering::Acquire) {
            return Err(closed());
        }
        if class == Class::Library {
            group.jobs.fetch_add(1, Ordering::AcqRel);
        }
        let request = Request {
            reply: reply.clone(),
            group: group.clone(),
            class,
            done: false,
        };
        let context = Context {
            shared: self.shared.clone(),
            group: group.clone(),
            class,
        };
        let retained = shared.clone();
        state.queued.push(Box::pin(async move {
            run_job(retained, group, class, reply, context, start, abandoned).await;
        }));
        drop(state);
        shared.wake.notify_one();
        Ok(request)
    }
}

#[derive(Clone)]
pub(crate) struct Context {
    shared: Weak<Shared>,
    group: Arc<Group>,
    class: Class,
}

impl Context {
    pub(crate) fn parent_owner(&self) -> Option<Arc<ycoding_core::extension::ParentOwner>> {
        self.shared.upgrade()?.parent.clone()
    }

    pub(crate) fn parent_plugins(&self) -> Option<ycoding_core::extension::ParentHandle> {
        self.parent_owner().map(|parent| parent.handle())
    }

    pub(crate) fn production_retirement(&self) -> Box<dyn FnOnce() + Send> {
        let group = Arc::downgrade(&self.group);
        Box::new(move || {
            if let Some(group) = group.upgrade() {
                group.close();
            }
        })
    }

    pub(crate) fn handle(&self) -> Handle {
        Handle {
            shared: self.shared.clone(),
            group: Some(self.group.clone()),
        }
    }

    pub(crate) fn drain_library(&self) -> Boxed<Report> {
        let group = self.group.clone();
        Box::pin(async move { group.drain().await })
    }

    pub(crate) fn retain(
        &self,
        retire: Box<dyn FnOnce() + Send>,
        cleanup: Boxed<Report>,
    ) -> Resource {
        let shared = self.shared.upgrade().expect("registered owner is retained");
        let mut state = shared.state.lock().unwrap_or_else(PoisonError::into_inner);
        let id = state.next;
        state.next += 1;
        let record = Arc::new(Record {
            id,
            shared: self.shared.clone(),
            group: self.group.clone(),
            class: self.class,
            closing: AtomicBool::new(false),
            retired: AtomicBool::new(false),
            retire: Mutex::new(Some(retire)),
            failures: Mutex::new(Report::default()),
            completion: Mutex::new(None),
            changed: Notify::new(),
        });
        if self.class == Class::Library {
            self.group.resources.fetch_add(1, Ordering::AcqRel);
        }
        self.group
            .records
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, Arc::downgrade(&record));
        state.resources.insert(id, record.clone());
        let work = record.clone();
        state
            .queued
            .push(Box::pin(async move { work.run(cleanup).await }));
        let closing = !state.admitting || !self.group.admitting.load(Ordering::Acquire);
        drop(state);
        if closing {
            record.signal();
        }
        shared.wake.notify_one();
        Resource(Arc::new(Token(record)))
    }
}

struct Reply<T> {
    state: Mutex<Response<T>>,
    changed: Notify,
}

struct Response<T> {
    value: Option<T>,
    failure: Option<Failure>,
    abandoned: bool,
    observed: bool,
    waker: Option<Waker>,
}

impl<T> Reply<T> {
    fn wake(&self) {
        let waker = self
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .waker
            .take();
        if let Some(waker) = waker {
            waker.wake();
        }
        self.changed.notify_waiters();
    }

    fn fail(&self) {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .failure = Some(closed());
        self.wake();
    }
}

pub(crate) struct Request<T> {
    reply: Arc<Reply<T>>,
    group: Arc<Group>,
    class: Class,
    done: bool,
}

impl<T> Future for Request<T> {
    type Output = Result<T, Failure>;

    fn poll(self: Pin<&mut Self>, context: &mut PollContext<'_>) -> Poll<Self::Output> {
        let request = self.get_mut();
        let output = {
            let mut state = request
                .reply
                .state
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if let Some(value) = state.value.take() {
                state.observed = true;
                Some(Ok(value))
            } else if let Some(error) = state.failure.take() {
                Some(Err(error))
            } else {
                state.waker = Some(context.waker().clone());
                None
            }
        };
        match output {
            Some(output) => {
                request.done = true;
                request.reply.changed.notify_waiters();
                Poll::Ready(output)
            }
            None => Poll::Pending,
        }
    }
}

impl<T> Drop for Request<T> {
    fn drop(&mut self) {
        if self.done {
            return;
        }
        self.reply
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .abandoned = true;
        if self.class == Class::Production {
            self.group.close();
        }
        self.reply.changed.notify_waiters();
    }
}

async fn run_job<T: Send + 'static>(
    shared: Arc<Shared>,
    group: Arc<Group>,
    class: Class,
    reply: Arc<Reply<T>>,
    context: Context,
    start: impl FnOnce(Context) -> Boxed<T> + Send + 'static,
    abandoned: impl FnOnce(T) -> Boxed<Report> + Send + 'static,
) {
    let skip = reply
        .state
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .abandoned
        || group.cancelled(class);
    if skip {
        reply.fail();
    } else {
        let result = AssertUnwindSafe(async move { start(context).await })
            .catch_unwind()
            .await;
        match result {
            Ok(value) => {
                reply
                    .state
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .value = Some(value);
                reply.wake();
                let orphan = loop {
                    let changed = reply.changed.notified();
                    let stopped = group.changed.notified();
                    tokio::pin!(changed, stopped);
                    changed.as_mut().enable();
                    stopped.as_mut().enable();
                    {
                        let mut state = reply.state.lock().unwrap_or_else(PoisonError::into_inner);
                        if state.observed {
                            break None;
                        }
                        if state.abandoned || group.cancelled(class) {
                            break state.value.take();
                        }
                    }
                    tokio::select! { _ = changed => {}, _ = stopped => {} }
                };
                if let Some(value) = orphan {
                    let result = AssertUnwindSafe(async move { abandoned(value).await })
                        .catch_unwind()
                        .await;
                    let report = result.unwrap_or_else(|_| {
                        Report::join("abandoned production operation cleanup panicked")
                    });
                    shared.record(Some(&group), class, report);
                    reply.fail();
                }
            }
            Err(_) => {
                shared.record(
                    Some(&group),
                    class,
                    Report::join("registered production operation panicked"),
                );
                if class == Class::Production {
                    group.close();
                }
                reply.fail();
            }
        }
    }
    if class == Class::Library {
        group.jobs.fetch_sub(1, Ordering::AcqRel);
    }
    group.changed.notify_waiters();
}

#[derive(Clone)]
pub(crate) struct Resource(Arc<Token>);

struct Token(Arc<Record>);

impl Drop for Token {
    fn drop(&mut self) {
        self.0.signal();
    }
}

impl Resource {
    pub(crate) fn retire(&self) {
        self.0.0.signal();
    }

    pub(crate) fn is_retired(&self) -> bool {
        self.0.0.closing.load(Ordering::Acquire)
    }

    pub(crate) fn close(&self) -> Boxed<Report> {
        self.retire();
        let record = self.0.0.clone();
        Box::pin(async move {
            loop {
                let changed = record.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if let Some(report) = record
                    .completion
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .clone()
                {
                    return report;
                }
                changed.await;
            }
        })
    }
}

struct Record {
    id: u64,
    shared: Weak<Shared>,
    group: Arc<Group>,
    class: Class,
    closing: AtomicBool,
    retired: AtomicBool,
    retire: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    failures: Mutex<Report>,
    completion: Mutex<Option<Report>>,
    changed: Notify,
}

impl Record {
    fn signal(&self) {
        if self.closing.swap(true, Ordering::AcqRel) {
            return;
        }
        let retire = self
            .retire
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(retire) = retire
            && catch_unwind(AssertUnwindSafe(retire)).is_err()
        {
            let report = Report::join("production resource retirement panicked");
            self.failures
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .failures
                .extend(report.failures.clone());
            if let Some(shared) = self.shared.upgrade() {
                shared.record(Some(&self.group), self.class, report);
            }
        }
        self.retired.store(true, Ordering::Release);
        self.changed.notify_waiters();
    }

    async fn run(self: Arc<Self>, cleanup: Boxed<Report>) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.retired.load(Ordering::Acquire) {
                break;
            }
            changed.await;
        }
        let mut report = if self.class == Class::Production {
            self.group.drain().await
        } else {
            Report::default()
        };
        report.failures.extend(
            self.failures
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .failures
                .clone(),
        );
        let own = AssertUnwindSafe(cleanup)
            .catch_unwind()
            .await
            .unwrap_or_else(|_| Report::join("production resource cleanup panicked"));
        if let Some(shared) = self.shared.upgrade() {
            shared.record(Some(&self.group), self.class, own.clone());
            shared
                .state
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .resources
                .remove(&self.id);
        }
        report.failures.extend(own.failures);
        *self
            .completion
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(report);
        self.group
            .records
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.id);
        if self.class == Class::Library {
            self.group.resources.fetch_sub(1, Ordering::AcqRel);
        }
        self.changed.notify_waiters();
        self.group.changed.notify_waiters();
    }
}

async fn drive(shared: Arc<Shared>) {
    let mut tasks = FuturesUnordered::new();
    loop {
        let (queued, admitting) = {
            let mut state = shared.state.lock().unwrap_or_else(PoisonError::into_inner);
            (std::mem::take(&mut state.queued), state.admitting)
        };
        for future in queued {
            tasks.push(future);
        }
        if tasks.is_empty() {
            if !admitting {
                return;
            }
            shared.wake.notified().await;
        } else {
            tokio::select! {
                _ = shared.wake.notified() => {},
                _ = tasks.next() => {},
            }
        }
    }
}

fn closed() -> Failure {
    Failure::Unavailable("production owner admission is closed".into())
}

#[cfg(test)]
mod tests {
    include!("owner_tests.rs");
}
