use super::BoxFuture;
use super::ask::Questions;
use super::bridge::{Bridge, CallbackFailed, CaptureMessage, Handlers, Options, ViewAssets};
use super::config::MeetingConfig;
use super::discovery::{Descriptor, RuntimeLock, publish_descriptor, remove_descriptor};
use super::history;
use super::intelligence::{Generate, Mcp, from_generator};
use super::runtime::{
    HEARTBEAT_TIMEOUT, MeetingRuntime, ProviderFactory, RuntimeOptions, SessionFactory,
};
use super::store::MeetingDatabase;
use crate::session::analysis::{Analysis, Generator};
use crate::tools::registry::{Registration, RegistrationError, Registry};
use serde_json::{Value, json};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::watch;
use tokio::task::JoinHandle;

const SETTINGS: &str = "settings.json";
const DATABASE: &str = "meetings.redb";
const MAX_ERROR_UNITS: usize = 300;
pub const EXPIRY_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceError(pub String);

impl fmt::Display for ServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ServiceError {}

fn failed(error: impl fmt::Display) -> ServiceError {
    ServiceError(error.to_string())
}

pub struct ServiceOptions {
    pub directory: PathBuf,
    pub config: MeetingConfig,
    pub create_session: SessionFactory,
    pub provider_factory: Option<ProviderFactory>,
    pub generate: Option<Generate>,
    pub generator: Option<Arc<Generator>>,
    pub analysis: Option<Arc<Analysis>>,
    pub mcp: Option<Arc<dyn Mcp>>,
    pub assets: ViewAssets,
    pub heartbeat_timeout: Duration,
    pub expiry_interval: Duration,
}

impl ServiceOptions {
    pub fn new(directory: PathBuf, config: MeetingConfig, create_session: SessionFactory) -> Self {
        Self {
            directory,
            config,
            create_session,
            provider_factory: None,
            generate: None,
            generator: None,
            analysis: None,
            mcp: None,
            assets: ViewAssets::default(),
            heartbeat_timeout: HEARTBEAT_TIMEOUT,
            expiry_interval: EXPIRY_INTERVAL,
        }
    }
}

struct RuntimeHandlers {
    runtime: Arc<MeetingRuntime>,
    questions: Option<Arc<Questions>>,
}

impl Handlers for RuntimeHandlers {
    fn control(&self, input: Value) -> BoxFuture<'_, Result<Value, CallbackFailed>> {
        Box::pin(async move {
            Ok(self
                .runtime
                .control(input)
                .await
                .unwrap_or_else(|error| json!({ "error": truncate(&error.0) })))
        })
    }

    fn capture(&self, input: CaptureMessage) -> BoxFuture<'_, Result<Value, CallbackFailed>> {
        Box::pin(async move {
            self.runtime
                .capture(input)
                .await
                .map_err(|_| CallbackFailed)
        })
    }

    fn view(&self) -> Option<BoxFuture<'_, Result<Value, CallbackFailed>>> {
        Some(Box::pin(async move {
            let view = match &self.questions {
                Some(questions) => questions.state(),
                None => self.runtime.status(None).map_err(|error| error.0),
            };
            view.map_err(|_| CallbackFailed)
        }))
    }

    fn ask(&self, question: String) -> Option<BoxFuture<'_, Result<Value, CallbackFailed>>> {
        let questions = self.questions.clone()?;
        Some(Box::pin(async move { Ok(questions.ask(question).await) }))
    }
}

struct Parts {
    runtime: Arc<MeetingRuntime>,
    questions: Option<Arc<Questions>>,
    bridge: Bridge,
    expiry: JoinHandle<()>,
    stop_expiry: watch::Sender<bool>,
}

pub struct MeetingService {
    runtime: Arc<MeetingRuntime>,
    questions: Option<Arc<Questions>>,
    registrations: Mutex<Vec<Registration>>,
    bridge: Bridge,
    lock: RuntimeLock,
    directory: PathBuf,
    expiry: JoinHandle<()>,
    stop_expiry: watch::Sender<bool>,
}

impl MeetingService {
    pub async fn start(options: ServiceOptions) -> Result<Self, ServiceError> {
        let lock = RuntimeLock::acquire(&options.directory).map_err(failed)?;
        let directory = options.directory.clone();
        match Self::launch(options).await {
            Ok(parts) => Ok(Self {
                runtime: parts.runtime,
                questions: parts.questions,
                registrations: Mutex::new(Vec::new()),
                bridge: parts.bridge,
                lock,
                directory,
                expiry: parts.expiry,
                stop_expiry: parts.stop_expiry,
            }),
            Err(error) => {
                let _ = remove_descriptor(&directory);
                let _ = lock.release();
                Err(error)
            }
        }
    }

