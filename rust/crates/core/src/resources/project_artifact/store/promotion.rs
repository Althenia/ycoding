use super::{
    Confirmation, Error, LifecycleInput, Service, WriteResult, adapter, automatic::WriteContext,
    error, key, package, scope_root,
};
use crate::resources::project_artifact::accounting;
use ycoding_schema::{DomainDecode, JsonValue, project_artifact};
use ycoding_store::artifacts;

#[derive(Clone)]
pub(super) struct PromotionToken {
    input: project_artifact::MutationExpectation,
    source: project_artifact::ProjectScope,
    kind: project_artifact::Kind,
    id: project_artifact::Id,
    expires_at: i64,
}
impl Service {
    pub fn preview_promotion(
        &self,
        input: LifecycleInput<'_>,
    ) -> Result<project_artifact::PromotionPreview, Error> {
        let snapshot = self.client.snapshot()?;
        let scope = self.scope_from_snapshot(&snapshot, input.scope_id)?;
        let project_artifact::Scope::Project(source) = scope else {
            return Err(error("InvalidScope"));
        };
        let details = self.get(input.scope_id, input.kind, input.id)?;
        if details.artifact.revision != input.expected.expected_revision
            || details.current_version.id != input.expected.expected_version_id
            || details.current_version.content_digest != input.expected.expected_digest
        {
            return Err(error("VersionConflict"));
        }
        let sources = self
            .sources
            .lock()
            .map_err(|_| error("StorageUnavailable"))?;
        if input.kind.as_lossless().as_str() == Some("plugin") {
            return Err(error("UnsupportedKind"));
        }
        if !sources
            .resolve("project", Some(&source.project_id), input.kind, input.id)
            .is_empty()
        {
            return Err(error("ArtifactCollision"));
        }
        if !sources
            .resolve("global", None, input.kind, input.id)
            .is_empty()
        {
            return Err(error("DestinationExists"));
        }
        drop(sources);
        let destination = self.resolve_global_scope()?;
        if snapshot
            .get::<artifacts::ArtifactTable>(&artifacts::identity(
                destination.id.as_lossless(),
                input.kind.as_lossless(),
                input.id.as_lossless(),
            ))?
            .is_some()
        {
            return Err(error("DestinationExists"));
        }
        let content = super::super::filesystem::read_text(
            &scope_root(&self.paths.data, &source.storage_id),
            &package::active_content_path(
                &scope_root(&self.paths.data, &source.storage_id),
                input.kind,
                input.id,
            ),
            &Default::default(),
        )
        .map_err(|_| error("StorageUnavailable"))?;
        let definition =
            adapter::parse(input.kind, &content).map_err(|_| error("InvalidArtifact"))?;
        let (name, description) = match &definition {
            project_artifact::Definition::Skill(value) => (&value.name, &value.description),
            project_artifact::Definition::Command(value) => (&value.name, &value.description),
            project_artifact::Definition::Agent(value) => (&value.name, &value.description),
            project_artifact::Definition::Plugin(value) => (&value.name, &value.description),
        };
        let mut metrics =
            accounting::Service::read_metrics(&self.client, &details.current_version.id)
                .map_err(|_| error("ReconciliationRequired"))?;
        metrics.last_used_at = details.artifact.last_used_at;
        let expires_at = input
            .now
            .checked_add(300_000)
            .ok_or_else(|| error("InvalidArtifact"))?;
        let token = project_artifact::ConfirmationToken::decode(&JsonValue::String(
            package::uuid()?.as_str().into(),
        ))
        .expect("token");
        self.tokens
            .lock()
            .map_err(|_| error("StorageUnavailable"))?
            .insert(
                token.as_lossless().clone(),
                Confirmation::Promotion(PromotionToken {
                    input: input.expected.clone(),
                    source: source.clone(),
                    kind: input.kind.clone(),
                    id: input.id.clone(),
                    expires_at,
                }),
            );
        Ok(project_artifact::PromotionPreview {
            artifact: project_artifact::ArtifactSummary {
                scope: project_artifact::Scope::Project(source),
                kind: input.kind.clone(),
                id: input.id.clone(),
                name: name.clone(),
                description: description.clone(),
                stage: details.artifact.stage,
                revision: details.artifact.revision,
                current_version_id: details.current_version.id,
                current_digest: details.current_version.content_digest,
                last_used_at: details.artifact.last_used_at,
                time_updated: details.artifact.time_updated,
            },
            metrics,
            destination,
            risk: project_artifact::Risk::decode(&JsonValue::String("declarative".into()))
                .expect("risk"),
            rendered_content: project_artifact::RenderedContent::decode(&JsonValue::String(
                content.as_str().into(),
            ))
            .map_err(|_| error("InvalidArtifact"))?,
            collision: None,
            token,
            expires_at: project_artifact::TimestampMillis::decode(&JsonValue::Number(
                expires_at as f64,
            ))
            .map_err(|_| error("InvalidArtifact"))?,
        })
    }
    pub fn confirm_promotion(
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
        let Confirmation::Promotion(preview) = preview else {
            return Err(error("ConfirmationExpired"));
        };
        if now >= preview.expires_at {
            return Err(error("ConfirmationExpired"));
        }
        let destination = self.resolve_global_scope()?;
        let mut scopes = [preview.source.id.clone(), destination.id.clone()];
        scopes.sort_by(|left, right| left.as_lossless().cmp(right.as_lossless()));
        let _first = package::package_lock(
            &self.paths.data,
            &format!(
                "project-artifact-scope:{}",
                scopes[0].as_lossless().as_str().expect("scope")
            ),
        )?;
        let _second = package::package_lock(
            &self.paths.data,
            &format!(
                "project-artifact-scope:{}",
                scopes[1].as_lossless().as_str().expect("scope")
            ),
        )?;
        let snapshot = self.client.snapshot()?;
        let artifact = snapshot
            .get::<artifacts::ArtifactTable>(&artifacts::identity(
                preview.source.id.as_lossless(),
                preview.kind.as_lossless(),
                preview.id.as_lossless(),
            ))?
            .ok_or_else(|| error("VersionConflict"))?;
        let version = snapshot
            .get::<artifacts::VersionTable>(&key(&artifact.current_version_id))?
            .ok_or_else(|| error("VersionConflict"))?;
        super::check_expectation(Some(&artifact), Some(&version), Some(&preview.input))?;
        let sources = self
            .sources
            .lock()
            .map_err(|_| error("StorageUnavailable"))?;
        if !sources
            .resolve(
                "project",
                Some(&preview.source.project_id),
                &preview.kind,
                &preview.id,
            )
            .is_empty()
        {
            return Err(error("ArtifactCollision"));
        }
        if !sources
            .resolve("global", None, &preview.kind, &preview.id)
            .is_empty()
        {
            return Err(error("DestinationExists"));
        }
        drop(sources);
        if snapshot
            .get::<artifacts::ArtifactTable>(&artifacts::identity(
                destination.id.as_lossless(),
                preview.kind.as_lossless(),
                preview.id.as_lossless(),
            ))?
            .is_some()
        {
            return Err(error("DestinationExists"));
        }
        let root = scope_root(&self.paths.data, &preview.source.storage_id);
        let content = super::super::filesystem::read_text(
            &root,
            &package::active_content_path(&root, &preview.kind, &preview.id),
            &Default::default(),
        )
        .map_err(|_| error("StorageUnavailable"))?;
        if package::sha256(&content.as_str().into()).as_lossless() != &version.content_digest {
            return Err(error("OwnershipMismatch"));
        }
        let definition =
            adapter::parse(&preview.kind, &content).map_err(|_| error("InvalidArtifact"))?;
        drop(snapshot);
        self.write_snapshot(
            &project_artifact::Scope::Global(destination),
            &preview.id,
            &definition,
            None,
            WriteContext {
                now,
                global: true,
                automatic: None,
                snapshot: Some(super::SnapshotCommit {
                    source: artifact,
                    version,
                    content: content.as_str().into(),
                    operation: super::SnapshotOperation::Promotion,
                }),
            },
        )
    }
}
