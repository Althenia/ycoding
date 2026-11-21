use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use ycoding_core::platform::{
    browser::{
        admission::Admission,
        boundary::{self, Services},
        bridge::{Bridge, Error, TabState, Transport},
        isolated::{
            ActionOutput, Availability, Executor, ExecutorError, Launch, Options, Runtime, Service,
            Snapshot,
        },
        protocol,
    },
    computer::{
        Future,
        boundary::{Context, Permission, PermissionFailure, Policy, Reservation, Resolved, Review},
        types::Owner,
    },
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, browser, isolated_browser, parse_json,
    session_id::SessionId, stringify_json,
};

fn decode<T: DomainDecode>(value: Value) -> T {
    T::decode(&parse_json(&value.to_string()).unwrap()).unwrap()
}
fn text(value: &ycoding_schema::LosslessString) -> &str {
    value.as_str().unwrap()
}

struct Extension {
    outbox: Mutex<Vec<JsonValue>>,
    notice: tokio::sync::Notify,
}
impl Transport for Extension {
    fn send(&self, message: JsonValue) -> bool {
        self.outbox.lock().unwrap().push(message);
        self.notice.notify_one();
        self.notice.notify_waiters();
        true
    }
    fn close(&self, _code: u16, _reason: &str) {}
}
impl Extension {
    fn sent(&self) -> Vec<Value> {
        self.outbox
            .lock()
            .unwrap()
            .iter()
            .map(|message| serde_json::from_str(&stringify_json(message)).unwrap())
            .collect()
    }
    async fn wait_sent(&self, count: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if self.outbox.lock().unwrap().len() >= count {
                    return;
                }
                self.notice.notified().await;
            }
        })
        .await
        .unwrap();
    }
}

fn receive(bridge: &Bridge, value: Value) {
    bridge
        .receive(protocol::decode_client(value.to_string().as_bytes()).unwrap())
        .unwrap();
}

fn setup(timeout: Duration) -> (Arc<Bridge>, Arc<Extension>) {
    let extension = Arc::new(Extension {
        outbox: Mutex::new(Vec::new()),
        notice: tokio::sync::Notify::new(),
    });
    let bridge = Bridge::new(
        decode(json!(1)),
        SessionId::new("ses_bootstrap").unwrap(),
        extension.clone(),
        Arc::new(Admission::default()),
        Arc::new(|_| true),
        timeout,
    );
    receive(&bridge, json!({"type":"profile_access","enabled":true}));
    receive(
        &bridge,
        json!({"type":"shared","mode":"profile","tabID":"btab_test","title":"Fixture","url":"https://example.test/form","documentGeneration":1,"active":true}),
    );
    (bridge, extension)
}

async fn observe_with(
    bridge: &Arc<Bridge>,
    extension: &Arc<Extension>,
    call: &str,
    diff: Option<bool>,
    revision: u64,
    elements: Value,
) -> browser::Observation {
    let sent = extension.sent().len() + 1;
    let task = tokio::spawn({
        let bridge = bridge.clone();
        let mut raw = json!({"sessionID":"ses_a","tabID":"btab_test","generation":1,"callID":call});
        if let Some(diff) = diff {
            raw["diff"] = json!(diff);
        }
        let input: browser::ObserveInput = decode(raw);
        async move { bridge.observe(input).await }
    });
    extension.wait_sent(sent).await;
    receive(
        bridge,
        json!({"type":"observation","callID":call,"tabID":"btab_test","generation":1,"documentGeneration":1,"revision":revision,"title":"Fixture","url":"https://example.test/form","elements":elements,"truncated":false}),
    );
    task.await.unwrap().unwrap()
}

fn action_input(call: &str, revision: u64, action: Value) -> browser::ActionInput {
    decode(
        json!({"sessionID":"ses_a","tabID":"btab_test","generation":1,"documentGeneration":1,"observationRevision":revision,"callID":call,"action":action}),
    )
}

