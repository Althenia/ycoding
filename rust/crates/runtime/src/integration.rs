use crate::{
    convert,
    dispatch::{Dispatcher, Failure, Invocation, RegistrationError},
    ids, integration_convert,
    services::IntegrationServices,
};
use ycoding_core::resources::credential::Error;
use ycoding_core::ycoding_schema::{JsonObject, JsonValue, integration};
use ycoding_protocol::v5;

#[cfg(test)]
mod account_skills_tests;

pub fn register(dispatcher: &mut Dispatcher) -> Result<(), RegistrationError> {
    dispatcher.handle("integration.list", list)?;
    dispatcher.handle("integration.get", get)?;
    dispatcher.handle("integration.accountSkills.read", account_skills_read)?;
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

fn account_skills_invalid(kind: &'static str, message: &str) -> Failure {
    Failure::InvalidRequest {
        message: message.into(),
        kind,
    }
}

pub async fn account_skills_read(
    invocation: Invocation,
    request: v5::IntegrationAccountSkillsReadRequest,
) -> Result<v5::IntegrationAccountSkillsReadResult, Failure> {
    use ycoding_core::resources::account_connectors::skills_read::{Input, Reader};
    use ycoding_core::ycoding_schema::session;

    if convert::domain(&request.params.integration_id)? != "openai".into() {
        return Err(account_skills_invalid(
            "unsupported_integration",
            "Account skills are only supported for the openai integration",
        ));
    }
    let id = request.query.session_id.as_ref().ok_or_else(|| {
        account_skills_invalid("missing_provenance", "Session provenance is required")
    })?;
    let id: session::Id = convert::identifier(id)?;
    let session = invocation
        .core()?
        .sessions
        .get(&id)
        .map_err(|_| Failure::Unavailable("Session store unavailable".into()))?
        .ok_or_else(|| account_skills_invalid("session_not_found", "Session not found"))?;
    let query = v5::LocationQuery {
        location: request
            .query
            .location
            .map(|value| v5::LocationQueryLocation {
                directory: value.directory,
                workspace: value.workspace,
            }),
    };
    let location = invocation.location(query.location.as_ref())?;
    if session.location.directory != location.info.directory
        || session
            .location
            .workspace_id
            .as_ref()
            .map(|id| id.as_lossless())
            .filter(|id| !id.is_empty())
            != location
                .info
                .workspace_id
                .as_ref()
                .map(|id| id.as_lossless())
                .filter(|id| !id.is_empty())
    {
        return Err(account_skills_invalid(
            "cross_location_session",
            "Session does not belong to the requested location",
        ));
    }
    let agent = session.agent.ok_or_else(|| {
        account_skills_invalid("missing_session_agent", "Session has no configured agent")
    })?;
    if let Some(supplied) = &request.query.agent
        && convert::domain(supplied)? != agent
    {
        return Err(account_skills_invalid(
            "agent_mismatch",
            "Agent does not match session agent",
        ));
    }
    let production = location
        .production
        .as_ref()
        .ok_or_else(|| Failure::Unavailable("Production services unavailable".into()))?;
    let (location_info, integrations) = resolve(&invocation, &query)?;
    let reader = Reader::new(
        production.configuration.clone(),
        integrations.registry,
        location.permissions.clone(),
    )
    .map_err(|error| account_skills_invalid(error.kind(), &error.to_string()))?;
    let proof = reader
        .read(Input {
            session_id: session.id,
            agent,
            profile: request
                .query
                .profile
                .as_ref()
                .map(convert::domain)
                .transpose()?,
            id: request.query.id.as_ref().map(convert::domain).transpose()?,
        })
        .await
        .map_err(|error| account_skills_invalid(error.kind(), &error.to_string()))?;
    Ok(v5::IntegrationAccountSkillsReadResult {
        location: location_info,
        data: account_skills_proof(proof)?,
    })
}

fn account_skills_proof(
    proof: ycoding_core::resources::account_connectors::skills_read::Proof,
) -> Result<v5::IntegrationAccountSkillsProof, Failure> {
    Ok(v5::IntegrationAccountSkillsProof {
        status: i64::from(proof.status),
        keys: v5::IntegrationAccountSkillsProofKeys {
            items: proof.keys.iter().map(convert::wire).collect(),
        },
        count: Some(
            i64::try_from(proof.count)
                .map_err(|_| Failure::Invalid("Invalid account skills count".into()))?,
        ),
        has_next: Some(proof.has_next),
        pagination_keys: Some(v5::IntegrationAccountSkillsProofPaginationKeys {
            items: proof.pagination_keys.iter().map(convert::wire).collect(),
        }),
        detail: proof
            .detail
            .map(|detail| v5::IntegrationAccountSkillsProofDetail {
                status: i64::from(detail.status),
                keys: v5::IntegrationAccountSkillsProofDetailKeys {
                    items: detail.keys.iter().map(convert::wire).collect(),
                },
            }),
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

pub(crate) fn resolve(
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
        Error::ProviderRetired => Failure::InvalidRequest {
            message: error.to_string(),
            kind: "integration_authorization",
        },
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
    let integration = convert::domain(&request.params.integration_id)?;
    let key = convert::domain(&request.payload.key)?;
    match &request.payload.credential_id {
        Some(credential_id) => {
            services
                .registry
                .replace_key(
                    integration,
                    convert::domain(credential_id)?,
                    key,
                    ids::now_millis(),
                )
                .await
        }
        None => {
            services
                .registry
                .login_key(
                    integration,
                    request
                        .payload
                        .label
                        .as_ref()
                        .map(convert::domain)
                        .transpose()?,
                    key,
                    ids::now_millis(),
                )
                .await
        }
    }
    .map_err(authorization)?;
    invocation.core()?.locations.credentials_changed().await?;
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
    let integration_id = convert::domain(&request.params.integration_id)?;
    let method_id = convert::domain(&request.payload.method_id)?;
    let inputs = integration::Inputs(inputs);
    let attempt = match &request.payload.credential_id {
        Some(credential_id) => {
            services
                .registry
                .reconnect(
                    integration_id,
                    method_id,
                    inputs,
                    convert::domain(credential_id)?,
                    ids::now_millis(),
                )
                .await
        }
        None => {
            services
                .registry
                .connect(
                    integration_id,
                    method_id,
                    inputs,
                    request
                        .payload
                        .label
                        .as_ref()
                        .map(convert::domain)
                        .transpose()?,
                    ids::now_millis(),
                )
                .await
        }
    }
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
    invocation.core()?.locations.credentials_changed().await?;
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
