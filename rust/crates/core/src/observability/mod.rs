mod config;
mod format;
mod layer;
mod otlp;

use crate::{
    event_feed::{Feed, Payload, Scope, Subscriber},
    resources::config::Roots,
};
use chrono::{SecondsFormat, Utc};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::PathBuf,
    sync::{
        Arc, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
    },
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tracing::Level;
use tracing_subscriber::layer::SubscriberExt;
use ycoding_schema::DomainEncode;

static INSTALLED: AtomicBool = AtomicBool::new(false);

pub struct Options {
    pub log_directory: PathBuf,
    pub version: String,
    pub channel: String,
    pub local: bool,
    pub environment: BTreeMap<String, String>,
    pub events: Option<Feed>,
}

impl Options {
    pub fn new(roots: &Roots, version: &str, channel: &str, local: bool) -> Self {
        Self {
            log_directory: roots.log.clone(),
            version: version.into(),
            channel: channel.into(),
            local,
            environment: std::env::vars().collect(),
            events: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    AlreadyInstalled,
    File,
    Random,
    Worker,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::AlreadyInstalled => "diagnostic subscriber already installed",
            Self::File => "diagnostic file operation failed",
            Self::Random => "diagnostic identity generation failed",
            Self::Worker => "diagnostic worker failed",
        })
    }
}
impl std::error::Error for Error {}

pub struct Guard {
    shared: Arc<Shared>,
    worker: Option<JoinHandle<Result<(), Error>>>,
    attached: bool,
}

pub fn install(options: Options) -> Result<Guard, Error> {
    if INSTALLED
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(Error::AlreadyInstalled);
    }
    let result = start(options);
    if result.is_err() {
        INSTALLED.store(false, Ordering::Release);
    }
    result
}

fn start(options: Options) -> Result<Guard, Error> {
    fs::create_dir_all(&options.log_directory).map_err(|_| Error::File)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&options.log_directory, fs::Permissions::from_mode(0o700))
            .map_err(|_| Error::File)?;
    }
    let mut open = OpenOptions::new();
    open.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open.mode(0o600);
    }
    let file = open.open(config::file(&options)).map_err(|_| Error::File)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| Error::File)?;
    }
    let run = identity::<4>()?;
    let redactor = format::Redactor::new(&options.environment);
    let (sender, receiver) = mpsc::sync_channel(4096);
    let shared = Arc::new(Shared {
        sender: Mutex::new(Some(sender)),
        minimum: config::minimum(
            options
                .environment
                .get("YCODING_LOG_LEVEL")
                .map(String::as_str),
        ),
        redactor,
    });
    let subscriber = options
        .events
        .as_ref()
        .map(|feed| {
            let shared = Arc::downgrade(&shared);
            feed.subscribe(Scope::Global, None, move || {
                if let Some(shared) = shared.upgrade()
                    && let Some(sender) = lock(&shared.sender).as_ref()
                {
                    let _ = sender.try_send(Command::Wake);
                }
            })
            .map_err(|_| Error::Worker)
        })
        .transpose()?;
    let attached = subscriber.is_some();
    let worker_shared = shared.clone();
    let worker = thread::Builder::new()
        .name("ycoding-diagnostics".into())
        .spawn(move || {
            tracing::subscriber::with_default(tracing::subscriber::NoSubscriber::default(), || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|_| Error::Worker)?;
                let mut worker = Worker {
                    file,
                    print: options
                        .environment
                        .get("YCODING_PRINT_LOGS")
                        .is_some_and(|v| v == "1"),
                    run: run.clone(),
                    exporter: otlp::Exporter::new(&options, &run, &worker_shared.redactor),
                    shared: worker_shared,
                    subscriber,
                };
                loop {
                    let command = receiver.recv_timeout(Duration::from_secs(1));
                    match command {
                        Ok(Command::Log(record)) => worker.log(record)?,
                        Ok(Command::Span(span)) => {
                            if let Some(exporter) = &mut worker.exporter {
                                exporter.spans.push(span);
                            }
                        }
                        Ok(Command::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                            worker.events()?;
                            if let Some(exporter) = &mut worker.exporter {
                                runtime.block_on(exporter.flush(true));
                            }
                            worker.file.flush().map_err(|_| Error::File)?;
                            return Ok(());
                        }
                        Ok(Command::Wake) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Ok(Command::Attach(subscriber)) => worker.subscriber = Some(subscriber),
                    }
                    worker.events()?;
                    if let Some(exporter) = &mut worker.exporter {
                        runtime.block_on(exporter.flush(false));
                    }
                }
            })
        })
        .map_err(|_| Error::Worker)?;
    let mut guard = Guard {
        shared: shared.clone(),
        worker: Some(worker),
        attached,
    };
    if tracing::subscriber::set_global_default(
        tracing_subscriber::registry().with(layer::Diagnostics { shared }),
    )
    .is_err()
    {
        guard.close()?;
        return Err(Error::AlreadyInstalled);
    }
    Ok(guard)
}

