use ycoding_ai::llm;
use ycoding_schema::{DomainDecode, JsonValue, ObjectEncoder, model, token_usage};

pub fn tokens(usage: Option<&llm::Usage>) -> JsonValue {
    ObjectEncoder::new()
        .field(
            "input",
            &safe(usage.and_then(|usage| usage.non_cached_input_tokens)),
        )
        .field(
            "output",
            &usage.map_or(0.0, llm::Usage::visible_output_tokens),
        )
        .field(
            "reasoning",
            &safe(usage.and_then(|usage| usage.reasoning_tokens)),
        )
        .field(
            "cache",
            &ObjectEncoder::new()
                .field(
                    "read",
                    &safe(usage.and_then(|usage| usage.cache_read_input_tokens)),
                )
                .field(
                    "write",
                    &safe(usage.and_then(|usage| usage.cache_write_input_tokens)),
                )
                .finish(),
        )
        .finish()
}

pub fn timing(usage: Option<&llm::Usage>) -> Option<JsonValue> {
    let duration = |value: Option<f64>| {
        value.filter(|value| {
            value.is_finite()
                && *value >= 0.0
                && value.fract() == 0.0
                && *value <= 9007199254740991.0
        })
    };
    let timing = ObjectEncoder::new()
        .optional(
            "promptEvalDurationNs",
            &duration(usage.and_then(|usage| usage.prompt_eval_duration_ns)),
        )
        .optional(
            "generationDurationNs",
            &duration(usage.and_then(|usage| usage.generation_duration_ns)),
        )
        .optional(
            "loadDurationNs",
            &duration(usage.and_then(|usage| usage.load_duration_ns)),
        )
        .finish();
    matches!(&timing, JsonValue::Object(fields) if fields.iter().next().is_some()).then_some(timing)
}

#[derive(Default)]
pub struct GenerationTimes {
    pub text: Option<u64>,
    pub reasoning: Option<u64>,
    pub tool_input: Option<u64>,
    pub ended: Option<u64>,
}

pub fn generation_timing(usage: Option<&llm::Usage>, times: &GenerationTimes) -> Option<JsonValue> {
    let output = usage.map_or(0.0, llm::Usage::visible_output_tokens);
    let reasoning = safe(usage.and_then(|usage| usage.reasoning_tokens));
    let provider_timed = usage.is_some_and(|usage| usage.generation_duration_ns.is_some());
    let visible = times.text.into_iter().chain(times.tool_input).min();
    let folded = times.reasoning.is_some() && reasoning == 0.0;
    if !provider_timed
        && usage.is_some_and(|usage| usage.output_may_include_unreported_reasoning == Some(true))
        && reasoning == 0.0
    {
        return None;
    }
    let tokens = if provider_timed {
        output + reasoning
    } else if folded || visible.is_some() {
        output
    } else {
        0.0
    };
    if !tokens.is_finite()
        || tokens <= 0.0
        || tokens.fract() != 0.0
        || tokens > 9_007_199_254_740_991.0
    {
        return None;
    }
    if provider_timed {
        return Some(
            ObjectEncoder::new()
                .field("generatedTokens", &tokens)
                .finish(),
        );
    }
    let start = if folded {
        times.reasoning.into_iter().chain(visible).min()
    } else {
        visible
    }?;
    let duration = times
        .ended?
        .checked_sub(start)
        .filter(|duration| *duration >= 1_000_000_000 && *duration <= 9_007_199_254_740_991);
    Some(
        ObjectEncoder::new()
            .field("generatedTokens", &tokens)
            .optional(
                "observedGenerationDurationNs",
                &duration.map(|duration| duration as f64),
            )
            .finish(),
    )
}

pub fn one_hour_cache_writes(usage: Option<&llm::Usage>) -> Option<f64> {
    let usage = usage?;
    let JsonValue::Object(metadata) = usage.provider_metadata.as_ref()? else {
        return None;
    };
    let JsonValue::Object(anthropic) = metadata.get(&"anthropic".into())? else {
        return None;
    };
    let JsonValue::Object(creation) = anthropic.get(&"cache_creation".into())? else {
        return None;
    };
    let JsonValue::Number(count) = creation.get(&"ephemeral_1h_input_tokens".into())? else {
        return None;
    };
    (count.is_finite() && *count >= 0.0 && *count <= safe(usage.cache_write_input_tokens))
        .then_some(*count)
}

pub fn cost(costs: &[model::Cost], tokens: &JsonValue, one_hour_writes: Option<f64>) -> f64 {
    estimated_cost(costs, tokens, one_hour_writes).unwrap_or(0.0)
}

pub fn estimated_cost(
    costs: &[model::Cost],
    tokens: &JsonValue,
    one_hour_writes: Option<f64>,
) -> Option<f64> {
    let usage = token_usage::Info::decode(tokens).expect("normalized tokens encode usage");
    let context = usage.input.get() + usage.cache.read.get() + usage.cache.write.get();
    let cost = costs
        .iter()
        .filter(|cost| {
            cost.tier
                .as_ref()
                .is_some_and(|tier| context > tier.size.get() as f64)
        })
        .min_by_key(|cost| std::cmp::Reverse(cost.tier.as_ref().expect("tier exists").size.get()))
        .or_else(|| costs.iter().find(|cost| cost.tier.is_none()));
    cost.map(|cost| {
        let cache_write = match one_hour_writes.filter(|count| *count <= usage.cache.write.get()) {
            Some(one_hour) => {
                2.0 * one_hour * cost.input.get()
                    + (usage.cache.write.get() - one_hour) * cost.cache.write.get()
            }
            None => usage.cache.write.get() * cost.cache.write.get(),
        };
        (usage.input.get() * cost.input.get()
            + (usage.output.get() + usage.reasoning.get()) * cost.output.get()
            + usage.cache.read.get() * cost.cache.read.get()
            + cache_write)
            / 1_000_000.0
    })
}

fn safe(value: Option<f64>) -> f64 {
    value
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or(0.0)
}

pub(crate) fn apply(
    tx: &mut ycoding_store::Write<'_>,
    object: &ycoding_schema::ObjectDecoder<'_>,
    id: &ycoding_schema::LosslessString,
) -> Result<(), ycoding_store::Error> {
    use ycoding_store::session::SessionTable;
    let cost: ycoding_schema::money::Usd = object
        .field("cost")
        .map_err(super::projector::record_error)?;
    let tokens: token_usage::Info = object
        .field("tokens")
        .map_err(super::projector::record_error)?;
    let key = super::key(id);
    let Some(mut row) = tx.get::<SessionTable>(&key)? else {
        return Err(ycoding_store::Error::Rejected("Session not found"));
    };
    let add = |current: i64, value: f64| {
        if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > i64::MAX as f64 {
            return Err(ycoding_store::Error::Rejected("Invalid token usage"));
        }
        current
            .checked_add(value as i64)
            .ok_or(ycoding_store::Error::Rejected("Token usage overflow"))
    };
    row.cost += cost.get();
    row.tokens_input = add(row.tokens_input, tokens.input.get())?;
    row.tokens_output = add(row.tokens_output, tokens.output.get())?;
    row.tokens_reasoning = add(row.tokens_reasoning, tokens.reasoning.get())?;
    row.tokens_cache_read = add(row.tokens_cache_read, tokens.cache.read.get())?;
    row.tokens_cache_write = add(row.tokens_cache_write, tokens.cache.write.get())?;
    SessionTable::put(tx, &row)
}
