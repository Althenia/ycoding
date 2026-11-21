use super::{
    error::{BoxFuture, DecisionBy, DecisionKind, DecisionReply, DecisionTrace},
    policy::SEP,
    value::{concat, os_text},
};
use crate::{platform::diff, session::projector};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, oneshot};
use ycoding_schema::{JsonValue, LosslessString, ObjectEncoder, session};
use ycoding_store::session::NewEvent;

pub const OUTPUT_CAP_BYTES: usize = 1024 * 1024;
pub const CONTENT_CAP_BYTES: usize = 1024 * 1024;

pub trait ProcessRecording: Send + Sync {
    fn output(&self, chunk: &[u8]);
    fn ended(&self, exit_code: Option<i64>, sandbox_denied: bool);
}
#[derive(Clone, Debug)]
pub struct ProcessRecord {
    pub process_id: LosslessString,
    pub command: LosslessString,
    pub shell: String,
    pub cwd: String,
    pub thread_id: Option<LosslessString>,
    pub tool_call_id: Option<LosslessString>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteOperation {
    Write,
    CreateDirectory,
    Remove,
    Copy,
}
#[derive(Clone, Debug)]
pub struct WriteRecord {
    pub operation: WriteOperation,
    pub path: String,
    pub destination: Option<String>,
    pub bytes: Option<u64>,
    pub before: Option<Vec<u8>>,
    pub after: Option<Vec<u8>>,
}
pub trait Recorder: Send + Sync {
    fn process(&self, input: ProcessRecord) -> Arc<dyn ProcessRecording>;
    fn read(&self, path: &str, bytes: u64);
    fn write(&self, input: WriteRecord);
    fn http(&self, method: &LosslessString, url: &LosslessString, status: Option<u16>, bytes: u64);
    fn denied(&self, action: &str, subject: &LosslessString, trace: &DecisionTrace);
    fn flush(&self) -> BoxFuture<'static, ()>;
}

pub type CommandHook = Arc<dyn Fn(LosslessString) -> BoxFuture<'static, ()> + Send + Sync>;

pub(crate) struct TranscriptOptions {
    pub session_id: session::Id,
    pub store: crate::session::store::Service,
    pub directory: Arc<dyn Fn() -> String + Send + Sync>,
    pub shell_directory: Arc<dyn Fn() -> PathBuf + Send + Sync>,
    pub command: Option<CommandHook>,
    pub record_reads: bool,
}

enum Job {
    Run(BoxFuture<'static, ()>),
    Flush(oneshot::Sender<()>),
}

pub(crate) struct SessionTranscript {
    options: TranscriptOptions,
    queue: mpsc::UnboundedSender<Job>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}
fn inside(directory: &str, target: &str) -> Option<String> {
    let prefix = if directory.ends_with(SEP) {
        directory.to_owned()
    } else {
        format!("{directory}{SEP}")
    };
    let relative = target.strip_prefix(&prefix)?;
    (!relative.is_empty() && relative != ".." && !relative.starts_with(&format!("..{SEP}")))
        .then(|| relative.to_owned())
}

impl SessionTranscript {
    pub(crate) fn new(options: TranscriptOptions) -> Arc<Self> {
        let (queue, mut jobs) = mpsc::unbounded_channel::<Job>();
        tokio::spawn(async move {
            while let Some(job) = jobs.recv().await {
                match job {
                    Job::Run(work) => work.await,
                    Job::Flush(done) => {
                        let _ = done.send(());
                    }
                }
            }
        });
        Arc::new(Self { options, queue })
    }

    fn enqueue(&self, work: impl std::future::Future<Output = ()> + Send + 'static) {
        let _ = self.queue.send(Job::Run(Box::pin(work)));
    }

