mod convert;

use crate::{
    dispatch::{Dispatcher, Failure, Invocation, RegistrationError},
    ids,
    services::ArtifactServices,
};
use prost::{Message, Name};
use ycoding_core::{
    resources::project_artifact::store,
    ycoding_schema::{DomainDecode, DomainEncode, JsonValue, project, project_artifact},
};
use ycoding_protocol::v5;

pub fn register(dispatcher: &mut Dispatcher) -> Result<(), RegistrationError> {
    dispatcher.handle("artifact.confirmGlobal", confirm_global)?;
    dispatcher.handle("artifact.create", create)?;
    dispatcher.handle("artifact.disable", disable)?;
    dispatcher.handle("artifact.enable", enable)?;
    dispatcher.handle("artifact.fork.confirm", fork_confirm)?;
    dispatcher.handle("artifact.fork.preview", fork_preview)?;
    dispatcher.handle("artifact.get", get)?;
    dispatcher.handle("artifact.list", list)?;
    dispatcher.handle("artifact.metrics", metrics)?;
    dispatcher.handle("artifact.promotion.confirm", promotion_confirm)?;
    dispatcher.handle("artifact.promotion.preview", promotion_preview)?;
    dispatcher.handle("artifact.purge", purge)?;
    dispatcher.handle("artifact.remove", remove)?;
    dispatcher.handle("artifact.restore", restore)?;
    dispatcher.handle("artifact.revert", revert)?;
    dispatcher.handle("artifact.shadow.confirm", shadow_confirm)?;
    dispatcher.handle("artifact.shadow.preview", shadow_preview)?;
    dispatcher.handle("artifact.update", update)?;
    Ok(())
}

fn prepare(
    invocation: &Invocation,
    query: &v5::LocationQuery,
) -> Result<(ArtifactServices, project::Id), Failure> {
    let location = invocation.location(query.location.as_ref())?;
    let services = invocation
        .core()?
        .artifacts
        .as_ref()
        .and_then(|provider| provider(&location.info))
        .ok_or_else(|| artifact_error("StorageUnavailable"))?;
    Ok((services, location.info.project.id.clone()))
}

fn scope(
    store: &store::Service,
    project: &project::Id,
    selector: i32,
) -> Result<project_artifact::ScopeId, Failure> {
    match selector {
        1 => store
            .resolve_project_scope(project)
            .map(|scope| scope.id)
            .map_err(failure),
        2 => store
            .resolve_global_scope()
            .map(|scope| scope.id)
            .map_err(failure),
        _ => Err(Failure::Invalid("invalid artifact scope".into())),
    }
}

fn failure(error: store::Error) -> Failure {
    Failure::Artifact(error.code)
}

fn artifact_error(code: &str) -> Failure {
    Failure::Artifact(
        project_artifact::ErrorCode::decode(&JsonValue::String(code.into()))
            .expect("artifact error code"),
    )
}

fn committed<T>(
    services: &ArtifactServices,
    result: Result<T, store::Error>,
) -> Result<T, Failure> {
    let result = result.map_err(failure)?;
    (services.refresh)();
    Ok(result)
}

async fn create(
    invocation: Invocation,
    request: v5::ArtifactCreateRequest,
) -> Result<v5::ArtifactCreateResult, Failure> {
    let (services, project) = prepare(&invocation, &request.query)?;
    let definition = convert::definition_domain(&request.payload.definition)?;
    let id = crate::convert::identifier::<project_artifact::Id>(&request.payload.id)?;
    let id = id
        .as_lossless()
        .as_str()
        .ok_or_else(|| Failure::Invalid("invalid artifact ID".into()))?;
    use v5::artifact_create_result_data::Kind;
    let result = match request.payload.scope {
        1 => Kind::Value1(convert::mutation(committed(
            &services,
            services.store.write_manual(store::ManualWriteInput {
                scope: project_artifact::ScopeSelector::Project,
                project_id: Some(project),
                id,
                definition: &definition,
                expected: None,
                now: ids::now_millis(),
            }),
        )?)),
        2 => Kind::Value2(convert::preview(
            services
                .store
                .preview_manual(store::ManualPreviewInput {
                    id,
                    definition: &definition,
                    expected: None,
                    now: ids::now_millis(),
                })
                .map_err(failure)?,
        )),
        _ => return Err(Failure::Invalid("invalid artifact scope".into())),
    };
    Ok(v5::ArtifactCreateResult {
        data: v5::ArtifactCreateResultData { kind: Some(result) },
    })
}

