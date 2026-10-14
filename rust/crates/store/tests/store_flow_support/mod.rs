use std::ops::Bound;
use std::path::{Path, PathBuf};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonObject, JsonValue, LosslessString, parse_json, stringify_json,
};
use ycoding_store::{
    IndexOrder, IndexQuery, Snapshot, TableSpec, artifacts, meeting, project, resources, session,
};

pub struct Baseline(pub PathBuf);

impl Baseline {
    pub fn produce() -> Self {
        let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let mut child = std::process::Command::new("bun")
            .arg("script/rust-parity/producer.ts")
            .current_dir(repository)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            use std::io::Read;
            let mut out = String::new();
            stdout.take(1_048_576).read_to_string(&mut out).unwrap();
            sender.send(out).unwrap();
        });
        let errors = std::thread::spawn(move || {
            use std::io::Read;
            let mut out = String::new();
            stderr.take(1_048_576).read_to_string(&mut out).unwrap();
            out
        });
        let result = receiver.recv_timeout(std::time::Duration::from_secs(150));
        if result.is_err() {
            child.kill().unwrap();
        }
        let status = child.wait().unwrap();
        reader.join().unwrap();
        let error = errors.join().unwrap();
        assert!(status.success(), "baseline producer: {status}: {error}");
        let root = PathBuf::from(result.unwrap().trim());
        assert!(
            root.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("ycoding-rust-baseline-")
        );
        assert!(root.join("provenance.json").is_file());
        rusqlite::Connection::open(root.join("data/core.sqlite"))
            .unwrap()
            .execute_batch(
                "ALTER TABLE session_task ADD owner_pid integer;
                 ALTER TABLE session_task ADD owner_started text;
                 UPDATE session_task SET owner_pid = 123, owner_started = 'Wed Oct 14 01:02:03 2026';",
            )
            .unwrap();
        let JsonValue::Object(mut provenance) =
            parse_json(&std::fs::read_to_string(root.join("provenance.json")).unwrap()).unwrap()
        else {
            panic!("provenance must be an object")
        };
        let JsonValue::Array(mut files) = provenance.get(&"files".into()).unwrap().clone() else {
            panic!("provenance files must be an array")
        };
        files.retain(|file| {
            let JsonValue::Object(file) = file else {
                panic!("file provenance must be an object")
            };
            let Some(JsonValue::String(name)) = file.get(&"file".into()) else {
                panic!("file name must be a string")
            };
            !matches!(
                name.as_str(),
                Some("data/core.sqlite-wal" | "data/core.sqlite-shm")
            ) || root.join(name.as_str().unwrap()).is_file()
        });
        for file in &mut files {
            let JsonValue::Object(file) = file else {
                panic!("file provenance must be an object")
            };
            let Some(JsonValue::String(name)) = file.get(&"file".into()) else {
                panic!("file name must be a string")
            };
            if matches!(
                name.as_str(),
                Some("data/core.sqlite" | "data/core.sqlite-wal" | "data/core.sqlite-shm")
            ) {
                let (digest, bytes) =
                    ycoding_store::import::file_fingerprint(&root.join(name.as_str().unwrap()))
                        .unwrap();
                file.insert("sha256".into(), JsonValue::String(digest.into()));
                file.insert("bytes".into(), JsonValue::Number(bytes as f64));
            }
        }
        provenance.insert("files".into(), JsonValue::Array(files));
        std::fs::write(
            root.join("provenance.json"),
            stringify_json(&JsonValue::Object(provenance)),
        )
        .unwrap();
        Self(root)
    }

    pub fn core(&self) -> PathBuf {
        self.0.join("data/core.sqlite")
    }

    pub fn expected(&self, domain: &str) -> JsonValue {
        let JsonValue::Object(export) =
            parse_json(&std::fs::read_to_string(self.0.join("semantic-export.json")).unwrap())
                .unwrap()
        else {
            panic!("baseline export must be an object")
        };
        let mut value = export.get(&domain.into()).unwrap().clone();
        if domain == "core" {
            let JsonValue::Object(tables) = &mut value else {
                panic!("core export must be an object")
            };
            let JsonValue::Array(mut tasks) = tables.get(&"session_task".into()).unwrap().clone()
            else {
                panic!("tasks must be an array")
            };
            for task in &mut tasks {
                let JsonValue::Object(fields) = task else {
                    panic!("task must be an object")
                };
                fields.insert("owner_pid".into(), 123i64.cell());
                fields.insert(
                    "owner_started".into(),
                    JsonValue::String("Wed Oct 14 01:02:03 2026".into()),
                );
            }
            tables.insert("session_task".into(), JsonValue::Array(tasks));
        }
        value
    }
}

