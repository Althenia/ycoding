use super::{
    error::{AuthorizationInput, AuthorizeFn, ExecutorError, Grant},
    executor::ExecutorAccess,
    policy::{
        self, PolicyError, ResolveSandboxOptions, SEP, SandboxAccess, SandboxIntent, SandboxPolicy,
        basename, dirname, io_error_code, is_absolute, join, parse_path_uri, real_path,
        resolve_sandbox, to_path_uri,
    },
    signal::HandlerContext,
    value::{LosslessString, Value, concat, utf8_len},
};
use std::{
    collections::{BTreeSet, HashMap},
    io,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tokio::sync::watch;

pub const FILE_READ_CHUNK_SIZE: usize = 1024 * 1024;
pub const FILE_WRITE_CHUNK_SIZE: usize = 1024 * 1024;
pub const MAX_OPEN_FILES: usize = 128;
pub const MAX_FILE_HANDLE_ID_BYTES: usize = 32;
pub const MAX_WALK_DEPTH: u64 = 64;
pub const MAX_WALK_DIRECTORIES: u64 = 10_000;
pub const MAX_WALK_ENTRIES: u64 = 50_000;
pub const MAX_WALK_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
pub const WALK_RESPONSE_ITEM_OVERHEAD_BYTES: usize = 64;
const MAX_SYMLINK_HOPS: usize = 40;
const OUTSIDE_MESSAGE: &str = "Operation not permitted (os error 1)";

#[derive(Clone, Debug)]
pub struct CreateDirectoryParams {
    pub path: String,
    pub recursive: Option<bool>,
    pub follow_symlinks: Option<bool>,
    pub sandbox: Option<Value>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenMode {
    Read,
    Replace,
}
#[derive(Clone, Debug)]
pub struct OpenParams {
    pub handle_id: LosslessString,
    pub path: String,
    pub mode: OpenMode,
    pub sandbox: Option<Value>,
}
#[derive(Clone, Debug)]
pub struct ReadBlockParams {
    pub handle_id: LosslessString,
    pub offset: u64,
    pub len: usize,
}
#[derive(Clone, Debug)]
pub struct ReadBlockResult {
    pub chunk: Vec<u8>,
    pub eof: bool,
}
#[derive(Clone, Debug)]
pub struct WriteBlockParams {
    pub handle_id: LosslessString,
    pub offset: u64,
    pub chunk: Vec<u8>,
}
#[derive(Clone, Debug)]
pub struct CloseParams {
    pub handle_id: LosslessString,
}
#[derive(Clone, Debug)]
pub struct WalkOptions {
    pub max_depth: u64,
    pub max_directories: u64,
    pub max_entries: u64,
    pub follow_directory_symlinks: bool,
    pub prune_hidden_directories: Option<bool>,
}
#[derive(Clone, Debug)]
pub struct WalkParams {
    pub path: String,
    pub options: WalkOptions,
    pub sandbox: Option<Value>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WalkKind {
    Directory,
    File,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WalkEntry {
    pub path: String,
    pub kind: WalkKind,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WalkError {
    pub path: String,
    pub message: LosslessString,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WalkResult {
    pub entries: Vec<WalkEntry>,
    pub errors: Vec<WalkError>,
    pub truncated: bool,
}
#[derive(Clone, Debug)]
pub struct RemoveParams {
    pub path: String,
    pub recursive: Option<bool>,
    pub force: Option<bool>,
    pub follow_symlinks: Option<bool>,
    pub sandbox: Option<Value>,
}
#[derive(Clone, Debug)]
pub struct CopyParams {
    pub source_path: String,
    pub destination_path: String,
    pub recursive: bool,
    pub sandbox: Option<Value>,
}

fn kind_code(error: &io::Error) -> i32 {
    io_error_code(error)
}
pub fn os_error(error: &io::Error) -> ExecutorError {
    if error.raw_os_error().is_none() {
        return ExecutorError::new(-32603, "Filesystem error");
    }
    ExecutorError::new(kind_code(error), error.to_string())
}
fn os_raw(raw: i32) -> ExecutorError {
    os_error(&io::Error::from_raw_os_error(raw))
}
fn policy_failure(error: PolicyError) -> ExecutorError {
    ExecutorError::new(-32602, error.message)
}
fn outside_roots() -> ExecutorError {
    ExecutorError::new(-32600, OUTSIDE_MESSAGE)
}
fn is_outside(error: &ExecutorError) -> bool {
    error.code == -32600 && error.message.as_str() == Some(OUTSIDE_MESSAGE)
}
fn invalid_input(message: impl Into<LosslessString>) -> ExecutorError {
    ExecutorError::new(-32600, message)
}
fn other_error(message: impl Into<LosslessString>) -> ExecutorError {
    ExecutorError::new(-32603, message)
}
fn sandbox_denied() -> ExecutorError {
    ExecutorError::new(-32600, "Permission denied")
}
fn walk_cancelled() -> ExecutorError {
    other_error("filesystem walk cancelled")
}
fn is_not_found(error: &ExecutorError) -> bool {
    error.code == -32004
}
fn within(target: &str, root: &str) -> bool {
    target == root
        || target.starts_with(&if root.ends_with(SEP) {
            root.to_owned()
        } else {
            format!("{root}{SEP}")
        })
}
fn join_unnormalized(base: &str, relative: &str) -> String {
    if is_absolute(relative) {
        relative.to_owned()
    } else if base.ends_with(SEP) {
        format!("{base}{relative}")
    } else {
        format!("{base}{SEP}{relative}")
    }
}

#[cfg(unix)]
fn file_id(metadata: &std::fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (metadata.dev(), metadata.ino())
}
#[cfg(not(unix))]
fn file_id(_metadata: &std::fs::Metadata) -> (u64, u64) {
    (0, 0)
}
#[cfg(unix)]
fn file_mode(metadata: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::MetadataExt;
    metadata.mode() & 0o7777
}
#[cfg(not(unix))]
fn file_mode(_metadata: &std::fs::Metadata) -> u32 {
    0o666
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> io::Result<T> + Send + 'static,
) -> io::Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .unwrap_or_else(|error| Err(io::Error::other(error)))
}
async fn lstat(path: &str) -> io::Result<std::fs::Metadata> {
    tokio::fs::symlink_metadata(path).await
}
async fn lstat_if_present(path: &str) -> Result<Option<std::fs::Metadata>, ExecutorError> {
    match lstat(path).await {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(os_error(&error)),
    }
}

#[derive(Clone)]
struct Pin {
    path: String,
    real: String,
    dev: u64,
    ino: u64,
    directory: bool,
}
fn pin_of(canonical: &str, metadata: &std::fs::Metadata) -> Pin {
    let (dev, ino) = file_id(metadata);
    Pin {
        path: canonical.to_owned(),
        real: canonical.to_owned(),
        dev,
        ino,
        directory: metadata.is_dir(),
    }
}
async fn pin(target: &str, metadata: Option<std::fs::Metadata>) -> Result<Pin, ExecutorError> {
    let current = match metadata {
        Some(metadata) => metadata,
        None => lstat(target).await.map_err(|error| os_error(&error))?,
    };
    let real = real_path(target).await.map_err(|error| os_error(&error))?;
    let (dev, ino) = file_id(&current);
    Ok(Pin {
        path: target.to_owned(),
        real,
        dev,
        ino,
        directory: current.is_dir(),
    })
}
async fn recheck(expected: &Pin) -> Result<(), ExecutorError> {
    let stable = match (lstat(&expected.path).await, real_path(&expected.path).await) {
        (Ok(metadata), Ok(real)) => {
            file_id(&metadata) == (expected.dev, expected.ino) && real == expected.real
        }
        _ => false,
    };
    if stable { Ok(()) } else { Err(outside_roots()) }
}

fn open_verified_blocking(
    target: &str,
    write: bool,
    create: bool,
    mode: u32,
) -> io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    if write {
        options.write(true);
    } else {
        options.read(true);
    }
    if create {
        options.create(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(mode)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(not(unix))]
    let _ = mode;
    options.open(target)
}
async fn open_verified(
    target: &str,
    write: bool,
    create: bool,
    mode: u32,
) -> Result<std::fs::File, ExecutorError> {
    let owned = target.to_owned();
    let file = blocking(move || open_verified_blocking(&owned, write, create, mode))
        .await
        .map_err(|error| os_error(&error))?;
    let metadata = file.metadata().map_err(|error| os_error(&error))?;
    recheck(&pin_of(target, &metadata)).await?;
    Ok(file)
}

#[cfg(unix)]
fn read_at(file: &std::fs::File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
    std::os::unix::fs::FileExt::read_at(file, buffer, offset)
}
#[cfg(unix)]
fn write_at(file: &std::fs::File, buffer: &[u8], offset: u64) -> io::Result<usize> {
    std::os::unix::fs::FileExt::write_at(file, buffer, offset)
}
#[cfg(windows)]
fn read_at(file: &std::fs::File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
    std::os::windows::fs::FileExt::seek_read(file, buffer, offset)
}
#[cfg(windows)]
fn write_at(file: &std::fs::File, buffer: &[u8], offset: u64) -> io::Result<usize> {
    std::os::windows::fs::FileExt::seek_write(file, buffer, offset)
}

fn write_all_at(file: &std::fs::File, bytes: &[u8], position: u64) -> Result<(), ExecutorError> {
    let mut written = 0usize;
    while written < bytes.len() {
        let count = write_at(file, &bytes[written..], position + written as u64)
            .map_err(|error| os_error(&error))?;
        if count == 0 {
            return Err(other_error("failed to write file block"));
        }
        written += count;
    }
    Ok(())
}

struct Scope {
    sandbox: Option<SandboxPolicy>,
    confined: bool,
}
impl Scope {
    fn check_access(
        &self,
        canonical: &str,
        requested: &str,
        need: SandboxAccess,
    ) -> Result<(), ExecutorError> {
        if self.confined
            && !self
                .sandbox
                .as_ref()
                .is_some_and(|sandbox| sandbox.access(canonical, Some(requested)).permits(need))
        {
            return Err(sandbox_denied());
        }
        Ok(())
    }
    fn guard<T>(&self, outcome: Result<T, ExecutorError>) -> Result<T, ExecutorError> {
        match outcome {
            Err(error) if self.confined && (is_outside(&error) || error.code == -32602) => {
                Err(sandbox_denied())
            }
            other => other,
        }
    }
}

struct FileEntry {
    file: Arc<std::fs::File>,
    grant: Mutex<Option<Grant>>,
    state: Mutex<EntryState>,
    done: watch::Sender<bool>,
}
struct EntryState {
    inflight: usize,
    detached: bool,
    finalizing: bool,
}

struct Inner {
    access: ExecutorAccess,
    roots: Vec<String>,
    authorize: AuthorizeFn,
    temporary_directories: Arc<dyn Fn() -> Vec<String> + Send + Sync>,
    closed: AtomicBool,
    cleanup_failed: AtomicBool,
    reserved: AtomicUsize,
    files: Mutex<HashMap<LosslessString, Arc<FileEntry>>>,
    live: Mutex<Vec<Arc<FileEntry>>>,
}

#[derive(Clone)]
pub struct FsExtended(Arc<Inner>);

struct Reservation<'a>(&'a AtomicUsize);
impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

impl FsExtended {
    pub fn new(
        roots: Vec<String>,
        authorize: AuthorizeFn,
        temporary_directories: Arc<dyn Fn() -> Vec<String> + Send + Sync>,
    ) -> Result<Self, ExecutorError> {
        Self::with_access(
            roots,
            authorize,
            temporary_directories,
            ExecutorAccess::Ordinary,
        )
    }

    pub(super) fn with_access(
        roots: Vec<String>,
        authorize: AuthorizeFn,
        temporary_directories: Arc<dyn Fn() -> Vec<String> + Send + Sync>,
        access: ExecutorAccess,
    ) -> Result<Self, ExecutorError> {
        if access == ExecutorAccess::Ordinary && roots.is_empty() {
            return Err(ExecutorError::new(
                -32602,
                "at least one containing root is required",
            ));
        }
        Ok(Self(Arc::new(Inner {
            access,
            roots,
            authorize,
            temporary_directories,
            closed: AtomicBool::new(false),
            cleanup_failed: AtomicBool::new(false),
            reserved: AtomicUsize::new(0),
            files: Mutex::new(HashMap::new()),
            live: Mutex::new(vec![]),
        })))
    }

    fn check_not_closed(&self) -> Result<(), ExecutorError> {
        if self.0.closed.load(Ordering::Acquire) {
            Err(other_error("Executor session closed"))
        } else {
            Ok(())
        }
    }
    fn parse(uri: &str) -> Result<String, ExecutorError> {
        parse_path_uri(uri).map_err(policy_failure)
    }
    async fn scope_for(&self, sandbox: Option<&Value>) -> Result<Scope, ExecutorError> {
        if self.0.access == ExecutorAccess::UnrestrictedHost {
            policy::validate_sandbox(sandbox).map_err(policy_failure)?;
            return Ok(Scope {
                sandbox: None,
                confined: false,
            });
        }
        let policy = resolve_sandbox(
            &SandboxIntent {
                sandbox,
                ..Default::default()
            },
            &ResolveSandboxOptions {
                temporary_directories: (self.0.temporary_directories)(),
                ..Default::default()
            },
        )
        .await
        .map_err(policy_failure)?;
        let confined = policy.as_ref().is_some_and(|policy| policy.restricted);
        Ok(Scope {
            sandbox: policy,
            confined,
        })
    }
    async fn authorize_in(
        &self,
        scope: &Scope,
        action: &str,
        resources: Vec<String>,
    ) -> Result<Grant, ExecutorError> {
        let denied = || {
            if scope.confined {
                sandbox_denied()
            } else {
                ExecutorError::permission_denied()
            }
        };
        let mut input = AuthorizationInput::new(
            action,
            resources.into_iter().map(LosslessString::from).collect(),
        );
        input.metadata = scope
            .sandbox
            .as_ref()
            .map(|sandbox| sandbox.metadata.clone());
        (self.0.authorize)(input).await.map_err(|_| denied())
    }
    async fn with_grant<T>(
        grant: Grant,
        work: impl std::future::Future<Output = Result<T, ExecutorError>>,
    ) -> Result<T, ExecutorError> {
        match work.await {
            Err(error) => {
                let _ = grant.release().await;
                Err(error)
            }
            Ok(value) => grant
                .release()
                .await
                .map(|_| value)
                .map_err(|_| other_error("Internal error")),
        }
    }
    async fn canonical_roots(&self) -> Result<Vec<String>, ExecutorError> {
        let mut roots = vec![];
        for root in &self.0.roots {
            roots.push(real_path(root).await.map_err(|_| {
                ExecutorError::new(-32602, "containing root cannot be canonicalized")
            })?);
        }
        Ok(roots)
    }
    async fn deepest_existing(
        target: &str,
    ) -> Result<(String, Vec<String>, io::Error), ExecutorError> {
        let mut rest: Vec<String> = vec![];
        let mut current = target.to_owned();
        let mut last: Option<io::Error> = None;
        loop {
            match real_path(&current).await {
                Ok(existing) => {
                    return Ok((
                        existing,
                        rest,
                        last.unwrap_or_else(|| io::Error::from_raw_os_error(0)),
                    ));
                }
                Err(error) => {
                    let parent = dirname(&current);
                    if parent == current {
                        return Err(os_error(&error));
                    }
                    rest.insert(0, basename(&current));
                    current = parent;
                    last = Some(error);
                }
            }
        }
    }
    async fn contained(&self, native: &str, allow_missing: bool) -> Result<String, ExecutorError> {
        let real_roots = if self.0.access == ExecutorAccess::Ordinary {
            self.canonical_roots().await?
        } else {
            vec![]
        };
        let mut pending = native.to_owned();
        let mut hops = 0usize;
        loop {
            let (existing, rest, failure) = Self::deepest_existing(&pending).await?;
            if self.0.access == ExecutorAccess::Ordinary
                && !real_roots.iter().any(|root| within(&existing, root))
            {
                return Err(outside_roots());
            }
            if rest.is_empty() {
                return Ok(existing);
            }
            let child = join(&existing, &[&rest[0]]);
            let link = lstat(&child)
                .await
                .map(|metadata| metadata.file_type().is_symlink())
                .unwrap_or(false);
            if link {
                if hops == MAX_SYMLINK_HOPS {
                    #[cfg(unix)]
                    return Err(os_raw(libc::ELOOP));
                    #[cfg(not(unix))]
                    return Err(other_error("Too many levels of symbolic links"));
                }
                hops += 1;
                let target = tokio::fs::read_link(&child)
                    .await
                    .map_err(|error| os_error(&error))?;
                let mut parts = vec![join_unnormalized(&existing, &target.to_string_lossy())];
                parts.extend(rest[1..].iter().cloned());
                pending = parts.join(&SEP.to_string());
                continue;
            }
            if allow_missing
                && failure.kind() == io::ErrorKind::NotFound
                && !rest.iter().any(|part| part == "." || part == "..")
            {
                let parts = rest.iter().map(String::as_str).collect::<Vec<_>>();
                return Ok(join(&existing, &parts));
            }
            return Err(os_error(&failure));
        }
    }
    async fn entry_path(
        &self,
        native: &str,
        allow_missing_parent: bool,
    ) -> Result<String, ExecutorError> {
        let parent = dirname(native);
        if parent == native {
            return self.contained(native, false).await;
        }
        Ok(join(
            &self.contained(&parent, allow_missing_parent).await?,
            &[&basename(native)],
        ))
    }

    async fn finalize(&self, entry: &Arc<FileEntry>) {
        {
            let mut state = entry
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if state.finalizing {
                return;
            }
            state.finalizing = true;
        }
        let grant = entry
            .grant
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(grant) = grant
            && grant.release().await.is_err()
        {
            self.0.cleanup_failed.store(true, Ordering::Release);
        }
        self.0
            .live
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .retain(|candidate| !Arc::ptr_eq(candidate, entry));
        let _ = entry.done.send_replace(true);
    }
    async fn wait_done(entry: &Arc<FileEntry>) {
        let mut receiver = entry.done.subscribe();
        while !*receiver.borrow() {
            if receiver.changed().await.is_err() {
                break;
            }
        }
    }
    fn detach(&self, handle_id: &LosslessString, entry: &Arc<FileEntry>) -> bool {
        {
            let mut files = self
                .0
                .files
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if files
                .get(handle_id)
                .is_some_and(|current| Arc::ptr_eq(current, entry))
            {
                files.remove(handle_id);
            }
        }
        let mut state = entry
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.detached = true;
        state.inflight == 0
    }
    fn lookup(&self, handle_id: &LosslessString) -> Result<Arc<FileEntry>, ExecutorError> {
        self.0
            .files
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(handle_id)
            .cloned()
            .ok_or_else(|| {
                ExecutorError::new(
                    -32004,
                    concat(&[&"unknown file handle `".into(), handle_id, &"`".into()]),
                )
            })
    }
    fn begin(entry: &Arc<FileEntry>) {
        entry
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .inflight += 1;
    }
    fn finish(&self, entry: &Arc<FileEntry>) {
        let finalize = {
            let mut state = entry
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            state.inflight -= 1;
            state.detached && state.inflight == 0
        };
        if finalize {
            let this = self.clone();
            let entry = entry.clone();
            tokio::spawn(async move { this.finalize(&entry).await });
        }
    }

    fn check_handle_id(handle_id: &LosslessString) -> Result<(), ExecutorError> {
        if utf8_len(handle_id) > MAX_FILE_HANDLE_ID_BYTES {
            return Err(invalid_input(format!(
                "file handle ID must not exceed {MAX_FILE_HANDLE_ID_BYTES} bytes"
            )));
        }
        Ok(())
    }

    async fn open_regular(
        target: &str,
        requested: &str,
        mode: OpenMode,
        parent: &Pin,
    ) -> Result<std::fs::File, ExecutorError> {
        recheck(parent).await?;
        let file = open_verified(
            target,
            mode == OpenMode::Replace,
            mode == OpenMode::Replace,
            0o666,
        )
        .await?;
        let metadata = file.metadata().map_err(|error| os_error(&error))?;
        if !metadata.is_file() {
            return Err(invalid_input(format!("path `{requested}` is not a file")));
        }
        if mode == OpenMode::Replace {
            file.set_len(0).map_err(|error| os_error(&error))?;
        }
        Ok(file)
    }

    pub async fn open(
        &self,
        params: OpenParams,
        _ctx: &HandlerContext,
    ) -> Result<LosslessString, ExecutorError> {
        self.check_not_closed()?;
        Self::check_handle_id(&params.handle_id)?;
        {
            let files = self
                .0
                .files
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if files.contains_key(&params.handle_id) {
                return Err(invalid_input(concat(&[
                    &"file handle `".into(),
                    &params.handle_id,
                    &"` already exists".into(),
                ])));
            }
            if files.len() + self.0.reserved.load(Ordering::Acquire) >= MAX_OPEN_FILES {
                return Err(invalid_input(format!(
                    "at most {MAX_OPEN_FILES} file handles may be open per connection"
                )));
            }
            self.0.reserved.fetch_add(1, Ordering::AcqRel);
        }
        let reservation = Reservation(&self.0.reserved);
        let native = Self::parse(&params.path)?;
        let scope = self.scope_for(params.sandbox.as_ref()).await?;
        let need = if params.mode == OpenMode::Read {
            SandboxAccess::Read
        } else {
            SandboxAccess::Write
        };
        let target = scope.guard(
            self.contained(&native, params.mode == OpenMode::Replace)
                .await,
        )?;
        let parent = pin(&dirname(&target), None).await?;
        scope.check_access(&target, &native, need)?;
        let grant = self
            .authorize_in(
                &scope,
                if params.mode == OpenMode::Read {
                    "read"
                } else {
                    "edit"
                },
                vec![target.clone()],
            )
            .await?;
        let file = match Self::open_regular(&target, &native, params.mode, &parent).await {
            Ok(file) => file,
            Err(error) => {
                if grant.release().await.is_err() {
                    self.0.cleanup_failed.store(true, Ordering::Release);
                }
                return Err(error);
            }
        };
        drop(reservation);
        let rejection = if self.0.closed.load(Ordering::Acquire) {
            Some(other_error("Executor session closed"))
        } else if self
            .0
            .files
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains_key(&params.handle_id)
        {
            Some(invalid_input(concat(&[
                &"file handle `".into(),
                &params.handle_id,
                &"` already exists".into(),
            ])))
        } else {
            None
        };
        if let Some(rejection) = rejection {
            drop(file);
            if grant.release().await.is_err() {
                self.0.cleanup_failed.store(true, Ordering::Release);
            }
            return Err(rejection);
        }
        let (done, _) = watch::channel(false);
        let entry = Arc::new(FileEntry {
            file: Arc::new(file),
            grant: Mutex::new(Some(grant)),
            state: Mutex::new(EntryState {
                inflight: 0,
                detached: false,
                finalizing: false,
            }),
            done,
        });
        self.0
            .files
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(params.handle_id.clone(), entry.clone());
        self.0
            .live
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(entry);
        Ok(params.handle_id)
    }

    pub async fn read_block(
        &self,
        params: ReadBlockParams,
        _ctx: &HandlerContext,
    ) -> Result<ReadBlockResult, ExecutorError> {
        self.check_not_closed()?;
        Self::check_handle_id(&params.handle_id)?;
        if !(1..=FILE_READ_CHUNK_SIZE).contains(&params.len) {
            return Err(invalid_input(format!(
                "file read block length must be between 1 and {FILE_READ_CHUNK_SIZE}"
            )));
        }
        let entry = self.lookup(&params.handle_id)?;
        Self::begin(&entry);
        let file = entry.file.clone();
        let (offset, length) = (params.offset, params.len);
        let outcome = blocking(move || {
            let mut buffer = vec![0u8; length];
            let mut total = 0usize;
            while total < length {
                let position = offset as u128 + total as u128;
                if position > i64::MAX as u128 {
                    return Err(io::Error::from_raw_os_error(einval()));
                }
                let remaining = (length - total).min((i64::MAX as u128 - position) as usize);
                if remaining == 0 {
                    break;
                }
                let count = read_at(
                    &file,
                    &mut buffer[total..total + remaining],
                    position as u64,
                )?;
                if count == 0 {
                    break;
                }
                total += count;
            }
            buffer.truncate(total);
            Ok(buffer)
        })
        .await;
        self.finish(&entry);
        match outcome {
            Ok(chunk) => {
                let eof = chunk.len() < params.len;
                Ok(ReadBlockResult { chunk, eof })
            }
            Err(error) => {
                if self.detach(&params.handle_id, &entry) {
                    let this = self.clone();
                    let entry = entry.clone();
                    tokio::spawn(async move { this.finalize(&entry).await });
                }
                Err(os_error(&error))
            }
        }
    }

    pub async fn write_block(
        &self,
        params: WriteBlockParams,
        _ctx: &HandlerContext,
    ) -> Result<(), ExecutorError> {
        self.check_not_closed()?;
        Self::check_handle_id(&params.handle_id)?;
        let length = params.chunk.len();
        if !(1..=FILE_WRITE_CHUNK_SIZE).contains(&length) {
            return Err(invalid_input(format!(
                "file write block length must be between 1 and {FILE_WRITE_CHUNK_SIZE}"
            )));
        }
        if params.offset as u128 + length as u128 > i64::MAX as u128 {
            return Err(invalid_input(
                "file write range exceeds the signed 64-bit file offset limit",
            ));
        }
        if params.offset as u128 + length as u128 > 9_007_199_254_740_991u128 {
            return Err(invalid_input(
                "file block range exceeds the largest exact offset 9007199254740991",
            ));
        }
        let entry = self.lookup(&params.handle_id)?;
        Self::begin(&entry);
        let file = entry.file.clone();
        let (offset, chunk) = (params.offset, params.chunk);
        let outcome = tokio::task::spawn_blocking(move || write_all_at(&file, &chunk, offset))
            .await
            .unwrap_or_else(|error| Err(other_error(error.to_string())));
        self.finish(&entry);
        outcome
    }

    pub async fn close_handle(
        &self,
        params: CloseParams,
        _ctx: &HandlerContext,
    ) -> Result<(), ExecutorError> {
        self.check_not_closed()?;
        Self::check_handle_id(&params.handle_id)?;
        let entry = self
            .0
            .files
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&params.handle_id)
            .cloned();
        if let Some(entry) = entry {
            let idle = self.detach(&params.handle_id, &entry);
            if idle {
                self.finalize(&entry).await;
                Self::wait_done(&entry).await;
            }
        }
        Ok(())
    }

    async fn make_directory(
        target: &str,
        recursive: bool,
        follow: bool,
    ) -> Result<(), ExecutorError> {
        let root = policy::root_of(target);
        let components = target[root.len()..]
            .split(SEP)
            .filter(|part| !part.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if components.is_empty() {
            return if recursive {
                Ok(())
            } else {
                Err(other_error("directory already exists"))
            };
        }
        let mut current = pin(&root, None).await?;
        for (index, component) in components.iter().enumerate() {
            let next = join(&current.path, &[component]);
            let leaf = index == components.len() - 1;
            if !recursive && leaf {
                recheck(&current).await?;
                tokio::fs::create_dir(&next)
                    .await
                    .map_err(|error| os_error(&error))?;
                return Ok(());
            }
            let mut stats = lstat_if_present(&next).await?;
            if stats.is_none() {
                if !recursive {
                    return Err(os_raw(enoent()));
                }
                recheck(&current).await?;
                if let Err(error) = tokio::fs::create_dir(&next).await
                    && error.kind() != io::ErrorKind::AlreadyExists
                {
                    return Err(os_error(&error));
                }
                stats = Some(lstat(&next).await.map_err(|error| os_error(&error))?);
            }
            let stats = stats.expect("directory metadata resolved");
            if stats.file_type().is_symlink() {
                return Err(if follow { outside_roots() } else { eloop() });
            }
            if !stats.is_dir() {
                return Err(if follow && leaf {
                    os_raw(eexist())
                } else {
                    os_raw(enotdir())
                });
            }
            current = pin(&next, Some(stats)).await?;
        }
        Ok(())
    }

    pub async fn create_directory(
        &self,
        params: CreateDirectoryParams,
        _ctx: &HandlerContext,
    ) -> Result<(), ExecutorError> {
        self.check_not_closed()?;
        let recursive = params.recursive.unwrap_or(true);
        let follow = params.follow_symlinks != Some(false);
        let native = Self::parse(&params.path)?;
        let scope = self.scope_for(params.sandbox.as_ref()).await?;
        let target = scope.guard(self.contained(&native, true).await)?;
        scope.check_access(&target, &native, SandboxAccess::Write)?;
        let grant = self
            .authorize_in(&scope, "edit", vec![target.clone()])
            .await?;
        let path = if follow { target } else { native };
        Self::with_grant(grant, Self::make_directory(&path, recursive, follow)).await
    }

    pub async fn walk(
        &self,
        params: WalkParams,
        ctx: &HandlerContext,
    ) -> Result<WalkResult, ExecutorError> {
        self.check_not_closed()?;
        let options = &params.options;
        if options.max_directories == 0 || options.max_entries == 0 {
            return Err(invalid_input(
                "filesystem walk limits must be greater than zero",
            ));
        }
        if options.max_depth > MAX_WALK_DEPTH
            || options.max_directories > MAX_WALK_DIRECTORIES
            || options.max_entries > MAX_WALK_ENTRIES
        {
            return Err(invalid_input(format!(
                "filesystem walk limits exceed maximums: depth={MAX_WALK_DEPTH}, directories={MAX_WALK_DIRECTORIES}, entries={MAX_WALK_ENTRIES}"
            )));
        }
        let native = Self::parse(&params.path)?;
        let scope = self.scope_for(params.sandbox.as_ref()).await?;
        let target = scope.guard(self.contained(&native, false).await)?;
        let root = pin(&target, None).await?;
        scope.check_access(&target, &native, SandboxAccess::Read)?;
        let grant = self
            .authorize_in(&scope, "read", vec![target.clone()])
            .await?;
        Self::with_grant(
            grant,
            self.walk_tree(native, root, params.options.clone(), &scope, ctx),
        )
        .await
    }

    async fn read_names(
        &self,
        directory: &str,
        ctx: &HandlerContext,
    ) -> Result<Vec<String>, ExecutorError> {
        if ctx.signal.is_cancelled() {
            return Err(walk_cancelled());
        }
        let mut reader = tokio::fs::read_dir(directory)
            .await
            .map_err(|error| os_error(&error))?;
        let mut names = vec![];
        while let Some(entry) = reader
            .next_entry()
            .await
            .map_err(|error| os_error(&error))?
        {
            if ctx.signal.is_cancelled() {
                return Err(walk_cancelled());
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let is_link = entry
                .file_type()
                .await
                .map(|kind| kind.is_symlink())
                .unwrap_or(false);
            if is_link {
                let listed = match self.contained(&join(directory, &[&name]), false).await {
                    Ok(_) => true,
                    Err(error) => is_outside(&error),
                };
                if !listed {
                    continue;
                }
            }
            names.push(name);
        }
        Ok(names)
    }

    async fn walk_tree(
        &self,
        native: String,
        root: Pin,
        options: WalkOptions,
        scope: &Scope,
        ctx: &HandlerContext,
    ) -> Result<WalkResult, ExecutorError> {
        let follow = options.follow_directory_symlinks;
        let check_cancelled = || {
            if ctx.signal.is_cancelled() {
                Err(walk_cancelled())
            } else {
                Ok(())
            }
        };
        let mut result = WalkResult::default();
        let mut response_bytes = 0usize;
        macro_rules! reserve {
            ($content:expr) => {{
                let total = response_bytes + $content + WALK_RESPONSE_ITEM_OVERHEAD_BYTES;
                if total > MAX_WALK_RESPONSE_BYTES {
                    result.truncated = true;
                    false
                } else {
                    response_bytes = total;
                    true
                }
            }};
        }
        macro_rules! push_error {
            ($uri:expr, $message:expr) => {{
                let uri: String = $uri;
                let message: LosslessString = $message.into();
                if reserve!(uri.len() + utf8_len(&message)) {
                    result.errors.push(WalkError { path: uri, message });
                    true
                } else {
                    false
                }
            }};
        }
        check_cancelled()?;
        recheck(&root).await?;
        let root_link = lstat(&native)
            .await
            .map_err(|error| os_error(&error))?
            .file_type()
            .is_symlink();
        if !root.directory || (root_link && !follow) {
            return Ok(result);
        }
        struct Queued {
            display: String,
            pin: Pin,
            depth: u64,
        }
        let mut queue: std::collections::VecDeque<Queued> = std::collections::VecDeque::new();
        queue.push_back(Queued {
            display: native.clone(),
            pin: root.clone(),
            depth: 0,
        });
        let mut visited = BTreeSet::new();
        visited.insert(root.path.clone());
        let mut directories = 1u64;
        let mut examined = 0u64;
        while let Some(directory) = queue.pop_front() {
            let directory_uri = to_path_uri(&directory.display).map_err(policy_failure)?;
            let listing = async {
                recheck(&directory.pin).await?;
                let names = self.read_names(&directory.pin.path, ctx).await?;
                recheck(&directory.pin).await?;
                Ok::<_, ExecutorError>(names)
            }
            .await;
            let mut names = match listing {
                Ok(names) => names,
                Err(error) => {
                    check_cancelled()?;
                    if !push_error!(directory_uri.clone(), error.message.clone()) {
                        return Ok(result);
                    }
                    continue;
                }
            };
            check_cancelled()?;
            names.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
            for name in names {
                check_cancelled()?;
                if examined == options.max_entries {
                    result.truncated = true;
                    return Ok(result);
                }
                examined += 1;
                let display = join(&directory.display, &[&name]);
                let real = join(&directory.pin.path, &[&name]);
                let uri = match to_path_uri(&display) {
                    Ok(uri) => uri,
                    Err(error) => {
                        if !push_error!(directory_uri.clone(), error.message) {
                            return Ok(result);
                        }
                        continue;
                    }
                };
                if scope.confined
                    && !scope.sandbox.as_ref().is_some_and(|sandbox| {
                        sandbox
                            .access(&real, Some(&display))
                            .permits(SandboxAccess::Read)
                    })
                {
                    #[cfg(unix)]
                    let message = os_raw(libc::EACCES).message;
                    #[cfg(not(unix))]
                    let message = "Permission denied".to_owned();
                    if !push_error!(uri, message) {
                        return Ok(result);
                    }
                    continue;
                }
                let mut resolved = real.clone();
                let stats = match async {
                    let mut stats = lstat(&real).await.map_err(|error| os_error(&error))?;
                    if stats.file_type().is_symlink() {
                        if !follow {
                            return Ok::<_, ExecutorError>(None);
                        }
                        resolved = self.contained(&real, false).await?;
                        stats = tokio::fs::metadata(&resolved)
                            .await
                            .map_err(|error| os_error(&error))?;
                    }
                    Ok(Some(stats))
                }
                .await
                {
                    Ok(Some(stats)) => stats,
                    Ok(None) => continue,
                    Err(error) => {
                        if !push_error!(uri, error.message) {
                            return Ok(result);
                        }
                        continue;
                    }
                };
                let link = resolved != real;
                if link && !stats.is_dir() {
                    continue;
                }
                let kind = if stats.is_dir() {
                    WalkKind::Directory
                } else if stats.is_file() {
                    WalkKind::File
                } else {
                    continue;
                };
                if !reserve!(uri.len()) {
                    return Ok(result);
                }
                result.entries.push(WalkEntry {
                    path: uri.clone(),
                    kind,
                });
                if kind != WalkKind::Directory || directory.depth >= options.max_depth {
                    continue;
                }
                if options.prune_hidden_directories == Some(true) && name.starts_with('.') {
                    continue;
                }
                if link
                    && scope.confined
                    && !scope.sandbox.as_ref().is_some_and(|sandbox| {
                        sandbox
                            .access(&resolved, Some(&display))
                            .permits(SandboxAccess::Read)
                    })
                {
                    #[cfg(unix)]
                    let message = os_raw(libc::EACCES).message;
                    #[cfg(not(unix))]
                    let message = "Permission denied".to_owned();
                    if !push_error!(uri, message) {
                        return Ok(result);
                    }
                    continue;
                }
                if !visited.insert(resolved.clone()) {
                    continue;
                }
                if directories == options.max_directories {
                    result.truncated = true;
                    continue;
                }
                directories += 1;
                queue.push_back(Queued {
                    display,
                    pin: pin_of(&resolved, &stats),
                    depth: directory.depth + 1,
                });
            }
        }
        Ok(result)
    }

    async fn assert_tree_writable(scope: &Scope, directory: &str) -> Result<(), ExecutorError> {
        let mut reader = tokio::fs::read_dir(directory)
            .await
            .map_err(|error| os_error(&error))?;
        let mut children = vec![];
        while let Some(entry) = reader
            .next_entry()
            .await
            .map_err(|error| os_error(&error))?
        {
            let is_dir = entry
                .file_type()
                .await
                .map(|kind| kind.is_dir())
                .unwrap_or(false);
            children.push((
                join(directory, &[&entry.file_name().to_string_lossy()]),
                is_dir,
            ));
        }
        for (child, is_dir) in children {
            scope.check_access(&child, &child, SandboxAccess::Write)?;
            if is_dir {
                Box::pin(Self::assert_tree_writable(scope, &child)).await?;
            }
        }
        Ok(())
    }

    async fn remove_tree(directory: String, parent: Pin) -> Result<(), ExecutorError> {
        recheck(&parent).await?;
        let own = pin(&directory, None).await?;
        if !own.directory {
            return Err(outside_roots());
        }
        let mut reader = tokio::fs::read_dir(&directory)
            .await
            .map_err(|error| os_error(&error))?;
        let mut children = vec![];
        while let Some(entry) = reader
            .next_entry()
            .await
            .map_err(|error| os_error(&error))?
        {
            let is_dir = entry
                .file_type()
                .await
                .map(|kind| kind.is_dir())
                .unwrap_or(false);
            children.push((
                join(&directory, &[&entry.file_name().to_string_lossy()]),
                is_dir,
            ));
        }
        for (child, is_dir) in children {
            recheck(&own).await?;
            if is_dir {
                Box::pin(Self::remove_tree(child, own.clone())).await?;
            } else {
                tokio::fs::remove_file(&child)
                    .await
                    .map_err(|error| os_error(&error))?;
            }
        }
        recheck(&parent).await?;
        tokio::fs::remove_dir(&directory)
            .await
            .map_err(|error| os_error(&error))
    }

    async fn remove_no_follow(
        native: &str,
        recursive: bool,
        force: bool,
    ) -> Result<(), ExecutorError> {
        if recursive {
            return Err(other_error("recursive no-follow removal is unsupported"));
        }
        let root = policy::root_of(native);
        let components = native[root.len()..]
            .split(SEP)
            .filter(|part| !part.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if components.is_empty() {
            return Err(invalid_input("path must name an entry"));
        }
        let mut current = pin(&root, None).await?;
        for component in &components[..components.len() - 1] {
            let next = join(&current.path, &[component]);
            let Some(stats) = lstat_if_present(&next).await? else {
                return if force { Ok(()) } else { Err(os_raw(enoent())) };
            };
            if stats.file_type().is_symlink() {
                return Err(eloop());
            }
            if !stats.is_dir() {
                return Err(os_raw(enotdir()));
            }
            current = pin(&next, Some(stats)).await?;
        }
        let leaf = join(
            &current.path,
            &[components.last().expect("component present")],
        );
        recheck(&current).await?;
        let Some(stats) = lstat_if_present(&leaf).await? else {
            return if force { Ok(()) } else { Err(os_raw(enoent())) };
        };
        if stats.file_type().is_symlink() {
            return Err(invalid_input("path contains a symbolic link"));
        }
        recheck(&current).await?;
        if stats.is_dir() {
            tokio::fs::remove_dir(&leaf)
                .await
                .map_err(|error| os_error(&error))
        } else {
            tokio::fs::remove_file(&leaf)
                .await
                .map_err(|error| os_error(&error))
        }
    }

    pub async fn remove(
        &self,
        params: RemoveParams,
        _ctx: &HandlerContext,
    ) -> Result<(), ExecutorError> {
        self.check_not_closed()?;
        let recursive = params.recursive.unwrap_or(true);
        let force = params.force.unwrap_or(true);
        let native = Self::parse(&params.path)?;
        let scope = self.scope_for(params.sandbox.as_ref()).await?;
        let located = async {
            let target = scope.guard(self.entry_path(&native, false).await)?;
            let parent = pin(&dirname(&target), None).await?;
            Ok::<_, ExecutorError>((target, parent))
        }
        .await;
        let (target, parent) = match located {
            Ok(located) => located,
            Err(error) if force && is_not_found(&error) => return Ok(()),
            Err(error) => return Err(error),
        };
        scope.check_access(&target, &native, SandboxAccess::Write)?;
        let grant = self
            .authorize_in(&scope, "edit", vec![target.clone()])
            .await?;
        let confined = scope.confined;
        let work = async {
            if params.follow_symlinks == Some(false) {
                return Self::remove_no_follow(&native, recursive, force).await;
            }
            recheck(&parent).await?;
            let Some(stats) = lstat_if_present(&target).await? else {
                return if force { Ok(()) } else { Err(os_raw(enoent())) };
            };
            if stats.is_dir() && recursive {
                if confined {
                    Self::assert_tree_writable(&scope, &target).await?;
                }
                return Self::remove_tree(target.clone(), parent.clone()).await;
            }
            recheck(&parent).await?;
            if stats.is_dir() {
                tokio::fs::remove_dir(&target)
                    .await
                    .map_err(|error| os_error(&error))
            } else {
                tokio::fs::remove_file(&target)
                    .await
                    .map_err(|error| os_error(&error))
            }
        };
        Self::with_grant(grant, work).await
    }

    async fn copy_file(
        &self,
        scope: &Scope,
        source: &str,
        destination: &str,
    ) -> Result<(), ExecutorError> {
        let target = scope.guard(self.contained(destination, true).await)?;
        scope.check_access(&target, destination, SandboxAccess::Write)?;
        let input = open_verified(source, false, false, 0).await?;
        let source_metadata = input.metadata().map_err(|error| os_error(&error))?;
        if !source_metadata.is_file() {
            return Err(invalid_input(
                "fs/copy only supports regular files, directories, and symlinks",
            ));
        }
        let mode = file_mode(&source_metadata);
        let output = open_verified(&target, true, true, mode).await?;
        let output_metadata = output.metadata().map_err(|error| os_error(&error))?;
        if file_id(&output_metadata) == file_id(&source_metadata)
            && file_id(&source_metadata) != (0, 0)
        {
            return Ok(());
        }
        let (input, output) = (Arc::new(input), Arc::new(output));
        tokio::task::spawn_blocking(move || -> Result<(), ExecutorError> {
            output.set_len(0).map_err(|error| os_error(&error))?;
            let mut buffer = vec![0u8; FILE_READ_CHUNK_SIZE];
            let mut position = 0u64;
            loop {
                let count =
                    read_at(&input, &mut buffer, position).map_err(|error| os_error(&error))?;
                if count == 0 {
                    break;
                }
                write_all_at(&output, &buffer[..count], position)?;
                position += count as u64;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                output
                    .set_permissions(std::fs::Permissions::from_mode(mode))
                    .map_err(|error| os_error(&error))?;
            }
            Ok(())
        })
        .await
        .unwrap_or_else(|error| Err(other_error(error.to_string())))
    }

    async fn copy_link(
        &self,
        scope: &Scope,
        link_text: &str,
        destination: &str,
    ) -> Result<(), ExecutorError> {
        let parent = scope.guard(self.contained(&dirname(destination), false).await)?;
        let target = join(&parent, &[&basename(destination)]);
        scope.check_access(&target, destination, SandboxAccess::Write)?;
        #[cfg(unix)]
        {
            let (text, target) = (link_text.to_owned(), target);
            blocking(move || std::os::unix::fs::symlink(&text, &target))
                .await
                .map_err(|error| os_error(&error))
        }
        #[cfg(not(unix))]
        {
            let _ = (link_text, target);
            Err(other_error(
                "symbolic link copy is unsupported on this platform",
            ))
        }
    }

    async fn copy_tree(
        &self,
        scope: &Scope,
        source: String,
        destination: String,
    ) -> Result<(), ExecutorError> {
        let target = scope.guard(self.contained(&destination, true).await)?;
        scope.check_access(&target, &destination, SandboxAccess::Write)?;
        Self::make_directory(&target, true, true).await?;
        let source_pin = pin(&source, None).await?;
        if !source_pin.directory {
            return Err(outside_roots());
        }
        let mut reader = tokio::fs::read_dir(&source)
            .await
            .map_err(|error| os_error(&error))?;
        let mut children = vec![];
        while let Some(entry) = reader
            .next_entry()
            .await
            .map_err(|error| os_error(&error))?
        {
            children.push((
                entry.file_name().to_string_lossy().into_owned(),
                entry.file_type().await.map_err(|error| os_error(&error))?,
            ));
        }
        recheck(&source_pin).await?;
        for (name, kind) in children {
            let from = join(&source, &[&name]);
            let to = join(&target, &[&name]);
            scope.check_access(&from, &from, SandboxAccess::Read)?;
            if kind.is_dir() {
                Box::pin(self.copy_tree(scope, from, to)).await?;
            } else if kind.is_file() {
                self.copy_file(scope, &from, &to).await?;
            } else if kind.is_symlink() {
                recheck(&source_pin).await?;
                let link = tokio::fs::read_link(&from)
                    .await
                    .map_err(|error| os_error(&error))?;
                self.copy_link(scope, &link.to_string_lossy(), &to).await?;
            }
        }
        Ok(())
    }

    pub async fn copy(
        &self,
        params: CopyParams,
        _ctx: &HandlerContext,
    ) -> Result<(), ExecutorError> {
        self.check_not_closed()?;
        let source_native = Self::parse(&params.source_path)?;
        let destination_native = Self::parse(&params.destination_path)?;
        let scope = self.scope_for(params.sandbox.as_ref()).await?;
        let source = scope.guard(self.entry_path(&source_native, false).await)?;
        let destination = scope.guard(self.entry_path(&destination_native, true).await)?;
        let source_parent = pin(&dirname(&source), None).await?;
        scope.check_access(&source, &source_native, SandboxAccess::Read)?;
        scope.check_access(&destination, &destination_native, SandboxAccess::Write)?;
        let read_grant = self
            .authorize_in(&scope, "read", vec![source.clone()])
            .await?;
        let this = self.clone();
        let work = async {
            let edit_grant = this
                .authorize_in(&scope, "edit", vec![destination.clone()])
                .await?;
            let inner = async {
                recheck(&source_parent).await?;
                let stats = lstat(&source).await.map_err(|error| os_error(&error))?;
                if stats.is_dir() {
                    if !params.recursive {
                        return Err(invalid_input(
                            "fs/copy requires recursive: true when sourcePath is a directory",
                        ));
                    }
                    let resolved_destination = match real_path(&destination).await {
                        Ok(resolved) => resolved,
                        Err(error) if error.kind() == io::ErrorKind::NotFound => {
                            destination.clone()
                        }
                        Err(error) => return Err(os_error(&error)),
                    };
                    let real_source = real_path(&source).await.map_err(|error| os_error(&error))?;
                    if within(&resolved_destination, &real_source) {
                        return Err(invalid_input(
                            "fs/copy cannot copy a directory to itself or one of its descendants",
                        ));
                    }
                    this.copy_tree(&scope, source.clone(), destination.clone())
                        .await
                } else if stats.file_type().is_symlink() {
                    let link = tokio::fs::read_link(&source)
                        .await
                        .map_err(|error| os_error(&error))?;
                    recheck(&source_parent).await?;
                    this.copy_link(&scope, &link.to_string_lossy(), &destination)
                        .await
                } else if stats.is_file() {
                    this.copy_file(&scope, &source, &destination).await
                } else {
                    Err(invalid_input(
                        "fs/copy only supports regular files, directories, and symlinks",
                    ))
                }
            };
            Self::with_grant(edit_grant, inner).await
        };
        Self::with_grant(read_grant, work).await
    }

    pub async fn shutdown(&self) -> Result<(), ExecutorError> {
        if !self.0.closed.swap(true, Ordering::AcqRel) {
            let entries = self
                .0
                .files
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .drain()
                .collect::<Vec<_>>();
            for (_, entry) in entries {
                let idle = {
                    let mut state = entry
                        .state
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    state.detached = true;
                    state.inflight == 0
                };
                if idle {
                    self.finalize(&entry).await;
                }
            }
            let live = self
                .0
                .live
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone();
            for entry in live {
                Self::wait_done(&entry).await;
            }
        }
        if self.0.cleanup_failed.load(Ordering::Acquire) {
            return Err(other_error("Internal error"));
        }
        Ok(())
    }
}

#[cfg(unix)]
fn einval() -> i32 {
    libc::EINVAL
}
#[cfg(not(unix))]
fn einval() -> i32 {
    22
}
#[cfg(unix)]
fn enoent() -> i32 {
    libc::ENOENT
}
#[cfg(not(unix))]
fn enoent() -> i32 {
    2
}
#[cfg(unix)]
fn enotdir() -> i32 {
    libc::ENOTDIR
}
#[cfg(not(unix))]
fn enotdir() -> i32 {
    20
}
#[cfg(unix)]
fn eexist() -> i32 {
    libc::EEXIST
}
#[cfg(not(unix))]
fn eexist() -> i32 {
    17
}
fn eloop() -> ExecutorError {
    #[cfg(unix)]
    return os_raw(libc::ELOOP);
    #[cfg(not(unix))]
    other_error("Too many levels of symbolic links")
}
