use std::convert::Infallible;
use std::io::{BufRead, BufReader, Read, Write};
use std::ops::{Bound, ControlFlow};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use ycoding_core::resources::project_artifact::{
    adapter,
    filesystem::{Hooks, Mutation},
    package,
    source_registry::Registry,
    store,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, parse_json, project, project_artifact,
    session,
};
use ycoding_store::import::{self, DatabaseKind, Request};
use ycoding_store::{Metadata, Options, Store, artifacts};

const T0: i64 = 1_700_000_000_000;
const SCOPE: &str = "pas_base";
const STORAGE: &str = "00000000-0000-4000-8000-000000000061";
const OTHER_SCOPE: &str = "pas_other";
const OTHER_STORAGE: &str = "00000000-0000-4000-8000-000000000062";
const SETTLED_V1: &str = "pav_settled-v1";
const SETTLED_V1_BODY: &str = "Settled first version body.";

#[derive(Clone, Copy, PartialEq)]
enum Crash {
    Filesystem,
    RedbOpen,
    RedbCommitted,
}

struct Case {
    artifact: &'static str,
    version: &'static str,
    operation: &'static str,
    session: &'static str,
    body: &'static str,
    crash: Option<Crash>,
    update: bool,
}

const CASES: [Case; 5] = [
    Case {
        artifact: "crash-fs",
        version: "pav_crash-fs",
        operation: "pop_crash-fs",
        session: "ses_acct",
        body: "Filesystem phase crash body.",
        crash: Some(Crash::Filesystem),
        update: false,
    },
    Case {
        artifact: "crash-redb-open",
        version: "pav_crash-redb-open",
        operation: "pop_crash-redb-open",
        session: "ses_acct",
        body: "Open redb transaction crash body.",
        crash: Some(Crash::RedbOpen),
        update: false,
    },
    Case {
        artifact: "crash-redb-done",
        version: "pav_crash-redb-done",
        operation: "pop_crash-redb-done",
        session: "ses_acct",
        body: "Committed redb journal crash body.",
        crash: Some(Crash::RedbCommitted),
        update: false,
    },
    Case {
        artifact: "settled",
        version: "pav_settled-v2",
        operation: "pop_settled-update",
        session: "ses_upd",
        body: "Settled second version body.",
        crash: Some(Crash::Filesystem),
        update: true,
    },
    Case {
        artifact: "orphan-create",
        version: "pav_orphan-create",
        operation: "pop_orphan-create",
        session: "ses_orphan",
        body: "Orphan journal body.",
        crash: None,
        update: false,
    },
];
const AVAILABLE_ORPHAN: (&str, &str, &str) =
    ("other-orphan", "pav_other-orphan", "pop_other-available");

impl Case {
    fn definition(&self, body: &str) -> project_artifact::Definition {
        project_artifact::Definition::decode(
            &parse_json(&format!(
                r#"{{"kind":"skill","name":"{}","description":"Recovery fixture","content":"{body}"}}"#,
                self.artifact
            ))
            .unwrap(),
        )
        .unwrap()
    }
    fn content(&self) -> LosslessString {
        adapter::render(&self.definition(self.body))
    }
    fn insight(&self) -> LosslessString {
        digest(&format!("insight-{}", self.operation))
    }
}

fn digest(text: &str) -> LosslessString {
    package::sha256(&text.into()).as_lossless().clone()
}

fn id<T: DomainDecode>(text: &str) -> T {
    T::decode(&JsonValue::String(text.into())).unwrap()
}

fn project_id(text: &str) -> project::Id {
    id(text)
}

