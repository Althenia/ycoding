use std::sync::Arc;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
};
use ycoding_ai::route::Executor;
use ycoding_core::{
    resources::{
        agent,
        catalog::{Catalog, models_dev},
        credential, model,
    },
    session::{pending, store::Service, title},
    tools::{
        code_mode::Cancellation,
        policy::helper::{self, Models, TitleMode},
    },
};
use ycoding_schema::{
    DomainDecode, JsonValue, ObjectEncoder, parse_json, session, session_message, session_pending,
    stringify_json,
};

#[path = "session_support/mod.rs"]
mod support;

const PROMPT: &str = "Fix failing build";

struct World {
    store: ycoding_store::Store,
    sessions: Service,
    title: title::Service,
    requests: mpsc::UnboundedReceiver<JsonValue>,
    server: tokio::task::JoinHandle<()>,
}

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
            while request.len() - boundary < length {
                let read = stream.read(&mut buffer).await.unwrap();
                assert!(read > 0);
                request.extend_from_slice(&buffer[..read]);
            }
            let body =
                parse_json(std::str::from_utf8(&request[boundary..boundary + length]).unwrap())
                    .unwrap();
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

fn stream(text: &str, finish: &str) -> (u16, String) {
    (
        200,
        format!(
            "data: {{\"id\":\"reply\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":{}}},\"finish_reason\":null}}]}}\n\ndata: {{\"id\":\"reply\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"{finish}\"}}],\"usage\":{{\"prompt_tokens\":3,\"completion_tokens\":2}}}}\n\ndata: [DONE]\n\n",
            stringify_json(&JsonValue::String(text.into()))
        ),
    )
}

fn text(text: &str) -> (u16, String) {
    stream(text, "stop")
}

fn rejected() -> (u16, String) {
    (
        400,
        r#"{"error":{"message":"rejected","type":"invalid_request_error"}}"#.into(),
    )
}

async fn world(reply: (u16, String)) -> World {
    let store = support::store();
    let sessions = Service::new(store.client());
    let (endpoint, requests, server) = scripted(vec![reply]).await;
    let source =
        include_str!("../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json");
    let mut catalog = Catalog::new(models_dev::normalize(&parse_json(source).unwrap()).unwrap());
    catalog
        .configure(&[parse_json(&format!(
            r#"{{"model":{{"providerID":"openai","model":"gpt-reasoning"}},"providers":{{"openai":{{"package":"@ycoding-ai/ai/providers/openai-compatible","settings":{{"apiKey":"fixture","baseURL":"{endpoint}"}}}}}}}}"#
        ))
        .unwrap()])
        .unwrap();
    let mut title_agent = agent::empty("title".into());
    title_agent.hidden = true;
    title_agent.system = Some("Generate one title".into());
    let models = Arc::new(Models {
        models: Arc::new(model::Resolver::new(catalog)),
        credentials: credential::Service::new(store.client()),
        auth: Default::default(),
        cursor: None,
        claude: None,
        store: sessions.clone(),
        settings: helper::Settings {
            title_mode: TitleMode::Model,
            ..Default::default()
        },
    });
    let title = title::Service::new(
        sessions.clone(),
        Arc::new(agent::Service::new(vec![title_agent])),
        models,
        Arc::new(Executor::new(Executor::http_client().unwrap())),
    );
    sessions
        .admit_input(pending::Request {
            id: session_message::Id::new("msg_first").unwrap(),
            session_id: session::Id::new("ses_one").unwrap(),
            input: session_pending::Message::decode(
                &ObjectEncoder::new()
                    .field("type", "user")
                    .field("data", &ObjectEncoder::new().field("text", PROMPT).finish())
                    .field("delivery", "steer")
                    .finish(),
            )
            .unwrap(),
            event_id: ycoding_schema::event::Id::new("evt_first").unwrap(),
            created: 1,
        })
        .await
        .unwrap();
    sessions
        .promote_steers(&session::Id::new("ses_one").unwrap(), 2)
        .await
        .unwrap();
    World {
        store,
        sessions,
        title,
        requests,
        server,
    }
}

impl World {
    async fn generate(&mut self) -> String {
        let id = session::Id::new("ses_one").unwrap();
        let info = self.sessions.get(&id).unwrap().unwrap();
        self.title
            .generate_for_first_prompt(&info, &Cancellation::default())
            .await
            .unwrap();
        self.requests.recv().await.unwrap();
        self.requests.try_recv().unwrap_err();
        let titles = self.sessions.get(&id).unwrap().unwrap().title;
        let requests = ycoding_store::resources::requests(
            &self.store.snapshot().unwrap(),
            &"ses_one".into(),
            ycoding_store::IndexOrder::Ascending,
            None,
            100,
        )
        .unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].record.source.as_str(), Some("title"));
        titles.as_str().unwrap().to_string()
    }

    async fn finish(self) {
        self.server.await.unwrap();
    }
}

#[tokio::test]
async fn an_obvious_refusal_first_line_is_replaced_by_the_first_prompt_title() {
    for refusal in [
        "I can't help with that request.",
        "I cannot assist with that.",
        "I\u{2019}m sorry, but I can\u{2019}t help.",
        "Sorry, that is not something I can do",
        "As an AI language model, I cannot answer.",
        "\"I won\u{2019}t do that\"",
        "Unfortunately, I am unable to help.",
        "We decline to answer.",
    ] {
        let mut world = world(text(refusal)).await;
        assert_eq!(world.generate().await, PROMPT, "{refusal}");
        world.finish().await;
    }
}

#[tokio::test]
async fn a_content_filter_finish_is_replaced_by_the_first_prompt_title_even_with_text() {
    let mut world = world(stream("Filtered Title", "content_filter")).await;
    assert_eq!(world.generate().await, PROMPT);
    world.finish().await;
}

#[tokio::test]
async fn a_provider_failure_is_replaced_by_the_first_prompt_title() {
    let mut world = world(rejected()).await;
    assert_eq!(world.generate().await, PROMPT);
    world.finish().await;
}

#[tokio::test]
async fn non_refusing_output_keeps_the_first_nonempty_line_as_the_title() {
    for (reply, expected) in [
        ("  Generated Title\nIgnored line", "Generated Title"),
        ("Generated Title\nI can't help with that", "Generated Title"),
        ("Cannot resolve imports", "Cannot resolve imports"),
        ("Refusal handler fix", "Refusal handler fix"),
        ("Implement cache", "Implement cache"),
    ] {
        let mut world = world(text(reply)).await;
        assert_eq!(world.generate().await, expected, "{reply}");
        world.finish().await;
    }
}
