use crate::Snapshot;
pub use duckdb::types::Value;
use std::marker::PhantomData;
use std::ops::Deref;
use std::path::Path;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

mod numeric;
pub mod reports;
mod state;
mod usage;
mod worker;
pub use state::{Change, Delivery, DeliveryTable, Intent, IntentTable, privacy_changed, record};
pub use usage::{
    UsageBuild, UsageCorrection, UsageCosts, UsageData, UsageFamily, UsageHint, UsagePresentation,
    UsagePrice, UsagePriceKey, UsageRepresentative, UsageSession, UsageStageFence, UsageStagePage,
    UsageTask,
};

pub const INTENT_LIMIT: usize = 4096;
pub const INTENT_BYTES: usize = 8 * 1024 * 1024;
pub const BATCH_SIZE: usize = 128;
pub const REBUILD_SLICE_PAGES: usize = 64;
pub const REPORT_DEADLINE: Duration = Duration::from_secs(5);
pub const REPORT_STACK_BYTES: usize = 8 * 1024 * 1024;
pub const ROW_BYTES: usize = 64 * 1024;
pub const REPORT_ROWS: usize = 4096;
pub const REPORT_BYTES: usize = 8 * 1024 * 1024;
const PRESENTATION_LIMIT: usize = 32;
const PRESENTATION_CONCURRENCY: usize = 4;
static INSTANCE: AtomicBool = AtomicBool::new(false);
pub type ReportRows = Vec<Vec<Vec<Value>>>;

pub fn session_cell_prefix(
    bucket_prefix: &[u8],
    session: &ycoding_schema::LosslessString,
) -> Result<Vec<u8>, crate::Error> {
    let mut dimensions = Vec::new();
    crate::session::codec::Field::encode(session, &mut dimensions)?;
    let suffix = crate::tuple_key(&[crate::KeyPart::Bytes(&dimensions)]);
    let mut prefix = bucket_prefix.to_vec();
    prefix.extend_from_slice(&suffix[..suffix.len() - 2]);
    Ok(prefix)
}

type PresentationProducer = Box<dyn FnOnce() -> Result<UsagePresentation, crate::Error> + Send>;
type PresentationObserver = Arc<dyn Fn(PresentationChange) + Send + Sync>;

pub enum PresentationChange {
    Queued,
    SummaryReady,
}

struct PresentationJob {
    key: String,
    queued: u64,
    publication: usage::Publication,
    producer: PresentationProducer,
}

struct PresentationEntry {
    value: Option<Arc<UsagePresentation>>,
    touched: u64,
    bytes: usize,
    retry_at: Option<Instant>,
}

#[derive(Default)]
struct Presentations {
    publication: Option<usage::Publication>,
    ready: std::collections::BTreeMap<String, PresentationEntry>,
    pending: std::collections::BTreeMap<String, Option<PresentationJob>>,
    observers: Vec<PresentationObserver>,
    sequence: u64,
    revision: u64,
    closed: bool,
    failed: bool,
}

impl Presentations {
    fn replace(&mut self, publication: Option<usage::Publication>) {
        if self.closed {
            return;
        }
        if self.publication.as_ref().map(|value| &value.revision)
            != publication.as_ref().map(|value| &value.revision)
        {
            let previous = self.publication.as_ref();
            self.ready.retain(|_, entry| {
                let (Some(previous), Some(current), Some(value)) =
                    (previous, publication.as_ref(), entry.value.as_mut())
                else {
                    return false;
                };
                if previous.data.source_revision != current.data.source_revision
                    || value.price_refs.iter().any(|key| {
                        usage::prices(&previous.data, key) != usage::prices(&current.data, key)
                    })
                {
                    return false;
                }
                let mut next = (**value).clone();
                next.revision = current.revision.clone();
                *value = Arc::new(next);
                true
            });
            self.pending.clear();
        }
        self.publication = publication;
    }

