use bytes::Bytes;
use http::Response;
use std::{
    future::Future,
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
        planning::{self, Approval, ApprovalKind, Artifact, Decision, Plan},
        protobuf, provider, transport,
    },
    llm::{FinishReason, Message, Request, ToolChoice, ToolDefinition},
    route::Executor,
};
use ycoding_schema::LosslessString;

struct Host {
    events: Mutex<Vec<String>>,
    accept: bool,
    fail_persist: bool,
    decline_execute: bool,
    fail_delivery: bool,
}
impl planning::Host for Host {
    fn approve<'a>(
        &'a self,
        request: &'a Approval,
    ) -> Pin<Box<dyn Future<Output = Result<Decision, Error>> + Send + 'a>> {
        Box::pin(async move {
            assert_eq!(request.session_id, "ses-planning".into());
            self.events.lock().unwrap().push(match &request.kind {
                ApprovalKind::SwitchMode { target, .. } => format!("approve:{target}"),
                ApprovalKind::ExecutePlan { artifact } => {
                    assert_eq!(artifact.uri, "file:///fixture/plan.md");
                    assert!(request.review.as_ref().unwrap().contains("Research"));
                    "approve:execute".into()
                }
            });
            Ok(
                if self.accept
                    && !(self.decline_execute
                        && matches!(request.kind, ApprovalKind::ExecutePlan { .. }))
                {
                    Decision::Approved
                } else {
                    Decision::Rejected("declined".into())
                },
            )
        })
    }
    fn persist<'a>(
        &'a self,
        request: &'a Plan,
    ) -> Pin<Box<dyn Future<Output = Result<Artifact, Error>> + Send + 'a>> {
        Box::pin(async move {
            assert_eq!(request.session_id, "ses-planning".into());
            assert_eq!(request.title, "my-plan");
            assert_eq!(request.content, "# My Plan\n\nResearch\n");
            self.events.lock().unwrap().push("persist".into());
            if self.fail_persist {
                return Err(Error::invalid("fixture disk unavailable"));
            }
            Ok(Artifact {
                path: "/fixture/plan.md".into(),
                uri: "file:///fixture/plan.md".into(),
            })
        })
    }
    fn switch_agent<'a>(
        &'a self,
        session: &'a LosslessString,
        target: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<(), Error>> + Send + 'a>> {
        Box::pin(async move {
            assert_eq!(session, &"ses-planning".into());
            self.events.lock().unwrap().push(format!("switch:{target}"));
            if self.fail_delivery {
                return Err(Error::invalid("fixture agent delivery unavailable"));
            }
            Ok(())
        })
    }
}
fn bytes(field: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    protobuf::write_bytes(&mut out, field, payload).unwrap();
    out
}
fn tool(name: &str) -> ToolDefinition {
    ToolDefinition {
        name: name.into(),
        description: "fixture".into(),
        input_schema: ycoding_schema::parse_json(r#"{"type":"object"}"#).unwrap(),
        output_schema: None,
        cache: None,
        metadata: None,
        native: None,
    }
}

#[tokio::test]
async fn cursor_planning_approval_persistence_terminal_switch_and_retained_reminder_use_the_host() {
    for (accept, fail_persist, disabled, decline_execute, fail_delivery) in [
        (true, false, false, false, false),
        (false, false, false, false, false),
        (true, true, false, false, false),
        (true, false, true, false, false),
        (true, false, false, true, false),
        (true, false, false, false, true),
    ] {
        tokio::time::timeout(Duration::from_secs(10), async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let host = Arc::new(Host { events: Mutex::new(Vec::new()), accept, fail_persist, decline_execute, fail_delivery });
            let server_host = host.clone();
            let server = tokio::spawn(async move {
                let (socket, _) = listener.accept().await.unwrap();
                let mut connection = h2::server::handshake(socket).await.unwrap();
                let (request, mut response) = connection.accept().await.unwrap().unwrap();
                let mut body = request.into_body();
                let exchange = async move {
                    let mut decoder = framing::Decoder::default(); let chunk = body.data().await.unwrap().unwrap(); body.flow_control().release_capacity(chunk.len()).unwrap(); assert_eq!(decoder.push(&chunk).len(), 1);
                    let mut send = response.send_response(Response::builder().status(200).body(()).unwrap(), false).unwrap();
                    for variant in [4, 7] {
                        let args = if variant == 4 { bytes(1, b"plan") } else { [bytes(1, b"Research"), bytes(4, b"My Plan")].concat() };
                        let query = [vec![8, variant as u8], bytes(variant, &bytes(1, &args))].concat();
                        send.send_data(Bytes::from(framing::encode(0, &bytes(7, &query)).unwrap()), false).unwrap();
                        let frame = loop { let chunk = body.data().await.expect("query requires a typed host reply").unwrap(); body.flow_control().release_capacity(chunk.len()).unwrap(); if let Some(frame) = decoder.push(&chunk).pop() { break frame; } };
                        let outer = protobuf::fields(&frame.payload).unwrap(); assert_eq!(outer[0].number, 6);
                        let response = protobuf::fields(outer[0].bytes().unwrap()).unwrap();
                        assert_eq!(response[0].varint().unwrap(), u64::from(variant));
                        let value = protobuf::fields(response[1].bytes().unwrap()).unwrap();
                        if variant == 4 { assert_eq!(value[0].number, if accept || disabled { 1 } else { 2 }); }
                        if variant == 7 {
                            let result = protobuf::fields(value[0].bytes().unwrap()).unwrap();
                            let failed = !disabled && (fail_persist || decline_execute);
                            assert_eq!(result[0].number, if failed { 2 } else { 1 });
                            assert_eq!(result.iter().find(|field| field.number == 3).unwrap().text().unwrap(), if disabled || fail_persist { "" } else { "file:///fixture/plan.md" });
                        }
                        assert!(!server_host.events.lock().unwrap().iter().any(|event| event.starts_with("switch:")), "agent switch must wait for provider terminal settlement");
                    }
                    send.send_data(Bytes::from(framing::encode(0, &[10, 2, 114, 0]).unwrap()), false).unwrap();
                    while let Some(chunk) = body.data().await { match chunk { Ok(chunk) => body.flow_control().release_capacity(chunk.len()).unwrap(), Err(error) => { assert_eq!(error.reason(), Some(h2::Reason::CANCEL)); break; } } }
                };
                tokio::pin!(exchange); tokio::select! { () = &mut exchange => {}, next = connection.accept() => { assert!(next.is_none()); exchange.await; } }
                if decline_execute {
                    for expected in ["Plan mode is active.", "Plan mode is still active."] {
                        let (request, mut response) = connection.accept().await.unwrap().unwrap();
                        let mut body = request.into_body();
                        let followup = async move {
                            let mut decoder = framing::Decoder::default();
                            let frame = loop { let chunk = body.data().await.unwrap().unwrap(); body.flow_control().release_capacity(chunk.len()).unwrap(); if let Some(frame) = decoder.push(&chunk).pop() { break frame; } };
                            let outer = protobuf::fields(&frame.payload).unwrap(); let run = protobuf::fields(outer[0].bytes().unwrap()).unwrap(); let action = protobuf::fields(run.iter().find(|field| field.number == 2).unwrap().bytes().unwrap()).unwrap(); let user = protobuf::fields(action[0].bytes().unwrap()).unwrap(); let message = protobuf::fields(user[0].bytes().unwrap()).unwrap(); let text = message[0].text().unwrap();
                            assert!(text.contains(expected)); assert!(text.contains("MUST NOT make edits")); assert!(text.contains("<system_reminder>"));
                            let mut send = response.send_response(Response::builder().status(200).body(()).unwrap(), false).unwrap(); send.send_data(Bytes::from(framing::encode(0, &[10, 2, 114, 0]).unwrap()), false).unwrap();
                            while let Some(chunk) = body.data().await { match chunk { Ok(chunk) => body.flow_control().release_capacity(chunk.len()).unwrap(), Err(error) => { assert_eq!(error.reason(), Some(h2::Reason::CANCEL)); break; } } }
                        };
                        tokio::pin!(followup); tokio::select! { () = &mut followup => {}, next = connection.accept() => { assert!(next.is_none()); followup.await; } }
                    }
                }
            });
            let runtime = Arc::new(provider::Runtime::new(Default::default()).unwrap());
            let mut config = provider::Config::new(Auth::bearer(Credential::value("fixture-token")), headers::Identity { machine_id: "machine".into(), mac_machine_id: None, client_version: "cli-fixture".into() }, provider::RequestContext::new(vec![34, 0]).unwrap(), runtime.clone());
            config.agent = Some(transport::Endpoint::loopback(address).unwrap()); config.planning_host = Some(host.clone());
            let mut request = Request::new(provider::model("planning-fixture", config).unwrap()); request.http.headers.insert("x-session-id".into(), "ses-planning".into()); request.messages.push(Message::user("Plan")); request.tools = vec![tool("plan_enter"), tool("question")]; if disabled { request.tool_choice = Some(ToolChoice::None); }
            let response = Executor::new(Executor::http_client().unwrap()).generate(&request).await;
            if fail_delivery { assert_eq!(response.unwrap_err().message, "fixture agent delivery unavailable"); }
            else { assert_eq!(response.unwrap().finish_reason, FinishReason::Stop); }
            if decline_execute {
                request.tools = vec![tool("question")];
                for _ in 0..2 { request.messages.push(Message::user("Continue")); assert_eq!(Executor::new(Executor::http_client().unwrap()).generate(&request).await.unwrap().finish_reason, FinishReason::Stop); }
            }
            server.await.unwrap(); runtime.shutdown().await;
            let expected = if disabled { vec![] } else if !accept { vec!["approve:plan", "persist"] } else if fail_persist { vec!["approve:plan", "persist", "switch:plan"] } else if decline_execute { vec!["approve:plan", "persist", "approve:execute", "switch:plan"] } else { vec!["approve:plan", "persist", "approve:execute", "switch:agent"] };
            assert_eq!(host.events.lock().unwrap().iter().map(String::as_str).collect::<Vec<_>>(), expected);
        }).await.unwrap();
    }
}
