use super::{DatabaseKind, Error, Progress, TableSummary, checkpoint, digest, read};
use crate::{
    IndexOrder, IndexQuery, Snapshot, Store, TableSpec, Write, artifacts, model_incident, project,
    resources, session,
};
use rusqlite::Connection;
use std::collections::{BTreeMap, BTreeSet};
use std::ops::{Bound, ControlFlow};
use ycoding_schema::LosslessString;

type ProgressFn<'a> = &'a mut dyn FnMut(Progress) -> ControlFlow<()>;
pub(super) struct Mapping {
    pub(super) name: &'static str,
    pub(super) columns: &'static [&'static str],
    pub(super) reset: fn(&Store) -> Result<(), Error>,
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
            reset: reset::<$module::$table>,
            load:|db,store,progress| load::<$module::$table>(db,store,progress,|row| Ok($module::$record { $($field:row.field(column!($field))?),* })),
            validate:|db,store,progress| validate::<$module::$table>(db,store,progress,|row| Ok($module::$record { $($field:row.field(column!($field))?),* }),$module::$table::put),
            verify:|db,snapshot,expected,progress| verify::<$module::$table>(db,snapshot,expected,progress,|row| Ok($module::$record { $($field:row.field(column!($field))?),* })),
        }
    };
}

pub(super) const ANALYTICS_MIGRATION: &str = "20261015122915_usage-analytics";
pub(super) const FACTS: &str = "usage_analytics_request";
pub(super) const BACKFILL: &str = "usage_analytics_request_backfill";

type FactTable = resources::UsageAnalyticsRequestTable;

pub(super) const INCIDENT_MIGRATION: &str = "20261016080907_model-incident";
pub(super) const INCIDENT_TABLES: [&str; 2] = ["model_incident", "model_guidance_clear"];

macro_rules! incident_mapping {
    ($table:ident, $record:ident, $name:literal, {$($field:ident),*}) => {
        Mapping {
            name: $name,
            columns: &[$(stringify!($field)),*],
            reset: reset::<model_incident::$table>,
            load: |db, store, progress| {
                if incidents_migrated(db)? {
                    return load::<model_incident::$table>(db, store, progress, |row| Ok(model_incident::$record { $($field: row.field(stringify!($field))?),* }));
                }
                load_with::<model_incident::$table>(store, |_| Ok(absent($name)))
            },
            validate: |db, store, progress| {
                if incidents_migrated(db)? {
                    return validate::<model_incident::$table>(db, store, progress, |row| Ok(model_incident::$record { $($field: row.field(stringify!($field))?),* }), model_incident::$table::put);
                }
                Ok(())
            },
            verify: |db, snapshot, expected, progress| {
                if incidents_migrated(db)? {
                    return verify::<model_incident::$table>(db, snapshot, expected, progress, |row| Ok(model_incident::$record { $($field: row.field(stringify!($field))?),* }));
                }
                verify_with::<model_incident::$table>(snapshot, expected, |_| Ok(absent($name)))
            },
        }
    };
}

fn absent(name: &str) -> TableSummary {
    TableSummary {
        name: name.to_owned(),
        rows: 0,
        digest: digest::Digest::new().finish(),
    }
}

const FACTS_MAPPING: Mapping = Mapping {
    name: FACTS,
    columns: &[
        "id",
        "session_id",
        "project_id",
        "directory",
        "workspace_id",
        "session_updated",
        "agent",
        "source",
        "model",
        "usage_anchor",
        "task_path",
        "request",
        "attempts",
        "continuation",
        "invalidation",
        "prompt_cache_key",
        "cache_read_reported",
        "tokens",
        "cost",
        "timing",
        "time_created",
    ],
    reset: reset::<FactTable>,
    load: load_facts,
    validate: validate_facts,
    verify: verify_facts,
};

