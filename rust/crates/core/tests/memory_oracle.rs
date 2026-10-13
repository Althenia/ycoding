use ycoding_core::resources::memory::{
    format::{self, Concept, Summary},
    graph::{self, Node},
};

#[test]
fn marked_link_and_citation_corpus_matches_locked_ts_lexer() {
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("../src/resources/memory/corpus.json")).unwrap();
    let mut failures = Vec::new();
    for case in corpus["formats"].as_array().unwrap() {
        let body = case["body"].as_str().unwrap();
        let parsed = format::parse(
            "entry",
            &format!(
                "---\ntype: Guide\nsources: [{{id: spec, resource: repo:///README.md}}]\n---\n{body}"
            ),
        );
        if parsed.is_ok() != case["valid"].as_bool().unwrap() {
            failures.push(format!("validity {body:?}"));
        }
        if let Ok(concept) = parsed
            && serde_json::json!(concept.links) != case["links"]
        {
            failures.push(format!(
                "links {body:?}: {:?} != {}",
                concept.links, case["links"]
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn unicode_lexical_words_match_ts_property_regexp() {
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("../src/resources/memory/corpus.json")).unwrap();
    for case in corpus["words"].as_array().unwrap() {
        let words = format::words(case["query"].as_str().unwrap())
            .unwrap()
            .into_iter()
            .collect::<Vec<_>>();
        assert_eq!(serde_json::json!(words), case["words"]);
    }
}

#[test]
fn yaml_metadata_preserves_js_yaml_utf16_escape_values() {
    let concept = format::parse(
        "metadata",
        "---\ntype: Guide\ntitle: \"\\uD800\"\n---\nBody\n",
    )
    .unwrap();
    assert_eq!(
        concept
            .summary
            .title
            .as_ref()
            .unwrap()
            .code_units()
            .collect::<Vec<_>>(),
        [0xd800]
    );
    assert!(
        graph::render(&[Node {
            id: "knowledge/metadata".into(),
            concept: &concept
        }])
        .html
        .contains("\\ud800")
    );
}

#[test]
fn offline_graph_html_matches_original_ts_bytes() {
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("../src/resources/memory/corpus.json")).unwrap();
    let concepts = corpus["graph"]["concepts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| Concept {
            summary: Summary {
                id: c["id"].as_str().unwrap().into(),
                type_: c["type"].as_str().unwrap().into(),
                digest: c["digest"].as_str().unwrap().into(),
                title: c["title"].as_str().map(Into::into),
                description: None,
                tags: None,
            },
            content: c["content"].as_str().unwrap().into(),
            body: String::new(),
            links: c["links"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().into())
                .collect(),
        })
        .collect::<Vec<_>>();
    let nodes = concepts
        .iter()
        .map(|concept| Node {
            id: format!("knowledge/{}", concept.summary.id),
            concept,
        })
        .collect::<Vec<_>>();
    let rendered = graph::render(&nodes);
    assert_eq!(
        rendered.nodes,
        corpus["graph"]["nodes"].as_u64().unwrap() as usize
    );
    assert_eq!(
        rendered.edges,
        corpus["graph"]["edges"].as_u64().unwrap() as usize
    );
    assert_eq!(
        format::sha256(rendered.html),
        corpus["graph"]["digest"].as_str().unwrap()
    );
}

#[tokio::test]
async fn snippets_preserve_ts_utf16_slice_boundaries() {
    use ycoding_core::resources::memory::{Limits, Options, Scope, Search, Service};
    let path = std::env::temp_dir().join(format!("ycoding-memory-snippet-{}", std::process::id()));
    std::fs::create_dir(&path).unwrap();
    let path = std::fs::canonicalize(path).unwrap();
    let store = Service::new(Options {
        directory: path.clone(),
        home: path.clone(),
        data: path.clone(),
        repository: None,
        limits: Limits::default(),
    })
    .unwrap();
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("../src/resources/memory/corpus.json")).unwrap();
    for (index, case) in corpus["snippets"].as_array().unwrap().iter().enumerate() {
        store
            .write(
                Scope::Knowledge,
                &format!("snippet-{index}"),
                &format!(
                    "---\ntype: Guide\ntitle: a\n---\n{}",
                    case["body"].as_str().unwrap()
                ),
                None,
            )
            .await
            .unwrap();
        let result = store
            .search(
                Scope::Knowledge,
                Search {
                    query: case["query"].as_str().unwrap(),
                    limit: None,
                    type_: None,
                    tag: None,
                },
            )
            .unwrap();
        let units = result.hits[0].snippet.code_units().collect::<Vec<_>>();
        assert_eq!(serde_json::json!(units), case["units"]);
    }
    std::fs::remove_dir_all(path).unwrap();
}
