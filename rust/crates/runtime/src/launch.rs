use crate::LocalAuth;
use crate::server;
use crate::services::{Identity, Services};
use std::collections::BTreeMap;
use std::fmt;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use ycoding_core::resources::{catalog::models_dev, config};
use ycoding_core::ycoding_schema::{
    JsonObject, JsonValue, LosslessString, parse_json, stringify_json,
};
use ycoding_core::ycoding_store::{Metadata, Options, Store, import};
use ycoding_protocol::connection::Budgets;

pub const BETA_NAMESPACE: &str = "ycoding-beta";

pub fn namespace(channel: &str) -> &'static str {
    if channel == "beta" {
        BETA_NAMESPACE
    } else {
        "ycoding"
    }
}

pub const EXIT_OK: u8 = 0;
pub const EXIT_FAILURE: u8 = 1;
pub const EXIT_USAGE: u8 = 2;

pub const USAGE: &str = "\
Usage: ycoding-runtime [serve] [--hostname <host>] [--port <port>] [--service | --stdio] [--cors <origin>]

Options:
  --hostname <host>  Bind hostname or IP address (default 127.0.0.1)
  --port <port>      Bind port, 0-65535; 0 selects an ephemeral port
  --service          Run as the managed background service
  --stdio            Print one JSON readiness line and stop when stdin closes
  --cors <origin>    Allow one additional WebSocket origin (repeatable)
  --paths           Print resolved global paths as JSON without starting
  -h, --help         Print this help
  -V, --version      Print the runtime version
";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mode {
    Default,
    Service,
    Stdio,
}

#[derive(Clone, Debug)]
pub struct LaunchConfig {
    pub mode: Mode,
    pub hostname: String,
    pub port: Option<u16>,
    pub cors: Vec<String>,
    pub password: String,
    pub password_generated: bool,
    pub version: String,
    pub channel: String,
    pub config_dir: PathBuf,
    pub state_dir: PathBuf,
    pub roots: config::Roots,
    pub stable_data: PathBuf,
    pub environment: BTreeMap<String, String>,
    pub startup_error_file: Option<PathBuf>,
}

#[derive(Debug)]
pub enum LaunchError {
    Usage(String),
    Message(String),
    Io(io::Error),
}

impl fmt::Display for LaunchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Usage(message) | Self::Message(message) => formatter.write_str(message),
            Self::Io(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for LaunchError {}

impl From<io::Error> for LaunchError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Debug)]
pub enum Parsed {
    Run(Box<LaunchConfig>),
    Help,
    Version(String),
    Paths(String),
}

