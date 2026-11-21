mod support;

use prost::Message;
use support::{wire::*, *};
use ycoding_core::ycoding_store::session::NewEvent;
use ycoding_core::{
    process::guardrails::Input,
    session::pending::Request,
    ycoding_schema::{
        DomainDecode, DomainEncode, JsonValue, guardrail, parse_json, session, session_message,
        session_pending,
    },
};
use ycoding_protocol::v5;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn guardrail_retry_republishes_and_cancel_settles_through_the_wire() {
    insert_session("ses_recovery_a", "/loc/recovery", None).await;
    insert_session("ses_recovery_b", "/loc/recovery", None).await;
    let id = session::Id::new("ses_recovery_a").unwrap();
    let services = world().core.locations.session(&id).unwrap().1;
    let admission = services
        .guardrails
        .assert(Input {
            session_id: id,
            action: "shell".into(),
            resources: vec!["rm -rf ~/notes".into()],
            metadata: None,
            skip_review: false,
            holder: None,
            source: None,
        })
        .unwrap();
    let original = admission.request.unwrap();
    let JsonValue::String(request_id) = original.id.encode() else {
        panic!("request ID must encode as a string")
    };
    let request_id = request_id.to_utf8().unwrap();
    let (server, mut client) = open().await;
    let retry = |session_id: &str| v5::SessionGuardrailRequestRetryRequest {
        params: v5::SessionGuardrailRequestRetryRequestParams {
            session_id: text(session_id),
            request_id: text(&request_id),
        },
    };
    let foreign: v5::GuardrailRequestNotFoundError = refuse(
        &mut client,
        "session.guardrail.request.retry",
        session_scope("ses_recovery_b"),
        retry("ses_recovery_b"),
    )
    .await;
    assert_eq!(units(&foreign.request_id), request_id);
    let repeated: v5::SessionGuardrailRequestRetryResult = ask(
        &mut client,
        "session.guardrail.request.retry",
        session_scope("ses_recovery_a"),
        retry("ses_recovery_a"),
    )
    .await;
    assert_eq!(units(&repeated.data.id), request_id);
    assert_eq!(
        repeated.data.created,
        original.created.map(|created| created.get() as u64)
    );
    let cancel = || v5::SessionGuardrailRequestCancelRequest {
        params: v5::SessionGuardrailRequestCancelRequestParams {
            session_id: text("ses_recovery_a"),
            request_id: text(&request_id),
        },
    };
    let _: v5::SessionGuardrailRequestCancelResult = ask(
        &mut client,
        "session.guardrail.request.cancel",
        session_scope("ses_recovery_a"),
        cancel(),
    )
    .await;
    assert!(admission.wait.unwrap().await.unwrap().is_err());
    let _: v5::GuardrailRequestNotFoundError = refuse(
        &mut client,
        "session.guardrail.request.cancel",
        session_scope("ses_recovery_a"),
        cancel(),
    )
    .await;
    let _: v5::GuardrailRequestNotFoundError = refuse(
        &mut client,
        "session.guardrail.request.retry",
        session_scope("ses_recovery_a"),
        retry("ses_recovery_a"),
    )
    .await;
    assert_eq!(
        services
            .guardrails
            .status(&session::Id::new("ses_recovery_a").unwrap())
            .unwrap()
            .decisions
            .unwrap()
            .last()
            .unwrap()
            .reason,
        Some(guardrail::ClosedReason::Cancelled)
    );
    drop(client);
    server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pending_controls_preserve_typed_not_found_and_non_user_errors() {
    insert_session("ses_pending_wire_a", "/loc/pending-wire", None).await;
    insert_session("ses_pending_wire_b", "/loc/pending-wire", None).await;
    let core = &world().core;
    for (name, input) in [
        (
            "user",
            r#"{"type":"user","data":{"text":"input"},"delivery":"steer"}"#,
        ),
        (
            "synthetic",
            r#"{"type":"synthetic","data":{"text":"internal"},"delivery":"queue"}"#,
        ),
    ] {
        core.sessions
            .admit(Request {
                id: session_message::Id::new(format!("msg_pending_{name}")).unwrap(),
                session_id: session::Id::new("ses_pending_wire_a").unwrap(),
                input: session_pending::Message::decode(&parse_json(input).unwrap()).unwrap(),
                event_id: ycoding_core::ycoding_schema::event::Id::new(format!(
                    "evt_pending_{name}"
                ))
                .unwrap(),
                created: 10,
            })
            .await
            .unwrap();
    }
    let (server, mut client) = open().await;
    let remove = |session_id: &str, message_id: &str| v5::SessionPendingRemoveRequest {
        params: v5::SessionPendingRemoveRequestParams {
            session_id: text(session_id),
            message_id: text(message_id),
        },
    };
    let foreign: v5::PendingInputNotFoundError = refuse(
        &mut client,
        "session.pending.remove",
        session_scope("ses_pending_wire_b"),
        remove("ses_pending_wire_b", "msg_pending_user"),
    )
    .await;
    assert_eq!(units(&foreign.message_id), "msg_pending_user");
    assert_eq!(
        units(&foreign.message),
        "Pending input not found: msg_pending_user"
    );
    let invalid: v5::InvalidRequestError = refuse(
        &mut client,
        "session.pending.remove",
        session_scope("ses_pending_wire_a"),
        remove("ses_pending_wire_a", "msg_pending_synthetic"),
    )
    .await;
    assert_eq!(
        units(invalid.kind.as_ref().unwrap()),
        "pending_input_not_user"
    );
    assert_eq!(units(invalid.field.as_ref().unwrap()), "messageID");
    let _: v5::SessionPendingSteerResult = ask(
        &mut client,
        "session.pending.steer",
        session_scope("ses_pending_wire_a"),
        v5::SessionPendingSteerRequest {
            params: v5::SessionPendingSteerRequestParams {
                session_id: text("ses_pending_wire_a"),
                message_id: text("msg_pending_user"),
            },
        },
    )
    .await;
    let _: v5::SessionPendingRemoveResult = ask(
        &mut client,
        "session.pending.remove",
        session_scope("ses_pending_wire_a"),
        remove("ses_pending_wire_a", "msg_pending_user"),
    )
    .await;
    let _: v5::PendingInputNotFoundError = refuse(
        &mut client,
        "session.pending.remove",
        session_scope("ses_pending_wire_a"),
        remove("ses_pending_wire_a", "msg_pending_user"),
    )
    .await;
    let pending = core
        .sessions
        .pending_list(&session::Id::new("ses_pending_wire_a").unwrap())
        .unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id.as_str(), Some("msg_pending_synthetic"));
    drop(client);
    server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sent_message_delete_checks_ownership_and_consumption_and_publishes_removal() {
    let session_id = "ses_delete_wire";
    let foreign_id = "ses_delete_wire_foreign";
    insert_session(session_id, "/loc/delete-wire", None).await;
    insert_session(foreign_id, "/loc/delete-wire", None).await;
    let session = session::Id::new(session_id).unwrap();
    let sessions = &world().core.sessions;
    let unread = "msg_delete_wire_unread";
    let read = "msg_delete_wire_read";
    let plugin = "msg_delete_wire_plugin";
    let pending = "msg_delete_wire_pending";
    for (name, origin, delivery) in [
        (unread, "direct", "steer"),
        (read, "direct", "steer"),
        (plugin, "plugin", "steer"),
        (pending, "direct", "queue"),
    ] {
        let input = parse_json(&format!(
            r#"{{"type":"user","data":{{"text":"Sent fixture","metadata":{{"inputOrigin":"{origin}"}}}},"delivery":"{delivery}"}}"#
        ))
        .unwrap();
        sessions
            .admit(Request {
                id: session_message::Id::new(name).unwrap(),
                session_id: session.clone(),
                input: session_pending::Message::decode(&input).unwrap(),
                event_id: ycoding_core::ycoding_schema::event::Id::new(format!("evt_{name}"))
                    .unwrap(),
                created: 10,
            })
            .await
            .unwrap();
    }
    assert_eq!(sessions.promote_steers(&session, 20).await.unwrap(), 3);

    let (server, mut client) = open().await;
    let scope = session_scope(session_id);
    let operation_name = "session.deleteMessage";
    assert_eq!(operation(operation_name).operation_id, 4112);
    let delete = |session_id, message_id| v5::SessionDeleteMessageRequest {
        params: v5::SessionDeleteMessageRequestParams {
            session_id: text(session_id),
            message_id: text(message_id),
        },
    };
    let get = |message_id| v5::SessionMessageRequest {
        params: v5::SessionMessageRequestParams {
            session_id: text(session_id),
            message_id: text(message_id),
        },
    };
    let _: v5::SessionMessageResult =
        ask(&mut client, "session.message", scope.clone(), get(read)).await;
    sessions
        .publish(NewEvent {
            id: "evt_delete_wire_consumed".into(),
            aggregate_id: session_id.into(),
            created: 30,
            type_: "session.input.consumed.1".into(),
            data: parse_json(&format!(
                r#"{{"sessionID":"{session_id}","inputIDs":["{read}"]}}"#
            ))
            .unwrap(),
        })
        .await
        .unwrap();

    let wrong_scope: v5::InvalidRequestError = refuse(
        &mut client,
        operation_name,
        scope.clone(),
        delete(foreign_id, unread),
    )
    .await;
    assert_eq!(
        units(&wrong_scope.message),
        "Session scope and request parameter disagree"
    );
    let missing_session = "ses_delete_wire_missing";
    let _: v5::SessionNotFoundError = refuse(
        &mut client,
        operation_name,
        session_scope(missing_session),
        delete(missing_session, unread),
    )
    .await;
    let foreign: v5::MessageNotFoundError = refuse(
        &mut client,
        operation_name,
        session_scope(foreign_id),
        delete(foreign_id, unread),
    )
    .await;
    assert_eq!(units(&foreign.message_id), unread);
    let _: v5::MessageNotFoundError = refuse(
        &mut client,
        operation_name,
        scope.clone(),
        delete(session_id, pending),
    )
    .await;
    for (id, reason, diagnostic) in [
        (read, 1, "YCoding has already read this message."),
        (plugin, 2, "You can only delete your own messages."),
    ] {
        let error: v5::MessageDeleteRefusedError = refuse(
            &mut client,
            operation_name,
            scope.clone(),
            delete(session_id, id),
        )
        .await;
        assert_eq!(units(&error.session_id), session_id);
        assert_eq!(units(&error.message_id), id);
        assert_eq!(error.reason, reason);
        assert_eq!(units(&error.message), diagnostic);
        let _: v5::SessionMessageResult =
            ask(&mut client, "session.message", scope.clone(), get(id)).await;
    }

    let log = client
        .send(
            "session.log",
            scope.clone(),
            v5::SessionLogRequest {
                params: v5::SessionLogRequestParams {
                    session_id: text(session_id),
                },
                query: v5::SessionLogRequestQuery {
                    after: None,
                    follow: Some(true),
                },
            }
            .encode_to_vec(),
        )
        .await;
    let log = client.subscribe_log(&log, scope.clone()).await;
    let events = client
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
    let events = client.subscribe_events(&events, scope.clone()).await;
    let deleted: v5::SessionDeleteMessageResult = ask(
        &mut client,
        operation_name,
        scope.clone(),
        delete(session_id, unread),
    )
    .await;
    assert_eq!(deleted.data, v5::Empty {});
    let _: v5::MessageNotFoundError =
        refuse(&mut client, "session.message", scope.clone(), get(unread)).await;
    let stale: v5::MessageNotFoundError = refuse(
        &mut client,
        operation_name,
        scope,
        delete(session_id, unread),
    )
    .await;
    assert_eq!(
        units(&stale.message),
        "This message is no longer available."
    );
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let mut log_seen = false;
            let mut public_seen = false;
            for batch in &client.batches {
                for record in &batch.events {
                    if batch.subscription_id == log {
                        let item =
                            v5::SessionLogItem::decode(record.event.payload.as_slice()).unwrap();
                        if let Some(v5::session_log_item::Kind::Value75(event)) = item.kind {
                            assert_eq!(units(&event.data.session_id), session_id);
                            assert_eq!(units(&event.data.input_id), unread);
                            log_seen = true;
                        }
                    } else if batch.subscription_id == events {
                        let item =
                            v5::PublicEvent::decode(record.event.payload.as_slice()).unwrap();
                        if let Some(v5::public_event::Kind::SessionInputDeleted(event)) = item.kind
                        {
                            assert_eq!(units(&event.data.session_id), session_id);
                            assert_eq!(units(&event.data.input_id), unread);
                            public_seen = true;
                        }
                    }
                }
            }
            if log_seen && public_seen {
                break;
            }
            client.step().await;
        }
    })
    .await
    .expect("delete must appear in the public event stream and Session log");
    assert_eq!(
        sessions.pending_list(&session).unwrap()[0].id.as_str(),
        Some(pending)
    );
    drop(client);
    server.shutdown().await.unwrap();
}
