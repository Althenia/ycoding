use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub const DIRECTORY_NAME: &str = "computer-history";

const SCHEMA: u64 = 1;
const MAX_FILES: usize = 200;
const RETENTION_SECONDS: u64 = 30 * 24 * 60 * 60;

#[derive(Clone, Debug, PartialEq)]
pub struct Screenshot {
    pub sha256: String,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub scale: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub session_id: String,
    pub action: String,
    pub bundle_id: String,
    pub pid: u64,
    pub window_id: u64,
    pub revision: String,
    pub effect: Option<String>,
    pub screenshot: Option<Screenshot>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StoredEvent {
    pub at: String,
    pub session_id: String,
    pub action: String,
    pub bundle_id: String,
    pub pid: u64,
    pub window_id: u64,
    pub revision: String,
    pub effect: Option<String>,
    pub screenshot: Option<Screenshot>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub id: String,
    pub file: String,
    pub session_id: String,
    pub started: String,
    pub updated: String,
    pub events: usize,
}

pub struct Recorder {
    directory: PathBuf,
    files: std::sync::Mutex<std::collections::HashMap<String, PathBuf>>,
    pruned: std::sync::Mutex<bool>,
}

impl Recorder {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            files: std::sync::Mutex::new(std::collections::HashMap::new()),
            pruned: std::sync::Mutex::new(false),
        }
    }

    pub fn record(&self, event: Event) -> Result<(), String> {
        {
            let mut pruned = self.pruned.lock().unwrap_or_else(|e| e.into_inner());
            if !*pruned {
                *pruned = true;
                let _ = prune(&self.directory);
            }
        }
        std::fs::create_dir_all(&self.directory)
            .map_err(|error| format!("computer history write failed: {error}"))?;
        let now = now_iso();
        let line = event_line(&event, &now);
        let existing = self
            .files
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&event.session_id)
            .cloned();
        if let Some(file) = existing {
            use std::io::Write;
            let mut handle = std::fs::OpenOptions::new()
                .append(true)
                .open(&file)
                .map_err(|error| format!("computer history write failed: {error}"))?;
            return writeln!(handle, "{line}")
                .map_err(|error| format!("computer history write failed: {error}"));
        }
        let file = self.directory.join(file_for(&now, &event.session_id));
        let header = json!({"type": "session", "schema": SCHEMA, "sessionID": event.session_id, "started": now});
        std::fs::write(&file, format!("{header}\n{line}\n"))
            .map_err(|error| format!("computer history write failed: {error}"))?;
        self.files
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(event.session_id.clone(), file);
        Ok(())
    }
}

pub fn screenshot_ref(
    data: Option<&str>,
    width: Option<f64>,
    height: Option<f64>,
    scale: Option<f64>,
) -> Option<Screenshot> {
    data.map(|data| Screenshot {
        sha256: ring::digest::digest(&ring::digest::SHA256, data.as_bytes())
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        width,
        height,
        scale,
    })
}

pub fn list(directory: &Path) -> Result<Vec<Entry>, String> {
    let mut entries = Vec::new();
    for file in files(directory) {
        let full = directory.join(&file);
        let contents = std::fs::read_to_string(&full).unwrap_or_default();
        let lines: Vec<&str> = contents
            .lines()
            .filter(|line| !line.trim().is_empty())
            .collect();
        let header: Value = lines
            .first()
            .and_then(|line| serde_json::from_str(line).ok())
            .unwrap_or_else(|| json!({}));
        if header.is_null() {
            return Err("Invalid computer history header".into());
        }
        let updated = std::fs::metadata(&full)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or_else(String::new, |duration| iso_from_seconds(duration.as_secs()));
        entries.push(Entry {
            id: file.trim_end_matches(".jsonl").to_owned(),
            file,
            session_id: text(&header, "sessionID").unwrap_or_default(),
            started: text(&header, "started").unwrap_or_default(),
            updated,
            events: lines.len().saturating_sub(1),
        });
    }
    Ok(entries)
}

pub fn read(directory: &Path, id: &str, limit: usize) -> Result<Vec<StoredEvent>, String> {
    let file = resolve_file(directory, id)?;
    let contents = std::fs::read_to_string(&file)
        .map_err(|_| "Computer history entry is unavailable".to_string())?;
    let mut events = Vec::new();
    for line in contents
        .lines()
        .filter(|line| !line.trim().is_empty())
        .skip(1)
    {
        let value: Value =
            serde_json::from_str(line).map_err(|_| "Invalid computer history event".to_string())?;
        if value["type"] != "event" {
            continue;
        }
        events.push(parse_event(&value)?);
        if events.len() >= limit {
            break;
        }
    }
    Ok(events)
}

