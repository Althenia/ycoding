use ycoding_core::session::store::Service;
use ycoding_schema::{DomainEncode, JsonValue, parse_json, session};
use ycoding_store::{
    KeyPart,
    session::{InstructionStateTable, NewEvent},
    tuple_key,
};

#[path = "session_support/mod.rs"]
mod support;

fn update(id: &str, key: &str, hash: &str, created: i64) -> NewEvent {
    NewEvent {
        id: id.into(),
        aggregate_id: "ses_one".into(),
        created,
        type_: "session.instructions.updated.2".into(),
        data: parse_json(&format!(
            r#"{{"sessionID":"ses_one","delta":{{"{key}":"{hash}"}}}}"#
        ))
        .unwrap(),
    }
}

fn id() -> session::Id {
    session::Id::new("ses_one").unwrap()
}

#[tokio::test]
async fn builtins_direct_event_driven_execution_and_preserve_git_identity() {
    use ycoding_core::instructions::{Observation, builtins};
    let sources = builtins::load(
        builtins::Environment {
            directory: "/project".into(),
            project_root: "/project".into(),
            git: true,
            platform: "test".into(),
            data: "/data/ycoding".into(),
        },
        std::sync::Arc::new(|| 0),
        ycoding_schema::session_scope::Scope::Bound,
    );
    for (key, required, forbidden) in [
        (
            "core/subagent-reuse",
            "Act on completion and failure events",
            "wait for a nudge",
        ),
        (
            "core/git-attribution",
            "use the existing Git author and committer identity",
            "the user's",
        ),
    ] {
        let source = sources
            .iter()
            .find(|source| ycoding_core::instructions::key(&source.key).as_str() == Some(key))
            .unwrap();
        let Observation::Value(JsonValue::String(text)) = (source.read)().await.unwrap() else {
            panic!("expected guidance for {key}")
        };
        let text = text.to_utf8().unwrap();
        assert!(text.contains(required), "{key}: missing {required}");
        assert!(!text.contains(forbidden), "{key}: contains {forbidden}");
    }
}

#[tokio::test]
async fn overlapping_initial_observations_remain_quiet_until_instructions_change() {
    use ycoding_core::instructions;
    let store = support::store();
    store
        .submit(|tx| {
            ycoding_store::session::SessionTable::insert(tx, &support::record("ses_three"))
        })
        .unwrap()
        .await
        .unwrap();
    let service = Service::new(store.client());
    let sources = vec![instructions::constant("api/task", "Initial instructions")];
    let changed = vec![instructions::constant("api/task", "Changed instructions")];
    let ids: Vec<_> = ["ses_one", "ses_two", "ses_three"]
        .into_iter()
        .map(|id| session::Id::new(id).unwrap())
        .collect();
    for id in &ids {
        let first = service.observe_instructions(id, &sources).await.unwrap();
        let overlapping = service.observe_instructions(id, &sources).await.unwrap();
        service.commit_instructions(first, 1).await.unwrap();
        service.commit_instructions(overlapping, 2).await.unwrap();
        service.prepare_instructions(id, &sources, 3).await.unwrap();
        assert!(service.transcript(id).unwrap().is_empty());
        let assembly = service.assemble_instructions(id, &sources).unwrap();
        assert!(
            assembly
                .initial
                .to_utf8()
                .unwrap()
                .contains("Initial instructions")
        );
    }
    let first = service
        .observe_instructions(&ids[1], &changed)
        .await
        .unwrap();
    let overlapping = service
        .observe_instructions(&ids[1], &changed)
        .await
        .unwrap();
    service.commit_instructions(first, 4).await.unwrap();
    service.commit_instructions(overlapping, 4).await.unwrap();
    service
        .prepare_instructions(&ids[1], &changed, 5)
        .await
        .unwrap();
    let transcript = service.transcript(&ids[1]).unwrap();
    assert_eq!(transcript.len(), 1);
    assert!(
        matches!(&transcript[0], ycoding_schema::session_message::Info::System(message) if message.text.as_str() == Some("Instructions updated: api/task"))
    );
    assert!(service.transcript(&ids[0]).unwrap().is_empty());
    assert!(service.transcript(&ids[2]).unwrap().is_empty());
}

