use std::cmp::Ordering;
use std::ops::Bound;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, mpsc};
use std::time::Duration;
use ycoding_schema::LosslessString;
use ycoding_store::{
    Catalog, Error, IndexDefinition, KeyPart, Metadata, Options, Store, TableDeclaration,
    TableSpec, tuple_key,
};

mod store_flow_support;

#[test]
fn test_001_006_063_baseline_checkpoint_to_client_history_and_escaped_export() {
    use std::ops::ControlFlow;
    use ycoding_schema::{DomainEncode, JsonValue, parse_json, stringify_json};
    use ycoding_store::{import, session};

    let baseline = store_flow_support::Baseline::produce();
    let source = baseline.core();
    let original = std::fs::read(&source).unwrap();
    let candidate = baseline.0.join("core.candidate.redb");
    let request = || import::Request {
        source: &source,
        candidate: &candidate,
        kind: import::DatabaseKind::Core,
        metadata: metadata(),
    };
    assert!(matches!(
        import::stage(request(), |phase| {
            if phase == import::Progress::Loaded("credential") {
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            }
        }),
        Err(import::Error::Cancelled)
    ));
    assert!(import::sealed(&candidate, import::DatabaseKind::Core).is_err());
    assert_eq!(import::resume_metadata(&candidate).unwrap(), metadata());
    let report = import::stage(request(), |_| ControlFlow::Continue(())).unwrap();
    assert_eq!(report.tables.len(), 52);
    assert_eq!(
        import::sealed(&candidate, import::DatabaseKind::Core)
            .unwrap()
            .1,
        report
    );
    assert_eq!(std::fs::read(&source).unwrap(), original);
    let active = baseline.0.join("core.active.redb");
    std::fs::hard_link(&candidate, &active).unwrap();
    let store = Store::open(
        &active,
        Options::core(),
        import::catalog(import::DatabaseKind::Core),
    )
    .unwrap();
    assert!(
        Store::open(
            &active,
            Options::core(),
            import::catalog(import::DatabaseKind::Core)
        )
        .is_err()
    );
    let client = store.client();
    let snapshot = client.snapshot().unwrap();
    let expected = store_flow_support::logical_tables(&baseline.expected("core"));
    let exported = store_flow_support::core_export(&snapshot);
    assert_eq!(store_flow_support::logical_tables(&exported), expected);
    let escaped = stringify_json(&exported);
    assert!(escaped.contains("\\ud800"));
    assert!(escaped.contains("\\udc00"));
    assert_eq!(
        store_flow_support::logical_tables(&parse_json(&escaped).unwrap()),
        expected
    );
    let history = session::messages(
        &snapshot,
        &"ses_baseline_root".into(),
        Bound::Unbounded,
        Bound::Unbounded,
        ycoding_store::IndexOrder::Ascending,
        None,
        10_000,
    )
    .unwrap();
    assert!(!history.is_empty());
    let projected = snapshot
        .scan::<session::MessageTable>(Bound::Unbounded, Bound::Unbounded, 10_000)
        .unwrap();
    for message in history {
        let original = projected
            .iter()
            .find(|row| row.id == message.record.id)
            .unwrap();
        assert_eq!(message.record, *original);
        let info = message.record.info().unwrap().encode();
        let JsonValue::Object(info) = info else {
            panic!("logical history must be an object")
        };
        assert_eq!(
            info.get(&"id".into()),
            Some(&JsonValue::String(original.id.clone()))
        );
        if let JsonValue::Object(data) = &original.data
            && let Some(metadata) = data.get(&"metadata".into())
        {
            assert_eq!(info.get(&"metadata".into()), Some(metadata));
        }
    }
    drop(snapshot);
    store.shutdown().unwrap();
    let reopened = Store::open(
        &active,
        Options::core(),
        import::catalog(import::DatabaseKind::Core),
    )
    .unwrap();
    assert_eq!(
        store_flow_support::logical_tables(&store_flow_support::core_export(
            &reopened.client().snapshot().unwrap()
        )),
        expected
    );
    reopened.shutdown().unwrap();
    assert_eq!(std::fs::read(source).unwrap(), original);
    let source = baseline.0.join("meeting/meetings.sqlite");
    let original = std::fs::read(&source).unwrap();
    let candidate = baseline.0.join("meeting.candidate.redb");
    let report = import::stage(
        import::Request {
            source: &source,
            candidate: &candidate,
            kind: import::DatabaseKind::Meeting,
            metadata: Metadata::new([8; 16], 1),
        },
        |_| ControlFlow::Continue(()),
    )
    .unwrap();
    assert_eq!(report.tables.len(), 9);
    assert_eq!(
        import::sealed(&candidate, import::DatabaseKind::Meeting)
            .unwrap()
            .1,
        report
    );
    let meeting = Store::open(
        &candidate,
        Options::meeting(),
        import::catalog(import::DatabaseKind::Meeting),
    )
    .unwrap();
    let expected = store_flow_support::logical_tables(&baseline.expected("meeting"));
    let export = store_flow_support::meeting_export(&meeting.client().snapshot().unwrap());
    assert_eq!(store_flow_support::logical_tables(&export), expected);
    assert_eq!(
        store_flow_support::logical_tables(&parse_json(&stringify_json(&export)).unwrap()),
        expected
    );
    assert!(matches!(
        meeting
            .client()
            .snapshot()
            .unwrap()
            .scan::<session::MessageTable>(Bound::Unbounded, Bound::Unbounded, 1),
        Err(Error::UnregisteredTable("session_message"))
    ));
    meeting.shutdown().unwrap();
    assert_eq!(std::fs::read(source).unwrap(), original);
    let source = baseline.0.join("stale.sqlite");
    std::fs::write(&source, std::fs::read(baseline.core()).unwrap()).unwrap();
    let candidate = baseline.0.join("stale.candidate.redb");
    let request = || import::Request {
        source: &source,
        candidate: &candidate,
        kind: import::DatabaseKind::Core,
        metadata: metadata(),
    };
    assert!(matches!(
        import::stage(request(), |phase| {
            if phase == import::Progress::Loaded("credential") {
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            }
        }),
        Err(import::Error::Cancelled)
    ));
    let before = std::fs::read(&candidate).unwrap();
    rusqlite::Connection::open(&source)
        .unwrap()
        .execute(
            "UPDATE credential SET label='Changed synthetic profile'",
            [],
        )
        .unwrap();
    assert!(matches!(
        import::stage(request(), |_| ControlFlow::Continue(())),
        Err(import::Error::SourceChanged)
    ));
    assert!(import::sealed(&candidate, import::DatabaseKind::Core).is_err());
    assert_eq!(std::fs::read(candidate).unwrap(), before);
    let JsonValue::Object(provenance) =
        parse_json(&std::fs::read_to_string(baseline.0.join("provenance.json")).unwrap()).unwrap()
    else {
        panic!("expected provenance object")
    };
    let Some(JsonValue::Array(files)) = provenance.get(&"files".into()) else {
        panic!("expected provenance files")
    };
    for file in files {
        let JsonValue::Object(file) = file else {
            panic!("expected provenance file")
        };
        let Some(JsonValue::String(name)) = file.get(&"file".into()) else {
            panic!("expected relative file name")
        };
        let (digest, bytes) =
            import::file_fingerprint(&baseline.0.join(name.as_str().unwrap())).unwrap();
        assert_eq!(
            file.get(&"sha256".into()),
            Some(&JsonValue::String(digest.into()))
        );
        assert_eq!(
            file.get(&"bytes".into()),
            Some(&JsonValue::Number(bytes as f64))
        );
    }
}

#[test]
fn test_003_replay_sequence_partitions_preserve_file_backed_canonical_events() {
    use ycoding_store::session;
    let root = Root::new();
    let store =
        Store::initialize(root.file(), Options::core(), flow_catalog(), metadata()).unwrap();
    store.submit(flow_seed).unwrap().wait().unwrap();
    let canonical = store
        .snapshot()
        .unwrap()
        .scan::<session::EventTable>(Bound::Unbounded, Bound::Unbounded, 10)
        .unwrap();
    for _ in 0..3 {
        assert!(matches!(
            store
                .submit(|tx| session::append(
                    tx,
                    &flow_event("admitted", "session.input.admitted.1"),
                    Some(&session::Replay {
                        seq: 0,
                        owner_id: None,
                        strict_owner: true,
                    })
                ))
                .unwrap()
                .wait()
                .unwrap(),
            session::Append::Replayed(_)
        ));
        assert_eq!(
            store
                .snapshot()
                .unwrap()
                .scan::<session::EventTable>(Bound::Unbounded, Bound::Unbounded, 10)
                .unwrap(),
            canonical
        );
    }
    for (id, seq, kind) in [
        ("duplicate", 0, "replay_diverged"),
        ("out-of-order", -1, "replay_diverged"),
        ("gap", 2, "sequence_mismatch"),
    ] {
        let result = store
            .submit(move |tx| {
                session::append(
                    tx,
                    &flow_event(id, "session.input.admitted.1"),
                    Some(&session::Replay {
                        seq,
                        owner_id: None,
                        strict_owner: true,
                    }),
                )
            })
            .unwrap()
            .wait();
        assert!(matches!(result, Err(Error::Domain { kind: actual, .. }) if actual == kind));
        assert_eq!(
            store
                .snapshot()
                .unwrap()
                .scan::<session::EventTable>(Bound::Unbounded, Bound::Unbounded, 10)
                .unwrap(),
            canonical
        );
        flow_state(&store.snapshot().unwrap(), false);
    }
    store.shutdown().unwrap();
    let store = Store::open(root.file(), Options::core(), flow_catalog()).unwrap();
    assert_eq!(
        store
            .client()
            .snapshot()
            .unwrap()
            .scan::<session::EventTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap(),
        canonical
    );
    store.shutdown().unwrap();
}

