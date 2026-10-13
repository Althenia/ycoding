use super::{Client, Error, Status, base64, now, oauth_secret, random_bytes};
use icu_normalizer::ComposingNormalizer;
use ring::digest;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fmt,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::watch,
    task::JoinHandle,
};
use ycoding_store::resources::Secret;

#[derive(Clone, PartialEq)]
pub struct Credentials {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
    pub subscription_type: Option<String>,
}
impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ClaudeCredentials([redacted])")
    }
}
impl Credentials {
    pub fn parse(raw: &str) -> Option<Self> {
        let parsed: Value = serde_json::from_str(raw).ok()?;
        let value = parsed
            .get("claudeAiOauth")
            .filter(|value| value.is_object())
            .unwrap_or(&parsed);
        Some(Self {
            access_token: value
                .get("accessToken")?
                .as_str()
                .filter(|value| !value.trim().is_empty())?
                .into(),
            refresh_token: value.get("refreshToken")?.as_str()?.into(),
            expires_at: value.get("expiresAt")?.as_f64()?.trunc() as i64,
            subscription_type: value
                .get("subscriptionType")
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
    }
    fn fresh(&self, time: i64) -> bool {
        self.expires_at > time.saturating_add(60_000)
    }
    fn replaced(&self, previous: &Self) -> bool {
        self.access_token != previous.access_token || self.refresh_token != previous.refresh_token
    }
}

#[derive(Clone)]
pub struct Account {
    pub label: String,
    pub source: String,
    pub credentials: Credentials,
}
impl fmt::Debug for Account {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ClaudeAccount([redacted])")
    }
}

pub fn profile_directory(root: &Path, source: &str) -> Result<PathBuf, Error> {
    if !root.is_absolute() || !valid_source(source) {
        return Err(Error::Rejected);
    }
    let mut path = PathBuf::new();
    for component in root.components() {
        match component {
            std::path::Component::ParentDir => {
                path.pop();
            }
            std::path::Component::CurDir => {}
            component => path.push(component),
        }
    }
    Ok(path.join(source))
}

pub fn keychain_service(directory: &Path) -> Result<String, Error> {
    if !directory.is_absolute() {
        return Err(Error::Rejected);
    }
    let text = directory.to_str().ok_or(Error::Rejected)?;
    let normalized = ComposingNormalizer::new_nfc().normalize(text);
    let hash = digest::digest(&digest::SHA256, normalized.as_bytes());
    Ok(format!(
        "Claude Code-credentials-{}",
        hash.as_ref()[..4]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn valid_source(source: &str) -> bool {
    source.len() == 36
        && source.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                return byte == b'-';
            }
            if index == 14 {
                return matches!(byte, b'1'..=b'8');
            }
            if index == 19 {
                return matches!(byte.to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b');
            }
            byte.is_ascii_hexdigit()
        })
}

pub fn credential_source(value: &ycoding_schema::credential::Value) -> Option<&str> {
    let ycoding_schema::credential::Value::OAuth(value) = value else {
        return None;
    };
    let metadata = value.metadata.as_ref()?;
    let source = value.access.as_str()?;
    (value.method_id.as_lossless().as_str() == Some("claude-code")
        && metadata.get(&"authKind".into())
            == Some(&ycoding_schema::JsonValue::String("claude-code".into()))
        && metadata.get(&"managed".into()) == Some(&ycoding_schema::JsonValue::Bool(true))
        && metadata.get(&"requiresLogin".into()) != Some(&ycoding_schema::JsonValue::Bool(true))
        && metadata.get(&"source".into())
            == Some(&ycoding_schema::JsonValue::String(value.access.clone()))
        && value.expires.get() == 9_007_199_254_740_991
        && valid_source(source))
    .then_some(source)
}

type KeychainFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, Error>> + Send + 'a>>;
pub trait Keychain: Send + Sync {
    fn read<'a>(&'a self, service: &'a str) -> KeychainFuture<'a, Option<String>>;
    fn write<'a>(&'a self, service: &'a str, raw: &'a str) -> KeychainFuture<'a, bool>;
}
pub struct SystemKeychain;
impl Keychain for SystemKeychain {
    fn read<'a>(&'a self, service: &'a str) -> KeychainFuture<'a, Option<String>> {
        Box::pin(async move {
            let output = security(&["find-generic-password", "-s", service, "-w"], None).await?;
            if output.status.code() == Some(44) {
                return Ok(None);
            }
            if !output.status.success() {
                return Err(Error::Rejected);
            }
            Ok(Some(String::from_utf8_lossy(&output.stdout).trim().into()))
        })
    }
    fn write<'a>(&'a self, service: &'a str, raw: &'a str) -> KeychainFuture<'a, bool> {
        Box::pin(async move {
            let output = security(&["find-generic-password", "-s", service], None).await;
            let Ok(output) = output else {
                return Ok(false);
            };
            let text = String::from_utf8_lossy(&output.stdout);
            let Some(account) = text
                .split("\"acct\"<blob>=\"")
                .nth(1)
                .and_then(|value| value.split('"').next())
                .filter(|value| !value.is_empty())
            else {
                return Ok(false);
            };
            let input = keychain_update(service, account, raw);
            Ok(security(&["-i"], Some(input.as_bytes()))
                .await
                .is_ok_and(|output| output.status.success()))
        })
    }
}
pub fn keychain_update(service: &str, account: &str, value: &str) -> String {
    let quote = |value: &str| format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""));
    format!(
        "add-generic-password -s {} -a {} -U -X {}\n",
        quote(service),
        quote(account),
        value
            .as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}
