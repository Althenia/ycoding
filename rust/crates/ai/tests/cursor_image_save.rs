use bytes::Bytes;
use http::Response;
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Mutex,
};
use tokio::net::TcpListener;
use ycoding_ai::{
    Error,
    cursor::images::{
        ApprovedWrite, Environment, Host, PathObservation, Permission, PermissionDecision,
        PermissionKind, ResolvedImage, Stage, StagedImage,
    },
};
use ycoding_ai::{
    auth::{Auth, Credential},
    cursor::{framing, headers, images, protobuf, provider, transport},
    llm::{FinishReason, Message, Part, Request, Role, ToolChoice, ToolResult},
    route::Executor,
    tool,
};

struct TestHost {
    events: Mutex<Vec<&'static str>>,
    denied: Option<PermissionKind>,
    escape: bool,
    sessions: Mutex<Vec<ycoding_schema::LosslessString>>,
}
impl Host for TestHost {
    fn resolve_image<'a>(
        &'a self,
        _source: &'a str,
        _limit: usize,
    ) -> Pin<Box<dyn Future<Output = Result<ResolvedImage, Error>> + Send + 'a>> {
        Box::pin(async { Err(Error::invalid("fixture has no URI image")) })
    }
    fn observe_path<'a>(
        &'a self,
        target: &'a Path,
        environment: &'a Environment,
    ) -> Pin<Box<dyn Future<Output = Result<PathObservation, Error>> + Send + 'a>> {
        Box::pin(async move {
            self.events.lock().unwrap().push("observe");
            Ok(PathObservation {
                target: if self.escape {
                    PathBuf::from("/outside/escape.png")
                } else {
                    target.to_path_buf()
                },
                project_root: environment.project_dir.clone(),
                workspace_root: environment.workspace.clone(),
                directory_root: environment.directory.clone(),
            })
        })
    }
    fn permission<'a>(
        &'a self,
        request: &'a Permission,
    ) -> Pin<Box<dyn Future<Output = Result<PermissionDecision, Error>> + Send + 'a>> {
        Box::pin(async move {
            self.sessions
                .lock()
                .unwrap()
                .push(request.session_id.clone());
            self.events.lock().unwrap().push(match request.kind {
                PermissionKind::ExternalDirectory => "external_directory",
                PermissionKind::Edit => "edit",
            });
            Ok(if self.denied == Some(request.kind) {
                PermissionDecision::Denied("fixture refusal".into())
            } else {
                PermissionDecision::Approved
            })
        })
    }
    fn write_image<'a>(
        &'a self,
        approved: ApprovedWrite,
    ) -> Pin<Box<dyn Future<Output = Result<(), Error>> + Send + 'a>> {
        Box::pin(async move {
            self.events.lock().unwrap().push("write");
            assert_eq!(approved.path(), Path::new("/fixture/project/assets/a.png"));
            assert_eq!(approved.data(), [0, 1, 255]);
            Ok(())
        })
    }
}
fn staged() -> StagedImage {
    StagedImage {
        path: "/fixture/project/assets/a.png".into(),
        environment: Environment {
            project_dir: "/fixture/project".into(),
            workspace: "/fixture/workspace".into(),
            directory: "/fixture/workspace".into(),
        },
        mime: "image/png".into(),
        data: vec![0, 1, 255],
        session_id: "ses-fixture".into(),
    }
}
fn host(denied: Option<PermissionKind>, escape: bool) -> TestHost {
    TestHost {
        events: Mutex::new(Vec::new()),
        denied,
        escape,
        sessions: Mutex::new(Vec::new()),
    }
}

#[tokio::test]
async fn cursor_image_save_checks_containment_then_external_and_edit_before_writing() {
    let store = Stage::new();
    let id = store.stage(staged(), 0).unwrap();
    let host = host(None, false);
    let receipt = store.save(&id, &host, 1).await.unwrap();
    assert_eq!(receipt.bytes, 3);
    assert_eq!(
        host.events.lock().unwrap().as_slice(),
        ["observe", "external_directory", "edit", "write"]
    );
    assert!(store.save(&id, &host, 2).await.is_err());
    assert_eq!(host.events.lock().unwrap().len(), 4);
}

