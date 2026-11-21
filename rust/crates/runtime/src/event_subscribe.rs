use crate::{
    convert,
    dispatch::{Failure, Invocation},
    ids,
};
use ycoding_core::event_feed::Scope;
use ycoding_core::ycoding_schema::{DomainDecode, JsonValue, LosslessString, session};
use ycoding_protocol::v5;

pub async fn subscribe(
    invocation: Invocation,
    request: v5::EventSubscribeRequest,
) -> Result<v5::EventSubscribeResult, Failure> {
    let core = invocation.core()?;
    if let Scope::Session(id) = target(&request.scope)? {
        match core.sessions.get(&id) {
            Ok(Some(_)) => {}
            Ok(None) => {
                return Err(Failure::SessionNotFound(String::from_utf16_lossy(
                    &id.as_lossless().code_units().collect::<Vec<_>>(),
                )));
            }
            Err(_) => return Err(Failure::Unavailable("Session store unavailable".into())),
        }
    }
    Ok(v5::EventSubscribeResult {
        subscription_id: convert::text(&format!(
            "{}_{}",
            invocation.connection_id,
            ids::subscription_id()
        )),
    })
}

pub fn target(scope: &v5::Scope) -> Result<Scope, Failure> {
    match &scope.target {
        Some(v5::scope::Target::Global(_)) => Ok(Scope::Global),
        Some(v5::scope::Target::Session(id)) => {
            session::Id::decode(&JsonValue::String(LosslessString::from(id.as_str())))
                .map(Scope::Session)
                .map_err(|_| Failure::Invalid("invalid Session ID".into()))
        }
        _ => Err(Failure::Invalid(
            "event.subscribe targets the Global scope or one Session".into(),
        )),
    }
}