    fn close(&mut self) {
        self.closed = true;
        self.publication = None;
        self.ready.clear();
        self.pending.clear();
        self.observers.clear();
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Maintenance {
    Complete,
    Pending,
}

#[derive(Debug)]
pub enum Error {
    Store(crate::Error),
    Duck(duckdb::Error),
    Io(std::io::Error),
    Unavailable,
    Invalid,
    Privacy,
    Cancelled,
    Deadline,
    Busy,
    Closed,
    Configuration,
    Limit,
    Preparation,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "analytics: {self:?}")
    }
}
impl std::error::Error for Error {}
impl From<crate::Error> for Error {
    fn from(value: crate::Error) -> Self {
        Self::Store(value)
    }
}
impl From<duckdb::Error> for Error {
    fn from(value: duckdb::Error) -> Self {
        Self::Duck(value)
    }
}
impl From<std::io::Error> for Error {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

#[derive(Clone, Copy)]
pub enum ColumnType {
    Boolean,
    Integer,
    Unsigned,
    Double,
    Text,
    Decimal,
}
pub struct Column {
    pub name: &'static str,
    pub kind: ColumnType,
}
pub struct SourceRow {
    pub identity: Vec<u8>,
    pub scope: Vec<u8>,
    pub values: Vec<Value>,
}
pub type SourcePage = fn(&Snapshot, Option<&[u8]>, usize) -> Result<Vec<SourceRow>, crate::Error>;
pub struct Source {
    pub name: &'static str,
    pub version: u64,
    pub columns: &'static [Column],
    pub allowed: fn(&Snapshot, &[u8]) -> Result<bool, crate::Error>,
    pub load: fn(&Snapshot, &[u8]) -> Result<Option<SourceRow>, crate::Error>,
    pub page: SourcePage,
}
pub struct Query {
    pub sql: &'static str,
    pub parameters: Vec<Value>,
    pub max_rows: usize,
}
#[derive(Clone, Default)]
pub struct Cancellation(Arc<CancelState>);
#[derive(Default)]
struct CancelState {
    state: Mutex<CancelStatus>,
    changed: Condvar,
    claimed: AtomicBool,
}
#[derive(Default)]
struct CancelStatus {
    cancelled: bool,
    expired: bool,
    querying: bool,
    finished: bool,
    interrupt: Option<Arc<duckdb::InterruptHandle>>,
    phase: Phase,
    source: Option<&'static str>,
    reported: bool,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Phase {
    #[default]
    Admission,
    Queue,
    Worker,
    UsageBackfill,
    DeliveryRead,
    RebuildInvalidate,
    IntentPrune,
    RebuildCleanup,
    GenerationCapture,
    ConnectionOpen,
    SchemaCreate,
    SourceRead,
    SourceNormalize,
    SourceInsert,
    RebuildBegin,
    RebuildCommit,
    ActivationRead,
    ActivationApply,
    ActivationAcknowledge,
    PurgeCleanup,
    PurgeAcknowledge,
    SynchronizeRead,
    SynchronizeOpen,
    SynchronizeApply,
    SynchronizeAcknowledge,
}
impl Cancellation {
    pub fn cancel(&self) {
        let interrupt = {
            let mut state = self
                .0
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            state.cancelled = true;
            state.interrupt.clone()
        };
        self.0.changed.notify_all();
        if let Some(interrupt) = interrupt {
            interrupt.interrupt();
        }
    }
    pub fn wait_querying(&self) -> Result<(), Error> {
        let state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let (state, timeout) = self
            .0
            .changed
            .wait_timeout_while(state, REPORT_DEADLINE, |state| {
                !state.querying && !state.finished
            })
            .unwrap_or_else(|error| error.into_inner());
        if state.querying {
            return Ok(());
        }
        if timeout.timed_out() {
            drop(state);
            return Err(self.deadline());
        }
        Err(Error::Cancelled)
    }
    fn check(&self, deadline: Instant) -> Result<(), Error> {
        let state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if state.cancelled {
            return Err(Error::Cancelled);
        }
        if state.expired || Instant::now() >= deadline {
            drop(state);
            return Err(self.deadline());
        }
        Ok(())
    }
    fn enter(
        &self,
        phase: Phase,
        source: Option<&'static str>,
        deadline: Instant,
    ) -> Result<(), Error> {
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if state.cancelled {
            return Err(Error::Cancelled);
        }
        if state.expired || Instant::now() >= deadline {
            drop(state);
            return Err(self.deadline());
        }
        state.phase = phase;
        state.source = source;
        Ok(())
    }
    fn deadline(&self) -> Error {
        let diagnostic = {
            let mut state = self
                .0
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            state.expired = true;
            if state.reported {
                None
            } else {
                state.reported = true;
                Some((state.phase, state.source))
            }
        };
        if let Some((phase, source)) = diagnostic {
            eprintln!(
                "analytics deadline phase={:?} source={}",
                phase,
                source.unwrap_or("none")
            );
        }
        Error::Deadline
    }
    fn attach(&self, connection: &duckdb::Connection) {
        self.0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .interrupt = Some(connection.interrupt_handle());
    }
    fn querying(&self) {
        self.0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .querying = true;
        self.0.changed.notify_all();
    }
    fn finish(&self) {
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.interrupt = None;
        state.finished = true;
        self.0.changed.notify_all();
    }
}
pub struct Engine {
    handle: Handle,
    writer: Option<JoinHandle<()>>,
    _owner: PhantomData<Rc<()>>,
}
impl Engine {
    pub fn handle(&self) -> Handle {
        self.handle.clone()
    }
    pub fn start(
        store: crate::Client,
        root: impl AsRef<Path>,
        sources: &'static [Source],
    ) -> Result<Self, Error> {
        worker::validate_sources(sources)?;
        if !store
            .catalog()
            .tables()
            .contains(&crate::TableDeclaration::of::<DeliveryTable>())
            || !store
                .catalog()
                .tables()
                .contains(&crate::TableDeclaration::of::<IntentTable>())
        {
            return Err(Error::Configuration);
        }
        INSTANCE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| Error::Busy)?;
        let (sender, receiver) = mpsc::sync_channel(256);
        let owned_store = store.clone();
        let wake_pending = Arc::new(AtomicBool::new(false));
        let worker_wake_pending = wake_pending.clone();
        let root = root.as_ref().to_path_buf();
        let publication_root = root.clone();
        let writer = match thread::Builder::new()
            .name("ycoding-analytics-writer".to_owned())
            .stack_size(REPORT_STACK_BYTES)
            .spawn(move || worker::run(owned_store, root, sources, receiver, worker_wake_pending))
        {
            Ok(writer) => writer,
            Err(error) => {
                INSTANCE.store(false, Ordering::Release);
                return Err(error.into());
            }
        };
        let handle = Handle(Arc::new(Shared {
            store,
            writer: writer.thread().id(),
            sender: Mutex::new(Some(sender)),
            presentations: Mutex::default(),
            presentation_changed: Condvar::new(),
            usage: Mutex::default(),
            root: publication_root,
            wake_pending,
        }));
        handle
            .0
            .store
            .attach_analytics(Link(Arc::downgrade(&handle.0)));
        Ok(Self {
            handle,
            writer: Some(writer),
            _owner: PhantomData,
        })
    }
    pub fn shutdown(mut self) -> Result<(), Error> {
        self.join()
    }
    fn join(&mut self) -> Result<(), Error> {
        if self.writer.is_none() {
            return Ok(());
        }
        self.handle
            .0
            .presentations
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .close();
        self.handle.0.presentation_changed.notify_all();
        *self
            .handle
            .0
            .usage
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = usage::Stage::default();
        self.handle
            .0
            .sender
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        let result = self.writer.take().map_or(Ok(()), |writer| {
            writer.join().map_err(|_| Error::Unavailable)
        });
        INSTANCE.store(false, Ordering::Release);
        result
    }
}
impl Deref for Engine {
    type Target = Handle;
    fn deref(&self) -> &Handle {
        &self.handle
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.join();
    }
}
#[derive(Clone)]
pub struct Handle(Arc<Shared>);
#[derive(Clone, Default)]
pub(crate) struct Link(std::sync::Weak<Shared>);
impl Link {
    pub(crate) fn handle(&self) -> Result<Handle, Error> {
        self.0.upgrade().map(Handle).ok_or(Error::Unavailable)
    }
}
struct Shared {
    store: crate::Client,
    writer: std::thread::ThreadId,
    sender: Mutex<Option<mpsc::SyncSender<Command>>>,
    presentations: Mutex<Presentations>,
    presentation_changed: Condvar,
    usage: Mutex<usage::Stage>,
    root: std::path::PathBuf,
    wake_pending: Arc<AtomicBool>,
}
enum Operation {
    Wake,
    Rebuild,
    Purge,
    Report(Delivery, Vec<Query>),
    SnapshotReport(Delivery, Box<Snapshot>, &'static [&'static str], Vec<Query>),
    Fence(Delivery),
}
enum Request {
    Operation(
        Operation,
        Option<mpsc::SyncSender<Result<ReportRows, Error>>>,
    ),
    Maintain(mpsc::SyncSender<Result<Maintenance, Error>>),
}
struct Command {
    request: Request,
    cancellation: Cancellation,
    deadline: Instant,
}
impl Handle {
    pub fn usage_data(&self) -> Result<Option<Arc<UsageData>>, Error> {
        worker::private_root(&self.0.root)?;
        let state = self
            .0
            .presentations
            .lock()
            .map_err(|_| Error::Unavailable)?;
        if state.closed {
            return Err(Error::Closed);
        }
        if state.failed {
            return Err(Error::Preparation);
        }
        Ok(state
            .publication
            .as_ref()
            .filter(|value| value.current(&self.0.store))
            .map(|value| value.data.clone()))
    }
    pub fn observe_presentations(
        &self,
        observer: impl Fn(PresentationChange) + Send + Sync + 'static,
    ) {
        self.0
            .presentations
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .observers
            .push(Arc::new(observer));
    }

