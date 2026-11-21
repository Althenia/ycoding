use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use ycoding_core::resources::project_artifact::filesystem::Hooks;
use ycoding_core::resources::project_artifact::package;
use ycoding_schema::{DomainDecode, DomainEncode, JsonValue, parse_json, project_artifact};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "ycoding-artifact-package-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        std::fs::write(package::scope_marker_path(&path), r#"{"schema":1,"scopeID":"pas_scope","type":"project","storageID":"11111111-1111-4111-8111-111111111111"}"#).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
fn input<'a>(
    root: &'a Path,
    marker: &'a package::Marker,
    content: &'a ycoding_schema::LosslessString,
) -> package::CommitInput<'a> {
    package::CommitInput {
        root,
        marker,
        content,
        expected_version_id: None,
        operation_id: None,
        standard: None,
        no_overwrite: false,
    }
}
fn next(previous: &package::Marker, version: &str, content: &str) -> package::Marker {
    let mut marker = previous.clone();
    marker.version_id =
        project_artifact::VersionId::decode(&JsonValue::String(version.into())).unwrap();
    marker.content_digest = package::sha256(&content.into());
    marker
}

fn marker(kind: &str, content: &str) -> package::Marker {
    package::marker(package::MarkerInput {
        scope_id: project_artifact::ScopeId::decode(&JsonValue::String("pas_scope".into()))
            .unwrap(),
        storage_id: project_artifact::StorageId::decode(&JsonValue::String(
            "11111111-1111-4111-8111-111111111111".into(),
        ))
        .unwrap(),
        kind: project_artifact::Kind::decode(&JsonValue::String(kind.into())).unwrap(),
        id: project_artifact::Id::decode(&JsonValue::String("review".into())).unwrap(),
        version_id: project_artifact::VersionId::decode(&JsonValue::String("pav_first".into()))
            .unwrap(),
        content: content.into(),
    })
}

#[test]
fn marker_uses_literal_sha256_and_exact_schema_field_order() {
    let marker = marker("skill", "first");
    assert_eq!(
        marker.content_digest.as_lossless().as_str(),
        Some("a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e")
    );
    assert_eq!(
        ycoding_schema::stringify_json(&marker.encode()),
        r#"{"schema":1,"scopeID":"pas_scope","storageID":"11111111-1111-4111-8111-111111111111","kind":"skill","id":"review","versionID":"pav_first","contentDigest":"a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e","contentRelpath":"SKILL.md"}"#
    );
    assert_eq!(package::Marker::decode(&marker.encode()).unwrap(), marker);
}

#[test]
fn computes_exact_paths_for_each_supported_kind() {
    for (kind, content, relative) in [
        ("skill", "/scope/active/skills/review/SKILL.md", "SKILL.md"),
        ("command", "/scope/active/commands/review.md", "review.md"),
        ("agent", "/scope/active/agents/review.md", "review.md"),
        ("plugin", "/scope/active/plugins/review.ts", "review.ts"),
    ] {
        let marker = marker(kind, "first");
        assert_eq!(
            package::active_content_path(Path::new("/scope"), &marker.kind, &marker.id),
            Path::new(content)
        );
        assert_eq!(
            marker.content_relpath.as_lossless().as_str(),
            Some(relative)
        );
        assert_eq!(
            package::version_root(Path::new("/scope"), &marker),
            Path::new(&format!("/scope/versions/{kind}/review/pav_first"))
        );
        assert_eq!(
            package::version_content_path(Path::new("/scope"), &marker),
            Path::new(&format!(
                "/scope/versions/{kind}/review/pav_first/{relative}"
            ))
        );
        assert_eq!(
            package::version_marker_path(Path::new("/scope"), &marker),
            Path::new(&format!(
                "/scope/versions/{kind}/review/pav_first/.ycoding-project-artifact.json"
            ))
        );
        assert_eq!(
            package::active_marker_path(Path::new("/scope"), &marker.kind, &marker.id),
            Path::new(&format!("/scope/metadata/{kind}/review.json"))
        );
    }
    assert_eq!(
        package::scope_marker_path(Path::new("/scope")),
        Path::new("/scope/.ycoding-scope.json")
    );
}

#[test]
fn marker_rejects_wrong_schema_digest_and_traversal() {
    let valid = marker("skill", "first").encode();
    for (field, value) in [
        ("schema", JsonValue::Number(2.0)),
        ("contentDigest", JsonValue::String("bad".into())),
        ("contentRelpath", JsonValue::String("../outside".into())),
        ("id", JsonValue::String("../outside".into())),
    ] {
        let JsonValue::Object(mut object) = valid.clone() else {
            panic!()
        };
        object.insert(field.into(), value);
        assert!(package::Marker::decode(&JsonValue::Object(object)).is_err());
    }
    assert!(package::Marker::decode(&parse_json("{}").unwrap()).is_err());
}

