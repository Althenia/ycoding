use super::codec::{
    Document, boundary, check, digest, integer, key, nonempty, nonnegative, optional_digest,
    require, table, text,
};
use crate::{Error, IndexDefinition, KeyPart, tuple_key};
use ycoding_schema::{
    JsonValue, LosslessString, domain, instruction, model, permission, session_event,
    session_revert, usage_anchor,
};

table!(SessionTable, Session, "session", {
    id: LosslessString, project_id: LosslessString, workspace_id: Option<LosslessString>, parent_id: Option<LosslessString>,
    fork_session_id: Option<LosslessString>, fork_message_id: Option<LosslessString>, fork_seq: Option<i64>, directory: LosslessString,
    path: Option<LosslessString>, title: LosslessString, cost: f64, tokens_input: i64, tokens_output: i64, tokens_reasoning: i64,
    tokens_cache_read: i64, tokens_cache_write: i64, revert: Option<Document<session_revert::Revert>>,
    permission: Option<Document<permission::Ruleset>>, autonomy: Option<JsonValue>, autonomy_revision: i64, orchestration_revision: i64,
    agent: Option<LosslessString>, model: Option<Document<model::Ref>>, profile_binding: Option<Document<session_event::ProfileBinding>>,
    daybreak: Option<LosslessString>, time_created: i64, time_updated: i64, time_archived: Option<i64>, time_active: Option<i64>,
    time_pinned: Option<i64>, time_suspended: Option<i64>, usage_pruned_through: Option<i64>
}, r, key(&r.id), &[
    IndexDefinition::secondary("session_project_idx"), IndexDefinition::secondary("session_workspace_idx"),
    IndexDefinition::secondary("session_parent_idx"), IndexDefinition::secondary("session_time_suspended_idx")
], index, match index.name {
    "session_project_idx" => Ok(Some(key(&r.project_id))),
    "session_workspace_idx" => Ok(Some(tuple_key(&[text(&r.workspace_id)]))),
    "session_parent_idx" => Ok(Some(tuple_key(&[text(&r.parent_id)]))),
    "session_time_suspended_idx" => Ok(r.time_suspended.map(|value| tuple_key(&[KeyPart::I64(value)]))),
    _ => Err(Error::UnregisteredIndex)
}, Ok::<_, Error>(()), tx, {
    require::<crate::project::ProjectTable>(tx, &key(&r.project_id))?;
    crate::resources::source_changed(tx, "session", key(&r.id), false)?;
});

table!(SequenceTable, Sequence, "event_sequence", {
    aggregate_id: LosslessString, seq: i64, owner_id: Option<LosslessString>
}, r, key(&r.aggregate_id), &[], index, { let _ = (index, r); Err(Error::UnregisteredIndex) }, Ok::<_, Error>(()), tx, { let _ = tx; });

table!(EventTable, Event, "event", {
    id: LosslessString, aggregate_id: LosslessString, seq: i64, created: i64, type_: LosslessString, data: JsonValue
}, r, key(&r.id), &[
    IndexDefinition::unique("event_aggregate_seq_idx"), IndexDefinition::secondary("event_aggregate_type_seq_idx")
], index, match index.name {
    "event_aggregate_seq_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.aggregate_id), KeyPart::I64(r.seq)]))),
    "event_aggregate_type_seq_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.aggregate_id), KeyPart::String(&r.type_), KeyPart::I64(r.seq)]))),
    _ => Err(Error::UnregisteredIndex)
}, Ok::<_, Error>(()), tx, { require::<SequenceTable>(tx, &key(&r.aggregate_id))?; });

