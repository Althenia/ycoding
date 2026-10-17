mod support;
mod telemetry_support;

use prost::Message;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock, mpsc},
    time::Duration,
};
use support::{CATALOG, Client, machine, record, rejected, session_scope, success, text, units};
use telemetry_support::{batch, consent, query};
use tokio::time::timeout;
use ycoding_core::process::guardrails::{Limits, Paths, Settings};
use ycoding_core::resources::{agent, model::quota};
use ycoding_core::session::{
    execution::{Execution, Locations, Runner},
    run_coordinator, store,
};
use ycoding_core::ycoding_schema::{
    DomainDecode, LosslessString, location, model, parse_json, provider, provider_usage,
    schema::NonNegativeInt,
};
use ycoding_core::ycoding_store::{
    KeyPart, Metadata, Options, Store, analytics, project,
    resources::{Request, RequestTable, UsageAnalyticsRequest, UsageAnalyticsRequestTable},
    session::{Document, NewEvent, SessionTable},
    tuple_key,
};
use ycoding_protocol::{connection::Budgets, connection::Outcome, v5};
use ycoding_runtime::{
    Configuration, Core, Identity, LocalAuth, ProviderUsageServices, Services, SnapshotSettings,
    serve_with, standard,
};

const FIRST_ROWS: usize = 6;
const OVERFLOW_ROWS: usize = analytics::INTENT_LIMIT + 1;
const HEAVY: &str = "SELECT sum(i::HUGEINT * (i % 97)) FROM range(1000000000000) t(i)";

struct NoRunner;
impl Locations for NoRunner {
    fn get(&self, _: &location::Ref) -> Result<Arc<dyn Runner>, run_coordinator::Error> {
        Err(run_coordinator::Error::Closed)
    }
}

struct Flow {
    core: Core,
    store: ycoding_core::ycoding_store::Client,
    quota: Arc<quota::Service>,
}

fn flow() -> &'static Flow {
    static FLOW: OnceLock<Flow> = OnceLock::new();
    FLOW.get_or_init(|| {
        let path = match std::env::var_os("YCODING_REPORT_FLOW_STORE") {
            Some(path) => PathBuf::from(path),
            None => std::env::temp_dir()
                .join(format!(
                    "ycoding-report-flow-runtime-{}",
                    std::process::id()
                ))
                .join("runtime.redb"),
        };
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let fresh = !path.exists();
        let store = if fresh {
            Store::initialize(&path, Options::core(), CATALOG, Metadata::new([67; 16], 1)).unwrap()
        } else {
            Store::open(&path, Options::core(), CATALOG).unwrap()
        };
        if fresh {
            store
                .submit(|tx| {
                    project::ProjectTable::insert(
                        tx,
                        &project::Project {
                            id: "prj_one".into(),
                            worktree: "/project".into(),
                            vcs: None,
                            name: None,
                            icon_url: None,
                            icon_url_override: None,
                            icon_color: None,
                            time_created: 1,
                            time_updated: 1,
                            time_initialized: None,
                            sandboxes: vec![],
                            commands: None,
                        },
                    )
                })
                .unwrap()
                .wait()
                .unwrap();
        }
        let client = store.client();
        std::mem::forget(store);
        let execution = Execution::install(
            store::Service::new(client.clone()),
            Arc::new(NoRunner),
            ycoding_core::job::Jobs::new(),
            None,
        )
        .unwrap();
        let credentials = ycoding_core::resources::credential::Service::new(client.clone());
        let quota =
            Arc::new(quota::Service::new(credentials, quota::Endpoints::default()).unwrap());
        let mut core = Core::new(client.clone(), execution, configuration());
        core.provider_usage = Some(Arc::new({
            let quota = quota.clone();
            move |_| {
                Ok(ProviderUsageServices {
                    quota: quota.clone(),
                    providers: vec![provider::Id("muse".into())],
                })
            }
        }));
        Flow {
            core,
            store: client,
            quota,
        }
    })
}

