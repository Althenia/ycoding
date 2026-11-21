use crate::{
    resources::project_artifact::store::{self, AutomaticWriteInput, Service},
    tools::{
        context::{Context, policy::LeafPolicy},
        registry::{Failure, Tool, ToolFuture},
    },
};
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use ycoding_ai::llm::{ToolDefinition, ToolOutput};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonObject, JsonValue, agent,
    llm::{ToolContent, ToolTextContent},
    parse_json, project, project_artifact,
};

pub struct ProjectArtifact {
    pub store: Arc<Service>,
    pub project_id: project::Id,
    pub policy: Arc<LeafPolicy>,
}

impl Tool for ProjectArtifact {
    fn definition(&self, name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.into(),
            description: "At a safe boundary after work is complete and validated, record at most one repeated durable repository-specific insight as a trial skill, instruction-only command, or least-privilege agent. Never record transient state, preferences, prompts, logs, secrets, credentials, private paths or URLs, customer data, or speculation. Do not create plugins.".into(),
            input_schema: parse_json(include_str!("project-artifact.input-schema.json")).unwrap(),
            output_schema: Some(parse_json(include_str!("project-artifact.output-schema.json")).unwrap()),
            cache: None,
            metadata: None,
            native: None,
        }
    }

    fn permission(&self) -> Option<&str> {
        Some("project_artifact")
    }

    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            let input = object(&input)?;
            if self.project_id.as_lossless().as_str() == Some("global") {
                return Err(Failure::message(
                    "Project artifact requires a stable project identity.",
                ));
            }
            let kind = text(input, "kind")?;
            let id_text = text(input, "id")?;
            let id = project_artifact::Id::decode(&JsonValue::String(id_text.clone().into()))
                .map_err(|error| {
                    Failure::message(format!("Invalid project artifact id: {error}"))
                })?;
            validate_fields(input, &kind)?;
            let insight_key = text(input, "insight_key")?;
            if insight_key.is_empty() {
                return Err(Failure::message(
                    "Project artifact insight_key must not be empty.",
                ));
            }
            let definition = definition(input, &kind)?;
            project_artifact::Definition::decode(&definition).map_err(|error| {
                Failure::message(format!("Invalid project artifact definition: {error}"))
            })?;
            let base_version_id = optional_text(input, "base_version_id")?
                .map(|value| project_artifact::VersionId::decode(&JsonValue::String(value.into())))
                .transpose()
                .map_err(|error| Failure::message(format!("Invalid base_version_id: {error}")))?;
            if self
                .policy
                .permissions
                .evaluate_effective(
                    &context.session_id,
                    Some(&context.agent),
                    &"project_artifact".into(),
                    id.as_lossless(),
                )
                .map_err(|error| {
                    Failure::message(format!(
                        "Project artifact permission could not be evaluated: {error:?}"
                    ))
                })?
                == crate::tools::policy::Effect::Deny
            {
                return Err(Failure::message("Project artifact is denied."));
            }
            let mut metadata = JsonObject::new();
            metadata.insert(
                "operation".into(),
                JsonValue::String("automatic_write".into()),
            );
            let reservation = self
                .policy
                .reserve(
                    &context,
                    "project_artifact_mutation",
                    vec![format!("{kind}/{id_text}").into()],
                    Some(metadata),
                )
                .await?;
            let result = self.store.write_automatic(AutomaticWriteInput {
                project_id: self.project_id.clone(),
                session_id: context.session_id.clone(),
                agent_id: Some(
                    agent::Id::decode(&JsonValue::String(context.agent.clone()))
                        .map_err(|error| Failure::message(format!("Invalid agent id: {error}")))?,
                ),
                insight_key: &insight_key,
                id: &id_text,
                definition: &definition,
                base_version_id,
                now: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|error| Failure::Defect(error.to_string()))?
                    .as_millis() as i64,
            });
            reservation.release();
            let result =
                result.map_err(|error| Failure::message(automatic_write_failure(error)))?;
            output(result)
        })
    }
}

