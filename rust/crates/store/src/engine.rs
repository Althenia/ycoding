use crate::catalog::{definition, index_definition};
use crate::metadata::{bootstrap, commit_error};
use crate::session::Event;
use crate::{Catalog, Error, IndexDefinition, KeyPart, Metadata, TableSpec, tuple_key};
use redb::{
    Database, Durability, ReadTransaction, ReadableDatabase, ReadableTable, WriteTransaction,
};
use std::fs::OpenOptions;
use std::future::Future;
use std::marker::PhantomData;
use std::ops::{Bound, Deref};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::pin::Pin;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
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
pub struct Client(Arc<Shared>);

type EventObserver = Box<dyn Fn(&[Event]) -> bool + Send + Sync>;

#[derive(Default)]
struct Observers(Mutex<Vec<EventObserver>>);

impl Observers {
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
    analytics: Mutex<crate::analytics::Link>,
    observers: Arc<Observers>,
    database: Mutex<Option<Arc<Database>>>,
    sender: Mutex<Option<mpsc::SyncSender<Request>>>,
    writer: ThreadId,
    closed: AtomicBool,
    fenced: Arc<AtomicBool>,
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
            .open(path)?;
        Self::start(
            Database::builder()
                .set_cache_size(options.cache_bytes)
                .create_file(file)?,
            options,
            catalog,
            Some(metadata),
        )
    }

    pub fn open(path: impl AsRef<Path>, options: Options, catalog: Catalog) -> Result<Self, Error> {
        options.validate()?;
        catalog.validate()?;
        Self::start(
            Database::builder()
                .set_cache_size(options.cache_bytes)
                .open(path)?,
            options,
            catalog,
            None,
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
        )
    }

    fn start(
        database: Database,
        options: Options,
        catalog: Catalog,
        initial: Option<Metadata>,
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
            client: Client(Arc::new(Shared {
                analytics: Mutex::default(),
                observers: Arc::default(),
                database: Mutex::new(Some(database)),
                sender: Mutex::new(Some(sender)),
                writer: writer.thread().id(),
                closed: AtomicBool::new(false),
                fenced,
                snapshots: Arc::new(AtomicUsize::new(0)),
                options,
                catalog,
                metadata,
            })),
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
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
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
        self.submit_operation(move |db, fenced, metadata| {
            let value = transact(db, catalog, fenced, metadata, &observers, operation)?;
            Ok((
                value,
                Snapshot {
                    read: db.begin_read()?,
                    _permit: permit,
                    _database: database,
                    catalog,
                },
            ))
        })
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

    pub fn submit<R, F>(&self, operation: F) -> Result<Receipt<R>, Error>
    where
        R: Send + 'static,
        F: FnOnce(&mut Write<'_>) -> Result<R, Error> + Send + 'static,
    {
        let catalog = self.0.catalog;
        let observers = Arc::clone(&self.0.observers);
        self.submit_operation(move |database, fenced, metadata| {
            transact(database, catalog, fenced, metadata, &observers, operation)
        })
    }

    pub fn observe_events(&self, observer: impl Fn(&[Event]) -> bool + Send + Sync + 'static) {
        self.0
            .observers
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(Box::new(observer));
    }

    fn submit_operation<R: Send + 'static>(
        &self,
        operation: impl FnOnce(&Database, &AtomicBool, &Metadata) -> Result<R, Error> + Send + 'static,
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
        Ok(Receipt { completion, writer })
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
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < self.0.options.max_snapshots).then_some(count + 1)
            })
            .map_err(|_| Error::SnapshotLimit)?;
        let permit = SnapshotPermit(Arc::clone(&self.0.snapshots));
        Ok(Snapshot {
            read: database.begin_read()?,
            _permit: permit,
            _database: Arc::clone(database),
            catalog: self.0.catalog,
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
        if !state.started {
            state.cancelled = true;
        }
        state.waker = None;
    }
}

