use super::{contains, glob, ignore, normalize, protected};
use crate::platform::git;
use notify::{
    Config, EventKind, PollWatcher, RecommendedWatcher, RecursiveMode, Watcher, event::ModifyKind,
};
use std::{
    collections::{HashMap, HashSet},
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::sync::mpsc;
use ycoding_schema::filesystem::{ChangedData, ChangedKind};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    File,
    Directory,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateKind {
    Create,
    Update,
    Delete,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Update {
    pub path: PathBuf,
    pub kind: UpdateKind,
}
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Input {
    pub path: PathBuf,
    pub kind: Kind,
    pub ignore: Vec<String>,
}

struct Entry {
    subscribers: Arc<Mutex<Subscribers>>,
    _watcher: WatcherOwner,
}
#[derive(Default)]
struct Subscribers {
    senders: Vec<mpsc::UnboundedSender<io::Result<Update>>>,
    failure: Option<Arc<io::Error>>,
    stopped: bool,
}

impl Subscribers {
    fn subscribe(&mut self) -> mpsc::UnboundedReceiver<io::Result<Update>> {
        let (sender, receiver) = mpsc::unbounded_channel();
        if let Some(error) = &self.failure {
            let _ = sender.send(Err(io::Error::new(error.kind(), error.clone())));
        } else if !self.stopped {
            self.senders.push(sender);
        }
        receiver
    }

    fn publish(&mut self, update: Update) {
        self.senders
            .retain(|sender| sender.send(Ok(update.clone())).is_ok());
    }

    fn fail(&mut self, error: io::Error) {
        if self.stopped || self.failure.is_some() {
            return;
        }
        tracing::error!(component = "watcher", error_kind = ?error.kind(), "watcher terminated");
        let error = Arc::new(error);
        self.failure = Some(error.clone());
        for sender in std::mem::take(&mut self.senders) {
            let _ = sender.send(Err(io::Error::new(error.kind(), error.clone())));
        }
    }
}

impl Drop for Entry {
    fn drop(&mut self) {
        let mut subscribers = self
            .subscribers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        subscribers.stopped = true;
        subscribers.senders.clear();
    }
}

struct FileCallback {
    subscribers: Arc<Mutex<Subscribers>>,
    target: PathBuf,
}

impl FileCallback {
    fn receive(&self, event: notify::Result<notify::Event>) {
        let event = match event {
            Ok(event) => event,
            Err(error) => {
                self.subscribers
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .fail(backend_error(error));
                return;
            }
        };
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        for path in event.paths {
            let path = normalize(&path);
            if path != self.target {
                continue;
            }
            let mut subscribers = match self.subscribers.lock() {
                Ok(subscribers) => subscribers,
                Err(error) => {
                    error
                        .into_inner()
                        .fail(io::Error::other("Watcher subscriber lock poisoned"));
                    return;
                }
            };
            subscribers.publish(Update {
                path,
                kind: UpdateKind::Update,
            });
        }
    }
}

impl Drop for FileCallback {
    fn drop(&mut self) {
        self.subscribers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .fail(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "Watcher backend callback closed",
            ));
    }
}

struct WatcherOwner {
    _native: Option<Mutex<Box<dyn Watcher + Send>>>,
    _directory: Option<DirectoryWatcher>,
}
struct DirectoryWatcher {
    stop: std::sync::mpsc::Sender<()>,
    worker: Option<std::thread::JoinHandle<()>>,
}
const KERNEL_RECURSIVE_WATCH: bool = cfg!(any(target_os = "macos", windows));
struct Slot {
    entry: Mutex<Weak<Entry>>,
}
pub struct Service {
    enabled: bool,
    entries: Mutex<HashMap<Input, Weak<Slot>>>,
}
pub struct Subscription {
    _entry: Option<Arc<Entry>>,
    _slot: Option<Arc<Slot>>,
    receiver: mpsc::UnboundedReceiver<io::Result<Update>>,
}

impl Service {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            entries: Mutex::new(HashMap::new()),
        }
    }

    pub fn active_count(&self) -> io::Result<usize> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| io::Error::other("Watcher lock poisoned"))?;
        entries.retain(|_, entry| entry.strong_count() > 0);
        let slots = entries
            .values()
            .filter_map(Weak::upgrade)
            .collect::<Vec<_>>();
        drop(entries);
        Ok(slots
            .into_iter()
            .filter(|slot| {
                slot.entry
                    .lock()
                    .is_ok_and(|entry| entry.strong_count() > 0)
            })
            .count())
    }

    pub fn subscribe(&self, input: Input) -> io::Result<Subscription> {
        self.subscribe_with(input, initialize)
    }

    fn subscribe_with(
        &self,
        mut input: Input,
        initialize: impl FnOnce(&Input) -> io::Result<Arc<Entry>>,
    ) -> io::Result<Subscription> {
        input.path = normalize(&std::path::absolute(input.path)?);
        if input.kind == Kind::File {
            input.ignore.clear();
        }
        input.ignore.sort();
        input.ignore.dedup();
        if !self.enabled {
            let (sender, receiver) = mpsc::unbounded_channel();
            drop(sender);
            return Ok(Subscription {
                _entry: None,
                _slot: None,
                receiver,
            });
        }
        let slot = {
            let mut entries = self
                .entries
                .lock()
                .map_err(|_| io::Error::other("Watcher lock poisoned"))?;
            entries.retain(|_, entry| entry.strong_count() > 0);
            match entries.get(&input).and_then(Weak::upgrade) {
                Some(slot) => slot,
                None => {
                    let slot = Arc::new(Slot {
                        entry: Mutex::new(Weak::new()),
                    });
                    entries.insert(input.clone(), Arc::downgrade(&slot));
                    slot
                }
            }
        };
        let mut cached = slot
            .entry
            .lock()
            .map_err(|_| io::Error::other("Watcher identity lock poisoned"))?;
        let entry = match cached.upgrade() {
            Some(entry) => entry,
            None => {
                let entry = initialize(&input)?;
                *cached = Arc::downgrade(&entry);
                entry
            }
        };
        let receiver = entry
            .subscribers
            .lock()
            .map_err(|_| io::Error::other("Watcher subscriber lock poisoned"))?
            .subscribe();
        drop(cached);
        Ok(Subscription {
            _entry: Some(entry),
            _slot: Some(slot),
            receiver,
        })
    }
}

