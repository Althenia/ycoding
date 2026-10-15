use axum::{
    Router,
    body::Body,
    extract::{Request, State},
    response::Response,
    routing::any,
};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use ycoding_core::resources::{
    auth::{self, integration},
    catalog::{AccountCatalog, Catalog, models_dev},
    config::{Configuration, LoadOptions, Roots},
    credential,
    discovery::wellknown,
    model, reference,
};
use ycoding_schema::{DomainEncode, JsonValue, parse_json, provider};
use ycoding_store::{Metadata, Options, Store, resources};

#[path = "filesystem_fixture.rs"]
mod filesystem_fixture;
use filesystem_fixture::{Fixture, git};

type Requests = Arc<Mutex<Vec<(String, String)>>>;
type Reply = Arc<Mutex<(u16, String)>>;

struct Server {
    origin: String,
    response: Reply,
    requests: Requests,
    stop: tokio::sync::oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}
impl Server {
    async fn new(body: &str) -> Self {
        let response = Arc::new(Mutex::new((200, body.to_owned())));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let app = Router::new()
            .fallback(any(
                |State((response, requests)): State<(Reply, Requests)>,
                 request: Request| async move {
                    requests.lock().unwrap().push((
                        request.uri().path().to_owned(),
                        request
                            .headers()
                            .get("authorization")
                            .map_or("", |v| v.to_str().unwrap())
                            .to_owned(),
                    ));
                    let (status, body) = response.lock().unwrap().clone();
                    Response::builder()
                        .status(status)
                        .header("content-type", "application/json")
                        .body(Body::from(body))
                        .unwrap()
                },
            ))
            .with_state((response.clone(), requests.clone()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
                .unwrap();
        });
        Self {
            origin,
            response,
            requests,
            stop,
            task,
        }
    }
    async fn finish(self) {
        self.stop.send(()).unwrap();
        self.task.await.unwrap();
    }
}

