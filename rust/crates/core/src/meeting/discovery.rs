use serde_json::{Value, json};
use std::fmt;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub use ycoding_store::meeting::directory;

const DESCRIPTOR: &str = "bridge.json";
const LOCK: &str = "runtime.lock";

#[derive(Debug)]
pub enum DiscoveryError {
    Io(io::Error),
    Invalid(String),
}

impl fmt::Display for DiscoveryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => error.fmt(formatter),
            Self::Invalid(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for DiscoveryError {}

impl From<io::Error> for DiscoveryError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Descriptor {
    pub url: String,
    pub token: String,
    pub pid: u64,
}

impl Descriptor {
    pub fn parse(value: &Value) -> Result<Self, DiscoveryError> {
        let Value::Object(map) = value else {
            return Err(invalid("Meeting bridge descriptor must be an object"));
        };
        if map.len() != 3 {
            return Err(invalid("Meeting bridge descriptor has unexpected fields"));
        }
        let url = map
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("Meeting bridge descriptor needs a url"))?;
        let token = map
            .get("token")
            .and_then(Value::as_str)
            .filter(|token| {
                token.len() == 64
                    && token
                        .bytes()
                        .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
            })
            .ok_or_else(|| {
                invalid(
                    "Meeting bridge descriptor needs a 64-character lowercase hexadecimal token",
                )
            })?;
        let pid = map
            .get("pid")
            .and_then(Value::as_u64)
            .filter(|pid| *pid > 0)
            .ok_or_else(|| invalid("Meeting bridge descriptor needs a positive process id"))?;
        let address = url::Url::parse(url).map_err(|_| loopback())?;
        if address.scheme() != "http"
            || address.host_str() != Some("127.0.0.1")
            || address.port().is_none()
            || !address.username().is_empty()
            || address.password().is_some()
            || address.query().is_some()
            || address.fragment().is_some()
            || address.path() != "/"
        {
            return Err(loopback());
        }
        Ok(Self {
            url: url.into(),
            token: token.into(),
            pid,
        })
    }

    pub fn to_value(&self) -> Value {
        json!({ "url": self.url, "token": self.token, "pid": self.pid })
    }
}

pub fn publish_descriptor(directory: &Path, descriptor: &Descriptor) -> io::Result<()> {
    let path = directory.join(DESCRIPTOR);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(descriptor.to_value().to_string().as_bytes())
}

pub fn remove_descriptor(directory: &Path) -> io::Result<()> {
    std::fs::remove_file(directory.join(DESCRIPTOR))
}

#[derive(Clone, Debug)]
pub struct Control {
    descriptor: Descriptor,
}

impl Control {
    pub fn connect(directory: &Path) -> Result<Self, DiscoveryError> {
        let file = directory.join(DESCRIPTOR);
        let info = std::fs::symlink_metadata(&file)?;
        if !info.is_file() || info.len() > 4096 || !owned_privately(&info) {
            return Err(invalid("Unsafe meeting bridge descriptor"));
        }
        let text = std::fs::read_to_string(&file)?;
        let value = serde_json::from_str(&text)
            .map_err(|_| invalid("Meeting bridge descriptor is not valid JSON"))?;
        Ok(Self {
            descriptor: Descriptor::parse(&value)?,
        })
    }

    pub fn descriptor(&self) -> &Descriptor {
        &self.descriptor
    }

    pub async fn send(&self, input: &Value) -> Result<Value, super::client::ClientError> {
        super::client::send_control(&self.descriptor.url, &self.descriptor.token, input).await
    }
}

#[cfg(unix)]
fn owned_privately(info: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    info.mode() & 0o077 == 0 && info.uid() == unsafe { libc::getuid() }
}

#[cfg(not(unix))]
fn owned_privately(_: &std::fs::Metadata) -> bool {
    true
}

pub struct RuntimeLock {
    path: PathBuf,
}

impl RuntimeLock {
    pub fn acquire(directory: &Path) -> Result<Self, DiscoveryError> {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
            builder.mode(0o700);
            builder.create(directory)?;
            std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
        }
        #[cfg(not(unix))]
        builder.create(directory)?;
        let path = directory.join(LOCK);
        match std::fs::read_to_string(&path) {
            Ok(previous) => {
                let pid = serde_json::from_str::<Value>(&previous)
                    .ok()
                    .and_then(|value| value.get("pid").and_then(Value::as_u64))
                    .filter(|pid| *pid > 0 && *pid <= i32::MAX as u64)
                    .ok_or_else(|| invalid("Meeting runtime lock is corrupt"))?;
                if process_exists(pid as u32)? {
                    return Err(invalid(
                        "Meeting runtime is already running for this Location",
                    ));
                }
                std::fs::remove_file(&path)?;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options
            .open(&path)?
            .write_all(json!({ "pid": std::process::id() }).to_string().as_bytes())?;
        Ok(Self { path })
    }

    pub fn release(self) -> io::Result<()> {
        std::fs::remove_file(self.path)
    }
}

#[cfg(unix)]
fn process_exists(pid: u32) -> io::Result<bool> {
    if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(false);
    }
    Err(error)
}

#[cfg(not(unix))]
fn process_exists(pid: u32) -> io::Result<bool> {
    crate::platform::process::is_alive(pid)
}

fn invalid(message: &str) -> DiscoveryError {
    DiscoveryError::Invalid(message.into())
}

fn loopback() -> DiscoveryError {
    invalid("Meeting bridge must be a numeric loopback HTTP endpoint")
}
