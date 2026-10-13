use super::{adapter, filesystem::Hooks, package, source_registry::Registry, sql, validation};
use std::{
    collections::BTreeMap,
    fmt, fs,
    ops::Bound,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder, project, project_artifact,
};
use ycoding_store::{
    Client, IndexOrder, IndexQuery, KeyPart, Snapshot, TableSpec, Write, artifacts, tuple_key,
};
mod authoring;
mod automatic;
mod governor;
mod lifecycle;
mod promotion;
mod recovery;
mod trash;
pub use authoring::{ForkPreviewInput, ShadowInput};
pub use automatic::AutomaticWriteInput;
use automatic::WriteContext;
pub use governor::GovernorInput;
pub use lifecycle::LifecycleInput;
pub use trash::TrashDetails;

#[derive(Clone, Debug)]
pub struct Error {
    pub code: project_artifact::ErrorCode,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Project Artifact operation failed")
    }
}
impl std::error::Error for Error {}
impl From<package::Failure> for Error {
    fn from(error: package::Failure) -> Self {
        Self { code: error.code }
    }
}
impl From<ycoding_store::Error> for Error {
    fn from(error: ycoding_store::Error) -> Self {
        match error {
            ycoding_store::Error::Domain {
                kind: "artifact_store",
                message,
            } => self::error(message),
            ycoding_store::Error::Domain {
                kind: "version_conflict",
                ..
            } => self::error("VersionConflict"),
            ycoding_store::Error::CommitUncertain(_)
            | ycoding_store::Error::RollbackFailed(_)
            | ycoding_store::Error::WriterFenced
            | ycoding_store::Error::WriterPanicked => self::error("ReconciliationRequired"),
            _ => self::error("StorageUnavailable"),
        }
    }
}
#[derive(Clone)]
pub struct Paths {
    pub data: PathBuf,
    pub home: PathBuf,
    pub config: PathBuf,
}
#[derive(Clone)]
pub struct Service {
    client: Client,
    paths: Paths,
    sources: Arc<Mutex<Registry>>,
    tokens: Arc<Mutex<BTreeMap<LosslessString, Confirmation>>>,
    accounting: Option<Arc<super::accounting::Service>>,
}
pub struct ManualWriteInput<'a> {
    pub scope: project_artifact::ScopeSelector,
    pub project_id: Option<project::Id>,
    pub id: &'a str,
    pub definition: &'a project_artifact::Definition,
    pub expected: Option<project_artifact::MutationExpectation>,
    pub now: i64,
}
pub struct ManualPreviewInput<'a> {
    pub id: &'a str,
    pub definition: &'a project_artifact::Definition,
    pub expected: Option<project_artifact::MutationExpectation>,
    pub now: i64,
}
pub struct ConfirmationPreview {
    pub token: project_artifact::ConfirmationToken,
    pub expires_at: i64,
}
#[derive(Clone)]
struct ManualToken {
    id: project_artifact::Id,
    definition: project_artifact::Definition,
    expected: Option<project_artifact::MutationExpectation>,
    expires_at: i64,
}
#[derive(Clone)]
enum Confirmation {
    Manual(ManualToken),
    Promotion(promotion::PromotionToken),
    Fork(Box<authoring::ForkToken>),
    Shadow(Box<authoring::ShadowToken>),
}
#[derive(Clone, Copy, PartialEq)]
enum SnapshotOperation {
    Promotion,
    Fork,
}
impl SnapshotOperation {
    fn text(self) -> &'static str {
        match self {
            Self::Promotion => "promotion",
            Self::Fork => "fork",
        }
    }
}
#[derive(Clone)]
struct SnapshotCommit {
    source: artifacts::Artifact,
    version: artifacts::Version,
    content: LosslessString,
    operation: SnapshotOperation,
}
#[derive(Debug)]
pub struct WriteResult {
    pub result: project_artifact::AutomaticWriteResult,
    pub scope_id: project_artifact::ScopeId,
    pub kind: project_artifact::Kind,
    pub id: project_artifact::Id,
    pub version_id: project_artifact::VersionId,
    pub content_digest: project_artifact::Digest,
    pub stage: project_artifact::Stage,
    pub remaining: Remaining,
}
#[derive(Debug)]
pub struct Remaining {
    pub session: f64,
    pub project_daily: f64,
    pub project_artifacts: f64,
    pub versions: f64,
    pub bytes: f64,
}
pub struct AdoptionResult {
    pub scope: project_artifact::ProjectScope,
    root: PathBuf,
}
impl AdoptionResult {
    pub fn post_commit(&self) -> Result<(), Error> {
        write_scope_marker(
            &self.root,
            &project_artifact::Scope::Project(self.scope.clone()),
            true,
        )
    }
}

