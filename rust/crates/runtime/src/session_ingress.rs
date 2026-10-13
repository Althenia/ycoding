use crate::{
    convert,
    dispatch::{Dispatcher, Failure, Invocation, RegistrationError},
    ids, message,
    services::SessionServices,
};
use ycoding_core::{
    session::{
        compaction_execution, model_switch, orchestration, pending,
        runner::{CommandInput, IngressError, ShellInput},
    },
    tools::code_mode::Cancellation,
    ycoding_schema::{
        DomainDecode, JsonValue, LosslessString, ObjectEncoder, location, model, session,
        session_compaction, session_delivery, session_message, session_pending,
        session_skill_status,
    },
    ycoding_store::session::Job,
};
use ycoding_protocol::v5;

pub fn register(dispatcher: &mut Dispatcher) -> Result<(), RegistrationError> {
    dispatcher.handle("session.command", command)?;
    dispatcher.handle("session.shell", shell)?;
    dispatcher.handle("session.skill", skill)?;
    dispatcher.handle("session.skills", skills)?;
    dispatcher.handle("session.resolveSkillConflict", resolve_skill_conflict)?;
    dispatcher.handle("session.compact", compact)?;
    dispatcher.handle("session.generate", generate)?;
    dispatcher.handle("session.move", move_session)?;
    dispatcher.handle("session.switchAgent", switch_agent)?;
    dispatcher.handle("session.switchModel", switch_model)?;
    dispatcher.handle("session.subagent.launch", launch)?;
    Ok(())
}

fn services(
    invocation: &Invocation,
    id: &session::Id,
) -> Result<
    (
        std::sync::Arc<crate::LocationServices>,
        crate::CatalogServices,
        SessionServices,
    ),
    Failure,
> {
    let core = invocation.core()?;
    let (_, location) = core.locations.session(id)?;
    let (catalogs, services) = core.session_services(&location)?;
    Ok((location, catalogs, services))
}

pub(crate) fn model_ref(value: &v5::ModelRef) -> Result<model::Ref, Failure> {
    model::Ref::decode(
        &ObjectEncoder::new()
            .field("providerID", &convert::domain(&value.provider_id)?)
            .field("id", &convert::domain(&value.id)?)
            .optional(
                "variant",
                &value.variant.as_ref().map(convert::domain).transpose()?,
            )
            .optional(
                "profile",
                &value.profile.as_ref().map(convert::domain).transpose()?,
            )
            .finish(),
    )
    .map_err(|error| Failure::Invalid(error.to_string()))
}

fn failure(error: IngressError) -> Failure {
    match error {
        IngressError::CommandNotFound(name) => Failure::CommandNotFound(name),
        IngressError::CommandEvaluation { command, message } => {
            Failure::CommandEvaluation { command, message }
        }
        IngressError::SkillNotFound(id) => Failure::SkillNotFound(id),
        IngressError::SkillConflictNotFound => Failure::SkillConflictNotFound,
        IngressError::Compaction(error) => Failure::Conflict(error.to_string()),
        IngressError::Invalid(message) => Failure::Invalid(message),
        IngressError::Io(error) if error.kind() == std::io::ErrorKind::Unsupported => {
            Failure::ServiceUnavailable {
                service: if error.to_string().contains("memory") {
                    "shell-memory"
                } else {
                    "shell-sandbox"
                },
                message: error.to_string(),
            }
        }
        IngressError::Io(error) => Failure::Invalid(error.to_string()),
        IngressError::Guardrail(error) => error
            .capacity_message()
            .map(|message| Failure::ServiceUnavailable {
                service: "guardrail",
                message,
            })
            .unwrap_or_else(|| Failure::Invalid(format!("Session guardrail: {error:?}"))),
        IngressError::Execution(ycoding_core::session::run_coordinator::Error::Store(error))
            if matches!(
                error.as_ref(),
                ycoding_core::ycoding_store::Error::Domain {
                    kind: "input_identity",
                    ..
                }
            ) =>
        {
            Failure::Conflict(error.to_string())
        }
        IngressError::Execution(error) => Failure::Unavailable(error.to_string()),
    }
}

