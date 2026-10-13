use super::{Error, Hooks, Service, error, key, package, reject, scan_all, scope_ids, scope_root};
use crate::resources::project_artifact::{accounting, adapter, filesystem};
use std::{collections::BTreeSet, fs};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder, project_artifact,
};
use ycoding_store::{TableSpec, Write, artifacts};

impl Service {
    pub fn reconcile(
        &self,
        scope_id: &project_artifact::ScopeId,
    ) -> Result<Vec<package::Marker>, Error> {
        let scope = self.scope_from_snapshot(&self.client.snapshot()?, scope_id)?;
        let (_, storage) = scope_ids(&scope);
        let root = scope_root(&self.paths.data, storage);
        let _scope = package::package_lock(
            &self.paths.data,
            &format!(
                "project-artifact-scope:{}",
                scope_id.as_lossless().as_str().expect("scope")
            ),
        )?;
        let transactions = package::read_commit_transactions(&root, &Hooks::default())?;
        for metadata in &transactions {
            let operation = self
                .client
                .snapshot()?
                .get::<artifacts::OperationTable>(&key(&metadata.operation_id.as_str().into()))?
                .ok_or_else(|| error("ReconciliationRequired"))?;
            if operation.scope_id != *scope_id.as_lossless()
                || !commit_matches(&operation, &metadata.marker)
            {
                return Err(error("ReconciliationRequired"));
            }
            if operation.phase.as_str() == Some("finalized") {
                if !matches!(
                    metadata.phase,
                    package::CommitPhase::Finalizing | package::CommitPhase::Committed
                ) {
                    return Err(error("ReconciliationRequired"));
                }
                package::cleanup_commit_transaction(metadata, &Hooks::default())?;
                continue;
            }
            let path = if metadata.content_path.exists() {
                metadata.content_path.clone()
            } else {
                metadata.stage_root.join(
                    metadata
                        .marker
                        .content_relpath
                        .as_lossless()
                        .as_str()
                        .expect("path"),
                )
            };
            let content = if metadata.standard && path == metadata.content_path {
                filesystem::read_text(
                    metadata
                        .content_path
                        .parent()
                        .ok_or_else(|| error("ReconciliationRequired"))?,
                    &path,
                    &Hooks::default(),
                )
            } else {
                filesystem::read_text(&root, &path, &Hooks::default())
            }
            .map_err(|_| error("ReconciliationRequired"))?;
            if package::sha256(&content.as_str().into()) != metadata.marker.content_digest {
                return Err(error("ReconciliationRequired"));
            }
            let client = self.client.clone();
            let finalized = operation.clone();
            let marker = metadata.marker.clone();
            let finalize = move |_: &package::CommitTransactionMetadata| {
                let mut operation = finalized.clone();
                let marker = marker.clone();
                client
                    .submit(move |tx| {
                        operation.phase = "available".into();
                        artifacts::OperationTable::put(tx, &operation)?;
                        finalize_commit(tx, &operation, &marker)
                    })?
                    .wait()
                    .map_err(Error::from)
            };
            let client = self.client.clone();
            let aborted = operation.clone();
            let marker = metadata.marker.clone();
            let abort = move |_: &package::CommitTransactionMetadata| {
                let operation = aborted.clone();
                let marker = marker.clone();
                client
                    .submit(move |tx| abort_commit(tx, &operation, &marker))?
                    .wait()
                    .map_err(Error::from)
            };
            let content: LosslessString = content.as_str().into();
            let can_compensate = || !self.client.is_fenced();
            package::commit_transaction(
                package::CommitInput {
                    root: &root,
                    marker: &metadata.marker,
                    content: &content,
                    expected_version_id: metadata
                        .previous
                        .as_ref()
                        .map(|marker| &marker.version_id),
                    operation_id: Some(&metadata.operation_id),
                    standard: metadata.standard.then_some(package::StandardTarget {
                        content_path: &metadata.content_path,
                        marker_path: &metadata.marker_path,
                    }),
                    no_overwrite: metadata.standard && metadata.previous.is_none(),
                },
                &Hooks::default(),
                &package::TransactionHooks {
                    reserve: None,
                    finalize: Some(&finalize),
                    abort: Some(&abort),
                    cancellation: None,
                    can_compensate: Some(&can_compensate),
                },
            )
            .map_err(transaction_error)?;
        }
        let states = package::read_state_transactions(&root, &Hooks::default())?;
        for metadata in &states {
            let operation = self
                .client
                .snapshot()?
                .get::<artifacts::OperationTable>(&key(&metadata.operation_id.as_str().into()))?
                .ok_or_else(|| error("ReconciliationRequired"))?;
            let target = metadata.target.as_ref().unwrap_or(&metadata.current);
            if operation.scope_id != *scope_id.as_lossless()
                || operation.kind != *metadata.current.kind.as_lossless()
                || operation.artifact_id != *metadata.current.id.as_lossless()
                || operation.expected_version_id.as_ref()
                    != Some(metadata.current.version_id.as_lossless())
                || operation.expected_digest.as_ref()
                    != Some(metadata.current.content_digest.as_lossless())
                || operation.target_version_id.as_ref() != Some(target.version_id.as_lossless())
                || operation.target_digest.as_ref() != Some(target.content_digest.as_lossless())
                || operation.operation.as_str()
                    != Some(match metadata.operation {
                        package::StateOperation::Rollback => "revert",
                        package::StateOperation::Disable => "disable",
                        package::StateOperation::Enable => "enable",
                    })
            {
                return Err(error("ReconciliationRequired"));
            }
            if operation.phase.as_str() == Some("finalized") {
                if !matches!(
                    metadata.phase,
                    package::StatePhase::Finalizing | package::StatePhase::Committed
                ) {
                    return Err(error("ReconciliationRequired"));
                }
                package::cleanup_state_transaction(metadata, &Hooks::default())?;
            }
        }
        for operation in scan_all::<artifacts::OperationTable>(&self.client.snapshot()?)?
            .into_iter()
            .filter(|operation| {
                operation.scope_id == *scope_id.as_lossless()
                    && matches!(operation.phase.as_str(), Some("preparing" | "available"))
                    && matches!(
                        operation.operation.as_str(),
                        Some("disable" | "enable" | "revert")
                    )
            })
        {
            if let Some(state) = states.iter().find(|state| {
                state.operation_id.as_str() == operation.id.as_str().expect("operation")
                    && state.context.is_some()
            }) {
                self.recover_governor(&operation, state)?;
                continue;
            }
            let kind = project_artifact::Kind::decode(&operation.kind.encode())
                .map_err(|_| error("ReconciliationRequired"))?;
            let id = project_artifact::Id::decode(&operation.artifact_id.encode())
                .map_err(|_| error("ReconciliationRequired"))?;
            let expected = project_artifact::MutationExpectation {
                expected_revision: project_artifact::Revision::decode(&JsonValue::Number(
                    operation
                        .expected_revision
                        .ok_or_else(|| error("ReconciliationRequired"))? as f64,
                ))
                .map_err(|_| error("ReconciliationRequired"))?,
                expected_version_id: project_artifact::VersionId::decode(
                    &operation
                        .expected_version_id
                        .as_ref()
                        .ok_or_else(|| error("ReconciliationRequired"))?
                        .encode(),
                )
                .map_err(|_| error("ReconciliationRequired"))?,
                expected_digest: project_artifact::Digest::decode(
                    &operation
                        .expected_digest
                        .as_ref()
                        .ok_or_else(|| error("ReconciliationRequired"))?
                        .encode(),
                )
                .map_err(|_| error("ReconciliationRequired"))?,
            };
            let target = operation
                .target_version_id
                .as_ref()
                .map(|target| project_artifact::VersionId::decode(&target.encode()))
                .transpose()
                .map_err(|_| error("ReconciliationRequired"))?;
            let change = match operation.operation.as_str() {
                Some("enable") => super::lifecycle::Change::Enable,
                Some("revert") => super::lifecycle::Change::Revert(target.as_ref()),
                _ => super::lifecycle::Change::Disable,
            };
            self.change_state_locked(
                super::LifecycleInput {
                    scope_id,
                    kind: &kind,
                    id: &id,
                    expected: &expected,
                    now: operation.time_created,
                },
                change,
            )?;
        }
        let transaction_ids = transactions
            .iter()
            .map(|metadata| metadata.operation_id.as_str())
            .collect::<BTreeSet<_>>();
        let operations = scan_all::<artifacts::OperationTable>(&self.client.snapshot()?)?;
        for operation in operations.into_iter().filter(|operation| {
            operation.scope_id == *scope_id.as_lossless()
                && matches!(
                    operation.operation.as_str(),
                    Some("create" | "update" | "promotion" | "fork")
                )
                && matches!(operation.phase.as_str(), Some("preparing" | "available"))
                && !transaction_ids.contains(operation.id.as_str().expect("operation"))
        }) {
            if operation.phase.as_str() == Some("available") {
                return Err(error("ReconciliationRequired"));
            }
            self.client
                .submit(move |tx| {
                    let mut operation = operation;
                    operation.phase = "aborted".into();
                    operation.time_updated = chrono::Utc::now().timestamp_millis();
                    artifacts::OperationTable::put(tx, &operation)
                })?
                .wait()?;
        }
        let project_markers = package::reconcile(&root, &Hooks::default())?;
        for operation in scan_all::<artifacts::OperationTable>(&self.client.snapshot()?)?
            .into_iter()
            .filter(|operation| {
                operation.scope_id == *scope_id.as_lossless()
                    && operation.phase.as_str() == Some("preparing")
                    && matches!(operation.operation.as_str(), Some("remove" | "restore"))
            })
        {
            if operation.operation.as_str() == Some("restore") {
                let deletion = project_artifact::DeletionId::decode(
                    &operation
                        .deletion_id
                        .as_ref()
                        .ok_or_else(|| error("ReconciliationRequired"))?
                        .encode(),
                )
                .map_err(|_| error("ReconciliationRequired"))?;
                self.restore_locked(&deletion, operation.time_created)?;
                continue;
            }
            let kind = project_artifact::Kind::decode(&operation.kind.encode())
                .map_err(|_| error("ReconciliationRequired"))?;
            let id = project_artifact::Id::decode(&operation.artifact_id.encode())
                .map_err(|_| error("ReconciliationRequired"))?;
            let expected = project_artifact::MutationExpectation {
                expected_revision: project_artifact::Revision::decode(&JsonValue::Number(
                    operation
                        .expected_revision
                        .ok_or_else(|| error("ReconciliationRequired"))? as f64,
                ))
                .map_err(|_| error("ReconciliationRequired"))?,
                expected_version_id: project_artifact::VersionId::decode(
                    &operation
                        .expected_version_id
                        .as_ref()
                        .ok_or_else(|| error("ReconciliationRequired"))?
                        .encode(),
                )
                .map_err(|_| error("ReconciliationRequired"))?,
                expected_digest: project_artifact::Digest::decode(
                    &operation
                        .expected_digest
                        .as_ref()
                        .ok_or_else(|| error("ReconciliationRequired"))?
                        .encode(),
                )
                .map_err(|_| error("ReconciliationRequired"))?,
            };
            self.remove_locked(super::LifecycleInput {
                scope_id,
                kind: &kind,
                id: &id,
                expected: &expected,
                now: operation.time_created,
            })?;
        }
        let markers = if matches!(scope, project_artifact::Scope::Global(_)) {
            package::reconcile_standard(
                package::StandardReconcileInput {
                    root: &root,
                    scope_id,
                    storage_id: storage,
                    roots: package::StandardRoots {
                        skill: Some(&self.paths.home.join(".agents/skills")),
                        command: Some(&self.paths.config.join("commands")),
                        agent: Some(&self.paths.config.join("agents")),
                    },
                },
                &Hooks::default(),
            )?
            .owned
        } else {
            project_markers
        };
        for operation in scan_all::<artifacts::OperationTable>(&self.client.snapshot()?)?
            .into_iter()
            .filter(|operation| {
                operation.scope_id == *scope_id.as_lossless()
                    && operation.operation.as_str() == Some("shadow")
                    && matches!(operation.phase.as_str(), Some("preparing" | "available"))
            })
        {
            self.client
                .submit(move |tx| {
                    let expected = operation
                        .expected_version_id
                        .as_ref()
                        .ok_or_else(|| reject(tx, "ReconciliationRequired"))?;
                    let source_scope = operation
                        .source_scope_id
                        .as_ref()
                        .ok_or_else(|| reject(tx, "ReconciliationRequired"))?;
                    let source_version = operation
                        .source_version_id
                        .as_ref()
                        .ok_or_else(|| reject(tx, "ReconciliationRequired"))?;
                    let source_digest = operation
                        .source_digest
                        .as_ref()
                        .ok_or_else(|| reject(tx, "ReconciliationRequired"))?;
                    let target = operation
                        .target_version_id
                        .clone()
                        .ok_or_else(|| reject(tx, "ReconciliationRequired"))?;
                    let mut artifact = tx
                        .get::<artifacts::ArtifactTable>(&artifacts::identity(
                            &operation.scope_id,
                            &operation.kind,
                            &operation.artifact_id,
                        ))?
                        .ok_or_else(|| reject(tx, "VersionConflict"))?;
                    let mut version = tx
                        .get::<artifacts::VersionTable>(&key(expected))?
                        .ok_or_else(|| reject(tx, "VersionConflict"))?;
                    let source = tx
                        .get::<artifacts::ArtifactTable>(&artifacts::identity(
                            source_scope,
                            &operation.kind,
                            &operation.artifact_id,
                        ))?
                        .ok_or_else(|| reject(tx, "VersionConflict"))?;
                    let source_value = tx
                        .get::<artifacts::VersionTable>(&key(source_version))?
                        .ok_or_else(|| reject(tx, "VersionConflict"))?;
                    if operation.expected_revision.is_none()
                        || artifact.current_version_id != *expected
                        || operation.expected_digest.as_ref() != Some(&version.content_digest)
                        || source.current_version_id != *source_version
                        || source_value.content_digest != *source_digest
                    {
                        return Err(reject(tx, "VersionConflict"));
                    }
                    if artifact.shadowed_scope_id.as_ref() != Some(source_scope)
                        || version.origin_scope_id.as_ref() != Some(source_scope)
                        || version.origin_version_id.as_ref() != Some(source_version)
                        || version.origin_evidence_digest.as_ref() != Some(source_digest)
                    {
                        artifact.revision += 1;
                        artifact.shadowed_scope_id = Some(source_scope.clone());
                        artifact.time_updated = operation.time_created;
                        version.origin_scope_id = Some(source_scope.clone());
                        version.origin_version_id = Some(source_version.clone());
                        version.origin_evidence_digest = Some(source_digest.clone());
                        artifacts::VersionTable::put(tx, &version)?;
                        artifacts::ArtifactTable::put(tx, &artifact)?;
                    }
                    finalize_operation(
                        tx,
                        &operation,
                        Some(target),
                        chrono::Utc::now().timestamp_millis(),
                    )
                })?
                .wait()?;
        }
        for entry in fs::read_dir(root.join("trash"))
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_type()
                    .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
            })
        {
            let deletion = project_artifact::DeletionId::decode(&JsonValue::String(
                entry.file_name().to_string_lossy().as_ref().into(),
            ))
            .map_err(|_| error("ReconciliationRequired"))?;
            let manifest = package::read_trash_manifest(&root, &deletion, &Hooks::default())?;
            if manifest.phase != package::TrashPhase::Trashed
                || manifest.scope_id != *scope_id
                || manifest.storage_id != *storage
            {
                return Err(error("ReconciliationRequired"));
            }
            self.client
                .submit(move |tx| {
                    let artifact = tx
                        .get::<artifacts::ArtifactTable>(&artifacts::identity(
                            manifest.scope_id.as_lossless(),
                            manifest.kind.as_lossless(),
                            manifest.id.as_lossless(),
                        ))?
                        .ok_or_else(|| reject(tx, "ReconciliationRequired"))?;
                    let version = tx
                        .get::<artifacts::VersionTable>(&key(&artifact.current_version_id))?
                        .ok_or_else(|| reject(tx, "VersionNotFound"))?;
                    if !manifest.entries.iter().any(|entry| {
                        entry.version_id.as_lossless() == &version.id
                            && entry.content_digest.as_lossless() == &version.content_digest
                            && entry.content_relpath.as_lossless() == &version.content_relpath
                    }) {
                        return Err(reject(tx, "OwnershipMismatch"));
                    }
                    let row = artifacts::Trash {
                        deletion_id: manifest.deletion_id.as_lossless().clone(),
                        scope_id: manifest.scope_id.as_lossless().clone(),
                        kind: manifest.kind.as_lossless().clone(),
                        artifact_id: manifest.id.as_lossless().clone(),
                        prior_stage: super::literal(&manifest.prior_stage),
                        prior_version_id: version.id.clone(),
                        deleted_at: manifest.deleted_at as i64,
                        purge_after: manifest.deleted_at as i64 + 30 * 86_400_000,
                    };
                    if let Some(existing) =
                        tx.get::<artifacts::TrashTable>(&key(&row.deletion_id))?
                    {
                        if existing != row {
                            return Err(reject(tx, "VersionConflict"));
                        }
                    } else {
                        artifacts::TrashTable::insert(tx, &row)?;
                    }
                    record_feedback(tx, &version, "delete", row.deleted_at)?;
                    for operation in transaction_rows::<artifacts::OperationTable>(tx)?
                        .into_iter()
                        .filter(|operation| {
                            operation.scope_id == row.scope_id
                                && operation.operation.as_str() == Some("remove")
                                && operation.deletion_id.as_ref() == Some(&row.deletion_id)
                                && matches!(
                                    operation.phase.as_str(),
                                    Some("preparing" | "available")
                                )
                        })
                    {
                        finalize_operation(
                            tx,
                            &operation,
                            None,
                            chrono::Utc::now().timestamp_millis(),
                        )?;
                    }
                    Ok(())
                })?
                .wait()?;
        }
        let mut current_markers = Vec::new();
        for scanned in markers {
            let marker = package::with_artifact_lock(&root, &scanned, || {
                let Some(marker) = read_current(self, &scope, &scanned.kind, &scanned.id)
                    .map_err(package_error)?
                else {
                    return Ok(None);
                };
                let folded = marker.clone();
                self.client
                    .submit(move |tx| fold_marker(tx, &folded))
                    .map_err(store_package_error)?
                    .wait()
                    .map_err(store_package_error)?;
                Ok(Some(marker))
            })?;
            if let Some(marker) = marker {
                current_markers.push(marker);
            }
        }
        for trash in scan_all::<artifacts::TrashTable>(&self.client.snapshot()?)?
            .into_iter()
            .filter(|trash| {
                trash.scope_id == *scope_id.as_lossless()
                    && !root
                        .join("trash")
                        .join(trash.deletion_id.as_str().expect("deletion"))
                        .join(".ycoding-trash.json")
                        .exists()
            })
        {
            let kind = project_artifact::Kind::decode(&trash.kind.encode())
                .map_err(|_| error("ReconciliationRequired"))?;
            let id = project_artifact::Id::decode(&trash.artifact_id.encode())
                .map_err(|_| error("ReconciliationRequired"))?;
            let version = self
                .client
                .snapshot()?
                .get::<artifacts::VersionTable>(&key(&trash.prior_version_id))?
                .ok_or_else(|| error("VersionNotFound"))?;
            let marker = read_current(self, &scope, &kind, &id)?;
            if marker.as_ref().is_some_and(|marker| {
                marker.version_id.as_lossless() == &version.id
                    && marker.content_digest.as_lossless() == &version.content_digest
            }) {
                self.client
                    .submit(move |tx| {
                        tx.delete::<artifacts::TrashTable>(&key(&trash.deletion_id))?;
                        record_feedback(
                            tx,
                            &version,
                            "restore",
                            chrono::Utc::now().timestamp_millis(),
                        )?;
                        for operation in transaction_rows::<artifacts::OperationTable>(tx)?
                            .into_iter()
                            .filter(|operation| {
                                operation.scope_id == trash.scope_id
                                    && operation.operation.as_str() == Some("restore")
                                    && operation.deletion_id.as_ref() == Some(&trash.deletion_id)
                                    && matches!(
                                        operation.phase.as_str(),
                                        Some("preparing" | "available")
                                    )
                            })
                        {
                            finalize_operation(
                                tx,
                                &operation,
                                Some(version.id.clone()),
                                chrono::Utc::now().timestamp_millis(),
                            )?;
                        }
                        Ok(())
                    })?
                    .wait()?;
                continue;
            }
            if chrono::Utc::now().timestamp_millis() < trash.purge_after {
                return Err(error("ReconciliationRequired"));
            }
            self.client
                .submit(move |tx| purge_index(tx, &trash))?
                .wait()?;
        }
        let keys = current_markers
            .iter()
            .map(|marker| {
                (
                    marker.kind.as_lossless().clone(),
                    marker.id.as_lossless().clone(),
                )
            })
            .collect::<BTreeSet<_>>();
        let snapshot = self.client.snapshot()?;
        let trash = scan_all::<artifacts::TrashTable>(&snapshot)?;
        let missing = scan_all::<artifacts::ArtifactTable>(&snapshot)?
            .into_iter()
            .filter(|artifact| {
                artifact.scope_id == *scope_id.as_lossless()
                    && !keys.contains(&(artifact.kind.clone(), artifact.artifact_id.clone()))
                    && !trash.iter().any(|trash| {
                        trash.scope_id == artifact.scope_id
                            && trash.kind == artifact.kind
                            && trash.artifact_id == artifact.artifact_id
                    })
            })
            .collect::<Vec<_>>();
        drop(snapshot);
        for artifact in missing {
            let marker = owner_marker(self, &scope, &artifact)?;
            package::with_artifact_lock(&root, &marker, || {
                if let Some(current) =
                    read_current(self, &scope, &marker.kind, &marker.id).map_err(package_error)?
                {
                    let folded = current.clone();
                    self.client
                        .submit(move |tx| fold_marker(tx, &folded))
                        .map_err(store_package_error)?
                        .wait()
                        .map_err(store_package_error)?;
                    current_markers.push(current);
                    return Ok(());
                }
                let artifact = artifact.clone();
                self.client
                    .submit(move |tx| {
                        let mut current = tx
                            .get::<artifacts::ArtifactTable>(&artifacts::identity(
                                &artifact.scope_id,
                                &artifact.kind,
                                &artifact.artifact_id,
                            ))?
                            .ok_or_else(|| reject(tx, "VersionConflict"))?;
                        if current.revision != artifact.revision
                            || current.current_version_id != artifact.current_version_id
                        {
                            return Err(reject(tx, "VersionConflict"));
                        }
                        if !matches!(current.stage.as_str(), Some("disabled" | "degraded")) {
                            current.stage = "disabled".into();
                            current.revision += 1;
                            current.time_updated = chrono::Utc::now().timestamp_millis();
                            let mut version = tx
                                .get::<artifacts::VersionTable>(&key(&current.current_version_id))?
                                .ok_or_else(|| reject(tx, "VersionNotFound"))?;
                            version.state = "disabled".into();
                            version.time_state_changed = current.time_updated;
                            artifacts::VersionTable::put(tx, &version)?;
                            artifacts::ArtifactTable::put(tx, &current)?;
                        }
                        Ok(())
                    })
                    .map_err(store_package_error)?
                    .wait()
                    .map_err(store_package_error)?;
                Ok(())
            })?;
        }
        Ok(current_markers)
    }
}

