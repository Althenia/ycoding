use reqwest::header::{HeaderMap, HeaderValue};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use ycoding_ai::{
    auth::Secret,
    cache::Policy,
    claude_code::{self, Account, Credentials, Resolution, Settings},
    llm::{Event, Message, Request, ToolDefinition},
    route::Executor,
};
use ycoding_schema::{
    JsonValue, LosslessString, parse_json, provider_usage::Observation, stringify_json,
};

fn settings() -> Settings {
    Settings {
        version: "2.1.289".into(),
        entrypoint: "sdk-cli".into(),
        user_agent: "claude-cli/2.1.289 (external, sdk-cli)".into(),
        beta_flags: String::new(),
        debug_file: None,
    }
}
fn body(raw: &str) -> serde_json::Value {
    serde_json::from_str(&stringify_json(&claude_code::transform_body(
        parse_json(raw).unwrap(),
        &settings(),
        None,
    )))
    .unwrap()
}
fn markers(value: &serde_json::Value) -> Vec<serde_json::Value> {
    match value {
        serde_json::Value::Array(values) => values.iter().flat_map(markers).collect(),
        serde_json::Value::Object(fields) => fields
            .iter()
            .flat_map(|(key, value)| {
                if key == "cache_control" {
                    vec![value.clone()]
                } else {
                    markers(value)
                }
            })
            .collect(),
        _ => Vec::new(),
    }
}

#[test]
fn managed_headers_required_model_betas_overrides_and_claude_code_fingerprint() {
    let incoming = HeaderMap::from_iter([
        (
            reqwest::header::HeaderName::from_static("x-api-key"),
            HeaderValue::from_static("fixture-discard"),
        ),
        (
            reqwest::header::HeaderName::from_static("anthropic-beta"),
            HeaderValue::from_static(" custom-feature, oauth-2025-04-20,custom-feature "),
        ),
        (
            reqwest::header::HeaderName::from_static("x-session-id"),
            HeaderValue::from_static("ses_fixed"),
        ),
        (
            reqwest::header::HeaderName::from_static("x-stainless-timeout"),
            HeaderValue::from_static("42"),
        ),
    ]);
    let headers = claude_code::headers(
        incoming,
        &Credentials {
            access_token: Secret::new("fixture-access"),
            subscription_type: None,
        },
        &"claude-opus-5".into(),
        &settings(),
        &BTreeSet::new(),
    )
    .unwrap();
    assert_eq!(headers["authorization"], "Bearer fixture-access");
    assert!(headers["authorization"].is_sensitive());
    assert!(!headers.contains_key("x-api-key"));
    assert_eq!(headers["anthropic-version"], "2023-06-01");
    assert_eq!(headers["x-app"], "cli");
    assert_eq!(headers["anthropic-dangerous-direct-browser-access"], "true");
    assert_eq!(
        headers["user-agent"],
        "claude-cli/2.1.289 (external, sdk-cli)"
    );
    assert_eq!(headers["x-claude-code-session-id"], "ses_fixed");
    assert_eq!(headers["x-client-request-id"].to_str().unwrap().len(), 36);
    assert_eq!(headers["x-stainless-timeout"], "42");
    assert_eq!(headers["x-stainless-lang"], "js");
    assert_eq!(
        headers["anthropic-beta"],
        "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advisor-tool-2026-03-01,thinking-token-count-2026-05-13,extended-cache-ttl-2025-04-11,effort-2025-11-24,custom-feature"
    );
    let excluded = BTreeSet::from(["interleaved-thinking-2025-05-14".into()]);
    let betas = claude_code::model_betas(
        &"claude-haiku-4-5-20251001".into(),
        "custom-one,oauth-2025-04-20,custom-two,context-1m-2025-08-07",
        &excluded,
    );
    assert_eq!(&betas[betas.len() - 2..], ["custom-one", "custom-two"]);
    assert!(!betas.iter().any(|beta| beta.starts_with("effort-")
        || beta.starts_with("context-1m")
        || beta.starts_with("interleaved-")));
    let expected = [
        ("x-stainless-lang", "js"),
        ("x-stainless-runtime", "node"),
        ("x-stainless-package-version", "0.81.0"),
        ("x-stainless-runtime-version", "v26.3.0"),
        ("x-stainless-retry-count", "0"),
        ("x-stainless-timeout", "600"),
        (
            "x-stainless-arch",
            match std::env::consts::ARCH {
                "aarch64" => "arm64",
                "x86_64" => "x64",
                arch => arch,
            },
        ),
        (
            "x-stainless-os",
            match std::env::consts::OS {
                "macos" => "MacOS",
                "windows" => "win32",
                os => os,
            },
        ),
    ];
    let credentials = Credentials {
        access_token: Secret::new("fixture-access"),
        subscription_type: None,
    };
    let defaults = claude_code::headers(
        HeaderMap::new(),
        &credentials,
        &"claude-opus-5".into(),
        &settings(),
        &BTreeSet::new(),
    )
    .unwrap();
    for (name, value) in expected {
        assert_eq!(defaults[name], value, "{name}");
    }
    let overrides = HeaderMap::from_iter(expected.iter().map(|(name, _)| {
        (
            reqwest::header::HeaderName::from_static(name),
            HeaderValue::from_static("explicit-value"),
        )
    }));
    let preserved = claude_code::headers(
        overrides,
        &credentials,
        &"claude-opus-5".into(),
        &settings(),
        &BTreeSet::new(),
    )
    .unwrap();
    for (name, _) in expected {
        assert_eq!(preserved[name], "explicit-value", "{name}");
    }
}