#[test]
fn atomically_updates_and_preserves_historical_owned_bytes() {
    let tmp = Temp::new();
    let first = marker("skill", "first");
    package::commit(input(&tmp.0, &first, &"first".into()), &Hooks::default()).unwrap();
    let second = next(&first, "pav_second", "second");
    package::commit(
        package::CommitInput {
            expected_version_id: Some(&first.version_id),
            ..input(&tmp.0, &second, &"second".into())
        },
        &Hooks::default(),
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(package::active_content_path(&tmp.0, &first.kind, &first.id))
            .unwrap(),
        "second"
    );
    assert_eq!(
        std::fs::read_to_string(package::version_content_path(&tmp.0, &first)).unwrap(),
        "first"
    );
    assert_eq!(
        package::read_active(&tmp.0, &first.kind, &first.id, &Hooks::default())
            .unwrap()
            .unwrap(),
        second
    );
    assert!(
        package::read_commit_transactions(&tmp.0, &Hooks::default())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn rejects_mismatching_digest_scope_and_expected_version_before_activation() {
    let tmp = Temp::new();
    let first = marker("command", "first");
    assert_eq!(
        package::commit(
            input(&tmp.0, &first, &"different".into()),
            &Hooks::default()
        )
        .unwrap_err()
        .code
        .encode(),
        JsonValue::String("InvalidArtifact".into())
    );
    let mut copied = first.clone();
    copied.scope_id =
        project_artifact::ScopeId::decode(&JsonValue::String("pas_foreign".into())).unwrap();
    assert_eq!(
        package::commit(input(&tmp.0, &copied, &"first".into()), &Hooks::default())
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("OwnershipMismatch".into())
    );
    assert_eq!(
        package::commit(
            package::CommitInput {
                expected_version_id: Some(&first.version_id),
                ..input(&tmp.0, &first, &"first".into())
            },
            &Hooks::default()
        )
        .unwrap_err()
        .code
        .encode(),
        JsonValue::String("VersionConflict".into())
    );
    package::commit(input(&tmp.0, &first, &"first".into()), &Hooks::default()).unwrap();
    let second = next(&first, "pav_second", "second");
    assert_eq!(
        package::commit(input(&tmp.0, &second, &"second".into()), &Hooks::default())
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("ArtifactCollision".into())
    );
}

#[test]
fn compensates_every_update_rename_boundary() {
    for boundary in 1..=4 {
        let tmp = Temp::new();
        let first = marker("command", "first");
        package::commit(input(&tmp.0, &first, &"first".into()), &Hooks::default()).unwrap();
        let second = next(&first, "pav_second", "second");
        let renames = std::cell::Cell::new(0);
        let before =
            |mutation: &ycoding_core::resources::project_artifact::filesystem::Mutation<'_>| {
                if mutation.operation == "rename"
                    && mutation.source.is_some_and(|p| {
                        !p.file_name().unwrap().to_string_lossy().ends_with(".tmp")
                    })
                {
                    renames.set(renames.get() + 1);
                    if renames.get() == boundary {
                        return Err(std::io::Error::other("boundary failure"));
                    }
                }
                Ok(())
            };
        assert!(
            package::commit(
                package::CommitInput {
                    expected_version_id: Some(&first.version_id),
                    ..input(&tmp.0, &second, &"second".into())
                },
                &Hooks {
                    before_mutation: Some(&before),
                    ..Hooks::default()
                }
            )
            .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(package::active_content_path(&tmp.0, &first.kind, &first.id))
                .unwrap(),
            "first"
        );
        assert_eq!(
            package::read_active(&tmp.0, &first.kind, &first.id, &Hooks::default())
                .unwrap()
                .unwrap(),
            first
        );
    }
}

#[test]
fn preserves_hook_errors_compensates_failed_finalization_and_reports_phases() {
    let tmp = Temp::new();
    let first = marker("command", "first");
    package::commit(input(&tmp.0, &first, &"first".into()), &Hooks::default()).unwrap();
    let second = next(&first, "pav_second", "second");
    let reserve = |metadata: &package::CommitTransactionMetadata| {
        assert_eq!(metadata.phase, package::CommitPhase::Prepared);
        Ok(())
    };
    let finalize = |metadata: &package::CommitTransactionMetadata| {
        assert_eq!(metadata.phase, package::CommitPhase::Available);
        Err("db-finalization")
    };
    let aborted = std::cell::Cell::new(false);
    let abort = |metadata: &package::CommitTransactionMetadata| {
        assert_eq!(metadata.phase, package::CommitPhase::Compensated);
        aborted.set(true);
        Ok(())
    };
    assert!(matches!(
        package::commit_transaction(
            package::CommitInput {
                expected_version_id: Some(&first.version_id),
                operation_id: Some("pop_failed"),
                ..input(&tmp.0, &second, &"second".into())
            },
            &Hooks::default(),
            &package::TransactionHooks {
                reserve: Some(&reserve),
                finalize: Some(&finalize),
                abort: Some(&abort),
                cancellation: None,
                can_compensate: None,
            }
        ),
        Err(package::TransactionError::Hook("db-finalization"))
    ));
    assert!(aborted.get());
    assert_eq!(
        std::fs::read_to_string(package::active_content_path(&tmp.0, &first.kind, &first.id))
            .unwrap(),
        "first"
    );
    assert!(!tmp.0.join("staging/pop_failed").exists());
}

#[test]
fn keeps_finalized_bytes_when_journal_cleanup_fails_and_allows_exact_retry() {
    let tmp = Temp::new();
    let first = marker("command", "first");
    let finalized = std::cell::Cell::new(false);
    let finalize = |_: &package::CommitTransactionMetadata| {
        finalized.set(true);
        Ok::<_, &str>(())
    };
    let before =
        |mutation: &ycoding_core::resources::project_artifact::filesystem::Mutation<'_>| {
            if finalized.get() && mutation.operation == "write" {
                return Err(std::io::Error::other("cleanup failure"));
            }
            Ok(())
        };
    let metadata = package::commit_transaction(
        package::CommitInput {
            operation_id: Some("pop_cleanup"),
            ..input(&tmp.0, &first, &"first".into())
        },
        &Hooks {
            before_mutation: Some(&before),
            ..Hooks::default()
        },
        &package::TransactionHooks {
            reserve: None,
            finalize: Some(&finalize),
            abort: None,
            cancellation: None,
            can_compensate: None,
        },
    )
    .unwrap();
    assert_eq!(metadata.phase, package::CommitPhase::Finalizing);
    assert_eq!(
        std::fs::read_to_string(package::active_content_path(&tmp.0, &first.kind, &first.id))
            .unwrap(),
        "first"
    );
    package::commit(
        package::CommitInput {
            operation_id: Some("pop_cleanup"),
            ..input(&tmp.0, &first, &"first".into())
        },
        &Hooks::default(),
    )
    .unwrap();
    assert!(
        package::read_commit_transactions(&tmp.0, &Hooks::default())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn concurrent_same_base_updates_leave_exactly_one_complete_version() {
    let tmp = Temp::new();
    let first = marker("command", "first");
    package::commit(input(&tmp.0, &first, &"first".into()), &Hooks::default()).unwrap();
    let barrier = std::sync::Barrier::new(2);
    let results = std::thread::scope(|scope| {
        let workers = ["one", "two"].map(|content| {
            let root = &tmp.0;
            let first = &first;
            let barrier = &barrier;
            scope.spawn(move || {
                let next = next(first, &format!("pav_{content}"), content);
                barrier.wait();
                package::commit(
                    package::CommitInput {
                        expected_version_id: Some(&first.version_id),
                        ..input(root, &next, &content.into())
                    },
                    &Hooks::default(),
                )
                .is_ok()
            })
        });
        workers.map(|worker| worker.join().unwrap())
    });
    assert_eq!(results.into_iter().filter(|result| *result).count(), 1);
    assert_eq!(
        std::fs::read_to_string(package::version_content_path(&tmp.0, &first)).unwrap(),
        "first"
    );
}

#[test]
fn standard_targets_refuse_unowned_overwrite_and_invalid_layouts() {
    let tmp = Temp::new();
    let target = tmp.0.join("commands");
    std::fs::create_dir(&target).unwrap();
    let content = target.join("review.md");
    let marker_path = target.join(".review.ycoding-project-artifact.json");
    std::fs::write(&content, "user-owned").unwrap();
    let first = marker("command", "first");
    assert_eq!(
        package::commit(
            package::CommitInput {
                standard: Some(package::StandardTarget {
                    content_path: &content,
                    marker_path: &marker_path
                }),
                no_overwrite: true,
                ..input(&tmp.0, &first, &"first".into())
            },
            &Hooks::default()
        )
        .unwrap_err()
        .code
        .encode(),
        JsonValue::String("DestinationExists".into())
    );
    assert_eq!(std::fs::read_to_string(content).unwrap(), "user-owned");
    assert_eq!(
        package::commit(
            package::CommitInput {
                standard: Some(package::StandardTarget {
                    content_path: &target.join("wrong.md"),
                    marker_path: &marker_path
                }),
                ..input(&tmp.0, &first, &"first".into())
            },
            &Hooks::default()
        )
        .unwrap_err()
        .code
        .encode(),
        JsonValue::String("OwnershipMismatch".into())
    );
}

fn state<'a>(
    root: &'a Path,
    current: &'a package::Marker,
    operation: package::StateOperation,
    operation_id: &'a str,
) -> package::StateMutationInput<'a> {
    package::StateMutationInput {
        root,
        current,
        operation,
        operation_id,
        target: None,
        standard: None,
        context: None,
    }
}
fn trash<'a>(
    root: &'a Path,
    marker: &'a package::Marker,
    deletion_id: &'a project_artifact::DeletionId,
) -> package::TrashInput<'a> {
    package::TrashInput {
        root,
        marker,
        deletion_id,
        prior_stage: None,
        deleted_at: Some(1000),
        now: None,
        standard: None,
    }
}

