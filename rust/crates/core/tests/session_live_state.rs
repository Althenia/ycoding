use std::cell::Cell;
use ycoding_ai::llm::Message;
use ycoding_core::session::{
    autonomy::{Goal, State, YoloLevel},
    context_manifest::ProtectedStateSource,
    live_state::{self, AUTHORITATIVE_STATE_PREFIX, LoadError, Source},
    prompt_cache::{canonical_json, sha256},
};
use ycoding_schema::{JsonValue, parse_json, session};
use ycoding_store::{
    Error, KeyPart, Store, Write,
    session::{
        Document, Event, EventTable, InstructionState, InstructionStateTable, Pending,
        PendingTable, Sequence, SequenceTable, SessionTable, Task, TaskTable, Todo, TodoState,
        TodoStateTable, TodoTable,
    },
    tuple_key,
};

#[path = "autonomy_support/mod.rs"]
mod support;

const GUARDRAIL_DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn json(text: &str) -> JsonValue {
    parse_json(text).unwrap()
}

fn guardrail() -> Source {
    Source {
        sequence: 4,
        digest: GUARDRAIL_DIGEST.into(),
    }
}

fn run(store: &Store, work: impl FnOnce(&mut Write<'_>) -> Result<(), Error> + Send + 'static) {
    store.submit(work).unwrap().wait().unwrap();
}

fn key(session: &str) -> Vec<u8> {
    tuple_key(&[KeyPart::String(&session.into())])
}

fn edit_session(
    store: &Store,
    session: &str,
    edit: impl FnOnce(&mut ycoding_store::session::Session) + Send + 'static,
) {
    let session = session.to_string();
    run(store, move |tx| {
        let mut row = tx.get::<SessionTable>(&key(&session))?.unwrap();
        edit(&mut row);
        SessionTable::put(tx, &row)
    });
}

fn put_event(store: &Store, id: &str, seq: i64, type_: &str) {
    let (id, type_) = (id.to_string(), type_.to_string());
    run(store, move |tx| insert_event(tx, &id, seq, &type_));
}

fn insert_event(tx: &mut Write<'_>, id: &str, seq: i64, type_: &str) -> Result<(), Error> {
    EventTable::insert(
        tx,
        &Event {
            id: id.into(),
            aggregate_id: "ses_one".into(),
            seq,
            created: seq,
            type_: type_.into(),
            data: json("{}"),
        },
    )
}

fn put_pending(store: &Store, message: &str, seq: i64, secret: &str) {
    let (message, secret) = (message.to_string(), secret.to_string());
    run(store, move |tx| insert_pending(tx, &message, seq, &secret));
}

fn insert_pending(tx: &mut Write<'_>, message: &str, seq: i64, secret: &str) -> Result<(), Error> {
    PendingTable::insert(
        tx,
        &Pending {
            id: message.into(),
            session_id: "ses_one".into(),
            type_: "user".into(),
            data: json(&format!(r#"{{"text":"{secret}"}}"#)),
            delivery: Some("queue".into()),
            admitted_seq: seq,
            time_created: seq,
        },
    )
}

fn seeded() -> Store {
    let store = support::store();
    run(&store, |tx| {
        SequenceTable::insert(
            tx,
            &Sequence {
                aggregate_id: "ses_one".into(),
                seq: 20,
                owner_id: None,
            },
        )?;
        insert_event(tx, "evt_created", 20, "session.created.2")
    });
    store
}

fn load(store: &Store) -> live_state::LiveState {
    live_state::load(&store.client(), &id("ses_one"), || Ok::<_, ()>(guardrail())).unwrap()
}

fn goal_json(state: &State) -> JsonValue {
    let JsonValue::Object(object) = state.encode() else {
        panic!("autonomy encodes an object")
    };
    object.get(&"goal".into()).cloned().unwrap()
}

fn expected_message(text: &str) -> Message {
    let mut message = Message::system(text);
    message.volatile = true;
    message
}

fn entries(
    sources: &[ycoding_core::session::context_manifest::ProtectedStateEntry],
) -> Vec<&'static str> {
    sources.iter().map(|entry| entry.source.as_str()).collect()
}

#[test]
fn renders_canonical_protected_state_and_returns_every_required_content_free_source() {
    let store = seeded();
    let state = load(&store);
    let text = format!(
        "{AUTHORITATIVE_STATE_PREFIX}\n{}",
        r#"{"autonomy":{"mode":"normal","yolo":0},"permissionCeiling":[],"todos":[]}"#
    );
    assert_eq!(state.text, text);
    assert_eq!(state.rendered, expected_message(&text));
    assert!(state.team_view.is_none());
    assert_eq!(state.sources.guardrails, guardrail());
    assert_eq!(state.sources.permissions.sequence, 20);
    assert_eq!(state.sources.instructions.digest, sha256("{}"));
    assert_eq!(state.sources.pending_work.digest, sha256("[]"));
    assert_eq!(state.sources.orchestration.digest, sha256("[]"));
    assert!(!format!("{:?}", state.sources).contains("content"));

    let protected = live_state::protected_state(&state.sources);
    assert_eq!(
        entries(&protected),
        [
            "instructions",
            "todos",
            "goal",
            "autonomy",
            "permissions",
            "guardrails",
            "pending_work",
            "orchestration"
        ]
    );
    assert!(
        protected
            .iter()
            .all(|entry| entry.source != ProtectedStateSource::ProjectArtifacts)
    );
    let permissions = protected
        .iter()
        .find(|entry| entry.source == ProtectedStateSource::Permissions)
        .unwrap();
    assert_eq!(permissions.revision.get(), 20);
    assert_eq!(
        permissions.digest.to_utf8().unwrap(),
        state.sources.permissions.digest
    );
}

#[test]
fn recaptures_database_authorities_from_the_caller_transaction() {
    let store = seeded();
    let initial = live_state::capture(&store.snapshot().unwrap(), &id("ses_one")).unwrap();
    let captured = store
        .submit(|tx| {
            tx.put::<SequenceTable>(&Sequence {
                aggregate_id: "ses_one".into(),
                seq: 21,
                owner_id: None,
            })?;
            insert_pending(
                tx,
                "msg_transaction_pending",
                21,
                "transaction-local secret",
            )?;
            insert_event(
                tx,
                "evt_transaction_admitted",
                21,
                "session.input.admitted.1",
            )?;
            live_state::capture_in(tx, &id("ses_one")).map_err(|error| tx.reject(error))
        })
        .unwrap()
        .wait()
        .unwrap();

    assert_eq!(captured.sources.pending_work.sequence, 21);
    assert_ne!(
        captured.sources.pending_work.digest,
        initial.sources.pending_work.digest
    );
    assert_eq!(
        entries(&live_state::database_protected_state(&captured.sources)),
        [
            "instructions",
            "todos",
            "goal",
            "autonomy",
            "permissions",
            "pending_work",
            "orchestration"
        ]
    );
    assert!(!format!("{captured:?}").contains("transaction-local secret"));
}

#[test]
fn uses_source_owned_sequence_fences_across_protected_state_aba_transitions() {
    let store = seeded();
    let initial = load(&store);

    put_event(&store, "evt_irrelevant", 1, "session.renamed.1");
    let renamed = load(&store);
    assert_eq!(renamed.sources.instructions, initial.sources.instructions);
    assert_eq!(renamed.sources.pending_work, initial.sources.pending_work);

    let values = format!(r#"{{"z":"{}","a":"{}"}}"#, "b".repeat(64), "c".repeat(64));
    run(&store, move |tx| {
        InstructionStateTable::insert(
            tx,
            &InstructionState {
                session_id: "ses_one".into(),
                epoch_start: 2,
                through_seq: 2,
                initial_values: Document::new(json(&values))?,
                current_values: Document::new(json(&values))?,
            },
        )
    });
    put_event(
        &store,
        "evt_instruction",
        2,
        "session.instructions.updated.2",
    );
    let instructed = load(&store);
    assert_eq!(instructed.sources.instructions.sequence, 2);
    assert_ne!(
        instructed.sources.instructions.digest,
        initial.sources.instructions.digest
    );

    run(&store, |tx| {
        tx.delete::<InstructionStateTable>(&key("ses_one"))
            .map(|_| ())
    });
    put_event(&store, "evt_moved", 3, "session.moved.1");
    assert_eq!(
        load(&store).sources.instructions,
        Source {
            sequence: 3,
            digest: initial.sources.instructions.digest.clone()
        }
    );

    put_pending(&store, "msg_live_state_pending", 4, "must remain private");
    put_event(&store, "evt_admitted", 4, "session.input.admitted.1");
    let admitted = load(&store);
    assert_eq!(admitted.sources.pending_work.sequence, 4);
    assert_ne!(
        admitted.sources.pending_work.digest,
        initial.sources.pending_work.digest
    );
    assert!(!format!("{admitted:?}").contains("must remain private"));

    run(&store, |tx| {
        tx.delete::<PendingTable>(&key("msg_live_state_pending"))
            .map(|_| ())
    });
    put_event(&store, "evt_promoted", 5, "session.input.promoted.1");
    assert_eq!(
        load(&store).sources.pending_work,
        Source {
            sequence: 5,
            digest: initial.sources.pending_work.digest.clone()
        }
    );
}

#[test]
fn each_relevant_event_type_advances_only_its_own_source() {
    let cases: [(&str, &[&str]); 11] = [
        ("session.instructions.updated.2", &["instructions"]),
        (
            "session.compaction.ended.1",
            &["instructions", "pending_work"],
        ),
        ("session.compaction.ended.2", &["instructions"]),
        ("session.moved.1", &["instructions"]),
        ("session.revert.committed.1", &["instructions"]),
        ("session.input.admitted.1", &["pending_work"]),
        ("session.input.promoted.1", &["pending_work"]),
        ("session.compaction.admitted.1", &["pending_work"]),
        ("session.compaction.failed.1", &["pending_work"]),
        ("session.created.2", &["permissions"]),
        ("session.forked.2", &["permissions"]),
    ];
    for (index, (type_, advanced)) in cases.iter().enumerate() {
        let store = seeded();
        let before = load(&store).sources;
        let seq = 100 + index as u64;
        put_event(&store, "evt_probe", seq as i64, type_);
        let after = load(&store).sources;
        let sequences = |sources: &live_state::Sources| {
            [
                ("instructions", sources.instructions.sequence),
                ("pending_work", sources.pending_work.sequence),
                ("permissions", sources.permissions.sequence),
                ("todos", sources.todos.sequence),
                ("goal", sources.goal.sequence),
                ("autonomy", sources.autonomy.sequence),
                ("orchestration", sources.orchestration.sequence),
            ]
        };
        for ((name, then), (_, now)) in sequences(&before).into_iter().zip(sequences(&after)) {
            let expected = if advanced.contains(&name) { seq } else { then };
            assert_eq!(now, expected, "{type_} -> {name}");
        }
    }
}

#[test]
fn latest_sequence_probes_pick_the_newest_matching_event_among_many() {
    let store = seeded();
    run(&store, |tx| {
        let types = [
            "session.instructions.updated.2",
            "session.input.admitted.1",
            "session.forked.2",
        ];
        for (source, type_) in types.iter().enumerate() {
            for index in 0..40 {
                let seq = 21 + (source * 40 + index) as i64;
                insert_event(tx, &format!("evt_probe_{source}_{index}"), seq, type_)?;
            }
        }
        Ok(())
    });
    let captured = live_state::capture(&store.snapshot().unwrap(), &id("ses_one")).unwrap();
    assert_eq!(captured.sources.instructions.sequence, 60);
    assert_eq!(captured.sources.pending_work.sequence, 100);
    assert_eq!(captured.sources.permissions.sequence, 140);
}

#[test]
fn missing_sessions_fail_with_not_found() {
    let store = seeded();
    let snapshot = store.snapshot().unwrap();
    assert!(matches!(
        live_state::capture(&snapshot, &id("ses_missing")),
        Err(Error::Domain {
            kind: "not_found",
            ..
        })
    ));
    assert!(matches!(
        live_state::load(&store.client(), &id("ses_missing"), || Ok::<_, ()>(
            guardrail()
        )),
        Err(LoadError::Store(Error::Domain {
            kind: "not_found",
            ..
        }))
    ));
}

#[test]
fn todos_follow_position_and_the_digest_prefers_stored_state() {
    let store = seeded();
    run(&store, |tx| {
        for (position, content, status, priority) in
            [(1, "b", "completed", "low"), (0, "a", "pending", "high")]
        {
            TodoTable::insert(
                tx,
                &Todo {
                    session_id: "ses_one".into(),
                    content: content.into(),
                    status: status.into(),
                    priority: priority.into(),
                    position,
                    time_created: 1,
                    time_updated: 1,
                },
            )?;
        }
        Ok(())
    });
    let state = load(&store);
    assert_eq!(
        state.text,
        format!(
            "{AUTHORITATIVE_STATE_PREFIX}\n{}",
            r#"{"autonomy":{"mode":"normal","yolo":0},"permissionCeiling":[],"todos":[{"content":"a","priority":"high","status":"pending"},{"content":"b","priority":"low","status":"completed"}]}"#
        )
    );
    assert_eq!(state.sources.todos.sequence, 0);
    assert_eq!(
        state.sources.todos.digest,
        sha256(
            r#"[{"content":"a","position":0,"priority":"high","status":"pending"},{"content":"b","position":1,"priority":"low","status":"completed"}]"#
        )
    );

    run(&store, |tx| {
        TodoStateTable::insert(
            tx,
            &TodoState {
                session_id: "ses_one".into(),
                revision: 3,
                digest: "d".repeat(64).into(),
                time_updated: 1,
            },
        )
    });
    assert_eq!(
        load(&store).sources.todos,
        Source {
            sequence: 3,
            digest: "d".repeat(64)
        }
    );
}

#[test]
fn permission_ceiling_keeps_only_unique_deny_rules_in_the_digest_and_text() {
    let store = seeded();
    edit_session(&store, "ses_one", |row| {
        row.permission = Some(
            Document::new(json(
                r#"[{"action":"bash","resource":"*","effect":"deny"},{"action":"edit","resource":"*","effect":"allow"},{"action":"bash","resource":"*","effect":"deny"},{"action":"read","resource":"/secret","effect":"deny"}]"#,
            ))
            .unwrap(),
        )
    });
    let state = load(&store);
    let ceiling = r#"[{"action":"bash","effect":"deny","resource":"*"},{"action":"read","effect":"deny","resource":"/secret"}]"#;
    assert!(
        state
            .text
            .contains(&format!(r#""permissionCeiling":{ceiling}"#))
    );
    assert_eq!(state.sources.permissions.digest, sha256(ceiling));
}

#[test]
fn goal_autonomy_shares_one_revision_and_the_reminder_follows_the_state() {
    let store = seeded();
    let active = State {
        yolo: YoloLevel::new(1).unwrap(),
        goal: Some(Goal::new("ship it", None, Some(3))),
        sleep: false,
        auto_answer: None,
    };
    let encoded = active.encode();
    edit_session(&store, "ses_one", move |row| {
        row.autonomy = Some(encoded);
        row.autonomy_revision = 7;
    });
    let state = load(&store);
    assert_eq!(state.sources.goal.sequence, 7);
    assert_eq!(state.sources.autonomy.sequence, 7);
    assert_eq!(
        state.sources.goal.digest,
        sha256(&canonical_json(&goal_json(&active)))
    );
    assert_eq!(state.sources.autonomy.digest, active.digest());
    let reminder = active.goal_reminder().unwrap();
    assert!(
        reminder.starts_with("Active autonomous goal (iteration 0, noProgress 0/3): ship it\n")
    );
    assert!(state.text.ends_with(&format!("\n\n{reminder}")));
    assert_eq!(state.rendered, expected_message(&state.text));

    let stopped = active.stop_goal();
    let encoded = stopped.encode();
    edit_session(&store, "ses_one", move |row| row.autonomy = Some(encoded));
    assert!(
        load(&store)
            .text
            .ends_with("\n\nAutonomous goal is stopped: ship it")
    );

    edit_session(&store, "ses_one", |row| {
        row.autonomy = None;
        row.autonomy_revision = 8;
    });
    let cleared = load(&store);
    assert_eq!(cleared.sources.goal.digest, sha256("null"));
    assert!(!cleared.text.contains("goal"));
}

#[test]
fn orchestration_source_tracks_child_task_revisions_and_exposes_the_team_view() {
    let store = seeded();
    let task = |revision: i64| Task {
        session_id: "ses_two".into(),
        parent_id: "ses_one".into(),
        parent_assistant_message_id: "msg_assistant".into(),
        tool_call_id: "call".into(),
        input_id: "msg_input".into(),
        description: "child work".into(),
        agent: "build".into(),
        model: Document::new(json(r#"{"providerID":"local","id":"test"}"#)).unwrap(),
        prompt_digest: "e".repeat(64).into(),
        background: 1,
        delivery: "steer".into(),
        state: "running".into(),
        progress: None,
        progress_time: None,
        question_id: None,
        question: None,
        question_data: None,
        question_time: None,
        attempt_started: 0,
        owner_pid: None,
        owner_started: None,
        revision,
        time_created: 1,
        time_updated: 1,
        usage_anchor: None,
    };
    let first = task(2);
    run(&store, move |tx| TaskTable::insert(tx, &first));
    edit_session(&store, "ses_one", |row| row.orchestration_revision = 5);
    let state = load(&store);
    assert_eq!(state.sources.orchestration.sequence, 5);
    assert_eq!(
        state.sources.orchestration.digest,
        sha256(r#"[{"revision":2,"sessionID":"ses_two"}]"#)
    );
    let team_view = state.team_view.unwrap();
    assert!(
        team_view
            .text
            .starts_with("Internal orchestration context (JSON).")
    );
    assert!(team_view.text.contains(r#""description":"child work""#));

    let second = task(3);
    run(&store, move |tx| TaskTable::put(tx, &second));
    assert_eq!(
        load(&store).sources.orchestration.digest,
        sha256(r#"[{"revision":3,"sessionID":"ses_two"}]"#)
    );
}

#[test]
fn load_retries_until_the_guardrail_snapshot_is_stable_across_the_database_read() {
    let store = seeded();
    let calls = Cell::new(0);
    let snapshots = [
        Source {
            sequence: 1,
            digest: "1".repeat(64),
        },
        Source {
            sequence: 2,
            digest: "2".repeat(64),
        },
        Source {
            sequence: 2,
            digest: "2".repeat(64),
        },
        Source {
            sequence: 2,
            digest: "2".repeat(64),
        },
    ];
    let state = live_state::load(&store.client(), &id("ses_one"), || {
        let call = calls.get();
        calls.set(call + 1);
        Ok::<_, ()>(snapshots[call].clone())
    })
    .unwrap();
    assert_eq!(calls.get(), 4);
    assert_eq!(state.sources.guardrails, snapshots[3]);

    let failed = live_state::load(&store.client(), &id("ses_one"), || {
        Err::<Source, _>("denied")
    });
    assert!(matches!(failed, Err(LoadError::Guardrail("denied"))));
}
