use axum::{Router, extract::State, routing::get};
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use ycoding_core::resources::{
    auth::integration,
    catalog::Catalog,
    config::{Configuration, LoadOptions, Roots},
    credential, generate, model,
};
use ycoding_schema::{DomainDecode, parse_json, provider};
use ycoding_store::{Metadata, Options, Store, resources};

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("ycoding-resource-policy-{}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn write(&self, path: &str, content: &str) -> std::path::PathBuf {
        let path = self.0.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, content).unwrap();
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

fn configuration(root: &std::path::Path, content: Option<String>) -> Configuration {
    Configuration::load(LoadOptions {
        directory: root.join("project"),
        roots: Roots::development(root).unwrap(),
        project: true,
        file: None,
        content,
        env: BTreeMap::new(),
    })
    .unwrap()
}

#[test]
fn policy_uses_reverse_source_order_last_matching_statement_and_reload() {
    let fixture = Fixture::new();
    let path = fixture.write("config/ycoding/ycoding.json", r#"{"experimental":{"policies":[{"action":"provider.use","resource":"*","effect":"deny"},{"action":"provider.use","resource":"loc?l","effect":"allow"}]}}"#);
    let mut config = configuration(&fixture.0, Some(r#"{"experimental":{"policies":[{"action":"provider.use","resource":"local","effect":"deny"}]},"providers":{"local":{"package":"@ycoding-ai/ai/providers/openai-compatible","settings":{"apiKey":"fixture"},"models":{"code":{}}},"other":{"package":"@ycoding-ai/ai/providers/openai-compatible","settings":{"apiKey":"fixture"},"models":{"code":{}}}}}"#.into()));
    assert!(config.diagnostics.is_empty(), "{:?}", config.diagnostics);
    let mut catalog = Catalog::from_config(Vec::new(), &config).unwrap();
    assert_eq!(
        catalog
            .available(&[])
            .iter()
            .map(|m| m.provider_id.clone())
            .collect::<Vec<_>>(),
        vec![provider::Id("local".into())]
    );
    assert_eq!(catalog.integrations().len(), 1);
    assert_eq!(
        catalog.integrations()[0].provider_id,
        provider::Id("local".into())
    );
    assert_eq!(catalog.available_providers(&[]).len(), 1);
    std::fs::write(&path, r#"{"experimental":{"policies":[{"action":"provider.use","resource":"*","effect":"deny"}]}}"#).unwrap();
    config.reload().unwrap();
    catalog
        .configure(
            &config
                .entries
                .iter()
                .filter_map(|e| match e {
                    ycoding_core::resources::config::Entry::Document { info, .. } => {
                        Some(info.clone())
                    }
                    _ => None,
                })
                .collect::<Vec<_>>(),
        )
        .unwrap();
    assert!(catalog.available(&[]).is_empty());
    assert!(catalog.integrations().is_empty());
    let selected = catalog
        .get(&provider::Id("local".into()), &"code".into(), None, &[])
        .unwrap();
    assert!(catalog.for_connection(&selected, None).is_none());
    std::fs::write(&path, r#"{"experimental":{"policies":[{"action":"provider.use","resource":"local","effect":"deny"},{"action":"provider.use","resource":"local","effect":"allow"}]}}"#).unwrap();
    config.reload().unwrap();
    catalog = Catalog::from_config(Vec::new(), &config).unwrap();
    assert_eq!(catalog.integrations().len(), 2);
    assert!(catalog.for_connection(&selected, None).is_some());
    catalog.configure(&[]).unwrap();
    assert_eq!(catalog.available(&[]).len(), 2);
}

#[tokio::test]
async fn denied_provider_has_no_discovery_or_selected_generation_effects() {
    let calls = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .route(
            "/models",
            get(|State(calls): State<Arc<AtomicUsize>>| async move {
                calls.fetch_add(1, Ordering::SeqCst);
                r#"{"object":"list","data":[{"id":"code"}]}"#
            }),
        )
        .with_state(calls.clone());
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let store = Store::disposable(
        Options::core(),
        ycoding_store::Catalog::new(1, resources::TABLES),
        Metadata::new([61; 16], 1),
    )
    .unwrap();
    let credentials = credential::Service::new(store.client());
    let documents = vec![parse_json(&serde_json::json!({"experimental":{"policies":[{"action":"provider.use","resource":"local","effect":"deny"}]},"providers":{"local":{"package":"@ycoding-ai/ai/providers/openai-compatible","catalog":{"source":"openai-models"},"settings":{"baseURL":endpoint,"apiKey":"fixture"},"models":{"code":{}}}}}).to_string()).unwrap()];
    let catalog = Catalog::compose(Vec::new(), &documents, &credentials)
        .await
        .unwrap()
        .catalog;
    assert!(catalog.integrations().is_empty());
    let mut draft = integration::Draft::default();
    draft.register_endpoints(&catalog);
    assert!(draft.get(&"local".into()).is_none());
    let registry = integration::Registry::new(credentials.clone(), BTreeMap::new());
    let generate = generate::Service {
        models: Arc::new(model::Resolver::new(catalog)),
        credentials: credentials.clone(),
        integrations: registry.clone(),
        executor: Arc::new(generate::Executor::new(
            generate::Executor::http_client().unwrap(),
        )),
        cursor: None,
    };
    let result = generate
        .text(generate::Input {
            prompt: "no effect".into(),
            model: Some(
                ycoding_schema::model::Ref::decode(
                    &parse_json(r#"{"providerID":"local","id":"code"}"#).unwrap(),
                )
                .unwrap(),
            ),
        })
        .await;
    assert_eq!(
        result,
        Err(generate::Error::Selection(
            "Model unavailable: local/code".into()
        ))
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    registry.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
    stop.send(()).unwrap();
    task.await.unwrap();
}

#[tokio::test]
async fn denied_selected_profile_never_refreshes_credentials() {
    use ycoding_schema::{DomainEncode, integration_id::IntegrationMethodId};
    let store = Store::disposable(
        Options::core(),
        ycoding_store::Catalog::new(1, resources::TABLES),
        Metadata::new([63; 16], 1),
    )
    .unwrap();
    let credentials = credential::Service::new(store.client());
    credentials.create("selected".into(),"local".into(),Some("Work".into()),resources::Secret::new(parse_json(r#"{"type":"oauth","methodID":"fixture","access":"expired","refresh":"fixture","expires":0}"#).unwrap()).unwrap(),1).await.unwrap();
    let registry = integration::Registry::new(credentials.clone(), BTreeMap::new());
    let effects = Arc::new(AtomicUsize::new(0));
    let calls = effects.clone();
    let registration = registry
        .transform(move |draft| {
            let calls = calls.clone();
            draft.oauth(integration::OAuthImplementation {
                integration: "local".into(),
                method: ycoding_schema::integration::OAuthMethod {
                    id: IntegrationMethodId::new("fixture").unwrap(),
                    label: "Fixture".into(),
                    prompts: None,
                    remote: None,
                },
                authorize: Arc::new(|_| Box::pin(async { Err(credential::Error::Rejected) })),
                refresh: Some(Arc::new(move |value| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Box::pin(async move { Ok(resources::Secret::new(value.encode()).unwrap()) })
                })),
                label: None,
            });
        })
        .unwrap();
    let mut catalog = Catalog::default();
    catalog.configure(&[parse_json(r#"{"providers":{"local":{"package":"@ycoding-ai/ai/providers/openai-compatible","models":{"code":{}}}},"experimental":{"policies":[{"action":"provider.use","resource":"local","effect":"deny"}]}}"#).unwrap()]).unwrap();
    let generator = generate::Service {
        models: Arc::new(model::Resolver::new(catalog)),
        credentials: credentials.clone(),
        integrations: registry.clone(),
        executor: Arc::new(generate::Executor::new(
            generate::Executor::http_client().unwrap(),
        )),
        cursor: None,
    };
    assert_eq!(
        generator
            .text(generate::Input {
                prompt: "no effect".into(),
                model: Some(
                    ycoding_schema::model::Ref::decode(
                        &parse_json(r#"{"providerID":"local","id":"code","profile":"Work"}"#)
                            .unwrap()
                    )
                    .unwrap()
                )
            })
            .await,
        Err(generate::Error::Selection(
            "Model unavailable: local/code".into()
        ))
    );
    assert_eq!(effects.load(Ordering::SeqCst), 0);
    registration.dispose().unwrap();
    registry.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
}
