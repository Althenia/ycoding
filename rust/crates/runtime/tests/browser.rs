mod support;

use prost::{Message, Name};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use support::*;
use tokio::sync::{mpsc, watch};
use ycoding_core::{
    platform::{
        browser::{admission::Admission, bridge::Transport, isolated, protocol, service},
        computer::Future,
    },
    resources::credential,
    ycoding_schema::{
        DomainDecode, JsonPath, JsonValue, LosslessString, ObjectDecoder, ObjectEncoder, browser,
        parse_json, session_id::SessionId, stringify_json,
    },
};
use ycoding_protocol::{connection::Outcome, v5};
use ycoding_runtime::{LocalAuth, standard};

const OWNER: &str = "ses_get";
const OTHER: &str = "ses_other";
const EXTENSION: &str = "abcdefghijklmnopabcdefghijklmnop";

fn decode<T: DomainDecode>(value: &str) -> T {
    T::decode(&parse_json(value).unwrap()).unwrap()
}

fn frame(value: JsonValue) -> protocol::ClientMessage {
    protocol::decode_client(stringify_json(&value).as_bytes()).unwrap()
}

fn error<T: Message + Default + Name>(outcome: Outcome) -> T {
    let payload = rejected(outcome);
    assert_eq!(payload.type_name, T::full_name());
    ycoding_protocol::decode_strict(&payload.payload).unwrap()
}

async fn call<T: Message>(client: &mut Client, name: &str, id: &str, request: T) -> Outcome {
    tokio::time::timeout(
        WAIT,
        client.call(name, session_scope(id), request.encode_to_vec()),
    )
    .await
    .expect("browser operation timed out")
}

struct Extension {
    sender: mpsc::Sender<JsonValue>,
    sent: AtomicUsize,
    fault: AtomicUsize,
}

impl Transport for Extension {
    fn send(&self, value: JsonValue) -> bool {
        self.sent.fetch_add(1, Ordering::SeqCst);
        self.sender.try_send(value).is_ok()
    }
    fn close(&self, _code: u16, _reason: &str) {}
}