const SUBSCRIBE_TIMEOUT: Duration = Duration::from_secs(10);

fn start<T: Send + 'static>(
    timeout: Duration,
    native: impl FnOnce() -> io::Result<T> + Send + 'static,
    fallback: impl FnOnce() -> io::Result<T>,
) -> io::Result<T> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = sender.send(native());
    });
    let error_kind = match receiver.recv_timeout(timeout) {
        Ok(Ok(watcher)) => return Ok(watcher),
        Ok(Err(error)) => error.kind(),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => io::ErrorKind::TimedOut,
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => io::ErrorKind::BrokenPipe,
    };
    tracing::warn!(
        component = "watcher",
        ?error_kind,
        "native watcher startup failed; using polling fallback"
    );
    fallback()
}

fn backend_error(error: notify::Error) -> io::Error {
    let kind = match &error.kind {
        notify::ErrorKind::Io(error) => error.kind(),
        notify::ErrorKind::PathNotFound | notify::ErrorKind::WatchNotFound => {
            io::ErrorKind::NotFound
        }
        notify::ErrorKind::InvalidConfig(_) => io::ErrorKind::InvalidInput,
        notify::ErrorKind::Generic(_) | notify::ErrorKind::MaxFilesWatch => io::ErrorKind::Other,
    };
    io::Error::new(kind, error)
}

fn initialize(input: &Input) -> io::Result<Arc<Entry>> {
    let subscribers = Arc::new(Mutex::new(Subscribers::default()));
    let watcher = if input.kind == Kind::File {
        WatcherOwner {
            _native: Some(Mutex::new(make::<RecommendedWatcher>(
                input,
                subscribers.clone(),
                Config::default(),
            )?)),
            _directory: None,
        }
    } else {
        WatcherOwner {
            _native: None,
            _directory: Some(initialize_directory(input, subscribers.clone())?),
        }
    };
    Ok(Arc::new(Entry {
        subscribers,
        _watcher: watcher,
    }))
}

struct DirectorySetup {
    watcher: Box<dyn Watcher + Send>,
    events: std::sync::mpsc::Receiver<notify::Result<notify::Event>>,
    known: HashSet<PathBuf>,
    watched: HashSet<PathBuf>,
    recursive: bool,
    matcher: IgnoreMatcher,
    inventory_pending: bool,
    registered_at: Option<std::time::SystemTime>,
}

fn setup_directory<W: Watcher + Send + 'static>(
    input: &Input,
    config: Config,
    recursive: bool,
) -> io::Result<DirectorySetup> {
    let (sender, events) = std::sync::mpsc::channel();
    let mut watcher = W::new(
        move |event| {
            let _ = sender.send(event);
        },
        config,
    )
    .map_err(backend_error)?;
    let mut matcher = IgnoreMatcher::compile(&input.ignore)?;
    let mut known = HashSet::new();
    let mut watched = HashSet::new();
    let registered_at = if recursive {
        let registered_at = std::time::SystemTime::now();
        watcher
            .watch(&input.path, RecursiveMode::Recursive)
            .map_err(backend_error)?;
        Some(registered_at)
    } else {
        let mut directories = vec![input.path.clone()];
        inventory(
            &mut matcher,
            &input.path,
            &input.path,
            &mut known,
            &mut directories,
            None,
            None,
        )?;
        for directory in directories {
            watcher
                .watch(&directory, RecursiveMode::NonRecursive)
                .map_err(backend_error)?;
            watched.insert(directory);
        }
        None
    };
    Ok(DirectorySetup {
        watcher: Box::new(watcher),
        events,
        known,
        watched,
        recursive,
        matcher,
        inventory_pending: recursive,
        registered_at,
    })
}

fn initialize_directory(
    input: &Input,
    subscribers: Arc<Mutex<Subscribers>>,
) -> io::Result<DirectoryWatcher> {
    let native_input = input.clone();
    let fallback_input = input.clone();
    let setup = start(
        SUBSCRIBE_TIMEOUT,
        move || {
            setup_directory::<RecommendedWatcher>(
                &native_input,
                Config::default(),
                KERNEL_RECURSIVE_WATCH,
            )
        },
        move || {
            setup_directory::<PollWatcher>(
                &fallback_input,
                Config::default()
                    .with_poll_interval(Duration::from_millis(100))
                    .with_compare_contents(true),
                false,
            )
        },
    )?;
    Ok(spawn_directory_watcher(input, subscribers, setup))
}

fn spawn_directory_watcher(
    input: &Input,
    subscribers: Arc<Mutex<Subscribers>>,
    mut setup: DirectorySetup,
) -> DirectoryWatcher {
    let (stop, stopping) = std::sync::mpsc::channel();
    let input = input.clone();
    let dispatch = tracing::dispatcher::get_default(Clone::clone);
    let worker = std::thread::spawn(move || {
        tracing::dispatcher::with_default(&dispatch, || {
            if setup.inventory_pending {
                match inventory(
                    &mut setup.matcher,
                    &input.path,
                    &input.path,
                    &mut setup.known,
                    &mut Vec::new(),
                    Some(&stopping),
                    setup.registered_at,
                ) {
                    Ok(outcome) if outcome.completed => outcome.report(),
                    Ok(_) => return,
                    Err(error) => {
                        if !stop_requested(&stopping) {
                            subscribers
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner)
                                .fail(error);
                        }
                        return;
                    }
                }
            }
            loop {
                if stop_requested(&stopping) {
                    break;
                }
                let error = match setup.events.recv_timeout(Duration::from_millis(100)) {
                    Ok(Ok(event)) => {
                        match process_directory_event(&input, &mut setup, &subscribers, event) {
                            Ok(()) => continue,
                            Err(error) => error,
                        }
                    }
                    Ok(Err(error)) => backend_error(error),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "Watcher backend event channel closed",
                    ),
                };
                if !stop_requested(&stopping) {
                    subscribers
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .fail(error);
                }
                break;
            }
        });
    });
    DirectoryWatcher {
        stop,
        worker: Some(worker),
    }
}

