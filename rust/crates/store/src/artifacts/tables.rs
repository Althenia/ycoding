use super::codec::{key, table};
use crate::session::codec::{check, integer, nonnegative, text};
use crate::{Error, IndexDefinition, KeyPart, tuple_key};
use ycoding_schema::{DomainDecode, JsonValue, LosslessString, project_artifact};

pub fn identity(scope: &LosslessString, kind: &LosslessString, id: &LosslessString) -> Vec<u8> {
    tuple_key(&[
        KeyPart::String(scope),
        KeyPart::String(kind),
        KeyPart::String(id),
    ])
}

table!(ScopeTable, Scope, "project_artifact_scope", {
    id: LosslessString, type_: LosslessString, storage_id: LosslessString, time_created: i64, time_updated: i64
}, r, key(&r.id), &[
    IndexDefinition::unique("project_artifact_scope_id_type_unique"),
    IndexDefinition::unique("project_artifact_scope_storage_id_idx")
], index, match index.name {
    "project_artifact_scope_id_type_unique" => Ok(Some(tuple_key(&[KeyPart::String(&r.id), KeyPart::String(&r.type_)]))),
    "project_artifact_scope_storage_id_idx" => Ok(Some(key(&r.storage_id))),
    _ => Err(Error::UnregisteredIndex)
}, {
    check(matches!(r.type_.as_str(), Some("project" | "global")), "project_artifact_scope_type_check")?;
    check(storage_id(&r.storage_id), "project_artifact_scope_storage_id_check")?;
    check(schema_prefix::<project_artifact::ScopeId>(&r.id), "project_artifact_scope_id_check")?;
    check(r.time_created >= 0 && r.time_updated >= 0, "project_artifact_scope_time_check")
}, tx, { super::operations::scope_references(tx, r)?; });

table!(ProjectScopeTable, ProjectScope, "project_artifact_project_scope", {
    scope_id: LosslessString, project_id: LosslessString
}, r, key(&r.scope_id), &[IndexDefinition::unique("project_artifact_project_scope_project_id_idx")], index,
match index.name { "project_artifact_project_scope_project_id_idx" => Ok(Some(key(&r.project_id))), _ => Err(Error::UnregisteredIndex) },
Ok::<_, Error>(()), tx, { super::operations::project_scope_references(tx, r)?; });

table!(GlobalScopeTable, GlobalScope, "project_artifact_global_scope", {
    scope_id: LosslessString, singleton: i64
}, r, key(&r.scope_id), &[IndexDefinition::unique("project_artifact_global_scope_singleton_idx")], index,
match index.name { "project_artifact_global_scope_singleton_idx" => Ok(Some(tuple_key(&[KeyPart::I64(r.singleton)]))), _ => Err(Error::UnregisteredIndex) },
check(r.singleton == 1, "project_artifact_global_scope_singleton_check"), tx, { super::operations::global_scope_references(tx, r)?; });

table!(ArtifactTable, Artifact, "project_artifact", {
    scope_id: LosslessString, kind: LosslessString, artifact_id: LosslessString, revision: i64, stage: LosslessString,
    current_version_id: LosslessString, fallback_version_id: Option<LosslessString>, shadowed_scope_id: Option<LosslessString>,
    last_used_at: Option<i64>, time_created: i64, time_updated: i64
}, r, identity(&r.scope_id, &r.kind, &r.artifact_id), &[IndexDefinition::secondary("project_artifact_scope_stage_kind_updated_idx")], index,
match index.name {
    "project_artifact_scope_stage_kind_updated_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.scope_id), KeyPart::String(&r.stage), KeyPart::String(&r.kind), KeyPart::I64(r.time_updated), KeyPart::String(&r.artifact_id)]))),
    _ => Err(Error::UnregisteredIndex)
}, {
    check(artifact_id(&r.artifact_id), "project_artifact_id_check")?;
    check(r.revision >= 0, "project_artifact_revision_check")?;
    check(schema::<project_artifact::Kind>(&r.kind), "project_artifact_kind_check")?;
    check(schema::<project_artifact::Stage>(&r.stage), "project_artifact_stage_check")?;
    check(nonnegative(r.last_used_at) && r.time_created >= 0 && r.time_updated >= 0, "project_artifact_time_check")
}, tx, { super::operations::artifact_references(tx, r)?; });

