use ycoding_core::session::{lifecycle::Change, pending::Request, store::Service};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, ObjectEncoder, event, model, parse_json, session,
    session_delivery, session_event, session_message, session_pending,
};
use ycoding_store::{
    Error, KeyPart,
    session::{
        ContextStateTable, Document, FileChangeTable, Message, MessageTable, NewEvent,
        SessionTable, Task, TaskTable,
    },
    tuple_key,
};

#[path = "autonomy_support/mod.rs"]
mod support;

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}
fn mid(value: &str) -> session_message::Id {
    session_message::Id::new(value).unwrap()
}
fn request(session: &str, message: &str, text: &str, delivery: &str) -> Request {
    Request {
        session_id: id(session),
        id: mid(message),
        created: 10,
        event_id: event::Id::new(format!("evt_{message}")).unwrap(),
        input: session_pending::Message::Synthetic(session_pending::SyntheticMessage {
            data: session_pending::SyntheticData {
                text: text.into(),
                description: Some("completion".into()),
                metadata: Some(
                    ycoding_schema::JsonObject::decode(&parse_json(r#"{"job":"done"}"#).unwrap())
                        .unwrap(),
                ),
            },
            delivery: session_delivery::Delivery::decode(&JsonValue::String(delivery.into()))
                .unwrap(),
        }),
    }
}

#[tokio::test]
async fn daybreak_sets_clears_and_always_records_a_fact_without_messages_or_pending() {
    let store = support::store();
    let sessions = Service::new(store.client());
    for program in [
        Some("daybreak_blue"),
        Some("daybreak_red"),
        Some("daybreak_red"),
        None,
    ] {
        let program =
            program.map(|value| model::Daybreak::decode(&JsonValue::String(value.into())).unwrap());
        assert!(
            sessions
                .change(&id("ses_one"), Change::Daybreak(program.clone()))
                .await
                .unwrap()
        );
        assert_eq!(
            sessions.get(&id("ses_one")).unwrap().unwrap().daybreak,
            program
        );
    }
    let log = sessions.log(&id("ses_one"), None, 10).unwrap();
    assert_eq!(log.events.len(), 4);
    for entry in &log.events {
        assert_eq!(
            entry.event.0.event_type.as_str(),
            Some("session.daybreak.set")
        );
        assert_eq!(entry.version, 1);
    }
    assert_eq!(
        log.events[3].event.0.data.encode(),
        ObjectEncoder::new()
            .field("sessionID", &id("ses_one"))
            .finish()
    );
    assert!(sessions.transcript(&id("ses_one")).unwrap().is_empty());
    assert!(sessions.pending_list(&id("ses_one")).unwrap().is_empty());
    assert!(
        !sessions
            .change(&id("ses_missing"), Change::Daybreak(None))
            .await
            .unwrap()
    );
    assert_eq!(
        sessions.get(&id("ses_two")).unwrap().unwrap().daybreak,
        None
    );
}

#[tokio::test]
async fn synthetic_admission_is_first_wins_before_and_after_promotion_with_kind_and_owner_conflicts()
 {
    let store = support::store();
    let sessions = Service::new(store.client());
    let (first, retry) = tokio::join!(
        sessions.admit_input(request("ses_one", "msg_synthetic", "first", "steer")),
        sessions.admit_input(request("ses_one", "msg_synthetic", "first", "steer"))
    );
    let first = first.unwrap().pending;
    assert_eq!(first, retry.unwrap().pending);
    assert!(sessions.transcript(&id("ses_one")).unwrap().is_empty());
    assert_eq!(
        sessions.promote_steers(&id("ses_one"), 20).await.unwrap(),
        1
    );
    assert_eq!(
        first,
        sessions
            .admit_input(request("ses_one", "msg_synthetic", "changed", "queue"))
            .await
            .unwrap()
            .pending
    );
    assert!(sessions.pending_list(&id("ses_one")).unwrap().is_empty());
    assert_eq!(
        sessions.log(&id("ses_one"), None, 10).unwrap().events.len(),
        2
    );
    let transcript = sessions.transcript(&id("ses_one")).unwrap();
    assert_eq!(transcript[0], session_message::Info::decode(&parse_json(r#"{"id":"msg_synthetic","type":"synthetic","text":"first","description":"completion","metadata":{"job":"done"},"time":{"created":20}}"#).unwrap()).unwrap());
    assert!(matches!(
        sessions
            .admit_input(request("ses_two", "msg_synthetic", "foreign", "steer"))
            .await,
        Err(Error::Domain {
            kind: "input_identity",
            ..
        })
    ));
    let mut user = request("ses_one", "msg_synthetic", "user", "steer");
    user.input = session_pending::Message::User(session_pending::UserMessage {
        data: session_pending::UserData {
            text: "user".into(),
            files: None,
            agents: None,
            metadata: None,
        },
        delivery: session_delivery::Delivery::decode(&JsonValue::String("steer".into())).unwrap(),
    });
    assert!(matches!(
        sessions.admit_input(user).await,
        Err(Error::Domain {
            kind: "input_identity",
            ..
        })
    ));
    assert!(matches!(
        sessions
            .admit_input(request("ses_missing", "msg_missing", "missing", "steer"))
            .await,
        Err(Error::Domain {
            kind: "not_found",
            ..
        })
    ));
    sessions
        .admit_input(request("ses_one", "msg_queue", "queued", "queue"))
        .await
        .unwrap();
    assert_eq!(
        sessions.promote_steers(&id("ses_one"), 30).await.unwrap(),
        0
    );
    assert!(
        sessions
            .promote_next_queued(&id("ses_one"), 30)
            .await
            .unwrap()
    );
    assert_eq!(sessions.transcript(&id("ses_one")).unwrap().len(), 2);
}

#[tokio::test]
async fn fork_copies_before_boundary_resets_state_and_preserves_location_selection_ceiling_and_binding()
 {
    let store = support::store();
    let sessions = Service::new(store.client());
    let binding = session_event::ProfileBinding::decode(&parse_json(r#"{"providerID":"openai","integrationID":"openai","profile":"Work","credentialID":"cred_unavailable","accountGeneration":2}"#).unwrap()).unwrap();
    let binding_doc = Document::from_domain(&binding).unwrap();
    let saved = binding_doc.clone();
    store.submit(move |tx| {
        let mut parent = support::record("ses_one");
        parent.title = "Parent".into();
        parent.agent = Some("build".into());
        parent.model = Some(Document::from_domain(&model::Ref::decode(&parse_json(r#"{"id":"model","providerID":"openai","profile":"Work"}"#).unwrap()).unwrap())?);
        parent.daybreak = Some("daybreak_red".into());
        parent.profile_binding = Some(binding_doc);
        parent.permission = Some(Document::from_domain(&ycoding_schema::permission::Ruleset::decode(&parse_json(r#"[{"action":"shell","effect":"deny","resource":"*"},{"action":"read","effect":"allow","resource":"*"}]"#).unwrap()).unwrap())?);
        parent.cost = 12.0;
        parent.tokens_input = 200;
        parent.time_archived = Some(5);
        parent.time_pinned = Some(5);
        SessionTable::put(tx, &parent)
    }).unwrap().await.unwrap();
    sessions
        .admit_input(request("ses_one", "msg_first", "first", "steer"))
        .await
        .unwrap();
    sessions.promote_steers(&id("ses_one"), 20).await.unwrap();
    sessions
        .admit_input(request("ses_one", "msg_second", "second", "steer"))
        .await
        .unwrap();
    sessions.promote_steers(&id("ses_one"), 30).await.unwrap();
    sessions
        .admit_input(request("ses_one", "msg_unconsumed", "pending", "queue"))
        .await
        .unwrap();
    let fork = sessions
        .fork(&id("ses_one"), Some(mid("msg_second")))
        .await
        .unwrap();
    assert_eq!(fork.title.as_str(), Some("Parent (fork #1)"));
    assert!(fork.parent_id.is_none());
    assert_eq!(fork.fork.as_ref().unwrap().session_id, id("ses_one"));
    assert_eq!(
        fork.fork.as_ref().unwrap().message_id,
        Some(mid("msg_second"))
    );
    assert_eq!(fork.cost.get(), 0.0);
    assert_eq!(fork.tokens.input.get(), 0.0);
    assert_eq!(
        fork.tokens.encode(),
        parse_json(r#"{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}"#).unwrap()
    );
    assert!(fork.time.archived.is_none() && fork.time.pinned.is_none());
    assert_eq!(fork.agent.as_ref().unwrap().as_str(), Some("build"));
    assert!(fork.daybreak.is_none());
    assert_eq!(
        fork.location,
        sessions.get(&id("ses_one")).unwrap().unwrap().location
    );
    assert_eq!(fork.permission_ceiling.as_ref().unwrap().len(), 1);
    assert_eq!(sessions.profile_binding(&fork.id).unwrap(), Some(binding));
    let key = tuple_key(&[KeyPart::String(fork.id.as_lossless())]);
    let row = store
        .client()
        .snapshot()
        .unwrap()
        .get::<SessionTable>(&key)
        .unwrap()
        .unwrap();
    assert_eq!(row.profile_binding, Some(saved));
    assert_eq!(
        row.model,
        store
            .client()
            .snapshot()
            .unwrap()
            .get::<SessionTable>(&tuple_key(&[KeyPart::String(id("ses_one").as_lossless())]))
            .unwrap()
            .unwrap()
            .model
    );
    assert_eq!(
        store
            .client()
            .snapshot()
            .unwrap()
            .get::<ContextStateTable>(&key)
            .unwrap()
            .unwrap()
            .revision,
        0
    );
    let transcript = sessions.transcript(&fork.id).unwrap();
    assert_eq!(transcript.len(), 1);
    let JsonValue::Object(message) = transcript[0].encode() else {
        panic!("message")
    };
    let copied_id = session_message::Id::decode(message.get(&"id".into()).unwrap()).unwrap();
    assert_ne!(copied_id, mid("msg_first"));
    assert!(sessions.pending_list(&fork.id).unwrap().is_empty());
    assert!(matches!(
        sessions
            .admit_input(request(
                fork.id.as_lossless().as_str().unwrap(),
                copied_id.as_lossless().as_str().unwrap(),
                "retry",
                "steer"
            ))
            .await,
        Err(Error::Domain {
            kind: "input_identity",
            ..
        })
    ));
    let log = sessions.log(&fork.id, None, 10).unwrap();
    assert_eq!(
        log.events[0].event.0.data.encode(),
        ObjectEncoder::new()
            .field("sessionID", &fork.id)
            .field("parentID", &id("ses_one"))
            .field("parentSeq", &2.0)
            .field("from", &mid("msg_second"))
            .finish()
    );
    assert_eq!(log.events[0].version, 2);
    assert_eq!(
        log.events[1].event.0.event_type.as_str(),
        Some("session.profile.bound")
    );
    let empty = sessions
        .fork(&id("ses_one"), Some(mid("msg_first")))
        .await
        .unwrap();
    assert!(sessions.transcript(&empty.id).unwrap().is_empty());
    let all = sessions.fork(&id("ses_one"), None).await.unwrap();
    assert_eq!(sessions.transcript(&all.id).unwrap().len(), 2);
    assert!(sessions.pending_list(&all.id).unwrap().is_empty());
    let nested = sessions.fork(&all.id, None).await.unwrap();
    assert_eq!(nested.title.as_str(), Some("Parent (fork #2)"));
    sessions
        .admit_input(request(
            fork.id.as_lossless().as_str().unwrap(),
            "msg_fork_new",
            "new",
            "steer",
        ))
        .await
        .unwrap();
    sessions.promote_steers(&fork.id, 40).await.unwrap();
    assert_eq!(sessions.transcript(&fork.id).unwrap().len(), 2);
    assert_eq!(sessions.transcript(&id("ses_one")).unwrap().len(), 2);
}

#[tokio::test]
async fn fork_rejects_missing_and_foreign_boundaries_without_creating_a_session() {
    let store = support::store();
    let sessions = Service::new(store.client());
    sessions
        .admit_input(request("ses_two", "msg_foreign", "foreign", "steer"))
        .await
        .unwrap();
    sessions.promote_steers(&id("ses_two"), 20).await.unwrap();
    for boundary in ["msg_foreign", "msg_missing"] {
        assert!(matches!(
            sessions.fork(&id("ses_one"), Some(mid(boundary))).await,
            Err(Error::Domain {
                kind: "message_not_found",
                ..
            })
        ));
    }
    assert!(matches!(
        sessions.fork(&id("ses_missing"), None).await,
        Err(Error::Domain {
            kind: "not_found",
            ..
        })
    ));
    assert_eq!(sessions.list(&Default::default()).unwrap().len(), 2);
}

#[tokio::test]
async fn fork_pages_history_and_excludes_only_running_compaction() {
    let store = support::store();
    let sessions = Service::new(store.client());
    store.submit(|tx| {
        for seq in 0..502 {
            MessageTable::insert(tx, &Message {
                id: format!("msg_page_{seq}").into(), session_id: "ses_one".into(), type_: "synthetic".into(), seq,
                time_created: seq, time_updated: seq,
                data: ObjectEncoder::new().field("text", "page").field("time", &ObjectEncoder::new().field("created", &(seq as f64)).finish()).finish(),
            })?;
        }
        MessageTable::insert(tx, &Message {
            id: "msg_running".into(), session_id: "ses_one".into(), type_: "compaction".into(), seq: 502,
            time_created: 502, time_updated: 502,
            data: parse_json(r#"{"status":"running","jobID":"cmp_running","trigger":"manual","time":{"created":502}}"#).unwrap(),
        })?;
        ycoding_store::session::reserve_sequence(tx, &"ses_one".into(), 502)
    }).unwrap().await.unwrap();
    let fork = sessions.fork(&id("ses_one"), None).await.unwrap();
    assert_eq!(sessions.transcript(&fork.id).unwrap().len(), 502);
    sessions
        .admit_input(request(
            fork.id.as_lossless().as_str().unwrap(),
            "msg_after_page",
            "after",
            "steer",
        ))
        .await
        .unwrap();
    sessions.promote_steers(&fork.id, 600).await.unwrap();
    assert_eq!(sessions.transcript(&fork.id).unwrap().len(), 503);
}

#[tokio::test]
async fn fork_rebuilds_instruction_lineage_at_the_selected_boundary() {
    let store = support::store();
    let sessions = Service::new(store.client());
    for (event, hash) in [("initial", "a"), ("updated", "b")] {
        sessions
            .publish(NewEvent {
                id: format!("evt_instruction_{event}").into(),
                aggregate_id: "ses_one".into(),
                created: 10,
                type_: "session.instructions.updated.2".into(),
                data: ObjectEncoder::new()
                    .field("sessionID", &id("ses_one"))
                    .field(
                        "delta",
                        &ObjectEncoder::new()
                            .field("api/task", hash.repeat(64).as_str())
                            .finish(),
                    )
                    .finish(),
            })
            .await
            .unwrap();
        sessions
            .admit_input(request(
                "ses_one",
                &format!("msg_instruction_{event}"),
                event,
                "steer",
            ))
            .await
            .unwrap();
        sessions.promote_steers(&id("ses_one"), 20).await.unwrap();
    }
    let fork = sessions
        .fork(&id("ses_one"), Some(mid("msg_instruction_initial")))
        .await
        .unwrap();
    let state = sessions
        .rebuild_instruction_state(&fork.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        state.current_values.value(),
        &parse_json(&format!(r#"{{"api/task":"{}"}}"#, "a".repeat(64))).unwrap()
    );
    let full = sessions.fork(&id("ses_one"), None).await.unwrap();
    let state = sessions
        .rebuild_instruction_state(&full.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        state.current_values.value(),
        &parse_json(&format!(r#"{{"api/task":"{}"}}"#, "b".repeat(64))).unwrap()
    );
}

#[tokio::test]
async fn recorded_profile_bindings_replay_without_current_credentials_but_new_selection_still_validates()
 {
    let store = support::store();
    let sessions = Service::new(store.client());
    let binding = session_event::ProfileBinding::decode(&parse_json(r#"{"providerID":"openai","integrationID":"openai","profile":"Work","credentialID":"cred_missing","accountGeneration":1}"#).unwrap()).unwrap();
    sessions
        .publish(NewEvent {
            id: "evt_profile_replay".into(),
            aggregate_id: "ses_one".into(),
            created: 1,
            type_: "session.profile.bound.1".into(),
            data: ObjectEncoder::new()
                .field("sessionID", &id("ses_one"))
                .field("binding", &binding)
                .finish(),
        })
        .await
        .unwrap();
    assert_eq!(
        sessions.profile_binding(&id("ses_one")).unwrap(),
        Some(binding.clone())
    );
    let credentials = ycoding_core::resources::credential::Service::new(store.client());
    assert!(
        credentials
            .publish_binding(
                "ses_two".into(),
                "evt_invalid_selection".into(),
                Some(ycoding_core::resources::credential::Binding::from_domain(
                    binding
                )),
                2
            )
            .await
            .is_err()
    );
    assert!(sessions.profile_binding(&id("ses_two")).unwrap().is_none());
}

#[tokio::test]
async fn file_change_event_rejects_non_string_paths_and_negative_or_unsafe_counts() {
    let store = support::store();
    let sessions = Service::new(store.client());
    for (suffix, path, additions) in [
        ("path", JsonValue::Number(1.0), 1.0),
        ("negative", JsonValue::String("src.rs".into()), -1.0),
        (
            "unsafe",
            JsonValue::String("src.rs".into()),
            9_007_199_254_740_992.0,
        ),
    ] {
        assert!(
            sessions
                .publish(NewEvent {
                    id: format!("evt_bad_{suffix}").into(),
                    aggregate_id: "ses_one".into(),
                    created: 10,
                    type_: "session.file-change.recorded.1".into(),
                    data: ObjectEncoder::new()
                        .field("sessionID", &id("ses_one"))
                        .field(
                            "change",
                            &ObjectEncoder::new()
                                .field("path", &path)
                                .field("patch", "patch")
                                .field("additions", &additions)
                                .field("deletions", &0.0)
                                .finish()
                        )
                        .finish(),
                })
                .await
                .is_err()
        );
    }
    assert!(sessions.file_changes(&id("ses_one")).unwrap().is_empty());
    assert!(
        sessions
            .log(&id("ses_one"), None, 10)
            .unwrap()
            .events
            .is_empty()
    );
}

async fn record_change(
    sessions: &Service,
    session: &str,
    suffix: &str,
    path: &str,
    patch: &str,
    additions: f64,
    deletions: f64,
) {
    sessions
        .publish(NewEvent {
            id: format!("evt_change_{suffix}").into(),
            aggregate_id: session.into(),
            created: 30,
            type_: "session.file-change.recorded.1".into(),
            data: ObjectEncoder::new()
                .field("sessionID", &id(session))
                .field(
                    "change",
                    &ObjectEncoder::new()
                        .field("path", path)
                        .field("patch", patch)
                        .field("additions", &additions)
                        .field("deletions", &deletions)
                        .finish(),
                )
                .finish(),
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn file_changes_accumulate_counts_keep_latest_patch_and_include_completed_direct_children_only()
 {
    let store = support::store();
    let sessions = Service::new(store.client());
    store
        .submit(|tx| {
            for (child, parent, state) in [
                ("ses_done", "ses_one", "completed"),
                ("ses_run", "ses_one", "running"),
                ("ses_failed", "ses_one", "failed"),
                ("ses_grandchild", "ses_done", "completed"),
                ("ses_unrelated", "ses_two", "completed"),
            ] {
                SessionTable::insert(tx, &support::record(child))?;
                TaskTable::insert(
                    tx,
                    &Task {
                        session_id: child.into(),
                        parent_id: parent.into(),
                        parent_assistant_message_id: format!("msg_parent_{child}").into(),
                        tool_call_id: child.into(),
                        input_id: format!("msg_input_{child}").into(),
                        description: "task".into(),
                        agent: "build".into(),
                        model: Document::from_domain(
                            &model::Ref::decode(
                                &parse_json(r#"{"id":"model","providerID":"openai"}"#).unwrap(),
                            )
                            .unwrap(),
                        )?,
                        prompt_digest: "digest".into(),
                        background: 1,
                        delivery: "queue".into(),
                        state: state.into(),
                        progress: None,
                        progress_time: None,
                        question_id: None,
                        question: None,
                        question_data: None,
                        question_time: None,
                        attempt_started: 0,
                        revision: 1,
                        time_created: 1,
                        time_updated: 1,
                    },
                )?;
            }
            Ok(())
        })
        .unwrap()
        .await
        .unwrap();
    record_change(&sessions, "ses_one", "a", "z.ts", "first", 2.0, 1.0).await;
    record_change(&sessions, "ses_one", "b", "z.ts", "latest", 3.0, 4.0).await;
    record_change(&sessions, "ses_done", "c", "a.ts", "child", 7.0, 0.0).await;
    record_change(&sessions, "ses_done", "d", "z.ts", "duplicate", 1.0, 1.0).await;
    for child in ["ses_run", "ses_failed", "ses_grandchild", "ses_unrelated"] {
        record_change(&sessions, child, child, "hidden.ts", "hidden", 1.0, 0.0).await;
    }
    let changes = sessions.file_changes(&id("ses_one")).unwrap();
    assert_eq!(
        changes
            .iter()
            .map(|row| (row.path.as_str().unwrap(), row.session_id.as_str().unwrap()))
            .collect::<Vec<_>>(),
        [
            ("a.ts", "ses_done"),
            ("z.ts", "ses_done"),
            ("z.ts", "ses_one")
        ]
    );
    assert_eq!(changes[2].patch.as_str(), Some("latest"));
    assert_eq!((changes[2].additions, changes[2].deletions), (5, 5));
    assert_eq!(changes[2].latest_seq, 1);
    assert!(
        sessions
            .file_changes(&id("ses_two"))
            .unwrap()
            .iter()
            .all(|row| row.session_id.as_str() == Some("ses_unrelated"))
    );
    assert!(matches!(
        sessions.file_changes(&id("ses_missing")),
        Err(Error::Domain {
            kind: "not_found",
            ..
        })
    ));
    let stored = store
        .client()
        .snapshot()
        .unwrap()
        .get::<FileChangeTable>(&tuple_key(&[
            KeyPart::String(&"ses_one".into()),
            KeyPart::String(&"z.ts".into()),
        ]))
        .unwrap()
        .unwrap();
    assert_eq!(stored.additions, 5);
}