impl Drop for DirectoryWatcher {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn stop_requested(stop: &std::sync::mpsc::Receiver<()>) -> bool {
    !matches!(stop.try_recv(), Err(std::sync::mpsc::TryRecvError::Empty))
}

fn process_directory_event(
    input: &Input,
    setup: &mut DirectorySetup,
    subscribers: &Arc<Mutex<Subscribers>>,
    event: notify::Event,
) -> io::Result<()> {
    if matches!(event.kind, EventKind::Access(_)) {
        return Ok(());
    }
    let mut recovery = InventoryOutcome::default();
    for path in event.paths.into_iter().map(|path| normalize(&path)) {
        if !contains(&input.path, &path) || path == input.path {
            continue;
        }
        if setup.matcher.matches(&input.path, &path)? {
            continue;
        }
        let mut discovered = Vec::new();
        let deleted = matches!(event.kind, EventKind::Remove(_))
            || matches!(event.kind, EventKind::Modify(ModifyKind::Name(_))) && !path.exists();
        let kind = if deleted {
            let mut removed_directories = setup
                .watched
                .iter()
                .filter(|directory| contains(&path, directory))
                .cloned()
                .collect::<Vec<_>>();
            removed_directories
                .sort_by_key(|directory| std::cmp::Reverse(directory.components().count()));
            for directory in removed_directories {
                if let Err(error) = setup.watcher.unwatch(&directory) {
                    let error = backend_error(error);
                    if error.kind() != io::ErrorKind::NotFound {
                        return Err(error);
                    }
                    recovery.recover(&error);
                }
                setup.watched.remove(&directory);
            }
            setup.known.retain(|entry| !contains(&path, entry));
            UpdateKind::Delete
        } else {
            let kind = match event.kind {
                EventKind::Create(_) => {
                    setup.known.insert(path.clone());
                    UpdateKind::Create
                }
                EventKind::Modify(ModifyKind::Name(_)) if setup.known.insert(path.clone()) => {
                    UpdateKind::Create
                }
                _ => {
                    setup.known.insert(path.clone());
                    UpdateKind::Update
                }
            };
            if !setup.recursive {
                match fs::symlink_metadata(&path) {
                    Ok(metadata) if metadata.file_type().is_dir() => {
                        let outcome = register_subtree(
                            input,
                            &path,
                            &mut setup.watcher,
                            &mut setup.known,
                            &mut setup.watched,
                            &mut setup.matcher,
                            &mut discovered,
                        )?;
                        recovery.missing = recovery.missing.saturating_add(outcome.missing);
                        recovery.denied = recovery.denied.saturating_add(outcome.denied);
                    }
                    Ok(_) => {}
                    Err(error) if recovery.recover(&error) => {}
                    Err(error) => return Err(error),
                }
            }
            kind
        };
        let mut subscribers = subscribers
            .lock()
            .map_err(|_| io::Error::other("Watcher subscriber lock poisoned"))?;
        let updates =
            std::iter::once(Update { path, kind }).chain(discovered.into_iter().map(|path| {
                Update {
                    path,
                    kind: UpdateKind::Create,
                }
            }));
        for update in updates {
            subscribers.publish(update);
        }
    }
    recovery.report();
    Ok(())
}

fn register_subtree(
    input: &Input,
    directory: &Path,
    watcher: &mut Box<dyn Watcher + Send>,
    known: &mut HashSet<PathBuf>,
    watched: &mut HashSet<PathBuf>,
    matcher: &mut IgnoreMatcher,
    discovered: &mut Vec<PathBuf>,
) -> io::Result<InventoryOutcome> {
    let mut outcome = InventoryOutcome {
        completed: true,
        ..InventoryOutcome::default()
    };
    if matcher.matches(&input.path, directory)? {
        return Ok(outcome);
    }
    if !watched.contains(directory) {
        if let Err(error) = watcher.watch(directory, RecursiveMode::NonRecursive) {
            let error = backend_error(error);
            return if outcome.recover(&error) {
                Ok(outcome)
            } else {
                Err(error)
            };
        }
        watched.insert(directory.to_owned());
    }
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if outcome.recover(&error) => return Ok(outcome),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) if outcome.recover(&error) => continue,
            Err(error) => return Err(error),
        };
        let path = normalize(&entry.path());
        if matcher.matches(&input.path, &path)? {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) if outcome.recover(&error) => continue,
            Err(error) => return Err(error),
        };
        if known.insert(path.clone()) {
            discovered.push(path.clone());
        }
        if file_type.is_dir() {
            let child =
                register_subtree(input, &path, watcher, known, watched, matcher, discovered)?;
            outcome.missing = outcome.missing.saturating_add(child.missing);
            outcome.denied = outcome.denied.saturating_add(child.denied);
        }
    }
    Ok(outcome)
}

fn make<W: Watcher + Send + 'static>(
    input: &Input,
    subscribers: Arc<Mutex<Subscribers>>,
    config: Config,
) -> io::Result<Box<dyn Watcher + Send>> {
    if input.kind != Kind::File {
        return Err(io::Error::other(
            "Directory watches must use ignore-pruned subscriptions",
        ));
    }
    let directory = input
        .path
        .parent()
        .ok_or_else(|| io::Error::other("File watch has no parent"))?
        .to_path_buf();
    let callback = FileCallback {
        subscribers,
        target: input.path.clone(),
    };
    let mut watcher =
        W::new(move |event| callback.receive(event), config).map_err(backend_error)?;
    watcher
        .watch(&directory, RecursiveMode::NonRecursive)
        .map_err(backend_error)?;
    Ok(Box::new(watcher))
}

enum IgnorePattern {
    Absolute(PathBuf),
    Relative { raw: String, pattern: glob::Pattern },
}

struct IgnoreMatcher {
    patterns: Vec<IgnorePattern>,
}

impl IgnoreMatcher {
    fn compile(ignore: &[String]) -> io::Result<Self> {
        Ok(Self {
            patterns: ignore
                .iter()
                .map(|pattern| {
                    if Path::new(pattern).is_absolute() {
                        return Ok(IgnorePattern::Absolute(PathBuf::from(pattern)));
                    }
                    Ok(IgnorePattern::Relative {
                        raw: pattern.clone(),
                        pattern: glob::Pattern::compile(pattern)?,
                    })
                })
                .collect::<io::Result<Vec<_>>>()?,
        })
    }

