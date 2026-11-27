use crate::{
    convert,
    message::{self, J, Unrepresentable},
};
use message::{count, literal, number, opt_count, opt_literal, opt_number, opt_text, text};
use ycoding_core::ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, guardrail, location, session_pending,
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
            usage_anchor: json.opt("usageAnchor").map(usage_anchor).transpose()?,
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
        Some("started") => Kind::Value2(v5::SessionLogItemValue24DataChangeValue2 {
            r#type: 1,
            source: opt_client_reply_source(json, "source")?,
        }),
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
                    deferred: opt_boolean(data, "deferred")?,
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
                    source: opt_client_reply_source(data, "source")?,
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
            source: opt_client_reply_source(json, "source")?,
        }),
        Some("question_timed_out") => Kind::Value12(v5::SessionLogItemValue24DataChangeValue12 {
            r#type: 1,
            question_id: text(json, "questionID")?,
        }),
        Some("resumed") => Kind::Value13(v5::SessionLogItemValue24DataChangeValue13 { r#type: 1 }),
        _ => return Err(Unrepresentable("task change")),
    };
    Ok(v5::SessionLogItemValue24DataChange { kind: Some(kind) })
}

pub(super) fn client_reply_source(json: J) -> R<v5::FormClientReplySource> {
    use v5::form_client_reply_source::Kind;
    let kind = match literal(json, "kind", &[("dots-client", 1), ("dots-native", 2)])? {
        1 => {
            let principal = json.field("principal")?;
            Kind::Value1(v5::FormDotsClientReplySource {
                kind: 1,
                anchor_session_id: text(json, "anchorSessionID")?,
                binding_id: text(json, "bindingID")?,
                delegation_id: text(json, "delegationID")?,
                revision: count(json, "revision")?,
                exchange_id: text(json, "exchangeID")?,
                principal: v5::McpEventsPrincipal {
                    owner_id: text(principal, "ownerID")?,
                    device_id: text(principal, "deviceID")?,
                    client_id: text(principal, "clientID")?,
                    grant_id: text(principal, "grantID")?,
                    epoch: text(principal, "epoch")?,
                },
            })
        }
        _ => Kind::Value2(v5::FormNativeReplySource {
            kind: 1,
            profile: text(json, "profile")?,
            credential_id: text(json, "credentialID")?,
            account_id: text(json, "accountID")?,
            account_generation: count(json, "accountGeneration")?,
            environment_id: text(json, "environmentID")?,
            connection_id: text(json, "connectionID")?,
            client_id: text(json, "clientID")?,
            stream_id: text(json, "streamID")?,
            root_session_id: text(json, "rootSessionID")?,
            access_revision: count(json, "accessRevision")?,
            request_id: text(json, "requestID")?,
        }),
    };
    Ok(v5::FormClientReplySource { kind: Some(kind) })
}

pub(super) fn opt_client_reply_source(json: J, key: &str) -> R<Option<v5::FormClientReplySource>> {
    json.opt(key).map(client_reply_source).transpose()
}

const DOTS_EVENT_BYTES: usize = 1024 * 1024;

pub(super) fn dots_event<T: prost::Message + prost::Name + Default>(
    json: J,
    label: &'static str,
) -> R<T> {
    let bytes = ycoding_protocol::domain_json::encode(
        &T::full_name(),
        &convert::json_domain(json.0),
        DOTS_EVENT_BYTES,
    )
    .map_err(|_| Unrepresentable(label))?;
    T::decode(bytes.as_slice()).map_err(|_| Unrepresentable(label))
}

pub(super) fn tool_invocation(json: J) -> R<v5::ToolInvocationSettled> {
    Ok(v5::ToolInvocationSettled {
        id: text(json, "id")?,
        index: count(json, "index")?,
        name: text(json, "name")?,
        tool: text(json, "tool")?,
        status: literal(json, "status", &[("completed", 1), ("error", 2)])?,
        input: json
            .opt("input")
            .map(|value| convert::json_to_value(value.0)),
        structured: json
            .opt("structured")
            .map(|value| convert::json_to_value(value.0)),
    })
}

