use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder, domain,
};
use crate::{
    model, money, provider_request,
    schema::{NonNegativeInt, PositiveInt},
};
#[derive(Clone, Debug, PartialEq)]
pub struct Mechanism(pub LosslessString);
impl DomainDecode for Mechanism {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        domain::literal_enum(
            v,
            &[
                "openai-prefix-cache",
                "openrouter-cache-control",
                "anthropic-cache-control",
                "bedrock-cache-point",
                "gemini-prefix-cache",
                "provider-reported",
                "none",
            ],
            p,
        )
        .map(Self)
    }
}
impl DomainEncode for Mechanism {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ProviderCache {
    pub mechanism: Mechanism,
    pub read_reported: bool,
    pub write_reported: bool,
}
#[derive(Clone, Debug, PartialEq)]
pub struct ContextBreakdown {
    pub system: NonNegativeInt,
    pub tools: NonNegativeInt,
    pub user: NonNegativeInt,
    pub assistant: NonNegativeInt,
    pub reasoning: NonNegativeInt,
    pub tool_calls: NonNegativeInt,
    pub other: NonNegativeInt,
}
#[derive(Clone, Debug, PartialEq)]
pub struct GenerationSpeed {
    pub estimated: Option<bool>,
    pub model: model::Ref,
    pub tokens: PositiveInt,
    pub duration_ns: PositiveInt,
    pub tokens_per_second: f64,
}
#[derive(Clone, Debug, PartialEq)]
pub struct GenerationSpeedHistory {
    pub model: Option<model::Ref>,
    pub unreported_reason: Option<LosslessString>,
    pub latest: Option<GenerationSpeed>,
    pub recent: Vec<GenerationSpeed>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Context {
    pub total: NonNegativeInt,
    pub limit: Option<NonNegativeInt>,
    pub remaining: Option<NonNegativeInt>,
    pub percent: Option<f64>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Tokens {
    pub uncached_input: NonNegativeInt,
    pub output: NonNegativeInt,
    pub reasoning: NonNegativeInt,
    pub cache_read: NonNegativeInt,
    pub cache_write: NonNegativeInt,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Cache {
    pub eligible: NonNegativeInt,
    pub hit_ratio: Option<f64>,
    pub mechanism: Mechanism,
    pub read_reported: bool,
    pub write_reported: bool,
    pub minimum_tokens: Option<NonNegativeInt>,
    pub below_minimum: Option<bool>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub model: model::Ref,
    pub context_breakdown: Option<ContextBreakdown>,
    pub context: Context,
    pub tokens: Tokens,
    pub cache: Cache,
    pub estimated_cost: Option<money::Usd>,
    pub requests: Option<provider_request::Summary>,
    pub generation_speed: Option<GenerationSpeedHistory>,
}
impl DomainDecode for ProviderCache {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            mechanism: o.field("mechanism")?,
            read_reported: o.field("readReported")?,
            write_reported: o.field("writeReported")?,
        })
    }
}
impl DomainEncode for ProviderCache {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("mechanism", &self.mechanism)
            .field("readReported", &self.read_reported)
            .field("writeReported", &self.write_reported)
            .finish()
    }
}
impl DomainDecode for ContextBreakdown {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            system: o.field("system")?,
            tools: o.field("tools")?,
            user: o.field("user")?,
            assistant: o.field("assistant")?,
            reasoning: o.field("reasoning")?,
            tool_calls: o.field("toolCalls")?,
            other: o.field("other")?,
        })
    }
}
impl DomainEncode for ContextBreakdown {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("system", &self.system)
            .field("tools", &self.tools)
            .field("user", &self.user)
            .field("assistant", &self.assistant)
            .field("reasoning", &self.reasoning)
            .field("toolCalls", &self.tool_calls)
            .field("other", &self.other)
            .finish()
    }
}
impl DomainDecode for GenerationSpeed {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let rate = domain::finite_number(
            &o.field::<JsonValue>("tokensPerSecond")?,
            &p.key("tokensPerSecond"),
        )?;
        if rate <= 0.0 {
            return Err(p
                .key("tokensPerSecond")
                .error(crate::DecodeErrorKind::NumberRange {
                    minimum: f64::MIN_POSITIVE,
                    maximum: f64::MAX,
                    integer: false,
                }));
        }
        Ok(Self {
            estimated: o.optional("estimated")?,
            model: o.field("model")?,
            tokens: o.field("tokens")?,
            duration_ns: o.field("durationNs")?,
            tokens_per_second: rate,
        })
    }
}
impl DomainEncode for GenerationSpeed {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("estimated", &self.estimated)
            .field("model", &self.model)
            .field("tokens", &self.tokens)
            .field("durationNs", &self.duration_ns)
            .field("tokensPerSecond", &self.tokens_per_second)
            .finish()
    }
}
impl DomainDecode for GenerationSpeedHistory {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let recent: Vec<GenerationSpeed> = o.field("recent")?;
        if recent.len() > 8 {
            return Err(p.key("recent").error(crate::DecodeErrorKind::Length {
                minimum: 0,
                maximum: 8,
            }));
        }
        Ok(Self {
            model: o.optional("model")?,
            unreported_reason: o.optional("unreportedReason")?,
            latest: o.optional("latest")?,
            recent,
        })
    }
}
impl DomainEncode for GenerationSpeedHistory {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("model", &self.model)
            .optional("unreportedReason", &self.unreported_reason)
            .optional("latest", &self.latest)
            .field("recent", &self.recent)
            .finish()
    }
}
impl DomainDecode for Context {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let percent = o
            .optional::<f64>("percent")?
            .map(|x| domain::finite_number(&JsonValue::Number(x), &p.key("percent")))
            .transpose()?;
        Ok(Self {
            total: o.field("total")?,
            limit: o.optional("limit")?,
            remaining: o.optional("remaining")?,
            percent,
        })
    }
}
impl DomainEncode for Context {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("total", &self.total)
            .optional("limit", &self.limit)
            .optional("remaining", &self.remaining)
            .optional("percent", &self.percent)
            .finish()
    }
}
impl DomainDecode for Tokens {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            uncached_input: o.field("uncachedInput")?,
            output: o.field("output")?,
            reasoning: o.field("reasoning")?,
            cache_read: o.field("cacheRead")?,
            cache_write: o.field("cacheWrite")?,
        })
    }
}
impl DomainEncode for Tokens {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("uncachedInput", &self.uncached_input)
            .field("output", &self.output)
            .field("reasoning", &self.reasoning)
            .field("cacheRead", &self.cache_read)
            .field("cacheWrite", &self.cache_write)
            .finish()
    }
}
impl DomainDecode for Cache {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let hit_ratio = o
            .optional::<f64>("hitRatio")?
            .map(|x| domain::finite_number(&JsonValue::Number(x), &p.key("hitRatio")))
            .transpose()?;
        Ok(Self {
            eligible: o.field("eligible")?,
            hit_ratio,
            mechanism: o.field("mechanism")?,
            read_reported: o.field("readReported")?,
            write_reported: o.field("writeReported")?,
            minimum_tokens: o.optional("minimumTokens")?,
            below_minimum: o.optional("belowMinimum")?,
        })
    }
}
impl DomainEncode for Cache {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("eligible", &self.eligible)
            .optional("hitRatio", &self.hit_ratio)
            .field("mechanism", &self.mechanism)
            .field("readReported", &self.read_reported)
            .field("writeReported", &self.write_reported)
            .optional("minimumTokens", &self.minimum_tokens)
            .optional("belowMinimum", &self.below_minimum)
            .finish()
    }
}
impl DomainDecode for Info {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            model: o.field("model")?,
            context_breakdown: o.optional("contextBreakdown")?,
            context: o.field("context")?,
            tokens: o.field("tokens")?,
            cache: o.field("cache")?,
            estimated_cost: o.optional("estimatedCost")?,
            requests: o.optional("requests")?,
            generation_speed: o.optional("generationSpeed")?,
        })
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("model", &self.model)
            .optional("contextBreakdown", &self.context_breakdown)
            .field("context", &self.context)
            .field("tokens", &self.tokens)
            .field("cache", &self.cache)
            .optional("estimatedCost", &self.estimated_cost)
            .optional("requests", &self.requests)
            .optional("generationSpeed", &self.generation_speed)
            .finish()
    }
}
