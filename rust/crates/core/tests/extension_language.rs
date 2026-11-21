#![cfg(unix)]

include!("tool_fixture.rs");

use serde_json::{Value, json};
use std::{os::unix::fs::PermissionsExt, sync::Arc, time::Duration};
use ycoding_ai::route::{LanguageAttempt, ProcessInput};
use ycoding_core::extension::{Activation, Host, Launch, Options, PluginRuntime, language};
use ycoding_schema::JsonValue;

const WATCHDOG: Duration = Duration::from_secs(30);
const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packages/cli/test/fixtures/plugin-host/"
);

fn runtime(fixture: &ToolFixture) -> PluginRuntime {
    let executable = fixture.root.join("frontend");
    std::fs::write(
        &executable,
        format!(
            "#!/bin/sh\nexec bun '{}'\n",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../packages/cli/src/plugin-host/main.ts"
            )
        ),
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    PluginRuntime {
        executable,
        args: vec![],
        cache: fixture.root.join("cache"),
        setup: WATCHDOG,
    }
}

async fn activate(
    fixture: &ToolFixture,
) -> (
    Arc<Activation>,
    Arc<ycoding_core::tools::registry::Registry>,
) {
    activate_file(fixture, "language-plugin.ts").await
}

async fn activate_file(
    fixture: &ToolFixture,
    file: &str,
) -> (
    Arc<Activation>,
    Arc<ycoding_core::tools::registry::Registry>,
) {
    let source = fixture.root.join("language.ts");
    std::fs::copy(format!("{FIXTURES}{file}"), &source).unwrap();
    let configuration = ycoding_core::resources::config::Configuration::load(
        ycoding_core::resources::config::LoadOptions {
            directory: fixture.root.clone(),
            roots: ycoding_core::resources::config::Roots::development(&fixture.root).unwrap(),
            project: false,
            file: None,
            content: Some(json!({"plugins": [{"package": source, "options": {"marker":fixture.root.join("closed"), "label":"authored"}}]}).to_string()),
            env: Default::default(),
        },
    )
    .unwrap();
    let registry = Arc::new(fixture.registry());
    let activation = Arc::new(
        Activation::new(
            fixture.root.clone(),
            Options {
                execution: WATCHDOG,
                ..Options::default()
            },
            registry.clone(),
            fixture.policy.clone(),
            Launch::default(),
            Host::default(),
        )
        .with_plugins(runtime(fixture)),
    );
    activation.reload(&configuration).await.unwrap();
    assert_eq!(
        activation.failures().await,
        [],
        "authored public SDK plugin must load"
    );
    (activation, registry)
}

#[tokio::test]
async fn public_promise_sdk_executes_in_the_real_process_and_cleans_up() {
    let fixture = ToolFixture::new();
    let (activation, registry) = activate_file(&fixture, "promise-plugin.ts").await;
    let result = registry
        .materialize(&[])
        .invoke(
            "promise_echo",
            value(json!({"text":"hello"})),
            fixture.context(),
        )
        .await
        .unwrap();
    assert!(result.error.is_none(), "{:?}", result.error);
    assert_eq!(
        serde_json::from_str::<Value>(&ycoding_schema::stringify_json(
            &result.output.unwrap().structured
        ))
        .unwrap(),
        json!({"text":"hello","label":"authored"})
    );
    activation.close().await;
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("closed")).unwrap(),
        "closed"
    );
    fixture.cleanup();
}