#[test]
fn billing_uses_javascript_code_units_and_durable_sample_across_compaction() {
    assert_eq!(claude_code::billing_sample(&"hello".into()), "o00".into());
    assert_eq!(
        claude_code::billing_sample(&"abc😀de😀fghijklmnop".into())
            .code_units()
            .next(),
        Some(0xde00)
    );
    let raw = |text: &str| {
        parse_json(&serde_json::json!({"model":"claude-opus-5", "messages":[{"role":"user","content":text}]}).to_string()).unwrap()
    };
    let before = claude_code::transform_body(
        raw("original durable user text"),
        &settings(),
        Some(&"dur".into()),
    );
    let after = claude_code::transform_body(
        raw("<conversation-checkpoint>compacted</conversation-checkpoint>"),
        &settings(),
        Some(&"dur".into()),
    );
    let before: serde_json::Value = serde_json::from_str(&stringify_json(&before)).unwrap();
    let after: serde_json::Value = serde_json::from_str(&stringify_json(&after)).unwrap();
    assert_eq!(before["system"], after["system"]);
    assert_eq!(
        before["system"][0]["text"],
        "x-anthropic-billing-header: cc_version=2.1.289.d48; cc_entrypoint=sdk-cli;"
    );
    assert!(
        !before["system"][0]["text"]
            .as_str()
            .unwrap()
            .contains("cch=")
    );
    assert_ne!(
        claude_code::transform_body(raw("original durable user text"), &settings(), None),
        claude_code::transform_body(
            raw("<conversation-checkpoint>compacted</conversation-checkpoint>"),
            &settings(),
            None
        )
    );
}

