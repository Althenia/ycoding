use std::{
    cell::Cell,
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};
use ycoding_core::resources::recall::{
    candidate::{Budget, Method, Query, Reason, Semantic as Used},
    document::{Activation, Document, Fields, Kind, Lifecycle, Scope, Source, Status, Trust},
    hybrid::{Calibration, Retriever, rrf_score},
    index::{Entry, Publication},
    provision::{self, Artifact, Pin},
    semantic::{Config, Semantic, Status as ModelStatus},
    vectors::VectorCache,
};

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("cue-retrieval-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn doc(kind: Kind, id: &str, title: &str, tags: &[&str], body: &str) -> Document {
    Document {
        id: id.into(),
        kind,
        scope: Scope::Knowledge,
        source: Source {
            path: format!("{id}.md"),
            revision: "1".into(),
            content_hash: format!("hash-{id}-{}", body.len()),
        },
        fields: Fields {
            title: title.into(),
            body: body.into(),
            tags: tags.iter().map(|t| (*t).into()).collect(),
            ..Fields::default()
        },
        lifecycle: Lifecycle::default(),
    }
}

fn manifest(docs: &[Document]) -> Vec<Entry> {
    docs.iter()
        .map(|d| Entry {
            scope: d.scope,
            kind: d.kind,
            id: d.id.clone(),
            hash: d.source.content_hash.clone(),
        })
        .collect()
}

fn sync(retriever: &Retriever, docs: &[Document]) -> (Publication, usize) {
    let loads = Cell::new(0);
    let publication = retriever
        .sync(
            &manifest(docs),
            |entry| {
                loads.set(loads.get() + 1);
                docs.iter().find(|d| d.id == entry.id).cloned()
            },
            Instant::now() + Duration::from_secs(30),
        )
        .unwrap();
    (publication, loads.get())
}

fn query(text: &str) -> Query {
    Query {
        text: text.into(),
        limit: 10,
        ..Query::default()
    }
}

fn ids(retriever: &Retriever, query: &Query) -> Vec<String> {
    retriever
        .search(query)
        .candidates
        .into_iter()
        .map(|c| c.id)
        .collect()
}

fn corpus() -> Vec<Document> {
    let mut identified = doc(
        Kind::Concept,
        "build/linker",
        "Link editor",
        &["toolchain"],
        "After a missing symbol, inspect the archive member list for the object.",
    );
    identified.fields.identifiers = vec!["LD_LIBRARY_PATH".into()];
    vec![
        identified,
        doc(
            Kind::Concept,
            "sync/leases",
            "Exclusive writers",
            &["locking"],
            "Serialize updates with one lease per collection to prevent concurrent mutations.",
        ),
        doc(
            Kind::Concept,
            "network/backoff",
            "Backoff",
            &["network"],
            "Space successive retries after an upstream timeout with growing delays.",
        ),
        doc(
            Kind::Skill,
            "rust-build",
            "rust-build",
            &[],
            "Diagnose Cargo build failures and linker errors.",
        ),
    ]
}

fn open_calibration() -> Calibration {
    Calibration {
        bm25_floor: 0.0,
        ..Calibration::default()
    }
}

fn lexical() -> Retriever {
    Retriever::open(None, None, open_calibration())
}

#[test]
fn exact_matches_precede_lexical_hits_with_their_reason() {
    let retriever = lexical();
    sync(&retriever, &corpus());
    for (text, id, reason) in [
        ("build/linker", "build/linker", Reason::ExactId),
        ("Link editor", "build/linker", Reason::ExactTitle),
        ("ld_library_path", "build/linker", Reason::ExactIdentifier),
        ("locking", "sync/leases", Reason::ExactTag),
    ] {
        let found = retriever.search(&query(text)).candidates;
        assert_eq!(found[0].id, id, "{text}");
        assert_eq!(found[0].method, Method::Exact, "{text}");
        assert_eq!(found[0].reason, reason, "{text}");
        assert_eq!(found[0].scores[0].rank, 1);
    }
}

#[test]
fn lexical_hits_have_positive_bm25_scores_in_stable_order_and_unrelated_queries_find_nothing() {
    let retriever = lexical();
    sync(&retriever, &corpus());
    let found = retriever.search(&query("archive member list")).candidates;
    assert_eq!(found[0].id, "build/linker");
    let score = found[0].score(Method::Bm25).unwrap();
    assert!(score.score > 0.0 && score.rank == 1);
    assert_eq!(found[0].reason, Reason::BodyPhrase);
    let twice = ids(&retriever, &query("collection upstream"));
    assert_eq!(twice, ids(&retriever, &query("collection upstream")));
    assert!(ids(&retriever, &query("glacial moraine sediments")).is_empty());
    assert!(ids(&retriever, &query("   ")).is_empty());
}