fn store() -> Store {
    Store::disposable(
        Options::core(),
        ycoding_store::Catalog::new(1, resources::TABLES),
        Metadata::new([62; 16], 1),
    )
    .unwrap()
}
fn options(root: &std::path::Path, content: Option<String>) -> LoadOptions {
    LoadOptions {
        directory: root.join("project"),
        roots: Roots::development(root).unwrap(),
        project: true,
        file: None,
        content,
        env: BTreeMap::new(),
    }
}
fn key(value: &str) -> resources::Secret {
    resources::Secret::new(
        ycoding_schema::credential::Value::Key(ycoding_schema::credential::Key {
            key: value.into(),
            metadata: None,
        })
        .encode(),
    )
    .unwrap()
}
fn documents(config: &Configuration) -> Vec<JsonValue> {
    config
        .entries
        .iter()
        .filter_map(|entry| match entry {
            ycoding_core::resources::config::Entry::Document { info, .. } => Some(info.clone()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn current_models_dev_refresh_changes_real_models_and_failed_refresh_keeps_prior_snapshot() {
    let fixture = Fixture::new();
    let mut source: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
    ))
    .unwrap();
    let server = Server::new(&source.to_string()).await;
    let discovery = models_dev::Service::new(models_dev::Options {
        source: server.origin.clone(),
        cache: fixture.0.join("models.json"),
        file: None,
        bundled: Some(parse_json(&source.to_string()).unwrap()),
        fetch: false,
        user_agent: "ycoding-test".into(),
    })
    .unwrap();
    let store = store();
    let credentials = credential::Service::new(store.client());
    let mut accounts = AccountCatalog::new(auth::Preparation::default(), BTreeMap::new()).unwrap();
    let config = Configuration::load(options(
        &fixture.0,
        Some(r#"{"providers":{"openai":{"settings":{"apiKey":"fixture"}}}}"#.into()),
    ))
    .unwrap();
    let first =
        Catalog::compose_current(&discovery, &config, &credentials, &mut accounts, 100, false)
            .await
            .unwrap();
    let models = model::Resolver::new(first.catalog);
    let held = models.catalog();
    assert_eq!(
        held.get(
            &provider::Id("openai".into()),
            &"gpt-reasoning".into(),
            None,
            &[]
        )
        .unwrap()
        .name,
        "GPT Reasoning".into()
    );
    source["openai"]["models"]["gpt-reasoning"]["name"] = "Refreshed reasoning".into();
    source["openai"]["models"]["gpt-reasoning"]["limit"]["context"] = 256000.into();
    *server.response.lock().unwrap() = (200, source.to_string());
    let mut refreshed = discovery.refreshed();
    assert!(discovery.refresh(true).await.unwrap());
    assert!(refreshed.has_changed().unwrap());
    refreshed.borrow_and_update();
    models
        .replace(
            Catalog::compose_current(&discovery, &config, &credentials, &mut accounts, 101, false)
                .await
                .unwrap()
                .catalog,
        )
        .unwrap();
    let current = models.catalog();
    let info = current
        .get(
            &provider::Id("openai".into()),
            &"gpt-reasoning".into(),
            None,
            &[],
        )
        .unwrap();
    assert_eq!(info.name, "Refreshed reasoning".into());
    assert_eq!(info.limit.context.get(), 256000);
    assert_eq!(
        held.get(
            &provider::Id("openai".into()),
            &"gpt-reasoning".into(),
            None,
            &[]
        )
        .unwrap()
        .limit
        .context
        .get(),
        128000
    );
    *server.response.lock().unwrap() = (400, "unavailable".into());
    assert_eq!(
        discovery.refresh(true).await.unwrap_err(),
        models_dev::Error::Request
    );
    assert!(!refreshed.has_changed().unwrap());
    let retained =
        Catalog::compose_current(&discovery, &config, &credentials, &mut accounts, 102, false)
            .await
            .unwrap();
    assert_eq!(
        retained
            .catalog
            .get(
                &provider::Id("openai".into()),
                &"gpt-reasoning".into(),
                None,
                &[]
            )
            .unwrap(),
        info
    );
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
    server.finish().await;
}

#[tokio::test]
async fn failed_account_discovery_cannot_publish_replacement_and_credential_changes_bypass_cache() {
    let fixture = Fixture::new();
    let server =
        Server::new(r#"{"object":"list","data":[{"id":"code","name":"First account"}]}"#).await;
    let store = store();
    let credentials = credential::Service::new(store.client());
    let selected = credentials
        .create(
            "account".into(),
            "local".into(),
            Some("Work".into()),
            key("first"),
            1,
        )
        .await
        .unwrap();
    let config = Configuration::load(options(&fixture.0,Some(serde_json::json!({"providers":{"local":{"package":"@ycoding-ai/ai/providers/openai-compatible","catalog":{"source":"openai-models"},"settings":{"baseURL":server.origin}}}}).to_string()))).unwrap();
    let discovery = models_dev::Service::new(models_dev::Options {
        source: server.origin.clone(),
        cache: fixture.0.join("models.json"),
        file: None,
        bundled: Some(parse_json("{}").unwrap()),
        fetch: false,
        user_agent: "ycoding-test".into(),
    })
    .unwrap();
    let mut accounts = AccountCatalog::new(auth::Preparation::default(), BTreeMap::new()).unwrap();
    let models = model::Resolver::new(
        Catalog::compose_current(&discovery, &config, &credentials, &mut accounts, 100, false)
            .await
            .unwrap()
            .catalog,
    );
    let held = models.catalog();
    *server.response.lock().unwrap() = (403, "unavailable".into());
    assert!(matches!(
        Catalog::compose_current(&discovery, &config, &credentials, &mut accounts, 101, true).await,
        Err(models_dev::Error::Request)
    ));
    assert!(Arc::ptr_eq(&held, &models.catalog()));
    *server.response.lock().unwrap() = (
        200,
        r#"{"object":"list","data":[{"id":"code","name":"New account"}]}"#.into(),
    );
    credentials
        .update(selected.id().clone(), None, Some(key("second")), 102)
        .await
        .unwrap();
    models
        .replace(
            Catalog::compose_current(&discovery, &config, &credentials, &mut accounts, 103, false)
                .await
                .unwrap()
                .catalog,
        )
        .unwrap();
    let saved = credentials.all().unwrap();
    let info = models
        .catalog()
        .get(
            &provider::Id("local".into()),
            &"code".into(),
            Some(&ycoding_schema::model::ProfileName("Work".into())),
            &saved,
        )
        .unwrap();
    assert_eq!(info.name, "New account".into());
    assert_eq!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.1.clone())
            .collect::<Vec<_>>(),
        ["Bearer first", "Bearer first", "Bearer second"]
    );
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
    server.finish().await;
}

#[tokio::test]
async fn credential_bound_wellknown_sources_compose_between_project_and_content_and_disappear() {
    let fixture = Fixture::new();
    fixture.write(
        "project/ycoding.json",
        r#"{"username":"project","model":"project/code"}"#,
    );
    let remote = Server::new(r#"{"config":{"username":"remote","default_agent":"remote"}}"#).await;
    let manifest = serde_json::json!({"auth":{"command":["fixture-login"],"env":"TOKEN"},"config":{"username":"embedded","model":"remote/code","providers":{"local":{"settings":{"apiKey":"{env:TOKEN}"}}}},"remote_config":{"url":remote.origin,"headers":{"authorization":"Bearer {env:TOKEN}"}}});
    let origin = Server::new(&manifest.to_string()).await;
    let store = store();
    let credentials = credential::Service::new(store.client());
    let owner = integration::WellKnown::new(
        wellknown::Service::new(
            store.client(),
            BTreeMap::from([("TOKEN".into(), "wrong".into())]),
        )
        .unwrap(),
    );
    let registry = integration::Registry::new(credentials.clone(), BTreeMap::new());
    owner.attach(&registry).await.unwrap();
    let mut updated = owner.updated();
    owner.add(&origin.origin, 1).await.unwrap();
    assert!(updated.has_changed().unwrap());
    updated.borrow_and_update();
    assert!(
        registry
            .get(&origin.origin.as_str().into())
            .unwrap()
            .is_some()
    );
    assert!(owner.configuration(&credentials).await.unwrap().is_empty());
    let selected = credentials
        .create(
            "enterprise".into(),
            origin.origin.as_str().into(),
            Some("Work".into()),
            key("fixture-secret"),
            2,
        )
        .await
        .unwrap();
    let sources = owner.configuration(&credentials).await.unwrap();
    assert_eq!(sources.len(), 2);
    let mut config = Configuration::load_with_sources(
        options(&fixture.0, Some(r#"{"username":"inline"}"#.into())),
        sources,
    )
    .unwrap();
    assert_eq!(
        config.latest("username"),
        Some(&parse_json(r#""inline""#).unwrap())
    );
    assert_eq!(
        config.latest("model"),
        Some(&parse_json(r#"{"providerID":"remote","model":"code"}"#).unwrap())
    );
    assert_eq!(
        config.latest("default_agent"),
        Some(&parse_json(r#""remote""#).unwrap())
    );
    assert!(
        ycoding_schema::stringify_json(config.latest("providers").unwrap())
            .contains("fixture-secret")
    );
    assert_eq!(config.snapshot().unwrap().entries, config.entries);
    assert_eq!(
        remote.requests.lock().unwrap()[0].1,
        "Bearer fixture-secret"
    );
    credentials
        .update(
            selected.id().clone(),
            None,
            Some(key("quoted\"key\\value")),
            3,
        )
        .await
        .unwrap();
    let escaped = owner.configuration(&credentials).await.unwrap();
    assert!(!format!("{escaped:?}").contains("quoted"));
    let JsonValue::Object(info) = &escaped[0].info else {
        panic!("source object");
    };
    assert_eq!(
        info.get(&"providers".into()),
        Some(&parse_json(r#"{"local":{"settings":{"apiKey":"quoted\"key\\value"}}}"#).unwrap())
    );
    credentials.remove(selected.id().clone(), 3).await.unwrap();
    config
        .reload_with_sources(owner.configuration(&credentials).await.unwrap())
        .unwrap();
    assert_eq!(
        config.latest("model"),
        Some(&parse_json(r#"{"providerID":"project","model":"code"}"#).unwrap())
    );
    assert!(config.latest("providers").is_none());
    assert_eq!(
        config.latest("username"),
        Some(&parse_json(r#""inline""#).unwrap())
    );
    assert_eq!(documents(&config).len(), 2);
    *origin.response.lock().unwrap() = (400, "unavailable".into());
    assert!(owner.refresh().await.is_err());
    assert!(!updated.has_changed().unwrap());
    assert!(
        registry
            .get(&origin.origin.as_str().into())
            .unwrap()
            .is_some()
    );
    *origin.response.lock().unwrap() = (
        200,
        serde_json::json!({"auth":{"command":["new-login"],"env":"TOKEN"}}).to_string(),
    );
    assert!(owner.refresh().await.unwrap());
    assert!(updated.has_changed().unwrap());
    updated.borrow_and_update();
    owner.remove(&origin.origin, 4).await.unwrap();
    assert!(updated.has_changed().unwrap());
    assert!(
        registry
            .get(&origin.origin.as_str().into())
            .unwrap()
            .is_none()
    );
    assert!(owner.configuration(&credentials).await.unwrap().is_empty());
    registry.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
    origin.finish().await;
    remote.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reference_materialization_advances_only_on_explicit_fetch() {
    let fixture = Fixture::new();
    fixture.repository();
    fixture.git(&["init", "--bare", "origin.git"]);
    fixture.write("README.md", "one");
    fixture.git(&["add", "README.md"]);
    fixture.git(&["commit", "-m", "one"]);
    let remote = url::Url::from_file_path(fixture.0.join("origin.git"))
        .unwrap()
        .to_string();
    fixture.git(&["remote", "add", "origin", &remote]);
    fixture.git(&["push", "-u", "origin", "main"]);
    fixture.git(&["--git-dir", "origin.git", "update-server-info"]);
    fixture.git(&[
        "--git-dir",
        "origin.git",
        "symbolic-ref",
        "HEAD",
        "refs/heads/main",
    ]);
    let roots = Roots::development(&fixture.0).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}/repo.git", listener.local_addr().unwrap());
    let bare = fixture.0.join("origin.git");
    let app = Router::new().route(
        "/repo.git/{*path}",
        any(
            move |axum::extract::Path(path): axum::extract::Path<String>| {
                let bare = bare.clone();
                async move {
                    if path.split('/').any(|part| part == "..") {
                        return Response::builder().status(400).body(Body::empty()).unwrap();
                    }
                    match tokio::fs::read(bare.join(path)).await {
                        Ok(bytes) => Response::new(Body::from(bytes)),
                        Err(_) => Response::builder().status(404).body(Body::empty()).unwrap(),
                    }
                }
            },
        ),
    );
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let target = ycoding_core::platform::repository_cache::parse_remote(&origin, None)
        .unwrap()
        .cache_path(&roots.repos);
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    fixture.git(&["clone", &remote, target.to_str().unwrap()]);
    git(&target, &["config", "remote.origin.url", &origin]);
    let config = Configuration::load(options(
        &fixture.0,
        Some(
            serde_json::json!({"references":{"lib":{"repository":origin,"branch":"main"}}})
                .to_string(),
        ),
    ))
    .unwrap();
    let references =
        reference::Service::from_entries(&config.entries, &fixture.0, &roots, &mut Vec::new())
            .unwrap();
    let cache = ycoding_core::platform::repository_cache::Service::new(
        roots.repos,
        roots.state,
        Arc::new(ycoding_core::platform::git::Service::new(1024 * 1024)),
    );
    let first = references
        .materialize(&cache, reference::Refresh::Cached)
        .unwrap();
    fixture.write("README.md", "two");
    fixture.git(&["add", "README.md"]);
    fixture.git(&["commit", "-m", "two"]);
    fixture.git(&["push"]);
    fixture.git(&["--git-dir", "origin.git", "update-server-info"]);
    assert_eq!(
        references
            .materialize(&cache, reference::Refresh::Cached)
            .unwrap()[0]
            .head,
        first[0].head
    );
    assert_eq!(
        std::fs::read_to_string(target.join("README.md")).unwrap(),
        "one"
    );
    let next = references
        .materialize(&cache, reference::Refresh::Fetch)
        .unwrap();
    assert_ne!(next[0].head, first[0].head);
    assert_eq!(
        std::fs::read_to_string(target.join("README.md")).unwrap(),
        "two"
    );
    stop.send(()).unwrap();
    task.await.unwrap();
}