pub fn parse_launch(
    args: &[String],
    env: impl Fn(&str) -> Option<String>,
) -> Result<Parsed, LaunchError> {
    let mut position = usize::from(args.first().is_some_and(|arg| arg == "serve"));
    let mut hostname = None::<String>;
    let mut port = None::<u16>;
    let mut cors = Vec::new();
    let mut service = false;
    let mut stdio = false;
    let mut paths = false;
    while position < args.len() {
        let arg = &args[position];
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => (flag, Some(value.to_string())),
            _ => (arg.as_str(), None),
        };
        let take = |position: &mut usize| -> Result<String, LaunchError> {
            if let Some(value) = &inline {
                return Ok(value.clone());
            }
            *position += 1;
            args.get(*position)
                .filter(|value| !value.starts_with("--"))
                .cloned()
                .ok_or_else(|| LaunchError::Usage(format!("{flag} requires a value")))
        };
        if inline.is_some()
            && matches!(
                flag,
                "--service" | "--stdio" | "--paths" | "--help" | "--version"
            )
        {
            return Err(LaunchError::Usage(format!(
                "{flag} does not accept a value"
            )));
        }
        match flag {
            "-h" | "--help" => return Ok(Parsed::Help),
            "-V" | "--version" => {
                return Ok(Parsed::Version(
                    env("YCODING_VERSION")
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string()),
                ));
            }
            "--hostname" => hostname = Some(take(&mut position)?),
            "--port" => {
                let value = take(&mut position)?;
                port = Some(value.parse::<u16>().map_err(|_| {
                    LaunchError::Usage(format!("Port must be between 0 and 65535, got {value}"))
                })?);
            }
            "--cors" => cors.push(take(&mut position)?),
            "--service" => service = true,
            "--stdio" => stdio = true,
            "--paths" => paths = true,
            _ => return Err(LaunchError::Usage(format!("Unknown argument: {arg}"))),
        }
        position += 1;
    }
    if service && stdio {
        return Err(LaunchError::Usage(
            "--service and --stdio cannot be combined".into(),
        ));
    }
    let mode = if service {
        Mode::Service
    } else if stdio {
        Mode::Stdio
    } else {
        Mode::Default
    };
    let version = env("YCODING_VERSION")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    let channel = env("YCODING_CHANNEL")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "local".to_string());
    let home = env("HOME")
        .or_else(|| env("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| LaunchError::Message("cannot resolve the home directory".into()))?;
    let environment = [
        "XDG_CONFIG_HOME",
        "XDG_STATE_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "YCODING_CONFIG_DIR",
        "YCODING_CONFIG",
        "YCODING_CONFIG_CONTENT",
        "YCODING_CONFIG_PROJECT_DISABLE",
        "YCODING_DISABLE_PROJECT_CONFIG",
        "YCODING_MODELS_URL",
        "YCODING_MODELS_PATH",
        "YCODING_DISABLE_MODELS_FETCH",
        "YCODING_TEST_HOME",
    ]
    .into_iter()
    .filter_map(|key| {
        env(key)
            .filter(|v| !v.is_empty())
            .map(|v| (key.to_string(), v))
    })
    .collect::<BTreeMap<_, _>>();
    let temp = env("TMPDIR")
        .or_else(|| env("TEMP"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let mut roots = config::Roots::runtime(&home, &temp, &environment).map_err(message)?;
    let stable_data = roots.data.clone();
    if channel == "beta" {
        roots.data.set_file_name(BETA_NAMESPACE);
        roots.cache.set_file_name(BETA_NAMESPACE);
        if !environment.contains_key("YCODING_CONFIG_DIR") {
            roots.config.set_file_name(BETA_NAMESPACE);
        }
        roots.state.set_file_name(BETA_NAMESPACE);
        roots.tmp.set_file_name(BETA_NAMESPACE);
        roots.log = roots.data.join("log");
        roots.repos = roots.data.join("repos");
        roots.bin = roots.cache.join("bin");
    }
    let config_dir = roots.config.clone();
    let state_dir = roots.state.clone();
    if paths {
        let mut object = JsonObject::new();
        for (key, path) in [
            ("config", &roots.config),
            ("state", &roots.state),
            ("data", &roots.data),
            ("cache", &roots.cache),
        ] {
            object.insert(
                key.into(),
                JsonValue::String(path.to_string_lossy().as_ref().into()),
            );
        }
        object.insert(
            "namespace".into(),
            JsonValue::String(namespace(&channel).into()),
        );
        object.insert(
            "serviceFilename".into(),
            JsonValue::String(service_filename(&channel).into()),
        );
        return Ok(Parsed::Paths(stringify_json(&JsonValue::Object(object))));
    }

    let service_config = if mode == Mode::Service {
        read_service_config(&config_dir.join(service_filename(&channel)))
    } else {
        None
    };
    if hostname.is_none() {
        hostname = service_config
            .as_ref()
            .and_then(|value| json_string(value, "hostname"));
    }
    if port.is_none() {
        port = service_config
            .as_ref()
            .and_then(|value| json_u16(value, "port"));
    }
    if mode == Mode::Service && port.is_none() {
        port = Some(default_service_port(&channel));
    }
    let configured_password = if mode == Mode::Service {
        service_config
            .as_ref()
            .and_then(|value| json_string(value, "password"))
            .filter(|value| !value.is_empty())
    } else {
        env("YCODING_PASSWORD")
            .filter(|value| !value.is_empty())
            .or_else(|| env("YCODING_SERVER_PASSWORD").filter(|value| !value.is_empty()))
    };
    let password_generated = configured_password.is_none();
    let password = match configured_password {
        Some(password) if !password.is_empty() => password,
        _ => random_password()?,
    };
    Ok(Parsed::Run(Box::new(LaunchConfig {
        mode,
        hostname: hostname.unwrap_or_else(|| "127.0.0.1".to_string()),
        port,
        cors,
        password,
        password_generated,
        version,
        channel,
        config_dir,
        state_dir,
        roots,
        stable_data,
        environment,
        startup_error_file: env("YCODING_SERVICE_STARTUP_ERROR_FILE")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from),
    })))
}

pub async fn build_production_services(
    config: &LaunchConfig,
    store: &Store,
) -> Result<Services, LaunchError> {
    let core = crate::Core::production(
        store.client(),
        crate::Production {
            configuration: config::LoadOptions {
                directory: if config.mode == Mode::Service {
                    config.roots.home.clone()
                } else {
                    std::env::current_dir()?
                },
                roots: config.roots.clone(),
                project: !truthy(
                    config
                        .environment
                        .get("YCODING_CONFIG_PROJECT_DISABLE")
                        .or_else(|| config.environment.get("YCODING_DISABLE_PROJECT_CONFIG")),
                ),
                file: config.environment.get("YCODING_CONFIG").map(PathBuf::from),
                content: config.environment.get("YCODING_CONFIG_CONTENT").cloned(),
                env: std::env::vars()
                    .filter(|(key, _)| {
                        key != "YCODING_PASSWORD" && key != "YCODING_SERVER_PASSWORD"
                    })
                    .collect(),
            },
            catalog: models_dev::Options {
                source: config
                    .environment
                    .get("YCODING_MODELS_URL")
                    .cloned()
                    .unwrap_or_else(|| "https://models.dev/api.json".into()),
                cache: config.roots.cache.join("models.json"),
                file: config
                    .environment
                    .get("YCODING_MODELS_PATH")
                    .map(PathBuf::from),
                bundled: None,
                fetch: !truthy(config.environment.get("YCODING_DISABLE_MODELS_FETCH")),
                user_agent: format!("ycoding/{}", config.version),
            },
            cursor: None,
            steer: None,
            ripgrep: "rg".into(),
        },
    )
    .await
    .map_err(|_| LaunchError::Message("production composition failed".into()))?;
    Ok(Services {
        identity: Identity {
            version: config.version.clone(),
            pid: u64::from(std::process::id()),
            source_epoch: source_epoch()?,
        },
        auth: LocalAuth::with_password(config.password.clone()),
        cors: config.cors.clone(),
        budgets: Budgets::default(),
        core: Some(core),
    })
}

pub fn health_json(identity: &Identity) -> String {
    let mut object = JsonObject::new();
    object.insert(LosslessString::from("healthy"), JsonValue::Bool(true));
    object.insert(
        LosslessString::from("version"),
        JsonValue::String(LosslessString::from(identity.version.as_str())),
    );
    object.insert(
        LosslessString::from("pid"),
        JsonValue::Number(identity.pid as f64),
    );
    object.insert(
        LosslessString::from("sourceEpoch"),
        JsonValue::String(LosslessString::from(identity.source_epoch.as_str())),
    );
    stringify_json(&JsonValue::Object(object))
}

pub fn service_filename(channel: &str) -> String {
    match channel {
        "latest" => "service.json".to_string(),
        "local" => "service-local.json".to_string(),
        _ => format!("service-{}.json", sha1_hex(channel.as_bytes())),
    }
}

pub fn default_service_port(channel: &str) -> u16 {
    let digest = sha1(format!("ycoding:{channel}").as_bytes());
    let first = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    (10_000 + first % 50_000) as u16
}

pub fn record_startup_error(config: &LaunchConfig, error: &LaunchError) {
    if config.mode != Mode::Service {
        return;
    }
    if let Some(file) = &config.startup_error_file {
        let _ = write_private(file, error.to_string().as_bytes());
    }
}

pub async fn run(config: LaunchConfig) -> Result<(), LaunchError> {
    config.roots.initialize().map_err(message)?;
    let lease = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(config.roots.data.join("runtime.lock"))?;
    match lease.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) if config.mode == Mode::Service => return Ok(()),
        Err(error) => return Err(message(error)),
    }
    let _diagnostics =
        ycoding_core::observability::install(ycoding_core::observability::Options::new(
            &config.roots,
            &config.version,
            &config.channel,
            config.channel == "local",
        ))
        .map_err(message)?;
    let store = open_store(&config)?;
    let services = build_production_services(&config, &store).await?;
    let core = services.core.clone();
    let identity = services.identity.clone();
    let listener = match bind(&config).await {
        Ok(listener) => listener,
        Err(error) => {
            if config.mode == Mode::Service
                && error.kind() == io::ErrorKind::AddrInUse
                && incumbent(&config).await
            {
                return Ok(());
            }
            if config.mode == Mode::Service
                && config.port.is_some_and(|port| port != 0)
                && error.kind() == io::ErrorKind::AddrInUse
            {
                return Err(LaunchError::Message(format!(
                    "Managed service port {} on {} is already in use by another process. Set `port` in {} under the YCoding config directory, or start with `--standalone`.",
                    config.port.unwrap_or_default(),
                    config.hostname,
                    service_filename(&config.channel),
                )));
            }
            return Err(error.into());
        }
    };
    let stop = Arc::new(Notify::new());
    let control =
        crate::health::Control::install(config.mode == Mode::Service, &identity, stop.clone())?;
    let server = server::serve(listener, services).await?;
    let address = server.address();
    let url = format!("http://{address}");

    let registration = if config.mode == Mode::Service {
        if config.password_generated {
            persist_service_password(&config)?;
        }
        let registered = Registration::write(&config, &identity, &url)?;
        Some(registered)
    } else {
        None
    };

    match config.mode {
        Mode::Stdio => println!("{{\"url\":\"{url}\"}}"),
        Mode::Default | Mode::Service => {
            println!("server listening on {url}");
            if config.mode == Mode::Default && config.password_generated {
                println!("server password {}", config.password);
            }
        }
    }
    use std::io::Write as _;
    let _ = std::io::stdout().flush();

    let watcher = registration
        .as_ref()
        .map(|registration| spawn_registration_watch(registration.clone(), stop.clone()));
    wait_for_shutdown(config.mode, stop).await;
    if let Some(watcher) = watcher {
        watcher.abort();
        let _ = watcher.await;
    }
    drop(control);
    let result = server.shutdown().await.map_err(LaunchError::from);
    let core_result = match core {
        Some(core) => core
            .shutdown()
            .await
            .map_err(|_| LaunchError::Message("production shutdown failed".into())),
        None => Ok(()),
    };
    if let Some(registration) = &registration {
        registration.remove_if_owned();
    }
    let store_result = store.shutdown().map_err(message);
    result.and(core_result).and(store_result)
}

