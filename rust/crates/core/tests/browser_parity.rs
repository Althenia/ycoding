use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use ycoding_core::platform::{
    browser::{
        admission::Admission,
        boundary::{self, Operation, Services},
        bridge::{Bridge, Transport},
        cdp, protocol,
    },
    computer::{
        Future,
        boundary::{Context, Permission, PermissionFailure, Policy, Reservation, Resolved, Review},
        types::Owner,
    },
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, browser, parse_json, session_id::SessionId,
    stringify_json,
};

const PAGE: &str = "https://example.test/form?record=A#private";
const CHILD: &str = "https://child.test/form?record=child#private";
const WAIT: Duration = Duration::from_secs(3);

fn decode<T: DomainDecode>(value: Value) -> T {
    T::decode(&parse_json(&value.to_string()).unwrap()).unwrap()
}

fn wire(value: &JsonValue) -> Value {
    serde_json::from_str(&stringify_json(value)).unwrap()
}

struct Extension {
    outbox: mpsc::UnboundedSender<JsonValue>,
    sent: Mutex<Vec<Value>>,
}

impl Transport for Extension {
    fn send(&self, value: JsonValue) -> bool {
        self.sent.lock().unwrap().push(wire(&value));
        self.outbox.send(value).is_ok()
    }

    fn close(&self, _: u16, _: &str) {}
}

struct Fixture {
    bridge: Arc<Bridge>,
    extension: Arc<Extension>,
    inbox: mpsc::UnboundedReceiver<JsonValue>,
}

impl Fixture {
    fn new() -> Self {
        Self::with_exports(true)
    }

    fn with_exports(configured: bool) -> Self {
        let (outbox, inbox) = mpsc::unbounded_channel();
        let extension = Arc::new(Extension {
            outbox,
            sent: Mutex::new(Vec::new()),
        });
        let bridge = Bridge::new(
            decode(json!(1)),
            SessionId::new("ses_parity").unwrap(),
            extension.clone(),
            Arc::new(Admission::default()),
            Arc::new(|_| true),
            WAIT,
        );
        if configured {
            bridge.configure_exports(Some(std::env::temp_dir().join(format!(
            "ycoding-browser-parity-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))));
        }
        let fixture = Self {
            bridge,
            extension,
            inbox,
        };
        fixture.receive(json!({"type":"profile_access","enabled":true}));
        fixture.receive(
            json!({"type":"shared","mode":"profile","tabID":"btab_parity",
            "title":"Fixture","url":PAGE,"documentGeneration":1,"active":false}),
        );
        fixture
    }

    fn receive(&self, value: Value) {
        self.bridge
            .receive(
                protocol::decode_client(value.to_string().as_bytes())
                    .expect("canonical extension frame must decode"),
            )
            .unwrap();
    }

    async fn next(&mut self) -> Value {
        wire(
            &tokio::time::timeout(WAIT, self.inbox.recv())
                .await
                .expect("Browser command must settle")
                .expect("Browser transport must remain open"),
        )
    }

    async fn observe(&mut self, call: &str, url: &str, elements: Value) -> browser::Observation {
        let bridge = self.bridge.clone();
        let input = decode(json!({"sessionID":"ses_parity","tabID":"btab_parity",
            "generation":1,"callID":call}));
        let task = tokio::spawn(async move { bridge.observe(input).await });
        let request = self.next().await;
        assert_eq!(request["callID"], call);
        self.receive(
            json!({"type":"observation","callID":call,"tabID":"btab_parity",
            "generation":1,"documentGeneration":1,"revision":1,"title":"Fixture",
            "url":url,"elements":elements,"truncated":false}),
        );
        task.await.unwrap().unwrap()
    }

    async fn action(&mut self, call: &str, action: Value, extra: Value) -> browser::ActionResult {
        let bridge = self.bridge.clone();
        let input = action_input(call, action);
        let task = tokio::spawn(async move { bridge.action(input).await });
        self.next().await;
        let mut reply = json!({"type":"result","callID":call,"tabID":"btab_parity",
            "generation":1,"documentGeneration":1,"observationRevision":0,
            "status":"completed","title":"Fixture","url":PAGE});
        reply
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        self.receive(reply);
        task.await.unwrap().unwrap()
    }
}

fn action_input(call: &str, action: Value) -> browser::ActionInput {
    decode(
        json!({"sessionID":"ses_parity","tabID":"btab_parity","generation":1,
        "documentGeneration":1,"observationRevision":1,"callID":call,"action":action}),
    )
}

fn elements() -> Value {
    json!([{"ref":"b1","role":"button","name":"Submit","description":"Save form"}])
}

fn actions() -> Vec<Value> {
    vec![
        json!({"type":"navigate","url":"https://example.test/next"}),
        json!({"type":"click","ref":"b1"}),
        json!({"type":"type","ref":"b1","text":"Synthetic text"}),
        json!({"type":"scroll","deltaY":120}),
        json!({"type":"capture"}),
        json!({"type":"group","tabIDs":["btab_parity"],"title":"Fixture"}),
        json!({"type":"ungroup","tabIDs":["btab_parity"],"groupID":0}),
        json!({"type":"group_control","tabIDs":["btab_parity"]}),
        json!({"type":"back"}),
        json!({"type":"forward"}),
        json!({"type":"reload"}),
        json!({"type":"key","key":"Enter","modifiers":["Control"]}),
        json!({"type":"wait","ref":"b1","timeoutMs":0}),
        json!({"type":"clipboard_read"}),
        json!({"type":"clipboard_write","text":"Synthetic clipboard"}),
        json!({"type":"upload","ref":"b1","paths":["/synthetic/upload.txt"]}),
        json!({"type":"download","timeoutMs":0}),
        json!({"type":"logs","limit":1}),
        json!({"type":"export"}),
        json!({"type":"webmcp_list"}),
        json!({"type":"webmcp_invoke","name":"fixture.echo","arguments":{"text":"hello"}}),
    ]
}

fn context(call: &str) -> Context {
    Context {
        owner: Owner {
            session_id: "ses_parity".into(),
            call_id: call.into(),
        },
        message_id: "ams_parity".into(),
        agent: "fixture".into(),
    }
}

#[derive(Default)]
struct Host {
    permissions: Mutex<Vec<Permission>>,
    reviews: Mutex<Vec<Review>>,
    deny_frame: bool,
    deny_review: bool,
}

struct Held;

impl Reservation for Held {
    fn release(&self) {}
}

impl Policy for Host {
    fn permission<'a>(
        &'a self,
        _: &'a Context,
        request: Permission,
    ) -> Future<'a, Result<(), PermissionFailure>> {
        Box::pin(async move {
            let denied = self.deny_frame
                && request
                    .resources
                    .iter()
                    .any(|resource| resource.starts_with("https://child.test/"));
            self.permissions.lock().unwrap().push(request);
            if denied {
                Err(PermissionFailure::Blocked("Child site denied".into()))
            } else {
                Ok(())
            }
        })
    }

    fn review<'a>(
        &'a self,
        _: &'a Context,
        request: Review,
    ) -> Future<'a, Result<Box<dyn Reservation>, String>> {
        Box::pin(async move {
            self.reviews.lock().unwrap().push(request);
            if self.deny_review {
                Err("Mutation denied".into())
            } else {
                Ok(Box::new(Held) as Box<dyn Reservation>)
            }
        })
    }