#[tokio::test]
async fn u6_observation_carries_control_state_and_withholds_sensitive_values() {
    let (bridge, extension) = setup(Duration::from_secs(1));
    let observation = observe_with(
        &bridge,
        &extension,
        "observe",
        None,
        1,
        json!([
            {"ref":"b1","role":"checkbox","name":"Agree","checked":"mixed","pressed":true,"expanded":false,"selected":true,"locator":"role=checkbox[name=\"Agree\"]"},
            {"ref":"b2","role":"textbox","name":"Password","value":"hunter2","sensitive":true,"locator":"role=textbox[name=\"Password\"]"},
            {"ref":"b3","role":"textbox","name":"City","value":"Lisbon","locator":"role=textbox[name=\"City\"]"}
        ]),
    )
    .await;
    let agree = &observation.elements[0];
    assert_eq!(agree.checked, Some(browser::Tristate::Mixed));
    assert_eq!(agree.pressed, Some(browser::Tristate::Boolean(true)));
    assert_eq!(agree.expanded, Some(false));
    assert_eq!(agree.selected, Some(true));
    assert_eq!(
        agree.locator.as_ref().map(text),
        Some("role=checkbox[name=\"Agree\"]")
    );
    let password = &observation.elements[1];
    assert_eq!(password.sensitive, Some(true));
    assert_eq!(password.value, None);
    assert!(!stringify_json(&observation.encode()).contains("hunter2"));
    assert_eq!(
        observation.elements[2].value.as_ref().map(text),
        Some("Lisbon")
    );
}

#[tokio::test]
async fn u6_diff_observation_returns_changed_elements_and_removed_locators() {
    let (bridge, extension) = setup(Duration::from_secs(1));
    let first = observe_with(
        &bridge,
        &extension,
        "first",
        Some(true),
        1,
        json!([
            {"ref":"b1","role":"button","name":"Keep","locator":"role=button[name=\"Keep\"]"},
            {"ref":"b2","role":"checkbox","name":"Toggle","checked":false,"locator":"role=checkbox[name=\"Toggle\"]"},
            {"ref":"b3","role":"button","name":"Gone","locator":"role=button[name=\"Gone\"]"}
        ]),
    )
    .await;
    assert_eq!(first.elements.len(), 3);
    assert_eq!(first.delta, None);
    let second = observe_with(
        &bridge,
        &extension,
        "second",
        Some(true),
        2,
        json!([
            {"ref":"b1","role":"button","name":"Keep","locator":"role=button[name=\"Keep\"]"},
            {"ref":"b2","role":"checkbox","name":"Toggle","checked":true,"locator":"role=checkbox[name=\"Toggle\"]"},
            {"ref":"b3","role":"button","name":"New","locator":"role=button[name=\"New\"]"}
        ]),
    )
    .await;
    assert_eq!(
        second
            .elements
            .iter()
            .map(|element| text(&element.name))
            .collect::<Vec<_>>(),
        ["Toggle", "New"]
    );
    let delta = second.delta.unwrap();
    assert_eq!(delta.base_revision.get(), 1);
    assert_eq!(
        delta.removed.iter().map(text).collect::<Vec<_>>(),
        ["role=button[name=\"Gone\"]"]
    );
    let full = observe_with(
        &bridge,
        &extension,
        "third",
        None,
        3,
        json!([{"ref":"b1","role":"button","name":"Keep","locator":"role=button[name=\"Keep\"]"}]),
    )
    .await;
    assert_eq!(full.delta, None);
    assert_eq!(full.elements.len(), 1);
}

#[tokio::test]
async fn u6_locator_actions_resolve_to_refs_and_malformed_locators_never_dispatch() {
    let (bridge, extension) = setup(Duration::from_secs(1));
    observe_with(
        &bridge,
        &extension,
        "observe",
        None,
        1,
        json!([{"ref":"b7","role":"textbox","name":"Email","locator":"role=textbox[name=\"Email\"]"}]),
    )
    .await;
    let malformed = action_input(
        "bad",
        1,
        json!({"type":"fill","locator":"textbox Email","text":"a@b.test"}),
    );
    assert_eq!(
        bridge.action(malformed).await,
        Err(Error::Fence("Locator is malformed".into()))
    );
    let stale = action_input(
        "stale",
        1,
        json!({"type":"fill","locator":"role=textbox[name=\"Missing\"]","text":"a@b.test"}),
    );
    assert_eq!(
        bridge.action(stale).await,
        Err(Error::Fence("Semantic element reference is stale".into()))
    );
    assert_eq!(extension.sent().len(), 1);
    let task = tokio::spawn({
        let bridge = bridge.clone();
        let input = action_input(
            "fill",
            1,
            json!({"type":"fill","locator":"role=textbox[name=\"Email\"]","text":"a@b.test"}),
        );
        async move { bridge.action(input).await }
    });
    extension.wait_sent(2).await;
    let sent = extension.sent();
    assert_eq!(sent[1]["action"]["ref"], "b7");
    assert!(sent[1]["action"].get("locator").is_none());
    receive(
        &bridge,
        json!({"type":"result","callID":"fill","tabID":"btab_test","generation":1,"documentGeneration":1,"observationRevision":1,"status":"completed","title":"Fixture","url":"https://example.test/form","control":{"value":"a@b.test"},"dialog":{"kind":"prompt","message":"Name?","defaultPrompt":"Ada"},"frame":"https://child.test/widget"}),
    );
    let result = task.await.unwrap().unwrap();
    assert_eq!(
        result.control.unwrap().value.as_ref().map(text),
        Some("a@b.test")
    );
    let dialog = result.dialog.unwrap();
    assert_eq!(dialog.kind, browser::DialogKind::Prompt);
    assert_eq!(text(&dialog.message), "Name?");
    assert_eq!(dialog.default_prompt.as_ref().map(text), Some("Ada"));
    assert_eq!(
        result.frame.unwrap().origin.as_str(),
        Some("https://child.test")
    );
}

