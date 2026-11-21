use crate::tools::{
    code_mode::{
        self, Cancellation, ToolCallEnded, ToolCallKind, ToolCallOutcome, ToolCallStarted,
        ToolDescription, ToolFailure, ToolHost,
    },
    context::{Context, Progress},
    materialization::Hooks,
    registry::{Entry, Failure, Tool, ToolFuture},
};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use ycoding_ai::llm::{ToolDefinition, ToolOutput};
use ycoding_schema::{
    DomainEncode, JsonValue, LosslessString, ObjectEncoder,
    llm::{ToolContent, ToolTextContent},
    parse_json,
};

pub struct Execute {
    registrations: BTreeMap<String, Entry>,
    collator: Arc<code_mode::Collation>,
    hooks: Arc<Hooks>,
}
impl Execute {
    pub fn new(
        registrations: BTreeMap<String, Entry>,
        collator: Arc<code_mode::Collation>,
    ) -> Self {
        Self {
            registrations,
            collator,
            hooks: Arc::new(Hooks::default()),
        }
    }
    pub(crate) fn with_hooks(mut self, hooks: Arc<Hooks>) -> Self {
        self.hooks = hooks;
        self
    }
}
const DESCRIPTION: &str = "Execute a program in a restricted JavaScript language for calling the current Code Mode tool catalog.\n\nDiscover tools at runtime with `return search({ query: \"<intent + key nouns>\" })`. Search results contain exact callable paths, descriptions, and TypeScript signatures. Copy a returned path exactly in a later execution; do not infer or normalize tool names.\n\nCall tools with `await tools.<namespace>.<tool>(input)` or the exact bracket notation returned by search. Run independent calls with `Promise.all`, await every call whose completion matters, and return only the fields needed from structured results.\n\nThe language supports common JavaScript data operations, functions, control flow, selected standard-library methods, and awaited tool calls. Modules, imports, classes, generators, timers, fetch, eval, prototype access, and unlisted methods are unavailable.\n\nOnly tools returned by runtime search or already known from the same execution context are available. Catalog contents may change without changing this tool definition.";

