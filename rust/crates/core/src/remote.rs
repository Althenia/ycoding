use crate::resources::mcp::skills::encode_base64;
use reqwest::header::CONTENT_TYPE;
use ring::{
    rand::{SecureRandom, SystemRandom},
    signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair},
};
use serde_json::{Map, Value, json};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

pub const FILE: &str = "remote-device.json";
const DEADLINE: Duration = Duration::from_secs(30);
const LIMIT: usize = 64 * 1024;
const SAFE_INTEGER: u64 = 9_007_199_254_740_991;
// ring's P-256 PKCS#8 v1 layout: prefix || private scalar || middle || uncompressed public point.
const PKCS8_PREFIX: [u8; 36] = [
    0x30, 0x81, 0x87, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02,
    0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x6d, 0x30, 0x6b, 0x02,
    0x01, 0x01, 0x04, 0x20,
];
const PKCS8_MIDDLE: [u8; 5] = [0xa1, 0x44, 0x03, 0x42, 0x00];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Store,
    NotEnrolled,
    Revoked,
    Relay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialState {
    NotAuthenticated,
    Valid,
    Expired,
    Revoked,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Summary {
    pub device_id: String,
    pub name: String,
    pub relay_origin: String,
    pub enrolled_at: u64,
    pub credential_state: CredentialState,
    pub credential_expires_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnrollError {
    InvalidOrigin,
    InvalidCode,
    MissingName,
    AlreadyEnrolled,
    RelayRejected,
    RelayUnavailable,
    KeyFailed,
    StoreFailed,
    Partial(Summary),
}

pub struct Enrollment {
    pub relay_origin: String,
    pub enrollment_id: String,
    pub code: String,
    pub name: Option<String>,
    pub replace: bool,
}

pub struct Access {
    pub token: String,
    pub expires_at: u64,
    pub device_id: String,
    pub relay_origin: String,
}

#[derive(Clone)]
pub struct Device(Arc<Inner>);

struct Inner {
    path: PathBuf,
    http: reqwest::Client,
    writer: tokio::sync::Mutex<()>,
    revoked: Mutex<Option<String>>,
}

struct Identity {
    device_id: String,
    name: String,
    relay_origin: String,
    public_key: Value,
    private_key: Value,
    refresh_token: Option<String>,
    refresh_expires_at: Option<u64>,
    enrolled_at: u64,
}

struct Tokens {
    access_token: String,
    access_expires_at: u64,
    refresh_token: String,
    refresh_expires_at: u64,
}

enum Posted {
    Accepted(Value),
    Unauthorized,
    Rejected,
    Unavailable,
}

impl Device {
    pub fn new(state: &Path) -> Result<Self, Error> {
        Ok(Self(Arc::new(Inner {
            path: state.join(FILE),
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .build()
                .map_err(|_| Error::Relay)?,
            writer: tokio::sync::Mutex::new(()),
            revoked: Mutex::new(None),
        })))
    }

    pub async fn summary(&self, now: u64) -> Result<Option<Summary>, Error> {
        Ok(self
            .read()
            .await?
            .map(|identity| self.summarize(&identity, now)))
    }

    pub async fn enrolled(&self) -> Result<(String, String), Error> {
        let identity = self.read().await?.ok_or(Error::NotEnrolled)?;
        Ok((identity.relay_origin, identity.device_id))
    }

    pub async fn enroll(&self, input: Enrollment, now: u64) -> Result<Summary, EnrollError> {
        let result = self.register(input, now).await;
        match &result {
            Ok(_) => tracing::info!("remote device enrolled"),
            Err(error) => tracing::warn!(
                reason = enroll_reason(error),
                "remote device enrollment failed"
            ),
        }
        result
    }

    pub async fn access(&self, now: u64) -> Result<Access, Error> {
        let _writer = self.0.writer.lock().await;
        let mut identity = self.read().await?.ok_or(Error::NotEnrolled)?;
        let tokens = match tokio::time::timeout(DEADLINE, self.rotate(&identity, now)).await {
            Ok(Ok(tokens)) => tokens,
            Ok(Err(Error::Revoked)) => {
                tracing::warn!("remote relay no longer authorizes this device");
                *self.0.revoked.lock().map_err(|_| Error::Store)? =
                    Some(identity.device_id.clone());
                return Err(Error::Revoked);
            }
            Ok(Err(error)) => return Err(error),
            Err(_) => return Err(Error::Relay),
        };
        identity.refresh_token = Some(tokens.refresh_token);
        identity.refresh_expires_at = Some(tokens.refresh_expires_at);
        write(self.0.path.clone(), encode(&identity), false).await?;
        let mut revoked = self.0.revoked.lock().map_err(|_| Error::Store)?;
        if revoked.as_deref() == Some(identity.device_id.as_str()) {
            *revoked = None;
        }
        Ok(Access {
            token: tokens.access_token,
            expires_at: tokens.access_expires_at,
            device_id: identity.device_id,
            relay_origin: identity.relay_origin,
        })
    }

    async fn register(&self, input: Enrollment, now: u64) -> Result<Summary, EnrollError> {
        let origin = normalize_origin(&input.relay_origin).ok_or(EnrollError::InvalidOrigin)?;
        if !enrollment_code(&input.code) {
            return Err(EnrollError::InvalidCode);
        }
        let _writer = self.0.writer.lock().await;
        let existing = self.read().await.map_err(|_| EnrollError::StoreFailed)?;
        if existing.is_some() && !input.replace {
            return Err(EnrollError::AlreadyEnrolled);
        }
        let name = input
            .name
            .map(|name| name.trim().to_owned())
            .filter(|name| !name.is_empty())
            .or_else(hostname)
            .ok_or(EnrollError::MissingName)?;
        let (public_key, private_key) = generate().ok_or(EnrollError::KeyFailed)?;
        let posted = tokio::time::timeout(
            DEADLINE,
            self.post(
                &origin,
                "enroll",
                json!({
                    "enrollmentID": input.enrollment_id.trim(),
                    "code": input.code,
                    "name": name,
                    "publicKey": public_key,
                }),
            ),
        )
        .await
        .unwrap_or(Posted::Unavailable);
        let device_id = match posted {
            Posted::Accepted(value) => text(&value, "deviceID")
                .filter(|value| bounded(value, 128))
                .ok_or(EnrollError::RelayUnavailable)?
                .to_owned(),
            Posted::Unauthorized | Posted::Rejected => return Err(EnrollError::RelayRejected),
            Posted::Unavailable => return Err(EnrollError::RelayUnavailable),
        };
        let identity = Identity {
            device_id,
            name,
            relay_origin: origin,
            public_key,
            private_key,
            refresh_token: None,
            refresh_expires_at: None,
            enrolled_at: now,
        };
        let summary = self.summarize(&identity, now);
        write(self.0.path.clone(), encode(&identity), existing.is_none())
            .await
            .map_err(|_| EnrollError::Partial(summary.clone()))?;
        Ok(summary)
    }

    async fn rotate(&self, identity: &Identity, now: u64) -> Result<Tokens, Error> {
        if let (Some(refresh_token), Some(expires_at)) =
            (&identity.refresh_token, identity.refresh_expires_at)
            && expires_at > now
        {
            let posted = self
                .post(
                    &identity.relay_origin,
                    "refresh",
                    json!({ "deviceID": identity.device_id, "refreshToken": refresh_token }),
                )
                .await;
            return tokens(accepted(posted)?);
        }
        let challenge = accepted(
            self.post(
                &identity.relay_origin,
                "challenge",
                json!({ "deviceID": identity.device_id }),
            )
            .await,
        )?;
        let challenge_id = text(&challenge, "challengeID").ok_or(Error::Relay)?;
        let nonce = text(&challenge, "nonce").ok_or(Error::Relay)?;
        let signature = sign(&identity.private_key, challenge_id, nonce).ok_or(Error::Store)?;
        let posted = self
            .post(
                &identity.relay_origin,
                "token",
                json!({
                    "deviceID": identity.device_id,
                    "challengeID": challenge_id,
                    "signature": signature,
                }),
            )
            .await;
        tokens(accepted(posted)?)
    }

    async fn post(&self, origin: &str, operation: &str, body: Value) -> Posted {
        let Ok(body) = serde_json::to_vec(&body) else {
            return Posted::Unavailable;
        };
        let Ok(mut response) = self
            .0
            .http
            .post(format!("{origin}/api/devices/{operation}"))
            .header(CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
        else {
            return Posted::Unavailable;
        };
        match response.status().as_u16() {
            200..=299 => {}
            401 | 403 | 410 => return Posted::Unauthorized,
            408 | 429 | 500..=599 => return Posted::Unavailable,
            _ => return Posted::Rejected,
        }
        let mut bytes = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) if bytes.len() + chunk.len() <= LIMIT => bytes.extend(chunk),
                Ok(None) => break,
                _ => return Posted::Unavailable,
            }
        }
        serde_json::from_slice::<Value>(&bytes)
            .ok()
            .filter(Value::is_object)
            .map_or(Posted::Unavailable, Posted::Accepted)
    }

    async fn read(&self) -> Result<Option<Identity>, Error> {
        let path = self.0.path.clone();
        tokio::task::spawn_blocking(move || read(&path))
            .await
            .map_err(|_| Error::Store)?
    }

    fn summarize(&self, identity: &Identity, now: u64) -> Summary {
        let revoked = self
            .0
            .revoked
            .lock()
            .is_ok_and(|revoked| revoked.as_deref() == Some(identity.device_id.as_str()));
        let expires_at = identity
            .refresh_token
            .as_ref()
            .and(identity.refresh_expires_at);
        Summary {
            device_id: identity.device_id.clone(),
            name: identity.name.clone(),
            relay_origin: identity.relay_origin.clone(),
            enrolled_at: identity.enrolled_at,
            credential_state: match expires_at {
                _ if revoked => CredentialState::Revoked,
                None => CredentialState::NotAuthenticated,
                Some(expires_at) if expires_at <= now => CredentialState::Expired,
                Some(_) => CredentialState::Valid,
            },
            credential_expires_at: expires_at,
        }
    }
}

