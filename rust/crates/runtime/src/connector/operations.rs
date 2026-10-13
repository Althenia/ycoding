use super::{State, Status};
use crate::{
    convert,
    dispatch::{Dispatcher, Failure, Invocation, RegistrationError},
};
use ycoding_core::ycoding_schema::session;
use ycoding_protocol::{decode_strict, v5};

pub(crate) fn register(dispatcher: &mut Dispatcher) -> Result<(), RegistrationError> {
    dispatcher.handle("remote.get", get)?;
    dispatcher.handle("remote.set", set)?;
    Ok(())
}

pub(crate) fn authorize(
    environment: &crate::Environment,
    descriptor: &v5::OperationDescriptor,
    request: &v5::Request,
) -> Result<(), Failure> {
    let scope = match &request.scope.target {
        Some(v5::scope::Target::Machine(_)) => v5::ScopeKind::Machine,
        Some(v5::scope::Target::Location(_)) => v5::ScopeKind::Location,
        Some(v5::scope::Target::Session(_)) => v5::ScopeKind::Session,
        Some(v5::scope::Target::Form(_)) => v5::ScopeKind::Form,
        Some(v5::scope::Target::Workspace(_)) => v5::ScopeKind::Workspace,
        Some(v5::scope::Target::Global(_)) => v5::ScopeKind::Global,
        Some(v5::scope::Target::GlobalForm(_)) => v5::ScopeKind::GlobalForm,
        None => return Err(Failure::Invalid("Missing remote scope".into())),
    };
    if ![v5::PeerRole::RemoteClient, v5::PeerRole::Relay]
        .iter()
        .all(|role| {
            descriptor
                .role_scopes
                .iter()
                .find(|entry| entry.role == *role as i32)
                .map_or(scope as i32 == descriptor.scope, |entry| {
                    entry.scopes.contains(&(scope as i32))
                })
        })
    {
        return Err(Failure::Invalid(
            "Remote scope does not match the operation".into(),
        ));
    }
    if let Some(v5::scope::Target::Workspace(id)) = &request.scope.target {
        let core = environment
            .services
            .core
            .as_ref()
            .ok_or_else(|| Failure::Unavailable("Core is not ready".into()))?;
        crate::remote_derived::target::workspace(core, &id.as_str().into())?;
        return Ok(());
    }
    if scope == v5::ScopeKind::Location {
        return Err(Failure::Forbidden(
            "Remote placement requires backend-advertised workspace resolution".into(),
        ));
    }
    let scoped = match &request.scope.target {
        Some(v5::scope::Target::Session(id) | v5::scope::Target::Form(id)) => Some(id.as_str()),
        _ => None,
    };
    let event_scope = if descriptor.diagnostic_name == "event.subscribe" {
        let query = decode_strict::<v5::EventSubscribeRequest>(&request.payload)
            .map_err(|_| Failure::Invalid("Invalid event subscription".into()))?;
        match query.scope.target {
            Some(v5::scope::Target::Session(id)) => Some(id),
            _ => {
                return Err(Failure::Forbidden(
                    "Remote event subscriptions require one Session".into(),
                ));
            }
        }
    } else {
        None
    };
    let Some(id) = scoped.or(event_scope.as_deref()) else {
        return Ok(());
    };
    let core = environment
        .services
        .core
        .as_ref()
        .ok_or_else(|| Failure::Unavailable("Core is not ready".into()))?;
    let id = session::Id::new(id).map_err(|_| Failure::Invalid("Invalid Session ID".into()))?;
    let (info, _) = core.locations.session(&id)?;
    if !std::fs::metadata(convert::readable(info.location.directory.as_lossless()))
        .is_ok_and(|metadata| metadata.is_dir())
    {
        return Err(Failure::SessionNotFound(convert::readable(
            id.as_lossless(),
        )));
    }
    let managed = info.parent_id.is_some()
        && info
            .agent
            .as_ref()
            .is_none_or(|agent| agent.as_str() != Some("btw"));
    let input = matches!(
        descriptor.diagnostic_name.as_str(),
        "session.prompt"
            | "session.command"
            | "session.compact"
            | "session.skill"
            | "session.attachment.upload"
            | "session.switchModel"
            | "session.switchAgent"
            | "session.autonomy.set"
    );
    if managed && input {
        return Err(Failure::Connector {
            code: 6,
            message: "Managed subagents are read-only",
        });
    }
    if matches!(
        descriptor.diagnostic_name.as_str(),
        "session.pin" | "session.unpin"
    ) && !managed
    {
        return Err(Failure::Forbidden(
            "Only managed children may be pinned remotely".into(),
        ));
    }
    if let Some(parent) = &info.parent_id {
        core.locations.session(parent)?;
    }
    Ok(())
}

fn state(status: Status) -> (i32, Option<v5::LosslessString>) {
    (
        match status.state {
            State::Off => 1,
            State::Connecting => 2,
            State::On => 3,
            State::Error => 4,
        },
        status.message.map(convert::text),
    )
}

async fn get(
    invocation: Invocation,
    _: v5::RemoteGetRequest,
) -> Result<v5::RemoteGetResult, Failure> {
    let control = invocation
        .core()?
        .remote
        .as_ref()
        .ok_or_else(|| Failure::Unavailable("Remote connector is not composed".into()))?;
    let (state, message) = state(control.status());
    Ok(v5::RemoteGetResult {
        data: v5::RemoteGetResultData { state, message },
    })
}

async fn set(
    invocation: Invocation,
    request: v5::RemoteSetRequest,
) -> Result<v5::RemoteSetResult, Failure> {
    let control = invocation
        .core()?
        .remote
        .as_ref()
        .ok_or_else(|| Failure::Unavailable("Remote connector is not composed".into()))?;
    let (state, message) = state(
        control
            .set(request.payload.enabled)
            .await
            .map_err(|_| Failure::Unavailable("Remote preference could not be saved".into()))?,
    );
    Ok(v5::RemoteSetResult {
        data: v5::RemoteSetResultData { state, message },
    })
}