impl Tool for Execute {
    fn definition(&self, name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.into(), description: DESCRIPTION.into(),
            input_schema: parse_json(r#"{"type":"object","properties":{"code":{"type":"string"}},"required":["code"],"additionalProperties":false}"#).unwrap(),
            output_schema: Some(parse_json(r#"{"type":"object","properties":{"toolCalls":{"type":"array","items":{"type":"object","properties":{"tool":{"type":"string"},"status":{"type":"string","enum":["running","completed","error"]},"id":{"type":"string"},"index":{"type":"number"},"name":{"type":"string"},"input":{},"structured":{}},"required":["tool","status"],"additionalProperties":false}},"error":{"type":"boolean","enum":[true]}},"required":["toolCalls"],"additionalProperties":false}"#).unwrap()),
            cache: None, metadata: None, native: None,
        }
    }
    fn permission(&self) -> Option<&str> {
        None
    }
    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            let JsonValue::Object(input) = input else {
                return Err(Failure::message("Invalid tool input: Expected object"));
            };
            let Some(JsonValue::String(code)) = input.get(&"code".into()) else {
                return Err(Failure::message(
                    "Invalid tool input: Expected string at code",
                ));
            };
            let mut registrations = BTreeMap::<String, (String, Entry)>::new();
            for (name, entry) in &self.registrations {
                let path = match entry.tool.code_path() {
                    Some(path) => path
                        .as_str()
                        .ok_or_else(|| Failure::message("Invalid Code Mode tool path"))?
                        .to_owned(),
                    None => entry.namespace.as_ref().map_or_else(
                        || entry.name.clone(),
                        |namespace| format!("{namespace}.{}", entry.name),
                    ),
                };
                crate::tools::registry::validate_namespace(&path)
                    .map_err(|_| Failure::message("Invalid Code Mode tool path"))?;
                if let Some((existing, _)) = registrations.get(&path) {
                    return Err(Failure::message(format!(
                        "Code Mode path {path} is claimed by both {existing} and {name}"
                    )));
                }
                registrations.insert(path, (name.clone(), entry.clone()));
            }
            let host = Arc::new(Host {
                registrations,
                hooks: self.hooks.clone(),
                context: context.clone(),
                calls: Arc::new(Mutex::new(vec![])),
                progress: Arc::new(tokio::sync::Mutex::new(())),
                invocations: AtomicUsize::new(0),
                receipt_error: Mutex::new(None),
                files: Mutex::new(vec![]),
                searches: Mutex::new(BTreeMap::new()),
            });
            let runtime = code_mode::Runtime::new(
                host.clone(),
                code_mode::ExecutionLimits {
                    max_tool_calls: Some(1000),
                    max_output_bytes: Some(1_048_576),
                    ..Default::default()
                },
                Arc::new(code_mode::regexp::NativeRegExpEngine),
                self.collator.clone(),
            )
            .map_err(Failure::Defect)?
            .with_step_limit(60_000_000);
            let result = runtime.execute(code.clone(), context.cancellation).await;
            if let Some(error) = host
                .receipt_error
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take()
            {
                return Err(Failure::Defect(error));
            }
            let mut structured =
                ObjectEncoder::new().field("toolCalls", &call_list(&host.calls, true));
            let output = match &result.value {
                Ok(JsonValue::String(value)) => value.clone(),
                Ok(value) => pretty(value, 0).into(),
                Err(errors) => {
                    structured = structured.field("error", &true);
                    errors
                        .first()
                        .map(|error| LosslessString::from(error.message.trim()))
                        .unwrap_or_default()
                }
            };
            let warnings = if result.value.is_ok() && !result.warnings.is_empty() {
                Some(format!(
                    "Warnings:\n{}",
                    result
                        .warnings
                        .iter()
                        .map(|item| format!("- [{:?}] {}", item.kind, item.message))
                        .collect::<Vec<_>>()
                        .join("\n")
                ))
            } else {
                None
            };
            let logs = if !result.logs.is_empty() {
                Some(LosslessString::from_utf16(
                    "Logs:\n"
                        .encode_utf16()
                        .chain(join(&result.logs, "\n").code_units())
                        .collect(),
                ))
            } else {
                None
            };
            let output = join(
                &[Some(output), warnings.map(LosslessString::from), logs]
                    .into_iter()
                    .flatten()
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<_>>(),
                "\n\n",
            );
            let mut content = vec![ToolContent::Text(ToolTextContent { text: output })];
            let mut files = host.files.lock().unwrap_or_else(|error| error.into_inner());
            files.sort_by_key(|(index, _)| *index);
            content.extend(files.iter().flat_map(|(_, files)| files.clone()));
            Ok(ToolOutput {
                structured: structured.finish(),
                content,
            })
        })
    }
}

struct Call {
    tool: LosslessString,
    status: &'static str,
    input: Option<JsonValue>,
    id: Option<LosslessString>,
    index: Option<usize>,
    name: Option<String>,
    structured: Option<JsonValue>,
}
struct Host {
    registrations: BTreeMap<String, (String, Entry)>,
    hooks: Arc<Hooks>,
    context: Context,
    calls: Arc<Mutex<Vec<Call>>>,
    progress: Arc<tokio::sync::Mutex<()>>,
    invocations: AtomicUsize,
    receipt_error: Mutex<Option<String>>,
    files: Mutex<Vec<(usize, Vec<ToolContent>)>>,
    searches: Mutex<BTreeMap<usize, usize>>,
}
impl Host {
    async fn settle_invocation(
        &self,
        position: usize,
        status: ycoding_schema::tool_invocation::Status,
        structured: Option<JsonValue>,
    ) -> Result<(), ToolFailure> {
        let invocation = {
            let calls = self.calls.lock().unwrap_or_else(|error| error.into_inner());
            let call = calls.get(position).ok_or(ToolFailure::Internal)?;
            ycoding_schema::tool_invocation::Settled {
                id: call.id.clone().ok_or(ToolFailure::Internal)?,
                index: ycoding_schema::schema::NonNegativeInt::new(
                    call.index.ok_or(ToolFailure::Internal)? as i64,
                )
                .map_err(|_| ToolFailure::Internal)?,
                name: call.name.clone().ok_or(ToolFailure::Internal)?.into(),
                tool: call.tool.clone(),
                status,
                input: call.input.clone(),
                structured: structured.clone(),
            }
        };
        if let Some(settle) = &self.context.invocation_settled
            && let Err(error) = settle(invocation).await
        {
            *self
                .receipt_error
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = Some(error);
            return Err(ToolFailure::Cancelled);
        }
        self.settle_call(
            position,
            match status {
                ycoding_schema::tool_invocation::Status::Completed => "completed",
                ycoding_schema::tool_invocation::Status::Error => "error",
            },
            structured,
        );
        Ok(())
    }

