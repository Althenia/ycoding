use crate::{convert, dispatch::Failure};
use prost::Message;
use ycoding_core::ycoding_schema::{
    DomainEncode, JsonObject, JsonValue, LosslessString, agent, command, config, model, provider,
    reference, skill,
};
use ycoding_protocol::v5;

fn choice(value: &LosslessString, values: &[&str]) -> Result<i32, Failure> {
    values
        .iter()
        .position(|item| value == &LosslessString::from(*item))
        .map(|index| index as i32 + 1)
        .ok_or_else(|| Failure::Unavailable("Catalog value is not representable".into()))
}

fn public(value: &JsonValue) -> JsonValue {
    match value {
        JsonValue::Object(object) => {
            let mut result = JsonObject::new();
            for (key, value) in object.iter() {
                if sensitive(key) {
                    continue;
                }
                result.insert(key.clone(), public(value));
            }
            JsonValue::Object(result)
        }
        JsonValue::Array(items) => JsonValue::Array(items.iter().map(public).collect()),
        value => value.clone(),
    }
}

fn sensitive(key: &LosslessString) -> bool {
    let key = convert::readable(key)
        .to_ascii_lowercase()
        .replace(['-', '_'], "");
    [
        "apikey",
        "authtoken",
        "accesstoken",
        "refreshtoken",
        "access",
        "refresh",
        "authorization",
        "proxyauthorization",
        "cookie",
        "setcookie",
        "credentialid",
        "claudecodesource",
        "email",
        "accountemail",
        "password",
        "secret",
        "token",
    ]
    .contains(&key.as_str())
        || [
            "apikey",
            "token",
            "cookie",
            "credentialid",
            "claudecodesource",
        ]
        .iter()
        .any(|suffix| key.ends_with(suffix))
}

macro_rules! values {
    ($source:expr, $wrapper:ident, $entry:ident) => {
        v5::$wrapper {
            entries: $source
                .iter()
                .filter(|(key, _)| !sensitive(key))
                .map(|(key, value)| v5::$entry {
                    key: convert::wire(key),
                    value: convert::json_to_value(&public(value)),
                })
                .collect(),
        }
    };
}

macro_rules! headers {
    ($source:expr, $wrapper:ident, $entry:ident) => {
        v5::$wrapper {
            entries: $source
                .iter()
                .filter(|(key, _)| !sensitive(key))
                .map(|(key, value)| {
                    let JsonValue::String(value) = value else {
                        return Err(Failure::Unavailable(
                            "Catalog header is not representable".into(),
                        ));
                    };
                    Ok(v5::$entry {
                        key: convert::wire(key),
                        value: convert::wire(value),
                    })
                })
                .collect::<Result<_, Failure>>()?,
        }
    };
}

pub fn provider(info: &provider::Info) -> Result<v5::ProviderInfo, Failure> {
    Ok(v5::ProviderInfo {
        id: convert::wire(&info.id.0),
        integration_id: info
            .integration_id
            .as_ref()
            .map(|id| convert::wire(id.as_lossless())),
        name: convert::wire(&info.name),
        disabled: info.disabled,
        package: convert::wire(&info.package),
        settings: info
            .overlays
            .settings
            .as_ref()
            .map(|settings| values!(settings.0, ProviderInfoSettings, ProviderInfoSettingsEntry)),
        headers: info
            .overlays
            .headers
            .as_ref()
            .map(|source| {
                Ok(headers!(
                    source,
                    ProviderInfoHeaders,
                    ProviderInfoHeadersEntry
                ))
            })
            .transpose()?,
        body: info
            .overlays
            .body
            .as_ref()
            .map(|body| values!(body.0, ProviderInfoBody, ProviderInfoBodyEntry)),
    })
}

pub fn agent(info: &agent::Info) -> Result<v5::AgentInfo, Failure> {
    Ok(v5::AgentInfo {
        id: convert::wire(&info.id),
        name: convert::wire(&info.name),
        model: info
            .model
            .as_ref()
            .map(|model| {
                convert::model_ref(&model.encode())
                    .map_err(|_| Failure::Unavailable("Agent model is not representable".into()))
            })
            .transpose()?,
        request: v5::ProviderRequest {
            settings: values!(
                info.request.settings.0,
                ProviderSettings,
                ProviderSettingsEntry
            ),
            headers: headers!(
                info.request.headers,
                ProviderRequestHeaders,
                ProviderRequestHeadersEntry
            ),
            body: values!(
                info.request.body.0,
                ProviderRequestBody,
                ProviderRequestBodyEntry
            ),
        },
        system: info.system.as_ref().map(convert::wire),
        description: info.description.as_ref().map(convert::wire),
        mode: choice(&info.mode, &["subagent", "primary", "all"])?,
        hidden: info.hidden,
        color: info
            .color
            .as_ref()
            .map(|color| {
                Ok(v5::AgentColor {
                    kind: Some(
                        if color.0.as_str().is_some_and(|color| color.starts_with('#')) {
                            v5::agent_color::Kind::Value1(convert::wire(&color.0))
                        } else {
                            v5::agent_color::Kind::Value2(choice(
                                &color.0,
                                &[
                                    "primary",
                                    "secondary",
                                    "accent",
                                    "success",
                                    "warning",
                                    "error",
                                    "info",
                                ],
                            )?)
                        },
                    ),
                })
            })
            .transpose()?,
        steps: info.steps.map(|steps| steps.get() as u64),
        locations: info
            .locations
            .as_ref()
            .map(|locations| v5::AgentInfoLocations {
                items: locations
                    .iter()
                    .map(|path| convert::wire(path.as_lossless()))
                    .collect(),
            }),
        permissions: v5::PermissionRuleset {
            items: info
                .permissions
                .iter()
                .map(|rule| {
                    Ok(v5::PermissionRule {
                        action: convert::wire(&rule.action),
                        resource: convert::wire(&rule.resource),
                        effect: choice(&rule.effect.0, &["allow", "deny", "ask"])?,
                    })
                })
                .collect::<Result<_, Failure>>()?,
        },
    })
}