async fn bind(config: &LaunchConfig) -> io::Result<TcpListener> {
    match config.port {
        Some(port) => TcpListener::bind((config.hostname.as_str(), port)).await,
        None => {
            let mut port = 4096u16;
            loop {
                match TcpListener::bind((config.hostname.as_str(), port)).await {
                    Ok(listener) => return Ok(listener),
                    Err(error) if error.kind() == io::ErrorKind::AddrInUse && port < u16::MAX => {
                        port += 1;
                    }
                    Err(error) => return Err(error),
                }
            }
        }
    }
}

async fn wait_for_shutdown(mode: Mode, stop: Arc<Notify>) {
    let stdin_closed = async {
        if mode != Mode::Stdio {
            std::future::pending::<()>().await;
            return;
        }
        let (sender, receiver) = tokio::sync::oneshot::channel::<()>();
        std::thread::spawn(move || {
            use std::io::Read as _;
            let mut stdin = std::io::stdin().lock();
            let mut buffer = [0u8; 1024];
            loop {
                match stdin.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => continue,
                }
            }
            let _ = sender.send(());
        });
        let _ = receiver.await;
    };
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
            _ = stop.notified() => {}
            _ = stdin_closed => {}
        }
    }
    #[cfg(not(unix))]
    {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = stop.notified() => {}
            _ = stdin_closed => {}
        }
    }
}

