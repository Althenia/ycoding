use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use ycoding_core::resources::attachment_store::{
    Error, MAX_BYTES, Store, managed_digest, managed_uri,
};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "ycoding-attachment-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn imports_exact_ts_reference_readonly_bytes_and_uri() {
    let temp = Temp::new();
    let store = Store::new(temp.0.join("data")).unwrap();
    assert!(!temp.0.join("data").exists());
    let content = store.import(b"managed attachment").unwrap();
    assert_eq!(
        content.digest.0.as_str(),
        Some("41ec6d391622f64880fe2995d08baef45ddfa52fbd06dd04fae881f57c3a828d")
    );
    assert_eq!(content.bytes.get(), 18);
    assert_eq!(
        content.path.as_str(),
        Some(
            "attachments/sha256/41/41ec6d391622f64880fe2995d08baef45ddfa52fbd06dd04fae881f57c3a828d"
        )
    );
    assert_eq!(store.read(&content).unwrap(), b"managed attachment");
    assert_eq!(store.import(b"managed attachment").unwrap(), content);
    assert_eq!(store.resolve_uri(&managed_uri(&content)).unwrap(), content);
    assert_eq!(
        managed_digest(&managed_uri(&content)),
        content.digest.0.as_str()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(store.absolute_path(&content).unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o400
        );
        assert_eq!(
            fs::metadata(temp.0.join("data"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
}

#[test]
fn detects_and_repairs_tampered_bytes_without_accepting_invalid_paths() {
    let temp = Temp::new();
    let store = Store::new(temp.0.clone()).unwrap();
    let mut content = store.import(b"original").unwrap();
    let path = store.absolute_path(&content).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    fs::write(&path, b"changed").unwrap();
    assert!(matches!(store.read(&content), Err(Error::Integrity)));
    assert_eq!(store.import(b"original").unwrap(), content);
    assert_eq!(store.read(&content).unwrap(), b"original");
    content.path = "../outside".into();
    assert!(matches!(store.read(&content), Err(Error::InvalidReference)));
    assert!(matches!(
        store.import(&vec![0; MAX_BYTES + 1]),
        Err(Error::Limit)
    ));
    for uri in [
        "ycoding-attachment://sha256/../outside",
        "https://example.invalid",
        "ycoding-attachment://sha256/ABC",
        "ycoding-attachment://sha256/",
    ] {
        assert!(managed_digest(uri).is_none());
        assert!(matches!(
            store.resolve_uri(uri),
            Err(Error::InvalidReference)
        ));
    }
}

#[test]
#[cfg(unix)]
fn rejects_symlinked_files_and_managed_directories() {
    use std::os::unix::fs::symlink;
    let temp = Temp::new();
    let store = Store::new(temp.0.join("data")).unwrap();
    let content = store.import(b"symlink target").unwrap();
    let path = store.absolute_path(&content).unwrap();
    fs::write(temp.0.join("outside"), b"symlink target").unwrap();
    fs::remove_file(&path).unwrap();
    symlink(temp.0.join("outside"), &path).unwrap();
    assert!(matches!(store.read(&content), Err(Error::InvalidReference)));
    assert!(matches!(
        store.import(b"symlink target"),
        Err(Error::InvalidReference)
    ));
    fs::remove_file(path).unwrap();
    let other = Store::new(temp.0.join("other")).unwrap();
    fs::create_dir(temp.0.join("other")).unwrap();
    symlink(
        temp.0.join("data/attachments"),
        temp.0.join("other/attachments"),
    )
    .unwrap();
    assert!(matches!(other.import(b"new"), Err(Error::InvalidReference)));
}

#[test]
fn resource_level_migration_retains_metadata_and_rejects_noncanonical_payloads() {
    use ycoding_core::resources::attachment_store::migration::migrate_record;
    use ycoding_schema::{parse_json, stringify_json};
    let temp = Temp::new();
    let store = Store::new(temp.0.clone()).unwrap();
    let source = parse_json(r#"{"text":"message","files":[{"data":"bGVnYWN5IGR1cmFibGUgYnl0ZXM=","mime":"application/pdf","source":{"type":"inline"},"name":"legacy.pdf","description":"Fixture","mention":{"start":0,"end":1,"text":"x"}}]}"#).unwrap();
    let migrated = migrate_record(&source, &store).unwrap();
    let text = stringify_json(&migrated);
    assert!(!text.contains("bGVnYWN5IGR1cmFibGUgYnl0ZXM="));
    assert!(!text.contains("\"source\""));
    assert!(text.contains("\"type\":\"managed\""));
    assert!(text.contains("\"name\":\"legacy.pdf\""));
    assert!(text.contains("\"description\":\"Fixture\""));
    assert!(text.contains("\"mention\":{\"start\":0,\"end\":1,\"text\":\"x\"}"));
    assert_eq!(migrate_record(&migrated, &store).unwrap(), migrated);
    for source in [
        r#"{"files":"invalid"}"#,
        r#"{"files":[{"data":"not-base64","mime":"x"}]}"#,
        r#"{"files":[{"data":"Zh==","mime":"x"}]}"#,
        r#"{"files":[{"data":"Zm9=","mime":"x"}]}"#,
        r#"{"files":[{"data":"Zg","mime":"x"}]}"#,
        r#"{"files":[{"data":"Zg=="}]}"#,
    ] {
        assert!(matches!(
            migrate_record(&parse_json(source).unwrap(), &store),
            Err(Error::Migration)
        ));
    }
}

#[tokio::test]
async fn migration_updates_real_event_pending_message_rows_and_records_completion_last() {
    use std::ops::Bound;
    use ycoding_core::resources::attachment_store::migration::{NAME, migrate};
    use ycoding_schema::parse_json;
    use ycoding_store::{
        Catalog, Metadata, Options, TableDeclaration, TableSpec, analytics, project, resources,
        session,
    };
    let temp = Temp::new();
    let store = Store::new(temp.0.clone()).unwrap();
    let catalog = Catalog::new(
        1,
        Box::leak(
            project::TABLES
                .iter()
                .chain(session::TABLES)
                .chain(resources::TABLES)
                .chain(ycoding_store::artifacts::TABLES)
                .chain(
                    [
                        TableDeclaration::of::<analytics::DeliveryTable>(),
                        TableDeclaration::of::<analytics::IntentTable>(),
                    ]
                    .iter(),
                )
                .copied()
                .collect::<Vec<_>>()
                .into_boxed_slice(),
        ),
    );
    let db = ycoding_store::Store::disposable(Options::core(), catalog, Metadata::new([41; 16], 1))
        .unwrap();
    db.client().submit(|tx| {
        project::ProjectTable::put(tx, &project::Project { id: "p".into(), worktree: "".into(), vcs: None, name: None, icon_url: None, icon_url_override: None, icon_color: None, time_created: 0, time_updated: 0, time_initialized: None, sandboxes: vec![], commands: None })?;
        session::SessionTable::put(tx, &session::Session {
            id: "ses_attachment".into(), project_id: "p".into(), workspace_id: None, parent_id: None, fork_session_id: None, fork_message_id: None, fork_seq: None, directory: "".into(), path: None, title: "Attachment fixture".into(), cost: 0.0, tokens_input: 0, tokens_output: 0, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0, revert: None, permission: None, autonomy: None, autonomy_revision: 0, orchestration_revision: 0, agent: None, model: None, profile_binding: None, daybreak: None, time_created: 0, time_updated: 0, time_archived: None, time_active: None, time_pinned: None, time_suspended: None, usage_pruned_through: None,
        })?;
        session::SequenceTable::put(tx, &session::Sequence { aggregate_id: "ses_attachment".into(), seq: 3, owner_id: None })?;
        session::EventTable::put(tx, &session::Event { id: "evt_attachment".into(), aggregate_id: "ses_attachment".into(), seq: 0, created: 0, type_: "session.input.admitted.1".into(), data: parse_json(r#"{"inputID":"msg_attachment_event","sessionID":"ses_attachment","input":{"type":"user","data":{"text":"event","files":[{"data":"bGVnYWN5IGR1cmFibGUgYnl0ZXM=","mime":"application/pdf","name":"legacy.pdf"}]},"delivery":"steer"}}"#).unwrap() })?;
        session::EventTable::put(tx, &session::Event { id: "evt_nonuser".into(), aggregate_id: "ses_attachment".into(), seq: 3, created: 0, type_: "session.input.admitted.1".into(), data: ycoding_schema::JsonValue::String(r#"{"input":{"type":"command","data":{"name":"fixture"}}}"#.into()) })?;
        session::PendingTable::put(tx, &session::Pending { id: "msg_attachment_pending".into(), session_id: "ses_attachment".into(), type_: "user".into(), data: parse_json(r#"{"text":"pending","files":[{"data":"bGVnYWN5IGR1cmFibGUgYnl0ZXM=","mime":"application/pdf","name":"legacy.pdf"}]}"#).unwrap(), delivery: Some("steer".into()), admitted_seq: 1, time_created: 0 })?;
        session::MessageTable::put(tx, &session::Message { id: "msg_attachment_message".into(), session_id: "ses_attachment".into(), type_: "user".into(), seq: 2, time_created: 0, time_updated: 0, data: parse_json(r#"{"text":"message","files":[{"data":"bGVnYWN5IGR1cmFibGUgYnl0ZXM=","mime":"application/pdf","name":"legacy.pdf"}],"time":{"created":0}}"#).unwrap() })?;
        Ok(())
    }).unwrap().await.unwrap();
    migrate(&db.client(), &store, 7).await.unwrap();
    migrate(&db.client(), &store, 8).await.unwrap();
    let snapshot = db.client().snapshot().unwrap();
    let events = snapshot
        .scan::<session::EventTable>(Bound::Unbounded, Bound::Unbounded, 10)
        .unwrap();
    let pending = snapshot
        .scan::<session::PendingTable>(Bound::Unbounded, Bound::Unbounded, 10)
        .unwrap();
    assert_eq!(
        events[1].data,
        parse_json(r#"{"input":{"type":"command","data":{"name":"fixture"}}}"#).unwrap()
    );
    let messages = snapshot
        .scan::<session::MessageTable>(Bound::Unbounded, Bound::Unbounded, 10)
        .unwrap();
    for data in [&events[0].data, &pending[0].data, &messages[0].data] {
        let text = ycoding_schema::stringify_json(data);
        assert!(text.contains("\"type\":\"managed\""));
        assert!(!text.contains("bGVnYWN5IGR1cmFibGUgYnl0ZXM="));
    }
    let markers = snapshot
        .scan::<resources::MigrationTable>(Bound::Unbounded, Bound::Unbounded, 10)
        .unwrap();
    assert_eq!(markers.len(), 1);
    assert_eq!(markers[0].name.as_str(), Some(NAME));
    assert_eq!(markers[0].time_completed, 7);
    drop(snapshot);
    db.client()
        .submit(move |tx| {
            tx.delete::<resources::MigrationTable>(&resources::MigrationTable::primary_key(
                &markers[0],
            ))?;
            let mut bad = pending[0].clone();
            bad.data = parse_json(r#"{"files":[{"data":"not-base64","mime":"x"}]}"#).unwrap();
            session::PendingTable::put(tx, &bad)?;
            Ok(())
        })
        .unwrap()
        .await
        .unwrap();
    assert!(matches!(
        migrate(&db.client(), &store, 9).await,
        Err(Error::Migration)
    ));
    let snapshot = db.client().snapshot().unwrap();
    assert!(
        snapshot
            .scan::<resources::MigrationTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap()
            .is_empty()
    );
    assert!(
        ycoding_schema::stringify_json(
            &snapshot
                .scan::<session::PendingTable>(Bound::Unbounded, Bound::Unbounded, 10)
                .unwrap()[0]
                .data
        )
        .contains("not-base64")
    );
    drop(snapshot);
    db.shutdown().unwrap();
}