async fn update(
    invocation: Invocation,
    request: v5::ArtifactUpdateRequest,
) -> Result<v5::ArtifactUpdateResult, Failure> {
    let (services, project) = prepare(&invocation, &request.query)?;
    let definition = convert::definition_domain(&request.payload.definition)?;
    let _ = convert::kind(request.params.kind)?;
    let id = crate::convert::identifier::<project_artifact::Id>(&request.params.id)?;
    let id = id
        .as_lossless()
        .as_str()
        .ok_or_else(|| Failure::Invalid("invalid artifact ID".into()))?;
    let expected = convert::expectation(&v5::ProjectArtifactApiExpectation {
        expected_revision: request.payload.expected_revision,
        expected_version_id: request.payload.expected_version_id,
        expected_digest: request.payload.expected_digest,
    })?;
    use v5::artifact_update_result_data::Kind;
    let result = match request.params.scope {
        1 => Kind::Value1(convert::mutation(committed(
            &services,
            services.store.write_manual(store::ManualWriteInput {
                scope: project_artifact::ScopeSelector::Project,
                project_id: Some(project),
                id,
                definition: &definition,
                expected: Some(expected),
                now: ids::now_millis(),
            }),
        )?)),
        2 => Kind::Value2(convert::preview(
            services
                .store
                .preview_manual(store::ManualPreviewInput {
                    id,
                    definition: &definition,
                    expected: Some(expected),
                    now: ids::now_millis(),
                })
                .map_err(failure)?,
        )),
        _ => return Err(Failure::Invalid("invalid artifact scope".into())),
    };
    Ok(v5::ArtifactUpdateResult {
        data: v5::ArtifactUpdateResultData { kind: Some(result) },
    })
}

async fn confirm_global(
    invocation: Invocation,
    request: v5::ArtifactConfirmGlobalRequest,
) -> Result<v5::ArtifactConfirmGlobalResult, Failure> {
    let (services, _) = prepare(&invocation, &request.query)?;
    let token = crate::convert::identifier(&request.payload.token)?;
    Ok(v5::ArtifactConfirmGlobalResult {
        data: convert::mutation(committed(
            &services,
            services.store.confirm_manual(&token, ids::now_millis()),
        )?),
    })
}

async fn get(
    invocation: Invocation,
    request: v5::ArtifactGetRequest,
) -> Result<v5::ArtifactGetResult, Failure> {
    let (services, project) = prepare(&invocation, &request.query)?;
    let scope = scope(&services.store, &project, request.params.scope)?;
    let kind = convert::kind(request.params.kind)?;
    let id = crate::convert::identifier(&request.params.id)?;
    Ok(v5::ArtifactGetResult {
        data: convert::details(&services.store.get(&scope, &kind, &id).map_err(failure)?),
    })
}

