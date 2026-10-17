use super::memory::{self, History, Peak};
use ring::digest;
use serde_json::{Map, Value, json};
use std::{
    collections::{HashMap, HashSet},
    fmt, fs, io,
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex, MutexGuard, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{oneshot, watch};

#[cfg(all(test, unix))]
#[path = "queue/tests.rs"]
mod tests;

const BACKSTOP: Duration = Duration::from_secs(2);
const HEARTBEAT: Duration = Duration::from_secs(1);
const STALE_HEARTBEATS: i64 = 5;
const TORN_MS: i64 = 5_000;
const SAMPLE_TIMEOUT: Duration = Duration::from_secs(1);
const SUBPROCESS_DEADLINE: Duration = Duration::from_millis(900);
const LOAD_HALF_LIFE_MS: f64 = 60_000.0;
const MIB: f64 = 1024.0 * 1024.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Limits {
    pub max_running: usize,
    pub max_running_per_session: usize,
    pub max_queued_per_session: usize,
    pub memory_reserve_mb: u64,
    pub max_load: f64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_running: 10,
            max_running_per_session: 1,
            max_queued_per_session: 16,
            memory_reserve_mb: 2_048,
            max_load: 1.0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample {
    pub available_mb: f64,
    pub load: f64,
}

pub type Sampler = Arc<dyn Fn() -> Option<Sample> + Send + Sync>;
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
pub type Wake = Arc<dyn Fn() + Send + Sync>;
pub type Resident = Arc<dyn Fn() -> f64 + Send + Sync>;
type EnqueueReceipt = (
    usize,
    watch::Receiver<usize>,
    oneshot::Receiver<Result<(), EntryLost>>,
);

#[derive(Clone)]
pub struct Options {
    pub directory: PathBuf,
    pub sample: Sampler,
    pub backstop: Duration,
    pub heartbeat: Duration,
    pub now: Clock,
    pub parallelism: usize,
}

impl Options {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
            sample: Arc::new(host_sample),
            backstop: BACKSTOP,
            heartbeat: HEARTBEAT,
            now: Arc::new(wall_ms),
            parallelism: thread::available_parallelism().map_or(1, usize::from),
        }
    }
}

pub trait FamilyReservation: Send {
    fn commit(&self);
    fn release(&self);
}

pub trait Admission: Send + Sync {
    fn family(&self) -> &str;
    fn acquire(&self) -> Option<Box<dyn FamilyReservation>>;
    fn subscribe(&self, wake: Wake) -> Box<dyn FnOnce() + Send>;
}

#[derive(Clone)]
pub struct Request {
    pub id: String,
    pub session_id: String,
    pub command: String,
    pub cwd: PathBuf,
    pub admission: Option<Arc<dyn Admission>>,
    pub memory_limit_mb: Option<u64>,
    pub resident_mb: Option<Resident>,
    pub limits: Limits,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Full {
    pub limit: usize,
}

impl fmt::Display for Full {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "The shell queue already holds {} waiting commands for this Session. Wait for a queued command to start before queueing another.",
            self.limit
        )
    }
}

impl std::error::Error for Full {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntryLost {
    pub id: String,
}

impl fmt::Display for EntryLost {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "The shell queue entry {} was removed before it was admitted",
            self.id
        )
    }
}

impl std::error::Error for EntryLost {}