fn commit_matches(operation: &artifacts::Operation, marker: &package::Marker) -> bool {
    operation.scope_id == *marker.scope_id.as_lossless()
        && operation.kind == *marker.kind.as_lossless()
        && operation.artifact_id == *marker.id.as_lossless()
        && operation.target_version_id.as_ref() == Some(marker.version_id.as_lossless())
        && operation.target_digest.as_ref() == Some(marker.content_digest.as_lossless())
}
fn finalize_commit(
    tx: &mut Write<'_>,
    operation: &artifacts::Operation,
    marker: &package::Marker,
) -> Result<(), ycoding_store::Error> {
    if !commit_matches(operation, marker) {
        return Err(reject(tx, "ReconciliationRequired"));
    }
    let old = tx.get::<artifacts::ArtifactTable>(&artifacts::identity(
        marker.scope_id.as_lossless(),
        marker.kind.as_lossless(),
        marker.id.as_lossless(),
    ))?;
    let already = old
        .as_ref()
        .is_some_and(|old| old.current_version_id == *marker.version_id.as_lossless());
    if !already
        && ((operation.operation.as_str() == Some("update")
            && !old.as_ref().is_some_and(|old| {
                Some(old.revision) == operation.expected_revision
                    && Some(&old.current_version_id) == operation.expected_version_id.as_ref()
            }))
            || (operation.operation.as_str() != Some("update") && old.is_some()))
    {
        return Err(reject(tx, "VersionConflict"));
    }
    let version = tx.get::<artifacts::VersionTable>(&key(marker.version_id.as_lossless()))?;
    let version = version.unwrap_or_else(|| {
        version_from_marker(
            marker,
            operation.time_created,
            if operation.operation.as_str() == Some("promotion") {
                "promotion"
            } else if operation.operation.as_str() == Some("fork") {
                "fork"
            } else if operation.automatic_session_id.is_some() {
                "agent"
            } else {
                "user"
            },
            "trial",
        )
    });
    let mut version = version;
    version.parent_version_id = operation.expected_version_id.clone();
    version.creator_session_id = operation.automatic_session_id.clone();
    version.insight_digest = operation.automatic_insight_digest.clone();
    version.origin_scope_id = operation.source_scope_id.clone();
    version.origin_version_id = operation.source_version_id.clone();
    version.origin_evidence_digest = operation.source_digest.clone();
    if old.is_none() {
        let artifact = artifact_from_marker(
            marker,
            operation.time_created,
            "trial",
            operation
                .source_scope_id
                .clone()
                .filter(|_| operation.operation.as_str() == Some("fork")),
        );
        artifacts::insert_artifact(tx, &artifact, &version)?;
    } else if let Some(mut old) = old
        && !already
    {
        let mut previous = tx
            .get::<artifacts::VersionTable>(&key(&old.current_version_id))?
            .ok_or_else(|| reject(tx, "ReconciliationRequired"))?;
        previous.state = "superseded".into();
        previous.time_state_changed = operation.time_created;
        artifacts::VersionTable::put(tx, &previous)?;
        artifacts::VersionTable::insert(tx, &version)?;
        old.revision += 1;
        old.stage = "trial".into();
        old.fallback_version_id = Some(old.current_version_id);
        old.current_version_id = version.id.clone();
        old.time_updated = operation.time_created;
        artifacts::ArtifactTable::put(tx, &old)?;
    }
    if let (Some(session), Some(insight)) = (
        &operation.automatic_session_id,
        &operation.automatic_insight_digest,
    ) {
        let row = artifacts::AutomaticWrite {
            scope_id: marker.scope_id.as_lossless().clone(),
            session_id: session.clone(),
            insight_digest: insight.clone(),
            operation: if operation.operation.as_str() == Some("update") {
                "update"
            } else {
                "create"
            }
            .into(),
            result: if operation.operation.as_str() == Some("update") {
                "updated"
            } else {
                "created"
            }
            .into(),
            version_id: marker.version_id.as_lossless().clone(),
            content_digest: marker.content_digest.as_lossless().clone(),
            time_created: operation.time_created,
        };
        let record_key = artifacts::WriteTable::primary_key(&row);
        if let Some(existing) = tx.get::<artifacts::WriteTable>(&record_key)? {
            if existing != row {
                return Err(reject(tx, "VersionConflict"));
            }
        } else {
            artifacts::WriteTable::insert(tx, &row)?;
        }
    }
    if operation.operation.as_str() == Some("promotion") {
        let source_scope = operation
            .source_scope_id
            .as_ref()
            .ok_or_else(|| reject(tx, "ReconciliationRequired"))?;
        let source_version = operation
            .source_version_id
            .as_ref()
            .ok_or_else(|| reject(tx, "ReconciliationRequired"))?;
        let mut source = tx
            .get::<artifacts::ArtifactTable>(&artifacts::identity(
                source_scope,
                &operation.kind,
                &operation.artifact_id,
            ))?
            .ok_or_else(|| reject(tx, "ReconciliationRequired"))?;
        if source.current_version_id == *source_version {
            source.shadowed_scope_id = Some(marker.scope_id.as_lossless().clone());
            source.time_updated = operation.time_created;
            artifacts::ArtifactTable::put(tx, &source)?;
        }
        let version = tx
            .get::<artifacts::VersionTable>(&key(source_version))?
            .ok_or_else(|| reject(tx, "ReconciliationRequired"))?;
        record_feedback(tx, &version, "promote", operation.time_created)?;
    }
    finalize_operation(
        tx,
        operation,
        Some(marker.version_id.as_lossless().clone()),
        operation.time_updated,
    )
}
fn abort_commit(
    tx: &mut Write<'_>,
    operation: &artifacts::Operation,
    marker: &package::Marker,
) -> Result<(), ycoding_store::Error> {
    if let Some(mut artifact) = tx.get::<artifacts::ArtifactTable>(&artifacts::identity(
        marker.scope_id.as_lossless(),
        marker.kind.as_lossless(),
        marker.id.as_lossless(),
    ))? && artifact.current_version_id == *marker.version_id.as_lossless()
        && let (Some(previous), Some(revision)) =
            (&operation.expected_version_id, operation.expected_revision)
    {
        let mut version = tx
            .get::<artifacts::VersionTable>(&key(previous))?
            .ok_or_else(|| reject(tx, "ReconciliationRequired"))?;
        artifact.revision = revision;
        artifact.current_version_id = version.id.clone();
        artifact.fallback_version_id = version.parent_version_id.clone();
        artifact.stage = if version.state.as_str() == Some("active") {
            "active"
        } else {
            "trial"
        }
        .into();
        artifact.time_updated = operation.time_created;
        version.state = artifact.stage.clone();
        version.time_state_changed = operation.time_created;
        artifacts::VersionTable::put(tx, &version)?;
        artifacts::ArtifactTable::put(tx, &artifact)?;
    }
    if operation.operation.as_str() == Some("promotion")
        && let Some(scope) = &operation.source_scope_id
        && let Some(mut source) = tx.get::<artifacts::ArtifactTable>(&artifacts::identity(
            scope,
            &operation.kind,
            &operation.artifact_id,
        ))?
        && source.shadowed_scope_id.as_ref() == Some(marker.scope_id.as_lossless())
    {
        source.shadowed_scope_id = None;
        source.time_updated = operation.time_created;
        artifacts::ArtifactTable::put(tx, &source)?;
    }
    if operation.operation.as_str() == Some("update") {
        if let Some(version) =
            tx.get::<artifacts::VersionTable>(&key(marker.version_id.as_lossless()))?
        {
            for row in transaction_rows::<artifacts::WriteTable>(tx)?
                .into_iter()
                .filter(|row| row.version_id == version.id)
            {
                tx.delete::<artifacts::WriteTable>(&artifacts::WriteTable::primary_key(&row))?;
            }
            tx.delete::<artifacts::VersionTable>(&key(&version.id))?;
        }
    } else if tx
        .get::<artifacts::ArtifactTable>(&artifacts::identity(
            marker.scope_id.as_lossless(),
            marker.kind.as_lossless(),
            marker.id.as_lossless(),
        ))?
        .is_some_and(|artifact| artifact.current_version_id == *marker.version_id.as_lossless())
    {
        artifacts::delete_artifact(
            tx,
            marker.scope_id.as_lossless(),
            marker.kind.as_lossless(),
            marker.id.as_lossless(),
        )?;
    }
    let mut operation = operation.clone();
    operation.phase = "aborted".into();
    operation.final_version_id = None;
    operation.time_updated = chrono::Utc::now().timestamp_millis();
    artifacts::OperationTable::put(tx, &operation)
}
fn fold_marker(tx: &mut Write<'_>, marker: &package::Marker) -> Result<(), ycoding_store::Error> {
    let now = chrono::Utc::now().timestamp_millis();
    let stage = if marker.kind.as_lossless().as_str() == Some("plugin") {
        "quarantine"
    } else {
        "trial"
    };
    let current = tx.get::<artifacts::ArtifactTable>(&artifacts::identity(
        marker.scope_id.as_lossless(),
        marker.kind.as_lossless(),
        marker.id.as_lossless(),
    ))?;
    let existing = tx.get::<artifacts::VersionTable>(&key(marker.version_id.as_lossless()))?;
    let version = existing
        .clone()
        .unwrap_or_else(|| version_from_marker(marker, now, "restore", stage));
    if current.is_none() {
        return artifacts::insert_artifact(
            tx,
            &artifact_from_marker(marker, now, stage, None),
            &version,
        );
    }
    let mut current = current.expect("current");
    if current.current_version_id != version.id
        || (matches!(current.stage.as_str(), Some("disabled" | "degraded"))
            && stage != "quarantine")
    {
        if existing.is_none() {
            artifacts::VersionTable::insert(tx, &version)?;
        }
        if current.current_version_id != version.id {
            let mut old = tx
                .get::<artifacts::VersionTable>(&key(&current.current_version_id))?
                .ok_or_else(|| reject(tx, "VersionNotFound"))?;
            old.state = "superseded".into();
            old.time_state_changed = now;
            artifacts::VersionTable::put(tx, &old)?;
            current.fallback_version_id = Some(current.current_version_id);
        }
        current.revision += 1;
        current.stage = stage.into();
        current.current_version_id = version.id;
        current.time_updated = now;
        artifacts::ArtifactTable::put(tx, &current)?;
    }
    Ok(())
}
pub(super) fn version_from_marker(
    marker: &package::Marker,
    now: i64,
    source: &str,
    state: &str,
) -> artifacts::Version {
    artifacts::Version {
        id: marker.version_id.as_lossless().clone(),
        scope_id: marker.scope_id.as_lossless().clone(),
        kind: marker.kind.as_lossless().clone(),
        artifact_id: marker.id.as_lossless().clone(),
        parent_version_id: None,
        state: state.into(),
        content_digest: marker.content_digest.as_lossless().clone(),
        content_relpath: marker.content_relpath.as_lossless().clone(),
        source: source.into(),
        creator_agent_id: None,
        creator_session_id: None,
        insight_digest: None,
        origin_scope_id: None,
        origin_version_id: None,
        origin_evidence_digest: None,
        first_qualified_at: None,
        last_evaluated_at: None,
        last_restored_at: None,
        last_governor_transition_at: None,
        time_created: now,
        time_state_changed: now,
    }
}
fn artifact_from_marker(
    marker: &package::Marker,
    now: i64,
    stage: &str,
    shadow: Option<LosslessString>,
) -> artifacts::Artifact {
    artifacts::Artifact {
        scope_id: marker.scope_id.as_lossless().clone(),
        kind: marker.kind.as_lossless().clone(),
        artifact_id: marker.id.as_lossless().clone(),
        revision: 0,
        stage: stage.into(),
        current_version_id: marker.version_id.as_lossless().clone(),
        fallback_version_id: None,
        shadowed_scope_id: shadow,
        last_used_at: None,
        time_created: now,
        time_updated: now,
    }
}
pub(super) fn finalize_operation(
    tx: &mut Write<'_>,
    operation: &artifacts::Operation,
    version: Option<LosslessString>,
    now: i64,
) -> Result<(), ycoding_store::Error> {
    let mut operation = operation.clone();
    operation.phase = "finalized".into();
    operation.final_version_id = version;
    operation.time_updated = now;
    artifacts::OperationTable::put(tx, &operation)
}
pub(super) fn record_feedback(
    tx: &mut Write<'_>,
    version: &artifacts::Version,
    action: &str,
    now: i64,
) -> Result<(), ycoding_store::Error> {
    let feedback = project_artifact::Feedback::decode(
        &ObjectEncoder::new()
            .field(
                "artifact",
                &ObjectEncoder::new()
                    .field("scopeID", &version.scope_id)
                    .field("kind", &version.kind)
                    .field("id", &version.artifact_id)
                    .field("versionID", &version.id)
                    .finish(),
            )
            .field("action", &LosslessString::from(action))
            .field("actor", &LosslessString::from("user"))
            .field("timeCreated", &(now as f64))
            .finish(),
    )
    .expect("feedback");
    accounting::Service::record_feedback(tx, &feedback)
        .map_err(|_| reject(tx, "ReconciliationRequired"))?;
    Ok(())
}
fn read_current(
    service: &Service,
    scope: &project_artifact::Scope,
    kind: &project_artifact::Kind,
    id: &project_artifact::Id,
) -> Result<Option<package::Marker>, Error> {
    let (scope_id, storage) = scope_ids(scope);
    let root = scope_root(&service.paths.data, storage);
    let content = if matches!(scope, project_artifact::Scope::Global(_)) {
        adapter::global_path(
            kind,
            &service.paths.home,
            &service.paths.config,
            id.as_lossless().as_str().expect("ID"),
        )
    } else {
        package::active_content_path(&root, kind, id)
    };
    let marker_path = if matches!(scope, project_artifact::Scope::Global(_)) {
        super::standard_marker_path(&content, kind, id)
    } else {
        package::active_marker_path(&root, kind, id)
    };
    if !content.exists() || !marker_path.exists() {
        return Ok(None);
    }
    let safe_root = if matches!(scope, project_artifact::Scope::Global(_)) {
        content.parent().ok_or_else(|| error("OwnershipMismatch"))?
    } else {
        &root
    };
    let marker = filesystem::read_text(safe_root, &marker_path, &Hooks::default())
        .ok()
        .and_then(|content| ycoding_schema::parse_json(&content).ok())
        .and_then(|value| package::Marker::decode(&value).ok());
    let Some(marker) = marker else {
        return Ok(None);
    };
    if marker.scope_id != *scope_id
        || marker.storage_id != *storage
        || marker.kind != *kind
        || marker.id != *id
    {
        return Ok(None);
    }
    let content = filesystem::read_text(safe_root, &content, &Hooks::default())
        .map_err(|_| error("StorageUnavailable"))?;
    Ok((package::sha256(&content.as_str().into()) == marker.content_digest).then_some(marker))
}
fn owner_marker(
    service: &Service,
    scope: &project_artifact::Scope,
    artifact: &artifacts::Artifact,
) -> Result<package::Marker, Error> {
    let snapshot = service.client.snapshot()?;
    let scope = snapshot
        .get::<artifacts::ScopeTable>(&key(scope_ids(scope).0.as_lossless()))?
        .ok_or_else(|| error("InvalidScope"))?;
    let version = snapshot
        .get::<artifacts::VersionTable>(&key(&artifact.current_version_id))?
        .ok_or_else(|| error("VersionNotFound"))?;
    super::sql::marker_value(&scope, &version)
}
fn package_error(error: Error) -> package::Failure {
    package::Failure { code: error.code }
}
fn store_package_error(error: ycoding_store::Error) -> package::Failure {
    package_error(Error::from(error))
}
fn transaction_error(error: package::TransactionError<Error>) -> Error {
    match error {
        package::TransactionError::Package(error) => Error::from(error),
        package::TransactionError::Hook(error) => error,
        package::TransactionError::Interrupted => self::error("ReconciliationRequired"),
    }
}
pub(super) fn transaction_rows<T: TableSpec>(
    tx: &mut Write<'_>,
) -> Result<Vec<T::Record>, ycoding_store::Error> {
    let mut output = Vec::new();
    let mut after = None;
    loop {
        let page = tx.scan::<T>(
            after
                .as_deref()
                .map_or(std::ops::Bound::Unbounded, std::ops::Bound::Excluded),
            std::ops::Bound::Unbounded,
            128,
        )?;
        if page.is_empty() {
            return Ok(output);
        }
        after = page.last().map(T::primary_key);
        output.extend(page);
    }
}
pub(super) fn purge_index(
    tx: &mut Write<'_>,
    trash: &artifacts::Trash,
) -> Result<(), ycoding_store::Error> {
    for operation in transaction_rows::<artifacts::OperationTable>(tx)?
        .into_iter()
        .filter(|operation| {
            operation.scope_id == trash.scope_id
                && operation.kind == trash.kind
                && operation.artifact_id == trash.artifact_id
                && (matches!(operation.phase.as_str(), Some("finalized" | "aborted"))
                    || operation.operation.as_str() == Some("purge"))
        })
    {
        tx.delete::<artifacts::OperationTable>(&key(&operation.id))?;
    }
    artifacts::delete_artifact(tx, &trash.scope_id, &trash.kind, &trash.artifact_id)?;
    Ok(())
}
