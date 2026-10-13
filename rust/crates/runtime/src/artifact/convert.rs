use crate::{convert, dispatch::Failure};
use ycoding_core::{
    resources::project_artifact::store,
    ycoding_schema::{
        DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder, project_artifact,
    },
};
use ycoding_protocol::v5;

const KINDS: &[&str] = &["skill", "command", "agent", "plugin"];
const STAGES: &[&str] = &["trial", "active", "degraded", "disabled", "quarantine"];

pub fn kind(value: i32) -> Result<project_artifact::Kind, Failure> {
    decode_enum(value, KINDS)
}

pub fn stage(value: i32) -> Result<project_artifact::Stage, Failure> {
    decode_enum(value, STAGES)
}

fn decode_enum<T: DomainDecode>(value: i32, choices: &[&str]) -> Result<T, Failure> {
    choices
        .get(value.checked_sub(1).unwrap_or(-1) as usize)
        .and_then(|value| T::decode(&JsonValue::String((*value).into())).ok())
        .ok_or_else(|| Failure::Invalid("invalid artifact enum".into()))
}

fn enum_wire(value: &impl DomainEncode, choices: &[&str]) -> i32 {
    let JsonValue::String(value) = value.encode() else {
        unreachable!("artifact literal")
    };
    choices
        .iter()
        .position(|choice| value.as_str() == Some(choice))
        .expect("validated artifact literal") as i32
        + 1
}

pub fn definition_domain(
    value: &v5::ProjectArtifactDefinition,
) -> Result<project_artifact::Definition, Failure> {
    use v5::project_artifact_definition::Kind;
    let object = match value
        .kind
        .as_ref()
        .ok_or_else(|| Failure::Invalid("missing artifact definition".into()))?
    {
        Kind::Value1(value) => ObjectEncoder::new()
            .field("kind", &LosslessString::from("skill"))
            .field("name", &convert::domain(&value.name)?)
            .field("description", &convert::domain(&value.description)?)
            .field("content", &convert::domain(&value.content)?),
        Kind::Value2(value) => ObjectEncoder::new()
            .field("kind", &LosslessString::from("command"))
            .field("name", &convert::domain(&value.name)?)
            .field("description", &convert::domain(&value.description)?)
            .field("template", &convert::domain(&value.template)?)
            .field("subtask", &value.subtask),
        Kind::Value3(value) => ObjectEncoder::new()
            .field("kind", &LosslessString::from("agent"))
            .field("name", &convert::domain(&value.name)?)
            .field("description", &convert::domain(&value.description)?)
            .field("system", &convert::domain(&value.system)?)
            .field(
                "mode",
                &decode_enum::<LosslessString>(value.mode, &["subagent"])?,
            )
            .field(
                "permissions",
                &value
                    .permissions
                    .items
                    .iter()
                    .map(|rule| {
                        Ok(ObjectEncoder::new()
                            .field("action", &convert::domain(&rule.action)?)
                            .field("resource", &convert::domain(&rule.resource)?)
                            .field(
                                "effect",
                                &decode_enum::<LosslessString>(
                                    rule.effect,
                                    &["allow", "deny", "ask"],
                                )?,
                            )
                            .finish())
                    })
                    .collect::<Result<Vec<_>, Failure>>()?,
            ),
        Kind::Value4(value) => ObjectEncoder::new()
            .field("kind", &LosslessString::from("plugin"))
            .field("name", &convert::domain(&value.name)?)
            .field("description", &convert::domain(&value.description)?)
            .field("draft", &convert::domain(&value.draft)?),
    };
    project_artifact::Definition::decode(&object.finish())
        .map_err(|_| Failure::Invalid("invalid artifact definition".into()))
}

