use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use ycoding_ai::{
    auth::{Auth, Credential, Secret},
    bedrock, cloudflare, cohere, gateway, gitlab, google_vertex_shared,
    hosted::{self, Vendor},
    llm::{
        self, Defaults, Event, FinishReason, Message, Part, Request, ToolChoice, ToolDefinition,
    },
    providers::{self, Api, AzureAuth, AzureConfig, Config},
    route::Executor,
    sap_ai_core, snowflake_cortex,
};
use ycoding_schema::{parse_json, provider, stringify_json};

async fn read_request(socket: &mut tokio::net::TcpStream) -> String {
    let mut bytes = Vec::new();
    let mut chunk = [0; 2048];
    loop {
        let count = socket.read(&mut chunk).await.unwrap();
        assert_ne!(count, 0);
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            let length = String::from_utf8_lossy(&bytes[..end])
                .lines()
                .find_map(|line| {
                    line.to_lowercase()
                        .strip_prefix("content-length: ")
                        .and_then(|value| value.parse::<usize>().ok())
                })
                .unwrap_or(0);
            if bytes.len() >= end + 4 + length {
                return String::from_utf8(bytes).unwrap();
            }
        }
    }
}
async fn server(status: u16, body: &'static str) -> (String, tokio::task::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = read_request(&mut socket).await;
        let headers = format!(
            "HTTP/1.1 {status} Fixture\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        socket.write_all(headers.as_bytes()).await.unwrap();
        for chunk in body.as_bytes().chunks(7) {
            socket.write_all(chunk).await.unwrap();
        }
        request
    });
    (base, task)
}
fn config(base: String) -> Config {
    let mut config = Config::new(Auth::bearer(Credential::value("fixture-key")));
    config.base_url = Some(base);
    config
}
fn request(model: llm::Model) -> Request {
    let mut request = Request::new(model);
    request.messages = vec![Message::user("hello")];
    request.generation.max_tokens = Some(32.0);
    request
}
fn tool() -> ToolDefinition {
    ToolDefinition {
        name: "lookup".into(),
        description: "Look up a number".into(),
        input_schema: parse_json(
            r#"{"type":"object","properties":{"n":{"type":"number"}},"required":["n"]}"#,
        )
        .unwrap(),
        output_schema: None,
        cache: None,
        metadata: None,
        native: None,
    }
}
fn body(request: &str) -> serde_json::Value {
    serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap()
}
fn header<'a>(request: &'a str, name: &str) -> Option<&'a str> {
    request.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name).then(|| value.trim())
    })
}
async fn generate(request: &Request) -> Result<llm::Response, ycoding_ai::Error> {
    tokio::time::timeout(
        Duration::from_secs(5),
        Executor::new(Executor::http_client().unwrap()).generate(request),
    )
    .await
    .unwrap()
}
const TEXT: &str = "data: {\"choices\":[{\"delta\":{\"content\":\"answer\"},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2,\"total_tokens\":12}}\n\ndata: [DONE]\n\n";
const TOOLS: &str = "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"consider\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{\\\"n\\\":\"}}]}}]}\n\ndata: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"2}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5,\"prompt_tokens_details\":{\"cached_tokens\":3,\"cache_creation_input_tokens\":2}}}\n\ndata: [DONE]\n\n";

