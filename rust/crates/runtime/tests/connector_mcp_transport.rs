mod connector_support;
mod remote_derived_support;
mod support;

use connector_support::{Command, Opening, Relay, WAIT};
use prost::{Message, Name};
use remote_derived_support::{Access, Fixture, Saved, world};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use support::{machine, text};
use tokio::sync::{Notify, Semaphore};
use ycoding_core::{
    event_feed::Data,
    remote::Device,
    ycoding_schema::{
        DomainDecode, JsonValue, parse_json,
        provider_usage::{PaceMilestone, QuotaPaceAlert},
        schema::NonNegativeInt,
    },
};
use ycoding_protocol::{OPERATIONS, connection::Budgets, decode_strict, v5};
use ycoding_runtime::{
    Dispatcher,
    connector::{Connector, Control, McpFile, Settings, State},
};

const VERSION: &str = "2026-07-28";
const INVALID_MESSAGE: i32 = 1;
const AGENT_UNAVAILABLE: i32 = 10;
const OUTCOME_UNKNOWN: i32 = 11;
const FORBIDDEN: i32 = 12;
static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Calls {
    root: String,
    started: Mutex<Vec<String>>,
    entered: Notify,
    block: AtomicBool,
    gate: Semaphore,
    fail: AtomicBool,
    resource: ResourceGate,
}

struct ResourceGate {
    block: AtomicBool,
    released: Mutex<bool>,
    wake: std::sync::Condvar,
    entered: Notify,
    exited: Notify,
}

impl Calls {
    fn started(&self) -> Vec<String> {
        self.started.lock().unwrap().clone()
    }

    async fn wait_started(&self, count: usize) {
        tokio::time::timeout(WAIT, async {
            while self.started.lock().unwrap().len() < count {
                self.entered.notified().await;
            }
        })
        .await
        .unwrap();
    }
}

fn dispatcher(calls: Arc<Calls>) -> Dispatcher {
    let mut dispatcher = Dispatcher::new(OPERATIONS.clone());
    ycoding_runtime::connector::register(&mut dispatcher).unwrap();
    dispatcher
        .authorize("artifact.demo.export", {
            let calls = calls.clone();
            move |_, _| {
                if calls.resource.block.swap(false, Ordering::AcqRel) {
                    calls.resource.entered.notify_one();
                    let (released, timeout) = calls
                        .resource
                        .wake
                        .wait_timeout_while(
                            calls.resource.released.lock().unwrap(),
                            WAIT,
                            |released| !*released,
                        )
                        .unwrap();
                    assert!(
                        !timeout.timed_out() && *released,
                        "resource gate was not released"
                    );
                    calls.resource.exited.notify_one();
                }
                Ok(())
            }
        })
        .unwrap();
    dispatcher
        .handle(
            "session.interrupt",
            move |invocation, _: v5::SessionInterruptRequest| {
                let calls = calls.clone();
                async move {
                    let Some(v5::scope::Target::Session(id)) = invocation.scope.target else {
                        panic!("Session-scoped interrupt");
                    };
                    calls.started.lock().unwrap().push(id.clone());
                    calls.entered.notify_one();
                    if id == calls.root {
                        if calls.fail.swap(false, Ordering::AcqRel) {
                            panic!("synthetic dispatched mutation abort");
                        }
                        if calls.block.load(Ordering::Acquire) {
                            calls.gate.acquire().await.unwrap().forget();
                        }
                    }
                    Ok(v5::SessionInterruptResult { data: v5::Empty {} })
                }
            },
        )
        .unwrap();
    dispatcher
        .handle(
            "session.todo.list",
            |_, _: v5::SessionTodoListRequest| async {
                Ok(v5::SessionTodoListResult {
                    data: v5::SessionTodoListResultData { items: Vec::new() },
                })
            },
        )
        .unwrap();
    dispatcher
}

struct Harness {
    relay: Relay,
    opening: Opening,
    connector: Connector,
    control: Control,
    fixture: Fixture,
    calls: Arc<Calls>,
    state: PathBuf,
    epoch: String,
}

