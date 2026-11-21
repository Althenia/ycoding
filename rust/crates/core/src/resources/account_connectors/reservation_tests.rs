use super::{producer_tests::Fixture, *};
use crate::cca::{
    library::LibraryFactory,
    value::{Value, parse_json, stringify_json},
};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

#[tokio::test]
async fn prepare_transfers_and_finalize_reuses_only_the_exact_completed_receipt() {
    let f = Fixture::new().await;
    let process = f.open("one").await;
    assert_eq!(
        process
            .tools()
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        [
            "ycoding_library.prepare_uploads",
            "ycoding_library.finalize_uploads"
        ]
    );
    let echo = process
        .call("ycoding_library.prepare_uploads", f.prepare())
        .await
        .unwrap();
    assert_eq!(f.routes(), ["POST /backend-api/files", "PUT /content"]);
    let encoded = stringify_json(&echo);
    assert!(!encoded.contains("synthetic-access"));
    assert!(!encoded.contains("sig="));
    assert!(!encoded.contains("attachments/sha256"));
    assert_eq!(f.releases.load(Ordering::Acquire), 0);
    assert_eq!(
        process
            .call("ycoding_library.prepare_uploads", f.prepare())
            .await
            .unwrap(),
        echo
    );
    let reply = process
        .call("ycoding_library.finalize_uploads", echo.clone())
        .await
        .unwrap();
    assert_eq!(reply, parse_json(r#"{"results":[{"operation":"create_library_file","status":"succeeded","file_id":"file-one","library_file_id":"library-one","file_name":"report.txt"}]}"#).unwrap());
    assert_eq!(
        process
            .call("ycoding_library.finalize_uploads", echo)
            .await
            .unwrap(),
        reply
    );
    assert_eq!(f.routes().len(), 3);
    assert_eq!(f.releases.load(Ordering::Acquire), 1);
    process.close().await.unwrap();
    process.close().await.unwrap();
    assert_eq!(f.releases.load(Ordering::Acquire), 1);
    f.finish().await;
}

#[tokio::test]
async fn unsupported_prepare_fields_batch_size_paths_and_source_size_dispatch_nothing() {
    let f = Fixture::new().await;
    let process = f.open("one").await;
    let Value::Object(mut base) = f.item() else {
        panic!()
    };
    for (key, value) in [
        ("purpose", Value::String("replace_library_file".into())),
        ("directory_id", Value::String("dir".into())),
        ("is_shared", Value::Bool(true)),
        ("library_artifact_type", Value::String("report".into())),
        ("expected_current_version", Value::Number(1.0)),
        ("file_size_bytes", Value::Number(0.0)),
        (
            "file_size_bytes",
            Value::Number((attachment_store::MAX_BYTES + 1) as f64),
        ),
        ("file_size_bytes", Value::Number(1.5)),
        ("file_size_bytes", Value::Number(1.0)),
        (
            "workspace_path",
            Value::String("relative/report.txt".into()),
        ),
        ("file_name", Value::String("other.txt".into())),
        ("mime_type", Value::String("text/plain\r\nsecret".into())),
    ] {
        let mut changed = base.clone();
        changed.insert(key.into(), value);
        assert!(
            process
                .call(
                    "ycoding_library.prepare_uploads",
                    object([("uploads", Value::Array(vec![Value::Object(changed)]))])
                )
                .await
                .is_err()
        );
    }
    for items in [
        vec![],
        vec![Value::Object(base.clone()), Value::Object(base.clone())],
    ] {
        assert!(
            process
                .call(
                    "ycoding_library.prepare_uploads",
                    object([("uploads", Value::Array(items))])
                )
                .await
                .is_err()
        );
    }
    base.insert(
        "file_name".into(),
        Value::String(ycoding_schema::LosslessString::from_utf16(vec![0xd800])),
    );
    assert!(
        process
            .call(
                "ycoding_library.prepare_uploads",
                object([("uploads", Value::Array(vec![Value::Object(base)]))])
            )
            .await
            .is_err()
    );
    assert!(process.call("unadvertised", f.prepare()).await.is_err());
    assert!(f.routes().is_empty());
    process.close().await.unwrap();
    f.finish().await;
}

#[tokio::test]
async fn reservations_are_private_even_for_duplicate_process_labels() {
    let f = Fixture::new().await;
    let first = f.open("same").await;
    let second = f.open("same").await;
    let echo = first
        .call("ycoding_library.prepare_uploads", f.prepare())
        .await
        .unwrap();
    assert!(
        second
            .call("ycoding_library.finalize_uploads", echo.clone())
            .await
            .is_err()
    );
    assert_eq!(f.routes().len(), 2);
    first
        .call("ycoding_library.finalize_uploads", echo)
        .await
        .unwrap();
    first.close().await.unwrap();
    second.close().await.unwrap();
    f.finish().await;
}

#[tokio::test]
async fn every_changed_echo_field_and_unsupported_finalization_consume_the_owned_reservation() {
    for (field, value) in [
        ("file_id", Value::String("file-other".into())),
        (
            "workspace_path",
            Value::String("/changed/report.txt".into()),
        ),
        ("file_name", Value::String("changed.txt".into())),
        ("mime_type", Value::String("image/png".into())),
        ("file_size_bytes", Value::Number(1.0)),
        ("purpose", Value::String("replace_library_file".into())),
        ("store_in_library", Value::Bool(false)),
        ("directory_id", Value::String("unsupported".into())),
    ] {
        let f = Fixture::new().await;
        let process = f.open("one").await;
        let echo = process
            .call("ycoding_library.prepare_uploads", f.prepare())
            .await
            .unwrap();
        let Value::Object(root) = &echo else { panic!() };
        let Some(Value::Array(uploads)) = root.get(&"uploads".into()) else {
            panic!()
        };
        let Value::Object(mut item) = uploads[0].clone() else {
            panic!()
        };
        item.insert(field.into(), value);
        let changed = object([("uploads", Value::Array(vec![Value::Object(item)]))]);
        assert!(
            process
                .call("ycoding_library.finalize_uploads", changed)
                .await
                .is_err()
        );
        assert!(
            process
                .call("ycoding_library.finalize_uploads", echo)
                .await
                .is_err()
        );
        assert_eq!(f.routes().len(), 2);
        assert_eq!(f.releases.load(Ordering::Acquire), 1);
        process.close().await.unwrap();
        f.finish().await;
    }
}

#[tokio::test]
async fn changed_source_or_managed_snapshot_never_dispatches_finalization() {
    for managed in [false, true] {
        let f = Fixture::new().await;
        let process = f.open("one").await;
        let echo = process
            .call("ycoding_library.prepare_uploads", f.prepare())
            .await
            .unwrap();
        if managed {
            let content = f.attachments.import(b"synthetic report\n").unwrap();
            let path = f.attachments.absolute_path(&content).unwrap();
            let mut permissions = std::fs::metadata(&path).unwrap().permissions();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                permissions.set_mode(permissions.mode() | 0o200);
            }
            #[cfg(not(unix))]
            permissions.set_readonly(false);
            std::fs::set_permissions(&path, permissions).unwrap();
            std::fs::write(path, b"changed snapshot\n").unwrap();
        } else {
            *f.source.lock().unwrap() = b"changed source!!\n".to_vec();
        }
        assert!(
            process
                .call("ycoding_library.finalize_uploads", echo.clone())
                .await
                .is_err()
        );
        assert!(
            process
                .call("ycoding_library.finalize_uploads", echo)
                .await
                .is_err()
        );
        assert_eq!(f.routes().len(), 2);
        assert_eq!(f.releases.load(Ordering::Acquire), 1);
        process.close().await.unwrap();
        f.finish().await;
    }
}

#[tokio::test]
async fn denied_reads_and_upload_authorization_have_no_transport_fallback() {
    let f = Fixture::new().await;
    f.denied.store(true, Ordering::Release);
    let process = f.open("denied").await;
    assert!(matches!(
        process
            .call("ycoding_library.prepare_uploads", f.prepare())
            .await,
        Err(crate::cca::library::LibraryCallError::Denied(_))
    ));
    assert!(f.routes().is_empty());
    process.close().await.unwrap();
    f.denied.store(false, Ordering::Release);
    let reads = Arc::new(AtomicUsize::new(0));
    let counted = reads.clone();
    let process = f
        .factory
        .open(crate::cca::library::LibraryOpenInput {
            process_id: "reader-denied".into(),
            cwd: f.cwd(),
            read_file: Arc::new(move |_| {
                counted.fetch_add(1, Ordering::AcqRel);
                Box::pin(async { Err(crate::cca::error::ExecutorError::permission_denied()) })
            }),
        })
        .await
        .unwrap();
    assert!(
        process
            .call("ycoding_library.prepare_uploads", f.prepare())
            .await
            .is_err()
    );
    assert_eq!(reads.load(Ordering::Acquire), 1);
    assert!(f.routes().is_empty());
    process.close().await.unwrap();
    f.finish().await;
}

#[tokio::test]
async fn known_initial_403_releases_and_remains_retryable_without_refreshing_or_replaying_it() {
    let f = Fixture::new().await;
    f.status.store(403, Ordering::Release);
    let process = f.open("one").await;
    assert!(
        process
            .call("ycoding_library.prepare_uploads", f.prepare())
            .await
            .is_err()
    );
    assert_eq!(f.routes().len(), 1);
    assert_eq!(f.releases.load(Ordering::Acquire), 1);
    f.status.store(200, Ordering::Release);
    process
        .call("ycoding_library.prepare_uploads", f.prepare())
        .await
        .unwrap();
    assert_eq!(f.routes().len(), 3);
    process.close().await.unwrap();
    assert_eq!(f.releases.load(Ordering::Acquire), 2);
    f.finish().await;
}

#[tokio::test]
async fn dispatched_transfer_failure_and_incomplete_receipt_are_never_replayed() {
    for phase in [
        "transfer",
        "completion",
        "oversize",
        "redirect",
        "headers",
        "destination",
    ] {
        let f = Fixture::new().await;
        *f.failure.lock().unwrap() = phase.into();
        let process = f.open("one").await;
        let result = process
            .call("ycoding_library.prepare_uploads", f.prepare())
            .await;
        if phase == "completion" {
            let echo = result.unwrap();
            assert!(
                process
                    .call("ycoding_library.finalize_uploads", echo.clone())
                    .await
                    .is_err()
            );
            let count = f.routes().len();
            assert!(
                process
                    .call("ycoding_library.finalize_uploads", echo)
                    .await
                    .is_err()
            );
            assert_eq!(count, f.routes().len());
        } else {
            assert!(result.is_err());
        }
        let count = f.routes().len();
        assert!(
            process
                .call("ycoding_library.prepare_uploads", f.prepare())
                .await
                .is_err()
        );
        assert_eq!(count, f.routes().len());
        assert_eq!(f.releases.load(Ordering::Acquire), 1);
        process.close().await.unwrap();
        f.finish().await;
    }
}

#[tokio::test]
async fn closing_or_aborting_inflight_transfer_drains_and_releases_once() {
    for abort in [false, true] {
        let f = Fixture::new().await;
        *f.failure.lock().unwrap() = "blocked".into();
        let process = f.open("one").await;
        let called = process.clone();
        let arguments = f.prepare();
        let attempt = tokio::spawn(async move {
            called
                .call("ycoding_library.prepare_uploads", arguments)
                .await
        });
        f.entered.notified().await;
        assert!(
            process
                .call("ycoding_library.prepare_uploads", f.prepare())
                .await
                .is_err()
        );
        if abort {
            attempt.abort();
            assert!(attempt.await.unwrap_err().is_cancelled());
            process.close().await.unwrap();
        } else {
            process.close().await.unwrap();
            assert!(attempt.await.unwrap().is_err());
        }
        assert_eq!(f.routes().len(), 2);
        assert_eq!(f.releases.load(Ordering::Acquire), 1);
        process.close().await.unwrap();
        f.finish().await;
    }
}

#[tokio::test]
async fn expired_idle_reservations_release_without_a_later_tool_call() {
    let f = Fixture::new().await;
    let process = f
        .factory
        .open_with_lifetime(f.owner("one"), std::time::Duration::ZERO)
        .await
        .unwrap();
    assert!(
        process
            .call("ycoding_library.prepare_uploads", f.prepare())
            .await
            .is_err()
    );
    process.close().await.unwrap();
    assert!(f.routes().is_empty());
    f.finish().await;
}

#[tokio::test]
async fn scheduled_idle_expiry_releases_the_held_grant_without_a_later_call() {
    let f = Fixture::new().await;
    let process = f
        .factory
        .open_with_lifetime(f.owner("idle"), std::time::Duration::from_secs(5))
        .await
        .unwrap();
    process
        .call("ycoding_library.prepare_uploads", f.prepare())
        .await
        .unwrap();
    assert_eq!(f.releases.load(Ordering::Acquire), 0);
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        f.release_entered.notified(),
    )
    .await
    .unwrap();
    process.close().await.unwrap();
    assert_eq!(f.releases.load(Ordering::Acquire), 1);
    assert_eq!(f.routes().len(), 2);
    assert!(process.check().await.is_err());
    f.finish().await;
}

