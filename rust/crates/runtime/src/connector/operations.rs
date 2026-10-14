use super::{State, Status};
use crate::{
    convert,
    dispatch::{Dispatcher, Failure, Invocation, RegistrationError},
};
use prost::{Message, Name};
use ycoding_core::{
    remote::{CredentialState, EnrollError, Enrollment, Summary},
    ycoding_schema::session,
};
use ycoding_protocol::{decode_strict, v5};

pub(crate) fn register(dispatcher: &mut Dispatcher) -> Result<(), RegistrationError> {
    dispatcher.handle("remote.get", get)?;
    dispatcher.handle("remote.enroll", enroll)?;
    dispatcher.handle("remote.set", set)?;
    dispatcher.handle(
        "session.attachment.upload",
        crate::session_attachment_upload::upload,
    )?;
    Ok(())
}

pub(crate) fn authorize(
    environment: &crate::Environment,
    descriptor: &v5::OperationDescriptor,
    request: &v5::Request,
) -> Result<(), Failure> {
    let caller_location = match descriptor.diagnostic_name.as_str() {
        "fs.find" => decode_strict::<v5::FsFindRequest>(&request.payload)
            .map_err(|_| Failure::Invalid("Invalid file search".into()))?
            .query
            .location
            .is_some(),
        "shell.output" => decode_strict::<v5::ShellOutputRequest>(&request.payload)
            .map_err(|_| Failure::Invalid("Invalid shell output read".into()))?
            .query
            .location
            .is_some(),
        "providerUsage.list" => decode_strict::<v5::ProviderUsageListRequest>(&request.payload)
            .map_err(|_| Failure::Invalid("Invalid provider usage read".into()))?
            .query
            .location
            .is_some(),
        "session.create" => {
            let query = decode_strict::<v5::SessionCreateRequest>(&request.payload)
                .map_err(|_| Failure::Invalid("Invalid Session creation".into()))?;
            if query.payload.id.is_none() || query.payload.parent_id.is_some() {
                return Err(Failure::Invalid(
                    "Remote creation requires a stable root Session ID".into(),
                ));
            }
            query.payload.location.is_some()
        }
        _ => false,
    };
    if caller_location {
        return Err(Failure::Forbidden(
            "Remote input cannot select a Location".into(),
        ));
    }
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
        if query.scope != request.scope {
            return Err(Failure::Forbidden(
                "Remote event target must match its Session scope".into(),
            ));
        }
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
    let (info, _) =
        crate::remote_derived::target::verify(core, &id).map_err(|error| match error {
            Failure::Connector { code: 5, .. } => {
                Failure::SessionNotFound(convert::readable(id.as_lossless()))
            }
            Failure::Connector { code: 10, .. } => {
                Failure::Unavailable("Session Location is unavailable".into())
            }
            error => error,
        })?;
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
        crate::remote_derived::target::verify(core, parent)?;
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
    let device = control
        .device()
        .summary(crate::ids::now_millis().max(0) as u64)
        .await
        .map_err(|_| Failure::Unavailable("Remote device enrollment could not be read".into()))?;
    Ok(v5::RemoteGetResult {
        data: v5::RemoteGetResultData {
            state,
            message,
            device: device.map(remote_device),
        },
    })
}

async fn enroll(
    invocation: Invocation,
    request: v5::RemoteEnrollRequest,
) -> Result<v5::RemoteEnrollResult, Failure> {
    let control = invocation
        .core()?
        .remote
        .as_ref()
        .ok_or_else(|| Failure::Unavailable("Remote connector is not composed".into()))?;
    let payload = request.payload;
    let enrollment = Enrollment {
        relay_origin: utf8(&payload.relay_origin, "payload.relayOrigin")?,
        enrollment_id: utf8(&payload.enrollment_id, "payload.enrollmentID")?,
        code: utf8(&payload.code, "payload.code")?,
        name: payload
            .name
            .as_ref()
            .map(|name| utf8(name, "payload.name"))
            .transpose()?,
        replace: payload.replace.unwrap_or(false),
    };
    let device = control
        .device()
        .enroll(enrollment, crate::ids::now_millis().max(0) as u64)
        .await
        .map_err(enrollment_failure)?;
    Ok(v5::RemoteEnrollResult {
        data: remote_device(device),
    })
}

fn utf8(value: &v5::LosslessString, field: &'static str) -> Result<String, Failure> {
    convert::domain(value)?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| Failure::InvalidField {
            message: "Expected well-formed text".into(),
            field,
        })
}

fn remote_device(summary: Summary) -> v5::RemoteDevice {
    v5::RemoteDevice {
        device_id: convert::text(&summary.device_id),
        name: convert::text(&summary.name),
        relay_origin: convert::text(&summary.relay_origin),
        enrolled_at: summary.enrolled_at,
        credential_state: match summary.credential_state {
            CredentialState::NotAuthenticated => 1,
            CredentialState::Valid => 2,
            CredentialState::Expired => 3,
            CredentialState::Revoked => 4,
        },
        credential_expires_at: summary.credential_expires_at,
    }
}

fn enrollment_failure(error: EnrollError) -> Failure {
    let code = match error {
        EnrollError::MissingName => {
            return Failure::InvalidField {
                message: "A device name is required".into(),
                field: "payload.name",
            };
        }
        EnrollError::Partial(summary) => {
            return Failure::RemoteEnrollment(typed(v5::RemoteEnrollmentPartialFailure {
                tag: 1,
                device: remote_device(summary),
            }));
        }
        EnrollError::InvalidOrigin => 1,
        EnrollError::InvalidCode => 2,
        EnrollError::AlreadyEnrolled => 3,
        EnrollError::RelayRejected => 4,
        EnrollError::RelayUnavailable => 5,
        EnrollError::KeyFailed => 6,
        EnrollError::StoreFailed => 7,
    };
    Failure::RemoteEnrollment(typed(v5::RemoteEnrollmentError { tag: 1, code }))
}

fn typed<T: Message + Name>(value: T) -> v5::TypedPayload {
    v5::TypedPayload {
        type_name: T::full_name(),
        payload: value.encode_to_vec(),
    }
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