async fn command(
    invocation: Invocation,
    request: v5::SessionCommandRequest,
) -> Result<v5::SessionCommandResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let (location, catalogs, services) = services(&invocation, &id)?;
    let payload = request.payload;
    let command = convert::domain(&payload.command)?;
    let platform = core.platform.as_ref().ok_or_else(|| {
        Failure::Unavailable("Location platform services are not composed".into())
    })?(services.runner.location())
    .map_err(Failure::Unavailable)?;
    if platform.shell.directory()
        != std::path::Path::new(convert::readable(location.info.directory.as_lossless()).as_str())
    {
        return Err(Failure::Unavailable(
            "Location Shell owner disagrees".into(),
        ));
    }
    let event_id = ids::event_id().map_err(|error| Failure::Unavailable(error.to_string()))?;
    let mcp = core
        .mcp
        .as_ref()
        .filter(|_| catalogs.commands.get(&command).is_none())
        .map(|resolver| resolver(&location.info))
        .transpose()
        .map_err(Failure::Unavailable)?;
    let message_id = payload
        .id
        .as_ref()
        .map(convert::identifier)
        .transpose()?
        .unwrap_or_else(|| session_message::Id::from_event(&event_id));
    let delivery = match payload.delivery {
        Some(2) => "queue",
        _ => "steer",
    };
    // A reused command ID returns the admitted record without resolving attachments again.
    let admitted_before = core
        .sessions
        .pending(&message_id)
        .map_err(|_| Failure::Unavailable("Session store unavailable".into()))?
        .is_some()
        || core
            .sessions
            .message(&message_id)
            .map_err(|_| Failure::Unavailable("Session store unavailable".into()))?
            .is_some();
    let files = match payload.files {
        Some(files) if !admitted_before && !files.items.is_empty() => {
            Some(crate::prompt_attachments::materialize(&invocation, &id, &files.items).await?)
        }
        files => files.map(|_| Vec::new()),
    };
    let admitted = services
        .runner
        .command(
            core.execution,
            &catalogs.commands,
            mcp.as_deref(),
            &platform.config,
            CommandInput {
                request: pending::Request {
                    id: message_id,
                    session_id: id,
                    event_id,
                    created: ids::now_millis(),
                    input: session_pending::Message::User(session_pending::UserMessage {
                        data: session_pending::UserData {
                            text: "".into(),
                            files,
                            agents: payload
                                .agents
                                .map(|agents| {
                                    agents.items.iter().map(convert::agent_domain).collect()
                                })
                                .transpose()?,
                            metadata: None,
                        },
                        delivery: session_delivery::Delivery::decode(&JsonValue::String(
                            delivery.into(),
                        ))
                        .map_err(|error| Failure::Invalid(error.to_string()))?,
                    }),
                },
                name: &command,
                arguments: &payload
                    .arguments
                    .as_ref()
                    .map(convert::domain)
                    .transpose()?
                    .unwrap_or_default(),
                agent: payload.agent.as_ref().map(convert::domain).transpose()?,
                model: payload.model.as_ref().map(model_ref).transpose()?,
                resume: payload.resume,
            },
        )
        .await
        .map_err(failure)?;
    Ok(v5::SessionCommandResult {
        data: message::pending_user(&admitted)
            .map_err(|_| Failure::Unavailable("Admitted command is not representable".into()))?,
    })
}

async fn shell(
    invocation: Invocation,
    request: v5::SessionShellRequest,
) -> Result<v5::SessionShellResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let (location, _, services) = services(&invocation, &id)?;
    let platform = core.platform.as_ref().ok_or_else(|| {
        Failure::Unavailable("Location platform services are not composed".into())
    })?(services.runner.location())
    .map_err(Failure::Unavailable)?;
    if platform.shell.directory()
        != std::path::Path::new(convert::readable(location.info.directory.as_lossless()).as_str())
    {
        return Err(Failure::Unavailable(
            "Location Shell owner disagrees".into(),
        ));
    }
    services
        .runner
        .shell(
            core.execution.coordinator(),
            ShellInput {
                session: &id,
                id: request
                    .payload
                    .id
                    .as_ref()
                    .map(convert::identifier)
                    .transpose()?,
                command: convert::domain(&request.payload.command)?,
                shell: &platform.shell,
                config: &platform.config,
            },
        )
        .await
        .map_err(failure)?;
    Ok(v5::SessionShellResult { data: v5::Empty {} })
}

