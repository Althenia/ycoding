use crate::platform::{
    filesystem::{self, mutation},
    git, worktree,
};
use crate::tools::{
    context::{Context, policy::LeafPolicy},
    registry::Failure,
};
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::Arc,
};
use ycoding_schema::{JsonObject, JsonValue, LosslessString};

pub struct Paths {
    pub directory: PathBuf,
    pub data: PathBuf,
    pub git: Arc<git::Service>,
}
pub struct Target {
    pub mutation: mutation::Target,
    pub external: Option<(String, String)>,
}
impl Paths {
    pub fn resolve(&self, input: &str, directory: bool) -> io::Result<Target> {
        let absolute = filesystem::normalize(&self.directory.join(input));
        let internal = filesystem::contains(&self.directory, &absolute);
        let root = fs::canonicalize(&self.directory)?;
        let mut anchor = absolute.clone();
        let (canonical, boundary) = loop {
            match fs::canonicalize(&anchor) {
                Ok(canonical) => {
                    let info = fs::metadata(&canonical)?;
                    if anchor != absolute && !info.is_dir() {
                        return Err(io::Error::new(
                            io::ErrorKind::NotADirectory,
                            "Mutation ancestor is not a directory",
                        ));
                    }
                    let target = if anchor == absolute {
                        canonical.clone()
                    } else {
                        canonical.join(absolute.strip_prefix(&anchor).map_err(io::Error::other)?)
                    };
                    let boundary = if info.is_dir() && (directory || anchor != absolute) {
                        canonical
                    } else {
                        canonical
                            .parent()
                            .ok_or_else(|| io::Error::other("No parent directory"))?
                            .to_owned()
                    };
                    break (target, boundary);
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    if !anchor.pop() {
                        return Err(error);
                    }
                }
                Err(error) => return Err(error),
            }
        };
        if internal && !filesystem::contains(&root, &canonical) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Path escapes the active Location",
            ));
        }
        let resource = if internal {
            canonical
                .strip_prefix(root)
                .map_err(io::Error::other)?
                .to_string_lossy()
                .replace('\\', "/")
        } else {
            canonical.to_string_lossy().replace('\\', "/")
        };
        let managed = if !internal {
            if let Some(repository) = self
                .git
                .discover(&self.directory)
                .map_err(io::Error::other)?
            {
                let parent = worktree::managed_destination(&self.data, &repository, "probe")
                    .map_err(io::Error::other)?
                    .parent()
                    .unwrap()
                    .to_owned();
                if filesystem::contains(&parent, &canonical) {
                    worktree::list(&self.git, &repository)
                        .map_err(io::Error::other)?
                        .iter()
                        .filter(|entry| !entry.main)
                        .any(|entry| {
                            fs::canonicalize(&entry.directory).is_ok_and(|linked| {
                                filesystem::contains(&parent, &linked)
                                    && filesystem::contains(&linked, &canonical)
                                    && self.git.discover(&linked).ok().flatten().is_some_and(
                                        |found| {
                                            fs::canonicalize(found.common_directory).ok()
                                                == fs::canonicalize(&repository.common_directory)
                                                    .ok()
                                        },
                                    )
                            })
                        })
                } else {
                    false
                }
            } else {
                false
            }
        } else {
            false
        };
        let external = if internal || managed {
            None
        } else {
            let save = self
                .git
                .discover(&boundary)
                .map_err(io::Error::other)?
                .map(|repository| repository.worktree)
                .unwrap_or_else(|| boundary.clone());
            Some((
                boundary.join("*").to_string_lossy().replace('\\', "/"),
                save.join("*").to_string_lossy().replace('\\', "/"),
            ))
        };
        Ok(Target {
            mutation: mutation::Target::new(
                canonical,
                if resource.is_empty() {
                    ".".into()
                } else {
                    resource
                },
            ),
            external,
        })
    }
}
impl Target {
    pub async fn authorize_external(
        &self,
        policy: &LeafPolicy,
        context: &Context,
    ) -> Result<(), Failure> {
        if let Some((resource, save)) = &self.external {
            policy
                .assert(
                    context,
                    "external_directory",
                    vec![resource.clone().into()],
                    vec![save.clone().into()],
                    None,
                )
                .await?;
        }
        Ok(())
    }
}

pub fn object(input: &JsonValue) -> Result<&JsonObject, Failure> {
    if let JsonValue::Object(object) = input {
        return Ok(object);
    }
    Err(Failure::message("Invalid tool input: Expected object"))
}
pub fn string(object: &JsonObject, key: &str) -> Result<LosslessString, Failure> {
    if let Some(JsonValue::String(value)) = object.get(&key.into()) {
        return Ok(value.clone());
    }
    Err(Failure::message(format!(
        "Invalid tool input: Expected string at {key}"
    )))
}
pub fn utf8(object: &JsonObject, key: &str) -> Result<String, Failure> {
    string(object, key)?
        .to_utf8()
        .map_err(|_| Failure::message(format!("Invalid tool input: {key} is not valid Unicode")))
}
pub fn optional_number(
    object: &JsonObject,
    key: &str,
    minimum: f64,
    maximum: f64,
) -> Result<Option<f64>, Failure> {
    match object.get(&key.into()) {
        None => Ok(None),
        Some(JsonValue::Number(value))
            if value.is_finite()
                && value.fract() == 0.0
                && *value >= minimum
                && *value <= maximum =>
        {
            Ok(Some(*value))
        }
        _ => Err(Failure::message(format!(
            "Invalid tool input: Invalid {key}"
        ))),
    }
}
pub fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
