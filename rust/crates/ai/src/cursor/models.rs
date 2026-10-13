use crate::{Error, json};
use ycoding_schema::{JsonValue, LosslessString};

#[derive(Clone, Debug, PartialEq)]
pub struct Variant {
    pub key: LosslessString,
    pub display_name: LosslessString,
    pub parameters: Vec<(LosslessString, LosslessString)>,
    pub default_non_max: bool,
    pub default_max: bool,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub id: LosslessString,
    pub display_name: LosslessString,
    pub supports_thinking: bool,
    pub supports_agent: bool,
    pub supports_images: Option<bool>,
    pub max_context: Option<f64>,
    pub max_context_max_mode: Option<f64>,
    pub supports_max_mode: bool,
    pub variants: Vec<Variant>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Selection {
    pub id: LosslessString,
    pub parameters: Vec<(LosslessString, LosslessString)>,
    pub max_mode: bool,
}
pub fn available_models(raw: &JsonValue) -> Result<Vec<Info>, Error> {
    let Some(entries) = json::get(raw, "models").filter(|value| !matches!(value, JsonValue::Null))
    else {
        return Ok(Vec::new());
    };
    let entries = json::array(entries)
        .ok_or_else(|| Error::output("Cursor AvailableModels models must be an array"))?;
    let mut models = Vec::new();
    for entry in entries {
        let Some(name) = json::get(entry, "name")
            .and_then(json::string)
            .filter(|name| json::nonblank(name))
        else {
            continue;
        };
        let mut variants = Vec::new();
        if let Some(raw) =
            json::get(entry, "variants").filter(|value| !matches!(value, JsonValue::Null))
        {
            for variant in json::array(raw)
                .ok_or_else(|| Error::output("Cursor AvailableModels variants must be an array"))?
            {
                if !matches!(variant, JsonValue::Object(_)) {
                    return Err(Error::output(
                        "Cursor AvailableModels returned a malformed variant",
                    ));
                }
                let parameters =
                    match nullable_member(variant, &["parameterValues", "parameter_values"]) {
                        Some(parameters) => parameters_from_json(parameters).map_err(|_| {
                            Error::output(
                                "Cursor AvailableModels returned malformed parameter values",
                            )
                        })?,
                        None => Vec::new(),
                    };
                variants.push(Variant {
                    key: name.clone(),
                    display_name: nullable_member(variant, &["displayName", "display_name"])
                        .and_then(json::string)
                        .cloned()
                        .unwrap_or_else(|| name.clone()),
                    parameters,
                    default_non_max: api_bool(
                        variant,
                        &["isDefaultNonMaxConfig", "is_default_non_max_config"],
                    )?,
                    default_max: api_bool(
                        variant,
                        &["isDefaultMaxConfig", "is_default_max_config"],
                    )?,
                });
            }
        }
        let base_context = variants
            .iter()
            .find(|variant| variant.default_non_max)
            .and_then(variant_context)
            .or_else(|| {
                variants
                    .iter()
                    .find(|variant| variant_context(variant) != Some(1_000_000.0))
                    .and_then(variant_context)
            })
            .or_else(|| {
                variants
                    .iter()
                    .find(|variant| {
                        variant
                            .parameters
                            .iter()
                            .any(|parameter| parameter.0.as_str() == Some("context"))
                    })
                    .and_then(variant_context)
            });
        let max_context = variants
            .iter()
            .find(|variant| variant.default_max)
            .and_then(variant_context);
        let images = member(entry, &["supportsImages", "supports_images"])
            .map(|value| {
                json::boolean(value).ok_or_else(|| {
                    Error::output("Cursor AvailableModels supportsImages must be boolean")
                })
            })
            .transpose()?;
        models.push(Info {
            id: name.clone(),
            display_name: nullable_member(entry, &["clientDisplayName", "client_display_name"])
                .and_then(json::string)
                .cloned()
                .unwrap_or_else(|| name.clone()),
            supports_thinking: api_bool(entry, &["supportsThinking", "supports_thinking"])?,
            supports_agent: api_bool(entry, &["supportsAgent", "supports_agent"])?,
            supports_images: images,
            max_context: base_context.or_else(|| {
                nullable_member(entry, &["contextTokenLimit", "context_token_limit"])
                    .and_then(positive)
            }),
            max_context_max_mode: max_context.or_else(|| {
                nullable_member(
                    entry,
                    &[
                        "contextTokenLimitForMaxMode",
                        "context_token_limit_for_max_mode",
                    ],
                )
                .and_then(positive)
            }),
            supports_max_mode: api_bool(entry, &["supportsMaxMode", "supports_max_mode"])?,
            variants,
        });
    }
    Ok(models)
}
pub fn wire_id(fallback: &LosslessString, options: Option<&JsonValue>) -> LosslessString {
    options
        .and_then(|options| json::get(options, "cursorModelId"))
        .and_then(json::string)
        .filter(|id| json::nonblank(id))
        .cloned()
        .unwrap_or_else(|| fallback.clone())
}
pub fn selection(
    fallback: &LosslessString,
    options: Option<&JsonValue>,
    models: &[Info],
) -> Result<Selection, Error> {
    let id = wire_id(fallback, options);
    let model = models.iter().find(|model| model.id == id);
    let picked = options
        .and_then(|options| json::get(options, "cursorVariantParameters"))
        .map(parameters_from_json)
        .transpose()?;
    let effort = options
        .and_then(|options| json::get(options, "reasoningEffort"))
        .and_then(json::string)
        .filter(|value| !value.is_empty());
    let want_max = options
        .and_then(|options| json::get(options, "maxMode"))
        .is_some_and(truthy);
    let parameters = if let Some(model) = model.filter(|model| !model.variants.is_empty()) {
        if let Some(picked) = &picked {
            let distinct = picked.iter().enumerate().all(|(index, parameter)| {
                !picked[..index].iter().any(|prior| prior.0 == parameter.0)
            });
            model.variants.iter().find(|variant| distinct && variant.parameters.len() == picked.len() && variant.parameters.iter().all(|parameter| picked.iter().any(|candidate| candidate == parameter))).map(|variant| variant.parameters.clone()).ok_or_else(|| Error::invalid("Cursor variant selection is stale: its exact parameter tuple is unavailable"))?
        } else {
            let non_fast = model
                .variants
                .iter()
                .filter(|variant| {
                    !variant.parameters.iter().any(|parameter| {
                        parameter.0.as_str() == Some("fast") && parameter.1.as_str() == Some("true")
                    })
                })
                .collect::<Vec<_>>();
            let pool = if non_fast.is_empty() {
                model.variants.iter().collect::<Vec<_>>()
            } else {
                non_fast
            };
            let max_pool = pool
                .iter()
                .copied()
                .filter(|variant| {
                    variant.default_max || variant_context(variant) == Some(1_000_000.0)
                })
                .collect::<Vec<_>>();
            let effort_pool = if want_max && !max_pool.is_empty() {
                max_pool.as_slice()
            } else {
                pool.as_slice()
            };
            let matched_effort = effort.and_then(|effort| {
                effort_pool.iter().copied().find(|variant| {
                    variant
                        .parameters
                        .iter()
                        .find(|parameter| {
                            matches!(parameter.0.as_str(), Some("effort" | "reasoning"))
                        })
                        .is_some_and(|parameter| &parameter.1 == effort)
                })
            });
            let matched_max = want_max
                .then(|| {
                    pool.iter()
                        .copied()
                        .find(|variant| variant.default_max)
                        .or_else(|| {
                            pool.iter()
                                .copied()
                                .find(|variant| variant_context(variant) == Some(1_000_000.0))
                        })
                })
                .flatten();
            let selected = matched_effort
                .or(matched_max)
                .or_else(|| pool.iter().copied().find(|variant| variant.default_non_max))
                .or_else(|| pool.first().copied())
                .ok_or_else(|| Error::output("Cursor cached model has no selectable variant"))?;
            let mut parameters = selected.parameters.clone();
            if let Some(effort) = effort
                && let Some(parameter) = parameters
                    .iter_mut()
                    .find(|parameter| matches!(parameter.0.as_str(), Some("effort" | "reasoning")))
            {
                parameter.1 = effort.clone();
            }
            parameters
        }
    } else {
        if picked.is_some() {
            return Err(Error::invalid(
                "Cursor variant selection is stale: model has no cached variants",
            ));
        }
        effort
            .map(|effort| vec![("effort".into(), effort.clone())])
            .unwrap_or_default()
    };
    let max_mode = parameters.iter().any(|parameter| {
        parameter.0.as_str() == Some("context") && context_limit(&parameter.1) == Some(1_000_000.0)
    }) || picked.is_none() && want_max;
    Ok(Selection {
        id,
        parameters,
        max_mode,
    })
}
pub fn context_limit(value: &LosslessString) -> Option<f64> {
    let text = value.as_str()?.trim();
    let limit = if let Some(last) = text
        .chars()
        .last()
        .filter(|last| matches!(last, 'k' | 'K' | 'm' | 'M'))
    {
        let number = text[..text.len() - 1].trim_end();
        let pieces = number.split('.').collect::<Vec<_>>();
        if pieces.is_empty()
            || pieces.len() > 2
            || pieces
                .iter()
                .any(|piece| piece.is_empty() || !piece.bytes().all(|byte| byte.is_ascii_digit()))
        {
            return None;
        }
        number.parse::<f64>().ok()?
            * if matches!(last, 'k' | 'K') {
                1000.0
            } else {
                1_000_000.0
            }
    } else if let Some(number) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        u64::from_str_radix(number, 16).ok()? as f64
    } else if let Some(number) = text.strip_prefix("0o").or_else(|| text.strip_prefix("0O")) {
        u64::from_str_radix(number, 8).ok()? as f64
    } else if let Some(number) = text.strip_prefix("0b").or_else(|| text.strip_prefix("0B")) {
        u64::from_str_radix(number, 2).ok()? as f64
    } else {
        text.parse::<f64>().ok()?
    };
    (limit.is_finite() && limit > 0.0 && limit.fract() == 0.0 && limit <= 9_007_199_254_740_991.0)
        .then_some(limit)
}
fn variant_context(variant: &Variant) -> Option<f64> {
    variant
        .parameters
        .iter()
        .find(|parameter| parameter.0.as_str() == Some("context"))
        .and_then(|parameter| context_limit(&parameter.1))
}
fn parameters_from_json(value: &JsonValue) -> Result<Vec<(LosslessString, LosslessString)>, Error> {
    json::array(value).ok_or_else(|| Error::invalid("Cursor variant selection is malformed: cursorVariantParameters must be a parameter array"))?.iter().map(|parameter| {
        let id = json::get(parameter, "id").and_then(json::string).filter(|id| json::nonblank(id)).ok_or_else(|| Error::invalid("Cursor variant parameter requires a nonempty id"))?;
        let value = json::get(parameter, "value").and_then(json::string).ok_or_else(|| Error::invalid("Cursor variant parameter requires a string value"))?;
        Ok((id.clone(), value.clone()))
    }).collect()
}
fn member<'a>(value: &'a JsonValue, names: &[&str]) -> Option<&'a JsonValue> {
    names.iter().find_map(|name| json::get(value, name))
}
fn nullable_member<'a>(value: &'a JsonValue, names: &[&str]) -> Option<&'a JsonValue> {
    names
        .iter()
        .find_map(|name| json::get(value, name).filter(|value| !matches!(value, JsonValue::Null)))
}
fn api_bool(value: &JsonValue, names: &[&str]) -> Result<bool, Error> {
    member(value, names)
        .map(|value| {
            json::boolean(value).ok_or_else(|| {
                Error::output("Cursor AvailableModels returned a non-boolean capability")
            })
        })
        .transpose()
        .map(|value| value.unwrap_or(false))
}
fn positive(value: &JsonValue) -> Option<f64> {
    json::number(value).filter(|value| value.is_finite() && *value > 0.0)
}
fn truthy(value: &JsonValue) -> bool {
    match value {
        JsonValue::Null => false,
        JsonValue::Bool(value) => *value,
        JsonValue::Number(value) => *value != 0.0 && !value.is_nan(),
        JsonValue::String(value) => !value.is_empty(),
        _ => true,
    }
}
