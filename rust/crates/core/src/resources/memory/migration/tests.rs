use super::{Checkpoint, Fence, LegacyWriters, MigrationError};
use crate::resources::memory::{
    Error, Limits, Options, Repository, Scope, Search, Service, format::sha256,
};
use std::{
    fs, io,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    sync::{
        Barrier,
        atomic::{AtomicU64, Ordering},
    },
};

const LEGACY: &str = "---\ntype: Decision\nnote: cobalt\n";
const ARCHIVE: &str = "---\ntype: Decision\n---\nArchived.\n";
const SHARED: &str = "---\ntype: Decision\n---\nShared.\n";
const CONCEPT: &str =
    "---\ntype: Decision\n---\n[Shared](/knowledge/shared.md) and [legacy](legacy.md).\n";

struct Fixture {
    path: PathBuf,
    base: PathBuf,
    root: PathBuf,
    receipt: String,
}

impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "ycoding-cue-migration-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        let path = fs::canonicalize(path).unwrap();
        let common = path.join("workspace/.git");
        fs::create_dir_all(&common).unwrap();
        let base = path.join("memory");
        let root = base
            .join("repository")
            .join(format!("repo_{}", sha256(common.to_str().unwrap())));
        let receipt = format!("trash_{}", sha256(format!("archived\0{}", sha256(ARCHIVE))));
        fs::create_dir_all(root.join("trash")).unwrap();
        fs::create_dir_all(base.join("knowledge")).unwrap();
        fs::write(base.join("unrelated.txt"), "outside both collections").unwrap();
        fs::write(root.join("concept.md"), CONCEPT).unwrap();
        fs::write(root.join("legacy.md"), LEGACY).unwrap();
        fs::write(root.join("opaque.bin"), [0, 255, 1]).unwrap();
        fs::write(base.join("knowledge/shared.md"), SHARED).unwrap();
        fs::write(root.join("trash").join(format!("{receipt}.md")), ARCHIVE).unwrap();
        fs::write(
            root.join("trash").join(format!("{receipt}.json")),
            "{\"version\":1,\"id\":\"archived\"}\n",
        )
        .unwrap();
        symlink("../../knowledge/shared.md", root.join("asset-link")).unwrap();
        Self {
            path,
            base,
            root,
            receipt,
        }
    }

    fn service(&self, base: &Path) -> Service {
        Service::new(Options {
            directory: self.path.join("workspace"),
            home: self.path.clone(),
            data: self.path.clone(),
            repository: Some(Repository {
                directory: self.path.join("workspace"),
                common_directory: self.path.join("workspace/.git"),
                worktrees: vec![self.path.join("workspace")],
            }),
            limits: Limits {
                path: Some(base.display().to_string()),
                ..Limits::default()
            },
        })
        .unwrap()
    }

    fn unchanged(&self, base: &Path) {
        let root = base.join(self.root.strip_prefix(&self.base).unwrap());
        assert_eq!(
            fs::read(root.join("concept.md")).unwrap(),
            CONCEPT.as_bytes()
        );
        assert_eq!(fs::read(root.join("legacy.md")).unwrap(), LEGACY.as_bytes());
        assert_eq!(fs::read(root.join("opaque.bin")).unwrap(), [0, 255, 1]);
        assert_eq!(
            fs::read_link(root.join("asset-link")).unwrap(),
            Path::new("../../knowledge/shared.md")
        );
        assert_eq!(
            fs::read(base.join("knowledge/shared.md")).unwrap(),
            SHARED.as_bytes()
        );
        assert_eq!(
            fs::read(root.join("trash").join(format!("{}.md", self.receipt))).unwrap(),
            ARCHIVE.as_bytes()
        );
        assert_eq!(
            fs::read(root.join("trash").join(format!("{}.json", self.receipt))).unwrap(),
            b"{\"version\":1,\"id\":\"archived\"}\n"
        );
        let unrelated = base.join("unrelated.txt");
        if base == self.base {
            assert_eq!(fs::read(unrelated).unwrap(), b"outside both collections");
        } else {
            assert!(!unrelated.exists());
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fn make_removable(root: &Path) {
            fs::set_permissions(root, fs::Permissions::from_mode(0o700)).unwrap();
            for entry in fs::read_dir(root).unwrap() {
                let entry = entry.unwrap();
                if entry.file_type().unwrap().is_dir() {
                    make_removable(&entry.path());
                }
            }
        }
        make_removable(&self.path);
        fs::remove_dir_all(&self.path).unwrap();
    }
}