    fn record(&self, call: Call) -> usize {
        let mut calls = self.calls.lock().unwrap_or_else(|error| error.into_inner());
        let position = calls.len();
        calls.push(call);
        position
    }
    fn settle_call(&self, position: usize, status: &'static str, structured: Option<JsonValue>) {
        if let Some(call) = self
            .calls
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get_mut(position)
        {
            call.status = status;
            call.structured = structured;
        }
    }
}
fn call_list(calls: &Mutex<Vec<Call>>, settled: bool) -> JsonValue {
    JsonValue::Array(
        calls
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .map(|call| {
                let mut output = ObjectEncoder::new()
                    .field("tool", &call.tool)
                    .field(
                        "status",
                        if settled && call.status == "running" {
                            "error"
                        } else {
                            call.status
                        },
                    )
                    .optional("input", &call.input)
                    .optional("id", &call.id)
                    .optional("name", &call.name.as_deref().map(LosslessString::from))
                    .optional("structured", &call.structured);
                if let Some(index) = call.index {
                    output = output.field("index", &(index as f64));
                }
                output.finish()
            })
            .collect(),
    )
}

async fn publish(
    context: &Context,
    calls: &Mutex<Vec<Call>>,
    progress: &tokio::sync::Mutex<()>,
    content: Vec<ToolContent>,
) {
    let _guard = progress.lock().await;
    let JsonValue::Object(structured) = ObjectEncoder::new()
        .field("toolCalls", &call_list(calls, false))
        .finish()
    else {
        unreachable!()
    };
    context
        .report(Progress {
            structured,
            content,
        })
        .await;
}
fn display_input(input: Option<JsonValue>) -> Option<JsonValue> {
    match input {
        None | Some(JsonValue::Null) => None,
        Some(JsonValue::Object(object)) if object.is_empty() => None,
        Some(value @ JsonValue::Object(_)) => Some(value),
        Some(value) => Some(ObjectEncoder::new().field("input", &value).finish()),
    }
}
impl ToolHost for Host {
    fn catalog(&self) -> Vec<ToolDescription> {
        self.registrations
            .iter()
            .map(|(path, (_, entry))| {
                let definition = entry.tool.definition(path);
                ToolDescription::from_schemas(
                    path.clone().into(),
                    String::from_utf16_lossy(
                        &definition.description.code_units().collect::<Vec<_>>(),
                    ),
                    &definition.input_schema,
                    definition.output_schema.as_ref(),
                )
            })
            .collect()
    }
    fn decode_input(
        &self,
        _: &LosslessString,
        input: Option<JsonValue>,
    ) -> Result<Option<JsonValue>, ToolFailure> {
        Ok(input)
    }
    fn decode_output(
        &self,
        _: &LosslessString,
        output: Option<JsonValue>,
    ) -> Result<Option<JsonValue>, ToolFailure> {
        Ok(output)
    }
    fn invoke(
        &self,
        path: LosslessString,
        input: Option<JsonValue>,
        cancellation: Cancellation,
    ) -> code_mode::ToolFuture<'_> {
        Box::pin(async move {
            if self
                .receipt_error
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_some()
            {
                return Err(ToolFailure::Cancelled);
            }
            let (name, entry) = path
                .as_str()
                .and_then(|path| self.registrations.get(path))
                .ok_or(ToolFailure::Internal)?;
            let sequence = self.invocations.fetch_add(1, Ordering::Relaxed);
            let id: LosslessString = ycoding_schema::stringify_json(&JsonValue::Array(vec![
                self.context.session_id.encode(),
                self.context.message_id.encode(),
                self.context.call_id.encode(),
                (sequence as f64).encode(),
            ]))
            .into();
            let index = self.record(Call {
                tool: path.clone(),
                status: "running",
                input: input.clone(),
                id: Some(id.clone()),
                index: Some(sequence),
                name: Some(name.clone()),
                structured: None,
            });
            let mut context = self.context.clone();
            context.invocation_id = Some(id);
            context.cancellation = cancellation;
            let calls = self.calls.clone();
            let progress = self.progress.clone();
            let outer = self.context.clone();
            context.progress = Some(Arc::new(move |update: Progress| {
                let calls = calls.clone();
                let progress = progress.clone();
                let outer = outer.clone();
                Box::pin(async move { publish(&outer, &calls, &progress, update.content).await })
            }));
            let pending = self
                .hooks
                .invoke_nested(name, entry, input.unwrap_or(JsonValue::Null), context)
                .await;
            let output = match pending {
                Ok(output) => output,
                Err(error) => {
                    self.settle_invocation(
                        index,
                        ycoding_schema::tool_invocation::Status::Error,
                        None,
                    )
                    .await?;
                    publish(&self.context, &self.calls, &self.progress, Vec::new()).await;
                    return Err(match error {
                        Failure::Tool { message, .. } => ToolFailure::Safe(message),
                        Failure::Cancelled => ToolFailure::Cancelled,
                        Failure::Defect(_) => ToolFailure::Internal,
                    });
                }
            };
            self.settle_invocation(
                index,
                ycoding_schema::tool_invocation::Status::Completed,
                Some(output.structured.clone()),
            )
            .await?;
            publish(&self.context, &self.calls, &self.progress, Vec::new()).await;
            let files = output
                .content
                .into_iter()
                .filter(|part| match part {
                    ToolContent::File(file) => {
                        file.uri.code_units().collect::<Vec<_>>().starts_with(
                            &"data:"
                                .encode_utf16()
                                .chain(file.mime.code_units())
                                .chain(";base64,".encode_utf16())
                                .collect::<Vec<_>>(),
                        )
                    }
                    _ => false,
                })
                .collect::<Vec<_>>();
            if !files.is_empty() {
                self.files
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .push((index, files));
            }
            Ok(Some(output.structured))
        })
    }
    fn on_tool_call_start(&self, call: ToolCallStarted) -> code_mode::ToolHookFuture<'_> {
        Box::pin(async move {
            if call.kind != ToolCallKind::Search {
                return;
            }
            let position = self.record(Call {
                tool: call.name,
                status: "running",
                input: display_input(call.input),
                id: None,
                index: None,
                name: None,
                structured: None,
            });
            self.searches
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(call.index, position);
        })
    }
    fn on_tool_call_end(&self, call: ToolCallEnded) -> code_mode::ToolHookFuture<'_> {
        Box::pin(async move {
            if call.call.kind != ToolCallKind::Search {
                return;
            }
            let position = self
                .searches
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .get(&call.call.index)
                .copied();
            if let Some(position) = position {
                self.settle_call(
                    position,
                    if call.outcome == ToolCallOutcome::Success {
                        "completed"
                    } else {
                        "error"
                    },
                    None,
                );
            }
        })
    }
}

