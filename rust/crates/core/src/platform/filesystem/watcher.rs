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
    subscribers: Arc<Mutex<Vec<mpsc::UnboundedSender<Update>>>>,
    _watcher: WatcherOwner,
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
    receiver: mpsc::UnboundedReceiver<Update>,
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
        let (sender, receiver) = mpsc::unbounded_channel();
        entry
            .subscribers
            .lock()
            .map_err(|_| io::Error::other("Watcher subscriber lock poisoned"))?
            .push(sender);
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
    match receiver.recv_timeout(timeout) {
        Ok(Ok(watcher)) => Ok(watcher),
        result => {
            eprintln!(
                "Native watcher startup failed; using polling fallback: {}",
                match result {
                    Ok(Err(error)) => error.to_string(),
                    Err(error) => error.to_string(),
                    Ok(Ok(_)) => unreachable!(),
                }
            );
            fallback()
        }
    }
}

fn initialize(input: &Input) -> io::Result<Arc<Entry>> {
    let subscribers = Arc::new(Mutex::new(Vec::new()));
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
    .map_err(io::Error::other)?;
    let mut known = HashSet::new();
    let mut directories = vec![input.path.clone()];
    inventory(
        input,
        &input.path,
        &input.path,
        &mut known,
        &mut directories,
    )?;
    let mut watched = HashSet::new();
    if recursive {
        watcher
            .watch(&input.path, RecursiveMode::Recursive)
            .map_err(io::Error::other)?;
    } else {
        for directory in directories {
            watcher
                .watch(&directory, RecursiveMode::NonRecursive)
                .map_err(io::Error::other)?;
            watched.insert(directory);
        }
    }
    Ok(DirectorySetup {
        watcher: Box::new(watcher),
        events,
        known,
        watched,
        recursive,
    })
}

