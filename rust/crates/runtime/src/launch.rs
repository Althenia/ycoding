use crate::LocalAuth;
use crate::server;
use crate::services::{Identity, Services};
use std::collections::BTreeMap;
use std::fmt;
use std::io;
use std::path::{Component, Path, PathBuf};
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

mod activation;
use activation::Paths;
pub use activation::{ImportError, ImportSource};

include!(concat!(env!("OUT_DIR"), "/bundled_models.rs"));

pub const BETA_NAMESPACE: &str = "ycoding-beta";
pub(crate) const FRONTEND_EXECUTABLE_KEY: &str = "YCODING_FRONTEND_EXECUTABLE";

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
Usage: ycoding-runtime [serve] [--hostname <host>] [--port <port>] [--service | --stdio] [--cors <origin>] [--meeting]

Options:
  --hostname <host>  Bind hostname or IP address (default 127.0.0.1)
  --port <port>      Bind port, 0-65535; 0 selects an ephemeral port
  --service          Run as the managed background service
  --stdio            Print one JSON readiness line and stop when stdin closes
  --cors <origin>    Allow one additional WebSocket origin (repeatable)
  --meeting          Start the Meeting runtime for each Location the server composes
  --frontend-executable <path>  Installed frontend executable owning native assets
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
    pub meeting: bool,
    pub password: String,
    pub password_generated: bool,
    pub version: String,
    pub channel: String,
    pub config_dir: PathBuf,
    pub state_dir: PathBuf,
    pub roots: config::Roots,
    pub storage: Storage,
    pub environment: BTreeMap<String, String>,
    pub startup_error_file: Option<PathBuf>,
}

#[derive(Clone, Debug)]
pub enum Storage {
    Memory { analytics: PathBuf },
    File(FileStorage),
}

#[derive(Clone, Debug)]
pub struct FileStorage {
    pub file: PathBuf,
    pub lease: PathBuf,
    pub analytics: PathBuf,
    pub marker: PathBuf,
    pub import: ImportSource,
    pub source_resources: PathBuf,
    pub slot: bool,
}

impl Storage {
    pub fn analytics(&self) -> &Path {
        match self {
            Self::Memory { analytics } => analytics,
            Self::File(storage) => &storage.analytics,
        }
    }
}

#[derive(Debug)]
pub enum LaunchError {
    Usage(String),
    Message(String),
    Io(io::Error),
    Import(ImportError),
}

