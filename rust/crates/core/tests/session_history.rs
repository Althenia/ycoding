use ycoding_core::session::{history, store::Service};
use ycoding_schema::{DomainEncode, JsonValue, ObjectEncoder, parse_json, session};
use ycoding_store::{
    KeyPart, TableSpec,
    session::{Message, MessageTable, NewEvent, SessionTable},
    tuple_key,
};

#[path = "session_support/mod.rs"]
mod support;

fn id() -> session::Id {
    session::Id::new("ses_one").unwrap()
}

fn message(seq: i64) -> Message {
    Message {
        id: format!("msg_{seq}").into(),
        session_id: "ses_one".into(),
        type_: "synthetic".into(),
        seq,
        time_created: seq,
        time_updated: seq,
        data: ObjectEncoder::new()
            .field("text", format!("message {seq}").as_str())
            .field(
                "time",
                &ObjectEncoder::new()
                    .field("created", &(seq as f64))
                    .finish(),
            )
            .finish(),
    }
}

#[test]
fn newest_hundred_page_backwards_without_overlap_with_consistent_watermark() {
    let store = support::store();
    store
        .submit(|tx| {
            for seq in 0..205 {
                MessageTable::insert(tx, &message(seq * 2))?;
            }
            ycoding_store::session::reserve_sequence(tx, &"ses_one".into(), 500)
        })
        .unwrap()
        .wait()
        .unwrap();
    let service = Service::new(store.client());
    let first = service.snapshot(&id(), 100, None).unwrap();
    assert_eq!(first.messages.len(), 100);
    assert_eq!(
        first.messages[0].encode(),
        message(210).info().unwrap().encode()
    );
    assert_eq!(first.watermark, Some(500));
    let second = service
        .snapshot(&id(), 100, first.before.as_deref())
        .unwrap();
    assert_eq!(second.messages.len(), 100);
    assert_eq!(
        second.messages[0].encode(),
        message(10).info().unwrap().encode()
    );
    let last = service
        .snapshot(&id(), 100, second.before.as_deref())
        .unwrap();
    assert_eq!(last.messages.len(), 5);
    assert!(last.before.is_none());
    assert_eq!(service.context(&id()).unwrap().len(), 205);
}

#[test]
fn window_does_not_decode_the_next_page_sentinel() {
    let store = support::store();
    store
        .submit(|tx| {
            MessageTable::insert(
                tx,
                &Message {
                    data: JsonValue::Null,
                    ..message(1)
                },
            )?;
            MessageTable::insert(tx, &message(3))?;
            MessageTable::insert(tx, &message(5))
        })
        .unwrap()
        .wait()
        .unwrap();
    let service = Service::new(store.client());
    let first = service.snapshot(&id(), 2, None).unwrap();
    assert_eq!(first.messages.len(), 2);
    assert_eq!(
        history::cursor(&id(), first.before.as_deref().unwrap()).unwrap(),
        3
    );
    assert!(service.snapshot(&id(), 1, first.before.as_deref()).is_err());
    assert_eq!(
        history::window(&store.snapshot().unwrap(), &id(), 1, Some(1))
            .unwrap()
            .messages,
        vec![]
    );
}

#[test]
fn cursor_matches_committed_ts_wire_encoding_and_rejects_wrong_owners_or_noncanonical_values() {
    let cursor = history::encode_cursor(&id(), 3);
    assert_eq!(cursor, "ODk0MGE4NzA4NzNhYTg2ODoz");
    assert_eq!(history::cursor(&id(), &cursor).unwrap(), 3);
    assert!(history::cursor(&session::Id::new("ses_two").unwrap(), &cursor).is_err());
    for value in ["", "abc+", "abc/", "abc=", "a", "_"] {
        assert!(history::cursor(&id(), value).is_err());
    }
    for seq in [-1, 9_007_199_254_740_992] {
        assert!(history::cursor(&id(), &history::encode_cursor(&id(), seq)).is_err());
    }
    let store = support::store();
    let service = Service::new(store.client());
    assert!(service.snapshot(&id(), 0, None).is_err());
    assert!(service.snapshot(&id(), 201, None).is_err());
}

