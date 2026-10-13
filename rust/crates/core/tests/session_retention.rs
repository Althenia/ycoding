use std::{
    collections::BTreeMap,
    fs,
    ops::Bound,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use ycoding_core::{
    resources::config::{Configuration, LoadOptions, Roots},
    session::{retention, store::Service},
};
use ycoding_schema::{LosslessString, domain, instruction, parse_json, session};
use ycoding_store::{
    Catalog, IndexOrder, IndexQuery, KeyPart, Metadata, Options, Store, TableDeclaration,
    analytics, project, resources, session as tables, tuple_key,
};

const CATALOG: Catalog = Catalog::new(
    1,
    &[
        TableDeclaration::of::<project::ProjectTable>(),
        TableDeclaration::of::<project::WorkspaceTable>(),
        TableDeclaration::of::<tables::SequenceTable>(),
        TableDeclaration::of::<tables::EventTable>(),
        TableDeclaration::of::<tables::SessionTable>(),
        TableDeclaration::of::<tables::MessageTable>(),
        TableDeclaration::of::<tables::PendingTable>(),
        TableDeclaration::of::<tables::TaskTable>(),
        TableDeclaration::of::<tables::NotificationTable>(),
        TableDeclaration::of::<tables::TodoTable>(),
        TableDeclaration::of::<tables::TodoStateTable>(),
        TableDeclaration::of::<tables::FileChangeTable>(),
        TableDeclaration::of::<tables::JobTable>(),
        TableDeclaration::of::<tables::RevisionTable>(),
        TableDeclaration::of::<tables::ContextStateTable>(),
        TableDeclaration::of::<tables::InstructionEntryTable>(),
        TableDeclaration::of::<tables::InstructionBlobTable>(),
        TableDeclaration::of::<tables::InstructionStateTable>(),
        TableDeclaration::of::<resources::RequestTable>(),
        TableDeclaration::of::<resources::UsageTable>(),
        TableDeclaration::of::<resources::ContinuationGenerationTable>(),
        TableDeclaration::of::<resources::ContinuationTable>(),
        TableDeclaration::of::<resources::StateBlobTable>(),
        TableDeclaration::of::<resources::StateLinkTable>(),
        TableDeclaration::of::<tables::ManifestTable>(),
        TableDeclaration::of::<tables::ExclusionTable>(),
        TableDeclaration::of::<analytics::DeliveryTable>(),
        TableDeclaration::of::<analytics::IntentTable>(),
    ],
);

const DAY: i64 = 24 * 60 * 60 * 1000;
const NOW: i64 = 100 * DAY;
const OLD: i64 = NOW - 7 * DAY - 1;
const RECENT: i64 = NOW - 7 * DAY;
const CUTOFF: i64 = NOW - 7 * DAY;
const INSTRUCTIONS: &str = "session.instructions.updated.2";

#[derive(Default)]
struct Seed {
    id: &'static str,
    updated: i64,
    parent: Option<&'static str>,
    fork: Option<&'static str>,
    active: Option<i64>,
    pinned: bool,
    suspended: bool,
    goal: bool,
    pending: bool,
    instruction: Option<&'static str>,
    manifest: Option<&'static str>,
    provider_state: Option<&'static str>,
}

fn store() -> Store {
    let store = Store::disposable(Options::core(), CATALOG, Metadata::new([9; 16], 1)).unwrap();
    store
        .submit(|tx| {
            project::ProjectTable::insert(
                tx,
                &project::Project {
                    id: "global".into(),
                    worktree: "/project".into(),
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
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    store
}

fn digest(value: &str) -> LosslessString {
    ring::digest::digest(&ring::digest::SHA256, value.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
        .as_str()
        .into()
}

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn json(text: &str) -> ycoding_schema::JsonValue {
    parse_json(text).unwrap()
}

fn seed(store: &Store, input: Seed) {
    store
        .submit(move |tx| {
            let sid: LosslessString = input.id.into();
            tables::SessionTable::insert(
                tx,
                &tables::Session {
                    id: sid.clone(),
                    project_id: "global".into(),
                    workspace_id: None,
                    parent_id: input.parent.map(Into::into),
                    fork_session_id: input.fork.map(Into::into),
                    fork_message_id: None,
                    fork_seq: input.fork.map(|_| 0),
                    directory: "/project".into(),
                    path: None,
                    title: input.id.into(),
                    cost: 0.0,
                    tokens_input: 0,
                    tokens_output: 0,
                    tokens_reasoning: 0,
                    tokens_cache_read: 0,
                    tokens_cache_write: 0,
                    revert: None,
                    permission: None,
                    autonomy: input.goal.then(|| {
                        json(r#"{"mode":"goal","yolo":0,"goal":{"status":"active"}}"#)
                    }),
                    autonomy_revision: 0,
                    orchestration_revision: 0,
                    agent: None,
                    model: None,
                    profile_binding: None,
                    daybreak: None,
                    time_created: input.updated,
                    time_updated: input.updated,
                    time_archived: None,
                    time_active: input.active,
                    time_pinned: input.pinned.then_some(input.updated),
                    time_suspended: input.suspended.then_some(input.updated),
                },
            )?;
            tables::SequenceTable::put(
                tx,
                &tables::Sequence {
                    aggregate_id: sid.clone(),
                    seq: 1,
                    owner_id: None,
                },
            )?;
            tables::EventTable::insert(
                tx,
                &tables::Event {
                    id: format!("evt_{}_0", input.id).as_str().into(),
                    aggregate_id: sid.clone(),
                    seq: 0,
                    created: input.updated,
                    type_: "session.created.2".into(),
                    data: json(&format!(r#"{{"sessionID":"{}"}}"#, input.id)),
                },
            )?;
            tables::MessageTable::insert(
                tx,
                &tables::Message {
                    id: format!("msg_{}", input.id).as_str().into(),
                    session_id: sid.clone(),
                    type_: "user".into(),
                    seq: 0,
                    time_created: input.updated,
                    time_updated: input.updated,
                    data: json("{}"),
                },
            )?;
            tables::RevisionTable::insert(tx, &revision(&sid, 0, None))?;
            if input.pending {
                tables::PendingTable::insert(
                    tx,
                    &tables::Pending {
                        id: format!("msg_pending_{}", input.id).as_str().into(),
                        session_id: sid.clone(),
                        type_: "user".into(),
                        data: json("{}"),
                        delivery: None,
                        admitted_seq: 1,
                        time_created: input.updated,
                    },
                )?;
            }
            if let Some(value) = input.instruction {
                let hash = digest(value);
                instruction_blob(tx, &hash)?;
                let hash = hash.as_str().unwrap();
                tables::EventTable::insert(
                    tx,
                    &tables::Event {
                        id: format!("evt_{}_1", input.id).as_str().into(),
                        aggregate_id: sid.clone(),
                        seq: 1,
                        created: input.updated,
                        type_: INSTRUCTIONS.into(),
                        data: json(&format!(
                            r#"{{"sessionID":"{}","delta":{{"global/agents.md":"{hash}","project/old":"removed"}}}}"#,
                            input.id
                        )),
                    },
                )?;
                let values = tables::Document::<instruction::Values>::new(json(&format!(
                    r#"{{"global/agents.md":"{hash}"}}"#
                )))?;
                tables::InstructionStateTable::insert(
                    tx,
                    &tables::InstructionState {
                        session_id: sid.clone(),
                        epoch_start: 1,
                        through_seq: 1,
                        initial_values: values.clone(),
                        current_values: values,
                    },
                )?;
            }
            if let Some(value) = input.manifest {
                let hash = digest(value);
                if tx.get::<tables::ManifestTable>(&key(&hash))?.is_none() {
                    tables::ManifestTable::insert(
                        tx,
                        &tables::Manifest {
                            digest: hash.clone(),
                            schema_version: 1,
                            content: tables::Document::<domain::Json>::new(json("{}"))?,
                            input_tokens: 1,
                            retained_tokens: 1,
                            time_created: 0,
                        },
                    )?;
                }
                tables::RevisionTable::insert(tx, &revision(&sid, 1, Some(hash)))?;
            }
            if let Some(value) = input.provider_state {
                let hash = digest(value);
                resources::capture_state(
                    tx,
                    &resources::StateBlob {
                        digest: hash.clone(),
                        provider: "openai".into(),
                        model_id: "gpt-5.6".into(),
                        item_type: "reasoning".into(),
                        content: tables::Document::<domain::Json>::new(json("{}"))?,
                        time_created: 0,
                    },
                    &resources::StateLink {
                        session_id: sid.clone(),
                        message_id: format!("msg_{}", input.id).as_str().into(),
                        part_ordinal: 0,
                        part_kind: "reasoning".into(),
                        provider: "openai".into(),
                        model_id: "gpt-5.6".into(),
                        blob_digest: hash,
                        context_revision: 0,
                        time_created: 0,
                    },
                )?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn revision(
    session: &LosslessString,
    revision: i64,
    manifest: Option<LosslessString>,
) -> tables::Revision {
    tables::Revision {
        session_id: session.clone(),
        revision,
        parent_revision: (revision > 0).then(|| revision - 1),
        manifest_digest: manifest,
        covered_through_message_id: None,
        covered_through_seq: None,
        activation_event_id: None,
        activation_sequence: None,
        time_created: 0,
    }
}

fn instruction_blob(
    tx: &mut ycoding_store::Write<'_>,
    hash: &LosslessString,
) -> Result<(), ycoding_store::Error> {
    if tx
        .get::<tables::InstructionBlobTable>(&key(hash))?
        .is_none()
    {
        tables::InstructionBlobTable::insert(
            tx,
            &tables::InstructionBlob {
                hash: hash.clone(),
                value: Some(tables::Document::new(json(r#""text""#))?),
            },
        )?;
    }
    Ok(())
}

fn key(value: &LosslessString) -> Vec<u8> {
    tuple_key(&[KeyPart::String(value)])
}

fn update(
    store: &Store,
    session: &'static str,
    change: impl FnOnce(&mut tables::Session) + Send + 'static,
) {
    store
        .submit(move |tx| {
            let mut row = tx
                .get::<tables::SessionTable>(&key(&session.into()))?
                .unwrap();
            change(&mut row);
            tables::SessionTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
}

#[derive(Debug, PartialEq)]
struct Rows {
    session: usize,
    sequence: usize,
    events: usize,
    messages: usize,
    revisions: usize,
}

const GONE: Rows = Rows {
    session: 0,
    sequence: 0,
    events: 0,
    messages: 0,
    revisions: 0,
};

fn rows(store: &Store, value: &str) -> Rows {
    let snapshot = store.snapshot().unwrap();
    let sid: LosslessString = value.into();
    let prefix = key(&sid);
    let mut upper = prefix.clone();
    *upper.last_mut().unwrap() += 1;
    let query = IndexQuery {
        lower: Bound::Unbounded,
        upper: Bound::Unbounded,
        prefix: Some(&prefix),
        order: IndexOrder::Ascending,
        after: None,
        limit: usize::MAX,
    };
    Rows {
        session: snapshot
            .get::<tables::SessionTable>(&prefix)
            .unwrap()
            .into_iter()
            .count(),
        sequence: snapshot
            .get::<tables::SequenceTable>(&prefix)
            .unwrap()
            .into_iter()
            .count(),
        events: snapshot
            .index_range::<tables::EventTable>("event_aggregate_seq_idx", query)
            .unwrap()
            .len(),
        messages: snapshot
            .index_range::<tables::MessageTable>("session_message_session_seq_idx", query)
            .unwrap()
            .len(),
        revisions: snapshot
            .scan::<tables::RevisionTable>(
                Bound::Included(&prefix),
                Bound::Excluded(&upper),
                usize::MAX,
            )
            .unwrap()
            .len(),
    }
}

#[derive(Debug, PartialEq)]
struct Blobs {
    instruction: usize,
    manifest: usize,
    provider_state: usize,
}

fn blobs(store: &Store, value: &str) -> Blobs {
    let snapshot = store.snapshot().unwrap();
    let hash = key(&digest(value));
    Blobs {
        instruction: snapshot
            .get::<tables::InstructionBlobTable>(&hash)
            .unwrap()
            .into_iter()
            .count(),
        manifest: snapshot
            .get::<tables::ManifestTable>(&hash)
            .unwrap()
            .into_iter()
            .count(),
        provider_state: snapshot
            .get::<resources::StateBlobTable>(&hash)
            .unwrap()
            .into_iter()
            .count(),
    }
}

fn removed(store: &Store, value: &str) {
    assert_eq!(rows(store, value), GONE, "{value}");
}

fn kept(store: &Store, value: &str) {
    assert_eq!(rows(store, value).session, 1, "{value}");
}

type Active = Arc<Mutex<Vec<session::Id>>>;
type Change = Box<dyn Fn(&Store, &Active)>;

fn active(set: &Active) -> impl Fn() -> Vec<session::Id> + Clone + Send + 'static {
    let set = set.clone();
    move || set.lock().unwrap().clone()
}

async fn cleanup(store: &Store, days: i64, set: &Active) -> usize {
    let sweep = Service::new(store.client())
        .retain(NOW, days, active(set))
        .await
        .unwrap();
    assert!(sweep.failures.is_empty(), "{:?}", sweep.failures);
    sweep.deleted
}

#[tokio::test]
async fn deletes_an_idle_family_with_its_events_projections_and_orphaned_blobs() {
    let store = store();
    seed(
        &store,
        Seed {
            id: "ses_old_root",
            updated: OLD,
            instruction: Some("old root"),
            manifest: Some("old manifest"),
            ..Seed::default()
        },
    );
    seed(
        &store,
        Seed {
            id: "ses_old_child",
            parent: Some("ses_old_root"),
            updated: OLD,
            provider_state: Some("old reasoning"),
            ..Seed::default()
        },
    );
    seed(
        &store,
        Seed {
            id: "ses_old_grandchild",
            parent: Some("ses_old_child"),
            updated: OLD,
            ..Seed::default()
        },
    );

    assert_eq!(cleanup(&store, 7, &Active::default()).await, 3);

    removed(&store, "ses_old_root");
    removed(&store, "ses_old_child");
    removed(&store, "ses_old_grandchild");
    assert_eq!(blobs(&store, "old root").instruction, 0);
    assert_eq!(blobs(&store, "old manifest").manifest, 0);
    assert_eq!(blobs(&store, "old reasoning").provider_state, 0);
}

#[tokio::test]
async fn publishes_session_deleted_for_every_member_children_first() {
    let store = store();
    let published = Arc::new(Mutex::new(Vec::new()));
    let observed = published.clone();
    store.observe_events(move |events| {
        observed.lock().unwrap().extend(
            events
                .iter()
                .map(|event| (event.type_.clone(), event.aggregate_id.clone())),
        );
        true
    });
    seed(
        &store,
        Seed {
            id: "ses_root",
            updated: OLD,
            ..Seed::default()
        },
    );
    seed(
        &store,
        Seed {
            id: "ses_child",
            parent: Some("ses_root"),
            updated: OLD,
            ..Seed::default()
        },
    );

    assert_eq!(cleanup(&store, 7, &Active::default()).await, 2);

    assert_eq!(
        *published.lock().unwrap(),
        vec![
            ("session.deleted.2".into(), "ses_child".into()),
            ("session.deleted.2".into(), "ses_root".into()),
        ]
    );
}

#[tokio::test]
async fn keeps_families_with_any_activity_inside_the_retention_window() {
    let store = store();
    seed(
        &store,
        Seed {
            id: "ses_boundary",
            updated: RECENT,
            ..Seed::default()
        },
    );
    seed(
        &store,
        Seed {
            id: "ses_recent_child_root",
            updated: OLD,
            ..Seed::default()
        },
    );
    seed(
        &store,
        Seed {
            id: "ses_recent_child",
            parent: Some("ses_recent_child_root"),
            updated: RECENT,
            ..Seed::default()
        },
    );
    seed(
        &store,
        Seed {
            id: "ses_recent_active",
            updated: OLD,
            active: Some(RECENT),
            ..Seed::default()
        },
    );

    assert_eq!(cleanup(&store, 7, &Active::default()).await, 0);

    for value in [
        "ses_boundary",
        "ses_recent_child_root",
        "ses_recent_child",
        "ses_recent_active",
    ] {
        kept(&store, value);
    }
}

#[tokio::test]
async fn keeps_exempt_families() {
    let store = store();
    seed(
        &store,
        Seed {
            id: "ses_pinned",
            updated: OLD,
            pinned: true,
            ..Seed::default()
        },
    );
    seed(
        &store,
        Seed {
            id: "ses_goal_root",
            updated: OLD,
            ..Seed::default()
        },
    );
    seed(
        &store,
        Seed {
            id: "ses_goal_child",
            parent: Some("ses_goal_root"),
            updated: OLD,
            goal: true,
            ..Seed::default()
        },
    );
    seed(
        &store,
        Seed {
            id: "ses_suspended",
            updated: OLD,
            suspended: true,
            ..Seed::default()
        },
    );
    seed(
        &store,
        Seed {
            id: "ses_pending_root",
            updated: OLD,
            ..Seed::default()
        },
    );
    seed(
        &store,
        Seed {
            id: "ses_pending_child",
            parent: Some("ses_pending_root"),
            updated: OLD,
            pending: true,
            ..Seed::default()
        },
    );
    seed(
        &store,
        Seed {
            id: "ses_running_root",
            updated: OLD,
            ..Seed::default()
        },
    );
    seed(
        &store,
        Seed {
            id: "ses_running_child",
            parent: Some("ses_running_root"),
            updated: OLD,
            ..Seed::default()
        },
    );
    seed(
        &store,
        Seed {
            id: "ses_fork_source",
            updated: OLD,
            ..Seed::default()
        },
    );
    seed(
        &store,
        Seed {
            id: "ses_fork",
            updated: RECENT,
            fork: Some("ses_fork_source"),
            ..Seed::default()
        },
    );
    let set = Active::new(Mutex::new(vec![id("ses_running_child")]));

    assert_eq!(cleanup(&store, 7, &set).await, 0);

    for value in [
        "ses_pinned",
        "ses_goal_root",
        "ses_goal_child",
        "ses_suspended",
        "ses_pending_root",
        "ses_pending_child",
        "ses_running_root",
        "ses_running_child",
        "ses_fork_source",
        "ses_fork",
    ] {
        kept(&store, value);
    }
}

#[tokio::test]
async fn rechecks_a_selected_family_inside_its_deletion_transaction() {
    let store = store();
    let sessions = Service::new(store.client());
    seed(
        &store,
        Seed {
            id: "ses_touched",
            updated: OLD,
            ..Seed::default()
        },
    );
    seed(
        &store,
        Seed {
            id: "ses_untouched",
            updated: OLD,
            ..Seed::default()
        },
    );

    let selected = sessions.idle_roots(CUTOFF).unwrap();
    assert_eq!(selected, vec![id("ses_touched"), id("ses_untouched")]);
    update(&store, "ses_touched", |row| row.time_updated = NOW);

    let set = Active::default();
    let touched = sessions
        .remove_idle(&selected[0], NOW, CUTOFF, active(&set))
        .await
        .unwrap();
    let untouched = sessions
        .remove_idle(&selected[1], NOW, CUTOFF, active(&set))
        .await
        .unwrap();

    assert!(touched.members.is_empty());
    kept(&store, "ses_touched");
    assert_eq!(untouched.members, vec![id("ses_untouched")]);
    removed(&store, "ses_untouched");
}

#[tokio::test]
async fn work_that_starts_between_scan_and_delete_keeps_the_family() {
    let store = store();
    let sessions = Service::new(store.client());
    let cases: [(&str, Change); 9] = [
        (
            "ses_race_activity",
            Box::new(|store: &Store, _: &Active| {
                update(store, "ses_race_activity_child", |row| {
                    row.time_active = Some(NOW)
                })
            }),
        ),
        (
            "ses_race_pending",
            Box::new(|store: &Store, _: &Active| {
                store
                    .submit(|tx| {
                        tables::PendingTable::insert(
                            tx,
                            &tables::Pending {
                                id: "msg_race_pending".into(),
                                session_id: "ses_race_pending_child".into(),
                                type_: "user".into(),
                                data: json("{}"),
                                delivery: Some("steer".into()),
                                admitted_seq: 2,
                                time_created: NOW,
                            },
                        )
                    })
                    .unwrap()
                    .wait()
                    .unwrap();
            }),
        ),
        (
            "ses_race_execution",
            Box::new(|_: &Store, set: &Active| {
                set.lock().unwrap().push(id("ses_race_execution_child"))
            }),
        ),
        (
            "ses_race_pin",
            Box::new(|store: &Store, _: &Active| {
                update(store, "ses_race_pin_child", |row| {
                    row.time_pinned = Some(NOW)
                })
            }),
        ),
        (
            "ses_race_suspend",
            Box::new(|store: &Store, _: &Active| {
                update(store, "ses_race_suspend_child", |row| {
                    row.time_suspended = Some(NOW)
                })
            }),
        ),
        (
            "ses_race_goal",
            Box::new(|store: &Store, _: &Active| {
                update(store, "ses_race_goal_child", |row| {
                    row.autonomy = Some(json(
                        r#"{"mode":"goal","yolo":0,"goal":{"status":"active"}}"#,
                    ))
                })
            }),
        ),
        (
            "ses_race_fork",
            Box::new(|store: &Store, _: &Active| {
                seed(
                    store,
                    Seed {
                        id: "ses_race_forked",
                        updated: OLD,
                        fork: Some("ses_race_fork_child"),
                        ..Seed::default()
                    },
                )
            }),
        ),
        (
            "ses_race_new_child",
            Box::new(|store: &Store, _: &Active| {
                seed(
                    store,
                    Seed {
                        id: "ses_race_new_child_late",
                        parent: Some("ses_race_new_child"),
                        updated: NOW,
                        ..Seed::default()
                    },
                )
            }),
        ),
        (
            "ses_race_reparent",
            Box::new(|store: &Store, _: &Active| {
                update(store, "ses_race_reparent", |row| {
                    row.parent_id = Some("ses_race_host".into())
                })
            }),
        ),
    ];
    seed(
        &store,
        Seed {
            id: "ses_race_host",
            updated: NOW,
            ..Seed::default()
        },
    );
    for (root, _) in &cases {
        seed(
            &store,
            Seed {
                id: root,
                updated: OLD,
                ..Seed::default()
            },
        );
        let child: &'static str = format!("{root}_child").leak();
        seed(
            &store,
            Seed {
                id: child,
                parent: Some(*root),
                updated: OLD,
                ..Seed::default()
            },
        );
    }
    let selected = sessions.idle_roots(CUTOFF).unwrap();
    let set = Active::default();
    for (root, mutate) in &cases {
        assert!(
            selected.contains(&id(root)),
            "{root} selected before the race"
        );
        mutate(&store, &set);

        let removal = sessions
            .remove_idle(&id(root), NOW, CUTOFF, active(&set))
            .await
            .unwrap();

        assert!(removal.members.is_empty(), "{root}");
        kept(&store, root);
        kept(&store, &format!("{root}_child"));
    }
}

#[tokio::test]
async fn deletion_racing_with_concurrent_writers_never_loses_a_touched_family() {
    let store = store();
    let sessions = Service::new(store.client());
    let names: Vec<&'static str> = (0..40)
        .map(|index| &*format!("ses_concurrent_{index:02}").leak())
        .collect();
    for name in names.iter().copied() {
        seed(
            &store,
            Seed {
                id: name,
                updated: OLD,
                ..Seed::default()
            },
        );
    }
    let selected = sessions.idle_roots(CUTOFF).unwrap();
    assert_eq!(selected.len(), names.len());
    let client = store.client();
    let writer = tokio::spawn(async move {
        let mut applied = Vec::new();
        for name in names.iter().copied().step_by(2) {
            let touched = client
                .submit(move |tx| {
                    let Some(mut row) = tx.get::<tables::SessionTable>(&key(&name.into()))? else {
                        return Ok(false);
                    };
                    row.time_updated = NOW;
                    tables::SessionTable::put(tx, &row)?;
                    Ok(true)
                })
                .unwrap()
                .await
                .unwrap();
            if touched {
                applied.push(name);
            }
            tokio::task::yield_now().await;
        }
        applied
    });
    let set = Active::default();
    let mut deleted = Vec::new();
    for root in &selected {
        deleted.extend(
            sessions
                .remove_idle(root, NOW, CUTOFF, active(&set))
                .await
                .unwrap()
                .members,
        );
        tokio::task::yield_now().await;
    }
    let applied = writer.await.unwrap();

    assert!(!applied.is_empty(), "the race touched no selected family");
    for name in &applied {
        assert!(
            !deleted.contains(&id(name)),
            "{name} deleted after its touch"
        );
        kept(&store, name);
    }
    for root in &selected {
        let present = rows(&store, root.as_lossless().as_str().unwrap()).session == 1;
        assert_ne!(present, deleted.contains(root), "{root:?}");
    }
}

#[tokio::test]
async fn preserves_blobs_still_referenced_by_a_kept_session() {
    let store = store();
    seed(
        &store,
        Seed {
            id: "ses_shared_old",
            updated: OLD,
            instruction: Some("shared"),
            manifest: Some("shared"),
            provider_state: Some("shared"),
            ..Seed::default()
        },
    );
    seed(
        &store,
        Seed {
            id: "ses_shared_kept",
            updated: RECENT,
            instruction: Some("shared"),
            manifest: Some("shared"),
            provider_state: Some("shared"),
            ..Seed::default()
        },
    );

    assert_eq!(cleanup(&store, 7, &Active::default()).await, 1);

    removed(&store, "ses_shared_old");
    kept(&store, "ses_shared_kept");
    assert_eq!(
        blobs(&store, "shared"),
        Blobs {
            instruction: 1,
            manifest: 1,
            provider_state: 1
        }
    );
}

#[tokio::test]
async fn deletes_unreferenced_instruction_blobs_across_chunks_after_the_sweep() {
    let store = store();
    let values: Vec<String> = (0..1200).map(|index| format!("chunked {index}")).collect();
    seed(
        &store,
        Seed {
            id: "ses_chunked_old",
            updated: OLD,
            ..Seed::default()
        },
    );
    seed(
        &store,
        Seed {
            id: "ses_chunked_kept",
            updated: RECENT,
            instruction: Some("chunked 1100"),
            ..Seed::default()
        },
    );
    let delta = values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            format!(
                r#""global/chunked-{index}":"{}""#,
                digest(value).as_str().unwrap()
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let hashes: Vec<LosslessString> = values.iter().map(|value| digest(value)).collect();
    store
        .submit(move |tx| {
            for hash in &hashes {
                instruction_blob(tx, hash)?;
            }
            tables::EventTable::insert(
                tx,
                &tables::Event {
                    id: "evt_chunked".into(),
                    aggregate_id: "ses_chunked_old".into(),
                    seq: 1,
                    created: OLD,
                    type_: INSTRUCTIONS.into(),
                    data: json(&format!(
                        r#"{{"sessionID":"ses_chunked_old","delta":{{{delta}}}}}"#
                    )),
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();

    assert_eq!(cleanup(&store, 7, &Active::default()).await, 1);

    removed(&store, "ses_chunked_old");
    let remaining: Vec<&String> = values
        .iter()
        .filter(|value| blobs(&store, value).instruction == 1)
        .collect();
    assert_eq!(remaining, vec!["chunked 1100"]);
}

struct Directory(PathBuf);

impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn configuration(document: Option<&str>) -> (Directory, Configuration) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let root = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "session-retention-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let roots = Roots::development(&root).unwrap();
    fs::create_dir_all(&roots.config).unwrap();
    if let Some(document) = document {
        fs::write(roots.config.join("ycoding.json"), document).unwrap();
    }
    let configuration = Configuration::load(LoadOptions {
        directory: roots.config.clone(),
        roots,
        project: false,
        file: None,
        content: None,
        env: BTreeMap::new(),
    })
    .unwrap();
    (Directory(root), configuration)
}

#[tokio::test]
async fn uses_the_configured_retention_days() {
    let (_directory, config) = configuration(Some(r#"{"session_retention":{"days":3}}"#));
    assert!(config.diagnostics.is_empty(), "{:?}", config.diagnostics);
    let days = retention::days(&config);
    assert_eq!(days, 3);
    let store = store();
    seed(
        &store,
        Seed {
            id: "ses_four_days",
            updated: NOW - 4 * DAY,
            ..Seed::default()
        },
    );
    seed(
        &store,
        Seed {
            id: "ses_two_days",
            updated: NOW - 2 * DAY,
            ..Seed::default()
        },
    );

    assert_eq!(cleanup(&store, days, &Active::default()).await, 1);

    removed(&store, "ses_four_days");
    kept(&store, "ses_two_days");
}

#[test]
fn retention_days_default_to_seven_and_reject_non_positive_values() {
    let (_absent, absent) = configuration(None);
    assert_eq!(retention::days(&absent), retention::DEFAULT_DAYS);
    assert_eq!(retention::DEFAULT_DAYS, 7);
    for invalid in ["0", "-1", "1.5", r#""3""#] {
        let (_directory, config) = configuration(Some(&format!(
            r#"{{"session_retention":{{"days":{invalid}}}}}"#
        )));
        assert_eq!(config.diagnostics.len(), 1, "{invalid}");
        assert_eq!(retention::days(&config), 7, "{invalid}");
    }
}
