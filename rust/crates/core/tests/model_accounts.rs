use ycoding_core::resources::{
    catalog::{Catalog, models_dev},
    credential::Service,
    model::{self, Error, Resolver},
};
use ycoding_schema::{DomainEncode, credential, parse_json, provider};
use ycoding_store::{Metadata, Options, Store, resources};

#[tokio::test]
async fn account_generation_fence_profile_inventory_and_config_overlay() {
    let store = Store::disposable(
        Options::core(),
        ycoding_store::Catalog::new(1, resources::TABLES),
        Metadata::new([9; 16], 1),
    )
    .unwrap();
    let credentials = Service::new(store.client());
    let secret = resources::Secret::new(
        credential::Value::Key(credential::Key {
            key: "fixture".into(),
            metadata: None,
        })
        .encode(),
    )
    .unwrap();
    let work = credentials
        .create(
            "work-id".into(),
            "openai".into(),
            Some("Work".into()),
            secret.clone(),
            1,
        )
        .await
        .unwrap();
    let personal = credentials
        .create(
            "personal-id".into(),
            "openai".into(),
            Some("Personal".into()),
            secret.clone(),
            2,
        )
        .await
        .unwrap();
    let mut catalog = Catalog::new(
        models_dev::normalize(
            &parse_json(include_str!(
                "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
            ))
            .unwrap(),
        )
        .unwrap(),
    );
    let provider = provider::Id("openai".into());
    let saved = credentials.all().unwrap();
    let mut work_model = catalog
        .get(&provider, &"gpt-reasoning".into(), None, &saved)
        .unwrap();
    work_model.name = "Work deployment".into();
    catalog.account_update(&work, provider.clone(), vec![work_model]);
    catalog.account_update(&personal, provider.clone(), vec![]);
    assert!(
        !catalog
            .get(&provider, &"gpt-reasoning".into(), None, &saved)
            .unwrap()
            .enabled
    );
    let selected = catalog
        .get(
            &provider,
            &"gpt-reasoning".into(),
            Some(&ycoding_schema::model::ProfileName("Work".into())),
            &saved,
        )
        .unwrap();
    assert_eq!(selected.name, "Work deployment".into());
    assert_eq!(selected.profiles.unwrap().len(), 1);
    catalog.configure(&[parse_json(r#"{"providers":{"openai":{"settings":{"nested":{"provider":1}},"models":{"gpt-reasoning":{"settings":{"nested":{"model":2}}}}}}}"#).unwrap()]).unwrap();
    let selected = catalog
        .get(
            &provider,
            &"gpt-reasoning".into(),
            Some(&ycoding_schema::model::ProfileName("Work".into())),
            &saved,
        )
        .unwrap();
    assert_eq!(
        selected.settings.unwrap().0.get(&"nested".into()),
        Some(&parse_json(r#"{"provider":1,"model":2}"#).unwrap())
    );
    credentials
        .create(
            "ignored-id".into(),
            "openai".into(),
            Some("Work".into()),
            secret,
            3,
        )
        .await
        .unwrap();
    let saved = credentials.all().unwrap();
    assert!(
        catalog
            .get(
                &provider,
                &"gpt-reasoning".into(),
                Some(&ycoding_schema::model::ProfileName("Work".into())),
                &saved
            )
            .is_none()
    );
    let selection = ycoding_schema::model::Ref {
        id: "gpt-reasoning".into(),
        provider_id: provider,
        variant: None,
        profile: Some(ycoding_schema::model::ProfileName("Work".into())),
    };
    assert_eq!(
        Resolver::new(catalog)
            .resolve(&selection, &saved, None)
            .unwrap_err(),
        Error::ProfileUnavailable
    );
    credentials.shutdown().await.unwrap();
}

#[test]
fn resolved_catalog_identity_and_native_wire_model_id_are_distinct() {
    let mut catalog = Catalog::new(
        models_dev::normalize(
            &parse_json(include_str!(
                "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
            ))
            .unwrap(),
        )
        .unwrap(),
    );
    catalog.configure(&[parse_json(r#"{"providers":{"openai":{"settings":{"apiKey":"fixture"},"models":{"gpt-reasoning":{"modelID":"gpt-5.6","variants":[{"id":"high","settings":{"reasoningEffort":"high"}}]}}}}}"#).unwrap()]).unwrap();
    let selected = ycoding_schema::model::Ref {
        id: "gpt-reasoning".into(),
        provider_id: provider::Id("openai".into()),
        variant: Some("high".into()),
        profile: None,
    };
    let resolved = Resolver::new(catalog)
        .resolve(&selected, &[], None)
        .unwrap();
    let native = model::from_catalog_model(&resolved.info, None).unwrap();
    assert_eq!(resolved.selection.id, "gpt-reasoning".into());
    assert_eq!(native.id, "gpt-5.6".into());
    let prepared = native
        .route
        .prepare(&ycoding_ai::llm::Request::new(native.clone()))
        .unwrap();
    let encoded = ycoding_schema::stringify_json(&prepared.body);
    assert!(encoded.contains("\"model\":\"gpt-5.6\""));
    assert!(encoded.contains("\"effort\":\"high\""));
}