#[test]
fn equal_scores_break_ties_by_canonical_key() {
    let retriever = lexical();
    let docs = vec![
        doc(Kind::Concept, "b/note", "note", &[], "shared canary"),
        doc(Kind::Concept, "a/note", "note", &[], "shared canary"),
    ];
    sync(&retriever, &docs);
    assert_eq!(ids(&retriever, &query("canary")), ["a/note", "b/note"]);
}

#[test]
fn filters_apply_before_the_limit() {
    let retriever = lexical();
    let mut docs = corpus();
    docs[3].lifecycle.activation = Some(Activation::Manual);
    docs.push(doc(
        Kind::Skill,
        "linker-guide",
        "linker-guide",
        &[],
        "Linker errors in builds.",
    ));
    docs[4].lifecycle.stale_after = Some(10);
    sync(&retriever, &docs);
    let mut q = query("linker");
    q.kinds = vec![Kind::Skill];
    assert_eq!(ids(&retriever, &q), ["linker-guide", "rust-build"]);
    q.implicit = true;
    assert_eq!(ids(&retriever, &q), ["linker-guide"]);
    q.now = Some(11);
    assert!(ids(&retriever, &q).is_empty());
    let mut tagged = query("linker");
    tagged.tags = vec!["toolchain".into()];
    assert_eq!(ids(&retriever, &tagged), ["build/linker"]);
    tagged.tags = vec!["Toolchain".into()];
    assert!(ids(&retriever, &tagged).is_empty());
    let mut scoped = query("linker");
    scoped.scopes = vec![Scope::Project];
    assert!(ids(&retriever, &scoped).is_empty());
}

#[test]
fn lifecycle_gates_exclude_superseded_inactive_and_stale_documents() {
    let retriever = lexical();
    let mut docs = corpus();
    docs[1].lifecycle.superseded_by = Some("sync/leases-v2".into());
    docs[2].lifecycle.status = Status::Deprecated;
    docs[0].lifecycle.stale_after = Some(100);
    docs[0].lifecycle.trust = Trust::Verified;
    sync(&retriever, &docs);
    let mut q = query("collection upstream linker archive");
    q.kinds = vec![Kind::Concept];
    assert_eq!(ids(&retriever, &q).len(), 3);
    q.now = Some(50);
    assert_eq!(ids(&retriever, &q), ["build/linker"]);
    q.now = Some(101);
    assert!(ids(&retriever, &q).is_empty());
}

#[test]
fn sync_loads_only_changed_documents_and_removes_deleted_ones() {
    let scratch = Scratch::new("incremental");
    let index = scratch.0.join("index");
    let retriever = Retriever::open(Some(index.clone()), None, open_calibration());
    let mut docs = corpus();
    assert_eq!(sync(&retriever, &docs), (Publication::Committed, 4));
    assert_eq!(sync(&retriever, &docs), (Publication::Unchanged, 0));
    docs[1] = doc(
        Kind::Concept,
        "sync/leases",
        "Exclusive writers",
        &["locking"],
        "Serialize updates with one lease per collection. Mention zebra crossing.",
    );
    assert_eq!(sync(&retriever, &docs), (Publication::Committed, 1));
    assert_eq!(ids(&retriever, &query("zebra")), ["sync/leases"]);
    docs.remove(2);
    assert_eq!(sync(&retriever, &docs), (Publication::Committed, 0));
    assert!(ids(&retriever, &query("upstream timeout")).is_empty());
    drop(retriever);
    let reopened = Retriever::open(Some(index), None, open_calibration());
    assert_eq!(sync(&reopened, &docs), (Publication::Unchanged, 0));
    assert_eq!(ids(&reopened, &query("zebra")), ["sync/leases"]);
}

#[test]
fn a_rebuilt_index_directory_returns_the_same_results() {
    let scratch = Scratch::new("rebuild");
    let index = scratch.0.join("index");
    let docs = corpus();
    let first = Retriever::open(Some(index.clone()), None, open_calibration());
    sync(&first, &docs);
    let before = first.search(&query("archive upstream"));
    drop(first);
    fs::remove_dir_all(&index).unwrap();
    let second = Retriever::open(Some(index), None, open_calibration());
    assert_eq!(sync(&second, &docs), (Publication::Committed, 4));
    assert_eq!(second.search(&query("archive upstream")), before);
}