pub fn normalize_origin(origin: &str) -> Option<String> {
    let uri = url::Url::parse(origin).ok()?;
    let loopback = uri.scheme() == "http"
        && matches!(uri.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !uri.username().is_empty()
        || uri.password().is_some()
        || uri.query().is_some()
        || uri.fragment().is_some()
        || uri.path() != "/"
        || uri.scheme() != "https" && !loopback
    {
        return None;
    }
    Some(uri.origin().ascii_serialization())
}

fn enrollment_code(code: &str) -> bool {
    code.len() == 24
        && code.bytes().enumerate().all(|(index, byte)| {
            if index % 5 == 4 {
                byte == b'-'
            } else {
                byte.is_ascii_uppercase() || byte.is_ascii_digit()
            }
        })
}

fn enroll_reason(error: &EnrollError) -> &'static str {
    match error {
        EnrollError::InvalidOrigin => "invalid_origin",
        EnrollError::InvalidCode => "invalid_code",
        EnrollError::MissingName => "missing_name",
        EnrollError::AlreadyEnrolled => "already_enrolled",
        EnrollError::RelayRejected => "relay_rejected",
        EnrollError::RelayUnavailable => "relay_unavailable",
        EnrollError::KeyFailed => "key_failed",
        EnrollError::StoreFailed => "store_failed",
        EnrollError::Partial(_) => "partial_failure",
    }
}

