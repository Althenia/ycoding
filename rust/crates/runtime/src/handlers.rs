use crate::{
    artifact, browser, convert, credential,
    dispatch::{Dispatcher, Failure, Invocation, RegistrationError},
    event_subscribe, form, guardrail, health, ids, isolated_browser, message, permission, project,
    provider_usage, question, session_autonomy, session_create, session_helpers, session_list,
    session_outstanding, session_read_models, session_revert, session_review, session_services,
    session_state, session_subagent, usage, usage_accounting,
};
use crate::{integration, mcp};
use ycoding_core::session::{pending, run_coordinator};
use ycoding_core::ycoding_schema::{
    DecodeError, DomainDecode, JsonValue, prompt, session, session_delivery, session_message,
    session_pending,
};
use ycoding_core::ycoding_store::Error;
use ycoding_protocol::{OPERATIONS, v5};

pub fn standard() -> Result<Dispatcher, RegistrationError> {
    let mut dispatcher = Dispatcher::new(OPERATIONS.clone());
    crate::remote_derived::register(&mut dispatcher)?;
    crate::session_ingress::register(&mut dispatcher)?;
    dispatcher.handle("pty.connectToken", crate::pty::connect_token)?;
    dispatcher.handle("pty.control", crate::pty::control)?;
    dispatcher.handle("pty.create", crate::pty::create)?;
    dispatcher.handle("pty.get", crate::pty::get)?;
    dispatcher.handle("pty.list", crate::pty::list)?;
    dispatcher.handle("pty.remove", crate::pty::remove)?;
    dispatcher.handle("pty.update", crate::pty::update)?;
    dispatcher.handle("shell.create", crate::shell::create)?;
    dispatcher.handle("shell.get", crate::shell::get)?;
    dispatcher.handle("shell.list", crate::shell::list)?;
    dispatcher.handle("shell.output", crate::shell::output)?;
    dispatcher.handle("shell.remove", crate::shell::remove)?;
    dispatcher.handle("shell.timeout", crate::shell::timeout)?;
    dispatcher.handle("vcs.branch", crate::vcs::branch)?;
    dispatcher.handle("vcs.diff", crate::vcs::diff)?;
    dispatcher.handle("vcs.status", crate::vcs::status)?;
    dispatcher.handle("projectCopy.create", crate::project_copy::create)?;
    dispatcher.handle("projectCopy.refresh", crate::project_copy::refresh)?;
    dispatcher.handle("projectCopy.remove", crate::project_copy::remove)?;
    dispatcher.handle("fs.find", crate::fs::find)?;
    dispatcher.handle("fs.list", crate::fs::list)?;
    crate::catalog_ops::register(&mut dispatcher)?;
    crate::config_ops::register(&mut dispatcher)?;
    crate::coordination::register(&mut dispatcher)?;
    crate::interaction::register(&mut dispatcher)?;
    dispatcher.handle("telemetry.append", crate::telemetry::append)?;
    dispatcher.handle("telemetry.list", crate::telemetry::list)?;
    dispatcher.handle("telemetry.consent.get", crate::telemetry::consent_get)?;
    dispatcher.handle("telemetry.consent.set", crate::telemetry::consent_set)?;
    dispatcher.handle("keepAwake.get", crate::keep_awake::get)?;
    dispatcher.handle("keepAwake.set", crate::keep_awake::set)?;
    artifact::register(&mut dispatcher)?;
    crate::connector::operations::register(&mut dispatcher)?;
    dispatcher.handle("decision.list", crate::decision::list)?;
    dispatcher.handle("dots.attach", crate::dots::attach)?;
    dispatcher.handle("dots.detach", crate::dots::detach)?;
    dispatcher.handle("dots.remove", crate::dots::remove)?;
    dispatcher.handle("dots.get", crate::dots::get)?;
    dispatcher.handle("dots.set", crate::dots::set)?;
    dispatcher.handle("dots.threads", crate::dots::threads)?;
    dispatcher.handle("dots.task.updates", crate::dots::task_updates)?;
    dispatcher.handle("dots.thread.read", crate::dots::thread_read)?;
    dispatcher.handle("dots.thread.send", crate::dots::thread_send)?;
    dispatcher.handle("dots.thread.interrupt", crate::dots::thread_interrupt)?;
    dispatcher.handle("dots.thread.requests", crate::dots::thread_requests)?;
    dispatcher.handle("dots.thread.respond", crate::dots::thread_respond)?;
    dispatcher.handle("dots.resume", crate::dots::resume)?;
    integration::register(&mut dispatcher)?;
    mcp::register(&mut dispatcher)?;
    dispatcher.handle("health.get", health_get)?;
    dispatcher.handle("health.stop", health::stop)?;
    dispatcher.handle("server.get", server)?;
    dispatcher.handle("usage.get", usage::get)?;
    dispatcher.handle("usage.report", usage::report)?;
    dispatcher.handle("usage.dashboard", crate::usage_dashboard::read)?;
    dispatcher.handle("providerUsage.get", provider_usage::get)?;
    dispatcher.handle("providerUsage.list", provider_usage::list)?;
    dispatcher.handle("providerUsage.forecast", provider_usage::forecast)?;
    dispatcher.handle("incident.report", crate::incident::report)?;
    dispatcher.handle("incident.recent", crate::incident::recent)?;
    dispatcher.handle("incident.guidance.get", crate::incident::guidance_get)?;
    dispatcher.handle("incident.guidance.clear", crate::incident::guidance_clear)?;
    dispatcher.handle("credential.update", credential::update)?;
    dispatcher.handle("credential.activate", credential::activate)?;
    dispatcher.handle("credential.remove", credential::remove)?;
    dispatcher.handle("credential.refresh", credential::refresh)?;
    dispatcher.handle("browser.status", browser::status)?;
    dispatcher.handle("browser.tabs", browser::tabs)?;
    dispatcher.handle("browser.start", browser::start)?;
    dispatcher.handle("browser.observe", browser::observe)?;
    dispatcher.handle("browser.action", browser::action)?;
    dispatcher.handle("browser.control", browser::control)?;
    dispatcher.handle("browser.open", browser::open)?;
    dispatcher.handle("browser.close", browser::close)?;
    dispatcher.handle("browser.release", browser::release)?;
    dispatcher.handle("browser.stop", browser::stop)?;
    dispatcher.handle("browser.forget", browser::forget)?;
    dispatcher.handle("isolatedBrowser.status", isolated_browser::status)?;
    dispatcher.handle("isolatedBrowser.tabs", isolated_browser::tabs)?;
    dispatcher.handle("isolatedBrowser.start", isolated_browser::start)?;
    dispatcher.handle("isolatedBrowser.observe", isolated_browser::observe)?;
    dispatcher.handle("isolatedBrowser.action", isolated_browser::action)?;
    dispatcher.handle("isolatedBrowser.control", isolated_browser::control)?;
    dispatcher.handle("isolatedBrowser.stop", isolated_browser::stop)?;
    dispatcher.handle("project.current", project::current)?;
    dispatcher.handle("project.directories", project::directories)?;
    dispatcher.handle("project.forget", project::forget)?;
    dispatcher.handle("project.inventory", project::inventory)?;
    dispatcher.handle("project.list", project::list)?;
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
    dispatcher.handle("session.review.list", session_review::list)?;
    dispatcher.handle("session.review.decide", session_review::decide)?;
    dispatcher.handle("session.diagnostics", session_state::diagnostics)?;
    dispatcher.handle("session.usage", session_read_models::usage)?;
    dispatcher.handle("session.usageReport", session_read_models::usage_report)?;
    dispatcher.handle("session.promptCosts", usage_accounting::prompt_costs)?;
    dispatcher.handle("session.taskCosts", usage_accounting::task_costs)?;
    dispatcher.handle("session.completions", session_services::completions)?;
    dispatcher.handle("session.context", session_services::context)?;
    dispatcher.handle("session.fork", session_services::fork)?;
    dispatcher.handle("session.synthetic", session_services::synthetic)?;
    dispatcher.handle("session.daybreak.set", session_services::daybreak_set)?;
    dispatcher.handle(
        "session.fileChange.list",
        session_services::file_change_list,
    )?;
    dispatcher.handle("session.background", session_services::background)?;
    dispatcher.handle(
        "session.instructions.entry.list",
        session_services::instruction_entry_list,
    )?;
    dispatcher.handle(
        "session.instructions.entry.put",
        session_services::instruction_entry_put,
    )?;
    dispatcher.handle(
        "session.instructions.entry.remove",
        session_services::instruction_entry_remove,
    )?;
    dispatcher.handle("session.wait", session_services::wait)?;
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
    dispatcher.handle("session.deleteMessage", session_delete_message)?;
    dispatcher.handle("session.pending.list", session_pending_list)?;
    dispatcher.handle("session.pending.remove", session_pending_remove)?;
    dispatcher.handle("session.pending.steer", session_pending_steer)?;
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
    dispatcher.handle("session.permission.reject", permission::reject)?;
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
    dispatcher.handle("session.guardrail.request.cancel", guardrail::cancel)?;
    dispatcher.handle("session.guardrail.request.retry", guardrail::retry)?;
    dispatcher.handle_asset("fs.read", crate::fs::read)?;
    dispatcher.handle_asset("session.attachment.read", crate::session_attachment::read)?;
    dispatcher.handle("location.get", crate::location_ops::get)?;
    dispatcher.handle("debug.location", crate::location_ops::list)?;
    dispatcher.handle("debug.location.evict", crate::location_ops::evict)?;
    Ok(dispatcher)
}