    fn publish(&self, type_: &'static str, data: JsonValue) -> BoxFuture<'static, ()> {
        let store = self.options.store.clone();
        let aggregate = self.options.session_id.as_lossless().clone();
        Box::pin(async move {
            let id = match projector::random_event_id() {
                Ok(id) => id.as_lossless().clone(),
                Err(error) => {
                    tracing::warn!(%error, "CCA transcript recording failed");
                    return;
                }
            };
            let event = NewEvent {
                id,
                aggregate_id: aggregate,
                created: now_ms(),
                type_: type_.into(),
                data,
            };
            if let Err(error) = store.publish(event).await {
                tracing::warn!(%error, "CCA transcript recording failed");
            }
        })
    }

    fn synthetic(&self, text: LosslessString, dots: JsonValue) {
        let metadata = ObjectEncoder::new().field("dots", &dots).finish();
        let data = ObjectEncoder::new()
            .field("sessionID", &self.options.session_id)
            .field("text", &text)
            .field("description", &text)
            .field("metadata", &metadata)
            .finish();
        let work = self.publish("session.synthetic.1", data);
        self.enqueue(work);
    }

    fn shown(&self, target: &str) -> String {
        inside(&(self.options.directory)(), target).unwrap_or_else(|| target.to_owned())
    }

    fn file_change(
        &self,
        target: &str,
        before: Option<&[u8]>,
        after: Option<&[u8]>,
    ) -> Option<JsonValue> {
        let (before, after) = (before?, after?);
        if before.len() > CONTENT_CAP_BYTES
            || after.len() > CONTENT_CAP_BYTES
            || before.contains(&0)
            || after.contains(&0)
        {
            return None;
        }
        let relative = inside(&(self.options.directory)(), target)?;
        let previous = String::from_utf8_lossy(before).into_owned();
        let next = String::from_utf8_lossy(after).into_owned();
        let parts = diff::diff_lines(&previous, &next);
        let additions: usize = parts
            .iter()
            .filter(|part| part.added)
            .map(|part| part.count)
            .sum();
        let deletions: usize = parts
            .iter()
            .filter(|part| part.removed)
            .map(|part| part.count)
            .sum();
        let portable = relative.split(SEP).collect::<Vec<_>>().join("/");
        let patch = diff::create_two_files_patch(&relative, &relative, &previous, &next);
        Some(
            ObjectEncoder::new()
                .field("path", portable.as_str())
                .field("patch", patch.as_str())
                .field("additions", &(additions as f64))
                .field("deletions", &(deletions as f64))
                .finish(),
        )
    }
}

struct Recording {
    transcript: Arc<SessionTranscript>,
    info: ShellInfoParts,
    state: Mutex<RecordingState>,
}
struct ShellInfoParts {
    id: String,
    command: LosslessString,
    cwd: String,
    shell: String,
    file: PathBuf,
    started: i64,
    thread_id: Option<LosslessString>,
    tool_call_id: Option<LosslessString>,
    process_id: LosslessString,
}
#[derive(Default)]
struct RecordingState {
    captured: Vec<u8>,
    total: usize,
    ended: bool,
}

fn dots_metadata(parts: &ShellInfoParts, sandbox_denied: Option<bool>) -> JsonValue {
    let dots = ObjectEncoder::new()
        .optional("threadId", &parts.thread_id)
        .optional("toolCallId", &parts.tool_call_id)
        .field("processId", &parts.process_id)
        .field("cwd", parts.cwd.as_str());
    let dots = match sandbox_denied {
        Some(flag) => dots.field("sandboxDenied", &flag),
        None => dots,
    };
    ObjectEncoder::new().field("dots", &dots.finish()).finish()
}
fn shell_info(parts: &ShellInfoParts, exited: Option<(Option<i64>, bool)>) -> JsonValue {
    let encoder = ObjectEncoder::new()
        .field("id", parts.id.as_str())
        .field(
            "status",
            if exited.is_some() {
                "exited"
            } else {
                "running"
            },
        )
        .field("command", &parts.command)
        .field("cwd", parts.cwd.as_str())
        .field("shell", parts.shell.as_str())
        .field("file", &*parts.file.to_string_lossy());
    let exit = exited.and_then(|(code, _)| code).map(|code| code as f64);
    let encoder = encoder.optional("exit", &exit).field(
        "metadata",
        &dots_metadata(parts, exited.map(|(_, denied)| denied)),
    );
    let time = match exited {
        Some(_) => ObjectEncoder::new()
            .field("started", &(parts.started as f64))
            .field("completed", &(now_ms() as f64))
            .finish(),
        None => ObjectEncoder::new()
            .field("started", &(parts.started as f64))
            .finish(),
    };
    encoder.field("time", &time).finish()
}

impl ProcessRecording for Recording {
    fn output(&self, chunk: &[u8]) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.ended {
            return;
        }
        state.total += chunk.len();
        let room = OUTPUT_CAP_BYTES.saturating_sub(state.captured.len());
        if room == 0 {
            return;
        }
        let kept = &chunk[..chunk.len().min(room)];
        state.captured.extend_from_slice(kept);
    }
    fn ended(&self, exit_code: Option<i64>, sandbox_denied: bool) {
        let (output, total) = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            if state.ended {
                return;
            }
            state.ended = true;
            (state.captured.clone(), state.total)
        };
        let file = self.info.file.clone();
        let text = String::from_utf8_lossy(&output).into_owned();
        let info = shell_info(&self.info, Some((exit_code, sandbox_denied)));
        let data = ObjectEncoder::new()
            .field("sessionID", &self.transcript.options.session_id)
            .field("shell", &info)
            .field(
                "output",
                &ObjectEncoder::new()
                    .field("output", text.as_str())
                    .field("cursor", &(output.len() as f64))
                    .field("size", &(output.len() as f64))
                    .field("truncated", &(total > output.len()))
                    .finish(),
            )
            .finish();
        let publish = self.transcript.publish("session.shell.ended.1", data);
        self.transcript.enqueue(async move {
            if let Err(error) = tokio::fs::write(&file, &output).await {
                tracing::warn!(%error, "CCA transcript recording failed");
            }
            publish.await;
        });
    }
}

impl Recorder for Arc<SessionTranscript> {
    fn process(&self, input: ProcessRecord) -> Arc<dyn ProcessRecording> {
        let id = crate::platform::identifier("sh_")
            .unwrap_or_else(|_| format!("sh_{}", super::encoding::random_hex(12)));
        let file = (self.options.shell_directory)().join(format!("{id}.out"));
        let parts = ShellInfoParts {
            id,
            command: input.command.clone(),
            cwd: input.cwd,
            shell: input.shell,
            file: file.clone(),
            started: now_ms(),
            thread_id: input.thread_id,
            tool_call_id: input.tool_call_id,
            process_id: input.process_id,
        };
        let started = ObjectEncoder::new()
            .field("sessionID", &self.options.session_id)
            .field("shell", &shell_info(&parts, None))
            .finish();
        let publish = self.publish("session.shell.started.1", started);
        let hook = self.options.command.clone().map(|hook| hook(input.command));
        self.enqueue(async move {
            let prepared = async {
                if let Some(parent) = file.parent() {
                    tokio::fs::create_dir_all(parent).await?;
                }
                tokio::fs::write(&file, b"").await
            }
            .await;
            if let Err(error) = prepared {
                tracing::warn!(%error, "CCA transcript recording failed");
            }
            publish.await;
            if let Some(hook) = hook {
                hook.await;
            }
        });
        Arc::new(Recording {
            transcript: self.clone(),
            info: parts,
            state: Mutex::new(RecordingState::default()),
        })
    }

