use std::{
    ffi::OsString,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
};
use tokio::{sync::Mutex, task::JoinHandle};

pub const VERSION: &str = "15.1.0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error {
    pub message: String,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for Error {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Target {
    pub triple: &'static str,
    pub extension: &'static str,
}
impl Target {
    pub fn for_key(key: &str) -> Result<Self, Error> {
        let (triple, extension) = match key {
            "arm64-darwin" => ("aarch64-apple-darwin", "tar.gz"),
            "arm64-linux" => ("aarch64-unknown-linux-gnu", "tar.gz"),
            "x64-darwin" => ("x86_64-apple-darwin", "tar.gz"),
            "x64-linux" => ("x86_64-unknown-linux-musl", "tar.gz"),
            "arm64-win32" => ("aarch64-pc-windows-msvc", "zip"),
            "ia32-win32" => ("i686-pc-windows-msvc", "zip"),
            "x64-win32" => ("x86_64-pc-windows-msvc", "zip"),
            _ => return Err(error(format!("unsupported platform for ripgrep: {key}"))),
        };
        Ok(Self { triple, extension })
    }

    pub fn filename(&self) -> String {
        format!("ripgrep-{VERSION}-{}.{}", self.triple, self.extension)
    }

    pub fn url(&self) -> String {
        format!(
            "https://github.com/BurntSushi/ripgrep/releases/download/{VERSION}/{}",
            self.filename()
        )
    }
}

pub trait Download: Send + Sync {
    fn get<'a>(
        &'a self,
        url: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, Error>> + Send + 'a>>;
}

pub struct HttpDownload(reqwest::Client);
impl HttpDownload {
    pub fn new() -> Result<Self, Error> {
        reqwest::Client::builder()
            .https_only(true)
            .retry(reqwest::retry::never())
            .build()
            .map(Self)
            .map_err(|e| error(e.to_string()))
    }
}
impl Download for HttpDownload {
    fn get<'a>(
        &'a self,
        url: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, Error>> + Send + 'a>> {
        Box::pin(async move {
            let response = self
                .0
                .get(url)
                .send()
                .await
                .map_err(|e| error(e.to_string()))?;
            if !response.status().is_success() {
                return Err(error(format!(
                    "HTTP status {} for {url}",
                    response.status().as_u16()
                )));
            }
            response
                .bytes()
                .await
                .map(|bytes| bytes.to_vec())
                .map_err(|e| error(e.to_string()))
        })
    }
}

pub struct Service {
    acquisition: Arc<Acquisition>,
    cached: Mutex<Cached>,
}
struct Acquisition {
    bin: PathBuf,
    platform_key: String,
    download: Arc<dyn Download>,
}
#[derive(Default)]
struct Cached {
    task: Option<JoinHandle<Result<PathBuf, Error>>>,
    result: Option<Result<PathBuf, Error>>,
}
impl Drop for Cached {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}
impl Service {
    pub fn new(bin: PathBuf) -> Result<Self, Error> {
        let http = HttpDownload::new()?;
        let arch = match std::env::consts::ARCH {
            "aarch64" => "arm64",
            "x86_64" => "x64",
            "x86" => "ia32",
            arch => arch,
        };
        let platform = match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            platform => platform,
        };
        Ok(Self::with_download(
            bin,
            format!("{arch}-{platform}"),
            Arc::new(http),
        ))
    }

    pub fn with_download(bin: PathBuf, platform_key: String, download: Arc<dyn Download>) -> Self {
        Self {
            acquisition: Arc::new(Acquisition {
                bin,
                platform_key,
                download,
            }),
            cached: Mutex::new(Cached::default()),
        }
    }

    pub async fn filepath(&self) -> Result<PathBuf, Error> {
        let mut cached = self.cached.lock().await;
        if let Some(result) = &cached.result {
            return result.clone();
        }
        let task = cached.task.get_or_insert_with(|| {
            let acquisition = self.acquisition.clone();
            tokio::spawn(async move { acquisition.acquire().await })
        });
        let result = task
            .await
            .map_err(|e| error(e.to_string()))
            .and_then(|result| result);
        cached.result = Some(result.clone());
        cached.task = None;
        result
    }
}