#[test]
fn disables_enables_rolls_back_and_preserves_all_three_owned_layouts() {
    let tmp = Temp::new();
    let first = marker("skill", "first");
    let second = next(&first, "pav_second", "second");
    package::commit(input(&tmp.0, &first, &"first".into()), &Hooks::default()).unwrap();
    package::state_mutation(
        state(
            &tmp.0,
            &first,
            package::StateOperation::Disable,
            "pop_disable",
        ),
        &Hooks::default(),
    )
    .unwrap();
    assert!(!package::active_content_path(&tmp.0, &first.kind, &first.id).exists());
    package::state_mutation(
        state(
            &tmp.0,
            &first,
            package::StateOperation::Enable,
            "pop_enable",
        ),
        &Hooks::default(),
    )
    .unwrap();
    package::commit(
        package::CommitInput {
            expected_version_id: Some(&first.version_id),
            ..input(&tmp.0, &second, &"second".into())
        },
        &Hooks::default(),
    )
    .unwrap();
    package::state_mutation(
        package::StateMutationInput {
            target: Some(&first),
            ..state(
                &tmp.0,
                &second,
                package::StateOperation::Rollback,
                "pop_rollback",
            )
        },
        &Hooks::default(),
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(package::active_content_path(&tmp.0, &first.kind, &first.id))
            .unwrap(),
        "first"
    );
    assert_eq!(
        std::fs::read_to_string(package::disabled_content_path(&tmp.0, &second)).unwrap(),
        "second"
    );
    assert!(!package::version_root(&tmp.0, &first).exists());
}