impl Drop for Baseline {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

trait Cell {
    fn cell(&self) -> JsonValue;
}

impl Cell for i64 {
    fn cell(&self) -> JsonValue {
        object([("sqliteInteger", JsonValue::String(self.to_string().into()))])
    }
}

impl Cell for f64 {
    fn cell(&self) -> JsonValue {
        JsonValue::Number(*self)
    }
}

impl Cell for LosslessString {
    fn cell(&self) -> JsonValue {
        JsonValue::String(self.clone())
    }
}

impl Cell for JsonValue {
    fn cell(&self) -> JsonValue {
        JsonValue::String(stringify_json(self).into())
    }
}

impl<T: DomainDecode + DomainEncode> Cell for session::Document<T> {
    fn cell(&self) -> JsonValue {
        self.value().cell()
    }
}

impl Cell for resources::Secret {
    fn cell(&self) -> JsonValue {
        self.value().cell()
    }
}

impl<T: Cell> Cell for Option<T> {
    fn cell(&self) -> JsonValue {
        self.as_ref().map_or(JsonValue::Null, Cell::cell)
    }
}

impl Cell for Vec<LosslessString> {
    fn cell(&self) -> JsonValue {
        JsonValue::String(
            stringify_json(&JsonValue::Array(
                self.iter().cloned().map(JsonValue::String).collect(),
            ))
            .into(),
        )
    }
}

fn object<const N: usize>(entries: [(&str, JsonValue); N]) -> JsonValue {
    let mut result = JsonObject::new();
    for (key, value) in entries {
        result.insert(key.into(), value);
    }
    JsonValue::Object(result)
}

fn canonical(value: &JsonValue) -> JsonValue {
    match value {
        JsonValue::Object(fields) => {
            let mut sorted = fields.iter().collect::<Vec<_>>();
            sorted.sort_by(|left, right| left.0.cmp(&right.0));
            let mut result = JsonObject::new();
            for (key, child) in sorted {
                result.insert(key.clone(), canonical(child));
            }
            JsonValue::Object(result)
        }
        JsonValue::Array(values) => JsonValue::Array(values.iter().map(canonical).collect()),
        value => value.clone(),
    }
}

pub fn logical_tables(value: &JsonValue) -> JsonValue {
    let JsonValue::Object(tables) = value else {
        panic!("table export must be an object")
    };
    let mut result = JsonObject::new();
    for (name, rows) in tables.iter() {
        let JsonValue::Array(rows) = rows else {
            panic!("table rows must be an array")
        };
        let mut rows = rows
            .iter()
            .map(|row| {
                let JsonValue::Object(fields) = row else {
                    panic!("row must be an object")
                };
                let mut result = JsonObject::new();
                for (name, value) in fields.iter() {
                    let cell = match value {
                        JsonValue::String(text) => text
                            .as_str()
                            .and_then(|text| parse_json(text).ok())
                            .map_or_else(
                                || value.clone(),
                                |value| object([("jsonText", canonical(&value))]),
                            ),
                        value => canonical(value),
                    };
                    result.insert(name.clone(), cell);
                }
                canonical(&JsonValue::Object(result))
            })
            .collect::<Vec<_>>();
        rows.sort_by_key(stringify_json);
        result.insert(name.clone(), JsonValue::Array(rows));
    }
    canonical(&JsonValue::Object(result))
}

fn rows<T: TableSpec>(snapshot: &Snapshot, export: impl Fn(&T::Record) -> JsonValue) -> JsonValue {
    let rows = snapshot
        .scan::<T>(Bound::Unbounded, Bound::Unbounded, 10_000)
        .unwrap();
    for row in &rows {
        assert_eq!(
            export(&snapshot.get::<T>(&T::primary_key(row)).unwrap().unwrap()),
            export(row),
            "{} primary consumer",
            T::NAME
        );
    }
    for index in T::INDEXES {
        let mut actual = snapshot
            .index_range::<T>(
                index.name,
                IndexQuery {
                    lower: Bound::Unbounded,
                    upper: Bound::Unbounded,
                    prefix: None,
                    order: IndexOrder::Ascending,
                    after: None,
                    limit: 10_000,
                },
            )
            .unwrap()
            .iter()
            .map(|entry| canonical(&export(&entry.record)))
            .collect::<Vec<_>>();
        let mut expected = rows
            .iter()
            .filter(|row| T::index_key(index, row).unwrap().is_some())
            .map(|row| canonical(&export(row)))
            .collect::<Vec<_>>();
        actual.sort_by_key(stringify_json);
        expected.sort_by_key(stringify_json);
        assert_eq!(actual, expected, "{} index {}", T::NAME, index.name);
    }
    JsonValue::Array(rows.iter().map(export).collect())
}

pub fn core_export(snapshot: &Snapshot) -> JsonValue {
    let mut result = JsonObject::new();
    macro_rules! table {
        ($module:ident, $table:ident, {$($field:ident),*}) => {
            result.insert(<$module::$table>::NAME.into(), rows::<$module::$table>(snapshot, |row| {
                let mut fields = JsonObject::new();
                $(fields.insert(if stringify!($field) == "type_" { "type" } else { stringify!($field) }.into(), row.$field.cell());)*
                JsonValue::Object(fields)
            }));
        };
    }
    table!(project, ProjectTable, {id, worktree, vcs, name, icon_url, icon_url_override, icon_color, time_created, time_updated, time_initialized, sandboxes, commands});
    table!(project, WorkspaceTable, {id, type_, name, branch, directory, extra, project_id, time_used});
    table!(project, DirectoryTable, {project_id, directory, type_, strategy, time_created});
    table!(project, PermissionTable, {id, project_id, action, resource, time_created, time_updated});
    table!(session, SessionTable, {id, project_id, workspace_id, parent_id, fork_session_id, fork_message_id, fork_seq, directory, path, title, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, revert, permission, autonomy, autonomy_revision, orchestration_revision, agent, model, profile_binding, daybreak, time_created, time_updated, time_archived, time_active, time_pinned, time_suspended});
    table!(session, SequenceTable, {aggregate_id, seq, owner_id});
    table!(session, EventTable, {id, aggregate_id, seq, created, type_, data});
    table!(session, MessageTable, {id, session_id, type_, seq, time_created, time_updated, data});
    table!(session, PendingTable, {id, session_id, type_, data, delivery, admitted_seq, time_created});
    table!(session, TodoTable, {session_id, content, status, priority, position, time_created, time_updated});
    table!(session, TodoStateTable, {session_id, revision, digest, time_updated});
    table!(session, FileChangeTable, {session_id, path, patch, additions, deletions, latest_seq});
    table!(session, TaskTable, {session_id, parent_id, parent_assistant_message_id, tool_call_id, input_id, description, agent, model, prompt_digest, background, delivery, state, progress, progress_time, question_id, question, question_data, question_time, attempt_started, owner_pid, owner_started, revision, time_created, time_updated});
    table!(session, NotificationTable, {id, task_session_id, parent_id, type_, revision, excerpt, delivered, time_created, time_delivered});
    table!(session, ManifestTable, {digest, schema_version, content, input_tokens, retained_tokens, time_created});
    table!(session, RevisionTable, {session_id, revision, parent_revision, manifest_digest, covered_through_message_id, covered_through_seq, activation_event_id, activation_sequence, time_created});
    table!(session, ContextStateTable, {session_id, status, revision, manifest_digest, covered_through_message_id, covered_through_seq, activated_event_id, time_activated, error_code});
    table!(session, ExclusionTable, {session_id, context_revision, target_key, target_kind, target_selector, dependency_group, reason, manifest_digest});
    table!(session, JobTable, {id, session_id, legacy_input_id, trigger, requested_through_message_id, requested_through_seq, base_context_revision, target_max_input_tokens, config_digest, status, lease_owner, lease_expires_at, attempts, manifest_digest, error_code, error_message, time_created, time_started, time_ended});
    table!(session, InstructionEntryTable, {session_id, key, value, removed, time_created, time_updated});
    table!(session, InstructionBlobTable, {hash, value});
    table!(session, InstructionStateTable, {session_id, epoch_start, through_seq, initial_values, current_values});
    table!(artifacts, ScopeTable, {id, type_, storage_id, time_created, time_updated});
    result.insert(
        artifacts::ProjectScopeTable::NAME.into(),
        rows::<artifacts::ProjectScopeTable>(snapshot, |row| {
            object([
                ("scope_id", row.scope_id.cell()),
                ("project_id", row.project_id.cell()),
                (
                    "scope_type",
                    snapshot
                        .get::<artifacts::ScopeTable>(&ycoding_store::tuple_key(&[
                            ycoding_store::KeyPart::String(&row.scope_id),
                        ]))
                        .unwrap()
                        .unwrap()
                        .type_
                        .cell(),
                ),
            ])
        }),
    );
    result.insert(
        artifacts::GlobalScopeTable::NAME.into(),
        rows::<artifacts::GlobalScopeTable>(snapshot, |row| {
            object([
                ("scope_id", row.scope_id.cell()),
                ("singleton", row.singleton.cell()),
                (
                    "scope_type",
                    snapshot
                        .get::<artifacts::ScopeTable>(&ycoding_store::tuple_key(&[
                            ycoding_store::KeyPart::String(&row.scope_id),
                        ]))
                        .unwrap()
                        .unwrap()
                        .type_
                        .cell(),
                ),
            ])
        }),
    );
    table!(artifacts, ArtifactTable, {scope_id, kind, artifact_id, revision, stage, current_version_id, fallback_version_id, shadowed_scope_id, last_used_at, time_created, time_updated});
    table!(artifacts, VersionTable, {id, scope_id, kind, artifact_id, parent_version_id, state, content_digest, content_relpath, source, creator_agent_id, creator_session_id, insight_digest, origin_scope_id, origin_version_id, origin_evidence_digest, first_qualified_at, last_evaluated_at, last_restored_at, last_governor_transition_at, time_created, time_state_changed});
    table!(artifacts, TrashTable, {deletion_id, scope_id, kind, artifact_id, prior_stage, prior_version_id, deleted_at, purge_after});
    table!(artifacts, OperationTable, {id, scope_id, kind, artifact_id, operation, request_fingerprint, expected_revision, expected_version_id, expected_digest, source_scope_id, source_version_id, source_digest, target_version_id, target_digest, final_version_id, deletion_id, automatic_session_id, automatic_insight_digest, phase, time_created, time_updated});
    table!(artifacts, ActivationTable, {id, scope_id, kind, artifact_id, version_id, project_id, session_id, agent_id, source, message_id, call_id, boundary_seq, activated_at, deactivated_at});
    table!(artifacts, ObservationTable, {id, scope_id, kind, artifact_id, version_id, project_id, session_id, activation_set_digest, active_artifact_count, external_confounded, eligible, terminal_outcome, goal_status, repeat_fix, latency_ms, input_tokens, output_tokens, cache_read_tokens, completed_tool_count, failed_tool_count, terminal_message_id, observed_at});
    table!(artifacts, TerminalTable, {id, project_id, session_id, terminal_message_id, boundary_seq, kind, agent_id, model_id, goal_mode, managed_activation_count, standard_invocation_count, external_confounded, terminal_outcome, goal_status, repeat_fix, observed_at});
    table!(artifacts, FeedbackTable, {id, scope_id, kind, artifact_id, version_id, action, actor, time_created});
    table!(artifacts, WriteTable, {scope_id, session_id, insight_digest, operation, result, version_id, content_digest, time_created});
    table!(artifacts, LegacyCleanupTable, {id, status, cursor, attempts, removed_count, skipped_count, failed_count, error_code, last_attempt_at, completed_at});
    table!(artifacts, MigrationTable, {id, time_completed});
    table!(artifacts, DatabaseFormatTable, {id, time_created});
    table!(resources, CredentialTable, {id, integration_id, label, value, connector_id, method_id, active, generation, account_generation, time_created, time_updated});
    table!(resources, KvTable, {key, value, time_created, time_updated});
    table!(resources, ShellTable, {id, session_id, pid, process_started, owner_pid, owner_started, notice_pending, time_created, time_lost, start_seq});
    table!(resources, ConsentTable, {id, enabled, notice_version, decided_at});
    table!(resources, MigrationTable, {name, time_completed});
    table!(resources, ContinuationGenerationTable, {session_id, generation, context_revision, time_updated});
    table!(resources, ContinuationTable, {session_id, response_id, represented_through_message_id, represented_message_count, context_revision, continuation_generation, provider, route_id, model_id, variant, connection_identity_digest, prompt_cache_key, instructions_digest, tools_digest, options_digest, volatile_context_digest, continuation_fingerprint, time_updated});
    table!(resources, StateBlobTable, {digest, provider, model_id, item_type, content, time_created});
    table!(resources, StateLinkTable, {session_id, message_id, part_ordinal, part_kind, provider, model_id, blob_digest, context_revision, time_created});
    table!(resources, RequestTable, {id, session_id, input_id, assistant_message_id, connection_identity_digest, source, agent, model, route_id, prompt_cache_key, system_digest, tool_digest, request, attempts, invalidation, continuation, cache_read_reported, timing, cost, tokens, time_created});
    table!(resources, UsageTable, {session_id, model_key, model, logical, physical, helpers, continued, fallback, cost, input, output, reasoning, cache_read, cache_write});
    table!(resources, LatencyTable, {id, received_at, sample});
    JsonValue::Object(result)
}

pub fn meeting_export(snapshot: &Snapshot) -> JsonValue {
    let mut result = JsonObject::new();
    macro_rules! table {
        ($table:ident, {$($field:ident),*}) => {
            result.insert(<meeting::$table>::NAME.into(), rows::<meeting::$table>(snapshot, |row| {
                let mut fields = JsonObject::new();
                $(fields.insert(stringify!($field).into(), row.$field.cell());)*
                JsonValue::Object(fields)
            }));
        };
    }
    table!(MeetingTable, {id, data});
    table!(SegmentTable, {id, meeting_id, sequence, state, original_text, data});
    table!(ReferenceTable, {meeting_id, server, target, data});
    table!(FindingTable, {id, meeting_id, data});
    table!(CheckpointTable, {id, meeting_id, data});
    table!(ProposalTable, {id, meeting_id, data});
    table!(PlanTable, {id, meeting_id, data});
    table!(ApprovalTable, {id, meeting_id, data});
    table!(JobTable, {id, meeting_id, data});
    JsonValue::Object(result)
}
