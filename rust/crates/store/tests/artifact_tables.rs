use ycoding_schema::LosslessString;
use ycoding_store::{
    Catalog, Error, KeyPart, Metadata, Options, Store, TableSpec, artifacts, project, session,
    tuple_key,
};

fn scope() -> artifacts::Scope {
    artifacts::Scope {
        id: "pas_one".into(),
        type_: "global".into(),
        storage_id: "00000000-0000-0000-0000-000000000001".into(),
        time_created: 0,
        time_updated: 0,
    }
}
fn store() -> Store {
    Store::disposable(
        Options::core(),
        Catalog::new(1, artifacts::TABLES),
        Metadata::new([1; 16], 1),
    )
    .unwrap()
}

fn combined() -> Catalog {
    Catalog::new(
        1,
        Box::leak(
            [
                artifacts::TABLES,
                project::TABLES,
                session::TABLES,
                ycoding_store::resources::TABLES,
                &[
                    ycoding_store::TableDeclaration::of::<ycoding_store::analytics::DeliveryTable>(
                    ),
                    ycoding_store::TableDeclaration::of::<ycoding_store::analytics::IntentTable>(),
                ],
            ]
            .concat()
            .into_boxed_slice(),
        ),
    )
}
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
fn graph(tx: &mut ycoding_store::Write<'_>) -> Result<(), Error> {
    project::ProjectTable::insert(tx, &root())?;
    artifacts::ScopeTable::insert(tx, &scope())?;
    artifacts::GlobalScopeTable::insert(
        tx,
        &artifacts::GlobalScope {
            scope_id: "pas_one".into(),
            singleton: 1,
        },
    )?;
    artifacts::insert_artifact(tx, &artifact(), &version())?;
    artifacts::ActivationTable::insert(tx, &activation())?;
    artifacts::ObservationTable::insert(tx, &observation())?;
    artifacts::TerminalTable::insert(tx, &terminal())?;
    artifacts::FeedbackTable::insert(tx, &feedback())?;
    artifacts::WriteTable::insert(tx, &write())?;
    artifacts::TrashTable::insert(tx, &trash())?;
    artifacts::OperationTable::insert(tx, &operation())?;
    artifacts::LegacyCleanupTable::insert(tx, &cleanup())
}