#[derive(Clone)]
struct Registration {
    file: PathBuf,
    info: JsonValue,
}

impl Registration {
    fn write(config: &LaunchConfig, identity: &Identity, url: &str) -> Result<Self, LaunchError> {
        let file = config.state_dir.join(service_filename(&config.channel));
        let mut object = JsonObject::new();
        object.insert(
            LosslessString::from("id"),
            JsonValue::String(LosslessString::from(identity.source_epoch.as_str())),
        );
        object.insert(
            LosslessString::from("version"),
            JsonValue::String(LosslessString::from(identity.version.as_str())),
        );
        object.insert(
            LosslessString::from("url"),
            JsonValue::String(LosslessString::from(url)),
        );
        object.insert(
            LosslessString::from("pid"),
            JsonValue::Number(identity.pid as f64),
        );
        object.insert(
            LosslessString::from("password"),
            JsonValue::String(LosslessString::from(config.password.as_str())),
        );
        let info = JsonValue::Object(object);
        let contents = stringify_json(&info);
        write_private(&file, contents.as_bytes())?;
        Ok(Self { file, info })
    }

    fn remove_if_owned(&self) {
        if self.owns() {
            let _ = std::fs::remove_file(&self.file);
        }
    }

    fn owns(&self) -> bool {
        read_json_file(&self.file).is_some_and(|current| {
            ["id", "version", "url", "password"]
                .into_iter()
                .all(|key| json_string(&current, key) == json_string(&self.info, key))
                && json_u64(&current, "pid") == json_u64(&self.info, "pid")
        })
    }
}

