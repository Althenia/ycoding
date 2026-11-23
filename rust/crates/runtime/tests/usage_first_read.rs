#[allow(dead_code)]
#[path = "support/launcher.rs"]
mod launcher;
mod support;

use launcher::{Directory, Runtime};
use std::time::{SystemTime, UNIX_EPOCH};
use support::{Client, basic, machine, session_scope, text, units, wire};
use ycoding_core::ycoding_schema::parse_json;
use ycoding_core::ycoding_store::{Options, Store, native, resources::Request, session::Document};
use ycoding_protocol::v5;

const PASSWORD: &str = "synthetic-usage-fixture";

async fn start(directory: &Directory) -> (Runtime, Client) {
    let mut command = directory.command("test-v1", "latest");
    command
        .current_dir(&directory.0)
        .env("YCODING_PASSWORD", PASSWORD);
    let runtime = Runtime::spawn(command, &["serve", "--stdio", "--port", "0"]);
    let ready = parse_json(&runtime.ready()).unwrap();
    let address = launcher::string(&ready, "url")
        .strip_prefix("http://")
        .unwrap()
        .parse()
        .unwrap();
    let client = Client::open(address, &[("authorization", basic(PASSWORD))])
        .await
        .unwrap();
    (runtime, client)
}

fn stop(mut runtime: Runtime, client: Client) {
    drop(client);
    drop(runtime.child.stdin.take());
    assert!(runtime.wait().success());
}

#[tokio::test]
async fn first_usage_read_returns_the_persisted_totals_without_a_warmup_request() {
    let directory = Directory::new();
    let (runtime, mut client) = start(&directory).await;
    let location = directory.0.to_str().unwrap();
    let session: v5::SessionCreateResult = wire::ask(
        &mut client,
        "session.create",
        wire::location_scope(location),
        v5::SessionCreateRequest {
            payload: v5::SessionCreateRequestPayload {
                location: Some(v5::LocationRef {
                    directory: text(location),
                    workspace_id: None,
                }),
                ..Default::default()
            },
        },
    )
    .await;
    let id = units(&session.data.id);
    stop(runtime, client);

    let store = Store::open(
        directory.0.join("data/ycoding/core.redb"),
        Options::core(),
        native::catalog(native::DatabaseKind::Core),
    )
    .unwrap();
    let row = Request {
        id: "prq_first_usage_read".into(),
        session_id: id.as_str().into(),
        input_id: None,
        assistant_message_id: None,
        connection_identity_digest: None,
        source: "step".into(),
        agent: "build".into(),
        model: Document::new(parse_json(r#"{"providerID":"fixture","id":"model"}"#).unwrap())
            .unwrap(),
        route_id: "fixture-route".into(),
        prompt_cache_key: "fixture-cache".into(),
        system_digest: "fixture-system".into(),
        tool_digest: "fixture-tools".into(),
        request: 1,
        attempts: 1,
        invalidation: "first-request".into(),
        continuation: "full".into(),
        cache_read_reported: None,
        timing: None,
        cost: None,
        tokens: Document::new(
            parse_json(r#"{"input":5,"output":2,"reasoning":0,"cache":{"read":0,"write":0}}"#)
                .unwrap(),
        )
        .unwrap(),
        time_created: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64,
        usage_anchor: None,
        outcome: Some("completed".into()),
    };
    store
        .submit(move |tx| support::usage::retained(tx, &row))
        .unwrap()
        .wait()
        .unwrap();
    store.shutdown().unwrap();

    let (runtime, mut client) = start(&directory).await;
    let summary: v5::SessionUsageResult = wire::ask(
        &mut client,
        "session.usage",
        session_scope(&id),
        v5::SessionUsageRequest {
            params: v5::SessionUsageRequestParams {
                session_id: text(&id),
            },
        },
    )
    .await;
    assert_eq!(
        (
            summary.data.logical,
            summary.data.tokens.input,
            summary.data.tokens.output
        ),
        (1, 5.0, 2.0)
    );
    let report: v5::SessionUsageReportResult = wire::ask(
        &mut client,
        "session.usageReport",
        session_scope(&id),
        v5::SessionUsageReportRequest {
            params: v5::SessionUsageReportRequestParams {
                session_id: text(&id),
            },
            query: query(),
        },
    )
    .await;
    assert_eq!(report.data.total.logical, 1);
    stop(runtime, client);

    let (runtime, mut client) = start(&directory).await;
    let report: v5::UsageReportResult = wire::ask(
        &mut client,
        "usage.report",
        machine(),
        v5::UsageReportRequest { query: query() },
    )
    .await;
    assert_eq!(report.data.total.logical, 1);
    let summary: v5::UsageGetResult =
        wire::ask(&mut client, "usage.get", machine(), v5::UsageGetRequest {}).await;
    assert_eq!(
        (
            summary.data.logical,
            summary.data.tokens.input,
            summary.data.tokens.output
        ),
        (1, 5.0, 2.0)
    );
    stop(runtime, client);
}

fn query() -> v5::SessionUsageReportQuery {
    v5::SessionUsageReportQuery {
        group: 1,
        ..Default::default()
    }
}
