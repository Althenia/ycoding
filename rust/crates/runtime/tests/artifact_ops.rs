mod support;

use prost::{Message, Name};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
};
use support::{
    Client, bare_dispatcher, operation, rejected, services, start, text, units,
    wire::{ask, location_scope, query, refuse},
};
use ycoding_core::{
    resources::project_artifact::{
        adapter,
        source_registry::{Record, Registry, StandardSource},
        store,
    },
    ycoding_schema::{DomainDecode, DomainEncode, JsonValue, project, project_artifact},
    ycoding_store::{Metadata, Options, Store, artifacts, import},
};
use ycoding_protocol::v5;
use ycoding_runtime::{ArtifactServices, Failure, LocalAuth, Server};

struct Fixture {
    _cleanup: Cleanup,
    service: store::Service,
    database: Store,
    refreshes: Arc<AtomicUsize>,
    server: Server,
    client: Client,
}

impl Fixture {
    async fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "ycoding-artifact-wire-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let database = Store::disposable(
            Options::core(),
            import::catalog(import::DatabaseKind::Core),
            Metadata::new([41; 16], 1),
        )
        .unwrap();
        database
            .submit(|tx| {
                ycoding_core::ycoding_store::project::ProjectTable::insert(
                    tx,
                    &ycoding_core::ycoding_store::project::Project {
                        id: "prj_one".into(),
                        worktree: "/project".into(),
                        vcs: None,
                        name: None,
                        icon_url: None,
                        icon_url_override: None,
                        icon_color: None,
                        time_created: 1,
                        time_updated: 1,
                        time_initialized: None,
                        sandboxes: vec![],
                        commands: None,
                    },
                )
            })
            .unwrap()
            .wait()
            .unwrap();
        let registry = Arc::new(Mutex::new(Registry::default()));
        let paths = store::Paths {
            data: root.join("data"),
            home: root.join("home"),
            config: root.join("config"),
        };
        let service = store::Service::new(database.client(), paths.clone(), registry.clone());
        let refreshes = Arc::new(AtomicUsize::new(0));
        let refresh_count = refreshes.clone();
        let refresh_store = service.clone();
        let refresh = Arc::new(move || {
            refresh_count.fetch_add(1, Ordering::Relaxed);
            let global = refresh_store.resolve_global_scope().unwrap();
            let records = refresh_store.list(&global.id, None, None).unwrap().into_iter()
                .filter(|item| matches!(item.stage.encode(), JsonValue::String(stage) if matches!(stage.as_str(), Some("trial" | "active"))))
                .map(|item| Record {
                    source: StandardSource { scope: "global".into(), managed_scope_id: Some(global.id.clone()), managed_version_id: Some(item.current_version_id), managed_digest: Some(item.current_digest) },
                    project_id: None, path: Some(adapter::global_path(&item.kind, &paths.home, &paths.config, item.id.as_lossless().as_str().unwrap())), kind: item.kind, id: item.id,
                }).collect();
            registry
                .lock()
                .unwrap()
                .replace("wire-global".into(), records);
        });
        let composed = ArtifactServices {
            store: service.clone(),
            refresh,
        };
        let mut services = services(LocalAuth::disabled(), true);
        services.core.as_mut().unwrap().artifacts = Some(Arc::new(move |_| Some(composed.clone())));
        let server = start(services, ycoding_runtime::standard().unwrap()).await;
        let client = Client::open(server.address(), &[]).await.unwrap();
        Self {
            _cleanup: Cleanup(root),
            database,
            service,
            refreshes,
            server,
            client,
        }
    }

    async fn get(&mut self, scope: i32, kind: i32, id: &str) -> v5::ProjectArtifactArtifactDetails {
        let result: v5::ArtifactGetResult = ask(
            &mut self.client,
            "artifact.get",
            location_scope("/project"),
            v5::ArtifactGetRequest {
                query: query("/project", None),
                params: v5::ArtifactGetRequestParams {
                    scope,
                    kind,
                    id: text(id),
                },
            },
        )
        .await;
        result.data
    }

    async fn create(
        &mut self,
        scope: i32,
        id: &str,
        definition: v5::ProjectArtifactDefinition,
    ) -> v5::ArtifactCreateResult {
        ask(
            &mut self.client,
            "artifact.create",
            location_scope("/project"),
            v5::ArtifactCreateRequest {
                query: query("/project", None),
                payload: v5::ProjectArtifactApiCreate {
                    scope,
                    id: text(id),
                    definition,
                },
            },
        )
        .await
    }

    async fn global(&mut self, id: &str) -> v5::ProjectArtifactApiMutationResult {
        let result = self.create(2, id, skill("Reusable global guidance.")).await;
        let Some(v5::artifact_create_result_data::Kind::Value2(preview)) = result.data.kind else {
            panic!("expected preview")
        };
        let confirmed: v5::ArtifactConfirmGlobalResult = ask(
            &mut self.client,
            "artifact.confirmGlobal",
            location_scope("/project"),
            v5::ArtifactConfirmGlobalRequest {
                query: query("/project", None),
                payload: v5::ProjectArtifactApiGlobalMutationConfirmation {
                    token: preview.token,
                },
            },
        )
        .await;
        confirmed.data
    }

    async fn list(
        &mut self,
        scope: i32,
        kind: Option<i32>,
        stage: Option<i32>,
    ) -> Vec<v5::ProjectArtifactApiListItem> {
        let result: v5::ArtifactListResult = ask(
            &mut self.client,
            "artifact.list",
            location_scope("/project"),
            v5::ArtifactListRequest {
                query: v5::ProjectArtifactApiQuery {
                    location: None,
                    scope,
                    kind,
                    stage,
                },
            },
        )
        .await;
        result.data.items
    }
}

struct Cleanup(PathBuf);

