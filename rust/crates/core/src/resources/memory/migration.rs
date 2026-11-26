use std::{
    fmt, fs, io,
    path::{Path, PathBuf},
};

#[cfg(all(test, unix))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum LegacyWriters {
    Unverified,
    Excluded,
}

#[derive(Debug)]
pub(super) enum MigrationError {
    #[cfg(all(test, unix))]
    LegacyWriters,
    #[cfg(not(unix))]
    Unsupported,
    Unsafe(PathBuf),
    #[cfg(all(test, unix))]
    Mismatch(PathBuf),
    #[cfg(unix)]
    InvalidGeneration,
    Io(io::Error),
}

impl fmt::Display for MigrationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            #[cfg(all(test, unix))]
            Self::LegacyWriters => f.write_str("Cannot verify exclusion of legacy memory writers."),
            #[cfg(not(unix))]
            Self::Unsupported => {
                f.write_str("Durable memory migration is unavailable on this platform.")
            }
            Self::Unsafe(path) => write!(f, "Unsafe memory migration path: {}.", path.display()),
            #[cfg(all(test, unix))]
            Self::Mismatch(path) => write!(
                f,
                "Memory migration verification failed for {}.",
                path.display()
            ),
            #[cfg(unix)]
            Self::InvalidGeneration => {
                f.write_str("The committed memory generation could not be verified.")
            }
            Self::Io(error) => write!(f, "Memory migration storage failed: {error}"),
        }
    }
}

impl std::error::Error for MigrationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for MigrationError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

use ring::digest::{self, SHA256};

#[cfg(unix)]
use {
    ring::digest::Context,
    std::{
        collections::BTreeMap,
        fs::{File, Metadata, OpenOptions},
        io::Read,
        os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    },
};

#[cfg(all(test, unix))]
use std::{
    fs::Permissions,
    io::Write,
    os::unix::fs::{DirBuilderExt, symlink},
};

#[cfg(unix)]
const HEADER: &[u8] = b"ycoding-memory/okf-0.3/v1\n";

fn control_path(base: &Path) -> Option<PathBuf> {
    let parent = base.parent()?;
    let key = digest::digest(&SHA256, base.as_os_str().as_encoded_bytes());
    let key: String = key
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Some(parent.join(format!(".ycoding-memory-migration-{key}")))
}

pub(super) fn verify_published(base: &Path) -> Result<(), MigrationError> {
    let Some(control) = control_path(base) else {
        return Ok(());
    };
    match fs::symlink_metadata(&control) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return Err(MigrationError::Unsafe("migration control".into())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    }
    match fs::symlink_metadata(control.join("current")) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    }
    #[cfg(unix)]
    {
        let root = directory(base)?;
        let control_meta = directory(&control)?;
        if control_meta.dev() != root.dev() || mode(&control_meta) != 0o700 {
            return Err(MigrationError::Unsafe("migration control".into()));
        }
        let lock = sealed_file(&control.join("fence"), &control_meta, 0o600)?;
        lock.try_lock_shared().map_err(|error| match error {
            fs::TryLockError::WouldBlock => MigrationError::InvalidGeneration,
            fs::TryLockError::Error(error) => error.into(),
        })?;
        verify_committed(&control, &root, &control_meta)
    }
    #[cfg(not(unix))]
    Err(MigrationError::Unsupported)
}

#[cfg(unix)]
fn verify_committed(
    control: &Path,
    root: &Metadata,
    owner: &Metadata,
) -> Result<(), MigrationError> {
    let mut selected = Vec::new();
    sealed_file(&control.join("current"), owner, 0o400)?
        .take((HEADER.len() + 81) as u64)
        .read_to_end(&mut selected)?;
    let identity = identity(root);
    if selected.len() != identity.len() + 64 || !selected.starts_with(&identity) {
        return Err(MigrationError::InvalidGeneration);
    }
    let stage = control.join("generation-v1");
    let stage_meta = directory(&stage)?;
    if stage_meta.dev() != owner.dev()
        || stage_meta.uid() != owner.uid()
        || mode(&stage_meta) != 0o700
    {
        return Err(MigrationError::Unsafe("migration generation".into()));
    }
    let original = digest_reader(sealed_file(
        &stage.join("original-inventory"),
        owner,
        0o400,
    )?)?;
    let backup = inventory(&stage.join("rollback"), root.dev(), InventoryScope::All)?;
    let expected = pointer(identity, &backup, original)?;
    if selected != expected {
        return Err(MigrationError::InvalidGeneration);
    }
    Ok(())
}

#[cfg(all(test, unix))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Checkpoint {
    BackingUp,
    BackupCopied,
    Staged,
    BeforePublish,
    Published,
    Synced,
}