async fn script(
    bridge: Arc<ycoding_core::platform::browser::bridge::Bridge>,
    extension: Arc<Extension>,
    mut frames: mpsc::Receiver<JsonValue>,
    mut stop: watch::Receiver<bool>,
) {
    loop {
        let message = tokio::select! {
            _ = stop.changed() => return,
            value = frames.recv() => match value { Some(value) => value, None => return },
        };
        let path = JsonPath::default();
        let object = ObjectDecoder::new(&message, &path).unwrap();
        let kind: LosslessString = object.field("type").unwrap();
        if kind.as_str() == Some("control") {
            let action: LosslessString = object.field("action").unwrap();
            assert!(matches!(
                action.as_str(),
                Some("pause" | "resume" | "stop" | "forget")
            ));
            continue;
        }
        if kind.as_str() == Some("paired") {
            continue;
        }
        let call: LosslessString = object.field("callID").unwrap();
        let tab: LosslessString = object.field("tabID").unwrap();
        let generation: JsonValue = object.field("generation").unwrap();
        let reply = ObjectEncoder::new()
            .field("callID", &call)
            .field("tabID", &tab)
            .field("generation", &generation);
        let reply = match kind.as_str().unwrap() {
            "observe" => reply.field("type", &LosslessString::from("observation"))
                .field("documentGeneration", &JsonValue::Number(1.))
                .field("revision", &JsonValue::Number(1.))
                .field("title", &LosslessString::from_utf16(vec![0xd800]))
                .field("url", &LosslessString::from("https://example.test/form?private=query#fragment"))
                .field("elements", &decode::<JsonValue>(r#"[{"ref":"b1","role":"link","name":"Go","destination":"https://other.test/next?private=query","disabled":false,"description":"Go next"}]"#))
                .field("truncated", &false).finish(),
            "open" => reply.field("type", &LosslessString::from("opened"))
                .field("documentGeneration", &JsonValue::Number(1.))
                .field("title", &LosslessString::from("Owned"))
                .field("url", &LosslessString::from("https://example.test/owned?private=query"))
                .field("active", &false).finish(),
            "close" => reply.field("type", &LosslessString::from("closed")).finish(),
            "relinquish" => reply.field("type", &LosslessString::from("relinquished")).finish(),
            "action" if extension.fault.load(Ordering::SeqCst) != 0 => reply
                .field("type", &LosslessString::from("error"))
                .field("dispatched", &(extension.fault.load(Ordering::SeqCst) == 2))
                .field("message", &LosslessString::from("Scripted failure")).finish(),
            "action" => reply.field("type", &LosslessString::from("result"))
                .field("documentGeneration", &JsonValue::Number(1.))
                .field("observationRevision", &JsonValue::Number(1.))
                .field("status", &LosslessString::from("completed"))
                .field("title", &LosslessString::from("Fixture"))
                .field("url", &LosslessString::from("https://example.test/form?private=query"))
                .field("groupID", &JsonValue::Number(17.))
                .field("capture", &decode::<JsonValue>(r#"{"mediaType":"image/png","data":"iVBORw==","bytes":4}"#)).finish(),
            other => panic!("unexpected extension command {other}"),
        };
        bridge.receive(frame(reply)).unwrap();
    }
}

struct Native {
    actions: AtomicUsize,
    launches: AtomicUsize,
    closes: AtomicUsize,
    fault: AtomicUsize,
    available: std::sync::atomic::AtomicBool,
    closed: watch::Sender<bool>,
    inputs: Mutex<Vec<browser::Action>>,
}

fn snapshot() -> isolated::Snapshot {
    isolated::Snapshot {
        title: LosslessString::from_utf16(vec![0xd800]),
        url: "https://example.test/form?private=query#fragment".into(),
        document_generation: decode("1"),
        revision: decode("1"),
        elements: vec![decode(
            r#"{"ref":"b1","role":"button","name":"Submit","description":"Submit form","disabled":false,"destination":{"origin":"https://other.test","path":"/next"}}"#,
        )],
        truncated: false,
    }
}

struct Factory(Arc<Native>);
impl isolated::Executor for Factory {
    fn availability(&self) -> Future<'_, isolated::Availability> {
        Box::pin(async move {
            isolated::Availability {
                available: self.0.available.load(Ordering::SeqCst),
                reason: (!self.0.available.load(Ordering::SeqCst))
                    .then(|| "Scripted Chrome unavailable".into()),
            }
        })
    }
    fn launch(
        &self,
        _input: isolated::Launch,
        _cancel: watch::Receiver<bool>,
    ) -> Future<'_, Result<Arc<dyn isolated::Runtime>, isolated::ExecutorError>> {
        Box::pin(async move {
            self.0.launches.fetch_add(1, Ordering::SeqCst);
            self.0.closed.send_replace(false);
            Ok(self.0.clone() as Arc<dyn isolated::Runtime>)
        })
    }
}

impl isolated::Runtime for Native {
    fn observe(&self) -> Future<'_, Result<isolated::Snapshot, isolated::ExecutorError>> {
        Box::pin(async { Ok(snapshot()) })
    }
    fn action(
        &self,
        action: browser::Action,
        _origins: Vec<String>,
        _cancel: watch::Receiver<bool>,
    ) -> Future<'_, Result<isolated::ActionOutput, isolated::ExecutorError>> {
        Box::pin(async move {
            self.actions.fetch_add(1, Ordering::SeqCst);
            self.inputs.lock().unwrap().push(action);
            match self.fault.load(Ordering::SeqCst) {
                1 | 2 => Err(isolated::ExecutorError {
                    message: "Scripted failure".into(),
                    phase: if self.fault.load(Ordering::SeqCst) == 1 {
                        isolated::Phase::Predispatch
                    } else {
                        isolated::Phase::Postdispatch
                    },
                }),
                _ => Ok(isolated::ActionOutput {
                    snapshot: snapshot(),
                    rejected: None,
                    capture: Some(decode(
                        r#"{"mediaType":"image/png","data":"iVBORw==","bytes":4}"#,
                    )),
                }),
            }
        })
    }
    fn pause(&self) -> Future<'_, Result<(), isolated::ExecutorError>> {
        Box::pin(async { Ok(()) })
    }
    fn resume(&self) -> Future<'_, Result<(), isolated::ExecutorError>> {
        Box::pin(async { Ok(()) })
    }
    fn close(&self) -> Future<'_, Result<(), isolated::ExecutorError>> {
        Box::pin(async move {
            self.closes.fetch_add(1, Ordering::SeqCst);
            self.closed.send_replace(true);
            Ok(())
        })
    }
    fn closed(&self) -> Future<'_, ()> {
        Box::pin(async move {
            let mut closed = self.closed.subscribe();
            closed.wait_for(|value| *value).await.unwrap();
        })
    }
}

fn click(call: &str) -> v5::BrowserActionRequestPayload {
    v5::BrowserActionRequestPayload {
        tab_id: text("btab_profile"),
        generation: 1,
        document_generation: 1,
        observation_revision: 1,
        call_id: text(call),
        action: v5::BrowserActionRequestPayloadAction {
            kind: Some(v5::browser_action_request_payload_action::Kind::Value2(
                v5::BrowserActionRequestPayloadActionValue2 {
                    r#type: 1,
                    r#ref: text("b1"),
                },
            )),
        },
    }
}