async fn security(args: &[&str], input: Option<&[u8]>) -> Result<std::process::Output, Error> {
    let mut child = tokio::process::Command::new("/usr/bin/security")
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| Error::Rejected)?;
    if let Some(input) = input {
        child
            .stdin
            .take()
            .ok_or(Error::Rejected)?
            .write_all(input)
            .await
            .map_err(|_| Error::Rejected)?;
    }
    tokio::time::timeout(Duration::from_secs(2), child.wait_with_output())
        .await
        .map_err(|_| Error::Rejected)?
        .map_err(|_| Error::Rejected)
}

#[derive(Clone)]
pub struct Source {
    root: PathBuf,
    keychain: Option<Arc<dyn Keychain>>,
}
impl fmt::Debug for Source {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ClaudeSource([redacted])")
    }
}
impl Source {
    pub fn new(root: PathBuf, keychain: Option<Arc<dyn Keychain>>) -> Result<Self, Error> {
        if !root.is_absolute() {
            return Err(Error::Rejected);
        }
        Ok(Self { root, keychain })
    }
    pub fn system(root: PathBuf) -> Result<Self, Error> {
        Self::new(
            root,
            if cfg!(target_os = "macos") {
                Some(Arc::new(SystemKeychain))
            } else {
                None
            },
        )
    }
    async fn raw(&self, source: &str) -> Result<Option<String>, Error> {
        let directory = profile_directory(&self.root, source)?;
        if !entry(&directory, true).await? {
            return Ok(None);
        }
        if let Some(keychain) = &self.keychain {
            let raw = keychain.read(&keychain_service(&directory)?).await?;
            if raw.is_some() {
                return Ok(raw);
            }
        }
        let file = directory.join(".credentials.json");
        if !entry(&file, false).await? {
            return Ok(None);
        }
        let mut options = tokio::fs::OpenOptions::new();
        options.read(true);
        no_follow(&mut options);
        let mut file = options.open(file).await.map_err(|_| Error::Rejected)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .await
            .map_err(|_| Error::Rejected)?;
        Ok(Some(String::from_utf8_lossy(&bytes).into()))
    }
    pub async fn read(&self, source: &str) -> Result<Option<Credentials>, Error> {
        if !valid_source(source) {
            return Ok(None);
        }
        Ok(self
            .raw(source)
            .await?
            .as_deref()
            .and_then(Credentials::parse))
    }
    pub async fn write(&self, source: &str, credentials: &Credentials) -> Result<bool, Error> {
        if !valid_source(source) {
            return Ok(false);
        }
        let Some(raw) = self.raw(source).await? else {
            return Ok(false);
        };
        if Credentials::parse(&raw).is_none() {
            return Ok(false);
        }
        let mut parsed: Value = serde_json::from_str(&raw).map_err(|_| Error::Rejected)?;
        let target = if parsed.get("claudeAiOauth").is_some_and(Value::is_object) {
            parsed.get_mut("claudeAiOauth").ok_or(Error::Rejected)?
        } else {
            &mut parsed
        };
        target["accessToken"] = credentials.access_token.clone().into();
        target["refreshToken"] = credentials.refresh_token.clone().into();
        target["expiresAt"] = credentials.expires_at.into();
        let directory = profile_directory(&self.root, source)?;
        if let Some(keychain) = &self.keychain {
            let service = keychain_service(&directory)?;
            if keychain.read(&service).await?.is_some() {
                return keychain.write(&service, &parsed.to_string()).await;
            }
        }
        let file = directory.join(".credentials.json");
        if !entry(&file, false).await? {
            return Ok(false);
        }
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true);
        no_follow(&mut options);
        let Ok(mut file) = options.open(file).await else {
            return Ok(false);
        };
        if file.set_len(0).await.is_err()
            || file.write_all(parsed.to_string().as_bytes()).await.is_err()
        {
            return Ok(false);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if file
                .set_permissions(std::fs::Permissions::from_mode(0o600))
                .await
                .is_err()
            {
                return Ok(false);
            }
        }
        Ok(true)
    }
    pub async fn list(&self) -> Result<Vec<Account>, Error> {
        let mut entries = match tokio::fs::read_dir(&self.root).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(_) => return Err(Error::Rejected),
        };
        let mut found = Vec::new();
        while let Some(entry) = entries.next_entry().await.map_err(|_| Error::Rejected)? {
            let Some(source) = entry
                .file_name()
                .to_str()
                .map(str::to_owned)
                .filter(|source| valid_source(source))
            else {
                continue;
            };
            if let Some(credentials) = self.read(&source).await? {
                found.push((source, credentials));
            }
        }
        found.sort_by(|a, b| a.0.cmp(&b.0));
        let labels: Vec<_> = found
            .iter()
            .map(|(_, credentials)| {
                credentials
                    .subscription_type
                    .as_ref()
                    .filter(|value| !value.is_empty())
                    .map_or_else(
                        || "Claude".into(),
                        |kind| {
                            let mut chars = kind.chars();
                            format!(
                                "Claude {}{}",
                                chars
                                    .next()
                                    .map(|value| value.to_uppercase().collect::<String>())
                                    .unwrap_or_default(),
                                chars.as_str()
                            )
                        },
                    )
            })
            .collect();
        let mut seen = BTreeMap::new();
        Ok(found
            .into_iter()
            .enumerate()
            .map(|(index, (source, credentials))| {
                let base = &labels[index];
                let count = seen.entry(base.clone()).or_insert(0);
                *count += 1;
                Account {
                    label: if labels.iter().filter(|value| *value == base).count() > 1 {
                        format!("{base} {count}")
                    } else {
                        base.clone()
                    },
                    source,
                    credentials,
                }
            })
            .collect())
    }
}
async fn entry(path: &Path, directory: bool) -> Result<bool, Error> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(info) => Ok(!info.is_symlink()
            && if directory {
                info.is_dir()
            } else {
                info.is_file()
            }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(Error::Rejected),
    }
}
fn no_follow(options: &mut tokio::fs::OpenOptions) {
    #[cfg(target_os = "macos")]
    options.custom_flags(0x100);
    #[cfg(target_os = "linux")]
    options.custom_flags(0x20000);
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let _ = options;
}

