use ycoding_core::resources::{catalog, config, model};
use ycoding_core::ycoding_schema::parse_json;

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
        &[
            "@ai-sdk/openai-compatible",
            "@ycoding-ai/ai/providers/openai-compatible",
            "@ycoding-ai/ai/providers/openai-compatible/responses",
        ],
        model::ProviderFamily::Compatible,
    ),
    (
        &[
            "@openrouter/ai-sdk-provider",
            "@ycoding-ai/ai/providers/openrouter",
        ],
        model::ProviderFamily::OpenRouter,
    ),
    (&["cursor-opencode-provider"], model::ProviderFamily::Cursor),
];

#[test]
fn kept_native_packages_load_at_provider_and_model_level_with_both_prefix_forms() {
    for (packages, expected) in PACKAGES {
        for package in *packages {
            for package in [package.to_string(), format!("aisdk:{package}")] {
                assert_eq!(model::family(&package.as_str().into()).unwrap(), *expected);
                for declaration in [
                    serde_json::json!({"providers":{"fixture":{"package":package,"models":{"code":{}}}}}),
                    serde_json::json!({"providers":{"fixture":{"models":{"code":{"package":package}}}}}),
                ] {
                    let decoded = config::decode_document(&declaration.to_string(), "fixture");
                    assert!(
                        decoded.diagnostics.is_empty(),
                        "{declaration}: {:?}",
                        decoded.diagnostics
                    );
                    let configuration = configuration(decoded.info.unwrap());
                    ycoding_core::extension::Configuration::reject_obsolete(&configuration)
                        .unwrap();
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
                    parse_json(declaration).unwrap()
                )),
                Err(ycoding_core::extension::Error::ObsoleteConfiguration)
            ),
            "{declaration}"
        );
    }
}

#[test]
fn dropped_native_families_cannot_resolve_under_an_alias_or_prefix() {
    for package in [
        "@ai-sdk/google",
        "@ai-sdk/azure",
        "@ai-sdk/xai",
        "@ai-sdk/amazon-bedrock",
        "@ycoding-ai/ai/providers/runpod",
        "@ai-sdk/github-copilot",
        "@ai-sdk/alibaba",
        "@ai-sdk/cohere",
        "@ai-sdk/cerebras",
        "@ai-sdk/deepinfra",
        "@ai-sdk/gateway",
        "@ai-sdk/groq",
        "@ai-sdk/mistral",
        "@ai-sdk/perplexity",
        "venice-ai-sdk-provider",
        "@ai-sdk/vercel",
        "@ai-sdk/togetherai",
        "gitlab-ai-provider",
        "@jerome-benoit/sap-ai-provider-v2",
        "ai-gateway-provider",
        "@ai-sdk/amazon-bedrock/mantle",
        "@ai-sdk/google-vertex",
        "@ai-sdk/google-vertex/anthropic",
    ] {
        for package in [package.to_owned(), format!("aisdk:{package}")] {
            assert!(
                matches!(
                    model::family(&package.as_str().into()),
                    Err(model::Error::UnsupportedPackage)
                ),
                "{package}"
            );
            let decoded = config::decode_document(&serde_json::json!({"default_agent":"god","providers":{"alias":{"package":package}}}).to_string(), "fixture");
            assert!(decoded.info.is_some(), "{package}");
            assert_eq!(decoded.diagnostics.len(), 1, "{package}");
            let catalog =
                catalog::Catalog::from_config(vec![], &configuration(decoded.info.unwrap()))
                    .unwrap();
            assert!(catalog.providers.is_empty(), "{package}");
        }
    }
}

fn configuration(info: ycoding_core::ycoding_schema::JsonValue) -> config::Configuration {
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
    configuration.entries = vec![config::Entry::Document { path: None, info }];
    configuration
}
