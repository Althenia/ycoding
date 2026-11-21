pub mod collation;
pub mod fuzzy;
pub mod glob;
pub mod ignore;
mod mime_data;
pub mod mutation;
pub mod protected;
pub mod search;
pub mod util;
pub mod watcher;

use std::{
    fs, io,
    path::{Component, Path, PathBuf},
};
use ycoding_schema::{
    filesystem::{Entry, EntryType},
    schema::RelativePath,
};

#[derive(Debug)]
pub struct Location {
    directory: PathBuf,
    root: PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ReadResult {
    pub content: Vec<u8>,
    pub mime: &'static str,
}

impl Location {
    pub fn new(directory: &Path) -> io::Result<Self> {
        let directory = normalize(&std::path::absolute(directory)?);
        let root = fs::canonicalize(&directory)?;
        Ok(Self { directory, root })
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub fn resolve(&self, input: &str) -> io::Result<PathBuf> {
        let absolute = normalize(&self.directory.join(input));
        if !contains(&self.directory, &absolute) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Path escapes the location",
            ));
        }
        let real = fs::canonicalize(&absolute)?;
        if !contains(&self.root, &real) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Path escapes the location",
            ));
        }
        Ok(real)
    }

    pub fn read_bytes(&self, input: &str) -> io::Result<Vec<u8>> {
        let real = self.resolve(input)?;
        if !fs::metadata(&real)?.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Path is not a file",
            ));
        }
        fs::read(real)
    }

    pub fn read(&self, input: &str) -> io::Result<ReadResult> {
        let real = self.resolve(input)?;
        if !fs::metadata(&real)?.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Path is not a file",
            ));
        }
        Ok(ReadResult {
            content: fs::read(&real)?,
            mime: mime_type(
                real.to_str()
                    .ok_or_else(|| io::Error::other("Path is not UTF-8"))?,
            ),
        })
    }

    pub fn resolve_mutation(&self, input: &str) -> io::Result<mutation::Target> {
        self.resolve_mutation_path(input, false)
            .map(|(target, _, _)| target)
    }

    pub async fn resolve_mutation_authorized(
        &self,
        input: &str,
        permissions: &crate::tools::policy::permissions::Permissions,
        mut request: ycoding_schema::permission::Request,
        agent: Option<ycoding_schema::LosslessString>,
    ) -> Result<mutation::Target, mutation::ResolveError> {
        let (target, directory, external) = self.resolve_mutation_path(input, true)?;
        if external {
            let save = directory
                .ancestors()
                .find(|path| path.join(".git").exists() || path.join(".hg").exists())
                .unwrap_or(&directory);
            request.action = "external_directory".into();
            request.resources = vec![
                directory
                    .join("*")
                    .to_string_lossy()
                    .replace('\\', "/")
                    .into(),
            ];
            request.save = Some(vec![
                save.join("*").to_string_lossy().replace('\\', "/").into(),
            ]);
            permissions.assert(request, agent).await?;
        }
        Ok(target)
    }

    pub(crate) fn resolve_mutation_path(
        &self,
        input: &str,
        allow_external: bool,
    ) -> io::Result<(mutation::Target, PathBuf, bool)> {
        let absolute = normalize(&self.directory.join(input));
        let external = !contains(&self.directory, &absolute);
        if external && !allow_external {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Path escapes the location",
            ));
        }
        let mut anchor = absolute.clone();
        let (canonical, directory) = loop {
            match fs::canonicalize(&anchor) {
                Ok(existing) => {
                    if anchor != absolute && !fs::metadata(&existing)?.is_dir() {
                        return Err(io::Error::new(
                            io::ErrorKind::NotADirectory,
                            "Mutation ancestor is not a directory",
                        ));
                    }
                    let directory = if fs::metadata(&existing)?.is_dir() {
                        existing.clone()
                    } else {
                        existing
                            .parent()
                            .ok_or_else(|| io::Error::other("Mutation target has no parent"))?
                            .to_path_buf()
                    };
                    break (
                        if anchor == absolute {
                            existing
                        } else {
                            existing.join(absolute.strip_prefix(&anchor).map_err(io::Error::other)?)
                        },
                        directory,
                    );
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    if fs::symlink_metadata(&anchor).is_ok_and(|info| info.file_type().is_symlink())
                    {
                        return Err(io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            "Mutation target crosses an unresolved symlink",
                        ));
                    }
                    if !anchor.pop() {
                        return Err(error);
                    }
                }
                Err(error) => return Err(error),
            }
        };
        if !external && !contains(&self.root, &canonical) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Path escapes the location",
            ));
        }
        let resource = if external {
            canonical.to_string_lossy().replace('\\', "/")
        } else {
            canonical
                .strip_prefix(&self.root)
                .map_err(io::Error::other)?
                .to_string_lossy()
                .replace('\\', "/")
        };
        Ok((
            mutation::Target::new(
                canonical,
                if resource.is_empty() {
                    ".".into()
                } else {
                    resource
                },
            ),
            directory,
            external,
        ))
    }

    pub fn list(&self, input: Option<&str>) -> io::Result<Vec<Entry>> {
        let real = self.resolve(input.unwrap_or("."))?;
        if !fs::metadata(&real)?.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Path is not a directory",
            ));
        }
        let mut entries = Vec::new();
        for item in fs::read_dir(real)? {
            let item = item?;
            let kind = item.file_type()?;
            if !kind.is_file() && !kind.is_dir() {
                continue;
            }
            let relative = normalize(
                &self
                    .directory
                    .join(input.unwrap_or("."))
                    .join(item.file_name()),
            );
            let relative = relative
                .strip_prefix(&self.directory)
                .map_err(io::Error::other)?;
            let path = relative.to_string_lossy();
            entries.push(Entry {
                path: RelativePath::new(format!(
                    "{path}{}",
                    if kind.is_dir() {
                        std::path::MAIN_SEPARATOR_STR
                    } else {
                        ""
                    }
                ))
                .map_err(io::Error::other)?,
                r#type: if kind.is_dir() {
                    EntryType::Directory
                } else {
                    EntryType::File
                },
            });
        }
        entries.sort_by(|a, b| {
            (a.r#type != EntryType::Directory)
                .cmp(&(b.r#type != EntryType::Directory))
                .then_with(|| {
                    collation::compare(
                        &a.path.as_lossless().code_units().collect::<Vec<_>>(),
                        &b.path.as_lossless().code_units().collect::<Vec<_>>(),
                    )
                })
        });
        Ok(entries)
    }
}

pub fn normalize(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            component => result.push(component.as_os_str()),
        }
    }
    result
}

pub fn trim(input: &str) -> &str {
    input.trim_matches(|character| {
        matches!(
            character,
            '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        )
    })
}

pub fn contains(parent: &Path, child: &Path) -> bool {
    normalize(child).starts_with(normalize(parent))
}

pub fn overlaps(a: &Path, b: &Path) -> bool {
    contains(a, b) || contains(b, a)
}

pub fn mime_type(path: &str) -> &'static str {
    let extension = Path::new(&format!("x.{path}"))
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    mime_data::TYPES
        .binary_search_by_key(&extension.as_str(), |entry| entry.0)
        .map(|index| mime_data::TYPES[index].1)
        .unwrap_or("application/octet-stream")
}
