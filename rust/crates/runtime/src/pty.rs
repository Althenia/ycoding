use crate::{
    convert,
    dispatch::{Failure, Invocation},
    platform_services,
};
use ycoding_core::platform::pty::ticket;
use ycoding_core::ycoding_schema::{JsonObject, JsonValue, pty, schema::PositiveInt};
use ycoding_protocol::v5;

pub(crate) fn failure(id: &v5::LosslessString, error: std::io::Error) -> Failure {
    let id = convert::domain(id)
        .map(|id| convert::readable(&id))
        .unwrap_or_default();
    match error.kind() {
        std::io::ErrorKind::NotFound => Failure::PtyNotFound(id),
        std::io::ErrorKind::PermissionDenied if error.to_string().contains("fence") => {
            Failure::PtyConflict(id)
        }
        std::io::ErrorKind::PermissionDenied => {
            Failure::Forbidden("PTY does not belong to this Session".into())
        }
        std::io::ErrorKind::WouldBlock => Failure::PtyConflict(id),
        std::io::ErrorKind::OutOfMemory => Failure::PtyResourceLimit(
            error
                .to_string()
                .split(": ")
                .nth(1)
                .unwrap_or("active")
                .into(),
        ),
        _ => platform_services::io(error),
    }
}

fn positive(value: u64) -> Result<PositiveInt, Failure> {
    PositiveInt::new(value as i64).map_err(|error| Failure::Invalid(error.to_string()))
}
fn size(size: v5::PtySize) -> Result<pty::Size, Failure> {
    Ok(pty::Size {
        rows: positive(size.rows)?,
        cols: positive(size.cols)?,
    })
}

fn info(info: &pty::Info) -> Result<v5::Pty, Failure> {
    Ok(v5::Pty {
        id: convert::identity(&info.id)?,
        title: convert::wire(&info.title),
        command: convert::wire(&info.command),
        args: v5::PtyArgs {
            items: info.args.iter().map(convert::wire).collect(),
        },
        cwd: convert::wire(&info.cwd),
        session_id: convert::wire(info.session_id.as_lossless()),
        status: match info.status {
            pty::Status::Running => v5::PtyStatus::Running,
            pty::Status::Exited => v5::PtyStatus::Exited,
        } as i32,
        pid: info.pid.get() as u64,
        exit_code: info.exit_code.map(|value| value.get() as u64),
        exit_reason: info.exit_reason.map(|reason| match reason {
            pty::ExitReason::Exit => v5::PtyExitReason::PtyExitreasonExit,
            pty::ExitReason::Timeout => v5::PtyExitReason::PtyExitreasonTimeout,
            pty::ExitReason::Terminated => v5::PtyExitReason::PtyExitreasonTerminated,
        } as i32),
        generation: info.generation.get() as u64,
        size: v5::PtySize {
            rows: info.size.rows.get() as u64,
            cols: info.size.cols.get() as u64,
        },
        control: v5::PtyControl {
            owner: match info.control.owner {
                pty::ControlOwner::Agent => v5::PtyControlOwner::Agent,
                pty::ControlOwner::User => v5::PtyControlOwner::User,
                pty::ControlOwner::Paused => v5::PtyControlOwner::Paused,
            } as i32,
            fence: info.control.fence.get() as u64,
        },
        output: v5::PtyOutput {
            start_offset: info.output.start_offset.get() as u64,
            end_offset: info.output.end_offset.get() as u64,
            truncated: info.output.truncated,
        },
        limits: v5::PtyLimits {
            max_runtime_seconds: info.limits.max_runtime_seconds.get() as u64,
            max_retained_bytes: info.limits.max_retained_bytes.get() as u64,
            max_input_bytes: info.limits.max_input_bytes.get() as u64,
        },
    })
}

