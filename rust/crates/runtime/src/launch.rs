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
use ycoding_core::ycoding_store::{Metadata, Options, Store, native};
use ycoding_protocol::connection::Budgets;

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
    Production(crate::Failure),
    CoreShutdown(crate::Failure),
    Owner(crate::Report),
    Shutdown {
        first: Box<LaunchError>,
        later: Vec<LaunchError>,
    },
}

impl fmt::Display for LaunchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Usage(message) | Self::Message(message) => formatter.write_str(message),
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Owner(_) => formatter.write_str("production owner shutdown failed"),
            Self::Production(failure) => {
                write!(
                    formatter,
                    "production composition failed: {}",
                    production_stage(failure)
                )?;
                if let crate::Failure::ServiceUnavailable {
                    service:
                        crate::production::GLOBAL_CONFIGURATION | crate::production::TELEMETRY_PRUNING,
                    message,
                } = failure
                {
                    write!(formatter, ": {message}")?;
                }
                Ok(())
            }
            Self::CoreShutdown(_) => formatter.write_str("production shutdown failed"),
            Self::Shutdown { first, later } => {
                write!(formatter, "{first}")?;
                for error in later {
                    write!(formatter, "; additional shutdown failure: {error}")?;
                }
                Ok(())
            }
        }
    }
}