#[tokio::test]
async fn u6_sensitive_control_results_carry_no_value() {
    let (bridge, extension) = setup(Duration::from_secs(1));
    observe_with(
        &bridge,
        &extension,
        "observe",
        None,
        1,
        json!([{"ref":"b1","role":"textbox","name":"Code","sensitive":true}]),
    )
    .await;
    let task = tokio::spawn({
        let bridge = bridge.clone();
        let input = action_input("hover", 1, json!({"type":"hover","ref":"b1"}));
        async move { bridge.action(input).await }
    });
    extension.wait_sent(2).await;
    receive(
        &bridge,
        json!({"type":"result","callID":"hover","tabID":"btab_test","generation":1,"documentGeneration":1,"observationRevision":1,"status":"completed","title":"Fixture","url":"https://example.test/form","control":{"value":"123456","checked":true,"sensitive":true}}),
    );
    let control = task.await.unwrap().unwrap().control.unwrap();
    assert_eq!(control.sensitive, Some(true));
    assert_eq!(control.value, None);
    assert_eq!(control.checked, None);
}

#[tokio::test]
async fn u6_wait_uses_its_budget_beyond_the_command_timeout_and_dialog_is_a_mutation() {
    let (bridge, extension) = setup(Duration::from_millis(60));
    observe_with(&bridge, &extension, "observe", None, 1, json!([])).await;
    let task = tokio::spawn({
        let bridge = bridge.clone();
        let input = action_input(
            "wait",
            1,
            json!({"type":"wait","text":"Ready","timeoutMs":5000}),
        );
        async move { bridge.action(input).await }
    });
    extension.wait_sent(2).await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    receive(
        &bridge,
        json!({"type":"result","callID":"wait","tabID":"btab_test","generation":1,"documentGeneration":1,"observationRevision":1,"status":"completed","title":"Fixture","url":"https://example.test/form"}),
    );
    assert_eq!(
        task.await.unwrap().unwrap().status,
        browser::ResultStatus::Completed
    );
    let dialog = action_input("dialog", 1, json!({"type":"dialog","accept":true}));
    assert_eq!(
        bridge.action(dialog).await.unwrap().status,
        browser::ResultStatus::Uncertain
    );
}

#[tokio::test]
async fn u6_deliver_marks_only_owned_tabs() {
    let (bridge, extension) = setup(Duration::from_secs(1));
    let profile: browser::CloseInput = decode(
        json!({"sessionID":"ses_a","tabID":"btab_test","generation":1,"callID":"deliver-profile"}),
    );
    assert_eq!(
        bridge.deliver(profile),
        Err(Error::Ownership(
            "Only agent-created tabs can be marked deliverable".into()
        ))
    );
    let opening = tokio::spawn({
        let bridge = bridge.clone();
        async move {
            bridge
                .open(decode(
                    json!({"sessionID":"ses_a","generation":1,"callID":"open","url":"https://example.test/report"}),
                ))
                .await
        }
    });
    extension.wait_sent(1).await;
    let command = extension.sent()[0].clone();
    receive(
        &bridge,
        json!({"type":"opened","callID":"open","tabID":command["tabID"],"generation":1,"documentGeneration":1,"title":"Report","url":"https://example.test/report","active":false}),
    );
    let tab = opening.await.unwrap().unwrap();
    assert_eq!(tab.deliverable, None);
    let delivered = bridge
        .deliver(decode(json!({"sessionID":"ses_a","tabID":stringify_json(&tab.id.encode()).trim_matches('"'),"generation":1,"callID":"deliver"})))
        .unwrap();
    assert_eq!(delivered.deliverable, Some(true));
    assert!(
        extension
            .sent()
            .iter()
            .any(|message| message["type"] == "deliver")
    );
    assert_eq!(
        bridge
            .list(&SessionId::new("ses_a").unwrap())
            .unwrap()
            .into_iter()
            .find(|listed| listed.id == tab.id)
            .unwrap()
            .deliverable,
        Some(true)
    );
}

