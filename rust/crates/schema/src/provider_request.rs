use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    ObjectDecoder, ObjectEncoder, domain,
};
use crate::{
    agent, model, money,
    schema::{DateTimeUtcFromMillis, NonNegativeInt, PositiveInt},
    session_id::SessionId,
    session_message_id::Id as MessageId,
    token_usage,
};
crate::schema::string_type!(Id, "prq_");
macro_rules! literal_type {($name:ident[$($value:literal),+])=>{#[derive(Clone,Debug,PartialEq)]pub struct $name(pub LosslessString);impl DomainDecode for $name{fn decode_at(v:&JsonValue,p:&JsonPath)->Result<Self,DecodeError>{domain::literal_enum(v,&[$($value),+],p).map(Self)}}impl DomainEncode for $name{fn encode(&self)->JsonValue{self.0.encode()}}}}
literal_type!(Source["step","title","goal","compaction","decision","prediction","prompt"]);
crate::schema::literal_enum_type!(Outcome, { Completed => "completed", Failed => "failed", Cancelled => "cancelled" });
crate::schema::record_type!(Outcomes { completed: NonNegativeInt => "completed", failed: NonNegativeInt => "failed", cancelled: NonNegativeInt => "cancelled" } {});
crate::schema::record_type!(ReceivedOutput { estimated_tokens: PositiveInt => "estimatedTokens", duration_ns: PositiveInt => "durationNs" } {});
literal_type!(Invalidation["first-request","compaction-reset","model-switched","model-variant-switched","stable-hit","prefix-changed","system-prefix-changed","tool-prefix-changed","below-minimum","provider-not-reported","cache-disabled","retry-fallback"]);
literal_type!(Continuation["full","continued","fallback"]);
literal_type!(CostProvenance["recorded","current_catalog"]);
literal_type!(ReportGroup["model","hour","day","month","session","project","agent","provider","provider-profile-model","provider-model","model-id","profile","prompt","task"]);
mod dimensions;
pub use dimensions::{Attribution, ReportDimensions};
literal_type!(ReportOrder["asc","desc"]);
literal_type!(ReportSort["key","tokens","cost","steps","input","output","reasoning","cacheRead","cacheWrite"]);
#[derive(Clone, Debug, PartialEq)]
pub struct CostCoverage {
    pub priced_requests: NonNegativeInt,
    pub unpriced_requests: NonNegativeInt,
}
impl DomainDecode for CostCoverage {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            priced_requests: o.field("pricedRequests")?,
            unpriced_requests: o.field("unpricedRequests")?,
        })
    }
}
impl DomainEncode for CostCoverage {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("pricedRequests", &self.priced_requests)
            .field("unpricedRequests", &self.unpriced_requests)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Timing {
    pub received_output: Option<ReceivedOutput>,
    pub estimated_tokens: Option<PositiveInt>,
    pub estimated_generation_duration_ns: Option<PositiveInt>,
    pub first_output_ms: Option<NonNegativeInt>,
    pub total_ms: Option<NonNegativeInt>,
    pub retry_wait_ms: Option<NonNegativeInt>,
    pub prompt_eval_duration_ns: Option<NonNegativeInt>,
    pub generation_duration_ns: Option<NonNegativeInt>,
    pub observed_generation_duration_ns: Option<PositiveInt>,
    pub generated_tokens: Option<PositiveInt>,
    pub load_duration_ns: Option<NonNegativeInt>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Speed {
    pub generation_p95_tokens_per_second: Option<f64>,
    pub mean_tokens_per_second: Option<f64>,
    pub first_output_p99_ms: Option<NonNegativeInt>,
    pub total_p99_ms: Option<NonNegativeInt>,
    pub generation_samples: NonNegativeInt,
    pub provider_timed_samples: NonNegativeInt,
    pub observed_samples: NonNegativeInt,
    pub generation_p50_tokens_per_second: Option<f64>,
    pub generation_p90_tokens_per_second: Option<f64>,
    pub first_output_p50_ms: Option<NonNegativeInt>,
    pub first_output_p95_ms: Option<NonNegativeInt>,
    pub total_p50_ms: Option<NonNegativeInt>,
    pub total_p95_ms: Option<NonNegativeInt>,
    pub output_tokens_per_second: Option<f64>,
    pub samples: NonNegativeInt,
}
#[derive(Clone, Debug, PartialEq)]
pub struct ReportInput {
    pub provider_id: Option<crate::provider::Id>,
    pub model_id: Option<model::Id>,
    pub profile: Option<model::ProfileName>,
    pub selected_effort: Option<LosslessString>,
    pub group: ReportGroup,
    pub time_zone: Option<LosslessString>,
    pub from: Option<NonNegativeInt>,
    pub to: Option<NonNegativeInt>,
    pub offset: Option<NonNegativeInt>,
    pub limit: Option<PositiveInt>,
    pub sort: Option<ReportSort>,
    pub order: Option<ReportOrder>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    pub outcome: Option<Outcome>,
    pub id: Id,
    pub session_id: SessionId,
    pub input_id: Option<MessageId>,
    pub usage_anchor: Option<crate::usage_anchor::Ref>,
    pub assistant_message_id: Option<MessageId>,
    pub connection_identity_digest: Option<LosslessString>,
    pub source: Source,
    pub agent: agent::Id,
    pub model: model::Ref,
    pub route_id: LosslessString,
    pub prompt_cache_key: LosslessString,
    pub system_digest: LosslessString,
    pub tool_digest: LosslessString,
    pub request: PositiveInt,
    pub attempts: PositiveInt,
    pub invalidation: Invalidation,
    pub continuation: Continuation,
    pub cache_read_reported: Option<bool>,
    pub timing: Option<Timing>,
    pub cost: Option<money::Usd>,
    pub tokens: token_usage::Info,
    pub time: DateTimeUtcFromMillis,
}
#[derive(Clone, Debug, PartialEq)]
pub struct ModelSpend {
    pub model: model::Ref,
    pub requests: NonNegativeInt,
    pub tokens: token_usage::Info,
    pub cache_read_reported: Option<bool>,
    pub cost: Option<money::Usd>,
    pub cost_provenance: Option<CostProvenance>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct ReportMetrics {
    pub outcomes: Option<Outcomes>,
    pub cost_coverage: Option<CostCoverage>,
    pub logical: NonNegativeInt,
    pub physical: NonNegativeInt,
    pub helpers: NonNegativeInt,
    pub continued: NonNegativeInt,
    pub fallback: NonNegativeInt,
    pub tokens: token_usage::Info,
    pub cost: Option<money::Usd>,
    pub cost_provenance: Option<CostProvenance>,
    pub cache_read_reported: Option<bool>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Summary {
    pub logical: NonNegativeInt,
    pub physical: NonNegativeInt,
    pub helpers: NonNegativeInt,
    pub continued: NonNegativeInt,
    pub fallback: NonNegativeInt,
    pub cache_read_reported: Option<bool>,
    pub cost: Option<money::Usd>,
    pub models: Option<Vec<ModelSpend>>,
    pub tokens: token_usage::Info,
    pub latest_invalidation: Option<Invalidation>,
    pub latest_namespace: Option<LosslessString>,
    pub latest_timing: Option<Timing>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct ReportRow {
    pub concurrency: Option<f64>,
    pub model: Option<model::Ref>,
    pub dimensions: Option<ReportDimensions>,
    pub key: LosslessString,
    pub label: LosslessString,
    pub metrics: ReportMetrics,
    pub speed: Option<Speed>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Report {
    pub speed: Option<Speed>,
    pub group: ReportGroup,
    pub rows: Vec<ReportRow>,
    pub total: ReportMetrics,
    pub row_count: NonNegativeInt,
    pub next_offset: Option<NonNegativeInt>,
}
impl DomainDecode for Timing {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            received_output: o.optional("receivedOutput")?,
            estimated_tokens: o.optional("estimatedTokens")?,
            estimated_generation_duration_ns: o.optional("estimatedGenerationDurationNs")?,
            first_output_ms: o.optional("firstOutputMs")?,
            total_ms: o.optional("totalMs")?,
            retry_wait_ms: o.optional("retryWaitMs")?,
            prompt_eval_duration_ns: o.optional("promptEvalDurationNs")?,
            generation_duration_ns: o.optional("generationDurationNs")?,
            observed_generation_duration_ns: o.optional("observedGenerationDurationNs")?,
            generated_tokens: o.optional("generatedTokens")?,
            load_duration_ns: o.optional("loadDurationNs")?,
        })
    }
}
impl DomainEncode for Timing {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("firstOutputMs", &self.first_output_ms)
            .optional("totalMs", &self.total_ms)
            .optional("retryWaitMs", &self.retry_wait_ms)
            .optional("promptEvalDurationNs", &self.prompt_eval_duration_ns)
            .optional("generationDurationNs", &self.generation_duration_ns)
            .optional(
                "observedGenerationDurationNs",
                &self.observed_generation_duration_ns,
            )
            .optional("generatedTokens", &self.generated_tokens)
            .optional("estimatedTokens", &self.estimated_tokens)
            .optional(
                "estimatedGenerationDurationNs",
                &self.estimated_generation_duration_ns,
            )
            .optional("receivedOutput", &self.received_output)
            .optional("loadDurationNs", &self.load_duration_ns)
            .finish()
    }
}
impl DomainDecode for Speed {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let rate = o
            .optional::<f64>("outputTokensPerSecond")?
            .map(|x| {
                domain::number_range(
                    &JsonValue::Number(x),
                    0.0,
                    f64::MAX,
                    &p.key("outputTokensPerSecond"),
                )
            })
            .transpose()?;
        Ok(Self {
            generation_p95_tokens_per_second: nonnegative_rate(
                &o,
                p,
                "generationP95TokensPerSecond",
            )?,
            mean_tokens_per_second: nonnegative_rate(&o, p, "meanTokensPerSecond")?,
            first_output_p99_ms: o.optional("firstOutputP99Ms")?,
            total_p99_ms: o.optional("totalP99Ms")?,
            generation_samples: o.field("generationSamples")?,
            provider_timed_samples: o.field("providerTimedSamples")?,
            observed_samples: o.field("observedSamples")?,
            generation_p50_tokens_per_second: nonnegative_rate(
                &o,
                p,
                "generationP50TokensPerSecond",
            )?,
            generation_p90_tokens_per_second: nonnegative_rate(
                &o,
                p,
                "generationP90TokensPerSecond",
            )?,
            first_output_p50_ms: o.optional("firstOutputP50Ms")?,
            first_output_p95_ms: o.optional("firstOutputP95Ms")?,
            total_p50_ms: o.optional("totalP50Ms")?,
            total_p95_ms: o.optional("totalP95Ms")?,
            output_tokens_per_second: rate,
            samples: o.field("samples")?,
        })
    }
}
impl DomainEncode for Speed {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("generationSamples", &self.generation_samples)
            .optional(
                "generationP50TokensPerSecond",
                &self.generation_p50_tokens_per_second,
            )
            .optional(
                "generationP90TokensPerSecond",
                &self.generation_p90_tokens_per_second,
            )
            .optional(
                "generationP95TokensPerSecond",
                &self.generation_p95_tokens_per_second,
            )
            .optional("meanTokensPerSecond", &self.mean_tokens_per_second)
            .field("providerTimedSamples", &self.provider_timed_samples)
            .field("observedSamples", &self.observed_samples)
            .optional("firstOutputP50Ms", &self.first_output_p50_ms)
            .optional("firstOutputP95Ms", &self.first_output_p95_ms)
            .optional("firstOutputP99Ms", &self.first_output_p99_ms)
            .optional("totalP50Ms", &self.total_p50_ms)
            .optional("totalP95Ms", &self.total_p95_ms)
            .optional("totalP99Ms", &self.total_p99_ms)
            .optional("outputTokensPerSecond", &self.output_tokens_per_second)
            .field("samples", &self.samples)
            .finish()
    }
}
impl DomainDecode for ReportInput {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let result = Self {
            group: o.field("group")?,
            provider_id: o.optional("providerID")?,
            model_id: o.optional("modelID")?,
            profile: o.optional("profile")?,
            selected_effort: o.optional("selectedEffort")?,
            time_zone: o.optional("timeZone")?,
            from: o.optional("from")?,
            to: o.optional("to")?,
            offset: o.optional("offset")?,
            limit: o.optional("limit")?,
            sort: o
                .optional::<LosslessString>("sort")?
                .map(|x| ReportSort::decode_at(&x.encode(), &p.key("sort")))
                .transpose()?,
            order: o
                .optional::<LosslessString>("order")?
                .map(|x| ReportOrder::decode_at(&x.encode(), &p.key("order")))
                .transpose()?,
        };
        if result
            .selected_effort
            .as_ref()
            .is_some_and(|value| value.is_empty())
        {
            return Err(p
                .key("selectedEffort")
                .error(DecodeErrorKind::Expected("nonempty string")));
        }
        if let (Some(from), Some(to)) = (result.from, result.to)
            && from.get() >= to.get()
        {
            return Err(p.error(DecodeErrorKind::Expected("from before to")));
        }
        if let Some(zone) = &result.time_zone
            && (zone.is_empty() || zone.len() > 128)
        {
            return Err(p.key("timeZone").error(DecodeErrorKind::Length {
                minimum: 1,
                maximum: 128,
            }));
        }
        if result.limit.is_some_and(|x| x.get() > 200) {
            return Err(p.key("limit").error(DecodeErrorKind::NumberRange {
                minimum: 1.0,
                maximum: 200.0,
                integer: true,
            }));
        }
        Ok(result)
    }
}
impl DomainEncode for ReportInput {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("group", &self.group)
            .optional("providerID", &self.provider_id)
            .optional("profile", &self.profile)
            .optional("modelID", &self.model_id)
            .optional("selectedEffort", &self.selected_effort)
            .optional("timeZone", &self.time_zone)
            .optional("from", &self.from)
            .optional("to", &self.to)
            .optional("offset", &self.offset)
            .optional("limit", &self.limit)
            .optional("sort", &self.sort)
            .optional("order", &self.order)
            .finish()
    }
}
impl DomainDecode for Record {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let digest = o.optional::<LosslessString>("connectionIdentityDigest")?;
        if let Some(x) = &digest {
            let _ =
                domain::bounded_string(&x.encode(), 64, 64, &p.key("connectionIdentityDigest"))?;
            if !x.as_str().is_some_and(|x| {
                x.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            }) {
                return Err(p
                    .key("connectionIdentityDigest")
                    .error(DecodeErrorKind::Expected("lowercase sha256 digest")));
            }
        }
        Ok(Self {
            id: o.field("id")?,
            outcome: o.optional("outcome")?,
            session_id: o.field("sessionID")?,
            input_id: o.optional("inputID")?,
            usage_anchor: o.optional("usageAnchor")?,
            assistant_message_id: o.optional("assistantMessageID")?,
            connection_identity_digest: digest,
            source: o
                .tag(
                    "source",
                    &[
                        "step",
                        "title",
                        "goal",
                        "compaction",
                        "decision",
                        "prediction",
                        "prompt",
                    ],
                )
                .map(Source)?,
            agent: o.field("agent")?,
            model: o.field("model")?,
            route_id: o.field("routeID")?,
            prompt_cache_key: o.field("promptCacheKey")?,
            system_digest: o.field("systemDigest")?,
            tool_digest: o.field("toolDigest")?,
            request: o.field("request")?,
            attempts: o.field("attempts")?,
            invalidation: o
                .tag(
                    "invalidation",
                    &[
                        "first-request",
                        "compaction-reset",
                        "model-switched",
                        "model-variant-switched",
                        "stable-hit",
                        "prefix-changed",
                        "system-prefix-changed",
                        "tool-prefix-changed",
                        "below-minimum",
                        "provider-not-reported",
                        "cache-disabled",
                        "retry-fallback",
                    ],
                )
                .map(Invalidation)?,
            continuation: o
                .tag("continuation", &["full", "continued", "fallback"])
                .map(Continuation)?,
            cache_read_reported: o.optional("cacheReadReported")?,
            timing: o.optional("timing")?,
            cost: o.optional("cost")?,
            tokens: o.field("tokens")?,
            time: o.field("time")?,
        })
    }
}
impl DomainEncode for Record {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("sessionID", &self.session_id)
            .optional("inputID", &self.input_id)
            .optional("usageAnchor", &self.usage_anchor)
            .optional("assistantMessageID", &self.assistant_message_id)
            .optional("connectionIdentityDigest", &self.connection_identity_digest)
            .field("source", &self.source)
            .field("agent", &self.agent)
            .field("model", &self.model)
            .field("routeID", &self.route_id)
            .field("promptCacheKey", &self.prompt_cache_key)
            .field("systemDigest", &self.system_digest)
            .field("toolDigest", &self.tool_digest)
            .field("request", &self.request)
            .field("attempts", &self.attempts)
            .field("invalidation", &self.invalidation)
            .field("continuation", &self.continuation)
            .optional("cacheReadReported", &self.cache_read_reported)
            .optional("timing", &self.timing)
            .optional("outcome", &self.outcome)
            .optional("cost", &self.cost)
            .field("tokens", &self.tokens)
            .field("time", &self.time)
            .finish()
    }
}
type CostFields = (Option<money::Usd>, Option<CostProvenance>, Option<bool>);
fn cost_fields(o: &ObjectDecoder<'_>, p: &JsonPath) -> Result<CostFields, DecodeError> {
    let cost = o.optional("cost")?;
    let provenance = o
        .optional::<LosslessString>("costProvenance")?
        .map(|x| CostProvenance::decode_at(&x.encode(), &p.key("costProvenance")))
        .transpose()?;
    let cache = o.optional("cacheReadReported")?;
    if cost.is_some() != provenance.is_some() {
        return Err(p.error(DecodeErrorKind::Expected(
            "cost and cost provenance together",
        )));
    }
    Ok((cost, provenance, cache))
}
fn metrics(o: &ObjectDecoder<'_>, p: &JsonPath) -> Result<ReportMetrics, DecodeError> {
    let (cost, cost_provenance, cache_read_reported) = cost_fields(o, p)?;
    Ok(ReportMetrics {
        outcomes: o.optional("outcomes")?,
        cost_coverage: o.optional("costCoverage")?,
        logical: o.field("logical")?,
        physical: o.field("physical")?,
        helpers: o.field("helpers")?,
        continued: o.field("continued")?,
        fallback: o.field("fallback")?,
        tokens: o.field("tokens")?,
        cost,
        cost_provenance,
        cache_read_reported,
    })
}
impl DomainDecode for ReportMetrics {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        metrics(&ObjectDecoder::new(v, p)?, p)
    }
}
impl DomainEncode for ReportMetrics {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("logical", &self.logical)
            .field("physical", &self.physical)
            .field("helpers", &self.helpers)
            .field("continued", &self.continued)
            .field("fallback", &self.fallback)
            .optional("costCoverage", &self.cost_coverage)
            .field("tokens", &self.tokens)
            .optional("cost", &self.cost)
            .optional("costProvenance", &self.cost_provenance)
            .optional("cacheReadReported", &self.cache_read_reported)
            .optional("outcomes", &self.outcomes)
            .finish()
    }
}
impl DomainDecode for ModelSpend {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let (cost, cost_provenance, cache_read_reported) = cost_fields(&o, p)?;
        Ok(Self {
            model: o.field("model")?,
            requests: o.field("requests")?,
            tokens: o.field("tokens")?,
            cache_read_reported,
            cost,
            cost_provenance,
        })
    }
}
impl DomainEncode for ModelSpend {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("model", &self.model)
            .field("requests", &self.requests)
            .field("tokens", &self.tokens)
            .optional("cacheReadReported", &self.cache_read_reported)
            .optional("cost", &self.cost)
            .optional("costProvenance", &self.cost_provenance)
            .finish()
    }
}
impl DomainDecode for Summary {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let latest_namespace = o.optional::<LosslessString>("latestNamespace")?;
        if let Some(x) = &latest_namespace {
            domain::bounded_string(&x.encode(), 8, 8, &p.key("latestNamespace"))?;
        }
        Ok(Self {
            logical: o.field("logical")?,
            physical: o.field("physical")?,
            helpers: o.field("helpers")?,
            continued: o.field("continued")?,
            fallback: o.field("fallback")?,
            cache_read_reported: o.optional("cacheReadReported")?,
            cost: o.optional("cost")?,
            models: o.optional("models")?,
            tokens: o.field("tokens")?,
            latest_invalidation: o
                .optional::<LosslessString>("latestInvalidation")?
                .map(|x| Invalidation::decode_at(&x.encode(), &p.key("latestInvalidation")))
                .transpose()?,
            latest_namespace,
            latest_timing: o.optional("latestTiming")?,
        })
    }
}
impl DomainEncode for Summary {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("logical", &self.logical)
            .field("physical", &self.physical)
            .field("helpers", &self.helpers)
            .field("continued", &self.continued)
            .field("fallback", &self.fallback)
            .optional("cacheReadReported", &self.cache_read_reported)
            .optional("cost", &self.cost)
            .optional("models", &self.models)
            .field("tokens", &self.tokens)
            .optional("latestInvalidation", &self.latest_invalidation)
            .optional("latestNamespace", &self.latest_namespace)
            .optional("latestTiming", &self.latest_timing)
            .finish()
    }
}
impl DomainDecode for ReportRow {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            concurrency: nonnegative_rate(&o, p, "concurrency")?,
            model: o.optional("model")?,
            dimensions: o.optional("dimensions")?,
            key: o.field("key")?,
            label: o.field("label")?,
            metrics: metrics(&o, p)?,
            speed: o.optional("speed")?,
        })
    }
}
impl DomainEncode for ReportRow {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("key", &self.key)
            .field("label", &self.label)
            .optional("model", &self.model)
            .optional("dimensions", &self.dimensions)
            .field("logical", &self.metrics.logical)
            .field("physical", &self.metrics.physical)
            .field("helpers", &self.metrics.helpers)
            .field("continued", &self.metrics.continued)
            .field("fallback", &self.metrics.fallback)
            .optional("costCoverage", &self.metrics.cost_coverage)
            .field("tokens", &self.metrics.tokens)
            .optional("cost", &self.metrics.cost)
            .optional("costProvenance", &self.metrics.cost_provenance)
            .optional("cacheReadReported", &self.metrics.cache_read_reported)
            .optional("outcomes", &self.metrics.outcomes)
            .optional("speed", &self.speed)
            .optional("concurrency", &self.concurrency)
            .finish()
    }
}
impl DomainDecode for Report {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let result = Self {
            group: o.field("group")?,
            speed: o.optional("speed")?,
            rows: o.field("rows")?,
            total: o.field("total")?,
            row_count: o.field("rowCount")?,
            next_offset: o.optional("nextOffset")?,
        };
        if matches!(
            result.group.0.as_str(),
            Some(
                "provider"
                    | "provider-profile-model"
                    | "provider-model"
                    | "model-id"
                    | "profile"
                    | "prompt"
                    | "task"
            )
        ) && result.rows.iter().any(|row| {
            row.model.is_some()
                || row.dimensions.as_ref().is_none_or(|dimensions| {
                    dimensions.group() != result.group.0.as_str().unwrap_or_default()
                })
        }) {
            return Err(p.error(DecodeErrorKind::Expected(
                "matching usage dimensions without a representative model",
            )));
        }
        Ok(result)
    }
}
impl DomainEncode for Report {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("group", &self.group)
            .field("rows", &self.rows)
            .field("total", &self.total)
            .field("rowCount", &self.row_count)
            .optional("nextOffset", &self.next_offset)
            .optional("speed", &self.speed)
            .finish()
    }
}

fn nonnegative_rate(
    o: &ObjectDecoder<'_>,
    p: &JsonPath,
    key: &str,
) -> Result<Option<f64>, DecodeError> {
    o.optional::<f64>(key)?
        .map(|value| domain::number_range(&JsonValue::Number(value), 0.0, f64::MAX, &p.key(key)))
        .transpose()
}
