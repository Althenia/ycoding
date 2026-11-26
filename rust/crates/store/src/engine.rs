use crate::catalog::{definition, index_definition};
use crate::metadata::{bootstrap, commit_error};
use crate::session::Event;
use crate::{Catalog, Error, IndexDefinition, KeyPart, Metadata, TableSpec, tuple_key};
use redb::{
    Database, Durability, ReadTransaction, ReadableDatabase, ReadableTable, ReadableTableMetadata,
    WriteTransaction,
};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::OpenOptions;
use std::future::Future;
use std::marker::PhantomData;
use std::ops::{Bound, Deref};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::pin::Pin;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak, mpsc};
use std::task::{Context, Poll, Waker};
use std::thread::{self, JoinHandle, ThreadId};

#[derive(Clone, Copy, Debug)]
pub struct Options {
    pub cache_bytes: usize,
    pub queue_capacity: usize,
    pub max_snapshots: usize,
}

impl Options {
    pub const fn core() -> Self {
        Self {
            cache_bytes: 128 * 1024 * 1024,
            queue_capacity: 256,
            max_snapshots: 64,
        }
    }
    pub const fn meeting() -> Self {
        Self {
            cache_bytes: 64 * 1024 * 1024,
            ..Self::core()
        }
    }
    fn validate(&self) -> Result<(), Error> {
        if !(1..=128 * 1024 * 1024).contains(&self.cache_bytes) {
            return Err(Error::InvalidConfiguration(
                "cache must be 1 byte through 128 MiB",
            ));
        }
        if !(1..=256).contains(&self.queue_capacity) || !(1..=256).contains(&self.max_snapshots) {
            return Err(Error::InvalidConfiguration(
                "queue and snapshot bounds must be 1 through 256",
            ));
        }
        Ok(())
    }
}

type Request = Box<dyn FnOnce(&Database, &AtomicBool, &Metadata) + Send>;
const TRANSACTION_WORK: usize = 65_536;

pub struct Store {
    client: Client,
    writer: Option<JoinHandle<()>>,
    _owner: PhantomData<Rc<()>>,
}

#[derive(Clone)]
pub struct Client(Arc<Shared>, Option<Arc<ReadBudget>>);

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReadUsage {
    pub work: usize,
    pub rows: usize,
    pub tables: BTreeMap<&'static str, usize>,
}

struct ReadBudget {
    limit: usize,
    parent: Option<Arc<ReadBudget>>,
    usage: Mutex<ReadUsage>,
}

impl ReadBudget {
    fn reserve(&self) -> Result<(), Error> {
        let mut usage = self.usage.lock().unwrap_or_else(|error| error.into_inner());
        let work = usage
            .work
            .checked_add(1)
            .filter(|work| *work <= self.limit)
            .ok_or(Error::Rejected(
                "read statement exceeds stored-row work limit",
            ))?;
        if let Some(parent) = &self.parent {
            parent.reserve()?;
        }
        usage.work = work;
        Ok(())
    }

    fn observe(&self, table: &'static str) {
        let mut usage = self.usage.lock().unwrap_or_else(|error| error.into_inner());
        usage.rows += 1;
        *usage.tables.entry(table).or_default() += 1;
        drop(usage);
        if let Some(parent) = &self.parent {
            parent.observe(table);
        }
    }
}

pub struct ReadStatement {
    client: Client,
}

impl ReadStatement {
    pub fn client(&self) -> &Client {
        &self.client
    }

    pub fn usage(&self) -> ReadUsage {
        self.client
            .1
            .as_ref()
            .expect("read statement budget")
            .usage
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub fn reset(&mut self) {
        let budget = self.client.1.as_ref().expect("read statement budget");
        self.client.1 = Some(Arc::new(ReadBudget {
            limit: budget.limit,
            parent: budget.parent.clone(),
            usage: Mutex::default(),
        }));
    }
}

#[derive(Clone)]
pub struct WeakClient(Weak<Shared>, Option<Arc<ReadBudget>>);

impl WeakClient {
    pub fn upgrade(&self) -> Option<Client> {
        self.0
            .upgrade()
            .map(|shared| Client(shared, self.1.clone()))
    }

