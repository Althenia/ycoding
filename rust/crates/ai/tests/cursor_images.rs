use bytes::Bytes;
use http::Response;
use std::{
    future::Future,
    path::Path,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::net::TcpListener;
use ycoding_ai::{
    Error,
    auth::{Auth, Credential},
    cursor::{
        framing, headers,
        images::{
            self, ApprovedWrite, Environment, Host, PathObservation, Permission,
            PermissionDecision, ResolvedImage,
        },
        models, protobuf, provider, transport,
    },
    llm::{
        FinishReason, Media, MediaData, Message, Part, Request, Role, ToolResult, ToolResultValue,
    },
    provider_error::Reason,
    route::Executor,
};
use ycoding_schema::llm::{ToolContent, ToolFileContent};

struct Resolver {
    calls: Mutex<Vec<(String, usize)>>,
    fail: bool,
}
impl Host for Resolver {
    fn resolve_image<'a>(
        &'a self,
        source: &'a str,
        limit: usize,
    ) -> Pin<Box<dyn Future<Output = Result<ResolvedImage, Error>> + Send + 'a>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push((source.into(), limit));
            if self.fail {
                return Err(Error::invalid("fixture URI denied"));
            }
            Ok(ResolvedImage {
                data: vec![255, 216, 255],
                mime: Some("image/jpeg".into()),
                filename: Some("remote.jpg".into()),
            })
        })
    }
    fn observe_path<'a>(
        &'a self,
        _target: &'a Path,
        _environment: &'a Environment,
    ) -> Pin<Box<dyn Future<Output = Result<PathObservation, Error>> + Send + 'a>> {
        Box::pin(async { Err(Error::invalid("no write in URI fixture")) })
    }
    fn permission<'a>(
        &'a self,
        _request: &'a Permission,
    ) -> Pin<Box<dyn Future<Output = Result<PermissionDecision, Error>> + Send + 'a>> {
        Box::pin(async { Err(Error::invalid("no permission in URI fixture")) })
    }
    fn write_image<'a>(
        &'a self,
        _approved: ApprovedWrite,
    ) -> Pin<Box<dyn Future<Output = Result<(), Error>> + Send + 'a>> {
        Box::pin(async { Err(Error::invalid("no write in URI fixture")) })
    }
}

#[derive(Debug, PartialEq)]
struct ReceivedImage {
    data: Vec<u8>,
    mime: String,
    filename: String,
}

