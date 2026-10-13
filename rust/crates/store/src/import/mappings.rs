use super::{DatabaseKind, Error, Progress, TableSummary, checkpoint, digest, read};
use crate::{
    IndexOrder, IndexQuery, Snapshot, Store, TableSpec, Write, artifacts, project, resources,
    session,
};
use rusqlite::Connection;
use std::ops::{Bound, ControlFlow};

type ProgressFn<'a> = &'a mut dyn FnMut(Progress) -> ControlFlow<()>;
pub(super) struct Mapping {
    pub(super) name: &'static str,
    pub(super) columns: &'static [&'static str],
    pub(super) load: fn(&Connection, &Store, ProgressFn<'_>) -> Result<TableSummary, Error>,
    pub(super) validate: fn(&Connection, &Store, ProgressFn<'_>) -> Result<(), Error>,
    pub(super) verify:
        fn(&Connection, &Snapshot, &TableSummary, ProgressFn<'_>) -> Result<(), Error>,
}

macro_rules! column {
    (type_) => {
        "type"
    };
    ($field:ident) => {
        stringify!($field)
    };
}
macro_rules! mapping {
    ($module:ident,$table:ident,$record:ident,$name:literal,{$($field:ident),*}) => {
        Mapping {
            name:$name,
            columns:&[$(column!($field)),*],
            load:|db,store,progress| load::<$module::$table>(db,store,progress,|row| Ok($module::$record { $($field:row.field(column!($field))?),* })),
            validate:|db,store,progress| validate::<$module::$table>(db,store,progress,|row| Ok($module::$record { $($field:row.field(column!($field))?),* }),$module::$table::put),
            verify:|db,snapshot,expected,progress| verify::<$module::$table>(db,snapshot,expected,progress,|row| Ok($module::$record { $($field:row.field(column!($field))?),* })),
        }
    };
}

const BOOTSTRAP: &[Mapping] = &[
    mapping!(artifacts, MigrationTable, Migration, "migration", {id, time_completed}),
    mapping!(artifacts, DatabaseFormatTable, DatabaseFormat, "database_format", {id, time_created}),
];
const CORE: &[Mapping] = &[
    mapping!(project, ProjectTable, Project, "project", {id, worktree, vcs, name, icon_url, icon_url_override, icon_color, time_created, time_updated, time_initialized, sandboxes, commands}),
    mapping!(project, WorkspaceTable, Workspace, "workspace", {id, type_, name, branch, directory, extra, project_id, time_used}),
    mapping!(project, DirectoryTable, Directory, "project_directory", {project_id, directory, type_, strategy, time_created}),
    mapping!(project, PermissionTable, Permission, "permission", {id, project_id, action, resource, time_created, time_updated}),
    mapping!(session, SessionTable, Session, "session", {id, project_id, workspace_id, parent_id, fork_session_id, fork_message_id, fork_seq, directory, path, title, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, revert, permission, autonomy, autonomy_revision, orchestration_revision, agent, model, profile_binding, daybreak, time_created, time_updated, time_archived, time_active, time_pinned, time_suspended}),
    mapping!(session, SequenceTable, Sequence, "event_sequence", {aggregate_id, seq, owner_id}),
    mapping!(session, EventTable, Event, "event", {id, aggregate_id, seq, created, type_, data}),
    mapping!(session, MessageTable, Message, "session_message", {id, session_id, type_, seq, time_created, time_updated, data}),
    mapping!(session, PendingTable, Pending, "session_pending", {id, session_id, type_, data, delivery, admitted_seq, time_created}),
    mapping!(session, TodoTable, Todo, "session_todo", {session_id, content, status, priority, position, time_created, time_updated}),
    mapping!(session, TodoStateTable, TodoState, "session_todo_state", {session_id, revision, digest, time_updated}),
    mapping!(session, FileChangeTable, FileChange, "session_file_change", {session_id, path, patch, additions, deletions, latest_seq}),
    mapping!(session, TaskTable, Task, "session_task", {session_id, parent_id, parent_assistant_message_id, tool_call_id, input_id, description, agent, model, prompt_digest, background, delivery, state, progress, progress_time, question_id, question, question_data, question_time, attempt_started, revision, time_created, time_updated}),
    mapping!(session, NotificationTable, Notification, "session_task_notification", {id, task_session_id, parent_id, type_, revision, excerpt, delivered, time_created, time_delivered}),
    mapping!(session, ManifestTable, Manifest, "compaction_manifest_blob", {digest, schema_version, content, input_tokens, retained_tokens, time_created}),
    mapping!(session, RevisionTable, Revision, "session_context_revision", {session_id, revision, parent_revision, manifest_digest, covered_through_message_id, covered_through_seq, activation_event_id, activation_sequence, time_created}),
    mapping!(session, ContextStateTable, ContextState, "session_context_state", {session_id, status, revision, manifest_digest, covered_through_message_id, covered_through_seq, activated_event_id, time_activated, error_code}),
    mapping!(session, ExclusionTable, Exclusion, "session_context_exclusion", {session_id, context_revision, target_key, target_kind, target_selector, dependency_group, reason, manifest_digest}),
    mapping!(session, JobTable, Job, "session_compaction_job", {id, session_id, legacy_input_id, trigger, requested_through_message_id, requested_through_seq, base_context_revision, target_max_input_tokens, config_digest, status, lease_owner, lease_expires_at, attempts, manifest_digest, error_code, error_message, time_created, time_started, time_ended}),
    mapping!(session, InstructionEntryTable, InstructionEntry, "instruction_entry", {session_id, key, value, removed, time_created, time_updated}),
    mapping!(session, InstructionBlobTable, InstructionBlob, "instruction_blob", {hash, value}),
    mapping!(session, InstructionStateTable, InstructionState, "instruction_state", {session_id, epoch_start, through_seq, initial_values, current_values}),
    mapping!(artifacts, ScopeTable, Scope, "project_artifact_scope", {id, type_, storage_id, time_created, time_updated}),
    mapping!(artifacts, ProjectScopeTable, ProjectScope, "project_artifact_project_scope", {scope_id, project_id}),
    mapping!(artifacts, GlobalScopeTable, GlobalScope, "project_artifact_global_scope", {scope_id, singleton}),
    mapping!(artifacts, ArtifactTable, Artifact, "project_artifact", {scope_id, kind, artifact_id, revision, stage, current_version_id, fallback_version_id, shadowed_scope_id, last_used_at, time_created, time_updated}),
    mapping!(artifacts, VersionTable, Version, "project_artifact_version", {id, scope_id, kind, artifact_id, parent_version_id, state, content_digest, content_relpath, source, creator_agent_id, creator_session_id, insight_digest, origin_scope_id, origin_version_id, origin_evidence_digest, first_qualified_at, last_evaluated_at, last_restored_at, last_governor_transition_at, time_created, time_state_changed}),
    mapping!(artifacts, TrashTable, Trash, "project_artifact_trash", {deletion_id, scope_id, kind, artifact_id, prior_stage, prior_version_id, deleted_at, purge_after}),
    mapping!(artifacts, OperationTable, Operation, "project_artifact_operation", {id, scope_id, kind, artifact_id, operation, request_fingerprint, expected_revision, expected_version_id, expected_digest, source_scope_id, source_version_id, source_digest, target_version_id, target_digest, final_version_id, deletion_id, automatic_session_id, automatic_insight_digest, phase, time_created, time_updated}),
    mapping!(artifacts, ActivationTable, Activation, "project_artifact_activation", {id, scope_id, kind, artifact_id, version_id, project_id, session_id, agent_id, source, message_id, call_id, boundary_seq, activated_at, deactivated_at}),
    mapping!(artifacts, ObservationTable, Observation, "project_artifact_observation", {id, scope_id, kind, artifact_id, version_id, project_id, session_id, activation_set_digest, active_artifact_count, external_confounded, eligible, terminal_outcome, goal_status, repeat_fix, latency_ms, input_tokens, output_tokens, cache_read_tokens, completed_tool_count, failed_tool_count, terminal_message_id, observed_at}),
    mapping!(artifacts, TerminalTable, Terminal, "project_artifact_terminal", {id, project_id, session_id, terminal_message_id, boundary_seq, kind, agent_id, model_id, goal_mode, managed_activation_count, standard_invocation_count, external_confounded, terminal_outcome, goal_status, repeat_fix, observed_at}),
    mapping!(artifacts, FeedbackTable, Feedback, "project_artifact_feedback", {id, scope_id, kind, artifact_id, version_id, action, actor, time_created}),
    mapping!(artifacts, WriteTable, AutomaticWrite, "project_artifact_write", {scope_id, session_id, insight_digest, operation, result, version_id, content_digest, time_created}),
    mapping!(artifacts, LegacyCleanupTable, LegacyCleanup, "project_artifact_legacy_cleanup", {id, status, cursor, attempts, removed_count, skipped_count, failed_count, error_code, last_attempt_at, completed_at}),
    mapping!(artifacts, MigrationTable, Migration, "migration", {id, time_completed}),
    mapping!(artifacts, DatabaseFormatTable, DatabaseFormat, "database_format", {id, time_created}),
    mapping!(resources, CredentialTable, Credential, "credential", {id, integration_id, label, value, connector_id, method_id, active, generation, account_generation, time_created, time_updated}),
    mapping!(resources, KvTable, Kv, "kv", {key, value, time_created, time_updated}),
    mapping!(resources, ShellTable, Shell, "shell", {id, session_id, pid, process_started, owner_pid, owner_started, notice_pending, time_created, time_lost, start_seq}),
    mapping!(resources, ConsentTable, Consent, "telemetry_consent", {id, enabled, notice_version, decided_at}),
    mapping!(resources, MigrationTable, Migration, "data_migration", {name, time_completed}),
    mapping!(resources, ContinuationGenerationTable, ContinuationGeneration, "session_provider_continuation_generation", {session_id, generation, context_revision, time_updated}),
    mapping!(resources, ContinuationTable, Continuation, "session_provider_continuation", {session_id, response_id, represented_through_message_id, represented_message_count, context_revision, continuation_generation, provider, route_id, model_id, variant, connection_identity_digest, prompt_cache_key, instructions_digest, tools_digest, options_digest, volatile_context_digest, continuation_fingerprint, time_updated}),
    mapping!(resources, StateBlobTable, StateBlob, "session_provider_state_blob", {digest, provider, model_id, item_type, content, time_created}),
    mapping!(resources, StateLinkTable, StateLink, "session_provider_state_link", {session_id, message_id, part_ordinal, part_kind, provider, model_id, blob_digest, context_revision, time_created}),
    mapping!(resources, RequestTable, Request, "session_provider_request", {id, session_id, input_id, assistant_message_id, connection_identity_digest, source, agent, model, route_id, prompt_cache_key, system_digest, tool_digest, request, attempts, invalidation, continuation, cache_read_reported, timing, cost, tokens, time_created}),
    mapping!(resources, UsageTable, Usage, "session_usage", {session_id, model_key, model, logical, physical, helpers, continued, fallback, cost, input, output, reasoning, cache_read, cache_write}),
    mapping!(resources, LatencyTable, Latency, "web_latency", {id, received_at, sample}),
];

pub(super) fn tables(kind: DatabaseKind) -> &'static [Mapping] {
    if kind == DatabaseKind::Meeting {
        return super::meeting::TABLES;
    }
    if kind == DatabaseKind::Bootstrap {
        return BOOTSTRAP;
    }
    CORE
}

fn row_error(table: &'static str, row: u64, error: crate::Error) -> Error {
    let reason = match error {
        crate::Error::Domain { kind, message } => format!("{kind}: {message}"),
        crate::Error::UniqueViolation { index } => format!("unique: {index}"),
        crate::Error::Rejected(message) | crate::Error::Incompatible(message) => message.to_owned(),
        crate::Error::Record(_) => "invalid schema document".to_owned(),
        _ => "storage operation failed".to_owned(),
    };
    Error::Row {
        table,
        row,
        column: None,
        reason,
    }
}

fn walk<T: TableSpec>(
    db: &Connection,
    progress: ProgressFn<'_>,
    decode: fn(&read::Row<'_, '_>) -> Result<T::Record, Error>,
    mut consume: impl FnMut(T::Record, u64) -> Result<(), Error>,
) -> Result<TableSummary, Error> {
    let mut query = db.prepare(&format!(
        "SELECT rowid AS _import_rowid,* FROM {} ORDER BY rowid",
        T::NAME
    ))?;
    let mut rows = query.query([])?;
    let mut count = 0u64;
    let mut digest = digest::Digest::new();
    while let Some(row) = rows.next()? {
        count += 1;
        let record = decode(&read::Row {
            value: row,
            table: T::NAME,
            number: count,
        })?;
        digest.record(
            &T::primary_key(&record),
            &T::encode(&record).map_err(|error| row_error(T::NAME, count, error))?,
        );
        consume(record, count)?;
        if count.is_multiple_of(128) {
            checkpoint(
                progress,
                Progress::Rows {
                    table: T::NAME,
                    rows: count,
                },
            )?;
        }
    }
    Ok(TableSummary {
        name: T::NAME.to_owned(),
        rows: i64::try_from(count).map_err(|_| Error::Source("row count overflow"))?,
        digest: digest.finish(),
    })
}

fn write<T: TableSpec>(
    store: &Store,
    batch: Vec<(T::Record, u64)>,
    put: fn(&mut Write<'_>, &T::Record) -> Result<(), crate::Error>,
) -> Result<(), Error>
where
    T::Record: Send + 'static,
{
    store
        .submit(move |tx| {
            for (record, row) in batch {
                put(tx, &record).map_err(|error| {
                    crate::Error::Record(Box::new(row_error(T::NAME, row, error)))
                })?;
            }
            Ok(())
        })?
        .wait()?;
    Ok(())
}

pub(super) fn load<T: TableSpec>(
    db: &Connection,
    store: &Store,
    progress: ProgressFn<'_>,
    decode: fn(&read::Row<'_, '_>) -> Result<T::Record, Error>,
) -> Result<TableSummary, Error>
where
    T::Record: Send + 'static,
{
    let mut batch = Vec::with_capacity(128);
    let put = |tx: &mut Write<'_>, record: &T::Record| {
        if tx.get::<T>(&T::primary_key(record))?.is_some() {
            return Err(tx.reject(crate::Error::Domain {
                kind: "primary_key",
                message: "duplicate source primary identity",
            }));
        }
        tx.put::<T>(record)
    };
    let summary = walk::<T>(db, progress, decode, |record, row| {
        batch.push((record, row));
        if batch.len() == 128 {
            write::<T>(store, std::mem::take(&mut batch), put)?;
        }
        Ok(())
    })?;
    if !batch.is_empty() {
        write::<T>(store, batch, put)?;
    }
    Ok(summary)
}

pub(super) fn validate<T: TableSpec>(
    db: &Connection,
    store: &Store,
    progress: ProgressFn<'_>,
    decode: fn(&read::Row<'_, '_>) -> Result<T::Record, Error>,
    put: fn(&mut Write<'_>, &T::Record) -> Result<(), crate::Error>,
) -> Result<(), Error>
where
    T::Record: Send + 'static,
{
    let mut batch = Vec::with_capacity(128);
    walk::<T>(db, progress, decode, |record, row| {
        batch.push((record, row));
        if batch.len() == 128 {
            write::<T>(store, std::mem::take(&mut batch), put)?;
        }
        Ok(())
    })?;
    if !batch.is_empty() {
        write::<T>(store, batch, put)?;
    }
    Ok(())
}

pub(super) fn verify<T: TableSpec>(
    db: &Connection,
    snapshot: &Snapshot,
    expected: &TableSummary,
    progress: ProgressFn<'_>,
    decode: fn(&read::Row<'_, '_>) -> Result<T::Record, Error>,
) -> Result<(), Error> {
    let mut candidate_digest = digest::Digest::new();
    let mut indexes = vec![0i64; T::INDEXES.len()];
    let source = walk::<T>(db, progress, decode, |record, row| {
        let key = T::primary_key(&record);
        let candidate = snapshot.get::<T>(&key)?.ok_or(Error::Verification {
            table: T::NAME,
            reason: "missing primary identity",
        })?;
        candidate_digest.record(&key, &T::encode(&candidate)?);
        for (i, index) in T::INDEXES.iter().enumerate() {
            if T::index_key(index, &record)
                .map_err(|error| row_error(T::NAME, row, error))?
                .is_some()
            {
                indexes[i] += 1;
            }
        }
        Ok(())
    })?;
    if &source != expected || candidate_digest.finish() != expected.digest {
        return Err(Error::Verification {
            table: T::NAME,
            reason: "semantic digest mismatch",
        });
    }
    let mut after = None;
    let mut count = 0i64;
    loop {
        let page = snapshot.scan::<T>(
            after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            128,
        )?;
        if page.is_empty() {
            break;
        }
        count += page.len() as i64;
        after = page.last().map(T::primary_key);
    }
    if count != expected.rows {
        return Err(Error::Verification {
            table: T::NAME,
            reason: "row count mismatch",
        });
    }
    for (index, expected_count) in T::INDEXES.iter().zip(indexes) {
        let mut cursor = None;
        let mut count = 0i64;
        loop {
            let page = snapshot.index_range::<T>(
                index.name,
                IndexQuery {
                    lower: Bound::Unbounded,
                    upper: Bound::Unbounded,
                    prefix: None,
                    order: IndexOrder::Ascending,
                    after: cursor.as_ref(),
                    limit: 128,
                },
            )?;
            if page.is_empty() {
                break;
            }
            count += page.len() as i64;
            cursor = page.last().map(|entry| entry.cursor.clone());
        }
        if count != expected_count {
            return Err(Error::Verification {
                table: T::NAME,
                reason: "index membership count mismatch",
            });
        }
    }
    Ok(())
}
