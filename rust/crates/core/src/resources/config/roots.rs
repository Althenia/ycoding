use super::Error;
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Debug)]
pub struct Roots {
    pub home: PathBuf,
    pub os_home: PathBuf,
    pub data: PathBuf,
    pub cache: PathBuf,
    pub config: PathBuf,
    pub state: PathBuf,
    pub tmp: PathBuf,
    pub bin: PathBuf,
    pub log: PathBuf,
    pub repos: PathBuf,
    development_root: Option<PathBuf>,
}

impl Roots {
    pub fn runtime(
        home: &Path,
        temp: &Path,
        env: &BTreeMap<String, String>,
    ) -> Result<Self, Error> {
        let home = absolute(home)?;
        let data = xdg(env, "XDG_DATA_HOME", home.join(".local/share")).join("ycoding");
        let cache = xdg(env, "XDG_CACHE_HOME", home.join(".cache")).join("ycoding");
        let config = match env.get("YCODING_CONFIG_DIR") {
            Some(config) => PathBuf::from(config),
            None => xdg(env, "XDG_CONFIG_HOME", home.join(".config")).join("ycoding"),
        };
        Ok(Self {
            os_home: home.clone(),
            home: match env.get("YCODING_TEST_HOME") {
                Some(home) => PathBuf::from(home),
                None => home.clone(),
            },
            log: data.join("log"),
            repos: data.join("repos"),
            bin: cache.join("bin"),
            data,
            cache,
            config,
            state: xdg(env, "XDG_STATE_HOME", home.join(".local/state")).join("ycoding"),
            tmp: absolute(temp)?.join("ycoding"),
            development_root: None,
        })
    }

    pub fn development(root: &Path) -> Result<Self, Error> {
        let root = absolute(root)?;
        Ok(Self {
            home: root.clone(),
            os_home: root.clone(),
            data: root.join("data/ycoding"),
            cache: root.join("cache/ycoding"),
            config: root.join("config/ycoding"),
            state: root.join("state/ycoding"),
            tmp: root.join("ycoding"),
            bin: root.join("cache/ycoding/bin"),
            log: root.join("data/ycoding/log"),
            repos: root.join("data/ycoding/repos"),
            development_root: Some(root),
        })
    }

    pub fn initialize(&self) -> Result<(), Error> {
        self.validate()?;
        for path in [
            &self.data,
            &self.config,
            &self.cache,
            &self.state,
            &self.tmp,
            &self.log,
            &self.bin,
            &self.repos,
        ] {
            fs::create_dir_all(path).map_err(|cause| io_error(path, cause))?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.log, fs::Permissions::from_mode(0o700))
                .map_err(|cause| io_error(&self.log, cause))?;
        }
        Ok(())
    }

    pub(super) fn validate(&self) -> Result<(), Error> {
        for path in [
            &self.home,
            &self.os_home,
            &self.data,
            &self.cache,
            &self.config,
            &self.state,
            &self.tmp,
            &self.log,
            &self.bin,
            &self.repos,
        ] {
            self.check(path)?;
        }
        Ok(())
    }

    pub(super) fn check(&self, path: &Path) -> Result<(), Error> {
        let Some(root) = &self.development_root else {
            return Ok(());
        };
        let path = absolute(path)?;
        if !path.starts_with(root)
            || !canonical_existing(&path)?.starts_with(canonical_existing(root)?)
        {
            return Err(Error {
                path: Some(path.clone()),
                virtual_source: None,
                message: format!(
                    "Path {} escapes the development root {}",
                    path.display(),
                    root.display()
                ),
                cause: None,
            });
        }
        Ok(())
    }

    pub(super) fn discovery_boundary(&self) -> Option<&Path> {
        self.development_root.as_deref()
    }
}

fn xdg(env: &BTreeMap<String, String>, key: &str, default: PathBuf) -> PathBuf {
    env.get(key)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or(default)
}

pub(super) fn absolute(path: &Path) -> Result<PathBuf, Error> {
    let path = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|cause| io_error(path, cause))?
            .join(path)
    };
    Ok(path
        .components()
        .fold(PathBuf::new(), |mut result, component| {
            match component {
                Component::CurDir => {}
                Component::ParentDir => {
                    result.pop();
                }
                component => result.push(component),
            }
            result
        }))
}

fn canonical_existing(path: &Path) -> Result<PathBuf, Error> {
    let mut existing = path;
    let mut missing = Vec::new();
    loop {
        match fs::canonicalize(existing) {
            Ok(mut canonical) => {
                for component in missing.into_iter().rev() {
                    canonical.push(component);
                }
                return Ok(canonical);
            }
            Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {
                let Some(name) = existing.file_name() else {
                    return Err(io_error(existing, cause));
                };
                missing.push(name.to_owned());
                let Some(parent) = existing.parent() else {
                    return Err(io_error(existing, cause));
                };
                existing = parent;
            }
            Err(cause) => return Err(io_error(existing, cause)),
        }
    }
}

pub(super) fn io_error(path: &Path, cause: std::io::Error) -> Error {
    Error {
        path: Some(path.into()),
        virtual_source: None,
        message: format!(
            "Configuration filesystem operation failed at {}: {cause}",
            path.display()
        ),
        cause: Some(cause),
    }
}