fn initialize_directory(
    input: &Input,
    subscribers: Arc<Mutex<Vec<mpsc::UnboundedSender<Update>>>>,
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
    subscribers: Arc<Mutex<Vec<mpsc::UnboundedSender<Update>>>>,
    mut setup: DirectorySetup,
) -> DirectoryWatcher {
    let (stop, stopping) = std::sync::mpsc::channel();
    let input = input.clone();
    let worker = std::thread::spawn(move || {
        loop {
            if stopping.try_recv().is_ok() {
                break;
            }
            match setup.events.recv_timeout(Duration::from_millis(100)) {
                Ok(Ok(event)) => process_directory_event(
                    &input,
                    &mut setup.watcher,
                    &mut setup.known,
                    &mut setup.watched,
                    setup.recursive,
                    &subscribers,
                    event,
                ),
                Ok(Err(error)) => eprintln!("Watcher callback failed: {error}"),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
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

fn process_directory_event(
    input: &Input,
    watcher: &mut Box<dyn Watcher + Send>,
    known: &mut HashSet<PathBuf>,
    watched: &mut HashSet<PathBuf>,
    recursive: bool,
    subscribers: &Arc<Mutex<Vec<mpsc::UnboundedSender<Update>>>>,
    event: notify::Event,
) {
    if matches!(event.kind, EventKind::Access(_)) {
        return;
    }
    for path in event.paths.into_iter().map(|path| normalize(&path)) {
        if !contains(&input.path, &path) || path == input.path {
            continue;
        }
        match ignored(input, &input.path, &path) {
            Ok(true) => continue,
            Err(error) => {
                eprintln!("Watcher ignore matching failed: {error}");
                continue;
            }
            Ok(false) => {}
        }
        let mut discovered = Vec::new();
        let deleted = matches!(event.kind, EventKind::Remove(_))
            || matches!(event.kind, EventKind::Modify(ModifyKind::Name(_))) && !path.exists();
        let kind = if deleted {
            let mut removed_directories = watched
                .iter()
                .filter(|directory| contains(&path, directory))
                .cloned()
                .collect::<Vec<_>>();
            removed_directories
                .sort_by_key(|directory| std::cmp::Reverse(directory.components().count()));
            for directory in removed_directories {
                if let Err(error) = watcher.unwatch(&directory) {
                    eprintln!("Watcher directory removal failed: {error}");
                }
                watched.remove(&directory);
            }
            known.retain(|entry| !contains(&path, entry));
            UpdateKind::Delete
        } else {
            let kind = match event.kind {
                EventKind::Create(_) => {
                    known.insert(path.clone());
                    UpdateKind::Create
                }
                EventKind::Modify(ModifyKind::Name(_)) if known.insert(path.clone()) => {
                    UpdateKind::Create
                }
                _ => {
                    known.insert(path.clone());
                    UpdateKind::Update
                }
            };
            if !recursive
                && fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_dir())
                && let Err(error) =
                    register_subtree(input, &path, watcher, known, watched, &mut discovered)
            {
                eprintln!("Watcher directory registration failed: {error}");
            }
            kind
        };
        if let Ok(mut subscribers) = subscribers.lock() {
            let updates =
                std::iter::once(Update { path, kind }).chain(discovered.into_iter().map(|path| {
                    Update {
                        path,
                        kind: UpdateKind::Create,
                    }
                }));
            for update in updates {
                subscribers.retain(|subscriber| subscriber.send(update.clone()).is_ok());
            }
        }
    }
}

fn register_subtree(
    input: &Input,
    directory: &Path,
    watcher: &mut Box<dyn Watcher + Send>,
    known: &mut HashSet<PathBuf>,
    watched: &mut HashSet<PathBuf>,
    discovered: &mut Vec<PathBuf>,
) -> io::Result<()> {
    if ignored(input, &input.path, directory)? {
        return Ok(());
    }
    if watched.insert(directory.to_owned()) {
        watcher
            .watch(directory, RecursiveMode::NonRecursive)
            .map_err(io::Error::other)?;
    }
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = normalize(&entry.path());
        if ignored(input, &input.path, &path)? {
            continue;
        }
        if known.insert(path.clone()) {
            discovered.push(path.clone());
        }
        if entry.file_type()?.is_dir() {
            register_subtree(input, &path, watcher, known, watched, discovered)?;
        }
    }
    Ok(())
}

fn make<W: Watcher + Send + 'static>(
    input: &Input,
    subscribers: Arc<Mutex<Vec<mpsc::UnboundedSender<Update>>>>,
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
    let publish = subscribers;
    let target = input.path.clone();
    let mut watcher = W::new(
        move |event: notify::Result<notify::Event>| {
            let event = match event {
                Ok(event) => event,
                Err(error) => {
                    eprintln!("Watcher callback failed: {error}");
                    return;
                }
            };
            if matches!(event.kind, EventKind::Access(_)) {
                return;
            }
            for path in event.paths {
                let path = normalize(&path);
                if path != target {
                    continue;
                }
                if let Ok(mut subscribers) = publish.lock() {
                    let update = Update {
                        path,
                        kind: UpdateKind::Update,
                    };
                    subscribers.retain(|subscriber| subscriber.send(update.clone()).is_ok());
                }
            }
        },
        config,
    )
    .map_err(io::Error::other)?;
    watcher
        .watch(&directory, RecursiveMode::NonRecursive)
        .map_err(io::Error::other)?;
    Ok(Box::new(watcher))
}

fn ignored(input: &Input, root: &Path, path: &Path) -> io::Result<bool> {
    let relative = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    input.ignore.iter().try_fold(false, |matched, pattern| {
        if matched {
            return Ok(true);
        }
        if Path::new(pattern).is_absolute() {
            return Ok(contains(Path::new(pattern), path));
        }
        Ok(glob::matches(pattern, &relative)? || relative.split('/').any(|part| part == pattern))
    })
}

fn inventory(
    input: &Input,
    root: &Path,
    directory: &Path,
    known: &mut HashSet<PathBuf>,
    directories: &mut Vec<PathBuf>,
) -> io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        if ignored(input, root, &path)? {
            continue;
        }
        known.insert(path.clone());
        if entry.file_type()?.is_dir() {
            directories.push(path.clone());
            inventory(input, root, &path, known, directories)?;
        }
    }
    Ok(())
}

impl Subscription {
    pub async fn recv(&mut self) -> io::Result<Update> {
        self.receiver.recv().await.ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotConnected, "Watcher subscription closed")
        })
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
        Config, Input, Kind, PollWatcher, SUBSCRIBE_TIMEOUT, Service, UpdateKind, initialize,
        setup_directory, spawn_directory_watcher, start,
    };
    use std::{
        fs, io,
        sync::{Arc, Barrier, Mutex, mpsc},
        time::Duration,
    };

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
        let subscribers = Arc::new(Mutex::new(vec![sender]));
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
                let event = receiver.recv().await.unwrap();
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
                    let event = receiver.recv().await.unwrap();
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
                let event = receiver.recv().await.unwrap();
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
                let event = receiver.recv().await.unwrap();
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
}
