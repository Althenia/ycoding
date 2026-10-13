#[path = "session_support/mod.rs"]
mod support;

use std::ops::Bound;
use ycoding_core::{instructions, session::store::Service};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, ObjectEncoder, instruction_entry, parse_json, session,
    session_message,
};
use ycoding_store::{
    KeyPart,
    session::{InstructionBlobTable, InstructionEntryTable, InstructionStateTable},
    tuple_key,
};

fn entry(key: &str, value: &str) -> instruction_entry::Info {
    instruction_entry::Info {
        key: instruction_entry::Key::decode(&JsonValue::String(key.into())).unwrap(),
        value: ycoding_schema::domain::Json::decode(&parse_json(value).unwrap()).unwrap(),
    }
}

fn update_text(service: &Service, id: &session::Id) -> Vec<String> {
    let sources = service.instruction_entry_sources(id).unwrap();
    service
        .assemble_instructions(id, &sources)
        .unwrap()
        .updates
        .iter()
        .map(|entry| {
            let session_message::Info::System(message) = &entry.message else {
                panic!("instruction update is System context")
            };
            message.text.to_utf8().unwrap()
        })
        .collect()
}

#[tokio::test]
async fn api_entry_changes_announce_only_at_instruction_boundaries_and_replay_hash_only_facts() {
    let store = support::store();
    let service = Service::new(store.client());
    let id = session::Id::new("ses_one").unwrap();
    let first = entry("deploy-target", r#""production""#);
    service
        .put_instruction_entry(&id, first.clone(), 1)
        .await
        .unwrap();
    assert!(service.log(&id, None, 20).unwrap().events.is_empty());
    let sources = service.instruction_entry_sources(&id).unwrap();
    service
        .prepare_instructions(&id, &sources, 2)
        .await
        .unwrap();
    let initial = service.assemble_instructions(&id, &sources).unwrap();
    assert_eq!(
        initial.initial.as_str(),
        Some("<context key=\"deploy-target\">\nproduction\n</context>")
    );
    assert!(initial.updates.is_empty());
    service
        .put_instruction_entry(&id, first.clone(), 3)
        .await
        .unwrap();
    let unchanged = service.instruction_entry_sources(&id).unwrap();
    service
        .prepare_instructions(&id, &unchanged, 4)
        .await
        .unwrap();
    assert_eq!(service.log(&id, None, 20).unwrap().events.len(), 1);

    let changed = entry("deploy-target", r#"{"region":"us-east-1"}"#);
    service
        .put_instruction_entry(&id, changed.clone(), 5)
        .await
        .unwrap();
    assert_eq!(update_text(&service, &id), Vec::<String>::new());
    service
        .prepare_instructions(&id, &service.instruction_entry_sources(&id).unwrap(), 6)
        .await
        .unwrap();
    assert_eq!(
        update_text(&service, &id),
        [
            "The context under \"deploy-target\" changed and supersedes the previous value:\n<context key=\"deploy-target\">\n{\n  \"region\": \"us-east-1\"\n}\n</context>"
        ]
    );
    service
        .put_instruction_entry(&id, entry("deploy-target", "null"), 7)
        .await
        .unwrap();
    service
        .prepare_instructions(&id, &service.instruction_entry_sources(&id).unwrap(), 8)
        .await
        .unwrap();
    assert_eq!(
        service.instruction_entries(&id).unwrap(),
        [entry("deploy-target", "null")]
    );
    assert_eq!(
        update_text(&service, &id)[1],
        "The context under \"deploy-target\" changed and supersedes the previous value:\n<context key=\"deploy-target\">\nnull\n</context>"
    );

    service
        .remove_instruction_entry(&id, &first.key, 9)
        .await
        .unwrap();
    service
        .remove_instruction_entry(&id, &first.key, 10)
        .await
        .unwrap();
    assert!(service.instruction_entries(&id).unwrap().is_empty());
    assert_eq!(service.log(&id, None, 20).unwrap().events.len(), 3);
    service
        .prepare_instructions(&id, &service.instruction_entry_sources(&id).unwrap(), 11)
        .await
        .unwrap();
    assert_eq!(
        update_text(&service, &id)[2],
        "The context under \"deploy-target\" no longer applies. Disregard it."
    );
    service
        .prepare_instructions(&id, &service.instruction_entry_sources(&id).unwrap(), 12)
        .await
        .unwrap();
    service
        .put_instruction_entry(&id, first.clone(), 13)
        .await
        .unwrap();
    service
        .prepare_instructions(&id, &service.instruction_entry_sources(&id).unwrap(), 14)
        .await
        .unwrap();
    let expected = service
        .assemble_instructions(&id, &service.instruction_entry_sources(&id).unwrap())
        .unwrap();
    let events = service.log(&id, None, 20).unwrap().events;
    assert_eq!(events.len(), 5);
    for (index, value) in [
        Some(first.value.encode()),
        Some(changed.value.encode()),
        Some(JsonValue::Null),
        None,
        Some(first.value.encode()),
    ]
    .iter()
    .enumerate()
    {
        assert_eq!(
            events[index].event.0.event_type.as_str(),
            Some("session.instructions.updated")
        );
        assert_eq!(events[index].seq, index as i64);
        assert_eq!(events[index].version, 2);
        assert_eq!(
            events[index].event.0.data.encode(),
            ObjectEncoder::new()
                .field("sessionID", &id)
                .field(
                    "delta",
                    &ObjectEncoder::new()
                        .field(
                            "api/deploy-target",
                            &value
                                .as_ref()
                                .map(|value| instructions::hash(value).encode())
                                .unwrap_or(JsonValue::String("removed".into()))
                        )
                        .finish()
                )
                .finish()
        );
    }
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .scan::<InstructionBlobTable>(Bound::Unbounded, Bound::Unbounded, 20)
            .unwrap()
            .len(),
        3
    );
    store
        .submit(|tx| {
            tx.delete::<InstructionStateTable>(&tuple_key(&[KeyPart::String(&"ses_one".into())]))?;
            Ok(())
        })
        .unwrap()
        .await
        .unwrap();
    assert_eq!(
        service
            .assemble_instructions(&id, &service.instruction_entry_sources(&id).unwrap())
            .unwrap(),
        expected
    );
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<InstructionStateTable>(&tuple_key(&[KeyPart::String(&"ses_one".into())]))
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn entry_scans_cross_pages_in_key_order_and_noop_removal_does_not_create_an_entry() {
    let store = support::store();
    let service = Service::new(store.client());
    let id = session::Id::new("ses_one").unwrap();
    let absent = entry("absent", "null");
    service
        .remove_instruction_entry(&id, &absent.key, 1)
        .await
        .unwrap();
    for index in (0..130).rev() {
        service
            .put_instruction_entry(&id, entry(&format!("k{index:03}"), "null"), 2)
            .await
            .unwrap();
    }
    let entries = service.instruction_entries(&id).unwrap();
    assert_eq!(
        entries,
        (0..130)
            .map(|index| entry(&format!("k{index:03}"), "null"))
            .collect::<Vec<_>>()
    );
    assert!(
        service
            .instruction_entries(&session::Id::new("ses_two").unwrap())
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<InstructionEntryTable>(&tuple_key(&[
                KeyPart::String(&"ses_one".into()),
                KeyPart::String(&"absent".into())
            ]))
            .unwrap()
            .is_none()
    );
    assert!(service.log(&id, None, 20).unwrap().events.is_empty());
}
