use std::{
    ops::Bound,
    sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
    },
};
use ycoding_core::{
    telemetry::{Error, MAX_ROWS, RETENTION_MS, Service},
    ycoding_schema::{DomainDecode, DomainEncode, parse_json, telemetry},
    ycoding_store::{
        Catalog, Metadata, Options, Store, TableDeclaration, analytics, resources,
        session::Document,
    },
};

const CATALOG: Catalog = Catalog::new(
    1,
    &[
        TableDeclaration::of::<resources::ConsentTable>(),
        TableDeclaration::of::<resources::LatencyTable>(),
        TableDeclaration::of::<resources::SequenceTable>(),
        TableDeclaration::of::<resources::RequestTable>(),
        TableDeclaration::of::<resources::UsageTable>(),
        TableDeclaration::of::<ycoding_store::project::ProjectTable>(),
        TableDeclaration::of::<ycoding_store::session::SessionTable>(),
        TableDeclaration::of::<analytics::DeliveryTable>(),
        TableDeclaration::of::<analytics::IntentTable>(),
    ],
);
#[path = "report_support/mod.rs"]
mod report_support;
struct ReportStore {
    _reports: report_support::Reports,
    store: Option<Store>,
}
impl std::ops::Deref for ReportStore {
    type Target = Store;
    fn deref(&self) -> &Store {
        self.store.as_ref().unwrap()
    }
}
impl ReportStore {
    fn shutdown(mut self) -> Result<(), ycoding_store::Error> {
        self.store.take().unwrap().shutdown()
    }
}
fn sample() -> telemetry::Sample {
    telemetry::Sample::decode(&parse_json(r#"{"kind":"request","at":"2026-10-04T12:00:00.000Z","operation":"session.list","outcome":"ok","queueMs":5,"settlementMs":20,"totalMs":25}"#).unwrap()).unwrap()
}
fn world() -> (ReportStore, Service, Arc<AtomicI64>) {
    let store = Store::disposable(Options::core(), CATALOG, Metadata::new([1; 16], 1)).unwrap();
    let time = Arc::new(AtomicI64::new(0));
    let clock = time.clone();
    let service = Service::with_clock(
        store.client(),
        Arc::new(move || clock.load(Ordering::SeqCst)),
    );
    let reports = report_support::start(store.client());
    (
        ReportStore {
            _reports: reports,
            store: Some(store),
        },
        service,
        time,
    )
}
async fn consent(service: &Service, enabled: bool) {
    service
        .set_consent(telemetry::ConsentInput {
            enabled,
            notice_version: telemetry::NoticeVersion,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn defaults_version_fences_opt_out_purge_and_no_disabled_writes() {
    let (store, service, _) = world();
    assert!(service.consent().unwrap().consent.is_none());
    assert_eq!(service.append(vec![sample()]).await, Err(Error::Disabled));
    assert!(service.list(None, None).await.unwrap().data.is_empty());
    consent(&service, true).await;
    assert_eq!(
        service.consent().unwrap().consent.unwrap().decided_at.get(),
        0
    );
    service.append(vec![sample()]).await.unwrap();
    store
        .client()
        .submit(|tx| {
            resources::ConsentTable::put(
                tx,
                &resources::Consent {
                    id: 1,
                    enabled: 1,
                    notice_version: 2,
                    decided_at: 0,
                },
            )
        })
        .unwrap()
        .await
        .unwrap();
    assert_eq!(service.append(vec![sample()]).await, Err(Error::Disabled));
    assert!(service.list(None, None).await.unwrap().data.is_empty());
    assert_eq!(service.consent(), Err(Error::InvalidConsent));
    store
        .client()
        .submit(|tx| {
            resources::ConsentTable::put(
                tx,
                &resources::Consent {
                    id: 1,
                    enabled: 1,
                    notice_version: 1,
                    decided_at: -1,
                },
            )
        })
        .unwrap()
        .await
        .unwrap();
    assert_eq!(service.consent(), Err(Error::InvalidConsent));
    assert_eq!(service.append(vec![sample()]).await, Err(Error::Disabled));
    assert!(service.list(None, None).await.unwrap().data.is_empty());
    consent(&service, false).await;
    assert!(
        store
            .client()
            .snapshot()
            .unwrap()
            .scan::<resources::LatencyTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap()
            .is_empty()
    );
    consent(&service, true).await;
    assert!(service.list(None, None).await.unwrap().data.is_empty());
    store.shutdown().unwrap();
}

#[tokio::test]
async fn validates_batch_sample_bounds_calendar_reason_arithmetic_and_privacy() {
    let (store, service, _) = world();
    consent(&service, true).await;
    for size in [0, 21] {
        assert_eq!(
            service.append(vec![sample(); size]).await,
            Err(Error::InvalidSample)
        );
    }
    assert_eq!(service.append(vec![sample(); 20]).await.unwrap(), 20);
    for value in [
        r#"{"kind":"request","at":"2026-02-30T12:00:00.000Z","operation":"session.list","outcome":"ok","queueMs":5,"settlementMs":20,"totalMs":25}"#,
        r#"{"kind":"request","at":"2026-10-04T12:00:00.000Z","operation":"session.list","outcome":"ok","queueMs":5,"settlementMs":19,"totalMs":25}"#,
        r#"{"kind":"request","at":"2026-10-04T12:00:00.000Z","operation":"session.list","outcome":"ok","reason":"cancelled","queueMs":5,"totalMs":5}"#,
        r#"{"kind":"request","at":"2026-10-04T12:00:00.000Z","operation":"session.list","outcome":"unavailable","queueMs":5,"totalMs":6}"#,
    ] {
        assert_eq!(
            service
                .append(vec![
                    telemetry::Sample::decode(&parse_json(value).unwrap()).unwrap()
                ])
                .await,
            Err(Error::InvalidSample)
        );
    }
    for value in [
        r#"{"kind":"long-task","at":"2026-10-04T12:00:00.000Z","durationMs":49}"#,
        r#"{"kind":"client","at":"2026-10-04T12:00:00.000Z","surface":"web","metric":"prompt.admit","durationMs":600001}"#,
        r#"{"kind":"client","at":"2026-10-04T12:00:00.000Z","surface":"web","metric":"prompt.admit","durationMs":1,"account":"synthetic-private"}"#,
        r#"{"kind":"request","at":"2026-10-04T12:00:00.000Z","operation":"session.private-id","outcome":"ok","queueMs":0,"totalMs":0}"#,
    ] {
        assert!(telemetry::Sample::decode(&parse_json(value).unwrap()).is_err());
    }
    let mut invalid = sample();
    if let telemetry::Sample::Request(row) = &mut invalid {
        row.queue_ms = ycoding_core::ycoding_schema::schema::Int::new(-1).unwrap();
    }
    assert_eq!(
        service.append(vec![invalid]).await,
        Err(Error::InvalidSample)
    );
    let page = service.list(None, None).await.unwrap();
    assert_eq!(page.data.len(), 20);
    let encoded = ycoding_core::ycoding_schema::stringify_json(&page.encode());
    for excluded in [
        "sessionID",
        "account",
        "credential",
        "payload",
        "receivedAt\":1",
    ] {
        assert!(!encoded.contains(excluded));
    }
    assert!(
        telemetry::ConsentInput::decode(
            &parse_json(r#"{"enabled":true,"noticeVersion":2}"#).unwrap()
        )
        .is_err()
    );
    assert!(
        telemetry::ConsentInput::decode(
            &parse_json(r#"{"enabled":true,"noticeVersion":1,"extra":true}"#).unwrap()
        )
        .is_err()
    );
    store.shutdown().unwrap();
}

#[tokio::test]
async fn receipt_clock_newest_pages_all_sample_kinds_and_canonical_cursors() {
    let (store, service, time) = world();
    consent(&service, true).await;
    time.store(123, Ordering::SeqCst);
    let task = telemetry::Sample::decode(
        &parse_json(r#"{"kind":"long-task","at":"2024-02-29T12:00:00.000Z","durationMs":50}"#)
            .unwrap(),
    )
    .unwrap();
    let client = telemetry::Sample::decode(&parse_json(r#"{"kind":"client","at":"2026-10-04T12:00:00.000Z","surface":"tui","metric":"stream.delay","durationMs":600000}"#).unwrap()).unwrap();
    service
        .append(vec![sample(), task.clone(), client.clone()])
        .await
        .unwrap();
    let first = service.list(Some(1), None).await.unwrap();
    assert_eq!(first.data[0].sample, client);
    assert_eq!(first.data[0].received_at.get(), 123);
    assert_eq!(first.cursor.next.as_ref().unwrap().as_str(), Some("Mw"));
    let second = service
        .list(Some(1), first.cursor.next.as_ref().unwrap().as_str())
        .await
        .unwrap();
    assert_eq!(second.data[0].sample, task);
    let third = service
        .list(Some(1), second.cursor.next.as_ref().unwrap().as_str())
        .await
        .unwrap();
    assert_eq!(third.data[0].sample, sample());
    assert!(third.cursor.next.is_none());
    for cursor in [
        "",
        "not-a-cursor",
        "MA",
        "MDE",
        "Mw==",
        "Mx",
        "LTE",
        "OTAwNzE5OTI1NDc0MDk5Mg",
        "IA",
    ] {
        assert_eq!(
            service.list(None, Some(cursor)).await,
            Err(Error::InvalidCursor),
            "{cursor}"
        );
    }
    for limit in [0, 201] {
        assert_eq!(
            service.list(Some(limit), None).await,
            Err(Error::InvalidLimit)
        );
    }
    store.shutdown().unwrap();
}

#[tokio::test]
async fn retention_boundary_read_write_housekeeping_and_ten_thousand_cap() {
    let (store, service, time) = world();
    consent(&service, true).await;
    service.append(vec![sample()]).await.unwrap();
    time.store(RETENTION_MS, Ordering::SeqCst);
    assert_eq!(service.list(None, None).await.unwrap().data.len(), 1);
    time.fetch_add(1, Ordering::SeqCst);
    service.prune().await.unwrap();
    assert!(service.list(None, None).await.unwrap().data.is_empty());
    let value = Document::from_domain(&sample()).unwrap();
    store
        .client()
        .submit(move |tx| {
            for _ in 0..MAX_ROWS {
                resources::append_latency(tx, RETENTION_MS + 1, &value)?;
            }
            Ok(())
        })
        .unwrap()
        .await
        .unwrap();
    service.append(vec![sample(), sample()]).await.unwrap();
    let snapshot = store.client().snapshot().unwrap();
    let rows = snapshot
        .scan::<resources::LatencyTable>(Bound::Unbounded, Bound::Unbounded, MAX_ROWS + 1)
        .unwrap();
    assert_eq!(rows.len(), MAX_ROWS);
    assert_eq!(rows[0].id, 4);
    drop(snapshot);
    assert_eq!(service.list(None, None).await.unwrap().data.len(), 60);
    time.store(2 * RETENTION_MS + 2, Ordering::SeqCst);
    service.append(vec![sample()]).await.unwrap();
    assert_eq!(service.list(None, None).await.unwrap().data.len(), 1);
    time.store(3 * RETENTION_MS + 3, Ordering::SeqCst);
    let (stop, shutdown) = tokio::sync::watch::channel(false);
    let task_service = service.clone();
    let task = tokio::spawn(async move {
        task_service
            .housekeeping(shutdown, |_| panic!("unexpected housekeeping failure"))
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if store
                .client()
                .snapshot()
                .unwrap()
                .scan::<resources::LatencyTable>(Bound::Unbounded, Bound::Unbounded, 1)
                .unwrap()
                .is_empty()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    stop.send(true).unwrap();
    task.await.unwrap().unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn consent_samples_and_sequence_survive_reopen() {
    let path = std::env::temp_dir().join(format!(
        "ycoding-telemetry-parity-{}.redb",
        std::process::id()
    ));
    let store =
        Store::initialize(&path, Options::core(), CATALOG, Metadata::new([2; 16], 1)).unwrap();
    let service = Service::with_clock(store.client(), Arc::new(|| 42));
    let reports = report_support::start(store.client());
    consent(&service, true).await;
    service.append(vec![sample()]).await.unwrap();
    store.shutdown().unwrap();
    drop(reports);
    let store = Store::open(&path, Options::core(), CATALOG).unwrap();
    let reports = report_support::start(store.client());
    let service = Service::with_clock(store.client(), Arc::new(|| 50));
    assert_eq!(
        service.consent().unwrap().consent.unwrap().decided_at.get(),
        42
    );
    assert_eq!(
        service.list(None, None).await.unwrap().data[0].sample,
        sample()
    );
    consent(&service, false).await;
    consent(&service, true).await;
    service.append(vec![sample(), sample()]).await.unwrap();
    assert_eq!(
        service
            .list(Some(1), None)
            .await
            .unwrap()
            .cursor
            .next
            .unwrap()
            .as_str(),
        Some("Mw")
    );
    store.shutdown().unwrap();
    drop(reports);
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn concurrent_revocation_never_leaves_old_or_post_opt_out_rows() {
    let (store, service, _) = world();
    consent(&service, true).await;
    let (appended, revoked) = tokio::join!(
        service.append(vec![sample()]),
        service.set_consent(telemetry::ConsentInput {
            enabled: false,
            notice_version: telemetry::NoticeVersion
        })
    );
    assert!(appended == Ok(1) || appended == Err(Error::Disabled));
    revoked.unwrap();
    assert_eq!(service.append(vec![sample()]).await, Err(Error::Disabled));
    assert!(service.list(None, None).await.unwrap().data.is_empty());
    store.shutdown().unwrap();
}