pub fn definition(value: &project_artifact::Definition) -> v5::ProjectArtifactDefinition {
    use v5::project_artifact_definition::Kind;
    v5::ProjectArtifactDefinition {
        kind: Some(match value {
            project_artifact::Definition::Skill(value) => {
                Kind::Value1(v5::ProjectArtifactSkillDefinition {
                    kind: 1,
                    name: convert::wire(value.name.as_lossless()),
                    description: convert::wire(value.description.as_lossless()),
                    content: convert::wire(value.content.as_lossless()),
                })
            }
            project_artifact::Definition::Command(value) => {
                Kind::Value2(v5::ProjectArtifactCommandDefinition {
                    kind: 1,
                    name: convert::wire(value.name.as_lossless()),
                    description: convert::wire(value.description.as_lossless()),
                    template: convert::wire(value.template.as_lossless()),
                    subtask: false,
                })
            }
            project_artifact::Definition::Agent(value) => {
                Kind::Value3(v5::ProjectArtifactAgentDefinition {
                    kind: 1,
                    name: convert::wire(value.name.as_lossless()),
                    description: convert::wire(value.description.as_lossless()),
                    system: convert::wire(value.system.as_lossless()),
                    mode: 1,
                    permissions: v5::PermissionRuleset {
                        items: value
                            .permissions
                            .iter()
                            .map(|rule| v5::PermissionRule {
                                action: convert::wire(&rule.action),
                                resource: convert::wire(&rule.resource),
                                effect: enum_wire(&rule.effect, &["allow", "deny", "ask"]),
                            })
                            .collect(),
                    },
                })
            }
            project_artifact::Definition::Plugin(value) => {
                Kind::Value4(v5::ProjectArtifactPluginDefinition {
                    kind: 1,
                    name: convert::wire(value.name.as_lossless()),
                    description: convert::wire(value.description.as_lossless()),
                    draft: convert::wire(value.draft.as_lossless()),
                })
            }
        }),
    }
}

pub fn expectation(
    value: &v5::ProjectArtifactApiExpectation,
) -> Result<project_artifact::MutationExpectation, Failure> {
    Ok(project_artifact::MutationExpectation {
        expected_revision: project_artifact::Revision::decode(&JsonValue::Number(
            value.expected_revision as f64,
        ))
        .map_err(|_| Failure::Invalid("invalid artifact revision".into()))?,
        expected_version_id: convert::identifier(&value.expected_version_id)?,
        expected_digest: convert::identifier(&value.expected_digest)?,
    })
}

pub fn preview(value: store::ConfirmationPreview) -> v5::ProjectArtifactApiConfirmationPreview {
    v5::ProjectArtifactApiConfirmationPreview {
        token: convert::wire(value.token.as_lossless()),
        expires_at: value.expires_at as u64,
    }
}

pub fn mutation(value: store::WriteResult) -> v5::ProjectArtifactApiMutationResult {
    v5::ProjectArtifactApiMutationResult {
        result: enum_wire(&value.result, &["created", "updated", "reconciled"]),
        scope_id: convert::wire(value.scope_id.as_lossless()),
        kind: enum_wire(&value.kind, KINDS),
        id: convert::wire(value.id.as_lossless()),
        version_id: convert::wire(value.version_id.as_lossless()),
        content_digest: convert::wire(value.content_digest.as_lossless()),
        stage: 1,
        remaining: v5::ProjectArtifactApiMutationResultRemaining {
            session: value.remaining.session as i64,
            project_daily: value.remaining.project_daily as i64,
            project_artifacts: value.remaining.project_artifacts as i64,
            versions: value.remaining.versions as i64,
            bytes: value.remaining.bytes as i64,
        },
    }
}

fn global_scope(value: &project_artifact::GlobalScope) -> v5::ProjectArtifactGlobalScope {
    v5::ProjectArtifactGlobalScope {
        r#type: 1,
        id: convert::wire(value.id.as_lossless()),
        storage_id: convert::wire(value.storage_id.as_lossless()),
    }
}

fn scope(value: &project_artifact::Scope) -> v5::ProjectArtifactScope {
    use v5::project_artifact_scope::Kind;
    v5::ProjectArtifactScope {
        kind: Some(match value {
            project_artifact::Scope::Project(value) => {
                Kind::Value1(v5::ProjectArtifactProjectScope {
                    r#type: 1,
                    id: convert::wire(value.id.as_lossless()),
                    project_id: convert::wire(value.project_id.as_lossless()),
                    storage_id: convert::wire(value.storage_id.as_lossless()),
                })
            }
            project_artifact::Scope::Global(value) => Kind::Value2(global_scope(value)),
        }),
    }
}

