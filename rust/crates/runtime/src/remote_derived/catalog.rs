use super::target;
use crate::{
    convert,
    dispatch::{Failure, Invocation},
    services::CatalogServices,
};
use ycoding_core::ycoding_schema::DomainEncode;
use ycoding_protocol::v5;

pub async fn services(
    invocation: &Invocation,
    location: &ycoding_core::ycoding_schema::location::Info,
) -> Result<CatalogServices, Failure> {
    let resolver = invocation
        .core()?
        .catalogs
        .as_ref()
        .ok_or_else(|| target::error(10, "Location catalog services are not composed"))?;
    let services =
        resolver(location).map_err(|_| target::error(10, "Location catalog unavailable"))?;
    tokio::time::timeout(std::time::Duration::from_secs(5), (services.ready)())
        .await
        .map_err(|_| target::error(10, "Catalog initialization timed out"))?
        .map_err(|_| target::error(10, "Catalog initialization failed"))?;
    let services =
        resolver(location).map_err(|_| target::error(10, "Location catalog unavailable"))?;
    if !std::sync::Arc::ptr_eq(&services.models, &services.generate.models) {
        return Err(target::error(10, "Location model services disagree"));
    }
    Ok(services)
}

pub async fn get(
    invocation: Invocation,
    _: v5::CatalogGetRequest,
) -> Result<v5::CatalogGetResult, Failure> {
    let location = target::scoped(&invocation)?;
    let services = services(&invocation, &location.info).await?;
    let saved = invocation
        .core()?
        .credentials
        .all()
        .map_err(|_| target::error(10, "Catalog credentials unavailable"))?;
    let skills = services
        .skills
        .lock()
        .await
        .list()
        .await
        .map_err(|_| target::error(10, "Skill catalog unavailable"))?;
    let mcp = invocation
        .core()?
        .mcp
        .as_ref()
        .ok_or_else(|| target::error(10, "Location MCP services are not composed"))?(
        &location.info,
    )
    .map_err(|_| target::error(10, "MCP catalog unavailable"))?;
    let resources = mcp
        .resource_catalog_typed()
        .await
        .map_err(|_| target::error(10, "MCP catalog unavailable"))?
        .resources;
    let agents = services.agents.list();
    let commands = services.commands.list();
    let references = services.references.list();
    if [
        (agents.len(), 100),
        (commands.len(), 200),
        (skills.len(), 200),
        (references.len(), 200),
        (resources.len(), 200),
    ]
    .iter()
    .any(|(count, limit)| count > limit)
    {
        return Err(target::error(2, "Catalog exceeds the bounded list size"));
    }
    let catalog = services.models.catalog();
    let providers = catalog
        .available_providers(&saved)
        .into_iter()
        .filter(|provider| provider.disabled != Some(true))
        .collect::<Vec<_>>();
    let models = catalog
        .available(&saved)
        .into_iter()
        .filter_map(|model| {
            let provider = providers
                .iter()
                .find(|provider| provider.id == model.provider_id)?;
            if !model.enabled
                && model
                    .profiles
                    .as_ref()
                    .is_none_or(|profiles| profiles.is_empty())
            {
                return None;
            }
            Some(v5::ConnectorCatalogModelsItem {
                provider_id: convert::wire(&model.provider_id.0),
                provider_name: Some(convert::wire(&provider.name)),
                id: convert::wire(&model.id),
                name: convert::wire(&model.name),
                variants: v5::ConnectorCatalogModelsItemVariants {
                    items: model
                        .variants
                        .iter()
                        .map(|variant| convert::wire(&variant.id))
                        .collect(),
                },
                enabled: (!model.enabled).then_some(false),
                profiles: model.profiles.as_ref().map(|profiles| {
                    v5::ConnectorCatalogModelsItemProfiles {
                        items: profiles
                            .iter()
                            .map(|profile| v5::ConnectorCatalogModelsItemProfilesItem {
                                name: convert::wire(&profile.name.0),
                                active: profile.active,
                                variants: profile.variants.as_ref().map(|variants| {
                                    v5::ConnectorCatalogModelsItemProfilesItemVariants {
                                        items: variants.iter().map(convert::wire).collect(),
                                    }
                                }),
                            })
                            .collect(),
                    }
                }),
            })
        })
        .collect();
    let agents = agents
        .iter()
        .map(|agent| {
            Ok(v5::ConnectorCatalogAgentsItem {
                id: convert::wire(&agent.id),
                name: convert::wire(&agent.name),
                description: agent.description.as_ref().map(convert::wire),
                mode: match agent.mode.as_str() {
                    Some("primary") => 1,
                    Some("subagent") => 2,
                    Some("all") => 3,
                    _ => return Err(target::error(10, "Agent mode is unrepresentable")),
                },
                hidden: agent.hidden,
                model: agent
                    .model
                    .as_ref()
                    .map(|model| {
                        convert::model_ref(&model.encode())
                            .map_err(|_| target::error(10, "Agent selection is unrepresentable"))
                    })
                    .transpose()?,
            })
        })
        .collect::<Result<_, Failure>>()?;
    let references = references
        .iter()
        .filter(|reference| reference.hidden != Some(true))
        .map(|reference| {
            Ok(v5::ConnectorCatalogReferencesItem {
                name: convert::wire(&reference.name),
                uri: convert::text(
                    url::Url::from_file_path(convert::readable(reference.path.as_lossless()))
                        .map_err(|_| target::error(10, "Reference path is unrepresentable"))?
                        .as_str(),
                ),
                description: reference.description.as_ref().map(convert::wire),
            })
        })
        .collect::<Result<_, Failure>>()?;
    Ok(v5::CatalogGetResult {
        data: v5::ConnectorCatalog {
            agents: v5::ConnectorCatalogAgents { items: agents },
            models: v5::ConnectorCatalogModels { items: models },
            default_model: services
                .models
                .catalog()
                .default_selection(&saved)
                .map(|selection| {
                    convert::model_ref(&selection.encode())
                        .map_err(|_| target::error(10, "Default selection is unrepresentable"))
                })
                .transpose()?,
            commands: v5::ConnectorCatalogCommands {
                items: commands
                    .iter()
                    .map(|command| v5::ConnectorCatalogCommandsItem {
                        name: convert::wire(&command.name),
                        description: command.description.as_ref().map(convert::wire),
                    })
                    .collect(),
            },
            skills: v5::ConnectorCatalogSkills {
                items: skills
                    .iter()
                    .map(|skill| v5::ConnectorCatalogSkillsItem {
                        id: convert::wire(&skill.id),
                        name: convert::wire(&skill.name),
                        description: skill.description.as_ref().map(convert::wire),
                        slash: skill.slash.unwrap_or(false),
                    })
                    .collect(),
            },
            references: v5::ConnectorCatalogReferences { items: references },
            resources: v5::ConnectorCatalogResources {
                items: resources
                    .iter()
                    .map(|resource| v5::ConnectorCatalogResourcesItem {
                        name: convert::wire(&resource.name),
                        uri: convert::wire(&resource.uri),
                        description: resource.description.as_ref().map(convert::wire),
                    })
                    .collect(),
            },
        },
    })
}
