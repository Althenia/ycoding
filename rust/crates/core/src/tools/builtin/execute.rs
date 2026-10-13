use crate::tools::{
    code_mode::{
        self, Cancellation, ToolCallEnded, ToolCallOutcome, ToolCallStarted, ToolDescription,
        ToolFailure, ToolHost,
    },
    context::Context,
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
    JsonValue, LosslessString, ObjectEncoder,
    llm::{ToolContent, ToolTextContent},
    parse_json,
};

pub struct Execute {
    registrations: BTreeMap<String, Entry>,
    collator: Arc<code_mode::Collation>,
}
impl Execute {
    pub fn new(
        registrations: BTreeMap<String, Entry>,
        collator: Arc<code_mode::Collation>,
    ) -> Self {
        Self {
            registrations,
            collator,
        }
    }
}
const DESCRIPTION: &str = "Execute a program in a restricted JavaScript language for calling the current Code Mode tool catalog.\n\nDiscover tools at runtime with `return search({ query: \"<intent + key nouns>\" })`. Search results contain exact callable paths, descriptions, and TypeScript signatures. Copy a returned path exactly in a later execution; do not infer or normalize tool names.\n\nCall tools with `await tools.<namespace>.<tool>(input)` or the exact bracket notation returned by search. Run independent calls with `Promise.all`, await every call whose completion matters, and return only the fields needed from structured results.\n\nThe language supports common JavaScript data operations, functions, control flow, selected standard-library methods, and awaited tool calls. Modules, imports, classes, generators, timers, fetch, eval, prototype access, and unlisted methods are unavailable.\n\nOnly tools returned by runtime search or already known from the same execution context are available. Catalog contents may change without changing this tool definition.";

impl Tool for Execute {
    fn definition(&self, name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.into(), description: DESCRIPTION.into(),
            input_schema: parse_json(r#"{"type":"object","properties":{"code":{"type":"string"}},"required":["code"],"additionalProperties":false}"#).unwrap(),
            output_schema: Some(parse_json(r#"{"type":"object","properties":{"toolCalls":{"type":"array","items":{"type":"object","properties":{"tool":{"type":"string"},"status":{"type":"string","enum":["running","completed","error"]},"input":{"type":"object"}},"required":["tool","status"],"additionalProperties":false}},"error":{"type":"boolean","enum":[true]}},"required":["toolCalls"],"additionalProperties":false}"#).unwrap()),
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
            let registrations = self
                .registrations
                .values()
                .map(|entry| {
                    (
                        entry.namespace.as_ref().map_or_else(
                            || entry.name.clone(),
                            |namespace| format!("{namespace}.{}", entry.name),
                        ),
                        entry.clone(),
                    )
                })
                .collect();
            let host = Arc::new(Host {
                registrations,
                context: context.clone(),
                calls: Mutex::new(vec![]),
                files: Mutex::new(vec![]),
                index: AtomicUsize::new(0),
            });
            let runtime = code_mode::Runtime::new(
                host.clone(),
                code_mode::ExecutionLimits::default(),
                Arc::new(code_mode::regexp::NativeRegExpEngine),
                self.collator.clone(),
            )
            .map_err(Failure::Defect)?;
            let result = runtime.execute(code.clone(), context.cancellation).await;
            let calls = host
                .calls
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .iter()
                .map(|call| {
                    let mut output = ObjectEncoder::new().field("tool", &call.tool).field(
                        "status",
                        if call.status == "running" {
                            "error"
                        } else {
                            call.status
                        },
                    );
                    if let Some(input) = &call.input {
                        output = output.field("input", input);
                    }
                    output.finish()
                })
                .collect::<Vec<_>>();
            let mut structured = ObjectEncoder::new().field("toolCalls", &JsonValue::Array(calls));
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
}
struct Host {
    registrations: BTreeMap<String, Entry>,
    context: Context,
    calls: Mutex<Vec<Call>>,
    files: Mutex<Vec<(usize, Vec<ToolContent>)>>,
    index: AtomicUsize,
}
impl ToolHost for Host {
    fn catalog(&self) -> Vec<ToolDescription> {
        self.registrations
            .iter()
            .map(|(path, entry)| {
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
            let entry = path
                .as_str()
                .and_then(|path| self.registrations.get(path))
                .ok_or(ToolFailure::Internal)?;
            let index = self.index.fetch_add(1, Ordering::SeqCst);
            let mut context = self.context.clone();
            context.cancellation = cancellation;
            let output = entry
                .tool
                .settle(input.unwrap_or(JsonValue::Null), context)
                .await
                .map_err(|error| match error {
                    Failure::Tool { message, .. } => ToolFailure::Safe(message),
                    Failure::Cancelled => ToolFailure::Cancelled,
                    Failure::Defect(_) => ToolFailure::Internal,
                })?;
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
            let input = match call.input {
                None | Some(JsonValue::Null) => None,
                Some(JsonValue::Object(object)) if object.is_empty() => None,
                Some(value @ JsonValue::Object(_)) => Some(value),
                Some(value) => Some(ObjectEncoder::new().field("input", &value).finish()),
            };
            self.calls
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(
                    call.index,
                    Call {
                        tool: call.name,
                        status: "running",
                        input,
                    },
                );
        })
    }
    fn on_tool_call_end(&self, call: ToolCallEnded) -> code_mode::ToolHookFuture<'_> {
        Box::pin(async move {
            if let Some(current) = self
                .calls
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .get_mut(call.call.index)
            {
                current.status = if call.outcome == ToolCallOutcome::Success {
                    "completed"
                } else {
                    "error"
                };
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
