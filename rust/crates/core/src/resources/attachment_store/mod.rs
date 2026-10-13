use ring::digest;
use std::{
    fmt, fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use ycoding_schema::{
    prompt::{AttachmentDigest, ManagedAttachmentContent},
    schema::NonNegativeInt,
};

pub mod migration;
pub const MAX_BYTES: usize = 20 * 1024 * 1024;

#[derive(Debug)]
pub enum Error {
    InvalidReference,
    Integrity,
    Limit,
    Migration,
    Io(io::Error),
    Storage(ycoding_store::Error),
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidReference => "Invalid managed attachment reference",
            Self::Integrity => "Managed attachment failed integrity verification",
            Self::Limit => "Attachment exceeds the 20971520 byte limit",
            Self::Migration => "Invalid durable attachment migration data",
            Self::Io(_) => "Unable to access managed attachment",
            Self::Storage(_) => "Unable to migrate durable attachments",
        })
    }
}
impl std::error::Error for Error {}
impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<ycoding_store::Error> for Error {
    fn from(error: ycoding_store::Error) -> Self {
        Self::Storage(error)
    }
}

pub fn managed_uri(content: &ManagedAttachmentContent) -> String {
    format!(
        "ycoding-attachment://sha256/{}",
        String::from_utf16_lossy(&content.digest.0.code_units().collect::<Vec<_>>())
    )
}
pub fn managed_digest(uri: &str) -> Option<&str> {
    uri.strip_prefix("ycoding-attachment://sha256/")
        .filter(|value| valid_digest(value))
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn sha256(bytes: &[u8]) -> String {
    digest::digest(&digest::SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn relative_path(digest: &str) -> String {
    format!("attachments/sha256/{}/{digest}", &digest[..2])
}

pub struct Store {
    root: PathBuf,
}
impl Store {
    pub fn new(data_root: PathBuf) -> Result<Self, Error> {
        Ok(Self {
            root: crate::resources::discovery::absolute(&data_root)
                .map_err(|_| Error::InvalidReference)?,
        })
    }
    pub fn absolute_path(&self, content: &ManagedAttachmentContent) -> Result<PathBuf, Error> {
        let digest = content
            .digest
            .0
            .as_str()
            .filter(|value| valid_digest(value))
            .ok_or(Error::InvalidReference)?;
        if content.bytes.get() as u64 > MAX_BYTES as u64 {
            return Err(Error::Limit);
        }
        let expected = relative_path(digest);
        if content.path.as_str() != Some(expected.as_str()) {
            return Err(Error::InvalidReference);
        }
        Ok(self.root.join(expected))
    }
    pub fn read(&self, content: &ManagedAttachmentContent) -> Result<Vec<u8>, Error> {
        let target = self.absolute_path(content)?;
        self.verify_file(&target)?;
        let bytes = fs::read(target)?;
        if bytes.len() as u64 != content.bytes.get() as u64
            || sha256(&bytes) != content.digest.0.as_str().ok_or(Error::InvalidReference)?
        {
            return Err(Error::Integrity);
        }
        Ok(bytes)
    }
    pub fn import(&self, bytes: &[u8]) -> Result<ManagedAttachmentContent, Error> {
        if bytes.len() > MAX_BYTES {
            return Err(Error::Limit);
        }
        let hash = sha256(bytes);
        let content = ManagedAttachmentContent {
            digest: AttachmentDigest(hash.as_str().into()),
            bytes: NonNegativeInt::new(bytes.len() as i64).map_err(|_| Error::Limit)?,
            path: relative_path(&hash).into(),
        };
        let target = self.absolute_path(&content)?;
        let modified = match fs::symlink_metadata(&target) {
            Ok(_) => match self.read(&content) {
                Ok(_) => return Ok(content),
                Err(Error::Integrity | Error::Limit) => true,
                Err(error) => return Err(error),
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.into()),
        };
        self.ensure_directory(target.parent().ok_or(Error::InvalidReference)?)?;
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let temporary = target.with_file_name(format!(
            "{hash}.{}-{}.tmp",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| {
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            file.write_all(bytes)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                file.set_permissions(fs::Permissions::from_mode(0o400))?;
            }
            if modified {
                fs::rename(&temporary, &target)?;
            }
            if !modified {
                match fs::hard_link(&temporary, &target) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(Error::Io(error)),
                }
            }
            self.read(&content)?;
            Ok(content)
        })();
        let cleanup = fs::remove_file(&temporary);
        match (result, cleanup) {
            (Err(error), _) => Err(error),
            (Ok(content), Ok(())) => Ok(content),
            (Ok(content), Err(error)) if error.kind() == io::ErrorKind::NotFound => Ok(content),
            (Ok(_), Err(error)) => Err(error.into()),
        }
    }
    pub fn resolve_uri(&self, uri: &str) -> Result<ManagedAttachmentContent, Error> {
        let digest = managed_digest(uri).ok_or(Error::InvalidReference)?;
        let target = self.root.join(relative_path(digest));
        self.verify_file(&target)?;
        let bytes = fs::read(&target)?;
        let content = ManagedAttachmentContent {
            digest: AttachmentDigest(digest.into()),
            bytes: NonNegativeInt::new(bytes.len() as i64).map_err(|_| Error::Limit)?,
            path: relative_path(digest).into(),
        };
        self.read(&content)?;
        Ok(content)
    }
    fn verify_file(&self, target: &Path) -> Result<(), Error> {
        let metadata = fs::symlink_metadata(target)?;
        if metadata.is_symlink() || !metadata.is_file() {
            return Err(Error::InvalidReference);
        }
        if metadata.len() > MAX_BYTES as u64 {
            return Err(Error::Limit);
        }
        self.inspect_directory(target.parent().ok_or(Error::InvalidReference)?)?;
        if !fs::canonicalize(target)?.starts_with(fs::canonicalize(&self.root)?) {
            return Err(Error::InvalidReference);
        }
        Ok(())
    }
    fn inspect_directory(&self, directory: &Path) -> Result<(), Error> {
        let relative = directory
            .strip_prefix(&self.root)
            .map_err(|_| Error::InvalidReference)?;
        let mut target = self.root.clone();
        for component in relative.components() {
            if !matches!(component, std::path::Component::Normal(_)) {
                return Err(Error::InvalidReference);
            }
            target.push(component);
            let metadata = fs::symlink_metadata(&target)?;
            if metadata.is_symlink() || !metadata.is_dir() {
                return Err(Error::InvalidReference);
            }
        }
        if !fs::canonicalize(directory)?.starts_with(fs::canonicalize(&self.root)?) {
            return Err(Error::InvalidReference);
        }
        Ok(())
    }
    fn ensure_directory(&self, directory: &Path) -> Result<(), Error> {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&self.root)?;
        let mut target = self.root.clone();
        for component in directory
            .strip_prefix(&self.root)
            .map_err(|_| Error::InvalidReference)?
            .components()
        {
            target.push(component);
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            match builder.create(&target) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
            self.inspect_directory(&target)?;
        }
        Ok(())
    }
}
