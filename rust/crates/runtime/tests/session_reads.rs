mod support;

use prost::{Message, Name};
use std::time::Duration;
use support::*;
use tokio::time::timeout;
use ycoding_core::ycoding_schema::{DomainDecode, parse_json, session_message, session_pending};
use ycoding_protocol::v5;
use ycoding_runtime::{LocalAuth, standard};

async fn bounded<F: std::future::Future>(future: F) -> F::Output {
    timeout(Duration::from_secs(60), future)
        .await
        .expect("test exceeded its time bound")
}

fn snapshot_request(session: &str, limit: Option<u64>, before: Option<&str>) -> Vec<u8> {
    v5::SessionSnapshotRequest {
        params: v5::SessionSnapshotRequestParams {
            session_id: text(session),
        },
        query: v5::SessionSnapshotQuery {
            limit,
            before: before.map(text),
        },
    }
    .encode_to_vec()
}

fn synthetic_text(info: &v5::SessionMessageInfo) -> String {
    let Some(v5::session_message_info::Kind::Value4(synthetic)) = &info.kind else {
        panic!("expected a synthetic message");
    };
    units(&synthetic.text)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_returns_the_newest_hundred_with_cursor_paging_and_one_watermark() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let scope = || session_scope("ses_history");

        let first: v5::SessionSnapshotResult = success(
            client
                .call(
                    "session.snapshot",
                    scope(),
                    snapshot_request("ses_history", None, None),
                )
                .await,
        );
        let first = first.data;
        assert_eq!(first.messages.items.len(), 100);
        assert!(synthetic_text(&first.messages.items[0]).starts_with("105-"));
        assert!(synthetic_text(&first.messages.items[99]).starts_with("204-"));
        assert_eq!(units(&first.source_epoch), "source-epoch-test");
        assert_eq!(units(&first.session.id), "ses_history");
        assert_eq!(first.watermark.r#type, 1);
        assert_eq!(units(&first.watermark.aggregate_id), "ses_history");
        assert_eq!(first.watermark.seq, Some(500));
        let cursor = units(first.before.as_ref().expect("an older page exists"));

        let second: v5::SessionSnapshotResult = success(
            client
                .call(
                    "session.snapshot",
                    scope(),
                    snapshot_request("ses_history", Some(100), Some(&cursor)),
                )
                .await,
        );
        let second = second.data;
        assert_eq!(second.messages.items.len(), 100);
        assert!(synthetic_text(&second.messages.items[0]).starts_with("005-"));
        assert!(synthetic_text(&second.messages.items[99]).starts_with("104-"));
        assert_eq!(second.watermark.seq, Some(500));

        let cursor = units(second.before.as_ref().unwrap());
        let last: v5::SessionSnapshotResult = success(
            client
                .call(
                    "session.snapshot",
                    scope(),
                    snapshot_request("ses_history", Some(100), Some(&cursor)),
                )
                .await,
        );
        assert_eq!(last.data.messages.items.len(), 5);
        assert!(synthetic_text(&last.data.messages.items[0]).starts_with("000-"));
        assert!(last.data.before.is_none());

        let descriptor = operation("session.snapshot");
        for (name, query) in [(
            "garbage cursor",
            snapshot_request("ses_history", None, Some("not a cursor")),
        )] {
            let payload = rejected(client.call("session.snapshot", scope(), query).await);
            assert_eq!(
                payload.type_name,
                v5::InvalidCursorError::full_name(),
                "{name}"
            );
            assert!(descriptor.error_types.contains(&payload.type_name));
        }
        let foreign_cursor = units(
            &success::<v5::SessionSnapshotResult>(
                client
                    .call(
                        "session.snapshot",
                        session_scope("ses_rich"),
                        snapshot_request("ses_rich", Some(2), None),
                    )
                    .await,
            )
            .data
            .before
            .unwrap(),
        );
        let payload = rejected(
            client
                .call(
                    "session.snapshot",
                    scope(),
                    snapshot_request("ses_history", None, Some(&foreign_cursor)),
                )
                .await,
        );
        assert_eq!(payload.type_name, v5::InvalidCursorError::full_name());

        let missing = rejected(
            client
                .call(
                    "session.snapshot",
                    session_scope("ses_nowhere"),
                    snapshot_request("ses_nowhere", None, None),
                )
                .await,
        );
        assert_eq!(missing.type_name, v5::SessionNotFoundError::full_name());
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_cursor_without_an_explicit_limit_is_rejected() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let first: v5::SessionSnapshotResult = success(
            client
                .call(
                    "session.snapshot",
                    session_scope("ses_history"),
                    snapshot_request("ses_history", None, None),
                )
                .await,
        );
        let cursor = units(first.data.before.as_ref().expect("an older page exists"));
        let descriptor = operation("session.snapshot");
        let payload = rejected(
            client
                .call(
                    "session.snapshot",
                    session_scope("ses_history"),
                    snapshot_request("ses_history", None, Some(&cursor)),
                )
                .await,
        );
        assert_eq!(payload.type_name, v5::InvalidCursorError::full_name());
        assert!(descriptor.error_types.contains(&payload.type_name));
        let error = v5::InvalidCursorError::decode(payload.payload.as_slice()).unwrap();
        assert!(units(&error.message).contains("window limit"));
        server.shutdown().await.unwrap();
    })
    .await;
}

