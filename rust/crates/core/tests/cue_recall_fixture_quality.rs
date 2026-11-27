use serde_json::Value;
use std::{fs, path::PathBuf};
use ycoding_core::resources::memory::{Limits, Options, Scope, Search, Service};

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[tokio::test]
async fn held_out_fixture_meets_retrieval_quality() {
    let path = std::env::temp_dir().join(format!("ycoding-cue-quality-{}", std::process::id()));
    fs::create_dir(&path).unwrap();
    let root = Scratch(fs::canonicalize(path).unwrap());
    let store = Service::new(Options {
        directory: root.0.clone(),
        data: root.0.clone(),
        home: root.0.clone(),
        repository: None,
        limits: Limits::default(),
    })
    .unwrap();
    let corpus: Value =
        serde_json::from_str(include_str!("../benches/cue-recall-corpus.json")).unwrap();
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
                false,
            )
            .await
            .unwrap();
    }

    let mut correct = 0;
    let mut recalled = 0;
    let mut relevant = 0;
    let mut total = 0;
    let mut negatives = 0;
    for query in corpus["queries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|q| q["split"] == "holdout")
    {
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
        let expected = query["relevant"].as_array().unwrap();
        if expected.is_empty() {
            negatives += 1;
            assert!(hits.is_empty(), "unexpected results for {}", query["query"]);
        }
        relevant += expected.len();
        recalled += expected
            .iter()
            .filter(|id| hits.iter().any(|hit| *id == &hit.summary.id))
            .count();
        let answer = hits.first().map(|hit| {
            let content = store
                .read(Scope::Knowledge, &hit.summary.id)
                .unwrap()
                .content;
            content
                .split_once("Diagnostic code: ")
                .unwrap()
                .1
                .trim_end()
                .trim_end_matches('.')
                .to_owned()
        });
        correct += usize::from(answer.as_deref() == query["answer"].as_str());
        total += 1;
    }
    println!(
        "diagnostics {correct}/{total}; recall@5 {recalled}/{relevant}; abstentions {negatives}/2"
    );
    assert_eq!((total, relevant, negatives), (10, 8, 2));
    assert!(correct >= 8, "diagnostic answers: {correct}/{total}");
    assert!(recalled >= 6, "recall@5: {recalled}/{relevant}");
}