pub fn pretty(value: &JsonValue, depth: usize) -> String {
    let (open, close, values) = match value {
        JsonValue::Array(values) => (
            '[',
            ']',
            values
                .iter()
                .map(|value| pretty(value, depth + 1))
                .collect::<Vec<_>>(),
        ),
        JsonValue::Object(object) => (
            '{',
            '}',
            object
                .iter()
                .map(|(key, value)| {
                    format!(
                        "{}: {}",
                        ycoding_schema::stringify_json(&JsonValue::String(key.clone())),
                        pretty(value, depth + 1)
                    )
                })
                .collect(),
        ),
        _ => return ycoding_schema::stringify_json(value),
    };
    if values.is_empty() {
        return format!("{open}{close}");
    }
    format!(
        "{open}\n{}{}\n{}{close}",
        "  ".repeat(depth + 1),
        values.join(&format!(",\n{}", "  ".repeat(depth + 1))),
        "  ".repeat(depth)
    )
}

fn join(parts: &[LosslessString], separator: &str) -> LosslessString {
    LosslessString::from_utf16(
        parts
            .iter()
            .enumerate()
            .flat_map(|(index, part)| {
                if index == 0 {
                    part.code_units().collect::<Vec<_>>()
                } else {
                    separator.encode_utf16().chain(part.code_units()).collect()
                }
            })
            .collect(),
    )
}