table!(VersionTable, Version, "project_artifact_version", {
    id: LosslessString, scope_id: LosslessString, kind: LosslessString, artifact_id: LosslessString, parent_version_id: Option<LosslessString>,
    state: LosslessString, content_digest: LosslessString, content_relpath: LosslessString, source: LosslessString,
    creator_agent_id: Option<LosslessString>, creator_session_id: Option<LosslessString>, insight_digest: Option<LosslessString>,
    origin_scope_id: Option<LosslessString>, origin_version_id: Option<LosslessString>, origin_evidence_digest: Option<LosslessString>,
    first_qualified_at: Option<i64>, last_evaluated_at: Option<i64>, last_restored_at: Option<i64>, last_governor_transition_at: Option<i64>,
    time_created: i64, time_state_changed: i64
}, r, key(&r.id), &[
    IndexDefinition::unique("project_artifact_version_owner_unique"),
    IndexDefinition::unique("project_artifact_version_digest_owner_unique"),
    IndexDefinition::unique("project_artifact_version_write_unique"),
    IndexDefinition::unique("project_artifact_version_scope_kind_id_digest_idx"),
    IndexDefinition::secondary("project_artifact_version_scope_kind_id_created_idx")
], index, match index.name {
    "project_artifact_version_owner_unique" => Ok(Some(tuple_key(&[KeyPart::String(&r.id), KeyPart::String(&r.scope_id), KeyPart::String(&r.kind), KeyPart::String(&r.artifact_id)]))),
    "project_artifact_version_digest_owner_unique" => Ok(Some(tuple_key(&[KeyPart::String(&r.id), KeyPart::String(&r.scope_id), KeyPart::String(&r.kind), KeyPart::String(&r.artifact_id), KeyPart::String(&r.content_digest)]))),
    "project_artifact_version_write_unique" => Ok(Some(tuple_key(&[KeyPart::String(&r.id), KeyPart::String(&r.scope_id), KeyPart::String(&r.content_digest)]))),
    "project_artifact_version_scope_kind_id_digest_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.scope_id), KeyPart::String(&r.kind), KeyPart::String(&r.artifact_id), KeyPart::String(&r.content_digest)]))),
    "project_artifact_version_scope_kind_id_created_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.scope_id), KeyPart::String(&r.kind), KeyPart::String(&r.artifact_id), KeyPart::I64(r.time_created)]))),
    _ => Err(Error::UnregisteredIndex)
}, {
    check(schema_prefix::<project_artifact::VersionId>(&r.id), "project_artifact_version_id_check")?;
    check(schema::<project_artifact::VersionState>(&r.state), "project_artifact_version_state_check")?;
    check(digest(&r.content_digest), "project_artifact_version_digest_check")?;
    check(optional_digest(&r.insight_digest) && optional_digest(&r.origin_evidence_digest), "project_artifact_version_optional_digest_check")?;
    check(relpath(&r.content_relpath), "project_artifact_version_relpath_check")?;
    check(schema::<project_artifact::Source>(&r.source), "project_artifact_version_source_check")?;
    check(session(&r.creator_session_id), "project_artifact_version_session_check")?;
    check(if matches!(r.source.as_str(), Some("promotion" | "fork")) {
        r.origin_scope_id.is_some() && r.origin_version_id.is_some() && r.origin_evidence_digest.is_some()
    } else { r.origin_scope_id.is_none() && r.origin_version_id.is_none() && r.origin_evidence_digest.is_none() }, "project_artifact_version_origin_check")?;
    check([r.first_qualified_at, r.last_evaluated_at, r.last_restored_at, r.last_governor_transition_at].into_iter().all(nonnegative)
        && r.time_created >= 0 && r.time_state_changed >= 0, "project_artifact_version_time_check")
}, tx, { super::operations::version_references(tx, r)?; });

