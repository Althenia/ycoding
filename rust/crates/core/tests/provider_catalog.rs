#[path = "support/muse.rs"]
mod fixture;
use fixture::{Fixture, header, row, secret, store};
use std::{
    collections::BTreeMap,
    io::Write,
    sync::{Arc, Mutex},
};
use tracing::instrument::WithSubscriber;
use ycoding_core::resources::{
    auth::Preparation,
    catalog::{AccountCatalog, Catalog, models_dev},
    model::{DROPPED_UPSTREAM_PROVIDER_ID, Resolver},
};
use ycoding_schema::{DomainDecode, model, parse_json, provider};

fn reference(provider: &str, id: &str, profile: &str) -> model::Ref {
    model::Ref {
        provider_id: provider::Id(provider.into()),
        id: id.into(),
        profile: Some(model::ProfileName(profile.into())),
        variant: None,
    }
}

#[tokio::test]
async fn dropped_saved_accounts_never_discover_or_reintroduce_providers() {
    let fixture = Fixture::new(Vec::new()).await;
    let (store, credentials) = store();
    for (time, id) in [DROPPED_UPSTREAM_PROVIDER_ID, "github-copilot", "xai"]
        .into_iter()
        .enumerate()
    {
        credentials
            .create(
                id.into(),
                id.into(),
                None,
                secret(r#"{"type":"key","key":"fixture-key"}"#),
                time as i64,
            )
            .await
            .unwrap();
    }
    let mut accounts = AccountCatalog::new(Preparation::default(), BTreeMap::new()).unwrap();
    for id in [DROPPED_UPSTREAM_PROVIDER_ID, "github-copilot", "xai"] {
        accounts.endpoints.insert(id.into(), fixture.base.clone());
    }
    let composition =
        Catalog::compose_with_accounts(Vec::new(), &[], &credentials, &mut accounts, 100, true)
            .await
            .unwrap();
    assert!(composition.catalog.providers.is_empty());
    assert!(composition.diagnostics.is_empty());
    assert_eq!(credentials.all().unwrap().len(), 3);
    assert!(fixture.finish().await.is_empty());
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn dropped_unexpired_credentials_are_not_prepared_but_kept_keys_are() {
    let (store, credentials) = store();
    let dropped = credentials
        .create(
            "copilot-id".into(),
            "github-copilot".into(),
            None,
            secret(
                r#"{"type":"oauth","methodID":"device","access":"fixture-access","refresh":"fixture-refresh","expires":9007199254740991}"#,
            ),
            0,
        )
        .await
        .unwrap();
    assert!(matches!(
        Preparation::default()
            .prepare_value(&credentials, dropped, 100, None)
            .await,
        Err(ycoding_core::resources::credential::Error::ProfileUnavailable)
    ));
    let kept = credentials
        .create(
            "openrouter-id".into(),
            "openrouter".into(),
            None,
            secret(r#"{"type":"key","key":"fixture-key"}"#),
            1,
        )
        .await
        .unwrap();
    let prepared = Preparation::default()
        .prepare_value(&credentials, kept, 100, None)
        .await
        .unwrap();
    assert!(
        matches!(prepared.domain().unwrap(), ycoding_schema::credential::Value::Key(value) if value.key.as_str() == Some("fixture-key"))
    );
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[test]
fn externally_registered_upstream_provider_retains_small_model_selection() {
    let mut record = Catalog::new(
        models_dev::normalize(
            &parse_json(include_str!(
                "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
            ))
            .unwrap(),
        )
        .unwrap(),
    )
    .providers
    .remove(0);
    record.provider.id = provider::Id(DROPPED_UPSTREAM_PROVIDER_ID.into());
    record.models.truncate(1);
    let selected = &mut record.models[0];
    selected.provider_id = record.provider.id.clone();
    selected.id = "gpt-5-nano".into();
    selected.enabled = true;
    selected.status = "active".into();
    selected.cost.clear();
    selected.capabilities.input.clear();
    selected.capabilities.output.clear();
    let mut catalog = Catalog::default();
    catalog.providers.push(record);
    let selected = catalog
        .small(&provider::Id(DROPPED_UPSTREAM_PROVIDER_ID.into()), 0.0)
        .unwrap();
    assert_eq!(selected.id, "gpt-5-nano".into());
    assert_eq!(
        selected.provider_id,
        provider::Id(DROPPED_UPSTREAM_PROVIDER_ID.into())
    );
}

#[tokio::test]
async fn muse_retained_owner_seeds_rebuilt_catalog_and_reconciles_on_timer() {
    let body = serde_json::json!({"data":[row("muse-fixture")]}).to_string();
    let fixture = Fixture::new(vec![(200, body.clone()), (200, body)]).await;
    let (store, credentials) = store();
    credentials
        .create(
            "muse-profile".into(),
            "muse".into(),
            Some("Muse".into()),
            secret(r#"{"type":"key","key":"muse-key"}"#),
            0,
        )
        .await
        .unwrap();
    let mut accounts = AccountCatalog::new(Preparation::default(), BTreeMap::new()).unwrap();
    accounts
        .endpoints
        .insert("muse".into(), fixture.base.clone());
    for now in [100, 101, 60101] {
        let composition = Catalog::compose_with_accounts(
            Vec::new(),
            &[],
            &credentials,
            &mut accounts,
            now,
            false,
        )
        .await
        .unwrap();
        assert!(composition.diagnostics.is_empty());
        let saved = credentials.all().unwrap();
        assert!(
            Resolver::new(composition.catalog)
                .resolve(
                    &reference("muse", "muse-fixture", "Muse"),
                    &saved,
                    saved.first()
                )
                .is_ok()
        );
    }
    assert_eq!(fixture.finish().await.len(), 2);
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn account_removal_and_replacement_clear_dynamic_inventory_without_borrowing_stale_models() {
    let cursor =
        serde_json::json!({"models":[{"name":"gpt-fixture","supportsAgent":true}]}).to_string();
    let fixture = Fixture::new(vec![(200, cursor), (503, "failed".into())]).await;
    let (store, credentials) = store();
    let first = credentials
        .create(
            "cursor-profile".into(),
            "cursor".into(),
            Some("Work".into()),
            secret(r#"{"type":"key","key":"cursor-first"}"#),
            1,
        )
        .await
        .unwrap();
    let documents = vec![
        parse_json(r#"{"providers":{"cursor":{"package":"cursor-opencode-provider"}}}"#).unwrap(),
    ];
    let mut accounts = AccountCatalog::new(Preparation::default(), BTreeMap::new()).unwrap();
    accounts
        .endpoints
        .insert("cursor".into(), fixture.base.clone());
    let mut composition = Catalog::compose_with_accounts(
        Vec::new(),
        &documents,
        &credentials,
        &mut accounts,
        100,
        false,
    )
    .await
    .unwrap();
    assert!(
        Resolver::new(composition.catalog.clone())
            .resolve(
                &reference("cursor", "gpt-fixture", "Work"),
                &credentials.all().unwrap(),
                Some(&first)
            )
            .is_ok()
    );
    credentials
        .update(
            first.id().clone(),
            None,
            Some(secret(r#"{"type":"key","key":"cursor-replaced"}"#)),
            101,
        )
        .await
        .unwrap();
    composition.diagnostics = accounts
        .reconcile(&mut composition.catalog, &credentials, 101, false)
        .await
        .unwrap();
    assert_eq!(composition.diagnostics.len(), 1);
    assert!(
        Resolver::new(composition.catalog.clone())
            .resolve(
                &reference("cursor", "gpt-fixture", "Work"),
                &credentials.all().unwrap(),
                credentials.all().unwrap().first()
            )
            .is_err()
    );
    accounts
        .reconcile(&mut composition.catalog, &credentials, 102, false)
        .await
        .unwrap();
    credentials.remove(first.id().clone(), 103).await.unwrap();
    accounts
        .reconcile(&mut composition.catalog, &credentials, 103, false)
        .await
        .unwrap();
    assert!(
        composition
            .catalog
            .all(&[])
            .iter()
            .all(|model| model.provider_id.0 != "cursor".into())
    );
    let requests = fixture.finish().await;
    assert_eq!(requests.len(), 2);
    assert_eq!(
        header(&requests[0], "authorization"),
        Some("Bearer cursor-first")
    );
    assert_eq!(
        header(&requests[1], "authorization"),
        Some("Bearer cursor-replaced")
    );
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn configured_models_discovery_is_retained_and_uses_prepared_selected_credentials() {
    let fixture = Fixture::new(vec![
        (
            200,
            r#"{"object":"list","data":[{"id":"local-model"}]}"#.into(),
        ),
        (
            200,
            r#"{"object":"list","data":[{"id":"local-model"}]}"#.into(),
        ),
    ])
    .await;
    let (store, credentials) = store();
    let documents = vec![parse_json(&serde_json::json!({"providers":{"local":{"package":"aisdk:@ai-sdk/openai-compatible","catalog":{"source":"openai-models"},"settings":{"baseURL":fixture.base,"apiKey":"local-key"}}}}).to_string()).unwrap()];
    let mut accounts = AccountCatalog::new(Preparation::default(), BTreeMap::new()).unwrap();
    for now in [100, 101, 60101] {
        let composition = Catalog::compose_with_accounts(
            Vec::new(),
            &documents,
            &credentials,
            &mut accounts,
            now,
            false,
        )
        .await
        .unwrap();
        assert!(composition.diagnostics.is_empty());
        let selection = model::Ref::decode(
            &parse_json(r#"{"providerID":"local","id":"local-model"}"#).unwrap(),
        )
        .unwrap();
        assert!(
            Resolver::new(composition.catalog)
                .resolve(&selection, &[], None)
                .is_ok()
        );
    }
    assert_eq!(fixture.finish().await.len(), 2);
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[derive(Clone, Default)]
struct Logs(Arc<Mutex<Vec<u8>>>);

impl Write for Logs {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn cursor_env_discovery_failure_preserves_a_usable_location_catalog_and_retries() {
    let logs = Logs::default();
    let writer = logs.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || writer.clone())
        .with_max_level(tracing::Level::WARN)
        .with_ansi(false)
        .finish();
    let dispatch = tracing::Dispatch::new(subscriber);
    let fixture = Fixture::new(vec![
        (503, "private upstream payload".into()),
        (
            200,
            r#"{"models":[{"name":"cursor-fixture","supportsAgent":true}]}"#.into(),
        ),
        (503, "private upstream payload".into()),
        (
            200,
            r#"{"models":[{"name":"cursor-recovered","supportsAgent":true}]}"#.into(),
        ),
    ])
    .await;
    let (store, credentials) = store();
    let cursor = ycoding_core::resources::auth::cursor::Store::new(
        ycoding_core::resources::auth::Client::new(&fixture.base, "fixture").unwrap(),
    );
    let mut accounts = AccountCatalog::new(
        Preparation {
            cursor: Some(cursor.clone()),
            ..Default::default()
        },
        BTreeMap::from([("CURSOR_API_KEY".into(), "fixture-key".into())]),
    )
    .unwrap();
    accounts
        .endpoints
        .insert("cursor".into(), fixture.base.clone());
    let documents = vec![parse_json(r#"{"providers":{"local":{"package":"aisdk:@ai-sdk/openai-compatible","settings":{"apiKey":"local-key"},"models":{"local-model":{}}}}}"#).unwrap()];
    for (now, expected, failed) in [
        (100, None, true),
        (101, Some("cursor-fixture"), false),
        (60101, Some("cursor-fixture"), true),
        (60102, Some("cursor-recovered"), false),
    ] {
        let composition = Catalog::compose_with_accounts(
            Vec::new(),
            &documents,
            &credentials,
            &mut accounts,
            now,
            false,
        )
        .with_subscriber(dispatch.clone())
        .await
        .unwrap();
        assert_eq!(composition.diagnostics.len(), usize::from(failed));
        if failed {
            assert_eq!(
                composition.diagnostics[0].provider_id,
                provider::Id("cursor".into())
            );
        }
        let models = composition.catalog.all(&[]);
        assert!(models.iter().any(|model| model.id == "local-model".into()));
        let cursor_models = models
            .iter()
            .filter(|model| model.provider_id.0 == "cursor".into())
            .collect::<Vec<_>>();
        assert_eq!(cursor_models.len(), usize::from(expected.is_some()));
        if let Some(id) = expected {
            assert_eq!(cursor_models[0].model_id, id.into());
        }
    }
    assert_eq!(fixture.finish().await.len(), 4);
    let logged = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    assert_eq!(logged.matches("failed to sync Cursor models").count(), 2);
    assert!(logged.contains("WARN"), "{logged}");
    assert!(logged.contains("provider=\"cursor\""), "{logged}");
    assert!(!logged.contains("fixture-key"), "{logged}");
    assert!(!logged.contains("private upstream payload"), "{logged}");
    cursor.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
}