#[tokio::test]
async fn disabled_guidance_publishes_removed_and_reenables_by_same_key() {
    use ycoding_core::instructions;
    let store = support::store();
    let service = Service::new(store.client());
    let sources = vec![instructions::constant("core/decision-use", "Use decision.")];
    service
        .prepare_instructions(&id(), &sources, 1)
        .await
        .unwrap();
    let initial = service
        .assemble_instructions(&id(), &sources)
        .unwrap()
        .current;
    let disabled = instructions::when(false, sources.clone());
    let observation = service
        .observe_instructions(&id(), &disabled)
        .await
        .unwrap();
    assert_eq!(
        observation.delta.encode(),
        parse_json(r#"{"core/decision-use":"removed"}"#).unwrap()
    );
    service.commit_instructions(observation, 2).await.unwrap();
    assert!(
        service
            .assemble_instructions(&id(), &disabled)
            .unwrap()
            .current
            .iter()
            .next()
            .is_none()
    );
    service
        .prepare_instructions(&id(), &sources, 3)
        .await
        .unwrap();
    assert_eq!(
        service
            .assemble_instructions(&id(), &sources)
            .unwrap()
            .current,
        initial
    );
    assert!(
        service
            .observe_instructions(&id(), &sources)
            .await
            .unwrap()
            .delta
            .0
            .iter()
            .next()
            .is_none()
    );
}

#[tokio::test]
async fn hash_only_instruction_events_fold_initial_changed_and_removed_values() {
    let store = support::store();
    let service = Service::new(store.client());
    service
        .publish(update("evt_initial", "api/task", &"a".repeat(64), 1))
        .await
        .unwrap();
    service
        .publish(update("evt_changed", "api/task", &"b".repeat(64), 2))
        .await
        .unwrap();
    let state = store
        .snapshot()
        .unwrap()
        .get::<InstructionStateTable>(&tuple_key(&[KeyPart::String(&"ses_one".into())]))
        .unwrap()
        .unwrap();
    assert_eq!((state.epoch_start, state.through_seq), (0, 1));
    assert_eq!(
        state.initial_values.value(),
        &parse_json(&format!(r#"{{"api/task":"{}"}}"#, "a".repeat(64))).unwrap()
    );
    assert_eq!(
        state.current_values.value(),
        &parse_json(&format!(r#"{{"api/task":"{}"}}"#, "b".repeat(64))).unwrap()
    );
    service
        .publish(update("evt_removed", "api/task", "removed", 3))
        .await
        .unwrap();
    let state = store
        .snapshot()
        .unwrap()
        .get::<InstructionStateTable>(&tuple_key(&[KeyPart::String(&"ses_one".into())]))
        .unwrap()
        .unwrap();
    assert_eq!(state.current_values.value(), &parse_json("{}").unwrap());
    assert_eq!(service.context(&id()).unwrap(), vec![]);
    let window = service
        .snapshot(
            &id(),
            100,
            None,
            &ycoding_core::generation_activity::Service::new(0, 0),
        )
        .unwrap();
    assert_eq!(window.messages.len(), 2);
    for message in window.messages {
        let JsonValue::Object(message) = message.encode() else {
            panic!()
        };
        assert_eq!(
            message.get(&"type".into()),
            Some(&JsonValue::String("system".into()))
        );
        assert_eq!(
            message.get(&"text".into()),
            Some(&JsonValue::String("Instructions updated: api/task".into()))
        );
    }
    assert_eq!(window.watermark, Some(2));
}

#[tokio::test]
async fn derived_notices_survive_missing_or_stale_cache_without_repair_on_reads() {
    let store = support::store();
    let service = Service::new(store.client());
    service
        .publish(update("evt_initial", "api/task", &"a".repeat(64), 1))
        .await
        .unwrap();
    service
        .publish(update("evt_changed", "api/task", &"b".repeat(64), 2))
        .await
        .unwrap();
    let expected = service
        .snapshot(
            &id(),
            100,
            None,
            &ycoding_core::generation_activity::Service::new(0, 0),
        )
        .unwrap();
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
            .snapshot(
                &id(),
                100,
                None,
                &ycoding_core::generation_activity::Service::new(0, 0)
            )
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
async fn backward_windows_keep_notices_with_their_projected_message_span() {
    let store = support::store();
    let service = Service::new(store.client());
    service
        .publish(update("evt_initial", "api/task", &"a".repeat(64), 1))
        .await
        .unwrap();
    for (index, hash) in [(1, "b"), (2, "c"), (3, "d")] {
        service
            .publish(NewEvent {
                id: format!("evt_message_{index}").into(),
                aggregate_id: "ses_one".into(),
                created: index * 2,
                type_: "session.synthetic.1".into(),
                data: parse_json(&format!(
                    r#"{{"sessionID":"ses_one","text":"message {index}"}}"#
                ))
                .unwrap(),
            })
            .await
            .unwrap();
        service
            .publish(update(
                &format!("evt_update_{index}"),
                "api/task",
                &hash.repeat(64),
                index * 2 + 1,
            ))
            .await
            .unwrap();
    }
    let newest = service
        .snapshot(
            &id(),
            1,
            None,
            &ycoding_core::generation_activity::Service::new(0, 0),
        )
        .unwrap();
    assert_eq!(newest.messages.len(), 2);
    let middle = service
        .snapshot(
            &id(),
            1,
            newest.before.as_deref(),
            &ycoding_core::generation_activity::Service::new(0, 0),
        )
        .unwrap();
    assert_eq!(middle.messages.len(), 2);
    let oldest = service
        .snapshot(
            &id(),
            1,
            middle.before.as_deref(),
            &ycoding_core::generation_activity::Service::new(0, 0),
        )
        .unwrap();
    assert_eq!(oldest.messages.len(), 2);
    assert!(oldest.before.is_none());
    assert_ne!(newest.messages, middle.messages);
    assert_ne!(middle.messages, oldest.messages);
}

#[tokio::test]
async fn notices_sit_at_their_update_position_in_the_transcript_and_in_backward_windows() {
    let store = support::store();
    let service = Service::new(store.client());
    let message = |id: &str, seq: i64, data: &str| ycoding_store::session::Message {
        id: id.into(),
        session_id: "ses_one".into(),
        type_: "synthetic".into(),
        seq,
        time_created: seq,
        time_updated: seq,
        data: parse_json(data).unwrap(),
    };
    store
        .submit(move |tx| {
            for (id, seq, text) in [
                ("msg_prompt", 2, "Prompt"),
                ("msg_assistant", 6, "Answer"),
                ("msg_later", 8, "Later"),
            ] {
                ycoding_store::session::MessageTable::insert(
                    tx,
                    &message(
                        id,
                        seq,
                        &format!(r#"{{"text":"{text}","time":{{"created":{seq}}}}}"#),
                    ),
                )?;
            }
            ycoding_store::session::reserve_sequence(tx, &"ses_one".into(), 0)
        })
        .unwrap()
        .wait()
        .unwrap();
    for (seq, id, key) in [
        (1, "evt_instruction_initial", "core/environment"),
        (4, "evt_instruction_date", "core/date"),
        (9, "evt_instruction_files", "core/instructions"),
    ] {
        store
            .submit(move |tx| {
                ycoding_store::session::reserve_sequence(tx, &"ses_one".into(), seq - 1)
            })
            .unwrap()
            .wait()
            .unwrap();
        service
            .publish(update(id, key, &"a".repeat(64), seq))
            .await
            .unwrap();
    }
    let label = |message: &ycoding_schema::session_message::Info| match message {
        ycoding_schema::session_message::Info::System(system) => system.text.to_utf8().unwrap(),
        other => {
            let JsonValue::Object(fields) = other.encode() else {
                panic!()
            };
            let Some(JsonValue::String(id)) = fields.get(&"id".into()) else {
                panic!()
            };
            id.to_utf8().unwrap()
        }
    };
    let full = service
        .transcript(&id())
        .unwrap()
        .iter()
        .map(label)
        .collect::<Vec<_>>();
    assert_eq!(
        full,
        [
            "msg_prompt",
            "Instructions updated: core/date",
            "msg_assistant",
            "msg_later",
            "Instructions updated: core/instructions",
        ]
    );
    let newest = service
        .snapshot(
            &id(),
            2,
            None,
            &ycoding_core::generation_activity::Service::new(0, 0),
        )
        .unwrap();
    assert_eq!(
        newest.messages.iter().map(label).collect::<Vec<_>>(),
        [
            "msg_assistant",
            "msg_later",
            "Instructions updated: core/instructions"
        ]
    );
    let older = service
        .snapshot(
            &id(),
            2,
            newest.before.as_deref(),
            &ycoding_core::generation_activity::Service::new(0, 0),
        )
        .unwrap();
    assert_eq!(
        older.messages.iter().map(label).collect::<Vec<_>>(),
        ["msg_prompt", "Instructions updated: core/date"]
    );
    assert!(older.before.is_none());
}