fn version(value: &project_artifact::Version) -> v5::ProjectArtifactVersion {
    v5::ProjectArtifactVersion {
        id: convert::wire(value.id.as_lossless()),
        parent_version_id: value
            .parent_version_id
            .as_ref()
            .map(|value| convert::wire(value.as_lossless())),
        state: enum_wire(
            &value.state,
            &[
                "trial",
                "active",
                "degraded",
                "disabled",
                "quarantine",
                "superseded",
            ],
        ),
        content_digest: convert::wire(value.content_digest.as_lossless()),
        content_relpath: convert::wire(value.content_relpath.as_lossless()),
        provenance: v5::ProjectArtifactProvenance {
            source: enum_wire(
                &value.provenance.source,
                &["agent", "user", "promotion", "fork", "restore"],
            ),
            creator_agent_id: value
                .provenance
                .creator_agent_id
                .as_ref()
                .map(convert::wire),
            creator_session_id: value
                .provenance
                .creator_session_id
                .as_ref()
                .map(|value| convert::wire(value.as_lossless())),
            insight_digest: value
                .provenance
                .insight_digest
                .as_ref()
                .map(|value| convert::wire(value.as_lossless())),
            origin_scope_id: value
                .provenance
                .origin_scope_id
                .as_ref()
                .map(|value| convert::wire(value.as_lossless())),
            origin_version_id: value
                .provenance
                .origin_version_id
                .as_ref()
                .map(|value| convert::wire(value.as_lossless())),
            origin_evidence_digest: value
                .provenance
                .origin_evidence_digest
                .as_ref()
                .map(|value| convert::wire(value.as_lossless())),
        },
        time_created: value.time_created.get() as u64,
        time_state_changed: value.time_state_changed.get() as u64,
    }
}

fn diagnostic(
    value: &project_artifact::CollisionDiagnostic,
) -> v5::ProjectArtifactCollisionDiagnostic {
    v5::ProjectArtifactCollisionDiagnostic {
        r#type: enum_wire(
            &value.diagnostic_type,
            &[
                "existing-source",
                "cross-scope",
                "project-over-global-shadow",
            ],
        ),
        kind: enum_wire(&value.kind, KINDS),
        id: convert::wire(value.id.as_lossless()),
        scope_id: value
            .scope_id
            .as_ref()
            .map(|value| convert::wire(value.as_lossless())),
        message: convert::wire(value.message.as_lossless()),
    }
}

pub fn details(value: &project_artifact::ArtifactDetails) -> v5::ProjectArtifactArtifactDetails {
    v5::ProjectArtifactArtifactDetails {
        artifact: v5::ProjectArtifactArtifact {
            scope: scope(&value.artifact.scope),
            kind: enum_wire(&value.artifact.kind, KINDS),
            id: convert::wire(value.artifact.id.as_lossless()),
            revision: value.artifact.revision.get() as u64,
            stage: enum_wire(&value.artifact.stage, STAGES),
            current_version_id: convert::wire(value.artifact.current_version_id.as_lossless()),
            fallback_version_id: value
                .artifact
                .fallback_version_id
                .as_ref()
                .map(|value| convert::wire(value.as_lossless())),
            shadowed_scope_id: value
                .artifact
                .shadowed_scope_id
                .as_ref()
                .map(|value| convert::wire(value.as_lossless())),
            last_used_at: value.artifact.last_used_at.map(|value| value.get() as u64),
            time_created: value.artifact.time_created.get() as u64,
            time_updated: value.artifact.time_updated.get() as u64,
        },
        definition: definition(&value.definition),
        current_version: version(&value.current_version),
        versions: v5::ProjectArtifactArtifactDetailsVersions {
            items: value.versions.iter().map(version).collect(),
        },
        diagnostics: v5::ProjectArtifactArtifactDetailsDiagnostics {
            items: value.diagnostics.iter().map(diagnostic).collect(),
        },
    }
}

