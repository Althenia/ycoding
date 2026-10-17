mod support;

use prost::{Message, Name};
use std::time::Duration;
use support::*;
use tokio::time::timeout;
use ycoding_core::ycoding_schema::{parse_json, session, session_message};
use ycoding_core::ycoding_store::{
    KeyPart,
    session::{Document, Message as Row, MessageTable, SessionTable, Todo, TodoTable},
    tuple_key,
};
use ycoding_protocol::v5;
use ycoding_runtime::{LocalAuth, standard};

async fn bounded<F: std::future::Future>(future: F) -> F::Output {
    timeout(Duration::from_secs(60), future)
        .await
        .expect("test exceeded its time bound")
}

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn params(session: &str) -> v5::SessionArchiveRequestParams {
    v5::SessionArchiveRequestParams {
        session_id: text(session),
    }
}

fn list_request(query: v5::SessionsQuery) -> Vec<u8> {
    v5::SessionListRequest { query }.encode_to_vec()
}

fn listed(search: &str) -> v5::SessionsQuery {
    v5::SessionsQuery {
        search: Some(text(search)),
        ..Default::default()
    }
}

fn names(result: &v5::SessionListResult) -> Vec<String> {
    result
        .data
        .data
        .items
        .iter()
        .map(|info| units(&info.id))
        .collect()
}