async fn skill(
    invocation: Invocation,
    request: v5::SessionSkillRequest,
) -> Result<v5::SessionSkillResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let (_location, _, services) = services(&invocation, &id)?;
    services
        .runner
        .load_skill(
            &id,
            request
                .payload
                .id
                .as_ref()
                .map(convert::identifier)
                .transpose()?,
            &convert::domain(&request.payload.skill)?,
        )
        .await
        .map_err(failure)?;
    if request.payload.resume != Some(false) {
        let execution = core.execution;
        // Like TS, the skill load resumes the Session in the background; drain outcomes are recorded durably by the runner.
        tokio::spawn(async move { execution.resume(&id).await });
    }
    Ok(v5::SessionSkillResult { data: v5::Empty {} })
}

async fn skills(
    invocation: Invocation,
    request: v5::SessionSkillsRequest,
) -> Result<v5::SessionSkillsResult, Failure> {
    let id = invocation.session(&request.params.session_id)?;
    let (_location, _, services) = services(&invocation, &id)?;
    Ok(v5::SessionSkillsResult {
        data: v5::SessionSkillsResultData {
            items: services
                .runner
                .skill_status(&id)
                .await
                .map_err(failure)?
                .iter()
                .map(skill_status)
                .collect::<Result<_, _>>()?,
        },
    })
}

fn skill_status(
    status: &session_skill_status::Info,
) -> Result<v5::SessionSkillsResultDataItem, Failure> {
    use v5::session_skills_result_data_item::Kind;
    let declarations = v5::SkillConflicts {
        skills: v5::SkillConflictsSkills {
            items: status
                .declarations
                .skills
                .iter()
                .map(convert::wire)
                .collect(),
        },
        instructions: v5::SkillConflictsInstructions {
            items: status
                .declarations
                .instructions
                .iter()
                .map(convert::identity)
                .collect::<Result<_, _>>()?,
        },
    };
    let activated_by = if status.activated_by.as_str() == Some("reference") {
        1
    } else {
        2
    };
    let conflict_type = |type_: &LosslessString| {
        if type_.as_str() == Some("skill") {
            1
        } else {
            2
        }
    };
    Ok(v5::SessionSkillsResultDataItem {
        kind: Some(match &status.state {
            session_skill_status::State::Active => {
                Kind::Value1(v5::SessionSkillsResultDataItemValue1 {
                    id: convert::wire(&status.id),
                    name: convert::wire(&status.name),
                    activated_by,
                    activation_message_id: convert::wire(
                        status.activation_message_id.as_lossless(),
                    ),
                    content: convert::wire(&status.content),
                    conflicts: v5::SessionSkillsResultDataItemValue1Conflicts {
                        items: status
                            .conflicts
                            .iter()
                            .map(
                                |conflict| v5::SessionSkillsResultDataItemValue1ConflictsItem {
                                    r#type: conflict_type(&conflict.r#type),
                                    id: convert::wire(&conflict.id),
                                    name: convert::wire(&conflict.name),
                                },
                            )
                            .collect(),
                    },
                    declarations,
                    state: 1,
                })
            }
            session_skill_status::State::Inactive { inactive_reason } => {
                Kind::Value2(v5::SessionSkillsResultDataItemValue2 {
                    id: convert::wire(&status.id),
                    name: convert::wire(&status.name),
                    activated_by,
                    activation_message_id: convert::wire(
                        status.activation_message_id.as_lossless(),
                    ),
                    content: convert::wire(&status.content),
                    conflicts: v5::SessionSkillsResultDataItemValue2Conflicts {
                        items: status
                            .conflicts
                            .iter()
                            .map(
                                |conflict| v5::SessionSkillsResultDataItemValue2ConflictsItem {
                                    r#type: conflict_type(&conflict.r#type),
                                    id: convert::wire(&conflict.id),
                                    name: convert::wire(&conflict.name),
                                },
                            )
                            .collect(),
                    },
                    declarations,
                    state: 1,
                    inactive_reason: match inactive_reason.as_str() {
                        Some("agent_switched") => 1,
                        Some("compacted") => 2,
                        Some("conflict_resolved") => 3,
                        _ => {
                            return Err(Failure::Unavailable(
                                "Skill deactivation is not representable".into(),
                            ));
                        }
                    },
                })
            }
        }),
    })
}

