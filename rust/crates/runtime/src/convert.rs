use crate::dispatch::Failure;
use ycoding_core::session::autonomy;
use ycoding_core::ycoding_schema::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonObject, JsonPath, JsonValue,
    LosslessString, ObjectDecoder, guardrail, location, prompt, provider_request,
    schema::NonNegativeInt,
    session, session_cache_diagnostics,
    session_orchestration::{Progress, Question, State, Task},
};
use ycoding_protocol::{decode_lossless, encode_lossless, limits, v5};

pub fn text(value: &str) -> v5::LosslessString {
    v5::LosslessString {
        encoding: Some(v5::lossless_string::Encoding::Utf8(value.into())),
    }
}

pub fn wire(value: &LosslessString) -> v5::LosslessString {
    encode_lossless(&value.code_units().collect::<Vec<_>>())
}

pub fn domain(value: &v5::LosslessString) -> Result<LosslessString, Failure> {
    decode_lossless(value, limits::INLINE_BODY_BYTES as usize)
        .map(LosslessString::from_utf16)
        .map_err(|_| Failure::Invalid("malformed string".into()))
}

pub fn identifier<T: DomainDecode>(value: &v5::LosslessString) -> Result<T, Failure> {
    T::decode(&JsonValue::String(domain(value)?))
        .map_err(|_| Failure::Invalid("invalid identifier".into()))
}

pub fn readable(value: &LosslessString) -> String {
    String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>())
}

pub fn yolo(level: autonomy::YoloLevel) -> v5::SessionAutonomyYolo {
    use v5::session_autonomy_yolo::Kind;
    let value = f64::from(level.get());
    v5::SessionAutonomyYolo {
        kind: Some(Kind::Value1(value)),
    }
}

pub fn yolo_level(yolo: &v5::SessionAutonomyYolo) -> Result<autonomy::YoloLevel, Failure> {
    use v5::session_autonomy_yolo::Kind;
    let value = match yolo.kind {
        Some(Kind::Value1(value) | Kind::Value2(value) | Kind::Value3(value)) => value,
        None => return Err(Failure::Invalid("missing yolo level".into())),
    };
    (value.is_finite() && (0.0..=2.0).contains(&value) && value.fract() == 0.0)
        .then(|| autonomy::YoloLevel::new(value as u8))
        .flatten()
        .ok_or_else(|| Failure::Invalid("invalid yolo level".into()))
}

pub fn autonomy_state(state: &autonomy::State) -> v5::SessionAutonomyState {
    use v5::SessionAutonomyGoalStatus as Status;
    v5::SessionAutonomyState {
        mode: v5::SessionAutonomyMode::SessionautonomymodeNormal as i32,
        yolo: yolo(state.yolo),
        goal: state.goal.as_ref().map(|goal| v5::SessionAutonomyGoal {
            text: wire(&goal.text),
            status: match goal.status {
                autonomy::GoalStatus::Active => Status::SessionautonomygoalstatusActive,
                autonomy::GoalStatus::Completed => Status::SessionautonomygoalstatusCompleted,
                autonomy::GoalStatus::Stopped => Status::SessionautonomygoalstatusStopped,
                autonomy::GoalStatus::Exhausted => Status::SessionautonomygoalstatusExhausted,
            } as i32,
            iteration: goal.iteration,
            no_progress: goal.no_progress,
            max_no_progress: goal.max_no_progress,
            last_progress_digest: goal.last_progress_digest.as_ref().map(wire),
        }),
        sleep: state.sleep.then_some(v5::SessionAutonomySleep {}),
        auto_answer: state.auto_answer,
    }
}

pub fn autonomy_view(
    state: &autonomy::State,
    effective: v5::SessionAutonomyEffective,
) -> v5::SessionAutonomyView {
    let current = autonomy_state(state);
    v5::SessionAutonomyView {
        mode: current.mode,
        yolo: current.yolo,
        goal: current.goal,
        sleep: current.sleep,
        auto_answer: current.auto_answer,
        effective,
    }
}

