mod support;

use prost::{Message, Name};
use support::*;
use ycoding_core::ycoding_schema::{ObjectEncoder, session};
use ycoding_core::ycoding_store::{
    KeyPart,
    session::{NewEvent, SessionTable},
    tuple_key,
};
use ycoding_protocol::v5;
use ycoding_runtime::{LocalAuth, standard};

fn synthetic(
    session: &str,
    id: Option<&str>,
    content: &str,
    delivery: Option<i32>,
    resume: Option<bool>,
) -> Vec<u8> {
    v5::SessionSyntheticRequest {
        params: v5::SessionSyntheticRequestParams {
            session_id: text(session),
        },
        payload: v5::SessionSyntheticRequestPayload {
            id: id.map(text),
            text: text(content),
            description: Some(text("completion")),
            metadata: Some(v5::SessionSyntheticRequestPayloadMetadata {
                entries: vec![v5::SessionSyntheticRequestPayloadMetadataEntry {
                    key: text("job"),
                    value: v5::Value {
                        kind: Some(v5::value::Kind::String(text("complete"))),
                    },
                }],
            }),
            delivery,
            resume,
        },
    }
    .encode_to_vec()
}

fn fork(session: &str, boundary: Option<&str>) -> Vec<u8> {
    v5::SessionForkRequest {
        params: v5::SessionForkRequestParams {
            session_id: text(session),
        },
        payload: v5::SessionForkRequestPayload {
            message_id: boundary.map(text),
        },
    }
    .encode_to_vec()
}

fn daybreak(session: &str, program: Option<i32>) -> Vec<u8> {
    use v5::session_daybreak_set_request_payload_daybreak::Kind;
    v5::SessionDaybreakSetRequest {
        params: v5::SessionDaybreakSetRequestParams {
            session_id: text(session),
        },
        payload: v5::SessionDaybreakSetRequestPayload {
            daybreak: v5::SessionDaybreakSetRequestPayloadDaybreak {
                kind: Some(program.map_or(Kind::Clear(v5::Empty {}), Kind::Value1)),
            },
        },
    }
    .encode_to_vec()
}

fn changes(session: &str) -> Vec<u8> {
    v5::SessionFileChangeListRequest {
        params: v5::SessionFileChangeListRequestParams {
            session_id: text(session),
        },
    }
    .encode_to_vec()
}

