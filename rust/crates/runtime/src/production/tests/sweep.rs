use super::*;

#[test]
fn empty_retention_preserves_analytics_but_deletions_and_pending_purges_require_it() {
    let store = Store::disposable(
        Options::core(),
        ycoding_core::ycoding_store::import::catalog(
            ycoding_core::ycoding_store::import::DatabaseKind::Core,
        ),
        Metadata::new([31; 16], 1),
    )
    .unwrap();
    let client = store.client();
    assert!(matches!(
        client.analytics(),
        Err(ycoding_core::ycoding_store::analytics::Error::Unavailable)
    ));
    assert!(reconcile_retention_analytics(&client, 0).is_ok());
    assert!(matches!(
        reconcile_retention_analytics(&client, 1),
        Err(ycoding_core::ycoding_store::analytics::Error::Unavailable)
    ));
    for all in [false, true] {
        store
            .submit(move |tx| {
                ycoding_core::ycoding_store::analytics::privacy_changed(tx, vec![1], true)?;
                if all {
                    let mut state = tx
                        .get::<ycoding_core::ycoding_store::analytics::DeliveryTable>(&[])?
                        .unwrap();
                    state.purges.clear();
                    state.purge_all = true;
                    tx.put::<ycoding_core::ycoding_store::analytics::DeliveryTable>(&state)?;
                }
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
        assert!(matches!(
            reconcile_retention_analytics(&client, 0),
            Err(ycoding_core::ycoding_store::analytics::Error::Unavailable)
        ));
    }
}
use ycoding_core::ycoding_schema::{ObjectEncoder, stringify_json};
use ycoding_core::ycoding_store::{
    KeyPart,
    session::{
        ContextState, ContextStateTable, Job, JobTable, Manifest, ManifestTable, Message,
        MessageTable, Revision, RevisionTable,
    },
    tuple_key,
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn first_location_boot_refreshes_copies_once_and_reload_does_not_repeat_it() {
    let f = fixture("{}", "{}");
    let missing = f
        .directory()
        .join("missing-copy")
        .to_str()
        .unwrap()
        .to_owned();
    let row = ycoding_core::ycoding_store::project::Directory {
        project_id: "prj_one".into(),
        directory: missing.clone().into(),
        type_: Some("copy".into()),
        strategy: Some("git_worktree".into()),
        time_created: 1,
    };
    let first = row.clone();
    f.store
        .submit(move |tx| ycoding_core::ycoding_store::project::DirectoryTable::insert(tx, &first))
        .unwrap()
        .await
        .unwrap();
    let notify = Arc::new(tokio::sync::Notify::new());
    let wake = notify.clone();
    let updates = f
        .feed
        .subscribe_types(
            ycoding_core::event_feed::Scope::Global,
            &["project.directories.updated"],
            move || wake.notify_one(),
        )
        .unwrap();
    let locations = f.locations();
    let held = f.services(&locations);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if f.store
                .client()
                .snapshot()
                .unwrap()
                .scan::<ycoding_core::ycoding_store::project::DirectoryTable>(
                    std::ops::Bound::Unbounded,
                    std::ops::Bound::Unbounded,
                    100,
                )
                .unwrap()
                .iter()
                .all(|row| row.directory.as_str() != Some(&missing))
            {
                break;
            }
            notify.notified().await;
        }
    })
    .await
    .unwrap();
    f.store
        .submit(move |tx| ycoding_core::ycoding_store::project::DirectoryTable::insert(tx, &row))
        .unwrap()
        .await
        .unwrap();
    let _again = f.services(&locations);
    locations.reload(&held.info).unwrap();
    locations.close().unwrap();
    assert!(
        f.store
            .client()
            .snapshot()
            .unwrap()
            .scan::<ycoding_core::ycoding_store::project::DirectoryTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                100
            )
            .unwrap()
            .iter()
            .any(|row| row.directory.as_str() == Some(&missing)),
        "reload and repeated acquire cannot repeat the boot-only refresh"
    );
    assert_eq!(std::iter::from_fn(|| updates.next().unwrap()).count(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn repository_observer_publishes_files_and_head_and_joins_on_eviction() {
    let f = fixture("{}", "{}");
    assert!(
        std::process::Command::new("git")
            .args(["init", "--quiet", "-b", "main"])
            .current_dir(f.directory())
            .status()
            .unwrap()
            .success()
    );
    std::fs::write(f.directory().join(".git/ycoding"), "prj_one").unwrap();
    let notify = Arc::new(tokio::sync::Notify::new());
    let wake = notify.clone();
    let changes = f
        .feed
        .subscribe_types(
            ycoding_core::event_feed::Scope::Global,
            &["filesystem.changed", "vcs.branch.updated"],
            move || wake.notify_one(),
        )
        .unwrap();
    let locations = f.locations();
    let held = f.services(&locations);
    std::fs::write(f.directory().join("observed.txt"), "Observed content").unwrap();
    std::fs::write(f.directory().join(".git/HEAD"), "ref: refs/heads/next\n").unwrap();
    let mut filesystem = false;
    let mut branch = false;
    tokio::time::timeout(Duration::from_secs(5), async {
        while !(filesystem && branch) {
            notify.notified().await;
            while let Some(item) = changes.next().unwrap() {
                let ycoding_core::event_feed::Payload::Ephemeral(event) = &item.payload else {
                    panic!()
                };
                assert_eq!(
                    event.location.as_ref().unwrap().directory,
                    held.info.directory
                );
                match &event.data {
                    ycoding_core::event_feed::Data::FilesystemChanged(data) => {
                        filesystem |= data
                            .file
                            .as_str()
                            .is_some_and(|file| file.ends_with("observed.txt"))
                    }
                    ycoding_core::event_feed::Data::VcsBranchUpdated(data) => {
                        branch |=
                            data.branch.as_ref().and_then(|branch| branch.as_str()) == Some("next")
                    }
                    _ => panic!(),
                }
            }
        }
    })
    .await
    .unwrap();
    locations
        .evict(held.info.directory.as_lossless(), None)
        .unwrap();
    assert_eq!(
        f.factory.globals.watcher.active_count().unwrap(),
        0,
        "eviction joins configuration and repository observer subscriptions even with a held generation"
    );
    locations.close().unwrap();
}

#[test]
fn home_location_without_a_repository_has_no_ordinary_filesystem_observer_to_join() {
    let f = fixture("{}", "{}");
    let locations = f.locations();
    let home = locations
        .location(&f.roots.home.to_str().unwrap().into(), None)
        .unwrap();
    assert!(home.production.is_some());
    locations.close().unwrap();
}

#[tokio::test]
async fn production_startup_and_hourly_sweep_prune_local_only() {
    let f = fixture("{}", "{}");
    let now = crate::ids::now_millis();
    f.store
        .submit(move |tx| {
            for name in ["local", "remote", "active"] {
                let id = format!("ses_{name}");
                let mut row = catalog_fixture::record(&id);
                row.time_updated = now;
                SessionTable::insert(tx, &row)?;
                RevisionTable::insert(
                    tx,
                    &Revision {
                        session_id: id.as_str().into(),
                        revision: 0,
                        parent_revision: None,
                        manifest_digest: None,
                        covered_through_message_id: None,
                        covered_through_seq: None,
                        activation_event_id: None,
                        activation_sequence: None,
                        time_created: now,
                    },
                )?;
                let data = parse_json(&format!(
                    r#"{{"text":"Covered {name}","time":{{"created":{now}}}}}"#
                ))
                .unwrap();
                for seq in 1..=206 {
                    MessageTable::insert(
                        tx,
                        &Message {
                            id: format!("msg_{name}_{seq}").into(),
                            session_id: id.as_str().into(),
                            type_: "synthetic".into(),
                            seq,
                            time_created: now,
                            time_updated: now,
                            data: data.clone(),
                        },
                    )?;
                }
                let boundary = format!("msg_{name}_206");
                let digest = ycoding_core::session::prompt_cache::sha256(&id);
                let covered = ObjectEncoder::new()
                    .field("messageID", boundary.as_str())
                    .field("seq", &206.0)
                    .finish();
                let manifest = ObjectEncoder::new().field("schemaVersion", &1.0);
                let manifest = if name == "remote" {
                    manifest.field("remote", &parse_json(r#"{"provider":"openai"}"#).unwrap())
                } else {
                    manifest.field(
                        "summary",
                        &ObjectEncoder::new()
                            .field("text", "Summary")
                            .field("coveredThrough", &covered)
                            .field("digest", &ycoding_core::instructions::hash(&data).encode())
                            .finish(),
                    )
                }
                .finish();
                ManifestTable::insert(
                    tx,
                    &Manifest {
                        digest: digest.as_str().into(),
                        schema_version: 1,
                        content: Document::new(manifest)?,
                        input_tokens: 1000,
                        retained_tokens: 100,
                        time_created: now,
                    },
                )?;
                ContextStateTable::insert(
                    tx,
                    &ContextState {
                        session_id: id.as_str().into(),
                        status: "active".into(),
                        revision: 0,
                        manifest_digest: Some(digest.as_str().into()),
                        covered_through_message_id: Some(boundary.as_str().into()),
                        covered_through_seq: Some(206),
                        activated_event_id: Some(format!("evt_{name}").into()),
                        time_activated: Some(now),
                        error_code: None,
                    },
                )?;
                JobTable::insert(
                    tx,
                    &Job {
                        id: format!("cmp_{name}").into(),
                        session_id: id.as_str().into(),
                        legacy_input_id: None,
                        trigger: "manual".into(),
                        requested_through_message_id: boundary.into(),
                        requested_through_seq: 206,
                        base_context_revision: 0,
                        target_max_input_tokens: Some(1000),
                        config_digest: Some("a".repeat(64).into()),
                        status: "ended".into(),
                        lease_owner: None,
                        lease_expires_at: None,
                        attempts: 1,
                        manifest_digest: Some(digest.into()),
                        error_code: None,
                        error_message: None,
                        time_created: now,
                        time_started: Some(now),
                        time_ended: Some(now),
                        usage_anchor: None,
                    },
                )?;
            }
            Ok(())
        })
        .unwrap()
        .await
        .unwrap();
    let (sleeps, mut receiver) = mpsc::unbounded_channel();
    let clock = Arc::new(Clock {
        now: AtomicI64::new(now),
        sleeps,
    });
    let active = Arc::new(Mutex::new(vec![session::Id::new("ses_active").unwrap()]));
    let activity = active.clone();
    let maintenance = Maintenance::new(&f.factory);
    maintenance.spawn(
        f.sessions(),
        f.locations(),
        f.factory.clone(),
        clock.clone(),
        Arc::new(move || activity.lock().unwrap().clone()),
    );
    let present = |name: &str| {
        f.store
            .snapshot()
            .unwrap()
            .get::<MessageTable>(&tuple_key(&[KeyPart::String(&name.into())]))
            .unwrap()
            .is_some()
    };
    let mut held = Vec::new();
    let first = hourly(&mut receiver, &mut held).await;
    assert!(
        !present("msg_local_1"),
        "startup must prune the eligible local checkpoint"
    );
    assert!(
        !present("msg_local_205"),
        "startup must complete all bounded batches"
    );
    assert!(present("msg_local_206"));
    assert!(present("msg_remote_1"));
    assert!(present("msg_active_1"));
    active.lock().unwrap().clear();
    assert!(present("msg_active_1"));
    clock.now.store(now + 3_600_000, Ordering::SeqCst);
    first.release.send(()).unwrap();
    let _second = hourly(&mut receiver, &mut held).await;
    assert!(
        !present("msg_active_1"),
        "the hourly sweep retries a formerly executing Session"
    );
    assert!(present("msg_active_206"));
    assert!(present("msg_remote_1"));
    assert!(
        stringify_json(
            &f.sessions()
                .transcript(&session::Id::new("ses_local").unwrap())
                .unwrap()[0]
                .encode()
        )
        .contains("compactionCheckpoint")
    );
    maintenance.stop().await.unwrap();
    assert!(maintenance.task.lock().unwrap().is_none());
}