impl Service {
    pub fn new(client: Client, paths: Paths, sources: Arc<Mutex<Registry>>) -> Self {
        Self {
            client,
            paths,
            sources,
            tokens: Arc::new(Mutex::new(BTreeMap::new())),
            accounting: None,
        }
    }
    pub fn with_accounting(mut self, accounting: super::accounting::Service) -> Self {
        self.accounting = Some(Arc::new(accounting));
        self
    }
    pub fn accounting(&self) -> Option<&super::accounting::Service> {
        self.accounting.as_deref()
    }
    pub fn resolve_project_scope(
        &self,
        project: &project::Id,
    ) -> Result<project_artifact::ProjectScope, Error> {
        if project.as_lossless().as_str() == Some("global") {
            return Err(error("ProjectIdentityUnavailable"));
        }
        let project = project.clone();
        let output = self
            .client
            .submit(move |tx| {
                if let Some(scope) = find_project_scope(tx, &project)? {
                    return Ok((scope, false));
                }
                let (id, storage_id) = new_scope_ids().map_err(storage_error)?;
                let scope = project_artifact::ProjectScope {
                    id,
                    storage_id,
                    project_id: project,
                };
                insert_scope(tx, &project_artifact::Scope::Project(scope.clone()))?;
                Ok((scope, true))
            })?
            .wait()?;
        let root = scope_root(&self.paths.data, &output.0.storage_id);
        write_scope_marker(
            &root,
            &project_artifact::Scope::Project(output.0.clone()),
            output.1,
        )?;
        Ok(output.0)
    }
    pub fn resolve_global_scope(&self) -> Result<project_artifact::GlobalScope, Error> {
        let (scope, created) = self
            .client
            .submit(|tx| {
                let rows = tx.index::<artifacts::GlobalScopeTable>(
                    "project_artifact_global_scope_singleton_idx",
                    &tuple_key(&[KeyPart::I64(1)]),
                    None,
                    1,
                )?;
                if let Some(member) = rows.first() {
                    let row = tx
                        .get::<artifacts::ScopeTable>(&key(&member.scope_id))?
                        .ok_or_else(|| reject(tx, "ReconciliationRequired"))?;
                    let project_artifact::Scope::Global(scope) =
                        sql::scope_value(&row, None).map_err(storage_error)?
                    else {
                        return Err(reject(tx, "ReconciliationRequired"));
                    };
                    return Ok((scope, false));
                }
                let (id, storage_id) = new_scope_ids().map_err(storage_error)?;
                let scope = project_artifact::GlobalScope { id, storage_id };
                insert_scope(tx, &project_artifact::Scope::Global(scope.clone()))?;
                Ok((scope, true))
            })?
            .wait()?;
        write_scope_marker(
            &scope_root(&self.paths.data, &scope.storage_id),
            &project_artifact::Scope::Global(scope.clone()),
            created,
        )?;
        Ok(scope)
    }
    pub async fn adopt_project_committed(
        &self,
        previous: &project::Id,
        project: &project::Id,
    ) -> Result<(), Error> {
        let service = self.clone();
        let previous = previous.clone();
        let project = project.clone();
        let adoption = self
            .client
            .submit(move |tx| service.adopt_project(tx, &previous, &project))?
            .await?;
        tokio::task::spawn_blocking(move || adoption.post_commit())
            .await
            .map_err(|_| error("StorageUnavailable"))?
    }
    pub fn adopt_project(
        &self,
        tx: &mut Write<'_>,
        previous: &project::Id,
        project: &project::Id,
    ) -> Result<AdoptionResult, ycoding_store::Error> {
        if previous.as_lossless().as_str() == Some("global")
            || project.as_lossless().as_str() == Some("global")
        {
            return Err(reject(tx, "ProjectIdentityUnavailable"));
        }
        let old = find_project_scope(tx, previous)?;
        let current = find_project_scope(tx, project)?;
        if old
            .as_ref()
            .zip(current.as_ref())
            .is_some_and(|(old, current)| old.id != current.id)
        {
            return Err(reject(tx, "ProjectAdoptionConflict"));
        }
        let scope = if let Some(current) = current {
            current
        } else if let Some(mut old) = old {
            old.project_id = project.clone();
            artifacts::ProjectScopeTable::put(
                tx,
                &artifacts::ProjectScope {
                    scope_id: old.id.as_lossless().clone(),
                    project_id: project.as_lossless().clone(),
                },
            )?;
            old
        } else {
            let (id, storage_id) = new_scope_ids().map_err(storage_error)?;
            let scope = project_artifact::ProjectScope {
                id,
                storage_id,
                project_id: project.clone(),
            };
            insert_scope(tx, &project_artifact::Scope::Project(scope.clone()))?;
            scope
        };
        Ok(AdoptionResult {
            root: scope_root(&self.paths.data, &scope.storage_id),
            scope,
        })
    }
    pub fn write_manual(&self, input: ManualWriteInput<'_>) -> Result<WriteResult, Error> {
        if input.scope != project_artifact::ScopeSelector::Project {
            return Err(error("InvalidScope"));
        }
        let project = input
            .project_id
            .ok_or_else(|| error("ProjectIdentityUnavailable"))?;
        let id = validate_definition(input.id, input.definition)?;
        let scope = project_artifact::Scope::Project(self.resolve_project_scope(&project)?);
        let _scope = package::package_lock(
            &self.paths.data,
            &format!(
                "project-artifact-scope:{}",
                scope_ids(&scope).0.as_lossless().as_str().expect("scope")
            ),
        )?;
        let kind = adapter::kind(input.definition);
        if !self
            .sources
            .lock()
            .map_err(|_| error("StorageUnavailable"))?
            .resolve("project", Some(&project), &kind, &id)
            .is_empty()
        {
            return Err(error("ArtifactCollision"));
        }
        self.write_snapshot(
            &scope,
            &id,
            input.definition,
            input.expected.as_ref(),
            WriteContext {
                now: input.now,
                global: false,
                automatic: None,
                snapshot: None,
            },
        )
    }
    pub fn preview_manual(
        &self,
        input: ManualPreviewInput<'_>,
    ) -> Result<ConfirmationPreview, Error> {
        let id = validate_definition(input.id, input.definition)?;
        let scope = project_artifact::Scope::Global(self.resolve_global_scope()?);
        let kind = adapter::kind(input.definition);
        let (scope_id, _) = scope_ids(&scope);
        let snapshot = self.client.snapshot()?;
        let artifact = snapshot.get::<artifacts::ArtifactTable>(&artifacts::identity(
            scope_id.as_lossless(),
            kind.as_lossless(),
            id.as_lossless(),
        ))?;
        let version = artifact
            .as_ref()
            .map(|artifact| {
                snapshot.get::<artifacts::VersionTable>(&key(&artifact.current_version_id))
            })
            .transpose()?
            .flatten();
        check_expectation(artifact.as_ref(), version.as_ref(), input.expected.as_ref())?;
        self.check_global_sources(&scope, &kind, &id, artifact.as_ref(), version.as_ref())?;
        if let (Some(artifact), Some(version)) = (&artifact, &version) {
            self.read_content(&scope, artifact, version)
                .map_err(|_| error("OwnershipMismatch"))?;
        }
        let token = project_artifact::ConfirmationToken::decode(&JsonValue::String(
            package::uuid()?.as_str().into(),
        ))
        .map_err(|_| error("StorageUnavailable"))?;
        let expires_at = input
            .now
            .checked_add(300_000)
            .ok_or_else(|| error("InvalidArtifact"))?;
        self.tokens
            .lock()
            .map_err(|_| error("StorageUnavailable"))?
            .insert(
                token.as_lossless().clone(),
                Confirmation::Manual(ManualToken {
                    id,
                    definition: input.definition.clone(),
                    expected: input.expected,
                    expires_at,
                }),
            );
        Ok(ConfirmationPreview { token, expires_at })
    }
    pub fn confirm_manual(
        &self,
        token: &project_artifact::ConfirmationToken,
        now: i64,
    ) -> Result<WriteResult, Error> {
        let confirmation = self
            .tokens
            .lock()
            .map_err(|_| error("StorageUnavailable"))?
            .remove(token.as_lossless())
            .ok_or_else(|| error("ConfirmationExpired"))?;
        let Confirmation::Manual(preview) = confirmation else {
            return Err(error("ConfirmationExpired"));
        };
        if now >= preview.expires_at {
            return Err(error("ConfirmationExpired"));
        }
        let scope = project_artifact::Scope::Global(self.resolve_global_scope()?);
        let _scope = package::package_lock(
            &self.paths.data,
            &format!(
                "project-artifact-scope:{}",
                scope_ids(&scope).0.as_lossless().as_str().expect("scope")
            ),
        )?;
        self.write_snapshot(
            &scope,
            &preview.id,
            &preview.definition,
            preview.expected.as_ref(),
            WriteContext {
                now,
                global: true,
                automatic: None,
                snapshot: None,
            },
        )
    }
    pub fn get(
        &self,
        scope_id: &project_artifact::ScopeId,
        kind: &project_artifact::Kind,
        id: &project_artifact::Id,
    ) -> Result<project_artifact::ArtifactDetails, Error> {
        let snapshot = self.client.snapshot()?;
        let artifact = snapshot
            .get::<artifacts::ArtifactTable>(&artifacts::identity(
                scope_id.as_lossless(),
                kind.as_lossless(),
                id.as_lossless(),
            ))?
            .ok_or_else(|| error("ArtifactNotFound"))?;
        let scope = self.scope_from_snapshot(&snapshot, scope_id)?;
        let current = snapshot
            .get::<artifacts::VersionTable>(&key(&artifact.current_version_id))?
            .ok_or_else(|| error("VersionNotFound"))?;
        let definition = adapter::parse(kind, &self.read_content(&scope, &artifact, &current)?)
            .map_err(|_| error("InvalidArtifact"))?;
        let versions = version_rows(&snapshot, scope_id, kind, id)?
            .iter()
            .map(sql::version_value)
            .collect::<Result<Vec<_>, _>>()?;
        let diagnostics = artifact
            .shadowed_scope_id
            .as_ref()
            .map(|scope| {
                project_artifact::CollisionDiagnostic::decode(
                    &ObjectEncoder::new()
                        .field("type", &LosslessString::from("project-over-global-shadow"))
                        .field("kind", kind)
                        .field("id", id)
                        .field("scopeID", scope)
                        .field(
                            "message",
                            &LosslessString::from(
                                "Project artifact explicitly shadows the confirmed global source",
                            ),
                        )
                        .finish(),
                )
                .map_err(|_| error("ReconciliationRequired"))
            })
            .transpose()?
            .into_iter()
            .collect();
        Ok(project_artifact::ArtifactDetails {
            artifact: sql::artifact_value(&scope, &artifact)?,
            definition,
            current_version: sql::version_value(&current)?,
            versions,
            diagnostics,
        })
    }
    pub fn list(
        &self,
        scope_id: &project_artifact::ScopeId,
        kind: Option<&project_artifact::Kind>,
        stage: Option<&project_artifact::Stage>,
    ) -> Result<Vec<project_artifact::ArtifactSummary>, Error> {
        let snapshot = self.client.snapshot()?;
        let mut artifacts = scan_index::<artifacts::ArtifactTable>(
            &snapshot,
            "project_artifact_scope_stage_kind_updated_idx",
            &key(scope_id.as_lossless()),
        )?;
        let trashed = scan_all::<artifacts::TrashTable>(&snapshot)?;
        artifacts.retain(|artifact| {
            !trashed.iter().any(|trash| {
                trash.scope_id == artifact.scope_id
                    && trash.kind == artifact.kind
                    && trash.artifact_id == artifact.artifact_id
            })
        });
        artifacts.sort_by(|left, right| {
            right
                .time_updated
                .cmp(&left.time_updated)
                .then_with(|| left.kind.cmp(&right.kind))
                .then_with(|| left.artifact_id.cmp(&right.artifact_id))
        });
        let mut output = Vec::new();
        for artifact in artifacts.into_iter().filter(|artifact| {
            kind.is_none_or(|kind| artifact.kind == *kind.as_lossless())
                && stage.is_none_or(|stage| artifact.stage == literal(stage))
        }) {
            let kind = project_artifact::Kind::decode(&JsonValue::String(artifact.kind.clone()))
                .map_err(|_| error("ReconciliationRequired"))?;
            let id = project_artifact::Id::decode(&JsonValue::String(artifact.artifact_id.clone()))
                .map_err(|_| error("ReconciliationRequired"))?;
            let details = self.get(scope_id, &kind, &id)?;
            let (name, description) = match &details.definition {
                project_artifact::Definition::Skill(value) => (&value.name, &value.description),
                project_artifact::Definition::Command(value) => (&value.name, &value.description),
                project_artifact::Definition::Agent(value) => (&value.name, &value.description),
                project_artifact::Definition::Plugin(value) => (&value.name, &value.description),
            };
            output.push(project_artifact::ArtifactSummary {
                scope: details.artifact.scope,
                kind,
                id,
                name: name.clone(),
                description: description.clone(),
                stage: details.artifact.stage,
                revision: details.artifact.revision,
                current_version_id: details.current_version.id,
                current_digest: details.current_version.content_digest,
                last_used_at: details.artifact.last_used_at,
                time_updated: details.artifact.time_updated,
            });
            if output.len() == 128 {
                break;
            }
        }
        Ok(output)
    }
    pub fn metrics(
        &self,
        version: &project_artifact::VersionId,
    ) -> Result<project_artifact::Metrics, Error> {
        super::accounting::Service::read_metrics(&self.client, version)
            .map_err(|_| error("StorageUnavailable"))
    }
    fn scope_from_snapshot(
        &self,
        snapshot: &Snapshot,
        id: &project_artifact::ScopeId,
    ) -> Result<project_artifact::Scope, Error> {
        let row = snapshot
            .get::<artifacts::ScopeTable>(&key(id.as_lossless()))?
            .ok_or_else(|| error("InvalidScope"))?;
        let project = snapshot
            .get::<artifacts::ProjectScopeTable>(&key(id.as_lossless()))?
            .map(|row| project::Id::decode(&JsonValue::String(row.project_id)))
            .transpose()
            .map_err(|_| error("ReconciliationRequired"))?;
        sql::scope_value(&row, project.as_ref())
    }
    fn read_content(
        &self,
        scope: &project_artifact::Scope,
        artifact: &artifacts::Artifact,
        version: &artifacts::Version,
    ) -> Result<String, Error> {
        let (_, storage) = scope_ids(scope);
        let root = scope_root(&self.paths.data, storage);
        let marker = package::Marker::decode(
            &ObjectEncoder::new()
                .field("schema", &1.0)
                .field("scopeID", &artifact.scope_id)
                .field("storageID", storage)
                .field("kind", &artifact.kind)
                .field("id", &artifact.artifact_id)
                .field("versionID", &version.id)
                .field("contentDigest", &version.content_digest)
                .field("contentRelpath", &version.content_relpath)
                .finish(),
        )
        .map_err(|_| error("ReconciliationRequired"))?;
        let path = if matches!(artifact.stage.as_str(), Some("disabled" | "degraded")) {
            package::disabled_content_path(&root, &marker)
        } else if matches!(scope, project_artifact::Scope::Global(_)) {
            adapter::global_path(
                &marker.kind,
                &self.paths.home,
                &self.paths.config,
                marker.id.as_lossless().as_str().expect("ID"),
            )
        } else {
            package::active_content_path(&root, &marker.kind, &marker.id)
        };
        fs::read(path)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .map_err(|_| error("StorageUnavailable"))
    }
    fn check_global_sources(
        &self,
        scope: &project_artifact::Scope,
        kind: &project_artifact::Kind,
        id: &project_artifact::Id,
        artifact: Option<&artifacts::Artifact>,
        version: Option<&artifacts::Version>,
    ) -> Result<(), Error> {
        let sources = self
            .sources
            .lock()
            .map_err(|_| error("StorageUnavailable"))?
            .resolve("global", None, kind, id);
        if artifact.is_none() && !sources.is_empty() {
            return Err(error("DestinationExists"));
        }
        if let Some(version) = version {
            let (scope_id, _) = scope_ids(scope);
            if sources.is_empty()
                || sources.iter().any(|source| {
                    source.managed_scope_id.as_ref() != Some(scope_id)
                        || source
                            .managed_version_id
                            .as_ref()
                            .map(|id| id.as_lossless())
                            != Some(&version.id)
                        || source
                            .managed_digest
                            .as_ref()
                            .map(|digest| digest.as_lossless())
                            != Some(&version.content_digest)
                })
            {
                return Err(error("DestinationExists"));
            }
        }
        Ok(())
    }
    fn write_snapshot(
        &self,
        scope: &project_artifact::Scope,
        id: &project_artifact::Id,
        definition: &project_artifact::Definition,
        expected: Option<&project_artifact::MutationExpectation>,
        context: WriteContext,
    ) -> Result<WriteResult, Error> {
        let now = context.now;
        let global = context.global;
        let (scope_id, storage_id) = scope_ids(scope);
        let kind = adapter::kind(definition);
        let content = context.snapshot.as_ref().map_or_else(
            || adapter::render(definition),
            |promotion| promotion.content.clone(),
        );
        let root = scope_root(&self.paths.data, storage_id);
        let snapshot = self.client.snapshot()?;
        let old = snapshot.get::<artifacts::ArtifactTable>(&artifacts::identity(
            scope_id.as_lossless(),
            kind.as_lossless(),
            id.as_lossless(),
        ))?;
        let previous = old
            .as_ref()
            .map(|artifact| {
                snapshot.get::<artifacts::VersionTable>(&key(&artifact.current_version_id))
            })
            .transpose()?
            .flatten();
        if global && expected.is_none() && old.is_some() {
            return Err(error("DestinationExists"));
        }
        check_expectation(old.as_ref(), previous.as_ref(), expected)?;
        if global {
            self.check_global_sources(scope, &kind, id, old.as_ref(), previous.as_ref())?;
            if let (Some(old), Some(previous)) = (&old, &previous)
                && package::sha256(&self.read_content(scope, old, previous)?.as_str().into())
                    .as_lossless()
                    != &previous.content_digest
            {
                return Err(error("OwnershipMismatch"));
            }
        }
        if old.is_none() {
            let other = scan_all::<artifacts::ArtifactTable>(&snapshot)?
                .into_iter()
                .any(|artifact| {
                    artifact.scope_id != *scope_id.as_lossless()
                        && artifact.kind == *kind.as_lossless()
                        && artifact.artifact_id == *id.as_lossless()
                });
            if other && !global && context.automatic.is_none() && context.snapshot.is_none() {
                return Err(error("ArtifactCollision"));
            }
        }
        if context.automatic.is_none()
            && let Some(previous) = &previous
            && previous.content_digest == *package::sha256(&content).as_lossless()
        {
            return Ok(WriteResult {
                result: project_artifact::AutomaticWriteResult::decode(&JsonValue::String(
                    "reconciled".into(),
                ))
                .expect("write result"),
                scope_id: scope_id.clone(),
                kind,
                id: id.clone(),
                version_id: project_artifact::VersionId::decode(&previous.id.encode())
                    .map_err(|_| error("ReconciliationRequired"))?,
                content_digest: project_artifact::Digest::decode(&previous.content_digest.encode())
                    .map_err(|_| error("ReconciliationRequired"))?,
                stage: project_artifact::Stage::decode(&JsonValue::String("trial".into()))
                    .expect("stage"),
                remaining: Remaining {
                    session: 3.0,
                    project_daily: 10.0,
                    project_artifacts: 32.0,
                    versions: 16.0,
                    bytes: 8.0 * 1024.0 * 1024.0,
                },
            });
        }
        drop(snapshot);
        let version_id = if let Some(automatic) = &context.automatic {
            automatic.version_id.clone()
        } else {
            project_artifact::VersionId::decode(&JsonValue::String(
                format!("pav_{}", package::uuid()?.replace('-', ""))
                    .as_str()
                    .into(),
            ))
            .map_err(|_| error("StorageUnavailable"))?
        };
        let marker = package::marker(package::MarkerInput {
            scope_id: scope_id.clone(),
            storage_id: storage_id.clone(),
            kind: kind.clone(),
            id: id.clone(),
            version_id: version_id.clone(),
            content: content.clone(),
        });
        let fingerprint = if let Some(promotion) = &context.snapshot {
            package::sha256(&crate::resources::discovery::join(
                &[
                    scope_id.as_lossless().clone(),
                    kind.as_lossless().clone(),
                    id.as_lossless().clone(),
                    promotion.operation.text().into(),
                    promotion.source.scope_id.clone(),
                    promotion.source.revision.to_string().as_str().into(),
                    promotion.version.id.clone(),
                    promotion.version.content_digest.clone(),
                    version_id.as_lossless().clone(),
                    marker.content_digest.as_lossless().clone(),
                ],
                "\0",
            ))
        } else if let Some(automatic) = &context.automatic {
            automatic.operation_fingerprint.clone()
        } else {
            package::sha256(&crate::resources::discovery::join(
                &[
                    scope_id.as_lossless().clone(),
                    kind.as_lossless().clone(),
                    id.as_lossless().clone(),
                    if old.is_some() {
                        "update".into()
                    } else {
                        "create".into()
                    },
                    old.as_ref()
                        .map(|old| old.revision.to_string().as_str().into())
                        .unwrap_or_else(|| "".into()),
                    old.as_ref()
                        .map(|old| old.current_version_id.clone())
                        .unwrap_or_else(|| "".into()),
                    previous
                        .as_ref()
                        .map(|old| old.content_digest.clone())
                        .unwrap_or_else(|| "".into()),
                    "".into(),
                    "".into(),
                    "".into(),
                    version_id.as_lossless().clone(),
                    marker.content_digest.as_lossless().clone(),
                ],
                "\0",
            ))
        };
        let operation_id = format!(
            "pop_{}",
            &fingerprint.as_lossless().as_str().expect("digest")[..32]
        );
        let operation = artifacts::Operation {
            id: operation_id.as_str().into(),
            scope_id: scope_id.as_lossless().clone(),
            kind: kind.as_lossless().clone(),
            artifact_id: id.as_lossless().clone(),
            operation: if let Some(snapshot) = &context.snapshot {
                snapshot.operation.text().into()
            } else if old.is_some() {
                "update".into()
            } else {
                "create".into()
            },
            request_fingerprint: fingerprint.as_lossless().clone(),
            expected_revision: old.as_ref().map(|old| old.revision),
            expected_version_id: old.as_ref().map(|old| old.current_version_id.clone()),
            expected_digest: previous.as_ref().map(|old| old.content_digest.clone()),
            source_scope_id: context
                .snapshot
                .as_ref()
                .map(|promotion| promotion.source.scope_id.clone()),
            source_version_id: context
                .snapshot
                .as_ref()
                .map(|promotion| promotion.version.id.clone()),
            source_digest: context
                .snapshot
                .as_ref()
                .map(|promotion| promotion.version.content_digest.clone()),
            target_version_id: Some(version_id.as_lossless().clone()),
            target_digest: Some(marker.content_digest.as_lossless().clone()),
            final_version_id: None,
            deletion_id: None,
            automatic_session_id: context
                .automatic
                .as_ref()
                .map(|automatic| automatic.session_id.as_lossless().clone()),
            automatic_insight_digest: context
                .automatic
                .as_ref()
                .map(|automatic| automatic.insight_digest.as_lossless().clone()),
            phase: "preparing".into(),
            time_created: now,
            time_updated: now,
        };
        let client = self.client.clone();
        let reservation = operation.clone();
        let reserve = move |_: &package::CommitTransactionMetadata| {
            let operation = reservation.clone();
            client
                .submit(move |tx| {
                    if let Some(mut existing) =
                        tx.get::<artifacts::OperationTable>(&key(&operation.id))?
                    {
                        if existing.phase.as_str() == Some("finalized") {
                            return Err(reject(tx, "ReconciliationRequired"));
                        }
                        let phase = existing.phase.clone();
                        existing.phase = operation.phase.clone();
                        existing.time_created = operation.time_created;
                        existing.time_updated = operation.time_updated;
                        if existing != operation {
                            return Err(reject(tx, "VersionConflict"));
                        }
                        if phase.as_str() == Some("aborted") {
                            artifacts::OperationTable::put(tx, &existing)?;
                        }
                        return Ok(());
                    }
                    artifacts::OperationTable::insert(tx, &operation)
                })?
                .wait()
                .map_err(Error::from)
        };
        let client = self.client.clone();
        let old_copy = old.clone();
        let previous_copy = previous.clone();
        let operation_copy = operation.clone();
        let marker_copy = marker.clone();
        let automatic = context.automatic.clone();
        let promotion = context.snapshot.clone();
        let finalize = move |_: &package::CommitTransactionMetadata| {
            let old = old_copy.clone();
            let updated = old.is_some();
            let automatic = automatic.clone();
            let promotion = promotion.clone();
            let previous = previous_copy.clone();
            let mut operation = operation_copy.clone();
            let marker = marker_copy.clone();
            client
                .submit(move |tx| {
                    operation.phase = "available".into();
                    artifacts::OperationTable::put(tx, &operation)?;
                    let version = artifacts::Version {
                        id: marker.version_id.as_lossless().clone(),
                        scope_id: marker.scope_id.as_lossless().clone(),
                        kind: marker.kind.as_lossless().clone(),
                        artifact_id: marker.id.as_lossless().clone(),
                        parent_version_id: old.as_ref().map(|old| old.current_version_id.clone()),
                        state: "trial".into(),
                        content_digest: marker.content_digest.as_lossless().clone(),
                        content_relpath: marker.content_relpath.as_lossless().clone(),
                        source: if let Some(snapshot) = &promotion {
                            snapshot.operation.text()
                        } else if automatic.is_some() {
                            "agent"
                        } else {
                            "user"
                        }
                        .into(),
                        creator_agent_id: automatic
                            .as_ref()
                            .and_then(|automatic| automatic.agent_id.clone()),
                        creator_session_id: automatic
                            .as_ref()
                            .map(|automatic| automatic.session_id.as_lossless().clone()),
                        insight_digest: automatic
                            .as_ref()
                            .map(|automatic| automatic.insight_digest.as_lossless().clone()),
                        origin_scope_id: promotion
                            .as_ref()
                            .map(|promotion| promotion.source.scope_id.clone()),
                        origin_version_id: promotion
                            .as_ref()
                            .map(|promotion| promotion.version.id.clone()),
                        origin_evidence_digest: promotion
                            .as_ref()
                            .map(|promotion| promotion.version.content_digest.clone()),
                        first_qualified_at: None,
                        last_evaluated_at: None,
                        last_restored_at: None,
                        last_governor_transition_at: None,
                        time_created: now,
                        time_state_changed: now,
                    };
                    let artifact = artifacts::Artifact {
                        scope_id: version.scope_id.clone(),
                        kind: version.kind.clone(),
                        artifact_id: version.artifact_id.clone(),
                        revision: old.as_ref().map_or(0, |old| old.revision + 1),
                        stage: "trial".into(),
                        current_version_id: version.id.clone(),
                        fallback_version_id: old.as_ref().map(|old| old.current_version_id.clone()),
                        shadowed_scope_id: promotion
                            .as_ref()
                            .filter(|snapshot| snapshot.operation == SnapshotOperation::Fork)
                            .map(|snapshot| snapshot.source.scope_id.clone())
                            .or_else(|| old.as_ref().and_then(|old| old.shadowed_scope_id.clone())),
                        last_used_at: old.as_ref().and_then(|old| old.last_used_at),
                        time_created: old.as_ref().map_or(now, |old| old.time_created),
                        time_updated: now,
                    };
                    if let (Some(old), Some(mut previous)) = (old, previous) {
                        artifacts::replace_artifact(
                            tx,
                            &artifacts::Expectation {
                                revision: old.revision,
                                version_id: old.current_version_id,
                                digest: previous.content_digest.clone(),
                            },
                            &artifact,
                            Some(&version),
                        )?;
                        previous.state = "superseded".into();
                        previous.time_state_changed = now;
                        artifacts::VersionTable::put(tx, &previous)?;
                    } else {
                        artifacts::insert_artifact(tx, &artifact, &version)?;
                    }
                    if let Some(promotion) = &promotion
                        && promotion.operation == SnapshotOperation::Promotion
                    {
                        let mut source = tx
                            .get::<artifacts::ArtifactTable>(&artifacts::identity(
                                &promotion.source.scope_id,
                                &promotion.source.kind,
                                &promotion.source.artifact_id,
                            ))?
                            .ok_or_else(|| reject(tx, "VersionConflict"))?;
                        if source.revision != promotion.source.revision
                            || source.current_version_id != promotion.version.id
                        {
                            return Err(reject(tx, "VersionConflict"));
                        }
                        source.shadowed_scope_id = Some(version.scope_id.clone());
                        source.time_updated = now;
                        artifacts::ArtifactTable::put(tx, &source)?;
                        let feedback = project_artifact::Feedback::decode(
                            &ObjectEncoder::new()
                                .field(
                                    "artifact",
                                    &ObjectEncoder::new()
                                        .field("scopeID", &source.scope_id)
                                        .field("kind", &source.kind)
                                        .field("id", &source.artifact_id)
                                        .field("versionID", &promotion.version.id)
                                        .finish(),
                                )
                                .field("action", &LosslessString::from("promote"))
                                .field("actor", &LosslessString::from("user"))
                                .field("timeCreated", &(now as f64))
                                .finish(),
                        )
                        .expect("feedback");
                        super::accounting::Service::record_feedback(tx, &feedback)
                            .map_err(|_| reject(tx, "ReconciliationRequired"))?;
                    }
                    if let Some(automatic) = &automatic {
                        artifacts::WriteTable::insert(
                            tx,
                            &artifacts::AutomaticWrite {
                                scope_id: version.scope_id.clone(),
                                session_id: automatic.session_id.as_lossless().clone(),
                                insight_digest: automatic.insight_digest.as_lossless().clone(),
                                operation: operation.operation.clone(),
                                result: if updated { "updated" } else { "created" }.into(),
                                version_id: version.id.clone(),
                                content_digest: version.content_digest.clone(),
                                time_created: now,
                            },
                        )?;
                    }
                    operation.phase = "finalized".into();
                    operation.final_version_id = Some(version.id);
                    operation.time_updated = now;
                    artifacts::OperationTable::put(tx, &operation)?;
                    Ok(())
                })?
                .wait()
                .map_err(Error::from)
        };
        let client = self.client.clone();
        let operation_copy = operation.clone();
        let abort = move |_: &package::CommitTransactionMetadata| {
            let mut operation = operation_copy.clone();
            client
                .submit(move |tx| {
                    operation.phase = "aborted".into();
                    operation.final_version_id = None;
                    operation.time_updated = now;
                    artifacts::OperationTable::put(tx, &operation)
                })?
                .wait()
                .map_err(Error::from)
        };
        let content_path = if global {
            Some(adapter::global_path(
                &kind,
                &self.paths.home,
                &self.paths.config,
                id.as_lossless().as_str().expect("ID"),
            ))
        } else {
            None
        };
        let metadata_path = content_path
            .as_ref()
            .map(|path| standard_marker_path(path, &kind, id));
        if let Some(path) = &content_path {
            fs::create_dir_all(path.parent().ok_or_else(|| error("OwnershipMismatch"))?)
                .map_err(|_| error("StorageUnavailable"))?;
        }
        let expected_version = previous
            .as_ref()
            .map(|version| {
                project_artifact::VersionId::decode(&JsonValue::String(version.id.clone()))
            })
            .transpose()
            .map_err(|_| error("VersionConflict"))?;
        let input = package::CommitInput {
            root: &root,
            marker: &marker,
            content: &content,
            expected_version_id: expected_version.as_ref(),
            operation_id: Some(&operation_id),
            standard: content_path.as_ref().zip(metadata_path.as_ref()).map(
                |(content_path, marker_path)| package::StandardTarget {
                    content_path,
                    marker_path,
                },
            ),
            no_overwrite: global && old.is_none(),
        };
        let can_compensate = || !self.client.is_fenced();
        package::commit_transaction(
            input,
            &Hooks::default(),
            &package::TransactionHooks {
                reserve: Some(&reserve),
                finalize: Some(&finalize),
                abort: Some(&abort),
                cancellation: None,
                can_compensate: Some(&can_compensate),
            },
        )
        .map_err(|error| match error {
            package::TransactionError::Package(error) => Error::from(error),
            package::TransactionError::Hook(error) => error,
            package::TransactionError::Interrupted => self::error("ReconciliationRequired"),
        })?;
        let remaining = if context.automatic.is_none() {
            let promotion = context
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.operation == SnapshotOperation::Promotion);
            Remaining {
                session: if promotion { 0.0 } else { 3.0 },
                project_daily: if promotion { 0.0 } else { 10.0 },
                project_artifacts: 32.0,
                versions: 16.0,
                bytes: 8.0 * 1024.0 * 1024.0,
            }
        } else {
            self.remaining(
                scope_id,
                &root,
                &kind,
                id,
                context
                    .automatic
                    .as_ref()
                    .map(|automatic| &automatic.session_id),
                now,
            )?
        };
        Ok(WriteResult {
            result: project_artifact::AutomaticWriteResult::decode(&JsonValue::String(
                if old.is_some() { "updated" } else { "created" }.into(),
            ))
            .expect("write result"),
            scope_id: scope_id.clone(),
            kind,
            id: id.clone(),
            version_id,
            content_digest: marker.content_digest,
            stage: project_artifact::Stage::decode(&JsonValue::String("trial".into()))
                .expect("stage"),
            remaining,
        })
    }
}

