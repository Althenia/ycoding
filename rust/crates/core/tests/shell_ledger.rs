#![cfg(unix)]
include!("policy_fixture.rs");
use std::{ops::Bound, time::Duration};
use tokio::io::{AsyncBufReadExt, BufReader};
use ycoding_core::platform::shell::ledger::{self, Ledger, Process};
use ycoding_schema::{DomainDecode, DomainEncode, JsonValue, LosslessString, shell::Id};
use ycoding_store::{
    KeyPart,
    resources::ShellTable,
    session::{Event, Sequence, SequenceTable},
    tuple_key,
};

fn id(name: &str) -> Id {
    Id::decode(&JsonValue::String(name.into())).unwrap()
}
fn owner() -> Process {
    Process {
        pid: 2_000_000_000,
        pgid: 2_000_000_000,
        started: "Thu Jan 1 00:00:00 1970".into(),
    }
}

#[test]
fn alive_requires_both_pid_and_exact_start_text_without_group_fallback() {
    let process = Process {
        pid: 42,
        pgid: 43,
        started: "Wed Oct 14 01:02:03 2026".into(),
    };
    let started = LosslessString::from(process.started.clone());
    let snapshot = [process];
    assert!(ledger::alive(&snapshot, Some(42), Some(&started)));
    assert!(!ledger::alive(&snapshot, None, Some(&started)));
    assert!(!ledger::alive(&snapshot, Some(42), None));
    assert!(!ledger::alive(&snapshot, Some(43), Some(&started)));
    assert!(!ledger::alive(
        &snapshot,
        Some(42),
        Some(&"different start".into())
    ));
    assert!(!ledger::alive(
        &snapshot,
        Some(42),
        Some(&"Wed Oct 14 01:02:03 2026 ".into())
    ));
    assert!(!ledger::alive(&[], Some(42), Some(&started)));
}
struct DatabaseFile(std::path::PathBuf);
impl Drop for DatabaseFile {
    fn drop(&mut self) {
        if self.0.exists() {
            std::fs::remove_file(&self.0).unwrap();
        }
    }
}
fn row(fixture: &Fixture, id: &Id) -> Option<ycoding_store::resources::Shell> {
    let JsonValue::String(id) = id.encode() else {
        unreachable!()
    };
    fixture
        .store
        .client()
        .snapshot()
        .unwrap()
        .get::<ShellTable>(&tuple_key(&[KeyPart::String(&id)]))
        .unwrap()
}

struct Orphan {
    child: tokio::process::Child,
    pid: u32,
    lines: BufReader<tokio::process::ChildStdout>,
}
impl Orphan {
    async fn new(script: &str) -> Self {
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .args(["-c", script])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().unwrap();
        let pid = child.id().unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap());
        let mut ready = String::new();
        tokio::time::timeout(Duration::from_secs(3), lines.read_line(&mut ready))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ready, "READY\n");
        Self { child, pid, lines }
    }
}
impl Drop for Orphan {
    fn drop(&mut self) {
        unsafe {
            libc::kill(-(self.pid as i32), libc::SIGKILL);
        }
    }
}

#[tokio::test]
async fn notice_retention_admission_and_real_store_reopen() {
    let path = DatabaseFile(
        std::env::temp_dir().join(format!("ycoding-wp009-ledger-{}.redb", std::process::id())),
    );
    let catalog = ycoding_store::import::catalog(ycoding_store::import::DatabaseKind::Core);
    let store = ycoding_store::Store::initialize(
        &path.0,
        ycoding_store::Options::core(),
        catalog,
        ycoding_store::Metadata::new([31; 16], 1),
    )
    .unwrap();
    let ledger = Ledger::new(store.client());
    let shell = id("sh_persistent");
    ledger
        .record(&shell, 1000, Some("identity".into()), &owner())
        .await
        .unwrap();
    ledger
        .notice_owed(
            &shell,
            ycoding_schema::session_id::SessionId::new("ses_trusted").unwrap(),
        )
        .await
        .unwrap();
    ledger.release(&shell).await.unwrap();
    drop(ledger);
    store.shutdown().unwrap();
    let store =
        ycoding_store::Store::open(&path.0, ycoding_store::Options::core(), catalog).unwrap();
    let record = store
        .client()
        .snapshot()
        .unwrap()
        .scan::<ShellTable>(Bound::Unbounded, Bound::Unbounded, 1)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(record.session_id, Some("ses_trusted".into()));
    assert_eq!(record.notice_pending, 1);
    let ledger = Ledger::new(store.client());
    ledger.notice_admitted(&shell).await.unwrap();
    assert!(
        store
            .client()
            .snapshot()
            .unwrap()
            .scan::<ShellTable>(Bound::Unbounded, Bound::Unbounded, 1)
            .unwrap()
            .is_empty()
    );
    drop(ledger);
    store.shutdown().unwrap();
}