#[tokio::test]
async fn u6_departed_tabs_report_reason_and_successor() {
    let (bridge, _extension) = setup(Duration::from_secs(1));
    let session = SessionId::new("ses_a").unwrap();
    let id = decode(json!("btab_test"));
    assert!(matches!(
        bridge.tab_state(&session, &id).unwrap(),
        TabState::Present {
            mode: browser::Mode::Profile
        }
    ));
    receive(
        &bridge,
        json!({"type":"revoked","tabID":"btab_test","reason":"replaced"}),
    );
    receive(
        &bridge,
        json!({"type":"shared","mode":"profile","tabID":"btab_next","title":"Fixture","url":"https://example.test/form","documentGeneration":2,"active":true,"replaces":"btab_test"}),
    );
    match bridge.tab_state(&session, &id).unwrap() {
        TabState::Departed {
            mode,
            reason,
            successor,
            ..
        } => {
            assert_eq!(mode, browser::Mode::Profile);
            assert_eq!(reason.as_deref(), Some("replaced"));
            assert_eq!(
                successor.as_ref().map(|id| stringify_json(&id.encode())),
                Some("\"btab_next\"".into())
            );
        }
        other => panic!("expected departed, got {other:?}"),
    }
    assert!(matches!(
        bridge
            .tab_state(&session, &decode(json!("btab_foreign")))
            .unwrap(),
        TabState::Unknown
    ));
}

struct AllowPolicy {
    calls: Arc<Mutex<Vec<String>>>,
}
struct HeldReservation;
impl Reservation for HeldReservation {
    fn release(&self) {}
}
impl Policy for AllowPolicy {
    fn permission<'a>(
        &'a self,
        _context: &'a Context,
        request: Permission,
    ) -> Future<'a, Result<(), PermissionFailure>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(request.action);
            Ok(())
        })
    }
    fn review<'a>(
        &'a self,
        _context: &'a Context,
        _request: Review,
    ) -> Future<'a, Result<Box<dyn Reservation>, String>> {
        Box::pin(async { Ok(Box::new(HeldReservation) as Box<dyn Reservation>) })
    }
    fn resolve<'a>(
        &'a self,
        _path: &'a str,
        _directory: bool,
    ) -> Future<'a, Result<Resolved, String>> {
        Box::pin(async { Err("Unexpected filesystem resolution".into()) })
    }
}

fn boundary_context(call: &str) -> Context {
    Context {
        owner: Owner {
            session_id: "ses_a".into(),
            call_id: call.into(),
        },
        message_id: "ams_message".into(),
        agent: "god".into(),
    }
}

