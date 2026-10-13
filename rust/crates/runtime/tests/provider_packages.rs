mod support;

use std::{fs, sync::Arc, time::Duration};
use support::{
    Client, text, units,
    wire::{ask, location_scope, query},
};
use ycoding_core::{
    resources::{catalog::models_dev, config, model},
    ycoding_schema::{credential, provider},
    ycoding_store::{Metadata, Options, Store},
};
use ycoding_protocol::{connection::Budgets, v5};
use ycoding_runtime::{Core, Identity, LocalAuth, Production, Services, standard};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exact_ts_openrouter_smoke_block_loads_registers_key_integration_and_resolves_native_model()
{
    tokio::time::timeout(Duration::from_secs(90), flow())
        .await
        .unwrap();
}

async fn flow() {
    let root = std::env::temp_dir().join(format!("native-provider-smoke-{}", std::process::id()));
    fs::create_dir_all(root.join("project")).unwrap();
    let root = fs::canonicalize(root).unwrap();
    let roots = config::Roots::development(&root).unwrap();
    roots.initialize().unwrap();
    let directory = root.join("project").to_str().unwrap().to_owned();
    fs::write(root.join("project/ycoding.json"), r#"{"providers":{"openrouter":{"name":"OpenRouter","package":"aisdk:@openrouter/ai-sdk-provider","settings":{"baseURL":"http://127.0.0.1:1/api/v1"},"models":{"smoke-model":{"name":"Runtime Smoke","capabilities":{"tools":true,"input":["text"],"output":["text"]},"limit":{"context":100000,"output":4096},"cost":{"input":1,"output":2,"cache":{"read":0.1,"write":1.25}}}}}}}"#).unwrap();
    let store = Store::initialize(
        root.join("core.redb"),
        Options::core(),
        ycoding_core::ycoding_store::import::catalog(
            ycoding_core::ycoding_store::import::DatabaseKind::Core,
        ),
        Metadata::new([51; 16], 1),
    )
    .unwrap();
    let core = Core::production(
        store.client(),
        Production {
            configuration: config::LoadOptions {
                directory: root.join("project"),
                roots: roots.clone(),
                project: true,
                file: None,
                content: None,
                env: Default::default(),
            },
            catalog: models_dev::Options {
                source: "https://example.invalid".into(),
                cache: roots.cache.join("catalog.json"),
                file: None,
                bundled: Some(ycoding_core::ycoding_schema::parse_json("{}").unwrap()),
                fetch: false,
                user_agent: "fixture".into(),
            },
            cursor: None,
            steer: None,
            ripgrep: "rg".into(),
            meeting: false,
        },
    )
    .await
    .unwrap();
    let services = Services {
        identity: Identity {
            version: "fixture".into(),
            pid: 1,
            source_epoch: "fixture".into(),
        },
        auth: LocalAuth::disabled(),
        cors: vec![],
        budgets: Budgets::default(),
        core: Some(core.clone()),
    };
    let server = support::start(services, standard().unwrap()).await;
    let mut client = Client::open(server.address(), &[]).await.unwrap();
    let listed: v5::IntegrationListResult = ask(
        &mut client,
        "integration.list",
        location_scope(&directory),
        v5::IntegrationListRequest {
            query: query(&directory, None),
        },
    )
    .await;
    assert!(
        listed
            .data
            .items
            .iter()
            .any(|item| units(&item.id) == "openrouter"),
        "OpenRouter smoke integration did not register"
    );
    let _: v5::IntegrationConnectKeyResult = ask(
        &mut client,
        "integration.connect.key",
        location_scope(&directory),
        v5::IntegrationConnectKeyRequest {
            params: v5::IntegrationConnectKeyRequestParams {
                integration_id: text("openrouter"),
            },
            query: query(&directory, None),
            payload: v5::IntegrationConnectKeyRequestPayload {
                key: text("synthetic-openrouter-key"),
                label: Some(text("default")),
            },
        },
    )
    .await;
    let location = core
        .locations
        .location(&directory.as_str().into(), None)
        .unwrap();
    let composed = core.catalogs.as_ref().unwrap()(&location.info).unwrap();
    assert!(
        composed.diagnostics.is_empty(),
        "{:?}",
        composed.diagnostics
    );
    let saved = core.credentials.all().unwrap();
    let resolved = composed
        .models
        .resolve(
            &ycoding_core::ycoding_schema::model::Ref {
                provider_id: provider::Id("openrouter".into()),
                id: "smoke-model".into(),
                profile: None,
                variant: None,
            },
            &saved,
            None,
        )
        .unwrap();
    let routed = model::from_catalog_model(
        &resolved.info,
        Some(&credential::Value::Key(credential::Key {
            key: "synthetic-openrouter-key".into(),
            metadata: None,
        })),
    )
    .unwrap();
    assert_eq!(routed.route.id, "openrouter-responses");
    assert_eq!(routed.id.as_str(), Some("smoke-model"));
    assert_eq!(routed.provider.0.as_str(), Some("openrouter"));
    let prepared = routed
        .route
        .prepare(&ycoding_core::ycoding_ai::llm::Request::new(routed.clone()))
        .unwrap();
    let ycoding_core::ycoding_schema::JsonValue::Object(body) = &prepared.wire_body else {
        panic!()
    };
    assert_eq!(
        body.get(&"model".into()),
        Some(&ycoding_core::ycoding_schema::JsonValue::String(
            "smoke-model".into()
        ))
    );
    assert!(Arc::ptr_eq(&composed.models, &composed.generate.models));
    drop(routed);
    drop(resolved);
    drop(composed);
    drop(location);
    drop(client);
    server.shutdown().await.unwrap();
    core.shutdown().await.unwrap();
    drop(core);
    drop(store);
    fs::remove_dir_all(root).unwrap();
}
