use crate::dispatch::Failure;
use ycoding_core::session::autonomy;
use ycoding_core::ycoding_schema::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonObject, JsonPath, JsonValue,
    LosslessString, ObjectDecoder, location, prompt,
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
        kind: Some(match level.get() {
            0 => Kind::Value1(value),
            1 => Kind::Value2(value),
            2 => Kind::Value3(value),
            _ => Kind::Value4(value),
        }),
    }
}

pub fn yolo_level(yolo: &v5::SessionAutonomyYolo) -> Result<autonomy::YoloLevel, Failure> {
    use v5::session_autonomy_yolo::Kind;
    let (position, value) = match yolo.kind {
        Some(Kind::Value1(value)) => (0, value),
        Some(Kind::Value2(value)) => (1, value),
        Some(Kind::Value3(value)) => (2, value),
        Some(Kind::Value4(value)) => (3, value),
        None => return Err(Failure::Invalid("missing yolo level".into())),
    };
    (value == f64::from(position))
        .then(|| autonomy::YoloLevel::new(position))
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
             }| v5::SessionOrchestrationQuestion {
                id: wire(&id.0),
                text: wire(text),
                data: data.as_ref().map(|data| json_to_value(data.as_value())),
                time: count(*time),
            },
        ),
        revision: count(task.revision),
        time: v5::SessionOrchestrationTaskTime {
            created: count(task.time.created),
            updated: count(task.time.updated),
        },
        pinned_at: task.pinned_at.map(count),
    })
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
        requests: None,
        generation_speed: None,
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
