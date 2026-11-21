use crate::{
    process::guardrails::redact_value,
    session::{
        autonomy::State as Autonomy,
        history::{self, type_rows},
        history_pruning::retained_floor,
        key,
        prompt_cache::{canonical_json, sha256},
        review_fold::{DECIDED, DEFERRED, WITHDRAWN},
        summary_toon::{self, DecisionStatus, ParseOptions},
    },
};
use std::{collections::BTreeMap, ops::Bound};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonObject, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    mcp_events::RequestContext,
    session, session_message as message,
    session_review::{self, Deferral, Payload},
    stringify_json,
};
use ycoding_store::{
    Client, IndexOrder, IndexQuery, KeyPart, Snapshot, TableSpec,
    project::PermissionTable,
    session::{EventTable, PendingTable, SessionTable, TaskTable},
    tuple_key,
};

const RECENT_MESSAGES: usize = 16;
const INSTRUCTIONS: usize = 8;
const PENDING_INSTRUCTIONS: usize = 8;
const REVIEWS: usize = 8;
const SETTLEMENTS: usize = 24;
const RULES: usize = 64;
const TOOL_PARTS: usize = 32;
const ANCESTORS: usize = 2;
const PAGE: usize = 128;
const RUNNING_BLOCKERS: [&str; 3] = ["question", "form", "subagent"];

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Store(#[from] ycoding_store::Error),
    #[error("{0}")]
    Decode(#[from] ycoding_schema::DecodeError),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Context(JsonValue);

impl Context {
    pub fn value(&self) -> &JsonValue {
        &self.0
    }
    pub fn into_value(self) -> JsonValue {
        self.0
    }
    pub fn authority_digest(&self) -> String {
        let field = |object: &JsonObject, name: &str| {
            object.get(&name.into()).cloned().unwrap_or(JsonValue::Null)
        };
        let reviewed = |object: &JsonObject, name: &str| match field(object, name) {
            JsonValue::Array(items) => JsonValue::Array(
                items
                    .into_iter()
                    .filter(|item| !is_review_decision(item))
                    .collect(),
            ),
            other => other,
        };
        let JsonValue::Object(context) = &self.0 else {
            return sha256(&canonical_json(&self.0));
        };
        let ancestors = match field(context, "ancestors") {
            JsonValue::Array(items) => JsonValue::Array(
                items
                    .into_iter()
                    .map(|item| match item {
                        JsonValue::Object(mut parent) => {
                            for name in ["userInstructions", "pendingInstructions"] {
                                let filtered = reviewed(&parent, name);
                                parent.insert(name.into(), filtered);
                            }
                            JsonValue::Object(parent)
                        }
                        other => other,
                    })
                    .collect(),
            ),
            other => other,
        };
        let mut digest = JsonObject::new();
        digest.insert("goal".into(), field(context, "goal"));
        digest.insert("summary".into(), field(context, "summary"));
        digest.insert("authorization".into(), field(context, "authorization"));
        digest.insert(
            "userInstructions".into(),
            reviewed(context, "userInstructions"),
        );
        digest.insert(
            "pendingInstructions".into(),
            reviewed(context, "pendingInstructions"),
        );
        digest.insert("ancestors".into(), ancestors);
        digest.insert(
            "ancestryTruncated".into(),
            field(context, "ancestryTruncated"),
        );
        sha256(&canonical_json(&JsonValue::Object(digest)))
    }
}

fn is_review_decision(item: &JsonValue) -> bool {
    matches!(item, JsonValue::Object(item)
        if item.get(&"source".into()) == Some(&JsonValue::String("review-decision".into())))
}

#[derive(Clone)]
pub struct Service {
    client: Client,
}

impl Service {
    pub fn new(client: Client) -> Self {
        Self { client }
    }

    pub fn read(&self, session: &session::Id) -> Result<Context, Error> {
        read(&self.client.snapshot()?, session)
    }

    pub fn authority_digest(&self, session: &session::Id) -> Result<String, Error> {
        Ok(self.read(session)?.authority_digest())
    }
}

pub fn read(snapshot: &Snapshot, session: &session::Id) -> Result<Context, Error> {
    let mut current = read_local(snapshot, session)?;
    let mut ancestors = Vec::new();
    let mut parent = current.parent.take();
    for _ in 0..ANCESTORS {
        let Some(id) = parent.take() else {
            break;
        };
        let mut local = read_local(snapshot, &id)?;
        ancestors.push(object([
            ("source", text("managed-task-parent")),
            ("goal", local.take("goal")),
            ("userInstructions", local.take("userInstructions")),
            ("pendingInstructions", local.take("pendingInstructions")),
            ("authorization", local.take("authorization")),
        ]));
        parent = local.parent.take();
    }
    let mut context = current.fields;
    context.insert("ancestors".into(), JsonValue::Array(ancestors));
    context.insert(
        "ancestryTruncated".into(),
        JsonValue::Bool(parent.is_some()),
    );
    Ok(Context(JsonValue::Object(context)))
}

struct Local {
    parent: Option<session::Id>,
    fields: JsonObject,
}

impl Local {
    fn take(&self, name: &str) -> JsonValue {
        self.fields
            .get(&name.into())
            .cloned()
            .unwrap_or(JsonValue::Null)
    }
}

fn read_local(snapshot: &Snapshot, id: &session::Id) -> Result<Local, Error> {
    let row = snapshot.get::<SessionTable>(&key(id.as_lossless()))?;
    let grants = match &row {
        Some(row) => saved_grants(snapshot, &row.project_id)?,
        None => Vec::new(),
    };
    let goal = Autonomy::read(row.as_ref().and_then(|row| row.autonomy.as_ref())).goal;
    let task = snapshot.get::<TaskTable>(&key(id.as_lossless()))?;
    let delegated = task.is_some();
    let recent = history::recent(snapshot, id, RECENT_MESSAGES)?;
    let floor = retained_floor(snapshot, id)?;
    let floor_seq = match floor.lower {
        Bound::Included(seq) => seq,
        Bound::Excluded(seq) => seq + 1,
        Bound::Unbounded => 0,
    };
    let instructions = instruction_messages(snapshot, id, floor.lower)?;
    let compaction = history::latest(snapshot, id, "compaction")?;
    let compacted = floor
        .checkpoint
        .as_ref()
        .map(|checkpoint| checkpoint.text.clone())
        .or_else(|| compaction.as_ref().and_then(compaction_summary).cloned());
    let through = floor
        .checkpoint
        .as_ref()
        .map_or(floor_seq, |checkpoint| checkpoint.through);
    let summary = compacted
        .as_ref()
        .map_or(JsonValue::Null, |text| summary_context(text, through));
    let pending = pending_instructions(snapshot, id)?;
    let reviews = reviews(snapshot, id)?;
    let ceiling = match row.as_ref().and_then(|row| row.permission.as_ref()) {
        Some(document) => document.domain()?,
        None => Vec::new(),
    };

    let authorization = object([
        ("source", text("session-ceiling")),
        (
            "ceiling",
            JsonValue::Array(
                ceiling
                    .iter()
                    .take(RULES)
                    .map(|rule| {
                        object([
                            ("action", head(&redacted(&rule.action), 256)),
                            ("resource", head(&redacted(&rule.resource), 1000)),
                            ("effect", rule.effect.encode()),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("truncated", JsonValue::Bool(ceiling.len() > RULES)),
        (
            "remembered",
            JsonValue::Array(
                grants
                    .iter()
                    .take(RULES)
                    .map(|grant| {
                        object([
                            ("source", text("saved-project-grant")),
                            ("id", JsonValue::String(grant.id.clone())),
                            ("projectID", JsonValue::String(grant.project_id.clone())),
                            ("action", head(&redacted(&grant.action), 256)),
                            ("resource", head(&redacted(&grant.resource), 1000)),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("rememberedTruncated", JsonValue::Bool(grants.len() > RULES)),
    ]);

    let user_instructions = instructions
        .iter()
        .map(|user| {
            instruction(
                &user.id,
                source(user.metadata.as_ref(), delegated),
                &user.text,
            )
        })
        .collect::<Vec<_>>();
    let pending_instructions = pending
        .iter()
        .map(|item| {
            let metadata = match &item.data {
                JsonValue::Object(data) => match data.get(&"metadata".into()) {
                    Some(JsonValue::Object(metadata)) => Some(metadata),
                    _ => None,
                },
                _ => None,
            };
            let body = match &item.data {
                JsonValue::Object(data) => match data.get(&"text".into()) {
                    Some(JsonValue::String(body)) => Some(body),
                    _ => None,
                },
                _ => None,
            };
            object([
                ("id", JsonValue::String(item.id.clone())),
                ("source", text(source(metadata, delegated))),
                ("text", body.map_or_else(|| text(""), bounded_input)),
                (
                    "truncated",
                    JsonValue::Bool(body.is_some_and(|body| body.len() > 4096)),
                ),
            ])
        })
        .collect::<Vec<_>>();

    let mut conversation = Vec::new();
    let mut progress = Vec::new();
    let mut blockers = Vec::new();
    for item in &recent {
        match item {
            message::Info::Assistant(assistant) => {
                let body = assistant
                    .content
                    .iter()
                    .filter_map(|part| match part {
                        message::AssistantContent::Text(part) => Some(part.text.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                conversation.push(object([
                    ("source", text("assistant")),
                    ("text", tail(&redacted(&join(&body, "\n")), 1024)),
                ]));
                let tools = assistant
                    .content
                    .iter()
                    .filter_map(|part| match part {
                        message::AssistantContent::Tool(tool) => Some(tool.as_ref()),
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                let tools = &tools[tools.len().saturating_sub(TOOL_PARTS)..];
                let status = if assistant.error.is_some() {
                    "failed"
                } else if assistant.time.completed.is_none() {
                    "running"
                } else {
                    "completed"
                };
                let mut entry = JsonObject::new();
                entry.insert("messageID".into(), assistant.id.encode());
                entry.insert("status".into(), text(status));
                if let Some(error) = &assistant.error {
                    entry.insert("error".into(), error_entry(error));
                }
                entry.insert(
                    "tools".into(),
                    JsonValue::Array(tools.iter().map(|tool| tool_entry(tool)).collect()),
                );
                progress.push(JsonValue::Object(entry));
                for tool in tools {
                    let running = matches!(tool.state, message::ToolState::Running(_));
                    if running
                        && RUNNING_BLOCKERS
                            .iter()
                            .any(|name| tool.name.as_str() == Some(*name))
                    {
                        blockers.push(object([
                            ("source", text("running-tool")),
                            ("messageID", assistant.id.encode()),
                            ("callID", JsonValue::String(tool.id.clone())),
                            ("kind", JsonValue::String(tool.name.clone())),
                        ]));
                    }
                }
            }
            message::Info::Synthetic(value) => conversation.push(observation(&value.text)),
            message::Info::System(value) => conversation.push(observation(&value.text)),
            _ => {}
        }
    }
    blockers.extend(
        reviews
            .iter()
            .filter(|review| review.status == "pending")
            .map(Review::encode),
    );
    let history = reviews
        .iter()
        .filter(|review| review.status != "pending")
        .map(Review::encode)
        .collect::<Vec<_>>();

    let mut fields = JsonObject::new();
    let mut put = |name: &str, value: JsonValue| {
        fields.insert(name.into(), value);
    };
    put("version", JsonValue::Number(1.0));
    put(
        "parentID",
        task.as_ref().map_or(JsonValue::Null, |task| {
            JsonValue::String(task.parent_id.clone())
        }),
    );
    put(
        "goal",
        goal.map_or(JsonValue::Null, |goal| {
            object([
                ("text", head(&redacted(&goal.text), 4096)),
                (
                    "intent",
                    head(
                        &redacted(goal.raw_text.as_ref().unwrap_or(&goal.text)),
                        4096,
                    ),
                ),
                ("status", text(goal.status.as_str())),
            ])
        }),
    );
    put("summary", summary.clone());
    put("authorization", authorization);
    put(
        "userInstructions",
        JsonValue::Array(user_instructions.clone()),
    );
    put("conversation", JsonValue::Array(conversation));
    put("progress", JsonValue::Array(progress));
    put("pendingBlockers", JsonValue::Array(blockers));
    put("reviewHistory", JsonValue::Array(history));
    put(
        "pendingInstructions",
        JsonValue::Array(pending_instructions.clone()),
    );
    put(
        "coverage",
        object([
            ("bounded", JsonValue::Bool(true)),
            ("recentMessages", number(recent.len())),
            ("userInstructions", number(user_instructions.len())),
            ("toolPartsPerMessage", number(TOOL_PARTS)),
            (
                "olderHistory",
                text(if compacted.is_some() {
                    "summary"
                } else {
                    "not included"
                }),
            ),
            (
                "summaryTruncated",
                JsonValue::Bool(matches!(&summary, JsonValue::Object(summary)
                    if summary.get(&"truncated".into()) == Some(&JsonValue::Bool(true)))),
            ),
            (
                "blockers",
                text(
                    "recent running tools and the latest eight durable reviews; the request supplies its own active blocker",
                ),
            ),
            (
                "authorization",
                text(
                    "session ceiling, remembered project grants and request applicability; unreported input origins do not prove consent; instruction-channel text is not a native control settlement; delegated choices remain bounded by current policy; runtime permission checks remain authoritative",
                ),
            ),
            ("toolOutput", text("omitted; never user authorization")),
        ]),
    );
    Ok(Local {
        parent: task
            .map(|task| session::Id::new(task.parent_id))
            .transpose()?,
        fields,
    })
}

fn saved_grants(
    snapshot: &Snapshot,
    project: &LosslessString,
) -> Result<Vec<ycoding_store::project::Permission>, Error> {
    let prefix = tuple_key(&[KeyPart::String(project)]);
    let mut grants = collect::<PermissionTable>(
        snapshot,
        "permission_project_action_resource_idx",
        &prefix,
        IndexOrder::Ascending,
        |_| true,
        usize::MAX,
    )?;
    grants.sort_by(|left, right| left.id.code_units().cmp(right.id.code_units()));
    grants.truncate(RULES + 1);
    Ok(grants)
}

fn instruction_messages(
    snapshot: &Snapshot,
    id: &session::Id,
    lower: Bound<i64>,
) -> Result<Vec<message::User>, Error> {
    let mut rows = BTreeMap::new();
    for human_only in [false, true] {
        let mut after = None;
        let mut kept = 0;
        'pages: loop {
            let page = type_rows(
                snapshot,
                id,
                "user",
                lower,
                Bound::Unbounded,
                IndexOrder::Descending,
                after.as_ref(),
                PAGE,
            )?;
            let Some(last) = page.last() else {
                break;
            };
            after = Some(last.cursor.clone());
            for entry in page {
                if human_only && !human(&entry.record.data) {
                    continue;
                }
                rows.insert(entry.record.seq, entry.record);
                kept += 1;
                if kept == INSTRUCTIONS {
                    break 'pages;
                }
            }
        }
    }
    rows.into_values()
        .map(|row| match row.info()? {
            message::Info::User(user) => Ok(user),
            _ => Err(ycoding_store::Error::Rejected("user message row has another type").into()),
        })
        .collect()
}

fn human(data: &JsonValue) -> bool {
    matches!(data, JsonValue::Object(data)
        if matches!(data.get(&"metadata".into()), Some(JsonValue::Object(metadata))
            if metadata.get(&"inputOrigin".into()) == Some(&JsonValue::String("human".into()))))
}

fn pending_instructions(
    snapshot: &Snapshot,
    id: &session::Id,
) -> Result<Vec<ycoding_store::session::Pending>, Error> {
    let steer = LosslessString::from("steer");
    let prefix = tuple_key(&[KeyPart::String(id.as_lossless()), KeyPart::String(&steer)]);
    let user = LosslessString::from("user");
    let mut rows = BTreeMap::new();
    for human_only in [false, true] {
        for row in collect::<PendingTable>(
            snapshot,
            "session_pending_session_delivery_seq_idx",
            &prefix,
            IndexOrder::Descending,
            |row| row.type_ == user && (!human_only || human(&row.data)),
            PENDING_INSTRUCTIONS,
        )? {
            rows.insert(row.admitted_seq, row);
        }
    }
    Ok(rows.into_values().collect())
}

struct Review {
    id: LosslessString,
    kind: &'static str,
    status: &'static str,
    reason: String,
    fingerprint: Option<LosslessString>,
    action: Option<LosslessString>,
    decision: Option<LosslessString>,
}

impl Review {
    fn encode(&self) -> JsonValue {
        let mut entry = JsonObject::new();
        entry.insert("id".into(), JsonValue::String(self.id.clone()));
        entry.insert("kind".into(), text(self.kind));
        entry.insert("status".into(), text(self.status));
        entry.insert("reason".into(), text(&self.reason));
        if let Some(fingerprint) = &self.fingerprint {
            entry.insert("fingerprint".into(), JsonValue::String(fingerprint.clone()));
        }
        if let Some(action) = &self.action {
            entry.insert("action".into(), JsonValue::String(action.clone()));
        }
        if let Some(decision) = &self.decision {
            entry.insert("decision".into(), JsonValue::String(decision.clone()));
        }
        JsonValue::Object(entry)
    }
}

fn reviews(snapshot: &Snapshot, id: &session::Id) -> Result<Vec<Review>, Error> {
    let session_key = id.as_lossless();
    let deferred = collect::<EventTable>(
        snapshot,
        "event_aggregate_type_seq_idx",
        &event_prefix(session_key, DEFERRED),
        IndexOrder::Descending,
        |_| true,
        REVIEWS,
    )?
    .into_iter()
    .filter_map(|event| Deferral::decode(&event.data).ok())
    .collect::<Vec<_>>();
    if deferred.is_empty() {
        return Ok(Vec::new());
    }
    let ids = deferred
        .iter()
        .map(|item| item.item_id.as_lossless().clone())
        .collect::<Vec<_>>();
    let mut settlements = Vec::new();
    for type_ in [DECIDED, WITHDRAWN] {
        settlements.extend(collect::<EventTable>(
            snapshot,
            "event_aggregate_type_seq_idx",
            &event_prefix(session_key, type_),
            IndexOrder::Descending,
            |event| item_of(&event.data).is_some_and(|item| ids.contains(&item)),
            SETTLEMENTS,
        )?);
    }
    settlements.sort_by_key(|event| std::cmp::Reverse(event.seq));
    settlements.truncate(SETTLEMENTS);
    Ok(deferred
        .into_iter()
        .map(|item| {
            let settled = settlements
                .iter()
                .find(|event| item_of(&event.data).as_ref() == Some(item.item_id.as_lossless()));
            let path = JsonPath::default();
            let withdrawn = settled
                .filter(|event| event.type_.as_str() == Some(WITHDRAWN))
                .and_then(|event| {
                    let object = ObjectDecoder::new(&event.data, &path).ok()?;
                    let reason = object.field::<LosslessString>("reason").ok()?;
                    matches!(reason.as_str(), Some("reverted" | "task_closed"))
                        .then(|| readable(&reason))
                });
            let decision = settled
                .filter(|event| event.type_.as_str() == Some(DECIDED))
                .and_then(|event| {
                    ObjectDecoder::new(&event.data, &path)
                        .ok()?
                        .field::<session_review::Decision>("decision")
                        .ok()
                });
            let (fingerprint, action) = match &item.payload {
                Payload::Permission(payload) => (
                    Some(payload.fingerprint.as_lossless().clone()),
                    Some(payload.action.clone()),
                ),
                Payload::Guardrail(payload) => (
                    Some(payload.fingerprint.as_lossless().clone()),
                    Some(payload.action.clone()),
                ),
                _ => (None, None),
            };
            Review {
                id: item.item_id.as_lossless().clone(),
                kind: item.kind.as_str(),
                status: if withdrawn.is_some() {
                    "withdrawn"
                } else if decision.is_some() {
                    "decided"
                } else {
                    "pending"
                },
                reason: withdrawn.unwrap_or_else(|| item.reason.as_str().to_owned()),
                fingerprint,
                action: action.map(|action| redacted(&action)),
                decision: decision.map(|decision| {
                    LosslessString::from_utf16(
                        redacted(&stringify_json(&decision.encode()).into())
                            .code_units()
                            .take(1000)
                            .collect(),
                    )
                }),
            }
        })
        .collect())
}

fn event_prefix(session: &LosslessString, type_: &str) -> Vec<u8> {
    tuple_key(&[KeyPart::String(session), KeyPart::String(&type_.into())])
}

fn item_of(data: &JsonValue) -> Option<LosslessString> {
    match data {
        JsonValue::Object(data) => match data.get(&"itemID".into()) {
            Some(JsonValue::String(item)) => Some(item.clone()),
            _ => None,
        },
        _ => None,
    }
}

fn collect<T: TableSpec>(
    snapshot: &Snapshot,
    index: &str,
    prefix: &[u8],
    order: IndexOrder,
    keep: impl Fn(&T::Record) -> bool,
    limit: usize,
) -> Result<Vec<T::Record>, ycoding_store::Error> {
    let mut kept = Vec::new();
    let mut after = None;
    loop {
        let page = snapshot.index_range::<T>(
            index,
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(prefix),
                order,
                after: after.as_ref(),
                limit: PAGE,
            },
        )?;
        let Some(last) = page.last() else {
            return Ok(kept);
        };
        after = Some(last.cursor.clone());
        for entry in page {
            if keep(&entry.record) {
                kept.push(entry.record);
                if kept.len() >= limit {
                    return Ok(kept);
                }
            }
        }
    }
}

fn compaction_summary(info: &message::Info) -> Option<&LosslessString> {
    let message::Info::Compaction(compaction) = info else {
        return None;
    };
    match compaction {
        message::Compaction::Pending(value) => value.summary.as_ref(),
        message::Compaction::RunningV1(value) => Some(&value.summary),
        message::Compaction::Running(value) => value.summary.as_ref(),
        message::Compaction::CompletedV1(value) => Some(&value.summary),
        message::Compaction::Completed(value) => value.summary.as_ref(),
        message::Compaction::FailedV1(_) => None,
        message::Compaction::Failed(value) => value.summary.as_ref(),
    }
}

fn summary_context(summary: &LosslessString, through: i64) -> JsonValue {
    let source = readable(summary);
    let Ok(memory) = summary_toon::parse(
        &source,
        &ParseOptions {
            through_sequence: through,
        },
    ) else {
        return object([
            ("source", text("historical-summary")),
            ("format", text("text")),
            ("text", head(&redacted(summary), 4096)),
            ("truncated", JsonValue::Bool(summary.len() > 4096)),
        ]);
    };
    let units = |value: &str| value.encode_utf16().count();
    let lists = [
        &memory.requirements,
        &memory.constraints,
        &memory.blocked,
        &memory.completed,
        &memory.in_progress,
    ];
    let truncated = units(&source) > 8192
        || units(&memory.objective) > 2048
        || lists
            .iter()
            .any(|values| values.len() > 8 || values.iter().any(|value| units(value) > 512))
        || memory.decision.len() > 8
        || memory.decision.iter().any(|item| units(&item.text) > 512);
    let bounded = |values: &[String]| {
        JsonValue::Array(
            values
                .iter()
                .take(8)
                .map(|value| head(&redacted(&value.as_str().into()), 512))
                .collect(),
        )
    };
    object([
        ("source", text("historical-summary")),
        ("format", text("structured")),
        ("truncated", JsonValue::Bool(truncated)),
        (
            "objective",
            head(&redacted(&memory.objective.as_str().into()), 2048),
        ),
        (
            "decisions",
            JsonValue::Array(
                memory
                    .decision
                    .iter()
                    .take(8)
                    .map(|item| {
                        object([
                            (
                                "status",
                                text(match item.status {
                                    DecisionStatus::Accepted => "accepted",
                                    DecisionStatus::Rejected => "rejected",
                                    DecisionStatus::Superseded => "superseded",
                                }),
                            ),
                            ("text", head(&redacted(&item.text.as_str().into()), 512)),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("requirements", bounded(&memory.requirements)),
        ("constraints", bounded(&memory.constraints)),
        ("blocked", bounded(&memory.blocked)),
        ("completed", bounded(&memory.completed)),
        ("inProgress", bounded(&memory.in_progress)),
    ])
}

fn source(metadata: Option<&JsonObject>, delegated: bool) -> &'static str {
    if let Some(metadata) = metadata
        && let Some(JsonValue::String(origin)) = metadata.get(&"inputOrigin".into())
    {
        match origin.as_str() {
            Some("human") => return "human",
            Some("coordination") => return "coordination",
            Some("plugin") => {
                return match metadata.get(&"remoteMcp".into()) {
                    Some(remote) if RequestContext::decode(remote).is_ok() => "remote-mcp",
                    _ => "plugin",
                };
            }
            Some("subagent") => return "delegated-task",
            Some("review") => return "review-decision",
            _ => {}
        }
    }
    if delegated {
        "delegated-task"
    } else {
        "unreported-input"
    }
}

fn instruction(id: &message::Id, source: &str, body: &LosslessString) -> JsonValue {
    object([
        ("source", text(source)),
        ("id", id.encode()),
        ("text", bounded_input(body)),
        ("truncated", JsonValue::Bool(body.len() > 4096)),
    ])
}

fn observation(body: &LosslessString) -> JsonValue {
    object([
        ("source", text("observation")),
        ("text", tail(&redacted(body), 1024)),
    ])
}

fn error_entry(error: &ycoding_schema::session_error::Error) -> JsonValue {
    object([
        ("type", JsonValue::String(error.r#type.clone())),
        ("message", head(&redacted(&error.message), 500)),
    ])
}

fn tool_entry(tool: &message::AssistantTool) -> JsonValue {
    let (status, error) = match &tool.state {
        message::ToolState::Streaming(_) => ("streaming", None),
        message::ToolState::Running(_) => ("running", None),
        message::ToolState::Completed(_) => ("completed", None),
        message::ToolState::Error(state) => ("error", Some(error_entry(&state.error))),
    };
    let mut entry = JsonObject::new();
    entry.insert("callID".into(), JsonValue::String(tool.id.clone()));
    entry.insert("name".into(), JsonValue::String(tool.name.clone()));
    entry.insert("status".into(), text(status));
    if let Some(error) = error {
        entry.insert("error".into(), error);
    }
    JsonValue::Object(entry)
}

fn bounded_input(body: &LosslessString) -> JsonValue {
    let redacted = redacted(body).code_units().collect::<Vec<_>>();
    if redacted.len() <= 4096 {
        return JsonValue::String(LosslessString::from_utf16(redacted));
    }
    let mut units = redacted[..2048].to_vec();
    units.extend("\n[bounded input: middle omitted]\n".encode_utf16());
    units.extend_from_slice(&redacted[redacted.len() - 2048..]);
    JsonValue::String(LosslessString::from_utf16(units))
}

fn redacted(value: &LosslessString) -> LosslessString {
    match redact_value(&JsonValue::String(value.clone())) {
        JsonValue::String(value) => value,
        _ => LosslessString::default(),
    }
}

fn head(value: &LosslessString, limit: usize) -> JsonValue {
    JsonValue::String(LosslessString::from_utf16(
        value.code_units().take(limit).collect(),
    ))
}

fn tail(value: &LosslessString, limit: usize) -> JsonValue {
    let units = value.code_units().collect::<Vec<_>>();
    JsonValue::String(LosslessString::from_utf16(
        units[units.len().saturating_sub(limit)..].to_vec(),
    ))
}

fn join(parts: &[LosslessString], separator: &str) -> LosslessString {
    let mut units = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            units.extend(separator.encode_utf16());
        }
        units.extend(part.code_units());
    }
    LosslessString::from_utf16(units)
}

fn readable(value: &LosslessString) -> String {
    String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>())
}

fn text(value: &str) -> JsonValue {
    JsonValue::String(value.into())
}

fn number(value: usize) -> JsonValue {
    JsonValue::Number(value as f64)
}

fn object<const N: usize>(entries: [(&str, JsonValue); N]) -> JsonValue {
    let mut object = JsonObject::new();
    for (name, value) in entries {
        object.insert(name.into(), value);
    }
    JsonValue::Object(object)
}
