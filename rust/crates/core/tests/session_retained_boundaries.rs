use std::{
    ops::Bound,
    sync::atomic::{AtomicUsize, Ordering},
};
use ycoding_core::session::{history_pruning, revert, store::Service};
use ycoding_schema::{
    DomainEncode, JsonValue, file_diff, schema::RelativePath, session_message, snapshot,
};
use ycoding_store::{
    Error, Store,
    session::{ContextStateTable, EventTable, MessageTable, SessionTable},
};

#[path = "session_support/checkpoint.rs"]
mod checkpoint;
#[path = "session_support/mod.rs"]
mod support;

#[derive(Default)]
struct Snapshots(AtomicUsize);

impl revert::Snapshots for Snapshots {
    fn capture(&self) -> Option<snapshot::Id> {
        self.0.fetch_add(1, Ordering::SeqCst);
        None
    }
    fn files(
        &self,
        _: &snapshot::Id,
        _: &snapshot::Id,
    ) -> Result<Vec<RelativePath>, revert::SnapshotFailure> {
        panic!("unexpected file read")
    }
    fn restore(&self, _: &[(RelativePath, snapshot::Id)]) -> Result<(), revert::SnapshotFailure> {
        panic!("unexpected restore")
    }
    fn diff(
        &self,
        _: &snapshot::Id,
        _: &snapshot::Id,
        _: &[RelativePath],
    ) -> Result<Vec<file_diff::Info>, revert::SnapshotFailure> {
        panic!("unexpected diff")
    }
}

fn state(store: &Store) -> impl PartialEq + std::fmt::Debug {
    let snapshot = store.snapshot().unwrap();
    (
        snapshot
            .scan::<SessionTable>(Bound::Unbounded, Bound::Unbounded, 1000)
            .unwrap(),
        snapshot
            .scan::<MessageTable>(Bound::Unbounded, Bound::Unbounded, 1000)
            .unwrap(),
        snapshot
            .scan::<EventTable>(Bound::Unbounded, Bound::Unbounded, 1000)
            .unwrap(),
        snapshot
            .scan::<ContextStateTable>(Bound::Unbounded, Bound::Unbounded, 1000)
            .unwrap(),
    )
}

fn without_id(message: &session_message::Info) -> JsonValue {
    let JsonValue::Object(mut message) = message.encode() else {
        panic!()
    };
    message.insert("id".into(), JsonValue::String("msg_copied".into()));
    JsonValue::Object(message)
}

#[tokio::test]
async fn pruned_or_unknown_checkpoint_target_returns_history_pruned_without_effect() {
    for prune in [false, true] {
        let store = support::store();
        let service = Service::new(store.client());
        let scenario = checkpoint::scenario(&store.client(), &service, "ses_main", 1).await;
        if prune {
            assert!(
                service
                    .prune_compacted(&scenario.session, 2, Vec::new)
                    .await
                    .unwrap()
                    .messages
                    > 0
            );
        }
        let before = state(&store);
        let info = service.get(&scenario.session).unwrap().unwrap();
        let snapshots = Snapshots::default();
        for target in [
            &scenario.ids.first_user,
            &scenario.ids.covered_user,
            &scenario.ids.fork_target,
            &scenario.ids.boundary,
            "msg_unknown",
        ] {
            let target = checkpoint::message_id(target);
            assert!(matches!(
                service.fork(&scenario.session, Some(target.clone())).await,
                Err(Error::Domain {
                    kind: "history_pruned",
                    ..
                })
            ));
            let rejected = revert::stage(&service, &snapshots, &info, &target, true, 3)
                .await
                .unwrap_err();
            assert!(
                rejected
                    .to_string()
                    .contains("history through the compaction checkpoint was removed"),
                "{rejected}"
            );
            assert_eq!(state(&store), before);
        }
        assert_eq!(snapshots.0.load(Ordering::SeqCst), 0);
        revert::stage(
            &service,
            &snapshots,
            &info,
            &checkpoint::message_id(&scenario.ids.tail_user),
            false,
            4,
        )
        .await
        .unwrap();
        assert!(
            service
                .get(&scenario.session)
                .unwrap()
                .unwrap()
                .revert
                .is_some()
        );
    }
}