#[tokio::test]
async fn cursor_image_denials_and_symlink_escape_never_reach_the_write_boundary() {
    for denied in [PermissionKind::ExternalDirectory, PermissionKind::Edit] {
        let store = Stage::new();
        let id = store.stage(staged(), 0).unwrap();
        let host = host(Some(denied), false);
        let error = store.save(&id, &host, 1).await.unwrap_err();
        assert!(error.message.starts_with("CursorImagePermissionDenied:"));
        assert!(!host.events.lock().unwrap().contains(&"write"));
    }
    let store = Stage::new();
    let id = store.stage(staged(), 0).unwrap();
    let host = host(None, true);
    assert!(store.save(&id, &host, 1).await.is_err());
    assert_eq!(host.events.lock().unwrap().as_slice(), ["observe"]);
}

#[tokio::test]
async fn cursor_staging_bounds_capacity_size_and_ttl_without_confirming_replayed_handles() {
    let store = Stage::new();
    let oldest = store.stage(staged(), 0).unwrap();
    for _ in 0..8 {
        store.stage(staged(), 0).unwrap();
    }
    let host = host(None, false);
    assert!(store.save(&oldest, &host, 0).await.is_err());
    let id = store.stage(staged(), 0).unwrap();
    assert!(store.save(&id, &host, 600_001).await.is_err());
    assert!(host.events.lock().unwrap().is_empty());
    let mut large = staged();
    large.data = vec![0; 50 * 1024 * 1024 + 1];
    assert!(store.stage(large, 0).is_err());
    let id = store.stage(staged(), 1).unwrap();
    assert!(store.save(&id, &host, 600_001).await.is_ok());
}