table!(TrashTable, Trash, "project_artifact_trash", {
    deletion_id: LosslessString, scope_id: LosslessString, kind: LosslessString, artifact_id: LosslessString, prior_stage: LosslessString,
    prior_version_id: LosslessString, deleted_at: i64, purge_after: i64
}, r, key(&r.deletion_id), &[
    IndexDefinition::unique("project_artifact_trash_scope_kind_id_idx"), IndexDefinition::secondary("project_artifact_trash_purge_after_idx")
], index, match index.name {
    "project_artifact_trash_scope_kind_id_idx" => Ok(Some(identity(&r.scope_id, &r.kind, &r.artifact_id))),
    "project_artifact_trash_purge_after_idx" => Ok(Some(tuple_key(&[KeyPart::I64(r.purge_after)]))),
    _ => Err(Error::UnregisteredIndex)
}, {
    check(schema_prefix::<project_artifact::DeletionId>(&r.deletion_id), "project_artifact_trash_id_check")?;
    check(schema::<project_artifact::Stage>(&r.prior_stage), "project_artifact_trash_stage_check")?;
    check(r.deleted_at >= 0 && r.purge_after >= 0, "project_artifact_trash_time_check")?;
    check(r.deleted_at.checked_add(2_592_000_000) == Some(r.purge_after), "project_artifact_trash_expiry_check")
}, tx, { super::operations::trash_references(tx, r)?; });

table!(OperationTable, Operation, "project_artifact_operation", {
    id: LosslessString, scope_id: LosslessString, kind: LosslessString, artifact_id: LosslessString, operation: LosslessString,
    request_fingerprint: LosslessString, expected_revision: Option<i64>, expected_version_id: Option<LosslessString>, expected_digest: Option<LosslessString>,
    source_scope_id: Option<LosslessString>, source_version_id: Option<LosslessString>, source_digest: Option<LosslessString>,
    target_version_id: Option<LosslessString>, target_digest: Option<LosslessString>, final_version_id: Option<LosslessString>, deletion_id: Option<LosslessString>,
    automatic_session_id: Option<LosslessString>, automatic_insight_digest: Option<LosslessString>, phase: LosslessString,
    time_created: i64, time_updated: i64
}, r, key(&r.id), &[
    IndexDefinition::unique("project_artifact_operation_request_idx"),
    IndexDefinition::unique("project_artifact_operation_automatic_retry_idx"),
    IndexDefinition::unique("project_artifact_operation_active_artifact_idx"),
    IndexDefinition::secondary("project_artifact_operation_recovery_idx")
], index, match index.name {
    "project_artifact_operation_request_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.scope_id), KeyPart::String(&r.request_fingerprint)]))),
    "project_artifact_operation_automatic_retry_idx" => Ok(match (&r.automatic_session_id, &r.automatic_insight_digest) {
        (Some(session), Some(insight)) => Some(tuple_key(&[KeyPart::String(&r.scope_id), KeyPart::String(session), KeyPart::String(insight)])), _ => None
    }),
    "project_artifact_operation_active_artifact_idx" => Ok(matches!(r.phase.as_str(), Some("preparing" | "available")).then(|| identity(&r.scope_id, &r.kind, &r.artifact_id))),
    "project_artifact_operation_recovery_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.phase), KeyPart::I64(r.time_updated), KeyPart::String(&r.id)]))),
    _ => Err(Error::UnregisteredIndex)
}, {
    check(prefixed(&r.id, "pop"), "project_artifact_operation_id_check")?;
    check(artifact_id(&r.artifact_id), "project_artifact_operation_artifact_id_check")?;
    check(schema::<project_artifact::Kind>(&r.kind), "project_artifact_operation_kind_check")?;
    check(matches!(r.operation.as_str(), Some("create" | "update" | "promotion" | "fork" | "shadow" | "remove" | "restore" | "disable" | "enable" | "revert" | "purge")), "project_artifact_operation_operation_check")?;
    check(matches!(r.phase.as_str(), Some("preparing" | "available" | "finalized" | "aborted")), "project_artifact_operation_phase_check")?;
    check(digest(&r.request_fingerprint) && [&r.expected_digest, &r.source_digest, &r.target_digest, &r.automatic_insight_digest].into_iter().all(optional_digest), "project_artifact_operation_digest_check")?;
    check([&r.expected_version_id, &r.source_version_id, &r.target_version_id, &r.final_version_id].into_iter().all(|id| id.as_ref().is_none_or(schema_prefix::<project_artifact::VersionId>)), "project_artifact_operation_version_id_check")?;
    check(r.deletion_id.as_ref().is_none_or(schema_prefix::<project_artifact::DeletionId>), "project_artifact_operation_deletion_id_check")?;
    check(session(&r.automatic_session_id), "project_artifact_operation_session_check")?;
    check(r.expected_revision.is_some() == r.expected_version_id.is_some() && r.expected_revision.is_some() == r.expected_digest.is_some(), "project_artifact_operation_expectation_check")?;
    check(if matches!(r.operation.as_str(), Some("promotion" | "fork" | "shadow")) {
        r.source_scope_id.is_some() && r.source_version_id.is_some() && r.source_digest.is_some()
    } else { r.source_scope_id.is_none() && r.source_version_id.is_none() && r.source_digest.is_none() }, "project_artifact_operation_source_check")?;
    check(r.target_version_id.is_some() == r.target_digest.is_some(), "project_artifact_operation_target_check")?;
    check(r.automatic_session_id.is_some() == r.automatic_insight_digest.is_some(), "project_artifact_operation_automatic_check")?;
    check(if r.phase.as_str() != Some("finalized") || matches!(r.operation.as_str(), Some("remove" | "purge")) { r.final_version_id.is_none() }
        else { r.final_version_id.is_some() && r.target_version_id.is_some() && r.target_digest.is_some() && r.target_version_id == r.final_version_id }, "project_artifact_operation_finalization_check")?;
    check(r.target_version_id.is_none() || r.final_version_id.is_none() || r.target_version_id == r.final_version_id, "project_artifact_operation_final_target_check")?;
    check(matches!(r.operation.as_str(), Some("remove" | "restore" | "purge")) == r.deletion_id.is_some(), "project_artifact_operation_deletion_check")?;
    check(nonnegative(r.expected_revision) && r.time_created >= 0 && r.time_updated >= r.time_created, "project_artifact_operation_time_check")
}, tx, { super::operations::operation_references(tx, r)?; });