#[test]
fn compensates_state_finalization_failure_without_losing_active_bytes() {
    let tmp = Temp::new();
    let first = marker("skill", "first");
    package::commit(input(&tmp.0, &first, &"first".into()), &Hooks::default()).unwrap();
    let finalize = |_: &package::StateMutationMetadata| Err("database rollback");
    let aborted = std::cell::Cell::new(false);
    let abort = |metadata: &package::StateMutationMetadata| {
        assert_eq!(metadata.phase, package::StatePhase::Compensated);
        aborted.set(true);
        Ok(())
    };
    assert!(matches!(
        package::state_transaction(
            state(
                &tmp.0,
                &first,
                package::StateOperation::Disable,
                "pop_state"
            ),
            &Hooks::default(),
            &package::TransactionHooks {
                reserve: None,
                finalize: Some(&finalize),
                abort: Some(&abort),
                cancellation: None,
                can_compensate: None,
            }
        ),
        Err(package::TransactionError::Hook("database rollback"))
    ));
    assert!(aborted.get());
    assert_eq!(
        std::fs::read_to_string(package::active_content_path(&tmp.0, &first.kind, &first.id))
            .unwrap(),
        "first"
    );
    assert!(
        package::read_state_transactions(&tmp.0, &Hooks::default())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn reconciles_and_exactly_retries_each_commit_and_state_rename_after_process_loss() {
    for boundary in 1..=4 {
        let tmp = Temp::new();
        let first = marker("command", "first");
        let second = next(&first, "pav_second", "second");
        package::commit(input(&tmp.0, &first, &"first".into()), &Hooks::default()).unwrap();
        let renames = std::cell::Cell::new(0);
        let after =
            |mutation: &ycoding_core::resources::project_artifact::filesystem::Mutation<'_>| {
                if mutation.operation == "rename"
                    && mutation.source.is_some_and(|p| {
                        !p.file_name().unwrap().to_string_lossy().ends_with(".tmp")
                    })
                {
                    renames.set(renames.get() + 1);
                    assert_ne!(renames.get(), boundary, "simulated process loss");
                }
                Ok(())
            };
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| package::commit(
                package::CommitInput {
                    operation_id: Some("pop_crash"),
                    expected_version_id: Some(&first.version_id),
                    ..input(&tmp.0, &second, &"second".into())
                },
                &Hooks {
                    after_mutation: Some(&after),
                    ..Hooks::default()
                }
            )))
            .is_err()
        );
        package::reconcile(&tmp.0, &Hooks::default()).unwrap();
        package::commit(
            package::CommitInput {
                operation_id: Some("pop_crash"),
                expected_version_id: Some(&first.version_id),
                ..input(&tmp.0, &second, &"second".into())
            },
            &Hooks::default(),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(package::active_content_path(&tmp.0, &first.kind, &first.id))
                .unwrap(),
            "second"
        );
    }
    for operation in [
        package::StateOperation::Disable,
        package::StateOperation::Enable,
        package::StateOperation::Rollback,
    ] {
        for boundary in 1..=if operation == package::StateOperation::Rollback {
            4
        } else {
            2
        } {
            let tmp = Temp::new();
            let first = marker("command", "first");
            let second = next(&first, "pav_second", "second");
            package::commit(input(&tmp.0, &first, &"first".into()), &Hooks::default()).unwrap();
            if operation == package::StateOperation::Enable {
                package::state_mutation(
                    state(
                        &tmp.0,
                        &first,
                        package::StateOperation::Disable,
                        "pop_disabled",
                    ),
                    &Hooks::default(),
                )
                .unwrap();
            }
            if operation == package::StateOperation::Rollback {
                package::commit(
                    package::CommitInput {
                        expected_version_id: Some(&first.version_id),
                        ..input(&tmp.0, &second, &"second".into())
                    },
                    &Hooks::default(),
                )
                .unwrap();
            }
            let current = if operation == package::StateOperation::Rollback {
                &second
            } else {
                &first
            };
            let input = package::StateMutationInput {
                target: (operation == package::StateOperation::Rollback).then_some(&first),
                ..state(&tmp.0, current, operation, "pop_crash")
            };
            let renames = std::cell::Cell::new(0);
            let after =
                |mutation: &ycoding_core::resources::project_artifact::filesystem::Mutation<'_>| {
                    if mutation.operation == "rename"
                        && mutation.source.is_some_and(|p| {
                            !p.file_name().unwrap().to_string_lossy().ends_with(".tmp")
                        })
                    {
                        renames.set(renames.get() + 1);
                        assert_ne!(renames.get(), boundary, "simulated process loss");
                    }
                    Ok(())
                };
            assert!(
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| package::state_mutation(
                    input,
                    &Hooks {
                        after_mutation: Some(&after),
                        ..Hooks::default()
                    }
                )))
                .is_err()
            );
            package::reconcile(&tmp.0, &Hooks::default()).unwrap();
            package::state_mutation(input, &Hooks::default()).unwrap();
            assert_eq!(
                package::active_content_path(&tmp.0, &first.kind, &first.id).exists(),
                operation != package::StateOperation::Disable
            );
        }
    }
}

#[test]
fn trashes_restores_and_purges_exact_multilayout_owned_manifest() {
    let tmp = Temp::new();
    let first = marker("command", "first");
    let second = next(&first, "pav_second", "second");
    let third = next(&first, "pav_third", "third");
    package::commit(input(&tmp.0, &first, &"first".into()), &Hooks::default()).unwrap();
    package::commit(
        package::CommitInput {
            expected_version_id: Some(&first.version_id),
            ..input(&tmp.0, &second, &"second".into())
        },
        &Hooks::default(),
    )
    .unwrap();
    package::state_mutation(
        package::StateMutationInput {
            target: Some(&first),
            ..state(
                &tmp.0,
                &second,
                package::StateOperation::Rollback,
                "pop_rollback",
            )
        },
        &Hooks::default(),
    )
    .unwrap();
    package::commit(
        package::CommitInput {
            expected_version_id: Some(&first.version_id),
            ..input(&tmp.0, &third, &"third".into())
        },
        &Hooks::default(),
    )
    .unwrap();
    let deletion =
        project_artifact::DeletionId::decode(&JsonValue::String("pad_delete".into())).unwrap();
    package::trash(trash(&tmp.0, &third, &deletion), &Hooks::default()).unwrap();
    let manifest = package::read_trash_manifest(&tmp.0, &deletion, &Hooks::default()).unwrap();
    assert_eq!(
        manifest
            .entries
            .iter()
            .map(|entry| (
                entry.layout,
                entry.version_id.as_lossless().as_str().unwrap()
            ))
            .collect::<Vec<_>>(),
        [
            (package::Layout::Active, "pav_third"),
            (package::Layout::Disabled, "pav_second"),
            (package::Layout::Version, "pav_first")
        ]
    );
    assert!(!package::active_content_path(&tmp.0, &third.kind, &third.id).exists());
    assert_eq!(
        package::purge(
            package::TrashInput {
                now: Some(1000),
                ..trash(&tmp.0, &third, &deletion)
            },
            &Hooks::default()
        )
        .unwrap_err()
        .code
        .encode(),
        JsonValue::String("TrashExpired".into())
    );
    package::restore(trash(&tmp.0, &third, &deletion), &Hooks::default()).unwrap();
    assert_eq!(
        std::fs::read_to_string(package::active_content_path(&tmp.0, &third.kind, &third.id))
            .unwrap(),
        "third"
    );
    assert_eq!(
        std::fs::read_to_string(package::version_content_path(&tmp.0, &first)).unwrap(),
        "first"
    );
    assert_eq!(
        std::fs::read_to_string(package::disabled_content_path(&tmp.0, &second)).unwrap(),
        "second"
    );
    package::trash(trash(&tmp.0, &third, &deletion), &Hooks::default()).unwrap();
    package::purge(
        package::TrashInput {
            now: Some(1000 + 30 * 86_400_000),
            ..trash(&tmp.0, &third, &deletion)
        },
        &Hooks::default(),
    )
    .unwrap();
    assert!(!tmp.0.join("trash/pad_delete").exists());
}

