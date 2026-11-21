mod support;

use prost::{Message, Name};
use std::time::Duration;
use support::*;
use tokio::time::timeout;
use ycoding_protocol::v5;
use ycoding_runtime::{LocalAuth, standard};

async fn bounded<F: std::future::Future>(future: F) -> F::Output {
    timeout(Duration::from_secs(60), future)
        .await
        .expect("test exceeded its time bound")
}

fn log_request(session: &str, after: Option<u64>, follow: Option<bool>) -> Vec<u8> {
    v5::SessionLogRequest {
        params: v5::SessionLogRequestParams {
            session_id: text(session),
        },
        query: v5::SessionLogRequestQuery { after, follow },
    }
    .encode_to_vec()
}

fn prompt_request(session: &str, id: &str) -> Vec<u8> {
    v5::SessionPromptRequest {
        params: v5::SessionPromptRequestParams {
            session_id: text(session),
        },
        payload: v5::SessionPromptRequestPayload {
            id: Some(text(id)),
            text: text("log probe"),
            files: None,
            agents: None,
            metadata: None,
            delivery: Some(v5::SessionPromptRequestPayloadDelivery::Queue as i32),
            resume: Some(false),
        },
    }
    .encode_to_vec()
}

fn items(client: &mut Client) -> Vec<v5::SessionLogItem> {
    client
        .batches
        .iter()
        .flat_map(|batch| batch.events.iter())
        .map(|record| {
            assert_eq!(record.event.type_name, v5::SessionLogItem::full_name());
            v5::SessionLogItem::decode(record.event.payload.as_slice()).unwrap()
        })
        .collect()
}

fn admitted_id(item: &v5::SessionLogItem) -> &str {
    let Some(v5::session_log_item::Kind::Value15(admitted)) = &item.kind else {
        panic!("expected an admitted input, got {item:?}");
    };
    match admitted.data.input_id.encoding.as_ref().unwrap() {
        v5::lossless_string::Encoding::Utf8(id) => id,
        v5::lossless_string::Encoding::Utf16LeUnits(_) => panic!("unexpected code-unit branch"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn log_replays_admissions_then_a_synced_watermark_and_discards_replay_below_it() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        for id in ["msg_log_replay_1", "msg_log_replay_2"] {
            let _: v5::SessionPromptResult = success(
                client
                    .call(
                        "session.prompt",
                        session_scope("ses_other"),
                        prompt_request("ses_other", id),
                    )
                    .await,
            );
        }

        let id = client
            .send(
                "session.log",
                session_scope("ses_other"),
                log_request("ses_other", None, None),
            )
            .await;
        let sub = client.subscribe_log(&id, session_scope("ses_other")).await;
        client.run_for(Duration::from_secs(2)).await;
        assert!(client.close.is_none());
        assert!(client.resyncs.is_empty());
        let replayed = items(&mut client);
        assert_eq!(replayed.len(), 3);
        assert_eq!(admitted_id(&replayed[0]), "msg_log_replay_1");
        assert_eq!(admitted_id(&replayed[1]), "msg_log_replay_2");
        let Some(v5::session_log_item::Kind::Value52(synced)) = &replayed[2].kind else {
            panic!("expected a synced marker");
        };
        assert_eq!(synced.seq, Some(1));
        assert_eq!(units(&synced.aggregate_id), "ses_other");
        assert_eq!(client.ended, vec![sub.clone()]);

        client.batches.clear();
        let id = client
            .send(
                "session.log",
                session_scope("ses_other"),
                log_request("ses_other", Some(1), None),
            )
            .await;
        client.subscribe_log(&id, session_scope("ses_other")).await;
        client.run_for(Duration::from_secs(2)).await;
        let replayed = items(&mut client);
        assert_eq!(replayed.len(), 1);
        assert!(matches!(
            replayed[0].kind,
            Some(v5::session_log_item::Kind::Value52(_))
        ));
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn log_follow_streams_live_admissions_until_unsubscribe() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let id = client
            .send(
                "session.log",
                session_scope("ses_files"),
                log_request("ses_files", None, Some(true)),
            )
            .await;
        let sub = client.subscribe_log(&id, session_scope("ses_files")).await;
        client.run_for(Duration::from_secs(1)).await;
        assert!(!client.ended.contains(&sub));

        let _: v5::SessionPromptResult = success(
            client
                .call(
                    "session.prompt",
                    session_scope("ses_files"),
                    prompt_request("ses_files", "msg_log_live_1"),
                )
                .await,
        );
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            client.run_for(Duration::from_millis(100)).await;
            let live: Vec<_> = items(&mut client)
                .into_iter()
                .filter(|item| matches!(item.kind, Some(v5::session_log_item::Kind::Value15(_))))
                .collect();
            if live
                .iter()
                .any(|item| admitted_id(item) == "msg_log_live_1")
            {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "no live admission arrived"
            );
        }
        assert!(!client.ended.contains(&sub));

        let _: v5::EventUnsubscribeResult = success(
            client
                .call(
                    "event.unsubscribe",
                    v5::Scope {
                        target: Some(v5::scope::Target::Global(v5::Empty {})),
                    },
                    v5::EventUnsubscribeRequest {
                        subscription_id: sub.clone(),
                    }
                    .encode_to_vec(),
                )
                .await,
        );
        client.run_for(Duration::from_secs(2)).await;
        assert_eq!(client.ended, vec![sub.clone()]);

        let seen = items(&mut client).len();
        let _: v5::SessionPromptResult = success(
            client
                .call(
                    "session.prompt",
                    session_scope("ses_files"),
                    prompt_request("ses_files", "msg_log_live_2"),
                )
                .await,
        );
        client.run_for(Duration::from_secs(1)).await;
        assert_eq!(items(&mut client).len(), seen);
        server.shutdown().await.unwrap();
    })
    .await;
}