fn production_stage(failure: &crate::Failure) -> &str {
    let message = match failure {
        crate::Failure::ServiceUnavailable { service, .. } => return service,
        crate::Failure::Unavailable(message) => message,
        _ => return "production",
    };
    let primary = message
        .split_once("; cleanup failure: ")
        .map_or(message.as_str(), |(primary, _)| primary);
    match primary {
        "production owner admission is closed" => "production owner",
        "Location guardrail directory is unavailable" | "stored Location is not representable" => {
            "Location guardrail directories"
        }
        "Pending Form checkpoint is invalid"
        | "Pending Form owner is invalid"
        | "Pending Form restoration failed" => "Pending Form restoration",
        "Native Dots services are unavailable" => "Native Dots",
        "Relay MCP is unavailable" | "Relay MCP authorization already has a backend owner" => {
            "Relay MCP"
        }
        "MCP Events already has a backend owner" => "MCP Events",
        _ => match primary.strip_suffix(" unavailable") {
            Some(
                stage @ ("account catalog"
                | "agent configuration"
                | "artifact accounting secret"
                | "built-in agent catalog"
                | "Claude account source"
                | "Claude account store"
                | "composition runtime"
                | "computer Electron bridge"
                | "Cursor account store"
                | "Goal decision subscription"
                | "Interaction attachments"
                | "Interaction helper"
                | "Interaction helper discovery"
                | "Interaction platforms"
                | "interrupted steps"
                | "managed attachments"
                | "managed task recovery"
                | "MCP Events authorization"
                | "MCP Events capture"
                | "model catalog"
                | "model catalog events"
                | "native account methods"
                | "notification outbox"
                | "process-global Session execution"
                | "Project admitted input resumption"
                | "Project notification recovery"
                | "Project notification subscription"
                | "Project runtime"
                | "provider context"
                | "provider execution"
                | "provider usage"
                | "remote control"
                | "review reconciliation"
                | "ripgrep acquisition"
                | "runtime directories"
                | "session cleanup startup"
                | "Session status feed"
                | "Session store"
                | "shell ledger"
                | "shell process reconciliation"
                | "sleep keep-awake holds"
                | "stale tasks"
                | "stored autonomy"
                | "task notifications subscription"
                | "wellknown source"),
            ) => stage,
            _ => "production",
        },
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
                if !path.is_absolute() || path.file_name().is_none() || value.contains('\0') {
                    return Err(LaunchError::Usage(
                        "--frontend-executable requires an absolute executable path".into(),
                    ));
                }
                frontend_executable = Some(value);
            }
            "--frontend-arguments" => {
                return Err(LaunchError::Usage(
                    "--frontend-arguments is unsupported".into(),
                ));
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
        meeting,
        password,
        password_generated,
        version,
        storage: select_storage(
            &channel,
            &roots,
            database.as_deref(),
            env("YCODING_DISABLE_CHANNEL_DB").is_some_and(|value| value == "1" || value == "true"),
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
    owner: &crate::Handle,
    config: &LaunchConfig,
    client: ycoding_core::ycoding_store::Client,
) -> Result<Services, LaunchError> {
    build_services(owner, config, client, process_identity(config)?).await
}

fn process_identity(config: &LaunchConfig) -> Result<Identity, LaunchError> {
    Ok(Identity {
        version: config.version.clone(),
        pid: u64::from(std::process::id()),
        source_epoch: source_epoch()?,
    })
}

async fn build_services(
    owner: &crate::Handle,
    config: &LaunchConfig,
    client: ycoding_core::ycoding_store::Client,
    identity: Identity,
) -> Result<Services, LaunchError> {
    let core = crate::Core::production_with_recovery(
        owner,
        client,
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
                env: production_environment(config, std::env::vars()),
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
    .map_err(LaunchError::Production)?;
    Ok(Services {
        identity,
        auth: LocalAuth::with_password(config.password.clone()),
        cors: config.cors.clone(),
        budgets: Budgets::default(),
        core: Some(core),
    })
}

fn production_environment(
    config: &LaunchConfig,
    inherited: impl IntoIterator<Item = (String, String)>,
) -> BTreeMap<String, String> {
    inherited
        .into_iter()
        .filter(|(key, _)| {
            key != "YCODING_PASSWORD"
                && key != "YCODING_SERVER_PASSWORD"
                && key != FRONTEND_EXECUTABLE_KEY
                && key != "YCODING_FRONTEND_ARGUMENTS"
        })
        .chain(
            config
                .environment
                .get(FRONTEND_EXECUTABLE_KEY)
                .map(|value| (FRONTEND_EXECUTABLE_KEY.into(), value.clone())),
        )
        .collect()
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
        let lease = std::fs::OpenOptions::new()
            .write(true)
            .open(service_lease_path(config))
            .ok();
        if lease
            .as_ref()
            .is_some_and(|lease| lease.try_lock().is_err())
            || config
                .state_dir
                .join(service_filename(&config.channel))
                .exists()
            || file.exists()
        {
            return;
        }
        let _ = write_private(file, error.to_string().as_bytes());
    }
}

pub fn run(config: LaunchConfig, runtime: &tokio::runtime::Runtime) -> Result<(), LaunchError> {
    run_inherited(config, runtime, None, None)
}

pub fn run_inherited(
    config: LaunchConfig,
    runtime: &tokio::runtime::Runtime,
    data: Option<u32>,
    cleanup: Option<u32>,
) -> Result<(), LaunchError> {
    let parent = ycoding_core::extension::ParentOwner::inherit(data, cleanup)
        .map_err(|error| LaunchError::Message(format!("parent plugin descriptors: {error}")))?
        .map(Arc::new);
    let started = match &parent {
        Some(parent) => runtime
            .block_on(parent.start())
            .map_err(|error| LaunchError::Message(format!("parent plugin startup: {error}"))),
        None => Ok(()),
    };
    let body = started.and_then(|()| run_started(config, runtime, parent.clone()));
    let cleanup = runtime
        .block_on(crate::production::close_parent(parent.as_deref()))
        .map_err(LaunchError::CoreShutdown);
    launch_results([body, cleanup])
}

fn run_started(
    config: LaunchConfig,
    runtime: &tokio::runtime::Runtime,
    parent: Option<Arc<ycoding_core::extension::ParentOwner>>,
) -> Result<(), LaunchError> {
    let mut managed = if config.mode == Mode::Service {
        match runtime.block_on(ManagedLaunch::admit(&config))? {
            Some(managed) => Some(managed),
            None => return Ok(()),
        }
    } else {
        None
    };
    let body = run_bootstrap(&config, runtime, &mut managed, parent);
    let cleanup = match managed.as_mut() {
        Some(managed) => runtime.block_on(managed.finish()),
        None => Ok(()),
    };
    launch_results([body, cleanup])
}

fn run_bootstrap(
    config: &LaunchConfig,
    runtime: &tokio::runtime::Runtime,
    managed: &mut Option<ManagedLaunch>,
    parent: Option<Arc<ycoding_core::extension::ParentOwner>>,
) -> Result<(), LaunchError> {
    if managed
        .as_ref()
        .is_some_and(|managed| *managed.stopped.borrow())
    {
        return Ok(());
    }
    if let Err(error) = validate_storage(config) {
        return runtime.block_on(boot_failure(
            config,
            managed.as_mut(),
            BootFailure::Retained(error),
        ));
    }
    let _analytics = MemoryAnalytics(match &config.storage {
        Storage::Memory { analytics } => Some(analytics.clone()),
        Storage::File(_) => None,
    });
    if let Err(error) = config.roots.initialize() {
        return runtime.block_on(boot_failure(
            config,
            managed.as_mut(),
            BootFailure::Retained(message(error)),
        ));
    }
    let lease = match &config.storage {
        Storage::File(storage) => Some(
            std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(&storage.lease),
        ),
        Storage::Memory { .. } => None,
    };
    let lease = match lease.transpose() {
        Ok(lease) => lease,
        Err(error) => {
            return runtime.block_on(boot_failure(
                config,
                managed.as_mut(),
                BootFailure::Retained(error.into()),
            ));
        }
    };
    if let Some(lease) = &lease {
        match lease.try_lock() {
            Ok(()) => {}
            Err(error) => {
                return runtime.block_on(boot_failure(
                    config,
                    managed.as_mut(),
                    BootFailure::Retained(message(error)),
                ));
            }
        }
    }
    let mut diagnostics =
        match ycoding_core::observability::install(ycoding_core::observability::Options::new(
            &config.roots,
            &config.version,
            &config.channel,
            config.channel == "local",
        )) {
            Ok(diagnostics) => diagnostics,
            Err(error) => {
                return runtime.block_on(boot_failure(
                    config,
                    managed.as_mut(),
                    BootFailure::Retained(message(error)),
                ));
            }
        };
    let mut memory = match ycoding_core::observability::memory::start(diagnostics.debug_enabled()) {
        Ok(memory) => memory,
        Err(error) => {
            let body = runtime.block_on(boot_failure(
                config,
                managed.as_mut(),
                BootFailure::Retained(error.into()),
            ));
            return launch_results([body, diagnostics.close().map_err(message)]);
        }
    };
    if let Err(error) = prepare_store(config) {
        let body = runtime.block_on(boot_failure(config, managed.as_mut(), error));
        return launch_results([
            body,
            memory.close().map_err(message),
            diagnostics.close().map_err(message),
        ]);
    }
    let store = match open_store(config) {
        Ok(store) => store,
        Err(error) => {
            let body = runtime.block_on(boot_failure(config, managed.as_mut(), error));
            return launch_results([
                body,
                memory.close().map_err(message),
                diagnostics.close().map_err(message),
            ]);
        }
    };
    let attached = diagnostics
        .attach_events(ycoding_core::event_feed::Feed::attach(&store.client()))
        .map_err(message);
    let (body, cleanup) = match attached {
        Ok(()) => {
            let joined = crate::ProductionOwner::scope_with_parent(runtime, parent, |owner| {
                runtime.block_on(run_hosted(&owner, config, &store, managed.as_mut()))
            });
            let body = joined
                .body
                .unwrap_or_else(|_| Err(LaunchError::Message("production host failed".into())));
            let cleanup = if joined.cleanup.failures.is_empty() {
                Ok(())
            } else {
                Err(LaunchError::Owner(joined.cleanup))
            };
            (body, cleanup)
        }
        Err(error) => (
            runtime.block_on(boot_failure(
                config,
                managed.as_mut(),
                BootFailure::Retained(error),
            )),
            Ok(()),
        ),
    };
    let memory_result = memory.close().map_err(message);
    let diagnostics_result = diagnostics.close().map_err(message);
    let store_result = store.shutdown().map_err(message);
    launch_results([
        body,
        cleanup,
        memory_result,
        diagnostics_result,
        store_result,
    ])
}

async fn run_hosted(
    owner: &crate::Handle,
    config: &LaunchConfig,
    store: &Store,
    managed: Option<&mut ManagedLaunch>,
) -> Result<(), LaunchError> {
    if managed
        .as_ref()
        .is_some_and(|managed| *managed.stopped.borrow())
    {
        return Ok(());
    }
    let built = match managed.as_ref() {
        Some(managed) => {
            build_services(owner, config, store.client(), managed.identity.clone()).await
        }
        None => build_production_services(owner, config, store.client()).await,
    };
    let services = match built {
        Ok(services) => services,
        Err(error) => {
            return match managed {
                Some(managed) => managed.failure(config, error).await,
                None => Err(error),
            };
        }
    };
    let core = services.core.clone();
    let result = match managed {
        Some(managed) => managed.serve(config, services).await,
        None => serve_until_stopped(config, services).await,
    };
    let suspended = match (&core, config.mode) {
        (Some(core), Mode::Service) => core
            .execution
            .suspend_active(crate::ids::now_millis())
            .await
            .map_err(|_| LaunchError::Message("active Session suspension failed".into())),
        _ => Ok(()),
    };
    let core_result = match core {
        Some(core) => core.shutdown().await.map_err(LaunchError::CoreShutdown),
        None => Ok(()),
    };
    launch_results([result, suspended, core_result])
}

enum BootFailure {
    Retained(LaunchError),
    Refused(LaunchError),
}

impl From<io::Error> for BootFailure {
    fn from(error: io::Error) -> Self {
        Self::Retained(error.into())
    }
}

impl From<LaunchError> for BootFailure {
    fn from(error: LaunchError) -> Self {
        Self::Retained(error)
    }
}

async fn boot_failure(
    config: &LaunchConfig,
    managed: Option<&mut ManagedLaunch>,
    failure: BootFailure,
) -> Result<(), LaunchError> {
    match (managed, failure) {
        (Some(managed), BootFailure::Retained(error)) => managed.failure(config, error).await,
        (Some(managed), BootFailure::Refused(error)) => {
            let recorded = managed.record_failure(config, &error);
            let closed = managed.close_http().await;
            launch_results([Err(error), recorded, closed])
        }
        (None, BootFailure::Retained(error) | BootFailure::Refused(error)) => Err(error),
    }
}

struct ManagedLaunch {
    identity: Identity,
    state: Arc<server::Managed>,
    server: Option<server::Server>,
    registration: Registration,
    control: Option<Arc<crate::health::Control>>,
    stop: Arc<Notify>,
    stopped: tokio::sync::watch::Receiver<bool>,
    signals: Option<tokio::task::JoinHandle<io::Result<()>>>,
    watcher: Option<tokio::task::JoinHandle<()>>,
    _election: std::fs::File,
}

fn service_lease_path(config: &LaunchConfig) -> PathBuf {
    config
        .state_dir
        .join(format!("{}.lock", service_filename(&config.channel)))
}

impl ManagedLaunch {
    async fn admit(config: &LaunchConfig) -> Result<Option<Self>, LaunchError> {
        std::fs::create_dir_all(&config.state_dir)?;
        let mut options = std::fs::OpenOptions::new();
        options.create(true).truncate(false).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let election = options.open(service_lease_path(config))?;
        match election.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => {
                return if wait_incumbent(config).await {
                    Ok(None)
                } else {
                    Err(LaunchError::Message(
                        "Managed service owner could not be authenticated".into(),
                    ))
                };
            }
            Err(error) => return Err(message(error)),
        }
        match incumbent(config).await {
            Incumbent::Compatible => return Ok(None),
            Incumbent::Foreign => {
                return Err(LaunchError::Message(
                    "Managed service owner could not be authenticated".into(),
                ));
            }
            Incumbent::Unclaimed => {}
        }
        let listener = match bind(config).await {
            Ok(listener) => listener,
            Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
                if matches!(incumbent(config).await, Incumbent::Compatible) {
                    return Ok(None);
                }
                return Err(LaunchError::Message(format!(
                    "Managed service port {} on {} is already in use by another process. Set `port` in {} under the YCoding config directory, or start with `--standalone`.",
                    config.port.unwrap_or_default(),
                    config.hostname,
                    service_filename(&config.channel),
                )));
            }
            Err(error) => return Err(error.into()),
        };
        let identity = process_identity(config)?;
        let signals = shutdown_signals()?;
        let stop = Arc::new(Notify::new());
        let control = crate::health::Control::install(true, &identity, stop.clone())?;
        let (server, state) = server::serve_managed(
            listener,
            identity.clone(),
            LocalAuth::with_password(config.password.clone()),
            config.cors.clone(),
        )
        .await?;
        let url = format!("http://{}", server.address());
        let registration = (if config.password_generated {
            persist_service_password(config)
        } else {
            Ok(())
        })
        .and_then(|()| Registration::write(config, &identity, &url));
        let registration = match registration {
            Ok(registration) => registration,
            Err(error) => {
                let stopping = state.stopping().map_err(LaunchError::from);
                let closed = server.shutdown().await.map_err(LaunchError::from);
                return launch_results([Err(error), stopping, closed]).map(|()| None);
            }
        };
        let watcher = spawn_registration_watch(registration.clone(), stop.clone());
        let (halted, stopped) = tokio::sync::watch::channel(false);
        let signal_state = state.clone();
        let signal_stop = stop.clone();
        let signals = tokio::spawn(async move {
            wait_for_shutdown(Mode::Service, signal_stop, signals).await;
            let result = signal_state.stopping();
            let _ = halted.send(true);
            result
        });
        Ok(Some(Self {
            identity,
            state,
            server: Some(server),
            registration,
            control: Some(control),
            stop,
            stopped,
            signals: Some(signals),
            watcher: Some(watcher),
            _election: election,
        }))
    }

    fn record_failure(
        &self,
        config: &LaunchConfig,
        error: &LaunchError,
    ) -> Result<(), LaunchError> {
        if self.registration.owns()
            && let Some(file) = &config.startup_error_file
        {
            write_private(file, error.to_string().as_bytes())?;
        }
        Ok(())
    }

    async fn wait(&self) -> Result<(), LaunchError> {
        let mut stopped = self.stopped.clone();
        stopped
            .wait_for(|stopped| *stopped)
            .await
            .map(|_| ())
            .map_err(|_| LaunchError::Message("managed shutdown listener closed".into()))
    }

    async fn failure(
        &mut self,
        config: &LaunchConfig,
        error: LaunchError,
    ) -> Result<(), LaunchError> {
        let recorded = self.record_failure(config, &error);
        let published = self.state.failed().map_err(LaunchError::from);
        let stopped = if published.is_ok() {
            self.wait().await
        } else {
            Ok(())
        };
        let closed = self.close_http().await;
        launch_results([Err(error), recorded, published, stopped, closed])
    }

    async fn serve(
        &mut self,
        config: &LaunchConfig,
        services: Services,
    ) -> Result<(), LaunchError> {
        if *self.stopped.borrow() {
            return self.close_http().await;
        }
        let url = format!(
            "http://{}",
            self.server
                .as_ref()
                .ok_or_else(|| LaunchError::Message("managed listener already closed".into()))?
                .address()
        );
        let mut announced = Ok(());
        let mut installed = false;
        if let Err(error) = self.state.ready(services.clone(), || {
            use std::io::Write as _;
            installed = true;
            let mut stdout = std::io::stdout();
            announced = writeln!(stdout, "server listening on {url}").and_then(|()| stdout.flush());
        }) {
            return self.failure(config, error.into()).await;
        }
        if let Err(error) = announced {
            let local = self.close_http().await;
            return launch_results([Err(error.into()), local]);
        }
        if !installed || *self.stopped.borrow() {
            return self.close_http().await;
        }
        let connector = match start_connector(&services, &url) {
            Ok(connector) => connector,
            Err(error) => return self.failure(config, error).await,
        };
        let stopped = self.wait().await;
        let remote = stop_connector(connector).await;
        let local = self.close_http().await;
        launch_results([stopped, remote, local])
    }

    async fn close_http(&mut self) -> Result<(), LaunchError> {
        let stopping = self.state.stopping().map_err(LaunchError::from);
        let closed = match self.server.take() {
            Some(server) => server.shutdown().await.map_err(LaunchError::from),
            None => Ok(()),
        };
        launch_results([stopping, closed])
    }

    async fn finish(&mut self) -> Result<(), LaunchError> {
        self.stop.notify_one();
        let signals = match self.signals.take() {
            Some(signals) => match signals.await {
                Ok(result) => result.map_err(LaunchError::from),
                Err(error) => Err(io::Error::other(error).into()),
            },
            None => Ok(()),
        };
        let watcher = match self.watcher.take() {
            Some(watcher) => {
                watcher.abort();
                match watcher.await {
                    Ok(()) => Ok(()),
                    Err(error) if error.is_cancelled() => Ok(()),
                    Err(error) => Err(io::Error::other(error).into()),
                }
            }
            None => Ok(()),
        };
        drop(self.control.take());
        let local = self.close_http().await;
        let registration = self.registration.remove_if_owned();
        launch_results([signals, watcher, local, registration])
    }
}