impl Guard {
    pub fn attach_events(&mut self, feed: Feed) -> Result<(), Error> {
        if self.attached {
            return Err(Error::AlreadyInstalled);
        }
        let shared = Arc::downgrade(&self.shared);
        let subscriber = feed.subscribe(Scope::Global, None, move || {
            if let Some(shared) = shared.upgrade()
                && let Some(sender) = lock(&shared.sender).as_ref()
            {
                let _ = sender.try_send(Command::Wake);
            }
        }).map_err(|_| Error::Worker)?;
        lock(&self.shared.sender).as_ref().ok_or(Error::Worker)?
            .send(Command::Attach(subscriber)).map_err(|_| Error::Worker)?;
        self.attached = true;
        Ok(())
    }
    pub fn close(&mut self) -> Result<(), Error> {
        if let Some(sender) = lock(&self.shared.sender).take() {
            let _ = sender.send(Command::Stop);
        }
        self.worker
            .take()
            .map_or(Ok(()), |worker| worker.join().map_err(|_| Error::Worker)?)
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

struct Shared {
    sender: Mutex<Option<SyncSender<Command>>>,
    minimum: Level,
    redactor: format::Redactor,
}
impl Shared {
    fn send(&self, command: Command) {
        if let Some(sender) = lock(&self.sender).as_ref() {
            let _ = sender.send(command);
        }
    }
}
enum Command {
    Attach(Subscriber),
    Log(Record),
    Span(Value),
    Wake,
    Stop,
}
struct Record {
    level: Level,
    time: SystemTime,
    message: Value,
    fields: Vec<(String, Value)>,
    spans: Vec<(String, u64)>,
    annotations: Vec<(String, Value)>,
    trace: Option<(String, String)>,
}
struct Worker {
    file: File,
    print: bool,
    run: String,
    shared: Arc<Shared>,
    subscriber: Option<Subscriber>,
    exporter: Option<otlp::Exporter>,
}
impl Worker {
    fn log(&mut self, record: Record) -> Result<(), Error> {
        if record.level > self.shared.minimum {
            return Ok(());
        }
        let text = format::record(&record, &self.run);
        self.file
            .write_all(text.as_bytes())
            .map_err(|_| Error::File)?;
        if self.print {
            io::stderr()
                .lock()
                .write_all(text.as_bytes())
                .map_err(|_| Error::File)?;
        }
        if let Some(exporter) = &mut self.exporter {
            exporter.logs.push(otlp::log(record));
        }
        Ok(())
    }
    fn events(&mut self) -> Result<(), Error> {
        loop {
            let Some(subscriber) = &self.subscriber else {
                return Ok(());
            };
            let item = subscriber.next().map_err(|_| Error::Worker)?;
            let Some(item) = item else {
                return Ok(());
            };
            let Payload::Ephemeral(event) = &item.payload else {
                continue;
            };
            if !matches!(
                event.data.name(),
                "agent.updated" | "catalog.updated" | "command.updated" | "config.updated"
            ) {
                continue;
            }
            let data = serde_json::from_str::<Value>(&ycoding_schema::stringify_json(
                &event.data.encode(),
            ))
            .unwrap_or(Value::String("[REDACTED]".into()));
            let event = self.shared.redactor.clean("event", json!({
                "id": event.id.to_utf8().unwrap_or_default(),
                "created": format!("DateTime.Utc({})", chrono::DateTime::<Utc>::from_timestamp_millis(event.created).map(|time|time.to_rfc3339_opts(SecondsFormat::Millis,true)).unwrap_or_default()),
                "type": event.data.name(),
                "data": data,
            }));
            self.log(Record {
                level: Level::INFO,
                time: SystemTime::now(),
                message: json!("event"),
                fields: vec![("event".into(), event)],
                spans: vec![],
                annotations: vec![],
                trace: None,
            })?;
        }
    }
}

fn identity<const N: usize>() -> Result<String, Error> {
    use ring::rand::{SecureRandom, SystemRandom};
    let mut bytes = [0; N];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| Error::Random)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn nanos(time: SystemTime) -> String {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .to_string()
}
fn timestamp(time: SystemTime) -> String {
    chrono::DateTime::<Utc>::from(time).to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
