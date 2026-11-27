#[path = "recall/corpus.rs"]
mod corpus;
#[path = "recall/metrics.rs"]
mod metrics;
#[path = "../tests/policy_fixture.rs"]
mod policy_fixture;

use corpus::{Corpus, Query as Labelled};
use serde_json::{Value, json};
use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use ycoding_core::resources::recall::{
    candidate::{Method, Query},
    document::{Activation, Document, Fields, Kind, Lifecycle, Scope, Source},
    hybrid::{Calibration, Retriever},
    index::Entry,
    semantic::{Config, Semantic, Status},
};

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn digest(text: &str) -> String {
    ring::digest::digest(&ring::digest::SHA256, text.as_bytes())
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn documents(corpus: &Corpus) -> Vec<Document> {
    let concepts = corpus.concepts.iter().map(|c| {
        let hash = digest(&format!("{}{}{}{}", c.id, c.title, c.description, c.body));
        (
            Kind::Concept,
            c.id.clone(),
            Fields {
                title: c.title.clone(),
                description: c.description.clone(),
                body: c.body.clone(),
                tags: c.tags.clone(),
                identifiers: c.identifiers.clone(),
                ..Fields::default()
            },
            None,
            hash,
        )
    });
    let skills = corpus.skills.iter().map(|s| {
        let hash = digest(&format!("{}{}{}", s.id, s.description, s.keywords));
        (
            Kind::Skill,
            s.id.clone(),
            Fields {
                title: s.name.clone(),
                description: s.description.clone(),
                keywords: s.keywords.split(',').map(|k| k.trim().to_owned()).collect(),
                ..Fields::default()
            },
            Some(if s.auto {
                Activation::Auto
            } else {
                Activation::Manual
            }),
            hash,
        )
    });
    concepts
        .chain(skills)
        .map(|(kind, id, fields, activation, hash)| Document {
            source: Source {
                path: format!("{id}.md"),
                revision: "1".into(),
                content_hash: hash,
            },
            id,
            kind,
            scope: Scope::Knowledge,
            fields,
            lifecycle: Lifecycle {
                activation,
                ..Lifecycle::default()
            },
        })
        .collect()
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

fn sync(retriever: &Retriever, docs: &[Document]) -> u128 {
    let started = Instant::now();
    retriever
        .sync(
            &manifest(docs),
            |entry| {
                docs.iter()
                    .find(|d| d.id == entry.id && d.kind == entry.kind)
                    .cloned()
            },
            Instant::now() + Duration::from_secs(600),
        )
        .unwrap();
    started.elapsed().as_micros()
}

fn query_for(item: &Labelled, limit: usize) -> Query {
    Query {
        text: item.text.clone(),
        kinds: vec![if item.skill {
            Kind::Skill
        } else {
            Kind::Concept
        }],
        implicit: item.skill,
        limit,
        ..Query::default()
    }
}

fn ids(retriever: &Retriever, item: &Labelled) -> Vec<String> {
    retriever
        .search(&query_for(item, 10))
        .candidates
        .into_iter()
        .map(|c| c.id)
        .collect()
}

fn wait_ready(semantic: &Semantic, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        match semantic.status() {
            Status::Ready => return true,
            Status::Failed => return false,
            _ => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    false
}

fn wait_embedded(semantic: &Semantic, limit: Duration) {
    let deadline = Instant::now() + limit;
    while semantic.pending() > 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn content_tokens(corpus: &Corpus, ids: &[String], skill: bool, take: usize) -> usize {
    ids.iter()
        .take(take)
        .map(|id| {
            if skill {
                corpus
                    .skills
                    .iter()
                    .find(|s| &s.id == id)
                    .map_or(0, |s| s.description.len() + s.name.len())
            } else {
                corpus
                    .concepts
                    .iter()
                    .find(|c| &c.id == id)
                    .map_or(0, |c| c.title.len() + c.body.len())
            }
        })
        .sum::<usize>()
        .div_ceil(4)
}

type Views = (Vec<String>, Vec<String>);

struct Run<'a> {
    corpus: &'a Corpus,
    results: Vec<Views>,
}

impl Run<'_> {
    fn report(&self) -> Value {
        let rows = |pick: fn(&Views) -> &Vec<String>| {
            metrics::summarize(
                self.corpus
                    .queries
                    .iter()
                    .zip(self.results.iter().map(pick)),
            )
        };
        let (mut tokens, mut wasted) = (0, 0);
        for (query, (_, auto)) in self.corpus.queries.iter().zip(&self.results) {
            let used = content_tokens(self.corpus, auto, query.skill, 3);
            let relevant: Vec<String> = auto
                .iter()
                .filter(|id| query.relevant.contains_key(*id))
                .cloned()
                .collect();
            tokens += used;
            wasted += used - content_tokens(self.corpus, &relevant, query.skill, 3).min(used);
        }
        json!({
            "ranked": rows(|r| &r.0),
            "auto": rows(|r| &r.1),
            "injected_tokens": tokens,
            "wasted_injected_tokens": wasted,
        })
    }
}

fn ranked_calibration() -> Calibration {
    Calibration {
        bm25_floor: 0.0,
        cosine_floor: -1.0,
        lexical_sufficient: f64::MAX,
        ..Calibration::default()
    }
}

fn passes(corpus: &Corpus, mut search: impl FnMut(&Labelled) -> Vec<String>) -> (Vec<u128>, u128) {
    let mut samples = Vec::new();
    let first = Instant::now();
    for item in &corpus.queries {
        search(item);
    }
    let cold = first.elapsed().as_micros();
    for _ in 0..5 {
        for item in &corpus.queries {
            let started = Instant::now();
            search(item);
            samples.push(started.elapsed().as_micros());
        }
    }
    samples.sort_unstable();
    (samples, cold)
}

fn latency(samples: &[u128]) -> Value {
    json!({"samples": samples.len(), "p50_us": metrics::percentile(samples, 50), "p95_us": metrics::percentile(samples, 95)})
}

fn semantic_for(root: &Path, models: &Path) -> Arc<Semantic> {
    Semantic::new(Config::new(
        models.to_owned(),
        Some(root.join("vectors.bin")),
    ))
}

fn dump(corpus: &Corpus, ranked: &Retriever) -> Value {
    Value::Array(
        corpus
            .queries
            .iter()
            .map(|q| {
                let result = ranked.search(&query_for(q, 50));
                json!({
                    "id": q.id, "skill": q.skill, "category": q.category, "holdout": q.holdout,
                    "relevant": q.relevant, "terms": result.signals.query_terms,
                    "matched": result.signals.matched_terms, "top_bm25": result.signals.top_bm25,
                    "second_bm25": result.signals.second_bm25,
                    "candidates": result.candidates.iter().map(|c| json!({
                        "id": c.id, "method": c.method.as_str(),
                        "bm25": c.score(Method::Bm25).map(|s| s.score),
                        "cosine": c.score(Method::Semantic).map(|s| s.score),
                    })).collect::<Vec<_>>(),
                })
            })
            .collect(),
    )
}

fn variant_bm25(corpus: &Corpus, root: &Path) -> Value {
    let docs = documents(corpus);
    let index = root.join("bm25");
    let auto = Retriever::open(Some(index.clone()), None, Calibration::default());
    let build_us = sync(&auto, &docs);
    let ranked = Retriever::open(Some(index.clone()), None, ranked_calibration());
    let reopen_us = sync(
        &Retriever::open(Some(index.clone()), None, Calibration::default()),
        &docs,
    );
    let results: Vec<_> = corpus
        .queries
        .iter()
        .map(|q| (ids(&ranked, q), ids(&auto, q)))
        .collect();
    let (samples, cold) = passes(corpus, |q| ids(&auto, q));
    json!({
        "variant": "bm25", "index_build_us": build_us, "reopen_sync_us": reopen_us, "first_pass_us": cold,
        "latency": latency(&samples), "index_disk_bytes": metrics::directory_bytes(&index),
        "quality": Run { corpus, results }.report(), "dump": dump(corpus, &ranked),
    })
}

fn dense(semantic: &Semantic, retriever: &Retriever, item: &Labelled, floor: f32) -> Vec<String> {
    let Some(vector) = semantic.query_vector(&item.text) else {
        return Vec::new();
    };
    let kind = if item.skill {
        Kind::Skill
    } else {
        Kind::Concept
    };
    let metas = retriever.engine().metas();
    let candidates = metas
        .iter()
        .filter(|(_, m)| m.kind == kind && !(item.skill && m.manual))
        .map(|(k, m)| (k.as_str(), m.hash.as_str()));
    semantic
        .nearest(&vector, candidates, floor, 10)
        .into_iter()
        .filter_map(|(key, _)| {
            metas
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, m)| m.id.clone())
        })
        .collect()
}