pub fn summary(value: &project_artifact::ArtifactSummary) -> v5::ProjectArtifactArtifactSummary {
    v5::ProjectArtifactArtifactSummary {
        scope: scope(&value.scope),
        kind: enum_wire(&value.kind, KINDS),
        id: convert::wire(value.id.as_lossless()),
        name: convert::wire(value.name.as_lossless()),
        description: convert::wire(value.description.as_lossless()),
        stage: enum_wire(&value.stage, STAGES),
        revision: value.revision.get() as u64,
        current_version_id: convert::wire(value.current_version_id.as_lossless()),
        current_digest: convert::wire(value.current_digest.as_lossless()),
        last_used_at: value.last_used_at.map(|value| value.get() as u64),
        time_updated: value.time_updated.get() as u64,
    }
}

pub fn trash(value: &project_artifact::Trash) -> v5::ArtifactRemoveResultData {
    v5::ArtifactRemoveResultData {
        deletion_id: convert::wire(value.deletion_id.as_lossless()),
        scope: scope(&value.scope),
        kind: enum_wire(&value.kind, KINDS),
        id: convert::wire(value.id.as_lossless()),
        prior_stage: enum_wire(&value.prior_stage, STAGES),
        prior_version_id: convert::wire(value.prior_version_id.as_lossless()),
        deleted_at: value.deleted_at.get() as u64,
        purge_after: value.purge_after.get() as u64,
    }
}

pub fn trash_summary(value: &store::TrashDetails) -> v5::ProjectArtifactApiTrashSummary {
    let trash = trash(&value.trash);
    let (name, description) = match &value.definition {
        project_artifact::Definition::Skill(value) => (&value.name, &value.description),
        project_artifact::Definition::Command(value) => (&value.name, &value.description),
        project_artifact::Definition::Agent(value) => (&value.name, &value.description),
        project_artifact::Definition::Plugin(value) => (&value.name, &value.description),
    };
    v5::ProjectArtifactApiTrashSummary {
        deletion_id: trash.deletion_id,
        scope: trash.scope,
        kind: trash.kind,
        id: trash.id,
        prior_stage: trash.prior_stage,
        prior_version_id: trash.prior_version_id,
        deleted_at: trash.deleted_at,
        purge_after: trash.purge_after,
        name: convert::wire(name.as_lossless()),
        description: convert::wire(description.as_lossless()),
        definition: definition(&value.definition),
    }
}

pub fn metrics(value: &project_artifact::Metrics) -> v5::ProjectArtifactApiMetrics {
    v5::ProjectArtifactApiMetrics {
        score: value.score,
        reward_units: value.reward_units,
        penalty_units: value.penalty_units,
        last_used_at: value.last_used_at.map(|value| value.get() as u64),
        confidence: v5::ProjectArtifactApiMetricsConfidence {
            sample_count: value.confidence.sample_count.get() as u64,
            success_count: value.confidence.success_count.get() as u64,
            lower_bound: value.confidence.lower_bound,
            upper_bound: value.confidence.upper_bound,
            eligible: value.confidence.eligible,
        },
    }
}

pub fn promotion(
    value: &project_artifact::PromotionPreview,
) -> v5::ProjectArtifactPromotionPreview {
    let metrics = metrics(&value.metrics);
    v5::ProjectArtifactPromotionPreview {
        artifact: summary(&value.artifact),
        destination: global_scope(&value.destination),
        risk: enum_wire(&value.risk, &["declarative", "executable"]),
        rendered_content: convert::wire(value.rendered_content.as_lossless()),
        collision: value.collision.as_ref().map(diagnostic),
        token: convert::wire(value.token.as_lossless()),
        expires_at: value.expires_at.get() as u64,
        metrics: v5::ProjectArtifactMetrics {
            score: metrics.score,
            reward_units: metrics.reward_units,
            penalty_units: metrics.penalty_units,
            last_used_at: metrics.last_used_at,
            confidence: v5::ProjectArtifactMetricsConfidence {
                sample_count: metrics.confidence.sample_count,
                success_count: metrics.confidence.success_count,
                lower_bound: metrics.confidence.lower_bound,
                upper_bound: metrics.confidence.upper_bound,
                eligible: metrics.confidence.eligible,
            },
        },
    }
}
