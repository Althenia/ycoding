use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use ycoding_core::{
    instructions::{self, Observation, Source},
    session::store::Service,
};
use ycoding_schema::{DomainDecode, JsonValue, instruction, parse_json, session};

#[path = "session_support/mod.rs"]
mod support;

fn id() -> session::Id {
    session::Id::new("ses_one").unwrap()
}

fn source(value: Arc<Mutex<Observation>>, reads: Arc<AtomicUsize>) -> Source {
    Source {
        key: instruction::Key::decode(&JsonValue::String("api/task".into())).unwrap(),
        read: Arc::new(move || {
            let value = value.clone();
            let reads = reads.clone();
            Box::pin(async move {
                reads.fetch_add(1, Ordering::SeqCst);
                Ok(value.lock().unwrap().clone())
            })
        }),
        initial: Arc::new(|value| match value {
            JsonValue::String(value) => value
                .as_str()
                .map(|value| format!("Initial {value}").into()),
            _ => None,
        }),
        changed: Arc::new(|previous, current| match (previous, current) {
            (JsonValue::String(previous), JsonValue::String(current)) => {
                Some(format!("Changed {} -> {}", previous.as_str()?, current.as_str()?).into())
            }
            _ => None,
        }),
        removed: Some(Arc::new(|_| Some("Removed task".into()))),
    }
}

#[tokio::test]
async fn observes_once_commits_hash_only_facts_and_renders_values_without_rereading() {
    let store = support::store();
    let service = Service::new(store.client());
    let value = Arc::new(Mutex::new(Observation::Value(JsonValue::String(
        "first".into(),
    ))));
    let reads = Arc::new(AtomicUsize::new(0));
    let sources = vec![source(value.clone(), reads.clone())];
    let observed = service.observe_instructions(&id(), &sources).await.unwrap();
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    assert!(
        service
            .snapshot(&id(), 100, None)
            .unwrap()
            .watermark
            .is_none()
    );
    service.commit_instructions(observed, 1).await.unwrap();
    *value.lock().unwrap() = Observation::Value(JsonValue::String("second".into()));
    let changed = service.observe_instructions(&id(), &sources).await.unwrap();
    service.commit_instructions(changed, 2).await.unwrap();
    let assembly = service.assemble_instructions(&id(), &sources).unwrap();
    assert_eq!(assembly.initial.as_str(), Some("Initial first"));
    let ycoding_schema::session_message::Info::System(update) = &assembly.updates[0].message else {
        panic!()
    };
    assert_eq!(update.text.as_str(), Some("Changed first -> second"));
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    assert_eq!(
        assembly.current.get(&"api/task".into()),
        Some(&JsonValue::String("second".into()))
    );
    *value.lock().unwrap() = Observation::Removed;
    let removed = service.observe_instructions(&id(), &sources).await.unwrap();
    service.commit_instructions(removed, 3).await.unwrap();
    let assembly = service.assemble_instructions(&id(), &sources).unwrap();
    let ycoding_schema::session_message::Info::System(update) = &assembly.updates[1].message else {
        panic!()
    };
    assert_eq!(update.text.as_str(), Some("Removed task"));
    assert!(assembly.current.is_empty());
}

#[tokio::test]
async fn unavailable_initial_sources_block_and_committed_values_survive_unavailability_and_noops() {
    let store = support::store();
    let service = Service::new(store.client());
    let value = Arc::new(Mutex::new(Observation::Unavailable));
    let sources = vec![source(value.clone(), Arc::new(AtomicUsize::new(0)))];
    assert!(matches!(
        service.observe_instructions(&id(), &sources).await,
        Err(instructions::Error::InitializationBlocked(_))
    ));
    assert!(
        service
            .snapshot(&id(), 100, None)
            .unwrap()
            .watermark
            .is_none()
    );
    *value.lock().unwrap() = Observation::Value(JsonValue::String("retained".into()));
    service
        .prepare_instructions(&id(), &sources, 1)
        .await
        .unwrap();
    let expected = service.snapshot(&id(), 100, None).unwrap();
    service
        .prepare_instructions(&id(), &sources, 2)
        .await
        .unwrap();
    *value.lock().unwrap() = Observation::Unavailable;
    service
        .prepare_instructions(&id(), &sources, 3)
        .await
        .unwrap();
    assert_eq!(service.snapshot(&id(), 100, None).unwrap(), expected);
    assert_eq!(
        service
            .assemble_instructions(&id(), &sources)
            .unwrap()
            .initial
            .as_str(),
        Some("Initial retained")
    );
}