table!(ActivationTable, Activation, "project_artifact_activation", {
    id: LosslessString, scope_id: LosslessString, kind: LosslessString, artifact_id: LosslessString, version_id: LosslessString,
    project_id: Option<LosslessString>, session_id: Option<LosslessString>, agent_id: Option<LosslessString>, source: LosslessString,
    message_id: Option<LosslessString>, call_id: Option<LosslessString>, boundary_seq: i64, activated_at: i64, deactivated_at: Option<i64>
}, r, key(&r.id), &[
    IndexDefinition::unique("project_artifact_activation_identity_idx"), IndexDefinition::unique("project_artifact_activation_sessionless_identity_idx"),
    IndexDefinition::secondary("project_artifact_activation_session_open_idx")
], index, match index.name {
    "project_artifact_activation_identity_idx" => Ok(r.session_id.as_ref().map(|session| tuple_key(&[KeyPart::String(session), KeyPart::String(&r.version_id), KeyPart::String(&r.source), KeyPart::I64(r.boundary_seq)]))),
    "project_artifact_activation_sessionless_identity_idx" => Ok(r.session_id.is_none().then(|| tuple_key(&[KeyPart::String(&r.version_id), KeyPart::String(&r.source), KeyPart::I64(r.boundary_seq)]))),
    "project_artifact_activation_session_open_idx" => Ok(Some(tuple_key(&[text(&r.session_id), integer(r.deactivated_at)]))),
    _ => Err(Error::UnregisteredIndex)
}, {
    check(schema_prefix::<project_artifact::ActivationId>(&r.id), "project_artifact_activation_id_check")?;
    check(schema::<project_artifact::ActivationSource>(&r.source), "project_artifact_activation_source_check")?;
    check(session(&r.session_id), "project_artifact_activation_session_check")?;
    check(nonempty(&r.message_id) && nonempty(&r.call_id), "project_artifact_activation_optional_id_check")?;
    check(r.boundary_seq >= 0 && r.activated_at >= 0 && nonnegative(r.deactivated_at), "project_artifact_activation_number_check")
}, tx, { super::operations::owner(tx, &r.version_id, &r.scope_id, &r.kind, &r.artifact_id, None)?; });

