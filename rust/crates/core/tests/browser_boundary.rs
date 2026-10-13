use serde_json::json;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use ycoding_core::platform::{
    browser::{
        admission::Admission,
        boundary::{self, Mode, Operation, Services},
        bridge::{Bridge, Transport},
        protocol,
    },
    computer::{
        Future,
        boundary::{Context, Permission, PermissionFailure, Policy, Reservation, Resolved, Review},
        types::Owner,
    },
};
use ycoding_schema::{DomainDecode, JsonValue, parse_json, session_id::SessionId};
struct Host {
    calls: Arc<Mutex<Vec<String>>>,
    deny: bool,
}
struct Held(Arc<Mutex<Vec<String>>>);
impl Reservation for Held {
    fn release(&self) {
        self.0.lock().unwrap().push("release".into());
    }
}
struct PostOpenReadFailure {
    calls: std::sync::atomic::AtomicUsize,
    error: String,
}
impl Policy for PostOpenReadFailure {
    fn permission<'a>(
        &'a self,
        _context: &'a Context,
        _request: Permission,
    ) -> Future<'a, Result<(), PermissionFailure>> {
        Box::pin(async move {
            if self
                .calls
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                == 2
            {
                return Err(match self.error.as_str() {
                    "denied" => PermissionFailure::Blocked(self.error.clone()),
                    "corrected" => PermissionFailure::Corrected(self.error.clone()),
                    _ => PermissionFailure::Fault(self.error.clone()),
                });
            }
            Ok(())
        })
    }
    fn review<'a>(
        &'a self,
        _context: &'a Context,
        _request: Review,
    ) -> Future<'a, Result<Box<dyn Reservation>, String>> {
        Box::pin(async {
            Ok(Box::new(Held(Arc::new(Mutex::new(Vec::new())))) as Box<dyn Reservation>)
        })
    }
    fn resolve<'a>(
        &'a self,
        _path: &'a str,
        _directory: bool,
    ) -> Future<'a, Result<Resolved, String>> {
        Box::pin(async { Err("Unexpected filesystem resolution".into()) })
    }
}
impl Policy for Host {
    fn permission<'a>(
        &'a self,
        _context: &'a Context,
        request: Permission,
    ) -> Future<'a, Result<(), PermissionFailure>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(format!(
                "permission:{}:{}",
                request.action,
                request.resources.join(",")
            ));
            if self.deny {
                return Err(PermissionFailure::Blocked("denied".into()));
            }
            Ok(())
        })
    }
    fn review<'a>(
        &'a self,
        _context: &'a Context,
        request: Review,
    ) -> Future<'a, Result<Box<dyn Reservation>, String>> {
        Box::pin(async move {
            assert!(request.skip_review);
            self.calls.lock().unwrap().push(format!(
                "guardrail:{}:{}",
                request.action, request.resources[0]
            ));
            Ok(Box::new(Held(self.calls.clone())) as Box<dyn Reservation>)
        })
    }
    fn resolve<'a>(
        &'a self,
        _path: &'a str,
        _directory: bool,
    ) -> Future<'a, Result<Resolved, String>> {
        Box::pin(async { Err("Unexpected filesystem resolution".into()) })
    }
}
struct Extension {
    outbox: tokio::sync::mpsc::UnboundedSender<JsonValue>,
    calls: Arc<Mutex<Vec<String>>>,
}
impl Transport for Extension {
    fn send(&self, message: JsonValue) -> bool {
        let text = ycoding_schema::stringify_json(&message);
        if text.contains("\"type\":\"action\"") {
            self.calls.lock().unwrap().push("action".into());
        }
        self.outbox.send(message).is_ok()
    }
    fn close(&self, _code: u16, _reason: &str) {}
}
fn context() -> Context {
    Context {
        owner: Owner {
            session_id: "ses_a".into(),
            call_id: "click".into(),
        },
        message_id: "ams_message".into(),
        agent: "god".into(),
    }
}
fn receive(bridge: &Bridge, value: serde_json::Value) {
    bridge
        .receive(protocol::decode_client(value.to_string().as_bytes()).unwrap())
        .unwrap();
}