fn schema_sql() -> String {
    let source = include_str!("../../../../packages/core/src/database/schema.gen.ts");
    let delimiters = source
        .match_indices('`')
        .filter_map(|(at, _)| (at == 0 || source.as_bytes()[at - 1] != b'\\').then_some(at))
        .collect::<Vec<_>>();
    assert!(delimiters.as_chunks::<2>().1.is_empty());
    delimiters
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| source[pair[0] + 1..pair[1]].replace("\\`", "`"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn baseline_sql() -> String {
    let mut sql = schema_sql();
    sql.push_str(
        "ALTER TABLE session_task ADD owner_pid integer;
         ALTER TABLE session_task ADD owner_started text;
         CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);
         CREATE TABLE database_format (id TEXT PRIMARY KEY, time_created INTEGER NOT NULL);
         INSERT INTO migration VALUES ('baseline', -9223372036854775808);
         INSERT INTO migration VALUES ('20261014011041_task-owner', 1);
         INSERT INTO database_format VALUES ('current-2026-08-04', 9223372036854775807);",
    );
    sql.push_str(&format!(
        "INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES ('prj_base','/baseline',1,1,'[]');
         INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES ('prj_other','/other',1,1,'[]');
         INSERT INTO project_artifact_scope VALUES ('{SCOPE}','project','{STORAGE}',0,0);
         INSERT INTO project_artifact_project_scope (scope_id,project_id) VALUES ('{SCOPE}','prj_base');
         INSERT INTO project_artifact_scope VALUES ('{OTHER_SCOPE}','project','{OTHER_STORAGE}',0,0);
         INSERT INTO project_artifact_project_scope (scope_id,project_id) VALUES ('{OTHER_SCOPE}','prj_other');"
    ));
    let v1 = digest_of(CASES[3].artifact, SETTLED_V1_BODY);
    sql.push_str(&format!(
        "BEGIN; PRAGMA defer_foreign_keys=ON;
         INSERT INTO project_artifact VALUES ('{SCOPE}','skill','settled',0,'trial','{SETTLED_V1}',NULL,NULL,NULL,0,0);
         INSERT INTO project_artifact_version (id,scope_id,kind,artifact_id,state,content_digest,content_relpath,source,time_created,time_state_changed)
           VALUES ('{SETTLED_V1}','{SCOPE}','skill','settled','trial','{v1}','SKILL.md','user',0,0);
         COMMIT;"
    ));
    for case in &CASES {
        let target = text(&package::sha256(&case.content()).as_lossless().clone());
        let expected = if case.update {
            format!("0,'{SETTLED_V1}','{v1}'")
        } else {
            "NULL,NULL,NULL".to_owned()
        };
        sql.push_str(&format!(
            "INSERT INTO project_artifact_operation (id,scope_id,kind,artifact_id,operation,request_fingerprint,expected_revision,expected_version_id,expected_digest,target_version_id,target_digest,automatic_session_id,automatic_insight_digest,phase,time_created,time_updated)
             VALUES ('{}','{SCOPE}','skill','{}','{}','{}',{expected},'{}','{target}','{}','{}','preparing',{T0},{T0});",
            case.operation,
            case.artifact,
            if case.update { "update" } else { "create" },
            text(&digest(&format!("request-{}", case.operation))),
            case.version,
            case.session,
            text(&case.insight()),
        ));
    }
    let (artifact, version, operation) = AVAILABLE_ORPHAN;
    let orphan = digest_of(artifact, "Available orphan body.");
    sql.push_str(&format!(
        "INSERT INTO project_artifact_operation (id,scope_id,kind,artifact_id,operation,request_fingerprint,target_version_id,target_digest,phase,time_created,time_updated)
         VALUES ('{operation}','{OTHER_SCOPE}','skill','{artifact}','create','{}','{version}','{orphan}','available',{T0},{T0});",
        text(&digest("request-available-orphan")),
    ));
    sql
}

fn digest_of(artifact: &str, body: &str) -> String {
    let definition = project_artifact::Definition::decode(
        &parse_json(&format!(
            r#"{{"kind":"skill","name":"{artifact}","description":"Recovery fixture","content":"{body}"}}"#
        ))
        .unwrap(),
    )
    .unwrap();
    text(package::sha256(&adapter::render(&definition)).as_lossless())
}

fn text(value: &LosslessString) -> String {
    value.as_str().unwrap().to_owned()
}

struct Layout(PathBuf);
impl Layout {
    fn candidate(&self) -> PathBuf {
        self.0.join("candidate.redb")
    }
    fn data(&self) -> PathBuf {
        self.0.join("data")
    }
    fn scope_root(&self, storage: &project_artifact::StorageId) -> PathBuf {
        self.data()
            .join("project-artifacts")
            .join(storage.as_lossless().as_str().unwrap())
    }
    fn open(&self) -> Store {
        Store::open(
            self.candidate(),
            Options::core(),
            import::catalog(DatabaseKind::Core),
        )
        .unwrap()
    }
    fn service(&self, store: &Store) -> store::Service {
        store::Service::new(
            store.client(),
            store::Paths {
                data: self.data(),
                home: self.0.join("home"),
                config: self.0.join("config"),
            },
            Arc::new(Mutex::new(Registry::default())),
        )
    }
}

struct Fixture(Layout);
impl Fixture {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "ycoding-report-flow-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        Self(Layout(root))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0.0).unwrap();
    }
}

