use ycoding_core::resources::{
    catalog::{Catalog, models_dev},
    config, model,
};
use ycoding_core::ycoding_schema::{DomainEncode, JsonValue, parse_json, provider};

const KEPT: &[(&str, &str)] = &[
    ("openai", "@ai-sdk/openai"),
    ("anthropic", "@ai-sdk/anthropic"),
    ("openrouter", "@openrouter/ai-sdk-provider"),
    ("llama", "@ai-sdk/openai-compatible"),
    ("meta", "@ai-sdk/openai"),
    ("cline-pass", "@ai-sdk/openai-compatible"),
    ("zai", "@ai-sdk/openai-compatible"),
    ("zai-coding-plan", "@ai-sdk/openai-compatible"),
    ("zhipuai", "@ai-sdk/openai-compatible"),
    ("zhipuai-coding-plan", "@ai-sdk/openai-compatible"),
    ("minimax", "@ai-sdk/anthropic"),
    ("minimax-cn", "@ai-sdk/anthropic"),
    ("minimax-coding-plan", "@ai-sdk/anthropic"),
    ("minimax-cn-coding-plan", "@ai-sdk/anthropic"),
    ("moonshotai", "@ai-sdk/openai-compatible"),
    ("moonshotai-cn", "@ai-sdk/openai-compatible"),
    ("kimi-code-plan-global", "@ai-sdk/openai-compatible"),
    ("kimi-code-plan-cn", "@ai-sdk/openai-compatible"),
    ("deepseek", "@ai-sdk/openai-compatible"),
    ("fireworks-ai", "@ai-sdk/openai-compatible"),
    ("nvidia", "@ai-sdk/openai-compatible"),
];

const NPM_PROVIDERS: &[(&str, &str)] = &[
    ("aihubmix", "@aihubmix/ai-sdk-provider"),
    ("merge-gateway", "merge-gateway-ai-sdk-provider"),
    ("watsonx", "watsonx-ai-provider"),
    ("salad-cloud", "@saladtechnologies-oss/ai-sdk-provider"),
    ("qvac", "@qvac/ai-sdk-provider"),
];

fn snapshot(id: &str, package: &str) -> models_dev::Snapshot {
    models_dev::normalize(
        &parse_json(
            &serde_json::json!({id: {
                "id": id, "name": id, "env": [], "npm": package,
                "api": "https://fixture.example/v1", "models": {"code": {
                    "id": "code", "name": "Code", "release_date": "2026-01-01",
                    "attachment": false, "reasoning": false, "tool_call": true,
                    "cost": {"input":3,"output":12,"cache_read":0.3,"cache_write":3.75},
                    "limit": {"context": 10000, "output": 1000}
                }}
            }})
            .to_string(),
        )
        .unwrap(),
    )
    .unwrap()
    .remove(0)
}

#[test]
fn builtin_models_resolve_and_prepare_their_wire_family() {
    for (id, package) in &KEPT[..3] {
        let mut catalog = Catalog::new(vec![snapshot(id, package)]);
        catalog
            .configure(&[parse_json(
                &serde_json::json!({"providers":{(*id):{"settings":{"apiKey":"fixture-key"}}}})
                    .to_string(),
            )
            .unwrap()])
            .unwrap();
        let resolved = model::Resolver::new(catalog)
            .resolve(
                &ycoding_core::ycoding_schema::model::Ref {
                    provider_id: provider::Id((*id).into()),
                    id: "code".into(),
                    profile: None,
                    variant: None,
                },
                &[],
                None,
            )
            .unwrap();
        let native = model::from_catalog_model(&resolved.info, None).unwrap();
        let mut request = ycoding_ai::llm::Request::new(native.clone());
        request
            .messages
            .push(ycoding_ai::llm::Message::user("hello"));
        let prepared = native.route.prepare(&request).unwrap();
        assert_eq!(
            field(&prepared.body, "model"),
            Some(&"code".encode()),
            "{id}"
        );
        let messages = package == &"@ai-sdk/anthropic";
        assert_eq!(
            prepared.url.path(),
            if messages {
                "/v1/messages"
            } else if package == &"@ai-sdk/openai" || *id == "openrouter" {
                "/v1/responses"
            } else {
                "/v1/chat/completions"
            },
            "{id}"
        );
        assert_eq!(
            prepared.headers[if messages {
                "x-api-key"
            } else {
                "authorization"
            }],
            if messages {
                "fixture-key"
            } else {
                "Bearer fixture-key"
            },
            "{id}"
        );
    }
}

