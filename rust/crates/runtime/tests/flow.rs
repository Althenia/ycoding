mod support;

use prost::Message;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use support::*;
use tokio::{sync::Notify, time::timeout};
use ycoding_protocol::{connection::Budgets, v5};
use ycoding_runtime::LocalAuth;

async fn bounded<F: std::future::Future>(future: F) -> F::Output {
    timeout(Duration::from_secs(60), future)
        .await
        .expect("test exceeded its time bound")
}

fn server_get_result() -> v5::ServerGetResult {
    v5::ServerGetResult {
        urls: v5::ServerGetResultUrls {
            items: vec![text("http://flow")],
        },
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_consumer_that_never_returns_credit_is_disconnected_at_its_deadline_while_a_second_peer_progresses()
 {
    bounded(async {
        let mut dispatcher = bare_dispatcher();
        dispatcher
            .handle("server.get", |_, _: v5::ServerGetRequest| async {
                Ok(server_get_result())
            })
            .unwrap();
        let mut configured = services(LocalAuth::disabled(), false);
        configured.budgets = Budgets {
            delivery_timeout_ms: 300,
            ..Budgets::default()
        };
        let server = start(configured, dispatcher).await;
        let mut healthy = Client::open(server.address(), &[]).await.unwrap();
        let mut stalled = Client::open(server.address(), &[]).await.unwrap();
        stalled.hold = true;

        let id = stalled
            .send(
                "server.get",
                machine(),
                v5::ServerGetRequest {}.encode_to_vec(),
            )
            .await;
        let _ = stalled.settle_held(&id).await;
        assert!(
            stalled.close.is_none(),
            "delivered but not yet past the deadline"
        );

        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while stalled.close.is_none() {
            assert!(
                std::time::Instant::now() < deadline,
                "the stalled peer was never disconnected"
            );
            stalled.step().await;
            let urls: v5::ServerGetResult = success(
                healthy
                    .call(
                        "server.get",
                        machine(),
                        v5::ServerGetRequest {}.encode_to_vec(),
                    )
                    .await,
            );
            assert_eq!(units(&urls.urls.items[0]), "http://flow");
        }
        assert_eq!(
            stalled.close.clone(),
            Some((1002, "limit".to_string())),
            "the unconsumed result exceeded its delivery deadline"
        );
        assert!(healthy.close.is_none());
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_a_queued_unstarted_mutation_prevents_it_from_ever_running() {
    bounded(async {
        let mut dispatcher = bare_dispatcher();
        let started = Arc::new(Notify::new());
        let gate = Arc::new(Notify::new());
        let runs = Arc::new(AtomicUsize::new(0));
        let order = Arc::new(Mutex::new(Vec::<String>::new()));
        let (handler_started, handler_gate, handler_runs, handler_order) =
            (started.clone(), gate.clone(), runs.clone(), order.clone());
        dispatcher
            .handle(
                "session.interrupt",
                move |_, request: v5::SessionInterruptRequest| {
                    let (started, gate, runs, order) = (
                        handler_started.clone(),
                        handler_gate.clone(),
                        handler_runs.clone(),
                        handler_order.clone(),
                    );
                    async move {
                        let run = runs.fetch_add(1, Ordering::SeqCst);
                        order
                            .lock()
                            .unwrap()
                            .push(format!("{}:{run}", units(&request.params.session_id)));
                        if run == 0 {
                            started.notify_one();
                            gate.notified().await;
                        }
                        Ok(v5::SessionInterruptResult { data: v5::Empty {} })
                    }
                },
            )
            .unwrap();
        dispatcher
            .authorize("session.interrupt", |_, _| Ok(()))
            .unwrap();
        let server = start(services(LocalAuth::disabled(), false), dispatcher).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let request = || {
            v5::SessionInterruptRequest {
                params: v5::SessionInterruptRequestParams {
                    session_id: text("ses_interrupt"),
                },
            }
            .encode_to_vec()
        };
        let running = client
            .send(
                "session.interrupt",
                session_scope("ses_interrupt"),
                request(),
            )
            .await;
        started.notified().await;
        let queued = client
            .send(
                "session.interrupt",
                session_scope("ses_interrupt"),
                request(),
            )
            .await;
        let after = client
            .send(
                "session.interrupt",
                session_scope("ses_interrupt"),
                request(),
            )
            .await;

        let now = client.now();
        let settled = client.connection.cancel_request(&queued, now).unwrap();
        assert!(matches!(
            settled.as_slice(),
            [ycoding_protocol::connection::Decision::Settled {
                outcome: ycoding_protocol::connection::Outcome::Unknown,
                ..
            }]
        ));
        client.pump().await;
        client.run_for(Duration::from_millis(100)).await;

        gate.notify_one();
        let _: v5::SessionInterruptResult = success(client.settle(&running).await);
        let _: v5::SessionInterruptResult = success(client.settle(&after).await);
        assert_eq!(
            runs.load(Ordering::SeqCst),
            2,
            "the cancelled mutation never ran"
        );
        assert_eq!(
            *order.lock().unwrap(),
            ["ses_interrupt:0", "ses_interrupt:1"]
        );
        assert!(
            client.events.is_empty(),
            "the cancelled request is never answered"
        );
        server.shutdown().await.unwrap();
    })
    .await;
}
