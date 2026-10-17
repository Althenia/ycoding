use ring::{
    digest,
    rand::{SecureRandom, SystemRandom},
};
use serde_json::{Value, json};
use std::{
    fs, io,
    path::{Component, Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

const MAX_PEAKS: usize = 5;
const MAX_KEYS: usize = 256;
const CONTENTION_WAIT: Duration = Duration::from_secs(1);
const CONTENTION_POLL: Duration = Duration::from_millis(10);

#[derive(Clone, Debug)]
pub struct Requirement {
    pub command: String,
    pub cwd: PathBuf,
    pub memory_limit_mb: Option<u64>,
    pub reserve_mb: u64,
}

#[derive(Clone, Debug)]
pub struct Peak {
    pub command: String,
    pub cwd: PathBuf,
    pub memory_limit_mb: Option<u64>,
    pub reserve_mb: u64,
    pub peak_mb: f64,
    pub can_lower: bool,
}

type Entries = Vec<(String, Vec<f64>)>;

#[derive(Clone, Debug)]
pub struct History {
    directory: PathBuf,
}

impl History {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
        }
    }

    pub fn requirement(&self, input: &Requirement) -> f64 {
        requirement(&self.read(), input)
    }

    pub fn record(&self, input: &Peak) -> io::Result<()> {
        if !input.peak_mb.is_finite() || input.peak_mb <= 0.0 {
            return Ok(());
        }
        fs::create_dir_all(&self.directory)?;
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.directory.join("memory.lock"))?;
        let deadline = Instant::now() + CONTENTION_WAIT;
        while lock.try_lock().is_err() {
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Shell memory history is locked by another writer",
                ));
            }
            thread::sleep(CONTENTION_POLL);
        }
        self.remove_abandoned()?;
        let mut history = self.read();
        let requirement_input = Requirement {
            command: input.command.clone(),
            cwd: input.cwd.clone(),
            memory_limit_mb: input.memory_limit_mb,
            reserve_mb: input.reserve_mb,
        };
        if !input.can_lower && input.peak_mb <= requirement(&history, &requirement_input) {
            return Ok(());
        }
        let digest = key(&input.command, &input.cwd);
        let mut peaks = history
            .iter()
            .find(|entry| entry.0 == digest)
            .map(|entry| entry.1.clone())
            .unwrap_or_default();
        peaks.push(input.peak_mb);
        peaks.drain(..peaks.len().saturating_sub(MAX_PEAKS));
        history.retain(|entry| entry.0 != digest);
        history.push((digest, peaks));
        history.drain(..history.len().saturating_sub(MAX_KEYS));
        self.write(&history)
    }

    fn file(&self) -> PathBuf {
        self.directory.join("memory.json")
    }

    fn read(&self) -> Entries {
        match fs::read_to_string(self.file()) {
            Ok(text) => decode(&text).unwrap_or_default(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(error) => {
                tracing::warn!(%error, "Shell memory history is unavailable");
                Vec::new()
            }
        }
    }

    fn write(&self, history: &Entries) -> io::Result<()> {
        let temporary = self
            .directory
            .join(format!("memory.json.{}.tmp", random_uuid()?));
        let text = Value::Array(
            history
                .iter()
                .map(|(key, peaks)| json!({"key": key, "peaks": peaks}))
                .collect(),
        )
        .to_string();
        let written = write_private(&temporary, text.as_bytes())
            .and_then(|()| fs::rename(&temporary, self.file()));
        if written.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        written
    }

    fn remove_abandoned(&self) -> io::Result<()> {
        for entry in fs::read_dir(&self.directory)? {
            let name = entry?.file_name();
            if abandoned(&name.to_string_lossy()) {
                let _ = fs::remove_file(self.directory.join(name));
            }
        }
        Ok(())
    }
}

fn requirement(history: &Entries, input: &Requirement) -> f64 {
    let digest = key(&input.command, &input.cwd);
    let limit = input.memory_limit_mb.map(|limit| limit as f64);
    match history
        .iter()
        .find(|entry| entry.0 == digest)
        .map(|entry| &entry.1)
        .filter(|peaks| !peaks.is_empty())
    {
        Some(peaks) => peaks
            .iter()
            .copied()
            .fold(f64::MIN, f64::max)
            .min(limit.unwrap_or(f64::INFINITY)),
        None => limit.unwrap_or(input.reserve_mb as f64),
    }
}

fn decode(text: &str) -> Option<Entries> {
    let Value::Array(entries) = serde_json::from_str(text).ok()? else {
        return None;
    };
    if entries.len() > MAX_KEYS {
        return None;
    }
    entries
        .iter()
        .map(|entry| {
            let key = entry.get("key")?.as_str()?.to_owned();
            let peaks = entry
                .get("peaks")?
                .as_array()?
                .iter()
                .map(|peak| peak.as_f64().filter(|peak| peak.is_finite() && *peak > 0.0))
                .collect::<Option<Vec<_>>>()?;
            (peaks.len() <= MAX_PEAKS).then_some((key, peaks))
        })
        .collect()
}

fn key(command: &str, cwd: &Path) -> String {
    let encoded = json!([command, resolve(cwd).to_string_lossy()]).to_string();
    digest::digest(&digest::SHA256, encoded.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn resolve(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut resolved = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            other => resolved.push(other.as_os_str()),
        }
    }
    resolved
}

fn abandoned(name: &str) -> bool {
    name.strip_prefix("memory.json.")
        .and_then(|name| name.strip_suffix(".tmp"))
        .is_some_and(|id| {
            id.len() == 36
                && id
                    .chars()
                    .all(|letter| letter == '-' || matches!(letter, '0'..='9' | 'a'..='f'))
        })
}

pub(super) fn random_uuid() -> io::Result<String> {
    let mut bytes = [0_u8; 16];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| io::Error::other("Random identifiers are unavailable"))?;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

pub(super) fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(bytes)
}
