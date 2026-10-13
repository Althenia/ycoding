use super::{
    Error, Hooks, LifecycleInput, Service, adapter, error, key, package, recovery, reject,
    scan_all, scope_ids, scope_root, sql,
};
use ycoding_schema::{DomainDecode, DomainEncode, JsonValue, project_artifact};
use ycoding_store::artifacts;

pub struct TrashDetails {
    pub trash: project_artifact::Trash,
    pub definition: project_artifact::Definition,
    pub current_version: project_artifact::Version,
    pub versions: Vec<project_artifact::Version>,
}
impl Service {
    pub fn remove(&self, input: LifecycleInput<'_>) -> Result<project_artifact::Trash, Error> {
        let scope = self.scope_from_snapshot(&self.client.snapshot()?, input.scope_id)?;
        if !matches!(scope, project_artifact::Scope::Project(_)) {
            return Err(error("InvalidScope"));
        }
        let _scope = package::package_lock(
            &self.paths.data,
            &format!(
                "project-artifact-scope:{}",
                input.scope_id.as_lossless().as_str().expect("scope")
            ),
        )?;
        self.remove_locked(input)
    }
    pub(super) fn remove_locked(
        &self,
        input: LifecycleInput<'_>,
    ) -> Result<project_artifact::Trash, Error> {
        let snapshot = self.client.snapshot()?;
        let scope = self.scope_from_snapshot(&snapshot, input.scope_id)?;
        let scope_row = snapshot
            .get::<artifacts::ScopeTable>(&key(input.scope_id.as_lossless()))?
            .ok_or_else(|| error("InvalidScope"))?;
        let artifact = snapshot
            .get::<artifacts::ArtifactTable>(&artifacts::identity(
                input.scope_id.as_lossless(),
                input.kind.as_lossless(),
                input.id.as_lossless(),
            ))?
            .ok_or_else(|| error("ArtifactNotFound"))?;
        if artifact.stage.as_str() == Some("quarantine") {
            return Err(error("UnsupportedKind"));
        }
        let version = snapshot
            .get::<artifacts::VersionTable>(&key(&artifact.current_version_id))?
            .ok_or_else(|| error("VersionNotFound"))?;
        super::check_expectation(Some(&artifact), Some(&version), Some(input.expected))?;
        if matches!(scope, project_artifact::Scope::Global(_)) {
            let sources = self
                .sources
                .lock()
                .map_err(|_| error("StorageUnavailable"))?
                .resolve("global", None, input.kind, input.id);
            if matches!(artifact.stage.as_str(), Some("trial" | "active"))
                && (sources.is_empty()
                    || sources.iter().any(|source| {
                        source.managed_scope_id.as_ref().map(|id| id.as_lossless())
                            != Some(&artifact.scope_id)
                            || source
                                .managed_version_id
                                .as_ref()
                                .map(|id| id.as_lossless())
                                != Some(&version.id)
                            || source.managed_digest.as_ref().map(|id| id.as_lossless())
                                != Some(&version.content_digest)
                    }))
            {
                return Err(error(if sources.is_empty() {
                    "OwnershipMismatch"
                } else {
                    "DestinationExists"
                }));
            }
            if matches!(artifact.stage.as_str(), Some("disabled" | "degraded"))
                && !sources.is_empty()
            {
                return Err(error("DestinationExists"));
            }
        }
        let fingerprint = package::sha256(&crate::resources::discovery::join(
            &[
                artifact.scope_id.clone(),
                artifact.kind.clone(),
                artifact.artifact_id.clone(),
                "remove".into(),
                artifact.revision.to_string().as_str().into(),
                version.id.clone(),
                version.content_digest.clone(),
            ],
            "\0",
        ));
        let operation_id = format!(
            "pop_{}",
            &fingerprint.as_lossless().as_str().expect("digest")[..32]
        );
        let deletion_id = project_artifact::DeletionId::decode(&JsonValue::String(
            format!(
                "pad_{}",
                &package::sha256(&operation_id.as_str().into())
                    .as_lossless()
                    .as_str()
                    .expect("digest")[..32]
            )
            .as_str()
            .into(),
        ))
        .expect("deletion");
        let operation = deletion_operation(
            &artifact,
            &version,
            &deletion_id,
            "remove",
            &fingerprint,
            input.now,
        );
        let reserved = self.reserve_deletion(operation)?;
        let root = scope_root(&self.paths.data, scope_ids(&scope).1);
        let marker = sql::marker_value(&scope_row, &version)?;
        let standard = self.trash_standard_paths(&scope, &marker);
        if reserved.phase.as_str() != Some("finalized") {
            if reserved.phase.as_str() == Some("preparing") {
                let stage = project_artifact::Stage::decode(&artifact.stage.encode())
                    .map_err(|_| error("ReconciliationRequired"))?;
                let trash_input = package::TrashInput {
                    root: &root,
                    marker: &marker,
                    deletion_id: &deletion_id,
                    prior_stage: Some(&stage),
                    deleted_at: Some(reserved.time_created as u64),
                    now: Some(input.now as u64),
                    standard: standard.as_ref().map(|(content_path, marker_path)| {
                        package::StandardTarget {
                            content_path,
                            marker_path,
                        }
                    }),
                };
                if root
                    .join("trash")
                    .join(deletion_id.as_lossless().as_str().expect("deletion"))
                    .exists()
                {
                    if package::validate_trash(trash_input, &Hooks::default())?.phase
                        != package::TrashPhase::Trashed
                    {
                        return Err(error("ReconciliationRequired"));
                    }
                } else {
                    package::trash(trash_input, &Hooks::default())?;
                }
                self.mark_deletion_available(&reserved, input.now)?;
            }
            let row = artifacts::Trash {
                deletion_id: deletion_id.as_lossless().clone(),
                scope_id: artifact.scope_id,
                kind: artifact.kind,
                artifact_id: artifact.artifact_id,
                prior_stage: artifact.stage,
                prior_version_id: version.id.clone(),
                deleted_at: reserved.time_created,
                purge_after: reserved.time_created + 30 * 86_400_000,
            };
            let operation = reserved.clone();
            self.client
                .submit(move |tx| {
                    if tx
                        .get::<artifacts::TrashTable>(&key(&row.deletion_id))?
                        .is_none()
                    {
                        artifacts::TrashTable::insert(tx, &row)?;
                    }
                    recovery::record_feedback(tx, &version, "delete", operation.time_created)?;
                    recovery::finalize_operation(tx, &operation, None, input.now)
                })?
                .wait()?;
        }
        let row = self
            .client
            .snapshot()?
            .get::<artifacts::TrashTable>(&key(deletion_id.as_lossless()))?
            .ok_or_else(|| error("ReconciliationRequired"))?;
        trash_value(scope, &row)
    }
    pub fn restore(&self, deletion: &project_artifact::DeletionId, now: i64) -> Result<(), Error> {
        let snapshot = self.client.snapshot()?;
        let trash = snapshot.get::<artifacts::TrashTable>(&key(deletion.as_lossless()))?;
        let completed = scan_all::<artifacts::OperationTable>(&snapshot)?
            .into_iter()
            .find(|operation| {
                operation.operation.as_str() == Some("restore")
                    && operation.deletion_id.as_ref() == Some(deletion.as_lossless())
                    && operation.phase.as_str() == Some("finalized")
            });
        let scope_id = trash
            .as_ref()
            .map(|trash| &trash.scope_id)
            .or_else(|| completed.as_ref().map(|operation| &operation.scope_id))
            .ok_or_else(|| error("DeletionNotFound"))?;
        let scope_id = project_artifact::ScopeId::decode(&scope_id.encode())
            .map_err(|_| error("OwnershipMismatch"))?;
        let scope = self.scope_from_snapshot(&snapshot, &scope_id)?;
        if !matches!(scope, project_artifact::Scope::Project(_)) {
            return Err(error("InvalidScope"));
        }
        let _scope = package::package_lock(
            &self.paths.data,
            &format!(
                "project-artifact-scope:{}",
                scope_id.as_lossless().as_str().expect("scope")
            ),
        )?;
        self.restore_locked(deletion, now)
    }
    pub(super) fn restore_locked(
        &self,
        deletion: &project_artifact::DeletionId,
        now: i64,
    ) -> Result<(), Error> {
        let snapshot = self.client.snapshot()?;
        let Some(trash) = snapshot.get::<artifacts::TrashTable>(&key(deletion.as_lossless()))?
        else {
            if scan_all::<artifacts::OperationTable>(&snapshot)?
                .iter()
                .any(|operation| {
                    operation.operation.as_str() == Some("restore")
                        && operation.deletion_id.as_ref() == Some(deletion.as_lossless())
                        && operation.phase.as_str() == Some("finalized")
                })
            {
                return Ok(());
            }
            return Err(error("DeletionNotFound"));
        };
        if now >= trash.purge_after {
            return Err(error("TrashExpired"));
        }
        let scope_id = project_artifact::ScopeId::decode(&trash.scope_id.encode())
            .map_err(|_| error("OwnershipMismatch"))?;
        let scope = self.scope_from_snapshot(&snapshot, &scope_id)?;
        let scope_row = snapshot
            .get::<artifacts::ScopeTable>(&key(&trash.scope_id))?
            .ok_or_else(|| error("OwnershipMismatch"))?;
        let version = snapshot
            .get::<artifacts::VersionTable>(&key(&trash.prior_version_id))?
            .ok_or_else(|| error("OwnershipMismatch"))?;
        let artifact = snapshot
            .get::<artifacts::ArtifactTable>(&artifacts::identity(
                &trash.scope_id,
                &trash.kind,
                &trash.artifact_id,
            ))?
            .ok_or_else(|| error("VersionConflict"))?;
        if artifact.current_version_id != version.id {
            return Err(error("VersionConflict"));
        }
        let marker = sql::marker_value(&scope_row, &version)?;
        let standard = self.trash_standard_paths(&scope, &marker);
        if matches!(scope, project_artifact::Scope::Global(_))
            && !self
                .sources
                .lock()
                .map_err(|_| error("StorageUnavailable"))?
                .resolve("global", None, &marker.kind, &marker.id)
                .is_empty()
        {
            return Err(error("DestinationExists"));
        }
        let root = scope_root(&self.paths.data, scope_ids(&scope).1);
        let fingerprint = package::sha256(&crate::resources::discovery::join(
            &[
                trash.scope_id.clone(),
                trash.kind.clone(),
                trash.artifact_id.clone(),
                "restore".into(),
                trash.deletion_id.clone(),
                artifact.revision.to_string().as_str().into(),
                version.id.clone(),
                version.content_digest.clone(),
                trash.deleted_at.to_string().as_str().into(),
            ],
            "\0",
        ));
        let operation = self.reserve_deletion(deletion_operation(
            &artifact,
            &version,
            deletion,
            "restore",
            &fingerprint,
            now,
        ))?;
        if operation.phase.as_str() != Some("finalized") {
            if operation.phase.as_str() == Some("preparing") {
                package::restore(
                    package::TrashInput {
                        root: &root,
                        marker: &marker,
                        deletion_id: deletion,
                        prior_stage: None,
                        deleted_at: None,
                        now: Some(now as u64),
                        standard: standard.as_ref().map(|(content_path, marker_path)| {
                            package::StandardTarget {
                                content_path,
                                marker_path,
                            }
                        }),
                    },
                    &Hooks::default(),
                )?;
                self.mark_deletion_available(&operation, now)?;
            }
            self.client
                .submit(move |tx| {
                    tx.delete::<artifacts::TrashTable>(&key(&trash.deletion_id))?;
                    recovery::record_feedback(tx, &version, "restore", operation.time_created)?;
                    recovery::finalize_operation(tx, &operation, Some(version.id), now)
                })?
                .wait()?;
        }
        Ok(())
    }
    pub fn get_trash(
        &self,
        deletion: &project_artifact::DeletionId,
    ) -> Result<TrashDetails, Error> {
        let snapshot = self.client.snapshot()?;
        let trash = snapshot
            .get::<artifacts::TrashTable>(&key(deletion.as_lossless()))?
            .ok_or_else(|| error("DeletionNotFound"))?;
        let scope = self.scope_from_snapshot(
            &snapshot,
            &project_artifact::ScopeId::decode(&trash.scope_id.encode())
                .map_err(|_| error("OwnershipMismatch"))?,
        )?;
        let root = scope_root(&self.paths.data, scope_ids(&scope).1);
        let scope_row = snapshot
            .get::<artifacts::ScopeTable>(&key(&trash.scope_id))?
            .ok_or_else(|| error("OwnershipMismatch"))?;
        let version = snapshot
            .get::<artifacts::VersionTable>(&key(&trash.prior_version_id))?
            .ok_or_else(|| error("VersionNotFound"))?;
        let marker = sql::marker_value(&scope_row, &version)?;
        let standard = self.trash_standard_paths(&scope, &marker);
        let manifest = package::validate_trash(
            package::TrashInput {
                root: &root,
                marker: &marker,
                deletion_id: deletion,
                prior_stage: Some(
                    &project_artifact::Stage::decode(&trash.prior_stage.encode())
                        .map_err(|_| error("OwnershipMismatch"))?,
                ),
                deleted_at: Some(trash.deleted_at as u64),
                now: None,
                standard: standard.as_ref().map(|(content_path, marker_path)| {
                    package::StandardTarget {
                        content_path,
                        marker_path,
                    }
                }),
            },
            &Hooks::default(),
        )?;
        if manifest.phase != package::TrashPhase::Trashed
            || manifest.scope_id.as_lossless() != &trash.scope_id
            || manifest.kind.as_lossless() != &trash.kind
            || manifest.id.as_lossless() != &trash.artifact_id
            || manifest.prior_stage.encode() != trash.prior_stage.encode()
        {
            return Err(error("OwnershipMismatch"));
        }
        let version = snapshot
            .get::<artifacts::VersionTable>(&key(&trash.prior_version_id))?
            .ok_or_else(|| error("VersionNotFound"))?;
        let entry = manifest
            .entries
            .iter()
            .find(|entry| {
                entry.version_id.as_lossless() == &version.id
                    && entry.content_digest.as_lossless() == &version.content_digest
                    && entry.content_relpath.as_lossless() == &version.content_relpath
            })
            .ok_or_else(|| error("OwnershipMismatch"))?;
        let JsonValue::String(layout) = entry.layout.encode() else {
            return Err(error("OwnershipMismatch"));
        };
        let path = root
            .join("trash")
            .join(deletion.as_lossless().as_str().expect("deletion"))
            .join("entries")
            .join(layout.as_str().expect("layout"))
            .join(entry.version_id.as_lossless().as_str().expect("version"))
            .join(entry.content_relpath.as_lossless().as_str().expect("path"));
        let content = crate::resources::project_artifact::filesystem::read_text(
            &root,
            &path,
            &Hooks::default(),
        )
        .map_err(|_| error("StorageUnavailable"))?;
        if package::sha256(&content.as_str().into()).as_lossless() != &version.content_digest {
            return Err(error("OwnershipMismatch"));
        }
        let kind = project_artifact::Kind::decode(&trash.kind.encode())
            .map_err(|_| error("OwnershipMismatch"))?;
        let id = project_artifact::Id::decode(&trash.artifact_id.encode())
            .map_err(|_| error("OwnershipMismatch"))?;
        let versions = super::version_rows(&snapshot, scope_ids(&scope).0, &kind, &id)?
            .iter()
            .map(sql::version_value)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(TrashDetails {
            trash: trash_value(scope, &trash)?,
            definition: adapter::parse(&kind, &content).map_err(|_| error("InvalidArtifact"))?,
            current_version: sql::version_value(&version)?,
            versions,
        })
    }
    pub fn purge(&self, now: i64) -> Result<usize, Error> {
        let mut expired = scan_all::<artifacts::TrashTable>(&self.client.snapshot()?)?
            .into_iter()
            .filter(|trash| trash.purge_after <= now)
            .collect::<Vec<_>>();
        expired.sort_by(|left, right| {
            left.purge_after
                .cmp(&right.purge_after)
                .then_with(|| left.deletion_id.cmp(&right.deletion_id))
        });
        expired.truncate(128);
        let count = expired.len();
        for trash in expired {
            if trash.prior_stage.as_str() == Some("quarantine") {
                return Err(error("UnsupportedKind"));
            }
            let scope_id = project_artifact::ScopeId::decode(&trash.scope_id.encode())
                .map_err(|_| error("OwnershipMismatch"))?;
            let _scope = package::package_lock(
                &self.paths.data,
                &format!(
                    "project-artifact-scope:{}",
                    scope_id.as_lossless().as_str().expect("scope")
                ),
            )?;
            let snapshot = self.client.snapshot()?;
            let scope = self.scope_from_snapshot(&snapshot, &scope_id)?;
            let scope_row = snapshot
                .get::<artifacts::ScopeTable>(&key(&trash.scope_id))?
                .ok_or_else(|| error("OwnershipMismatch"))?;
            let version = snapshot
                .get::<artifacts::VersionTable>(&key(&trash.prior_version_id))?
                .ok_or_else(|| error("OwnershipMismatch"))?;
            let artifact = snapshot
                .get::<artifacts::ArtifactTable>(&artifacts::identity(
                    &trash.scope_id,
                    &trash.kind,
                    &trash.artifact_id,
                ))?
                .ok_or_else(|| error("ArtifactNotFound"))?;
            let marker = sql::marker_value(&scope_row, &version)?;
            let standard = self.trash_standard_paths(&scope, &marker);
            let deletion = project_artifact::DeletionId::decode(&trash.deletion_id.encode())
                .map_err(|_| error("OwnershipMismatch"))?;
            let fingerprint = package::sha256(&crate::resources::discovery::join(
                &[
                    trash.scope_id.clone(),
                    trash.kind.clone(),
                    trash.artifact_id.clone(),
                    "purge".into(),
                    trash.deletion_id.clone(),
                    trash.prior_version_id.clone(),
                    trash.deleted_at.to_string().as_str().into(),
                    trash.purge_after.to_string().as_str().into(),
                ],
                "\0",
            ));
            let operation = self.reserve_deletion(deletion_operation(
                &artifact,
                &version,
                &deletion,
                "purge",
                &fingerprint,
                now,
            ))?;
            if operation.phase.as_str() == Some("preparing") {
                package::purge(
                    package::TrashInput {
                        root: &scope_root(&self.paths.data, scope_ids(&scope).1),
                        marker: &marker,
                        deletion_id: &deletion,
                        prior_stage: Some(
                            &project_artifact::Stage::decode(&trash.prior_stage.encode())
                                .map_err(|_| error("OwnershipMismatch"))?,
                        ),
                        deleted_at: Some(trash.deleted_at as u64),
                        now: Some(now as u64),
                        standard: standard.as_ref().map(|(content_path, marker_path)| {
                            package::StandardTarget {
                                content_path,
                                marker_path,
                            }
                        }),
                    },
                    &Hooks::default(),
                )?;
                self.mark_deletion_available(&operation, now)?;
            }
            self.client
                .submit(move |tx| recovery::purge_index(tx, &trash))?
                .wait()?;
        }
        Ok(count)
    }
    fn reserve_deletion(
        &self,
        operation: artifacts::Operation,
    ) -> Result<artifacts::Operation, Error> {
        self.client
            .submit(move |tx| {
                if let Some(mut existing) =
                    tx.get::<artifacts::OperationTable>(&key(&operation.id))?
                {
                    if existing.request_fingerprint != operation.request_fingerprint {
                        return Err(reject(tx, "VersionConflict"));
                    }
                    if existing.phase.as_str() == Some("aborted") {
                        existing.phase = "preparing".into();
                        existing.final_version_id = None;
                        existing.time_updated = operation.time_updated;
                        artifacts::OperationTable::put(tx, &existing)?;
                    }
                    return Ok(existing);
                }
                artifacts::OperationTable::insert(tx, &operation)?;
                Ok(operation)
            })?
            .wait()
            .map_err(Error::from)
    }
    fn trash_standard_paths(
        &self,
        scope: &project_artifact::Scope,
        marker: &package::Marker,
    ) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
        matches!(scope, project_artifact::Scope::Global(_)).then(|| {
            let content = adapter::global_path(
                &marker.kind,
                &self.paths.home,
                &self.paths.config,
                marker.id.as_lossless().as_str().expect("ID"),
            );
            let metadata = super::standard_marker_path(&content, &marker.kind, &marker.id);
            (content, metadata)
        })
    }
    fn mark_deletion_available(
        &self,
        operation: &artifacts::Operation,
        now: i64,
    ) -> Result<(), Error> {
        let operation = operation.clone();
        self.client
            .submit(move |tx| {
                let mut operation = operation;
                operation.phase = "available".into();
                operation.time_updated = now;
                artifacts::OperationTable::put(tx, &operation)
            })?
            .wait()?;
        Ok(())
    }
}
fn deletion_operation(
    artifact: &artifacts::Artifact,
    version: &artifacts::Version,
    deletion: &project_artifact::DeletionId,
    operation: &str,
    fingerprint: &project_artifact::Digest,
    now: i64,
) -> artifacts::Operation {
    artifacts::Operation {
        id: format!(
            "pop_{}",
            &fingerprint.as_lossless().as_str().expect("digest")[..32]
        )
        .as_str()
        .into(),
        scope_id: artifact.scope_id.clone(),
        kind: artifact.kind.clone(),
        artifact_id: artifact.artifact_id.clone(),
        operation: operation.into(),
        request_fingerprint: fingerprint.as_lossless().clone(),
        expected_revision: Some(artifact.revision),
        expected_version_id: Some(version.id.clone()),
        expected_digest: Some(version.content_digest.clone()),
        source_scope_id: None,
        source_version_id: None,
        source_digest: None,
        target_version_id: (operation == "restore").then(|| version.id.clone()),
        target_digest: (operation == "restore").then(|| version.content_digest.clone()),
        final_version_id: None,
        deletion_id: Some(deletion.as_lossless().clone()),
        automatic_session_id: None,
        automatic_insight_digest: None,
        phase: "preparing".into(),
        time_created: now,
        time_updated: now,
    }
}
fn trash_value(
    scope: project_artifact::Scope,
    trash: &artifacts::Trash,
) -> Result<project_artifact::Trash, Error> {
    project_artifact::Trash::decode(
        &ycoding_schema::ObjectEncoder::new()
            .field("scope", &scope)
            .field("deletionID", &trash.deletion_id)
            .field("kind", &trash.kind)
            .field("id", &trash.artifact_id)
            .field("priorStage", &trash.prior_stage)
            .field("priorVersionID", &trash.prior_version_id)
            .field("deletedAt", &(trash.deleted_at as f64))
            .field("purgeAfter", &(trash.purge_after as f64))
            .finish(),
    )
    .map_err(|_| error("ReconciliationRequired"))
}
