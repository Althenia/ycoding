use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder, model, provider_request, provider_usage, schema::NonNegativeInt, usage_forecast,
};

crate::schema::record_type!(Input {} {
    daily: provider_request::ReportInput => "daily",
    monthly: provider_request::ReportInput => "monthly",
    breakdown: provider_request::ReportInput => "breakdown",
    refresh: bool => "refresh",
});
#[derive(Clone, Debug, PartialEq)]
pub struct LiveModel {
    pub model: model::Ref,
    pub active: NonNegativeInt,
    pub streaming: NonNegativeInt,
    pub output_tokens_per_second: Option<f64>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct LivePoint {
    pub at: NonNegativeInt,
    pub active: NonNegativeInt,
    pub output_tokens_per_second: Option<f64>,
}
fn rate(object: &ObjectDecoder<'_>, path: &JsonPath) -> Result<Option<f64>, DecodeError> {
    object
        .optional::<f64>("outputTokensPerSecond")?
        .map(|value| {
            crate::domain::number_range(
                &JsonValue::Number(value),
                0.0,
                f64::MAX,
                &path.key("outputTokensPerSecond"),
            )
        })
        .transpose()
}
impl DomainDecode for LiveModel {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            model: object.field("model")?,
            active: object.field("active")?,
            streaming: object.field("streaming")?,
            output_tokens_per_second: rate(&object, path)?,
        })
    }
}
impl DomainEncode for LiveModel {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("model", &self.model)
            .field("active", &self.active)
            .field("streaming", &self.streaming)
            .optional("outputTokensPerSecond", &self.output_tokens_per_second)
            .finish()
    }
}
impl DomainDecode for LivePoint {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            at: object.field("at")?,
            active: object.field("active")?,
            output_tokens_per_second: rate(&object, path)?,
        })
    }
}
impl DomainEncode for LivePoint {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("at", &self.at)
            .field("active", &self.active)
            .optional("outputTokensPerSecond", &self.output_tokens_per_second)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Live {
    pub as_of: NonNegativeInt,
    pub active: NonNegativeInt,
    pub streaming: NonNegativeInt,
    pub output_tokens_per_second: Option<f64>,
    pub models: Vec<LiveModel>,
    pub history: Vec<LivePoint>,
}
impl DomainDecode for Live {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let models: Vec<LiveModel> = object.field("models")?;
        let history: Vec<LivePoint> = object.field("history")?;
        if models.len() > 50 || history.len() > 120 {
            return Err(path.error(crate::DecodeErrorKind::Expected("bounded live history")));
        }
        let output_tokens_per_second = rate(&object, path)?;
        Ok(Self {
            as_of: object.field("asOf")?,
            active: object.field("active")?,
            streaming: object.field("streaming")?,
            output_tokens_per_second,
            models,
            history,
        })
    }
}
impl DomainEncode for Live {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("asOf", &self.as_of)
            .field("active", &self.active)
            .field("streaming", &self.streaming)
            .optional("outputTokensPerSecond", &self.output_tokens_per_second)
            .field("models", &self.models)
            .field("history", &self.history)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Quota {
    Preparing,
    Ready {
        providers: Vec<provider_usage::Snapshot>,
        forecast: usage_forecast::Info,
    },
    Error {
        message: LosslessString,
    },
}
impl DomainDecode for Quota {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        match object.field::<LosslessString>("status")?.as_str() {
            Some("preparing") => Ok(Self::Preparing),
            Some("ready") => Ok(Self::Ready {
                providers: object.field("providers")?,
                forecast: object.field("forecast")?,
            }),
            Some("error") => Ok(Self::Error {
                message: object.field("message")?,
            }),
            _ => Err(path
                .key("status")
                .error(crate::DecodeErrorKind::Expected("quota status"))),
        }
    }
}
impl DomainEncode for Quota {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Preparing => ObjectEncoder::new().field("status", "preparing").finish(),
            Self::Ready {
                providers,
                forecast,
            } => ObjectEncoder::new()
                .field("status", "ready")
                .field("providers", providers)
                .field("forecast", forecast)
                .finish(),
            Self::Error { message } => ObjectEncoder::new()
                .field("status", "error")
                .field("message", message)
                .finish(),
        }
    }
}
crate::schema::record_type!(Ready {
    as_of: NonNegativeInt => "asOf", revision: LosslessString => "revision",
    summary: provider_request::Summary => "summary", quota: Quota => "quota", live: Live => "live",
} { daily: provider_request::Report => "daily", monthly: provider_request::Report => "monthly", breakdown: provider_request::Report => "breakdown" });

#[derive(Clone, Debug, PartialEq)]
pub enum Info {
    Preparing,
    Error { message: LosslessString },
    Ready(Box<Ready>),
}
impl DomainDecode for Info {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        match object.field::<LosslessString>("status")?.as_str() {
            Some("preparing") => Ok(Self::Preparing),
            Some("error") => Ok(Self::Error {
                message: object.field("message")?,
            }),
            Some("ready") => Ready::decode_at(value, path).map(Box::new).map(Self::Ready),
            _ => Err(path
                .key("status")
                .error(crate::DecodeErrorKind::Expected("dashboard status"))),
        }
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Preparing => ObjectEncoder::new().field("status", "preparing").finish(),
            Self::Error { message } => ObjectEncoder::new()
                .field("status", "error")
                .field("message", message)
                .finish(),
            Self::Ready(ready) => {
                let JsonValue::Object(fields) = ready.encode() else {
                    unreachable!()
                };
                let mut object = crate::JsonObject::new();
                object.insert("status".into(), "ready".encode());
                for (key, value) in fields.iter() {
                    object.insert(key.clone(), value.clone());
                }
                JsonValue::Object(object)
            }
        }
    }
}
