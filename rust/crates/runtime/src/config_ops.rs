use crate::{
    convert,
    dispatch::{Dispatcher, Failure, Invocation, RegistrationError},
    mcp_convert, platform_services,
    services::{CatalogServices, PlatformServices},
};
use std::{path::PathBuf, sync::Arc};
use ycoding_core::{
    resources::model,
    resources::{config, frontend_package},
    ycoding_schema::provider,
};
use ycoding_protocol::v5;

pub fn register(dispatcher: &mut Dispatcher) -> Result<(), RegistrationError> {
    dispatcher.handle("provider.configure", configure_provider)?;
    dispatcher.handle("frontendPackage.resolve", resolve_package)?;
    Ok(())
}

fn resolve(
    invocation: &Invocation,
    query: &v5::LocationQuery,
) -> Result<
    (
        ycoding_core::ycoding_schema::location::Info,
        Arc<PlatformServices>,
    ),
    Failure,
> {
    if invocation.remote {
        return Err(Failure::Unauthorized(
            "Configuration operations require a local client".into(),
        ));
    }
    platform_services::resolve(
        invocation,
        query
            .location
            .as_ref()
            .and_then(|location| location.directory.as_ref()),
        query
            .location
            .as_ref()
            .and_then(|location| location.workspace.as_ref()),
    )
}

fn scope(scope: i32) -> Result<config::Scope, Failure> {
    match scope {
        1 => Ok(config::Scope::Global),
        2 => Ok(config::Scope::Project),
        _ => Err(Failure::ConfigurationWrite(
            config::WriteError::InvalidConfig,
        )),
    }
}

fn api(api: i32) -> Result<config::EndpointApi, Failure> {
    match api {
        1 => Ok(config::EndpointApi::Chat),
        2 => Ok(config::EndpointApi::Responses),
        _ => Err(Failure::ConfigurationWrite(
            config::WriteError::InvalidConfig,
        )),
    }
}

fn endpoint(
    payload: &v5::ProviderConfigureRequestPayload,
) -> Result<config::ProviderConfiguration, Failure> {
    let invalid = || Failure::ConfigurationWrite(config::WriteError::InvalidConfig);
    let endpoint = match payload.endpoint.kind.as_ref() {
        Some(v5::provider_endpoint::Kind::Openai(endpoint)) => config::Endpoint::OpenAi {
            base_url: convert::domain(&endpoint.base_url)?
                .to_utf8()
                .map_err(|_| invalid())?,
            api: api(endpoint.api)?,
        },
        Some(v5::provider_endpoint::Kind::Runpod(endpoint)) => config::Endpoint::Runpod {
            base_url: convert::domain(&endpoint.base_url)?
                .to_utf8()
                .map_err(|_| invalid())?,
            worker: match endpoint.worker {
                1 => config::EndpointWorker::Ollama,
                2 => config::EndpointWorker::Vllm,
                _ => return Err(invalid()),
            },
        },
        None => return Err(invalid()),
    };
    if payload.catalog.is_some_and(|catalog| catalog != 1) {
        return Err(invalid());
    }
    Ok(config::ProviderConfiguration {
        provider_id: convert::domain(&payload.provider_id)?,
        endpoint,
        catalog: payload.catalog.is_some(),
        models: payload
            .models
            .as_ref()
            .map(|models| {
                models
                    .items
                    .iter()
                    .map(|model| {
                        Ok(config::EndpointModel {
                            id: convert::domain(&model.id)?,
                            model_id: model.model_id.as_ref().map(convert::domain).transpose()?,
                            name: model.name.as_ref().map(convert::domain).transpose()?,
                            family: model.family.as_ref().map(convert::domain).transpose()?,
                            api: model.api.map(api).transpose()?,
                            disabled: model.disabled,
                            tools: model.tools,
                        })
                    })
                    .collect::<Result<Vec<_>, Failure>>()
            })
            .transpose()?,
    })
}

fn catalogs(
    invocation: &Invocation,
    location: &ycoding_core::ycoding_schema::location::Info,
) -> Result<CatalogServices, Failure> {
    invocation
        .core()?
        .catalogs
        .as_ref()
        .ok_or_else(|| Failure::Unavailable("Configuration reload is not composed".into()))?(
        location,
    )
    .map_err(|_| Failure::Unavailable("Configuration reload unavailable".into()))
}

pub(crate) fn target(target: &config::Target) -> v5::ConfigurationTarget {
    v5::ConfigurationTarget {
        scope: match target.scope {
            config::Scope::Global => 1,
            config::Scope::Project => 2,
        },
        path: convert::text(&target.path.to_string_lossy()),
    }
}