type Resolution = Result<Option<Credentials>, Error>;
struct State {
    closed: bool,
    cache: BTreeMap<String, (Credentials, i64)>,
    pending: BTreeMap<String, watch::Receiver<Option<Resolution>>>,
    tasks: Vec<JoinHandle<()>>,
}
struct Inner {
    source: Source,
    client: Client,
    state: Mutex<State>,
}
#[derive(Clone)]
pub struct Store(Arc<Inner>);
impl Store {
    pub fn new(source: Source, client: Client) -> Self {
        Self(Arc::new(Inner {
            source,
            client,
            state: Mutex::new(State {
                closed: false,
                cache: BTreeMap::new(),
                pending: BTreeMap::new(),
                tasks: Vec::new(),
            }),
        }))
    }
    pub async fn accounts(&self, time: i64) -> Result<Vec<Account>, Error> {
        let accounts = self.0.source.list().await?;
        let mut state = self.0.state.lock().map_err(|_| Error::Closed)?;
        state
            .cache
            .retain(|source, _| accounts.iter().any(|account| &account.source == source));
        for account in &accounts {
            if account.credentials.fresh(time) {
                state
                    .cache
                    .insert(account.source.clone(), (account.credentials.clone(), time));
            }
        }
        Ok(accounts)
    }
    pub async fn reload(&self, source: &str, time: i64) -> Resolution {
        let value = self
            .0
            .source
            .read(source)
            .await
            .ok()
            .flatten()
            .filter(|value| value.fresh(time));
        let mut state = self.0.state.lock().map_err(|_| Error::Closed)?;
        state.cache.remove(source);
        if let Some(value) = &value {
            state.cache.insert(source.into(), (value.clone(), time));
        }
        Ok(value)
    }
    pub async fn resolve(&self, source: &str, time: i64, force_refresh: bool) -> Resolution {
        let finished = self
            .0
            .state
            .lock()
            .map_err(|_| Error::Closed)?
            .tasks
            .extract_if(.., |task| task.is_finished())
            .collect();
        super::join_finished(finished).await?;
        let cached = self
            .0
            .state
            .lock()
            .map_err(|_| Error::Closed)?
            .cache
            .get(source)
            .cloned();
        if !force_refresh
            && let Some((credentials, cached_at)) = &cached
            && time - cached_at < 30_000
            && credentials.fresh(time)
        {
            return Ok(Some(credentials.clone()));
        }
        let current = match self.0.source.read(source).await {
            Ok(value) => value,
            Err(_) => cached.map(|(value, _)| value),
        };
        let Some(current) = current else {
            self.0
                .state
                .lock()
                .map_err(|_| Error::Closed)?
                .cache
                .remove(source);
            return Ok(None);
        };
        if !force_refresh && current.fresh(time) {
            self.0
                .state
                .lock()
                .map_err(|_| Error::Closed)?
                .cache
                .insert(source.into(), (current.clone(), time));
            return Ok(Some(current));
        }
        let key = base64(
            digest::digest(
                &digest::SHA256,
                serde_json::json!([
                    self.0.source.root,
                    source,
                    current.access_token,
                    current.refresh_token
                ])
                .to_string()
                .as_bytes(),
            )
            .as_ref(),
        );
        let mut receiver = {
            let mut state = self.0.state.lock().map_err(|_| Error::Closed)?;
            if state.closed {
                return Err(Error::Closed);
            }
            if let Some(receiver) = state.pending.get(&key) {
                receiver.clone()
            } else {
                let (sender, receiver) = watch::channel(None);
                state.pending.insert(key.clone(), receiver.clone());
                let store = self.clone();
                let source = source.to_owned();
                state.tasks.push(tokio::spawn(async move {
                    let result = store.refresh_current(&source, current, time).await;
                    if let Ok(Some(value)) = &result
                        && let Ok(mut state) = store.0.state.lock()
                    {
                        state.cache.insert(source.clone(), (value.clone(), time));
                    }
                    sender.send_replace(Some(result.clone()));
                    if result != Err(Error::UnknownOutcome)
                        && let Ok(mut state) = store.0.state.lock()
                    {
                        state.pending.remove(&key);
                    }
                }));
                receiver
            }
        };
        loop {
            if let Some(result) = receiver.borrow_and_update().clone() {
                return result;
            }
            receiver
                .changed()
                .await
                .map_err(|_| Error::UnknownOutcome)?;
        }
    }
    async fn refresh_current(&self, source: &str, current: Credentials, time: i64) -> Resolution {
        let Some(before) = self.0.source.read(source).await? else {
            return Ok(None);
        };
        if before.replaced(&current) {
            return Ok(before.fresh(time).then_some(before));
        }
        let refreshed = if current.refresh_token.is_empty() {
            Ok(None)
        } else {
            self.exchange(&current, time).await
        };
        let latest = self.0.source.read(source).await?;
        let Some(latest) = latest else {
            return Ok(None);
        };
        if latest.replaced(&current) {
            return Ok(latest.fresh(time).then_some(latest));
        }
        let Some(refreshed) = refreshed? else {
            return Ok(None);
        };
        if !refreshed.fresh(time) {
            return Ok(None);
        }
        self.0.source.write(source, &refreshed).await?;
        Ok(Some(refreshed))
    }
    async fn exchange(&self, current: &Credentials, time: i64) -> Resolution {
        let (status, tokens) = self
            .0
            .client
            .send(self.0.client.form(
                "/v1/oauth/token",
                &[
                    ("grant_type", "refresh_token"),
                    ("client_id", "9d1c250a-e61b-44d9-88ed-5944d1962f5e"),
                    ("refresh_token", &current.refresh_token),
                ],
            ))
            .await?;
        if !status.is_success() {
            return Ok(None);
        }
        let access = tokens
            .get("access_token")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or(Error::UnknownOutcome)?;
        Ok(Some(Credentials {
            access_token: access.into(),
            refresh_token: tokens
                .get("refresh_token")
                .and_then(Value::as_str)
                .unwrap_or(&current.refresh_token)
                .into(),
            expires_at: time.saturating_add(
                (tokens
                    .get("expires_in")
                    .and_then(Value::as_f64)
                    .unwrap_or(36_000.0)
                    * 1000.0)
                    .trunc() as i64,
            ),
            subscription_type: current.subscription_type.clone(),
        }))
    }
    pub async fn shutdown(&self) -> Result<(), Error> {
        let tasks = {
            let mut state = self.0.state.lock().map_err(|_| Error::Closed)?;
            state.closed = true;
            std::mem::take(&mut state.tasks)
        };
        for task in &tasks {
            task.abort();
        }
        for task in tasks {
            if task.await.is_err_and(|error| !error.is_cancelled()) {
                return Err(Error::UnknownOutcome);
            }
        }
        Ok(())
    }
}

