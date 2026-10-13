use std::{collections::VecDeque, sync::Mutex};
use ycoding_core::session::{
    pending::Request,
    revert::{self, Error, Runs, SnapshotFailure, Snapshots},
    store::Service,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, file_diff, parse_json, schema::RelativePath, session,
    session_message, session_pending, snapshot,
};
use ycoding_store::{
    Store,
    session::{
        InstructionState, InstructionStateTable, Message, MessageTable, NewEvent, Pending,
        PendingTable, SessionTable, latest_sequence,
    },
};

#[path = "session_support/mod.rs"]
mod support;

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn message_id(value: &str) -> session_message::Id {
    session_message::Id::new(value).unwrap()
}

fn tree(value: &str) -> snapshot::Id {
    snapshot::Id::new(value).unwrap()
}

fn json(text: &str) -> JsonValue {
    parse_json(text).unwrap()
}

fn assistant(range: Option<&str>) -> JsonValue {
    json(&format!(
        r#"{{"time":{{"created":1}},"agent":"build","model":{{"providerID":"local","id":"test"}},"content":[]{}}}"#,
        range.map_or(String::new(), |range| format!(r#","snapshot":{range}"#))
    ))
}

fn note() -> JsonValue {
    json(r#"{"text":"note","time":{"created":1}}"#)
}

fn put_message(
    store: &Store,
    session: &str,
    message: &str,
    type_: &str,
    seq: i64,
    data: JsonValue,
) {
    store
        .submit({
            let (session, message, type_) =
                (session.to_string(), message.to_string(), type_.to_string());
            move |tx| {
                MessageTable::insert(
                    tx,
                    &Message {
                        id: message.into(),
                        session_id: session.into(),
                        type_: type_.into(),
                        seq,
                        time_created: 1,
                        time_updated: 1,
                        data,
                    },
                )
            }
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn put_pending(store: &Store, session: &str, message: &str, admitted_seq: i64) {
    store
        .submit({
            let (session, message) = (session.to_string(), message.to_string());
            move |tx| {
                PendingTable::insert(
                    tx,
                    &Pending {
                        id: message.into(),
                        session_id: session.into(),
                        type_: "synthetic".into(),
                        data: json(r#"{"text":"queued"}"#),
                        delivery: Some("queue".into()),
                        admitted_seq,
                        time_created: 1,
                    },
                )
            }
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn message_ids(store: &Store, session: &str) -> Vec<String> {
    let snapshot = store.snapshot().unwrap();
    ycoding_store::session::messages(
        &snapshot,
        &session.into(),
        std::ops::Bound::Unbounded,
        std::ops::Bound::Unbounded,
        ycoding_store::IndexOrder::Ascending,
        None,
        100,
    )
    .unwrap()
    .into_iter()
    .map(|row| row.record.id.to_utf8().unwrap())
    .collect()
}

fn pending_ids(store: &Store, session: &str) -> Vec<String> {
    let snapshot = store.snapshot().unwrap();
    ycoding_store::session::pending(&snapshot, &session.into(), Some(&"queue".into()), None, 100)
        .unwrap()
        .into_iter()
        .map(|row| row.record.id.to_utf8().unwrap())
        .collect()
}

fn stage_event(session: &str, revert: &str, now: i64) -> NewEvent {
    NewEvent {
        id: format!("evt_stage_{now}").into(),
        aggregate_id: session.into(),
        created: now,
        type_: "session.revert.staged.1".into(),
        data: json(&format!(r#"{{"sessionID":"{session}","revert":{revert}}}"#)),
    }
}

fn event(kind: &str, session: &str, now: i64, extra: &str) -> NewEvent {
    NewEvent {
        id: format!("evt_{kind}_{now}").replace('.', "_").into(),
        aggregate_id: session.into(),
        created: now,
        type_: format!("session.revert.{kind}.1").into(),
        data: json(&format!(r#"{{"sessionID":"{session}"{extra}}}"#)),
    }
}

fn info(service: &Service, session: &str) -> session::Info {
    service.get(&id(session)).unwrap().unwrap()
}

fn diff(file: &str) -> file_diff::Info {
    file_diff::Info::decode(&json(&format!(
        r#"{{"file":"{file}","patch":"@@","additions":1,"deletions":0,"status":"modified"}}"#
    )))
    .unwrap()
}

#[derive(Default)]
struct Recorder {
    captures: Mutex<VecDeque<Option<snapshot::Id>>>,
    diffs: Mutex<Vec<file_diff::Info>>,
    restore_failure: Mutex<Option<String>>,
    calls: Mutex<Vec<String>>,
}

impl Recorder {
    fn with_captures(captures: &[Option<&str>]) -> Self {
        Self {
            captures: Mutex::new(captures.iter().map(|value| value.map(tree)).collect()),
            ..Self::default()
        }
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

impl Snapshots for Recorder {
    fn capture(&self) -> Option<snapshot::Id> {
        self.calls.lock().unwrap().push("capture".into());
        self.captures.lock().unwrap().pop_front().flatten()
    }

    fn restore(&self, files: &[(RelativePath, snapshot::Id)]) -> Result<(), SnapshotFailure> {
        self.calls.lock().unwrap().push(format!(
            "restore {}",
            files
                .iter()
                .map(|(file, tree)| format!(
                    "{}={}",
                    file.as_lossless().to_utf8().unwrap(),
                    tree.as_lossless().to_utf8().unwrap()
                ))
                .collect::<Vec<_>>()
                .join(",")
        ));
        match self.restore_failure.lock().unwrap().clone() {
            Some(message) => Err(SnapshotFailure {
                operation: "restore",
                message,
            }),
            None => Ok(()),
        }
    }

    fn diff(
        &self,
        from: &snapshot::Id,
        to: &snapshot::Id,
        paths: &[RelativePath],
    ) -> Result<Vec<file_diff::Info>, SnapshotFailure> {
        self.calls.lock().unwrap().push(format!(
            "diff {}..{} [{}]",
            from.as_lossless().to_utf8().unwrap(),
            to.as_lossless().to_utf8().unwrap(),
            paths
                .iter()
                .map(|file| file.as_lossless().to_utf8().unwrap())
                .collect::<Vec<_>>()
                .join(",")
        ));
        Ok(self.diffs.lock().unwrap().clone())
    }
}

fn seeded() -> (Store, Service) {
    let store = support::store();
    let service = Service::new(store.client());
    (store, service)
}

fn seed_history(store: &Store) {
    put_message(
        store,
        "ses_one",
        "msg_earlier",
        "assistant",
        0,
        assistant(None),
    );
    put_message(
        store,
        "ses_one",
        "msg_boundary",
        "assistant",
        1,
        assistant(Some(r#"{"start":"tree_boundary","files":["boundary.ts"]}"#)),
    );
    put_message(
        store,
        "ses_one",
        "msg_later",
        "assistant",
        2,
        assistant(Some(r#"{"start":"tree_later","files":["a.ts","b.ts"]}"#)),
    );
    put_message(
        store,
        "ses_one",
        "msg_latest",
        "assistant",
        3,
        assistant(Some(r#"{"start":"tree_latest","files":["b.ts","c.ts"]}"#)),
    );
    put_message(store, "ses_one", "msg_note", "system", 4, note());
    put_message(
        store,
        "ses_one",
        "msg_unsnapped",
        "assistant",
        5,
        assistant(Some(r#"{"files":["ignored.ts"]}"#)),
    );
    put_message(
        store,
        "ses_two",
        "msg_other_session",
        "assistant",
        2,
        assistant(Some(r#"{"start":"tree_other","files":["other.ts"]}"#)),
    );
}

#[tokio::test]
async fn loads_current_revert_storage() {
    let (store, service) = seeded();
    store
        .submit(|tx| {
            let mut row = tx.get::<SessionTable>(&ycoding_store::tuple_key(&[
                ycoding_store::KeyPart::String(&"ses_one".into()),
            ]))?
            .unwrap();
            row.revert = Some(ycoding_store::session::Document::new(json(
                r#"{"messageID":"msg_boundary","snapshot":"tree","files":[{"file":"src/current.ts","status":"modified","additions":1,"deletions":0,"patch":"@@"}]}"#,
            ))?);
            SessionTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
    let revert = info(&service, "ses_one").revert.unwrap();
    assert_eq!(
        revert.message_id.as_lossless().to_utf8().unwrap(),
        "msg_boundary"
    );
    assert_eq!(
        revert.snapshot.unwrap().as_lossless().to_utf8().unwrap(),
        "tree"
    );
    assert_eq!(
        revert.files.unwrap(),
        vec![file_diff::Info {
            file: "src/current.ts".into(),
            ..diff("src/current.ts")
        }]
    );
}

#[tokio::test]
async fn projects_staged_cleared_and_committed_reverts() {
    let (store, service) = seeded();
    put_message(
        &store,
        "ses_one",
        "msg_earlier",
        "assistant",
        0,
        assistant(None),
    );
    put_message(
        &store,
        "ses_one",
        "msg_boundary",
        "assistant",
        1,
        assistant(None),
    );
    put_message(
        &store,
        "ses_one",
        "msg_later",
        "assistant",
        2,
        assistant(None),
    );
    store
        .submit(|tx| {
            let key =
                ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(&"ses_one".into())]);
            let mut row = tx.get::<SessionTable>(&key)?.unwrap();
            row.cost = 1.25;
            row.tokens_input = 10;
            row.tokens_output = 4;
            row.tokens_reasoning = 2;
            row.tokens_cache_read = 3;
            row.tokens_cache_write = 1;
            SessionTable::put(tx, &row)?;
            InstructionStateTable::insert(
                tx,
                &InstructionState {
                    session_id: "ses_one".into(),
                    epoch_start: 0,
                    through_seq: 0,
                    initial_values: ycoding_store::session::Document::new(json("{}"))?,
                    current_values: ycoding_store::session::Document::new(json("{}"))?,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();

    service
        .publish(stage_event(
            "ses_one",
            r#"{"messageID":"msg_boundary","snapshot":"tree","files":[]}"#,
            100,
        ))
        .await
        .unwrap();
    let staged = info(&service, "ses_one");
    let revert = staged.revert.unwrap();
    assert_eq!(
        revert.message_id.as_lossless().to_utf8().unwrap(),
        "msg_boundary"
    );
    assert_eq!(
        revert.snapshot.unwrap().as_lossless().to_utf8().unwrap(),
        "tree"
    );
    assert_eq!(revert.files.unwrap(), vec![]);
    assert_eq!(staged.time.updated.epoch_millis(), 100);

    service
        .publish(event("cleared", "ses_one", 101, ""))
        .await
        .unwrap();
    let cleared = info(&service, "ses_one");
    assert!(cleared.revert.is_none());
    assert_eq!(cleared.time.updated.epoch_millis(), 101);

    service
        .publish(stage_event(
            "ses_one",
            r#"{"messageID":"msg_boundary","files":[]}"#,
            102,
        ))
        .await
        .unwrap();
    service
        .publish(event(
            "committed",
            "ses_one",
            103,
            r#","to":"msg_boundary""#,
        ))
        .await
        .unwrap();

    assert_eq!(message_ids(&store, "ses_one"), vec!["msg_earlier"]);
    let committed = info(&service, "ses_one");
    assert!(committed.revert.is_none());
    assert_eq!(committed.time.updated.epoch_millis(), 103);
    assert_eq!(committed.cost.encode(), JsonValue::Number(1.25));
    assert_eq!(committed.tokens.input.get(), 10.0);
    assert_eq!(committed.tokens.output.get(), 4.0);
    assert_eq!(committed.tokens.reasoning.get(), 2.0);
    assert_eq!(committed.tokens.cache.read.get(), 3.0);
    assert_eq!(committed.tokens.cache.write.get(), 1.0);
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<InstructionStateTable>(&ycoding_store::tuple_key(&[
                ycoding_store::KeyPart::String(&"ses_one".into())
            ]))
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn committed_revert_prunes_only_this_sessions_boundary_messages_and_pending_input() {
    let (store, service) = seeded();
    seed_history(&store);
    put_pending(&store, "ses_one", "msg_pending_before", 0);
    put_pending(&store, "ses_one", "msg_pending_after", 5);
    put_pending(&store, "ses_two", "msg_pending_other", 5);
    service
        .publish(event("committed", "ses_one", 10, r#","to":"msg_boundary""#))
        .await
        .unwrap();
    assert_eq!(message_ids(&store, "ses_one"), vec!["msg_earlier"]);
    assert_eq!(message_ids(&store, "ses_two"), vec!["msg_other_session"]);
    assert_eq!(pending_ids(&store, "ses_one"), vec!["msg_pending_before"]);
    assert_eq!(pending_ids(&store, "ses_two"), vec!["msg_pending_other"]);
}

#[tokio::test]
async fn committed_revert_rejects_a_missing_or_foreign_boundary_without_side_effects() {
    let (store, service) = seeded();
    seed_history(&store);
    for target in ["msg_missing", "msg_other_session"] {
        let before = latest_sequence(&store.snapshot().unwrap(), &"ses_one".into()).unwrap();
        let result = service
            .publish(event(
                "committed",
                "ses_one",
                10,
                &format!(r#","to":"{target}""#),
            ))
            .await;
        assert!(result.is_err(), "{target}");
        assert_eq!(
            latest_sequence(&store.snapshot().unwrap(), &"ses_one".into()).unwrap(),
            before
        );
        assert_eq!(message_ids(&store, "ses_one").len(), 6);
        assert_eq!(message_ids(&store, "ses_two"), vec!["msg_other_session"]);
    }
}

#[tokio::test]
async fn plan_collects_first_snapshot_per_file_from_assistant_messages_after_the_boundary() {
    let (store, _service) = seeded();
    seed_history(&store);
    let snapshot = store.snapshot().unwrap();
    let files = revert::plan(&snapshot, &id("ses_one"), &message_id("msg_boundary")).unwrap();
    let rendered = files
        .iter()
        .map(|(file, tree)| {
            format!(
                "{}={}",
                file.as_lossless().to_utf8().unwrap(),
                tree.as_lossless().to_utf8().unwrap()
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        rendered,
        vec!["a.ts=tree_later", "b.ts=tree_later", "c.ts=tree_latest"]
    );
    assert!(
        revert::plan(&snapshot, &id("ses_one"), &message_id("msg_latest"))
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn plan_fails_with_message_not_found_for_a_missing_or_foreign_boundary() {
    let (store, _service) = seeded();
    seed_history(&store);
    let snapshot = store.snapshot().unwrap();
    for target in ["msg_missing", "msg_other_session"] {
        let Err(Error::MessageNotFound {
            session_id,
            message_id: missing,
        }) = revert::plan(&snapshot, &id("ses_one"), &message_id(target))
        else {
            panic!("expected MessageNotFound for {target}")
        };
        assert_eq!(session_id, id("ses_one"));
        assert_eq!(missing, message_id(target));
    }
}

#[tokio::test]
async fn stage_captures_restores_planned_files_and_publishes_the_diffed_revert() {
    let (store, service) = seeded();
    seed_history(&store);
    let snapshots = Recorder::with_captures(&[Some("tree_original"), Some("tree_now")]);
    *snapshots.diffs.lock().unwrap() = vec![diff("a.ts")];
    let revert = revert::stage(
        &service,
        &snapshots,
        &info(&service, "ses_one"),
        &message_id("msg_boundary"),
        true,
        50,
    )
    .await
    .unwrap();
    assert_eq!(
        snapshots.calls(),
        vec![
            "capture",
            "restore a.ts=tree_later,b.ts=tree_later,c.ts=tree_latest",
            "capture",
            "diff tree_original..tree_now [a.ts,b.ts,c.ts]",
        ]
    );
    assert_eq!(revert.snapshot, Some(tree("tree_original")));
    assert_eq!(revert.files, Some(vec![diff("a.ts")]));
    let stored = info(&service, "ses_one");
    assert_eq!(stored.revert, Some(revert));
    assert_eq!(stored.time.updated.epoch_millis(), 50);
}

#[tokio::test]
async fn stage_reuses_the_staged_original_and_lets_planned_trees_override_its_files() {
    let (store, service) = seeded();
    seed_history(&store);
    service
        .publish(stage_event(
            "ses_one",
            r#"{"messageID":"msg_later","snapshot":"tree_first","files":[{"file":"b.ts","status":"modified","additions":1,"deletions":0,"patch":"@@"},{"file":"z.ts","status":"modified","additions":1,"deletions":0,"patch":"@@"}]}"#,
            40,
        ))
        .await
        .unwrap();
    let snapshots = Recorder::with_captures(&[Some("tree_now")]);
    let revert = revert::stage(
        &service,
        &snapshots,
        &info(&service, "ses_one"),
        &message_id("msg_boundary"),
        true,
        50,
    )
    .await
    .unwrap();
    assert_eq!(
        snapshots.calls(),
        vec![
            "restore b.ts=tree_later,z.ts=tree_first,a.ts=tree_later,c.ts=tree_latest",
            "capture",
            "diff tree_first..tree_now [a.ts,b.ts,c.ts]",
        ]
    );
    assert_eq!(revert.snapshot, Some(tree("tree_first")));
}

#[tokio::test]
async fn stage_without_files_restores_only_the_original_selection_and_diffs_no_paths() {
    let (store, service) = seeded();
    seed_history(&store);
    service
        .publish(stage_event(
            "ses_one",
            r#"{"messageID":"msg_later","snapshot":"tree_first","files":[{"file":"z.ts","status":"modified","additions":1,"deletions":0,"patch":"@@"}]}"#,
            40,
        ))
        .await
        .unwrap();
    let snapshots = Recorder::with_captures(&[Some("tree_now")]);
    revert::stage(
        &service,
        &snapshots,
        &info(&service, "ses_one"),
        &message_id("msg_boundary"),
        false,
        50,
    )
    .await
    .unwrap();
    assert_eq!(
        snapshots.calls(),
        vec![
            "restore z.ts=tree_first",
            "capture",
            "diff tree_first..tree_now []"
        ]
    );
}

#[tokio::test]
async fn stage_without_a_snapshot_still_restores_the_plan_and_publishes_an_empty_diff() {
    let (store, service) = seeded();
    seed_history(&store);
    let snapshots = Recorder::with_captures(&[None]);
    let revert = revert::stage(
        &service,
        &snapshots,
        &info(&service, "ses_one"),
        &message_id("msg_boundary"),
        true,
        50,
    )
    .await
    .unwrap();
    assert_eq!(
        snapshots.calls(),
        vec![
            "capture",
            "restore a.ts=tree_later,b.ts=tree_later,c.ts=tree_latest"
        ]
    );
    assert_eq!(revert.snapshot, None);
    assert_eq!(revert.files, Some(vec![]));
}

#[tokio::test]
async fn stage_fails_before_publishing_when_the_boundary_is_missing_or_restore_fails() {
    let (store, service) = seeded();
    seed_history(&store);
    let before = latest_sequence(&store.snapshot().unwrap(), &"ses_one".into()).unwrap();
    let snapshots = Recorder::with_captures(&[Some("tree_original")]);
    let result = revert::stage(
        &service,
        &snapshots,
        &info(&service, "ses_one"),
        &message_id("msg_missing"),
        true,
        50,
    )
    .await;
    assert!(matches!(result, Err(Error::MessageNotFound { .. })));
    assert_eq!(snapshots.calls(), vec!["capture"]);

    let snapshots = Recorder::with_captures(&[Some("tree_original")]);
    *snapshots.restore_failure.lock().unwrap() = Some("disk".into());
    let result = revert::stage(
        &service,
        &snapshots,
        &info(&service, "ses_one"),
        &message_id("msg_boundary"),
        true,
        50,
    )
    .await;
    assert!(matches!(
        result,
        Err(Error::Snapshot(SnapshotFailure {
            operation: "restore",
            ..
        }))
    ));
    assert_eq!(
        latest_sequence(&store.snapshot().unwrap(), &"ses_one".into()).unwrap(),
        before
    );
    assert!(info(&service, "ses_one").revert.is_none());
}

#[tokio::test]
async fn clear_restores_the_original_files_then_publishes_cleared() {
    let (store, service) = seeded();
    seed_history(&store);
    service
        .publish(stage_event(
            "ses_one",
            r#"{"messageID":"msg_boundary","snapshot":"tree_first","files":[{"file":"a.ts","status":"modified","additions":1,"deletions":0,"patch":"@@"},{"file":"b.ts","status":"modified","additions":1,"deletions":0,"patch":"@@"}]}"#,
            40,
        ))
        .await
        .unwrap();
    let snapshots = Recorder::default();
    revert::clear(&service, &snapshots, &info(&service, "ses_one"), 60)
        .await
        .unwrap();
    assert_eq!(
        snapshots.calls(),
        vec!["restore a.ts=tree_first,b.ts=tree_first"]
    );
    let cleared = info(&service, "ses_one");
    assert!(cleared.revert.is_none());
    assert_eq!(cleared.time.updated.epoch_millis(), 60);
}

#[tokio::test]
async fn clear_without_a_snapshot_publishes_without_restoring_and_without_a_revert_is_a_no_op() {
    let (store, service) = seeded();
    seed_history(&store);
    let snapshots = Recorder::default();
    let before = latest_sequence(&store.snapshot().unwrap(), &"ses_one".into()).unwrap();
    revert::clear(&service, &snapshots, &info(&service, "ses_one"), 60)
        .await
        .unwrap();
    assert!(snapshots.calls().is_empty());
    assert_eq!(
        latest_sequence(&store.snapshot().unwrap(), &"ses_one".into()).unwrap(),
        before
    );

    service
        .publish(stage_event(
            "ses_one",
            r#"{"messageID":"msg_boundary","files":[]}"#,
            40,
        ))
        .await
        .unwrap();
    revert::clear(&service, &snapshots, &info(&service, "ses_one"), 60)
        .await
        .unwrap();
    assert!(snapshots.calls().is_empty());
    assert!(info(&service, "ses_one").revert.is_none());
}

#[tokio::test]
async fn commit_without_a_revert_is_a_no_op_and_with_one_prunes_history() {
    let (store, service) = seeded();
    seed_history(&store);
    let before = latest_sequence(&store.snapshot().unwrap(), &"ses_one".into()).unwrap();
    revert::commit(&service, &info(&service, "ses_one"), 70)
        .await
        .unwrap();
    assert_eq!(
        latest_sequence(&store.snapshot().unwrap(), &"ses_one".into()).unwrap(),
        before
    );
    assert_eq!(message_ids(&store, "ses_one").len(), 6);

    service
        .publish(stage_event(
            "ses_one",
            r#"{"messageID":"msg_later","files":[]}"#,
            40,
        ))
        .await
        .unwrap();
    revert::commit(&service, &info(&service, "ses_one"), 70)
        .await
        .unwrap();
    assert_eq!(
        message_ids(&store, "ses_one"),
        vec!["msg_earlier", "msg_boundary"]
    );
    assert!(info(&service, "ses_one").revert.is_none());
}

fn input(id: &str, kind: &str, event: &str, created: i64) -> Request {
    Request {
        id: message_id(id),
        session_id: self::id("ses_one"),
        input: session_pending::Message::decode(&json(&format!(
            r#"{{"type":"{kind}","data":{{"text":"{id}"}},"delivery":"steer"}}"#
        )))
        .unwrap(),
        event_id: ycoding_schema::event::Id::new(event).unwrap(),
        created,
    }
}

fn all_pending(service: &Service, session: &str) -> Vec<String> {
    service
        .pending_list(&id(session))
        .unwrap()
        .into_iter()
        .map(|row| row.id.to_utf8().unwrap())
        .collect()
}

async fn promoted_boundary(service: &Service) {
    service
        .admit(input("msg_boundary", "user", "evt_boundary", 10))
        .await
        .unwrap();
    service.promote_steers(&id("ses_one"), 11).await.unwrap();
}

#[tokio::test]
async fn admitting_a_prompt_commits_a_staged_revert_first() {
    let (store, service) = seeded();
    promoted_boundary(&service).await;
    put_message(
        &store,
        "ses_one",
        "msg_stale_assistant",
        "assistant",
        100,
        assistant(None),
    );
    service
        .publish(stage_event(
            "ses_one",
            r#"{"messageID":"msg_boundary","files":[]}"#,
            50,
        ))
        .await
        .unwrap();
    assert!(info(&service, "ses_one").revert.is_some());

    let admitted = service
        .admit_input(input("msg_after", "user", "evt_after", 60))
        .await
        .unwrap();

    assert!(admitted.wake);
    assert!(info(&service, "ses_one").revert.is_none());
    assert_eq!(message_ids(&store, "ses_one"), Vec::<String>::new());
    assert_eq!(all_pending(&service, "ses_one"), vec!["msg_after"]);
}

#[tokio::test]
async fn synthetic_input_is_held_behind_a_staged_revert_and_discarded_on_commit() {
    let (_store, service) = seeded();
    promoted_boundary(&service).await;
    service
        .publish(stage_event(
            "ses_one",
            r#"{"messageID":"msg_boundary","files":[]}"#,
            50,
        ))
        .await
        .unwrap();

    let admitted = service
        .admit_input(input("msg_stale_completion", "synthetic", "evt_stale", 60))
        .await
        .unwrap();

    assert!(!admitted.wake);
    assert!(info(&service, "ses_one").revert.is_some());
    assert_eq!(
        all_pending(&service, "ses_one"),
        vec!["msg_stale_completion"]
    );

    revert::commit(&service, &info(&service, "ses_one"), 70)
        .await
        .unwrap();

    assert!(all_pending(&service, "ses_one").is_empty());
}

#[tokio::test]
async fn synthetic_input_wakes_without_a_staged_revert_and_unknown_sessions_are_rejected() {
    let (_store, service) = seeded();
    let admitted = service
        .admit_input(input("msg_note", "synthetic", "evt_note", 60))
        .await
        .unwrap();
    assert!(admitted.wake);

    let mut unknown = input("msg_ghost", "user", "evt_ghost", 61);
    unknown.session_id = id("ses_missing");
    assert!(service.admit_input(unknown).await.is_err());
    assert!(service.pending(&message_id("msg_ghost")).unwrap().is_none());
}

#[tokio::test]
async fn committed_after_reports_only_a_later_committed_revert_of_this_session() {
    let (store, service) = seeded();
    seed_history(&store);
    let session = id("ses_one");
    let snapshot = || store.snapshot().unwrap();
    assert!(!revert::committed_after(&snapshot(), &session, 0).unwrap());

    service
        .publish(stage_event(
            "ses_one",
            r#"{"messageID":"msg_boundary","files":[]}"#,
            40,
        ))
        .await
        .unwrap();
    let staged = latest_sequence(&snapshot(), &"ses_one".into()).unwrap();
    assert!(!revert::committed_after(&snapshot(), &session, 0).unwrap());

    service
        .publish(event("committed", "ses_one", 50, r#","to":"msg_boundary""#))
        .await
        .unwrap();
    let committed = latest_sequence(&snapshot(), &"ses_one".into()).unwrap();

    assert!(revert::committed_after(&snapshot(), &session, staged).unwrap());
    assert!(!revert::committed_after(&snapshot(), &session, committed).unwrap());
    assert!(!revert::committed_after(&snapshot(), &id("ses_two"), 0).unwrap());
}

struct FakeRuns {
    active: Vec<session::Id>,
    wakes: Mutex<Vec<session::Id>>,
    wake_failure: Option<String>,
}

impl FakeRuns {
    fn idle() -> Self {
        Self {
            active: Vec::new(),
            wakes: Mutex::new(Vec::new()),
            wake_failure: None,
        }
    }

    fn running(session: &str) -> Self {
        Self {
            active: vec![id(session)],
            ..Self::idle()
        }
    }

    fn wakes(&self) -> Vec<session::Id> {
        self.wakes.lock().unwrap().clone()
    }
}

impl Runs for FakeRuns {
    fn active(&self) -> Vec<session::Id> {
        self.active.clone()
    }

    fn wake(&self, id: &session::Id) -> Result<(), String> {
        self.wakes.lock().unwrap().push(id.clone());
        self.wake_failure.clone().map_or(Ok(()), Err)
    }
}

#[tokio::test]
async fn revert_operations_reject_an_active_session_without_side_effects() {
    let (store, service) = seeded();
    seed_history(&store);
    service
        .publish(stage_event(
            "ses_one",
            r#"{"messageID":"msg_boundary","snapshot":"tree_first","files":[{"file":"a.ts","status":"modified","additions":1,"deletions":0,"patch":"@@"}]}"#,
            40,
        ))
        .await
        .unwrap();
    let runs = FakeRuns::running("ses_one");
    let snapshots = Recorder::with_captures(&[Some("tree_now")]);
    let before = latest_sequence(&store.snapshot().unwrap(), &"ses_one".into()).unwrap();

    let staged = revert::stage_idle(
        &service,
        &runs,
        &snapshots,
        &id("ses_one"),
        &message_id("msg_later"),
        true,
        50,
    )
    .await;
    let cleared = revert::clear_idle(&service, &runs, &snapshots, &id("ses_one"), 51).await;
    let committed = revert::commit_idle(&service, &runs, &id("ses_one"), 52).await;

    for result in [staged.map(|_| ()), cleared, committed] {
        assert!(matches!(result, Err(Error::Busy { .. })));
    }
    assert!(snapshots.calls().is_empty());
    assert!(runs.wakes().is_empty());
    assert_eq!(
        latest_sequence(&store.snapshot().unwrap(), &"ses_one".into()).unwrap(),
        before
    );
    assert!(info(&service, "ses_one").revert.is_some());
    assert_eq!(message_ids(&store, "ses_one").len(), 6);
}

#[tokio::test]
async fn revert_operations_reject_an_unknown_session() {
    let (_store, service) = seeded();
    let runs = FakeRuns::idle();
    let snapshots = Recorder::default();
    let result = revert::commit_idle(&service, &runs, &id("ses_missing"), 1).await;
    assert!(matches!(result, Err(Error::SessionNotFound { .. })));
    let result = revert::clear_idle(&service, &runs, &snapshots, &id("ses_missing"), 1).await;
    assert!(matches!(result, Err(Error::SessionNotFound { .. })));
    assert!(runs.wakes().is_empty());
}

#[tokio::test]
async fn idle_stage_and_commit_run_without_waking_and_clear_wakes_the_session() {
    let (store, service) = seeded();
    seed_history(&store);
    let runs = FakeRuns::idle();
    let snapshots = Recorder::with_captures(&[Some("tree_original"), Some("tree_now")]);

    let revert = revert::stage_idle(
        &service,
        &runs,
        &snapshots,
        &id("ses_one"),
        &message_id("msg_boundary"),
        false,
        50,
    )
    .await
    .unwrap();
    assert_eq!(info(&service, "ses_one").revert, Some(revert));
    assert!(runs.wakes().is_empty());

    revert::clear_idle(&service, &runs, &snapshots, &id("ses_one"), 60)
        .await
        .unwrap();
    assert!(info(&service, "ses_one").revert.is_none());
    assert_eq!(runs.wakes(), vec![id("ses_one")]);

    revert::clear_idle(&service, &runs, &snapshots, &id("ses_one"), 61)
        .await
        .unwrap();
    assert_eq!(runs.wakes(), vec![id("ses_one"), id("ses_one")]);

    service
        .publish(stage_event(
            "ses_one",
            r#"{"messageID":"msg_later","files":[]}"#,
            70,
        ))
        .await
        .unwrap();
    revert::commit_idle(&service, &runs, &id("ses_one"), 71)
        .await
        .unwrap();
    assert_eq!(
        message_ids(&store, "ses_one"),
        vec!["msg_earlier", "msg_boundary"]
    );
    assert_eq!(runs.wakes().len(), 2);
}

#[tokio::test]
async fn clear_reports_a_wake_failure_after_the_revert_was_cleared() {
    let (store, service) = seeded();
    seed_history(&store);
    service
        .publish(stage_event(
            "ses_one",
            r#"{"messageID":"msg_boundary","files":[]}"#,
            40,
        ))
        .await
        .unwrap();
    let runs = FakeRuns {
        wake_failure: Some("closed".into()),
        ..FakeRuns::idle()
    };
    let result =
        revert::clear_idle(&service, &runs, &Recorder::default(), &id("ses_one"), 60).await;
    assert!(matches!(result, Err(Error::Wake(message)) if message == "closed"));
    assert!(info(&service, "ses_one").revert.is_none());
}