fn launch_results(
    results: impl IntoIterator<Item = Result<(), LaunchError>>,
) -> Result<(), LaunchError> {
    let mut errors = results.into_iter().filter_map(Result::err);
    let Some(first) = errors.next() else {
        return Ok(());
    };
    let later = errors.collect::<Vec<_>>();
    if later.is_empty() {
        return Err(first);
    }
    Err(LaunchError::Shutdown {
        first: Box::new(first),
        later,
    })
}

fn followed_by(first: LaunchError, later: Result<(), LaunchError>) -> LaunchError {
    match later {
        Ok(()) => first,
        Err(later) => LaunchError::Shutdown {
            first: Box::new(first),
            later: vec![later],
        },
    }
}

async fn serve_until_stopped(config: &LaunchConfig, services: Services) -> Result<(), LaunchError> {
    let identity = services.identity.clone();
    let listener = bind(config).await?;
    let signals = shutdown_signals()?;
    let stop = Arc::new(Notify::new());
    let control = crate::health::Control::install(false, &identity, stop.clone())?;
    let url = format!("http://{}", listener.local_addr()?);
    let server = server::serve(listener, services.clone()).await?;

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
    if let Err(error) = std::io::stdout().flush() {
        let local = server.shutdown().await.map_err(LaunchError::from);
        return launch_results([Err(error.into()), local]);
    }

    let shutdown = wait_for_shutdown(config.mode, stop, signals);
    tokio::pin!(shutdown);
    let started = tokio::select! {
        biased;
        _ = &mut shutdown => {
            drop(control);
            return server.shutdown().await.map_err(LaunchError::from);
        }
        result = async { start_connector(&services, &url) } => result,
    };
    let connector = match started {
        Ok(connector) => connector,
        Err(error) => {
            let local = server.shutdown().await.map_err(LaunchError::from);
            return launch_results([Err(error), local]);
        }
    };

    shutdown.await;
    drop(control);
    let remote = stop_connector(connector).await;
    let local = server.shutdown().await.map_err(LaunchError::from);
    launch_results([remote, local])
}