#[test]
fn refuses_unverified_legacy_exclusion_without_touching_the_store() {
    let fixture = Fixture::new();
    let lock = fixture.root.join(".locks/collection.lock");
    fs::create_dir(lock.parent().unwrap()).unwrap();
    let legacy = fs::File::create(lock).unwrap();
    legacy.lock().unwrap();
    let before = fs::read_dir(&fixture.path).unwrap().count();
    assert!(matches!(
        Fence::acquire(&fixture.base, LegacyWriters::Unverified),
        Err(MigrationError::LegacyWriters)
    ));
    assert_eq!(fs::read_dir(&fixture.path).unwrap().count(), before);
    fixture.unchanged(&fixture.base);
}

#[test]
fn restart_at_each_commit_boundary_keeps_one_complete_generation() {
    for phase in [
        Checkpoint::BackingUp,
        Checkpoint::Staged,
        Checkpoint::BeforePublish,
        Checkpoint::Published,
        Checkpoint::Synced,
    ] {
        let fixture = Fixture::new();
        let mut fence = Fence::acquire(&fixture.base, LegacyWriters::Excluded).unwrap();
        assert!(
            fence
                .migrate_with(
                    |_, rollback| {
                        fixture.unchanged(rollback);
                        Ok(())
                    },
                    |seen, _| {
                        if phase == seen {
                            return Err(io::Error::from(io::ErrorKind::Interrupted).into());
                        }
                        Ok(())
                    }
                )
                .is_err(),
            "{phase:?}"
        );
        drop(fence);
        fixture.unchanged(&fixture.base);
        let mut fence = Fence::acquire(&fixture.base, LegacyWriters::Excluded).unwrap();
        let mut imported = false;
        fence
            .migrate(|original, rollback| {
                imported = true;
                fixture.unchanged(original);
                fixture.unchanged(rollback);
                assert_eq!(
                    fs::metadata(rollback).unwrap().permissions().mode() & 0o222,
                    0
                );
                Ok(())
            })
            .unwrap();
        assert_eq!(
            imported,
            !matches!(phase, Checkpoint::Published | Checkpoint::Synced),
            "{phase:?}"
        );
        fence
            .migrate(|_, _| panic!("re-imported a committed generation"))
            .unwrap();
        fixture.unchanged(&fixture.base);
    }
}