fn spawn_registration_watch(
    registration: Registration,
    stop: Arc<Notify>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            if !registration.owns() {
                stop.notify_one();
                return;
            }
        }
    })
}

fn persist_service_password(config: &LaunchConfig) -> Result<(), LaunchError> {
    let file = config.config_dir.join(service_filename(&config.channel));
    let mut object = read_service_config(&file)
        .and_then(|value| match value {
            JsonValue::Object(object) => Some(object),
            _ => None,
        })
        .unwrap_or_default();
    object.insert(
        LosslessString::from("password"),
        JsonValue::String(LosslessString::from(config.password.as_str())),
    );
    let contents = format!("{}\n", stringify_json(&JsonValue::Object(object)));
    write_private(&file, contents.as_bytes())?;
    Ok(())
}

async fn incumbent(config: &LaunchConfig) -> bool {
    let Some(port) = config.port.filter(|port| *port != 0) else {
        return false;
    };
    let registration = read_json_file(&config.state_dir.join(service_filename(&config.channel)));
    let Some(registration) = registration else {
        return false;
    };
    let (Some(pid), Some(password)) = (
        json_u64(&registration, "pid"),
        json_string(&registration, "password"),
    ) else {
        return false;
    };
    let address = format!("{}:{port}", config.hostname);
    for _ in 0..150 {
        if let Some(health) = probe_health(&address, &password).await
            && health.0 == pid
            && health.1 == config.version
        {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

async fn probe_health(address: &str, password: &str) -> Option<(u64, String)> {
    let mut stream = TcpStream::connect(address).await.ok()?;
    let request = format!(
        "GET /api/health HTTP/1.1\r\nHost: {address}\r\nAuthorization: Basic {}\r\nConnection: close\r\n\r\n",
        encode_base64(format!("ycoding:{password}").as_bytes())
    );
    stream.write_all(request.as_bytes()).await.ok()?;
    let mut response = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut response)).await;
    let text = String::from_utf8_lossy(&response);
    if !text.starts_with("HTTP/1.1 200") {
        return None;
    }
    let body = text.split("\r\n\r\n").nth(1)?;
    let value = parse_json(body).ok()?;
    Some((json_u64(&value, "pid")?, json_string(&value, "version")?))
}

fn read_json_file(path: &PathBuf) -> Option<JsonValue> {
    parse_json(&std::fs::read_to_string(path).ok()?).ok()
}

fn read_service_config(path: &PathBuf) -> Option<JsonValue> {
    read_json_file(path).filter(|value| {
        let JsonValue::Object(object) = value else {
            return false;
        };
        ["hostname", "password"]
            .into_iter()
            .all(|key| object.get(&key.into()).is_none() || json_string(value, key).is_some())
            && (object.get(&"port".into()).is_none()
                || json_u16(value, "port").is_some_and(|port| port > 0))
    })
}

pub(crate) fn json_string(value: &JsonValue, key: &str) -> Option<String> {
    let JsonValue::Object(object) = value else {
        return None;
    };
    match object.get(&LosslessString::from(key)) {
        Some(JsonValue::String(value)) => value.as_str().map(str::to_string),
        _ => None,
    }
}

fn json_u16(value: &JsonValue, key: &str) -> Option<u16> {
    json_u64(value, key).and_then(|value| u16::try_from(value).ok())
}

fn json_u64(value: &JsonValue, key: &str) -> Option<u64> {
    let JsonValue::Object(object) = value else {
        return None;
    };
    match object.get(&LosslessString::from(key)) {
        Some(JsonValue::Number(value))
            if *value >= 0.0 && value.fract() == 0.0 && *value <= 9_007_199_254_740_991.0 =>
        {
            Some(*value as u64)
        }
        _ => None,
    }
}

fn write_private(path: &PathBuf, contents: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension(format!("{}.tmp", source_epoch().map_err(io::Error::other)?));
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)?;
        std::io::Write::write_all(&mut file, contents)?;
        file.sync_all()?;
    }
    #[cfg(not(unix))]
    std::fs::write(&temp, contents)?;
    std::fs::rename(&temp, path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        if let Some(parent) = path.parent() {
            std::fs::File::open(parent)?.sync_all()?;
        }
    }
    Ok(())
}