pub async fn create(
    invocation: Invocation,
    request: v5::PtyCreateRequest,
) -> Result<v5::PtyCreateResult, Failure> {
    let q = request.query.location.as_ref();
    let (location, services) = platform_services::resolve(
        &invocation,
        q.and_then(|q| q.directory.as_ref()),
        q.and_then(|q| q.workspace.as_ref()),
    )?;
    let session_id = convert::identifier(&request.payload.session_id)?;
    let owner = invocation
        .core()?
        .sessions
        .get(&session_id)
        .map_err(|error| Failure::Unavailable(error.to_string()))?
        .ok_or_else(|| Failure::SessionNotFound(convert::readable(session_id.as_lossless())))?;
    if owner.location.directory != location.directory
        || owner.location.workspace_id != location.workspace_id
    {
        return Err(Failure::SessionNotFound(convert::readable(
            session_id.as_lossless(),
        )));
    }
    let env = request
        .payload
        .env
        .map(|env| {
            let mut values = JsonObject::new();
            for entry in env.entries {
                values.insert(
                    convert::domain(&entry.key)?,
                    JsonValue::String(convert::domain(&entry.value)?),
                );
            }
            Ok::<_, Failure>(values)
        })
        .transpose()?;
    let input = pty::CreateInput {
        session_id,
        command: request
            .payload
            .command
            .as_ref()
            .map(convert::domain)
            .transpose()?,
        args: request
            .payload
            .args
            .map(|args| {
                args.items
                    .iter()
                    .map(convert::domain)
                    .collect::<Result<_, _>>()
            })
            .transpose()?,
        cwd: Some(platform_services::cwd(
            &services,
            request.payload.cwd.as_ref(),
        )?),
        title: request
            .payload
            .title
            .as_ref()
            .map(convert::domain)
            .transpose()?,
        env,
        size: request.payload.size.map(size).transpose()?,
        max_runtime_seconds: request
            .payload
            .max_runtime_seconds
            .map(positive)
            .transpose()?,
        max_retained_bytes: request
            .payload
            .max_retained_bytes
            .map(positive)
            .transpose()?,
    };
    Ok(v5::PtyCreateResult {
        location: convert::location_info(&location),
        data: info(
            &services
                .pty
                .create(input, Some(&services.config))
                .await
                .map_err(|error| failure(&request.payload.session_id, error))?,
        )?,
    })
}

pub async fn list(
    invocation: Invocation,
    request: v5::PtyListRequest,
) -> Result<v5::PtyListResult, Failure> {
    let q = request.query.location.as_ref();
    let (location, services) = platform_services::resolve(
        &invocation,
        q.and_then(|q| q.directory.as_ref()),
        q.and_then(|q| q.workspace.as_ref()),
    )?;
    Ok(v5::PtyListResult {
        location: convert::location_info(&location),
        data: v5::PtyListResultData {
            items: services
                .pty
                .list(&convert::identifier(&request.query.session_id)?)
                .map_err(platform_services::io)?
                .iter()
                .map(info)
                .collect::<Result<_, _>>()?,
        },
    })
}

pub async fn get(
    invocation: Invocation,
    request: v5::PtyGetRequest,
) -> Result<v5::PtyGetResult, Failure> {
    let q = request.query.location.as_ref();
    let (location, services) = platform_services::resolve(
        &invocation,
        q.and_then(|q| q.directory.as_ref()),
        q.and_then(|q| q.workspace.as_ref()),
    )?;
    Ok(v5::PtyGetResult {
        location: convert::location_info(&location),
        data: info(
            &services
                .pty
                .get(
                    &convert::identifier(&request.params.pty_id)?,
                    &convert::identifier(&request.query.session_id)?,
                )
                .map_err(|error| failure(&request.params.pty_id, error))?,
        )?,
    })
}

pub async fn remove(
    invocation: Invocation,
    request: v5::PtyRemoveRequest,
) -> Result<v5::PtyRemoveResult, Failure> {
    let q = request.query.location.as_ref();
    let (_, services) = platform_services::resolve(
        &invocation,
        q.and_then(|q| q.directory.as_ref()),
        q.and_then(|q| q.workspace.as_ref()),
    )?;
    services
        .pty
        .remove(
            &convert::identifier(&request.params.pty_id)?,
            &convert::identifier(&request.query.session_id)?,
        )
        .await
        .map_err(|error| failure(&request.params.pty_id, error))?;
    Ok(v5::PtyRemoveResult { data: v5::Empty {} })
}

pub async fn control(
    invocation: Invocation,
    request: v5::PtyControlRequest,
) -> Result<v5::PtyControlResult, Failure> {
    let q = request.query.location.as_ref();
    let (location, services) = platform_services::resolve(
        &invocation,
        q.and_then(|q| q.directory.as_ref()),
        q.and_then(|q| q.workspace.as_ref()),
    )?;
    let input = pty::ControlInput {
        session_id: convert::identifier(&request.payload.session_id)?,
        generation: positive(request.payload.generation)?,
        expected_fence: positive(request.payload.expected_fence)?,
        action: match v5::PtyControlRequestPayloadAction::try_from(request.payload.action) {
            Ok(v5::PtyControlRequestPayloadAction::Take) => pty::ControlAction::Take,
            Ok(v5::PtyControlRequestPayloadAction::Pause) => pty::ControlAction::Pause,
            Ok(v5::PtyControlRequestPayloadAction::Agent) => pty::ControlAction::Agent,
            _ => return Err(Failure::Invalid("Invalid control action".into())),
        },
    };
    Ok(v5::PtyControlResult {
        location: convert::location_info(&location),
        data: info(
            &services
                .pty
                .control(&convert::identifier(&request.params.pty_id)?, input)
                .map_err(|error| failure(&request.params.pty_id, error))?,
        )?,
    })
}

