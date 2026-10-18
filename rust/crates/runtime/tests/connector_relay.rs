mod connector_status_support;
mod support;

use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdout, Command, Stdio},
    sync::Arc,
};
use support::{services, world};
use ycoding_core::{
    event_feed::{Data, Feed, ephemeral::Fragment},
    remote::Enrollment,
    ycoding_schema::{
        DomainDecode, JsonValue, form, parse_json, schema::NonNegativeInt, session, session_message,
    },
};
use ycoding_runtime::{
    Environment, LocalAuth, Subscriptions,
    connector::{Connector, Control, Settings, State},
    standard,
};

struct Harness {
    child: Child,
    output: BufReader<ChildStdout>,
}

impl Harness {
    fn phase(&mut self, phase: &str) -> JsonValue {
        loop {
            let mut line = String::new();
            assert!(
                self.output.read_line(&mut line).unwrap() > 0,
                "Worker harness ended before {phase}"
            );
            if !line.starts_with("{\"phase\":") {
                continue;
            }
            let value = parse_json(line.trim()).unwrap();
            assert_eq!(field(&value, "phase"), phase);
            return value;
        }
    }
    fn send(&mut self, message: &str) {
        writeln!(self.child.stdin.as_mut().unwrap(), "{message}").unwrap();
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.child.stdin.take();
        let _ = self.child.wait();
    }
}

fn field(value: &JsonValue, name: &str) -> String {
    let JsonValue::Object(object) = value else {
        panic!("expected harness object");
    };
    let Some(JsonValue::String(value)) = object.get(&name.into()) else {
        panic!("missing harness field {name}");
    };
    value.to_utf8().unwrap()
}