    fn resolve<'a>(&'a self, _: &'a str, _: bool) -> Future<'a, Result<Resolved, String>> {
        Box::pin(async { Err("Unexpected path resolution".into()) })
    }
}

fn input(action: Value) -> boundary::Input {
    boundary::decode_input(&decode(json!({"operation":"action","mode":"profile",
        "tabID":"btab_parity","generation":1,"documentGeneration":1,
        "observationRevision":1,"action":action})))
    .unwrap()
}

#[test]
fn version_six_is_the_only_accepted_pairing_and_reconnect_protocol() {
    for kind in ["pair", "authenticate"] {
        for version in [2, 3, 4, 5, 6] {
            let message = json!({"type":kind,"version":version,"extensionID":"b".repeat(32),
                "secret":"s".repeat(32),"credential":"c".repeat(32),"serverID":"server".repeat(4)});
            assert_eq!(
                protocol::decode_client(message.to_string().as_bytes()).is_some(),
                version == 6,
                "{kind} version {version}"
            );
        }
    }
}

#[test]
fn extension_and_cdp_buffers_accept_twelve_mebibytes_and_reject_the_next_byte() {
    assert_eq!(protocol::MAX_FRAME_BYTES, 12 * 1024 * 1024);
    assert_eq!(cdp::MAX_MESSAGE_BYTES, 12 * 1024 * 1024);
    let mut message = br#"{"type":"pong"}"#.to_vec();
    message.resize(12 * 1024 * 1024, b' ');
    assert!(protocol::decode_client(&message).is_some());
    message.push(b' ');
    assert!(protocol::decode_client(&message).is_none());
}

#[test]
fn tool_decodes_twenty_actions_encoded_actions_and_all_numeric_inputs() {
    for mut action in actions() {
        let kind = action["type"].as_str().unwrap().to_owned();
        for name in ["deltaY", "groupID", "timeoutMs", "limit"] {
            if let Some(number) = action.get(name).and_then(Value::as_i64) {
                action[name] = json!(number.to_string());
            }
        }
        for submitted in [action.clone(), json!(action.to_string())] {
            let value = json!({"operation":"action","tabID":"btab_parity","generation":"1",
                "documentGeneration":"1","observationRevision":"1","action":submitted});
            let decoded = boundary::decode_input(&decode(value))
                .unwrap_or_else(|error| panic!("{kind}: {error}"));
            let Operation::Action { action, .. } = decoded.operation else {
                panic!("Expected action")
            };
            assert_eq!(wire(&action.encode())["type"], kind);
        }
    }
    for name in ["limit", "startTime", "endTime"] {
        let mut history = json!({"operation":"history","generation":"1","query":"fixture"});
        history[name] = json!("1");
        assert!(boundary::decode_input(&decode(history)).is_ok(), "{name}");
    }
    for action in [
        json!({"type":"wait","timeoutMs":"30001"}),
        json!({"type":"logs","limit":"0"}),
        json!({"type":"logs","limit":"101"}),
    ] {
        assert!(
            boundary::decode_input(&decode(json!({"operation":"action","tabID":"btab_parity",
            "generation":"1","documentGeneration":"1","observationRevision":"1",
            "action":action})))
            .is_err()
        );
    }
}

#[test]
fn native_tool_catalog_exposes_actions_history_and_encoded_integer_inputs() {
    let definition: Value =
        serde_json::from_str(include_str!("../src/tools/builtin/browser.tool.json")).unwrap();
    let validator = jsonschema::validator_for(&definition["inputSchema"]).unwrap();
    for action in actions() {
        for action in [action.clone(), json!(action.to_string())] {
            let submitted = json!({"operation":"action","mode":"profile","tabID":"btab_parity",
                "generation":"1","documentGeneration":"1","observationRevision":"1","action":action});
            assert!(validator.is_valid(&submitted), "{submitted}");
        }
    }
    assert!(validator.is_valid(
        &json!({"operation":"history","generation":"1","query":"fixture",
        "limit":"2","startTime":"0","endTime":"100"})
    ));
    assert!(!validator.is_valid(&json!({"operation":"status","consumeReview":false})));
    assert!(!validator.is_valid(&json!({"operation":"status","identity":"private"})));
}

