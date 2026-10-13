use crate::{
    catalog_convert, convert,
    dispatch::{Dispatcher, Failure, Invocation, RegistrationError},
    services::CatalogServices,
};
use ycoding_core::{
    resources::generate,
    ycoding_schema::{DomainDecode, location, model},
};
use ycoding_protocol::v5;

pub fn register(dispatcher: &mut Dispatcher) -> Result<(), RegistrationError> {
    dispatcher.handle("provider.get", provider_get)?;
    dispatcher.handle("provider.integrations", provider_integrations)?;
    dispatcher.handle("provider.list", provider_list)?;
    dispatcher.handle("provider.refresh", provider_refresh)?;
    dispatcher.handle("model.default", model_default)?;
    dispatcher.handle("model.list", model_list)?;
    dispatcher.handle("agent.list", agent_list)?;
    dispatcher.handle("command.list", command_list)?;
    dispatcher.handle("config.diagnostics", diagnostics)?;
    dispatcher.handle("plugin.list", plugin_list)?;
    dispatcher.handle("reference.list", reference_list)?;
    dispatcher.handle("skill.list", skill_list)?;
    dispatcher.handle("generate.text", generate_text)?;
    Ok(())
}

fn services(
    invocation: &Invocation,
    query: &v5::LocationQuery,
) -> Result<(location::Info, CatalogServices), Failure> {
    let location = invocation.location(query.location.as_ref())?.info.clone();
    let resolver =
        invocation.core()?.catalogs.as_ref().ok_or_else(|| {
            Failure::Unavailable("Location catalog services are not ready".into())
        })?;
    let services = resolver(&location)
        .map_err(|_| Failure::Unavailable("Location catalog services are unavailable".into()))?;
    let scope = ycoding_core::ycoding_schema::location::Ref {
        directory: location.directory.clone(),
        workspace_id: location.workspace_id.clone(),
    };
    let feed = invocation.core()?.events.clone();
    services
        .models
        .catalog()
        .event_source
        .bind(feed.clone(), Some(scope.clone()))
        .map_err(Failure::Unavailable)?;
    services
        .agents
        .event_source
        .bind(feed.clone(), Some(scope.clone()))
        .map_err(Failure::Unavailable)?;
    services
        .commands
        .event_source
        .bind(feed.clone(), Some(scope.clone()))
        .map_err(Failure::Unavailable)?;
    services
        .references
        .event_source
        .bind(feed, Some(scope))
        .map_err(Failure::Unavailable)?;
    if !std::sync::Arc::ptr_eq(&services.models, &services.generate.models) {
        return Err(Failure::Unavailable(
            "Location catalog and generation model services disagree".into(),
        ));
    }
    Ok((location, services))
}

async fn ready(
    services: &CatalogServices,
    service: &'static str,
    message: &'static str,
) -> Result<(), Failure> {
    tokio::time::timeout(std::time::Duration::from_secs(5), (services.ready)())
        .await
        .map_err(|_| Failure::ServiceUnavailable {
            service,
            message: message.into(),
        })?
        .map_err(|_| Failure::ServiceUnavailable {
            service,
            message: "Catalog initialization failed".into(),
        })
}

async fn provider_get(
    invocation: Invocation,
    request: v5::ProviderGetRequest,
) -> Result<v5::ProviderGetResult, Failure> {
    let (location, services) = services(&invocation, &request.query)?;
    let id = convert::identifier(&request.params.provider_id)?;
    let provider = services
        .models
        .catalog()
        .provider(&id)
        .ok_or_else(|| Failure::ProviderNotFound(id.0.clone()))?;
    Ok(v5::ProviderGetResult {
        location: convert::location_info(&location),
        data: catalog_convert::provider(provider)?,
    })
}

async fn provider_integrations(
    invocation: Invocation,
    request: v5::ProviderIntegrationsRequest,
) -> Result<v5::ProviderIntegrationsResult, Failure> {
    let (location, catalogs) = services(&invocation, &request.query)?;
    ready(
        &catalogs,
        "provider.integrations",
        "Provider integrations initialization timed out",
    )
    .await?;
    let (_, services) = services(&invocation, &request.query)?;
    Ok(v5::ProviderIntegrationsResult {
        location: convert::location_info(&location),
        data: v5::ProviderIntegrationsResultData {
            items: services
                .models
                .catalog()
                .integrations()
                .iter()
                .map(|item| v5::ProviderIntegrationRef {
                    provider_id: convert::wire(&item.provider_id.0),
                    integration_id: convert::wire(item.integration_id.as_lossless()),
                })
                .collect(),
        },
    })
}

