use serde_json::{Value, json};
use std::{env, fs, path::PathBuf, time::Instant};
use ycoding_core::resources::memory::{Limits, Options, Scope, Search, Service};
use ycoding_core::session::skill::triggered;
use ycoding_schema::{JsonValue, parse_json};

#[path = "../tests/policy_fixture.rs"]
mod policy_fixture;

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).expect("remove synthetic corpus");
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let parent = env::args_os()
        .skip(1)
        .find(|arg| arg != "--bench")
        .expect("supply a private scratch directory");
    let path = fs::canonicalize(parent)
        .unwrap()
        .join(format!("cue-recall-bench-{}", std::process::id()));
    fs::create_dir(&path).expect("create a fresh fixture directory");
    let root = Scratch(path);
    let store = Service::new(Options {
        directory: root.0.clone(),
        data: root.0.clone(),
        home: root.0.clone(),
        repository: None,
        limits: Limits::default(),
    })
    .unwrap();
    let corpus: Value = serde_json::from_str(include_str!("cue-recall-corpus.json")).unwrap();
    let setup = Instant::now();
    for concept in corpus["concepts"].as_array().unwrap() {
        store
            .write(
                Scope::Knowledge,
                concept["id"].as_str().unwrap(),
                &format!(
                    "---\ntype: Reference\ntitle: {}\ntags: {}\n---\n{}\n",
                    concept["title"],
                    concept["tags"],
                    concept["body"].as_str().unwrap()
                ),
                None,
            )
            .await
            .unwrap();
    }
    let setup_us = setup.elapsed().as_micros();
    let queries: Vec<_> = corpus["queries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|query| query["split"] == "holdout")
        .collect();
    let mut latency = Vec::new();
    let mut recall = 0;
    let mut relevant = 0;
    let mut answered = 0;
    let mut first_us = None;
    let mut query_bytes = 0;
    let mut returned_content_bytes = 0;
    let mut query_results = Vec::new();
    for pass in 0..4 {
        for query in &queries {
            let start = Instant::now();
            let hits = store
                .search(
                    Scope::Knowledge,
                    Search {
                        query: query["query"].as_str().unwrap(),
                        limit: Some(5),
                        type_: None,
                        tag: None,
                    },
                )
                .unwrap()
                .hits;
            let elapsed = start.elapsed().as_micros();
            first_us.get_or_insert(elapsed);
            if pass != 0 {
                latency.push(elapsed);
                continue;
            }
            query_bytes += query["query"].as_str().unwrap().len();
            let mut first_content = None;
            for hit in &hits {
                let content = store
                    .read(Scope::Knowledge, &hit.summary.id)
                    .unwrap()
                    .content;
                returned_content_bytes += content.len();
                if first_content.is_none() {
                    first_content = Some(content);
                }
            }
            for id in query["relevant"].as_array().unwrap() {
                relevant += 1;
                recall += usize::from(hits.iter().any(|hit| id == &hit.summary.id));
            }
            let answer = first_content.as_ref().map(|content| {
                content
                    .split_once("Diagnostic code: ")
                    .unwrap()
                    .1
                    .trim_end()
                    .trim_end_matches('.')
                    .to_owned()
            });
            answered += usize::from(answer.as_deref() == query["answer"].as_str());
            query_results.push(json!({"query":query["query"],"expected":query["answer"],"observed":answer,"latency_us":elapsed,"hits":hits.iter().map(|hit| &hit.summary.id).collect::<Vec<_>>() }));
        }
    }
    let index_bytes = directory_bytes(&root.0.join("recall/index"));
    let before = store.read(Scope::Knowledge, "build/linker").unwrap();
    let update = Instant::now();
    store
        .write(
            Scope::Knowledge,
            "build/linker",
            &format!("{}\nAdditional synthetic note.\n", before.content),
            Some(&before.digest),
        )
        .await
        .unwrap();
    let write_update_us = update.elapsed().as_micros();
    let update_index = Instant::now();
    store
        .search(
            Scope::Knowledge,
            Search {
                query: "build/linker",
                limit: Some(5),
                type_: None,
                tag: None,
            },
        )
        .unwrap();
    let update_search_us = update_index.elapsed().as_micros();
    let index_bytes_after = directory_bytes(&root.0.join("recall/index"));
    let prefix = prefix_metrics(&root.0).await;
    let fixtures = [
        (
            r#"{"activation":"auto","commands":"cargo check"}"#,
            vec!["cargo", "check"],
            true,
        ),
        (
            r#"{"activation":"auto","commands":"cargo check"}"#,
            vec!["cargo", "checker"],
            false,
        ),
        (
            r#"{"activation":"manual","commands":"cargo check"}"#,
            vec!["cargo", "check"],
            false,
        ),
        (
            r#"{"activation":"auto","commands":"cargo check"}"#,
            vec!["cargo", "check", "--workspace"],
            true,
        ),
    ];
    let mut skill_selected = 0;
    let mut skill_correct = 0;
    let mut skill_negative = 0;
    let mut skill_abstain = 0;
    for (metadata, argv, expected) in fixtures {
        let JsonValue::Object(metadata) = parse_json(metadata).unwrap() else {
            panic!()
        };
        let argv: Vec<String> = argv.into_iter().map(str::to_owned).collect();
        let selected = triggered(&metadata, "command.invoked", Some(&argv));
        skill_selected += usize::from(selected);
        skill_correct += usize::from(selected && expected);
        skill_negative += usize::from(!expected);
        skill_abstain += usize::from(!selected && !expected);
    }
    latency.sort_unstable();
    println!(
        "{}",
        json!({
            "corpus_version": corpus["version"], "queries": queries.len(), "recall_at_5": [recall, relevant],
            "diagnostic_answer_correct": [answered, queries.len()], "write_setup_us": setup_us, "first_query_us": first_us,
            "warm_samples": latency.len(), "warm_p50_us": latency[latency.len().div_ceil(2)-1],
            "warm_p95_us": latency[(latency.len()*95).div_ceil(100)-1],
            "query_utf8_bytes":query_bytes,"retrieved_content_utf8_bytes":returned_content_bytes,
            "query_results":query_results,"persistent_index_bytes":index_bytes,"persistent_index_bytes_after_update":index_bytes_after,
            "source_update_us":write_update_us,"post_update_search_us":update_search_us,
            "native_skill_command_cue_precision":[skill_correct,skill_selected],"native_skill_negative_abstention":[skill_abstain,skill_negative],
            "request_prefix":prefix
        })
    );
}

async fn prefix_metrics(root: &std::path::Path) -> Value {
    use std::sync::Arc;
    use ycoding_ai::{llm, openai_chat, route::Route};
    use ycoding_core::{
        resources::memory::Repository,
        session::{compaction_gate, recall::Context},
    };
    use ycoding_schema::{DomainDecode, permission, provider, session_message, stringify_json};

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
        )
        .await
        .unwrap();
    service
        .write(
            Scope::Repository,
            "fixture/amber",
            "---\ntype: Decision\n---\namber heron details.\n",
            None,
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

fn directory_bytes(path: &std::path::Path) -> u64 {
    match fs::read_dir(path) {
        Ok(entries) => entries
            .map(|entry| {
                let entry = entry.unwrap();
                let metadata = entry.metadata().unwrap();
                if metadata.is_dir() {
                    directory_bytes(&entry.path())
                } else {
                    metadata.len()
                }
            })
            .sum(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => panic!("read index size: {error}"),
    }
}