fn message(error: impl fmt::Display) -> LaunchError {
    LaunchError::Message(error.to_string())
}

fn truthy(value: Option<&String>) -> bool {
    value.is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"))
}

fn metadata() -> Result<Metadata, LaunchError> {
    let id = source_epoch()?.replace('-', "");
    let mut bytes = [0; 16];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&id[index * 2..index * 2 + 2], 16).map_err(message)?;
    }
    Ok(Metadata::new(bytes, 1))
}

fn open_store(config: &LaunchConfig) -> Result<Store, LaunchError> {
    let catalog = import::catalog(import::DatabaseKind::Core);
    let file = config.roots.data.join("ycoding.redb");
    if config.channel == "beta" {
        import_beta(config, &file)?;
    }
    if file.try_exists()? {
        return Store::open(file, Options::core(), catalog).map_err(message);
    }
    let store = Store::initialize(&file, Options::core(), catalog, metadata()?).map_err(message)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(store)
}

fn import_beta(config: &LaunchConfig, file: &std::path::Path) -> Result<(), LaunchError> {
    let marker = config.roots.state.join("stable-import-v1.json");
    if marker.try_exists()? {
        return match std::fs::read_to_string(&marker)?.as_str() {
            "{\"complete\":true,\"version\":1,\"imported\":true}\n" if file.try_exists()? => Ok(()),
            "{\"complete\":true,\"version\":1,\"imported\":false}\n" => Ok(()),
            _ => Err(message(
                "invalid beta import marker or missing imported store",
            )),
        };
    }
    if file.try_exists()? {
        let store = Store::open(
            file,
            Options::core(),
            import::catalog(import::DatabaseKind::Core),
        )
        .map_err(message)?;
        let verified = store
            .snapshot()
            .map_err(message)?
            .get::<import::ProvenanceTable>(&[])
            .map_err(message)?
            .is_some();
        store.shutdown().map_err(message)?;
        if !verified {
            return Err(message("beta store has no completed import provenance"));
        }
    } else {
        let source = config.stable_data.join("ycoding.db");
        if source.try_exists()? {
            let scratch = config
                .roots
                .tmp
                .join(format!("stable-import-{}", source_epoch()?));
            std::fs::create_dir(&scratch)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&scratch, std::fs::Permissions::from_mode(0o700))?;
            }
            let candidate = config
                .roots
                .data
                .join(format!(".stable-import-{}.redb", source_epoch()?));
            let copied = scratch.join("source.sqlite");
            let result = (|| {
                import::copy_source(&source, &copied).map_err(message)?;
                import::stage(
                    import::Request {
                        source: &copied,
                        candidate: &candidate,
                        kind: import::DatabaseKind::Core,
                        metadata: metadata()?,
                    },
                    |_| std::ops::ControlFlow::Continue(()),
                )
                .map_err(message)?;
                std::fs::rename(&candidate, file)?;
                #[cfg(unix)]
                std::fs::File::open(&config.roots.data)?.sync_all()?;
                Ok::<_, LaunchError>(())
            })();
            let cleanup = std::fs::remove_dir_all(&scratch)
                .and_then(|()| {
                    if candidate.try_exists()? {
                        std::fs::remove_file(&candidate)?;
                    }
                    Ok(())
                })
                .map_err(LaunchError::from);
            result.and(cleanup)?;
        }
    }
    write_private(
        &marker,
        if file.try_exists()? {
            b"{\"complete\":true,\"version\":1,\"imported\":true}\n"
        } else {
            b"{\"complete\":true,\"version\":1,\"imported\":false}\n"
        },
    )?;
    Ok(())
}