    pub fn prepared_revision(&self) -> Result<Option<ycoding_schema::LosslessString>, Error> {
        worker::private_root(&self.0.root)?;
        let state = self
            .0
            .presentations
            .lock()
            .map_err(|_| Error::Unavailable)?;
        if state.closed {
            return Err(Error::Closed);
        }
        if state.failed {
            return Err(Error::Preparation);
        }
        Ok(state
            .publication
            .as_ref()
            .filter(|value| value.source_current(&self.0.store))
            .map(|value| value.revision.clone()))
    }

    pub fn presentation(
        &self,
        key: String,
        refresh: bool,
        producer: impl FnOnce() -> Result<UsagePresentation, crate::Error> + Send + 'static,
    ) -> Result<Option<Arc<UsagePresentation>>, Error> {
        worker::private_root(&self.0.root)?;
        let mut state = self
            .0
            .presentations
            .lock()
            .map_err(|_| Error::Unavailable)?;
        if state.closed {
            return Err(Error::Closed);
        }
        if state.failed {
            return Err(Error::Preparation);
        }
        if key.len() > ROW_BYTES {
            return Err(Error::Limit);
        }
        let Some(publication) = state
            .publication
            .as_ref()
            .filter(|value| value.source_current(&self.0.store))
            .cloned()
        else {
            return Ok(None);
        };
        state.sequence = state.sequence.wrapping_add(1);
        let sequence = state.sequence;
        if (refresh
            && state
                .ready
                .get(&key)
                .is_some_and(|entry| entry.value.is_none()))
            || state
                .ready
                .get(&key)
                .and_then(|entry| entry.retry_at)
                .is_some_and(|retry| Instant::now() >= retry)
        {
            state.ready.remove(&key);
        }
        if let Some(entry) = state.ready.get_mut(&key) {
            entry.touched = sequence;
            if entry
                .value
                .as_ref()
                .is_some_and(|value| !publication.verified(value))
                || (entry.value.is_none() && !publication.current(&self.0.store))
            {
                return Ok(None);
            }
            return entry.value.clone().map(Some).ok_or(Error::Preparation);
        }
        if !publication.current(&self.0.store) {
            return Ok(None);
        }
        if state.pending.contains_key(&key) || state.pending.len() >= PRESENTATION_LIMIT {
            return Ok(None);
        }
        state.pending.insert(
            key.clone(),
            Some(PresentationJob {
                key,
                queued: sequence,
                publication,
                producer: Box::new(producer),
            }),
        );
        let observers = state.observers.clone();
        drop(state);
        for observer in observers {
            observer(PresentationChange::Queued);
        }
        Ok(None)
    }

