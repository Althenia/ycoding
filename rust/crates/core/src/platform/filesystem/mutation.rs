use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
};

#[derive(Debug)]
pub enum ResolveError {
    Io(io::Error),
    Permission(crate::tools::policy::permissions::Error),
}
impl From<io::Error> for ResolveError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<crate::tools::policy::permissions::Error> for ResolveError {
    fn from(error: crate::tools::policy::permissions::Error) -> Self {
        Self::Permission(error)
    }
}
impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => error.fmt(f),
            Self::Permission(_) => f.write_str("External directory authorization failed"),
        }
    }
}
impl std::error::Error for ResolveError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub canonical: PathBuf,
    pub resource: String,
}

impl Target {
    pub fn new(canonical: PathBuf, resource: impl Into<String>) -> Self {
        Self {
            canonical,
            resource: resource.into(),
        }
    }
}

#[derive(Debug)]
pub enum Error {
    Io(io::Error),
    StaleContent(PathBuf),
    TargetExists(PathBuf),
    LockPoisoned,
}

impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => error.fmt(f),
            Self::StaleContent(path) => write!(f, "File content changed: {}", path.display()),
            Self::TargetExists(path) => write!(f, "Target exists: {}", path.display()),
            Self::LockPoisoned => f.write_str("File mutation lock poisoned"),
        }
    }
}
impl std::error::Error for Error {}

#[derive(Debug, PartialEq, Eq)]
pub struct Result {
    pub operation: &'static str,
    pub target: PathBuf,
    pub resource: String,
    pub existed: bool,
}

#[derive(Default)]
pub struct Service {
    locks: Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>,
}

impl Service {
    fn locked<T>(
        &self,
        target: &Target,
        operation: impl FnOnce() -> std::result::Result<T, Error>,
    ) -> std::result::Result<T, Error> {
        let lock = {
            let mut locks = self.locks.lock().map_err(|_| Error::LockPoisoned)?;
            locks.retain(|_, lock| lock.strong_count() > 0);
            match locks.get(&target.canonical).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(Mutex::new(()));
                    locks.insert(target.canonical.clone(), Arc::downgrade(&lock));
                    lock
                }
            }
        };
        let _guard = lock.lock().map_err(|_| Error::LockPoisoned)?;
        operation()
    }

    pub fn write(&self, target: &Target, content: &[u8]) -> std::result::Result<Result, Error> {
        self.locked(target, || {
            let existed = target.canonical.try_exists()?;
            write_with_dirs(target, content, false)?;
            Ok(result("write", target, existed))
        })
    }

    pub fn create(&self, target: &Target, content: &[u8]) -> std::result::Result<Result, Error> {
        self.locked(target, || {
            write_with_dirs(target, content, true).map_err(|error| {
                if error.kind() == io::ErrorKind::AlreadyExists {
                    Error::TargetExists(target.canonical.clone())
                } else {
                    Error::Io(error)
                }
            })?;
            Ok(result("write", target, false))
        })
    }

    pub fn write_text_preserving_bom(
        &self,
        target: &Target,
        text: &str,
    ) -> std::result::Result<Result, Error> {
        self.locked(target, || {
            let current = match fs::read(&target.canonical) {
                Ok(bytes) => Some(bytes),
                Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.into()),
            };
            let stripped = text.trim_start_matches('\u{feff}');
            let bom = current
                .as_ref()
                .is_some_and(|bytes| bytes.starts_with(&[0xef, 0xbb, 0xbf]))
                || stripped.len() != text.len();
            let content = format!("{}{stripped}", if bom { "\u{feff}" } else { "" });
            write_with_dirs(target, content.as_bytes(), false)?;
            Ok(result("write", target, current.is_some()))
        })
    }

    pub fn write_if_unchanged(
        &self,
        target: &Target,
        expected: &[u8],
        content: &[u8],
    ) -> std::result::Result<Result, Error> {
        self.locked(target, || {
            if fs::read(&target.canonical)? != expected {
                return Err(Error::StaleContent(target.canonical.clone()));
            }
            fs::write(&target.canonical, content)?;
            Ok(result("write", target, true))
        })
    }

    pub fn remove(&self, target: &Target) -> std::result::Result<Result, Error> {
        self.locked(target, || {
            let removal = fs::symlink_metadata(&target.canonical).and_then(|info| {
                if info.is_dir() {
                    fs::remove_dir(&target.canonical)
                } else {
                    fs::remove_file(&target.canonical)
                }
            });
            let existed = match removal {
                Ok(()) => true,
                Err(error) if error.kind() == io::ErrorKind::NotFound => false,
                Err(error) => return Err(error.into()),
            };
            Ok(result("remove", target, existed))
        })
    }
}

fn result(operation: &'static str, target: &Target, existed: bool) -> Result {
    Result {
        operation,
        target: target.canonical.clone(),
        resource: target.resource.clone(),
        existed,
    }
}

fn write_with_dirs(target: &Target, content: &[u8], create: bool) -> io::Result<()> {
    let open = || {
        OpenOptions::new()
            .write(true)
            .create(!create)
            .create_new(create)
            .truncate(!create)
            .open(&target.canonical)
    };
    let mut file = match open() {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(target.canonical.parent().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "Target has no parent")
            })?)?;
            open()?
        }
        Err(error) => return Err(error),
    };
    file.write_all(content)
}