pub async fn update(
    invocation: Invocation,
    request: v5::PtyUpdateRequest,
) -> Result<v5::PtyUpdateResult, Failure> {
    let q = request.query.location.as_ref();
    let (location, services) = platform_services::resolve(
        &invocation,
        q.and_then(|q| q.directory.as_ref()),
        q.and_then(|q| q.workspace.as_ref()),
    )?;
    let input = pty::UpdateInput {
        session_id: convert::identifier(&request.payload.session_id)?,
        generation: positive(request.payload.generation)?,
        expected_fence: positive(request.payload.expected_fence)?,
        actor: match v5::PtyUpdateRequestPayloadActor::try_from(request.payload.actor) {
            Ok(v5::PtyUpdateRequestPayloadActor::Agent) => pty::Actor::Agent,
            Ok(v5::PtyUpdateRequestPayloadActor::User) => pty::Actor::User,
            _ => return Err(Failure::Invalid("Invalid PTY actor".into())),
        },
        title: request
            .payload
            .title
            .as_ref()
            .map(convert::domain)
            .transpose()?,
        size: request.payload.size.map(size).transpose()?,
    };
    Ok(v5::PtyUpdateResult {
        location: convert::location_info(&location),
        data: info(
            &services
                .pty
                .update(&convert::identifier(&request.params.pty_id)?, input)
                .await
                .map_err(|error| failure(&request.params.pty_id, error))?,
        )?,
    })
}

pub async fn connect_token(
    invocation: Invocation,
    request: v5::PtyConnectTokenRequest,
) -> Result<v5::PtyConnectTokenResult, Failure> {
    let q = request.query.location.as_ref();
    let (location, services) = platform_services::resolve(
        &invocation,
        q.and_then(|q| q.directory.as_ref()),
        q.and_then(|q| q.workspace.as_ref()),
    )?;
    let id = convert::identifier(&request.params.pty_id)?;
    let owner = convert::identifier(&request.payload.session_id)?;
    let current = services
        .pty
        .get(&id, &owner)
        .map_err(|error| failure(&request.params.pty_id, error))?;
    let access = match v5::PtyConnectTokenRequestPayloadAccess::try_from(request.payload.access) {
        Ok(v5::PtyConnectTokenRequestPayloadAccess::PtyConnecttokenRequestPayloadAccessInspect) => {
            pty::Access::Inspect
        }
        Ok(v5::PtyConnectTokenRequestPayloadAccess::PtyConnecttokenRequestPayloadAccessControl) => {
            pty::Access::Control
        }
        _ => return Err(Failure::Invalid("Invalid access".into())),
    };
    let fence = (access == pty::Access::Control)
        .then_some(request.payload.expected_fence)
        .flatten();
    if current.generation.get() as u64 != request.payload.generation
        || (access == pty::Access::Control
            && (current.control.owner != pty::ControlOwner::User
                || fence != Some(current.control.fence.get() as u64)))
    {
        return Err(Failure::PtyConflict(convert::readable(&convert::domain(
            &request.params.pty_id,
        )?)));
    }
    let token = services
        .tickets
        .lock()
        .map_err(|_| Failure::Unavailable("PTY tickets unavailable".into()))?
        .issue(ticket::Scope {
            pty_id: id,
            session_id: owner,
            access,
            generation: request.payload.generation,
            fence,
            directory: Some(convert::readable(location.directory.as_lossless())),
            workspace_id: location
                .workspace_id
                .as_ref()
                .map(|id| convert::readable(id.as_lossless())),
        })
        .map_err(platform_services::io)?;
    Ok(v5::PtyConnectTokenResult {
        location: convert::location_info(&location),
        data: v5::PtyTicketConnectToken {
            ticket: convert::wire(&token.ticket),
            expires_in: token.expires_in.get() as u64,
            access: match token.access {
                pty::Access::Inspect => {
                    v5::PtyTicketConnectTokenAccess::PtyticketConnecttokenAccessInspect
                }
                pty::Access::Control => {
                    v5::PtyTicketConnectTokenAccess::PtyticketConnecttokenAccessControl
                }
            } as i32,
            generation: token.generation.get() as u64,
            fence: token.fence.map(|value| value.get() as u64),
        },
    })
}