fn create_baseline(layout: &Layout) -> PathBuf {
    let sql = layout.0.join("baseline.sql");
    let database = layout.0.join("baseline.sqlite");
    std::fs::write(&sql, baseline_sql()).unwrap();
    let status = std::process::Command::new("bun")
        .args([
            "-e",
            r#"const { Database } = require("bun:sqlite"); const db = new Database(process.env.BASELINE_DB, { create: true }); db.exec(require("fs").readFileSync(process.env.BASELINE_SQL, "utf8")); db.close()"#,
        ])
        .env("BASELINE_DB", &database)
        .env("BASELINE_SQL", &sql)
        .status()
        .unwrap();
    assert!(status.success());
    database
}

#[derive(Debug, PartialEq)]
struct Journal {
    operations: Vec<artifacts::Operation>,
    artifacts: Vec<artifacts::Artifact>,
    versions: Vec<artifacts::Version>,
    writes: Vec<artifacts::AutomaticWrite>,
}
impl Journal {
    fn take(store: &Store) -> Self {
        let snapshot = store.snapshot().unwrap();
        let scan = |snapshot: &ycoding_store::Snapshot| {
            (
                snapshot
                    .scan::<artifacts::OperationTable>(Bound::Unbounded, Bound::Unbounded, 128)
                    .unwrap(),
                snapshot
                    .scan::<artifacts::ArtifactTable>(Bound::Unbounded, Bound::Unbounded, 128)
                    .unwrap(),
                snapshot
                    .scan::<artifacts::VersionTable>(Bound::Unbounded, Bound::Unbounded, 128)
                    .unwrap(),
                snapshot
                    .scan::<artifacts::WriteTable>(Bound::Unbounded, Bound::Unbounded, 128)
                    .unwrap(),
            )
        };
        let (operations, artifacts, versions, writes) = scan(&snapshot);
        Self {
            operations,
            artifacts,
            versions,
            writes,
        }
    }
    fn operation(&self, id: &str) -> &artifacts::Operation {
        self.operations
            .iter()
            .find(|operation| operation.id.as_str() == Some(id))
            .unwrap()
    }
}

fn kind() -> project_artifact::Kind {
    id("skill")
}