    fn matches(&mut self, root: &Path, path: &Path) -> io::Result<bool> {
        let mut relative: Option<String> = None;
        for pattern in &mut self.patterns {
            let matched = match pattern {
                IgnorePattern::Absolute(directory) => contains(directory, path),
                IgnorePattern::Relative { raw, pattern } => {
                    let relative = relative.get_or_insert_with(|| {
                        path.strip_prefix(root)
                            .unwrap_or(path)
                            .to_string_lossy()
                            .replace('\\', "/")
                    });
                    pattern.matches(relative)?
                        || relative.split('/').any(|part| part == raw.as_str())
                }
            };
            if matched {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

#[derive(Default)]
struct InventoryOutcome {
    completed: bool,
    missing: u64,
    denied: u64,
}

impl InventoryOutcome {
    fn recover(&mut self, error: &io::Error) -> bool {
        match error.kind() {
            io::ErrorKind::NotFound => self.missing = self.missing.saturating_add(1),
            io::ErrorKind::PermissionDenied => self.denied = self.denied.saturating_add(1),
            _ => return false,
        }
        true
    }

    fn report(&self) {
        if self.missing > 0 || self.denied > 0 {
            tracing::warn!(
                component = "watcher",
                missing = self.missing,
                denied = self.denied,
                "watcher inventory recovery summary"
            );
        }
    }
}

fn inventory(
    matcher: &mut IgnoreMatcher,
    root: &Path,
    directory: &Path,
    known: &mut HashSet<PathBuf>,
    directories: &mut Vec<PathBuf>,
    stop: Option<&std::sync::mpsc::Receiver<()>>,
    snapshot_at: Option<std::time::SystemTime>,
) -> io::Result<InventoryOutcome> {
    let mut outcome = InventoryOutcome {
        completed: true,
        ..InventoryOutcome::default()
    };
    if stop.is_some_and(stop_requested) {
        outcome.completed = false;
        return Ok(outcome);
    }
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if snapshot_at.is_some() && outcome.recover(&error) => return Ok(outcome),
        Err(error) => return Err(error),
    };
    let entries = entries.collect::<Vec<_>>();
    let entries_unchanged = snapshot_at.is_some_and(|snapshot_at| {
        status_changed(directory).is_some_and(|changed| changed <= snapshot_at)
    });
    for entry in entries {
        if stop.is_some_and(stop_requested) {
            outcome.completed = false;
            return Ok(outcome);
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) if snapshot_at.is_some() && outcome.recover(&error) => continue,
            Err(error) => return Err(error),
        };
        let path = entry.path();
        if matcher.matches(root, &path)? {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) if snapshot_at.is_some() && outcome.recover(&error) => continue,
            Err(error) => return Err(error),
        };
        if entries_unchanged
            || !snapshot_at.is_some_and(|snapshot_at| {
                status_changed(&path).is_some_and(|changed| changed > snapshot_at)
            })
        {
            known.insert(path.clone());
        }
        if file_type.is_dir() {
            directories.push(path.clone());
            let child = inventory(matcher, root, &path, known, directories, stop, snapshot_at)?;
            outcome.missing = outcome.missing.saturating_add(child.missing);
            outcome.denied = outcome.denied.saturating_add(child.denied);
            if !child.completed {
                outcome.completed = false;
                return Ok(outcome);
            }
        }
    }
    Ok(outcome)
}

#[cfg(unix)]
fn status_changed(path: &Path) -> Option<std::time::SystemTime> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::symlink_metadata(path).ok()?;
    std::time::SystemTime::UNIX_EPOCH.checked_add(Duration::new(
        metadata.ctime().try_into().ok()?,
        metadata.ctime_nsec().try_into().ok()?,
    ))
}

#[cfg(not(unix))]
fn status_changed(_path: &Path) -> Option<std::time::SystemTime> {
    None
}

impl Subscription {
    pub async fn recv(&mut self) -> io::Result<Update> {
        self.receiver.recv().await.ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotConnected, "Watcher subscription closed")
        })?
    }
}

pub struct LocationWatcher {
    pub event_source: crate::event_feed::EventSource,
    root: Option<Subscription>,
    git: Option<Subscription>,
}

impl LocationWatcher {
    pub fn start(
        watcher: &Service,
        git: &git::Service,
        directory: &Path,
        home: &Path,
        platform: &str,
        vcs: bool,
        configured: &[String],
    ) -> io::Result<Self> {
        let directory = normalize(&std::path::absolute(directory)?);
        let is_home = directory == normalize(&std::path::absolute(home)?);
        let root = if !is_home && vcs {
            let ignores = ignore::patterns()
                .into_iter()
                .chain(configured.iter().cloned())
                .chain(
                    protected::paths(platform, home)
                        .into_iter()
                        .filter(|path| path != &directory && contains(&directory, path))
                        .map(|path| path.to_string_lossy().into_owned()),
                )
                .collect();
            Some(watcher.subscribe(Input {
                path: directory.clone(),
                kind: Kind::Directory,
                ignore: ignores,
            })?)
        } else {
            None
        };
        let repository = if vcs {
            git.discover(&directory).map_err(io::Error::other)?
        } else {
            None
        };
        let git = if let Some(repository) = repository {
            let resolved = &repository.git_directory;
            let canonical = fs::canonicalize(resolved).unwrap_or_else(|_| resolved.clone());
            if configured.iter().any(|item| {
                item == ".git" || Path::new(item) == resolved || Path::new(item) == canonical
            }) {
                None
            } else {
                let ignores = fs::read_dir(&canonical)
                    .map(|entries| {
                        entries
                            .filter_map(Result::ok)
                            .filter(|entry| entry.file_name() != "HEAD")
                            .map(|entry| entry.file_name().to_string_lossy().into_owned())
                            .collect()
                    })
                    .unwrap_or_default();
                Some(watcher.subscribe(Input {
                    path: canonical,
                    kind: Kind::Directory,
                    ignore: ignores,
                })?)
            }
        } else {
            None
        };
        Ok(Self {
            root,
            git,
            event_source: Default::default(),
        })
    }

