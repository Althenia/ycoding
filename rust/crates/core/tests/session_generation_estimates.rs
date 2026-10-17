use std::sync::Arc;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
};
use ycoding_core::{
    resources::{
        agent, attachment_store,
        catalog::{Catalog, models_dev},
        credential, model,
    },
    session::{
        compaction_policy::{Info, resolve},
        run_coordinator::Coordinator,
        runner::{Local, Services, WallClock},
        skill::Resolver,
        store::Service,
    },
    tools::{policy::helper, registry::Registry},
};
use ycoding_schema::{
    DomainDecode, JsonValue, parse_json, session, session_message, session_pending,
};
use ycoding_store::session::{ContextState, ContextStateTable, Revision, RevisionTable};

#[path = "session_support/guardrails.rs"]
mod guardrails;
#[path = "session_support/mod.rs"]
mod support;

async fn scripted(
    replies: Vec<(u16, String)>,
) -> (
    String,
    mpsc::UnboundedReceiver<JsonValue>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let (send, receive) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        for (status, reply) in replies {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 4096];
            let boundary = loop {
                let read = stream.read(&mut buffer).await.unwrap();
                assert!(read > 0);
                request.extend_from_slice(&buffer[..read]);
                if let Some(boundary) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                    break boundary + 4;
                }
            };
            let header = std::str::from_utf8(&request[..boundary]).unwrap();
            let length = header
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|value| value.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            let authorization = header
                .lines()
                .find_map(|line| {
                    line.split_once(':')
                        .filter(|(key, _)| key.eq_ignore_ascii_case("authorization"))
                        .map(|(_, value)| value.trim().to_string())
                })
                .unwrap_or_default();
            while request.len() - boundary < length {
                let read = stream.read(&mut buffer).await.unwrap();
                assert!(read > 0);
                request.extend_from_slice(&buffer[..read]);
            }
            let mut body =
                parse_json(std::str::from_utf8(&request[boundary..boundary + length]).unwrap())
                    .unwrap();
            if let JsonValue::Object(body) = &mut body {
                body.insert(
                    "_testAuthorization".into(),
                    JsonValue::String(authorization.as_str().into()),
                );
            }
            send.send(body).unwrap();
            let kind = if status == 200 {
                "text/event-stream"
            } else {
                "application/json"
            };
            let response = format!(
                "HTTP/1.1 {status} Response\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });
    (address, receive, task)
}

async fn within<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(std::time::Duration::from_secs(30), future)
        .await
        .expect("operation did not finish within 30 seconds")
}

