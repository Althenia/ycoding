use crate::{
    convert,
    dispatch::{Dispatcher, Failure, Invocation, RegistrationError},
    event_subscribe, form, guardrail, ids, message, permission, question, session_autonomy,
    session_create, session_helpers, session_list, session_outstanding, session_read_models,
    session_revert, session_state, session_subagent,
};
use ycoding_core::session::{pending, run_coordinator};
use ycoding_core::ycoding_schema::{
    DecodeError, DomainDecode, JsonValue, prompt, session, session_delivery, session_message,
    session_pending,
};
use ycoding_core::ycoding_store::Error;
use ycoding_protocol::{OPERATIONS, v5};

pub fn standard() -> Result<Dispatcher, RegistrationError> {
    let mut dispatcher = Dispatcher::new(OPERATIONS.clone());
    dispatcher.handle("health.get", health)?;
    dispatcher.handle("server.get", server)?;
    dispatcher.handle("session.create", session_create::create)?;
    dispatcher.handle("session.get", session_get)?;
    dispatcher.handle("session.list", session_list::list)?;
    dispatcher.handle("session.archive", session_state::archive)?;
    dispatcher.handle("session.unarchive", session_state::unarchive)?;
    dispatcher.handle("session.pin", session_state::pin)?;
    dispatcher.handle("session.unpin", session_state::unpin)?;
    dispatcher.handle("session.rename", session_state::rename)?;
    dispatcher.handle("session.active", session_state::active)?;
    dispatcher.handle("session.todo.list", session_state::todo_list)?;
    dispatcher.handle("session.todo.update", session_state::todo_update)?;
    dispatcher.handle("session.outstanding", session_outstanding::read)?;
    dispatcher.handle("session.diagnostics", session_state::diagnostics)?;
    dispatcher.handle("session.usage", session_read_models::usage)?;
    dispatcher.handle("session.usageReport", session_read_models::usage_report)?;
    dispatcher.handle(
        "session.capturedInputs",
        session_read_models::captured_inputs,
    )?;
    dispatcher.handle(
        "session.compaction.list",
        session_read_models::compaction_list,
    )?;
    dispatcher.handle("session.revert.commit", session_state::revert_commit)?;
    dispatcher.handle("session.revert.stage", session_revert::stage)?;
    dispatcher.handle("session.revert.clear", session_revert::clear)?;
    dispatcher.handle("session.prompt", session_prompt)?;
    dispatcher.handle("session.prediction", session_helpers::prediction)?;
    dispatcher.handle("session.promptGenerate", session_helpers::prompt_generate)?;
    dispatcher.handle("session.snapshot", session_snapshot)?;
    dispatcher.handle("session.messages", session_messages)?;
    dispatcher.handle("session.message", session_message)?;
    dispatcher.handle("session.pending.list", session_pending_list)?;
    dispatcher.handle("session.log", session_log)?;
    dispatcher.handle("event.subscribe", event_subscribe::subscribe)?;
    dispatcher.handle("event.unsubscribe", event_unsubscribe)?;
    dispatcher.handle("session.interrupt", session_interrupt)?;
    dispatcher.handle("session.remove", session_remove)?;
    dispatcher.handle("session.autonomy.get", session_autonomy::get)?;
    dispatcher.handle("session.autonomy.set", session_autonomy::set)?;
    dispatcher.handle("session.subagent.list", session_subagent::list)?;
    dispatcher.handle("session.subagent.message", session_subagent::message)?;
    dispatcher.handle("session.subagent.answer", session_subagent::answer)?;
    dispatcher.handle("session.subagent.cancel", session_subagent::cancel)?;
    dispatcher.handle("session.subagent.resume", session_subagent::resume)?;
    dispatcher.handle("session.permission.create", permission::create)?;
    dispatcher.handle("session.permission.list", permission::list)?;
    dispatcher.handle("session.permission.get", permission::get)?;
    dispatcher.handle("session.permission.reply", permission::reply)?;
    dispatcher.handle("permission.request.list", permission::request_list)?;
    dispatcher.handle("permission.saved.list", permission::saved_list)?;
    dispatcher.handle("permission.saved.remove", permission::saved_remove)?;
    dispatcher.handle("session.question.list", question::list)?;
    dispatcher.handle("session.question.reply", question::reply)?;
    dispatcher.handle("session.question.reject", question::reject)?;
    dispatcher.handle("question.request.list", question::request_list)?;
    dispatcher.handle("session.form.create", form::create)?;
    dispatcher.handle("session.form.list", form::list)?;
    dispatcher.handle("session.form.get", form::get)?;
    dispatcher.handle("session.form.state", form::state)?;
    dispatcher.handle("session.form.reply", form::reply)?;
    dispatcher.handle("session.form.cancel", form::cancel)?;
    dispatcher.handle("form.request.list", form::request_list)?;
    dispatcher.handle("session.guardrail.status", guardrail::status)?;
    dispatcher.handle("session.guardrail.request.list", guardrail::request_list)?;
    dispatcher.handle("session.guardrail.request.reply", guardrail::reply)?;
    Ok(dispatcher)
}