#[test]
fn cached_system_identity_tools_and_history_are_translated_without_ttl_changes() {
    for ttl in ["5m", "1h"] {
        let original = serde_json::json!({"model":"claude-opus-5", "system":[{"type":"text","text":"x-anthropic-billing-header: stale"},{"type":"text","text":format!("{}\n\nstable system",claude_code::IDENTITY),"cache_control":{"type":"ephemeral","ttl":ttl}}], "tools":[{"name":"lookup","input_schema":{"type":"object"},"cache_control":{"type":"ephemeral","ttl":ttl}}], "messages":[{"role":"user","content":"use lookup"},{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"lookup","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"ok"}]}]});
        let transformed = body(&original.to_string());
        assert_eq!(markers(&transformed), markers(&original));
        assert_eq!(transformed["system"].as_array().unwrap().len(), 2);
        assert_eq!(
            transformed["system"][1],
            serde_json::json!({"type":"text","text":claude_code::IDENTITY})
        );
        assert_eq!(
            transformed["messages"][0]["content"][0]["text"],
            "stable system"
        );
        assert_eq!(
            transformed["messages"][0]["content"][0]["cache_control"]["ttl"],
            ttl
        );
        assert_eq!(transformed["tools"][0]["name"], "mcp_Lookup");
        assert_eq!(
            transformed["messages"][1]["content"][0]["name"],
            "mcp_Lookup"
        );
        assert_eq!(transformed["messages"][2]["content"][0]["tool_use_id"], "t");
    }
}

#[test]
fn haiku_removes_effort_only_and_system_without_user_is_retained() {
    let transformed = body(
        r#"{"model":"claude-haiku-4-5","thinking":{"type":"disabled","effort":"high"},"output_config":{"effort":"high","format":{"type":"json_schema"}},"system":[{"type":"text","text":"instructions"}],"messages":[]}"#,
    );
    assert_eq!(
        transformed["thinking"],
        serde_json::json!({"type":"disabled"})
    );
    assert_eq!(
        transformed["output_config"],
        serde_json::json!({"format":{"type":"json_schema"}})
    );
    assert_eq!(transformed["system"][2]["text"], "instructions");
    let transformed = body(
        r#"{"model":"claude-haiku-4-5","thinking":{"effort":"high"},"output_config":{"effort":"high"}}"#,
    );
    assert!(transformed.get("thinking").is_none());
    assert!(transformed.get("output_config").is_none());
    assert!(transformed.get("messages").is_none());
}

#[test]
fn repair_pairs_retains_only_first_immediately_adjacent_uses_and_results() {
    let cases = [
        (
            r#"[{"role":"assistant","content":[{"type":"tool_use","id":"a"},{"type":"tool_use","id":"b"}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"a"}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"b"}]}]"#,
            r#"[{"role":"assistant","content":[{"type":"tool_use","id":"a"}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"a"}]}]"#,
        ),
        (
            r#"[{"role":"user","content":[{"type":"tool_result","tool_use_id":"a"}]},{"role":"assistant","content":[{"type":"text","text":"answer"},{"type":"tool_use","id":"a"}]}]"#,
            r#"[{"role":"assistant","content":[{"type":"text","text":"answer"}]}]"#,
        ),
        (
            r#"[{"content":[{"type":"tool_use","id":"a"},{"type":"tool_use","id":"orphan"}]},{"content":[{"type":"tool_result","tool_use_id":"a"}]},{"content":[{"type":"tool_use","id":"a"},{"type":"text","text":"keep"}]},{"content":[{"type":"tool_result","tool_use_id":"a"}]}]"#,
            r#"[{"content":[{"type":"tool_use","id":"a"}]},{"content":[{"type":"tool_result","tool_use_id":"a"}]},{"content":[{"type":"text","text":"keep"}]}]"#,
        ),
    ];
    for (input, expected) in cases {
        let JsonValue::Array(messages) = parse_json(input).unwrap() else {
            panic!()
        };
        assert_eq!(
            JsonValue::Array(claude_code::repair_pairs(messages)),
            parse_json(expected).unwrap()
        );
    }
}

#[test]
fn usage_headers_preserve_unreported_validate_and_normalize_only_allowed_fields() {
    let empty = claude_code::normalize_headers(&HeaderMap::new(), None, -1).unwrap();
    assert!(empty.windows.is_empty());
    assert_eq!(empty.observed_at.get(), 0);
    let headers = HeaderMap::from_iter([
        (
            reqwest::header::HeaderName::from_static("anthropic-ratelimit-unified-5h-utilization"),
            HeaderValue::from_static("0.42"),
        ),
        (
            reqwest::header::HeaderName::from_static("anthropic-ratelimit-unified-5h-reset"),
            HeaderValue::from_static("1767225600"),
        ),
        (
            reqwest::header::HeaderName::from_static("anthropic-ratelimit-unified-7d-limit"),
            HeaderValue::from_static("100"),
        ),
        (
            reqwest::header::HeaderName::from_static("anthropic-ratelimit-unified-7d-remaining"),
            HeaderValue::from_static("25"),
        ),
        (
            reqwest::header::HeaderName::from_static("private-account"),
            HeaderValue::from_static("fixture-private"),
        ),
    ]);
    let observation = claude_code::normalize_headers(&headers, Some("MAX"), 1).unwrap();
    assert_eq!(observation.label, "Claude Max".into());
    assert_eq!(observation.windows[0].used, Some(42.0));
    assert_eq!(
        observation.windows[0].reset_at.unwrap().get(),
        1767225600000
    );
    assert_eq!(observation.windows[1].used, Some(75.0));
    assert!(!format!("{observation:?}").contains("fixture-private"));
    for raw in ["-1", "101", "NaN", "", "invalid"] {
        let mut headers = headers.clone();
        headers.insert(
            "anthropic-ratelimit-unified-5h-utilization",
            HeaderValue::from_str(raw).unwrap(),
        );
        assert!(claude_code::normalize_headers(&headers, None, 1).is_err());
    }
}

#[derive(Default)]
struct FixtureAccount {
    forced: Mutex<Vec<bool>>,
    rotated: Option<&'static str>,
    unavailable: bool,
    samples: Mutex<Vec<String>>,
    observations: Mutex<Vec<Observation>>,
    observer_fails: bool,
}
impl Account for FixtureAccount {
    fn resolve(&self, force: bool) -> Resolution<'_> {
        Box::pin(async move {
            self.forced.lock().unwrap().push(force);
            if self.unavailable || force && self.rotated.is_none() {
                return Err(claude_code::reconnect());
            }
            Ok(Credentials {
                access_token: Secret::new(if force {
                    self.rotated.unwrap()
                } else {
                    "fixture-first"
                }),
                subscription_type: Some("max".into()),
            })
        })
    }
    fn billing_sample(&self, session: &str) -> Option<LosslessString> {
        self.samples.lock().unwrap().push(session.into());
        (session == "ses_durable").then(|| "dur".into())
    }
    fn observe(&self, observation: Observation) -> Result<(), claude_code::ObservationError> {
        self.observations.lock().unwrap().push(observation);
        if self.observer_fails {
            return Err(claude_code::ObservationError);
        }
        Ok(())
    }
}

struct Fixture {
    base: String,
    requests: Arc<Mutex<Vec<String>>>,
    task: Option<tokio::task::JoinHandle<()>>,
}
impl Fixture {
    async fn new(responses: Vec<(u16, &'static str)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let task = tokio::spawn(async move {
            for (status, response) in responses {
                let (mut socket, _) =
                    tokio::time::timeout(Duration::from_secs(10), listener.accept())
                        .await
                        .unwrap()
                        .unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut chunk = [0; 4096];
                    let count = socket.read(&mut chunk).await.unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&chunk[..count]);
                    if let Some(end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                        let length = String::from_utf8_lossy(&bytes[..end])
                            .lines()
                            .find_map(|line| {
                                line.to_lowercase()
                                    .strip_prefix("content-length: ")
                                    .and_then(|value| value.parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                captured
                    .lock()
                    .unwrap()
                    .push(String::from_utf8(bytes).unwrap());
                socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nanthropic-ratelimit-unified-5h-utilization: 0.42\r\nConnection: close\r\n\r\n", response.len()).as_bytes()).await.unwrap();
                for chunk in response.as_bytes().chunks(7) {
                    socket.write_all(chunk).await.unwrap();
                }
            }
        });
        Self {
            base,
            requests,
            task: Some(task),
        }
    }
    async fn finish(&mut self) {
        self.task.take().unwrap().await.unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}
const SUCCESS: &str = "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10,\"cache_creation_input_tokens\":4,\"cache_read_input_tokens\":3}}}\n\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t\",\"name\":\"mcp_Lookup\",\"input\":{}}}\n\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"value\\\":\\\"ไทย\\\"}\"}}\n\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":2}}\n\ndata: {\"type\":\"message_stop\"}\n\n";
fn request(fixture: &Fixture, account: Arc<FixtureAccount>) -> Request {
    let mut route = claude_code::route(account, settings());
    route.endpoint.base_url = fixture.base.clone();
    let mut request = Request::new(route.model("claude-opus-5"));
    request.cache = Policy::None;
    request.system = vec!["stable system".into()];
    request.messages = vec![Message::user("latest prompt")];
    request.http.headers = BTreeMap::from([
        ("x-session-id".into(), "ses_affinity".into()),
        ("x-ycoding-session".into(), "ses_durable".into()),
    ]);
    request.tools = vec![ToolDefinition {
        name: "lookup".into(),
        description: "Lookup".into(),
        input_schema: parse_json(r#"{"type":"object","properties":{}}"#).unwrap(),
        output_schema: None,
        cache: Some(ycoding_ai::cache::Hint::ephemeral(Some(3600.0))),
        metadata: None,
        native: None,
    }];
    request
}

#[tokio::test]
async fn streaming_flow_restores_names_usage_and_best_effort_observation() {
    let account = Arc::new(FixtureAccount {
        observer_fails: true,
        ..Default::default()
    });
    let mut fixture = Fixture::new(vec![(200, SUCCESS), (200, SUCCESS)]).await;
    let executor = Executor::new(Executor::http_client().unwrap());
    let request = request(&fixture, account.clone());
    for _ in 0..2 {
        let response = executor.generate(&request).await.unwrap();
        assert!(response.events.iter().any(|event| matches!(event, Event::ToolCall(call) if call.name == "lookup".into() && call.input == parse_json(r#"{"value":"ไทย"}"#).unwrap())));
        let usage = response.usage.unwrap();
        assert_eq!(
            (
                usage.input_tokens,
                usage.non_cached_input_tokens,
                usage.cache_read_input_tokens,
                usage.cache_write_input_tokens,
                usage.output_tokens
            ),
            (Some(17.0), Some(10.0), Some(3.0), Some(4.0), Some(2.0))
        );
    }
    fixture.finish().await;
    let requests = fixture.requests.lock().unwrap();
    assert!(requests[0].starts_with("POST /v1/messages?beta=true "));
    assert!(
        requests
            .iter()
            .all(|request| request.contains("x-claude-code-session-id: ses_affinity"))
    );
    let bodies: Vec<serde_json::Value> = requests
        .iter()
        .map(|request| serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap())
        .collect();
    assert_eq!(bodies[0], bodies[1]);
    assert_eq!(
        markers(&bodies[0]),
        [serde_json::json!({"type":"ephemeral","ttl":"1h"})]
    );
    assert_eq!(
        *account.samples.lock().unwrap(),
        ["ses_durable", "ses_durable"]
    );
    assert_eq!(account.observations.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn single_changed_token_401_retry_preserves_request_and_observes_only_final_response() {
    let account = Arc::new(FixtureAccount {
        rotated: Some("fixture-rotated"),
        ..Default::default()
    });
    let mut fixture = Fixture::new(vec![
        (401, "{\"error\":{\"message\":\"expired\"}}"),
        (200, SUCCESS),
    ])
    .await;
    Executor::new(Executor::http_client().unwrap())
        .generate(&request(&fixture, account.clone()))
        .await
        .unwrap();
    fixture.finish().await;
    let requests = fixture.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].contains("authorization: Bearer fixture-first"));
    assert!(requests[1].contains("authorization: Bearer fixture-rotated"));
    assert_eq!(
        requests[0].split_once("\r\n\r\n").unwrap().1,
        requests[1].split_once("\r\n\r\n").unwrap().1
    );
    assert_eq!(*account.forced.lock().unwrap(), [false, true]);
    assert_eq!(account.observations.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn unchanged_or_failed_refresh_preserves_401_without_replay_and_redacts_credentials() {
    for rotated in [Some("fixture-first"), None] {
        let account = Arc::new(FixtureAccount {
            rotated,
            ..Default::default()
        });
        let mut fixture =
            Fixture::new(vec![(401, "{\"error\":{\"message\":\"fixture-first\"}}")]).await;
        let error = Executor::new(Executor::http_client().unwrap())
            .generate(&request(&fixture, account.clone()))
            .await
            .unwrap_err();
        fixture.finish().await;
        assert_eq!(error.status, Some(401));
        assert!(!format!("{error:?}").contains("fixture-first"));
        assert_eq!(fixture.requests.lock().unwrap().len(), 1);
        assert_eq!(*account.forced.lock().unwrap(), [false, true]);
        assert_eq!(account.observations.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn long_context_retries_once_without_changing_cache_markers_and_stops_on_repeat() {
    for final_reply in [
        (200, SUCCESS),
        (
            429,
            "{\"error\":{\"message\":\"You're out of extra usage\"}}",
        ),
    ] {
        let account = Arc::new(FixtureAccount::default());
        let mut fixture = Fixture::new(vec![
            (
                429,
                "{\"error\":{\"message\":\"You're out of extra usage\"}}",
            ),
            final_reply,
        ])
        .await;
        let result = Executor::new(Executor::http_client().unwrap())
            .generate(&request(&fixture, account.clone()))
            .await;
        assert_eq!(result.is_ok(), final_reply.0 == 200);
        fixture.finish().await;
        let requests = fixture.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(
            requests[0]
                .split_once("\r\n\r\n")
                .unwrap()
                .0
                .contains("interleaved-thinking-2025-05-14")
        );
        assert!(
            !requests[1]
                .split_once("\r\n\r\n")
                .unwrap()
                .0
                .contains("interleaved-thinking-2025-05-14")
        );
        assert_eq!(
            requests[0].split_once("\r\n\r\n").unwrap().1,
            requests[1].split_once("\r\n\r\n").unwrap().1
        );
        assert_eq!(account.observations.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn unavailable_account_fails_before_http() {
    let account = Arc::new(FixtureAccount {
        unavailable: true,
        ..Default::default()
    });
    let fixture = Fixture::new(vec![]).await;
    let error = Executor::new(Executor::http_client().unwrap())
        .generate(&request(&fixture, account.clone()))
        .await
        .unwrap_err();
    assert_eq!(error.message, claude_code::RECONNECT);
    assert!(fixture.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn beta_query_preserves_explicit_values_and_only_defaults_the_messages_path() {
    for explicit in [true, false] {
        let account = Arc::new(FixtureAccount::default());
        let mut fixture = Fixture::new(vec![(200, SUCCESS)]).await;
        let mut request = request(&fixture, account);
        if explicit {
            request.http.query.insert("beta".into(), "false".into());
        } else {
            Arc::make_mut(&mut request.model.route).endpoint.base_url =
                fixture.base.replace("/v1", "/custom");
        }
        Executor::new(Executor::http_client().unwrap())
            .generate(&request)
            .await
            .unwrap();
        fixture.finish().await;
        assert!(
            fixture.requests.lock().unwrap()[0].starts_with(if explicit {
                "POST /v1/messages?beta=false "
            } else {
                "POST /custom/messages "
            })
        );
    }
}

#[tokio::test]
async fn debug_events_exclude_credential_material_and_tighten_existing_file_permissions() {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let directory = std::env::temp_dir().join(format!(
        "ycoding-claude-debug-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&directory).unwrap();
    let file = directory.join("events.log");
    std::fs::write(&file, "").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o777)).unwrap();
    }
    let account = Arc::new(FixtureAccount {
        rotated: Some("fixture-rotated"),
        observer_fails: true,
        ..Default::default()
    });
    let mut fixture = Fixture::new(vec![
        (401, "{\"error\":{\"message\":\"fixture-first\"}}"),
        (200, SUCCESS),
    ])
    .await;
    let mut request = request(&fixture, account.clone());
    let mut options = settings();
    options.debug_file = Some(file.clone());
    let mut route = claude_code::route(account, options);
    route.endpoint.base_url = fixture.base.clone();
    request.model.route = Arc::new(route);
    Executor::new(Executor::http_client().unwrap())
        .generate(&request)
        .await
        .unwrap();
    fixture.finish().await;
    let text = std::fs::read_to_string(&file).unwrap();
    let events: Vec<serde_json::Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        events
            .iter()
            .map(|event| event["event"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["credential-rotated", "response-observer-failed"]
    );
    assert!(
        events
            .iter()
            .all(|event| event["data"] == serde_json::json!({}))
    );
    assert!(!text.contains("fixture-first") && !text.contains("fixture-rotated"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    std::fs::remove_dir_all(directory).unwrap();
}