    pub fn refers_to(&self, client: &Client) -> bool {
        std::ptr::eq(Weak::as_ptr(&self.0), Arc::as_ptr(&client.0))
    }
}

type EventObserver = Box<dyn Fn(&[Event]) -> bool + Send + Sync>;
type CommitObserver = Box<dyn Fn(&[&'static str]) -> bool + Send + Sync>;

#[derive(Default)]
struct Observers(Mutex<Vec<EventObserver>>, Mutex<Vec<CommitObserver>>);

impl Observers {
    fn committed(&self, changed: &[&'static str]) {
        if changed.is_empty() {
            return;
        }
        self.1
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .retain(|observer| {
                catch_unwind(AssertUnwindSafe(|| observer(changed))).unwrap_or(false)
            });
    }

    fn notify(&self, events: &[Event]) {
        if events.is_empty() {
            return;
        }
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .retain(|observer| {
                catch_unwind(AssertUnwindSafe(|| observer(events))).unwrap_or(false)
            });
    }
}

struct Shared {
    backup: Mutex<crate::backup::State>,
    analytics: Mutex<crate::analytics::Link>,
    observers: Arc<Observers>,
    database: Mutex<Option<Arc<Database>>>,
    sender: Mutex<Option<mpsc::SyncSender<Request>>>,
    writer: ThreadId,
    closed: AtomicBool,
    fenced: Arc<AtomicBool>,
    stamp: Arc<Stamp>,
    snapshots: Arc<AtomicUsize>,
    options: Options,
    catalog: Catalog,
    metadata: Metadata,
}

impl Store {
    pub fn initialize(
        path: impl AsRef<Path>,
        options: Options,
        catalog: Catalog,
        metadata: Metadata,
    ) -> Result<Self, Error> {
        options.validate()?;
        catalog.validate()?;
        metadata.validate()?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(path.as_ref())?;
        Self::start(
            Database::builder()
                .set_cache_size(options.cache_bytes)
                .create_file(file)?,
            options,
            catalog,
            Some(metadata),
            Some(std::fs::canonicalize(path)?),
        )
    }

    pub fn open(path: impl AsRef<Path>, options: Options, catalog: Catalog) -> Result<Self, Error> {
        options.validate()?;
        catalog.validate()?;
        Self::start(
            Database::builder()
                .set_cache_size(options.cache_bytes)
                .open(path.as_ref())?,
            options,
            catalog,
            None,
            Some(std::fs::canonicalize(path)?),
        )
    }

    pub fn disposable(
        options: Options,
        catalog: Catalog,
        metadata: Metadata,
    ) -> Result<Self, Error> {
        options.validate()?;
        catalog.validate()?;
        metadata.validate()?;
        Self::start(
            Database::builder()
                .set_cache_size(options.cache_bytes)
                .create_with_backend(redb::backends::InMemoryBackend::new())?,
            options,
            catalog,
            Some(metadata),
            None,
        )
    }

    fn start(
        database: Database,
        options: Options,
        catalog: Catalog,
        initial: Option<Metadata>,
        path: Option<std::path::PathBuf>,
    ) -> Result<Self, Error> {
        let database = Arc::new(database);
        let fenced = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = mpsc::sync_channel::<Request>(options.queue_capacity);
        let (ready, startup) = mpsc::sync_channel(1);
        let owned_database = Arc::clone(&database);
        let owned_fence = Arc::clone(&fenced);
        let writer = thread::Builder::new()
            .name("ycoding-store-writer".to_owned())
            .spawn(move || {
                let metadata = match bootstrap(&owned_database, catalog, initial) {
                    Ok(metadata) => {
                        if ready.send(Ok(metadata.clone())).is_err() {
                            return;
                        }
                        metadata
                    }
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        return;
                    }
                };
                while let Ok(request) = receiver.recv() {
                    if catch_unwind(AssertUnwindSafe(|| {
                        request(&owned_database, &owned_fence, &metadata)
                    }))
                    .is_err()
                    {
                        owned_fence.store(true, Ordering::Release);
                    }
                }
            })?;
        let metadata = match startup.recv() {
            Ok(Ok(metadata)) => metadata,
            result => {
                drop(sender);
                let joined = writer.join();
                if joined.is_err() {
                    return Err(Error::WriterPanicked);
                }
                return Err(match result {
                    Ok(Err(error)) => error,
                    _ => Error::WriterPanicked,
                });
            }
        };
        Ok(Self {
            client: Client(
                Arc::new(Shared {
                    backup: Mutex::new(crate::backup::State::new(path)),
                    analytics: Mutex::default(),
                    observers: Arc::default(),
                    database: Mutex::new(Some(database)),
                    sender: Mutex::new(Some(sender)),
                    writer: writer.thread().id(),
                    closed: AtomicBool::new(false),
                    fenced,
                    stamp: Arc::new(Stamp {
                        epoch: AtomicU64::new(0),
                        tables: TableVersions::new(catalog),
                    }),
                    snapshots: Arc::new(AtomicUsize::new(0)),
                    options,
                    catalog,
                    metadata,
                }),
                None,
            ),
            writer: Some(writer),
            _owner: PhantomData,
        })
    }

    pub fn client(&self) -> Client {
        self.client.clone()
    }

    pub fn shutdown(mut self) -> Result<(), Error> {
        self.join()
    }

    pub(crate) fn close_with<R>(
        mut self,
        operation: impl FnOnce(&mut Write<'_>) -> Result<R, Error>,
    ) -> Result<(Database, R), Error> {
        self.client.0.closed.store(true, Ordering::Release);
        self.client
            .0
            .sender
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(writer) = self.writer.take() {
            writer.join().map_err(|_| Error::WriterPanicked)?;
        }
        let database = self
            .client
            .0
            .database
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
            .ok_or(Error::Closed)?;
        let database = Arc::try_unwrap(database).map_err(|_| Error::Domain {
            kind: "database_busy",
            message: "exclusive database operation requires released snapshots",
        })?;
        if self.client.is_fenced() {
            return Err(Error::WriterFenced);
        }
        let result = transact(
            &database,
            self.client.0.catalog,
            &self.client.0.fenced,
            &self.client.0.stamp,
            &self.client.0.metadata,
            &self.client.0.observers,
            operation,
        )?;
        Ok((database, result))
    }

    fn join(&mut self) -> Result<(), Error> {
        self.client.0.closed.store(true, Ordering::Release);
        self.client
            .0
            .sender
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        let result = self.writer.take().map_or(Ok(()), |writer| {
            writer.join().map_err(|_| Error::WriterPanicked)
        });
        self.client
            .0
            .database
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        result
    }
}

impl Deref for Store {
    type Target = Client;
    fn deref(&self) -> &Self::Target {
        &self.client
    }
}

impl Client {
    pub fn read_statement(&self, limit: usize) -> ReadStatement {
        ReadStatement {
            client: Self(
                self.0.clone(),
                Some(Arc::new(ReadBudget {
                    limit,
                    parent: self.1.clone(),
                    usage: Mutex::default(),
                })),
            ),
        }
    }
    pub fn downgrade(&self) -> WeakClient {
        WeakClient(Arc::downgrade(&self.0), self.1.clone())
    }

    pub fn prepare_pruning(
        &self,
        now: i64,
        free_bytes: impl FnOnce(&Path) -> Result<u64, Error>,
    ) -> Result<crate::backup::Status, Error> {
        let mut state = self
            .0
            .backup
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.prepare(now, free_bytes, self.0.catalog, &self.0.metadata, || {
            self.snapshot()
        })
    }

    pub fn reclaim(&self) -> Result<Receipt<()>, Error> {
        self.submit(|_| Ok(()))
    }
    pub(crate) fn attach_analytics(&self, link: crate::analytics::Link) {
        *self
            .0
            .analytics
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = link;
    }

    pub fn analytics(&self) -> Result<crate::analytics::Handle, crate::analytics::Error> {
        self.0
            .analytics
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .handle()
    }
    pub fn submit_with_snapshot<R, F>(&self, operation: F) -> Result<Receipt<(R, Snapshot)>, Error>
    where
        R: Send + 'static,
        F: FnOnce(&mut Write<'_>) -> Result<R, Error> + Send + 'static,
    {
        if self.0.closed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        self.0
            .snapshots
            .try_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < self.0.options.max_snapshots).then_some(count + 1)
            })
            .map_err(|_| Error::SnapshotLimit)?;
        let permit = SnapshotPermit(Arc::clone(&self.0.snapshots));
        let database = self
            .0
            .database
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .cloned()
            .ok_or(Error::Closed)?;
        let catalog = self.0.catalog;
        let observers = Arc::clone(&self.0.observers);
        let stamp = Arc::clone(&self.0.stamp);
        let budget = self.1.clone();
        self.submit_operation(
            move |db, fenced, metadata| {
                let value = transact(db, catalog, fenced, &stamp, metadata, &observers, operation)?;
                let (read, view) = stamped(&database, &stamp)?;
                Ok((
                    value,
                    Snapshot {
                        read,
                        _permit: permit,
                        _database: database,
                        catalog,
                        view,
                        reads: Mutex::default(),
                        budget,
                    },
                ))
            },
            true,
            |_| {},
        )
    }
    pub fn metadata(&self) -> &Metadata {
        &self.0.metadata
    }
    pub fn catalog(&self) -> Catalog {
        self.0.catalog
    }
    pub fn is_fenced(&self) -> bool {
        self.0.fenced.load(Ordering::Acquire)
    }

    pub fn versions_current(&self, versions: &Versions) -> bool {
        if self.0.closed.load(Ordering::Acquire)
            || self.is_fenced()
            || !Arc::ptr_eq(&self.0.stamp, &versions.view.stamp)
        {
            return false;
        }
        let stamp = &self.0.stamp;
        let before = stamp.epoch.load(Ordering::SeqCst);
        let current = before.is_multiple_of(2)
            && versions.tables.iter().all(|name| {
                stamp.tables.index(name).is_some_and(|index| {
                    stamp.tables.versions[index].load(Ordering::SeqCst)
                        == versions.view.versions[index]
                })
            });
        current && before == stamp.epoch.load(Ordering::SeqCst)
    }

    pub fn submit<R, F>(&self, operation: F) -> Result<Receipt<R>, Error>
    where
        R: Send + 'static,
        F: FnOnce(&mut Write<'_>) -> Result<R, Error> + Send + 'static,
    {
        let catalog = self.0.catalog;
        let observers = Arc::clone(&self.0.observers);
        let stamp = Arc::clone(&self.0.stamp);
        self.submit_operation(
            move |database, fenced, metadata| {
                transact(
                    database, catalog, fenced, &stamp, metadata, &observers, operation,
                )
            },
            true,
            |_| {},
        )
    }

    pub fn submit_owned<R, F, O>(&self, operation: F, observe: O) -> Result<Receipt<R>, Error>
    where
        R: Send + 'static,
        F: FnOnce(&mut Write<'_>) -> Result<R, Error> + Send + 'static,
        O: FnOnce(&Result<R, Error>) + Send + 'static,
    {
        let catalog = self.0.catalog;
        let observers = Arc::clone(&self.0.observers);
        let stamp = Arc::clone(&self.0.stamp);
        self.submit_operation(
            move |database, fenced, metadata| {
                transact(
                    database, catalog, fenced, &stamp, metadata, &observers, operation,
                )
            },
            false,
            observe,
        )
    }

    pub fn observe_events(&self, observer: impl Fn(&[Event]) -> bool + Send + Sync + 'static) {
        self.0
            .observers
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(Box::new(observer));
    }

    pub fn observe_commits(
        &self,
        observer: impl Fn(&[&'static str]) -> bool + Send + Sync + 'static,
    ) {
        self.0
            .observers
            .1
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(Box::new(observer));
    }

    fn submit_operation<R: Send + 'static>(
        &self,
        operation: impl FnOnce(&Database, &AtomicBool, &Metadata) -> Result<R, Error> + Send + 'static,
        cancel_on_drop: bool,
        observe: impl FnOnce(&Result<R, Error>) + Send + 'static,
    ) -> Result<Receipt<R>, Error> {
        if self.0.closed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        if self.is_fenced() {
            return Err(Error::WriterFenced);
        }
        let writer = self.0.writer;
        if writer == thread::current().id() {
            return Err(Error::Reentrant);
        }
        let completion = Arc::new(Completion {
            state: Mutex::new(CompletionState {
                result: None,
                cancelled: false,
                started: false,
                waker: None,
            }),
            ready: Condvar::new(),
        });
        let owned_completion = Arc::clone(&completion);
        let request = Box::new(
            move |database: &Database, fenced: &AtomicBool, metadata: &Metadata| {
                {
                    let mut state = owned_completion
                        .state
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    if state.cancelled {
                        return;
                    }
                    state.started = true;
                }
                let result = catch_unwind(AssertUnwindSafe(|| {
                    if fenced.load(Ordering::Acquire) {
                        return Err(Error::WriterFenced);
                    }
                    operation(database, fenced, metadata)
                }))
                .unwrap_or_else(|_| {
                    fenced.store(true, Ordering::Release);
                    Err(Error::WriterPanicked)
                });
                if catch_unwind(AssertUnwindSafe(|| observe(&result))).is_err() {
                    fenced.store(true, Ordering::Release);
                }
                owned_completion.complete(result);
            },
        );
        self.0
            .sender
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .ok_or(Error::Closed)?
            .try_send(request)
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => Error::QueueFull,
                mpsc::TrySendError::Disconnected(_) => Error::Closed,
            })?;
        Ok(Receipt {
            completion,
            writer,
            cancel_on_drop,
        })
    }

    pub fn snapshot(&self) -> Result<Snapshot, Error> {
        if self.0.closed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        if self.is_fenced() {
            return Err(Error::WriterFenced);
        }
        let database = self
            .0
            .database
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let database = database.as_ref().ok_or(Error::Closed)?;
        self.0
            .snapshots
            .try_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < self.0.options.max_snapshots).then_some(count + 1)
            })
            .map_err(|_| Error::SnapshotLimit)?;
        let permit = SnapshotPermit(Arc::clone(&self.0.snapshots));
        let (read, view) = stamped(database, &self.0.stamp)?;
        Ok(Snapshot {
            read,
            _permit: permit,
            _database: Arc::clone(database),
            catalog: self.0.catalog,
            view,
            reads: Mutex::default(),
            budget: self.1.clone(),
        })
    }
}

impl Drop for Store {
    fn drop(&mut self) {
        let _ = self.join();
    }
}

struct CompletionState<R> {
    result: Option<Result<R, Error>>,
    cancelled: bool,
    started: bool,
    waker: Option<Waker>,
}
struct Completion<R> {
    state: Mutex<CompletionState<R>>,
    ready: Condvar,
}
impl<R> Completion<R> {
    fn complete(&self, result: Result<R, Error>) {
        let waker = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            state.result = Some(result);
            state.waker.take()
        };
        self.ready.notify_all();
        if let Some(waker) = waker {
            waker.wake();
        }
    }
}

pub struct Receipt<R> {
    completion: Arc<Completion<R>>,
    writer: ThreadId,
    cancel_on_drop: bool,
}
impl<R> Receipt<R> {
    pub fn wait(self) -> Result<R, Error> {
        if self.writer == thread::current().id() {
            return Err(Error::Reentrant);
        }
        let mut state = self
            .completion
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        loop {
            if let Some(result) = state.result.take() {
                return result;
            }
            state = self
                .completion
                .ready
                .wait(state)
                .unwrap_or_else(|error| error.into_inner());
        }
    }
}
impl<R> Future for Receipt<R> {
    type Output = Result<R, Error>;
    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let mut state = self
            .completion
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(result) = state.result.take() {
            return Poll::Ready(result);
        }
        state.waker = Some(context.waker().clone());
        Poll::Pending
    }
}
impl<R> Drop for Receipt<R> {
    fn drop(&mut self) {
        let mut state = self
            .completion
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.cancel_on_drop && !state.started {
            state.cancelled = true;
        }
        state.waker = None;
    }
}

fn epoch_advance(epoch: &AtomicU64) {
    if epoch.load(Ordering::SeqCst) != u64::MAX {
        epoch.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Debug)]
struct Stamp {
    epoch: AtomicU64,
    tables: TableVersions,
}

#[derive(Debug)]
struct TableVersions {
    names: Vec<&'static str>,
    versions: Vec<AtomicU64>,
}

impl TableVersions {
    fn new(catalog: Catalog) -> Self {
        let names = catalog
            .tables()
            .iter()
            .map(|table| table.name)
            .collect::<Vec<_>>();
        let versions = (0..names.len()).map(|_| AtomicU64::new(0)).collect();
        Self { names, versions }
    }

