#[path = "log/payload.rs"]
mod payload;

use crate::{
    convert::{self, wire},
    message::{
        self, J, Unrepresentable, count, literal, number, opt_count, opt_literal, opt_number,
        opt_text, text,
    },
};
use ycoding_core::ycoding_schema::{DomainEncode, JsonValue, LosslessString, session};
use ycoding_protocol::v5;

type R<T> = Result<T, Unrepresentable>;

pub struct Record {
    pub item: v5::SessionLogItem,
    pub event_id: String,
    pub created_ms: i64,
    pub seq: u64,
    pub version: u32,
}

pub fn record(
    entry: &ycoding_core::session::log::Entry,
    session: &session::Id,
    source_epoch: &LosslessString,
) -> R<Record> {
    use v5::session_log_item::Kind;
    let event = &entry.event.0;
    let encoded = event.data.encode();
    let data = J(&encoded);
    let seq = u64::try_from(entry.seq).map_err(|_| Unrepresentable("event seq"))?;
    let version = u32::try_from(entry.version).map_err(|_| Unrepresentable("event version"))?;
    let expected = match event.event_type.as_str() {
        Some(
            "session.created"
            | "session.deleted"
            | "session.archived"
            | "session.unarchived"
            | "session.forked"
            | "session.instructions.updated"
            | "session.compaction.admitted"
            | "session.compaction.started"
            | "session.compaction.ended"
            | "session.compaction.failed",
        ) => 2,
        _ => 1,
    };
    let position = event
        .durable
        .as_ref()
        .ok_or(Unrepresentable("durable envelope"))?;
    if entry.version != expected
        || position.version.get() != entry.version
        || position.seq.get() as u64 != seq
        || position.aggregate_id != *session.as_lossless()
        || data.field("sessionID")?.0 != &JsonValue::String(session.as_lossless().clone())
    {
        return Err(Unrepresentable("durable envelope"));
    }
    macro_rules! item {
        ($variant:ident, $value:ident, $data:expr) => {{
            let mut output = v5::$value {
                id: wire(event.id.as_lossless()),
                created: event.created.epoch_millis() as f64,
                metadata: None,
                source_epoch: wire(source_epoch),
                r#type: 1,
                durable: Default::default(),
                location: event
                    .location
                    .as_ref()
                    .map(|location| payload::location(J(&location.encode())))
                    .transpose()?,
                data: $data,
            };
            output.durable.aggregate_id = wire(session.as_lossless());
            output.durable.seq = seq;
            output.durable.version = entry.version;
            if let Some(metadata) = &event.metadata {
                let entries = &mut output.metadata.insert(Default::default()).entries;
                for (key, value) in metadata.iter() {
                    entries.push(Default::default());
                    let entry = entries
                        .last_mut()
                        .ok_or(Unrepresentable("event metadata"))?;
                    entry.key = wire(key);
                    entry.value = convert::json_to_value(value);
                }
            }
            Kind::$variant(output)
        }};
    }
    macro_rules! object {
        ($value:expr, $wrapper:ident, $entry:ident) => {
            v5::$wrapper {
                entries: message::object_entries($value, |key, value| v5::$entry { key, value })?,
            }
        };
    }
    let item = match entry.event.0.event_type.as_str() {
        Some("session.created") => item!(
            Value1,
            SessionLogItemValue1,
            v5::SessionLogItemValue1Data {
                session_id: text(data, "sessionID")?,
                project_id: text(data, "projectID")?,
                location: payload::location(data.field("location")?)?,
                parent_id: opt_text(data, "parentID")?,
                agent: opt_text(data, "agent")?,
                model: data.opt("model").map(message::model_ref).transpose()?,
                permission_ceiling: data
                    .opt("permissionCeiling")
                    .map(payload::rules)
                    .transpose()?,
                title: text(data, "title")?,
                subpath: opt_text(data, "subpath")?,
                created: count(data, "created")?,
            }
        ),
        Some("session.agent.selected") => item!(
            Value2,
            SessionLogItemValue2,
            v5::SessionLogItemValue2Data {
                session_id: text(data, "sessionID")?,
                agent: text(data, "agent")?,
                artifact: data.opt("artifact").map(payload::artifact).transpose()?
            }
        ),
        Some("session.model.selected") => item!(
            Value3,
            SessionLogItemValue3,
            v5::SessionLogItemValue3Data {
                session_id: text(data, "sessionID")?,
                model: message::model_ref(data.field("model")?)?
            }
        ),
        Some("session.daybreak.set") => item!(
            Value4,
            SessionLogItemValue4,
            v5::SessionLogItemValue4Data {
                session_id: text(data, "sessionID")?,
                daybreak: opt_literal(
                    data,
                    "daybreak",
                    &[("daybreak_blue", 1), ("daybreak_red", 2)]
                )?
            }
        ),
        Some("session.project-artifacts-ended") => item!(
            Value5,
            SessionLogItemValue5,
            v5::SessionLogItemValue5Data {
                session_id: text(data, "sessionID")?,
                old_project_id: text(data, "oldProjectID")?,
                new_project_id: text(data, "newProjectID")?
            }
        ),
        Some("session.moved") => item!(
            Value6,
            SessionLogItemValue6,
            v5::SessionLogItemValue6Data {
                session_id: text(data, "sessionID")?,
                location: payload::location(data.field("location")?)?,
                project_id: opt_text(data, "projectID")?,
                subpath: opt_text(data, "subpath")?
            }
        ),
        Some("session.renamed") => item!(
            Value7,
            SessionLogItemValue7,
            v5::SessionLogItemValue7Data {
                session_id: text(data, "sessionID")?,
                title: text(data, "title")?
            }
        ),
        Some("session.deleted") => item!(
            Value8,
            SessionLogItemValue8,
            v5::SessionLogItemValue8Data {
                session_id: text(data, "sessionID")?
            }
        ),
        Some("session.archived") => item!(
            Value9,
            SessionLogItemValue9,
            v5::SessionLogItemValue9Data {
                session_id: text(data, "sessionID")?
            }
        ),
        Some("session.unarchived") => item!(
            Value10,
            SessionLogItemValue10,
            v5::SessionLogItemValue10Data {
                session_id: text(data, "sessionID")?
            }
        ),
        Some("session.pinned") => item!(
            Value11,
            SessionLogItemValue11,
            v5::SessionLogItemValue11Data {
                session_id: text(data, "sessionID")?
            }
        ),
        Some("session.unpinned") => item!(
            Value12,
            SessionLogItemValue12,
            v5::SessionLogItemValue12Data {
                session_id: text(data, "sessionID")?
            }
        ),
        Some("session.forked") => item!(
            Value13,
            SessionLogItemValue13,
            v5::SessionLogItemValue13Data {
                session_id: text(data, "sessionID")?,
                parent_id: text(data, "parentID")?,
                parent_seq: number(data, "parentSeq")? as i64,
                from: opt_text(data, "from")?
            }
        ),
        Some("session.input.promoted") => item!(
            Value14,
            SessionLogItemValue14,
            v5::SessionLogItemValue14Data {
                session_id: text(data, "sessionID")?,
                input_id: text(data, "inputID")?
            }
        ),
        Some("session.input.admitted") => item!(
            Value15,
            SessionLogItemValue15,
            v5::SessionLogItemValue15Data {
                caused_by: data
                    .opt("causedBy")
                    .map(payload::usage_anchor)
                    .transpose()?,
                session_id: text(data, "sessionID")?,
                input_id: text(data, "inputID")?,
                input: payload::pending(data.field("input")?)?
            }
        ),
        Some("session.input.consumed") => item!(
            Value16,
            SessionLogItemValue16,
            v5::SessionLogItemValue16Data {
                session_id: text(data, "sessionID")?,
                input_i_ds: v5::SessionLogItemValue16DataInputIDs {
                    items: payload::strings(data.field("inputIDs")?)?
                }
            }
        ),
        Some("session.execution.started") => item!(
            Value17,
            SessionLogItemValue17,
            v5::SessionLogItemValue17Data {
                session_id: text(data, "sessionID")?
            }
        ),
        Some("session.execution.succeeded") => item!(
            Value18,
            SessionLogItemValue18,
            v5::SessionLogItemValue18Data {
                session_id: text(data, "sessionID")?
            }
        ),
        Some("session.execution.failed") => item!(
            Value19,
            SessionLogItemValue19,
            v5::SessionLogItemValue19Data {
                session_id: text(data, "sessionID")?,
                error: message::structured_error(data.field("error")?)?
            }
        ),
        Some("session.execution.interrupted") => item!(
            Value20,
            SessionLogItemValue20,
            v5::SessionLogItemValue20Data {
                session_id: text(data, "sessionID")?,
                reason: literal(
                    data,
                    "reason",
                    &[("user", 1), ("shutdown", 2), ("superseded", 3)]
                )?
            }
        ),
        Some("session.work.completed") => item!(
            Value21,
            SessionLogItemValue21,
            v5::SessionLogItemValue21Data {
                session_id: text(data, "sessionID")?,
                input_id: text(data, "inputID")?,
                assistant_message_id: text(data, "assistantMessageID")?
            }
        ),
        Some("session.instructions.updated") => item!(
            Value22,
            SessionLogItemValue22,
            v5::SessionLogItemValue22Data {
                session_id: text(data, "sessionID")?,
                delta: payload::delta(data.field("delta")?)?
            }
        ),
        Some("session.context.observed") => item!(
            Value23,
            SessionLogItemValue23,
            v5::SessionLogItemValue23Data {
                session_id: text(data, "sessionID")?,
                source: literal(
                    data,
                    "source",
                    &[("session-state", 1), ("team-view", 2), ("step-limit", 3)]
                )?,
                text: text(data, "text")?
            }
        ),
        Some("session.task.updated") => item!(
            Value24,
            SessionLogItemValue24,
            v5::SessionLogItemValue24Data {
                session_id: text(data, "sessionID")?,
                change: payload::change(data.field("change")?)?
            }
        ),
        Some("session.synthetic") => item!(
            Value25,
            SessionLogItemValue25,
            v5::SessionLogItemValue25Data {
                session_id: text(data, "sessionID")?,
                text: text(data, "text")?,
                description: opt_text(data, "description")?,
                metadata: data
                    .opt("metadata")
                    .map(|value| Ok(object!(
                        value,
                        SessionLogItemValue25DataMetadata,
                        SessionLogItemValue25DataMetadataEntry
                    )))
                    .transpose()?
            }
        ),
        Some("session.skill.activated") => item!(
            Value26,
            SessionLogItemValue26,
            v5::SessionLogItemValue26Data {
                session_id: text(data, "sessionID")?,
                id: text(data, "id")?,
                name: text(data, "name")?,
                text: text(data, "text")?,
                conflicts: data.opt("conflicts").map(payload::conflicts).transpose()?,
                artifact: data.opt("artifact").map(payload::artifact).transpose()?
            }
        ),
        Some("session.skill.deactivated") => item!(
            Value27,
            SessionLogItemValue27,
            v5::SessionLogItemValue27Data {
                session_id: text(data, "sessionID")?,
                id: text(data, "id")?,
                activation_message_id: text(data, "activationMessageID")?,
                reason: literal(data, "reason", &[("conflict_resolved", 1)])?
            }
        ),
        Some("session.shell.started") => item!(
            Value28,
            SessionLogItemValue28,
            v5::SessionLogItemValue28Data {
                session_id: text(data, "sessionID")?,
                shell: payload::shell(data.field("shell")?)?
            }
        ),
        Some("session.shell.ended") => {
            let output = data.field("output")?;
            item!(
                Value29,
                SessionLogItemValue29,
                v5::SessionLogItemValue29Data {
                    session_id: text(data, "sessionID")?,
                    shell: payload::shell(data.field("shell")?)?,
                    output: v5::SessionLogItemValue29DataOutput {
                        output: text(output, "output")?,
                        cursor: count(output, "cursor")?,
                        size: count(output, "size")?,
                        truncated: output.field("truncated")?.boolean()?
                    }
                }
            )
        }
        Some("session.step.started") => item!(
            Value30,
            SessionLogItemValue30,
            v5::SessionLogItemValue30Data {
                session_id: text(data, "sessionID")?,
                assistant_message_id: text(data, "assistantMessageID")?,
                agent: text(data, "agent")?,
                model: message::model_ref(data.field("model")?)?,
                snapshot: opt_text(data, "snapshot")?
            }
        ),
        Some("session.step.ended") => item!(
            Value31,
            SessionLogItemValue31,
            v5::SessionLogItemValue31Data {
                session_id: text(data, "sessionID")?,
                assistant_message_id: text(data, "assistantMessageID")?,
                finish: literal(data, "finish", payload::FINISH)?,
                cost: number(data, "cost")?,
                tokens: message::tokens(data.field("tokens")?)?,
                context_limit: opt_count(data, "contextLimit")?,
                context_breakdown: data
                    .opt("contextBreakdown")
                    .map(payload::breakdown)
                    .transpose()?,
                provider_cache: data
                    .opt("providerCache")
                    .map(payload::provider_cache)
                    .transpose()?,
                snapshot: opt_text(data, "snapshot")?,
                files: data
                    .opt("files")
                    .map(payload::strings)
                    .transpose()?
                    .map(|items| v5::SessionLogItemValue31DataFiles { items }),
            }
        ),
        Some("session.step.failed") => item!(
            Value32,
            SessionLogItemValue32,
            v5::SessionLogItemValue32Data {
                session_id: text(data, "sessionID")?,
                assistant_message_id: text(data, "assistantMessageID")?,
                error: message::structured_error(data.field("error")?)?,
                cost: opt_number(data, "cost")?,
                tokens: data.opt("tokens").map(message::tokens).transpose()?,
                context_limit: opt_count(data, "contextLimit")?,
                context_breakdown: data
                    .opt("contextBreakdown")
                    .map(payload::breakdown)
                    .transpose()?,
                provider_cache: data
                    .opt("providerCache")
                    .map(payload::provider_cache)
                    .transpose()?,
                snapshot: opt_text(data, "snapshot")?,
                files: data
                    .opt("files")
                    .map(payload::strings)
                    .transpose()?
                    .map(|items| v5::SessionLogItemValue32DataFiles { items }),
            }
        ),
        Some("session.text.started") => item!(
            Value33,
            SessionLogItemValue33,
            v5::SessionLogItemValue33Data {
                session_id: text(data, "sessionID")?,
                assistant_message_id: text(data, "assistantMessageID")?,
                ordinal: count(data, "ordinal")?,
                phase: opt_literal(data, "phase", payload::PHASE)?
            }
        ),
        Some("session.text.ended") => item!(
            Value34,
            SessionLogItemValue34,
            v5::SessionLogItemValue34Data {
                session_id: text(data, "sessionID")?,
                assistant_message_id: text(data, "assistantMessageID")?,
                ordinal: count(data, "ordinal")?,
                text: text(data, "text")?,
                phase: opt_literal(data, "phase", payload::PHASE)?
            }
        ),
        Some("session.reasoning.started") => item!(
            Value35,
            SessionLogItemValue35,
            v5::SessionLogItemValue35Data {
                session_id: text(data, "sessionID")?,
                assistant_message_id: text(data, "assistantMessageID")?,
                ordinal: count(data, "ordinal")?,
                state: data.opt("state").map(message::provider_state).transpose()?
            }
        ),
        Some("session.reasoning.ended") => item!(
            Value36,
            SessionLogItemValue36,
            v5::SessionLogItemValue36Data {
                session_id: text(data, "sessionID")?,
                assistant_message_id: text(data, "assistantMessageID")?,
                ordinal: count(data, "ordinal")?,
                text: text(data, "text")?,
                state: data.opt("state").map(message::provider_state).transpose()?
            }
        ),
        Some("session.tool.input.started") => item!(
            Value37,
            SessionLogItemValue37,
            v5::SessionLogItemValue37Data {
                session_id: text(data, "sessionID")?,
                assistant_message_id: text(data, "assistantMessageID")?,
                call_id: text(data, "callID")?,
                name: text(data, "name")?
            }
        ),
        Some("session.tool.input.ended") => item!(
            Value38,
            SessionLogItemValue38,
            v5::SessionLogItemValue38Data {
                session_id: text(data, "sessionID")?,
                assistant_message_id: text(data, "assistantMessageID")?,
                call_id: text(data, "callID")?,
                text: text(data, "text")?
            }
        ),
        Some("session.tool.called") => item!(
            Value39,
            SessionLogItemValue39,
            v5::SessionLogItemValue39Data {
                session_id: text(data, "sessionID")?,
                assistant_message_id: text(data, "assistantMessageID")?,
                call_id: text(data, "callID")?,
                input: object!(
                    data.field("input")?,
                    SessionLogItemValue39DataInput,
                    SessionLogItemValue39DataInputEntry
                ),
                executed: data.field("executed")?.boolean()?,
                state: data.opt("state").map(message::provider_state).transpose()?
            }
        ),
        Some("session.tool.success") => item!(
            Value41,
            SessionLogItemValue41,
            v5::SessionLogItemValue41Data {
                session_id: text(data, "sessionID")?,
                assistant_message_id: text(data, "assistantMessageID")?,
                call_id: text(data, "callID")?,
                structured: object!(
                    data.field("structured")?,
                    SessionLogItemValue41DataStructured,
                    SessionLogItemValue41DataStructuredEntry
                ),
                content: v5::SessionLogItemValue41DataContent {
                    items: message::tool_contents(data.field("content")?)?
                },
                result: data
                    .opt("result")
                    .map(|value| convert::json_to_value(value.0)),
                executed: data.field("executed")?.boolean()?,
                result_state: data
                    .opt("resultState")
                    .map(message::provider_state)
                    .transpose()?
            }
        ),
        Some("session.tool.failed") => item!(
            Value42,
            SessionLogItemValue42,
            v5::SessionLogItemValue42Data {
                session_id: text(data, "sessionID")?,
                assistant_message_id: text(data, "assistantMessageID")?,
                call_id: text(data, "callID")?,
                error: message::structured_error(data.field("error")?)?,
                result: data
                    .opt("result")
                    .map(|value| convert::json_to_value(value.0)),
                executed: data.field("executed")?.boolean()?,
                result_state: data
                    .opt("resultState")
                    .map(message::provider_state)
                    .transpose()?
            }
        ),
        Some("session.file-change.recorded") => {
            let change = data.field("change")?;
            item!(
                Value43,
                SessionLogItemValue43,
                v5::SessionLogItemValue43Data {
                    session_id: text(data, "sessionID")?,
                    change: v5::SessionEventFileChangeInfo {
                        path: text(change, "path")?,
                        patch: text(change, "patch")?,
                        additions: count(change, "additions")?,
                        deletions: count(change, "deletions")?
                    }
                }
            )
        }
        Some("session.retry.scheduled") => item!(
            Value44,
            SessionLogItemValue44,
            v5::SessionLogItemValue44Data {
                session_id: text(data, "sessionID")?,
                assistant_message_id: text(data, "assistantMessageID")?,
                attempt: count(data, "attempt")?,
                at: count(data, "at")?,
                error: message::structured_error(data.field("error")?)?
            }
        ),
        Some("session.compaction.admitted") => item!(
            Value45,
            SessionLogItemValue45,
            v5::SessionLogItemValue45Data {
                usage_anchor: data
                    .opt("usageAnchor")
                    .map(payload::usage_anchor)
                    .transpose()?,
                session_id: text(data, "sessionID")?,
                job_id: text(data, "jobID")?,
                pressure: data.opt("pressure").map(payload::pressure).transpose()?
            }
        ),
        Some("session.compaction.started") => item!(
            Value46,
            SessionLogItemValue46,
            v5::SessionLogItemValue46Data {
                session_id: text(data, "sessionID")?,
                job_id: text(data, "jobID")?
            }
        ),
        Some("session.compaction.ended") => item!(
            Value47,
            SessionLogItemValue47,
            v5::SessionLogItemValue47Data {
                session_id: text(data, "sessionID")?,
                job_id: text(data, "jobID")?,
                revision: count(data, "revision")?,
                boundary: payload::boundary(data.field("boundary")?)?,
                metrics: payload::metrics(data.field("metrics")?)?
            }
        ),
        Some("session.compaction.failed") => item!(
            Value48,
            SessionLogItemValue48,
            v5::SessionLogItemValue48Data {
                session_id: text(data, "sessionID")?,
                job_id: text(data, "jobID")?,
                code: literal(data, "code", payload::FAILURE)?,
                error: message::structured_error(data.field("error")?)?
            }
        ),
        Some("session.revert.staged") => item!(
            Value49,
            SessionLogItemValue49,
            v5::SessionLogItemValue49Data {
                session_id: text(data, "sessionID")?,
                revert: convert::revert(data.field("revert")?.0)
                    .map_err(|_| Unrepresentable("revert"))?
            }
        ),
        Some("session.revert.cleared") => item!(
            Value50,
            SessionLogItemValue50,
            v5::SessionLogItemValue50Data {
                session_id: text(data, "sessionID")?
            }
        ),
        Some("session.revert.committed") => item!(
            Value51,
            SessionLogItemValue51,
            v5::SessionLogItemValue51Data {
                session_id: text(data, "sessionID")?,
                to: text(data, "to")?
            }
        ),
        Some("session.guardrail.dismissed") => item!(
            Value53,
            SessionLogItemValue53,
            v5::SessionLogItemValue53Data {
                session_id: text(data, "sessionID")?,
                review_session_id: text(data, "reviewSessionID")?,
                rule_id: text(data, "ruleID")?,
                confidence: number(data, "confidence")?,
                source: data.opt("source").map(payload::source).transpose()?
            }
        ),
        Some("session.guardrail.escalated") => item!(
            Value54,
            SessionLogItemValue54,
            v5::SessionLogItemValue54Data {
                session_id: text(data, "sessionID")?,
                request_id: text(data, "requestID")?,
                choice: opt_literal(data, "choice", payload::CHOICE)?,
                confidence: opt_number(data, "confidence")?,
                grades: data
                    .opt("grades")
                    .map(|grades| payload::grades(grades)
                        .map(|items| v5::SessionLogItemValue54DataGrades { items }))
                    .transpose()?,
                rule_i_ds: data
                    .opt("ruleIDs")
                    .map(|rules| payload::strings(rules)
                        .map(|items| v5::SessionLogItemValue54DataRuleIDs { items }))
                    .transpose()?,
                source: data.opt("source").map(payload::source).transpose()?
            }
        ),
        Some("session.guardrail.decided") => item!(
            Value55,
            SessionLogItemValue55,
            v5::SessionLogItemValue55Data {
                session_id: text(data, "sessionID")?,
                review_session_id: text(data, "reviewSessionID")?,
                request_id: text(data, "requestID")?,
                reply: literal(data, "reply", payload::REPLY)?,
                choice: opt_literal(data, "choice", payload::CHOICE)?,
                grades: data
                    .opt("grades")
                    .map(|grades| payload::grades(grades)
                        .map(|items| v5::SessionLogItemValue55DataGrades { items }))
                    .transpose()?,
                confidence: opt_number(data, "confidence")?,
                rule_i_ds: data
                    .opt("ruleIDs")
                    .map(|rules| payload::strings(rules)
                        .map(|items| v5::SessionLogItemValue55DataRuleIDs { items }))
                    .transpose()?,
                source: data.opt("source").map(payload::source).transpose()?
            }
        ),
        Some("session.review.deferred") => item!(
            Value56,
            SessionLogItemValue56,
            v5::SessionLogItemValue56Data {
                session_id: text(data, "sessionID")?,
                item_id: text(data, "itemID")?,
                kind: literal(data, "kind", payload::REVIEW_KIND)?,
                reason: literal(data, "reason", payload::REVIEW_REASON)?,
                choice: opt_text(data, "choice")?,
                confidence: opt_number(data, "confidence")?,
                grades: data
                    .opt("grades")
                    .map(|grades| payload::grades(grades)
                        .map(|items| v5::SessionLogItemValue56DataGrades { items }))
                    .transpose()?,
                origin: payload::origin(data.field("origin")?)?,
                payload: payload::review_payload(data.field("payload")?)?
            }
        ),
        Some("session.review.decided") => item!(
            Value57,
            SessionLogItemValue57,
            v5::SessionLogItemValue57Data {
                session_id: text(data, "sessionID")?,
                item_id: text(data, "itemID")?,
                decision: payload::review_decision(data.field("decision")?)?
            }
        ),
        Some("session.review.withdrawn") => item!(
            Value58,
            SessionLogItemValue58,
            v5::SessionLogItemValue58Data {
                session_id: text(data, "sessionID")?,
                item_id: text(data, "itemID")?,
                reason: literal(data, "reason", payload::WITHDRAWN)?
            }
        ),
        Some("session.review.consumed") => item!(
            Value59,
            SessionLogItemValue59,
            v5::SessionLogItemValue59Data {
                session_id: text(data, "sessionID")?,
                item_id: text(data, "itemID")?
            }
        ),
        Some("session.step.rerouted") => item!(
            Value60,
            SessionLogItemValue60,
            v5::SessionLogItemValue60Data {
                session_id: text(data, "sessionID")?,
                assistant_message_id: text(data, "assistantMessageID")?,
                model: message::model_ref(data.field("model")?)?,
                error: message::structured_error(data.field("error")?)?
            }
        ),
        _ => return Err(Unrepresentable("session log event")),
    };
    Ok(Record {
        item: v5::SessionLogItem { kind: Some(item) },
        event_id: event
            .id
            .as_lossless()
            .to_utf8()
            .map_err(|_| Unrepresentable("event identifier"))?,
        created_ms: entry.event.0.created.epoch_millis(),
        seq,
        version,
    })
}

pub fn excluded(type_: &str) -> bool {
    matches!(
        type_,
        "session.profile.bound.1"
            | "session.tool.progress.1"
            | "session.guardrail.approved.1"
            | "session.usage.recorded.1"
            | "session.provider.request.recorded.1"
            | "session.compaction.admitted.1"
            | "session.compaction.started.1"
            | "session.compaction.ended.1"
            | "session.compaction.failed.1"
            | "session.compaction.replaced.1"
    )
}

pub fn synced(
    session: &session::Id,
    watermark: Option<i64>,
    source_epoch: &LosslessString,
) -> v5::SessionLogItem {
    v5::SessionLogItem {
        kind: Some(v5::session_log_item::Kind::Value52(
            v5::SessionLogItemValue52 {
                r#type: 1,
                aggregate_id: wire(session.as_lossless()),
                seq: watermark.map(|watermark| watermark as u64),
                source_epoch: wire(source_epoch),
            },
        )),
    }
}
