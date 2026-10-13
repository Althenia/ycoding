mod support;

use prost::Message;
use std::{
    fs,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use support::{
    Client, text, units,
    wire::{ask, location_scope, query, refuse},
};
use ycoding_core::{
    resources::{
        catalog::models_dev,
        config::{self, Mutation, MutationPolicy},
    },
    ycoding_store::{Metadata, Options, Store},
};
use ycoding_protocol::{connection::Budgets, v5};
use ycoding_runtime::standard;
use ycoding_runtime::{Core, Identity, LocalAuth, PlatformServices, Production, Services};

#[test]
fn configuration_operations_are_registered_and_local_only() {
    let dispatcher = standard().unwrap();
    for operation in [
        "provider.configure",
        "mcp.configure",
        "frontendPackage.resolve",
    ] {
        assert!(
            dispatcher.wired().contains(&operation),
            "{operation} has no handler"
        );
        let id = dispatcher.operation_id(operation).unwrap();
        assert_eq!(
            dispatcher.descriptor(id).unwrap().roles,
            vec![ycoding_protocol::v5::PeerRole::LocalClient as i32]
        );
    }
}

fn provider(directory: &str, id: &str) -> v5::ProviderConfigureRequest {
    v5::ProviderConfigureRequest {
        query: query(directory, None),
        payload: v5::ProviderConfigureRequestPayload {
            provider_id: text(id),
            scope: 2,
            endpoint: v5::ProviderEndpoint {
                kind: Some(v5::provider_endpoint::Kind::Openai(
                    v5::ProviderEndpointOpenAi {
                        base_url: text("http://localhost:4567/v1"),
                        api: 1,
                    },
                )),
            },
            catalog: None,
            models: Some(v5::ProviderEndpointModels {
                items: vec![v5::ProviderEndpointModel {
                    id: text("code"),
                    model_id: None,
                    name: Some(text("Fixture model")),
                    family: None,
                    api: None,
                    disabled: Some(false),
                    tools: Some(false),
                }],
            }),
        },
    }
}

fn mcp(directory: &str, name: &str) -> v5::McpConfigureRequest {
    v5::McpConfigureRequest {
        query: query(directory, None),
        payload: v5::McpConfigureRequestPayload {
            name: text(name),
            scope: 2,
            config: v5::McpAddRequestPayloadConfig {
                kind: Some(v5::mcp_add_request_payload_config::Kind::Value1(
                    v5::McpLocalConfig {
                        r#type: 1,
                        command: v5::McpLocalConfigCommand {
                            items: vec![text("fixture")],
                        },
                        cwd: None,
                        environment: Some(v5::McpLocalConfigEnvironment {
                            entries: vec![v5::McpLocalConfigEnvironmentEntry {
                                key: text("FIXTURE_KEY"),
                                value: text("synthetic-key"),
                            }],
                        }),
                        disabled: Some(true),
                        codemode: None,
                        timeout: None,
                    },
                )),
            },
        },
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn typed_operations_write_reload_register_and_report_partial_failures_without_secrets() {
    tokio::time::timeout(Duration::from_secs(90), flow())
        .await
        .unwrap();
}

async fn flow() {
    let root = std::env::temp_dir().join(format!("runtime-config-ops-{}", std::process::id()));
    fs::create_dir_all(root.join("project")).unwrap();
    let root = fs::canonicalize(root).unwrap();
    let roots = config::Roots::development(&root).unwrap();
    roots.initialize().unwrap();
    fs::create_dir_all(roots.config.join(".ycoding")).unwrap();
    fs::write(roots.config.join(".ycoding/ycoding.jsonc"), "{}\n").unwrap();
    let directory = root.join("project").to_str().unwrap().to_owned();
    fs::write(
        root.join("project/ycoding.jsonc"),
        "{\n  // retained wire comment\n  \"default_agent\" : \"god\"\n}\n",
    )
    .unwrap();
    let store = Store::initialize(
        root.join("core.redb"),
        Options::core(),
        ycoding_core::ycoding_store::import::catalog(
            ycoding_core::ycoding_store::import::DatabaseKind::Core,
        ),
        Metadata::new([31; 16], 1),
    )
    .unwrap();
    let mut core = Core::production(
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
    let package_digest = prepare_package_cache(roots.clone()).await;
    let production_services = Services {
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
    let production_server = support::start(production_services, standard().unwrap()).await;
    let mut production_client = Client::open(production_server.address(), &[])
        .await
        .unwrap();
    let mut global_mcp = mcp(&directory, "production-global-mcp");
    global_mcp.payload.scope = 1;
    let configured: v5::McpConfigureResult = ask(
        &mut production_client,
        "mcp.configure",
        location_scope(&directory),
        global_mcp,
    )
    .await;
    assert_eq!(
        units(&configured.data.target.path),
        roots
            .config
            .join(".ycoding/ycoding.jsonc")
            .to_str()
            .unwrap()
    );
    assert!(configured.data.reloaded);
    let configured_servers: v5::McpListResult = ask(
        &mut production_client,
        "mcp.list",
        location_scope(&directory),
        v5::McpListRequest {
            query: query(&directory, None),
        },
    )
    .await;
    assert!(
        configured_servers
            .data
            .items
            .iter()
            .any(|server| units(&server.name) == "production-global-mcp")
    );
    let mut global = provider(&directory, "production-global");
    global.payload.scope = 1;
    let configured: v5::ProviderConfigureResult = ask(
        &mut production_client,
        "provider.configure",
        location_scope(&directory),
        global,
    )
    .await;
    assert!(configured.data.registered);
    assert_eq!(configured.data.target.scope, 1);
    let mut runpod = provider(&directory, "production-runpod");
    runpod.payload.endpoint.kind = Some(v5::provider_endpoint::Kind::Runpod(
        v5::ProviderEndpointRunpod {
            base_url: text("https://api.runpod.ai/v2/fixture"),
            worker: 1,
        },
    ));
    let configured: v5::ProviderConfigureResult = ask(
        &mut production_client,
        "provider.configure",
        location_scope(&directory),
        runpod,
    )
    .await;
    assert!(configured.data.registered);
    assert_eq!(configured.data.target.scope, 2);
    let configured: v5::McpConfigureResult = ask(
        &mut production_client,
        "mcp.configure",
        location_scope(&directory),
        mcp(&directory, "production-mcp"),
    )
    .await;
    assert!(configured.data.reloaded);
    let resolved: v5::FrontendPackageResolveResult = ask(
        &mut production_client,
        "frontendPackage.resolve",
        location_scope(&directory),
        v5::FrontendPackageResolveRequest {
            query: query(&directory, None),
            payload: v5::FrontendPackageResolveRequestPayload {
                spec: text("@fixture/presentation@1.2.3"),
            },
        },
    )
    .await;
    assert_eq!(units(&resolved.data.name), "@fixture/presentation");
    assert_eq!(units(&resolved.data.version), "1.2.3");
    assert_eq!(units(&resolved.data.digest), package_digest);
    assert_eq!(units(&resolved.data.entrypoint.path), "tui.js");
    assert_eq!(
        units(&resolved.data.entrypoint.digest),
        ycoding_core::resources::memory::format::sha256(b"export default 'production fixture'\n")
    );
    assert!(resolved.data.assets.is_none());
    let location = core
        .locations
        .location(&directory.as_str().into(), None)
        .unwrap();
    let original = core.platform.as_ref().unwrap()(&ycoding_core::ycoding_schema::location::Ref {
        directory: location.info.directory.clone(),
        workspace_id: None,
    })
    .unwrap();
    for scope in [config::Scope::Global, config::Scope::Project] {
        assert!(
            original
                .config
                .allows_mutation(Mutation::Configuration(&config::Target {
                    scope,
                    path: root.join("display-only")
                }))
        );
    }
    assert!(
        original
            .config
            .allows_mutation(Mutation::FrontendPackage("@fixture/presentation"))
    );
    let integrations = core.integrations.as_ref().unwrap()(&location.info).unwrap();
    assert!(
        integrations
            .registry
            .get(&"production-global".into())
            .unwrap()
            .is_some()
    );
    assert!(
        integrations
            .registry
            .get(&"production-runpod".into())
            .unwrap()
            .is_some()
    );
    let catalog = core.catalogs.as_ref().unwrap()(&location.info).unwrap();
    assert_eq!(
        ycoding_core::resources::model::family(
            &catalog
                .models
                .catalog()
                .provider(&ycoding_core::ycoding_schema::provider::Id(
                    "production-runpod".into()
                ))
                .unwrap()
                .package
        )
        .unwrap(),
        ycoding_core::resources::model::ProviderFamily::RunPod
    );
    drop(original);
    drop(location);
    drop(integrations);
    drop(catalog);
    drop(production_client);
    production_server.shutdown().await.unwrap();
    let allow_global = Arc::new(AtomicBool::new(false));
    let resolve_platform = core.platform.clone().unwrap();
    let global = allow_global.clone();
    core.platform = Some(Arc::new(move |location| {
        let platform = resolve_platform(location)?;
        let global = global.clone();
        let configuration = platform
            .config
            .as_ref()
            .clone()
            .with_mutation_policy(MutationPolicy(Arc::new(move |mutation| match mutation {
                Mutation::Configuration(target) => {
                    target.scope == config::Scope::Project || global.load(Ordering::Relaxed)
                }
                Mutation::FrontendPackage(_) => false,
            })));
        Ok(Arc::new(PlatformServices {
            config: Arc::new(configuration),
            shell: platform.shell.clone(),
            pty: platform.pty.clone(),
            tickets: Default::default(),
            filesystem: platform.filesystem.clone(),
            search: platform.search.clone(),
            git: platform.git.clone(),
            copies: platform.copies.clone(),
        }))
    }));
    let fail_reload = Arc::new(AtomicBool::new(false));
    let original_catalogs = core.catalogs.clone().unwrap();
    let reload_failure = fail_reload.clone();
    core.catalogs = Some(Arc::new(move |location| {
        let mut services = original_catalogs(location)?;
        let refresh = services.refresh.clone();
        let failure = reload_failure.clone();
        services.refresh = Arc::new(move || {
            let refresh = refresh.clone();
            let failure = failure.clone();
            Box::pin(async move {
                if failure.load(Ordering::Relaxed) {
                    return Err("synthetic-key must not leak".into());
                }
                refresh().await
            })
        });
        Ok(services)
    }));
    let fail_registration = Arc::new(AtomicBool::new(false));
    let original_integrations = core.integrations.clone().unwrap();
    let registration_failure = fail_registration.clone();
    core.integrations = Some(Arc::new(move |location| {
        if registration_failure.load(Ordering::Relaxed) {
            return Err("synthetic-key must not leak".into());
        }
        original_integrations(location)
    }));
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
    let server = support::start(services.clone(), standard().unwrap()).await;
    let mut client = Client::open(server.address(), &[]).await.unwrap();
    let result: v5::ProviderConfigureResult = ask(
        &mut client,
        "provider.configure",
        location_scope(&directory),
        provider(&directory, "fixture-provider"),
    )
    .await;
    assert!(result.data.registered);
    assert_eq!(units(&result.data.provider_id), "fixture-provider");
    assert_eq!(
        units(&result.data.target.path),
        root.join("project/ycoding.jsonc").to_str().unwrap()
    );
    let model: v5::ProviderGetResult = ask(
        &mut client,
        "provider.get",
        location_scope(&directory),
        v5::ProviderGetRequest {
            query: query(&directory, None),
            params: v5::ProviderGetRequestParams {
                provider_id: text("fixture-provider"),
            },
        },
    )
    .await;
    assert_eq!(
        units(&model.data.package),
        "aisdk:@ai-sdk/openai-compatible"
    );
    assert!(
        core.integrations.as_ref().unwrap()(
            &core
                .locations
                .location(&directory.as_str().into(), None)
                .unwrap()
                .info
        )
        .unwrap()
        .registry
        .get(&"fixture-provider".into())
        .unwrap()
        .is_some()
    );
    assert!(core.credentials.all().unwrap().is_empty());
    let mcp_result: v5::McpConfigureResult = ask(
        &mut client,
        "mcp.configure",
        location_scope(&directory),
        mcp(&directory, "persistent"),
    )
    .await;
    assert!(mcp_result.data.reloaded);
    let list: v5::McpListResult = ask(
        &mut client,
        "mcp.list",
        location_scope(&directory),
        v5::McpListRequest {
            query: query(&directory, None),
        },
    )
    .await;
    assert!(
        list.data
            .items
            .iter()
            .any(|server| units(&server.name) == "persistent")
    );
    let stored = fs::read_to_string(root.join("project/ycoding.jsonc")).unwrap();
    assert!(stored.contains("// retained wire comment"));
    assert!(stored.contains("synthetic-key"));
    let live = mcp(&directory, "live-only");
    let _: v5::McpAddResult = ask(
        &mut client,
        "mcp.add",
        location_scope(&directory),
        v5::McpAddRequest {
            query: live.query,
            params: v5::McpAddRequestParams {
                server: live.payload.name,
            },
            payload: v5::McpAddRequestPayload {
                config: live.payload.config,
            },
        },
    )
    .await;
    assert_eq!(
        fs::read_to_string(root.join("project/ycoding.jsonc")).unwrap(),
        stored
    );
    let mut global_request = provider(&directory, "global-provider");
    global_request.payload.scope = 1;
    let denied: v5::ConfigurationWriteError = refuse(
        &mut client,
        "provider.configure",
        location_scope(&directory),
        global_request.clone(),
    )
    .await;
    assert_eq!(denied.code, 2);
    assert!(
        !fs::read_to_string(roots.config.join("ycoding.json"))
            .unwrap()
            .contains("global-provider")
    );
    allow_global.store(true, Ordering::Relaxed);
    let allowed: v5::ProviderConfigureResult = ask(
        &mut client,
        "provider.configure",
        location_scope(&directory),
        global_request,
    )
    .await;
    assert_eq!(allowed.data.target.scope, 1);
    assert!(roots.config.join("ycoding.json").is_file());
    let mut collision = provider(&directory, "fixture-provider");
    collision.payload.endpoint.kind = Some(v5::provider_endpoint::Kind::Runpod(
        v5::ProviderEndpointRunpod {
            base_url: text("https://api.runpod.ai/v2/fixture"),
            worker: 1,
        },
    ));
    let failure: v5::ConfigurationWriteError = refuse(
        &mut client,
        "provider.configure",
        location_scope(&directory),
        collision,
    )
    .await;
    assert_eq!(failure.code, 3);
    fail_reload.store(true, Ordering::Relaxed);
    for (name, bytes) in [
        (
            "provider.configure",
            provider(&directory, "partial-provider").encode_to_vec(),
        ),
        (
            "mcp.configure",
            mcp(&directory, "partial-mcp").encode_to_vec(),
        ),
    ] {
        let rejected =
            support::rejected(client.call(name, location_scope(&directory), bytes).await);
        let failure = v5::ConfigurationPartialFailure::decode(rejected.payload.as_slice()).unwrap();
        assert_eq!(failure.stage, 1);
        assert_eq!(
            units(&failure.target.path),
            root.join("project/ycoding.jsonc").to_str().unwrap()
        );
        assert!(
            !rejected
                .payload
                .windows(b"synthetic-key".len())
                .any(|window| window == b"synthetic-key")
        );
    }
    fail_reload.store(false, Ordering::Relaxed);
    fail_registration.store(true, Ordering::Relaxed);
    let failure: v5::ConfigurationPartialFailure = refuse(
        &mut client,
        "provider.configure",
        location_scope(&directory),
        provider(&directory, "unregistered-provider"),
    )
    .await;
    assert_eq!(failure.stage, 2);
    fail_registration.store(false, Ordering::Relaxed);
    let result: v5::ProviderConfigureResult = ask(
        &mut client,
        "provider.configure",
        location_scope(&directory),
        provider(&directory, "unregistered-provider"),
    )
    .await;
    assert!(result.data.registered);
    let denied: v5::FrontendPackageError = refuse(
        &mut client,
        "frontendPackage.resolve",
        location_scope(&directory),
        v5::FrontendPackageResolveRequest {
            query: query(&directory, None),
            payload: v5::FrontendPackageResolveRequestPayload {
                spec: text("@fixture/presentation"),
            },
        },
    )
    .await;
    assert_eq!(denied.code, 2);
    let invalid: v5::FrontendPackageError = refuse(
        &mut client,
        "frontendPackage.resolve",
        location_scope(&directory),
        v5::FrontendPackageResolveRequest {
            query: query(&directory, None),
            payload: v5::FrontendPackageResolveRequestPayload {
                spec: text("file:/not-a-package"),
            },
        },
    )
    .await;
    assert_eq!(invalid.code, 1);
    let expiry = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
        + 60000;
    let enrolled = ycoding_runtime::connector::Enrolled::new(
        "https://example.invalid",
        "device-fixture".into(),
    )
    .unwrap();
    let credential = ycoding_runtime::connector::Credential::new(
        "fixture".into(),
        expiry,
        "https://example.invalid".into(),
        "device-fixture".into(),
    );
    let peer =
        ycoding_runtime::connector::Peer::authenticate(&enrolled, &credential, expiry - 60000)
            .unwrap();
    let environment = Arc::new(ycoding_runtime::Environment {
        services,
        urls: vec![],
        subscriptions: Default::default(),
        uploads: Default::default(),
    });
    let dispatcher = standard().unwrap();
    for operation in [
        "provider.configure",
        "mcp.configure",
        "frontendPackage.resolve",
    ] {
        assert!(
            dispatcher
                .invoke_remote(
                    environment.clone(),
                    "remote-fixture".into(),
                    &peer,
                    v5::Request {
                        request_id: "req_fixture".into(),
                        operation_id: dispatcher.operation_id(operation).unwrap(),
                        scope: location_scope(&directory),
                        payload: vec![]
                    }
                )
                .await
                .is_none()
        );
    }
    drop(client);
    server.shutdown().await.unwrap();
    core.shutdown().await.unwrap();
    drop(environment);
    drop(core);
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

async fn prepare_package_cache(roots: config::Roots) -> String {
    tokio::task::spawn_blocking(move || {
        let source = roots.tmp.join("frontend-fixture"); fs::create_dir_all(&source).unwrap();
        fs::write(source.join("package.json"), r#"{"name":"@fixture/presentation","version":"1.2.3","exports":{"./tui":"./tui.js"},"scripts":{"postinstall":"touch SHOULD_NOT_RUN"}}"#).unwrap();
        fs::write(source.join("tui.js"), "export default 'production fixture'\n").unwrap();
        let directory = roots.cache.join("packages/@fixture/presentation@1.2.3"); fs::create_dir_all(&directory).unwrap();
        fs::write(source.join("empty.npmrc"), "").unwrap();
        let pack = std::process::Command::new("npm").args(["--offline", "--userconfig", source.join("empty.npmrc").to_str().unwrap(), "pack", "--ignore-scripts", "--json", "--pack-destination", directory.to_str().unwrap()]).current_dir(&source).output().unwrap();
        assert!(pack.status.success(), "local npm pack failed");
        let archive = directory.join("distribution.tgz"); fs::rename(directory.join("fixture-presentation-1.2.3.tgz"), &archive).unwrap();
        let install = std::process::Command::new("npm").args(["--offline", "--userconfig", source.join("empty.npmrc").to_str().unwrap(), "--cache", roots.tmp.join("npm-cache").to_str().unwrap(), "install", "--ignore-scripts", "--no-audit", "--no-fund", "--", archive.to_str().unwrap()]).current_dir(&directory).output().unwrap();
        assert!(install.status.success(), "local npm install failed");
        assert!(!directory.join("node_modules/@fixture/presentation/SHOULD_NOT_RUN").exists());
        let digest = ycoding_core::resources::memory::format::sha256(fs::read(archive).unwrap());
        fs::write(directory.join("frontend-package.json"), format!(r#"{{"spec":"@fixture/presentation@1.2.3","name":"@fixture/presentation","version":"1.2.3","digest":"{digest}"}}"#)).unwrap();
        digest
    }).await.unwrap()
}