async fn health_get(
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
    let delivery = match payload.delivery {
        Some(delivery) if delivery == v5::SessionPromptRequestPayloadDelivery::Queue as i32 => {
            "queue"
        }
        _ => "steer",
    };
    let event_id =
        ids::event_id().map_err(|_| Failure::Unavailable("event ID generation failed".into()))?;
    let id = match payload.id {
        Some(id) => session_message::Id::decode(&JsonValue::String(convert::domain(&id)?))
            .map_err(|_| Failure::Invalid("invalid input ID".into()))?,
        None => session_message::Id::from_event(&event_id),
    };
    // A reused input ID returns the admitted record without resolving its attachments again.
    let admitted_before = core
        .sessions
        .pending(&id)
        .map_err(|error| store_failure(error, &session_id))?
        .is_some()
        || core
            .sessions
            .message(&id)
            .map_err(|error| store_failure(error, &session_id))?
            .is_some();
    let (files, paths) = match payload.files {
        Some(files) if !admitted_before && !files.items.is_empty() => {
            let materialized =
                crate::prompt_attachments::materialize(&invocation, &session_id, &files.items)
                    .await?;
            (Some(materialized.files), materialized.paths)
        }
        files => (files.map(|_| Vec::new()), Vec::new()),
    };
    let data = session_pending::UserData {
        text: convert::domain(&payload.text)?,
        files,
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
    let admitted = core
        .execution
        .prompt_with_paths(
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
            paths,
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
            &core.generation,
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
            generation_speed: snapshot
                .generation_speed
                .as_ref()
                .map(convert::generation_speed)
                .transpose()
                .map_err(unrepresentable_info)?,
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

async fn session_delete_message(
    invocation: Invocation,
    request: v5::SessionDeleteMessageRequest,
) -> Result<v5::SessionDeleteMessageResult, Failure> {
    let core = invocation.core()?;
    let session = invocation.session(&request.params.session_id)?;
    let message: session_message::Id = convert::identifier(&request.params.message_id)?;
    core.sessions
        .delete_message(&session, &message, ids::now_millis())
        .await
        .map_err(|error| {
            use v5::MessageDeleteRefusedErrorReason as Reason;
            let (reason, diagnostic) = match error {
                Error::Domain {
                    kind: "message_not_found",
                    message,
                } => (None, message),
                Error::Domain {
                    kind: "message_read",
                    message,
                } => (Some(Reason::MessagedeleterefusederrorReasonRead), message),
                Error::Domain {
                    kind: "message_not_owned",
                    message,
                } => (
                    Some(Reason::MessagedeleterefusederrorReasonNotOwned),
                    message,
                ),
                error => return store_failure(error, &session),
            };
            Failure::MessageDelete {
                session: session.as_lossless().clone(),
                message: message.as_lossless().clone(),
                reason,
                diagnostic,
            }
        })?;
    Ok(v5::SessionDeleteMessageResult { data: v5::Empty {} })
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

async fn control_pending(
    invocation: &Invocation,
    session_id: &v5::LosslessString,
    message_id: &v5::LosslessString,
    control: ycoding_core::session::pending::Control,
) -> Result<(), Failure> {
    let core = invocation.core()?;
    let session = invocation.session(session_id)?;
    let message = convert::identifier(message_id)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| Failure::Unavailable("System clock predates the Unix epoch".into()))?
        .as_millis() as i64;
    let changed = core
        .sessions
        .control_pending(&session, &message, control, now)
        .await
        .map_err(|error| match error {
            ycoding_core::ycoding_store::Error::Domain {
                kind: "pending_input_not_found",
                ..
            } => Failure::PendingInputNotFound {
                session: session.as_lossless().clone(),
                message: message.as_lossless().clone(),
            },
            ycoding_core::ycoding_store::Error::Domain {
                kind: "pending_input_invalid",
                ..
            } => Failure::PendingInputInvalid(message.as_lossless().clone()),
            error => store_failure(error, &session),
        })?;
    if changed && control == ycoding_core::session::pending::Control::Steer {
        core.execution
            .wake(&session)
            .map_err(|error| Failure::Unavailable(error.to_string()))?;
    }
    Ok(())
}
async fn session_pending_remove(
    invocation: Invocation,
    request: v5::SessionPendingRemoveRequest,
) -> Result<v5::SessionPendingRemoveResult, Failure> {
    control_pending(
        &invocation,
        &request.params.session_id,
        &request.params.message_id,
        ycoding_core::session::pending::Control::Remove,
    )
    .await?;
    Ok(v5::SessionPendingRemoveResult { data: v5::Empty {} })
}
async fn session_pending_steer(
    invocation: Invocation,
    request: v5::SessionPendingSteerRequest,
) -> Result<v5::SessionPendingSteerResult, Failure> {
    control_pending(
        &invocation,
        &request.params.session_id,
        &request.params.message_id,
        ycoding_core::session::pending::Control::Steer,
    )
    .await?;
    Ok(v5::SessionPendingSteerResult { data: v5::Empty {} })
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
        subscription_id: convert::text(&format!(
            "{}_{}",
            invocation.connection_id,
            ids::subscription_id()
        )),
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
        .end(&invocation.connection_id, &request.subscription_id)
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
    core.coordination
        .pause_master(&id)
        .map_err(|_| Failure::Unavailable("Project pause unavailable".into()))?;
    core.execution
        .interrupt(&id)
        .await
        .map_err(|error| match error {
            run_coordinator::Error::Runner(error) if error.r#type.as_str() == Some("not_found") => {
                Failure::SessionNotFound(name(&id))
            }
            _ => Failure::Unavailable("Session interruption unavailable".into()),
        })?;
    Ok(v5::SessionInterruptResult { data: v5::Empty {} })
}

async fn session_remove(
    invocation: Invocation,
    request: v5::SessionRemoveRequest,
) -> Result<v5::SessionRemoveResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let removed = remove_subtree(core, &id, std::collections::BTreeSet::new()).await?;
    if removed.is_empty() {
        return Err(Failure::SessionNotFound(name(&id)));
    }
    Ok(v5::SessionRemoveResult { data: v5::Empty {} })
}

fn remove_subtree<'a>(
    core: &'a crate::services::Core,
    root: &'a session::Id,
    mut stopped: std::collections::BTreeSet<session::Id>,
) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<Vec<session::Id>, Failure>> + Send + 'a>,
> {
    Box::pin(async move {
        let family = removal_family(core.locations.client(), root)?;
        let next = family.into_iter().find(|member| !stopped.contains(member));
        let Some(member) = next else {
            return core
                .sessions
                .remove(root)
                .await
                .map_err(|error| store_failure(error, root));
        };
        core.execution
            .with_transition(&member, async {
                core.execution
                    .request_interrupt(&member)
                    .map_err(|_| Failure::Unavailable("Session interruption unavailable".into()))?;
                core.execution.await_idle(&member).await;
                core.locations.cancel_session(&member).await?;
                stopped.insert(member.clone());
                remove_subtree(core, root, stopped).await
            })
            .await
            .map_err(|_| Failure::Unavailable("Session removal transition unavailable".into()))?
    })
}