#[test]
fn native_tool_describes_hidden_file_inputs_and_file_chooser_limits() {
    let definition: Value =
        serde_json::from_str(include_str!("../src/tools/builtin/browser.tool.json")).unwrap();
    assert!(definition["description"].as_str().unwrap().contains(
        "Upload takes absolute file paths and a file input, including one listed as a hidden file input, or the element that opens a file chooser; no native file dialog opens, and a page picker without a file input cannot receive files; isolated mode rejects upload."
    ));
}

#[test]
fn native_tool_catalog_bounds_group_control_and_carries_tab_group_ids() {
    let definition: Value =
        serde_json::from_str(include_str!("../src/tools/builtin/browser.tool.json")).unwrap();
    let input = jsonschema::validator_for(&definition["inputSchema"]).unwrap();
    for count in [0, 1, 8, 9] {
        for mode in ["owned", "profile"] {
            let submitted = json!({"operation":"action", "mode":mode, "tabID":"btab_parity",
                "generation":1, "documentGeneration":1, "observationRevision":1,
                "action":{"type":"group_control", "tabIDs":vec!["btab_parity"; count]}});
            assert_eq!(input.is_valid(&submitted), (1..=8).contains(&count));
        }
    }
    let output = jsonschema::validator_for(&definition["outputSchema"]).unwrap();
    for group_id in [
        json!(0),
        json!(9_007_199_254_740_991u64),
        json!(-1),
        json!(0.5),
    ] {
        let valid = group_id == json!(0) || group_id == json!(9_007_199_254_740_991u64);
        let value = json!({"type":"tabs", "tabs":[{"id":"btab_parity", "sessionID":"ses_parity",
            "title":"Fixture", "page":{"origin":"https://example.test", "path":"/"},
            "status":"shared", "generation":1, "documentGeneration":1, "observationRevision":1,
            "groupID":group_id}]});
        assert_eq!(output.is_valid(&value), valid);
    }
}

#[tokio::test]
async fn bridge_dispatches_all_twenty_typed_actions_without_changing_the_payload() {
    for action in actions() {
        let mut fixture = Fixture::new();
        fixture.observe("observe", PAGE, elements()).await;
        let bridge = fixture.bridge.clone();
        let submitted = action_input("action", action.clone());
        let task = tokio::spawn(async move { bridge.action(submitted).await });
        let command = fixture.next().await;
        assert_eq!(command["action"], action);
        fixture.receive(
            json!({"type":"error","callID":"action","tabID":"btab_parity",
            "generation":1,"dispatched":false,"message":"Synthetic extension rejection"}),
        );
        let result = task.await.unwrap().unwrap();
        let sent = fixture.extension.sent.lock().unwrap();
        assert_eq!(sent.last().unwrap()["action"], action);
        assert_eq!(result.status, browser::ResultStatus::Rejected);
    }
}

#[tokio::test]
async fn peripheral_results_preserve_optional_absence_and_never_publish_mhtml() {
    let mut fixture = Fixture::new();
    fixture.observe("observe", PAGE, elements()).await;
    let extra = json!({"text":"fixture output","download":{"filename":"fixture.txt","state":"complete"},
        "logs":[{"level":"info","text":"child output","frame":CHILD}],
        "webmcpTools":[{"name":"fixture.echo"}]});
    let result = fixture
        .action("result", json!({"type":"logs"}), extra)
        .await;
    let value = wire(&result.encode());
    assert_eq!(value["text"], "fixture output");
    assert_eq!(
        value["download"],
        json!({"filename":"fixture.txt","state":"complete"})
    );
    assert_eq!(
        value["logs"][0]["frame"],
        json!({"origin":"https://child.test","path":"/form"})
    );
    assert_eq!(value["webmcpTools"], json!([{"name":"fixture.echo"}]));
    assert!(value.get("data").is_none());
    assert!(!value.to_string().contains("record="));
    fixture.observe("empty-observe", PAGE, elements()).await;
    let absent = wire(
        &fixture
            .action("empty", json!({"type":"logs"}), json!({}))
            .await
            .encode(),
    );
    for name in [
        "text",
        "download",
        "logs",
        "savedFile",
        "webmcpTools",
        "data",
    ] {
        assert!(absent.get(name).is_none(), "{name} must remain absent");
    }
    let output = decode(json!({"type":"action","result":{
        "callID":"saved","tab":value["tab"],"status":"completed",
        "savedFile":{"path":"/synthetic/page.mhtml","bytes":12}}}));
    let projected = boundary::model_output(&output);
    assert!(projected[0].to_string().contains("page.mhtml"));
    assert!(!projected[0].to_string().contains("\"data\""));
}