    pub fn prepare_presentations(&self) -> Result<(), Error> {
        let pending = {
            let state = self
                .0
                .presentations
                .lock()
                .map_err(|_| Error::Unavailable)?;
            state.pending.values().flatten().count()
        };
        let work = AtomicUsize::new(0);
        let drain = || self.drain_presentations(&work);
        thread::scope(|scope| {
            let mut workers = Vec::new();
            let mut result = Ok(());
            for _ in 1..pending.min(PRESENTATION_CONCURRENCY) {
                match thread::Builder::new()
                    .name("ycoding-usage-presentation".into())
                    .spawn_scoped(scope, drain)
                {
                    Ok(worker) => workers.push(worker),
                    Err(_) => {
                        result = Err(Error::Unavailable);
                        break;
                    }
                }
            }
            result = result.and(drain());
            for worker in workers {
                result = result.and(worker.join().unwrap_or(Err(Error::Unavailable)));
            }
            result
        })
    }

    pub fn await_presentation<T>(
        &self,
        deadline: Instant,
        mut read: impl FnMut() -> Result<Option<T>, crate::Error>,
    ) -> Result<Option<T>, crate::Error> {
        let presentations = &self.0.presentations;
        let unavailable = || crate::Error::Record(Box::new(Error::Unavailable));
        loop {
            let revision = presentations.lock().map_err(|_| unavailable())?.revision;
            if let Some(value) = read()? {
                return Ok(Some(value));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(None);
            }
            let state = presentations.lock().map_err(|_| unavailable())?;
            if !state.closed && state.observers.is_empty() {
                return Ok(None);
            }
            let (state, elapsed) = self
                .0
                .presentation_changed
                .wait_timeout_while(state, remaining, |state| {
                    !state.closed && state.revision == revision
                })
                .map_err(|_| unavailable())?;
            let done = state.closed || elapsed.timed_out();
            drop(state);
            if done {
                return read();
            }
        }
    }