const BOOTSTRAP: &[Mapping] = &[
    mapping!(artifacts, MigrationTable, Migration, "migration", {id, time_completed}),
    mapping!(artifacts, DatabaseFormatTable, DatabaseFormat, "database_format", {id, time_created}),
];
const CORE: &[Mapping] = &[
    mapping!(project, ProjectTable, Project, "project", {id, worktree, vcs, name, icon_url, icon_url_override, icon_color, time_created, time_updated, time_initialized, sandboxes, commands}),
    mapping!(project, WorkspaceTable, Workspace, "workspace", {id, type_, name, branch, directory, extra, project_id, time_used}),
    mapping!(project, DirectoryTable, Directory, "project_directory", {project_id, directory, type_, strategy, time_created}),
    mapping!(project, PermissionTable, Permission, "permission", {id, project_id, action, resource, time_created, time_updated}),
    mapping!(session, SessionTable, Session, "session", {id, project_id, workspace_id, parent_id, fork_session_id, fork_message_id, fork_seq, directory, path, title, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, revert, permission, autonomy, autonomy_revision, orchestration_revision, agent, model, profile_binding, daybreak, time_created, time_updated, time_archived, time_active, time_pinned, time_suspended, usage_pruned_through}),
    mapping!(session, SequenceTable, Sequence, "event_sequence", {aggregate_id, seq, owner_id}),
    mapping!(session, EventTable, Event, "event", {id, aggregate_id, seq, created, type_, data}),
    mapping!(session, MessageTable, Message, "session_message", {id, session_id, type_, seq, time_created, time_updated, data}),
    mapping!(session, PendingTable, Pending, "session_pending", {id, session_id, type_, data, delivery, admitted_seq, time_created}),
    mapping!(session, TodoTable, Todo, "session_todo", {session_id, content, status, priority, position, time_created, time_updated}),
    mapping!(session, TodoStateTable, TodoState, "session_todo_state", {session_id, revision, digest, time_updated}),
    mapping!(session, FileChangeTable, FileChange, "session_file_change", {session_id, path, patch, additions, deletions, latest_seq}),
    mapping!(session, TaskTable, Task, "session_task", {session_id, parent_id, parent_assistant_message_id, tool_call_id, input_id, description, agent, model, prompt_digest, background, delivery, state, progress, progress_time, question_id, question, question_data, question_time, attempt_started, owner_pid, owner_started, revision, time_created, time_updated, usage_anchor}),
    mapping!(session, NotificationTable, Notification, "session_task_notification", {id, task_session_id, parent_id, type_, revision, excerpt, delivered, time_created, time_delivered}),
    mapping!(session, ManifestTable, Manifest, "compaction_manifest_blob", {digest, schema_version, content, input_tokens, retained_tokens, time_created}),
    mapping!(session, RevisionTable, Revision, "session_context_revision", {session_id, revision, parent_revision, manifest_digest, covered_through_message_id, covered_through_seq, activation_event_id, activation_sequence, time_created}),
    mapping!(session, ContextStateTable, ContextState, "session_context_state", {session_id, status, revision, manifest_digest, covered_through_message_id, covered_through_seq, activated_event_id, time_activated, error_code}),
    mapping!(session, ExclusionTable, Exclusion, "session_context_exclusion", {session_id, context_revision, target_key, target_kind, target_selector, dependency_group, reason, manifest_digest}),
    mapping!(session, JobTable, Job, "session_compaction_job", {id, session_id, legacy_input_id, trigger, requested_through_message_id, requested_through_seq, base_context_revision, target_max_input_tokens, config_digest, status, lease_owner, lease_expires_at, attempts, manifest_digest, error_code, error_message, time_created, time_started, time_ended, usage_anchor}),
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
    mapping!(resources, RequestTable, Request, "session_provider_request", {id, session_id, input_id, assistant_message_id, connection_identity_digest, source, agent, model, route_id, prompt_cache_key, system_digest, tool_digest, request, attempts, invalidation, continuation, cache_read_reported, timing, cost, tokens, time_created, usage_anchor}),
    FACTS_MAPPING,
    mapping!(resources, UsageTable, Usage, "session_usage", {session_id, model_key, model, logical, physical, helpers, continued, fallback, cost, input, output, reasoning, cache_read, cache_write}),
    mapping!(resources, LatencyTable, Latency, "web_latency", {id, received_at, sample}),
    incident_mapping!(IncidentTable, Incident, "model_incident", {id, time_created, kind, provider_id, model_id, variant, profile, agent, project_id, session_id, request_id, category, rule_ids, target, decided_by}),
    incident_mapping!(GuidanceClearTable, GuidanceClear, "model_guidance_clear", {provider_id, model_id, cleared_at}),
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

pub(super) fn task_owner_migrated(db: &Connection) -> Result<bool, Error> {
    migrated(db, "20261014011041_task-owner")
}

pub(super) fn analytics_migrated(db: &Connection) -> Result<bool, Error> {
    migrated(db, ANALYTICS_MIGRATION)
}

pub(super) fn incidents_migrated(db: &Connection) -> Result<bool, Error> {
    migrated(db, INCIDENT_MIGRATION)
}

fn migrated(db: &Connection, id: &str) -> Result<bool, Error> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM migration WHERE id = ?1)",
        [id],
        |row| row.get(0),
    )?)
}

pub(super) fn missing_columns(
    db: &Connection,
    table: &str,
) -> Result<&'static [&'static str], Error> {
    Ok(match table {
        "session_task" => match (task_owner_migrated(db)?, analytics_migrated(db)?) {
            (true, true) => &[],
            (true, false) => &["usage_anchor"],
            (false, true) => &["owner_pid", "owner_started"],
            (false, false) => &["owner_pid", "owner_started", "usage_anchor"],
        },
        "session_compaction_job" | "session_provider_request" if !analytics_migrated(db)? => {
            &["usage_anchor"]
        }
        "session" if !analytics_migrated(db)? => &["usage_pruned_through"],
        _ => &[],
    })
}

