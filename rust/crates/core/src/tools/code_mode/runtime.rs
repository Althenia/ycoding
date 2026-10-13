use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Notify;
use ycoding_schema::{JsonValue, LosslessString};

use super::{Diagnostic, DiagnosticKind, Position, Program};

pub type Collation = dyn Fn(&[u16], &[u16]) -> std::cmp::Ordering + Send + Sync;

#[derive(Clone, Default)]
pub struct Cancellation(Arc<CancellationState>);

#[derive(Default)]
struct CancellationState {
    cancelled: AtomicBool,
    notification: Notify,
}

impl Cancellation {
    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::Release);
        self.0.notification.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::Acquire)
    }

    pub async fn cancelled(&self) {
        loop {
            let notification = self.0.notification.notified();
            tokio::pin!(notification);
            notification.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notification.await;
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ExecutionLimits {
    pub timeout_ms: Option<u64>,
    pub max_tool_calls: Option<u64>,
    pub max_output_bytes: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolDescription {
    pub path: LosslessString,
    pub description: String,
    pub signature: String,
    pub input_properties: Vec<(LosslessString, Option<String>)>,
}

impl ToolDescription {
    pub fn from_schemas(
        path: LosslessString,
        description: String,
        input: &JsonValue,
        output: Option<&JsonValue>,
    ) -> Self {
        Self {
            signature: format!(
                "{}(input: {}): Promise<{}>",
                super::stdlib::discovery::expression(&path),
                super::schema::to_typescript(input, true),
                output
                    .map(|output| super::schema::to_typescript(output, true))
                    .unwrap_or_else(|| "unknown".into())
            ),
            input_properties: super::schema::properties(input),
            path,
            description,
        }
    }
}

#[derive(Clone, Debug)]
pub enum ToolFailure {
    Safe(String),
    Internal,
    InvalidInput(String),
    InvalidOutput,
    Cancelled,
}

pub type ToolFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Option<JsonValue>, ToolFailure>> + Send + 'a>>;
pub type ToolHookFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

#[derive(Clone, Debug, PartialEq)]
pub struct ToolCallStarted {
    pub index: usize,
    pub name: LosslessString,
    pub input: Option<JsonValue>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToolCallOutcome {
    Success,
    Failure(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolCallEnded {
    pub call: ToolCallStarted,
    pub duration_ms: u64,
    pub outcome: ToolCallOutcome,
}

pub trait ToolHost: Send + Sync {
    fn catalog(&self) -> Vec<ToolDescription>;
    fn decode_input(
        &self,
        path: &LosslessString,
        input: Option<JsonValue>,
    ) -> Result<Option<JsonValue>, ToolFailure>;
    fn invoke(
        &self,
        path: LosslessString,
        input: Option<JsonValue>,
        cancellation: Cancellation,
    ) -> ToolFuture<'_>;
    fn decode_output(
        &self,
        path: &LosslessString,
        output: Option<JsonValue>,
    ) -> Result<Option<JsonValue>, ToolFailure>;
    fn on_tool_call_start(&self, _: ToolCallStarted) -> ToolHookFuture<'_> {
        Box::pin(async {})
    }
    fn on_tool_call_end(&self, _: ToolCallEnded) -> ToolHookFuture<'_> {
        Box::pin(async {})
    }
}

#[derive(Clone, Debug)]
pub struct ExecutionResult {
    pub value: Result<JsonValue, Vec<Diagnostic>>,
    pub warnings: Vec<Diagnostic>,
    pub logs: Vec<LosslessString>,
    pub tool_calls: Vec<LosslessString>,
    pub truncated: bool,
}

pub struct Runtime {
    pub(crate) host: Arc<dyn ToolHost>,
    pub(crate) limits: ExecutionLimits,
    pub(crate) regexp: Arc<dyn super::regexp::RegExpEngine>,
    pub(crate) collator: Arc<Collation>,
}

impl Runtime {
    pub fn with_default_collation(
        host: Arc<dyn ToolHost>,
        limits: ExecutionLimits,
        regexp: Arc<dyn super::regexp::RegExpEngine>,
    ) -> Result<Self, String> {
        Self::new(
            host,
            limits,
            regexp,
            Arc::new(crate::platform::filesystem::collation::compare),
        )
    }
    pub fn catalog(&self) -> Vec<ToolDescription> {
        super::stdlib::discovery::catalog(self.host.catalog())
    }

    pub fn instructions(&self, catalog_budget: Option<usize>) -> Result<String, String> {
        let budget = catalog_budget.unwrap_or(2000);
        if budget as u64 > 9_007_199_254_740_991 {
            return Err("discovery.catalogBudget must be a non-negative safe integer".into());
        }
        Ok(super::stdlib::discovery::instructions(
            self.host.catalog(),
            budget,
            self.collator.as_ref(),
        ))
    }
    pub fn new(
        host: Arc<dyn ToolHost>,
        limits: ExecutionLimits,
        regexp: Arc<dyn super::regexp::RegExpEngine>,
        collator: Arc<Collation>,
    ) -> Result<Self, String> {
        if host.catalog().iter().any(|tool| {
            super::stdlib::discovery::segments(&tool.path)
                .iter()
                .any(LosslessString::is_empty)
        }) {
            return Err("Tool names cannot contain an empty segment.".into());
        }
        for (name, value, minimum) in [
            ("timeoutMs", limits.timeout_ms, 1),
            ("maxToolCalls", limits.max_tool_calls, 0),
            (
                "maxOutputBytes",
                limits.max_output_bytes.map(|value| value as u64),
                0,
            ),
        ] {
            if value.is_some_and(|value| value < minimum || value > 9_007_199_254_740_991) {
                return Err(format!(
                    "{name} must be a safe integer greater than or equal to {minimum}."
                ));
            }
        }
        Ok(Self {
            host,
            limits,
            regexp,
            collator,
        })
    }

    pub async fn execute(
        &self,
        source: impl Into<LosslessString>,
        cancellation: Cancellation,
    ) -> ExecutionResult {
        let source = source.into();
        let started = std::time::Instant::now();
        let program = if source.is_empty()
            || source.code_units().all(|unit| {
                char::from_u32(unit as u32).is_some_and(super::stdlib::string::whitespace)
            }) {
            Err(vec![Diagnostic {
                kind: DiagnosticKind::ParseError,
                message: "Code cannot be empty.".into(),
                location: Position {
                    index: 0,
                    line: 1,
                    column: 0,
                },
            }])
        } else {
            Program::parse(source)
        };
        let program = match program {
            Ok(program) => program,
            Err(errors) => {
                return ExecutionResult {
                    value: Err(errors),
                    warnings: Vec::new(),
                    logs: Vec::new(),
                    tool_calls: Vec::new(),
                    truncated: false,
                };
            }
        };
        let mut vm = super::evaluator::Vm::new(
            self.host.clone(),
            self.limits.clone(),
            cancellation.clone(),
            self.regexp.clone(),
            self.collator.clone(),
        );
        vm.started = started;
        let owner = ExecutionOwner(vm.clone());
        let execution = vm.clone();
        let main = vm.spawn(Box::pin(async move { execution.run(&program.body).await }));
        vm.observe(&main);
        let super::values::Value::Promise(id) = main else {
            unreachable!("An execution task always creates a promise")
        };
        let result = async {
            tokio::select! {result=vm.drive(id)=>result,_=cancellation.cancelled()=>Err(vm.interrupted(&vm.origin))}
        };
        let result = if let Some(timeout) = self.limits.timeout_ms {
            match tokio::time::timeout_at(
                tokio::time::Instant::from_std(started + std::time::Duration::from_millis(timeout)),
                result,
            )
            .await
            {
                Ok(result) => result,
                Err(_) => Err(super::values::Fault {
                    kind: DiagnosticKind::TimeoutExceeded,
                    fatal: true,
                    ..super::values::Fault::error(
                        "Error",
                        format!("Execution timed out after {timeout}ms."),
                        &vm.origin,
                    )
                }),
            }
        } else {
            result.await
        };
        let value = result
            .and_then(|value| {
                vm.state()
                    .json(&value, false)
                    .map(|value| value.unwrap_or(JsonValue::Null))
            })
            .map_err(|fault| vec![fault.diagnostic()]);
        let cleanup = vm.cleanup();
        let cleanup_timeout = if let Some(timeout) = self.limits.timeout_ms {
            tokio::time::timeout_at(
                tokio::time::Instant::from_std(started + std::time::Duration::from_millis(timeout)),
                cleanup,
            )
            .await
            .is_err()
        } else {
            cleanup.await;
            false
        };
        let state = vm.state();
        let mut warnings = state
            .promises
            .iter()
            .filter(|promise| !promise.observed)
            .filter_map(|promise| match &promise.result {
                Some(Err(fault)) if !fault.fatal => {
                    let mut diagnostic = fault.diagnostic();
                    diagnostic.message = format!(
                        "Unhandled rejection from an un-awaited promise: {}",
                        diagnostic.message
                    );
                    Some(diagnostic)
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        if cleanup_timeout && value.is_ok() {
            warnings.insert(0,Diagnostic {kind:DiagnosticKind::TimeoutExceeded,message:format!("The program returned, but background work was still running at the {}ms timeout and was interrupted. Await all started promises.",self.limits.timeout_ms.unwrap_or_default()),location:vm.origin.clone()});
        }
        let output = ExecutionResult {
            value,
            warnings,
            logs: state.logs.clone(),
            tool_calls: state.calls.clone(),
            truncated: false,
        };
        drop(state);
        drop(owner);
        match self.limits.max_output_bytes {
            Some(limit) => bound_output(output, limit),
            None => output,
        }
    }
}

struct ExecutionOwner(super::evaluator::Vm);

impl Drop for ExecutionOwner {
    fn drop(&mut self) {
        self.0.work_cancel.cancel();
        let mut jobs = self
            .0
            .jobs
            .lock()
            .expect("Code Mode reaction queue poisoned");
        jobs.tasks.clear();
        jobs.ready.clear();
        jobs.driver = None;
    }
}

fn utf8_prefix(text: &str, limit: usize) -> &str {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1
    }
    &text[..end]
}

fn bound_output(mut output: ExecutionResult, limit: usize) -> ExecutionResult {
    let mut value_bytes = 0;
    if let Ok(value) = &output.value {
        let text = ycoding_schema::stringify_json(value);
        value_bytes = text.len().min(limit);
        if text.len() > limit {
            output.truncated = true;
            output.value=Ok(JsonValue::String(format!("{} [result truncated: {} bytes exceeds the {limit}-byte output limit; return a smaller value]",utf8_prefix(&text,limit),text.len()).into()));
        }
    }
    let mut warning_bytes = 0;
    let count = output.warnings.len();
    let mut kept = Vec::new();
    for warning in output.warnings {
        let mut object = ycoding_schema::JsonObject::new();
        object.insert(
            "kind".into(),
            JsonValue::String(format!("{:?}", warning.kind).into()),
        );
        object.insert(
            "message".into(),
            JsonValue::String(warning.message.clone().into()),
        );
        let bytes = ycoding_schema::stringify_json(&JsonValue::Object(object)).len() + 1;
        if warning_bytes + bytes > limit {
            break;
        }
        warning_bytes += bytes;
        kept.push(warning);
    }
    if kept.len() < count {
        output.truncated = true;
        kept.push(Diagnostic {
            kind: DiagnosticKind::Truncated,
            message: format!(
                "{} additional warnings omitted by the output limit.",
                count - kept.len()
            ),
            location: Position {
                index: 0,
                line: 1,
                column: 0,
            },
        });
    }
    output.warnings = kept;
    let budget = limit.saturating_sub(value_bytes);
    let mut log_bytes = 0;
    let count = output.logs.len();
    let mut logs = Vec::new();
    for line in output.logs {
        let bytes = String::from_utf16_lossy(&line.code_units().collect::<Vec<_>>()).len() + 1;
        if log_bytes + bytes > budget {
            break;
        }
        log_bytes += bytes;
        logs.push(line);
    }
    if logs.len() < count {
        output.truncated = true;
        logs.push(format!("[logs truncated: showing {} of {count} lines]", logs.len()).into());
    }
    output.logs = logs;
    output
}