fn emit(feed: &Feed, owner: &str, index: i64) {
    feed.emit(
        Data::SessionTextDelta(Box::new(Fragment {
            session_id: session::Id::new(owner).unwrap(),
            assistant_message_id: session_message::Id::new("msg_real_connector").unwrap(),
            ordinal: NonNegativeInt::new(index).unwrap(),
            delta: format!("live-{index}").into(),
        })),
        None,
    )
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_workerd_enrollment_snapshot_events_and_release_are_driven_by_the_rust_connector() {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .with_test_writer()
        .try_init()
        .unwrap();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap()
        .to_path_buf();
    let scratch = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join(format!(".connector-v5-relay-{}", std::process::id()));
    std::fs::create_dir_all(&scratch).unwrap();
    let mut child = Command::new("bun")
        .arg(root.join("rust/crates/runtime/tests/connector_relay_support.ts"))
        .arg(&scratch)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(std::fs::File::create(scratch.join("worker.log")).unwrap())
        .spawn()
        .unwrap();
    let output = BufReader::new(child.stdout.take().unwrap());
    let mut harness = Harness { child, output };
    let enrollment = harness.phase("enrollment");
    let control = Control::open(&scratch.join("backend")).await.unwrap();
    let device = control
        .device()
        .enroll(
            Enrollment {
                relay_origin: field(&enrollment, "origin"),
                enrollment_id: field(&enrollment, "enrollmentID"),
                code: field(&enrollment, "code"),
                name: Some("Rust connector fixture".into()),
                replace: false,
            },
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64,
        )
        .await
        .unwrap();
    support::insert_session("ses_real_connector", scratch.to_str().unwrap(), None).await;
    support::insert_session("ses_real_other", scratch.to_str().unwrap(), None).await;
    support::insert_message(
        "ses_real_connector",
        "msg_relay_input",
        "user",
        1,
        r#"{"text":"Task","time":{"created":1,"consumed":1}}"#,
    )
    .await;
    support::insert_message("ses_real_connector", "msg_relay_edit", "assistant", 2, r#"{"agent":"build","model":{"providerID":"fixture","id":"model"},"content":[{"type":"tool","id":"relay_edit","name":"patch","state":{"status":"completed","input":{},"content":[],"structured":{"files":[{"file":"relay.txt","patch":"--- /dev/null\n+++ b/relay.txt\n@@ -0,0 +1 @@\n+new\n"}]}},"time":{"created":1,"completed":2}}],"cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":2,"completed":3}}"#).await;
    world()
        .store
        .submit(|tx| {
            ycoding_core::ycoding_store::session::reserve_sequence(
                tx,
                &"ses_real_connector".into(),
                2,
            )
        })
        .unwrap()
        .await
        .unwrap();
    let feed = world().core.events.clone();
    let mut services = services(LocalAuth::disabled(), true);
    services.core.as_mut().unwrap().events = feed.clone();
    let environment = Arc::new(Environment {
        services,
        urls: vec![],
        subscriptions: Subscriptions::default(),
        uploads: Default::default(),
    });
    let connector = Connector::start(
        control.clone(),
        Settings::new(Arc::new(control.device().clone())),
        environment,
        Arc::new(standard().unwrap()),
    )
    .unwrap();
    control.set(true).await.unwrap();
    let mut status = control.observe();
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        status.wait_for(|(_, status)| status.state == State::On),
    )
    .await
    .unwrap()
    .unwrap();
    harness.send(&format!(
        "{{\"deviceID\":\"{}\",\"sourceEpoch\":\"source-epoch-test\"}}",
        device.device_id
    ));
    harness.phase("subscribed");
    assert_eq!(control.status().state, State::On);
    assert_eq!(feed.subscribers(), 3);
    for index in 0..3 {
        emit(&feed, "ses_real_connector", index);
    }
    harness.send("{}");
    harness.phase("live-delivered");
    assert!(
        world()
            .core
            .sessions
            .change(
                &session::Id::new("ses_real_connector").unwrap(),
                ycoding_core::session::lifecycle::Change::Rename("Relay renamed".into())
            )
            .await
            .unwrap()
    );
    harness.send("{}");
    harness.phase("released-one");
    assert_eq!(feed.subscribers(), 3);
    emit(&feed, "ses_real_connector", 3);
    harness.send("{}");
    harness.phase("released-all");
    assert_eq!(feed.subscribers(), 2);
    harness.send("{}");
    harness.phase("notifications-ready");
    let root = session::Id::new("ses_real_connector").unwrap();
    let (_, location) = world().core.locations.session(&root).unwrap();
    let form = form::Info::decode(&parse_json(r#"{"id":"frm_connector_status","sessionID":"ses_real_connector","title":"Runtime approval","fields":[{"key":"approve","type":"boolean"}]}"#).unwrap()).unwrap();
    location.forms.create(form.clone()).unwrap();
    harness.send("{}");
    harness.phase("attention-notified");
    location.forms.cancel(&form.id).unwrap();
    connector_status_support::complete(&world().store, &world().core, &root).await;
    harness.send("{}");
    harness.phase("completion-pushed");
    harness.send("{}");
    harness.phase("oversize-ready");
    for (index, (kind, data)) in [
        ("session.step.started.1", parse_json(r#"{"assistantMessageID":"msg_real_oversized","agent":"build","model":{"providerID":"fixture","id":"model"}}"#).unwrap()),
        ("session.text.started.1", parse_json(r#"{"assistantMessageID":"msg_real_oversized","ordinal":0}"#).unwrap()),
        ("session.text.ended.1", ycoding_core::ycoding_schema::ObjectEncoder::new().field("assistantMessageID", "msg_real_oversized").field("ordinal", &0_f64).field("text", "x".repeat(2_320_000).as_str()).finish()),
    ].into_iter().enumerate() {
        let JsonValue::Object(mut data) = data else { unreachable!() };
        data.insert("sessionID".into(), JsonValue::String(root.as_lossless().clone()));
        world().core.sessions.publish(ycoding_core::ycoding_store::session::NewEvent {
            id: format!("evt_real_oversized_{index}").into(), aggregate_id: root.as_lossless().clone(),
            created: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64,
            type_: kind.into(), data: JsonValue::Object(data),
        }).await.unwrap();
    }
    emit(&feed, "ses_real_other", 4);
    harness.send("{}");
    harness.phase("oversize-resynced");
    emit(&feed, "ses_real_connector", 4);
    emit(&feed, "ses_real_other", 5);
    harness.send("{}");
    harness.phase("oversize-recovered");
    assert_eq!(control.status().state, State::On);
    harness.send("{}");
    harness.child.stdin.take();
    assert!(
        harness.child.wait().unwrap().success(),
        "real relay harness failed; inspect worker.log"
    );
    connector.shutdown().await.unwrap();
    assert_eq!(feed.subscribers(), 0);
}
