use crate::{
    resources::memory::{self, Scope, Service},
    tools::{
        context::{Context, policy::LeafPolicy},
        registry::{Failure, Tool, ToolFuture},
    },
};
use std::{path::Path, sync::Arc};
use ycoding_ai::llm::{ToolDefinition, ToolOutput};
use ycoding_schema::{
    JsonObject, JsonValue, LosslessString,
    llm::{ToolContent, ToolTextContent},
    parse_json, stringify_json,
};

pub struct Memory {
    pub service: Arc<Service>,
    pub policy: Arc<LeafPolicy>,
}

impl Tool for Memory {
    fn definition(&self, name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.into(),
            description: "Use on-demand workspace knowledge: inspect status, list, search, read, write linked Markdown, export a local graph, or maintain entries. Read before replacing or deleting a concept and supply its digest. Delete moves an entry to recoverable trash; vacuum previews cleanup unless dryRun is false.".into(),
            input_schema: parse_json(include_str!("memory.input-schema.json")).unwrap(),
            output_schema: Some(parse_json(include_str!("memory.output-schema.json")).unwrap()),
            cache: None,
            metadata: None,
            native: None,
        }
    }

    fn permission(&self) -> Option<&str> {
        Some("memory")
    }

    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            let input = object(&input)?;
            let action = text(input, "action")?;
            validate_input(input, &action)?;
            let scope = match optional_text(input, "scope")?
                .as_deref()
                .unwrap_or("repository")
            {
                "repository" => Scope::Repository,
                "knowledge" => Scope::Knowledge,
                _ => return Err(Failure::message("Invalid memory scope.")),
            };
            let status = self.service.status(scope).map_err(memory_failure)?;
            if !status.enabled && action != "status" {
                return Err(Failure::message("Workspace memory is disabled."));
            }
            let resource = path(&status.root);
            if self
                .policy
                .permissions
                .evaluate_effective(
                    &context.session_id,
                    Some(&context.agent),
                    &"memory".into(),
                    &resource,
                )
                .map_err(|error| {
                    Failure::message(format!("Workspace memory permission failed: {error:?}"))
                })?
                == crate::tools::policy::Effect::Deny
            {
                return Err(Failure::message("Workspace memory is denied."));
            }
            let applying = action == "vacuum" && optional_bool(input, "dryRun")? == Some(false);
            let mutating = matches!(
                action.as_str(),
                "write" | "delete" | "restore" | "purge" | "graph"
            ) || applying;
            let read_only_preview = action == "vacuum" && !applying;
            let mut metadata = JsonObject::new();
            metadata.insert(
                "operation".into(),
                JsonValue::String(action.as_str().into()),
            );
            metadata.insert(
                "scope".into(),
                JsonValue::String(
                    match scope {
                        Scope::Repository => "repository",
                        Scope::Knowledge => "knowledge",
                    }
                    .into(),
                ),
            );
            self.policy
                .assert(
                    &context,
                    if mutating {
                        "memory_write"
                    } else {
                        "memory_read"
                    },
                    vec![resource.clone()],
                    vec!["*".into()],
                    Some(metadata.clone()),
                )
                .await?;
            if action == "status" {
                return output(status_output(status));
            }
            if action == "graph" && scope == Scope::Repository {
                let mut knowledge_metadata = JsonObject::new();
                knowledge_metadata.insert("operation".into(), JsonValue::String("graph".into()));
                knowledge_metadata.insert("scope".into(), JsonValue::String("knowledge".into()));
                self.policy
                    .assert(
                        &context,
                        "memory_read",
                        vec![path(&status.knowledge_root)],
                        vec!["*".into()],
                        Some(knowledge_metadata),
                    )
                    .await?;
            }
            if read_only_preview {
                return output(
                    self.service
                        .vacuum(
                            scope,
                            optional_bool(input, "dryRun")?,
                            optional_text(input, "expectedDigest")?.as_deref(),
                        )
                        .await
                        .map(vacuum_output)
                        .map_err(memory_failure)?,
                );
            }
            let reservation = if mutating {
                let mut guardrail_metadata = JsonObject::new();
                guardrail_metadata.insert(
                    "operation".into(),
                    JsonValue::String(
                        if matches!(action.as_str(), "delete" | "purge") || applying {
                            "remove"
                        } else {
                            "write"
                        }
                        .into(),
                    ),
                );
                guardrail_metadata.insert(
                    "memoryAction".into(),
                    JsonValue::String(action.clone().into()),
                );
                Some(
                    self.policy
                        .reserve(
                            &context,
                            "file_mutation",
                            vec![resource],
                            Some(guardrail_metadata),
                        )
                        .await?,
                )
            } else {
                None
            };
            let result = match action.as_str() {
                "list" => self
                    .service
                    .list(scope, number(input, "limit")?, number(input, "offset")?)
                    .map(listing_output),
                "search" => {
                    let query = text(input, "query")?;
                    let type_ = optional_text(input, "type")?;
                    let tag = optional_text(input, "tag")?;
                    self.service
                        .search(
                            scope,
                            memory::Search {
                                query: &query,
                                limit: number(input, "limit")?,
                                type_: type_.as_deref(),
                                tag: tag.as_deref(),
                            },
                        )
                        .map(search_output)
                }
                "read" => self
                    .service
                    .read(scope, &text(input, "id")?)
                    .map(read_output),
                "trash" => self
                    .service
                    .trash(scope, number(input, "limit")?, number(input, "offset")?)
                    .map(trash_output),
                "write" => self
                    .service
                    .write(
                        scope,
                        &text(input, "id")?,
                        &text(input, "content")?,
                        optional_text(input, "expectedDigest")?.as_deref(),
                    )
                    .await
                    .map(write_output),
                "delete" => self
                    .service
                    .delete(scope, &text(input, "id")?, &text(input, "expectedDigest")?)
                    .await
                    .map(delete_output),
                "restore" => self
                    .service
                    .restore(
                        scope,
                        &text(input, "trashID")?,
                        &text(input, "expectedDigest")?,
                    )
                    .await
                    .map(restore_output),
                "purge" => self
                    .service
                    .purge(
                        scope,
                        &text(input, "trashID")?,
                        &text(input, "expectedDigest")?,
                    )
                    .await
                    .map(purge_output),
                "vacuum" => self
                    .service
                    .vacuum(
                        scope,
                        optional_bool(input, "dryRun")?,
                        optional_text(input, "expectedDigest")?.as_deref(),
                    )
                    .await
                    .map(vacuum_output),
                "graph" => self.service.graph(scope).await.map(graph_output),
                _ => return Err(Failure::message("Unknown memory action.")),
            };
            drop(reservation);
            match result {
                Ok(value) => output(value),
                Err(error) => Err(memory_failure(error)),
            }
        })
    }
}

