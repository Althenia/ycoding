use super::filesystem::{Paths, path_text};
use crate::{
    platform::computer::{
        Future,
        boundary::{
            Context as Call, Permission, PermissionFailure, Policy, Reservation, Resolved, Review,
        },
        types::Owner,
    },
    tools::{
        context::{Context, policy::LeafPolicy},
        policy::permissions,
        registry::Failure,
    },
};
use serde_json::Value;
use std::sync::Arc;
use ycoding_ai::llm::ToolOutput;
use ycoding_schema::{
    JsonObject, JsonValue, LosslessString,
    llm::{ToolContent, ToolFileContent, ToolTextContent},
    parse_json,
};

pub(super) struct CallPolicy {
    pub policy: Arc<LeafPolicy>,
    pub paths: Arc<Paths>,
    pub context: Context,
}

impl CallPolicy {
    pub(super) fn call(&self) -> Result<Call, Failure> {
        Ok(Call {
            owner: Owner {
                session_id: utf8(self.context.session_id.as_lossless())?,
                call_id: utf8(&self.context.call_id)?,
            },
            message_id: utf8(self.context.message_id.as_lossless())?,
            agent: utf8(&self.context.agent)?,
        })
    }
}

impl Policy for CallPolicy {
    fn permission<'a>(
        &'a self,
        _context: &'a Call,
        request: Permission,
    ) -> Future<'a, Result<(), PermissionFailure>> {
        Box::pin(async move {
            let outcome = self
                .policy
                .assert_with(
                    &self.context,
                    &request.action,
                    lossless(request.resources),
                    lossless(request.save),
                    object(&request.metadata),
                )
                .await
                .map_err(|failure| PermissionFailure::Fault(failure_message(failure)))?;
            outcome.map_err(|error| match error {
                permissions::Error::Blocked { permission, .. } => {
                    PermissionFailure::Blocked(format!("Permission denied: {}", lossy(&permission)))
                }
                permissions::Error::Corrected(feedback) => {
                    PermissionFailure::Corrected(lossy(&feedback))
                }
                permissions::Error::Declined => {
                    PermissionFailure::Fault("The user declined this permission request".into())
                }
                other => PermissionFailure::Fault(format!("Permission rejected: {other:?}")),
            })
        })
    }

    fn review<'a>(
        &'a self,
        _context: &'a Call,
        request: Review,
    ) -> Future<'a, Result<Box<dyn Reservation>, String>> {
        Box::pin(async move {
            let reservation = self
                .policy
                .reserve_with(
                    &self.context,
                    &request.action,
                    lossless(request.resources),
                    object(&request.metadata),
                    request.skip_review,
                )
                .await
                .map_err(failure_message)?;
            Ok(Box::new(Held(reservation)) as Box<dyn Reservation>)
        })
    }

    fn resolve<'a>(
        &'a self,
        path: &'a str,
        directory: bool,
    ) -> Future<'a, Result<Resolved, String>> {
        Box::pin(async move {
            let target = self
                .paths
                .resolve(path, directory)
                .map_err(|error| error.to_string())?;
            Ok(Resolved {
                canonical: path_text(&target.mutation.canonical),
                resource: target.mutation.resource,
                external_directory: target.external.map(|(resource, save)| Permission {
                    action: "external_directory".into(),
                    resources: vec![resource],
                    save: vec![save],
                    metadata: Value::Null,
                }),
            })
        })
    }
}

struct Held(crate::process::guardrails::Reservation);
impl Reservation for Held {
    fn release(&self) {
        self.0.release();
    }
}

pub(super) fn model_content(parts: Vec<Value>) -> Vec<ToolContent> {
    parts
        .into_iter()
        .filter_map(|part| match part.get("type").and_then(Value::as_str) {
            Some("text") => Some(ToolContent::Text(ToolTextContent {
                text: part.get("text")?.as_str()?.into(),
            })),
            Some("file") => {
                let mime = part.get("mime")?.as_str()?;
                Some(ToolContent::File(ToolFileContent {
                    uri: format!("data:{mime};base64,{}", part.get("data")?.as_str()?).into(),
                    mime: mime.into(),
                    name: part.get("name")?.as_str().map(Into::into),
                }))
            }
            _ => None,
        })
        .collect()
}

pub(super) fn output(structured: JsonValue, parts: Vec<Value>) -> ToolOutput {
    ToolOutput {
        structured,
        content: model_content(parts),
    }
}

pub(super) fn to_serde(value: &JsonValue) -> Result<Value, Failure> {
    serde_json::from_str(&ycoding_schema::stringify_json(value))
        .map_err(|_| Failure::message("Invalid tool input"))
}

pub(super) fn to_json(value: &Value) -> Result<JsonValue, Failure> {
    parse_json(&value.to_string()).map_err(|_| Failure::Defect("Invalid tool output".into()))
}

fn utf8(value: &LosslessString) -> Result<String, Failure> {
    value
        .to_utf8()
        .map_err(|_| Failure::message("Invalid tool call identity"))
}

fn lossy(value: &LosslessString) -> String {
    value.to_utf8().unwrap_or_default()
}

fn lossless(values: Vec<String>) -> Vec<LosslessString> {
    values.into_iter().map(Into::into).collect()
}

fn object(value: &Value) -> Option<JsonObject> {
    match parse_json(&value.to_string()) {
        Ok(JsonValue::Object(object)) => Some(object),
        _ => None,
    }
}

fn failure_message(failure: Failure) -> String {
    match failure {
        Failure::Tool { message, .. } | Failure::Defect(message) => message,
        Failure::Cancelled => "The operation was cancelled".into(),
    }
}

pub(super) fn definition(name: &str, source: &str) -> ycoding_ai::llm::ToolDefinition {
    let JsonValue::Object(parts) = parse_json(source).expect("embedded tool definition parses")
    else {
        unreachable!("embedded tool definition is an object")
    };
    let part = |key: &str| parts.get(&key.into()).cloned();
    let Some(JsonValue::String(description)) = part("description") else {
        unreachable!("embedded tool definition has a description")
    };
    ycoding_ai::llm::ToolDefinition {
        name: name.into(),
        description,
        input_schema: part("inputSchema").expect("embedded tool definition has an input schema"),
        output_schema: part("outputSchema"),
        cache: None,
        metadata: None,
        native: None,
    }
}
