use super::{
    filesystem::{Paths, object, optional_number, path_text, utf8},
    native::definition,
};
use crate::{
    job,
    platform::{self, filesystem},
    resources::config::Configuration,
    tools::{
        context::{Context, Progress, policy::LeafPolicy},
        registry::{Failure, Tool, ToolFuture},
    },
};
use std::{
    collections::HashMap,
    future::Future,
    io,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex, Weak},
    task::Poll,
    time::Duration,
};
use tokio::{
    sync::{Notify, oneshot},
    time::MissedTickBehavior,
};
use ycoding_ai::llm::{ToolDefinition, ToolOutput};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder,
    llm::{ToolContent, ToolTextContent},
    schema::Finite,
    session_delivery::Delivery,
    session_id::SessionId,
    session_pending,
    shell::{CreateInput, Id, MAX_MEMORY_LIMIT_MB, Status},
};

pub const MAX_TIMEOUT_MS: u64 = 60 * 60 * 1000;
pub const DEFAULT_TIMEOUT_MS: u64 = 10 * 60 * 1000;
pub const AUTO_BACKGROUND: Duration = Duration::from_secs(5 * 60);
pub const MAX_CAPTURE_BYTES: usize = 1024 * 1024;

const BACKGROUND_STARTED: &str = "The command was moved to the background.";
const BACKGROUND_INSTRUCTION: &str = "You will be notified automatically when the command finishes. DO NOT sleep, poll, or proactively check on its progress.";
const AUTO_BACKGROUND_STEER: &str = "The foreground shell exceeded 300 seconds and was moved to the background. Continue without waiting; completion will be delivered automatically.";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Job {
    pub session_id: SessionId,
    pub call_id: String,
    pub command: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Notice {
    Steer {
        session_id: SessionId,
        text: String,
    },
    Completed {
        job: Job,
        shell_id: String,
        state: &'static str,
        text: String,
        resume: bool,
    },
}

pub type Lease = Box<dyn Send + Sync>;
pub type NoticeFuture = Pin<Box<dyn Future<Output = io::Result<()>> + Send>>;

pub trait Jobs: Send + Sync {
    fn foreground(&self, job: &Job, background: Arc<Notify>) -> Lease;
    fn background(&self, job: &Job) -> Lease;
    fn deliver(&self, notice: Notice) -> NoticeFuture;
}

pub type Deliver = Arc<dyn Fn(SessionId, session_pending::Message) -> NoticeFuture + Send + Sync>;

pub struct JobShells {
    jobs: job::Jobs,
    deliver: Deliver,
    quiet: Option<Deliver>,
    holds: Mutex<HashMap<String, Weak<Hold>>>,
}

struct Hold {
    _released: oneshot::Sender<()>,
}

impl JobShells {
    pub fn new(jobs: job::Jobs, deliver: Deliver) -> Self {
        Self {
            jobs,
            deliver,
            quiet: None,
            holds: Mutex::default(),
        }
    }

    pub fn with_quiet_delivery(mut self, deliver: Deliver) -> Self {
        self.quiet = Some(deliver);
        self
    }

    fn hold(&self, job: &Job) -> Arc<Hold> {
        let mut holds = self
            .holds
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        holds.retain(|_, hold| hold.strong_count() > 0);
        if let Some(hold) = holds.get(&job.call_id).and_then(Weak::upgrade) {
            return hold;
        }
        let (released, done) = oneshot::channel::<()>();
        let hold = Arc::new(Hold {
            _released: released,
        });
        holds.insert(job.call_id.clone(), Arc::downgrade(&hold));
        self.jobs
            .start(job::StartInput {
                id: Some(job.call_id.clone()),
                kind: "shell".into(),
                title: Some(job.command.clone()),
                metadata: Some(serde_json::Map::from_iter([(
                    "sessionID".into(),
                    job.session_id
                        .as_lossless()
                        .to_utf8()
                        .unwrap_or_default()
                        .into(),
                )])),
                run: Box::pin(async move {
                    let _ = done.await;
                    Ok(String::new())
                }),
            })
            .expect("a job with an explicit identifier starts without generating one");
        hold
    }
}

impl Jobs for JobShells {
    fn foreground(&self, job: &Job, background: Arc<Notify>) -> Lease {
        let hold = self.hold(job);
        let jobs = self.jobs.clone();
        let input = job::BlockInput {
            id: job.call_id.clone(),
            session_id: job.session_id.clone(),
            background_after: None,
        };
        let mut blocked = Box::pin(async move { jobs.block(input).await });
        match blocked
            .as_mut()
            .poll(&mut std::task::Context::from_waker(std::task::Waker::noop()))
        {
            Poll::Ready(result) => signal(result, &background),
            Poll::Pending => {
                tokio::spawn(async move { signal(blocked.await, &background) });
            }
        }
        Box::new(hold)
    }

    fn background(&self, job: &Job) -> Lease {
        let hold = self.hold(job);
        self.jobs.background(&job.call_id);
        Box::new(hold)
    }

    fn deliver(&self, notice: Notice) -> NoticeFuture {
        let (session_id, text, description, metadata, admitted, resume) = match notice {
            Notice::Steer { session_id, text } => (session_id, text, None, None, None, true),
            Notice::Completed {
                job,
                state,
                text,
                resume,
                ..
            } => {
                if state == "cancelled" {
                    self.jobs.mark_cancelled(&job.call_id);
                }
                (
                    job.session_id,
                    format!(
                        "<shell id=\"{}\" state=\"{state}\" command=\"{}\">\n{text}\n</shell>",
                        job.call_id, job.command
                    ),
                    Some(job.command),
                    Some(
                        ObjectEncoder::new()
                            .field("source", "shell")
                            .field("state", state)
                            .finish(),
                    ),
                    Some(job.call_id),
                    resume,
                )
            }
        };
        let deliver = match (&self.quiet, resume) {
            (Some(quiet), false) => quiet,
            _ => &self.deliver,
        };
        let delivered = deliver(
            session_id,
            session_pending::Message::Synthetic(session_pending::SyntheticMessage {
                data: session_pending::SyntheticData {
                    text: text.into(),
                    description: description.map(Into::into),
                    metadata: match metadata {
                        Some(JsonValue::Object(metadata)) => Some(metadata),
                        _ => None,
                    },
                },
                delivery: Delivery::Steer,
            }),
        );
        let jobs = self.jobs.clone();
        Box::pin(async move {
            let delivered = delivered.await;
            if delivered
                .as_ref()
                .err()
                .is_none_or(|error| error.kind() == io::ErrorKind::NotFound)
                && let Some(id) = admitted
            {
                jobs.notice_admitted(&id);
            }
            delivered
        })
    }
}

fn signal(result: Option<job::BlockResult>, background: &Notify) {
    if let Some(job::BlockResult::Backgrounded { .. }) = result {
        background.notify_one();
    }
}

pub struct ShellTool {
    pub shell: Arc<platform::shell::Shell>,
    pub configuration: Arc<Configuration>,
    pub paths: Arc<Paths>,
    pub policy: Arc<LeafPolicy>,
    pub jobs: Arc<dyn Jobs>,
    pub auto_background: Duration,
}

impl Tool for ShellTool {
    fn definition(&self, name: &str) -> ToolDefinition {
        Self::tool_definition(name)
    }
    fn permission(&self) -> Option<&str> {
        Some("shell")
    }
    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move { self.run(parse(&input)?, context).await })
    }
}