#[tokio::test]
async fn bundled_hosted_wire_routes_auth_and_late_usage() {
    for vendor in [
        Vendor::Alibaba,
        Vendor::Mistral,
        Vendor::Perplexity,
        Vendor::Venice,
        Vendor::Vercel,
    ] {
        let (base, task) = server(200, TEXT).await;
        let mut common = config(base);
        common
            .defaults
            .http
            .headers
            .insert("x-title".into(), "incorrect".into());
        let response = generate(&request(hosted::model("api-model", vendor, common)))
            .await
            .unwrap();
        let sent = task.await.unwrap();
        assert!(sent.starts_with("POST /chat/completions "));
        assert_eq!(header(&sent, "authorization"), Some("Bearer fixture-key"));
        assert_eq!(body(&sent)["model"], "api-model");
        assert_eq!(body(&sent)["stream"], true);
        if vendor == Vendor::Vercel {
            assert_eq!(header(&sent, "x-title"), Some("YCoding"));
        }
        assert_eq!(response.text().as_str(), Some("answer"));
        let usage = response.usage.unwrap();
        assert_eq!(
            (usage.input_tokens, usage.output_tokens),
            (Some(10.0), Some(2.0))
        );
    }
}
#[tokio::test]
async fn alibaba_thinking_tools_and_cache_usage() {
    let (base, task) = server(200, TOOLS).await;
    let mut request = request(hosted::model("qwen", Vendor::Alibaba, config(base)));
    request.tools = vec![tool()];
    request.generation.top_k = Some(8.0);
    let mut system: llm::TextPart = "stable system".into();
    system.cache = Some(ycoding_ai::cache::Hint::ephemeral(None));
    request.system = vec![system];
    request.provider_options = Some(
        parse_json(
            r#"{"alibaba":{"enableThinking":true,"thinkingBudget":64,"parallelToolCalls":false}}"#,
        )
        .unwrap(),
    );
    let response = generate(&request).await.unwrap();
    let sent = task.await.unwrap();
    let body = body(&sent);
    assert_eq!(
        (
            body["enable_thinking"].as_bool(),
            body["thinking_budget"].as_u64(),
            body["top_k"].as_u64()
        ),
        (Some(true), Some(64), Some(8))
    );
    assert_eq!(body["tools"][0]["function"]["name"], "lookup");
    assert_eq!(
        body["messages"][0]["content"][0]["cache_control"]["type"],
        "ephemeral"
    );
    assert!(
        response
            .message
            .content
            .iter()
            .any(|p| matches!(p, Part::Reasoning(p) if p.text.as_str() == Some("consider")))
    );
    assert!(
        response
            .message
            .content
            .iter()
            .any(|p| matches!(p, Part::ToolCall(p) if stringify_json(&p.input) == "{\"n\":2}"))
    );
    let usage = response.usage.unwrap();
    assert_eq!(
        (
            usage.cache_read_input_tokens,
            usage.cache_write_input_tokens,
            usage.non_cached_input_tokens
        ),
        (Some(3.0), Some(2.0), Some(5.0))
    );
    request.messages.push(response.message);
    let replay: serde_json::Value =
        serde_json::from_str(&request.model.route.prepare(&request).unwrap().encoded_body).unwrap();
    assert_eq!(replay["messages"][2]["content"], "consider");
    assert!(replay["messages"][2].get("reasoning_content").is_none());
}
#[tokio::test]
async fn mistral_array_content_complete_tools_and_options() {
    let (base, task) = server(200, "data: {\"choices\":[{\"delta\":{\"content\":[{\"type\":\"thinking\",\"thinking\":[{\"type\":\"text\",\"text\":\"think\"}]},{\"type\":\"text\",\"text\":\"answer\"}],\"tool_calls\":[{\"id\":\"call\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{\\\"n\\\":1}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":3}}\n\ndata: [DONE]\n\n").await;
    let mut request = request(hosted::model("magistral", Vendor::Mistral, config(base)));
    request.generation.seed = Some(3.0);
    request.provider_options =
        Some(parse_json(r#"{"mistral":{"safePrompt":true,"reasoningEffort":"high"}}"#).unwrap());
    let response = generate(&request).await.unwrap();
    let sent = task.await.unwrap();
    let body = body(&sent);
    assert_eq!(body["random_seed"], 3);
    assert_eq!(body["safe_prompt"], true);
    assert_eq!(body["reasoning_effort"], "high");
    assert!(body.get("stream_options").is_none());
    assert_eq!(response.text().as_str(), Some("answer"));
    assert!(
        response
            .message
            .content
            .iter()
            .any(|p| matches!(p, Part::Reasoning(p) if p.text.as_str() == Some("think")))
    );
    assert_eq!(response.finish_reason, FinishReason::ToolCalls);
    request.messages.push(response.message);
    let replay: serde_json::Value =
        serde_json::from_str(&request.model.route.prepare(&request).unwrap().encoded_body).unwrap();
    assert_eq!(replay["messages"][1]["content"][0]["type"], "thinking");
    assert_eq!(
        replay["messages"][1]["content"][0]["thinking"][0]["text"],
        "think"
    );
}
#[tokio::test]
async fn perplexity_search_metadata_and_venice_options_survive() {
    let (base, task) = server(200, "data: {\"citations\":[\"https://example.com\"],\"choices\":[{\"delta\":{\"content\":\"answer\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1,\"citation_tokens\":3,\"num_search_queries\":1,\"cost\":{\"total_cost\":0.1}}}\n\ndata: [DONE]\n\n").await;
    let mut request = request(hosted::model("sonar", Vendor::Perplexity, config(base)));
    request.provider_options = Some(
        parse_json(
            r#"{"perplexity":{"search_domain_filter":["example.com"],"return_images":true}}"#,
        )
        .unwrap(),
    );
    let response = generate(&request).await.unwrap();
    let sent = task.await.unwrap();
    assert_eq!(body(&sent)["search_domain_filter"][0], "example.com");
    assert!(response.events.iter().any(|event| matches!(event, Event::Finish(finish) if finish.provider_metadata.as_ref().is_some_and(|v| stringify_json(v).contains("\"citationTokens\":3") && !stringify_json(v).contains("prompt_tokens")))));
    let (base, task) = server(200, TEXT).await;
    let mut request = crate::request(hosted::model("venice-model", Vendor::Venice, config(base)));
    request.provider_options = Some(parse_json(r#"{"venice":{"venice_parameters":{"disable_thinking":false,"enable_web_search":"auto"}}}"#).unwrap());
    generate(&request).await.unwrap();
    assert_eq!(
        body(&task.await.unwrap())["venice_parameters"]["enable_web_search"],
        "auto"
    );
}
#[tokio::test]
async fn cohere_v2_reasoning_tool_stream_and_usage() {
    let (base, task) = server(200, "data: {\"type\":\"message-start\",\"id\":\"msg\"}\n\ndata: {\"type\":\"content-delta\",\"index\":0,\"delta\":{\"message\":{\"content\":{\"thinking\":\"consider\"}}}}\n\ndata: {\"type\":\"content-end\",\"index\":0}\n\ndata: {\"type\":\"tool-call-start\",\"index\":1,\"delta\":{\"message\":{\"tool_calls\":{\"id\":\"call\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{\\\"n\\\":\"}}}}}\n\ndata: {\"type\":\"tool-call-delta\",\"index\":1,\"delta\":{\"message\":{\"tool_calls\":{\"function\":{\"arguments\":\"2}\"}}}}}\n\ndata: {\"type\":\"tool-call-end\",\"index\":1}\n\ndata: {\"type\":\"message-end\",\"delta\":{\"finish_reason\":\"TOOL_CALL\",\"usage\":{\"tokens\":{\"input_tokens\":9,\"output_tokens\":3},\"billed_units\":{\"input_tokens\":5,\"output_tokens\":3}}}}\n\n").await;
    let mut request = request(cohere::model("command-a", config(base)));
    request.tools = vec![tool()];
    request.tool_choice = Some(ToolChoice::Tool("lookup".into()));
    request.generation.top_p = Some(0.8);
    request.provider_options =
        Some(parse_json(r#"{"cohere":{"thinking":{"tokenBudget":20}}}"#).unwrap());
    let response = generate(&request).await.unwrap();
    let sent = task.await.unwrap();
    assert!(sent.starts_with("POST /chat "));
    let body = body(&sent);
    assert_eq!(body["p"], 0.8);
    assert_eq!(body["thinking"]["token_budget"], 20);
    assert_eq!(body["tool_choice"], "REQUIRED");
    assert_eq!(response.finish_reason, FinishReason::ToolCalls);
    assert_eq!(response.usage.unwrap().input_tokens, Some(9.0));
    assert!(
        response
            .message
            .content
            .iter()
            .any(|p| matches!(p, Part::ToolCall(p) if p.name.as_str() == Some("lookup")))
    );
    assert!(
        response
            .message
            .content
            .iter()
            .any(|p| matches!(p, Part::Reasoning(p) if p.text.as_str() == Some("consider")))
    );
}
#[tokio::test]
async fn gateway_native_v3_prompt_headers_stream_and_tools() {
    let (base, task) = server(200, "data: {\"type\":\"stream-start\",\"warnings\":[]}\n\ndata: {\"type\":\"reasoning-delta\",\"id\":\"r\",\"delta\":\"think\"}\n\ndata: {\"type\":\"reasoning-end\",\"id\":\"r\"}\n\ndata: {\"type\":\"text-delta\",\"id\":\"t\",\"delta\":\"answer\"}\n\ndata: {\"type\":\"tool-input-start\",\"id\":\"call\",\"toolName\":\"lookup\"}\n\ndata: {\"type\":\"tool-input-delta\",\"id\":\"call\",\"delta\":\"{\\\"n\\\":1}\"}\n\ndata: {\"type\":\"tool-input-end\",\"id\":\"call\"}\n\ndata: {\"type\":\"tool-call\",\"toolCallId\":\"call\",\"toolName\":\"lookup\",\"input\":\"{\\\"n\\\":1}\"}\n\ndata: {\"type\":\"finish\",\"finishReason\":{\"unified\":\"tool-calls\",\"raw\":\"tool_calls\"},\"usage\":{\"inputTokens\":{\"total\":12,\"noCache\":5,\"cacheRead\":7},\"outputTokens\":{\"total\":4,\"reasoning\":2}},\"providerMetadata\":{\"gateway\":{\"routing\":\"fixture\"}}}\n\n").await;
    let mut request = request(gateway::model("anthropic/model", config(base)));
    request.tools = vec![tool()];
    request.system = vec!["system".into()];
    let response = generate(&request).await.unwrap();
    let sent = task.await.unwrap();
    assert!(sent.starts_with("POST /language-model "));
    assert_eq!(
        header(&sent, "ai-language-model-id"),
        Some("anthropic/model")
    );
    assert_eq!(
        header(&sent, "ai-language-model-specification-version"),
        Some("3")
    );
    assert_eq!(header(&sent, "ai-gateway-protocol-version"), Some("0.0.1"));
    let body = body(&sent);
    assert_eq!(body["prompt"][0]["content"], "system");
    assert_eq!(body["prompt"][1]["content"][0]["type"], "text");
    assert_eq!(body["tools"][0]["inputSchema"]["type"], "object");
    assert!(body.get("model").is_none());
    assert_eq!(response.text().as_str(), Some("answer"));
    assert_eq!(response.finish_reason, FinishReason::ToolCalls);
    assert_eq!(response.usage.unwrap().reasoning_tokens, Some(2.0));
}
#[tokio::test]
async fn gateway_cache_metadata_replay_and_provider_executed_result() {
    let (base, task) = server(200, "data: {\"type\":\"tool-call\",\"toolCallId\":\"hosted-call\",\"toolName\":\"lookup\",\"input\":\"{\\\"n\\\":1}\",\"providerExecuted\":true}\n\ndata: {\"type\":\"tool-result\",\"toolCallId\":\"hosted-call\",\"toolName\":\"lookup\",\"result\":{\"n\":2},\"providerMetadata\":{\"anthropic\":{\"signature\":\"fixture-signature\"}}}\n\ndata: {\"type\":\"finish\",\"finishReason\":{\"unified\":\"stop\"},\"usage\":{\"inputTokens\":{},\"outputTokens\":{}}}\n\n").await;
    let mut request = request(gateway::model("anthropic/model", config(base)));
    let mut system: llm::TextPart = "stable system".into();
    system.cache = Some(ycoding_ai::cache::Hint::ephemeral(Some(3600.0)));
    request.system = vec![system];
    let response = generate(&request).await.unwrap();
    let sent = task.await.unwrap();
    assert_eq!(
        body(&sent)["prompt"][0]["providerOptions"]["anthropic"]["cacheControl"]["ttl"],
        "1h"
    );
    assert!(response.message.content.iter().any(|part| matches!(part, Part::ToolResult(part) if part.provider_executed == Some(true) && stringify_json(&part.result.to_json()) == "{\"n\":2}")));
    request.messages.push(response.message);
    let replay: serde_json::Value =
        serde_json::from_str(&request.model.route.prepare(&request).unwrap().encoded_body).unwrap();
    assert!(
        replay["prompt"][2]["content"]
            .as_array()
            .unwrap()
            .iter()
            .any(|part| part["providerOptions"]["anthropic"]["signature"] == "fixture-signature")
    );
}
#[tokio::test]
async fn cloudflare_unified_array_envelope_metadata_and_env_precedence() {
    let (base, task) = server(200, TEXT).await;
    let mut model = cloudflare::gateway(
        "provider/model",
        cloudflare::GatewayConfig {
            account_id: Some("option-account".into()),
            gateway_id: Some("option-gateway".into()),
            api_key: Some(Credential::value("option-key")),
            base_url: None,
            environment: BTreeMap::from([
                ("CLOUDFLARE_ACCOUNT_ID".into(), "env-account".into()),
                ("CLOUDFLARE_GATEWAY_ID".into(), "env-gateway".into()),
                ("CLOUDFLARE_API_TOKEN".into(), "fixture-key".into()),
            ]),
            options: cloudflare::GatewayOptions {
                metadata: Some(parse_json(r#"{"source":"typed"}"#).unwrap()),
                cache_ttl: Some(90),
                cache_key: Some("fixture-cache".into()),
                skip_cache: Some(true),
                collect_log: Some(false),
            },
            defaults: Defaults::default(),
            user_agent: "ycoding/fixture cloudflare-ai-gateway (test)".into(),
        },
    )
    .unwrap();
    assert_eq!(
        model.route.endpoint.base_url,
        "https://gateway.ai.cloudflare.com/v1/env-account/env-gateway"
    );
    Arc::make_mut(&mut model.route).endpoint.base_url = base;
    let response = generate(&request(model)).await.unwrap();
    let sent = task.await.unwrap();
    assert!(sent.starts_with("POST / "));
    assert_eq!(
        header(&sent, "cf-aig-authorization"),
        Some("Bearer fixture-key")
    );
    assert_eq!(
        header(&sent, "cf-aig-metadata"),
        Some("{\"source\":\"typed\"}")
    );
    assert_eq!(header(&sent, "cf-cache-ttl"), Some("90"));
    assert_eq!(header(&sent, "cf-skip-cache"), Some("true"));
    assert_eq!(header(&sent, "cf-aig-collect-log"), Some("false"));
    let body = body(&sent);
    assert_eq!(body[0]["provider"], "compat");
    assert_eq!(body[0]["endpoint"], "chat/completions");
    assert_eq!(body[0]["headers"]["Authorization"], "Bearer fixture-key");
    assert_eq!(body[0]["query"]["model"], "provider/model");
    assert_eq!(response.text().as_str(), Some("answer"));
}
#[tokio::test]
async fn cloudflare_workers_template_key_and_user_agent_override() {
    let (base, task) = server(200, TEXT).await;
    let mut common = config(format!("{base}/${{CLOUDFLARE_ACCOUNT_ID}}/ai/v1"));
    common
        .defaults
        .http
        .headers
        .insert("user-agent".into(), "caller-agent".into());
    let model = cloudflare::workers(
        "@cf/model",
        cloudflare::WorkersConfig {
            account_id: Some("option".into()),
            common,
            environment: BTreeMap::from([
                ("CLOUDFLARE_ACCOUNT_ID".into(), "fixture-account".into()),
                ("CLOUDFLARE_API_KEY".into(), "worker-key".into()),
            ]),
            user_agent: "default-agent".into(),
        },
    )
    .unwrap();
    generate(&request(model)).await.unwrap();
    let sent = task.await.unwrap();
    assert!(sent.starts_with("POST /fixture-account/ai/v1/chat/completions "));
    assert_eq!(header(&sent, "authorization"), Some("Bearer worker-key"));
    assert_eq!(header(&sent, "user-agent"), Some("caller-agent"));
}
#[tokio::test]
async fn cortex_token_max_completion_and_usage_opt_out_wire() {
    let (base, task) = server(200, TEXT).await;
    let model = snowflake_cortex::model(
        "snowflake",
        config(base),
        Some(Credential::value("option")),
        &BTreeMap::from([
            ("SNOWFLAKE_CORTEX_PAT".into(), "pat".into()),
            ("SNOWFLAKE_CORTEX_TOKEN".into(), "fixture-key".into()),
        ]),
    )
    .unwrap();
    let mut request = request(model);
    request.provider_options =
        Some(parse_json(r#"{"openai-compatible":{"includeUsage":false}}"#).unwrap());
    generate(&request).await.unwrap();
    let sent = task.await.unwrap();
    let body = body(&sent);
    assert_eq!(header(&sent, "authorization"), Some("Bearer fixture-key"));
    assert_eq!(body["max_completion_tokens"], 32);
    assert!(body.get("max_tokens").is_none());
    assert!(body.get("stream_options").is_none());
}
#[test]
fn cortex_recognizes_only_json_conversation_complete_400() {
    for (status, body, expected) in [
        (400, r#"{"message":"Conversation COMPLETE"}"#, true),
        (400, r#"{"error":"conversation complete"}"#, true),
        (400, r#"{"message":"other"}"#, false),
        (429, r#"{"message":"conversation complete"}"#, false),
        (400, "conversation complete", false),
        (
            400,
            r#"{"error":{"message":"conversation complete"}}"#,
            false,
        ),
    ] {
        assert_eq!(
            snowflake_cortex::conversation_complete(status, body),
            expected
        );
    }
}
#[tokio::test]
async fn cortex_conversation_complete_settles_only_scoped_400() {
    for (status, response, normal_stop) in [
        (400, r#"{"message":"Conversation COMPLETE"}"#, true),
        (400, r#"{"error":"conversation complete"}"#, true),
        (400, r#"{"message":"other failure"}"#, false),
        (400, "conversation complete", false),
        (429, r#"{"message":"conversation complete"}"#, false),
    ] {
        let (base, task) = server(status, response).await;
        let model =
            snowflake_cortex::model("cortex", config(base), None, &BTreeMap::new()).unwrap();
        let result = generate(&request(model)).await;
        task.await.unwrap();
        if normal_stop {
            let response = result.unwrap();
            assert_eq!(response.text().as_str(), Some(""));
            assert_eq!(response.finish_reason, FinishReason::Stop);
            assert!(response.usage.is_none());
            assert_eq!(
                response
                    .events
                    .iter()
                    .filter(|event| matches!(event, Event::Finish(_)))
                    .count(),
                1
            );
            continue;
        }
        assert_eq!(result.unwrap_err().status, Some(status));
    }
    let (base, task) = server(400, r#"{"message":"conversation complete"}"#).await;
    let model = providers::compatible(
        "other",
        provider::Id("other".into()),
        config(base),
        Api::Chat,
    )
    .unwrap();
    assert_eq!(
        generate(&request(model)).await.unwrap_err().status,
        Some(400)
    );
    task.await.unwrap();
}
#[test]
fn bedrock_regional_model_matrix_endpoint_and_bearer_precedence() {
    for (id, region, expected) in [
        (
            "anthropic.claude-sonnet",
            "us-east-1",
            "us.anthropic.claude-sonnet",
        ),
        ("amazon.nova-2", "us-west-2", "us.amazon.nova-2"),
        (
            "amazon.nova-premier",
            "us-gov-west-1",
            "amazon.nova-premier",
        ),
        ("mistral.pixtral", "eu-south-2", "eu.mistral.pixtral"),
        ("amazon.nova-pro", "eu-central-1", "amazon.nova-pro"),
        (
            "anthropic.claude-haiku",
            "ap-southeast-4",
            "au.anthropic.claude-haiku",
        ),
        (
            "anthropic.claude-sonnet-4-5",
            "ap-southeast-2",
            "au.anthropic.claude-sonnet-4-5",
        ),
        (
            "anthropic.claude-sonnet",
            "ap-northeast-1",
            "jp.anthropic.claude-sonnet",
        ),
        ("amazon.nova-lite", "ap-south-1", "apac.amazon.nova-lite"),
        (
            "global.anthropic.claude",
            "us-west-2",
            "global.anthropic.claude",
        ),
        ("us.amazon.nova-lite", "eu-west-1", "us.amazon.nova-lite"),
        ("deepseek.model", "ca-central-1", "deepseek.model"),
    ] {
        assert_eq!(bedrock::regional_model_id(id, region), expected);
    }
    let model = bedrock::model(
        "anthropic.claude",
        bedrock::HostedConfig {
            endpoint: Some("http://127.0.0.1:1/private".into()),
            base_url: Some("http://127.0.0.1:1/wrong".into()),
            region: Some("eu-west-1".into()),
            bearer_token: Some(Credential::value("option")),
            auth: Auth::None,
            environment: BTreeMap::from([(
                "AWS_BEARER_TOKEN_BEDROCK".into(),
                "fixture-key".into(),
            )]),
            defaults: Defaults::default(),
        },
        bedrock::Api::Converse,
    );
    let prepared = model.route.prepare(&request(model.clone())).unwrap();
    assert!(
        prepared
            .url
            .path()
            .starts_with("/private/model/eu.anthropic.claude/")
    );
    assert_eq!(prepared.headers["authorization"], "Bearer fixture-key");
    for (id, path) in [
        ("openai.gpt-oss-safeguard-20b", "/chat/completions"),
        ("openai.gpt-oss-safeguard-120b", "/chat/completions"),
        ("anthropic.claude", "/responses"),
    ] {
        let model = bedrock::model(
            id,
            bedrock::HostedConfig {
                endpoint: None,
                base_url: None,
                region: Some("us-west-2".into()),
                bearer_token: Some(Credential::value("fixture-key")),
                auth: Auth::None,
                environment: BTreeMap::new(),
                defaults: Defaults::default(),
            },
            bedrock::Api::Mantle,
        );
        let prepared = model.route.prepare(&request(model.clone())).unwrap();
        assert_eq!(
            prepared.url.as_str(),
            format!("https://bedrock-mantle.us-west-2.api.aws/v1{path}")
        );
        assert_eq!(model.id.as_str(), Some(id));
    }
}
#[tokio::test]
async fn azure_responses_default_and_completion_selection() {
    for use_completion_urls in [false, true] {
        let response = if use_completion_urls {
            TEXT
        } else {
            "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"item\",\"delta\":\"answer\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"response\",\"usage\":{\"input_tokens\":5,\"output_tokens\":1}}}\n\n"
        };
        let (base, task) = server(200, response).await;
        let endpoint = providers::azure_endpoint(Some(&base), None, &BTreeMap::new()).unwrap();
        let model = providers::azure_sdk(
            "deployment",
            providers::AzureSdkConfig {
                common: AzureConfig {
                    endpoint,
                    auth: AzureAuth::Key(Credential::value("fixture-key")),
                    api_version: None,
                    query: BTreeMap::new(),
                    defaults: Defaults::default(),
                },
                use_completion_urls,
                use_deployment_based_urls: false,
            },
        );
        generate(&request(model)).await.unwrap();
        let sent = task.await.unwrap();
        assert!(sent.starts_with(if use_completion_urls {
            "POST /chat/completions "
        } else {
            "POST /responses "
        }));
        assert_eq!(header(&sent, "api-key"), Some("fixture-key"));
        assert_eq!(header(&sent, "authorization"), None);
    }
    assert!(providers::azure_endpoint(None, Some(" "), &BTreeMap::new()).is_err());
    assert!(
        matches!(providers::azure_endpoint(None, Some(" "), &BTreeMap::from([("AZURE_RESOURCE_NAME".into(), " fixture ".into())])).unwrap(), providers::AzureEndpoint::Resource(name) if name == "fixture")
    );
    assert_eq!(
        providers::azure_cognitive_endpoint(
            Some("http://127.0.0.1:1/option"),
            &BTreeMap::from([(
                "AZURE_COGNITIVE_SERVICES_RESOURCE_NAME".into(),
                "fixture".into()
            )])
        ),
        Some("https://fixture.cognitiveservices.azure.com/openai".into())
    );
}
#[tokio::test]
async fn vertex_templates_trimmed_ids_and_explicit_access_token() {
    assert_eq!(
        google_vertex_shared::expand_template(
            "https://${GOOGLE_VERTEX_ENDPOINT}/${GOOGLE_VERTEX_PROJECT}/${GOOGLE_VERTEX_LOCATION}",
            Some("project"),
            "eu"
        ),
        "https://eu-aiplatform.googleapis.com/project/eu"
    );
    assert_eq!(
        google_vertex_shared::expand_template("https://${GOOGLE_VERTEX_ENDPOINT}", None, "global"),
        "https://aiplatform.googleapis.com"
    );
    let (base, task) = server(200, TEXT).await;
    let route = ycoding_ai::google_vertex_chat::route(google_vertex_shared::Config {
        access_token: Some(Credential::value("fixture-key")),
        base_url: Some(format!("{base}/${{GOOGLE_VERTEX_PROJECT}}")),
        project: Some("project".into()),
        ..Default::default()
    })
    .unwrap();
    generate(&request(route.model(" model "))).await.unwrap();
    let sent = task.await.unwrap();
    assert!(sent.starts_with("POST /project/chat/completions "));
    assert_eq!(body(&sent)["model"], "model");
    assert_eq!(header(&sent, "authorization"), Some("Bearer fixture-key"));
}
#[tokio::test]
async fn hosted_errors_are_classified_and_redacted() {
    for vendor in [
        Vendor::Alibaba,
        Vendor::Mistral,
        Vendor::Perplexity,
        Vendor::Venice,
        Vendor::Vercel,
    ] {
        let (base, task) = server(401, "{\"error\":{\"message\":\"rejected fixture-key\"}}").await;
        let error = generate(&request(hosted::model("model", vendor, config(base))))
            .await
            .unwrap_err();
        task.await.unwrap();
        assert_eq!(error.status, Some(401));
        assert!(!error.message.contains("fixture-key"));
        assert!(!format!("{error:?}").contains("fixture-key"));
    }
}
#[tokio::test]
async fn incomplete_vendor_streams_fail_without_success() {
    for model_kind in ["cohere", "gateway", "mistral"] {
        let (base, task) = server(200, "data: {\"type\":\"content-delta\",\"index\":0,\"delta\":{\"message\":{\"content\":{\"text\":\"incomplete\"}}}}\n\n").await;
        let model = match model_kind {
            "cohere" => cohere::model("model", config(base)),
            "gateway" => gateway::model("model", config(base)),
            _ => hosted::model("model", Vendor::Mistral, config(base)),
        };
        assert!(generate(&request(model)).await.is_err());
        task.await.unwrap();
    }
}
#[tokio::test]
async fn gitlab_agentic_direct_access_exchange_and_chat_wire() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let mut sent = Vec::new();
        for response in [
            "{\"token\":\"direct-key\",\"headers\":{\"x-api-key\":\"must-drop\",\"x-gitlab-instance-id\":\"fixture\"}}",
            TEXT,
        ] {
            let (mut socket, _) = listener.accept().await.unwrap();
            sent.push(read_request(&mut socket).await);
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).as_bytes()).await.unwrap();
        }
        sent
    });
    let mut config = gitlab::Config::new(Credential::value("fixture-key"));
    config.instance_url = base.clone();
    config.ai_gateway_url = base;
    config.ai_gateway_headers.insert(
        "User-Agent".into(),
        "ycoding/fixture gitlab-ai-provider/6.11.1 (test)".into(),
    );
    let model = gitlab::model(
        &Executor::http_client().unwrap(),
        "duo-chat-gpt-5-4",
        config,
    )
    .await
    .unwrap();
    assert_eq!(model.route.defaults.generation.max_tokens, Some(8192.0));
    generate(&request(model)).await.unwrap();
    let sent = task.await.unwrap();
    assert!(sent[0].starts_with("POST /api/v4/ai/third_party_agents/direct_access "));
    assert_eq!(body(&sent[0])["feature_flags"]["duo_agent_platform"], true);
    assert!(sent[1].starts_with("POST /ai/v1/proxy/openai/v1/chat/completions "));
    assert_eq!(header(&sent[1], "authorization"), Some("Bearer direct-key"));
    assert_eq!(header(&sent[1], "x-api-key"), None);
    assert_eq!(body(&sent[1])["model"], "gpt-5.4-2026-03-05");
    assert_eq!(body(&sent[1])["max_completion_tokens"], 32);
}
#[tokio::test]
async fn sap_service_key_oauth_and_orchestration_envelope() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let mut sent = Vec::new();
        for response in [
            "{\"access_token\":\"sap-access\",\"expires_in\":3600}",
            "data: {\"final_result\":{\"choices\":[{\"index\":0,\"delta\":{\"content\":\"answer\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":2}}}\n\ndata: [DONE]\n\n",
        ] {
            let (mut socket, _) = listener.accept().await.unwrap();
            sent.push(read_request(&mut socket).await);
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).as_bytes()).await.unwrap();
        }
        sent
    });
    let key = serde_json::json!({"clientid":"fixture-client","clientsecret":"fixture-secret","url":base,"serviceurls":{"AI_API_URL":base}}).to_string();
    let model = sap_ai_core::model(
        &Executor::http_client().unwrap(),
        "gpt-model",
        sap_ai_core::Config {
            service_key: Some(Secret::new("invalid-option-key")),
            deployment_id: None,
            resource_group: None,
            environment: BTreeMap::from([
                ("AICORE_SERVICE_KEY".into(), key),
                ("AICORE_DEPLOYMENT_ID".into(), "deployment".into()),
                ("AICORE_RESOURCE_GROUP".into(), "group".into()),
            ]),
            defaults: Defaults::default(),
        },
    )
    .await
    .unwrap();
    let response = generate(&request(model)).await.unwrap();
    let sent = task.await.unwrap();
    assert!(sent[0].starts_with("POST /oauth/token "));
    assert!(
        header(&sent[0], "authorization")
            .unwrap()
            .starts_with("Basic ")
    );
    assert_eq!(
        sent[0].split_once("\r\n\r\n").unwrap().1,
        "grant_type=client_credentials"
    );
    assert!(sent[1].starts_with("POST /v2/inference/deployments/deployment/v2/completion "));
    assert_eq!(header(&sent[1], "AI-Resource-Group"), Some("group"));
    assert_eq!(header(&sent[1], "authorization"), Some("Bearer sap-access"));
    let body = body(&sent[1]);
    assert_eq!(
        body["config"]["modules"]["prompt_templating"]["model"]["name"],
        "gpt-model"
    );
    assert_eq!(
        body["config"]["modules"]["prompt_templating"]["prompt"]["template"][0]["content"],
        "hello"
    );
    assert_eq!(body["config"]["stream"]["enabled"], true);
    assert_eq!(response.text().as_str(), Some("answer"));
    assert_eq!(response.usage.unwrap().input_tokens, Some(9.0));
}
#[tokio::test]
async fn compatible_usage_opt_out_preserves_observed_usage() {
    let (base, task) = server(200, TEXT).await;
    let model = providers::compatible(
        "custom-model",
        provider::Id("custom".into()),
        config(base),
        Api::Chat,
    )
    .unwrap();
    let mut request = request(model);
    request.provider_options =
        Some(parse_json(r#"{"openai-compatible":{"includeUsage":false}}"#).unwrap());
    let response = generate(&request).await.unwrap();
    assert!(body(&task.await.unwrap()).get("stream_options").is_none());
    assert_eq!(response.usage.unwrap().output_tokens, Some(2.0));
}