impl fmt::Display for LaunchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Usage(message) | Self::Message(message) => formatter.write_str(message),
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Import(error) => error.fmt(formatter),
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
    let mut meeting = false;
    let mut frontend_executable = None;
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
                "--service" | "--stdio" | "--meeting" | "--paths" | "--help" | "--version"
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
            "--frontend-executable" => {
                let value = take(&mut position)?;
                let path = std::path::Path::new(&value);
                if !path.is_absolute() || path.file_name().is_none() {
                    return Err(LaunchError::Usage(
                        "--frontend-executable requires an absolute executable path".into(),
                    ));
                }
                frontend_executable = Some(value);
            }
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
            "--meeting" => meeting = true,
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
    let database = env("YCODING_DB").filter(|value| !value.is_empty());
    let import_source = env("YCODING_SQLITE_IMPORT_SOURCE").filter(|value| !value.is_empty());
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
    .chain(frontend_executable.map(|value| (FRONTEND_EXECUTABLE_KEY.into(), value)))
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
    check_import_source(database.as_deref(), import_source.as_deref())?;
    Ok(Parsed::Run(Box::new(LaunchConfig {
        mode,
        hostname: hostname.unwrap_or_else(|| "127.0.0.1".to_string()),
        port,
        cors,
        meeting,
        password,
        password_generated,
        version,
        storage: select_storage(
            &channel,
            &roots,
            &stable_data,
            database.as_deref(),
            env("YCODING_DISABLE_CHANNEL_DB").is_some_and(|value| value == "1" || value == "true"),
            import_source,
        )?,
        channel,
        config_dir,
        state_dir,
        roots,
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
    let core = crate::Core::production_with_recovery(
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
                        key != "YCODING_PASSWORD"
                            && key != "YCODING_SERVER_PASSWORD"
                            && key != FRONTEND_EXECUTABLE_KEY
                    })
                    .chain(
                        config
                            .environment
                            .get(FRONTEND_EXECUTABLE_KEY)
                            .map(|value| (FRONTEND_EXECUTABLE_KEY.into(), value.clone())),
                    )
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
                bundled: Some(parse_json(BUNDLED_MODELS).map_err(|_| {
                    LaunchError::Message("bundled model catalog is invalid".into())
                })?),
                fetch: !truthy(config.environment.get("YCODING_DISABLE_MODELS_FETCH")),
                user_agent: format!("ycoding/{}", config.version),
            },
            cursor: None,
            steer: None,
            ripgrep: "rg".into(),
            meeting: config.meeting,
            analytics: config.storage.analytics().to_path_buf(),
        },
        config.mode == Mode::Service,
    )
    .await
    .map_err(|failure| {
        if !matches!(failure, crate::dispatch::Failure::Unavailable(_)) {
            let category = match failure {
                crate::dispatch::Failure::Invalid(_)
                | crate::dispatch::Failure::InvalidField { .. } => "invalid",
                crate::dispatch::Failure::Unknown { .. } => "unknown",
                crate::dispatch::Failure::ServiceUnavailable { .. } => "unavailable",
                _ => "other",
            };
            eprintln!("production composition diagnostic: stage=production; category={category}");
        }
        LaunchError::Message("production composition failed".into())
    })?;
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
    validate_storage(&config)?;
    let _analytics = MemoryAnalytics(match &config.storage {
        Storage::Memory { analytics } => Some(analytics.clone()),
        Storage::File(_) => None,
    });
    config.roots.initialize().map_err(message)?;
    let lease = match &config.storage {
        Storage::File(storage) => Some(
            std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(&storage.lease)?,
        ),
        Storage::Memory { .. } => None,
    };
    if let Some(lease) = &lease {
        match lease.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) if config.mode == Mode::Service => {
                return Ok(());
            }
            Err(error) => return Err(message(error)),
        }
    }
    let mut diagnostics =
        ycoding_core::observability::install(ycoding_core::observability::Options::new(
            &config.roots,
            &config.version,
            &config.channel,
            config.channel == "local",
        ))
        .map_err(message)?;
    let store_config = config.clone();
    tokio::task::spawn_blocking(move || prepare_store(&store_config))
        .await
        .map_err(|_| LaunchError::Message("Store startup worker failed".into()))??;
    let store = open_store(&config)?;
    let services = match diagnostics
        .attach_events(ycoding_core::event_feed::Feed::attach(&store.client()))
        .map_err(message)
    {
        Ok(()) => build_production_services(&config, &store).await,
        Err(error) => Err(error),
    };
    let services = match services {
        Ok(services) => services,
        Err(error) => {
            if store.shutdown().is_err() {
                tracing::error!("Store shutdown after a failed start failed");
            }
            let _ = diagnostics.close();
            return Err(error);
        }
    };
    let core = services.core.clone();
    let (result, registration) = serve_until_stopped(&config, services).await;
    let suspended = match (&core, config.mode) {
        (Some(core), Mode::Service) => core
            .execution
            .suspend_active(crate::ids::now_millis())
            .await
            .map_err(|_| LaunchError::Message("active Session suspension failed".into())),
        _ => Ok(()),
    };
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
    let diagnostics_result = diagnostics.close().map_err(message);
    let store_result = store.shutdown().map_err(message);
    result
        .and(suspended)
        .and(core_result)
        .and(diagnostics_result)
        .and(store_result)
}