#[tokio::test]
async fn leaf_orders_page_interaction_cross_origin_permission_review_and_settlement_reads() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let host = Host {
        calls: calls.clone(),
        deny: false,
    };
    let (outbox, mut inbox) = tokio::sync::mpsc::unbounded_channel();
    let bridge = Bridge::new(
        DomainDecode::decode(&JsonValue::Number(1.)).unwrap(),
        SessionId::new("ses_a").unwrap(),
        Arc::new(Extension {
            outbox,
            calls: calls.clone(),
        }),
        Arc::new(Admission::default()),
        Arc::new(|_| true),
        Duration::from_secs(1),
    );
    receive(&bridge, json!({"type":"profile_access","enabled":true}));
    receive(
        &bridge,
        json!({"type":"shared","mode":"profile","tabID":"btab_test","title":"Fixture","url":"https://example.test/form","documentGeneration":1,"active":false}),
    );
    let observe = tokio::spawn({
        let bridge = bridge.clone();
        async move {
            bridge.observe(DomainDecode::decode(&parse_json(&json!({"sessionID":"ses_a","callID":"observe","tabID":"btab_test","generation":1}).to_string()).unwrap()).unwrap()).await
        }
    });
    inbox.recv().await.unwrap();
    receive(
        &bridge,
        json!({"type":"observation","callID":"observe","tabID":"btab_test","generation":1,"documentGeneration":1,"revision":1,"title":"Fixture","url":"https://example.test/form","elements":[{"ref":"b1","role":"link","name":"Go","destination":"https://other.test/arrive"}],"truncated":false}),
    );
    observe.await.unwrap().unwrap();
    let input=boundary::decode_input(&parse_json(&json!({"operation":"action","tabID":"btab_test","generation":"1","documentGeneration":"1","observationRevision":"1","action":{"type":"click","ref":"b1"}}).to_string()).unwrap()).unwrap();
    let context = context();
    let (result, ()) = tokio::join!(
        boundary::execute(
            Services {
                paired: &bridge,
                isolated: None
            },
            &host,
            &context,
            input
        ),
        async {
            inbox.recv().await.unwrap();
            receive(
                &bridge,
                json!({"type":"result","callID":"click","tabID":"btab_test","generation":1,"documentGeneration":1,"observationRevision":0,"status":"completed","title":"Fixture","url":"https://example.test/form"}),
            );
        }
    );
    assert!(result.is_ok());
    assert_eq!(
        *calls.lock().unwrap(),
        vec![
            "permission:browser_read:https://example.test/form",
            "permission:browser_interact:https://example.test/form",
            "permission:browser_navigate:https://other.test/arrive",
            "permission:browser_read:https://other.test/arrive",
            "guardrail:browser_profile_mutation:https://example.test/form",
            "action",
            "release",
            "permission:browser_read:https://example.test/form"
        ]
    );
}

#[test]
fn input_preserves_numeric_fences_encoded_actions_and_required_isolated_instance() {
    let input=boundary::decode_input(&parse_json(&json!({"operation":"action","mode":"profile","tabID":"btab_test","generation":"1","documentGeneration":"2","observationRevision":"3","action":"{\"type\":\"scroll\",\"deltaY\":\"120\"}"}).to_string()).unwrap()).unwrap();
    assert_eq!(input.mode, Some(Mode::Profile));
    assert!(matches!(input.operation, Operation::Action { .. }));
    assert!(boundary::decode_input(&parse_json(&json!({"operation":"observe","mode":"isolated","tabID":"btab_test","generation":1}).to_string()).unwrap()).is_err());
    assert!(
        boundary::decode_input(
            &parse_json(
                &json!({"operation":"control","mode":"profile","action":"pause"}).to_string()
            )
            .unwrap()
        )
        .is_err()
    );
}

#[test]
fn browser_capture_model_output_removes_base64_from_text() {
    let output=parse_json(&json!({"type":"action","result":{"callID":"call","capture":{"mediaType":"image/png","data":"AAAA","bytes":3}}}).to_string()).unwrap();
    let parts = boundary::model_output(&output);
    assert_eq!(parts.len(), 2);
    assert!(!parts[0].to_string().contains("AAAA"));
    assert_eq!(parts[1]["name"], "shared-tab.png");
}