    async fn launch(options: ServiceOptions) -> Result<Parts, ServiceError> {
        let config = saved_config(&options.directory, options.config)?;
        let database = MeetingDatabase::open(&options.directory.join(DATABASE)).map_err(failed)?;
        if let Some(analysis) = &options.analysis {
            for meeting in database.list_meetings("", 10_000).map_err(failed)? {
                let Some(session) = meeting["sessionID"].as_str() else {
                    continue;
                };
                let Ok(id) = ycoding_schema::session::Id::new(session) else {
                    continue;
                };
                analysis.register(id);
            }
        }
        let generate = options.generate.clone().or_else(|| {
            options
                .generator
                .as_ref()
                .map(|generator| from_generator(generator.clone()))
        });
        let runtime = match MeetingRuntime::new(RuntimeOptions {
            directory: options.directory.clone(),
            database: database.clone(),
            config,
            create_session: options.create_session,
            provider_factory: options.provider_factory,
            heartbeat_timeout: options.heartbeat_timeout,
            generate: generate.clone(),
            mcp: options.mcp,
        })
        .await
        {
            Ok(runtime) => runtime,
            Err(error) => {
                let _ = database.close().await;
                return Err(failed(error));
            }
        };
        let questions = generate.map(|generate| Questions::new(runtime.clone(), generate));
        let bridge = match start_bridge(
            &runtime,
            questions.clone(),
            options.assets,
            &options.directory,
        )
        .await
        {
            Ok(bridge) => bridge,
            Err(error) => {
                let _ = runtime.close().await;
                return Err(error);
            }
        };
        let (stop_expiry, stopped) = watch::channel(false);
        let expiry = tokio::spawn(expire(runtime.clone(), stopped, options.expiry_interval));
        Ok(Parts {
            runtime,
            questions,
            bridge,
            expiry,
            stop_expiry,
        })
    }

    pub fn runtime(&self) -> &Arc<MeetingRuntime> {
        &self.runtime
    }

    pub fn url(&self) -> &str {
        self.bridge.url()
    }

    pub fn register_history(&self, registry: &Registry) -> Result<(), RegistrationError> {
        let registration = history::register(registry, self.runtime.database().clone())?;
        self.registrations
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(registration);
        Ok(())
    }

    pub async fn shutdown(self) -> Result<(), ServiceError> {
        let _ = self.stop_expiry.send(true);
        let _ = self.expiry.await;
        self.bridge.close().await;
        if let Some(questions) = &self.questions {
            questions.settled().await;
        }
        let closed = self.runtime.close().await.map_err(failed);
        drop(self.registrations);
        let descriptor = match remove_descriptor(&self.directory) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(failed(error)),
            _ => Ok(()),
        };
        let released = self.lock.release().map_err(failed);
        closed.and(descriptor).and(released)
    }
}

async fn start_bridge(
    runtime: &Arc<MeetingRuntime>,
    questions: Option<Arc<Questions>>,
    assets: ViewAssets,
    directory: &Path,
) -> Result<Bridge, ServiceError> {
    let token = crate::platform::random::<32>()
        .map_err(failed)?
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let mut options = Options::new(token.clone());
    options.assets = assets;
    let bridge = Bridge::start(
        options,
        Arc::new(RuntimeHandlers {
            runtime: runtime.clone(),
            questions,
        }),
    )
    .await
    .map_err(failed)?;
    let descriptor = Descriptor {
        url: bridge.url().to_owned(),
        token,
        pid: u64::from(std::process::id()),
    };
    if let Err(error) = publish_descriptor(directory, &descriptor) {
        bridge.close().await;
        return Err(failed(error));
    }
    Ok(bridge)
}

async fn expire(
    runtime: Arc<MeetingRuntime>,
    mut stopped: watch::Receiver<bool>,
    interval: Duration,
) {
    loop {
        let finished = tokio::select! {
            _ = stopped.wait_for(|stopped| *stopped) => true,
            _ = tokio::time::sleep(interval) => false,
        };
        if finished {
            return;
        }
        let _ = runtime.expire_capture(Instant::now()).await;
    }
}

pub fn saved_config(
    directory: &Path,
    fallback: MeetingConfig,
) -> Result<MeetingConfig, ServiceError> {
    match std::fs::read_to_string(directory.join(SETTINGS)) {
        Ok(text) => {
            let value = serde_json::from_str(&text)
                .map_err(|_| ServiceError("Meeting settings are not valid JSON".into()))?;
            MeetingConfig::parse(&value).map_err(failed)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(fallback),
        Err(error) => Err(failed(error)),
    }
}

fn truncate(message: &str) -> String {
    let mut units = 0;
    message
        .chars()
        .take_while(|character| {
            units += character.len_utf16();
            units <= MAX_ERROR_UNITS
        })
        .collect()
}
