use std::{
    fmt, fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

#[derive(Debug)]
pub enum Error {
    Unsafe(&'static str),
    Io(io::Error),
}
impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsafe(message) => f.write_str(message),
            Self::Io(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for Error {}

pub struct Mutation<'a> {
    pub operation: &'static str,
    pub path: Option<&'a Path>,
    pub source: Option<&'a Path>,
    pub destination: Option<&'a Path>,
}
type MutationHook<'a> = &'a dyn Fn(&Mutation<'_>) -> io::Result<()>;
type ReadHook<'a> = &'a dyn Fn(&Path) -> io::Result<()>;
#[derive(Default)]
pub struct Hooks<'a> {
    pub before_read: Option<ReadHook<'a>>,
    pub before_mutation: Option<MutationHook<'a>>,
    pub after_mutation: Option<MutationHook<'a>>,
}
pub enum MutationRequest<'a> {
    Mkdir {
        root: &'a Path,
        path: &'a Path,
    },
    Write {
        root: &'a Path,
        path: &'a Path,
        content: &'a str,
        exclusive: bool,
    },
    Rename {
        source_root: &'a Path,
        destination_root: &'a Path,
        source: &'a Path,
        destination: &'a Path,
        replace: bool,
    },
    Remove {
        root: &'a Path,
        path: &'a Path,
        recursive: bool,
    },
}

pub fn execute_mutation(request: MutationRequest<'_>, hooks: &Hooks<'_>) -> Result<(), Error> {
    let bindings = match &request {
        MutationRequest::Rename {
            source_root,
            destination_root,
            source,
            destination,
            ..
        } => vec![(*source_root, *source), (*destination_root, *destination)],
        MutationRequest::Mkdir { root, path }
        | MutationRequest::Write { root, path, .. }
        | MutationRequest::Remove { root, path, .. } => vec![(*root, *path)],
    };
    let before = bindings
        .iter()
        .map(|(root, target)| binding_identity(root, target))
        .collect::<Result<Vec<_>, _>>()?;
    if let MutationRequest::Rename {
        destination,
        replace: false,
        ..
    } = &request
        && fs::symlink_metadata(destination).is_ok()
    {
        return Err(Error::Unsafe("rename destination exists"));
    }
    let mutation = metadata(&request);
    if let Some(hook) = hooks.before_mutation {
        hook(&mutation)?;
    }
    let after = bindings
        .iter()
        .map(|(root, target)| binding_identity(root, target))
        .collect::<Result<Vec<_>, _>>()?;
    if before != after {
        return Err(Error::Unsafe("filesystem identity changed before mutation"));
    }
    if let MutationRequest::Rename {
        destination,
        replace: false,
        ..
    } = &request
        && fs::symlink_metadata(destination).is_ok()
    {
        return Err(Error::Unsafe("rename destination appeared before mutation"));
    }
    match request {
        MutationRequest::Mkdir { path, .. } => fs::create_dir(path)?,
        MutationRequest::Write {
            path,
            content,
            exclusive,
            ..
        } => {
            fs::OpenOptions::new()
                .write(true)
                .create(!exclusive)
                .create_new(exclusive)
                .truncate(!exclusive)
                .open(path)?
                .write_all(content.as_bytes())?;
        }
        MutationRequest::Rename {
            source,
            destination,
            ..
        } => fs::rename(source, destination)?,
        MutationRequest::Remove {
            path, recursive, ..
        } => {
            let result = match fs::symlink_metadata(path) {
                Ok(info) if info.is_dir() && recursive => fs::remove_dir_all(path),
                Ok(info) if info.is_dir() => Err(io::Error::new(
                    io::ErrorKind::IsADirectory,
                    "nonrecursive removal requires a file",
                )),
                Ok(_) => fs::remove_file(path),
                Err(error) => Err(error),
            };
            if let Err(error) = result
                && error.kind() != io::ErrorKind::NotFound
            {
                return Err(error.into());
            }
        }
    }
    if let Some(hook) = hooks.after_mutation {
        hook(&mutation)?;
    }
    Ok(())
}

pub fn assert_safe_path(root: &Path, target: &Path) -> Result<(), Error> {
    binding_identity(root, target).map(|_| ())
}
pub fn read_text(root: &Path, path: &Path, hooks: &Hooks<'_>) -> Result<String, Error> {
    assert_safe_path(root, path)?;
    if let Some(hook) = hooks.before_read {
        hook(path)?;
    }
    Ok(String::from_utf8_lossy(&fs::read(path)?).into_owned())
}
pub(crate) fn mkdir(root: &Path, path: &Path, hooks: &Hooks<'_>) -> Result<(), Error> {
    let root = absolute(root)?;
    let path = absolute(path)?;
    let relative = relative(&root, &path)?;
    assert_safe_path(&root, &root)?;
    let mut current = root.clone();
    for part in relative.components() {
        current.push(part);
        if fs::symlink_metadata(&current).is_ok() {
            assert_safe_path(&root, &current)?;
            continue;
        }
        execute_mutation(
            MutationRequest::Mkdir {
                root: &root,
                path: &current,
            },
            hooks,
        )?;
    }
    Ok(())
}
pub(crate) fn write(
    root: &Path,
    path: &Path,
    content: &str,
    exclusive: bool,
    hooks: &Hooks<'_>,
) -> Result<(), Error> {
    mkdir(
        root,
        path.parent().ok_or(Error::Unsafe("missing write parent"))?,
        hooks,
    )?;
    execute_mutation(
        MutationRequest::Write {
            root,
            path,
            content,
            exclusive,
        },
        hooks,
    )
}
pub(crate) fn move_across(
    source_root: &Path,
    destination_root: &Path,
    source: &Path,
    destination: &Path,
    hooks: &Hooks<'_>,
) -> Result<(), Error> {
    mkdir(
        destination_root,
        destination
            .parent()
            .ok_or(Error::Unsafe("missing rename parent"))?,
        hooks,
    )?;
    execute_mutation(
        MutationRequest::Rename {
            source_root,
            destination_root,
            source,
            destination,
            replace: false,
        },
        hooks,
    )
}
pub(crate) fn remove(
    root: &Path,
    path: &Path,
    recursive: bool,
    hooks: &Hooks<'_>,
) -> Result<(), Error> {
    execute_mutation(
        MutationRequest::Remove {
            root,
            path,
            recursive,
        },
        hooks,
    )
}
pub(crate) fn absolute(path: &Path) -> Result<PathBuf, Error> {
    crate::resources::discovery::absolute(path).map_err(|_| Error::Unsafe("invalid absolute path"))
}

#[derive(PartialEq)]
struct Binding {
    root: PathBuf,
    target: PathBuf,
    components: Vec<ComponentIdentity>,
}
#[derive(PartialEq)]
struct ComponentIdentity {
    path: PathBuf,
    identity: Option<FileIdentity>,
}
#[derive(PartialEq)]
struct FileIdentity {
    device: u64,
    inode: u64,
    mode: u32,
}
fn relative<'a>(root: &Path, target: &'a Path) -> Result<&'a Path, Error> {
    let relative = target
        .strip_prefix(root)
        .map_err(|_| Error::Unsafe("mutation escapes root"))?;
    if relative.as_os_str().to_string_lossy().starts_with("..") {
        return Err(Error::Unsafe("mutation escapes root"));
    }
    Ok(relative)
}
fn binding_identity(root: &Path, target: &Path) -> Result<Binding, Error> {
    let root = absolute(root)?;
    let target = absolute(target)?;
    let relative = relative(&root, &target)?;
    let canonical_root =
        fs::canonicalize(&root).map_err(|_| Error::Unsafe("unsafe mutation root"))?;
    let root_info =
        fs::symlink_metadata(&root).map_err(|_| Error::Unsafe("unsafe mutation root"))?;
    if root_info.is_symlink() || !root_info.is_dir() {
        return Err(Error::Unsafe("unsafe mutation root"));
    }
    let mut paths = vec![root.clone()];
    for component in relative.components() {
        paths.push(paths.last().expect("root path").join(component));
    }
    let mut components = Vec::new();
    for (index, current) in paths.iter().enumerate() {
        let Ok(info) = fs::symlink_metadata(current) else {
            components.push(ComponentIdentity {
                path: current.clone(),
                identity: None,
            });
            break;
        };
        if info.is_symlink() {
            return Err(Error::Unsafe("symbolic link in mutation path"));
        }
        if index < paths.len() - 1 && !info.is_dir() {
            return Err(Error::Unsafe("non-directory mutation ancestor"));
        }
        let canonical =
            fs::canonicalize(current).map_err(|_| Error::Unsafe("canonical mutation escape"))?;
        if !canonical.starts_with(&canonical_root) {
            return Err(Error::Unsafe("canonical mutation escape"));
        }
        components.push(ComponentIdentity {
            path: current.clone(),
            identity: Some(identity(&info)?),
        });
    }
    Ok(Binding {
        root,
        target,
        components,
    })
}
#[cfg(unix)]
fn identity(info: &fs::Metadata) -> Result<FileIdentity, Error> {
    use std::os::unix::fs::MetadataExt;
    Ok(FileIdentity {
        device: info.dev(),
        inode: info.ino(),
        mode: info.mode(),
    })
}
#[cfg(not(unix))]
fn identity(_: &fs::Metadata) -> Result<FileIdentity, Error> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Filesystem component identity requires a supported native platform",
    )
    .into())
}
fn metadata<'a>(request: &'a MutationRequest<'a>) -> Mutation<'a> {
    match request {
        MutationRequest::Mkdir { path, .. } => Mutation {
            operation: "mkdir",
            path: Some(path),
            source: None,
            destination: None,
        },
        MutationRequest::Write { path, .. } => Mutation {
            operation: "write",
            path: Some(path),
            source: None,
            destination: None,
        },
        MutationRequest::Rename {
            source,
            destination,
            ..
        } => Mutation {
            operation: "rename",
            path: None,
            source: Some(source),
            destination: Some(destination),
        },
        MutationRequest::Remove { path, .. } => Mutation {
            operation: "remove",
            path: Some(path),
            source: None,
            destination: None,
        },
    }
}