#[tokio::test]
async fn cancellation_before_stream_start_reaches_the_owned_model() {
    let fixture = ToolFixture::new();
    let (activation, registry) = activate(&fixture).await;
    let attempt = claim(&activation, "startup-wait").await;
    let task = tokio::spawn(async move { attempt.attempt(input(json!({}))).await });
    let started = registry
        .materialize(&[])
        .invoke(
            "language_state",
            value(json!({"event":"started"})),
            fixture.context(),
        )
        .await
        .unwrap();
    assert!(started.error.is_none());
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    let state = tokio::time::timeout(
        WATCHDOG,
        registry.materialize(&[]).invoke(
            "language_state",
            value(json!({"event":"cancelled"})),
            ycoding_core::tools::context::Context::new("ses_tool", "test", "msg_tool", "cancelled")
                .unwrap(),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(state.error.is_none(), "{:?}", state.error);
    let state: Value = serde_json::from_str(&ycoding_schema::stringify_json(
        &state.output.unwrap().structured,
    ))
    .unwrap();
    assert_eq!(state["cancelled"], 1);
    activation.close().await;
    fixture.cleanup();
}

fn value(value: Value) -> JsonValue {
    ycoding_schema::parse_json(&value.to_string()).unwrap()
}

async fn claim(activation: &Activation, id: &str) -> Arc<dyn LanguageAttempt> {
    language::claim(
        &activation.extensions().await,
        "fixture-sdk",
        &value(json!({"id": id, "providerID": "fixture"})),
        &value(json!({"baseURL": "https://fixture.invalid"})),
    )
    .await
    .unwrap()
    .expect("authored SDK must claim its model")
}

fn input(body: Value) -> ProcessInput {
    ProcessInput {
        model: "fixture".into(),
        options: None,
        body: value(body),
        caller: None,
    }
}

async fn collect(attempt: &dyn LanguageAttempt, body: Value) -> Vec<Value> {
    let mut stream = attempt.attempt(input(body)).await.unwrap();
    let mut parts = vec![];
    while let Some(part) = stream.recv().await {
        parts.push(serde_json::from_str(&ycoding_schema::stringify_json(&part.unwrap())).unwrap());
    }
    parts
}

#[tokio::test]
async fn public_sdk_hooks_preserve_prompt_tools_reasoning_and_replay_across_the_process() {
    let fixture = ToolFixture::new();
    let (activation, _) = activate(&fixture).await;
    let attempt = claim(&activation, "language-hook").await;
    let body = json!({
        "prompt": [
            {"role":"system","content":"system"},
            {"role":"user","content":[{"type":"text","text":"prompt"}]},
            {"role":"assistant","content":[
                {"type":"reasoning","text":"retained reasoning","providerOptions":{"fixture":{"signature":"synthetic"}}},
                {"type":"tool-call","toolCallId":"call_test","toolName":"echo","input":{"text":"hello"}}
            ]},
            {"role":"tool","content":[{"type":"tool-result","toolCallId":"call_test","toolName":"echo","output":{"type":"json","value":{"ok":true}}}]}
        ],
        "tools": [{"type":"function","name":"echo","inputSchema":{"type":"object"}}],
        "providerOptions": {"fixture":{"reasoningEffort":"high"}}
    });
    for _ in 0..2 {
        let parts = tokio::time::timeout(WATCHDOG, collect(attempt.as_ref(), body.clone()))
            .await
            .unwrap();
        assert_eq!(parts[0]["rawValue"]["options"]["prompt"], body["prompt"]);
        assert_eq!(parts[0]["rawValue"]["options"]["tools"], body["tools"]);
        assert_eq!(
            parts[0]["rawValue"]["options"]["providerOptions"],
            body["providerOptions"]
        );
        assert_eq!(parts[0]["rawValue"]["options"]["languageHook"], true);
        assert_eq!(parts[0]["rawValue"]["sdkHook"], true);
    }
    assert!(
        language::claim(
            &activation.extensions().await,
            "native",
            &value(json!({"id":"native"})),
            &value(json!({}))
        )
        .await
        .unwrap()
        .is_none()
    );
    activation.close().await;
    fixture.cleanup();
}

#[tokio::test]
async fn hook_and_startup_and_stream_errors_are_visible_without_replaying() {
    let fixture = ToolFixture::new();
    let (activation, _) = activate(&fixture).await;
    let error = language::claim(
        &activation.extensions().await,
        "fixture-hook-error",
        &value(json!({"id":"x"})),
        &value(json!({})),
    )
    .await
    .err()
    .unwrap();
    assert!(
        error.message.contains("authored SDK hook failure"),
        "{error:?}"
    );
    let attempt = claim(&activation, "startup-error").await;
    let error = attempt.attempt(input(json!({}))).await.err().unwrap();
    assert!(
        error.message.contains("authored startup failure"),
        "{error:?}"
    );
    for (id, message) in [
        ("read-error", "authored stream failure"),
        ("part-error", "authored error part"),
    ] {
        let attempt = claim(&activation, id).await;
        let mut stream = attempt.attempt(input(json!({}))).await.unwrap();
        let first = tokio::time::timeout(WATCHDOG, stream.recv())
            .await
            .unwrap()
            .unwrap();
        if id == "part-error" {
            let part: Value =
                serde_json::from_str(&ycoding_schema::stringify_json(&first.unwrap())).unwrap();
            assert_eq!(part["error"]["message"], message);
        } else {
            assert!(first.unwrap_err().message.contains(message));
        }
    }
    activation.close().await;
    fixture.cleanup();
}

#[tokio::test]
async fn bounded_stream_delivery_keeps_every_part_and_the_terminal_error() {
    let fixture = ToolFixture::new();
    let (activation, registry) = activate(&fixture).await;
    for id in ["burst", "burst-error"] {
        let attempt = claim(&activation, id).await;
        let mut stream = attempt.attempt(input(json!({}))).await.unwrap();
        let context =
            ycoding_core::tools::context::Context::new("ses_tool", "test", "msg_tool", id).unwrap();
        let filled = tokio::time::timeout(
            WATCHDOG,
            registry.materialize(&[]).invoke(
                "language_state",
                value(json!({"wait":true})),
                context,
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(filled.error.is_none(), "{:?}", filled.error);
        let state: Value = serde_json::from_str(&ycoding_schema::stringify_json(
            &filled.output.unwrap().structured,
        ))
        .unwrap();
        assert!(
            state["pulled"].as_u64().unwrap() <= 66,
            "unbounded read-ahead: {state}"
        );
        let mut parts = vec![];
        let mut failure = None;
        while let Some(part) = tokio::time::timeout(WATCHDOG, stream.recv()).await.unwrap() {
            match part {
                Ok(part) => parts.push(
                    serde_json::from_str::<Value>(&ycoding_schema::stringify_json(&part)).unwrap(),
                ),
                Err(error) => failure = Some(error),
            }
        }
        assert_eq!(
            parts
                .iter()
                .filter_map(|part| part["delta"].as_str())
                .collect::<Vec<_>>(),
            (0..192).map(|n| n.to_string()).collect::<Vec<_>>()
        );
        if id == "burst-error" {
            assert!(
                failure
                    .unwrap()
                    .message
                    .contains("authored error after burst")
            );
        } else {
            assert!(failure.is_none());
            assert_eq!(parts.last().unwrap()["type"], "finish");
        }
    }
    activation.close().await;
    fixture.cleanup();
}

#[tokio::test]
async fn dropping_streams_cancels_the_owned_attempt_and_process_exit_is_not_replayed() {
    let fixture = ToolFixture::new();
    let (activation, _) = activate(&fixture).await;
    let extensions = activation.extensions().await;
    let pid = extensions[0].pid();
    let waiting = claim(&activation, "wait").await;
    let mut stream = waiting.attempt(input(json!({}))).await.unwrap();
    assert!(stream.recv().await.unwrap().is_ok());
    drop(stream);
    let exit = claim(&activation, "exit").await;
    let failure = match exit.attempt(input(json!({}))).await {
        Err(error) => error,
        Ok(mut stream) => tokio::time::timeout(WATCHDOG, stream.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap_err(),
    };
    assert!(failure.message.contains("replay prohibited"), "{failure:?}");
    tokio::time::timeout(WATCHDOG, extensions[0].closed())
        .await
        .unwrap();
    assert!(!ycoding_core::platform::process::is_alive(pid).unwrap());
    assert!(exit.attempt(input(json!({}))).await.is_err());
    activation.close().await;
    fixture.cleanup();
}

#[tokio::test]
async fn cached_npm_only_model_executes_through_its_owned_language_host() {
    let fixture = ToolFixture::new();
    let package = fixture
        .root
        .join("cache/packages/fixture-model/node_modules/fixture-model");
    std::fs::create_dir_all(&package).unwrap();
    std::fs::write(
        package.join("package.json"),
        r#"{"name":"fixture-model","version":"1.0.0","type":"module","exports":"./index.js"}"#,
    )
    .unwrap();
    std::fs::copy(
        format!("{FIXTURES}model-package.js"),
        package.join("index.js"),
    )
    .unwrap();
    let activation = Activation::new(
        fixture.root.clone(),
        Options::default(),
        Arc::new(fixture.registry()),
        fixture.policy.clone(),
        Launch::default(),
        Host::default(),
    )
    .with_plugins(runtime(&fixture));
    let attempt = activation
        .package_language(
            "fixture-model",
            &value(json!({"id":"model"})),
            &value(json!({"baseURL":"https://fixture.invalid"})),
        )
        .await
        .unwrap();
    let body =
        json!({"prompt":[{"role":"user","content":[{"type":"text","text":"local package"}]}]});
    let parts = tokio::time::timeout(WATCHDOG, collect(attempt.as_ref(), body.clone()))
        .await
        .unwrap();
    assert_eq!(parts[0]["rawValue"]["id"], "model");
    assert_eq!(
        parts[0]["rawValue"]["options"]["baseURL"],
        "https://fixture.invalid"
    );
    assert_eq!(parts[0]["rawValue"]["prompt"], body["prompt"]);
    activation.close().await;
    assert!(
        activation
            .package_language(
                "fixture-model",
                &value(json!({"id":"model"})),
                &value(json!({}))
            )
            .await
            .is_err()
    );
    fixture.cleanup();
}

#[tokio::test]
async fn activation_closure_is_visible_through_a_retained_binding() {
    let fixture = ToolFixture::new();
    let (activation, _) = activate(&fixture).await;
    let retained = Arc::downgrade(&activation);
    assert!(!activation.is_closed().await);
    activation.close().await;
    let retained = retained.upgrade().unwrap();
    assert!(retained.extensions().await.is_empty());
    assert!(retained.is_closed().await);
    retained.close().await;
    assert!(retained.is_closed().await);
    fixture.cleanup();
}

#[tokio::test]
async fn catalog_http_overlays_reach_the_authored_sdk_request() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let fixture = ToolFixture::new();
    let package = fixture
        .root
        .join("cache/packages/fixture-model/node_modules/fixture-model");
    std::fs::create_dir_all(&package).unwrap();
    std::fs::write(
        package.join("package.json"),
        r#"{"name":"fixture-model","version":"1.0.0","type":"module","exports":"./index.js"}"#,
    )
    .unwrap();
    std::fs::copy(
        format!("{FIXTURES}model-package.js"),
        package.join("index.js"),
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut received = vec![];
        let mut bytes = [0; 4096];
        let header_end = loop {
            let count = socket.read(&mut bytes).await.unwrap();
            assert!(count > 0 && received.len() < 65536);
            received.extend_from_slice(&bytes[..count]);
            if let Some(position) = received.windows(4).position(|part| part == b"\r\n\r\n") {
                break position + 4;
            }
        };
        let headers = String::from_utf8(received[..header_end].to_vec()).unwrap();
        let length: usize = headers
            .lines()
            .find_map(|line| {
                line.split_once(':')
                    .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                    .map(|(_, value)| value.trim().parse().unwrap())
            })
            .unwrap();
        while received.len() < header_end + length {
            let count = socket.read(&mut bytes).await.unwrap();
            assert!(count > 0);
            received.extend_from_slice(&bytes[..count]);
        }
        let body: Value =
            serde_json::from_slice(&received[header_end..header_end + length]).unwrap();
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}").await.unwrap();
        (headers.to_ascii_lowercase(), body)
    });
    let activation = Activation::new(
        fixture.root.clone(),
        Options::default(),
        Arc::new(fixture.registry()),
        fixture.policy.clone(),
        Launch::default(),
        Host::default(),
    )
    .with_plugins(runtime(&fixture));
    let model = value(
        json!({"id":"http", "providerID":"fixture", "headers":{"X-Catalog":"configured"}, "body":{"nested":{"replace":"catalog","added":true},"list":["catalog"],"catalogOnly":true}}),
    );
    let attempt = activation
        .package_language("fixture-model", &model, &value(json!({"baseURL":base_url})))
        .await
        .unwrap();
    let result = async {
        let mut stream = attempt
            .attempt(input(
                json!({"prompt":[],"headers":{"X-Call":"per-request"}}),
            ))
            .await?;
        while let Some(part) = stream.recv().await {
            part?;
        }
        Ok::<(), ycoding_ai::Error>(())
    }
    .await;
    if result.is_err() {
        server.abort();
        let _ = server.await;
        activation.close().await;
        fixture.cleanup();
        panic!("authored SDK request failed: {result:?}");
    }
    let (headers, body) = tokio::time::timeout(WATCHDOG, server)
        .await
        .unwrap()
        .unwrap();
    assert!(headers.starts_with("post /chat http/1.1"), "{headers}");
    assert!(headers.contains("x-catalog: configured\r\n"), "{headers}");
    assert!(headers.contains("x-call: per-request\r\n"), "{headers}");
    assert!(headers.contains("x-sdk: fixture\r\n"), "{headers}");
    assert!(!headers.contains("authorization:"), "{headers}");
    assert_eq!(
        body,
        json!({"model":"http","prompt":[],"nested":{"keep":"sdk","replace":"catalog","added":true},"list":["catalog"],"catalogOnly":true})
    );
    activation.close().await;
    fixture.cleanup();
}