#[tokio::test]
async fn cursor_binary_write_uses_the_real_save_tool_and_typed_native_success_or_permission_denial()
{
    for denied in [None, Some(PermissionKind::Edit)] {
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
                    let first = body.data().await.unwrap().unwrap();
                    body.flow_control().release_capacity(first.len()).unwrap();
                    assert_eq!(decoder.push(&first).len(), 1);
                    let mut args = Vec::new();
                    protobuf::write_string(&mut args, 1, &"/outside/a.png".into()).unwrap();
                    protobuf::write_bytes(&mut args, 5, &[0, 1, 255]).unwrap();
                    let mut exec = vec![8, 8];
                    protobuf::write_bytes(&mut exec, 3, &args).unwrap();
                    let mut query = Vec::new();
                    protobuf::write_bytes(&mut query, 2, &exec).unwrap();
                    let mut send = response.send_response(Response::builder().status(200).body(()).unwrap(), false).unwrap();
                    send.send_data(Bytes::from(framing::encode(0, &query).unwrap()), false).unwrap();
                    let mut observed = Vec::new();
                    while observed.len() < 2 {
                        let chunk = body.data().await.unwrap().unwrap();
                        body.flow_control().release_capacity(chunk.len()).unwrap();
                        observed.extend(decoder.push(&chunk));
                    }
                    let reply = protobuf::fields(&observed[0].payload).unwrap();
                    let exec = protobuf::fields(reply[0].bytes().unwrap()).unwrap();
                    assert_eq!(exec.iter().find(|field| field.number == 1).unwrap().varint().unwrap(), 8);
                    let result = protobuf::fields(exec.iter().find(|field| field.number == 3).unwrap().bytes().unwrap()).unwrap();
                    assert_eq!(result[0].number, if denied.is_some() { 3 } else { 1 });
                    let value = protobuf::fields(result[0].bytes().unwrap()).unwrap();
                    assert_eq!(value.iter().find(|field| field.number == 1).unwrap().text().unwrap(), "/fixture/project/assets/a.png");
                    if denied.is_some() {
                        assert_eq!(value.iter().find(|field| field.number == 3).unwrap().text().unwrap(), "write");
                        assert_eq!(value.iter().find(|field| field.number == 4).unwrap().text().unwrap(), "fixture refusal");
                    } else {
                        assert_eq!(value.iter().find(|field| field.number == 2).unwrap().varint().unwrap(), 0);
                        assert_eq!(value.iter().find(|field| field.number == 3).unwrap().varint().unwrap(), 3);
                    }
                    assert_eq!(observed[1].payload, [42, 4, 10, 2, 8, 8]);
                    send.send_data(Bytes::from(framing::encode(0, &[10, 2, 114, 0]).unwrap()), false).unwrap();
                    while let Some(chunk) = body.data().await { match chunk { Ok(chunk) => body.flow_control().release_capacity(chunk.len()).unwrap(), Err(error) => { assert_eq!(error.reason(), Some(h2::Reason::CANCEL)); break; } } }
                };
                tokio::pin!(exchange);
                tokio::select! { () = &mut exchange => {}, next = connection.accept() => { assert!(next.is_none()); exchange.await; } }
            });
            let runtime = Arc::new(provider::Runtime::new(Default::default()).unwrap());
            let host = Arc::new(host(denied, false));
            let save = runtime.image_save_tool(host.clone());
            let mut config = provider::Config::new(Auth::bearer(Credential::value("fixture-token")), headers::Identity { machine_id: "machine".into(), mac_machine_id: None, client_version: "cli-fixture".into() }, provider::RequestContext::new(vec![34, 0]).unwrap(), runtime.clone());
            config.agent = Some(transport::Endpoint::loopback(address).unwrap());
            config.image_host = Some(host.clone());
            config.image_environment = Some(staged().environment);
            let mut request = Request::new(provider::model("image-fixture", config).unwrap());
            request.http.headers.insert("x-session-id".into(), "ses-fixture".into());
            request.messages.push(Message::user("Generate"));
            request.tools.push(save.definition.clone());
            let executor = Executor::new(Executor::http_client().unwrap());
            let first = executor.generate(&request).await.unwrap();
            assert_eq!(first.finish_reason, FinishReason::ToolCalls);
            let call = first.message.content.iter().find_map(|part| if let Part::ToolCall(call) = part { Some(call.clone()) } else { None }).unwrap();
            assert_eq!(call.name, images::SAVE_TOOL.into());
            let ycoding_schema::JsonValue::Object(input) = &call.input else { panic!("image handle object required"); };
            assert_eq!(input.len(), 1);
            let tools = BTreeMap::from([(call.name.clone(), save)]);
            let result = tool::dispatch(&tools, &call).await.unwrap();
            request.messages.push(first.message);
            request.messages.push(Message::new(Role::Tool, vec![Part::ToolResult(ToolResult { id: call.id, name: call.name, result: result.result, cache: None, provider_executed: None, provider_metadata: None, output: result.output })]));
            assert_eq!(executor.generate(&request).await.unwrap().finish_reason, FinishReason::Stop);
            assert_eq!(host.events.lock().unwrap().contains(&"write"), denied.is_none());
            assert_eq!(host.sessions.lock().unwrap().as_slice(), ["ses-fixture".into(), "ses-fixture".into()]);
            server.await.unwrap();
            runtime.shutdown().await;
        }).await.unwrap();
    }
}