fn isolated_click(
    status: &v5::IsolatedBrowserStatus,
    call: &str,
) -> v5::IsolatedBrowserActionRequestPayload {
    let tab = status.tab.as_ref().unwrap();
    v5::IsolatedBrowserActionRequestPayload {
        tab_id: tab.id.clone(),
        instance_id: status.instance_id.clone().unwrap(),
        generation: tab.generation,
        document_generation: tab.document_generation,
        observation_revision: tab.observation_revision,
        call_id: text(call),
        action: v5::IsolatedBrowserActionRequestPayloadAction {
            kind: Some(
                v5::isolated_browser_action_request_payload_action::Kind::Value2(
                    v5::IsolatedBrowserActionRequestPayloadActionValue2 {
                        r#type: 1,
                        r#ref: text("b1"),
                    },
                ),
            ),
        },
    }
}

async fn observed(client: &mut Client, id: &str, call_id: &str) -> v5::BrowserObservation {
    success::<v5::BrowserObserveResult>(
        call(
            client,
            "browser.observe",
            id,
            v5::BrowserObserveRequest {
                params: v5::BrowserObserveRequestParams {
                    session_id: text(id),
                },
                payload: v5::BrowserObserveRequestPayload {
                    tab_id: text("btab_profile"),
                    generation: 1,
                    call_id: text(call_id),
                },
            },
        )
        .await,
    )
    .data
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn browser_wire_flows_preserve_ownership_fences_settlement_and_lifecycle() {
    let admission = Arc::new(Admission::default());
    let credentials = credential::Service::new(world().store.clone());
    let sessions = world().core.sessions.clone();
    let check: ycoding_core::platform::browser::bridge::SessionCheck = Arc::new(move |id| {
        sessions
            .get(id)
            .ok()
            .flatten()
            .is_some_and(|info| info.time.archived.is_none())
    });
    let paired = service::Service::new(
        credentials.clone(),
        admission.clone(),
        check.clone(),
        service::Options {
            pairing_ttl: Duration::from_secs(120),
            command_timeout: WAIT,
        },
    );
    let native = Arc::new(Native {
        actions: AtomicUsize::new(0),
        launches: AtomicUsize::new(0),
        closes: AtomicUsize::new(0),
        fault: AtomicUsize::new(0),
        available: std::sync::atomic::AtomicBool::new(true),
        closed: watch::channel(false).0,
        inputs: Mutex::new(vec![]),
    });
    let isolated = isolated::Service::new(
        Arc::new(Factory(native.clone())),
        admission.clone(),
        check,
        isolated::Options::default(),
    );
    let resolved = Arc::new(Mutex::new(Vec::new()));
    let mut services = services(LocalAuth::disabled(), true);
    let core = services.core.as_mut().unwrap();
    core.browser = Some(paired.clone());
    core.isolated_browser = Some(Arc::new({
        let isolated = isolated.clone();
        let resolved = resolved.clone();
        move |location| {
            resolved.lock().unwrap().push(location.clone());
            Ok(isolated.clone())
        }
    }));
    let server = start(services, standard().unwrap()).await;
    let mut client = Client::open(server.address(), &[]).await.unwrap();

    let initial: v5::BrowserStatusResult = success(
        call(
            &mut client,
            "browser.status",
            OWNER,
            v5::BrowserStatusRequest {
                params: v5::BrowserStatusRequestParams {
                    session_id: text(OWNER),
                },
            },
        )
        .await,
    );
    assert_eq!(initial.data.state, 1);
    let tabs: v5::BrowserTabsResult = success(
        call(
            &mut client,
            "browser.tabs",
            OWNER,
            v5::BrowserTabsRequest {
                params: v5::BrowserTabsRequestParams {
                    session_id: text(OWNER),
                },
            },
        )
        .await,
    );
    assert!(tabs.data.items.is_empty());
    error::<v5::SessionNotFoundError>(
        call(
            &mut client,
            "browser.status",
            "ses_missing",
            v5::BrowserStatusRequest {
                params: v5::BrowserStatusRequestParams {
                    session_id: text("ses_missing"),
                },
            },
        )
        .await,
    );
    error::<v5::InvalidRequestError>(
        call(
            &mut client,
            "browser.status",
            OWNER,
            v5::BrowserStatusRequest {
                params: v5::BrowserStatusRequestParams {
                    session_id: text(OTHER),
                },
            },
        )
        .await,
    );

    let pairing: v5::BrowserStartResult = success(
        call(
            &mut client,
            "browser.start",
            OWNER,
            v5::BrowserStartRequest {
                params: v5::BrowserStartRequestParams {
                    session_id: text(OWNER),
                },
            },
        )
        .await,
    );
    assert!(units(&pairing.data.secret).len() >= 32);
    let (sender, frames) = mpsc::channel(32);
    let extension = Arc::new(Extension {
        sender,
        sent: AtomicUsize::new(0),
        fault: AtomicUsize::new(0),
    });
    let attached = paired
        .attach(
            &format!("chrome-extension://{EXTENSION}"),
            frame(
                ObjectEncoder::new()
                    .field("type", &LosslessString::from("pair"))
                    .field("version", &JsonValue::Number(4.))
                    .field("extensionID", &LosslessString::from(EXTENSION))
                    .field("secret", &LosslessString::from(units(&pairing.data.secret)))
                    .finish(),
            ),
            extension.clone(),
        )
        .await
        .unwrap();
    attached
        .receive(frame(decode(r#"{"type":"profile_access","enabled":true}"#)))
        .await
        .unwrap();
    attached.receive(frame(decode(r#"{"type":"shared","mode":"profile","tabID":"btab_profile","title":"Fixture","url":"https://example.test/form?private=query","documentGeneration":1,"active":false}"#))).await.unwrap();
    let (stop, stopped) = watch::channel(false);
    let worker = tokio::spawn(script(
        paired.bridge().unwrap(),
        extension.clone(),
        frames,
        stopped,
    ));

    let observation = observed(&mut client, OWNER, "observe").await;
    assert_eq!(observation.revision, 1);
    assert_eq!(
        ycoding_protocol::decode_lossless(&observation.title, 512).unwrap(),
        vec![0xd800]
    );
    assert_eq!(units(&observation.page.path), "/form");
    assert_eq!(
        units(
            &observation.elements.items[0]
                .destination
                .as_ref()
                .unwrap()
                .path
        ),
        "/next"
    );
    assert_eq!(observation.elements.items[0].disabled, Some(false));
    let tabs: v5::BrowserTabsResult = success(
        call(
            &mut client,
            "browser.tabs",
            OTHER,
            v5::BrowserTabsRequest {
                params: v5::BrowserTabsRequestParams {
                    session_id: text(OTHER),
                },
            },
        )
        .await,
    );
    assert_eq!(tabs.data.items[0].lease, Some(2));
    let count = extension.sent.load(Ordering::SeqCst);
    error::<v5::ForbiddenError>(
        call(
            &mut client,
            "browser.observe",
            OTHER,
            v5::BrowserObserveRequest {
                params: v5::BrowserObserveRequestParams {
                    session_id: text(OTHER),
                },
                payload: v5::BrowserObserveRequestPayload {
                    tab_id: text("btab_profile"),
                    generation: 1,
                    call_id: text("foreign"),
                },
            },
        )
        .await,
    );
    for fence in 0..3 {
        let mut payload = click(&format!("stale-{fence}"));
        match fence {
            0 => payload.generation = 2,
            1 => payload.document_generation = 2,
            _ => payload.observation_revision = 2,
        };
        error::<v5::ConflictError>(
            call(
                &mut client,
                "browser.action",
                OWNER,
                v5::BrowserActionRequest {
                    params: v5::BrowserActionRequestParams {
                        session_id: text(OWNER),
                    },
                    payload,
                },
            )
            .await,
        );
    }
    assert_eq!(extension.sent.load(Ordering::SeqCst), count);
    let request = v5::BrowserActionRequest {
        params: v5::BrowserActionRequestParams {
            session_id: text(OWNER),
        },
        payload: click("click"),
    };
    let result: v5::BrowserActionReply =
        success(call(&mut client, "browser.action", OWNER, request.clone()).await);
    assert_eq!(result.data.status, 1);
    assert_eq!(result.data.group_id, Some(17));
    assert_eq!(result.data.capture.as_ref().unwrap().bytes, 4);
    assert_eq!(result.data.tab.observation_revision, 1);
    let count = extension.sent.load(Ordering::SeqCst);
    let retry: v5::BrowserActionReply =
        success(call(&mut client, "browser.action", OWNER, request.clone()).await);
    assert_eq!(retry, result);
    assert_eq!(extension.sent.load(Ordering::SeqCst), count);
    error::<v5::ConflictError>(
        call(
            &mut client,
            "browser.action",
            OWNER,
            v5::BrowserActionRequest {
                params: v5::BrowserActionRequestParams {
                    session_id: text(OWNER),
                },
                payload: click("invalidated-ref"),
            },
        )
        .await,
    );
    let mut conflict = request;
    conflict.payload.action = v5::BrowserActionRequestPayloadAction {
        kind: Some(v5::browser_action_request_payload_action::Kind::Value4(
            v5::BrowserActionRequestPayloadActionValue4 {
                r#type: 1,
                delta_y: 120,
            },
        )),
    };
    error::<v5::ConflictError>(call(&mut client, "browser.action", OWNER, conflict).await);

    let paused: v5::BrowserControlResult = success(
        call(
            &mut client,
            "browser.control",
            OWNER,
            v5::BrowserControlRequest {
                params: v5::BrowserControlRequestParams {
                    session_id: text(OWNER),
                },
                payload: v5::BrowserControlInput { action: 1 },
            },
        )
        .await,
    );
    assert_eq!(paused.data.state, 4);
    let resumed: v5::BrowserControlResult = success(
        call(
            &mut client,
            "browser.control",
            OWNER,
            v5::BrowserControlRequest {
                params: v5::BrowserControlRequestParams {
                    session_id: text(OWNER),
                },
                payload: v5::BrowserControlInput { action: 2 },
            },
        )
        .await,
    );
    assert_eq!(resumed.data.state, 3);
    success::<v5::BrowserReleaseResult>(
        call(
            &mut client,
            "browser.release",
            OWNER,
            v5::BrowserReleaseRequest {
                params: v5::BrowserReleaseRequestParams {
                    session_id: text(OWNER),
                },
                payload: v5::BrowserReleaseRequestPayload {
                    tab_id: text("btab_profile"),
                    generation: 1,
                    call_id: text("release"),
                },
            },
        )
        .await,
    );
    observed(&mut client, OTHER, "new-owner").await;

    let open = v5::BrowserOpenRequest {
        params: v5::BrowserOpenRequestParams {
            session_id: text(OWNER),
        },
        payload: v5::BrowserOpenRequestPayload {
            generation: 1,
            url: text("https://example.test/owned?private=query"),
            call_id: text("open"),
        },
    };
    let owned: v5::BrowserOpenResult =
        success(call(&mut client, "browser.open", OWNER, open.clone()).await);
    assert_eq!(owned.data.mode, Some(1));
    error::<v5::ConflictError>(call(&mut client, "browser.open", OWNER, open).await);
    error::<v5::ForbiddenError>(
        call(
            &mut client,
            "browser.close",
            OTHER,
            v5::BrowserCloseRequest {
                params: v5::BrowserCloseRequestParams {
                    session_id: text(OTHER),
                },
                payload: v5::BrowserCloseRequestPayload {
                    tab_id: owned.data.id.clone(),
                    generation: 1,
                    call_id: text("foreign-close"),
                },
            },
        )
        .await,
    );
    error::<v5::ForbiddenError>(
        call(
            &mut client,
            "browser.close",
            OTHER,
            v5::BrowserCloseRequest {
                params: v5::BrowserCloseRequestParams {
                    session_id: text(OTHER),
                },
                payload: v5::BrowserCloseRequestPayload {
                    tab_id: text("btab_profile"),
                    generation: 1,
                    call_id: text("personal-close"),
                },
            },
        )
        .await,
    );
    success::<v5::BrowserCloseResult>(
        call(
            &mut client,
            "browser.close",
            OWNER,
            v5::BrowserCloseRequest {
                params: v5::BrowserCloseRequestParams {
                    session_id: text(OWNER),
                },
                payload: v5::BrowserCloseRequestPayload {
                    tab_id: owned.data.id,
                    generation: 1,
                    call_id: text("close"),
                },
            },
        )
        .await,
    );

    for (fault, status) in [(1, 3), (2, 4)] {
        observed(&mut client, OTHER, &format!("observe-fault-{fault}")).await;
        extension.fault.store(fault, Ordering::SeqCst);
        let request = v5::BrowserActionRequest {
            params: v5::BrowserActionRequestParams {
                session_id: text(OTHER),
            },
            payload: click(&format!("fault-{fault}")),
        };
        let outcome: v5::BrowserActionReply =
            success(call(&mut client, "browser.action", OTHER, request.clone()).await);
        assert_eq!(outcome.data.status, status);
        let retry: v5::BrowserActionReply =
            success(call(&mut client, "browser.action", OTHER, request).await);
        assert_eq!(retry, outcome);
    }
    success::<v5::BrowserStopResult>(
        call(
            &mut client,
            "browser.stop",
            OWNER,
            v5::BrowserStopRequest {
                params: v5::BrowserStopRequestParams {
                    session_id: text(OWNER),
                },
            },
        )
        .await,
    );
    let stopped: v5::BrowserStatusResult = success(
        call(
            &mut client,
            "browser.status",
            OTHER,
            v5::BrowserStatusRequest {
                params: v5::BrowserStatusRequestParams {
                    session_id: text(OTHER),
                },
            },
        )
        .await,
    );
    assert_eq!(stopped.data.state, 1);
    assert_eq!(stopped.data.paired, Some(true));
    success::<v5::BrowserForgetResult>(
        call(
            &mut client,
            "browser.forget",
            OWNER,
            v5::BrowserForgetRequest {
                params: v5::BrowserForgetRequestParams {
                    session_id: text(OWNER),
                },
            },
        )
        .await,
    );
    assert_eq!(
        paired
            .status(&SessionId::new(OWNER).unwrap())
            .unwrap()
            .paired,
        Some(false)
    );
    stop.send_replace(true);
    worker.await.unwrap();

    let ready: v5::IsolatedBrowserStartResult = success(
        call(
            &mut client,
            "isolatedBrowser.start",
            OWNER,
            v5::IsolatedBrowserStartRequest {
                params: v5::IsolatedBrowserStartRequestParams {
                    session_id: text(OWNER),
                },
                payload: v5::IsolatedBrowserStartPayload {
                    url: text("https://example.test/form?private=query"),
                },
            },
        )
        .await,
    );
    assert_eq!(ready.data.state, 3);
    assert_eq!(ready.data.mode, 1);
    assert_eq!(
        resolved.lock().unwrap()[0],
        world()
            .core
            .sessions
            .get(&SessionId::new(OWNER).unwrap())
            .unwrap()
            .unwrap()
            .location
    );
    let status: v5::IsolatedBrowserStatusResult = success(
        call(
            &mut client,
            "isolatedBrowser.status",
            OWNER,
            v5::IsolatedBrowserStatusRequest {
                params: v5::IsolatedBrowserStatusRequestParams {
                    session_id: text(OWNER),
                },
            },
        )
        .await,
    );
    assert_eq!(status.data, ready.data);
    let tabs: v5::IsolatedBrowserTabsResult = success(
        call(
            &mut client,
            "isolatedBrowser.tabs",
            OWNER,
            v5::IsolatedBrowserTabsRequest {
                params: v5::IsolatedBrowserTabsRequestParams {
                    session_id: text(OWNER),
                },
            },
        )
        .await,
    );
    assert_eq!(tabs.data.items.len(), 1);
    error::<v5::ConflictError>(
        call(
            &mut client,
            "isolatedBrowser.start",
            OWNER,
            v5::IsolatedBrowserStartRequest {
                params: v5::IsolatedBrowserStartRequestParams {
                    session_id: text(OWNER),
                },
                payload: v5::IsolatedBrowserStartPayload {
                    url: text("https://example.test/"),
                },
            },
        )
        .await,
    );
    error::<v5::ConflictError>(
        call(
            &mut client,
            "browser.start",
            OWNER,
            v5::BrowserStartRequest {
                params: v5::BrowserStartRequestParams {
                    session_id: text(OWNER),
                },
            },
        )
        .await,
    );
    let foreign = v5::IsolatedBrowserActionRequest {
        params: v5::IsolatedBrowserActionRequestParams {
            session_id: text(OTHER),
        },
        payload: isolated_click(&ready.data, "foreign"),
    };
    error::<v5::ServiceUnavailableError>(
        call(&mut client, "isolatedBrowser.action", OTHER, foreign).await,
    );
    for fence in 0..5 {
        let mut payload = isolated_click(&ready.data, &format!("isolated-stale-{fence}"));
        match fence {
            0 => payload.generation = 2,
            1 => payload.document_generation = 2,
            2 => payload.observation_revision = 0,
            3 => payload.tab_id = text("btab_other"),
            _ => payload.instance_id = text("ibrowser_other"),
        };
        let outcome = call(
            &mut client,
            "isolatedBrowser.action",
            OWNER,
            v5::IsolatedBrowserActionRequest {
                params: v5::IsolatedBrowserActionRequestParams {
                    session_id: text(OWNER),
                },
                payload,
            },
        )
        .await;
        if fence < 3 {
            error::<v5::ConflictError>(outcome);
        } else {
            error::<v5::ForbiddenError>(outcome);
        }
    }
    assert_eq!(native.actions.load(Ordering::SeqCst), 0);
    let isolated_observation: v5::IsolatedBrowserObserveResult = success(
        call(
            &mut client,
            "isolatedBrowser.observe",
            OWNER,
            v5::IsolatedBrowserObserveRequest {
                params: v5::IsolatedBrowserObserveRequestParams {
                    session_id: text(OWNER),
                },
                payload: v5::IsolatedBrowserObserveRequestPayload {
                    instance_id: ready.data.instance_id.clone().unwrap(),
                    tab_id: ready.data.tab.as_ref().unwrap().id.clone(),
                    generation: 1,
                    call_id: text("isolated-observe"),
                },
            },
        )
        .await,
    );
    assert_eq!(isolated_observation.data.mode, 1);
    assert_eq!(
        isolated_observation.data.elements.items[0].disabled,
        Some(false)
    );
    assert_eq!(units(&isolated_observation.data.page.path), "/form");
    let current: v5::IsolatedBrowserStatusResult = success(
        call(
            &mut client,
            "isolatedBrowser.status",
            OWNER,
            v5::IsolatedBrowserStatusRequest {
                params: v5::IsolatedBrowserStatusRequestParams {
                    session_id: text(OWNER),
                },
            },
        )
        .await,
    );
    let request = v5::IsolatedBrowserActionRequest {
        params: v5::IsolatedBrowserActionRequestParams {
            session_id: text(OWNER),
        },
        payload: isolated_click(&current.data, "isolated-click"),
    };
    let result: v5::IsolatedBrowserActionReply = success(
        call(
            &mut client,
            "isolatedBrowser.action",
            OWNER,
            request.clone(),
        )
        .await,
    );
    assert_eq!(result.data.status, 1);
    assert_eq!(result.data.capture.unwrap().bytes, 4);
    success::<v5::IsolatedBrowserActionReply>(
        call(&mut client, "isolatedBrowser.action", OWNER, request).await,
    );
    assert_eq!(native.actions.load(Ordering::SeqCst), 1);
    for (action, state) in [(1, 4), (2, 3)] {
        let controlled: v5::IsolatedBrowserControlResult = success(
            call(
                &mut client,
                "isolatedBrowser.control",
                OWNER,
                v5::IsolatedBrowserControlRequest {
                    params: v5::IsolatedBrowserControlRequestParams {
                        session_id: text(OWNER),
                    },
                    payload: v5::IsolatedBrowserControlInput { action },
                },
            )
            .await,
        );
        assert_eq!(controlled.data.state, state);
        if action == 2 {
            assert_eq!(controlled.data.tab.unwrap().observation_revision, 0);
        }
    }
    success::<v5::IsolatedBrowserStopResult>(
        call(
            &mut client,
            "isolatedBrowser.stop",
            OWNER,
            v5::IsolatedBrowserStopRequest {
                params: v5::IsolatedBrowserStopRequestParams {
                    session_id: text(OWNER),
                },
            },
        )
        .await,
    );
    assert_eq!(native.closes.load(Ordering::SeqCst), 1);
    for (fault, expected) in [(1, 2), (2, 3)] {
        let ready: v5::IsolatedBrowserStartResult = success(
            call(
                &mut client,
                "isolatedBrowser.start",
                OWNER,
                v5::IsolatedBrowserStartRequest {
                    params: v5::IsolatedBrowserStartRequestParams {
                        session_id: text(OWNER),
                    },
                    payload: v5::IsolatedBrowserStartPayload {
                        url: text("https://example.test/form"),
                    },
                },
            )
            .await,
        );
        native.fault.store(fault, Ordering::SeqCst);
        let result: v5::IsolatedBrowserActionReply = success(
            call(
                &mut client,
                "isolatedBrowser.action",
                OWNER,
                v5::IsolatedBrowserActionRequest {
                    params: v5::IsolatedBrowserActionRequestParams {
                        session_id: text(OWNER),
                    },
                    payload: isolated_click(&ready.data, &format!("isolated-fault-{fault}")),
                },
            )
            .await,
        );
        assert_eq!(result.data.status, expected);
        success::<v5::IsolatedBrowserStopResult>(
            call(
                &mut client,
                "isolatedBrowser.stop",
                OWNER,
                v5::IsolatedBrowserStopRequest {
                    params: v5::IsolatedBrowserStopRequestParams {
                        session_id: text(OWNER),
                    },
                },
            )
            .await,
        );
    }
    native.available.store(false, Ordering::SeqCst);
    let unavailable: v5::IsolatedBrowserStatusResult = success(
        call(
            &mut client,
            "isolatedBrowser.status",
            OWNER,
            v5::IsolatedBrowserStatusRequest {
                params: v5::IsolatedBrowserStatusRequestParams {
                    session_id: text(OWNER),
                },
            },
        )
        .await,
    );
    assert_eq!(unavailable.data.state, 1);
    let unavailable = error::<v5::ServiceUnavailableError>(
        call(
            &mut client,
            "isolatedBrowser.start",
            OWNER,
            v5::IsolatedBrowserStartRequest {
                params: v5::IsolatedBrowserStartRequestParams {
                    session_id: text(OWNER),
                },
                payload: v5::IsolatedBrowserStartPayload {
                    url: text("https://example.test/"),
                },
            },
        )
        .await,
    );
    assert_eq!(
        units(unavailable.service.as_ref().unwrap()),
        "isolated-browser"
    );
    assert_eq!(native.launches.load(Ordering::SeqCst), 3);
    isolated.shutdown().await.unwrap();
    paired.shutdown();
    credentials.shutdown().await.unwrap();
    server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn browser_domain_validation_precedes_uncomposed_services() {
    let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
    let mut client = Client::open(server.address(), &[]).await.unwrap();
    for invalid in ["b0", "b10000", "raw-selector"] {
        let mut payload = click("invalid-ref");
        payload.action.kind = Some(v5::browser_action_request_payload_action::Kind::Value2(
            v5::BrowserActionRequestPayloadActionValue2 {
                r#type: 1,
                r#ref: text(invalid),
            },
        ));
        error::<v5::InvalidRequestError>(
            call(
                &mut client,
                "browser.action",
                OWNER,
                v5::BrowserActionRequest {
                    params: v5::BrowserActionRequestParams {
                        session_id: text(OWNER),
                    },
                    payload,
                },
            )
            .await,
        );
    }
    let mut payload = click("invalid-tab");
    payload.tab_id = text("not-a-tab");
    error::<v5::InvalidRequestError>(
        call(
            &mut client,
            "browser.action",
            OWNER,
            v5::BrowserActionRequest {
                params: v5::BrowserActionRequestParams {
                    session_id: text(OWNER),
                },
                payload,
            },
        )
        .await,
    );
    let mut payload = click("utf8-bound");
    payload.action.kind = Some(v5::browser_action_request_payload_action::Kind::Value3(
        v5::BrowserActionRequestPayloadActionValue3 {
            r#type: 1,
            r#ref: text("b1"),
            text: text(&"é".repeat(4097)),
        },
    ));
    error::<v5::InvalidRequestError>(
        call(
            &mut client,
            "browser.action",
            OWNER,
            v5::BrowserActionRequest {
                params: v5::BrowserActionRequestParams {
                    session_id: text(OWNER),
                },
                payload,
            },
        )
        .await,
    );
    for url in [
        "file:///tmp/file",
        "https://user:secret@example.test/",
        "not-a-url",
    ] {
        error::<v5::InvalidRequestError>(
            call(
                &mut client,
                "isolatedBrowser.start",
                OWNER,
                v5::IsolatedBrowserStartRequest {
                    params: v5::IsolatedBrowserStartRequestParams {
                        session_id: text(OWNER),
                    },
                    payload: v5::IsolatedBrowserStartPayload { url: text(url) },
                },
            )
            .await,
        );
    }
    let unavailable = error::<v5::ServiceUnavailableError>(
        call(
            &mut client,
            "browser.observe",
            OWNER,
            v5::BrowserObserveRequest {
                params: v5::BrowserObserveRequestParams {
                    session_id: text(OWNER),
                },
                payload: v5::BrowserObserveRequestPayload {
                    tab_id: text("btab_valid"),
                    generation: 1,
                    call_id: text("valid"),
                },
            },
        )
        .await,
    );
    assert_eq!(
        units(unavailable.service.as_ref().unwrap()),
        "browser-extension"
    );
    error::<v5::SessionNotFoundError>(
        call(
            &mut client,
            "isolatedBrowser.status",
            "ses_missing",
            v5::IsolatedBrowserStatusRequest {
                params: v5::IsolatedBrowserStatusRequestParams {
                    session_id: text("ses_missing"),
                },
            },
        )
        .await,
    );
    let unavailable = error::<v5::ServiceUnavailableError>(
        call(
            &mut client,
            "isolatedBrowser.start",
            OWNER,
            v5::IsolatedBrowserStartRequest {
                params: v5::IsolatedBrowserStartRequestParams {
                    session_id: text(OWNER),
                },
                payload: v5::IsolatedBrowserStartPayload {
                    url: text("https://example.test/"),
                },
            },
        )
        .await,
    );
    assert_eq!(
        units(unavailable.service.as_ref().unwrap()),
        "isolated-browser"
    );
    server.shutdown().await.unwrap();
}
