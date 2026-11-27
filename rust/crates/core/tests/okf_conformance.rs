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

mod validators {
    use super::*;
    use std::process::Command;

    fn helper() -> Option<PathBuf> {
        let path = PathBuf::from(std::env::var_os("HOME")?)
            .join(".agents/skills/okf-knowledge-bundle/scripts/okf_helper.py");
        path.exists().then_some(path)
    }
    fn interpreter() -> String {
        std::env::var("YCODING_OKF_HELPER_PYTHON").unwrap_or_else(|_| "python3".into())
    }

    #[tokio::test]
    async fn rust_written_bundles_pass_the_reference_helper() {
        let Some(helper) = helper() else {
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
        let sample = sample_experience();
        f.store
            .record_experience(Scope::Repository, &experience::id(&sample), &sample, None)
            .await
            .unwrap();
        let repo = f.path.join("helper-repo");
        fs::create_dir_all(&repo).unwrap();
        let bundle = repo.join("bundle");
        copy(&f.root(), &bundle);
        let output = Command::new(interpreter())
            .arg("-B")
            .arg(&helper)
            .args(["validate", "--no-git", "--repo"])
            .arg(&repo)
            .arg("--bundle")
            .arg("bundle")
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&output.stdout).into_owned()
            + &String::from_utf8_lossy(&output.stderr);
        if text.contains("No module named") || text.contains("PyYAML is required") {
            return;
        }
        assert!(output.status.success(), "{text}");
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