#[test]
fn rejects_tampered_manifest_and_corrupted_purge_bytes_without_deleting_them() {
    let tmp = Temp::new();
    let first = marker("command", "first");
    let deletion =
        project_artifact::DeletionId::decode(&JsonValue::String("pad_delete".into())).unwrap();
    package::commit(input(&tmp.0, &first, &"first".into()), &Hooks::default()).unwrap();
    package::trash(trash(&tmp.0, &first, &deletion), &Hooks::default()).unwrap();
    let path = tmp.0.join("trash/pad_delete/.ycoding-trash.json");
    let original = std::fs::read_to_string(&path).unwrap();
    for (field, value) in [
        ("entries", JsonValue::Array(Vec::new())),
        ("schema", JsonValue::Number(99.0)),
        ("entryCount", JsonValue::Number(2.0)),
        (
            "entriesDigest",
            JsonValue::String(
                "0000000000000000000000000000000000000000000000000000000000000000".into(),
            ),
        ),
    ] {
        let JsonValue::Object(mut object) = parse_json(&original).unwrap() else {
            panic!()
        };
        object.insert(field.into(), value);
        std::fs::write(
            &path,
            ycoding_schema::stringify_json(&JsonValue::Object(object)),
        )
        .unwrap();
        assert_eq!(
            package::restore(trash(&tmp.0, &first, &deletion), &Hooks::default())
                .unwrap_err()
                .code
                .encode(),
            JsonValue::String("OwnershipMismatch".into())
        );
        assert!(path.exists());
    }
    std::fs::write(&path, original).unwrap();
    std::fs::write(
        tmp.0
            .join("trash/pad_delete/entries/active/pav_first/review.md"),
        "tampered",
    )
    .unwrap();
    assert_eq!(
        package::purge(
            package::TrashInput {
                now: Some(1000 + 30 * 86_400_000),
                ..trash(&tmp.0, &first, &deletion)
            },
            &Hooks::default()
        )
        .unwrap_err()
        .code
        .encode(),
        JsonValue::String("OwnershipMismatch".into())
    );
    assert!(path.exists());
}

#[test]
fn reconciles_process_loss_at_every_multilayout_trash_and_restore_rename() {
    for restoring in [false, true] {
        for boundary in 1..=6 {
            let tmp = Temp::new();
            let first = marker("agent", "first");
            let second = next(&first, "pav_second", "second");
            let third = next(&first, "pav_third", "third");
            package::commit(input(&tmp.0, &first, &"first".into()), &Hooks::default()).unwrap();
            package::commit(
                package::CommitInput {
                    expected_version_id: Some(&first.version_id),
                    ..input(&tmp.0, &second, &"second".into())
                },
                &Hooks::default(),
            )
            .unwrap();
            package::state_mutation(
                package::StateMutationInput {
                    target: Some(&first),
                    ..state(
                        &tmp.0,
                        &second,
                        package::StateOperation::Rollback,
                        "pop_rollback",
                    )
                },
                &Hooks::default(),
            )
            .unwrap();
            package::commit(
                package::CommitInput {
                    expected_version_id: Some(&first.version_id),
                    ..input(&tmp.0, &third, &"third".into())
                },
                &Hooks::default(),
            )
            .unwrap();
            let deletion =
                project_artifact::DeletionId::decode(&JsonValue::String("pad_delete".into()))
                    .unwrap();
            if restoring {
                package::trash(trash(&tmp.0, &third, &deletion), &Hooks::default()).unwrap();
            }
            let entries = tmp.0.join("trash/pad_delete/entries");
            let renames = std::cell::Cell::new(0);
            let after =
                |mutation: &ycoding_core::resources::project_artifact::filesystem::Mutation<'_>| {
                    if mutation.operation == "rename"
                        && if restoring {
                            mutation
                                .source
                                .is_some_and(|path| path.starts_with(&entries))
                        } else {
                            mutation
                                .destination
                                .is_some_and(|path| path.starts_with(&entries))
                        }
                    {
                        renames.set(renames.get() + 1);
                        assert_ne!(renames.get(), boundary, "simulated process loss");
                    }
                    Ok(())
                };
            assert!(
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let hooks = Hooks {
                        after_mutation: Some(&after),
                        ..Hooks::default()
                    };
                    if restoring {
                        package::restore(trash(&tmp.0, &third, &deletion), &hooks)
                    } else {
                        package::trash(trash(&tmp.0, &third, &deletion), &hooks)
                    }
                }))
                .is_err()
            );
            package::reconcile(&tmp.0, &Hooks::default()).unwrap();
            assert_eq!(
                std::fs::read_to_string(package::active_content_path(
                    &tmp.0,
                    &third.kind,
                    &third.id
                ))
                .unwrap(),
                "third"
            );
            assert_eq!(
                std::fs::read_to_string(package::version_content_path(&tmp.0, &first)).unwrap(),
                "first"
            );
            assert_eq!(
                std::fs::read_to_string(package::disabled_content_path(&tmp.0, &second)).unwrap(),
                "second"
            );
            assert!(!tmp.0.join("trash/pad_delete").exists());
        }
    }
}

