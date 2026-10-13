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
    catalog::{AccountCatalog, Catalog},
    model::Resolver,
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
async fn opencode_profiles_republish_retained_inventory_config_and_attribution_to_wire() {
    let remote = |id: &str, endpoint: &str| {
        serde_json::json!({"config":{"providers":{"router":{"package":"aisdk:@openrouter/ai-sdk-provider","settings":{"baseURL":endpoint,"apiKey":"remote-secret","headers":{"Authorization":"private"}},"models":{id:{"modelID":id,"limit":{"context":10000,"output":1000}}}}}}}).to_string()
    };
    let fixture = Fixture::new(vec![
        (200, remote("work-model", "http://127.0.0.1:1/work")),
        (200, remote("personal-model", "http://127.0.0.1:1/personal")),
        (503, "private upstream".into()),
        (503, "private upstream".into()),
    ])
    .await;
    let (store, credentials) = store();
    for (time, (id, name)) in [("work", "Work"), ("personal", "Personal")]
        .into_iter()
        .enumerate()
    {
        credentials.create(id.into(), "opencode".into(), Some(name.into()), secret(&serde_json::json!({"type":"key","key":format!("selected-{id}"),"metadata":{"orgID":id}}).to_string()), time as i64).await.unwrap();
    }
    let documents = vec![parse_json(r#"{"providers":{"router":{"headers":{"X-Title":"configured-title"},"models":{"work-model":{"limit":{"output":777}},"personal-model":{}}}}}"#).unwrap()];
    let mut accounts = AccountCatalog::new(Preparation::default(), BTreeMap::new()).unwrap();
    accounts
        .endpoints
        .insert("opencode".into(), fixture.base.clone());
    for (now, force) in [(100, true), (101, false), (60101, false), (60102, false)] {
        let composition = Catalog::compose_with_accounts(
            Vec::new(),
            &documents,
            &credentials,
            &mut accounts,
            now,
            force,
        )
        .await
        .unwrap();
        let resolver = Resolver::new(composition.catalog);
        let saved = credentials.all().unwrap();
        for (profile, id) in [("Work", "work-model"), ("Personal", "personal-model")] {
            let selected = saved
                .iter()
                .find(|credential| credential.label().as_str() == Some(profile))
                .unwrap();
            let resolved = resolver
                .resolve(&reference("router", id, profile), &saved, Some(selected))
                .unwrap();
            assert!(
                resolver
                    .resolve(
                        &reference(
                            "router",
                            if profile == "Work" {
                                "personal-model"
                            } else {
                                "work-model"
                            },
                            profile
                        ),
                        &saved,
                        Some(selected)
                    )
                    .is_err()
            );
            assert_eq!(
                resolved.info.package.as_ref().unwrap().as_str(),
                Some("@ycoding-ai/ai/providers/openrouter")
            );
            let native =
                ycoding_core::resources::model::ProviderContext::new(BTreeMap::new(), "fixture")
                    .unwrap()
                    .model(&resolved.info, Some(&selected.secret().domain().unwrap()))
                    .await
                    .unwrap();
            let prepared = native
                .route
                .prepare(&ycoding_ai::llm::Request::new(native.clone()))
                .unwrap();
            assert_eq!(prepared.headers["x-title"], "configured-title");
            assert_eq!(
                prepared.headers["authorization"],
                format!("Bearer selected-{}", selected.id().as_str().unwrap())
            );
            assert!(!prepared.encoded_body.contains("remote-secret"));
            assert!(!prepared.encoded_body.contains("private"));
            if profile == "Work" {
                assert_eq!(resolved.info.limit.output.get(), 777);
            }
        }
    }
    let requests = fixture.finish().await;
    assert_eq!(requests.len(), 4);
    assert_eq!(header(&requests[0], "x-org-id"), Some("work"));
    assert_eq!(header(&requests[1], "x-org-id"), Some("personal"));
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
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
    let copilot = serde_json::json!({"data":[{"id":"gpt-fixture","name":"Fixture","version":"2026-01-01","model_picker_enabled":true,"capabilities":{"family":"gpt-fixture","limits":{"max_prompt_tokens":10000,"max_output_tokens":1000},"supports":{"tool_calls":false}},"supported_endpoints":["/chat/completions"]}]}).to_string();
    let fixture = Fixture::new(vec![(200, copilot), (503, "failed".into())]).await;
    let (store, credentials) = store();
    let first = credentials.create("copilot-profile".into(), "github-copilot".into(), Some("Work".into()), secret(r#"{"type":"oauth","methodID":"device","access":"copilot-first","refresh":"github-first","expires":0}"#), 1).await.unwrap();
    let documents = vec![
        parse_json(
            r#"{"providers":{"github-copilot":{"package":"aisdk:@ai-sdk/github-copilot"}}}"#,
        )
        .unwrap(),
    ];
    let mut accounts = AccountCatalog::new(Preparation::default(), BTreeMap::new()).unwrap();
    accounts
        .endpoints
        .insert("github-copilot".into(), fixture.base.clone());
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
                &reference("github-copilot", "gpt-fixture", "Work"),
                &credentials.all().unwrap(),
                Some(&first)
            )
            .is_ok()
    );
    credentials.update(first.id().clone(), None, Some(secret(r#"{"type":"oauth","methodID":"device","access":"copilot-replaced","refresh":"github-replaced","expires":0}"#)), 101).await.unwrap();
    composition.diagnostics = accounts
        .reconcile(&mut composition.catalog, &credentials, 101, false)
        .await
        .unwrap();
    assert_eq!(composition.diagnostics.len(), 1);
    assert!(
        Resolver::new(composition.catalog.clone())
            .resolve(
                &reference("github-copilot", "gpt-fixture", "Work"),
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
            .all(|model| model.provider_id.0 != "github-copilot".into())
    );
    let requests = fixture.finish().await;
    assert_eq!(requests.len(), 2);
    assert_eq!(
        header(&requests[0], "authorization"),
        Some("Bearer github-first")
    );
    assert_eq!(
        header(&requests[1], "authorization"),
        Some("Bearer github-replaced")
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