#[tokio::test]
async fn dropped_close_waiter_can_repoll_the_same_owned_authorization_drain() {
    let f = Fixture::new().await;
    let (release, gate) = tokio::sync::oneshot::channel();
    *f.authorization_gate.lock().unwrap() = Some(gate);
    let process = f.open("one").await;
    let called = process.clone();
    let input = f.prepare();
    let attempt =
        tokio::spawn(async move { called.call("ycoding_library.prepare_uploads", input).await });
    f.authorization_entered.notified().await;
    let (started, cancelled) = tokio::sync::oneshot::channel();
    let closing = process.clone();
    let waiter = tokio::spawn(async move {
        let outcome = closing.close();
        started.send(()).unwrap();
        outcome.await
    });
    cancelled.await.unwrap();
    assert!(!waiter.is_finished());
    waiter.abort();
    assert!(waiter.await.unwrap_err().is_cancelled());
    assert_eq!(f.releases.load(Ordering::Acquire), 0);
    assert!(f.routes().is_empty());
    release.send(()).unwrap();
    assert!(attempt.await.unwrap().is_err());
    process.close().await.unwrap();
    process.close().await.unwrap();
    assert_eq!(f.releases.load(Ordering::Acquire), 1);
    assert!(f.routes().is_empty());
    f.finish().await;
}

