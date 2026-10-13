use crate::{
    convert,
    dispatch::{Dispatcher, Failure, Invocation, RegistrationError},
    ids, integration_convert,
    services::IntegrationServices,
};
use ycoding_core::resources::credential::Error;
use ycoding_core::ycoding_schema::{JsonObject, JsonValue, integration};
use ycoding_protocol::v5;

pub fn register(dispatcher: &mut Dispatcher) -> Result<(), RegistrationError> {
    dispatcher.handle("integration.list", list)?;
    dispatcher.handle("integration.get", get)?;
    dispatcher.handle("integration.wellknown.add", wellknown_add)?;
    dispatcher.handle("integration.connect.key", key)?;
    dispatcher.handle("integration.oauth.connect", oauth_connect)?;
    dispatcher.handle("integration.oauth.status", oauth_status)?;
    dispatcher.handle("integration.oauth.complete", oauth_complete)?;
    dispatcher.handle("integration.oauth.cancel", oauth_cancel)?;
    dispatcher.handle("integration.command.connect", command_connect)?;
    dispatcher.handle("integration.command.status", command_status)?;
    dispatcher.handle("integration.command.cancel", command_cancel)?;
    Ok(())
}

pub async fn list(
    invocation: Invocation,
    request: v5::IntegrationListRequest,
) -> Result<v5::IntegrationListResult, Failure> {
    let (location, services) = resolve(&invocation, &request.query)?;
    let items = services
        .registry
        .list_by(|first, second| {
            ycoding_core::platform::filesystem::collation::compare(
                &first.code_units().collect::<Vec<_>>(),
                &second.code_units().collect::<Vec<_>>(),
            )
        })
        .map_err(|_| Failure::Unavailable("Integration registry unavailable".into()))?;
    Ok(v5::IntegrationListResult {
        location,
        data: v5::IntegrationListResultData {
            items: items.iter().map(integration_convert::info).collect(),
        },
    })
}

pub async fn get(
    invocation: Invocation,
    request: v5::IntegrationGetRequest,
) -> Result<v5::IntegrationGetResult, Failure> {
    let (location, services) = resolve(&invocation, &request.query)?;
    let info = services
        .registry
        .get(&convert::domain(&request.params.integration_id)?)
        .map_err(|_| Failure::Unavailable("Integration registry unavailable".into()))?;
    Ok(v5::IntegrationGetResult {
        location,
        data: v5::IntegrationGetResultData {
            kind: Some(match info {
                Some(info) => {
                    v5::integration_get_result_data::Kind::Value1(integration_convert::info(&info))
                }
                None => v5::integration_get_result_data::Kind::None(v5::Empty {}),
            }),
        },
    })
}

pub async fn command_status(
    invocation: Invocation,
    request: v5::IntegrationCommandStatusRequest,
) -> Result<v5::IntegrationCommandStatusResult, Failure> {
    let (location, services) = resolve(&invocation, &request.query)?;
    let status = services
        .registry
        .command_status(
            &convert::domain(&request.params.integration_id)?,
            &convert::identifier(&request.params.attempt_id)?,
        )
        .map_err(|_| Failure::Unavailable("Command attempt not found".into()))?;
    Ok(v5::IntegrationCommandStatusResult {
        location,
        data: integration_convert::command_status(&status),
    })
}

fn resolve(
    invocation: &Invocation,
    query: &v5::LocationQuery,
) -> Result<(v5::LocationInfo, IntegrationServices), Failure> {
    let location = invocation.location(query.location.as_ref())?;
    let resolver = invocation.core()?.integrations.as_ref().ok_or_else(|| {
        Failure::Unavailable("Location integration resolver is not composed".into())
    })?;
    let services = resolver(&location.info)
        .map_err(|_| Failure::Unavailable("Location integration registry unavailable".into()))?;
    services
        .registry
        .bind_events(
            invocation.core()?.events.clone(),
            Some(ycoding_core::ycoding_schema::location::Ref {
                directory: location.info.directory.clone(),
                workspace_id: location.info.workspace_id.clone(),
            }),
        )
        .map_err(Failure::Unavailable)?;
    Ok((convert::location_info(&location.info), services))
}

fn authorization(error: Error) -> Failure {
    match error {
        Error::CodeRequired => Failure::IntegrationCodeRequired,
        _ => Failure::IntegrationAuthorization,
    }
}

pub async fn wellknown_add(
    invocation: Invocation,
    request: v5::IntegrationWellknownAddRequest,
) -> Result<v5::IntegrationWellknownAddResult, Failure> {
    let (_, services) = resolve(&invocation, &request.query)?;
    let service = services
        .wellknown
        .ok_or_else(|| Failure::Unavailable("Well-known discovery is not composed".into()))?;
    let url = convert::domain(&request.payload.url)?
        .to_utf8()
        .map_err(|_| Failure::WellKnownDiscovery("Invalid well-known URL".into()))?;
    service
        .add(&url, ids::now_millis())
        .await
        .map_err(|error| match error {
            ycoding_core::resources::discovery::wellknown::Error::MissingAuth => {
                Failure::WellKnownDiscovery(format!(
                    "No authentication method found at {}",
                    url.trim_end_matches('/')
                ))
            }
            ycoding_core::resources::discovery::wellknown::Error::Http
            | ycoding_core::resources::discovery::wellknown::Error::InvalidManifest => {
                Failure::WellKnownDiscovery(format!(
                    "Failed to load wellknown manifest from {}/.well-known/ycoding",
                    url.trim_end_matches('/')
                ))
            }
            _ => Failure::Unavailable("Well-known source storage unavailable".into()),
        })?;
    Ok(v5::IntegrationWellknownAddResult { data: v5::Empty {} })
}