async fn seed(id: &str) {
    let name = id.to_owned();
    world()
        .store
        .submit(move |tx| {
            let mut row = tx
                .get::<SessionTable>(&tuple_key(&[KeyPart::String(&"ses_get".into())]))?
                .unwrap();
            row.id = name.into();
            row.title = "Operations".into();
            SessionTable::insert(tx, &row)
        })
        .unwrap()
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wire_synthetic_retry_fork_daybreak_and_file_changes_use_durable_core_state() {
    seed("ses_ops_flow").await;
    let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
    let mut client = Client::open(server.address(), &[]).await.unwrap();
    let input: v5::SessionSyntheticResult = success(
        client
            .call(
                "session.synthetic",
                session_scope("ses_ops_flow"),
                synthetic(
                    "ses_ops_flow",
                    Some("msg_ops_first"),
                    "original",
                    None,
                    Some(false),
                ),
            )
            .await,
    );
    assert_eq!(units(&input.data.data.text), "original");
    assert_eq!(
        input.data.delivery,
        v5::SessionPendingSyntheticDelivery::SessionpendingSyntheticDeliverySteer as i32
    );
    let retry: v5::SessionSyntheticResult = success(
        client
            .call(
                "session.synthetic",
                session_scope("ses_ops_flow"),
                synthetic(
                    "ses_ops_flow",
                    Some("msg_ops_first"),
                    "changed",
                    Some(v5::SessionSyntheticRequestPayloadDelivery::Queue as i32),
                    Some(false),
                ),
            )
            .await,
    );
    assert_eq!(retry, input);
    let sessions = &world().core.sessions;
    let id = session::Id::new("ses_ops_flow").unwrap();
    assert!(sessions.transcript(&id).unwrap().is_empty());
    sessions.promote_steers(&id, 20).await.unwrap();
    let retry: v5::SessionSyntheticResult = success(
        client
            .call(
                "session.synthetic",
                session_scope("ses_ops_flow"),
                synthetic(
                    "ses_ops_flow",
                    Some("msg_ops_first"),
                    "changed again",
                    None,
                    Some(false),
                ),
            )
            .await,
    );
    assert_eq!(retry, input);
    let queued: v5::SessionSyntheticResult = success(
        client
            .call(
                "session.synthetic",
                session_scope("ses_ops_flow"),
                synthetic(
                    "ses_ops_flow",
                    None,
                    "queued",
                    Some(v5::SessionSyntheticRequestPayloadDelivery::Queue as i32),
                    Some(false),
                ),
            )
            .await,
    );
    assert!(!units(&queued.data.id).is_empty());
    assert_eq!(sessions.promote_steers(&id, 30).await.unwrap(), 0);
    assert!(sessions.promote_next_queued(&id, 30).await.unwrap());
    let blue: v5::SessionDaybreakSetResult = success(
        client
            .call(
                "session.daybreak.set",
                session_scope("ses_ops_flow"),
                daybreak("ses_ops_flow", Some(v5::ModelDaybreak::DaybreakBlue as i32)),
            )
            .await,
    );
    assert_eq!(
        blue.data.daybreak,
        Some(v5::ModelDaybreak::DaybreakBlue as i32)
    );
    let forked: v5::SessionForkResult = success(
        client
            .call(
                "session.fork",
                session_scope("ses_ops_flow"),
                fork("ses_ops_flow", Some(&units(&queued.data.id))),
            )
            .await,
    );
    assert!(forked.data.parent_id.is_none());
    assert!(forked.data.daybreak.is_none());
    assert_eq!(units(&forked.data.title), "Operations (fork #1)");
    assert_eq!(
        sessions
            .transcript(&session::Id::new(units(&forked.data.id)).unwrap())
            .unwrap()
            .len(),
        1
    );
    let clear: v5::SessionDaybreakSetResult = success(
        client
            .call(
                "session.daybreak.set",
                session_scope("ses_ops_flow"),
                daybreak("ses_ops_flow", None),
            )
            .await,
    );
    assert!(clear.data.daybreak.is_none());
    sessions
        .publish(NewEvent {
            id: "evt_ops_change".into(),
            aggregate_id: id.as_lossless().clone(),
            created: 40,
            type_: "session.file-change.recorded.1".into(),
            data: ObjectEncoder::new()
                .field("sessionID", &id)
                .field(
                    "change",
                    &ObjectEncoder::new()
                        .field("path", "src/main.rs")
                        .field("patch", "patch")
                        .field("additions", &2.0)
                        .field("deletions", &1.0)
                        .finish(),
                )
                .finish(),
        })
        .await
        .unwrap();
    let changes: v5::SessionFileChangeListResult = success(
        client
            .call(
                "session.fileChange.list",
                session_scope("ses_ops_flow"),
                changes("ses_ops_flow"),
            )
            .await,
    );
    assert_eq!(changes.data.items.len(), 1);
    assert_eq!(units(&changes.data.items[0].path), "src/main.rs");
    assert_eq!(
        (
            changes.data.items[0].additions,
            changes.data.items[0].deletions
        ),
        (2, 1)
    );
    let log = sessions.log(&id, None, 20).unwrap();
    assert_eq!(
        log.events
            .iter()
            .filter(|event| event.event.0.event_type.as_str() == Some("session.input.admitted"))
            .count(),
        2
    );
    server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wire_operations_return_declared_missing_conflict_and_scope_errors() {
    seed("ses_ops_errors").await;
    let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
    let mut client = Client::open(server.address(), &[]).await.unwrap();
    for (operation, payload) in [
        (
            "session.synthetic",
            synthetic("ses_ops_absent", None, "test", None, Some(false)),
        ),
        ("session.fork", fork("ses_ops_absent", None)),
        ("session.daybreak.set", daybreak("ses_ops_absent", None)),
        ("session.fileChange.list", changes("ses_ops_absent")),
    ] {
        let error = rejected(
            client
                .call(operation, session_scope("ses_ops_absent"), payload)
                .await,
        );
        assert_eq!(error.type_name, v5::SessionNotFoundError::full_name());
        assert_eq!(
            units(
                &v5::SessionNotFoundError::decode(error.payload.as_slice())
                    .unwrap()
                    .session_id
            ),
            "ses_ops_absent"
        );
    }
    for boundary in ["msg_missing_ops", "msg_rich_01"] {
        let error = rejected(
            client
                .call(
                    "session.fork",
                    session_scope("ses_ops_errors"),
                    fork("ses_ops_errors", Some(boundary)),
                )
                .await,
        );
        assert_eq!(error.type_name, v5::MessageNotFoundError::full_name());
        let error = v5::MessageNotFoundError::decode(error.payload.as_slice()).unwrap();
        assert_eq!(units(&error.session_id), "ses_ops_errors");
        assert_eq!(units(&error.message_id), boundary);
    }
    for message in ["msg_rich_01", "msg_ops_owner"] {
        if message == "msg_ops_owner" {
            success::<v5::SessionSyntheticResult>(
                client
                    .call(
                        "session.synthetic",
                        session_scope("ses_ops_errors"),
                        synthetic("ses_ops_errors", Some(message), "owned", None, Some(false)),
                    )
                    .await,
            );
        }
        let error = rejected(
            client
                .call(
                    "session.synthetic",
                    session_scope("ses_get"),
                    synthetic("ses_get", Some(message), "foreign", None, Some(false)),
                )
                .await,
        );
        assert_eq!(error.type_name, v5::ConflictError::full_name());
    }
    let error = rejected(
        client
            .call(
                "session.fork",
                session_scope("ses_ops_errors"),
                fork("ses_get", None),
            )
            .await,
    );
    assert_eq!(error.type_name, v5::InvalidRequestError::full_name());
    let error = rejected(
        client
            .call(
                "session.fork",
                session_scope("ses_ops_errors"),
                fork("ses_ops_errors", Some("invalid-prefix")),
            )
            .await,
    );
    assert_eq!(error.type_name, v5::InvalidRequestError::full_name());
    server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn synthetic_default_resume_wakes_but_staged_revert_holds_admission() {
    seed("ses_ops_resume").await;
    seed("ses_ops_revert").await;
    let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
    let mut client = Client::open(server.address(), &[]).await.unwrap();
    let admitted: v5::SessionSyntheticResult = success(
        client
            .call(
                "session.synthetic",
                session_scope("ses_ops_resume"),
                synthetic("ses_ops_resume", None, "wake", None, None),
            )
            .await,
    );
    let id = session::Id::new("ses_ops_resume").unwrap();
    world().core.execution.await_idle(&id).await;
    let log = world().core.sessions.log(&id, None, 20).unwrap();
    assert!(
        log.events
            .iter()
            .any(|event| event.event.0.event_type.as_str() == Some("session.execution.started"))
    );
    assert_eq!(units(&admitted.data.data.text), "wake");
    world()
        .core
        .sessions
        .publish(NewEvent {
            id: "evt_ops_revert".into(),
            aggregate_id: "ses_ops_revert".into(),
            created: 50,
            type_: "session.revert.staged.1".into(),
            data: ObjectEncoder::new()
                .field("sessionID", "ses_ops_revert")
                .field(
                    "revert",
                    &ObjectEncoder::new()
                        .field("messageID", "msg_ops_boundary")
                        .field(
                            "files",
                            &Vec::<ycoding_core::ycoding_schema::JsonValue>::new(),
                        )
                        .finish(),
                )
                .finish(),
        })
        .await
        .unwrap();
    success::<v5::SessionSyntheticResult>(
        client
            .call(
                "session.synthetic",
                session_scope("ses_ops_revert"),
                synthetic("ses_ops_revert", Some("msg_ops_held"), "held", None, None),
            )
            .await,
    );
    let id = session::Id::new("ses_ops_revert").unwrap();
    assert!(!world().core.execution.active().contains(&id));
    assert_eq!(world().core.sessions.pending_list(&id).unwrap().len(), 1);
    server.shutdown().await.unwrap();
}

#[test]
fn wire_bounds_reject_unknown_daybreak_and_delivery_and_missing_program() {
    assert!(
        ycoding_protocol::decode_strict::<v5::SessionDaybreakSetRequest>(&daybreak(
            "ses_ops",
            Some(3)
        ))
        .is_err()
    );
    assert!(
        ycoding_protocol::decode_strict::<v5::SessionDaybreakSetRequest>(
            &v5::SessionDaybreakSetRequest {
                params: v5::SessionDaybreakSetRequestParams {
                    session_id: text("ses_ops")
                },
                payload: v5::SessionDaybreakSetRequestPayload {
                    daybreak: v5::SessionDaybreakSetRequestPayloadDaybreak { kind: None }
                },
            }
            .encode_to_vec()
        )
        .is_err()
    );
    assert!(
        ycoding_protocol::decode_strict::<v5::SessionSyntheticRequest>(&synthetic(
            "ses_ops",
            None,
            "test",
            Some(3),
            Some(false)
        ))
        .is_err()
    );
    assert!(
        ycoding_protocol::decode_strict::<v5::SessionSyntheticRequest>(&synthetic(
            "ses_ops",
            None,
            "",
            None,
            Some(false)
        ))
        .is_ok()
    );
}
