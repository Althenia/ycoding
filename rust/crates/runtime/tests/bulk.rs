mod support;

use prost::Message;
use std::{sync::Arc, time::Duration};
use support::*;
use tokio::time::timeout;
use ycoding_protocol::{connection::Outcome, limits, v5};
use ycoding_runtime::{Environment, LocalAuth, Settled};

async fn bounded<F: std::future::Future>(future: F) -> F::Output {
    timeout(Duration::from_secs(60), future)
        .await
        .expect("test exceeded its time bound")
}

fn urls(count: usize, width: usize) -> v5::ServerGetResult {
    v5::ServerGetResult {
        urls: v5::ServerGetResultUrls {
            items: (0..count)
                .map(|index| {
                    text(&format!(
                        "https://example.test/{index:08}/{}",
                        "p".repeat(width)
                    ))
                })
                .collect(),
        },
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn results_over_the_inline_bound_stream_as_typed_bulk_under_bulk_credit() {
    bounded(async {
        const COUNT: usize = 20_000;
        let mut dispatcher = bare_dispatcher();
        dispatcher
            .handle("server.get", |_, _: v5::ServerGetRequest| async {
                Ok(urls(COUNT, 80))
            })
            .unwrap();
        let server = start(services(LocalAuth::disabled(), false), dispatcher).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let mut ids = Vec::new();
        for _ in 0..3 {
            ids.push(
                client
                    .send(
                        "server.get",
                        machine(),
                        v5::ServerGetRequest {}.encode_to_vec(),
                    )
                    .await,
            );
        }
        let expected = urls(COUNT, 80);
        for id in &ids {
            let outcome = client.settle(id).await;
            let Outcome::BulkSuccess {
                settlement,
                start,
                bytes,
            } = &outcome
            else {
                panic!("expected bulk delivery, got {outcome:?}");
            };
            assert_eq!(*settlement, operation("server.get").settlement());
            assert_eq!(start.type_name, operation("server.get").result_type);
            assert_eq!(start.operation_id, operation("server.get").operation_id);
            assert_eq!(start.byte_count as usize, bytes.len());
            assert_eq!(
                start.chunk_count as usize,
                bytes.len().div_ceil(limits::BULK_PIECE_BYTES as usize)
            );
            assert!(
                bytes.len() as u64 > 2 * limits::BULK_WINDOW_BYTES,
                "the transfer exceeds the 512 KiB bulk window, so it only completes if credit flows"
            );
            assert_eq!(
                v5::ServerGetResult::decode(bytes.as_slice()).unwrap(),
                expected
            );
        }
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn results_over_the_typed_message_bound_are_refused_with_a_typed_error() {
    bounded(async {
        let mut dispatcher = bare_dispatcher();
        dispatcher
            .handle("server.get", |_, _: v5::ServerGetRequest| async {
                Ok(urls(70_000, 1_000))
            })
            .unwrap();
        let environment = Arc::new(Environment {
            services: services(LocalAuth::disabled(), false),
            urls: Vec::new(),
            subscriptions: ycoding_runtime::Subscriptions::default(),
            uploads: Default::default(),
        });
        let descriptor = operation("server.get");
        let settled = dispatcher
            .invoke(
                environment,
                "test-connection".into(),
                v5::Request {
                    request_id: "1".into(),
                    operation_id: descriptor.operation_id,
                    scope: machine(),
                    payload: Vec::new(),
                },
            )
            .await
            .unwrap();
        let Settled::Result(result) = settled else {
            panic!("an oversized message must not stream");
        };
        let Some(v5::result::Outcome::Error(payload)) = result.outcome else {
            panic!("expected a typed error");
        };
        assert!(descriptor.error_types.contains(&payload.type_name));
        let error = v5::InvalidRequestError::decode(payload.payload.as_slice()).unwrap();
        assert_eq!(units(error.kind.as_ref().unwrap()), "unavailable");
        assert!(units(&error.message).contains("typed message bound"));
    })
    .await;
}
