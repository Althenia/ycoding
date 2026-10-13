use super::store::{Error, error};
use ycoding_schema::{DomainDecode, JsonValue, ObjectEncoder, project, project_artifact};
use ycoding_store::artifacts;

pub fn scope_value(
    row: &artifacts::Scope,
    project: Option<&project::Id>,
) -> Result<project_artifact::Scope, Error> {
    project_artifact::Scope::decode(
        &ObjectEncoder::new()
            .field("type", &row.type_)
            .field("id", &row.id)
            .optional("projectID", &project.cloned())
            .field("storageID", &row.storage_id)
            .finish(),
    )
    .map_err(|_| error("ReconciliationRequired"))
}
pub fn artifact_value(
    scope: &project_artifact::Scope,
    row: &artifacts::Artifact,
) -> Result<project_artifact::Artifact, Error> {
    project_artifact::Artifact::decode(
        &ObjectEncoder::new()
            .field("scope", scope)
            .field("kind", &row.kind)
            .field("id", &row.artifact_id)
            .field("revision", &(row.revision as f64))
            .field("stage", &row.stage)
            .field("currentVersionID", &row.current_version_id)
            .optional("fallbackVersionID", &row.fallback_version_id)
            .optional("shadowedScopeID", &row.shadowed_scope_id)
            .optional("lastUsedAt", &row.last_used_at.map(|v| v as f64))
            .field("timeCreated", &(row.time_created as f64))
            .field("timeUpdated", &(row.time_updated as f64))
            .finish(),
    )
    .map_err(|_| error("ReconciliationRequired"))
}
pub fn version_value(row: &artifacts::Version) -> Result<project_artifact::Version, Error> {
    let provenance = ObjectEncoder::new()
        .field("source", &row.source)
        .optional("creatorAgentID", &row.creator_agent_id)
        .optional("creatorSessionID", &row.creator_session_id)
        .optional("insightDigest", &row.insight_digest)
        .optional("originScopeID", &row.origin_scope_id)
        .optional("originVersionID", &row.origin_version_id)
        .optional("originEvidenceDigest", &row.origin_evidence_digest)
        .finish();
    project_artifact::Version::decode(
        &ObjectEncoder::new()
            .field("id", &row.id)
            .optional("parentVersionID", &row.parent_version_id)
            .field("state", &row.state)
            .field("contentDigest", &row.content_digest)
            .field("contentRelpath", &row.content_relpath)
            .field("provenance", &provenance)
            .field("timeCreated", &(row.time_created as f64))
            .field("timeStateChanged", &(row.time_state_changed as f64))
            .finish(),
    )
    .map_err(|_| error("ReconciliationRequired"))
}
pub fn marker_value(
    scope: &artifacts::Scope,
    version: &artifacts::Version,
) -> Result<super::package::Marker, Error> {
    super::package::Marker::decode(
        &ObjectEncoder::new()
            .field("schema", &JsonValue::Number(1.0))
            .field("scopeID", &scope.id)
            .field("storageID", &scope.storage_id)
            .field("kind", &version.kind)
            .field("id", &version.artifact_id)
            .field("versionID", &version.id)
            .field("contentDigest", &version.content_digest)
            .field("contentRelpath", &version.content_relpath)
            .finish(),
    )
    .map_err(|_| error("ReconciliationRequired"))
}
