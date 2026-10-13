use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use ycoding_core::resources::project_artifact::{
    adapter, package, source_registry::Registry, store,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, parse_json, project, project_artifact,
};
use ycoding_store::{Metadata, Options, Store, import};

struct Fixture {
    db: Store,
    root: PathBuf,
    service: store::Service,
    sources: Arc<Mutex<Registry>>,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "ycoding-artifact-store-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let db = Store::disposable(
            Options::core(),
            import::catalog(import::DatabaseKind::Core),
            Metadata::new([49; 16], 1),
        )
        .unwrap();
        db.submit(|tx| {
            for id in ["project", "adopted"] {
                ycoding_store::project::ProjectTable::insert(
                    tx,
                    &ycoding_store::project::Project {
                        id: id.into(),
                        worktree: "/fixture".into(),
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
                    },
                )?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
        let sources = Arc::new(Mutex::new(Registry::default()));
        let service = store::Service::new(
            db.client(),
            store::Paths {
                data: root.join("data"),
                home: root.join("home"),
                config: root.join("config"),
            },
            sources.clone(),
        );
        Self {
            db,
            root,
            service,
            sources,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if self.root.exists() {
            std::fs::remove_dir_all(&self.root).unwrap();
        }
    }
}
fn project() -> project::Id {
    project::Id::decode(&JsonValue::String("project".into())).unwrap()
}
fn definition() -> project_artifact::Definition {
    project_artifact::Definition::decode(&parse_json(r#"{"kind":"skill","name":"Review","description":"Reusable review","content":"Review the current change."}"#).unwrap()).unwrap()
}
fn global(fixture: &Fixture) -> store::WriteResult {
    global_definition(fixture, &definition())
}
fn global_definition(
    fixture: &Fixture,
    definition: &project_artifact::Definition,
) -> store::WriteResult {
    let preview = fixture
        .service
        .preview_manual(store::ManualPreviewInput {
            id: "review",
            definition,
            expected: None,
            now: 1000,
        })
        .unwrap();
    let written = fixture
        .service
        .confirm_manual(&preview.token, 1001)
        .unwrap();
    register_global(fixture, &written);
    written
}
fn register_global(fixture: &Fixture, written: &store::WriteResult) {
    fixture.sources.lock().unwrap().replace(
        "fixture-global".into(),
        vec![
            ycoding_core::resources::project_artifact::source_registry::Record {
                source:
                    ycoding_core::resources::project_artifact::source_registry::StandardSource {
                        scope: "global".into(),
                        managed_scope_id: Some(written.scope_id.clone()),
                        managed_version_id: Some(written.version_id.clone()),
                        managed_digest: Some(written.content_digest.clone()),
                    },
                project_id: None,
                kind: written.kind.clone(),
                id: written.id.clone(),
                path: None,
            },
        ],
    );
}
fn pending_remove(
    fixture: &Fixture,
    written: &store::WriteResult,
    now: i64,
) -> project_artifact::DeletionId {
    let revision = fixture
        .service
        .get(&written.scope_id, &written.kind, &written.id)
        .unwrap()
        .artifact
        .revision
        .get();
    let fingerprint = package::sha256(
        &format!(
            "{}\0{}\0{}\0remove\0{}\0{}\0{}",
            written.scope_id.as_lossless().as_str().unwrap(),
            written.kind.as_lossless().as_str().unwrap(),
            written.id.as_lossless().as_str().unwrap(),
            revision,
            written.version_id.as_lossless().as_str().unwrap(),
            written.content_digest.as_lossless().as_str().unwrap()
        )
        .as_str()
        .into(),
    );
    let operation_id = format!("pop_{}", &fingerprint.as_lossless().as_str().unwrap()[..32]);
    let deletion = project_artifact::DeletionId::decode(&JsonValue::String(
        format!(
            "pad_{}",
            &package::sha256(&operation_id.as_str().into())
                .as_lossless()
                .as_str()
                .unwrap()[..32]
        )
        .into(),
    ))
    .unwrap();
    let operation = ycoding_store::artifacts::Operation {
        id: operation_id.into(),
        scope_id: written.scope_id.as_lossless().clone(),
        kind: written.kind.as_lossless().clone(),
        artifact_id: written.id.as_lossless().clone(),
        operation: "remove".into(),
        request_fingerprint: fingerprint.as_lossless().clone(),
        expected_revision: Some(revision),
        expected_version_id: Some(written.version_id.as_lossless().clone()),
        expected_digest: Some(written.content_digest.as_lossless().clone()),
        source_scope_id: None,
        source_version_id: None,
        source_digest: None,
        target_version_id: None,
        target_digest: None,
        final_version_id: None,
        deletion_id: Some(deletion.as_lossless().clone()),
        automatic_session_id: None,
        automatic_insight_digest: None,
        phase: "preparing".into(),
        time_created: now,
        time_updated: now,
    };
    fixture
        .db
        .submit(move |tx| ycoding_store::artifacts::OperationTable::insert(tx, &operation))
        .unwrap()
        .wait()
        .unwrap();
    deletion
}
#[test]
fn global_recovery_trashes_standard_bytes_validates_details_and_purges_without_unowned_deletion() {
    let fixture = Fixture::new();
    let written = global(&fixture);
    let deletion = pending_remove(&fixture, &written, 2000);
    fixture.service.reconcile(&written.scope_id).unwrap();
    fixture.sources.lock().unwrap().remove("fixture-global");
    assert!(
        !fixture
            .root
            .join("home/.agents/skills/review/SKILL.md")
            .exists()
    );
    assert_eq!(
        fixture.service.get_trash(&deletion).unwrap().definition,
        definition()
    );
    assert!(
        fixture
            .service
            .list(&written.scope_id, None, None)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        fixture
            .service
            .restore(&deletion, 2001)
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("InvalidScope".into())
    );
    let unrelated = fixture.root.join("home/.agents/skills/unrelated/SKILL.md");
    std::fs::create_dir_all(unrelated.parent().unwrap()).unwrap();
    std::fs::write(&unrelated, "Unowned bytes").unwrap();
    assert_eq!(fixture.service.purge(2000 + 30 * 86_400_000).unwrap(), 1);
    assert_eq!(std::fs::read_to_string(unrelated).unwrap(), "Unowned bytes");
}
#[test]
fn global_trash_recovery_preserves_each_standard_kind_and_disabled_owned_layout() {
    for definition in [
        definition(),
        project_artifact::Definition::decode(&parse_json(r#"{"kind":"command","name":"Review","description":"Reusable review","template":"Review behavior.","subtask":false}"#).unwrap()).unwrap(),
        project_artifact::Definition::decode(&parse_json(r#"{"kind":"agent","name":"Review","description":"Reusable review","mode":"subagent","system":"Review behavior.","permissions":[{"action":"read","effect":"allow","resource":"*"}]}"#).unwrap()).unwrap(),
    ] {
        let fixture = Fixture::new();
        let written = global_definition(&fixture, &definition);
        let deletion = pending_remove(&fixture, &written, 2000);
        fixture.service.reconcile(&written.scope_id).unwrap();
        fixture.sources.lock().unwrap().remove("fixture-global");
        assert_eq!(fixture.service.get_trash(&deletion).unwrap().definition, definition);
        assert_eq!(fixture.service.purge(2000 + 30 * 86_400_000).unwrap(), 1);
    }
    let fixture = Fixture::new();
    let written = global(&fixture);
    let scope = fixture.service.resolve_global_scope().unwrap();
    let root = fixture
        .root
        .join("data/project-artifacts")
        .join(scope.storage_id.as_lossless().as_str().unwrap());
    let content = fixture.root.join("home/.agents/skills/review/SKILL.md");
    let metadata = content
        .parent()
        .unwrap()
        .join(".ycoding-project-artifact.json");
    let marker =
        package::Marker::decode(&parse_json(&std::fs::read_to_string(&metadata).unwrap()).unwrap())
            .unwrap();
    package::state_transaction(
        package::StateMutationInput {
            root: &root,
            operation_id: "pop_disabled-fixture",
            operation: package::StateOperation::Disable,
            current: &marker,
            target: None,
            standard: Some(package::StandardTarget {
                content_path: &content,
                marker_path: &metadata,
            }),
            context: None,
        },
        &Default::default(),
        &package::TransactionHooks::<_, std::convert::Infallible> {
            reserve: None,
            finalize: None,
            abort: None,
            cancellation: None,
            can_compensate: None,
        },
    )
    .unwrap();
    let identity = ycoding_store::artifacts::identity(
        written.scope_id.as_lossless(),
        written.kind.as_lossless(),
        written.id.as_lossless(),
    );
    let version_key = ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(
        written.version_id.as_lossless(),
    )]);
    fixture
        .db
        .submit(move |tx| {
            let mut artifact = tx
                .get::<ycoding_store::artifacts::ArtifactTable>(&identity)?
                .unwrap();
            artifact.stage = "disabled".into();
            artifact.revision = 1;
            ycoding_store::artifacts::ArtifactTable::put(tx, &artifact)?;
            let mut version = tx
                .get::<ycoding_store::artifacts::VersionTable>(&version_key)?
                .unwrap();
            version.state = "disabled".into();
            ycoding_store::artifacts::VersionTable::put(tx, &version)
        })
        .unwrap()
        .wait()
        .unwrap();
    let deletion = pending_remove(&fixture, &written, 2000);
    assert_eq!(
        fixture
            .service
            .reconcile(&written.scope_id)
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("DestinationExists".into())
    );
    fixture.sources.lock().unwrap().remove("fixture-global");
    fixture.service.reconcile(&written.scope_id).unwrap();
    assert_eq!(
        fixture.service.get_trash(&deletion).unwrap().definition,
        definition()
    );
    assert_eq!(
        fixture
            .service
            .get_trash(&deletion)
            .unwrap()
            .trash
            .prior_stage
            .encode(),
        JsonValue::String("disabled".into())
    );
}
#[test]
fn global_remove_recovery_rejects_unmanaged_sources_before_moving_owned_bytes() {
    let fixture = Fixture::new();
    let written = global(&fixture);
    pending_remove(&fixture, &written, 2000);
    fixture.sources.lock().unwrap().replace(
        "fixture-global".into(),
        vec![
            ycoding_core::resources::project_artifact::source_registry::Record {
                source:
                    ycoding_core::resources::project_artifact::source_registry::StandardSource {
                        scope: "global".into(),
                        managed_scope_id: None,
                        managed_version_id: None,
                        managed_digest: None,
                    },
                project_id: None,
                kind: written.kind.clone(),
                id: written.id.clone(),
                path: None,
            },
        ],
    );
    assert_eq!(
        fixture
            .service
            .reconcile(&written.scope_id)
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("DestinationExists".into())
    );
    assert!(
        fixture
            .root
            .join("home/.agents/skills/review/SKILL.md")
            .exists()
    );
    assert!(
        fixture
            .db
            .snapshot()
            .unwrap()
            .scan::<ycoding_store::artifacts::TrashTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                128
            )
            .unwrap()
            .is_empty()
    );
}
#[test]
fn global_restore_recovery_fences_destination_and_retries_exactly_without_duplicate_feedback() {
    let fixture = Fixture::new();
    let written = global(&fixture);
    let deletion = pending_remove(&fixture, &written, 2000);
    fixture.service.reconcile(&written.scope_id).unwrap();
    let mut operation = fixture
        .db
        .snapshot()
        .unwrap()
        .scan::<ycoding_store::artifacts::OperationTable>(
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
            128,
        )
        .unwrap()
        .into_iter()
        .find(|row| row.operation.as_str() == Some("remove"))
        .unwrap();
    let fingerprint = package::sha256(
        &format!(
            "{}\0{}\0{}\0restore\0{}\0{}\0{}\0{}\0{}",
            written.scope_id.as_lossless().as_str().unwrap(),
            written.kind.as_lossless().as_str().unwrap(),
            written.id.as_lossless().as_str().unwrap(),
            deletion.as_lossless().as_str().unwrap(),
            0,
            written.version_id.as_lossless().as_str().unwrap(),
            written.content_digest.as_lossless().as_str().unwrap(),
            2000
        )
        .as_str()
        .into(),
    );
    operation.id = format!("pop_{}", &fingerprint.as_lossless().as_str().unwrap()[..32]).into();
    operation.request_fingerprint = fingerprint.as_lossless().clone();
    operation.operation = "restore".into();
    operation.phase = "preparing".into();
    operation.target_version_id = Some(written.version_id.as_lossless().clone());
    operation.target_digest = Some(written.content_digest.as_lossless().clone());
    operation.time_created = 2001;
    operation.time_updated = 2001;
    fixture
        .db
        .submit(move |tx| ycoding_store::artifacts::OperationTable::insert(tx, &operation))
        .unwrap()
        .wait()
        .unwrap();
    let path = fixture.root.join("home/.agents/skills/review/SKILL.md");
    assert_eq!(
        fixture
            .service
            .reconcile(&written.scope_id)
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("DestinationExists".into())
    );
    assert!(!path.exists());
    std::fs::write(&path, "Unowned destination").unwrap();
    assert_eq!(
        fixture
            .service
            .reconcile(&written.scope_id)
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("DestinationExists".into())
    );
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "Unowned destination"
    );
    assert_eq!(
        fixture.service.get_trash(&deletion).unwrap().definition,
        definition()
    );
    std::fs::remove_file(&path).unwrap();
    fixture.sources.lock().unwrap().remove("fixture-global");
    fixture.service.reconcile(&written.scope_id).unwrap();
    fixture.service.reconcile(&written.scope_id).unwrap();
    assert_eq!(
        fixture
            .service
            .get(&written.scope_id, &written.kind, &written.id)
            .unwrap()
            .current_version
            .id,
        written.version_id
    );
    let feedback = fixture
        .db
        .snapshot()
        .unwrap()
        .scan::<ycoding_store::artifacts::FeedbackTable>(
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
            128,
        )
        .unwrap();
    assert_eq!(
        feedback
            .iter()
            .filter(|row| row.action.as_str() == Some("restore"))
            .count(),
        1
    );
    assert_eq!(
        fixture
            .service
            .get_trash(&deletion)
            .err()
            .unwrap()
            .code
            .encode(),
        JsonValue::String("DeletionNotFound".into())
    );
}
#[test]
fn fork_copies_literal_global_bytes_and_provenance_then_shadow_is_idempotent() {
    let fixture = Fixture::new();
    let written = global(&fixture);
    let project_id = project();
    let preview = fixture
        .service
        .preview_fork(store::ForkPreviewInput {
            project_id: &project_id,
            kind: &written.kind,
            id: &written.id,
            expected_revision: None,
            expected_version_id: &written.version_id,
            expected_digest: &written.content_digest,
            now: 2000,
        })
        .unwrap();
    let forked = fixture.service.confirm_fork(&preview.token, 2001).unwrap();
    assert_ne!(forked.version_id, written.version_id);
    assert_eq!(
        fixture
            .service
            .confirm_fork(&preview.token, 2002)
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("ConfirmationExpired".into())
    );
    let details = fixture
        .service
        .get(&forked.scope_id, &forked.kind, &forked.id)
        .unwrap();
    assert_eq!(
        details.current_version.provenance.source.encode(),
        JsonValue::String("fork".into())
    );
    assert_eq!(
        details.current_version.provenance.origin_scope_id,
        Some(written.scope_id.clone())
    );
    assert_eq!(
        details.current_version.provenance.origin_version_id,
        Some(written.version_id.clone())
    );
    assert_eq!(
        details.artifact.shadowed_scope_id,
        Some(written.scope_id.clone())
    );
    assert_eq!(details.definition, definition());
    let expected = project_artifact::MutationExpectation {
        expected_revision: details.artifact.revision,
        expected_version_id: forked.version_id.clone(),
        expected_digest: forked.content_digest.clone(),
    };
    let global_expected = project_artifact::MutationExpectation {
        expected_revision: project_artifact::Revision::decode(&JsonValue::Number(0.0)).unwrap(),
        expected_version_id: written.version_id.clone(),
        expected_digest: written.content_digest.clone(),
    };
    let input = store::ShadowInput {
        project_id: &project_id,
        kind: &written.kind,
        id: &written.id,
        expected: &expected,
        global_scope_id: &written.scope_id,
        global_expected: &global_expected,
        now: 2003,
    };
    let shadow = fixture.service.preview_shadow(input).unwrap();
    fixture.service.confirm_shadow(&shadow.token, 2004).unwrap();
    assert_eq!(
        fixture
            .service
            .get(&forked.scope_id, &forked.kind, &forked.id)
            .unwrap()
            .artifact
            .revision,
        expected.expected_revision
    );
    let shadow = fixture
        .service
        .preview_shadow(store::ShadowInput { now: 2005, ..input })
        .unwrap();
    fixture.service.confirm_shadow(&shadow.token, 2006).unwrap();
    assert_eq!(
        fixture
            .service
            .get(&forked.scope_id, &forked.kind, &forked.id)
            .unwrap()
            .artifact
            .revision,
        expected.expected_revision
    );
    fixture.service.reconcile(&forked.scope_id).unwrap();
    assert_eq!(
        fixture
            .service
            .get(&forked.scope_id, &forked.kind, &forked.id)
            .unwrap()
            .current_version
            .id,
        forked.version_id
    );
}
#[test]
fn fork_rechecks_registry_bytes_destination_and_exact_token_expiry() {
    let fixture = Fixture::new();
    let written = global(&fixture);
    let project_id = project();
    let input = store::ForkPreviewInput {
        project_id: &project_id,
        kind: &written.kind,
        id: &written.id,
        expected_revision: None,
        expected_version_id: &written.version_id,
        expected_digest: &written.content_digest,
        now: 2000,
    };
    let preview = fixture.service.preview_fork(input).unwrap();
    assert_eq!(
        fixture
            .service
            .confirm_fork(&preview.token, 302_000)
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("ConfirmationExpired".into())
    );
    let preview = fixture
        .service
        .preview_fork(store::ForkPreviewInput { now: 3000, ..input })
        .unwrap();
    fixture.sources.lock().unwrap().replace(
        "project-collision".into(),
        vec![
            ycoding_core::resources::project_artifact::source_registry::Record {
                source:
                    ycoding_core::resources::project_artifact::source_registry::StandardSource {
                        scope: "project".into(),
                        managed_scope_id: None,
                        managed_version_id: None,
                        managed_digest: None,
                    },
                project_id: Some(project_id.clone()),
                kind: written.kind.clone(),
                id: written.id.clone(),
                path: None,
            },
        ],
    );
    assert_eq!(
        fixture
            .service
            .confirm_fork(&preview.token, 3001)
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("ArtifactCollision".into())
    );
    fixture.sources.lock().unwrap().remove("project-collision");
    let preview = fixture
        .service
        .preview_fork(store::ForkPreviewInput { now: 4000, ..input })
        .unwrap();
    std::fs::write(
        fixture.root.join("home/.agents/skills/review/SKILL.md"),
        "Tampered bytes",
    )
    .unwrap();
    assert_eq!(
        fixture
            .service
            .confirm_fork(&preview.token, 4001)
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("OwnershipMismatch".into())
    );
    assert!(
        fixture
            .service
            .list(
                &fixture
                    .service
                    .resolve_project_scope(&project_id)
                    .unwrap()
                    .id,
                None,
                None
            )
            .unwrap()
            .is_empty()
    );
}
#[test]
fn shadow_retargets_fork_origin_and_rechecks_both_versions_without_rewriting_bytes() {
    let fixture = Fixture::new();
    let global = global(&fixture);
    let project_id = project();
    let preview = fixture
        .service
        .preview_fork(store::ForkPreviewInput {
            project_id: &project_id,
            kind: &global.kind,
            id: &global.id,
            expected_revision: None,
            expected_version_id: &global.version_id,
            expected_digest: &global.content_digest,
            now: 1100,
        })
        .unwrap();
    let existing = fixture.service.confirm_fork(&preview.token, 1101).unwrap();
    let global_expected = project_artifact::MutationExpectation {
        expected_revision: project_artifact::Revision::decode(&JsonValue::Number(0.0)).unwrap(),
        expected_version_id: global.version_id,
        expected_digest: global.content_digest,
    };
    let updated = project_artifact::Definition::decode(&parse_json(r#"{"kind":"skill","name":"Review","description":"Reusable review","content":"Updated global review."}"#).unwrap()).unwrap();
    let preview = fixture
        .service
        .preview_manual(store::ManualPreviewInput {
            id: "review",
            definition: &updated,
            expected: Some(global_expected),
            now: 1200,
        })
        .unwrap();
    let global = fixture
        .service
        .confirm_manual(&preview.token, 1201)
        .unwrap();
    register_global(&fixture, &global);
    let expected = project_artifact::MutationExpectation {
        expected_revision: project_artifact::Revision::decode(&JsonValue::Number(0.0)).unwrap(),
        expected_version_id: existing.version_id.clone(),
        expected_digest: existing.content_digest.clone(),
    };
    let global_expected = project_artifact::MutationExpectation {
        expected_revision: project_artifact::Revision::decode(&JsonValue::Number(1.0)).unwrap(),
        expected_version_id: global.version_id.clone(),
        expected_digest: global.content_digest.clone(),
    };
    let input = store::ShadowInput {
        project_id: &project_id,
        kind: &existing.kind,
        id: &existing.id,
        expected: &expected,
        global_scope_id: &global.scope_id,
        global_expected: &global_expected,
        now: 2000,
    };
    let preview = fixture.service.preview_shadow(input).unwrap();
    fixture
        .service
        .confirm_shadow(&preview.token, 2001)
        .unwrap();
    let linked = fixture
        .service
        .get(&existing.scope_id, &existing.kind, &existing.id)
        .unwrap();
    assert_eq!(linked.artifact.revision.encode(), JsonValue::Number(1.0));
    assert_eq!(linked.current_version.id, existing.version_id);
    assert_eq!(
        linked.current_version.provenance.origin_version_id,
        Some(global.version_id.clone())
    );
    assert_eq!(linked.definition, definition());
    let expected = project_artifact::MutationExpectation {
        expected_revision: linked.artifact.revision,
        expected_version_id: linked.current_version.id,
        expected_digest: linked.current_version.content_digest,
    };
    let preview = fixture
        .service
        .preview_shadow(store::ShadowInput {
            expected: &expected,
            now: 3000,
            ..input
        })
        .unwrap();
    std::fs::write(
        fixture.root.join("home/.agents/skills/review/SKILL.md"),
        "Tampered global bytes",
    )
    .unwrap();
    assert_eq!(
        fixture
            .service
            .confirm_shadow(&preview.token, 3001)
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("OwnershipMismatch".into())
    );
    assert_eq!(
        fixture
            .service
            .get(&existing.scope_id, &existing.kind, &existing.id)
            .unwrap()
            .artifact
            .revision,
        expected.expected_revision
    );
}
#[test]
fn shadow_preserves_the_store_origin_constraint_without_partial_graph_writes() {
    let fixture = Fixture::new();
    let existing = fixture.service.write_manual(manual(&definition())).unwrap();
    let global = global(&fixture);
    let project_id = project();
    let expected = project_artifact::MutationExpectation {
        expected_revision: project_artifact::Revision::decode(&JsonValue::Number(0.0)).unwrap(),
        expected_version_id: existing.version_id.clone(),
        expected_digest: existing.content_digest.clone(),
    };
    let global_expected = project_artifact::MutationExpectation {
        expected_revision: project_artifact::Revision::decode(&JsonValue::Number(0.0)).unwrap(),
        expected_version_id: global.version_id.clone(),
        expected_digest: global.content_digest.clone(),
    };
    let preview = fixture
        .service
        .preview_shadow(store::ShadowInput {
            project_id: &project_id,
            kind: &existing.kind,
            id: &existing.id,
            expected: &expected,
            global_scope_id: &global.scope_id,
            global_expected: &global_expected,
            now: 2000,
        })
        .unwrap();
    assert_eq!(
        fixture
            .service
            .confirm_shadow(&preview.token, 2001)
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("ReconciliationRequired".into())
    );
    let unchanged = fixture
        .service
        .get(&existing.scope_id, &existing.kind, &existing.id)
        .unwrap();
    assert_eq!(unchanged.artifact.revision, expected.expected_revision);
    assert_eq!(unchanged.artifact.shadowed_scope_id, None);
    assert_eq!(unchanged.current_version.provenance.origin_scope_id, None);
    assert_eq!(
        unchanged.current_version.provenance.source.encode(),
        JsonValue::String("user".into())
    );
    assert_eq!(
        fixture
            .service
            .confirm_shadow(&preview.token, 2002)
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("ConfirmationExpired".into())
    );
}
fn manual<'a>(definition: &'a project_artifact::Definition) -> store::ManualWriteInput<'a> {
    store::ManualWriteInput {
        scope: project_artifact::ScopeSelector::Project,
        project_id: Some(project()),
        id: "review",
        definition,
        expected: None,
        now: 1000,
    }
}

#[test]
fn write_results_report_retained_artifact_version_and_owned_byte_capacity() {
    let fixture = Fixture::new();
    let written = fixture.service.write_manual(manual(&definition())).unwrap();
    assert_eq!(written.remaining.project_artifacts, 31.0);
    assert_eq!(written.remaining.versions, 15.0);
    assert!(written.remaining.bytes < 8.0 * 1024.0 * 1024.0);
}

fn automatic<'a>(
    definition: &'a JsonValue,
    id: &'a str,
    insight: &'a str,
    now: i64,
) -> store::AutomaticWriteInput<'a> {
    store::AutomaticWriteInput {
        project_id: project(),
        session_id: ycoding_schema::session::Id::decode(&JsonValue::String(
            "ses_quota_session".into(),
        ))
        .unwrap(),
        agent_id: Some("reviewer".into()),
        insight_key: insight,
        id,
        definition,
        base_version_id: None,
        now,
    }
}

#[test]
fn automatic_retries_normalize_insights_preserve_identity_and_do_not_charge_quota() {
    let fixture = Fixture::new();
    let definition = definition().encode();
    let first = fixture
        .service
        .write_automatic(automatic(
            &definition,
            "first",
            "ＦＯＣＵＳ   Check",
            1_000_000,
        ))
        .unwrap();
    let retried = fixture
        .service
        .write_automatic(automatic(&definition, "first", "focus check", 1_000_001))
        .unwrap();
    assert_eq!(retried.version_id, first.version_id);
    assert_eq!(retried.remaining.session, 2.0);
    assert_eq!(retried.remaining.project_artifacts, 31.0);
    assert_eq!(
        fixture
            .service
            .write_automatic(automatic(&definition, "other", "focus check", 1_000_002))
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("VersionConflict".into())
    );
    let mut update = automatic(&definition, "first", "new insight", 1_000_003);
    update.base_version_id = Some(first.version_id.clone());
    let reconciled = fixture.service.write_automatic(update).unwrap();
    assert_eq!(
        reconciled.result.encode(),
        JsonValue::String("reconciled".into())
    );
    assert_eq!(reconciled.version_id, first.version_id);
    assert_eq!(reconciled.remaining.session, 2.0);
    fixture
        .service
        .write_automatic(automatic(
            &definition,
            "second",
            "second insight",
            1_000_004,
        ))
        .unwrap();
    fixture
        .service
        .write_automatic(automatic(&definition, "third", "third insight", 1_000_005))
        .unwrap();
    assert_eq!(
        fixture
            .service
            .write_automatic(automatic(
                &definition,
                "fourth",
                "fourth insight",
                1_000_006
            ))
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("WriteRateExceeded".into())
    );
    let details = fixture
        .service
        .get(&first.scope_id, &first.kind, &first.id)
        .unwrap();
    assert_eq!(details.versions.len(), 1);
    assert_eq!(
        details.current_version.provenance.source.encode(),
        JsonValue::String("agent".into())
    );
    assert_eq!(
        details.current_version.provenance.creator_agent_id,
        Some("reviewer".into())
    );
}

#[test]
fn automatic_updates_enforce_base_version_cooldown_and_literal_deterministic_ids() {
    let fixture = Fixture::new();
    let original = definition().encode();
    let first = fixture
        .service
        .write_automatic(automatic(&original, "review", "create", 1_000_000))
        .unwrap();
    let mut changed = definition();
    if let project_artifact::Definition::Skill(skill) = &mut changed {
        skill.content = project_artifact::SkillContent::decode(&JsonValue::String(
            "Review changed behavior.".into(),
        ))
        .unwrap();
    }
    let changed = changed.encode();
    assert_eq!(
        fixture
            .service
            .write_automatic(automatic(&changed, "review", "update", 4_600_000))
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("VersionConflict".into())
    );
    let mut early = automatic(&changed, "review", "update", 4_599_999);
    early.base_version_id = Some(first.version_id.clone());
    assert_eq!(
        fixture
            .service
            .write_automatic(early)
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("ArtifactCooldown".into())
    );
    let mut ready = automatic(&changed, "review", "update", 4_600_000);
    ready.base_version_id = Some(first.version_id.clone());
    let updated = fixture.service.write_automatic(ready).unwrap();
    assert_eq!(updated.result.encode(), JsonValue::String("updated".into()));
    assert_ne!(updated.version_id, first.version_id);
    assert_eq!(updated.remaining.versions, 14.0);
    let details = fixture
        .service
        .get(&updated.scope_id, &updated.kind, &updated.id)
        .unwrap();
    assert_eq!(
        details.current_version.parent_version_id,
        Some(first.version_id)
    );
    assert_eq!(details.versions.len(), 2);
}

#[test]
fn concurrent_automatic_cross_id_writes_reserve_only_the_third_session_slot() {
    let fixture = Fixture::new();
    let definition = definition().encode();
    fixture
        .service
        .write_automatic(automatic(&definition, "one", "one", 8_000_000))
        .unwrap();
    fixture
        .service
        .write_automatic(automatic(&definition, "two", "two", 8_000_001))
        .unwrap();
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let threads = ["three", "four"].map(|id| {
        let service = fixture.service.clone();
        let definition = definition.clone();
        let barrier = barrier.clone();
        std::thread::spawn(move || {
            barrier.wait();
            service.write_automatic(automatic(&definition, id, id, 8_000_002))
        })
    });
    let outcomes = threads.map(|thread| thread.join().unwrap());
    assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        outcomes
            .iter()
            .filter(|result| result.as_ref().is_err_and(
                |error| error.code.encode() == JsonValue::String("WriteRateExceeded".into())
            ))
            .count(),
        1
    );
}

#[test]
fn automatic_daily_and_per_kind_quotas_include_manual_artifacts_and_expire_old_writes() {
    let fixture = Fixture::new();
    let definition = definition().encode();
    for index in 0..10 {
        let id = format!("daily-{index}");
        let mut input = automatic(&definition, &id, &id, 30_000_000 + index);
        input.session_id = ycoding_schema::session::Id::decode(&JsonValue::String(
            format!("ses_daily_{index}").into(),
        ))
        .unwrap();
        fixture.service.write_automatic(input).unwrap();
    }
    let mut blocked = automatic(&definition, "daily-blocked", "daily-blocked", 30_000_010);
    blocked.session_id =
        ycoding_schema::session::Id::decode(&JsonValue::String("ses_daily_blocked".into()))
            .unwrap();
    assert_eq!(
        fixture
            .service
            .write_automatic(blocked)
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("WriteRateExceeded".into())
    );
    let expired = fixture
        .service
        .write_automatic(automatic(
            &definition,
            "expired",
            "expired",
            30_000_010 + 30 * 86_400_000,
        ))
        .unwrap();
    assert_eq!(expired.remaining.session, 2.0);
    assert_eq!(
        fixture
            .db
            .snapshot()
            .unwrap()
            .scan::<ycoding_store::artifacts::WriteTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                128
            )
            .unwrap()
            .len(),
        1
    );

    for (definition, cap) in [
        (definition.clone(), 24),
        (parse_json(r#"{"kind":"command","name":"Check","description":"Focused check","template":"Check focused behavior.","subtask":false}"#).unwrap(), 8),
        (parse_json(r#"{"kind":"agent","name":"Review","description":"Focused review","mode":"subagent","system":"Review focused behavior.","permissions":[{"action":"read","effect":"allow","resource":"*"}]}"#).unwrap(), 4),
    ] {
        let fixture = Fixture::new();
        let decoded = project_artifact::Definition::decode(&definition).unwrap();
        for index in 0..cap {
            let id = format!("seed-{index}");
            fixture.service.write_manual(store::ManualWriteInput { id: &id, ..manual(&decoded) }).unwrap();
        }
        assert_eq!(fixture.service.write_automatic(automatic(&definition, "over-cap", "over-cap", 40_000_000)).unwrap_err().code.encode(), JsonValue::String("ScopeQuotaExceeded".into()));
    }
}

#[test]
fn concurrent_automatic_writes_reserve_only_the_thirty_second_live_artifact() {
    let fixture = Fixture::new();
    let skill = definition();
    let command = project_artifact::Definition::decode(&parse_json(r#"{"kind":"command","name":"Check","description":"Focused check","template":"Check focused behavior.","subtask":false}"#).unwrap()).unwrap();
    let agent = project_artifact::Definition::decode(&parse_json(r#"{"kind":"agent","name":"Review","description":"Focused review","mode":"subagent","system":"Review focused behavior.","permissions":[{"action":"read","effect":"allow","resource":"*"}]}"#).unwrap()).unwrap();
    for index in 0..31 {
        let id = format!("seed-{index}");
        let definition = if index < 23 {
            &skill
        } else if index < 30 {
            &command
        } else {
            &agent
        };
        fixture
            .service
            .write_manual(store::ManualWriteInput {
                id: &id,
                ..manual(definition)
            })
            .unwrap();
    }
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let threads = ["last-a", "last-b"].map(|id| {
        let service = fixture.service.clone();
        let definition = agent.encode();
        let barrier = barrier.clone();
        std::thread::spawn(move || {
            barrier.wait();
            let mut input = automatic(&definition, id, id, 31_000_000);
            input.session_id =
                ycoding_schema::session::Id::decode(&JsonValue::String(format!("ses_{id}").into()))
                    .unwrap();
            service.write_automatic(input)
        })
    });
    let outcomes = threads.map(|thread| thread.join().unwrap());
    assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        outcomes
            .iter()
            .filter(|result| result.as_ref().is_err_and(
                |error| error.code.encode() == JsonValue::String("ScopeQuotaExceeded".into())
            ))
            .count(),
        1
    );
    assert_eq!(
        fixture
            .service
            .list(
                &fixture
                    .service
                    .resolve_project_scope(&project())
                    .unwrap()
                    .id,
                None,
                None
            )
            .unwrap()
            .len(),
        32
    );
}

#[test]
fn automatic_version_limit_counts_retained_versions_and_owned_bytes_ignore_unrelated_files() {
    let fixture = Fixture::new();
    let definition = definition().encode();
    let first = fixture
        .service
        .write_automatic(automatic(
            &definition,
            "version-cap",
            "version-cap",
            33_000_000,
        ))
        .unwrap();
    let snapshot = fixture.db.snapshot().unwrap();
    let row = snapshot
        .get::<ycoding_store::artifacts::VersionTable>(&ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(first.version_id.as_lossless()),
        ]))
        .unwrap()
        .unwrap();
    drop(snapshot);
    fixture
        .db
        .submit(move |tx| {
            for index in 0..15 {
                let mut version = row.clone();
                version.id = format!("pav_seed-{index}").into();
                version.content_digest = package::sha256(&format!("seed {index}").as_str().into())
                    .as_lossless()
                    .clone();
                version.parent_version_id = Some(row.id.clone());
                version.state = "superseded".into();
                ycoding_store::artifacts::VersionTable::insert(tx, &version)?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let changed = parse_json(r#"{"kind":"skill","name":"Review","description":"Reusable review","content":"Review another behavior."}"#).unwrap();
    let mut update = automatic(&changed, "version-cap", "update", 36_600_000);
    update.base_version_id = Some(first.version_id.clone());
    assert_eq!(
        fixture
            .service
            .write_automatic(update)
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("ScopeQuotaExceeded".into())
    );
    let scope = fixture.service.resolve_project_scope(&project()).unwrap();
    let root = fixture
        .root
        .join("data/project-artifacts")
        .join(scope.storage_id.as_lossless().as_str().unwrap());
    std::fs::write(root.join("unrelated.bin"), vec![0u8; 8 * 1024 * 1024]).unwrap();
    fixture
        .service
        .write_automatic(automatic(
            &definition,
            "unrelated-safe",
            "unrelated-safe",
            36_600_001,
        ))
        .unwrap();
    let content = "x".repeat(8 * 1024 * 1024);
    let marker = package::marker(package::MarkerInput {
        scope_id: scope.id,
        storage_id: scope.storage_id,
        kind: first.kind,
        id: project_artifact::Id::decode(&JsonValue::String("owned-filler".into())).unwrap(),
        version_id: project_artifact::VersionId::decode(&JsonValue::String("pav_filler".into()))
            .unwrap(),
        content: content.as_str().into(),
    });
    package::commit(
        package::CommitInput {
            root: &root,
            marker: &marker,
            content: &content.as_str().into(),
            expected_version_id: None,
            operation_id: None,
            standard: None,
            no_overwrite: false,
        },
        &Default::default(),
    )
    .unwrap();
    assert_eq!(
        fixture
            .service
            .write_automatic(automatic(
                &definition,
                "owned-blocked",
                "owned-blocked",
                36_600_002
            ))
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("ScopeQuotaExceeded".into())
    );
}

#[test]
fn automatic_retry_finishes_an_available_package_without_double_charging_reserved_slot() {
    let fixture = Fixture::new();
    fixture
        .db
        .submit(|tx| {
            ycoding_store::artifacts::ScopeTable::insert(
                tx,
                &ycoding_store::artifacts::Scope {
                    id: "pas_fixed".into(),
                    type_: "project".into(),
                    storage_id: "11111111-1111-4111-8111-111111111111".into(),
                    time_created: 0,
                    time_updated: 0,
                },
            )?;
            ycoding_store::artifacts::ProjectScopeTable::insert(
                tx,
                &ycoding_store::artifacts::ProjectScope {
                    scope_id: "pas_fixed".into(),
                    project_id: "project".into(),
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let scope = fixture.service.resolve_project_scope(&project()).unwrap();
    let definition = definition().encode();
    fixture
        .service
        .write_automatic(automatic(&definition, "one", "one", 1_000_000))
        .unwrap();
    fixture
        .service
        .write_automatic(automatic(&definition, "two", "two", 1_000_001))
        .unwrap();
    let root = fixture
        .root
        .join("data/project-artifacts")
        .join(scope.storage_id.as_lossless().as_str().unwrap());
    let version_id = project_artifact::VersionId::decode(&JsonValue::String(
        "pav_84dc108deefcca51fd5339ab7c404f1e".into(),
    ))
    .unwrap();
    let marker = package::marker(package::MarkerInput {
        scope_id: scope.id,
        storage_id: scope.storage_id,
        kind: project_artifact::Kind::decode(&JsonValue::String("skill".into())).unwrap(),
        id: project_artifact::Id::decode(&JsonValue::String("recover".into())).unwrap(),
        version_id: version_id.clone(),
        content: adapter::render(&project_artifact::Definition::decode(&definition).unwrap()),
    });
    let operation_id = "pop_fafc8f6d7801aaf63d79ad3fc4061c4a";
    let content = adapter::render(&project_artifact::Definition::decode(&definition).unwrap());
    let prepared = package::prepare_commit(
        package::CommitInput {
            root: &root,
            marker: &marker,
            content: &content,
            expected_version_id: None,
            operation_id: Some(operation_id),
            standard: None,
            no_overwrite: false,
        },
        &Default::default(),
    )
    .unwrap();
    package::make_available(&prepared, &Default::default()).unwrap();
    fixture
        .db
        .submit(move |tx| {
            ycoding_store::artifacts::OperationTable::insert(
                tx,
                &ycoding_store::artifacts::Operation {
                    id: operation_id.into(),
                    scope_id: "pas_fixed".into(),
                    kind: "skill".into(),
                    artifact_id: "recover".into(),
                    operation: "create".into(),
                    request_fingerprint:
                        "fafc8f6d7801aaf63d79ad3fc4061c4a7ea7c025d99d2917a246e02d75f560db".into(),
                    expected_revision: None,
                    expected_version_id: None,
                    expected_digest: None,
                    source_scope_id: None,
                    source_version_id: None,
                    source_digest: None,
                    target_version_id: Some("pav_84dc108deefcca51fd5339ab7c404f1e".into()),
                    target_digest: Some(
                        "dececb15aa76c55ecda31e851c93b3dbd7420e82aff5a50fb8714bb67befcc42".into(),
                    ),
                    final_version_id: None,
                    deletion_id: None,
                    automatic_session_id: Some("ses_quota_session".into()),
                    automatic_insight_digest: Some(
                        "ec3915f542e0f8cb6c1832fbb0389a011fe48b6a82e37f7940e274bf23020776".into(),
                    ),
                    phase: "available".into(),
                    time_created: 1_000_002,
                    time_updated: 1_000_002,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let recovered = fixture
        .service
        .write_automatic(automatic(&definition, "recover", "recover", 1_000_010))
        .unwrap();
    assert_eq!(recovered.version_id, version_id);
    assert_eq!(recovered.remaining.session, 0.0);
    assert!(
        package::read_commit_transactions(&root, &Default::default())
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        fixture
            .service
            .get(&recovered.scope_id, &recovered.kind, &recovered.id)
            .unwrap()
            .versions
            .len(),
        1
    );
}

#[test]
fn general_recovery_finishes_shared_journal_and_preserves_exact_version_on_repeated_scan() {
    let fixture = Fixture::new();
    let scope = fixture.service.resolve_project_scope(&project()).unwrap();
    let root = fixture
        .root
        .join("data/project-artifacts")
        .join(scope.storage_id.as_lossless().as_str().unwrap());
    let content = adapter::render(&definition());
    let marker = package::marker(package::MarkerInput {
        scope_id: scope.id.clone(),
        storage_id: scope.storage_id.clone(),
        kind: project_artifact::Kind::decode(&JsonValue::String("skill".into())).unwrap(),
        id: project_artifact::Id::decode(&JsonValue::String("recover-shared".into())).unwrap(),
        version_id: project_artifact::VersionId::decode(&JsonValue::String(
            "pav_recover-shared".into(),
        ))
        .unwrap(),
        content: content.clone(),
    });
    let operation = ycoding_store::artifacts::Operation {
        id: "pop_recover-shared".into(),
        scope_id: scope.id.as_lossless().clone(),
        kind: "skill".into(),
        artifact_id: "recover-shared".into(),
        operation: "create".into(),
        request_fingerprint: package::sha256(&"shared recovery".into())
            .as_lossless()
            .clone(),
        expected_revision: None,
        expected_version_id: None,
        expected_digest: None,
        source_scope_id: None,
        source_version_id: None,
        source_digest: None,
        target_version_id: Some(marker.version_id.as_lossless().clone()),
        target_digest: Some(marker.content_digest.as_lossless().clone()),
        final_version_id: None,
        deletion_id: None,
        automatic_session_id: None,
        automatic_insight_digest: None,
        phase: "preparing".into(),
        time_created: 6500000,
        time_updated: 6500000,
    };
    fixture
        .db
        .submit(move |tx| ycoding_store::artifacts::OperationTable::insert(tx, &operation))
        .unwrap()
        .wait()
        .unwrap();
    let prepared = package::prepare_commit(
        package::CommitInput {
            root: &root,
            marker: &marker,
            content: &content,
            expected_version_id: None,
            operation_id: Some("pop_recover-shared"),
            standard: None,
            no_overwrite: false,
        },
        &Default::default(),
    )
    .unwrap();
    package::make_available(&prepared, &Default::default()).unwrap();
    assert_eq!(
        fixture.service.reconcile(&scope.id).unwrap(),
        vec![marker.clone()]
    );
    assert_eq!(
        fixture.service.reconcile(&scope.id).unwrap(),
        vec![marker.clone()]
    );
    let details = fixture
        .service
        .get(&scope.id, &marker.kind, &marker.id)
        .unwrap();
    assert_eq!(details.current_version.id, marker.version_id);
    assert_eq!(
        details.current_version.provenance.source.encode(),
        JsonValue::String("user".into())
    );
    assert_eq!(details.artifact.revision.get(), 0);
    assert!(
        package::read_commit_transactions(&root, &Default::default())
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        fixture
            .db
            .snapshot()
            .unwrap()
            .get::<ycoding_store::artifacts::OperationTable>(&ycoding_store::tuple_key(&[
                ycoding_store::KeyPart::String(&"pop_recover-shared".into())
            ]))
            .unwrap()
            .unwrap()
            .phase,
        "finalized".into()
    );
}

#[test]
fn general_recovery_folds_owned_markers_and_disables_missing_bytes_without_feedback() {
    let fixture = Fixture::new();
    let created = fixture.service.write_manual(manual(&definition())).unwrap();
    let scope = fixture.service.resolve_project_scope(&project()).unwrap();
    let root = fixture
        .root
        .join("data/project-artifacts")
        .join(scope.storage_id.as_lossless().as_str().unwrap());
    std::fs::remove_file(package::active_content_path(
        &root,
        &created.kind,
        &created.id,
    ))
    .unwrap();
    fixture.service.reconcile(&scope.id).unwrap();
    let row = fixture
        .db
        .snapshot()
        .unwrap()
        .get::<ycoding_store::artifacts::ArtifactTable>(&ycoding_store::artifacts::identity(
            scope.id.as_lossless(),
            created.kind.as_lossless(),
            created.id.as_lossless(),
        ))
        .unwrap()
        .unwrap();
    assert_eq!(row.stage, "disabled".into());
    assert_eq!(row.revision, 1);
    assert!(
        fixture
            .db
            .snapshot()
            .unwrap()
            .scan::<ycoding_store::artifacts::FeedbackTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                128
            )
            .unwrap()
            .is_empty()
    );
    let content = "A quarantined plugin draft.";
    let marker = package::marker(package::MarkerInput {
        scope_id: scope.id.clone(),
        storage_id: scope.storage_id.clone(),
        kind: project_artifact::Kind::decode(&JsonValue::String("plugin".into())).unwrap(),
        id: project_artifact::Id::decode(&JsonValue::String("draft".into())).unwrap(),
        version_id: project_artifact::VersionId::decode(&JsonValue::String("pav_draft".into()))
            .unwrap(),
        content: content.into(),
    });
    package::commit(
        package::CommitInput {
            root: &root,
            marker: &marker,
            content: &content.into(),
            expected_version_id: None,
            operation_id: None,
            standard: None,
            no_overwrite: false,
        },
        &Default::default(),
    )
    .unwrap();
    fixture.service.reconcile(&scope.id).unwrap();
    let details = fixture
        .service
        .get(&scope.id, &marker.kind, &marker.id)
        .unwrap();
    assert_eq!(
        details.artifact.stage.encode(),
        JsonValue::String("quarantine".into())
    );
    assert_eq!(
        details.current_version.provenance.source.encode(),
        JsonValue::String("restore".into())
    );
}

#[test]
fn general_recovery_indexes_unrecorded_trash_restores_and_rebuilds_owned_global_index() {
    let fixture = Fixture::new();
    let created = fixture.service.write_manual(manual(&definition())).unwrap();
    let scope = fixture.service.resolve_project_scope(&project()).unwrap();
    let root = fixture
        .root
        .join("data/project-artifacts")
        .join(scope.storage_id.as_lossless().as_str().unwrap());
    let marker = package::read_active(&root, &created.kind, &created.id, &Default::default())
        .unwrap()
        .unwrap();
    let deletion =
        project_artifact::DeletionId::decode(&JsonValue::String("pad_recovered".into())).unwrap();
    package::trash(
        package::TrashInput {
            root: &root,
            marker: &marker,
            deletion_id: &deletion,
            prior_stage: Some(&created.stage),
            deleted_at: Some(1000),
            now: Some(1000),
            standard: None,
        },
        &Default::default(),
    )
    .unwrap();
    fixture.service.reconcile(&scope.id).unwrap();
    assert_eq!(
        fixture
            .db
            .snapshot()
            .unwrap()
            .get::<ycoding_store::artifacts::TrashTable>(&ycoding_store::tuple_key(&[
                ycoding_store::KeyPart::String(deletion.as_lossless())
            ]))
            .unwrap()
            .unwrap()
            .deleted_at,
        1000
    );
    assert!(
        fixture
            .service
            .list(&scope.id, None, None)
            .unwrap()
            .is_empty()
    );
    package::restore(
        package::TrashInput {
            root: &root,
            marker: &marker,
            deletion_id: &deletion,
            prior_stage: None,
            deleted_at: None,
            now: Some(1001),
            standard: None,
        },
        &Default::default(),
    )
    .unwrap();
    fixture.service.reconcile(&scope.id).unwrap();
    assert_eq!(
        fixture.service.list(&scope.id, None, None).unwrap().len(),
        1
    );
    assert!(
        fixture
            .db
            .snapshot()
            .unwrap()
            .get::<ycoding_store::artifacts::TrashTable>(&ycoding_store::tuple_key(&[
                ycoding_store::KeyPart::String(deletion.as_lossless())
            ]))
            .unwrap()
            .is_none()
    );
    let expected = project_artifact::MutationExpectation {
        expected_revision: project_artifact::Revision::decode(&JsonValue::Number(0.0)).unwrap(),
        expected_version_id: created.version_id.clone(),
        expected_digest: created.content_digest.clone(),
    };
    let preview = fixture
        .service
        .preview_promotion(store::LifecycleInput {
            scope_id: &created.scope_id,
            kind: &created.kind,
            id: &created.id,
            expected: &expected,
            now: 1002,
        })
        .unwrap();
    let promoted = fixture
        .service
        .confirm_promotion(&preview.token, 1003)
        .unwrap();
    let destination = promoted.scope_id.clone();
    fixture
        .db
        .submit(move |tx| {
            let rows = tx.scan::<ycoding_store::artifacts::OperationTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                128,
            )?;
            for row in rows
                .into_iter()
                .filter(|row| row.scope_id == *destination.as_lossless())
            {
                tx.delete::<ycoding_store::artifacts::OperationTable>(&ycoding_store::tuple_key(
                    &[ycoding_store::KeyPart::String(&row.id)],
                ))?;
            }
            ycoding_store::artifacts::delete_artifact(
                tx,
                destination.as_lossless(),
                &"skill".into(),
                &"review".into(),
            )?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    fixture.service.reconcile(&promoted.scope_id).unwrap();
    assert_eq!(
        fixture
            .service
            .get(&promoted.scope_id, &promoted.kind, &promoted.id)
            .unwrap()
            .current_version
            .id,
        promoted.version_id
    );
}

#[test]
fn general_recovery_aborts_only_preparing_orphans_and_rejects_unowned_shared_journal() {
    for phase in ["preparing", "available"] {
        let fixture = Fixture::new();
        let scope = fixture.service.resolve_project_scope(&project()).unwrap();
        let operation = ycoding_store::artifacts::Operation {
            id: "pop_orphan".into(),
            scope_id: scope.id.as_lossless().clone(),
            kind: "skill".into(),
            artifact_id: "orphan".into(),
            operation: "create".into(),
            request_fingerprint: package::sha256(&"orphan".into()).as_lossless().clone(),
            expected_revision: None,
            expected_version_id: None,
            expected_digest: None,
            source_scope_id: None,
            source_version_id: None,
            source_digest: None,
            target_version_id: Some("pav_orphan".into()),
            target_digest: Some(package::sha256(&"orphan".into()).as_lossless().clone()),
            final_version_id: None,
            deletion_id: None,
            automatic_session_id: None,
            automatic_insight_digest: None,
            phase: phase.into(),
            time_created: 1,
            time_updated: 1,
        };
        fixture
            .db
            .submit(move |tx| ycoding_store::artifacts::OperationTable::insert(tx, &operation))
            .unwrap()
            .wait()
            .unwrap();
        if phase == "available" {
            assert_eq!(
                fixture
                    .service
                    .reconcile(&scope.id)
                    .unwrap_err()
                    .code
                    .encode(),
                JsonValue::String("ReconciliationRequired".into())
            );
        } else {
            fixture.service.reconcile(&scope.id).unwrap();
            assert_eq!(
                fixture
                    .db
                    .snapshot()
                    .unwrap()
                    .get::<ycoding_store::artifacts::OperationTable>(&ycoding_store::tuple_key(&[
                        ycoding_store::KeyPart::String(&"pop_orphan".into())
                    ]))
                    .unwrap()
                    .unwrap()
                    .phase,
                "aborted".into()
            );
        }
    }
    let fixture = Fixture::new();
    let scope = fixture.service.resolve_project_scope(&project()).unwrap();
    let root = fixture
        .root
        .join("data/project-artifacts")
        .join(scope.storage_id.as_lossless().as_str().unwrap());
    let content = adapter::render(&definition());
    let marker = package::marker(package::MarkerInput {
        scope_id: scope.id.clone(),
        storage_id: scope.storage_id,
        kind: project_artifact::Kind::decode(&JsonValue::String("skill".into())).unwrap(),
        id: project_artifact::Id::decode(&JsonValue::String("unowned".into())).unwrap(),
        version_id: project_artifact::VersionId::decode(&JsonValue::String("pav_unowned".into()))
            .unwrap(),
        content: content.clone(),
    });
    let prepared = package::prepare_commit(
        package::CommitInput {
            root: &root,
            marker: &marker,
            content: &content,
            expected_version_id: None,
            operation_id: Some("pop_unowned"),
            standard: None,
            no_overwrite: false,
        },
        &Default::default(),
    )
    .unwrap();
    package::make_available(&prepared, &Default::default()).unwrap();
    assert_eq!(
        fixture
            .service
            .reconcile(&scope.id)
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("ReconciliationRequired".into())
    );
    assert_eq!(
        std::fs::read_to_string(package::active_content_path(
            &root,
            &marker.kind,
            &marker.id
        ))
        .unwrap(),
        content.as_str().unwrap()
    );
}

#[test]
fn trash_coordination_retains_all_owned_layouts_restores_exact_bytes_and_expires_at_thirty_days() {
    let fixture = Fixture::new();
    let first = fixture.service.write_manual(manual(&definition())).unwrap();
    let expected = project_artifact::MutationExpectation {
        expected_revision: project_artifact::Revision::decode(&JsonValue::Number(0.0)).unwrap(),
        expected_version_id: first.version_id.clone(),
        expected_digest: first.content_digest.clone(),
    };
    let input = store::LifecycleInput {
        scope_id: &first.scope_id,
        kind: &first.kind,
        id: &first.id,
        expected: &expected,
        now: 1000,
    };
    let trashed = fixture.service.remove(input).unwrap();
    assert_eq!(
        fixture.service.remove(input).unwrap().deletion_id,
        trashed.deletion_id
    );
    assert!(
        fixture
            .service
            .list(&first.scope_id, None, None)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        fixture
            .service
            .get_trash(&trashed.deletion_id)
            .unwrap()
            .definition,
        definition()
    );
    assert_eq!(
        fixture
            .service
            .restore(&trashed.deletion_id, 1000 + 30 * 86_400_000)
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("TrashExpired".into())
    );
    fixture.service.restore(&trashed.deletion_id, 1001).unwrap();
    fixture.service.restore(&trashed.deletion_id, 1002).unwrap();
    assert_eq!(
        fixture
            .service
            .get(&first.scope_id, &first.kind, &first.id)
            .unwrap()
            .current_version
            .id,
        first.version_id
    );
    let fixture = Fixture::new();
    let first = fixture.service.write_manual(manual(&definition())).unwrap();
    let expected = project_artifact::MutationExpectation {
        expected_revision: project_artifact::Revision::decode(&JsonValue::Number(0.0)).unwrap(),
        expected_version_id: first.version_id.clone(),
        expected_digest: first.content_digest.clone(),
    };
    fixture
        .service
        .remove(store::LifecycleInput {
            scope_id: &first.scope_id,
            kind: &first.kind,
            id: &first.id,
            expected: &expected,
            now: 1000,
        })
        .unwrap();
    assert_eq!(fixture.service.purge(1001).unwrap(), 0);
    assert_eq!(fixture.service.purge(1000 + 30 * 86_400_000).unwrap(), 1);
    assert!(
        fixture
            .service
            .list(&first.scope_id, None, None)
            .unwrap()
            .is_empty()
    );
}

fn governor_samples(
    accounting: &ycoding_core::resources::project_artifact::accounting::Service,
    written: &store::WriteResult,
    prefix: &str,
    at: i64,
    success_count: usize,
    managed: bool,
) {
    for index in 0..if managed { 20 } else { 30 } {
        let session = ycoding_schema::session::Id::decode(&JsonValue::String(
            format!("ses_{prefix}_{index}").into(),
        ))
        .unwrap();
        if managed {
            let activation = project_artifact::Activation::decode(
                &ycoding_schema::ObjectEncoder::new()
                    .field("id", format!("paa_{prefix}-{index}").as_str())
                    .field(
                        "artifact",
                        &ycoding_schema::ObjectEncoder::new()
                            .field("scopeID", &written.scope_id)
                            .field("kind", &written.kind)
                            .field("id", &written.id)
                            .field("versionID", &written.version_id)
                            .finish(),
                    )
                    .field("projectID", &project())
                    .field("sessionID", &session)
                    .field("source", "skill-tool")
                    .field("boundarySeq", &1.0)
                    .field("activatedAt", &((at - 100) as f64))
                    .finish(),
            )
            .unwrap();
            accounting.activate(&activation).unwrap();
        }
        let observed = ycoding_core::resources::project_artifact::accounting::ObserveInput::decode(
            &ycoding_schema::ObjectEncoder::new()
                .field("projectID", &project())
                .field("sessionID", &session)
                .field(
                    "terminalMessageID",
                    format!("terminal-{prefix}-{index}").as_str(),
                )
                .field("boundarySeq", &2.0)
                .field("kind", &written.kind)
                .field("modelID", "governor/model")
                .field("goalMode", &false)
                .field("standardInvocationCount", &0.0)
                .field("externalConfounded", &false)
                .field(
                    "terminalOutcome",
                    if index < success_count {
                        "succeeded"
                    } else {
                        "failed"
                    },
                )
                .field("goalStatus", "none")
                .field("repeatFix", &false)
                .field("observedAt", &((at - index as i64) as f64))
                .finish(),
        )
        .unwrap();
        accounting.observe(&observed).unwrap();
    }
}

#[test]
fn governor_coordinates_exact_activation_and_degradation_with_real_accounting_and_package_bytes() {
    let fixture = Fixture::new();
    let accounting = ycoding_core::resources::project_artifact::accounting::Service::new(
        fixture.db.client(),
        "private-test-bucket-key".into(),
    );
    let service = fixture.service.clone().with_accounting(accounting.clone());
    let written = service
        .write_manual(store::ManualWriteInput {
            now: 1,
            ..manual(&definition())
        })
        .unwrap();
    governor_samples(&accounting, &written, "good", 8 * 86_400_000, 20, true);
    let expected = project_artifact::MutationExpectation {
        expected_revision: project_artifact::Revision::decode(&JsonValue::Number(0.0)).unwrap(),
        expected_version_id: written.version_id.clone(),
        expected_digest: written.content_digest.clone(),
    };
    let input = store::LifecycleInput {
        scope_id: &written.scope_id,
        kind: &written.kind,
        id: &written.id,
        expected: &expected,
        now: 8 * 86_400_000,
    };
    assert_eq!(
        service
            .evaluate_governor(store::GovernorInput {
                artifact: input,
                agent_id: None,
                model_id: "governor/model".into(),
                goal_mode: false
            })
            .unwrap()
            .transition
            .action,
        "none"
    );
    assert_eq!(
        service
            .evaluate_governor(store::GovernorInput {
                artifact: store::LifecycleInput {
                    now: 9 * 86_400_000 - 1,
                    ..input
                },
                agent_id: None,
                model_id: "governor/model".into(),
                goal_mode: false
            })
            .unwrap()
            .transition
            .action,
        "none"
    );
    assert_eq!(
        service
            .evaluate_governor(store::GovernorInput {
                artifact: store::LifecycleInput {
                    now: 9 * 86_400_000,
                    ..input
                },
                agent_id: None,
                model_id: "governor/model".into(),
                goal_mode: false
            })
            .unwrap()
            .transition
            .action,
        "activate"
    );
    let active = service
        .get(&written.scope_id, &written.kind, &written.id)
        .unwrap();
    assert_eq!(
        active.artifact.stage.encode(),
        JsonValue::String("active".into())
    );
    governor_samples(&accounting, &written, "bad", 19 * 86_400_000, 2, true);
    governor_samples(
        &accounting,
        &written,
        "baseline",
        19 * 86_400_000,
        30,
        false,
    );
    let expected = project_artifact::MutationExpectation {
        expected_revision: active.artifact.revision,
        expected_version_id: written.version_id.clone(),
        expected_digest: written.content_digest.clone(),
    };
    let input = store::LifecycleInput {
        expected: &expected,
        now: 20 * 86_400_000,
        ..input
    };
    assert_eq!(
        service
            .evaluate_governor(store::GovernorInput {
                artifact: input,
                agent_id: None,
                model_id: "governor/model".into(),
                goal_mode: false
            })
            .unwrap()
            .transition
            .action,
        "none"
    );
    assert_eq!(
        service
            .evaluate_governor(store::GovernorInput {
                artifact: store::LifecycleInput {
                    now: 21 * 86_400_000,
                    ..input
                },
                agent_id: None,
                model_id: "governor/model".into(),
                goal_mode: false
            })
            .unwrap()
            .transition
            .action,
        "degrade"
    );
    let degraded = service
        .get(&written.scope_id, &written.kind, &written.id)
        .unwrap();
    assert_eq!(
        degraded.artifact.stage.encode(),
        JsonValue::String("degraded".into())
    );
    assert_eq!(degraded.definition, definition());
    let rows = fixture
        .db
        .snapshot()
        .unwrap()
        .scan::<ycoding_store::artifacts::FeedbackTable>(
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
            128,
        )
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].actor, "automatic-governor".into());
}
#[test]
fn governor_degradation_restores_durable_fallback_bytes_and_version_states_atomically() {
    let fixture = Fixture::new();
    let accounting = ycoding_core::resources::project_artifact::accounting::Service::new(
        fixture.db.client(),
        "fallback-test-key".into(),
    );
    let service = fixture.service.clone().with_accounting(accounting.clone());
    let first = service
        .write_automatic(automatic(
            &definition().encode(),
            "fallback",
            "fallback-first",
            1,
        ))
        .unwrap();
    let updated = project_artifact::Definition::decode(&parse_json(r#"{"kind":"skill","name":"Review","description":"Reusable review","content":"Review updated behavior."}"#).unwrap()).unwrap();
    let second = service
        .write_automatic(store::AutomaticWriteInput {
            base_version_id: Some(first.version_id.clone()),
            ..automatic(&updated.encode(), "fallback", "fallback-second", 3_600_001)
        })
        .unwrap();
    let identity = ycoding_store::artifacts::identity(
        second.scope_id.as_lossless(),
        second.kind.as_lossless(),
        second.id.as_lossless(),
    );
    let version_key = ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(
        second.version_id.as_lossless(),
    )]);
    fixture
        .db
        .submit(move |tx| {
            let mut artifact = tx
                .get::<ycoding_store::artifacts::ArtifactTable>(&identity)?
                .unwrap();
            artifact.stage = "active".into();
            ycoding_store::artifacts::ArtifactTable::put(tx, &artifact)?;
            let mut version = tx
                .get::<ycoding_store::artifacts::VersionTable>(&version_key)?
                .unwrap();
            version.state = "active".into();
            ycoding_store::artifacts::VersionTable::put(tx, &version)
        })
        .unwrap()
        .wait()
        .unwrap();
    governor_samples(
        &accounting,
        &second,
        "fallback-bad",
        7 * 86_400_000,
        2,
        true,
    );
    governor_samples(
        &accounting,
        &second,
        "fallback-base",
        7 * 86_400_000,
        30,
        false,
    );
    let expected = project_artifact::MutationExpectation {
        expected_revision: project_artifact::Revision::decode(&JsonValue::Number(1.0)).unwrap(),
        expected_version_id: second.version_id.clone(),
        expected_digest: second.content_digest.clone(),
    };
    let input = store::LifecycleInput {
        scope_id: &second.scope_id,
        kind: &second.kind,
        id: &second.id,
        expected: &expected,
        now: 8 * 86_400_000,
    };
    assert_eq!(
        service
            .evaluate_governor(store::GovernorInput {
                artifact: input,
                agent_id: None,
                model_id: "governor/model".into(),
                goal_mode: false
            })
            .unwrap()
            .transition
            .action,
        "none"
    );
    assert_eq!(
        service
            .evaluate_governor(store::GovernorInput {
                artifact: store::LifecycleInput {
                    now: 9 * 86_400_000,
                    ..input
                },
                agent_id: None,
                model_id: "governor/model".into(),
                goal_mode: false
            })
            .unwrap()
            .transition
            .action,
        "degrade"
    );
    let details = service
        .get(&second.scope_id, &second.kind, &second.id)
        .unwrap();
    assert_eq!(details.current_version.id, first.version_id);
    assert_eq!(details.artifact.revision.encode(), JsonValue::Number(2.0));
    assert_eq!(
        details.artifact.stage.encode(),
        JsonValue::String("active".into())
    );
    assert_eq!(details.definition, definition());
    assert_eq!(
        details
            .versions
            .iter()
            .find(|version| version.id == second.version_id)
            .unwrap()
            .state
            .encode(),
        JsonValue::String("degraded".into())
    );
    assert_eq!(
        std::fs::read_to_string(package::active_content_path(
            &fixture.root.join("data/project-artifacts").join(
                service
                    .resolve_project_scope(&project())
                    .unwrap()
                    .storage_id
                    .as_lossless()
                    .as_str()
                    .unwrap()
            ),
            &second.kind,
            &second.id
        ))
        .unwrap(),
        adapter::render(&definition()).as_str().unwrap()
    );
}

#[test]
fn general_recovery_replays_governor_context_and_commits_degradation_with_one_feedback() {
    let fixture = Fixture::new();
    let accounting = ycoding_core::resources::project_artifact::accounting::Service::new(
        fixture.db.client(),
        "private-test-key".into(),
    );
    let service = fixture.service.clone().with_accounting(accounting.clone());
    let written = service
        .write_manual(store::ManualWriteInput {
            now: 1,
            ..manual(&definition())
        })
        .unwrap();
    let scope = service.resolve_project_scope(&project()).unwrap();
    let identity = ycoding_store::artifacts::identity(
        written.scope_id.as_lossless(),
        written.kind.as_lossless(),
        written.id.as_lossless(),
    );
    let version_key = ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(
        written.version_id.as_lossless(),
    )]);
    fixture
        .db
        .submit(move |tx| {
            let mut artifact = tx
                .get::<ycoding_store::artifacts::ArtifactTable>(&identity)?
                .unwrap();
            artifact.stage = "active".into();
            ycoding_store::artifacts::ArtifactTable::put(tx, &artifact)?;
            let mut version = tx
                .get::<ycoding_store::artifacts::VersionTable>(&version_key)?
                .unwrap();
            version.state = "active".into();
            ycoding_store::artifacts::VersionTable::put(tx, &version)
        })
        .unwrap()
        .wait()
        .unwrap();
    governor_samples(&accounting, &written, "failure", 8 * 86_400_000, 0, true);
    governor_samples(
        &accounting,
        &written,
        "powered-baseline",
        8 * 86_400_000,
        30,
        false,
    );
    let expected = project_artifact::MutationExpectation {
        expected_revision: project_artifact::Revision::decode(&JsonValue::Number(0.0)).unwrap(),
        expected_version_id: written.version_id.clone(),
        expected_digest: written.content_digest.clone(),
    };
    let input = store::LifecycleInput {
        scope_id: &written.scope_id,
        kind: &written.kind,
        id: &written.id,
        expected: &expected,
        now: 8 * 86_400_000,
    };
    assert_eq!(
        service
            .evaluate_governor(store::GovernorInput {
                artifact: input,
                agent_id: None,
                model_id: "governor/model".into(),
                goal_mode: false
            })
            .unwrap()
            .transition
            .action,
        "none"
    );
    let root = fixture
        .root
        .join("data/project-artifacts")
        .join(scope.storage_id.as_lossless().as_str().unwrap());
    let marker = package::read_active(&root, &written.kind, &written.id, &Default::default())
        .unwrap()
        .unwrap();
    let row = ycoding_store::artifacts::Operation {
        id: "pop_governor-crash".into(),
        scope_id: written.scope_id.as_lossless().clone(),
        kind: written.kind.as_lossless().clone(),
        artifact_id: written.id.as_lossless().clone(),
        operation: "disable".into(),
        request_fingerprint: package::sha256(&"governor crash".into())
            .as_lossless()
            .clone(),
        expected_revision: Some(0),
        expected_version_id: Some(written.version_id.as_lossless().clone()),
        expected_digest: Some(written.content_digest.as_lossless().clone()),
        source_scope_id: None,
        source_version_id: None,
        source_digest: None,
        target_version_id: Some(written.version_id.as_lossless().clone()),
        target_digest: Some(written.content_digest.as_lossless().clone()),
        final_version_id: None,
        deletion_id: None,
        automatic_session_id: None,
        automatic_insight_digest: None,
        phase: "available".into(),
        time_created: 9 * 86_400_000,
        time_updated: 9 * 86_400_000,
    };
    fixture
        .db
        .submit(move |tx| ycoding_store::artifacts::OperationTable::insert(tx, &row))
        .unwrap()
        .wait()
        .unwrap();
    let context = format!(
        r#"{{"modelID":"governor/model","goalMode":false,"now":{}}}"#,
        9 * 86_400_000
    );
    let crash = |_: &package::StateMutationMetadata| -> Result<(), store::Error> {
        panic!("simulated process loss after availability")
    };
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| package::state_transaction(
            package::StateMutationInput {
                root: &root,
                operation_id: "pop_governor-crash",
                operation: package::StateOperation::Disable,
                current: &marker,
                target: None,
                standard: None,
                context: Some(&context)
            },
            &Default::default(),
            &package::TransactionHooks {
                reserve: None,
                finalize: Some(&crash),
                abort: None,
                cancellation: None,
                can_compensate: None
            }
        )))
        .is_err()
    );
    service.reconcile(&scope.id).unwrap();
    service.reconcile(&scope.id).unwrap();
    let result = service
        .get(&written.scope_id, &written.kind, &written.id)
        .unwrap();
    assert_eq!(
        result.artifact.stage.encode(),
        JsonValue::String("degraded".into())
    );
    assert_eq!(result.artifact.revision.get(), 1);
    assert_eq!(
        fixture
            .db
            .snapshot()
            .unwrap()
            .scan::<ycoding_store::artifacts::FeedbackTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                128
            )
            .unwrap()
            .len(),
        1
    );
    assert!(
        package::read_state_transactions(&root, &Default::default())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn lifecycle_disables_enables_reverts_owned_bytes_and_deduplicates_feedback() {
    let fixture = Fixture::new();
    let first = fixture.service.write_manual(manual(&definition())).unwrap();
    let changed = project_artifact::Definition::decode(&parse_json(r#"{"kind":"skill","name":"Review","description":"Reusable review","content":"Review revised behavior."}"#).unwrap()).unwrap();
    let second = fixture
        .service
        .write_manual(store::ManualWriteInput {
            definition: &changed,
            expected: Some(project_artifact::MutationExpectation {
                expected_revision: project_artifact::Revision::decode(&JsonValue::Number(0.0))
                    .unwrap(),
                expected_version_id: first.version_id.clone(),
                expected_digest: first.content_digest.clone(),
            }),
            now: 2000,
            ..manual(&changed)
        })
        .unwrap();
    let expected = project_artifact::MutationExpectation {
        expected_revision: project_artifact::Revision::decode(&JsonValue::Number(1.0)).unwrap(),
        expected_version_id: second.version_id.clone(),
        expected_digest: second.content_digest.clone(),
    };
    let input = store::LifecycleInput {
        scope_id: &second.scope_id,
        kind: &second.kind,
        id: &second.id,
        expected: &expected,
        now: 3000,
    };
    fixture.service.disable(input).unwrap();
    fixture.service.disable(input).unwrap();
    let disabled = fixture
        .service
        .get(&second.scope_id, &second.kind, &second.id)
        .unwrap();
    assert_eq!(
        disabled.artifact.stage.encode(),
        JsonValue::String("disabled".into())
    );
    assert_eq!(disabled.artifact.revision.get(), 2);
    assert_eq!(disabled.definition, changed);
    let expected = project_artifact::MutationExpectation {
        expected_revision: disabled.artifact.revision,
        expected_version_id: second.version_id.clone(),
        expected_digest: second.content_digest.clone(),
    };
    fixture
        .service
        .enable(store::LifecycleInput {
            expected: &expected,
            now: 4000,
            ..input
        })
        .unwrap();
    let enabled = fixture
        .service
        .get(&second.scope_id, &second.kind, &second.id)
        .unwrap();
    assert_eq!(
        enabled.artifact.stage.encode(),
        JsonValue::String("trial".into())
    );
    assert_eq!(enabled.artifact.revision.get(), 3);
    let expected = project_artifact::MutationExpectation {
        expected_revision: enabled.artifact.revision,
        expected_version_id: second.version_id.clone(),
        expected_digest: second.content_digest.clone(),
    };
    fixture
        .service
        .revert(
            store::LifecycleInput {
                expected: &expected,
                now: 5000,
                ..input
            },
            Some(&first.version_id),
        )
        .unwrap();
    let reverted = fixture
        .service
        .get(&second.scope_id, &second.kind, &second.id)
        .unwrap();
    assert_eq!(
        reverted.artifact.stage.encode(),
        JsonValue::String("active".into())
    );
    assert_eq!(reverted.current_version.id, first.version_id);
    assert_eq!(reverted.definition, definition());
    assert_eq!(
        fixture
            .db
            .snapshot()
            .unwrap()
            .scan::<ycoding_store::artifacts::FeedbackTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                128
            )
            .unwrap()
            .len(),
        3
    );
    let stale = project_artifact::MutationExpectation {
        expected_revision: project_artifact::Revision::decode(&JsonValue::Number(4.0)).unwrap(),
        ..expected
    };
    assert_eq!(
        fixture
            .service
            .disable(store::LifecycleInput {
                expected: &stale,
                ..input
            })
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("VersionConflict".into())
    );
}

#[test]
fn promotion_previews_metrics_uses_single_use_token_and_copies_an_independent_literal_snapshot() {
    let fixture = Fixture::new();
    let created = fixture.service.write_manual(manual(&definition())).unwrap();
    let expected = project_artifact::MutationExpectation {
        expected_revision: project_artifact::Revision::decode(&JsonValue::Number(0.0)).unwrap(),
        expected_version_id: created.version_id.clone(),
        expected_digest: created.content_digest.clone(),
    };
    let input = store::LifecycleInput {
        scope_id: &created.scope_id,
        kind: &created.kind,
        id: &created.id,
        expected: &expected,
        now: 1001,
    };
    let preview = fixture.service.preview_promotion(input).unwrap();
    assert_eq!(preview.metrics.reward_units, 0.0);
    assert_eq!(preview.metrics.confidence.sample_count.get(), 0);
    let promoted = fixture
        .service
        .confirm_promotion(&preview.token, 1002)
        .unwrap();
    assert_eq!(promoted.remaining.session, 0.0);
    assert_eq!(
        fixture
            .service
            .confirm_promotion(&preview.token, 1003)
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("ConfirmationExpired".into())
    );
    let path = fixture.root.join("home/.agents/skills/review/SKILL.md");
    let before = std::fs::read_to_string(&path).unwrap();
    assert_eq!(
        before,
        preview.rendered_content.as_lossless().as_str().unwrap()
    );
    let global = fixture
        .service
        .get(&promoted.scope_id, &promoted.kind, &promoted.id)
        .unwrap();
    assert_eq!(
        global.current_version.provenance.source.encode(),
        JsonValue::String("promotion".into())
    );
    assert_eq!(
        global.current_version.provenance.origin_scope_id,
        Some(created.scope_id.clone())
    );
    let changed = project_artifact::Definition::decode(&parse_json(r#"{"kind":"skill","name":"Review","description":"Reusable review","content":"Review changed project behavior."}"#).unwrap()).unwrap();
    fixture
        .service
        .write_manual(store::ManualWriteInput {
            definition: &changed,
            expected: Some(expected),
            now: 2000,
            ..manual(&changed)
        })
        .unwrap();
    assert_eq!(std::fs::read_to_string(path).unwrap(), before);
    assert_eq!(
        fixture
            .db
            .snapshot()
            .unwrap()
            .scan::<ycoding_store::artifacts::FeedbackTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                128
            )
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn promotion_rechecks_native_destination_and_expiry_without_modifying_project_source() {
    let fixture = Fixture::new();
    let created = fixture.service.write_manual(manual(&definition())).unwrap();
    let expected = project_artifact::MutationExpectation {
        expected_revision: project_artifact::Revision::decode(&JsonValue::Number(0.0)).unwrap(),
        expected_version_id: created.version_id.clone(),
        expected_digest: created.content_digest.clone(),
    };
    let input = store::LifecycleInput {
        scope_id: &created.scope_id,
        kind: &created.kind,
        id: &created.id,
        expected: &expected,
        now: 1000,
    };
    let preview = fixture.service.preview_promotion(input).unwrap();
    assert_eq!(
        fixture
            .service
            .confirm_promotion(&preview.token, 301_000)
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("ConfirmationExpired".into())
    );
    let preview = fixture.service.preview_promotion(input).unwrap();
    let path = fixture.root.join("home/.agents/skills/review/SKILL.md");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "user-owned").unwrap();
    assert_eq!(
        fixture
            .service
            .confirm_promotion(&preview.token, 1001)
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("DestinationExists".into())
    );
    assert_eq!(std::fs::read_to_string(path).unwrap(), "user-owned");
    assert_eq!(
        fixture
            .service
            .get(&created.scope_id, &created.kind, &created.id)
            .unwrap()
            .definition,
        definition()
    );
}

#[test]
fn scope_is_shared_marker_restored_and_adoption_keeps_storage_identity() {
    let fixture = Fixture::new();
    let first = fixture.service.resolve_project_scope(&project()).unwrap();
    assert_eq!(
        fixture.service.resolve_project_scope(&project()).unwrap(),
        first
    );
    let root = fixture
        .root
        .join("data/project-artifacts")
        .join(first.storage_id.as_lossless().as_str().unwrap());
    std::fs::remove_file(package::scope_marker_path(&root)).unwrap();
    assert_eq!(
        fixture.service.resolve_project_scope(&project()).unwrap(),
        first
    );
    assert!(package::scope_marker_path(&root).exists());
    let service = fixture.service.clone();
    let adopted = fixture
        .db
        .submit(move |tx| {
            service.adopt_project(
                tx,
                &project(),
                &project::Id::decode(&JsonValue::String("adopted".into())).unwrap(),
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    adopted.post_commit().unwrap();
    assert_eq!(adopted.scope.storage_id, first.storage_id);
    assert_eq!(adopted.scope.id, first.id);
    assert!(
        fixture
            .service
            .resolve_project_scope(
                &project::Id::decode(&JsonValue::String("global".into())).unwrap()
            )
            .is_err()
    );
}

#[test]
fn manual_writes_get_list_and_exact_revision_version_digest_expectations() {
    let fixture = Fixture::new();
    let definition = definition();
    let created = fixture.service.write_manual(manual(&definition)).unwrap();
    let details = fixture
        .service
        .get(&created.scope_id, &created.kind, &created.id)
        .unwrap();
    assert_eq!(details.artifact.revision.get(), 0);
    assert_eq!(details.definition, definition);
    assert_eq!(
        fixture
            .service
            .list(&created.scope_id, None, None)
            .unwrap()
            .len(),
        1
    );
    let changed=project_artifact::Definition::decode(&parse_json(r#"{"kind":"skill","name":"Review","description":"Reusable review","content":"Review the change carefully."}"#).unwrap()).unwrap();
    assert_eq!(
        fixture
            .service
            .write_manual(manual(&changed))
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("VersionConflict".into())
    );
    let expected = project_artifact::MutationExpectation {
        expected_revision: details.artifact.revision,
        expected_version_id: created.version_id.clone(),
        expected_digest: created.content_digest.clone(),
    };
    let mut wrong = expected.clone();
    wrong.expected_digest = project_artifact::Digest::decode(&JsonValue::String(
        "0000000000000000000000000000000000000000000000000000000000000000".into(),
    ))
    .unwrap();
    assert_eq!(
        fixture
            .service
            .write_manual(store::ManualWriteInput {
                expected: Some(wrong),
                ..manual(&changed)
            })
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("VersionConflict".into())
    );
    let updated = fixture
        .service
        .write_manual(store::ManualWriteInput {
            expected: Some(expected),
            ..manual(&changed)
        })
        .unwrap();
    let details = fixture
        .service
        .get(&updated.scope_id, &updated.kind, &updated.id)
        .unwrap();
    assert_eq!(details.artifact.revision.get(), 1);
    assert_eq!(details.versions.len(), 2);
    assert_eq!(
        details.current_version.parent_version_id,
        Some(created.version_id)
    );
}

#[test]
fn global_manual_confirmation_is_single_use_expires_at_five_minutes_and_rechecks_targets() {
    let fixture = Fixture::new();
    let definition = definition();
    let preview = fixture
        .service
        .preview_manual(store::ManualPreviewInput {
            id: "review",
            definition: &definition,
            expected: None,
            now: 1000,
        })
        .unwrap();
    assert_eq!(preview.expires_at, 301000);
    let created = fixture
        .service
        .confirm_manual(&preview.token, 1001)
        .unwrap();
    assert_eq!(
        fixture
            .service
            .get(&created.scope_id, &created.kind, &created.id)
            .unwrap()
            .definition,
        definition
    );
    assert_eq!(
        fixture
            .service
            .confirm_manual(&preview.token, 1002)
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("ConfirmationExpired".into())
    );
    let expired = fixture
        .service
        .preview_manual(store::ManualPreviewInput {
            id: "other",
            definition: &definition,
            expected: None,
            now: 1000,
        })
        .unwrap();
    assert_eq!(
        fixture
            .service
            .confirm_manual(&expired.token, 301000)
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("ConfirmationExpired".into())
    );
    let collided = fixture
        .service
        .preview_manual(store::ManualPreviewInput {
            id: "collision",
            definition: &definition,
            expected: None,
            now: 1000,
        })
        .unwrap();
    let kind = adapter::kind(&definition);
    let content = adapter::global_path(
        &kind,
        &fixture.root.join("home"),
        &fixture.root.join("config"),
        "collision",
    );
    std::fs::create_dir_all(content.parent().unwrap()).unwrap();
    std::fs::write(&content, "user-owned").unwrap();
    assert!(
        fixture
            .service
            .confirm_manual(&collided.token, 1001)
            .is_err()
    );
    assert_eq!(std::fs::read_to_string(content).unwrap(), "user-owned");
}
