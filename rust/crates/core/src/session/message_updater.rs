use super::{
    key,
    projector::{insert_message, record_error},
};
use std::ops::Bound;
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonObject, JsonPath, JsonValue, ObjectDecoder, session_event,
    session_message,
};
use ycoding_store::{
    Error, IndexOrder, IndexQuery, KeyPart, Write,
    session::{Document, Event, Message, MessageTable, SessionTable},
    tuple_key,
};

pub(crate) fn fold(
    tx: &mut Write<'_>,
    event: &Event,
    decoded: &session_event::Event,
) -> Result<(), Error> {
    let data = decoded.data.encode();
    let path = JsonPath::default();
    let object = ObjectDecoder::new(&data, &path).map_err(record_error)?;
    let time = ycoding_schema::schema::DateTimeUtcFromMillis::new(event.created as f64)
        .map_err(record_error)?;
    let id = session_message::Id::from_event(&decoded.id);
    match decoded.event_type.as_str() {
        Some("session.step.started") => {
            let assistant_id: session_message::Id =
                object.field("assistantMessageID").map_err(record_error)?;
            if let Some(row) = owned_assistant(tx, event, &assistant_id)? {
                let session_message::Info::Assistant(mut assistant) = row.info()? else {
                    return Ok(());
                };
                assistant.agent = object.field("agent").map_err(record_error)?;
                assistant.model = object.field("model").map_err(record_error)?;
                assistant.retry = None;
                assistant.error = None;
                assistant.finish = None;
                assistant.time.completed = None;
                if let Some(start) = object.optional("snapshot").map_err(record_error)? {
                    assistant
                        .snapshot
                        .get_or_insert(session_message::SnapshotRange {
                            start: None,
                            end: None,
                            files: None,
                        })
                        .start = Some(start);
                }
                return update_message(tx, &row, &session_message::Info::Assistant(assistant));
            }
            if let Some(row) = current_assistant(tx, event)? {
                let session_message::Info::Assistant(mut assistant) = row.info()? else {
                    return Ok(());
                };
                assistant.retry = None;
                assistant.time.completed = Some(time);
                update_message(tx, &row, &session_message::Info::Assistant(assistant))?;
            }
            insert_message(
                tx,
                event,
                &session_message::Info::Assistant(Box::new(session_message::Assistant {
                    id: assistant_id,
                    metadata: decoded.metadata.clone(),
                    time: session_message::CompletedTime {
                        created: time,
                        completed: None,
                    },
                    agent: object.field("agent").map_err(record_error)?,
                    model: object.field("model").map_err(record_error)?,
                    content: Vec::new(),
                    skill_deactivations: None,
                    snapshot: object
                        .optional("snapshot")
                        .map_err(record_error)?
                        .map(|start| session_message::SnapshotRange {
                            start: Some(start),
                            end: None,
                            files: None,
                        }),
                    finish: None,
                    cost: None,
                    tokens: None,
                    diagnostics: None,
                    error: None,
                    retry: None,
                    reroutes: None,
                })),
            )
        }
        Some(
            "session.step.ended"
            | "session.step.failed"
            | "session.text.started"
            | "session.text.ended"
            | "session.reasoning.started"
            | "session.reasoning.ended"
            | "session.retry.scheduled"
            | "session.step.rerouted"
            | "session.tool.input.started"
            | "session.tool.input.ended"
            | "session.tool.called"
            | "session.tool.progress"
            | "session.tool.success"
            | "session.tool.failed",
        ) => {
            let assistant_id = object.field("assistantMessageID").map_err(record_error)?;
            if let Some(row) = owned_assistant(tx, event, &assistant_id)? {
                let session_message::Info::Assistant(mut assistant) = row.info()? else {
                    return Ok(());
                };
                update_assistant(&mut assistant, decoded)?;
                update_message(tx, &row, &session_message::Info::Assistant(assistant))?;
            }
            if matches!(
                decoded.event_type.as_str(),
                Some("session.step.ended" | "session.step.failed")
            ) {
                let mut session = tx
                    .get::<SessionTable>(&key(&event.aggregate_id))?
                    .ok_or(Error::Rejected("Session not found"))?;
                session.time_active = Some(
                    session
                        .time_active
                        .map_or(event.created, |time| time.max(event.created)),
                );
                let cost: Option<ycoding_schema::money::Usd> =
                    object.optional("cost").map_err(record_error)?;
                let tokens: Option<ycoding_schema::token_usage::Info> =
                    object.optional("tokens").map_err(record_error)?;
                if let (Some(cost), Some(tokens)) = (cost, tokens) {
                    session.cost += cost.get();
                    session.tokens_input = add_tokens(session.tokens_input, tokens.input.get())?;
                    session.tokens_output = add_tokens(session.tokens_output, tokens.output.get())?;
                    session.tokens_reasoning =
                        add_tokens(session.tokens_reasoning, tokens.reasoning.get())?;
                    session.tokens_cache_read =
                        add_tokens(session.tokens_cache_read, tokens.cache.read.get())?;
                    session.tokens_cache_write =
                        add_tokens(session.tokens_cache_write, tokens.cache.write.get())?;
                }
                SessionTable::put(tx, &session)?;
            }
            Ok(())
        }
        Some("session.input.consumed") => {
            for id in object
                .field::<Vec<session_message::Id>>("inputIDs")
                .map_err(record_error)?
            {
                let Some(row) = tx.get::<MessageTable>(&key(id.as_lossless()))? else {
                    continue;
                };
                if row.session_id != event.aggregate_id || row.type_.as_str() != Some("user") {
                    continue;
                }
                let session_message::Info::User(mut user) = row.info()? else {
                    continue;
                };
                if user.time.consumed.is_some() {
                    continue;
                }
                user.time.consumed = Some(time);
                update_message(tx, &row, &session_message::Info::User(user))?;
            }
            Ok(())
        }
        Some("session.agent.selected") => {
            let agent = object.field("agent").map_err(record_error)?;
            insert_message(
                tx,
                event,
                &session_message::Info::AgentSelected(session_message::AgentSelected {
                    id,
                    agent,
                    artifact: object.optional("artifact").map_err(record_error)?,
                    metadata: decoded.metadata.clone(),
                    time: session_message::BaseTime { created: time },
                }),
            )?;
            let mut session = tx
                .get::<SessionTable>(&key(&event.aggregate_id))?
                .ok_or(Error::Rejected("Session not found"))?;
            session.agent = object.optional("agent").map_err(record_error)?;
            session.time_updated = event.created;
            SessionTable::put(tx, &session)
        }
        Some("session.profile.bound") => {
            let mut session = tx
                .get::<SessionTable>(&key(&event.aggregate_id))?
                .ok_or(Error::Rejected("Session not found"))?;
            let binding: Option<ycoding_schema::session_event::ProfileBinding> =
                object.optional("binding").map_err(record_error)?;
            session.profile_binding = binding.as_ref().map(Document::from_domain).transpose()?;
            SessionTable::put(tx, &session)
        }
        Some("session.model.selected") => {
            let mut session = tx
                .get::<SessionTable>(&key(&event.aggregate_id))?
                .ok_or(Error::Rejected("Session not found"))?;
            let model: ycoding_schema::model::Ref = object.field("model").map_err(record_error)?;
            insert_message(
                tx,
                event,
                &session_message::Info::ModelSelected(session_message::ModelSelected {
                    id,
                    model: model.clone(),
                    previous: session
                        .model
                        .as_ref()
                        .map(|model| model.domain())
                        .transpose()?,
                    metadata: decoded.metadata.clone(),
                    time: session_message::BaseTime { created: time },
                }),
            )?;
            session.model = Some(Document::from_domain(&model)?);
            session.profile_binding = None;
            session.time_updated = event.created;
            SessionTable::put(tx, &session)
        }
        Some("session.synthetic") => insert_message(
            tx,
            event,
            &session_message::Info::Synthetic(session_message::Synthetic {
                id,
                metadata: object.optional("metadata").map_err(record_error)?,
                text: object.field("text").map_err(record_error)?,
                description: object.optional("description").map_err(record_error)?,
                time: session_message::BaseTime { created: time },
            }),
        ),
        Some("session.context.observed") => {
            let source: ycoding_schema::LosslessString =
                object.field("source").map_err(record_error)?;
            let mut metadata = ycoding_schema::JsonObject::new();
            metadata.insert("contextSource".into(), source.encode());
            let text = object.field("text").map_err(record_error)?;
            let message = if source.as_str() == Some("team-view") {
                session_message::Info::Synthetic(session_message::Synthetic {
                    id,
                    metadata: Some(metadata),
                    text,
                    description: Some("TeamView update".into()),
                    time: session_message::BaseTime { created: time },
                })
            } else {
                session_message::Info::System(session_message::System {
                    id,
                    metadata: Some(metadata),
                    text,
                    time: session_message::BaseTime { created: time },
                })
            };
            insert_message(tx, event, &message)
        }
        Some("session.guardrail.escalated") => {
            let choice: Option<ycoding_schema::guardrail::DecisionChoice> =
                object.optional("choice").map_err(record_error)?;
            let confidence: Option<ycoding_schema::guardrail::Confidence> =
                object.optional("confidence").map_err(record_error)?;
            insert_message(
                tx,
                event,
                &session_message::Info::System(session_message::System {
                    id,
                    metadata: None,
                    text: format!(
                        "Decision model escalated this guardrail review · choice {} · confidence {}",
                        choice.map_or("unreported", |value| value.as_str()),
                        confidence.map_or_else(|| "unreported".to_owned(), |value| value.get().to_string()),
                    )
                    .into(),
                    time: session_message::BaseTime { created: time },
                }),
            )
        }
        Some("session.review.withdrawn") => {
            let item: ycoding_schema::session_review::Id =
                object.field("itemID").map_err(record_error)?;
            let reason: ycoding_schema::LosslessString =
                object.field("reason").map_err(record_error)?;
            let reason = match reason.as_str() {
                Some("reverted") => "its originating message was reverted",
                Some("task_closed") => "its subagent task closed",
                _ => return Err(Error::Rejected("invalid review withdrawal reason")),
            };
            insert_message(
                tx,
                event,
                &session_message::Info::System(session_message::System {
                    id,
                    metadata: None,
                    text: concat(
                        &concat(&"Review item ".into(), item.as_lossless()),
                        &format!(
                            " withdrawn: {reason}. Any unused approval from this item is invalid."
                        )
                        .into(),
                    ),
                    time: session_message::BaseTime { created: time },
                }),
            )
        }
        Some(
            "session.guardrail.approved"
            | "session.guardrail.decided"
            | "session.guardrail.dismissed"
            | "session.review.deferred"
            | "session.review.decided"
            | "session.review.consumed",
        ) => Ok(()),
        _ => Err(Error::Domain {
            kind: "unsupported_session_event",
            message: "Session projector does not own this event",
        }),
    }
}