pub fn managed_secret(source: &str) -> Result<Secret, Error> {
    if !valid_source(source) {
        return Err(Error::Rejected);
    }
    let mut metadata = ycoding_schema::JsonObject::new();
    metadata.insert(
        "authKind".into(),
        ycoding_schema::JsonValue::String("claude-code".into()),
    );
    metadata.insert(
        "source".into(),
        ycoding_schema::JsonValue::String(source.into()),
    );
    metadata.insert("managed".into(), ycoding_schema::JsonValue::Bool(true));
    oauth_secret(
        "claude-code",
        source,
        "",
        9_007_199_254_740_991,
        Some(metadata),
    )
}

pub struct Enrollment {
    pub source: String,
    pub url: String,
    submission: Submission,
    receiver: watch::Receiver<Option<Result<Credentials, Error>>>,
    task: Option<JoinHandle<()>>,
    status: Status,
}
#[derive(Clone)]
pub struct Submission {
    stdin: Arc<tokio::sync::Mutex<Option<tokio::process::ChildStdin>>>,
    submitted: Arc<AtomicBool>,
    receiver: watch::Receiver<Option<Result<Credentials, Error>>>,
}
impl Submission {
    pub async fn submit(&self, code: &str) -> Result<(), Error> {
        if self.receiver.borrow().is_some()
            || code.is_empty()
            || code.encode_utf16().count() > 2048
            || code
                .chars()
                .any(|value| value.is_whitespace() || value == '\0')
        {
            return Err(Error::Rejected);
        }
        if self
            .submitted
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(Error::Rejected);
        }
        let mut stdin = self.stdin.lock().await;
        let stdin = stdin.as_mut().ok_or(Error::Rejected)?;
        stdin
            .write_all(format!("{code}\n").as_bytes())
            .await
            .map_err(|_| Error::Rejected)?;
        stdin.flush().await.map_err(|_| Error::Rejected)?;
        Ok(())
    }
}
impl fmt::Debug for Enrollment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ClaudeEnrollment([redacted])")
    }
}
impl Enrollment {
    pub async fn start(
        source: Source,
        command: &[String],
        env: &BTreeMap<String, String>,
    ) -> Result<Self, Error> {
        let mut bytes = random_bytes(16)?;
        bytes[6] = bytes[6] & 15 | 64;
        bytes[8] = bytes[8] & 63 | 128;
        let id = bytes
            .iter()
            .enumerate()
            .map(|(index, byte)| {
                format!(
                    "{}{byte:02x}",
                    if matches!(index, 4 | 6 | 8 | 10) {
                        "-"
                    } else {
                        ""
                    }
                )
            })
            .collect::<String>();
        let directory = profile_directory(&source.root, &id)?;
        tokio::fs::create_dir_all(&source.root)
            .await
            .map_err(|_| Error::Rejected)?;
        tokio::fs::create_dir(&directory)
            .await
            .map_err(|_| Error::Rejected)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for path in [&source.root, &directory] {
                tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
                    .await
                    .map_err(|_| Error::Rejected)?;
            }
        }
        let mut child =
            tokio::process::Command::new(command.first().map_or("claude", String::as_str))
                .args(command.iter().skip(1))
                .args(["auth", "login", "--claudeai"])
                .current_dir(&directory)
                .env_clear()
                .envs(env.iter().filter(|(key, _)| !blocked_env(key)))
                .env("CLAUDE_CONFIG_DIR", &directory)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .map_err(|_| Error::Rejected)?;
        let stdin = child.stdin.take();
        let mut stdout = child.stdout.take().ok_or(Error::Rejected)?;
        let (url_sender, mut url_receiver) = watch::channel(None);
        let (sender, receiver) = watch::channel(None);
        let selected = id.clone();
        let task = tokio::spawn(async move {
            let result = tokio::time::timeout(Duration::from_secs(120), async {
                let output = async {
                    let mut text = Vec::new();
                    let mut found = false;
                    loop {
                        let mut bytes = [0; 2048];
                        let count = stdout.read(&mut bytes).await.map_err(|_| Error::Rejected)?;
                        if count == 0 { break; }
                        text.extend_from_slice(&bytes[..count]);
                        if String::from_utf8_lossy(&text).encode_utf16().count() > 16_384 { return Err(Error::Rejected); }
                        if !found && let Some(url) = authorization_url(&String::from_utf8_lossy(&text)) { url_sender.send_replace(Some(url)); found = true; }
                    }
                    Ok::<_, Error>(())
                };
                tokio::pin!(output);
                let exit = tokio::select! {
                    result = &mut output => {
                        if result.is_err() { let _ = child.kill().await; return Err(Error::Rejected); }
                        child.wait().await
                    }
                    exit = child.wait() => { output.await?; exit }
                };
                if !exit.map_err(|_| Error::Rejected)?.success() { return Err(Error::Rejected); }
                source.read(&selected).await?.filter(|credentials| credentials.expires_at > now().unwrap_or(i64::MAX)).ok_or(Error::Rejected)
            }).await;
            if result.is_err() {
                let _ = child.kill().await;
            }
            let result = result.unwrap_or(Err(Error::Rejected));
            sender.send_replace(Some(result));
        });
        let submission = Submission {
            stdin: Arc::new(tokio::sync::Mutex::new(stdin)),
            submitted: Arc::new(AtomicBool::new(false)),
            receiver: receiver.clone(),
        };
        let mut attempt = Self {
            source: id,
            url: String::new(),
            submission,
            receiver,
            task: Some(task),
            status: Status::Pending,
        };
        loop {
            let url = url_receiver.borrow_and_update().clone();
            if let Some(url) = url {
                attempt.url = url;
                return Ok(attempt);
            }
            if url_receiver.changed().await.is_err() {
                if let Some(task) = attempt.task.take() {
                    task.await.map_err(|_| Error::Rejected)?;
                }
                return Err(Error::Rejected);
            }
        }
    }
    pub async fn submit_code(&mut self, code: &str) -> Result<(), Error> {
        if self.status != Status::Pending {
            return Err(Error::Rejected);
        }
        self.submission.submit(code).await
    }
    pub async fn wait(&mut self) -> Result<Credentials, Error> {
        loop {
            let result = self.receiver.borrow_and_update().clone();
            if let Some(result) = result {
                if let Some(task) = self.task.take() {
                    task.await.map_err(|_| Error::Rejected)?;
                }
                self.status = if result.is_ok() {
                    Status::Complete
                } else {
                    Status::Failed
                };
                return result;
            }
            self.receiver.changed().await.map_err(|_| Error::Rejected)?;
        }
    }
    pub async fn cancel(&mut self) -> Result<(), Error> {
        if let Some(task) = self.task.take() {
            task.abort();
            if task.await.is_err_and(|error| !error.is_cancelled()) {
                return Err(Error::Rejected);
            }
        }
        self.submission.stdin.lock().await.take();
        self.status = Status::Cancelled;
        Ok(())
    }
    pub fn status(&self) -> Status {
        self.status
    }
    pub fn submission(&self) -> Submission {
        self.submission.clone()
    }
    pub fn instructions(&self) -> &'static str {
        "Complete authorization in your browser. If prompted by Claude Code, paste the authorization code here."
    }
}
impl Drop for Enrollment {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}
fn blocked_env(key: &str) -> bool {
    [
        "ANTHROPIC_",
        "CLAUDE_CODE_",
        "AWS_",
        "GOOGLE_",
        "AZURE_",
        "CLAUDE_PROFILE",
        "CLAUDE_AUTH",
        "CLAUDE_BEDROCK",
        "CLAUDE_VERTEX",
        "CLAUDE_FOUNDRY",
    ]
    .iter()
    .any(|prefix| key.starts_with(prefix))
        || key == "CLAUDE_SECURESTORAGE_CONFIG_DIR"
}
fn authorization_url(text: &str) -> Option<String> {
    let suffix = text
        .split("If the browser didn't open, visit:")
        .nth(1)?
        .trim_start();
    let suffix = suffix.strip_prefix("\u{1b}]8;;").unwrap_or(suffix);
    let end =
        suffix.find(|value: char| value.is_whitespace() || matches!(value, '\u{7}' | '\u{1b}'))?;
    let url = url::Url::parse(&suffix[..end]).ok()?;
    (url.scheme() == "https"
        && url.host_str() == Some("claude.com")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none())
    .then(|| url.into())
}

