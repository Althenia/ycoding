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
fn custom_source_provider_keeps_source_pricing_under_configured_model_without_cost() {
    let mut catalog = Catalog::new(models_dev::normalize(&parse_json(r#"{"stand-in":{"id":"stand-in","name":"Stand-in","env":[],"npm":"@ai-sdk/openai-compatible","models":{"model":{"id":"model","name":"Model","release_date":"2026-01-01","attachment":false,"reasoning":false,"tool_call":true,"modalities":{"input":["text"],"output":["text"]},"limit":{"context":128000,"output":8192},"cost":{"input":1,"output":1}}}}}"#).unwrap()).unwrap());
    catalog.configure(&[parse_json(r#"{"providers":{"stand-in":{"name":"Configured stand-in","package":"aisdk:@ai-sdk/openai-compatible","settings":{"baseURL":"http://127.0.0.1:1/v1"},"models":{"model":{"name":"Configured","limit":{"context":128000,"output":8192}}}}}}"#).unwrap()]).unwrap();
    let model = catalog
        .get(&provider::Id("stand-in".into()), &"model".into(), None, &[])
        .unwrap();
    assert_eq!(model.name, "Configured".into());
    assert_eq!(model.time.released.get(), 1767225600000.0);
    assert_eq!(
        model
            .cost
            .iter()
            .map(|cost| (cost.input.get(), cost.output.get(), cost.cache.read.get()))
            .collect::<Vec<_>>(),
        vec![(1.0, 1.0, 0.0)]
    );
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

#[test]
fn effort_variants_detect_manual_thinking_like_main() {
    let model = |id: &str| {
        format!(
            r#""{id}":{{"id":"{id}","name":"{id}","release_date":"2026-01-01","attachment":false,"reasoning":true,"reasoning_options":[{{"type":"effort","values":["high"]}}],"temperature":true,"tool_call":true,"limit":{{"context":128000,"output":8192}}}}"#
        )
    };
    let provider = |id: &str, npm: &str, models: &[&str]| {
        format!(
            r#""{id}":{{"id":"{id}","name":"{id}","env":[],"npm":"{npm}","api":"https://example.test/v1","models":{{{}}}}}"#,
            models
                .iter()
                .map(|m| model(m))
                .collect::<Vec<_>>()
                .join(",")
        )
    };
    let snapshots = models_dev::normalize(
        &parse_json(&format!(
            "{{{}}}",
            [
                provider(
                    "vertex-anthropic",
                    "@ai-sdk/google-vertex/anthropic",
                    &["claude-opus-4-6@default", "claude-sonnet-4-6@default"],
                ),
                provider(
                    "zenmux",
                    "@ai-sdk/anthropic",
                    &["anthropic/claude-3.7-sonnet", "claude-opus-4-5"],
                ),
                provider(
                    "sap",
                    "@jerome-benoit/sap-ai-provider-v2",
                    &["anthropic--claude-4.5-opus"],
                ),
            ]
            .join(",")
        ))
        .unwrap(),
    )
    .unwrap();
    let high = |provider: &str, model: &str| {
        snapshots
            .iter()
            .find(|p| p.info.id.0 == provider.into())
            .unwrap()
            .models
            .iter()
            .find(|m| m.id == model.into())
            .unwrap()
            .variants
            .iter()
            .find(|v| v.id == "high".into())
            .unwrap()
            .settings
            .as_ref()
            .unwrap()
            .encode()
    };
    let adaptive =
        parse_json(r#"{"thinking":{"type":"adaptive","display":"summarized"},"effort":"high"}"#)
            .unwrap();
    let manual = parse_json(r#"{"effort":"high"}"#).unwrap();
    assert_eq!(
        high("vertex-anthropic", "claude-opus-4-6@default"),
        adaptive
    );
    assert_eq!(
        high("vertex-anthropic", "claude-sonnet-4-6@default"),
        adaptive
    );
    assert_eq!(high("zenmux", "anthropic/claude-3.7-sonnet"), manual);
    assert_eq!(high("zenmux", "claude-opus-4-5"), manual);
    assert_eq!(
        high("sap", "anthropic--claude-4.5-opus"),
        parse_json(
            r#"{"modelParams":{"additionalModelRequestFields":{"output_config":{"effort":"high"}}}}"#
        )
        .unwrap()
    );
}