#[cfg(all(test, unix))]
pub(super) struct Fence {
    base: PathBuf,
    control: PathBuf,
    dev: u64,
    ino: u64,
    _lock: File,
}

#[cfg(all(test, unix))]
impl Fence {
    pub(super) fn acquire(base: &Path, legacy: LegacyWriters) -> Result<Self, MigrationError> {
        if legacy == LegacyWriters::Unverified {
            return Err(MigrationError::LegacyWriters);
        }
        let base = fs::canonicalize(base)?;
        let parent = base
            .parent()
            .ok_or_else(|| MigrationError::Unsafe(PathBuf::from(".")))?;
        let root = directory(&base)?;
        let control = control_path(&base).ok_or_else(|| MigrationError::Unsafe(".".into()))?;
        match fs::DirBuilder::new().mode(0o700).create(&control) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        let control_meta = directory(&control)?;
        if control_meta.dev() != root.dev() || mode(&control_meta) != 0o700 {
            return Err(MigrationError::Unsafe(PathBuf::from("migration control")));
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(control.join("fence"))?;
        let lock_meta = lock.metadata()?;
        if !lock_meta.is_file() || lock_meta.nlink() != 1 || mode(&lock_meta) != 0o600 {
            return Err(MigrationError::Unsafe(PathBuf::from("migration fence")));
        }
        lock.lock()?;
        sync_directory(parent)?;
        Ok(Self {
            base,
            control,
            dev: root.dev(),
            ino: root.ino(),
            _lock: lock,
        })
    }

    pub(super) fn migrate(
        &mut self,
        verify: impl FnOnce(&Path, &Path) -> Result<(), MigrationError>,
    ) -> Result<(), MigrationError> {
        self.migrate_with(verify, |_, _| Ok(()))
    }

    pub(super) fn migrate_with(
        &mut self,
        verify: impl FnOnce(&Path, &Path) -> Result<(), MigrationError>,
        mut checkpoint: impl FnMut(Checkpoint, &Path) -> Result<(), MigrationError>,
    ) -> Result<(), MigrationError> {
        let root = self.verify_base()?;
        let active = self.control.join("current");
        let candidate = self.control.join("next");
        let stage = self.control.join("generation-v1");
        let rollback = stage.join("rollback");
        let manifest = stage.join("original-inventory");
        match fs::symlink_metadata(&active) {
            Ok(_) => {
                verify_committed(&self.control, &root, &directory(&self.control)?)?;
                return sync_directory(&self.control);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        discard_stage(&stage, self.dev)?;
        match fs::symlink_metadata(&candidate) {
            Ok(meta) if meta.is_file() && meta.nlink() == 1 => fs::remove_file(&candidate)?,
            Ok(_) => {
                return Err(MigrationError::Unsafe(PathBuf::from(
                    "next generation pointer",
                )));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let before = inventory(&self.base, self.dev, InventoryScope::Collections)?;
        private_directory(&stage)?;
        copy(&self.base, &rollback, &before, || {
            checkpoint(Checkpoint::BackingUp, &rollback)
        })?;
        checkpoint(Checkpoint::BackupCopied, &rollback)?;
        let expected_backup = seal(&before);
        compare(
            &expected_backup,
            &inventory(&rollback, self.dev, InventoryScope::All)?,
        )?;
        verify(&self.base, &rollback)?;
        self.verify_base()?;
        compare(
            &before,
            &inventory(&self.base, self.dev, InventoryScope::Collections)?,
        )?;
        let backed_up = inventory(&rollback, self.dev, InventoryScope::All)?;
        compare(&expected_backup, &backed_up)?;
        let inventory = encode(&before)?;
        let mut file = private_file(&manifest)?;
        file.write_all(&inventory)?;
        file.set_permissions(Permissions::from_mode(0o400))?;
        file.sync_all()?;
        let pointer = pointer(
            identity(&root),
            &backed_up,
            digest::digest(&SHA256, &inventory)
                .as_ref()
                .try_into()
                .map_err(|_| MigrationError::InvalidGeneration)?,
        )?;
        sync_directory(&stage)?;
        checkpoint(Checkpoint::Staged, &rollback)?;
        let mut file = private_file(&candidate)?;
        file.write_all(&pointer)?;
        file.set_permissions(Permissions::from_mode(0o400))?;
        file.sync_all()?;
        sync_directory(&self.control)?;
        checkpoint(Checkpoint::BeforePublish, &rollback)?;
        fs::rename(&candidate, &active)?;
        checkpoint(Checkpoint::Published, &rollback)?;
        sync_directory(&self.control)?;
        checkpoint(Checkpoint::Synced, &rollback)?;
        Ok(())
    }

    fn verify_base(&self) -> Result<Metadata, MigrationError> {
        let root = directory(&self.base)?;
        if (root.dev(), root.ino()) != (self.dev, self.ino) {
            return Err(MigrationError::InvalidGeneration);
        }
        Ok(root)
    }
}

#[cfg(unix)]
fn identity(root: &Metadata) -> Vec<u8> {
    let mut identity = HEADER.to_vec();
    identity.extend_from_slice(&root.dev().to_be_bytes());
    identity.extend_from_slice(&root.ino().to_be_bytes());
    identity
}

#[cfg(unix)]
fn pointer(
    mut identity: Vec<u8>,
    backup: &Inventory,
    original: [u8; 32],
) -> Result<Vec<u8>, MigrationError> {
    identity.extend_from_slice(&original);
    identity.extend_from_slice(digest::digest(&SHA256, &encode(backup)?).as_ref());
    Ok(identity)
}

#[cfg(unix)]
#[derive(Clone, Debug, PartialEq, Eq)]
enum Kind {
    Directory,
    File([u8; 32]),
    Link(PathBuf),
}

#[cfg(unix)]
#[derive(Clone, Debug, PartialEq, Eq)]
struct Entry {
    mode: u32,
    kind: Kind,
}

#[cfg(unix)]
type Inventory = BTreeMap<PathBuf, Entry>;

#[cfg(unix)]
#[derive(Clone, Copy)]
enum InventoryScope {
    #[cfg(test)]
    Collections,
    All,
}

#[cfg(unix)]
fn mode(metadata: &Metadata) -> u32 {
    metadata.permissions().mode() & 0o7777
}

#[cfg(unix)]
fn directory(path: &Path) -> Result<Metadata, MigrationError> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_dir() {
        return Err(MigrationError::Unsafe(
            path.file_name().unwrap_or_default().into(),
        ));
    }
    Ok(meta)
}

#[cfg(all(test, unix))]
fn sync_directory(path: &Path) -> Result<(), MigrationError> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
        .open(path)?
        .sync_all()?;
    Ok(())
}

#[cfg(unix)]
fn regular(path: &Path) -> Result<File, MigrationError> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err(MigrationError::Unsafe(
            path.file_name().unwrap_or_default().into(),
        ));
    }
    Ok(file)
}

#[cfg(unix)]
fn sealed_file(path: &Path, owner: &Metadata, expected_mode: u32) -> Result<File, MigrationError> {
    let file = regular(path)?;
    let metadata = file.metadata()?;
    if metadata.dev() != owner.dev()
        || metadata.uid() != owner.uid()
        || metadata.nlink() != 1
        || mode(&metadata) != expected_mode
    {
        return Err(MigrationError::Unsafe(
            path.file_name().unwrap_or_default().into(),
        ));
    }
    Ok(file)
}

#[cfg(all(test, unix))]
fn private_directory(path: &Path) -> Result<(), MigrationError> {
    fs::DirBuilder::new().mode(0o700).create(path)?;
    Ok(())
}

#[cfg(all(test, unix))]
fn private_file(path: &Path) -> Result<File, MigrationError> {
    Ok(OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?)
}

#[cfg(unix)]
fn digest_file(path: &Path) -> Result<[u8; 32], MigrationError> {
    digest_reader(regular(path)?)
}

#[cfg(unix)]
fn digest_reader(mut file: File) -> Result<[u8; 32], MigrationError> {
    let mut state = Context::new(&SHA256);
    let mut bytes = [0; 16 * 1024];
    loop {
        let count = file.read(&mut bytes)?;
        if count == 0 {
            return state
                .finish()
                .as_ref()
                .try_into()
                .map_err(|_| MigrationError::InvalidGeneration);
        }
        state.update(&bytes[..count]);
    }
}

#[cfg(unix)]
fn inventory(root: &Path, device: u64, scope: InventoryScope) -> Result<Inventory, MigrationError> {
    let collections = match scope {
        #[cfg(test)]
        InventoryScope::Collections => true,
        InventoryScope::All => false,
    };
    let mut entries = Inventory::new();
    let mut pending = vec![PathBuf::new()];
    while let Some(name) = pending.pop() {
        let path = root.join(&name);
        let metadata = fs::symlink_metadata(&path)?;
        let collection_boundary = if collections {
            match name.components().count() {
                0 | 1 => true,
                2 => name.starts_with("repository"),
                _ => false,
            }
        } else {
            name.as_os_str().is_empty()
        };
        if metadata.dev() != device || (collection_boundary && !metadata.is_dir()) {
            return Err(MigrationError::Unsafe(name));
        }
        let kind = if metadata.is_dir() {
            if name.as_os_str().is_empty() && collections {
                for name in [PathBuf::from("repository"), PathBuf::from("knowledge")] {
                    match fs::symlink_metadata(root.join(&name)) {
                        Ok(_) => pending.push(name),
                        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                        Err(error) => return Err(error.into()),
                    }
                }
            } else {
                for entry in fs::read_dir(&path)? {
                    let child = entry?.file_name();
                    if collections
                        && name == Path::new("repository")
                        && !repository_id(child.as_encoded_bytes())
                    {
                        continue;
                    }
                    pending.push(name.join(child));
                }
            }
            Kind::Directory
        } else if metadata.file_type().is_symlink() {
            Kind::Link(fs::read_link(&path)?)
        } else if metadata.is_file() {
            Kind::File(digest_file(&path)?)
        } else {
            return Err(MigrationError::Unsafe(name));
        };
        entries.insert(
            name,
            Entry {
                mode: mode(&metadata),
                kind,
            },
        );
    }
    Ok(entries)
}

#[cfg(unix)]
fn repository_id(name: &[u8]) -> bool {
    name.strip_prefix(b"repo_").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .iter()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    })
}

