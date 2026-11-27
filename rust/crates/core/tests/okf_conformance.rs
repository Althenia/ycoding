use chrono::{DateTime, TimeZone, Utc};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicI64, AtomicU64, Ordering},
    },
};
use ycoding_core::resources::memory::{
    Error, Limits, Options, Repository, Scope, Service,
    experience::{self, Evidence, Experience, Outcome},
    okf::Trust,
    reset, templates,
};

const START: i64 = 1_795_000_000;

struct Fixture {
    path: PathBuf,
    clock: Arc<AtomicI64>,
    store: Service,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "okf-conformance-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        let path = fs::canonicalize(path).unwrap();
        fs::create_dir_all(path.join("workspace/.git")).unwrap();
        let clock = Arc::new(AtomicI64::new(START));
        let ticks = clock.clone();
        let store = Service::with_clock(
            Options {
                directory: path.join("workspace"),
                home: path.clone(),
                data: path.join("data"),
                repository: Some(Repository {
                    directory: path.join("workspace"),
                    common_directory: path.join("workspace/.git"),
                    worktrees: vec![path.join("workspace")],
                }),
                limits: Limits::default(),
            },
            Box::new(move || Utc.timestamp_opt(ticks.load(Ordering::Relaxed), 0).unwrap()),
        )
        .unwrap();
        Self { path, clock, store }
    }
    fn root(&self) -> PathBuf {
        self.store.status(Scope::Repository).unwrap().root
    }
    fn advance(&self, seconds: i64) {
        self.clock.fetch_add(seconds, Ordering::Relaxed);
    }
    fn now(&self) -> DateTime<Utc> {
        self.store.now()
    }
    async fn write(&self, id: &str, content: &str) -> ycoding_core::resources::memory::WriteResult {
        self.store
            .write(Scope::Repository, id, content, None, false)
            .await
            .unwrap()
    }
    async fn reject(&self, id: &str, content: &str) -> Error {
        self.store
            .write(Scope::Repository, id, content, None, false)
            .await
            .unwrap_err()
    }
    fn read(&self, id: &str) -> String {
        self.store.read(Scope::Repository, id).unwrap().content
    }
    fn summary(&self, id: &str) -> ycoding_core::resources::memory::format::Summary {
        self.store
            .list(Scope::Repository, None, None)
            .unwrap()
            .concepts
            .into_iter()
            .find(|concept| concept.id == id)
            .unwrap_or_else(|| panic!("{id} is not listed"))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn note(body: &str) -> String {
    format!("---\ntype: Note\n---\n{body}\n")
}

#[tokio::test]
async fn source_without_resource_is_tolerated() {
    let f = Fixture::new();
    f.write(
        "a",
        "---\ntype: Note\nsources:\n  - title: no resource\n---\nBody\n",
    )
    .await;
}
#[tokio::test]
async fn footnote_without_source_is_tolerated() {
    let f = Fixture::new();
    f.write("a", "---\ntype: Note\n---\nClaim.[^missing]\n")
        .await;
}
#[tokio::test]
async fn non_string_and_null_optional_metadata_is_tolerated() {
    let f = Fixture::new();
    f.write("a", "---\ntype: Note\ntitle: 123\n---\nBody\n")
        .await;
    f.write("b", "---\ntype: Note\ntitle:\ntags:\n---\nBody two\n")
        .await;
    f.write(
        "c",
        "---\ntype: Note\nstatus: surprising\n---\nBody three\n",
    )
    .await;
}
#[tokio::test]
async fn hand_written_concept_with_any_file_name_is_listed() {
    let f = Fixture::new();
    f.write("seed", &note("Body")).await;
    fs::write(
        f.root().join("Orders Table.md"),
        "---\ntype: Table\n---\nBody\n",
    )
    .unwrap();
    let listing = f.store.list(Scope::Repository, None, None).unwrap();
    assert!(listing.concepts.iter().any(|c| c.id == "Orders Table"));
}
#[tokio::test]
async fn trash_is_outside_the_bundle() {
    let f = Fixture::new();
    let first = f.write("a", &note("Body")).await;
    f.store
        .delete(Scope::Repository, "a", &first.digest)
        .await
        .unwrap();
    assert!(!f.root().join("trash").exists());
    assert!(f.root().join(".trash").exists());
    assert_eq!(
        f.store.trash(Scope::Repository, None, None).unwrap().total,
        1
    );
}
#[tokio::test]
async fn root_index_declares_okf_version_and_hides_local_paths() {
    let f = Fixture::new();
    f.write("a", &note("Body")).await;
    let index = fs::read_to_string(f.root().join("index.md")).unwrap();
    assert!(index.starts_with("---\n") && index.contains("okf_version: \"0.3\""));
    assert!(!index.contains(&f.path.to_string_lossy().into_owned()));
}
#[tokio::test]
async fn changes_are_logged_newest_date_first() {
    let f = Fixture::new();
    f.write("a", &note("First body")).await;
    f.advance(2 * 86_400);
    f.write("b", &note("Second distinct body about other things"))
        .await;
    let log = fs::read_to_string(f.root().join("log.md")).unwrap();
    let dates: Vec<_> = log.lines().filter(|l| l.starts_with("## ")).collect();
    assert_eq!(dates.len(), 2, "{log}");
    assert!(dates[0] > dates[1], "{log}");
    assert!(!log.starts_with("---"));
}
#[tokio::test]
async fn harness_stamps_generated_and_never_verifies() {
    let f = Fixture::new();
    f.write("a", &note("Body")).await;
    let text = f.read("a");
    assert!(
        text.contains("generated:") && text.contains("ycoding/"),
        "{text}"
    );
    assert!(!text.contains("verified:"), "{text}");
    let summary = f.summary("a");
    assert_eq!(summary.signals.trust, Trust::Unverified);
    assert_eq!(summary.signals.generated_at, Some(f.now()));
}
#[tokio::test]
async fn unchanged_rewrite_keeps_the_generation_stamp() {
    let f = Fixture::new();
    let first = f.write("a", &note("Body")).await;
    let stamped = f.read("a");
    f.advance(3600);
    let second = f
        .store
        .write(
            Scope::Repository,
            "a",
            &note("Body"),
            Some(&first.digest),
            false,
        )
        .await
        .unwrap();
    assert_eq!(second.digest, first.digest);
    assert_eq!(f.read("a"), stamped);
}
#[tokio::test]
async fn changed_content_restamps_generation_time() {
    let f = Fixture::new();
    let first = f.write("a", &note("Body")).await;
    f.advance(3600);
    f.store
        .write(
            Scope::Repository,
            "a",
            &note("Different body"),
            Some(&first.digest),
            false,
        )
        .await
        .unwrap();
    assert_eq!(f.summary("a").signals.generated_at, Some(f.now()));
}
#[tokio::test]
async fn invented_verification_is_rejected() {
    let f = Fixture::new();
    let claimed = "---\ntype: Note\nverified:\n  - by: agent:planner\n    at: 2026-11-01T00:00:00Z\n---\nBody\n";
    assert!(matches!(
        f.reject("a", claimed).await,
        Error::Rejected("verified-requires-evidence")
    ));
}
#[tokio::test]
async fn human_verification_needs_explicit_confirmation() {
    let f = Fixture::new();
    let first = f.write("a", &note("Body")).await;
    f.advance(3600);
    let claimed = format!(
        "---\ntype: Note\nverified:\n  - by: human:alice\n    at: {}\n---\nBody\n",
        f.now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    );
    assert!(matches!(
        f.store
            .write(Scope::Repository, "a", &claimed, Some(&first.digest), false)
            .await,
        Err(Error::Rejected(_))
    ));
    f.store
        .write(Scope::Repository, "a", &claimed, Some(&first.digest), true)
        .await
        .unwrap();
    let summary = f.summary("a");
    assert_eq!(summary.signals.trust, Trust::HumanReviewed);
    assert!(!summary.signals.verification_older_than_content);
}
#[tokio::test]
async fn editing_content_after_verification_drops_the_trust_tier() {
    let f = Fixture::new();
    let first = f.write("a", &note("Body")).await;
    let claimed = format!(
        "---\ntype: Note\nverified:\n  - by: human:alice\n    at: {}\n---\nBody\n",
        f.now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    );
    let verified = f
        .store
        .write(Scope::Repository, "a", &claimed, Some(&first.digest), true)
        .await
        .unwrap();
    f.advance(3600);
    let edited = claimed.replace("Body\n", "Changed body\n");
    f.store
        .write(
            Scope::Repository,
            "a",
            &edited,
            Some(&verified.digest),
            false,
        )
        .await
        .unwrap();
    assert_eq!(f.summary("a").signals.trust, Trust::Unverified);
}
#[tokio::test]
async fn future_human_verification_is_rejected() {
    let f = Fixture::new();
    let claimed = "---\ntype: Note\nverified:\n  - by: human:alice\n    at: 2099-01-01T00:00:00Z\n---\nBody\n";
    assert!(
        f.store
            .write(Scope::Repository, "a", claimed, None, true)
            .await
            .is_err()
    );
}
#[tokio::test]
async fn credentials_are_rejected() {
    let f = Fixture::new();
    for body in [
        "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "key AKIAABCDEFGHIJKLMNOP",
        "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    ] {
        assert!(
            matches!(f.reject("a", &note(body)).await, Error::Rejected(_)),
            "{body}"
        );
    }
}
#[tokio::test]
async fn machine_local_paths_draw_advice_not_rejection() {
    let f = Fixture::new();
    let written = f
        .write("a", &note("See /Users/someone/project/file.rs for it"))
        .await;
    assert!(
        written.diagnostics.iter().any(|d| d.code == "Y310"),
        "{:?}",
        written.diagnostics
    );
}
#[tokio::test]
async fn structural_defects_are_rejected() {
    let f = Fixture::new();
    for content in [
        "no frontmatter",
        "---\ntitle: missing type\n---\nBody\n",
        "---\ntype: Note\ntype: Again\n---\nBody\n",
        "---\n- a\n- b\n---\nBody\n",
        "---\ntype: Note\nBody without close\n",
    ] {
        assert!(
            f.store
                .write(Scope::Repository, "a", content, None, false)
                .await
                .is_err(),
            "{content}"
        );
    }
}
#[tokio::test]
async fn near_duplicate_create_reports_the_existing_concept() {
    let f = Fixture::new();
    let body = "The release pipeline signs every artifact with the hardware key before upload to the registry";
    f.write("one", &note(body)).await;
    let second = f.write("two", &note(body)).await;
    assert_eq!(second.duplicate_of.as_deref(), Some("one"));
    assert!(!f.root().join("two.md").exists());
}
#[tokio::test]
async fn same_title_and_type_create_reports_duplicate() {
    let f = Fixture::new();
    f.write(
        "one",
        "---\ntype: Decision\ntitle: Use sqlite\n---\nAlpha beta gamma\n",
    )
    .await;
    let second = f
        .write(
            "two",
            "---\ntype: Decision\ntitle: use  SQLite\n---\nCompletely different words here\n",
        )
        .await;
    assert_eq!(second.duplicate_of.as_deref(), Some("one"));
}
#[tokio::test]
async fn stale_after_marks_concepts_stale_once_due() {
    let f = Fixture::new();
    f.write(
        "a",
        "---\ntype: Note\nstale_after: 2026-12-01T00:00:00Z\n---\nBody\n",
    )
    .await;
    assert!(!f.summary("a").signals.stale);
    f.advance(30 * 86_400);
    let summary = f.summary("a");
    assert!(summary.signals.stale);
    let review = f.store.review(Scope::Repository).unwrap();
    assert!(
        review
            .flagged
            .iter()
            .any(|(s, reasons)| s.id == "a" && reasons.contains(&"stale"))
    );
}
#[tokio::test]
async fn supersede_deprecates_and_links_the_replacement() {
    let f = Fixture::new();
    let old = f.write("old", &note("Old guidance about deploys")).await;
    f.write(
        "new",
        &note("Fresh guidance covering rollouts completely different"),
    )
    .await;
    let result = f
        .store
        .supersede(Scope::Repository, "old", Some("new"), &old.digest)
        .await
        .unwrap();
    assert_eq!(result.superseded_by.as_deref(), Some("new"));
    let text = f.read("old");
    assert!(
        text.contains("status: deprecated") && text.contains("superseded_by"),
        "{text}"
    );
    let summary = f.summary("old");
    assert!(!summary.signals.current);
    assert_eq!(summary.signals.superseded_by.as_deref(), Some("/new.md"));
}
#[tokio::test]
async fn supersede_rejects_stale_digest_and_cycles() {
    let f = Fixture::new();
    let old = f.write("old", &note("Old")).await;
    assert!(
        f.store
            .supersede(Scope::Repository, "old", Some("old"), &old.digest)
            .await
            .is_err()
    );
    assert!(matches!(
        f.store
            .supersede(Scope::Repository, "old", None, &"0".repeat(64))
            .await,
        Err(Error::StaleContent)
    ));
}
#[tokio::test]
async fn retire_deprecates_without_replacement() {
    let f = Fixture::new();
    let old = f.write("old", &note("Old")).await;
    f.store
        .supersede(Scope::Repository, "old", None, &old.digest)
        .await
        .unwrap();
    let summary = f.summary("old");
    assert!(!summary.signals.current && summary.signals.superseded_by.is_none());
}
#[tokio::test]
async fn deprecated_concepts_are_flagged_in_review() {
    let f = Fixture::new();
    let old = f.write("old", &note("Old")).await;
    f.store
        .supersede(Scope::Repository, "old", None, &old.digest)
        .await
        .unwrap();
    let review = f.store.review(Scope::Repository).unwrap();
    assert!(
        review
            .flagged
            .iter()
            .any(|(s, r)| s.id == "old" && r.contains(&"deprecated"))
    );
}
#[tokio::test]
async fn hand_written_same_title_concepts_conflict() {
    let f = Fixture::new();
    f.write("seed", &note("Seed")).await;
    for name in ["x", "y"] {
        fs::write(
            f.root().join(format!("{name}.md")),
            format!("---\ntype: Decision\ntitle: Pick a database\n---\nChoice {name}\n"),
        )
        .unwrap();
    }
    assert_eq!(f.summary("x").signals.conflicts_with, vec!["y".to_owned()]);
}
#[tokio::test]
async fn unknown_frontmatter_fields_survive_lifecycle_edits() {
    let f = Fixture::new();
    let old = f
        .write(
            "old",
            "---\ntype: Note\nx-custom: keep me\nowner: ops\n---\nBody\n",
        )
        .await;
    f.store
        .supersede(Scope::Repository, "old", None, &old.digest)
        .await
        .unwrap();
    let text = f.read("old");
    assert!(
        text.contains("x-custom: keep me") && text.contains("owner: ops"),
        "{text}"
    );
}
#[tokio::test]
async fn nested_ids_get_directory_indexes() {
    let f = Fixture::new();
    f.write("ops/runbook", &note("Runbook body")).await;
    let nested = fs::read_to_string(f.root().join("ops/index.md")).unwrap();
    assert!(nested.contains("runbook"));
    let root = fs::read_to_string(f.root().join("index.md")).unwrap();
    assert!(root.contains("ops/"));
}
#[tokio::test]
async fn hand_written_root_index_frontmatter_is_preserved() {
    let f = Fixture::new();
    f.write("a", &note("Body")).await;
    let path = f.root().join("index.md");
    let original = fs::read_to_string(&path).unwrap();
    let edited = original.replacen("---\n", "---\nlicense: MIT\n", 1);
    fs::write(&path, &edited).unwrap();
    f.write("b", &note("A second and different body")).await;
    assert!(fs::read_to_string(&path).unwrap().contains("license: MIT"));
}

#[tokio::test]
async fn every_template_skeleton_is_a_valid_write() {
    let f = Fixture::new();
    let kinds: Vec<_> = templates::kinds().collect();
    assert_eq!(kinds.len(), 9, "{kinds:?}");
    for (index, kind) in kinds.iter().enumerate() {
        let template = templates::by_kind(kind).unwrap();
        let skeleton = templates::skeleton(template);
        let id = format!("t{index}");
        let result = f
            .store
            .write(Scope::Repository, &id, &skeleton, None, false)
            .await;
        if *kind == "experience" {
            assert!(
                matches!(result, Err(Error::Rejected("experience-outcome-invalid"))),
                "an unfilled experience skeleton is not writable"
            );
            continue;
        }
        let written = result.unwrap_or_else(|e| panic!("{kind}: {e}\n{skeleton}"));
        assert!(written.created, "{kind}");
    }
}

fn sample_experience() -> Experience {
    Experience {
        cue: "cargo test exits with a linker error after a dependency bump".into(),
        lesson: "Clear the stale incremental build output before rerunning the selected test."
            .into(),
        applicability: "Rust workspaces that share one target directory".into(),
        outcome: Outcome::Failure,
        confidence: 0.8,
        evidence: vec![Evidence {
            resource: "https://example.com/build-notes".into(),
            title: "Build notes".into(),
        }],
        harness_change: Some("repo:///rust/config/build.toml".into()),
        tags: vec!["build".into()],
    }
}

fn replace_line(content: &str, key: &str, line: &str) -> String {
    let mut replaced = false;
    let lines = content
        .lines()
        .map(|current| {
            if current.starts_with(key) {
                replaced = true;
                line.to_owned()
            } else {
                current.to_owned()
            }
        })
        .collect::<Vec<_>>();
    assert!(replaced, "{key} is not in the sample");
    lines.join("\n") + "\n"
}
fn drop_line(content: &str, key: &str) -> String {
    let kept = content
        .lines()
        .filter(|line| !line.starts_with(key))
        .collect::<Vec<_>>();
    assert_ne!(
        kept.len(),
        content.lines().count(),
        "{key} is not in the sample"
    );
    kept.join("\n") + "\n"
}

fn write_tree(root: &Path, files: &[(&str, &str)]) {
    for (name, content) in files {
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
}

#[tokio::test]
async fn reset_purges_legacy_state_and_keeps_everything_else() {
    let f = Fixture::new();
    let base = f.store.status(Scope::Knowledge).unwrap().base;
    write_tree(
        &base,
        &[
            ("repository/repo_abc/old.md", "legacy"),
            ("repository/repo_abc/trash/x.md", "legacy trash"),
            ("knowledge/shared.md", "legacy shared"),
            ("unrelated/keep.txt", "keep"),
        ],
    );
    let data = f.path.join("data");
    write_tree(
        &data,
        &[
            ("recall/cache.bin", "cache"),
            ("sessions/history.json", "history"),
        ],
    );
    let migration = base
        .parent()
        .unwrap()
        .join(".ycoding-memory-migration-deadbeef/control.json");
    write_tree(
        migration.parent().unwrap().parent().unwrap(),
        &[(".ycoding-memory-migration-deadbeef/control.json", "{}")],
    );

    let plan = f.store.reset_plan().unwrap();
    assert!(plan.repositories.contains(&"repo_abc".to_owned()));
    let archive = f.path.join("rollback");
    fs::create_dir(&archive).unwrap();
    let report = f.store.reset(&plan.digest, &archive).unwrap();

    assert!(!base.join("repository/repo_abc/old.md").exists());
    assert!(!base.join("knowledge/shared.md").exists());
    assert!(!data.join("recall").exists());
    assert!(!migration.exists());
    assert!(base.join("unrelated/keep.txt").exists());
    assert!(data.join("sessions/history.json").exists());
    assert!(
        fs::read_dir(&archive).unwrap().next().is_some(),
        "archive holds the removed trees"
    );
    assert!(!report.removed.is_empty());
    let knowledge = f.store.status(Scope::Knowledge).unwrap().root;
    let index = fs::read_to_string(knowledge.join("index.md")).unwrap();
    assert!(index.contains("okf_version: \"0.3\""));
    assert!(knowledge.join("log.md").exists());
    assert_eq!(
        f.store.list(Scope::Knowledge, None, None).unwrap().total,
        0,
        "legacy content is never migrated"
    );
}
#[tokio::test]
async fn reset_refuses_a_stale_plan_digest() {
    let f = Fixture::new();
    let base = f.store.status(Scope::Knowledge).unwrap().base;
    write_tree(&base, &[("repository/repo_abc/old.md", "legacy")]);
    let plan = f.store.reset_plan().unwrap();
    write_tree(
        &base,
        &[("repository/repo_abc/extra.md", "added after planning")],
    );
    let archive = f.path.join("rollback");
    fs::create_dir(&archive).unwrap();
    assert!(f.store.reset(&plan.digest, &archive).is_err());
    assert!(base.join("repository/repo_abc/old.md").exists());
}
#[tokio::test]
async fn reset_refuses_a_non_empty_or_inside_archive() {
    let f = Fixture::new();
    let base = f.store.status(Scope::Knowledge).unwrap().base;
    write_tree(&base, &[("repository/repo_abc/old.md", "legacy")]);
    let plan = f.store.reset_plan().unwrap();
    let busy = f.path.join("busy");
    write_tree(&busy, &[("x", "y")]);
    assert!(f.store.reset(&plan.digest, &busy).is_err());
    let inside = base.join("archive");
    fs::create_dir_all(&inside).unwrap();
    assert!(f.store.reset(&plan.digest, &inside).is_err());
    assert!(base.join("repository/repo_abc/old.md").exists());
}
#[cfg(unix)]
#[tokio::test]
async fn reset_never_follows_symlinks() {
    let f = Fixture::new();
    let base = f.store.status(Scope::Knowledge).unwrap().base;
    let outside = f.path.join("outside");
    write_tree(&outside, &[("precious.txt", "keep")]);
    fs::create_dir_all(base.join("repository/repo_abc")).unwrap();
    std::os::unix::fs::symlink(&outside, base.join("repository/repo_abc/link")).unwrap();
    let archive = f.path.join("rollback");
    fs::create_dir(&archive).unwrap();
    let plan = f.store.reset_plan().unwrap();
    let _ = f.store.reset(&plan.digest, &archive);
    assert!(outside.join("precious.txt").exists());
}
#[tokio::test]
async fn reset_does_not_recur() {
    let f = Fixture::new();
    f.write("a", &note("Body")).await;
    let before = f.read("a");
    let plan: reset::Plan = f.store.reset_plan().unwrap();
    assert!(plan.targets.is_empty() || plan.repositories.is_empty() || !plan.digest.is_empty());
    assert_eq!(f.read("a"), before);
}

mod projection {
    use super::*;
    use ycoding_core::resources::recall::document::{
        Document, Kind, Scope as DocumentScope, Status, Trust as DocumentTrust,
    };

    fn documents(f: &Fixture) -> Vec<Document> {
        f.store.documents(Scope::Repository).unwrap()
    }
    fn document(f: &Fixture, id: &str) -> Document {
        documents(f)
            .into_iter()
            .find(|document| document.id == id)
            .unwrap_or_else(|| panic!("{id} has no document"))
    }

    #[tokio::test]
    async fn concepts_project_into_documents_with_source_and_fields() {
        let f = Fixture::new();
        f.write(
            "ops/target",
            &note("Target body with its own distinct vocabulary"),
        )
        .await;
        let written = f
            .write(
                "ops/runbook",
                "---\ntype: Procedure\ntitle: Roll back a deploy\ndescription: Steps to revert\ntags: [ops, deploy]\nkeywords: [rollback]\nresource: https://example.com/deploys\nsources:\n  - id: s1\n    resource: https://example.com/runbook\n---\nRevert with the pipeline.[^s1] See [target](target.md).\n\n[^s1]: Runbook.\n",
            )
            .await;
        let doc = document(&f, "ops/runbook");
        assert_eq!(doc.kind, Kind::Concept);
        assert_eq!(doc.scope, DocumentScope::Workspace);
        assert_eq!(
            doc.key(),
            (DocumentScope::Workspace, Kind::Concept, "ops/runbook")
        );
        assert_eq!(doc.source.path, "ops/runbook.md");
        assert_eq!(doc.source.content_hash, written.digest);
        assert!(!doc.source.revision.is_empty());
        assert_eq!(doc.fields.doc_type, "Procedure");
        assert_eq!(doc.fields.title, "Roll back a deploy");
        assert_eq!(doc.fields.description, "Steps to revert");
        assert_eq!(doc.fields.tags, ["ops", "deploy"]);
        assert_eq!(doc.fields.keywords, ["rollback"]);
        assert!(doc.fields.body.contains("Revert with the pipeline."));
        assert!(!doc.fields.body.contains("type: Procedure"));
        for expected in [
            "https://example.com/deploys",
            "s1",
            "https://example.com/runbook",
        ] {
            assert!(
                doc.fields.identifiers.contains(&expected.to_owned()),
                "{expected}"
            );
        }
        assert_eq!(doc.fields.relationships, ["ops/target"]);
        assert!(doc.lifecycle.eligible(START));
        assert_eq!(doc.lifecycle.trust, DocumentTrust::Unverified);
        assert!(doc.lifecycle.activation.is_none());
    }
    #[tokio::test]
    async fn untitled_concepts_fall_back_to_their_id_and_knowledge_scope_is_distinct() {
        let f = Fixture::new();
        f.store
            .write(
                Scope::Knowledge,
                "shared",
                &note("Shared body"),
                None,
                false,
            )
            .await
            .unwrap();
        let doc = &f.store.documents(Scope::Knowledge).unwrap()[0];
        assert_eq!(doc.fields.title, "shared");
        assert_eq!(doc.scope, DocumentScope::Knowledge);
        assert!(f.store.documents(Scope::Repository).unwrap().is_empty());
    }
    #[tokio::test]
    async fn lifecycle_signals_make_documents_ineligible() {
        let f = Fixture::new();
        let old = f.write("old", &note("Old guidance about deploys")).await;
        f.write("new", &note("Fresh rollout guidance entirely different"))
            .await;
        f.write(
            "draft",
            "---\ntype: Note\nstatus: draft\n---\nA draft idea\n",
        )
        .await;
        f.write(
            "archived",
            "---\ntype: Note\nstatus: archived\n---\nAn archived idea\n",
        )
        .await;
        f.write(
            "expiring",
            "---\ntype: Note\nstale_after: 2026-12-01T00:00:00Z\n---\nExpiring words here\n",
        )
        .await;
        f.write(
            "malformed",
            "---\ntype: Note\nstale_after: not-a-date\n---\nMalformed deadline text\n",
        )
        .await;
        f.store
            .supersede(Scope::Repository, "old", Some("new"), &old.digest)
            .await
            .unwrap();
        assert!(document(&f, "new").lifecycle.eligible(START));
        let old_doc = document(&f, "old");
        assert_eq!(old_doc.lifecycle.status, Status::Deprecated);
        assert_eq!(old_doc.lifecycle.superseded_by.as_deref(), Some("new"));
        assert!(!old_doc.lifecycle.eligible(START));
        assert_eq!(document(&f, "draft").lifecycle.status, Status::Draft);
        assert!(!document(&f, "draft").lifecycle.eligible(START));
        assert_eq!(document(&f, "archived").lifecycle.status, Status::Archived);
        assert!(!document(&f, "archived").lifecycle.eligible(START));
        assert!(!document(&f, "malformed").lifecycle.eligible(START));
        let expiring = document(&f, "expiring");
        let deadline = Utc
            .with_ymd_and_hms(2026, 12, 1, 0, 0, 0)
            .unwrap()
            .timestamp();
        assert!(expiring.lifecycle.eligible(deadline - 1));
        assert!(!expiring.lifecycle.eligible(deadline));
        assert!(expiring.lifecycle.eligible(START));
    }
    #[tokio::test]
    async fn verification_projects_as_verified_trust_until_content_changes() {
        let f = Fixture::new();
        let first = f.write("a", &note("Body")).await;
        let claimed = format!(
            "---\ntype: Note\nverified:\n  - by: human:alice\n    at: {}\n---\nBody\n",
            f.now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        );
        let verified = f
            .store
            .write(Scope::Repository, "a", &claimed, Some(&first.digest), true)
            .await
            .unwrap();
        assert_eq!(document(&f, "a").lifecycle.trust, DocumentTrust::Verified);
        f.advance(3600);
        f.store
            .write(
                Scope::Repository,
                "a",
                &claimed.replace("Body\n", "Changed\n"),
                Some(&verified.digest),
                false,
            )
            .await
            .unwrap();
        let changed = document(&f, "a");
        assert_eq!(changed.lifecycle.trust, DocumentTrust::Unverified);
        assert_ne!(changed.source.content_hash, verified.digest);
    }
    #[tokio::test]
    async fn projection_is_deterministic_and_skips_unreadable_files() {
        let f = Fixture::new();
        f.write("b", &note("Second distinct words here")).await;
        f.write("a", &note("First unrelated vocabulary there"))
            .await;
        fs::write(f.root().join("broken.md"), "no frontmatter").unwrap();
        let first = documents(&f);
        assert_eq!(first, documents(&f));
        assert_eq!(
            first.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
    }
}

mod experiences {
    use super::*;
    use ycoding_core::resources::recall::document::Trust as DocumentTrust;

    async fn record(
        f: &Fixture,
        experience: &Experience,
    ) -> ycoding_core::resources::memory::WriteResult {
        f.store
            .record_experience(
                Scope::Repository,
                &experience::id(experience),
                experience,
                None,
            )
            .await
            .unwrap()
    }
    async fn rejects(f: &Fixture, content: &str, reason: &str) {
        match f.reject("experiences/probe", content).await {
            Error::Rejected(found) => assert_eq!(found, reason, "{content}"),
            other => panic!("expected {reason}, got {other}"),
        }
    }

    #[tokio::test]
    async fn recording_writes_a_canonical_unverified_concept() {
        let f = Fixture::new();
        let sample = sample_experience();
        let written = record(&f, &sample).await;
        assert!(written.created);
        assert_eq!(written.id, experience::id(&sample));
        assert!(written.id.starts_with("experiences/cargo-test-exits"));
        assert!(written.id.ends_with("-failure"));
        let summary = f.summary(&written.id);
        assert_eq!(summary.meta.type_, "Experience");
        assert_eq!(summary.meta.trust(), Trust::Unverified);
        assert!(summary.meta.verified.is_empty());
        assert!(
            summary
                .meta
                .generated
                .as_ref()
                .is_some_and(|generated| generated.by.starts_with("ycoding/"))
        );
        let content = f.read(&written.id);
        for expected in [
            "x-ycoding-cue:",
            "x-ycoding-lesson:",
            "x-ycoding-applicability:",
            "x-ycoding-outcome: failure",
            "x-ycoding-confidence: \"0.8\"",
            "x-ycoding-harness-change:",
            "# Evidence",
            "[^e1]: Build notes",
        ] {
            assert!(content.contains(expected), "{expected}\n{content}");
        }
        assert!(
            written
                .diagnostics
                .iter()
                .all(|d| !d.code.starts_with("Y30"))
        );
    }
    #[tokio::test]
    async fn rerecording_is_idempotent_and_variants_report_the_existing_concept() {
        let f = Fixture::new();
        let sample = sample_experience();
        let first = record(&f, &sample).await;
        let again = record(&f, &sample).await;
        assert_eq!(again.digest, first.digest);
        assert!(again.duplicate_of.is_none());
        let mut variant = sample.clone();
        variant.lesson =
            "Delete the lock file instead, because the linker caches nothing else.".into();
        let reported = f
            .store
            .write(
                Scope::Repository,
                "experiences/variant",
                &experience::render(&variant),
                None,
                false,
            )
            .await
            .unwrap();
        assert_eq!(reported.duplicate_of.as_deref(), Some(first.id.as_str()));
        let mut success = sample.clone();
        success.outcome = Outcome::Success;
        success.lesson =
            "Pinning the toolchain release resolves the mismatch without any cleanup.".into();
        let other = record(&f, &success).await;
        assert!(other.created && other.duplicate_of.is_none());
        assert_ne!(other.id, first.id);
    }
    #[tokio::test]
    async fn confidence_and_evidence_never_create_verification() {
        let f = Fixture::new();
        let mut sample = sample_experience();
        sample.confidence = 1.0;
        let written = record(&f, &sample).await;
        assert_eq!(f.summary(&written.id).meta.trust(), Trust::Unverified);
        let at = f.now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let machine = experience::render(&sample).replacen(
            "x-ycoding-cue:",
            &format!("verified:\n  - by: ycoding/0.1\n    at: \"{at}\"\nx-ycoding-cue:"),
            1,
        );
        rejects(&f, &machine, "verified-requires-evidence").await;
        let human = machine.replace("ycoding/0.1", "human:alice");
        rejects(&f, &human, "verified-requires-evidence").await;
        let g = Fixture::new();
        let confirmed = g
            .store
            .write(
                Scope::Repository,
                "experiences/confirmed",
                &human,
                None,
                true,
            )
            .await
            .unwrap();
        assert_eq!(g.summary(&confirmed.id).meta.trust(), Trust::HumanReviewed);
    }
    #[tokio::test]
    async fn structural_rules_reject_incomplete_or_transient_experiences() {
        let f = Fixture::new();
        let good = experience::render(&sample_experience());
        rejects(
            &f,
            &drop_line(&good, "x-ycoding-cue:"),
            "experience-cue-invalid",
        )
        .await;
        rejects(
            &f,
            &replace_line(
                &good,
                "x-ycoding-cue:",
                "x-ycoding-cue: |\n  first\n  second",
            ),
            "experience-cue-invalid",
        )
        .await;
        rejects(
            &f,
            &drop_line(&good, "x-ycoding-lesson:"),
            "experience-lesson-invalid",
        )
        .await;
        rejects(
            &f,
            &drop_line(&good, "x-ycoding-applicability:"),
            "experience-applicability-invalid",
        )
        .await;
        for outcome in ["maybe", "Success", "\"\""] {
            rejects(
                &f,
                &replace_line(
                    &good,
                    "x-ycoding-outcome:",
                    &format!("x-ycoding-outcome: {outcome}"),
                ),
                "experience-outcome-invalid",
            )
            .await;
        }
        rejects(
            &f,
            &drop_line(&good, "x-ycoding-outcome:"),
            "experience-outcome-invalid",
        )
        .await;
        for confidence in ["\"1.5\"", "-0.1", "high", ".nan", "\"\""] {
            rejects(
                &f,
                &replace_line(
                    &good,
                    "x-ycoding-confidence:",
                    &format!("x-ycoding-confidence: {confidence}"),
                ),
                "experience-confidence-invalid",
            )
            .await;
        }
        rejects(
            &f,
            &drop_line(&good, "x-ycoding-confidence:"),
            "experience-confidence-invalid",
        )
        .await;
        for change in ["\"two words\"", "42", "[a, b]"] {
            rejects(
                &f,
                &replace_line(
                    &good,
                    "x-ycoding-harness-change:",
                    &format!("x-ycoding-harness-change: {change}"),
                ),
                "experience-harness-change-invalid",
            )
            .await;
        }
        let mut long = sample_experience();
        long.lesson = "x".repeat(601);
        rejects(&f, &experience::render(&long), "experience-lesson-invalid").await;
        let mut none = sample_experience();
        none.evidence.clear();
        rejects(
            &f,
            &experience::render(&none),
            "experience-evidence-missing",
        )
        .await;
        for resource in [
            "file:///etc/passwd",
            "relative/path.md",
            "has space",
            "/no-extension",
        ] {
            let mut bad = sample_experience();
            bad.evidence[0].resource = resource.into();
            rejects(&f, &experience::render(&bad), "experience-evidence-invalid").await;
        }
        let mut many = sample_experience();
        many.evidence = (0..9)
            .map(|n| Evidence {
                resource: format!("https://example.com/{n}"),
                title: format!("Source {n}"),
            })
            .collect();
        rejects(
            &f,
            &experience::render(&many),
            "experience-evidence-invalid",
        )
        .await;
        rejects(
            &f,
            &format!("{good}\nuser: please fix it\nassistant: done\n"),
            "experience-transcript",
        )
        .await;
        rejects(
            &f,
            &format!("{good}\n{}\n", "padding ".repeat(600)),
            "experience-body-too-long",
        )
        .await;
        rejects(
            &f,
            &drop_line(&good, "x-ycoding-cue:").replace("type: Experience", "type: experience"),
            "experience-cue-invalid",
        )
        .await;
    }
    #[tokio::test]
    async fn experiences_project_cue_and_harness_change_into_retrieval_documents() {
        let f = Fixture::new();
        let sample = sample_experience();
        let written = record(&f, &sample).await;
        let document = f
            .store
            .documents(Scope::Repository)
            .unwrap()
            .into_iter()
            .find(|document| document.id == written.id)
            .unwrap();
        assert_eq!(document.fields.doc_type, "Experience");
        assert!(document.fields.keywords.contains(&sample.cue));
        assert!(
            document
                .fields
                .identifiers
                .contains(&"repo:///rust/config/build.toml".to_owned())
        );
        assert!(
            document
                .fields
                .body
                .contains("Clear the stale incremental build output")
        );
        assert_eq!(document.lifecycle.trust, DocumentTrust::Unverified);
        assert!(document.lifecycle.eligible(START));
    }
}

mod v03 {
    use super::*;
    use ycoding_core::resources::{
        memory::okf::Level,
        recall::document::{Document, Trust as DocumentTrust},
    };

    const EARLY: &str = "2026-10-01T00:00:00Z";
    const MIDDLE: &str = "2026-10-15T00:00:00Z";
    const LATE: &str = "2026-11-01T00:00:00Z";

    fn place(f: &Fixture, relative: &str, content: &str) {
        let path = f.root().join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
    fn declare(f: &Fixture, version: &str) {
        place(
            f,
            "index.md",
            &format!("---\nokf_version: \"{version}\"\n---\n"),
        );
    }
    fn trust(f: &Fixture, id: &str) -> Trust {
        f.summary(id).signals.trust
    }
    fn stale_review(f: &Fixture, id: &str) -> bool {
        f.summary(id).signals.verification_older_than_content
    }
    fn document(f: &Fixture, id: &str) -> Document {
        f.store
            .documents(Scope::Repository)
            .unwrap()
            .into_iter()
            .find(|document| document.id == id)
            .unwrap_or_else(|| panic!("{id} has no document"))
    }
    fn codes(f: &Fixture, id: &str) -> Vec<&'static str> {
        f.store
            .review(Scope::Repository)
            .unwrap()
            .findings
            .into_iter()
            .filter(|(path, _)| path == &format!("{id}.md"))
            .map(|(_, found)| found.code)
            .collect()
    }
    fn verified(events: &[(&str, &str)]) -> String {
        events
            .iter()
            .map(|(by, at)| format!("  - by: {by}\n    at: \"{at}\"\n"))
            .collect::<String>()
    }
    fn concept(generated: Option<&str>, events: &[(&str, &str)]) -> String {
        let mut text = "---\ntype: Note\n".to_owned();
        if let Some(at) = generated {
            text += &format!("generated: {{ by: \"ycoding/0.1\", at: \"{at}\" }}\n");
        }
        if !events.is_empty() {
            text += &format!("verified:\n{}", verified(events));
        }
        text + "---\nBody\n"
    }

    #[tokio::test]
    async fn declared_v03_bundles_ignore_the_legacy_timestamp() {
        let f = Fixture::new();
        declare(&f, "0.3");
        place(
            &f,
            "a.md",
            &format!(
                "---\ntype: Note\ntimestamp: \"{MIDDLE}\"\nverified:\n{}---\nBody\n",
                verified(&[("human:alice", EARLY)])
            ),
        );
        let signals = f.summary("a").signals;
        assert_eq!(signals.generated_at, None);
        assert!(!signals.verification_older_than_content);
        assert_eq!(signals.trust, Trust::HumanReviewed);
        let projected = document(&f, "a");
        assert_eq!(projected.lifecycle.trust, DocumentTrust::Verified);
        assert_eq!(projected.source.revision, projected.source.content_hash);
    }
    #[tokio::test]
    async fn eligible_legacy_bundles_keep_the_legacy_timestamp() {
        for version in [None, Some("0.2"), Some("0.1")] {
            let f = Fixture::new();
            if let Some(version) = version {
                declare(&f, version);
            }
            place(
                &f,
                "a.md",
                &format!(
                    "---\ntype: Note\ntimestamp: \"{MIDDLE}\"\nverified:\n{}---\nBody\n",
                    verified(&[("human:alice", EARLY)])
                ),
            );
            let signals = f.summary("a").signals;
            assert_eq!(
                signals.generated_at,
                Some(Utc.with_ymd_and_hms(2026, 10, 15, 0, 0, 0).unwrap()),
                "{version:?}"
            );
            assert!(signals.verification_older_than_content, "{version:?}");
            assert_eq!(signals.trust, Trust::Unverified, "{version:?}");
            assert!(document(&f, "a").source.revision.starts_with("2026-10-15"));
        }
    }
    #[tokio::test]
    async fn generated_always_wins_over_the_legacy_timestamp() {
        let f = Fixture::new();
        place(
            &f,
            "a.md",
            &format!(
                "---\ntype: Note\ntimestamp: \"{LATE}\"\ngenerated: {{ by: \"ycoding/0.1\", at: \"{EARLY}\" }}\nverified:\n{}---\nBody\n",
                verified(&[("human:alice", MIDDLE)])
            ),
        );
        assert_eq!(trust(&f, "a"), Trust::HumanReviewed);
    }

    #[tokio::test]
    async fn trust_comes_only_from_current_verification_events() {
        let f = Fixture::new();
        declare(&f, "0.3");
        place(&f, "none.md", &concept(Some(MIDDLE), &[]));
        place(
            &f,
            "stale-human.md",
            &concept(Some(LATE), &[("human:alice", MIDDLE)]),
        );
        place(
            &f,
            "machine.md",
            &concept(Some(MIDDLE), &[("ci/1.0", LATE)]),
        );
        place(
            &f,
            "human.md",
            &concept(Some(MIDDLE), &[("human:alice", LATE)]),
        );
        place(
            &f,
            "both.md",
            &concept(Some(MIDDLE), &[("ci/1.0", LATE), ("human:alice", LATE)]),
        );
        place(
            &f,
            "machine-over-stale-human.md",
            &concept(Some(MIDDLE), &[("human:alice", EARLY), ("ci/1.0", LATE)]),
        );
        place(
            &f,
            "same-instant.md",
            &concept(Some(MIDDLE), &[("human:alice", MIDDLE)]),
        );
        place(
            &f,
            "no-generated-human.md",
            &concept(None, &[("human:alice", EARLY)]),
        );
        place(
            &f,
            "no-generated-machine.md",
            &concept(None, &[("ci/1.0", EARLY)]),
        );
        place(&f, "no-generated-none.md", &concept(None, &[]));
        for (id, tier, older) in [
            ("none", Trust::Unverified, false),
            ("stale-human", Trust::Unverified, true),
            ("machine", Trust::MachineConfirmed, false),
            ("human", Trust::HumanReviewed, false),
            ("both", Trust::HumanReviewed, false),
            ("machine-over-stale-human", Trust::MachineConfirmed, false),
            ("same-instant", Trust::HumanReviewed, false),
            ("no-generated-human", Trust::HumanReviewed, false),
            ("no-generated-machine", Trust::MachineConfirmed, false),
            ("no-generated-none", Trust::Unverified, false),
        ] {
            assert_eq!(trust(&f, id), tier, "{id}");
            assert_eq!(stale_review(&f, id), older, "{id}");
            assert_eq!(
                document(&f, id).lifecycle.trust,
                if tier == Trust::Unverified {
                    DocumentTrust::Unverified
                } else {
                    DocumentTrust::Verified
                },
                "{id}"
            );
            assert!(
                document(&f, id).lifecycle.eligible(START),
                "trust is advisory: {id}"
            );
        }
    }

    #[tokio::test]
    async fn file_relative_and_bundle_root_links_and_path_fields_both_resolve() {
        let f = Fixture::new();
        f.write(
            "ops/target",
            &note("Target words with their own vocabulary"),
        )
        .await;
        f.write("top", &note("Top level words in a different vocabulary"))
            .await;
        let written = f
            .write(
                "ops/a",
                "---\ntype: Note\nresource: ../top.md\nsources:\n  - id: s1\n    resource: /ops/target.md\n---\nBare [one](target.md), parent [two](../top.md), root [three](/top.md).[^s1]\n\n[^s1]: Source.\n",
            )
            .await;
        assert!(
            written
                .diagnostics
                .iter()
                .all(|d| !matches!(d.code, "W115" | "W116")),
            "{:?}",
            written.diagnostics
        );
        assert_eq!(
            document(&f, "ops/a").fields.relationships,
            ["ops/target", "top"]
        );
        assert!(
            codes(&f, "ops/a")
                .iter()
                .all(|c| !matches!(*c, "W115" | "W116"))
        );
    }
    #[tokio::test]
    async fn unresolved_links_and_path_fields_are_warnings_never_rejections() {
        let f = Fixture::new();
        let written = f
            .write(
                "a",
                "---\ntype: Note\nresource: nowhere.md\nsuperseded_by: gone.md\n---\nMissing [m](missing.md), above-root [o](../../x.md), anchor [h](#top), external [e](https://example.com/x) and [mail](mailto:a@example.com).\n",
            )
            .await;
        let codes = written
            .diagnostics
            .iter()
            .map(|d| d.code)
            .collect::<Vec<_>>();
        assert!(
            codes.contains(&"W115") && codes.contains(&"W116"),
            "{codes:?}"
        );
        assert!(
            written.diagnostics.iter().all(|d| d.level != Level::Error),
            "{:?}",
            written.diagnostics
        );
        assert!(document(&f, "a").fields.relationships.is_empty());
        assert_eq!(f.summary("a").id, "a");
    }

    #[tokio::test]
    async fn legacy_fallback_resolves_only_eligible_legacy_inputs() {
        let content = "---\ntype: Note\nsuperseded_by: target.md\nstatus: deprecated\n---\nBody [l](target.md)\n";
        for (version, eligible) in [
            (None, true),
            (Some("0.2"), true),
            (Some("0.3"), false),
            (Some("1.0"), false),
            (Some("unknown"), false),
        ] {
            let f = Fixture::new();
            if let Some(version) = version {
                declare(&f, version);
            }
            place(
                &f,
                "target.md",
                &note("Target words with their own vocabulary"),
            );
            place(&f, "ops/a.md", content);
            let found = codes(&f, "ops/a");
            assert_eq!(found.contains(&"W119"), eligible, "{version:?}: {found:?}");
            assert_eq!(found.contains(&"W116"), !eligible, "{version:?}: {found:?}");
            assert!(
                found.contains(&"W115"),
                "links never fall back: {version:?}"
            );
            assert_eq!(
                document(&f, "ops/a").lifecycle.superseded_by.as_deref(),
                Some(if eligible { "target" } else { "ops/target" }),
                "{version:?}"
            );
        }
    }

    #[tokio::test]
    async fn no_read_or_write_escapes_the_bundle_root() {
        let f = Fixture::new();
        f.write("inside", &note("Inside words only")).await;
        let outside = f.path.join("outside.md");
        fs::write(&outside, note("Outside bytes")).unwrap();
        for id in [
            "../outside",
            "a/../../outside",
            "/outside",
            "..",
            "a/./b",
            ".hidden",
            "a\\b",
            "inside/../../outside",
        ] {
            assert!(
                matches!(
                    f.store
                        .write(Scope::Repository, id, &note("Escape attempt"), None, false)
                        .await,
                    Err(Error::UnsafePath)
                ),
                "write {id}"
            );
            assert!(
                matches!(f.store.read(Scope::Repository, id), Err(Error::UnsafePath)),
                "read {id}"
            );
        }
        assert_eq!(fs::read_to_string(&outside).unwrap(), note("Outside bytes"));
        let escaping = f
            .write(
                "b",
                "---\ntype: Note\nresource: ../../outside.md\n---\n[o](../../outside.md)\n",
            )
            .await;
        assert!(escaping.diagnostics.iter().any(|d| d.code == "W116"));
        assert!(document(&f, "b").fields.relationships.is_empty());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn symlinks_never_carry_a_read_or_write_out_of_the_bundle() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        f.write("inside", &note("Inside words only")).await;
        let elsewhere = f.path.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::write(elsewhere.join("secret.md"), note("Secret words elsewhere")).unwrap();
        symlink(&elsewhere, f.root().join("linkdir")).unwrap();
        symlink(elsewhere.join("secret.md"), f.root().join("linkfile.md")).unwrap();
        for id in ["linkdir/secret", "linkdir/new", "linkfile"] {
            assert!(
                f.store
                    .write(
                        Scope::Repository,
                        id,
                        &note("Through the link"),
                        None,
                        false
                    )
                    .await
                    .is_err(),
                "write {id}"
            );
            assert!(f.store.read(Scope::Repository, id).is_err(), "read {id}");
        }
        assert!(!elsewhere.join("new.md").exists());
        assert_eq!(
            fs::read_to_string(elsewhere.join("secret.md")).unwrap(),
            note("Secret words elsewhere")
        );
        let listing = f.store.list(Scope::Repository, None, None).unwrap();
        assert_eq!(
            listing
                .concepts
                .iter()
                .map(|c| c.id.as_str())
                .collect::<Vec<_>>(),
            ["inside"]
        );
        let warned = listing
            .warnings
            .iter()
            .filter(|w| w.code == "unsafe-link")
            .count();
        assert_eq!(warned, 2);
        assert_eq!(
            document(&f, "inside").fields.relationships,
            Vec::<String>::new()
        );
    }

    #[tokio::test]
    async fn plain_markdown_reference_files_are_not_concepts_and_stay_untouched() {
        let f = Fixture::new();
        let guide = "# Guide\n\nPlain Markdown with no frontmatter and a [link](other.md).\n";
        let skill = "---\nname: example\ndescription: A skill file with its own frontmatter\n---\n# Skill\n";
        place(&f, "references/guide.md", guide);
        place(&f, "references/SKILL.md", skill);
        f.write(
            "ops/runbook",
            &note("Runbook words with a distinct vocabulary"),
        )
        .await;
        let listing = f.store.list(Scope::Repository, None, None).unwrap();
        assert_eq!(
            listing
                .concepts
                .iter()
                .map(|c| c.id.as_str())
                .collect::<Vec<_>>(),
            ["ops/runbook"]
        );
        assert_eq!(
            listing
                .warnings
                .iter()
                .map(|w| (w.id.as_str(), w.code.as_str()))
                .collect::<Vec<_>>(),
            [
                ("references/SKILL", "not-a-concept"),
                ("references/guide", "not-a-concept")
            ]
        );
        assert_eq!(
            fs::read_to_string(f.root().join("references/guide.md")).unwrap(),
            guide
        );
        assert_eq!(
            fs::read_to_string(f.root().join("references/SKILL.md")).unwrap(),
            skill
        );
        assert!(!f.root().join("references/index.md").exists());
        assert!(
            !fs::read_to_string(f.root().join("index.md"))
                .unwrap()
                .contains("references")
        );
        assert!(
            f.store
                .documents(Scope::Repository)
                .unwrap()
                .iter()
                .all(|d| !d.id.starts_with("references/"))
        );
    }
}

mod appendix_a {
    use super::*;
    use ycoding_core::resources::memory::{format, okf};

    const SPEC_PIN: &str = "527e81aff55992be21507e97004286789126f88c";
    const REVENUE: &str = "computations/revenue";
    const PROFIT: &str = "computations/profit";
    const METRIC: &str = "metrics/income-statement";

    fn fixture_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/okf_appendix_a")
    }
    fn copy_tree(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for entry in fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_tree(&entry.path(), &target);
            } else {
                fs::copy(entry.path(), target).unwrap();
            }
        }
    }
    fn installed() -> Fixture {
        let f = Fixture::new();
        copy_tree(&fixture_root().join("bundle"), &f.root());
        f
    }
    fn original(name: &str) -> String {
        fs::read_to_string(fixture_root().join("bundle").join(name)).unwrap()
    }
    fn findings(f: &Fixture) -> Vec<(String, okf::Diagnostic)> {
        f.store.review(Scope::Repository).unwrap().findings
    }
    fn concept(f: &Fixture, id: &str) -> format::Concept {
        format::parse(id, &f.read(id), f.now()).unwrap()
    }

    #[tokio::test]
    async fn the_appendix_a_bundle_validates_with_no_errors_and_no_schema_findings() {
        let f = installed();
        let found = findings(&f);
        assert!(
            found
                .iter()
                .all(|(_, d)| d.level != okf::Level::Error && !d.code.starts_with('S')),
            "{found:?}"
        );
        let (root, version, license) = okf::root_index(&original("index.md"));
        assert!(root.is_empty(), "{root:?}");
        assert_eq!(version.as_deref(), Some("0.3"));
        assert_eq!(license.as_deref(), Some("CC-BY-4.0"));
        assert_eq!(
            f.store.list(Scope::Repository, None, None).unwrap().total,
            3
        );
    }
    #[tokio::test]
    async fn the_metric_links_both_attested_computations() {
        let f = installed();
        let metric = f
            .store
            .documents(Scope::Repository)
            .unwrap()
            .into_iter()
            .find(|d| d.id == METRIC)
            .unwrap();
        assert_eq!(metric.fields.doc_type, "Metric");
        assert_eq!(metric.fields.relationships, [PROFIT, REVENUE]);
        assert!(
            findings(&f)
                .iter()
                .all(|(_, d)| !matches!(d.code, "W115" | "W116")),
            "executor, attester and link targets all resolve"
        );
    }
    #[tokio::test]
    async fn trust_freshness_and_attestation_follow_the_spec_table() {
        let f = installed();
        let table = [
            (METRIC, Trust::HumanReviewed, false, false),
            (REVENUE, Trust::HumanReviewed, false, true),
            (PROFIT, Trust::MachineConfirmed, true, true),
        ];
        for (id, tier, stale, attestable) in table {
            let signals = f.summary(id).signals;
            assert_eq!(signals.trust, tier, "{id}");
            assert_eq!(signals.stale, stale, "{id}");
            assert_eq!(signals.attestable, attestable, "{id}");
        }
    }
    #[tokio::test]
    async fn the_verified_singleton_sources_usage_window_and_parameters_parse_intact() {
        let f = installed();
        let revenue = concept(&f, REVENUE);
        assert!(matches!(
            revenue.doc.yaml["verified"],
            yaml_rust2::Yaml::Hash(_)
        ));
        assert_eq!(revenue.summary.meta.verified.len(), 1);
        assert_eq!(revenue.summary.meta.verified[0].by, "human:ahormati");
        assert_eq!(revenue.summary.meta.sources.len(), 2);
        assert_eq!(
            revenue.summary.meta.sources[1].id.as_deref(),
            Some("exec-rev-dash")
        );
        assert_eq!(
            revenue.summary.meta.sources[1].author.as_deref(),
            Some("team:finance-fpa")
        );
        assert_eq!(
            revenue.doc.yaml["sources"][1]["usage_count"].as_i64(),
            Some(5000)
        );
        assert_eq!(
            revenue.doc.yaml["usage_window"]["from"].as_str(),
            Some("2026-06-01T00:00:00Z")
        );
        assert_eq!(
            revenue.doc.yaml["parameters"][0]["name"].as_str(),
            Some("year")
        );
        assert_eq!(
            revenue.doc.yaml["parameters"][0]["type"].as_str(),
            Some("integer")
        );
        assert_eq!(
            revenue.doc.yaml["parameters"][0]["required"].as_bool(),
            Some(true)
        );
        let profit = concept(&f, PROFIT);
        assert_eq!(
            profit.doc.yaml["parameters"].as_vec().map(Vec::len),
            Some(2)
        );
        assert_eq!(
            profit.doc.yaml["parameters"][1]["name"].as_str(),
            Some("segment")
        );
        assert_eq!(
            profit.summary.meta.verified[0].by,
            "process:finance-nightly"
        );
    }
    #[tokio::test]
    async fn read_and_identical_write_preserve_every_byte() {
        let f = installed();
        for id in [METRIC, REVENUE, PROFIT] {
            let name = format!("{id}.md");
            assert_eq!(f.read(id), original(&name), "{id}");
            let digest = f.summary(id).digest;
            let again = f
                .store
                .write(Scope::Repository, id, &original(&name), Some(&digest), true)
                .await
                .unwrap();
            assert!(!again.created && again.duplicate_of.is_none(), "{id}");
            assert_eq!(again.digest, digest, "{id}");
            assert_eq!(f.read(id), original(&name), "{id}");
        }
    }
    #[tokio::test]
    async fn supersede_changes_only_the_lifecycle_keys() {
        let f = installed();
        let digest = f.summary(REVENUE).digest;
        f.store
            .supersede(Scope::Repository, REVENUE, Some(PROFIT), &digest)
            .await
            .unwrap();
        let before = original("computations/revenue.md");
        let after = f.read(REVENUE);
        let kept = before
            .lines()
            .filter(|line| *line != "status: stable")
            .collect::<Vec<_>>();
        for line in &kept {
            assert!(after.lines().any(|found| found == *line), "lost: {line}");
        }
        assert!(after.contains("status: deprecated"));
        assert!(after.contains("superseded_by"));
        assert!(
            after.contains("verified: { by: \"human:ahormati\", at: \"2026-06-25T09:00:00Z\" }")
        );
        assert!(after.contains(
            "usage_window: { from: \"2026-06-01T00:00:00Z\", to: \"2026-06-30T00:00:00Z\" }"
        ));
    }
    #[tokio::test]
    async fn a_content_edit_keeps_the_family_lines_and_drops_the_stale_trust() {
        let f = installed();
        let before = original("computations/profit.md");
        let edited = before.replace(
            "Gross profit by segment per the cost-allocation standard.",
            "Gross profit by segment per the cost-allocation standard, reviewed again.",
        );
        assert_ne!(before, edited);
        let digest = f.summary(PROFIT).digest;
        f.store
            .write(Scope::Repository, PROFIT, &edited, Some(&digest), false)
            .await
            .unwrap();
        let after = f.read(PROFIT);
        for line in before.lines().filter(|line| {
            line.starts_with("verified:")
                || line.starts_with("  - { name")
                || line.starts_with("  receipt")
                || line.starts_with("    resource")
                || line.starts_with("  - id")
                || line.starts_with("stale_after")
        }) {
            assert!(after.lines().any(|found| found == line), "lost: {line}");
        }
        assert!(after.contains("reviewed again"));
        assert!(!after.contains("2026-06-10T14:00:00Z"));
        let signals = f.summary(PROFIT).signals;
        assert_eq!(signals.trust, Trust::Unverified);
        assert!(signals.verification_older_than_content);
    }
    #[tokio::test]
    async fn validation_never_executes_or_evaluates_the_example_computations() {
        let f = installed();
        let marker = f.path.join("EXECUTED");
        let script = format!("open(r\"{}\", \"w\").write(\"ran\")\n", marker.display());
        let attesters = f.root().join("references/attesters");
        for name in ["sql-equality.py", "dbt-binding.py"] {
            fs::write(attesters.join(name), &script).unwrap();
        }
        let sql_before = original("computations/profit.md");
        let _ = findings(&f);
        let _ = f.store.list(Scope::Repository, None, None).unwrap();
        let _ = f.store.documents(Scope::Repository).unwrap();
        let _ = f.read(REVENUE);
        let digest = f.summary(REVENUE).digest;
        f.store
            .supersede(Scope::Repository, REVENUE, None, &digest)
            .await
            .unwrap();
        assert!(!marker.exists(), "a computation or attester ran");
        for name in ["sql-equality.py", "dbt-binding.py"] {
            assert_eq!(fs::read_to_string(attesters.join(name)).unwrap(), script);
        }
        assert_eq!(f.read(PROFIT), sql_before);
        assert!(f.summary(PROFIT).signals.attestable);
    }
    #[tokio::test]
    async fn fixture_only_fields_are_neither_required_nor_defaulted() {
        let f = Fixture::new();
        f.write("plain", "---\ntype: Note\n---\nOnly a type and a body.\n")
            .await;
        let found = findings(&f);
        assert!(
            found
                .iter()
                .all(|(_, d)| d.level != okf::Level::Error && !d.code.starts_with('S')),
            "{found:?}"
        );
        let root_index = fs::read_to_string(f.root().join("index.md")).unwrap();
        for forbidden in [
            "license",
            "CC-BY",
            "usage_window",
            "human:ahormati",
            "finance",
        ] {
            assert!(!root_index.contains(forbidden), "{forbidden}");
        }
        for kind in templates::kinds() {
            let skeleton = templates::skeleton(templates::by_kind(kind).unwrap());
            for forbidden in [
                "usage_window",
                "human:ahormati",
                "process:finance",
                "license",
            ] {
                assert!(!skeleton.contains(forbidden), "{kind}: {forbidden}");
            }
        }
        let written = fs::read_to_string(f.root().join("plain.md")).unwrap();
        assert!(!written.contains("verified") && !written.contains("sources"));
    }
    #[test]
    fn the_fixture_matches_the_pinned_spec_text_when_the_spec_is_available() {
        let source = fs::read_to_string(fixture_root().join("SOURCE.txt")).unwrap();
        assert!(source.contains(SPEC_PIN));
        let Some(spec) = std::env::var_os("YCODING_OKF_SPEC") else {
            return;
        };
        let spec = fs::read_to_string(spec).unwrap();
        for name in [
            "index.md",
            "metrics/income-statement.md",
            "computations/revenue.md",
            "computations/profit.md",
        ] {
            assert!(spec.contains(original(name).trim_end()), "{name}");
        }
    }
}