impl ShellTool {
    pub fn tool_definition(name: &str) -> ToolDefinition {
        definition(name, include_str!("shell.tool.json"))
    }
}

struct Input {
    command: String,
    workdir: Option<String>,
    timeout: Option<u64>,
    memory_limit_mb: Option<u64>,
    background: bool,
}

struct Outcome {
    output: String,
    exit: Option<Finite>,
    shell_id: Option<LosslessString>,
    truncated: bool,
    timeout: bool,
    memory_limit: bool,
    running: bool,
    killed: bool,
    warnings: Vec<String>,
}

enum Exit {
    Settled(io::Result<()>),
    Signal,
    Deadline,
    Cancelled,
}

impl ShellTool {
    async fn run(&self, input: Input, context: Context) -> Result<ToolOutput, Failure> {
        let command = input.command.clone();
        let unable = |failure: Failure| match failure {
            Failure::Tool { .. } => {
                Failure::message(format!("Unable to execute command: {command}"))
            }
            other => other,
        };
        let generic = || Failure::message(format!("Unable to execute command: {command}"));
        let job = Job {
            session_id: context.session_id.clone(),
            call_id: context
                .call_id
                .to_utf8()
                .map_err(|_| Failure::message("Invalid tool call identity"))?,
            command: command.clone(),
        };
        let target = self
            .paths
            .resolve(input.workdir.as_deref().unwrap_or("."), true)
            .map_err(|_| generic())?;
        let cwd = target.mutation.canonical.clone();
        let timeout = match input.timeout {
            None | Some(0) => DEFAULT_TIMEOUT_MS,
            Some(timeout) => timeout,
        };
        let mut prepared = self
            .shell
            .prepare(
                create_input(&input, &cwd, timeout, &context).map_err(|_| generic())?,
                &self.configuration,
            )
            .map_err(|error| prepare_failure(error, &command))?;
        target
            .authorize_external(&self.policy, &context)
            .await
            .map_err(&unable)?;
        let mut warnings = prepared.warnings.clone();
        warnings.extend(self.external_directories(&command, &cwd).iter().map(|directory| {
            format!(
                "Command argument references external directory {}/*. Shell runs with host-user filesystem, process, and network authority; this scan is advisory only.",
                path_text(directory).replace('\\', "/")
            )
        }));
        self.policy
            .assert(
                &context,
                "shell",
                vec![command.clone().into()],
                vec![command.clone().into()],
                None,
            )
            .await
            .map_err(&unable)?;
        if !std::fs::metadata(&cwd).is_ok_and(|metadata| metadata.is_dir()) {
            return Err(generic());
        }
        let metadata = match ObjectEncoder::new()
            .field("workdir", path_text(&cwd).as_str())
            .finish()
        {
            JsonValue::Object(metadata) => Some(metadata),
            _ => unreachable!(),
        };
        let admitted = self
            .policy
            .admit(
                &context,
                "shell",
                vec![command.clone().into()],
                metadata,
                false,
            )
            .await?;
        let reservation =
            admitted.map_err(|error| {
                Failure::message(error.capacity_message().unwrap_or_else(|| {
                    format!("Session guardrail rejected shell command: {command}")
                }))
            })?;
        let info = self
            .shell
            .create(&mut prepared)
            .await
            .map_err(|_| generic())?;
        let id = info.id.clone();
        self.shell
            .retain_until_exit(&id, reservation)
            .map_err(|_| generic())?;
        let Ok(file) = info.file.to_utf8() else {
            let _ = self.shell.remove(&id).await;
            return Err(generic());
        };
        let memory_limit_mb = prepared.memory_limit_mb;
        let watch = Watch {
            id: id.clone(),
            file,
            timeout,
            memory_limit_mb,
        };
        if input.background {
            return self
                .detach(job, watch, warnings)
                .await
                .map_err(|_| generic());
        }

        let background = Arc::new(Notify::new());
        let _lease = self.jobs.foreground(&job, background.clone());
        let waiting = self.shell.wait(&id);
        tokio::pin!(waiting);
        let has_deadline = Duration::from_millis(timeout) > self.auto_background;
        let deadline = tokio::time::sleep(self.auto_background);
        tokio::pin!(deadline);
        let mut ticker = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(1),
            Duration::from_secs(1),
        );
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let exit = loop {
            tokio::select! {
                settled = &mut waiting => break Exit::Settled(settled.map(drop)),
                () = context.cancellation.cancelled() => break Exit::Cancelled,
                () = background.notified() => break Exit::Signal,
                () = &mut deadline, if has_deadline => break Exit::Deadline,
                _ = ticker.tick() => {
                    if let Ok((text, truncated)) = capture(&self.shell, &id, &watch.file).await {
                        context.report(progress(text, truncated)).await;
                    }
                }
            }
        };
        match exit {
            Exit::Cancelled => {
                let _ = self.shell.remove(&id).await;
                Err(Failure::Cancelled)
            }
            Exit::Settled(Err(_)) => Err(generic()),
            Exit::Settled(Ok(_)) => {
                let mut outcome = settle_shell(&self.shell, &watch)
                    .await
                    .map_err(|_| generic())?;
                outcome.warnings = warnings;
                Ok(outcome.into_output())
            }
            Exit::Signal | Exit::Deadline => {
                let steer = matches!(exit, Exit::Deadline);
                let detached = self.detach(job.clone(), watch, warnings).await;
                if steer {
                    self.jobs
                        .deliver(Notice::Steer {
                            session_id: job.session_id,
                            text: AUTO_BACKGROUND_STEER.into(),
                        })
                        .await
                        .map_err(|_| generic())?;
                }
                detached.map_err(|_| generic())
            }
        }
    }

    async fn detach(
        &self,
        job: Job,
        watch: Watch,
        warnings: Vec<String>,
    ) -> io::Result<ToolOutput> {
        let started = Outcome {
            output: BACKGROUND_STARTED.into(),
            exit: None,
            shell_id: Some(id_text(&watch.id).into()),
            truncated: false,
            timeout: false,
            memory_limit: false,
            running: true,
            killed: false,
            warnings,
        };
        if let Err(error) = self
            .shell
            .notice_owed(&watch.id, job.session_id.clone())
            .await
        {
            let _ = self.shell.remove(&watch.id).await;
            return Err(error);
        }
        let lease = self.jobs.background(&job);
        let shell = self.shell.clone();
        let jobs = self.jobs.clone();
        tokio::spawn(async move {
            let settled = settle_shell(&shell, &watch).await;
            let (state, text) = match settled {
                Ok(outcome) if outcome.killed => ("cancelled", "Command cancelled".into()),
                Ok(outcome) => ("completed", outcome.output),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    ("cancelled", "Command cancelled".into())
                }
                Err(error) => ("error", error.to_string()),
            };
            let delivered = jobs
                .deliver(Notice::Completed {
                    job,
                    shell_id: id_text(&watch.id),
                    state,
                    text,
                    resume: true,
                })
                .await;
            if delivered
                .as_ref()
                .err()
                .is_none_or(|error| error.kind() == io::ErrorKind::NotFound)
            {
                let _ = shell.notice_admitted(&watch.id).await;
            }
            drop(lease);
        });
        Ok(started.into_output())
    }

    fn external_directories(&self, command: &str, cwd: &Path) -> Vec<PathBuf> {
        let mut directories = Vec::new();
        for token in tokens(command) {
            let value = unquote(token).trim_end_matches([';', ',', '|', '&']);
            if !Path::new(value).is_absolute() {
                continue;
            }
            let Ok(target) = self.paths.resolve(value, false) else {
                continue;
            };
            let resolved = target.mutation.canonical;
            if filesystem::contains(cwd, &resolved) {
                continue;
            }
            if let Some(directory) = resolved.parent()
                && !directories.iter().any(|known| known == directory)
            {
                directories.push(directory.to_path_buf());
            }
        }
        directories
    }
}

