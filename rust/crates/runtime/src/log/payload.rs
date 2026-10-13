use crate::{
    convert,
    message::{self, J, Unrepresentable},
};
use message::{count, literal, number, opt_count, opt_number, opt_text, text};
use ycoding_core::ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, location, session_pending,
};
use ycoding_protocol::v5;

type R<T> = Result<T, Unrepresentable>;

pub(super) fn location(json: J) -> R<v5::LocationRef> {
    let location = location::Ref::decode(json.0).map_err(|_| Unrepresentable("event location"))?;
    Ok(v5::LocationRef {
        directory: convert::wire(location.directory.as_lossless()),
        workspace_id: location
            .workspace_id
            .as_ref()
            .map(|id| convert::wire(id.as_lossless())),
    })
}

pub(super) fn artifact(json: J) -> R<v5::SessionEventArtifactProvenance> {
    Ok(v5::SessionEventArtifactProvenance {
        scope_id: text(json, "scopeID")?,
        version_id: text(json, "versionID")?,
        kind: literal(
            json,
            "kind",
            &[("skill", 1), ("command", 2), ("agent", 3), ("plugin", 4)],
        )?,
        id: text(json, "id")?,
        source_scope: literal(json, "sourceScope", &[("project", 1), ("global", 2)])?,
    })
}

pub(super) fn rules(json: J) -> R<v5::PermissionRuleset> {
    Ok(v5::PermissionRuleset {
        items: json
            .items()?
            .iter()
            .map(|value| {
                let json = J(value);
                Ok(v5::PermissionRule {
                    action: text(json, "action")?,
                    resource: text(json, "resource")?,
                    effect: literal(json, "effect", &[("allow", 1), ("deny", 2), ("ask", 3)])?,
                })
            })
            .collect::<R<_>>()?,
    })
}

pub(super) fn strings(json: J) -> R<Vec<v5::LosslessString>> {
    json.items()?.iter().map(|value| J(value).text()).collect()
}

pub(super) fn pending(json: J) -> R<v5::SessionPendingMessage> {
    use v5::session_pending_message::Kind;
    let input =
        session_pending::Message::decode(json.0).map_err(|_| Unrepresentable("pending input"))?;
    Ok(v5::SessionPendingMessage {
        kind: Some(match input {
            session_pending::Message::User(input) => Kind::Value1(v5::SessionPendingUserMessage {
                r#type: 1,
                data: message::user_data(&input.data.encode())?,
                delivery: match input.delivery.encode() {
                    JsonValue::String(name) => message::delivery(name.as_str())?,
                    _ => return Err(Unrepresentable("delivery")),
                },
            }),
            session_pending::Message::Synthetic(input) => {
                Kind::Value2(v5::SessionPendingSyntheticMessage {
                    r#type: 1,
                    data: message::synthetic_data(&input.data.encode())?,
                    delivery: match input.delivery.encode() {
                        JsonValue::String(name) => message::delivery(name.as_str())?,
                        _ => return Err(Unrepresentable("delivery")),
                    },
                })
            }
        }),
    })
}

pub(super) fn delta(json: J) -> R<v5::SessionLogItemValue22DataDelta> {
    let JsonValue::Object(object) = json.0 else {
        return Err(Unrepresentable("instruction delta"));
    };
    Ok(v5::SessionLogItemValue22DataDelta {
        entries: object
            .iter()
            .map(|(key, value)| {
                use v5::session_log_item_value22_data_delta_entry_value::Kind;
                Ok(v5::SessionLogItemValue22DataDeltaEntry {
                    key: convert::wire(key),
                    value: v5::SessionLogItemValue22DataDeltaEntryValue {
                        kind: Some(if value == &JsonValue::String("removed".into()) {
                            Kind::Value2(1)
                        } else {
                            Kind::Value1(J(value).text()?)
                        }),
                    },
                })
            })
            .collect::<R<_>>()?,
    })
}

