use std::collections::BTreeMap;
use ycoding_ai::cursor::models::Info;
use ycoding_core::resources::{
    auth::{Client, cursor, integration::Registry},
    catalog::Catalog,
    credential::{self, Service},
    cursor::catalog::{Connection, load, publish, source, sync},
    cursor::models::from_cursor,
};
use ycoding_schema::{DomainEncode, credential as schema_credential, integration, provider};
use ycoding_store::{Catalog as Tables, Metadata, Options, Store, resources};

fn store(seed: u8) -> Store {
    Store::disposable(
        Options::core(),
        Tables::new(1, resources::TABLES),
        Metadata::new([seed; 16], 1),
    )
    .unwrap()
}

fn key(value: &str) -> resources::Secret {
    resources::Secret::new(
        schema_credential::Value::Key(schema_credential::Key {
            key: value.into(),
            metadata: None,
        })
        .encode(),
    )
    .unwrap()
}

async fn stored(service: &Service, id: &str, value: &str) -> credential::Info {
    service
        .create(id.into(), "cursor".into(), None, key(value), 0)
        .await
        .unwrap()
}

fn composer() -> Vec<Info> {
    vec![Info {
        id: "composer-2.5".into(),
        display_name: "Composer 2.5".into(),
        supports_thinking: false,
        supports_agent: true,
        supports_images: None,
        max_context: None,
        max_context_max_mode: None,
        supports_max_mode: false,
        variants: vec![],
    }]
}