fn object(value: &JsonValue) -> Result<&JsonObject, Failure> {
    match value {
        JsonValue::Object(value) => Ok(value),
        _ => Err(Failure::message(
            "Project artifact input must be an object.",
        )),
    }
}
fn text(input: &JsonObject, key: &str) -> Result<String, Failure> {
    optional_text(input, key)?
        .ok_or_else(|| Failure::message(format!("Project artifact input is missing {key}.")))
}
fn optional_text(input: &JsonObject, key: &str) -> Result<Option<String>, Failure> {
    match input.get(&key.into()) {
        None => Ok(None),
        Some(JsonValue::String(value)) => value
            .as_str()
            .map(|value| Some(value.to_owned()))
            .ok_or_else(|| {
                Failure::message(format!("Project artifact {key} must be valid UTF-8."))
            }),
        _ => Err(Failure::message(format!(
            "Project artifact {key} must be a string."
        ))),
    }
}
fn validate_fields(input: &JsonObject, kind: &str) -> Result<(), Failure> {
    let common = ["kind", "id", "insight_key", "base_version_id"];
    let specific: &[&str] = match kind {
        "skill" => &["name", "description", "content"],
        "command" => &["name", "description", "template"],
        "agent" => &["name", "description", "system", "permissions"],
        _ => {
            return Err(Failure::message(
                "Project artifact kind must be skill, command, or agent.",
            ));
        }
    };
    if input.iter().any(|(key, _)| {
        let Some(key) = key.as_str() else { return true };
        !common.contains(&key) && !specific.contains(&key)
    }) {
        return Err(Failure::message(
            "Project artifact input contains an unsupported field.",
        ));
    }
    Ok(())
}
fn definition(input: &JsonObject, kind: &str) -> Result<JsonValue, Failure> {
    let mut fields = JsonObject::new();
    fields.insert("kind".into(), JsonValue::String(kind.into()));
    for key in ["name", "description"] {
        fields.insert(key.into(), JsonValue::String(text(input, key)?.into()));
    }
    match kind {
        "skill" => fields.insert(
            "content".into(),
            JsonValue::String(text(input, "content")?.into()),
        ),
        "command" => {
            fields.insert(
                "template".into(),
                JsonValue::String(text(input, "template")?.into()),
            );
            fields.insert("subtask".into(), JsonValue::Bool(false));
            None
        }
        "agent" => {
            fields.insert(
                "system".into(),
                JsonValue::String(text(input, "system")?.into()),
            );
            fields.insert("mode".into(), JsonValue::String("subagent".into()));
            fields.insert(
                "permissions".into(),
                input
                    .get(&"permissions".into())
                    .cloned()
                    .unwrap_or_else(|| JsonValue::Array(vec![])),
            );
            None
        }
        _ => {
            return Err(Failure::message(
                "Project artifact kind must be skill, command, or agent.",
            ));
        }
    };
    Ok(JsonValue::Object(fields))
}
fn output(value: store::WriteResult) -> Result<ToolOutput, Failure> {
    let result_value = value.result.encode();
    let result_label = match &result_value {
        JsonValue::String(result) => result.as_str().unwrap_or("written").to_owned(),
        _ => "written".to_owned(),
    };
    let result = object_value([
        ("result".into(), result_value),
        ("kind".into(), value.kind.encode()),
        ("id".into(), value.id.encode()),
        ("versionID".into(), value.version_id.encode()),
        ("contentDigest".into(), value.content_digest.encode()),
        ("stage".into(), value.stage.encode()),
        (
            "remaining".into(),
            object_value([
                ("session".into(), JsonValue::Number(value.remaining.session)),
                (
                    "projectDaily".into(),
                    JsonValue::Number(value.remaining.project_daily),
                ),
                (
                    "projectArtifacts".into(),
                    JsonValue::Number(value.remaining.project_artifacts),
                ),
                (
                    "versions".into(),
                    JsonValue::Number(value.remaining.versions),
                ),
                ("bytes".into(), JsonValue::Number(value.remaining.bytes)),
            ]),
        ),
    ]);
    let text = format!(
        "{}: {}/{} (trial); remaining session {}, project {}",
        result_label,
        value.kind.as_lossless().as_str().unwrap_or("artifact"),
        value.id.as_lossless().as_str().unwrap_or(""),
        value.remaining.session,
        value.remaining.project_artifacts,
    );
    Ok(ToolOutput {
        structured: result,
        content: vec![ToolContent::Text(ToolTextContent { text: text.into() })],
    })
}
fn object_value(fields: impl IntoIterator<Item = (String, JsonValue)>) -> JsonValue {
    let mut value = JsonObject::new();
    for (key, field) in fields {
        value.insert(key.into(), field);
    }
    JsonValue::Object(value)
}
fn automatic_write_failure(error: store::Error) -> String {
    let code = match error.code.encode() {
        JsonValue::String(code) => code.as_str().unwrap_or("unknown").to_owned(),
        _ => "unknown".to_owned(),
    };
    let remedy = match code.as_str() {
        "ProjectIdentityUnavailable" => "retry from a stable project.",
        "InvalidArtifact" => "correct the artifact fields.",
        "UnsafeContent" => {
            "remove secrets, URLs, filesystem paths, contact details, markup or links, prompt-injection markers, executable code or commands, and packaging filenames."
        }
        "UnsupportedKind" => "choose a supported artifact kind.",
        "InvalidScope" => "choose a valid artifact scope.",
        "ArtifactNotFound" => "choose an existing artifact.",
        "VersionNotFound" => "pass an existing base_version_id.",
        "DeletionNotFound" => "choose an existing deletion.",
        "ArtifactCollision" => "choose another artifact id.",
        "ScopeCollision" => "choose a different artifact scope.",
        "VersionConflict" => "pass base_version_id for the current version.",
        "OwnershipMismatch" => "use an artifact owned by this project.",
        "DestinationExists" => "choose a different destination.",
        "ProjectAdoptionConflict" => "resolve project ownership before retrying.",
        "ConfirmationExpired" => "request a new confirmation.",
        "TrashExpired" => "create a new artifact instead.",
        "ContentTooLarge" => "reduce the artifact content.",
        "ScopeQuotaExceeded" => "prune project artifacts or versions before retrying.",
        "WriteRateExceeded" => "wait before another automatic write.",
        "ArtifactCooldown" => "wait before updating this artifact.",
        "StorageUnavailable" => "retry after storage is available.",
        "LockTimeout" => "retry after another artifact operation completes.",
        "ReconciliationRequired" => "reconcile project artifacts before retrying.",
        _ => "correct the input or retry after storage is available.",
    };
    format!("Project artifact write was rejected: {code}; {remedy}")
}