#[tokio::test]
async fn u6_boundary_decodes_diff_and_deliver_and_reports_departed_tabs() {
    let (bridge, extension) = setup(Duration::from_secs(1));
    let policy = AllowPolicy {
        calls: Arc::new(Mutex::new(Vec::new())),
    };
    let input = boundary::decode_input(
        &parse_json(
            &json!({"operation":"observe","mode":"profile","tabID":"btab_test","generation":1,"diff":true})
                .to_string(),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(matches!(
        input.operation,
        boundary::Operation::Observe {
            diff: Some(true),
            ..
        }
    ));
    let paired: Arc<dyn boundary::Paired> = Arc::new(bridge.clone());
    let running = tokio::spawn({
        let context = boundary_context("observe");
        async move {
            boundary::execute(
                Services {
                    paired: &*paired,
                    isolated: None,
                },
                &policy,
                &context,
                input,
            )
            .await
        }
    });
    extension.wait_sent(1).await;
    receive(
        &bridge,
        json!({"type":"observation","callID":"observe","tabID":"btab_test","generation":1,"documentGeneration":1,"revision":1,"title":"Fixture","url":"https://example.test/form","elements":[],"truncated":false}),
    );
    running.await.unwrap().unwrap();
    let deliver = boundary::decode_input(
        &parse_json(
            &json!({"operation":"deliver","mode":"owned","tabID":"btab_test","generation":1})
                .to_string(),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(matches!(
        deliver.operation,
        boundary::Operation::Deliver { .. }
    ));
    receive(
        &bridge,
        json!({"type":"revoked","tabID":"btab_test","reason":"closed"}),
    );
    let policy = AllowPolicy {
        calls: Arc::new(Mutex::new(Vec::new())),
    };
    let paired: Arc<dyn boundary::Paired> = Arc::new(bridge.clone());
    let error = boundary::execute(
        Services {
            paired: &*paired,
            isolated: None,
        },
        &policy,
        &boundary_context("gone"),
        boundary::decode_input(
            &parse_json(
                &json!({"operation":"observe","mode":"profile","tabID":"btab_test","generation":1})
                    .to_string(),
            )
            .unwrap(),
        )
        .unwrap(),
    )
    .await
    .unwrap_err();
    assert_eq!(
        error,
        "Chrome tab btab_test is no longer listed: the tab was closed. List tabs again to find it."
    );
    let foreign = boundary::execute(
        Services {
            paired: &*paired,
            isolated: None,
        },
        &policy,
        &boundary_context("foreign"),
        boundary::decode_input(
            &parse_json(
                &json!({"operation":"observe","mode":"profile","tabID":"btab_foreign","generation":1})
                    .to_string(),
            )
            .unwrap(),
        )
        .unwrap(),
    )
    .await
    .unwrap_err();
    assert_eq!(
        foreign,
        "Chrome tab btab_foreign is not listed by the current browser connection; list tabs again"
    );
}

struct FakeRuntime {
    actions: AtomicUsize,
    received: Mutex<Vec<Value>>,
    elements: Mutex<Vec<Value>>,
    delay: Duration,
    closed: tokio::sync::watch::Sender<bool>,
}
impl FakeRuntime {
    fn snapshot(&self, revision: u64) -> Snapshot {
        Snapshot {
            title: "Fixture".into(),
            url: "https://example.test/form".into(),
            document_generation: decode(json!(1)),
            revision: decode(json!(revision)),
            elements: self
                .elements
                .lock()
                .unwrap()
                .iter()
                .cloned()
                .map(decode)
                .collect(),
            texts: None,
            frames: None,
            truncated: false,
        }
    }
}
impl Runtime for FakeRuntime {
    fn observe(&self) -> Future<'_, Result<Snapshot, ExecutorError>> {
        Box::pin(async move { Ok(self.snapshot(2)) })
    }
    fn action<'a>(
        &'a self,
        action: browser::Action,
        _origins: Vec<String>,
        _cancel: tokio::sync::watch::Receiver<bool>,
    ) -> Future<'a, Result<ActionOutput, ExecutorError>> {
        Box::pin(async move {
            self.actions.fetch_add(1, Ordering::Relaxed);
            self.received
                .lock()
                .unwrap()
                .push(serde_json::from_str(&stringify_json(&action.encode())).unwrap());
            if !self.delay.is_zero() {
                tokio::time::sleep(self.delay).await;
            }
            let mut snapshot = self.snapshot(0);
            snapshot.elements.clear();
            Ok(ActionOutput {
                snapshot,
                capture: None,
                rejected: None,
                text: None,
                data: None,
                logs: None,
                webmcp_tools: None,
                dialog: Some(decode(json!({"kind":"alert","message":"Saved"}))),
                control: Some(decode(json!({"value":"filled"}))),
                frame: None,
                message: None,
            })
        })
    }
    fn pause(&self) -> Future<'_, Result<(), ExecutorError>> {
        Box::pin(async { Ok(()) })
    }
    fn resume(&self) -> Future<'_, Result<(), ExecutorError>> {
        Box::pin(async { Ok(()) })
    }
    fn close(&self) -> Future<'_, Result<(), ExecutorError>> {
        Box::pin(async move {
            self.closed.send_replace(true);
            Ok(())
        })
    }
    fn closed(&self) -> Future<'_, ()> {
        Box::pin(async move {
            let mut closed = self.closed.subscribe();
            let _ = closed.wait_for(|value| *value).await;
        })
    }
}
struct FakeFactory(Arc<FakeRuntime>);
impl Executor for FakeFactory {
    fn availability(&self) -> Future<'_, Availability> {
        Box::pin(async {
            Availability {
                available: true,
                reason: None,
            }
        })
    }
    fn launch(
        &self,
        _input: Launch,
        _cancel: tokio::sync::watch::Receiver<bool>,
    ) -> Future<'_, Result<Arc<dyn Runtime>, ExecutorError>> {
        Box::pin(async move { Ok(self.0.clone() as Arc<dyn Runtime>) })
    }
}

