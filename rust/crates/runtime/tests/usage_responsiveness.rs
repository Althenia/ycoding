#[path = "../../core/tests/report_support/prepared.rs"]
mod prepared_support;
mod support;

use prost::{Message, Name};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;
use support::{machine, operation, services, session_scope, text, world};
use ycoding_core::ycoding_schema::DomainDecode;
use ycoding_core::ycoding_schema::{model, parse_json, provider};
use ycoding_core::ycoding_store::analytics::{self, Query};
use ycoding_core::ycoding_store::{resources::Request, session::Document};
use ycoding_protocol::v5;
use ycoding_runtime::{Environment, LocalAuth, Subscriptions, standard};

#[tokio::test(flavor = "current_thread")]
async fn held_usage_producers_and_reads_leave_the_executor_and_canonical_store_available() {
    world()
        .store
        .submit(|tx| {
            support::usage::retained(
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
                    usage_anchor: None,
                    outcome: None,
                },
            )
        })
        .unwrap()
        .await
        .unwrap();
    let gate = Arc::new(Mutex::new(
        None::<(tokio::sync::oneshot::Sender<()>, mpsc::Receiver<()>)>,
    ));
    let pending = gate.clone();
    let views = ycoding_core::usage_view::Service::new(
        world().core.sessions.clone(),
        Some(Arc::new(move |_| {
            if let Some((entered, release)) = pending.lock().unwrap().take() {
                entered.send(()).unwrap();
                release.recv_timeout(Duration::from_secs(10)).unwrap();
            }
            Ok(None)
        })),
    );
    prepared_support::publish(&world().store, &views);
    let environment = Arc::new(Environment {
        services: services(LocalAuth::disabled(), true),
        urls: vec![],
        subscriptions: Subscriptions::default(),
        uploads: Default::default(),
    });
    let dispatcher = standard().unwrap();
    let input = ycoding_core::ycoding_schema::provider_request::ReportInput::decode(
        &ycoding_core::ycoding_schema::parse_json(r#"{"group":"model"}"#).unwrap(),
    )
    .unwrap();
    for name in [
        "usage.get",
        "usage.report",
        "session.usage",
        "session.usageReport",
    ] {
        let (entered, started) = tokio::sync::oneshot::channel();
        let (release, held) = mpsc::channel();
        *gate.lock().unwrap() = Some((entered, held));
        views.invalidate();
        let producer = views.clone();
        let producer = std::thread::spawn(move || producer.publish());
        tokio::time::timeout(Duration::from_secs(5), started)
            .await
            .unwrap()
            .unwrap();
        let payload = match name {
            "usage.get" => v5::UsageGetRequest {}.encode_to_vec(),
            "usage.report" => v5::UsageReportRequest {
                query: v5::SessionUsageReportQuery {
                    group: 1,
                    ..Default::default()
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
                query: v5::SessionUsageReportQuery {
                    group: 1,
                    ..Default::default()
                },
            }
            .encode_to_vec(),
        };
        let request = v5::Request {
            request_id: format!("cold-{name}"),
            operation_id: operation(name).operation_id,
            scope: if name.starts_with("session.") {
                session_scope("ses_get")
            } else {
                machine()
            },
            payload,
        };
        let response = tokio::time::timeout(
            Duration::from_secs(2),
            dispatcher.invoke(environment.clone(), "usage-test".into(), request.clone()),
        )
        .await
        .unwrap();
        let Some(ycoding_runtime::Settled::Result(v5::Result {
            outcome: Some(v5::result::Outcome::Error(error)),
            ..
        })) = response
        else {
            panic!("cold Usage must fail closed")
        };
        assert_eq!(error.type_name, v5::InvalidRequestError::full_name());
        let unavailable = v5::InvalidRequestError::decode(error.payload.as_slice()).unwrap();
        assert_eq!(unavailable.kind, Some(text("unavailable")));
        let (progress, progressed) = mpsc::channel();
        let watchdog = std::thread::spawn(move || {
            let available = progressed.recv_timeout(Duration::from_secs(2)).is_ok();
            release.send(()).unwrap();
            available
        });
        let cheap = dispatcher
            .invoke(
                environment.clone(),
                "usage-test".into(),
                v5::Request {
                    request_id: "cheap".into(),
                    operation_id: operation("session.get").operation_id,
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
                session.title = "usage producer remains responsive".into();
                ycoding_core::ycoding_store::session::SessionTable::put(tx, &session)
            })
            .unwrap()
            .await
            .unwrap();
        let _ = progress.send(());
        let available = watchdog.join().unwrap();
        let published = producer.join().unwrap().unwrap();
        assert!(
            available,
            "cheap read and canonical write exceeded two seconds"
        );
        assert!(
            !published,
            "a source write must reject the in-flight publication"
        );
        prepared_support::publish(&world().store, &views);
        match name {
            "usage.report" => views
                .refresh_prepared(std::slice::from_ref(&input))
                .unwrap(),
            "session.usage" | "session.usageReport" => {
                let id = ycoding_core::ycoding_schema::session::Id::new("ses_get").unwrap();
                let queued = if name == "session.usage" {
                    world().core.sessions.usage(&id).map(|_| ())
                } else {
                    world().core.sessions.usage_report(&id, &input).map(|_| ())
                };
                assert!(matches!(
                    queued,
                    Err(ycoding_core::ycoding_store::Error::Domain {
                        kind: "Usage.PreparedUnavailable",
                        ..
                    })
                ));
            }
            _ => {}
        }
        world()
            .store
            .analytics()
            .unwrap()
            .prepare_presentations()
            .unwrap();
        let response = dispatcher
            .invoke(environment.clone(), "usage-test".into(), request)
            .await;
        assert!(matches!(
            response,
            Some(ycoding_runtime::Settled::Result(v5::Result {
                outcome: Some(v5::result::Outcome::Success(_)),
                ..
            }))
        ));
    }

    views.refresh_prepared(&[input]).unwrap();
    let handle = world().store.analytics().unwrap();
    handle.prepare_presentations().unwrap();
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
    let (progress, progressed) = mpsc::channel();
    let watchdog = std::thread::spawn(move || {
        let available = progressed.recv_timeout(Duration::from_secs(2)).is_ok();
        cancellation.cancel();
        available
    });
    let report = dispatcher.invoke(
        environment,
        "usage-test".into(),
        v5::Request {
            request_id: "report-receipt".into(),
            operation_id: operation("usage.report").operation_id,
            scope: machine(),
            payload: v5::UsageReportRequest {
                query: v5::SessionUsageReportQuery {
                    group: 1,
                    ..Default::default()
                },
            }
            .encode_to_vec(),
        },
    );
    let available = async {
        world().store.submit(|_| Ok(())).unwrap().await.unwrap();
        progress.send(()).unwrap();
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