#[test]
fn canonical_hash_is_key_order_independent_and_removed_is_not_json_shaped() {
    assert_eq!(
        instructions::hash(&parse_json(r#"{"b":2,"a":[1,null]}"#).unwrap()),
        instructions::hash(&parse_json(r#"{"a":[1,null],"b":2}"#).unwrap())
    );
    let key = instruction::Key::decode(&JsonValue::String("api/value".into())).unwrap();
    let observed = instructions::Observed {
        key: key.clone(),
        value: Observation::Value(parse_json(r#"{"_tag":"Removed"}"#).unwrap()),
    };
    assert!(
        !instructions::diff(&[observed], None)
            .unwrap()
            .blobs
            .is_empty()
    );
    assert!(
        instructions::diff(
            &[instructions::Observed {
                key,
                value: Observation::Removed
            }],
            None
        )
        .unwrap()
        .delta
        .0
        .is_empty()
    );
}

#[tokio::test]
async fn private_preview_uses_durable_values_without_repairing_a_missing_cache() {
    let store = support::store();
    let service = Service::new(store.client());
    let value = Arc::new(Mutex::new(Observation::Value(JsonValue::String(
        "committed".into(),
    ))));
    let sources = vec![source(value.clone(), Arc::new(AtomicUsize::new(0)))];
    service
        .prepare_instructions(&id(), &sources, 1)
        .await
        .unwrap();
    store
        .submit(|tx| {
            tx.delete::<ycoding_store::session::InstructionStateTable>(&ycoding_store::tuple_key(
                &[ycoding_store::KeyPart::String(&"ses_one".into())],
            ))?;
            Ok(())
        })
        .unwrap()
        .await
        .unwrap();
    let before = service.snapshot(&id(), 100, None).unwrap();
    *value.lock().unwrap() = Observation::Value(JsonValue::String("private".into()));
    let preview = service.preview_instructions(&id(), &sources).await.unwrap();
    assert_eq!(preview.initial.as_str(), Some("Initial committed"));
    assert_eq!(
        preview.update.as_str(),
        Some("Changed committed -> private")
    );
    assert!(preview.updates.is_empty());
    assert_eq!(service.snapshot(&id(), 100, None).unwrap(), before);
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<ycoding_store::session::InstructionStateTable>(&ycoding_store::tuple_key(&[
                ycoding_store::KeyPart::String(&"ses_one".into())
            ]))
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn completed_compaction_advances_the_epoch_and_movement_clears_it() {
    let store = support::store();
    let service = Service::new(store.client());
    let value = Arc::new(Mutex::new(Observation::Value(JsonValue::String(
        "first".into(),
    ))));
    let sources = vec![source(value.clone(), Arc::new(AtomicUsize::new(0)))];
    service
        .prepare_instructions(&id(), &sources, 1)
        .await
        .unwrap();
    *value.lock().unwrap() = Observation::Value(JsonValue::String("second".into()));
    service
        .prepare_instructions(&id(), &sources, 2)
        .await
        .unwrap();
    store
        .submit(|tx| {
            ycoding_store::session::append(
                tx,
                &ycoding_store::session::NewEvent {
                    id: "evt_compaction".into(),
                    aggregate_id: "ses_one".into(),
                    created: 3,
                    type_: "session.compaction.ended.2".into(),
                    data: parse_json(r#"{"sessionID":"ses_one"}"#).unwrap(),
                },
                None,
            )?;
            Ok(())
        })
        .unwrap()
        .await
        .unwrap();
    let assembly = service.assemble_instructions(&id(), &sources).unwrap();
    assert_eq!(assembly.initial.as_str(), Some("Initial second"));
    assert!(assembly.updates.is_empty());
    store
        .submit(|tx| {
            ycoding_store::session::append(
                tx,
                &ycoding_store::session::NewEvent {
                    id: "evt_move".into(),
                    aggregate_id: "ses_one".into(),
                    created: 4,
                    type_: "session.moved.1".into(),
                    data: parse_json(r#"{"sessionID":"ses_one"}"#).unwrap(),
                },
                None,
            )?;
            Ok(())
        })
        .unwrap()
        .await
        .unwrap();
    assert!(service.assemble_instructions(&id(), &sources).is_err());
    service
        .prepare_instructions(&id(), &sources, 5)
        .await
        .unwrap();
    assert_eq!(
        service
            .assemble_instructions(&id(), &sources)
            .unwrap()
            .initial
            .as_str(),
        Some("Initial second")
    );
    assert!(
        service
            .snapshot(&id(), 100, None)
            .unwrap()
            .messages
            .is_empty()
    );
}

#[tokio::test]
async fn failed_publication_rolls_back_blobs_and_missing_blobs_fail_assembly() {
    let store = support::store();
    let service = Service::new(store.client());
    let value = Arc::new(Mutex::new(Observation::Value(JsonValue::String(
        "first".into(),
    ))));
    let sources = vec![source(value, Arc::new(AtomicUsize::new(0)))];
    let missing = session::Id::new("ses_missing").unwrap();
    let observation = service
        .observe_instructions(&missing, &sources)
        .await
        .unwrap();
    assert!(service.commit_instructions(observation, 1).await.is_err());
    assert!(
        store
            .snapshot()
            .unwrap()
            .scan::<ycoding_store::session::InstructionBlobTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                10
            )
            .unwrap()
            .is_empty()
    );
    service
        .publish(ycoding_store::session::NewEvent {
            id: "evt_orphan".into(),
            aggregate_id: "ses_one".into(),
            created: 2,
            type_: "session.instructions.updated.2".into(),
            data: parse_json(&format!(
                r#"{{"sessionID":"ses_one","delta":{{"api/task":"{}"}}}}"#,
                "a".repeat(64)
            ))
            .unwrap(),
        })
        .await
        .unwrap();
    assert!(service.assemble_instructions(&id(), &sources).is_err());
}