#[tokio::test]
async fn authorization_cleanup_failure_is_retained_by_repeated_close() {
    let f = Fixture::new().await;
    let process = f.open("one").await;
    process
        .call("ycoding_library.prepare_uploads", f.prepare())
        .await
        .unwrap();
    f.release_failure.store(true, Ordering::Release);
    let first = process.close().await;
    assert!(first.is_err());
    assert_eq!(process.close().await, first);
    assert_eq!(f.releases.load(Ordering::Acquire), 1);
    f.finish().await;
}

#[tokio::test]
async fn exact_twenty_mib_source_is_transferred_without_expanding_the_limit() {
    let f = Fixture::new().await;
    *f.source.lock().unwrap() = vec![b'x'; attachment_store::MAX_BYTES];
    let process = f.open("maximum").await;
    let Value::Object(mut item) = f.item() else {
        panic!()
    };
    item.insert(
        "file_size_bytes".into(),
        Value::Number(attachment_store::MAX_BYTES as f64),
    );
    let input = object([("uploads", Value::Array(vec![Value::Object(item)]))]);
    process
        .call("ycoding_library.prepare_uploads", input)
        .await
        .unwrap();
    assert_eq!(f.routes().len(), 2);
    process.close().await.unwrap();
    assert_eq!(f.releases.load(Ordering::Acquire), 1);
    f.finish().await;
}