fn accepted(posted: Posted) -> Result<Value, Error> {
    match posted {
        Posted::Accepted(value) => Ok(value),
        Posted::Unauthorized => Err(Error::Revoked),
        Posted::Rejected | Posted::Unavailable => Err(Error::Relay),
    }
}

fn tokens(value: Value) -> Result<Tokens, Error> {
    Ok(Tokens {
        access_token: text(&value, "accessToken").ok_or(Error::Relay)?.to_owned(),
        access_expires_at: safe(value.get("accessExpiresAt")).ok_or(Error::Relay)?,
        refresh_token: text(&value, "refreshToken").ok_or(Error::Relay)?.to_owned(),
        refresh_expires_at: safe(value.get("refreshExpiresAt")).ok_or(Error::Relay)?,
    })
}

fn text<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

fn safe(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= SAFE_INTEGER)
}

fn bounded(value: &str, max: usize) -> bool {
    !value.is_empty() && value.encode_utf16().count() <= max
}

fn read(path: &Path) -> Result<Option<Identity>, Error> {
    use std::io::Read;
    let info = match std::fs::symlink_metadata(path) {
        Ok(info) => info,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(Error::Store),
    };
    if !info.file_type().is_file() || !private(&info) {
        return Err(Error::Store);
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|_| Error::Store)?;
    let opened = file.metadata().map_err(|_| Error::Store)?;
    if !opened.is_file() || !private(&opened) || opened.len() > LIMIT as u64 {
        return Err(Error::Store);
    }
    let mut bytes = Vec::new();
    file.take(LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Store)?;
    decode(&bytes).map(Some).ok_or(Error::Store)
}

