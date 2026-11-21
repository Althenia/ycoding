use std::{
    collections::{BTreeMap, hash_map::RandomState},
    hash::{BuildHasher, Hasher},
    io::Write,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use ycoding_core::ycoding_schema::{
    JsonObject, JsonValue, ObjectEncoder, parse_json, stringify_json,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Enrollment {
    pub server_id: String,
    pub environment_id: String,
    pub server_name: String,
    pub remote_control_enabled: bool,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct State {
    pub installation_id: String,
    pub enrollments: BTreeMap<String, Enrollment>,
}

#[derive(Debug)]
pub struct StateError;
impl std::fmt::Display for StateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Invalid remote-control state")
    }
}
impl std::error::Error for StateError {}
impl From<std::io::Error> for StateError {
    fn from(_: std::io::Error) -> Self {
        Self
    }
}

pub fn installation_id() -> String {
    let mut bytes = [0u8; 16];
    for chunk in bytes.chunks_mut(8) {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u128(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_nanos()),
        );
        chunk.copy_from_slice(&hasher.finish().to_le_bytes());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

pub struct Store {
    path: PathBuf,
    lock: tokio::sync::Mutex<()>,
}

fn encode(state: &State) -> String {
    let mut enrollments = JsonObject::new();
    for (key, enrollment) in &state.enrollments {
        enrollments.insert(
            key.as_str().into(),
            ObjectEncoder::new()
                .field("serverID", enrollment.server_id.as_str())
                .field("environmentID", enrollment.environment_id.as_str())
                .field("serverName", enrollment.server_name.as_str())
                .field("remoteControlEnabled", &enrollment.remote_control_enabled)
                .field(
                    "updatedAt",
                    &JsonValue::Number(enrollment.updated_at as f64),
                )
                .finish(),
        );
    }
    stringify_json(
        &ObjectEncoder::new()
            .field("installationID", state.installation_id.as_str())
            .field("enrollments", &JsonValue::Object(enrollments))
            .finish(),
    )
}

fn decode_enrollment(value: &JsonValue) -> Option<Enrollment> {
    let JsonValue::Object(object) = value else {
        return None;
    };
    let text = |name: &str| match object.get(&name.into()) {
        Some(JsonValue::String(value)) => value.to_utf8().ok(),
        _ => None,
    };
    let (Some(JsonValue::Bool(enabled)), Some(JsonValue::Number(updated))) = (
        object.get(&"remoteControlEnabled".into()),
        object.get(&"updatedAt".into()),
    ) else {
        return None;
    };
    if !updated.is_finite() || *updated < 0.0 {
        return None;
    }
    Some(Enrollment {
        server_id: text("serverID")?,
        environment_id: text("environmentID")?,
        server_name: text("serverName")?,
        remote_control_enabled: *enabled,
        updated_at: *updated as u64,
    })
}

fn decode(content: &str) -> Result<State, StateError> {
    let Ok(JsonValue::Object(object)) = parse_json(content) else {
        return Err(StateError);
    };
    let installation_id = match object.get(&"installationID".into()) {
        Some(JsonValue::String(value)) => value.to_utf8().ok().filter(|value| !value.is_empty()),
        _ => None,
    }
    .ok_or(StateError)?;
    let mut enrollments = BTreeMap::new();
    if let Some(JsonValue::Object(saved)) = object.get(&"enrollments".into()) {
        for (key, value) in saved.iter() {
            if let (Ok(key), Some(enrollment)) = (key.to_utf8(), decode_enrollment(value)) {
                enrollments.insert(key, enrollment);
            }
        }
    }
    Ok(State {
        installation_id,
        enrollments,
    })
}

impl Store {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: tokio::sync::Mutex::new(()),
        }
    }

    fn temporary(&self) -> PathBuf {
        let mut name = self.path.clone().into_os_string();
        name.push(format!(".{}.{}.tmp", std::process::id(), installation_id()));
        PathBuf::from(name)
    }

    fn write_private(path: &PathBuf, content: &str) -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(path)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()
    }

    fn read(&self) -> Result<State, StateError> {
        match std::fs::read_to_string(&self.path) {
            Ok(content) => decode(&content),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => self.create(),
            Err(_) => Err(StateError),
        }
    }

    fn create(&self) -> Result<State, StateError> {
        let state = State {
            installation_id: installation_id(),
            enrollments: BTreeMap::new(),
        };
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temporary = self.temporary();
        Self::write_private(&temporary, &encode(&state))?;
        let published = std::fs::hard_link(&temporary, &self.path);
        let _ = std::fs::remove_file(&temporary);
        match published {
            Ok(()) => Ok(state),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                decode(&std::fs::read_to_string(&self.path)?)
            }
            Err(_) => Err(StateError),
        }
    }

    pub async fn load(&self) -> Result<State, StateError> {
        let _guard = self.lock.lock().await;
        self.read()
    }
}
