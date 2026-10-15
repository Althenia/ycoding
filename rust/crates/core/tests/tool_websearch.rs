include!("tool_fixture.rs");
use std::{
    io::{Read, Write},
    sync::{Arc, Mutex},
};
use ycoding_core::tools::{
    builtin::websearch::{self, Config, Provider, WebSearch},
    registry::Options,
};
use ycoding_schema::{JsonValue, parse_json};

#[tokio::test]
async fn provider_pin_overrides_environment_for_all_sessions() {
    use ycoding_core::{
        resources::config::{Configuration, LoadOptions, Roots},
        tools::registry::Tool,
    };
    let fixture = ToolFixture::new();
    fixture.authority.session("ses_other", None, 1, false, None);
    let roots = Roots::development(&fixture.root).unwrap();
    roots.initialize().unwrap();
    let path = roots.config.join("ycoding.json");
    std::fs::write(
        &path,
        r#"{"capabilities":{"websearch_provider":"parallel"}}"#,
    )
    .unwrap();
    let configuration = Arc::new(
        Configuration::load(LoadOptions {
            directory: fixture.root.clone(),
            roots,
            project: false,
            file: None,
            content: None,
            env: Default::default(),
        })
        .unwrap(),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint =
        url::Url::parse(&format!("http://{}/mcp", listener.local_addr().unwrap())).unwrap();
    let (send, mut requests) = tokio::sync::mpsc::unbounded_channel();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let router = axum::Router::new().route(
        "/mcp",
        axum::routing::post(move |body: axum::body::Bytes| {
            send.send(parse_json(std::str::from_utf8(&body).unwrap()).unwrap())
                .unwrap();
            async { r#"{"result":{"content":[{"type":"text","text":"Pinned search result"}]}}"# }
        }),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let mut tool = WebSearch::new(
        Config::from_environment(&std::collections::BTreeMap::from([(
            "YCODING_WEBSEARCH_PROVIDER".into(),
            "exa".into(),
        )])),
        fixture.policy.clone(),
        "test".into(),
    )
    .unwrap();
    tool.configuration = Some(configuration);
    tool.exa_url = endpoint.clone();
    tool.parallel_url = endpoint;
    for (pin, expected) in [
        (Some("parallel"), "parallel"),
        (Some("exa"), "exa"),
        (None, "parallel"),
    ] {
        std::fs::write(
            &path,
            pin.map_or_else(
                || "{}".into(),
                |pin| format!(r#"{{"capabilities":{{"websearch_provider":"{pin}"}}}}"#),
            ),
        )
        .unwrap();
        for id in ["ses_tool", "ses_other"] {
            let mut context = fixture.context();
            context.session_id = ycoding_schema::session::Id::new(id).unwrap();
            let output = tool
                .settle(
                    parse_json(r#"{"query":"current runtime"}"#).unwrap(),
                    context,
                )
                .await
                .unwrap();
            let JsonValue::Object(output) = output.structured else {
                panic!()
            };
            assert_eq!(
                output.get(&"provider".into()),
                Some(&JsonValue::String(expected.into()))
            );
            assert!(
                ycoding_schema::stringify_json(&requests.recv().await.unwrap()).contains(
                    if expected == "exa" {
                        "web_search_exa"
                    } else {
                        "session_id"
                    }
                )
            );
        }
        tool.config.provider = Some(Provider::Parallel);
    }
    stop.send(()).unwrap();
    server.await.unwrap();
}

#[test]
fn provider_selection_flags_and_response_parser_match_ts() {
    let session = "ses_websearch_test".into();
    assert_eq!(
        websearch::select_provider(
            &session,
            &Config {
                enable_exa: true,
                enable_parallel: true,
                ..Default::default()
            }
        ),
        Provider::Parallel
    );
    assert_eq!(
        websearch::select_provider(
            &session,
            &Config {
                enable_exa: true,
                ..Default::default()
            }
        ),
        Provider::Exa
    );
    assert_eq!(
        websearch::select_provider(
            &session,
            &Config {
                provider: Some(Provider::Exa),
                enable_parallel: true,
                ..Default::default()
            }
        ),
        Provider::Exa
    );
    let payload = r#"{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"search results"}]}}"#;
    assert_eq!(
        websearch::parse_response(payload)
            .unwrap()
            .unwrap()
            .as_str(),
        Some("search results")
    );
    assert_eq!(
        websearch::parse_response(&format!(
            "data: [DONE]\nevent: message\ndata: {payload}\n\n"
        ))
        .unwrap()
        .unwrap()
        .as_str(),
        Some("search results")
    );
    assert!(websearch::parse_response(r#"{"result":{"content":[{"type":"text"}]}}"#).is_err());
    assert_eq!(websearch::parse_response("").unwrap(), None);
}

#[tokio::test]
async fn real_exa_and_parallel_requests_preserve_wire_shape_and_redact_credentials() {
    let fixture = ToolFixture::new();
    let requests = Arc::new(Mutex::new(vec![]));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint =
        url::Url::parse(&format!("http://{}/mcp", listener.local_addr().unwrap())).unwrap();
    let record = requests.clone();
    let server = std::thread::spawn(move || {
        for _ in 0..2 {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = vec![];
            let mut buffer = [0; 4096];
            loop {
                let size = socket.read(&mut buffer).unwrap();
                if size == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..size]);
                let text = String::from_utf8_lossy(&request);
                if let Some((header, body)) = text.split_once("\r\n\r\n") {
                    let length = header
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(str::to_owned)
                        })
                        .unwrap()
                        .parse::<usize>()
                        .unwrap();
                    if body.len() >= length {
                        break;
                    }
                }
            }
            record
                .lock()
                .unwrap()
                .push(String::from_utf8(request).unwrap());
            let body = r#"{"result":{"content":[{"type":"text","text":"search results"}]}}"#;
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        }
    });
    for provider in [Provider::Exa, Provider::Parallel] {
        let registry = fixture.registry();
        let _scope = registry
            .register(
                vec![(
                    "websearch".into(),
                    Arc::new(WebSearch {
                        configuration: None,
                        client: reqwest::Client::new(),
                        config: Config {
                            provider: Some(provider),
                            exa_api_key: Some("synthetic exa".into()),
                            parallel_api_key: Some("synthetic-parallel".into()),
                            ..Default::default()
                        },
                        policy: fixture.policy.clone(),
                        exa_url: endpoint.clone(),
                        parallel_url: endpoint.clone(),
                        version: "test".into(),
                        year: 2026,
                    }),
                )],
                Options::direct(),
            )
            .unwrap();
        let settled = registry.materialize(&[]).invoke("websearch", parse_json(r#"{"query":"effect typescript","numResults":3,"livecrawl":"preferred","type":"fast","contextMaxCharacters":2500}"#).unwrap(), fixture.context()).await.unwrap();
        assert_eq!(
            settled.result,
            ycoding_ai::llm::ToolResultValue::Text(JsonValue::String("search results".into()))
        );
        assert!(!format!("{settled:?}").contains("synthetic"));
    }
    server.join().unwrap();
    let requests = requests.lock().unwrap();
    assert!(requests[0].starts_with("POST /mcp?exaApiKey=synthetic+exa "));
    assert!(
        requests[1]
            .to_ascii_lowercase()
            .contains("authorization: bearer synthetic-parallel")
    );
    let first = parse_json(requests[0].split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(first, parse_json(r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"web_search_exa","arguments":{"query":"effect typescript","type":"fast","numResults":3,"livecrawl":"preferred","contextMaxCharacters":2500}}}"#).unwrap());
    let second = parse_json(requests[1].split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(second, parse_json(r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"web_search","arguments":{"objective":"effect typescript","search_queries":["effect typescript"],"session_id":"ses_tool"}}}"#).unwrap());
    fixture.cleanup();
}