async fn resolve_skill_conflict(
    invocation: Invocation,
    request: v5::SessionResolveSkillConflictRequest,
) -> Result<v5::SessionResolveSkillConflictResult, Failure> {
    let id = invocation.session(&request.params.session_id)?;
    let (_location, _, services) = services(&invocation, &id)?;
    services
        .runner
        .resolve_skill_conflict(
            &id,
            &convert::domain(&request.payload.winner)?,
            &convert::domain(&request.payload.loser)?,
        )
        .await
        .map_err(failure)?;
    Ok(v5::SessionResolveSkillConflictResult { data: v5::Empty {} })
}

async fn compact(
    invocation: Invocation,
    request: v5::SessionCompactRequest,
) -> Result<v5::SessionCompactResult, Failure> {
    let id = invocation.session(&request.params.session_id)?;
    let (_location, _, services) = services(&invocation, &id)?;
    let job_id = request
        .payload
        .id
        .as_ref()
        .map(|id| {
            compaction_execution::job_id(&convert::domain(id)?)
                .map_err(|error| Failure::Invalid(error.to_string()))
        })
        .transpose()?;
    let requested = request
        .payload
        .id
        .as_ref()
        .map(convert::domain)
        .transpose()?;
    let result = services
        .runner
        .compact(&id, job_id)
        .await
        .map_err(|error| match error {
            IngressError::Compaction(error) => Failure::Conflict(format!(
                "Compaction job ID conflicts with an existing durable record: {}{error}",
                requested
                    .as_ref()
                    .map(|id: &LosslessString| format!("{}: ", convert::readable(id)))
                    .unwrap_or_default()
            )),
            error => failure(error),
        })?;
    Ok(v5::SessionCompactResult {
        data: compaction_result(&result)?,
    })
}

fn compaction_result(job: &Job) -> Result<v5::SessionCompactionResult, Failure> {
    let failure = job
        .error_code
        .as_ref()
        .map(|code| {
            let code = session_compaction::FailureCode::decode(&JsonValue::String(code.clone()))
                .map_err(|error| Failure::Unavailable(error.to_string()))?;
            let codes = [
                "cancelled",
                "superseded",
                "invalid_manifest",
                "protected_state_changed",
                "context_limit_unresolved",
                "migration_failed",
                "provider_failed",
            ];
            Ok(codes
                .iter()
                .position(|name| *name == code.as_str())
                .ok_or_else(|| {
                    Failure::Unavailable("Compaction failure is not representable".into())
                })? as i32
                + 1)
        })
        .transpose()?;
    Ok(v5::SessionCompactionResult {
        id: convert::wire(&job.id),
        session_id: convert::wire(&job.session_id),
        trigger: match job.trigger.as_str() {
            Some("manual") => 4,
            Some("consider") => 1,
            Some("advised") => 2,
            Some("mandatory") => 3,
            _ => {
                return Err(Failure::Unavailable(
                    "Compaction trigger is not representable".into(),
                ));
            }
        },
        status: match job.status.as_str() {
            Some("ended") => 1,
            Some("failed") => 2,
            _ => return Err(Failure::Unavailable("Compaction has not settled".into())),
        },
        requested_through: v5::SessionCompactionBoundary {
            message_id: convert::wire(&job.requested_through_message_id),
            seq: job.requested_through_seq as u64,
        },
        time_created: job.time_created as f64,
        failure,
    })
}

async fn generate(
    invocation: Invocation,
    request: v5::SessionGenerateRequest,
) -> Result<v5::SessionGenerateResult, Failure> {
    let id = invocation.session(&request.params.session_id)?;
    let (_location, _, services) = services(&invocation, &id)?;
    let text = services
        .generate
        .generate(
            &id,
            convert::domain(&request.payload.prompt)?,
            &Cancellation::default(),
        )
        .await
        .map_err(|error| Failure::ServiceUnavailable {
            service: "session generation",
            message: error.to_string(),
        })?;
    Ok(v5::SessionGenerateResult {
        data: v5::SessionGenerateResponse {
            data: v5::SessionGenerateResponseData {
                text: convert::wire(&text),
            },
        },
    })
}

