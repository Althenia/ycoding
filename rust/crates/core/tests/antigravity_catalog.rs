#[path = "support/muse.rs"]
mod fixture;
use fixture::{Fixture, header, secret, store};
use ycoding_core::resources::{antigravity, auth::Preparation, catalog::Catalog};
use ycoding_schema::{DomainEncode, parse_json, stringify_json};

fn settings(model: &ycoding_schema::model::Info) -> Option<serde_json::Value> {
    model
        .settings
        .as_ref()
        .map(|settings| serde_json::from_str(&stringify_json(&settings.encode())).unwrap())
}
fn variant_settings(model: &ycoding_schema::model::Info, id: &str) -> Option<serde_json::Value> {
    model
        .variants
        .iter()
        .find(|variant| variant.id.as_str() == Some(id))
        .and_then(|variant| variant.settings.as_ref())
        .map(|settings| serde_json::from_str(&stringify_json(&settings.encode())).unwrap())
}
fn ids(models: &[ycoding_schema::model::Info]) -> Vec<String> {
    models
        .iter()
        .map(|model| model.id.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn selectable_models_limits_capabilities_and_thinking_defaults() {
    let response = parse_json(
        r#"{
          "models": {
            "gemini-fixture": {
              "displayName": "Gemini Fixture",
              "maxTokens": 1000000,
              "maxOutputTokens": 65536,
              "supportsImages": true,
              "supportsThinking": true,
              "supportsVideo": true,
              "supportsPdf": true,
              "quotaInfo": { "remainingFraction": 0.5 }
            },
            "claude-fixture": { "displayName": "Claude Fixture", "maxTokens": 200000, "supportsImages": false },
            "disabled-fixture": { "displayName": "Off", "maxTokens": 1000, "disabled": true },
            "internal-fixture": { "displayName": "Internal", "maxTokens": 1000, "isInternal": true },
            "old-fixture": { "displayName": "Old", "maxTokens": 1000 },
            "unlimited-fixture": { "displayName": "No limit reported" },
            "gemini-image-fixture": { "displayName": "Gemini Image Fixture", "maxTokens": 32000, "supportsImages": true }
          },
          "deprecatedModelIds": { "old-fixture": { "newModelId": "gemini-fixture" } }
        }"#,
    )
    .unwrap();
    let discovered = antigravity::models(&response).unwrap();
    assert_eq!(
        ids(&discovered.models),
        [
            "claude-fixture",
            "gemini-fixture",
            "gemini-image-fixture",
            "unlimited-fixture"
        ]
    );
    let gemini = discovered
        .models
        .iter()
        .find(|model| model.id.as_str() == Some("gemini-fixture"))
        .unwrap();
    assert_eq!(gemini.name, "Gemini Fixture".into());
    assert_eq!(
        gemini.package.as_ref().and_then(|package| package.as_str()),
        Some("aisdk:@ai-sdk/google")
    );
    assert_eq!(
        (gemini.limit.context.get(), gemini.limit.output.get()),
        (1_000_000, 65_536)
    );
    assert_eq!(
        gemini.capabilities.input,
        vec!["text".into(), "image".into(), "video".into(), "pdf".into()]
    );
    assert!(gemini.variants.is_empty());
    assert_eq!(
        settings(gemini),
        Some(serde_json::json!({"thinkingConfig": {"includeThoughts": true}}))
    );
    let claude = discovered
        .models
        .iter()
        .find(|model| model.id.as_str() == Some("claude-fixture"))
        .unwrap();
    assert_eq!(
        (claude.limit.context.get(), claude.limit.output.get()),
        (200_000, 8_192)
    );
    assert!(!claude.capabilities.input.contains(&"image".into()));
    assert!(claude.variants.is_empty());
    let image = discovered
        .models
        .iter()
        .find(|model| model.id.as_str() == Some("gemini-image-fixture"))
        .unwrap();
    assert!(image.capabilities.output.contains(&"image".into()));
    assert!(!image.capabilities.tools);
    let unlimited = discovered
        .models
        .iter()
        .find(|model| model.id.as_str() == Some("unlimited-fixture"))
        .unwrap();
    assert_eq!(unlimited.limit.context.get(), 0);
}

#[test]
fn effort_models_pivot_into_one_catalog_model_with_variants() {
    let entries = [
        (
            "gemini-4-argon-low",
            "Gemini 4 Argon (Low)",
            r#""thinkingLevel":1"#,
        ),
        (
            "gemini-4-argon-medium",
            "Gemini 4 Argon (Medium)",
            r#""thinkingLevel":2,"thinkingBudget":-1"#,
        ),
        (
            "gemini-4-argon-high",
            "Gemini 4 Argon (High)",
            r#""thinkingLevel":3"#,
        ),
        (
            "gemini-4-argon-xhigh",
            "Gemini 4 Argon (XHigh)",
            r#""thinkingLevel":3"#,
        ),
        (
            "gemini-3.8-flash-low",
            "Gemini 3.8 Flash (Low)",
            r#""thinkingBudget":1000"#,
        ),
        (
            "gemini-3.8-flash-medium",
            "Gemini 3.8 Flash (Medium)",
            r#""thinkingBudget":4000"#,
        ),
        (
            "gemini-3.8-flash-high",
            "Gemini 3.8 Flash (High)",
            r#""thinkingBudget":-1"#,
        ),
        (
            "claude-opus-4-6-max",
            "Claude Opus 4.6 (Max)",
            r#""thinkingLevel":3"#,
        ),
        (
            "claude-sonnet-5-5-low",
            "Claude Sonnet 5.5 (Low)",
            r#""thinkingLevel":1"#,
        ),
        (
            "claude-sonnet-5-5-max",
            "Claude Sonnet 5.5 (Max)",
            r#""thinkingLevel":3"#,
        ),
        (
            "gemini-3.1-pro-high",
            "Gemini 3.1 Pro (High)",
            r#""thinkingLevel":3"#,
        ),
        (
            "gemini-2.5-pro",
            "Gemini 2.5 Pro",
            r#""thinkingBudget":1024"#,
        ),
    ];
    let models = entries
        .iter()
        .map(|(id, name, extra)| {
            format!(r#""{id}":{{"displayName":"{name}",{extra},"supportsThinking":true}}"#)
        })
        .collect::<Vec<_>>()
        .join(",");
    let response = parse_json(&format!(r#"{{"models":{{{models}}}}}"#)).unwrap();
    let discovered = antigravity::models(&response).unwrap();
    assert_eq!(
        ids(&discovered.models),
        [
            "claude-opus-4-6-max",
            "claude-sonnet-5-5",
            "gemini-2.5-pro",
            "gemini-3.1-pro",
            "gemini-3.8-flash",
            "gemini-4-argon"
        ]
    );
    let argon = discovered
        .models
        .iter()
        .find(|model| model.id.as_str() == Some("gemini-4-argon"))
        .unwrap();
    assert_eq!(argon.name, "Gemini 4 Argon".into());
    assert_eq!(argon.model_id.as_str(), Some("gemini-4-argon-medium"));
    assert_eq!(
        settings(argon),
        Some(
            serde_json::json!({"thinkingConfig": {"includeThoughts": true, "thinkingLevel": "medium"}})
        )
    );
    assert_eq!(
        argon
            .variants
            .iter()
            .map(|variant| variant.id.as_str().unwrap().to_owned())
            .collect::<Vec<_>>(),
        ["low", "medium", "high", "xhigh"]
    );
    assert_eq!(
        variant_settings(argon, "xhigh"),
        Some(serde_json::json!({
            "thinkingConfig": {"includeThoughts": true, "thinkingLevel": "high"},
            "antigravityModelID": "gemini-4-argon-xhigh"
        }))
    );
    assert_eq!(
        variant_settings(argon, "high"),
        Some(serde_json::json!({
            "thinkingConfig": {"includeThoughts": true, "thinkingLevel": "high"},
            "antigravityModelID": "gemini-4-argon-high"
        }))
    );
    assert_eq!(
        variant_settings(argon, "low"),
        Some(serde_json::json!({
            "thinkingConfig": {"includeThoughts": true, "thinkingLevel": "low"},
            "antigravityModelID": "gemini-4-argon-low"
        }))
    );
    let flash = discovered
        .models
        .iter()
        .find(|model| model.id.as_str() == Some("gemini-3.8-flash"))
        .unwrap();
    assert_eq!(flash.name, "Gemini 3.8 Flash".into());
    assert_eq!(flash.model_id.as_str(), Some("gemini-3.8-flash-medium"));
    assert_eq!(
        settings(flash),
        Some(
            serde_json::json!({"thinkingConfig": {"includeThoughts": true, "thinkingBudget": 4000}})
        )
    );
    for (variant, budget, gateway) in [
        ("low", 1000, "gemini-3.8-flash-low"),
        ("medium", 4000, "gemini-3.8-flash-medium"),
        ("high", -1, "gemini-3.8-flash-high"),
    ] {
        assert_eq!(
            variant_settings(flash, variant),
            Some(serde_json::json!({
                "thinkingConfig": {"includeThoughts": true, "thinkingBudget": budget},
                "antigravityModelID": gateway
            }))
        );
    }
    let sonnet = discovered
        .models
        .iter()
        .find(|model| model.id.as_str() == Some("claude-sonnet-5-5"))
        .unwrap();
    assert_eq!(sonnet.name, "Claude Sonnet 5.5".into());
    assert_eq!(sonnet.model_id.as_str(), Some("claude-sonnet-5-5-low"));
    assert_eq!(
        sonnet
            .variants
            .iter()
            .map(|variant| variant.id.as_str().unwrap().to_owned())
            .collect::<Vec<_>>(),
        ["low", "max"]
    );
    assert_eq!(
        variant_settings(sonnet, "max"),
        Some(serde_json::json!({
            "thinkingConfig": {"includeThoughts": true, "thinkingLevel": "high"},
            "antigravityModelID": "claude-sonnet-5-5-max"
        }))
    );
    let opus = discovered
        .models
        .iter()
        .find(|model| model.id.as_str() == Some("claude-opus-4-6-max"))
        .unwrap();
    assert_eq!(opus.name, "Claude Opus 4.6 (Max)".into());
    assert!(opus.variants.is_empty());
    assert_eq!(
        settings(opus),
        Some(
            serde_json::json!({"thinkingConfig": {"includeThoughts": true, "thinkingLevel": "high"}})
        )
    );
    let single = discovered
        .models
        .iter()
        .find(|model| model.id.as_str() == Some("gemini-3.1-pro"))
        .unwrap();
    assert_eq!(single.name, "Gemini 3.1 Pro".into());
    assert_eq!(single.model_id.as_str(), Some("gemini-3.1-pro-high"));
    assert_eq!(
        single
            .variants
            .iter()
            .map(|variant| variant.id.as_str().unwrap().to_owned())
            .collect::<Vec<_>>(),
        ["high"]
    );
    assert_eq!(
        variant_settings(single, "high"),
        Some(serde_json::json!({
            "thinkingConfig": {"includeThoughts": true, "thinkingLevel": "high"},
            "antigravityModelID": "gemini-3.1-pro-high"
        }))
    );
    assert_eq!(
        settings(single),
        Some(
            serde_json::json!({"thinkingConfig": {"includeThoughts": true, "thinkingLevel": "high"}})
        )
    );
    let pro = discovered
        .models
        .iter()
        .find(|model| model.id.as_str() == Some("gemini-2.5-pro"))
        .unwrap();
    assert!(pro.variants.is_empty());
    assert_eq!(
        settings(pro),
        Some(
            serde_json::json!({"thinkingConfig": {"includeThoughts": true, "thinkingBudget": 1024}})
        )
    );
}

#[test]
fn gemini_parenthesized_suffixes_pivot_into_variants_and_sort_known_efforts_first() {
    let response = parse_json(
        r#"{"models":{
            "gemini-4-hydrogen-preview":{"displayName":"Gemini 4 Hydrogen (Preview)","supportsThinking":true,"thinkingBudget":2048},
            "gemini-4-hydrogen-low":{"displayName":"Gemini 4 Hydrogen (Low)","supportsThinking":true,"thinkingLevel":1},
            "gemini-4-hydrogen-alpha-test":{"displayName":"Gemini 4 Hydrogen (Alpha Test)","supportsThinking":true,"thinkingBudget":512},
            "gemini-3-pro":{"displayName":"Gemini 3 Pro (Thinking)","supportsThinking":true,"thinkingBudget":4096}
        }}"#,
    )
    .unwrap();
    let discovered = antigravity::models(&response).unwrap();
    assert_eq!(
        ids(&discovered.models),
        ["gemini-3-pro", "gemini-4-hydrogen"]
    );
    let pro = &discovered.models[0];
    assert_eq!(pro.name, "Gemini 3 Pro".into());
    assert_eq!(pro.model_id.as_str(), Some("gemini-3-pro"));
    assert_eq!(
        pro.variants
            .iter()
            .map(|variant| variant.id.as_str().unwrap().to_owned())
            .collect::<Vec<_>>(),
        ["thinking"]
    );
    assert_eq!(
        variant_settings(pro, "thinking"),
        Some(serde_json::json!({
            "thinkingConfig": {"includeThoughts": true, "thinkingBudget": 4096},
            "antigravityModelID": "gemini-3-pro"
        }))
    );
    let hydrogen = &discovered.models[1];
    assert_eq!(hydrogen.name, "Gemini 4 Hydrogen".into());
    assert_eq!(hydrogen.model_id.as_str(), Some("gemini-4-hydrogen-low"));
    assert_eq!(
        hydrogen
            .variants
            .iter()
            .map(|variant| variant.id.as_str().unwrap().to_owned())
            .collect::<Vec<_>>(),
        ["low", "alpha-test", "preview"]
    );
    assert_eq!(
        variant_settings(hydrogen, "preview"),
        Some(serde_json::json!({
            "thinkingConfig": {"includeThoughts": true, "thinkingBudget": 2048},
            "antigravityModelID": "gemini-4-hydrogen-preview"
        }))
    );
    assert_eq!(
        variant_settings(hydrogen, "alpha-test"),
        Some(serde_json::json!({
            "thinkingConfig": {"includeThoughts": true, "thinkingBudget": 512},
            "antigravityModelID": "gemini-4-hydrogen-alpha-test"
        }))
    );
}

#[tokio::test]
async fn service_reconcile_publishes_account_models_and_retains_on_failure() {
    let payload = r#"{"models":{"gemini-fixture":{"displayName":"Gemini Fixture","maxTokens":1000000,"supportsImages":true,"supportsThinking":true}}}"#;
    let fixture = Fixture::new(vec![(200, payload.into()), (500, "{}".into())]).await;
    let (_store, credentials) = store();
    let saved = credentials
        .create(
            "account".into(),
            "antigravity".into(),
            Some("Work".into()),
            secret(
                r#"{"type":"oauth","methodID":"google","access":"google-access","refresh":"google-refresh","expires":9000000,"metadata":{"projectID":"project-1"}}"#,
            ),
            1,
        )
        .await
        .unwrap();
    let preparation = Preparation::default();
    let mut catalog = Catalog::default();
    let mut service = antigravity::Service::new()
        .unwrap()
        .with_base_url(fixture.base.clone());
    service
        .reconcile(&mut catalog, &credentials, &preparation, 0)
        .await
        .unwrap();
    let record = catalog
        .providers
        .iter()
        .find(|record| record.provider.id.0.as_str() == Some("antigravity"))
        .unwrap();
    assert_eq!(record.provider.name, "Antigravity".into());
    assert_eq!(
        record
            .provider
            .integration_id
            .as_ref()
            .map(|id| id.as_lossless().as_str()),
        Some(Some("antigravity"))
    );
    assert_eq!(ids(&record.models), ["gemini-fixture"]);
    let model = record.models[0].clone();
    assert!(catalog.for_connection(&model, Some(&saved)).is_some());
    service
        .reconcile(&mut catalog, &credentials, &preparation, 1)
        .await
        .unwrap();
    assert_eq!(fixture.requests.lock().unwrap().len(), 1);
    service
        .refresh(&mut catalog, &credentials, &preparation, 2)
        .await
        .unwrap();
    assert!(service.source().is_none());
    let record = catalog
        .providers
        .iter()
        .find(|record| record.provider.id.0.as_str() == Some("antigravity"))
        .unwrap();
    assert_eq!(ids(&record.models), ["gemini-fixture"]);
    assert!(catalog.for_connection(&model, Some(&saved)).is_some());
    let requests = fixture.finish().await;
    assert_eq!(requests.len(), 2);
    assert!(requests[0].starts_with("POST /v1internal:fetchAvailableModels "));
    assert_eq!(
        header(&requests[0], "authorization"),
        Some("Bearer google-access")
    );
    assert!(
        header(&requests[0], "user-agent")
            .unwrap()
            .starts_with("antigravity/hub/2.28.2 (aidev_client; os_type=")
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(requests[0].split_once("\r\n\r\n").unwrap().1)
            .unwrap(),
        serde_json::json!({"project": "project-1"})
    );
}