async fn image_runs(
    inputs: Vec<Vec<Message>>,
    host: Option<Arc<dyn Host>>,
) -> Vec<Vec<ReceivedImage>> {
    tokio::time::timeout(Duration::from_secs(10), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let count = inputs.len();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut connection = h2::server::handshake(socket).await.unwrap();
            let mut workers = tokio::task::JoinSet::new();
            for index in 0..count {
                let (request, mut response) = connection.accept().await.unwrap().unwrap();
                workers.spawn(async move {
                    let mut body = request.into_body();
                    let mut decoder = framing::Decoder::default();
                    let initial = loop {
                        let chunk = body.data().await.unwrap().unwrap();
                        body.flow_control().release_capacity(chunk.len()).unwrap();
                        if let Some(frame) = decoder.push(&chunk).pop() { break frame.payload; }
                    };
                    let outer = protobuf::fields(&initial).unwrap();
                    let run = protobuf::fields(outer[0].bytes().unwrap()).unwrap();
                    let action = protobuf::fields(run.iter().find(|field| field.number == 2).unwrap().bytes().unwrap()).unwrap();
                    assert_eq!(action[0].number, 1);
                    let user = protobuf::fields(action[0].bytes().unwrap()).unwrap();
                    let message = protobuf::fields(user[0].bytes().unwrap()).unwrap();
                    let images = message.iter().find(|field| field.number == 3).map(|field| protobuf::fields(field.bytes().unwrap()).unwrap()).unwrap_or_default().into_iter().map(|field| {
                        let fields = protobuf::fields(field.bytes().unwrap()).unwrap();
                        ReceivedImage {
                            data: fields.iter().find(|field| field.number == 8).unwrap().bytes().unwrap().to_vec(),
                            mime: fields.iter().find(|field| field.number == 7).unwrap().text().unwrap(),
                            filename: fields.iter().find(|field| field.number == 3).unwrap().text().unwrap(),
                        }
                    }).collect::<Vec<_>>();
                    let mut send = response.send_response(Response::builder().status(200).body(()).unwrap(), false).unwrap();
                    send.send_data(Bytes::from(framing::encode(0, &[10, 2, 114, 0]).unwrap()), false).unwrap();
                    while let Some(chunk) = body.data().await { match chunk { Ok(chunk) => body.flow_control().release_capacity(chunk.len()).unwrap(), Err(error) => { assert_eq!(error.reason(), Some(h2::Reason::CANCEL)); break; } } }
                    (index, images)
                });
            }
            let mut results = Vec::new();
            while !workers.is_empty() {
                tokio::select! { result = workers.join_next() => results.push(result.unwrap().unwrap()), next = connection.accept() => { assert!(next.is_none()); } }
            }
            results.sort_by_key(|(index, _)| *index);
            results.into_iter().map(|(_, images)| images).collect()
        });
        let mut config = config(address, true);
        let runtime = config.runtime.clone();
        config.image_host = host;
        let mut request = Request::new(provider::model("image-fixture", config).unwrap());
        request.http.headers.insert("x-session-id".into(), "ses-fixture".into());
        let executor = Executor::new(Executor::http_client().unwrap());
        for messages in inputs {
            request.messages = messages;
            assert_eq!(executor.generate(&request).await.unwrap().finish_reason, FinishReason::Stop);
        }
        let received = server.await.unwrap();
        runtime.shutdown().await;
        received
    }).await.unwrap()
}