#[tokio::test]
async fn reconcile_terminates_dead_owner_and_only_retains_owed_notice() {
    use std::os::unix::process::ExitStatusExt;
    let fixture = Fixture::default();
    fixture.session("ses_notice", None, 0, false, None);
    let ledger = Ledger::new(fixture.store.client());
    let mut child = Orphan::new("printf 'READY\n'; exec tail -f /dev/null").await;
    let shell = id("sh_dead_owner");
    ledger
        .record(
            &shell,
            child.pid,
            ledger::identify(child.pid)
                .await
                .map(|identity| identity.started),
            &owner(),
        )
        .await
        .unwrap();
    ledger
        .notice_owed(
            &shell,
            ycoding_schema::session_id::SessionId::new("ses_notice").unwrap(),
        )
        .await
        .unwrap();
    let (report, status) = tokio::join!(
        ledger.reconcile(Duration::from_millis(100)),
        child.child.wait()
    );
    let report = report.unwrap();
    assert!(!report.process_list_unavailable);
    assert!(report.signal_failures.is_empty());
    assert_eq!(status.unwrap().signal(), Some(libc::SIGTERM));
    let lost = row(&fixture, &shell).unwrap();
    assert!(lost.time_lost.is_some());
    assert_eq!(lost.start_seq, -1);
    assert_eq!(
        ledger.lost_sessions().unwrap(),
        vec![LosslessString::from("ses_notice")]
    );
    ledger.reconcile(Duration::ZERO).await.unwrap();
    assert!(row(&fixture, &shell).is_some());
    ledger.notice_admitted(&shell).await.unwrap();
    assert!(row(&fixture, &shell).is_none());
}

#[tokio::test]
async fn live_owner_and_mismatched_process_identity_are_never_signalled() {
    let fixture = Fixture::default();
    let ledger = Ledger::new(fixture.store.client());
    let mut child = Orphan::new("printf 'READY\n'; exec tail -f /dev/null").await;
    let live = id("sh_live_owner");
    ledger
        .record(
            &live,
            child.pid,
            None,
            &ledger::identify(std::process::id()).await.unwrap(),
        )
        .await
        .unwrap();
    let stale = id("sh_reused_pid");
    ledger
        .record(
            &stale,
            child.pid,
            Some("wrong birth identity".into()),
            &owner(),
        )
        .await
        .unwrap();
    ledger.reconcile(Duration::from_millis(50)).await.unwrap();
    assert!(child.child.try_wait().unwrap().is_none());
    assert!(row(&fixture, &live).is_some());
    assert!(row(&fixture, &stale).is_none());
    unsafe {
        libc::kill(-(child.pid as i32), libc::SIGKILL);
    }
    child.child.wait().await.unwrap();
}

