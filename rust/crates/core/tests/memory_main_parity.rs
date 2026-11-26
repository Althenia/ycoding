use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::SystemTime,
};
use ycoding_core::resources::memory::{
    Error, Limits, Options, Repository, Scope, Search, SearchHit, Service, format,
};

struct Fixture {
    path: PathBuf,
    store: Service,
}
impl Fixture {
    fn new(limits: Limits) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "ycoding-memory-parity-{}-{}",
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
    async fn put(&self, id: &str, body: &str, metadata: &str) -> String {
        self.store
            .write(Scope::Repository, id, &note(body, metadata), None)
            .await
            .unwrap()
            .digest
    }
    fn search(&self, query: &str) -> Vec<SearchHit> {
        self.filtered(query, None, None)
    }
    fn filtered(&self, query: &str, type_: Option<&str>, tag: Option<&str>) -> Vec<SearchHit> {
        self.store
            .search(
                Scope::Repository,
                Search {
                    query,
                    limit: None,
                    type_,
                    tag,
                },
            )
            .unwrap()
            .hits
    }
    fn root(&self) -> PathBuf {
        self.store.status(Scope::Repository).unwrap().root
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn note(body: &str, metadata: &str) -> String {
    format!("---\n{metadata}\n---\n{body}\n")
}
fn receipt(id: &str) -> String {
    format!("{{\"version\":1,\"id\":\"{id}\"}}\n")
}
fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}
fn ids(hits: &[SearchHit]) -> Vec<&str> {
    hits.iter().map(|hit| hit.summary.id.as_str()).collect()
}
fn sorted_ids(hits: &[SearchHit]) -> Vec<&str> {
    let mut result = ids(hits);
    result.sort();
    result
}
fn close(left: f64, right: f64) {
    assert!(
        (left - right).abs() < 1e-10,
        "{left} is not close to {right}"
    );
}

#[tokio::test]
async fn derived_recall_index_recovers_without_restoring_removed_concepts() {
    let f = Fixture::new(Limits::default());
    f.put("first", "red lantern", "type: Note").await;
    let digest = f.put("second", "red lantern", "type: Note").await;
    let contents = snapshot(&f.root());
    assert_eq!(ids(&f.search("lantern")), ["first", "second"]);
    assert_eq!(snapshot(&f.root()), contents);
    let cache = f
        .path
        .join("data/recall/index")
        .join(format::sha256(f.root().as_os_str().as_encoded_bytes()))
        .join("bm25-v1");
    assert!(fs::metadata(&cache).unwrap().len() > 64);
    fs::write(&cache, b"interrupted derived data").unwrap();
    f.store
        .delete(Scope::Repository, "second", &digest)
        .await
        .unwrap();
    assert_eq!(ids(&f.search("lantern")), ["first"]);
    assert_ne!(fs::read(cache).unwrap(), b"interrupted derived data");
}
fn snippet(hit: &SearchHit) -> String {
    String::from_utf16(&hit.snippet.code_units().collect::<Vec<_>>()).unwrap()
}
fn snapshot(root: &Path) -> Vec<(String, Vec<u8>, SystemTime)> {
    fn walk(root: &Path, directory: &Path, out: &mut Vec<(String, Vec<u8>, SystemTime)>) {
        for entry in fs::read_dir(directory).unwrap() {
            let entry = entry.unwrap();
            let kind = entry.file_type().unwrap();
            let path = entry.path();
            if kind.is_dir() {
                walk(root, &path, out);
            } else if kind.is_file() {
                out.push((
                    path.strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    fs::read(&path).unwrap(),
                    fs::metadata(&path).unwrap().modified().unwrap(),
                ));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}
fn preserved(root: &Path) -> Vec<(String, Vec<u8>, SystemTime)> {
    snapshot(root)
        .into_iter()
        .filter(|item| item.0 != "index.md" && !item.0.starts_with(".locks"))
        .collect()
}

#[tokio::test]
async fn mixed_collection_indexes_unterminated_bytes_and_repairs_only_by_digest() {
    let f = Fixture::new(Limits::default());
    f.put("normal", "other", "type: Decision").await;
    let raw = "---\r\ntype: Decision\r\nx-note: cobalt\r\n";
    let path = f.root().join("legacy.md");
    fs::write(&path, raw).unwrap();
    let before = snapshot(&f.root());
    let digest = format::sha256(raw);
    for _ in 0..2 {
        let read = f.store.read(Scope::Repository, "legacy").unwrap();
        assert_eq!((read.content.as_str(), &read.digest), (raw, &digest));
        let list = f.store.list(Scope::Repository, None, None).unwrap();
        assert_eq!(list.total, 2);
        assert!(
            list.warnings
                .iter()
                .any(|warning| warning.id == "legacy" && warning.code.contains("unterminated"))
        );
        assert_eq!(ids(&f.search("cobalt")), ["legacy"]);
    }
    assert_eq!(snapshot(&f.root()), before);
    let repaired = "---\ntype: Decision\n---\nCobalt.";
    assert!(matches!(
        f.store
            .write(Scope::Repository, "legacy", repaired, Some(&"0".repeat(64)))
            .await,
        Err(Error::StaleContent)
    ));
    assert_eq!(fs::read(&path).unwrap(), raw.as_bytes());
    f.store
        .write(Scope::Repository, "legacy", repaired, Some(&digest))
        .await
        .unwrap();
    assert_eq!(fs::read(&path).unwrap(), repaired.as_bytes());
    assert!(
        f.store
            .list(Scope::Repository, None, None)
            .unwrap()
            .warnings
            .is_empty()
    );
}

#[tokio::test]
async fn singleton_okf_metadata_is_searchable_without_reserializing_it() {
    let f = Fixture::new(Limits::default());
    let text = "---\ntype: Reference\ntags: reviewed\nsources: {id: spec, resource: 'repo:///SPEC.md'}\nx-extension: {value: 7}\n---\nCobalt.[^spec]\n";
    f.store
        .write(Scope::Repository, "one", text, None)
        .await
        .unwrap();
    assert_eq!(ids(&f.filtered("cobalt", None, Some("reviewed"))), ["one"]);
    assert_eq!(
        f.store.read(Scope::Repository, "one").unwrap().content,
        text
    );
}

#[tokio::test]
async fn new_concepts_require_a_closing_delimiter_and_a_yaml_mapping() {
    let f = Fixture::new(Limits::default());
    for (content, message) in [
        ("---\ntype: Decision\n", "closing ---"),
        ("---\ntype: Decision\n---suffix\n", "closing ---"),
        ("---\ntype: Decision\ntitle: x: y\n---\nbody", "YAML"),
        ("---\ntype: Decision\nx: a\nx: b\n---\n", "YAML"),
    ] {
        assert!(
            f.store
                .write(Scope::Repository, "new", content, None)
                .await
                .unwrap_err()
                .to_string()
                .contains(message)
        );
        assert!(!f.root().exists());
    }
}

#[tokio::test]
async fn bm25_scores_use_fixed_boosts_and_whole_collection_statistics() {
    let f = Fixture::new(Limits::default());
    f.put("d1", "x y", "type: T\ntitle: kappa").await;
    f.put("d2", "x y", "type: T\ntitle: Other\ndescription: kappa")
        .await;
    f.put("d3", "kappa y", "type: G\ntitle: Other").await;
    let idf = (1.0_f64 + 0.5 / 3.5).ln();
    let title = idf * 4.0 * (2.2 / (1.0 + 1.2 * (0.25 + (0.75 * 2.0) / 2.0)));
    let description = idf * 2.0 * (2.2 / (1.0 + 1.2 * (0.25 + (0.75 * 2.0) / (4.0 / 3.0))));
    let body = idf * (2.2 / (1.0 + 1.2 * (0.25 + (0.75 * 2.0) / 2.0)));
    let hits = f.search("kappa");
    assert_eq!(ids(&hits), ["d1", "d2", "d3"]);
    close(hits[0].score, title);
    close(hits[1].score, description);
    close(hits[2].score, body);
    let filtered = f.filtered("kappa", Some("G"), None);
    assert_eq!(ids(&filtered), ["d3"]);
    close(filtered[0].score, body);
    assert!(f.filtered("kappa", Some("g"), None).is_empty());
    let repeated = f.search("kappa KAPPA kappa");
    assert_eq!(ids(&repeated), ids(&hits));
    for (left, right) in repeated.iter().zip(&hits) {
        assert_eq!(left.score, right.score);
        assert_eq!(snippet(left), snippet(right));
    }
}

#[tokio::test]
async fn bm25_normalizes_empty_fields_without_nan() {
    let empty = Fixture::new(Limits::default());
    empty.put("e1", "", "type: T\ntitle: kappa").await;
    empty.put("e2", "", "type: T\ntitle: Other").await;
    let hits = empty.search("kappa");
    assert_eq!(ids(&hits), ["e1"]);
    assert!(hits[0].score.is_finite());
    close(hits[0].score, 4.0 * 2.0_f64.ln());
    assert_eq!(snippet(&hits[0]), "");
    let mixed = Fixture::new(Limits::default());
    mixed.put("m1", "kappa", "type: T").await;
    mixed.put("m2", "", "type: T").await;
    let hits = mixed.search("kappa");
    assert_eq!(ids(&hits), ["m1"]);
    close(
        hits[0].score,
        2.0_f64.ln() * (2.2 / (1.0 + 1.2 * (0.25 + (0.75 * 1.0) / 0.5))),
    );
}

#[tokio::test]
async fn bm25_ranks_rarity_frequency_and_length_with_stable_id_ties() {
    let rarity = Fixture::new(Limits::default());
    for (id, body) in [
        ("n1", "common pad"),
        ("n2", "rare pad"),
        ("n3", "common pad"),
        ("n4", "common pad"),
    ] {
        rarity.put(id, body, "type: T").await;
    }
    let first = rarity.search("common rare");
    assert_eq!(ids(&first), ["n2", "n1", "n3", "n4"]);
    for query in ["pad rare common", "rare pad common PAD", "common rare pad"] {
        let permuted = rarity.search(query);
        let expected = rarity.search("common rare pad");
        assert_eq!(ids(&permuted), ids(&expected));
        for (left, right) in permuted.iter().zip(&expected) {
            assert_eq!(left.score, right.score);
        }
    }
    let frequency = Fixture::new(Limits::default());
    for (id, body) in [
        ("t1", "alpha beta"),
        ("t2", "alpha alpha"),
        ("l1", "alpha b c d e f g h"),
        ("l2", "alpha b"),
    ] {
        frequency.put(id, body, "type: T").await;
    }
    let hits = frequency.search("alpha");
    assert_eq!(ids(&hits), ["t2", "l2", "t1", "l1"]);
    assert_eq!(hits[1].score, hits[2].score);
}

#[tokio::test]
async fn bm25_title_and_id_boost_exceeds_shared_metadata_boost() {
    let f = Fixture::new(Limits::default());
    f.put("kappa", "x", "type: T\ntitle: Other").await;
    f.put("q1", "x", "type: T\ntitle: Kappa").await;
    f.put("r-desc", "x", "type: T\ntitle: Other\ndescription: kappa")
        .await;
    f.put("s-tag", "x", "type: T\ntitle: Other\ntags: [kappa]")
        .await;
    f.put("t-type", "x", "type: Kappa T\ntitle: Other").await;
    let hits = f.search("kappa");
    assert_eq!(ids(&hits), ["kappa", "q1", "r-desc", "s-tag", "t-type"]);
    close(hits[1].score, hits[0].score);
    assert!(hits[1].score > hits[2].score);
    close(hits[3].score, hits[2].score);
    close(hits[4].score, hits[2].score);
    let tagged = f.filtered("kappa", None, Some("kappa"));
    assert_eq!(ids(&tagged), ["s-tag"]);
    close(tagged[0].score, hits[3].score);
    assert!(f.filtered("kappa", None, Some("Kappa")).is_empty());
}

#[tokio::test]
async fn search_matches_distinct_whole_tokens_without_prefix_phrase_or_boolean_operators() {
    let f = Fixture::new(Limits::default());
    f.put("p1", "build-cache don't snake_case end.", "type: T")
        .await;
    f.put("p2", "cache", "type: T").await;
    for (query, expected) in [
        ("cach", vec![]),
        ("snake", vec![]),
        ("snake_case", vec!["p1"]),
        ("don", vec!["p1"]),
        ("build-cache", vec!["p1", "p2"]),
        ("\"cache build\"", vec!["p1", "p2"]),
        ("cache AND absent", vec!["p1", "p2"]),
        ("NOT cache", vec!["p1", "p2"]),
        ("!!! ???", vec![]),
    ] {
        assert_eq!(sorted_ids(&f.search(query)), expected, "{query}");
    }
}

#[tokio::test]
async fn search_matches_nfc_equivalent_text_without_accent_folding() {
    let f = Fixture::new(Limits::default());
    let decomposed = note("cafe\u{301} dec", "type: T");
    f.store
        .write(Scope::Repository, "n-dec", &decomposed, None)
        .await
        .unwrap();
    f.put("n-pre", "caf\u{e9} pre", "type: T").await;
    f.put("n-plain", "cafe plain", "type: T").await;
    f.put("n-caron", "J\u{30c} caron", "type: T").await;
    f.put("n-greek", "\u{39f}\u{394}\u{39f}\u{3a3} greek", "type: T")
        .await;
    assert_eq!(sorted_ids(&f.search("caf\u{e9}")), ["n-dec", "n-pre"]);
    assert_eq!(sorted_ids(&f.search("cafe\u{301}")), ["n-dec", "n-pre"]);
    assert_eq!(sorted_ids(&f.search("CAF\u{c9}")), ["n-dec", "n-pre"]);
    assert_eq!(ids(&f.search("cafe")), ["n-plain"]);
    let hits = f.search("caf\u{e9}");
    let kept = hits.iter().find(|hit| hit.summary.id == "n-dec").unwrap();
    assert!(snippet(kept).contains("cafe\u{301}"));
    assert_eq!(
        f.store.read(Scope::Repository, "n-dec").unwrap().content,
        decomposed
    );
    assert_eq!(ids(&f.search("\u{1f0}")), ["n-caron"]);
    assert_eq!(ids(&f.search("j\u{30c}")), ["n-caron"]);
    assert!(f.search("j").is_empty());
    assert_eq!(ids(&f.search("\u{3bf}\u{3b4}\u{3bf}\u{3c2}")), ["n-greek"]);
    assert_eq!(ids(&f.search("\u{39f}\u{394}\u{39f}\u{3a3}")), ["n-greek"]);
    assert!(f.search("\u{3bf}\u{3b4}\u{3bf}\u{3c3}").is_empty());
    let greek = f.search("\u{3bf}\u{3b4}\u{3bf}\u{3c2}");
    assert!(snippet(&greek[0]).contains("\u{39f}\u{394}\u{39f}\u{3a3}"));
}

#[tokio::test]
async fn snippets_align_to_whole_token_matches_in_surrogate_safe_text() {
    let f = Fixture::new(Limits::default());
    let contents = [
        (
            "s-cat",
            format!("concatenate {}cat end", "filler ".repeat(120)),
            "cat",
        ),
        (
            "s-dot",
            format!("{} pin tail", "\u{130}".repeat(100)),
            "pin",
        ),
        (
            "s-emoji",
            format!(
                "{} needle {}",
                "\u{1f600}".repeat(200),
                "\u{1f600}".repeat(200)
            ),
            "needle",
        ),
    ];
    for (id, body, _) in &contents {
        f.put(id, body, "type: T").await;
    }
    for (id, body, query) in &contents {
        let hits = f.search(query);
        let hit = hits.iter().find(|hit| hit.summary.id == *id).unwrap();
        let text = snippet(hit);
        assert!(hit.snippet.code_units().count() <= 320);
        assert!(body.contains(&text));
        assert!(text.contains(query));
        if *id == "s-cat" {
            assert!(!text.contains("concatenate"));
            assert!(
                text.split(|ch: char| !ch.is_alphanumeric() && ch != '_')
                    .any(|word| word == "cat")
            );
        }
    }
}

#[test]
fn lexical_tokens_keep_duplicates_normalize_nfc_and_order_by_utf16() {
    assert_eq!(
        format::tokens("ODOS \u{39f}\u{394}\u{39f}\u{3a3} odos").unwrap(),
        ["odos", "\u{3bf}\u{3b4}\u{3bf}\u{3c2}", "odos"]
    );
    assert_eq!(
        format::words("cafe\u{301} CAF\u{c9}")
            .unwrap()
            .into_iter()
            .collect::<Vec<_>>(),
        ["caf\u{e9}"]
    );
    assert_eq!(
        format::compare("\u{ff5e}", "\u{10000}"),
        std::cmp::Ordering::Greater
    );
}

#[test]
fn trash_receipts_require_exactly_version_one_and_a_valid_concept_id() {
    for valid in [
        "{\"version\":1,\"id\":\"entry\"}\n",
        "{\"id\":\"a/b-c_d\",\"version\":1.0}",
    ] {
        assert!(format::is_receipt(valid), "{valid}");
    }
    for invalid in [
        "{\"version\":2,\"id\":\"entry\"}",
        "{\"id\":\"entry\"}",
        "{\"version\":1}",
        "{\"version\":1,\"id\":\"entry\",\"note\":\"x\"}",
        "{\"version\":1,\"id\":\"Bad.ID\"}",
        "{\"version\":1,\"id\":\"trash/entry\"}",
        "{\"version\":1,\"id\":1}",
        "{\"version\":\"1\",\"id\":\"entry\"}",
        "[]",
        "{ malformed receipt",
        "",
    ] {
        assert!(!format::is_receipt(invalid), "{invalid}");
    }
}

#[tokio::test]
async fn vacuum_repairs_an_orphan_receipt_only_through_preview_and_apply() {
    let f = Fixture::new(Limits::default());
    let root = f.root();
    let knowledge_root = f.store.status(Scope::Knowledge).unwrap().root;
    let kept = f.put("kept", "Kept", "type: T").await;
    let first = f.put("first", "First", "type: T").await;
    let second = f.put("second", "Second", "type: T").await;
    let third = f.put("third", "Third", "type: T").await;
    let shared = f
        .store
        .write(Scope::Knowledge, "shared", &note("Shared", "type: T"), None)
        .await
        .unwrap()
        .digest;
    let orphan = f
        .store
        .delete(Scope::Repository, "first", &first)
        .await
        .unwrap();
    let restorable = f
        .store
        .delete(Scope::Repository, "second", &second)
        .await
        .unwrap();
    let purgeable = f
        .store
        .delete(Scope::Repository, "third", &third)
        .await
        .unwrap();
    let shared_orphan = f
        .store
        .delete(Scope::Knowledge, "shared", &shared)
        .await
        .unwrap();
    fs::remove_file(root.join(format!("trash/{}.md", orphan.trash_id))).unwrap();
    fs::remove_file(knowledge_root.join(format!("trash/{}.md", shared_orphan.trash_id))).unwrap();
    assert!(matches!(
        f.store.delete(Scope::Repository, "kept", &kept).await,
        Err(Error::TooLarge)
    ));
    assert_eq!(
        f.store.read(Scope::Repository, "kept").unwrap().digest,
        kept
    );
    f.store
        .restore(Scope::Repository, &restorable.trash_id, &restorable.digest)
        .await
        .unwrap();
    assert_eq!(
        f.store.read(Scope::Repository, "second").unwrap().content,
        note("Second", "type: T")
    );
    f.store
        .purge(Scope::Repository, &purgeable.trash_id, &purgeable.digest)
        .await
        .unwrap();
    let metadata = format!("trash/{}.json", orphan.trash_id);
    let before = snapshot(&root);
    let preview = f.store.vacuum(Scope::Repository, None, None).await.unwrap();
    assert!(preview.dry_run);
    assert_eq!(preview.removed, [metadata.as_str()]);
    assert_eq!(snapshot(&root), before);
    let applied = f
        .store
        .vacuum(Scope::Repository, Some(false), Some(&preview.digest))
        .await
        .unwrap();
    assert!(!applied.dry_run);
    assert_eq!(applied.removed, [metadata.as_str()]);
    assert!(!exists(&root.join(&metadata)));
    assert_eq!(
        fs::read_to_string(knowledge_root.join(format!("trash/{}.json", shared_orphan.trash_id)))
            .unwrap(),
        receipt("shared")
    );
    assert_eq!(
        f.store
            .vacuum(Scope::Knowledge, None, None)
            .await
            .unwrap()
            .removed,
        [format!("trash/{}.json", shared_orphan.trash_id)]
    );
    let listing = f.store.trash(Scope::Repository, None, None).unwrap();
    assert!(listing.entries.is_empty());
    assert_eq!(listing.total, 0);
    assert!(listing.warnings.is_empty());
    assert_eq!(
        f.store.read(Scope::Repository, "kept").unwrap().digest,
        kept
    );
    f.store
        .delete(Scope::Repository, "kept", &kept)
        .await
        .unwrap();
    assert_eq!(
        f.store.trash(Scope::Repository, None, None).unwrap().total,
        1
    );
}

#[tokio::test]
async fn vacuum_apply_rejects_an_orphan_receipt_changed_after_preview() {
    let f = Fixture::new(Limits::default());
    let root = f.root();
    let saved = f.put("entry", "Body", "type: T").await;
    let removed = f
        .store
        .delete(Scope::Repository, "entry", &saved)
        .await
        .unwrap();
    fs::remove_file(root.join(format!("trash/{}.md", removed.trash_id))).unwrap();
    let metadata = root.join(format!("trash/{}.json", removed.trash_id));
    let relative = format!("trash/{}.json", removed.trash_id);
    let preview = f.store.vacuum(Scope::Repository, None, None).await.unwrap();
    assert_eq!(preview.removed, [relative.as_str()]);
    let changed = "{\"id\":\"entry\",\"version\":1}\n";
    fs::write(&metadata, changed).unwrap();
    assert!(matches!(
        f.store
            .vacuum(Scope::Repository, Some(false), Some(&preview.digest))
            .await,
        Err(Error::StaleContent)
    ));
    assert_eq!(fs::read_to_string(&metadata).unwrap(), changed);
    let fresh = f.store.vacuum(Scope::Repository, None, None).await.unwrap();
    assert_ne!(fresh.digest, preview.digest);
    assert_eq!(fresh.removed, [relative.as_str()]);
    f.store
        .vacuum(Scope::Repository, Some(false), Some(&fresh.digest))
        .await
        .unwrap();
    assert!(!exists(&metadata));
}

#[cfg(unix)]
#[tokio::test]
async fn vacuum_preserves_unrecognized_oversized_linked_other_version_and_archive_backed_receipts()
{
    let f = Fixture::new(Limits::default());
    let root = f.root();
    let trash = root.join("trash");
    let entry = f.put("entry", "Body", "type: T").await;
    let damaged = f.put("damaged", "Damaged", "type: T").await;
    let orphan = f
        .store
        .delete(Scope::Repository, "entry", &entry)
        .await
        .unwrap();
    let damaged_trash = f
        .store
        .delete(Scope::Repository, "damaged", &damaged)
        .await
        .unwrap();
    fs::remove_file(trash.join(format!("{}.md", orphan.trash_id))).unwrap();
    fs::write(
        trash.join(format!("{}.md", damaged_trash.trash_id)),
        [0xff, 0xfe, 0xfd],
    )
    .unwrap();
    let named = |digit: &str| trash.join(format!("trash_{}.json", digit.repeat(64)));
    fs::write(named("1"), "{\"version\":2,\"id\":\"entry\"}\n").unwrap();
    fs::write(named("2"), "{\"id\":\"entry\"}\n").unwrap();
    fs::write(named("3"), "{ malformed receipt").unwrap();
    fs::write(named("4"), receipt("Bad.ID")).unwrap();
    fs::write(
        named("5"),
        format!(
            "{{\"version\":1,\"id\":\"entry\",\"padding\":\"{}\"}}\n",
            "x".repeat(5000)
        ),
    )
    .unwrap();
    let outside = f.path.join("outside-receipt.json");
    fs::write(&outside, receipt("entry")).unwrap();
    std::os::unix::fs::symlink(&outside, named("6")).unwrap();
    fs::create_dir(named("7")).unwrap();
    fs::write(
        named("8"),
        "{\"version\":1,\"id\":\"entry\",\"note\":\"x\"}\n",
    )
    .unwrap();
    fs::write(trash.join("notes.json"), receipt("entry")).unwrap();
    fs::write(
        trash.join(format!("trash_{}.json", "A".repeat(64))),
        receipt("entry"),
    )
    .unwrap();
    fs::write(trash.join(".pending.tmp"), "Unknown temporary data").unwrap();
    fs::write(root.join(".leftover.tmp"), "Unknown temporary data").unwrap();
    let metadata = format!("trash/{}.json", orphan.trash_id);
    let before = preserved(&root);
    let preview = f.store.vacuum(Scope::Repository, None, None).await.unwrap();
    assert_eq!(preview.removed, [metadata.as_str()]);
    assert_eq!(preserved(&root), before);
    let applied = f
        .store
        .vacuum(Scope::Repository, Some(false), Some(&preview.digest))
        .await
        .unwrap();
    assert_eq!(applied.removed, [metadata.as_str()]);
    assert_eq!(
        preserved(&root),
        before
            .into_iter()
            .filter(|item| item.0 != metadata)
            .collect::<Vec<_>>()
    );
    assert!(fs::symlink_metadata(named("6")).unwrap().is_symlink());
    assert_eq!(fs::read_to_string(&outside).unwrap(), receipt("entry"));
    assert!(fs::symlink_metadata(named("7")).unwrap().is_dir());
}

#[tokio::test]
async fn unpaired_archives_are_bounded_diagnostics_and_never_removed() {
    let f = Fixture::new(Limits::default());
    let root = f.root();
    let saved = f.put("solo", "Solo", "type: T").await;
    let solo = f
        .store
        .delete(Scope::Repository, "solo", &saved)
        .await
        .unwrap();
    fs::remove_file(root.join(format!("trash/{}.json", solo.trash_id))).unwrap();
    let archive = root.join(format!("trash/{}.md", solo.trash_id));
    let listing = f.store.trash(Scope::Repository, None, None).unwrap();
    assert!(listing.entries.is_empty());
    assert!(
        listing
            .warnings
            .iter()
            .any(|warning| warning.id == solo.trash_id && warning.code == "unpaired-trash")
    );
    let preview = f.store.vacuum(Scope::Repository, None, None).await.unwrap();
    assert!(preview.removed.is_empty());
    assert!(
        preview
            .warnings
            .iter()
            .any(|warning| warning.id == solo.trash_id)
    );
    f.store
        .vacuum(Scope::Repository, Some(false), Some(&preview.digest))
        .await
        .unwrap();
    assert_eq!(
        fs::read_to_string(&archive).unwrap(),
        note("Solo", "type: T")
    );
    let bounded = Fixture::new(Limits {
        max_concepts: 4,
        ..Limits::default()
    });
    let trash = bounded.root().join("trash");
    fs::create_dir_all(&trash).unwrap();
    let archives = (0..12)
        .map(|index| trash.join(format!("trash_{index:064x}.md")))
        .collect::<Vec<_>>();
    for target in &archives {
        fs::write(target, "Unpaired").unwrap();
    }
    let listing = bounded.store.trash(Scope::Repository, None, None).unwrap();
    assert!(!listing.warnings.is_empty());
    assert!(listing.warnings.len() <= 4);
    assert!(
        bounded
            .store
            .vacuum(Scope::Repository, None, None)
            .await
            .unwrap()
            .removed
            .is_empty()
    );
    for target in &archives {
        assert_eq!(fs::read_to_string(target).unwrap(), "Unpaired");
    }
}

#[tokio::test]
async fn orphan_receipt_recovery_is_bounded_by_the_inventory_limit() {
    let f = Fixture::new(Limits {
        max_concepts: 2,
        ..Limits::default()
    });
    let root = f.root();
    fs::create_dir_all(root.join("trash")).unwrap();
    let receipts = (0..5)
        .map(|index| format!("trash/trash_{index:064x}.json"))
        .collect::<Vec<_>>();
    for (index, relative) in receipts.iter().enumerate() {
        fs::write(root.join(relative), receipt(&format!("orphan-{index}"))).unwrap();
    }
    let before = snapshot(&root);
    let preview = f.store.vacuum(Scope::Repository, None, None).await.unwrap();
    assert_eq!(snapshot(&root), before);
    assert!(!preview.removed.is_empty());
    assert!(preview.removed.len() <= 2);
    assert!(preview.removed.iter().all(|path| receipts.contains(path)));
    assert!(!preview.warnings.is_empty());
    let applied = f
        .store
        .vacuum(Scope::Repository, Some(false), Some(&preview.digest))
        .await
        .unwrap();
    assert_eq!(applied.removed, preview.removed);
    for relative in &receipts {
        assert_eq!(
            exists(&root.join(relative)),
            !preview.removed.contains(relative)
        );
    }
}

#[tokio::test]
async fn vacuum_reports_committed_removals_when_index_rebuilding_fails_afterward() {
    let f = Fixture::new(Limits::default());
    let live = f.put("live", "Live", "type: T").await;
    f.put("old/entry", "Old", "type: T").await;
    let root = f.root();
    fs::remove_file(root.join("old/entry.md")).unwrap();
    fs::remove_file(root.join("index.md")).unwrap();
    fs::create_dir(root.join("index.md")).unwrap();
    let preview = f.store.vacuum(Scope::Repository, None, None).await.unwrap();
    assert_eq!(preview.removed, ["old/index.md"]);
    let applied = f
        .store
        .vacuum(Scope::Repository, Some(false), Some(&preview.digest))
        .await
        .unwrap();
    assert_eq!(applied.removed, ["old/index.md"]);
    assert!(
        applied
            .warnings
            .iter()
            .any(|warning| warning.code == "index-out-of-date")
    );
    assert!(!exists(&root.join("old/index.md")));
    assert_eq!(
        f.store.read(Scope::Repository, "live").unwrap().digest,
        live
    );
}

#[cfg(unix)]
#[tokio::test]
async fn vacuum_returns_only_removed_paths_with_a_warning_when_a_later_removal_fails() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new(Limits::default());
    f.put("live", "Live", "type: T").await;
    f.put("old/entry", "Old", "type: T").await;
    f.put("zzz/entry", "Locked", "type: T").await;
    let root = f.root();
    fs::remove_file(root.join("old/entry.md")).unwrap();
    fs::remove_file(root.join("zzz/entry.md")).unwrap();
    let preview = f.store.vacuum(Scope::Repository, None, None).await.unwrap();
    assert_eq!(preview.removed, ["old/index.md", "zzz/index.md"]);
    let locked = root.join("zzz");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o500)).unwrap();
    if fs::write(locked.join(".probe"), "").is_ok() {
        fs::remove_file(locked.join(".probe")).unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
        return;
    }
    let applied = f
        .store
        .vacuum(Scope::Repository, Some(false), Some(&preview.digest))
        .await;
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
    let applied = applied.unwrap();
    assert_eq!(applied.removed, ["old/index.md"]);
    assert!(
        applied
            .warnings
            .iter()
            .any(|warning| warning.code == "vacuum-incomplete" && warning.id == "zzz/index.md")
    );
    assert!(!exists(&root.join("old/index.md")));
    assert!(exists(&root.join("zzz/index.md")));
}

#[tokio::test]
async fn delete_admission_ignores_unpaired_archives_at_a_one_entry_limit() {
    let f = Fixture::new(Limits {
        max_concepts: 1,
        ..Limits::default()
    });
    let root = f.root();
    let saved = f.put("entry", "Body", "type: T").await;
    let archive = root.join(format!("trash/trash_{}.md", "0".repeat(64)));
    fs::create_dir_all(archive.parent().unwrap()).unwrap();
    fs::write(&archive, "Unpaired").unwrap();
    let removed = f
        .store
        .delete(Scope::Repository, "entry", &saved)
        .await
        .unwrap();
    let listing = f.store.trash(Scope::Repository, None, None).unwrap();
    assert_eq!(listing.entries.len(), 1);
    assert_eq!(listing.entries[0].id, "entry");
    assert_eq!(listing.entries[0].trash_id, removed.trash_id);
    assert!(listing.warnings.len() <= 1);
    assert!(
        listing
            .warnings
            .iter()
            .all(|warning| warning.code == "unpaired-trash")
    );
    assert_eq!(fs::read_to_string(&archive).unwrap(), "Unpaired");
}

#[tokio::test]
async fn valid_receipts_stay_discoverable_after_capped_unpaired_diagnostics() {
    let f = Fixture::new(Limits {
        max_concepts: 4,
        ..Limits::default()
    });
    let root = f.root();
    let restorable_saved = f.put("restorable", "Restorable", "type: T").await;
    let purgeable_saved = f.put("purgeable", "Purgeable", "type: T").await;
    let restorable = f
        .store
        .delete(Scope::Repository, "restorable", &restorable_saved)
        .await
        .unwrap();
    let purgeable = f
        .store
        .delete(Scope::Repository, "purgeable", &purgeable_saved)
        .await
        .unwrap();
    let archives = (0..10)
        .map(|index| root.join(format!("trash/trash_{index:064x}.md")))
        .collect::<Vec<_>>();
    for target in &archives {
        fs::write(target, "Unpaired").unwrap();
    }
    let listing = f.store.trash(Scope::Repository, None, None).unwrap();
    let mut trash_ids = listing
        .entries
        .iter()
        .map(|entry| entry.trash_id.clone())
        .collect::<Vec<_>>();
    trash_ids.sort();
    let mut expected = vec![restorable.trash_id.clone(), purgeable.trash_id.clone()];
    expected.sort();
    assert_eq!(trash_ids, expected);
    assert_eq!(listing.total, 2);
    assert!(!listing.warnings.is_empty());
    assert!(listing.warnings.len() <= 4);
    assert!(
        listing
            .warnings
            .iter()
            .all(|warning| warning.code == "unpaired-trash")
    );
    f.store
        .restore(Scope::Repository, &restorable.trash_id, &restorable.digest)
        .await
        .unwrap();
    assert_eq!(
        f.store
            .read(Scope::Repository, "restorable")
            .unwrap()
            .content,
        note("Restorable", "type: T")
    );
    f.store
        .purge(Scope::Repository, &purgeable.trash_id, &purgeable.digest)
        .await
        .unwrap();
    assert!(
        f.store
            .trash(Scope::Repository, None, None)
            .unwrap()
            .entries
            .is_empty()
    );
    for target in &archives {
        assert_eq!(fs::read_to_string(target).unwrap(), "Unpaired");
    }
}

#[test]
fn relative_memory_path_resolves_against_the_main_checkout_or_the_location_outside_git() {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let base = std::env::temp_dir().join(format!(
        "ycoding-memory-parity-path-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&base).unwrap();
    let base = fs::canonicalize(base).unwrap();
    let main = base.join("main");
    let linked = base.join("linked");
    fs::create_dir_all(main.join(".git")).unwrap();
    fs::create_dir(&linked).unwrap();
    let limits = Limits {
        path: Some("notes/memory".into()),
        ..Limits::default()
    };
    let inside = Service::new(Options {
        directory: linked.clone(),
        home: base.clone(),
        data: base.join("data"),
        repository: Some(Repository {
            directory: linked.clone(),
            common_directory: main.join(".git"),
            worktrees: vec![main.clone(), linked.clone()],
        }),
        limits: limits.clone(),
    })
    .unwrap();
    let state = inside.status(Scope::Repository).unwrap();
    assert_eq!(state.base, main.join("notes/memory"));
    assert_eq!(state.knowledge_root, main.join("notes/memory/knowledge"));
    assert!(state.root.starts_with(main.join("notes/memory/repository")));
    let outside = Service::new(Options {
        directory: linked.clone(),
        home: base.clone(),
        data: base.join("data"),
        repository: None,
        limits,
    })
    .unwrap();
    assert_eq!(
        outside.status(Scope::Knowledge).unwrap().base,
        linked.join("notes/memory")
    );
    assert!(matches!(
        outside.status(Scope::Repository),
        Err(Error::NotFound)
    ));
    fs::remove_dir_all(base).unwrap();
}