#[cfg(all(test, unix))]
fn copy(
    source: &Path,
    rollback: &Path,
    entries: &Inventory,
    checkpoint: impl FnOnce() -> Result<(), MigrationError>,
) -> Result<(), MigrationError> {
    let mut checkpoint = Some(checkpoint);
    for (name, entry) in entries {
        let target = rollback.join(name);
        match &entry.kind {
            Kind::Directory => private_directory(&target)?,
            Kind::File(_) => {
                let mut current = regular(&source.join(name))?;
                let mut copy = private_file(&target)?;
                io::copy(&mut current, &mut copy)?;
                copy.set_permissions(Permissions::from_mode(0o400))?;
                copy.sync_all()?;
            }
            Kind::Link(target_path) => symlink(target_path, &target)?,
        }
        if !name.as_os_str().is_empty()
            && let Some(checkpoint) = checkpoint.take()
        {
            checkpoint()?;
        }
    }
    for (name, entry) in entries.iter().rev() {
        if entry.kind == Kind::Directory {
            let target = rollback.join(name);
            fs::set_permissions(&target, Permissions::from_mode(0o500))?;
            sync_directory(&target)?;
        }
    }
    Ok(())
}

#[cfg(all(test, unix))]
fn seal(inventory: &Inventory) -> Inventory {
    inventory
        .iter()
        .map(|(name, entry)| {
            let mut entry = entry.clone();
            entry.mode = match entry.kind {
                Kind::Directory => 0o500,
                Kind::File(_) => 0o400,
                Kind::Link(_) => entry.mode,
            };
            (name.clone(), entry)
        })
        .collect()
}