#[test]
fn standard_skill_scan_classifies_unmanaged_copied_corrupt_and_missing_targets() {
    let tmp = Temp::new();
    let skills = tmp.0.join("standard-skills");
    std::fs::create_dir(&skills).unwrap();
    let first = marker("skill", "first");
    let content = skills.join("review/SKILL.md");
    let metadata = skills.join("review/.ycoding-project-artifact.json");
    std::fs::create_dir(content.parent().unwrap()).unwrap();
    package::commit(
        package::CommitInput {
            standard: Some(package::StandardTarget {
                content_path: &content,
                marker_path: &metadata,
            }),
            ..input(&tmp.0, &first, &"first".into())
        },
        &Hooks::default(),
    )
    .unwrap();
    for id in ["content-only", "copied", "corrupt", "marker-only"] {
        std::fs::create_dir(skills.join(id)).unwrap();
    }
    std::fs::write(skills.join("content-only/SKILL.md"), "user-owned").unwrap();
    std::fs::write(skills.join("corrupt/SKILL.md"), "corrupt").unwrap();
    std::fs::write(
        skills.join("corrupt/.ycoding-project-artifact.json"),
        "not-json",
    )
    .unwrap();
    let mut copied = first.clone();
    copied.id = project_artifact::Id::decode(&JsonValue::String("copied".into())).unwrap();
    copied.scope_id =
        project_artifact::ScopeId::decode(&JsonValue::String("pas_copied".into())).unwrap();
    std::fs::write(skills.join("copied/SKILL.md"), "first").unwrap();
    std::fs::write(
        skills.join("copied/.ycoding-project-artifact.json"),
        ycoding_schema::stringify_json(&copied.encode()),
    )
    .unwrap();
    let mut missing = first.clone();
    missing.id = project_artifact::Id::decode(&JsonValue::String("marker-only".into())).unwrap();
    std::fs::write(
        skills.join("marker-only/.ycoding-project-artifact.json"),
        ycoding_schema::stringify_json(&missing.encode()),
    )
    .unwrap();
    let scan = package::reconcile_standard(
        package::StandardReconcileInput {
            root: &tmp.0,
            scope_id: &first.scope_id,
            storage_id: &first.storage_id,
            roots: package::StandardRoots {
                skill: Some(&skills),
                ..package::StandardRoots::default()
            },
        },
        &Hooks::default(),
    )
    .unwrap();
    assert_eq!(scan.owned, [first]);
    assert_eq!(
        scan.issues
            .iter()
            .map(|issue| (issue.id.as_str(), issue.status, issue.ownership))
            .collect::<Vec<_>>(),
        [
            ("content-only", "content-only", "user-owned"),
            ("copied", "copied-marker", "unknown"),
            ("corrupt", "corrupt-marker", "unknown"),
            ("marker-only", "marker-only", "owned")
        ]
    );
    assert_eq!(
        std::fs::read_to_string(skills.join("content-only/SKILL.md")).unwrap(),
        "user-owned"
    );
}

#[test]
fn quarantines_scope_path_and_digest_mismatches_without_touching_unrelated_content() {
    for field in ["scopeID", "id", "digest"] {
        let tmp = Temp::new();
        let first = marker("command", "first");
        package::commit(input(&tmp.0, &first, &"first".into()), &Hooks::default()).unwrap();
        let metadata_path = package::active_marker_path(&tmp.0, &first.kind, &first.id);
        let content_path = package::active_content_path(&tmp.0, &first.kind, &first.id);
        let mut corrupted = first.clone();
        if field == "scopeID" {
            corrupted.scope_id =
                project_artifact::ScopeId::decode(&JsonValue::String("pas_foreign".into()))
                    .unwrap();
        }
        if field == "id" {
            corrupted.id =
                project_artifact::Id::decode(&JsonValue::String("copied".into())).unwrap();
        }
        if field == "digest" {
            std::fs::write(&content_path, "tampered").unwrap();
        }
        std::fs::write(
            &metadata_path,
            ycoding_schema::stringify_json(&corrupted.encode()),
        )
        .unwrap();
        assert!(
            package::reconcile(&tmp.0, &Hooks::default())
                .unwrap()
                .is_empty()
        );
        assert!(!metadata_path.exists());
        assert_eq!(content_path.exists(), field != "digest");
        assert!(tmp.0.join("quarantine").exists());
    }
}

#[cfg(unix)]
#[test]
fn package_rejects_symlink_roots_and_mutation_time_identity_swaps_without_external_writes() {
    use std::os::unix::fs::symlink;
    let tmp = Temp::new();
    let linked = tmp.0.join("linked");
    symlink(&tmp.0, &linked).unwrap();
    let first = marker("skill", "first");
    assert_eq!(
        package::commit(input(&linked, &first, &"first".into()), &Hooks::default())
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("OwnershipMismatch".into())
    );
    package::commit(input(&tmp.0, &first, &"first".into()), &Hooks::default()).unwrap();
    let second = next(&first, "pav_second", "second");
    let skills = tmp.0.join("active/skills");
    let outside = tmp.0.join("outside");
    std::fs::create_dir(&outside).unwrap();
    let replaced = std::cell::Cell::new(false);
    let content = package::active_content_path(&tmp.0, &first.kind, &first.id);
    let before =
        |mutation: &ycoding_core::resources::project_artifact::filesystem::Mutation<'_>| {
            if !replaced.get()
                && mutation.operation == "rename"
                && mutation.destination == Some(content.as_path())
            {
                replaced.set(true);
                std::fs::rename(&skills, tmp.0.join("prior-skills"))?;
                symlink(&outside, &skills)?;
            }
            Ok(())
        };
    assert_eq!(
        package::commit(
            package::CommitInput {
                expected_version_id: Some(&first.version_id),
                ..input(&tmp.0, &second, &"second".into())
            },
            &Hooks {
                before_mutation: Some(&before),
                ..Hooks::default()
            }
        )
        .unwrap_err()
        .code
        .encode(),
        JsonValue::String("OwnershipMismatch".into())
    );
    assert!(!outside.join("review/SKILL.md").exists());
}

