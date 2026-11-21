use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use ycoding_core::resources::project_artifact::{legacy_cleanup, package};

struct Fixture {
    directory: PathBuf,
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let directory = std::env::temp_dir().join(format!(
            "ycoding-legacy-cleanup-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&directory).unwrap();
        let directory = fs::canonicalize(directory).unwrap();
        let root = directory.join("generated");
        fs::create_dir(&root).unwrap();
        Self { directory, root }
    }
    fn owned(&self, prefix: &str, location: &str, artifact: &str) -> PathBuf {
        let digest = package::sha256(&format!("{location}\0{artifact}").as_str().into());
        let child = self.root.join(format!(
            "{prefix}-{}",
            &digest.as_lossless().as_str().unwrap()[..12]
        ));
        fs::create_dir(&child).unwrap();
        write_marker(&child, location, artifact);
        child
    }
    fn run(
        &self,
        cursor: Option<&str>,
        limit: Option<usize>,
        dependencies: legacy_cleanup::Dependencies<'_>,
    ) -> legacy_cleanup::Report {
        legacy_cleanup::run(
            legacy_cleanup::Input {
                root: &self.root,
                cursor,
                limit,
            },
            dependencies,
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.directory).unwrap();
    }
}
fn write_marker(child: &Path, location: &str, artifact: &str) {
    let value = ycoding_schema::ObjectEncoder::new()
        .field("generated", &true)
        .field("locationID", location)
        .field("artifactID", artifact)
        .field("versionID", "version")
        .field("versionDigest", "a".repeat(64).as_str())
        .finish();
    fs::write(
        child.join(".ycoding-generated.json"),
        ycoding_schema::stringify_json(&value),
    )
    .unwrap();
}
#[test]
fn removes_only_bounded_positively_marked_legacy_children_and_pages_remaining_entries() {
    let fixture = Fixture::new();
    let owned = fixture.owned("aaa-owned", "location", "artifact");
    fs::create_dir(fixture.root.join("unmarked")).unwrap();
    let linked = fixture.root.join("linked-123456789abc");
    fs::create_dir(&linked).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        fixture.root.join("unmarked"),
        linked.join(".ycoding-generated.json"),
    )
    .unwrap();
    let report = fixture.run(None, Some(1), Default::default());
    assert_eq!(report.status, legacy_cleanup::Status::Partial);
    assert_eq!((report.scanned, report.removed, report.failed), (1, 1, 0));
    assert!(!owned.exists());
    assert!(fixture.root.join("unmarked").exists());
    assert!(linked.exists());
    let remainder = fixture.run(report.cursor.as_deref(), Some(256), Default::default());
    assert_eq!(remainder.status, legacy_cleanup::Status::Complete);
    assert_eq!(
        (remainder.scanned, remainder.removed, remainder.skipped),
        (2, 0, 2)
    );
}
#[test]
fn rejects_wrong_suffix_empty_ids_false_markers_invalid_digests_and_unmarked_children() {
    let fixture = Fixture::new();
    let wrong = fixture.root.join("owned-123456789abc");
    fs::create_dir(&wrong).unwrap();
    write_marker(&wrong, "location", "artifact");
    fixture.owned("empty-location", "", "artifact");
    fixture.owned("empty-artifact", "location", "");
    let empty_version = fixture.owned("empty-version", "location", "version");
    let false_marker = fixture.owned("false-marker", "location", "false");
    let invalid_digest = fixture.owned("invalid-digest", "location", "digest");
    for (directory, marker) in [
        (
            &empty_version,
            r#"{"generated":true,"locationID":"location","artifactID":"version","versionID":""}"#,
        ),
        (
            &false_marker,
            r#"{"generated":false,"locationID":"location","artifactID":"false","versionID":"version"}"#,
        ),
        (
            &invalid_digest,
            r#"{"generated":true,"locationID":"location","artifactID":"digest","versionID":"version","versionDigest":"wrong"}"#,
        ),
    ] {
        fs::write(directory.join(".ycoding-generated.json"), marker).unwrap();
    }
    let report = fixture.run(None, None, Default::default());
    assert_eq!(report.status, legacy_cleanup::Status::Complete);
    assert_eq!((report.removed, report.skipped, report.failed), (0, 6, 0));
    assert_eq!(fs::read_dir(&fixture.root).unwrap().count(), 6);
}
#[test]
fn accepts_a_valid_marker_without_the_optional_version_digest() {
    let fixture = Fixture::new();
    let child = fixture.owned("optional", "location", "artifact");
    fs::write(child.join(".ycoding-generated.json"), r#"{"generated":true,"locationID":"location","artifactID":"artifact","versionID":"version"}"#).unwrap();
    let report = fixture.run(None, None, Default::default());
    assert_eq!((report.removed, report.failed), (1, 0));
}
#[test]
fn cursor_pages_use_one_utf16_order_even_for_supplementary_and_unmarked_names() {
    let fixture = Fixture::new();
    let owned = fixture.owned("aaa-owned", "location", "artifact");
    for name in ["\u{1f642}-unmarked", "\u{e000}-unmarked"] {
        fs::create_dir(fixture.root.join(name)).unwrap();
    }
    let first = fixture.run(None, Some(1), Default::default());
    assert_eq!(first.cursor.as_deref(), owned.file_name().unwrap().to_str());
    let second = fixture.run(first.cursor.as_deref(), Some(1), Default::default());
    assert_eq!(second.status, legacy_cleanup::Status::Partial);
    assert_eq!(second.cursor.as_deref(), Some("\u{1f642}-unmarked"));
    let third = fixture.run(second.cursor.as_deref(), Some(1), Default::default());
    assert_eq!(third.status, legacy_cleanup::Status::Complete);
    assert_eq!(third.cursor.as_deref(), Some("\u{e000}-unmarked"));
    assert_eq!((first.removed, second.skipped, third.skipped), (1, 1, 1));
}
#[test]
fn retains_failed_cursor_entry_restores_from_quarantine_and_removes_it_on_retry() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.root.join("aaa-unmarked")).unwrap();
    let child = fixture.owned("retry", "location", "artifact");
    let remove = |path: &Path| {
        assert_eq!(path.parent(), Some(fixture.directory.as_path()));
        assert!(
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".ycoding-cleanup-generated-")
        );
        Err(io::Error::other("injected remove failure"))
    };
    let failed = fixture.run(
        None,
        None,
        legacy_cleanup::Dependencies {
            before_remove: None,
            remove: Some(&remove),
        },
    );
    assert_eq!(failed.status, legacy_cleanup::Status::Partial);
    assert_eq!((failed.scanned, failed.removed, failed.failed), (2, 0, 1));
    assert_eq!(
        failed.error_code,
        Some(legacy_cleanup::ErrorCode::RemoveFailed)
    );
    assert_eq!(failed.cursor.as_deref(), Some("aaa-unmarked"));
    assert!(child.exists());
    let retried = fixture.run(failed.cursor.as_deref(), None, Default::default());
    assert_eq!(retried.status, legacy_cleanup::Status::Complete);
    assert_eq!(
        (retried.scanned, retried.removed, retried.failed),
        (1, 1, 0)
    );
    assert!(!child.exists());
}
#[test]
fn fails_closed_for_unavailable_or_symlink_roots_and_clamps_each_page_to_256_entries() {
    let fixture = Fixture::new();
    let failed = legacy_cleanup::run(
        legacy_cleanup::Input {
            root: &fixture.directory.join("missing"),
            cursor: None,
            limit: None,
        },
        Default::default(),
    );
    assert_eq!(failed.status, legacy_cleanup::Status::Failed);
    assert_eq!((failed.scanned, failed.failed), (0, 1));
    assert_eq!(
        failed.error_code,
        Some(legacy_cleanup::ErrorCode::RootUnavailable)
    );
    #[cfg(unix)]
    {
        let linked = fixture.directory.join("linked");
        std::os::unix::fs::symlink(&fixture.root, &linked).unwrap();
        assert_eq!(
            legacy_cleanup::run(
                legacy_cleanup::Input {
                    root: &linked,
                    cursor: None,
                    limit: None
                },
                Default::default()
            )
            .status,
            legacy_cleanup::Status::Failed
        );
    }
    for index in 0..257 {
        fs::create_dir(fixture.root.join(format!("unmarked-{index:03}"))).unwrap();
    }
    let first = fixture.run(None, Some(usize::MAX), Default::default());
    assert_eq!(first.status, legacy_cleanup::Status::Partial);
    assert_eq!(first.scanned, 256);
    let second = fixture.run(first.cursor.as_deref(), None, Default::default());
    assert_eq!(second.status, legacy_cleanup::Status::Complete);
    assert_eq!(second.scanned, 1);
    assert_eq!(fixture.run(None, Some(0), Default::default()).scanned, 1);
}
#[cfg(unix)]
#[test]
fn refuses_root_parent_marker_child_and_marker_content_replacement_before_removal() {
    for replacement in ["root", "parent", "marker", "child", "content"] {
        let fixture = Fixture::new();
        let child = fixture.owned("owned", "location", replacement);
        let backup = fixture.directory.join("backup");
        let external = fixture.directory.join("external");
        fs::create_dir(&external).unwrap();
        fs::write(external.join("sentinel"), "external").unwrap();
        let before = |path: &Path| {
            assert_eq!(path, child);
            match replacement {
                "root" => {
                    fs::rename(&fixture.root, &backup)?;
                    std::os::unix::fs::symlink(&external, &fixture.root)?;
                }
                "parent" => {
                    let moved = fixture.directory.with_extension("moved");
                    fs::rename(&fixture.directory, &moved)?;
                    std::os::unix::fs::symlink(&moved, &fixture.directory)?;
                }
                "marker" => {
                    let marker = child.join(".ycoding-generated.json");
                    fs::rename(&marker, child.join("marker.old"))?;
                    fs::write(marker, "{}")?;
                }
                "child" => {
                    fs::rename(&child, &backup)?;
                    std::os::unix::fs::symlink(&external, &child)?;
                }
                _ => {
                    fs::write(child.join(".ycoding-generated.json"), "{}")?;
                }
            }
            Ok(())
        };
        let report = fixture.run(
            None,
            None,
            legacy_cleanup::Dependencies {
                before_remove: Some(&before),
                remove: None,
            },
        );
        assert_eq!(
            report.status,
            legacy_cleanup::Status::Partial,
            "{replacement}"
        );
        assert_eq!((report.removed, report.failed), (0, 1), "{replacement}");
        assert_eq!(
            report.error_code,
            Some(legacy_cleanup::ErrorCode::EntryUnavailable)
        );
        assert!(report.cursor.is_none());
        assert_eq!(
            fs::read_to_string(external.join("sentinel")).unwrap(),
            "external"
        );
        if replacement == "root" {
            fs::remove_file(&fixture.root).unwrap();
            fs::rename(&backup, &fixture.root).unwrap();
        }
        if replacement == "parent" {
            fs::remove_file(&fixture.directory).unwrap();
            fs::rename(
                fixture.directory.with_extension("moved"),
                &fixture.directory,
            )
            .unwrap();
        }
        if replacement == "child" {
            fs::remove_file(&child).unwrap();
            fs::rename(&backup, &child).unwrap();
        }
    }
}
#[test]
fn service_uses_only_the_config_generated_directory() {
    let fixture = Fixture::new();
    fixture.owned("owned", "location", "artifact");
    let service = legacy_cleanup::Service::new(&fixture.directory);
    let report = service.run(None, None);
    assert_eq!((report.removed, report.failed), (1, 0));
}