fn start_connector(
    services: &Services,
    url: &str,
) -> Result<Option<crate::connector::Connector>, LaunchError> {
    let Some(control) = services.core.as_ref().and_then(|core| core.remote.clone()) else {
        return Ok(None);
    };
    let dispatcher = Arc::new(
        crate::handlers::standard()
            .map_err(|_| LaunchError::Message("remote dispatcher unavailable".into()))?,
    );
    let environment = Arc::new(crate::services::Environment {
        services: services.clone(),
        urls: vec![url.into()],
        subscriptions: Default::default(),
        uploads: Default::default(),
    });
    crate::connector::Connector::start(
        control.clone(),
        crate::connector::Settings::new(Arc::new(control.device().clone())),
        environment,
        dispatcher,
    )
    .map(Some)
    .map_err(|_| LaunchError::Message("remote connector unavailable".into()))
}

async fn stop_connector(connector: Option<crate::connector::Connector>) -> Result<(), LaunchError> {
    match connector {
        Some(connector) => connector
            .shutdown()
            .await
            .map_err(|_| LaunchError::Message("remote connector shutdown failed".into())),
        None => Ok(()),
    }
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
        let registration = Self { file, info };
        if let Err(error) = write_private(&registration.file, contents.as_bytes()) {
            return Err(followed_by(error.into(), registration.remove_if_owned()));
        }
        Ok(registration)
    }

    fn remove_if_owned(&self) -> Result<(), LaunchError> {
        if self.owns() {
            match std::fs::remove_file(&self.file) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
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

enum Incumbent {
    Compatible,
    Unclaimed,
    Foreign,
}

enum HealthProbe {
    Native(Identity),
    Unclaimed,
    Foreign,
}

async fn wait_incumbent(config: &LaunchConfig) -> bool {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            match incumbent(config).await {
                Incumbent::Compatible => return true,
                Incumbent::Foreign => return false,
                Incumbent::Unclaimed => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        }
    })
    .await
    .unwrap_or(false)
}