#[test]
fn keeps_finalized_state_bytes_when_cleanup_fails_and_retries_exactly() {
    let tmp = Temp::new();
    let first = marker("skill", "first");
    package::commit(input(&tmp.0, &first, &"first".into()), &Hooks::default()).unwrap();
    let finalized = std::cell::Cell::new(false);
    let finalize = |_: &package::StateMutationMetadata| {
        finalized.set(true);
        Ok::<_, &str>(())
    };
    let before =
        |mutation: &ycoding_core::resources::project_artifact::filesystem::Mutation<'_>| {
            if finalized.get() && mutation.operation == "write" {
                return Err(std::io::Error::other("cleanup failure"));
            }
            Ok(())
        };
    let result = package::state_transaction(
        state(
            &tmp.0,
            &first,
            package::StateOperation::Disable,
            "pop_cleanup",
        ),
        &Hooks {
            before_mutation: Some(&before),
            ..Hooks::default()
        },
        &package::TransactionHooks {
            reserve: None,
            finalize: Some(&finalize),
            abort: None,
            cancellation: None,
            can_compensate: None,
        },
    )
    .unwrap();
    assert_eq!(result.phase, package::StatePhase::Finalizing);
    assert_eq!(
        std::fs::read_to_string(package::disabled_content_path(&tmp.0, &first)).unwrap(),
        "first"
    );
    package::reconcile(&tmp.0, &Hooks::default()).unwrap();
    package::state_mutation(
        state(
            &tmp.0,
            &first,
            package::StateOperation::Disable,
            "pop_cleanup",
        ),
        &Hooks::default(),
    )
    .unwrap();
    assert!(
        package::read_state_transactions(&tmp.0, &Hooks::default())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn locks_reservation_finalization_and_every_trash_restore_rename() {
    let tmp = Temp::new();
    let first = marker("command", "first");
    let check_locks = || {
        for filename in [
            "0b770f7b6158c7b8e6432a2e2303bc32fd8d7409.lock",
            "97cd601f2e63234ae8deb7a0f51848d59f62feda.lock",
        ] {
            let file = std::fs::OpenOptions::new()
                .write(true)
                .open(tmp.0.join("locks").join(filename))
                .unwrap();
            assert!(matches!(
                file.try_lock(),
                Err(std::fs::TryLockError::WouldBlock)
            ));
        }
    };
    let reserve = |_: &package::CommitTransactionMetadata| {
        check_locks();
        Ok::<_, &str>(())
    };
    let finalize = |_: &package::CommitTransactionMetadata| {
        check_locks();
        Ok::<_, &str>(())
    };
    package::commit_transaction(
        input(&tmp.0, &first, &"first".into()),
        &Hooks::default(),
        &package::TransactionHooks {
            reserve: Some(&reserve),
            finalize: Some(&finalize),
            abort: None,
            cancellation: None,
            can_compensate: None,
        },
    )
    .unwrap();
    let deletion =
        project_artifact::DeletionId::decode(&JsonValue::String("pad_delete".into())).unwrap();
    let count = std::cell::Cell::new(0);
    let after = |mutation: &ycoding_core::resources::project_artifact::filesystem::Mutation<'_>| {
        if mutation.operation == "rename"
            && mutation.source.is_some_and(|path| {
                !path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .ends_with(".tmp")
            })
        {
            check_locks();
            count.set(count.get() + 1);
        }
        Ok(())
    };
    package::trash(
        trash(&tmp.0, &first, &deletion),
        &Hooks {
            after_mutation: Some(&after),
            ..Hooks::default()
        },
    )
    .unwrap();
    package::restore(
        trash(&tmp.0, &first, &deletion),
        &Hooks {
            after_mutation: Some(&after),
            ..Hooks::default()
        },
    )
    .unwrap();
    assert_eq!(count.get(), 4);
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(
            tmp.0
                .join("locks/0b770f7b6158c7b8e6432a2e2303bc32fd8d7409.lock"),
        )
        .unwrap();
    file.try_lock().unwrap();
}

#[cfg(unix)]
#[test]
fn native_permissions_archiving_failure_restores_the_old_complete_version() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = Temp::new();
    let first = marker("skill", "first");
    package::commit(input(&tmp.0, &first, &"first".into()), &Hooks::default()).unwrap();
    let directory = package::active_marker_path(&tmp.0, &first.kind, &first.id)
        .parent()
        .unwrap()
        .to_path_buf();
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o500)).unwrap();
    let second = next(&first, "pav_second", "second");
    let result = package::commit(
        package::CommitInput {
            expected_version_id: Some(&first.version_id),
            ..input(&tmp.0, &second, &"second".into())
        },
        &Hooks::default(),
    );
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(result.is_err());
    assert_eq!(
        std::fs::read_to_string(package::active_content_path(&tmp.0, &first.kind, &first.id))
            .unwrap(),
        "first"
    );
    assert_eq!(
        package::read_active(&tmp.0, &first.kind, &first.id, &Hooks::default())
            .unwrap()
            .unwrap(),
        first
    );
}