pub async fn key(
    invocation: Invocation,
    request: v5::IntegrationConnectKeyRequest,
) -> Result<v5::IntegrationConnectKeyResult, Failure> {
    let (_, services) = resolve(&invocation, &request.query)?;
    services
        .registry
        .login_key(
            convert::domain(&request.params.integration_id)?,
            request
                .payload
                .label
                .as_ref()
                .map(convert::domain)
                .transpose()?,
            convert::domain(&request.payload.key)?,
            ids::now_millis(),
        )
        .await
        .map_err(authorization)?;
    Ok(v5::IntegrationConnectKeyResult { data: v5::Empty {} })
}

pub async fn oauth_connect(
    invocation: Invocation,
    request: v5::IntegrationOauthConnectRequest,
) -> Result<v5::IntegrationOauthConnectResult, Failure> {
    let (location, services) = resolve(&invocation, &request.query)?;
    let mut inputs = JsonObject::new();
    for entry in &request.payload.inputs.entries {
        inputs.insert(
            convert::domain(&entry.key)?,
            JsonValue::String(convert::domain(&entry.value)?),
        );
    }
    let attempt = services
        .registry
        .connect(
            convert::domain(&request.params.integration_id)?,
            convert::domain(&request.payload.method_id)?,
            integration::Inputs(inputs),
            request
                .payload
                .label
                .as_ref()
                .map(convert::domain)
                .transpose()?,
            ids::now_millis(),
        )
        .await
        .map_err(authorization)?;
    Ok(v5::IntegrationOauthConnectResult {
        location,
        data: integration_convert::attempt(&attempt)?,
    })
}

pub async fn oauth_status(
    invocation: Invocation,
    request: v5::IntegrationOauthStatusRequest,
) -> Result<v5::IntegrationOauthStatusResult, Failure> {
    let (location, services) = resolve(&invocation, &request.query)?;
    let status = services
        .registry
        .status(
            &convert::domain(&request.params.integration_id)?,
            &convert::identifier(&request.params.attempt_id)?,
        )
        .map_err(|_| Failure::Unavailable("OAuth attempt not found".into()))?;
    Ok(v5::IntegrationOauthStatusResult {
        location,
        data: integration_convert::status(&status),
    })
}

pub async fn oauth_complete(
    invocation: Invocation,
    request: v5::IntegrationOauthCompleteRequest,
) -> Result<v5::IntegrationOauthCompleteResult, Failure> {
    let (_, services) = resolve(&invocation, &request.query)?;
    let code = request
        .payload
        .code
        .as_ref()
        .map(convert::domain)
        .transpose()?
        .map(|code| {
            code.to_utf8()
                .map_err(|_| Failure::IntegrationAuthorization)
        })
        .transpose()?;
    services
        .registry
        .complete(
            &convert::domain(&request.params.integration_id)?,
            &convert::identifier(&request.params.attempt_id)?,
            code.as_deref(),
            ids::now_millis(),
        )
        .await
        .map_err(authorization)?;
    Ok(v5::IntegrationOauthCompleteResult { data: v5::Empty {} })
}

pub async fn oauth_cancel(
    invocation: Invocation,
    request: v5::IntegrationOauthCancelRequest,
) -> Result<v5::IntegrationOauthCancelResult, Failure> {
    let (_, services) = resolve(&invocation, &request.query)?;
    services
        .registry
        .cancel(
            &convert::domain(&request.params.integration_id)?,
            &convert::identifier(&request.params.attempt_id)?,
        )
        .await
        .map_err(authorization)?;
    Ok(v5::IntegrationOauthCancelResult { data: v5::Empty {} })
}

pub async fn command_connect(
    invocation: Invocation,
    request: v5::IntegrationCommandConnectRequest,
) -> Result<v5::IntegrationCommandConnectResult, Failure> {
    let (location, services) = resolve(&invocation, &request.query)?;
    let attempt = services
        .registry
        .connect_command(
            convert::domain(&request.params.integration_id)?,
            convert::domain(&request.payload.method_id)?,
            request
                .payload
                .label
                .as_ref()
                .map(convert::domain)
                .transpose()?,
            ids::now_millis(),
        )
        .await
        .map_err(authorization)?;
    Ok(v5::IntegrationCommandConnectResult {
        location,
        data: v5::IntegrationCommandAttempt {
            attempt_id: convert::wire(&attempt.attempt_id.0),
            time: v5::IntegrationCommandAttemptTime {
                created: attempt.time.created,
                expires: attempt.time.expires,
            },
        },
    })
}

pub async fn command_cancel(
    invocation: Invocation,
    request: v5::IntegrationCommandCancelRequest,
) -> Result<v5::IntegrationCommandCancelResult, Failure> {
    let (_, services) = resolve(&invocation, &request.query)?;
    services
        .registry
        .cancel_command(
            &convert::domain(&request.params.integration_id)?,
            &convert::identifier(&request.params.attempt_id)?,
        )
        .await
        .map_err(authorization)?;
    Ok(v5::IntegrationCommandCancelResult { data: v5::Empty {} })
}