fn walk<T: TableSpec>(
    db: &Connection,
    progress: ProgressFn<'_>,
    decode: fn(&read::Row<'_, '_>) -> Result<T::Record, Error>,
    mut consume: impl FnMut(T::Record, u64) -> Result<(), Error>,
) -> Result<TableSummary, Error> {
    let columns = ["*".to_owned()]
        .into_iter()
        .chain(
            missing_columns(db, T::NAME)?
                .iter()
                .map(|column| format!("NULL AS {column}")),
        )
        .collect::<Vec<_>>()
        .join(", ");
    let mut query = db.prepare(&format!(
        "SELECT rowid AS _import_rowid,{columns} FROM {} ORDER BY rowid",
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

type Consume<'a, T> = &'a mut dyn FnMut(<T as TableSpec>::Record, u64) -> Result<(), Error>;

pub(super) fn load<T: TableSpec>(
    db: &Connection,
    store: &Store,
    progress: ProgressFn<'_>,
    decode: fn(&read::Row<'_, '_>) -> Result<T::Record, Error>,
) -> Result<TableSummary, Error>
where
    T::Record: Send + 'static,
{
    load_with::<T>(store, |consume| walk::<T>(db, progress, decode, consume))
}

fn load_with<T: TableSpec>(
    store: &Store,
    walker: impl FnOnce(Consume<'_, T>) -> Result<TableSummary, Error>,
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
    let summary = walker(&mut |record, row| {
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

pub(super) fn reset<T: TableSpec>(store: &Store) -> Result<(), Error> {
    loop {
        let removed = store
            .submit(|tx| {
                let rows = tx.scan::<T>(Bound::Unbounded, Bound::Unbounded, 128)?;
                for row in &rows {
                    tx.delete::<T>(&T::primary_key(row))?;
                }
                Ok(rows.len())
            })?
            .wait()?;
        if removed == 0 {
            return Ok(());
        }
    }
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
    validate_with::<T>(store, put, |consume| {
        walk::<T>(db, progress, decode, consume).map(|_| ())
    })
}

fn validate_with<T: TableSpec>(
    store: &Store,
    put: fn(&mut Write<'_>, &T::Record) -> Result<(), crate::Error>,
    walker: impl FnOnce(Consume<'_, T>) -> Result<(), Error>,
) -> Result<(), Error>
where
    T::Record: Send + 'static,
{
    let mut batch = Vec::with_capacity(128);
    walker(&mut |record, row| {
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
    verify_with::<T>(snapshot, expected, |consume| {
        walk::<T>(db, progress, decode, consume)
    })
}

fn verify_with<T: TableSpec>(
    snapshot: &Snapshot,
    expected: &TableSummary,
    walker: impl FnOnce(Consume<'_, T>) -> Result<TableSummary, Error>,
) -> Result<(), Error> {
    let mut candidate_digest = digest::Digest::new();
    let mut indexes = vec![0i64; T::INDEXES.len()];
    let source = walker(&mut |record, row| {
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

fn decode_fact(row: &read::Row<'_, '_>) -> Result<resources::UsageAnalyticsRequest, Error> {
    Ok(resources::UsageAnalyticsRequest {
        id: row.field("id")?,
        session_id: row.field("session_id")?,
        project_id: row.field("project_id")?,
        directory: row.field("directory")?,
        workspace_id: row.field("workspace_id")?,
        session_updated: row.field("session_updated")?,
        agent: row.field("agent")?,
        source: row.field("source")?,
        model: row.field("model")?,
        usage_anchor: row.field("usage_anchor")?,
        task_path: row.field("task_path")?,
        request: row.field("request")?,
        attempts: row.field("attempts")?,
        continuation: row.field("continuation")?,
        invalidation: row.field("invalidation")?,
        prompt_cache_key: row.field("prompt_cache_key")?,
        cache_read_reported: row.field("cache_read_reported")?,
        tokens: row.field("tokens")?,
        cost: row.field("cost")?,
        timing: row.field("timing")?,
        time_created: row.field("time_created")?,
    })
}

fn load_facts(
    db: &Connection,
    store: &Store,
    progress: ProgressFn<'_>,
) -> Result<TableSummary, Error> {
    if analytics_migrated(db)? {
        return load::<FactTable>(db, store, progress, decode_fact);
    }
    load_with::<FactTable>(store, |consume| backfill(db, progress, consume))
}

fn validate_facts(db: &Connection, store: &Store, progress: ProgressFn<'_>) -> Result<(), Error> {
    if analytics_migrated(db)? {
        return validate::<FactTable>(db, store, progress, decode_fact, FactTable::put);
    }
    validate_with::<FactTable>(store, FactTable::put, |consume| {
        backfill(db, progress, consume).map(|_| ())
    })
}

fn verify_facts(
    db: &Connection,
    snapshot: &Snapshot,
    expected: &TableSummary,
    progress: ProgressFn<'_>,
) -> Result<(), Error> {
    if analytics_migrated(db)? {
        return verify::<FactTable>(db, snapshot, expected, progress, decode_fact);
    }
    verify_with::<FactTable>(snapshot, expected, |consume| {
        backfill(db, progress, consume)
    })
}

const BACKFILL_QUERY: &str = "SELECT r.id AS id, r.session_id AS session_id, s.project_id AS project_id,
    s.directory AS directory, s.workspace_id AS workspace_id, s.time_updated AS session_updated,
    r.agent AS agent, r.source AS source, r.model AS model, r.request AS request,
    r.attempts AS attempts, r.continuation AS continuation, r.invalidation AS invalidation,
    substr(r.prompt_cache_key, 1, 8) AS prompt_cache_key, r.cache_read_reported AS cache_read_reported,
    r.tokens AS tokens, r.cost AS cost, r.timing AS timing, r.time_created AS time_created
    FROM session_provider_request r JOIN session s ON s.id = r.session_id
    ORDER BY r.session_id, r.request";

fn backfill(
    db: &Connection,
    progress: ProgressFn<'_>,
    consume: Consume<'_, FactTable>,
) -> Result<TableSummary, Error> {
    let parents = db
        .prepare("SELECT id, parent_id FROM session")?
        .query_map([], |row| {
            Ok((
                LosslessString::from(row.get::<_, String>(0)?),
                row.get::<_, Option<String>>(1)?.map(LosslessString::from),
            ))
        })?
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    let tasks = db
        .prepare("SELECT session_id FROM session_task")?
        .query_map([], |row| row.get::<_, String>(0).map(LosslessString::from))?
        .collect::<Result<BTreeSet<_>, _>>()?;
    let mut query = db.prepare(BACKFILL_QUERY)?;
    let mut rows = query.query([])?;
    let mut count = 0u64;
    let mut digest = digest::Digest::new();
    while let Some(row) = rows.next()? {
        count += 1;
        let row = read::Row {
            value: row,
            table: BACKFILL,
            number: count,
        };
        let session_id: LosslessString = row.field("session_id")?;
        let task_path = task_path(&session_id, &parents, &tasks)?;
        let record = resources::UsageAnalyticsRequest {
            id: row.field("id")?,
            project_id: row.field("project_id")?,
            directory: row.field("directory")?,
            workspace_id: row.field("workspace_id")?,
            session_updated: row.field("session_updated")?,
            agent: row.field("agent")?,
            source: row.field("source")?,
            model: row.field("model")?,
            usage_anchor: None,
            task_path: session::Document::from_domain(&task_path)
                .map_err(|error| row_error(BACKFILL, count, error))?,
            request: row.field("request")?,
            attempts: row.field("attempts")?,
            continuation: row.field("continuation")?,
            invalidation: row.field("invalidation")?,
            prompt_cache_key: row.field("prompt_cache_key")?,
            cache_read_reported: row.field("cache_read_reported")?,
            tokens: row.field("tokens")?,
            cost: row.field("cost")?,
            timing: row.field("timing")?,
            time_created: row.field("time_created")?,
            session_id,
        };
        digest.record(
            &FactTable::primary_key(&record),
            &FactTable::encode(&record).map_err(|error| row_error(BACKFILL, count, error))?,
        );
        consume(record, count)?;
        if count.is_multiple_of(128) {
            checkpoint(
                progress,
                Progress::Rows {
                    table: BACKFILL,
                    rows: count,
                },
            )?;
        }
    }
    Ok(TableSummary {
        name: BACKFILL.to_owned(),
        rows: i64::try_from(count).map_err(|_| Error::Source("row count overflow"))?,
        digest: digest.finish(),
    })
}

fn task_path(
    session: &LosslessString,
    parents: &BTreeMap<LosslessString, Option<LosslessString>>,
    tasks: &BTreeSet<LosslessString>,
) -> Result<Vec<LosslessString>, Error> {
    let mut path = Vec::new();
    let mut seen = BTreeSet::new();
    let mut current = Some(session.clone());
    while let Some(id) = current {
        if !seen.insert(id.clone()) {
            return Err(Error::Source("Session ancestry contains a cycle"));
        }
        if tasks.contains(&id) {
            path.push(id.clone());
        }
        current = parents.get(&id).cloned().flatten();
    }
    Ok(path)
}