pub fn task(task: &Task) -> Result<v5::SessionOrchestrationTask, DecodeError> {
    use v5::SessionOrchestrationTaskState as Wire;
    let count = |value: ycoding_core::ycoding_schema::schema::NonNegativeInt| value.get() as u64;
    Ok(v5::SessionOrchestrationTask {
        session_id: wire(task.session_id.as_lossless()),
        parent_id: wire(task.parent_id.as_lossless()),
        description: wire(&task.description),
        agent: wire(&task.agent),
        model: model_ref(&task.model.encode())?,
        background: task.background,
        state: match task.state {
            State::Starting => Wire::SessionorchestrationTaskStateStarting,
            State::Running => Wire::SessionorchestrationTaskStateRunning,
            State::Waiting => Wire::SessionorchestrationTaskStateWaiting,
            State::Cancelling => Wire::SessionorchestrationTaskStateCancelling,
            State::Cancelled => Wire::SessionorchestrationTaskStateCancelled,
            State::Completed => Wire::SessionorchestrationTaskStateCompleted,
            State::Failed => Wire::SessionorchestrationTaskStateFailed,
            State::Lost => Wire::SessionorchestrationTaskStateLost,
        } as i32,
        progress: task.progress.as_ref().map(|Progress { text, time }| {
            v5::SessionOrchestrationProgress {
                text: wire(text),
                time: count(*time),
            }
        }),
        question: task.question.as_ref().map(
            |Question {
                 id,
                 text,
                 data,
                 time,
                 deferred,
             }| v5::SessionOrchestrationQuestion {
                id: wire(&id.0),
                text: wire(text),
                data: data.as_ref().map(|data| json_to_value(data.as_value())),
                time: count(*time),
                deferred: *deferred,
            },
        ),
        revision: count(task.revision),
        time: v5::SessionOrchestrationTaskTime {
            created: count(task.time.created),
            updated: count(task.time.updated),
        },
        pinned_at: task.pinned_at.map(count),
        stopped_recovery: task.stopped_recovery.as_ref().map(|recovery| {
            v5::SessionOrchestrationTaskStoppedRecovery {
                item_id: wire(recovery.item_id.as_lossless()),
            }
        }),
    })
}

pub fn decision_choice(choice: guardrail::DecisionChoice) -> i32 {
    match choice {
        guardrail::DecisionChoice::ApproveAll => 1,
        guardrail::DecisionChoice::Approve => 2,
        guardrail::DecisionChoice::Reject => 3,
        guardrail::DecisionChoice::Escalate => 4,
    }
}

pub fn guardrail_reply(reply: guardrail::Reply) -> i32 {
    match reply {
        guardrail::Reply::Once => 1,
        guardrail::Reply::Always => 2,
        guardrail::Reply::Reject => 3,
    }
}

pub fn guardrail_source(source: &guardrail::Source) -> v5::GuardrailSource {
    v5::GuardrailSource {
        message_id: wire(source.message_id.as_lossless()),
        call_id: wire(&source.call_id),
    }
}

pub fn grades(grades: &[guardrail::Grade]) -> Vec<v5::GuardrailGrade> {
    grades
        .iter()
        .map(|grade| v5::GuardrailGrade {
            choice: decision_choice(grade.choice),
            confidence: grade.confidence.get(),
            evidence: wire(&grade.evidence),
        })
        .collect()
}

pub fn escalation(escalation: &guardrail::Escalation) -> v5::GuardrailEscalation {
    v5::GuardrailEscalation {
        choice: escalation.choice.map(decision_choice),
        confidence: escalation.confidence.map(guardrail::Confidence::get),
        grades: escalation
            .grades
            .as_ref()
            .map(|items| v5::GuardrailEscalationGrades {
                items: grades(items),
            }),
    }
}

pub fn value_to_json(value: &v5::Value) -> Result<JsonValue, Failure> {
    use v5::value::Kind;
    match value.kind.as_ref() {
        Some(Kind::Null(_)) => Ok(JsonValue::Null),
        Some(Kind::Boolean(boolean)) => Ok(JsonValue::Bool(*boolean)),
        Some(Kind::Number(number)) => Ok(JsonValue::Number(*number)),
        Some(Kind::String(string)) => domain(string).map(JsonValue::String),
        Some(Kind::Bytes(_)) => Err(Failure::Invalid("bytes are not a JSON value".into())),
        Some(Kind::List(list)) => list
            .items
            .iter()
            .map(value_to_json)
            .collect::<Result<_, _>>()
            .map(JsonValue::Array),
        Some(Kind::Object(object)) => {
            let mut entries = JsonObject::new();
            for entry in &object.entries {
                entries.insert(domain(&entry.key)?, value_to_json(&entry.value)?);
            }
            Ok(JsonValue::Object(entries))
        }
        None => Err(Failure::Invalid("missing value".into())),
    }
}