    fn bump(&self, changed: &[&'static str]) {
        if changed.is_empty() || changed.iter().any(|name| !self.names.contains(name)) {
            for version in &self.versions {
                epoch_advance(version);
            }
            return;
        }
        for name in changed {
            if let Some(index) = self.index(name) {
                epoch_advance(&self.versions[index]);
            }
        }
    }

    fn capture(&self) -> Vec<u64> {
        self.versions
            .iter()
            .map(|version| version.load(Ordering::SeqCst))
            .collect()
    }

    fn index(&self, name: &str) -> Option<usize> {
        self.names.iter().position(|known| *known == name)
    }
}

fn stamped(
    database: &Arc<Database>,
    stamp: &Arc<Stamp>,
) -> Result<(ReadTransaction, Option<SnapshotView>), Error> {
    let before = stamp.epoch.load(Ordering::SeqCst);
    let versions = stamp.tables.capture();
    let read = database.begin_read()?;
    let after = stamp.epoch.load(Ordering::SeqCst);
    let view = (before == after && before.is_multiple_of(2)).then(|| SnapshotView {
        epoch: before,
        database: Arc::downgrade(database),
        stamp: Arc::clone(stamp),
        versions,
    });
    Ok((read, view))
}

fn transact<R>(
    database: &Database,
    catalog: Catalog,
    fenced: &AtomicBool,
    stamp: &Stamp,
    metadata: &Metadata,
    observers: &Observers,
    operation: impl FnOnce(&mut Write<'_>) -> Result<R, Error>,
) -> Result<R, Error> {
    let mut transaction = database.begin_write().inspect_err(|_| {
        fenced.store(true, Ordering::Release);
    })?;
    transaction.set_durability(Durability::Immediate)?;
    transaction.set_quick_repair(true);
    let mut write = Write {
        transaction: &transaction,
        metadata,
        catalog,
        dirty: false,
        changed: Vec::new(),
        failed: false,
        rejection: None,
        events: Vec::new(),
        remaining_work: TRANSACTION_WORK,
    };
    let result = catch_unwind(AssertUnwindSafe(|| operation(&mut write)));
    let failed = write.failed;
    let rejection = write.rejection.take();
    let events = std::mem::take(&mut write.events);
    let changed = std::mem::take(&mut write.changed);
    let dirty = write.dirty || !events.is_empty();
    match result {
        Ok(Ok(value)) if !failed => {
            if dirty {
                epoch_advance(&stamp.epoch);
            }
            let committed = transaction.commit();
            if dirty {
                stamp.tables.bump(&changed);
                epoch_advance(&stamp.epoch);
            }
            match committed {
                Ok(()) => {
                    observers.committed(&changed);
                    observers.notify(&events);
                    Ok(value)
                }
                Err(error) => {
                    let error = commit_error(error);
                    if matches!(error, Error::CommitUncertain(_)) {
                        fenced.store(true, Ordering::Release);
                    }
                    Err(error)
                }
            }
        }
        result => {
            let error = match result {
                Ok(Err(error)) => error,
                Ok(Ok(_)) => rejection.unwrap_or(Error::TransactionAborted),
                Err(_) => {
                    fenced.store(true, Ordering::Release);
                    Error::WriterPanicked
                }
            };
            transaction.abort().map_err(|error| {
                fenced.store(true, Ordering::Release);
                Error::RollbackFailed(error)
            })?;
            Err(error)
        }
    }
}

pub struct Write<'a> {
    transaction: &'a WriteTransaction,
    metadata: &'a Metadata,
    catalog: Catalog,
    dirty: bool,
    changed: Vec<&'static str>,
    failed: bool,
    rejection: Option<Error>,
    events: Vec<Event>,
    remaining_work: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IndexOrder {
    Ascending,
    Descending,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexCursor {
    pub logical_key: Vec<u8>,
    pub primary_key: Vec<u8>,
}

#[derive(Debug)]
pub struct IndexEntry<R> {
    pub record: R,
    pub cursor: IndexCursor,
}

#[derive(Clone, Copy, Debug)]
pub struct IndexQuery<'a> {
    pub lower: Bound<&'a [u8]>,
    pub upper: Bound<&'a [u8]>,
    pub prefix: Option<&'a [u8]>,
    pub order: IndexOrder,
    pub after: Option<&'a IndexCursor>,
    pub limit: usize,
}

impl Write<'_> {
    pub(crate) fn import_bun<R>(
        &mut self,
        operation: impl FnOnce(&mut Self) -> Result<R, Error>,
    ) -> Result<Option<R>, Error> {
        for table in self.catalog.tables() {
            if crate::bun_import::blocks_import_when_populated(table.name)
                && !self
                    .transaction
                    .open_table(definition(table.name))?
                    .is_empty()?
            {
                return Ok(None);
            }
        }
        self.remaining_work = usize::MAX;
        operation(self).map(Some)
    }

    fn work(&mut self, units: usize) -> Result<(), Error> {
        let Some(remaining) = self.remaining_work.checked_sub(units) else {
            return Err(self.reject(Error::Domain {
                kind: "transaction_work_limit",
                message: "transaction exceeds 65536 logical work units",
            }));
        };
        self.remaining_work = remaining;
        Ok(())
    }

    pub(crate) fn record_event(&mut self, event: Event) {
        self.events.push(event);
    }

    pub fn metadata(&self) -> &Metadata {
        self.metadata
    }
    pub fn index_range<T: TableSpec>(
        &mut self,
        name: &str,
        query: IndexQuery<'_>,
    ) -> Result<Vec<IndexEntry<T::Record>>, Error> {
        self.work(1)?;
        let result = (|| {
            self.catalog.require::<T>()?;
            let index = index_definition::<T>(name)?;
            let rows = read_index_range::<T>(
                &self.transaction.open_table(definition(T::NAME))?,
                &self.transaction.open_table(definition(index.name))?,
                index,
                IndexQuery {
                    limit: query.limit.min(self.remaining_work + 1),
                    ..query
                },
                None,
            )?;
            self.work(rows.len())?;
            Ok(rows)
        })();
        self.failed |= result.is_err();
        result
    }

    pub fn reject(&mut self, error: Error) -> Error {
        self.failed = true;
        if self.rejection.is_none() {
            self.rejection = match &error {
                Error::Domain { kind, message } => Some(Error::Domain { kind, message }),
                Error::Rejected(reason) => Some(Error::Rejected(reason)),
                _ => None,
            };
        }
        error
    }

    pub fn index<T: TableSpec>(
        &mut self,
        name: &str,
        key: &[u8],
        after_primary: Option<&[u8]>,
        limit: usize,
    ) -> Result<Vec<T::Record>, Error> {
        self.work(1)?;
        let result = (|| {
            self.catalog.require::<T>()?;
            let index = index_definition::<T>(name)?;
            let rows = read_index::<T>(
                &self.transaction.open_table(definition(T::NAME))?,
                &self.transaction.open_table(definition(index.name))?,
                index,
                key,
                after_primary,
                limit.min(self.remaining_work + 1),
                None,
            )?;
            self.work(rows.len())?;
            Ok(rows)
        })();
        self.failed |= result.is_err();
        result
    }

    pub fn scan<T: TableSpec>(
        &mut self,
        lower: Bound<&[u8]>,
        upper: Bound<&[u8]>,
        limit: usize,
    ) -> Result<Vec<T::Record>, Error> {
        self.work(1)?;
        let result = (|| {
            self.catalog.require::<T>()?;
            let rows = self
                .transaction
                .open_table(definition(T::NAME))?
                .range::<&[u8]>((lower, upper))?
                .take(limit.min(self.remaining_work + 1))
                .map(|entry| {
                    let (key, value) = entry?;
                    decode_record::<T>(key.value(), value.value())
                })
                .collect::<Result<Vec<_>, Error>>()?;
            self.work(rows.len())?;
            Ok(rows)
        })();
        self.failed |= result.is_err();
        result
    }
    pub fn get<T: TableSpec>(&mut self, key: &[u8]) -> Result<Option<T::Record>, Error> {
        self.work(1)?;
        let result = (|| {
            self.catalog.require::<T>()?;
            let table = self.transaction.open_table(definition(T::NAME))?;
            table
                .get(key)?
                .map(|value| decode_record::<T>(key, value.value()))
                .transpose()
        })();
        self.failed |= result.is_err();
        result
    }

    pub(crate) fn registered<T: TableSpec>(&self) -> bool {
        self.catalog.require::<T>().is_ok()
    }

    pub fn put<T: TableSpec>(&mut self, record: &T::Record) -> Result<(), Error> {
        self.work(1)?;
        let result = self.put_inner::<T>(record).and_then(|()| {
            crate::usage_cells::changed(self, T::NAME, &T::primary_key(record), false)
        });
        self.dirty |= result.is_ok();
        if result.is_ok() && !self.changed.contains(&T::NAME) {
            self.changed.push(T::NAME);
        }
        self.failed |= result.is_err();
        result
    }

    fn put_inner<T: TableSpec>(&self, record: &T::Record) -> Result<(), Error> {
        self.catalog.require::<T>()?;
        let key = T::primary_key(record);
        let encoded = T::encode(record)?;
        let old = {
            let table = self.transaction.open_table(definition(T::NAME))?;
            table
                .get(key.as_slice())?
                .map(|value| decode_record::<T>(&key, value.value()))
                .transpose()?
        };
        if let Some(old) = old {
            self.remove_indexes::<T>(&old, &key)?;
        }
        for index in T::INDEXES {
            let Some(index_key) = T::index_key(index, record)? else {
                continue;
            };
            let storage_key = index_storage_key(index, &index_key, &key);
            let mut table = self.transaction.open_table(definition(index.name))?;
            if index.unique
                && table
                    .get(storage_key.as_slice())?
                    .is_some_and(|existing| existing.value() != key)
            {
                return Err(Error::UniqueViolation { index: index.name });
            }
            table.insert(storage_key.as_slice(), key.as_slice())?;
        }
        self.transaction
            .open_table(definition(T::NAME))?
            .insert(key.as_slice(), encoded.as_slice())?;
        Ok(())
    }

    pub fn delete<T: TableSpec>(&mut self, key: &[u8]) -> Result<bool, Error> {
        self.work(1)?;
        let result = (|| {
            self.catalog.require::<T>()?;
            let old = {
                let table = self.transaction.open_table(definition(T::NAME))?;
                table
                    .get(key)?
                    .map(|value| decode_record::<T>(key, value.value()))
                    .transpose()?
            };
            let Some(old) = old else {
                return Ok(false);
            };
            self.remove_indexes::<T>(&old, key)?;
            self.transaction
                .open_table(definition(T::NAME))?
                .remove(key)?;
            crate::usage_cells::changed(self, T::NAME, key, true)?;
            Ok(true)
        })();
        self.dirty |= matches!(result, Ok(true));
        if matches!(result, Ok(true)) && !self.changed.contains(&T::NAME) {
            self.changed.push(T::NAME);
        }
        self.failed |= result.is_err();
        result
    }

    fn remove_indexes<T: TableSpec>(
        &self,
        record: &T::Record,
        primary: &[u8],
    ) -> Result<(), Error> {
        for index in T::INDEXES {
            let Some(key) = T::index_key(index, record)? else {
                continue;
            };
            let storage_key = index_storage_key(index, &key, primary);
            let mut table = self.transaction.open_table(definition(index.name))?;
            if table
                .remove(storage_key.as_slice())?
                .is_none_or(|value| value.value() != primary)
            {
                return Err(Error::Incompatible("missing or inconsistent index entry"));
            }
        }
        Ok(())
    }
}

pub(crate) fn index_storage_key(index: &IndexDefinition, key: &[u8], primary: &[u8]) -> Vec<u8> {
    if index.unique {
        return key.to_vec();
    }
    tuple_key(&[KeyPart::Bytes(key), KeyPart::Bytes(primary)])
}

fn decode_record<T: TableSpec>(key: &[u8], bytes: &[u8]) -> Result<T::Record, Error> {
    let record = T::decode(bytes)?;
    if T::primary_key(&record) != key {
        return Err(Error::Incompatible("record primary identity mismatch"));
    }
    Ok(record)
}

struct SnapshotPermit(Arc<AtomicUsize>);
impl Drop for SnapshotPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Release);
    }
}