fn transact<R>(
    database: &Database,
    catalog: Catalog,
    fenced: &AtomicBool,
    metadata: &Metadata,
    observers: &Observers,
    operation: impl FnOnce(&mut Write<'_>) -> Result<R, Error>,
) -> Result<R, Error> {
    let mut transaction = database.begin_write().inspect_err(|_| {
        fenced.store(true, Ordering::Release);
    })?;
    transaction.set_durability(Durability::Immediate)?;
    let mut write = Write {
        transaction: &transaction,
        metadata,
        catalog,
        failed: false,
        rejection: None,
        events: Vec::new(),
        remaining_work: TRANSACTION_WORK,
    };
    let result = catch_unwind(AssertUnwindSafe(|| operation(&mut write)));
    let failed = write.failed;
    let rejection = write.rejection.take();
    let events = std::mem::take(&mut write.events);
    match result {
        Ok(Ok(value)) if !failed => match transaction.commit() {
            Ok(()) => {
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
        },
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

    pub fn put<T: TableSpec>(&mut self, record: &T::Record) -> Result<(), Error> {
        self.work(1)?;
        let result = self.put_inner::<T>(record);
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
            Ok(true)
        })();
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

fn index_storage_key(index: &IndexDefinition, key: &[u8], primary: &[u8]) -> Vec<u8> {
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

pub struct Snapshot {
    read: ReadTransaction,
    _permit: SnapshotPermit,
    _database: Arc<Database>,
    catalog: Catalog,
}

impl Snapshot {
    pub fn index_range<T: TableSpec>(
        &self,
        name: &str,
        query: IndexQuery<'_>,
    ) -> Result<Vec<IndexEntry<T::Record>>, Error> {
        self.catalog.require::<T>()?;
        let index = index_definition::<T>(name)?;
        read_index_range::<T>(
            &self.read.open_table(definition(T::NAME))?,
            &self.read.open_table(definition(index.name))?,
            index,
            query,
        )
    }

    pub fn get<T: TableSpec>(&self, key: &[u8]) -> Result<Option<T::Record>, Error> {
        self.catalog.require::<T>()?;
        self.read
            .open_table(definition(T::NAME))?
            .get(key)?
            .map(|value| decode_record::<T>(key, value.value()))
            .transpose()
    }

    pub fn scan<T: TableSpec>(
        &self,
        lower: Bound<&[u8]>,
        upper: Bound<&[u8]>,
        limit: usize,
    ) -> Result<Vec<T::Record>, Error> {
        self.catalog.require::<T>()?;
        self.read
            .open_table(definition(T::NAME))?
            .range::<&[u8]>((lower, upper))?
            .take(limit)
            .map(|entry| {
                let (key, value) = entry?;
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
        self.catalog.require::<T>()?;
        let index = index_definition::<T>(name)?;
        read_index::<T>(
            &self.read.open_table(definition(T::NAME))?,
            &self.read.open_table(definition(index.name))?,
            index,
            key,
            after_primary,
            limit,
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
) -> Result<Vec<T::Record>, Error> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    if index.unique {
        let Some(primary) = table.get(key)? else {
            return Ok(Vec::new());
        };
        if after_primary.is_some_and(|after| primary.value() <= after) {
            return Ok(Vec::new());
        }
        return Ok(vec![index_record::<T>(
            records,
            index,
            key,
            primary.value(),
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
    table
        .range::<&[u8]>((lower, Bound::Excluded(end.as_slice())))?
        .take(limit)
        .map(|entry| {
            let (storage_key, primary) = entry?;
            if storage_key.value() != index_storage_key(index, key, primary.value()) {
                return Err(Error::Incompatible("index primary tiebreak mismatch"));
            }
            index_record::<T>(records, index, key, primary.value())
        })
        .collect()
}

fn read_index_range<T: TableSpec>(
    records: &impl ReadableTable<&'static [u8], &'static [u8]>,
    table: &impl ReadableTable<&'static [u8], &'static [u8]>,
    index: &IndexDefinition,
    query: IndexQuery<'_>,
) -> Result<Vec<IndexEntry<T::Record>>, Error> {
    if query.limit == 0 {
        return Ok(Vec::new());
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
        return Ok(Vec::new());
    }
    let mut range = table.range::<&[u8]>((
        lower.as_ref().map(Vec::as_slice),
        upper.as_ref().map(Vec::as_slice),
    ))?;
    std::iter::from_fn(|| match query.order {
        IndexOrder::Ascending => range.next(),
        IndexOrder::Descending => range.next_back(),
    })
    .take(query.limit)
    .map(|entry| {
        let (storage_key, primary) = entry?;
        let value = records
            .get(primary.value())?
            .ok_or(Error::Incompatible("dangling index entry"))?;
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
) -> Result<T::Record, Error> {
    let value = records
        .get(primary)?
        .ok_or(Error::Incompatible("dangling index entry"))?;
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
    use crate::{Catalog, Error, Metadata};
    use redb::{Database, StorageBackend};
    use std::fs::OpenOptions;
    use std::io;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, mpsc};
    use std::time::Duration;

    #[derive(Debug)]
    struct SyncFault {
        file: redb::backends::FileBackend,
        armed: Arc<AtomicBool>,
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
            if self.armed.swap(false, Ordering::AcqRel) {
                return Err(io::Error::other(
                    "injected post-fsync acknowledgement failure",
                ));
            }
            Ok(())
        }
    }

    #[test]
    fn durable_commit_ack_failure_fences_queued_operations_without_replay() {
        let path = std::env::temp_dir().join(format!(
            "ycoding-store-sync-fault-{}.redb",
            std::process::id()
        ));
        let armed = Arc::new(AtomicBool::new(false));
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
            armed: Arc::clone(&armed),
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
        let store =
            Store::start(db, options, Catalog::EMPTY, Some(Metadata::new([9; 16], 1))).unwrap();
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
        armed.store(true, Ordering::Release);
        release.send(()).unwrap();
        assert!(matches!(receipt.wait(), Err(Error::CommitUncertain(_))));
        assert!(store.is_fenced());
        assert!(matches!(queued.wait(), Err(Error::WriterFenced)));
        assert!(!executed.load(Ordering::Acquire));
        assert!(matches!(store.submit(|_| Ok(())), Err(Error::WriterFenced)));
        store.shutdown().unwrap();
        let reopened = Store::open(&path, options, Catalog::EMPTY).unwrap();
        assert_eq!(reopened.metadata().generation, 2);
        reopened.shutdown().unwrap();
        std::fs::remove_file(path).unwrap();
    }
}