#[test]
fn test_065_coupled_domain_commit_at_65536_work_units_is_atomic() {
    use ycoding_store::{analytics, session};
    for delta in [-1_isize, 0, 1] {
        let root = Root::new();
        let store =
            Store::initialize(root.file(), Options::core(), flow_catalog(), metadata()).unwrap();
        store.submit(flow_seed).unwrap().wait().unwrap();
        let result = store
            .submit(move |tx| {
                tx.put::<session::EventTable>(&session::Event {
                    id: "promoted".into(),
                    aggregate_id: "s".into(),
                    seq: 1,
                    created: 1,
                    type_: "session.input.promoted.1".into(),
                    data: flow_input().data,
                })?;
                tx.put::<session::SequenceTable>(&session::Sequence {
                    aggregate_id: "s".into(),
                    seq: 1,
                    owner_id: None,
                })?;
                tx.put::<session::MessageTable>(&flow_message())?;
                tx.delete::<session::PendingTable>(&tuple_key(&[KeyPart::String(
                    &"msg_flow".into(),
                )]))?;
                tx.put::<session::SessionTable>(&session::Session {
                    revert: Some(session::Document::new(
                        ycoding_schema::parse_json(r#"{"messageID":"msg_flow"}"#).unwrap(),
                    )?),
                    ..flow_session()
                })?;
                let intent = analytics::Intent {
                    source: "session".into(),
                    identity: tuple_key(&[KeyPart::String(&"s".into())]),
                    generation: 1,
                    order: 1,
                    delete: false,
                };
                let bytes = analytics::IntentTable::primary_key(&intent).len()
                    + analytics::IntentTable::encode(&intent)?.len();
                tx.put::<analytics::IntentTable>(&intent)?;
                tx.put::<analytics::DeliveryTable>(&analytics::Delivery {
                    identity: metadata().database_identity,
                    source_generation: 1,
                    generation: 1,
                    order: 1,
                    applied: 0,
                    valid: true,
                    rebuilding: false,
                    intents: 1,
                    bytes,
                    privacy: 0,
                    purges: vec![],
                    purge_all: false,
                })?;
                for _ in 0..(65_536_usize - 7).checked_add_signed(delta).unwrap() {
                    tx.get::<session::PendingTable>(&tuple_key(&[KeyPart::String(
                        &"absent".into(),
                    )]))?;
                }
                Ok(())
            })
            .unwrap()
            .wait();
        if delta > 0 {
            assert!(matches!(
                result,
                Err(Error::Domain {
                    kind: "transaction_work_limit",
                    ..
                })
            ));
        } else {
            result.unwrap();
        }
        flow_state(&store.client().snapshot().unwrap(), delta <= 0);
        assert!(!store.is_fenced());
        store.shutdown().unwrap();
        let store = Store::open(root.file(), Options::core(), flow_catalog()).unwrap();
        flow_state(&store.client().snapshot().unwrap(), delta <= 0);
        store.shutdown().unwrap();
    }
}

fn flow_catalog() -> Catalog {
    ycoding_store::import::catalog(ycoding_store::import::DatabaseKind::Core)
}

fn flow_session() -> ycoding_store::session::Session {
    ycoding_store::session::Session {
        id: "s".into(),
        project_id: "p".into(),
        workspace_id: None,
        parent_id: None,
        fork_session_id: None,
        fork_message_id: None,
        fork_seq: None,
        directory: "/synthetic".into(),
        path: None,
        title: "Storage acceptance".into(),
        cost: 0.0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        revert: None,
        permission: None,
        autonomy: None,
        autonomy_revision: 0,
        orchestration_revision: 0,
        agent: None,
        model: None,
        profile_binding: None,
        daybreak: None,
        time_created: 0,
        time_updated: 0,
        time_archived: None,
        time_active: None,
        time_pinned: None,
        time_suspended: None,
        usage_pruned_through: None,
    }
}

fn flow_event(id: &str, kind: &str) -> ycoding_store::session::NewEvent {
    ycoding_store::session::NewEvent {
        id: id.into(),
        aggregate_id: "s".into(),
        created: 1,
        type_: kind.into(),
        data: ycoding_schema::parse_json(r#"{"text":"original","metadata":{"\ud800":"\udc00"}}"#)
            .unwrap(),
    }
}

fn flow_input() -> ycoding_store::session::Pending {
    ycoding_store::session::Pending {
        id: "msg_flow".into(),
        session_id: "s".into(),
        type_: "synthetic".into(),
        data: flow_event("unused", "unused").data,
        delivery: Some("steer".into()),
        admitted_seq: 0,
        time_created: 0,
    }
}

fn flow_message() -> ycoding_store::session::Message {
    ycoding_store::session::Message {
        id: "msg_flow".into(),
        session_id: "s".into(),
        type_: "synthetic".into(),
        seq: 1,
        time_created: 1,
        time_updated: 1,
        data: flow_input().data,
    }
}

fn flow_seed(tx: &mut ycoding_store::Write<'_>) -> Result<(), Error> {
    use ycoding_store::{analytics, project, session};
    project::ProjectTable::put(
        tx,
        &project::Project {
            id: "p".into(),
            worktree: "/synthetic".into(),
            vcs: None,
            name: None,
            icon_url: None,
            icon_url_override: None,
            icon_color: None,
            time_created: 0,
            time_updated: 0,
            time_initialized: None,
            sandboxes: vec![],
            commands: None,
        },
    )?;
    session::SessionTable::put(tx, &flow_session())?;
    tx.put::<analytics::DeliveryTable>(&analytics::Delivery {
        identity: metadata().database_identity,
        source_generation: 1,
        generation: 1,
        order: 0,
        applied: 0,
        valid: true,
        rebuilding: false,
        intents: 0,
        bytes: 0,
        privacy: 0,
        purges: vec![],
        purge_all: false,
    })?;
    session::append(
        tx,
        &flow_event("admitted", "session.input.admitted.1"),
        None,
    )?;
    session::admit(tx, &flow_input())?;
    Ok(())
}

fn flow_promote(
    tx: &mut ycoding_store::Write<'_>,
    mut barrier: impl FnMut(&str),
) -> Result<(), Error> {
    use ycoding_store::{analytics, session};
    session::append(
        tx,
        &flow_event("promoted", "session.input.promoted.1"),
        None,
    )?;
    barrier("event-sequence");
    session::promote(tx, &flow_message())?;
    barrier("message-pending-index");
    let mut record = tx
        .get::<session::SessionTable>(&tuple_key(&[KeyPart::String(&"s".into())]))?
        .unwrap();
    record.revert = Some(session::Document::new(
        ycoding_schema::parse_json(r#"{"messageID":"msg_flow"}"#).unwrap(),
    )?);
    session::SessionTable::put(tx, &record)?;
    barrier("revert");
    analytics::record(
        tx,
        analytics::Change {
            source: "session",
            identity: tuple_key(&[KeyPart::String(&"s".into())]),
            delete: false,
        },
    )?;
    barrier("intent");
    Ok(())
}

fn flow_state(snapshot: &ycoding_store::Snapshot, promoted: bool) {
    use ycoding_store::{analytics, session};
    let input_key = tuple_key(&[KeyPart::String(&"msg_flow".into())]);
    assert_eq!(
        snapshot.get::<session::PendingTable>(&input_key).unwrap(),
        (!promoted).then(flow_input)
    );
    assert_eq!(
        snapshot.get::<session::MessageTable>(&input_key).unwrap(),
        promoted.then(flow_message)
    );
    assert_eq!(
        session::latest_sequence(snapshot, &"s".into()).unwrap(),
        i64::from(promoted)
    );
    assert_eq!(
        snapshot
            .scan::<session::EventTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap()
            .len(),
        1 + usize::from(promoted)
    );
    assert_eq!(
        session::messages(
            snapshot,
            &"s".into(),
            Bound::Unbounded,
            Bound::Unbounded,
            ycoding_store::IndexOrder::Ascending,
            None,
            10
        )
        .unwrap()
        .len(),
        usize::from(promoted)
    );
    let record = snapshot
        .get::<session::SessionTable>(&tuple_key(&[KeyPart::String(&"s".into())]))
        .unwrap()
        .unwrap();
    assert_eq!(record.revert.is_some(), promoted);
    assert_eq!(
        snapshot
            .scan::<analytics::IntentTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap()
            .len(),
        usize::from(promoted)
    );
}

#[test]
fn test_002_009_065_held_promotion_failure_retry_and_uncertain_receipt_reconcile() {
    use ycoding_store::session;
    let root = Root::new();
    let store =
        Store::initialize(root.file(), Options::core(), flow_catalog(), metadata()).unwrap();
    store.submit(flow_seed).unwrap().wait().unwrap();
    let (sent, observed) = mpsc::channel();
    store.observe_events(move |events| {
        sent.send(events.to_vec()).unwrap();
        true
    });
    let before = store.snapshot().unwrap();
    for failure in [true, false] {
        let (reached, ready) = mpsc::channel();
        let (release, barrier) = mpsc::channel();
        let receipt = store
            .submit(move |tx| {
                flow_promote(tx, |_| {})?;
                reached.send(()).unwrap();
                barrier.recv_timeout(Duration::from_secs(30)).unwrap();
                if failure {
                    return Err(Error::Rejected("injected promotion commit failure"));
                }
                Ok(())
            })
            .unwrap();
        ready.recv_timeout(Duration::from_secs(30)).unwrap();
        flow_state(&store.snapshot().unwrap(), false);
        flow_state(&before, false);
        release.send(()).unwrap();
        if failure {
            assert!(matches!(
                receipt.wait(),
                Err(Error::Rejected("injected promotion commit failure"))
            ));
            flow_state(&store.snapshot().unwrap(), false);
            assert!(matches!(
                observed.try_recv(),
                Err(mpsc::TryRecvError::Empty)
            ));
            continue;
        }
        drop(receipt);
        let published = observed.recv_timeout(Duration::from_secs(30)).unwrap();
        assert_eq!(published.len(), 1);
        assert_eq!(published[0].id, LosslessString::from("promoted"));
        assert_eq!(published[0].seq, 1);
        flow_state(&store.snapshot().unwrap(), true);
    }
    drop(before);
    store.shutdown().unwrap();
    let store = Store::open(root.file(), Options::core(), flow_catalog()).unwrap();
    flow_state(&store.client().snapshot().unwrap(), true);
    let mut retry = flow_input();
    retry.data = ycoding_schema::parse_json(r#"{"text":"changed"}"#).unwrap();
    assert_eq!(
        store
            .submit(move |tx| session::admit(tx, &retry))
            .unwrap()
            .wait()
            .unwrap(),
        session::Admission::Promoted(flow_message())
    );
    flow_state(&store.snapshot().unwrap(), true);
    store.shutdown().unwrap();
}

#[test]
fn test_004_065_history_watermark_catchup_live_overlap_and_page_boundaries() {
    use ycoding_store::{IndexOrder, session};
    let root = Root::new();
    let store =
        Store::initialize(root.file(), Options::core(), flow_catalog(), metadata()).unwrap();
    store.submit(flow_seed).unwrap().wait().unwrap();
    let (sent, live) = mpsc::channel();
    store.observe_events(move |events| {
        sent.send(events.to_vec()).unwrap();
        true
    });
    let held = store.client().snapshot().unwrap();
    let watermark = session::latest_sequence(&held, &"s".into()).unwrap();
    assert!(
        session::messages(
            &held,
            &"s".into(),
            Bound::Unbounded,
            Bound::Unbounded,
            IndexOrder::Ascending,
            None,
            100
        )
        .unwrap()
        .is_empty()
    );
    store
        .submit(|tx| {
            flow_promote(tx, |_| {})?;
            for seq in 2..=101 {
                session::append(
                    tx,
                    &flow_event(&format!("event-{seq}"), "session.message.updated.1"),
                    None,
                )?;
                session::MessageTable::put(
                    tx,
                    &session::Message {
                        id: format!("message-{seq}").into(),
                        seq,
                        ..flow_message()
                    },
                )?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(
        session::latest_sequence(&held, &"s".into()).unwrap(),
        watermark
    );
    assert!(
        session::messages(
            &held,
            &"s".into(),
            Bound::Unbounded,
            Bound::Unbounded,
            IndexOrder::Ascending,
            None,
            101
        )
        .unwrap()
        .is_empty()
    );
    let fresh = store.client().snapshot().unwrap();
    let catchup = fresh
        .index_range::<session::EventTable>(
            "event_aggregate_seq_idx",
            ycoding_store::IndexQuery {
                lower: Bound::Excluded(&tuple_key(&[
                    KeyPart::String(&"s".into()),
                    KeyPart::I64(watermark),
                ])),
                upper: Bound::Unbounded,
                prefix: Some(&tuple_key(&[KeyPart::String(&"s".into())])),
                order: IndexOrder::Ascending,
                after: None,
                limit: 102,
            },
        )
        .unwrap();
    assert_eq!(
        catchup.iter().map(|row| row.record.seq).collect::<Vec<_>>(),
        (1..=101).collect::<Vec<_>>()
    );
    let overlap = live.recv_timeout(Duration::from_secs(30)).unwrap();
    assert_eq!(
        overlap,
        catchup
            .iter()
            .map(|row| row.record.clone())
            .collect::<Vec<_>>()
    );
    for limit in [99, 100, 101] {
        let first = session::messages(
            &fresh,
            &"s".into(),
            Bound::Unbounded,
            Bound::Unbounded,
            IndexOrder::Descending,
            None,
            limit,
        )
        .unwrap();
        assert_eq!(first.len(), limit);
        let second = session::messages(
            &fresh,
            &"s".into(),
            Bound::Unbounded,
            Bound::Unbounded,
            IndexOrder::Descending,
            Some(&first.last().unwrap().cursor),
            limit,
        )
        .unwrap();
        assert_eq!(
            first
                .iter()
                .chain(&second)
                .map(|row| row.record.seq)
                .collect::<Vec<_>>(),
            (1..=101).rev().collect::<Vec<_>>()
        );
    }
    let covered = session::latest_sequence(&fresh, &"s".into()).unwrap();
    let visible = overlap
        .into_iter()
        .filter(|event| event.seq > covered)
        .collect::<Vec<_>>();
    assert!(visible.is_empty());
    store
        .submit(|tx| session::append(tx, &flow_event("live", "session.step.started.1"), None))
        .unwrap()
        .wait()
        .unwrap();
    let continued = live.recv_timeout(Duration::from_secs(30)).unwrap();
    assert_eq!(continued.len(), 1);
    assert_eq!(continued[0].seq, covered + 1);
    drop((held, fresh));
    store.shutdown().unwrap();
}

#[test]
fn test_005_065_process_kill_coupled_promotion_barriers_reopen_only_committed_facts() {
    for phase in [
        "event-sequence",
        "message-pending-index",
        "revert",
        "intent",
        "committed",
    ] {
        let root = Root::new();
        let store =
            Store::initialize(root.file(), Options::core(), flow_catalog(), metadata()).unwrap();
        store.submit(flow_seed).unwrap().wait().unwrap();
        store.shutdown().unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "store_flow_kill_worker",
                "--ignored",
                "--nocapture",
            ])
            .env("YCODING_STORE_FLOW_FILE", root.file())
            .env("YCODING_STORE_FLOW_PHASE", phase)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, receiver) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stdout).lines() {
                if line.unwrap() == "STORE-FLOW-BARRIER" {
                    sender.send(()).unwrap();
                    break;
                }
            }
        });
        let ready = receiver.recv_timeout(Duration::from_secs(30));
        child.kill().unwrap();
        let status = child.wait().unwrap();
        reader.join().unwrap();
        ready.unwrap();
        assert!(!status.success());
        let store = Store::open(root.file(), Options::core(), flow_catalog()).unwrap();
        flow_state(&store.snapshot().unwrap(), phase == "committed");
        if phase != "committed" {
            store
                .submit(|tx| flow_promote(tx, |_| {}))
                .unwrap()
                .wait()
                .unwrap();
        }
        flow_state(&store.snapshot().unwrap(), true);
        assert_eq!(
            store
                .submit(|tx| ycoding_store::session::admit(tx, &flow_input()))
                .unwrap()
                .wait()
                .unwrap(),
            ycoding_store::session::Admission::Promoted(flow_message())
        );
        flow_state(&store.snapshot().unwrap(), true);
        store.shutdown().unwrap();
    }
}

#[test]
#[ignore = "subprocess-only process-kill barrier fixture"]
fn store_flow_kill_worker() {
    let store = Store::open(
        std::env::var_os("YCODING_STORE_FLOW_FILE").unwrap(),
        Options::core(),
        flow_catalog(),
    )
    .unwrap();
    let phase = std::env::var("YCODING_STORE_FLOW_PHASE").unwrap();
    let barrier = |current: &str| {
        if current == phase {
            use std::io::{Read, Write};
            println!("STORE-FLOW-BARRIER");
            std::io::stdout().flush().unwrap();
            std::io::stdin().read_exact(&mut [0]).unwrap();
        }
    };
    if matches!(phase.as_str(), "admission" | "pre-wake" | "step") {
        let inside = phase.clone();
        store
            .submit(move |tx| {
                flow_seed(tx)?;
                if inside == "admission" {
                    use std::io::{Read, Write};
                    println!("STORE-FLOW-BARRIER");
                    std::io::stdout().flush().unwrap();
                    std::io::stdin().read_exact(&mut [0]).unwrap();
                }
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
        barrier("pre-wake");
        store
            .submit(|tx| {
                flow_promote(tx, |_| {})?;
                ycoding_store::session::append(
                    tx,
                    &flow_event("step", "session.step.started.1"),
                    None,
                )?;
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
        barrier("step");
        return;
    }
    let inside = phase.clone();
    store
        .submit(move |tx| {
            flow_promote(tx, |current| {
                if current == inside {
                    use std::io::{Read, Write};
                    println!("STORE-FLOW-BARRIER");
                    std::io::stdout().flush().unwrap();
                    std::io::stdin().read_exact(&mut [0]).unwrap();
                }
            })
        })
        .unwrap()
        .wait()
        .unwrap();
    barrier("committed");
}

#[test]
fn test_005_admission_pre_wake_and_step_kills_preserve_durable_input_identity() {
    use ycoding_store::session;
    for phase in ["admission", "pre-wake", "step"] {
        let root = Root::new();
        Store::initialize(root.file(), Options::core(), flow_catalog(), metadata())
            .unwrap()
            .shutdown()
            .unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "store_flow_kill_worker",
                "--ignored",
                "--nocapture",
            ])
            .env("YCODING_STORE_FLOW_FILE", root.file())
            .env("YCODING_STORE_FLOW_PHASE", phase)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, receiver) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stdout).lines() {
                if line.unwrap() == "STORE-FLOW-BARRIER" {
                    sender.send(()).unwrap();
                    break;
                }
            }
        });
        let ready = receiver.recv_timeout(Duration::from_secs(30));
        child.kill().unwrap();
        let status = child.wait().unwrap();
        reader.join().unwrap();
        ready.unwrap();
        assert!(!status.success());
        let store = Store::open(root.file(), Options::core(), flow_catalog()).unwrap();
        let snapshot = store.client().snapshot().unwrap();
        assert_eq!(
            session::latest_sequence(&snapshot, &"s".into()).unwrap(),
            match phase {
                "admission" => -1,
                "pre-wake" => 0,
                _ => 2,
            }
        );
        assert_eq!(
            snapshot
                .get::<session::PendingTable>(&tuple_key(&[KeyPart::String(&"msg_flow".into())]))
                .unwrap(),
            (phase == "pre-wake").then(flow_input)
        );
        assert_eq!(
            snapshot
                .get::<session::MessageTable>(&tuple_key(&[KeyPart::String(&"msg_flow".into())]))
                .unwrap(),
            (phase == "step").then(flow_message)
        );
        let events = snapshot
            .scan::<session::EventTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap();
        assert_eq!(
            events.len(),
            match phase {
                "admission" => 0,
                "pre-wake" => 1,
                _ => 3,
            }
        );
        drop(snapshot);
        if phase == "admission" {
            store.submit(flow_seed).unwrap().wait().unwrap();
        }
        if phase != "step" {
            store
                .submit(|tx| flow_promote(tx, |_| {}))
                .unwrap()
                .wait()
                .unwrap();
        }
        assert_eq!(
            store
                .submit(|tx| session::admit(tx, &flow_input()))
                .unwrap()
                .wait()
                .unwrap(),
            session::Admission::Promoted(flow_message())
        );
        store.shutdown().unwrap();
        let store = Store::open(root.file(), Options::core(), flow_catalog()).unwrap();
        assert!(
            store
                .snapshot()
                .unwrap()
                .get::<session::PendingTable>(&tuple_key(&[KeyPart::String(&"msg_flow".into())]))
                .unwrap()
                .is_none()
        );
        assert_eq!(
            store
                .snapshot()
                .unwrap()
                .get::<session::MessageTable>(&tuple_key(&[KeyPart::String(&"msg_flow".into())]))
                .unwrap(),
            Some(flow_message())
        );
        assert_eq!(
            store
                .snapshot()
                .unwrap()
                .scan::<session::EventTable>(Bound::Unbounded, Bound::Unbounded, 10)
                .unwrap()
                .iter()
                .filter(|event| event.type_.as_str() == Some("session.input.promoted.1"))
                .count(),
            1
        );
        store.shutdown().unwrap();
    }
}