fn prepared_semantic(
    corpus: &Corpus,
    root: &Path,
    models: &Path,
) -> (Arc<Semantic>, Retriever, Value) {
    let docs = documents(corpus);
    let semantic = semantic_for(root, models);
    let started = Instant::now();
    semantic.warm();
    let ready = wait_ready(&semantic, Duration::from_secs(900));
    let load_ms = started.elapsed().as_millis();
    assert!(ready, "embedding model unavailable");
    let retriever = Retriever::open(
        Some(root.join("hybrid")),
        Some(semantic.clone()),
        Calibration::default(),
    );
    let build_us = sync(&retriever, &docs);
    let embed_started = Instant::now();
    wait_embedded(&semantic, Duration::from_secs(900));
    let embed_ms = embed_started.elapsed().as_millis();
    let _ = semantic.cache().persist();
    let mut query_us: Vec<u128> = corpus
        .queries
        .iter()
        .map(|q| {
            let t = Instant::now();
            semantic.query_vector(&q.text).unwrap();
            t.elapsed().as_micros()
        })
        .collect();
    query_us.sort_unstable();
    let info = json!({
        "provision_and_load_ms": load_ms, "lexical_sync_us": build_us, "document_embedding_ms": embed_ms,
        "documents_embedded": semantic.cache().len(), "vector_cache_bytes": fs::metadata(root.join("vectors.bin")).map_or(0, |m| m.len()),
        "query_embedding": latency(&query_us),
    });
    (semantic, retriever, info)
}

