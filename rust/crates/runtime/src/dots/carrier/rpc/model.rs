use super::{Failure, array, field, object, present};
use ycoding_core::{
    dots::native,
    ycoding_schema::{DomainDecode, JsonObject, JsonValue, LosslessString, model},
};

const EFFORTS: [&str; 8] = [
    "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
];

fn invalid() -> Failure {
    Failure(-32602, "Invalid model or reasoning effort", "")
}

fn optional(value: Option<&JsonValue>) -> Result<Option<String>, Failure> {
    match value {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::String(value)) => value
            .to_utf8()
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(Some)
            .ok_or_else(invalid),
        _ => Err(invalid()),
    }
}

fn merge(current: &mut Option<String>, next: Option<String>) -> Result<(), Failure> {
    if let Some(next) = next {
        if current.as_ref().is_some_and(|current| current != &next) {
            return Err(invalid());
        }
        *current = Some(next);
    }
    Ok(())
}

pub(super) fn wire(model: &native::Model) -> String {
    match &model.profile {
        Some(profile) => format!("{profile}#{}/{}", model.provider_id, model.id),
        None => format!("{}/{}", model.provider_id, model.id),
    }
}

pub(super) fn reference(value: &model::Ref) -> LosslessString {
    let mut units = Vec::new();
    if let Some(profile) = &value.profile {
        units.extend(profile.0.code_units());
        units.push(b'#' as u16);
    }
    units.extend(value.provider_id.0.code_units());
    units.push(b'/' as u16);
    units.extend(value.id.code_units());
    LosslessString::from_utf16(units)
}

async fn parse(
    channel: &native::Channel,
    input: &str,
    provider: Option<&str>,
    effort: Option<&str>,
    profile: Option<&str>,
) -> Result<model::Ref, Failure> {
    let models = channel.models().await.map_err(|_| invalid())?;
    let matches = models
        .iter()
        .filter(|model| {
            wire(model) == input
                && profile.is_none_or(|profile| {
                    model
                        .profile
                        .as_deref()
                        .is_none_or(|selected| selected == profile)
                })
        })
        .collect::<Vec<_>>();
    let (provider_id, id, selected_profile, selected_effort) = if matches.len() == 1 {
        let model = matches[0];
        (
            model.provider_id.clone(),
            model.id.clone(),
            model.profile.clone().or_else(|| profile.map(str::to_owned)),
            effort.map(str::to_owned),
        )
    } else if matches.len() > 1 {
        return Err(invalid());
    } else if let Some(slash) = input.find('/') {
        let (prefix, tail) = input.split_at(slash);
        let (selected_profile, provider_id) = match prefix.split_once('#') {
            Some((profile, provider)) if !profile.is_empty() && !provider.is_empty() => {
                (Some(profile.to_owned()), provider.to_owned())
            }
            None if !prefix.is_empty() => (None, prefix.to_owned()),
            _ => return Err(invalid()),
        };
        let (id, variant) = match tail[1..].split_once('#') {
            Some((id, variant))
                if !id.is_empty() && !variant.is_empty() && !variant.contains('#') =>
            {
                (id.to_owned(), Some(variant.to_owned()))
            }
            None if tail.len() > 1 => (tail[1..].to_owned(), None),
            _ => return Err(invalid()),
        };
        if provider_id.contains('#')
            || profile.is_some_and(|profile| {
                selected_profile
                    .as_deref()
                    .is_some_and(|selected| profile != selected)
            })
            || effort
                .is_some_and(|effort| variant.as_deref().is_some_and(|variant| effort != variant))
        {
            return Err(invalid());
        }
        (
            provider_id,
            id,
            selected_profile.or_else(|| profile.map(str::to_owned)),
            effort.map(str::to_owned).or(variant),
        )
    } else if input.contains('#') {
        return Err(invalid());
    } else if let Some(provider) = provider {
        if provider.contains('/') || provider.contains('#') {
            return Err(invalid());
        }
        (
            provider.to_owned(),
            input.to_owned(),
            profile.map(str::to_owned),
            effort.map(str::to_owned),
        )
    } else {
        let matches = models
            .iter()
            .filter(|model| model.id == input && model.profile.as_deref() == profile)
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return Err(invalid());
        }
        (
            matches[0].provider_id.clone(),
            input.to_owned(),
            profile.map(str::to_owned),
            effort.map(str::to_owned),
        )
    };
    if provider.is_some_and(|provider| provider != "ycoding" && provider != provider_id) {
        return Err(invalid());
    }
    model::Ref::decode(
        &object()
            .field("providerID", provider_id.as_str())
            .field("id", id.as_str())
            .optional("profile", &selected_profile.map(LosslessString::from))
            .optional("variant", &selected_effort.map(LosslessString::from))
            .finish(),
    )
    .map_err(|_| invalid())
}