struct Accounts;
#[derive(Debug, PartialEq)]
struct Account {
    id: u64,
    email: Vec<u8>,
    group: i64,
}
impl TableSpec for Accounts {
    type Record = Account;
    const NAME: &'static str = "accounts";
    const INDEXES: &'static [IndexDefinition] = &[
        IndexDefinition::unique("account_email"),
        IndexDefinition::secondary("account_group"),
        IndexDefinition::unique("positive_group"),
    ];
    fn primary_key(record: &Account) -> Vec<u8> {
        tuple_key(&[KeyPart::U64(record.id)])
    }
    fn encode(record: &Account) -> Result<Vec<u8>, Error> {
        Ok([
            record.id.to_be_bytes().as_slice(),
            &record.group.to_be_bytes(),
            &record.email,
        ]
        .concat())
    }
    fn decode(bytes: &[u8]) -> Result<Account, Error> {
        if bytes.len() < 16 {
            return Err(Error::Rejected("invalid account"));
        }
        Ok(Account {
            id: u64::from_be_bytes(bytes[..8].try_into().unwrap()),
            group: i64::from_be_bytes(bytes[8..16].try_into().unwrap()),
            email: bytes[16..].to_vec(),
        })
    }
    fn index_key(index: &IndexDefinition, record: &Account) -> Result<Option<Vec<u8>>, Error> {
        Ok(match index.name {
            "account_email" => Some(tuple_key(&[KeyPart::Bytes(&record.email)])),
            "account_group" => Some(tuple_key(&[KeyPart::I64(record.group)])),
            "positive_group" if record.group > 0 => Some(tuple_key(&[KeyPart::I64(record.group)])),
            "positive_group" => None,
            _ => return Err(Error::Rejected("invalid index")),
        })
    }
}
struct Ledger;
impl TableSpec for Ledger {
    type Record = u64;
    const NAME: &'static str = "ledger";
    const INDEXES: &'static [IndexDefinition] = &[];
    fn primary_key(record: &u64) -> Vec<u8> {
        tuple_key(&[KeyPart::U64(*record)])
    }
    fn encode(record: &u64) -> Result<Vec<u8>, Error> {
        Ok(record.to_be_bytes().to_vec())
    }
    fn decode(bytes: &[u8]) -> Result<u64, Error> {
        Ok(u64::from_be_bytes(
            bytes
                .try_into()
                .map_err(|_| Error::Rejected("invalid ledger"))?,
        ))
    }
    fn index_key(_: &IndexDefinition, _: &u64) -> Result<Option<Vec<u8>>, Error> {
        Err(Error::Rejected("no ledger indexes"))
    }
}
const CATALOG: Catalog = Catalog::new(
    1,
    &[
        TableDeclaration::of::<Accounts>(),
        TableDeclaration::of::<Ledger>(),
    ],
);