#[test]
fn npm_provider_documents_preserve_selection_pricing_and_unrelated_settings() {
    for &(id, npm) in NPM_PROVIDERS {
        for package in [npm.to_owned(), format!("aisdk:{npm}")] {
            let document = serde_json::json!({"model":format!("{id}/code"), "shell":"/bin/sh", "providers": {
                id:{"package":package,"settings":{"apiKey":"fixture-key","custom":{"keep":true}},"models":{"code":{"settings":{"temperature":0.25}}}},
                "local":{"package":"aisdk:@ai-sdk/openai-compatible","settings":{"baseURL":"http://localhost:1234/v1"},"models":{"code":{}}}
            }}).to_string();
            let decoded = config::decode_document(&document, "fixture");
            assert!(
                decoded.diagnostics.is_empty(),
                "{id}: {:?}",
                decoded.diagnostics
            );
            let info = decoded.info.unwrap();
            assert_eq!(field(&info, "shell"), Some(&"/bin/sh".encode()));
            let source = snapshot(id, npm);
            let cost = source.models[0].cost.clone();
            let mut catalog = Catalog::new(vec![source]);
            catalog.configure(&[info]).unwrap();
            assert_eq!(
                catalog
                    .provider(&provider::Id(id.into()))
                    .unwrap()
                    .package
                    .as_str(),
                Some(package.as_str())
            );
            let selected = catalog.default_selection(&[]).unwrap();
            assert_eq!(selected.provider_id, provider::Id(id.into()));
            assert_eq!(selected.id, "code".into());
            assert!(matches!(
                model::Resolver::new(catalog.clone()).resolve(&selected, &[], None),
                Err(model::Error::UnsupportedPackage)
            ));
            let info = catalog
                .get(&selected.provider_id, &selected.id, None, &[])
                .unwrap();
            assert_eq!(info.cost, cost);
            assert_eq!(
                info.settings.as_ref().unwrap().0.get(&"custom".into()),
                Some(&parse_json(r#"{"keep":true}"#).unwrap())
            );
            assert_eq!(
                info.settings.as_ref().unwrap().0.get(&"temperature".into()),
                Some(&0.25.encode())
            );
            assert!(
                catalog.provider(&provider::Id("local".into())).is_some(),
                "{id}"
            );
        }
    }
}

#[test]
fn user_endpoint_shapes_load_and_prepare_without_credentials() {
    for (id, package, endpoint) in [
        (
            "remote",
            "@ycoding-ai/ai/providers/openai-compatible",
            "https://fixture.example/v1",
        ),
        (
            "local",
            "@ycoding-ai/ai/providers/openai-compatible",
            "http://localhost:1234/v1",
        ),
        ("anthropic", "@ai-sdk/anthropic", "http://localhost:1234/v1"),
        (
            "messages",
            "@ycoding-ai/ai/providers/anthropic-compatible",
            "https://fixture.example/v1",
        ),
        (
            "lmstudio",
            "aisdk:@ai-sdk/openai-compatible",
            "http://localhost:1234/v1",
        ),
    ] {
        let decoded = config::decode_document(&serde_json::json!({"providers":{id:{"package":package,"settings":{"baseURL":endpoint},"models":{"code":{}}}}}).to_string(), "fixture");
        assert!(
            decoded.diagnostics.is_empty(),
            "{id}: {:?}",
            decoded.diagnostics
        );
        let mut catalog = Catalog::default();
        catalog.configure(&[decoded.info.unwrap()]).unwrap();
        let native = model::from_catalog_model(
            &ycoding_core::resources::catalog::project(
                &catalog.providers[0].models[0],
                &catalog.providers[0].provider,
            ),
            None,
        )
        .unwrap();
        let prepared = native
            .route
            .prepare(&ycoding_ai::llm::Request::new(native.clone()))
            .unwrap();
        assert!(prepared.url.as_str().starts_with(endpoint), "{id}");
        assert!(!prepared.headers.contains_key("authorization"), "{id}");
        assert!(!prepared.headers.contains_key("x-api-key"), "{id}");
    }
}

#[test]
fn anthropic_base_url_only_overlay_preserves_the_native_messages_route() {
    let decoded = config::decode_document(
        r#"{"providers":{"anthropic":{"settings":{"baseURL":"http://localhost:1234/v1"}}}}"#,
        "fixture",
    );
    assert!(decoded.diagnostics.is_empty());
    let mut catalog = Catalog::new(vec![snapshot("anthropic", "@ai-sdk/anthropic")]);
    catalog.configure(&[decoded.info.unwrap()]).unwrap();
    let native = model::from_catalog_model(
        &ycoding_core::resources::catalog::project(
            &catalog.providers[0].models[0],
            &catalog.providers[0].provider,
        ),
        None,
    )
    .unwrap();
    let prepared = native
        .route
        .prepare(&ycoding_ai::llm::Request::new(native.clone()))
        .unwrap();
    assert_eq!(prepared.url.as_str(), "http://localhost:1234/v1/messages");
    assert!(!prepared.headers.contains_key("x-api-key"));
}

#[test]
fn npm_model_package_override_is_retained_with_its_native_sibling() {
    let decoded = config::decode_document(
        r#"{"default_agent":"god","providers":{"openai":{"models":{"code":{},"dynamic":{"package":"aisdk:@aihubmix/ai-sdk-provider","settings":{"custom":42},"cost":{"input":1,"output":2}}}}}}"#,
        "fixture",
    );
    assert!(decoded.diagnostics.is_empty());
    assert_eq!(
        field(decoded.info.as_ref().unwrap(), "default_agent"),
        Some(&"god".encode())
    );
    let mut catalog = Catalog::new(vec![snapshot("openai", "@ai-sdk/openai")]);
    catalog.configure(&[decoded.info.unwrap()]).unwrap();
    assert!(
        catalog
            .get(&provider::Id("openai".into()), &"code".into(), None, &[])
            .is_some()
    );
    let dynamic = catalog
        .get(&provider::Id("openai".into()), &"dynamic".into(), None, &[])
        .unwrap();
    assert_eq!(
        dynamic.package.unwrap().as_str(),
        Some("aisdk:@aihubmix/ai-sdk-provider")
    );
    assert_eq!(
        dynamic.settings.unwrap().0.get(&"custom".into()),
        Some(&42.0.encode())
    );
    assert_eq!(dynamic.cost[0].input.get(), 1.0);
    assert_eq!(dynamic.cost[0].output.get(), 2.0);
}

#[test]
fn catalog_keeps_native_and_npm_providers_and_normalization_adds_the_deepseek_fallback() {
    let catalog = Catalog::new(
        KEPT.iter()
            .chain(NPM_PROVIDERS)
            .map(|(id, package)| snapshot(id, package))
            .chain([snapshot("unlisted", "@ai-sdk/openai-compatible")])
            .collect(),
    );
    assert_eq!(
        catalog
            .providers
            .iter()
            .map(|record| record.provider.id.0.as_str().unwrap())
            .collect::<Vec<_>>(),
        KEPT.iter()
            .chain(NPM_PROVIDERS)
            .map(|(id, _)| *id)
            .chain(["unlisted"])
            .collect::<Vec<_>>()
    );
    let snapshots = models_dev::normalize(&parse_json(r#"{"openai":{"id":"openai","name":"OpenAI","env":[],"npm":"@ai-sdk/openai","models":{}},"anthropic":{"id":"anthropic","name":"Anthropic","env":[],"npm":"@ai-sdk/anthropic","models":{}}}"#).unwrap()).unwrap();
    assert_eq!(
        snapshots
            .iter()
            .map(|snapshot| snapshot.info.id.0.as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["openai", "anthropic", "deepseek"]
    );
}

#[test]
fn bundled_catalog_keeps_every_provider_and_its_source_pricing() {
    let source = parse_json(include_str!(
        "../../../../packages/cli/script/models-dev.snapshot.json"
    ))
    .unwrap();
    let snapshots = models_dev::normalize(&source).unwrap();
    let catalog = Catalog::new(snapshots.clone());
    let JsonValue::Object(providers) = source else {
        panic!("expected catalog");
    };
    let mut expected = providers
        .iter()
        .map(|(id, _)| id.as_str().unwrap())
        .collect::<Vec<_>>();
    expected.sort();
    let mut actual = catalog
        .providers
        .iter()
        .map(|record| record.provider.id.0.as_str().unwrap())
        .collect::<Vec<_>>();
    actual.sort();
    assert_eq!(actual, expected);
    for record in &catalog.providers {
        let original = snapshots
            .iter()
            .find(|snapshot| snapshot.info.id == record.provider.id)
            .unwrap();
        assert_eq!(record.models.len(), original.models.len());
        for (model, original) in record.models.iter().zip(&original.models) {
            assert_eq!(model.id, original.id);
            assert_eq!(model.cost, original.cost);
            assert_eq!(model.limit, original.limit);
        }
    }
    for (id, item) in providers.iter() {
        let Some(JsonValue::String(package)) = field(item, "npm") else {
            panic!("expected package");
        };
        let document = serde_json::json!({"default_agent":"god","providers":{(id.as_str().unwrap()):{"package":package.as_str().unwrap()}}}).to_string();
        let decoded = config::decode_document(&document, "fixture");
        assert!(decoded.info.is_some(), "{id:?}: {:?}", decoded.diagnostics);
        assert!(
            decoded.diagnostics.is_empty(),
            "{id:?}: {:?}",
            decoded.diagnostics
        );
    }
}

#[tokio::test]
async fn catalog_metadata_reads_do_not_execute_or_install_explicit_packages() {
    let root = std::env::temp_dir().join(format!(
        "catalog-metadata-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let package = root.join("provider");
    std::fs::create_dir_all(&package).unwrap();
    let marker = root.join("executed");
    std::fs::write(
        package.join("package.json"),
        r#"{"name":"@fixture/catalog-only","version":"1.0.0","main":"index.cjs"}"#,
    )
    .unwrap();
    std::fs::write(package.join("index.cjs"), format!("require('node:fs').writeFileSync({}, 'executed'); throw new Error('catalog reads cannot load packages');", serde_json::to_string(&marker).unwrap())).unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let configuration = config::Configuration::load(config::LoadOptions {
        directory: root.clone(),
        roots: config::Roots::development(&root).unwrap(),
        project: false,
        file: None,
        content: Some(serde_json::json!({"model":"fixture/code","providers":{"fixture":{"package":format!("file:{}", package.display()),"settings":{"baseURL":format!("http://{}", listener.local_addr().unwrap()),"custom":true},"models":{"code":{"cost":{"input":2,"output":5}}}}}}).to_string()),
        env: Default::default(),
    }).unwrap();
    assert!(
        configuration.diagnostics.is_empty(),
        "{:?}",
        configuration.diagnostics
    );
    ycoding_core::extension::Configuration::reject_obsolete(&configuration).unwrap();
    let store = ycoding_store::Store::disposable(
        ycoding_store::Options::core(),
        ycoding_store::Catalog::new(1, ycoding_store::resources::TABLES),
        ycoding_store::Metadata::new([41; 16], 1),
    )
    .unwrap();
    let credentials = ycoding_core::resources::credential::Service::new(store.client());
    let documents = configuration
        .entries
        .iter()
        .filter_map(|entry| match entry {
            config::Entry::Document { info, .. } => Some(info.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    let composed = Catalog::compose(vec![], &documents, &credentials)
        .await
        .unwrap();
    assert!(composed.diagnostics.is_empty());
    assert!(composed.degraded.is_empty());
    assert_eq!(composed.catalog.all(&[]).len(), 1);
    assert!(composed.catalog.available(&[]).is_empty());
    let selected = composed.catalog.default_selection(&[]).unwrap();
    assert!(matches!(
        model::Resolver::new(composed.catalog.clone()).resolve(&selected, &[], None),
        Err(model::Error::UnsupportedPackage)
    ));
    let info = composed
        .catalog
        .get(&selected.provider_id, &selected.id, None, &[])
        .unwrap();
    assert_eq!(selected.provider_id, provider::Id("fixture".into()));
    assert_eq!(
        info.package.as_ref().unwrap().as_str(),
        Some(format!("file:{}", package.display()).as_str())
    );
    assert_eq!(info.cost[0].input.get(), 2.0);
    assert_eq!(info.cost[0].output.get(), 5.0);
    assert!(!marker.exists());
    for path in [
        root.join("node_modules"),
        package.join("node_modules"),
        root.join("bun.lock"),
        root.join("package-lock.json"),
    ] {
        assert!(!path.exists(), "{}", path.display());
    }
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn excluded_package_discovery_does_not_contact_the_endpoint_or_hide_metadata() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let id = "aihubmix";
    let package = "@aihubmix/ai-sdk-provider";
    let document = parse_json(
        &serde_json::json!({"providers": {id: {
            "package": package, "catalog": {"source": "openai-models"},
            "settings": {"baseURL": endpoint, "custom": "kept"},
            "models": {"code": {"limit": {"output": 777}}}
        }}})
        .to_string(),
    )
    .unwrap();
    let store = ycoding_store::Store::disposable(
        ycoding_store::Options::core(),
        ycoding_store::Catalog::new(1, ycoding_store::resources::TABLES),
        ycoding_store::Metadata::new([42; 16], 1),
    )
    .unwrap();
    let credentials = ycoding_core::resources::credential::Service::new(store.client());
    let composed = Catalog::compose(vec![snapshot(id, package)], &[document], &credentials)
        .await
        .unwrap();
    assert!(composed.diagnostics.is_empty());
    assert!(composed.degraded.is_empty());
    let code = composed
        .catalog
        .get(&provider::Id(id.into()), &"code".into(), None, &[])
        .unwrap();
    assert_eq!(code.limit.output.get(), 777);
    assert_eq!(code.cost[0].input.get(), 3.0);
    assert_eq!(
        code.settings.unwrap().0.get(&"custom".into()),
        Some(&"kept".encode())
    );
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

fn field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    let JsonValue::Object(fields) = value else {
        return None;
    };
    fields.get(&key.into())
}

#[test]
fn excluded_upstream_provider_remains_readable_but_cannot_be_selected() {
    let id = provider::Id("deepseek".into());
    let mut catalog = Catalog::new(vec![
        snapshot("openai", "@ai-sdk/openai"),
        snapshot("deepseek", "@ai-sdk/openai-compatible"),
    ]);
    catalog
        .configure(&[parse_json(
            r#"{"model":{"providerID":"deepseek","model":"code"},"providers":{"openai":{"settings":{"apiKey":"fixture-key"}},"deepseek":{"settings":{"apiKey":"fixture-key"}}}}"#,
        )
        .unwrap()])
        .unwrap();
    let selection = catalog.configured_default().unwrap().clone();
    let historical = catalog.get(&id, &"code".into(), None, &[]).unwrap();
    assert_eq!(historical.cost[0].input.get(), 3.0);
    assert_eq!(catalog.default_selection(&[]), Some(selection.clone()));
    assert!(catalog.default_model(&[]).is_none());
    assert!(
        catalog
            .available(&[])
            .iter()
            .all(|model| model.provider_id != id)
    );
    assert!(matches!(
        model::Resolver::new(catalog).resolve(&selection, &[], None),
        Err(model::Error::UnsupportedPackage)
    ));
}

#[test]
fn provider_integration_choices_keep_canonical_ids_order_and_custom_profiles() {
    use ycoding_core::resources::auth::{Preparation, integration::Draft};
    use ycoding_core::ycoding_schema::integration::Method;

    let mut catalog = Catalog::new(vec![snapshot("deepseek", "@ai-sdk/openai-compatible")]);
    catalog.configure(&[parse_json(r#"{"providers":{"local":{"package":"aisdk:@ai-sdk/openai-compatible","settings":{"baseURL":"http://localhost:1234/v1"},"models":{"code":{}}}}}"#).unwrap()]).unwrap();
    assert_eq!(
        catalog
            .integrations()
            .iter()
            .map(|entry| entry.provider_id.0.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["openai", "anthropic", "openrouter", "local"]
    );
    assert_eq!(
        catalog
            .available(&[])
            .iter()
            .map(|model| model.provider_id.0.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["local"]
    );
    let mut draft = Draft::default();
    Preparation::default()
        .register(&mut draft, &Default::default(), None)
        .unwrap();
    draft.register_endpoints(&catalog);
    assert!(
        draft
            .methods(&"openai".into())
            .iter()
            .any(|method| matches!(method, Method::OAuth(_)))
    );
    for id in ["openai", "anthropic", "openrouter", "local"] {
        assert!(
            draft
                .methods(&id.into())
                .iter()
                .any(|method| matches!(method, Method::Key(_))),
            "{id}"
        );
    }
    assert!(draft.get(&"deepseek".into()).is_some());
}

#[test]
fn retired_provider_ids_do_not_register_from_snapshots_or_custom_configuration() {
    for name in ["antigravity", "muse", "AntiGravity", "MuSe"] {
        let id = provider::Id(name.into());
        let mut catalog = Catalog::new(vec![snapshot(name, "@ai-sdk/openai-compatible")]);
        catalog.configure(&[parse_json(&serde_json::json!({
            "providers": {
                name: {"package":"aisdk:@ai-sdk/openai-compatible","settings":{"baseURL":"http://localhost:1234/v1"},"models":{"code":{}}},
                "local": {"package":"aisdk:@ai-sdk/openai-compatible","settings":{"baseURL":"http://localhost:1234/v1"},"models":{"code":{}}}
            }
        }).to_string()).unwrap()]).unwrap();
        assert!(catalog.provider(&id).is_none());
        assert!(catalog.all(&[]).iter().all(|model| model.provider_id != id));
        assert!(
            catalog
                .integrations()
                .iter()
                .all(|entry| entry.provider_id != id)
        );
        assert_eq!(
            catalog.available(&[])[0].provider_id,
            provider::Id("local".into())
        );
        let selection = ycoding_schema::model::Ref {
            provider_id: id,
            id: "code".into(),
            variant: None,
            profile: None,
        };
        assert!(matches!(
            model::Resolver::new(catalog).resolve(&selection, &[], None),
            Err(model::Error::ProviderRetired)
        ));
    }
}

#[test]
fn configured_openai_compatible_route_retains_its_id_and_rejects_oauth() {
    use ycoding_core::ycoding_schema::{DomainDecode, credential};
    let mut catalog = Catalog::new(vec![snapshot("openai", "@ai-sdk/openai")]);
    catalog.configure(&[parse_json(r#"{"providers":{"openai":{"package":"@ycoding-ai/ai/providers/openai-compatible","settings":{"baseURL":"http://localhost:1234/v1","api":"chat"}}}}"#).unwrap()]).unwrap();
    let selected = catalog.default_selection(&[]).unwrap();
    assert_eq!(selected.provider_id, provider::Id("openai".into()));
    assert_eq!(
        catalog
            .integrations()
            .iter()
            .filter(|integration| integration.provider_id == selected.provider_id)
            .count(),
        1
    );
    let resolved = model::Resolver::new(catalog)
        .resolve(&selected, &[], None)
        .unwrap();
    let oauth = credential::Value::decode(&parse_json(r#"{"type":"oauth","methodID":"chatgpt-headless","access":"test-token","refresh":"test-refresh","expires":0}"#).unwrap()).unwrap();
    assert!(matches!(
        model::from_catalog_model(&resolved.info, Some(&oauth)),
        Err(model::Error::ProfileUnavailable)
    ));
    let key = credential::Value::Key(credential::Key {
        key: "fixture-key".into(),
        metadata: None,
    });
    let native = model::from_catalog_model(&resolved.info, Some(&key)).unwrap();
    let prepared = native
        .route
        .prepare(&ycoding_ai::llm::Request::new(native.clone()))
        .unwrap();
    assert_eq!(
        prepared.url.as_str(),
        "http://localhost:1234/v1/chat/completions"
    );
    assert_eq!(prepared.headers["authorization"], "Bearer fixture-key");
}
