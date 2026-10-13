use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use ycoding_core::resources::memory::{Error, Limits, Options, Repository, Scope, Service};

struct Fixture {
    path: PathBuf,
    store: Service,
}
impl Fixture {
    fn new(limits: Limits) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "ycoding-memory-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        let path = fs::canonicalize(path).unwrap();
        fs::create_dir(path.join("workspace")).unwrap();
        fs::create_dir(path.join("workspace/.git")).unwrap();
        let store = Service::new(Options {
            directory: path.join("workspace"),
            home: path.clone(),
            data: path.join("data"),
            repository: Some(Repository {
                directory: path.join("workspace"),
                common_directory: path.join("workspace/.git"),
                worktrees: vec![path.join("workspace")],
            }),
            limits,
        })
        .unwrap();
        Self { path, store }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.path).unwrap();
    }
}
fn note(body: &str) -> String {
    format!("---\ntype: Decision\ntitle: Build guide\n---\n{body}\n")
}

#[tokio::test]
async fn readonly_missing_storage_exact_retries_and_digest_fence() {
    let f = Fixture::new(Limits::default());
    let status = f.store.status(Scope::Repository).unwrap();
    assert!(!status.root.exists());
    assert_eq!(
        f.store.list(Scope::Repository, None, None).unwrap().total,
        0
    );
    assert!(!f.path.join("data").exists());
    let content = note("Use the local build command.");
    let first = f
        .store
        .write(Scope::Repository, "build/rules", &content, None)
        .await
        .unwrap();
    assert!(first.created);
    assert_eq!(
        f.store
            .read(Scope::Repository, "build/rules")
            .unwrap()
            .content,
        content
    );
    assert!(
        !f.store
            .write(Scope::Repository, "build/rules", &content, None)
            .await
            .unwrap()
            .created
    );
    assert!(matches!(
        f.store
            .write(Scope::Repository, "build/rules", &note("Changed"), None)
            .await,
        Err(Error::StaleContent)
    ));
    let one = note("One");
    let two = note("Two");
    let (a, b) = tokio::join!(
        f.store
            .write(Scope::Repository, "build/rules", &one, Some(&first.digest)),
        f.store
            .write(Scope::Repository, "build/rules", &two, Some(&first.digest))
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert!(
        fs::read_to_string(status.root.join("index.md"))
            .unwrap()
            .contains("build/rules.md")
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for directory in [
            &status.root,
            &status.root.join("build"),
            &status.root.join(".locks"),
        ] {
            assert_eq!(
                fs::metadata(directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        assert_eq!(
            fs::metadata(status.root.join("build/rules.md"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[tokio::test]
async fn reserved_ids_and_bad_frontmatter_leave_no_storage() {
    let f = Fixture::new(Limits::default());
    for id in [
        "../escape",
        "/absolute",
        "notes/../escape",
        "index",
        "notes/log",
        "a.md",
        "_meta",
        "trash/hidden",
        "Index",
        "notes/_meta/x",
    ] {
        assert!(matches!(
            f.store
                .write(Scope::Repository, id, &note("ok"), None)
                .await,
            Err(Error::UnsafePath)
        ));
    }
    for content in [
        "No frontmatter",
        "---\ntype: ''\n---\nEmpty type",
        "---\ntype: Decision\n---\nMissing.[^absent]\n",
    ] {
        assert!(matches!(
            f.store
                .write(Scope::Repository, "invalid", content, None)
                .await,
            Err(Error::InvalidConcept)
        ));
    }
    assert!(!f.store.status(Scope::Repository).unwrap().root.exists());
}

#[tokio::test]
async fn trash_receipts_restore_no_overwrite_and_purge_digest_fence() {
    let f = Fixture::new(Limits::default());
    let content = format!("\u{feff}{}", note("Lifecycle sentinel café\nSecond line"));
    let saved = f
        .store
        .write(Scope::Repository, "notes/entry", &content, None)
        .await
        .unwrap();
    assert!(matches!(
        f.store
            .delete(Scope::Repository, "notes/entry", &"0".repeat(64))
            .await,
        Err(Error::StaleContent)
    ));
    let removed = f
        .store
        .delete(Scope::Repository, "notes/entry", &saved.digest)
        .await
        .unwrap();
    assert!(matches!(
        f.store.read(Scope::Repository, "notes/entry"),
        Err(Error::NotFound)
    ));
    assert_eq!(
        f.store.trash(Scope::Repository, None, None).unwrap().total,
        1
    );
    let replacement = f
        .store
        .write(Scope::Repository, "notes/entry", &note("Replacement"), None)
        .await
        .unwrap();
    assert!(matches!(
        f.store
            .restore(Scope::Repository, &removed.trash_id, &saved.digest)
            .await,
        Err(Error::StaleContent)
    ));
    assert!(matches!(
        f.store
            .purge(Scope::Repository, &removed.trash_id, &replacement.digest)
            .await,
        Err(Error::StaleContent)
    ));
    f.store
        .delete(Scope::Repository, "notes/entry", &replacement.digest)
        .await
        .unwrap();
    f.store
        .restore(Scope::Repository, &removed.trash_id, &saved.digest)
        .await
        .unwrap();
    assert_eq!(
        f.store
            .read(Scope::Repository, "notes/entry")
            .unwrap()
            .content,
        content
    );
    let rest = f.store.trash(Scope::Repository, None, None).unwrap();
    f.store
        .purge(
            Scope::Repository,
            &rest.entries[0].trash_id,
            &rest.entries[0].digest,
        )
        .await
        .unwrap();
    assert_eq!(
        f.store.trash(Scope::Repository, None, None).unwrap().total,
        0
    );
}

#[tokio::test]
async fn vacuum_defaults_to_readonly_preview_and_binds_obsolete_bytes() {
    let f = Fixture::new(Limits::default());
    assert!(
        f.store
            .vacuum(Scope::Repository, None, None)
            .await
            .unwrap()
            .dry_run
    );
    let root = f.store.status(Scope::Repository).unwrap().root;
    assert!(!root.exists());
    f.store
        .write(Scope::Repository, "old/entry", &note("Old"), None)
        .await
        .unwrap();
    fs::remove_file(root.join("old/entry.md")).unwrap();
    fs::create_dir(root.join("manual")).unwrap();
    fs::write(root.join("manual/index.md"), "Handwritten index; preserve").unwrap();
    let before = fs::read(root.join("old/index.md")).unwrap();
    let preview = f.store.vacuum(Scope::Repository, None, None).await.unwrap();
    assert!(preview.dry_run);
    assert_eq!(preview.removed, ["old/index.md"]);
    assert_eq!(fs::read(root.join("old/index.md")).unwrap(), before);
    fs::write(
        root.join("old/index.md"),
        [before.as_slice(), b"Changed"].concat(),
    )
    .unwrap();
    assert!(matches!(
        f.store
            .vacuum(Scope::Repository, Some(false), Some(&preview.digest))
            .await,
        Err(Error::StaleContent)
    ));
    let preview = f.store.vacuum(Scope::Repository, None, None).await.unwrap();
    f.store
        .vacuum(Scope::Repository, Some(false), Some(&preview.digest))
        .await
        .unwrap();
    assert!(!root.join("old").exists());
    assert_eq!(
        fs::read_to_string(root.join("manual/index.md")).unwrap(),
        "Handwritten index; preserve"
    );
}

#[tokio::test]
async fn lexical_ranking_filters_unicode_and_paging_match_ts() {
    use ycoding_core::resources::memory::Search;
    let f = Fixture::new(Limits::default());
    for id in ["b", "a"] {
        f.store
            .write(
                Scope::Repository,
                id,
                "---\ntype: Decision\ntitle: Cache\ntags: [runtime]\n---\nSame body\n",
                None,
            )
            .await
            .unwrap();
    }
    f.store
        .write(
            Scope::Repository,
            "c",
            "---\ntype: Guide\ntitle: Other\n---\ncache café\n",
            None,
        )
        .await
        .unwrap();
    let search = |query, type_, tag, limit| {
        f.store
            .search(
                Scope::Repository,
                Search {
                    query,
                    type_,
                    tag,
                    limit,
                },
            )
            .unwrap()
            .hits
    };
    let all = search("cache", None, None, None);
    assert_eq!(
        all.iter()
            .map(|h| (h.summary.id.as_str(), h.score))
            .collect::<Vec<_>>(),
        [("a", 4), ("b", 4), ("c", 1)]
    );
    assert_eq!(
        search("cache", Some("Guide"), None, None)[0].summary.id,
        "c"
    );
    assert_eq!(
        search("cache", None, Some("runtime"), Some(1))[0]
            .summary
            .id,
        "a"
    );
    assert_eq!(search("CAFÉ", None, None, None)[0].summary.id, "c");
    assert!(search("absent", None, None, None).is_empty());
    assert_eq!(
        f.store
            .list(Scope::Repository, Some(1), Some(1))
            .unwrap()
            .concepts[0]
            .id,
        "b"
    );
    for query in ["", "   "] {
        assert!(
            f.store
                .search(
                    Scope::Repository,
                    Search {
                        query,
                        type_: None,
                        tag: None,
                        limit: None
                    }
                )
                .is_err()
        );
    }
    assert!(f.store.list(Scope::Repository, Some(101), None).is_err());
}

#[tokio::test]
async fn graph_is_offline_escaped_deterministic_and_excludes_trash() {
    let f = Fixture::new(Limits::default());
    let repository = f
        .store
        .status(Scope::Repository)
        .unwrap()
        .repository
        .unwrap()
        .id;
    let content = format!(
        "---\ntype: Guide\ntitle: \"</script><img src=x onerror=alert(1)>\"\n---\n[Related](../b.md) [Root][r]\n\n[r]: /repository/{repository}/b.md\n\n`[Code](../ghost.md)`\n\n```md\n[Fenced](../ghost.md)\n```\n\n[Dangling](missing.md)\n<script>globalThis.injected=true</script>\n"
    );
    let saved = f
        .store
        .write(Scope::Repository, "notes/a", &content, None)
        .await
        .unwrap();
    f.store
        .write(
            Scope::Repository,
            "b",
            &note("Use the local build command."),
            None,
        )
        .await
        .unwrap();
    let before = f.store.read(Scope::Repository, "notes/a").unwrap();
    let graph = f.store.graph(Scope::Repository).await.unwrap();
    assert_eq!((graph.nodes, graph.edges), (2, 1));
    assert_eq!(
        graph
            .warnings
            .iter()
            .map(|w| (w.id.as_str(), w.code.as_str()))
            .collect::<Vec<_>>(),
        [("notes/a", "dangling-link")]
    );
    let html = fs::read_to_string(&graph.path).unwrap();
    assert!(!html.contains("<img src=x"));
    assert!(!html.contains("<script>globalThis.injected"));
    assert!(!html.contains("<script src="));
    assert!(!html.contains("fetch("));
    assert!(html.contains("connect-src 'none'"));
    assert_eq!(
        f.store.graph(Scope::Repository).await.unwrap().digest,
        graph.digest
    );
    assert_eq!(
        f.store.read(Scope::Repository, "notes/a").unwrap().content,
        before.content
    );
    f.store
        .delete(Scope::Repository, "notes/a", &saved.digest)
        .await
        .unwrap();
    assert!(!graph.path.exists());
    let regenerated = f.store.graph(Scope::Repository).await.unwrap();
    assert_eq!(regenerated.nodes, 1);
    assert!(
        !fs::read_to_string(regenerated.path)
            .unwrap()
            .contains("globalThis.injected")
    );
}

#[tokio::test]
async fn knowledge_graph_and_repository_qualified_links_share_identity() {
    let f = Fixture::new(Limits::default());
    f.store
        .write(
            Scope::Knowledge,
            "a",
            &note("[Shared target](/knowledge/b.md)"),
            None,
        )
        .await
        .unwrap();
    f.store
        .write(Scope::Knowledge, "b", &note("Shared build facts."), None)
        .await
        .unwrap();
    f.store
        .write(
            Scope::Repository,
            "mem_build",
            &note("[Shared build](../../knowledge/b.md)"),
            None,
        )
        .await
        .unwrap();
    let graph = f.store.graph(Scope::Repository).await.unwrap();
    assert_eq!((graph.nodes, graph.edges), (3, 2));
    let graph = f.store.graph(Scope::Knowledge).await.unwrap();
    assert_eq!((graph.nodes, graph.edges), (2, 1));
    assert!(graph.warnings.is_empty());
    assert!(
        fs::read_to_string(graph.path)
            .unwrap()
            .contains("\"id\":\"knowledge/b\"")
    );
    assert_eq!(
        f.store.list(Scope::Repository, None, None).unwrap().total,
        1
    );
    assert_eq!(f.store.list(Scope::Knowledge, None, None).unwrap().total, 2);
}

#[tokio::test]
async fn capacity_counts_invalid_files_and_derived_failure_is_not_failed_commit() {
    let content = note("café");
    let f = Fixture::new(Limits {
        max_concept_bytes: content.len(),
        max_bundle_bytes: content.len() * 2 - 1,
        ..Limits::default()
    });
    f.store
        .write(Scope::Repository, "a", &content, None)
        .await
        .unwrap();
    assert!(matches!(
        f.store.write(Scope::Repository, "b", &content, None).await,
        Err(Error::TooLarge)
    ));
    assert!(matches!(
        f.store
            .write(Scope::Repository, "b", &(content.clone() + "x"), None)
            .await,
        Err(Error::TooLarge)
    ));
    let root = f.store.status(Scope::Repository).unwrap().root;
    fs::remove_file(root.join("index.md")).unwrap();
    fs::create_dir(root.join("index.md")).unwrap();
    let result = f
        .store
        .write(Scope::Repository, "a", &content, None)
        .await
        .unwrap();
    assert_eq!(result.warnings[0].code, "index-out-of-date");
    assert_eq!(
        f.store.read(Scope::Repository, "a").unwrap().digest,
        result.digest
    );
    fs::remove_dir(root.join("index.md")).unwrap();
    assert_eq!(
        f.store.list(Scope::Repository, None, None).unwrap().total,
        1
    );
    assert!(!root.join("index.md").exists());
    f.store.graph(Scope::Repository).await.unwrap();
    assert!(root.join("index.md").exists());
}

#[tokio::test]
async fn bounded_trash_preserves_bytes_and_refuses_incomplete_inventory() {
    let f = Fixture::new(Limits {
        max_concepts: 4,
        ..Limits::default()
    });
    let saved = f
        .store
        .write(Scope::Repository, "entry", &note("Original"), None)
        .await
        .unwrap();
    let removed = f
        .store
        .delete(Scope::Repository, "entry", &saved.digest)
        .await
        .unwrap();
    let root = f.store.status(Scope::Repository).unwrap().root;
    for index in 0..40 {
        fs::write(
            root.join(format!("trash/trash_{index:064x}.json")),
            "{ malformed receipt",
        )
        .unwrap();
    }
    let listing = f.store.trash(Scope::Repository, None, None).unwrap();
    assert!(listing.entries.is_empty());
    assert_eq!(listing.warnings.len(), 4);
    assert_eq!(listing.warnings.last().unwrap().code, "trash-limit");
    let next = f
        .store
        .write(
            Scope::Repository,
            "next",
            &note("Distinct next entry"),
            None,
        )
        .await
        .unwrap();
    assert!(matches!(
        f.store
            .delete(Scope::Repository, "next", &next.digest)
            .await,
        Err(Error::TooLarge)
    ));
    assert_eq!(
        f.store.read(Scope::Repository, "next").unwrap().digest,
        next.digest
    );
    assert!(root.join(format!("trash/{}.md", removed.trash_id)).exists());
}

#[tokio::test]
async fn duplicate_receipts_do_not_charge_capacity_and_tampering_blocks_restore() {
    let f = Fixture::new(Limits {
        max_concepts: 1,
        ..Limits::default()
    });
    let content = note("Original");
    let saved = f
        .store
        .write(Scope::Repository, "entry", &content, None)
        .await
        .unwrap();
    let first = f
        .store
        .delete(Scope::Repository, "entry", &saved.digest)
        .await
        .unwrap();
    f.store
        .write(Scope::Repository, "entry", &content, None)
        .await
        .unwrap();
    let second = f
        .store
        .delete(Scope::Repository, "entry", &saved.digest)
        .await
        .unwrap();
    assert_eq!(first.trash_id, second.trash_id);
    assert_eq!(
        f.store.trash(Scope::Repository, None, None).unwrap().total,
        1
    );
    let root = f.store.status(Scope::Repository).unwrap().root;
    fs::write(
        root.join(format!("trash/{}.json", first.trash_id)),
        "{\"version\":1,\"id\":\"different\"}\n",
    )
    .unwrap();
    assert!(
        f.store
            .restore(Scope::Repository, &first.trash_id, &saved.digest)
            .await
            .is_err()
    );
    assert!(!root.join("different.md").exists());
    assert_eq!(
        fs::read_to_string(root.join(format!("trash/{}.md", first.trash_id))).unwrap(),
        content
    );
}

#[tokio::test]
async fn cancelling_a_waiting_writer_releases_lock_and_never_commits() {
    use std::future::Future;
    let f = Fixture::new(Limits::default());
    f.store
        .write(Scope::Repository, "existing", &note("Existing"), None)
        .await
        .unwrap();
    let root = f.store.status(Scope::Repository).unwrap().root;
    let lease = fs::OpenOptions::new()
        .write(true)
        .open(root.join(".locks/collection.lock"))
        .unwrap();
    lease.lock().unwrap();
    {
        let content = note("Cancelled");
        let write = f
            .store
            .write(Scope::Repository, "cancelled", &content, None);
        tokio::pin!(write);
        std::future::poll_fn(|cx| {
            assert!(write.as_mut().poll(cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
    }
    drop(lease);
    f.store
        .write(Scope::Repository, "later", &note("Later"), None)
        .await
        .unwrap();
    assert_eq!(
        f.store
            .list(Scope::Repository, None, None)
            .unwrap()
            .concepts
            .iter()
            .map(|c| c.id.as_str())
            .collect::<Vec<_>>(),
        ["existing", "later"]
    );
}

#[test]
fn markdown_source_citations_metadata_and_code_rules_match_ts() {
    use ycoding_core::resources::memory::format::parse;
    let concept = parse("decision", "---\ntype: NovelType\ncustom:\n  preserved: true\nsources:\n  - id: spec\n    resource: repo:///README.md\n---\nEvidence.[^spec]\n").unwrap();
    assert_eq!(concept.summary.type_.as_str(), Some("NovelType"));
    assert!(concept.content.contains("preserved: true"));
    for body in [
        "`Missing.[^absent]`",
        "```\nMissing.[^absent]\n```",
        "[^absent]\n\n[^absent]: https://example.invalid",
    ] {
        assert!(parse("valid", &note(body)).is_ok());
    }
    for body in [
        "Missing.[^absent]",
        "Evidence.[^absent]: https://example.invalid",
    ] {
        assert!(matches!(
            parse("invalid", &note(body)),
            Err(Error::InvalidConcept)
        ));
    }
    for metadata in [
        "type: Decision\ntags: [7]",
        "type: Decision\ntitle: 7",
        "type: Decision\ntitle: x: y",
        "type: Decision\nsources: [{id: duplicate, resource: a}, {id: duplicate, resource: b}]",
        "type: Decision\nsources: [{id: bad.id, resource: a}]",
    ] {
        assert!(parse("invalid", &format!("---\n{metadata}\n---\nbody\n")).is_err());
    }
}

#[tokio::test]
async fn typed_boundary_denies_mutations_and_releases_reservations_on_failure() {
    use std::{
        cell::{Cell, RefCell},
        path::Path,
    };
    use ycoding_core::resources::memory::boundary::{
        self, Authority, Input, Mutation, Permission, Reservation,
    };
    struct Policy {
        visible: Cell<bool>,
        write: Cell<bool>,
        guard: Cell<bool>,
        actions: RefCell<Vec<(Permission, String)>>,
        mutations: RefCell<Vec<(Mutation, String)>>,
        reservations: Cell<usize>,
        releases: Cell<usize>,
    }
    impl Authority for Policy {
        fn visible(&self, _: &Path) -> Result<bool, Error> {
            Ok(self.visible.get())
        }
        fn assert_permission(
            &self,
            permission: Permission,
            _: &Path,
            operation: &str,
            _: Scope,
        ) -> Result<(), Error> {
            self.actions
                .borrow_mut()
                .push((permission, operation.into()));
            if permission == Permission::Write && !self.write.get() {
                return Err(Error::Unavailable);
            }
            Ok(())
        }
        fn reserve(
            &self,
            mutation: Mutation,
            _: &Path,
            operation: &str,
        ) -> Result<Reservation<'_>, Error> {
            self.mutations
                .borrow_mut()
                .push((mutation, operation.into()));
            if !self.guard.get() {
                return Err(Error::Unavailable);
            }
            self.reservations.set(self.reservations.get() + 1);
            Ok(Reservation::new(|| {
                self.releases.set(self.releases.get() + 1)
            }))
        }
    }
    let f = Fixture::new(Limits::default());
    let policy = Policy {
        visible: Cell::new(false),
        write: Cell::new(false),
        guard: Cell::new(false),
        actions: RefCell::new(Vec::new()),
        mutations: RefCell::new(Vec::new()),
        reservations: Cell::new(0),
        releases: Cell::new(0),
    };
    let content = note("Use the local build command.");
    assert!(
        boundary::execute(
            &f.store,
            None,
            Input::Write {
                id: "guide",
                content: &content,
                expected_digest: None
            },
            &policy
        )
        .await
        .is_err()
    );
    assert!(policy.actions.borrow().is_empty());
    policy.visible.set(true);
    assert!(
        boundary::execute(
            &f.store,
            None,
            Input::Write {
                id: "guide",
                content: &content,
                expected_digest: None
            },
            &policy
        )
        .await
        .is_err()
    );
    assert!(!f.path.join("data").exists());
    policy.write.set(true);
    assert!(
        boundary::execute(
            &f.store,
            None,
            Input::Write {
                id: "guide",
                content: &content,
                expected_digest: None
            },
            &policy
        )
        .await
        .is_err()
    );
    assert!(!f.path.join("data").exists());
    policy.guard.set(true);
    boundary::execute(
        &f.store,
        None,
        Input::Write {
            id: "guide",
            content: &content,
            expected_digest: None,
        },
        &policy,
    )
    .await
    .unwrap();
    assert!(
        boundary::execute(
            &f.store,
            None,
            Input::Write {
                id: "guide",
                content: &note("Conflicting"),
                expected_digest: None
            },
            &policy
        )
        .await
        .is_err()
    );
    assert_eq!(policy.reservations.get(), 2);
    assert_eq!(policy.releases.get(), 2);
    let before = policy.mutations.borrow().len();
    boundary::execute(
        &f.store,
        None,
        Input::Vacuum {
            dry_run: None,
            expected_digest: None,
        },
        &policy,
    )
    .await
    .unwrap();
    assert_eq!(policy.mutations.borrow().len(), before);
    assert_eq!(
        policy.actions.borrow().last().unwrap(),
        &(Permission::Read, "vacuum".into())
    );
    boundary::execute(&f.store, None, Input::Graph, &policy)
        .await
        .unwrap();
    assert_eq!(policy.releases.get(), 3);
    assert_eq!(
        policy.mutations.borrow().last().unwrap(),
        &(Mutation::Write, "graph".into())
    );
    assert!(
        boundary::execute(
            &f.store,
            None,
            Input::Purge {
                trash_id: "missing",
                expected_digest: &"0".repeat(64)
            },
            &policy
        )
        .await
        .is_err()
    );
    assert_eq!(policy.releases.get(), 4);
    assert_eq!(
        policy.mutations.borrow().last().unwrap(),
        &(Mutation::Remove, "purge".into())
    );
    let before = policy.actions.borrow().len();
    assert!(
        boundary::execute(
            &f.store,
            None,
            Input::Delete {
                id: "guide",
                expected_digest: "bad"
            },
            &policy
        )
        .await
        .is_err()
    );
    assert_eq!(policy.actions.borrow().len(), before);
}

#[tokio::test]
#[cfg(unix)]
async fn symlink_paths_and_invalid_utf8_are_never_followed_or_repaired_by_reads() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new(Limits::default());
    let root = f.store.status(Scope::Repository).unwrap().root;
    fs::create_dir_all(&root).unwrap();
    symlink(f.path.join("workspace"), root.join("outside")).unwrap();
    assert!(matches!(
        f.store
            .write(Scope::Repository, "outside/escape", &note("Escape"), None)
            .await,
        Err(Error::UnsafePath)
    ));
    assert!(!f.path.join("workspace/escape.md").exists());
    fs::write(root.join("broken.md"), b"---\ntype: Decision\n---\n\xff").unwrap();
    assert!(matches!(
        f.store.read(Scope::Repository, "broken"),
        Err(Error::InvalidConcept)
    ));
    let listing = f.store.list(Scope::Repository, None, None).unwrap();
    assert_eq!(
        listing
            .warnings
            .iter()
            .map(|w| (w.id.as_str(), w.code.as_str()))
            .collect::<Vec<_>>(),
        [("broken", "invalid-concept"), ("outside", "unsafe-link")]
    );
    assert!(!root.join("index.md").exists());
}

#[tokio::test]
async fn disabled_outside_git_relative_and_home_roots_do_not_create_storage() {
    let f = Fixture::new(Limits::default());
    let knowledge = Service::new(Options {
        directory: f.path.clone(),
        home: f.path.clone(),
        data: f.path.join("data"),
        repository: None,
        limits: Limits::default(),
    })
    .unwrap();
    assert!(matches!(
        knowledge.status(Scope::Repository),
        Err(Error::NotFound)
    ));
    knowledge
        .write(Scope::Knowledge, "general", &note("General facts"), None)
        .await
        .unwrap();
    assert_eq!(
        f.store.list(Scope::Knowledge, None, None).unwrap().concepts[0].id,
        "general"
    );
    let disabled = Service::new(Options {
        directory: f.path.clone(),
        home: f.path.clone(),
        data: f.path.join("data"),
        repository: None,
        limits: Limits {
            enabled: false,
            path: Some("~/custom".into()),
            ..Limits::default()
        },
    })
    .unwrap();
    assert_eq!(
        disabled.status(Scope::Knowledge).unwrap().root,
        f.path.join("custom/knowledge")
    );
    assert!(matches!(
        disabled
            .write(Scope::Knowledge, "entry", &note("No effect"), None)
            .await,
        Err(Error::Disabled)
    ));
    assert!(!f.path.join("custom").exists());
    let relative = Service::new(Options {
        directory: f.path.join("workspace"),
        home: f.path.clone(),
        data: f.path.join("data"),
        repository: Some(Repository {
            directory: f.path.join("workspace"),
            common_directory: f.path.join("workspace/.git"),
            worktrees: vec![f.path.join("workspace")],
        }),
        limits: Limits {
            path: Some("notes".into()),
            ..Limits::default()
        },
    })
    .unwrap();
    assert!(
        relative
            .status(Scope::Repository)
            .unwrap()
            .root
            .starts_with(f.path.join("workspace/notes"))
    );
}

#[tokio::test]
async fn approval_root_fence_and_live_disabled_configuration_preserve_saved_bytes() {
    use std::path::Path;
    use ycoding_core::resources::memory::boundary::{
        self, Authority, Input, Mutation, Permission, Reservation,
    };
    struct Redirect<'a>(&'a Service);
    impl Authority for Redirect<'_> {
        fn visible(&self, _: &Path) -> Result<bool, Error> {
            Ok(true)
        }
        fn assert_permission(
            &self,
            _: Permission,
            _: &Path,
            _: &str,
            _: Scope,
        ) -> Result<(), Error> {
            Ok(())
        }
        fn reserve(&self, _: Mutation, _: &Path, _: &str) -> Result<Reservation<'_>, Error> {
            self.0.configure(Limits {
                path: Some("redirected".into()),
                ..Limits::default()
            })?;
            Ok(Reservation::new(|| {}))
        }
    }
    let f = Fixture::new(Limits::default());
    let content = note("Original");
    f.store
        .write(Scope::Repository, "guide", &content, None)
        .await
        .unwrap();
    let root = f.store.status(Scope::Repository).unwrap().root;
    assert!(matches!(
        boundary::execute(
            &f.store,
            None,
            Input::Write {
                id: "redirected",
                content: &content,
                expected_digest: None
            },
            &Redirect(&f.store)
        )
        .await,
        Err(Error::UnsafePath)
    ));
    assert!(!f.path.join("workspace/redirected").exists());
    f.store
        .configure(Limits {
            enabled: false,
            ..Limits::default()
        })
        .unwrap();
    assert!(!f.store.status(Scope::Repository).unwrap().enabled);
    assert!(matches!(
        f.store.read(Scope::Repository, "guide"),
        Err(Error::Disabled)
    ));
    assert_eq!(fs::read_to_string(root.join("guide.md")).unwrap(), content);
    f.store.configure(Limits::default()).unwrap();
    assert_eq!(
        f.store.read(Scope::Repository, "guide").unwrap().content,
        content
    );
}

#[test]
fn configuration_defaults_and_ordered_fieldwise_overrides_match_ts() {
    use std::collections::BTreeMap;
    use ycoding_core::resources::config::{Configuration, Entry, LoadOptions, Roots};
    use ycoding_schema::parse_json;
    let f = Fixture::new(Limits::default());
    let mut config = Configuration::load(LoadOptions {
        directory: f.path.clone(),
        roots: Roots::development(&f.path).unwrap(),
        project: false,
        file: None,
        content: None,
        env: BTreeMap::new(),
    })
    .unwrap();
    assert_eq!(Limits::from_configuration(&config), Limits::default());
    assert_eq!(
        ycoding_core::resources::image::Limits::from_configuration(&config),
        ycoding_core::resources::image::Limits::default()
    );
    config.entries.push(Entry::Document { path: None, info: parse_json(r#"{"memory":{"enabled":false,"path":"./knowledge","max_concepts":5},"attachments":{"image":{"auto_resize":false,"max_width":5000000000}}}"#).unwrap() });
    config.entries.push(Entry::Document {
        path: None,
        info: parse_json(
            r#"{"memory":{"enabled":true},"attachments":{"image":{"max_height":17}}}"#,
        )
        .unwrap(),
    });
    assert_eq!(
        Limits::from_configuration(&config),
        Limits {
            enabled: true,
            path: Some("./knowledge".into()),
            max_concepts: 5,
            ..Limits::default()
        }
    );
    assert_eq!(
        ycoding_core::resources::image::Limits::from_configuration(&config),
        ycoding_core::resources::image::Limits {
            auto_resize: false,
            max_width: 5000000000,
            max_height: 17,
            ..ycoding_core::resources::image::Limits::default()
        }
    );
}