pub(crate) fn removal_family(
    client: &ycoding_core::ycoding_store::Client,
    root: &session::Id,
) -> Result<Vec<session::Id>, Failure> {
    use std::ops::Bound;
    use ycoding_core::ycoding_store::{
        IndexOrder, IndexQuery, KeyPart, session::SessionTable, tuple_key,
    };
    let snapshot = client
        .snapshot()
        .map_err(|error| store_failure(error, root))?;
    let mut family = vec![root.clone()];
    let mut seen = std::collections::BTreeSet::from([root.clone()]);
    let mut index = 0;
    while index < family.len() {
        let prefix = tuple_key(&[KeyPart::String(family[index].as_lossless())]);
        let mut after = None;
        loop {
            let page = snapshot
                .index_range::<SessionTable>(
                    "session_parent_idx",
                    IndexQuery {
                        lower: Bound::Unbounded,
                        upper: Bound::Unbounded,
                        prefix: Some(&prefix),
                        order: IndexOrder::Ascending,
                        after: after.as_ref(),
                        limit: 128,
                    },
                )
                .map_err(|error| store_failure(error, root))?;
            if page.is_empty() {
                break;
            }
            after = page.last().map(|entry| entry.cursor.clone());
            for entry in page {
                let member = session::Id::new(entry.record.id)
                    .map_err(|_| Failure::Unavailable("Invalid descendant Session".into()))?;
                if seen.insert(member.clone()) {
                    family.push(member);
                }
            }
        }
        index += 1;
    }
    Ok(family)
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