async fn health(
    invocation: Invocation,
    _request: v5::HealthGetRequest,
) -> Result<v5::HealthGetResult, Failure> {
    let services = &invocation.environment.services;
    Ok(v5::HealthGetResult {
        data: v5::ServiceHealth {
            healthy: true,
            version: convert::text(&services.identity.version),
            pid: services.identity.pid,
            source_epoch: convert::text(&services.identity.source_epoch),
        },
    })
}

async fn server(
    invocation: Invocation,
    _request: v5::ServerGetRequest,
) -> Result<v5::ServerGetResult, Failure> {
    Ok(v5::ServerGetResult {
        urls: v5::ServerGetResultUrls {
            items: invocation
                .environment
                .urls
                .iter()
                .map(|url| convert::text(url))
                .collect(),
        },
    })
}

async fn session_get(
    invocation: Invocation,
    request: v5::SessionGetRequest,
) -> Result<v5::SessionGetResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let info = core
        .sessions
        .get(&id)
        .map_err(|_| Failure::Unavailable("Session store unavailable".into()))?
        .ok_or_else(|| Failure::SessionNotFound(String::from_utf16_lossy(&units(&id))))?;
    Ok(v5::SessionGetResult {
        data: convert::session_info(&info)
            .map_err(|_| Failure::Unavailable("stored Session is not representable".into()))?,
    })
}

async fn session_prompt(
    invocation: Invocation,
    request: v5::SessionPromptRequest,
) -> Result<v5::SessionPromptResult, Failure> {
    let core = invocation.core()?;
    let session_id = invocation.session(&request.params.session_id)?;
    let payload = request.payload;
    if payload
        .files
        .as_ref()
        .is_some_and(|files| !files.items.is_empty())
    {
        return Err(Failure::Unavailable(
            "file attachment resolution is not wired to the local bridge".into(),
        ));
    }
    let delivery = match payload.delivery {
        Some(delivery) if delivery == v5::SessionPromptRequestPayloadDelivery::Queue as i32 => {
            "queue"
        }
        _ => "steer",
    };
    let data = session_pending::UserData {
        text: convert::domain(&payload.text)?,
        files: payload.files.map(|_| Vec::new()),
        agents: payload
            .agents
            .map(|agents| {
                agents
                    .items
                    .iter()
                    .map(convert::agent_domain)
                    .collect::<Result<Vec<prompt::AgentAttachment>, _>>()
            })
            .transpose()?,
        metadata: payload
            .metadata
            .map(|metadata| convert::metadata_domain(&metadata.entries))
            .transpose()?,
    };
    let event_id =
        ids::event_id().map_err(|_| Failure::Unavailable("event ID generation failed".into()))?;
    let id = match payload.id {
        Some(id) => session_message::Id::decode(&JsonValue::String(convert::domain(&id)?))
            .map_err(|_| Failure::Invalid("invalid input ID".into()))?,
        None => session_message::Id::from_event(&event_id),
    };
    let admitted = core
        .execution
        .prompt(
            pending::Request {
                id,
                session_id,
                input: session_pending::Message::User(session_pending::UserMessage {
                    data,
                    delivery: session_delivery::Delivery::decode(&JsonValue::String(
                        delivery.into(),
                    ))
                    .map_err(|_| Failure::Invalid("invalid delivery".into()))?,
                }),
                event_id,
                created: ids::now_millis(),
            },
            payload.resume,
        )
        .await
        .map_err(prompt_failure)?;
    Ok(v5::SessionPromptResult {
        data: message::pending_user(&admitted)
            .map_err(|_| Failure::Unavailable("admitted input is not representable".into()))?,
    })
}