pub fn json_to_value(value: &JsonValue) -> v5::Value {
    use v5::value::Kind;
    let kind = match value {
        JsonValue::Null => Kind::Null(v5::Empty {}),
        JsonValue::Bool(boolean) => Kind::Boolean(*boolean),
        JsonValue::Number(number) => Kind::Number(*number),
        JsonValue::String(string) => Kind::String(wire(string)),
        JsonValue::Array(items) => Kind::List(v5::ValueList {
            items: items.iter().map(json_to_value).collect(),
        }),
        JsonValue::Object(object) => Kind::Object(v5::ValueObject {
            entries: object
                .iter()
                .map(|(key, value)| v5::ValueEntry {
                    key: wire(key),
                    value: json_to_value(value),
                })
                .collect(),
        }),
    };
    v5::Value { kind: Some(kind) }
}

pub fn mention_domain(mention: &v5::PromptMention) -> Result<prompt::Mention, Failure> {
    Ok(prompt::Mention {
        start: mention.start,
        end: mention.end,
        text: domain(&mention.text)?,
    })
}

pub fn agent_domain(agent: &v5::PromptAgentAttachment) -> Result<prompt::AgentAttachment, Failure> {
    Ok(prompt::AgentAttachment {
        name: domain(&agent.name)?,
        mention: agent.mention.as_ref().map(mention_domain).transpose()?,
    })
}

pub fn metadata_domain(
    metadata: &[v5::SessionPromptRequestPayloadMetadataEntry],
) -> Result<JsonObject, Failure> {
    let mut object = JsonObject::new();
    for entry in metadata {
        object.insert(domain(&entry.key)?, value_to_json(&entry.value)?);
    }
    Ok(object)
}

pub fn session_info(info: &session::Info) -> Result<v5::SessionInfo, DecodeError> {
    let value = info.encode();
    let path = JsonPath::default();
    let object = ObjectDecoder::new(&value, &path)?;
    let string = |key: &str| -> Result<Option<v5::LosslessString>, DecodeError> {
        Ok(object.optional::<LosslessString>(key)?.as_ref().map(wire))
    };
    let nested = |key: &str| object.optional::<JsonValue>(key);
    Ok(v5::SessionInfo {
        id: wire(&object.field::<LosslessString>("id")?),
        parent_id: string("parentID")?,
        fork: nested("fork")?.as_ref().map(fork).transpose()?,
        project_id: wire(&object.field::<LosslessString>("projectID")?),
        agent: string("agent")?,
        model: nested("model")?.as_ref().map(model_ref).transpose()?,
        daybreak: object
            .optional::<LosslessString>("daybreak")?
            .map(|daybreak| daybreak_value(&daybreak))
            .transpose()?,
        permission_ceiling: nested("permissionCeiling")?
            .as_ref()
            .map(ruleset)
            .transpose()?,
        cost: object.field::<f64>("cost")?,
        tokens: tokens(&object.field::<JsonValue>("tokens")?)?,
        time: time(&object.field::<JsonValue>("time")?)?,
        title: wire(&object.field::<LosslessString>("title")?),
        location: location(&object.field::<JsonValue>("location")?)?,
        subpath: string("subpath")?,
        revert: nested("revert")?.as_ref().map(revert).transpose()?,
    })
}

