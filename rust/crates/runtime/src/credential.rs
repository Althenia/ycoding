use crate::{convert, dispatch::Failure};
use ycoding_core::ycoding_schema::{DomainDecode, JsonValue, credential};
use ycoding_protocol::v5;

pub async fn update(
    invocation: crate::Invocation,
    request: v5::CredentialUpdateRequest,
) -> Result<v5::CredentialUpdateResult, Failure> {
    let core = invocation.core()?;
    let id = credential_id(&request.params.credential_id)?;
    core.credentials
        .update(
            id,
            Some(convert::domain(&request.payload.label)?),
            None,
            crate::ids::now_millis(),
        )
        .await
        .map_err(credential_unavailable)?;
    Ok(v5::CredentialUpdateResult { data: v5::Empty {} })
}

pub async fn activate(
    invocation: crate::Invocation,
    request: v5::CredentialActivateRequest,
) -> Result<v5::CredentialActivateResult, Failure> {
    let core = invocation.core()?;
    core.credentials
        .activate(
            credential_id(&request.params.credential_id)?,
            crate::ids::now_millis(),
        )
        .await
        .map_err(credential_unavailable)?;
    Ok(v5::CredentialActivateResult { data: v5::Empty {} })
}

pub async fn remove(
    invocation: crate::Invocation,
    request: v5::CredentialRemoveRequest,
) -> Result<v5::CredentialRemoveResult, Failure> {
    let core = invocation.core()?;
    core.credentials
        .remove(
            credential_id(&request.params.credential_id)?,
            crate::ids::now_millis(),
        )
        .await
        .map_err(credential_unavailable)?;
    Ok(v5::CredentialRemoveResult { data: v5::Empty {} })
}

fn credential_id(
    value: &v5::LosslessString,
) -> Result<ycoding_core::ycoding_schema::LosslessString, Failure> {
    let value = convert::domain(value)?;
    credential::Id::decode(&JsonValue::String(value.clone()))
        .map(|_| value)
        .map_err(|_| Failure::Invalid("invalid credential ID".into()))
}

fn credential_unavailable(_: ycoding_core::resources::credential::Error) -> Failure {
    Failure::Unavailable("credential store unavailable".into())
}
