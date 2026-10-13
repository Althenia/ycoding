use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    response::Response,
    routing::any,
};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use ycoding_ai::{llm, route::Executor};
use ycoding_core::resources::{
    catalog::{Catalog, models_dev},
    model::{self, ProviderContext},
};
use ycoding_schema::{DomainDecode, parse_json, provider, stringify_json};

const CHAT: &str = "data: {\"choices\":[{\"delta\":{\"content\":\"answer\"},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1}}\n\ndata: [DONE]\n\n";
const RESPONSES: &str = "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"item\",\"delta\":\"answer\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"response\",\"usage\":{\"input_tokens\":2,\"output_tokens\":1}}}\n\n";
const COHERE: &str = "data: {\"type\":\"message-start\",\"id\":\"msg\"}\n\ndata: {\"type\":\"content-delta\",\"index\":0,\"delta\":{\"message\":{\"content\":{\"text\":\"answer\"}}}}\n\ndata: {\"type\":\"message-end\",\"delta\":{\"finish_reason\":\"COMPLETE\",\"usage\":{\"tokens\":{\"input_tokens\":2,\"output_tokens\":1}}}}\n\n";
const GATEWAY: &str = "data: {\"type\":\"text-delta\",\"id\":\"text\",\"delta\":\"answer\"}\n\ndata: {\"type\":\"finish\",\"finishReason\":{\"unified\":\"stop\"},\"usage\":{\"inputTokens\":{\"total\":2},\"outputTokens\":{\"total\":1}}}\n\n";
const MESSAGES: &str = "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg\",\"usage\":{\"input_tokens\":2}}}\n\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"answer\"}}\n\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\ndata: {\"type\":\"message_stop\"}\n\n";
const GEMINI: &str = "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"answer\"}],\"role\":\"model\"},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":2,\"candidatesTokenCount\":1,\"totalTokenCount\":3}}\n\n";

#[path = "session_support/guardrails.rs"]
mod guardrails;
#[path = "session_support/mod.rs"]
mod support;

type Requests = Arc<Mutex<Vec<(String, axum::http::HeaderMap, serde_json::Value)>>>;

struct Fixture {
    base: String,
    requests: Requests,
    stop: tokio::sync::oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}
impl Fixture {
    async fn new(body: &'static str) -> Self {
        Self::bytes(body.as_bytes().to_vec()).await
    }
    async fn bytes(body: Vec<u8>) -> Self {
        let body = Arc::new(body);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let app = Router::new()
            .fallback(any(
                |State((requests, body)): State<(Requests, Arc<Vec<u8>>)>,
                 request: Request| async move {
                    let (parts, body_bytes) = request.into_parts();
                    let bytes = to_bytes(body_bytes, 1_048_576).await.unwrap();
                    let value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
                    requests
                        .lock()
                        .unwrap()
                        .push((parts.uri.path().into(), parts.headers, value));
                    let body = if parts.uri.path().ends_with("/exchange_user_api_key") {
                        b"{\"accessToken\":\"exchanged\",\"refreshToken\":\"rotated\"}".to_vec()
                    } else if parts.uri.path().ends_with("/oauth/token") {
                        b"{\"access_token\":\"exchanged\",\"expires_in\":60}".to_vec()
                    } else if parts.uri.path().ends_with("/direct_access") {
                        b"{\"token\":\"exchanged\",\"headers\":{\"x-fixture\":\"retained\"}}"
                            .to_vec()
                    } else {
                        body.as_ref().clone()
                    };
                    Response::builder()
                        .header(
                            "content-type",
                            if body.first() == Some(&0) {
                                "application/vnd.amazon.eventstream"
                            } else {
                                "text/event-stream"
                            },
                        )
                        .body(Body::from(body))
                        .unwrap()
                },
            ))
            .with_state((requests.clone(), body));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (stop, done) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = done.await;
                })
                .await
                .unwrap();
        });
        Self {
            base,
            requests,
            stop,
            task,
        }
    }
    async fn finish(self) -> Vec<(String, axum::http::HeaderMap, serde_json::Value)> {
        self.stop.send(()).unwrap();
        self.task.await.unwrap();
        Arc::try_unwrap(self.requests)
            .unwrap()
            .into_inner()
            .unwrap()
    }
}
fn info(package: &str, settings: serde_json::Value) -> ycoding_schema::model::Info {
    let source = parse_json(include_str!(
        "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
    ))
    .unwrap();
    let mut info = models_dev::normalize(&source).unwrap()[0].models[0].clone();
    info.package = Some(package.into());
    info.model_id = "fixture-model".into();
    info.provider_id = provider::Id("fixture".into());
    info.settings =
        Some(provider::Settings::decode(&parse_json(&settings.to_string()).unwrap()).unwrap());
    info
}