#[tokio::test]
async fn cursor_url_and_file_images_use_the_owned_resolver_with_remaining_budget() {
    let resolver = Arc::new(Resolver {
        calls: Mutex::new(Vec::new()),
        fail: false,
    });
    let inputs = vec![Message::new(
        Role::User,
        vec![
            image(
                "image/*",
                MediaData::Encoded("https://example.invalid/image.jpg".into()),
                None,
            ),
            image(
                "image/png",
                MediaData::Encoded("file:///fixture/image.png".into()),
                Some("../chosen.png"),
            ),
        ],
    )];
    assert_eq!(
        image_runs(vec![inputs], Some(resolver.clone())).await,
        [vec![
            ReceivedImage {
                data: vec![255, 216, 255],
                mime: "image/jpeg".into(),
                filename: "remote.jpg".into()
            },
            ReceivedImage {
                data: vec![255, 216, 255],
                mime: "image/png".into(),
                filename: "chosen.png".into()
            }
        ]]
    );
    assert_eq!(
        resolver.calls.lock().unwrap().as_slice(),
        [
            (
                "https://example.invalid/image.jpg".into(),
                images::MAX_INPUT_BYTES
            ),
            (
                "file:///fixture/image.png".into(),
                images::MAX_INPUT_BYTES - 3
            )
        ]
    );
    let mut config = config("127.0.0.1:1".parse().unwrap(), true);
    let resolver = Arc::new(Resolver {
        calls: Mutex::new(Vec::new()),
        fail: true,
    });
    config.image_host = Some(resolver.clone());
    let mut request = Request::new(provider::model("image-fixture", config).unwrap());
    request.messages.push(Message::new(
        Role::User,
        vec![image(
            "image/png",
            MediaData::Encoded("file:///fixture/private.png".into()),
            None,
        )],
    ));
    let error = Executor::new(Executor::http_client().unwrap())
        .generate(&request)
        .await
        .unwrap_err();
    assert_eq!(error.reason, Reason::InvalidRequest);
    assert_eq!(error.message, "fixture URI denied");
    assert_eq!(resolver.calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn cursor_history_dedupes_user_assistant_and_tool_images_but_keeps_current_user_repeats() {
    let old = Message::new(
        Role::User,
        vec![image("image/png", MediaData::Bytes(vec![1, 2, 3]), None)],
    );
    let assistant = Message::new(
        Role::Assistant,
        vec![
            image("image/png", MediaData::Encoded("AQID".into()), None),
            image("image/png", MediaData::Bytes(vec![4, 5, 6]), None),
        ],
    );
    let tool = Message::new(
        Role::Tool,
        vec![Part::ToolResult(ToolResult {
            id: "call".into(),
            name: "read".into(),
            result: ToolResultValue::Content(vec![ToolContent::File(ToolFileContent {
                mime: "image/png".into(),
                uri: "data:image/png;base64,BAUG".into(),
                name: None,
            })]),
            cache: None,
            provider_executed: None,
            provider_metadata: None,
            output: None,
        })],
    );
    let current = Message::new(
        Role::User,
        vec![
            image("image/png", MediaData::Bytes(vec![7, 8, 9]), None),
            image("image/png", MediaData::Bytes(vec![7, 8, 9]), None),
        ],
    );
    let first = vec![
        old.clone(),
        assistant.clone(),
        tool.clone(),
        current.clone(),
    ];
    let second = vec![old, assistant, tool, current];
    let received = image_runs(vec![first, second], None).await;
    assert_eq!(
        received[0]
            .iter()
            .map(|image| image.data.as_slice())
            .collect::<Vec<_>>(),
        [vec![7, 8, 9], vec![7, 8, 9], vec![1, 2, 3], vec![4, 5, 6]]
    );
    assert_eq!(
        received[1]
            .iter()
            .map(|image| image.data.as_slice())
            .collect::<Vec<_>>(),
        [vec![7, 8, 9], vec![7, 8, 9]]
    );
}

#[tokio::test]
async fn cursor_combined_user_and_history_image_budget_checks_unique_bytes_only() {
    let big = vec![1; images::MAX_INPUT_BYTES];
    let current = Message::new(
        Role::User,
        vec![image("image/png", MediaData::Bytes(big.clone()), None)],
    );
    let duplicate = Message::new(
        Role::Assistant,
        vec![image("image/png", MediaData::Bytes(big), None)],
    );
    let received = image_runs(vec![vec![duplicate, current]], None).await;
    assert_eq!(received[0].len(), 1);
    assert_eq!(received[0][0].data.len(), images::MAX_INPUT_BYTES);
    for history in [false, true] {
        let mut request = Request::new(
            provider::model(
                "image-fixture",
                config("127.0.0.1:1".parse().unwrap(), true),
            )
            .unwrap(),
        );
        let large = image(
            "image/png",
            MediaData::Bytes(vec![1; images::MAX_INPUT_BYTES]),
            None,
        );
        let small = image("image/png", MediaData::Bytes(vec![2]), None);
        request.messages = if history {
            vec![
                Message::new(Role::Assistant, vec![small]),
                Message::new(Role::User, vec![large]),
            ]
        } else {
            vec![Message::new(Role::User, vec![large, small])]
        };
        assert_eq!(
            Executor::new(Executor::http_client().unwrap())
                .generate(&request)
                .await
                .unwrap_err()
                .reason,
            Reason::InvalidRequest
        );
    }
}

fn config(address: std::net::SocketAddr, supports_images: bool) -> provider::Config {
    let runtime = Arc::new(provider::Runtime::new(Default::default()).unwrap());
    let mut config = provider::Config::new(
        Auth::bearer(Credential::value("fixture-token")),
        headers::Identity {
            machine_id: "machine".into(),
            mac_machine_id: None,
            client_version: "cli-fixture".into(),
        },
        provider::RequestContext::new(vec![34, 0]).unwrap(),
        runtime,
    );
    config.agent = Some(transport::Endpoint::loopback(address).unwrap());
    config.models = models::available_models(
        &ycoding_schema::parse_json(&format!(
            r#"{{"models":[{{"name":"image-fixture","supportsImages":{supports_images}}}]}}"#
        ))
        .unwrap(),
    )
    .unwrap();
    config
}
fn image(mime: &str, data: MediaData, filename: Option<&str>) -> Part {
    Part::Media(Media {
        mime: mime.into(),
        data,
        filename: filename.map(Into::into),
    })
}

#[test]
fn cursor_unsupported_images_and_non_image_files_fail_before_provider_io() {
    for (supports, mime) in [(false, "image/png"), (true, "text/plain")] {
        let mut request = Request::new(
            provider::model(
                "image-fixture",
                config("127.0.0.1:1".parse().unwrap(), supports),
            )
            .unwrap(),
        );
        request.messages.push(Message::new(
            ycoding_ai::llm::Role::User,
            vec![image(mime, MediaData::Bytes(vec![1]), None)],
        ));
        let error = request
            .model
            .route
            .prepare(&request)
            .expect_err("unsupported attachments must not be dropped");
        assert_eq!(error.reason, Reason::InvalidRequest);
    }
}

#[tokio::test]
async fn cursor_user_images_preserve_selected_wire_bytes_mime_and_basename() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut connection = h2::server::handshake(socket).await.unwrap();
            let (request, mut response) = connection.accept().await.unwrap().unwrap();
            let mut body = request.into_body();
            let exchange = async move {
                let mut decoder = framing::Decoder::default();
                let initial = loop {
                    let chunk = body.data().await.unwrap().unwrap();
                    body.flow_control().release_capacity(chunk.len()).unwrap();
                    if let Some(frame) = decoder.push(&chunk).pop() { break frame.payload; }
                };
                let outer = protobuf::fields(&initial).unwrap();
                let run = protobuf::fields(outer[0].bytes().unwrap()).unwrap();
                let action = protobuf::fields(run.iter().find(|field| field.number == 2).unwrap().bytes().unwrap()).unwrap();
                let user = protobuf::fields(action[0].bytes().unwrap()).unwrap();
                let message = protobuf::fields(user[0].bytes().unwrap()).unwrap();
                let selected = protobuf::fields(message.iter().find(|field| field.number == 3).expect("images were dropped").bytes().unwrap()).unwrap();
                assert_eq!(selected.len(), 2);
                for (image, expected, mime, filename) in [(&selected[0], vec![0, 1, 255], "image/png", "shot.png"), (&selected[1], vec![137, 80, 78, 71, 13, 10, 26, 10], "image/png", "image-2")] {
                    let fields = protobuf::fields(image.bytes().unwrap()).unwrap();
                    assert_eq!(fields.iter().find(|field| field.number == 2).unwrap().text().unwrap().len(), 36);
                    assert_eq!(fields.iter().find(|field| field.number == 3).unwrap().text().unwrap(), filename);
                    assert_eq!(fields.iter().find(|field| field.number == 7).unwrap().text().unwrap(), mime);
                    assert_eq!(fields.iter().find(|field| field.number == 8).unwrap().bytes().unwrap(), expected);
                }
                let mut send = response.send_response(Response::builder().status(200).body(()).unwrap(), false).unwrap();
                send.send_data(Bytes::from(framing::encode(0, &[10, 2, 114, 0]).unwrap()), false).unwrap();
                while let Some(chunk) = body.data().await {
                    match chunk { Ok(chunk) => body.flow_control().release_capacity(chunk.len()).unwrap(), Err(error) => { assert_eq!(error.reason(), Some(h2::Reason::CANCEL)); break; } }
                }
            };
            tokio::pin!(exchange);
            tokio::select! { () = &mut exchange => {}, next = connection.accept() => { assert!(next.is_none()); exchange.await; } }
        });
        let config = config(address, true);
        let runtime = config.runtime.clone();
        let mut request = Request::new(provider::model("image-fixture", config).unwrap());
        let mut user = Message::user("Look");
        user.content.push(image("image/png", MediaData::Bytes(vec![0, 1, 255]), Some("../shot.png")));
        user.content.push(image("image/*", MediaData::Encoded("data:;base64,iVBORw0KGgo".into()), None));
        request.messages.push(user);
        assert_eq!(Executor::new(Executor::http_client().unwrap()).generate(&request).await.unwrap().finish_reason, FinishReason::Stop);
        server.await.unwrap();
        runtime.shutdown().await;
    }).await.unwrap();
}