async fn list(client: &mut Client, query: v5::SessionsQuery) -> v5::SessionListResult {
    success(
        client
            .call("session.list", machine(), list_request(query))
            .await,
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_list_orders_filters_and_pages_with_opaque_cursors() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();

        let all = list(&mut client, listed("ses_list_")).await;
        assert_eq!(names(&all), ["ses_list_c", "ses_list_b", "ses_list_a"]);
        assert!(all.data.cursor.previous.is_some() && all.data.cursor.next.is_some());

        let ascending = list(
            &mut client,
            v5::SessionsQuery {
                order: Some(v5::SessionsQueryOrder::SessionsqueryOrderAsc as i32),
                ..listed("ses_list_")
            },
        )
        .await;
        assert_eq!(
            names(&ascending),
            ["ses_list_a", "ses_list_b", "ses_list_c"]
        );

        let first = list(
            &mut client,
            v5::SessionsQuery {
                limit: Some(2),
                ..listed("ses_list_")
            },
        )
        .await;
        assert_eq!(names(&first), ["ses_list_c", "ses_list_b"]);
        let second = list(
            &mut client,
            v5::SessionsQuery {
                limit: Some(2),
                cursor: first.data.cursor.next.clone(),
                ..Default::default()
            },
        )
        .await;
        assert_eq!(names(&second), ["ses_list_a"]);
        let back = list(
            &mut client,
            v5::SessionsQuery {
                limit: Some(2),
                cursor: second.data.cursor.previous.clone(),
                ..Default::default()
            },
        )
        .await;
        assert_eq!(names(&back), ["ses_list_c", "ses_list_b"]);

        let nowhere = list(
            &mut client,
            v5::SessionsQuery {
                directory: Some(text("/nowhere")),
                ..listed("ses_list_")
            },
        )
        .await;
        assert!(nowhere.data.data.items.is_empty());
        assert!(nowhere.data.cursor.next.is_none());

        let roots = list(
            &mut client,
            v5::SessionsQuery {
                parent_id: Some(v5::SessionsQueryParentId {
                    kind: Some(v5::sessions_query_parent_id::Kind::Clear(v5::Empty {})),
                }),
                ..listed("ses_list_")
            },
        )
        .await;
        assert_eq!(roots.data.data.items.len(), 3);
        let children = list(
            &mut client,
            v5::SessionsQuery {
                parent_id: Some(v5::SessionsQueryParentId {
                    kind: Some(v5::sessions_query_parent_id::Kind::Value1(text(
                        "ses_list_a",
                    ))),
                }),
                ..listed("ses_list_")
            },
        )
        .await;
        assert!(children.data.data.items.is_empty());

        let descriptor = operation("session.list");
        let payload = rejected(
            client
                .call(
                    "session.list",
                    machine(),
                    list_request(v5::SessionsQuery {
                        cursor: Some(text("not a cursor")),
                        ..Default::default()
                    }),
                )
                .await,
        );
        assert_eq!(payload.type_name, v5::InvalidCursorError::full_name());
        assert!(descriptor.error_types.contains(&payload.type_name));
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn archive_pin_and_rename_change_the_session_and_report_unknown_ones() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let sessions = &world().core.sessions;
        let scope = || session_scope("ses_state_flags");
        let info = || sessions.get(&id("ses_state_flags")).unwrap().unwrap();

        let _: v5::SessionArchiveResult = success(
            client
                .call(
                    "session.archive",
                    scope(),
                    v5::SessionArchiveRequest {
                        params: params("ses_state_flags"),
                    }
                    .encode_to_vec(),
                )
                .await,
        );
        assert!(info().time.archived.is_some());
        let _: v5::SessionUnarchiveResult = success(
            client
                .call(
                    "session.unarchive",
                    scope(),
                    v5::SessionUnarchiveRequest {
                        params: v5::SessionUnarchiveRequestParams {
                            session_id: text("ses_state_flags"),
                        },
                    }
                    .encode_to_vec(),
                )
                .await,
        );
        assert!(info().time.archived.is_none());

        let _: v5::SessionPinResult = success(
            client
                .call(
                    "session.pin",
                    scope(),
                    v5::SessionPinRequest {
                        params: v5::SessionPinRequestParams {
                            session_id: text("ses_state_flags"),
                        },
                    }
                    .encode_to_vec(),
                )
                .await,
        );
        assert!(info().time.pinned.is_some());
        let _: v5::SessionUnpinResult = success(
            client
                .call(
                    "session.unpin",
                    scope(),
                    v5::SessionUnpinRequest {
                        params: v5::SessionUnpinRequestParams {
                            session_id: text("ses_state_flags"),
                        },
                    }
                    .encode_to_vec(),
                )
                .await,
        );
        assert!(info().time.pinned.is_none());

        let _: v5::SessionRenameResult = success(
            client
                .call(
                    "session.rename",
                    scope(),
                    v5::SessionRenameRequest {
                        params: v5::SessionRenameRequestParams {
                            session_id: text("ses_state_flags"),
                        },
                        payload: v5::SessionRenameRequestPayload {
                            title: text("A new title"),
                        },
                    }
                    .encode_to_vec(),
                )
                .await,
        );
        assert_eq!(units_of(&info().title), "A new title");

        let missing = rejected(
            client
                .call(
                    "session.archive",
                    session_scope("ses_state_nowhere"),
                    v5::SessionArchiveRequest {
                        params: params("ses_state_nowhere"),
                    }
                    .encode_to_vec(),
                )
                .await,
        );
        assert_eq!(missing.type_name, v5::SessionNotFoundError::full_name());
        assert!(
            operation("session.archive")
                .error_types
                .contains(&missing.type_name)
        );
        server.shutdown().await.unwrap();
    })
    .await;
}