async fn incumbent(config: &LaunchConfig) -> Incumbent {
    let file = config.state_dir.join(service_filename(&config.channel));
    let registration = match std::fs::read_to_string(&file) {
        Ok(contents) => match parse_json(&contents) {
            Ok(registration) => registration,
            Err(_) => return Incumbent::Foreign,
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Incumbent::Unclaimed,
        Err(_) => return Incumbent::Foreign,
    };
    let (Some(password), Some(url)) = (
        json_string(&registration, "password"),
        json_string(&registration, "url"),
    ) else {
        return Incumbent::Foreign;
    };
    let Ok(url) = url::Url::parse(&url) else {
        return Incumbent::Foreign;
    };
    if url.scheme() != "http"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Incumbent::Foreign;
    }
    let ip = match url.host() {
        Some(url::Host::Ipv4(ip)) => std::net::IpAddr::V4(ip),
        Some(url::Host::Ipv6(ip)) => std::net::IpAddr::V6(ip),
        _ => return Incumbent::Foreign,
    };
    let Some(port) = url.port_or_known_default() else {
        return Incumbent::Foreign;
    };
    let address = std::net::SocketAddr::new(ip, port);
    let expected = tokio::time::timeout(
        Duration::from_secs(2),
        tokio::net::lookup_host((config.hostname.as_str(), port)),
    )
    .await;
    let matches_host = match expected {
        Ok(Ok(mut addresses)) => addresses.any(|candidate| candidate == address),
        _ => false,
    };
    if !matches_host {
        return Incumbent::Foreign;
    }
    let health = match probe_health(address, &password).await {
        HealthProbe::Unclaimed => return Incumbent::Unclaimed,
        HealthProbe::Foreign => return Incumbent::Foreign,
        HealthProbe::Native(health) => health,
    };
    if json_u64(&registration, "pid") == Some(health.pid)
        && health.pid != 0
        && json_string(&registration, "version").as_deref() == Some(health.version.as_str())
        && health.version == config.version
        && json_string(&registration, "id").as_deref() == Some(health.source_epoch.as_str())
        && !health.source_epoch.is_empty()
        && (config.password_generated || password == config.password)
        && config
            .port
            .is_none_or(|expected| expected == 0 || expected == port)
        && read_json_file(&file).as_ref() == Some(&registration)
    {
        Incumbent::Compatible
    } else {
        Incumbent::Foreign
    }
}