#[tokio::test]
async fn cursor_oversized_binary_write_gets_a_typed_refusal_and_the_run_continues() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            socket.set_nodelay(true).unwrap();
            let mut connection = h2::server::handshake(socket).await.unwrap();
            let (request, mut response) = connection.accept().await.unwrap().unwrap();
            let mut body = request.into_body();
            let exchange = async move {
                let mut decoder = framing::Decoder::default();
                let first = body.data().await.unwrap().unwrap();
                body.flow_control().release_capacity(first.len()).unwrap();
                assert_eq!(decoder.push(&first).len(), 1);
                let mut args = Vec::new();
                protobuf::write_string(&mut args, 1, &"/outside/a.png".into()).unwrap();
                protobuf::write_bytes(&mut args, 5, &vec![0; images::MAX_STAGED_BYTES + 1]).unwrap();
                let mut exec = vec![8, 8];
                protobuf::write_bytes(&mut exec, 3, &args).unwrap();
                let mut query = Vec::new();
                protobuf::write_bytes(&mut query, 2, &exec).unwrap();
                let mut send = response.send_response(Response::builder().status(200).body(()).unwrap(), false).unwrap();
                let frame = Bytes::from(framing::encode(0, &query).unwrap());
                let mut sent = 0;
                while sent < frame.len() {
                    send.reserve_capacity(frame.len() - sent);
                    let granted = std::future::poll_fn(|cx| send.poll_capacity(cx)).await.unwrap().unwrap();
                    send.send_data(frame.slice(sent..sent + granted), false).unwrap();
                    sent += granted;
                }
                let mut observed = Vec::new();
                while observed.len() < 2 {
                    let chunk = body.data().await.unwrap().unwrap();
                    body.flow_control().release_capacity(chunk.len()).unwrap();
                    observed.extend(decoder.push(&chunk).into_iter().filter(|frame| frame.flags != 0 || frame.payload != [0x3a, 0]));
                }
                let reply = protobuf::fields(&observed[0].payload).unwrap();
                let exec = protobuf::fields(reply[0].bytes().unwrap()).unwrap();
                let result = protobuf::fields(exec.iter().find(|field| field.number == 3).unwrap().bytes().unwrap()).unwrap();
                assert_eq!(result[0].number, 5);
                let value = protobuf::fields(result[0].bytes().unwrap()).unwrap();
                assert_eq!(value.iter().find(|field| field.number == 1).unwrap().text().unwrap(), "/outside/a.png");
                assert_eq!(
                    value.iter().find(|field| field.number == 2).unwrap().text().unwrap(),
                    "Generated image is 52428801 bytes, above the 52428800 byte limit\nWorkspace root: \"/work/space\". Resolve workspace paths against exactly this root; never invent an absolute prefix, and verify uncertain paths with an available tool before using them."
                );
                assert_eq!(observed[1].payload, [42, 4, 10, 2, 8, 8]);
                send.send_data(Bytes::from(framing::encode(0, &[10, 2, 114, 0]).unwrap()), false).unwrap();
                while let Some(chunk) = body.data().await { match chunk { Ok(chunk) => body.flow_control().release_capacity(chunk.len()).unwrap(), Err(error) => { assert_eq!(error.reason(), Some(h2::Reason::CANCEL)); break; } } }
            };
            tokio::pin!(exchange);
            tokio::select! { () = &mut exchange => {}, next = connection.accept() => { assert!(next.is_none()); exchange.await; } }
        });
        let runtime = Arc::new(provider::Runtime::new(Default::default()).unwrap());
        let host = Arc::new(host(None, false));
        let save = runtime.image_save_tool(host.clone());
        let mut config = provider::Config::new(Auth::bearer(Credential::value("fixture-token")), headers::Identity { machine_id: "machine".into(), mac_machine_id: None, client_version: "cli-fixture".into() }, provider::RequestContext::new(vec![34, 13, 18, 11, b'/', b'w', b'o', b'r', b'k', b'/', b's', b'p', b'a', b'c', b'e']).unwrap(), runtime.clone());
        config.agent = Some(transport::Endpoint::loopback(address).unwrap());
        config.image_host = Some(host.clone());
        config.image_environment = Some(staged().environment);
        let mut request = Request::new(provider::model("image-fixture", config).unwrap());
        request.http.headers.insert("x-session-id".into(), "ses-fixture".into());
        request.messages.push(Message::user("Generate"));
        request.tools.push(save.definition.clone());
        let response = Executor::new(Executor::http_client().unwrap()).generate(&request).await.unwrap();
        assert_eq!(response.finish_reason, FinishReason::Stop);
        assert!(host.events.lock().unwrap().is_empty());
        server.await.unwrap();
        runtime.shutdown().await;
    }).await.unwrap();
}

