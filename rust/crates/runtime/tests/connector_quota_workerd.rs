mod connector_support;
mod remote_derived_support;

use remote_derived_support::{Fixture, Saved, now, world};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};
use ycoding_core::{
    event_feed::Data,
    remote::Device,
    ycoding_schema::{
        DomainDecode, JsonValue,
        provider_usage::{PaceMilestone, QuotaPaceAlert},
        schema::NonNegativeInt,
    },
};
use ycoding_protocol::OPERATIONS;
use ycoding_runtime::{
    Boxed, Dispatcher,
    connector::{
        Connector, Control, Credential, Credentials, Enrolled, Error, McpFile, Settings, State,
    },
};

const WAIT: Duration = Duration::from_secs(60);
const PHASE_WAIT: Duration = Duration::from_secs(180);

struct WorkerdAccess {
    origin: String,
    device: String,
    token: String,
}

impl Credentials for WorkerdAccess {
    fn enrolled(&self) -> Boxed<Result<Enrolled, Error>> {
        let enrolled = Enrolled::new(&self.origin, self.device.clone());
        Box::pin(async move { enrolled })
    }

    fn access(&self) -> Boxed<Result<Credential, Error>> {
        let credential = Credential::new(
            self.token.clone(),
            now() + 600_000,
            self.origin.clone(),
            self.device.clone(),
        );
        Box::pin(async move { Ok(credential) })
    }
}

fn required(name: &str) -> String {
    let value = std::env::var(name).unwrap_or_else(|_| {
        panic!(
            "{name} is required; run this fixture through infra/cloudflare/test/integration/binary-flow.ts --group=quota"
        )
    });
    assert!(!value.is_empty(), "{name} must not be empty");
    value
}

fn alert(window: &str, milestone: &str, reset_at: u64) -> Data {
    Data::ProviderQuotaPace(Box::new(QuotaPaceAlert {
        provider_id: DomainDecode::decode(&JsonValue::String("openai".into())).unwrap(),
        window_id: window.into(),
        milestone: PaceMilestone(milestone.into()),
        reset_at: NonNegativeInt::new(reset_at as i64).unwrap(),
        title: "Fixed title".into(),
        body: "Fixed body".into(),
    }))
}

fn write_phase(dir: &Path, name: &str) {
    std::fs::write(dir.join(name), "").unwrap();
}

async fn wait_phase(dir: &Path, name: &str) {
    let path = dir.join(name);
    tokio::time::timeout(PHASE_WAIT, async {
        while !path.exists() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("host phase {name} not reached"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires the binary-flow --group=quota workerd fixture via YCODING_TEST_QUOTA_* environment"]
async fn quota_connector_delivers_through_workerd() {
    let origin = required("YCODING_TEST_QUOTA_RELAY_ORIGIN");
    let device = required("YCODING_TEST_QUOTA_DEVICE_ID");
    let token = required("YCODING_TEST_QUOTA_DEVICE_TOKEN");
    let window = required("YCODING_TEST_QUOTA_WINDOW");
    let reset_at: u64 = required("YCODING_TEST_QUOTA_RESET_AT").parse().unwrap();
    let phases = PathBuf::from(required("YCODING_TEST_QUOTA_PHASE_DIR"));

    let fixture = Fixture::new().await;
    let state = fixture.path.join("quota-state");
    std::fs::create_dir(&state).unwrap();
    let control = Control::load_with_mcp(
        Arc::new(Saved(AtomicBool::new(true))),
        Arc::new(McpFile(state.join("remote-mcp.json"))),
        Device::new(&state.join("device")).unwrap(),
        fixture.path.clone(),
    )
    .await;
    let mut environment = Arc::into_inner(fixture.environment(true)).unwrap();
    environment.services.core.as_mut().unwrap().remote = Some(control.clone());
    let mut dispatcher = Dispatcher::new(OPERATIONS.clone());
    ycoding_runtime::connector::register(&mut dispatcher).unwrap();
    let connector = Connector::start(
        control.clone(),
        Settings::new(Arc::new(WorkerdAccess {
            origin,
            device,
            token,
        })),
        Arc::new(environment),
        Arc::new(dispatcher),
    )
    .unwrap();
    tokio::time::timeout(
        WAIT,
        control
            .observe()
            .wait_for(|(_, status)| status.state == State::On),
    )
    .await
    .unwrap()
    .unwrap();

    let events = &world().core.events;
    events
        .emit(alert(&window, "almost-out", reset_at), None)
        .unwrap();
    write_phase(&phases, "emitted-1");
    wait_phase(&phases, "emit-marker").await;
    events
        .emit(
            alert(&format!("{window}-marker"), "cutting-it-close", reset_at),
            None,
        )
        .unwrap();
    write_phase(&phases, "emitted-marker");
    wait_phase(&phases, "evicted").await;
    events
        .emit(
            alert(&format!("{window}-b"), "will-run-out", reset_at),
            None,
        )
        .unwrap();
    write_phase(&phases, "emitted-2");
    wait_phase(&phases, "release").await;

    connector.shutdown().await.unwrap();
    fixture.close().await;
}