const SNAPSHOT_WINDOW: u64 = 100;

async fn session_snapshot(
    invocation: Invocation,
    request: v5::SessionSnapshotRequest,
) -> Result<v5::SessionSnapshotResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    if request.query.before.is_some() && request.query.limit.is_none() {
        return Err(Failure::InvalidCursor(
            "A snapshot cursor requires a window limit".into(),
        ));
    }
    let before = request
        .query
        .before
        .as_ref()
        .map(|cursor| {
            convert::domain(cursor)?
                .to_utf8()
                .map_err(|_| Failure::InvalidCursor("invalid Session history cursor".into()))
        })
        .transpose()?;
    let snapshot = core
        .sessions
        .snapshot(
            &id,
            request.query.limit.unwrap_or(SNAPSHOT_WINDOW) as usize,
            before.as_deref(),
        )
        .map_err(|error| store_failure(error, &id))?;
    Ok(v5::SessionSnapshotResult {
        data: v5::SessionProjection {
            source_epoch: convert::text(&invocation.environment.services.identity.source_epoch),
            session: convert::session_info(&snapshot.session).map_err(unrepresentable_info)?,
            messages: v5::SessionProjectionMessages {
                items: messages(&snapshot.messages)?,
            },
            watermark: v5::EventLogSynced {
                r#type: 1,
                aggregate_id: convert::wire(id.as_lossless()),
                seq: snapshot.watermark.map(|watermark| watermark as u64),
            },
            generation_speed: None,
            before: snapshot.before.as_deref().map(convert::text),
        },
    })
}

async fn session_messages(
    invocation: Invocation,
    request: v5::SessionMessagesRequest,
) -> Result<v5::SessionMessagesResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let transcript = core
        .sessions
        .transcript(&id)
        .map_err(|error| store_failure(error, &id))?;
    Ok(v5::SessionMessagesResult {
        data: v5::SessionMessagesResponse {
            data: v5::SessionMessagesResponseData {
                items: messages(&transcript)?,
            },
        },
    })
}

async fn session_message(
    invocation: Invocation,
    request: v5::SessionMessageRequest,
) -> Result<v5::SessionMessageResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let message_id = session_message::Id::decode(&JsonValue::String(convert::domain(
        &request.params.message_id,
    )?))
    .map_err(|_| Failure::Invalid("invalid message ID".into()))?;
    let found = core
        .sessions
        .message(&message_id)
        .map_err(|error| store_failure(error, &id))?;
    let Some((owner, info)) = found.filter(|(owner, _)| owner.as_lossless() == id.as_lossless())
    else {
        return Err(Failure::MessageNotFound {
            session: name(&id),
            message: String::from_utf16_lossy(
                &message_id.as_lossless().code_units().collect::<Vec<_>>(),
            ),
        });
    };
    let _ = owner;
    Ok(v5::SessionMessageResult {
        data: message::message(&info).map_err(unrepresentable)?,
    })
}