async fn serve_until_stopped(
    config: &LaunchConfig,
    services: Services,
) -> (Result<(), LaunchError>, Option<Registration>) {
    let identity = services.identity.clone();
    let listener = match bind(config).await {
        Ok(listener) => listener,
        Err(error) => {
            if config.mode == Mode::Service
                && error.kind() == io::ErrorKind::AddrInUse
                && incumbent(config).await
            {
                return (Ok(()), None);
            }
            if config.mode == Mode::Service
                && config.port.is_some_and(|port| port != 0)
                && error.kind() == io::ErrorKind::AddrInUse
            {
                return (
                    Err(LaunchError::Message(format!(
                        "Managed service port {} on {} is already in use by another process. Set `port` in {} under the YCoding config directory, or start with `--standalone`.",
                        config.port.unwrap_or_default(),
                        config.hostname,
                        service_filename(&config.channel),
                    ))),
                    None,
                );
            }
            return (Err(error.into()), None);
        }
    };
    // Signal listeners exist before readiness is published, so a stop sent right after the
    // registration appears still runs graceful shutdown.
    let signals = match shutdown_signals() {
        Ok(signals) => signals,
        Err(error) => return (Err(error.into()), None),
    };
    let stop = Arc::new(Notify::new());
    let control = match crate::health::Control::install(
        config.mode == Mode::Service,
        &identity,
        stop.clone(),
    ) {
        Ok(control) => control,
        Err(error) => return (Err(error.into()), None),
    };
    let remote = match services.core.as_ref().and_then(|core| core.remote.clone()) {
        Some(control) => {
            let dispatcher = match crate::handlers::standard() {
                Ok(dispatcher) => Arc::new(dispatcher),
                Err(_) => {
                    return (
                        Err(LaunchError::Message("remote dispatcher unavailable".into())),
                        None,
                    );
                }
            };
            let address = match listener.local_addr() {
                Ok(address) => address,
                Err(error) => return (Err(error.into()), None),
            };
            Some((
                control,
                Arc::new(crate::services::Environment {
                    services: services.clone(),
                    urls: vec![format!("http://{address}")],
                    subscriptions: Default::default(),
                    uploads: Default::default(),
                }),
                dispatcher,
            ))
        }
        None => None,
    };
    let server = match server::serve(listener, services).await {
        Ok(server) => server,
        Err(error) => return (Err(error.into()), None),
    };
    let connector = match remote {
        Some((control, environment, dispatcher)) => match crate::connector::Connector::start(
            control.clone(),
            crate::connector::Settings::new(Arc::new(control.device().clone())),
            environment,
            dispatcher,
        ) {
            Ok(connector) => Some(connector),
            Err(_) => {
                let stopped = server.shutdown().await.map_err(LaunchError::from);
                return (
                    Err::<(), _>(LaunchError::Message("remote connector unavailable".into()))
                        .and(stopped),
                    None,
                );
            }
        },
        None => None,
    };
    let url = format!("http://{}", server.address());

    let registration = if config.mode == Mode::Service {
        let registered = (if config.password_generated {
            persist_service_password(config)
        } else {
            Ok(())
        })
        .and_then(|()| Registration::write(config, &identity, &url));
        match registered {
            Ok(registered) => Some(registered),
            Err(error) => {
                drop(control);
                let remote = match connector {
                    Some(connector) => connector.shutdown().await.map_err(|_| {
                        LaunchError::Message("remote connector shutdown failed".into())
                    }),
                    None => Ok(()),
                };
                let stopped = server.shutdown().await.map_err(LaunchError::from);
                return (Err::<(), _>(error).and(remote).and(stopped), None);
            }
        }
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
    wait_for_shutdown(config.mode, stop, signals).await;
    if let Some(watcher) = watcher {
        watcher.abort();
        let _ = watcher.await;
    }
    drop(control);
    let remote = match connector {
        Some(connector) => connector
            .shutdown()
            .await
            .map_err(|_| LaunchError::Message("remote connector shutdown failed".into())),
        None => Ok(()),
    };
    let local = server.shutdown().await.map_err(LaunchError::from);
    (remote.and(local), registration)
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

#[cfg(unix)]
type Signals = (tokio::signal::unix::Signal, tokio::signal::unix::Signal);
#[cfg(not(unix))]
type Signals = tokio::signal::windows::CtrlC;

#[cfg(unix)]
fn shutdown_signals() -> io::Result<Signals> {
    use tokio::signal::unix::{SignalKind, signal};
    Ok((
        signal(SignalKind::terminate())?,
        signal(SignalKind::interrupt())?,
    ))
}

#[cfg(not(unix))]
fn shutdown_signals() -> io::Result<Signals> {
    tokio::signal::windows::ctrl_c()
}

async fn wait_for_shutdown(mode: Mode, stop: Arc<Notify>, signals: Signals) {
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
        let (mut terminate, mut interrupt) = signals;
        tokio::select! {
            _ = interrupt.recv() => {}
            _ = terminate.recv() => {}
            _ = stop.notified() => {}
            _ = stdin_closed => {}
        }
    }
    #[cfg(not(unix))]
    {
        let mut interrupt = signals;
        tokio::select! {
            _ = interrupt.recv() => {}
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

fn write_private(path: &Path, contents: &[u8]) -> io::Result<()> {
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

fn prepare_store(config: &LaunchConfig) -> Result<(), LaunchError> {
    let Storage::File(storage) = &config.storage else {
        return Ok(());
    };
    activation::activate(
        &storage.import,
        Paths {
            file: &storage.file,
            marker: &storage.marker,
            scratch_root: &config.roots.tmp,
            source_resources: &storage.source_resources,
            target_resources: &config.roots.data,
            create_parents: storage.slot,
        },
        import::DatabaseKind::Core,
        |_| Ok(()),
    )?;
    if storage.file.try_exists()? {
        ycoding_core::ycoding_store::upgrade::core(
            &storage.file,
            Options::core(),
            ycoding_core::session::history_pruning::free_bytes,
        )
        .map_err(|_| unsupported_store())?;
    }
    Ok(())
}

fn open_store(config: &LaunchConfig) -> Result<Store, LaunchError> {
    let catalog = import::catalog(import::DatabaseKind::Core);
    let Storage::File(storage) = &config.storage else {
        return Store::disposable(Options::core(), catalog, metadata()?).map_err(message);
    };
    if storage.file.try_exists()? {
        return Store::open(&storage.file, Options::core(), catalog)
            .map_err(|_| unsupported_store());
    }
    let store =
        Store::initialize(&storage.file, Options::core(), catalog, metadata()?).map_err(message)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&storage.file, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(store)
}

fn unsupported_store() -> LaunchError {
    LaunchError::Message(
        "The YCoding data store is unreadable or uses an unsupported format, or its upgrade could not be completed. Existing store files and backups were retained; inspect them before starting again.".into(),
    )
}

pub(crate) fn import_stable(
    source: &Path,
    file: &Path,
    marker: &Path,
    scratch_root: &Path,
    kind: import::DatabaseKind,
) -> Result<(), LaunchError> {
    activation::activate(
        &ImportSource::Default(source.to_path_buf()),
        Paths {
            file,
            marker,
            scratch_root,
            source_resources: source
                .parent()
                .ok_or_else(|| message("the import source has no parent directory"))?,
            target_resources: file
                .parent()
                .ok_or_else(|| message("the import target has no parent directory"))?,
            create_parents: true,
        },
        kind,
        |_| Ok(()),
    )
}

struct MemoryAnalytics(Option<PathBuf>);

impl Drop for MemoryAnalytics {
    fn drop(&mut self) {
        let Some(directory) = self.0.take() else {
            return;
        };
        if let Err(error) = std::fs::remove_dir_all(&directory)
            && error.kind() != io::ErrorKind::NotFound
        {
            tracing::error!(%error, "Disposable analytics cleanup failed");
        }
    }
}

fn check_import_source(database: Option<&str>, source: Option<&str>) -> Result<(), LaunchError> {
    let Some(source) = source else {
        return Ok(());
    };
    if !Path::new(source).is_absolute() {
        return Err(LaunchError::Usage(
            "YCODING_SQLITE_IMPORT_SOURCE must be an absolute path".into(),
        ));
    }
    if database.is_none_or(|database| database == ":memory:") {
        return Err(LaunchError::Usage(
            "YCODING_SQLITE_IMPORT_SOURCE requires YCODING_DB to name a file store".into(),
        ));
    }
    Ok(())
}

fn select_storage(
    channel: &str,
    roots: &config::Roots,
    stable_data: &Path,
    database: Option<&str>,
    selector: bool,
    source: Option<String>,
) -> Result<Storage, LaunchError> {
    let mut slot = slot_storage(channel, roots, stable_data, selector);
    let Some(database) = database else {
        return Ok(Storage::File(with_source(slot, source)));
    };
    if database == ":memory:" {
        return Ok(Storage::Memory {
            analytics: roots.tmp.join(format!("analytics-{}", source_epoch()?)),
        });
    }
    let requested = roots.data.join(database);
    if resolve(&requested) == resolve(&slot.file) {
        return Ok(Storage::File(with_source(slot, source)));
    }
    slot.lease = companion(&requested, ".runtime.lock");
    slot.analytics = companion(&requested, ".analytics");
    slot.marker = companion(&requested, ".stable-import-v1.json");
    slot.file = requested;
    slot.slot = false;
    slot.import = ImportSource::None;
    Ok(Storage::File(with_source(slot, source)))
}

fn with_source(mut storage: FileStorage, source: Option<String>) -> FileStorage {
    if let Some(source) = source {
        storage.import = ImportSource::Explicit(PathBuf::from(source));
    }
    storage
}

fn slot_storage(
    channel: &str,
    roots: &config::Roots,
    stable_data: &Path,
    selector: bool,
) -> FileStorage {
    let named = |name: &str| {
        (
            roots.data.join(format!("ycoding{name}.redb")),
            roots.data.join(format!("runtime{name}.lock")),
            roots.data.join(format!("analytics{name}")),
        )
    };
    let (file, lease, analytics, marker, import) = if channel == "beta" {
        let (file, lease, analytics) = named("");
        (
            file,
            lease,
            analytics,
            roots.state.join("stable-import-v1.json"),
            ImportSource::Default(stable_data.join("ycoding.db")),
        )
    } else if matches!(channel, "latest" | "prod") || selector {
        let (file, lease, analytics) = named("");
        (
            file,
            lease,
            analytics,
            roots.state.join("stable-import-v1.json"),
            ImportSource::None,
        )
    } else {
        let name = sanitize(channel);
        let (file, lease, analytics) = named(&format!("-{name}"));
        (
            file,
            lease,
            analytics,
            roots.state.join(format!("stable-import-{name}-v1.json")),
            ImportSource::Default(stable_data.join(format!("ycoding-{name}.db"))),
        )
    };
    FileStorage {
        file,
        lease,
        analytics,
        marker,
        import,
        source_resources: stable_data.to_path_buf(),
        slot: true,
    }
}

fn sanitize(channel: &str) -> String {
    channel
        .chars()
        .flat_map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                vec![character]
            } else {
                vec!['-'; character.len_utf16()]
            }
        })
        .collect()
}

fn companion(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    name.into()
}

fn resolve(path: &Path) -> PathBuf {
    let mut resolved = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                resolved = existing_prefix(&resolved);
                resolved.pop();
            }
            other => resolved.push(other.as_os_str()),
        }
    }
    existing_prefix(&resolved)
}