#[test]
fn test_061_imported_journal_crash_at_filesystem_and_redb_phases_reconciles_twice_with_exact_bytes_and_accounting()
 {
    let fixture = Fixture::new();
    let layout = &fixture.0;
    let source = create_baseline(layout);
    import::stage(
        Request {
            source: &source,
            candidate: &layout.candidate(),
            kind: DatabaseKind::Core,
            metadata: Metadata::new([61; 16], 1),
        },
        |_| ControlFlow::Continue(()),
    )
    .unwrap();
    import::sealed(&layout.candidate(), DatabaseKind::Core).unwrap();

    let store = layout.open();
    let imported = Journal::take(&store);
    assert_eq!(imported.operations.len(), CASES.len() + 1);
    for case in &CASES {
        let operation = imported.operation(case.operation);
        assert_eq!(operation.phase.as_str(), Some("preparing"));
        assert_eq!(operation.time_created, T0);
    }
    assert_eq!(
        imported.operation(AVAILABLE_ORPHAN.2).phase.as_str(),
        Some("available")
    );
    assert!(imported.writes.is_empty());
    let service = layout.service(&store);
    let scope = service
        .resolve_project_scope(&project_id("prj_base"))
        .unwrap();
    assert_eq!(scope.id.as_lossless().as_str(), Some(SCOPE));
    assert_eq!(scope.storage_id.as_lossless().as_str(), Some(STORAGE));
    let root = layout.scope_root(&scope.storage_id);
    let settled = &CASES[3];
    let v1_content = adapter::render(&settled.definition(SETTLED_V1_BODY));
    let v1_marker = package::marker(package::MarkerInput {
        scope_id: scope.id.clone(),
        storage_id: scope.storage_id.clone(),
        kind: kind(),
        id: id(settled.artifact),
        version_id: id(SETTLED_V1),
        content: v1_content.clone(),
    });
    package::commit(
        package::CommitInput {
            root: &root,
            marker: &v1_marker,
            content: &v1_content,
            expected_version_id: None,
            operation_id: None,
            standard: None,
            no_overwrite: false,
        },
        &Hooks::default(),
    )
    .unwrap();
    drop(service);
    store.shutdown().unwrap();

    for case in CASES.iter().filter(|case| case.crash.is_some()) {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "report_flow_crash_child",
                "--ignored",
                "--nocapture",
            ])
            .env("YCODING_REPORT_FLOW_ROOT", &layout.0)
            .env("YCODING_REPORT_FLOW_CASE", case.artifact)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let reached = lines.any(|line| line.unwrap() == "CRASH-POINT");
        child.kill().unwrap();
        assert!(!child.wait().unwrap().success());
        assert!(reached, "{} reached its crash point", case.artifact);
    }

    let store = layout.open();
    let service = layout.service(&store);
    let scope = service
        .resolve_project_scope(&project_id("prj_base"))
        .unwrap();
    let crashed = Journal::take(&store);
    for case in CASES.iter().filter(|case| case.crash.is_some()) {
        let expected = if case.crash == Some(Crash::RedbCommitted) {
            "available"
        } else {
            "preparing"
        };
        assert_eq!(
            crashed.operation(case.operation).phase.as_str(),
            Some(expected),
            "{} journal phase after the kill",
            case.artifact
        );
    }
    assert_eq!(crashed.artifacts.len(), 1);
    assert_eq!(crashed.artifacts[0].artifact_id.as_str(), Some("settled"));
    assert_eq!(crashed.artifacts[0].revision, 0);
    assert_eq!(
        crashed.artifacts[0].current_version_id.as_str(),
        Some(SETTLED_V1)
    );
    assert!(crashed.writes.is_empty());
    let transactions = package::read_commit_transactions(&root, &Hooks::default()).unwrap();
    assert_eq!(transactions.len(), 4);
    for transaction in &transactions {
        let case = CASES
            .iter()
            .find(|case| case.operation == transaction.operation_id)
            .unwrap();
        assert_eq!(
            transaction.phase,
            if case.crash == Some(Crash::Filesystem) {
                package::CommitPhase::ActivatingContent
            } else {
                package::CommitPhase::Finalizing
            },
            "{} filesystem phase after the kill",
            transaction.operation_id
        );
        assert_ne!(transaction.phase, package::CommitPhase::Committed);
    }

    let first = service.reconcile(&scope.id);
    assert!(
        first.is_ok(),
        "reconciliation: {first:?}; journal: {:?}",
        Journal::take(&store)
    );
    let first = first.unwrap();
    let settled_journal = Journal::take(&store);
    let second = service.reconcile(&scope.id).unwrap();
    assert!(first == second);
    assert_eq!(settled_journal, Journal::take(&store));
    assert!(
        package::read_commit_transactions(&root, &Hooks::default())
            .unwrap()
            .is_empty()
    );

    assert_eq!(settled_journal.artifacts.len(), 4);
    assert_eq!(settled_journal.versions.len(), 5);
    assert_eq!(settled_journal.writes.len(), 4);
    for case in &CASES[..4] {
        let marker = package::marker(package::MarkerInput {
            scope_id: scope.id.clone(),
            storage_id: scope.storage_id.clone(),
            kind: kind(),
            id: id(case.artifact),
            version_id: id(case.version),
            content: case.content(),
        });
        let details = service.get(&scope.id, &marker.kind, &marker.id).unwrap();
        assert_eq!(details.current_version.id, marker.version_id);
        assert_eq!(
            details.current_version.content_digest,
            marker.content_digest
        );
        assert_eq!(
            details.artifact.revision.get(),
            if case.update { 1 } else { 0 }
        );
        assert_eq!(details.versions.len(), if case.update { 2 } else { 1 });
        assert_eq!(
            details.current_version.parent_version_id,
            case.update.then(|| id(SETTLED_V1))
        );
        assert_eq!(
            details.current_version.provenance.source.encode(),
            JsonValue::String("agent".into())
        );
        assert_eq!(
            details.artifact.stage.encode(),
            JsonValue::String("trial".into())
        );
        assert_eq!(
            std::fs::read(package::active_content_path(
                &root,
                &marker.kind,
                &marker.id
            ))
            .unwrap(),
            text(&case.content()).as_bytes()
        );
        assert!(
            package::read_active(&root, &marker.kind, &marker.id, &Hooks::default()).unwrap()
                == Some(marker.clone())
        );
        let operation = settled_journal.operation(case.operation);
        assert_eq!(operation.phase.as_str(), Some("finalized"));
        assert_eq!(
            operation.final_version_id.as_ref(),
            Some(marker.version_id.as_lossless())
        );
        assert_eq!(
            settled_journal
                .writes
                .iter()
                .filter(|write| write.version_id == *marker.version_id.as_lossless())
                .collect::<Vec<_>>(),
            vec![&artifacts::AutomaticWrite {
                scope_id: SCOPE.into(),
                session_id: case.session.into(),
                insight_digest: case.insight(),
                operation: if case.update { "update" } else { "create" }.into(),
                result: if case.update { "updated" } else { "created" }.into(),
                version_id: marker.version_id.as_lossless().clone(),
                content_digest: marker.content_digest.as_lossless().clone(),
                time_created: T0,
            }]
        );
    }

    let artifact = settled_journal
        .artifacts
        .iter()
        .find(|artifact| artifact.artifact_id.as_str() == Some(settled.artifact))
        .unwrap();
    assert_eq!(
        artifact.fallback_version_id.as_ref(),
        Some(v1_marker.version_id.as_lossless())
    );
    let previous = settled_journal
        .versions
        .iter()
        .find(|version| version.id == *v1_marker.version_id.as_lossless())
        .unwrap();
    assert_eq!(previous.state.as_str(), Some("superseded"));
    assert_eq!(
        previous.content_digest,
        *v1_marker.content_digest.as_lossless()
    );
    assert_eq!(
        std::fs::read(package::version_content_path(&root, &v1_marker)).unwrap(),
        text(&v1_content).as_bytes()
    );
    assert_eq!(
        std::fs::read_to_string(package::version_marker_path(&root, &v1_marker)).unwrap(),
        ycoding_schema::stringify_json(&v1_marker.encode())
    );

    let orphan = &CASES[4];
    assert_eq!(
        settled_journal.operation(orphan.operation).phase.as_str(),
        Some("aborted")
    );
    assert!(
        service
            .get(&scope.id, &kind(), &id(orphan.artifact))
            .is_err()
    );
    assert!(!root.join("active/skills").join(orphan.artifact).exists());

    let other = service
        .resolve_project_scope(&project_id("prj_other"))
        .unwrap();
    for _ in 0..2 {
        assert_eq!(
            service.reconcile(&other.id).unwrap_err().code.encode(),
            JsonValue::String("ReconciliationRequired".into())
        );
        assert_eq!(
            Journal::take(&store)
                .operation(AVAILABLE_ORPHAN.2)
                .phase
                .as_str(),
            Some("available")
        );
    }

    let fresh = parse_json(
        r#"{"kind":"skill","name":"Extra","description":"Accounting probe","content":"Accounting probe body."}"#,
    )
    .unwrap();
    let probe = |session_id: &str, artifact_id| store::AutomaticWriteInput {
        project_id: project_id("prj_base"),
        session_id: id::<session::Id>(session_id),
        agent_id: None,
        insight_key: artifact_id,
        id: artifact_id,
        definition: &fresh,
        base_version_id: None,
        now: T0 + 1000,
    };
    assert_eq!(
        service
            .write_automatic(probe("ses_acct", "extra-denied"))
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("WriteRateExceeded".into())
    );
    let written = service
        .write_automatic(probe("ses_fresh", "extra"))
        .unwrap();
    assert_eq!(
        (
            written.remaining.session,
            written.remaining.project_daily,
            written.remaining.project_artifacts,
            written.remaining.versions
        ),
        (2.0, 5.0, 27.0, 15.0)
    );
    drop(service);
    store.shutdown().unwrap();
}