    pub async fn recv(&mut self) -> io::Result<ChangedData> {
        let update = match (&mut self.root, &mut self.git) {
            (Some(root), Some(git)) => {
                tokio::select! { update = root.recv() => update?, update = git.recv() => update? }
            }
            (Some(root), None) => root.recv().await?,
            (None, Some(git)) => git.recv().await?,
            (None, None) => {
                return Err(io::Error::new(
                    io::ErrorKind::NotConnected,
                    "Location has no watcher subscriptions",
                ));
            }
        };
        let data = ChangedData {
            file: update.path.to_string_lossy().into_owned().into(),
            event: match update.kind {
                UpdateKind::Create => ChangedKind::Add,
                UpdateKind::Update => ChangedKind::Change,
                UpdateKind::Delete => ChangedKind::Unlink,
            },
        };
        self.event_source
            .emit(crate::event_feed::Data::FilesystemChanged(Box::new(
                data.clone(),
            )))
            .map_err(io::Error::other)?;
        Ok(data)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Config, Input, Kind, PollWatcher, RecommendedWatcher, SUBSCRIBE_TIMEOUT, Service,
        Subscribers, UpdateKind, initialize, setup_directory, spawn_directory_watcher, start,
    };
    use std::{
        fs, io,
        sync::{Arc, Barrier, Mutex, mpsc},
        time::Duration,
    };

    #[derive(Clone, Default)]
    struct Logs(Arc<Mutex<Vec<u8>>>);

    impl io::Write for Logs {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn controlled_directory(
        input: &Input,
        inventory_pending: bool,
        recursive: bool,
        events: mpsc::Receiver<notify::Result<notify::Event>>,
    ) -> Arc<super::Entry> {
        let subscribers = Arc::new(Mutex::new(Subscribers::default()));
        let setup = super::DirectorySetup {
            watcher: Box::new(
                PollWatcher::new(|_: notify::Result<notify::Event>| {}, Config::default()).unwrap(),
            ),
            events,
            known: Default::default(),
            watched: Default::default(),
            recursive,
            matcher: super::IgnoreMatcher::compile(&input.ignore).unwrap(),
            inventory_pending,
            registered_at: Some(std::time::SystemTime::now()),
        };
        let directory = spawn_directory_watcher(input, subscribers.clone(), setup);
        Arc::new(super::Entry {
            subscribers,
            _watcher: super::WatcherOwner {
                _native: None,
                _directory: Some(directory),
            },
        })
    }

    #[tokio::test]
    async fn recoverable_inventory_emits_one_count_only_summary_and_keeps_receiving_updates() {
        let logs = Logs::default();
        let writer = logs.clone();
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();
        let service = Service::new(true);
        let input = Input {
            path: std::env::temp_dir().join(format!(
                "ycoding-watch-private-missing-{}",
                std::process::id()
            )),
            kind: Kind::Directory,
            ignore: vec![],
        };
        assert!(!input.path.exists());
        let (backend, events) = mpsc::channel();
        let mut subscription = tracing::subscriber::with_default(subscriber, || {
            service
                .subscribe_with(input.clone(), |input| {
                    Ok(controlled_directory(input, true, true, events))
                })
                .unwrap()
        });
        let visible = input.path.join("visible");
        backend
            .send(Ok(notify::Event::new(notify::EventKind::Create(
                notify::event::CreateKind::File,
            ))
            .add_path(visible.clone())))
            .unwrap();
        let update = subscription.recv().await.unwrap();
        assert_eq!(update.path, visible);
        assert_eq!(update.kind, UpdateKind::Create);
        drop(subscription);
        let bytes = logs.0.lock().unwrap();
        let text = std::str::from_utf8(&bytes).unwrap();
        assert_eq!(text.lines().count(), 1, "{text}");
        assert!(text.contains("watcher inventory recovery summary"));
        assert!(text.contains("missing=1"));
        assert!(text.contains("denied=0"));
        assert!(!text.contains("watch-private-missing"));
        assert!(!text.contains("watcher terminated"));
    }