pub fn cache_diagnostics(
    info: &session_cache_diagnostics::Info,
) -> Result<v5::SessionCacheDiagnostics, DecodeError> {
    let count = |value: NonNegativeInt| value.get() as u64;
    let mechanism = info.cache.mechanism.0.as_str().and_then(|name| match name {
        "openai-prefix-cache" => {
            Some(v5::SessionCacheMechanism::SessionCachemechanismOpenaiPrefixCache)
        }
        "openrouter-cache-control" => {
            Some(v5::SessionCacheMechanism::SessionCachemechanismOpenrouterCacheControl)
        }
        "anthropic-cache-control" => {
            Some(v5::SessionCacheMechanism::SessionCachemechanismAnthropicCacheControl)
        }
        "bedrock-cache-point" => {
            Some(v5::SessionCacheMechanism::SessionCachemechanismBedrockCachePoint)
        }
        "gemini-prefix-cache" => {
            Some(v5::SessionCacheMechanism::SessionCachemechanismGeminiPrefixCache)
        }
        "provider-reported" => {
            Some(v5::SessionCacheMechanism::SessionCachemechanismProviderReported)
        }
        "none" => Some(v5::SessionCacheMechanism::SessionCachemechanismNone),
        _ => None,
    });
    Ok(v5::SessionCacheDiagnostics {
        model: model_ref(&info.model.encode())?,
        context_breakdown: info.context_breakdown.as_ref().map(|breakdown| {
            v5::SessionContextBreakdown {
                system: count(breakdown.system),
                tools: count(breakdown.tools),
                user: count(breakdown.user),
                assistant: count(breakdown.assistant),
                reasoning: count(breakdown.reasoning),
                tool_calls: count(breakdown.tool_calls),
                other: count(breakdown.other),
            }
        }),
        context: v5::SessionCacheDiagnosticsContext {
            total: count(info.context.total),
            limit: info.context.limit.map(count),
            remaining: info.context.remaining.map(count),
            percent: info.context.percent,
        },
        tokens: v5::SessionCacheDiagnosticsTokens {
            uncached_input: count(info.tokens.uncached_input),
            output: count(info.tokens.output),
            reasoning: count(info.tokens.reasoning),
            cache_read: count(info.tokens.cache_read),
            cache_write: count(info.tokens.cache_write),
        },
        cache: v5::SessionCacheDiagnosticsCache {
            eligible: count(info.cache.eligible),
            hit_ratio: info.cache.hit_ratio,
            mechanism: mechanism.ok_or_else(|| {
                JsonPath::default().error(DecodeErrorKind::Expected("known cache mechanism"))
            })? as i32,
            read_reported: info.cache.read_reported,
            write_reported: info.cache.write_reported,
            minimum_tokens: info.cache.minimum_tokens.map(count),
            below_minimum: info.cache.below_minimum,
        },
        estimated_cost: info.estimated_cost.map(|cost| cost.get()),
        requests: info
            .requests
            .as_ref()
            .map(provider_summary)
            .transpose()
            .map_err(|_| {
                JsonPath::default()
                    .error(DecodeErrorKind::Expected("representable request summary"))
            })?,
        generation_speed: info
            .generation_speed
            .as_ref()
            .map(generation_speed)
            .transpose()?,
    })
}

pub fn generation_speed(
    history: &session_cache_diagnostics::GenerationSpeedHistory,
) -> Result<v5::SessionGenerationSpeedHistory, DecodeError> {
    let sample = |speed: &session_cache_diagnostics::GenerationSpeed| -> Result<v5::SessionGenerationSpeed, DecodeError> {
        Ok(v5::SessionGenerationSpeed {
            model: model_ref(&speed.model.encode())?, tokens: speed.tokens.get() as u64,
            duration_ns: speed.duration_ns.get() as u64, tokens_per_second: speed.tokens_per_second,
            estimated: speed.estimated,
        })
    };
    Ok(v5::SessionGenerationSpeedHistory {
        model: history
            .model
            .as_ref()
            .map(|model| model_ref(&model.encode()))
            .transpose()?,
        unreported_reason: history.unreported_reason.as_ref().map(wire),
        latest: history.latest.as_ref().map(sample).transpose()?,
        recent: v5::SessionGenerationSpeedHistoryRecent {
            items: history
                .recent
                .iter()
                .map(sample)
                .collect::<Result<_, _>>()?,
        },
    })
}