fn configuration() -> Configuration {
    Configuration {
        helpers: None,
        agents: Arc::new(agent::Service::new(vec![agent::empty("build".into())])),
        publisher: Arc::new(|_| Ok(())),
        guardrails: Settings {
            paths: Paths {
                workdir: "".into(),
                project: "".into(),
                home: "/home/operator".into(),
                tmpdir: None,
                trusted_paths: vec![],
            },
            global_roots: vec![],
            custom: Arc::new(Vec::new),
            enabled: true,
            limits: Limits::default(),
            decide_reviews: false,
            decide_hard_reviews: true,
        },
        snapshots: SnapshotSettings {
            git: Arc::new(ycoding_core::platform::git::Service::new(16 * 1024 * 1024)),
            data: std::env::temp_dir().join(format!(
                "ycoding-report-flow-snapshots-{}",
                std::process::id()
            )),
            enabled: false,
        },
    }
}

async fn serve() -> (ycoding_runtime::Server, Client) {
    let services = Services {
        identity: Identity {
            version: "9.9.9-test".into(),
            pid: std::process::id() as u64,
            source_epoch: "source-epoch-test".into(),
        },
        auth: LocalAuth::disabled(),
        cors: Vec::new(),
        budgets: Budgets::default(),
        core: Some(flow().core.clone()),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let server = serve_with(listener, services, standard().unwrap())
        .await
        .unwrap();
    let client = Client::open(server.address(), &[]).await.unwrap();
    (server, client)
}

struct Analytics {
    directory: PathBuf,
    stop: Option<mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Analytics {
    fn start(directory: &Path) -> Self {
        let (ready, started) = mpsc::sync_channel(1);
        let (stop, stopped) = mpsc::channel();
        let client = flow().store.clone();
        let private = directory.to_owned();
        let thread = std::thread::spawn(move || {
            let engine = analytics::reports::start(client.clone(), &private).unwrap();
            let handle = engine.handle();
            if client
                .snapshot()
                .unwrap()
                .get::<analytics::DeliveryTable>(&[])
                .unwrap()
                .is_some_and(|delivery| delivery.purge_all || !delivery.purges.is_empty())
            {
                handle.purge().unwrap();
            }
            handle.rebuild().unwrap();
            ready.send(()).unwrap();
            stopped.recv().unwrap();
            engine.shutdown().unwrap();
        });
        started.recv().unwrap();
        Self {
            directory: directory.to_owned(),
            stop: Some(stop),
            thread: Some(thread),
        }
    }
    fn stop(mut self) -> PathBuf {
        self.stop.take().unwrap().send(()).unwrap();
        self.thread.take().unwrap().join().unwrap();
        self.directory.clone()
    }
}

fn derived_file(directory: &Path) -> PathBuf {
    std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.extension()
                .is_some_and(|extension| extension == "duckdb")
        })
        .unwrap()
}

#[derive(Clone)]
struct Usage {
    rows: BTreeMap<String, f64>,
}
impl Usage {
    fn logical(&self) -> u64 {
        self.rows.len() as u64
    }
    fn cost(&self) -> f64 {
        self.rows.values().sum()
    }
    fn reasoning(&self) -> f64 {
        3.0 * self.rows.len() as f64
    }
}