#[tokio::test]
async fn cursor_same_text_after_checkpoint_is_a_fresh_user_action_with_new_image_bytes() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut connection = h2::server::handshake(socket).await.unwrap();
            let (request, mut response) = connection.accept().await.unwrap().unwrap();
            let mut body = request.into_body();
            let exchange = async move {
                let mut decoder = framing::Decoder::default();
                let initial = loop {
                    let chunk = body.data().await.unwrap().unwrap();
                    body.flow_control().release_capacity(chunk.len()).unwrap();
                    if let Some(frame) = decoder.push(&chunk).pop() { break frame.payload; }
                };
                let outer = protobuf::fields(&initial).unwrap();
                let run = protobuf::fields(outer[0].bytes().unwrap()).unwrap();
                let action = protobuf::fields(run.iter().find(|field| field.number == 2).unwrap().bytes().unwrap()).unwrap();
                assert_eq!(action[0].number, 1, "new user input must not become a Resume action");
                let user = protobuf::fields(action[0].bytes().unwrap()).unwrap();
                let message = protobuf::fields(user[0].bytes().unwrap()).unwrap();
                let selected = protobuf::fields(message.iter().find(|field| field.number == 3).unwrap().bytes().unwrap()).unwrap();
                let image = protobuf::fields(selected[0].bytes().unwrap()).unwrap();
                assert_eq!(image.iter().find(|field| field.number == 8).unwrap().bytes().unwrap(), [9, 8, 7]);
                let mut send = response.send_response(Response::builder().status(200).body(()).unwrap(), false).unwrap();
                send.send_data(Bytes::from(framing::encode(0, &[10, 2, 114, 0]).unwrap()), false).unwrap();
                while let Some(chunk) = body.data().await { match chunk { Ok(chunk) => body.flow_control().release_capacity(chunk.len()).unwrap(), Err(error) => { assert_eq!(error.reason(), Some(h2::Reason::CANCEL)); break; } } }
            };
            tokio::pin!(exchange);
            tokio::select! { () = &mut exchange => {}, next = connection.accept() => { assert!(next.is_none()); exchange.await; } }
        });
        let config = config(address, true);
        let runtime = config.runtime.clone();
        let mut snapshot = runtime.snapshot("ses-fixture").await.unwrap();
        snapshot.checkpoint = Some(vec![1, 2, 3]);
        snapshot.last_user = Some("Look".into());
        runtime.restore("ses-fixture", snapshot).await.unwrap();
        let mut request = Request::new(provider::model("image-fixture", config).unwrap());
        request.http.headers.insert("x-session-id".into(), "ses-fixture".into());
        let mut user = Message::user("Look");
        user.content.push(image("image/png", MediaData::Bytes(vec![9, 8, 7]), None));
        request.messages.push(user);
        assert_eq!(Executor::new(Executor::http_client().unwrap()).generate(&request).await.unwrap().finish_reason, FinishReason::Stop);
        server.await.unwrap();
        runtime.shutdown().await;
    }).await.unwrap();
}