fn object(value: &JsonValue) -> Result<&JsonObject, Failure> {
    match value {
        JsonValue::Object(value) => Ok(value),
        _ => Err(Failure::message("Memory input must be an object.")),
    }
}
fn validate_input(input: &JsonObject, action: &str) -> Result<(), Failure> {
    let allowed: &[&str] = match action {
        "status" | "graph" => &["action", "scope"],
        "list" | "trash" => &["action", "scope", "limit", "offset"],
        "search" => &["action", "scope", "query", "limit", "type", "tag"],
        "read" => &["action", "scope", "id"],
        "vacuum" => &["action", "scope", "dryRun", "expectedDigest"],
        "write" => &["action", "scope", "id", "content", "expectedDigest"],
        "delete" => &["action", "scope", "id", "expectedDigest"],
        "restore" | "purge" => &["action", "scope", "trashID", "expectedDigest"],
        _ => return Err(Failure::message("Unknown memory action.")),
    };
    if input
        .iter()
        .any(|(key, _)| !key.as_str().is_some_and(|key| allowed.contains(&key)))
    {
        return Err(Failure::message(
            "Memory input contains an unsupported field.",
        ));
    }
    if matches!(action, "list" | "trash" | "search")
        && number(input, "limit")?
            .is_some_and(|limit| limit == 0 || limit > if action == "search" { 50 } else { 100 })
    {
        return Err(Failure::message("Memory limit is out of range."));
    }
    if matches!(action, "list" | "trash")
        && number(input, "offset")?.is_some_and(|offset| offset > 9_007_199_254_740_991)
    {
        return Err(Failure::message("Memory offset is out of range."));
    }
    match action {
        "search" => {
            let query = text(input, "query")?;
            if query.is_empty() || query.encode_utf16().count() > 1024 {
                return Err(Failure::message("Memory query is out of range."));
            }
        }
        "read" | "write" | "delete" => {
            let id = text(input, "id")?;
            memory::format::require_id(&id).map_err(memory_failure)?;
            match action {
                "write" => {
                    text(input, "content")?;
                    optional_digest(input)?;
                }
                "delete" => {
                    required_digest(input)?;
                }
                _ => {}
            }
        }
        "restore" | "purge" => {
            text(input, "trashID")?;
            required_digest(input)?;
        }
        "vacuum" => optional_digest(input)?,
        _ => {}
    }
    Ok(())
}
fn required_digest(input: &JsonObject) -> Result<String, Failure> {
    let digest = text(input, "expectedDigest")?;
    if !valid_digest(&digest) {
        return Err(Failure::message(
            "Memory expectedDigest must be a lowercase SHA-256 digest.",
        ));
    }
    Ok(digest)
}
fn optional_digest(input: &JsonObject) -> Result<(), Failure> {
    if let Some(digest) = optional_text(input, "expectedDigest")?
        && !valid_digest(&digest)
    {
        return Err(Failure::message(
            "Memory expectedDigest must be a lowercase SHA-256 digest.",
        ));
    }
    Ok(())
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn text(input: &JsonObject, key: &str) -> Result<String, Failure> {
    optional_text(input, key)?
        .ok_or_else(|| Failure::message(format!("Memory input is missing {key}.")))
}
fn optional_text(input: &JsonObject, key: &str) -> Result<Option<String>, Failure> {
    match input.get(&key.into()) {
        None => Ok(None),
        Some(JsonValue::String(value)) => value
            .as_str()
            .map(|text| Some(text.to_owned()))
            .ok_or_else(|| Failure::message(format!("Memory {key} must contain valid UTF-8."))),
        _ => Err(Failure::message(format!("Memory {key} must be a string."))),
    }
}
fn optional_bool(input: &JsonObject, key: &str) -> Result<Option<bool>, Failure> {
    match input.get(&key.into()) {
        None => Ok(None),
        Some(JsonValue::Bool(value)) => Ok(Some(*value)),
        _ => Err(Failure::message(format!("Memory {key} must be a boolean."))),
    }
}
fn number(input: &JsonObject, key: &str) -> Result<Option<usize>, Failure> {
    match input.get(&key.into()) {
        None => Ok(None),
        Some(JsonValue::Number(value))
            if value.is_finite()
                && *value >= 0.0
                && *value <= 9_007_199_254_740_991.0
                && value.fract() == 0.0 =>
        {
            Ok(Some(*value as usize))
        }
        _ => Err(Failure::message(format!(
            "Memory {key} must be a non-negative integer."
        ))),
    }
}
fn path(value: &Path) -> LosslessString {
    value.to_string_lossy().into_owned().into()
}
fn output(value: JsonValue) -> Result<ToolOutput, Failure> {
    let text = stringify_json(&value);
    Ok(ToolOutput {
        structured: value,
        content: vec![ToolContent::Text(ToolTextContent { text: text.into() })],
    })
}
fn memory_failure(error: memory::Error) -> Failure {
    Failure::message(error.to_string())
}
fn json_string(value: impl Into<LosslessString>) -> JsonValue {
    JsonValue::String(value.into())
}
fn object_value(fields: impl IntoIterator<Item = (String, JsonValue)>) -> JsonValue {
    let mut value = JsonObject::new();
    for (key, field) in fields {
        value.insert(key.into(), field);
    }
    JsonValue::Object(value)
}
fn array(values: Vec<JsonValue>) -> JsonValue {
    JsonValue::Array(values)
}
fn summary_output(value: memory::Summary) -> JsonValue {
    let mut fields = JsonObject::new();
    fields.insert("id".into(), json_string(value.id));
    fields.insert("type".into(), JsonValue::String(value.type_));
    if let Some(title) = value.title {
        fields.insert("title".into(), JsonValue::String(title));
    }
    if let Some(description) = value.description {
        fields.insert("description".into(), JsonValue::String(description));
    }
    if let Some(tags) = value.tags {
        fields.insert(
            "tags".into(),
            array(tags.into_iter().map(JsonValue::String).collect()),
        );
    }
    fields.insert("digest".into(), json_string(value.digest));
    JsonValue::Object(fields)
}
fn status_output(value: memory::State) -> JsonValue {
    let mut fields = JsonObject::new();
    fields.insert("enabled".into(), JsonValue::Bool(value.enabled));
    fields.insert(
        "scope".into(),
        JsonValue::String(
            match value.scope {
                Scope::Repository => "repository",
                Scope::Knowledge => "knowledge",
            }
            .into(),
        ),
    );
    fields.insert(
        "root".into(),
        json_string(value.root.to_string_lossy().into_owned()),
    );
    fields.insert(
        "base".into(),
        json_string(value.base.to_string_lossy().into_owned()),
    );
    fields.insert(
        "knowledgeRoot".into(),
        json_string(value.knowledge_root.to_string_lossy().into_owned()),
    );
    if let Some(repository) = value.repository {
        fields.insert(
            "repository".into(),
            object_value([
                ("id".into(), json_string(repository.id)),
                (
                    "directory".into(),
                    json_string(repository.directory.to_string_lossy().into_owned()),
                ),
                (
                    "commonDirectory".into(),
                    json_string(repository.common_directory.to_string_lossy().into_owned()),
                ),
                (
                    "worktrees".into(),
                    array(
                        repository
                            .worktrees
                            .into_iter()
                            .map(|path| json_string(path.to_string_lossy().into_owned()))
                            .collect(),
                    ),
                ),
            ]),
        );
    }
    let mut limits = JsonObject::new();
    limits.insert("enabled".into(), JsonValue::Bool(value.limits.enabled));
    if let Some(path) = value.limits.path {
        limits.insert("path".into(), json_string(path));
    }
    limits.insert(
        "max_concept_bytes".into(),
        JsonValue::Number(value.limits.max_concept_bytes as f64),
    );
    limits.insert(
        "max_bundle_bytes".into(),
        JsonValue::Number(value.limits.max_bundle_bytes as f64),
    );
    limits.insert(
        "max_concepts".into(),
        JsonValue::Number(value.limits.max_concepts as f64),
    );
    fields.insert("limits".into(), JsonValue::Object(limits));
    JsonValue::Object(fields)
}
fn warnings(values: Vec<memory::Warning>) -> JsonValue {
    array(
        values
            .into_iter()
            .map(|value| {
                object_value([
                    ("id".into(), json_string(value.id)),
                    ("code".into(), json_string(value.code)),
                ])
            })
            .collect(),
    )
}
fn listing_output(value: memory::Listing) -> JsonValue {
    object_value([
        (
            "concepts".into(),
            array(value.concepts.into_iter().map(summary_output).collect()),
        ),
        ("total".into(), JsonValue::Number(value.total as f64)),
        ("warnings".into(), warnings(value.warnings)),
    ])
}
fn read_output(value: memory::ReadResult) -> JsonValue {
    object_value([
        ("id".into(), json_string(value.id)),
        ("content".into(), json_string(value.content)),
        ("digest".into(), json_string(value.digest)),
    ])
}
fn write_output(value: memory::WriteResult) -> JsonValue {
    object_value([
        ("id".into(), json_string(value.id)),
        ("digest".into(), json_string(value.digest)),
        ("created".into(), JsonValue::Bool(value.created)),
        ("warnings".into(), warnings(value.warnings)),
    ])
}
fn delete_output(value: memory::DeleteResult) -> JsonValue {
    object_value([
        ("id".into(), json_string(value.id)),
        ("trashID".into(), json_string(value.trash_id)),
        ("digest".into(), json_string(value.digest)),
        ("warnings".into(), warnings(value.warnings)),
    ])
}
fn restore_output(value: memory::RestoreResult) -> JsonValue {
    object_value([
        ("id".into(), json_string(value.id)),
        ("digest".into(), json_string(value.digest)),
        ("warnings".into(), warnings(value.warnings)),
    ])
}
fn trash_output(value: memory::TrashListing) -> JsonValue {
    object_value([
        (
            "entries".into(),
            array(
                value
                    .entries
                    .into_iter()
                    .map(|entry| {
                        object_value([
                            ("id".into(), json_string(entry.id)),
                            ("trashID".into(), json_string(entry.trash_id)),
                            ("digest".into(), json_string(entry.digest)),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("total".into(), JsonValue::Number(value.total as f64)),
        ("warnings".into(), warnings(value.warnings)),
    ])
}
fn purge_output(value: memory::PurgeResult) -> JsonValue {
    object_value([
        ("trashID".into(), json_string(value.trash_id)),
        ("purged".into(), JsonValue::Bool(value.purged)),
        ("warnings".into(), warnings(value.warnings)),
    ])
}
fn vacuum_output(value: memory::VacuumResult) -> JsonValue {
    object_value([
        ("dryRun".into(), JsonValue::Bool(value.dry_run)),
        ("digest".into(), json_string(value.digest)),
        (
            "removed".into(),
            array(value.removed.into_iter().map(json_string).collect()),
        ),
        ("warnings".into(), warnings(value.warnings)),
    ])
}
fn graph_output(value: memory::graph::Export) -> JsonValue {
    object_value([
        (
            "path".into(),
            json_string(value.path.to_string_lossy().into_owned()),
        ),
        ("digest".into(), json_string(value.digest)),
        ("nodes".into(), JsonValue::Number(value.nodes as f64)),
        ("edges".into(), JsonValue::Number(value.edges as f64)),
        ("warnings".into(), warnings(value.warnings)),
    ])
}
fn search_output(value: memory::SearchResult) -> JsonValue {
    object_value([
        (
            "hits".into(),
            array(
                value
                    .hits
                    .into_iter()
                    .map(|hit| {
                        let JsonValue::Object(mut fields) = summary_output(hit.summary) else {
                            unreachable!()
                        };
                        fields.insert("score".into(), JsonValue::Number(hit.score as f64));
                        fields.insert("snippet".into(), JsonValue::String(hit.snippet));
                        JsonValue::Object(fields)
                    })
                    .collect(),
            ),
        ),
        ("warnings".into(), warnings(value.warnings)),
    ])
}