#[derive(Clone, Debug)]
pub(crate) struct SnapshotView {
    epoch: u64,
    database: Weak<Database>,
    stamp: Arc<Stamp>,
    versions: Vec<u64>,
}

impl SnapshotView {
    pub(crate) fn same(&self, other: &Self) -> bool {
        self.epoch == other.epoch && Weak::ptr_eq(&self.database, &other.database)
    }

    pub(crate) fn same_reads(&self, other: &Self, reads: &BTreeSet<&'static str>) -> bool {
        self.same(other)
            || (Weak::ptr_eq(&self.database, &other.database)
                && Arc::ptr_eq(&self.stamp, &other.stamp)
                && reads.iter().all(|name| {
                    self.stamp
                        .tables
                        .index(name)
                        .is_some_and(|index| self.versions[index] == other.versions[index])
                }))
    }
}

#[derive(Clone, Debug)]
pub struct Versions {
    view: SnapshotView,
    tables: BTreeSet<&'static str>,
}

impl Versions {
    pub(crate) fn exclude<T: TableSpec>(&mut self) {
        self.tables.remove(T::NAME);
    }

    pub fn current(&self, snapshot: &Snapshot) -> bool {
        snapshot
            .view
            .as_ref()
            .is_some_and(|view| self.view.same_reads(view, &self.tables))
    }
}

pub struct Snapshot {
    pub(crate) read: ReadTransaction,
    _permit: SnapshotPermit,
    _database: Arc<Database>,
    catalog: Catalog,
    view: Option<SnapshotView>,
    reads: Mutex<BTreeSet<&'static str>>,
    budget: Option<Arc<ReadBudget>>,
}

pub struct SnapshotStatement<'a> {
    snapshot: &'a Snapshot,
    budget: ReadBudget,
}

impl SnapshotStatement<'_> {
    pub fn get<T: TableSpec>(&self, key: &[u8]) -> Result<Option<T::Record>, Error> {
        self.snapshot.get_with_budget::<T>(key, Some(&self.budget))
    }

    pub fn scan<T: TableSpec>(
        &self,
        lower: Bound<&[u8]>,
        upper: Bound<&[u8]>,
        limit: usize,
    ) -> Result<Vec<T::Record>, Error> {
        self.snapshot
            .scan_with_budget::<T>(lower, upper, limit, Some(&self.budget))
    }
}

impl Snapshot {
    pub fn read_statement(&self, limit: usize) -> SnapshotStatement<'_> {
        SnapshotStatement {
            snapshot: self,
            budget: ReadBudget {
                limit,
                parent: self.budget.clone(),
                usage: Mutex::new(ReadUsage::default()),
            },
        }
    }

    pub(crate) fn view(&self) -> Option<&SnapshotView> {
        self.view.as_ref()
    }

    pub fn versions(&self, tables: &[&'static str]) -> Option<Versions> {
        let view = self.view.clone()?;
        let mut reads = self.reads();
        reads.extend(tables);
        Some(Versions {
            view,
            tables: reads,
        })
    }

    pub(crate) fn reset_reads(&self) {
        self.reads
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
    }

    pub(crate) fn reads(&self) -> BTreeSet<&'static str> {
        self.reads
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn track<T: TableSpec>(&self) {
        self.reads
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(T::NAME);
    }

    pub fn index_range<T: TableSpec>(
        &self,
        name: &str,
        query: IndexQuery<'_>,
    ) -> Result<Vec<IndexEntry<T::Record>>, Error> {
        self.track::<T>();
        self.catalog.require::<T>()?;
        let index = index_definition::<T>(name)?;
        read_index_range::<T>(
            &self.read.open_table(definition(T::NAME))?,
            &self.read.open_table(definition(index.name))?,
            index,
            query,
            self.budget.as_deref(),
        )
    }

    pub fn index_cursors<T: TableSpec>(
        &self,
        name: &str,
        query: IndexQuery<'_>,
    ) -> Result<Vec<IndexCursor>, Error> {
        self.track::<T>();
        self.catalog.require::<T>()?;
        let index = index_definition::<T>(name)?;
        let records = self.read.open_table(definition(T::NAME))?;
        let table = self.read.open_table(definition(index.name))?;
        let Some((lower, upper)) = index_range_bounds(index, &query) else {
            return Ok(Vec::new());
        };
        let mut range = table.range::<&[u8]>((
            lower.as_ref().map(Vec::as_slice),
            upper.as_ref().map(Vec::as_slice),
        ))?;
        std::iter::from_fn(|| {
            if let Some(budget) = &self.budget
                && let Err(error) = budget.reserve()
            {
                return Some(Err(error));
            }
            match query.order {
                IndexOrder::Ascending => range.next(),
                IndexOrder::Descending => range.next_back(),
            }
            .map(|entry| entry.map_err(Error::from))
        })
        .take(query.limit)
        .map(|entry| {
            let (storage_key, primary) = entry?;
            if let Some(budget) = &self.budget {
                budget.observe(index.name);
                budget.reserve()?;
            }
            let record = records.get(primary.value())?;
            if record.is_none() {
                return Err(Error::Incompatible("dangling index entry"));
            }
            if let Some(budget) = &self.budget {
                budget.observe(T::NAME);
            }
            index_cursor(index, storage_key.value(), primary.value())
        })
        .collect()
    }

    pub fn get<T: TableSpec>(&self, key: &[u8]) -> Result<Option<T::Record>, Error> {
        self.get_with_budget::<T>(key, self.budget.as_deref())
    }

    fn get_with_budget<T: TableSpec>(
        &self,
        key: &[u8],
        budget: Option<&ReadBudget>,
    ) -> Result<Option<T::Record>, Error> {
        self.track::<T>();
        self.catalog.require::<T>()?;
        if let Some(budget) = budget {
            budget.reserve()?;
        }
        self.read
            .open_table(definition(T::NAME))?
            .get(key)?
            .map(|value| {
                if let Some(budget) = budget {
                    budget.observe(T::NAME);
                }
                decode_record::<T>(key, value.value())
            })
            .transpose()
    }

    pub fn scan<T: TableSpec>(
        &self,
        lower: Bound<&[u8]>,
        upper: Bound<&[u8]>,
        limit: usize,
    ) -> Result<Vec<T::Record>, Error> {
        self.scan_with_budget::<T>(lower, upper, limit, self.budget.as_deref())
    }

    fn scan_with_budget<T: TableSpec>(
        &self,
        lower: Bound<&[u8]>,
        upper: Bound<&[u8]>,
        limit: usize,
        budget: Option<&ReadBudget>,
    ) -> Result<Vec<T::Record>, Error> {
        self.track::<T>();
        self.catalog.require::<T>()?;
        let table = self.read.open_table(definition(T::NAME))?;
        let mut range = table.range::<&[u8]>((lower, upper))?;
        std::iter::from_fn(|| {
            if let Some(budget) = budget
                && let Err(error) = budget.reserve()
            {
                return Some(Err(error));
            }
            range.next().map(|entry| entry.map_err(Error::from))
        })
        .take(limit)
        .map(|entry| {
            let (key, value) = entry?;
            if let Some(budget) = budget {
                budget.observe(T::NAME);
            }
            decode_record::<T>(key.value(), value.value())
        })
        .collect()
    }

    pub fn index<T: TableSpec>(
        &self,
        name: &str,
        key: &[u8],
        after_primary: Option<&[u8]>,
        limit: usize,
    ) -> Result<Vec<T::Record>, Error> {
        self.track::<T>();
        self.catalog.require::<T>()?;
        let index = index_definition::<T>(name)?;
        read_index::<T>(
            &self.read.open_table(definition(T::NAME))?,
            &self.read.open_table(definition(index.name))?,
            index,
            key,
            after_primary,
            limit,
            self.budget.as_deref(),
        )
    }
}

fn read_index<T: TableSpec>(
    records: &impl ReadableTable<&'static [u8], &'static [u8]>,
    table: &impl ReadableTable<&'static [u8], &'static [u8]>,
    index: &IndexDefinition,
    key: &[u8],
    after_primary: Option<&[u8]>,
    limit: usize,
    budget: Option<&ReadBudget>,
) -> Result<Vec<T::Record>, Error> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    if index.unique {
        if let Some(budget) = budget {
            budget.reserve()?;
        }
        let Some(primary) = table.get(key)? else {
            return Ok(Vec::new());
        };
        if let Some(budget) = budget {
            budget.observe(index.name);
        }
        if after_primary.is_some_and(|after| primary.value() <= after) {
            return Ok(Vec::new());
        }
        return Ok(vec![index_record::<T>(
            records,
            index,
            key,
            primary.value(),
            budget,
        )?]);
    }
    let prefix = tuple_key(&[KeyPart::Bytes(key)]);
    let mut end = prefix.clone();
    end.pop();
    end.push(1);
    let start = after_primary.map(|primary| index_storage_key(index, key, primary));
    let lower = start
        .as_ref()
        .map_or(Bound::Included(prefix.as_slice()), |start| {
            Bound::Excluded(start.as_slice())
        });
    let mut range = table.range::<&[u8]>((lower, Bound::Excluded(end.as_slice())))?;
    std::iter::from_fn(|| {
        if let Some(budget) = budget
            && let Err(error) = budget.reserve()
        {
            return Some(Err(error));
        }
        range.next().map(|entry| entry.map_err(Error::from))
    })
    .take(limit)
    .map(|entry| {
        let (storage_key, primary) = entry?;
        if let Some(budget) = budget {
            budget.observe(index.name);
        }
        if storage_key.value() != index_storage_key(index, key, primary.value()) {
            return Err(Error::Incompatible("index primary tiebreak mismatch"));
        }
        index_record::<T>(records, index, key, primary.value(), budget)
    })
    .collect()
}

