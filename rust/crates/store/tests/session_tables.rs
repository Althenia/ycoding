use std::ops::Bound;
use ycoding_schema::LosslessString;
use ycoding_store::{
    Catalog, Error, IndexOrder, IndexQuery, KeyPart, Metadata, Options, Store, TableDeclaration,
    TableSpec, project, session, tuple_key,
};

#[test]
fn cleanup_keyset_is_bounded_and_uses_sqlite_binary_tiebreaks() {
    let store = store();
    store
        .submit(|tx| {
            for index in 0..205 {
                session::SessionTable::put(
                    tx,
                    &session::Session {
                        time_updated: 1,
                        ..record(&format!("ses_{index:03}"))
                    },
                )?;
            }
            for id in ["ses_\u{e000}", "ses_\u{10000}"] {
                session::SessionTable::put(
                    tx,
                    &session::Session {
                        time_updated: 2,
                        ..record(id)
                    },
                )?;
            }
            for unit in [0xd800, 0xd801] {
                session::SessionTable::put(
                    tx,
                    &session::Session {
                        id: LosslessString::from_utf16(
                            "ses_".encode_utf16().chain([unit]).collect(),
                        ),
                        time_updated: 2,
                        ..record("unused")
                    },
                )?;
            }
            session::SessionTable::put(
                tx,
                &session::Session {
                    time_updated: 3,
                    ..record("ses_boundary")
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    let first = session::cleanup_sessions(&snapshot, 3, None).unwrap();
    assert_eq!(first.len(), 200);
    assert_eq!(first[0].id, LosslessString::from("ses_000"));
    assert_eq!(first[199].id, LosslessString::from("ses_199"));
    let second = session::cleanup_sessions(&snapshot, 3, first.last()).unwrap();
    assert_eq!(second.len(), 9);
    assert_eq!(second[5].id, LosslessString::from("ses_\u{e000}"));
    assert_eq!(second[8].id, LosslessString::from("ses_\u{10000}"));
    let remainder = session::cleanup_sessions(&snapshot, 3, Some(&second[6])).unwrap();
    assert_eq!(remainder.len(), 2);
    assert_eq!(remainder[0].id, second[7].id);
    assert!(
        session::cleanup_sessions(&snapshot, 3, second.last())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn cleanup_rolls_back_and_resumes_from_committed_pages_without_touching_history() {
    let store = store();
    store
        .submit(|tx| {
            session::SessionTable::put(
                tx,
                &session::Session {
                    time_updated: 0,
                    ..record("s")
                },
            )?;
            session::SessionTable::put(
                tx,
                &session::Session {
                    time_updated: 0,
                    ..record("other")
                },
            )?;
            session::append(tx, &event("e0"), None)?;
            session::MessageTable::put(tx, &message("m", 0))?;
            for index in 0..260 {
                session::FileChangeTable::put(
                    tx,
                    &session::FileChange {
                        session_id: "s".into(),
                        path: format!("file{index}").into(),
                        patch: "@@".into(),
                        additions: 1,
                        deletions: 0,
                        latest_seq: 0,
                    },
                )?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = std::sync::Arc::new(store.snapshot().unwrap());
    let page = session::cleanup_sessions(&snapshot, 1, None).unwrap();
    let initial = snapshot.clone();
    let sessions = page.clone();
    assert!(
        store
            .submit(move |tx| {
                assert_eq!(
                    session::cleanup_projections(
                        tx,
                        &initial,
                        &sessions,
                        1,
                        &[],
                        session::Projection::Files
                    )?
                    .files,
                    260
                );
                Err::<(), _>(Error::Rejected("interrupted sweep"))
            })
            .unwrap()
            .wait()
            .is_err()
    );
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .scan::<session::FileChangeTable>(Bound::Unbounded, Bound::Unbounded, 300)
            .unwrap()
            .len(),
        260
    );
    let initial = snapshot.clone();
    let sessions = page.clone();
    let deleted = store
        .submit(move |tx| {
            session::cleanup_projections(
                tx,
                &initial,
                &sessions,
                1,
                &[],
                session::Projection::Files,
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(deleted.files, 260);
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .scan::<session::MessageTable>(Bound::Unbounded, Bound::Unbounded, 1)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .scan::<session::EventTable>(Bound::Unbounded, Bound::Unbounded, 1)
            .unwrap()
            .len(),
        1
    );
    let deleted = store
        .submit(move |tx| {
            session::cleanup_projections(tx, &snapshot, &page, 1, &[], session::Projection::Files)
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(deleted.files, 0);
}

#[test]
fn cleanup_rechecks_activity_and_freshness_and_preserves_new_rows() {
    let store = store();
    store
        .submit(|tx| {
            for id in ["s", "active", "fresh"] {
                session::SessionTable::put(
                    tx,
                    &session::Session {
                        time_updated: 0,
                        ..record(id)
                    },
                )?;
                session::FileChangeTable::put(
                    tx,
                    &session::FileChange {
                        session_id: id.into(),
                        path: "old".into(),
                        patch: "@@".into(),
                        additions: 1,
                        deletions: 0,
                        latest_seq: 0,
                    },
                )?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = std::sync::Arc::new(store.snapshot().unwrap());
    let page = session::cleanup_sessions(&snapshot, 1, None).unwrap();
    store
        .submit(|tx| {
            session::SessionTable::put(
                tx,
                &session::Session {
                    time_updated: 1,
                    ..record("fresh")
                },
            )?;
            session::FileChangeTable::put(
                tx,
                &session::FileChange {
                    session_id: "s".into(),
                    path: "new".into(),
                    patch: "new row".into(),
                    additions: 1,
                    deletions: 0,
                    latest_seq: 0,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let deleted = store
        .submit(move |tx| {
            session::cleanup_projections(
                tx,
                &snapshot,
                &page,
                1,
                &["active".into()],
                session::Projection::Files,
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(deleted.files, 1);
    let rows = store
        .snapshot()
        .unwrap()
        .scan::<session::FileChangeTable>(Bound::Unbounded, Bound::Unbounded, 10)
        .unwrap();
    assert_eq!(rows.len(), 3);
    assert!(rows.iter().any(|row| row.patch.as_str() == Some("new row")));
}

#[test]
fn cleanup_restart_resumes_after_a_committed_200_session_page() {
    let path = std::env::temp_dir().join(format!(
        "ycoding-cleanup-resume-{}-{}.redb",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let store =
        Store::initialize(&path, Options::core(), CATALOG, Metadata::new([6; 16], 1)).unwrap();
    store
        .submit(|tx| {
            project::ProjectTable::put(tx, &root())?;
            for index in 0..205 {
                let id = format!("ses_{index:03}");
                session::SessionTable::put(
                    tx,
                    &session::Session {
                        time_updated: 0,
                        ..record(&id)
                    },
                )?;
                session::FileChangeTable::put(
                    tx,
                    &session::FileChange {
                        session_id: id.into(),
                        path: "file".into(),
                        patch: "@@".into(),
                        additions: 1,
                        deletions: 0,
                        latest_seq: 0,
                    },
                )?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = std::sync::Arc::new(store.snapshot().unwrap());
    let page = session::cleanup_sessions(&snapshot, 1, None).unwrap();
    assert_eq!(
        store
            .submit(move |tx| session::cleanup_projections(
                tx,
                &snapshot,
                &page,
                1,
                &[],
                session::Projection::Files
            ))
            .unwrap()
            .wait()
            .unwrap()
            .files,
        200
    );
    store.shutdown().unwrap();
    let store = Store::open(&path, Options::core(), CATALOG).unwrap();
    let snapshot = std::sync::Arc::new(store.snapshot().unwrap());
    let first = session::cleanup_sessions(&snapshot, 1, None).unwrap();
    let initial = snapshot.clone();
    let next = first.last().cloned();
    assert_eq!(
        store
            .submit(move |tx| session::cleanup_projections(
                tx,
                &initial,
                &first,
                1,
                &[],
                session::Projection::Files
            ))
            .unwrap()
            .wait()
            .unwrap()
            .files,
        0
    );
    let second = session::cleanup_sessions(&snapshot, 1, next.as_ref()).unwrap();
    assert_eq!(
        store
            .submit(move |tx| session::cleanup_projections(
                tx,
                &snapshot,
                &second,
                1,
                &[],
                session::Projection::Files
            ))
            .unwrap()
            .wait()
            .unwrap()
            .files,
        5
    );
    store.shutdown().unwrap();
    std::fs::remove_file(path).unwrap();
}

const CATALOG: Catalog = Catalog::new(
    1,
    &[
        TableDeclaration::of::<project::ProjectTable>(),
        TableDeclaration::of::<project::WorkspaceTable>(),
        TableDeclaration::of::<project::DirectoryTable>(),
        TableDeclaration::of::<project::PermissionTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::ArtifactTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::ScopeTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::ProjectScopeTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::GlobalScopeTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::VersionTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::TrashTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::OperationTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::ActivationTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::ObservationTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::TerminalTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::FeedbackTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::WriteTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::LegacyCleanupTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::MigrationTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::DatabaseFormatTable>(),
        TableDeclaration::of::<session::SequenceTable>(),
        TableDeclaration::of::<session::EventTable>(),
        TableDeclaration::of::<session::SessionTable>(),
        TableDeclaration::of::<session::MessageTable>(),
        TableDeclaration::of::<session::PendingTable>(),
        TableDeclaration::of::<session::TodoTable>(),
        TableDeclaration::of::<session::TodoStateTable>(),
        TableDeclaration::of::<session::FileChangeTable>(),
        TableDeclaration::of::<session::TaskTable>(),
        TableDeclaration::of::<session::NotificationTable>(),
        TableDeclaration::of::<session::ManifestTable>(),
        TableDeclaration::of::<session::JobTable>(),
        TableDeclaration::of::<session::RevisionTable>(),
        TableDeclaration::of::<session::ContextStateTable>(),
        TableDeclaration::of::<session::ExclusionTable>(),
        TableDeclaration::of::<session::InstructionEntryTable>(),
        TableDeclaration::of::<session::InstructionBlobTable>(),
        TableDeclaration::of::<session::InstructionStateTable>(),
        TableDeclaration::of::<ycoding_store::resources::CredentialTable>(),
        TableDeclaration::of::<ycoding_store::resources::KvTable>(),
        TableDeclaration::of::<ycoding_store::resources::ShellTable>(),
        TableDeclaration::of::<ycoding_store::resources::ConsentTable>(),
        TableDeclaration::of::<ycoding_store::resources::MigrationTable>(),
        TableDeclaration::of::<ycoding_store::resources::SequenceTable>(),
        TableDeclaration::of::<ycoding_store::resources::ContinuationGenerationTable>(),
        TableDeclaration::of::<ycoding_store::resources::ContinuationTable>(),
        TableDeclaration::of::<ycoding_store::resources::StateBlobTable>(),
        TableDeclaration::of::<ycoding_store::resources::StateLinkTable>(),
        TableDeclaration::of::<ycoding_store::resources::RequestTable>(),
        TableDeclaration::of::<ycoding_store::resources::UsageTable>(),
        TableDeclaration::of::<ycoding_store::resources::LatencyTable>(),
        TableDeclaration::of::<ycoding_store::analytics::DeliveryTable>(),
        TableDeclaration::of::<ycoding_store::analytics::IntentTable>(),
    ],
);

fn root() -> project::Project {
    project::Project {
        id: "p".into(),
        worktree: "/p".into(),
        vcs: None,
        name: None,
        icon_url: None,
        icon_url_override: None,
        icon_color: None,
        time_created: 0,
        time_updated: 0,
        time_initialized: None,
        sandboxes: vec![],
        commands: None,
    }
}
fn record(id: &str) -> session::Session {
    session::Session {
        id: id.into(),
        project_id: "p".into(),
        workspace_id: None,
        parent_id: None,
        fork_session_id: None,
        fork_message_id: None,
        fork_seq: None,
        directory: "".into(),
        path: None,
        title: LosslessString::from_utf16(vec![0, 0xd800]),
        cost: -0.0,
        tokens_input: -1,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        revert: None,
        permission: None,
        autonomy: None,
        autonomy_revision: 0,
        orchestration_revision: 0,
        agent: None,
        model: None,
        profile_binding: None,
        daybreak: None,
        time_created: i64::MIN,
        time_updated: i64::MAX,
        time_archived: None,
        time_active: None,
        time_pinned: None,
        time_suspended: None,
    }
}
fn store() -> Store {
    let store = Store::disposable(Options::core(), CATALOG, Metadata::new([2; 16], 1)).unwrap();
    store
        .submit(|tx| project::ProjectTable::put(tx, &root()))
        .unwrap()
        .wait()
        .unwrap();
    store
}

#[test]
fn session_reference_indexes_and_nullable_membership() {
    let store = store();
    store
        .submit(|tx| {
            session::SessionTable::put(tx, &record("s"))?;
            session::SessionTable::put(
                tx,
                &session::Session {
                    time_suspended: Some(-1),
                    ..record("t")
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    assert_eq!(
        snapshot
            .index::<session::SessionTable>(
                "session_project_idx",
                &tuple_key(&[KeyPart::String(&"p".into())]),
                None,
                4
            )
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        snapshot
            .index::<session::SessionTable>(
                "session_workspace_idx",
                &tuple_key(&[KeyPart::Null]),
                None,
                4
            )
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        snapshot
            .index::<session::SessionTable>(
                "session_parent_idx",
                &tuple_key(&[KeyPart::Null]),
                None,
                4
            )
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        snapshot
            .index::<session::SessionTable>(
                "session_time_suspended_idx",
                &tuple_key(&[KeyPart::Null]),
                None,
                4
            )
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        snapshot
            .index::<session::SessionTable>(
                "session_time_suspended_idx",
                &tuple_key(&[KeyPart::I64(-1)]),
                None,
                4
            )
            .unwrap()
            .len(),
        1
    );
}

fn message(id: &str, seq: i64) -> session::Message {
    session::Message {
        id: id.into(),
        session_id: "s".into(),
        type_: "synthetic".into(),
        seq,
        time_created: seq,
        time_updated: seq,
        data: ycoding_schema::parse_json("{\"text\":\"hi\"}").unwrap(),
    }
}

#[test]
fn session_delete_cascades_messages_but_not_nonreferences() {
    let store = store();
    store
        .submit(|tx| {
            session::SessionTable::put(tx, &record("s"))?;
            session::SessionTable::put(
                tx,
                &session::Session {
                    parent_id: Some("s".into()),
                    ..record("child")
                },
            )?;
            session::MessageTable::put(tx, &message("m", 0))?;
            session::SequenceTable::put(
                tx,
                &session::Sequence {
                    aggregate_id: "s".into(),
                    seq: 0,
                    owner_id: None,
                },
            )?;
            session::InstructionBlobTable::put(
                tx,
                &session::InstructionBlob {
                    hash: "hash".into(),
                    value: None,
                },
            )?;
            session::delete(tx, &"s".into())?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    assert!(
        snapshot
            .get::<session::MessageTable>(&session::MessageTable::primary_key(&message("m", 0)))
            .unwrap()
            .is_none()
    );
    assert!(
        snapshot
            .get::<session::SessionTable>(&tuple_key(&[KeyPart::String(&"child".into())]))
            .unwrap()
            .is_some()
    );
    assert!(
        snapshot
            .get::<session::SequenceTable>(&tuple_key(&[KeyPart::String(&"s".into())]))
            .unwrap()
            .is_some()
    );
    assert!(
        snapshot
            .get::<session::InstructionBlobTable>(&tuple_key(&[KeyPart::String(&"hash".into())]))
            .unwrap()
            .is_some()
    );
}

fn k(parts: &[KeyPart<'_>]) -> Vec<u8> {
    tuple_key(parts)
}
fn s(value: &str) -> Vec<u8> {
    k(&[KeyPart::String(&value.into())])
}
fn hash() -> LosslessString {
    "a".repeat(64).into()
}
fn json() -> session::Document<ycoding_schema::domain::Json> {
    session::Document::new(
        ycoding_schema::parse_json("{\"odd\\ud800\": [null, true, false, -0, \"\\udfff\\u0000\"]}")
            .unwrap(),
    )
    .unwrap()
}
fn manifest() -> session::Manifest {
    session::Manifest {
        digest: hash(),
        schema_version: 1,
        content: json(),
        input_tokens: 0,
        retained_tokens: 2,
        time_created: 0,
    }
}
fn revision(n: i64) -> session::Revision {
    session::Revision {
        session_id: "s".into(),
        revision: n,
        parent_revision: (n > 0).then_some(n - 1),
        manifest_digest: None,
        covered_through_message_id: None,
        covered_through_seq: None,
        activation_event_id: None,
        activation_sequence: None,
        time_created: 0,
    }
}
fn context() -> session::ContextState {
    session::ContextState {
        session_id: "s".into(),
        status: "active".into(),
        revision: 0,
        manifest_digest: Some(hash()),
        covered_through_message_id: None,
        covered_through_seq: None,
        activated_event_id: None,
        time_activated: None,
        error_code: None,
    }
}
fn exclusion() -> session::Exclusion {
    session::Exclusion {
        session_id: "s".into(),
        context_revision: 0,
        target_key: "b".repeat(64).into(),
        target_kind: "message".into(),
        target_selector: json(),
        dependency_group: None,
        reason: "exact_duplicate".into(),
        manifest_digest: hash(),
    }
}
fn job() -> session::Job {
    session::Job {
        id: "cmp_one".into(),
        session_id: "s".into(),
        legacy_input_id: None,
        trigger: "manual".into(),
        requested_through_message_id: "m".into(),
        requested_through_seq: 0,
        base_context_revision: 0,
        target_max_input_tokens: Some(0),
        config_digest: Some(hash()),
        status: "pending".into(),
        lease_owner: None,
        lease_expires_at: None,
        attempts: 0,
        manifest_digest: None,
        error_code: None,
        error_message: None,
        time_created: 0,
        time_started: None,
        time_ended: None,
    }
}
fn task(id: &str) -> session::Task {
    session::Task {
        session_id: id.into(),
        parent_id: "s".into(),
        parent_assistant_message_id: "assistant".into(),
        tool_call_id: "call".into(),
        input_id: "input".into(),
        description: "child".into(),
        agent: "default".into(),
        model: session::Document::new(
            ycoding_schema::parse_json("{\"providerID\":\"test\",\"id\":\"test\"}").unwrap(),
        )
        .unwrap(),
        prompt_digest: hash(),
        background: 2,
        delivery: "steer".into(),
        state: "starting".into(),
        progress: None,
        progress_time: None,
        question_id: None,
        question: None,
        question_data: Some(json()),
        question_time: None,
        attempt_started: -1,
        revision: 0,
        time_created: i64::MIN,
        time_updated: i64::MAX,
    }
}
fn notification(id: &str) -> session::Notification {
    session::Notification {
        id: id.into(),
        task_session_id: "child".into(),
        parent_id: "s".into(),
        type_: "completed".into(),
        revision: 0,
        excerpt: None,
        delivered: 0,
        time_created: -1,
        time_delivered: None,
    }
}
fn input(id: &str, seq: i64) -> session::Pending {
    session::Pending {
        id: id.into(),
        session_id: "s".into(),
        type_: "synthetic".into(),
        data: ycoding_schema::parse_json("{\"text\":\"hi\"}").unwrap(),
        delivery: Some("steer".into()),
        admitted_seq: seq,
        time_created: 0,
    }
}
fn event(id: &str) -> session::NewEvent {
    session::NewEvent {
        id: id.into(),
        aggregate_id: "s".into(),
        created: -1,
        type_: "session.input.admitted.1".into(),
        data: ycoding_schema::parse_json("{\"a\":1,\"b\":2}").unwrap(),
    }
}

trait Insert: TableSpec {
    fn insert(tx: &mut ycoding_store::Write<'_>, record: &Self::Record) -> Result<(), Error>;
}
macro_rules! inserts {
    ($($table:ty),*) => {$(impl Insert for $table {
        fn insert(tx: &mut ycoding_store::Write<'_>, record: &Self::Record) -> Result<(), Error> { <$table>::insert(tx,record) }
    })*};
}
inserts!(
    session::SequenceTable,
    session::EventTable,
    session::SessionTable,
    session::MessageTable,
    session::PendingTable,
    session::TodoTable,
    session::TodoStateTable,
    session::FileChangeTable,
    session::TaskTable,
    session::NotificationTable,
    session::ManifestTable,
    session::RevisionTable,
    session::ContextStateTable,
    session::ExclusionTable,
    session::JobTable,
    session::InstructionEntryTable,
    session::InstructionBlobTable,
    session::InstructionStateTable
);

fn contract<T: Insert>(record: T::Record, primary: Vec<u8>, keys: &[(&str, Option<Vec<u8>>)])
where
    T::Record: Clone + PartialEq + std::fmt::Debug + Send + 'static,
{
    assert_eq!(T::primary_key(&record), primary);
    assert_eq!(T::decode(&T::encode(&record).unwrap()).unwrap(), record);
    assert!(T::decode(&T::encode(&record).unwrap()[..1]).is_err());
    let mut bytes = T::encode(&record).unwrap();
    bytes.push(0);
    assert!(T::decode(&bytes).is_err());
    let catalog = Catalog::new(
        1,
        Box::leak(vec![TableDeclaration::of::<T>()].into_boxed_slice()),
    );
    for durable in [false, true] {
        let path = std::env::temp_dir().join(format!(
            "ycoding-table-{}-{}-{}.redb",
            T::NAME,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = if durable {
            Store::initialize(&path, Options::core(), catalog, Metadata::new([3; 16], 1)).unwrap()
        } else {
            Store::disposable(Options::core(), catalog, Metadata::new([3; 16], 1)).unwrap()
        };
        let put = record.clone();
        store
            .submit(move |tx| tx.put::<T>(&put))
            .unwrap()
            .wait()
            .unwrap();
        let store = if durable {
            store.shutdown().unwrap();
            Store::open(&path, Options::core(), catalog).unwrap()
        } else {
            store
        };
        let duplicate = record.clone();
        assert!(
            matches!(
                store
                    .submit(move |tx| T::insert(tx, &duplicate))
                    .unwrap()
                    .wait(),
                Err(Error::Domain {
                    kind: "primary_key",
                    ..
                })
            ),
            "{}",
            T::NAME
        );
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.get::<T>(&primary).unwrap(), Some(record.clone()));
        assert_eq!(T::INDEXES.len(), keys.len());
        for (name, key) in keys {
            let rows = snapshot
                .index::<T>(name, key.as_deref().unwrap_or(&[0]), None, 2)
                .unwrap();
            assert_eq!(
                rows,
                if key.is_some() {
                    vec![record.clone()]
                } else {
                    vec![]
                },
                "{name}"
            );
            assert!(
                snapshot
                    .index::<T>(name, &k(&[KeyPart::Bytes(b"absent")]), None, 1)
                    .unwrap()
                    .is_empty()
            );
            if let Some(key) = key {
                assert!(
                    snapshot
                        .index::<T>(name, key, Some(&primary), 1)
                        .unwrap()
                        .is_empty()
                );
                assert!(snapshot.index::<T>(name, key, None, 0).unwrap().is_empty());
            }
        }
        let deleted = primary.clone();
        store
            .submit(move |tx| tx.delete::<T>(&deleted))
            .unwrap()
            .wait()
            .unwrap();
        assert_eq!(snapshot.get::<T>(&primary).unwrap(), Some(record.clone()));
        let fresh = store.snapshot().unwrap();
        assert!(fresh.get::<T>(&primary).unwrap().is_none());
        for (name, key) in keys.iter().filter(|(_, key)| key.is_some()) {
            assert!(
                fresh
                    .index::<T>(name, key.as_deref().unwrap(), None, 1)
                    .unwrap()
                    .is_empty()
            );
        }
        drop(snapshot);
        drop(fresh);
        store.shutdown().unwrap();
        if durable {
            std::fs::remove_file(path).unwrap();
        }
    }
}

#[test]
fn every_session_primary_codec_and_named_index_matches_baseline() {
    contract::<session::SessionTable>(
        record("s"),
        s("s"),
        &[
            ("session_project_idx", Some(s("p"))),
            ("session_workspace_idx", Some(k(&[KeyPart::Null]))),
            ("session_parent_idx", Some(k(&[KeyPart::Null]))),
            ("session_time_suspended_idx", None),
        ],
    );
    contract::<session::SequenceTable>(
        session::Sequence {
            aggregate_id: "s".into(),
            seq: -1,
            owner_id: Some(LosslessString::from_utf16(vec![0xd800])),
        },
        s("s"),
        &[],
    );
    contract::<session::EventTable>(
        session::Event {
            id: "e".into(),
            aggregate_id: "s".into(),
            seq: -1,
            created: i64::MIN,
            type_: "kind.1".into(),
            data: json().value().clone(),
        },
        s("e"),
        &[
            (
                "event_aggregate_seq_idx",
                Some(k(&[KeyPart::String(&"s".into()), KeyPart::I64(-1)])),
            ),
            (
                "event_aggregate_type_seq_idx",
                Some(k(&[
                    KeyPart::String(&"s".into()),
                    KeyPart::String(&"kind.1".into()),
                    KeyPart::I64(-1),
                ])),
            ),
        ],
    );
    contract::<session::MessageTable>(
        message("m", -1),
        s("m"),
        &[
            (
                "session_message_session_seq_idx",
                Some(k(&[KeyPart::String(&"s".into()), KeyPart::I64(-1)])),
            ),
            (
                "session_message_session_type_seq_idx",
                Some(k(&[
                    KeyPart::String(&"s".into()),
                    KeyPart::String(&"synthetic".into()),
                    KeyPart::I64(-1),
                ])),
            ),
            (
                "session_message_session_time_created_id_idx",
                Some(k(&[
                    KeyPart::String(&"s".into()),
                    KeyPart::I64(-1),
                    KeyPart::String(&"m".into()),
                ])),
            ),
            (
                "session_message_time_created_idx",
                Some(k(&[KeyPart::I64(-1)])),
            ),
        ],
    );
    contract::<session::PendingTable>(
        session::Pending {
            delivery: None,
            ..input("i", -1)
        },
        s("i"),
        &[
            (
                "session_pending_session_delivery_seq_idx",
                Some(k(&[
                    KeyPart::String(&"s".into()),
                    KeyPart::Null,
                    KeyPart::I64(-1),
                ])),
            ),
            (
                "session_pending_session_admitted_seq_idx",
                Some(k(&[KeyPart::String(&"s".into()), KeyPart::I64(-1)])),
            ),
        ],
    );
    contract::<session::TodoTable>(
        session::Todo {
            session_id: "s".into(),
            content: LosslessString::from_utf16(vec![0xdc00]),
            status: "pending".into(),
            priority: "high".into(),
            position: -1,
            time_created: i64::MIN,
            time_updated: i64::MAX,
        },
        k(&[KeyPart::String(&"s".into()), KeyPart::I64(-1)]),
        &[("session_todo_session_idx", Some(s("s")))],
    );
    contract::<session::TodoStateTable>(
        session::TodoState {
            session_id: "s".into(),
            revision: 0,
            digest: hash(),
            time_updated: 0,
        },
        s("s"),
        &[],
    );
    contract::<session::FileChangeTable>(
        session::FileChange {
            session_id: "s".into(),
            path: "x".into(),
            patch: LosslessString::from_utf16(vec![0, 0xd800]),
            additions: -1,
            deletions: i64::MAX,
            latest_seq: -1,
        },
        k(&[KeyPart::String(&"s".into()), KeyPart::String(&"x".into())]),
        &[(
            "session_file_change_path_session_idx",
            Some(k(&[
                KeyPart::String(&"x".into()),
                KeyPart::String(&"s".into()),
            ])),
        )],
    );
    contract::<session::TaskTable>(
        task("child"),
        s("child"),
        &[
            ("sqlite_autoindex_session_task_2", Some(s("input"))),
            (
                "session_task_launch_identity_idx",
                Some(k(&[
                    KeyPart::String(&"s".into()),
                    KeyPart::String(&"assistant".into()),
                    KeyPart::String(&"call".into()),
                ])),
            ),
            (
                "session_task_parent_state_updated_idx",
                Some(k(&[
                    KeyPart::String(&"s".into()),
                    KeyPart::String(&"starting".into()),
                    KeyPart::I64(i64::MAX),
                ])),
            ),
        ],
    );
    contract::<session::NotificationTable>(
        notification("n"),
        s("n"),
        &[
            (
                "session_task_notification_transition_idx",
                Some(k(&[
                    KeyPart::String(&"child".into()),
                    KeyPart::String(&"completed".into()),
                    KeyPart::I64(0),
                ])),
            ),
            (
                "session_task_notification_delivery_idx",
                Some(k(&[
                    KeyPart::I64(0),
                    KeyPart::I64(-1),
                    KeyPart::String(&"n".into()),
                ])),
            ),
        ],
    );
    contract::<session::ManifestTable>(manifest(), s(&"a".repeat(64)), &[]);
    contract::<session::RevisionTable>(
        revision(0),
        k(&[KeyPart::String(&"s".into()), KeyPart::I64(0)]),
        &[],
    );
    contract::<session::ContextStateTable>(context(), s("s"), &[]);
    contract::<session::ExclusionTable>(
        exclusion(),
        k(&[
            KeyPart::String(&"s".into()),
            KeyPart::I64(0),
            KeyPart::String(&"b".repeat(64).into()),
        ]),
        &[
            (
                "session_context_exclusion_current_target_idx",
                Some(k(&[
                    KeyPart::String(&"s".into()),
                    KeyPart::String(&"b".repeat(64).into()),
                ])),
            ),
            (
                "session_context_exclusion_manifest_idx",
                Some(s(&"a".repeat(64))),
            ),
        ],
    );
    contract::<session::JobTable>(
        job(),
        s("cmp_one"),
        &[
            (
                "session_compaction_job_pending_revision_idx",
                Some(k(&[KeyPart::String(&"s".into()), KeyPart::I64(0)])),
            ),
            ("session_compaction_job_legacy_input_idx", None),
            (
                "session_compaction_job_recovery_idx",
                Some(k(&[
                    KeyPart::String(&"pending".into()),
                    KeyPart::Null,
                    KeyPart::String(&"s".into()),
                ])),
            ),
            (
                "session_compaction_job_manifest_idx",
                Some(k(&[KeyPart::Null])),
            ),
        ],
    );
    contract::<session::InstructionEntryTable>(
        session::InstructionEntry {
            session_id: "s".into(),
            key: "k".into(),
            value: Some(json()),
            removed: 2,
            time_created: -1,
            time_updated: i64::MAX,
        },
        k(&[KeyPart::String(&"s".into()), KeyPart::String(&"k".into())]),
        &[],
    );
    contract::<session::InstructionBlobTable>(
        session::InstructionBlob {
            hash: "hash".into(),
            value: None,
        },
        s("hash"),
        &[],
    );
    contract::<session::InstructionStateTable>(
        session::InstructionState {
            session_id: "s".into(),
            epoch_start: -1,
            through_seq: i64::MAX,
            initial_values: session::Document::new(ycoding_schema::parse_json("{}").unwrap())
                .unwrap(),
            current_values: session::Document::new(ycoding_schema::parse_json("{}").unwrap())
                .unwrap(),
        },
        s("s"),
        &[],
    );
}

fn collision<T: TableSpec>(first: T::Record, second: T::Record, index: &'static str)
where
    T::Record: Send + 'static,
{
    let first_key = T::primary_key(&first);
    let second_key = T::primary_key(&second);
    let store = Store::disposable(
        Options::core(),
        Catalog::new(
            1,
            Box::leak(vec![TableDeclaration::of::<T>()].into_boxed_slice()),
        ),
        Metadata::new([4; 16], 1),
    )
    .unwrap();
    store
        .submit(move |tx| tx.put::<T>(&first))
        .unwrap()
        .wait()
        .unwrap();
    let failed = store.submit(move |tx| tx.put::<T>(&second)).unwrap().wait();
    assert!(
        matches!(failed,Err(Error::UniqueViolation{index:got}) if got==index),
        "{index}"
    );
    let snapshot = store.snapshot().unwrap();
    assert!(snapshot.get::<T>(&first_key).unwrap().is_some());
    assert!(snapshot.get::<T>(&second_key).unwrap().is_none());
}

#[test]
fn every_unique_index_rejects_a_second_primary_owner() {
    collision::<session::EventTable>(
        session::Event {
            id: "a".into(),
            aggregate_id: "s".into(),
            seq: 0,
            created: 0,
            type_: "kind".into(),
            data: json().value().clone(),
        },
        session::Event {
            id: "b".into(),
            aggregate_id: "s".into(),
            seq: 0,
            created: 0,
            type_: "other".into(),
            data: json().value().clone(),
        },
        "event_aggregate_seq_idx",
    );
    collision::<session::MessageTable>(
        message("a", 0),
        message("b", 0),
        "session_message_session_seq_idx",
    );
    collision::<session::PendingTable>(
        input("a", 0),
        input("b", 0),
        "session_pending_session_admitted_seq_idx",
    );
    collision::<session::TaskTable>(
        task("one"),
        session::Task {
            input_id: "different".into(),
            ..task("two")
        },
        "session_task_launch_identity_idx",
    );
    collision::<session::TaskTable>(
        task("one"),
        session::Task {
            tool_call_id: "different".into(),
            ..task("two")
        },
        "sqlite_autoindex_session_task_2",
    );
    collision::<session::NotificationTable>(
        notification("one"),
        notification("two"),
        "session_task_notification_transition_idx",
    );
    collision::<session::JobTable>(
        job(),
        session::Job {
            id: "cmp_two".into(),
            ..job()
        },
        "session_compaction_job_pending_revision_idx",
    );
    collision::<session::JobTable>(
        session::Job {
            legacy_input_id: Some("legacy".into()),
            ..job()
        },
        session::Job {
            id: "cmp_two".into(),
            base_context_revision: 1,
            legacy_input_id: Some("legacy".into()),
            ..job()
        },
        "session_compaction_job_legacy_input_idx",
    );
    collision::<session::ExclusionTable>(
        exclusion(),
        session::Exclusion {
            context_revision: 1,
            ..exclusion()
        },
        "session_context_exclusion_current_target_idx",
    );
}

#[test]
fn partial_job_indexes_exclude_terminal_jobs_and_null_legacy_inputs() {
    let store = store();
    store
        .submit(|tx| {
            session::SessionTable::put(tx, &record("s"))?;
            session::RevisionTable::put(tx, &revision(0))?;
            session::JobTable::put(tx, &job())?;
            let terminal = session::Job {
                status: "failed".into(),
                error_code: Some("failed".into()),
                time_ended: Some(0),
                ..job()
            };
            session::JobTable::put(tx, &terminal)?;
            session::JobTable::put(
                tx,
                &session::Job {
                    id: "cmp_two".into(),
                    ..terminal
                },
            )?;
            session::JobTable::put(
                tx,
                &session::Job {
                    id: "cmp_three".into(),
                    ..job()
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    assert_eq!(
        snapshot
            .index::<session::JobTable>(
                "session_compaction_job_pending_revision_idx",
                &k(&[KeyPart::String(&"s".into()), KeyPart::I64(0)]),
                None,
                5
            )
            .unwrap()
            .len(),
        1
    );
    assert!(
        snapshot
            .index::<session::JobTable>(
                "session_compaction_job_legacy_input_idx",
                &k(&[KeyPart::Null]),
                None,
                5
            )
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        snapshot
            .index::<session::JobTable>(
                "session_compaction_job_manifest_idx",
                &k(&[KeyPart::Null]),
                None,
                5
            )
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn message_windows_and_delivery_windows_order_signed_keys_and_page_both_directions() {
    let store = store();
    store
        .submit(|tx| {
            session::SessionTable::put(tx, &record("s"))?;
            session::SessionTable::put(tx, &record("other"))?;
            for (i, seq) in [i64::MIN, -1, 0, 1, i64::MAX].into_iter().enumerate() {
                session::MessageTable::put(tx, &message(&format!("m{i}"), seq))?;
                session::PendingTable::put(tx, &input(&format!("i{i}"), seq))?;
            }
            session::MessageTable::put(
                tx,
                &session::Message {
                    session_id: "other".into(),
                    ..message("foreign", -1)
                },
            )?;
            session::PendingTable::put(
                tx,
                &session::Pending {
                    delivery: Some("queue".into()),
                    ..input("queue", 2)
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    let first = session::messages(
        &snapshot,
        &"s".into(),
        Bound::Unbounded,
        Bound::Unbounded,
        IndexOrder::Descending,
        None,
        2,
    )
    .unwrap();
    assert_eq!(
        first.iter().map(|r| r.record.seq).collect::<Vec<_>>(),
        vec![i64::MAX, 1]
    );
    let second = session::messages(
        &snapshot,
        &"s".into(),
        Bound::Unbounded,
        Bound::Unbounded,
        IndexOrder::Descending,
        Some(&first.last().unwrap().cursor),
        3,
    )
    .unwrap();
    assert_eq!(
        second.iter().map(|r| r.record.seq).collect::<Vec<_>>(),
        vec![0, -1, i64::MIN]
    );
    assert_eq!(
        session::messages(
            &snapshot,
            &"s".into(),
            Bound::Excluded(-1),
            Bound::Included(1),
            IndexOrder::Ascending,
            None,
            5
        )
        .unwrap()
        .iter()
        .map(|r| r.record.seq)
        .collect::<Vec<_>>(),
        vec![0, 1]
    );
    let first = session::pending(&snapshot, &"s".into(), Some(&"steer".into()), None, 2).unwrap();
    assert_eq!(
        first
            .iter()
            .map(|r| r.record.admitted_seq)
            .collect::<Vec<_>>(),
        vec![i64::MIN, -1]
    );
    assert_eq!(
        session::pending(&snapshot, &"s".into(), Some(&"queue".into()), None, 2)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        session::pending(
            &snapshot,
            &"s".into(),
            Some(&"steer".into()),
            Some(&first.last().unwrap().cursor),
            5
        )
        .unwrap()
        .len(),
        3
    );
    let rows = snapshot
        .index_range::<session::MessageTable>(
            "session_message_time_created_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: None,
                order: IndexOrder::Ascending,
                after: None,
                limit: 10,
            },
        )
        .unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| r.record.time_created)
            .collect::<Vec<_>>(),
        vec![i64::MIN, -1, -1, 0, 1, i64::MAX]
    );
}

#[test]
fn append_admission_promotion_and_watermark_commit_or_rollback_together() {
    let store = store();
    let (_, snapshot) = store
        .submit_with_snapshot(|tx| {
            session::SessionTable::put(tx, &record("s"))?;
            assert!(matches!(
                session::append(tx, &event("e0"), None)?,
                session::Append::Appended(session::Event { seq: 0, .. })
            ));
            assert!(matches!(
                session::admit(tx, &input("m", 0))?,
                session::Admission::Pending(_)
            ));
            assert_eq!(session::promote(tx, &message("m", 1))?.admitted_seq, 0);
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(session::latest_sequence(&snapshot, &"s".into()).unwrap(), 0);
    assert!(
        snapshot
            .get::<session::PendingTable>(&s("m"))
            .unwrap()
            .is_none()
    );
    assert_eq!(
        session::messages(
            &snapshot,
            &"s".into(),
            Bound::Unbounded,
            Bound::Unbounded,
            IndexOrder::Descending,
            None,
            1
        )
        .unwrap()[0]
            .record
            .id,
        LosslessString::from("m")
    );
    let failed = store
        .submit(|tx| {
            session::append(tx, &event("e1"), None)?;
            let _ = session::promote(tx, &message("missing", 2));
            session::TodoTable::put(
                tx,
                &session::Todo {
                    session_id: "s".into(),
                    content: "discard".into(),
                    status: "pending".into(),
                    priority: "high".into(),
                    position: 0,
                    time_created: 0,
                    time_updated: 0,
                },
            )?;
            Ok(())
        })
        .unwrap()
        .wait();
    assert!(matches!(
        failed,
        Err(Error::Domain {
            kind: "input_lifecycle",
            ..
        })
    ));
    let fresh = store.snapshot().unwrap();
    assert_eq!(session::latest_sequence(&fresh, &"s".into()).unwrap(), 0);
    assert!(
        fresh
            .get::<session::EventTable>(&s("e1"))
            .unwrap()
            .is_none()
    );
    assert!(
        fresh
            .scan::<session::TodoTable>(Bound::Unbounded, Bound::Unbounded, 1)
            .unwrap()
            .is_empty()
    );
    store
        .submit(|tx| session::append(tx, &event("e1"), None))
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(session::latest_sequence(&snapshot, &"s".into()).unwrap(), 0);
    assert_eq!(
        session::latest_sequence(&store.snapshot().unwrap(), &"s".into()).unwrap(),
        1
    );
}

#[test]
fn event_replay_identity_owner_reservation_and_aggregate_cascade() {
    let store = store();
    assert_eq!(
        session::latest_sequence(&store.snapshot().unwrap(), &"s".into()).unwrap(),
        -1
    );
    store
        .submit(|tx| {
            session::append(
                tx,
                &event("e0"),
                Some(&session::Replay {
                    seq: 0,
                    owner_id: Some("owner".into()),
                    strict_owner: false,
                }),
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    store
        .submit(|tx| {
            let reordered = session::NewEvent {
                data: ycoding_schema::parse_json("{\"b\":2,\"a\":1}").unwrap(),
                ..event("e0")
            };
            assert!(matches!(
                session::append(
                    tx,
                    &reordered,
                    Some(&session::Replay {
                        seq: 0,
                        owner_id: Some("owner".into()),
                        strict_owner: true
                    })
                )?,
                session::Append::Replayed(_)
            ));
            assert_eq!(
                session::append(
                    tx,
                    &event("ignored"),
                    Some(&session::Replay {
                        seq: 1,
                        owner_id: Some("other".into()),
                        strict_owner: false
                    })
                )?,
                session::Append::Ignored
            );
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    for (kind, ev, replay) in [
        (
            "replay_owner",
            event("e0"),
            session::Replay {
                seq: 0,
                owner_id: Some("other".into()),
                strict_owner: true,
            },
        ),
        (
            "replay_diverged",
            event("changed"),
            session::Replay {
                seq: 0,
                owner_id: Some("owner".into()),
                strict_owner: false,
            },
        ),
        (
            "sequence_mismatch",
            event("gap"),
            session::Replay {
                seq: 2,
                owner_id: Some("owner".into()),
                strict_owner: false,
            },
        ),
    ] {
        let failed = store
            .submit(move |tx| session::append(tx, &ev, Some(&replay)))
            .unwrap()
            .wait();
        assert!(matches!(failed,Err(Error::Domain{kind:got,..}) if got==kind));
    }
    let failed = store
        .submit(|tx| session::append(tx, &event("e0"), None))
        .unwrap()
        .wait();
    assert!(matches!(
        failed,
        Err(Error::Domain {
            kind: "event_identity",
            ..
        })
    ));
    store
        .submit(|tx| {
            session::reserve_sequence(tx, &"s".into(), 10)?;
            session::reserve_sequence(tx, &"s".into(), -1)?;
            session::claim_sequence(tx, &"s".into(), &"new".into())
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(
        session::latest_sequence(&store.snapshot().unwrap(), &"s".into()).unwrap(),
        10
    );
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .get::<session::SequenceTable>(&s("s"))
            .unwrap()
            .unwrap()
            .owner_id,
        Some("new".into())
    );
    store
        .submit(|tx| session::reserve_sequence(tx, &"overflow".into(), i64::MAX))
        .unwrap()
        .wait()
        .unwrap();
    let failed = store
        .submit(|tx| {
            session::append(
                tx,
                &session::NewEvent {
                    aggregate_id: "overflow".into(),
                    ..event("overflow")
                },
                None,
            )
        })
        .unwrap()
        .wait();
    assert!(matches!(
        failed,
        Err(Error::Domain {
            kind: "sequence_overflow",
            ..
        })
    ));
    let old = store.snapshot().unwrap();
    store
        .submit(|tx| session::delete_aggregate(tx, &"s".into()))
        .unwrap()
        .wait()
        .unwrap();
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<session::EventTable>(&s("e0"))
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<session::SequenceTable>(&s("s"))
            .unwrap()
            .is_none()
    );
    assert!(old.get::<session::EventTable>(&s("e0")).unwrap().is_some());
}

#[test]
fn first_admission_wins_and_promotion_rejects_wrong_identity_or_compaction() {
    let store = store();
    store
        .submit(|tx| {
            session::SessionTable::put(tx, &record("s"))?;
            session::SessionTable::put(tx, &record("other"))?;
            session::admit(tx, &input("i", 0))?;
            let retry = session::Pending {
                admitted_seq: 10,
                data: ycoding_schema::parse_json("{\"text\":\"changed\"}").unwrap(),
                ..input("i", 0)
            };
            assert_eq!(
                session::admit(tx, &retry)?,
                session::Admission::Pending(input("i", 0))
            );
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    for pending in [
        session::Pending {
            session_id: "other".into(),
            ..input("i", 0)
        },
        session::Pending {
            type_: "user".into(),
            ..input("i", 0)
        },
    ] {
        assert!(matches!(
            store
                .submit(move |tx| session::admit(tx, &pending))
                .unwrap()
                .wait(),
            Err(Error::Domain {
                kind: "input_identity",
                ..
            })
        ));
    }
    assert!(matches!(
        store
            .submit(|tx| session::promote(
                tx,
                &session::Message {
                    session_id: "other".into(),
                    ..message("i", 1)
                }
            ))
            .unwrap()
            .wait(),
        Err(Error::Domain {
            kind: "input_lifecycle",
            ..
        })
    ));
    store
        .submit(|tx| {
            session::PendingTable::put(
                tx,
                &session::Pending {
                    type_: "compaction".into(),
                    delivery: None,
                    ..input("compaction", 2)
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(matches!(
        store
            .submit(|tx| session::promote(tx, &message("i", 1)))
            .unwrap()
            .wait(),
        Err(Error::Domain {
            kind: "input_lifecycle",
            ..
        })
    ));
    store
        .submit(|tx| {
            tx.delete::<session::PendingTable>(&s("compaction"))?;
            session::promote(tx, &message("i", 1))?;
            assert!(matches!(
                session::admit(tx, &input("i", 0))?,
                session::Admission::Promoted(_)
            ));
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(matches!(
        store
            .submit(|tx| session::promote(tx, &message("i", 1)))
            .unwrap()
            .wait(),
        Err(Error::Domain {
            kind: "input_lifecycle",
            ..
        })
    ));
    assert!(
        session::Pending {
            session_id: "ses_valid".into(),
            ..input("msg_valid", 0)
        }
        .info()
        .is_ok()
    );
    assert!(
        session::Pending {
            delivery: None,
            ..input("msg_valid", 0)
        }
        .info()
        .is_err()
    );
    let valid = session::Message {
        id: "msg_valid".into(),
        data: ycoding_schema::parse_json("{\"text\":\"hi\",\"time\":{\"created\":0}}").unwrap(),
        ..message("msg_valid", 0)
    };
    assert!(valid.info().is_ok());
}

fn foreign<T: TableSpec>(
    store: &Store,
    record: T::Record,
    put: fn(&mut ycoding_store::Write<'_>, &T::Record) -> Result<(), Error>,
) where
    T::Record: Send + 'static,
{
    let failed = store.submit(move |tx| put(tx, &record)).unwrap().wait();
    assert!(
        matches!(
            failed,
            Err(Error::Domain {
                kind: "foreign_reference",
                ..
            })
        ),
        "{}",
        T::NAME
    );
}

#[test]
fn every_session_foreign_reference_is_checked_in_the_write_view() {
    let store = store();
    foreign::<session::SessionTable>(
        &store,
        session::Session {
            project_id: "missing".into(),
            ..record("s")
        },
        session::SessionTable::put,
    );
    foreign::<session::EventTable>(
        &store,
        session::Event {
            id: "e".into(),
            aggregate_id: "s".into(),
            seq: 0,
            created: 0,
            type_: "kind".into(),
            data: json().value().clone(),
        },
        session::EventTable::put,
    );
    foreign::<session::MessageTable>(&store, message("m", 0), session::MessageTable::put);
    foreign::<session::PendingTable>(&store, input("i", 0), session::PendingTable::put);
    foreign::<session::TodoTable>(
        &store,
        session::Todo {
            session_id: "s".into(),
            content: "x".into(),
            status: "pending".into(),
            priority: "high".into(),
            position: 0,
            time_created: 0,
            time_updated: 0,
        },
        session::TodoTable::put,
    );
    foreign::<session::TodoStateTable>(
        &store,
        session::TodoState {
            session_id: "s".into(),
            revision: 0,
            digest: hash(),
            time_updated: 0,
        },
        session::TodoStateTable::put,
    );
    foreign::<session::FileChangeTable>(
        &store,
        session::FileChange {
            session_id: "s".into(),
            path: "x".into(),
            patch: "".into(),
            additions: 0,
            deletions: 0,
            latest_seq: 0,
        },
        session::FileChangeTable::put,
    );
    foreign::<session::TaskTable>(&store, task("child"), session::TaskTable::put);
    foreign::<session::NotificationTable>(
        &store,
        notification("n"),
        session::NotificationTable::put,
    );
    foreign::<session::RevisionTable>(&store, revision(0), session::RevisionTable::put);
    foreign::<session::ContextStateTable>(&store, context(), session::ContextStateTable::put);
    foreign::<session::ExclusionTable>(&store, exclusion(), session::ExclusionTable::put);
    foreign::<session::JobTable>(&store, job(), session::JobTable::put);
    foreign::<session::InstructionEntryTable>(
        &store,
        session::InstructionEntry {
            session_id: "s".into(),
            key: "k".into(),
            value: None,
            removed: 0,
            time_created: 0,
            time_updated: 0,
        },
        session::InstructionEntryTable::put,
    );
    foreign::<session::InstructionStateTable>(
        &store,
        session::InstructionState {
            session_id: "s".into(),
            epoch_start: 0,
            through_seq: 0,
            initial_values: session::Document::new(ycoding_schema::parse_json("{}").unwrap())
                .unwrap(),
            current_values: session::Document::new(ycoding_schema::parse_json("{}").unwrap())
                .unwrap(),
        },
        session::InstructionStateTable::put,
    );
    store
        .submit(|tx| {
            session::SessionTable::put(tx, &record("s"))?;
            session::SessionTable::put(tx, &record("child"))
        })
        .unwrap()
        .wait()
        .unwrap();
    foreign::<session::TaskTable>(
        &store,
        session::Task {
            parent_id: "missing".into(),
            ..task("child")
        },
        session::TaskTable::put,
    );
    foreign::<session::RevisionTable>(&store, revision(1), session::RevisionTable::put);
    foreign::<session::ContextStateTable>(&store, context(), session::ContextStateTable::put);
    foreign::<session::JobTable>(&store, job(), session::JobTable::put);
    foreign::<session::ExclusionTable>(&store, exclusion(), session::ExclusionTable::put);
    store
        .submit(|tx| {
            session::RevisionTable::put(tx, &revision(0))?;
            session::TaskTable::put(tx, &task("child"))
        })
        .unwrap()
        .wait()
        .unwrap();
    foreign::<session::NotificationTable>(
        &store,
        session::Notification {
            parent_id: "missing".into(),
            ..notification("n")
        },
        session::NotificationTable::put,
    );
    foreign::<session::RevisionTable>(
        &store,
        session::Revision {
            manifest_digest: Some(hash()),
            ..revision(0)
        },
        session::RevisionTable::put,
    );
    foreign::<session::ContextStateTable>(&store, context(), session::ContextStateTable::put);
    foreign::<session::ExclusionTable>(&store, exclusion(), session::ExclusionTable::put);
    foreign::<session::JobTable>(
        &store,
        session::Job {
            status: "ended".into(),
            manifest_digest: Some(hash()),
            time_started: Some(0),
            time_ended: Some(0),
            ..job()
        },
        session::JobTable::put,
    );
}

#[test]
fn manifest_restrict_counts_all_references_and_revision_cascade_preserves_null_parent_roots() {
    let store = store();
    store
        .submit(|tx| {
            session::SessionTable::put(tx, &record("s"))?;
            session::ManifestTable::put(tx, &manifest())?;
            session::RevisionTable::put(
                tx,
                &session::Revision {
                    manifest_digest: Some(hash()),
                    ..revision(0)
                },
            )?;
            session::RevisionTable::put(tx, &revision(1))?;
            session::RevisionTable::put(
                tx,
                &session::Revision {
                    parent_revision: None,
                    ..revision(2)
                },
            )?;
            session::ContextStateTable::put(tx, &context())?;
            session::ExclusionTable::put(tx, &exclusion())?;
            session::JobTable::put(
                tx,
                &session::Job {
                    status: "ended".into(),
                    manifest_digest: Some(hash()),
                    time_started: Some(0),
                    time_ended: Some(0),
                    ..job()
                },
            )?;
            assert_eq!(session::manifest_references(tx, &hash())?, 4);
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let failed = store
        .submit(|tx| {
            let _ = session::delete_manifest(tx, &hash());
            session::delete(tx, &"s".into())?;
            Ok(())
        })
        .unwrap()
        .wait();
    assert!(matches!(
        failed,
        Err(Error::Domain {
            kind: "restrict",
            ..
        })
    ));
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<session::SessionTable>(&s("s"))
            .unwrap()
            .is_some()
    );
    store
        .submit(|tx| {
            assert!(session::delete_revision(tx, &"s".into(), 0)?);
            assert_eq!(session::manifest_references(tx, &hash())?, 0);
            assert!(session::delete_manifest(tx, &hash())?);
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    assert!(
        snapshot
            .get::<session::RevisionTable>(&k(&[KeyPart::String(&"s".into()), KeyPart::I64(0)]))
            .unwrap()
            .is_none()
    );
    assert!(
        snapshot
            .get::<session::RevisionTable>(&k(&[KeyPart::String(&"s".into()), KeyPart::I64(1)]))
            .unwrap()
            .is_none()
    );
    assert!(
        snapshot
            .get::<session::RevisionTable>(&k(&[KeyPart::String(&"s".into()), KeyPart::I64(2)]))
            .unwrap()
            .is_some()
    );
    assert!(
        snapshot
            .scan::<session::JobTable>(Bound::Unbounded, Bound::Unbounded, 1)
            .unwrap()
            .is_empty()
    );
    assert!(
        snapshot
            .scan::<session::ExclusionTable>(Bound::Unbounded, Bound::Unbounded, 1)
            .unwrap()
            .is_empty()
    );
    assert!(
        snapshot
            .get::<session::ContextStateTable>(&s("s"))
            .unwrap()
            .is_none()
    );
}

#[test]
fn task_identities_lookup_and_delete_cascade_notifications_not_child_session() {
    let store = store();
    store
        .submit(|tx| {
            session::SessionTable::put(tx, &record("s"))?;
            session::SessionTable::put(tx, &record("child"))?;
            session::TaskTable::insert(tx, &task("child"))?;
            session::NotificationTable::insert(tx, &notification("n"))
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    assert!(
        session::task_by_launch(&snapshot, &"s".into(), &"assistant".into(), &"call".into())
            .unwrap()
            .is_some()
    );
    assert!(
        session::notification_by_transition(&snapshot, &"child".into(), &"completed".into(), 0)
            .unwrap()
            .is_some()
    );
    store
        .submit(|tx| session::delete(tx, &"s".into()))
        .unwrap()
        .wait()
        .unwrap();
    let fresh = store.snapshot().unwrap();
    assert!(
        fresh
            .get::<session::TaskTable>(&s("child"))
            .unwrap()
            .is_none()
    );
    assert!(
        fresh
            .get::<session::NotificationTable>(&s("n"))
            .unwrap()
            .is_none()
    );
    assert!(
        fresh
            .get::<session::SessionTable>(&s("child"))
            .unwrap()
            .is_some()
    );
    assert!(
        snapshot
            .get::<session::NotificationTable>(&s("n"))
            .unwrap()
            .is_some()
    );
}

fn check_failure<T: TableSpec>(record: T::Record, name: &'static str) {
    assert!(
        matches!(T::encode(&record),Err(Error::Domain{kind:"check",message}) if message==name),
        "{name}"
    );
}

#[test]
fn checked_tables_enforce_every_baseline_check_without_strengthening_sql_null_truth() {
    for (record, name) in [
        (
            session::Manifest {
                digest: "bad".into(),
                ..manifest()
            },
            "compaction_manifest_blob_digest_check",
        ),
        (
            session::Manifest {
                schema_version: 0,
                ..manifest()
            },
            "compaction_manifest_blob_schema_version_check",
        ),
        (
            session::Manifest {
                input_tokens: -1,
                ..manifest()
            },
            "compaction_manifest_blob_counts_check",
        ),
        (
            session::Manifest {
                retained_tokens: -1,
                ..manifest()
            },
            "compaction_manifest_blob_counts_check",
        ),
        (
            session::Manifest {
                time_created: -1,
                ..manifest()
            },
            "compaction_manifest_blob_time_check",
        ),
    ] {
        check_failure::<session::ManifestTable>(record, name);
    }
    assert!(
        session::Document::<ycoding_schema::domain::Json>::new(ycoding_schema::JsonValue::Number(
            f64::INFINITY
        ))
        .is_err()
    );
    for (record, name) in [
        (
            session::Revision {
                parent_revision: Some(0),
                ..revision(0)
            },
            "session_context_revision_lineage_check",
        ),
        (
            session::Revision {
                parent_revision: Some(1),
                ..revision(1)
            },
            "session_context_revision_lineage_check",
        ),
        (
            session::Revision {
                manifest_digest: Some("bad".into()),
                ..revision(0)
            },
            "session_context_revision_manifest_check",
        ),
        (
            session::Revision {
                covered_through_message_id: Some("m".into()),
                ..revision(0)
            },
            "session_context_revision_boundary_check",
        ),
        (
            session::Revision {
                covered_through_seq: Some(-1),
                ..revision(0)
            },
            "session_context_revision_boundary_check",
        ),
        (
            session::Revision {
                activation_event_id: Some("e".into()),
                ..revision(0)
            },
            "session_context_revision_activation_check",
        ),
        (
            session::Revision {
                time_created: -1,
                ..revision(0)
            },
            "session_context_revision_time_check",
        ),
    ] {
        check_failure::<session::RevisionTable>(record, name);
    }
    for (record, name) in [
        (
            session::ContextState {
                status: "other".into(),
                ..context()
            },
            "session_context_state_status_check",
        ),
        (
            session::ContextState {
                revision: -1,
                ..context()
            },
            "session_context_state_revision_check",
        ),
        (
            session::ContextState {
                manifest_digest: Some("bad".into()),
                ..context()
            },
            "session_context_state_manifest_check",
        ),
        (
            session::ContextState {
                covered_through_message_id: Some("".into()),
                covered_through_seq: Some(0),
                ..context()
            },
            "session_context_state_boundary_check",
        ),
        (
            session::ContextState {
                activated_event_id: Some("e".into()),
                ..context()
            },
            "session_context_state_activation_check",
        ),
        (
            session::ContextState {
                error_code: Some("bad".into()),
                ..context()
            },
            "session_context_state_error_check",
        ),
        (
            session::ContextState {
                status: "quarantined".into(),
                error_code: Some("".into()),
                ..context()
            },
            "session_context_state_error_check",
        ),
    ] {
        check_failure::<session::ContextStateTable>(record, name);
    }
    for (record, name) in [
        (
            session::Exclusion {
                target_key: "bad".into(),
                ..exclusion()
            },
            "session_context_exclusion_target_key_check",
        ),
        (
            session::Exclusion {
                target_kind: "other".into(),
                ..exclusion()
            },
            "session_context_exclusion_target_kind_check",
        ),
        (
            session::Exclusion {
                dependency_group: Some("".into()),
                ..exclusion()
            },
            "session_context_exclusion_dependency_check",
        ),
        (
            session::Exclusion {
                reason: "other".into(),
                ..exclusion()
            },
            "session_context_exclusion_reason_check",
        ),
        (
            session::Exclusion {
                manifest_digest: "bad".into(),
                ..exclusion()
            },
            "session_context_exclusion_manifest_check",
        ),
    ] {
        check_failure::<session::ExclusionTable>(record, name);
    }
    for (record, name) in [
        (
            session::Job {
                id: "cmp_".into(),
                ..job()
            },
            "session_compaction_job_id_check",
        ),
        (
            session::Job {
                legacy_input_id: Some("".into()),
                ..job()
            },
            "session_compaction_job_legacy_input_check",
        ),
        (
            session::Job {
                trigger: "other".into(),
                ..job()
            },
            "session_compaction_job_trigger_check",
        ),
        (
            session::Job {
                requested_through_message_id: "".into(),
                ..job()
            },
            "session_compaction_job_requested_message_check",
        ),
        (
            session::Job {
                requested_through_seq: -1,
                ..job()
            },
            "session_compaction_job_counts_check",
        ),
        (
            session::Job {
                base_context_revision: -1,
                ..job()
            },
            "session_compaction_job_counts_check",
        ),
        (
            session::Job {
                target_max_input_tokens: Some(-1),
                ..job()
            },
            "session_compaction_job_counts_check",
        ),
        (
            session::Job {
                attempts: -1,
                ..job()
            },
            "session_compaction_job_counts_check",
        ),
        (
            session::Job {
                config_digest: Some("bad".into()),
                ..job()
            },
            "session_compaction_job_config_digest_check",
        ),
        (
            session::Job {
                manifest_digest: Some("bad".into()),
                ..job()
            },
            "session_compaction_job_manifest_digest_check",
        ),
        (
            session::Job {
                target_max_input_tokens: None,
                ..job()
            },
            "session_compaction_job_current_input_check",
        ),
        (
            session::Job {
                config_digest: None,
                ..job()
            },
            "session_compaction_job_current_input_check",
        ),
        (
            session::Job {
                status: "other".into(),
                ..job()
            },
            "session_compaction_job_status_check",
        ),
        (
            session::Job {
                lease_owner: Some("owner".into()),
                ..job()
            },
            "session_compaction_job_lease_check",
        ),
        (
            session::Job {
                lease_expires_at: Some(-1),
                ..job()
            },
            "session_compaction_job_lease_check",
        ),
        (
            session::Job {
                time_started: Some(0),
                ..job()
            },
            "session_compaction_job_terminal_check",
        ),
        (
            session::Job {
                status: "running".into(),
                ..job()
            },
            "session_compaction_job_terminal_check",
        ),
        (
            session::Job {
                status: "ended".into(),
                ..job()
            },
            "session_compaction_job_terminal_check",
        ),
        (
            session::Job {
                status: "failed".into(),
                ..job()
            },
            "session_compaction_job_terminal_check",
        ),
        (
            session::Job {
                time_created: -1,
                ..job()
            },
            "session_compaction_job_time_check",
        ),
        (
            session::Job {
                status: "failed".into(),
                error_code: Some("bad".into()),
                time_ended: Some(-1),
                ..job()
            },
            "session_compaction_job_time_check",
        ),
    ] {
        check_failure::<session::JobTable>(record, name);
    }
    let todo = session::TodoState {
        session_id: "s".into(),
        revision: 0,
        digest: hash(),
        time_updated: 0,
    };
    check_failure::<session::TodoStateTable>(
        session::TodoState {
            revision: -1,
            ..todo.clone()
        },
        "session_todo_state_revision_check",
    );
    check_failure::<session::TodoStateTable>(
        session::TodoState {
            digest: "bad".into(),
            ..todo.clone()
        },
        "session_todo_state_digest_check",
    );
    check_failure::<session::TodoStateTable>(
        session::TodoState {
            time_updated: -1,
            ..todo
        },
        "session_todo_state_time_check",
    );
    for r in [
        session::Revision {
            parent_revision: None,
            ..revision(1)
        },
        session::Revision {
            covered_through_seq: Some(0),
            activation_sequence: Some(0),
            ..revision(0)
        },
    ] {
        assert!(session::RevisionTable::encode(&r).is_ok());
    }
    assert!(
        session::ContextStateTable::encode(&session::ContextState {
            status: "quarantined".into(),
            ..context()
        })
        .is_ok()
    );
    assert!(
        session::JobTable::encode(&session::Job {
            lease_expires_at: Some(0),
            ..job()
        })
        .is_ok()
    );
    assert!(
        session::JobTable::encode(&session::Job {
            id: LosslessString::from_utf16("cmp_".encode_utf16().chain([0xd800]).collect()),
            ..job()
        })
        .is_ok()
    );
    assert!(
        session::JobTable::encode(&session::Job {
            target_max_input_tokens: None,
            config_digest: None,
            legacy_input_id: Some("legacy".into()),
            ..job()
        })
        .is_ok()
    );
    assert!(
        session::JobTable::encode(&session::Job {
            status: "running".into(),
            lease_owner: Some("owner".into()),
            lease_expires_at: Some(0),
            time_started: Some(0),
            ..job()
        })
        .is_ok()
    );
}

#[test]
fn sql_null_truth_matches_real_sqlite_check_acceptance() {
    let db = rusqlite::Connection::open_in_memory().unwrap();
    for expression in [
        "(1=0 AND NULL IS NULL) OR (1>0 AND NULL=1-1)",
        "(NULL IS NULL AND 0 IS NULL) OR (length(NULL)>0 AND typeof(0)='integer' AND 0>=0)",
        "('quarantined'='active' AND NULL IS NULL) OR ('quarantined'='quarantined' AND length(NULL)>0)",
        "(NULL IS NULL AND 0 IS NULL) OR (length(NULL)>0 AND typeof(0)='integer' AND 0>=0)",
    ] {
        let result: Option<i64> = db
            .query_row(&format!("SELECT {expression}"), [], |row| row.get(0))
            .unwrap();
        assert_eq!(result, None);
    }
}

#[test]
fn project_cascade_covers_all_owned_children_and_preserves_other_project_and_blobs() {
    let store = store();
    store
        .submit(|tx| {
            project::ProjectTable::put(
                tx,
                &project::Project {
                    id: "other".into(),
                    ..root()
                },
            )?;
            project::WorkspaceTable::put(
                tx,
                &project::Workspace {
                    id: "w".into(),
                    type_: "git".into(),
                    name: "".into(),
                    branch: None,
                    directory: None,
                    extra: None,
                    project_id: "p".into(),
                    time_used: 0,
                },
            )?;
            project::DirectoryTable::put(
                tx,
                &project::Directory {
                    project_id: "p".into(),
                    directory: "/p".into(),
                    type_: None,
                    strategy: None,
                    time_created: 0,
                },
            )?;
            project::PermissionTable::put(
                tx,
                &project::Permission {
                    id: "perm".into(),
                    project_id: "p".into(),
                    action: "read".into(),
                    resource: "*".into(),
                    time_created: 0,
                    time_updated: 0,
                },
            )?;
            session::SessionTable::put(tx, &record("s"))?;
            session::SessionTable::put(tx, &record("child"))?;
            session::SessionTable::put(
                tx,
                &session::Session {
                    project_id: "other".into(),
                    ..record("foreign")
                },
            )?;
            session::MessageTable::put(tx, &message("m", 0))?;
            session::PendingTable::put(tx, &input("i", 0))?;
            session::TodoTable::put(
                tx,
                &session::Todo {
                    session_id: "s".into(),
                    content: "x".into(),
                    status: "pending".into(),
                    priority: "high".into(),
                    position: 0,
                    time_created: 0,
                    time_updated: 0,
                },
            )?;
            session::TodoStateTable::put(
                tx,
                &session::TodoState {
                    session_id: "s".into(),
                    revision: 0,
                    digest: hash(),
                    time_updated: 0,
                },
            )?;
            session::FileChangeTable::put(
                tx,
                &session::FileChange {
                    session_id: "s".into(),
                    path: "x".into(),
                    patch: "".into(),
                    additions: 0,
                    deletions: 0,
                    latest_seq: 0,
                },
            )?;
            session::TaskTable::put(tx, &task("child"))?;
            session::NotificationTable::put(tx, &notification("n"))?;
            session::ManifestTable::put(tx, &manifest())?;
            session::RevisionTable::put(tx, &revision(0))?;
            session::ContextStateTable::put(tx, &context())?;
            session::JobTable::put(tx, &job())?;
            session::ExclusionTable::put(tx, &exclusion())?;
            session::InstructionEntryTable::put(
                tx,
                &session::InstructionEntry {
                    session_id: "s".into(),
                    key: "k".into(),
                    value: Some(json()),
                    removed: 0,
                    time_created: 0,
                    time_updated: 0,
                },
            )?;
            session::InstructionStateTable::put(
                tx,
                &session::InstructionState {
                    session_id: "s".into(),
                    epoch_start: 0,
                    through_seq: 0,
                    initial_values: session::Document::new(
                        ycoding_schema::parse_json("{}").unwrap(),
                    )
                    .unwrap(),
                    current_values: session::Document::new(
                        ycoding_schema::parse_json("{}").unwrap(),
                    )
                    .unwrap(),
                },
            )?;
            session::InstructionBlobTable::put(
                tx,
                &session::InstructionBlob {
                    hash: "hash".into(),
                    value: Some(json()),
                },
            )?;
            assert!(project::delete(tx, &"p".into())?);
            assert_eq!(session::manifest_references(tx, &hash())?, 0);
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    macro_rules! empty {($($table:ty),*)=>{$(assert!(snapshot.scan::<$table>(Bound::Unbounded,Bound::Unbounded,1).unwrap().is_empty(),"{}",<$table>::NAME);)*};}
    empty!(
        project::WorkspaceTable,
        project::DirectoryTable,
        project::PermissionTable,
        session::MessageTable,
        session::PendingTable,
        session::TodoTable,
        session::TodoStateTable,
        session::FileChangeTable,
        session::TaskTable,
        session::NotificationTable,
        session::RevisionTable,
        session::ContextStateTable,
        session::JobTable,
        session::ExclusionTable,
        session::InstructionEntryTable,
        session::InstructionStateTable
    );
    assert_eq!(
        snapshot
            .scan::<project::ProjectTable>(Bound::Unbounded, Bound::Unbounded, 3)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        snapshot
            .scan::<session::SessionTable>(Bound::Unbounded, Bound::Unbounded, 3)
            .unwrap()[0]
            .id,
        LosslessString::from("foreign")
    );
    assert!(
        snapshot
            .get::<session::ManifestTable>(&s(&"a".repeat(64)))
            .unwrap()
            .is_some()
    );
    assert!(
        snapshot
            .get::<session::InstructionBlobTable>(&s("hash"))
            .unwrap()
            .is_some()
    );
}

#[test]
fn file_initialize_reopen_keeps_catalog_indexes_and_lossless_records() {
    let path = std::env::temp_dir().join(format!(
        "ycoding-session-catalog-{}-{}.redb",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let store =
        Store::initialize(&path, Options::core(), CATALOG, Metadata::new([5; 16], 1)).unwrap();
    store
        .submit(|tx| {
            project::ProjectTable::put(tx, &root())?;
            session::SessionTable::put(tx, &record("s"))?;
            session::append(tx, &event("e0"), None)?;
            session::admit(tx, &input("m", 0))?;
            session::promote(tx, &message("m", 1))?;
            session::ManifestTable::put(tx, &manifest())?;
            session::InstructionBlobTable::put(
                tx,
                &session::InstructionBlob {
                    hash: "hash".into(),
                    value: Some(json()),
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    store.shutdown().unwrap();
    let reopened = Store::open(&path, Options::core(), CATALOG).unwrap();
    let snapshot = reopened.snapshot().unwrap();
    let session = snapshot
        .get::<session::SessionTable>(&s("s"))
        .unwrap()
        .unwrap();
    assert_eq!(session, record("s"));
    assert_eq!(session.cost.to_bits(), (-0.0f64).to_bits());
    assert_eq!(session::latest_sequence(&snapshot, &"s".into()).unwrap(), 0);
    assert_eq!(
        session::messages(
            &snapshot,
            &"s".into(),
            Bound::Unbounded,
            Bound::Unbounded,
            IndexOrder::Descending,
            None,
            1
        )
        .unwrap()[0]
            .record
            .seq,
        1
    );
    assert!(
        session::pending(&snapshot, &"s".into(), Some(&"steer".into()), None, 1)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        snapshot
            .get::<session::ManifestTable>(&s(&"a".repeat(64)))
            .unwrap()
            .unwrap(),
        manifest()
    );
    let blob = snapshot
        .get::<session::InstructionBlobTable>(&s("hash"))
        .unwrap()
        .unwrap();
    assert_eq!(blob.value.unwrap(), json());
    drop(snapshot);
    reopened.shutdown().unwrap();
    std::fs::remove_file(path).unwrap();
}

#[test]
fn cascade_pages_remove_more_than_one_batch_without_skipping_signed_prefixes() {
    let store = store();
    store
        .submit(|tx| {
            session::SessionTable::put(tx, &record("s"))?;
            for seq in 0..260 {
                session::MessageTable::put(tx, &message(&format!("m{seq}"), seq))?;
                session::PendingTable::put(tx, &input(&format!("i{seq}"), seq))?;
                session::TodoTable::put(
                    tx,
                    &session::Todo {
                        session_id: "s".into(),
                        content: "x".into(),
                        status: "pending".into(),
                        priority: "high".into(),
                        position: seq,
                        time_created: 0,
                        time_updated: 0,
                    },
                )?;
                session::RevisionTable::put(tx, &revision(seq))?;
            }
            session::ManifestTable::put(tx, &manifest())?;
            session::ExclusionTable::put(
                tx,
                &session::Exclusion {
                    context_revision: 255,
                    ..exclusion()
                },
            )?;
            session::delete_revision(tx, &"s".into(), 255)?;
            session::delete(tx, &"s".into())?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    assert!(
        snapshot
            .scan::<session::MessageTable>(Bound::Unbounded, Bound::Unbounded, 1)
            .unwrap()
            .is_empty()
    );
    assert!(
        snapshot
            .scan::<session::PendingTable>(Bound::Unbounded, Bound::Unbounded, 1)
            .unwrap()
            .is_empty()
    );
    assert!(
        snapshot
            .scan::<session::TodoTable>(Bound::Unbounded, Bound::Unbounded, 1)
            .unwrap()
            .is_empty()
    );
    assert!(
        snapshot
            .scan::<session::RevisionTable>(Bound::Unbounded, Bound::Unbounded, 1)
            .unwrap()
            .is_empty()
    );
    assert!(
        snapshot
            .scan::<session::ExclusionTable>(Bound::Unbounded, Bound::Unbounded, 1)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn schema_documents_keep_unknown_fields_sql_null_json_null_and_signed_zero() {
    let value = ycoding_schema::parse_json(
        "{\"id\":\"model\",\"providerID\":\"test\",\"unknown\\ud800\":null}",
    )
    .unwrap();
    let document = session::Document::<ycoding_schema::model::Ref>::new(value.clone()).unwrap();
    assert_eq!(document.domain().unwrap().id, LosslessString::from("model"));
    assert_eq!(document.value(), &value);
    let record = session::Task {
        model: document,
        ..task("child")
    };
    assert_eq!(
        session::TaskTable::decode(&session::TaskTable::encode(&record).unwrap())
            .unwrap()
            .model
            .value(),
        &value
    );
    let null = session::InstructionBlob {
        hash: "hash".into(),
        value: Some(session::Document::new(ycoding_schema::JsonValue::Null).unwrap()),
    };
    let absent = session::InstructionBlob {
        value: None,
        ..null.clone()
    };
    assert_ne!(
        session::InstructionBlobTable::encode(&null).unwrap(),
        session::InstructionBlobTable::encode(&absent).unwrap()
    );
    assert_eq!(
        session::InstructionBlobTable::decode(
            &session::InstructionBlobTable::encode(&null).unwrap()
        )
        .unwrap(),
        null
    );
    let record = session::InstructionBlob {
        hash: "hash".into(),
        value: Some(json()),
    };
    let decoded = session::InstructionBlobTable::decode(
        &session::InstructionBlobTable::encode(&record).unwrap(),
    )
    .unwrap();
    let ycoding_schema::JsonValue::Object(object) = decoded.value.unwrap().value().clone() else {
        panic!("object");
    };
    let key = LosslessString::from_utf16("odd".encode_utf16().chain([0xd800]).collect());
    let ycoding_schema::JsonValue::Array(values) = object.get(&key).unwrap() else {
        panic!("array");
    };
    let ycoding_schema::JsonValue::Number(number) = values[3] else {
        panic!("number");
    };
    assert_eq!(number.to_bits(), (-0.0f64).to_bits());
    let mut invalid = session::InstructionBlobTable::encode(&record).unwrap();
    invalid[18] = u8::MAX;
    assert!(session::InstructionBlobTable::decode(&invalid).is_err());
}

#[test]
fn promotion_rejects_unsupported_pending_kind_without_consuming_it() {
    let store = store();
    store
        .submit(|tx| {
            session::SessionTable::put(tx, &record("s"))?;
            session::PendingTable::put(
                tx,
                &session::Pending {
                    type_: "unsupported".into(),
                    ..input("bad", 0)
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let failed = store
        .submit(|tx| {
            session::promote(
                tx,
                &session::Message {
                    type_: "unsupported".into(),
                    ..message("bad", 1)
                },
            )
        })
        .unwrap()
        .wait();
    assert!(matches!(
        failed,
        Err(Error::Domain {
            kind: "input_lifecycle",
            ..
        })
    ));
    let snapshot = store.snapshot().unwrap();
    assert!(
        snapshot
            .get::<session::PendingTable>(&s("bad"))
            .unwrap()
            .is_some()
    );
    assert!(
        snapshot
            .get::<session::MessageTable>(&s("bad"))
            .unwrap()
            .is_none()
    );
}

#[test]
fn promotion_rejects_empty_delivery_without_consuming_pending() {
    let store = store();
    store
        .submit(|tx| {
            session::SessionTable::put(tx, &record("s"))?;
            session::PendingTable::put(
                tx,
                &session::Pending {
                    delivery: Some("".into()),
                    ..input("bad", 0)
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(matches!(
        store
            .submit(|tx| session::promote(tx, &message("bad", 1)))
            .unwrap()
            .wait(),
        Err(Error::Domain {
            kind: "input_lifecycle",
            ..
        })
    ));
    let snapshot = store.snapshot().unwrap();
    assert!(
        snapshot
            .get::<session::PendingTable>(&s("bad"))
            .unwrap()
            .is_some()
    );
    assert!(
        snapshot
            .get::<session::MessageTable>(&s("bad"))
            .unwrap()
            .is_none()
    );
}

#[test]
fn event_empty_owner_preserves_ts_truthiness_without_coercing_null_identity() {
    let store = store();
    store
        .submit(|tx| {
            session::SequenceTable::put(
                tx,
                &session::Sequence {
                    aggregate_id: "s".into(),
                    seq: -1,
                    owner_id: Some("".into()),
                },
            )?;
            assert!(matches!(
                session::append(
                    tx,
                    &event("e0"),
                    Some(&session::Replay {
                        seq: 0,
                        owner_id: Some("other".into()),
                        strict_owner: true
                    })
                )?,
                session::Append::Appended(_)
            ));
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .get::<session::SequenceTable>(&s("s"))
            .unwrap()
            .unwrap()
            .owner_id,
        Some("".into())
    );
    store
        .submit(|tx| {
            session::SequenceTable::put(
                tx,
                &session::Sequence {
                    aggregate_id: "s".into(),
                    seq: 0,
                    owner_id: None,
                },
            )?;
            session::append(
                tx,
                &event("e0"),
                Some(&session::Replay {
                    seq: 0,
                    owner_id: Some("".into()),
                    strict_owner: true,
                }),
            )?;
            session::append(
                tx,
                &event("e1"),
                Some(&session::Replay {
                    seq: 1,
                    owner_id: Some("".into()),
                    strict_owner: true,
                }),
            )?;
            session::append(
                tx,
                &session::NewEvent {
                    aggregate_id: "new".into(),
                    ..event("new")
                },
                Some(&session::Replay {
                    seq: 0,
                    owner_id: Some("".into()),
                    strict_owner: true,
                }),
            )?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .get::<session::SequenceTable>(&s("s"))
            .unwrap()
            .unwrap()
            .owner_id,
        None
    );
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .get::<session::SequenceTable>(&s("new"))
            .unwrap()
            .unwrap()
            .owner_id,
        Some("".into())
    );
}
