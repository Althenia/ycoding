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
        Some("question_timed_out") => Kind::Value12(v5::SessionLogItemValue24DataChangeValue12 {
            r#type: 1,
            question_id: text(json, "questionID")?,
        }),
        Some("resumed") => Kind::Value13(v5::SessionLogItemValue24DataChangeValue13 { r#type: 1 }),
        _ => return Err(Unrepresentable("task change")),
    };
    Ok(v5::SessionLogItemValue24DataChange { kind: Some(kind) })
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
pub(super) const WITHDRAWN: &[(&str, i32)] = &[("reverted", 1), ("task_closed", 2)];

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
        Kind::Value3(v5::SessionReviewOriginValue3 {
            request_id: text(json, "requestID")?,
        })
    } else {
        Kind::Value1(v5::SessionReviewOriginValue1 {
            message_id: text(json, "messageID")?,
            call_id: text(json, "callID")?,
        })
    };
    Ok(v5::SessionReviewOrigin { kind: Some(kind) })
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
            request_id: text(json, "requestID")?,
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