#[derive(Debug)]
pub enum Error {
    Full(Full),
    Io(io::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Full(full) => full.fmt(f),
            Self::Io(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for Error {}

impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct EntryView {
    pub id: String,
    pub session_id: String,
    pub reserve_mb: f64,
    pub admitted: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Slots {
    run: usize,
    session: usize,
}

#[derive(Clone, Debug, PartialEq)]
struct Entry {
    id: String,
    owner: String,
    session_id: String,
    enqueued: i64,
    reserve_mb: f64,
    max_running: usize,
    max_running_per_session: usize,
    max_load: f64,
    capacity_blocked: Option<String>,
    retiring: bool,
    admitted: Option<(i64, Slots)>,
}

impl Entry {
    fn encode(&self) -> String {
        let mut object = Map::new();
        object.insert("id".into(), json!(self.id));
        object.insert("owner".into(), json!(self.owner));
        object.insert("sessionID".into(), json!(self.session_id));
        object.insert("enqueued".into(), json!(self.enqueued));
        object.insert("reserveMb".into(), json!(self.reserve_mb));
        object.insert("maxRunning".into(), json!(self.max_running));
        object.insert(
            "maxRunningPerSession".into(),
            json!(self.max_running_per_session),
        );
        object.insert("maxLoad".into(), json!(self.max_load));
        if let Some(epoch) = &self.capacity_blocked {
            object.insert("capacityBlocked".into(), json!(epoch));
        }
        if self.retiring {
            object.insert("retiring".into(), json!(true));
        }
        if let Some((at, slots)) = self.admitted {
            object.insert("admitted".into(), json!(at));
            object.insert(
                "slots".into(),
                json!({"run": slots.run, "session": slots.session}),
            );
        }
        Value::Object(object).to_string()
    }

    fn decode(text: &str) -> Option<Self> {
        let value: Value = serde_json::from_str(text).ok()?;
        let string = |key: &str| value.get(key)?.as_str().map(str::to_owned);
        let number = |key: &str| value.get(key)?.as_f64().filter(|value| value.is_finite());
        let admitted = match value.get("admitted") {
            None => None,
            Some(at) => {
                let slots = value.get("slots")?;
                Some((
                    at.as_f64().filter(|at| at.is_finite())? as i64,
                    Slots {
                        run: slots.get("run")?.as_u64()? as usize,
                        session: slots.get("session")?.as_u64()? as usize,
                    },
                ))
            }
        };
        Some(Self {
            id: string("id")?,
            owner: string("owner")?,
            session_id: string("sessionID")?,
            enqueued: number("enqueued")? as i64,
            reserve_mb: number("reserveMb")?,
            max_running: number("maxRunning")? as usize,
            max_running_per_session: number("maxRunningPerSession")? as usize,
            max_load: number("maxLoad")?,
            capacity_blocked: match value.get("capacityBlocked") {
                None => None,
                Some(epoch) => Some(epoch.as_str()?.to_owned()),
            },
            retiring: value.get("retiring").is_some_and(|flag| flag == true),
            admitted,
        })
    }
}

struct Held {
    path: PathBuf,
    _file: fs::File,
}

impl Drop for Held {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

struct Claimed {
    files: Vec<Held>,
    family: Option<Box<dyn FamilyReservation>>,
}

impl Drop for Claimed {
    fn drop(&mut self) {
        if let Some(family) = self.family.take() {
            family.release();
        }
    }
}

struct Owned {
    entry: Entry,
    waiting: Option<Held>,
    running: Option<Claimed>,
    unsubscribe: Option<Box<dyn FnOnce() + Send>>,
}

struct Waiter {
    request: Request,
    entry: Entry,
    generation: u64,
    position: usize,
    positions: watch::Sender<usize>,
    admitted: Option<oneshot::Sender<Result<(), EntryLost>>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Identity(u64, u64);

struct Registration {
    _owner: fs::File,
    owner: Identity,
    entries: Identity,
}

struct Beat {
    mtime: i64,
    heartbeat_ms: i64,
    resident: HashMap<String, f64>,
}

#[derive(Default)]
struct State {
    waiters: HashMap<String, Waiter>,
    owned: HashMap<String, Owned>,
    residents: HashMap<String, Resident>,
    published: HashSet<String>,
    registration: Option<Registration>,
    missing_owners: HashMap<String, i64>,
    beats: HashMap<String, Beat>,
    generation: u64,
}

#[derive(Default)]
struct Signal {
    flag: Mutex<bool>,
    changed: Condvar,
}

impl Signal {
    fn notify(&self) {
        *lock(&self.flag) = true;
        self.changed.notify_all();
    }
}

struct Inner {
    token: String,
    dir: PathBuf,
    entries_dir: PathBuf,
    owners_dir: PathBuf,
    slots_dir: PathBuf,
    lanes_dir: PathBuf,
    admission_file: PathBuf,
    owner_file: PathBuf,
    options: Options,
    history: History,
    state: Mutex<State>,
    registering: Mutex<()>,
    evaluating: Mutex<()>,
    writing: Mutex<()>,
    revision: AtomicU64,
    stop: AtomicBool,
    signal: Signal,
    activity: Signal,
}

struct Handle {
    inner: Arc<Inner>,
    threads: Mutex<Vec<thread::JoinHandle<()>>>,
}

impl Drop for Handle {
    fn drop(&mut self) {
        self.inner.stop.store(true, Ordering::SeqCst);
        self.inner.signal.notify();
        self.inner.activity.notify();
    }
}

#[derive(Clone)]
pub struct Queue(Arc<Handle>);

pub struct Ticket {
    handle: Arc<Handle>,
    id: String,
    position: usize,
    positions: watch::Receiver<usize>,
    admitted: Option<oneshot::Receiver<Result<(), EntryLost>>>,
}

impl Queue {
    pub async fn open(options: Options) -> io::Result<Self> {
        let inner = Arc::new(Inner::new(options));
        inner.register()?;
        let evaluator = {
            let inner = inner.clone();
            thread::Builder::new()
                .name("shell-queue-evaluator".into())
                .spawn(move || inner.evaluate_loop())?
        };
        let heartbeat = {
            let inner = inner.clone();
            thread::Builder::new()
                .name("shell-queue-heartbeat".into())
                .spawn(move || inner.heartbeat_loop())?
        };
        Ok(Self(Arc::new(Handle {
            inner,
            threads: Mutex::new(vec![evaluator, heartbeat]),
        })))
    }

    pub async fn enqueue(&self, request: Request) -> Result<Ticket, Error> {
        let (position, positions, admitted) = self.0.inner.enqueue(request.clone())?;
        Ok(Ticket {
            handle: self.0.clone(),
            id: request.id,
            position,
            positions,
            admitted: Some(admitted),
        })
    }

    pub fn record_peak(&self, peak: Peak) -> io::Result<()> {
        let recorded = self.0.inner.history.record(&peak);
        self.0.inner.wake();
        recorded
    }

    pub fn entries(&self) -> io::Result<Vec<EntryView>> {
        let names = match fs::read_dir(&self.0.inner.entries_dir) {
            Ok(names) => names,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut views = Vec::new();
        for name in names {
            let path = name?.path();
            if path.extension().is_none_or(|extension| extension != "json") {
                continue;
            }
            let Ok(text) = fs::read_to_string(&path) else {
                continue;
            };
            if let Some(entry) = Entry::decode(&text).filter(|entry| !entry.retiring) {
                views.push(EntryView {
                    id: entry.id,
                    session_id: entry.session_id,
                    reserve_mb: entry.reserve_mb,
                    admitted: entry.admitted.is_some(),
                });
            }
        }
        Ok(views)
    }

    pub async fn shutdown(&self) {
        self.0.inner.stop.store(true, Ordering::SeqCst);
        self.0.inner.signal.notify();
        self.0.inner.activity.notify();
        let threads = std::mem::take(&mut *lock(&self.0.threads));
        let _ = tokio::task::spawn_blocking(move || {
            for thread in threads {
                let _ = thread.join();
            }
        })
        .await;
    }
}

impl Ticket {
    pub fn position(&self) -> usize {
        self.position
    }

    pub async fn admitted(
        &mut self,
        mut on_position: impl FnMut(usize) + Send,
    ) -> Result<(), EntryLost> {
        let Some(mut admitted) = self.admitted.take() else {
            return Ok(());
        };
        let current = *self.positions.borrow_and_update();
        if current != self.position {
            on_position(current);
        }
        let lost = || EntryLost {
            id: self.id.clone(),
        };
        let mut watching = true;
        loop {
            tokio::select! {
                result = &mut admitted => return result.unwrap_or_else(|_| Err(lost())),
                changed = self.positions.changed(), if watching => {
                    if changed.is_ok() {
                        on_position(*self.positions.borrow_and_update());
                    } else {
                        watching = false;
                    }
                }
            }
        }
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        self.handle.inner.release(&self.id);
    }
}

impl Inner {
    fn new(options: Options) -> Self {
        let dir = options.directory.clone();
        let token = memory::random_uuid().unwrap_or_else(|_| format!("{:x}", wall_ms()));
        Self {
            entries_dir: dir.join("entries"),
            owners_dir: dir.join("owners"),
            slots_dir: dir.join("slots"),
            lanes_dir: dir.join("lanes"),
            admission_file: dir.join("admission"),
            owner_file: dir.join("owners").join(format!("{token}.lock")),
            history: History::new(&dir),
            dir,
            token,
            options,
            state: Mutex::new(State::default()),
            registering: Mutex::new(()),
            evaluating: Mutex::new(()),
            writing: Mutex::new(()),
            revision: AtomicU64::new(0),
            stop: AtomicBool::new(false),
            signal: Signal::default(),
            activity: Signal::default(),
        }
    }

    fn now(&self) -> i64 {
        (self.options.now)()
    }

    fn wake(&self) {
        self.revision.fetch_add(1, Ordering::SeqCst);
        self.signal.notify();
    }

    fn entry_file(&self, id: &str) -> PathBuf {
        self.entries_dir.join(format!("{id}.json"))
    }

    fn heartbeat_ms(&self) -> i64 {
        self.options.heartbeat.as_millis() as i64
    }

    fn evaluate_loop(self: Arc<Self>) {
        while !self.stop.load(Ordering::SeqCst) {
            let waiting = !lock(&self.state).waiters.is_empty();
            {
                let mut flag = lock(&self.signal.flag);
                if waiting {
                    flag = self
                        .signal
                        .changed
                        .wait_timeout_while(flag, self.options.backstop, |flag| {
                            !*flag && !self.stop.load(Ordering::SeqCst)
                        })
                        .unwrap_or_else(|error| error.into_inner())
                        .0;
                } else {
                    flag = self
                        .signal
                        .changed
                        .wait_while(flag, |flag| !*flag && !self.stop.load(Ordering::SeqCst))
                        .unwrap_or_else(|error| error.into_inner());
                }
                *flag = false;
            }
            if self.stop.load(Ordering::SeqCst) {
                return;
            }
            self.pass();
        }
    }

    fn heartbeat_loop(self: Arc<Self>) {
        while !self.stop.load(Ordering::SeqCst) {
            let owned = !lock(&self.state).owned.is_empty();
            if owned {
                if let Err(error) = self.register() {
                    tracing::warn!(%error, "shell queue registration failed");
                }
                if !self.heartbeat() {
                    self.wake();
                }
            }
            let mut flag = lock(&self.activity.flag);
            flag = if owned {
                self.activity
                    .changed
                    .wait_timeout_while(flag, self.options.heartbeat, |flag| {
                        !*flag && !self.stop.load(Ordering::SeqCst)
                    })
                    .unwrap_or_else(|error| error.into_inner())
                    .0
            } else {
                self.activity
                    .changed
                    .wait_while(flag, |flag| !*flag && !self.stop.load(Ordering::SeqCst))
                    .unwrap_or_else(|error| error.into_inner())
            };
            *flag = false;
        }
    }

    fn resident_of(&self, id: &str) -> f64 {
        let probe = lock(&self.state).residents.get(id).cloned();
        probe
            .map(|probe| probe())
            .filter(|value| value.is_finite())
            .map_or(0.0, |value| value.max(0.0))
    }

    fn heartbeat(&self) -> bool {
        let admitted: Vec<String> = lock(&self.state)
            .owned
            .values()
            .filter(|owned| owned.entry.admitted.is_some())
            .map(|owned| owned.entry.id.clone())
            .collect();
        let resident: Map<String, Value> = admitted
            .iter()
            .map(|id| (id.clone(), json!(self.resident_of(id))))
            .collect();
        let body = json!({"heartbeatMs": self.heartbeat_ms(), "residentMb": resident});
        fs::write(&self.owner_file, body.to_string()).is_ok()
    }

    fn claim(&self, path: &Path) -> Option<Held> {
        for _ in 0..8 {
            let file = match fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(path)
            {
                Ok(file) => file,
                Err(error) => {
                    tracing::warn!(%error, path = %path.display(), "could not open a shell queue slot");
                    return None;
                }
            };
            match file.try_lock() {
                Ok(()) => {}
                Err(fs::TryLockError::WouldBlock) => return None,
                Err(fs::TryLockError::Error(error)) => {
                    tracing::warn!(%error, path = %path.display(), "could not claim a shell queue slot");
                    return None;
                }
            }
            let same = match (fs::metadata(path), file.metadata()) {
                (Ok(path), Ok(file)) => identity(&path) == identity(&file),
                _ => false,
            };
            if same {
                return Some(Held {
                    path: path.to_path_buf(),
                    _file: file,
                });
            }
        }
        None
    }

    fn claim_slot(&self, prefix: &str, size: usize, held: &mut Vec<Held>) -> Option<usize> {
        for index in 0..size {
            if let Some(slot) = self.claim(&self.slots_dir.join(format!("{prefix}-{index}"))) {
                held.push(slot);
                return Some(index);
            }
        }
        None
    }

    fn register(&self) -> io::Result<()> {
        let _registering = lock(&self.registering);
        let known: Vec<String> = lock(&self.state).published.iter().cloned().collect();
        let owner = fs::metadata(&self.owner_file)
            .ok()
            .map(|meta| identity(&meta));
        let entries = fs::metadata(&self.entries_dir)
            .ok()
            .map(|meta| identity(&meta));
        let registered = {
            let state = lock(&self.state);
            state.registration.as_ref().is_some_and(|registration| {
                owner == Some(registration.owner) && entries == Some(registration.entries)
            })
        };
        if registered {
            let names: HashSet<String> = fs::read_dir(&self.entries_dir)
                .map(|names| {
                    names
                        .filter_map(|name| name.ok())
                        .map(|name| name.file_name().to_string_lossy().into_owned())
                        .collect()
                })
                .unwrap_or_default();
            let state = lock(&self.state);
            if known
                .iter()
                .all(|id| !state.owned.contains_key(id) || names.contains(&format!("{id}.json")))
            {
                return Ok(());
            }
        }
        let restoring = {
            let state = lock(&self.state);
            state.registration.is_some() || !state.owned.is_empty()
        };
        if !registered {
            lock(&self.state).registration = None;
        }
        for directory in [
            &self.entries_dir,
            &self.owners_dir,
            &self.slots_dir,
            &self.lanes_dir,
        ] {
            fs::create_dir_all(directory)?;
        }
        if !registered {
            fs::write(
                &self.owner_file,
                json!({"heartbeatMs": self.heartbeat_ms()}).to_string(),
            )?;
            let file = fs::OpenOptions::new().write(true).open(&self.owner_file)?;
            file.try_lock()
                .map_err(|_| io::Error::other("The shell queue owner file is already locked"))?;
            let registration = Registration {
                _owner: file,
                owner: identity(&fs::metadata(&self.owner_file)?),
                entries: identity(&fs::metadata(&self.entries_dir)?),
            };
            lock(&self.state).registration = Some(registration);
        } else if let Some(registration) = lock(&self.state).registration.as_mut() {
            registration.owner = identity(&fs::metadata(&self.owner_file)?);
            registration.entries = identity(&fs::metadata(&self.entries_dir)?);
        }
        if !restoring {
            return Ok(());
        }
        tracing::warn!(
            directory = %self.dir.display(),
            "shell queue files were removed; restoring this process's entries and slots"
        );
        let ids: Vec<String> = lock(&self.state).owned.keys().cloned().collect();
        for id in &ids {
            if !self.entry_file(id).exists()
                && let Err(error) = self.write_entry(id)
            {
                tracing::warn!(%error, "could not restore a shell queue entry");
            }
        }
        let mut state = lock(&self.state);
        for owned in state.owned.values_mut() {
            let id = owned.entry.id.clone();
            let files = owned.waiting.iter_mut().chain(
                owned
                    .running
                    .iter_mut()
                    .flat_map(|claimed| claimed.files.iter_mut()),
            );
            for held in files {
                if held.path.exists() {
                    continue;
                }
                let path = held.path.clone();
                match self.claim(&path) {
                    Some(restored) => {
                        let mut stale = std::mem::replace(held, restored);
                        stale.path = PathBuf::new();
                    }
                    None => tracing::warn!(
                        id,
                        path = %path.display(),
                        "another process took a shell queue slot while it was restored"
                    ),
                }
            }
        }
        Ok(())
    }

    fn write_entry(&self, id: &str) -> io::Result<()> {
        let _writing = lock(&self.writing);
        let Some(entry) = lock(&self.state)
            .owned
            .get(id)
            .map(|owned| owned.entry.clone())
        else {
            return Ok(());
        };
        let temporary = self
            .entries_dir
            .join(format!("{id}.json.{}.tmp", memory::random_uuid()?));
        fs::write(&temporary, entry.encode())?;
        if let Err(error) = fs::rename(&temporary, self.entry_file(id)) {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        let mut state = lock(&self.state);
        if state.owned.contains_key(id) {
            state.published.insert(id.to_owned());
        } else {
            drop(state);
            let _ = fs::remove_file(self.entry_file(id));
        }
        Ok(())
    }

    fn enqueue(self: &Arc<Self>, request: Request) -> Result<EnqueueReceipt, Error> {
        self.register()?;
        self.heartbeat();
        let limits = request.limits;
        let entry = Entry {
            id: request.id.clone(),
            owner: self.token.clone(),
            session_id: request.session_id.clone(),
            enqueued: self.now(),
            reserve_mb: request.memory_limit_mb.unwrap_or(limits.memory_reserve_mb) as f64,
            max_running: limits.max_running,
            max_running_per_session: limits.max_running_per_session,
            max_load: limits.max_load,
            capacity_blocked: None,
            retiring: false,
            admitted: None,
        };
        let mut held = Vec::new();
        if self
            .claim_slot(
                &format!("wait-{}", lane_of(&request.session_id)),
                limits.max_queued_per_session,
                &mut held,
            )
            .is_none()
        {
            return Err(Error::Full(Full {
                limit: limits.max_queued_per_session,
            }));
        }
        {
            let mut state = lock(&self.state);
            if state.owned.contains_key(&entry.id) {
                return Err(Error::Io(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "The shell queue already holds this entry",
                )));
            }
            state.owned.insert(
                entry.id.clone(),
                Owned {
                    entry: entry.clone(),
                    waiting: held.pop(),
                    running: None,
                    unsubscribe: None,
                },
            );
            if let Some(resident) = request.resident_mb.clone() {
                state.residents.insert(entry.id.clone(), resident);
            }
        }
        if let Err(error) = self.write_entry(&entry.id) {
            self.release(&entry.id);
            return Err(Error::Io(error));
        }
        let snapshot = self.snapshot();
        let position = snapshot
            .waiting
            .iter()
            .position(|item| item.id == entry.id)
            .map_or(1, |index| index + 1);
        let (positions_tx, positions_rx) = watch::channel(position);
        let (admitted_tx, admitted_rx) = oneshot::channel();
        let unsubscribe = request.admission.as_ref().map(|admission| {
            let weak: Weak<Inner> = Arc::downgrade(self);
            admission.subscribe(Arc::new(move || {
                if let Some(inner) = weak.upgrade() {
                    inner.wake();
                }
            }))
        });
        {
            let mut state = lock(&self.state);
            state.generation += 1;
            let generation = state.generation;
            if let Some(owned) = state.owned.get_mut(&entry.id) {
                owned.unsubscribe = unsubscribe;
            }
            state.waiters.insert(
                entry.id.clone(),
                Waiter {
                    request,
                    entry,
                    generation,
                    position,
                    positions: positions_tx,
                    admitted: Some(admitted_tx),
                },
            );
        }
        self.activity.notify();
        self.wake();
        Ok((position, positions_rx, admitted_rx))
    }

    fn release(&self, id: &str) {
        let (owned, published) = {
            let mut state = lock(&self.state);
            state.waiters.remove(id);
            state.residents.remove(id);
            let published = state.published.contains(id);
            (state.owned.remove(id), published)
        };
        let Some(mut owned) = owned else {
            return;
        };
        if let Some(unsubscribe) = owned.unsubscribe.take() {
            unsubscribe();
        }
        if published {
            let _writing = lock(&self.writing);
            let mut retiring = owned.entry.clone();
            retiring.retiring = true;
            if let Ok(uuid) = memory::random_uuid() {
                let temporary = self.entries_dir.join(format!("{id}.json.{uuid}.tmp"));
                if fs::write(&temporary, retiring.encode()).is_ok() {
                    let _ = fs::rename(&temporary, self.entry_file(id));
                } else {
                    let _ = fs::remove_file(&temporary);
                }
            }
        }
        drop(owned.running.take());
        drop(owned.waiting.take());
        let _ = fs::remove_file(self.entry_file(id));
        lock(&self.state).published.remove(id);
        self.activity.notify();
        self.wake();
    }

    fn sample(&self) -> Option<Sample> {
        let (sender, receiver) = std::sync::mpsc::channel();
        let sample = self.options.sample.clone();
        thread::spawn(move || {
            let _ = sender.send(sample());
        });
        receiver.recv_timeout(SAMPLE_TIMEOUT).ok().flatten()
    }

    fn wall(&self) -> i64 {
        wall_ms()
    }

    fn epoch(&self) -> String {
        fs::read_to_string(&self.admission_file).unwrap_or_else(|_| "initial".into())
    }

    fn owner_state(&self, owner: &str, now: i64) -> OwnerState {
        let file = self.owners_dir.join(format!("{owner}.lock"));
        let Ok(meta) = fs::metadata(&file) else {
            let mut state = lock(&self.state);
            let since = *state.missing_owners.entry(owner.to_owned()).or_insert(now);
            let (mtime, interval) = state
                .beats
                .get(owner)
                .map_or((since, HEARTBEAT.as_millis() as i64), |beat| {
                    (beat.mtime, beat.heartbeat_ms)
                });
            return if now - mtime < interval * STALE_HEARTBEATS {
                OwnerState::Stalled
            } else {
                OwnerState::Dead
            };
        };
        let mtime = modified_ms(&meta);
        let recorded: Option<Value> = fs::read_to_string(&file)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok());
        let interval = recorded
            .as_ref()
            .and_then(|value| value.get("heartbeatMs")?.as_f64())
            .filter(|value| value.is_finite() && *value > 0.0)
            .map_or(HEARTBEAT.as_millis() as i64, |value| value as i64);
        let resident: HashMap<String, f64> = recorded
            .as_ref()
            .and_then(|value| value.get("residentMb")?.as_object())
            .map(|object| {
                object
                    .iter()
                    .filter_map(|(id, value)| Some((id.clone(), value.as_f64()?)))
                    .filter(|(_, value)| value.is_finite() && *value >= 0.0)
                    .collect()
            })
            .unwrap_or_default();
        {
            let mut state = lock(&self.state);
            state.missing_owners.remove(owner);
            state.beats.insert(
                owner.to_owned(),
                Beat {
                    mtime,
                    heartbeat_ms: interval,
                    resident,
                },
            );
        }
        if now - mtime <= interval * STALE_HEARTBEATS {
            return OwnerState::Live;
        }
        match fs::OpenOptions::new().write(true).open(&file) {
            Ok(probe) => match probe.try_lock() {
                Ok(()) => OwnerState::Dead,
                Err(fs::TryLockError::WouldBlock) => OwnerState::Stalled,
                Err(fs::TryLockError::Error(error)) => {
                    tracing::warn!(%error, "could not check a shell queue owner");
                    OwnerState::Stalled
                }
            },
            Err(_) => OwnerState::Dead,
        }
    }

    fn prune_abandoned(&self, now: i64, entry_names: &[String]) {
        let old =
            |path: &Path| fs::metadata(path).is_ok_and(|meta| now - modified_ms(&meta) > TORN_MS);
        for name in entry_names {
            if is_entry_temporary(name) {
                let path = self.entries_dir.join(name);
                if old(&path) {
                    let _ = fs::remove_file(path);
                }
            }
        }
        if let Ok(names) = fs::read_dir(&self.dir) {
            for name in names.filter_map(|name| name.ok()) {
                let text = name.file_name().to_string_lossy().into_owned();
                if is_admission_temporary(&text) && old(&name.path()) {
                    let _ = fs::remove_file(name.path());
                }
            }
        }
        if let Ok(names) = fs::read_dir(&self.slots_dir) {
            for name in names.filter_map(|name| name.ok()) {
                let text = name.file_name().to_string_lossy().into_owned();
                if is_bypass(&text) && old(&name.path()) {
                    drop(self.claim(&name.path()));
                }
            }
        }
    }

    fn survey(&self) -> Survey {
        let now = self.wall();
        let entry_names: Vec<String> = fs::read_dir(&self.entries_dir)
            .map(|names| {
                names
                    .filter_map(|name| name.ok())
                    .map(|name| name.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        self.prune_abandoned(now, &entry_names);
        let names: Vec<&String> = entry_names
            .iter()
            .filter(|name| name.ends_with(".json"))
            .collect();
        struct Read {
            file: PathBuf,
            entry: Option<Entry>,
            torn: bool,
        }
        let read: Vec<Read> = names
            .iter()
            .filter_map(|name| {
                let file = self.entries_dir.join(name);
                let text = fs::read_to_string(&file).ok()?;
                let entry = Entry::decode(&text);
                let torn = entry.is_none()
                    && fs::metadata(&file).is_ok_and(|meta| now - modified_ms(&meta) > TORN_MS);
                Some(Read { file, entry, torn })
            })
            .collect();
        let foreign: Vec<String> = {
            let mut owners: Vec<String> = read
                .iter()
                .filter_map(|item| item.entry.as_ref())
                .filter(|entry| entry.owner != self.token)
                .map(|entry| entry.owner.clone())
                .collect();
            owners.sort();
            owners.dedup();
            owners
        };
        {
            let mut state = lock(&self.state);
            state
                .missing_owners
                .retain(|owner, _| foreign.contains(owner));
            state.beats.retain(|owner, _| foreign.contains(owner));
        }
        let states: HashMap<String, OwnerState> = foreign
            .iter()
            .map(|owner| (owner.clone(), self.owner_state(owner, now)))
            .collect();
        let (stale, live): (Vec<&Read>, Vec<&Read>) = read.iter().partition(|item| {
            item.torn
                || item.entry.as_ref().is_some_and(|entry| {
                    if entry.owner == self.token {
                        let state = lock(&self.state);
                        !state.owned.contains_key(&entry.id)
                            && !state.published.contains(&entry.id)
                            && !entry.retiring
                    } else {
                        states.get(&entry.owner) == Some(&OwnerState::Dead)
                    }
                })
        });
        for item in &stale {
            let _ = fs::remove_file(&item.file);
        }
        let state = lock(&self.state);
        Survey {
            present: names
                .iter()
                .map(|name| name.trim_end_matches(".json").to_owned())
                .collect(),
            entries: live
                .iter()
                .filter_map(|item| item.entry.clone())
                .filter(|entry| !entry.retiring)
                .collect(),
            stalled: foreign
                .iter()
                .filter(|owner| states.get(*owner) == Some(&OwnerState::Stalled))
                .cloned()
                .collect(),
            resident: state
                .beats
                .iter()
                .map(|(owner, beat)| {
                    (
                        owner.clone(),
                        if states.get(owner) == Some(&OwnerState::Live) {
                            beat.resident.clone()
                        } else {
                            HashMap::new()
                        },
                    )
                })
                .collect(),
        }
    }

    fn snapshot(&self) -> Snapshot {
        let started = self.wall();
        let revision = self.revision.load(Ordering::SeqCst);
        let known: HashSet<String> = lock(&self.state).waiters.keys().cloned().collect();
        let directory = fs::metadata(&self.entries_dir)
            .ok()
            .map(|meta| identity(&meta));
        let survey = self.survey();
        let unordered: Vec<Entry> = survey
            .entries
            .iter()
            .filter(|entry| entry.admitted.is_none())
            .cloned()
            .collect();
        let mut lanes = HashMap::new();
        for entry in &unordered {
            if lanes.contains_key(&entry.session_id) {
                continue;
            }
            if let Some(admitted) =
                fs::read_to_string(self.lanes_dir.join(lane_of(&entry.session_id)))
                    .ok()
                    .and_then(|text| text.trim().parse::<f64>().ok())
                    .filter(|value| value.is_finite())
            {
                lanes.insert(entry.session_id.clone(), admitted);
            }
        }
        Snapshot {
            started,
            revision,
            directory,
            epoch: self.epoch(),
            known,
            present: survey.present,
            live_lanes: survey
                .entries
                .iter()
                .map(|entry| lane_of(&entry.session_id))
                .collect(),
            running: survey
                .entries
                .iter()
                .filter(|entry| entry.admitted.is_some())
                .cloned()
                .collect(),
            waiting: order(unordered, &lanes),
            stalled: survey.stalled,
            resident: survey.resident,
        }
    }

    fn settle(&self, snapshot: &Snapshot) -> bool {
        let _registering = lock(&self.registering);
        let mut lost = Vec::new();
        {
            let mut state = lock(&self.state);
            if snapshot.directory.is_none()
                || snapshot.directory != state.registration.as_ref().map(|record| record.entries)
            {
                return false;
            }
            let ids: Vec<String> = state
                .waiters
                .keys()
                .filter(|id| {
                    snapshot.known.contains(*id)
                        && !snapshot.present.contains(*id)
                        && !self.entry_file(id).exists()
                })
                .cloned()
                .collect();
            if snapshot.directory
                != fs::metadata(&self.entries_dir)
                    .ok()
                    .map(|meta| identity(&meta))
            {
                return false;
            }
            for id in ids {
                if let Some(mut waiter) = state.waiters.remove(&id)
                    && let Some(sender) = waiter.admitted.take()
                {
                    lost.push((sender, id));
                }
            }
            let positions: HashMap<&str, usize> = snapshot
                .waiting
                .iter()
                .enumerate()
                .map(|(index, entry)| (entry.id.as_str(), index + 1))
                .collect();
            for (id, waiter) in &mut state.waiters {
                if let Some(position) = positions.get(id.as_str())
                    && *position != waiter.position
                {
                    waiter.position = *position;
                    let _ = waiter.positions.send(*position);
                }
            }
        }
        for (sender, id) in lost {
            let _ = sender.send(Err(EntryLost { id }));
        }
        true
    }

    fn resources_met(&self, entry: &Entry, snapshot: &Snapshot) -> bool {
        let Some(sample) = self.sample() else {
            return false;
        };
        let unmaterialized: f64 = snapshot
            .running
            .iter()
            .map(|running| {
                let resident = if running.owner == self.token {
                    self.resident_of(&running.id)
                } else {
                    snapshot
                        .resident
                        .get(&running.owner)
                        .and_then(|resident| resident.get(&running.id))
                        .copied()
                        .unwrap_or(0.0)
                };
                (running.reserve_mb - resident).max(0.0)
            })
            .sum();
        let now = self.now();
        let recent: f64 = snapshot
            .running
            .iter()
            .filter_map(|running| running.admitted)
            .map(|(at, _)| (-((now - at).max(0) as f64) / LOAD_HALF_LIFE_MS).exp())
            .sum();
        sample.available_mb - unmaterialized >= entry.reserve_mb
            && sample.load + recent / (self.options.parallelism.max(1) as f64) < entry.max_load
    }

    fn family_of(&self, id: &str) -> Option<String> {
        lock(&self.state)
            .waiters
            .get(id)
            .and_then(|waiter| waiter.request.admission.as_ref())
            .map(|admission| admission.family().to_owned())
    }

    fn candidate(&self, snapshot: &Snapshot, exhausted: &Exhausted) -> Option<Entry> {
        snapshot
            .waiting
            .iter()
            .find(|entry| {
                if let Some(family) = self.family_of(&entry.id)
                    && exhausted.families.contains(&family)
                {
                    return false;
                }
                if snapshot.stalled.contains(&entry.owner) {
                    return false;
                }
                if entry.owner != self.token
                    && let Some(blocked) = &entry.capacity_blocked
                {
                    return *blocked != snapshot.epoch;
                }
                if entry.max_running <= exhausted.run
                    || entry.max_running_per_session
                        <= exhausted
                            .sessions
                            .get(&entry.session_id)
                            .copied()
                            .unwrap_or(0)
                {
                    return false;
                }
                if entry.capacity_blocked.is_some() {
                    return true;
                }
                (0..entry.max_running).any(|index| {
                    !snapshot
                        .running
                        .iter()
                        .any(|item| item.admitted.is_some_and(|(_, slots)| slots.run == index))
                }) && (0..entry.max_running_per_session).any(|index| {
                    !snapshot.running.iter().any(|item| {
                        item.session_id == entry.session_id
                            && item
                                .admitted
                                .is_some_and(|(_, slots)| slots.session == index)
                    })
                })
            })
            .cloned()
    }

    fn capacity_blocked(&self, id: &str, generation: u64, observation: Option<String>) {
        {
            let mut state = lock(&self.state);
            if state.waiters.get(id).map(|waiter| waiter.generation) != Some(generation) {
                return;
            }
            let Some(owned) = state.owned.get_mut(id) else {
                return;
            };
            if owned.entry.admitted.is_some() || owned.entry.capacity_blocked == observation {
                return;
            }
            owned.entry.capacity_blocked = observation;
        }
        if let Err(error) = self.write_entry(id) {
            tracing::warn!(%error, "could not publish a shell queue capacity hint");
        }
    }

    fn pass(&self) {
        let _evaluating = lock(&self.evaluating);
        if lock(&self.state).waiters.is_empty() {
            return;
        }
        if let Err(error) = self.register() {
            tracing::warn!(%error, "shell queue registration failed");
            return;
        }
        let mut snapshot = self.snapshot();
        if !self.settle(&snapshot) {
            return;
        }
        let mut exhausted = Exhausted::default();
        loop {
            if self.revision.load(Ordering::SeqCst) != snapshot.revision {
                return;
            }
            let Some(head) = self.candidate(&snapshot, &exhausted) else {
                return;
            };
            if head.owner != self.token {
                return;
            }
            let Some((request, generation)) = lock(&self.state)
                .waiters
                .get(&head.id)
                .map(|waiter| (waiter.request.clone(), waiter.generation))
            else {
                return;
            };
            match self.admit(&request, generation, &snapshot, &exhausted) {
                Outcome::Stop => return,
                Outcome::Family => {
                    if let Some(admission) = &request.admission {
                        exhausted.families.insert(admission.family().to_owned());
                    }
                }
                Outcome::Run => {
                    exhausted.run = exhausted.run.max(request.limits.max_running);
                }
                Outcome::Session => {
                    let cap = exhausted
                        .sessions
                        .entry(request.session_id.clone())
                        .or_insert(0);
                    *cap = (*cap).max(request.limits.max_running_per_session);
                }
                Outcome::Admitted => {
                    snapshot = self.snapshot();
                    exhausted = Exhausted::default();
                    if !self.settle(&snapshot) {
                        return;
                    }
                }
            }
        }
    }

    fn claim_all(
        &self,
        request: &Request,
        entry: &Entry,
        snapshot: &Snapshot,
        exhausted: &Exhausted,
        claimed: &mut Claimed,
    ) -> Result<Slots, Blocked> {
        let idle = snapshot.running.is_empty();
        let lane = lane_of(&request.session_id);
        let session_prefix = format!("session-{lane}");
        if !idle && !self.resources_met(entry, snapshot) {
            return Err(Blocked::Resources);
        }
        if self.revision.load(Ordering::SeqCst) != snapshot.revision
            || self
                .candidate(snapshot, exhausted)
                .map(|item| item.id)
                .as_deref()
                != Some(entry.id.as_str())
        {
            return Err(Blocked::Changed);
        }
        if let Some(admission) = &request.admission {
            claimed.family = admission.acquire();
            if claimed.family.is_none() {
                return Err(Blocked::Family);
            }
        }
        let exempt = if idle {
            self.claim_slot("run", 1, &mut claimed.files)
        } else {
            None
        };
        if let Some(run) = exempt {
            let session = self
                .claim_slot(
                    &session_prefix,
                    entry.max_running_per_session,
                    &mut claimed.files,
                )
                .ok_or(Blocked::Session)?;
            return Ok(Slots { run, session });
        }
        if idle && !self.resources_met(entry, snapshot) {
            return Err(Blocked::Resources);
        }
        let session = self
            .claim_slot(
                &session_prefix,
                entry.max_running_per_session,
                &mut claimed.files,
            )
            .ok_or(Blocked::Session)?;
        let run = self
            .claim_slot("run", entry.max_running, &mut claimed.files)
            .ok_or(Blocked::Run)?;
        Ok(Slots { run, session })
    }

    fn admit(
        &self,
        request: &Request,
        generation: u64,
        snapshot: &Snapshot,
        exhausted: &Exhausted,
    ) -> Outcome {
        let id = &request.id;
        let waiting = |this: &Self| {
            lock(&this.state)
                .waiters
                .get(id)
                .filter(|waiter| waiter.generation == generation)
                .map(|waiter| waiter.entry.clone())
        };
        let Some(mut entry) = waiting(self) else {
            return Outcome::Stop;
        };
        entry.reserve_mb = self.history.requirement(&memory::Requirement {
            command: request.command.clone(),
            cwd: request.cwd.clone(),
            memory_limit_mb: request.memory_limit_mb,
            reserve_mb: request.limits.memory_reserve_mb,
        });
        let mut claimed = Claimed {
            files: Vec::new(),
            family: None,
        };
        let slots = match self.claim_all(request, &entry, snapshot, exhausted, &mut claimed) {
            Ok(slots) => slots,
            Err(blocked) => {
                drop(claimed);
                if blocked != Blocked::Changed {
                    let observation = (blocked != Blocked::Resources).then(|| self.epoch());
                    self.capacity_blocked(id, generation, observation);
                }
                return match blocked {
                    Blocked::Run => Outcome::Run,
                    Blocked::Session => Outcome::Session,
                    Blocked::Family => Outcome::Family,
                    Blocked::Resources | Blocked::Changed => Outcome::Stop,
                };
            }
        };
        let latest = self.snapshot();
        if self
            .candidate(&latest, exhausted)
            .map(|item| item.id)
            .as_deref()
            != Some(entry.id.as_str())
            || waiting(self).is_none()
        {
            return Outcome::Stop;
        }
        let position = latest
            .waiting
            .iter()
            .position(|item| item.id == entry.id)
            .unwrap_or(0);
        let bypassing = latest.waiting[..position].iter().any(|item| {
            item.owner != self.token
                && !latest.stalled.contains(&item.owner)
                && item.capacity_blocked.as_deref() == Some(latest.epoch.as_str())
        });
        let bypass = if bypassing {
            let path = self
                .slots_dir
                .join(format!("bypass-{}", sha256_hex(&latest.epoch)));
            match self.claim(&path) {
                Some(held) if self.epoch() == latest.epoch => Some(held),
                _ => return Outcome::Stop,
            }
        } else {
            None
        };
        let temporary = self.dir.join(format!(
            "admission.{}.tmp",
            memory::random_uuid().unwrap_or_default()
        ));
        if fs::write(&temporary, memory::random_uuid().unwrap_or_default())
            .and_then(|()| fs::rename(&temporary, &self.admission_file))
            .is_err()
        {
            let _ = fs::remove_file(&temporary);
            return Outcome::Stop;
        }
        drop(bypass);
        let admitted_at = self.now();
        let waiting_version = {
            let mut state = lock(&self.state);
            if !state
                .waiters
                .get(id)
                .is_some_and(|waiter| waiter.generation == generation)
            {
                return Outcome::Stop;
            }
            let Some(owned) = state.owned.get_mut(id) else {
                return Outcome::Stop;
            };
            let waiting_version = owned.entry.clone();
            owned.entry.admitted = Some((admitted_at, slots));
            owned.entry.reserve_mb = entry.reserve_mb;
            owned.entry.capacity_blocked = None;
            waiting_version
        };
        let written = self
            .write_lane(&request.session_id, admitted_at)
            .and_then(|()| self.write_entry(id));
        if let Err(error) = written {
            tracing::warn!(%error, "could not publish a shell queue admission");
            if let Some(owned) = lock(&self.state).owned.get_mut(id) {
                owned.entry = waiting_version;
            }
            return Outcome::Stop;
        }
        if let Some(family) = &claimed.family {
            family.commit();
        }
        let (waiting_slot, sender) = {
            let mut state = lock(&self.state);
            let sender = state
                .waiters
                .remove(id)
                .and_then(|mut waiter| waiter.admitted.take());
            let waiting_slot = state.owned.get_mut(id).and_then(|owned| {
                owned.running = Some(claimed);
                owned.waiting.take()
            });
            (waiting_slot, sender)
        };
        drop(waiting_slot);
        if let Some(sender) = sender {
            let _ = sender.send(Ok(()));
        }
        self.prune_lanes(&snapshot.live_lanes, snapshot.started);
        Outcome::Admitted
    }

    fn write_lane(&self, session_id: &str, admitted: i64) -> io::Result<()> {
        let lane = self.lanes_dir.join(lane_of(session_id));
        let temporary = lane.with_extension(format!("{}.tmp", self.token));
        fs::write(&temporary, admitted.to_string())?;
        fs::rename(&temporary, lane).inspect_err(|_| {
            let _ = fs::remove_file(&temporary);
        })
    }

    fn prune_lanes(&self, live: &HashSet<String>, before: i64) {
        let Ok(names) = fs::read_dir(&self.lanes_dir) else {
            return;
        };
        for name in names.filter_map(|name| name.ok()) {
            let text = name.file_name().to_string_lossy().into_owned();
            let lane = text.split('.').next().unwrap_or(&text).to_owned();
            if live.contains(&lane) {
                continue;
            }
            if fs::metadata(name.path()).is_ok_and(|meta| modified_ms(&meta) < before) {
                let _ = fs::remove_file(name.path());
            }
        }
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.owner_file);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OwnerState {
    Live,
    Stalled,
    Dead,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Blocked {
    Resources,
    Changed,
    Family,
    Session,
    Run,
}

enum Outcome {
    Stop,
    Family,
    Run,
    Session,
    Admitted,
}

#[derive(Default)]
struct Exhausted {
    run: usize,
    sessions: HashMap<String, usize>,
    families: HashSet<String>,
}

struct Survey {
    present: HashSet<String>,
    entries: Vec<Entry>,
    stalled: HashSet<String>,
    resident: HashMap<String, HashMap<String, f64>>,
}

struct Snapshot {
    started: i64,
    revision: u64,
    directory: Option<Identity>,
    epoch: String,
    known: HashSet<String>,
    present: HashSet<String>,
    live_lanes: HashSet<String>,
    running: Vec<Entry>,
    waiting: Vec<Entry>,
    stalled: HashSet<String>,
    resident: HashMap<String, HashMap<String, f64>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

fn wall_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

fn modified_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

fn identity(meta: &fs::Metadata) -> Identity {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Identity(meta.dev(), meta.ino())
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        Identity(0, 0)
    }
}

fn sha256_hex(text: &str) -> String {
    digest::digest(&digest::SHA256, text.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn lane_of(session_id: &str) -> String {
    sha256_hex(session_id)[..32].to_owned()
}

fn is_uuid(text: &str) -> bool {
    text.len() == 36
        && text
            .chars()
            .all(|letter| letter == '-' || matches!(letter, '0'..='9' | 'a'..='f'))
}

fn is_entry_temporary(name: &str) -> bool {
    name.split_once(".json.")
        .and_then(|(_, rest)| rest.strip_suffix(".tmp"))
        .is_some_and(is_uuid)
}

fn is_admission_temporary(name: &str) -> bool {
    name.strip_prefix("admission.")
        .and_then(|rest| rest.strip_suffix(".tmp"))
        .is_some_and(is_uuid)
}

fn is_bypass(name: &str) -> bool {
    name.strip_prefix("bypass-").is_some_and(|hash| {
        hash.len() == 64
            && hash
                .chars()
                .all(|letter| matches!(letter, '0'..='9' | 'a'..='f'))
    })
}

// Round-robin across Session lanes: each round takes the next entry of every lane, starting
// with the lane admitted least recently, so one Session's backlog cannot starve another.
fn order(waiting: Vec<Entry>, lanes: &HashMap<String, f64>) -> Vec<Entry> {
    let mut sorted = waiting;
    sorted.sort_by(|left, right| {
        left.enqueued
            .cmp(&right.enqueued)
            .then_with(|| left.id.cmp(&right.id))
    });
    let mut sessions: Vec<String> = Vec::new();
    for entry in &sorted {
        if !sessions.contains(&entry.session_id) {
            sessions.push(entry.session_id.clone());
        }
    }
    let mut ranked: Vec<(usize, &String)> = sessions.iter().enumerate().collect();
    ranked.sort_by(|left, right| {
        let left_lane = lanes.get(left.1).copied().unwrap_or(-1.0);
        let right_lane = lanes.get(right.1).copied().unwrap_or(-1.0);
        left_lane
            .partial_cmp(&right_lane)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(left.0.cmp(&right.0))
    });
    let by_session: HashMap<&String, Vec<&Entry>> = sessions
        .iter()
        .map(|session| {
            (
                session,
                sorted
                    .iter()
                    .filter(|entry| &entry.session_id == session)
                    .collect(),
            )
        })
        .collect();
    let rounds = by_session.values().map(Vec::len).max().unwrap_or(0);
    let mut output = Vec::with_capacity(sorted.len());
    for round in 0..rounds {
        for (_, session) in &ranked {
            if let Some(entry) = by_session[session].get(round) {
                output.push((*entry).clone());
            }
        }
    }
    output
}

pub fn vm_stat_available_mb(text: &str) -> Option<f64> {
    let page_size: f64 = text
        .split_once("page size of ")?
        .1
        .split_whitespace()
        .next()?
        .parse()
        .ok()?;
    let mut pages = 0.0;
    for name in ["free", "inactive", "speculative"] {
        let heading = format!("Pages {name}:");
        let line = text.lines().find(|line| line.starts_with(&heading))?;
        let count = line[heading.len()..].trim().strip_suffix('.')?;
        pages += count.trim().parse::<f64>().ok()?;
    }
    Some(pages * page_size / MIB)
}

pub fn host_sample() -> Option<Sample> {
    let parallelism = thread::available_parallelism().map_or(1, usize::from) as f64;
    Some(Sample {
        available_mb: available_memory_mb()?,
        load: load_average()? / parallelism,
    })
}

pub fn available_with_fallback(
    primary: Option<f64>,
    free: impl FnOnce() -> Option<f64>,
) -> Option<f64> {
    primary.or_else(free)
}

pub fn meminfo_available_mb(text: &str) -> Option<f64> {
    let line = text
        .lines()
        .find(|line| line.starts_with("MemAvailable:"))?;
    let mut fields = line.split_whitespace().skip(1);
    let kib: f64 = fields.next()?.parse().ok()?;
    (fields.next() == Some("kB") && kib.is_finite() && kib >= 0.0).then_some(kib / 1024.0)
}

pub fn output_within(
    program: &str,
    arguments: &[&str],
    deadline: Duration,
) -> io::Result<Option<String>> {
    use io::Read;
    let mut child = std::process::Command::new(program)
        .args(arguments)
        .env("LC_ALL", "C")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("Sampler output is unavailable"))?;
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).map(|_| bytes)
    });
    let started = std::time::Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            let bytes = reader
                .join()
                .map_err(|_| io::Error::other("Sampler output reader panicked"))??;
            return Ok(status
                .success()
                .then(|| String::from_utf8_lossy(&bytes).into_owned()));
        }
        if started.elapsed() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "The sampler command outlived its deadline",
            ));
        }
        thread::sleep(Duration::from_millis(5));
    }
}

#[cfg(target_os = "macos")]
fn available_memory_mb() -> Option<f64> {
    let primary = output_within("vm_stat", &[], SUBPROCESS_DEADLINE)
        .ok()
        .flatten()
        .and_then(|text| vm_stat_available_mb(&text));
    available_with_fallback(primary, || {
        let pages = sysctl_unsigned("vm.page_free_count")?;
        let size = sysctl_unsigned("hw.pagesize")?;
        Some(pages as f64 * size as f64 / MIB)
    })
}

#[cfg(target_os = "macos")]
fn sysctl_unsigned(name: &str) -> Option<u64> {
    let name = std::ffi::CString::new(name).ok()?;
    let mut buffer = [0_u8; 8];
    let mut length = buffer.len();
    let read = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            buffer.as_mut_ptr().cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    match (read, length) {
        (0, 4) => Some(u64::from(u32::from_ne_bytes(buffer[..4].try_into().ok()?))),
        (0, 8) => Some(u64::from_ne_bytes(buffer)),
        _ => None,
    }
}

#[cfg(target_os = "linux")]
fn available_memory_mb() -> Option<f64> {
    let primary = fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|text| meminfo_available_mb(&text));
    available_with_fallback(primary, || {
        let pages = unsafe { libc::sysconf(libc::_SC_AVPHYS_PAGES) };
        let size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        (pages > 0 && size > 0).then(|| pages as f64 * size as f64 / MIB)
    })
}

#[cfg(windows)]
fn available_memory_mb() -> Option<f64> {
    #[repr(C)]
    struct MemoryStatus {
        length: u32,
        load: u32,
        total_physical: u64,
        available_physical: u64,
        total_page_file: u64,
        available_page_file: u64,
        total_virtual: u64,
        available_virtual: u64,
        available_extended_virtual: u64,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GlobalMemoryStatusEx(status: *mut MemoryStatus) -> i32;
    }
    let mut status = MemoryStatus {
        length: std::mem::size_of::<MemoryStatus>() as u32,
        load: 0,
        total_physical: 0,
        available_physical: 0,
        total_page_file: 0,
        available_page_file: 0,
        total_virtual: 0,
        available_virtual: 0,
        available_extended_virtual: 0,
    };
    (unsafe { GlobalMemoryStatusEx(&mut status) } != 0)
        .then(|| status.available_physical as f64 / MIB)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn available_memory_mb() -> Option<f64> {
    None
}

#[cfg(unix)]
fn load_average() -> Option<f64> {
    let mut load = [0.0_f64; 3];
    (unsafe { libc::getloadavg(load.as_mut_ptr(), 3) } >= 1).then_some(load[0])
}

#[cfg(not(unix))]
fn load_average() -> Option<f64> {
    Some(0.0)
}