    fn presentation_changed(&self, state: &mut Presentations) {
        state.revision = state.revision.wrapping_add(1);
        self.0.presentation_changed.notify_all();
    }

    fn drain_presentations(&self, work: &AtomicUsize) -> Result<(), Error> {
        let mut failure = None;
        while work.fetch_add(1, Ordering::Relaxed) < PRESENTATION_LIMIT {
            let job = {
                let mut state = self
                    .0
                    .presentations
                    .lock()
                    .map_err(|_| Error::Unavailable)?;
                if state.closed {
                    return Err(Error::Closed);
                }
                state
                    .pending
                    .values_mut()
                    .filter_map(|entry| {
                        let queued = entry.as_ref()?.queued;
                        Some((queued, entry))
                    })
                    .min_by_key(|(queued, _)| *queued)
                    .and_then(|(_, entry)| entry.take())
            };
            let Some(job) = job else {
                break;
            };
            let result = if job.publication.current(&self.0.store) {
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(job.producer)) {
                    Ok(Ok(value)) => {
                        Some(value).filter(|value| value.revision == job.publication.revision)
                    }
                    Ok(Err(error)) => {
                        failure.get_or_insert(Error::Store(error));
                        None
                    }
                    Err(_) => {
                        failure.get_or_insert(Error::Unavailable);
                        None
                    }
                }
            } else {
                None
            };
            let bytes = result.as_ref().map_or(0, |value| {
                usage::payload(&job.publication.data, value).len() + job.key.len()
            });
            let mut state = self
                .0
                .presentations
                .lock()
                .map_err(|_| Error::Unavailable)?;
            if state.closed {
                return Err(Error::Closed);
            }
            if state
                .publication
                .as_ref()
                .is_none_or(|value| value.revision != job.publication.revision)
            {
                continue;
            }
            state.pending.remove(&job.key);
            if !job.publication.current(&self.0.store) {
                continue;
            }
            let result = result.filter(|_| bytes <= REPORT_BYTES);
            if bytes > REPORT_BYTES {
                failure.get_or_insert(Error::Limit);
            }
            let bytes = if result.is_some() { bytes } else { 0 };
            while state.ready.len() >= PRESENTATION_LIMIT
                || state
                    .ready
                    .values()
                    .map(|entry| entry.bytes)
                    .sum::<usize>()
                    .saturating_add(bytes)
                    > REPORT_BYTES
            {
                let Some(key) = state
                    .ready
                    .iter()
                    .min_by_key(|(_, entry)| entry.touched)
                    .map(|(key, _)| key.clone())
                else {
                    break;
                };
                state.ready.remove(&key);
            }
            state.sequence = state.sequence.wrapping_add(1);
            let touched = state.sequence;
            let retry_at = result
                .is_none()
                .then(|| Instant::now() + Duration::from_secs(30));
            let summary_ready = result.as_ref().is_some_and(|value| value.summary.is_some());
            state.ready.insert(
                job.key,
                PresentationEntry {
                    value: result.map(Arc::new),
                    touched,
                    bytes,
                    retry_at,
                },
            );
            self.presentation_changed(&mut state);
            if summary_ready {
                let observers = state.observers.clone();
                drop(state);
                for observer in observers {
                    observer(PresentationChange::SummaryReady);
                }
            }
        }
        failure.map_or(Ok(()), Err)
    }

    pub fn fail_usage(&self) -> Result<(), Error> {
        let mut usage = self.usage_stage()?;
        usage.failed();
        self.update_usage(&usage)
    }

    pub fn begin_usage(&self, fence: UsageStageFence) -> Result<UsageBuild, Error> {
        worker::private_root(&self.0.root)?;
        let mut usage = self.usage_stage()?;
        if !fence.current(&self.0.store) {
            return Err(Error::Unavailable);
        }
        usage.begin(fence)
    }

    pub fn append_usage(&self, build: &UsageBuild, page: UsageStagePage) -> Result<(), Error> {
        let mut usage = self.usage_stage()?;
        if !usage.candidate(*build)?.current(&self.0.store) {
            return Err(Error::Unavailable);
        }
        usage.append(*build, page)
    }

    pub fn publish_usage(&self, build: UsageBuild, versions: crate::Versions) -> Result<(), Error> {
        let mut usage = self.usage_stage()?;
        usage.publish(&self.0.store, build, versions)?;
        self.update_usage(&usage)
    }

    pub fn abort_usage(&self, build: UsageBuild, failed: bool) -> Result<(), Error> {
        let mut usage = self.usage_stage()?;
        usage.abort(build, failed)?;
        self.update_usage(&usage)
    }

    fn usage_stage(&self) -> Result<std::sync::MutexGuard<'_, usage::Stage>, Error> {
        let usage = self.0.usage.lock().map_err(|_| Error::Unavailable)?;
        if self
            .0
            .presentations
            .lock()
            .map_err(|_| Error::Unavailable)?
            .closed
        {
            return Err(Error::Closed);
        }
        Ok(usage)
    }

    fn update_usage(&self, stage: &usage::Stage) -> Result<(), Error> {
        let publication = stage.published();
        let mut state = self
            .0
            .presentations
            .lock()
            .map_err(|_| Error::Unavailable)?;
        if state.closed {
            return Err(Error::Closed);
        }
        state.failed = matches!(&publication, Err(Error::Preparation));
        state.replace(publication.ok().cloned());
        self.presentation_changed(&mut state);
        Ok(())
    }

    pub fn report_snapshot(
        &self,
        snapshot: Snapshot,
        sources: &'static [&'static str],
        queries: Vec<Query>,
    ) -> Result<ReportRows, Error> {
        let state = self.captured(&snapshot)?;
        if sources.is_empty()
            || sources.len() > 64
            || sources.iter().any(|source| !identifier(source))
        {
            return Err(Error::Configuration);
        }
        validate_queries(&queries)?;
        self.call(
            |reply| {
                Request::Operation(
                    Operation::SnapshotReport(state, Box::new(snapshot), sources, queries),
                    Some(reply),
                )
            },
            Cancellation::default(),
        )
    }

    pub fn fence(&self, snapshot: &Snapshot) -> Result<(), Error> {
        let state = self.captured(snapshot)?;
        self.call(
            |reply| Request::Operation(Operation::Fence(state), Some(reply)),
            Cancellation::default(),
        )
        .map(|_| ())
    }

    fn captured(&self, snapshot: &Snapshot) -> Result<Delivery, Error> {
        let state = snapshot
            .get::<DeliveryTable>(&[])?
            .unwrap_or_else(|| Delivery::initial(self.0.store.metadata()));
        if !state.matches(self.0.store.metadata()) {
            return Err(Error::Invalid);
        }
        if state.pending_purge() {
            return Err(Error::Privacy);
        }
        Ok(state)
    }

    pub fn notify(&self) -> Result<(), Error> {
        let command = Command {
            request: Request::Operation(Operation::Wake, None),
            cancellation: Cancellation::default(),
            deadline: Instant::now() + REPORT_DEADLINE,
        };
        match self.send(command) {
            Err(Error::Busy) => Ok(()),
            result => result,
        }
    }
    pub fn rebuild(&self) -> Result<(), Error> {
        self.call(
            |reply| Request::Operation(Operation::Rebuild, Some(reply)),
            Cancellation::default(),
        )
        .map(|_| ())
    }
    pub fn purge(&self) -> Result<(), Error> {
        self.call(
            |reply| Request::Operation(Operation::Purge, Some(reply)),
            Cancellation::default(),
        )
        .map(|_| ())
    }
    pub fn maintain(&self) -> Result<Maintenance, Error> {
        self.call(Request::Maintain, Cancellation::default())
    }
    pub fn report(&self, queries: Vec<Query>) -> Result<ReportRows, Error> {
        self.report_cancellable(queries, Cancellation::default())
    }
    pub fn report_cancellable(
        &self,
        queries: Vec<Query>,
        cancellation: Cancellation,
    ) -> Result<ReportRows, Error> {
        let snapshot = self.0.store.snapshot()?;
        let state = snapshot
            .get::<DeliveryTable>(&[])?
            .unwrap_or_else(|| Delivery::initial(self.0.store.metadata()));
        drop(snapshot);
        if state.pending_purge() {
            return Err(Error::Privacy);
        }
        validate_queries(&queries)?;
        self.call(
            |reply| Request::Operation(Operation::Report(state, queries), Some(reply)),
            cancellation,
        )
    }
    fn send(&self, command: Command) -> Result<(), Error> {
        if thread::current().id() == self.0.writer {
            return Err(Error::Busy);
        }
        let sender = self
            .0
            .sender
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let sender = sender.as_ref().ok_or(Error::Closed)?;
        command
            .cancellation
            .enter(Phase::Queue, None, command.deadline)?;
        let wake = matches!(&command.request, Request::Operation(Operation::Wake, None));
        if wake && self.0.wake_pending.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        sender.try_send(command).map_err(|error| {
            if wake {
                self.0.wake_pending.store(false, Ordering::Release);
            }
            match error {
                mpsc::TrySendError::Full(_) => Error::Busy,
                mpsc::TrySendError::Disconnected(_) => Error::Closed,
            }
        })
    }
    fn call<T>(
        &self,
        request: impl FnOnce(mpsc::SyncSender<Result<T, Error>>) -> Request,
        cancellation: Cancellation,
    ) -> Result<T, Error> {
        if cancellation.0.claimed.swap(true, Ordering::AcqRel) {
            return Err(Error::Configuration);
        }
        let deadline = Instant::now() + REPORT_DEADLINE;
        cancellation.check(deadline)?;
        let (reply, receipt) = mpsc::sync_channel(1);
        self.send(Command {
            request: request(reply),
            cancellation: cancellation.clone(),
            deadline,
        })?;
        match receipt.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(Error::Closed),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let interrupt = {
                    let mut state = cancellation
                        .0
                        .state
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    state.expired = true;
                    state.interrupt.clone()
                };
                if let Some(interrupt) = interrupt {
                    interrupt.interrupt();
                }
                let error = cancellation.deadline();
                let _ = receipt.recv();
                Err(error)
            }
        }
    }
}

fn validate_queries(queries: &[Query]) -> Result<(), Error> {
    if queries.is_empty()
        || queries.len() > 16
        || queries.iter().any(|query| {
            query.max_rows == 0
                || query.max_rows > REPORT_ROWS
                || query.sql.len() > ROW_BYTES
                || query.parameters.len() > 64
        })
    {
        return Err(Error::Configuration);
    }
    let bytes = queries
        .iter()
        .flat_map(|query| &query.parameters)
        .map(worker::scalar_bytes)
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .sum::<usize>();
    if bytes > REPORT_BYTES {
        return Err(Error::Limit);
    }
    Ok(())
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        && value.as_bytes()[0].is_ascii_lowercase()
}