#[test]
fn write_index_reads_own_put_delete_and_changed_membership() {
    for file_backed in [false, true] {
        let root = Root::new();
        let store = if file_backed {
            Store::initialize(root.file(), options(), CATALOG, metadata()).unwrap()
        } else {
            Store::disposable(options(), CATALOG, metadata()).unwrap()
        };
        store
            .submit(|tx| {
                tx.put::<Accounts>(&account(2, b"b", -1))?;
                tx.put::<Accounts>(&account(1, b"a", -1))?;
                let group = tuple_key(&[KeyPart::I64(-1)]);
                assert_eq!(
                    tx.index::<Accounts>("account_group", &group, None, 10)?,
                    vec![account(1, b"a", -1), account(2, b"b", -1)]
                );
                assert_eq!(
                    tx.index::<Accounts>("account_group", &group, Some(&key(1)), 1)?,
                    vec![account(2, b"b", -1)]
                );
                assert_eq!(
                    tx.index::<Accounts>(
                        "account_email",
                        &tuple_key(&[KeyPart::Bytes(b"a")]),
                        None,
                        1
                    )?,
                    vec![account(1, b"a", -1)]
                );
                tx.put::<Accounts>(&account(1, b"c", 1))?;
                assert_eq!(
                    tx.index::<Accounts>("account_group", &group, None, 10)?,
                    vec![account(2, b"b", -1)]
                );
                assert!(
                    tx.index::<Accounts>(
                        "account_email",
                        &tuple_key(&[KeyPart::Bytes(b"a")]),
                        None,
                        1
                    )?
                    .is_empty()
                );
                assert_eq!(
                    tx.index::<Accounts>(
                        "positive_group",
                        &tuple_key(&[KeyPart::I64(1)]),
                        None,
                        1
                    )?,
                    vec![account(1, b"c", 1)]
                );
                tx.delete::<Accounts>(&key(2))?;
                assert!(
                    tx.index::<Accounts>("account_group", &group, None, 10)?
                        .is_empty()
                );
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
        store.shutdown().unwrap();
        if file_backed {
            let reopened = Store::open(root.file(), options(), CATALOG).unwrap();
            assert_eq!(
                reopened
                    .snapshot()
                    .unwrap()
                    .index::<Accounts>("positive_group", &tuple_key(&[KeyPart::I64(1)]), None, 10)
                    .unwrap(),
                vec![account(1, b"c", 1)]
            );
        }
    }
}

#[test]
fn domain_reject_latches_and_preserves_error_even_when_closure_returns_ok() {
    for file_backed in [false, true] {
        let root = Root::new();
        let store = if file_backed {
            Store::initialize(root.file(), options(), CATALOG, metadata()).unwrap()
        } else {
            Store::disposable(options(), CATALOG, metadata()).unwrap()
        };
        let result = store
            .submit(|tx| {
                tx.put::<Accounts>(&account(1, b"a", -1))?;
                let error = tx.reject(Error::Domain {
                    kind: "owner_mismatch",
                    message: "record owner does not match",
                });
                assert_eq!(
                    error.to_string(),
                    "domain rejection (owner_mismatch): record owner does not match"
                );
                let _ = tx.reject(Error::Domain {
                    kind: "later_rejection",
                    message: "second domain check",
                });
                tx.put::<Ledger>(&2)?;
                Ok(())
            })
            .unwrap()
            .wait();
        assert!(
            matches!(
                result,
                Err(Error::Domain {
                    kind: "owner_mismatch",
                    message: "record owner does not match"
                })
            ),
            "{result:?}"
        );
        let check = |store: &Store| {
            let snapshot = store.snapshot().unwrap();
            assert_eq!(snapshot.get::<Accounts>(&key(1)).unwrap(), None);
            assert_eq!(snapshot.get::<Ledger>(&key(2)).unwrap(), None);
            assert!(
                snapshot
                    .index::<Accounts>("account_group", &tuple_key(&[KeyPart::I64(-1)]), None, 10)
                    .unwrap()
                    .is_empty()
            );
        };
        check(&store);
        for (error, retained) in [
            (Error::Rejected("reference still exists"), true),
            (Error::InvalidConfiguration("fixture rejection"), false),
        ] {
            let result = store
                .submit(move |tx| {
                    tx.put::<Ledger>(&3)?;
                    let _ = tx.reject(error);
                    Ok(())
                })
                .unwrap()
                .wait();
            assert!(if retained {
                matches!(result, Err(Error::Rejected("reference still exists")))
            } else {
                matches!(result, Err(Error::TransactionAborted))
            });
            assert_eq!(
                store.snapshot().unwrap().get::<Ledger>(&key(3)).unwrap(),
                None
            );
        }
        store.shutdown().unwrap();
        if file_backed {
            let reopened = Store::open(root.file(), options(), CATALOG).unwrap();
            check(&reopened);
        }
    }
}

#[test]
fn committed_snapshot_precedes_next_queued_mutation() {
    let store = Store::disposable(options(), CATALOG, metadata()).unwrap();
    let (reached, started) = mpsc::channel();
    let (release, barrier) = mpsc::channel();
    let receipt = store
        .submit_with_snapshot(move |tx| {
            tx.put::<Ledger>(&1)?;
            reached.send(()).unwrap();
            barrier.recv_timeout(Duration::from_secs(10)).unwrap();
            Ok(7)
        })
        .unwrap();
    started.recv_timeout(Duration::from_secs(10)).unwrap();
    let later = store.submit(|tx| tx.put::<Ledger>(&2)).unwrap();
    release.send(()).unwrap();
    let (value, snapshot) = receipt.wait().unwrap();
    later.wait().unwrap();
    assert_eq!(value, 7);
    assert_eq!(snapshot.get::<Ledger>(&key(1)).unwrap(), Some(1));
    assert_eq!(snapshot.get::<Ledger>(&key(2)).unwrap(), None);
    assert_eq!(
        store.snapshot().unwrap().get::<Ledger>(&key(2)).unwrap(),
        Some(2)
    );
}

#[test]
fn rejected_commit_returns_no_snapshot_and_scan_reads_own_writes() {
    let store = Store::disposable(options(), CATALOG, metadata()).unwrap();
    store
        .submit(|tx| {
            for value in 1..=4 {
                tx.put::<Ledger>(&value)?;
            }
            assert_eq!(
                tx.scan::<Ledger>(Bound::Included(&key(2)), Bound::Excluded(&key(4)), 1)?,
                vec![2]
            );
            assert_eq!(
                tx.scan::<Ledger>(Bound::Excluded(&key(1)), Bound::Unbounded, 2)?,
                vec![2, 3]
            );
            assert!(
                tx.scan::<Ledger>(Bound::Unbounded, Bound::Unbounded, 0)?
                    .is_empty()
            );
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let result = store
        .submit_with_snapshot(|tx| {
            tx.put::<Ledger>(&5)?;
            Err::<(), _>(Error::Rejected("reject snapshot commit"))
        })
        .unwrap()
        .wait();
    assert!(matches!(
        result,
        Err(Error::Rejected("reject snapshot commit"))
    ));
    assert_eq!(
        store.snapshot().unwrap().get::<Ledger>(&key(5)).unwrap(),
        None
    );
}

fn options() -> Options {
    Options {
        cache_bytes: 1024 * 1024,
        queue_capacity: 2,
        max_snapshots: 2,
    }
}
fn metadata() -> Metadata {
    Metadata::new([7; 16], 1)
}
fn account(id: u64, email: &[u8], group: i64) -> Account {
    Account {
        id,
        email: email.to_vec(),
        group,
    }
}
fn key(id: u64) -> Vec<u8> {
    tuple_key(&[KeyPart::U64(id)])
}
struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "ycoding-store-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn file(&self) -> PathBuf {
        self.0.join("store.redb")
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn atomic_commit_rollback_reopen_and_disposable_semantics() {
    for file_backed in [false, true] {
        let root = Root::new();
        let store = if file_backed {
            Store::initialize(root.file(), options(), CATALOG, metadata()).unwrap()
        } else {
            Store::disposable(options(), CATALOG, metadata()).unwrap()
        };
        store
            .submit(|tx| {
                tx.put::<Accounts>(&account(1, b"a", -1))?;
                tx.put::<Ledger>(&1)
            })
            .unwrap()
            .wait()
            .unwrap();
        let result = store
            .submit(|tx| {
                tx.put::<Accounts>(&account(2, b"b", -1))?;
                tx.put::<Ledger>(&2)?;
                Err::<(), _>(Error::Rejected("injected mid-transaction"))
            })
            .unwrap()
            .wait();
        assert!(matches!(result, Err(Error::Rejected(_))));
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.get::<Ledger>(&key(1)).unwrap(), Some(1));
        assert_eq!(snapshot.get::<Ledger>(&key(2)).unwrap(), None);
        assert_eq!(snapshot.get::<Accounts>(&key(2)).unwrap(), None);
        assert!(
            snapshot
                .index::<Accounts>(
                    "account_email",
                    &tuple_key(&[KeyPart::Bytes(b"b")]),
                    None,
                    10
                )
                .unwrap()
                .is_empty()
        );
        drop(snapshot);
        store.shutdown().unwrap();
        let reopened = if file_backed {
            Store::open(root.file(), options(), CATALOG).unwrap()
        } else {
            assert!(!root.file().exists());
            Store::disposable(options(), CATALOG, metadata()).unwrap()
        };
        assert_eq!(reopened.metadata(), &metadata());
        assert_eq!(
            reopened.snapshot().unwrap().get::<Ledger>(&key(1)).unwrap(),
            file_backed.then_some(1)
        );
        assert_eq!(
            reopened.snapshot().unwrap().get::<Ledger>(&key(2)).unwrap(),
            None
        );
        reopened.shutdown().unwrap();
    }
}

#[test]
fn uniqueness_poisoning_updates_partial_membership_and_delete_are_atomic() {
    let store = Store::disposable(options(), CATALOG, metadata()).unwrap();
    store
        .submit(|tx| {
            tx.put::<Accounts>(&account(2, b"b", -1))?;
            tx.put::<Accounts>(&account(1, b"a", -1))
        })
        .unwrap()
        .wait()
        .unwrap();
    let result = store
        .submit(|tx| {
            tx.put::<Ledger>(&9)?;
            tx.put::<Accounts>(&account(3, b"a", 5))
        })
        .unwrap()
        .wait();
    assert!(matches!(
        result,
        Err(Error::UniqueViolation {
            index: "account_email"
        })
    ));
    assert_eq!(
        store.snapshot().unwrap().get::<Ledger>(&key(9)).unwrap(),
        None
    );
    let result = store
        .submit(|tx| {
            let _ = tx.put::<Accounts>(&account(3, b"a", -1));
            tx.put::<Ledger>(&10)?;
            Ok(())
        })
        .unwrap()
        .wait();
    assert!(matches!(result, Err(Error::TransactionAborted)));
    assert_eq!(
        store.snapshot().unwrap().get::<Ledger>(&key(10)).unwrap(),
        None
    );
    let rows = store
        .snapshot()
        .unwrap()
        .index::<Accounts>("account_group", &tuple_key(&[KeyPart::I64(-1)]), None, 10)
        .unwrap();
    assert_eq!(rows.iter().map(|r| r.id).collect::<Vec<_>>(), vec![1, 2]);
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .index::<Accounts>("account_group", &tuple_key(&[KeyPart::I64(-1)]), None, 1)
            .unwrap()
            .iter()
            .map(|r| r.id)
            .collect::<Vec<_>>(),
        vec![1]
    );
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .index::<Accounts>(
                "account_group",
                &tuple_key(&[KeyPart::I64(-1)]),
                Some(&key(1)),
                1
            )
            .unwrap()
            .iter()
            .map(|r| r.id)
            .collect::<Vec<_>>(),
        vec![2]
    );
    store
        .submit(|tx| tx.put::<Accounts>(&account(1, b"c", 5)))
        .unwrap()
        .wait()
        .unwrap();
    assert!(
        store
            .snapshot()
            .unwrap()
            .index::<Accounts>(
                "account_email",
                &tuple_key(&[KeyPart::Bytes(b"a")]),
                None,
                10
            )
            .unwrap()
            .is_empty()
    );
    assert!(matches!(
        store
            .submit(|tx| tx.put::<Accounts>(&account(2, b"b", 5)))
            .unwrap()
            .wait(),
        Err(Error::UniqueViolation {
            index: "positive_group"
        })
    ));
    store
        .submit(|tx| {
            tx.delete::<Accounts>(&key(1))?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    for (name, index_key) in [
        ("account_email", tuple_key(&[KeyPart::Bytes(b"c")])),
        ("positive_group", tuple_key(&[KeyPart::I64(5)])),
    ] {
        assert!(
            store
                .snapshot()
                .unwrap()
                .index::<Accounts>(name, &index_key, None, 10)
                .unwrap()
                .is_empty()
        );
    }
    store.shutdown().unwrap();
}

#[test]
fn snapshot_is_coherent_bounded_and_drop_releases_only_its_permit() {
    let store = Store::disposable(options(), CATALOG, metadata()).unwrap();
    store
        .submit(|tx| tx.put::<Ledger>(&1))
        .unwrap()
        .wait()
        .unwrap();
    let before = store.snapshot().unwrap();
    let other = store.snapshot().unwrap();
    assert!(matches!(store.snapshot(), Err(Error::SnapshotLimit)));
    store
        .submit(|tx| {
            tx.delete::<Ledger>(&key(1))?;
            tx.put::<Ledger>(&2)?;
            tx.put::<Accounts>(&account(2, b"b", -1))
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(before.get::<Ledger>(&key(1)).unwrap(), Some(1));
    assert_eq!(before.get::<Ledger>(&key(2)).unwrap(), None);
    assert_eq!(before.get::<Accounts>(&key(2)).unwrap(), None);
    drop(before);
    let after = store.snapshot().unwrap();
    assert_eq!(after.get::<Ledger>(&key(1)).unwrap(), None);
    assert_eq!(after.get::<Ledger>(&key(2)).unwrap(), Some(2));
    assert_eq!(
        after
            .scan::<Ledger>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap(),
        vec![2]
    );
    assert_eq!(other.get::<Ledger>(&key(1)).unwrap(), Some(1));
    drop((other, after));
    store.shutdown().unwrap();
}

#[test]
fn transaction_work_limit_is_atomic_for_point_and_range_operations() {
    const WORK_LIMIT: usize = 65_536;
    for file_backed in [false, true] {
        let root = Root::new();
        let store = if file_backed {
            Store::initialize(root.file(), options(), CATALOG, metadata()).unwrap()
        } else {
            Store::disposable(options(), CATALOG, metadata()).unwrap()
        };
        store
            .submit(|tx| tx.put::<Accounts>(&account(1, b"a", 1)))
            .unwrap()
            .wait()
            .unwrap();
        for operation in 0..6 {
            for delta in [-1_isize, 0, 1] {
                let result = store
                    .submit(move |tx| {
                        tx.put::<Ledger>(&999)?;
                        let cost = if operation < 3 { 1 } else { 2 };
                        for _ in 0..(WORK_LIMIT - cost - 1).checked_add_signed(delta).unwrap() {
                            tx.get::<Ledger>(&key(0))?;
                        }
                        let result = match operation {
                            0 => tx.get::<Ledger>(&key(999)).map(|_| ()),
                            1 => tx.put::<Ledger>(&999),
                            2 => tx.delete::<Ledger>(&key(888)).map(|_| ()),
                            3 => tx
                                .scan::<Ledger>(Bound::Unbounded, Bound::Unbounded, usize::MAX)
                                .map(|rows| assert_eq!(rows, vec![999])),
                            4 => tx
                                .index::<Accounts>(
                                    "account_group",
                                    &tuple_key(&[KeyPart::I64(1)]),
                                    None,
                                    usize::MAX,
                                )
                                .map(|rows| assert_eq!(rows.len(), 1)),
                            _ => tx
                                .index_range::<Accounts>(
                                    "account_group",
                                    ycoding_store::IndexQuery {
                                        lower: Bound::Unbounded,
                                        upper: Bound::Unbounded,
                                        prefix: None,
                                        order: ycoding_store::IndexOrder::Ascending,
                                        after: None,
                                        limit: usize::MAX,
                                    },
                                )
                                .map(|rows| assert_eq!(rows.len(), 1)),
                        };
                        if delta <= 0 {
                            result?;
                            return Ok(());
                        }
                        assert!(matches!(
                            result,
                            Err(Error::Domain {
                                kind: "transaction_work_limit",
                                ..
                            })
                        ));
                        Ok(())
                    })
                    .unwrap()
                    .wait();
                if delta > 0 {
                    assert!(matches!(
                        result,
                        Err(Error::Domain {
                            kind: "transaction_work_limit",
                            ..
                        })
                    ));
                } else {
                    result.unwrap();
                }
                assert_eq!(
                    store.snapshot().unwrap().get::<Ledger>(&key(999)).unwrap(),
                    (delta <= 0).then_some(999)
                );
                assert!(!store.is_fenced());
                store
                    .submit(|tx| tx.delete::<Ledger>(&key(999)))
                    .unwrap()
                    .wait()
                    .unwrap();
            }
        }
        store.shutdown().unwrap();
    }
}

#[test]
fn saturated_queue_cancellation_commit_receipt_and_joined_shutdown() {
    let root = Root::new();
    let store = Store::initialize(root.file(), options(), CATALOG, metadata()).unwrap();
    let (started, reached) = mpsc::channel();
    let (release, barrier) = mpsc::channel();
    let inflight = store
        .submit(move |tx| {
            tx.put::<Ledger>(&1)?;
            started.send(std::thread::current().id()).unwrap();
            barrier.recv_timeout(Duration::from_secs(10)).unwrap();
            Ok(())
        })
        .unwrap();
    let writer_id = reached.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_ne!(writer_id, std::thread::current().id());
    assert_eq!(
        store.snapshot().unwrap().get::<Ledger>(&key(1)).unwrap(),
        None
    );
    let queued_cancelled = store.submit(|tx| tx.put::<Ledger>(&2)).unwrap();
    let queued = store
        .submit(|tx| {
            tx.put::<Ledger>(&3)?;
            Ok(std::thread::current().id())
        })
        .unwrap();
    assert!(matches!(
        store.submit(|tx| tx.put::<Ledger>(&4)),
        Err(Error::QueueFull)
    ));
    drop((inflight, queued_cancelled));
    release.send(()).unwrap();
    assert_eq!(queued.wait().unwrap(), writer_id);
    assert_eq!(
        store.snapshot().unwrap().get::<Ledger>(&key(1)).unwrap(),
        Some(1)
    );
    assert_eq!(
        store.snapshot().unwrap().get::<Ledger>(&key(2)).unwrap(),
        None
    );
    let drained = store.submit(|tx| tx.put::<Ledger>(&5)).unwrap();
    store.shutdown().unwrap();
    drained.wait().unwrap();
    let reopened = Store::open(root.file(), options(), CATALOG).unwrap();
    let snapshot = reopened.snapshot().unwrap();
    for id in [1, 3, 5] {
        assert_eq!(snapshot.get::<Ledger>(&key(id)).unwrap(), Some(id));
    }
    for id in [2, 4] {
        assert_eq!(snapshot.get::<Ledger>(&key(id)).unwrap(), None);
    }
    drop(snapshot);
    reopened.shutdown().unwrap();
}

#[test]
fn selected_writer_queue_and_snapshot_bounds_reject_one_past_capacity() {
    for max_snapshots in [Options::core().max_snapshots, 256] {
        let root = Root::new();
        let store = Store::initialize(
            root.file(),
            Options {
                cache_bytes: 1024 * 1024,
                max_snapshots,
                ..Options::core()
            },
            CATALOG,
            metadata(),
        )
        .unwrap();
        let snapshots = (0..max_snapshots)
            .map(|_| store.snapshot().unwrap())
            .collect::<Vec<_>>();
        assert!(matches!(store.snapshot(), Err(Error::SnapshotLimit)));
        let (started, reached) = mpsc::channel();
        let (release, barrier) = mpsc::channel();
        let active = store
            .submit(move |tx| {
                started.send(()).unwrap();
                barrier.recv_timeout(Duration::from_secs(20)).unwrap();
                tx.put::<Ledger>(&1)
            })
            .unwrap();
        reached.recv_timeout(Duration::from_secs(20)).unwrap();
        let queued = (0..256)
            .map(|_| store.submit(|tx| tx.get::<Ledger>(&key(1))).unwrap())
            .collect::<Vec<_>>();
        assert!(matches!(
            store.submit(|tx| tx.put::<Ledger>(&2)),
            Err(Error::QueueFull)
        ));
        release.send(()).unwrap();
        active.wait().unwrap();
        for receipt in queued {
            assert_eq!(receipt.wait().unwrap(), Some(1));
        }
        drop(snapshots);
        assert_eq!(
            store.snapshot().unwrap().get::<Ledger>(&key(2)).unwrap(),
            None
        );
        store
            .submit(|tx| tx.put::<Ledger>(&3))
            .unwrap()
            .wait()
            .unwrap();
        store.shutdown().unwrap();
    }
}

#[test]
fn missing_corrupt_empty_existing_and_incompatible_fail_closed() {
    use redb::ReadableDatabase;
    let root = Root::new();
    assert!(Store::open(root.file(), options(), CATALOG).is_err());
    assert!(!root.file().exists());
    for bytes in [b"".as_slice(), b"not redb"] {
        std::fs::write(root.file(), bytes).unwrap();
        assert!(Store::open(root.file(), options(), CATALOG).is_err());
        assert!(Store::initialize(root.file(), options(), CATALOG, metadata()).is_err());
        assert_eq!(std::fs::read(root.file()).unwrap(), bytes);
    }
    let valid = Root::new();
    Store::initialize(valid.file(), options(), CATALOG, metadata())
        .unwrap()
        .shutdown()
        .unwrap();
    assert!(Store::initialize(valid.file(), options(), CATALOG, metadata()).is_err());
    assert!(Store::open(valid.file(), options(), Catalog::new(2, CATALOG.tables())).is_err());
    assert!(Store::open(valid.file(), options(), Catalog::EMPTY).is_err());
    for (field, bad) in [
        ("physical_format", b"sqlite".to_vec()),
        ("catalog_version", 2_u64.to_be_bytes().to_vec()),
        ("record_codec_version", 2_u64.to_be_bytes().to_vec()),
        ("key_codec_version", 2_u64.to_be_bytes().to_vec()),
        ("generation", 0_u64.to_be_bytes().to_vec()),
        ("database_identity", vec![0; 16]),
    ] {
        let root = Root::new();
        Store::initialize(root.file(), options(), CATALOG, metadata())
            .unwrap()
            .shutdown()
            .unwrap();
        let db = redb::Database::open(root.file()).unwrap();
        let write = db.begin_write().unwrap();
        {
            let mut table = write
                .open_table(redb::TableDefinition::<&[u8], &[u8]>::new(
                    "storage_metadata",
                ))
                .unwrap();
            table.insert(field.as_bytes(), bad.as_slice()).unwrap();
        }
        write.commit().unwrap();
        drop(db);
        assert!(matches!(
            Store::open(root.file(), options(), CATALOG),
            Err(Error::Incompatible(_))
        ));
        let db = redb::Database::open(root.file()).unwrap();
        let read = db.begin_read().unwrap();
        let table = read
            .open_table(redb::TableDefinition::<&[u8], &[u8]>::new(
                "storage_metadata",
            ))
            .unwrap();
        assert_eq!(table.get(field.as_bytes()).unwrap().unwrap().value(), bad);
    }
}

#[test]
fn empty_catalog_and_configuration_have_no_placeholder_domain_tables() {
    let store = Store::disposable(Options::core(), Catalog::EMPTY, metadata()).unwrap();
    assert_eq!(store.catalog().tables(), &[]);
    assert_eq!(Options::core().cache_bytes, 128 * 1024 * 1024);
    assert_eq!(Options::meeting().cache_bytes, 64 * 1024 * 1024);
    store.shutdown().unwrap();
    for options in [
        Options {
            queue_capacity: 257,
            ..options()
        },
        Options {
            queue_capacity: 0,
            ..options()
        },
        Options {
            cache_bytes: 0,
            ..options()
        },
        Options {
            max_snapshots: 0,
            ..options()
        },
    ] {
        assert!(matches!(
            Store::disposable(options, CATALOG, metadata()),
            Err(Error::InvalidConfiguration(_))
        ));
    }
}

#[test]
fn transaction_panic_rolls_back_fences_and_shutdown_joins() {
    let root = Root::new();
    let store = Store::initialize(root.file(), options(), CATALOG, metadata()).unwrap();
    assert!(matches!(
        store
            .submit(|tx| {
                tx.put::<Ledger>(&1)?;
                panic!("injected transaction panic");
                #[allow(unreachable_code)]
                Ok(())
            })
            .unwrap()
            .wait(),
        Err(Error::WriterPanicked)
    ));
    assert!(matches!(
        store.submit(|tx| tx.put::<Ledger>(&2)),
        Err(Error::WriterFenced)
    ));
    store.shutdown().unwrap();
    let store = Store::open(root.file(), options(), CATALOG).unwrap();
    assert_eq!(
        store.snapshot().unwrap().get::<Ledger>(&key(1)).unwrap(),
        None
    );
    store.shutdown().unwrap();
}

#[test]
fn receipt_future_wakes_only_after_commit() {
    use std::future::Future;
    use std::pin::Pin;
    use std::task::{Context, Poll, Wake, Waker};
    struct Signal(mpsc::Sender<()>);
    impl Wake for Signal {
        fn wake(self: Arc<Self>) {
            self.0.send(()).unwrap();
        }
    }
    let store = Store::disposable(options(), CATALOG, metadata()).unwrap();
    let (release, barrier) = mpsc::channel();
    let mut receipt = store
        .submit(move |tx| {
            barrier.recv_timeout(Duration::from_secs(10)).unwrap();
            tx.put::<Ledger>(&1)
        })
        .unwrap();
    let (send, wake) = mpsc::channel();
    let waker = Waker::from(Arc::new(Signal(send)));
    let mut context = Context::from_waker(&waker);
    assert!(matches!(
        Pin::new(&mut receipt).poll(&mut context),
        Poll::Pending
    ));
    release.send(()).unwrap();
    wake.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(matches!(
        Pin::new(&mut receipt).poll(&mut context),
        Poll::Ready(Ok(()))
    ));
    assert_eq!(
        store.snapshot().unwrap().get::<Ledger>(&key(1)).unwrap(),
        Some(1)
    );
    store.shutdown().unwrap();
}

#[test]
fn tuple_codec_properties_logical_order_equals_byte_order() {
    let unsigned = [0, 1, 255, 256, u64::MAX / 2, u64::MAX];
    let signed = [i64::MIN, i64::MIN + 1, -256, -1, 0, 1, 256, i64::MAX];
    for a in unsigned {
        for b in unsigned {
            assert_eq!(
                a.cmp(&b),
                tuple_key(&[KeyPart::U64(a)]).cmp(&tuple_key(&[KeyPart::U64(b)]))
            );
        }
    }
    for a in signed {
        for b in signed {
            assert_eq!(
                a.cmp(&b),
                tuple_key(&[KeyPart::I64(a)]).cmp(&tuple_key(&[KeyPart::I64(b)]))
            );
        }
    }
    let alphabet = [0_u8, 1, 127, 255];
    let bytes: Vec<Vec<u8>> = std::iter::once(vec![])
        .chain(alphabet.into_iter().map(|a| vec![a]))
        .chain(
            alphabet
                .into_iter()
                .flat_map(|a| alphabet.into_iter().map(move |b| vec![a, b])),
        )
        .collect();
    for a in &bytes {
        for b in &bytes {
            assert_eq!(
                a.cmp(b),
                tuple_key(&[KeyPart::Bytes(a)]).cmp(&tuple_key(&[KeyPart::Bytes(b)]))
            );
            for suffix in unsigned {
                assert_eq!(
                    (a, 0_u64).cmp(&(b, suffix)),
                    tuple_key(&[KeyPart::Bytes(a), KeyPart::U64(0)])
                        .cmp(&tuple_key(&[KeyPart::Bytes(b), KeyPart::U64(suffix)]))
                );
            }
        }
    }
    let units = [0_u16, 1, 255, 256, 0xd800, 0xdc00, 0xffff];
    let strings: Vec<_> = std::iter::once(vec![])
        .chain(units.into_iter().map(|a| vec![a]))
        .chain(
            units
                .into_iter()
                .flat_map(|a| units.into_iter().map(move |b| vec![a, b])),
        )
        .map(LosslessString::from_utf16)
        .collect();
    for a in &strings {
        for b in &strings {
            assert_eq!(
                a.cmp(b),
                tuple_key(&[KeyPart::String(a)]).cmp(&tuple_key(&[KeyPart::String(b)]))
            );
        }
    }
    let mut seed = 0x1256_9931_7701_u64;
    for _ in 0..4096 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let a = seed;
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let b = seed;
        assert_eq!(a.cmp(&b), key(a).cmp(&key(b)));
        assert_eq!(
            (a as i64).cmp(&(b as i64)),
            tuple_key(&[KeyPart::I64(a as i64)]).cmp(&tuple_key(&[KeyPart::I64(b as i64)]))
        );
    }
    assert_eq!(tuple_key(&[KeyPart::Null]).cmp(&key(0)), Ordering::Less);
    assert!(
        tuple_key(&[KeyPart::Bytes(b"a"), KeyPart::Bytes(b"bc")])
            != tuple_key(&[KeyPart::Bytes(b"ab"), KeyPart::Bytes(b"c")])
    );
    assert!(tuple_key(&[KeyPart::Bytes(b"a")]) < tuple_key(&[KeyPart::Bytes(b"a"), KeyPart::Null]));
    for a in [None, Some(i64::MIN), Some(-1), Some(0), Some(i64::MAX)] {
        for b in [None, Some(i64::MIN), Some(-1), Some(0), Some(i64::MAX)] {
            for left in &bytes {
                for right in &bytes {
                    let left_key =
                        tuple_key(&[a.map_or(KeyPart::Null, KeyPart::I64), KeyPart::Bytes(left)]);
                    let right_key =
                        tuple_key(&[b.map_or(KeyPart::Null, KeyPart::I64), KeyPart::Bytes(right)]);
                    assert_eq!((a, left).cmp(&(b, right)), left_key.cmp(&right_key));
                }
            }
        }
    }
}

#[test]
fn duplicate_race_is_serialized_and_databases_are_isolated() {
    let core = Store::disposable(options(), CATALOG, metadata()).unwrap();
    let client = core.client();
    let meeting = Store::disposable(options(), CATALOG, Metadata::new([8; 16], 1)).unwrap();
    std::thread::scope(|scope| {
        let a = scope.spawn(|| {
            client
                .submit(|tx| tx.put::<Accounts>(&account(1, b"same", -1)))
                .unwrap()
                .wait()
        });
        let b = scope.spawn(|| {
            client
                .submit(|tx| tx.put::<Accounts>(&account(2, b"same", -1)))
                .unwrap()
                .wait()
        });
        let results = [a.join().unwrap(), b.join().unwrap()];
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|r| matches!(r, Err(Error::UniqueViolation { .. })))
                .count(),
            1
        );
    });
    assert!(
        meeting
            .snapshot()
            .unwrap()
            .index::<Accounts>(
                "account_email",
                &tuple_key(&[KeyPart::Bytes(b"same")]),
                None,
                10
            )
            .unwrap()
            .is_empty()
    );
    core.shutdown().unwrap();
    meeting.shutdown().unwrap();
}

#[test]
fn catalog_registration_and_real_file_writer_ownership_fail_closed() {
    const DUPLICATE: Catalog = Catalog::new(
        1,
        &[
            TableDeclaration::of::<Ledger>(),
            TableDeclaration::of::<Ledger>(),
        ],
    );
    assert!(matches!(
        Store::disposable(options(), DUPLICATE, metadata()),
        Err(Error::InvalidConfiguration(_))
    ));
    let root = Root::new();
    let store = Store::initialize(root.file(), options(), Catalog::EMPTY, metadata()).unwrap();
    assert!(Store::open(root.file(), options(), Catalog::EMPTY).is_err());
    assert!(matches!(
        store.submit(|tx| tx.put::<Ledger>(&1)).unwrap().wait(),
        Err(Error::UnregisteredTable("ledger"))
    ));
    drop(store);
    Store::open(root.file(), options(), Catalog::EMPTY)
        .unwrap()
        .shutdown()
        .unwrap();
    let naked = Root::new();
    drop(redb::Database::create(naked.file()).unwrap());
    assert!(matches!(
        Store::open(naked.file(), options(), CATALOG),
        Err(Error::Incompatible(_))
    ));
    let root = Root::new();
    Store::initialize(root.file(), options(), CATALOG, metadata())
        .unwrap()
        .shutdown()
        .unwrap();
    let db = redb::Database::open(root.file()).unwrap();
    let tx = db.begin_write().unwrap();
    drop(
        tx.open_table(redb::TableDefinition::<&[u8], &[u8]>::new("unregistered"))
            .unwrap(),
    );
    tx.commit().unwrap();
    drop(db);
    assert!(matches!(
        Store::open(root.file(), options(), CATALOG),
        Err(Error::Incompatible(_))
    ));
}

#[test]
fn queue_capacity_boundaries_and_drop_join() {
    for capacity in [1, 2, 256] {
        let store = Store::disposable(
            Options {
                queue_capacity: capacity,
                ..options()
            },
            CATALOG,
            metadata(),
        )
        .unwrap();
        let (started, reached) = mpsc::channel();
        let (release, barrier) = mpsc::channel();
        let inflight = store
            .submit(move |tx| {
                started.send(()).unwrap();
                barrier.recv_timeout(Duration::from_secs(10)).unwrap();
                tx.put::<Ledger>(&0)
            })
            .unwrap();
        reached.recv_timeout(Duration::from_secs(10)).unwrap();
        let queued: Vec<_> = (1..=capacity)
            .map(|id| {
                store
                    .submit(move |tx| tx.put::<Ledger>(&(id as u64)))
                    .unwrap()
            })
            .collect();
        assert!(matches!(store.submit(|_| Ok(())), Err(Error::QueueFull)));
        release.send(()).unwrap();
        drop(store);
        inflight.wait().unwrap();
        for receipt in queued {
            receipt.wait().unwrap();
        }
    }
}

#[test]
fn immediate_commit_survives_process_exit_but_uncommitted_changes_do_not() {
    for committed in [false, true] {
        let root = Root::new();
        Store::initialize(root.file(), options(), CATALOG, metadata())
            .unwrap()
            .shutdown()
            .unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "process_exit_worker", "--ignored"])
            .env("YCODING_STORE_CRASH_PATH", root.file())
            .env(
                "YCODING_STORE_CRASH_COMMITTED",
                if committed { "yes" } else { "no" },
            )
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(17));
        let store = Store::open(root.file(), options(), CATALOG).unwrap();
        assert_eq!(
            store.snapshot().unwrap().get::<Ledger>(&key(1)).unwrap(),
            committed.then_some(1)
        );
        assert_eq!(
            store.snapshot().unwrap().get::<Accounts>(&key(1)).unwrap(),
            committed.then_some(account(1, b"a", -1))
        );
        assert_eq!(
            store
                .snapshot()
                .unwrap()
                .index::<Accounts>(
                    "account_email",
                    &tuple_key(&[KeyPart::Bytes(b"a")]),
                    None,
                    10
                )
                .unwrap()
                .len(),
            usize::from(committed)
        );
        store.shutdown().unwrap();
    }
}