table!(ObservationTable, Observation, "project_artifact_observation", {
    id: LosslessString, scope_id: LosslessString, kind: LosslessString, artifact_id: LosslessString, version_id: LosslessString,
    project_id: Option<LosslessString>, session_id: Option<LosslessString>, activation_set_digest: LosslessString, active_artifact_count: i64,
    external_confounded: i64, eligible: i64, terminal_outcome: LosslessString, goal_status: LosslessString, repeat_fix: i64,
    latency_ms: Option<i64>, input_tokens: Option<i64>, output_tokens: Option<i64>, cache_read_tokens: Option<i64>, completed_tool_count: Option<i64>, failed_tool_count: Option<i64>,
    terminal_message_id: Option<LosslessString>, observed_at: i64
}, r, key(&r.id), &[
    IndexDefinition::unique("project_artifact_observation_version_terminal_idx"),
    IndexDefinition::unique("project_artifact_observation_version_session_absent_idx"),
    IndexDefinition::unique("project_artifact_observation_sessionless_absent_idx"),
    IndexDefinition::secondary("project_artifact_observation_version_eligible_observed_idx")
], index, match index.name {
    "project_artifact_observation_version_terminal_idx" => Ok(r.terminal_message_id.as_ref().map(|message| tuple_key(&[KeyPart::String(&r.version_id), KeyPart::String(message)]))),
    "project_artifact_observation_version_session_absent_idx" => Ok(if r.terminal_message_id.is_none() { r.session_id.as_ref().map(|session| tuple_key(&[KeyPart::String(&r.version_id), KeyPart::String(session)])) } else { None }),
    "project_artifact_observation_sessionless_absent_idx" => Ok((r.terminal_message_id.is_none() && r.session_id.is_none()).then(|| key(&r.version_id))),
    "project_artifact_observation_version_eligible_observed_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.version_id), KeyPart::I64(r.eligible), KeyPart::I64(r.observed_at)]))),
    _ => Err(Error::UnregisteredIndex)
}, {
    check(schema_prefix::<project_artifact::ObservationId>(&r.id), "project_artifact_observation_id_check")?;
    check(digest(&r.activation_set_digest), "project_artifact_observation_digest_check")?;
    check(schema::<project_artifact::TerminalOutcome>(&r.terminal_outcome), "project_artifact_observation_terminal_check")?;
    check(schema::<project_artifact::GoalStatus>(&r.goal_status), "project_artifact_observation_goal_check")?;
    check(session(&r.session_id), "project_artifact_observation_session_check")?;
    check(nonempty(&r.terminal_message_id), "project_artifact_observation_message_check")?;
    check([r.external_confounded, r.eligible, r.repeat_fix].into_iter().all(boolean), "project_artifact_observation_boolean_check")?;
    check(r.active_artifact_count >= 0 && r.observed_at >= 0 && [r.latency_ms, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.completed_tool_count, r.failed_tool_count].into_iter().all(nonnegative), "project_artifact_observation_number_check")
}, tx, { super::operations::owner(tx, &r.version_id, &r.scope_id, &r.kind, &r.artifact_id, None)?; });

table!(TerminalTable, Terminal, "project_artifact_terminal", {
    id: LosslessString, project_id: LosslessString, session_id: LosslessString, terminal_message_id: Option<LosslessString>, boundary_seq: i64,
    kind: LosslessString, agent_id: Option<LosslessString>, model_id: LosslessString, goal_mode: i64, managed_activation_count: i64,
    standard_invocation_count: i64, external_confounded: i64, terminal_outcome: LosslessString, goal_status: LosslessString, repeat_fix: i64, observed_at: i64
}, r, key(&r.id), &[
    IndexDefinition::unique("project_artifact_terminal_message_identity_idx"), IndexDefinition::unique("project_artifact_terminal_boundary_identity_idx"),
    IndexDefinition::secondary("project_artifact_terminal_cohort_idx")
], index, match index.name {
    "project_artifact_terminal_message_identity_idx" => Ok(r.terminal_message_id.as_ref().map(|message| tuple_key(&[KeyPart::String(&r.session_id), KeyPart::String(message)]))),
    "project_artifact_terminal_boundary_identity_idx" => Ok(r.terminal_message_id.is_none().then(|| tuple_key(&[KeyPart::String(&r.session_id), KeyPart::I64(r.boundary_seq)]))),
    "project_artifact_terminal_cohort_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.kind), text(&r.agent_id), KeyPart::String(&r.model_id), KeyPart::I64(r.goal_mode), KeyPart::I64(r.observed_at)]))),
    _ => Err(Error::UnregisteredIndex)
}, {
    check(prefixed(&r.id, "pat"), "project_artifact_terminal_id_check")?;
    check(session(&Some(r.session_id.clone())), "project_artifact_terminal_session_check")?;
    check(nonempty(&r.terminal_message_id), "project_artifact_terminal_message_check")?;
    check(!sql_text(&r.model_id).is_empty(), "project_artifact_terminal_model_check")?;
    check(schema::<project_artifact::Kind>(&r.kind), "project_artifact_terminal_kind_check")?;
    check(schema::<project_artifact::TerminalOutcome>(&r.terminal_outcome), "project_artifact_terminal_outcome_check")?;
    check(schema::<project_artifact::GoalStatus>(&r.goal_status), "project_artifact_terminal_goal_check")?;
    check([r.goal_mode, r.external_confounded, r.repeat_fix].into_iter().all(boolean), "project_artifact_terminal_boolean_check")?;
    check([r.boundary_seq, r.managed_activation_count, r.standard_invocation_count, r.observed_at].into_iter().all(|n| n >= 0), "project_artifact_terminal_number_check")
}, tx, { crate::session::codec::require::<crate::project::ProjectTable>(tx, &key(&r.project_id))?; });