    #[test]
    fn native_startup_recovery_logs_only_the_error_kind() {
        let logs = Logs::default();
        let writer = logs.clone();
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            start(
                SUBSCRIBE_TIMEOUT,
                || {
                    Err::<(), _>(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "synthetic private native startup detail",
                    ))
                },
                || Ok(()),
            )
            .unwrap();
        });
        let bytes = logs.0.lock().unwrap();
        let text = std::str::from_utf8(&bytes).unwrap();
        assert_eq!(text.lines().count(), 1, "{text}");
        assert!(text.contains("native watcher startup failed; using polling fallback"));
        assert!(text.contains("error_kind=PermissionDenied"));
        assert!(!text.contains("synthetic private native startup detail"));
    }

    #[test]
    fn backend_error_translation_preserves_recoverable_kinds_and_terminal_causes() {
        let cases = [
            (notify::Error::path_not_found(), io::ErrorKind::NotFound),
            (notify::Error::watch_not_found(), io::ErrorKind::NotFound),
            (
                notify::Error::io(io::Error::from(io::ErrorKind::PermissionDenied)),
                io::ErrorKind::PermissionDenied,
            ),
            (
                notify::Error::generic("synthetic backend detail"),
                io::ErrorKind::Other,
            ),
            (
                notify::Error::new(notify::ErrorKind::MaxFilesWatch),
                io::ErrorKind::Other,
            ),
            (
                notify::Error::invalid_config(&Config::default()),
                io::ErrorKind::InvalidInput,
            ),
        ];
        for (error, kind) in cases {
            let message = error.to_string();
            let translated = super::backend_error(error);
            assert_eq!(translated.kind(), kind);
            assert_eq!(translated.to_string(), message);
        }
    }

    #[tokio::test]
    async fn event_inventory_recovers_missing_paths_then_propagates_unexpected_errors_in_order() {
        let root = std::env::temp_dir().join(format!(
            "ycoding-watch-event-inventory-{}",
            std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        let blocker = root.join("blocker");
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&blocker)
            .unwrap();
        let input = Input {
            path: root.clone(),
            kind: Kind::Directory,
            ignore: vec![],
        };
        let service = Service::new(true);
        let (backend, events) = mpsc::channel();
        let mut subscription = service
            .subscribe_with(input, |input| {
                Ok(controlled_directory(input, false, false, events))
            })
            .unwrap();
        let missing = root.join("missing");
        for path in [missing.clone(), blocker.join("child")] {
            backend
                .send(Ok(notify::Event::new(notify::EventKind::Create(
                    notify::event::CreateKind::File,
                ))
                .add_path(path)))
                .unwrap();
        }
        let update = subscription.recv().await.unwrap();
        assert_eq!(update.path, missing);
        assert_eq!(update.kind, UpdateKind::Create);
        assert_eq!(
            subscription.recv().await.unwrap_err().kind(),
            io::ErrorKind::NotADirectory
        );
        assert_eq!(
            subscription.recv().await.unwrap_err().kind(),
            io::ErrorKind::NotConnected
        );
        drop(subscription);
        assert_eq!(service.active_count().unwrap(), 0);
        fs::remove_file(blocker).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn inventory_recovery_counts_only_missing_and_denied_errors_without_retaining_details() {
        let mut outcome = super::InventoryOutcome::default();
        for kind in [io::ErrorKind::NotFound, io::ErrorKind::PermissionDenied] {
            assert!(outcome.recover(&io::Error::new(kind, "synthetic private detail")));
        }
        assert_eq!((outcome.missing, outcome.denied), (1, 1));
        for kind in [io::ErrorKind::InvalidData, io::ErrorKind::NotADirectory] {
            assert!(!outcome.recover(&io::Error::new(kind, "synthetic private detail")));
        }
        assert_eq!((outcome.missing, outcome.denied), (1, 1));
        outcome.missing = u64::MAX;
        assert!(outcome.recover(&io::Error::from(io::ErrorKind::NotFound)));
        assert_eq!(outcome.missing, u64::MAX);
    }

    #[test]
    fn cancelled_inventory_stops_before_reading_or_reporting_recoveries() {
        let root = std::env::temp_dir().join(format!(
            "ycoding-watch-cancelled-inventory-{}",
            std::process::id()
        ));
        assert!(!root.exists());
        for requested in [true, false] {
            let (stop, stopping) = mpsc::channel();
            if requested {
                stop.send(()).unwrap();
            }
            drop(stop);
            let mut matcher = super::IgnoreMatcher::compile(&[]).unwrap();
            let mut known = Default::default();
            let mut directories = Vec::new();
            let outcome = super::inventory(
                &mut matcher,
                &root,
                &root,
                &mut known,
                &mut directories,
                Some(&stopping),
                Some(std::time::SystemTime::now()),
            )
            .unwrap();
            assert!(!outcome.completed);
            assert_eq!((outcome.missing, outcome.denied), (0, 0));
            assert!(known.is_empty());
            assert!(directories.is_empty());
        }
    }

    #[tokio::test]
    async fn terminal_inventory_and_backend_channel_failures_reach_subscription_recv() {
        let root = std::env::temp_dir().join(format!(
            "ycoding-watch-terminal-inventory-{}",
            std::process::id()
        ));
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&root)
            .unwrap();
        for inventory_pending in [true, false] {
            let input = Input {
                path: root.clone(),
                kind: Kind::Directory,
                ignore: vec![],
            };
            let service = Service::new(true);
            let (backend, events) = mpsc::channel();
            let mut subscription = service
                .subscribe_with(input, |input| {
                    Ok(controlled_directory(input, inventory_pending, true, events))
                })
                .unwrap();
            drop(backend);
            let error = subscription.recv().await.unwrap_err();
            assert_eq!(
                error.kind(),
                if inventory_pending {
                    io::ErrorKind::NotADirectory
                } else {
                    io::ErrorKind::BrokenPipe
                }
            );
            assert_eq!(
                subscription.recv().await.unwrap_err().kind(),
                io::ErrorKind::NotConnected
            );
            drop(subscription);
            assert_eq!(service.active_count().unwrap(), 0);
        }
        fs::remove_file(root).unwrap();
    }

    #[tokio::test]
    async fn terminal_backend_errors_preserve_prior_updates_and_reach_shared_and_late_receivers() {
        let input = Input {
            path: std::env::temp_dir().join("ycoding-watch-terminal-callback"),
            kind: Kind::Directory,
            ignore: vec![],
        };
        let service = Service::new(true);
        let (backend, events) = mpsc::channel();
        let mut first = service
            .subscribe_with(input.clone(), |input| {
                Ok(controlled_directory(input, false, true, events))
            })
            .unwrap();
        let mut second = service
            .subscribe_with(input.clone(), |_| {
                panic!("shared watcher initialized twice")
            })
            .unwrap();
        let visible = input.path.join("visible");
        backend
            .send(Ok(notify::Event::new(notify::EventKind::Create(
                notify::event::CreateKind::File,
            ))
            .add_path(visible.clone())))
            .unwrap();
        backend
            .send(Err(notify::Error::generic("synthetic backend failure")))
            .unwrap();
        for subscription in [&mut first, &mut second] {
            let update = subscription.recv().await.unwrap();
            assert_eq!(update.path, visible);
            assert_eq!(update.kind, UpdateKind::Create);
            let error = subscription.recv().await.unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::Other);
            assert!(error.to_string().contains("synthetic backend failure"));
            assert_eq!(
                subscription.recv().await.unwrap_err().kind(),
                io::ErrorKind::NotConnected
            );
        }
        let mut late = service
            .subscribe_with(input, |_| {
                panic!("terminal watcher replaced while subscriptions remain")
            })
            .unwrap();
        assert!(
            late.recv()
                .await
                .unwrap_err()
                .to_string()
                .contains("synthetic backend failure")
        );
    }

    #[tokio::test]
    async fn file_callback_failure_and_unexpected_close_are_terminal_but_entry_drop_is_not() {
        for fails in [true, false] {
            let subscribers = Arc::new(Mutex::new(Subscribers::default()));
            let input = Input {
                path: std::env::temp_dir().join("ycoding-watch-file-callback"),
                kind: Kind::File,
                ignore: vec![],
            };
            let callback = super::FileCallback {
                subscribers: subscribers.clone(),
                target: input.path.clone(),
            };
            let entry = Arc::new(super::Entry {
                subscribers: subscribers.clone(),
                _watcher: super::WatcherOwner {
                    _native: None,
                    _directory: None,
                },
            });
            let service = Service::new(true);
            let mut subscription = service.subscribe_with(input, |_| Ok(entry)).unwrap();
            if fails {
                callback.receive(Err(notify::Error::generic(
                    "synthetic file callback failure",
                )));
            }
            drop(callback);
            assert_eq!(
                subscription.recv().await.unwrap_err().kind(),
                if fails {
                    io::ErrorKind::Other
                } else {
                    io::ErrorKind::BrokenPipe
                }
            );
            assert_eq!(
                subscription.recv().await.unwrap_err().kind(),
                io::ErrorKind::NotConnected
            );
            drop(subscription);
        }
        let subscribers = Arc::new(Mutex::new(Subscribers::default()));
        let callback = super::FileCallback {
            subscribers: subscribers.clone(),
            target: std::env::temp_dir(),
        };
        drop(super::Entry {
            subscribers: subscribers.clone(),
            _watcher: super::WatcherOwner {
                _native: None,
                _directory: None,
            },
        });
        drop(callback);
        assert!(subscribers.lock().unwrap().failure.is_none());
    }

    #[tokio::test]
    async fn native_failure_fallback_recursively_reports_real_changes_and_filters_ignores() {
        let root =
            std::env::temp_dir().join(format!("ycoding-watch-fallback-{}", std::process::id()));
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::create_dir_all(root.join("ignored")).unwrap();
        let input = Input {
            path: root.clone(),
            kind: Kind::Directory,
            ignore: vec!["ignored".into()],
        };
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let subscribers = Arc::new(Mutex::new(Subscribers {
            senders: vec![sender],
            ..Subscribers::default()
        }));
        let setup = setup_directory::<PollWatcher>(
            &input,
            Config::default()
                .with_poll_interval(Duration::from_millis(10))
                .with_compare_contents(true),
            false,
        )
        .unwrap();
        assert!(!setup.watched.contains(&root.join("ignored")));
        let watcher = spawn_directory_watcher(&input, subscribers, setup);
        fs::write(root.join("ignored/hidden"), "hidden").unwrap();
        fs::write(root.join("nested/visible"), "visible").unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let event = receiver.recv().await.unwrap().unwrap();
                assert!(!event.path.starts_with(root.join("ignored")));
                if event.path == root.join("nested/visible") {
                    assert_eq!(event.kind, UpdateKind::Create);
                    break;
                }
            }
        })
        .await
        .unwrap();
        for (path, kind) in [
            (root.join("new"), UpdateKind::Create),
            (root.join("new/deep"), UpdateKind::Create),
        ] {
            fs::create_dir(&path).unwrap();
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    let event = receiver.recv().await.unwrap().unwrap();
                    assert!(!event.path.starts_with(root.join("ignored")));
                    if event.path == path && event.kind == kind {
                        break;
                    }
                }
            })
            .await
            .unwrap();
        }
        let nested = root.join("new/deep/later");
        fs::write(&nested, "later").unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let event = receiver.recv().await.unwrap().unwrap();
                assert!(!event.path.starts_with(root.join("ignored")));
                if event.path == nested && event.kind == UpdateKind::Create {
                    break;
                }
            }
        })
        .await
        .unwrap();
        let staged = root.with_extension("staged");
        fs::create_dir_all(staged.join("inner/ignored")).unwrap();
        fs::write(staged.join("inner/file"), "file").unwrap();
        fs::write(staged.join("inner/ignored/hidden"), "hidden").unwrap();
        fs::rename(&staged, root.join("moved")).unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let event = receiver.recv().await.unwrap().unwrap();
                assert!(!event.path.starts_with(root.join("ignored")));
                assert!(!event.path.starts_with(root.join("moved/inner/ignored")));
                if event.path == root.join("moved/inner/file") {
                    assert_eq!(event.kind, UpdateKind::Create);
                    break;
                }
            }
        })
        .await
        .unwrap();
        drop(watcher);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn native_errors_and_ten_second_timeout_select_recursive_fallback_and_release_late_native() {
        assert_eq!(SUBSCRIBE_TIMEOUT, Duration::from_secs(10));
        assert_eq!(
            start(
                Duration::from_secs(1),
                || Err::<usize, _>(io::Error::other("native failed")),
                || Ok(7)
            )
            .unwrap(),
            7
        );
        struct Native(mpsc::Sender<()>);
        impl Drop for Native {
            fn drop(&mut self) {
                self.0.send(()).unwrap();
            }
        }
        let (release, resumed) = mpsc::channel();
        let (dropped, observed) = mpsc::channel();
        let value = start(
            Duration::from_millis(20),
            move || {
                resumed.recv().unwrap();
                Ok(Some(Native(dropped)))
            },
            || Ok(None),
        )
        .unwrap();
        assert!(value.is_none());
        release.send(()).unwrap();
        observed.recv_timeout(Duration::from_secs(2)).unwrap();
    }

    #[test]
    fn different_watch_identities_initialize_independently_and_same_identity_shares() {
        let root =
            std::env::temp_dir().join(format!("ycoding-watch-acquire-{}", std::process::id()));
        fs::create_dir_all(root.join("first")).unwrap();
        fs::create_dir_all(root.join("second")).unwrap();
        let service = Arc::new(Service::new(true));
        let first = Input {
            path: root.join("first"),
            kind: Kind::Directory,
            ignore: vec![],
        };
        let second = Input {
            path: root.join("second"),
            kind: Kind::Directory,
            ignore: vec![],
        };
        let (blocked, observed) = mpsc::channel();
        let gate = Arc::new(Barrier::new(2));
        let worker_service = service.clone();
        let worker_gate = gate.clone();
        let worker_first = first.clone();
        let worker = std::thread::spawn(move || {
            worker_service
                .subscribe_with(worker_first, |input| {
                    blocked.send(()).unwrap();
                    worker_gate.wait();
                    initialize(input)
                })
                .unwrap()
        });
        observed.recv_timeout(Duration::from_secs(2)).unwrap();
        let (done, finished) = mpsc::channel();
        let worker_service = service.clone();
        let independent =
            std::thread::spawn(move || done.send(worker_service.subscribe(second)).unwrap());
        let completed = finished.recv_timeout(Duration::from_secs(2));
        gate.wait();
        let first_subscription = worker.join().unwrap();
        independent.join().unwrap();
        let second_subscription = completed.unwrap().unwrap();
        let shared = service
            .subscribe_with(first, |_| panic!("same identity initialized twice"))
            .unwrap();
        assert_eq!(service.active_count().unwrap(), 2);
        drop((first_subscription, second_subscription, shared));
        assert_eq!(service.active_count().unwrap(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn recursive_native_setup_is_ready_without_inventorying_the_tree() {
        let root = std::env::temp_dir().join(format!(
            "ycoding-watch-recursive-ready-{}",
            std::process::id()
        ));
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::create_dir_all(root.join("locked")).unwrap();
        let existing = root.join("nested/existing.txt");
        fs::write(&existing, "existing").unwrap();
        fs::write(root.join("locked/inside.txt"), "inside").unwrap();
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o000)).unwrap();
        }
        let input = Input {
            path: root.clone(),
            kind: Kind::Directory,
            ignore: vec![],
        };
        let setup = setup_directory::<RecommendedWatcher>(&input, Config::default(), true)
            .expect("recursive native setup must not depend on reading the whole tree");
        assert!(
            setup.known.is_empty(),
            "recursive native readiness waited on a full inventory: {:?}",
            setup.known
        );
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let subscribers = Arc::new(Mutex::new(Subscribers {
            senders: vec![sender],
            ..Subscribers::default()
        }));
        let watcher = spawn_directory_watcher(&input, subscribers, setup);
        async fn next(
            receiver: &mut tokio::sync::mpsc::UnboundedReceiver<io::Result<super::Update>>,
            path: &std::path::Path,
            kind: UpdateKind,
        ) {
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let event = receiver.recv().await.unwrap().unwrap();
                    if event.path == path && event.kind == kind {
                        break;
                    }
                }
            })
            .await
            .unwrap();
        }
        let created = root.join("nested/created.txt");
        fs::write(&created, "created").unwrap();
        next(&mut receiver, &created, UpdateKind::Create).await;
        fs::write(&created, "updated").unwrap();
        next(&mut receiver, &created, UpdateKind::Update).await;
        fs::write(&existing, "changed").unwrap();
        next(&mut receiver, &existing, UpdateKind::Update).await;
        let renamed = root.join("nested/renamed.txt");
        fs::rename(&existing, &renamed).unwrap();
        next(&mut receiver, &existing, UpdateKind::Delete).await;
        next(&mut receiver, &renamed, UpdateKind::Create).await;
        fs::remove_file(&renamed).unwrap();
        next(&mut receiver, &renamed, UpdateKind::Delete).await;
        drop(watcher);
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o755));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn startup_snapshot_classifies_paths_changed_before_the_scan_reaches_them() {
        use super::{EventKind, ModifyKind, inventory, process_directory_event};
        use notify::event::RenameMode;
        let root = std::env::temp_dir().join(format!(
            "ycoding-watch-startup-snapshot-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        for directory in ["nested", "churn", "source"] {
            fs::create_dir_all(root.join(directory)).unwrap();
        }
        let existing = root.join("nested/existing.txt");
        let untouched = root.join("churn/untouched.txt");
        let edited = root.join("churn/edited.txt");
        let source = root.join("source/moved.txt");
        for path in [&existing, &untouched, &edited, &source] {
            fs::write(path, "before").unwrap();
        }
        let input = Input {
            path: root.clone(),
            kind: Kind::Directory,
            ignore: vec![],
        };
        let mut setup =
            setup_directory::<RecommendedWatcher>(&input, Config::default(), true).unwrap();
        fs::write(&existing, "after").unwrap();
        fs::write(&edited, "after").unwrap();
        let moved = root.join("churn/moved.txt");
        fs::rename(&source, &moved).unwrap();
        let (_stop, stopping) = mpsc::channel();
        assert!(
            inventory(
                &mut setup.matcher,
                &root,
                &root,
                &mut setup.known,
                &mut Vec::new(),
                Some(&stopping),
                setup.registered_at,
            )
            .unwrap()
            .completed
        );
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let subscribers = Arc::new(Mutex::new(Subscribers {
            senders: vec![sender],
            ..Subscribers::default()
        }));
        let mut classify = |path: &std::path::Path| {
            process_directory_event(
                &input,
                &mut setup,
                &subscribers,
                notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Any)))
                    .add_path(path.to_path_buf()),
            )
            .unwrap();
            receiver.try_recv().unwrap().unwrap().kind
        };
        assert_eq!(
            classify(&existing),
            UpdateKind::Update,
            "a pre-existing file written in place before the scan reached it is a change"
        );
        assert_eq!(classify(&untouched), UpdateKind::Update);
        assert_eq!(
            classify(&moved),
            UpdateKind::Create,
            "a rename that lands before the scan reaches its directory is a creation"
        );
        assert_eq!(
            classify(&edited),
            UpdateKind::Create,
            "a file changed while its directory's entries also changed is reported as added first"
        );
        assert_eq!(classify(&edited), UpdateKind::Update);
        drop(setup);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn startup_snapshot_skips_unreadable_directories_and_keeps_scanning() {
        use super::inventory;
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!(
            "ycoding-watch-startup-unreadable-{}",
            std::process::id()
        ));
        let locked = root.join("locked");
        if locked.exists() {
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&locked).unwrap();
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(locked.join("inside.txt"), "inside").unwrap();
        let existing = root.join("nested/existing.txt");
        fs::write(&existing, "existing").unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        let input = Input {
            path: root.clone(),
            kind: Kind::Directory,
            ignore: vec![],
        };
        let mut setup =
            setup_directory::<RecommendedWatcher>(&input, Config::default(), true).unwrap();
        let (_stop, stopping) = mpsc::channel();
        let completed = inventory(
            &mut setup.matcher,
            &root,
            &root,
            &mut setup.known,
            &mut Vec::new(),
            Some(&stopping),
            setup.registered_at,
        );
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        let outcome = completed.unwrap();
        assert!(
            outcome.completed,
            "an unreadable directory must not end the startup snapshot"
        );
        assert!(setup.known.contains(&existing));
        assert!(setup.known.contains(&locked));
        drop(setup);
        fs::remove_dir_all(root).unwrap();
    }
}
