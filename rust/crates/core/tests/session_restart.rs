use ycoding_core::session::store::Service;
use ycoding_schema::{parse_json, session, session_message};
use ycoding_store::session::NewEvent;

#[path = "session_support/mod.rs"]
mod support;

#[tokio::test]
async fn reconciles_missing_step_and_execution_terminals_without_resuming_or_repeating_them() {
    let store = support::store();
    let service = Service::new(store.client());
    service
        .publish(NewEvent {
            id: "evt_execution".into(),
            aggregate_id: "ses_one".into(),
            created: 1,
            type_: "session.execution.started.1".into(),
            data: parse_json(r#"{"sessionID":"ses_one"}"#).unwrap(),
        })
        .await
        .unwrap();
    service.publish(NewEvent { id: "evt_step".into(), aggregate_id: "ses_one".into(), created: 2, type_: "session.step.started.1".into(), data: parse_json(r#"{"sessionID":"ses_one","assistantMessageID":"msg_step","agent":"build","model":{"providerID":"local","id":"test"}}"#).unwrap() }).await.unwrap();
    let id = session::Id::new("ses_one").unwrap();
    service.suspend(std::slice::from_ref(&id), 3).await.unwrap();
    assert_eq!(service.reconcile_interrupted(4).await.unwrap(), 1);
    let (_, message) = service
        .message(&session_message::Id::new("msg_step").unwrap())
        .unwrap()
        .unwrap();
    let ycoding_schema::session_message::Info::Assistant(assistant) = message else {
        panic!()
    };
    assert_eq!(
        assistant.error.unwrap().r#type.as_str(),
        Some("interrupted")
    );
    assert_eq!(assistant.time.completed.unwrap().epoch_millis(), 4);
    let first = service.snapshot(&id, 100, None).unwrap();
    assert_eq!(first.watermark, Some(3));
    assert_eq!(service.reconcile_interrupted(5).await.unwrap(), 0);
    assert_eq!(service.snapshot(&id, 100, None).unwrap(), first);
    assert!(service.consume_suspended(&id).await.unwrap());
}

#[tokio::test]
async fn closed_steps_and_idle_lifecycle_history_never_manufacture_restart_continuation() {
    let store = support::store();
    let service = Service::new(store.client());
    service
        .publish(NewEvent {
            id: "evt_execution".into(),
            aggregate_id: "ses_one".into(),
            created: 1,
            type_: "session.execution.started.1".into(),
            data: parse_json(r#"{"sessionID":"ses_one"}"#).unwrap(),
        })
        .await
        .unwrap();
    service
        .publish(NewEvent {
            id: "evt_success".into(),
            aggregate_id: "ses_one".into(),
            created: 2,
            type_: "session.execution.succeeded.1".into(),
            data: parse_json(r#"{"sessionID":"ses_one"}"#).unwrap(),
        })
        .await
        .unwrap();
    assert_eq!(service.reconcile_interrupted(3).await.unwrap(), 0);
    let id = session::Id::new("ses_one").unwrap();
    assert!(!service.consume_suspended(&id).await.unwrap());
    assert!(service.pending_list(&id).unwrap().is_empty());
}

#[tokio::test]
async fn restart_closes_only_the_latest_open_step_and_leaves_closed_steps_untouched() {
    let store = support::store();
    let service = Service::new(store.client());
    for (id, now, kind, fields) in [
        ("evt_run", 1, "session.execution.started.1", ""),
        (
            "evt_first",
            2,
            "session.step.started.1",
            r#", "assistantMessageID":"msg_first","agent":"build","model":{"providerID":"local","id":"test"}"#,
        ),
        (
            "evt_first_end",
            3,
            "session.step.failed.1",
            r#", "assistantMessageID":"msg_first","error":{"type":"provider.transport","message":"Disconnected"}"#,
        ),
        (
            "evt_second",
            4,
            "session.step.started.1",
            r#", "assistantMessageID":"msg_second","agent":"build","model":{"providerID":"local","id":"test"}"#,
        ),
    ] {
        service
            .publish(NewEvent {
                id: id.into(),
                aggregate_id: "ses_one".into(),
                created: now,
                type_: kind.into(),
                data: parse_json(&format!(r#"{{"sessionID":"ses_one"{fields}}}"#)).unwrap(),
            })
            .await
            .unwrap();
    }
    service
        .publish(NewEvent {
            id: "evt_other_run".into(),
            aggregate_id: "ses_two".into(),
            created: 1,
            type_: "session.execution.started.1".into(),
            data: parse_json(r#"{"sessionID":"ses_two"}"#).unwrap(),
        })
        .await
        .unwrap();
    service.publish(NewEvent { id: "evt_other_step".into(), aggregate_id: "ses_two".into(), created: 2, type_: "session.step.started.1".into(), data: parse_json(r#"{"sessionID":"ses_two","assistantMessageID":"msg_other","agent":"build","model":{"providerID":"local","id":"test"}}"#).unwrap() }).await.unwrap();
    service.publish(NewEvent { id: "evt_other_end".into(), aggregate_id: "ses_two".into(), created: 3, type_: "session.step.failed.1".into(), data: parse_json(r#"{"sessionID":"ses_two","assistantMessageID":"msg_other","error":{"type":"unknown","message":"already closed"}}"#).unwrap() }).await.unwrap();
    assert_eq!(service.reconcile_interrupted(5).await.unwrap(), 2);
    let (_, first) = service
        .message(&session_message::Id::new("msg_first").unwrap())
        .unwrap()
        .unwrap();
    let session_message::Info::Assistant(first) = first else {
        panic!()
    };
    assert_eq!(
        first.error.unwrap().r#type.as_str(),
        Some("provider.transport")
    );
    let (_, second) = service
        .message(&session_message::Id::new("msg_second").unwrap())
        .unwrap()
        .unwrap();
    let session_message::Info::Assistant(second) = second else {
        panic!()
    };
    assert_eq!(second.error.unwrap().r#type.as_str(), Some("interrupted"));
    let (_, other) = service
        .message(&session_message::Id::new("msg_other").unwrap())
        .unwrap()
        .unwrap();
    let session_message::Info::Assistant(other) = other else {
        panic!()
    };
    assert_eq!(
        other.error.unwrap().message.as_str(),
        Some("already closed")
    );
    assert_eq!(
        service
            .snapshot(&session::Id::new("ses_one").unwrap(), 100, None)
            .unwrap()
            .watermark,
        Some(5)
    );
    assert_eq!(
        service
            .snapshot(&session::Id::new("ses_two").unwrap(), 100, None)
            .unwrap()
            .watermark,
        Some(3)
    );
    assert_eq!(service.reconcile_interrupted(6).await.unwrap(), 0);
}
