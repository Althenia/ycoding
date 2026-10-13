use ycoding_core::session::pending::Request;
use ycoding_core::session::store::Service;
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, parse_json, session, session_message, session_pending,
};
use ycoding_store::{
    TableSpec,
    session::{Message, MessageTable, PendingTable},
};

#[path = "session_support/mod.rs"]
mod support;

fn request(id: &str, text: &str, kind: &str, delivery: &str, event: &str) -> Request {
    Request {
        id: session_message::Id::new(id).unwrap(),
        session_id: session::Id::new("ses_one").unwrap(),
        input: session_pending::Message::decode(
            &parse_json(&format!(
                r#"{{"type":"{kind}","data":{{"text":"{text}"}},"delivery":"{delivery}"}}"#
            ))
            .unwrap(),
        )
        .unwrap(),
        event_id: ycoding_schema::event::Id::new(event).unwrap(),
        created: 10,
    }
}

#[tokio::test]
async fn first_admission_wins_changed_text_and_delivery_without_another_event() {
    let store = support::store();
    let service = Service::new(store.client());
    let first = service
        .admit(request("msg_input", "first", "user", "steer", "evt_first"))
        .await
        .unwrap();
    assert_eq!(
        service
            .admit(request(
                "msg_input",
                "changed",
                "user",
                "queue",
                "evt_retry"
            ))
            .await
            .unwrap(),
        first
    );
    assert_eq!(
        ycoding_store::session::latest_sequence(&store.snapshot().unwrap(), &"ses_one".into())
            .unwrap(),
        0
    );
    assert!(
        service
            .message(&session_message::Id::new("msg_input").unwrap())
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn rejects_cross_session_and_cross_kind_reuse_atomically() {
    let store = support::store();
    let service = Service::new(store.client());
    let first = service
        .admit(request("msg_input", "first", "user", "steer", "evt_first"))
        .await
        .unwrap();
    assert!(
        service
            .admit(request(
                "msg_input",
                "synthetic",
                "synthetic",
                "steer",
                "evt_kind"
            ))
            .await
            .is_err()
    );
    let mut other = request("msg_input", "other", "user", "steer", "evt_other");
    other.session_id = session::Id::new("ses_two").unwrap();
    assert!(service.admit(other).await.is_err());
    assert_eq!(
        service
            .pending(&session_message::Id::new("msg_input").unwrap())
            .unwrap(),
        Some(first)
    );
}

#[tokio::test]
async fn promoted_retry_reconstructs_original_admission_not_the_visible_message() {
    let store = support::store();
    let service = Service::new(store.client());
    let first = service
        .admit(request("msg_input", "first", "user", "queue", "evt_first"))
        .await
        .unwrap();
    store
        .submit(|tx| {
            let message = Message {
                id: "msg_input".into(),
                session_id: "ses_one".into(),
                type_: "user".into(),
                seq: 1,
                time_created: 20,
                time_updated: 20,
                data: parse_json(r#"{"text":"first","time":{"created":20}}"#).unwrap(),
            };
            ycoding_store::session::promote(tx, &message)?;
            Ok(())
        })
        .unwrap()
        .await
        .unwrap();
    let retry = service
        .admit(request(
            "msg_input",
            "changed",
            "user",
            "steer",
            "evt_retry",
        ))
        .await
        .unwrap();
    assert_eq!(retry, first);
    assert!(
        service
            .pending(&session_message::Id::new("msg_input").unwrap())
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn copied_visible_history_without_admission_is_not_retryable() {
    let store = support::store();
    store
        .submit(|tx| {
            MessageTable::insert(
                tx,
                &Message {
                    id: "msg_copied".into(),
                    session_id: "ses_one".into(),
                    type_: "user".into(),
                    seq: 4,
                    time_created: 1,
                    time_updated: 1,
                    data: JsonValue::Null,
                },
            )
        })
        .unwrap()
        .await
        .unwrap();
    let service = Service::new(store.client());
    assert!(
        service
            .admit(request("msg_copied", "new", "user", "steer", "evt_new"))
            .await
            .is_err()
    );
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<PendingTable>(&PendingTable::primary_key(
                &ycoding_store::session::Pending {
                    id: "msg_copied".into(),
                    session_id: "ses_one".into(),
                    type_: "user".into(),
                    data: JsonValue::Null,
                    delivery: Some("steer".into()),
                    admitted_seq: 0,
                    time_created: 1
                }
            ))
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn queue_waits_for_idle_boundary_and_steers_promote_in_admission_order() {
    let store = support::store();
    let service = Service::new(store.client());
    service
        .admit(request("msg_first", "first", "user", "steer", "evt_first"))
        .await
        .unwrap();
    service
        .admit(request(
            "msg_queue",
            "queued",
            "synthetic",
            "queue",
            "evt_queue",
        ))
        .await
        .unwrap();
    service
        .admit(request(
            "msg_second",
            "second",
            "user",
            "steer",
            "evt_second",
        ))
        .await
        .unwrap();
    service
        .admit(request(
            "msg_queue2",
            "queued2",
            "user",
            "queue",
            "evt_queue2",
        ))
        .await
        .unwrap();
    assert_eq!(
        service
            .pending_list(&session::Id::new("ses_one").unwrap())
            .unwrap()
            .len(),
        4
    );
    assert_eq!(
        service
            .promote_steers(&session::Id::new("ses_one").unwrap(), 20)
            .await
            .unwrap(),
        2
    );
    let snapshot = service
        .snapshot(&session::Id::new("ses_one").unwrap(), 100, None)
        .unwrap();
    assert_eq!(
        snapshot
            .messages
            .iter()
            .map(|message| message.encode())
            .collect::<Vec<_>>()
            .iter()
            .map(|message| match message {
                JsonValue::Object(object) => object.get(&"id".into()).unwrap().clone(),
                _ => panic!(),
            })
            .collect::<Vec<_>>(),
        vec![
            JsonValue::String("msg_first".into()),
            JsonValue::String("msg_second".into())
        ]
    );
    assert_eq!(
        service
            .pending_list(&session::Id::new("ses_one").unwrap())
            .unwrap()
            .len(),
        2
    );
    assert!(
        service
            .promote_next_queued(&session::Id::new("ses_one").unwrap(), 30)
            .await
            .unwrap()
    );
    assert_eq!(
        service
            .pending_list(&session::Id::new("ses_one").unwrap())
            .unwrap()[0]
            .id
            .as_str(),
        Some("msg_queue2")
    );
    assert!(
        service
            .promote_next_queued(&session::Id::new("ses_one").unwrap(), 40)
            .await
            .unwrap()
    );
    assert!(
        !service
            .promote_next_queued(&session::Id::new("ses_one").unwrap(), 50)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn concurrent_admissions_and_promotions_commit_one_identity_once() {
    let store = support::store();
    let service = Service::new(store.client());
    let (first, second) = tokio::join!(
        service.admit(request("msg_first", "first", "user", "steer", "evt_first")),
        service.admit(request(
            "msg_first",
            "second",
            "user",
            "queue",
            "evt_second"
        ))
    );
    assert_eq!(first.unwrap(), second.unwrap());
    let id = session::Id::new("ses_one").unwrap();
    let (first, second) = tokio::join!(
        service.promote_steers(&id, 20),
        service.promote_steers(&id, 20)
    );
    assert_eq!(first.unwrap() + second.unwrap(), 1);
    assert_eq!(service.snapshot(&id, 100, None).unwrap().messages.len(), 1);
    assert_eq!(service.snapshot(&id, 100, None).unwrap().watermark, Some(1));
}

#[tokio::test]
async fn compaction_beyond_a_scan_page_blocks_every_promotion_without_consuming_inputs() {
    let store = support::store();
    let service = Service::new(store.client());
    for index in 0..130 {
        service
            .admit(request(
                &format!("msg_{index}"),
                "steer",
                "user",
                "steer",
                &format!("evt_{index}"),
            ))
            .await
            .unwrap();
    }
    store
        .submit(|tx| {
            PendingTable::insert(
                tx,
                &ycoding_store::session::Pending {
                    id: "msg_compaction".into(),
                    session_id: "ses_one".into(),
                    type_: "compaction".into(),
                    data: parse_json("{}").unwrap(),
                    delivery: None,
                    admitted_seq: 130,
                    time_created: 10,
                },
            )
        })
        .unwrap()
        .await
        .unwrap();
    let id = session::Id::new("ses_one").unwrap();
    assert!(!service.has_eligible_pending(&id).unwrap());
    assert_eq!(service.pending_list(&id).unwrap().len(), 130);
    assert_eq!(service.promote_steers(&id, 20).await.unwrap(), 0);
    assert!(!service.promote_next_queued(&id, 20).await.unwrap());
    assert!(
        service
            .snapshot(&id, 100, None)
            .unwrap()
            .messages
            .is_empty()
    );
    assert_eq!(
        ycoding_store::session::latest_sequence(&store.snapshot().unwrap(), &"ses_one".into())
            .unwrap(),
        129
    );
}

#[tokio::test]
async fn pending_reads_reject_invalid_message_data_and_missing_delivery() {
    for (data, delivery) in [
        (JsonValue::Null, Some("steer".into())),
        (parse_json(r#"{"text":"input"}"#).unwrap(), None),
    ] {
        let store = support::store();
        store
            .submit(move |tx| {
                PendingTable::insert(
                    tx,
                    &ycoding_store::session::Pending {
                        id: "msg_invalid".into(),
                        session_id: "ses_one".into(),
                        type_: "user".into(),
                        data,
                        delivery,
                        admitted_seq: 0,
                        time_created: 10,
                    },
                )
            })
            .unwrap()
            .await
            .unwrap();
        let service = Service::new(store.client());
        assert!(
            service
                .pending_list(&session::Id::new("ses_one").unwrap())
                .is_err()
        );
        assert!(
            service
                .pending(&session_message::Id::new("msg_invalid").unwrap())
                .is_err()
        );
    }
}