async fn configure_provider(
    invocation: Invocation,
    request: v5::ProviderConfigureRequest,
) -> Result<v5::ProviderConfigureResult, Failure> {
    let (location, platform) = resolve(&invocation, &request.query)?;
    let scope = scope(request.payload.scope)?;
    let input = endpoint(&request.payload)?;
    input.validate().map_err(Failure::ConfigurationWrite)?;
    let before = catalogs(&invocation, &location)?;
    if let Some(existing) = before
        .models
        .catalog()
        .provider(&provider::Id(input.provider_id.clone()))
        && !existing.package.is_empty()
        && model::family(&existing.package).ok()
            != Some(input.family().map_err(Failure::ConfigurationWrite)?)
    {
        return Err(Failure::ConfigurationWrite(
            config::WriteError::ProviderCollision,
        ));
    }
    let configuration = platform.config.clone();
    let id = input.provider_id.clone();
    let written = tokio::task::spawn_blocking(move || configuration.write_provider(scope, &input))
        .await
        .map_err(|_| Failure::Unavailable("Configuration writer failed".into()))?
        .map_err(Failure::ConfigurationWrite)?;
    if (before.refresh)().await.is_err() {
        return Err(Failure::ConfigurationPartial {
            target: written,
            registration: false,
        });
    }
    let registered = (|| {
        let after = catalogs(&invocation, &location)?;
        let integrations =
            invocation.core()?.integrations.as_ref().ok_or_else(|| {
                Failure::Unavailable("Integration registration unavailable".into())
            })?(&location)
            .map_err(|_| Failure::Unavailable("Integration registration failed".into()))?;
        let catalog = after.models.catalog();
        let registered_provider = catalog
            .provider(&provider::Id(id.clone()))
            .ok_or_else(|| Failure::Unavailable("Provider did not register".into()))?;
        integrations
            .registry
            .get(
                registered_provider
                    .integration_id
                    .as_ref()
                    .map_or(&id, |integration| integration.as_lossless()),
            )
            .map_err(|_| Failure::Unavailable("Integration registration failed".into()))?
            .ok_or_else(|| Failure::Unavailable("Integration did not register".into()))?;
        Ok::<_, Failure>(())
    })();
    if registered.is_err() {
        return Err(Failure::ConfigurationPartial {
            target: written,
            registration: true,
        });
    }
    Ok(v5::ProviderConfigureResult {
        data: v5::ProviderConfigureResultData {
            provider_id: convert::wire(&id),
            target: target(&written),
            registered: true,
        },
    })
}

pub(crate) async fn configure_mcp(
    invocation: Invocation,
    request: v5::McpConfigureRequest,
) -> Result<v5::McpConfigureResult, Failure> {
    let (location, platform) = resolve(&invocation, &request.query)?;
    let scope = scope(request.payload.scope)?;
    let before = catalogs(&invocation, &location)?;
    let input = mcp_convert::config(&request.payload.config)
        .map_err(|_| Failure::ConfigurationWrite(config::WriteError::InvalidConfig))?;
    let name = convert::domain(&request.payload.name)?;
    let owned_name = name.clone();
    let configuration = platform.config.clone();
    let written =
        tokio::task::spawn_blocking(move || configuration.write_mcp(scope, &owned_name, &input))
            .await
            .map_err(|_| Failure::Unavailable("Configuration writer failed".into()))?
            .map_err(Failure::ConfigurationWrite)?;
    if (before.refresh)().await.is_err() {
        return Err(Failure::ConfigurationPartial {
            target: written,
            registration: false,
        });
    }
    Ok(v5::McpConfigureResult {
        data: v5::McpConfigureResultData {
            name: convert::wire(&name),
            target: target(&written),
            reloaded: true,
        },
    })
}

async fn resolve_package(
    invocation: Invocation,
    request: v5::FrontendPackageResolveRequest,
) -> Result<v5::FrontendPackageResolveResult, Failure> {
    let (_, platform) = resolve(&invocation, &request.query)?;
    let spec = convert::domain(&request.payload.spec)?
        .to_utf8()
        .map_err(|_| Failure::FrontendPackage(frontend_package::Error::InvalidPackage))?;
    let configuration = platform.config.clone();
    let service = frontend_package::Service::new(
        configuration.roots().cache.clone(),
        PathBuf::from("npm"),
        Default::default(),
        Arc::new(move |spec| {
            configuration.allows_mutation(config::Mutation::FrontendPackage(spec))
        }),
    );
    let resolved = service
        .resolve(&spec)
        .await
        .map_err(Failure::FrontendPackage)?;
    Ok(v5::FrontendPackageResolveResult {
        data: v5::FrontendPackageDescriptor {
            name: convert::text(&resolved.name),
            version: convert::text(&resolved.version),
            digest: convert::text(&resolved.digest),
            root: convert::text(&resolved.root.to_string_lossy()),
            entrypoint: v5::FrontendPackageAsset {
                path: convert::text(&resolved.entrypoint.path),
                digest: convert::text(&resolved.entrypoint.digest),
            },
            assets: None,
        },
    })
}
