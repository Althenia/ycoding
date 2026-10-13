use ycoding_ai::llm;
use ycoding_schema::{JsonValue, ObjectEncoder};

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
        | "muse-responses"
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