mod content_schema {
    use super::*;
    use ycoding_core::resources::memory::okf::{Diagnostic, Level};

    fn place(f: &Fixture, relative: &str, content: &str) {
        let path = f.root().join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
    fn declared(f: &Fixture) {
        place(f, "index.md", "---\nokf_version: \"0.3\"\n---\n");
    }
    fn schema_findings(f: &Fixture, id: &str) -> Vec<Diagnostic> {
        f.store
            .review(Scope::Repository)
            .unwrap()
            .findings
            .into_iter()
            .filter(|(path, found)| path == id && found.code.starts_with('S'))
            .map(|(_, found)| found)
            .collect()
    }

    #[tokio::test]
    async fn a_conformant_bundle_has_no_schema_findings() {
        let f = Fixture::new();
        f.write(
            "ops/runbook",
            "---\ntype: Procedure\ntitle: Roll back\ntags: [ops]\nsources:\n  - id: s1\n    resource: https://example.com/r\n    title: Runbook\n---\nRevert.[^s1]\n\n[^s1]: Runbook.\n",
        )
        .await;
        let sample = sample_experience();
        f.store
            .record_experience(Scope::Repository, &experience::id(&sample), &sample, None)
            .await
            .unwrap();
        let review = f.store.review(Scope::Repository).unwrap();
        assert!(
            review
                .findings
                .iter()
                .all(|(_, d)| !d.code.starts_with('S')),
            "{:?}",
            review.findings
        );
    }
    #[tokio::test]
    async fn malformed_content_under_a_declared_v03_index_is_reported_by_field() {
        let f = Fixture::new();
        declared(&f);
        let cases: [(&str, &str, &str, Level); 14] = [
            (
                "sources",
                "sources:\n  - title: no resource\n",
                "sources[0].resource",
                Level::Error,
            ),
            (
                "verified",
                "verified:\n  - by: \"human:a\"\n",
                "verified[0].at",
                Level::Error,
            ),
            ("generated", "generated: text\n", "generated", Level::Error),
            ("title", "title: 123\n", "title", Level::Error),
            ("tags", "tags: [1]\n", "tags[0]", Level::Error),
            (
                "stale",
                "stale_after: tomorrow\n",
                "stale_after",
                Level::Error,
            ),
            ("status", "status: frozen\n", "status", Level::Warning),
            (
                "actor",
                "generated: { by: no actor here, at: \"2026-10-01T00:00:00Z\" }\n",
                "generated.by",
                Level::Warning,
            ),
            (
                "window",
                "usage_window: { from: \"2026-10-01T00:00:00Z\" }\n",
                "usage_window.to",
                Level::Error,
            ),
            (
                "parameters",
                "parameters:\n  - { name: year }\n",
                "parameters[0].type",
                Level::Error,
            ),
            (
                "executor",
                "executor: {}\n",
                "executor.resource",
                Level::Error,
            ),
            (
                "attester",
                "attester: { receipt: [a] }\n",
                "attester.resource",
                Level::Error,
            ),
            (
                "count",
                "sources:\n  - { resource: \"https://example.com/a\", usage_count: -1 }\n",
                "sources[0].usage_count",
                Level::Warning,
            ),
            (
                "window-type",
                "usage_window: nope\n",
                "usage_window",
                Level::Error,
            ),
        ];
        for (id, extra, path, level) in cases {
            place(
                &f,
                &format!("{id}.md"),
                &format!("---\ntype: Note\n{extra}---\nBody\n"),
            );
            let found = schema_findings(&f, &format!("{id}.md"));
            let hit = found
                .iter()
                .find(|d| d.message.starts_with(&format!("{path} ")))
                .unwrap_or_else(|| panic!("{id}: no finding for {path}: {found:?}"));
            assert_eq!(hit.level, level, "{id}: {hit:?}");
            assert!(
                hit.message.contains("527e81a") && hit.message.contains("not official"),
                "{hit:?}"
            );
            assert!(!hit.message.contains("tomorrow"), "values are never quoted");
        }
        place(
            &f,
            "computation.md",
            "---\ntype: Attested Computation\n---\nBody\n",
        );
        let found = schema_findings(&f, "computation.md");
        assert!(
            found
                .iter()
                .any(|d| d.level == Level::Error && d.message.starts_with("runtime ")),
            "{found:?}"
        );
        let review = f.store.review(Scope::Repository).unwrap();
        assert!(review.findings.iter().any(|(_, d)| d.level == Level::Error));
        assert!(
            review
                .findings
                .iter()
                .filter(|(path, _)| path == "index.md")
                .all(|(_, d)| d.level != Level::Error),
            "the declared version itself is fine"
        );
    }
    #[tokio::test]
    async fn a_malformed_root_index_is_reported_by_field() {
        let f = Fixture::new();
        place(
            &f,
            "index.md",
            "---\nokf_version: 0.3\nlicense: [a, b]\ntitle: 7\n---\n",
        );
        place(&f, "a.md", "---\ntype: Note\n---\nBody\n");
        let found = schema_findings(&f, "index.md");
        for path in ["okf_version", "license", "title"] {
            assert!(
                found
                    .iter()
                    .any(|d| d.level == Level::Error && d.message.starts_with(&format!("{path} "))),
                "{path}: {found:?}"
            );
        }
    }

    #[test]
    fn the_compiled_in_schema_is_pinned_derived_and_never_official() {
        use ycoding_core::resources::memory::schema;
        let schema: serde_json::Value = serde_json::from_str(schema::SCHEMA_TEXT).unwrap();
        let derived = &schema["x-okf-derived-from"];
        assert_eq!(derived["commit"], schema::PINNED_COMMIT);
        assert_eq!(
            schema::PINNED_COMMIT,
            "527e81aff55992be21507e97004286789126f88c"
        );
        assert_eq!(derived["official"], false);
        assert_eq!(derived["spec_version"], "0.3");
        assert!(
            schema["title"]
                .as_str()
                .unwrap()
                .contains("derived, unofficial")
        );
        assert!(
            schema::unsupported_keywords().is_empty(),
            "{:?}",
            schema::unsupported_keywords()
        );
    }
    #[test]
    fn the_compiled_in_schema_matches_the_skill_package_when_it_is_installed() {
        use ycoding_core::resources::memory::schema;
        let Some(home) = std::env::var_os("HOME") else {
            return;
        };
        let packaged = PathBuf::from(home).join(
            ".agents/skills/okf-knowledge-bundle/assets/okf-v0.3-content.derived.schema.json",
        );
        let Ok(packaged) = fs::read_to_string(packaged) else {
            return;
        };
        assert_eq!(packaged, schema::SCHEMA_TEXT);
    }

    #[tokio::test]
    async fn optional_content_defects_never_reject_a_write() {
        let f = Fixture::new();
        let written = f
            .write(
                "a",
                "---\ntype: Note\ntitle: 123\nsources:\n  - title: no resource\nverified:\n  - by: human:x\n---\nBody\n",
            )
            .await;
        assert!(written.created);
        let found = written
            .diagnostics
            .iter()
            .filter(|d| d.code.starts_with('S'))
            .collect::<Vec<_>>();
        assert!(found.iter().any(|d| d.message.starts_with("title ")));
    }
}

mod acceptance {
    use super::*;
    use ycoding_core::resources::memory::okf::Level;