#[test]
fn corrupt_index_files_are_discarded_and_rebuilt_from_source() {
    let scratch = Scratch::new("corrupt");
    let index = scratch.0.join("index");
    let docs = corpus();
    let first = Retriever::open(Some(index.clone()), None, open_calibration());
    sync(&first, &docs);
    drop(first);
    fs::write(index.join("meta.json"), b"{broken").unwrap();
    let second = Retriever::open(Some(index), None, open_calibration());
    assert_eq!(sync(&second, &docs), (Publication::Committed, 4));
    assert_eq!(ids(&second, &query("locking"))[0], "sync/leases");
}

#[test]
fn a_busy_writer_scores_an_unpublished_index_and_leaves_the_committed_generation() {
    let scratch = Scratch::new("busy");
    let index = scratch.0.join("index");
    let docs = corpus();
    let owner = Retriever::open(Some(index.clone()), None, open_calibration());
    sync(&owner, &docs[..2]);
    let committed = fs::read(index.join("meta.json")).unwrap();
    let competitor = Retriever::open(Some(index.clone()), None, open_calibration());
    let held = tantivy_writer_guard(&index);
    assert_eq!(sync(&competitor, &docs).0, Publication::Volatile);
    assert_eq!(
        ids(&competitor, &query("upstream timeout")),
        ["network/backoff"]
    );
    assert_eq!(fs::read(index.join("meta.json")).unwrap(), committed);
    drop(held);
    assert_eq!(sync(&competitor, &docs).0, Publication::Committed);
    assert_eq!(
        ids(&competitor, &query("upstream timeout")),
        ["network/backoff"]
    );
}

fn tantivy_writer_guard(index: &std::path::Path) -> tantivy::IndexWriter {
    tantivy::Index::open_in_dir(index)
        .unwrap()
        .writer_with_num_threads(1, 15_000_000)
        .unwrap()
}

#[test]
fn an_expired_deadline_does_not_publish() {
    let scratch = Scratch::new("deadline");
    let index = scratch.0.join("index");
    let retriever = Retriever::open(Some(index.clone()), None, open_calibration());
    let docs = corpus();
    let publication = retriever
        .sync(
            &manifest(&docs),
            |entry| docs.iter().find(|d| d.id == entry.id).cloned(),
            Instant::now(),
        )
        .unwrap();
    assert_eq!(publication, Publication::Volatile);
    assert_eq!(ids(&retriever, &query("locking"))[0], "sync/leases");
    let reopened = Retriever::open(Some(index), None, open_calibration());
    assert!(ids(&reopened, &query("locking")).is_empty());
}

#[test]
fn signals_report_the_lexical_evidence() {
    let retriever = lexical();
    sync(&retriever, &corpus());
    let result = retriever.search(&query("archive upstream"));
    assert_eq!(result.signals.query_terms, 2);
    assert!(result.signals.top_bm25 >= result.signals.second_bm25);
    assert!(result.signals.matched_terms >= 1);
    assert_eq!(result.signals.semantic, Used::NotNeeded);
}

fn experiences() -> Vec<Document> {
    vec![
        doc(
            Kind::Experience,
            "experience/flaky-linker",
            "Flaky linker after cache restore",
            &["linker"],
            "A restored cache kept stale objects; clearing the object directory fixed the linker error.",
        ),
        doc(
            Kind::Experience,
            "experience/linker-order",
            "Linker argument order",
            &["linker"],
            "Libraries must follow the objects that need them or the linker reports missing symbols.",
        ),
        doc(
            Kind::Concept,
            "build/linker-notes",
            "Linker notes",
            &[],
            "The linker resolves symbols from objects and archives.",
        ),
        doc(
            Kind::Skill,
            "linker-skill",
            "Linker skill",
            &[],
            "Diagnose linker failures step by step.",
        ),
    ]
}

