use crate::resources::catalog::{empty_model, object};
use std::collections::{BTreeMap, BTreeSet};
use ycoding_ai::cursor::{
    models::{Info, Variant, context_limit},
    pricing,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonObject, JsonValue, LosslessString, model, provider, schema::Int,
};

pub const PROVIDER_ID: &str = "cursor";
pub const PACKAGE_NAME: &str = "cursor-opencode-provider";
pub const VARIANT_PARAMETERS_KEY: &str = "cursorVariantParameters";

struct Group<'a> {
    context: Option<u64>,
    fast: bool,
    variants: Vec<&'a Variant>,
    suffix: String,
}

pub fn from_cursor(models: &[Info]) -> Vec<model::Info> {
    let ambiguous = thinking_suffix_names(models);
    let mut used = models
        .iter()
        .map(|model| text(&model.id))
        .collect::<BTreeSet<_>>();
    models
        .iter()
        .flat_map(|model| {
            let thinking =
                model.supports_thinking && ambiguous.contains(&label(&model.display_name));
            let groups = tier_groups(model);
            if groups.is_empty() {
                let group = Group {
                    context: None,
                    fast: false,
                    variants: Vec::new(),
                    suffix: String::new(),
                };
                return vec![info(model, text(&model.id), &group, thinking)];
            }
            let primary = groups
                .iter()
                .position(|group| group.suffix.is_empty())
                .unwrap_or(0);
            groups
                .iter()
                .enumerate()
                .map(|(index, group)| {
                    let id = if index == primary {
                        text(&model.id)
                    } else {
                        unique_id(&mut used, &text(&model.id), &group.suffix)
                    };
                    info(model, id, group, thinking)
                })
                .collect()
        })
        .collect()
}