    fn place(f: &Fixture, relative: &str, content: &str) {
        let path = f.root().join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
    fn codes(f: &Fixture, id: &str) -> Vec<&'static str> {
        f.store
            .review(Scope::Repository)
            .unwrap()
            .findings
            .into_iter()
            .filter(|(path, _)| path == &format!("{id}.md"))
            .map(|(_, found)| found.code)
            .collect()
    }
    fn tree(root: &Path, found: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                tree(&path, found);
            } else {
                found.push(path);
            }
        }
    }

    #[tokio::test]
    async fn sources_and_claim_footnotes_are_read_preserved_and_validated() {
        let f = Fixture::new();
        let content = "---\ntype: Note\nsources:\n  - id: a\n    resource: https://example.com/a\n    title: Source A\n    author: \"team:docs\"\n    usage_count: 7\n    last_modified: \"2026-10-01T00:00:00Z\"\n  - id: b\n    resource: /other.md\nusage_window: { from: \"2026-10-01T00:00:00Z\", to: \"2026-10-31T00:00:00Z\" }\n---\nClaim one.[^a] Claim two.[^b]\n\n[^a]: Source A\n[^b]: Other\n";
        f.write("other", &note("Another concept with a distinct vocabulary"))
            .await;
        let written = f.write("n", content).await;
        assert!(
            written
                .diagnostics
                .iter()
                .all(|d| !matches!(d.code, "W107" | "W108" | "W115" | "W116")
                    && !d.code.starts_with('S')),
            "{:?}",
            written.diagnostics
        );
        let stored = f.read("n");
        for line in content.lines().filter(|line| !line.starts_with("---")) {
            assert!(stored.lines().any(|found| found == line), "lost: {line}");
        }
        let meta = f.summary("n").meta;
        assert_eq!(meta.sources.len(), 2);
        assert_eq!(meta.sources[0].id.as_deref(), Some("a"));
        assert_eq!(meta.sources[0].author.as_deref(), Some("team:docs"));
        assert_eq!(meta.sources[1].resource, "/other.md");
        let projected = f
            .store
            .documents(Scope::Repository)
            .unwrap()
            .into_iter()
            .find(|d| d.id == "n")
            .unwrap();
        assert!(
            projected
                .fields
                .identifiers
                .contains(&"https://example.com/a".to_owned())
        );
        assert!(projected.fields.relationships.contains(&"other".to_owned()));
        let defective = f
            .write(
                "m",
                "---\ntype: Note\nsources:\n  - id: a\n    resource: https://example.com/a\n  - id: a\n    resource: https://example.com/b\n  - title: no resource\n---\nUndeclared.[^zz]\n\n[^zz]: Missing\n",
            )
            .await;
        let found = defective
            .diagnostics
            .iter()
            .map(|d| d.code)
            .collect::<Vec<_>>();
        for code in ["W107", "W108", "S100"] {
            assert!(found.contains(&code), "{code}: {found:?}");
        }
        assert!(
            !found.contains(&"W115"),
            "a footnote definition is not a link: {found:?}"
        );
    }

    #[tokio::test]
    async fn historical_verification_is_kept_but_never_trusted() {
        let f = Fixture::new();
        let first = f.write("a", &note("Body")).await;
        let at = f.now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let claimed = format!(
            "---\ntype: Note\nverified:\n  - by: human:alice\n    at: \"{at}\"\n---\nBody\n"
        );
        let verified = f
            .store
            .write(Scope::Repository, "a", &claimed, Some(&first.digest), true)
            .await
            .unwrap();
        assert_eq!(f.summary("a").signals.trust, Trust::HumanReviewed);
        f.advance(86_400);
        let edited = claimed.replace("Body\n", "Changed body\n");
        let rewritten = f
            .store
            .write(
                Scope::Repository,
                "a",
                &edited,
                Some(&verified.digest),
                false,
            )
            .await
            .unwrap();
        let stored = f.read("a");
        assert!(stored.contains("human:alice"), "the event is kept");
        let signals = f.summary("a").signals;
        assert_eq!(signals.trust, Trust::Unverified);
        assert!(signals.verification_older_than_content);
        f.advance(3_600);
        let again = stored.replacen(
            "verified:\n",
            &format!(
                "verified:\n  - by: human:bob\n    at: \"{}\"\n",
                f.now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
            ),
            1,
        );
        f.store
            .write(
                Scope::Repository,
                "a",
                &again,
                Some(&rewritten.digest),
                true,
            )
            .await
            .unwrap();
        let after = f.summary("a");
        assert_eq!(after.signals.trust, Trust::HumanReviewed);
        assert_eq!(
            after.meta.verified.len(),
            2,
            "history stays alongside the current event"
        );
        assert_eq!(after.meta.current_verifications().len(), 1);
        assert_eq!(after.meta.current_verifications()[0].by, "human:bob");
    }

    #[tokio::test]
    async fn superseded_by_resolves_from_the_file_and_from_the_bundle_root() {
        let f = Fixture::new();
        f.write(
            "ops/new",
            &note("Replacement words in their own vocabulary"),
        )
        .await;
        f.write("top", &note("Another current concept with other words"))
            .await;
        for (id, target, expected) in [
            ("ops/old-relative", "new.md", Some("ops/new")),
            ("ops/old-parent", "../top.md", Some("top")),
            ("ops/old-root", "/ops/new.md", Some("ops/new")),
            ("ops/old-dangling", "gone.md", None),
        ] {
            f.write(
                id,
                &format!(
                    "---\ntype: Note\nstatus: deprecated\nsuperseded_by: {target}\n---\nOld {id} text\n"
                ),
            )
            .await;
            let signals = f.summary(id).signals;
            assert_eq!(signals.replacement.as_deref(), expected, "{id}");
            assert!(!signals.current, "{id}");
            let projected = f
                .store
                .documents(Scope::Repository)
                .unwrap()
                .into_iter()
                .find(|d| d.id == id)
                .unwrap();
            assert!(!projected.lifecycle.eligible(START), "{id}");
            assert!(
                projected.lifecycle.superseded_by.is_some(),
                "{id}: the marker stays even when unresolved"
            );
        }
        let dangling = codes(&f, "ops/old-dangling");
        assert!(dangling.contains(&"W116"), "{dangling:?}");
    }

    #[tokio::test]
    async fn machine_checks_are_never_human_and_no_human_review_is_fabricated() {
        let f = Fixture::new();
        let at = f.now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        for (by, reason) in [
            ("ci/1.0", "verified-requires-evidence"),
            ("agent:planner", "verified-requires-evidence"),
            ("Human:alice", "verified-requires-evidence"),
            (" human:alice", "verified-requires-evidence"),
        ] {
            let claimed = format!(
                "---\ntype: Note\nverified:\n  - by: \"{by}\"\n    at: \"{at}\"\n---\nBody\n"
            );
            assert!(
                matches!(f.reject("x", &claimed).await, Error::Rejected(found) if found == reason),
                "{by:?}"
            );
        }
        let spoofed = "---\ntype: Note\ngenerated: { by: \"human:alice\", at: \"2026-10-01T00:00:00Z\" }\n---\nBody\n";
        assert!(matches!(
            f.reject("y", spoofed).await,
            Error::Rejected("human-actor-unconfirmed")
        ));
        f.write("a", &note("First distinct body about deploys"))
            .await;
        let sample = sample_experience();
        f.store
            .record_experience(Scope::Repository, &experience::id(&sample), &sample, None)
            .await
            .unwrap();
        let digest = f.summary("a").digest;
        f.store
            .supersede(Scope::Repository, "a", None, &digest)
            .await
            .unwrap();
        f.write("b", &note("Second unrelated body about builds"))
            .await;
        let mut files = Vec::new();
        tree(&f.root(), &mut files);
        for file in files {
            let text = fs::read_to_string(&file).unwrap();
            assert!(!text.contains("human:"), "{}", file.display());
            if let Some(line) = text.lines().find(|line| line.starts_with("generated:")) {
                assert!(line.contains("ycoding/"), "{}: {line}", file.display());
            }
        }
        let g = Fixture::new();
        for (id, by, tier) in [
            ("machine", "ci/1.0", Trust::MachineConfirmed),
            ("lookalike", "bot/human:alice", Trust::MachineConfirmed),
            ("capitalised", "Human:alice", Trust::MachineConfirmed),
            ("human", "human:alice", Trust::HumanReviewed),
        ] {
            place(
                &g,
                &format!("{id}.md"),
                &format!(
                    "---\ntype: Note\nverified:\n  - by: \"{by}\"\n    at: \"2026-11-01T00:00:00Z\"\n---\nBody\n"
                ),
            );
            assert_eq!(g.summary(id).signals.trust, tier, "{id}");
        }
    }

    #[tokio::test]
    async fn a_regenerated_root_index_keeps_its_metadata_and_nested_indexes_list_their_children() {
        let f = Fixture::new();
        f.write("a", &note("Body words for the root")).await;
        let path = f.root().join("index.md");
        let original = fs::read_to_string(&path).unwrap();
        let edited = replace_line(&original, "title:", "title: Acme notes");
        let edited = replace_line(
            &edited,
            "description:",
            "description: Notes for the example bundle.",
        )
        .replacen("---\n", "---\nlicense: CC-BY-4.0\n", 1);
        fs::write(&path, &edited).unwrap();
        f.write(
            "ops/runbook",
            &note("Runbook words with their own vocabulary"),
        )
        .await;
        f.write("ops/deep/check", &note("Checklist words that differ again"))
            .await;
        let root = fs::read_to_string(&path).unwrap();
        for kept in [
            "title: Acme notes",
            "description: Notes for the example bundle.",
            "license: CC-BY-4.0",
            "okf_version: \"0.3\"",
        ] {
            assert!(root.contains(kept), "{kept}\n{root}");
        }
        assert!(root.contains("ops/index.md") && !root.contains("ops/runbook.md"));
        let ops = fs::read_to_string(f.root().join("ops/index.md")).unwrap();
        assert!(ops.contains("runbook.md") && ops.contains("deep/index.md"));
        assert!(!ops.contains("okf_version"));
        let deep = fs::read_to_string(f.root().join("ops/deep/index.md")).unwrap();
        assert!(deep.contains("check.md") && !deep.contains("runbook"));
        let found = f.store.review(Scope::Repository).unwrap().findings;
        assert!(
            found.iter().all(|(_, d)| d.level != Level::Error),
            "{found:?}"
        );
    }
    #[tokio::test]
    async fn a_hand_written_index_is_never_overwritten() {
        let f = Fixture::new();
        let hand = "---\nokf_version: \"0.3\"\ntitle: By hand\nlicense: MIT\n---\n\n# Contents\n\n* [a](a.md) - hand listed\n";
        place(&f, "index.md", hand);
        place(
            &f,
            "ops/index.md",
            "---\ntitle: Ops by hand\n---\n\nOps notes.\n",
        );
        f.write("a", &note("Body words for the root")).await;
        f.write(
            "ops/runbook",
            &note("Runbook words with their own vocabulary"),
        )
        .await;
        assert_eq!(fs::read_to_string(f.root().join("index.md")).unwrap(), hand);
        assert_eq!(
            fs::read_to_string(f.root().join("ops/index.md")).unwrap(),
            "---\ntitle: Ops by hand\n---\n\nOps notes.\n"
        );
    }

    #[tokio::test]
    async fn the_upstream_consumer_scan_agrees_on_trust_freshness_and_lifecycle() {
        let Some(scan) = std::env::var_os("YCODING_OKF_SCAN").map(PathBuf::from) else {
            return;
        };
        let f = Fixture::new();
        place(&f, "index.md", "---\nokf_version: \"0.3\"\n---\n");
        let stamp = |generated: Option<&str>, events: &[(&str, &str)], extra: &str| {
            let mut text = "---\ntype: Note\n".to_owned();
            if let Some(at) = generated {
                text += &format!("generated: {{ by: \"ycoding/0.1\", at: \"{at}\" }}\n");
            }
            if !events.is_empty() {
                text += "verified:\n";
                for (by, at) in events {
                    text += &format!("  - by: \"{by}\"\n    at: \"{at}\"\n");
                }
            }
            text + extra + "---\nBody\n"
        };
        let cases = [
            ("none", stamp(Some("2026-10-15T00:00:00Z"), &[], "")),
            (
                "stale-human",
                stamp(
                    Some("2026-11-01T00:00:00Z"),
                    &[("human:alice", "2026-10-15T00:00:00Z")],
                    "",
                ),
            ),
            (
                "machine",
                stamp(
                    Some("2026-10-15T00:00:00Z"),
                    &[("ci/1.0", "2026-11-01T00:00:00Z")],
                    "",
                ),
            ),
            (
                "human",
                stamp(
                    Some("2026-10-15T00:00:00Z"),
                    &[("human:alice", "2026-11-01T00:00:00Z")],
                    "",
                ),
            ),
            (
                "no-generated",
                stamp(None, &[("human:alice", "2026-10-01T00:00:00Z")], ""),
            ),
            (
                "stale",
                stamp(None, &[], "stale_after: \"2026-11-01T00:00:00Z\"\n"),
            ),
            (
                "fresh",
                stamp(None, &[], "stale_after: \"2026-12-31T00:00:00Z\"\n"),
            ),
            (
                "malformed-stale",
                stamp(None, &[], "stale_after: tomorrow\n"),
            ),
            ("draft", stamp(None, &[], "status: draft\n")),
            ("unknown-status", stamp(None, &[], "status: frozen\n")),
            (
                "deprecated",
                stamp(None, &[], "status: deprecated\nsuperseded_by: human.md\n"),
            ),
        ];
        for (id, content) in &cases {
            place(&f, &format!("{id}.md"), content);
        }
        for name in [
            "metrics/income-statement.md",
            "computations/revenue.md",
            "computations/profit.md",
        ] {
            place(
                &f,
                name,
                &fs::read_to_string(
                    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("tests/fixtures/okf_appendix_a/bundle")
                        .join(name),
                )
                .unwrap(),
            );
        }
        let output = std::process::Command::new(
            std::env::var("YCODING_OKF_PYTHON").unwrap_or_else(|_| "python3".into()),
        )
        .arg("-B")
        .arg(&scan)
        .arg(f.root())
        .args(["--json", "--now"])
        .arg(f.now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .output()
        .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        let concepts = report["concepts"].as_array().unwrap();
        assert_eq!(concepts.len(), cases.len() + 3);
        for upstream in concepts {
            let id = upstream["id"].as_str().unwrap();
            let ours = f.summary(id).signals;
            let tier = match ours.trust {
                Trust::HumanReviewed => "human-reviewed",
                Trust::MachineConfirmed => "machine-confirmed",
                Trust::Unverified => "unverified",
            };
            assert_eq!(upstream["trust"], tier, "{id}: trust");
            assert_eq!(upstream["stale"].as_bool(), Some(ours.stale), "{id}: stale");
            assert_eq!(
                upstream["current"].as_bool(),
                Some(ours.current),
                "{id}: current"
            );
            assert_eq!(
                upstream["verified_before_change"].as_bool(),
                Some(ours.verification_older_than_content),
                "{id}: verification before change"
            );
            assert_eq!(
                upstream["replacement_id"].as_str().map(str::to_owned),
                ours.replacement,
                "{id}: replacement"
            );
        }
    }
}