fn read_index_range<T: TableSpec>(
    records: &impl ReadableTable<&'static [u8], &'static [u8]>,
    table: &impl ReadableTable<&'static [u8], &'static [u8]>,
    index: &IndexDefinition,
    query: IndexQuery<'_>,
    budget: Option<&ReadBudget>,
) -> Result<Vec<IndexEntry<T::Record>>, Error> {
    let Some((lower, upper)) = index_range_bounds(index, &query) else {
        return Ok(Vec::new());
    };
    let mut range = table.range::<&[u8]>((
        lower.as_ref().map(Vec::as_slice),
        upper.as_ref().map(Vec::as_slice),
    ))?;
    std::iter::from_fn(|| {
        if let Some(budget) = budget
            && let Err(error) = budget.reserve()
        {
            return Some(Err(error));
        }
        match query.order {
            IndexOrder::Ascending => range.next(),
            IndexOrder::Descending => range.next_back(),
        }
        .map(|entry| entry.map_err(Error::from))
    })
    .take(query.limit)
    .map(|entry| {
        let (storage_key, primary) = entry?;
        if let Some(budget) = budget {
            budget.observe(index.name);
            budget.reserve()?;
        }
        let value = records
            .get(primary.value())?
            .ok_or(Error::Incompatible("dangling index entry"))?;
        if let Some(budget) = budget {
            budget.observe(T::NAME);
        }
        let record = decode_record::<T>(primary.value(), value.value())?;
        let logical_key =
            T::index_key(index, &record)?.ok_or(Error::Incompatible("stale index entry"))?;
        if storage_key.value() != index_storage_key(index, &logical_key, primary.value()) {
            return Err(Error::Incompatible("stale or inconsistent index entry"));
        }
        Ok(IndexEntry {
            record,
            cursor: IndexCursor {
                logical_key,
                primary_key: primary.value().to_vec(),
            },
        })
    })
    .collect()
}

type IndexBounds = (Bound<Vec<u8>>, Bound<Vec<u8>>);

fn index_range_bounds(index: &IndexDefinition, query: &IndexQuery<'_>) -> Option<IndexBounds> {
    if query.limit == 0 {
        return None;
    }
    let mut lower = logical_bound(index, query.lower, false);
    let mut upper = logical_bound(index, query.upper, true);
    if let Some(prefix) = query.prefix {
        let prefix = if index.unique {
            prefix.to_vec()
        } else {
            let mut encoded = tuple_key(&[KeyPart::Bytes(prefix)]);
            encoded.truncate(encoded.len() - 2);
            encoded
        };
        upper = tighter_bound(
            upper,
            prefix_end(&prefix).map_or(Bound::Unbounded, Bound::Excluded),
            false,
        );
        lower = tighter_bound(lower, Bound::Included(prefix), true);
    }
    if let Some(cursor) = query.after {
        let cursor = Bound::Excluded(index_storage_key(
            index,
            &cursor.logical_key,
            &cursor.primary_key,
        ));
        match query.order {
            IndexOrder::Ascending => lower = tighter_bound(lower, cursor, true),
            IndexOrder::Descending => upper = tighter_bound(upper, cursor, false),
        }
    }
    if let (Bound::Included(lo) | Bound::Excluded(lo), Bound::Included(hi) | Bound::Excluded(hi)) =
        (&lower, &upper)
        && (lo > hi
            || (lo == hi
                && (!matches!(lower, Bound::Included(_)) || !matches!(upper, Bound::Included(_)))))
    {
        return None;
    }
    Some((lower, upper))
}

fn index_cursor(
    index: &IndexDefinition,
    storage_key: &[u8],
    primary: &[u8],
) -> Result<IndexCursor, Error> {
    let logical_key = if index.unique {
        storage_key.to_vec()
    } else {
        let mut bytes = storage_key
            .strip_prefix(&[3])
            .ok_or(Error::Incompatible("invalid index key"))?;
        let mut logical = Vec::new();
        loop {
            let Some((&byte, rest)) = bytes.split_first() else {
                return Err(Error::Incompatible("unterminated index key"));
            };
            bytes = rest;
            if byte != 0 {
                logical.push(byte);
                continue;
            }
            let Some((&escaped, rest)) = bytes.split_first() else {
                return Err(Error::Incompatible("unterminated index key"));
            };
            bytes = rest;
            match escaped {
                0 => break,
                255 => logical.push(0),
                _ => return Err(Error::Incompatible("invalid index key escape")),
            }
        }
        logical
    };
    if storage_key != index_storage_key(index, &logical_key, primary) {
        return Err(Error::Incompatible("index primary tiebreak mismatch"));
    }
    Ok(IndexCursor {
        logical_key,
        primary_key: primary.to_vec(),
    })
}

fn logical_bound(index: &IndexDefinition, bound: Bound<&[u8]>, upper: bool) -> Bound<Vec<u8>> {
    if index.unique {
        return bound.map(<[u8]>::to_vec);
    }
    let (key, included) = match bound {
        Bound::Included(key) => (key, true),
        Bound::Excluded(key) => (key, false),
        Bound::Unbounded => return Bound::Unbounded,
    };
    let start = tuple_key(&[KeyPart::Bytes(key)]);
    let key = if included == upper {
        prefix_end(&start).expect("terminated index group has a successor")
    } else {
        start
    };
    if upper {
        Bound::Excluded(key)
    } else {
        Bound::Included(key)
    }
}

fn prefix_end(prefix: &[u8]) -> Option<Vec<u8>> {
    let position = prefix.iter().rposition(|byte| *byte != u8::MAX)?;
    let mut end = prefix[..=position].to_vec();
    end[position] += 1;
    Some(end)
}

fn tighter_bound(left: Bound<Vec<u8>>, right: Bound<Vec<u8>>, lower: bool) -> Bound<Vec<u8>> {
    let (left_key, right_key) = match (&left, &right) {
        (Bound::Unbounded, _) => return right,
        (_, Bound::Unbounded) => return left,
        (
            Bound::Included(left) | Bound::Excluded(left),
            Bound::Included(right) | Bound::Excluded(right),
        ) => (left, right),
    };
    let take_left = if left_key == right_key {
        matches!(left, Bound::Excluded(_))
    } else if lower {
        left_key > right_key
    } else {
        left_key < right_key
    };
    if take_left { left } else { right }
}