#[tokio::test]
async fn extension_peripheral_output_is_bounded_sanitized_and_does_not_split_utf8_characters() {
    let mut fixture = Fixture::new();
    fixture.observe("observe", PAGE, elements()).await;
    let logs = (0..101)
        .map(|_| {
            json!({"level":"x".repeat(17),"text":"z".repeat(browser::MAX_NAME_LENGTH + 1),
        "frame":"file:///synthetic/private"})
        })
        .collect::<Vec<_>>();
    let tools = (0..101)
        .map(|_| {
            json!({"name":"n".repeat(129),
        "description":"d".repeat(browser::MAX_NAME_LENGTH + 1)})
        })
        .collect::<Vec<_>>();
    let result = fixture
        .action(
            "bounded",
            json!({"type":"logs"}),
            json!({
        "text":"🦀".repeat(16385), "logs":logs, "webmcpTools":tools,
        "download":{"filename":"f".repeat(1025),"state":"s".repeat(33),"bytesReceived":-1,
            "totalBytes":1.75,"mime":"m".repeat(129)}}),
        )
        .await;
    let value = wire(&result.encode());
    assert_eq!(value["text"].as_str().unwrap().len(), 64 * 1024);
    assert_eq!(value["text"].as_str().unwrap().chars().count(), 16384);
    assert_eq!(value["logs"].as_array().unwrap().len(), 100);
    assert_eq!(value["logs"][0]["level"].as_str().unwrap().len(), 16);
    assert_eq!(
        value["logs"][0]["text"].as_str().unwrap().len(),
        browser::MAX_NAME_LENGTH
    );
    assert!(value["logs"][0].get("frame").is_none());
    assert_eq!(value["webmcpTools"].as_array().unwrap().len(), 100);
    assert_eq!(value["webmcpTools"][0]["name"].as_str().unwrap().len(), 128);
    assert_eq!(
        value["webmcpTools"][0]["description"]
            .as_str()
            .unwrap()
            .len(),
        browser::MAX_NAME_LENGTH
    );
    assert_eq!(value["download"]["filename"].as_str().unwrap().len(), 1024);
    assert_eq!(value["download"]["state"].as_str().unwrap().len(), 32);
    assert!(value["download"].get("bytesReceived").is_none());
    assert_eq!(value["download"]["totalBytes"], 1);
    assert_eq!(value["download"]["mime"].as_str().unwrap().len(), 128);
}

#[tokio::test]
async fn foreign_frame_reads_are_authorized_before_exposure_and_second_observation() {
    for denied in [false, true] {
        let mut fixture = Fixture::new();
        let host = Host {
            deny_frame: denied,
            ..Host::default()
        };
        let call = context("observe");
        let input =
            boundary::decode_input(&decode(json!({"operation":"observe","tabID":"btab_parity",
            "generation":1})))
            .unwrap();
        let bridge = fixture.bridge.clone();
        let result = boundary::execute(
            Services {
                paired: &bridge,
                isolated: None,
            },
            &host,
            &call,
            input,
        );
        let script = async {
            let first = fixture.next().await;
            fixture.receive(
                json!({"type":"observation","callID":first["callID"],"tabID":"btab_parity",
                "generation":1,"documentGeneration":1,"revision":1,"title":"Fixture","url":PAGE,
                "elements":[],"frames":[{"url":CHILD,"observed":false}],"truncated":false}),
            );
            if !denied {
                let second = fixture.next().await;
                assert_eq!(second["callID"], "observe:frames");
                assert!(
                    second["frameOrigins"]
                        .as_array()
                        .unwrap()
                        .contains(&json!("https://child.test"))
                );
                fixture.receive(
                    json!({"type":"observation","callID":second["callID"],"tabID":"btab_parity",
                    "generation":1,"documentGeneration":1,"revision":2,"title":"Fixture","url":PAGE,
                    "elements":[{"ref":"b1","role":"button","name":"Child","frame":CHILD}],
                    "texts":[{"role":"heading","name":"Child heading","frame":CHILD}],
                    "frames":[{"url":CHILD,"observed":true}],"truncated":false}),
                );
            }
        };
        let (result, ()) = tokio::time::timeout(WAIT, async { tokio::join!(result, script) })
            .await
            .unwrap();
        assert!(host.permissions.lock().unwrap().iter().any(|permission| {
            permission.action == "browser_read"
                && permission
                    .resources
                    .contains(&"https://child.test/form".into())
        }));
        if denied {
            assert!(result.is_err());
            assert_eq!(fixture.extension.sent.lock().unwrap().len(), 1);
        } else {
            let value = wire(&result.unwrap());
            assert_eq!(value["observation"]["texts"][0]["name"], "Child heading");
            assert!(!value.to_string().contains("record="));
        }
    }
}

