use ycoding_core::resources::catalog::{Catalog, models_dev};
use ycoding_schema::{DomainEncode, JsonValue, parse_json, provider};

fn source() -> Vec<models_dev::Snapshot> {
    models_dev::normalize(
        &parse_json(include_str!(
            "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
        ))
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn source_reasoning_variants_modes_and_encrypted_reasoning() {
    let snapshots = source();
    let openai = snapshots
        .iter()
        .find(|p| p.info.id.0 == "openai".into())
        .unwrap();
    let model = openai
        .models
        .iter()
        .find(|m| m.id == "gpt-reasoning".into())
        .unwrap();
    assert_eq!(
        model
            .variants
            .iter()
            .map(|v| v.id.clone())
            .collect::<Vec<_>>(),
        vec!["none".into(), "low".into(), "high".into()]
    );
    assert_eq!(model.time.released.get(), 1767225600000.0);
    assert_eq!(
        model.settings.as_ref().unwrap().0.get(&"include".into()),
        Some(&parse_json(r#"["reasoning.encrypted_content"]"#).unwrap())
    );
    let mode = openai
        .models
        .iter()
        .find(|m| m.id == "gpt-reasoning-high".into())
        .unwrap();
    assert_eq!(mode.model_id, model.model_id);
    assert_eq!(mode.name, "GPT Reasoning High".into());
    assert_eq!(
        mode.body.as_ref().unwrap().encode(),
        parse_json(r#"{"service_tier":"priority"}"#).unwrap()
    );
    let anthropic = snapshots
        .iter()
        .find(|p| p.info.id.0 == "anthropic".into())
        .unwrap();
    let budget = anthropic
        .models
        .iter()
        .find(|m| m.id == "claude-budget".into())
        .unwrap();
    assert_eq!(
        budget.variants[0].settings.as_ref().unwrap().encode(),
        parse_json(r#"{"thinking":{"type":"enabled","budgetTokens":16000}}"#).unwrap()
    );
    assert_eq!(
        budget.variants[1].settings.as_ref().unwrap().encode(),
        parse_json(r#"{"thinking":{"type":"enabled","budgetTokens":31999}}"#).unwrap()
    );
}

#[test]
fn rejects_invalid_source_without_partial_catalog() {
    assert!(
        models_dev::normalize(
            &parse_json(include_str!(
                "../../../../packages/core/test/plugin/fixtures/models-dev-invalid.json"
            ))
            .unwrap()
        )
        .is_err()
    );
}

#[test]
fn projection_recursive_overlays_replace_arrays_and_case_insensitive_headers() {
    let mut catalog = Catalog::new(source());
    catalog.configure(&[parse_json(r#"{"providers":{"openai":{"settings":{"nested":{"left":1},"include":["provider"]},"headers":{"X-Test":"provider"},"models":{"gpt-reasoning":{"settings":{"nested":{"right":2},"include":["custom"]},"headers":{"x-test":"model"},"cost":{"input":2,"output":4},"disabled":false}}}}}"#).unwrap()]).unwrap();
    let model = catalog
        .get(
            &provider::Id("openai".into()),
            &"gpt-reasoning".into(),
            None,
            &[],
        )
        .unwrap();
    assert_eq!(
        model.settings.as_ref().unwrap().0.get(&"nested".into()),
        Some(&parse_json(r#"{"left":1,"right":2}"#).unwrap())
    );
    assert_eq!(
        model.settings.as_ref().unwrap().0.get(&"include".into()),
        Some(&parse_json(r#"["custom"]"#).unwrap())
    );
    assert_eq!(model.headers.as_ref().unwrap().len(), 1);
    assert_eq!(
        model.headers.as_ref().unwrap().get(&"x-test".into()),
        Some(&JsonValue::String("model".into()))
    );
    assert_eq!(model.cost[0].cache.read.get(), 0.0);
}

#[test]
fn native_registry_hides_only_provider_specific_chat_aliases() {
    let mut snapshots = source();
    let openai = snapshots
        .iter_mut()
        .find(|p| p.info.id.0 == "openai".into())
        .unwrap();
    let mut alias = openai.models[0].clone();
    alias.id = "gpt-5-chat-latest".into();
    openai.models.push(alias.clone());
    let mut custom = openai.clone();
    custom.info.id = provider::Id("custom".into());
    custom.info.package = "aisdk:@ai-sdk/openai-compatible".into();
    custom.models = vec![alias];
    custom.models[0].provider_id = custom.info.id.clone();
    snapshots.push(custom);
    let catalog = Catalog::new(snapshots);
    assert!(
        !catalog
            .get(
                &provider::Id("openai".into()),
                &"gpt-5-chat-latest".into(),
                None,
                &[]
            )
            .unwrap()
            .enabled
    );
    assert!(
        catalog
            .get(
                &provider::Id("custom".into()),
                &"gpt-5-chat-latest".into(),
                None,
                &[]
            )
            .unwrap()
            .enabled
    );
}