#[cfg(all(test, unix))]
fn compare(expected: &Inventory, observed: &Inventory) -> Result<(), MigrationError> {
    for (name, entry) in expected {
        if observed.get(name) != Some(entry) {
            return Err(MigrationError::Mismatch(name.clone()));
        }
    }
    if let Some(name) = observed.keys().find(|name| !expected.contains_key(*name)) {
        return Err(MigrationError::Mismatch(name.clone()));
    }
    Ok(())
}

#[cfg(unix)]
fn encode(inventory: &Inventory) -> Result<Vec<u8>, MigrationError> {
    fn field(out: &mut Vec<u8>, bytes: &[u8]) -> Result<(), MigrationError> {
        let len = u32::try_from(bytes.len()).map_err(|_| MigrationError::InvalidGeneration)?;
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(bytes);
        Ok(())
    }
    let mut out = Vec::new();
    for (name, entry) in inventory {
        field(&mut out, name.as_os_str().as_encoded_bytes())?;
        out.extend_from_slice(&entry.mode.to_be_bytes());
        match &entry.kind {
            Kind::Directory => out.push(b'd'),
            Kind::File(hash) => {
                out.push(b'f');
                out.extend_from_slice(hash);
            }
            Kind::Link(link) => {
                out.push(b'l');
                field(&mut out, link.as_os_str().as_encoded_bytes())?;
            }
        }
    }
    Ok(out)
}

#[cfg(all(test, unix))]
fn discard_stage(stage: &Path, device: u64) -> Result<(), MigrationError> {
    match fs::symlink_metadata(stage) {
        Ok(meta) if meta.is_dir() && meta.dev() == device => {}
        Ok(_) => return Err(MigrationError::Unsafe(PathBuf::from("staged generation"))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    }
    let mut pending = vec![stage.to_path_buf()];
    while let Some(path) = pending.pop() {
        let meta = directory(&path)?;
        if meta.dev() != device {
            return Err(MigrationError::Unsafe(PathBuf::from("staged generation")));
        }
        fs::set_permissions(&path, Permissions::from_mode(0o700))?;
        for child in fs::read_dir(path)? {
            let child = child?;
            if child.file_type()?.is_dir() {
                pending.push(child.path());
            }
        }
    }
    fs::remove_dir_all(stage)?;
    Ok(())
}
