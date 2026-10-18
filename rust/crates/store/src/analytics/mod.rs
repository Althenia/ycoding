use crate::Snapshot;
pub use duckdb::types::Value;
use std::marker::PhantomData;
use std::ops::Deref;
use std::path::Path;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

mod numeric;
pub mod reports;
mod state;
mod worker;
pub use state::{Change, Delivery, DeliveryTable, Intent, IntentTable, privacy_changed, record};

pub const INTENT_LIMIT: usize = 4096;
pub const INTENT_BYTES: usize = 8 * 1024 * 1024;
pub const BATCH_SIZE: usize = 128;
pub const REBUILD_SLICE_PAGES: usize = 64;
pub const REPORT_DEADLINE: Duration = Duration::from_secs(5);
pub const REPORT_STACK_BYTES: usize = 8 * 1024 * 1024;
pub const ROW_BYTES: usize = 64 * 1024;
pub const REPORT_ROWS: usize = 4096;
pub const REPORT_BYTES: usize = 8 * 1024 * 1024;
static INSTANCE: AtomicBool = AtomicBool::new(false);
pub type ReportRows = Vec<Vec<Vec<Value>>>;

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
            return Err(Error::Deadline);
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
            return Err(Error::Deadline);
        }
        Ok(())
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
        let root = root.as_ref().to_path_buf();
        let writer = match thread::Builder::new()
            .name("ycoding-analytics-writer".to_owned())
            .stack_size(REPORT_STACK_BYTES)
            .spawn(move || worker::run(owned_store, root, sources, receiver))
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
}
enum Operation {
    Wake,
    Rebuild,
    Purge,
    Report(Delivery, Vec<Query>),
    SnapshotReport(Delivery, Box<Snapshot>, &'static [&'static str], Vec<Query>),
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
    pub fn report_snapshot(
        &self,
        snapshot: Snapshot,
        sources: &'static [&'static str],
        queries: Vec<Query>,
    ) -> Result<ReportRows, Error> {
        let state = snapshot
            .get::<DeliveryTable>(&[])?
            .unwrap_or_else(|| Delivery::initial(self.0.store.metadata()));
        if !state.matches(self.0.store.metadata()) {
            return Err(Error::Invalid);
        }
        if state.pending_purge() {
            return Err(Error::Privacy);
        }
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
        self.0
            .sender
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .ok_or(Error::Closed)?
            .try_send(command)
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => Error::Busy,
                mpsc::TrySendError::Disconnected(_) => Error::Closed,
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
                let _ = receipt.recv();
                Err(Error::Deadline)
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
