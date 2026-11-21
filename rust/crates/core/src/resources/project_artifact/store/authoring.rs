use super::{
    Confirmation, ConfirmationPreview, Error, Service, SnapshotCommit, SnapshotOperation,
    WriteContext, WriteResult, adapter, error, key, package, reject, scope_ids,
};
use std::fs;
use ycoding_schema::{DomainDecode, JsonValue, LosslessString, project, project_artifact};
use ycoding_store::artifacts;

#[derive(Clone, Copy)]
pub struct ForkPreviewInput<'a> {
    pub project_id: &'a project::Id,
    pub kind: &'a project_artifact::Kind,
    pub id: &'a project_artifact::Id,
    pub expected_revision: Option<project_artifact::Revision>,
    pub expected_version_id: &'a project_artifact::VersionId,
    pub expected_digest: &'a project_artifact::Digest,
    pub now: i64,
}
#[derive(Clone, Copy)]
pub struct ShadowInput<'a> {
    pub project_id: &'a project::Id,
    pub kind: &'a project_artifact::Kind,
    pub id: &'a project_artifact::Id,
    pub expected: &'a project_artifact::MutationExpectation,
    pub global_scope_id: &'a project_artifact::ScopeId,
    pub global_expected: &'a project_artifact::MutationExpectation,
    pub now: i64,
}
#[derive(Clone)]
struct CapturedVersion {
    scope: project_artifact::Scope,
    artifact: artifacts::Artifact,
    version: artifacts::Version,
    content: LosslessString,
}
#[derive(Clone)]
pub(super) struct ForkToken {
    source: CapturedVersion,
    destination: project_artifact::ProjectScope,
    expires_at: i64,
}
#[derive(Clone)]
pub(super) struct ShadowToken {
    project: CapturedVersion,
    global: CapturedVersion,
    expires_at: i64,
}
impl Service {
    pub fn preview_fork(&self, input: ForkPreviewInput<'_>) -> Result<ConfirmationPreview, Error> {
        let source = self.resolve_global_scope()?;
        let destination = self.resolve_project_scope(input.project_id)?;
        let captured = self.capture_version(
            project_artifact::Scope::Global(source),
            input.kind,
            input.id,
        )?;
        if input
            .expected_revision
            .is_some_and(|revision| revision.get() != captured.artifact.revision)
            || input.expected_version_id.as_lossless() != &captured.version.id
            || input.expected_digest.as_lossless() != &captured.version.content_digest
        {
            return Err(error("VersionConflict"));
        }
        self.check_authoring_sources(&captured, &destination, input.kind, input.id)?;
        if self
            .client
            .snapshot()?
            .get::<artifacts::ArtifactTable>(&artifacts::identity(
                destination.id.as_lossless(),
                input.kind.as_lossless(),
                input.id.as_lossless(),
            ))?
            .is_some()
        {
            return Err(error("ArtifactCollision"));
        }
        let expires_at = input
            .now
            .checked_add(300_000)
            .ok_or_else(|| error("InvalidArtifact"))?;
        self.authoring_preview(
            Confirmation::Fork(Box::new(ForkToken {
                source: captured,
                destination,
                expires_at,
            })),
            expires_at,
        )
    }
    pub fn confirm_fork(
        &self,
        token: &project_artifact::ConfirmationToken,
        now: i64,
    ) -> Result<WriteResult, Error> {
        let preview = self
            .tokens
            .lock()
            .map_err(|_| error("StorageUnavailable"))?
            .remove(token.as_lossless())
            .ok_or_else(|| error("ConfirmationExpired"))?;
        let Confirmation::Fork(preview) = preview else {
            return Err(error("ConfirmationExpired"));
        };
        if now >= preview.expires_at {
            return Err(error("ConfirmationExpired"));
        }
        let _locks =
            self.authoring_locks(scope_ids(&preview.source.scope).0, &preview.destination.id)?;
        let kind = project_artifact::Kind::decode(&JsonValue::String(
            preview.source.artifact.kind.clone(),
        ))
        .map_err(|_| error("InvalidArtifact"))?;
        let id = project_artifact::Id::decode(&JsonValue::String(
            preview.source.artifact.artifact_id.clone(),
        ))
        .map_err(|_| error("InvalidArtifact"))?;
        let source = self.capture_version(preview.source.scope.clone(), &kind, &id)?;
        if !same_identity(&source, &preview.source)
            || source.content != preview.source.content
            || self
                .client
                .snapshot()?
                .get::<artifacts::ArtifactTable>(&artifacts::identity(
                    preview.destination.id.as_lossless(),
                    kind.as_lossless(),
                    id.as_lossless(),
                ))?
                .is_some()
        {
            return Err(error("VersionConflict"));
        }
        self.check_authoring_sources(&source, &preview.destination, &kind, &id)?;
        let definition = adapter::parse(
            &kind,
            source
                .content
                .as_str()
                .ok_or_else(|| error("InvalidArtifact"))?,
        )
        .map_err(|_| error("InvalidArtifact"))?;
        self.write_snapshot(
            &project_artifact::Scope::Project(preview.destination),
            &id,
            &definition,
            None,
            WriteContext {
                now,
                global: false,
                automatic: None,
                snapshot: Some(SnapshotCommit {
                    source: source.artifact,
                    version: source.version,
                    content: source.content,
                    operation: SnapshotOperation::Fork,
                }),
            },
        )
    }
    pub fn preview_shadow(&self, input: ShadowInput<'_>) -> Result<ConfirmationPreview, Error> {
        let project = self.resolve_project_scope(input.project_id)?;
        let global = self.scope_from_snapshot(&self.client.snapshot()?, input.global_scope_id)?;
        if !matches!(global, project_artifact::Scope::Global(_)) {
            return Err(error("InvalidScope"));
        }
        let project_value = self.capture_version(
            project_artifact::Scope::Project(project.clone()),
            input.kind,
            input.id,
        )?;
        let global_value = self.capture_version(global, input.kind, input.id)?;
        super::check_expectation(
            Some(&project_value.artifact),
            Some(&project_value.version),
            Some(input.expected),
        )?;
        super::check_expectation(
            Some(&global_value.artifact),
            Some(&global_value.version),
            Some(input.global_expected),
        )?;
        self.check_authoring_sources(&global_value, &project, input.kind, input.id)?;
        let expires_at = input
            .now
            .checked_add(300_000)
            .ok_or_else(|| error("InvalidArtifact"))?;
        self.authoring_preview(
            Confirmation::Shadow(Box::new(ShadowToken {
                project: project_value,
                global: global_value,
                expires_at,
            })),
            expires_at,
        )
    }
    pub fn confirm_shadow(
        &self,
        token: &project_artifact::ConfirmationToken,
        now: i64,
    ) -> Result<(), Error> {
        let preview = self
            .tokens
            .lock()
            .map_err(|_| error("StorageUnavailable"))?
            .remove(token.as_lossless())
            .ok_or_else(|| error("ConfirmationExpired"))?;
        let Confirmation::Shadow(preview) = preview else {
            return Err(error("ConfirmationExpired"));
        };
        if now >= preview.expires_at {
            return Err(error("ConfirmationExpired"));
        }
        let _locks = self.authoring_locks(
            scope_ids(&preview.project.scope).0,
            scope_ids(&preview.global.scope).0,
        )?;
        let kind = project_artifact::Kind::decode(&JsonValue::String(
            preview.project.artifact.kind.clone(),
        ))
        .map_err(|_| error("InvalidArtifact"))?;
        let id = project_artifact::Id::decode(&JsonValue::String(
            preview.project.artifact.artifact_id.clone(),
        ))
        .map_err(|_| error("InvalidArtifact"))?;
        let project = self.capture_version(preview.project.scope.clone(), &kind, &id)?;
        let global = self.capture_version(preview.global.scope.clone(), &kind, &id)?;
        if !same_identity(&project, &preview.project) || !same_identity(&global, &preview.global) {
            return Err(error("VersionConflict"));
        }
        let project_artifact::Scope::Project(project_scope) = &project.scope else {
            return Err(error("InvalidScope"));
        };
        self.check_authoring_sources(&global, project_scope, &kind, &id)?;
        let fingerprint = package::sha256(&crate::resources::discovery::join(
            &[
                project.artifact.scope_id.clone(),
                project.artifact.kind.clone(),
                project.artifact.artifact_id.clone(),
                "shadow".into(),
                project.artifact.revision.to_string().as_str().into(),
                project.version.id.clone(),
                project.version.content_digest.clone(),
                global.artifact.scope_id.clone(),
                global.version.id.clone(),
                global.version.content_digest.clone(),
            ],
            "\0",
        ));
        let operation = artifacts::Operation {
            id: format!(
                "pop_{}",
                &fingerprint.as_lossless().as_str().expect("digest")[..32]
            )
            .as_str()
            .into(),
            scope_id: project.artifact.scope_id.clone(),
            kind: project.artifact.kind.clone(),
            artifact_id: project.artifact.artifact_id.clone(),
            operation: "shadow".into(),
            request_fingerprint: fingerprint.as_lossless().clone(),
            expected_revision: Some(project.artifact.revision),
            expected_version_id: Some(project.version.id.clone()),
            expected_digest: Some(project.version.content_digest.clone()),
            source_scope_id: Some(global.artifact.scope_id.clone()),
            source_version_id: Some(global.version.id.clone()),
            source_digest: Some(global.version.content_digest.clone()),
            target_version_id: Some(project.version.id.clone()),
            target_digest: Some(project.version.content_digest.clone()),
            final_version_id: None,
            deletion_id: None,
            automatic_session_id: None,
            automatic_insight_digest: None,
            phase: "available".into(),
            time_created: now,
            time_updated: now,
        };
        self.client
            .submit(move |tx| {
                if let Some(existing) = tx.get::<artifacts::OperationTable>(&key(&operation.id))? {
                    if existing.request_fingerprint != operation.request_fingerprint {
                        return Err(reject(tx, "VersionConflict"));
                    }
                    if existing.phase.as_str() == Some("finalized") {
                        return Ok(());
                    }
                } else {
                    artifacts::OperationTable::insert(tx, &operation)?;
                }
                finalize_shadow(tx, &operation, now)
            })?
            .wait()
            .map_err(|cause| match cause {
                ycoding_store::Error::Domain {
                    kind: "artifact_store" | "version_conflict",
                    ..
                } => Error::from(cause),
                _ => error("ReconciliationRequired"),
            })?;
        Ok(())
    }
    fn capture_version(
        &self,
        scope: project_artifact::Scope,
        kind: &project_artifact::Kind,
        id: &project_artifact::Id,
    ) -> Result<CapturedVersion, Error> {
        let snapshot = self.client.snapshot()?;
        let artifact = snapshot
            .get::<artifacts::ArtifactTable>(&artifacts::identity(
                scope_ids(&scope).0.as_lossless(),
                kind.as_lossless(),
                id.as_lossless(),
            ))?
            .ok_or_else(|| error("VersionConflict"))?;
        let version = snapshot
            .get::<artifacts::VersionTable>(&key(&artifact.current_version_id))?
            .ok_or_else(|| error("VersionConflict"))?;
        let content = self
            .read_content(&scope, &artifact, &version)
            .map_err(|_| error("OwnershipMismatch"))?;
        let content: LosslessString = content.as_str().into();
        if package::sha256(&content).as_lossless() != &version.content_digest {
            return Err(error("OwnershipMismatch"));
        }
        Ok(CapturedVersion {
            scope,
            artifact,
            version,
            content,
        })
    }
    fn check_authoring_sources(
        &self,
        global: &CapturedVersion,
        project: &project_artifact::ProjectScope,
        kind: &project_artifact::Kind,
        id: &project_artifact::Id,
    ) -> Result<(), Error> {
        let sources = self
            .sources
            .lock()
            .map_err(|_| error("StorageUnavailable"))?;
        let global_sources = sources.resolve("global", None, kind, id);
        if !sources
            .resolve("project", Some(&project.project_id), kind, id)
            .is_empty()
            || global_sources.is_empty()
            || global_sources.iter().any(|source| {
                source.managed_scope_id.as_ref().map(|id| id.as_lossless())
                    != Some(&global.artifact.scope_id)
                    || source
                        .managed_version_id
                        .as_ref()
                        .map(|id| id.as_lossless())
                        != Some(&global.version.id)
                    || source.managed_digest.as_ref().map(|id| id.as_lossless())
                        != Some(&global.version.content_digest)
            })
        {
            return Err(error("ArtifactCollision"));
        }
        Ok(())
    }
    fn authoring_preview(
        &self,
        confirmation: Confirmation,
        expires_at: i64,
    ) -> Result<ConfirmationPreview, Error> {
        let token = project_artifact::ConfirmationToken::decode(&JsonValue::String(
            package::uuid()?.as_str().into(),
        ))
        .map_err(|_| error("StorageUnavailable"))?;
        self.tokens
            .lock()
            .map_err(|_| error("StorageUnavailable"))?
            .insert(token.as_lossless().clone(), confirmation);
        Ok(ConfirmationPreview { token, expires_at })
    }
    fn authoring_locks(
        &self,
        first: &project_artifact::ScopeId,
        second: &project_artifact::ScopeId,
    ) -> Result<[fs::File; 2], Error> {
        let mut scopes = [first, second];
        scopes.sort_by(|left, right| left.as_lossless().cmp(right.as_lossless()));
        Ok([
            package::package_lock(
                &self.paths.data,
                &format!(
                    "project-artifact-scope:{}",
                    scopes[0].as_lossless().as_str().expect("scope")
                ),
            )?,
            package::package_lock(
                &self.paths.data,
                &format!(
                    "project-artifact-scope:{}",
                    scopes[1].as_lossless().as_str().expect("scope")
                ),
            )?,
        ])
    }
}
fn same_identity(left: &CapturedVersion, right: &CapturedVersion) -> bool {
    left.artifact.revision == right.artifact.revision
        && left.version.id == right.version.id
        && left.version.content_digest == right.version.content_digest
}
fn finalize_shadow(
    tx: &mut ycoding_store::Write<'_>,
    operation: &artifacts::Operation,
    now: i64,
) -> Result<(), ycoding_store::Error> {
    let mut project = tx
        .get::<artifacts::ArtifactTable>(&artifacts::identity(
            &operation.scope_id,
            &operation.kind,
            &operation.artifact_id,
        ))?
        .ok_or_else(|| reject(tx, "VersionConflict"))?;
    let mut version = tx
        .get::<artifacts::VersionTable>(&key(&project.current_version_id))?
        .ok_or_else(|| reject(tx, "VersionConflict"))?;
    let source_scope = operation
        .source_scope_id
        .as_ref()
        .ok_or_else(|| reject(tx, "ReconciliationRequired"))?;
    let global = tx
        .get::<artifacts::ArtifactTable>(&artifacts::identity(
            source_scope,
            &operation.kind,
            &operation.artifact_id,
        ))?
        .ok_or_else(|| reject(tx, "VersionConflict"))?;
    let source_version = tx
        .get::<artifacts::VersionTable>(&key(&global.current_version_id))?
        .ok_or_else(|| reject(tx, "VersionConflict"))?;
    if Some(project.revision) != operation.expected_revision
        || Some(&version.id) != operation.expected_version_id.as_ref()
        || Some(&version.content_digest) != operation.expected_digest.as_ref()
        || Some(&source_version.id) != operation.source_version_id.as_ref()
        || Some(&source_version.content_digest) != operation.source_digest.as_ref()
    {
        return Err(reject(tx, "VersionConflict"));
    }
    if project.shadowed_scope_id.as_ref() != Some(source_scope)
        || version.origin_scope_id != operation.source_scope_id
        || version.origin_version_id != operation.source_version_id
        || version.origin_evidence_digest != operation.source_digest
    {
        project.revision += 1;
        project.shadowed_scope_id = operation.source_scope_id.clone();
        project.time_updated = now;
        version.origin_scope_id = operation.source_scope_id.clone();
        version.origin_version_id = operation.source_version_id.clone();
        version.origin_evidence_digest = operation.source_digest.clone();
        artifacts::ArtifactTable::put(tx, &project)?;
        artifacts::VersionTable::put(tx, &version)?;
    }
    super::recovery::finalize_operation(tx, operation, Some(version.id), now)
}