#[test]
fn project_delete_preserves_informational_session_links_and_cascades_terminal() {
    let store = Store::disposable(Options::core(), combined(), Metadata::new([2; 16], 1)).unwrap();
    store.submit(graph).unwrap().wait().unwrap();
    store
        .submit(|tx| {
            project::delete(tx, &"p".into())?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    assert!(
        snapshot
            .get::<artifacts::TerminalTable>(&strings(&["pat_one"]))
            .unwrap()
            .is_none()
    );
    assert_eq!(
        snapshot
            .get::<artifacts::ActivationTable>(&strings(&["paa_one"]))
            .unwrap(),
        Some(activation())
    );
    assert_eq!(
        snapshot
            .get::<artifacts::WriteTable>(&artifacts::WriteTable::primary_key(&write()))
            .unwrap(),
        Some(write())
    );
}

fn invalid<T: TableSpec>(record: T::Record, name: &'static str)
where
    T::Record: Send + 'static,
{
    assert!(
        matches!(T::encode(&record), Err(Error::Domain { kind: "check", message }) if message == name),
        "{name}"
    );
    let store = store();
    let result = store
        .submit(move |tx| {
            artifacts::MigrationTable::insert(
                tx,
                &artifacts::Migration {
                    id: "before".into(),
                    time_completed: -1,
                },
            )?;
            let _ = tx.put::<T>(&record);
            Ok(())
        })
        .unwrap()
        .wait();
    assert!(
        matches!(result, Err(Error::TransactionAborted)),
        "{name}: {result:?}"
    );
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<artifacts::MigrationTable>(&strings(&["before"]))
            .unwrap()
            .is_none()
    );
}
macro_rules! bad {
    ($table:ident, $fixture:expr, $name:literal, $($field:ident = $value:expr),+ $(,)?) => {{
        let mut record = $fixture;
        $(record.$field = $value;)+
        invalid::<artifacts::$table>(record, $name);
    }};
}

#[test]
fn every_baseline_check_rejects_invalid_values_without_narrowing_stored_columns() {
    bad!(
        ScopeTable,
        scope(),
        "project_artifact_scope_type_check",
        type_ = "other".into()
    );
    bad!(
        ScopeTable,
        scope(),
        "project_artifact_scope_storage_id_check",
        storage_id = "00000000-0000-0000-0000-00000000000A".into()
    );
    bad!(
        ScopeTable,
        scope(),
        "project_artifact_scope_id_check",
        id = "pas_-bad".into()
    );
    bad!(
        ScopeTable,
        scope(),
        "project_artifact_scope_time_check",
        time_updated = -1
    );
    bad!(
        GlobalScopeTable,
        artifacts::GlobalScope {
            scope_id: "pas_one".into(),
            singleton: 1
        },
        "project_artifact_global_scope_singleton_check",
        singleton = 2
    );
    bad!(
        ArtifactTable,
        artifact(),
        "project_artifact_id_check",
        artifact_id = "con".into()
    );
    bad!(
        ArtifactTable,
        artifact(),
        "project_artifact_revision_check",
        revision = -1
    );
    bad!(
        ArtifactTable,
        artifact(),
        "project_artifact_kind_check",
        kind = "tool".into()
    );
    bad!(
        ArtifactTable,
        artifact(),
        "project_artifact_stage_check",
        stage = "superseded".into()
    );
    bad!(
        ArtifactTable,
        artifact(),
        "project_artifact_time_check",
        last_used_at = Some(-1)
    );
    bad!(
        VersionTable,
        version(),
        "project_artifact_version_id_check",
        id = "pav_Upper".into()
    );
    bad!(
        VersionTable,
        version(),
        "project_artifact_version_state_check",
        state = "missing".into()
    );
    bad!(
        VersionTable,
        version(),
        "project_artifact_version_digest_check",
        content_digest = digest('G')
    );
    bad!(
        VersionTable,
        version(),
        "project_artifact_version_optional_digest_check",
        insight_digest = Some("short".into())
    );
    for path in [
        "/a", "a/", "a//b", "a/./b", "a/.", "a/../b", "a/..", "a:b", "~/a",
    ] {
        bad!(
            VersionTable,
            version(),
            "project_artifact_version_relpath_check",
            content_relpath = path.into()
        );
    }
    bad!(
        VersionTable,
        version(),
        "project_artifact_version_source_check",
        source = "import".into()
    );
    bad!(
        VersionTable,
        version(),
        "project_artifact_version_session_check",
        creator_session_id = Some("se".into())
    );
    bad!(
        VersionTable,
        version(),
        "project_artifact_version_origin_check",
        source = "fork".into()
    );
    bad!(
        VersionTable,
        version(),
        "project_artifact_version_origin_check",
        origin_scope_id = Some("pas_two".into())
    );
    bad!(
        VersionTable,
        version(),
        "project_artifact_version_time_check",
        first_qualified_at = Some(-1)
    );
    bad!(
        TrashTable,
        trash(),
        "project_artifact_trash_id_check",
        deletion_id = "pad_bad-".into()
    );
    bad!(
        TrashTable,
        trash(),
        "project_artifact_trash_stage_check",
        prior_stage = "superseded".into()
    );
    bad!(
        TrashTable,
        trash(),
        "project_artifact_trash_time_check",
        deleted_at = -1
    );
    bad!(
        TrashTable,
        trash(),
        "project_artifact_trash_expiry_check",
        purge_after = 2_592_000_001
    );
    bad!(
        TrashTable,
        trash(),
        "project_artifact_trash_expiry_check",
        deleted_at = i64::MAX,
        purge_after = i64::MAX
    );
    bad!(
        OperationTable,
        operation(),
        "project_artifact_operation_id_check",
        id = "pop_".into()
    );
    bad!(
        OperationTable,
        operation(),
        "project_artifact_operation_artifact_id_check",
        artifact_id = "a/b".into()
    );
    bad!(
        OperationTable,
        operation(),
        "project_artifact_operation_kind_check",
        kind = "tool".into()
    );
    bad!(
        OperationTable,
        operation(),
        "project_artifact_operation_operation_check",
        operation = "import".into()
    );
    bad!(
        OperationTable,
        operation(),
        "project_artifact_operation_phase_check",
        phase = "active".into()
    );
    bad!(
        OperationTable,
        operation(),
        "project_artifact_operation_digest_check",
        request_fingerprint = "short".into()
    );
    bad!(
        OperationTable,
        operation(),
        "project_artifact_operation_version_id_check",
        target_version_id = Some("bad".into())
    );
    bad!(
        OperationTable,
        operation(),
        "project_artifact_operation_deletion_id_check",
        deletion_id = Some("bad".into())
    );
    bad!(
        OperationTable,
        operation(),
        "project_artifact_operation_session_check",
        automatic_session_id = Some("bad".into())
    );
    bad!(
        OperationTable,
        operation(),
        "project_artifact_operation_expectation_check",
        expected_revision = Some(0)
    );
    bad!(
        OperationTable,
        operation(),
        "project_artifact_operation_source_check",
        operation = "promotion".into()
    );
    bad!(
        OperationTable,
        operation(),
        "project_artifact_operation_target_check",
        target_digest = None
    );
    bad!(
        OperationTable,
        operation(),
        "project_artifact_operation_automatic_check",
        automatic_session_id = Some("ses_one".into())
    );
    bad!(
        OperationTable,
        operation(),
        "project_artifact_operation_finalization_check",
        phase = "finalized".into()
    );
    bad!(
        OperationTable,
        operation(),
        "project_artifact_operation_finalization_check",
        operation = "remove".into(),
        phase = "preparing".into(),
        final_version_id = Some("pav_two".into())
    );
    bad!(
        OperationTable,
        operation(),
        "project_artifact_operation_deletion_check",
        operation = "remove".into()
    );
    bad!(
        OperationTable,
        operation(),
        "project_artifact_operation_time_check",
        time_created = 1,
        time_updated = 0
    );
    bad!(
        ActivationTable,
        activation(),
        "project_artifact_activation_id_check",
        id = "pao_one".into()
    );
    bad!(
        ActivationTable,
        activation(),
        "project_artifact_activation_source_check",
        source = "import".into()
    );
    bad!(
        ActivationTable,
        activation(),
        "project_artifact_activation_session_check",
        session_id = Some("bad".into())
    );
    bad!(
        ActivationTable,
        activation(),
        "project_artifact_activation_optional_id_check",
        call_id = Some("".into())
    );
    bad!(
        ActivationTable,
        activation(),
        "project_artifact_activation_number_check",
        deactivated_at = Some(-1)
    );
    bad!(
        ObservationTable,
        observation(),
        "project_artifact_observation_id_check",
        id = "pao_bad-".into()
    );
    bad!(
        ObservationTable,
        observation(),
        "project_artifact_observation_digest_check",
        activation_set_digest = digest('z')
    );
    bad!(
        ObservationTable,
        observation(),
        "project_artifact_observation_terminal_check",
        terminal_outcome = "cancelled".into()
    );
    bad!(
        ObservationTable,
        observation(),
        "project_artifact_observation_goal_check",
        goal_status = "running".into()
    );
    bad!(
        ObservationTable,
        observation(),
        "project_artifact_observation_session_check",
        session_id = Some("bad".into())
    );
    bad!(
        ObservationTable,
        observation(),
        "project_artifact_observation_message_check",
        terminal_message_id = Some("".into())
    );
    bad!(
        ObservationTable,
        observation(),
        "project_artifact_observation_boolean_check",
        eligible = 2
    );
    bad!(
        ObservationTable,
        observation(),
        "project_artifact_observation_number_check",
        cache_read_tokens = Some(-1)
    );
    bad!(
        TerminalTable,
        terminal(),
        "project_artifact_terminal_id_check",
        id = "pat_bad-".into()
    );
    bad!(
        TerminalTable,
        terminal(),
        "project_artifact_terminal_session_check",
        session_id = "bad".into()
    );
    bad!(
        TerminalTable,
        terminal(),
        "project_artifact_terminal_message_check",
        terminal_message_id = Some("".into())
    );
    bad!(
        TerminalTable,
        terminal(),
        "project_artifact_terminal_model_check",
        model_id = "".into()
    );
    bad!(
        TerminalTable,
        terminal(),
        "project_artifact_terminal_kind_check",
        kind = "tool".into()
    );
    bad!(
        TerminalTable,
        terminal(),
        "project_artifact_terminal_outcome_check",
        terminal_outcome = "other".into()
    );
    bad!(
        TerminalTable,
        terminal(),
        "project_artifact_terminal_goal_check",
        goal_status = "other".into()
    );
    bad!(
        TerminalTable,
        terminal(),
        "project_artifact_terminal_boolean_check",
        goal_mode = -1
    );
    bad!(
        TerminalTable,
        terminal(),
        "project_artifact_terminal_number_check",
        observed_at = -1
    );
    bad!(
        FeedbackTable,
        feedback(),
        "project_artifact_feedback_id_check",
        id = "paf_bad-".into()
    );
    bad!(
        FeedbackTable,
        feedback(),
        "project_artifact_feedback_action_check",
        action = "create".into()
    );
    bad!(
        FeedbackTable,
        feedback(),
        "project_artifact_feedback_actor_check",
        actor = "agent".into()
    );
    bad!(
        FeedbackTable,
        feedback(),
        "project_artifact_feedback_time_check",
        time_created = -1
    );
    bad!(
        WriteTable,
        write(),
        "project_artifact_write_operation_check",
        operation = "delete".into()
    );
    bad!(
        WriteTable,
        write(),
        "project_artifact_write_result_check",
        result = "failed".into()
    );
    bad!(
        WriteTable,
        write(),
        "project_artifact_write_session_check",
        session_id = "bad".into()
    );
    bad!(
        WriteTable,
        write(),
        "project_artifact_write_digest_check",
        insight_digest = "".into()
    );
    bad!(
        WriteTable,
        write(),
        "project_artifact_write_time_check",
        time_created = -1
    );
    bad!(
        LegacyCleanupTable,
        cleanup(),
        "project_artifact_legacy_cleanup_singleton_check",
        id = 2
    );
    bad!(
        LegacyCleanupTable,
        cleanup(),
        "project_artifact_legacy_cleanup_status_check",
        status = "active".into()
    );
    bad!(
        LegacyCleanupTable,
        cleanup(),
        "project_artifact_legacy_cleanup_counts_check",
        attempts = -1
    );
    bad!(
        LegacyCleanupTable,
        cleanup(),
        "project_artifact_legacy_cleanup_time_check",
        completed_at = Some(-1)
    );
}

fn digest(c: char) -> LosslessString {
    c.to_string().repeat(64).into()
}
fn version() -> artifacts::Version {
    artifacts::Version {
        id: "pav_one".into(),
        scope_id: "pas_one".into(),
        kind: "skill".into(),
        artifact_id: "one".into(),
        parent_version_id: None,
        state: "trial".into(),
        content_digest: digest('a'),
        content_relpath: "versions/one.md".into(),
        source: "user".into(),
        creator_agent_id: Some(LosslessString::from_utf16(vec![0, 0xd800])),
        creator_session_id: None,
        insight_digest: None,
        origin_scope_id: None,
        origin_version_id: None,
        origin_evidence_digest: None,
        first_qualified_at: None,
        last_evaluated_at: Some(0),
        last_restored_at: None,
        last_governor_transition_at: None,
        time_created: 0,
        time_state_changed: i64::MAX,
    }
}
fn artifact() -> artifacts::Artifact {
    artifacts::Artifact {
        scope_id: "pas_one".into(),
        kind: "skill".into(),
        artifact_id: "one".into(),
        revision: i64::MAX,
        stage: "trial".into(),
        current_version_id: "pav_one".into(),
        fallback_version_id: None,
        shadowed_scope_id: None,
        last_used_at: Some(0),
        time_created: 0,
        time_updated: i64::MAX,
    }
}
fn operation() -> artifacts::Operation {
    artifacts::Operation {
        id: "pop_one".into(),
        scope_id: "pas_one".into(),
        kind: "skill".into(),
        artifact_id: "one".into(),
        operation: "create".into(),
        request_fingerprint: digest('b'),
        expected_revision: None,
        expected_version_id: None,
        expected_digest: None,
        source_scope_id: None,
        source_version_id: None,
        source_digest: None,
        target_version_id: Some("pav_one".into()),
        target_digest: Some(digest('a')),
        final_version_id: None,
        deletion_id: None,
        automatic_session_id: None,
        automatic_insight_digest: None,
        phase: "preparing".into(),
        time_created: 0,
        time_updated: 0,
    }
}
fn activation() -> artifacts::Activation {
    artifacts::Activation {
        id: "paa_one".into(),
        scope_id: "pas_one".into(),
        kind: "skill".into(),
        artifact_id: "one".into(),
        version_id: "pav_one".into(),
        project_id: Some("not-a-foreign-key".into()),
        session_id: Some("ses_missing".into()),
        agent_id: Some("agent".into()),
        source: "manual".into(),
        message_id: Some(LosslessString::from_utf16(vec![0xdfff])),
        call_id: None,
        boundary_seq: 0,
        activated_at: i64::MAX,
        deactivated_at: None,
    }
}
fn observation() -> artifacts::Observation {
    artifacts::Observation {
        id: "pao_one".into(),
        scope_id: "pas_one".into(),
        kind: "skill".into(),
        artifact_id: "one".into(),
        version_id: "pav_one".into(),
        project_id: None,
        session_id: None,
        activation_set_digest: digest('c'),
        active_artifact_count: 0,
        external_confounded: 0,
        eligible: 1,
        terminal_outcome: "succeeded".into(),
        goal_status: "none".into(),
        repeat_fix: 0,
        latency_ms: Some(i64::MAX),
        input_tokens: None,
        output_tokens: Some(0),
        cache_read_tokens: None,
        completed_tool_count: Some(0),
        failed_tool_count: None,
        terminal_message_id: None,
        observed_at: i64::MAX,
    }
}
fn terminal() -> artifacts::Terminal {
    artifacts::Terminal {
        id: "pat_one".into(),
        project_id: "p".into(),
        session_id: "ses_missing".into(),
        terminal_message_id: None,
        boundary_seq: 0,
        kind: "skill".into(),
        agent_id: None,
        model_id: LosslessString::from_utf16(vec![0xd800]),
        goal_mode: 0,
        managed_activation_count: 0,
        standard_invocation_count: 0,
        external_confounded: 0,
        terminal_outcome: "interrupted".into(),
        goal_status: "stopped".into(),
        repeat_fix: 0,
        observed_at: 0,
    }
}
fn feedback() -> artifacts::Feedback {
    artifacts::Feedback {
        id: "paf_one".into(),
        scope_id: "pas_one".into(),
        kind: "skill".into(),
        artifact_id: "one".into(),
        version_id: "pav_one".into(),
        action: "enable".into(),
        actor: "user".into(),
        time_created: 0,
    }
}
fn write() -> artifacts::AutomaticWrite {
    artifacts::AutomaticWrite {
        scope_id: "pas_one".into(),
        session_id: "ses_missing".into(),
        insight_digest: digest('d'),
        operation: "reconcile".into(),
        result: "reconciled".into(),
        version_id: "pav_one".into(),
        content_digest: digest('a'),
        time_created: 0,
    }
}
fn trash() -> artifacts::Trash {
    artifacts::Trash {
        deletion_id: "pad_one".into(),
        scope_id: "pas_one".into(),
        kind: "skill".into(),
        artifact_id: "one".into(),
        prior_stage: "quarantine".into(),
        prior_version_id: "pav_one".into(),
        deleted_at: 0,
        purge_after: 2_592_000_000,
    }
}
fn cleanup() -> artifacts::LegacyCleanup {
    artifacts::LegacyCleanup {
        id: 1,
        status: "partial".into(),
        cursor: Some(LosslessString::from_utf16(vec![0, 0xdfff])),
        attempts: 0,
        removed_count: 0,
        skipped_count: i64::MAX,
        failed_count: 0,
        error_code: None,
        last_attempt_at: None,
        completed_at: Some(0),
    }
}

fn indexes<T: TableSpec>(record: &T::Record, expected: &[(&str, bool, Option<Vec<u8>>)])
where
    T::Record: Clone + Send + Sync + PartialEq + std::fmt::Debug + 'static,
{
    assert_eq!(T::INDEXES.len(), expected.len(), "{}", T::NAME);
    for durable in [false, true] {
        let file = TestFile::new();
        let store = if durable {
            Store::initialize(
                &file.0,
                Options::core(),
                Catalog::new(1, artifacts::TABLES),
                Metadata::new([1; 16], 1),
            )
            .unwrap()
        } else {
            store()
        };
        let owned = record.clone();
        store
            .submit(move |tx| tx.put::<T>(&owned))
            .unwrap()
            .wait()
            .unwrap();
        let store = if durable {
            store.shutdown().unwrap();
            Store::open(&file.0, Options::core(), Catalog::new(1, artifacts::TABLES)).unwrap()
        } else {
            store
        };
        let snapshot = store.snapshot().unwrap();
        assert_eq!(
            snapshot.get::<T>(&T::primary_key(record)).unwrap().as_ref(),
            Some(record)
        );
        let bytes = T::encode(record).unwrap();
        assert_eq!(&T::decode(&bytes).unwrap(), record);
        assert!(T::decode(&bytes[..bytes.len() - 1]).is_err());
        assert!(T::decode(&[bytes.as_slice(), &[0]].concat()).is_err());
        for (name, unique, key) in expected {
            let index = T::INDEXES.iter().find(|index| index.name == *name).unwrap();
            assert_eq!(index.unique, *unique);
            assert_eq!(T::index_key(index, record).unwrap(), *key, "{}", name);
            if let Some(key) = key {
                assert_eq!(
                    snapshot.index::<T>(name, key, None, 1).unwrap(),
                    vec![record.clone()]
                );
                assert!(
                    snapshot
                        .index::<T>(name, key, Some(&T::primary_key(record)), 1)
                        .unwrap()
                        .is_empty()
                );
                assert!(
                    snapshot
                        .index::<T>(name, &tuple_key(&[KeyPart::Bytes(b"unrelated")]), None, 1)
                        .unwrap()
                        .is_empty()
                );
            }
        }
        let primary = T::primary_key(record);
        store
            .submit(move |tx| tx.delete::<T>(&primary))
            .unwrap()
            .wait()
            .unwrap();
        let fresh = store.snapshot().unwrap();
        for (name, _, key) in expected {
            if let Some(key) = key {
                assert!(fresh.index::<T>(name, key, None, 1).unwrap().is_empty());
            }
        }
        assert_eq!(
            snapshot.get::<T>(&T::primary_key(record)).unwrap().as_ref(),
            Some(record)
        );
    }
}
fn strings(values: &[&str]) -> Vec<u8> {
    let values: Vec<LosslessString> = values.iter().map(|s| (*s).into()).collect();
    tuple_key(&values.iter().map(KeyPart::String).collect::<Vec<_>>())
}

#[test]
fn every_artifact_primary_codec_and_named_index_matches_baseline() {
    indexes::<artifacts::ScopeTable>(
        &scope(),
        &[
            (
                "project_artifact_scope_id_type_unique",
                true,
                Some(strings(&["pas_one", "global"])),
            ),
            (
                "project_artifact_scope_storage_id_idx",
                true,
                Some(strings(&["00000000-0000-0000-0000-000000000001"])),
            ),
        ],
    );
    indexes::<artifacts::ProjectScopeTable>(
        &artifacts::ProjectScope {
            scope_id: "pas_one".into(),
            project_id: "p".into(),
        },
        &[(
            "project_artifact_project_scope_project_id_idx",
            true,
            Some(strings(&["p"])),
        )],
    );
    indexes::<artifacts::GlobalScopeTable>(
        &artifacts::GlobalScope {
            scope_id: "pas_one".into(),
            singleton: 1,
        },
        &[(
            "project_artifact_global_scope_singleton_idx",
            true,
            Some(tuple_key(&[KeyPart::I64(1)])),
        )],
    );
    indexes::<artifacts::ArtifactTable>(
        &artifact(),
        &[(
            "project_artifact_scope_stage_kind_updated_idx",
            false,
            Some(tuple_key(&[
                KeyPart::String(&"pas_one".into()),
                KeyPart::String(&"trial".into()),
                KeyPart::String(&"skill".into()),
                KeyPart::I64(i64::MAX),
                KeyPart::String(&"one".into()),
            ])),
        )],
    );
    indexes::<artifacts::VersionTable>(
        &version(),
        &[
            (
                "project_artifact_version_owner_unique",
                true,
                Some(strings(&["pav_one", "pas_one", "skill", "one"])),
            ),
            (
                "project_artifact_version_digest_owner_unique",
                true,
                Some(strings(&[
                    "pav_one",
                    "pas_one",
                    "skill",
                    "one",
                    &"a".repeat(64),
                ])),
            ),
            (
                "project_artifact_version_write_unique",
                true,
                Some(strings(&["pav_one", "pas_one", &"a".repeat(64)])),
            ),
            (
                "project_artifact_version_scope_kind_id_digest_idx",
                true,
                Some(strings(&["pas_one", "skill", "one", &"a".repeat(64)])),
            ),
            (
                "project_artifact_version_scope_kind_id_created_idx",
                false,
                Some(tuple_key(&[
                    KeyPart::String(&"pas_one".into()),
                    KeyPart::String(&"skill".into()),
                    KeyPart::String(&"one".into()),
                    KeyPart::I64(0),
                ])),
            ),
        ],
    );
    indexes::<artifacts::TrashTable>(
        &trash(),
        &[
            (
                "project_artifact_trash_scope_kind_id_idx",
                true,
                Some(strings(&["pas_one", "skill", "one"])),
            ),
            (
                "project_artifact_trash_purge_after_idx",
                false,
                Some(tuple_key(&[KeyPart::I64(2_592_000_000)])),
            ),
        ],
    );
    indexes::<artifacts::OperationTable>(
        &operation(),
        &[
            (
                "project_artifact_operation_request_idx",
                true,
                Some(strings(&["pas_one", &"b".repeat(64)])),
            ),
            ("project_artifact_operation_automatic_retry_idx", true, None),
            (
                "project_artifact_operation_active_artifact_idx",
                true,
                Some(strings(&["pas_one", "skill", "one"])),
            ),
            (
                "project_artifact_operation_recovery_idx",
                false,
                Some(tuple_key(&[
                    KeyPart::String(&"preparing".into()),
                    KeyPart::I64(0),
                    KeyPart::String(&"pop_one".into()),
                ])),
            ),
        ],
    );
    indexes::<artifacts::ActivationTable>(
        &activation(),
        &[
            (
                "project_artifact_activation_identity_idx",
                true,
                Some(tuple_key(&[
                    KeyPart::String(&"ses_missing".into()),
                    KeyPart::String(&"pav_one".into()),
                    KeyPart::String(&"manual".into()),
                    KeyPart::I64(0),
                ])),
            ),
            (
                "project_artifact_activation_sessionless_identity_idx",
                true,
                None,
            ),
            (
                "project_artifact_activation_session_open_idx",
                false,
                Some(tuple_key(&[
                    KeyPart::String(&"ses_missing".into()),
                    KeyPart::Null,
                ])),
            ),
        ],
    );
    indexes::<artifacts::ObservationTable>(
        &observation(),
        &[
            (
                "project_artifact_observation_version_terminal_idx",
                true,
                None,
            ),
            (
                "project_artifact_observation_version_session_absent_idx",
                true,
                None,
            ),
            (
                "project_artifact_observation_sessionless_absent_idx",
                true,
                Some(strings(&["pav_one"])),
            ),
            (
                "project_artifact_observation_version_eligible_observed_idx",
                false,
                Some(tuple_key(&[
                    KeyPart::String(&"pav_one".into()),
                    KeyPart::I64(1),
                    KeyPart::I64(i64::MAX),
                ])),
            ),
        ],
    );
    indexes::<artifacts::TerminalTable>(
        &terminal(),
        &[
            ("project_artifact_terminal_message_identity_idx", true, None),
            (
                "project_artifact_terminal_boundary_identity_idx",
                true,
                Some(tuple_key(&[
                    KeyPart::String(&"ses_missing".into()),
                    KeyPart::I64(0),
                ])),
            ),
            (
                "project_artifact_terminal_cohort_idx",
                false,
                Some(tuple_key(&[
                    KeyPart::String(&"skill".into()),
                    KeyPart::Null,
                    KeyPart::String(&LosslessString::from_utf16(vec![0xd800])),
                    KeyPart::I64(0),
                    KeyPart::I64(0),
                ])),
            ),
        ],
    );
    indexes::<artifacts::FeedbackTable>(
        &feedback(),
        &[(
            "project_artifact_feedback_version_created_idx",
            false,
            Some(tuple_key(&[
                KeyPart::String(&"pav_one".into()),
                KeyPart::I64(0),
            ])),
        )],
    );
    indexes::<artifacts::WriteTable>(
        &write(),
        &[
            (
                "project_artifact_write_scope_created_idx",
                false,
                Some(tuple_key(&[
                    KeyPart::String(&"pas_one".into()),
                    KeyPart::I64(0),
                ])),
            ),
            (
                "project_artifact_write_session_created_idx",
                false,
                Some(tuple_key(&[
                    KeyPart::String(&"ses_missing".into()),
                    KeyPart::I64(0),
                ])),
            ),
        ],
    );
    indexes::<artifacts::LegacyCleanupTable>(&cleanup(), &[]);
    indexes::<artifacts::MigrationTable>(
        &artifacts::Migration {
            id: LosslessString::from_utf16(vec![0xd800, 0]),
            time_completed: i64::MIN,
        },
        &[],
    );
    indexes::<artifacts::DatabaseFormatTable>(
        &artifacts::DatabaseFormat {
            id: "current-2026-08-04".into(),
            time_created: i64::MAX,
        },
        &[],
    );
}

fn duplicate<T: TableSpec>(first: T::Record, second: T::Record, name: &'static str)
where
    T::Record: Send + 'static,
{
    let store = store();
    store
        .submit(move |tx| tx.put::<T>(&first))
        .unwrap()
        .wait()
        .unwrap();
    let result = store
        .submit(move |tx| {
            artifacts::MigrationTable::insert(
                tx,
                &artifacts::Migration {
                    id: "before".into(),
                    time_completed: 0,
                },
            )?;
            tx.put::<T>(&second)
        })
        .unwrap()
        .wait();
    assert!(
        matches!(result, Err(Error::UniqueViolation { index }) if index == name),
        "{name}: {result:?}"
    );
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<artifacts::MigrationTable>(&strings(&["before"]))
            .unwrap()
            .is_none()
    );
}

#[test]
fn every_reachable_unique_index_rejects_second_owner_atomically() {
    duplicate::<artifacts::ScopeTable>(
        scope(),
        artifacts::Scope {
            id: "pas_two".into(),
            ..scope()
        },
        "project_artifact_scope_storage_id_idx",
    );
    duplicate::<artifacts::ProjectScopeTable>(
        artifacts::ProjectScope {
            scope_id: "pas_one".into(),
            project_id: "p".into(),
        },
        artifacts::ProjectScope {
            scope_id: "pas_two".into(),
            project_id: "p".into(),
        },
        "project_artifact_project_scope_project_id_idx",
    );
    duplicate::<artifacts::GlobalScopeTable>(
        artifacts::GlobalScope {
            scope_id: "pas_one".into(),
            singleton: 1,
        },
        artifacts::GlobalScope {
            scope_id: "pas_two".into(),
            singleton: 1,
        },
        "project_artifact_global_scope_singleton_idx",
    );
    duplicate::<artifacts::VersionTable>(
        version(),
        artifacts::Version {
            id: "pav_two".into(),
            ..version()
        },
        "project_artifact_version_scope_kind_id_digest_idx",
    );
    duplicate::<artifacts::TrashTable>(
        trash(),
        artifacts::Trash {
            deletion_id: "pad_two".into(),
            ..trash()
        },
        "project_artifact_trash_scope_kind_id_idx",
    );
    duplicate::<artifacts::OperationTable>(
        operation(),
        artifacts::Operation {
            id: "pop_two".into(),
            artifact_id: "two".into(),
            ..operation()
        },
        "project_artifact_operation_request_idx",
    );
    duplicate::<artifacts::OperationTable>(
        operation(),
        artifacts::Operation {
            id: "pop_two".into(),
            request_fingerprint: digest('e'),
            phase: "available".into(),
            ..operation()
        },
        "project_artifact_operation_active_artifact_idx",
    );
    let automatic = artifacts::Operation {
        automatic_session_id: Some("ses_missing".into()),
        automatic_insight_digest: Some(digest('f')),
        ..operation()
    };
    duplicate::<artifacts::OperationTable>(
        automatic.clone(),
        artifacts::Operation {
            id: "pop_two".into(),
            artifact_id: "two".into(),
            request_fingerprint: digest('e'),
            ..automatic
        },
        "project_artifact_operation_automatic_retry_idx",
    );
    duplicate::<artifacts::ActivationTable>(
        activation(),
        artifacts::Activation {
            id: "paa_two".into(),
            ..activation()
        },
        "project_artifact_activation_identity_idx",
    );
    let sessionless = artifacts::Activation {
        session_id: None,
        ..activation()
    };
    duplicate::<artifacts::ActivationTable>(
        sessionless.clone(),
        artifacts::Activation {
            id: "paa_two".into(),
            ..sessionless
        },
        "project_artifact_activation_sessionless_identity_idx",
    );
    duplicate::<artifacts::ObservationTable>(
        observation(),
        artifacts::Observation {
            id: "pao_two".into(),
            ..observation()
        },
        "project_artifact_observation_sessionless_absent_idx",
    );
    let session = artifacts::Observation {
        session_id: Some("ses_missing".into()),
        ..observation()
    };
    duplicate::<artifacts::ObservationTable>(
        session.clone(),
        artifacts::Observation {
            id: "pao_two".into(),
            ..session
        },
        "project_artifact_observation_version_session_absent_idx",
    );
    let message = artifacts::Observation {
        terminal_message_id: Some("message".into()),
        ..observation()
    };
    duplicate::<artifacts::ObservationTable>(
        message.clone(),
        artifacts::Observation {
            id: "pao_two".into(),
            session_id: Some("ses_other".into()),
            ..message
        },
        "project_artifact_observation_version_terminal_idx",
    );
    duplicate::<artifacts::TerminalTable>(
        terminal(),
        artifacts::Terminal {
            id: "pat_two".into(),
            ..terminal()
        },
        "project_artifact_terminal_boundary_identity_idx",
    );
    let message = artifacts::Terminal {
        terminal_message_id: Some("message".into()),
        ..terminal()
    };
    duplicate::<artifacts::TerminalTable>(
        message.clone(),
        artifacts::Terminal {
            id: "pat_two".into(),
            boundary_seq: 1,
            ..message
        },
        "project_artifact_terminal_message_identity_idx",
    );
}

fn primary<T: TableSpec>(
    record: T::Record,
    insert: fn(&mut ycoding_store::Write<'_>, &T::Record) -> Result<(), Error>,
) where
    T::Record: Clone + Send + 'static,
{
    let store = store();
    let first = record.clone();
    store
        .submit(move |tx| tx.put::<T>(&first))
        .unwrap()
        .wait()
        .unwrap();
    let result = store.submit(move |tx| insert(tx, &record)).unwrap().wait();
    assert!(
        matches!(
            result,
            Err(Error::Domain {
                kind: "primary_key",
                ..
            })
        ),
        "{}: {result:?}",
        T::NAME
    );
}

#[test]
fn every_primary_identity_rejects_duplicate_insert() {
    primary::<artifacts::ScopeTable>(scope(), artifacts::ScopeTable::insert);
    primary::<artifacts::ProjectScopeTable>(
        artifacts::ProjectScope {
            scope_id: "pas_one".into(),
            project_id: "p".into(),
        },
        artifacts::ProjectScopeTable::insert,
    );
    primary::<artifacts::GlobalScopeTable>(
        artifacts::GlobalScope {
            scope_id: "pas_one".into(),
            singleton: 1,
        },
        artifacts::GlobalScopeTable::insert,
    );
    primary::<artifacts::ArtifactTable>(artifact(), artifacts::ArtifactTable::insert);
    primary::<artifacts::VersionTable>(version(), artifacts::VersionTable::insert);
    primary::<artifacts::TrashTable>(trash(), artifacts::TrashTable::insert);
    primary::<artifacts::OperationTable>(operation(), artifacts::OperationTable::insert);
    primary::<artifacts::ActivationTable>(activation(), artifacts::ActivationTable::insert);
    primary::<artifacts::ObservationTable>(observation(), artifacts::ObservationTable::insert);
    primary::<artifacts::TerminalTable>(terminal(), artifacts::TerminalTable::insert);
    primary::<artifacts::FeedbackTable>(feedback(), artifacts::FeedbackTable::insert);
    primary::<artifacts::WriteTable>(write(), artifacts::WriteTable::insert);
    primary::<artifacts::LegacyCleanupTable>(cleanup(), artifacts::LegacyCleanupTable::insert);
    primary::<artifacts::MigrationTable>(
        artifacts::Migration {
            id: "source".into(),
            time_completed: -1,
        },
        artifacts::MigrationTable::insert,
    );
    primary::<artifacts::DatabaseFormatTable>(
        artifacts::DatabaseFormat {
            id: "source".into(),
            time_created: -1,
        },
        artifacts::DatabaseFormatTable::insert,
    );
}

#[test]
fn partial_null_exclusions_and_phase_replacement_release_only_old_memberships() {
    let store = store();
    store
        .submit(|tx| {
            tx.put::<artifacts::ActivationTable>(&activation())?;
            tx.put::<artifacts::ActivationTable>(&artifacts::Activation {
                id: "paa_null".into(),
                session_id: None,
                ..activation()
            })?;
            tx.put::<artifacts::ObservationTable>(&observation())?;
            tx.put::<artifacts::ObservationTable>(&artifacts::Observation {
                id: "pao_session".into(),
                session_id: Some("ses_one".into()),
                ..observation()
            })?;
            tx.put::<artifacts::ObservationTable>(&artifacts::Observation {
                id: "pao_message".into(),
                terminal_message_id: Some("message".into()),
                ..observation()
            })?;
            tx.put::<artifacts::TerminalTable>(&terminal())?;
            tx.put::<artifacts::TerminalTable>(&artifacts::Terminal {
                id: "pat_message".into(),
                terminal_message_id: Some("message".into()),
                ..terminal()
            })?;
            tx.put::<artifacts::OperationTable>(&operation())?;
            tx.put::<artifacts::OperationTable>(&artifacts::Operation {
                phase: "aborted".into(),
                ..operation()
            })?;
            tx.put::<artifacts::OperationTable>(&artifacts::Operation {
                id: "pop_two".into(),
                phase: "finalized".into(),
                final_version_id: Some("pav_one".into()),
                request_fingerprint: digest('e'),
                ..operation()
            })?;
            tx.put::<artifacts::OperationTable>(&artifacts::Operation {
                id: "pop_three".into(),
                request_fingerprint: digest('f'),
                ..operation()
            })
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    assert_eq!(
        snapshot
            .index::<artifacts::OperationTable>(
                "project_artifact_operation_active_artifact_idx",
                &strings(&["pas_one", "skill", "one"]),
                None,
                10
            )
            .unwrap()
            .iter()
            .map(|r| r.id.clone())
            .collect::<Vec<_>>(),
        vec![LosslessString::from("pop_three")]
    );
    assert!(
        snapshot
            .index::<artifacts::ActivationTable>(
                "project_artifact_activation_identity_idx",
                &tuple_key(&[
                    KeyPart::Null,
                    KeyPart::String(&"pav_one".into()),
                    KeyPart::String(&"manual".into()),
                    KeyPart::I64(0)
                ]),
                None,
                10
            )
            .unwrap()
            .is_empty()
    );
    assert!(
        snapshot
            .index::<artifacts::ObservationTable>(
                "project_artifact_observation_version_session_absent_idx",
                &tuple_key(&[KeyPart::String(&"pav_one".into()), KeyPart::Null]),
                None,
                10
            )
            .unwrap()
            .is_empty()
    );
    let result = store
        .submit(|tx| tx.put::<artifacts::OperationTable>(&operation()))
        .unwrap()
        .wait();
    assert!(matches!(
        result,
        Err(Error::UniqueViolation {
            index: "project_artifact_operation_active_artifact_idx"
        })
    ));
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .get::<artifacts::OperationTable>(&strings(&["pop_one"]))
            .unwrap()
            .unwrap()
            .phase
            .as_str(),
        Some("aborted")
    );
}

fn refused(
    store: &Store,
    operation: impl FnOnce(&mut ycoding_store::Write<'_>) -> Result<(), Error> + Send + 'static,
    kind: &'static str,
) {
    let result = store
        .submit(move |tx| {
            artifacts::MigrationTable::put(
                tx,
                &artifacts::Migration {
                    id: "rolled-back".into(),
                    time_completed: 0,
                },
            )?;
            let error = operation(tx).unwrap_err();
            assert!(
                matches!(error, Error::Domain { kind: actual, .. } if actual == kind),
                "{kind}: {error:?}"
            );
            artifacts::DatabaseFormatTable::put(
                tx,
                &artifacts::DatabaseFormat {
                    id: "later".into(),
                    time_created: 0,
                },
            )?;
            Ok(())
        })
        .unwrap()
        .wait();
    assert!(matches!(result, Err(Error::Domain { kind: actual, .. }) if actual == kind));
    let snapshot = store.snapshot().unwrap();
    assert!(
        snapshot
            .get::<artifacts::MigrationTable>(&strings(&["rolled-back"]))
            .unwrap()
            .is_none()
    );
    assert!(
        snapshot
            .get::<artifacts::DatabaseFormatTable>(&strings(&["later"]))
            .unwrap()
            .is_none()
    );
}

#[test]
fn every_foreign_owner_and_digest_edge_is_checked_and_replacement_preserves_incoming_references() {
    let store = Store::disposable(Options::core(), combined(), Metadata::new([2; 16], 1)).unwrap();
    store.submit(graph).unwrap().wait().unwrap();
    refused(
        &store,
        |tx| {
            artifacts::ProjectScopeTable::put(
                tx,
                &artifacts::ProjectScope {
                    scope_id: "pas_one".into(),
                    project_id: "p".into(),
                },
            )
        },
        "foreign_reference",
    );
    refused(
        &store,
        |tx| {
            artifacts::ProjectScopeTable::put(
                tx,
                &artifacts::ProjectScope {
                    scope_id: "pas_missing".into(),
                    project_id: "missing".into(),
                },
            )
        },
        "foreign_reference",
    );
    refused(
        &store,
        |tx| {
            artifacts::GlobalScopeTable::put(
                tx,
                &artifacts::GlobalScope {
                    scope_id: "pas_missing".into(),
                    singleton: 1,
                },
            )
        },
        "foreign_reference",
    );
    refused(
        &store,
        |tx| {
            artifacts::ScopeTable::put(
                tx,
                &artifacts::Scope {
                    type_: "project".into(),
                    ..scope()
                },
            )
        },
        "foreign_reference",
    );
    refused(
        &store,
        |tx| {
            artifacts::ArtifactTable::put(
                tx,
                &artifacts::Artifact {
                    scope_id: "pas_missing".into(),
                    ..artifact()
                },
            )
        },
        "foreign_reference",
    );
    refused(
        &store,
        |tx| {
            artifacts::ArtifactTable::put(
                tx,
                &artifacts::Artifact {
                    shadowed_scope_id: Some("pas_missing".into()),
                    ..artifact()
                },
            )
        },
        "foreign_reference",
    );
    refused(
        &store,
        |tx| {
            artifacts::ArtifactTable::put(
                tx,
                &artifacts::Artifact {
                    current_version_id: "pav_missing".into(),
                    ..artifact()
                },
            )
        },
        "foreign_reference",
    );
    refused(
        &store,
        |tx| {
            artifacts::ArtifactTable::put(
                tx,
                &artifacts::Artifact {
                    fallback_version_id: Some("pav_missing".into()),
                    ..artifact()
                },
            )
        },
        "foreign_reference",
    );
    refused(
        &store,
        |tx| {
            artifacts::VersionTable::put(
                tx,
                &artifacts::Version {
                    artifact_id: "missing".into(),
                    ..version()
                },
            )
        },
        "foreign_reference",
    );
    refused(
        &store,
        |tx| {
            artifacts::VersionTable::put(
                tx,
                &artifacts::Version {
                    parent_version_id: Some("pav_missing".into()),
                    ..version()
                },
            )
        },
        "foreign_reference",
    );
    refused(
        &store,
        |tx| {
            artifacts::VersionTable::put(
                tx,
                &artifacts::Version {
                    source: "fork".into(),
                    origin_scope_id: Some("pas_other".into()),
                    origin_version_id: Some("pav_missing".into()),
                    origin_evidence_digest: Some(digest('a')),
                    ..version()
                },
            )
        },
        "foreign_reference",
    );
    refused(
        &store,
        |tx| {
            artifacts::TrashTable::put(
                tx,
                &artifacts::Trash {
                    artifact_id: "missing".into(),
                    ..trash()
                },
            )
        },
        "foreign_reference",
    );
    refused(
        &store,
        |tx| {
            artifacts::TrashTable::put(
                tx,
                &artifacts::Trash {
                    prior_version_id: "pav_missing".into(),
                    ..trash()
                },
            )
        },
        "foreign_reference",
    );
    refused(
        &store,
        |tx| {
            artifacts::OperationTable::put(
                tx,
                &artifacts::Operation {
                    scope_id: "pas_missing".into(),
                    ..operation()
                },
            )
        },
        "foreign_reference",
    );
    refused(
        &store,
        |tx| {
            artifacts::OperationTable::put(
                tx,
                &artifacts::Operation {
                    expected_revision: Some(0),
                    expected_version_id: Some("pav_one".into()),
                    expected_digest: Some(digest('e')),
                    ..operation()
                },
            )
        },
        "foreign_reference",
    );
    refused(
        &store,
        |tx| {
            artifacts::OperationTable::put(
                tx,
                &artifacts::Operation {
                    operation: "fork".into(),
                    source_scope_id: Some("pas_other".into()),
                    source_version_id: Some("pav_one".into()),
                    source_digest: Some(digest('a')),
                    ..operation()
                },
            )
        },
        "foreign_reference",
    );
    refused(
        &store,
        |tx| {
            artifacts::OperationTable::put(
                tx,
                &artifacts::Operation {
                    phase: "finalized".into(),
                    final_version_id: Some("pav_one".into()),
                    target_digest: Some(digest('e')),
                    ..operation()
                },
            )
        },
        "foreign_reference",
    );
    refused(
        &store,
        |tx| {
            artifacts::ActivationTable::put(
                tx,
                &artifacts::Activation {
                    artifact_id: "other".into(),
                    ..activation()
                },
            )
        },
        "foreign_reference",
    );
    refused(
        &store,
        |tx| {
            artifacts::ObservationTable::put(
                tx,
                &artifacts::Observation {
                    version_id: "pav_missing".into(),
                    ..observation()
                },
            )
        },
        "foreign_reference",
    );
    refused(
        &store,
        |tx| {
            artifacts::FeedbackTable::put(
                tx,
                &artifacts::Feedback {
                    scope_id: "pas_other".into(),
                    ..feedback()
                },
            )
        },
        "foreign_reference",
    );
    refused(
        &store,
        |tx| {
            artifacts::WriteTable::put(
                tx,
                &artifacts::AutomaticWrite {
                    scope_id: "pas_missing".into(),
                    ..write()
                },
            )
        },
        "foreign_reference",
    );
    refused(
        &store,
        |tx| {
            artifacts::WriteTable::put(
                tx,
                &artifacts::AutomaticWrite {
                    content_digest: digest('e'),
                    ..write()
                },
            )
        },
        "foreign_reference",
    );
    refused(
        &store,
        |tx| {
            artifacts::TerminalTable::put(
                tx,
                &artifacts::Terminal {
                    project_id: "missing".into(),
                    ..terminal()
                },
            )
        },
        "foreign_reference",
    );
    refused(
        &store,
        |tx| {
            artifacts::VersionTable::put(
                tx,
                &artifacts::Version {
                    content_digest: digest('e'),
                    ..version()
                },
            )
        },
        "foreign_reference",
    );
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .get::<artifacts::VersionTable>(&strings(&["pav_one"]))
            .unwrap(),
        Some(version())
    );
}

#[test]
fn revision_digest_lifecycle_and_journal_transitions_commit_together_or_rollback() {
    let store = Store::disposable(Options::core(), combined(), Metadata::new([2; 16], 1)).unwrap();
    store
        .submit(|tx| {
            graph(tx)?;
            artifacts::ArtifactTable::put(
                tx,
                &artifacts::Artifact {
                    revision: 0,
                    ..artifact()
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    refused(
        &store,
        |tx| {
            artifacts::replace_artifact(
                tx,
                &artifacts::Expectation {
                    revision: 0,
                    version_id: "pav_one".into(),
                    digest: digest('b'),
                },
                &artifacts::Artifact {
                    revision: 1,
                    stage: "active".into(),
                    ..artifact()
                },
                None,
            )
        },
        "version_conflict",
    );
    for (i, stage) in ["active", "degraded", "disabled", "quarantine", "trial"]
        .into_iter()
        .enumerate()
    {
        store
            .submit(move |tx| {
                artifacts::replace_artifact(
                    tx,
                    &artifacts::Expectation {
                        revision: i as i64,
                        version_id: "pav_one".into(),
                        digest: digest('a'),
                    },
                    &artifacts::Artifact {
                        revision: i as i64 + 1,
                        stage: stage.into(),
                        ..artifact()
                    },
                    None,
                )?;
                artifacts::VersionTable::put(
                    tx,
                    &artifacts::Version {
                        state: stage.into(),
                        ..version()
                    },
                )
            })
            .unwrap()
            .wait()
            .unwrap();
        let snapshot = store.snapshot().unwrap();
        let artifact = snapshot
            .get::<artifacts::ArtifactTable>(&artifacts::ArtifactTable::primary_key(&artifact()))
            .unwrap()
            .unwrap();
        assert_eq!(artifact.stage.as_str(), Some(stage));
        assert!(artifact.stage().is_ok());
        assert_eq!(artifact.revision, i as i64 + 1);
        assert!(
            snapshot
                .get::<artifacts::VersionTable>(&strings(&["pav_one"]))
                .unwrap()
                .unwrap()
                .state()
                .is_ok()
        );
    }
    refused(
        &store,
        |tx| {
            artifacts::replace_artifact(
                tx,
                &artifacts::Expectation {
                    revision: 5,
                    version_id: "pav_one".into(),
                    digest: digest('a'),
                },
                &artifacts::Artifact {
                    revision: 6,
                    current_version_id: "pav_missing".into(),
                    ..artifact()
                },
                None,
            )
        },
        "foreign_reference",
    );
    let result = store
        .submit(|tx| {
            artifacts::replace_artifact(
                tx,
                &artifacts::Expectation {
                    revision: 5,
                    version_id: "pav_one".into(),
                    digest: digest('a'),
                },
                &artifacts::Artifact {
                    revision: 6,
                    current_version_id: "pav_two".into(),
                    ..artifact()
                },
                Some(&artifacts::Version {
                    id: "pav_two".into(),
                    ..version()
                }),
            )
        })
        .unwrap()
        .wait();
    assert!(matches!(
        result,
        Err(Error::UniqueViolation {
            index: "project_artifact_version_scope_kind_id_digest_idx"
        })
    ));
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .get::<artifacts::ArtifactTable>(&artifacts::ArtifactTable::primary_key(&artifact()))
            .unwrap()
            .unwrap()
            .revision,
        5
    );
    store
        .submit(|tx| {
            artifacts::replace_artifact(
                tx,
                &artifacts::Expectation {
                    revision: 5,
                    version_id: "pav_one".into(),
                    digest: digest('a'),
                },
                &artifacts::Artifact {
                    revision: 6,
                    current_version_id: "pav_two".into(),
                    fallback_version_id: Some("pav_one".into()),
                    ..artifact()
                },
                Some(&artifacts::Version {
                    id: "pav_two".into(),
                    content_digest: digest('e'),
                    parent_version_id: Some("pav_one".into()),
                    ..version()
                }),
            )?;
            artifacts::transition_operation(
                tx,
                &"pop_one".into(),
                artifacts::JournalPhase::Available,
                None,
                1,
            )?;
            artifacts::transition_operation(
                tx,
                &"pop_one".into(),
                artifacts::JournalPhase::Finalized,
                Some("pav_one".into()),
                2,
            )?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    refused(
        &store,
        |tx| {
            artifacts::transition_operation(
                tx,
                &"pop_one".into(),
                artifacts::JournalPhase::Preparing,
                None,
                3,
            )
            .map(|_| ())
        },
        "version_conflict",
    );
    refused(
        &store,
        |tx| {
            artifacts::delete_artifact(tx, &"pas_one".into(), &"skill".into(), &"one".into())
                .map(|_| ())
        },
        "restrict",
    );
}

#[test]
fn artifact_scope_version_trash_cascades_restrict_and_preserve_other_records() {
    let store = Store::disposable(Options::core(), combined(), Metadata::new([2; 16], 1)).unwrap();
    store.submit(graph).unwrap().wait().unwrap();
    refused(
        &store,
        |tx| artifacts::delete_version(tx, &"pav_one".into()).map(|_| ()),
        "restrict",
    );
    store
        .submit(|tx| {
            assert!(artifacts::restore(tx, &"pad_one".into())?);
            assert!(!artifacts::restore(tx, &"pad_one".into())?);
            artifacts::TrashTable::insert(tx, &trash())?;
            assert!(artifacts::delete_artifact(
                tx,
                &"pas_one".into(),
                &"skill".into(),
                &"one".into()
            )?);
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    assert!(
        snapshot
            .get::<artifacts::ArtifactTable>(&artifacts::ArtifactTable::primary_key(&artifact()))
            .unwrap()
            .is_none()
    );
    assert!(
        snapshot
            .get::<artifacts::VersionTable>(&strings(&["pav_one"]))
            .unwrap()
            .is_none()
    );
    assert!(
        snapshot
            .get::<artifacts::TrashTable>(&strings(&["pad_one"]))
            .unwrap()
            .is_none()
    );
    assert!(
        snapshot
            .get::<artifacts::ActivationTable>(&strings(&["paa_one"]))
            .unwrap()
            .is_none()
    );
    assert!(
        snapshot
            .get::<artifacts::ObservationTable>(&strings(&["pao_one"]))
            .unwrap()
            .is_none()
    );
    assert!(
        snapshot
            .get::<artifacts::FeedbackTable>(&strings(&["paf_one"]))
            .unwrap()
            .is_none()
    );
    assert!(
        snapshot
            .get::<artifacts::WriteTable>(&artifacts::WriteTable::primary_key(&write()))
            .unwrap()
            .is_none()
    );
    assert!(
        snapshot
            .get::<artifacts::OperationTable>(&strings(&["pop_one"]))
            .unwrap()
            .is_some()
    );
    assert!(
        snapshot
            .get::<artifacts::TerminalTable>(&strings(&["pat_one"]))
            .unwrap()
            .is_some()
    );
    drop(snapshot);
    store
        .submit(|tx| {
            assert!(artifacts::delete_scope(tx, &"pas_one".into())?);
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    assert!(
        snapshot
            .get::<artifacts::ScopeTable>(&strings(&["pas_one"]))
            .unwrap()
            .is_none()
    );
    assert!(
        snapshot
            .get::<artifacts::GlobalScopeTable>(&strings(&["pas_one"]))
            .unwrap()
            .is_none()
    );
    assert!(
        snapshot
            .get::<artifacts::OperationTable>(&strings(&["pop_one"]))
            .unwrap()
            .is_none()
    );
    assert!(
        snapshot
            .get::<artifacts::LegacyCleanupTable>(&tuple_key(&[KeyPart::I64(1)]))
            .unwrap()
            .is_some()
    );
    assert!(
        snapshot
            .get::<project::ProjectTable>(&strings(&["p"]))
            .unwrap()
            .is_some()
    );
}

#[test]
fn project_membership_restrict_is_latched_before_any_project_children_are_deleted() {
    let store = Store::disposable(Options::core(), combined(), Metadata::new([2; 16], 1)).unwrap();
    store
        .submit(|tx| {
            graph(tx)?;
            artifacts::ScopeTable::insert(
                tx,
                &artifacts::Scope {
                    id: "pas_project".into(),
                    type_: "project".into(),
                    storage_id: "00000000-0000-0000-0000-000000000002".into(),
                    ..scope()
                },
            )?;
            artifacts::ProjectScopeTable::insert(
                tx,
                &artifacts::ProjectScope {
                    scope_id: "pas_project".into(),
                    project_id: "p".into(),
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    refused(
        &store,
        |tx| project::delete(tx, &"p".into()).map(|_| ()),
        "restrict",
    );
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<artifacts::TerminalTable>(&strings(&["pat_one"]))
            .unwrap()
            .is_some()
    );
    store
        .submit(|tx| {
            artifacts::delete_scope(tx, &"pas_project".into())?;
            project::delete(tx, &"p".into()).map(|_| ())
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<artifacts::ProjectScopeTable>(&strings(&["pas_project"]))
            .unwrap()
            .is_none()
    );
}

struct TestFile(std::path::PathBuf);
impl TestFile {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        Self(std::env::temp_dir().join(format!(
            "ycoding-artifacts-{}-{}.redb",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        )))
    }
}
impl Drop for TestFile {
    fn drop(&mut self) {
        if self.0.exists() {
            std::fs::remove_file(&self.0).unwrap();
        }
    }
}

#[test]
fn durable_graph_journal_recovery_provenance_and_nullable_values_survive_reopen() {
    let file = TestFile::new();
    let catalog = combined();
    let store =
        Store::initialize(&file.0, Options::core(), catalog, Metadata::new([9; 16], 7)).unwrap();
    store
        .submit(|tx| {
            graph(tx)?;
            artifacts::MigrationTable::insert(
                tx,
                &artifacts::Migration {
                    id: "20260726160111_agentic-project-artifacts".into(),
                    time_completed: -1,
                },
            )?;
            artifacts::DatabaseFormatTable::insert(
                tx,
                &artifacts::DatabaseFormat {
                    id: "current-2026-08-04".into(),
                    time_created: i64::MAX,
                },
            )?;
            artifacts::ScopeTable::insert(
                tx,
                &artifacts::Scope {
                    id: "pas_project".into(),
                    type_: "project".into(),
                    storage_id: "00000000-0000-0000-0000-000000000002".into(),
                    ..scope()
                },
            )?;
            artifacts::ProjectScopeTable::insert(
                tx,
                &artifacts::ProjectScope {
                    scope_id: "pas_project".into(),
                    project_id: "p".into(),
                },
            )?;
            artifacts::transition_operation(
                tx,
                &"pop_one".into(),
                artifacts::JournalPhase::Available,
                None,
                1,
            )?;
            artifacts::OperationTable::insert(
                tx,
                &artifacts::Operation {
                    id: "pop_two".into(),
                    artifact_id: "two".into(),
                    request_fingerprint: digest('e'),
                    ..operation()
                },
            )?;
            artifacts::transition_operation(
                tx,
                &"pop_two".into(),
                artifacts::JournalPhase::Aborted,
                None,
                2,
            )?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    store.shutdown().unwrap();
    let store = Store::open(&file.0, Options::core(), catalog).unwrap();
    assert_eq!(store.metadata(), &Metadata::new([9; 16], 7));
    let snapshot = store.snapshot().unwrap();
    assert_eq!(
        snapshot
            .get::<artifacts::ArtifactTable>(&artifacts::ArtifactTable::primary_key(&artifact()))
            .unwrap(),
        Some(artifact())
    );
    assert_eq!(
        snapshot
            .get::<artifacts::VersionTable>(&strings(&["pav_one"]))
            .unwrap(),
        Some(version())
    );
    assert_eq!(
        snapshot
            .get::<artifacts::ScopeTable>(&strings(&["pas_one"]))
            .unwrap(),
        Some(scope())
    );
    assert_eq!(
        snapshot
            .get::<artifacts::GlobalScopeTable>(&strings(&["pas_one"]))
            .unwrap()
            .unwrap()
            .singleton,
        1
    );
    assert_eq!(
        snapshot
            .get::<artifacts::ProjectScopeTable>(&strings(&["pas_project"]))
            .unwrap()
            .unwrap()
            .project_id
            .as_str(),
        Some("p")
    );
    assert_eq!(
        snapshot
            .get::<artifacts::TrashTable>(&strings(&["pad_one"]))
            .unwrap(),
        Some(trash())
    );
    assert_eq!(
        snapshot
            .get::<artifacts::ActivationTable>(&strings(&["paa_one"]))
            .unwrap(),
        Some(activation())
    );
    assert_eq!(
        snapshot
            .get::<artifacts::ObservationTable>(&strings(&["pao_one"]))
            .unwrap(),
        Some(observation())
    );
    assert_eq!(
        snapshot
            .get::<artifacts::TerminalTable>(&strings(&["pat_one"]))
            .unwrap(),
        Some(terminal())
    );
    assert_eq!(
        snapshot
            .get::<artifacts::FeedbackTable>(&strings(&["paf_one"]))
            .unwrap(),
        Some(feedback())
    );
    assert_eq!(
        snapshot
            .get::<artifacts::WriteTable>(&artifacts::WriteTable::primary_key(&write()))
            .unwrap(),
        Some(write())
    );
    assert_eq!(
        snapshot
            .get::<artifacts::LegacyCleanupTable>(&tuple_key(&[KeyPart::I64(1)]))
            .unwrap(),
        Some(cleanup())
    );
    assert_eq!(
        snapshot
            .get::<artifacts::MigrationTable>(&strings(&[
                "20260726160111_agentic-project-artifacts"
            ]))
            .unwrap()
            .unwrap()
            .time_completed,
        -1
    );
    assert_eq!(
        snapshot
            .get::<artifacts::DatabaseFormatTable>(&strings(&["current-2026-08-04"]))
            .unwrap()
            .unwrap()
            .time_created,
        i64::MAX
    );
    let available =
        artifacts::operations_in_phase(&snapshot, artifacts::JournalPhase::Available, None, 1)
            .unwrap();
    assert_eq!(available[0].record.id.as_str(), Some("pop_one"));
    assert!(
        artifacts::operations_in_phase(
            &snapshot,
            artifacts::JournalPhase::Available,
            Some(&available[0].cursor),
            1
        )
        .unwrap()
        .is_empty()
    );
    assert_eq!(
        artifacts::operations_in_phase(&snapshot, artifacts::JournalPhase::Aborted, None, 1)
            .unwrap()[0]
            .record
            .id
            .as_str(),
        Some("pop_two")
    );
    drop(snapshot);
    store
        .submit(|tx| {
            artifacts::transition_operation(
                tx,
                &"pop_two".into(),
                artifacts::JournalPhase::Preparing,
                None,
                3,
            )?;
            artifacts::transition_operation(
                tx,
                &"pop_one".into(),
                artifacts::JournalPhase::Finalized,
                Some("pav_one".into()),
                3,
            )?;
            artifacts::transition_operation(
                tx,
                &"pop_two".into(),
                artifacts::JournalPhase::Available,
                None,
                4,
            )?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    store.shutdown().unwrap();
    let store = Store::open(&file.0, Options::core(), catalog).unwrap();
    refused(
        &store,
        |tx| artifacts::delete_scope(tx, &"pas_one".into()).map(|_| ()),
        "restrict",
    );
    assert_eq!(
        artifacts::operations_in_phase(
            &store.snapshot().unwrap(),
            artifacts::JournalPhase::Finalized,
            None,
            1
        )
        .unwrap()[0]
            .record
            .final_version_id
            .as_ref()
            .unwrap()
            .as_str(),
        Some("pav_one")
    );
}

#[test]
fn cross_scope_origin_and_shadow_restrict_deletion_until_referring_records_are_removed() {
    let store = Store::disposable(Options::core(), combined(), Metadata::new([2; 16], 1)).unwrap();
    store
        .submit(|tx| {
            graph(tx)?;
            artifacts::ScopeTable::insert(
                tx,
                &artifacts::Scope {
                    id: "pas_two".into(),
                    storage_id: "00000000-0000-0000-0000-000000000002".into(),
                    ..scope()
                },
            )?;
            artifacts::insert_artifact(
                tx,
                &artifacts::Artifact {
                    scope_id: "pas_two".into(),
                    current_version_id: "pav_two".into(),
                    shadowed_scope_id: Some("pas_one".into()),
                    ..artifact()
                },
                &artifacts::Version {
                    scope_id: "pas_two".into(),
                    id: "pav_two".into(),
                    source: "fork".into(),
                    origin_scope_id: Some("pas_one".into()),
                    origin_version_id: Some("pav_one".into()),
                    origin_evidence_digest: Some(digest('a')),
                    ..version()
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    refused(
        &store,
        |tx| artifacts::delete_scope(tx, &"pas_one".into()).map(|_| ()),
        "restrict",
    );
    refused(
        &store,
        |tx| {
            artifacts::delete_artifact(tx, &"pas_one".into(), &"skill".into(), &"one".into())
                .map(|_| ())
        },
        "restrict",
    );
    store
        .submit(|tx| {
            artifacts::delete_scope(tx, &"pas_two".into())?;
            artifacts::delete_scope(tx, &"pas_one".into())?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<artifacts::ScopeTable>(&strings(&["pas_two"]))
            .unwrap()
            .is_none()
    );
}

fn sqlite_baseline() -> rusqlite::Connection {
    let database = rusqlite::Connection::open_in_memory().unwrap();
    database.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    for definition in include_str!("../../../../packages/core/src/database/schema.gen.ts")
        .split("CREATE ")
        .skip(1)
    {
        if definition.starts_with("TABLE ")
            || definition.starts_with("INDEX ")
            || definition.starts_with("UNIQUE INDEX ")
        {
            database
                .execute_batch(&format!(
                    "CREATE {};",
                    definition.split(';').next().unwrap().replace("\\`", "`")
                ))
                .unwrap();
        }
    }
    database
}

#[test]
fn replacing_self_referenced_version_owner_preserves_sql_final_row_semantics() {
    let database = sqlite_baseline();
    database.execute_batch("BEGIN; PRAGMA defer_foreign_keys=ON;
        INSERT INTO project_artifact_scope VALUES ('pas_one','global','00000000-0000-0000-0000-000000000001',0,0);
        INSERT INTO project_artifact_scope VALUES ('pas_two','global','00000000-0000-0000-0000-000000000002',0,0);
        INSERT INTO project_artifact VALUES ('pas_one','skill','one',0,'trial','pav_one',NULL,NULL,NULL,0,0);
        INSERT INTO project_artifact VALUES ('pas_two','skill','one',0,'trial','pav_three',NULL,NULL,NULL,0,0);").unwrap();
    for (id, scope, digest, parent) in [
        ("pav_one", "pas_one", 'a', Some("pav_one")),
        ("pav_three", "pas_two", 'c', None),
        ("pav_two", "pas_one", 'b', None),
    ] {
        database.execute("INSERT INTO project_artifact_version (id,scope_id,kind,artifact_id,parent_version_id,state,content_digest,content_relpath,source,time_created,time_state_changed)
            VALUES (?1,?2,'skill','one',?3,'trial',?4,'v/one','user',0,0)", rusqlite::params![id, scope, parent, digest.to_string().repeat(64)]).unwrap();
    }
    database.execute_batch("UPDATE project_artifact SET current_version_id='pav_two' WHERE scope_id='pas_one'; COMMIT;
        UPDATE project_artifact_version SET scope_id='pas_two' WHERE id='pav_one';").unwrap();
    let store = Store::disposable(Options::core(), combined(), Metadata::new([2; 16], 1)).unwrap();
    store
        .submit(|tx| {
            artifacts::ScopeTable::insert(tx, &scope())?;
            artifacts::ScopeTable::insert(
                tx,
                &artifacts::Scope {
                    id: "pas_two".into(),
                    storage_id: "00000000-0000-0000-0000-000000000002".into(),
                    ..scope()
                },
            )?;
            artifacts::insert_artifact(
                tx,
                &artifact(),
                &artifacts::Version {
                    parent_version_id: Some("pav_one".into()),
                    ..version()
                },
            )?;
            artifacts::VersionTable::insert(
                tx,
                &artifacts::Version {
                    id: "pav_two".into(),
                    content_digest: digest('b'),
                    ..version()
                },
            )?;
            artifacts::ArtifactTable::put(
                tx,
                &artifacts::Artifact {
                    current_version_id: "pav_two".into(),
                    ..artifact()
                },
            )?;
            artifacts::insert_artifact(
                tx,
                &artifacts::Artifact {
                    scope_id: "pas_two".into(),
                    current_version_id: "pav_three".into(),
                    ..artifact()
                },
                &artifacts::Version {
                    id: "pav_three".into(),
                    scope_id: "pas_two".into(),
                    content_digest: digest('c'),
                    ..version()
                },
            )?;
            artifacts::VersionTable::put(
                tx,
                &artifacts::Version {
                    scope_id: "pas_two".into(),
                    parent_version_id: Some("pav_one".into()),
                    ..version()
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .get::<artifacts::VersionTable>(&strings(&["pav_one"]))
            .unwrap()
            .unwrap()
            .scope_id
            .as_str(),
        Some("pas_two")
    );
}

#[test]
fn settled_journal_update_is_idempotent_and_never_regresses_phase() {
    let store = Store::disposable(Options::core(), combined(), Metadata::new([2; 16], 1)).unwrap();
    store
        .submit(|tx| {
            graph(tx)?;
            artifacts::transition_operation(
                tx,
                &"pop_one".into(),
                artifacts::JournalPhase::Finalized,
                Some("pav_one".into()),
                1,
            )?;
            artifacts::transition_operation(
                tx,
                &"pop_one".into(),
                artifacts::JournalPhase::Available,
                None,
                2,
            )?;
            artifacts::transition_operation(
                tx,
                &"pop_one".into(),
                artifacts::JournalPhase::Aborted,
                None,
                3,
            )?;
            assert!(
                artifacts::transition_operation(
                    tx,
                    &"pop_missing".into(),
                    artifacts::JournalPhase::Aborted,
                    None,
                    3
                )?
                .is_none()
            );
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let operation = store
        .snapshot()
        .unwrap()
        .get::<artifacts::OperationTable>(&strings(&["pop_one"]))
        .unwrap()
        .unwrap();
    assert_eq!(operation.phase.as_str(), Some("finalized"));
    assert_eq!(
        operation.final_version_id.as_ref().unwrap().as_str(),
        Some("pav_one")
    );
    assert_eq!(operation.time_updated, 1);
}

#[test]
fn baseline_catalog_names_and_primary_keys_are_complete() {
    let database = sqlite_baseline();
    let mut query = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'project_artifact%' ORDER BY name").unwrap();
    let actual = query
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let mut declared: Vec<_> = artifacts::TABLES
        .iter()
        .filter(|table| table.name.starts_with("project_artifact"))
        .map(|table| table.name.to_owned())
        .collect();
    declared.sort();
    assert_eq!(actual, declared);
    let mut query = database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'project_artifact%' ORDER BY name").unwrap();
    let actual = query
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let mut declared: Vec<_> = artifacts::TABLES
        .iter()
        .flat_map(|table| table.indexes)
        .filter(|index| index.name.ends_with("_idx"))
        .map(|index| index.name.to_owned())
        .collect();
    declared.sort();
    assert_eq!(actual, declared);
    assert_eq!(artifacts::TABLES.len(), 15);
    assert_eq!(
        artifacts::ScopeTable::primary_key(&scope()),
        strings(&["pas_one"])
    );
    assert_eq!(
        artifacts::ProjectScopeTable::primary_key(&artifacts::ProjectScope {
            scope_id: "pas_one".into(),
            project_id: "p".into()
        }),
        strings(&["pas_one"])
    );
    assert_eq!(
        artifacts::GlobalScopeTable::primary_key(&artifacts::GlobalScope {
            scope_id: "pas_one".into(),
            singleton: 1
        }),
        strings(&["pas_one"])
    );
    assert_eq!(
        artifacts::ArtifactTable::primary_key(&artifact()),
        strings(&["pas_one", "skill", "one"])
    );
    assert_eq!(
        artifacts::VersionTable::primary_key(&version()),
        strings(&["pav_one"])
    );
    assert_eq!(
        artifacts::TrashTable::primary_key(&trash()),
        strings(&["pad_one"])
    );
    assert_eq!(
        artifacts::OperationTable::primary_key(&operation()),
        strings(&["pop_one"])
    );
    assert_eq!(
        artifacts::ActivationTable::primary_key(&activation()),
        strings(&["paa_one"])
    );
    assert_eq!(
        artifacts::ObservationTable::primary_key(&observation()),
        strings(&["pao_one"])
    );
    assert_eq!(
        artifacts::TerminalTable::primary_key(&terminal()),
        strings(&["pat_one"])
    );
    assert_eq!(
        artifacts::FeedbackTable::primary_key(&feedback()),
        strings(&["paf_one"])
    );
    assert_eq!(
        artifacts::WriteTable::primary_key(&write()),
        strings(&["pas_one", "ses_missing", &"d".repeat(64)])
    );
    assert_eq!(
        artifacts::LegacyCleanupTable::primary_key(&cleanup()),
        tuple_key(&[KeyPart::I64(1)])
    );
    assert_eq!(
        artifacts::MigrationTable::primary_key(&artifacts::Migration {
            id: "source".into(),
            time_completed: -1
        }),
        strings(&["source"])
    );
    assert_eq!(
        artifacts::DatabaseFormatTable::primary_key(&artifacts::DatabaseFormat {
            id: "source".into(),
            time_created: -1
        }),
        strings(&["source"])
    );
}

#[test]
fn bounded_accounting_pages_are_completely_removed_by_artifact_cascade() {
    let store = Store::disposable(Options::core(), combined(), Metadata::new([2; 16], 1)).unwrap();
    store
        .submit(|tx| {
            artifacts::ScopeTable::insert(tx, &scope())?;
            artifacts::insert_artifact(tx, &artifact(), &version())?;
            for i in 0..130 {
                artifacts::ActivationTable::insert(
                    tx,
                    &artifacts::Activation {
                        id: format!("paa_{i}").into(),
                        boundary_seq: i,
                        ..activation()
                    },
                )?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let logical = tuple_key(&[KeyPart::String(&"ses_missing".into()), KeyPart::Null]);
    let snapshot = store.snapshot().unwrap();
    let first = snapshot
        .index::<artifacts::ActivationTable>(
            "project_artifact_activation_session_open_idx",
            &logical,
            None,
            128,
        )
        .unwrap();
    assert_eq!(first.len(), 128);
    let after = artifacts::ActivationTable::primary_key(first.last().unwrap());
    assert_eq!(
        snapshot
            .index::<artifacts::ActivationTable>(
                "project_artifact_activation_session_open_idx",
                &logical,
                Some(&after),
                128
            )
            .unwrap()
            .len(),
        2
    );
    store
        .submit(|tx| {
            artifacts::delete_artifact(tx, &"pas_one".into(), &"skill".into(), &"one".into())
                .map(|_| ())
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(
        store
            .snapshot()
            .unwrap()
            .index::<artifacts::ActivationTable>(
                "project_artifact_activation_session_open_idx",
                &logical,
                None,
                1
            )
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        snapshot
            .index::<artifacts::ActivationTable>(
                "project_artifact_activation_session_open_idx",
                &logical,
                None,
                256
            )
            .unwrap()
            .len(),
        130
    );
}

#[test]
fn sql_text_checks_preserve_embedded_nul_tails_without_truncating_keys_or_values() {
    let database = sqlite_baseline();
    let scope_id = "pas_one\0tail";
    let storage_id = "00000000-0000-0000-0000-000000000001\0tail";
    let artifact_id = "con\0tail";
    let version_id = "pav_one\0tail";
    let digest_value = format!("{}\0tail", "a".repeat(64));
    database
        .execute_batch("BEGIN; PRAGMA defer_foreign_keys=ON")
        .unwrap();
    database
        .execute(
            "INSERT INTO project_artifact_scope VALUES (?1,'global',?2,0,0)",
            rusqlite::params![scope_id, storage_id],
        )
        .unwrap();
    database
        .execute(
            "INSERT INTO project_artifact VALUES (?1,'skill',?2,0,'trial',?3,NULL,NULL,NULL,0,0)",
            rusqlite::params![scope_id, artifact_id, version_id],
        )
        .unwrap();
    database.execute("INSERT INTO project_artifact_version (id,scope_id,kind,artifact_id,state,content_digest,content_relpath,source,time_created,time_state_changed) VALUES (?1,?2,'skill',?3,'trial',?4,?5,'user',0,0)", rusqlite::params![version_id,scope_id,artifact_id,digest_value,"a\0/.."]).unwrap();
    database.execute_batch("COMMIT").unwrap();
    let store = Store::disposable(Options::core(), combined(), Metadata::new([2; 16], 1)).unwrap();
    let raw_scope = artifacts::Scope {
        id: scope_id.into(),
        storage_id: storage_id.into(),
        ..scope()
    };
    let raw_artifact = artifacts::Artifact {
        scope_id: scope_id.into(),
        artifact_id: artifact_id.into(),
        current_version_id: version_id.into(),
        ..artifact()
    };
    let raw_version = artifacts::Version {
        id: version_id.into(),
        scope_id: scope_id.into(),
        artifact_id: artifact_id.into(),
        content_digest: digest_value.into(),
        content_relpath: "a\0/..".into(),
        ..version()
    };
    let write_scope = raw_scope.clone();
    let write_artifact = raw_artifact.clone();
    let write_version = raw_version.clone();
    store
        .submit(move |tx| {
            artifacts::ScopeTable::insert(tx, &write_scope)?;
            artifacts::insert_artifact(tx, &write_artifact, &write_version)
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    assert_eq!(
        snapshot
            .get::<artifacts::ScopeTable>(&strings(&[scope_id]))
            .unwrap(),
        Some(raw_scope)
    );
    assert_eq!(
        snapshot
            .get::<artifacts::ArtifactTable>(&strings(&[scope_id, "skill", artifact_id]))
            .unwrap(),
        Some(raw_artifact)
    );
    assert_eq!(
        snapshot
            .get::<artifacts::VersionTable>(&strings(&[version_id]))
            .unwrap(),
        Some(raw_version)
    );
    assert!(
        snapshot
            .get::<artifacts::ScopeTable>(&strings(&["pas_one"]))
            .unwrap()
            .is_none()
    );
    bad!(
        TerminalTable,
        terminal(),
        "project_artifact_terminal_model_check",
        model_id = "\0nonempty-tail".into()
    );
    bad!(
        ActivationTable,
        activation(),
        "project_artifact_activation_optional_id_check",
        message_id = Some("\0tail".into())
    );
}

#[test]
fn baseline_checks_reject_invalid_scope_and_latch_rollback() {
    let store = store();
    let mut invalid = scope();
    invalid.type_ = "session".into();
    let result = store
        .submit(move |tx| {
            artifacts::MigrationTable::insert(
                tx,
                &artifacts::Migration {
                    id: "source".into(),
                    time_completed: -7,
                },
            )?;
            let _ = artifacts::ScopeTable::insert(tx, &invalid);
            Ok(())
        })
        .unwrap()
        .wait();
    assert!(matches!(
        result,
        Err(Error::TransactionAborted) | Err(Error::Domain { kind: "check", .. })
    ));
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<artifacts::MigrationTable>(&ycoding_store::tuple_key(&[
                ycoding_store::KeyPart::String(&LosslessString::from("source"))
            ]))
            .unwrap()
            .is_none()
    );
}

#[test]
fn scope_storage_unique_and_lossless_file_codec() {
    let store = store();
    store
        .submit(|tx| artifacts::ScopeTable::insert(tx, &scope()))
        .unwrap()
        .wait()
        .unwrap();
    let mut second = scope();
    second.id = "pas_two".into();
    let result = store
        .submit(move |tx| artifacts::ScopeTable::insert(tx, &second))
        .unwrap()
        .wait();
    assert!(matches!(
        result,
        Err(Error::UniqueViolation {
            index: "project_artifact_scope_storage_id_idx"
        })
    ));
    assert_eq!(
        artifacts::ScopeTable::decode(&artifacts::ScopeTable::encode(&scope()).unwrap()).unwrap(),
        scope()
    );
}
