mod connector_support;
mod remote_derived_support;
mod support;

use connector_support::{Command, Opening, Relay, WAIT};
use prost::Message;
use remote_derived_support::{Access, Fixture, Saved, world};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use support::{operation, session_scope, text};
use tokio::sync::{Notify, Semaphore};
use ycoding_core::{
    event_feed::Data,
    remote::Device,
    ycoding_schema::{
        DomainDecode, JsonValue,
        provider_usage::{PaceMilestone, QuotaPaceAlert},
        schema::NonNegativeInt,
    },
};
use ycoding_protocol::{OPERATIONS, connection::Budgets, v5};
use ycoding_runtime::{
    Dispatcher,
    connector::{Connector, Control, Settings, State},
};

const RETIRED_OPERATIONS: [(&str, u32); 3] = [
    ("remote.mcp.get", 3054),
    ("remote.mcp.set", 3055),
    ("mcp.request", 5044),
];
const HISTORICAL_STATE: &str = r#"{"enabled":true,"epoch":"mcp_stale","pendingRevocation":false}"#;
static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Calls {
    root: String,
    started: Mutex<Vec<String>>,
    entered: Notify,
    block: AtomicBool,
    gate: Semaphore,
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
                    if id == calls.root && calls.block.load(Ordering::Acquire) {
                        calls.gate.acquire().await.unwrap().forget();
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
}

impl Harness {
    async fn new() -> Self {
        Self::start(None).await
    }

    async fn with_historical_state(contents: &str) -> Self {
        Self::start(Some(contents)).await
    }

    async fn start(historical: Option<&str>) -> Self {
        let fixture = Fixture::new().await;
        let state = std::env::temp_dir().join(format!(
            "ycoding-mcp-transport-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&state);
        std::fs::create_dir_all(&state).unwrap();
        let relay = Relay::start(5, false, Budgets::default()).await;
        let control = match historical {
            None => {
                Control::load(
                    Arc::new(Saved(AtomicBool::new(true))),
                    Device::new(&state.join("device")).unwrap(),
                )
                .await
            }
            Some(contents) => {
                std::fs::write(state.join("remote.json"), r#"{"enabled":true}"#).unwrap();
                std::fs::write(state.join("remote-mcp.json"), contents).unwrap();
                Control::open(&state).await.unwrap()
            }
        };
        let calls = Arc::new(Calls {
            root: fixture.root.clone(),
            started: Mutex::new(Vec::new()),
            entered: Notify::new(),
            block: AtomicBool::new(false),
            gate: Semaphore::new(0),
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
        }
    }

    async fn ready(&mut self) {
        tokio::time::timeout(
            WAIT,
            self.control
                .observe()
                .wait_for(|(_, status)| status.state == State::On),
        )
        .await
        .unwrap()
        .unwrap();
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

    async fn reconnect(&mut self) {
        self.opening
            .commands
            .send(Command::Close(1012))
            .await
            .unwrap();
        self.relay.closed(self.opening.generation).await;
        self.opening = self.relay.opening().await;
    }

    async fn interrupt(&self, session: &str) -> String {
        self.opening
            .request(
                operation("session.interrupt").operation_id,
                session_scope(session),
                v5::SessionInterruptRequest {
                    params: v5::SessionInterruptRequestParams {
                        session_id: text(session),
                    },
                }
                .encode_to_vec(),
            )
            .await
    }

    async fn todos(&self, session: &str) -> String {
        self.opening
            .request(
                operation("session.todo.list").operation_id,
                session_scope(session),
                v5::SessionTodoListRequest {
                    params: v5::SessionTodoListRequestParams {
                        session_id: text(session),
                    },
                }
                .encode_to_vec(),
            )
            .await
    }

    async fn settled(&mut self, id: &str) -> v5::result::Outcome {
        let generation = self.opening.generation;
        let frame = tokio::time::timeout(WAIT, async {
            loop {
                let seen = self.relay.frames.recv().await.unwrap();
                if seen.generation != generation {
                    continue;
                }
                let frame = seen
                    .frame
                    .expect("relay connection closed before the expected result");
                assert!(
                    !matches!(
                        &frame.body,
                        Some(v5::frame::Body::Control(v5::Control {
                            kind: Some(v5::control::Kind::McpState(_))
                        }))
                    ),
                    "the connector advertised retired relay MCP state"
                );
                if matches!(&frame.body, Some(v5::frame::Body::Result(result)) if result.request_id == id)
                {
                    return frame;
                }
            }
        })
        .await
        .unwrap();
        let Some(v5::frame::Body::Result(result)) = frame.body else {
            unreachable!()
        };
        result.outcome.unwrap()
    }

    async fn close(self) {
        self.connector.shutdown().await.unwrap();
        self.relay.shutdown().await;
        self.fixture.close().await;
        let _ = std::fs::remove_dir_all(self.state);
    }
}

fn succeeded(outcome: &v5::result::Outcome) -> bool {
    matches!(outcome, v5::result::Outcome::Success(_))
}

#[test]
fn retired_relay_mcp_operations_have_no_descriptor_or_handler() {
    let mut dispatcher = Dispatcher::new(OPERATIONS.clone());
    ycoding_runtime::connector::register(&mut dispatcher).unwrap();
    for (name, id) in RETIRED_OPERATIONS {
        assert_eq!(dispatcher.operation_id(name), None, "{name}");
        assert!(dispatcher.descriptor(id).is_none(), "{name}");
        assert!(!dispatcher.wired().contains(&name), "{name}");
        assert!(
            OPERATIONS
                .iter()
                .all(|descriptor| descriptor.diagnostic_name != name
                    && descriptor.operation_id != id),
            "{name}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stale_enabled_relay_mcp_state_is_never_advertised_or_rewritten() {
    let mut harness = Harness::with_historical_state(HISTORICAL_STATE).await;
    harness.ready().await;
    let root = harness.fixture.root.clone();
    let id = harness.todos(&root).await;
    assert!(succeeded(&harness.settled(&id).await));
    harness.reconnect().await;
    let id = harness.todos(&root).await;
    assert!(succeeded(&harness.settled(&id).await));
    harness.control.set(false).await.unwrap();
    harness.relay.closed(harness.opening.generation).await;
    assert_eq!(
        std::fs::read_to_string(harness.state.join("remote-mcp.json")).unwrap(),
        HISTORICAL_STATE
    );
    assert_eq!(
        std::fs::read_to_string(harness.state.join("remote.json")).unwrap(),
        r#"{"enabled":false}"#
    );
    let siblings = std::fs::read_dir(&harness.state)
        .unwrap()
        .filter_map(|entry| entry.unwrap().file_name().into_string().ok())
        .filter(|name| name.starts_with("remote-mcp"))
        .collect::<Vec<_>>();
    assert_eq!(siblings, vec!["remote-mcp.json".to_owned()]);
    harness.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unsolicited_relay_mcp_acknowledgement_closes_the_connection_as_incompatible() {
    let mut harness = Harness::new().await;
    harness.ready().await;
    let generation = harness.opening.generation;
    harness
        .send(v5::control::Kind::McpStateAck(v5::McpStateAck {
            id: "mcpstate_unsolicited".into(),
            enabled: true,
            epoch: "mcp_unsolicited".into(),
        }))
        .await;
    harness.relay.closed(generation).await;
    tokio::time::timeout(
        WAIT,
        harness
            .control
            .observe()
            .wait_for(|(_, status)| status.state == State::Error),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(harness.calls.started().is_empty());
    assert!(!harness.state.join("remote-mcp.json").exists());
    harness.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn same_session_mutations_queue_while_reads_and_other_sessions_proceed() {
    let mut harness = Harness::new().await;
    harness.ready().await;
    let root = harness.fixture.root.clone();
    let other = harness.fixture.other.clone();
    harness.calls.block.store(true, Ordering::Release);
    let first = harness.interrupt(&root).await;
    harness.calls.wait_started(1).await;
    let second = harness.interrupt(&root).await;
    let read = harness.todos(&root).await;
    assert!(succeeded(&harness.settled(&read).await));
    let parallel = harness.interrupt(&other).await;
    assert!(succeeded(&harness.settled(&parallel).await));
    assert_eq!(harness.calls.started(), vec![root.clone(), other.clone()]);
    harness.calls.gate.add_permits(2);
    assert!(succeeded(&harness.settled(&first).await));
    assert!(succeeded(&harness.settled(&second).await));
    assert_eq!(harness.calls.started(), vec![root.clone(), other, root]);
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
async fn quota_pace_alerts_forward_once_per_connection_and_settle_only_on_relay_result() {
    let mut harness = Harness::new().await;
    harness.ready().await;
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
    events
        .emit(alert("openai", &window("expired"), "will-run-out", 1), None)
        .unwrap();
    events
        .emit(
            alert("openai", &window("b"), "cutting-it-close", future),
            None,
        )
        .unwrap();
    let second = harness
        .relay
        .matching(harness.opening.generation, |frame| {
            quota(frame, &window("b")).is_some()
        })
        .await;
    let pending = quota(&second, &window("b")).unwrap();
    events
        .emit(
            alert("openai", &window("a"), "almost-out", future + 10_000),
            None,
        )
        .unwrap();
    harness
        .send(v5::control::Kind::QuotaPaceResult(v5::QuotaPaceResult {
            quota: sent,
            status: v5::QuotaPaceStatus::Settled as i32,
        }))
        .await;
    events
        .emit(alert("openai", &window("c"), "will-run-out", future), None)
        .unwrap();
    assert_eq!(
        next_quota(&mut harness, &prefix).await,
        window("c"),
        "a pending identity is not offered again"
    );
    harness
        .send(v5::control::Kind::QuotaPaceResult(v5::QuotaPaceResult {
            quota: pending,
            status: v5::QuotaPaceStatus::Pending as i32,
        }))
        .await;
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