pub fn command(info: &command::Info) -> Result<v5::CommandInfo, Failure> {
    Ok(v5::CommandInfo {
        name: convert::wire(&info.name),
        template: convert::wire(&info.template),
        description: info.description.as_ref().map(convert::wire),
        agent: info.agent.as_ref().map(convert::wire),
        model: info
            .model
            .as_ref()
            .map(|model| {
                convert::model_ref(&model.encode())
                    .map_err(|_| Failure::Unavailable("Command model is not representable".into()))
            })
            .transpose()?,
        subtask: info.subtask,
        locations: info
            .locations
            .as_ref()
            .map(|locations| v5::CommandInfoLocations {
                items: locations
                    .iter()
                    .map(|path| convert::wire(path.as_lossless()))
                    .collect(),
            }),
    })
}

pub fn diagnostic(info: &config::Diagnostic) -> Result<v5::ConfigDiagnostic, Failure> {
    Ok(v5::ConfigDiagnostic {
        path: convert::wire(&info.path),
        reason: choice(
            &info.reason.0,
            &["invalid-json", "invalid-values", "removed-keys"],
        )?,
        json_path: info.json_path.as_ref().map(convert::wire),
        fail_closed: info.fail_closed,
        message: convert::wire(&info.message),
    })
}

pub fn reference(info: &reference::Info) -> Result<v5::ReferenceInfo, Failure> {
    Ok(v5::ReferenceInfo {
        name: convert::wire(&info.name),
        path: convert::wire(info.path.as_lossless()),
        description: info.description.as_ref().map(convert::wire),
        hidden: info.hidden,
        source: v5::ReferenceSource {
            kind: Some(match &info.source {
                reference::Source::Local(source) => {
                    v5::reference_source::Kind::Value1(v5::ReferenceLocalSource {
                        r#type: 1,
                        path: convert::wire(source.path.as_lossless()),
                        description: source.description.as_ref().map(convert::wire),
                        hidden: source.hidden,
                    })
                }
                reference::Source::Git(source) => {
                    v5::reference_source::Kind::Value2(v5::ReferenceGitSource {
                        r#type: 1,
                        repository: convert::wire(&source.repository),
                        branch: source.branch.as_ref().map(convert::wire),
                        description: source.description.as_ref().map(convert::wire),
                        hidden: source.hidden,
                    })
                }
            }),
        },
    })
}

pub fn skill(
    info: &skill::Info,
    scope: Option<ycoding_core::resources::skill::Scope>,
) -> Result<v5::SkillInfo, Failure> {
    Ok(v5::SkillInfo {
        id: convert::wire(&info.id),
        name: convert::wire(&info.name),
        description: info.description.as_ref().map(convert::wire),
        slash: info.slash,
        autoinvoke: info.autoinvoke,
        conflicts: info
            .conflicts
            .as_ref()
            .map(|conflicts| {
                Ok(v5::SkillConflicts {
                    skills: v5::SkillConflictsSkills {
                        items: conflicts.skills.iter().map(convert::wire).collect(),
                    },
                    instructions: v5::SkillConflictsInstructions {
                        items: conflicts
                            .instructions
                            .iter()
                            .map(convert::identity)
                            .collect::<Result<_, Failure>>()?,
                    },
                })
            })
            .transpose()?,
        location: convert::wire(info.location.as_lossless()),
        content: convert::wire(&info.content),
        scope: scope.map(|scope| match scope {
            ycoding_core::resources::skill::Scope::Global => {
                v5::ConfigurationScope::ConfigurationscopeGlobal as i32
            }
            ycoding_core::resources::skill::Scope::Project => {
                v5::ConfigurationScope::ConfigurationscopeProject as i32
            }
        }),
    })
}