#[tokio::test]
async fn cursor_generate_image_approval_preserves_description_and_rejects_missing_save_paths_or_bad_args()
 {
    for (enabled, disabled, malformed, session) in [
        (true, false, false, true),
        (false, false, false, true),
        (true, true, false, true),
        (true, false, true, true),
        (true, false, false, false),
    ] {
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
                    let chunk = body.data().await.unwrap().unwrap();
                    body.flow_control().release_capacity(chunk.len()).unwrap();
                    assert_eq!(decoder.push(&chunk).len(), 1);
                    let mut args = Vec::new(); protobuf::write_string(&mut args, 1, &"  Draw a tree  ".into()).unwrap();
                    let mut query_body = Vec::new(); protobuf::write_bytes(&mut query_body, 1, &args).unwrap();
                    let mut query = vec![8, 17]; protobuf::write_bytes(&mut query, 12, if malformed { &[10, 1] } else { &query_body }).unwrap();
                    let mut message = Vec::new(); protobuf::write_bytes(&mut message, 7, &query).unwrap();
                    let mut send = response.send_response(Response::builder().status(200).body(()).unwrap(), false).unwrap();
                    send.send_data(Bytes::from(framing::encode(0, &message).unwrap()), false).unwrap();
                    let frame = loop { let chunk = body.data().await.expect("query must receive a typed reply").unwrap(); body.flow_control().release_capacity(chunk.len()).unwrap(); if let Some(frame) = decoder.push(&chunk).pop() { break frame; } };
                    let outer = protobuf::fields(&frame.payload).unwrap(); assert_eq!(outer[0].number, 6);
                    let response = protobuf::fields(outer[0].bytes().unwrap()).unwrap(); assert_eq!(response[0].varint().unwrap(), 17);
                    let result = protobuf::fields(response.iter().find(|field| field.number == 12).unwrap().bytes().unwrap()).unwrap();
                    let approved = enabled && !disabled && !malformed && session;
                    assert_eq!(result[0].number, if approved { 1 } else { 2 });
                    let value = protobuf::fields(result[0].bytes().unwrap()).unwrap();
                    let description = value[0].text().unwrap();
                    if approved { assert_eq!(description, "  Draw a tree  "); }
                    else if malformed { assert!(description.contains("Missing generate image")); }
                    else { assert!(description.contains("cannot save a generated image")); }
                    send.send_data(Bytes::from(framing::encode(0, &[10, 2, 114, 0]).unwrap()), false).unwrap();
                    while let Some(chunk) = body.data().await { match chunk { Ok(chunk) => body.flow_control().release_capacity(chunk.len()).unwrap(), Err(error) => { assert_eq!(error.reason(), Some(h2::Reason::CANCEL)); break; } } }
                };
                tokio::pin!(exchange);
                tokio::select! { () = &mut exchange => {}, next = connection.accept() => { assert!(next.is_none()); exchange.await; } }
            });
            let runtime = Arc::new(provider::Runtime::new(Default::default()).unwrap());
            let host = Arc::new(host(None, false));
            let save = runtime.image_save_tool(host.clone());
            let mut config = provider::Config::new(Auth::bearer(Credential::value("fixture-token")), headers::Identity { machine_id: "machine".into(), mac_machine_id: None, client_version: "cli-fixture".into() }, provider::RequestContext::new(vec![34, 0]).unwrap(), runtime.clone());
            config.agent = Some(transport::Endpoint::loopback(address).unwrap());
            if enabled { config.image_host = Some(host.clone()); config.image_environment = Some(staged().environment); }
            let mut request = Request::new(provider::model("image-fixture", config).unwrap());
            if session { request.http.headers.insert("x-session-id".into(), "ses-fixture".into()); }
            request.messages.push(Message::user("Generate"));
            request.tools.push(save.definition);
            if disabled { request.tool_choice = Some(ToolChoice::None); }
            assert_eq!(Executor::new(Executor::http_client().unwrap()).generate(&request).await.unwrap().finish_reason, FinishReason::Stop);
            assert!(host.events.lock().unwrap().is_empty());
            server.await.unwrap(); runtime.shutdown().await;
        }).await.unwrap();
    }
}