fn existing_prefix(path: &Path) -> PathBuf {
    let mut head = path.to_path_buf();
    let mut tail = Vec::new();
    loop {
        if let Ok(mut real) = std::fs::canonicalize(&head) {
            real.extend(tail.iter().rev());
            return real;
        }
        let Some(name) = head.file_name().map(ToOwned::to_owned) else {
            return path.to_path_buf();
        };
        tail.push(name);
        head.pop();
    }
}

fn validate_storage(config: &LaunchConfig) -> Result<(), LaunchError> {
    let Storage::File(storage) = &config.storage else {
        return Ok(());
    };
    if !storage.slot {
        validate_target(storage, &config.roots.data)?;
    }
    if matches!(storage.import, ImportSource::None)
        || !activation::import_would_run(
            &storage.file,
            &storage.marker,
            import::DatabaseKind::Core,
        )?
    {
        return Ok(());
    }
    if storage.file.try_exists()? && !storage.marker.with_extension("stage-v2").try_exists()? {
        return Err(refusal(
            "the target already holds a store that was never imported; it was left unchanged",
        ));
    }
    if let ImportSource::Explicit(source) = &storage.import {
        validate_source(source, storage)?;
    }
    Ok(())
}

fn validate_target(storage: &FileStorage, data: &Path) -> Result<(), LaunchError> {
    let parent = storage
        .file
        .parent()
        .ok_or_else(|| refusal("the target has no parent directory"))?;
    if parent
        .components()
        .any(|component| component == Component::ParentDir)
        || resolve(parent) != resolve(data)
    {
        match std::fs::symlink_metadata(parent) {
            Ok(info) if info.is_dir() => {}
            _ => {
                return Err(refusal(
                    "the target parent is missing, is not a directory, or is a symbolic link; nothing was changed",
                ));
            }
        }
    }
    match std::fs::symlink_metadata(&storage.file) {
        Ok(info) if info.is_file() => {
            let mut header = [0; 16];
            let sqlite = std::fs::File::open(&storage.file)
                .and_then(|mut file| io::Read::read_exact(&mut file, &mut header))
                .is_ok()
                && &header == b"SQLite format 3\0";
            if sqlite {
                return Err(refusal(
                    "the target is a SQLite database and was left unchanged; use YCODING_SQLITE_IMPORT_SOURCE to import it into a new native store file",
                ));
            }
            Ok(())
        }
        Ok(_) => Err(refusal(
            "the target is not a regular file; nothing was changed",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(refusal(
            "the target cannot be inspected; nothing was changed",
        )),
    }
}

fn validate_source(source: &Path, storage: &FileStorage) -> Result<(), LaunchError> {
    match std::fs::symlink_metadata(source) {
        Ok(info) if info.is_file() => {}
        Ok(_) => {
            return Err(LaunchError::Message(
                "YCODING_SQLITE_IMPORT_SOURCE must name a regular file, not a directory or symbolic link; nothing was changed".into(),
            ));
        }
        Err(_) => {
            return Err(LaunchError::Message(
                "YCODING_SQLITE_IMPORT_SOURCE does not name an existing file; nothing was changed"
                    .into(),
            ));
        }
    }
    let sources = ["", "-wal", "-journal", "-shm"]
        .into_iter()
        .map(|suffix| resolve(&companion(source, suffix)))
        .collect::<Vec<_>>();
    let mut owned = vec![
        storage.file.clone(),
        storage.lease.clone(),
        storage.analytics.clone(),
        companion(&storage.file, ".pre-prune-backup"),
        companion(&storage.file, ".pre-prune-backup.complete"),
        storage.marker.clone(),
        storage.marker.with_extension("stage-v2"),
        storage.marker.with_extension("import-lock"),
    ];
    if let Some(directory) = storage.file.parent()
        && let Ok(entries) = std::fs::read_dir(directory)
    {
        owned.extend(entries.flatten().filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            (name.starts_with(".stable-import-") && name.ends_with(".redb")).then(|| entry.path())
        }));
    }
    let mut aliased = false;
    for path in owned {
        aliased |= sources.contains(&resolve(&path));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let (Ok(target), Ok(origin)) =
            (std::fs::metadata(&storage.file), std::fs::metadata(source))
        {
            aliased |= target.dev() == origin.dev() && target.ino() == origin.ino();
        }
    }
    if aliased {
        return Err(LaunchError::Message(
            "YCODING_SQLITE_IMPORT_SOURCE overlaps a file owned by the target store; nothing was changed".into(),
        ));
    }
    Ok(())
}