struct Watch {
    id: Id,
    file: String,
    timeout: u64,
    memory_limit_mb: Option<u64>,
}

impl Outcome {
    fn into_output(self) -> ToolOutput {
        let warnings = if self.warnings.is_empty() {
            String::new()
        } else {
            format!(
                "Warnings:\n{}\n\n",
                self.warnings
                    .iter()
                    .map(|warning| format!("- {warning}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        };
        let model = if self.running {
            BACKGROUND_INSTRUCTION.to_owned()
        } else if self.timeout {
            "Command timed out before completion.".to_owned()
        } else if self.memory_limit {
            "Command exceeded its memory limit before completion.".to_owned()
        } else if let Some(exit) = self.exit {
            format!("Command exited with code {}.", exit.get())
        } else {
            "Command was terminated before it exited.".to_owned()
        };
        ToolOutput {
            structured: ObjectEncoder::new()
                .field("truncated", &self.truncated)
                .optional("exit", &self.exit)
                .optional("shellID", &self.shell_id)
                .optional("timeout", &self.timeout.then_some(true))
                .optional("memoryLimit", &self.memory_limit.then_some(true))
                .finish(),
            content: vec![
                ToolContent::Text(ToolTextContent {
                    text: self.output.into(),
                }),
                ToolContent::Text(ToolTextContent {
                    text: format!("{warnings}{model}").into(),
                }),
            ],
        }
    }
}

fn parse(input: &JsonValue) -> Result<Input, Failure> {
    let object = object(input)?;
    Ok(Input {
        command: utf8(object, "command")?,
        workdir: match object.get(&"workdir".into()) {
            None => None,
            Some(JsonValue::String(_)) => Some(utf8(object, "workdir")?),
            Some(_) => {
                return Err(Failure::message(
                    "Invalid tool input: Expected string at workdir",
                ));
            }
        },
        timeout: optional_number(object, "timeout", 0.0, MAX_TIMEOUT_MS as f64)?
            .map(|value| value as u64),
        memory_limit_mb: optional_number(
            object,
            "memory_limit_mb",
            0.0,
            MAX_MEMORY_LIMIT_MB as f64,
        )?
        .map(|value| value as u64),
        background: match object.get(&"background".into()) {
            None => false,
            Some(JsonValue::Bool(value)) => *value,
            Some(_) => return Err(Failure::message("Invalid tool input: Invalid background")),
        },
    })
}

fn create_input(
    input: &Input,
    cwd: &Path,
    timeout: u64,
    context: &Context,
) -> Result<CreateInput, ycoding_schema::DecodeError> {
    let mut encoder = ObjectEncoder::new()
        .field("command", input.command.as_str())
        .field("cwd", path_text(cwd).as_str())
        .field("timeout", &(timeout as f64));
    if let Some(memory) = input.memory_limit_mb {
        encoder = encoder.field("memoryLimitMb", &(memory as f64));
    }
    CreateInput::decode(
        &encoder
            .field(
                "metadata",
                &ObjectEncoder::new()
                    .field("sessionID", &context.session_id)
                    .field("toolCallID", &context.call_id)
                    .finish(),
            )
            .finish(),
    )
}

fn prepare_failure(error: io::Error, command: &str) -> Failure {
    if error.kind() != io::ErrorKind::Unsupported {
        return Failure::message(format!("Unable to execute command: {command}"));
    }
    Failure::message(if error.to_string().contains("sandbox") {
        "Shell sandboxing is required, but no enforceable backend is available.".to_owned()
    } else {
        error.to_string()
    })
}

fn id_text(id: &Id) -> String {
    match id.encode() {
        JsonValue::String(text) => text.to_utf8().unwrap_or_default(),
        _ => unreachable!("shell identifiers encode as strings"),
    }
}

async fn capture(
    shell: &platform::shell::Shell,
    id: &Id,
    file: &str,
) -> io::Result<(String, bool)> {
    let page = shell.output(id, 0, MAX_CAPTURE_BYTES).await?;
    let truncated = page.size > page.cursor;
    let notice = if truncated {
        format!("\n\n[output truncated; full output saved to: {file}]")
    } else {
        String::new()
    };
    let output = if page.output.is_empty() {
        "(no output)"
    } else {
        page.output.as_str()
    };
    Ok((format!("{output}{notice}"), truncated))
}

fn progress(text: String, truncated: bool) -> Progress {
    Progress {
        structured: match ObjectEncoder::new().field("truncated", &truncated).finish() {
            JsonValue::Object(structured) => structured,
            _ => unreachable!(),
        },
        content: vec![ToolContent::Text(ToolTextContent { text: text.into() })],
    }
}

async fn settle_shell(shell: &platform::shell::Shell, watch: &Watch) -> io::Result<Outcome> {
    let settled = shell.wait(&watch.id).await?;
    let outcome = |output: String, truncated: bool| Outcome {
        output,
        exit: settled.exit,
        shell_id: None,
        truncated,
        timeout: false,
        memory_limit: false,
        running: false,
        killed: settled.status == Status::Killed,
        warnings: Vec::new(),
    };
    match settled.status {
        Status::Timeout => Ok(Outcome {
            timeout: true,
            ..outcome(
                format!(
                    "Command exceeded timeout of {} ms. Retry with a larger timeout if the command is expected to take longer.",
                    watch.timeout
                ),
                false,
            )
        }),
        Status::MemoryLimit => Ok(Outcome {
            memory_limit: true,
            exit: None,
            ..outcome(
                format!(
                    "Command was terminated by the {} MiB memory limit.",
                    watch.memory_limit_mb.unwrap_or_default()
                ),
                false,
            )
        }),
        _ => {
            let (output, truncated) = capture(shell, &watch.id, &watch.file).await?;
            Ok(outcome(output, truncated))
        }
    }
}

fn tokens(command: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let mut start = None;
    let mut index = 0;
    while let Some(character) = command[index..].chars().next() {
        let width = character.len_utf8();
        if character.is_whitespace() {
            if let Some(begin) = start.take() {
                tokens.push(&command[begin..index]);
            }
        } else if matches!(character, '"' | '\'') {
            match command[index + width..].find(character) {
                Some(closing) => {
                    start.get_or_insert(index);
                    index += closing + 2 * width;
                    continue;
                }
                None => {
                    if let Some(begin) = start.take() {
                        tokens.push(&command[begin..index]);
                    }
                }
            }
        } else {
            start.get_or_insert(index);
        }
        index += width;
    }
    if let Some(begin) = start {
        tokens.push(&command[begin..]);
    }
    tokens
}

fn unquote(token: &str) -> &str {
    let mut characters = token.chars();
    match (characters.next(), characters.next_back()) {
        (Some(first @ ('"' | '\'')), Some(last)) if first == last => {
            &token[first.len_utf8()..token.len() - last.len_utf8()]
        }
        _ => token,
    }
}