#[tokio::test]
async fn configured_bundled_families_reach_real_core_resolution_and_http_wire() {
    for (package, stream, path, auth) in [
        (
            "aisdk:@ai-sdk/alibaba",
            CHAT,
            "/chat/completions",
            "authorization",
        ),
        (
            "aisdk:@ai-sdk/cerebras",
            CHAT,
            "/chat/completions",
            "authorization",
        ),
        (
            "aisdk:@ai-sdk/deepinfra",
            CHAT,
            "/chat/completions",
            "authorization",
        ),
        (
            "aisdk:@ai-sdk/groq",
            CHAT,
            "/chat/completions",
            "authorization",
        ),
        (
            "aisdk:@ai-sdk/togetherai",
            CHAT,
            "/chat/completions",
            "authorization",
        ),
        (
            "aisdk:@ai-sdk/mistral",
            CHAT,
            "/chat/completions",
            "authorization",
        ),
        (
            "aisdk:@ai-sdk/perplexity",
            CHAT,
            "/chat/completions",
            "authorization",
        ),
        (
            "aisdk:venice-ai-sdk-provider",
            CHAT,
            "/chat/completions",
            "authorization",
        ),
        (
            "aisdk:@ai-sdk/vercel",
            CHAT,
            "/chat/completions",
            "authorization",
        ),
        ("aisdk:@ai-sdk/cohere", COHERE, "/chat", "authorization"),
        (
            "aisdk:@ai-sdk/gateway",
            GATEWAY,
            "/language-model",
            "authorization",
        ),
        ("aisdk:@ai-sdk/azure", RESPONSES, "/responses", "api-key"),
        (
            "aisdk:@ai-sdk/github-copilot",
            CHAT,
            "/chat/completions",
            "authorization",
        ),
        (
            "aisdk:ai-gateway-provider",
            CHAT,
            "/chat/completions",
            "authorization",
        ),
    ] {
        let fixture = Fixture::new(stream).await;
        let source = models_dev::normalize(
            &parse_json(include_str!(
                "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
            ))
            .unwrap(),
        )
        .unwrap();
        let mut catalog = Catalog::new(source);
        catalog.configure(&[parse_json(&serde_json::json!({"providers":{"fixture":{"package":package,"settings":{"baseURL":fixture.base,"apiKey":"fixture-key"},"models":{"selected":{"modelID":"fixture-model","limit":{"context":10000,"output":1000}}}}}}).to_string()).unwrap()]).unwrap();
        let selection = ycoding_schema::model::Ref {
            id: "selected".into(),
            provider_id: provider::Id("fixture".into()),
            profile: None,
            variant: None,
        };
        let resolved = model::Resolver::new(catalog)
            .resolve(&selection, &[], None)
            .unwrap();
        let context = ProviderContext::new(BTreeMap::new(), "fixture").unwrap();
        let model = context.model(&resolved.info, None).await.unwrap();
        let mut request = llm::Request::new(model);
        request.messages.push(llm::Message::user("hello"));
        let response = tokio::time::timeout(
            Duration::from_secs(5),
            Executor::new(Executor::http_client().unwrap()).generate(&request),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(response.text(), "answer".into(), "{package}");
        let requests = fixture.finish().await;
        assert_eq!(requests.len(), 1, "{package}");
        assert_eq!(requests[0].0, path, "{package}");
        assert_eq!(
            requests[0].1[auth],
            if auth == "authorization" {
                "Bearer fixture-key"
            } else {
                "fixture-key"
            },
            "{package}"
        );
        assert!(!requests[0].2.to_string().contains("fixture-key"));
    }
}

#[tokio::test]
async fn selected_account_metadata_controls_subscription_routes_not_http_body() {
    let context = ProviderContext::new(BTreeMap::new(), "fixture").unwrap();
    let value = ycoding_schema::credential::Value::decode(&parse_json(r#"{"type":"oauth","methodID":"chatgpt-headless","access":"prepared","refresh":"refresh","expires":9007199254740991,"metadata":{"accountID":"account-a"}}"#).unwrap()).unwrap();
    let model = context
        .model(
            &info(
                "aisdk:@ai-sdk/openai",
                serde_json::json!({"baseURL":"https://ignored.example/v1"}),
            ),
            Some(&value),
        )
        .await
        .unwrap();
    assert_eq!(model.route.id, "openai-codex-responses");
    let prepared = model
        .route
        .prepare(&llm::Request::new(model.clone()))
        .unwrap();
    assert_eq!(
        prepared.url.as_str(),
        "https://chatgpt.com/backend-api/codex/responses"
    );
    assert_eq!(prepared.headers["chatgpt-account-id"], "account-a");
    assert!(!prepared.encoded_body.contains("account-a"));
    let copilot = ycoding_schema::credential::Value::decode(&parse_json(r#"{"type":"oauth","methodID":"device","access":"prepared","refresh":"refresh","expires":0,"metadata":{"enterpriseUrl":"example.ghe.com"}}"#).unwrap()).unwrap();
    let mut info = info("aisdk:@ai-sdk/anthropic", serde_json::json!({}));
    info.provider_id = provider::Id("github-copilot".into());
    let model = context.model(&info, Some(&copilot)).await.unwrap();
    assert_eq!(model.route.id, "github-copilot-messages");
    assert_eq!(
        model.route.endpoint.base_url,
        "https://copilot-api.example.ghe.com"
    );
    assert!(
        !stringify_json(
            &model
                .defaults
                .http
                .body
                .unwrap_or(parse_json("{}").unwrap())
        )
        .contains("enterpriseUrl")
    );
}

#[tokio::test]
async fn gitlab_and_sap_reconstruct_exchanged_credentials_for_each_request() {
    for package in [
        "aisdk:gitlab-ai-provider",
        "aisdk:@jerome-benoit/sap-ai-provider-v2",
    ] {
        let fixture = Fixture::new(CHAT).await;
        let context = ProviderContext::new(BTreeMap::new(), "fixture").unwrap();
        let settings = serde_json::json!({"apiKey":"selected","instanceUrl":fixture.base,"aiGatewayUrl":fixture.base,"deploymentId":"deployment","serviceKey":serde_json::json!({"clientid":"selected","clientsecret":"secret","url":fixture.base,"serviceurls":{"AI_API_URL":fixture.base}}).to_string()});
        let mut info = info(package, settings);
        info.model_id = if package.contains("gitlab") {
            "duo-chat-gpt-5-4".into()
        } else {
            "fixture-model".into()
        };
        for _ in 0..2 {
            let model = context.model(&info, None).await.unwrap();
            let prepared = model
                .route
                .prepare(&llm::Request::new(model.clone()))
                .unwrap();
            assert_eq!(prepared.headers["authorization"], "Bearer exchanged");
        }
        if package.contains("gitlab") {
            info.model_id = "duo-workflow-exact".into();
            assert!(context.model(&info, None).await.is_err());
        }
        let sent = fixture.finish().await;
        assert_eq!(sent.len(), 2);
    }
}

#[test]
fn attribution_transforms_apply_to_configured_aliases_with_distinct_override_rules() {
    let mut catalog = Catalog::new(Vec::new());
    let documents = parse_json(r#"{"providers":{"kilo-alias":{"package":"aisdk:@ai-sdk/openai-compatible","settings":{"baseURL":"https://api.kilo.ai/api/gateway"},"headers":{"X-Title":"user"}},"zenmux-alias":{"package":"aisdk:@ai-sdk/openai-compatible","settings":{"baseURL":"https://zenmux.ai/api/v1"},"headers":{"X-Title":"user"}},"nvidia-alias":{"package":"aisdk:@ai-sdk/openai-compatible","settings":{"baseURL":"https://integrate.api.nvidia.com/v1"},"headers":{"X-BILLING-INVOKE-ORIGIN":"user"}},"cerebras-alias":{"package":"aisdk:@ai-sdk/cerebras"},"router-alias":{"package":"aisdk:@openrouter/ai-sdk-provider","headers":{"X-OpenRouter-Title":"user"},"models":{"gpt-5-chat-latest":{}}}}}"#).unwrap();
    catalog.configure(&[documents]).unwrap();
    catalog.configure(&[parse_json(r#"{"providers":{"llmgateway-alias":{"package":"aisdk:@ai-sdk/openai-compatible","settings":{"baseURL":"https://api.llmgateway.io/v1"},"headers":{"X-Title":"user","X-Source":"user"}},"llmgateway-disabled":{"package":"aisdk:@ai-sdk/openai-compatible","settings":{"baseURL":"https://api.llmgateway.io/v1"}},"vercel-alias":{"package":"aisdk:@ai-sdk/vercel","headers":{"X-Title":"user"}},"wrong-endpoint":{"package":"aisdk:@ai-sdk/openai-compatible","settings":{"baseURL":"https://zenmux.ai/api/v1/"}},"wrong-package":{"package":"@ycoding-ai/ai/providers/openai-compatible","settings":{"baseURL":"https://api.kilo.ai/api/gateway"}}}}"#).unwrap()]).unwrap();
    catalog.set_disabled(&provider::Id("llmgateway-disabled".into()), true);
    catalog.transform_providers(&BTreeMap::new()).unwrap();
    let headers = |id: &str| {
        catalog
            .provider(&provider::Id(id.into()))
            .unwrap()
            .overlays
            .headers
            .as_ref()
            .unwrap()
    };
    assert_eq!(
        headers("kilo-alias").get(&"X-Title".into()),
        Some(&parse_json("\"YCoding\"").unwrap())
    );
    assert_eq!(
        headers("zenmux-alias").get(&"X-Title".into()),
        Some(&parse_json("\"user\"").unwrap())
    );
    assert_eq!(
        headers("nvidia-alias").get(&"X-BILLING-INVOKE-ORIGIN".into()),
        Some(&parse_json("\"user\"").unwrap())
    );
    assert_eq!(
        headers("cerebras-alias").get(&"X-Cerebras-3rd-Party-Integration".into()),
        Some(&parse_json("\"ycoding\"").unwrap())
    );
    assert_eq!(
        headers("router-alias").get(&"X-OpenRouter-Title".into()),
        Some(&parse_json("\"user\"").unwrap())
    );
    for name in ["X-Title", "X-Source"] {
        assert_eq!(
            headers("llmgateway-alias").get(&name.into()),
            Some(&parse_json("\"YCoding\"").unwrap())
        );
    }
    assert_eq!(
        headers("vercel-alias").get(&"x-title".into()),
        Some(&parse_json("\"YCoding\"").unwrap())
    );
    for id in ["llmgateway-disabled", "wrong-endpoint", "wrong-package"] {
        assert!(
            catalog
                .provider(&provider::Id(id.into()))
                .unwrap()
                .overlays
                .headers
                .is_none()
        );
    }
    assert!(
        !catalog
            .all(&[])
            .iter()
            .find(|m| m.provider_id.0 == "router-alias".into())
            .unwrap()
            .enabled
    );
}

fn runner(
    store: &ycoding_store::Store,
    catalog: Catalog,
    context: ProviderContext,
) -> ycoding_core::session::runner::Local {
    ycoding_core::session::runner::Local::new(runner_services(store, catalog, context))
}
fn runner_services(
    store: &ycoding_store::Store,
    catalog: Catalog,
    context: ProviderContext,
) -> ycoding_core::session::runner::Services {
    use ycoding_core::{
        resources::{agent, attachment_store, config, credential, tool_output_store},
        session::{
            runner::{Services, WallClock},
            store::Service,
        },
        tools::registry::Registry,
    };
    Services {
        snapshots: None,
        store: Service::new(store.client()),
        events: ycoding_core::event_feed::Feed::attach(&store.client()),
        location: ycoding_schema::location::Ref::decode(
            &parse_json(r#"{"directory":"/project"}"#).unwrap(),
        )
        .unwrap(),
        models: Arc::new(model::Resolver::new(catalog)),
        agents: Arc::new(agent::Service::new(vec![agent::empty("build".into())])),
        credentials: credential::Service::new(store.client()),
        tools: Arc::new(Registry::new(
            Arc::new(tool_output_store::Store::new(
                &config::Roots::development(
                    &std::env::temp_dir().join("ycoding-provider-glue-output"),
                )
                .unwrap(),
            )),
            None,
            Default::default(),
            Arc::new(|left, right| left.cmp(right)),
        )),
        attachments: Arc::new(
            attachment_store::Store::new(
                std::env::temp_dir().join("ycoding-provider-glue-attachments"),
            )
            .unwrap(),
        ),
        instructions: Vec::new(),
        analysis: None,
        clock: Arc::new(WallClock),
        executor: Arc::new(Executor::new(Executor::http_client().unwrap())),
        compaction: Default::default(),
        guardrails: guardrails::guardrails(store),
        helpers: Default::default(),
        cursor: None,
        claude: None,
        auth: Some(ycoding_core::resources::auth::Preparation {
            providers: Some(context),
            ..Default::default()
        }),
        skill_resolver: None,
        configuration: None,
        image_analyzer: None,
        extensions: Vec::new(),
        session_tools: None,
    }
}
#[tokio::test]
async fn runner_bundled_packages_publish_real_assistant_messages_without_a_bridge() {
    use ycoding_core::session::{pending, run_coordinator::Coordinator, store::Service};
    for (package, stream) in [
        ("@ai-sdk/alibaba", CHAT),
        ("@ai-sdk/mistral", CHAT),
        ("@ai-sdk/perplexity", CHAT),
        ("venice-ai-sdk-provider", CHAT),
        ("@ai-sdk/vercel", CHAT),
        ("@ai-sdk/cohere", COHERE),
        ("@ai-sdk/gateway", GATEWAY),
        ("@ai-sdk/azure", RESPONSES),
        ("@ai-sdk/github-copilot", CHAT),
        ("@ai-sdk/cerebras", CHAT),
        ("@ai-sdk/deepinfra", CHAT),
        ("@ai-sdk/groq", CHAT),
        ("@ai-sdk/togetherai", CHAT),
        ("@ai-sdk/openai", RESPONSES),
        ("@ai-sdk/anthropic", MESSAGES),
        ("@ai-sdk/google", GEMINI),
        ("@ai-sdk/google-vertex", GEMINI),
        ("@ai-sdk/google-vertex/anthropic", MESSAGES),
        ("@ai-sdk/openai-compatible", CHAT),
        ("@openrouter/ai-sdk-provider", RESPONSES),
        ("@ai-sdk/xai", RESPONSES),
        ("@ai-sdk/amazon-bedrock/mantle", RESPONSES),
        ("@ai-sdk/amazon-bedrock", "bedrock"),
        (
            "@ycoding-ai/ai/providers/runpod",
            r#"{"status":"COMPLETED","output":[{"message":{"role":"assistant","content":"answer"},"done":true,"prompt_eval_count":2,"eval_count":1}]}"#,
        ),
        ("ai-gateway-provider", CHAT),
        ("gitlab-ai-provider", CHAT),
        (
            "@jerome-benoit/sap-ai-provider-v2",
            "data: {\"final_result\":{\"choices\":[{\"index\":0,\"delta\":{\"content\":\"answer\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1}}}\n\ndata: [DONE]\n\n",
        ),
        ("workers", CHAT),
        ("cortex", CHAT),
        ("cognitive", CHAT),
        ("muse", RESPONSES),
        ("codex", RESPONSES),
        ("unified", CHAT),
    ] {
        let fixture = if stream == "bedrock" {
            let recorded: serde_json::Value = serde_json::from_str(include_str!("../../../../packages/ai/test/fixtures/recordings/bedrock-converse/streams-text.json")).unwrap();
            Fixture::bytes(decode_base64(
                recorded["interactions"][0]["response"]["body"]
                    .as_str()
                    .unwrap(),
            ))
            .await
        } else {
            Fixture::new(stream).await
        };
        let store = support::store();
        let service = Service::new(store.client());
        let mut catalog = Catalog::new(Vec::new());
        let (provider, package) = match package {
            "workers" => ("cloudflare-workers-ai", "@ai-sdk/openai-compatible"),
            "cortex" => ("snowflake-cortex", "@ai-sdk/openai-compatible"),
            "cognitive" => ("azure-cognitive-services", "@ai-sdk/openai-compatible"),
            "muse" => ("muse", "@ai-sdk/openai"),
            "codex" => ("openai", "@ai-sdk/openai"),
            "unified" => ("unified", "ai-gateway-provider"),
            package => ("fixture", package),
        };
        let model_id = if package == "gitlab-ai-provider" {
            "duo-chat-gpt-5-4"
        } else {
            "fixture-model"
        };
        let package = if package.starts_with("@ycoding-ai/") {
            package.into()
        } else {
            format!("aisdk:{package}")
        };
        let mut settings = serde_json::json!({"baseURL":fixture.base,"apiKey":"fixture-key","accessToken":"fixture-key","worker":"ollama","region":"us-east-1","instanceUrl":fixture.base,"aiGatewayUrl":fixture.base,"deploymentId":"deployment","serviceKey":serde_json::json!({"clientid":"selected","clientsecret":"secret","url":fixture.base,"serviceurls":{"AI_API_URL":fixture.base}}).to_string()});
        if provider == "unified" {
            settings.as_object_mut().unwrap().remove("baseURL");
            settings["accountId"] = "account".into();
            settings["gateway"] = "gateway".into();
        }
        if provider == "openai" {
            settings.as_object_mut().unwrap().remove("apiKey");
            let credentials = ycoding_core::resources::credential::Service::new(store.client());
            credentials.create("codex-profile".into(), "openai".into(), Some("Work".into()), ycoding_store::resources::Secret::new(parse_json(r#"{"type":"oauth","methodID":"chatgpt-headless","access":"fixture-codex","refresh":"refresh","expires":9007199254740991,"metadata":{"accountID":"fixture-account"}}"#).unwrap()).unwrap(), 1).await.unwrap();
        }
        catalog.configure(&[parse_json(&serde_json::json!({"model":{"providerID":provider,"model":"selected"},"providers":{provider:{"package":package,"settings":settings,"models":{"selected":{"modelID":model_id,"capabilities":{"tools":false,"input":["text"],"output":["text"]},"limit":{"context":10000,"output":1000}}}}}}).to_string()).unwrap()]).unwrap();
        service.admit(pending::Request {id:ycoding_schema::session_message::Id::new("msg_fixture").unwrap(),session_id:ycoding_schema::session::Id::new("ses_one").unwrap(),input:ycoding_schema::session_pending::Message::decode(&parse_json(r#"{"type":"user","data":{"text":"Answer this prompt"},"delivery":"steer"}"#).unwrap()).unwrap(),event_id:ycoding_schema::event::Id::new("evt_fixture").unwrap(),created:1}).await.unwrap();
        let mut context = ProviderContext::new(BTreeMap::new(), "fixture").unwrap();
        context
            .endpoints
            .insert("openai-codex-responses".into(), fixture.base.clone());
        context
            .endpoints
            .insert("cloudflare-unified-gateway".into(), fixture.base.clone());
        let coordinator = Coordinator::new(Arc::new(runner(&store, catalog, context)));
        tokio::time::timeout(
            Duration::from_secs(10),
            coordinator.run(&ycoding_schema::session::Id::new("ses_one").unwrap()),
        )
        .await
        .unwrap()
        .unwrap();
        let snapshot = store.client().snapshot().unwrap();
        let message = ycoding_core::session::history::latest(
            &snapshot,
            &ycoding_schema::session::Id::new("ses_one").unwrap(),
            "assistant",
        )
        .unwrap()
        .unwrap();
        assert!(
            stringify_json(&ycoding_schema::DomainEncode::encode(&message)).contains(
                if stream == "bedrock" {
                    "Hello"
                } else {
                    "answer"
                }
            ),
            "{package}"
        );
        let requests = fixture.finish().await;
        assert_eq!(
            requests.len(),
            if package.contains("gitlab") || package.contains("sap-ai") {
                2
            } else {
                1
            },
            "{package}"
        );
        if provider == "unified" {
            assert_eq!(
                requests[0].2[0]["headers"]["Authorization"],
                "Bearer fixture-key"
            );
            assert_eq!(requests[0].1["cf-aig-authorization"], "Bearer fixture-key");
        } else {
            assert!(!requests[0].2.to_string().contains("fixture-key"));
        }
        if provider == "openai" {
            assert_eq!(requests[0].1["chatgpt-account-id"], "fixture-account");
            assert_eq!(requests[0].1["authorization"], "Bearer fixture-codex");
        }
        coordinator.shutdown().await.unwrap();
        store.shutdown().unwrap();
    }
}
fn decode_base64(value: &str) -> Vec<u8> {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    value
        .as_bytes()
        .as_chunks::<4>()
        .0
        .iter()
        .flat_map(|chunk| {
            let values = chunk.map(|byte| {
                if byte == b'=' {
                    0
                } else {
                    alphabet
                        .iter()
                        .position(|candidate| *candidate == byte)
                        .unwrap() as u32
                }
            });
            let bits = (values[0] << 18) | (values[1] << 12) | (values[2] << 6) | values[3];
            [(bits >> 16) as u8, (bits >> 8) as u8, bits as u8]
                .into_iter()
                .take(3 - usize::from(chunk[3] == b'=') - usize::from(chunk[2] == b'='))
        })
        .collect()
}

#[tokio::test]
async fn account_catalog_preserves_key_inventory_and_fences_plan_entitlements() {
    use ycoding_core::resources::{auth::Preparation, catalog::AccountCatalog, credential};
    use ycoding_schema::DomainEncode;
    const MODELS: &str = r#"{"models":[{"slug":"gpt-5.6-luna","available_access_programs":{"cyber":["daybreak_blue","unknown"]}},{"slug":4}]}"#;
    let fixture = Fixture::new(MODELS).await;
    let store = support::store();
    let credentials = credential::Service::new(store.client());
    let key = credentials
        .create(
            "key".into(),
            "openai".into(),
            Some("Key".into()),
            ycoding_store::resources::Secret::new(
                ycoding_schema::credential::Value::decode(
                    &parse_json(r#"{"type":"key","key":"key-token"}"#).unwrap(),
                )
                .unwrap()
                .encode(),
            )
            .unwrap(),
            1,
        )
        .await
        .unwrap();
    let plan=credentials.create("plan".into(),"openai".into(),Some("Plan".into()),ycoding_store::resources::Secret::new(ycoding_schema::credential::Value::decode(&parse_json(r#"{"type":"oauth","methodID":"chatgpt-headless","access":"plan-token","refresh":"refresh","expires":9007199254740991,"metadata":{"accountID":"account-plan"}}"#).unwrap()).unwrap().encode()).unwrap(),2).await.unwrap();
    let mut catalog = Catalog::new(Vec::new());
    catalog.configure(&[parse_json(r#"{"providers":{"openai":{"package":"aisdk:@ai-sdk/openai","models":{"gpt-5.6-luna":{},"gpt-5.6":{},"gpt-5.5-pro":{},"gpt-5-chat-latest":{},"gpt-5.4-mini":{}}}}}"#).unwrap()]).unwrap();
    let mut accounts = AccountCatalog::new(Preparation::default(), BTreeMap::new()).unwrap();
    accounts
        .endpoints
        .insert("codex".into(), fixture.base.clone());
    accounts.seed(&mut catalog, &credentials).unwrap();
    let saved = credentials.all().unwrap();
    let resolver = model::Resolver::new(catalog.clone());
    for (profile, selected) in [("Key", &key), ("Plan", &plan)] {
        for id in [
            "gpt-5.6-luna",
            "gpt-5.6",
            "gpt-5.5-pro",
            "gpt-5-chat-latest",
            "gpt-5.4-mini",
        ] {
            let reference = ycoding_schema::model::Ref {
                provider_id: provider::Id("openai".into()),
                id: id.into(),
                profile: Some(ycoding_schema::model::ProfileName(profile.into())),
                variant: None,
            };
            let allowed = if profile == "Key" {
                id != "gpt-5-chat-latest"
            } else {
                matches!(id, "gpt-5.6-luna" | "gpt-5.4-mini")
            };
            assert_eq!(
                resolver.resolve(&reference, &saved, Some(selected)).is_ok(),
                allowed,
                "{profile}/{id}"
            );
        }
    }
    assert!(
        accounts
            .reconcile(&mut catalog, &credentials, 100, true)
            .await
            .unwrap()
            .is_empty()
    );
    let luna = catalog
        .get(
            &provider::Id("openai".into()),
            &"gpt-5.6-luna".into(),
            Some(&ycoding_schema::model::ProfileName("Plan".into())),
            &saved,
        )
        .unwrap();
    assert_eq!(luna.daybreak.as_ref().unwrap()[0].0, "daybreak_blue".into());
    accounts
        .reconcile(&mut catalog, &credentials, 101, false)
        .await
        .unwrap();
    let sent = fixture.finish().await;
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].1["chatgpt-account-id"], "account-plan");
    credentials.shutdown().await.unwrap();
}

#[tokio::test]
async fn vertex_adc_is_resolved_and_refreshes_at_dispatch_without_secret_body_fields() {
    use ycoding_core::resources::auth::{self, google};
    const GEMINI: &str = "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"answer\"}],\"role\":\"model\"},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":2,\"candidatesTokenCount\":1,\"totalTokenCount\":3}}\n\n";
    let fixture = Fixture::new(GEMINI).await;
    let context = ProviderContext::new(
        BTreeMap::from([
            ("GOOGLE_VERTEX_PROJECT".into(), "project".into()),
            ("GOOGLE_VERTEX_LOCATION".into(), "global".into()),
        ]),
        "fixture",
    )
    .unwrap();
    let store = google::Store::new(
        google::Credentials::AuthorizedUser {
            client_id: "fixture-client".into(),
            client_secret: "fixture-secret".into(),
            refresh_token: "fixture-refresh".into(),
        },
        auth::Client::new(&format!("{}/oauth", fixture.base), "fixture").unwrap(),
        &fixture.base,
    )
    .unwrap();
    context.set_google(store.clone()).await;
    let mut configured = info(
        "aisdk:@ai-sdk/google-vertex",
        serde_json::json!({"baseURL":fixture.base}),
    );
    configured.model_id = " gemini-fixture ".into();
    let model = context.model(&configured, None).await.unwrap();
    let mut request = llm::Request::new(model);
    request.messages.push(llm::Message::user("hello"));
    assert_eq!(
        Executor::new(Executor::http_client().unwrap())
            .generate(&request)
            .await
            .unwrap()
            .text(),
        "answer".into()
    );
    context.shutdown().await;
    let requests = fixture.finish().await;
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[2].1["authorization"], "Bearer exchanged");
    assert!(!requests[2].2.to_string().contains("fixture-secret"));
    assert!(!requests[2].2.to_string().contains("exchanged"));
    assert_eq!(
        requests[2].0,
        "/models/gemini-fixture:streamGenerateContent"
    );
}

#[tokio::test]
async fn cursor_quota_exchanges_selected_profile_key_and_does_not_borrow_another_profile() {
    use ycoding_core::resources::{
        auth::{self, cursor},
        credential,
        model::quota,
    };
    use ycoding_schema::DomainEncode;
    const USAGE: &str = r#"{"planUsage":{"totalPercentUsed":25},"billingCycleStart":1000000,"billingCycleEnd":2000000}"#;
    let fixture = Fixture::new(USAGE).await;
    let store = support::store();
    let credentials = credential::Service::new(store.client());
    let first = credentials
        .create(
            "first".into(),
            "cursor".into(),
            Some("First".into()),
            ycoding_store::resources::Secret::new(
                ycoding_schema::credential::Value::decode(
                    &parse_json(r#"{"type":"key","key":"crsr_first"}"#).unwrap(),
                )
                .unwrap()
                .encode(),
            )
            .unwrap(),
            1,
        )
        .await
        .unwrap();
    credentials
        .create(
            "second".into(),
            "cursor".into(),
            Some("Second".into()),
            ycoding_store::resources::Secret::new(
                ycoding_schema::credential::Value::decode(
                    &parse_json(r#"{"type":"key","key":"crsr_second"}"#).unwrap(),
                )
                .unwrap()
                .encode(),
            )
            .unwrap(),
            2,
        )
        .await
        .unwrap();
    let client = auth::Client::new(&fixture.base, "fixture").unwrap();
    let keys = cursor::Store::new(client.clone());
    let quota = quota::Service::new(
        credentials.clone(),
        quota::Endpoints(BTreeMap::from([("cursor".into(), fixture.base.clone())])),
    )
    .unwrap()
    .with_auth(
        auth::Preparation {
            clients: BTreeMap::from([("cursor".into(), client)]),
            cursor: Some(keys.clone()),
            providers: None,
        },
        None,
    );
    let snapshot = quota
        .get(provider::Id("cursor".into()), Some(first.id()), true, 100)
        .await;
    assert_eq!(snapshot.profile, Some("First".into()));
    assert_eq!(snapshot.status.as_str(), Some("available"));
    assert_eq!(snapshot.windows[0].used, Some(25.0));
    assert!(snapshot.windows[0].remaining.is_none());
    let sent = fixture.finish().await;
    assert_eq!(sent.len(), 3);
    assert_eq!(sent[0].1["authorization"], "Bearer crsr_first");
    assert_eq!(sent[1].1["authorization"], "Bearer exchanged");
    assert_eq!(sent[2].1["authorization"], "Bearer exchanged");
    assert!(
        !sent
            .iter()
            .any(|request| request.1["authorization"] == "Bearer crsr_second")
    );
    quota.shutdown().await.unwrap();
    keys.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[test]
fn builtin_account_methods_register_browser_device_remote_and_env_contracts() {
    use ycoding_core::resources::auth::{Preparation, integration::Draft};
    let mut draft = Draft::default();
    Preparation::default()
        .register(&mut draft, &BTreeMap::new(), None)
        .unwrap();
    for (id, methods) in [
        ("openai", vec!["chatgpt-browser", "chatgpt-headless"]),
        ("xai", vec!["browser", "device"]),
        ("github-copilot", vec!["device"]),
        ("cursor", vec!["browser"]),
        ("muse", vec!["device"]),
        ("opencode", vec!["device"]),
    ] {
        for method in methods {
            assert!(draft.methods(&id.into()).iter().any(|candidate|matches!(candidate,ycoding_schema::integration::Method::OAuth(candidate) if candidate.id.as_lossless().as_str()==Some(method))),"{id}/{method}");
        }
    }
    let copilot = draft
        .methods(&"github-copilot".into())
        .iter()
        .find_map(|method| {
            if let ycoding_schema::integration::Method::OAuth(method) = method {
                Some(method)
            } else {
                None
            }
        })
        .unwrap();
    assert_eq!(copilot.remote, Some(true));
    assert_eq!(copilot.prompts.as_ref().unwrap().len(), 2);
}

#[test]
fn live_model_resolver_replaces_one_catalog_authority_without_changing_prior_snapshots() {
    let mut first = Catalog::new(Vec::new());
    first.configure(&[parse_json(r#"{"providers":{"fixture":{"package":"aisdk:@ai-sdk/openai","settings":{"apiKey":"first"},"models":{"selected":{"modelID":"first-api"}}}}}"#).unwrap()]).unwrap();
    let resolver = model::Resolver::new(first);
    let snapshot = resolver.catalog();
    let selection = ycoding_schema::model::Ref {
        provider_id: provider::Id("fixture".into()),
        id: "selected".into(),
        profile: None,
        variant: None,
    };
    assert_eq!(
        resolver
            .resolve(&selection, &[], None)
            .unwrap()
            .info
            .model_id,
        "first-api".into()
    );
    let mut second = Catalog::new(Vec::new());
    second.configure(&[parse_json(r#"{"providers":{"fixture":{"package":"aisdk:@ai-sdk/openai","settings":{"apiKey":"second"},"models":{"selected":{"modelID":"second-api"}}}}}"#).unwrap()]).unwrap();
    resolver.replace(second).unwrap();
    assert_eq!(
        resolver
            .resolve(&selection, &[], None)
            .unwrap()
            .info
            .model_id,
        "second-api".into()
    );
    assert_eq!(
        snapshot
            .get(&selection.provider_id, &selection.id, None, &[])
            .unwrap()
            .model_id,
        "first-api".into()
    );
}

#[tokio::test]
async fn core_mantle_and_converse_use_resolved_aws_credentials_with_the_correct_service() {
    let context = ProviderContext::new(
        BTreeMap::from([
            ("AWS_ACCESS_KEY_ID".into(), "fixture-key".into()),
            ("AWS_SECRET_ACCESS_KEY".into(), "fixture-secret".into()),
            ("AWS_REGION".into(), "us-east-1".into()),
        ]),
        "fixture",
    )
    .unwrap();
    for (package, service) in [
        ("aisdk:@ai-sdk/amazon-bedrock/mantle", "bedrock-mantle"),
        ("aisdk:@ai-sdk/amazon-bedrock", "bedrock"),
    ] {
        let model = context
            .model(&info(package, serde_json::json!({})), None)
            .await
            .unwrap();
        let prepared = model
            .route
            .prepare(&llm::Request::new(model.clone()))
            .unwrap();
        assert!(
            prepared.headers["authorization"]
                .to_str()
                .unwrap()
                .contains(&format!("/us-east-1/{service}/aws4_request"))
        );
        assert!(prepared.headers["authorization"].is_sensitive());
        assert!(!stringify_json(&prepared.wire_body).contains("fixture-secret"));
        assert!(!stringify_json(&prepared.wire_body).contains("fixture-key"));
    }
    context.shutdown().await;
}

#[tokio::test]
async fn runner_cursor_uses_native_connect_transport_and_account_owned_runtime() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use ycoding_ai::cursor::{
        framing,
        headers::Identity,
        provider::{RequestContext, Runtime},
        transport::Endpoint,
    };
    use ycoding_core::{
        resources::cursor::route::{Extensions, Host},
        session::{pending, run_coordinator::Coordinator, store::Service},
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut preface = [0; 24];
        socket.read_exact(&mut preface).await.unwrap();
        assert_eq!(&preface, b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
        socket.write_all(&h2_frame(4, 0, 0, &[])).await.unwrap();
        let mut decoder = framing::Decoder::default();
        loop {
            let mut header = [0; 9];
            if socket.read_exact(&mut header).await.is_err() {
                break;
            }
            let length =
                ((header[0] as usize) << 16) | ((header[1] as usize) << 8) | header[2] as usize;
            let stream = u32::from_be_bytes(header[5..9].try_into().unwrap()) & 0x7fffffff;
            let mut payload = vec![0; length];
            socket.read_exact(&mut payload).await.unwrap();
            match header[3] {
                4 if header[4] == 0 => socket.write_all(&h2_frame(4, 1, 0, &[])).await.unwrap(),
                6 if header[4] == 0 => socket
                    .write_all(&h2_frame(6, 1, 0, &payload))
                    .await
                    .unwrap(),
                0 if !decoder.push(&payload).is_empty() => {
                    socket
                        .write_all(&h2_frame(1, 4, stream, &[0x88]))
                        .await
                        .unwrap();
                    socket
                        .write_all(&h2_frame(
                            0,
                            0,
                            stream,
                            &framing::encode(
                                0,
                                &[
                                    10, 11, 10, 9, 10, 7, b'a', b'n', b's', b'w', b'e', b'r', b'!',
                                ],
                            )
                            .unwrap(),
                        ))
                        .await
                        .unwrap();
                    socket
                        .write_all(&h2_frame(
                            0,
                            0,
                            stream,
                            &framing::encode(0, &[10, 2, 114, 0]).unwrap(),
                        ))
                        .await
                        .unwrap();
                }
                3 | 7 => break,
                _ => {}
            }
        }
    });
    let store = support::store();
    let service = Service::new(store.client());
    let mut catalog = Catalog::new(Vec::new());
    catalog.configure(&[parse_json(r#"{"model":{"providerID":"cursor","model":"selected"},"providers":{"cursor":{"package":"aisdk:cursor-opencode-provider","env":["CURSOR_API_KEY"],"models":{"selected":{"modelID":"composer-fixture","capabilities":{"tools":false,"input":["text"],"output":["text"]},"limit":{"context":10000,"output":1000}}}}}}"#).unwrap()]).unwrap();
    let environment = BTreeMap::from([("CURSOR_API_KEY".into(), "crsr_fixture".into())]);
    catalog.transform_providers(&environment).unwrap();
    let auth_fixture = Fixture::new(CHAT).await;
    let auth_store = ycoding_core::resources::auth::cursor::Store::new(
        ycoding_core::resources::auth::Client::new(&auth_fixture.base, "fixture").unwrap(),
    );
    service
        .admit(pending::Request {
            id: ycoding_schema::session_message::Id::new("msg_cursor").unwrap(),
            session_id: ycoding_schema::session::Id::new("ses_one").unwrap(),
            input: ycoding_schema::session_pending::Message::decode(
                &parse_json(
                    r#"{"type":"user","data":{"text":"Answer this prompt"},"delivery":"steer"}"#,
                )
                .unwrap(),
            )
            .unwrap(),
            event_id: ycoding_schema::event::Id::new("evt_cursor").unwrap(),
            created: 1,
        })
        .await
        .unwrap();
    let context = ProviderContext::new(environment, "fixture").unwrap();
    let mut local = runner_services(&store, catalog, context.clone());
    local.auth.as_mut().unwrap().cursor = Some(auth_store.clone());
    local.cursor = Some(Host {
        identity: Identity {
            machine_id: "machine".into(),
            mac_machine_id: None,
            client_version: "fixture".into(),
        },
        context: RequestContext::new(vec![0x22, 0]).unwrap(),
        runtime: Arc::new(Runtime::new(Default::default()).unwrap()),
        known_mcp_servers: Vec::new(),
        extensions: Extensions {
            agent: Some(Endpoint::loopback(address).unwrap()),
            ..Default::default()
        },
    });
    let selected = local
        .models
        .resolve(
            &ycoding_schema::model::Ref::decode(
                &parse_json(r#"{"providerID":"cursor","id":"selected"}"#).unwrap(),
            )
            .unwrap(),
            &[],
            None,
        )
        .unwrap();
    assert!(matches!(
        context
            .selected_model(
                &selected.info,
                None,
                None,
                None,
                local.cursor.as_ref(),
                None
            )
            .await,
        Err(model::Error::ProfileUnavailable)
    ));
    assert!(auth_fixture.requests.lock().unwrap().is_empty());
    let coordinator = Coordinator::new(Arc::new(ycoding_core::session::runner::Local::new(local)));
    tokio::time::timeout(
        Duration::from_secs(10),
        coordinator.run(&ycoding_schema::session::Id::new("ses_one").unwrap()),
    )
    .await
    .unwrap()
    .unwrap();
    let message = ycoding_core::session::history::latest(
        &store.client().snapshot().unwrap(),
        &ycoding_schema::session::Id::new("ses_one").unwrap(),
        "assistant",
    )
    .unwrap()
    .unwrap();
    assert!(stringify_json(&ycoding_schema::DomainEncode::encode(&message)).contains("answer!"));
    tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
    coordinator.shutdown().await.unwrap();
    let auth_requests = auth_fixture.finish().await;
    assert_eq!(auth_requests.len(), 1);
    assert_eq!(auth_requests[0].0, "/auth/exchange_user_api_key");
    assert_eq!(auth_requests[0].1["authorization"], "Bearer crsr_fixture");
    auth_store.shutdown().await.unwrap();
    context.shutdown().await;
    store.shutdown().unwrap();
}

fn h2_frame(kind: u8, flags: u8, stream: u32, payload: &[u8]) -> Vec<u8> {
    let length = (payload.len() as u32).to_be_bytes();
    let mut bytes = vec![length[1], length[2], length[3], kind, flags];
    bytes.extend(stream.to_be_bytes());
    bytes.extend(payload);
    bytes
}