async fn switch_agent(
    invocation: Invocation,
    request: v5::SessionSwitchAgentRequest,
) -> Result<v5::SessionSwitchAgentResult, Failure> {
    let id = invocation.session(&request.params.session_id)?;
    let (_location, _, services) = services(&invocation, &id)?;
    services
        .runner
        .switch_agent(&id, &convert::domain(&request.payload.agent)?)
        .await
        .map_err(failure)?;
    Ok(v5::SessionSwitchAgentResult { data: v5::Empty {} })
}

async fn switch_model(
    invocation: Invocation,
    request: v5::SessionSwitchModelRequest,
) -> Result<v5::SessionSwitchModelResult, Failure> {
    let id = invocation.session(&request.params.session_id)?;
    let (_location, _, services) = services(&invocation, &id)?;
    match services
        .runner
        .switch_model(
            invocation.core()?.execution.coordinator(),
            &id,
            &model_ref(&request.payload.model)?,
        )
        .await
        .map_err(|error| switch_failure(&id, error))?
    {
        model_switch::Outcome::Switched => Ok(v5::SessionSwitchModelResult { data: v5::Empty {} }),
        model_switch::Outcome::Blocked(blocked) => Err(Failure::ModelSwitchBlocked(blocked)),
    }
}

fn switch_failure(id: &session::Id, error: IngressError) -> Failure {
    let kind = match &error {
        IngressError::Compaction(_) => Some("compaction"),
        IngressError::Execution(ycoding_core::session::run_coordinator::Error::Runner(error)) => {
            error.r#type.as_str()
        }
        _ => None,
    };
    let category = match kind {
        Some("compaction") => (
            "compaction-failed",
            "Context compaction could not complete the model switch. The prior model remains selected; inspect compaction status before retrying.",
        ),
        Some("model.profile") => {
            return Failure::InvalidField {
                field: "model.profile",
                message:
                    "Selected model profile is unavailable. Reconnect or select the profile again."
                        .into(),
            };
        }
        Some("model.unavailable") => (
            "model-unavailable",
            "Target model is unavailable. Refresh the model catalog and select an available model.",
        ),
        Some("model.variant") => (
            "variant-unavailable",
            "Target model variant is unavailable. Select a supported variant.",
        ),
        Some("model.unsupported") => (
            "unsupported-provider",
            "Target model uses an unsupported provider package. Check provider configuration.",
        ),
        Some("provider.auth") => (
            "provider-authorization",
            "Provider authorization failed. Reconnect the provider and retry the model switch.",
        ),
        _ => return failure(error),
    };
    use std::hash::{BuildHasher, Hasher};
    let reference = format!(
        "err_{:08x}",
        std::collections::hash_map::RandomState::new()
            .build_hasher()
            .finish() as u32
    );
    tracing::error!(
        r#ref = reference,
        session_id = convert::readable(id.as_lossless()),
        category = category.0,
        "session model switch failed"
    );
    Failure::Unknown {
        message: category.1.into(),
        reference,
    }
}