pub(crate) fn clear_current_retry(tx: &mut Write<'_>, event: &Event) -> Result<(), Error> {
    if let Some(row) = current_assistant(tx, event)? {
        let session_message::Info::Assistant(mut assistant) = row.info()? else {
            return Ok(());
        };
        if assistant.retry.take().is_some() {
            update_message(tx, &row, &session_message::Info::Assistant(assistant))?;
        }
    }
    Ok(())
}

fn current_assistant(tx: &mut Write<'_>, event: &Event) -> Result<Option<Message>, Error> {
    let prefix = tuple_key(&[
        KeyPart::String(&event.aggregate_id),
        KeyPart::String(&"assistant".into()),
    ]);
    let row = tx
        .index_range::<MessageTable>(
            "session_message_session_type_seq_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Descending,
                after: None,
                limit: 1,
            },
        )?
        .into_iter()
        .next()
        .map(|row| row.record);
    row.map(|row| {
        Ok(matches!(row.info()?, session_message::Info::Assistant(ref assistant) if assistant.time.completed.is_none() || assistant.retry.is_some()).then_some(row))
    }).transpose().map(Option::flatten)
}

fn owned_assistant(
    tx: &mut Write<'_>,
    event: &Event,
    id: &session_message::Id,
) -> Result<Option<Message>, Error> {
    Ok(tx
        .get::<MessageTable>(&key(id.as_lossless()))?
        .filter(|row| {
            row.session_id == event.aggregate_id && row.type_.as_str() == Some("assistant")
        }))
}