impl Harness {
    async fn new(enable: bool) -> Self {
        let fixture = Fixture::new().await;
        let state = std::env::temp_dir().join(format!(
            "ycoding-mcp-transport-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&state);
        std::fs::create_dir_all(&state).unwrap();
        let relay = Relay::start(5, false, Budgets::default()).await;
        let control = Control::load_with_mcp(
            Arc::new(Saved(AtomicBool::new(true))),
            Arc::new(McpFile(state.join("remote-mcp.json"))),
            Device::new(&state.join("device")).unwrap(),
            fixture.path.clone(),
        )
        .await;
        if enable {
            control.set_mcp(true).await.unwrap();
        }
        let calls = Arc::new(Calls {
            root: fixture.root.clone(),
            started: Mutex::new(Vec::new()),
            entered: Notify::new(),
            block: AtomicBool::new(false),
            gate: Semaphore::new(0),
            fail: AtomicBool::new(false),
            resource: ResourceGate {
                block: AtomicBool::new(false),
                released: Mutex::new(false),
                wake: std::sync::Condvar::new(),
                entered: Notify::new(),
                exited: Notify::new(),
            },
        });
        let mut environment = Arc::into_inner(fixture.environment(true)).unwrap();
        environment.services.core.as_mut().unwrap().remote = Some(control.clone());
        let connector = Connector::start(
            control.clone(),
            Settings::new(Arc::new(Access(relay.origin()))),
            Arc::new(environment),
            Arc::new(dispatcher(calls.clone())),
        )
        .unwrap();
        let mut relay = relay;
        let opening = relay.opening().await;
        Self {
            relay,
            opening,
            connector,
            control,
            fixture,
            calls,
            state,
            epoch: String::new(),
        }
    }

    async fn advertised(&mut self) -> v5::McpState {
        let frame = self
            .relay
            .matching(self.opening.generation, |frame| {
                matches!(
                    &frame.body,
                    Some(v5::frame::Body::Control(v5::Control {
                        kind: Some(v5::control::Kind::McpState(_))
                    }))
                )
            })
            .await;
        let Some(v5::frame::Body::Control(v5::Control {
            kind: Some(v5::control::Kind::McpState(state)),
        })) = frame.body
        else {
            unreachable!()
        };
        state
    }

    async fn acknowledge(&mut self, state: &v5::McpState) {
        self.send(v5::control::Kind::McpStateAck(v5::McpStateAck {
            id: state.id.clone(),
            enabled: state.enabled,
            epoch: state.epoch.clone(),
        }))
        .await;
    }

    async fn send(&self, kind: v5::control::Kind) {
        self.opening
            .commands
            .send(Command::Body(v5::frame::Body::Control(v5::Control {
                kind: Some(kind),
            })))
            .await
            .unwrap();
    }

    async fn on(&mut self) {
        let state = self.advertised().await;
        assert!(state.enabled);
        self.epoch = state.epoch.clone();
        self.acknowledge(&state).await;
        let mut observe = self.control.mcp_observe();
        tokio::time::timeout(WAIT, observe.wait_for(|status| status.state == State::On))
            .await
            .unwrap()
            .unwrap();
    }

    async fn reconnect(&mut self) {
        self.opening
            .commands
            .send(Command::Close(1012))
            .await
            .unwrap();
        self.relay.closed(self.opening.generation).await;
        self.opening = self.relay.opening().await;
    }

    fn payload(&self, body: &str, tool: Option<&str>) -> v5::McpRequestRequest {
        let mut headers = vec![
            ("content-type", "application/json"),
            ("accept", "application/json, text/event-stream"),
            ("mcp-protocol-version", VERSION),
            (
                "mcp-method",
                if tool.is_some() {
                    "tools/call"
                } else {
                    "tools/list"
                },
            ),
        ];
        if let Some(tool) = tool {
            headers.push(("mcp-name", tool));
        }
        v5::McpRequestRequest {
            payload: v5::ConnectorMcpRequest {
                body: text(body),
                headers: headers
                    .into_iter()
                    .map(|(name, value)| v5::ConnectorMcpHeader {
                        name: name.into(),
                        value: text(value),
                    })
                    .collect(),
                principal: v5::ConnectorMcpPrincipal {
                    owner_id: "owner-1".into(),
                    device_id: "device-a".into(),
                    client_id: text("https://client.example/metadata.json"),
                },
                epoch: self.epoch.clone(),
            },
        }
    }

    fn call(&self, tool: &str, session: &str) -> v5::McpRequestRequest {
        self.payload(
            &format!(
                r#"{{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{{"name":"{tool}","arguments":{{"sessionID":"{session}"}},"_meta":{{"io.modelcontextprotocol/protocolVersion":"{VERSION}","io.modelcontextprotocol/clientInfo":{{"name":"fixture","version":"1"}},"io.modelcontextprotocol/clientCapabilities":{{}}}}}}}}"#
            ),
            Some(tool),
        )
    }

    fn resource(&self, method: &str, uri: Option<&str>) -> v5::McpRequestRequest {
        let meta = format!(
            r#"{{"io.modelcontextprotocol/protocolVersion":"{VERSION}","io.modelcontextprotocol/clientInfo":{{"name":"fixture","version":"1"}},"io.modelcontextprotocol/clientCapabilities":{{}}}}"#
        );
        let params = uri.map_or_else(String::new, |uri| format!(r#", "uri":"{uri}""#));
        let mut payload = self.payload(&format!(r#"{{"jsonrpc":"2.0","id":7,"method":"{method}","params":{{"_meta":{meta}{params}}}}}"#), None);
        payload.payload.headers[3].value = text(method);
        if let Some(uri) = uri {
            payload.payload.headers.push(v5::ConnectorMcpHeader {
                name: "mcp-name".into(),
                value: text(uri),
            });
        }
        payload
    }

    fn demo_export(&self) -> v5::McpRequestRequest {
        self.payload(&format!(r#"{{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{{"name":"artifact_demo_export","arguments":{{}},"_meta":{{"io.modelcontextprotocol/protocolVersion":"{VERSION}","io.modelcontextprotocol/clientInfo":{{"name":"fixture","version":"1"}},"io.modelcontextprotocol/clientCapabilities":{{}}}}}}}}"#), Some("artifact_demo_export"))
    }

    async fn submit(&self, payload: v5::McpRequestRequest) -> String {
        self.opening
            .request(5044, machine(), payload.encode_to_vec())
            .await
    }

    async fn settled(&mut self, id: &str) -> Result<v5::ConnectorMcpResponse, i32> {
        let frame = self
            .relay
            .matching(self.opening.generation, |frame| {
                matches!(&frame.body, Some(v5::frame::Body::Result(result)) if result.request_id == id)
            })
            .await;
        let Some(v5::frame::Body::Result(result)) = frame.body else {
            unreachable!()
        };
        match result.outcome.unwrap() {
            v5::result::Outcome::Success(value) => {
                assert_eq!(value.type_name, v5::McpRequestResult::full_name());
                Ok(decode_strict::<v5::McpRequestResult>(&value.payload)
                    .unwrap()
                    .data)
            }
            v5::result::Outcome::Error(value) => {
                assert_eq!(value.type_name, v5::ConnectorError::full_name());
                Err(decode_strict::<v5::ConnectorError>(&value.payload)
                    .unwrap()
                    .code)
            }
            v5::result::Outcome::AssetMetadata(_) => panic!("typed MCP result"),
        }
    }

    async fn exchange(
        &mut self,
        payload: v5::McpRequestRequest,
    ) -> Result<v5::ConnectorMcpResponse, i32> {
        let id = self.submit(payload).await;
        self.settled(&id).await
    }

    async fn close(self) {
        self.connector.shutdown().await.unwrap();
        self.relay.shutdown().await;
        self.fixture.close().await;
        let _ = std::fs::remove_dir_all(self.state);
    }
}

fn tool_error(response: &v5::ConnectorMcpResponse) -> Option<String> {
    let body = response_body(response);
    let parsed = parse_json(&body).unwrap();
    let mut value = &parsed;
    for key in ["result", "structuredContent", "error", "code"] {
        let JsonValue::Object(object) = value else {
            return None;
        };
        value = object.get(&key.into())?;
    }
    match value {
        JsonValue::String(code) => code.to_utf8().ok(),
        _ => None,
    }
}

fn response_body(response: &v5::ConnectorMcpResponse) -> String {
    String::from_utf16(&ycoding_protocol::decode_lossless(&response.body, 4_194_304).unwrap())
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fixed_resources_require_current_device_epoch_and_keep_identity_across_reconnect() {
    let mut harness = Harness::new(true).await;
    harness.on().await;
    let exported = harness.exchange(harness.demo_export()).await.unwrap();
    let exported_json = parse_json(&response_body(&exported)).unwrap();
    let JsonValue::Object(result) = exported_json else {
        panic!("MCP response")
    };
    let JsonValue::Object(result) = result.get(&"result".into()).unwrap() else {
        panic!("MCP result")
    };
    let JsonValue::Array(content) = result.get(&"content".into()).unwrap() else {
        panic!("resource content")
    };
    let JsonValue::Object(link) = &content[0] else {
        panic!("resource link")
    };
    let JsonValue::String(uri) = link.get(&"uri".into()).unwrap() else {
        panic!("resource URI")
    };
    let uri = uri.to_utf8().unwrap();
    let read = harness
        .exchange(harness.resource("resources/read", Some(&uri)))
        .await
        .unwrap();
    assert!(response_body(&read).contains("iVBORw0KGgoAAAANSUhEUgAAAAIAAAAC"));
    let mut foreign = harness.resource("resources/read", Some(&uri));
    foreign.payload.principal.device_id = "device-b".into();
    assert_eq!(harness.exchange(foreign).await.err(), Some(FORBIDDEN));
    let stale = harness.resource("resources/read", Some(&uri));
    harness.control.set_mcp(false).await.unwrap();
    let disabled = harness.advertised().await;
    assert_eq!(
        harness.exchange(stale.clone()).await.err(),
        Some(AGENT_UNAVAILABLE)
    );
    harness.acknowledge(&disabled).await;
    let mut observe = harness.control.mcp_observe();
    tokio::time::timeout(WAIT, observe.wait_for(|status| status.state == State::Off))
        .await
        .unwrap()
        .unwrap();
    harness.control.set_mcp(true).await.unwrap();
    harness.on().await;
    assert_eq!(harness.exchange(stale).await.err(), Some(AGENT_UNAVAILABLE));
    let after = harness.exchange(harness.demo_export()).await.unwrap();
    assert_eq!(after.body, exported.body);
    harness.reconnect().await;
    harness.on().await;
    let after = harness.exchange(harness.demo_export()).await.unwrap();
    assert_eq!(after.body, exported.body);
    harness.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelled_or_disabled_inflight_resource_exports_never_settle_on_the_relay() {
    for disable in [false, true] {
        let mut harness = Harness::new(true).await;
        harness.on().await;
        let exported = harness.exchange(harness.demo_export()).await.unwrap();
        assert_eq!(exported.status, 200);
        assert!(response_body(&exported).contains("resource_link"));
        harness.calls.resource.block.store(true, Ordering::Release);
        let id = harness.submit(harness.demo_export()).await;
        tokio::time::timeout(WAIT, harness.calls.resource.entered.notified())
            .await
            .unwrap();
        if disable {
            harness.control.set_mcp(false).await.unwrap();
        }
        if !disable {
            harness.opening.cancel(id.clone()).await;
            let root = harness.fixture.root.clone();
            harness
                .exchange(harness.call("session_todo_list", &root))
                .await
                .unwrap();
        }
        *harness.calls.resource.released.lock().unwrap() = true;
        harness.calls.resource.wake.notify_one();
        tokio::time::timeout(WAIT, harness.calls.resource.exited.notified())
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(500), harness.settled(&id))
                .await
                .is_err(),
            "stale export settled after cancellation or disablement"
        );
        harness.close().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn relay_mcp_requests_wait_for_a_matching_acknowledgement_on_the_current_connection() {
    let mut harness = Harness::new(true).await;
    let state = harness.advertised().await;
    assert!(state.enabled);
    harness.epoch = state.epoch.clone();
    let root = harness.fixture.root.clone();
    assert_eq!(
        harness
            .exchange(harness.call("session_todo_list", &root))
            .await
            .err(),
        Some(AGENT_UNAVAILABLE),
        "no MCP before the relay acknowledges"
    );
    for stale in [
        v5::McpStateAck {
            id: "other".into(),
            enabled: true,
            epoch: state.epoch.clone(),
        },
        v5::McpStateAck {
            id: state.id.clone(),
            enabled: true,
            epoch: "mcp_stale".into(),
        },
        v5::McpStateAck {
            id: state.id.clone(),
            enabled: false,
            epoch: state.epoch.clone(),
        },
    ] {
        harness.send(v5::control::Kind::McpStateAck(stale)).await;
        assert_eq!(
            harness
                .exchange(harness.call("session_todo_list", &root))
                .await
                .err(),
            Some(AGENT_UNAVAILABLE)
        );
        assert_eq!(harness.control.mcp_status().state, State::Connecting);
    }
    harness.acknowledge(&state).await;
    let mut observe = harness.control.mcp_observe();
    tokio::time::timeout(WAIT, observe.wait_for(|status| status.state == State::On))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        harness.control.mcp_status().url.as_deref(),
        Some(format!("{}/api/mcp/devices/device-a", harness.relay.origin()).as_str())
    );
    let response = harness
        .exchange(harness.call("session_todo_list", &root))
        .await
        .unwrap();
    assert_eq!(
        (response.status, response.content_type.as_str()),
        (200, "application/json")
    );
    assert_eq!(tool_error(&response), None);
    harness.reconnect().await;
    let replacement = harness.advertised().await;
    assert_eq!(replacement.epoch, state.epoch);
    assert_eq!(
        harness
            .exchange(harness.call("session_todo_list", &root))
            .await
            .err(),
        Some(AGENT_UNAVAILABLE),
        "a replacement connection waits for its own acknowledgement"
    );
    harness.acknowledge(&replacement).await;
    let mut observe = harness.control.mcp_observe();
    tokio::time::timeout(WAIT, observe.wait_for(|status| status.state == State::On))
        .await
        .unwrap()
        .unwrap();
    assert!(
        harness
            .exchange(harness.call("session_todo_list", &root))
            .await
            .is_ok()
    );
    harness.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn raw_requests_must_match_the_authenticated_device_epoch_and_header_policy() {
    let mut harness = Harness::new(true).await;
    harness.on().await;
    let root = harness.fixture.root.clone();
    let mut foreign = harness.call("session_interrupt", &root);
    foreign.payload.principal.device_id = "device-b".into();
    assert_eq!(harness.exchange(foreign).await.err(), Some(FORBIDDEN));
    let mut stale = harness.call("session_interrupt", &root);
    stale.payload.epoch = "mcp_previous".into();
    assert_eq!(harness.exchange(stale).await.err(), Some(AGENT_UNAVAILABLE));
    for header in ["authorization", "cookie", "x-forwarded-for"] {
        let mut extra = harness.call("session_interrupt", &root);
        extra.payload.headers[4] = v5::ConnectorMcpHeader {
            name: header.into(),
            value: text("value"),
        };
        assert_eq!(
            harness.exchange(extra).await.err(),
            Some(INVALID_MESSAGE),
            "{header}"
        );
    }
    let mut duplicate = harness.call("session_interrupt", &root);
    duplicate.payload.headers[4] = v5::ConnectorMcpHeader {
        name: "accept".into(),
        value: text("application/json"),
    };
    assert_eq!(
        harness.exchange(duplicate).await.err(),
        Some(INVALID_MESSAGE)
    );
    let mut injected = harness.call("session_interrupt", &root);
    injected.payload.headers[1].value = text("application/json\r\nx: y");
    assert_eq!(
        harness.exchange(injected).await.err(),
        Some(INVALID_MESSAGE)
    );
    let mut owner = harness.call("session_interrupt", &root);
    owner.payload.principal.owner_id = "owner with space".into();
    assert_eq!(harness.exchange(owner).await.err(), Some(INVALID_MESSAGE));
    assert!(
        harness.calls.started().is_empty(),
        "rejected requests dispatch nothing"
    );
    assert!(
        harness
            .exchange(harness.call("session_interrupt", &root))
            .await
            .is_ok()
    );
    assert_eq!(harness.calls.started(), vec![root]);
    harness.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn same_session_mutations_queue_while_reads_and_other_sessions_proceed() {
    let mut harness = Harness::new(true).await;
    harness.on().await;
    let root = harness.fixture.root.clone();
    let other = harness.fixture.other.clone();
    harness.calls.block.store(true, Ordering::Release);
    let first = harness
        .submit(harness.call("session_interrupt", &root))
        .await;
    harness.calls.wait_started(1).await;
    let second = harness
        .submit(harness.call("session_interrupt", &root))
        .await;
    assert!(
        harness
            .exchange(harness.call("session_todo_list", &root))
            .await
            .is_ok()
    );
    assert!(
        harness
            .exchange(harness.call("session_interrupt", &other))
            .await
            .is_ok()
    );
    assert_eq!(harness.calls.started(), vec![root.clone(), other.clone()]);
    harness.calls.gate.add_permits(2);
    assert!(harness.settled(&first).await.is_ok());
    assert!(harness.settled(&second).await.is_ok());
    assert_eq!(harness.calls.started(), vec![root.clone(), other, root]);
    harness.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unknown_outcome_quarantines_only_its_lane_across_reconnects_until_explicit_reenable() {
    let mut harness = Harness::new(true).await;
    harness.on().await;
    let root = harness.fixture.root.clone();
    let other = harness.fixture.other.clone();
    harness.calls.fail.store(true, Ordering::Release);
    let unknown = harness
        .exchange(harness.call("session_interrupt", &root))
        .await
        .unwrap();
    assert_eq!(tool_error(&unknown).as_deref(), Some("outcome_unknown"));
    assert_eq!(
        harness
            .exchange(harness.call("session_interrupt", &root))
            .await
            .err(),
        Some(OUTCOME_UNKNOWN)
    );
    assert_eq!(harness.calls.started(), vec![root.clone()], "no replay");
    assert!(
        harness
            .exchange(harness.call("session_todo_list", &root))
            .await
            .is_ok()
    );
    assert!(
        harness
            .exchange(harness.call("session_interrupt", &other))
            .await
            .is_ok()
    );
    harness.reconnect().await;
    harness.on().await;
    assert_eq!(
        harness
            .exchange(harness.call("session_interrupt", &root))
            .await
            .err(),
        Some(OUTCOME_UNKNOWN),
        "automatic reconnect keeps the quarantine"
    );
    harness.control.set_mcp(false).await.unwrap();
    let revoked = harness.advertised().await;
    assert!(!revoked.enabled);
    harness.acknowledge(&revoked).await;
    harness.control.set_mcp(true).await.unwrap();
    harness.on().await;
    assert!(
        harness
            .exchange(harness.call("session_interrupt", &root))
            .await
            .is_ok()
    );
    assert_eq!(harness.calls.started(), vec![root.clone(), other, root]);
    harness.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelling_or_disconnecting_a_dispatched_mutation_quarantines_its_lane() {
    let mut harness = Harness::new(true).await;
    harness.on().await;
    let root = harness.fixture.root.clone();
    harness.calls.block.store(true, Ordering::Release);
    let queued_first = harness
        .submit(harness.call("session_interrupt", &root))
        .await;
    harness.calls.wait_started(1).await;
    let queued_second = harness
        .submit(harness.call("session_interrupt", &root))
        .await;
    harness.opening.cancel(queued_second).await;
    harness.opening.cancel(queued_first).await;
    harness.calls.gate.add_permits(1);
    harness.calls.block.store(false, Ordering::Release);
    assert_eq!(
        harness
            .exchange(harness.call("session_interrupt", &root))
            .await
            .err(),
        Some(OUTCOME_UNKNOWN)
    );
    assert_eq!(
        harness.calls.started(),
        vec![root.clone()],
        "the cancelled queued request never ran"
    );
    harness.close().await;

    let mut harness = Harness::new(true).await;
    harness.on().await;
    let root = harness.fixture.root.clone();
    harness.calls.block.store(true, Ordering::Release);
    harness
        .submit(harness.call("session_interrupt", &root))
        .await;
    harness.calls.wait_started(1).await;
    harness.reconnect().await;
    harness.calls.block.store(false, Ordering::Release);
    harness.calls.gate.add_permits(1);
    harness.on().await;
    assert_eq!(
        harness
            .exchange(harness.call("session_interrupt", &root))
            .await
            .err(),
        Some(OUTCOME_UNKNOWN)
    );
    assert_eq!(harness.calls.started(), vec![root]);
    harness.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn remote_off_revokes_relay_mcp_until_the_relay_acknowledges_the_disabled_epoch() {
    let mut harness = Harness::new(true).await;
    harness.on().await;
    harness.control.set(false).await.unwrap();
    harness.relay.closed(harness.opening.generation).await;
    assert_eq!(harness.control.mcp_status().state, State::Off);
    let saved = std::fs::read_to_string(harness.state.join("remote-mcp.json")).unwrap();
    assert!(saved.contains("\"enabled\":false") && saved.contains("\"pendingRevocation\":true"));
    harness.control.set(true).await.unwrap();
    harness.opening = harness.relay.opening().await;
    let revoked = harness.advertised().await;
    assert!(!revoked.enabled);
    assert_ne!(revoked.epoch, harness.epoch);
    harness.acknowledge(&revoked).await;
    tokio::time::timeout(WAIT, async {
        loop {
            let saved = std::fs::read_to_string(harness.state.join("remote-mcp.json")).unwrap();
            if saved.contains("\"pendingRevocation\":false") {
                assert!(saved.contains(&format!("\"epoch\":\"{}\"", revoked.epoch)));
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(harness.control.mcp_status().state, State::Off);
    harness.epoch = revoked.epoch.clone();
    let root = harness.fixture.root.clone();
    assert_eq!(
        harness
            .exchange(harness.call("session_todo_list", &root))
            .await
            .err(),
        Some(AGENT_UNAVAILABLE)
    );
    harness.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_never_enabled_connector_advertises_a_stable_disabled_epoch_without_persisting_it() {
    let mut harness = Harness::new(false).await;
    let first = harness.advertised().await;
    assert!(!first.enabled);
    harness.acknowledge(&first).await;
    harness.epoch = first.epoch.clone();
    let root = harness.fixture.root.clone();
    assert_eq!(
        harness
            .exchange(harness.call("session_interrupt", &root))
            .await
            .err(),
        Some(AGENT_UNAVAILABLE)
    );
    assert_eq!(harness.control.mcp_status().state, State::Off);
    assert_eq!(harness.control.mcp_status().url, None);
    assert!(!harness.state.join("remote-mcp.json").exists());
    harness.reconnect().await;
    let second = harness.advertised().await;
    assert!(!second.enabled);
    assert_eq!(second.epoch, first.epoch);
    assert_ne!(second.id, first.id);
    harness.acknowledge(&second).await;
    harness.epoch = second.epoch.clone();
    assert_eq!(
        harness
            .exchange(harness.call("session_todo_list", &root))
            .await
            .err(),
        Some(AGENT_UNAVAILABLE)
    );
    assert_eq!(harness.control.mcp_status().state, State::Off);
    assert!(!harness.state.join("remote-mcp.json").exists());
    assert!(harness.calls.started().is_empty());
    harness.close().await;
}

fn alert(provider: &str, window: &str, milestone: &str, reset_at: u64) -> Data {
    Data::ProviderQuotaPace(Box::new(QuotaPaceAlert {
        provider_id: DomainDecode::decode(&JsonValue::String(provider.into())).unwrap(),
        window_id: window.into(),
        milestone: PaceMilestone(milestone.into()),
        reset_at: NonNegativeInt::new(reset_at as i64).unwrap(),
        title: "Fixed title".into(),
        body: "Fixed body".into(),
    }))
}

fn quota(frame: &v5::Frame, window: &str) -> Option<v5::QuotaPace> {
    match &frame.body {
        Some(v5::frame::Body::Control(v5::Control {
            kind: Some(v5::control::Kind::QuotaPace(quota)),
        })) if ycoding_protocol::decode_lossless(&quota.window_id, 64).unwrap()
            == window.encode_utf16().collect::<Vec<_>>() =>
        {
            Some(quota.clone())
        }
        _ => None,
    }
}

async fn next_quota(harness: &mut Harness, prefix: &str) -> String {
    let frame = harness
        .relay
        .matching(harness.opening.generation, |frame| {
            matches!(&frame.body, Some(v5::frame::Body::Control(v5::Control { kind: Some(v5::control::Kind::QuotaPace(quota)) }))
                if String::from_utf16(&ycoding_protocol::decode_lossless(&quota.window_id, 64).unwrap()).unwrap().starts_with(prefix))
        })
        .await;
    let Some(v5::frame::Body::Control(v5::Control {
        kind: Some(v5::control::Kind::QuotaPace(quota)),
    })) = frame.body
    else {
        unreachable!()
    };
    String::from_utf16(&ycoding_protocol::decode_lossless(&quota.window_id, 64).unwrap()).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn quota_pace_alerts_forward_once_per_refresh_and_settle_only_on_relay_result() {
    let mut harness = Harness::new(false).await;
    tokio::time::timeout(
        WAIT,
        harness
            .control
            .observe()
            .wait_for(|(_, status)| status.state == State::On),
    )
    .await
    .unwrap()
    .unwrap();
    let prefix = format!("pace-{}-", NEXT.fetch_add(1, Ordering::Relaxed));
    let window = |name: &str| format!("{prefix}{name}");
    let events = &world().core.events;
    let future = ((support_now() + 3_600_000) / 60_000 * 60_000) as u64;
    events
        .emit(alert("openai", &window("a"), "almost-out", future), None)
        .unwrap();
    let first = harness
        .relay
        .matching(harness.opening.generation, |frame| {
            quota(frame, &window("a")).is_some()
        })
        .await;
    let sent = quota(&first, &window("a")).unwrap();
    assert_eq!(sent.milestone, v5::QuotaPaceMilestone::AlmostOut as i32);
    assert_eq!(sent.reset_at, future);
    harness
        .send(v5::control::Kind::QuotaPaceResult(v5::QuotaPaceResult {
            quota: sent.clone(),
            status: v5::QuotaPaceStatus::Pending as i32,
        }))
        .await;
    events
        .emit(alert("openai", &window("expired"), "will-run-out", 1), None)
        .unwrap();
    events
        .emit(
            alert("openai", &window("b"), "cutting-it-close", future),
            None,
        )
        .unwrap();
    assert_eq!(
        next_quota(&mut harness, &prefix).await,
        window("b"),
        "pending is not resent; expired drops"
    );
    events
        .emit(
            alert("openai", &window("a"), "almost-out", future + 10_000),
            None,
        )
        .unwrap();
    assert_eq!(
        next_quota(&mut harness, &prefix).await,
        window("a"),
        "a refresh resends the pending alert"
    );
    harness
        .send(v5::control::Kind::QuotaPaceResult(v5::QuotaPaceResult {
            quota: sent,
            status: v5::QuotaPaceStatus::Settled as i32,
        }))
        .await;
    events
        .emit(alert("openai", &window("c"), "will-run-out", future), None)
        .unwrap();
    assert_eq!(next_quota(&mut harness, &prefix).await, window("c"));
    harness.reconnect().await;
    let mut resent = vec![
        next_quota(&mut harness, &prefix).await,
        next_quota(&mut harness, &prefix).await,
    ];
    resent.sort();
    assert_eq!(
        resent,
        vec![window("b"), window("c")],
        "settled alerts never return after reconnect"
    );
    events
        .emit(alert("openai", &window("d"), "almost-out", future), None)
        .unwrap();
    assert_eq!(next_quota(&mut harness, &prefix).await, window("d"));
    harness.close().await;
}

fn support_now() -> i64 {
    remote_derived_support::now()
}