table!(MessageTable, Message, "session_message", {
    id: LosslessString, session_id: LosslessString, type_: LosslessString, seq: i64, time_created: i64, time_updated: i64, data: JsonValue
}, r, key(&r.id), &[
    IndexDefinition::unique("session_message_session_seq_idx"), IndexDefinition::secondary("session_message_session_type_seq_idx"),
    IndexDefinition::secondary("session_message_session_time_created_id_idx"), IndexDefinition::secondary("session_message_time_created_idx")
], index, match index.name {
    "session_message_session_seq_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.session_id), KeyPart::I64(r.seq)]))),
    "session_message_session_type_seq_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.session_id), KeyPart::String(&r.type_), KeyPart::I64(r.seq)]))),
    "session_message_session_time_created_id_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.session_id), KeyPart::I64(r.time_created), KeyPart::String(&r.id)]))),
    "session_message_time_created_idx" => Ok(Some(tuple_key(&[KeyPart::I64(r.time_created)]))),
    _ => Err(Error::UnregisteredIndex)
}, Ok::<_, Error>(()), tx, { require::<SessionTable>(tx, &key(&r.session_id))?; });

impl Message {
    pub fn info(&self) -> Result<ycoding_schema::session_message::Info, Error> {
        let JsonValue::Object(mut value) = self.data.clone() else {
            return Err(Error::Rejected("message data must be an object"));
        };
        value.insert("id".into(), JsonValue::String(self.id.clone()));
        value.insert("type".into(), JsonValue::String(self.type_.clone()));
        <ycoding_schema::session_message::Info as ycoding_schema::DomainDecode>::decode(
            &JsonValue::Object(value),
        )
        .map_err(|error| Error::Record(Box::new(error)))
    }
}

table!(PendingTable, Pending, "session_pending", {
    id: LosslessString, session_id: LosslessString, type_: LosslessString, data: JsonValue, delivery: Option<LosslessString>, admitted_seq: i64, time_created: i64
}, r, key(&r.id), &[
    IndexDefinition::secondary("session_pending_session_delivery_seq_idx"), IndexDefinition::unique("session_pending_session_admitted_seq_idx")
], index, match index.name {
    "session_pending_session_delivery_seq_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.session_id), text(&r.delivery), KeyPart::I64(r.admitted_seq)]))),
    "session_pending_session_admitted_seq_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.session_id), KeyPart::I64(r.admitted_seq)]))),
    _ => Err(Error::UnregisteredIndex)
}, Ok::<_, Error>(()), tx, { require::<SessionTable>(tx, &key(&r.session_id))?; });

impl Pending {
    pub fn info(&self) -> Result<ycoding_schema::session_pending::LegacyInfo, Error> {
        use ycoding_schema::ObjectEncoder;
        let value = ObjectEncoder::new()
            .field("id", &self.id)
            .field("sessionID", &self.session_id)
            .field("type", &self.type_)
            .field("admittedSeq", &(self.admitted_seq as f64))
            .field("timeCreated", &(self.time_created as f64))
            .field("data", &self.data)
            .optional("delivery", &self.delivery)
            .finish();
        <ycoding_schema::session_pending::LegacyInfo as ycoding_schema::DomainDecode>::decode(
            &value,
        )
        .map_err(|error| Error::Record(Box::new(error)))
    }
}

table!(TodoTable, Todo, "session_todo", {
    session_id: LosslessString, content: LosslessString, status: LosslessString, priority: LosslessString, position: i64, time_created: i64, time_updated: i64
}, r, tuple_key(&[KeyPart::String(&r.session_id), KeyPart::I64(r.position)]), &[IndexDefinition::secondary("session_todo_session_idx")], index,
match index.name { "session_todo_session_idx" => Ok(Some(key(&r.session_id))), _ => Err(Error::UnregisteredIndex) },
Ok::<_, Error>(()), tx, { require::<SessionTable>(tx, &key(&r.session_id))?; });

table!(TodoStateTable, TodoState, "session_todo_state", {
    session_id: LosslessString, revision: i64, digest: LosslessString, time_updated: i64
}, r, key(&r.session_id), &[], index, { let _ = (index, r); Err(Error::UnregisteredIndex) }, {
    check(r.revision >= 0, "session_todo_state_revision_check")?;
    check(digest(&r.digest), "session_todo_state_digest_check")?;
    check(r.time_updated >= 0, "session_todo_state_time_check")
}, tx, { require::<SessionTable>(tx, &key(&r.session_id))?; });

