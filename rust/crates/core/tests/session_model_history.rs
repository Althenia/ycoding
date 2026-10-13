use ycoding_core::session::store::Service;
use ycoding_schema::{DomainEncode, JsonValue, ObjectEncoder, session};
use ycoding_store::session::{
    ContextState, ContextStateTable, Document, Manifest, ManifestTable, Message, MessageTable,
    Revision, RevisionTable,
};

#[path = "session_support/mod.rs"]
mod support;

fn user(id: &str, seq: i64, text: &str) -> Message {
    Message {
        id: id.into(),
        session_id: "ses_one".into(),
        type_: "user".into(),
        seq,
        time_created: seq,
        time_updated: seq,
        data: ObjectEncoder::new()
            .field("text", text)
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
fn sole_user_read_changes_from_absent_to_one_to_absent_at_the_second_indexed_user() {
    let store = support::store();
    let service = Service::new(store.client());
    let id = session::Id::new("ses_one").unwrap();
    assert!(service.first_user_message_if_only(&id).unwrap().is_none());
    store
        .submit(|tx| MessageTable::insert(tx, &user("msg_one", 1, "First")))
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(
        service
            .first_user_message_if_only(&id)
            .unwrap()
            .unwrap()
            .text
            .as_str(),
        Some("First")
    );
    store
        .submit(|tx| MessageTable::insert(tx, &user("msg_two", 2, "Second")))
        .unwrap()
        .wait()
        .unwrap();
    assert!(service.first_user_message_if_only(&id).unwrap().is_none());
}

fn install_summary(store: &ycoding_store::Store) {
    let before = user("msg_before", 1, "Earlier input");
    let digest = crate_hash(&before.data);
    let manifest = ObjectEncoder::new()
        .field(
            "summary",
            &ObjectEncoder::new()
                .field("text", "Verified earlier context")
                .field(
                    "coveredThrough",
                    &ObjectEncoder::new()
                        .field("messageID", "msg_before")
                        .field("seq", &1.0)
                        .finish(),
                )
                .field("digest", &digest)
                .finish(),
        )
        .finish();
    store
        .submit(move |tx| {
            MessageTable::insert(tx, &before)?;
            MessageTable::insert(tx, &user("msg_after", 3, "Newest input"))?;
            ManifestTable::insert(
                tx,
                &Manifest {
                    digest: "a".repeat(64).into(),
                    schema_version: 1,
                    content: Document::new(manifest)?,
                    input_tokens: 10,
                    retained_tokens: 5,
                    time_created: 2,
                },
            )?;
            RevisionTable::insert(
                tx,
                &Revision {
                    session_id: "ses_one".into(),
                    revision: 0,
                    parent_revision: None,
                    manifest_digest: None,
                    covered_through_message_id: None,
                    covered_through_seq: None,
                    activation_event_id: None,
                    activation_sequence: None,
                    time_created: 0,
                },
            )?;
            RevisionTable::insert(
                tx,
                &Revision {
                    session_id: "ses_one".into(),
                    revision: 1,
                    parent_revision: Some(0),
                    manifest_digest: Some("a".repeat(64).into()),
                    covered_through_message_id: Some("msg_before".into()),
                    covered_through_seq: Some(1),
                    activation_event_id: Some("evt_activate".into()),
                    activation_sequence: Some(2),
                    time_created: 2,
                },
            )?;
            ContextStateTable::insert(
                tx,
                &ContextState {
                    session_id: "ses_one".into(),
                    status: "active".into(),
                    revision: 1,
                    manifest_digest: Some("a".repeat(64).into()),
                    covered_through_message_id: Some("msg_before".into()),
                    covered_through_seq: Some(1),
                    activated_event_id: Some("evt_activate".into()),
                    time_activated: Some(2),
                    error_code: None,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
}

#[test]
fn active_local_summary_requires_the_exact_session_boundary_payload_digest() {
    let store = support::store();
    let service = Service::new(store.client());
    let id = session::Id::new("ses_one").unwrap();
    install_summary(&store);
    let selected = service.model_history(&id).unwrap();
    assert_eq!(selected.len(), 2);
    let ycoding_schema::session_message::Info::Synthetic(summary) = &selected[0].message else {
        panic!()
    };
    assert!(
        summary
            .text
            .to_utf8()
            .unwrap()
            .contains("Verified earlier context")
    );
    assert!(
        matches!(&selected[1].message, ycoding_schema::session_message::Info::User(user) if user.text.as_str() == Some("Newest input"))
    );
    assert_eq!(service.context(&id).unwrap().len(), 2);
    store
        .submit(|tx| MessageTable::put(tx, &user("msg_before", 1, "Changed boundary payload")))
        .unwrap()
        .wait()
        .unwrap();
    let selected = service.model_history(&id).unwrap();
    assert!(
        matches!(&selected[0].message, ycoding_schema::session_message::Info::User(user) if user.text.as_str() == Some("Changed boundary payload"))
    );
}

#[test]
fn rows_covered_by_the_active_summary_are_not_decoded() {
    let store = support::store();
    let service = Service::new(store.client());
    let id = session::Id::new("ses_one").unwrap();
    install_summary(&store);
    store
        .submit(|tx| {
            MessageTable::insert(
                tx,
                &Message {
                    data: JsonValue::Null,
                    ..user("msg_covered", 0, "")
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let selected = service.model_history(&id).unwrap();
    assert_eq!(selected.len(), 2);
    assert!(
        matches!(&selected[1].message, ycoding_schema::session_message::Info::User(user) if user.text.as_str() == Some("Newest input"))
    );
    assert!(service.context(&id).is_err());
}

fn crate_hash(value: &JsonValue) -> JsonValue {
    ycoding_core::instructions::hash(value).encode()
}