#[test]
fn backup_mismatch_does_not_publish_and_readonly_source_can_retry() {
    let fixture = Fixture::new();
    let legacy = fixture.root.join("legacy.md");
    fs::set_permissions(&legacy, fs::Permissions::from_mode(0o400)).unwrap();
    fs::set_permissions(&fixture.base, fs::Permissions::from_mode(0o500)).unwrap();
    let relative = legacy.strip_prefix(&fixture.base).unwrap();
    let mut fence = Fence::acquire(&fixture.base, LegacyWriters::Excluded).unwrap();
    assert!(
        matches!(fence.migrate_with(|_, _| panic!("verified a corrupt backup"), |phase, rollback| {
        if phase == Checkpoint::BackupCopied {
            let copy = rollback.join(relative);
            fs::set_permissions(&copy, fs::Permissions::from_mode(0o600)).unwrap();
            fs::write(&copy, LEGACY.replace("cobalt", "nickel")).unwrap();
        }
        Ok(())
    }), Err(MigrationError::Mismatch(path)) if path == relative)
    );
    fixture.unchanged(&fixture.base);
    drop(fence);
    let mut fence = Fence::acquire(&fixture.base, LegacyWriters::Excluded).unwrap();
    let mut sealed = PathBuf::new();
    fence
        .migrate(|_, rollback| {
            fixture.unchanged(rollback);
            sealed = rollback.to_path_buf();
            Ok(())
        })
        .unwrap();
    drop(fence);
    assert_eq!(
        fs::metadata(&fixture.base).unwrap().permissions().mode() & 0o777,
        0o500
    );
    assert_eq!(
        fs::metadata(&legacy).unwrap().permissions().mode() & 0o777,
        0o400
    );
    fixture.unchanged(&fixture.base);
    let mut from_readonly = Fence::acquire(&sealed, LegacyWriters::Excluded).unwrap();
    from_readonly
        .migrate(|original, rollback| {
            fixture.unchanged(original);
            fixture.unchanged(rollback);
            Ok(())
        })
        .unwrap();
    drop(from_readonly);
    let copy = sealed.join(relative);
    fs::set_permissions(&copy, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(copy, LEGACY.replace("cobalt", "nickel")).unwrap();
    let mut recovered = Fence::acquire(&fixture.base, LegacyWriters::Excluded).unwrap();
    assert!(matches!(
        recovered.migrate(|_, _| panic!("silently re-imported a corrupt committed generation")),
        Err(MigrationError::InvalidGeneration)
    ));
    fixture.unchanged(&fixture.base);
}

#[tokio::test]
async fn service_uses_legacy_store_without_a_published_cutover() {
    let fixture = Fixture::new();
    let initial = fs::read_dir(&fixture.path).unwrap().count();
    let service = fixture.service(&fixture.base);
    let original = service.read(Scope::Repository, "concept").unwrap();
    assert_eq!(original.content, CONCEPT);
    assert_eq!(fs::read_dir(&fixture.path).unwrap().count(), initial);

    let mut fence = Fence::acquire(&fixture.base, LegacyWriters::Excluded).unwrap();
    let mut rollback = PathBuf::new();
    fence
        .migrate_with(
            |_, _| Ok(()),
            |phase, backup| {
                if phase == Checkpoint::BeforePublish {
                    rollback = backup.to_path_buf();
                    return Err(io::Error::from(io::ErrorKind::Interrupted).into());
                }
                Ok(())
            },
        )
        .unwrap_err();
    drop(fence);

    let service = fixture.service(&fixture.base);
    assert_eq!(
        service.status(Scope::Repository).unwrap().root,
        fixture.root
    );
    assert_eq!(
        service.read(Scope::Repository, "concept").unwrap().content,
        CONCEPT
    );
    let update = "---\ntype: Decision\n---\nWritten to legacy authority.\n";
    service
        .write(Scope::Repository, "concept", update, Some(&original.digest))
        .await
        .unwrap();
    assert_eq!(
        fs::read_to_string(fixture.root.join("concept.md")).unwrap(),
        update
    );
    fixture.unchanged(&rollback);
    assert!(
        !rollback
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("current")
            .exists()
    );
}

#[tokio::test]
async fn service_admits_verified_cutover_and_refuses_corrupt_rollback() {
    let fixture = Fixture::new();
    let mut fence = Fence::acquire(&fixture.base, LegacyWriters::Excluded).unwrap();
    let mut rollback = PathBuf::new();
    fence
        .migrate_with(
            |_, backup| {
                rollback = backup.to_path_buf();
                Ok(())
            },
            |phase, _| {
                if phase == Checkpoint::Published {
                    let service = fixture.service(&fixture.base);
                    assert!(matches!(
                        service.status(Scope::Repository),
                        Err(Error::Unavailable)
                    ));
                }
                Ok(())
            },
        )
        .unwrap();
    drop(fence);

    let service = fixture.service(&fixture.base);
    let state = service.status(Scope::Repository).unwrap();
    assert_eq!(state.root, fixture.root);
    let original = service.read_at(&state, "concept").unwrap();
    assert_eq!(original.content, CONCEPT);
    let update = "---\ntype: Decision\n---\nWritten after cutover.\n";
    let committed = service
        .write(Scope::Repository, "concept", update, Some(&original.digest))
        .await
        .unwrap();
    assert_eq!(
        service.read(Scope::Repository, "concept").unwrap().digest,
        committed.digest
    );
    fixture.unchanged(&rollback);
    let copy = rollback.join("knowledge/shared.md");
    fs::set_permissions(&copy, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&copy, SHARED.replace("Shared", "Altered")).unwrap();
    fs::set_permissions(&copy, fs::Permissions::from_mode(0o400)).unwrap();

    assert!(matches!(
        service.status(Scope::Repository),
        Err(Error::Unavailable)
    ));
    assert!(matches!(
        service.read_at(&state, "concept"),
        Err(Error::Unavailable)
    ));
    assert!(matches!(
        service.list(Scope::Knowledge, None, None),
        Err(Error::Unavailable)
    ));
    assert!(matches!(
        service.graph(Scope::Repository).await,
        Err(Error::Unavailable)
    ));
    assert!(matches!(
        service
            .write(
                Scope::Repository,
                "concept",
                CONCEPT,
                Some(&committed.digest)
            )
            .await,
        Err(Error::Unavailable)
    ));
    assert_eq!(
        fs::read_to_string(fixture.root.join("concept.md")).unwrap(),
        update
    );
    assert!(!fixture.root.join("graph.html").exists());
}

#[test]
fn service_refuses_replacement_at_the_published_root() {
    let fixture = Fixture::new();
    let mut fence = Fence::acquire(&fixture.base, LegacyWriters::Excluded).unwrap();
    fence.migrate(|_, _| Ok(())).unwrap();
    drop(fence);

    let retained = fixture.path.join("retained");
    fs::rename(&fixture.base, &retained).unwrap();
    fs::create_dir(&fixture.base).unwrap();
    assert!(matches!(
        fixture.service(&fixture.base).status(Scope::Repository),
        Err(Error::Unavailable)
    ));
    assert!(fs::read_dir(&fixture.base).unwrap().next().is_none());

    fs::remove_dir(&fixture.base).unwrap();
    symlink(&retained, &fixture.base).unwrap();
    assert!(matches!(
        fixture
            .service(&fixture.base)
            .read(Scope::Repository, "concept"),
        Err(Error::UnsafePath)
    ));
    let concept = fixture
        .root
        .strip_prefix(&fixture.base)
        .unwrap()
        .join("concept.md");
    assert_eq!(fs::read_to_string(retained.join(concept)).unwrap(), CONCEPT);
}

#[tokio::test]
async fn migrated_mixed_bundle_keeps_raw_identity_and_digest_checked_repair() {
    let fixture = Fixture::new();
    let graph = fixture
        .service(&fixture.base)
        .graph(Scope::Repository)
        .await
        .unwrap();
    assert_eq!((graph.nodes, graph.edges), (3, 2));
    let qualified_root = fixture.root.strip_prefix(&fixture.base).unwrap();
    let mut fence = Fence::acquire(&fixture.base, LegacyWriters::Excluded).unwrap();
    fence
        .migrate(|original, rollback| {
            for base in [original, rollback] {
                let service = fixture.service(base);
                let archived = service.trash(Scope::Repository, None, None).unwrap();
                assert_eq!(
                    (
                        archived.entries[0].id.as_str(),
                        archived.entries[0].trash_id.as_str(),
                        archived.entries[0].digest.as_str()
                    ),
                    (
                        "archived",
                        fixture.receipt.as_str(),
                        sha256(ARCHIVE).as_str()
                    )
                );
                assert_eq!(
                    service.read(Scope::Knowledge, "shared").unwrap().content,
                    SHARED
                );
                let graph_bytes = fs::read(base.join(qualified_root).join("graph.html")).unwrap();
                assert_eq!(sha256(graph_bytes), graph.digest);
            }
            Ok(())
        })
        .unwrap();
    drop(fence);
    let service = fixture.service(&fixture.base);
    let expected = sha256(LEGACY);
    let read = service.read(Scope::Repository, "legacy").unwrap();
    assert_eq!(
        (
            read.id.as_str(),
            read.content.as_str(),
            read.digest.as_str()
        ),
        ("legacy", LEGACY, expected.as_str())
    );
    let listing = service.list(Scope::Repository, None, None).unwrap();
    assert_eq!(
        listing
            .concepts
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["concept", "legacy"]
    );
    assert!(
        listing
            .warnings
            .iter()
            .any(|warning| warning.id == "legacy" && warning.code == "unterminated-frontmatter")
    );
    let hits = service
        .search(
            Scope::Repository,
            Search {
                query: "cobalt",
                limit: None,
                type_: None,
                tag: None,
            },
        )
        .unwrap();
    assert_eq!(hits.hits[0].summary.id, "legacy");
    assert!(
        hits.warnings
            .iter()
            .any(|warning| warning.id == "legacy" && warning.code == "unterminated-frontmatter")
    );
    let repaired = "---\ntype: Decision\n---\ncobalt\n";
    assert!(matches!(
        service
            .write(Scope::Repository, "legacy", repaired, Some(&"0".repeat(64)))
            .await,
        Err(Error::StaleContent)
    ));
    assert_eq!(
        fs::read(fixture.root.join("legacy.md")).unwrap(),
        LEGACY.as_bytes()
    );
    service
        .write(Scope::Repository, "legacy", repaired, Some(&expected))
        .await
        .unwrap();
    assert_eq!(
        fs::read(fixture.root.join("legacy.md")).unwrap(),
        repaired.as_bytes()
    );
    assert!(
        !service
            .list(Scope::Repository, None, None)
            .unwrap()
            .warnings
            .iter()
            .any(|warning| warning.id == "legacy")
    );
    assert!(matches!(
        service.write(Scope::Repository, "new", LEGACY, None).await,
        Err(Error::UnterminatedFrontmatter)
    ));
    assert!(!fixture.root.join("new.md").exists());
}

#[test]
fn two_sessions_replace_one_digest_and_leave_the_other_scope_untouched() {
    let fixture = Fixture::new();
    let mut fence = Fence::acquire(&fixture.base, LegacyWriters::Excluded).unwrap();
    fence.migrate(|_, _| Ok(())).unwrap();
    drop(fence);
    let barrier = Barrier::new(2);
    let fixture = &fixture;
    let results = std::thread::scope(|scope| {
        let threads = ["first", "second"].map(|text| {
            let barrier = &barrier;
            scope.spawn(move || {
                let service = fixture.service(&fixture.base);
                let digest = service.read(Scope::Repository, "concept").unwrap().digest;
                let content = format!("---\ntype: Decision\n---\n{text}\n");
                barrier.wait();
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_time()
                    .build()
                    .unwrap();
                runtime
                    .block_on(service.write(Scope::Repository, "concept", &content, Some(&digest)))
                    .map(|_| content)
            })
        });
        threads.map(|thread| thread.join().unwrap())
    });
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(Error::StaleContent)))
            .count(),
        1
    );
    let winner = results.into_iter().find_map(Result::ok).unwrap();
    assert_eq!(
        fs::read(fixture.root.join("concept.md")).unwrap(),
        winner.as_bytes()
    );
    assert_eq!(
        fs::read(fixture.base.join("knowledge/shared.md")).unwrap(),
        SHARED.as_bytes()
    );
}