async fn write(path: PathBuf, bytes: Vec<u8>, create: bool) -> Result<(), Error> {
    tokio::task::spawn_blocking(move || store(&path, &bytes, create))
        .await
        .map_err(|_| Error::Store)?
}

fn store(path: &Path, bytes: &[u8], create: bool) -> Result<(), Error> {
    use std::io::Write;
    match std::fs::symlink_metadata(path) {
        Ok(info) if create || info.file_type().is_symlink() => return Err(Error::Store),
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(Error::Store),
    }
    std::fs::create_dir_all(path.parent().ok_or(Error::Store)?).map_err(|_| Error::Store)?;
    let mut suffix = [0_u8; 16];
    SystemRandom::new()
        .fill(&mut suffix)
        .map_err(|_| Error::Store)?;
    let mut temp = OsString::from(path.as_os_str());
    temp.push(format!(
        ".{}.tmp",
        suffix
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ));
    let temp = PathBuf::from(temp);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp).map_err(|_| Error::Store)?;
    // Rename replaces the destination entry itself, so a link planted there cannot redirect the write.
    let result = file
        .write_all(bytes)
        .and_then(|()| file.sync_all())
        .and_then(|()| std::fs::rename(&temp, path))
        .map_err(|_| Error::Store);
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(unix)]
fn private(info: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    private_mode(info.mode(), info.uid(), unsafe { libc::getuid() })
}

#[cfg(unix)]
fn private_mode(mode: u32, owner: u32, user: u32) -> bool {
    mode & 0o077 == 0 && owner == user
}

#[cfg(not(unix))]
fn private(_: &std::fs::Metadata) -> bool {
    true
}

fn decode(bytes: &[u8]) -> Option<Identity> {
    let value = serde_json::from_slice::<Value>(bytes).ok()?;
    let optional = |field| value.get(field);
    Some(Identity {
        device_id: text(&value, "deviceID")
            .filter(|value| bounded(value, 128))?
            .to_owned(),
        name: text(&value, "name")
            .filter(|value| bounded(value, 128))?
            .to_owned(),
        relay_origin: normalize_origin(text(&value, "relayURL")?)?,
        public_key: key(value.get("publicKey")?, false)?,
        private_key: key(value.get("privateKey")?, true)?,
        refresh_token: match optional("refreshToken") {
            None => None,
            Some(token) => Some(token.as_str()?.to_owned()),
        },
        refresh_expires_at: match optional("refreshExpiresAt") {
            None => None,
            Some(expires_at) => Some(safe(Some(expires_at))?),
        },
        enrolled_at: safe(value.get("enrolledAt"))?,
    })
}

fn key(value: &Value, private: bool) -> Option<Value> {
    if value.get("kty")?.as_str()? != "EC" || value.get("crv")?.as_str()? != "P-256" {
        return None;
    }
    let mut key = Map::new();
    key.insert("kty".into(), "EC".into());
    key.insert("crv".into(), "P-256".into());
    let fields: &[&str] = if private {
        &["x", "y", "d"]
    } else {
        &["x", "y"]
    };
    for field in fields {
        key.insert((*field).into(), value.get(*field)?.as_str()?.into());
    }
    Some(Value::Object(key))
}