fn refusal(reason: &str) -> LaunchError {
    LaunchError::Message(format!("YCODING_DB: {reason}"))
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
    for block in padded.as_chunks::<64>().0 {
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

#[cfg(test)]
mod frontend_launch_tests {
    use super::{LaunchError, Parsed, parse_launch};

    #[test]
    fn frontend_launch_flag_is_explicit_absolute_and_not_read_from_environment() {
        let home = std::env::temp_dir().join("ycoding-frontend-launch");
        let frontend = home.join("installed").join("ycoding");
        let env = |key: &str| match key {
            "HOME" => Some(home.to_string_lossy().into_owned()),
            "YCODING_FRONTEND_EXECUTABLE" => Some("untrusted-environment-value".into()),
            _ => None,
        };
        let Parsed::Run(config) = parse_launch(
            &[
                "--frontend-executable".into(),
                frontend.to_string_lossy().into_owned(),
            ],
            env,
        )
        .unwrap() else {
            panic!("expected launch configuration")
        };
        assert_eq!(
            config.environment.get("YCODING_FRONTEND_EXECUTABLE"),
            Some(&frontend.to_string_lossy().into_owned())
        );
        let Parsed::Run(config) = parse_launch(&[], env).unwrap() else {
            panic!("expected launch configuration")
        };
        assert!(
            !config
                .environment
                .contains_key("YCODING_FRONTEND_EXECUTABLE")
        );
        assert!(matches!(
            parse_launch(
                &["--frontend-executable".into(), "relative/ycoding".into()],
                env
            ),
            Err(LaunchError::Usage(_))
        ));
        assert!(matches!(
            parse_launch(&["--frontend-executable".into()], env),
            Err(LaunchError::Usage(_))
        ));
    }
}
