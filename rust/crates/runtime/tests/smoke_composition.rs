use std::{collections::BTreeMap, path::PathBuf};
use ycoding_core::{
    resources::config,
    ycoding_store::{Metadata, Options, Store, import},
};
use ycoding_runtime::launch::{Parsed, build_production_services, parse_launch};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_smoke_configuration_boots_without_a_model_catalog_service() {
    cold_start().await;
}

async fn cold_start() {
    let root = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("smoke-composition-{}", std::process::id()));
    std::fs::create_dir_all(root.join("home")).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            axum::Router::new().fallback(|| async { axum::http::StatusCode::SERVICE_UNAVAILABLE }),
        )
        .await
        .unwrap();
    });
    let configuration = format!(
        r#"{{
        "efficiency":{{"title":"local","goal_synthesis":"local","openai_responses_continuation":"auto"}},
        "agents":{{"reviewer":{{"description":"Runtime smoke managed subagent","mode":"subagent","model":"openrouter/smoke-model","system":"Complete the delegated task and report the final result."}}}},
        "providers":{{
          "openrouter":{{"name":"OpenRouter","package":"aisdk:@openrouter/ai-sdk-provider","settings":{{"baseURL":"{endpoint}/api/v1"}},"models":{{"smoke-model":{{"name":"Runtime Smoke","capabilities":{{"tools":true,"input":["text"],"output":["text"]}},"limit":{{"context":100000,"output":4096}},"cost":{{"input":1,"output":2,"cache":{{"read":0.1,"write":1.25}}}}}}}}}},
          "openai":{{"name":"OpenAI","package":"@ycoding-ai/ai/providers/openai","settings":{{"baseURL":"{endpoint}/openai/v1","providerOptions":{{"openai":{{"store":true}}}}}},"models":{{"gpt-5.6":{{"name":"Runtime Smoke OpenAI","capabilities":{{"tools":true,"input":["text"],"output":["text"]}},"limit":{{"context":100000,"output":4096}},"cost":{{"input":1,"output":2,"cache":{{"read":0.1,"write":1.25}}}}}}}}}}
        }}
    }}"#
    );
    let environment = BTreeMap::from([
        ("HOME", root.join("home").to_string_lossy().into_owned()),
        (
            "XDG_DATA_HOME",
            root.join("data").to_string_lossy().into_owned(),
        ),
        (
            "XDG_CONFIG_HOME",
            root.join("config").to_string_lossy().into_owned(),
        ),
        (
            "XDG_CACHE_HOME",
            root.join("cache").to_string_lossy().into_owned(),
        ),
        (
            "XDG_STATE_HOME",
            root.join("state").to_string_lossy().into_owned(),
        ),
        ("YCODING_CONFIG_PROJECT_DISABLE", "1".into()),
        ("YCODING_CONFIG_CONTENT", configuration),
        ("YCODING_MODELS_URL", endpoint),
    ]);
    let Parsed::Run(launch) =
        parse_launch(&["--stdio".into(), "--port".into(), "0".into()], |key| {
            environment.get(key).cloned()
        })
        .unwrap()
    else {
        panic!("run configuration required")
    };
    config::Roots::initialize(&launch.roots).unwrap();
    let store = Store::initialize(
        root.join("core.redb"),
        Options::core(),
        import::catalog(import::DatabaseKind::Core),
        Metadata::new([7; 16], 1),
    )
    .unwrap();
    let result = build_production_services(&launch, &store).await;
    server.abort();
    let _ = server.await;
    let services = result
        .expect("the native payload must use its bundled catalog during cold offline startup");
    services.core.unwrap().shutdown().await.unwrap();
    store.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn composition_failure_diagnostics_preserve_the_stdio_protocol() {
    let root = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("smoke-diagnostics-{}", std::process::id()));
    std::fs::create_dir_all(root.join("home")).unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_ycoding-runtime"))
        .args(["--stdio", "--port", "0"])
        .current_dir(&root)
        .env_clear()
        .env("HOME", root.join("home"))
        .env("XDG_DATA_HOME", root.join("data"))
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_CACHE_HOME", root.join("cache"))
        .env("XDG_STATE_HOME", root.join("state"))
        .env("YCODING_CONFIG_PROJECT_DISABLE", "1")
        .env(
            "YCODING_CONFIG_CONTENT",
            format!(
                "{{\"model\":\"{{file:{}}}\"}}",
                root.join("missing-model.txt").display()
            ),
        )
        .env("YCODING_DISABLE_MODELS_FETCH", "1")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty(), "{:?}", output.stdout);
    let diagnostic = String::from_utf8(output.stderr).unwrap();
    assert!(
        diagnostic.contains("production composition failed"),
        "{diagnostic}"
    );
    assert!(
        diagnostic.contains(
            "production composition diagnostic: stage=global configuration; category=unavailable"
        ),
        "{diagnostic}"
    );
    assert!(!diagnostic.contains(&root.display().to_string()));
    std::fs::remove_dir_all(root).unwrap();
}