#[tokio::test]
async fn reconciliation_escalates_and_terminates_leaderless_groups() {
    use std::os::unix::process::ExitStatusExt;
    let fixture = Fixture::default();
    let ledger = Ledger::new(fixture.store.client());
    let mut child = Orphan::new("trap '' TERM; printf 'READY\n'; exec tail -f /dev/null").await;
    let shell = id("sh_stubborn");
    ledger
        .record(
            &shell,
            child.pid,
            ledger::identify(child.pid)
                .await
                .map(|identity| identity.started),
            &owner(),
        )
        .await
        .unwrap();
    ledger.reconcile(Duration::from_millis(50)).await.unwrap();
    assert_eq!(
        child.child.wait().await.unwrap().signal(),
        Some(libc::SIGKILL)
    );
    assert!(row(&fixture, &shell).is_none());
    let mut child = Orphan::new("tail -f /dev/null & printf 'READY\n'; echo $!; wait").await;
    let mut descendant = String::new();
    child.lines.read_line(&mut descendant).await.unwrap();
    let descendant: u32 = descendant.trim().parse().unwrap();
    let shell = id("sh_no_leader");
    ledger
        .record(
            &shell,
            child.pid,
            ledger::identify(child.pid)
                .await
                .map(|identity| identity.started),
            &owner(),
        )
        .await
        .unwrap();
    child.child.start_kill().unwrap();
    child.child.wait().await.unwrap();
    assert!(ycoding_core::platform::process::is_alive(descendant).unwrap());
    ledger.reconcile(Duration::from_millis(50)).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while ycoding_core::platform::process::is_alive(descendant).unwrap() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(row(&fixture, &shell).is_none());
}

