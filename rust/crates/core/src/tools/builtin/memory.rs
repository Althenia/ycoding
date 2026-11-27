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
            description: "Durable OKF v0.3 Markdown knowledge for the active workspace. Relevant concepts are recalled automatically; use this tool to record or maintain knowledge, not to search for it.\nscope defaults to the active Git repository and may be 'knowledge' for concepts shared across repositories; outside Git only the knowledge scope is available.\nwrite stores one concept as complete Markdown: frontmatter with a nonempty type, then a body. Call template with a kind (fact, decision, constraint, preference, lesson, troubleshooting, procedure, known-issue) for the canonical shape. The harness stamps generated authorship, never accepts new verified events or human actors from the agent, rejects credentials, and answers a near-duplicate with duplicateOf instead of storing it. Replace an existing concept by passing its current digest; read it first.\nsupersede points a concept at its current replacement and retire marks it deprecated; both keep the file and need the current digest. review lists stale, deprecated, unverified, draft, conflicting, and invalid knowledge. delete moves an entry to recoverable trash, trash lists it, restore returns it without overwriting, purge permanently removes one exact trash entry, and vacuum previews derived cleanup (dryRun defaults true). graph exports an offline HTML graph.\nIDs are lowercase paths without extensions; index and log are reserved. Store only verified, durable, non-obvious knowledge that cites its sources; never store transient task state, transcripts, logs, secrets, credentials, private URLs, or speculation.".into(),
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
                "write" | "delete" | "restore" | "purge" | "graph" | "supersede" | "retire"
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
                    .list_at(&status, number(input, "limit")?, number(input, "offset")?)
                    .map(listing_output),
                "search" => {
                    let query = text(input, "query")?;
                    let type_ = optional_text(input, "type")?;
                    let tag = optional_text(input, "tag")?;
                    self.service
                        .search_at(
                            &status,
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
                    .read_at(&status, &text(input, "id")?)
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
                        optional_bool(input, "allowHumanActor")?.unwrap_or(false),
                    )
                    .await
                    .map(write_output),
                "supersede" => self
                    .service
                    .supersede(
                        scope,
                        &text(input, "id")?,
                        Some(&text(input, "replacement")?),
                        &text(input, "expectedDigest")?,
                    )
                    .await
                    .map(lifecycle_output),
                "retire" => self
                    .service
                    .supersede(
                        scope,
                        &text(input, "id")?,
                        None,
                        &text(input, "expectedDigest")?,
                    )
                    .await
                    .map(lifecycle_output),
                "review" => self.service.review(scope).map(review_output),
                "template" => memory::templates::by_kind(&text(input, "kind")?)
                    .map(template_output)
                    .ok_or(memory::Error::InvalidConcept),
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
        "write" => &[
            "action",
            "scope",
            "id",
            "content",
            "expectedDigest",
            "allowHumanActor",
        ],
        "delete" | "retire" => &["action", "scope", "id", "expectedDigest"],
        "supersede" => &["action", "scope", "id", "replacement", "expectedDigest"],
        "review" => &["action", "scope"],
        "template" => &["action", "scope", "kind"],
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
        "read" | "write" | "delete" | "retire" | "supersede" => {
            let id = text(input, "id")?;
            if action == "write" {
                memory::format::require_id(&id)
            } else {
                memory::format::require_readable_id(&id)
            }
            .map_err(memory_failure)?;
            match action {
                "write" => {
                    text(input, "content")?;
                    optional_digest(input)?;
                    optional_bool(input, "allowHumanActor")?;
                }
                "supersede" => {
                    memory::format::require_readable_id(&text(input, "replacement")?)
                        .map_err(memory_failure)?;
                    required_digest(input)?;
                }
                "delete" | "retire" => {
                    required_digest(input)?;
                }
                _ => {}
            }
        }
        "template" => {
            let kind = text(input, "kind")?;
            if memory::templates::by_kind(&kind).is_none() {
                return Err(Failure::message("Unknown memory template kind."));
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
    fields.insert("signals".into(), signals_output(&value.signals));
    JsonValue::Object(fields)
}
fn signals_output(signals: &memory::okf::Signals) -> JsonValue {
    let mut fields = JsonObject::new();
    fields.insert("status".into(), json_string(signals.status.clone()));
    fields.insert("current".into(), JsonValue::Bool(signals.current));
    fields.insert("trust".into(), json_string(signals.trust.name()));
    fields.insert("stale".into(), JsonValue::Bool(signals.stale));
    if let Some(deadline) = &signals.stale_after {
        fields.insert("staleAfter".into(), json_string(deadline.clone()));
    }
    if let Some(at) = signals.generated_at {
        fields.insert(
            "generatedAt".into(),
            json_string(at.format("%Y-%m-%dT%H:%M:%SZ").to_string()),
        );
    }
    if let Some(target) = signals
        .replacement
        .as_ref()
        .or(signals.superseded_by.as_ref())
    {
        fields.insert("supersededBy".into(), json_string(target.clone()));
    }
    fields.insert(
        "verificationOlderThanContent".into(),
        JsonValue::Bool(signals.verification_older_than_content),
    );
    fields.insert(
        "conflictsWith".into(),
        array(
            signals
                .conflicts_with
                .iter()
                .cloned()
                .map(json_string)
                .collect(),
        ),
    );
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
pub fn listing_output(value: memory::Listing) -> JsonValue {
    object_value([
        (
            "concepts".into(),
            array(value.concepts.into_iter().map(summary_output).collect()),
        ),
        ("total".into(), JsonValue::Number(value.total as f64)),
        ("warnings".into(), warnings(value.warnings)),
    ])
}
pub fn read_output(value: memory::ReadResult) -> JsonValue {
    object_value([
        ("id".into(), json_string(value.id)),
        ("content".into(), json_string(value.content)),
        ("digest".into(), json_string(value.digest)),
    ])
}
fn diagnostics(values: Vec<memory::okf::Diagnostic>) -> JsonValue {
    array(
        values
            .into_iter()
            .map(|value| {
                let mut fields = vec![
                    (
                        "level".to_owned(),
                        json_string(match value.level {
                            memory::okf::Level::Error => "error",
                            memory::okf::Level::Warning => "warning",
                            memory::okf::Level::Info => "info",
                            memory::okf::Level::Advice => "advice",
                        }),
                    ),
                    ("code".to_owned(), json_string(value.code)),
                    ("message".to_owned(), json_string(value.message)),
                ];
                if let Some(line) = value.line {
                    fields.push(("line".to_owned(), JsonValue::Number(line as f64)));
                }
                object_value(fields)
            })
            .collect(),
    )
}
fn write_output(value: memory::WriteResult) -> JsonValue {
    let mut fields = vec![
        ("id".to_owned(), json_string(value.id)),
        ("digest".to_owned(), json_string(value.digest)),
        ("created".to_owned(), JsonValue::Bool(value.created)),
        ("warnings".to_owned(), warnings(value.warnings)),
        ("diagnostics".to_owned(), diagnostics(value.diagnostics)),
    ];
    if let Some(existing) = value.duplicate_of {
        fields.push(("duplicateOf".to_owned(), json_string(existing)));
    }
    object_value(fields)
}
fn lifecycle_output(value: memory::LifecycleResult) -> JsonValue {
    let mut fields = vec![
        ("id".to_owned(), json_string(value.id)),
        ("digest".to_owned(), json_string(value.digest)),
        ("status".to_owned(), json_string("deprecated")),
        ("warnings".to_owned(), warnings(value.warnings)),
    ];
    if let Some(target) = value.superseded_by {
        fields.push(("supersededBy".to_owned(), json_string(target)));
    }
    object_value(fields)
}
fn review_output(value: memory::Review) -> JsonValue {
    object_value([
        ("total".into(), JsonValue::Number(value.total as f64)),
        (
            "flagged".into(),
            array(
                value
                    .flagged
                    .into_iter()
                    .map(|(summary, reasons)| {
                        let JsonValue::Object(mut fields) = summary_output(summary) else {
                            unreachable!()
                        };
                        fields.insert(
                            "reasons".into(),
                            array(reasons.into_iter().map(json_string).collect()),
                        );
                        JsonValue::Object(fields)
                    })
                    .collect(),
            ),
        ),
        (
            "findings".into(),
            array(
                value
                    .findings
                    .into_iter()
                    .filter(|(_, found)| found.level != memory::okf::Level::Info)
                    .map(|(path, found)| {
                        let JsonValue::Array(mut one) = diagnostics(vec![found]) else {
                            unreachable!()
                        };
                        let JsonValue::Object(mut fields) = one.remove(0) else {
                            unreachable!()
                        };
                        fields.insert("path".into(), json_string(path));
                        JsonValue::Object(fields)
                    })
                    .collect(),
            ),
        ),
        ("warnings".into(), warnings(value.warnings)),
    ])
}
fn template_output(value: &memory::templates::Template) -> JsonValue {
    object_value([
        ("kind".into(), json_string(value.kind)),
        ("type".into(), json_string(value.type_name)),
        ("purpose".into(), json_string(value.purpose)),
        (
            "markdown".into(),
            json_string(memory::templates::skeleton(value)),
        ),
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
pub fn search_output(value: memory::SearchResult) -> JsonValue {
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
                        fields.insert("score".into(), JsonValue::Number(hit.score));
                        fields.insert("snippet".into(), JsonValue::String(hit.snippet));
                        JsonValue::Object(fields)
                    })
                    .collect(),
            ),
        ),
        ("warnings".into(), warnings(value.warnings)),
    ])
}