pub(super) async fn requested(
    channel: &native::Channel,
    params: &JsonObject,
    allow_config: bool,
    fallback: Option<model::Ref>,
) -> Result<Option<model::Ref>, Failure> {
    let mut model = optional(field(params, "model"))?;
    let provider = optional(field(params, "modelProvider"))?;
    let mut effort = optional(field(params, "effort"))?;
    merge(&mut effort, optional(field(params, "reasoningEffort"))?)?;
    if present(params, "config") {
        if !allow_config {
            return Err(Failure(
                -32602,
                "Native config overrides are unsupported; YCoding owns execution configuration",
                "",
            ));
        }
        let Some(JsonValue::Object(config)) = field(params, "config") else {
            return Err(invalid());
        };
        merge(&mut model, optional(field(config, "model"))?)?;
        merge(
            &mut effort,
            optional(field(config, "model_reasoning_effort"))?,
        )?;
    }
    if present(params, "collaborationMode") {
        let Some(JsonValue::Object(mode)) = field(params, "collaborationMode") else {
            return Err(invalid());
        };
        if present(mode, "settings") {
            let Some(JsonValue::Object(settings)) = field(mode, "settings") else {
                return Err(invalid());
            };
            merge(&mut model, optional(field(settings, "model"))?)?;
            merge(&mut effort, optional(field(settings, "reasoning_effort"))?)?;
        }
    }
    if let Some(model) = model {
        return parse(
            channel,
            &model,
            provider.as_deref(),
            effort.as_deref(),
            None,
        )
        .await
        .map(Some);
    }
    if provider.is_some() {
        return Err(invalid());
    }
    let mut fallback = fallback;
    if let Some(effort) = effort {
        let base = fallback.as_mut().ok_or_else(invalid)?;
        base.variant = Some(effort.into());
    }
    Ok(fallback)
}

pub(super) fn has_selection(params: &JsonObject) -> bool {
    if ["model", "modelProvider", "effort", "reasoningEffort"]
        .iter()
        .any(|key| present(params, key))
    {
        return true;
    }
    if let Some(JsonValue::Object(config)) = field(params, "config")
        && ["model", "model_reasoning_effort"]
            .iter()
            .any(|key| present(config, key))
    {
        return true;
    }
    if let Some(JsonValue::Object(mode)) = field(params, "collaborationMode")
        && let Some(JsonValue::Object(settings)) = field(mode, "settings")
    {
        return ["model", "reasoning_effort"]
            .iter()
            .any(|key| present(settings, key));
    }
    false
}

pub(super) async fn config(channel: &native::Channel) -> Result<JsonValue, Failure> {
    let selected = channel.default_model().await.map_err(super::internal)?;
    Ok(object()
        .field("model_provider", "ycoding")
        .field(
            "model_providers",
            &object()
                .field("ycoding", &object().field("name", "YCoding").finish())
                .finish(),
        )
        .optional("model", &selected.as_ref().map(reference))
        .optional(
            "model_reasoning_effort",
            &selected.and_then(|selected| selected.variant),
        )
        .finish())
}