#[test]
#[ignore = "subprocess-only abrupt-exit fixture"]
fn process_exit_worker() {
    let store = Store::open(
        std::env::var_os("YCODING_STORE_CRASH_PATH").unwrap(),
        options(),
        CATALOG,
    )
    .unwrap();
    let committed = std::env::var("YCODING_STORE_CRASH_COMMITTED").unwrap() == "yes";
    store
        .submit(move |tx| {
            tx.put::<Ledger>(&1)?;
            tx.put::<Accounts>(&account(1, b"a", -1))?;
            if !committed {
                std::process::exit(17);
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    std::process::exit(17);
}

#[test]
fn write_reads_its_changes_and_snapshot_ranges_are_ordered_bounded() {
    let store = Store::disposable(options(), CATALOG, metadata()).unwrap();
    let returned = store
        .submit(|tx| {
            tx.put::<Accounts>(&account(1, b"a", -1))?;
            let mut row = tx.get::<Accounts>(&key(1))?.unwrap();
            row.group -= 1;
            tx.put::<Accounts>(&row)?;
            for id in 1..=3 {
                tx.put::<Ledger>(&id)?;
            }
            Ok(row)
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(returned, account(1, b"a", -2));
    let snapshot = store.snapshot().unwrap();
    assert_eq!(snapshot.get::<Accounts>(&key(1)).unwrap(), Some(returned));
    assert_eq!(
        snapshot
            .scan::<Ledger>(Bound::Included(&key(1)), Bound::Excluded(&key(3)), 10)
            .unwrap(),
        vec![1, 2]
    );
    assert_eq!(
        snapshot
            .scan::<Ledger>(Bound::Unbounded, Bound::Unbounded, 1)
            .unwrap(),
        vec![1]
    );
    assert!(
        snapshot
            .scan::<Ledger>(Bound::Unbounded, Bound::Unbounded, 0)
            .unwrap()
            .is_empty()
    );
    drop(snapshot);
    let result = store
        .submit(|tx| {
            tx.delete::<Accounts>(&key(1))?;
            Err::<(), _>(Error::Rejected("abort delete"))
        })
        .unwrap()
        .wait();
    assert!(result.is_err());
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .index::<Accounts>("account_group", &tuple_key(&[KeyPart::I64(-2)]), None, 10)
            .unwrap()
            .len(),
        1
    );
    store.shutdown().unwrap();
}

#[test]
fn clients_cannot_retain_admission_after_owner_shutdown_or_self_join() {
    fn send_sync<T: Send + Sync>() {}
    send_sync::<ycoding_store::Client>();
    let root = Root::new();
    let store = Store::initialize(root.file(), options(), CATALOG, metadata()).unwrap();
    let client = store.client();
    let nested = client.clone();
    store
        .submit(move |tx| {
            assert!(matches!(nested.submit(|_| Ok(())), Err(Error::Reentrant)));
            tx.put::<Ledger>(&1)
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = client.snapshot().unwrap();
    store.shutdown().unwrap();
    assert!(matches!(client.submit(|_| Ok(())), Err(Error::Closed)));
    assert!(matches!(client.snapshot(), Err(Error::Closed)));
    assert_eq!(snapshot.get::<Ledger>(&key(1)).unwrap(), Some(1));
    assert!(Store::open(root.file(), options(), CATALOG).is_err());
    drop(snapshot);
    Store::open(root.file(), options(), CATALOG)
        .unwrap()
        .shutdown()
        .unwrap();
}

#[test]
fn cancelling_a_read_future_drops_only_its_snapshot() {
    use std::future::Future;
    use std::task::{Context, Poll, Waker};
    let store = Store::disposable(options(), CATALOG, metadata()).unwrap();
    store
        .submit(|tx| tx.put::<Ledger>(&1))
        .unwrap()
        .wait()
        .unwrap();
    let survivor = store.snapshot().unwrap();
    let client = store.client();
    let mut read = Box::pin(async move {
        let snapshot = client.snapshot().unwrap();
        std::future::pending::<()>().await;
        drop(snapshot);
    });
    assert!(matches!(
        read.as_mut().poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    assert!(matches!(store.snapshot(), Err(Error::SnapshotLimit)));
    drop(read);
    let next = store.snapshot().unwrap();
    assert_eq!(survivor.get::<Ledger>(&key(1)).unwrap(), Some(1));
    assert_eq!(next.get::<Ledger>(&key(1)).unwrap(), Some(1));
    drop((survivor, next));
    store.shutdown().unwrap();
}