fn ids(catalog: &Catalog) -> Vec<String> {
    catalog
        .providers
        .iter()
        .filter(|record| record.provider.id.0.as_str() == Some("cursor"))
        .flat_map(|record| &record.models)
        .map(|model| model.id.as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn registers_browser_oauth_api_key_and_env_methods() {
    let store = store(41);
    let registry = Registry::new(Service::new(store.client()), BTreeMap::new());
    let client = Client::new("http://127.0.0.1:9", "fixture").unwrap();
    let _registration = registry
        .transform(move |draft| {
            cursor::register(draft, client.clone(), "https://cursor.com".into())
        })
        .unwrap();
    let info = registry.get(&"cursor".into()).unwrap().unwrap();
    assert_eq!(info.name.as_str(), Some("Cursor"));
    assert_eq!(info.methods.len(), 3);
    assert!(
        info.methods
            .contains(&integration::Method::OAuth(integration::OAuthMethod {
                id: ycoding_schema::integration_id::IntegrationMethodId::new("browser").unwrap(),
                label: "Cursor account (browser login)".into(),
                prompts: None,
                remote: Some(true),
            }))
    );
    assert!(
        info.methods
            .contains(&integration::Method::Key(integration::KeyMethod {
                label: Some("Cursor API key (crsr_…)".into()),
            }))
    );
    assert!(
        info.methods
            .contains(&integration::Method::Env(integration::EnvMethod {
                names: vec!["CURSOR_API_KEY".into()],
            }))
    );
}

#[tokio::test]
async fn browser_login_starts_a_pkce_attempt_in_automatic_mode() {
    let store = store(42);
    let registry = Registry::new(Service::new(store.client()), BTreeMap::new());
    let client = Client::new("http://127.0.0.1:9", "fixture").unwrap();
    let _registration = registry
        .transform(move |draft| {
            cursor::register(draft, client.clone(), "https://cursor.com".into())
        })
        .unwrap();
    let attempt = registry
        .connect(
            "cursor".into(),
            "browser".into(),
            integration::Inputs(Default::default()),
            None,
            0,
        )
        .await
        .unwrap();
    let url = url::Url::parse(attempt.url.as_str().unwrap()).unwrap();
    assert_eq!(attempt.mode.as_str(), Some("auto"));
    assert_eq!(
        format!("{}{}", url.origin().ascii_serialization(), url.path()),
        "https://cursor.com/loginDeepControl"
    );
    let query = url.query_pairs().collect::<BTreeMap<_, _>>();
    assert_eq!(query["challenge"].len(), 43);
    assert!(
        query["challenge"]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    );
    assert_eq!(query["uuid"].len(), 36);
    assert!(
        query["uuid"]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    );
    assert_eq!(query["redirectTarget"], "cli");
}

#[tokio::test]
async fn discovery_publishes_models_for_env_and_stored_credentials() {
    let store = store(43);
    let service = Service::new(store.client());
    let first = stored(&service, "first", "crsr_first").await;
    let seen = std::sync::Mutex::new(Vec::new());
    let loaded = load(
        &[],
        vec![
            Connection {
                credential: None,
                token: "crsr_env".into(),
            },
            Connection {
                credential: Some(first.clone()),
                token: "access".into(),
            },
        ],
        "fingerprint".into(),
        |token| {
            seen.lock().unwrap().push(token);
            async { Ok::<_, ()>(composer()) }
        },
    )
    .await;
    assert_eq!(*seen.lock().unwrap(), ["crsr_env", "access"]);
    assert_eq!(loaded.source.as_deref(), Some("fingerprint"));
    let mut catalog = Catalog::new(vec![]);
    publish(&mut catalog, &loaded.accounts);
    assert_eq!(ids(&catalog), ["composer-2.5"]);
    let record = &catalog.providers[0];
    assert_eq!(record.provider.name.as_str(), Some("Cursor"));
    assert_eq!(
        record.provider.package.as_str(),
        Some("aisdk:cursor-opencode-provider")
    );
    assert_eq!(
        record
            .provider
            .integration_id
            .as_ref()
            .and_then(|id| id.as_lossless().as_str()),
        Some("cursor")
    );
    let model = &record.models[0];
    assert!(catalog.for_connection(model, Some(&first)).is_some());
    let other = stored(&service, "other", "crsr_other").await;
    assert!(catalog.for_connection(model, Some(&other)).is_none());
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn failed_discovery_keeps_same_account_inventory_but_not_a_replacement() {
    let store = store(44);
    let service = Service::new(store.client());
    let first = stored(&service, "first", "crsr_first").await;
    let initial = load(
        &[],
        vec![Connection {
            credential: Some(first.clone()),
            token: "crsr_first".into(),
        }],
        "one".into(),
        |_| async { Ok::<_, ()>(composer()) },
    )
    .await;
    let retained = load(
        &initial.accounts,
        vec![Connection {
            credential: Some(first.clone()),
            token: "crsr_first".into(),
        }],
        "two".into(),
        |_| async { Err::<Vec<Info>, _>("AvailableModels timed out after 5000ms") },
    )
    .await;
    assert_eq!(retained.source, None);
    assert!(retained.accounts == initial.accounts);
    let mut catalog = Catalog::new(vec![]);
    publish(&mut catalog, &retained.accounts);
    assert_eq!(ids(&catalog), ["composer-2.5"]);

    let second = stored(&service, "second", "crsr_second").await;
    let replaced = load(
        &retained.accounts,
        vec![Connection {
            credential: Some(second.clone()),
            token: "crsr_second".into(),
        }],
        "three".into(),
        |_| async { Err::<Vec<Info>, _>("AvailableModels timed out after 5000ms") },
    )
    .await;
    publish(&mut catalog, &replaced.accounts);
    assert_eq!(ids(&catalog), Vec::<String>::new());
    let model = from_cursor(&composer()).remove(0);
    assert!(catalog.for_connection(&model, Some(&second)).is_none());
    assert!(catalog.for_connection(&model, Some(&first)).is_none());
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn sync_replaces_cursor_models_with_the_discovered_set() {
    let mut catalog = Catalog::new(vec![]);
    sync(
        &mut catalog,
        from_cursor(&[Info {
            id: "stale".into(),
            ..composer().remove(0)
        }]),
    );
    assert_eq!(ids(&catalog), ["stale"]);
    sync(&mut catalog, from_cursor(&composer()));
    assert_eq!(ids(&catalog), ["composer-2.5"]);
    assert_eq!(
        catalog
            .provider(&provider::Id("cursor".into()))
            .unwrap()
            .name
            .as_str(),
        Some("Cursor")
    );
}

#[tokio::test]
async fn reconcile_fingerprint_changes_with_stored_credentials_and_env_key() {
    let store = store(45);
    let service = Service::new(store.client());
    let empty = source(&[], None);
    assert_eq!(empty, source(&[], None));
    let first = stored(&service, "first", "crsr_first").await;
    let with_credential = source(std::slice::from_ref(&first), None);
    assert_ne!(empty, with_credential);
    assert_ne!(
        with_credential,
        source(std::slice::from_ref(&first), Some("crsr_env"))
    );
    service.shutdown().await.unwrap();
}