pub(super) async fn edit(channel: &native::Channel, params: &JsonObject) -> Result<(), Failure> {
    let Some(JsonValue::Array(edits)) = field(params, "edits") else {
        return Err(invalid());
    };
    if edits.is_empty() {
        return Ok(());
    }
    let mut model = None;
    let mut effort: Option<Option<String>> = None;
    let mut profile = None;
    for edit in edits {
        let JsonValue::Object(edit) = edit else {
            return Err(invalid());
        };
        if optional(field(edit, "mergeStrategy"))?
            .as_deref()
            .is_some_and(|value| !matches!(value, "replace" | "upsert"))
        {
            return Err(invalid());
        }
        let key = optional(field(edit, "keyPath"))?.ok_or_else(invalid)?;
        let key = if let Some(key) = key.strip_prefix("profiles.") {
            let (name, key) = key.split_once('.').ok_or_else(invalid)?;
            if name.is_empty() || key.contains('.') {
                return Err(invalid());
            }
            merge(&mut profile, Some(name.to_owned()))?;
            key
        } else {
            &key
        };
        match key {
            "model" => merge(
                &mut model,
                Some(optional(field(edit, "value"))?.ok_or_else(invalid)?),
            )?,
            "model_reasoning_effort" => {
                if field(edit, "value").is_none() {
                    return Err(invalid());
                }
                let next = optional(field(edit, "value"))?;
                if effort.as_ref().is_some_and(|effort| effort != &next) {
                    return Err(invalid());
                }
                effort = Some(next);
            }
            _ => return Err(invalid()),
        }
    }
    let target = match model {
        Some(model) => {
            let selected = parse(
                channel,
                &model,
                None,
                effort.as_ref().and_then(|effort| effort.as_deref()),
                profile.as_deref(),
            )
            .await?;
            if effort == Some(None) && selected.variant.is_some() {
                return Err(invalid());
            }
            selected
        }
        None => {
            let mut current = channel
                .default_model()
                .await
                .map_err(|_| invalid())?
                .ok_or_else(invalid)?;
            if profile.as_ref().is_some_and(|profile| {
                current
                    .profile
                    .as_ref()
                    .is_none_or(|current| current.0.as_str() != Some(profile.as_str()))
            }) {
                return Err(invalid());
            }
            current.variant = effort.flatten().map(Into::into);
            current
        }
    };
    channel
        .set_default_model(target)
        .await
        .map_err(|_| Failure(-32602, "Unknown or unavailable model or profile", ""))?;
    Ok(())
}

pub(super) async fn list(channel: &native::Channel) -> Result<JsonValue, Failure> {
    let models = channel.models().await.map_err(super::internal)?;
    let selected = channel.default_model().await.map_err(super::internal)?;
    let matches = |model: &native::Model| {
        selected.as_ref().is_some_and(|selected| {
            selected.provider_id.0.as_str() == Some(model.provider_id.as_str())
                && selected.id.as_str() == Some(model.id.as_str())
                && selected.profile.as_ref().map(|profile| profile.0.as_str())
                    == model.profile.as_deref().map(Some)
        })
    };
    let explicit = models.iter().any(matches);
    Ok(array(
        models
            .iter()
            .map(|model| {
                let id = wire(model);
                let mut efforts = Vec::new();
                for effort in model.variants.as_deref().unwrap_or(&[]) {
                    if EFFORTS.contains(&effort.as_str()) && !efforts.contains(effort) {
                        efforts.push(effort.clone());
                    }
                }
                let default = if efforts.iter().any(|effort| effort == "medium") {
                    Some("medium")
                } else {
                    efforts.first().map(String::as_str)
                };
                let name = model.name.as_deref().unwrap_or(&model.id);
                let display = match &model.profile {
                    Some(profile) => format!("{name} ({} · {profile})", model.provider_id),
                    None => format!("{name} ({})", model.provider_id),
                };
                object()
                    .field("id", id.as_str())
                    .field("model", id.as_str())
                    .field("displayName", display.as_str())
                    .field("providerId", model.provider_id.as_str())
                    .optional(
                        "profile",
                        &model.profile.as_deref().map(LosslessString::from),
                    )
                    .field("hidden", &false)
                    .field(
                        "isDefault",
                        &(if explicit {
                            matches(model)
                        } else {
                            model.is_default.unwrap_or(false)
                        }),
                    )
                    .field(
                        "supportedReasoningEfforts",
                        &array(
                            efforts
                                .iter()
                                .map(|effort| {
                                    object()
                                        .field("reasoningEffort", effort.as_str())
                                        .field("description", effort.as_str())
                                        .finish()
                                })
                                .collect(),
                        ),
                    )
                    .field(
                        "defaultReasoningEffort",
                        &default
                            .map(|effort| JsonValue::String(effort.into()))
                            .unwrap_or(JsonValue::Null),
                    )
                    .finish()
            })
            .collect(),
    ))
}