pub fn provider_summary(
    summary: &provider_request::Summary,
) -> Result<v5::ProviderRequestSummary, DecodeError> {
    let count = |value: NonNegativeInt| value.get() as u64;
    let invalid =
        || JsonPath::default().error(DecodeErrorKind::Expected("representable request summary"));
    let models = summary
        .models
        .as_ref()
        .map(|models| {
            models
                .iter()
                .map(|spend| {
                    Ok(v5::ProviderRequestSummaryModelsItem {
                        model: model_ref(&spend.model.encode())?,
                        requests: count(spend.requests),
                        tokens: tokens(&spend.tokens.encode())?,
                        cache_read_reported: spend.cache_read_reported,
                        cost: spend.cost.map(|cost| cost.get()),
                        cost_provenance: spend
                            .cost_provenance
                            .as_ref()
                            .map(|value| match value.0.as_str() {
                                Some("recorded") => Ok(1),
                                Some("current_catalog") => Ok(2),
                                _ => Err(invalid()),
                            })
                            .transpose()?,
                    })
                })
                .collect::<Result<Vec<_>, DecodeError>>()
                .map(|items| v5::ProviderRequestSummaryModels { items })
        })
        .transpose()?;
    let invalidations = [
        "first-request",
        "compaction-reset",
        "model-switched",
        "model-variant-switched",
        "stable-hit",
        "prefix-changed",
        "system-prefix-changed",
        "tool-prefix-changed",
        "below-minimum",
        "provider-not-reported",
        "cache-disabled",
        "retry-fallback",
    ];
    Ok(v5::ProviderRequestSummary {
        logical: count(summary.logical),
        physical: count(summary.physical),
        helpers: count(summary.helpers),
        continued: count(summary.continued),
        fallback: count(summary.fallback),
        cache_read_reported: summary.cache_read_reported,
        cost: summary.cost.map(|cost| cost.get()),
        models,
        tokens: tokens(&summary.tokens.encode())?,
        latest_invalidation: summary
            .latest_invalidation
            .as_ref()
            .map(|value| {
                invalidations
                    .iter()
                    .position(|name| value.0.as_str() == Some(name))
                    .map(|index| index as i32 + 1)
                    .ok_or_else(invalid)
            })
            .transpose()?,
        latest_namespace: summary.latest_namespace.as_ref().map(wire),
        latest_timing: summary
            .latest_timing
            .as_ref()
            .map(|timing| v5::ProviderRequestTiming {
                estimated_tokens: timing.estimated_tokens.map(|value| value.get() as u64),
                estimated_generation_duration_ns: timing
                    .estimated_generation_duration_ns
                    .map(|value| value.get() as u64),
                first_output_ms: timing.first_output_ms.map(count),
                total_ms: timing.total_ms.map(count),
                retry_wait_ms: timing.retry_wait_ms.map(count),
                prompt_eval_duration_ns: timing.prompt_eval_duration_ns.map(count),
                generation_duration_ns: timing.generation_duration_ns.map(count),
                observed_generation_duration_ns: timing
                    .observed_generation_duration_ns
                    .map(|value| value.get() as u64),
                generated_tokens: timing.generated_tokens.map(|value| value.get() as u64),
                load_duration_ns: timing.load_duration_ns.map(count),
            }),
    })
}

fn fork(value: &JsonValue) -> Result<v5::SessionInfoFork, DecodeError> {
    let path = JsonPath::default();
    let object = ObjectDecoder::new(value, &path)?;
    Ok(v5::SessionInfoFork {
        session_id: wire(&object.field::<LosslessString>("sessionID")?),
        message_id: object
            .optional::<LosslessString>("messageID")?
            .as_ref()
            .map(wire),
    })
}

pub fn model_ref(value: &JsonValue) -> Result<v5::ModelRef, DecodeError> {
    let path = JsonPath::default();
    let object = ObjectDecoder::new(value, &path)?;
    Ok(v5::ModelRef {
        id: wire(&object.field::<LosslessString>("id")?),
        provider_id: wire(&object.field::<LosslessString>("providerID")?),
        variant: object
            .optional::<LosslessString>("variant")?
            .as_ref()
            .map(wire),
        profile: object
            .optional::<LosslessString>("profile")?
            .as_ref()
            .map(wire),
    })
}

fn daybreak_value(value: &LosslessString) -> Result<i32, DecodeError> {
    match value.as_str() {
        Some("daybreak_blue") => Ok(v5::ModelDaybreak::DaybreakBlue as i32),
        Some("daybreak_red") => Ok(v5::ModelDaybreak::DaybreakRed as i32),
        _ => Err(JsonPath::default().error(
            ycoding_core::ycoding_schema::DecodeErrorKind::Expected("daybreak"),
        )),
    }
}