impl Acquisition {
    async fn acquire(&self) -> Result<PathBuf, Error> {
        let windows = self.platform_key.ends_with("-win32");
        let name = if windows { "rg.exe" } else { "rg" };
        if let Some(system) = which(name, &self.bin, windows) {
            return Ok(system);
        }
        let target = self.bin.join(name);
        if target.is_file() {
            return Ok(target);
        }
        let config = Target::for_key(&self.platform_key)?;
        let url = config.url();
        tokio::fs::create_dir_all(&self.bin)
            .await
            .map_err(|e| error(e.to_string()))?;
        let bytes = self.download.get(&url).await?;
        if bytes.is_empty() {
            return Err(error(format!("failed to download ripgrep from {url}")));
        }
        let archive = self.bin.join(config.filename());
        tokio::fs::write(&archive, bytes)
            .await
            .map_err(|e| error(e.to_string()))?;
        let bin = self.bin.clone();
        let source = archive.clone();
        let destination = target.clone();
        tokio::task::spawn_blocking(move || extract(&bin, &source, config, &destination, name))
            .await
            .map_err(|e| error(e.to_string()))??;
        let _ = tokio::fs::remove_file(archive).await;
        Ok(target)
    }
}

fn which(name: &str, bin: &Path, windows: bool) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")
        .or_else(|| std::env::var_os("Path"))
        .unwrap_or_default();
    let mut paths = if windows {
        vec![std::env::current_dir().ok()?]
    } else {
        Vec::new()
    };
    if !path.is_empty() {
        paths.extend(if windows {
            path.to_string_lossy()
                .split(';')
                .map(PathBuf::from)
                .collect::<Vec<_>>()
        } else {
            std::env::split_paths(&path).collect::<Vec<_>>()
        });
    }
    paths.push(bin.into());
    let extensions = if windows {
        std::env::var_os("PATHEXT")
            .or_else(|| std::env::var_os("PathExt"))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| OsString::from(".EXE;.CMD;.BAT;.COM"))
            .to_string_lossy()
            .split(';')
            .map(str::to_owned)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let suffixes = std::iter::once(String::new())
        .chain(
            extensions
                .iter()
                .flat_map(|ext| [ext.clone(), ext.to_lowercase()]),
        )
        .collect::<Vec<_>>();
    #[cfg(unix)]
    let (uid, gid, groups) = {
        let uid = unsafe { libc::getuid() };
        let gid = unsafe { libc::getgid() };
        let count = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
        if count < 0 {
            return None;
        }
        let mut groups = vec![0; count as usize];
        if count > 0 && unsafe { libc::getgroups(count, groups.as_mut_ptr()) } < 0 {
            return None;
        }
        (uid, gid, groups)
    };
    paths
        .into_iter()
        .map(|directory| {
            let text = directory.to_string_lossy();
            text.strip_prefix('"')
                .and_then(|text| text.strip_suffix('"'))
                .map_or(directory.clone(), PathBuf::from)
        })
        .flat_map(|directory| {
            suffixes
                .iter()
                .map(move |suffix| directory.join(format!("{name}{suffix}")))
        })
        .find(|path| {
            if !path.is_file() {
                return false;
            }
            if windows {
                return extensions.iter().any(|extension| {
                    extension.is_empty()
                        || path
                            .to_string_lossy()
                            .to_lowercase()
                            .ends_with(&extension.to_lowercase())
                });
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                path.metadata().is_ok_and(|metadata| {
                    metadata.mode() & 0o001 != 0
                        || (metadata.mode() & 0o010 != 0
                            && (metadata.gid() == gid || groups.contains(&metadata.gid())))
                        || (metadata.mode() & 0o100 != 0 && metadata.uid() == uid)
                        || (metadata.mode() & 0o110 != 0 && uid == 0)
                })
            }
            #[cfg(not(unix))]
            {
                true
            }
        })
}

struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn extract(
    bin: &Path,
    archive: &Path,
    config: Target,
    target: &Path,
    name: &str,
) -> Result<(), Error> {
    let suffix = super::random::<16>()
        .map_err(|e| error(e.to_string()))?
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let directory = bin.join(format!("ripgrep-{suffix}"));
    std::fs::create_dir(&directory).map_err(|e| error(e.to_string()))?;
    let temporary = Temporary(directory);
    let file = std::fs::File::open(archive).map_err(|e| error(e.to_string()))?;
    match config.extension {
        "zip" => zip::ZipArchive::new(file)
            .map_err(|e| error(e.to_string()))?
            .extract(&temporary.0)
            .map_err(|e| error(e.to_string()))?,
        _ => tar::Archive::new(flate2::read::GzDecoder::new(file))
            .unpack(&temporary.0)
            .map_err(|e| error(e.to_string()))?,
    }
    let extracted = temporary
        .0
        .join(format!("ripgrep-{VERSION}-{}", config.triple))
        .join(name);
    if !extracted.is_file() {
        return Err(error(format!(
            "ripgrep archive did not contain executable: {}",
            extracted.display()
        )));
    }
    std::fs::copy(extracted, target).map_err(|e| error(e.to_string()))?;
    #[cfg(unix)]
    if name != "rg.exe" {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(target, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| error(e.to_string()))?;
    }
    Ok(())
}

fn error(message: String) -> Error {
    Error { message }
}
