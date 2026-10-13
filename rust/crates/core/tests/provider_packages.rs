use ycoding_core::resources::{catalog, config, model};
use ycoding_core::ycoding_schema::{JsonValue, parse_json};

const PACKAGES: &[(&[&str], model::ProviderFamily)] = &[
    (
        &[
            "@ai-sdk/openai",
            "@ycoding-ai/ai/providers/openai",
            "@ycoding-ai/ai/providers/openai/responses",
        ],
        model::ProviderFamily::OpenAI,
    ),
    (
        &[
            "@ai-sdk/anthropic",
            "@ycoding-ai/ai/providers/anthropic",
            "@ycoding-ai/ai/providers/anthropic-compatible",
        ],
        model::ProviderFamily::Anthropic,
    ),
    (
        &["@ai-sdk/google", "@ycoding-ai/ai/providers/google"],
        model::ProviderFamily::Google,
    ),
    (
        &[
            "@ai-sdk/google-vertex",
            "@ycoding-ai/ai/providers/google-vertex",
        ],
        model::ProviderFamily::Vertex,
    ),
    (
        &[
            "@ai-sdk/google-vertex/anthropic",
            "@ycoding-ai/ai/providers/google-vertex/anthropic",
        ],
        model::ProviderFamily::VertexAnthropic,
    ),
    (
        &[
            "@ai-sdk/openai-compatible",
            "@ycoding-ai/ai/providers/openai-compatible",
            "@ycoding-ai/ai/providers/openai-compatible/responses",
        ],
        model::ProviderFamily::Compatible,
    ),
    (
        &[
            "@ai-sdk/azure",
            "@ycoding-ai/ai/providers/azure",
            "@ycoding-ai/ai/providers/azure/chat",
            "@ycoding-ai/ai/providers/azure/responses",
        ],
        model::ProviderFamily::Azure,
    ),
    (
        &[
            "@openrouter/ai-sdk-provider",
            "@ycoding-ai/ai/providers/openrouter",
        ],
        model::ProviderFamily::OpenRouter,
    ),
    (
        &["@ai-sdk/xai", "@ycoding-ai/ai/providers/xai"],
        model::ProviderFamily::Xai,
    ),
    (
        &[
            "@ai-sdk/amazon-bedrock",
            "@ycoding-ai/ai/providers/amazon-bedrock",
        ],
        model::ProviderFamily::Bedrock,
    ),
    (
        &["@ycoding-ai/ai/providers/runpod"],
        model::ProviderFamily::RunPod,
    ),
    (&["@ai-sdk/github-copilot"], model::ProviderFamily::Copilot),
    (&["@ai-sdk/alibaba"], model::ProviderFamily::Alibaba),
    (&["@ai-sdk/cohere"], model::ProviderFamily::Cohere),
    (&["@ai-sdk/cerebras"], model::ProviderFamily::Cerebras),
    (&["@ai-sdk/deepinfra"], model::ProviderFamily::Deepinfra),
    (&["@ai-sdk/gateway"], model::ProviderFamily::Gateway),
    (&["@ai-sdk/groq"], model::ProviderFamily::Groq),
    (&["@ai-sdk/mistral"], model::ProviderFamily::Mistral),
    (&["@ai-sdk/perplexity"], model::ProviderFamily::Perplexity),
    (&["venice-ai-sdk-provider"], model::ProviderFamily::Venice),
    (&["@ai-sdk/vercel"], model::ProviderFamily::Vercel),
    (&["@ai-sdk/togetherai"], model::ProviderFamily::Together),
    (&["gitlab-ai-provider"], model::ProviderFamily::Gitlab),
    (
        &["@jerome-benoit/sap-ai-provider-v2"],
        model::ProviderFamily::Sap,
    ),
    (
        &["ai-gateway-provider"],
        model::ProviderFamily::CloudflareGateway,
    ),
    (
        &["@ai-sdk/amazon-bedrock/mantle"],
        model::ProviderFamily::Mantle,
    ),
    (&["cursor-opencode-provider"], model::ProviderFamily::Cursor),
];