fn variant_bge(corpus: &Corpus, root: &Path, models: &Path) -> Value {
    let (semantic, retriever, overhead) = prepared_semantic(corpus, root, models);
    let floor = Calibration::default().cosine_floor;
    let results: Vec<_> = corpus
        .queries
        .iter()
        .map(|q| {
            (
                dense(&semantic, &retriever, q, -1.0),
                dense(&semantic, &retriever, q, floor),
            )
        })
        .collect();
    let (samples, cold) = passes(corpus, |q| dense(&semantic, &retriever, q, floor));
    json!({"variant": "bge", "overhead": overhead, "first_pass_us": cold, "latency": latency(&samples),
           "quality": Run { corpus, results }.report()})
}

fn variant_hybrid(corpus: &Corpus, root: &Path, models: &Path) -> Value {
    let (semantic, auto, overhead) = prepared_semantic(corpus, root, models);
    let ranked = Retriever::open(
        Some(root.join("hybrid")),
        Some(semantic.clone()),
        Calibration {
            bm25_floor: Calibration::default().bm25_floor,
            ..ranked_calibration()
        },
    );
    sync(&ranked, &documents(corpus));
    let results: Vec<_> = corpus
        .queries
        .iter()
        .map(|q| (ids(&ranked, q), ids(&auto, q)))
        .collect();
    let skipped = corpus
        .queries
        .iter()
        .filter(|q| {
            auto.search(&query_for(q, 10)).signals.semantic
                == ycoding_core::resources::recall::candidate::Semantic::NotNeeded
        })
        .count();
    let (samples, cold) = passes(corpus, |q| ids(&auto, q));
    json!({"variant": "hybrid", "overhead": overhead, "queries_without_inference": [skipped, corpus.queries.len()],
           "first_pass_us": cold, "latency": latency(&samples),
           "index_disk_bytes": metrics::directory_bytes(&root.join("hybrid")),
           "quality": Run { corpus, results }.report(), "dump": dump(corpus, &ranked)})
}