fn services(
    store: &ycoding_store::Store,
    endpoint: &str,
    helpers: helper::Settings,
    skill_resolver: Option<Arc<dyn Resolver>>,
) -> Services {
    let models =
        include_str!("../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json")
            .replacen("\"context\": 128000", "\"context\": 6000", 1)
            .replacen(
                "\"models\": {\n      \"gpt-reasoning\": {",
                "\"models\": {\n      \"gpt-tiny\": {\"id\":\"gpt-tiny\",\"name\":\"GPT Tiny\",\"release_date\":\"2026-01-01\",\"attachment\":false,\"reasoning\":false,\"temperature\":true,\"tool_call\":true,\"limit\":{\"context\":900,\"output\":100}},\n      \"gpt-helper\": {\"id\":\"gpt-helper\",\"name\":\"GPT Helper\",\"release_date\":\"2026-01-01\",\"attachment\":false,\"reasoning\":false,\"temperature\":true,\"tool_call\":true,\"limit\":{\"context\":20000,\"output\":2000}},\n      \"gpt-reasoning\": {",
                1,
            );
    let mut catalog = Catalog::new(models_dev::normalize(&parse_json(&models).unwrap()).unwrap());
    catalog.configure(&[parse_json(&format!(r#"{{"model":{{"providerID":"openai","model":"gpt-reasoning"}},"providers":{{"openai":{{"package":"@ycoding-ai/ai/providers/openai-compatible","settings":{{"apiKey":"fixture","baseURL":"{endpoint}"}}}}}}}}"#)).unwrap()]).unwrap();
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
            Arc::new(ycoding_core::resources::tool_output_store::Store::new(
                &ycoding_core::resources::config::Roots::development(
                    &std::env::temp_dir().join("ycoding-compaction-output"),
                )
                .unwrap(),
            )),
            None,
            Default::default(),
            Arc::new(|left, right| left.cmp(right)),
        )),
        attachments: Arc::new(
            attachment_store::Store::new(
                std::env::temp_dir().join("ycoding-compaction-attachments"),
            )
            .unwrap(),
        ),
        instructions: Vec::new(),
        analysis: None,
        clock: Arc::new(WallClock),
        executor: Arc::new(ycoding_ai::route::Executor::new(
            ycoding_ai::route::Executor::http_client().unwrap(),
        )),
        compaction: resolve(&[Info {
            context_safety_margin_tokens: Some(1_000),
            ..Info::default()
        }]),
        guardrails: guardrails::guardrails(store),
        helpers,
        cursor: None,
        skill_resolver,
        configuration: None,
        image_analyzer: None,
        extensions: Vec::new(),
        session_tools: None,
        claude: None,
        auth: None,
    }
}

fn seed_context(store: &ycoding_store::Store) {
    store
        .submit(|tx| {
            RevisionTable::insert(
                tx,
                &Revision {
                    session_id: "ses_one".into(),
                    revision: 0,
                    parent_revision: None,
                    manifest_digest: None,
                    covered_through_message_id: None,
                    covered_through_seq: None,
                    activation_event_id: None,
                    activation_sequence: None,
                    time_created: 0,
                },
            )?;
            ContextStateTable::insert(
                tx,
                &ContextState {
                    session_id: "ses_one".into(),
                    status: "active".into(),
                    revision: 0,
                    manifest_digest: None,
                    covered_through_message_id: None,
                    covered_through_seq: None,
                    activated_event_id: None,
                    time_activated: None,
                    error_code: None,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn local(store: &ycoding_store::Store, endpoint: &str, tools: Arc<Registry>) -> Local {
    Local::new(Services {
        tools,
        ..services(store, endpoint, Default::default(), None)
    })
}

fn registry() -> Arc<Registry> {
    Arc::new(Registry::new(
        Arc::new(ycoding_core::resources::tool_output_store::Store::new(
            &ycoding_core::resources::config::Roots::development(
                &std::env::temp_dir().join("ycoding-estimates-output"),
            )
            .unwrap(),
        )),
        None,
        Default::default(),
        Arc::new(|left, right| left.cmp(right)),
    ))
}

fn stream(deltas: &[&str], usage: Option<&str>) -> String {
    let mut events = deltas
        .iter()
        .map(|delta| {
            format!(
                "data: {{\"id\":\"reply\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":{}}},\"finish_reason\":null}}]}}\n\n",
                ycoding_schema::stringify_json(&JsonValue::String((*delta).into()))
            )
        })
        .collect::<String>();
    events.push_str(&format!(
        "data: {{\"id\":\"reply\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}]{}}}\n\ndata: [DONE]\n\n",
        usage.map_or_else(String::new, |usage| format!(",\"usage\":{usage}"))
    ));
    events
}

fn tool_stream(arguments: &[&str]) -> String {
    let mut events = arguments
        .iter()
        .enumerate()
        .map(|(index, chunk)| {
            let function = if index == 0 {
                serde_json::json!({"name": "estimate_tool", "arguments": chunk})
            } else {
                serde_json::json!({"arguments": chunk})
            };
            let call = if index == 0 {
                serde_json::json!({"index": 0, "id": "call_estimate", "type": "function", "function": function})
            } else {
                serde_json::json!({"index": 0, "function": function})
            };
            let event = serde_json::json!({"id": "tool", "choices": [{"index": 0, "delta": {"tool_calls": [call]}, "finish_reason": null}]});
            format!("data: {event}\n\n")
        })
        .collect::<String>();
    let finish = serde_json::json!({"id": "tool", "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]});
    events.push_str(&format!("data: {finish}\n\ndata: [DONE]\n\n"));
    events
}

async fn run(
    replies: Vec<String>,
) -> (ycoding_store::Store, Vec<ycoding_store::resources::Request>) {
    let (store, rows, outcome) = run_outcome(replies).await;
    outcome.unwrap();
    (store, rows)
}

async fn run_outcome(
    replies: Vec<String>,
) -> (
    ycoding_store::Store,
    Vec<ycoding_store::resources::Request>,
    Result<(), String>,
) {
    let store = support::store();
    let service = Service::new(store.client());
    seed_context(&store);
    service
        .admit(ycoding_core::session::pending::Request {
            id: session_message::Id::new("msg_input").unwrap(),
            session_id: session::Id::new("ses_one").unwrap(),
            input: session_pending::Message::decode(
                &parse_json(
                    r#"{"type":"user","data":{"text":"Answer the prompt"},"delivery":"steer"}"#,
                )
                .unwrap(),
            )
            .unwrap(),
            event_id: ycoding_schema::event::Id::new("evt_input").unwrap(),
            created: 1,
        })
        .await
        .unwrap();
    let count = replies.len();
    let (endpoint, mut requests, server) =
        scripted(replies.into_iter().map(|reply| (200, reply)).collect()).await;
    let tools = registry();
    let _registration = tools
        .register(
            vec![(
                "estimate_tool".into(),
                Arc::new(ycoding_core::tools::registry::DynamicTool::new(
                    "Echo input",
                    parse_json(r#"{"type":"object"}"#).unwrap(),
                    None,
                    None,
                    |input, _| {
                        Box::pin(async move {
                            Ok(ycoding_core::ycoding_ai::llm::ToolOutput {
                                structured: input,
                                content: Vec::new(),
                            })
                        })
                    },
                )),
            )],
            ycoding_core::tools::registry::Options::direct(),
        )
        .unwrap();
    let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, tools)));
    let outcome = within(coordinator.run(&session::Id::new("ses_one").unwrap()))
        .await
        .map(|_| ())
        .map_err(|error| format!("{error:?}"));
    within(server).await.unwrap();
    coordinator.shutdown().await.unwrap();
    for _ in 0..count {
        requests.recv().await.unwrap();
    }
    let rows = ycoding_store::resources::requests(
        &store.snapshot().unwrap(),
        &"ses_one".into(),
        ycoding_store::IndexOrder::Ascending,
        None,
        100,
    )
    .unwrap()
    .into_iter()
    .map(|entry| entry.record)
    .collect();
    (store, rows, outcome)
}

fn timing(row: &ycoding_store::resources::Request) -> JsonValue {
    row.timing
        .as_ref()
        .map(|timing| timing.value().clone())
        .unwrap_or_else(|| parse_json("{}").unwrap())
}

fn number(value: &JsonValue, key: &str) -> Option<f64> {
    match value {
        JsonValue::Object(object) => match object.get(&key.into()) {
            Some(JsonValue::Number(number)) => Some(*number),
            _ => None,
        },
        _ => None,
    }
}

fn zero_tokens(row: &ycoding_store::resources::Request) -> bool {
    row.tokens.value()
        == &parse_json(r#"{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}"#)
            .unwrap()
}

fn assert_estimated_only(row: &ycoding_store::resources::Request, tokens: f64) {
    let timing = timing(row);
    assert_eq!(number(&timing, "estimatedTokens"), Some(tokens));
    assert!(number(&timing, "estimatedGenerationDurationNs").is_some_and(|ns| ns >= 1.0));
    assert_eq!(number(&timing, "generatedTokens"), None);
    assert_eq!(number(&timing, "observedGenerationDurationNs"), None);
    assert!(zero_tokens(row));
    assert_eq!(row.cost.unwrap_or(0.0), 0.0);
}

fn aggregates_stay_zero(store: &ycoding_store::Store) {
    let snapshot = store.snapshot().unwrap();
    let session = snapshot
        .get::<ycoding_store::session::SessionTable>(&ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(&"ses_one".into()),
        ]))
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            session.tokens_input,
            session.tokens_output,
            session.tokens_reasoning,
            session.tokens_cache_read,
            session.tokens_cache_write
        ),
        (0, 0, 0, 0, 0)
    );
    assert_eq!(session.cost, 0.0);
}

#[tokio::test]
async fn provider_reported_tokens_keep_a_sub_second_observed_window_and_no_estimate() {
    let usage = r#"{"prompt_tokens":3,"completion_tokens":12}"#;
    let (_, rows) = run(vec![stream(&["Answer"], Some(usage))]).await;
    let timing = timing(&rows[0]);
    assert_eq!(number(&timing, "generatedTokens"), Some(12.0));
    assert!(
        number(&timing, "observedGenerationDurationNs")
            .is_some_and(|ns| (1.0..1_000_000_000.0).contains(&ns)),
        "{timing:?}"
    );
    assert_eq!(number(&timing, "estimatedTokens"), None);
    assert_eq!(number(&timing, "estimatedGenerationDurationNs"), None);
}

#[tokio::test]
async fn reported_reasoning_is_counted_with_the_visible_output() {
    let usage = r#"{"prompt_tokens":3,"completion_tokens":12,"completion_tokens_details":{"reasoning_tokens":4}}"#;
    let (_, rows) = run(vec![stream(&["Answer"], Some(usage))]).await;
    let timing = timing(&rows[0]);
    assert_eq!(number(&timing, "generatedTokens"), Some(12.0));
    assert!(number(&timing, "observedGenerationDurationNs").is_some_and(|ns| ns >= 1.0));
    assert_eq!(number(&timing, "estimatedTokens"), None);
}

#[tokio::test]
async fn streamed_text_without_provider_usage_is_estimated_and_never_becomes_actual_usage() {
    let (store, rows) = run(vec![stream(&["hello ", "world"], None)]).await;
    assert_estimated_only(&rows[0], 3.0);
    aggregates_stay_zero(&store);
}

#[tokio::test]
async fn whitespace_only_deltas_count_toward_the_estimate_and_start_the_window() {
    let (_, rows) = run(vec![stream(&["        ", "ab"], None)]).await;
    assert_estimated_only(&rows[0], 3.0);
}

#[tokio::test]
async fn estimates_count_utf16_code_units() {
    let (_, rows) = run(vec![stream(
        &["\u{1F600}\u{1F600}\u{1F600}\u{1F600}"],
        None,
    )])
    .await;
    assert_estimated_only(&rows[0], 2.0);
}

#[tokio::test]
async fn streamed_tool_input_without_provider_usage_is_estimated() {
    let (_, rows) = run(vec![
        tool_stream(&["{\"path\":", "\"a.ts\"}"]),
        stream(
            &["done"],
            Some(r#"{"prompt_tokens":3,"completion_tokens":2}"#),
        ),
    ])
    .await;
    assert_estimated_only(&rows[0], 4.0);
    let second = timing(&rows[1]);
    assert_eq!(number(&second, "estimatedTokens"), None);
    assert_eq!(number(&second, "generatedTokens"), Some(2.0));
}

#[tokio::test]
async fn a_stream_without_usage_or_output_records_no_generation_timing() {
    let (_, rows) = run(vec![stream(&[], None), stream(&["recovered"], None)]).await;
    assert_eq!(rows.len(), 2);
    let timing = timing(&rows[0]);
    for key in [
        "generatedTokens",
        "observedGenerationDurationNs",
        "estimatedTokens",
        "estimatedGenerationDurationNs",
    ] {
        assert_eq!(number(&timing, key), None, "{key}");
    }
}

#[tokio::test]
async fn a_stream_that_fails_after_output_without_a_terminal_event_still_records_its_estimate() {
    let chunk = serde_json::json!({"id": "reply", "choices": [{"index": 0, "delta": {"content": "hello world"}, "finish_reason": null}]});
    let (_, rows, outcome) = run_outcome(vec![format!(
        "data: {chunk}\n\ndata: {{\"id\":\"reply\",\"choices\":\"broken\"}}\n\n"
    )])
    .await;
    assert!(
        outcome.unwrap_err().contains("provider.invalid-output"),
        "the stream must fail before any finish event"
    );
    assert_eq!(rows.len(), 1);
    assert_estimated_only(&rows[0], 3.0);
}