pub(super) fn change(json: J) -> R<v5::SessionLogItemValue24DataChange> {
    use v5::session_log_item_value24_data_change::Kind;
    let JsonValue::String(name) = json.field("type")?.0 else {
        return Err(Unrepresentable("task change"));
    };
    let kind = match name.as_str() {
        Some("launched") => Kind::Value1(v5::SessionLogItemValue24DataChangeValue1 {
            r#type: 1,
            parent_id: text(json, "parentID")?,
            parent_assistant_message_id: text(json, "parentAssistantMessageID")?,
            tool_call_id: text(json, "toolCallID")?,
            input_id: text(json, "inputID")?,
            description: text(json, "description")?,
            agent: text(json, "agent")?,
            model: message::model_ref(json.field("model")?)?,
            prompt_digest: text(json, "promptDigest")?,
            background: json.field("background")?.boolean()?,
            delivery: literal(json, "delivery", &[("steer", 1), ("queue", 2)])?,
        }),
        Some("started") => Kind::Value2(v5::SessionLogItemValue24DataChangeValue2 { r#type: 1 }),
        Some("backgrounded") => {
            Kind::Value3(v5::SessionLogItemValue24DataChangeValue3 { r#type: 1 })
        }
        Some("progressed") => {
            let data = json.field("progress")?;
            Kind::Value4(v5::SessionLogItemValue24DataChangeValue4 {
                r#type: 1,
                progress: v5::SessionOrchestrationProgress {
                    text: text(data, "text")?,
                    time: count(data, "time")?,
                },
            })
        }
        Some("question_asked") => {
            let data = json.field("question")?;
            Kind::Value5(v5::SessionLogItemValue24DataChangeValue5 {
                r#type: 1,
                question: v5::SessionOrchestrationQuestion {
                    id: text(data, "id")?,
                    text: text(data, "text")?,
                    time: count(data, "time")?,
                    data: data
                        .opt("data")
                        .map(|value| convert::json_to_value(value.0)),
                },
            })
        }
        Some("question_answered") => {
            let data = json.field("answer")?;
            Kind::Value6(v5::SessionLogItemValue24DataChangeValue6 {
                r#type: 1,
                answer: v5::SessionOrchestrationAnswer {
                    question_id: text(data, "questionID")?,
                    text: opt_text(data, "text")?,
                    data: data
                        .opt("data")
                        .map(|value| convert::json_to_value(value.0)),
                },
            })
        }
        Some("cancel_requested") => {
            Kind::Value7(v5::SessionLogItemValue24DataChangeValue7 { r#type: 1 })
        }
        Some("cancelled") => Kind::Value8(v5::SessionLogItemValue24DataChangeValue8 { r#type: 1 }),
        Some("completed") => Kind::Value9(v5::SessionLogItemValue24DataChangeValue9 {
            r#type: 1,
            excerpt: opt_text(json, "excerpt")?,
        }),
        Some("failed") => Kind::Value10(v5::SessionLogItemValue24DataChangeValue10 {
            r#type: 1,
            error: text(json, "error")?,
            excerpt: opt_text(json, "excerpt")?,
        }),
        Some("lost") => Kind::Value11(v5::SessionLogItemValue24DataChangeValue11 {
            r#type: 1,
            excerpt: opt_text(json, "excerpt")?,
        }),
        _ => return Err(Unrepresentable("task change")),
    };
    Ok(v5::SessionLogItemValue24DataChange { kind: Some(kind) })
}

pub(super) fn conflicts(json: J) -> R<v5::SkillConflicts> {
    Ok(v5::SkillConflicts {
        skills: v5::SkillConflictsSkills {
            items: strings(json.field("skills")?)?,
        },
        instructions: v5::SkillConflictsInstructions {
            items: strings(json.field("instructions")?)?,
        },
    })
}

pub(super) fn shell(json: J) -> R<v5::ShellInfo> {
    let time = json.field("time")?;
    Ok(v5::ShellInfo {
        id: text(json, "id")?,
        status: literal(
            json,
            "status",
            &[
                ("running", 1),
                ("exited", 2),
                ("timeout", 3),
                ("memory-limit", 4),
                ("killed", 5),
            ],
        )?,
        command: text(json, "command")?,
        cwd: text(json, "cwd")?,
        shell: text(json, "shell")?,
        file: text(json, "file")?,
        pid: opt_count(json, "pid")?,
        exit: opt_number(json, "exit")?,
        tool_call_id: opt_text(json, "toolCallID")?,
        metadata: v5::ShellInfoMetadata {
            entries: message::object_entries(json.field("metadata")?, |key, value| {
                v5::ShellInfoMetadataEntry { key, value }
            })?,
        },
        time: v5::ShellInfoTime {
            started: number(time, "started")?,
            completed: opt_number(time, "completed")?,
        },
    })
}

pub(super) fn breakdown(json: J) -> R<v5::SessionContextBreakdown> {
    Ok(v5::SessionContextBreakdown {
        system: count(json, "system")?,
        tools: count(json, "tools")?,
        user: count(json, "user")?,
        assistant: count(json, "assistant")?,
        reasoning: count(json, "reasoning")?,
        tool_calls: count(json, "toolCalls")?,
        other: count(json, "other")?,
    })
}

pub(super) fn provider_cache(json: J) -> R<v5::SessionProviderCacheDiagnostics> {
    Ok(v5::SessionProviderCacheDiagnostics {
        mechanism: literal(
            json,
            "mechanism",
            &[
                ("openai-prefix-cache", 1),
                ("openrouter-cache-control", 2),
                ("anthropic-cache-control", 3),
                ("bedrock-cache-point", 4),
                ("gemini-prefix-cache", 5),
                ("provider-reported", 6),
                ("none", 7),
            ],
        )?,
        read_reported: json.field("readReported")?.boolean()?,
        write_reported: json.field("writeReported")?.boolean()?,
    })
}

pub(super) fn pressure(json: J) -> R<v5::SessionCompactionPressure> {
    Ok(v5::SessionCompactionPressure {
        estimated_input_tokens: count(json, "estimatedInputTokens")?,
        safe_input_tokens: count(json, "safeInputTokens")?,
    })
}

pub(super) fn boundary(json: J) -> R<v5::SessionCompactionBoundary> {
    Ok(v5::SessionCompactionBoundary {
        message_id: text(json, "messageID")?,
        seq: count(json, "seq")?,
    })
}

pub(super) fn metrics(json: J) -> R<v5::SessionCompactionMetrics> {
    Ok(v5::SessionCompactionMetrics {
        excluded_messages: count(json, "excludedMessages")?,
        excluded_parts: count(json, "excludedParts")?,
        input_tokens: count(json, "inputTokens")?,
        retained_tokens: count(json, "retainedTokens")?,
    })
}

pub(super) const PHASE: &[(&str, i32)] = &[("commentary", 1), ("final_answer", 2)];
pub(super) const FINISH: &[(&str, i32)] = &[
    ("stop", 1),
    ("length", 2),
    ("tool-calls", 3),
    ("content-filter", 4),
    ("error", 5),
    ("unknown", 6),
];
pub(super) const FAILURE: &[(&str, i32)] = &[
    ("cancelled", 1),
    ("superseded", 2),
    ("invalid_manifest", 3),
    ("protected_state_changed", 4),
    ("context_limit_unresolved", 5),
    ("migration_failed", 6),
    ("provider_failed", 7),
];