fn variant_scale(root: &Path, count: usize) -> Value {
    let corpus = corpus::load();
    let sentences: Vec<String> = corpus
        .concepts
        .iter()
        .flat_map(|c| c.body.split(". ").map(str::to_owned).collect::<Vec<_>>())
        .collect();
    let mut seed = 0x2545F491u64;
    let mut next = || {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (seed >> 33) as usize
    };
    let docs: Vec<Document> = (0..count)
        .map(|i| {
            let mut body = String::new();
            while body.len() < 8_000 {
                body.push_str(&sentences[next() % sentences.len()]);
                body.push_str(". ");
            }
            let id = format!("scale/doc-{i:05}");
            Document {
                source: Source {
                    path: format!("{id}.md"),
                    revision: "1".into(),
                    content_hash: digest(&body),
                },
                id,
                kind: Kind::Concept,
                scope: Scope::Knowledge,
                fields: Fields {
                    title: format!("note {i}"),
                    body,
                    ..Fields::default()
                },
                lifecycle: Lifecycle::default(),
            }
        })
        .collect();
    let index = root.join("scale");
    let retriever = Retriever::open(Some(index.clone()), None, Calibration::default());
    let build_us = sync(&retriever, &docs);
    let disk = metrics::directory_bytes(&index);
    let queries: Vec<String> = (0..100)
        .map(|_| {
            let s = &sentences[next() % sentences.len()];
            s.split_whitespace().take(5).collect::<Vec<_>>().join(" ")
        })
        .collect();
    let mut samples: Vec<u128> = queries
        .iter()
        .map(|q| {
            let t = Instant::now();
            retriever.search(&Query {
                text: q.clone(),
                limit: 5,
                ..Query::default()
            });
            t.elapsed().as_micros()
        })
        .collect();
    samples.sort_unstable();
    let mut changed = docs.clone();
    changed[0].fields.body.push_str(" additional note");
    changed[0].source.content_hash = digest(&changed[0].fields.body);
    let update_us = sync(&retriever, &changed);
    let reopened = Retriever::open(Some(index), None, Calibration::default());
    let reopen_us = sync(&reopened, &changed);
    json!({"variant": "scale", "documents": count, "input_bytes": docs.iter().map(|d| d.fields.body.len()).sum::<usize>(),
           "index_build_us": build_us, "index_disk_bytes": disk, "query_latency": latency(&samples),
           "single_document_update_us": update_us, "cold_reopen_sync_us": reopen_us})
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = env::args().skip(1).filter(|a| a != "--bench").collect();
    let flag = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let parent = flag("--scratch").expect("--scratch <dir>");
    let variant = flag("--variant").expect("--variant bm25|bge|hybrid|scale|prefix");
    let root = Scratch(
        fs::canonicalize(parent)
            .unwrap()
            .join(format!("cue-recall-{variant}-{}", std::process::id())),
    );
    fs::create_dir_all(&root.0).unwrap();
    let models = flag("--models").map(PathBuf::from);
    let corpus = corpus::load();
    let mut report = match variant.as_str() {
        "bm25" => variant_bm25(&corpus, &root.0),
        "bge" => variant_bge(&corpus, &root.0, models.as_deref().expect("--models <dir>")),
        "hybrid" => variant_hybrid(&corpus, &root.0, models.as_deref().expect("--models <dir>")),
        "scale" => variant_scale(
            &root.0,
            flag("--documents").map_or(1000, |n| n.parse().unwrap()),
        ),
        "prefix" => prefix_metrics(&root.0).await,
        other => panic!("unknown variant {other}"),
    };
    let usage = metrics::usage();
    report["process"] = json!({"cpu_ms": usage.cpu_ms, "peak_rss_bytes": usage.peak_rss_bytes});
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}