fn ruleset(value: &JsonValue) -> Result<v5::PermissionRuleset, DecodeError> {
    let path = JsonPath::default();
    let JsonValue::Array(rules) = value else {
        return Err(
            path.error(ycoding_core::ycoding_schema::DecodeErrorKind::Expected(
                "array",
            )),
        );
    };
    let items = rules
        .iter()
        .map(|rule| {
            let object = ObjectDecoder::new(rule, &path)?;
            let effect = object.field::<LosslessString>("effect")?;
            Ok(v5::PermissionRule {
                action: wire(&object.field::<LosslessString>("action")?),
                resource: wire(&object.field::<LosslessString>("resource")?),
                effect: match effect.as_str() {
                    Some("allow") => v5::PermissionEffect::Allow as i32,
                    Some("deny") => v5::PermissionEffect::Deny as i32,
                    Some("ask") => v5::PermissionEffect::Ask as i32,
                    _ => {
                        return Err(path.error(
                            ycoding_core::ycoding_schema::DecodeErrorKind::Expected("effect"),
                        ));
                    }
                },
            })
        })
        .collect::<Result<_, DecodeError>>()?;
    Ok(v5::PermissionRuleset { items })
}

fn tokens(value: &JsonValue) -> Result<v5::TokenUsageInfo, DecodeError> {
    let path = JsonPath::default();
    let object = ObjectDecoder::new(value, &path)?;
    let cache_value = object.field::<JsonValue>("cache")?;
    let cache = ObjectDecoder::new(&cache_value, &path)?;
    Ok(v5::TokenUsageInfo {
        input: object.field("input")?,
        output: object.field("output")?,
        reasoning: object.field("reasoning")?,
        cache: v5::TokenUsageInfoCache {
            read: cache.field("read")?,
            write: cache.field("write")?,
        },
    })
}

fn time(value: &JsonValue) -> Result<v5::SessionInfoTime, DecodeError> {
    let path = JsonPath::default();
    let object = ObjectDecoder::new(value, &path)?;
    Ok(v5::SessionInfoTime {
        created: object.field("created")?,
        updated: object.field("updated")?,
        active: object.optional("active")?,
        archived: object.optional("archived")?,
        pinned: object.optional("pinned")?,
    })
}

fn location(value: &JsonValue) -> Result<v5::LocationRef, DecodeError> {
    let path = JsonPath::default();
    let object = ObjectDecoder::new(value, &path)?;
    Ok(v5::LocationRef {
        directory: wire(&object.field::<LosslessString>("directory")?),
        workspace_id: object
            .optional::<LosslessString>("workspaceID")?
            .as_ref()
            .map(wire),
    })
}

pub fn revert(value: &JsonValue) -> Result<v5::SessionRevert, DecodeError> {
    let path = JsonPath::default();
    let object = ObjectDecoder::new(value, &path)?;
    let files =
        object
            .optional::<JsonValue>("files")?
            .map(|files| {
                let JsonValue::Array(files) = files else {
                    return Err(path.error(
                        ycoding_core::ycoding_schema::DecodeErrorKind::Expected("array"),
                    ));
                };
                files
                    .iter()
                    .map(file_diff)
                    .collect::<Result<_, _>>()
                    .map(|items| v5::SessionRevertFiles { items })
            })
            .transpose()?;
    Ok(v5::SessionRevert {
        message_id: wire(&object.field::<LosslessString>("messageID")?),
        snapshot: object
            .optional::<LosslessString>("snapshot")?
            .as_ref()
            .map(wire),
        files,
    })
}

fn file_diff(value: &JsonValue) -> Result<v5::FileDiffInfo, DecodeError> {
    let path = JsonPath::default();
    let object = ObjectDecoder::new(value, &path)?;
    let status = object.field::<LosslessString>("status")?;
    Ok(v5::FileDiffInfo {
        file: wire(&object.field::<LosslessString>("file")?),
        patch: wire(&object.field::<LosslessString>("patch")?),
        additions: object.field::<f64>("additions")? as u64,
        deletions: object.field::<f64>("deletions")? as u64,
        status: match status.as_str() {
            Some("added") => v5::FileDiffInfoStatus::FilediffInfoStatusAdded as i32,
            Some("deleted") => v5::FileDiffInfoStatus::FilediffInfoStatusDeleted as i32,
            Some("modified") => v5::FileDiffInfoStatus::FilediffInfoStatusModified as i32,
            _ => {
                return Err(
                    path.error(ycoding_core::ycoding_schema::DecodeErrorKind::Expected(
                        "status",
                    )),
                );
            }
        },
    })
}