impl Store {
    pub fn implementation(
        &self,
        command: Vec<String>,
        env: BTreeMap<String, String>,
    ) -> super::integration::OAuthImplementation {
        let source = self.0.source.clone();
        super::integration::OAuthImplementation {
            integration: "anthropic".into(),
            method: ycoding_schema::integration::OAuthMethod {
                id: ycoding_schema::integration_id::IntegrationMethodId::new("claude-code")
                    .expect("method"),
                label: "Claude Code account".into(),
                prompts: None,
                remote: Some(true),
            },
            authorize: Arc::new(move |_| {
                let source = source.clone();
                let command = command.clone();
                let env = env.clone();
                Box::pin(async move {
                    let mut attempt = Enrollment::start(source, &command, &env).await?;
                    let submit = attempt.submission();
                    let url = attempt.url.clone();
                    let instructions = attempt.instructions().into();
                    Ok(super::integration::Authorization::automatic(
                        url,
                        instructions,
                        Box::pin(async move {
                            attempt.wait().await?;
                            managed_secret(&attempt.source)
                        }),
                        Some(Arc::new(move |code| {
                            let submit = submit.clone();
                            Box::pin(async move { submit.submit(&code).await })
                        })),
                        None,
                    ))
                })
            }),
            refresh: Some(Arc::new(|_| {
                Box::pin(async { Err(Error::ProfileUnavailable) })
            })),
            label: None,
        }
    }
}
