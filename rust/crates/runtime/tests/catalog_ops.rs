mod support;

use prost::Message;
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use support::{
    wire::{ask, location_scope, query, refuse},
    *,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use ycoding_core::{
    resources::{
        agent,
        auth::integration,
        catalog::{Catalog, ProviderRecord},
        command,
        config::{Entry, Roots},
        generate, model, reference, skill,
    },
    ycoding_schema::{
        DomainDecode, DomainEncode, JsonValue, credential, model::ProfileName, parse_json, plugin,
        provider, skill::Source,
    },
    ycoding_store::resources::Secret,
};
use ycoding_protocol::v5;
use ycoding_runtime::{CatalogServices, CatalogTask, LocalAuth, standard};

fn base_catalog() -> Catalog {
    let info = ycoding_core::ycoding_schema::model::Info::decode(&parse_json(r#"{"id":"code","modelID":"api-code","providerID":"fixture","name":"Code","package":"@ycoding-ai/ai/providers/openai-compatible","settings":{},"headers":{"X-Fixture":"safe"},"body":{"custom":{"enabled":true}},"capabilities":{"tools":true,"input":["text","image"],"output":["text"]},"variants":[{"id":"high","body":{"service_tier":"priority"}}],"time":{"released":12},"cost":[{"tier":{"type":"context","size":100},"input":1.5,"output":2.5,"cache":{"read":0.1,"write":0.2}}],"status":"active","enabled":true,"daybreak":["daybreak_blue"],"api":"chat","limit":{"context":4096,"input":4000,"output":96}}"#).unwrap()).unwrap();
    let mut catalog = Catalog::default();
    catalog.providers = vec![ProviderRecord { provider: provider::Info::decode(&parse_json(r#"{"id":"fixture","integrationID":"fixture-auth","name":"Fixture","package":"@ycoding-ai/ai/providers/openai-compatible","settings":{"apiKey":"synthetic-secret","nested":{"authToken":"synthetic-secret","claudeCodeSource":"managed-source-identity","retained":true}},"headers":{"Authorization":"Bearer synthetic-secret","X-API-Key":"synthetic-secret","X-Fixture":"safe"},"body":{"credentialID":"internal-identity","format":"compact"}}"#).unwrap()).unwrap(), models: vec![info], environment: vec![] }];
    catalog
}

fn task(result: Result<(), String>) -> CatalogTask {
    Arc::new(move || {
        let result = result.clone();
        Box::pin(async move { result })
    })
}

fn fixture(catalog: Catalog, refresh: CatalogTask) -> CatalogServices {
    let credentials = world().core.credentials.clone();
    let roots = Roots::runtime(
        Path::new("/home/fixture"),
        Path::new("/tmp"),
        &BTreeMap::new(),
    )
    .unwrap();
    let entries = [
        Entry::Document { path: Some("/home/fixture/ycoding.json".into()), info: parse_json(r#"{"commands":{"review":{"template":"user","agent":"zeus","model":{"providerID":"fixture","model":"code","profile":"Work","variant":"high"},"subtask":true}},"references":{"guide":{"type":"local","path":"/user/guide","description":"user"}}}"#).unwrap() },
        Entry::Document { path: Some("/project/ycoding.json".into()), info: parse_json(r#"{"commands":{"review":{"template":"project","description":"review project"}},"references":{"guide":{"type":"local","path":"./guide","description":"project","hidden":true},"remote":{"type":"git","repository":"https://github.com/example/guide","branch":"main","description":"remote guide"}},"default_agent":"yangi"}"#).unwrap() },
    ];
    let models = Arc::new(model::Resolver::new(catalog));
    let mut skills = skill::Service::new(Path::new("/tmp/ycoding-catalog-skills"));
    for (name, content) in [("first", "user"), ("second", "other"), ("first", "project")] {
        skills.source(Source::Embedded(ycoding_core::ycoding_schema::skill::EmbeddedSource { skill: ycoding_core::ycoding_schema::skill::Info::decode(&parse_json(&format!(r#"{{"id":"{name}","name":"{name}","description":"fixture","slash":true,"autoinvoke":false,"conflicts":{{"skills":["other"],"instructions":["core/instructions"]}},"location":"/project/skills/{name}/SKILL.md","content":"{content}"}}"#)).unwrap()).unwrap() }));
    }
    CatalogServices {
        generate: Arc::new(generate::Service {
            models: models.clone(),
            credentials: credentials.clone(),
            integrations: integration::Registry::new(credentials, Default::default()),
            executor: Arc::new(generate::Executor::new(
                generate::Executor::http_client().unwrap(),
            )),
            cursor: None,
        }),
        models,
        agents: Arc::new(
            agent::Service::from_documents(
                &entries,
                &roots.home,
                agent::builtin::catalog(&roots).unwrap(),
            )
            .unwrap(),
        ),
        commands: Arc::new(command::Service::from_documents(&entries).unwrap()),
        references: Arc::new(
            reference::Service::from_entries(
                &entries,
                Path::new("/project"),
                &roots,
                &mut Vec::new(),
            )
            .unwrap(),
        ),
        skills: Arc::new(tokio::sync::Mutex::new(skills)),
        diagnostics: ycoding_core::resources::config::decode_document(
            r#"{"permissions":[{"action":"shell","resource":42,"effect":"allow"}]}"#,
            "/project/ycoding.json",
        )
        .diagnostics,
        plugins: vec![
            plugin::Info {
                id: "ycoding.agent".into(),
            },
            plugin::Info {
                id: "trusted-process".into(),
            },
        ],
        ready: task(Ok(())),
        refresh,
    }
}

fn settings(first: CatalogServices, second: Option<CatalogServices>) -> ycoding_runtime::Services {
    let mut settings = services(LocalAuth::disabled(), true);
    settings.core.as_mut().unwrap().catalogs = Some(Arc::new(move |location| {
        match location.directory.as_lossless().as_str() {
            Some("/project") => Ok(first.clone()),
            Some("/project/team") => second.clone().ok_or("Catalog absent".into()),
            _ => Err("Catalog absent".into()),
        }
    }));
    settings
}

async fn bounded<F: std::future::Future>(future: F) -> F::Output {
    tokio::time::timeout(Duration::from_secs(30), future)
        .await
        .expect("catalog test exceeded its time bound")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn location_catalogs_preserve_provider_model_fields_and_private_values_stay_local() {
    bounded(async {
        let mut second = base_catalog();
        second.providers[0].models[0].name = "Other location".into();
        let server = start(
            settings(
                fixture(base_catalog(), task(Ok(()))),
                Some(fixture(second, task(Ok(())))),
            ),
            standard().unwrap(),
        )
        .await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let providers: v5::ProviderListResult = ask(
            &mut client,
            "provider.list",
            location_scope("/project"),
            v5::ProviderListRequest {
                query: query("/project", None),
            },
        )
        .await;
        assert_eq!(units(&providers.location.directory), "/project");
        assert_eq!(providers.data.items.len(), 1);
        let provider = &providers.data.items[0];
        assert_eq!(units(&provider.id), "fixture");
        assert_eq!(
            units(provider.integration_id.as_ref().unwrap()),
            "fixture-auth"
        );
        assert_eq!(provider.settings.as_ref().unwrap().entries.len(), 1);
        assert_eq!(provider.headers.as_ref().unwrap().entries.len(), 1);
        assert_eq!(provider.body.as_ref().unwrap().entries.len(), 1);
        let bytes = providers.encode_to_vec();
        for private in [
            "synthetic-secret",
            "internal-identity",
            "authToken",
            "apiKey",
            "Authorization",
            "X-API-Key",
            "managed-source-identity",
        ] {
            assert!(
                !bytes
                    .windows(private.len())
                    .any(|window| window == private.as_bytes())
            );
        }
        let got: v5::ProviderGetResult = ask(
            &mut client,
            "provider.get",
            location_scope("/project"),
            v5::ProviderGetRequest {
                query: query("/project", None),
                params: v5::ProviderGetRequestParams {
                    provider_id: text("fixture"),
                },
            },
        )
        .await;
        assert_eq!(got.data, *provider);
        let unavailable: v5::ProviderNotFoundError = refuse(
            &mut client,
            "provider.get",
            location_scope("/project"),
            v5::ProviderGetRequest {
                query: query("/project", None),
                params: v5::ProviderGetRequestParams {
                    provider_id: text("missing"),
                },
            },
        )
        .await;
        assert_eq!(units(&unavailable.provider_id), "missing");
        assert_eq!(units(&unavailable.message), "Provider not found: missing");
        let models: v5::ModelListResult = ask(
            &mut client,
            "model.list",
            location_scope("/project"),
            v5::ModelListRequest {
                query: query("/project", None),
            },
        )
        .await;
        let info = &models.data.items[0];
        assert_eq!(units(&info.model_id), "api-code");
        assert_eq!(units(&info.name), "Code");
        assert_eq!(info.time.released, 12.0);
        assert_eq!(info.limit.input, Some(4000));
        assert_eq!(info.variants.items.len(), 1);
        assert_eq!(info.capabilities.input.items.len(), 2);
        assert_eq!(info.cost.items[0].tier.as_ref().unwrap().size, 100);
        assert_eq!(info.cost.items[0].cache.read, 0.1);
        assert_eq!(info.daybreak.as_ref().unwrap().items, [1]);
        assert_eq!(info.api, Some(1));
        assert_eq!(info.headers.as_ref().unwrap().entries.len(), 1);
        let other: v5::ModelListResult = ask(
            &mut client,
            "model.list",
            location_scope("/project/team"),
            v5::ModelListRequest {
                query: query("/project/team", None),
            },
        )
        .await;
        assert_eq!(units(&other.data.items[0].name), "Other location");
        let _: v5::InvalidRequestError = refuse(
            &mut client,
            "model.list",
            location_scope("/project"),
            v5::ModelListRequest {
                query: query("/project/team", None),
            },
        )
        .await;
        let selected: v5::ModelDefaultResult = ask(
            &mut client,
            "model.default",
            location_scope("/project"),
            v5::ModelDefaultRequest {
                query: query("/project", None),
            },
        )
        .await;
        let v5::model_default_result_data::Kind::Value1(selected) = selected.data.kind.unwrap()
        else {
            panic!("expected default")
        };
        assert_eq!(units(&selected.selection.provider_id), "fixture");
        assert_eq!(units(&selected.selection.id), "code");
        assert_eq!(selected.variants.items, info.variants.items);
        assert_eq!(selected.limit.context, info.limit.context);
        assert_eq!(selected.status, info.status);
        drop(client);
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn integrations_include_unconnected_but_exclude_disabled_and_denied_and_refresh_reloads_once()
{
    bounded(async {
        let refreshed = Arc::new(AtomicUsize::new(0));
        let counter = refreshed.clone();
        let refresh: CatalogTask = Arc::new(move || { counter.fetch_add(1, Ordering::SeqCst); Box::pin(async { Ok(()) }) });
        let mut catalog = base_catalog();
        for (id, disabled, denied) in [("unconnected", false, false), ("disabled", true, false), ("denied", false, true)] {
            catalog.providers.push(ProviderRecord { provider: provider::Info::decode(&parse_json(&format!(r#"{{"id":"{id}","integrationID":"{id}-auth","name":"{id}","package":"fixture","disabled":{disabled}}}"#)).unwrap()).unwrap(), models: vec![], environment: vec![] });
            catalog.set_denied(provider::Id(id.into()), denied);
        }
        let server = start(settings(fixture(catalog, refresh), None), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let mappings: v5::ProviderIntegrationsResult = ask(&mut client, "provider.integrations", location_scope("/project"), v5::ProviderIntegrationsRequest { query: query("/project", None) }).await;
        assert_eq!(mappings.data.items.iter().map(|mapping| units(&mapping.provider_id)).collect::<Vec<_>>(), ["fixture", "unconnected"]);
        let _: v5::ProviderRefreshResult = ask(&mut client, "provider.refresh", location_scope("/project"), v5::ProviderRefreshRequest { query: query("/project", None) }).await;
        assert_eq!(refreshed.load(Ordering::SeqCst), 1);
        drop(client); server.shutdown().await.unwrap();
        let server = start(settings(fixture(base_catalog(), task(Err("private-error".into()))), None), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let failed: v5::ServiceUnavailableError = refuse(&mut client, "provider.refresh", location_scope("/project"), v5::ProviderRefreshRequest { query: query("/project", None) }).await;
        assert_eq!(units(&failed.message), "Catalog refresh failed");
        drop(client); server.shutdown().await.unwrap();
    }).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agents_commands_references_skills_diagnostics_and_plugins_use_location_services() {
    bounded(async {
        let server = start(
            settings(fixture(base_catalog(), task(Ok(()))), None),
            standard().unwrap(),
        )
        .await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let agents: v5::AgentListResult = ask(
            &mut client,
            "agent.list",
            location_scope("/project"),
            v5::AgentListRequest {
                query: query("/project", None),
            },
        )
        .await;
        assert_eq!(agents.data.items.len(), 16);
        assert_eq!(units(&agents.data.items[0].id), "yangi");
        let god = agents
            .data
            .items
            .iter()
            .find(|agent| units(&agent.id) == "god")
            .unwrap();
        assert_eq!(units(&god.name), "God");
        assert_eq!(god.mode, 2);
        assert!(units(god.system.as_ref().unwrap()).contains("Main-session controls:"));
        assert_eq!(god.permissions.items.len(), 14);
        let commands: v5::CommandListResult = ask(
            &mut client,
            "command.list",
            location_scope("/project"),
            v5::CommandListRequest {
                query: query("/project", None),
            },
        )
        .await;
        let command = &commands.data.items[0];
        assert_eq!(units(&command.template), "project");
        assert_eq!(command.subtask, Some(true));
        assert_eq!(
            units(command.model.as_ref().unwrap().profile.as_ref().unwrap()),
            "Work"
        );
        assert_eq!(
            units(command.model.as_ref().unwrap().variant.as_ref().unwrap()),
            "high"
        );
        assert_eq!(command.locations.as_ref().unwrap().items.len(), 2);
        let references: v5::ReferenceListResult = ask(
            &mut client,
            "reference.list",
            location_scope("/project"),
            v5::ReferenceListRequest {
                query: query("/project", None),
            },
        )
        .await;
        assert_eq!(references.data.items.len(), 2);
        assert_eq!(units(&references.data.items[0].path), "/project/guide");
        assert_eq!(
            units(references.data.items[0].description.as_ref().unwrap()),
            "project"
        );
        assert_eq!(references.data.items[0].hidden, Some(true));
        assert!(matches!(
            references.data.items[1].source.kind,
            Some(v5::reference_source::Kind::Value2(_))
        ));
        let skills: v5::SkillListResult = ask(
            &mut client,
            "skill.list",
            location_scope("/project"),
            v5::SkillListRequest {
                query: query("/project", None),
            },
        )
        .await;
        assert_eq!(skills.data.items.len(), 2);
        assert_eq!(units(&skills.data.items[0].content), "user");
        assert_eq!(skills.data.items[0].slash, Some(true));
        assert_eq!(skills.data.items[0].autoinvoke, Some(false));
        assert_eq!(
            units(
                &skills.data.items[0]
                    .conflicts
                    .as_ref()
                    .unwrap()
                    .instructions
                    .items[0]
            ),
            "core/instructions"
        );
        let diagnostics: v5::ConfigDiagnosticsResult = ask(
            &mut client,
            "config.diagnostics",
            location_scope("/project"),
            v5::ConfigDiagnosticsRequest {
                query: query("/project", None),
            },
        )
        .await;
        assert_eq!(diagnostics.data.items[0].reason, 2);
        assert_eq!(diagnostics.data.items[0].fail_closed, Some(true));
        assert_eq!(
            units(diagnostics.data.items[0].json_path.as_ref().unwrap()),
            "$.permissions[0]"
        );
        let plugins: v5::PluginListResult = ask(
            &mut client,
            "plugin.list",
            location_scope("/project"),
            v5::PluginListRequest {
                query: query("/project", None),
            },
        )
        .await;
        assert_eq!(
            plugins
                .data
                .items
                .iter()
                .map(|plugin| units(&plugin.id))
                .collect::<Vec<_>>(),
            ["ycoding.agent", "trusted-process"]
        );
        drop(client);
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn model_profiles_defaults_and_unavailable_preferences_preserve_canonical_identity() {
    bounded(async {
        let work = world()
            .core
            .credentials
            .create(
                "catalog-work".into(),
                "fixture-auth".into(),
                Some("Work".into()),
                Secret::new(
                    credential::Value::Key(credential::Key {
                        key: "synthetic-work".into(),
                        metadata: None,
                    })
                    .encode(),
                )
                .unwrap(),
                1,
            )
            .await
            .unwrap();
        let mut catalog = base_catalog();
        catalog.account_update(
            &work,
            provider::Id("fixture".into()),
            catalog.providers[0].models.clone(),
        );
        catalog.set_default(Some(ycoding_core::ycoding_schema::model::Ref {
            provider_id: provider::Id("fixture".into()),
            id: "code".into(),
            profile: Some(ProfileName("Work".into())),
            variant: Some("high".into()),
        }));
        let mut unavailable = base_catalog();
        unavailable.set_default(Some(ycoding_core::ycoding_schema::model::Ref {
            provider_id: provider::Id("fixture".into()),
            id: "code".into(),
            profile: Some(ProfileName("Missing".into())),
            variant: Some("high".into()),
        }));
        let server = start(
            settings(
                fixture(catalog, task(Ok(()))),
                Some(fixture(unavailable, task(Ok(())))),
            ),
            standard().unwrap(),
        )
        .await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let defaults: v5::ModelDefaultResult = ask(
            &mut client,
            "model.default",
            location_scope("/project"),
            v5::ModelDefaultRequest {
                query: query("/project", None),
            },
        )
        .await;
        let v5::model_default_result_data::Kind::Value1(defaults) = defaults.data.kind.unwrap()
        else {
            panic!("expected profile default")
        };
        assert_eq!(units(defaults.selection.profile.as_ref().unwrap()), "Work");
        assert_eq!(units(defaults.selection.variant.as_ref().unwrap()), "high");
        assert_eq!(units(&defaults.selection.id), "code");
        let profile = &defaults.profiles.unwrap().items[0];
        assert_eq!(units(&profile.name), "Work");
        assert_eq!(
            profile
                .variants
                .as_ref()
                .unwrap()
                .items
                .iter()
                .map(units)
                .collect::<Vec<_>>(),
            ["high"]
        );
        let unavailable: v5::ModelDefaultResult = ask(
            &mut client,
            "model.default",
            location_scope("/project/team"),
            v5::ModelDefaultRequest {
                query: query("/project/team", None),
            },
        )
        .await;
        assert!(matches!(
            unavailable.data.kind,
            Some(v5::model_default_result_data::Kind::None(_))
        ));
        drop(client);
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_catalogs_and_failed_initialization_answer_declared_failures() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let payload = rejected(
            client
                .call(
                    "agent.list",
                    location_scope("/project"),
                    v5::AgentListRequest {
                        query: query("/project", None),
                    }
                    .encode_to_vec(),
                )
                .await,
        );
        assert!(
            operation("agent.list")
                .error_types
                .contains(&payload.type_name)
        );
        drop(client);
        server.shutdown().await.unwrap();
        let mut catalogs = fixture(base_catalog(), task(Ok(())));
        catalogs.ready = task(Err("private-error".into()));
        let server = start(settings(catalogs, None), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let failed: v5::ServiceUnavailableError = refuse(
            &mut client,
            "model.default",
            location_scope("/project"),
            v5::ModelDefaultRequest {
                query: query("/project", None),
            },
        )
        .await;
        assert_eq!(units(failed.service.as_ref().unwrap()), "model.catalog");
        assert_eq!(units(&failed.message), "Catalog initialization failed");
        let mappings: v5::ServiceUnavailableError = refuse(
            &mut client,
            "provider.integrations",
            location_scope("/project"),
            v5::ProviderIntegrationsRequest {
                query: query("/project", None),
            },
        )
        .await;
        assert_eq!(
            units(mappings.service.as_ref().unwrap()),
            "provider.integrations"
        );
        drop(client);
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refresh_publishes_a_shared_catalog_snapshot_without_blocking_reads() {
    bounded(async {
        let state = Arc::new(Mutex::new(fixture(base_catalog(), task(Ok(())))));
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let changed = Arc::downgrade(&state);
        let started = entered.clone();
        let released = release.clone();
        state.lock().unwrap().refresh = Arc::new(move || {
            let changed = changed.clone();
            let started = started.clone();
            let released = released.clone();
            Box::pin(async move {
                started.notify_one();
                released.notified().await;
                let changed = changed.upgrade().ok_or("Location closed".to_owned())?;
                let mut current = changed.lock().unwrap();
                let mut catalog = base_catalog();
                catalog.providers[0].models[0].name = "Refreshed model".into();
                let models = Arc::new(model::Resolver::new(catalog));
                current.generate = Arc::new(generate::Service {
                    models: models.clone(),
                    credentials: current.generate.credentials.clone(),
                    integrations: current.generate.integrations.clone(),
                    executor: current.generate.executor.clone(),
                    cursor: None,
                });
                current.models = models;
                Ok(())
            })
        });
        let mut settings = services(LocalAuth::disabled(), true);
        let supplied = state.clone();
        settings.core.as_mut().unwrap().catalogs =
            Some(Arc::new(move |_| Ok(supplied.lock().unwrap().clone())));
        let server = start(settings, standard().unwrap()).await;
        let mut refresh_client = Client::open(server.address(), &[]).await.unwrap();
        let mut reader = Client::open(server.address(), &[]).await.unwrap();
        let refresh = async move {
            let _: v5::ProviderRefreshResult = ask(
                &mut refresh_client,
                "provider.refresh",
                location_scope("/project"),
                v5::ProviderRefreshRequest {
                    query: query("/project", None),
                },
            )
            .await;
            drop(refresh_client);
        };
        let read = async {
            entered.notified().await;
            let old: v5::ModelListResult = ask(
                &mut reader,
                "model.list",
                location_scope("/project"),
                v5::ModelListRequest {
                    query: query("/project", None),
                },
            )
            .await;
            assert_eq!(units(&old.data.items[0].name), "Code");
            release.notify_one();
        };
        tokio::join!(refresh, read);
        let fresh: v5::ModelListResult = ask(
            &mut reader,
            "model.list",
            location_scope("/project"),
            v5::ModelListRequest {
                query: query("/project", None),
            },
        )
        .await;
        assert_eq!(units(&fresh.data.items[0].name), "Refreshed model");
        let selected: v5::ModelDefaultResult = ask(
            &mut reader,
            "model.default",
            location_scope("/project"),
            v5::ModelDefaultRequest {
                query: query("/project", None),
            },
        )
        .await;
        let v5::model_default_result_data::Kind::Value1(selected) = selected.data.kind.unwrap()
        else {
            panic!()
        };
        assert_eq!(units(&selected.name), "Refreshed model");
        {
            let current = state.lock().unwrap();
            assert!(Arc::ptr_eq(&current.models, &current.generate.models));
        }
        drop(reader);
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn initialization_has_a_bounded_typed_timeout_and_catalog_identity_is_enforced() {
    bounded(async {
        let mut catalogs = fixture(base_catalog(), task(Ok(())));
        catalogs.ready = Arc::new(|| Box::pin(std::future::pending()));
        let server = start(settings(catalogs, None), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let failed: v5::ServiceUnavailableError = refuse(
            &mut client,
            "model.default",
            location_scope("/project"),
            v5::ModelDefaultRequest {
                query: query("/project", None),
            },
        )
        .await;
        assert_eq!(
            units(&failed.message),
            "Model catalog initialization timed out"
        );
        let _: v5::ModelListResult = ask(
            &mut client,
            "model.list",
            location_scope("/project"),
            v5::ModelListRequest {
                query: query("/project", None),
            },
        )
        .await;
        drop(client);
        server.shutdown().await.unwrap();
        let mut catalogs = fixture(base_catalog(), task(Ok(())));
        catalogs.models = Arc::new(model::Resolver::new(base_catalog()));
        let server = start(settings(catalogs, None), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let failed: v5::ServiceUnavailableError = refuse(
            &mut client,
            "model.list",
            location_scope("/project"),
            v5::ModelListRequest {
                query: query("/project", None),
            },
        )
        .await;
        assert_eq!(
            units(&failed.message),
            "Location catalog and generation model services disagree"
        );
        drop(client);
        server.shutdown().await.unwrap();
    })
    .await;
}

async fn http(response: &str) -> (String, tokio::task::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let response = response.to_owned();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut data = Vec::new();
        let mut buffer = [0; 4096];
        let body = loop {
            let count = socket.read(&mut buffer).await.unwrap();
            assert!(count > 0 && data.len() < 1024 * 1024);
            data.extend_from_slice(&buffer[..count]);
            let Some(end) = data.windows(4).position(|window| window == b"\r\n\r\n") else {
                continue;
            };
            let headers = String::from_utf8_lossy(&data[..end]);
            let length = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length: ")
                        .map(|length| length.parse::<usize>().unwrap())
                })
                .unwrap();
            if data.len() < end + 4 + length {
                continue;
            }
            break String::from_utf8(data[end + 4..end + 4 + length].to_vec()).unwrap();
        };
        socket.write_all(response.as_bytes()).await.unwrap();
        socket.shutdown().await.unwrap();
        body
    });
    (url, task)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stateless_generation_reaches_real_provider_adapter_and_returns_typed_text_or_safe_errors()
{
    bounded(async {
        let sse = "data: {\"id\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"generated answer\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
        let (url, provider) = http(&format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{sse}", sse.len())).await;
        let mut catalog = base_catalog();
        catalog.configure(&[parse_json(&format!(r#"{{"providers":{{"fixture":{{"settings":{{"baseURL":"{url}"}}}}}}}}"#)).unwrap()]).unwrap();
        let server = start(settings(fixture(catalog, task(Ok(()))), None), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let request = v5::GenerateTextRequest { query: query("/project", None), payload: v5::GenerateTextRequestPayload { prompt: text("Explain the boundary"), model: Some(v5::ModelRef { provider_id: text("fixture"), id: text("code"), profile: None, variant: Some(text("high")) }) } };
        let generated: v5::GenerateTextResult = ask(&mut client, "generate.text", location_scope("/project"), request.clone()).await;
        assert_eq!(units(&generated.data.data.text), "generated answer");
        let body = parse_json(&provider.await.unwrap()).unwrap();
        let JsonValue::Object(body) = body else { panic!() };
        assert_eq!(body.get(&"model".into()), Some(&JsonValue::String("api-code".into())));
        assert_eq!(body.get(&"service_tier".into()), Some(&JsonValue::String("priority".into())));
        assert_eq!(body.get(&"messages".into()), Some(&parse_json(r#"[{"role":"user","content":"Explain the boundary"}]"#).unwrap()));
        let mut missing = request;
        missing.payload.model.as_mut().unwrap().profile = Some(text("Unavailable"));
        let failed: v5::InvalidRequestError = refuse(&mut client, "generate.text", location_scope("/project"), missing).await;
        assert_eq!(units(&failed.message), "Profile unavailable for fixture: Unavailable");
        drop(client); server.shutdown().await.unwrap();
        let error = "private-header synthetic-secret internal-identity account@example.test";
        let (url, provider) = http(&format!("HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-Private: synthetic-secret\r\nConnection: close\r\n\r\n{error}", error.len())).await;
        let mut catalog = base_catalog();
        catalog.configure(&[parse_json(&format!(r#"{{"providers":{{"fixture":{{"settings":{{"baseURL":"{url}"}}}}}}}}"#)).unwrap()]).unwrap();
        let server = start(settings(fixture(catalog, task(Ok(()))), None), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let failed: v5::ServiceUnavailableError = refuse(&mut client, "generate.text", location_scope("/project"), v5::GenerateTextRequest { query: query("/project", None), payload: v5::GenerateTextRequestPayload { prompt: text("p"), model: None } }).await;
        assert_eq!(units(&failed.message), "Text generation failed");
        assert_eq!(units(failed.service.as_ref().unwrap()), "fixture");
        provider.await.unwrap();
        drop(client); server.shutdown().await.unwrap();
    }).await;
}