pub fn identity(value: &impl DomainEncode) -> Result<v5::LosslessString, Failure> {
    match value.encode() {
        JsonValue::String(text) => Ok(wire(&text)),
        _ => Err(Failure::Unavailable(
            "stored identifier is not representable".into(),
        )),
    }
}

pub fn location_info(info: &location::Info) -> v5::LocationInfo {
    v5::LocationInfo {
        directory: wire(info.directory.as_lossless()),
        workspace_id: info
            .workspace_id
            .as_ref()
            .map(|workspace| wire(workspace.as_lossless())),
        project: v5::LocationInfoProject {
            id: wire(info.project.id.as_lossless()),
            directory: wire(info.project.directory.as_lossless()),
        },
        backend_paths: None,
    }
}

pub fn file_diff_info(info: &ycoding_core::ycoding_schema::file_diff::Info) -> v5::FileDiffInfo {
    use ycoding_core::ycoding_schema::file_diff::Status;
    v5::FileDiffInfo {
        file: wire(&info.file),
        patch: wire(&info.patch),
        additions: info.additions.get() as u64,
        deletions: info.deletions.get() as u64,
        status: match info.status {
            Status::Added => v5::FileDiffInfoStatus::FilediffInfoStatusAdded,
            Status::Deleted => v5::FileDiffInfoStatus::FilediffInfoStatusDeleted,
            Status::Modified => v5::FileDiffInfoStatus::FilediffInfoStatusModified,
        } as i32,
    }
}

pub fn object_domain<'a>(
    entries: impl IntoIterator<Item = (&'a v5::LosslessString, &'a v5::Value)>,
) -> Result<JsonObject, Failure> {
    let mut object = JsonObject::new();
    for (key, value) in entries {
        object.insert(domain(key)?, value_to_json(value)?);
    }
    Ok(object)
}