#[test]
fn completed_legacy_checkpoint_stops_history_but_running_and_current_markers_do_not() {
    let store = support::store();
    store.submit(|tx| {
        MessageTable::insert(tx, &message(1))?;
        MessageTable::insert(tx, &Message { type_: "compaction".into(), data: parse_json(r#"{"status":"completed","reason":"manual","summary":"checkpoint","recent":"","time":{"created":3}}"#).unwrap(), ..message(3) })?;
        MessageTable::insert(tx, &message(5))?;
        MessageTable::insert(tx, &Message { type_: "compaction".into(), data: parse_json(r#"{"status":"running","reason":"manual","summary":"draft","recent":"","time":{"created":7}}"#).unwrap(), ..message(7) })
    }).unwrap().wait().unwrap();
    let service = Service::new(store.client());
    let window = service.snapshot(&id(), 100, None).unwrap();
    assert_eq!(window.messages.len(), 3);
    assert!(window.before.is_none());
    assert_eq!(service.context(&id()).unwrap(), window.messages);
    assert_eq!(
        history::latest_compaction(&store.snapshot().unwrap(), &id()).unwrap(),
        Some(3)
    );
}

#[tokio::test]
async fn create_adopts_original_session_and_terminal_activity_does_not_reorder_list_time() {
    let store = support::store();
    let service = Service::new(store.client());
    let event = NewEvent { id: "evt_create".into(), aggregate_id: "ses_new".into(), created: 10, type_: "session.created.2".into(), data: parse_json(r#"{"sessionID":"ses_new","projectID":"prj_one","location":{"directory":"/project"},"title":"First","created":5}"#).unwrap() };
    let first = service.create(event.clone()).await.unwrap();
    let mut reused = event;
    reused.id = "evt_retry".into();
    reused.data = JsonValue::Null;
    assert_eq!(service.create(reused).await.unwrap(), first);
    assert_eq!(
        service
            .snapshot(&session::Id::new("ses_new").unwrap(), 100, None)
            .unwrap()
            .watermark,
        Some(0)
    );
    for (event_id, now) in [("evt_success", 20), ("evt_late", 15)] {
        service
            .publish(NewEvent {
                id: event_id.into(),
                aggregate_id: "ses_new".into(),
                created: now,
                type_: "session.execution.succeeded.1".into(),
                data: parse_json(r#"{"sessionID":"ses_new"}"#).unwrap(),
            })
            .await
            .unwrap();
    }
    let info = service
        .get(&session::Id::new("ses_new").unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(info.time.active.unwrap().epoch_millis(), 20);
    assert_eq!(info.time.updated.epoch_millis(), 5);
    assert!(info.location.workspace_id.is_none());
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .get::<SessionTable>(&tuple_key(&[KeyPart::String(&"ses_new".into())]))
            .unwrap()
            .unwrap()
            .title
            .as_str(),
        Some("First")
    );
}

#[tokio::test]
async fn suspension_is_preserved_and_only_one_concurrent_caller_consumes_it() {
    let store = support::store();
    let service = Service::new(store.client());
    service.suspend(&[id()], 10).await.unwrap();
    service.suspend(&[id()], 20).await.unwrap();
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .get::<SessionTable>(&SessionTable::primary_key(&support::record("ses_one")))
            .unwrap()
            .unwrap()
            .time_suspended,
        Some(10)
    );
    let session = id();
    let (first, second) = tokio::join!(
        service.consume_suspended(&session),
        service.consume_suspended(&session)
    );
    assert_ne!(first.unwrap(), second.unwrap());
    assert!(!service.consume_suspended(&session).await.unwrap());
}

#[test]
fn snapshot_windows_accept_one_to_two_hundred_messages_and_reject_other_limits() {
    let store = support::store();
    store
        .submit(|tx| {
            for seq in 0..250 {
                MessageTable::insert(tx, &message(seq))?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let service = Service::new(store.client());
    assert_eq!(service.snapshot(&id(), 1, None).unwrap().messages.len(), 1);
    let widest = service.snapshot(&id(), 200, None).unwrap();
    assert_eq!(widest.messages.len(), 200);
    assert!(widest.before.is_some());
    for limit in [0, 201] {
        assert!(matches!(
            service.snapshot(&id(), limit, None),
            Err(ycoding_store::Error::Domain {
                kind: "invalid_cursor",
                ..
            })
        ));
    }
}