table!(FeedbackTable, Feedback, "project_artifact_feedback", {
    id: LosslessString, scope_id: LosslessString, kind: LosslessString, artifact_id: LosslessString, version_id: LosslessString,
    action: LosslessString, actor: LosslessString, time_created: i64
}, r, key(&r.id), &[IndexDefinition::secondary("project_artifact_feedback_version_created_idx")], index,
match index.name { "project_artifact_feedback_version_created_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.version_id), KeyPart::I64(r.time_created)]))), _ => Err(Error::UnregisteredIndex) },
{
    check(prefixed(&r.id, "paf"), "project_artifact_feedback_id_check")?;
    check(schema::<project_artifact::FeedbackAction>(&r.action), "project_artifact_feedback_action_check")?;
    check(schema::<project_artifact::FeedbackActor>(&r.actor), "project_artifact_feedback_actor_check")?;
    check(r.time_created >= 0, "project_artifact_feedback_time_check")
}, tx, { super::operations::owner(tx, &r.version_id, &r.scope_id, &r.kind, &r.artifact_id, None)?; });

table!(WriteTable, AutomaticWrite, "project_artifact_write", {
    scope_id: LosslessString, session_id: LosslessString, insight_digest: LosslessString, operation: LosslessString, result: LosslessString,
    version_id: LosslessString, content_digest: LosslessString, time_created: i64
}, r, tuple_key(&[KeyPart::String(&r.scope_id), KeyPart::String(&r.session_id), KeyPart::String(&r.insight_digest)]), &[
    IndexDefinition::secondary("project_artifact_write_scope_created_idx"), IndexDefinition::secondary("project_artifact_write_session_created_idx")
], index, match index.name {
    "project_artifact_write_scope_created_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.scope_id), KeyPart::I64(r.time_created)]))),
    "project_artifact_write_session_created_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.session_id), KeyPart::I64(r.time_created)]))),
    _ => Err(Error::UnregisteredIndex)
}, {
    check(schema::<project_artifact::AutomaticWriteOperation>(&r.operation), "project_artifact_write_operation_check")?;
    check(schema::<project_artifact::AutomaticWriteResult>(&r.result), "project_artifact_write_result_check")?;
    check(session(&Some(r.session_id.clone())), "project_artifact_write_session_check")?;
    check(digest(&r.insight_digest) && digest(&r.content_digest), "project_artifact_write_digest_check")?;
    check(r.time_created >= 0, "project_artifact_write_time_check")
}, tx, { super::operations::write_references(tx, r)?; });

table!(LegacyCleanupTable, LegacyCleanup, "project_artifact_legacy_cleanup", {
    id: i64, status: LosslessString, cursor: Option<LosslessString>, attempts: i64, removed_count: i64, skipped_count: i64,
    failed_count: i64, error_code: Option<LosslessString>, last_attempt_at: Option<i64>, completed_at: Option<i64>
}, r, tuple_key(&[KeyPart::I64(r.id)]), &[], index, { let _ = (index, r); Err(Error::UnregisteredIndex) },
{
    check(r.id == 1, "project_artifact_legacy_cleanup_singleton_check")?;
    check(matches!(r.status.as_str(), Some("pending" | "partial" | "complete" | "failed")), "project_artifact_legacy_cleanup_status_check")?;
    check([r.attempts, r.removed_count, r.skipped_count, r.failed_count].into_iter().all(|n| n >= 0), "project_artifact_legacy_cleanup_counts_check")?;
    check(nonnegative(r.last_attempt_at) && nonnegative(r.completed_at), "project_artifact_legacy_cleanup_time_check")
}, tx, { let _ = tx; });

table!(MigrationTable, Migration, "migration", { id: LosslessString, time_completed: i64 }, r, key(&r.id), &[], index,
{ let _ = (index, r); Err(Error::UnregisteredIndex) }, Ok::<_, Error>(()), tx, { let _ = tx; });

fn schema<T: DomainDecode>(value: &LosslessString) -> bool {
    T::decode(&JsonValue::String(value.clone())).is_ok()
}
fn sql_text(value: &LosslessString) -> std::borrow::Cow<'_, LosslessString> {
    match value.code_units().position(|unit| unit == 0) {
        Some(count) => std::borrow::Cow::Owned(LosslessString::from_utf16(
            value.code_units().take(count).collect(),
        )),
        None => std::borrow::Cow::Borrowed(value),
    }
}
fn schema_prefix<T: DomainDecode>(value: &LosslessString) -> bool {
    schema::<T>(&sql_text(value))
}
fn digest(value: &LosslessString) -> bool {
    schema_prefix::<project_artifact::Digest>(value)
}
fn optional_digest(value: &Option<LosslessString>) -> bool {
    value.as_ref().is_none_or(digest)
}
fn nonempty(value: &Option<LosslessString>) -> bool {
    value
        .as_ref()
        .is_none_or(|value| !sql_text(value).is_empty())
}
fn storage_id(value: &LosslessString) -> bool {
    schema_prefix::<project_artifact::StorageId>(value)
        && value
            .code_units()
            .all(|unit| !(u16::from(b'A')..=u16::from(b'Z')).contains(&unit))
}
fn artifact_id(value: &LosslessString) -> bool {
    let prefix = sql_text(value);
    if &*prefix == value {
        return schema::<project_artifact::Id>(value);
    }
    prefix.as_str().is_some_and(|s| {
        (1..=64).contains(&s.len())
            && s.bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
            && !s.starts_with('-')
            && !s.ends_with('-')
    })
}
fn prefixed(value: &LosslessString, prefix: &str) -> bool {
    sql_text(value).as_str().is_some_and(|s| {
        s.strip_prefix(prefix)
            .and_then(|s| s.strip_prefix('_'))
            .is_some_and(|s| {
                !s.is_empty()
                    && s.len() <= 60
                    && s.bytes()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
                    && !s.starts_with('-')
                    && !s.ends_with('-')
            })
    })
}
fn session(value: &Option<LosslessString>) -> bool {
    value
        .as_ref()
        .is_none_or(|s| s.code_units().take(3).eq("ses".encode_utf16()))
}
fn boolean(value: i64) -> bool {
    matches!(value, 0 | 1)
}
fn relpath(value: &LosslessString) -> bool {
    sql_text(value).as_str().is_some_and(|s| {
        s.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
            && !s.ends_with('/')
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._/-".contains(&c))
            && !s.split('/').any(|part| matches!(part, "" | "." | ".."))
    })
}

