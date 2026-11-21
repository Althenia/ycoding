use ycoding_core::session::{instruction_entry::EntryError, store::Service};
use ycoding_schema::{DomainDecode, JsonValue, instruction_entry, session};

#[path = "session_support/mod.rs"]
mod support;

#[tokio::test]
async fn entry_limits_count_serialized_utf8_bytes_and_failed_updates_preserve_the_prior_value() {
    let store = support::store();
    let service = Service::new(store.client());
    let id = session::Id::new("ses_one").unwrap();
    let key = instruction_entry::Key::decode(&JsonValue::String("context".into())).unwrap();
    let value = JsonValue::String("é".repeat(4095).into());
    let entry = instruction_entry::Info {
        key: key.clone(),
        value: ycoding_schema::domain::Json::decode(&value).unwrap(),
    };
    service
        .put_instruction_entry(&id, entry.clone(), 1)
        .await
        .unwrap();
    service
        .put_instruction_entry(&id, entry.clone(), 2)
        .await
        .unwrap();
    let row = store
        .snapshot()
        .unwrap()
        .get::<ycoding_store::session::InstructionEntryTable>(&ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(&"ses_one".into()),
            ycoding_store::KeyPart::String(&"context".into()),
        ]))
        .unwrap()
        .unwrap();
    assert_eq!(row.time_updated, 1);
    let too_large = instruction_entry::Info {
        key: key.clone(),
        value: ycoding_schema::domain::Json::decode(&JsonValue::String("é".repeat(4096).into()))
            .unwrap(),
    };
    assert!(
        matches!(service.put_instruction_entry(&id, too_large, 3).await, Err(EntryError::ValueTooLarge(error)) if error.actual_bytes.get() == 8194)
    );
    assert_eq!(service.instruction_entries(&id).unwrap(), vec![entry]);
    service
        .remove_instruction_entry(&id, &key, 4)
        .await
        .unwrap();
    service
        .remove_instruction_entry(&id, &key, 5)
        .await
        .unwrap();
    let row = store
        .snapshot()
        .unwrap()
        .get::<ycoding_store::session::InstructionEntryTable>(&ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(&"ses_one".into()),
            ycoding_store::KeyPart::String(&"context".into()),
        ]))
        .unwrap()
        .unwrap();
    assert_eq!(row.time_updated, 4);
    assert_eq!(row.removed, 1);
}