pub fn model(info: &model::Info) -> Result<v5::ModelInfo, Failure> {
    Ok(v5::ModelInfo {
        id: convert::wire(&info.id),
        model_id: convert::wire(&info.model_id),
        provider_id: convert::wire(&info.provider_id.0),
        family: info.family.as_ref().map(convert::wire),
        name: convert::wire(&info.name),
        package: info.package.as_ref().map(convert::wire),
        settings: info
            .settings
            .as_ref()
            .map(|settings| values!(settings.0, ModelInfoSettings, ModelInfoSettingsEntry)),
        headers: info
            .headers
            .as_ref()
            .map(|source| Ok(headers!(source, ModelInfoHeaders, ModelInfoHeadersEntry)))
            .transpose()?,
        body: info
            .body
            .as_ref()
            .map(|body| values!(body.0, ModelInfoBody, ModelInfoBodyEntry)),
        capabilities: v5::ModelCapabilities {
            tools: info.capabilities.tools,
            input: v5::ModelCapabilitiesInput {
                items: info.capabilities.input.iter().map(convert::wire).collect(),
            },
            output: v5::ModelCapabilitiesOutput {
                items: info.capabilities.output.iter().map(convert::wire).collect(),
            },
        },
        variants: v5::ModelInfoVariants {
            items: info
                .variants
                .iter()
                .map(|variant| {
                    Ok(v5::ModelVariant {
                        id: convert::wire(&variant.id),
                        settings: variant.settings.as_ref().map(|settings| {
                            values!(settings.0, ModelVariantSettings, ModelVariantSettingsEntry)
                        }),
                        headers: variant
                            .headers
                            .as_ref()
                            .map(|source| {
                                Ok(headers!(
                                    source,
                                    ModelVariantHeaders,
                                    ModelVariantHeadersEntry
                                ))
                            })
                            .transpose()?,
                        body: variant
                            .body
                            .as_ref()
                            .map(|body| values!(body.0, ModelVariantBody, ModelVariantBodyEntry)),
                    })
                })
                .collect::<Result<_, Failure>>()?,
        },
        profiles: info
            .profiles
            .as_ref()
            .map(|profiles| {
                Ok(v5::ModelInfoProfiles {
                    items: profiles
                        .iter()
                        .map(|profile| {
                            Ok(v5::ModelProfile {
                                name: convert::wire(&profile.name.0),
                                active: profile.active,
                                variants: profile.variants.as_ref().map(|variants| {
                                    v5::ModelProfileVariants {
                                        items: variants.iter().map(convert::wire).collect(),
                                    }
                                }),
                                daybreak: profile
                                    .daybreak
                                    .as_ref()
                                    .map(|values| {
                                        Ok(v5::ModelProfileDaybreak {
                                            items: values
                                                .iter()
                                                .map(|value| {
                                                    choice(
                                                        &value.0,
                                                        &["daybreak_blue", "daybreak_red"],
                                                    )
                                                })
                                                .collect::<Result<_, Failure>>()?,
                                        })
                                    })
                                    .transpose()?,
                            })
                        })
                        .collect::<Result<_, Failure>>()?,
                })
            })
            .transpose()?,
        time: v5::ModelInfoTime {
            released: info.time.released.get(),
        },
        cost: v5::ModelInfoCost {
            items: info
                .cost
                .iter()
                .map(|cost| v5::ModelCost {
                    tier: cost.tier.as_ref().map(|tier| v5::ModelCostTier {
                        r#type: 1,
                        size: tier.size.get(),
                    }),
                    input: cost.input.get(),
                    output: cost.output.get(),
                    cache: v5::ModelCostCache {
                        read: cost.cache.read.get(),
                        write: cost.cache.write.get(),
                    },
                })
                .collect(),
        },
        status: choice(&info.status, &["alpha", "beta", "deprecated", "active"])?,
        enabled: info.enabled,
        daybreak: info
            .daybreak
            .as_ref()
            .map(|values| {
                Ok(v5::ModelInfoDaybreak {
                    items: values
                        .iter()
                        .map(|value| choice(&value.0, &["daybreak_blue", "daybreak_red"]))
                        .collect::<Result<_, Failure>>()?,
                })
            })
            .transpose()?,
        api: info
            .api
            .as_ref()
            .map(|value| choice(&value.0, &["chat", "responses"]))
            .transpose()?,
        limit: v5::ModelInfoLimit {
            context: info.limit.context.get(),
            input: info.limit.input.map(|value| value.get()),
            output: info.limit.output.get(),
        },
    })
}

pub fn model_default(
    info: &model::Info,
    selection: &model::Ref,
) -> Result<v5::ModelDefault, Failure> {
    let mut data = model(info)?.encode_to_vec();
    let selection = convert::model_ref(&selection.encode())
        .map_err(|_| Failure::Unavailable("Default model selection is not representable".into()))?;
    prost::encoding::message::encode(20, &selection, &mut data);
    v5::ModelDefault::decode(data.as_slice())
        .map_err(|_| Failure::Unavailable("Default model is not representable".into()))
}
