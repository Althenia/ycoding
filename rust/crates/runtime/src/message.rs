use crate::convert::{json_to_value, wire};
use ycoding_core::ycoding_schema::{DomainEncode, JsonValue, LosslessString, session_message};
use ycoding_core::ycoding_store::session::Pending;
use ycoding_protocol::v5;

#[derive(Debug)]
pub struct Unrepresentable(pub &'static str);

type R<T> = Result<T, Unrepresentable>;

#[derive(Clone, Copy)]
pub(crate) struct J<'a>(pub(crate) &'a JsonValue);

impl<'a> J<'a> {
    pub(crate) fn opt(self, key: &str) -> Option<J<'a>> {
        let JsonValue::Object(object) = self.0 else {
            return None;
        };
        object.get(&LosslessString::from(key)).map(J)
    }

    pub(crate) fn field(self, key: &'static str) -> R<J<'a>> {
        self.opt(key).ok_or(Unrepresentable(key))
    }

    pub(crate) fn text(self) -> R<v5::LosslessString> {
        match self.0 {
            JsonValue::String(text) => Ok(wire(text)),
            _ => Err(Unrepresentable("string")),
        }
    }

    pub(crate) fn number(self) -> R<f64> {
        match self.0 {
            JsonValue::Number(number) => Ok(*number),
            _ => Err(Unrepresentable("number")),
        }
    }

    pub(crate) fn count(self) -> R<u64> {
        let number = self.number()?;
        if number >= 0.0 && number.fract() == 0.0 && number <= 9_007_199_254_740_991.0 {
            return Ok(number as u64);
        }
        Err(Unrepresentable("count"))
    }

    pub(crate) fn boolean(self) -> R<bool> {
        match self.0 {
            JsonValue::Bool(value) => Ok(*value),
            _ => Err(Unrepresentable("boolean")),
        }
    }

    pub(crate) fn items(self) -> R<&'a [JsonValue]> {
        match self.0 {
            JsonValue::Array(items) => Ok(items),
            _ => Err(Unrepresentable("array")),
        }
    }
}

pub(crate) fn text(json: J, key: &'static str) -> R<v5::LosslessString> {
    json.field(key)?.text()
}

pub(crate) fn opt_text(json: J, key: &str) -> R<Option<v5::LosslessString>> {
    json.opt(key).map(J::text).transpose()
}

pub(crate) fn number(json: J, key: &'static str) -> R<f64> {
    json.field(key)?.number()
}

pub(crate) fn opt_number(json: J, key: &str) -> R<Option<f64>> {
    json.opt(key).map(J::number).transpose()
}

pub(crate) fn count(json: J, key: &'static str) -> R<u64> {
    json.field(key)?.count()
}

pub(crate) fn opt_count(json: J, key: &str) -> R<Option<u64>> {
    json.opt(key).map(J::count).transpose()
}

pub(crate) fn literal(json: J, key: &'static str, table: &[(&str, i32)]) -> R<i32> {
    let JsonValue::String(value) = json.field(key)?.0 else {
        return Err(Unrepresentable(key));
    };
    table
        .iter()
        .find(|(name, _)| value.as_str() == Some(name))
        .map(|(_, number)| *number)
        .ok_or(Unrepresentable(key))
}

pub(crate) fn opt_literal(json: J, key: &'static str, table: &[(&str, i32)]) -> R<Option<i32>> {
    json.opt(key).map(|_| literal(json, key, table)).transpose()
}

pub(crate) fn object_entries<T>(
    value: J,
    make: impl Fn(v5::LosslessString, v5::Value) -> T,
) -> R<Vec<T>> {
    let JsonValue::Object(object) = value.0 else {
        return Err(Unrepresentable("object"));
    };
    Ok(object
        .iter()
        .map(|(key, value)| make(wire(key), json_to_value(value)))
        .collect())
}

macro_rules! entries {
    ($value:expr, $entry:ident) => {
        object_entries($value, |key, value| v5::$entry { key, value })?
    };
}

macro_rules! metadata {
    ($json:expr, $wrapper:ident, $entry:ident) => {
        match $json.opt("metadata") {
            Some(value) => Some(v5::$wrapper {
                entries: entries!(value, $entry),
            }),
            None => None,
        }
    };
}