async fn provider_list(
    invocation: Invocation,
    request: v5::ProviderListRequest,
) -> Result<v5::ProviderListResult, Failure> {
    let (location, services) = services(&invocation, &request.query)?;
    let saved = invocation
        .core()?
        .credentials
        .all()
        .map_err(|_| Failure::Unavailable("Catalog credentials unavailable".into()))?;
    Ok(v5::ProviderListResult {
        location: convert::location_info(&location),
        data: v5::ProviderListResultData {
            items: services
                .models
                .catalog()
                .available_providers(&saved)
                .into_iter()
                .map(catalog_convert::provider)
                .collect::<Result<_, _>>()?,
        },
    })
}

async fn provider_refresh(
    invocation: Invocation,
    request: v5::ProviderRefreshRequest,
) -> Result<v5::ProviderRefreshResult, Failure> {
    let (_, services) = services(&invocation, &request.query)?;
    (services.refresh)()
        .await
        .map_err(|_| Failure::ServiceUnavailable {
            service: "provider.refresh",
            message: "Catalog refresh failed".into(),
        })?;
    Ok(v5::ProviderRefreshResult { data: v5::Empty {} })
}

async fn model_list(
    invocation: Invocation,
    request: v5::ModelListRequest,
) -> Result<v5::ModelListResult, Failure> {
    let (location, services) = services(&invocation, &request.query)?;
    let saved = invocation
        .core()?
        .credentials
        .all()
        .map_err(|_| Failure::Unavailable("Catalog credentials unavailable".into()))?;
    Ok(v5::ModelListResult {
        location: convert::location_info(&location),
        data: v5::ModelListResultData {
            items: services
                .models
                .catalog()
                .available(&saved)
                .iter()
                .map(catalog_convert::model)
                .collect::<Result<_, _>>()?,
        },
    })
}

async fn model_default(
    invocation: Invocation,
    request: v5::ModelDefaultRequest,
) -> Result<v5::ModelDefaultResult, Failure> {
    let (location, catalogs) = services(&invocation, &request.query)?;
    ready(
        &catalogs,
        "model.catalog",
        "Model catalog initialization timed out",
    )
    .await?;
    let (_, catalogs) = services(&invocation, &request.query)?;
    let saved = invocation
        .core()?
        .credentials
        .all()
        .map_err(|_| Failure::Unavailable("Catalog credentials unavailable".into()))?;
    let selected = catalogs
        .models
        .catalog()
        .default_model(&saved)
        .map(|info| {
            let selection = catalogs
                .models
                .catalog()
                .default_selection(&saved)
                .unwrap_or(model::Ref {
                    id: info.id.clone(),
                    provider_id: info.provider_id.clone(),
                    profile: None,
                    variant: None,
                });
            catalog_convert::model_default(&info, &selection)
        })
        .transpose()?;
    Ok(v5::ModelDefaultResult {
        location: convert::location_info(&location),
        data: v5::ModelDefaultResultData {
            kind: Some(selected.map_or(
                v5::model_default_result_data::Kind::None(v5::Empty {}),
                v5::model_default_result_data::Kind::Value1,
            )),
        },
    })
}

async fn agent_list(
    invocation: Invocation,
    request: v5::AgentListRequest,
) -> Result<v5::AgentListResult, Failure> {
    let (location, services) = services(&invocation, &request.query)?;
    Ok(v5::AgentListResult {
        location: convert::location_info(&location),
        data: v5::AgentListResultData {
            items: services
                .agents
                .list()
                .into_iter()
                .map(catalog_convert::agent)
                .collect::<Result<_, _>>()?,
        },
    })
}