#[test]
fn every_native_family_identity_is_accepted_at_provider_and_model_level_with_both_prefix_forms() {
    for (packages, expected) in PACKAGES {
        for package in *packages {
            for package in [package.to_string(), format!("aisdk:{package}")] {
                assert_eq!(model::family(&package.as_str().into()).unwrap(), *expected);
                for declaration in [
                    format!(
                        r#"{{"providers":{{"fixture":{{"package":"{package}","models":{{"code":{{}}}}}}}}}}"#
                    ),
                    format!(
                        r#"{{"providers":{{"fixture":{{"models":{{"code":{{"package":"{package}"}}}}}}}}}}"#
                    ),
                ] {
                    let decoded = config::decode_document(&declaration, "fixture");
                    assert!(
                        decoded.diagnostics.is_empty(),
                        "{declaration}: {:?}",
                        decoded.diagnostics
                    );
                    let mut configuration = configuration(&declaration);
                    ycoding_core::extension::Configuration::reject_obsolete(&configuration)
                        .unwrap();
                    configuration.entries = vec![config::Entry::Document {
                        path: None,
                        info: decoded.info.unwrap(),
                    }];
                    let catalog = catalog::Catalog::from_config(vec![], &configuration).unwrap();
                    let mut registrations =
                        ycoding_core::resources::auth::integration::Draft::default();
                    registrations.register_endpoints(&catalog);
                    assert!(registrations.get(&"fixture".into()).is_some());
                    assert!(registrations.methods(&"fixture".into()).iter().any(
                        |method| matches!(
                            method,
                            ycoding_core::ycoding_schema::integration::Method::Key(_)
                        )
                    ));
                    let effective = catalog::project(
                        &catalog.providers[0].models[0],
                        &catalog.providers[0].provider,
                    );
                    assert_eq!(
                        effective.package.as_ref().unwrap().as_str(),
                        Some(package.as_str())
                    );
                    assert_eq!(
                        model::family(effective.package.as_ref().unwrap()).unwrap(),
                        *expected
                    );
                }
            }
        }
    }
}

#[test]
fn unknown_packages_and_executable_keys_remain_rejected_at_every_declaration_level() {
    for declaration in [
        r#"{"providers":{"fixture":{"package":"@example/unknown"}}}"#,
        r#"{"providers":{"fixture":{"package":"aisdk:@example/unknown"}}}"#,
        r#"{"providers":{"fixture":{"models":{"code":{"package":"@example/unknown"}}}}}"#,
        r#"{"providers":{"fixture":{"models":{"code":{"package":"file:provider.ts"}}}}}"#,
        r#"{"provider":{"fixture":{"package":"aisdk:@openrouter/ai-sdk-provider"}}}"#,
        r#"{"providers":{"fixture":{"package":"aisdk:@openrouter/ai-sdk-provider","npm":"@example/package"}}}"#,
        r#"{"providers":{"fixture":{"models":{"code":{"package":"@ai-sdk/openai","plugin":"@example/package"}}}}}"#,
        r#"{"providers":{"fixture":{"settings":{"package":"@ai-sdk/openai"}}}}"#,
    ] {
        assert!(
            config::decode_document(declaration, "fixture")
                .info
                .is_none(),
            "{declaration}"
        );
        assert!(
            matches!(
                ycoding_core::extension::Configuration::reject_obsolete(&configuration(
                    declaration
                )),
                Err(ycoding_core::extension::Error::ObsoleteConfiguration)
            ),
            "{declaration}"
        );
    }
}

fn configuration(declaration: &str) -> config::Configuration {
    let root = std::env::temp_dir().join(format!("native-package-shapes-{}", std::process::id()));
    let mut configuration = config::Configuration::load(config::LoadOptions {
        directory: root.clone(),
        roots: config::Roots::development(&root).unwrap(),
        project: false,
        file: None,
        content: None,
        env: Default::default(),
    })
    .unwrap();
    configuration.entries = vec![config::Entry::Document {
        path: None,
        info: parse_json(declaration).unwrap(),
    }];
    assert!(matches!(
        configuration.entries[0],
        config::Entry::Document {
            info: JsonValue::Object(_),
            ..
        }
    ));
    configuration
}