async fn list(
    invocation: Invocation,
    request: v5::ArtifactListRequest,
) -> Result<v5::ArtifactListResult, Failure> {
    let query = &request.query;
    let (services, project) = prepare(
        &invocation,
        &v5::LocationQuery {
            location: query
                .location
                .as_ref()
                .map(|location| v5::LocationQueryLocation {
                    directory: location.directory.clone(),
                    workspace: location.workspace.clone(),
                }),
        },
    )?;
    let kind = query.kind.map(convert::kind).transpose()?;
    let stage = query.stage.map(convert::stage).transpose()?;
    use v5::project_artifact_api_list_item::Kind;
    let items = if query.scope == 3 {
        let project = scope(&services.store, &project, 1)?;
        let global = services.store.resolve_global_scope().map_err(failure)?.id;
        [project, global]
            .iter()
            .map(|scope| {
                services
                    .store
                    .list_trash(scope, kind.as_ref(), stage.as_ref())
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(failure)?
            .into_iter()
            .flatten()
            .map(|value| v5::ProjectArtifactApiListItem {
                kind: Some(Kind::Value2(convert::trash_summary(&value))),
            })
            .collect()
    } else {
        let scope = scope(&services.store, &project, query.scope)?;
        services
            .store
            .list(&scope, kind.as_ref(), stage.as_ref())
            .map_err(failure)?
            .iter()
            .map(|value| v5::ProjectArtifactApiListItem {
                kind: Some(Kind::Value1(convert::summary(value))),
            })
            .collect()
    };
    Ok(v5::ArtifactListResult {
        data: v5::ArtifactListResultData { items },
    })
}

async fn metrics(
    invocation: Invocation,
    request: v5::ArtifactMetricsRequest,
) -> Result<v5::ArtifactMetricsResult, Failure> {
    let (services, project) = prepare(&invocation, &request.query)?;
    let scope = scope(&services.store, &project, request.params.scope)?;
    let kind = convert::kind(request.params.kind)?;
    let id = crate::convert::identifier(&request.params.id)?;
    let details = services.store.get(&scope, &kind, &id).map_err(failure)?;
    let mut metrics = services
        .store
        .metrics(&details.current_version.id)
        .map_err(failure)?;
    metrics.last_used_at = details.artifact.last_used_at;
    Ok(v5::ArtifactMetricsResult {
        data: convert::metrics(&metrics),
    })
}

async fn disable(
    invocation: Invocation,
    request: v5::ArtifactDisableRequest,
) -> Result<v5::ArtifactDisableResult, Failure> {
    let (services, project) = prepare(&invocation, &request.query)?;
    let scope = scope(&services.store, &project, request.params.scope)?;
    let kind = convert::kind(request.params.kind)?;
    let id = crate::convert::identifier(&request.params.id)?;
    let expected = convert::expectation(&request.payload)?;
    committed(
        &services,
        services.store.disable(store::LifecycleInput {
            scope_id: &scope,
            kind: &kind,
            id: &id,
            expected: &expected,
            now: ids::now_millis(),
        }),
    )?;
    Ok(v5::ArtifactDisableResult { data: v5::Empty {} })
}

async fn enable(
    invocation: Invocation,
    request: v5::ArtifactEnableRequest,
) -> Result<v5::ArtifactEnableResult, Failure> {
    let (services, project) = prepare(&invocation, &request.query)?;
    let scope = scope(&services.store, &project, request.params.scope)?;
    let kind = convert::kind(request.params.kind)?;
    let id = crate::convert::identifier(&request.params.id)?;
    let expected = convert::expectation(&request.payload)?;
    committed(
        &services,
        services.store.enable(store::LifecycleInput {
            scope_id: &scope,
            kind: &kind,
            id: &id,
            expected: &expected,
            now: ids::now_millis(),
        }),
    )?;
    Ok(v5::ArtifactEnableResult { data: v5::Empty {} })
}

async fn revert(
    invocation: Invocation,
    request: v5::ArtifactRevertRequest,
) -> Result<v5::ArtifactRevertResult, Failure> {
    let (services, project) = prepare(&invocation, &request.query)?;
    let scope = scope(&services.store, &project, request.params.scope)?;
    let kind = convert::kind(request.params.kind)?;
    let id = crate::convert::identifier(&request.params.id)?;
    let expected = convert::expectation(&v5::ProjectArtifactApiExpectation {
        expected_revision: request.payload.expected_revision,
        expected_version_id: request.payload.expected_version_id,
        expected_digest: request.payload.expected_digest,
    })?;
    let target = crate::convert::identifier(&request.payload.target_version_id)?;
    committed(
        &services,
        services.store.revert(
            store::LifecycleInput {
                scope_id: &scope,
                kind: &kind,
                id: &id,
                expected: &expected,
                now: ids::now_millis(),
            },
            Some(&target),
        ),
    )?;
    Ok(v5::ArtifactRevertResult { data: v5::Empty {} })
}

async fn remove(
    invocation: Invocation,
    request: v5::ArtifactRemoveRequest,
) -> Result<v5::ArtifactRemoveResult, Failure> {
    let (services, project) = prepare(&invocation, &request.query)?;
    let scope = scope(&services.store, &project, request.params.scope)?;
    let kind = convert::kind(request.params.kind)?;
    let id = crate::convert::identifier(&request.params.id)?;
    let expected = convert::expectation(&request.payload)?;
    Ok(v5::ArtifactRemoveResult {
        data: convert::trash(&committed(
            &services,
            services.store.remove(store::LifecycleInput {
                scope_id: &scope,
                kind: &kind,
                id: &id,
                expected: &expected,
                now: ids::now_millis(),
            }),
        )?),
    })
}

async fn restore(
    invocation: Invocation,
    request: v5::ArtifactRestoreRequest,
) -> Result<v5::ArtifactRestoreResult, Failure> {
    let (services, _) = prepare(&invocation, &request.query)?;
    let deletion = crate::convert::identifier(&request.params.deletion_id)?;
    committed(
        &services,
        services.store.restore(&deletion, ids::now_millis()),
    )?;
    Ok(v5::ArtifactRestoreResult { data: v5::Empty {} })
}

async fn purge(
    invocation: Invocation,
    request: v5::ArtifactPurgeRequest,
) -> Result<v5::ArtifactPurgeResult, Failure> {
    let (services, _) = prepare(&invocation, &request.query)?;
    Ok(v5::ArtifactPurgeResult {
        data: v5::ArtifactPurgeResultData {
            count: services.store.purge(ids::now_millis()).map_err(failure)? as u64,
        },
    })
}

async fn promotion_preview(
    invocation: Invocation,
    request: v5::ArtifactPromotionPreviewRequest,
) -> Result<v5::ArtifactPromotionPreviewResult, Failure> {
    let (services, project) = prepare(&invocation, &request.query)?;
    let scope = scope(&services.store, &project, 1)?;
    let kind = convert::kind(request.params.kind)?;
    let id = crate::convert::identifier(&request.params.id)?;
    let expected = convert::expectation(&request.payload)?;
    Ok(v5::ArtifactPromotionPreviewResult {
        data: convert::promotion(
            &services
                .store
                .preview_promotion(store::LifecycleInput {
                    scope_id: &scope,
                    kind: &kind,
                    id: &id,
                    expected: &expected,
                    now: ids::now_millis(),
                })
                .map_err(failure)?,
        ),
    })
}

async fn promotion_confirm(
    invocation: Invocation,
    request: v5::ArtifactPromotionConfirmRequest,
) -> Result<v5::ArtifactPromotionConfirmResult, Failure> {
    let (services, _) = prepare(&invocation, &request.query)?;
    let token = crate::convert::identifier(&request.params.token)?;
    Ok(v5::ArtifactPromotionConfirmResult {
        data: convert::mutation(committed(
            &services,
            services.store.confirm_promotion(&token, ids::now_millis()),
        )?),
    })
}

async fn fork_preview(
    invocation: Invocation,
    request: v5::ArtifactForkPreviewRequest,
) -> Result<v5::ArtifactForkPreviewResult, Failure> {
    let (services, project) = prepare(&invocation, &request.query)?;
    let kind = convert::kind(request.params.kind)?;
    let id = crate::convert::identifier(&request.params.id)?;
    let expected = convert::expectation(&request.payload)?;
    Ok(v5::ArtifactForkPreviewResult {
        data: convert::preview(
            services
                .store
                .preview_fork(store::ForkPreviewInput {
                    project_id: &project,
                    kind: &kind,
                    id: &id,
                    expected_revision: Some(expected.expected_revision),
                    expected_version_id: &expected.expected_version_id,
                    expected_digest: &expected.expected_digest,
                    now: ids::now_millis(),
                })
                .map_err(failure)?,
        ),
    })
}

async fn fork_confirm(
    invocation: Invocation,
    request: v5::ArtifactForkConfirmRequest,
) -> Result<v5::ArtifactForkConfirmResult, Failure> {
    let (services, _) = prepare(&invocation, &request.query)?;
    let token = crate::convert::identifier(&request.params.token)?;
    Ok(v5::ArtifactForkConfirmResult {
        data: convert::mutation(committed(
            &services,
            services.store.confirm_fork(&token, ids::now_millis()),
        )?),
    })
}

async fn shadow_preview(
    invocation: Invocation,
    request: v5::ArtifactShadowPreviewRequest,
) -> Result<v5::ArtifactShadowPreviewResult, Failure> {
    let (services, project) = prepare(&invocation, &request.query)?;
    let kind = convert::kind(request.params.kind)?;
    let id = crate::convert::identifier(&request.params.id)?;
    let expected = convert::expectation(&request.payload)?;
    let global_scope = services.store.resolve_global_scope().map_err(failure)?;
    let global = services
        .store
        .get(&global_scope.id, &kind, &id)
        .map_err(failure)?;
    let global_expected = project_artifact::MutationExpectation {
        expected_revision: global.artifact.revision,
        expected_version_id: global.current_version.id,
        expected_digest: global.current_version.content_digest,
    };
    Ok(v5::ArtifactShadowPreviewResult {
        data: convert::preview(
            services
                .store
                .preview_shadow(store::ShadowInput {
                    project_id: &project,
                    kind: &kind,
                    id: &id,
                    expected: &expected,
                    global_scope_id: &global_scope.id,
                    global_expected: &global_expected,
                    now: ids::now_millis(),
                })
                .map_err(failure)?,
        ),
    })
}

async fn shadow_confirm(
    invocation: Invocation,
    request: v5::ArtifactShadowConfirmRequest,
) -> Result<v5::ArtifactShadowConfirmResult, Failure> {
    let (services, _) = prepare(&invocation, &request.query)?;
    let token = crate::convert::identifier(&request.params.token)?;
    committed(
        &services,
        services.store.confirm_shadow(&token, ids::now_millis()),
    )?;
    Ok(v5::ArtifactShadowConfirmResult { data: v5::Empty {} })
}

pub(crate) fn error_payload(code: &project_artifact::ErrorCode) -> v5::TypedPayload {
    fn encoded<T: Message + Name>(value: T) -> v5::TypedPayload {
        v5::TypedPayload {
            type_name: T::full_name(),
            payload: value.encode_to_vec(),
        }
    }
    let JsonValue::String(code) = code.encode() else {
        unreachable!("artifact error literal")
    };
    match code.as_str().expect("artifact error literal") {
        "ProjectIdentityUnavailable" => encoded(v5::ArtifactBadRequest { tag: 1, code: 1 }),
        "InvalidArtifact" => encoded(v5::ArtifactBadRequest { tag: 1, code: 2 }),
        "UnsafeContent" => encoded(v5::ArtifactBadRequest { tag: 1, code: 3 }),
        "UnsupportedKind" => encoded(v5::ArtifactBadRequest { tag: 1, code: 4 }),
        "InvalidScope" => encoded(v5::ArtifactBadRequest { tag: 1, code: 5 }),
        "ArtifactNotFound" => encoded(v5::ArtifactNotFound { tag: 1, code: 1 }),
        "VersionNotFound" => encoded(v5::ArtifactNotFound { tag: 1, code: 2 }),
        "DeletionNotFound" => encoded(v5::ArtifactNotFound { tag: 1, code: 3 }),
        "ArtifactCollision" => encoded(v5::ArtifactConflict { tag: 1, code: 1 }),
        "ScopeCollision" => encoded(v5::ArtifactConflict { tag: 1, code: 2 }),
        "VersionConflict" => encoded(v5::ArtifactConflict { tag: 1, code: 3 }),
        "OwnershipMismatch" => encoded(v5::ArtifactConflict { tag: 1, code: 4 }),
        "DestinationExists" => encoded(v5::ArtifactConflict { tag: 1, code: 5 }),
        "ProjectAdoptionConflict" => encoded(v5::ArtifactConflict { tag: 1, code: 6 }),
        "ConfirmationExpired" => encoded(v5::ArtifactGone { tag: 1, code: 1 }),
        "TrashExpired" => encoded(v5::ArtifactGone { tag: 1, code: 2 }),
        "ContentTooLarge" => encoded(v5::ArtifactTooLarge { tag: 1, code: 1 }),
        "ScopeQuotaExceeded" => encoded(v5::ArtifactTooLarge { tag: 1, code: 2 }),
        "WriteRateExceeded" => encoded(v5::ArtifactRateLimited { tag: 1, code: 1 }),
        "ArtifactCooldown" => encoded(v5::ArtifactRateLimited { tag: 1, code: 2 }),
        "StorageUnavailable" => encoded(v5::ArtifactUnavailable { tag: 1, code: 1 }),
        "LockTimeout" => encoded(v5::ArtifactUnavailable { tag: 1, code: 2 }),
        "ReconciliationRequired" => encoded(v5::ArtifactUnavailable { tag: 1, code: 3 }),
        _ => unreachable!("validated artifact error code"),
    }
}