fn files(directory: &Path) -> Vec<String> {
    let Ok(read) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut names: Vec<String> = read
        .filter_map(Result::ok)
        .map(|item| item.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".jsonl"))
        .collect();
    names.sort();
    names
}

fn resolve_file(directory: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty()
        || id.encode_utf16().count() > 200
        || id.contains(['/', '\\'])
        || id.contains("..")
    {
        return Err("Invalid computer history id".into());
    }
    Ok(directory.join(format!("{id}.jsonl")))
}

fn file_for(started: &str, session_id: &str) -> String {
    let sanitized: String = session_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect();
    format!("{}-{sanitized}.jsonl", started.replace(':', "-"))
}

pub fn clear(directory: &Path, session: Option<&str>) -> Result<usize, String> {
    let names: Vec<String> = match session {
        None => files(directory),
        Some(session) => list(directory)?
            .into_iter()
            .filter(|entry| entry.session_id == session)
            .map(|entry| entry.file)
            .collect(),
    };
    for name in &names {
        std::fs::remove_file(directory.join(name)).map_err(io)?;
    }
    Ok(names.len())
}

fn prune(directory: &Path) -> Result<(), String> {
    let cutoff = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs()
        .saturating_sub(RETENTION_SECONDS);
    let Ok(read) = std::fs::read_dir(directory) else {
        return Ok(());
    };
    let mut files: Vec<(u64, PathBuf)> = Vec::new();
    for item in read {
        let item = item.map_err(io)?;
        if !item.file_name().to_string_lossy().ends_with(".jsonl") {
            continue;
        }
        let modified = item
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |duration| duration.as_secs());
        if modified < cutoff {
            let _ = std::fs::remove_file(item.path());
        } else {
            files.push((modified, item.path()));
        }
    }
    files.sort_by_key(|(modified, _)| *modified);
    while files.len() > MAX_FILES {
        let _ = std::fs::remove_file(files.remove(0).1);
    }
    Ok(())
}

fn parse_event(value: &Value) -> Result<StoredEvent, String> {
    let invalid = || "Invalid computer history event".to_string();
    if value["type"] != "event" {
        return Err(invalid());
    }
    let screenshot = match value.get("screenshot") {
        None | Some(Value::Null) => None,
        Some(shot) => Some(Screenshot {
            sha256: text(shot, "sha256").ok_or_else(invalid)?,
            width: shot.get("width").and_then(Value::as_f64),
            height: shot.get("height").and_then(Value::as_f64),
            scale: shot.get("scale").and_then(Value::as_f64),
        }),
    };
    let effect = text(value, "effect");
    if effect
        .as_deref()
        .is_some_and(|effect| !matches!(effect, "changed" | "unchanged" | "unverified"))
    {
        return Err(invalid());
    }
    Ok(StoredEvent {
        at: text(value, "at").ok_or_else(invalid)?,
        session_id: text(value, "sessionID").ok_or_else(invalid)?,
        action: text(value, "action").ok_or_else(invalid)?,
        bundle_id: text(value, "bundleID").ok_or_else(invalid)?,
        pid: value["pid"].as_u64().ok_or_else(invalid)?,
        window_id: value["windowID"].as_u64().ok_or_else(invalid)?,
        revision: text(value, "revision").ok_or_else(invalid)?,
        effect,
        screenshot,
    })
}

fn event_line(event: &Event, at: &str) -> Value {
    let mut line = json!({
        "type": "event",
        "at": at,
        "sessionID": event.session_id,
        "action": event.action,
        "bundleID": event.bundle_id,
        "pid": event.pid,
        "windowID": event.window_id,
        "revision": event.revision,
    });
    if let Some(effect) = &event.effect {
        line["effect"] = json!(effect);
    }
    if let Some(shot) = &event.screenshot {
        let mut value = json!({"sha256": shot.sha256});
        if let Some(width) = shot.width {
            value["width"] = json!(width);
        }
        if let Some(height) = shot.height {
            value["height"] = json!(height);
        }
        if let Some(scale) = shot.scale {
            value["scale"] = json!(scale);
        }
        line["screenshot"] = value;
    }
    line
}

fn text(value: &Value, key: &str) -> Option<String> {
    value[key].as_str().map(str::to_owned)
}

fn io(error: std::io::Error) -> String {
    format!("computer history read failed: {error}")
}

pub fn now_iso() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs());
    iso_from_seconds(seconds)
}

fn iso_from_seconds(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64;
    let rest = seconds % 86_400;
    let (year, month, day) = civil(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
        rest / 3600,
        (rest % 3600) / 60,
        rest % 60
    )
}

fn civil(days_since_epoch: i64) -> (i64, u32, u32) {
    let shifted = days_since_epoch + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    } as u32;
    if month <= 2 {
        year += 1;
    }
    (year, month, day)
}