table!(FileChangeTable, FileChange, "session_file_change", {
    session_id: LosslessString, path: LosslessString, patch: LosslessString, additions: i64, deletions: i64, latest_seq: i64
}, r, tuple_key(&[KeyPart::String(&r.session_id), KeyPart::String(&r.path)]), &[IndexDefinition::secondary("session_file_change_path_session_idx")], index,
match index.name { "session_file_change_path_session_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.path), KeyPart::String(&r.session_id)]))), _ => Err(Error::UnregisteredIndex) },
Ok::<_, Error>(()), tx, { require::<SessionTable>(tx, &key(&r.session_id))?; });

table!(TaskTable, Task, "session_task", {
    session_id: LosslessString, parent_id: LosslessString, parent_assistant_message_id: LosslessString, tool_call_id: LosslessString,
    input_id: LosslessString, description: LosslessString, agent: LosslessString, model: Document<model::Ref>, prompt_digest: LosslessString,
    background: i64, delivery: LosslessString, state: LosslessString, progress: Option<LosslessString>, progress_time: Option<i64>,
    question_id: Option<LosslessString>, question: Option<LosslessString>, question_data: Option<Document<domain::Json>>, question_time: Option<i64>,
    attempt_started: i64, owner_pid: Option<i64>, owner_started: Option<LosslessString>, revision: i64, time_created: i64, time_updated: i64,
    usage_anchor: Option<Document<usage_anchor::Ref>>
}, r, key(&r.session_id), &[
    IndexDefinition::unique("sqlite_autoindex_session_task_2"), IndexDefinition::unique("session_task_launch_identity_idx"),
    IndexDefinition::secondary("session_task_parent_state_updated_idx")
], index, match index.name {
    "sqlite_autoindex_session_task_2" => Ok(Some(key(&r.input_id))),
    "session_task_launch_identity_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.parent_id), KeyPart::String(&r.parent_assistant_message_id), KeyPart::String(&r.tool_call_id)]))),
    "session_task_parent_state_updated_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.parent_id), KeyPart::String(&r.state), KeyPart::I64(r.time_updated)]))),
    _ => Err(Error::UnregisteredIndex)
}, Ok::<_, Error>(()), tx, {
    require::<SessionTable>(tx, &key(&r.session_id))?;
    require::<SessionTable>(tx, &key(&r.parent_id))?;
    crate::resources::source_changed(tx, "task", key(&r.session_id), false)?;
});

table!(NotificationTable, Notification, "session_task_notification", {
    id: LosslessString, task_session_id: LosslessString, parent_id: LosslessString, type_: LosslessString, revision: i64,
    excerpt: Option<LosslessString>, delivered: i64, time_created: i64, time_delivered: Option<i64>
}, r, key(&r.id), &[
    IndexDefinition::unique("session_task_notification_transition_idx"), IndexDefinition::secondary("session_task_notification_delivery_idx")
], index, match index.name {
    "session_task_notification_transition_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.task_session_id), KeyPart::String(&r.type_), KeyPart::I64(r.revision)]))),
    "session_task_notification_delivery_idx" => Ok(Some(tuple_key(&[KeyPart::I64(r.delivered), KeyPart::I64(r.time_created), KeyPart::String(&r.id)]))),
    _ => Err(Error::UnregisteredIndex)
}, Ok::<_, Error>(()), tx, {
    require::<TaskTable>(tx, &key(&r.task_session_id))?;
    require::<SessionTable>(tx, &key(&r.parent_id))?;
});

table!(ManifestTable, Manifest, "compaction_manifest_blob", {
    digest: LosslessString, schema_version: i64, content: Document<domain::Json>, input_tokens: i64, retained_tokens: i64, time_created: i64
}, r, key(&r.digest), &[], index, { let _ = (index, r); Err(Error::UnregisteredIndex) }, {
    check(digest(&r.digest), "compaction_manifest_blob_digest_check")?;
    check(r.schema_version > 0, "compaction_manifest_blob_schema_version_check")?;
    check(r.input_tokens >= 0 && r.retained_tokens >= 0, "compaction_manifest_blob_counts_check")?;
    check(r.time_created >= 0, "compaction_manifest_blob_time_check")
}, tx, { let _ = tx; });

table!(RevisionTable, Revision, "session_context_revision", {
    session_id: LosslessString, revision: i64, parent_revision: Option<i64>, manifest_digest: Option<LosslessString>,
    covered_through_message_id: Option<LosslessString>, covered_through_seq: Option<i64>, activation_event_id: Option<LosslessString>, activation_sequence: Option<i64>, time_created: i64
}, r, tuple_key(&[KeyPart::String(&r.session_id), KeyPart::I64(r.revision)]), &[], index, { let _ = (index, r); Err(Error::UnregisteredIndex) }, {
    check((r.revision == 0 && r.parent_revision.is_none()) || (r.revision > 0 && r.parent_revision.is_none_or(|parent| parent == r.revision - 1)), "session_context_revision_lineage_check")?;
    check(optional_digest(&r.manifest_digest), "session_context_revision_manifest_check")?;
    check(boundary(&r.covered_through_message_id, r.covered_through_seq), "session_context_revision_boundary_check")?;
    check(boundary(&r.activation_event_id, r.activation_sequence), "session_context_revision_activation_check")?;
    check(r.time_created >= 0, "session_context_revision_time_check")
}, tx, {
    require::<SessionTable>(tx, &key(&r.session_id))?;
    if let Some(parent) = r.parent_revision { require::<RevisionTable>(tx, &tuple_key(&[KeyPart::String(&r.session_id), KeyPart::I64(parent)]))?; }
    if let Some(manifest) = &r.manifest_digest { require::<ManifestTable>(tx, &key(manifest))?; }
});

table!(ContextStateTable, ContextState, "session_context_state", {
    session_id: LosslessString, status: LosslessString, revision: i64, manifest_digest: Option<LosslessString>,
    covered_through_message_id: Option<LosslessString>, covered_through_seq: Option<i64>, activated_event_id: Option<LosslessString>, time_activated: Option<i64>, error_code: Option<LosslessString>
}, r, key(&r.session_id), &[], index, { let _ = (index, r); Err(Error::UnregisteredIndex) }, {
    check(matches!(r.status.as_str(), Some("active" | "quarantined")), "session_context_state_status_check")?;
    check(r.revision >= 0, "session_context_state_revision_check")?;
    check(optional_digest(&r.manifest_digest), "session_context_state_manifest_check")?;
    check(boundary(&r.covered_through_message_id, r.covered_through_seq), "session_context_state_boundary_check")?;
    check(boundary(&r.activated_event_id, r.time_activated), "session_context_state_activation_check")?;
    check((r.status.as_str() == Some("active") && r.error_code.is_none()) || (r.status.as_str() == Some("quarantined") && nonempty(&r.error_code)), "session_context_state_error_check")
}, tx, {
    require::<SessionTable>(tx, &key(&r.session_id))?;
    require::<RevisionTable>(tx, &tuple_key(&[KeyPart::String(&r.session_id), KeyPart::I64(r.revision)]))?;
    if let Some(manifest) = &r.manifest_digest { require::<ManifestTable>(tx, &key(manifest))?; }
});

table!(ExclusionTable, Exclusion, "session_context_exclusion", {
    session_id: LosslessString, context_revision: i64, target_key: LosslessString, target_kind: LosslessString, target_selector: Document<domain::Json>,
    dependency_group: Option<LosslessString>, reason: LosslessString, manifest_digest: LosslessString
}, r, tuple_key(&[KeyPart::String(&r.session_id), KeyPart::I64(r.context_revision), KeyPart::String(&r.target_key)]), &[
    IndexDefinition::unique("session_context_exclusion_current_target_idx"), IndexDefinition::secondary("session_context_exclusion_manifest_idx")
], index, match index.name {
    "session_context_exclusion_current_target_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.session_id), KeyPart::String(&r.target_key)]))),
    "session_context_exclusion_manifest_idx" => Ok(Some(key(&r.manifest_digest))), _ => Err(Error::UnregisteredIndex)
}, {
    check(digest(&r.target_key), "session_context_exclusion_target_key_check")?;
    check(matches!(r.target_kind.as_str(), Some("message" | "part" | "provider_state")), "session_context_exclusion_target_kind_check")?;
    check(nonempty(&r.dependency_group), "session_context_exclusion_dependency_check")?;
    check(matches!(r.reason.as_str(), Some("exact_duplicate" | "superseded_authority" | "terminal_intermediate" | "stale_tool_result" | "provider_rebase")), "session_context_exclusion_reason_check")?;
    check(digest(&r.manifest_digest), "session_context_exclusion_manifest_check")
}, tx, {
    require::<SessionTable>(tx, &key(&r.session_id))?;
    require::<RevisionTable>(tx, &tuple_key(&[KeyPart::String(&r.session_id), KeyPart::I64(r.context_revision)]))?;
    require::<ManifestTable>(tx, &key(&r.manifest_digest))?;
});

table!(JobTable, Job, "session_compaction_job", {
    id: LosslessString, session_id: LosslessString, legacy_input_id: Option<LosslessString>, trigger: LosslessString,
    requested_through_message_id: LosslessString, requested_through_seq: i64, base_context_revision: i64, target_max_input_tokens: Option<i64>,
    config_digest: Option<LosslessString>, status: LosslessString, lease_owner: Option<LosslessString>, lease_expires_at: Option<i64>, attempts: i64,
    manifest_digest: Option<LosslessString>, error_code: Option<LosslessString>, error_message: Option<LosslessString>, time_created: i64, time_started: Option<i64>, time_ended: Option<i64>,
    usage_anchor: Option<Document<usage_anchor::Ref>>
}, r, key(&r.id), &[
    IndexDefinition::unique("session_compaction_job_pending_revision_idx"), IndexDefinition::unique("session_compaction_job_legacy_input_idx"),
    IndexDefinition::secondary("session_compaction_job_recovery_idx"), IndexDefinition::secondary("session_compaction_job_manifest_idx")
], index, match index.name {
    "session_compaction_job_pending_revision_idx" => Ok((r.status.as_str() == Some("pending")).then(|| tuple_key(&[KeyPart::String(&r.session_id), KeyPart::I64(r.base_context_revision)]))),
    "session_compaction_job_legacy_input_idx" => Ok(r.legacy_input_id.as_ref().map(key)),
    "session_compaction_job_recovery_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.status), integer(r.lease_expires_at), KeyPart::String(&r.session_id)]))),
    "session_compaction_job_manifest_idx" => Ok(Some(tuple_key(&[text(&r.manifest_digest)]))), _ => Err(Error::UnregisteredIndex)
}, validate_job(r), tx, {
    require::<SessionTable>(tx, &key(&r.session_id))?;
    require::<RevisionTable>(tx, &tuple_key(&[KeyPart::String(&r.session_id), KeyPart::I64(r.base_context_revision)]))?;
    if let Some(manifest) = &r.manifest_digest { require::<ManifestTable>(tx, &key(manifest))?; }
});

fn validate_job(r: &Job) -> Result<(), Error> {
    check(
        r.id.code_units().take(4).eq("cmp_".encode_utf16()) && r.id.len() > 4,
        "session_compaction_job_id_check",
    )?;
    check(
        nonempty(&r.legacy_input_id),
        "session_compaction_job_legacy_input_check",
    )?;
    check(
        matches!(
            r.trigger.as_str(),
            Some("consider" | "advised" | "mandatory" | "manual")
        ),
        "session_compaction_job_trigger_check",
    )?;
    check(
        !r.requested_through_message_id.is_empty(),
        "session_compaction_job_requested_message_check",
    )?;
    check(
        r.requested_through_seq >= 0
            && r.base_context_revision >= 0
            && nonnegative(r.target_max_input_tokens)
            && r.attempts >= 0,
        "session_compaction_job_counts_check",
    )?;
    check(
        optional_digest(&r.config_digest),
        "session_compaction_job_config_digest_check",
    )?;
    check(
        optional_digest(&r.manifest_digest),
        "session_compaction_job_manifest_digest_check",
    )?;
    check(
        r.legacy_input_id.is_some()
            || (r.target_max_input_tokens.is_some() && r.config_digest.is_some()),
        "session_compaction_job_current_input_check",
    )?;
    check(
        matches!(
            r.status.as_str(),
            Some("pending" | "running" | "ended" | "failed")
        ),
        "session_compaction_job_status_check",
    )?;
    check(
        (r.lease_owner.is_none() && r.lease_expires_at.is_none())
            || (nonempty(&r.lease_owner) && r.lease_expires_at.is_some_and(|value| value >= 0)),
        "session_compaction_job_lease_check",
    )?;
    let valid = match r.status.as_str() {
        Some("pending") => {
            r.lease_owner.is_none()
                && r.time_started.is_none()
                && r.time_ended.is_none()
                && r.manifest_digest.is_none()
                && r.error_code.is_none()
                && r.error_message.is_none()
        }
        Some("running") => {
            r.lease_owner.is_some()
                && r.time_started.is_some()
                && r.time_ended.is_none()
                && r.manifest_digest.is_none()
                && r.error_code.is_none()
                && r.error_message.is_none()
        }
        Some("ended") => {
            r.lease_owner.is_none()
                && r.time_started.is_some()
                && r.time_ended.is_some()
                && r.manifest_digest.is_some()
                && r.error_code.is_none()
                && r.error_message.is_none()
        }
        Some("failed") => {
            r.lease_owner.is_none()
                && r.time_ended.is_some()
                && r.manifest_digest.is_none()
                && r.error_code.is_some()
        }
        _ => false,
    };
    check(valid, "session_compaction_job_terminal_check")?;
    check(
        r.time_created >= 0 && nonnegative(r.time_started) && nonnegative(r.time_ended),
        "session_compaction_job_time_check",
    )
}

table!(InstructionEntryTable, InstructionEntry, "instruction_entry", {
    session_id: LosslessString, key: LosslessString, value: Option<Document<domain::Json>>, removed: i64, time_created: i64, time_updated: i64
}, r, tuple_key(&[KeyPart::String(&r.session_id), KeyPart::String(&r.key)]), &[], index, { let _ = (index, r); Err(Error::UnregisteredIndex) }, Ok::<_, Error>(()), tx, {
    require::<SessionTable>(tx, &key(&r.session_id))?;
});
table!(InstructionBlobTable, InstructionBlob, "instruction_blob", {
    hash: LosslessString, value: Option<Document<domain::Json>>
}, r, key(&r.hash), &[], index, { let _ = (index, r); Err(Error::UnregisteredIndex) }, Ok::<_, Error>(()), tx, { let _ = tx; });
table!(InstructionStateTable, InstructionState, "instruction_state", {
    session_id: LosslessString, epoch_start: i64, through_seq: i64, initial_values: Document<instruction::Values>, current_values: Document<instruction::Values>
}, r, key(&r.session_id), &[], index, { let _ = (index, r); Err(Error::UnregisteredIndex) }, Ok::<_, Error>(()), tx, {
    require::<SessionTable>(tx, &key(&r.session_id))?;
});
