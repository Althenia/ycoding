use std::{
    collections::BTreeSet,
    ops::Bound,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use ycoding_core::session::{
    compaction_job::AdmitInput, history_pruning, live_state, pending::Request, revert,
    store::Service,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, event, parse_json, session, session_compaction,
    session_message, session_pending,
};
use ycoding_store::{
    IndexOrder, IndexQuery, Store,
    resources::{Request as LedgerRow, RequestTable},
    session::{
        ContextStateTable, Document, EventTable, JobTable, MessageTable, SessionTable,
        latest_sequence,
    },
};

#[path = "session_support/mod.rs"]
mod support;

#[path = "session_support/checkpoint.rs"]
mod checkpoint;

const DAY: i64 = 24 * 60 * 60 * 1000;
const RETAINED_ERRORS: [&str; 4] = [
    "session.compaction.failed.2",
    "session.execution.failed.1",
    "session.step.failed.1",
    "session.tool.failed.1",
];
const RETAINED_HISTORY: [&str; 6] = [
    "session.compaction.admitted.2",
    "session.compaction.started.2",
    "session.context.observed.1:team-view",
    "session.input.admitted.1",
    "session.input.consumed.1",
    "session.input.promoted.1",
];

fn none() -> Vec<session::Id> {
    Vec::new()
}

fn file_store(path: &std::path::Path, identity: u8) -> Store {
    let fixture = support::store();
    let projects = fixture
        .snapshot()
        .unwrap()
        .scan::<ycoding_store::project::ProjectTable>(Bound::Unbounded, Bound::Unbounded, 10)
        .unwrap();
    let store = Store::initialize(
        path,
        ycoding_store::Options::core(),
        fixture.catalog(),
        ycoding_store::Metadata::new([identity; 16], 1),
    )
    .unwrap();
    store
        .submit(move |tx| {
            for project in projects {
                ycoding_store::project::ProjectTable::insert(tx, &project)?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    store
}

fn rows(store: &Store, session: &str) -> Vec<ycoding_store::session::Message> {
    ycoding_store::session::messages(
        &store.snapshot().unwrap(),
        &session.into(),
        Bound::Unbounded,
        Bound::Unbounded,
        IndexOrder::Ascending,
        None,
        100_000,
    )
    .unwrap()
    .into_iter()
    .map(|row| row.record)
    .collect()
}

fn events(store: &Store, session: &str) -> Vec<ycoding_store::session::Event> {
    let prefix = checkpoint::key(session);
    store
        .snapshot()
        .unwrap()
        .index_range::<EventTable>(
            "event_aggregate_seq_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Ascending,
                after: None,
                limit: 100_000,
            },
        )
        .unwrap()
        .into_iter()
        .map(|row| row.record)
        .collect()
}

fn counts(store: &Store, session: &str) -> (usize, usize) {
    (rows(store, session).len(), events(store, session).len())
}

fn types_below(store: &Store, session: &str, through: i64) -> Vec<String> {
    events(store, session)
        .into_iter()
        .filter(|event| event.seq < through)
        .map(|event| {
            let type_ = event.type_.to_utf8().unwrap();
            match &event.data {
                JsonValue::Object(data) if type_ == "session.context.observed.1" => {
                    match data.get(&"source".into()) {
                        Some(JsonValue::String(source)) => {
                            format!("{type_}:{}", source.to_utf8().unwrap())
                        }
                        _ => type_,
                    }
                }
                _ => type_,
            }
        })
        .collect()
}

fn distinct(types: &[String]) -> Vec<String> {
    types
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn sorted(values: &[&str]) -> Vec<String> {
    let mut values = values
        .iter()
        .map(|value| value.to_string())
        .collect::<Vec<_>>();
    values.sort();
    values
}

fn ledger(store: &Store) -> Vec<LedgerRow> {
    store
        .snapshot()
        .unwrap()
        .scan::<RequestTable>(Bound::Unbounded, Bound::Unbounded, 1000)
        .unwrap()
}

fn totals(store: &Store, session: &str) -> (f64, i64, i64) {
    let row = store
        .snapshot()
        .unwrap()
        .get::<SessionTable>(&checkpoint::key(session))
        .unwrap()
        .unwrap();
    (row.cost, row.tokens_input, row.tokens_output)
}

fn admission(session: &str, input: &str, kind: &str, text: &str) -> Request {
    Request {
        id: checkpoint::message_id(input),
        session_id: checkpoint::id(session),
        input: session_pending::Message::decode(
            &parse_json(&format!(
                r#"{{"type":"{kind}","data":{{"text":"{text}"}},"delivery":"steer"}}"#
            ))
            .unwrap(),
        )
        .unwrap(),
        event_id: event::Id::new(format!("evt_retry_{text}").replace(' ', "_")).unwrap(),
        created: 9_000,
    }
}

fn admitted_text(row: &ycoding_store::session::Pending) -> String {
    let JsonValue::Object(data) = &row.data else {
        panic!()
    };
    let Some(JsonValue::String(text)) = data.get(&"text".into()) else {
        panic!()
    };
    text.to_utf8().unwrap()
}

struct NoSnapshots;

impl revert::Snapshots for NoSnapshots {
    fn capture(&self) -> Option<ycoding_schema::snapshot::Id> {
        None
    }

    fn files(
        &self,
        _: &ycoding_schema::snapshot::Id,
        _: &ycoding_schema::snapshot::Id,
    ) -> Result<Vec<ycoding_schema::schema::RelativePath>, revert::SnapshotFailure> {
        Ok(Vec::new())
    }

    fn restore(
        &self,
        _: &[(
            ycoding_schema::schema::RelativePath,
            ycoding_schema::snapshot::Id,
        )],
    ) -> Result<(), revert::SnapshotFailure> {
        Ok(())
    }

    fn diff(
        &self,
        _: &ycoding_schema::snapshot::Id,
        _: &ycoding_schema::snapshot::Id,
        _: &[ycoding_schema::schema::RelativePath],
    ) -> Result<Vec<ycoding_schema::file_diff::Info>, revert::SnapshotFailure> {
        Ok(Vec::new())
    }
}

async fn stage_revert(service: &Service, session: &session::Id, to: &str) {
    let info = service.get(session).unwrap().unwrap();
    revert::stage(
        service,
        &NoSnapshots,
        &info,
        &checkpoint::message_id(to),
        false,
        9_500,
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn pruning_preserves_required_rows_events_usage_and_request_ledger() {
    let store = support::store();
    let client = store.client();
    let service = Service::new(client.clone());
    let scenario = checkpoint::scenario(&client, &service, "ses_main", 1_000).await;
    let session = &scenario.session;
    checkpoint::publish(
        &service,
        "ses_main",
        "session.usage.recorded.1",
        1_000,
        r#","source":"decision","cost":0.25,"tokens":{"input":3,"output":2,"reasoning":0,"cache":{"read":0,"write":0}}"#,
    )
    .await;
    let (first_user, first_answer) = (
        scenario.ids.first_user.clone(),
        scenario.ids.first_answer.clone(),
    );
    client
        .submit(move |tx| {
            RequestTable::insert(
                tx,
                &LedgerRow {
                    id: "preq_covered".into(),
                    session_id: "ses_main".into(),
                    input_id: Some(first_user.as_str().into()),
                    assistant_message_id: Some(first_answer.as_str().into()),
                    connection_identity_digest: None,
                    source: "step".into(),
                    agent: "build".into(),
                    model: Document::new(
                        parse_json(r#"{"providerID":"test","id":"summary-model"}"#).unwrap(),
                    )?,
                    route_id: "openai-chat".into(),
                    prompt_cache_key: "key".into(),
                    system_digest: "system".into(),
                    tool_digest: "tools".into(),
                    request: 1,
                    attempts: 1,
                    invalidation: "none".into(),
                    continuation: "full".into(),
                    cache_read_reported: None,
                    timing: None,
                    cost: Some(0.5),
                    tokens: Document::new(
                        parse_json(
                            r#"{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}"#,
                        )
                        .unwrap(),
                    )?,
                    time_created: 1_000,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let before = counts(&store, "ses_main");
    let history = service.compaction_history(session).unwrap();
    let usage = totals(&store, "ses_main");
    let requests = ledger(&store);
    let sequence = latest_sequence(&store.snapshot().unwrap(), &"ses_main".into()).unwrap();
    assert!(usage.0 > 0.0);
    assert_eq!(requests.len(), 1);

    let pruned = service.prune_compacted(session, 1_000, none).await.unwrap();
    let after = counts(&store, "ses_main");
    assert!(pruned.messages > 0);
    assert_eq!(pruned.messages, before.0 - after.0);
    assert_eq!(pruned.events, before.1 - after.1);

    let remaining = rows(&store, "ses_main");
    let below = remaining
        .iter()
        .filter(|row| row.seq < scenario.through)
        .collect::<Vec<_>>();
    assert_eq!(
        below
            .iter()
            .map(|row| row.type_.to_utf8().unwrap())
            .collect::<Vec<_>>(),
        ["user", "compaction", "user"]
    );
    assert_eq!(below[0].id.to_utf8().unwrap(), scenario.ids.first_user);
    assert_eq!(below[2].id.to_utf8().unwrap(), scenario.ids.fork_target);
    let ids = remaining
        .iter()
        .map(|row| row.id.to_utf8().unwrap())
        .collect::<Vec<_>>();
    for kept in [
        &scenario.ids.boundary,
        &scenario.ids.tail_user,
        &scenario.ids.tail_answer,
        &scenario.ids.failed_tail,
    ] {
        assert!(ids.contains(kept));
    }
    assert_eq!(
        remaining
            .iter()
            .filter(|row| row.type_.as_str() == Some("compaction"))
            .count(),
        3
    );

    let types = types_below(&store, "ses_main", scenario.through);
    let mut expected = sorted(&RETAINED_HISTORY);
    expected.extend(sorted(&RETAINED_ERRORS));
    expected.sort();
    assert_eq!(distinct(&types), expected);
    assert_eq!(
        types
            .iter()
            .filter(|type_| *type_ == "session.input.consumed.1")
            .count(),
        2
    );
    assert_eq!(
        types
            .iter()
            .filter(|type_| *type_ == "session.input.promoted.1")
            .count(),
        3
    );

    let kept = service.compaction_history(session).unwrap();
    assert_eq!(kept, history);
    assert_eq!(kept.total_saved_tokens.encode(), JsonValue::Number(900.0));
    assert_eq!(kept.completed_count.encode(), JsonValue::Number(1.0));
    assert_eq!(
        kept.data
            .iter()
            .filter(|job| job.status.encode() == JsonValue::String("failed".into()))
            .count(),
        2
    );
    assert_eq!(
        kept.data
            .iter()
            .filter(|job| job.status.encode() == JsonValue::String("completed".into()))
            .count(),
        1
    );
    assert_eq!(totals(&store, "ses_main"), usage);
    assert_eq!(ledger(&store), requests);
    assert_eq!(
        latest_sequence(&store.snapshot().unwrap(), &"ses_main".into()).unwrap(),
        sequence
    );

    checkpoint::publish(
        &service,
        "ses_main",
        "session.synthetic.1",
        1_000,
        r#","text":"After pruning""#,
    )
    .await;
    let appended = events(&store, "ses_main");
    assert_eq!(appended.last().unwrap().seq, sequence + 1);

    assert_eq!(
        service.prune_compacted(session, 1_000, none).await.unwrap(),
        history_pruning::Pruned::default()
    );
    assert_eq!(counts(&store, "ses_main"), (after.0 + 1, after.1 + 1));
}

#[tokio::test]
async fn covering_job_errors_expire_after_seven_days() {
    let store = support::store();
    let client = store.client();
    let service = Service::new(client.clone());
    let scenario = checkpoint::scenario(&client, &service, "ses_main", 1_000).await;
    let session = &scenario.session;
    let errors = || {
        let mut found = types_below(&store, "ses_main", scenario.through)
            .into_iter()
            .filter(|type_| RETAINED_ERRORS.contains(&type_.as_str()))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        found.sort();
        found
    };

    service.prune_compacted(session, 1_000, none).await.unwrap();
    assert_eq!(errors(), sorted(&RETAINED_ERRORS));
    service
        .prune_compacted(session, 1_000 + 7 * DAY - 1, none)
        .await
        .unwrap();
    assert_eq!(errors(), sorted(&RETAINED_ERRORS));

    let expired = service
        .prune_compacted(session, 1_000 + 7 * DAY, none)
        .await
        .unwrap();
    assert_eq!(expired.messages, 0);
    assert!(expired.events > 0);
    assert!(errors().is_empty());
    assert_eq!(
        distinct(&types_below(&store, "ses_main", scenario.through)),
        sorted(&RETAINED_HISTORY)
    );
    assert!(
        events(&store, "ses_main")
            .iter()
            .filter(|event| event.seq > scenario.through)
            .any(|event| event.type_.as_str() == Some("session.step.failed.1"))
    );
    assert_eq!(
        service
            .prune_compacted(session, 1_000 + 7 * DAY, none)
            .await
            .unwrap(),
        history_pruning::Pruned::default()
    );
}

#[tokio::test]
async fn pruning_rechecks_active_revert_job_and_digest_per_batch() {
    let store = support::store();
    let client = store.client();
    let service = Service::new(client.clone());

    let mut untouched = Vec::new();
    for (name, kind) in [
        ("ses_failed", checkpoint::Compaction::Failed),
        ("ses_remote", checkpoint::Compaction::Remote),
    ] {
        checkpoint::session(&client, name);
        checkpoint::user(&service, name, "Only request", 1).await;
        let answer = checkpoint::run(
            &service,
            name,
            "Only answer",
            checkpoint::Outcome::Succeeded,
            1,
        )
        .await;
        checkpoint::compaction(&client, &service, name, &answer, kind, 1).await;
        checkpoint::user(&service, name, "Later request", 1).await;
        untouched.push(name);
    }

    let pending = checkpoint::scenario(&client, &service, "ses_pending", 1).await;
    let revision = store
        .snapshot()
        .unwrap()
        .get::<ContextStateTable>(&checkpoint::key("ses_pending"))
        .unwrap()
        .unwrap()
        .revision;
    service
        .compaction_admit(
            AdmitInput {
                id: None,
                session: pending.session.clone(),
                trigger: session_compaction::Trigger::Manual,
                requested_through_message: checkpoint::message_id(&pending.ids.failed_tail),
                requested_through_seq: checkpoint::seq(&client, &pending.ids.failed_tail),
                base_context_revision: revision,
                target_max_input_tokens: 1000,
                config_digest: "d".repeat(64),
                pressure: None,
            },
            1,
        )
        .await
        .unwrap();
    untouched.push("ses_pending");

    let staged = checkpoint::scenario(&client, &service, "ses_staged", 1).await;
    stage_revert(&service, &staged.session, &staged.ids.tail_user).await;
    untouched.push("ses_staged");

    let changed = checkpoint::scenario(&client, &service, "ses_changed", 1).await;
    let boundary = changed.ids.boundary.clone();
    client
        .submit(move |tx| {
            let mut row = tx
                .get::<MessageTable>(&checkpoint::key(&boundary))?
                .unwrap();
            let JsonValue::Object(data) = &mut row.data else {
                panic!()
            };
            data.insert("finish".into(), JsonValue::String("length".into()));
            MessageTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
    untouched.push("ses_changed");

    let running = checkpoint::scenario(&client, &service, "ses_running", 1).await;
    let before = untouched
        .iter()
        .map(|name| counts(&store, name))
        .collect::<Vec<_>>();
    let running_before = counts(&store, "ses_running");
    let busy = running.session.clone();
    let swept = service
        .prune_history(2, move || vec![busy.clone()])
        .await
        .unwrap();
    assert_eq!(swept.pruned, history_pruning::Pruned::default());
    assert!(swept.failures.is_empty());
    assert_eq!(counts(&store, "ses_running"), running_before);
    assert_eq!(
        untouched
            .iter()
            .map(|name| counts(&store, name))
            .collect::<Vec<_>>(),
        before
    );

    let resumed = service.prune_history(2, none).await.unwrap();
    assert!(resumed.pruned.messages > 0);
    assert!(counts(&store, "ses_running").0 < running_before.0);
    assert_eq!(
        untouched
            .iter()
            .map(|name| counts(&store, name))
            .collect::<Vec<_>>(),
        before
    );

    checkpoint::session(&client, "ses_bulk");
    let first = checkpoint::user(&service, "ses_bulk", "Bulk request", 1).await;
    for index in 0..1_100 {
        checkpoint::publish(
            &service,
            "ses_bulk",
            "session.synthetic.1",
            1,
            &format!(r#","text":"Covered note {index}""#),
        )
        .await;
    }
    let boundary = checkpoint::run(
        &service,
        "ses_bulk",
        "Bulk answer",
        checkpoint::Outcome::Succeeded,
        1,
    )
    .await;
    checkpoint::compaction(
        &client,
        &service,
        "ses_bulk",
        &boundary,
        checkpoint::Compaction::Ended,
        1,
    )
    .await;
    let through = checkpoint::seq(&client, &boundary);
    let bulk = checkpoint::id("ses_bulk");
    let bulk_before = counts(&store, "ses_bulk");
    let calls = Arc::new(AtomicUsize::new(0));
    let (counter, target) = (calls.clone(), bulk.clone());
    let first_batch = service
        .prune_compacted(&bulk, 2, move || {
            if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                Vec::new()
            } else {
                vec![target.clone()]
            }
        })
        .await
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    assert_eq!(first_batch.messages, 49);
    assert_eq!(first_batch.events, 0);
    assert_eq!(
        counts(&store, "ses_bulk"),
        (bulk_before.0 - 49, bulk_before.1)
    );

    let rest = service.prune_compacted(&bulk, 2, none).await.unwrap();
    assert_eq!(first_batch.messages + rest.messages, 1_100);
    assert_eq!(rest.events, 1_100);
    let below = rows(&store, "ses_bulk")
        .into_iter()
        .filter(|row| row.seq < through)
        .map(|row| row.id.to_utf8().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(below, [first]);
    assert!(
        !types_below(&store, "ses_bulk", through)
            .iter()
            .any(|type_| type_ == "session.synthetic.1")
    );
}

#[tokio::test]
async fn pruned_prompt_retry_returns_original_admission_until_revert() {
    let store = support::store();
    let client = store.client();
    let service = Service::new(client.clone());
    let scenario = checkpoint::scenario(&client, &service, "ses_main", 1_000).await;
    let session = &scenario.session;
    let covered = scenario.ids.covered_user.clone();
    let original = events(&store, "ses_main")
        .into_iter()
        .find(|event| {
            event.type_.as_str() == Some("session.input.admitted.1")
                && matches!(&event.data, JsonValue::Object(data)
                    if data.get(&"inputID".into()) == Some(&JsonValue::String(covered.as_str().into())))
        })
        .unwrap();
    assert!(
        service
            .prune_compacted(session, 1_000, none)
            .await
            .unwrap()
            .messages
            > 0
    );
    let present = || {
        store
            .snapshot()
            .unwrap()
            .get::<MessageTable>(&checkpoint::key(&covered))
            .unwrap()
            .is_some()
    };
    assert!(!present());
    let before = counts(&store, "ses_main");

    let resent = service
        .admit(admission("ses_main", &covered, "user", "Changed text"))
        .await
        .unwrap();
    assert_eq!(resent.id.to_utf8().unwrap(), covered);
    assert_eq!(resent.session_id.to_utf8().unwrap(), "ses_main");
    assert_eq!(resent.type_.as_str(), Some("user"));
    assert_eq!(resent.admitted_seq, original.seq);
    assert_eq!(resent.time_created, original.created);
    assert_eq!(admitted_text(&resent), "Third request");
    assert!(service.pending_list(session).unwrap().is_empty());
    assert!(!present());
    assert_eq!(counts(&store, "ses_main"), before);

    let synthetic = service
        .admit(admission(
            "ses_main",
            &covered,
            "synthetic",
            "Synthetic reuse",
        ))
        .await
        .unwrap_err();
    assert!(matches!(
        synthetic,
        ycoding_store::Error::Domain {
            kind: "input_identity",
            ..
        }
    ));
    assert_eq!(counts(&store, "ses_main"), before);

    stage_revert(&service, session, &scenario.ids.tail_user).await;
    let info = service.get(session).unwrap().unwrap();
    revert::commit(&service, &info, 9_600).await.unwrap();
    let readmitted = service
        .admit(admission("ses_main", &covered, "user", "Changed again"))
        .await
        .unwrap();
    assert!(readmitted.admitted_seq > original.seq);
    assert_eq!(admitted_text(&readmitted), "Changed again");
    assert_eq!(
        service
            .pending_list(session)
            .unwrap()
            .iter()
            .map(|row| row.id.to_utf8().unwrap())
            .collect::<Vec<_>>(),
        [covered]
    );
}

#[tokio::test]
async fn pruning_changes_neither_next_provider_request_nor_live_state() {
    let store = support::store();
    let client = store.client();
    let service = Service::new(client.clone());
    let scenario = checkpoint::scenario(&client, &service, "ses_main", 1_000).await;
    let session = &scenario.session;
    let state = || {
        let snapshot = store.snapshot().unwrap();
        (
            service.model_history(session).unwrap(),
            live_state::capture(&snapshot, session).unwrap(),
            service.latest(session, "user").unwrap(),
            service.latest(session, "assistant").unwrap(),
            service.recent(session, 12).unwrap(),
            service.first_user_message_if_only(session).unwrap(),
            service.transcript(session).unwrap(),
            service.unsettled_tool_messages(session).unwrap(),
        )
    };
    let before = state();
    assert!(matches!(
        &before.0[0].message,
        session_message::Info::Synthetic(synthetic)
            if synthetic.text.to_utf8().unwrap().contains("conversation-checkpoint")
    ));
    assert!(
        service
            .prune_compacted(session, 1_000, none)
            .await
            .unwrap()
            .messages
            > 0
    );
    assert_eq!(state(), before);
}

#[tokio::test]
async fn startup_backfill_and_repeated_sweep_are_idempotent() {
    let store = support::store();
    let client = store.client();
    let service = Service::new(client.clone());
    checkpoint::scenario(&client, &service, "ses_first", 1).await;
    checkpoint::scenario(&client, &service, "ses_second", 1).await;
    let before = [counts(&store, "ses_first"), counts(&store, "ses_second")];
    let swept = service.prune_history(2, none).await.unwrap();
    let after = [counts(&store, "ses_first"), counts(&store, "ses_second")];
    assert!(swept.failures.is_empty());
    assert!(after[0].0 < before[0].0);
    assert!(after[1].0 < before[1].0);
    assert_eq!(
        swept.pruned.messages,
        before[0].0 - after[0].0 + before[1].0 - after[1].0
    );
    assert_eq!(
        swept.pruned.events,
        before[0].1 - after[0].1 + before[1].1 - after[1].1
    );
    let repeated = service.prune_history(2, none).await.unwrap();
    assert_eq!(repeated.pruned, history_pruning::Pruned::default());
    assert!(repeated.failures.is_empty());
    assert_eq!(
        [counts(&store, "ses_first"), counts(&store, "ses_second")],
        after
    );
}

#[tokio::test]
async fn summary_floor_may_precede_the_context_state_boundary() {
    let store = support::store();
    let service = Service::new(store.client());
    let scenario = checkpoint::scenario(&store.client(), &service, "ses_main", 1).await;
    let tail = scenario.ids.failed_tail.clone();
    store
        .submit(move |tx| {
            let message = tx.get::<MessageTable>(&checkpoint::key(&tail))?.unwrap();
            let mut state = tx
                .get::<ContextStateTable>(&checkpoint::key("ses_main"))?
                .unwrap();
            state.covered_through_seq = Some(message.seq);
            state.covered_through_message_id = Some(message.id);
            ContextStateTable::put(tx, &state)
        })
        .unwrap()
        .await
        .unwrap();
    assert_eq!(
        history_pruning::checkpoint(&store.snapshot().unwrap(), &scenario.session)
            .unwrap()
            .unwrap()
            .through,
        scenario.through
    );
    assert!(
        service
            .prune_compacted(&scenario.session, 2, none)
            .await
            .unwrap()
            .messages
            > 0
    );
}

#[tokio::test]
async fn every_batch_rechecks_checkpoint_and_session_fences() {
    for fence in [
        "sequence", "digest", "revert", "pending", "running", "ended", "boundary", "session",
    ] {
        let store = support::store();
        let client = store.client();
        let service = Service::new(client.clone());
        checkpoint::session(&client, "ses_bulk");
        checkpoint::user(&service, "ses_bulk", "First request", 1).await;
        for index in 0..410 {
            checkpoint::publish(
                &service,
                "ses_bulk",
                "session.synthetic.1",
                1,
                &format!(r#", "text":"Note {index}""#),
            )
            .await;
        }
        let boundary = checkpoint::run(
            &service,
            "ses_bulk",
            "Answer",
            checkpoint::Outcome::Succeeded,
            1,
        )
        .await;
        let job = checkpoint::compaction(
            &client,
            &service,
            "ses_bulk",
            &boundary,
            checkpoint::Compaction::Ended,
            1,
        )
        .await;
        let before = counts(&store, "ses_bulk");
        let (start, started) = std::sync::mpsc::channel();
        let (queued, queue) = std::sync::mpsc::channel();
        let writer = std::thread::spawn(move || {
            started.recv().unwrap();
            let receipt = client
                .submit(move |tx| {
                    match fence {
                        "sequence" | "digest" => {
                            let mut state = tx
                                .get::<ContextStateTable>(&checkpoint::key("ses_bulk"))?
                                .unwrap();
                            if fence == "sequence" {
                                state.covered_through_seq =
                                    state.covered_through_seq.map(|seq| seq - 1);
                            }
                            if fence == "digest" {
                                state.manifest_digest = None;
                            }
                            ContextStateTable::put(tx, &state)?;
                        }
                        "revert" => {
                            let mut row = tx
                                .get::<SessionTable>(&checkpoint::key("ses_bulk"))?
                                .unwrap();
                            row.revert = Some(Document::new(
                                parse_json(&format!(r#"{{"messageID":"{boundary}"}}"#)).unwrap(),
                            )?);
                            SessionTable::put(tx, &row)?;
                        }
                        "pending" | "running" => {
                            let mut row = tx.get::<JobTable>(&checkpoint::key(&job))?.unwrap();
                            row.id = "cmp_extra".into();
                            row.status = fence.into();
                            row.time_ended = None;
                            row.manifest_digest = None;
                            row.time_started = (fence == "running").then_some(1);
                            row.lease_owner = (fence == "running").then(|| "owner".into());
                            row.lease_expires_at = (fence == "running").then_some(60_000);
                            JobTable::insert(tx, &row)?;
                        }
                        "ended" => {
                            tx.delete::<JobTable>(&checkpoint::key(&job))?;
                        }
                        "boundary" => {
                            tx.delete::<MessageTable>(&checkpoint::key(&boundary))?;
                        }
                        "session" => {
                            tx.delete::<SessionTable>(&checkpoint::key("ses_bulk"))?;
                        }
                        _ => unreachable!(),
                    }
                    Ok(())
                })
                .unwrap();
            queued.send(()).unwrap();
            receipt.wait().unwrap();
        });
        let queue = Arc::new(std::sync::Mutex::new(queue));
        let counter = Arc::new(AtomicUsize::new(0));
        let pruned = service
            .prune_compacted(&checkpoint::id("ses_bulk"), 2, move || {
                if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                    start.send(()).unwrap();
                    queue.lock().unwrap().recv().unwrap();
                }
                Vec::new()
            })
            .await
            .unwrap();
        writer.join().unwrap();
        assert_eq!(pruned.messages, 49, "{fence}");
        assert_eq!(pruned.events, 0, "{fence}");
        assert_eq!(events(&store, "ses_bulk").len(), before.1, "{fence}");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn file_pruning_waits_for_backup_without_blocking_runtime_or_writer_and_restores() {
    use ycoding_store::{Options, backup};
    let directory =
        std::env::temp_dir().join(format!("ycoding-core-prune-backup-{}", std::process::id()));
    std::fs::create_dir(&directory).unwrap();
    let path = directory.join("core.redb");
    let store = file_store(&path, 42);
    let client = store.client();
    let service = Service::new(client.clone());
    let scenario = checkpoint::scenario(&client, &service, "ses_backup", 1).await;
    let before = counts(&store, "ses_backup");
    let original_messages = rows(&store, "ses_backup");
    let original_events = events(&store, "ses_backup");
    let (entered, started) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let backup_client = client.clone();
    let worker = std::thread::spawn(move || {
        backup_client
            .prepare_pruning(2, |_| {
                entered.send(()).unwrap();
                wait.recv().unwrap();
                Ok(u64::MAX)
            })
            .unwrap()
    });
    started.await.unwrap();
    let pruning = service.prune_compacted(&scenario.session, 2, none);
    tokio::pin!(pruning);
    tokio::select! {
        result = &mut pruning => panic!("pruning settled before backup: {result:?}"),
        result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::task::yield_now().await;
            client.submit(|_| Ok(())).unwrap().await.unwrap();
        }) => result.unwrap(),
    }
    assert_eq!(counts(&store, "ses_backup"), before);
    assert!(!backup::path(&path).exists());
    assert!(!backup::marker(&path).exists());
    release.send(()).unwrap();
    let pruned = tokio::time::timeout(std::time::Duration::from_secs(10), &mut pruning)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(worker.join().unwrap(), backup::Status::Ready);
    assert!(pruned.messages > 0 && pruned.events > 0);
    assert!(backup::marker(&path).is_file());
    let restored_path = directory.join("restored.redb");
    std::fs::copy(backup::path(&path), &restored_path).unwrap();
    let restored = Store::open(&restored_path, Options::core(), store.catalog()).unwrap();
    assert_eq!(counts(&restored, "ses_backup"), before);
    assert_eq!(rows(&restored, "ses_backup"), original_messages);
    assert_eq!(events(&restored, "ses_backup"), original_events);
    restored.shutdown().unwrap();
    store.shutdown().unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn invalid_backup_keeps_all_compacted_rows_until_retry() {
    use ycoding_store::backup;
    let directory = std::env::temp_dir().join(format!(
        "ycoding-core-refused-backup-{}",
        std::process::id()
    ));
    std::fs::create_dir(&directory).unwrap();
    let path = directory.join("core.redb");
    let store = file_store(&path, 43);
    let service = Service::new(store.client());
    let scenario = checkpoint::scenario(&store.client(), &service, "ses_backup", 1).await;
    let before = counts(&store, "ses_backup");
    std::fs::write(backup::path(&path), b"invalid backup").unwrap();
    assert_eq!(
        service
            .prune_compacted(&scenario.session, 2, none)
            .await
            .unwrap(),
        history_pruning::Pruned::default()
    );
    assert_eq!(
        service.prune_history(3, none).await.unwrap().pruned,
        history_pruning::Pruned::default()
    );
    assert_eq!(counts(&store, "ses_backup"), before);
    assert_eq!(service.retain(30 * DAY, 7, none).await.unwrap().deleted, 0);
    assert_eq!(counts(&store, "ses_backup"), before);
    assert!(!backup::marker(&path).exists());
    std::fs::remove_file(backup::path(&path)).unwrap();
    assert!(
        service
            .prune_history(4, none)
            .await
            .unwrap()
            .pruned
            .messages
            > 0
    );
    assert!(backup::marker(&path).is_file());
    drop(service);
    store.shutdown().unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn empty_sweeps_do_not_seal_backup_and_first_retention_deletion_is_restorable() {
    use ycoding_store::{Options, backup};
    let directory =
        std::env::temp_dir().join(format!("ycoding-core-lazy-backup-{}", std::process::id()));
    std::fs::create_dir(&directory).unwrap();
    let path = directory.join("core.redb");
    let store = file_store(&path, 44);
    let service = Service::new(store.client());
    assert_eq!(
        service.prune_history(30 * DAY, none).await.unwrap().pruned,
        history_pruning::Pruned::default()
    );
    assert_eq!(service.retain(30 * DAY, 7, none).await.unwrap().deleted, 0);
    assert!(
        service
            .remove_idle(&checkpoint::id("ses_absent"), 30 * DAY, 23 * DAY, none)
            .await
            .unwrap()
            .members
            .is_empty()
    );
    assert!(!backup::path(&path).exists());
    assert!(!backup::marker(&path).exists());
    checkpoint::session(&store.client(), "ses_idle");
    let original = service.get(&checkpoint::id("ses_idle")).unwrap().unwrap();
    std::fs::write(backup::path(&path), b"invalid backup").unwrap();
    assert_eq!(service.retain(30 * DAY, 7, none).await.unwrap().deleted, 0);
    assert_eq!(
        service.get(&checkpoint::id("ses_idle")).unwrap(),
        Some(original.clone())
    );
    std::fs::remove_file(backup::path(&path)).unwrap();
    assert_eq!(service.retain(30 * DAY, 7, none).await.unwrap().deleted, 1);
    assert!(service.get(&checkpoint::id("ses_idle")).unwrap().is_none());
    assert!(backup::marker(&path).is_file());
    let restored_path = directory.join("restored.redb");
    std::fs::copy(backup::path(&path), &restored_path).unwrap();
    let restored = Store::open(&restored_path, Options::core(), store.catalog()).unwrap();
    assert_eq!(
        Service::new(restored.client())
            .get(&checkpoint::id("ses_idle"))
            .unwrap(),
        Some(original)
    );
    restored.shutdown().unwrap();
    store.shutdown().unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}
