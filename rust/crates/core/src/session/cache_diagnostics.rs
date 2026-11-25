use ycoding_ai::llm;
use ycoding_schema::{
    JsonValue, ObjectEncoder, model, provider_request, schema::PositiveInt,
    session_cache_diagnostics,
};

pub struct Reported {
    pub mechanism: &'static str,
    pub read: bool,
    pub write: bool,
}

pub fn reported(route_id: &str, provider_id: &str, usage: Option<&llm::Usage>) -> Reported {
    let read = usage.and_then(|usage| usage.cache_read_input_tokens);
    let write = usage.and_then(|usage| usage.cache_write_input_tokens);
    let cached =
        read.is_some_and(|tokens| tokens > 0.0) || write.is_some_and(|tokens| tokens > 0.0);
    Reported {
        mechanism: mechanism(route_id, provider_id, cached),
        read: read.is_some(),
        write: write.is_some(),
    }
}

pub fn provider_cache(route_id: &str, provider_id: &str, usage: Option<&llm::Usage>) -> JsonValue {
    let reported = reported(route_id, provider_id, usage);
    ObjectEncoder::new()
        .field("mechanism", reported.mechanism)
        .field("readReported", &reported.read)
        .field("writeReported", &reported.write)
        .finish()
}

fn mechanism(route_id: &str, provider_id: &str, cached: bool) -> &'static str {
    match route_id {
        "anthropic-messages"
        | "google-vertex-messages"
        | "ai-sdk:@ai-sdk/anthropic"
        | "ai-sdk:@ai-sdk/google-vertex/anthropic" => "anthropic-cache-control",
        "openrouter" | "openrouter-responses" | "ai-sdk:@openrouter/ai-sdk-provider" => {
            "openrouter-cache-control"
        }
        "bedrock-converse" | "ai-sdk:@ai-sdk/amazon-bedrock" => "bedrock-cache-point",
        "openai-chat"
        | "openai-responses"
        | "openai-responses-websocket"
        | "github-copilot-chat"
        | "github-copilot-responses"
        | "ai-sdk:@ai-sdk/github-copilot"
        | "openai-codex-responses"
        | "openai-codex-websocket-responses"
        | "openai-compatible-chat"
        | "openai-compatible-responses"
        | "azure-openai-chat"
        | "azure-openai-responses"
        | "google-vertex-chat"
        | "google-vertex-responses"
        | "cloudflare-ai-gateway"
        | "cloudflare-workers-ai"
        | "ai-sdk:@ai-sdk/openai"
        | "ai-sdk:@ai-sdk/azure" => "openai-prefix-cache",
        "gemini"
        | "google-vertex-gemini"
        | "ai-sdk:@ai-sdk/google"
        | "ai-sdk:@ai-sdk/google-vertex" => "gemini-prefix-cache",
        "ai-sdk:cursor-opencode-provider" | "runpod-ollama" | "runpod-vllm" => "provider-reported",
        "unknown" => match provider_id {
            "openai" | "azure" | "github-copilot" | "ycoding" | "meta" => "openai-prefix-cache",
            "openrouter" => "openrouter-cache-control",
            "anthropic" => "anthropic-cache-control",
            "amazon-bedrock" => "bedrock-cache-point",
            "google" | "google-vertex" => "gemini-prefix-cache",
            "cursor" => "provider-reported",
            _ => observed(cached),
        },
        _ => observed(cached),
    }
}

fn observed(cached: bool) -> &'static str {
    if cached { "provider-reported" } else { "none" }
}

const SECOND_NS: i64 = 1_000_000_000;

fn measured_sample(
    model: &model::Ref,
    timing: &provider_request::Timing,
) -> Option<session_cache_diagnostics::GenerationSpeed> {
    let tokens = timing.generated_tokens?.get();
    let provider = timing.generation_duration_ns.map(|value| value.get());
    let observed = timing
        .observed_generation_duration_ns
        .map(|value| value.get());
    let duration = match provider {
        Some(value) if value >= SECOND_NS => value,
        _ => observed.filter(|value| *value >= SECOND_NS)?,
    };
    let rate = tokens as f64 * 1e9 / duration as f64;
    (tokens > 0 && rate.is_finite() && rate > 0.0).then(|| {
        session_cache_diagnostics::GenerationSpeed {
            model: model.clone(),
            tokens: PositiveInt::new(tokens).expect("positive generated tokens"),
            duration_ns: PositiveInt::new(duration).expect("positive generation duration"),
            tokens_per_second: rate,
            estimated: None,
        }
    })
}

fn estimated_sample(
    model: &model::Ref,
    timing: &provider_request::Timing,
) -> Option<session_cache_diagnostics::GenerationSpeed> {
    let received = timing.received_output.as_ref()?;
    if received.duration_ns.get() < SECOND_NS {
        return None;
    }
    let rate = received.estimated_tokens.get() as f64 * 1e9 / received.duration_ns.get() as f64;
    (rate.is_finite() && rate > 0.0).then(|| session_cache_diagnostics::GenerationSpeed {
        model: model.clone(),
        tokens: received.estimated_tokens,
        duration_ns: received.duration_ns,
        tokens_per_second: rate,
        estimated: Some(true),
    })
}

pub(crate) fn generation_sample(
    model: &model::Ref,
    timing: Option<&provider_request::Timing>,
) -> Option<session_cache_diagnostics::GenerationSpeed> {
    estimated_sample(model, timing?)
}

pub fn generation_speed(
    records: &[(model::Ref, Option<provider_request::Timing>)],
) -> Option<session_cache_diagnostics::GenerationSpeedHistory> {
    let newest = &records.last()?.0;
    let candidates = records
        .iter()
        .filter(|(model, _)| model.provider_id == newest.provider_id && model.id == newest.id)
        .filter_map(|(model, timing)| {
            let timing = timing.as_ref()?;
            let counted = measured_sample(model, timing);
            let estimated = estimated_sample(model, timing);
            (counted.is_some() || estimated.is_some()).then_some((counted, estimated))
        })
        .collect::<Vec<_>>();
    let use_measured =
        !candidates.is_empty() && candidates.iter().all(|(counted, _)| counted.is_some());
    let mut recent = candidates
        .into_iter()
        .filter_map(|(counted, estimated)| if use_measured { counted } else { estimated })
        .rev()
        .take(8)
        .collect::<Vec<_>>();
    recent.reverse();
    let latest = recent
        .iter()
        .try_fold((0i64, 0i64), |(tokens, duration), sample| {
            Some((
                tokens.checked_add(sample.tokens.get())?,
                duration.checked_add(sample.duration_ns.get())?,
            ))
        })
        .and_then(|(tokens, duration)| {
            Some(session_cache_diagnostics::GenerationSpeed {
                model: newest.clone(),
                tokens: PositiveInt::new(tokens).ok()?,
                duration_ns: PositiveInt::new(duration).ok()?,
                tokens_per_second: tokens as f64 * 1e9 / duration as f64,
                estimated: recent
                    .iter()
                    .any(|sample| sample.estimated == Some(true))
                    .then_some(true),
            })
        });
    Some(session_cache_diagnostics::GenerationSpeedHistory {
        live: None,
        model: Some(newest.clone()),
        unreported_reason: None,
        latest,
        recent,
    })
}