fn request(id: &str, session: &str, order: i64, cost: f64) -> Request {
    Request {
        id: id.into(),
        session_id: session.into(),
        input_id: None,
        assistant_message_id: None,
        connection_identity_digest: None,
        source: "step".into(),
        agent: "build".into(),
        model: Document::from_domain(&model::Ref {
            id: "model_flow".into(),
            provider_id: provider::Id("openai".into()),
            variant: None,
            profile: None,
        })
        .unwrap(),
        route_id: "private-route".into(),
        prompt_cache_key: "private-namespace".into(),
        system_digest: "private-system".into(),
        tool_digest: "private-tool".into(),
        request: order,
        attempts: 1,
        invalidation: "first-request".into(),
        continuation: "full".into(),
        cache_read_reported: Some(1),
        timing: None,
        cost: Some(cost),
        tokens: Document::new(
            parse_json(r#"{"input":10,"output":2,"reasoning":3,"cache":{"read":4,"write":5}}"#)
                .unwrap(),
        )
        .unwrap(),
        time_created: 1_761_438_600_000 + order,
        usage_anchor: None,
    }
}

async fn insert_usage(usage: &mut Usage, from: usize, to: usize, sessions: &[&str]) {
    for chunk in (from..to).collect::<Vec<_>>().chunks(256) {
        let rows = chunk
            .iter()
            .map(|index| {
                let session = sessions[index % sessions.len()];
                (
                    format!("prq_flow_{index}"),
                    session.to_owned(),
                    *index as i64 + 1,
                    (*index % 5) as f64,
                )
            })
            .collect::<Vec<_>>();
        for row in &rows {
            usage.rows.insert(row.0.clone(), row.3);
        }
        flow()
            .store
            .submit(move |tx| {
                for row in &rows {
                    let ledger = request(&row.0, &row.1, row.2, row.3);
                    RequestTable::insert(tx, &ledger)?;
                    let session = tx
                        .get::<SessionTable>(&tuple_key(&[KeyPart::String(&ledger.session_id)]))?
                        .unwrap();
                    UsageAnalyticsRequestTable::insert(
                        tx,
                        &UsageAnalyticsRequest {
                            id: ledger.id,
                            session_id: ledger.session_id,
                            project_id: session.project_id,
                            directory: session.directory,
                            workspace_id: session.workspace_id,
                            session_updated: session.time_updated,
                            agent: ledger.agent,
                            source: ledger.source,
                            model: ledger.model,
                            usage_anchor: None,
                            task_path: Document::new(parse_json("[]").unwrap())?,
                            request: ledger.request,
                            attempts: ledger.attempts,
                            continuation: ledger.continuation,
                            invalidation: ledger.invalidation,
                            prompt_cache_key: LosslessString::from_utf16(
                                ledger.prompt_cache_key.code_units().take(8).collect(),
                            ),
                            cache_read_reported: ledger.cache_read_reported,
                            tokens: ledger.tokens,
                            cost: ledger.cost,
                            timing: ledger.timing,
                            time_created: ledger.time_created,
                        },
                    )?;
                }
                Ok(())
            })
            .unwrap()
            .await
            .unwrap();
    }
}

async fn delete_usage(usage: &mut Usage, ids: &[&str]) {
    for id in ids {
        usage.rows.remove(*id);
        let identity = tuple_key(&[KeyPart::String(&(*id).into())]);
        flow()
            .store
            .submit(move |tx| {
                RequestTable::delete(tx, &identity)?;
                UsageAnalyticsRequestTable::delete(tx, &identity).map(|_| ())
            })
            .unwrap()
            .await
            .unwrap();
    }
}

async fn read_usage(client: &mut Client) -> Outcome {
    client
        .call(
            "usage.report",
            machine(),
            v5::UsageReportRequest {
                query: v5::UsageReportRequestQuery {
                    group: 5,
                    time_zone: None,
                    from: Some(1_761_438_600_000),
                    to: None,
                    offset: None,
                    limit: None,
                    sort: None,
                    order: None,
                    ..Default::default()
                },
            }
            .encode_to_vec(),
        )
        .await
}

fn assert_usage(outcome: Outcome, expected: &Usage) {
    let report: v5::UsageReportResult = success(outcome);
    assert_eq!(report.data.total.logical, expected.logical());
    assert_eq!(report.data.total.physical, expected.logical());
    assert_eq!(report.data.total.helpers, 0);
    assert_eq!(report.data.total.cost, Some(expected.cost()));
    assert_eq!(report.data.total.tokens.reasoning, expected.reasoning());
}

fn sample() -> v5::TelemetrySample {
    v5::TelemetrySample {
        kind: Some(v5::telemetry_sample::Kind::Value1(
            v5::TelemetryRequestSample {
                kind: 1,
                at: text("2026-10-04T12:00:00.000Z"),
                operation: 8,
                outcome: 1,
                reason: None,
                queue_ms: 5,
                settlement_ms: Some(20),
                total_ms: 25,
            },
        )),
    }
}

async fn telemetry_items(client: &mut Client) -> Result<usize, ()> {
    match client
        .call("telemetry.list", machine(), query(Some(60), None))
        .await
    {
        Outcome::Rejected(_) => Err(()),
        other => Ok(success::<v5::TelemetryListResult>(other)
            .data
            .data
            .items
            .len()),
    }
}

fn prompt_request(session: &str, id: &str) -> Vec<u8> {
    v5::SessionPromptRequest {
        params: v5::SessionPromptRequestParams {
            session_id: text(session),
        },
        payload: v5::SessionPromptRequestPayload {
            id: Some(text(id)),
            text: text("admission probe"),
            files: None,
            agents: None,
            metadata: None,
            delivery: Some(v5::SessionPromptRequestPayloadDelivery::Queue as i32),
            resume: Some(false),
        },
    }
    .encode_to_vec()
}

fn snapshot_request(session: &str) -> Vec<u8> {
    v5::SessionSnapshotRequest {
        params: v5::SessionSnapshotRequestParams {
            session_id: text(session),
        },
        query: v5::SessionSnapshotQuery {
            limit: Some(100),
            before: None,
        },
    }
    .encode_to_vec()
}

fn diagnostics_request(session: &str) -> Vec<u8> {
    v5::SessionDiagnosticsRequest {
        params: v5::SessionDiagnosticsRequestParams {
            session_id: text(session),
        },
    }
    .encode_to_vec()
}

fn messages_request(session: &str) -> Vec<u8> {
    v5::SessionMessagesRequest {
        params: v5::SessionMessagesRequestParams {
            session_id: text(session),
        },
    }
    .encode_to_vec()
}

async fn quota_state(client: &mut Client) -> (i32, i32, i32) {
    let usage: v5::ProviderUsageGetResult = success(
        client
            .call(
                "providerUsage.get",
                v5::Scope {
                    target: Some(v5::scope::Target::Location(text("/project"))),
                },
                v5::ProviderUsageGetRequest {
                    params: v5::ProviderUsageGetRequestParams {
                        provider_id: text("muse"),
                    },
                    query: v5::ProviderUsageQuery {
                        location: None,
                        refresh: Some(false),
                    },
                }
                .encode_to_vec(),
            )
            .await,
    );
    (usage.data.status, usage.data.source, usage.data.stability)
}

struct Canonical {
    prompts: u32,
}
impl Canonical {
    async fn assert_operations(&mut self, client: &mut Client, session: &str, measured: bool) {
        self.prompts += 1;
        let id = format!("msg_flow_prompt_{}", self.prompts);
        let before = flow()
            .core
            .sessions
            .pending_list(&session.parse_id())
            .unwrap()
            .len();
        let _: v5::SessionPromptResult = success(
            client
                .call(
                    "session.prompt",
                    session_scope(session),
                    prompt_request(session, &id),
                )
                .await,
        );
        assert_eq!(
            flow()
                .core
                .sessions
                .pending_list(&session.parse_id())
                .unwrap()
                .len(),
            before + 1
        );
        assert!(
            flow()
                .core
                .sessions
                .promote_next_queued(&session.parse_id(), 100 + i64::from(self.prompts))
                .await
                .unwrap()
        );
        let history: v5::SessionMessagesResult = success(
            client
                .call(
                    "session.messages",
                    session_scope(session),
                    messages_request(session),
                )
                .await,
        );
        assert_eq!(history.data.data.items.len(), self.prompts as usize + 1);
        let snapshot: v5::SessionSnapshotResult = success(
            client
                .call(
                    "session.snapshot",
                    session_scope(session),
                    snapshot_request(session),
                )
                .await,
        );
        assert_eq!(
            snapshot.data.messages.items.len(),
            self.prompts as usize + 1
        );
        assert_eq!(units(&snapshot.data.session.id), session);
        let diagnostics: v5::SessionDiagnosticsResult = success(
            client
                .call(
                    "session.diagnostics",
                    session_scope(session),
                    diagnostics_request(session),
                )
                .await,
        );
        let diagnostics = diagnostics.data.expect("a recorded provider request");
        assert_eq!(diagnostics.requests.as_ref().unwrap().logical, 1);
        let speed = diagnostics
            .generation_speed
            .as_ref()
            .expect("selected model history");
        assert!(speed.model.is_some());
        assert_eq!(speed.latest.is_some(), measured);
        assert_eq!(speed.recent.items.is_empty(), !measured);
        if let Some(latest) = &speed.latest {
            assert_eq!(latest.tokens_per_second, 6.0);
        }
        assert_eq!(snapshot.data.generation_speed, diagnostics.generation_speed);
        assert_eq!(quota_state(client).await, (1, 6, 3));
    }
}

trait ParseId {
    fn parse_id(&self) -> ycoding_core::ycoding_schema::session::Id;
}
impl ParseId for str {
    fn parse_id(&self) -> ycoding_core::ycoding_schema::session::Id {
        ycoding_core::ycoding_schema::session::Id::decode(
            &ycoding_core::ycoding_schema::JsonValue::String(self.into()),
        )
        .unwrap()
    }
}

async fn seed_session(id: &str) {
    let row = record(id);
    flow()
        .store
        .submit(move |tx| SessionTable::insert(tx, &row))
        .unwrap()
        .await
        .unwrap();
}

async fn record_provider_request(session: &str) {
    let service = store::Service::new(flow().store.clone());
    for (kind, suffix, fields) in [
        (
            "session.step.started.1",
            "started",
            r#""agent":"build","model":{"providerID":"p1","id":"m1"}"#,
        ),
        (
            "session.step.ended.1",
            "ended",
            r#""finish":"stop","cost":0,"tokens":{"input":100,"output":2,"reasoning":3,"cache":{"read":4,"write":5}}"#,
        ),
    ] {
        service
            .publish(NewEvent {
                id: format!("evt_flow_{suffix}_{session}").as_str().into(),
                aggregate_id: session.into(),
                created: 12,
                type_: kind.into(),
                data: parse_json(&format!(
                    r#"{{"sessionID":"{session}","assistantMessageID":"msg_diag_{session}",{fields}}}"#
                ))
                .unwrap(),
            })
            .await
            .unwrap();
    }
    store::Service::new(flow().store.clone())
        .publish(NewEvent {
            id: format!("evt_flow_request_{session}").as_str().into(),
            aggregate_id: session.into(),
            created: 12,
            type_: "session.provider.request.recorded.1".into(),
            data: parse_json(&format!(
                r#"{{"sessionID":"{session}","id":"prq_diag_{session}","source":"step","agent":"build","model":{{"providerID":"p1","id":"m1"}},"routeID":"unknown","promptCacheKey":"namespace","systemDigest":"system","toolDigest":"tools","request":1,"attempts":2,"invalidation":"provider-not-reported","continuation":"full","tokens":{{"input":100,"output":2,"reasoning":3,"cache":{{"read":4,"write":5}}}},"timing":{{"generatedTokens":12,"generationDurationNs":2000000000}},"time":12}}"#
            ))
            .unwrap(),
        })
        .await
        .unwrap();
}

fn observe_quota() {
    flow()
        .quota
        .observe(
            provider_usage::Observation {
                provider_id: provider::Id("muse".into()),
                label: "Muse (Meta)".into(),
                source: "response_stream".into(),
                stability: "observed".into(),
                observed_at: NonNegativeInt::new(100).unwrap(),
                windows: vec![provider_usage::Window {
                    id: "window".into(),
                    label: "5-hour window".into(),
                    unit: "percent".into(),
                    used: Some(0.0),
                    limit: None,
                    remaining: None,
                    unlimited: None,
                    reset_at: Some(NonNegativeInt::new(1791876076000).unwrap()),
                    period_seconds: Some(NonNegativeInt::new(18000).unwrap()),
                }],
            },
            None,
        )
        .unwrap();
}

fn consent_enabled() -> bool {
    flow()
        .store
        .snapshot()
        .unwrap()
        .get::<ycoding_core::ycoding_store::resources::ConsentTable>(&tuple_key(&[KeyPart::I64(1)]))
        .unwrap()
        .is_some_and(|row| row.enabled == 1)
}

fn delivery() -> analytics::Delivery {
    flow()
        .store
        .snapshot()
        .unwrap()
        .get::<analytics::DeliveryTable>(&[])
        .unwrap()
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test_067_canonical_operations_and_report_reads_through_duckdb_outage_overflow_hold_and_restore()
 {
    timeout(Duration::from_secs(600), async {
        let directory = std::env::temp_dir().join(format!(
            "ycoding-report-flow-derived-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        for session in [
            "ses_flow_main",
            "ses_flow_use0",
            "ses_flow_use1",
            "ses_flow_use2",
        ] {
            seed_session(session).await;
        }
        let mut usage = Usage {
            rows: BTreeMap::new(),
        };
        insert_usage(
            &mut usage,
            0,
            FIRST_ROWS,
            &["ses_flow_use0", "ses_flow_use1", "ses_flow_use2"],
        )
        .await;
        record_provider_request("ses_flow_main").await;
        observe_quota();
        let (server, mut client) = serve().await;
        let mut canonical = Canonical { prompts: 0 };

        let enabled: v5::TelemetryConsentSetResult = success(
            client
                .call("telemetry.consent.set", machine(), consent(true, 1.0))
                .await,
        );
        assert!(enabled.data.enabled);
        let appended: v5::TelemetryAppendResult = success(
            client
                .call(
                    "telemetry.append",
                    machine(),
                    batch(vec![sample(), sample()]),
                )
                .await,
        );
        assert_eq!(appended.accepted, 2);
        rejected(read_usage(&mut client).await);
        assert_eq!(telemetry_items(&mut client).await, Err(()));
        canonical
            .assert_operations(&mut client, "ses_flow_main", true)
            .await;

        let analytics = Analytics::start(&directory);
        assert_usage(read_usage(&mut client).await, &usage);
        assert_eq!(telemetry_items(&mut client).await, Ok(2));

        let directory = analytics.stop();
        insert_usage(
            &mut usage,
            FIRST_ROWS,
            FIRST_ROWS + OVERFLOW_ROWS,
            &["ses_flow_use0"],
        )
        .await;
        assert!(!delivery().valid);
        rejected(read_usage(&mut client).await);
        canonical
            .assert_operations(&mut client, "ses_flow_main", true)
            .await;
        let analytics = Analytics::start(&directory);
        assert!(delivery().valid);
        assert_usage(read_usage(&mut client).await, &usage);

        let analytics_directory = analytics.stop();
        let backup = analytics_directory.with_extension("backup.duckdb");
        std::fs::copy(derived_file(&analytics_directory), &backup).unwrap();
        delete_usage(&mut usage, &["prq_flow_0", "prq_flow_3"]).await;
        let analytics = Analytics::start(&analytics_directory);
        assert_usage(read_usage(&mut client).await, &usage);
        let analytics_directory = analytics.stop();

        std::fs::copy(&backup, derived_file(&analytics_directory)).unwrap();
        let analytics = Analytics::start(&analytics_directory);
        assert_usage(read_usage(&mut client).await, &usage);

        let handle = flow().store.analytics().unwrap();
        let hold = analytics::Cancellation::default();
        let held = {
            let handle = handle.clone();
            let hold = hold.clone();
            tokio::task::spawn_blocking(move || {
                handle.report_cancellable(
                    vec![analytics::Query {
                        sql: HEAVY,
                        parameters: Vec::new(),
                        max_rows: 1,
                    }],
                    hold,
                )
            })
        };
        let signal = hold.clone();
        tokio::task::spawn_blocking(move || signal.wait_querying())
            .await
            .unwrap()
            .unwrap();
        let mut usage_client = Client::open(server.address(), &[]).await.unwrap();
        let mut telemetry_client = Client::open(server.address(), &[]).await.unwrap();
        let mut revoke_client = Client::open(server.address(), &[]).await.unwrap();
        let control = async {
            while consent_enabled() {
                tokio::task::yield_now().await;
            }
            let mut after = usage.clone();
            delete_usage(&mut after, &["prq_flow_1", "prq_flow_4"]).await;
            hold.cancel();
            after
        };
        let (listed, read, revoked, after) = tokio::join!(
            telemetry_items(&mut telemetry_client),
            read_usage(&mut usage_client),
            async {
                revoke_client
                    .call("telemetry.consent.set", machine(), consent(false, 1.0))
                    .await
            },
            control,
        );
        assert!(matches!(
            held.await.unwrap(),
            Err(analytics::Error::Cancelled)
        ));
        assert!(
            matches!(listed, Err(()) | Ok(0)),
            "revoked facts were returned: {listed:?}"
        );
        let revoked: v5::TelemetryConsentSetResult = success(revoked);
        assert!(!revoked.data.enabled);
        match read {
            Outcome::Rejected(_) => {}
            other => assert_usage(other, &after),
        }
        usage = after;
        assert_usage(read_usage(&mut client).await, &usage);
        assert_eq!(telemetry_items(&mut client).await, Ok(0));
        let disabled = rejected(
            client
                .call("telemetry.append", machine(), batch(vec![sample()]))
                .await,
        );
        assert_eq!(
            disabled.type_name,
            <v5::TelemetryDisabled as prost::Name>::full_name()
        );
        canonical
            .assert_operations(&mut client, "ses_flow_main", false)
            .await;
        analytics.stop();
        server.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

const HISTORY: usize = 130;
const PAGE: u64 = 100;

fn synthetic_request(session: &str, id: &str, content: &str) -> Vec<u8> {
    v5::SessionSyntheticRequest {
        params: v5::SessionSyntheticRequestParams {
            session_id: text(session),
        },
        payload: v5::SessionSyntheticRequestPayload {
            id: Some(text(id)),
            text: text(content),
            description: None,
            metadata: None,
            delivery: None,
            resume: Some(false),
        },
    }
    .encode_to_vec()
}

fn page_request(session: &str, before: Option<&str>) -> Vec<u8> {
    v5::SessionSnapshotRequest {
        params: v5::SessionSnapshotRequestParams {
            session_id: text(session),
        },
        query: v5::SessionSnapshotQuery {
            limit: Some(PAGE),
            before: before.map(text),
        },
    }
    .encode_to_vec()
}

fn texts(snapshot: &v5::SessionSnapshotResult) -> Vec<String> {
    snapshot
        .data
        .messages
        .items
        .iter()
        .map(|info| {
            let Some(v5::session_message_info::Kind::Value4(synthetic)) = &info.kind else {
                panic!("expected a synthetic message");
            };
            units(&synthetic.text)
        })
        .collect()
}

fn labels(range: std::ops::Range<usize>) -> Vec<String> {
    range.map(|index| format!("h{index:03}")).collect()
}

async fn admit_history(
    client: &mut Client,
    address: std::net::SocketAddr,
    session: &str,
    range: std::ops::Range<usize>,
) {
    for index in range.clone() {
        if index > range.start && (index - range.start).is_multiple_of(60) {
            *client = Client::open(address, &[]).await.unwrap();
        }
        let _: v5::SessionSyntheticResult = success(
            client
                .call(
                    "session.synthetic",
                    session_scope(session),
                    synthetic_request(
                        session,
                        &format!("msg_ctx_{index:03}"),
                        &format!("h{index:03}"),
                    ),
                )
                .await,
        );
    }
    assert_eq!(
        flow()
            .core
            .sessions
            .promote_steers(&session.parse_id(), 1_000 + range.end as i64)
            .await
            .unwrap(),
        range.len()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "subprocess-only fixture driven by the restart parent test"]
async fn report_flow_history_child() {
    timeout(Duration::from_secs(120), async {
        let write = std::env::var("YCODING_REPORT_FLOW_MODE").unwrap() == "write";
        if write {
            let mut row = record("ses_ctx");
            row.agent = Some("build".into());
            row.model = Some(
                Document::from_domain(
                    &model::Ref::decode(
                        &parse_json(r#"{"providerID":"p1","id":"m1","variant":"high"}"#).unwrap(),
                    )
                    .unwrap(),
                )
                .unwrap(),
            );
            flow()
                .store
                .submit(move |tx| SessionTable::insert(tx, &row))
                .unwrap()
                .await
                .unwrap();
        }
        let (server, mut client) = serve().await;
        if write {
            admit_history(&mut client, server.address(), "ses_ctx", 0..HISTORY).await;
            server.shutdown().await.unwrap();
            return;
        }
        let selected: v5::SessionGetResult = success(
            client
                .call(
                    "session.get",
                    session_scope("ses_ctx"),
                    v5::SessionGetRequest {
                        params: v5::SessionGetRequestParams {
                            session_id: text("ses_ctx"),
                        },
                    }
                    .encode_to_vec(),
                )
                .await,
        );
        assert_eq!(units(selected.data.agent.as_ref().unwrap()), "build");
        let chosen = selected.data.model.as_ref().unwrap();
        assert_eq!(
            (
                units(&chosen.provider_id),
                units(&chosen.id),
                chosen.variant.as_ref().map(units)
            ),
            ("p1".to_owned(), "m1".to_owned(), Some("high".to_owned()))
        );

        let newest: v5::SessionSnapshotResult = success(
            client
                .call(
                    "session.snapshot",
                    session_scope("ses_ctx"),
                    page_request("ses_ctx", None),
                )
                .await,
        );
        assert_eq!(texts(&newest), labels(HISTORY - PAGE as usize..HISTORY));
        let cursor = units(newest.data.before.as_ref().expect("older history exists"));
        let watermark = newest.data.watermark.seq.unwrap();

        admit_history(
            &mut client,
            server.address(),
            "ses_ctx",
            HISTORY..HISTORY + 1,
        )
        .await;
        let older: v5::SessionSnapshotResult = success(
            client
                .call(
                    "session.snapshot",
                    session_scope("ses_ctx"),
                    page_request("ses_ctx", Some(&cursor)),
                )
                .await,
        );
        assert_eq!(texts(&older), labels(0..HISTORY - PAGE as usize));
        assert!(older.data.before.is_none());
        let refreshed: v5::SessionSnapshotResult = success(
            client
                .call(
                    "session.snapshot",
                    session_scope("ses_ctx"),
                    page_request("ses_ctx", None),
                )
                .await,
        );
        assert_eq!(
            texts(&refreshed),
            labels(HISTORY + 1 - PAGE as usize..HISTORY + 1)
        );
        assert!(refreshed.data.watermark.seq.unwrap() > watermark);

        let sessions = &flow().core.sessions;
        assert_eq!(
            sessions.transcript(&"ses_ctx".parse_id()).unwrap().len(),
            HISTORY + 1
        );

        let forked: v5::SessionForkResult = success(
            client
                .call(
                    "session.fork",
                    session_scope("ses_ctx"),
                    v5::SessionForkRequest {
                        params: v5::SessionForkRequestParams {
                            session_id: text("ses_ctx"),
                        },
                        payload: v5::SessionForkRequestPayload {
                            message_id: Some(text("msg_ctx_100")),
                        },
                    }
                    .encode_to_vec(),
                )
                .await,
        );
        let fork = units(&forked.data.id);
        assert_ne!(fork, "ses_ctx");
        assert_eq!(sessions.transcript(&fork.parse_id()).unwrap().len(), 100);
        assert_eq!(
            sessions.transcript(&"ses_ctx".parse_id()).unwrap().len(),
            HISTORY + 1
        );
        let fork_page: v5::SessionSnapshotResult = success(
            client
                .call(
                    "session.snapshot",
                    session_scope(&fork),
                    page_request(&fork, None),
                )
                .await,
        );
        assert_eq!(texts(&fork_page), labels(0..100));
        assert!(fork_page.data.before.is_none());
        server.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[test]
fn test_062_restarted_selection_and_history_serve_find_timeline_fork_and_export_reads() {
    let directory = std::env::temp_dir().join(format!(
        "ycoding-report-flow-restart-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(&directory).unwrap();
    for mode in ["write", "read"] {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "report_flow_history_child",
                "--ignored",
                "--nocapture",
            ])
            .env("YCODING_REPORT_FLOW_STORE", directory.join("runtime.redb"))
            .env("YCODING_REPORT_FLOW_MODE", mode)
            .status()
            .unwrap();
        assert!(status.success(), "{mode} process");
    }
    std::fs::remove_dir_all(&directory).unwrap();
}