async fn move_session(
    invocation: Invocation,
    request: v5::SessionMoveRequest,
) -> Result<v5::SessionMoveResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let (held, _, services) = services(&invocation, &id)?;
    let value = convert::domain(&request.payload.directory)?
        .to_utf8()
        .map_err(|error| Failure::Invalid(error.to_string()))?;
    let value = value.trim();
    let expanded = if value == "~" || value.starts_with("~/") {
        std::path::PathBuf::from(
            std::env::var("HOME")
                .map_err(|_| Failure::Invalid("Home directory unavailable".into()))?,
        )
        .join(value.strip_prefix("~/").unwrap_or(""))
    } else {
        std::path::PathBuf::from(value)
    };
    let path = ycoding_core::platform::filesystem::normalize(
        &std::path::Path::new(convert::readable(held.info.directory.as_lossless()).as_str())
            .join(expanded),
    );
    let stat = tokio::fs::metadata(&path)
        .await
        .map_err(|_| Failure::Invalid(format!("Directory does not exist: {}", path.display())))?;
    if !stat.is_dir() {
        return Err(Failure::Invalid(format!(
            "Not a directory: {}",
            path.display()
        )));
    }
    let target = location::Ref {
        directory: ycoding_core::ycoding_schema::schema::AbsolutePath::new(
            path.to_string_lossy().as_ref(),
        )
        .map_err(|error| Failure::Invalid(error.to_string()))?,
        workspace_id: request
            .payload
            .workspace_id
            .as_ref()
            .map(convert::identifier)
            .transpose()?,
    };
    if services.runner.location() == &target {
        return Ok(v5::SessionMoveResult { data: v5::Empty {} });
    }
    let destination = services.destination.as_ref().ok_or_else(|| {
        Failure::Unavailable("Session destination resolver is not composed".into())
    })?;
    let info = (destination.resolve)(target.clone())
        .await
        .map_err(Failure::Unavailable)?;
    if info.directory != target.directory || info.workspace_id != target.workspace_id {
        return Err(Failure::Unavailable(
            "Destination resolver returned another Location".into(),
        ));
    }
    if core.execution.active().contains(&id) {
        core.execution
            .interrupt(&id)
            .await
            .map_err(|error| Failure::Unavailable(error.to_string()))?;
        core.execution.await_idle(&id).await;
    }
    if held.info.project.id != info.project.id {
        (destination.invalidate)(target)
            .await
            .map_err(Failure::Unavailable)?;
    }
    let destination_agent = if held.info.project.id != info.project.id {
        let destination_location = core.locations.move_location(&info)?;
        destination_location
            .agents
            .default()
            .map(|agent| agent.id.clone())
    } else {
        None
    };
    let artifacts = core
        .artifacts
        .as_ref()
        .and_then(|artifacts| artifacts(&held.info));
    services
        .runner
        .move_to(
            core.execution.coordinator(),
            &id,
            &info,
            artifacts
                .as_ref()
                .and_then(|artifacts| artifacts.store.accounting()),
            destination_agent.as_ref(),
        )
        .await
        .map_err(failure)?;
    Ok(v5::SessionMoveResult { data: v5::Empty {} })
}

async fn launch(
    invocation: Invocation,
    request: v5::SessionSubagentLaunchRequest,
) -> Result<v5::SessionSubagentLaunchResult, Failure> {
    let core = invocation.core()?;
    let parent = invocation.session(&request.params.parent_id)?;
    let (location, catalogs, services) = services(&invocation, &parent)?;
    let prepared = orchestration::Preflight::new(
        core.sessions.clone(),
        catalogs.agents.clone(),
        catalogs.models.clone(),
        core.credentials.clone(),
    )
    .prepare(
        &parent,
        &orchestration::PreflightRequest {
            agent: convert::domain(&request.payload.agent)?,
            model: request.payload.model.as_ref().map(model_ref).transpose()?,
            caller: None,
        },
    )
    .map_err(crate::session_subagent::failure)?;
    let platform = core.platform.as_ref().ok_or_else(|| {
        Failure::Unavailable("Location platform services are not composed".into())
    })?(services.runner.location())
    .map_err(Failure::Unavailable)?;
    let task = core
        .orchestration
        .launch(orchestration::LaunchInput {
            parent_id: parent,
            parent_assistant_message_id: convert::identifier(
                &request.payload.parent_assistant_message_id,
            )?,
            tool_call_id: convert::domain(&request.payload.tool_call_id)?
                .to_utf8()
                .map_err(|error| Failure::Invalid(error.to_string()))?,
            description: convert::domain(&request.payload.description)?
                .to_utf8()
                .map_err(|error| Failure::Invalid(error.to_string()))?,
            prompt: convert::domain(&request.payload.prompt)?
                .to_utf8()
                .map_err(|error| Failure::Invalid(error.to_string()))?,
            depth_limit: services.runner.subagent_depth(&platform.config),
            prepared,
            guardrails: location.guardrails.clone(),
        })
        .await
        .map_err(crate::session_subagent::failure)?;
    Ok(v5::SessionSubagentLaunchResult {
        data: convert::task(&task).map_err(|error| Failure::Unavailable(error.to_string()))?,
    })
}
