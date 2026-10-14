#[path = "provider_contract_support/replay.rs"]
mod replay;
#[path = "provider_contract_support/structured.rs"]
mod structured;

use replay::{Replay, Reply};
use std::sync::{Arc, Mutex};
use ycoding_ai::{
    auth::{Auth, Credential, ProviderAuth},
    cache::{Hint, MessageStrategy, Policy},
    llm::{Event, Media, MediaData, Message, Model, Part, Request, Role, ToolDefinition},
    providers::{self, Api, Config, OpenAIConfig, OpenRouterConfig, Transport},
    route::{Attempt, AttemptPhase, Executor, Route},
};
use ycoding_schema::{parse_json, stringify_json};

const ROUTES: &[(&str, &str, &str)] = &[
    ("openai-responses", "responses", "/v1/responses"),
    ("openai-compatible-responses", "responses", "/v1/responses"),
    ("openai-compatible-chat", "chat", "/v1/chat/completions"),
    ("openrouter-responses", "responses", "/v1/responses"),
    ("anthropic-messages", "messages", "/v1/messages"),
    ("anthropic-compatible", "messages", "/v1/messages"),
    ("openai-codex-responses", "responses", "/v1/responses"),
    ("muse-responses", "responses", "/v1/responses"),
    (
        "anthropic-claude-code",
        "messages",
        "/v1/messages?beta=true",
    ),
];

struct SyntheticClaudeAccount;
impl ycoding_ai::claude_code::Account for SyntheticClaudeAccount {
    fn resolve(&self, _force_refresh: bool) -> ycoding_ai::claude_code::Resolution<'_> {
        Box::pin(async {
            Ok(ycoding_ai::claude_code::Credentials {
                access_token: ycoding_ai::auth::Secret::new("synthetic-key"),
                subscription_type: None,
            })
        })
    }
    fn billing_sample(&self, _session: &str) -> Option<ycoding_schema::LosslessString> {
        None
    }
    fn observe(
        &self,
        _observation: ycoding_schema::provider_usage::Observation,
    ) -> Result<(), ycoding_ai::claude_code::ObservationError> {
        Ok(())
    }
}

fn model(route: &str, base: &str, id: &str) -> Model {
    let mut common = Config::new(Auth::bearer(Credential::value("synthetic-key")));
    common.base_url = Some(format!("{base}/v1"));
    match route {
        "openai-responses" => providers::openai(
            id,
            OpenAIConfig {
                common,
                organization: None,
                project: None,
                transport: Transport::Http,
            },
        ),
        "openai-compatible-responses" | "openai-compatible-chat" => providers::compatible(
            id,
            ycoding_schema::provider::Id("local".into()),
            common,
            if route.ends_with("-chat") {
                Api::Chat
            } else {
                Api::Responses
            },
        )
        .unwrap(),
        "openrouter-responses" => providers::openrouter(
            id,
            OpenRouterConfig {
                common,
                reasoning: None,
            },
        ),
        "anthropic-messages" | "anthropic-compatible" => {
            let mut native = if route == "anthropic-compatible" {
                Route::anthropic_compatible(
                    format!("{base}/v1"),
                    None,
                    ProviderAuth::ApiKey(Credential::value("synthetic-key")),
                )
                .unwrap()
            } else {
                Route::anthropic_provider(ProviderAuth::ApiKey(Credential::value("synthetic-key")))
            };
            native.endpoint.base_url = format!("{base}/v1");
            native.model(id)
        }
        "openai-codex-responses" => {
            let mut config =
                ycoding_ai::openai_codex::Config::new(Credential::value("synthetic-key"));
            config.account_id = Some("synthetic-account".into());
            let mut native = ycoding_ai::openai_codex::model(id, config).unwrap();
            Arc::make_mut(&mut native.route).endpoint.base_url = format!("{base}/v1");
            native
        }
        "muse-responses" => {
            let runtime = ycoding_ai::muse::Runtime::new(format!("{base}/mint")).unwrap();
            let mut native = ycoding_ai::muse::route(ycoding_ai::muse::Connection::key(
                runtime,
                "synthetic-key".into(),
                format!("{base}/v1"),
                None,
            ))
            .model(id);
            Arc::make_mut(&mut native.route).endpoint.base_url = format!("{base}/v1");
            native
        }
        "anthropic-claude-code" => {
            let mut route = ycoding_ai::claude_code::route(
                Arc::new(SyntheticClaudeAccount),
                ycoding_ai::claude_code::Settings {
                    version: "2.1.289".into(),
                    entrypoint: "sdk-cli".into(),
                    user_agent: "claude-cli/2.1.289 (external, sdk-cli)".into(),
                    beta_flags: String::new(),
                    debug_file: None,
                },
            );
            route.endpoint.base_url = format!("{base}/v1");
            route.model(id)
        }
        _ => panic!("route lacks a contract oracle: {route}"),
    }
}