impl Artifact {
    pub fn stage(&self) -> Result<project_artifact::Stage, Error> {
        project_artifact::Stage::decode(&JsonValue::String(self.stage.clone()))
            .map_err(|e| Error::Record(Box::new(e)))
    }
    pub fn kind(&self) -> Result<project_artifact::Kind, Error> {
        project_artifact::Kind::decode(&JsonValue::String(self.kind.clone()))
            .map_err(|e| Error::Record(Box::new(e)))
    }
}
impl Version {
    pub fn provenance(&self) -> Result<project_artifact::Provenance, Error> {
        use ycoding_schema::ObjectEncoder;
        project_artifact::Provenance::decode(
            &ObjectEncoder::new()
                .field("source", &self.source)
                .optional("creatorAgentID", &self.creator_agent_id)
                .optional("creatorSessionID", &self.creator_session_id)
                .optional("insightDigest", &self.insight_digest)
                .optional("originScopeID", &self.origin_scope_id)
                .optional("originVersionID", &self.origin_version_id)
                .optional("originEvidenceDigest", &self.origin_evidence_digest)
                .finish(),
        )
        .map_err(|e| Error::Record(Box::new(e)))
    }
    pub fn state(&self) -> Result<project_artifact::VersionState, Error> {
        project_artifact::VersionState::decode(&JsonValue::String(self.state.clone()))
            .map_err(|e| Error::Record(Box::new(e)))
    }
}

table!(DatabaseFormatTable, DatabaseFormat, "database_format", { id: LosslessString, time_created: i64 }, r, key(&r.id), &[], index,
{ let _ = (index, r); Err(Error::UnregisteredIndex) }, Ok::<_, Error>(()), tx, { let _ = tx; });
