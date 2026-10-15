use super::*;
use ycoding_core::ycoding_schema::{ObjectEncoder, stringify_json};
use ycoding_core::ycoding_store::{
    KeyPart,
    session::{
        ContextState, ContextStateTable, Job, JobTable, Manifest, ManifestTable, Message,
        MessageTable, Revision, RevisionTable,
    },
    tuple_key,
};

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