#[test]
#[ignore = "subprocess-only crash fixture killed by the parent test"]
fn report_flow_crash_child() {
    fn barrier() {
        println!("CRASH-POINT");
        std::io::stdout().flush().unwrap();
        std::io::stdin().read_exact(&mut [0]).unwrap();
    }
    let layout = Layout(PathBuf::from(
        std::env::var_os("YCODING_REPORT_FLOW_ROOT").unwrap(),
    ));
    let name = std::env::var("YCODING_REPORT_FLOW_CASE").unwrap();
    let case = CASES.iter().find(|case| case.artifact == name).unwrap();
    let crash = case.crash.unwrap();
    let store = layout.open();
    let service = layout.service(&store);
    let scope = service
        .resolve_project_scope(&project_id("prj_base"))
        .unwrap();
    let root = layout.scope_root(&scope.storage_id);
    let content = case.content();
    let marker = package::marker(package::MarkerInput {
        scope_id: scope.id.clone(),
        storage_id: scope.storage_id.clone(),
        kind: kind(),
        id: id(case.artifact),
        version_id: id(case.version),
        content: content.clone(),
    });
    let previous = case
        .update
        .then(|| id::<project_artifact::VersionId>(SETTLED_V1));
    let active = package::active_content_path(&root, &marker.kind, &marker.id);
    let before = |mutation: &Mutation<'_>| {
        if crash == Crash::Filesystem
            && mutation.operation == "rename"
            && mutation.destination == Some(active.as_path())
        {
            barrier();
        }
        Ok(())
    };
    let client = store.client();
    let finalize = |_: &package::CommitTransactionMetadata| -> Result<(), Infallible> {
        let operation = case.operation;
        client
            .submit(move |tx| {
                artifacts::transition_operation(
                    tx,
                    &operation.into(),
                    artifacts::JournalPhase::Available,
                    None,
                    T0 + 1,
                )?;
                if crash == Crash::RedbOpen {
                    barrier();
                }
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
        barrier();
        Ok(())
    };
    package::commit_transaction(
        package::CommitInput {
            root: &root,
            marker: &marker,
            content: &content,
            expected_version_id: previous.as_ref(),
            operation_id: Some(case.operation),
            standard: None,
            no_overwrite: false,
        },
        &Hooks {
            before_mutation: Some(&before),
            ..Default::default()
        },
        &package::TransactionHooks {
            reserve: None,
            finalize: Some(&finalize),
            abort: None,
            cancellation: None,
            can_compensate: None,
        },
    )
    .unwrap();
}
