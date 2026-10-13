use ycoding_core::platform::filesystem::{fuzzy, glob, mime_type};

#[test]
fn minimatch_dot_true_matches_cached_version_10_2_5_corpus() {
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("../src/platform/filesystem/corpus.json")).unwrap();
    for case in corpus["glob"].as_array().unwrap() {
        let pattern = case["pattern"].as_str().unwrap();
        let path = case["path"].as_str().unwrap();
        assert_eq!(
            glob::matches(pattern, path).unwrap(),
            case["matched"].as_bool().unwrap(),
            "pattern={pattern:?}, path={path:?}"
        );
    }
}

#[test]
fn fuzzysort_ranking_matches_cached_version_3_1_0_corpus() {
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("../src/platform/filesystem/corpus.json")).unwrap();
    for case in corpus["fuzzy"].as_array().unwrap() {
        let targets: Vec<_> = case["targets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_string())
            .collect();
        let expected: Vec<_> = case["expected"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            fuzzy::find(
                case["query"].as_str().unwrap(),
                &targets,
                case["limit"].as_u64().unwrap() as usize
            ),
            expected,
            "query={:?}, limit={}",
            case["query"],
            case["limit"]
        );
    }
}

#[test]
fn mime_database_preserves_types_and_unknown_extensions() {
    for (path, expected) in [
        ("file.json", "application/json"),
        ("image.png", "image/png"),
        ("text.txt", "text/plain"),
        ("README.md", "text/markdown"),
        ("file.JSON", "application/json"),
        ("unknown.qzx", "application/octet-stream"),
        ("json", "application/json"),
        (".json", "application/json"),
        ("/tmp/.json", "application/octet-stream"),
    ] {
        assert_eq!(mime_type(path), expected);
    }
}
