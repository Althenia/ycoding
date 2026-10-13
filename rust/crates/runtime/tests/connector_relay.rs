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
    ycoding_schema::{JsonValue, parse_json, schema::NonNegativeInt, session, session_message},
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

fn emit(feed: &Feed, index: i64) {
    feed.emit(
        Data::SessionTextDelta(Box::new(Fragment {
            session_id: session::Id::new("ses_real_connector").unwrap(),
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
    let scratch = root.join(format!(".connector-v5-relay-{}", std::process::id()));
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
    let feed = Feed::attach(&world().store);
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
    assert_eq!(feed.subscribers(), 2);
    for index in 0..3 {
        emit(&feed, index);
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
    assert_eq!(feed.subscribers(), 2);
    emit(&feed, 3);
    harness.send("{}");
    harness.phase("released-all");
    assert_eq!(feed.subscribers(), 1);
    harness.send("{}");
    harness.child.stdin.take();
    assert!(
        harness.child.wait().unwrap().success(),
        "real relay harness failed; inspect worker.log"
    );
    connector.shutdown().await.unwrap();
    assert_eq!(feed.subscribers(), 0);
}