fn task(fixture: &Fixture, child: &str, parent: &str, state: &str) {
    let (child, parent, state) = (child.to_owned(), parent.to_owned(), state.to_owned());
    fixture
        .store
        .submit(move |tx| {
            ycoding_store::session::TaskTable::put(
                tx,
                &ycoding_store::session::Task {
                    session_id: child.as_str().into(),
                    parent_id: parent.as_str().into(),
                    parent_assistant_message_id: "msg_parent".into(),
                    tool_call_id: format!("call_{child}").as_str().into(),
                    input_id: format!("msg_input_{child}").as_str().into(),
                    description: "Work".into(),
                    agent: "build".into(),
                    model: ycoding_store::session::Document::<ycoding_schema::model::Ref>::new(
                        ycoding_schema::parse_json(r#"{"providerID":"local","id":"test"}"#)
                            .unwrap(),
                    )?,
                    prompt_digest: "0".repeat(64).as_str().into(),
                    background: 1,
                    delivery: "steer".into(),
                    state: state.as_str().into(),
                    progress: None,
                    progress_time: None,
                    question_id: None,
                    question: None,
                    question_data: None,
                    question_time: None,
                    usage_anchor: None,
                    attempt_started: 0,
                    owner_pid: None,
                    owner_started: None,
                    revision: 0,
                    time_created: 1,
                    time_updated: 1,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
}

async fn owed(ledger: &Ledger, shell: &Id, session: &str, pid: u32) {
    ledger.record(shell, pid, None, &owner()).await.unwrap();
    ledger
        .notice_owed(
            shell,
            ycoding_schema::session_id::SessionId::new(session).unwrap(),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn lost_notices_of_terminal_subagents_are_acknowledged_and_discarded_at_startup() {
    let fixture = Fixture::default();
    fixture.session("ses_lost_root", None, 0, false, None);
    fixture.session("ses_lost_done", Some("ses_lost_root"), 0, false, None);
    fixture.session("ses_lost_open", Some("ses_lost_root"), 0, false, None);
    task(&fixture, "ses_lost_done", "ses_lost_root", "completed");
    task(&fixture, "ses_lost_open", "ses_lost_root", "running");
    let ledger = Ledger::new(fixture.store.client());
    let (root, done, open) = (id("sh_lost_root"), id("sh_lost_done"), id("sh_lost_open"));
    owed(&ledger, &root, "ses_lost_root", 2_000_000_011).await;
    owed(&ledger, &done, "ses_lost_done", 2_000_000_012).await;
    owed(&ledger, &open, "ses_lost_open", 2_000_000_013).await;

    ledger.reconcile(Duration::ZERO).await.unwrap();
    assert!(
        row(&fixture, &done).is_none(),
        "a newly orphaned notice of a terminal subagent was kept"
    );
    assert!(row(&fixture, &root).unwrap().time_lost.is_some());
    assert!(row(&fixture, &open).unwrap().time_lost.is_some());
    assert_eq!(
        ledger.lost_sessions().unwrap(),
        vec![
            LosslessString::from("ses_lost_open"),
            LosslessString::from("ses_lost_root")
        ]
    );

    task(&fixture, "ses_lost_open", "ses_lost_root", "failed");
    assert_eq!(
        ledger.lost_sessions().unwrap(),
        vec![LosslessString::from("ses_lost_root")]
    );
    ledger.reconcile(Duration::ZERO).await.unwrap();
    assert!(row(&fixture, &open).is_none());
    assert!(row(&fixture, &root).is_some());

    for state in ["cancelled", "lost"] {
        let child = format!("ses_lost_{state}");
        fixture.session(&child, Some("ses_lost_root"), 0, false, None);
        task(&fixture, &child, "ses_lost_root", "running");
        let shell = id(&format!("sh_lost_{state}"));
        owed(&ledger, &shell, &child, 2_000_000_014).await;
        ledger.reconcile(Duration::ZERO).await.unwrap();
        assert!(row(&fixture, &shell).unwrap().time_lost.is_some());
        task(&fixture, &child, "ses_lost_root", state);
        assert!(
            !ledger
                .lost_sessions()
                .unwrap()
                .contains(&LosslessString::from(child.as_str())),
            "{state} subagent stayed lost"
        );
        ledger.reconcile(Duration::ZERO).await.unwrap();
        assert!(row(&fixture, &shell).is_none(), "{state} row was kept");
    }
}

#[tokio::test]
async fn lost_notice_is_acknowledged_only_by_a_newer_execution_start_and_pruned_for_deleted_sessions()
 {
    let fixture = Fixture::default();
    fixture.session("ses_notice", None, 0, false, None);
    let ledger = Ledger::new(fixture.store.client());
    fixture
        .store
        .submit(|tx| {
            SequenceTable::put(
                tx,
                &Sequence {
                    aggregate_id: "ses_notice".into(),
                    seq: 3,
                    owner_id: None,
                },
            )?;
            ycoding_store::session::EventTable::insert(
                tx,
                &Event {
                    id: "ev_prior".into(),
                    aggregate_id: "ses_notice".into(),
                    seq: 3,
                    created: 1,
                    type_: "session.execution.started.1".into(),
                    data: JsonValue::Null,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let shell = id("sh_notice_seq");
    ledger
        .record(&shell, 2_000_000_001, None, &owner())
        .await
        .unwrap();
    ledger
        .notice_owed(
            &shell,
            ycoding_schema::session_id::SessionId::new("ses_notice").unwrap(),
        )
        .await
        .unwrap();
    ledger.reconcile(Duration::ZERO).await.unwrap();
    assert_eq!(row(&fixture, &shell).unwrap().start_seq, 3);
    assert_eq!(
        ledger.lost_sessions().unwrap(),
        vec![LosslessString::from("ses_notice")]
    );
    fixture
        .store
        .submit(|tx| {
            ycoding_store::session::EventTable::insert(
                tx,
                &Event {
                    id: "ev_other".into(),
                    aggregate_id: "ses_notice".into(),
                    seq: 4,
                    created: 2,
                    type_: "session.execution.succeeded.1".into(),
                    data: JsonValue::Null,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(ledger.lost_sessions().unwrap().len(), 1);
    fixture
        .store
        .submit(|tx| {
            ycoding_store::session::EventTable::insert(
                tx,
                &Event {
                    id: "ev_next".into(),
                    aggregate_id: "ses_notice".into(),
                    seq: 5,
                    created: 3,
                    type_: "session.execution.started.1".into(),
                    data: JsonValue::Null,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(ledger.lost_sessions().unwrap().is_empty());
    ledger.reconcile(Duration::ZERO).await.unwrap();
    assert!(row(&fixture, &shell).is_none());
    let missing = id("sh_missing_session");
    ledger
        .record(&missing, 2_000_000_001, None, &owner())
        .await
        .unwrap();
    ledger
        .notice_owed(
            &missing,
            ycoding_schema::session_id::SessionId::new("ses_missing").unwrap(),
        )
        .await
        .unwrap();
    ledger.reconcile(Duration::ZERO).await.unwrap();
    assert!(row(&fixture, &missing).is_some());
    assert!(ledger.lost_sessions().unwrap().is_empty());
    ledger.reconcile(Duration::ZERO).await.unwrap();
    assert!(row(&fixture, &missing).is_none());
}