#[tokio::test]
async fn foreign_message_remains_not_found() {
    let store = support::store();
    let service = Service::new(store.client());
    let scenario = checkpoint::scenario(&store.client(), &service, "ses_main", 1).await;
    let foreign = checkpoint::user(&service, "ses_two", "Other Session", 1).await;
    let before = state(&store);
    assert!(matches!(
        service
            .fork(&scenario.session, Some(checkpoint::message_id(&foreign)))
            .await,
        Err(Error::Domain {
            kind: "message_not_found",
            ..
        })
    ));
    assert!(matches!(
        revert::plan(
            &store.snapshot().unwrap(),
            &scenario.session,
            &checkpoint::message_id(&foreign)
        ),
        Err(revert::Error::MessageNotFound { .. })
    ));
    assert!(matches!(
        service
            .fork(
                &checkpoint::id("ses_two"),
                Some(checkpoint::message_id("msg_unknown"))
            )
            .await,
        Err(Error::Domain {
            kind: "message_not_found",
            ..
        })
    ));
    assert!(matches!(
        revert::plan(
            &store.snapshot().unwrap(),
            &checkpoint::id("ses_two"),
            &checkpoint::message_id("msg_unknown")
        ),
        Err(revert::Error::MessageNotFound { .. })
    ));
    assert_eq!(state(&store), before);
}

#[tokio::test]
async fn retained_fork_copies_summary_and_only_retained_prefix() {
    for prune in [false, true] {
        let store = support::store();
        let service = Service::new(store.client());
        let scenario = checkpoint::scenario(&store.client(), &service, "ses_main", 1).await;
        if prune {
            service
                .prune_compacted(&scenario.session, 2, Vec::new)
                .await
                .unwrap();
        }
        let target = checkpoint::message_id(&scenario.ids.tail_answer);
        let sequence = checkpoint::seq(&store.client(), &scenario.ids.tail_answer);
        let checkpoint = history_pruning::checkpoint(&store.snapshot().unwrap(), &scenario.session)
            .unwrap()
            .unwrap();
        for boundary in [Some(target.clone()), None] {
            let fork = service
                .fork(&scenario.session, boundary.clone())
                .await
                .unwrap();
            let copied = service.transcript(&fork.id).unwrap();
            let expected = service
                .transcript(&scenario.session)
                .unwrap()
                .into_iter()
                .filter(|message| {
                    boundary.is_none()
                        || match message {
                            session_message::Info::Synthetic(message)
                                if message.metadata.as_ref().is_some_and(|data| {
                                    data.get(&"compactionCheckpoint".into()).is_some()
                                }) =>
                            {
                                true
                            }
                            _ => {
                                let JsonValue::Object(data) = message.encode() else {
                                    panic!()
                                };
                                let Some(JsonValue::String(id)) = data.get(&"id".into()) else {
                                    panic!()
                                };
                                let seq = store
                                    .snapshot()
                                    .unwrap()
                                    .get::<MessageTable>(&ycoding_store::tuple_key(&[
                                        ycoding_store::KeyPart::String(id),
                                    ]))
                                    .unwrap()
                                    .unwrap()
                                    .seq;
                                seq > checkpoint.through && seq < sequence
                            }
                        }
                })
                .map(|message| without_id(&message))
                .collect::<Vec<_>>();
            assert_eq!(copied.iter().map(without_id).collect::<Vec<_>>(), expected);
            assert!(
                matches!(&copied[0], session_message::Info::Synthetic(message) if message.text.to_utf8().unwrap().contains(checkpoint::SUMMARY))
            );
            assert!(
                service
                    .first_user_message_if_only(&fork.id)
                    .unwrap()
                    .is_none()
            );
            assert!(
                !ycoding_schema::stringify_json(&JsonValue::Array(
                    copied.iter().map(without_id).collect()
                ))
                .contains("First answer")
            );
        }
    }
}