pub(crate) fn update_message(
    tx: &mut Write<'_>,
    row: &Message,
    message: &session_message::Info,
) -> Result<(), Error> {
    let JsonValue::Object(value) = message.encode() else {
        return Err(Error::Rejected("message must encode an object"));
    };
    let mut data = JsonObject::new();
    for (key, value) in value
        .iter()
        .filter(|(key, _)| !matches!(key.as_str(), Some("id" | "type")))
    {
        data.insert(key.clone(), value.clone());
    }
    MessageTable::put(
        tx,
        &Message {
            data: JsonValue::Object(data),
            ..row.clone()
        },
    )
}

fn add_tokens(previous: i64, value: f64) -> Result<i64, Error> {
    if value.fract() != 0.0
        || !(-9_007_199_254_740_991.0..=9_007_199_254_740_991.0).contains(&value)
    {
        return Err(Error::Rejected(
            "Session Store token columns require safe integer counts",
        ));
    }
    previous
        .checked_add(value as i64)
        .ok_or(Error::Rejected("Session token count overflow"))
}

fn update_assistant(
    assistant: &mut session_message::Assistant,
    event: &session_event::Event,
) -> Result<(), Error> {
    use session_message::{AssistantContent, ToolState};
    let data = event.data.encode();
    let path = JsonPath::default();
    let object = ObjectDecoder::new(&data, &path).map_err(record_error)?;
    let time = event.created;
    match event.event_type.as_str() {
        Some("session.step.ended" | "session.step.failed") => {
            assistant.time.completed = Some(time);
            if event.event_type.as_str() == Some("session.step.failed") {
                assistant.finish = Some(ycoding_schema::llm::FinishReason::decode(&JsonValue::String("error".into())).map_err(record_error)?);
                assistant.error = object.optional("error").map_err(record_error)?;
                assistant.retry = None;
                let cost = object.optional("cost").map_err(record_error)?;
                let tokens = object.optional("tokens").map_err(record_error)?;
                if cost.is_some() && tokens.is_some() { assistant.cost = cost; assistant.tokens = tokens; }
            } else {
                assistant.finish = object.optional("finish").map_err(record_error)?;
                assistant.cost = object.optional("cost").map_err(record_error)?;
                assistant.tokens = object.optional("tokens").map_err(record_error)?;
            }
            let diagnostics = session_message::Diagnostics { context_limit: object.optional("contextLimit").map_err(record_error)?, context_breakdown: object.optional("contextBreakdown").map_err(record_error)?, provider_cache: object.optional("providerCache").map_err(record_error)? };
            assistant.diagnostics = (diagnostics.context_limit.is_some() || diagnostics.context_breakdown.is_some() || diagnostics.provider_cache.is_some()).then_some(diagnostics);
            let end = object.optional("snapshot").map_err(record_error)?;
            let files = object.optional("files").map_err(record_error)?;
            if end.is_some() || files.is_some() {
                let snapshot = assistant.snapshot.get_or_insert(session_message::SnapshotRange { start: None, end: None, files: None });
                snapshot.end = end; snapshot.files = files;
            }
        }
        Some("session.text.started") => assistant.content.push(AssistantContent::Text(session_message::AssistantText { text: "".into(), phase: object.optional("phase").map_err(record_error)? })),
        Some("session.text.delta" | "session.text.ended") => {
            if let Some(AssistantContent::Text(text)) = assistant.content.iter_mut().rev().find(|part| matches!(part, AssistantContent::Text(_))) {
                if event.event_type.as_str() == Some("session.text.delta") { text.text = concat(&text.text, &object.field("delta").map_err(record_error)?); }
                else { text.text = object.field("text").map_err(record_error)?; text.phase = object.optional("phase").map_err(record_error)?; }
            }
        }
        Some("session.reasoning.started") => assistant.content.push(AssistantContent::Reasoning(session_message::AssistantReasoning { text: "".into(), state: object.optional("state").map_err(record_error)?, time: Some(session_message::CompletedTime { created: time, completed: None }) })),
        Some("session.reasoning.delta" | "session.reasoning.ended") => {
            if let Some(AssistantContent::Reasoning(reasoning)) = assistant.content.iter_mut().rev().find(|part| matches!(part, AssistantContent::Reasoning(reasoning) if reasoning.time.as_ref().is_none_or(|time| time.completed.is_none()))) {
                if event.event_type.as_str() == Some("session.reasoning.delta") { reasoning.text = concat(&reasoning.text, &object.field("delta").map_err(record_error)?); }
                else {
                    reasoning.text = object.field("text").map_err(record_error)?;
                    reasoning.time = Some(session_message::CompletedTime { created: reasoning.time.as_ref().map_or(time, |time| time.created), completed: Some(time) });
                    if let Some(state) = object.optional("state").map_err(record_error)? { reasoning.state = Some(state); }
                }
            }
        }
        Some("session.retry.scheduled") => assistant.retry = Some(session_message::AssistantRetry { attempt: object.field("attempt").map_err(record_error)?, at: object.field("at").map_err(record_error)?, error: object.field("error").map_err(record_error)? }),
        Some("session.step.rerouted") => {
            let model: ycoding_schema::model::Ref = object.field("model").map_err(record_error)?;
            let from = std::mem::replace(&mut assistant.model, model.clone());
            assistant.reroutes.get_or_insert_with(Vec::new).push(session_message::AssistantReroute { from, model, error: object.field("error").map_err(record_error)? });
            assistant.content = Vec::new();
            assistant.retry = None;
        }
        Some("session.tool.input.started") => assistant.content.push(AssistantContent::Tool(Box::new(session_message::AssistantTool { id: object.field("callID").map_err(record_error)?, name: object.field("name").map_err(record_error)?, executed: None, provider_state: None, provider_result_state: None, state: ToolState::Streaming(session_message::ToolStateStreaming { input: "".into() }), time: session_message::ToolTime { created: time, ran: None, completed: None } }))),
        Some("session.tool.input.ended" | "session.tool.called" | "session.tool.progress" | "session.tool.success" | "session.tool.failed") => {
            let call_id: ycoding_schema::LosslessString = object.field("callID").map_err(record_error)?;
            if let Some(AssistantContent::Tool(tool)) = assistant.content.iter_mut().rev().find(|part| matches!(part, AssistantContent::Tool(tool) if tool.id == call_id)) {
                match event.event_type.as_str() {
                    Some("session.tool.input.ended") => { if let ToolState::Streaming(state) = &mut tool.state { state.input = object.field("text").map_err(record_error)?; } }
                    Some("session.tool.called") => {
                        tool.executed = object.optional("executed").map_err(record_error)?;
                        tool.provider_state = object.optional("state").map_err(record_error)?;
                        tool.time.ran = Some(time);
                        tool.state = ToolState::Running(session_message::ToolStateRunning { input: object.field("input").map_err(record_error)?, structured: JsonObject::new(), content: Vec::new() });
                    }
                    Some("session.tool.progress") => { if let ToolState::Running(state) = &mut tool.state { state.structured = object.field("structured").map_err(record_error)?; state.content = object.field("content").map_err(record_error)?; } }
                    Some("session.tool.success") => { if let ToolState::Running(state) = &tool.state {
                        tool.executed = Some(object.field::<bool>("executed").map_err(record_error)? || tool.executed == Some(true));
                        tool.provider_result_state = object.optional("resultState").map_err(record_error)?;
                        tool.time.completed = Some(time);
                        tool.state = ToolState::Completed(session_message::ToolStateCompleted { input: state.input.clone(), structured: object.field("structured").map_err(record_error)?, content: object.field("content").map_err(record_error)?, result: object.optional("result").map_err(record_error)? });
                    } }
                    Some("session.tool.failed") => {
                        let state = match &tool.state {
                            ToolState::Streaming(_) => Some((JsonObject::new(), JsonObject::new(), Vec::new())),
                            ToolState::Running(state) => Some((state.input.clone(), state.structured.clone(), state.content.clone())),
                            _ => None,
                        };
                        if let Some((input, structured, content)) = state {
                            tool.executed = Some(object.field::<bool>("executed").map_err(record_error)? || tool.executed == Some(true));
                            tool.provider_result_state = object.optional("resultState").map_err(record_error)?;
                            tool.time.completed = Some(time);
                            tool.state = ToolState::Error(session_message::ToolStateError { input, structured, content, error: object.field("error").map_err(record_error)?, result: object.optional("result").map_err(record_error)? });
                        }
                    }
                    _ => {}
                }
            }
        }
        Some("session.tool.input.delta") => {}
        _ => return Err(Error::Rejected("unsupported assistant update")),
    }
    Ok(())
}

fn concat(
    left: &ycoding_schema::LosslessString,
    right: &ycoding_schema::LosslessString,
) -> ycoding_schema::LosslessString {
    ycoding_schema::LosslessString::from_utf16(
        left.code_units().chain(right.code_units()).collect(),
    )
}