fn validate_definition(
    id: &str,
    definition: &project_artifact::Definition,
) -> Result<project_artifact::Id, Error> {
    let errors =
        validation::validate_automatic(&JsonValue::String(id.into()), &definition.encode(), &[]);
    if let Some(error) = errors.first() {
        return Err(Error {
            code: error.code.clone(),
        });
    }
    if let Some(error) = validation::validate_rendered(&adapter::render(definition)).first() {
        return Err(Error {
            code: error.code.clone(),
        });
    }
    project_artifact::Id::decode(&JsonValue::String(id.into()))
        .map_err(|_| error("InvalidArtifact"))
}
fn check_expectation(
    artifact: Option<&artifacts::Artifact>,
    version: Option<&artifacts::Version>,
    expected: Option<&project_artifact::MutationExpectation>,
) -> Result<(), Error> {
    match (artifact, version, expected) {
        (None, _, None) => Ok(()),
        (Some(artifact), Some(version), Some(expected))
            if artifact.revision == expected.expected_revision.get()
                && artifact.current_version_id == *expected.expected_version_id.as_lossless()
                && version.content_digest == *expected.expected_digest.as_lossless() =>
        {
            Ok(())
        }
        _ => Err(error("VersionConflict")),
    }
}
fn new_scope_ids() -> Result<(project_artifact::ScopeId, project_artifact::StorageId), Error> {
    Ok((
        project_artifact::ScopeId::decode(&JsonValue::String(
            format!("pas_{}", package::uuid()?.replace('-', ""))
                .as_str()
                .into(),
        ))
        .map_err(|_| error("StorageUnavailable"))?,
        project_artifact::StorageId::decode(&JsonValue::String(package::uuid()?.as_str().into()))
            .map_err(|_| error("StorageUnavailable"))?,
    ))
}
fn insert_scope(
    tx: &mut Write<'_>,
    scope: &project_artifact::Scope,
) -> Result<(), ycoding_store::Error> {
    let (id, storage) = scope_ids(scope);
    let time = chrono::Utc::now().timestamp_millis();
    artifacts::ScopeTable::insert(
        tx,
        &artifacts::Scope {
            id: id.as_lossless().clone(),
            type_: if matches!(scope, project_artifact::Scope::Project(_)) {
                "project".into()
            } else {
                "global".into()
            },
            storage_id: storage.as_lossless().clone(),
            time_created: time,
            time_updated: time,
        },
    )?;
    match scope {
        project_artifact::Scope::Project(scope) => artifacts::ProjectScopeTable::insert(
            tx,
            &artifacts::ProjectScope {
                scope_id: scope.id.as_lossless().clone(),
                project_id: scope.project_id.as_lossless().clone(),
            },
        ),
        project_artifact::Scope::Global(scope) => artifacts::GlobalScopeTable::insert(
            tx,
            &artifacts::GlobalScope {
                scope_id: scope.id.as_lossless().clone(),
                singleton: 1,
            },
        ),
    }
}
fn find_project_scope(
    tx: &mut Write<'_>,
    project: &project::Id,
) -> Result<Option<project_artifact::ProjectScope>, ycoding_store::Error> {
    let rows = tx.index::<artifacts::ProjectScopeTable>(
        "project_artifact_project_scope_project_id_idx",
        &key(project.as_lossless()),
        None,
        1,
    )?;
    let Some(member) = rows.first() else {
        return Ok(None);
    };
    let row = tx
        .get::<artifacts::ScopeTable>(&key(&member.scope_id))?
        .ok_or_else(|| reject(tx, "ReconciliationRequired"))?;
    let project_artifact::Scope::Project(scope) =
        sql::scope_value(&row, Some(project)).map_err(storage_error)?
    else {
        return Err(reject(tx, "ReconciliationRequired"));
    };
    Ok(Some(scope))
}
fn scope_ids(
    scope: &project_artifact::Scope,
) -> (&project_artifact::ScopeId, &project_artifact::StorageId) {
    match scope {
        project_artifact::Scope::Project(scope) => (&scope.id, &scope.storage_id),
        project_artifact::Scope::Global(scope) => (&scope.id, &scope.storage_id),
    }
}
fn scope_root(data: &Path, storage: &project_artifact::StorageId) -> PathBuf {
    data.join("project-artifacts")
        .join(storage.as_lossless().as_str().expect("storage ID"))
}
fn write_scope_marker(
    root: &Path,
    scope: &project_artifact::Scope,
    replace: bool,
) -> Result<(), Error> {
    let (id, storage) = scope_ids(scope);
    let content = ycoding_schema::stringify_json(
        &ObjectEncoder::new()
            .field("schema", &1.0)
            .field("scopeID", id)
            .field(
                "type",
                &LosslessString::from(if matches!(scope, project_artifact::Scope::Project(_)) {
                    "project"
                } else {
                    "global"
                }),
            )
            .field("storageID", storage)
            .finish(),
    );
    fs::create_dir_all(root).map_err(|_| error("StorageUnavailable"))?;
    let path = package::scope_marker_path(root);
    if !replace {
        match fs::read(&path) {
            Ok(_) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(error("StorageUnavailable")),
        };
        use std::io::Write;
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path);
        return match file {
            Ok(mut file) => file
                .write_all(content.as_bytes())
                .map_err(|_| error("StorageUnavailable")),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(_) => Err(error("StorageUnavailable")),
        };
    }
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, content)
        .and_then(|_| fs::rename(temporary, path))
        .map_err(|_| error("StorageUnavailable"))
}
fn version_rows(
    snapshot: &Snapshot,
    scope: &project_artifact::ScopeId,
    kind: &project_artifact::Kind,
    id: &project_artifact::Id,
) -> Result<Vec<artifacts::Version>, Error> {
    scan_index::<artifacts::VersionTable>(
        snapshot,
        "project_artifact_version_scope_kind_id_created_idx",
        &artifacts::identity(scope.as_lossless(), kind.as_lossless(), id.as_lossless()),
    )
}
fn scan_index<T: TableSpec>(
    snapshot: &Snapshot,
    index: &str,
    prefix: &[u8],
) -> Result<Vec<T::Record>, Error> {
    let mut after = None;
    let mut output = Vec::new();
    loop {
        let page = snapshot.index_range::<T>(
            index,
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(prefix),
                order: IndexOrder::Ascending,
                after: after.as_ref(),
                limit: 128,
            },
        )?;
        if page.is_empty() {
            return Ok(output);
        }
        after = page.last().map(|row| row.cursor.clone());
        output.extend(page.into_iter().map(|row| row.record));
    }
}
fn scan_all<T: TableSpec>(snapshot: &Snapshot) -> Result<Vec<T::Record>, Error> {
    let mut after = None;
    let mut output = Vec::new();
    loop {
        let page = snapshot.scan::<T>(
            after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            128,
        )?;
        if page.is_empty() {
            return Ok(output);
        }
        after = page.last().map(T::primary_key);
        output.extend(page);
    }
}
fn standard_marker_path(
    content: &Path,
    kind: &project_artifact::Kind,
    id: &project_artifact::Id,
) -> PathBuf {
    content.parent().expect("standard content parent").join(
        if kind.as_lossless().as_str() == Some("skill") {
            ".ycoding-project-artifact.json".to_string()
        } else {
            format!(
                ".{}.ycoding-project-artifact.json",
                id.as_lossless().as_str().expect("ID")
            )
        },
    )
}
fn key(value: &LosslessString) -> Vec<u8> {
    tuple_key(&[KeyPart::String(value)])
}
fn literal(value: &impl DomainEncode) -> LosslessString {
    let JsonValue::String(value) = value.encode() else {
        unreachable!("string domain")
    };
    value
}
pub(super) fn error(code: &str) -> Error {
    Error {
        code: project_artifact::ErrorCode::decode(&JsonValue::String(code.into()))
            .expect("artifact error code"),
    }
}
fn storage_error(error: Error) -> ycoding_store::Error {
    let code = literal(&error.code);
    let name = match code.as_str().expect("error code") {
        "ProjectIdentityUnavailable" => "ProjectIdentityUnavailable",
        "VersionConflict" => "VersionConflict",
        "ProjectAdoptionConflict" => "ProjectAdoptionConflict",
        "ReconciliationRequired" => "ReconciliationRequired",
        _ => "StorageUnavailable",
    };
    ycoding_store::Error::Domain {
        kind: "artifact_store",
        message: name,
    }
}
fn reject(tx: &mut Write<'_>, code: &'static str) -> ycoding_store::Error {
    tx.reject(ycoding_store::Error::Domain {
        kind: "artifact_store",
        message: code,
    })
}