#[tokio::test]
async fn leaf_uses_coordinator_pairing_status_without_requiring_an_attached_bridge() {
    let root = std::env::temp_dir().join(format!("ycoding-browser-leaf-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let store = ycoding_store::Store::initialize(
        root.join("store.redb"),
        ycoding_store::Options::core(),
        ycoding_store::Catalog::new(1, ycoding_store::resources::TABLES),
        ycoding_store::Metadata::new([13; 16], 1),
    )
    .unwrap();
    let credentials = ycoding_core::resources::credential::Service::new(store.client());
    let paired = ycoding_core::platform::browser::service::Service::new(
        credentials.clone(),
        Arc::new(Admission::default()),
        Arc::new(|_| true),
        Default::default(),
    );
    let host = Host {
        calls: Arc::new(Mutex::new(Vec::new())),
        deny: false,
    };
    let context = context();
    let input =
        || boundary::decode_input(&parse_json("{\"operation\":\"status\"}").unwrap()).unwrap();
    let result = boundary::execute(
        Services {
            paired: &paired,
            isolated: None,
        },
        &host,
        &context,
        input(),
    )
    .await
    .unwrap();
    assert_eq!(
        result,
        parse_json("{\"type\":\"status\",\"status\":{\"state\":\"unavailable\",\"paired\":false}}")
            .unwrap()
    );
    let session = SessionId::new("ses_a").unwrap();
    paired.start(&session).await.unwrap();
    let result = boundary::execute(
        Services {
            paired: &paired,
            isolated: None,
        },
        &host,
        &context,
        input(),
    )
    .await
    .unwrap();
    let result: serde_json::Value =
        serde_json::from_str(&ycoding_schema::stringify_json(&result)).unwrap();
    assert_eq!(result["status"]["state"], "pairing");
    assert!(result["status"]["pairingExpiresAt"].as_u64().unwrap() > 0);
    assert!(host.calls.lock().unwrap().is_empty());
    paired.shutdown();
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

async fn post_open_read_failure(
    error: &str,
    close_failure: bool,
) -> (Result<JsonValue, String>, Vec<serde_json::Value>) {
    let (outbox, mut inbox) = tokio::sync::mpsc::unbounded_channel();
    let bridge = Bridge::new(
        DomainDecode::decode(&JsonValue::Number(1.)).unwrap(),
        SessionId::new("ses_a").unwrap(),
        Arc::new(Extension {
            outbox,
            calls: Arc::new(Mutex::new(Vec::new())),
        }),
        Arc::new(Admission::default()),
        Arc::new(|_| true),
        Duration::from_secs(1),
    );
    let policy = PostOpenReadFailure {
        calls: std::sync::atomic::AtomicUsize::new(0),
        error: error.into(),
    };
    let context = context();
    let input=boundary::decode_input(&parse_json("{\"operation\":\"open\",\"mode\":\"owned\",\"generation\":1,\"url\":\"https://example.test/\"}").unwrap()).unwrap();
    let mut execute = Box::pin(boundary::execute(
        Services {
            paired: &bridge,
            isolated: None,
        },
        &policy,
        &context,
        input,
    ));
    let mut frames = Vec::new();
    loop {
        tokio::select! {
            result=&mut execute=>return (result,frames),
            frame=inbox.recv()=>{
                let frame:serde_json::Value=serde_json::from_str(&ycoding_schema::stringify_json(&frame.unwrap())).unwrap();
                match frame["type"].as_str().unwrap() {
                    "open"=>receive(&bridge,json!({"type":"opened","callID":frame["callID"],"tabID":frame["tabID"],"generation":1,"documentGeneration":1,"title":"Owned","url":"https://example.test/","active":false})),
                    "close" if close_failure=>receive(&bridge,json!({"type":"error","callID":frame["callID"],"tabID":frame["tabID"],"generation":1,"dispatched":false,"message":"Close failed"})),
                    "close"=>receive(&bridge,json!({"type":"closed","callID":frame["callID"],"tabID":frame["tabID"],"generation":1})),
                    other=>panic!("Unexpected extension command {other}"),
                }
                frames.push(frame);
            }
        }
    }
}

#[tokio::test]
async fn a_post_open_permission_fault_is_preserved_and_never_dispatches_cleanup() {
    let (result, frames) = post_open_read_failure("Permission storage unavailable", false).await;
    assert_eq!(result.unwrap_err(), "Permission storage unavailable");
    assert_eq!(frames.len(), 1);
}

#[tokio::test]
async fn a_post_open_denial_closes_with_the_exact_cleanup_call_identity() {
    let (result, frames) = post_open_read_failure("denied", false).await;
    assert_eq!(
        result.unwrap_err(),
        "Page access was denied; the new Chrome tab was closed"
    );
    assert_eq!(frames.len(), 2);
    assert_eq!(
        frames[1]["callID"],
        format!("cleanup-{}", frames[0]["tabID"].as_str().unwrap())
    );
}

#[tokio::test]
async fn failed_denial_cleanup_reports_the_tab_identity_and_manual_recovery() {
    let (result, frames) = post_open_read_failure("denied", true).await;
    assert_eq!(
        result.unwrap_err(),
        format!(
            "Page access was denied and the new Chrome tab may remain open. Switch away and close it manually in Chrome. Tab ID: {}",
            frames[0]["tabID"].as_str().unwrap()
        )
    );
    assert_eq!(frames.len(), 2);
}

#[tokio::test]
async fn a_corrected_post_open_permission_closes_the_unapproved_tab() {
    let (result, frames) = post_open_read_failure("corrected", false).await;
    assert_eq!(
        result.unwrap_err(),
        "Page access was denied; the new Chrome tab was closed"
    );
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[1]["type"], "close");
}