async fn probe_health(address: std::net::SocketAddr, password: &str) -> HealthProbe {
    tokio::time::timeout(Duration::from_secs(2), async {
        let stream = match TcpStream::connect(address).await {
            Ok(stream) => stream,
            Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => {
                return HealthProbe::Unclaimed;
            }
            Err(_) => return HealthProbe::Foreign,
        };
        match read_health(stream, address, password).await {
            Some(identity) => HealthProbe::Native(identity),
            None => HealthProbe::Foreign,
        }
    })
    .await
    .unwrap_or(HealthProbe::Foreign)
}

async fn read_health(
    mut stream: TcpStream,
    address: std::net::SocketAddr,
    password: &str,
) -> Option<Identity> {
    let request = format!(
        "GET /api/health HTTP/1.1\r\nHost: {address}\r\nAuthorization: Basic {}\r\nConnection: close\r\n\r\n",
        encode_base64(format!("ycoding:{password}").as_bytes())
    );
    stream.write_all(request.as_bytes()).await.ok()?;
    let mut response = Vec::new();
    stream.take(65_537).read_to_end(&mut response).await.ok()?;
    if response.len() > 65_536 {
        return None;
    }
    let text = std::str::from_utf8(&response).ok()?;
    let (headers, body) = text.split_once("\r\n\r\n")?;
    let status = headers.split_whitespace().nth(1)?.parse::<u16>().ok()?;
    if !matches!(status, 200 | 500 | 503) {
        return None;
    }
    let value = parse_json(body).ok()?;
    let JsonValue::Object(object) = &value else {
        return None;
    };
    if object.get(&"healthy".into()) != Some(&JsonValue::Bool(true)) {
        return None;
    }
    Some(Identity {
        pid: json_u64(&value, "pid")?,
        version: json_string(&value, "version")?,
        source_epoch: json_string(&value, "sourceEpoch")?,
    })
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

fn prepare_store(config: &LaunchConfig) -> Result<(), BootFailure> {
    let Storage::File(storage) = &config.storage else {
        return Ok(());
    };
    if storage.file.try_exists()? {
        ycoding_core::ycoding_store::upgrade::core(
            &storage.file,
            Options::core(),
            ycoding_core::session::history_pruning::free_bytes,
        )
        .map_err(|error| {
            tracing::error!(%error, "Store upgrade failed");
            BootFailure::Refused(unsupported_store())
        })?;
    }
    Ok(())
}

fn open_store(config: &LaunchConfig) -> Result<Store, BootFailure> {
    let catalog = native::catalog(native::DatabaseKind::Core);
    let Storage::File(storage) = &config.storage else {
        return Store::disposable(Options::core(), catalog, metadata()?)
            .map_err(|error| BootFailure::Retained(message(error)));
    };
    if storage.file.try_exists()? {
        return Store::open(&storage.file, Options::core(), catalog).map_err(|error| {
            tracing::error!(%error, "Store open failed");
            BootFailure::Refused(unsupported_store())
        });
    }
    let store =
        Store::initialize(&storage.file, Options::core(), catalog, metadata()?).map_err(message)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(error) =
            std::fs::set_permissions(&storage.file, std::fs::Permissions::from_mode(0o600))
        {
            return Err(BootFailure::Retained(followed_by(
                error.into(),
                store.shutdown().map_err(message),
            )));
        }
    }
    Ok(store)
}

