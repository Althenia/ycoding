use std::path::PathBuf;
use ycoding_ai::cursor::models::available_models;
use ycoding_core::resources::cursor::cache::{self, Cache};
use ycoding_schema::parse_json;

#[derive(Debug)]
struct Failure(String);
impl From<std::io::Error> for Failure {
    fn from(error: std::io::Error) -> Self {
        Self(error.to_string())
    }
}

fn directory(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "cursor-models-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&directory).unwrap();
    directory
}

fn discovered() -> Vec<ycoding_ai::cursor::models::Info> {
    available_models(
        &parse_json(
            r#"{"models":[{"name":"composer-2.5","clientDisplayName":"Composer 2.5","supportsThinking":true,"variants":[{"parameterValues":[{"id":"effort","value":"high"},{"id":"context","value":"200k"}],"isDefaultNonMaxConfig":true}]}]}"#,
        )
        .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn discovered_models_and_variant_tuples_survive_a_failed_refresh() {
    let directory = directory("retain");
    let models = discovered();
    assert_eq!(models[0].id.as_str(), Some("composer-2.5"));
    assert_eq!(models[0].max_context, Some(200_000.0));
    assert_eq!(
        models[0].variants[0].parameters,
        [
            ("effort".into(), "high".into()),
            ("context".into(), "200k".into())
        ]
    );
    cache::refresh(&directory, 10.0, || async {
        Ok::<_, Failure>(models.clone())
    })
    .await
    .unwrap();
    let failure = cache::refresh(&directory, 20.0, || async {
        Err::<Vec<_>, _>(Failure("discovery denied".into()))
    })
    .await
    .unwrap_err();
    assert_eq!(failure.0, "discovery denied");
    let cached = cache::read(&directory).unwrap();
    assert_eq!(
        cached,
        Cache {
            models,
            fetched_at: 10.0
        }
    );
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn discovery_serves_fresh_cache_and_stale_cache_on_failure_but_not_when_forced() {
    let directory = directory("discover");
    let models = discovered();
    assert!(cache::read(&directory).is_none());
    let fetched = cache::discover(&directory, 0.0, false, || async {
        Ok::<_, Failure>(models.clone())
    })
    .await
    .unwrap();
    assert_eq!(fetched, models);
    let fresh = cache::discover(&directory, 1.0, false, || async {
        Err::<Vec<_>, _>(Failure("must not fetch".into()))
    })
    .await
    .unwrap();
    assert_eq!(fresh, models);
    let stale = cache::discover(&directory, cache::TTL_MS + 1.0, false, || async {
        Err::<Vec<_>, _>(Failure("offline".into()))
    })
    .await
    .unwrap();
    assert_eq!(stale, models);
    let forced = cache::discover(&directory, 1.0, true, || async {
        Err::<Vec<_>, _>(Failure("forced".into()))
    })
    .await
    .unwrap_err();
    assert_eq!(forced.0, "forced");
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn invalid_or_foreign_cache_files_are_ignored_and_malformed_variants_are_rejected() {
    let directory = directory("invalid");
    std::fs::write(
        cache::path(&directory),
        r#"{"models":[],"fetchedAt":1,"schemaVersion":2}"#,
    )
    .unwrap();
    assert!(cache::read(&directory).is_none());
    std::fs::write(
        cache::path(&directory),
        r#"{"models":[{"id":"x","variants":"invalid"}],"fetchedAt":1,"schemaVersion":3}"#,
    )
    .unwrap();
    assert!(cache::read(&directory).is_none());
    std::fs::write(cache::path(&directory), "{").unwrap();
    assert!(cache::read(&directory).is_none());
    assert!(
        available_models(
            &parse_json(r#"{"models":[{"name":"broken","variants":"invalid"}]}"#).unwrap()
        )
        .is_err()
    );
    std::fs::remove_dir_all(directory).unwrap();
}