fn messages_request(session: &str) -> Vec<u8> {
    v5::SessionMessagesRequest {
        params: v5::SessionMessagesRequestParams {
            session_id: text(session),
        },
    }
    .encode_to_vec()
}

fn message_request(session: &str, message: &str) -> Vec<u8> {
    v5::SessionMessageRequest {
        params: v5::SessionMessageRequestParams {
            session_id: text(session),
            message_id: text(message),
        },
    }
    .encode_to_vec()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_message_family_converts_with_its_exact_fields() {
    use v5::session_message_info::Kind;
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let all: v5::SessionMessagesResult = success(
            client
                .call(
                    "session.messages",
                    session_scope("ses_rich"),
                    messages_request("ses_rich"),
                )
                .await,
        );
        let items = all.data.data.items;
        assert_eq!(items.len(), 11);
        let kinds = items
            .iter()
            .map(|item| match item.kind.as_ref().unwrap() {
                Kind::Value1(_) => "agent",
                Kind::Value2(_) => "model",
                Kind::Value3(_) => "user",
                Kind::Value4(_) => "synthetic",
                Kind::Value5(_) => "system",
                Kind::Value6(_) => "skill",
                Kind::Value7(_) => "shell",
                Kind::Value8(_) => "assistant",
                Kind::Value9(_) => "compaction",
            })
            .collect::<Vec<_>>();
        assert_eq!(
            kinds,
            [
                "agent",
                "model",
                "user",
                "synthetic",
                "system",
                "skill",
                "shell",
                "assistant",
                "compaction",
                "compaction",
                "compaction"
            ]
        );

        let Some(Kind::Value1(agent)) = &items[0].kind else {
            unreachable!()
        };
        assert_eq!(units(&agent.agent), "build");
        assert_eq!(agent.metadata.as_ref().unwrap().entries.len(), 1);
        let Some(Kind::Value2(model)) = &items[1].kind else {
            unreachable!()
        };
        assert_eq!(units(model.model.variant.as_ref().unwrap()), "high");
        assert_eq!(units(&model.previous.as_ref().unwrap().id), "m0");

        let Some(Kind::Value3(user)) = &items[2].kind else {
            unreachable!()
        };
        assert_eq!((user.time.created, user.time.consumed), (3.0, Some(4.0)));
        let reviewer = &user.agents.as_ref().unwrap().items[0];
        assert_eq!(units(&reviewer.name), "reviewer");
        assert_eq!(units(&reviewer.mention.as_ref().unwrap().text), "@rev");
        let metadata = &user.metadata.as_ref().unwrap().entries[0];
        let Some(v5::value::Kind::List(list)) = &metadata.value.kind else {
            panic!("list")
        };
        assert!(
            matches!(list.items[0].kind, Some(v5::value::Kind::Number(number)) if number == 1.0)
        );
        assert!(matches!(
            list.items[1].kind,
            Some(v5::value::Kind::Boolean(true))
        ));
        assert!(matches!(list.items[2].kind, Some(v5::value::Kind::Null(_))));

        let Some(Kind::Value7(shell)) = &items[6].kind else {
            unreachable!()
        };
        assert_eq!(shell.status, 4, "memory-limit");
        assert_eq!(shell.exit, Some(0.0));
        assert_eq!(shell.output.as_ref().unwrap().size, 2);

        let Some(Kind::Value8(assistant)) = &items[7].kind else {
            unreachable!()
        };
        assert_eq!(assistant.finish, Some(3));
        assert_eq!(assistant.cost, Some(0.5));
        assert_eq!(assistant.tokens.as_ref().unwrap().cache.write, 5.0);
        let diagnostics = assistant.diagnostics.as_ref().unwrap();
        assert_eq!(diagnostics.context_limit, Some(1000));
        assert_eq!(
            diagnostics.context_breakdown.as_ref().unwrap().tool_calls,
            6
        );
        let cache = diagnostics.provider_cache.as_ref().unwrap();
        assert_eq!(
            (cache.mechanism, cache.read_reported, cache.write_reported),
            (7, false, true)
        );
        assert_eq!(units(&assistant.error.as_ref().unwrap().message), "y");
        let retry = assistant.retry.as_ref().unwrap();
        assert_eq!((retry.attempt, retry.at), (1, 12.0));
        let content = &assistant.content.items;
        assert_eq!(content.len(), 4);
        let Some(v5::session_message_assistant_content_item::Kind::Value1(text_part)) =
            &content[0].kind
        else {
            panic!("text")
        };
        assert_eq!(text_part.phase, Some(2));
        let Some(v5::session_message_assistant_content_item::Kind::Value2(reasoning)) =
            &content[1].kind
        else {
            panic!("reasoning")
        };
        assert_eq!(reasoning.state.as_ref().unwrap().entries.len(), 1);
        let Some(v5::session_message_assistant_content_item::Kind::Value3(tool)) = &content[2].kind
        else {
            panic!("tool")
        };
        assert_eq!(tool.executed, Some(true));
        assert_eq!(
            (tool.time.created, tool.time.ran, tool.time.completed),
            (10.0, Some(10.0), Some(11.0))
        );
        let Some(v5::session_message_assistant_tool_state::Kind::Value3(completed)) =
            &tool.state.kind
        else {
            panic!("completed")
        };
        assert_eq!(completed.content.items.len(), 2);
        assert!(matches!(
            completed.result.as_ref().unwrap().kind,
            Some(v5::value::Kind::Object(_))
        ));
        let Some(v5::session_message_assistant_content_item::Kind::Value3(streaming)) =
            &content[3].kind
        else {
            panic!("tool")
        };
        assert!(matches!(
            streaming.state.kind,
            Some(v5::session_message_assistant_tool_state::Kind::Value1(_))
        ));

        let Some(Kind::Value9(compaction)) = &items[9].kind else {
            unreachable!()
        };
        let Some(v5::session_message_compaction::Kind::Value2(running)) = &compaction.kind else {
            panic!("running")
        };
        let Some(v5::session_message_compaction_value2::Kind::Value2(running)) = &running.kind
        else {
            panic!("current running")
        };
        assert_eq!(running.pressure.as_ref().unwrap().safe_input_tokens, 20);
        assert_eq!(running.trigger, 4);
        let Some(Kind::Value9(compaction)) = &items[10].kind else {
            unreachable!()
        };
        let Some(v5::session_message_compaction::Kind::Value4(failed)) = &compaction.kind else {
            panic!("failed")
        };
        let Some(v5::session_message_compaction_value4::Kind::Value2(failed)) = &failed.kind else {
            panic!("current failed")
        };
        assert_eq!((failed.code, failed.trigger), (7, 2));

        let one: v5::SessionMessageResult = success(
            client
                .call(
                    "session.message",
                    session_scope("ses_rich"),
                    message_request("ses_rich", "msg_rich_08"),
                )
                .await,
        );
        assert_eq!(one.data, items[7]);

        let descriptor = operation("session.message");
        for foreign in [("ses_rich", "msg_h_000"), ("ses_rich", "msg_absent")] {
            let payload = rejected(
                client
                    .call(
                        "session.message",
                        session_scope(foreign.0),
                        message_request(foreign.0, foreign.1),
                    )
                    .await,
            );
            assert_eq!(
                payload.type_name,
                v5::MessageNotFoundError::full_name(),
                "{foreign:?}"
            );
            assert!(descriptor.error_types.contains(&payload.type_name));
        }
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_full_transcript_streams_as_typed_bulk() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let id = client
            .send(
                "session.messages",
                session_scope("ses_history"),
                messages_request("ses_history"),
            )
            .await;
        let outcome = client.settle(&id).await;
        let ycoding_protocol::connection::Outcome::BulkSuccess { start, bytes, .. } = &outcome
        else {
            panic!("a 205-message transcript exceeds the inline bound: {outcome:?}");
        };
        assert_eq!(start.byte_count as usize, bytes.len());
        assert!(start.chunk_count >= 3);
        let all = v5::SessionMessagesResult::decode(bytes.as_slice()).unwrap();
        assert_eq!(all.data.data.items.len(), 205);
        assert!(synthetic_text(&all.data.data.items[0]).starts_with("000-"));
        assert!(synthetic_text(&all.data.data.items[204]).starts_with("204-"));
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pending_list_returns_user_and_synthetic_inputs_in_admission_order() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let prompt = |id: &str, delivery: i32, body: &str| {
            v5::SessionPromptRequest {
                params: v5::SessionPromptRequestParams {
                    session_id: text("ses_pending"),
                },
                payload: v5::SessionPromptRequestPayload {
                    id: Some(text(id)),
                    text: text(body),
                    files: None,
                    agents: Some(v5::SessionPromptRequestPayloadAgents {
                        items: vec![v5::PromptAgentAttachment {
                            name: text("reviewer"),
                            mention: Some(v5::PromptMention {
                                start: 0.0,
                                end: 1.0,
                                text: text("@r"),
                            }),
                        }],
                    }),
                    metadata: None,
                    delivery: Some(delivery),
                    resume: Some(false),
                },
            }
            .encode_to_vec()
        };
        for (id, delivery, body) in [
            ("msg_pend_1", v5::SessionPromptRequestPayloadDelivery::Steer as i32, "first"),
            ("msg_pend_2", v5::SessionPromptRequestPayloadDelivery::Queue as i32, "second"),
        ] {
            let _: v5::SessionPromptResult = success(
                client
                    .call("session.prompt", session_scope("ses_pending"), prompt(id, delivery, body))
                    .await,
            );
        }
        world()
            .core
            .sessions
            .admit(ycoding_core::session::pending::Request {
                id: session_message::Id::new("msg_pend_3").unwrap(),
                session_id: ycoding_core::ycoding_schema::session::Id::new("ses_pending").unwrap(),
                input: session_pending::Message::decode(
                    &parse_json(
                        r#"{"type":"synthetic","data":{"text":"sys note","description":"why","metadata":{"a":1}},"delivery":"queue"}"#,
                    )
                    .unwrap(),
                )
                .unwrap(),
                event_id: ycoding_core::ycoding_schema::event::Id::new("evt_pend_3").unwrap(),
                created: 30,
            })
            .await
            .unwrap();

        let list: v5::SessionPendingListResult = success(
            client
                .call(
                    "session.pending.list",
                    session_scope("ses_pending"),
                    v5::SessionPendingListRequest {
                        params: v5::SessionPendingListRequestParams {
                            session_id: text("ses_pending"),
                        },
                    }
                    .encode_to_vec(),
                )
                .await,
        );
        use v5::session_pending_info::Kind;
        let items = list.data.items;
        assert_eq!(items.len(), 3);
        let Some(Kind::Value1(first)) = &items[0].kind else { panic!("user") };
        assert_eq!((units(&first.id).as_str(), first.delivery, units(&first.data.text).as_str()), ("msg_pend_1", 1, "first"));
        assert_eq!(first.data.agents.as_ref().unwrap().items.len(), 1);
        assert!(first.admitted_seq < match &items[1].kind { Some(Kind::Value1(second)) => second.admitted_seq, _ => panic!("user") });
        let Some(Kind::Value1(second)) = &items[1].kind else { unreachable!() };
        assert_eq!(second.delivery, 2);
        let Some(Kind::Value2(synthetic)) = &items[2].kind else { panic!("synthetic") };
        assert_eq!(units(synthetic.data.description.as_ref().unwrap()), "why");
        assert_eq!(synthetic.data.metadata.as_ref().unwrap().entries.len(), 1);
        assert_eq!(synthetic.delivery, 2);
        assert_eq!(synthetic.time_created, 30.0);
        server.shutdown().await.unwrap();
    })
    .await;
}