fn unsupported_store() -> LaunchError {
    LaunchError::Message(
        "The YCoding data store is unreadable or uses an unsupported format, or its upgrade could not be completed. Existing store files and backups were retained; inspect them before starting again.".into(),
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

fn select_storage(
    channel: &str,
    roots: &config::Roots,
    database: Option<&str>,
    selector: bool,
) -> Result<Storage, LaunchError> {
    let mut slot = slot_storage(channel, roots, selector);
    let Some(database) = database else {
        return Ok(Storage::File(slot));
    };
    if database == ":memory:" {
        return Ok(Storage::Memory {
            analytics: roots.tmp.join(format!("analytics-{}", source_epoch()?)),
        });
    }
    let requested = roots.data.join(database);
    if resolve(&requested) == resolve(&slot.file) {
        return Ok(Storage::File(slot));
    }
    slot.lease = companion(&requested, ".runtime.lock");
    slot.analytics = companion(&requested, ".analytics");
    slot.file = requested;
    slot.slot = false;
    Ok(Storage::File(slot))
}

fn slot_storage(channel: &str, roots: &config::Roots, selector: bool) -> FileStorage {
    let suffix = if channel == "beta" || matches!(channel, "latest" | "prod") || selector {
        String::new()
    } else {
        format!("-{}", sanitize(channel))
    };
    FileStorage {
        file: roots.data.join(if suffix.is_empty() && channel != "beta" {
            "core.redb".to_owned()
        } else {
            format!("ycoding{suffix}.redb")
        }),
        lease: roots.data.join(format!("runtime{suffix}.lock")),
        analytics: roots.data.join(format!("analytics{suffix}")),
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
                    "the target is a SQLite database and was left unchanged; name a new native store file instead",
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
    use super::{LaunchError, Parsed, parse_launch, production_environment};

    #[test]
    fn composition_error_reports_the_stage_without_internal_details() {
        let failure = crate::production::bootstrap_failure(
            crate::Failure::Unavailable("shell ledger unavailable".into()),
            Err(crate::Failure::Unavailable(
                "synthetic private details".into(),
            )),
        );
        assert_eq!(
            LaunchError::Production(failure).to_string(),
            "production composition failed: shell ledger"
        );
        let failure = crate::Failure::Unavailable("synthetic private contents unavailable".into());
        assert_eq!(
            LaunchError::Production(failure).to_string(),
            "production composition failed: production"
        );
        let failure = crate::production::bootstrap_failure(
            crate::Failure::ServiceUnavailable {
                service: crate::production::TELEMETRY_PRUNING,
                message: "storage request queue full".into(),
            },
            Err(crate::Failure::Unavailable(
                "synthetic private details".into(),
            )),
        );
        assert_eq!(
            LaunchError::Production(failure).to_string(),
            "production composition failed: telemetry pruning: storage request queue full"
        );
    }

    #[test]
    fn shutdown_errors_retain_the_owner_report_and_later_host_failures() {
        let report = crate::Report::library(Err(ycoding_core::cca::error::ExecutorError::new(
            -32603,
            "synthetic cleanup",
        )));
        let error = super::launch_results([
            Err(LaunchError::Message("first host failure".into())),
            Err(LaunchError::Owner(report.clone())),
            Err(LaunchError::Message("last host failure".into())),
        ])
        .unwrap_err();
        let LaunchError::Shutdown { first, later } = error else {
            panic!("expected complete shutdown report")
        };
        assert_eq!(first.to_string(), "first host failure");
        assert!(matches!(&later[0], LaunchError::Owner(actual) if actual == &report));
        assert_eq!(later[1].to_string(), "last host failure");
        assert_eq!(later[0].to_string(), "production owner shutdown failed");
    }

    #[test]
    fn production_environment_retains_only_explicit_frontend_metadata() {
        let home = std::env::temp_dir().join("ycoding-frontend-rebuild");
        let executable = home.join("node").to_string_lossy().into_owned();
        let Parsed::Run(config) = parse_launch(
            &["--frontend-executable".into(), executable.clone()],
            |key| (key == "HOME").then(|| home.to_string_lossy().into_owned()),
        )
        .unwrap() else {
            panic!("expected launch configuration")
        };
        let inherited = || {
            [
                (
                    "YCODING_FRONTEND_EXECUTABLE".into(),
                    "untrusted-executable".into(),
                ),
                (
                    "YCODING_FRONTEND_ARGUMENTS".into(),
                    "untrusted-arguments".into(),
                ),
                ("YCODING_PASSWORD".into(), "synthetic-password".into()),
                (
                    "YCODING_SERVER_PASSWORD".into(),
                    "synthetic-password".into(),
                ),
                ("PATH".into(), "synthetic-path".into()),
            ]
            .into_iter()
        };
        let rebuilt = production_environment(&config, inherited());
        assert_eq!(
            rebuilt.get("YCODING_FRONTEND_EXECUTABLE"),
            Some(&executable)
        );
        assert!(!rebuilt.contains_key("YCODING_FRONTEND_ARGUMENTS"));
        assert!(!rebuilt.contains_key("YCODING_PASSWORD"));
        assert!(!rebuilt.contains_key("YCODING_SERVER_PASSWORD"));
        let Parsed::Run(empty) = parse_launch(&[], |key| {
            (key == "HOME").then(|| home.to_string_lossy().into_owned())
        })
        .unwrap() else {
            panic!("expected launch configuration")
        };
        assert_eq!(
            production_environment(&empty, inherited()),
            std::collections::BTreeMap::from([("PATH".into(), "synthetic-path".into())])
        );
    }

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