fn units_of(value: &ycoding_core::ycoding_schema::LosslessString) -> String {
    String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn active_lists_nothing_while_no_session_runs() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();

        let active: v5::SessionActiveResult = success(
            client
                .call(
                    "session.active",
                    machine(),
                    v5::SessionActiveRequest {}.encode_to_vec(),
                )
                .await,
        );

        assert!(active.data.entries.is_empty());
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn todo_list_returns_the_stored_todos_in_position_order() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        world()
            .store
            .submit(|tx| {
                for (position, content, status, priority) in [
                    (1, "second", "completed", "low"),
                    (0, "first", "in_progress", "high"),
                ] {
                    TodoTable::insert(
                        tx,
                        &Todo {
                            session_id: "ses_state_todo".into(),
                            content: content.into(),
                            status: status.into(),
                            priority: priority.into(),
                            position,
                            time_created: 1,
                            time_updated: 1,
                        },
                    )?;
                }
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
        let request = |session: &str| {
            v5::SessionTodoListRequest {
                params: v5::SessionTodoListRequestParams {
                    session_id: text(session),
                },
            }
            .encode_to_vec()
        };

        let listed: v5::SessionTodoListResult = success(
            client
                .call(
                    "session.todo.list",
                    session_scope("ses_state_todo"),
                    request("ses_state_todo"),
                )
                .await,
        );
        let items = &listed.data.items;
        assert_eq!(
            items
                .iter()
                .map(|todo| units(&todo.content))
                .collect::<Vec<_>>(),
            ["first", "second"]
        );
        assert_eq!(
            items[0].status,
            v5::SessionTodoInfoStatus::SessiontodoInfoStatusInProgress as i32
        );
        assert_eq!(
            items[0].priority,
            v5::SessionTodoInfoPriority::SessiontodoInfoPriorityHigh as i32
        );
        assert_eq!(
            items[1].status,
            v5::SessionTodoInfoStatus::SessiontodoInfoStatusCompleted as i32
        );

        let missing = rejected(
            client
                .call(
                    "session.todo.list",
                    session_scope("ses_state_nowhere"),
                    request("ses_state_nowhere"),
                )
                .await,
        );
        assert_eq!(missing.type_name, v5::SessionNotFoundError::full_name());
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn diagnostics_report_the_latest_measured_assistant_step() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let request = |session: &str| {
            v5::SessionDiagnosticsRequest {
                params: v5::SessionDiagnosticsRequestParams {
                    session_id: text(session),
                },
            }
            .encode_to_vec()
        };

        let unmeasured: v5::SessionDiagnosticsResult = success(
            client
                .call(
                    "session.diagnostics",
                    session_scope("ses_state_diag"),
                    request("ses_state_diag"),
                )
                .await,
        );
        assert!(unmeasured.data.is_none());

        world()
            .store
            .submit(|tx| {
                MessageTable::insert(
                    tx,
                    &Row {
                        id: "msg_state_diag".into(),
                        session_id: "ses_state_diag".into(),
                        type_: "assistant".into(),
                        seq: 1,
                        time_created: 1,
                        time_updated: 1,
                        data: parse_json(
                            r#"{"time":{"created":10,"completed":11},"agent":"build","model":{"id":"m1","providerID":"p1"},"content":[],"finish":"stop","cost":0.5,"tokens":{"input":100,"output":2,"reasoning":3,"cache":{"read":4,"write":5}}}"#,
                        )
                        .unwrap(),
                    },
                )
            })
            .unwrap()
            .wait()
            .unwrap();
        let measured: v5::SessionDiagnosticsResult = success(
            client
                .call(
                    "session.diagnostics",
                    session_scope("ses_state_diag"),
                    request("ses_state_diag"),
                )
                .await,
        );
        let data = measured.data.expect("a measured assistant step");
        assert_eq!(data.context.total, 114);
        assert_eq!(data.tokens.uncached_input, 100);
        assert_eq!(data.tokens.cache_read, 4);
        assert_eq!(data.cache.eligible, 109);
        assert_eq!(
            data.cache.mechanism,
            v5::SessionCacheMechanism::SessionCachemechanismProviderReported as i32
        );
        assert_eq!(data.estimated_cost, Some(0.5));
        assert_eq!(units(&data.model.id), "m1");
        assert_eq!(data.requests.as_ref().unwrap().logical, 0);
        let unsampled = data.generation_speed.as_ref().unwrap();
        assert_eq!(units(&unsampled.model.as_ref().unwrap().id), "m1");
        assert!(unsampled.latest.is_none());
        assert!(unsampled.recent.items.is_empty());
        assert!(unsampled.unreported_reason.is_none());

        ycoding_core::session::store::Service::new(world().store.clone()).publish(
            ycoding_core::ycoding_store::session::NewEvent {
                id: "evt_state_diag_request".into(), aggregate_id: "ses_state_diag".into(), created: 12,
                type_: "session.provider.request.recorded.1".into(),
                data: parse_json(r#"{"sessionID":"ses_state_diag","id":"prq_state_diag","source":"step","agent":"build","model":{"providerID":"p1","id":"m1"},"routeID":"unknown","promptCacheKey":"namespace","systemDigest":"system","toolDigest":"tools","request":1,"attempts":2,"invalidation":"provider-not-reported","continuation":"full","tokens":{"input":100,"output":2,"reasoning":3,"cache":{"read":4,"write":5}},"timing":{"generatedTokens":12,"generationDurationNs":2000000000},"time":12}"#).unwrap(),
            }
        ).await.unwrap();
        let measured: v5::SessionDiagnosticsResult = success(client.call("session.diagnostics", session_scope("ses_state_diag"), request("ses_state_diag")).await);
        let data = measured.data.unwrap();
        let requests = data.requests.unwrap(); assert_eq!((requests.logical, requests.physical), (1, 2));
        assert_eq!(requests.latest_timing.unwrap().generated_tokens, Some(12));
        assert!(requests.cost.is_none()); assert!(requests.cache_read_reported.is_none());
        let speed = data.generation_speed.unwrap();
        assert_eq!(speed.latest.as_ref().unwrap().tokens_per_second, 6.0);
        assert_eq!(speed.recent.items.len(), 1);
        let snapshot: v5::SessionSnapshotResult = success(client.call("session.snapshot", session_scope("ses_state_diag"), v5::SessionSnapshotRequest {
            params: v5::SessionSnapshotRequestParams { session_id: text("ses_state_diag") },
            query: v5::SessionSnapshotQuery { limit: Some(100), before: None },
        }.encode_to_vec()).await);
        assert_eq!(snapshot.data.generation_speed, Some(speed));

        let missing = rejected(
            client
                .call(
                    "session.diagnostics",
                    session_scope("ses_state_nowhere"),
                    request("ses_state_nowhere"),
                )
                .await,
        );
        assert_eq!(missing.type_name, v5::SessionNotFoundError::full_name());
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revert_commit_drops_the_reverted_history_and_clears_the_stage() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let sessions = &world().core.sessions;
        world()
            .store
            .submit(|tx| {
                for (seq, name) in [
                    (1, "msg_state_keep"),
                    (2, "msg_state_cut"),
                    (3, "msg_state_gone"),
                ] {
                    MessageTable::insert(
                        tx,
                        &Row {
                            id: name.into(),
                            session_id: "ses_state_commit".into(),
                            type_: "synthetic".into(),
                            seq,
                            time_created: seq,
                            time_updated: seq,
                            data: parse_json(r#"{"text":"x","time":{"created":1}}"#).unwrap(),
                        },
                    )?;
                }
                let key = tuple_key(&[KeyPart::String(&"ses_state_commit".into())]);
                let mut row = tx.get::<SessionTable>(&key)?.unwrap();
                row.revert = Some(Document::new(
                    parse_json(r#"{"messageID":"msg_state_cut"}"#).unwrap(),
                )?);
                SessionTable::put(tx, &row)
            })
            .unwrap()
            .wait()
            .unwrap();
        assert!(
            sessions
                .get(&id("ses_state_commit"))
                .unwrap()
                .unwrap()
                .revert
                .is_some()
        );
        let request = |session: &str| {
            v5::SessionRevertCommitRequest {
                params: v5::SessionRevertCommitRequestParams {
                    session_id: text(session),
                },
            }
            .encode_to_vec()
        };

        let _: v5::SessionRevertCommitResult = success(
            client
                .call(
                    "session.revert.commit",
                    session_scope("ses_state_commit"),
                    request("ses_state_commit"),
                )
                .await,
        );

        assert!(
            sessions
                .get(&id("ses_state_commit"))
                .unwrap()
                .unwrap()
                .revert
                .is_none()
        );
        let stored = |name: &str| {
            sessions
                .message(&session_message::Id::new(name).unwrap())
                .unwrap()
                .is_some()
        };
        assert!(stored("msg_state_keep"));
        assert!(!stored("msg_state_cut"));
        assert!(!stored("msg_state_gone"));

        let missing = rejected(
            client
                .call(
                    "session.revert.commit",
                    session_scope("ses_state_nowhere"),
                    request("ses_state_nowhere"),
                )
                .await,
        );
        assert_eq!(missing.type_name, v5::SessionNotFoundError::full_name());
        server.shutdown().await.unwrap();
    })
    .await;
}