async fn isolated_setup(
    elements: Vec<Value>,
    delay: Duration,
) -> (Arc<Service>, Arc<FakeRuntime>, isolated_browser::Status) {
    let runtime = Arc::new(FakeRuntime {
        actions: AtomicUsize::new(0),
        received: Mutex::new(Vec::new()),
        elements: Mutex::new(elements),
        delay,
        closed: tokio::sync::watch::channel(false).0,
    });
    let service = Service::new(
        Arc::new(FakeFactory(runtime.clone())),
        Arc::new(Admission::default()),
        Arc::new(|_| true),
        Options {
            operation_timeout: Duration::from_millis(100),
            settlement_limit: 16,
            export_directory: None,
        },
    );
    let status = service
        .start(
            &SessionId::new("ses_a").unwrap(),
            decode(json!({"url":"https://example.test/form"})),
        )
        .await
        .unwrap();
    (service, runtime, status)
}

fn isolated_input(
    status: &isolated_browser::Status,
    call: &str,
    revision: u64,
    action: Value,
) -> isolated_browser::ActionInput {
    let tab = status.tab.as_ref().unwrap();
    isolated_browser::ActionInput {
        session_id: SessionId::new("ses_a").unwrap(),
        instance_id: status.instance_id.clone().unwrap(),
        tab_id: tab.id.clone(),
        generation: tab.generation,
        document_generation: tab.document_generation,
        observation_revision: decode(json!(revision)),
        call_id: decode(json!(call)),
        action: decode(action),
    }
}

#[tokio::test]
async fn u6_isolated_diff_and_locator_resolution_carry_control_state() {
    let initial = vec![
        json!({"ref":"b1","role":"textbox","name":"Email","locator":"role=textbox[name=\"Email\"]"}),
        json!({"ref":"b2","role":"button","name":"Gone","locator":"role=button[name=\"Gone\"]"}),
    ];
    let (service, runtime, status) = isolated_setup(initial, Duration::ZERO).await;
    *runtime.elements.lock().unwrap() = vec![
        json!({"ref":"b1","role":"textbox","name":"Email","value":"a@b.test","locator":"role=textbox[name=\"Email\"]"}),
        json!({"ref":"b2","role":"button","name":"New","locator":"role=button[name=\"New\"]"}),
    ];
    let tab = status.tab.as_ref().unwrap();
    let observation = service
        .observe(isolated_browser::ObserveInput {
            session_id: SessionId::new("ses_a").unwrap(),
            instance_id: status.instance_id.clone().unwrap(),
            tab_id: tab.id.clone(),
            generation: tab.generation,
            call_id: decode(json!("observe")),
            diff: Some(true),
        })
        .await
        .unwrap();
    assert_eq!(
        observation
            .elements
            .iter()
            .map(|element| text(&element.name))
            .collect::<Vec<_>>(),
        ["Email", "New"]
    );
    let delta = observation.delta.unwrap();
    assert_eq!(delta.base_revision.get(), 2);
    assert_eq!(
        delta.removed.iter().map(text).collect::<Vec<_>>(),
        ["role=button[name=\"Gone\"]"]
    );
    let malformed = isolated_input(
        &status,
        "bad",
        2,
        json!({"type":"fill","locator":"Email","text":"x"}),
    );
    assert!(service.action(malformed).await.is_err());
    assert_eq!(runtime.actions.load(Ordering::Relaxed), 0);
    let result = service
        .action(isolated_input(
            &status,
            "fill",
            2,
            json!({"type":"fill","locator":"role=textbox[name=\"Email\"]","text":"filled"}),
        ))
        .await
        .unwrap();
    assert_eq!(runtime.received.lock().unwrap()[0]["ref"], "b1");
    assert_eq!(
        result.control.unwrap().value.as_ref().map(text),
        Some("filled")
    );
    assert_eq!(result.dialog.unwrap().kind, browser::DialogKind::Alert);
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn u6_isolated_wait_budget_extends_the_action_deadline() {
    let (service, runtime, status) = isolated_setup(vec![], Duration::from_millis(300)).await;
    let result = service
        .action(isolated_input(
            &status,
            "wait",
            2,
            json!({"type":"wait","load":"load","timeoutMs":5000}),
        ))
        .await
        .unwrap();
    assert_eq!(result.status, isolated_browser::ActionStatus::Completed);
    assert_eq!(runtime.actions.load(Ordering::Relaxed), 1);
    service.shutdown().await.unwrap();
}