    fn read(&self, path: &str, bytes: u64) {
        if !self.options.record_reads {
            return;
        }
        let dots = ObjectEncoder::new()
            .field("operation", "read")
            .field("path", path)
            .field("bytes", &(bytes as f64))
            .finish();
        self.synthetic(
            format!("Read {bytes} bytes from {}", self.shown(path)).into(),
            dots,
        );
    }

    fn write(&self, input: WriteRecord) {
        let target = self.shown(&input.path);
        let text = match input.operation {
            WriteOperation::Write => {
                format!("Wrote {} bytes to {target}", input.bytes.unwrap_or(0))
            }
            WriteOperation::CreateDirectory => format!("Created directory {target}"),
            WriteOperation::Remove => format!("Removed {target}"),
            WriteOperation::Copy => format!(
                "Copied {target} to {}",
                self.shown(input.destination.as_deref().unwrap_or(""))
            ),
        };
        let operation = match input.operation {
            WriteOperation::Write => "write",
            WriteOperation::CreateDirectory => "createDirectory",
            WriteOperation::Remove => "remove",
            WriteOperation::Copy => "copy",
        };
        let destination = input.destination.as_deref().map(LosslessString::from);
        let bytes = input.bytes.map(|bytes| bytes as f64);
        let dots = ObjectEncoder::new()
            .field("operation", operation)
            .field("path", input.path.as_str())
            .optional("destination", &destination)
            .optional("bytes", &bytes)
            .finish();
        self.synthetic(text.into(), dots);
        if let Some(change) =
            self.file_change(&input.path, input.before.as_deref(), input.after.as_deref())
        {
            let data = ObjectEncoder::new()
                .field("sessionID", &self.options.session_id)
                .field("change", &change)
                .finish();
            let work = self.publish("session.file-change.recorded.1", data);
            self.enqueue(work);
        }
    }