#[test]
fn experiences_are_a_retrievable_kind_with_their_content_size() {
    let retriever = lexical();
    let docs = experiences();
    sync(&retriever, &docs);
    let mut q = query("linker");
    q.kinds = vec![Kind::Experience];
    let found = retriever.search(&q).candidates;
    assert_eq!(
        found.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        ["experience/flaky-linker", "experience/linker-order"]
    );
    assert!(found.iter().all(|c| c.kind == Kind::Experience));
    let flaky = &docs[0].fields;
    assert_eq!(
        found[0].bytes,
        flaky.title.len() + flaky.description.len() + flaky.body.len()
    );
    q.kinds = vec![Kind::Concept, Kind::Skill];
    assert!(
        retriever
            .search(&q)
            .candidates
            .iter()
            .all(|c| c.kind != Kind::Experience)
    );
}

#[test]
fn seen_content_hashes_are_not_returned_again() {
    let retriever = lexical();
    let docs = experiences();
    sync(&retriever, &docs);
    let mut q = query("linker");
    q.kinds = vec![Kind::Experience];
    q.seen = vec![docs[0].source.content_hash.clone()];
    assert_eq!(ids(&retriever, &q), ["experience/linker-order"]);
}

#[test]
fn implicit_queries_collapse_documents_with_identical_content_into_the_best_ranked_one() {
    let retriever = lexical();
    let mut docs = experiences();
    let mut copy = docs[0].clone();
    copy.id = "experience/flaky-linker-copy".into();
    copy.scope = Scope::Project;
    docs.push(copy);
    sync(&retriever, &docs);
    let mut q = query("linker");
    q.kinds = vec![Kind::Experience];
    assert_eq!(ids(&retriever, &q).len(), 3);
    q.implicit = true;
    let found = retriever.search(&q).candidates;
    assert_eq!(
        found.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        ["experience/flaky-linker", "experience/linker-order"]
    );
    assert_eq!(found[0].aliases.len(), 1);
    assert!(found[0].aliases[0].contains("flaky-linker-copy"));
    assert!(found[1].aliases.is_empty());
}

#[test]
fn budgets_cap_candidates_and_bytes_per_kind_and_in_total() {
    let retriever = lexical();
    let docs = experiences();
    sync(&retriever, &docs);
    let size = |i: usize| {
        let f = &docs[i].fields;
        f.title.len() + f.description.len() + f.body.len()
    };
    let mut q = query("linker");
    assert_eq!(ids(&retriever, &q).len(), 4);

    q.budget = Budget {
        per_kind_candidates: Some(1),
        ..Budget::default()
    };
    let capped = retriever.search(&q).candidates;
    assert_eq!(capped.len(), 3);
    assert_eq!(
        capped.iter().filter(|c| c.kind == Kind::Experience).count(),
        1
    );

    q.budget = Budget {
        per_kind_bytes: Some(size(0)),
        ..Budget::default()
    };
    let experience_ids: Vec<_> = retriever
        .search(&q)
        .candidates
        .into_iter()
        .filter(|c| c.kind == Kind::Experience)
        .map(|c| c.id)
        .collect();
    assert_eq!(experience_ids, ["experience/flaky-linker"]);

    q.budget = Budget {
        total_bytes: Some(size(2) + size(3)),
        ..Budget::default()
    };
    let total: usize = retriever
        .search(&q)
        .candidates
        .iter()
        .map(|c| c.bytes)
        .sum();
    assert!(total <= size(2) + size(3));
    q.budget = Budget {
        total_bytes: Some(0),
        ..Budget::default()
    };
    assert!(ids(&retriever, &q).is_empty());
}

#[test]
fn rrf_scores_sum_reciprocal_ranks() {
    assert!((rrf_score([1usize, 1], 60.0) - 2.0 / 61.0).abs() < 1e-12);
    assert!(rrf_score([1usize], 60.0) > rrf_score([2usize], 60.0));
    assert!(rrf_score([3usize, 3], 60.0) > rrf_score([1usize], 60.0));
}

#[test]
fn an_unprovisionable_model_falls_back_to_bm25_with_an_unavailable_signal() {
    let scratch = Scratch::new("fallback");
    let mut config = Config::new(scratch.0.join("models"), None);
    config.base_url = Some("http://127.0.0.1:9".into());
    let semantic = Semantic::new(config);
    semantic.warm();
    let deadline = Instant::now() + Duration::from_secs(20);
    while semantic.status() != ModelStatus::Failed && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(semantic.status(), ModelStatus::Failed);
    let hybrid = Retriever::open(None, Some(semantic), open_calibration());
    let plain = lexical();
    let docs = corpus();
    sync(&hybrid, &docs);
    sync(&plain, &docs);
    let text = query("mutations concurrent");
    let result = hybrid.search(&text);
    assert_eq!(result.signals.semantic, Used::Unavailable);
    assert_eq!(result.candidates[0].id, "sync/leases");
    assert!(result.candidates.iter().all(|c| c.method == Method::Bm25));
}

