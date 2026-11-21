use super::prompt_cache::sha256;
use ycoding_schema::{
    DecodeError, DecodeErrorKind, DomainDecode, JsonPath, JsonValue, ObjectDecoder, ObjectEncoder,
    schema::NonNegativeInt, stringify_json,
};

const ALGORITHM_REVISION: f64 = 4.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Advisory {
    Disabled,
    Thresholds {
        consider_percent: i64,
        strongly_advised_percent: i64,
    },
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Info {
    pub keep_recent_messages: Option<i64>,
    pub reserved_output_tokens: Option<i64>,
    pub context_safety_margin_tokens: Option<i64>,
    pub timeout_seconds: Option<i64>,
    pub max_output_tokens: Option<i64>,
    pub max_manifest_bytes: Option<i64>,
    pub max_internal_passes: Option<i64>,
    pub advisory: Option<Advisory>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Resolved {
    pub keep_recent_messages: i64,
    pub reserved_output_tokens: i64,
    pub context_safety_margin_tokens: i64,
    pub timeout_seconds: i64,
    pub max_output_tokens: i64,
    pub max_manifest_bytes: i64,
    pub max_internal_passes: i64,
    pub advisory: Advisory,
}

impl Default for Resolved {
    fn default() -> Self {
        Self {
            keep_recent_messages: 20,
            reserved_output_tokens: 0,
            context_safety_margin_tokens: 4_096,
            timeout_seconds: 60,
            max_output_tokens: 0,
            max_manifest_bytes: 65_536,
            max_internal_passes: 8,
            advisory: Advisory::Thresholds {
                consider_percent: 70,
                strongly_advised_percent: 90,
            },
        }
    }
}

pub fn resolve(infos: &[Info]) -> Resolved {
    infos
        .iter()
        .fold(Resolved::default(), |result, info| Resolved {
            keep_recent_messages: info
                .keep_recent_messages
                .unwrap_or(result.keep_recent_messages),
            reserved_output_tokens: info
                .reserved_output_tokens
                .unwrap_or(result.reserved_output_tokens),
            context_safety_margin_tokens: info
                .context_safety_margin_tokens
                .unwrap_or(result.context_safety_margin_tokens),
            timeout_seconds: info.timeout_seconds.unwrap_or(result.timeout_seconds),
            max_output_tokens: info.max_output_tokens.unwrap_or(result.max_output_tokens),
            max_manifest_bytes: info.max_manifest_bytes.unwrap_or(result.max_manifest_bytes),
            max_internal_passes: info
                .max_internal_passes
                .unwrap_or(result.max_internal_passes),
            advisory: info.advisory.unwrap_or(result.advisory),
        })
}

pub fn admission_digest(policy: &Resolved) -> String {
    let advisory = match policy.advisory {
        Advisory::Disabled => JsonValue::Bool(false),
        Advisory::Thresholds {
            consider_percent,
            strongly_advised_percent,
        } => ObjectEncoder::new()
            .field("considerPercent", &(consider_percent as f64))
            .field("stronglyAdvisedPercent", &(strongly_advised_percent as f64))
            .finish(),
    };
    sha256(&stringify_json(
        &ObjectEncoder::new()
            .field("revision", &ALGORITHM_REVISION)
            .field(
                "policy",
                &ObjectEncoder::new()
                    .field("keepRecentMessages", &(policy.keep_recent_messages as f64))
                    .field(
                        "reservedOutputTokens",
                        &(policy.reserved_output_tokens as f64),
                    )
                    .field(
                        "contextSafetyMarginTokens",
                        &(policy.context_safety_margin_tokens as f64),
                    )
                    .field("timeoutSeconds", &(policy.timeout_seconds as f64))
                    .field("maxOutputTokens", &(policy.max_output_tokens as f64))
                    .field("maxManifestBytes", &(policy.max_manifest_bytes as f64))
                    .field("maxInternalPasses", &(policy.max_internal_passes as f64))
                    .field("advisory", &advisory)
                    .finish(),
            )
            .finish(),
    ))
}

impl DomainDecode for Info {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let count = |name: &str| -> Result<Option<i64>, DecodeError> {
            Ok(object
                .optional::<NonNegativeInt>(name)?
                .map(|count| count.get()))
        };
        let advisory = match object.optional::<JsonValue>("advisory")? {
            None => None,
            Some(JsonValue::Bool(false)) => Some(Advisory::Disabled),
            Some(other) => {
                let path = path.key("advisory");
                let object = ObjectDecoder::new(&other, &path)?;
                let percent = |name: &str| -> Result<i64, DecodeError> {
                    let percent: NonNegativeInt = object.field(name)?;
                    if (1..=99).contains(&percent.get()) {
                        Ok(percent.get())
                    } else {
                        Err(path
                            .key(name)
                            .error(DecodeErrorKind::Expected("integer from 1 to 99")))
                    }
                };
                let consider = percent("consider_percent")?;
                let strongly = percent("strongly_advised_percent")?;
                if consider >= strongly {
                    return Err(path.error(DecodeErrorKind::Expected(
                        "consider_percent lower than strongly_advised_percent",
                    )));
                }
                Some(Advisory::Thresholds {
                    consider_percent: consider,
                    strongly_advised_percent: strongly,
                })
            }
        };
        Ok(Self {
            keep_recent_messages: count("keep_recent_messages")?,
            reserved_output_tokens: count("reserved_output_tokens")?,
            context_safety_margin_tokens: count("context_safety_margin_tokens")?,
            timeout_seconds: count("timeout_seconds")?,
            max_output_tokens: count("max_output_tokens")?,
            max_manifest_bytes: count("max_manifest_bytes")?,
            max_internal_passes: count("max_internal_passes")?,
            advisory,
        })
    }
}