    fn http(&self, method: &LosslessString, url: &LosslessString, status: Option<u16>, bytes: u64) {
        let parsed = url::Url::parse(&os_text(url)).ok();
        let origin = parsed
            .as_ref()
            .map(|url| url.origin().ascii_serialization())
            .unwrap_or_default();
        let origin = if origin == "null" {
            String::new()
        } else {
            origin
        };
        let pathname = parsed
            .as_ref()
            .map(|url| url.path().to_owned())
            .unwrap_or_default();
        let outcome = match status {
            None => "failed".to_owned(),
            Some(status) => format!("{status} ({bytes} bytes)"),
        };
        let status_value = status.map(|status| status as f64);
        let dots = ObjectEncoder::new()
            .field("operation", "http")
            .field("method", method)
            .field("origin", origin.as_str())
            .field("path", pathname.as_str())
            .optional("status", &status_value)
            .field("bytes", &(bytes as f64))
            .finish();
        self.synthetic(
            concat(&[
                &"HTTP ".into(),
                method,
                &format!(" {origin}{pathname} → {outcome}").into(),
            ]),
            dots,
        );
    }

    fn denied(&self, action: &str, subject: &LosslessString, trace: &DecisionTrace) {
        let steps = trace
            .iter()
            .map(|step| {
                let request = step.request_id.as_deref().map(LosslessString::from);
                ObjectEncoder::new()
                    .field(
                        "kind",
                        match step.kind {
                            DecisionKind::Permission => "permission",
                            DecisionKind::Guardrail => "guardrail",
                        },
                    )
                    .optional("requestID", &request)
                    .field(
                        "reply",
                        match step.reply {
                            DecisionReply::Allow => "allow",
                            DecisionReply::Once => "once",
                            DecisionReply::Always => "always",
                            DecisionReply::Reject => "reject",
                            DecisionReply::Expired => "expired",
                        },
                    )
                    .field(
                        "by",
                        match step.by {
                            DecisionBy::Rule => "rule",
                            DecisionBy::User => "user",
                            DecisionBy::Auto => "auto",
                            DecisionBy::Yolo => "yolo",
                            DecisionBy::Expired => "expired",
                        },
                    )
                    .finish()
            })
            .collect::<Vec<_>>();
        let dots = ObjectEncoder::new()
            .field("operation", "denied")
            .field("action", action)
            .field("subject", subject)
            .field("trace", &JsonValue::Array(steps))
            .finish();
        let clipped = LosslessString::from_utf16(subject.code_units().take(200).collect());
        self.synthetic(
            concat(&[&format!("Denied {action} ").into(), &clipped]),
            dots,
        );
    }

    fn flush(&self) -> BoxFuture<'static, ()> {
        let (done, wait) = oneshot::channel();
        let queued = self.queue.send(Job::Flush(done)).is_ok();
        Box::pin(async move {
            if queued {
                let _ = wait.await;
            }
        })
    }
}
