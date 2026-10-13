mod support;

use prost::Message;
use std::{collections::BTreeSet, time::Duration};
use support::{wire::*, *};
use ycoding_core::event_feed::{Ephemeral, Payload, Scope, Subscriber};
use ycoding_core::session::{autonomy::Goal, pending::Request};
use ycoding_core::tools::builtin::shell::{Job, Jobs};
use ycoding_core::ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, event, parse_json, session, session_message,
    session_pending,
};
use ycoding_core::ycoding_store::{
    KeyPart,
    resources::{Shell, ShellTable},
    session::{NewEvent, SessionTable, append},
    tuple_key,
};
use ycoding_protocol::v5;

async fn bounded<F: std::future::Future>(future: F) -> F::Output {
    tokio::time::timeout(Duration::from_secs(60), future)
        .await
        .expect("test exceeded its time bound")
}

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn names(items: &[v5::LosslessString]) -> BTreeSet<String> {
    items.iter().map(units).collect()
}

fn outstanding(failures: bool) -> v5::SessionOutstandingRequest {
    v5::SessionOutstandingRequest {
        query: v5::SessionOutstandingRequestQuery {
            failures: Some(failures),
        },
    }
}

async fn admit_pending(session: &str) {
    world()
        .core
        .execution
        .prompt(
            Request {
                id: session_message::Id::new(format!("msg_{session}")).unwrap(),
                session_id: id(session),
                input: session_pending::Message::decode(
                    &parse_json(r#"{"type":"user","data":{"text":"queued"},"delivery":"queue"}"#)
                        .unwrap(),
                )
                .unwrap(),
                event_id: event::Id::new(format!("evt_{session}")).unwrap(),
                created: 10,
            },
            Some(false),
        )
        .await
        .unwrap();
}

fn record(session: &str, type_: &str, fields: &str) {
    let (event_id, session, type_, data) = (
        format!("evt_{type_}_{session}").replace('.', "_"),
        session.to_owned(),
        type_.to_owned(),
        parse_json(&format!(r#"{{"sessionID":"{session}"{fields}}}"#)).unwrap(),
    );
    world()
        .store
        .submit(move |tx| {
            append(
                tx,
                &NewEvent {
                    id: event_id.as_str().into(),
                    aggregate_id: session.as_str().into(),
                    created: 30,
                    type_: type_.as_str().into(),
                    data,
                },
                None,
            )
            .map(|_| ())
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn adopt(child: &str, parent: &str) {
    let (child, parent) = (child.to_owned(), parent.to_owned());
    world()
        .store
        .submit(move |tx| {
            let key = tuple_key(&[KeyPart::String(&child.as_str().into())]);
            let mut row = tx.get::<SessionTable>(&key)?.expect("seeded child");
            row.parent_id = Some(parent.as_str().into());
            SessionTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outstanding_reports_work_owed_running_failed_and_lost_sessions() {
    bounded(async {
        for session in [
            "ses_out_goal",
            "ses_out_pending",
            "ses_out_shell",
            "ses_out_clean",
            "ses_out_root",
            "ses_out_child",
            "ses_out_recovered",
            "ses_out_lost",
        ] {
            insert_session(session, "/loc/out", None).await;
        }
        world()
            .core
            .autonomy
            .set_goal(&id("ses_out_goal"), Goal::new("Ship", None, None))
            .await
            .unwrap();
        admit_pending("ses_out_pending").await;
        let lease = world().core.execution.job_shells().background(&Job {
            session_id: id("ses_out_shell"),
            call_id: "call_out_shell".into(),
            command: "sleep 600".into(),
        });
        adopt("ses_out_child", "ses_out_root");
        let error = r#","error":{"type":"unknown","message":"failed"}"#;
        record("ses_out_child", "session.execution.failed.1", error);
        record("ses_out_recovered", "session.execution.failed.1", error);
        record("ses_out_recovered", "session.execution.started.1", "");
        world()
            .store
            .submit(|tx| {
                ShellTable::insert(
                    tx,
                    &Shell {
                        id: "shl_out_lost".into(),
                        session_id: Some("ses_out_lost".into()),
                        pid: 1,
                        process_started: None,
                        owner_pid: 1,
                        owner_started: "Mon Jan  1 00:00:00 2024".into(),
                        notice_pending: 1,
                        time_created: 1,
                        time_lost: Some(2),
                        start_seq: -1,
                    },
                )
            })
            .unwrap()
            .wait()
            .unwrap();

        let (server, mut client) = open().await;
        let with_failures: v5::SessionOutstandingResult = ask(
            &mut client,
            "session.outstanding",
            machine(),
            outstanding(true),
        )
        .await;
        let owed = names(&with_failures.data.items);
        for session in ["ses_out_goal", "ses_out_pending", "ses_out_shell"] {
            assert!(owed.contains(session), "{session} is owed work: {owed:?}");
        }
        for session in ["ses_out_clean", "ses_out_root", "ses_out_lost"] {
            assert!(!owed.contains(session), "{session} owes nothing: {owed:?}");
        }
        let running = names(&with_failures.running.items);
        assert!(running.contains("ses_out_shell"));
        assert!(!running.contains("ses_out_goal"));
        let failed = names(&with_failures.failed.items);
        assert!(failed.contains("ses_out_root"), "{failed:?}");
        assert!(!failed.contains("ses_out_child"), "{failed:?}");
        assert!(!failed.contains("ses_out_recovered"), "{failed:?}");
        assert!(names(&with_failures.lost.items).contains("ses_out_lost"));

        let without: v5::SessionOutstandingResult = ask(
            &mut client,
            "session.outstanding",
            machine(),
            outstanding(false),
        )
        .await;
        assert!(without.failed.items.is_empty());
        assert!(names(&without.data.items).contains("ses_out_shell"));

        drop(lease);
        server.shutdown().await.unwrap();
    })
    .await;
}

fn todo(
    content: &str,
    status: v5::SessionTodoInfoStatus,
    priority: v5::SessionTodoInfoPriority,
) -> v5::SessionTodoInfo {
    v5::SessionTodoInfo {
        content: text(content),
        status: status as i32,
        priority: priority as i32,
    }
}

fn todo_update(session: &str, items: Vec<v5::SessionTodoInfo>) -> v5::SessionTodoUpdateRequest {
    v5::SessionTodoUpdateRequest {
        params: v5::SessionTodoUpdateRequestParams {
            session_id: text(session),
        },
        payload: v5::SessionTodoUpdateRequestPayload {
            todos: v5::SessionTodoUpdateRequestPayloadTodos { items },
        },
    }
}

fn todo_list(session: &str) -> v5::SessionTodoListRequest {
    v5::SessionTodoListRequest {
        params: v5::SessionTodoListRequestParams {
            session_id: text(session),
        },
    }
}

fn ephemeral(subscriber: &Subscriber, event_type: &str) -> Ephemeral {
    loop {
        let item = subscriber
            .next()
            .unwrap()
            .unwrap_or_else(|| panic!("{event_type} reached the feed"));
        if let Payload::Ephemeral(event) = &item.payload
            && event.data.name() == event_type
        {
            return event.clone();
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn todo_update_replaces_the_list_publishes_todo_updated_and_reports_unknown_sessions() {
    bounded(async {
        insert_session("ses_todo_update", "/loc/todo", None).await;
        let subscriber = world()
            .core
            .events
            .subscribe(Scope::Session(id("ses_todo_update")), None, || {})
            .unwrap();
        let (server, mut client) = open().await;
        let scope = session_scope("ses_todo_update");
        let mut subscriptions = Vec::new();
        let global = v5::Scope {
            target: Some(v5::scope::Target::Global(v5::Empty {})),
        };
        for target in [global.clone(), scope.clone()] {
            let request = client
                .send(
                    "event.subscribe",
                    global.clone(),
                    v5::EventSubscribeRequest {
                        scope: target.clone(),
                    }
                    .encode_to_vec(),
                )
                .await;
            subscriptions.push(client.subscribe_events(&request, target).await);
        }
        let first = vec![
            todo(
                "first",
                v5::SessionTodoInfoStatus::SessiontodoInfoStatusInProgress,
                v5::SessionTodoInfoPriority::SessiontodoInfoPriorityHigh,
            ),
            todo(
                "second",
                v5::SessionTodoInfoStatus::SessiontodoInfoStatusPending,
                v5::SessionTodoInfoPriority::SessiontodoInfoPriorityLow,
            ),
        ];

        let updated: v5::SessionTodoUpdateResult = ask(
            &mut client,
            "session.todo.update",
            scope.clone(),
            todo_update("ses_todo_update", first.clone()),
        )
        .await;
        assert_eq!(updated.data.items, first);
        let listed: v5::SessionTodoListResult = ask(
            &mut client,
            "session.todo.list",
            scope.clone(),
            todo_list("ses_todo_update"),
        )
        .await;
        assert_eq!(listed.data.items, first);

        let event = ephemeral(&subscriber, "todo.updated");
        assert_eq!(event.session, Some(id("ses_todo_update")));
        let encoded = ycoding_core::ycoding_schema::DomainEncode::encode(&event.data);
        let JsonValue::Object(data) = &encoded else {
            panic!("todo.updated carries an object")
        };
        assert_eq!(
            data.get(&LosslessString::from("sessionID")),
            Some(&JsonValue::String("ses_todo_update".into()))
        );
        let Some(JsonValue::Array(todos)) = data.get(&LosslessString::from("todos")) else {
            panic!("todo.updated carries the replaced list")
        };
        assert_eq!(todos.len(), 2);
        let received = |client: &Client, subscription: &String| {
            client
                .batches
                .iter()
                .filter(|batch| &batch.subscription_id == subscription)
                .flat_map(|batch| &batch.events)
                .filter(|record| record.durable.is_none())
                .find_map(|record| {
                    let Some(v5::public_event::Kind::TodoUpdated(event)) =
                        v5::PublicEvent::decode(record.event.payload.as_slice())
                            .unwrap()
                            .kind
                    else {
                        return None;
                    };
                    Some(event)
                })
        };
        while subscriptions
            .iter()
            .any(|subscription| received(&client, subscription).is_none())
        {
            client.step().await;
        }
        for subscription in &subscriptions {
            let event = received(&client, subscription).unwrap();
            assert_eq!(event.data.todos.items, first);
            assert_eq!(units(&event.location.unwrap().directory), "/loc/todo");
        }

        let replacement = vec![todo(
            "only",
            v5::SessionTodoInfoStatus::SessiontodoInfoStatusCompleted,
            v5::SessionTodoInfoPriority::SessiontodoInfoPriorityMedium,
        )];
        let _: v5::SessionTodoUpdateResult = ask(
            &mut client,
            "session.todo.update",
            scope.clone(),
            todo_update("ses_todo_update", replacement.clone()),
        )
        .await;
        let listed: v5::SessionTodoListResult = ask(
            &mut client,
            "session.todo.list",
            scope,
            todo_list("ses_todo_update"),
        )
        .await;
        assert_eq!(listed.data.items, replacement);

        let missing: v5::SessionNotFoundError = refuse(
            &mut client,
            "session.todo.update",
            session_scope("ses_todo_nowhere"),
            todo_update("ses_todo_nowhere", replacement),
        )
        .await;
        assert_eq!(units(&missing.session_id), "ses_todo_nowhere");
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn permission_events_reach_feed_subscribers_and_the_public_wire() {
    bounded(async {
        insert_session("ses_feed_perm", "/loc/feedperm", None).await;
        let subscriber = world()
            .core
            .events
            .subscribe(Scope::Session(id("ses_feed_perm")), None, || {})
            .unwrap();
        let (server, mut client) = open().await;
        let scope = session_scope("ses_feed_perm");
        let sub = client
            .send(
                "event.subscribe",
                v5::Scope {
                    target: Some(v5::scope::Target::Global(v5::Empty {})),
                },
                v5::EventSubscribeRequest {
                    scope: scope.clone(),
                }
                .encode_to_vec(),
            )
            .await;
        client.subscribe_events(&sub, scope.clone()).await;

        let created: v5::SessionPermissionCreateResult = ask(
            &mut client,
            "session.permission.create",
            scope,
            v5::SessionPermissionCreateRequest {
                params: v5::SessionPermissionCreateRequestParams {
                    session_id: text("ses_feed_perm"),
                },
                payload: v5::SessionPermissionCreateRequestPayload {
                    id: None,
                    action: text("bash_feed"),
                    resources: v5::SessionPermissionCreateRequestPayloadResources {
                        items: vec![text("ls")],
                    },
                    save: None,
                    metadata: None,
                    source: None,
                    agent: None,
                },
            },
        )
        .await;

        let event = ephemeral(&subscriber, "permission.asked");
        assert_eq!(event.session, Some(id("ses_feed_perm")));
        let encoded = ycoding_core::ycoding_schema::DomainEncode::encode(&event.data);
        let JsonValue::Object(data) = &encoded else {
            panic!("permission.asked carries an object")
        };
        assert_eq!(
            data.get(&LosslessString::from("id")),
            Some(&JsonValue::String(units(&created.data.id).into()))
        );

        let published = |client: &Client| {
            client
                .batches
                .iter()
                .flat_map(|batch| &batch.events)
                .find_map(|record| {
                    if record.durable.is_some() {
                        return None;
                    }
                    let public = v5::PublicEvent::decode(record.event.payload.as_slice()).unwrap();
                    let Some(v5::public_event::Kind::PermissionAsked(asked)) = public.kind else {
                        return None;
                    };
                    Some((record.event_id.clone(), asked.data))
                })
        };
        while published(&client).is_none() {
            client.step().await;
        }
        assert!(client.close.is_none());
        let (event_id, asked) = published(&client).unwrap();
        assert_eq!(event_id, event.id.as_str().unwrap());
        assert_eq!(asked.id, created.data.id);
        assert_eq!(units(&asked.session_id), "ses_feed_perm");
        assert_eq!(units(&asked.action), "bash_feed");
        assert_eq!(
            asked.resources.items.iter().map(units).collect::<Vec<_>>(),
            ["ls"]
        );
        server.shutdown().await.unwrap();
    })
    .await;
}