async fn prefix_metrics(root: &std::path::Path) -> Value {
    use std::sync::Arc;
    use ycoding_ai::{llm, openai_chat, route::Route};
    use ycoding_core::{
        resources::memory::{Limits, Options, Repository, Scope, Service},
        session::{compaction_gate, recall::Context},
    };
    use ycoding_schema::{
        DomainDecode, parse_json, permission, provider, session_message, stringify_json,
    };

    let repo = root.join("prefix-repository");
    let git = repo.join(".git");
    fs::create_dir_all(&git).unwrap();
    let service = Arc::new(
        Service::new(Options {
            directory: repo.clone(),
            data: root.join("prefix-data"),
            home: root.to_owned(),
            repository: Some(Repository {
                directory: repo.clone(),
                common_directory: git,
                worktrees: vec![repo],
            }),
            limits: Limits::default(),
        })
        .unwrap(),
    );
    service
        .write(
            Scope::Repository,
            "fixture/cobalt",
            "---\ntype: Decision\n---\ncobalt canary details.\n",
            None,
            false,
        )
        .await
        .unwrap();
    service
        .write(
            Scope::Repository,
            "fixture/amber",
            "---\ntype: Decision\n---\namber heron details.\n",
            None,
            false,
        )
        .await
        .unwrap();
    let policy = policy_fixture::Fixture::default();
    *policy.rules.lock().unwrap() = permission::Ruleset::decode(&parse_json(r#"[{"action":"memory","resource":"*","effect":"allow"},{"action":"memory_read","resource":"*","effect":"allow"}]"#).unwrap()).unwrap();
    let session = policy.session("ses_fixture_prefix", None, 0, false, None);
    let recall = Context {
        memory: service,
        permissions: policy.permissions(),
    };
    let mut base = llm::Request::new(llm::Model {
        id: "fixture".into(),
        provider: provider::Id("fixture".into()),
        route: Arc::new(Route::openai_chat()),
        defaults: Default::default(),
        tool_schema: None,
        supports_temperature: true,
    });
    base.messages
        .push(llm::Message::user("fixed synthetic task"));
    base.tools.push(llm::ToolDefinition {
        name: "memory".into(),
        description: "Read references".into(),
        input_schema: parse_json(r#"{"type":"object"}"#).unwrap(),
        output_schema: None,
        cache: None,
        metadata: None,
        native: None,
    });
    let mut wires = Vec::new();
    let mut estimates = Vec::new();
    let mut added = Vec::new();
    for text in ["cobalt canary", "cobalt canary", "amber heron"] {
        let user = session_message::Info::decode(&parse_json(&format!(r#"{{"type":"user","id":"msg_fixture","time":{{"created":1,"consumed":2}},"text":"{text}"}}"#)).unwrap()).unwrap();
        let mut request = base.clone();
        recall
            .append(&session, &"test".into(), &[user], &mut request, 4096, 2048)
            .await;
        added.push(request.messages.len() - base.messages.len());
        estimates.push(compaction_gate::estimated_provider_input_tokens(&request));
        wires.push(stringify_json(&openai_chat::lower(&request).unwrap()));
    }
    let shared = |a: &str, b: &str| a.bytes().zip(b.bytes()).take_while(|(x, y)| x == y).count();
    assert_eq!(added, [1, 1, 1]);
    assert_eq!(wires[0], wires[1]);
    assert_ne!(wires[0], wires[2]);
    json!({"wire_bytes":wires.iter().map(String::len).collect::<Vec<_>>(),"identical_equal":wires[0] == wires[1],"identical_common_prefix_bytes":shared(&wires[0],&wires[1]),"changed_suffix_common_prefix_bytes":shared(&wires[0],&wires[2]),"changed_suffix_distinct":wires[0] != wires[2],"added_messages":added,"estimated_input_tokens":estimates})
}