mod validators {
    use super::*;
    use std::process::Command;

    fn interpreter() -> String {
        std::env::var("YCODING_OKF_PYTHON").unwrap_or_else(|_| "python3".into())
    }

    #[tokio::test]
    async fn rust_written_bundles_pass_the_official_validator() {
        let Some(validator) = std::env::var_os("YCODING_OKF_OFFICIAL_VALIDATOR").map(PathBuf::from)
        else {
            return;
        };
        let f = Fixture::new();
        f.write(
            "ops/runbook",
            "---\ntype: Procedure\ntitle: Roll back a deploy\ndescription: Steps to revert\ntags: [ops]\nsources:\n  - id: s1\n    resource: https://example.com/runbook\n    title: Runbook\n---\nRevert with the pipeline.[^s1]\n\n[^s1]: Runbook.\n",
        )
        .await;
        f.write(
            "fact",
            &note("Plain fact with a fully distinct vocabulary here"),
        )
        .await;
        f.write(
            "ops/links",
            "---\ntype: Note\ntags: [links]\n---\nFile-relative [runbook](runbook.md), parent-relative [fact](../fact.md), bundle-root [runbook](/ops/runbook.md), external [spec](https://example.com/spec) and a [self link](#links).\n",
        )
        .await;
        let sample = sample_experience();
        f.store
            .record_experience(Scope::Repository, &experience::id(&sample), &sample, None)
            .await
            .unwrap();
        let old = f
            .write("old", &note("Superseded guidance about unrelated matters"))
            .await;
        f.store
            .supersede(Scope::Repository, "old", Some("fact"), &old.digest)
            .await
            .unwrap();
        let output = Command::new(interpreter())
            .arg("-B")
            .arg(&validator)
            .arg(f.root())
            .arg("--strict")
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&output.stdout).into_owned()
            + &String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "{text}");
    }

    fn copy(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for entry in fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy(&entry.path(), &target);
            } else {
                fs::copy(entry.path(), target).unwrap();
            }
        }
    }

    #[tokio::test]
    async fn official_sample_bundles_are_consumed_without_rejection() {
        let Some(samples) = std::env::var_os("YCODING_OKF_SAMPLES").map(PathBuf::from) else {
            return;
        };
        for entry in fs::read_dir(samples).unwrap() {
            let sample = entry.unwrap().path();
            if !sample.is_dir() {
                continue;
            }
            let f = Fixture::new();
            copy(&sample, &f.root());
            let listing = f.store.list(Scope::Repository, None, Some(0)).unwrap();
            let files = count_markdown(&sample);
            assert!(
                listing.total > 0 && listing.total <= files,
                "{sample:?}: {} of {files}",
                listing.total
            );
            assert!(
                listing.warnings.is_empty(),
                "{sample:?}: {:?}",
                listing.warnings
            );
        }
    }
    fn count_markdown(dir: &Path) -> usize {
        fs::read_dir(dir)
            .unwrap()
            .map(|entry| {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    count_markdown(&path)
                } else {
                    usize::from(path.extension().is_some_and(|e| e == "md"))
                }
            })
            .sum()
    }
}