impl Drop for Cleanup {
    fn drop(&mut self) {
        if self.0.exists() {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
}

fn skill(content: &str) -> v5::ProjectArtifactDefinition {
    v5::ProjectArtifactDefinition {
        kind: Some(v5::project_artifact_definition::Kind::Value1(
            v5::ProjectArtifactSkillDefinition {
                kind: 1,
                name: text("Review"),
                description: text("Reusable review guidance"),
                content: text(content),
            },
        )),
    }
}

fn expectation(value: &v5::ProjectArtifactArtifactDetails) -> v5::ProjectArtifactApiExpectation {
    v5::ProjectArtifactApiExpectation {
        expected_revision: value.artifact.revision,
        expected_version_id: value.current_version.id.clone(),
        expected_digest: value.current_version.content_digest.clone(),
    }
}

fn mutation(
    value: &v5::ProjectArtifactArtifactDetails,
    definition: v5::ProjectArtifactDefinition,
) -> v5::ProjectArtifactApiMutation {
    v5::ProjectArtifactApiMutation {
        definition,
        expected_revision: value.artifact.revision,
        expected_version_id: value.current_version.id.clone(),
        expected_digest: value.current_version.content_digest.clone(),
    }
}

fn project_scope(fixture: &Fixture) -> project_artifact::ScopeId {
    fixture
        .service
        .resolve_project_scope(&project::Id::decode(&JsonValue::String("prj_one".into())).unwrap())
        .unwrap()
        .id
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn manual_crud_lifecycle_metrics_and_trash_use_real_store_and_refresh_only_commits() {
    let mut fixture = Fixture::new().await;
    let created = fixture
        .create(1, "review", skill("Review the current change."))
        .await;
    let Some(v5::artifact_create_result_data::Kind::Value1(created)) = created.data.kind else {
        panic!("expected mutation")
    };
    assert_eq!(created.result, 1);
    assert_eq!(created.stage, 1);
    assert_eq!(
        (
            created.remaining.session,
            created.remaining.project_daily,
            created.remaining.project_artifacts,
            created.remaining.versions
        ),
        (3, 10, 32, 16)
    );
    assert_eq!(created.remaining.bytes, 8 * 1024 * 1024);
    let first = fixture.get(1, 1, "review").await;
    assert_eq!(first.definition, skill("Review the current change."));
    assert_eq!(first.current_version.provenance.source, 2);
    assert_eq!(fixture.list(1, Some(1), Some(1)).await.len(), 1);
    assert!(fixture.list(1, Some(2), None).await.is_empty());
    let _: v5::ArtifactUpdateResult = ask(
        &mut fixture.client,
        "artifact.update",
        location_scope("/project"),
        v5::ArtifactUpdateRequest {
            query: query("/project", None),
            params: v5::ArtifactUpdateRequestParams {
                scope: 1,
                kind: 1,
                id: text("review"),
            },
            payload: mutation(&first, skill("Review the change carefully.")),
        },
    )
    .await;
    let second = fixture.get(1, 1, "review").await;
    assert_eq!(second.artifact.revision, 1);
    assert_eq!(second.versions.items.len(), 2);
    assert_eq!(
        second.current_version.parent_version_id,
        Some(first.current_version.id.clone())
    );
    let reconciled: v5::ArtifactUpdateResult = ask(
        &mut fixture.client,
        "artifact.update",
        location_scope("/project"),
        v5::ArtifactUpdateRequest {
            query: query("/project", None),
            params: v5::ArtifactUpdateRequestParams {
                scope: 1,
                kind: 1,
                id: text("review"),
            },
            payload: mutation(&second, second.definition.clone()),
        },
    )
    .await;
    let Some(v5::artifact_update_result_data::Kind::Value1(reconciled)) = reconciled.data.kind
    else {
        panic!("mutation")
    };
    assert_eq!(reconciled.result, 3);
    assert_eq!(reconciled.version_id, second.current_version.id);
    assert_eq!(fixture.get(1, 1, "review").await, second);
    let conflict: v5::ArtifactConflict = refuse(
        &mut fixture.client,
        "artifact.update",
        location_scope("/project"),
        v5::ArtifactUpdateRequest {
            query: query("/project", None),
            params: v5::ArtifactUpdateRequestParams {
                scope: 1,
                kind: 1,
                id: text("review"),
            },
            payload: mutation(&first, skill("Stale guidance.")),
        },
    )
    .await;
    assert_eq!(conflict.code, 3);
    assert_eq!(fixture.refreshes.load(Ordering::Relaxed), 3);
    let _: v5::ArtifactDisableResult = ask(
        &mut fixture.client,
        "artifact.disable",
        location_scope("/project"),
        v5::ArtifactDisableRequest {
            query: query("/project", None),
            params: v5::ArtifactDisableRequestParams {
                scope: 1,
                kind: 1,
                id: text("review"),
            },
            payload: expectation(&second),
        },
    )
    .await;
    let disabled = fixture.get(1, 1, "review").await;
    assert_eq!(disabled.artifact.stage, 4);
    assert_eq!(disabled.definition, second.definition);
    let _: v5::ArtifactEnableResult = ask(
        &mut fixture.client,
        "artifact.enable",
        location_scope("/project"),
        v5::ArtifactEnableRequest {
            query: query("/project", None),
            params: v5::ArtifactEnableRequestParams {
                scope: 1,
                kind: 1,
                id: text("review"),
            },
            payload: expectation(&disabled),
        },
    )
    .await;
    let enabled = fixture.get(1, 1, "review").await;
    assert_eq!(enabled.artifact.stage, 1);
    let _: v5::ArtifactRevertResult = ask(
        &mut fixture.client,
        "artifact.revert",
        location_scope("/project"),
        v5::ArtifactRevertRequest {
            query: query("/project", None),
            params: v5::ArtifactRevertRequestParams {
                scope: 1,
                kind: 1,
                id: text("review"),
            },
            payload: v5::ProjectArtifactApiRevert {
                expected_revision: enabled.artifact.revision,
                expected_version_id: enabled.current_version.id.clone(),
                expected_digest: enabled.current_version.content_digest.clone(),
                target_version_id: first.current_version.id.clone(),
            },
        },
    )
    .await;
    let reverted = fixture.get(1, 1, "review").await;
    assert_eq!(reverted.artifact.stage, 2);
    assert_eq!(reverted.definition, first.definition);
    let metrics: v5::ArtifactMetricsResult = ask(
        &mut fixture.client,
        "artifact.metrics",
        location_scope("/project"),
        v5::ArtifactMetricsRequest {
            query: query("/project", None),
            params: v5::ArtifactMetricsRequestParams {
                scope: 1,
                kind: 1,
                id: text("review"),
            },
        },
    )
    .await;
    assert_eq!(metrics.data.confidence.sample_count, 0);
    assert!(!metrics.data.confidence.eligible);
    assert_eq!(metrics.data.last_used_at, None);
    assert_eq!(fixture.refreshes.load(Ordering::Relaxed), 6);
    let removed: v5::ArtifactRemoveResult = ask(
        &mut fixture.client,
        "artifact.remove",
        location_scope("/project"),
        v5::ArtifactRemoveRequest {
            query: query("/project", None),
            params: v5::ArtifactRemoveRequestParams {
                scope: 1,
                kind: 1,
                id: text("review"),
            },
            payload: expectation(&reverted),
        },
    )
    .await;
    assert_eq!(removed.data.prior_stage, 2);
    assert_eq!(
        removed.data.purge_after - removed.data.deleted_at,
        30 * 86_400_000
    );
    assert!(fixture.list(1, None, None).await.is_empty());
    let trash = fixture.list(3, None, Some(2)).await;
    let Some(v5::project_artifact_api_list_item::Kind::Value2(item)) = &trash[0].kind else {
        panic!("expected trash")
    };
    assert_eq!(item.definition, first.definition);
    assert_eq!(item.deletion_id, removed.data.deletion_id);
    let _: v5::ArtifactRestoreResult = ask(
        &mut fixture.client,
        "artifact.restore",
        location_scope("/project"),
        v5::ArtifactRestoreRequest {
            query: query("/project", None),
            params: v5::ArtifactRestoreRequestParams {
                deletion_id: removed.data.deletion_id,
            },
        },
    )
    .await;
    assert_eq!(
        fixture.get(1, 1, "review").await.definition,
        first.definition
    );
    assert!(fixture.list(3, None, None).await.is_empty());
    let purged: v5::ArtifactPurgeResult = ask(
        &mut fixture.client,
        "artifact.purge",
        location_scope("/project"),
        v5::ArtifactPurgeRequest {
            query: query("/project", None),
        },
    )
    .await;
    assert_eq!(purged.data.count, 0);
    assert_eq!(fixture.refreshes.load(Ordering::Relaxed), 8);
    fixture.server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn global_create_update_are_previews_tokens_are_single_use_typed_and_expire_exactly() {
    let mut fixture = Fixture::new().await;
    let created = fixture
        .create(2, "review", skill("Initial global guidance."))
        .await;
    let Some(v5::artifact_create_result_data::Kind::Value2(preview)) = created.data.kind else {
        panic!("expected preview")
    };
    assert!(fixture.list(2, None, None).await.is_empty());
    assert_eq!(fixture.refreshes.load(Ordering::Relaxed), 0);
    let confirmed: v5::ArtifactConfirmGlobalResult = ask(
        &mut fixture.client,
        "artifact.confirmGlobal",
        location_scope("/project/team"),
        v5::ArtifactConfirmGlobalRequest {
            query: query("/project/team", None),
            payload: v5::ProjectArtifactApiGlobalMutationConfirmation {
                token: preview.token.clone(),
            },
        },
    )
    .await;
    assert_eq!(confirmed.data.result, 1);
    let reused: v5::ArtifactGone = refuse(
        &mut fixture.client,
        "artifact.confirmGlobal",
        location_scope("/project"),
        v5::ArtifactConfirmGlobalRequest {
            query: query("/project", None),
            payload: v5::ProjectArtifactApiGlobalMutationConfirmation {
                token: preview.token,
            },
        },
    )
    .await;
    assert_eq!(reused.code, 1);
    let global = fixture.get(2, 1, "review").await;
    let updated: v5::ArtifactUpdateResult = ask(
        &mut fixture.client,
        "artifact.update",
        location_scope("/project"),
        v5::ArtifactUpdateRequest {
            query: query("/project", None),
            params: v5::ArtifactUpdateRequestParams {
                scope: 2,
                kind: 1,
                id: text("review"),
            },
            payload: mutation(&global, skill("Updated global guidance.")),
        },
    )
    .await;
    let Some(v5::artifact_update_result_data::Kind::Value2(preview)) = updated.data.kind else {
        panic!("expected update preview")
    };
    assert_eq!(
        fixture.get(2, 1, "review").await.definition,
        global.definition
    );
    let _: v5::ArtifactConfirmGlobalResult = ask(
        &mut fixture.client,
        "artifact.confirmGlobal",
        location_scope("/project"),
        v5::ArtifactConfirmGlobalRequest {
            query: query("/project", None),
            payload: v5::ProjectArtifactApiGlobalMutationConfirmation {
                token: preview.token,
            },
        },
    )
    .await;
    let updated = fixture.get(2, 1, "review").await;
    assert_eq!(updated.artifact.revision, 1);
    assert_eq!(updated.definition, skill("Updated global guidance."));
    let domain_definition = project_artifact::Definition::decode(&ycoding_core::ycoding_schema::parse_json(r#"{"kind":"skill","name":"Review","description":"Reusable review","content":"Expired guidance."}"#).unwrap()).unwrap();
    let expired = fixture
        .service
        .preview_manual(store::ManualPreviewInput {
            id: "expired",
            definition: &domain_definition,
            expected: None,
            now: 0,
        })
        .unwrap();
    let error: v5::ArtifactGone = refuse(
        &mut fixture.client,
        "artifact.confirmGlobal",
        location_scope("/project"),
        v5::ArtifactConfirmGlobalRequest {
            query: query("/project", None),
            payload: v5::ProjectArtifactApiGlobalMutationConfirmation {
                token: text(expired.token.as_lossless().as_str().unwrap()),
            },
        },
    )
    .await;
    assert_eq!(error.code, 1);
    let another = fixture
        .create(2, "wrong-kind", skill("Unconfirmed guidance."))
        .await;
    let Some(v5::artifact_create_result_data::Kind::Value2(preview)) = another.data.kind else {
        panic!("preview")
    };
    let error: v5::ArtifactGone = refuse(
        &mut fixture.client,
        "artifact.fork.confirm",
        location_scope("/project"),
        v5::ArtifactForkConfirmRequest {
            query: query("/project", None),
            params: v5::ArtifactForkConfirmRequestParams {
                kind: 1,
                id: text("wrong-kind"),
                token: preview.token.clone(),
            },
        },
    )
    .await;
    assert_eq!(error.code, 1);
    let _: v5::ArtifactGone = refuse(
        &mut fixture.client,
        "artifact.confirmGlobal",
        location_scope("/project"),
        v5::ArtifactConfirmGlobalRequest {
            query: query("/project", None),
            payload: v5::ProjectArtifactApiGlobalMutationConfirmation {
                token: preview.token,
            },
        },
    )
    .await;
    assert_eq!(fixture.refreshes.load(Ordering::Relaxed), 2);
    fixture.server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fork_shadow_and_promotion_preserve_literal_snapshots_provenance_and_source_identity() {
    let mut fixture = Fixture::new().await;
    let global = fixture.global("forked").await;
    let global_details = fixture.get(2, 1, "forked").await;
    let preview: v5::ArtifactForkPreviewResult = ask(
        &mut fixture.client,
        "artifact.fork.preview",
        location_scope("/project"),
        v5::ArtifactForkPreviewRequest {
            query: query("/project", None),
            params: v5::ArtifactForkPreviewRequestParams {
                kind: 1,
                id: text("forked"),
            },
            payload: expectation(&global_details),
        },
    )
    .await;
    let fork: v5::ArtifactForkConfirmResult = ask(
        &mut fixture.client,
        "artifact.fork.confirm",
        location_scope("/project"),
        v5::ArtifactForkConfirmRequest {
            query: query("/project", None),
            params: v5::ArtifactForkConfirmRequestParams {
                kind: 1,
                id: text("forked"),
                token: preview.data.token.clone(),
            },
        },
    )
    .await;
    assert_ne!(fork.data.version_id, global.version_id);
    assert_eq!(fork.data.content_digest, global.content_digest);
    let _: v5::ArtifactGone = refuse(
        &mut fixture.client,
        "artifact.fork.confirm",
        location_scope("/project"),
        v5::ArtifactForkConfirmRequest {
            query: query("/project", None),
            params: v5::ArtifactForkConfirmRequestParams {
                kind: 1,
                id: text("forked"),
                token: preview.data.token,
            },
        },
    )
    .await;
    let forked = fixture.get(1, 1, "forked").await;
    assert_eq!(forked.definition, global_details.definition);
    assert_eq!(forked.current_version.provenance.source, 4);
    assert_eq!(
        forked.current_version.provenance.origin_scope_id,
        Some(global.scope_id.clone())
    );
    assert_eq!(
        forked.current_version.provenance.origin_version_id,
        Some(global.version_id)
    );
    let shadow: v5::ArtifactShadowPreviewResult = ask(
        &mut fixture.client,
        "artifact.shadow.preview",
        location_scope("/project"),
        v5::ArtifactShadowPreviewRequest {
            query: query("/project", None),
            params: v5::ArtifactShadowPreviewRequestParams {
                kind: 1,
                id: text("forked"),
            },
            payload: expectation(&forked),
        },
    )
    .await;
    let _: v5::ArtifactShadowConfirmResult = ask(
        &mut fixture.client,
        "artifact.shadow.confirm",
        location_scope("/project"),
        v5::ArtifactShadowConfirmRequest {
            query: query("/project", None),
            params: v5::ArtifactShadowConfirmRequestParams {
                kind: 1,
                id: text("forked"),
                token: shadow.data.token.clone(),
            },
        },
    )
    .await;
    let _: v5::ArtifactGone = refuse(
        &mut fixture.client,
        "artifact.shadow.confirm",
        location_scope("/project"),
        v5::ArtifactShadowConfirmRequest {
            query: query("/project", None),
            params: v5::ArtifactShadowConfirmRequestParams {
                kind: 1,
                id: text("forked"),
                token: shadow.data.token,
            },
        },
    )
    .await;
    let shadowed = fixture.get(1, 1, "forked").await;
    assert_eq!(
        shadowed.current_version.content_digest,
        forked.current_version.content_digest
    );
    assert_eq!(shadowed.artifact.shadowed_scope_id, Some(global.scope_id));
    assert_eq!(shadowed.diagnostics.items[0].r#type, 3);
    fixture
        .create(1, "promoted", skill("Independent promoted guidance."))
        .await;
    let project = fixture.get(1, 1, "promoted").await;
    let promotion: v5::ArtifactPromotionPreviewResult = ask(
        &mut fixture.client,
        "artifact.promotion.preview",
        location_scope("/project"),
        v5::ArtifactPromotionPreviewRequest {
            query: query("/project", None),
            params: v5::ArtifactPromotionPreviewRequestParams {
                kind: 1,
                id: text("promoted"),
            },
            payload: expectation(&project),
        },
    )
    .await;
    assert_eq!(promotion.data.risk, 1);
    assert_eq!(promotion.data.metrics.confidence.sample_count, 0);
    assert!(units(&promotion.data.rendered_content).contains("Independent promoted guidance."));
    let promoted: v5::ArtifactPromotionConfirmResult = ask(
        &mut fixture.client,
        "artifact.promotion.confirm",
        location_scope("/project"),
        v5::ArtifactPromotionConfirmRequest {
            query: query("/project", None),
            params: v5::ArtifactPromotionConfirmRequestParams {
                kind: 1,
                id: text("promoted"),
                token: promotion.data.token.clone(),
            },
        },
    )
    .await;
    assert_eq!(
        promoted.data.content_digest,
        project.current_version.content_digest
    );
    let source = fixture.get(1, 1, "promoted").await;
    assert_eq!(source.current_version, project.current_version);
    assert_eq!(source.definition, project.definition);
    assert_eq!(source.artifact.revision, project.artifact.revision);
    assert_eq!(
        source.artifact.shadowed_scope_id,
        Some(promoted.data.scope_id)
    );
    assert_eq!(
        fixture
            .get(2, 1, "promoted")
            .await
            .current_version
            .provenance
            .source,
        3
    );
    let _: v5::ArtifactGone = refuse(
        &mut fixture.client,
        "artifact.promotion.confirm",
        location_scope("/project"),
        v5::ArtifactPromotionConfirmRequest {
            query: query("/project", None),
            params: v5::ArtifactPromotionConfirmRequestParams {
                kind: 1,
                id: text("promoted"),
                token: promotion.data.token,
            },
        },
    )
    .await;
    assert_eq!(fixture.refreshes.load(Ordering::Relaxed), 5);
    fixture.server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wire_errors_sanitize_invalid_not_found_scope_and_optimistic_conflicts() {
    let mut fixture = Fixture::new().await;
    let not_found: v5::ArtifactNotFound = refuse(
        &mut fixture.client,
        "artifact.get",
        location_scope("/project"),
        v5::ArtifactGetRequest {
            query: query("/project", None),
            params: v5::ArtifactGetRequestParams {
                scope: 1,
                kind: 1,
                id: text("missing"),
            },
        },
    )
    .await;
    assert_eq!(not_found.code, 1);
    let missing: v5::ArtifactNotFound = refuse(
        &mut fixture.client,
        "artifact.restore",
        location_scope("/project"),
        v5::ArtifactRestoreRequest {
            query: query("/project", None),
            params: v5::ArtifactRestoreRequestParams {
                deletion_id: text("pad_missing"),
            },
        },
    )
    .await;
    assert_eq!(missing.code, 3);
    let invalid: v5::InvalidRequestError = refuse(
        &mut fixture.client,
        "artifact.create",
        location_scope("/project"),
        v5::ArtifactCreateRequest {
            query: query("/different", None),
            payload: v5::ProjectArtifactApiCreate {
                scope: 1,
                id: text("review"),
                definition: skill("Reusable guidance."),
            },
        },
    )
    .await;
    assert!(!units(&invalid.message).is_empty());
    let unsafe_content: v5::ArtifactBadRequest = refuse(
        &mut fixture.client,
        "artifact.create",
        location_scope("/project"),
        v5::ArtifactCreateRequest {
            query: query("/project", None),
            payload: v5::ProjectArtifactApiCreate {
                scope: 1,
                id: text("unsafe"),
                definition: skill("Visit https://example.invalid for guidance."),
            },
        },
    )
    .await;
    assert_eq!(unsafe_content.code, 3);
    fixture
        .create(1, "review", skill("Reusable guidance."))
        .await;
    let details = fixture.get(1, 1, "review").await;
    for expectation in [
        v5::ProjectArtifactApiExpectation {
            expected_revision: 12,
            ..expectation(&details)
        },
        v5::ProjectArtifactApiExpectation {
            expected_version_id: text("pav_other"),
            ..expectation(&details)
        },
        v5::ProjectArtifactApiExpectation {
            expected_digest: text(&"0".repeat(64)),
            ..expectation(&details)
        },
    ] {
        let error: v5::ArtifactConflict = refuse(
            &mut fixture.client,
            "artifact.disable",
            location_scope("/project"),
            v5::ArtifactDisableRequest {
                query: query("/project", None),
                params: v5::ArtifactDisableRequestParams {
                    scope: 1,
                    kind: 1,
                    id: text("review"),
                },
                payload: expectation,
            },
        )
        .await;
        assert_eq!(error.code, 3);
    }
    let missing_target: v5::ArtifactNotFound = refuse(
        &mut fixture.client,
        "artifact.revert",
        location_scope("/project"),
        v5::ArtifactRevertRequest {
            query: query("/project", None),
            params: v5::ArtifactRevertRequestParams {
                scope: 1,
                kind: 1,
                id: text("review"),
            },
            payload: v5::ProjectArtifactApiRevert {
                expected_revision: details.artifact.revision,
                expected_version_id: details.current_version.id,
                expected_digest: details.current_version.content_digest,
                target_version_id: text("pav_missing"),
            },
        },
    )
    .await;
    assert_eq!(missing_target.code, 2);
    fixture.global("global").await;
    let global = fixture.get(2, 1, "global").await;
    let invalid_scope: v5::ArtifactBadRequest = refuse(
        &mut fixture.client,
        "artifact.disable",
        location_scope("/project"),
        v5::ArtifactDisableRequest {
            query: query("/project", None),
            params: v5::ArtifactDisableRequestParams {
                scope: 2,
                kind: 1,
                id: text("global"),
            },
            payload: expectation(&global),
        },
    )
    .await;
    assert_eq!(invalid_scope.code, 5);
    assert_eq!(fixture.refreshes.load(Ordering::Relaxed), 2);
    fixture.server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn expiry_purge_removes_only_due_trash_and_restore_rejects_expired_deletion() {
    let mut fixture = Fixture::new().await;
    fixture
        .create(1, "expired", skill("Expired guidance."))
        .await;
    fixture
        .create(1, "retained", skill("Retained guidance."))
        .await;
    let scope = project_scope(&fixture);
    let kind = project_artifact::Kind::decode(&JsonValue::String("skill".into())).unwrap();
    let id = project_artifact::Id::decode(&JsonValue::String("expired".into())).unwrap();
    let details = fixture.service.get(&scope, &kind, &id).unwrap();
    let expected = project_artifact::MutationExpectation {
        expected_revision: details.artifact.revision,
        expected_version_id: details.current_version.id,
        expected_digest: details.current_version.content_digest,
    };
    let removed = fixture
        .service
        .remove(store::LifecycleInput {
            scope_id: &scope,
            kind: &kind,
            id: &id,
            expected: &expected,
            now: 1,
        })
        .unwrap();
    let retained = fixture.get(1, 1, "retained").await;
    let _: v5::ArtifactRemoveResult = ask(
        &mut fixture.client,
        "artifact.remove",
        location_scope("/project"),
        v5::ArtifactRemoveRequest {
            query: query("/project", None),
            params: v5::ArtifactRemoveRequestParams {
                scope: 1,
                kind: 1,
                id: text("retained"),
            },
            payload: expectation(&retained),
        },
    )
    .await;
    let expired: v5::ArtifactGone = refuse(
        &mut fixture.client,
        "artifact.restore",
        location_scope("/project"),
        v5::ArtifactRestoreRequest {
            query: query("/project", None),
            params: v5::ArtifactRestoreRequestParams {
                deletion_id: text(removed.deletion_id.as_lossless().as_str().unwrap()),
            },
        },
    )
    .await;
    assert_eq!(expired.code, 2);
    let purged: v5::ArtifactPurgeResult = ask(
        &mut fixture.client,
        "artifact.purge",
        location_scope("/project"),
        v5::ArtifactPurgeRequest {
            query: query("/project", None),
        },
    )
    .await;
    assert_eq!(purged.data.count, 1);
    assert_eq!(fixture.list(3, None, None).await.len(), 1);
    let missing: v5::ArtifactNotFound = refuse(
        &mut fixture.client,
        "artifact.get",
        location_scope("/project"),
        v5::ArtifactGetRequest {
            query: query("/project", None),
            params: v5::ArtifactGetRequestParams {
                scope: 1,
                kind: 1,
                id: text("expired"),
            },
        },
    )
    .await;
    assert_eq!(missing.code, 1);
    fixture.server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn authoring_previews_recheck_captured_sources_and_destinations_before_confirmation() {
    let mut fixture = Fixture::new().await;
    fixture.global("fork-stale").await;
    let global = fixture.get(2, 1, "fork-stale").await;
    let fork: v5::ArtifactForkPreviewResult = ask(
        &mut fixture.client,
        "artifact.fork.preview",
        location_scope("/project"),
        v5::ArtifactForkPreviewRequest {
            query: query("/project", None),
            params: v5::ArtifactForkPreviewRequestParams {
                kind: 1,
                id: text("fork-stale"),
            },
            payload: expectation(&global),
        },
    )
    .await;
    let updated: v5::ArtifactUpdateResult = ask(
        &mut fixture.client,
        "artifact.update",
        location_scope("/project"),
        v5::ArtifactUpdateRequest {
            query: query("/project", None),
            params: v5::ArtifactUpdateRequestParams {
                scope: 2,
                kind: 1,
                id: text("fork-stale"),
            },
            payload: mutation(&global, skill("Changed global guidance.")),
        },
    )
    .await;
    let Some(v5::artifact_update_result_data::Kind::Value2(update)) = updated.data.kind else {
        panic!("preview")
    };
    let _: v5::ArtifactConfirmGlobalResult = ask(
        &mut fixture.client,
        "artifact.confirmGlobal",
        location_scope("/project"),
        v5::ArtifactConfirmGlobalRequest {
            query: query("/project", None),
            payload: v5::ProjectArtifactApiGlobalMutationConfirmation {
                token: update.token,
            },
        },
    )
    .await;
    let conflict: v5::ArtifactConflict = refuse(
        &mut fixture.client,
        "artifact.fork.confirm",
        location_scope("/project"),
        v5::ArtifactForkConfirmRequest {
            query: query("/project", None),
            params: v5::ArtifactForkConfirmRequestParams {
                kind: 1,
                id: text("fork-stale"),
                token: fork.data.token,
            },
        },
    )
    .await;
    assert_eq!(conflict.code, 3);
    assert!(fixture.list(1, None, None).await.is_empty());
    let global = fixture.get(2, 1, "fork-stale").await;
    let fork: v5::ArtifactForkPreviewResult = ask(
        &mut fixture.client,
        "artifact.fork.preview",
        location_scope("/project"),
        v5::ArtifactForkPreviewRequest {
            query: query("/project", None),
            params: v5::ArtifactForkPreviewRequestParams {
                kind: 1,
                id: text("fork-stale"),
            },
            payload: expectation(&global),
        },
    )
    .await;
    let _: v5::ArtifactForkConfirmResult = ask(
        &mut fixture.client,
        "artifact.fork.confirm",
        location_scope("/project"),
        v5::ArtifactForkConfirmRequest {
            query: query("/project", None),
            params: v5::ArtifactForkConfirmRequestParams {
                kind: 1,
                id: text("fork-stale"),
                token: fork.data.token,
            },
        },
    )
    .await;
    let project = fixture.get(1, 1, "fork-stale").await;
    let shadow: v5::ArtifactShadowPreviewResult = ask(
        &mut fixture.client,
        "artifact.shadow.preview",
        location_scope("/project"),
        v5::ArtifactShadowPreviewRequest {
            query: query("/project", None),
            params: v5::ArtifactShadowPreviewRequestParams {
                kind: 1,
                id: text("fork-stale"),
            },
            payload: expectation(&project),
        },
    )
    .await;
    let _: v5::ArtifactUpdateResult = ask(
        &mut fixture.client,
        "artifact.update",
        location_scope("/project"),
        v5::ArtifactUpdateRequest {
            query: query("/project", None),
            params: v5::ArtifactUpdateRequestParams {
                scope: 1,
                kind: 1,
                id: text("fork-stale"),
            },
            payload: mutation(&project, skill("Changed project guidance.")),
        },
    )
    .await;
    let conflict: v5::ArtifactConflict = refuse(
        &mut fixture.client,
        "artifact.shadow.confirm",
        location_scope("/project"),
        v5::ArtifactShadowConfirmRequest {
            query: query("/project", None),
            params: v5::ArtifactShadowConfirmRequestParams {
                kind: 1,
                id: text("fork-stale"),
                token: shadow.data.token,
            },
        },
    )
    .await;
    assert_eq!(conflict.code, 3);
    fixture
        .create(1, "promotion-collision", skill("Promotable guidance."))
        .await;
    let project = fixture.get(1, 1, "promotion-collision").await;
    let promotion: v5::ArtifactPromotionPreviewResult = ask(
        &mut fixture.client,
        "artifact.promotion.preview",
        location_scope("/project"),
        v5::ArtifactPromotionPreviewRequest {
            query: query("/project", None),
            params: v5::ArtifactPromotionPreviewRequestParams {
                kind: 1,
                id: text("promotion-collision"),
            },
            payload: expectation(&project),
        },
    )
    .await;
    fixture.global("promotion-collision").await;
    let conflict: v5::ArtifactConflict = refuse(
        &mut fixture.client,
        "artifact.promotion.confirm",
        location_scope("/project"),
        v5::ArtifactPromotionConfirmRequest {
            query: query("/project", None),
            params: v5::ArtifactPromotionConfirmRequestParams {
                kind: 1,
                id: text("promotion-collision"),
                token: promotion.data.token,
            },
        },
    )
    .await;
    assert_eq!(conflict.code, 5);
    assert_eq!(fixture.get(1, 1, "promotion-collision").await, project);
    fixture.server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn command_agent_definitions_round_trip_permissions_and_plugin_activation_is_rejected() {
    let mut fixture = Fixture::new().await;
    let command = v5::ProjectArtifactDefinition {
        kind: Some(v5::project_artifact_definition::Kind::Value2(
            v5::ProjectArtifactCommandDefinition {
                kind: 1,
                name: text("Review"),
                description: text("Review command"),
                template: text("Review the current change."),
                subtask: false,
            },
        )),
    };
    let agent = v5::ProjectArtifactDefinition {
        kind: Some(v5::project_artifact_definition::Kind::Value3(
            v5::ProjectArtifactAgentDefinition {
                kind: 1,
                name: text("Review"),
                description: text("Review subagent"),
                system: text("Review the current change."),
                mode: 1,
                permissions: v5::PermissionRuleset {
                    items: vec![
                        v5::PermissionRule {
                            action: text("read"),
                            resource: text("*"),
                            effect: 1,
                        },
                        v5::PermissionRule {
                            action: text("shell"),
                            resource: text("*"),
                            effect: 2,
                        },
                        v5::PermissionRule {
                            action: text("write"),
                            resource: text("*"),
                            effect: 3,
                        },
                    ],
                },
            },
        )),
    };
    fixture.create(1, "command", command.clone()).await;
    fixture.create(1, "agent", agent.clone()).await;
    assert_eq!(fixture.get(1, 2, "command").await.definition, command);
    assert_eq!(fixture.get(1, 3, "agent").await.definition, agent);
    let unsupported: v5::ArtifactBadRequest = refuse(
        &mut fixture.client,
        "artifact.create",
        location_scope("/project"),
        v5::ArtifactCreateRequest {
            query: query("/project", None),
            payload: v5::ProjectArtifactApiCreate {
                scope: 1,
                id: text("plugin"),
                definition: v5::ProjectArtifactDefinition {
                    kind: Some(v5::project_artifact_definition::Kind::Value4(
                        v5::ProjectArtifactPluginDefinition {
                            kind: 1,
                            name: text("Draft"),
                            description: text("Plugin draft"),
                            draft: text("Validated draft."),
                        },
                    )),
                },
            },
        },
    )
    .await;
    assert_eq!(unsupported.code, 4);
    assert_eq!(fixture.list(1, None, None).await.len(), 2);
    fixture.server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn metrics_read_persisted_feedback_and_last_used_without_refresh_or_raw_data() {
    let mut fixture = Fixture::new().await;
    fixture
        .create(1, "metrics", skill("Measured reusable guidance."))
        .await;
    let details = fixture.get(1, 1, "metrics").await;
    let scope = project_scope(&fixture);
    let version = units(&details.current_version.id);
    fixture
        .database
        .submit(move |tx| {
            let key = artifacts::identity(scope.as_lossless(), &"skill".into(), &"metrics".into());
            let mut artifact = tx.get::<artifacts::ArtifactTable>(&key)?.unwrap();
            artifact.last_used_at = Some(1234);
            artifacts::ArtifactTable::put(tx, &artifact)?;
            artifacts::FeedbackTable::insert(
                tx,
                &artifacts::Feedback {
                    id: "paf_wire-disable".into(),
                    scope_id: scope.as_lossless().clone(),
                    kind: "skill".into(),
                    artifact_id: "metrics".into(),
                    version_id: version.into(),
                    action: "disable".into(),
                    actor: "user".into(),
                    time_created: 1000,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let response: v5::ArtifactMetricsResult = ask(
        &mut fixture.client,
        "artifact.metrics",
        location_scope("/project"),
        v5::ArtifactMetricsRequest {
            query: query("/project", None),
            params: v5::ArtifactMetricsRequestParams {
                scope: 1,
                kind: 1,
                id: text("metrics"),
            },
        },
    )
    .await;
    assert_eq!(response.data.last_used_at, Some(1234));
    assert_eq!(response.data.reward_units, 0.0);
    assert_eq!(response.data.penalty_units, 4.0);
    assert_eq!(response.data.score, -1.0);
    assert_eq!(response.data.confidence.sample_count, 0);
    assert_eq!(fixture.refreshes.load(Ordering::Relaxed), 1);
    fixture.server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn all_artifact_error_codes_settle_as_the_declared_typed_family() {
    let cases = [
        (
            "ProjectIdentityUnavailable",
            v5::ArtifactBadRequest::full_name(),
            1,
        ),
        ("InvalidArtifact", v5::ArtifactBadRequest::full_name(), 2),
        ("UnsafeContent", v5::ArtifactBadRequest::full_name(), 3),
        ("UnsupportedKind", v5::ArtifactBadRequest::full_name(), 4),
        ("InvalidScope", v5::ArtifactBadRequest::full_name(), 5),
        ("ArtifactNotFound", v5::ArtifactNotFound::full_name(), 1),
        ("VersionNotFound", v5::ArtifactNotFound::full_name(), 2),
        ("DeletionNotFound", v5::ArtifactNotFound::full_name(), 3),
        ("ArtifactCollision", v5::ArtifactConflict::full_name(), 1),
        ("ScopeCollision", v5::ArtifactConflict::full_name(), 2),
        ("VersionConflict", v5::ArtifactConflict::full_name(), 3),
        ("OwnershipMismatch", v5::ArtifactConflict::full_name(), 4),
        ("DestinationExists", v5::ArtifactConflict::full_name(), 5),
        (
            "ProjectAdoptionConflict",
            v5::ArtifactConflict::full_name(),
            6,
        ),
        ("ConfirmationExpired", v5::ArtifactGone::full_name(), 1),
        ("TrashExpired", v5::ArtifactGone::full_name(), 2),
        ("ContentTooLarge", v5::ArtifactTooLarge::full_name(), 1),
        ("ScopeQuotaExceeded", v5::ArtifactTooLarge::full_name(), 2),
        ("WriteRateExceeded", v5::ArtifactRateLimited::full_name(), 1),
        ("ArtifactCooldown", v5::ArtifactRateLimited::full_name(), 2),
        (
            "StorageUnavailable",
            v5::ArtifactUnavailable::full_name(),
            1,
        ),
        ("LockTimeout", v5::ArtifactUnavailable::full_name(), 2),
        (
            "ReconciliationRequired",
            v5::ArtifactUnavailable::full_name(),
            3,
        ),
    ];
    for (code, expected_type, expected_code) in cases {
        let code = project_artifact::ErrorCode::decode(&JsonValue::String(code.into())).unwrap();
        let mut dispatcher = bare_dispatcher();
        dispatcher
            .handle("artifact.get", move |_, _: v5::ArtifactGetRequest| {
                let code = code.clone();
                async move { Err::<v5::ArtifactGetResult, _>(Failure::Artifact(code)) }
            })
            .unwrap();
        let server = start(services(LocalAuth::disabled(), false), dispatcher).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let payload = rejected(
            client
                .call(
                    "artifact.get",
                    location_scope("/project"),
                    v5::ArtifactGetRequest {
                        query: query("/project", None),
                        params: v5::ArtifactGetRequestParams {
                            scope: 1,
                            kind: 1,
                            id: text("review"),
                        },
                    }
                    .encode_to_vec(),
                )
                .await,
        );
        assert_eq!(payload.type_name, expected_type);
        assert!(
            operation("artifact.get")
                .error_types
                .contains(&payload.type_name)
        );
        assert_eq!(payload.payload, vec![8, 1, 16, expected_code]);
        server.shutdown().await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn artifact_manifest_is_fully_registered_location_only_and_missing_composition_is_typed() {
    let dispatcher = ycoding_runtime::standard().unwrap();
    let descriptors = dispatcher
        .descriptors()
        .into_iter()
        .filter(|item| item.diagnostic_name.starts_with("artifact."))
        .collect::<Vec<_>>();
    assert_eq!(descriptors.len(), 18);
    for descriptor in descriptors {
        assert_eq!(descriptor.roles, vec![v5::PeerRole::LocalClient as i32]);
        assert_eq!(descriptor.scope, v5::ScopeKind::Location as i32);
        assert!(
            dispatcher
                .wired()
                .contains(&descriptor.diagnostic_name.as_str())
        );
    }
    let server = start(services(LocalAuth::disabled(), true), dispatcher).await;
    let mut client = Client::open(server.address(), &[]).await.unwrap();
    let unavailable: v5::ArtifactUnavailable = refuse(
        &mut client,
        "artifact.get",
        location_scope("/project"),
        v5::ArtifactGetRequest {
            query: query("/project", None),
            params: v5::ArtifactGetRequestParams {
                scope: 1,
                kind: 1,
                id: text("review"),
            },
        },
    )
    .await;
    assert_eq!(unavailable.code, 1);
    server.shutdown().await.unwrap();
}