#[cfg(test)]
mod tests {
    #[test]
    fn usage_wire_preserves_estimated_timing_and_speed_presence() {
        use ycoding_core::ycoding_schema::{
            DomainDecode, parse_json, provider_request, session_cache_diagnostics,
        };
        let history = session_cache_diagnostics::GenerationSpeedHistory::decode(&parse_json(r#"{"model":{"providerID":"p","id":"m"},"unreportedReason":"synthetic reason","recent":[{"model":{"providerID":"p","id":"m"},"tokens":12,"durationNs":2000000000,"tokensPerSecond":6,"estimated":true}]}"#).unwrap()).unwrap();
        let wire = super::generation_speed(&history).unwrap();
        assert!(wire.model.is_some());
        assert!(wire.unreported_reason.is_some());
        assert_eq!(wire.recent.items[0].estimated, Some(true));
        let empty = session_cache_diagnostics::GenerationSpeedHistory::decode(
            &parse_json(r#"{"recent":[]}"#).unwrap(),
        )
        .unwrap();
        let wire = super::generation_speed(&empty).unwrap();
        assert!(wire.model.is_none());
        assert!(wire.unreported_reason.is_none());
        let summary = provider_request::Summary::decode(&parse_json(r#"{"logical":1,"physical":1,"helpers":0,"continued":0,"fallback":0,"tokens":{"input":1,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"latestTiming":{"estimatedTokens":12,"estimatedGenerationDurationNs":2000000000}}"#).unwrap()).unwrap();
        let timing = super::provider_summary(&summary)
            .unwrap()
            .latest_timing
            .unwrap();
        assert_eq!(timing.estimated_tokens, Some(12));
        assert_eq!(timing.estimated_generation_duration_ns, Some(2_000_000_000));
        assert!(timing.generated_tokens.is_none());
    }
    use super::{yolo, yolo_level};
    use ycoding_protocol::v5::{SessionAutonomyYolo, session_autonomy_yolo::Kind};

    #[test]
    fn yolo_literals_follow_the_typescript_first_matching_branch_codec() {
        for value in [0.0, 1.0, 2.0] {
            let canonical = SessionAutonomyYolo {
                kind: Some(Kind::Value1(value)),
            };
            for kind in [
                Kind::Value1(value),
                Kind::Value2(value),
                Kind::Value3(value),
            ] {
                let level = yolo_level(&SessionAutonomyYolo { kind: Some(kind) }).unwrap();
                assert_eq!(f64::from(level.get()), value);
                assert_eq!(yolo(level), canonical);
            }
        }
        assert!(yolo_level(&SessionAutonomyYolo { kind: None }).is_err());
        for value in [
            -1.0,
            0.5,
            3.0,
            4.0,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
        ] {
            for kind in [
                Kind::Value1(value),
                Kind::Value2(value),
                Kind::Value3(value),
            ] {
                assert!(yolo_level(&SessionAutonomyYolo { kind: Some(kind) }).is_err());
            }
        }
    }
}

#[cfg(test)]
mod task_tests {
    use super::*;

    fn decoded(json: &str) -> Task {
        Task::decode(&ycoding_core::ycoding_schema::parse_json(json).unwrap()).unwrap()
    }

    #[test]
    fn task_wire_carries_the_deferred_question_flag_and_the_stopped_recovery_item() {
        let task = task(&decoded(
            r#"{"sessionID":"ses_child","parentID":"ses_parent","description":"Explore","agent":"build","model":{"providerID":"openai","id":"fixture"},"background":true,"state":"waiting","question":{"id":"qst_fixture","text":"Which branch?","time":3,"deferred":true},"revision":4,"time":{"created":1,"updated":2},"stoppedRecovery":{"itemID":"rvw_fixture"}}"#,
        ))
        .unwrap();
        assert_eq!(task.question.unwrap().deferred, Some(true));
        assert_eq!(
            task.stopped_recovery.map(|recovery| recovery.item_id),
            Some(text("rvw_fixture"))
        );
        let plain = super::task(&decoded(
            r#"{"sessionID":"ses_child","parentID":"ses_parent","description":"Explore","agent":"build","model":{"providerID":"openai","id":"fixture"},"background":false,"state":"running","question":{"id":"qst_fixture","text":"Which branch?","time":3},"revision":0,"time":{"created":1,"updated":1}}"#,
        ))
        .unwrap();
        assert_eq!(plain.question.unwrap().deferred, None);
        assert!(plain.stopped_recovery.is_none());
    }

    #[test]
    fn autonomy_state_reports_sleep_only_as_a_presence_marker() {
        let awake = autonomy::State::default();
        assert_eq!(autonomy_state(&awake).sleep, None);
        let asleep = autonomy::State {
            sleep: true,
            ..autonomy::State::default()
        };
        let wire = autonomy_state(&asleep);
        assert_eq!(wire.sleep, Some(v5::SessionAutonomySleep {}));
        assert_eq!(wire.yolo, autonomy_state(&awake).yolo);
    }

    #[test]
    fn guardrail_escalation_maps_choices_confidence_and_ordered_grades() {
        let escalation = guardrail::Escalation::decode(
            &ycoding_core::ycoding_schema::parse_json(
                r#"{"choice":"escalate","confidence":0.25,"grades":[{"choice":"approve_all","confidence":0,"evidence":"broad"},{"choice":"reject","confidence":1,"evidence":"narrow"}]}"#,
            )
            .unwrap(),
        )
        .unwrap();
        let wire = super::escalation(&escalation);
        assert_eq!(wire.choice, Some(4));
        assert_eq!(wire.confidence, Some(0.25));
        let grades = wire.grades.unwrap().items;
        assert_eq!(
            grades
                .iter()
                .map(|grade| (grade.choice, grade.confidence, grade.evidence.clone()))
                .collect::<Vec<_>>(),
            vec![(1, 0.0, text("broad")), (3, 1.0, text("narrow"))]
        );
        let empty = super::escalation(
            &guardrail::Escalation::decode(
                &ycoding_core::ycoding_schema::parse_json("{}").unwrap(),
            )
            .unwrap(),
        );
        assert_eq!(empty, v5::GuardrailEscalation::default());
    }
}
