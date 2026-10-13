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