async fn session_pending_list(
    invocation: Invocation,
    request: v5::SessionPendingListRequest,
) -> Result<v5::SessionPendingListResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let records = core
        .sessions
        .pending_list(&id)
        .map_err(|error| store_failure(error, &id))?;
    Ok(v5::SessionPendingListResult {
        data: v5::SessionPendingListResultData {
            items: records
                .iter()
                .map(message::pending)
                .collect::<Result<_, _>>()
                .map_err(unrepresentable)?,
        },
    })
}

async fn session_log(
    invocation: Invocation,
    request: v5::SessionLogRequest,
) -> Result<v5::SessionLogResult, Failure> {
    const MAX_SAFE: u64 = 9_007_199_254_740_991;
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let after = request
        .query
        .after
        .map(|after| {
            (after <= MAX_SAFE)
                .then_some(after as i64)
                .ok_or_else(|| Failure::Invalid("invalid session log cursor".into()))
        })
        .transpose()?;
    core.sessions
        .log(&id, after, 1)
        .map_err(|error| store_failure(error, &id))?;
    Ok(v5::SessionLogResult {
        subscription_id: convert::text(&ids::subscription_id()),
    })
}

async fn event_unsubscribe(
    invocation: Invocation,
    request: v5::EventUnsubscribeRequest,
) -> Result<v5::EventUnsubscribeResult, Failure> {
    if request.subscription_id.is_empty() {
        return Err(Failure::Invalid("invalid subscription".into()));
    }
    if !invocation
        .environment
        .subscriptions
        .end(&request.subscription_id)
    {
        return Err(Failure::Invalid("unknown subscription".into()));
    }
    Ok(v5::EventUnsubscribeResult { data: v5::Empty {} })
}

async fn session_interrupt(
    invocation: Invocation,
    request: v5::SessionInterruptRequest,
) -> Result<v5::SessionInterruptResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let _ = core.execution.interrupt(&id).await;
    Ok(v5::SessionInterruptResult { data: v5::Empty {} })
}

async fn session_remove(
    invocation: Invocation,
    request: v5::SessionRemoveRequest,
) -> Result<v5::SessionRemoveResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let removed = core
        .sessions
        .remove(&id)
        .await
        .map_err(|error| store_failure(error, &id))?;
    if removed.is_empty() {
        return Err(Failure::SessionNotFound(name(&id)));
    }
    Ok(v5::SessionRemoveResult { data: v5::Empty {} })
}

fn messages(infos: &[session_message::Info]) -> Result<Vec<v5::SessionMessageInfo>, Failure> {
    infos
        .iter()
        .map(message::message)
        .collect::<Result<_, _>>()
        .map_err(unrepresentable)
}

fn unrepresentable(error: message::Unrepresentable) -> Failure {
    Failure::Unavailable(format!(
        "stored message is not representable on the wire: {}",
        error.0
    ))
}

fn unrepresentable_info(_: DecodeError) -> Failure {
    Failure::Unavailable("stored Session is not representable on the wire".into())
}

fn name(id: &session::Id) -> String {
    String::from_utf16_lossy(&units(id))
}

fn store_failure(error: Error, id: &session::Id) -> Failure {
    match error {
        Error::Domain {
            kind: "not_found", ..
        } => Failure::SessionNotFound(name(id)),
        Error::Domain {
            kind: "invalid_cursor",
            message,
        } => Failure::InvalidCursor(message.into()),
        _ => Failure::Unavailable("Session store unavailable".into()),
    }
}

fn prompt_failure(error: run_coordinator::Error) -> Failure {
    match error {
        run_coordinator::Error::Store(store) => match store.as_ref() {
            Error::Domain {
                kind: "input_identity",
                message,
            } => Failure::Conflict((*message).into()),
            _ => Failure::Unavailable("Session store unavailable".into()),
        },
        _ => Failure::Unavailable("Session execution unavailable".into()),
    }
}

fn units(id: &session::Id) -> Vec<u16> {
    id.as_lossless().code_units().collect()
}