#[tokio::test]
async fn foreign_frame_click_type_and_upload_are_denied_before_mutation_dispatch() {
    for action in [
        json!({"type":"click","ref":"b1"}),
        json!({"type":"type","ref":"b1","text":"fixture"}),
        json!({"type":"upload","ref":"b1","paths":["/synthetic/upload.txt"]}),
    ] {
        let mut fixture = Fixture::new();
        fixture
            .observe(
                "observe",
                PAGE,
                json!([{"ref":"b1","role":"textbox","name":"Child","frame":CHILD}]),
            )
            .await;
        let host = Host {
            deny_frame: true,
            ..Host::default()
        };
        let result = boundary::execute(
            Services {
                paired: &fixture.bridge,
                isolated: None,
            },
            &host,
            &context("denied"),
            input(action),
        )
        .await;
        assert!(result.is_err());
        assert!(host.permissions.lock().unwrap().iter().any(|permission| {
            permission
                .resources
                .contains(&"https://child.test/form".into())
        }));
        assert!(host.reviews.lock().unwrap().is_empty());
        assert_eq!(fixture.extension.sent.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn frame_authority_does_not_grant_top_document_navigation() {
    for scenario in ["scripted-hop", "frame", "navigate"] {
        let mut fixture = Fixture::new();
        fixture
            .observe(
                "observe",
                PAGE,
                json!([{
                    "ref":"b1","role":"button","name":"Child button","frame":CHILD
                }]),
            )
            .await;
        let host = Host::default();
        let call = context("frame-authority");
        let bridge = fixture.bridge.clone();
        let action = if scenario == "navigate" {
            json!({"type":"navigate","url":CHILD})
        } else {
            json!({"type":"click","ref":"b1"})
        };
        let execute = boundary::execute(
            Services {
                paired: &bridge,
                isolated: None,
            },
            &host,
            &call,
            input(action),
        );
        let script = async {
            let request = fixture.next().await;
            fixture.receive(
                json!({"type":"result","callID":"frame-authority","tabID":"btab_parity",
                "generation":1,"documentGeneration":1,"observationRevision":0,"status":"completed",
                "title":"Fixture","url":if scenario == "frame" { PAGE } else { CHILD }}),
            );
            request
        };
        let (result, request) = tokio::time::timeout(WAIT, async { tokio::join!(execute, script) })
            .await
            .unwrap();
        let permissions = host.permissions.lock().unwrap();
        let child_navigation = permissions.iter().any(|permission| {
            permission.action == "browser_navigate"
                && permission
                    .resources
                    .contains(&"https://child.test/form".into())
        });
        assert_eq!(child_navigation, scenario == "navigate", "{scenario}");
        if scenario != "navigate" {
            for action in ["browser_read", "browser_interact"] {
                assert!(
                    permissions
                        .iter()
                        .any(|permission| permission.action == action
                            && permission
                                .resources
                                .contains(&"https://child.test/form".into())),
                    "{scenario}: {action}"
                );
            }
            assert!(
                host.reviews
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|review| review.resources.contains(&"https://child.test/form".into()))
            );
        }
        assert_eq!(
            result.is_ok(),
            scenario != "scripted-hop",
            "{scenario}: {result:?}"
        );
        let approved = request["allowedOrigins"]
            .as_array()
            .expect("Action origins are explicit");
        assert_eq!(
            approved.contains(&json!("https://child.test")),
            scenario == "navigate",
            "{scenario}: frame interaction must not authorize a top-document destination"
        );
    }
}

#[tokio::test]
async fn every_profile_mutation_is_guarded_and_reads_have_no_mutation_review() {
    let mutations = [
        "navigate",
        "click",
        "type",
        "group",
        "ungroup",
        "group_control",
        "back",
        "forward",
        "reload",
        "key",
        "clipboard_write",
        "upload",
        "webmcp_invoke",
    ];
    for action in actions() {
        let mut fixture = Fixture::new();
        fixture.observe("observe", PAGE, elements()).await;
        let host = Host {
            deny_review: true,
            ..Host::default()
        };
        let kind = action["type"].as_str().unwrap().to_owned();
        let call = context("guarded");
        let bridge = fixture.bridge.clone();
        let execute = boundary::execute(
            Services {
                paired: &bridge,
                isolated: None,
            },
            &host,
            &call,
            input(action),
        );
        if mutations.contains(&kind.as_str()) {
            assert!(execute.await.is_err(), "{kind}");
            let reviews = host.reviews.lock().unwrap();
            assert_eq!(reviews.len(), 1, "{kind}");
            assert_eq!(reviews[0].action, "browser_profile_mutation");
            assert!(reviews[0].skip_review);
            assert_eq!(fixture.extension.sent.lock().unwrap().len(), 1, "{kind}");
        } else {
            let (result, ()) = tokio::join!(execute, async {
                fixture.next().await;
                fixture.receive(
                    json!({"type":"result","callID":"guarded","tabID":"btab_parity",
                    "generation":1,"documentGeneration":1,"observationRevision":0,
                    "status":"completed","title":"Fixture","url":PAGE,"data":"<html></html>"}),
                );
            });
            assert!(result.is_ok(), "{kind}: {result:?}");
            assert!(host.reviews.lock().unwrap().is_empty(), "{kind}");
        }
    }
}

#[tokio::test]
async fn group_actions_require_every_member_site_control_permission_and_mutation_review() {
    for kind in ["group", "ungroup", "group_control"] {
        for denied in ["none", "site", "review"] {
            let mut fixture = Fixture::new();
            fixture.observe("observe", PAGE, elements()).await;
            fixture.receive(json!({"type":"shared","mode":"profile","tabID":"btab_peer",
                "title":"Peer","url":CHILD,"documentGeneration":1,"active":false}));
            let host = Host {
                deny_frame: denied == "site",
                deny_review: denied == "review",
                ..Host::default()
            };
            let mut action = json!({"type":kind,"tabIDs":["btab_parity","btab_peer"]});
            if kind == "group" {
                action["title"] = json!("Task");
            } else if kind == "ungroup" {
                action["groupID"] = json!(0);
            }
            let bridge = fixture.bridge.clone();
            let call = context("group");
            let execute = boundary::execute(
                Services {
                    paired: &bridge,
                    isolated: None,
                },
                &host,
                &call,
                input(action),
            );
            if denied != "none" {
                assert!(execute.await.is_err(), "{kind}: {denied}");
                assert!(fixture.inbox.try_recv().is_err());
                assert_eq!(
                    fixture
                        .bridge
                        .list(&SessionId::new("ses_parity").unwrap())
                        .unwrap()
                        .into_iter()
                        .find(|tab| tab.id == decode(json!("btab_peer")))
                        .unwrap()
                        .lease,
                    None
                );
            } else {
                let (result, command) = tokio::join!(execute, async {
                    let command = fixture.next().await;
                    fixture.receive(
                        json!({"type":"result","callID":"group","tabID":"btab_parity",
                        "generation":1,"documentGeneration":1,"observationRevision":0,
                        "status":"completed","title":"Fixture","url":PAGE}),
                    );
                    command
                });
                assert!(result.is_ok(), "{kind}: {result:?}");
                assert_eq!(
                    command["allowedOrigins"],
                    json!(["https://example.test", "https://child.test"])
                );
                assert_eq!(command["controlSessionID"], "ses_parity");
                assert_eq!(
                    command["controlTabIDs"],
                    json!(["btab_parity", "btab_peer"])
                );
            }
            let permissions = host.permissions.lock().unwrap();
            assert!(permissions.iter().any(|request| {
                request.action == "browser_read"
                    && request.resources.len() == 2
                    && request
                        .resources
                        .contains(&"https://example.test/form".into())
                    && request
                        .resources
                        .contains(&"https://child.test/form".into())
            }));
            assert_eq!(
                permissions
                    .iter()
                    .any(|request| request.action == "browser_control"
                        && request.resources == [kind]),
                denied != "site"
            );
            let reviews = host.reviews.lock().unwrap();
            if denied == "site" {
                assert!(reviews.is_empty());
            } else {
                assert_eq!(reviews.len(), 1);
                assert_eq!(reviews[0].action, "browser_profile_mutation");
                assert_eq!(reviews[0].resources.len(), 2);
                assert!(
                    reviews[0]
                        .resources
                        .contains(&"https://example.test/form".into())
                );
                assert!(
                    reviews[0]
                        .resources
                        .contains(&"https://child.test/form".into())
                );
            }
        }
    }
}

#[tokio::test]
async fn added_mutations_keep_dispatched_failures_uncertain_and_never_replay() {
    for action in actions().into_iter().filter(|action| {
        [
            "back",
            "forward",
            "reload",
            "key",
            "clipboard_write",
            "upload",
            "webmcp_invoke",
        ]
        .contains(&action["type"].as_str().unwrap())
    }) {
        for dispatched in [false, true] {
            let mut fixture = Fixture::new();
            fixture.observe("observe", PAGE, elements()).await;
            let input = action_input("failure", action.clone());
            let bridge = fixture.bridge.clone();
            let submitted = input.clone();
            let task = tokio::spawn(async move { bridge.action(submitted).await });
            fixture.next().await;
            fixture.receive(
                json!({"type":"error","callID":"failure","tabID":"btab_parity",
                "generation":1,"dispatched":dispatched,"message":"Scripted lost reply"}),
            );
            let result = task.await.unwrap().unwrap();
            assert_eq!(
                result.status,
                if dispatched {
                    browser::ResultStatus::Uncertain
                } else {
                    browser::ResultStatus::Rejected
                },
                "{action}"
            );
            assert_eq!(fixture.bridge.action(input).await.unwrap(), result);
            assert_eq!(fixture.extension.sent.lock().unwrap().len(), 2);
        }
    }
}

#[tokio::test]
async fn stale_fences_and_foreign_leases_reject_new_actions_before_dispatch() {
    let mut fixture = Fixture::new();
    fixture.observe("observe", PAGE, elements()).await;
    for field in ["generation", "documentGeneration", "observationRevision"] {
        let mut value = wire(&action_input(field, json!({"type":"key","key":"Enter"})).encode());
        value[field] = json!(2);
        assert!(fixture.bridge.action(decode(value)).await.is_err());
    }
    let mut value = wire(&action_input("foreign", json!({"type":"reload"})).encode());
    value["sessionID"] = json!("ses_other");
    assert!(fixture.bridge.action(decode(value)).await.is_err());
    assert_eq!(fixture.extension.sent.lock().unwrap().len(), 1);
}

async fn approved_identity(url: &str, listed: Value, action: Value) -> (String, Vec<bool>) {
    let mut fixture = Fixture::new();
    let observation = fixture.observe("observe", url, listed).await;
    let public = stringify_json(&observation.encode());
    assert!(!public.contains("record="));
    assert!(!public.contains("identity"));
    let host = Host {
        deny_review: true,
        ..Host::default()
    };
    let result = boundary::execute(
        Services {
            paired: &fixture.bridge,
            isolated: None,
        },
        &host,
        &context("identity"),
        input(action),
    )
    .await;
    assert!(result.is_err());
    let permissions = host.permissions.lock().unwrap();
    let digests = permissions
        .iter()
        .map(|permission| {
            permission.metadata["operationDigest"]
                .as_str()
                .expect("Browser permissions must bind a private operation digest")
                .to_owned()
        })
        .collect::<Vec<_>>();
    assert!(!digests.is_empty());
    assert!(digests.iter().all(|digest| digest == &digests[0]));
    assert!(digests[0].bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_eq!(digests[0].len(), 64);
    (
        digests[0].clone(),
        permissions
            .iter()
            .map(|permission| permission.consume_review)
            .collect(),
    )
}

#[tokio::test]
async fn semantic_approval_identity_survives_ref_changes_but_not_target_payload_or_private_url_changes()
 {
    let first = approved_identity(PAGE, elements(), json!({"type":"click","ref":"b1"})).await;
    assert!(first.1.iter().all(|consume| *consume));
    let fresh = approved_identity(
        PAGE,
        json!([{"ref":"b2","role":"button","name":"Submit","description":"Save form"}]),
        json!({"type":"click","ref":"b2"}),
    )
    .await;
    assert_eq!(first.0, fresh.0);
    let renamed = approved_identity(
        PAGE,
        json!([{"ref":"b1","role":"button","name":"Delete","description":"Save form"}]),
        json!({"type":"click","ref":"b1"}),
    )
    .await;
    assert_ne!(first.0, renamed.0);
    let changed_url = approved_identity(
        "https://example.test/form?record=B#private",
        elements(),
        json!({"type":"click","ref":"b1"}),
    )
    .await;
    assert_ne!(first.0, changed_url.0);
    let typed_a = approved_identity(
        PAGE,
        elements(),
        json!({"type":"type","ref":"b1","text":"A"}),
    )
    .await;
    let typed_b = approved_identity(
        PAGE,
        elements(),
        json!({"type":"type","ref":"b1","text":"B"}),
    )
    .await;
    assert_ne!(typed_a.0, typed_b.0);
}

#[tokio::test]
async fn ambiguous_semantic_targets_cannot_consume_once_approval() {
    let listed = json!([
        {"ref":"b1","role":"button","name":"Submit","description":"Save form"},
        {"ref":"b2","role":"button","name":"Submit","description":"Save form"}]);
    for action in [
        json!({"type":"click","ref":"b1"}),
        json!({"type":"type","ref":"b1","text":"fixture"}),
    ] {
        let (_, consume) = approved_identity(PAGE, listed.clone(), action).await;
        assert!(consume.iter().all(|value| !value));
    }
}

#[tokio::test]
async fn paired_history_and_export_use_the_existing_bridge_and_private_configured_storage() {
    use ycoding_core::{platform::browser::service, resources::credential};
    use ycoding_store::{Catalog, Metadata, Store, resources};
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let root = std::env::temp_dir().join(format!(
        "ycoding-browser-parity-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::create_dir(&root).unwrap();
    let exports = root.join("exports");
    let store = Store::initialize(
        root.join("store.redb"),
        ycoding_store::Options::core(),
        Catalog::new(1, resources::TABLES),
        Metadata::new([29; 16], 1),
    )
    .unwrap();
    let credentials = credential::Service::new(store.client());
    let service = service::Service::new(
        credentials.clone(),
        Arc::new(Admission::default()),
        Arc::new(|_| true),
        service::Options {
            command_timeout: WAIT,
            export_directory: Some(exports.clone()),
            ..Default::default()
        },
    );
    let session = SessionId::new("ses_parity").unwrap();
    let pairing = service.start(&session).await.unwrap();
    let (sender, mut inbox) = mpsc::unbounded_channel();
    let extension = Arc::new(Extension {
        outbox: sender,
        sent: Mutex::new(Vec::new()),
    });
    let mut handshake = json!({"type":"pair","version":4,"extensionID":"b".repeat(32),
        "secret":pairing.secret.as_str().unwrap()});
    assert!(protocol::decode_client(handshake.to_string().as_bytes()).is_none());
    handshake["version"] = json!(6);
    let attachment = service
        .attach(
            &format!("chrome-extension://{}", "b".repeat(32)),
            protocol::decode_client(handshake.to_string().as_bytes()).unwrap(),
            extension.clone(),
        )
        .await
        .unwrap();
    let response = wire(&inbox.recv().await.unwrap());
    assert_eq!(response["version"], 6);
    assert!(response["credential"].is_string());
    attachment
        .receive(
            protocol::decode_client(
                json!({"type":"profile_access","enabled":true})
                    .to_string()
                    .as_bytes(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    attachment
        .receive(
            protocol::decode_client(
                json!({"type":"shared","mode":"profile","tabID":"btab_parity",
        "title":"../../unsafe fixture","url":PAGE,"documentGeneration":1,"active":false})
                .to_string()
                .as_bytes(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let request = decode(
        json!({"sessionID":"ses_parity","generation":1,"callID":"history",
        "query":"fixture","limit":2,"startTime":0,"endTime":100}),
    );
    let worker = service.clone();
    let history = tokio::spawn(async move { worker.history(request).await });
    let command = wire(&inbox.recv().await.unwrap());
    assert_eq!(
        command,
        json!({"type":"history","generation":1,"callID":"history","query":"fixture",
        "limit":2,"startTime":0,"endTime":100})
    );
    assert!(
        service
            .observe(decode(
                json!({"sessionID":"ses_parity","tabID":"btab_parity",
        "generation":1,"callID":"blocked-by-history"})
            ))
            .await
            .is_err()
    );
    attachment
        .receive(
            protocol::decode_client(
                json!({"type":"history_result","generation":1,"callID":"history",
        "entries":[{"url":"file:///private/fixture","title":"Hidden","lastVisitTime":1},
            {"url":"https://fixture:password@example.test/","title":"Hidden","lastVisitTime":1},
            {"url":PAGE,"title":"Fixture","lastVisitTime":12.9,"visitCount":3.7}]})
                .to_string()
                .as_bytes(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let history = wire(&history.await.unwrap().unwrap().encode());
    assert_eq!(history["entries"].as_array().unwrap().len(), 1);
    assert_eq!(history["entries"][0]["url"], PAGE);
    assert_eq!(history["entries"][0]["lastVisitTime"], 12);
    assert_eq!(history["entries"][0]["visitCount"], 3);
    let worker = service.clone();
    let observe = tokio::spawn(async move {
        worker
            .observe(decode(
                json!({"sessionID":"ses_parity","tabID":"btab_parity",
        "generation":1,"callID":"observe-export"}),
            ))
            .await
    });
    inbox.recv().await.unwrap();
    attachment.receive(protocol::decode_client(json!({"type":"observation","callID":"observe-export","tabID":"btab_parity",
        "generation":1,"documentGeneration":1,"revision":1,"title":"../../unsafe fixture","url":PAGE,
        "elements":[],"truncated":false}).to_string().as_bytes()).unwrap()).await.unwrap();
    observe.await.unwrap().unwrap();
    let input = action_input("export", json!({"type":"export"}));
    let repeated = input.clone();
    let worker = service.clone();
    let export = tokio::spawn(async move { worker.action(input).await });
    let command = wire(&inbox.recv().await.unwrap());
    assert_eq!(command["action"]["type"], "export");
    let archive = "Synthetic archive 🦀\n";
    attachment
        .receive(
            protocol::decode_client(
                json!({"type":"result","callID":"export","tabID":"btab_parity",
        "generation":1,"documentGeneration":1,"observationRevision":0,"status":"completed",
        "title":"../../unsafe fixture","url":PAGE,"data":archive})
                .to_string()
                .as_bytes(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let result = export.await.unwrap().unwrap();
    let public = wire(&result.encode());
    let path = std::path::Path::new(public["savedFile"]["path"].as_str().unwrap());
    assert_eq!(path.parent(), Some(exports.as_path()));
    assert_eq!(
        path.extension().and_then(|value| value.to_str()),
        Some("mhtml")
    );
    assert_eq!(std::fs::read(path).unwrap(), archive.as_bytes());
    assert_eq!(public["savedFile"]["bytes"], archive.len());
    assert!(public.get("data").is_none());
    assert!(!public.to_string().contains("Synthetic archive"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&exports).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert_eq!(service.action(repeated).await.unwrap(), result);
    assert_eq!(std::fs::read_dir(&exports).unwrap().count(), 1);
    service.shutdown();
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn unconfigured_exports_fail_instead_of_selecting_an_ambient_directory() {
    let mut fixture = Fixture::with_exports(false);
    fixture.observe("observe", PAGE, elements()).await;
    let bridge = fixture.bridge.clone();
    let export = tokio::spawn(async move {
        bridge
            .action(action_input("export", json!({"type":"export"})))
            .await
    });
    fixture.next().await;
    fixture.receive(json!({"type":"result","callID":"export","tabID":"btab_parity","generation":1,
        "documentGeneration":1,"observationRevision":0,"status":"completed","title":"Fixture","url":PAGE,
        "data":"Synthetic MHTML"}));
    assert!(export.await.unwrap().is_err());
}

#[tokio::test]
async fn owned_group_actions_and_isolated_history_reject_before_permissions_or_mutation() {
    let mut fixture = Fixture::new();
    let bridge = fixture.bridge.clone();
    let open = tokio::spawn(async move {
        bridge
            .open(decode(json!({"sessionID":"ses_parity","generation":1,
        "callID":"owned-open","url":"https://example.test/owned"})))
            .await
    });
    let command = fixture.next().await;
    fixture.receive(json!({"type":"opened","callID":"owned-open","tabID":command["tabID"],
        "generation":1,"documentGeneration":1,"title":"Owned fixture","url":"https://example.test/owned","active":false}));
    let owned = open.await.unwrap().unwrap();
    let owned_id = wire(&owned.id.encode());
    for kind in ["group", "ungroup", "group_control"] {
        let host = Host::default();
        let mut action = json!({"type":kind,"tabIDs":[owned_id]});
        if kind == "group" {
            action["title"] = json!("Fixture");
        } else if kind == "ungroup" {
            action["groupID"] = json!(0);
        }
        let input = boundary::decode_input(&decode(json!({"operation":"action","mode":"owned",
            "tabID":owned_id,"generation":1,"documentGeneration":1,
            "observationRevision":0,"action":action})))
        .unwrap();
        assert!(
            boundary::execute(
                Services {
                    paired: &fixture.bridge,
                    isolated: None
                },
                &host,
                &context(kind),
                input
            )
            .await
            .is_err()
        );
        assert!(host.permissions.lock().unwrap().is_empty());
        assert!(host.reviews.lock().unwrap().is_empty());
    }
    let host = Host::default();
    let input = boundary::decode_input(&decode(json!({"operation":"history","mode":"isolated",
        "instanceID":"ibrowser_parity","generation":1})))
    .unwrap();
    let error = boundary::execute(
        Services {
            paired: &fixture.bridge,
            isolated: None,
        },
        &host,
        &context("isolated-history"),
        input,
    )
    .await
    .unwrap_err();
    assert!(error.to_lowercase().contains("history"));
    assert!(host.permissions.lock().unwrap().is_empty());
    assert_eq!(fixture.extension.sent.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn cdp_transports_a_large_bounded_export_response_without_a_live_browser() {
    let (client, mut chrome) = tokio::io::duplex(8192);
    let (read, write) = tokio::io::split(client);
    let cdp = cdp::Client::connect(read, write, WAIT);
    let (result, ()) = tokio::join!(
        cdp.send(
            "Page.captureSnapshot",
            json!({"format":"mhtml"}),
            Some("page"),
            None,
            None
        ),
        async {
            let mut bytes = Vec::new();
            while chrome.read_u8().await.unwrap() != 0 {}
            bytes.extend_from_slice(b"{\"id\":1,\"result\":{\"data\":\"");
            bytes.resize(bytes.len() + 3 * 1024 * 1024, b'x');
            bytes.extend_from_slice(b"\"}}\0");
            chrome.write_all(&bytes).await.unwrap();
        }
    );
    assert_eq!(
        result.unwrap()["data"].as_str().unwrap().len(),
        3 * 1024 * 1024
    );
    cdp.shutdown().await.unwrap();
}