#[test]
fn the_vector_cache_is_keyed_by_content_hash_and_model_revision() {
    let scratch = Scratch::new("vectors");
    let path = scratch.0.join("vectors.bin");
    let vector = |seed: f32| (0..384).map(|i| seed + i as f32).collect::<Vec<_>>();
    let cache = VectorCache::open(Some(path.clone()), "model@1");
    cache.insert("h1", vector(1.0));
    cache.insert("h2", vector(2.0));
    cache.insert("bad", vec![1.0; 3]);
    assert!(!cache.contains("bad"));
    cache.persist().unwrap();
    let reopened = VectorCache::open(Some(path.clone()), "model@1");
    assert!(reopened.contains("h1") && reopened.contains("h2"));
    let norm: f32 = reopened.get("h1").unwrap().iter().map(|v| v * v).sum();
    assert!((norm - 1.0).abs() < 1e-4);
    assert!(VectorCache::open(Some(path.clone()), "model@2").is_empty());
    reopened.retain(&["h2".to_owned()].into_iter().collect());
    assert!(!reopened.contains("h1") && reopened.contains("h2"));
    fs::write(&path, b"CUEVEC01garbage").unwrap();
    assert!(VectorCache::open(Some(path), "model@1").is_empty());
}

const PAYLOADS: [(&str, &str, &[u8]); 2] = [
    ("model.onnx", "onnx/model.onnx", b"onnx-bytes"),
    ("tokenizer.json", "tokenizer.json", b"{\"tokenizer\":1}"),
];

fn sha256(bytes: &[u8]) -> String {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut child = Command::new("shasum")
        .args(["-a", "256"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(bytes).unwrap();
    String::from_utf8(child.wait_with_output().unwrap().stdout)
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .to_owned()
}

fn pin(tamper: bool) -> Pin {
    let artifacts: Vec<Artifact> = PAYLOADS
        .iter()
        .map(|(name, remote, bytes)| Artifact {
            name,
            remote,
            sha256: Box::leak(
                sha256(if tamper && *name == "model.onnx" {
                    b"other"
                } else {
                    bytes
                })
                .into_boxed_str(),
            ),
            size: bytes.len() as u64,
        })
        .collect();
    Pin {
        repository: "fixture/model",
        revision: "rev1",
        artifacts: Box::leak(artifacts.into_boxed_slice()),
    }
}

async fn serve() -> (String, tokio::task::JoinHandle<()>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0u8; 2048];
            let n = socket.read(&mut buffer).await.unwrap();
            let request = String::from_utf8_lossy(&buffer[..n]).to_string();
            let body = PAYLOADS
                .iter()
                .find(|(_, remote, _)| request.contains(&format!("/rev1/{remote} ")))
                .map(|(_, _, bytes)| *bytes);
            let response = match body {
                Some(bytes) => {
                    let mut out = format!(
                        "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                        bytes.len()
                    )
                    .into_bytes();
                    out.extend_from_slice(bytes);
                    out
                }
                None => b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                    .to_vec(),
            };
            socket.write_all(&response).await.unwrap();
        }
    });
    (base, task)
}

#[tokio::test]
async fn provisioning_downloads_pinned_files_verifies_them_and_is_idempotent() {
    let scratch = Scratch::new("provision");
    let (base, server) = serve().await;
    let pinned = pin(false);
    let dir = provision::provision(&scratch.0, &pinned, Some(&base))
        .await
        .unwrap();
    assert!(provision::is_provisioned(&dir, &pinned));
    assert_eq!(fs::read(dir.join("model.onnx")).unwrap(), b"onnx-bytes");
    server.abort();
    let again = provision::provision(&scratch.0, &pinned, Some("http://127.0.0.1:9"))
        .await
        .unwrap();
    assert_eq!(again, dir);
}

#[tokio::test]
async fn provisioning_rejects_content_that_fails_the_pinned_digest() {
    let scratch = Scratch::new("tamper");
    let (base, server) = serve().await;
    let pinned = pin(true);
    let error = provision::provision(&scratch.0, &pinned, Some(&base))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("integrity"));
    let dir = provision::directory(&scratch.0, &pinned);
    assert!(!provision::is_provisioned(&dir, &pinned));
    assert!(!dir.join("model.onnx").exists());
    server.abort();
}