async fn command_list(
    invocation: Invocation,
    request: v5::CommandListRequest,
) -> Result<v5::CommandListResult, Failure> {
    let (location, services) = services(&invocation, &request.query)?;
    Ok(v5::CommandListResult {
        location: convert::location_info(&location),
        data: v5::CommandListResultData {
            items: services
                .commands
                .list()
                .iter()
                .map(catalog_convert::command)
                .collect::<Result<_, _>>()?,
        },
    })
}

async fn diagnostics(
    invocation: Invocation,
    request: v5::ConfigDiagnosticsRequest,
) -> Result<v5::ConfigDiagnosticsResult, Failure> {
    let (location, services) = services(&invocation, &request.query)?;
    Ok(v5::ConfigDiagnosticsResult {
        location: convert::location_info(&location),
        data: v5::ConfigDiagnosticsResultData {
            items: services
                .diagnostics
                .iter()
                .map(catalog_convert::diagnostic)
                .collect::<Result<_, _>>()?,
        },
    })
}

async fn plugin_list(
    invocation: Invocation,
    request: v5::PluginListRequest,
) -> Result<v5::PluginListResult, Failure> {
    let (location, services) = services(&invocation, &request.query)?;
    Ok(v5::PluginListResult {
        location: convert::location_info(&location),
        data: v5::PluginListResultData {
            items: services
                .plugins
                .iter()
                .map(|plugin| v5::PluginInfo {
                    id: convert::wire(&plugin.id),
                })
                .collect(),
        },
    })
}

async fn reference_list(
    invocation: Invocation,
    request: v5::ReferenceListRequest,
) -> Result<v5::ReferenceListResult, Failure> {
    let (location, services) = services(&invocation, &request.query)?;
    Ok(v5::ReferenceListResult {
        location: convert::location_info(&location),
        data: v5::ReferenceListResultData {
            items: services
                .references
                .list()
                .iter()
                .map(catalog_convert::reference)
                .collect::<Result<_, _>>()?,
        },
    })
}

async fn skill_list(
    invocation: Invocation,
    request: v5::SkillListRequest,
) -> Result<v5::SkillListResult, Failure> {
    let (location, services) = services(&invocation, &request.query)?;
    let mut service = services.skills.lock().await;
    service
        .event_source
        .bind(
            invocation.core()?.events.clone(),
            Some(location::Ref {
                directory: location.directory.clone(),
                workspace_id: location.workspace_id.clone(),
            }),
        )
        .map_err(Failure::Unavailable)?;
    let skills = service
        .list()
        .await
        .map_err(|_| Failure::Unavailable("Skill catalog unavailable".into()))?;
    Ok(v5::SkillListResult {
        location: convert::location_info(&location),
        data: v5::SkillListResultData {
            items: skills
                .iter()
                .map(catalog_convert::skill)
                .collect::<Result<_, _>>()?,
        },
    })
}

async fn generate_text(
    invocation: Invocation,
    request: v5::GenerateTextRequest,
) -> Result<v5::GenerateTextResult, Failure> {
    let (_, services) = services(&invocation, &request.query)?;
    let model = request
        .payload
        .model
        .as_ref()
        .map(|reference| {
            model::Ref::decode(
                &ycoding_core::ycoding_schema::ObjectEncoder::new()
                    .field("providerID", &convert::domain(&reference.provider_id)?)
                    .field("id", &convert::domain(&reference.id)?)
                    .optional(
                        "profile",
                        &reference
                            .profile
                            .as_ref()
                            .map(convert::domain)
                            .transpose()?,
                    )
                    .optional(
                        "variant",
                        &reference
                            .variant
                            .as_ref()
                            .map(convert::domain)
                            .transpose()?,
                    )
                    .finish(),
            )
            .map_err(|_| Failure::Invalid("Invalid model reference".into()))
        })
        .transpose()?;
    let text = services
        .generate
        .text(generate::Input {
            prompt: convert::domain(&request.payload.prompt)?,
            model,
        })
        .await
        .map_err(|error| match error {
            generate::Error::Selection(message) => Failure::Invalid(message),
            generate::Error::Unavailable { message, service } => {
                Failure::GenerationUnavailable { message, service }
            }
        })?;
    Ok(v5::GenerateTextResult {
        data: v5::GenerateTextResponse {
            data: v5::GenerateTextResponseData {
                text: convert::wire(&text),
            },
        },
    })
}