fn encode(identity: &Identity) -> Vec<u8> {
    let mut object = Map::new();
    object.insert("deviceID".into(), identity.device_id.as_str().into());
    object.insert("name".into(), identity.name.as_str().into());
    object.insert("relayURL".into(), identity.relay_origin.as_str().into());
    object.insert("publicKey".into(), identity.public_key.clone());
    object.insert("privateKey".into(), identity.private_key.clone());
    if let Some(token) = &identity.refresh_token {
        object.insert("refreshToken".into(), token.as_str().into());
    }
    if let Some(expires_at) = identity.refresh_expires_at {
        object.insert("refreshExpiresAt".into(), expires_at.into());
    }
    object.insert("enrolledAt".into(), identity.enrolled_at.into());
    Value::Object(object).to_string().into_bytes()
}

fn generate() -> Option<(Value, Value)> {
    let random = SystemRandom::new();
    let document = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &random).ok()?;
    let bytes = document.as_ref();
    let private_end = PKCS8_PREFIX.len() + 32;
    let public_start = private_end + PKCS8_MIDDLE.len();
    if bytes.len() != public_start + 65
        || bytes[..PKCS8_PREFIX.len()] != PKCS8_PREFIX
        || bytes[private_end..public_start] != PKCS8_MIDDLE
    {
        return None;
    }
    let scalar = &bytes[PKCS8_PREFIX.len()..private_end];
    let point = &bytes[public_start..];
    EcdsaKeyPair::from_private_key_and_public_key(
        &ECDSA_P256_SHA256_FIXED_SIGNING,
        scalar,
        point,
        &random,
    )
    .ok()?;
    let x = encode_base64(&point[1..33], true);
    let y = encode_base64(&point[33..], true);
    Some((
        json!({ "kty": "EC", "crv": "P-256", "x": x, "y": y }),
        json!({ "kty": "EC", "crv": "P-256", "x": x, "y": y, "d": encode_base64(scalar, true) }),
    ))
}

fn sign(private_key: &Value, challenge_id: &str, nonce: &str) -> Option<String> {
    let coordinate = |field| {
        decode_base64url(private_key.get(field)?.as_str()?).filter(|bytes| bytes.len() == 32)
    };
    let scalar = coordinate("d")?;
    let mut point = vec![4];
    point.extend(coordinate("x")?);
    point.extend(coordinate("y")?);
    let random = SystemRandom::new();
    let pair = EcdsaKeyPair::from_private_key_and_public_key(
        &ECDSA_P256_SHA256_FIXED_SIGNING,
        &scalar,
        &point,
        &random,
    )
    .ok()?;
    let signature = pair
        .sign(
            &random,
            format!("ycoding-device-v1\n{challenge_id}\n{nonce}").as_bytes(),
        )
        .ok()?;
    Some(encode_base64(signature.as_ref(), true))
}

fn decode_base64url(text: &str) -> Option<Vec<u8>> {
    if text.len() % 4 == 1 {
        return None;
    }
    let mut bytes = Vec::new();
    let mut bits = 0_u32;
    let mut count = 0;
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        };
        bits = (bits << 6 | u32::from(value)) & 0xffff;
        count += 6;
        if count >= 8 {
            count -= 8;
            bytes.push((bits >> count) as u8);
        }
    }
    Some(bytes)
}

#[cfg(unix)]
fn hostname() -> Option<String> {
    let mut buffer = [0_u8; 256];
    if unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } != 0 {
        return None;
    }
    let end = buffer.iter().position(|byte| *byte == 0)?;
    std::str::from_utf8(&buffer[..end])
        .ok()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
}

#[cfg(not(unix))]
fn hostname() -> Option<String> {
    std::env::var("COMPUTERNAME")
        .ok()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
}

#[cfg(all(test, unix))]
mod tests {
    #[test]
    fn private_files_require_owner_only_mode_and_the_current_user() {
        assert!(super::private_mode(0o100600, 501, 501));
        assert!(super::private_mode(0o100400, 501, 501));
        assert!(!super::private_mode(0o100600, 0, 501));
        assert!(!super::private_mode(0o100640, 501, 501));
        assert!(!super::private_mode(0o100604, 501, 501));
    }
}