fn source_epoch() -> Result<String, LaunchError> {
    ycoding_core::meeting::store::uuid().map_err(message)
}

fn random_password() -> Result<String, LaunchError> {
    Ok(format!(
        "{}{}",
        source_epoch()?.replace('-', ""),
        source_epoch()?.replace('-', "")
    ))
}

fn encode_base64(input: &[u8]) -> String {
    const STANDARD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::new();
    for chunk in input.chunks(3) {
        let value = chunk.iter().enumerate().fold(0u32, |value, (index, byte)| {
            value | (u32::from(*byte) << (16 - 8 * index))
        });
        for index in 0..4 {
            if index <= chunk.len() {
                output.push(STANDARD[((value >> (18 - 6 * index)) & 0x3f) as usize] as char);
            } else {
                output.push('=');
            }
        }
    }
    output
}

pub fn sha1_hex(input: &[u8]) -> String {
    sha1(input)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn sha1(input: &[u8]) -> [u8; 20] {
    let mut state: [u32; 5] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
    let bit_length = (input.len() as u64).wrapping_mul(8);
    let mut padded = input.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend(bit_length.to_be_bytes());
    for block in padded.chunks_exact(64) {
        let mut words = [0u32; 80];
        for (index, word) in words.iter_mut().take(16).enumerate() {
            *word = u32::from_be_bytes([
                block[index * 4],
                block[index * 4 + 1],
                block[index * 4 + 2],
                block[index * 4 + 3],
            ]);
        }
        for index in 16..80 {
            words[index] =
                (words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16])
                    .rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) =
            (state[0], state[1], state[2], state[3], state[4]);
        for (index, word) in words.iter().enumerate() {
            let (function, constant) = match index {
                0..=19 => ((b & c) | ((!b) & d), 0x5a827999),
                20..=39 => (b ^ c ^ d, 0x6ed9eba1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8f1bbcdc),
                _ => (b ^ c ^ d, 0xca62c1d6),
            };
            let next = a
                .rotate_left(5)
                .wrapping_add(function)
                .wrapping_add(e)
                .wrapping_add(constant)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = next;
        }
        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
        state[4] = state[4].wrapping_add(e);
    }
    let mut output = [0u8; 20];
    for (index, word) in state.iter().enumerate() {
        output[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    output
}