fn info(model: &Info, id: String, group: &Group, thinking: bool) -> model::Info {
    let model_id = text(&model.id);
    let offered = variants(model, &group.variants);
    let defaults =
        if id == model_id && group.context.is_none() && !group.fast && !offered.is_empty() {
            None
        } else {
            default_variant(group)
        };
    let mut info = empty_model(provider::Id(PROVIDER_ID.into()), id.as_str().into())
        .expect("Cursor model identity is valid");
    info.model_id = model_id.as_str().into();
    info.name = [
        Some(label(&model.display_name)),
        thinking.then(|| "Thinking".into()),
        group.fast.then(|| "Fast".into()),
        group.context.map(context_label),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ")
    .into();
    info.package = Some(format!("aisdk:{PACKAGE_NAME}").into());
    info.settings = defaults.map(parameters_settings);
    info.capabilities = model::Capabilities {
        tools: model.supports_agent,
        input: if model.supports_images.unwrap_or(false) {
            vec!["text".into(), "image".into()]
        } else {
            vec!["text".into()]
        },
        output: vec!["text".into()],
    };
    info.variants = offered;
    let price_key = if group.fast {
        format!("{model_id}-fast")
    } else if group.context == Some(1_000_000) {
        format!("{model_id}-1m")
    } else {
        model_id.clone()
    };
    info.cost = costs(&price_key);
    info.limit = model::Limit {
        context: int(group.context.unwrap_or_else(|| base_context(model))),
        input: None,
        output: int(if group.context == Some(1_000_000) {
            128_000
        } else {
            32_000
        }),
    };
    info
}

fn costs(key: &str) -> Vec<model::Cost> {
    let cost = pricing::get(&key.into()).ok().flatten();
    pricing::tiers(cost.as_ref())
        .into_iter()
        .map(|tier| model::Cost {
            tier: tier.context_size.map(|size| model::Tier {
                size: int(u64::from(size)),
            }),
            input: rate(tier.input),
            output: rate(tier.output),
            cache: model::CacheCost {
                read: rate(tier.cache_read),
                write: rate(tier.cache_write),
            },
        })
        .collect()
}

fn rate(value: f64) -> ycoding_schema::money::UsdPerMillionTokens {
    ycoding_schema::money::UsdPerMillionTokens::new(value).expect("Cursor rates are finite")
}

fn int(value: u64) -> Int {
    Int::decode(&JsonValue::Number(value as f64)).expect("Cursor limits are integers")
}

fn base_context(model: &Info) -> u64 {
    model.max_context.map_or(
        if model.id.as_str() == Some("default") {
            256_000
        } else {
            200_000
        },
        |value| value as u64,
    )
}

fn tier_groups(model: &Info) -> Vec<Group<'_>> {
    let split_fast = model.variants.iter().any(is_fast);
    let base = base_context(model);
    let mut contexts = Vec::new();
    for variant in &model.variants {
        if let Some(context) = variant_context(variant, base)
            && !contexts.contains(&context)
        {
            contexts.push(context);
        }
    }
    std::iter::once(None)
        .chain(contexts.into_iter().map(Some))
        .flat_map(|context| {
            let tiered = model
                .variants
                .iter()
                .filter(|variant| variant_context(variant, base) == context)
                .collect::<Vec<_>>();
            let speeds = if split_fast {
                vec![
                    (
                        false,
                        tiered.iter().copied().filter(|v| !is_fast(v)).collect(),
                    ),
                    (
                        true,
                        tiered.iter().copied().filter(|v| is_fast(v)).collect(),
                    ),
                ]
            } else {
                vec![(false, tiered)]
            };
            speeds
                .into_iter()
                .filter(|(_, variants): &(bool, Vec<&Variant>)| !variants.is_empty())
                .map(|(fast, variants)| Group {
                    context,
                    fast,
                    variants,
                    suffix: format!(
                        "{}{}",
                        context.map_or(String::new(), |context| format!(
                            "-{}",
                            context_label(context).to_lowercase()
                        )),
                        if fast { "-fast" } else { "" }
                    ),
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

fn default_variant<'a>(group: &Group<'a>) -> Option<&'a Variant> {
    group
        .variants
        .iter()
        .copied()
        .find(|variant| {
            if group.context.is_none() {
                variant.default_non_max
            } else {
                variant.default_max
            }
        })
        .or_else(|| group.variants.first().copied())
}

fn variants(model: &Info, input: &[&Variant]) -> Vec<model::Variant> {
    if input.len() == 1
        && !input[0]
            .parameters
            .iter()
            .any(|p| p.0.as_str() == Some("effort"))
    {
        return Vec::new();
    }
    let base = label(&model.display_name);
    let mut used = BTreeSet::new();
    input
        .iter()
        .map(|variant| {
            let effort = variant
                .parameters
                .iter()
                .find(|p| p.0.as_str() == Some("effort"))
                .map(|p| text(&p.1))
                .filter(|effort| !effort.is_empty());
            let name = if variant.display_name.is_empty() {
                &variant.key
            } else {
                &variant.display_name
            };
            let sanitized = label(name);
            let tagged = format!("{sanitized}{}", dimensions(variant));
            let first = (sanitized == base && !used.contains(&sanitized))
                .then(|| format!("{base}{}", dimensions(variant)));
            let candidate = match effort {
                Some(effort) if ["low", "medium", "high", "xhigh"].contains(&effort.as_str()) => {
                    effort
                }
                _ => first.unwrap_or_else(|| {
                    if used.contains(&sanitized) {
                        tagged.clone()
                    } else {
                        sanitized.clone()
                    }
                }),
            };
            let id = if used.contains(&candidate) {
                (0..=used.len())
                    .map(|index| format!("{tagged} {}", index + 2))
                    .find(|item| !used.contains(item))
                    .unwrap_or(tagged)
            } else {
                candidate
            };
            used.insert(id.clone());
            model::Variant {
                id: id.into(),
                settings: Some(parameters_settings(variant)),
                headers: None,
                body: None,
            }
        })
        .collect()
}

fn dimensions(variant: &Variant) -> String {
    let labels = variant
        .parameters
        .iter()
        .filter_map(|(id, value)| match (id.as_str(), value.as_str()) {
            (Some("fast"), Some("true")) => Some("Fast".to_owned()),
            (Some("thinking"), Some("true")) => Some("Thinking".to_owned()),
            (Some("context"), _) => Some(text(value)),
            _ => None,
        })
        .collect::<Vec<_>>();
    if !labels.is_empty() {
        format!(" {}", labels.join(" "))
    } else if variant.parameters.is_empty() {
        String::new()
    } else {
        " default".into()
    }
}

fn parameters_settings(variant: &Variant) -> provider::Settings {
    let mut settings = JsonObject::new();
    settings.insert(
        VARIANT_PARAMETERS_KEY.into(),
        JsonValue::Array(
            variant
                .parameters
                .iter()
                .map(|(id, value)| object(&[("id", id.encode()), ("value", value.encode())]))
                .collect(),
        ),
    );
    provider::Settings(settings)
}

fn thinking_suffix_names(models: &[Info]) -> BTreeSet<String> {
    let mut groups = BTreeMap::<String, (bool, bool)>::new();
    for model in models {
        let entry = groups.entry(label(&model.display_name)).or_default();
        if model.supports_thinking {
            entry.0 = true;
        } else {
            entry.1 = true;
        }
    }
    groups
        .into_iter()
        .filter(|(_, (thinking, plain))| *thinking && *plain)
        .map(|(name, _)| name)
        .collect()
}

fn unique_id(used: &mut BTreeSet<String>, model_id: &str, suffix: &str) -> String {
    let first = format!("{model_id}{suffix}");
    let numbered = (0..=used.len()).map(|index| {
        let n = index + 2;
        if suffix == "-fast" {
            format!("{model_id}-fast-{n}")
        } else if let Some(stem) = suffix.strip_suffix("-fast") {
            format!("{model_id}{stem}-{n}-fast")
        } else {
            format!("{model_id}{suffix}-{n}")
        }
    });
    let id = std::iter::once(first.clone())
        .chain(numbered)
        .find(|candidate| !used.contains(candidate))
        .unwrap_or(first);
    used.insert(id.clone());
    id
}

fn label(value: &LosslessString) -> String {
    let mut stripped = String::new();
    let mut rest = text(value);
    while let Some(start) = rest.find('<') {
        stripped.push_str(&rest[..start]);
        match rest[start..].find('>') {
            Some(end) => rest = rest[start + end + 1..].to_owned(),
            None => {
                stripped.push_str(&rest[start..]);
                rest.clear();
            }
        }
    }
    stripped.push_str(&rest);
    let cleaned = stripped
        .chars()
        .filter(|c| !"()<>&\"'`".contains(*c))
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if cleaned.is_empty() {
        "default".into()
    } else {
        cleaned
    }
}

fn text(value: &LosslessString) -> String {
    String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>())
}

fn is_fast(variant: &Variant) -> bool {
    variant
        .parameters
        .iter()
        .any(|p| p.0.as_str() == Some("fast") && p.1.as_str() == Some("true"))
}

fn variant_context(variant: &Variant, base: u64) -> Option<u64> {
    let value = &variant
        .parameters
        .iter()
        .find(|p| p.0.as_str() == Some("context"))?
        .1;
    context_limit(value)
        .map(|limit| limit as u64)
        .filter(|context| *context != base)
}

fn context_label(tokens: u64) -> String {
    if tokens.is_multiple_of(1_000_000) {
        format!("{}M", tokens / 1_000_000)
    } else if tokens.is_multiple_of(1_000) {
        format!("{}k", tokens / 1_000)
    } else {
        tokens.to_string()
    }
}
