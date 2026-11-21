use crate::{
    connector::mcp::json,
    convert,
    dispatch::{Dispatcher, Failure, Invocation, RegistrationError},
};
use prost::{Message, Name};
use std::sync::Arc;
use ycoding_core::{
    platform::interaction::{self, Authority},
    tools::policy::Effect,
    ycoding_schema::{DomainDecode, DomainEncode, interaction as schema, session, session_scope},
};
use ycoding_protocol::{domain_json, limits, v5};

pub(crate) fn register(dispatcher: &mut Dispatcher) -> Result<(), RegistrationError> {
    dispatcher.handle("session.interaction.status", status)?;
    dispatcher.handle("session.interaction.request", request)?;
    dispatcher.handle("session.interaction.preview", preview)?;
    dispatcher.handle("session.interaction.stop", stop)?;
    dispatcher.handle("session.interaction.resume", resume)?;
    Ok(())
}
fn authority(invocation: &Invocation) -> Result<&Arc<Authority>, Failure> {
    invocation
        .core()?
        .interaction
        .as_ref()
        .ok_or_else(|| Failure::Unavailable("Interaction is not composed".into()))
}
fn require(invocation: &Invocation, id: &session::Id) -> Result<session::Info, Failure> {
    let core = invocation.core()?;
    let session = core
        .sessions
        .get(id)
        .map_err(|_| Failure::Unavailable("Session store is unavailable".into()))?;
    let Some(session) = session else {
        if let Some(authority) = core.interaction.as_ref() {
            authority.revoke(&convert::readable(id.as_lossless()));
        }
        return Err(Failure::SessionNotFound(convert::readable(
            id.as_lossless(),
        )));
    };
    if session.scope != session_scope::Scope::Bound || session.time.archived.is_some() {
        if let Some(authority) = core.interaction.as_ref() {
            authority.revoke(&convert::readable(id.as_lossless()));
        }
        return Err(Failure::Forbidden(
            "Interaction is unavailable for this Session".into(),
        ));
    }
    Ok(session)
}
pub(crate) async fn status(
    invocation: Invocation,
    request: v5::SessionInteractionStatusRequest,
) -> Result<v5::SessionInteractionStatusResult, Failure> {
    let id = invocation.session(&request.params.session_id)?;
    require(&invocation, &id)?;
    let status: schema::Status = interaction::to_domain(
        &authority(&invocation)?.status(&convert::readable(id.as_lossless())),
    )
    .map_err(failure)?;
    Ok(v5::SessionInteractionStatusResult {
        data: encode(&status)?,
    })
}
pub(crate) async fn request(
    invocation: Invocation,
    request: v5::SessionInteractionRequestRequest,
) -> Result<v5::SessionInteractionRequestResult, Failure> {
    let id = invocation.session(&request.params.session_id)?;
    require(&invocation, &id)?;
    let selection: schema::Request = decode(&request.payload)?;
    let status = authority(&invocation)?
        .request(
            &convert::readable(id.as_lossless()),
            interaction::from_domain(&selection).map_err(failure)?,
        )
        .map_err(failure)?;
    let status: schema::Status = interaction::to_domain(&status).map_err(failure)?;
    Ok(v5::SessionInteractionRequestResult {
        data: encode(&status)?,
    })
}
pub(crate) async fn preview(
    invocation: Invocation,
    request: v5::SessionInteractionPreviewRequest,
) -> Result<v5::SessionInteractionPreviewResult, Failure> {
    let id = invocation.session(&request.params.session_id)?;
    let session = require(&invocation, &id)?;
    let fence: schema::Fence = decode(&request.query)?;
    let generation = fence
        .generation
        .0
        .to_utf8()
        .map_err(|_| Failure::Invalid("Invalid generation".into()))?;
    let session_id = convert::readable(id.as_lossless());
    let authority = authority(&invocation)?;
    let withheld = || {
        encode(&schema::Preview::Unavailable {
            generation: fence.generation.clone(),
        })
        .map(|data| v5::SessionInteractionPreviewResult { data })
    };
    let Some(target) = authority.target(&session_id, &generation) else {
        return withheld();
    };
    let target: schema::Target = interaction::to_domain(&target).map_err(failure)?;
    let (macos, resource) = match target {
        schema::Target::MacosWindow { bundle_id, .. } => (true, bundle_id),
        schema::Target::ChromeTab {
            origin, pathname, ..
        }
        | schema::Target::ChromeOwned {
            origin, pathname, ..
        } => (
            false,
            format!(
                "{}{}",
                convert::readable(&origin),
                convert::readable(&pathname.0)
            )
            .into(),
        ),
    };
    let Ok((_, location)) = invocation.core()?.locations.session(&id) else {
        return withheld();
    };
    for action in [
        "interaction",
        if macos { "computer" } else { "browser_read" },
    ] {
        if location
            .permissions
            .evaluate_effective(&id, session.agent.as_ref(), &action.into(), &resource)
            .map_or(true, |effect| effect == Effect::Deny)
        {
            return withheld();
        }
    }
    let preview: schema::Preview =
        interaction::to_domain(&authority.preview(&session_id, &generation).await)
            .map_err(failure)?;
    Ok(v5::SessionInteractionPreviewResult {
        data: encode(&preview)?,
    })
}
pub(crate) async fn stop(
    invocation: Invocation,
    request: v5::SessionInteractionStopRequest,
) -> Result<v5::SessionInteractionStopResult, Failure> {
    let id = invocation.session(&request.params.session_id)?;
    require(&invocation, &id)?;
    let fence: schema::Fence = decode(&request.payload)?;
    let generation = fence
        .generation
        .0
        .to_utf8()
        .map_err(|_| Failure::Invalid("Invalid generation".into()))?;
    let session_id = convert::readable(id.as_lossless());
    let authority = authority(&invocation)?;
    authority.stop(&session_id, &generation);
    let status: schema::Status =
        interaction::to_domain(&authority.status(&session_id)).map_err(failure)?;
    if !matches!(&status,schema::Status::Stopped {generation,..}if generation==&fence.generation) {
        return Err(Failure::Conflict(
            "No Interaction matches this generation".into(),
        ));
    }
    Ok(v5::SessionInteractionStopResult {
        data: encode(&status)?,
    })
}
pub(crate) async fn resume(
    invocation: Invocation,
    request: v5::SessionInteractionResumeRequest,
) -> Result<v5::SessionInteractionResumeResult, Failure> {
    let id = invocation.session(&request.params.session_id)?;
    require(&invocation, &id)?;
    let fence: schema::Fence = decode(&request.payload)?;
    let generation = fence
        .generation
        .0
        .to_utf8()
        .map_err(|_| Failure::Invalid("Invalid generation".into()))?;
    let session_id = convert::readable(id.as_lossless());
    let authority = authority(&invocation)?;
    let status: schema::Status =
        interaction::to_domain(&authority.status(&session_id)).map_err(failure)?;
    if !matches!(&status,schema::Status::Paused {generation,..}if generation==&fence.generation) {
        return Err(Failure::Conflict(
            "No paused Interaction matches this generation".into(),
        ));
    }
    authority.resume(&session_id, &generation).await;
    let status: schema::Status =
        interaction::to_domain(&authority.status(&session_id)).map_err(failure)?;
    Ok(v5::SessionInteractionResumeResult {
        data: encode(&status)?,
    })
}
fn decode<T: DomainDecode, Q: Message + Name>(message: &Q) -> Result<T, Failure> {
    let value = domain_json::decode(&Q::full_name(), &message.encode_to_vec())
        .map_err(|_| Failure::Invalid("Malformed Interaction payload".into()))?;
    T::decode(&json::value(&value))
        .map_err(|_| Failure::Invalid("Invalid Interaction input".into()))
}
fn encode<R: Message + Name + Default>(value: &impl DomainEncode) -> Result<R, Failure> {
    let bytes = domain_json::encode(
        &R::full_name(),
        &convert::json_domain(&value.encode()),
        limits::INLINE_BODY_BYTES as usize,
    )
    .map_err(|_| Failure::Unavailable("Interaction result cannot be encoded".into()))?;
    R::decode(bytes.as_slice())
        .map_err(|_| Failure::Unavailable("Interaction result cannot be decoded".into()))
}
fn failure(error: interaction::Error) -> Failure {
    match error.0 {
        "stale" | "busy" => Failure::Conflict(error.to_string()),
        "invalid" => Failure::Invalid(error.to_string()),
        _ => Failure::Unavailable(error.to_string()),
    }
}