fn tool() -> ToolDefinition {
    ToolDefinition {
        name: "lookup".into(), description: "Lookup".into(),
        input_schema: parse_json(r#"{"type":"object","properties":{"q":{"type":"string"}},"required":["q"],"additionalProperties":false}"#).unwrap(),
        output_schema: None, cache: None, metadata: None, native: None,
    }
}

fn request(native: Model) -> Request {
    let mut request = Request::new(native);
    request.cache = Policy::None;
    request.system.push("Follow the contract.".into());
    request.messages.push(Message::user("Return a value."));
    request.http.body = Some(parse_json(r#"{"metadata":{"fixture":"contract"}}"#).unwrap());
    request
}

fn frames(family: &str, usage_after: bool) -> String {
    match family {
        "messages" => concat!(
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":7,\"cache_read_input_tokens\":0}}}\r\n\r\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\r\n\r\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"answer ไทย\"}}\n\n",
            "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":3}}\n\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        ).into(),
        "responses" => concat!(
            "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg\",\"delta\":\"answer ไทย\"}\r\n\r\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r_fixture\",\"status\":\"completed\",\"usage\":{\"input_tokens\":7,\"output_tokens\":3,\"input_tokens_details\":{\"cached_tokens\":0},\"output_tokens_details\":{\"reasoning_tokens\":0}}}}\n\n",
        ).into(),
        "chat" => {
            let usage = r#""usage":{"prompt_tokens":7,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":0}}"#;
            format!(
                "data: {{\"id\":\"r_fixture\",\"choices\":[{{\"index\":0,\"delta\":{{\"thought\":\"plan\",\"content\":\"answer ไทย\"}},\"finish_reason\":null}}]}}\r\n\r\ndata: {{\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}]{}}}\n\n{}data: [DONE]\n\n",
                if usage_after { String::new() } else { format!(",{usage}") },
                if usage_after { format!("data: {{\"choices\":[],{usage}}}\n\n") } else { String::new() },
            )
        }
        _ => panic!("unplanned framing family"),
    }
}

fn observed_executor(replay: &Replay) -> (Executor, Arc<Mutex<Vec<Attempt>>>) {
    let attempts = Arc::new(Mutex::new(Vec::new()));
    let mut executor = Executor::new(replay.client());
    let observed = attempts.clone();
    executor.observer = Some(Arc::new(move |attempt| {
        observed.lock().unwrap().push(attempt);
        Ok(())
    }));
    (executor, attempts)
}

#[tokio::test]
async fn test_039_route_entrypoints_encode_native_requests_at_the_socket() {
    for (route, family, path) in ROUTES {
        let replay = Replay::start(
            (0..4)
                .map(|index| {
                    Reply::stream(
                        path,
                        if index == 3 {
                            structured::frames(family).into()
                        } else {
                            frames(family, false)
                        },
                    )
                })
                .collect(),
        )
        .await;
        let (executor, attempts) = observed_executor(&replay);
        let base = request(model(route, &replay.base, "contract-model"));
        let expected_text = match *family {
            "messages" => {
                r#"{"model":"contract-model","system":[{"type":"text","text":"Follow the contract."}],"messages":[{"role":"user","content":[{"type":"text","text":"Return a value."}]}],"stream":true,"max_tokens":4096,"metadata":{"fixture":"contract"}}"#.to_owned()
            }
            "chat" => {
                r#"{"model":"contract-model","messages":[{"role":"system","content":"Follow the contract."},{"role":"user","content":"Return a value."}],"stream":true,"stream_options":{"include_usage":true},"metadata":{"fixture":"contract"}}"#.to_owned()
            }
            "responses" => {
                format!(r#"{{"model":"contract-model","input":[{{"role":"system","content":"Follow the contract."}},{{"role":"user","content":[{{"type":"input_text","text":"Return a value."}}]}}],"store":{},"stream":true,"metadata":{{"fixture":"contract"}}}}"#, *route == "openai-responses")
            }
            _ => unreachable!(),
        };
        let mut prepared = Vec::new();
        for capability in ["text", "media", "tool", "structured"] {
            let mut input = base.clone();
            match capability {
                "media" => input.messages[0].content.push(Part::Media(Media {
                    mime: "image/png".into(),
                    data: MediaData::Bytes(vec![1, 2, 3]),
                    filename: None,
                })),
                "tool" => input.tools.push(tool()),
                "structured" => {
                    input.tools = vec![structured::definition()];
                    input.tool_choice =
                        Some(ycoding_ai::llm::ToolChoice::Tool("generate_object".into()));
                }
                "text" => {}
                _ => unreachable!(),
            }
            let native = input.model.route.prepare(&input).unwrap();
            assert_eq!(
                native.url.as_str(),
                format!("{}{}", replay.base, path.split('?').next().unwrap())
            );
            let response = if capability == "structured" {
                let (object, response) = executor
                    .generate_object(&base, structured::schema())
                    .await
                    .unwrap();
                assert_eq!(
                    object,
                    parse_json(r#"{"value":"result"}"#).unwrap(),
                    "{route}: structured result"
                );
                response
            } else {
                let response = executor.generate(&input).await.unwrap();
                assert_eq!(
                    response.text().as_str(),
                    Some("answer ไทย"),
                    "{route}/{capability}"
                );
                response
            };
            assert_eq!(
                response
                    .events
                    .iter()
                    .filter(|event| event.terminal())
                    .count(),
                1
            );
            prepared.push(native.encoded_body);
        }
        let captured = replay.finish().await;
        assert_eq!(captured.len(), 4, "{route}");
        for (actual, expected) in captured.iter().zip(&prepared) {
            assert_eq!(
                &actual.body, expected,
                "{route}: lowering did not reach wire"
            );
            assert!(actual.headers.to_lowercase().contains(
                if *family == "messages" && *route != "anthropic-claude-code" {
                    "x-api-key: synthetic-key"
                } else {
                    "authorization: bearer synthetic-key"
                }
            ));
            assert!(!actual.body.contains("protobuf"));
        }
        if !matches!(
            *route,
            "openai-codex-responses"
                | "openrouter-responses"
                | "muse-responses"
                | "anthropic-claude-code"
        ) {
            assert_eq!(
                captured[0].body, expected_text,
                "{route}: TS native request contract"
            );
        }
        assert!(captured[1].body.contains("AQID"), "{route}: media missing");
        assert!(
            captured[2]
                .body
                .contains(if *route == "anthropic-claude-code" {
                    "Lookup"
                } else {
                    "lookup"
                }),
            "{route}: local tool missing"
        );
        assert!(
            captured[3].body.contains("value"),
            "{route}: structured schema missing"
        );
        assert_eq!(
            attempts
                .lock()
                .unwrap()
                .iter()
                .filter(|attempt| attempt.phase == AttemptPhase::Started)
                .count(),
            4
        );
    }
}

#[tokio::test]
async fn test_040_route_stream_error_usage_and_physical_accounting() {
    for (route, family, path) in ROUTES {
        for usage_after in if *family == "chat" {
            &[false, true][..]
        } else {
            &[false][..]
        } {
            let replay =
                Replay::start(vec![Reply::stream(path, frames(family, *usage_after))]).await;
            let (executor, attempts) = observed_executor(&replay);
            let response = executor
                .generate(&request(model(route, &replay.base, "contract-model")))
                .await
                .unwrap();
            let usage = response.usage.as_ref().unwrap();
            assert_eq!(
                (
                    usage.input_tokens,
                    usage.output_tokens,
                    usage.cache_read_input_tokens
                ),
                (Some(7.0), Some(3.0), Some(0.0)),
                "{route}/{usage_after}"
            );
            assert_eq!(
                response
                    .events
                    .iter()
                    .filter(|event| event.terminal())
                    .count(),
                1
            );
            assert_eq!(
                response
                    .events
                    .iter()
                    .filter(|event| matches!(event, Event::StepFinish { .. }))
                    .count(),
                1
            );
            if *family == "chat" {
                assert_eq!(response.reasoning().as_str(), Some("plan"));
                assert!(!response.text().as_str().unwrap().contains("plan"));
            }
            assert_eq!(replay.finish().await.len(), 1);
            let attempts = attempts.lock().unwrap();
            assert_eq!(attempts.len(), 2, "{route}: hidden request/retry");
            assert_eq!(attempts[0].phase, AttemptPhase::Started);
            assert_eq!(attempts[1].phase, AttemptPhase::Succeeded);
        }
        for (case, reply) in [
            ("sentinel", Reply::stream(path, "data: [DONE]\n\n")),
            (
                "partial",
                Reply::stream(
                    path,
                    match *family {
                        "messages" => {
                            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"partial\"}}\n\n"
                        }
                        "chat" => {
                            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\n"
                        }
                        _ => {
                            "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg\",\"delta\":\"partial\"}\n\n"
                        }
                    },
                ),
            ),
            (
                "retry-hint",
                Reply {
                    headers: "Retry-After: 0\r\n",
                    ..Reply::json(
                        "POST",
                        path,
                        429,
                        r#"{"error":{"type":"rate_limit_error","message":"synthetic failure"}}"#,
                    )
                },
            ),
        ] {
            let replay = Replay::start(vec![reply]).await;
            let (executor, attempts) = observed_executor(&replay);
            let result = executor
                .generate(&request(model(route, &replay.base, "contract-model")))
                .await;
            assert!(result.is_err(), "{route}/{case}: false success");
            if case == "retry-hint" {
                let error = result.unwrap_err();
                assert_eq!(error.status, Some(429));
                assert_eq!(error.retry_after_ms, Some(0.0));
            }
            assert_eq!(replay.finish().await.len(), 1);
            let attempts = attempts.lock().unwrap();
            assert_eq!(attempts.len(), 2, "{route}/{case}: replay hidden");
            assert_eq!(attempts[0].phase, AttemptPhase::Started);
            assert_eq!(
                attempts[1].phase,
                if case == "retry-hint" {
                    AttemptPhase::Failed
                } else {
                    AttemptPhase::Succeeded
                }
            );
        }
    }
}

#[test]
fn test_041_gpt_family_and_anthropic_direct_compatible_cache_wire() {
    for id in ["gpt-5.5", "gpt-5.6", "gpt-6", "gpt-daybreak-blue-latest"] {
        let mut input = request(model("openai-responses", "http://127.0.0.1:1", id));
        input.provider_options = Some(parse_json(r#"{"openai":{"promptCacheKey":"stable-key","promptCacheRetention":"24h","promptCacheOptions":{"mode":"explicit","ttl":"30m"}}}"#).unwrap());
        input.cache = Policy::Explicit {
            tools: true,
            system: true,
            messages: Some(MessageStrategy::Tail(1)),
            ttl_seconds: None,
        };
        let body = input.model.route.prepare(&input).unwrap().encoded_body;
        assert!(body.contains(r#""prompt_cache_key":"stable-key""#));
        let modern = id != "gpt-5.5";
        assert_eq!(body.contains("prompt_cache_options"), modern, "{id}");
        assert_eq!(body.contains("prompt_cache_breakpoint"), modern, "{id}");
        assert_eq!(body.contains("prompt_cache_retention"), !modern, "{id}");
    }
    for route in ["anthropic-messages", "anthropic-compatible"] {
        let mut input = request(model(route, "http://127.0.0.1:1", "claude-sonnet-4-5"));
        input.tools.push(tool());
        input.cache = Policy::Explicit {
            tools: true,
            system: true,
            messages: Some(MessageStrategy::Tail(1)),
            ttl_seconds: Some(3600.0),
        };
        let prepared = input.model.route.prepare(&input).unwrap();
        let body: serde_json::Value = serde_json::from_str(&prepared.encoded_body).unwrap();
        for marker in [
            &body["tools"][0]["cache_control"],
            &body["system"][0]["cache_control"],
            &body["messages"][0]["content"][0]["cache_control"],
        ] {
            assert_eq!(
                marker,
                &serde_json::json!({"type":"ephemeral","ttl":"1h"}),
                "{route}"
            );
        }
        input.messages.push(Message::new(
            Role::User,
            vec![Part::Text("volatile".into())],
        ));
        input.messages.last_mut().unwrap().volatile = true;
        let actual: serde_json::Value =
            serde_json::from_str(&input.model.route.prepare(&input).unwrap().encoded_body).unwrap();
        let mut expected = body;
        expected["messages"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"role":"user","content":[{"type":"text","text":"volatile"}]}));
        assert_eq!(actual, expected);
    }
}

#[test]
fn test_041_lossless_canonical_request_bytes_and_digest_restore_after_overlay_changes() {
    let route = Route::anthropic();
    let mut input = Request::new(route.model("claude-contract"));
    input.cache = Policy::None;
    input.system.push(ycoding_ai::llm::TextPart::from("stable"));
    input.messages.push(Message::user("suffix"));
    input.http.body = Some(parse_json(r#"{"metadata":{"2":"two","10":"ten","a\ud800":"mixed","\udfff":"lone","pair":"\ud83d\ude80","number":1e+21}}"#).unwrap());
    let expected = r#"{"model":"claude-contract","system":[{"type":"text","text":"stable"}],"messages":[{"role":"user","content":[{"type":"text","text":"suffix"}]}],"stream":true,"max_tokens":4096,"metadata":{"2":"two","10":"ten","a\ud800":"mixed","\udfff":"lone","pair":"🚀","number":1e+21}}"#;
    let baseline = route.prepare(&input).unwrap().encoded_body;
    assert_eq!(baseline, expected);
    let digest = |text: &str| {
        ring::digest::digest(&ring::digest::SHA256, text.as_bytes())
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };
    assert_eq!(digest(&baseline), digest(expected));
    input.system[0].cache = Some(Hint::ephemeral(None));
    assert_ne!(route.prepare(&input).unwrap().encoded_body, baseline);
    input.system[0].cache = None;
    assert_eq!(route.prepare(&input).unwrap().encoded_body, baseline);
    input.tools.push(tool());
    assert_ne!(route.prepare(&input).unwrap().encoded_body, baseline);
    input.tools.clear();
    assert_eq!(route.prepare(&input).unwrap().encoded_body, baseline);
    assert_eq!(stringify_json(&parse_json(&baseline).unwrap()), baseline);
}

#[tokio::test]
async fn test_039_040_websocket_entrypoint_matrix_native_body_and_terminal_accounting() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::accept_async;
    for codex in [false, true] {
        for outcome in ["complete", "partial", "error"] {
            tokio::time::timeout(std::time::Duration::from_secs(15), async {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let address = listener.local_addr().unwrap();
                let server = tokio::spawn(async move {
                    let (socket, _) = listener.accept().await.unwrap();
                    let mut socket = accept_async(socket).await.unwrap();
                    let request = socket.next().await.unwrap().unwrap().into_text().unwrap();
                    let body: serde_json::Value = serde_json::from_str(&request).unwrap();
                    assert_eq!(body["type"], "response.create");
                    assert_eq!(body["model"], "gpt-5.6");
                    assert!(request.contains("generate_object"));
                    assert!(request.contains("data:image/png;base64,AQID"));
                    assert!(request.contains("additionalProperties"));
                    if outcome == "complete" {
                        for frame in structured::frames("responses").lines().filter_map(|line| line.strip_prefix("data: ")) {
                            let mut event: serde_json::Value = serde_json::from_str(frame).unwrap();
                            if event["type"] == "response.completed" {
                                event["response"]["usage"] = serde_json::json!({"input_tokens":0,"output_tokens":0,"input_tokens_details":{"cached_tokens":0}});
                            }
                            socket.send(tokio_tungstenite::tungstenite::Message::Text(event.to_string().into())).await.unwrap();
                        }
                        socket.close(None).await.unwrap();
                        return request;
                    }
                    let reply = match outcome {
                        "partial" => r#"{"type":"response.output_text.delta","item_id":"msg","delta":"partial"}"#,
                        "error" => r#"{"type":"error","error":{"code":"invalid_api_key","message":"synthetic rejection"}}"#,
                        _ => unreachable!(),
                    };
                    socket.send(tokio_tungstenite::tungstenite::Message::Text(reply.into())).await.unwrap();
                    socket.close(None).await.unwrap();
                    request
                });
                let mut native = if codex {
                    let mut config = ycoding_ai::openai_codex::Config::new(Credential::value("synthetic-key"));
                    config.websocket = true;
                    config.account_id = Some("synthetic-account".into());
                    ycoding_ai::openai_codex::model("gpt-5.6", config).unwrap()
                } else {
                    providers::openai("gpt-5.6", OpenAIConfig {
                        common: Config::new(Auth::bearer(Credential::value("synthetic-key"))),
                        organization: None, project: None, transport: Transport::WebSocket,
                    })
                };
                Arc::make_mut(&mut native.route).endpoint.base_url = format!("http://{address}/v1");
                let mut input = request(native);
                input.http.body = None;
                input.tools.push(tool());
                input.messages[0].content.push(Part::Media(Media { mime: "image/png".into(), data: MediaData::Bytes(vec![1,2,3]), filename: None }));
                let attempts = Arc::new(Mutex::new(Vec::new()));
                let recorded = attempts.clone();
                let mut executor = Executor::new(Executor::http_client().unwrap());
                executor.observer = Some(Arc::new(move |attempt| { recorded.lock().unwrap().push(attempt); Ok(()) }));
                let result = executor.generate_object(&input, structured::schema()).await;
                if outcome == "complete" {
                    let (object, response) = result.unwrap();
                    assert_eq!(object, parse_json(r#"{"value":"result"}"#).unwrap());
                    assert_eq!(response.events.iter().filter(|event| event.terminal()).count(), 1);
                    assert_eq!(response.usage.unwrap().cache_read_input_tokens, Some(0.0));
                } else {
                    assert!(result.is_err(), "{codex}/{outcome}: false settlement");
                }
                server.await.unwrap();
                let recorded = attempts.lock().unwrap();
                assert_eq!(recorded.len(), 2, "{codex}/{outcome}: physical request accounting");
                assert_eq!(recorded[0].phase, AttemptPhase::Started);
                assert_eq!(recorded[1].phase, AttemptPhase::Succeeded);
            }).await.unwrap();
        }
    }
}

#[tokio::test]
async fn test_039_040_cursor_native_composition_and_physical_terminal_table() {
    use ycoding_ai::cursor::{framing, headers, protobuf, provider, transport};
    for outcome in ["complete", "partial", "error"] {
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (socket, _) = listener.accept().await.unwrap();
                let mut connection = h2::server::handshake(socket).await.unwrap();
                let (request, mut response) = connection.accept().await.unwrap().unwrap();
                assert_eq!(request.uri().path(), "/agent.v1.AgentService/Run");
                assert_eq!(request.headers()["authorization"], "Bearer synthetic-key");
                assert_eq!(request.headers()["content-type"], "application/connect+proto");
                let mut body = request.into_body();
                let exchange = async move {
                    let mut decoder = framing::Decoder::default();
                    let frame = loop {
                        let bytes = body.data().await.unwrap().unwrap();
                        body.flow_control().release_capacity(bytes.len()).unwrap();
                        if let Some(frame) = decoder.push(&bytes).pop() { break frame; }
                    };
                    let envelope = protobuf::fields(&frame.payload).unwrap();
                    let run = protobuf::fields(envelope[0].bytes().unwrap()).unwrap();
                    let model = protobuf::fields(run.iter().find(|field| field.number == 9).unwrap().bytes().unwrap()).unwrap();
                    assert_eq!(model[0].text().unwrap(), "composer-contract");
                    assert!(frame.payload.windows("Return a value.".len()).any(|bytes| bytes == b"Return a value."));
                    assert!(frame.payload.windows("lookup".len()).any(|bytes| bytes == b"lookup"));
                    let mut send = response.send_response(http::Response::builder().status(200).body(()).unwrap(), false).unwrap();
                    if outcome == "error" {
                        send.send_data(bytes::Bytes::from(framing::encode(framing::END_STREAM, br#"{"error":{"code":"resource_exhausted","retryAfter":"0s"}}"#).unwrap()), false).unwrap();
                    } else {
                        send.send_data(bytes::Bytes::from(framing::encode(0, &[10, 5, 10, 3, 10, 1, b'x']).unwrap()), false).unwrap();
                        if outcome == "complete" {
                            send.send_data(bytes::Bytes::from(framing::encode(0, &[10, 2, 114, 0]).unwrap()), false).unwrap();
                        } else {
                            send.send_data(bytes::Bytes::new(), true).unwrap();
                        }
                    }
                    while let Some(bytes) = body.data().await {
                        match bytes {
                            Ok(bytes) => body.flow_control().release_capacity(bytes.len()).unwrap(),
                            Err(error) => { assert_eq!(error.reason(), Some(h2::Reason::CANCEL)); break; },
                        }
                    }
                };
                tokio::pin!(exchange);
                tokio::select! {
                    () = &mut exchange => {},
                    next = connection.accept() => { assert!(next.is_none(), "unplanned Cursor request"); exchange.await; },
                }
            });
            let runtime = Arc::new(provider::Runtime::new(Default::default()).unwrap());
            let mut config = provider::Config::new(Auth::bearer(Credential::value("synthetic-key")), headers::Identity {
                machine_id: "synthetic-machine".into(), mac_machine_id: None, client_version: "contract".into(),
            }, provider::RequestContext::new(vec![10,0]).unwrap(), runtime.clone());
            config.agent = Some(transport::Endpoint::loopback(address).unwrap());
            let mut input = request(provider::model("composer-contract", config).unwrap());
            input.http.body = None;
            input.tools.push(tool());
            let recorded = Arc::new(Mutex::new(Vec::new()));
            let observed = recorded.clone();
            let mut executor = Executor::new(Executor::http_client().unwrap());
            executor.observer = Some(Arc::new(move |attempt| { observed.lock().unwrap().push(attempt); Ok(()) }));
            let result = executor.generate(&input).await;
            if outcome == "complete" {
                let response = result.unwrap();
                assert_eq!(response.text().as_str(), Some("x"));
                assert_eq!(response.usage, None);
                assert_eq!(response.events.iter().filter(|event| event.terminal()).count(), 1);
                assert_eq!(response.events.iter().filter(|event| matches!(event, Event::StepFinish { .. })).count(), 1);
            } else {
                assert!(result.is_err(), "Cursor/{outcome}: false success");
            }
            server.await.unwrap();
            runtime.shutdown().await;
            let recorded = recorded.lock().unwrap();
            assert_eq!(recorded.iter().filter(|attempt| attempt.phase == AttemptPhase::Started).count(), 1);
            assert_eq!(recorded.iter().filter(|attempt| attempt.phase != AttemptPhase::Started).count(), 1);
        }).await.unwrap();
    }
}