#[test]
fn global_standard_target_preserves_active_historical_and_disabled_layouts() {
    let tmp = Temp::new();
    let config = Temp::new();
    let first = marker("command", "first");
    let second = next(&first, "pav_second", "second");
    let third = next(&first, "pav_third", "third");
    let content = config.0.join("review.md");
    let metadata = config.0.join(".review.ycoding-project-artifact.json");
    let standard = Some(package::StandardTarget {
        content_path: &content,
        marker_path: &metadata,
    });
    package::commit(
        package::CommitInput {
            standard,
            ..input(&tmp.0, &first, &"first".into())
        },
        &Hooks::default(),
    )
    .unwrap();
    package::commit(
        package::CommitInput {
            standard,
            expected_version_id: Some(&first.version_id),
            ..input(&tmp.0, &second, &"second".into())
        },
        &Hooks::default(),
    )
    .unwrap();
    package::state_mutation(
        package::StateMutationInput {
            standard,
            target: Some(&first),
            ..state(
                &tmp.0,
                &second,
                package::StateOperation::Rollback,
                "pop_rollback",
            )
        },
        &Hooks::default(),
    )
    .unwrap();
    package::commit(
        package::CommitInput {
            standard,
            expected_version_id: Some(&first.version_id),
            ..input(&tmp.0, &third, &"third".into())
        },
        &Hooks::default(),
    )
    .unwrap();
    let deletion =
        project_artifact::DeletionId::decode(&JsonValue::String("pad_global".into())).unwrap();
    package::trash(
        package::TrashInput {
            standard,
            ..trash(&tmp.0, &third, &deletion)
        },
        &Hooks::default(),
    )
    .unwrap();
    assert!(!content.exists());
    assert_eq!(
        package::restore(trash(&tmp.0, &third, &deletion), &Hooks::default())
            .unwrap_err()
            .code
            .encode(),
        JsonValue::String("OwnershipMismatch".into())
    );
    package::restore(
        package::TrashInput {
            standard,
            ..trash(&tmp.0, &third, &deletion)
        },
        &Hooks::default(),
    )
    .unwrap();
    assert_eq!(std::fs::read_to_string(content).unwrap(), "third");
    assert_eq!(
        std::fs::read_to_string(package::version_content_path(&tmp.0, &first)).unwrap(),
        "first"
    );
    assert_eq!(
        std::fs::read_to_string(package::disabled_content_path(&tmp.0, &second)).unwrap(),
        "second"
    );
}

#[test]
fn explicit_cancellation_after_finalization_never_crosses_back_into_compensation() {
    for (state_operation, standard_target) in
        [(true, false), (true, true), (false, false), (false, true)]
    {
        let tmp = Temp::new();
        let config = Temp::new();
        let first = marker("command", "first");
        let second = next(&first, "pav_second", "second");
        let content = if standard_target {
            config.0.join("review.md")
        } else {
            package::active_content_path(&tmp.0, &first.kind, &first.id)
        };
        let metadata = if standard_target {
            config.0.join(".review.ycoding-project-artifact.json")
        } else {
            package::active_marker_path(&tmp.0, &first.kind, &first.id)
        };
        let standard = standard_target.then_some(package::StandardTarget {
            content_path: &content,
            marker_path: &metadata,
        });
        package::commit(
            package::CommitInput {
                standard,
                ..input(&tmp.0, &first, &"first".into())
            },
            &Hooks::default(),
        )
        .unwrap();
        let cancellation = package::Cancellation::default();
        let finalized = std::cell::Cell::new(0);
        let aborted = std::cell::Cell::new(0);
        let before =
            |mutation: &ycoding_core::resources::project_artifact::filesystem::Mutation<'_>| {
                if finalized.get() > 0 && mutation.operation == "write" {
                    cancellation.cancel();
                }
                Ok(())
            };
        let filesystem = Hooks {
            before_mutation: Some(&before),
            ..Hooks::default()
        };
        if state_operation {
            let finalize = |_: &package::StateMutationMetadata| {
                finalized.set(finalized.get() + 1);
                Ok::<_, &str>(())
            };
            let abort = |_: &package::StateMutationMetadata| {
                aborted.set(aborted.get() + 1);
                Ok::<_, &str>(())
            };
            assert!(matches!(
                package::state_transaction(
                    package::StateMutationInput {
                        standard,
                        ..state(
                            &tmp.0,
                            &first,
                            package::StateOperation::Disable,
                            "pop_interrupt"
                        )
                    },
                    &filesystem,
                    &package::TransactionHooks {
                        reserve: None,
                        finalize: Some(&finalize),
                        abort: Some(&abort),
                        cancellation: Some(&cancellation),
                        can_compensate: None
                    }
                ),
                Err(package::TransactionError::Interrupted)
            ));
            assert!(!content.exists());
            assert_eq!(
                std::fs::read_to_string(package::disabled_content_path(&tmp.0, &first)).unwrap(),
                "first"
            );
        } else {
            let finalize = |_: &package::CommitTransactionMetadata| {
                finalized.set(finalized.get() + 1);
                Ok::<_, &str>(())
            };
            let abort = |_: &package::CommitTransactionMetadata| {
                aborted.set(aborted.get() + 1);
                Ok::<_, &str>(())
            };
            assert!(matches!(
                package::commit_transaction(
                    package::CommitInput {
                        standard,
                        expected_version_id: Some(&first.version_id),
                        ..input(&tmp.0, &second, &"second".into())
                    },
                    &filesystem,
                    &package::TransactionHooks {
                        reserve: None,
                        finalize: Some(&finalize),
                        abort: Some(&abort),
                        cancellation: Some(&cancellation),
                        can_compensate: None
                    }
                ),
                Err(package::TransactionError::Interrupted)
            ));
            assert_eq!(std::fs::read_to_string(&content).unwrap(), "second");
            assert_eq!(
                package::Marker::decode(
                    &parse_json(&std::fs::read_to_string(&metadata).unwrap()).unwrap()
                )
                .unwrap()
                .version_id,
                second.version_id
            );
        }
        assert_eq!(finalized.get(), 1);
        assert_eq!(aborted.get(), 0);
    }
}
