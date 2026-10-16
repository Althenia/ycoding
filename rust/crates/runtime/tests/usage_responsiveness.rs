mod support;

use prost::Message;
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;
use support::{machine, operation, services, session_scope, text, world};
use ycoding_core::ycoding_schema::{model, parse_json, provider};
use ycoding_core::ycoding_store::analytics::{self, Query};
use ycoding_core::ycoding_store::{
    resources::{Request, RequestTable},
    session::Document,
};
use ycoding_protocol::v5;
use ycoding_runtime::{Environment, LocalAuth, Subscriptions, standard};

#[tokio::test(flavor = "current_thread")]
async fn held_usage_reads_leave_the_executor_and_canonical_store_available() {
    world()
        .store
        .submit(|tx| {
            RequestTable::insert(
                tx,
                &Request {
                    id: "prq_held_usage".into(),
                    session_id: "ses_get".into(),
                    input_id: None,
                    assistant_message_id: None,
                    connection_identity_digest: None,
                    source: "step".into(),
                    agent: "build".into(),
                    model: Document::from_domain(&model::Ref {
                        id: "gpt".into(),
                        provider_id: provider::Id("openai".into()),
                        variant: None,
                        profile: None,
                    })
                    .unwrap(),
                    route_id: "test".into(),
                    prompt_cache_key: "namespace".into(),
                    system_digest: "system".into(),
                    tool_digest: "tools".into(),
                    request: 1,
                    attempts: 1,
                    invalidation: "first-request".into(),
                    continuation: "full".into(),
                    cache_read_reported: None,
                    timing: None,
                    cost: None,
                    tokens: Document::new(
                        parse_json(
                            r#"{"input":10,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}"#,
                        )
                        .unwrap(),
                    )
                    .unwrap(),
                    time_created: 1,
                },
            )
        })
        .unwrap()
        .await
        .unwrap();
    for operation in [
        "usage.get",
        "usage.report",
        "session.usage",
        "session.usageReport",
    ] {
        let (reached, entered) = tokio::sync::oneshot::channel();
        let reached = Mutex::new(Some(reached));
        let (release, held) = mpsc::channel();
        let held = Mutex::new(held);
        let mut config = services(LocalAuth::disabled(), true);
        config.core.as_mut().unwrap().usage_pricer = Some(Arc::new(move |_| {
            if let Some(reached) = reached.lock().unwrap().take() {
                reached.send(()).unwrap();
                held.lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(10))
                    .unwrap();
            }
            None
        }));
        let environment = Arc::new(Environment {
            services: config,
            urls: vec![],
            subscriptions: Subscriptions::default(),
            uploads: Default::default(),
        });
        let dispatcher = standard().unwrap();
        let payload = match operation {
            "usage.get" => v5::UsageGetRequest {}.encode_to_vec(),
            "usage.report" => v5::UsageReportRequest {
                query: v5::UsageReportRequestQuery {
                    group: 1,
                    time_zone: None,
                    from: None,
                    to: None,
                    offset: None,
                    limit: None,
                    sort: None,
                    order: None,
                },
            }
            .encode_to_vec(),
            "session.usage" => v5::SessionUsageRequest {
                params: v5::SessionUsageRequestParams {
                    session_id: text("ses_get"),
                },
            }
            .encode_to_vec(),
            _ => v5::SessionUsageReportRequest {
                params: v5::SessionUsageReportRequestParams {
                    session_id: text("ses_get"),
                },
                query: v5::SessionUsageReportRequestQuery {
                    group: 1,
                    time_zone: None,
                    from: None,
                    to: None,
                    offset: None,
                    limit: None,
                    sort: None,
                    order: None,
                },
            }
            .encode_to_vec(),
        };
        let (progress, progressed) = mpsc::channel();
        let watchdog = std::thread::spawn(move || {
            let available = progressed.recv_timeout(Duration::from_secs(2)).is_ok();
            release.send(()).unwrap();
            available
        });
        let report = dispatcher.invoke(
            environment.clone(),
            "usage-test".into(),
            v5::Request {
                request_id: "report".into(),
                operation_id: support::operation(operation).operation_id,
                scope: if operation.starts_with("session.") {
                    session_scope("ses_get")
                } else {
                    machine()
                },
                payload,
            },
        );
        let available = async {
            entered.await.unwrap();
            let cheap = dispatcher
                .invoke(
                    environment.clone(),
                    "usage-test".into(),
                    v5::Request {
                        request_id: "cheap".into(),
                        operation_id: support::operation("session.get").operation_id,
                        scope: session_scope("ses_get"),
                        payload: v5::SessionGetRequest {
                            params: v5::SessionGetRequestParams {
                                session_id: text("ses_get"),
                            },
                        }
                        .encode_to_vec(),
                    },
                )
                .await
                .unwrap();
            assert!(matches!(
                cheap,
                ycoding_runtime::Settled::Result(v5::Result {
                    outcome: Some(v5::result::Outcome::Success(_)),
                    ..
                })
            ));
            world()
                .store
                .submit(|tx| {
                    let key = ycoding_core::ycoding_store::tuple_key(&[
                        ycoding_core::ycoding_store::KeyPart::String(&"ses_get".into()),
                    ]);
                    let mut session = tx
                        .get::<ycoding_core::ycoding_store::session::SessionTable>(&key)?
                        .unwrap();
                    session.title = "usage read remains responsive".into();
                    ycoding_core::ycoding_store::session::SessionTable::put(tx, &session)
                })
                .unwrap()
                .await
                .unwrap();
            let _ = progress.send(());
            watchdog.join().unwrap()
        };
        let (response, available) = tokio::join!(report, available);
        assert!(matches!(
            response,
            Some(ycoding_runtime::Settled::Result(v5::Result {
                outcome: Some(v5::result::Outcome::Success(_)),
                ..
            }))
        ));
        assert!(
            available,
            "{operation} blocked the only async executor thread while held"
        );
    }

    let handle = world().store.analytics().unwrap();
    let cancellation = analytics::Cancellation::default();
    let signal = cancellation.clone();
    let native = std::thread::spawn(move || {
        handle.report_cancellable(
            vec![Query {
                sql: "SELECT sum(i::HUGEINT * (i % 97)) FROM range(1000000000000) t(i)",
                parameters: vec![],
                max_rows: 1,
            }],
            signal,
        )
    });
    cancellation.wait_querying().unwrap();
    let (reached, entered) = tokio::sync::oneshot::channel();
    let reached = Mutex::new(Some(reached));
    let mut config = services(LocalAuth::disabled(), true);
    config.core.as_mut().unwrap().usage_pricer = Some(Arc::new(move |_| {
        if let Some(reached) = reached.lock().unwrap().take() {
            reached.send(()).unwrap();
        }
        None
    }));
    let environment = Arc::new(Environment {
        services: config,
        urls: vec![],
        subscriptions: Subscriptions::default(),
        uploads: Default::default(),
    });
    let dispatcher = standard().unwrap();
    let (progress, progressed) = mpsc::channel();
    let watchdog = std::thread::spawn(move || {
        let available = progressed.recv_timeout(Duration::from_secs(2)).is_ok();
        cancellation.cancel();
        available
    });
    let report = dispatcher.invoke(
        environment,
        "usage-receipt-test".into(),
        v5::Request {
            request_id: "report-receipt".into(),
            operation_id: operation("usage.report").operation_id,
            scope: machine(),
            payload: v5::UsageReportRequest {
                query: v5::UsageReportRequestQuery {
                    group: 1,
                    time_zone: None,
                    from: None,
                    to: None,
                    offset: None,
                    limit: None,
                    sort: None,
                    order: None,
                },
            }
            .encode_to_vec(),
        },
    );
    let available = async {
        entered.await.unwrap();
        world().store.submit(|_| Ok(())).unwrap().await.unwrap();
        let _ = progress.send(());
        watchdog.join().unwrap()
    };
    let (report, available) = tokio::join!(report, available);
    assert!(matches!(
        native.join().unwrap(),
        Err(analytics::Error::Cancelled)
    ));
    assert!(matches!(
        report,
        Some(ycoding_runtime::Settled::Result(v5::Result {
            outcome: Some(v5::result::Outcome::Success(_)),
            ..
        }))
    ));
    assert!(
        available,
        "waiting for an analytics receipt blocked the async executor"
    );
}