fn index_record<T: TableSpec>(
    records: &impl ReadableTable<&'static [u8], &'static [u8]>,
    index: &IndexDefinition,
    key: &[u8],
    primary: &[u8],
    budget: Option<&ReadBudget>,
) -> Result<T::Record, Error> {
    if let Some(budget) = budget {
        budget.reserve()?;
    }
    let value = records
        .get(primary)?
        .ok_or(Error::Incompatible("dangling index entry"))?;
    if let Some(budget) = budget {
        budget.observe(T::NAME);
    }
    let record = decode_record::<T>(primary, value.value())?;
    if T::index_key(index, &record)?.as_deref() != Some(key) {
        return Err(Error::Incompatible("stale index entry"));
    }
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::{Options, Store};
    use crate::catalog::definition;
    use crate::{Catalog, Error, IndexDefinition, Metadata, TableDeclaration, TableSpec};
    use redb::{Database, StorageBackend};
    use std::fs::OpenOptions;
    use std::io;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, mpsc};
    use std::time::Duration;

    type SyncBarrier = Arc<std::sync::Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>>;

    #[derive(Debug)]
    struct SyncFault {
        file: redb::backends::FileBackend,
        syncs_until_error: Arc<AtomicUsize>,
        barrier: SyncBarrier,
    }

    impl StorageBackend for SyncFault {
        fn len(&self) -> io::Result<u64> {
            self.file.len()
        }
        fn read(&self, offset: u64, out: &mut [u8]) -> io::Result<()> {
            self.file.read(offset, out)
        }
        fn set_len(&self, len: u64) -> io::Result<()> {
            self.file.set_len(len)
        }
        fn write(&self, offset: u64, data: &[u8]) -> io::Result<()> {
            self.file.write(offset, data)
        }
        fn close(&self) -> io::Result<()> {
            self.file.close()
        }
        fn sync_data(&self) -> io::Result<()> {
            self.file.sync_data()?;
            let barrier = self
                .barrier
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take();
            if let Some((reached, release)) = barrier {
                reached.send(()).unwrap();
                release.recv_timeout(Duration::from_secs(10)).unwrap();
            }
            if self
                .syncs_until_error
                .try_update(Ordering::AcqRel, Ordering::Acquire, |left| {
                    left.checked_sub(1)
                })
                == Ok(1)
            {
                return Err(io::Error::other(
                    "injected post-fsync acknowledgement failure",
                ));
            }
            Ok(())
        }
    }

    #[test]
    fn durable_commit_ack_failure_fences_queued_operations_without_replay() {
        assert_commit_fenced_after_sync(1, 1);
        assert_commit_fenced_after_sync(2, 2);
    }

    fn assert_commit_fenced_after_sync(sync: usize, expected_generation: u64) {
        let path = std::env::temp_dir().join(format!(
            "ycoding-store-sync-fault-{}-{sync}.redb",
            std::process::id()
        ));
        let syncs_until_error = Arc::new(AtomicUsize::new(0));
        let backend = SyncFault {
            file: redb::backends::FileBackend::new(
                OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create_new(true)
                    .open(&path)
                    .unwrap(),
            )
            .unwrap(),
            syncs_until_error: Arc::clone(&syncs_until_error),
            barrier: Arc::new(std::sync::Mutex::new(None)),
        };
        let options = Options {
            cache_bytes: 1024 * 1024,
            queue_capacity: 2,
            max_snapshots: 2,
        };
        let db = Database::builder()
            .set_cache_size(options.cache_bytes)
            .create_with_backend(backend)
            .unwrap();
        let store = Store::start(
            db,
            options,
            Catalog::EMPTY,
            Some(Metadata::new([9; 16], 1)),
            None,
        )
        .unwrap();
        let (reached, started) = mpsc::channel();
        let (release, barrier) = mpsc::channel();
        let receipt = store
            .submit_with_snapshot(move |tx| {
                tx.transaction
                    .open_table(definition("storage_metadata"))?
                    .insert(b"generation".as_slice(), 2_u64.to_be_bytes().as_slice())?;
                reached.send(()).unwrap();
                barrier.recv_timeout(Duration::from_secs(10)).unwrap();
                Ok(())
            })
            .unwrap();
        started.recv_timeout(Duration::from_secs(10)).unwrap();
        let executed = Arc::new(AtomicBool::new(false));
        let owned_executed = Arc::clone(&executed);
        let queued = store
            .submit(move |_| {
                owned_executed.store(true, Ordering::Release);
                Ok(())
            })
            .unwrap();
        syncs_until_error.store(sync, Ordering::Release);
        release.send(()).unwrap();
        assert!(matches!(receipt.wait(), Err(Error::CommitUncertain(_))));
        assert!(store.is_fenced());
        assert!(matches!(store.snapshot(), Err(Error::WriterFenced)));
        assert!(matches!(queued.wait(), Err(Error::WriterFenced)));
        assert!(!executed.load(Ordering::Acquire));
        assert!(matches!(store.submit(|_| Ok(())), Err(Error::WriterFenced)));
        store.shutdown().unwrap();
        let reopened = Store::open(&path, options, Catalog::EMPTY).unwrap();
        assert_eq!(reopened.metadata().generation, expected_generation);
        reopened.shutdown().unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn ordinary_empty_submissions_and_both_reclaim_passes_sync() {
        let path = std::env::temp_dir().join(format!(
            "ycoding-store-reclaim-sync-{}.redb",
            std::process::id()
        ));
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        let syncs_until_error = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(std::sync::Mutex::new(None));
        let options = Options {
            cache_bytes: 1024 * 1024,
            queue_capacity: 2,
            max_snapshots: 2,
        };
        let db = Database::builder()
            .set_cache_size(options.cache_bytes)
            .create_with_backend(SyncFault {
                file: redb::backends::FileBackend::new(file).unwrap(),
                syncs_until_error: Arc::clone(&syncs_until_error),
                barrier: Arc::clone(&barrier),
            })
            .unwrap();
        let store = Store::start(
            db,
            options,
            Catalog::EMPTY,
            Some(Metadata::new([9; 16], 1)),
            None,
        )
        .unwrap();
        for pass in 0..3 {
            let (reached, entered) = mpsc::channel();
            let (release, held) = mpsc::channel();
            *barrier.lock().unwrap() = Some((reached, held));
            let receipt = if pass == 0 {
                store.submit(|_| Ok(()))
            } else {
                store.reclaim()
            }
            .unwrap();
            entered.recv_timeout(Duration::from_secs(10)).unwrap();
            release.send(()).unwrap();
            receipt.wait().unwrap();
        }
        syncs_until_error.store(1, Ordering::Release);
        assert!(matches!(
            store.reclaim().unwrap().wait(),
            Err(Error::CommitUncertain(_))
        ));
        assert!(store.is_fenced());
        store.shutdown().unwrap();
        std::fs::remove_file(path).unwrap();
    }

    struct Stamp;
    impl TableSpec for Stamp {
        type Record = u64;
        const NAME: &'static str = "test_stamp";
        const INDEXES: &'static [IndexDefinition] =
            &[IndexDefinition::secondary("test_stamp_value_idx")];
        fn primary_key(row: &u64) -> Vec<u8> {
            row.to_be_bytes().to_vec()
        }
        fn encode(row: &u64) -> Result<Vec<u8>, Error> {
            Ok(row.to_be_bytes().to_vec())
        }
        fn decode(bytes: &[u8]) -> Result<u64, Error> {
            if bytes.len() != 8 {
                return Err(Error::Rejected("stamp codec"));
            }
            Ok(u64::from_be_bytes(bytes.try_into().unwrap()))
        }
        fn index_key(index: &IndexDefinition, row: &u64) -> Result<Option<Vec<u8>>, Error> {
            if index.name != "test_stamp_value_idx" {
                return Err(Error::UnregisteredIndex);
            }
            Ok(Some(row.to_be_bytes().to_vec()))
        }
    }
    struct Other;
    impl TableSpec for Other {
        type Record = u64;
        const NAME: &'static str = "test_other";
        const INDEXES: &'static [IndexDefinition] = &[];
        fn primary_key(row: &u64) -> Vec<u8> {
            row.to_be_bytes().to_vec()
        }
        fn encode(row: &u64) -> Result<Vec<u8>, Error> {
            Ok(row.to_be_bytes().to_vec())
        }
        fn decode(bytes: &[u8]) -> Result<u64, Error> {
            if bytes.len() != 8 {
                return Err(Error::Rejected("other codec"));
            }
            Ok(u64::from_be_bytes(bytes.try_into().unwrap()))
        }
        fn index_key(_: &IndexDefinition, _: &u64) -> Result<Option<Vec<u8>>, Error> {
            Err(Error::UnregisteredIndex)
        }
    }
    const STAMP_CATALOG: Catalog = Catalog::new(
        1,
        &[
            TableDeclaration::of::<Stamp>(),
            TableDeclaration::of::<Other>(),
        ],
    );

    fn disposable_store() -> Store {
        Store::disposable(
            Options {
                cache_bytes: 1024 * 1024,
                queue_capacity: 4,
                max_snapshots: 8,
            },
            STAMP_CATALOG,
            Metadata::new([7; 16], 1),
        )
        .unwrap()
    }

    #[test]
    fn snapshot_statements_bound_each_page_and_keep_the_same_snapshot_and_parent_limit() {
        use std::ops::Bound;

        let store = disposable_store();
        store
            .submit(|tx| tx.put::<Stamp>(&1))
            .unwrap()
            .wait()
            .unwrap();
        let snapshot = store.snapshot().unwrap();
        store
            .submit(|tx| tx.put::<Stamp>(&2))
            .unwrap()
            .wait()
            .unwrap();
        for _ in 0..2 {
            let statement = snapshot.read_statement(1);
            assert_eq!(
                statement.get::<Stamp>(&1_u64.to_be_bytes()).unwrap(),
                Some(1)
            );
            assert!(matches!(
                statement.get::<Stamp>(&2_u64.to_be_bytes()),
                Err(Error::Rejected(
                    "read statement exceeds stored-row work limit"
                ))
            ));
        }
        assert_eq!(
            snapshot
                .read_statement(2)
                .scan::<Stamp>(Bound::Unbounded, Bound::Unbounded, 2)
                .unwrap(),
            vec![1]
        );
        let parent = store.read_statement(1);
        let snapshot = parent.client().snapshot().unwrap();
        assert_eq!(
            snapshot
                .read_statement(1)
                .get::<Stamp>(&1_u64.to_be_bytes())
                .unwrap(),
            Some(1)
        );
        assert!(matches!(
            snapshot
                .read_statement(1)
                .get::<Stamp>(&2_u64.to_be_bytes()),
            Err(Error::Rejected(
                "read statement exceeds stored-row work limit"
            ))
        ));
        assert_eq!(parent.usage().work, 1);
    }

    #[test]
    fn read_statement_keeps_one_bound_across_128_row_pages_and_snapshots() {
        use std::ops::Bound;
        let store = disposable_store();
        store
            .submit(|tx| {
                for row in 0..10_001 {
                    tx.put::<Stamp>(&row)?;
                }
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
        let statement = store.read_statement(10_000);
        let mut after = None;
        for _ in 0..78 {
            let snapshot = statement.client().snapshot().unwrap();
            let rows = snapshot
                .scan::<Stamp>(
                    after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                    Bound::Unbounded,
                    128,
                )
                .unwrap();
            assert_eq!(rows.len(), 128);
            after = rows.last().map(Stamp::primary_key);
        }
        let snapshot = statement.client().snapshot().unwrap();
        assert_eq!(
            snapshot
                .scan::<Stamp>(
                    Bound::Excluded(after.as_deref().unwrap()),
                    Bound::Unbounded,
                    16,
                )
                .unwrap()
                .len(),
            16
        );
        assert!(matches!(
            snapshot.get::<Stamp>(&10_000_u64.to_be_bytes()),
            Err(Error::Rejected(
                "read statement exceeds stored-row work limit"
            ))
        ));
        let usage = statement.usage();
        assert_eq!((usage.work, usage.rows), (10_000, 10_000));
        assert_eq!(
            usage.tables,
            std::collections::BTreeMap::from([(Stamp::NAME, 10_000)])
        );
        assert_eq!(
            store
                .snapshot()
                .unwrap()
                .scan::<Stamp>(Bound::Unbounded, Bound::Unbounded, 10_001)
                .unwrap()
                .len(),
            10_001
        );
    }

    #[test]
    fn read_statement_counts_physical_index_rows_before_output_filtering() {
        use super::{IndexOrder, IndexQuery};
        use std::ops::Bound;
        let store = disposable_store();
        store
            .submit(|tx| tx.put::<Stamp>(&42))
            .unwrap()
            .wait()
            .unwrap();
        let statement = store.read_statement(7);
        let snapshot = statement.client().snapshot().unwrap();
        assert_eq!(
            snapshot
                .index::<Stamp>("test_stamp_value_idx", &42_u64.to_be_bytes(), None, 1)
                .unwrap(),
            [42]
        );
        let query = |order| IndexQuery {
            lower: Bound::Unbounded,
            upper: Bound::Unbounded,
            prefix: None,
            order,
            after: None,
            limit: 1,
        };
        assert_eq!(
            snapshot
                .index_range::<Stamp>("test_stamp_value_idx", query(IndexOrder::Ascending))
                .unwrap()
                .into_iter()
                .filter(|_| false)
                .count(),
            0
        );
        assert_eq!(
            snapshot
                .index_cursors::<Stamp>("test_stamp_value_idx", query(IndexOrder::Descending))
                .unwrap()
                .len(),
            1
        );
        assert_eq!((statement.usage().work, statement.usage().rows), (6, 6));
        assert!(
            snapshot
                .index::<Stamp>("test_stamp_value_idx", &42_u64.to_be_bytes(), None, 1)
                .is_err()
        );
        assert_eq!((statement.usage().work, statement.usage().rows), (7, 7));
        assert_eq!(
            statement.usage().tables,
            std::collections::BTreeMap::from([(Stamp::NAME, 3), ("test_stamp_value_idx", 4)])
        );
    }

    #[test]
    fn read_statement_counts_unique_index_entries_rejected_by_resume() {
        struct Unique;
        impl TableSpec for Unique {
            type Record = u64;
            const NAME: &'static str = "test_unique";
            const INDEXES: &'static [IndexDefinition] =
                &[IndexDefinition::unique("test_unique_value_idx")];
            fn primary_key(row: &u64) -> Vec<u8> {
                Stamp::primary_key(row)
            }
            fn encode(row: &u64) -> Result<Vec<u8>, Error> {
                Stamp::encode(row)
            }
            fn decode(bytes: &[u8]) -> Result<u64, Error> {
                Stamp::decode(bytes)
            }
            fn index_key(_: &IndexDefinition, row: &u64) -> Result<Option<Vec<u8>>, Error> {
                Ok(Some(row.to_be_bytes().to_vec()))
            }
        }
        const UNIQUE_CATALOG: Catalog = Catalog::new(1, &[TableDeclaration::of::<Unique>()]);
        let store =
            Store::disposable(Options::core(), UNIQUE_CATALOG, Metadata::new([8; 16], 1)).unwrap();
        store
            .submit(|tx| tx.put::<Unique>(&1))
            .unwrap()
            .wait()
            .unwrap();
        let mut statement = store.read_statement(2);
        assert_eq!(
            statement
                .client()
                .snapshot()
                .unwrap()
                .index::<Unique>("test_unique_value_idx", &1_u64.to_be_bytes(), None, 1)
                .unwrap(),
            [1]
        );
        assert_eq!((statement.usage().work, statement.usage().rows), (2, 2));
        statement.reset();
        assert!(
            statement
                .client()
                .snapshot()
                .unwrap()
                .index::<Unique>(
                    "test_unique_value_idx",
                    &1_u64.to_be_bytes(),
                    Some(&1_u64.to_be_bytes()),
                    1
                )
                .unwrap()
                .is_empty()
        );
        assert_eq!((statement.usage().work, statement.usage().rows), (1, 1));
        assert_eq!(
            statement.usage().tables,
            std::collections::BTreeMap::from([("test_unique_value_idx", 1)])
        );
    }

    #[test]
    fn read_statement_observes_entries_before_decode_failure_and_counts_misses_as_work() {
        use std::ops::Bound;
        let store = disposable_store();
        store
            .submit(|tx| {
                tx.put::<Stamp>(&1)?;
                tx.transaction
                    .open_table(definition(Stamp::NAME))?
                    .insert(1_u64.to_be_bytes().as_slice(), b"invalid".as_slice())?;
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
        let mut statement = store.read_statement(2);
        let old = statement.client().snapshot().unwrap();
        assert!(old.get::<Stamp>(&2_u64.to_be_bytes()).unwrap().is_none());
        assert!(
            old.scan::<Stamp>(Bound::Excluded(&1_u64.to_be_bytes()), Bound::Unbounded, 128)
                .unwrap()
                .is_empty()
        );
        assert_eq!((statement.usage().work, statement.usage().rows), (2, 0));
        statement.reset();
        assert!(matches!(
            old.get::<Stamp>(&1_u64.to_be_bytes()),
            Err(Error::Rejected(
                "read statement exceeds stored-row work limit"
            ))
        ));
        let snapshot = statement.client().snapshot().unwrap();
        assert!(matches!(
            snapshot.get::<Stamp>(&1_u64.to_be_bytes()),
            Err(Error::Rejected("stamp codec"))
        ));
        assert!(matches!(
            snapshot.scan::<Stamp>(Bound::Unbounded, Bound::Unbounded, 1),
            Err(Error::Rejected("stamp codec"))
        ));
        assert_eq!((statement.usage().work, statement.usage().rows), (2, 2));
    }

    #[test]
    fn read_statement_nested_concurrent_scopes_and_resets_keep_separate_limits() {
        let store = disposable_store();
        store
            .submit(|tx| tx.put::<Stamp>(&1))
            .unwrap()
            .wait()
            .unwrap();
        let parent = store.read_statement(80);
        let mut statement = parent.client().read_statement(64);
        let successes = std::thread::scope(|scope| {
            let handles = (0..4)
                .map(|_| {
                    let client = statement.client().clone();
                    scope.spawn(move || {
                        let snapshot = client.snapshot().unwrap();
                        (0..32)
                            .filter(|_| snapshot.get::<Stamp>(&1_u64.to_be_bytes()).is_ok())
                            .count()
                    })
                })
                .collect::<Vec<_>>();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .sum::<usize>()
        });
        assert_eq!(successes, 64);
        assert_eq!((statement.usage().rows, parent.usage().rows), (64, 64));
        let weak = statement.client().downgrade();
        statement.reset();
        assert_eq!(statement.usage(), super::ReadUsage::default());
        assert!(
            weak.upgrade()
                .unwrap()
                .snapshot()
                .unwrap()
                .get::<Stamp>(&1_u64.to_be_bytes())
                .is_err()
        );
        let snapshot = statement.client().snapshot().unwrap();
        assert_eq!(
            (0..32)
                .filter(|_| snapshot.get::<Stamp>(&1_u64.to_be_bytes()).is_ok())
                .count(),
            16
        );
        assert_eq!((statement.usage().rows, parent.usage().rows), (16, 80));
        assert_eq!(
            store
                .snapshot()
                .unwrap()
                .get::<Stamp>(&1_u64.to_be_bytes())
                .unwrap(),
            Some(1)
        );
        assert_eq!(parent.usage().rows, 80);
    }

    #[test]
    fn read_statement_zero_work_and_dropped_snapshots_preserve_permits_and_commits() {
        let store = disposable_store();
        let statement = store.read_statement(1);
        let (_, snapshot) = statement
            .client()
            .submit_with_snapshot(|tx| tx.put::<Stamp>(&1))
            .unwrap()
            .wait()
            .unwrap();
        assert_eq!(statement.usage(), super::ReadUsage::default());
        assert_eq!(
            snapshot.get::<Stamp>(&1_u64.to_be_bytes()).unwrap(),
            Some(1)
        );
        drop(snapshot);
        for _ in 0..16 {
            let empty = statement.client().snapshot().unwrap();
            assert!(empty.get::<Stamp>(&1_u64.to_be_bytes()).is_err());
        }
        let zero = store.read_statement(0);
        assert!(
            zero.client()
                .snapshot()
                .unwrap()
                .get::<Stamp>(&1_u64.to_be_bytes())
                .is_err()
        );
        assert_eq!(zero.usage(), super::ReadUsage::default());
        assert_eq!(
            store
                .snapshot()
                .unwrap()
                .get::<Stamp>(&1_u64.to_be_bytes())
                .unwrap(),
            Some(1)
        );
        assert_eq!((statement.usage().work, statement.usage().rows), (1, 1));
    }

    #[test]
    fn metadata_index_cursors_match_decoded_bounds_prefix_order_and_resume() {
        use super::{IndexOrder, IndexQuery};
        use crate::{
            KeyPart,
            session::{Event, EventTable},
            tuple_key,
        };
        use std::ops::Bound;
        let store = Store::disposable(
            Options::core(),
            crate::native::catalog(crate::native::DatabaseKind::Core),
            Metadata::new([17; 16], 1),
        )
        .unwrap();
        store
            .submit(|tx| {
                for owner in ["ses_metadata", "ses_other"] {
                    crate::session::reserve_sequence(tx, &owner.into(), 5)?;
                    for seq in 1..=5 {
                        EventTable::insert(
                            tx,
                            &Event {
                                id: format!("evt_{owner}_{seq}").into(),
                                aggregate_id: owner.into(),
                                seq,
                                created: seq,
                                type_: "session.test.1".into(),
                                data: ycoding_schema::JsonValue::Null,
                            },
                        )?;
                    }
                }
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
        let snapshot = store.snapshot().unwrap();
        for name in ["event_aggregate_seq_idx", "event_aggregate_type_seq_idx"] {
            let owner = "ses_metadata".into();
            let kind = "session.test.1".into();
            let mut parts = vec![KeyPart::String(&owner)];
            if name == "event_aggregate_type_seq_idx" {
                parts.push(KeyPart::String(&kind));
            }
            let prefix = tuple_key(&parts);
            parts.push(KeyPart::I64(2));
            let lower = tuple_key(&parts);
            parts.pop();
            parts.push(KeyPart::I64(5));
            let upper = tuple_key(&parts);
            for order in [IndexOrder::Ascending, IndexOrder::Descending] {
                let mut after = None;
                let mut sequences = Vec::new();
                loop {
                    let query = || IndexQuery {
                        lower: Bound::Included(&lower),
                        upper: Bound::Excluded(&upper),
                        prefix: Some(&prefix),
                        order,
                        after: after.as_ref(),
                        limit: 2,
                    };
                    let metadata = snapshot.index_cursors::<EventTable>(name, query()).unwrap();
                    let decoded = snapshot.index_range::<EventTable>(name, query()).unwrap();
                    assert_eq!(
                        metadata,
                        decoded
                            .iter()
                            .map(|entry| entry.cursor.clone())
                            .collect::<Vec<_>>()
                    );
                    sequences.extend(decoded.iter().map(|entry| entry.record.seq));
                    if metadata.is_empty() {
                        break;
                    }
                    after = metadata.last().cloned();
                }
                assert_eq!(
                    sequences,
                    match order {
                        IndexOrder::Ascending => vec![2, 3, 4],
                        IndexOrder::Descending => vec![4, 3, 2],
                    }
                );
                assert!(
                    snapshot
                        .index_cursors::<EventTable>(
                            name,
                            IndexQuery {
                                lower: Bound::Included(&upper),
                                upper: Bound::Excluded(&lower),
                                prefix: Some(&prefix),
                                order,
                                after: None,
                                limit: 0,
                            }
                        )
                        .unwrap()
                        .is_empty()
                );
            }
        }
    }

    #[test]
    fn metadata_index_cursors_do_not_decode_records_or_weaken_decoded_reads() {
        use super::{IndexOrder, IndexQuery};
        use std::ops::Bound;
        let store = disposable_store();
        store
            .submit(|tx| {
                tx.put::<Stamp>(&1)?;
                tx.transaction
                    .open_table(definition(Stamp::NAME))?
                    .insert(1_u64.to_be_bytes().as_slice(), b"invalid".as_slice())?;
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
        let query = || IndexQuery {
            lower: Bound::Unbounded,
            upper: Bound::Unbounded,
            prefix: None,
            order: IndexOrder::Ascending,
            after: None,
            limit: 1,
        };
        let snapshot = store.snapshot().unwrap();
        let metadata = snapshot
            .index_cursors::<Stamp>("test_stamp_value_idx", query())
            .unwrap();
        assert_eq!(metadata[0].logical_key, 1_u64.to_be_bytes());
        assert_eq!(metadata[0].primary_key, 1_u64.to_be_bytes());
        assert_eq!(
            snapshot.reads(),
            std::collections::BTreeSet::from([Stamp::NAME])
        );
        assert!(
            snapshot
                .index_range::<Stamp>("test_stamp_value_idx", query())
                .is_err()
        );
        drop(snapshot);
        store
            .submit(|tx| {
                tx.transaction.open_table(definition(Stamp::NAME))?.insert(
                    1_u64.to_be_bytes().as_slice(),
                    2_u64.to_be_bytes().as_slice(),
                )?;
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
        let snapshot = store.snapshot().unwrap();
        assert_eq!(
            snapshot
                .index_cursors::<Stamp>("test_stamp_value_idx", query())
                .unwrap()
                .len(),
            1
        );
        assert!(
            snapshot
                .index_range::<Stamp>("test_stamp_value_idx", query())
                .is_err()
        );
        drop(snapshot);
        store
            .submit(|tx| {
                tx.transaction
                    .open_table(definition(Stamp::NAME))?
                    .remove(1_u64.to_be_bytes().as_slice())?;
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
        assert!(
            store
                .snapshot()
                .unwrap()
                .index_cursors::<Stamp>("test_stamp_value_idx", query())
                .is_err()
        );
    }

    #[test]
    fn versions_stay_current_until_a_read_or_declared_table_changes() {
        let store = disposable_store();
        let put = |store: &Store, value: u64, other: bool| {
            store
                .submit(move |tx| {
                    if other {
                        return tx.put::<Other>(&value);
                    }
                    tx.put::<Stamp>(&value)
                })
                .unwrap()
                .wait()
                .unwrap();
        };
        let read = store.snapshot().unwrap();
        read.get::<Stamp>(&1_u64.to_be_bytes()).unwrap();
        let tracked = read.versions(&[]).unwrap();
        let declared = store.snapshot().unwrap().versions(&[Other::NAME]).unwrap();
        let unread = store.snapshot().unwrap().versions(&[]).unwrap();
        put(&store, 1, true);
        let current = store.snapshot().unwrap();
        assert!(tracked.current(&current));
        assert!(store.client().versions_current(&tracked));
        assert!(!store.client().versions_current(&declared));
        assert!(!declared.current(&current));
        assert!(unread.current(&current));
        put(&store, 2, false);
        let current = store.snapshot().unwrap();
        assert!(!tracked.current(&current));
        assert!(!store.client().versions_current(&tracked));
        assert!(unread.current(&current));
        let other = disposable_store();
        assert!(!other.client().versions_current(&unread));
        assert!(!unread.current(&other.snapshot().unwrap()));
    }

    #[test]
    fn snapshot_views_track_committed_content_not_empty_transactions() {
        let store = disposable_store();
        let view = |store: &Store| store.snapshot().unwrap().view().unwrap().clone();
        let first = view(&store);
        assert!(first.same(&view(&store)));
        store.submit(|_| Ok(())).unwrap().wait().unwrap();
        assert!(first.same(&view(&store)));
        let read = store
            .submit(|tx| tx.get::<Stamp>(&1_u64.to_be_bytes()))
            .unwrap()
            .wait()
            .unwrap();
        assert_eq!(read, None);
        assert!(first.same(&view(&store)));
        let removed = store
            .submit(|tx| tx.delete::<Stamp>(&1_u64.to_be_bytes()))
            .unwrap()
            .wait()
            .unwrap();
        assert!(!removed);
        assert!(first.same(&view(&store)));
        let (_, snapshot) = store
            .submit_with_snapshot(|_| Ok(()))
            .unwrap()
            .wait()
            .unwrap();
        assert!(first.same(snapshot.view().unwrap()));
        store
            .submit(|tx| tx.put::<Stamp>(&1))
            .unwrap()
            .wait()
            .unwrap();
        let committed = view(&store);
        assert!(!first.same(&committed));
        store
            .submit(|tx| tx.put::<Stamp>(&1))
            .unwrap()
            .wait()
            .unwrap();
        let rewritten = view(&store);
        assert!(!committed.same(&rewritten));
        let rejected = store
            .submit(|tx| {
                tx.put::<Stamp>(&2)?;
                Err::<(), _>(Error::Rejected("abort without commit"))
            })
            .unwrap()
            .wait();
        assert!(rejected.is_err());
        assert!(rewritten.same(&view(&store)));
        assert_eq!(
            store
                .snapshot()
                .unwrap()
                .get::<Stamp>(&2_u64.to_be_bytes())
                .unwrap(),
            None
        );
        let removed = store
            .submit(|tx| tx.delete::<Stamp>(&1_u64.to_be_bytes()))
            .unwrap()
            .wait()
            .unwrap();
        assert!(removed);
        let deleted = view(&store);
        assert!(!rewritten.same(&deleted));
        let removed = store
            .submit(|tx| tx.delete::<Stamp>(&1_u64.to_be_bytes()))
            .unwrap()
            .wait()
            .unwrap();
        assert!(!removed);
        assert!(deleted.same(&view(&store)));
        let (_, snapshot) = store
            .submit_with_snapshot(|tx| tx.put::<Stamp>(&3))
            .unwrap()
            .wait()
            .unwrap();
        let stamped = snapshot.view().unwrap().clone();
        assert!(!deleted.same(&stamped));
        assert!(stamped.same(&view(&store)));
        store.shutdown().unwrap();

        let reopened = disposable_store();
        let other = reopened.snapshot().unwrap().view().unwrap().clone();
        assert_eq!(other.epoch, first.epoch);
        assert!(!other.same(&first));
        reopened.client.0.stamp.epoch.store(1, Ordering::SeqCst);
        assert!(reopened.snapshot().unwrap().view().is_none());
        reopened.client.0.stamp.epoch.store(2, Ordering::SeqCst);
        assert_eq!(reopened.snapshot().unwrap().view().unwrap().epoch, 2);
        reopened.shutdown().unwrap();
    }

    #[test]
    fn snapshot_read_sets_track_typed_reads_and_only_read_tables_gate_views() {
        use super::{IndexOrder, IndexQuery};
        use std::collections::BTreeSet;
        use std::ops::Bound;

        let store = disposable_store();
        store
            .submit(|tx| {
                tx.put::<Stamp>(&1)?;
                tx.put::<Stamp>(&2)
            })
            .unwrap()
            .wait()
            .unwrap();
        let snapshot = store.snapshot().unwrap();
        let reads = BTreeSet::from(["test_stamp"]);
        assert_eq!(
            snapshot.get::<Stamp>(&1_u64.to_be_bytes()).unwrap(),
            Some(1)
        );
        assert_eq!(snapshot.reads(), reads);
        snapshot.reset_reads();
        assert_eq!(
            snapshot
                .scan::<Stamp>(Bound::Unbounded, Bound::Unbounded, 10)
                .unwrap(),
            vec![1, 2]
        );
        assert_eq!(snapshot.reads(), reads);
        snapshot.reset_reads();
        assert_eq!(
            snapshot
                .index::<Stamp>("test_stamp_value_idx", &1_u64.to_be_bytes(), None, 10)
                .unwrap(),
            vec![1]
        );
        assert_eq!(snapshot.reads(), reads);
        snapshot.reset_reads();
        assert_eq!(
            snapshot
                .index_range::<Stamp>(
                    "test_stamp_value_idx",
                    IndexQuery {
                        lower: Bound::Unbounded,
                        upper: Bound::Unbounded,
                        prefix: None,
                        order: IndexOrder::Ascending,
                        after: None,
                        limit: 10,
                    },
                )
                .unwrap()
                .len(),
            2
        );
        assert_eq!(snapshot.reads(), reads);
        snapshot.reset_reads();
        assert!(snapshot.reads().is_empty());
        snapshot.get::<Stamp>(&1_u64.to_be_bytes()).unwrap();
        assert_eq!(snapshot.reads(), reads);
        let staged = snapshot.view().unwrap().clone();
        drop(snapshot);
        let view = |store: &Store| store.snapshot().unwrap().view().unwrap().clone();
        assert!(staged.same_reads(&view(&store), &reads));
        store
            .submit(|tx| tx.put::<Other>(&1))
            .unwrap()
            .wait()
            .unwrap();
        let unrelated = view(&store);
        assert!(!staged.same(&unrelated));
        assert!(staged.same_reads(&unrelated, &reads));
        assert!(!staged.same_reads(&unrelated, &BTreeSet::from(["test_other"])));
        assert!(!staged.same_reads(&unrelated, &BTreeSet::from(["missing_table"])));
        store
            .submit(|tx| tx.put::<Stamp>(&3))
            .unwrap()
            .wait()
            .unwrap();
        assert!(!staged.same_reads(&view(&store), &reads));
        let before_delete = view(&store);
        let removed = store
            .submit(|tx| tx.delete::<Other>(&1_u64.to_be_bytes()))
            .unwrap()
            .wait()
            .unwrap();
        assert!(removed);
        let after_delete = view(&store);
        assert!(!before_delete.same_reads(&after_delete, &BTreeSet::from(["test_other"])));
        assert!(before_delete.same_reads(&after_delete, &reads));
        store.shutdown().unwrap();

        let reopened = disposable_store();
        assert!(!staged.same_reads(&view(&reopened), &reads));
        assert!(!staged.same_reads(&view(&reopened), &BTreeSet::new()));
        reopened.shutdown().unwrap();
    }

    #[test]
    fn snapshot_taken_during_commit_is_uncacheable() {
        let path = std::env::temp_dir().join(format!(
            "ycoding-store-commit-epoch-{}.redb",
            std::process::id()
        ));
        let barrier = Arc::new(std::sync::Mutex::new(None));
        let backend = SyncFault {
            file: redb::backends::FileBackend::new(
                OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create_new(true)
                    .open(&path)
                    .unwrap(),
            )
            .unwrap(),
            syncs_until_error: Arc::new(AtomicUsize::new(0)),
            barrier: Arc::clone(&barrier),
        };
        let options = Options {
            cache_bytes: 1024 * 1024,
            queue_capacity: 2,
            max_snapshots: 4,
        };
        let db = Database::builder()
            .set_cache_size(options.cache_bytes)
            .create_with_backend(backend)
            .unwrap();
        let store = Store::start(
            db,
            options,
            STAMP_CATALOG,
            Some(Metadata::new([9; 16], 1)),
            None,
        )
        .unwrap();
        let before = store.snapshot().unwrap().view().unwrap().clone();
        let (reached, entered) = mpsc::channel();
        let (release, held) = mpsc::channel();
        *barrier.lock().unwrap() = Some((reached, held));
        let receipt = store.submit(|tx| tx.put::<Stamp>(&1)).unwrap();
        entered.recv_timeout(Duration::from_secs(10)).unwrap();
        let during = store.snapshot().unwrap();
        assert!(during.view().is_none());
        drop(during);
        release.send(()).unwrap();
        receipt.wait().unwrap();
        let after = store.snapshot().unwrap().view().unwrap().clone();
        assert!(!before.same(&after));
        store.shutdown().unwrap();
        std::fs::remove_file(path).unwrap();
    }
}