const TRIGGER: &[(&str, i32)] = &[
    ("consider", 1),
    ("advised", 2),
    ("mandatory", 3),
    ("manual", 4),
];
const REASON: &[(&str, i32)] = &[("auto", 1), ("manual", 2)];

pub fn message(info: &session_message::Info) -> R<v5::SessionMessageInfo> {
    use session_message::Info;
    use v5::session_message_info::Kind;
    let value = info.encode();
    let json = J(&value);
    let kind = match info {
        Info::AgentSelected(_) => Kind::Value1(agent_selected(json)?),
        Info::ModelSelected(_) => Kind::Value2(model_selected(json)?),
        Info::User(_) => Kind::Value3(user(json)?),
        Info::Synthetic(_) => Kind::Value4(synthetic(json)?),
        Info::System(_) => Kind::Value5(system(json)?),
        Info::Skill(_) => Kind::Value6(skill(json)?),
        Info::Shell(_) => Kind::Value7(shell(json)?),
        Info::Assistant(_) => Kind::Value8(assistant(json)?),
        Info::Compaction(compaction) => Kind::Value9(compaction_message(compaction, json)?),
    };
    Ok(v5::SessionMessageInfo { kind: Some(kind) })
}

fn artifact(json: J) -> R<v5::SessionMessageArtifactProvenance> {
    Ok(v5::SessionMessageArtifactProvenance {
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

pub(crate) fn model_ref(json: J) -> R<v5::ModelRef> {
    Ok(v5::ModelRef {
        id: text(json, "id")?,
        provider_id: text(json, "providerID")?,
        variant: opt_text(json, "variant")?,
        profile: opt_text(json, "profile")?,
    })
}

pub(crate) fn tokens(json: J) -> R<v5::TokenUsageInfo> {
    let cache = json.field("cache")?;
    Ok(v5::TokenUsageInfo {
        input: number(json, "input")?,
        output: number(json, "output")?,
        reasoning: number(json, "reasoning")?,
        cache: v5::TokenUsageInfoCache {
            read: number(cache, "read")?,
            write: number(cache, "write")?,
        },
    })
}

pub(crate) fn structured_error(json: J) -> R<v5::SessionStructuredError> {
    Ok(v5::SessionStructuredError {
        r#type: text(json, "type")?,
        message: text(json, "message")?,
    })
}

fn mention(json: J) -> R<v5::PromptMention> {
    Ok(v5::PromptMention {
        start: number(json, "start")?,
        end: number(json, "end")?,
        text: text(json, "text")?,
    })
}

fn agent_attachment(json: J) -> R<v5::PromptAgentAttachment> {
    Ok(v5::PromptAgentAttachment {
        name: text(json, "name")?,
        mention: json.opt("mention").map(mention).transpose()?,
    })
}

fn file_attachment(json: J) -> R<v5::PromptFileAttachment> {
    let content = json.field("content")?;
    Ok(v5::PromptFileAttachment {
        content: v5::PromptManagedAttachmentContent {
            r#type: 1,
            digest: text(content, "digest")?,
            bytes: count(content, "bytes")?,
            path: text(content, "path")?,
        },
        mime: text(json, "mime")?,
        name: opt_text(json, "name")?,
        description: opt_text(json, "description")?,
        mention: json.opt("mention").map(mention).transpose()?,
    })
}

fn files(json: J) -> R<Vec<v5::PromptFileAttachment>> {
    json.items()?
        .iter()
        .map(|item| file_attachment(J(item)))
        .collect()
}

fn agents(json: J) -> R<Vec<v5::PromptAgentAttachment>> {
    json.items()?
        .iter()
        .map(|item| agent_attachment(J(item)))
        .collect()
}

fn skill_deactivations(json: J) -> R<Vec<v5::SessionMessageSkillDeactivation>> {
    json.items()?
        .iter()
        .map(|item| {
            Ok(v5::SessionMessageSkillDeactivation {
                skill: text(J(item), "skill")?,
                reason: literal(J(item), "reason", &[("conflict_resolved", 1)])?,
            })
        })
        .collect()
}

fn agent_selected(json: J) -> R<v5::SessionMessageAgentSelected> {
    Ok(v5::SessionMessageAgentSelected {
        id: text(json, "id")?,
        metadata: metadata!(
            json,
            SessionMessageAgentSelectedMetadata,
            SessionMessageAgentSelectedMetadataEntry
        ),
        time: v5::SessionMessageAgentSelectedTime {
            created: number(json.field("time")?, "created")?,
        },
        r#type: 1,
        agent: text(json, "agent")?,
        artifact: json.opt("artifact").map(artifact).transpose()?,
    })
}

fn model_selected(json: J) -> R<v5::SessionMessageModelSelected> {
    Ok(v5::SessionMessageModelSelected {
        id: text(json, "id")?,
        metadata: metadata!(
            json,
            SessionMessageModelSelectedMetadata,
            SessionMessageModelSelectedMetadataEntry
        ),
        time: v5::SessionMessageModelSelectedTime {
            created: number(json.field("time")?, "created")?,
        },
        r#type: 1,
        model: model_ref(json.field("model")?)?,
        previous: json.opt("previous").map(model_ref).transpose()?,
    })
}

fn user(json: J) -> R<v5::SessionMessageUser> {
    let time = json.field("time")?;
    Ok(v5::SessionMessageUser {
        id: text(json, "id")?,
        metadata: metadata!(
            json,
            SessionMessageUserMetadata,
            SessionMessageUserMetadataEntry
        ),
        time: v5::SessionMessageUserTime {
            created: number(time, "created")?,
            consumed: opt_number(time, "consumed")?,
        },
        text: text(json, "text")?,
        files: json
            .opt("files")
            .map(files)
            .transpose()?
            .map(|items| v5::SessionMessageUserFiles { items }),
        agents: json
            .opt("agents")
            .map(agents)
            .transpose()?
            .map(|items| v5::SessionMessageUserAgents { items }),
        r#type: 1,
    })
}

fn synthetic(json: J) -> R<v5::SessionMessageSynthetic> {
    Ok(v5::SessionMessageSynthetic {
        id: text(json, "id")?,
        metadata: metadata!(
            json,
            SessionMessageSyntheticMetadata,
            SessionMessageSyntheticMetadataEntry
        ),
        time: v5::SessionMessageSyntheticTime {
            created: number(json.field("time")?, "created")?,
        },
        text: text(json, "text")?,
        description: opt_text(json, "description")?,
        r#type: 1,
    })
}

fn system(json: J) -> R<v5::SessionMessageSystem> {
    Ok(v5::SessionMessageSystem {
        id: text(json, "id")?,
        metadata: metadata!(
            json,
            SessionMessageSystemMetadata,
            SessionMessageSystemMetadataEntry
        ),
        time: v5::SessionMessageSystemTime {
            created: number(json.field("time")?, "created")?,
        },
        r#type: 1,
        text: text(json, "text")?,
    })
}

fn skill(json: J) -> R<v5::SessionMessageSkill> {
    let conflicts = json
        .opt("conflicts")
        .map(|conflicts| {
            let list = |key: &'static str| -> R<Vec<v5::LosslessString>> {
                conflicts
                    .field(key)?
                    .items()?
                    .iter()
                    .map(|item| J(item).text())
                    .collect()
            };
            Ok(v5::SkillConflicts {
                skills: v5::SkillConflictsSkills {
                    items: list("skills")?,
                },
                instructions: v5::SkillConflictsInstructions {
                    items: list("instructions")?,
                },
            })
        })
        .transpose()?;
    Ok(v5::SessionMessageSkill {
        id: text(json, "id")?,
        metadata: metadata!(
            json,
            SessionMessageSkillMetadata,
            SessionMessageSkillMetadataEntry
        ),
        time: v5::SessionMessageSkillTime {
            created: number(json.field("time")?, "created")?,
        },
        r#type: 1,
        skill: text(json, "skill")?,
        name: text(json, "name")?,
        text: text(json, "text")?,
        conflicts,
        skill_deactivations: json
            .opt("skillDeactivations")
            .map(skill_deactivations)
            .transpose()?
            .map(|items| v5::SessionMessageSkillSkillDeactivations { items }),
        artifact: json.opt("artifact").map(artifact).transpose()?,
    })
}

fn shell(json: J) -> R<v5::SessionMessageShell> {
    let time = json.field("time")?;
    Ok(v5::SessionMessageShell {
        id: text(json, "id")?,
        metadata: metadata!(
            json,
            SessionMessageShellMetadata,
            SessionMessageShellMetadataEntry
        ),
        time: v5::SessionMessageShellTime {
            created: number(time, "created")?,
            completed: opt_number(time, "completed")?,
        },
        r#type: 1,
        shell_id: text(json, "shellID")?,
        command: text(json, "command")?,
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
        exit: opt_number(json, "exit")?,
        output: json
            .opt("output")
            .map(|output| {
                Ok(v5::SessionMessageShellOutput {
                    output: text(output, "output")?,
                    cursor: count(output, "cursor")?,
                    size: count(output, "size")?,
                    truncated: output.field("truncated")?.boolean()?,
                })
            })
            .transpose()?,
    })
}

pub(crate) fn provider_state(json: J) -> R<v5::SessionMessageProviderState> {
    Ok(v5::SessionMessageProviderState {
        entries: entries!(json, SessionMessageProviderStateEntry),
    })
}

fn tool_content(json: J) -> R<v5::LlmToolContent> {
    use v5::llm_tool_content::Kind;
    let kind = match literal(json, "type", &[("text", 1), ("file", 2)])? {
        1 => Kind::Value1(v5::ToolTextContent {
            r#type: 1,
            text: text(json, "text")?,
        }),
        _ => Kind::Value2(v5::ToolFileContent {
            r#type: 1,
            uri: text(json, "uri")?,
            mime: text(json, "mime")?,
            name: opt_text(json, "name")?,
        }),
    };
    Ok(v5::LlmToolContent { kind: Some(kind) })
}

pub(crate) fn tool_contents(json: J) -> R<Vec<v5::LlmToolContent>> {
    json.items()?
        .iter()
        .map(|item| tool_content(J(item)))
        .collect()
}

fn tool_state(json: J) -> R<v5::SessionMessageAssistantToolState> {
    use v5::session_message_assistant_tool_state::Kind;
    let result = json.opt("result").map(|result| json_to_value(result.0));
    let kind = match literal(
        json,
        "status",
        &[
            ("streaming", 1),
            ("running", 2),
            ("completed", 3),
            ("error", 4),
        ],
    )? {
        1 => Kind::Value1(v5::SessionMessageToolStateStreaming {
            status: 1,
            input: text(json, "input")?,
        }),
        2 => Kind::Value2(v5::SessionMessageToolStateRunning {
            status: 1,
            input: v5::SessionMessageToolStateRunningInput {
                entries: entries!(
                    json.field("input")?,
                    SessionMessageToolStateRunningInputEntry
                ),
            },
            structured: v5::SessionMessageToolStateRunningStructured {
                entries: entries!(
                    json.field("structured")?,
                    SessionMessageToolStateRunningStructuredEntry
                ),
            },
            content: v5::SessionMessageToolStateRunningContent {
                items: tool_contents(json.field("content")?)?,
            },
        }),
        3 => Kind::Value3(v5::SessionMessageToolStateCompleted {
            status: 1,
            input: v5::SessionMessageToolStateCompletedInput {
                entries: entries!(
                    json.field("input")?,
                    SessionMessageToolStateCompletedInputEntry
                ),
            },
            content: v5::SessionMessageToolStateCompletedContent {
                items: tool_contents(json.field("content")?)?,
            },
            structured: v5::SessionMessageToolStateCompletedStructured {
                entries: entries!(
                    json.field("structured")?,
                    SessionMessageToolStateCompletedStructuredEntry
                ),
            },
            result,
        }),
        _ => Kind::Value4(v5::SessionMessageToolStateError {
            status: 1,
            input: v5::SessionMessageToolStateErrorInput {
                entries: entries!(json.field("input")?, SessionMessageToolStateErrorInputEntry),
            },
            content: v5::SessionMessageToolStateErrorContent {
                items: tool_contents(json.field("content")?)?,
            },
            structured: v5::SessionMessageToolStateErrorStructured {
                entries: entries!(
                    json.field("structured")?,
                    SessionMessageToolStateErrorStructuredEntry
                ),
            },
            error: structured_error(json.field("error")?)?,
            result,
        }),
    };
    Ok(v5::SessionMessageAssistantToolState { kind: Some(kind) })
}

fn assistant_item(json: J) -> R<v5::SessionMessageAssistantContentItem> {
    use v5::session_message_assistant_content_item::Kind;
    let kind = match literal(json, "type", &[("text", 1), ("reasoning", 2), ("tool", 3)])? {
        1 => Kind::Value1(v5::SessionMessageAssistantText {
            r#type: 1,
            text: text(json, "text")?,
            phase: opt_literal(json, "phase", &[("commentary", 1), ("final_answer", 2)])?,
        }),
        2 => Kind::Value2(v5::SessionMessageAssistantReasoning {
            r#type: 1,
            text: text(json, "text")?,
            state: json.opt("state").map(provider_state).transpose()?,
            time: json
                .opt("time")
                .map(|time| {
                    Ok(v5::SessionMessageAssistantReasoningTime {
                        created: number(time, "created")?,
                        completed: opt_number(time, "completed")?,
                    })
                })
                .transpose()?,
        }),
        _ => {
            let time = json.field("time")?;
            Kind::Value3(v5::SessionMessageAssistantTool {
                r#type: 1,
                id: text(json, "id")?,
                name: text(json, "name")?,
                executed: json.opt("executed").map(J::boolean).transpose()?,
                provider_state: json.opt("providerState").map(provider_state).transpose()?,
                provider_result_state: json
                    .opt("providerResultState")
                    .map(provider_state)
                    .transpose()?,
                state: tool_state(json.field("state")?)?,
                time: v5::SessionMessageAssistantToolTime {
                    created: number(time, "created")?,
                    ran: opt_number(time, "ran")?,
                    completed: opt_number(time, "completed")?,
                },
            })
        }
    };
    Ok(v5::SessionMessageAssistantContentItem { kind: Some(kind) })
}

fn assistant(json: J) -> R<v5::SessionMessageAssistant> {
    let time = json.field("time")?;
    Ok(v5::SessionMessageAssistant {
        id: text(json, "id")?,
        metadata: metadata!(
            json,
            SessionMessageAssistantMetadata,
            SessionMessageAssistantMetadataEntry
        ),
        time: v5::SessionMessageAssistantTime {
            created: number(time, "created")?,
            completed: opt_number(time, "completed")?,
        },
        r#type: 1,
        agent: text(json, "agent")?,
        model: model_ref(json.field("model")?)?,
        content: v5::SessionMessageAssistantContent {
            items: json
                .field("content")?
                .items()?
                .iter()
                .map(|item| assistant_item(J(item)))
                .collect::<R<_>>()?,
        },
        skill_deactivations: json
            .opt("skillDeactivations")
            .map(skill_deactivations)
            .transpose()?
            .map(|items| v5::SessionMessageAssistantSkillDeactivations { items }),
        snapshot: json
            .opt("snapshot")
            .map(|snapshot| {
                Ok(v5::SessionMessageAssistantSnapshot {
                    start: opt_text(snapshot, "start")?,
                    end: opt_text(snapshot, "end")?,
                    files: snapshot
                        .opt("files")
                        .map(|files| {
                            files
                                .items()?
                                .iter()
                                .map(|item| J(item).text())
                                .collect::<R<_>>()
                                .map(|items| v5::SessionMessageAssistantSnapshotFiles { items })
                        })
                        .transpose()?,
                })
            })
            .transpose()?,
        finish: opt_literal(
            json,
            "finish",
            &[
                ("stop", 1),
                ("length", 2),
                ("tool-calls", 3),
                ("content-filter", 4),
                ("error", 5),
                ("unknown", 6),
            ],
        )?,
        cost: opt_number(json, "cost")?,
        tokens: json.opt("tokens").map(tokens).transpose()?,
        diagnostics: json.opt("diagnostics").map(diagnostics).transpose()?,
        error: json.opt("error").map(structured_error).transpose()?,
        retry: json
            .opt("retry")
            .map(|retry| {
                Ok(v5::SessionMessageAssistantRetry {
                    attempt: count(retry, "attempt")?,
                    at: number(retry, "at")?,
                    error: structured_error(retry.field("error")?)?,
                })
            })
            .transpose()?,
    })
}

fn diagnostics(json: J) -> R<v5::SessionMessageAssistantDiagnostics> {
    Ok(v5::SessionMessageAssistantDiagnostics {
        context_limit: opt_count(json, "contextLimit")?,
        context_breakdown: json
            .opt("contextBreakdown")
            .map(|breakdown| {
                Ok(v5::SessionContextBreakdown {
                    system: count(breakdown, "system")?,
                    tools: count(breakdown, "tools")?,
                    user: count(breakdown, "user")?,
                    assistant: count(breakdown, "assistant")?,
                    reasoning: count(breakdown, "reasoning")?,
                    tool_calls: count(breakdown, "toolCalls")?,
                    other: count(breakdown, "other")?,
                })
            })
            .transpose()?,
        provider_cache: json
            .opt("providerCache")
            .map(|cache| {
                Ok(v5::SessionProviderCacheDiagnostics {
                    mechanism: literal(
                        cache,
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
                    read_reported: cache.field("readReported")?.boolean()?,
                    write_reported: cache.field("writeReported")?.boolean()?,
                })
            })
            .transpose()?,
    })
}

fn pressure(json: J) -> R<Option<v5::SessionCompactionPressure>> {
    json.opt("pressure")
        .map(|pressure| {
            Ok(v5::SessionCompactionPressure {
                estimated_input_tokens: count(pressure, "estimatedInputTokens")?,
                safe_input_tokens: count(pressure, "safeInputTokens")?,
            })
        })
        .transpose()
}

fn compaction_time(json: J) -> R<f64> {
    number(json.field("time")?, "created")
}

fn compaction_message(
    domain: &session_message::Compaction,
    json: J,
) -> R<v5::SessionMessageCompaction> {
    use session_message::Compaction as C;
    use v5::{
        session_message_compaction::Kind, session_message_compaction_value2 as running,
        session_message_compaction_value3 as completed,
        session_message_compaction_value4 as failed,
    };
    let kind = match domain {
        C::Pending(_) => Kind::Value1(compaction_pending(json)?),
        C::RunningV1(_) => Kind::Value2(v5::SessionMessageCompactionValue2 {
            kind: Some(running::Kind::Value1(compaction_running_v1(json)?)),
        }),
        C::Running(_) => Kind::Value2(v5::SessionMessageCompactionValue2 {
            kind: Some(running::Kind::Value2(compaction_running(json)?)),
        }),
        C::CompletedV1(_) => Kind::Value3(v5::SessionMessageCompactionValue3 {
            kind: Some(completed::Kind::Value1(compaction_completed_v1(json)?)),
        }),
        C::Completed(_) => Kind::Value3(v5::SessionMessageCompactionValue3 {
            kind: Some(completed::Kind::Value2(compaction_completed(json)?)),
        }),
        C::FailedV1(_) => Kind::Value4(v5::SessionMessageCompactionValue4 {
            kind: Some(failed::Kind::Value1(compaction_failed_v1(json)?)),
        }),
        C::Failed(_) => Kind::Value4(v5::SessionMessageCompactionValue4 {
            kind: Some(failed::Kind::Value2(compaction_failed(json)?)),
        }),
    };
    Ok(v5::SessionMessageCompaction { kind: Some(kind) })
}

fn compaction_pending(json: J) -> R<v5::SessionMessageCompactionPending> {
    Ok(v5::SessionMessageCompactionPending {
        r#type: 1,
        id: text(json, "id")?,
        metadata: metadata!(
            json,
            SessionMessageCompactionPendingMetadata,
            SessionMessageCompactionPendingMetadataEntry
        ),
        time: v5::SessionMessageCompactionPendingTime {
            created: compaction_time(json)?,
        },
        job_id: text(json, "jobID")?,
        trigger: literal(json, "trigger", TRIGGER)?,
        pressure: pressure(json)?,
        status: 1,
        summary: opt_text(json, "summary")?,
        recent: opt_text(json, "recent")?,
    })
}

fn compaction_running_v1(json: J) -> R<v5::SessionMessageCompactionRunningV1> {
    Ok(v5::SessionMessageCompactionRunningV1 {
        r#type: 1,
        id: text(json, "id")?,
        metadata: metadata!(
            json,
            SessionMessageCompactionRunningV1Metadata,
            SessionMessageCompactionRunningV1MetadataEntry
        ),
        time: v5::SessionMessageCompactionRunningV1Time {
            created: compaction_time(json)?,
        },
        reason: literal(json, "reason", REASON)?,
        status: 1,
        summary: text(json, "summary")?,
        recent: text(json, "recent")?,
    })
}

fn compaction_running(json: J) -> R<v5::SessionMessageCompactionRunning> {
    Ok(v5::SessionMessageCompactionRunning {
        r#type: 1,
        id: text(json, "id")?,
        metadata: metadata!(
            json,
            SessionMessageCompactionRunningMetadata,
            SessionMessageCompactionRunningMetadataEntry
        ),
        time: v5::SessionMessageCompactionRunningTime {
            created: compaction_time(json)?,
        },
        job_id: text(json, "jobID")?,
        trigger: literal(json, "trigger", TRIGGER)?,
        pressure: pressure(json)?,
        status: 1,
        summary: opt_text(json, "summary")?,
        recent: opt_text(json, "recent")?,
    })
}

fn compaction_completed_v1(json: J) -> R<v5::SessionMessageCompactionCompletedV1> {
    Ok(v5::SessionMessageCompactionCompletedV1 {
        r#type: 1,
        id: text(json, "id")?,
        metadata: metadata!(
            json,
            SessionMessageCompactionCompletedV1Metadata,
            SessionMessageCompactionCompletedV1MetadataEntry
        ),
        time: v5::SessionMessageCompactionCompletedV1Time {
            created: compaction_time(json)?,
        },
        reason: literal(json, "reason", REASON)?,
        status: 1,
        summary: text(json, "summary")?,
        recent: text(json, "recent")?,
        messages: opt_count(json, "messages")?,
        tokens: json.opt("tokens").map(tokens).transpose()?,
    })
}

fn compaction_completed(json: J) -> R<v5::SessionMessageCompactionCompleted> {
    let boundary = json.field("boundary")?;
    let metrics = json.field("metrics")?;
    Ok(v5::SessionMessageCompactionCompleted {
        r#type: 1,
        id: text(json, "id")?,
        metadata: metadata!(
            json,
            SessionMessageCompactionCompletedMetadata,
            SessionMessageCompactionCompletedMetadataEntry
        ),
        time: v5::SessionMessageCompactionCompletedTime {
            created: compaction_time(json)?,
        },
        job_id: text(json, "jobID")?,
        trigger: literal(json, "trigger", TRIGGER)?,
        pressure: pressure(json)?,
        status: 1,
        revision: count(json, "revision")?,
        boundary: v5::SessionCompactionBoundary {
            message_id: text(boundary, "messageID")?,
            seq: count(boundary, "seq")?,
        },
        metrics: v5::SessionCompactionMetrics {
            excluded_messages: count(metrics, "excludedMessages")?,
            excluded_parts: count(metrics, "excludedParts")?,
            input_tokens: count(metrics, "inputTokens")?,
            retained_tokens: count(metrics, "retainedTokens")?,
        },
        summary: opt_text(json, "summary")?,
        recent: opt_text(json, "recent")?,
    })
}

fn compaction_failed_v1(json: J) -> R<v5::SessionMessageCompactionFailedV1> {
    Ok(v5::SessionMessageCompactionFailedV1 {
        r#type: 1,
        id: text(json, "id")?,
        metadata: metadata!(
            json,
            SessionMessageCompactionFailedV1Metadata,
            SessionMessageCompactionFailedV1MetadataEntry
        ),
        time: v5::SessionMessageCompactionFailedV1Time {
            created: compaction_time(json)?,
        },
        reason: literal(json, "reason", REASON)?,
        status: 1,
        error: structured_error(json.field("error")?)?,
    })
}

fn compaction_failed(json: J) -> R<v5::SessionMessageCompactionFailed> {
    Ok(v5::SessionMessageCompactionFailed {
        r#type: 1,
        id: text(json, "id")?,
        metadata: metadata!(
            json,
            SessionMessageCompactionFailedMetadata,
            SessionMessageCompactionFailedMetadataEntry
        ),
        time: v5::SessionMessageCompactionFailedTime {
            created: compaction_time(json)?,
        },
        job_id: text(json, "jobID")?,
        trigger: literal(json, "trigger", TRIGGER)?,
        pressure: pressure(json)?,
        status: 1,
        code: literal(
            json,
            "code",
            &[
                ("cancelled", 1),
                ("superseded", 2),
                ("invalid_manifest", 3),
                ("protected_state_changed", 4),
                ("context_limit_unresolved", 5),
                ("migration_failed", 6),
                ("provider_failed", 7),
            ],
        )?,
        error: structured_error(json.field("error")?)?,
        summary: opt_text(json, "summary")?,
        recent: opt_text(json, "recent")?,
    })
}

pub(crate) fn delivery(value: Option<&str>) -> R<i32> {
    match value {
        Some("steer") => Ok(1),
        Some("queue") => Ok(2),
        _ => Err(Unrepresentable("delivery")),
    }
}

pub(crate) fn user_data(data: &JsonValue) -> R<v5::SessionPendingUserData> {
    let data = J(data);
    Ok(v5::SessionPendingUserData {
        text: text(data, "text")?,
        files: data
            .opt("files")
            .map(files)
            .transpose()?
            .map(|items| v5::SessionPendingUserDataFiles { items }),
        agents: data
            .opt("agents")
            .map(agents)
            .transpose()?
            .map(|items| v5::SessionPendingUserDataAgents { items }),
        metadata: metadata!(
            data,
            SessionPendingUserDataMetadata,
            SessionPendingUserDataMetadataEntry
        ),
    })
}

pub(crate) fn synthetic_data(data: &JsonValue) -> R<v5::SessionPendingSyntheticData> {
    let data = J(data);
    Ok(v5::SessionPendingSyntheticData {
        text: text(data, "text")?,
        description: opt_text(data, "description")?,
        metadata: metadata!(
            data,
            SessionPendingSyntheticDataMetadata,
            SessionPendingSyntheticDataMetadataEntry
        ),
    })
}

pub fn pending(record: &Pending) -> R<v5::SessionPendingInfo> {
    use v5::session_pending_info::Kind;
    let delivery = delivery(record.delivery.as_ref().and_then(LosslessString::as_str))?;
    let admitted_seq =
        u64::try_from(record.admitted_seq).map_err(|_| Unrepresentable("admittedSeq"))?;
    let kind = match record.type_.as_str() {
        Some("user") => Kind::Value1(v5::SessionPendingUser {
            admitted_seq,
            id: wire(&record.id),
            session_id: wire(&record.session_id),
            time_created: record.time_created as f64,
            r#type: 1,
            data: user_data(&record.data)?,
            delivery,
        }),
        Some("synthetic") => Kind::Value2(v5::SessionPendingSynthetic {
            admitted_seq,
            id: wire(&record.id),
            session_id: wire(&record.session_id),
            time_created: record.time_created as f64,
            r#type: 1,
            data: synthetic_data(&record.data)?,
            delivery,
        }),
        _ => return Err(Unrepresentable("pending type")),
    };
    Ok(v5::SessionPendingInfo { kind: Some(kind) })
}

pub fn pending_user(record: &Pending) -> R<v5::SessionPendingUser> {
    match pending(record)?.kind {
        Some(v5::session_pending_info::Kind::Value1(user)) => Ok(user),
        _ => Err(Unrepresentable("user input")),
    }
}
