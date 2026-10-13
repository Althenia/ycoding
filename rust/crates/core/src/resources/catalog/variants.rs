use super::{field, models_dev::Error, object};
use ycoding_schema::{DomainDecode, JsonValue, model};

pub(super) fn variants(
    npm: Option<&str>,
    source: &JsonValue,
) -> Result<Vec<model::Variant>, Error> {
    let Some(npm) = npm else {
        return Ok(vec![]);
    };
    let Some(JsonValue::Array(options)) = field(source, "reasoning_options") else {
        return Ok(vec![]);
    };
    let id = field(source, "id")
        .and_then(string)
        .ok_or(Error::InvalidSource)?;
    let toggle = options
        .iter()
        .any(|v| field(v, "type").and_then(string) == Some("toggle"));
    let effort = options
        .iter()
        .find(|v| field(v, "type").and_then(string) == Some("effort"));
    let mut result = if toggle {
        toggles(npm, id)
            .into_iter()
            .filter(|(id, _)| effort.is_none() || *id == "none")
            .map(|(id, s)| variant(id, s))
            .collect::<Result<Vec<_>, _>>()?
    } else {
        vec![]
    };
    if let Some(effort) = effort {
        let Some(JsonValue::Array(values)) = field(effort, "values") else {
            return Err(Error::InvalidSource);
        };
        for value in values {
            let id_value = match value {
                JsonValue::Null => "none",
                JsonValue::String(s) => s.as_str().ok_or(Error::InvalidSource)?,
                _ => return Err(Error::InvalidSource),
            };
            if id_value == "null" {
                continue;
            }
            if result.iter().any(|v| v.id == id_value.into()) {
                continue;
            }
            if let Some(settings) = for_effort(npm, id, id_value) {
                result.push(variant(id_value, settings)?);
            }
        }
        return Ok(result);
    }
    if let Some(budget) = options
        .iter()
        .find(|v| field(v, "type").and_then(string) == Some("budget_tokens"))
    {
        result.retain(|v| v.id == "none".into());
        let output = field(source, "limit")
            .and_then(|v| field(v, "output"))
            .and_then(number)
            .ok_or(Error::InvalidSource)?;
        let maximum = field(budget, "max")
            .and_then(number)
            .unwrap_or(31999.0)
            .min(output - 1.0)
            .min(31999.0);
        if maximum <= 0.0 {
            return Ok(result);
        }
        let high = field(budget, "min")
            .and_then(number)
            .unwrap_or(0.0)
            .max(((maximum + 1.0) / 2.0).floor())
            .min(maximum);
        for (name, budget) in [("high", high), ("max", maximum)] {
            if let Some(settings) = for_budget(npm, id, budget) {
                result.push(variant(name, settings)?);
            }
        }
    }
    Ok(result)
}
fn variant(id: &str, settings: JsonValue) -> Result<model::Variant, Error> {
    Ok(model::Variant::decode(&object(&[
        ("id", JsonValue::String(id.into())),
        ("settings", settings),
    ]))?)
}
fn json(value: &str) -> JsonValue {
    ycoding_schema::parse_json(value).expect("static valid JSON")
}
fn string(value: &JsonValue) -> Option<&str> {
    match value {
        JsonValue::String(s) => s.as_str(),
        _ => None,
    }
}
fn number(value: &JsonValue) -> Option<f64> {
    match value {
        JsonValue::Number(n) => Some(*n),
        _ => None,
    }
}
fn gateway(id: &str) -> Option<&'static str> {
    match id.split_once('/')?.0 {
        "anthropic" => Some("@ai-sdk/anthropic"),
        "google" => Some("@ai-sdk/google"),
        "amazon" => Some("@ai-sdk/amazon-bedrock"),
        "alibaba" => Some("@ai-sdk/alibaba"),
        _ => None,
    }
}
fn manual(id: &str) -> bool {
    let lower = id.to_ascii_lowercase();
    let family = ["opus-", "sonnet-", "haiku-"]
        .iter()
        .find_map(|prefix| lower.find(prefix).map(|i| &lower[i + prefix.len()..]));
    let version = family.or_else(|| {
        lower
            .strip_prefix("claude-")
            .filter(|s| s.as_bytes().first().is_some_and(u8::is_ascii_digit))
    });
    let Some(version) = version else {
        return false;
    };
    let mut parts = version.split(['-', '.']);
    let Some(major) = parts.next().and_then(|s| s.parse::<u32>().ok()) else {
        return false;
    };
    let minor = parts
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|n| *n <= 9)
        .unwrap_or(0);
    major < 4 || (major == 4 && minor < 6)
}
pub(crate) fn for_effort(npm: &str, id: &str, effort: &str) -> Option<JsonValue> {
    let effort = JsonValue::String(effort.into());
    let direct = object(&[("reasoningEffort", effort.clone())]);
    if npm == "@ai-sdk/openai-compatible" && id.contains("deepseek") {
        return Some(if string(&effort) == Some("none") {
            json(r#"{"thinking":{"type":"disabled"}}"#)
        } else {
            super::merge_json(&direct, &json(r#"{"thinking":{"type":"enabled"}}"#))
        });
    }
    match npm {
        "@openrouter/ai-sdk-provider" => {
            Some(object(&[("reasoning", object(&[("effort", effort)]))]))
        }
        "@ai-sdk/anthropic" | "@ai-sdk/google-vertex/anthropic" => Some(if manual(id) {
            object(&[("effort", effort)])
        } else {
            object(&[
                (
                    "thinking",
                    json(r#"{"type":"adaptive","display":"summarized"}"#),
                ),
                ("effort", effort),
            ])
        }),
        "@ai-sdk/google" | "@ai-sdk/google-vertex" => Some(object(&[(
            "thinkingConfig",
            object(&[
                ("includeThoughts", JsonValue::Bool(true)),
                ("thinkingLevel", effort),
            ]),
        )])),
        "@ai-sdk/amazon-bedrock" => Some(object(&[(
            "reasoningConfig",
            super::merge_json(
                &if id.contains("anthropic") {
                    if manual(id) {
                        object(&[])
                    } else {
                        json(r#"{"type":"adaptive","display":"summarized"}"#)
                    }
                } else {
                    json(r#"{"type":"enabled"}"#)
                },
                &object(&[("maxReasoningEffort", effort)]),
            ),
        )])),
        "@ai-sdk/gateway" => gateway(id)
            .map(|npm| for_effort(npm, id, string(&effort).expect("effort string")))
            .unwrap_or(Some(direct)),
        "@ai-sdk/github-copilot" if id.contains("gemini") => None,
        "@ai-sdk/github-copilot" if id.contains("claude") => Some(direct),
        "@ai-sdk/openai"
        | "@ai-sdk/amazon-bedrock/mantle"
        | "@ai-sdk/azure"
        | "@ai-sdk/github-copilot" => Some(super::merge_json(
            &direct,
            &json(r#"{"reasoningSummary":"auto","include":["reasoning.encrypted_content"]}"#),
        )),
        "@jerome-benoit/sap-ai-provider-v2" => Some(object(&[(
            "modelParams",
            if id.contains("anthropic") {
                object(&[(
                    "additionalModelRequestFields",
                    super::merge_json(
                        &if manual(id) {
                            object(&[])
                        } else {
                            json(r#"{"thinking":{"type":"adaptive","display":"summarized"}}"#)
                        },
                        &object(&[("output_config", object(&[("effort", effort)]))]),
                    ),
                )])
            } else if id.contains("gemini") {
                object(&[(
                    "thinkingConfig",
                    object(&[
                        ("includeThoughts", JsonValue::Bool(true)),
                        ("thinkingLevel", effort),
                    ]),
                )])
            } else if id.contains("amazon--nova") {
                object(&[(
                    "additionalModelRequestFields",
                    object(&[("output_config", object(&[("effort", effort)]))]),
                )])
            } else {
                object(&[("reasoning_effort", effort)])
            },
        )])),
        "@ai-sdk/openai-compatible"
        | "@ai-sdk/xai"
        | "@ai-sdk/mistral"
        | "@ai-sdk/groq"
        | "@ai-sdk/cerebras"
        | "@ai-sdk/deepinfra"
        | "@ai-sdk/togetherai"
        | "venice-ai-sdk-provider"
        | "ai-gateway-provider" => Some(direct),
        _ => None,
    }
}
fn toggles(npm: &str, id: &str) -> Vec<(&'static str, JsonValue)> {
    if npm == "@ai-sdk/gateway"
        && let Some(npm) = gateway(id)
    {
        return toggles(npm, id);
    }
    let pair = match npm {
        "@ai-sdk/openai-compatible" if id.contains("deepseek") => (
            "thinking",
            json(r#"{"thinking":{"type":"disabled"}}"#),
            json(r#"{"thinking":{"type":"enabled"},"reasoningEffort":"high"}"#),
        ),
        "@ai-sdk/gateway" | "@openrouter/ai-sdk-provider" => (
            "thinking",
            json(r#"{"reasoning":{"enabled":false}}"#),
            json(r#"{"reasoning":{"enabled":true}}"#),
        ),
        "@ai-sdk/anthropic" | "@ai-sdk/google-vertex/anthropic" => (
            "thinking",
            json(r#"{"thinking":{"type":"disabled"}}"#),
            json(r#"{"thinking":{"type":"adaptive","display":"summarized"}}"#),
        ),
        "@ai-sdk/google" | "@ai-sdk/google-vertex" => (
            "thinking",
            json(r#"{"thinkingConfig":{"includeThoughts":false,"thinkingBudget":0}}"#),
            json(r#"{"thinkingConfig":{"includeThoughts":true,"thinkingBudget":-1}}"#),
        ),
        "@ai-sdk/amazon-bedrock" => (
            "thinking",
            object(&[(
                "additionalModelRequestFields",
                if id.contains("anthropic") {
                    json(r#"{"thinking":{"type":"disabled"}}"#)
                } else {
                    json(r#"{"reasoningConfig":{"type":"disabled"}}"#)
                },
            )]),
            object(&[(
                "additionalModelRequestFields",
                if id.contains("anthropic") {
                    json(r#"{"thinking":{"type":"adaptive","display":"summarized"}}"#)
                } else {
                    json(r#"{"reasoningConfig":{"type":"enabled"}}"#)
                },
            )]),
        ),
        "@ai-sdk/alibaba" => (
            "high",
            json(r#"{"enableThinking":false}"#),
            json(r#"{"enableThinking":true}"#),
        ),
        "@ai-sdk/cohere" => (
            "high",
            json(r#"{"thinking":{"type":"disabled"}}"#),
            json(r#"{"thinking":{"type":"enabled"}}"#),
        ),
        "@jerome-benoit/sap-ai-provider-v2" => {
            let (left, right) = if id.contains("gemini") {
                (
                    json(r#"{"thinkingConfig":{"includeThoughts":false,"thinkingBudget":0}}"#),
                    json(r#"{"thinkingConfig":{"includeThoughts":true,"thinkingBudget":-1}}"#),
                )
            } else if id.contains("cohere") {
                (
                    json(r#"{"thinking":{"type":"disabled"}}"#),
                    json(r#"{"thinking":{"type":"enabled"}}"#),
                )
            } else if id.contains("amazon--nova") {
                (
                    json(r#"{"additionalModelRequestFields":{"thinking":{"type":"disabled"}}}"#),
                    json(r#"{"additionalModelRequestFields":{"thinking":{"type":"enabled"}}}"#),
                )
            } else if id.contains("anthropic") {
                (
                    json(r#"{"additionalModelRequestFields":{"thinking":{"type":"disabled"}}}"#),
                    json(
                        r#"{"additionalModelRequestFields":{"thinking":{"type":"adaptive","display":"summarized"}}}"#,
                    ),
                )
            } else {
                return vec![];
            };
            (
                "thinking",
                object(&[("modelParams", left)]),
                object(&[("modelParams", right)]),
            )
        }
        _ => return vec![],
    };
    vec![("none", pair.1), (pair.0, pair.2)]
}
fn for_budget(npm: &str, id: &str, budget: f64) -> Option<JsonValue> {
    let number = JsonValue::Number(budget);
    match npm {
        "@openrouter/ai-sdk-provider" => {
            Some(object(&[("reasoning", object(&[("max_tokens", number)]))]))
        }
        "@ai-sdk/anthropic" | "@ai-sdk/google-vertex/anthropic" => Some(object(&[(
            "thinking",
            object(&[
                ("type", JsonValue::String("enabled".into())),
                ("budgetTokens", number),
            ]),
        )])),
        "@ai-sdk/google" | "@ai-sdk/google-vertex" => Some(object(&[(
            "thinkingConfig",
            object(&[
                ("includeThoughts", JsonValue::Bool(true)),
                ("thinkingBudget", number),
            ]),
        )])),
        "@ai-sdk/amazon-bedrock" => Some(object(&[(
            "reasoningConfig",
            object(&[
                ("type", JsonValue::String("enabled".into())),
                ("budgetTokens", number),
            ]),
        )])),
        "@ai-sdk/gateway" => gateway(id)
            .map(|npm| for_budget(npm, id, budget))
            .unwrap_or_else(|| for_budget("@openrouter/ai-sdk-provider", id, budget)),
        "@ai-sdk/cohere" => Some(object(&[(
            "thinking",
            object(&[
                ("type", JsonValue::String("enabled".into())),
                ("tokenBudget", number),
            ]),
        )])),
        "@ai-sdk/alibaba" => Some(object(&[
            ("enableThinking", JsonValue::Bool(true)),
            ("thinkingBudget", number),
        ])),
        "@jerome-benoit/sap-ai-provider-v2" => Some(object(&[(
            "modelParams",
            if id.contains("anthropic") {
                object(&[(
                    "additionalModelRequestFields",
                    object(&[(
                        "thinking",
                        object(&[
                            ("type", JsonValue::String("enabled".into())),
                            ("budget_tokens", number),
                        ]),
                    )]),
                )])
            } else if id.contains("gemini") {
                object(&[(
                    "thinkingConfig",
                    object(&[
                        ("includeThoughts", JsonValue::Bool(true)),
                        ("thinkingBudget", number),
                    ]),
                )])
            } else if id.contains("cohere") {
                object(&[(
                    "thinking",
                    object(&[
                        ("type", JsonValue::String("enabled".into())),
                        ("token_budget", number),
                    ]),
                )])
            } else {
                return None;
            },
        )])),
        _ => None,
    }
}