pub(super) fn usage_anchor(json: J) -> R<v5::UsageAnchorRef> {
    Ok(v5::UsageAnchorRef {
        session_id: text(json, "sessionID")?,
        input_id: text(json, "inputID")?,
    })
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

pub(super) const CHOICE: &[(&str, i32)] = &[
    ("approve_all", 1),
    ("approve", 2),
    ("reject", 3),
    ("escalate", 4),
    ("allow", 5),
    ("deny", 6),
];
pub(super) const AUTHORITY: &[(&str, i32)] = &[("baseline", 1), ("yolo", 2)];
pub(super) const PURPOSE: &[(&str, i32)] = &[
    ("permission", 1),
    ("guardrail", 2),
    ("answer", 3),
    ("advisory", 4),
];
pub(super) const OUTCOME: &[(&str, i32)] = &[("succeeded", 1), ("failed", 2), ("cancelled", 3)];
pub(super) const DECISION_FAILURE: &[(&str, i32)] = &[
    ("unavailable", 1),
    ("invalid-request", 2),
    ("provider-failed", 3),
    ("timeout", 4),
    ("input-too-large", 5),
    ("invalid-output", 6),
    ("refused", 7),
    ("truncated-output", 8),
    ("unsupported-output", 9),
];
pub(super) const ANSWER_TYPE: &[(&str, i32)] = &[
    ("predicate", 1),
    ("choice", 2),
    ("score", 3),
    ("text", 4),
    ("refusal", 5),
];
pub(super) const ASSESSED: &[(&str, i32)] = &[("allow", 1), ("deny", 2), ("escalate", 3)];
pub(super) const VIA: &[(&str, i32)] = &[
    ("auto-permission", 1),
    ("baseline", 2),
    ("yolo", 3),
    ("coordination", 4),
];
pub(super) const ACTOR: &[(&str, i32)] = &[("coordinator", 1)];
pub(super) const SESSION_ORIGIN: &[(&str, i32)] = &[("dots-executor", 1)];
pub(super) const SESSION_SCOPE: &[(&str, i32)] = &[("bound", 1), ("standalone", 2)];
pub(super) const CONTEXT_SOURCE: &[(&str, i32)] = &[
    ("session-state", 1),
    ("team-view", 2),
    ("step-limit", 3),
    ("dots", 4),
];
pub(super) const REPLY: &[(&str, i32)] = &[("once", 1), ("always", 2), ("reject", 3)];
pub(super) const REVIEW_KIND: &[(&str, i32)] = &[
    ("question", 1),
    ("subagent_question", 2),
    ("guardrail", 3),
    ("permission", 4),
    ("recovery", 5),
];
pub(super) const REVIEW_REASON: &[(&str, i32)] = &[
    ("disabled", 1),
    ("free_text", 2),
    ("refused", 3),
    ("low_confidence", 4),
    ("escalated", 5),
    ("error", 6),
    ("timeout", 7),
    ("sleep_entry", 8),
    ("defer_entry", 18),
    ("restart", 9),
    ("unavailable", 10),
    ("invalid-request", 11),
    ("provider-failed", 12),
    ("input-too-large", 13),
    ("invalid-output", 14),
    ("truncated-output", 15),
    ("unsupported-output", 16),
    ("conflicting_grades", 17),
];
pub(super) const WITHDRAWN: &[(&str, i32)] =
    &[("reverted", 1), ("task_closed", 2), ("autonomy", 3)];

pub(super) fn escalation_reason(json: J) -> R<i32> {
    guardrail::EscalationReason::decode(json.0)
        .map(convert::escalation_reason)
        .map_err(|_| Unrepresentable("guardrail escalation reason"))
}

pub(super) fn source(json: J) -> R<v5::GuardrailSource> {
    Ok(v5::GuardrailSource {
        message_id: text(json, "messageID")?,
        call_id: text(json, "callID")?,
    })
}

pub(super) fn grades(json: J) -> R<Vec<v5::GuardrailGrade>> {
    json.items()?
        .iter()
        .map(|grade| {
            let grade = J(grade);
            Ok(v5::GuardrailGrade {
                choice: literal(grade, "choice", CHOICE)?,
                confidence: number(grade, "confidence")?,
                evidence: text(grade, "evidence")?,
            })
        })
        .collect()
}

pub(super) fn origin(json: J) -> R<v5::SessionReviewOrigin> {
    use v5::session_review_origin::Kind;
    let kind = if json.opt("questionID").is_some() {
        Kind::Value2(v5::SessionReviewOriginValue2 {
            question_id: text(json, "questionID")?,
        })
    } else if json.opt("requestID").is_some() {
        let executor = match opt_boolean(json, "executor")? {
            None => None,
            Some(true) => Some(true),
            Some(false) => return Err(Unrepresentable("executor")),
        };
        Kind::Value3(v5::SessionReviewOriginValue3 {
            request_id: text(json, "requestID")?,
            executor,
        })
    } else {
        Kind::Value1(v5::SessionReviewOriginValue1 {
            message_id: text(json, "messageID")?,
            call_id: text(json, "callID")?,
        })
    };
    Ok(v5::SessionReviewOrigin { kind: Some(kind) })
}

fn fingerprint_version(json: J) -> R<v5::SessionReviewPermissionPayloadFingerprintVersion> {
    use v5::session_review_permission_payload_fingerprint_version::Kind;
    let kind = match number(json, "fingerprintVersion")? {
        version if version == 1.0 || version == 2.0 => Kind::Value1(version),
        _ => return Err(Unrepresentable("fingerprintVersion")),
    };
    Ok(v5::SessionReviewPermissionPayloadFingerprintVersion { kind: Some(kind) })
}

pub(super) fn review_payload(json: J) -> R<v5::SessionReviewPayload> {
    use v5::session_review_payload::Kind;
    let JsonValue::String(name) = json.field("type")?.0 else {
        return Err(Unrepresentable("review payload"));
    };
    let kind = match name.as_str() {
        Some("form") => Kind::Value1(v5::SessionReviewFormPayload {
            r#type: 1,
            title: text(json, "title")?,
            fields: v5::FormFields {
                items: json
                    .field("fields")?
                    .items()?
                    .iter()
                    .map(|field| form_field(J(field)))
                    .collect::<R<_>>()?,
            },
            question_tool: opt_boolean(json, "questionTool")?,
            coordination_escalation: json
                .opt("coordinationEscalation")
                .map(message::coordination_escalation)
                .transpose()?,
        }),
        Some("question") => Kind::Value2(v5::SessionReviewQuestionPayload {
            r#type: 1,
            questions: v5::SessionReviewQuestionPayloadQuestions {
                items: json
                    .field("questions")?
                    .items()?
                    .iter()
                    .map(|question| question_info(J(question)))
                    .collect::<R<_>>()?,
            },
        }),
        Some("subagent_question") => Kind::Value3(v5::SessionReviewSubagentQuestionPayload {
            r#type: 1,
            text: text(json, "text")?,
            data: json.opt("data").map(|data| convert::json_to_value(data.0)),
        }),
        Some("guardrail") => Kind::Value4(v5::SessionReviewGuardrailPayload {
            r#type: 1,
            action: text(json, "action")?,
            resources: v5::SessionReviewGuardrailPayloadResources {
                items: strings(json.field("resources")?)?,
            },
            rule_i_ds: v5::SessionReviewGuardrailPayloadRuleIDs {
                items: strings(json.field("ruleIDs")?)?,
            },
            reason: text(json, "reason")?,
            hard_review: json.field("hardReview")?.boolean()?,
            directories: v5::SessionReviewGuardrailPayloadDirectories {
                items: strings(json.field("directories")?)?,
            },
            fingerprint: text(json, "fingerprint")?,
            request_id: text(json, "requestID")?,
            coordination_escalation: json
                .opt("coordinationEscalation")
                .map(message::coordination_escalation)
                .transpose()?,
        }),
        Some("permission") => Kind::Value5(v5::SessionReviewPermissionPayload {
            r#type: 1,
            action: text(json, "action")?,
            resources: v5::SessionReviewPermissionPayloadResources {
                items: strings(json.field("resources")?)?,
            },
            save: json
                .opt("save")
                .map(|save| {
                    strings(save).map(|items| v5::SessionReviewPermissionPayloadSave { items })
                })
                .transpose()?,
            fingerprint: text(json, "fingerprint")?,
            fingerprint_version: fingerprint_version(json)?,
            request_id: text(json, "requestID")?,
            coordination_escalation: json
                .opt("coordinationEscalation")
                .map(message::coordination_escalation)
                .transpose()?,
        }),
        Some("recovery") => Kind::Value6(v5::SessionReviewRecoveryPayload {
            r#type: 1,
            tools: v5::SessionReviewRecoveryPayloadTools {
                items: json
                    .field("tools")?
                    .items()?
                    .iter()
                    .map(|tool| {
                        let tool = J(tool);
                        Ok(v5::SessionReviewRecoveryTool {
                            message_id: text(tool, "messageID")?,
                            call_id: text(tool, "callID")?,
                            name: text(tool, "name")?,
                        })
                    })
                    .collect::<R<_>>()?,
            },
        }),
        _ => return Err(Unrepresentable("review payload")),
    };
    Ok(v5::SessionReviewPayload { kind: Some(kind) })
}

pub(super) fn review_decision(json: J) -> R<v5::SessionReviewDecision> {
    use v5::session_review_decision::Kind;
    let kind = literal(json, "kind", REVIEW_KIND)?;
    let kind = match (kind, json.opt("dismissed").is_some()) {
        (1 | 2, true) => {
            if !json.field("dismissed")?.boolean()? {
                return Err(Unrepresentable("review decision"));
            }
            Kind::Value6(v5::SessionReviewDecisionValue6 {
                kind,
                dismissed: true,
            })
        }
        (1, false) => {
            use v5::session_review_decision_value1_answers::Kind as Answers;
            let answers = json.field("answers")?;
            let answers = match answers.0 {
                JsonValue::Array(items) => {
                    Answers::Value2(v5::SessionReviewDecisionValue1AnswersValue2 {
                        items: items
                            .iter()
                            .map(|answer| {
                                strings(J(answer)).map(|items| v5::QuestionAnswer { items })
                            })
                            .collect::<R<_>>()?,
                    })
                }
                _ => Answers::Value1(form_answer(answers)?),
            };
            Kind::Value1(v5::SessionReviewDecisionValue1 {
                kind: 1,
                answers: v5::SessionReviewDecisionValue1Answers {
                    kind: Some(answers),
                },
            })
        }
        (2, false) => Kind::Value2(v5::SessionReviewDecisionValue2 {
            kind: 1,
            text: text(json, "text")?,
            data: json.opt("data").map(|data| convert::json_to_value(data.0)),
        }),
        (3, false) => Kind::Value3(v5::SessionReviewDecisionValue3 {
            kind: 1,
            reply: literal(json, "reply", REPLY)?,
        }),
        (4, false) => Kind::Value4(v5::SessionReviewDecisionValue4 {
            kind: 1,
            reply: literal(json, "reply", REPLY)?,
        }),
        (5, false) => Kind::Value5(v5::SessionReviewDecisionValue5 {
            kind: 1,
            choice: literal(json, "choice", &[("continue", 1), ("stop", 2)])?,
        }),
        _ => return Err(Unrepresentable("review decision")),
    };
    Ok(v5::SessionReviewDecision { kind: Some(kind) })
}

pub(super) fn audited_answers(json: J) -> R<Vec<v5::SessionLogItemValue61DataAnswersItem>> {
    use v5::session_log_item_value61_data_answers_item_choice::Kind;
    json.items()?
        .iter()
        .map(|answer| {
            let answer = J(answer);
            Ok(v5::SessionLogItemValue61DataAnswersItem {
                name: text(answer, "name")?,
                r#type: literal(answer, "type", ANSWER_TYPE)?,
                confidence: number(answer, "confidence")?,
                answer: opt_boolean(answer, "answer")?,
                choice: match answer.opt("choice") {
                    None => None,
                    Some(choice) => Some(v5::SessionLogItemValue61DataAnswersItemChoice {
                        kind: Some(match choice.0 {
                            JsonValue::Bool(value) => Kind::Value2(*value),
                            _ => Kind::Value1(choice.text()?),
                        }),
                    }),
                },
                score: opt_count(answer, "score")?,
                length: opt_count(answer, "length")?,
            })
        })
        .collect()
}

fn opt_boolean(json: J, key: &str) -> R<Option<bool>> {
    json.opt(key).map(J::boolean).transpose()
}

fn question_info(json: J) -> R<v5::QuestionInfo> {
    Ok(v5::QuestionInfo {
        question: text(json, "question")?,
        header: text(json, "header")?,
        options: v5::QuestionInfoOptions {
            items: json
                .field("options")?
                .items()?
                .iter()
                .map(|option| {
                    let option = J(option);
                    Ok(v5::QuestionOption {
                        label: text(option, "label")?,
                        description: text(option, "description")?,
                    })
                })
                .collect::<R<_>>()?,
        },
        multiple: opt_boolean(json, "multiple")?,
        custom: opt_boolean(json, "custom")?,
    })
}

fn form_answer(json: J) -> R<v5::FormAnswer> {
    let JsonValue::Object(object) = json.0 else {
        return Err(Unrepresentable("form answer"));
    };
    Ok(v5::FormAnswer {
        entries: object
            .iter()
            .map(|(key, value)| {
                Ok(v5::FormAnswerEntry {
                    key: convert::wire(key),
                    value: form_value(J(value))?,
                })
            })
            .collect::<R<_>>()?,
    })
}

fn form_value(json: J) -> R<v5::FormValue> {
    use v5::form_value::Kind;
    let kind = match json.0 {
        JsonValue::String(_) => Kind::Value1(json.text()?),
        JsonValue::Number(number) => Kind::Value2(*number),
        JsonValue::Bool(flag) => Kind::Value3(*flag),
        JsonValue::Array(_) => Kind::Value4(v5::FormValueValue4 {
            items: strings(json)?,
        }),
        _ => return Err(Unrepresentable("form value")),
    };
    Ok(v5::FormValue { kind: Some(kind) })
}

fn form_when(json: J) -> R<Vec<v5::FormWhen>> {
    use v5::form_when_value::Kind;
    json.items()?
        .iter()
        .map(|when| {
            let when = J(when);
            let value = when.field("value")?;
            Ok(v5::FormWhen {
                key: text(when, "key")?,
                op: literal(when, "op", &[("eq", 1), ("neq", 2)])?,
                value: v5::FormWhenValue {
                    kind: Some(match value.0 {
                        JsonValue::String(_) => Kind::Value1(value.text()?),
                        JsonValue::Number(number) => Kind::Value2(*number),
                        JsonValue::Bool(flag) => Kind::Value3(*flag),
                        _ => return Err(Unrepresentable("form condition")),
                    }),
                },
            })
        })
        .collect()
}

fn form_options(json: J) -> R<Vec<v5::FormOption>> {
    json.items()?
        .iter()
        .map(|option| {
            let option = J(option);
            Ok(v5::FormOption {
                value: text(option, "value")?,
                label: text(option, "label")?,
                description: opt_text(option, "description")?,
            })
        })
        .collect()
}

fn form_field(json: J) -> R<v5::FormField> {
    use v5::form_field::Kind;
    let JsonValue::String(name) = json.field("type")?.0 else {
        return Err(Unrepresentable("form field"));
    };
    let key = text(json, "key")?;
    let title = opt_text(json, "title")?;
    let description = opt_text(json, "description")?;
    let required = opt_boolean(json, "required")?;
    let when = json.opt("when");
    let kind = match name.as_str() {
        Some("string") => Kind::Value1(v5::FormStringField {
            key,
            title,
            description,
            required,
            when: when
                .map(|when| form_when(when).map(|items| v5::FormStringFieldWhen { items }))
                .transpose()?,
            r#type: 1,
            format: opt_literal(
                json,
                "format",
                &[("email", 1), ("uri", 2), ("date", 3), ("date-time", 4)],
            )?,
            min_length: opt_count(json, "minLength")?,
            max_length: opt_count(json, "maxLength")?,
            pattern: opt_text(json, "pattern")?,
            placeholder: opt_text(json, "placeholder")?,
            default: opt_text(json, "default")?,
            options: json
                .opt("options")
                .map(|options| {
                    form_options(options).map(|items| v5::FormStringFieldOptions { items })
                })
                .transpose()?,
            custom: opt_boolean(json, "custom")?,
        }),
        Some("number") => Kind::Value2(v5::FormNumberField {
            key,
            title,
            description,
            required,
            when: when
                .map(|when| form_when(when).map(|items| v5::FormNumberFieldWhen { items }))
                .transpose()?,
            r#type: 1,
            minimum: opt_number(json, "minimum")?,
            maximum: opt_number(json, "maximum")?,
            default: opt_number(json, "default")?,
        }),
        Some("integer") => Kind::Value3(v5::FormIntegerField {
            key,
            title,
            description,
            required,
            when: when
                .map(|when| form_when(when).map(|items| v5::FormIntegerFieldWhen { items }))
                .transpose()?,
            r#type: 1,
            minimum: opt_number(json, "minimum")?,
            maximum: opt_number(json, "maximum")?,
            default: opt_number(json, "default")?,
        }),
        Some("boolean") => Kind::Value4(v5::FormBooleanField {
            key,
            title,
            description,
            required,
            when: when
                .map(|when| form_when(when).map(|items| v5::FormBooleanFieldWhen { items }))
                .transpose()?,
            r#type: 1,
            default: opt_boolean(json, "default")?,
        }),
        Some("multiselect") => Kind::Value5(v5::FormMultiselectField {
            key,
            title,
            description,
            required,
            when: when
                .map(|when| form_when(when).map(|items| v5::FormMultiselectFieldWhen { items }))
                .transpose()?,
            r#type: 1,
            options: v5::FormMultiselectFieldOptions {
                items: form_options(json.field("options")?)?,
            },
            min_items: opt_count(json, "minItems")?,
            max_items: opt_count(json, "maxItems")?,
            custom: opt_boolean(json, "custom")?,
            default: json
                .opt("default")
                .map(|items| strings(items).map(|items| v5::FormMultiselectFieldDefault { items }))
                .transpose()?,
        }),
        Some("external") => Kind::Value6(v5::FormExternalField {
            key,
            r#type: 1,
            url: text(json, "url")?,
            title,
            description,
        }),
        _ => return Err(Unrepresentable("form field")),
    };
    Ok(v5::FormField { kind: Some(kind) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ycoding_core::ycoding_schema::parse_json;
    use ycoding_protocol::domain_json::enumeration;

    fn agrees(name: &str, table: &[(&str, i32)]) {
        let wire = enumeration(name).expect(name);
        let mut expected = wire
            .values
            .iter()
            .map(|value| (wire.text(value), value.number as i32))
            .collect::<Vec<_>>();
        let mut actual = table.to_vec();
        expected.sort();
        actual.sort();
        assert_eq!(actual, expected, "{name}");
    }

    #[test]
    fn literal_tables_cover_every_wire_enumeration_value() {
        agrees("ycoding.v5.SessionLogItemValue62_data_via", VIA);
        agrees("ycoding.v5.SessionLogItemValue62_data_actor", ACTOR);
        agrees("ycoding.v5.SessionLogItemValue55_data_actor", ACTOR);
        agrees(
            "ycoding.v5.SessionLogItemValue23_data_source",
            CONTEXT_SOURCE,
        );
    }

    #[test]
    fn review_payloads_project_the_whole_coordination_escalation_chain_or_none() {
        let escalation = r#","coordinationEscalation":{"reasons":[{"sessionID":"ses_driver","reason":"The target is outside the assignment."},{"sessionID":"ses_master","reason":"Confirm this additional target."}]}"#;
        let permission = |extra: &str| {
            parse_json(&format!(
                r#"{{"type":"permission","action":"shell","resources":["*"],"fingerprint":"fp","fingerprintVersion":2,"requestID":"per_one"{extra}}}"#
            ))
            .unwrap()
        };
        let Some(v5::session_review_payload::Kind::Value5(held)) =
            review_payload(J(&permission(escalation))).unwrap().kind
        else {
            panic!("permission payload expected")
        };
        let reasons = held.coordination_escalation.unwrap().reasons.items;
        assert_eq!(
            reasons
                .iter()
                .map(|reason| (
                    convert::readable(&convert::domain(&reason.session_id).unwrap()),
                    convert::readable(&convert::domain(&reason.reason).unwrap())
                ))
                .collect::<Vec<_>>(),
            [
                (
                    "ses_driver".to_owned(),
                    "The target is outside the assignment.".to_owned()
                ),
                (
                    "ses_master".to_owned(),
                    "Confirm this additional target.".to_owned()
                ),
            ]
        );
        let Some(v5::session_review_payload::Kind::Value5(plain)) =
            review_payload(J(&permission(""))).unwrap().kind
        else {
            panic!("permission payload expected")
        };
        assert_eq!(plain.coordination_escalation, None);
        assert!(review_payload(J(&permission(r#","coordinationEscalation":{}"#))).is_err());
    }

    #[test]
    fn permission_review_payloads_project_the_fingerprint_version_and_reject_others() {
        use v5::session_review_permission_payload_fingerprint_version::Kind;
        let payload = |version: &str| {
            parse_json(&format!(
                r#"{{"type":"permission","action":"shell","resources":["*"],"fingerprint":"fp"{version},"requestID":"per_one"}}"#
            ))
            .unwrap()
        };
        let version = |json: &str| {
            let Some(v5::session_review_payload::Kind::Value5(permission)) =
                review_payload(J(&payload(json))).unwrap().kind
            else {
                panic!("permission payload expected")
            };
            permission.fingerprint_version.kind
        };
        assert_eq!(
            version(r#","fingerprintVersion":1"#),
            Some(Kind::Value1(1.0))
        );
        assert_eq!(
            version(r#","fingerprintVersion":2"#),
            Some(Kind::Value1(2.0))
        );
        assert!(review_payload(J(&payload(""))).is_err());
        assert!(review_payload(J(&payload(r#","fingerprintVersion":3"#))).is_err());
    }

    #[test]
    fn request_origin_projects_executor_true_omits_absent_and_rejects_explicit_false() {
        use prost::Message;
        use v5::session_review_origin::Kind;
        let project = |extra: &str| {
            origin(J(&parse_json(&format!(
                r#"{{"requestID":"req_one"{extra}}}"#
            ))
            .unwrap()))
        };
        let encoded = |extra: &str| match project(extra).unwrap().kind {
            Some(Kind::Value3(value)) => value.encode_to_vec(),
            _ => panic!("request origin expected"),
        };
        let base = v5::SessionReviewOriginValue3 {
            request_id: convert::text("req_one"),
            executor: None,
        }
        .encode_to_vec();
        assert_eq!(encoded(""), base);
        assert_eq!(
            encoded(r#","executor":true"#),
            [base.as_slice(), &[0x10, 0x01]].concat()
        );
        assert!(project(r#","executor":false"#).is_err());
        assert!(project(r#","executor":"true""#).is_err());
    }
    #[test]
    fn dots_event_projects_declared_fields_and_rejects_unmodeled_input() {
        type Access = v5::SessionLogItemValue67Data;
        let project =
            |json: &str| dots_event::<Access>(J(&parse_json(json).unwrap()), "dots access");
        let held = project(r#"{"sessionID":"ses_one","enabled":true,"revision":2}"#).unwrap();
        assert!(held.enabled);
        assert_eq!(held.revision, 2);
        for invalid in [
            r#"{"sessionID":"ses_one","enabled":true,"revision":2,"extra":1}"#,
            r#"{"sessionID":"ses_one","enabled":true}"#,
            r#"{"sessionID":"ses_one","enabled":"yes","revision":2}"#,
            r#"{"sessionID":"ses_one","enabled":true,"revision":-1}"#,
        ] {
            assert!(project(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn dots_event_selects_the_union_branch_of_each_external_reply_source() {
        use v5::{form_client_reply_source::Kind as Client, form_external_reply_source::Kind};
        let fingerprint = "a".repeat(64);
        let source = |source: &str| {
            let json = format!(
                r#"{{"sessionID":"ses_one","source":{source},"target":{{"kind":"review","itemID":"rvw_one","fingerprint":"{fingerprint}"}},"reply":"reject"}}"#
            );
            dots_event::<v5::SessionLogItemValue72Data>(
                J(&parse_json(&json).unwrap()),
                "dots decision",
            )
            .unwrap()
            .source
            .kind
        };
        assert!(matches!(
            source(
                r#"{"kind":"dots-delegation","anchorSessionID":"ses_anchor","delegationID":"del","revision":1,"exchangeID":"ex"}"#
            ),
            Some(Kind::Value1(_))
        ));
        let Some(Kind::Value2(client)) = source(
            r#"{"kind":"dots-native","profile":"p","credentialID":"c","accountID":"a","accountGeneration":0,"environmentID":"e","connectionID":"n","clientID":"k","streamID":"s","rootSessionID":"ses_one","accessRevision":0,"requestID":"r"}"#,
        ) else {
            panic!("client source expected")
        };
        assert!(matches!(client.kind, Some(Client::Value2(_))));
    }

    #[test]
    fn tool_invocation_projects_optional_values_and_rejects_unknown_status_or_index() {
        let project = |json: &str| tool_invocation(J(&parse_json(json).unwrap()));
        let base = r#""id":"leaf","name":"read","tool":"read""#;
        let bare = project(&format!(r#"{{{base},"index":0,"status":"completed"}}"#)).unwrap();
        assert_eq!((bare.status, bare.index), (1, 0));
        assert!(bare.input.is_none() && bare.structured.is_none());
        let full = project(&format!(
            r#"{{{base},"index":9007199254740991,"status":"error","input":null,"structured":{{"exit":1}}}}"#
        ))
        .unwrap();
        assert_eq!((full.status, full.index), (2, 9_007_199_254_740_991));
        assert!(full.input.is_some() && full.structured.is_some());
        for invalid in [
            format!(r#"{{{base},"index":0,"status":"pending"}}"#),
            format!(r#"{{{base},"index":-1,"status":"completed"}}"#),
            format!(r#"{{{base},"index":0.5,"status":"completed"}}"#),
            r#"{"id":"leaf","name":"read","index":0,"status":"completed"}"#.to_owned(),
        ] {
            assert!(project(&invalid).is_err(), "{invalid}");
        }
    }
}

pub(super) const CUE_KIND: &[(&str, i32)] = &[
    ("explicit", 1),
    ("command", 2),
    ("path", 3),
    ("symbol", 4),
    ("tool_call", 5),
    ("tool_result", 6),
    ("tool_error", 7),
    ("workspace", 8),
    ("lifecycle", 9),
    ("compaction", 10),
    ("recovery", 11),
    ("memory_revision", 12),
    ("skill_revision", 13),
];
pub(super) const LIFECYCLE_DECISION: &[(&str, i32)] =
    &[("continue", 1), ("recover", 2), ("complete", 3)];
pub(super) const LIFECYCLE_BASIS: &[(&str, i32)] = &[
    ("tool_results", 1),
    ("answered", 2),
    ("truncated", 3),
    ("silent", 4),
    ("unsettled", 5),
];
pub(super) const HARNESS_STAGE: &[(&str, i32)] = &[
    ("baseline", 1),
    ("propose", 2),
    ("probe", 3),
    ("compose", 4),
    ("adopt", 5),
];
pub(super) const HARNESS_MODE: &[(&str, i32)] = &[
    ("adaptive", 1),
    ("parallel", 2),
    ("sequential", 3),
    ("disabled", 4),
];
pub(super) const RECALL_TRIGGER: &[(&str, i32)] = &[
    ("prompt", 1),
    ("cue", 2),
    ("explicit", 3),
    ("compaction", 4),
    ("recovery", 5),
    ("delegation", 6),
];
pub(super) const RECALL_METHOD: &[(&str, i32)] = &[
    ("explicit", 1),
    ("cue", 2),
    ("exact", 3),
    ("bm25", 4),
    ("semantic", 5),
    ("rrf", 6),
];
pub(super) const RECALL_OUTCOME: &[(&str, i32)] =
    &[("injected", 1), ("abstained", 2), ("restored", 3)];
pub(super) const RECALL_ABSTENTION: &[(&str, i32)] = &[
    ("no_match", 1),
    ("below_threshold", 2),
    ("explicit_unavailable", 3),
    ("out_of_budget", 4),
    ("offline", 5),
];
const RECALL_KIND: &[(&str, i32)] = &[("memory", 1), ("skill", 2)];
const RECALL_STAGE: &[(&str, i32)] = &[
    ("candidate", 1),
    ("rejected", 2),
    ("selected", 3),
    ("injected", 4),
    ("restored", 5),
];
const RECALL_REJECTION: &[(&str, i32)] = &[
    ("denied", 1),
    ("disabled", 2),
    ("stale", 3),
    ("out_of_scope", 4),
    ("over_budget", 5),
    ("duplicate", 6),
    ("conflict", 7),
    ("below_threshold", 8),
    ("manual_only", 9),
    ("missing", 10),
    ("untrusted", 11),
];
const RECALL_TRUST: &[(&str, i32)] = &[("trusted", 1), ("unverified", 2)];
const RECALL_FRESHNESS: &[(&str, i32)] = &[("fresh", 1), ("stale", 2), ("unknown", 3)];
const RECALL_LIFECYCLE: &[(&str, i32)] = &[
    ("active", 1),
    ("draft", 2),
    ("deprecated", 3),
    ("superseded", 4),
    ("archived", 5),
    ("unknown", 6),
];

pub(super) fn harness_experiences(json: J) -> R<v5::HarnessExperiences> {
    json.items()?
        .iter()
        .map(|value| match value {
            JsonValue::String(value) => Ok(crate::convert::wire(value)),
            _ => Err(Unrepresentable("experience")),
        })
        .collect::<R<Vec<_>>>()
        .map(|items| v5::HarnessExperiences { items })
}

pub(super) fn recall_methods(json: J) -> R<v5::SessionLogItemValue77DataMethods> {
    json.items()?
        .iter()
        .map(|method| match method {
            JsonValue::String(value) => RECALL_METHOD
                .iter()
                .find(|(name, _)| value.as_str() == Some(*name))
                .map(|(_, number)| *number)
                .ok_or(Unrepresentable("method")),
            _ => Err(Unrepresentable("method")),
        })
        .collect::<R<Vec<_>>>()
        .map(|items| v5::SessionLogItemValue77DataMethods { items })
}

pub(super) fn recall_items(json: J) -> R<v5::RecallItems> {
    json.items()?
        .iter()
        .map(|value| {
            let item = J(value);
            Ok(v5::RecallItem {
                kind: literal(item, "kind", RECALL_KIND)?,
                id: text(item, "id")?,
                stage: literal(item, "stage", RECALL_STAGE)?,
                method: literal(item, "method", RECALL_METHOD)?,
                scores: item
                    .opt("scores")
                    .map(|scores| {
                        Ok(v5::RecallScores {
                            bm25: opt_number(scores, "bm25")?,
                            semantic: opt_number(scores, "semantic")?,
                            rrf: opt_number(scores, "rrf")?,
                            rank: opt_count(scores, "rank")?,
                        })
                    })
                    .transpose()?,
                reason: text(item, "reason")?,
                rejection: opt_literal(item, "rejection", RECALL_REJECTION)?,
                source: {
                    let source = item.field("source")?;
                    v5::RecallSource {
                        id: text(source, "id")?,
                        revision: text(source, "revision")?,
                    }
                },
                okf: item
                    .opt("okf")
                    .map(|okf| {
                        Ok(v5::RecallOkf {
                            r#type: text(okf, "type")?,
                            trust: literal(okf, "trust", RECALL_TRUST)?,
                            freshness: literal(okf, "freshness", RECALL_FRESHNESS)?,
                            lifecycle: literal(okf, "lifecycle", RECALL_LIFECYCLE)?,
                        })
                    })
                    .transpose()?,
                tokens: opt_count(item, "tokens")?,
            })
        })
        .collect::<R<Vec<_>>>()
        .map(|items| v5::RecallItems { items })
}
