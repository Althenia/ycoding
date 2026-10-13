use std::{
    fs,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use ycoding_core::resources::{
    catalog::Catalog,
    config::{
        self, Configuration, Endpoint, EndpointApi, EndpointModel, LoadOptions, Mutation,
        MutationPolicy, ProviderConfiguration, Roots, Scope, WriteError,
    },
    mcp,
};
use ycoding_core::ycoding_schema::{DomainDecode, JsonValue, parse_json, provider};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    options: LoadOptions,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "config-ops-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("project")).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let roots = Roots::development(&root).unwrap();
        roots.initialize().unwrap();
        Self {
            options: LoadOptions {
                directory: root.join("project"),
                roots,
                project: true,
                file: None,
                content: None,
                env: Default::default(),
            },
            root,
        }
    }
    fn config(&self) -> Configuration {
        Configuration::load(self.options.clone())
            .unwrap()
            .with_mutation_policy(MutationPolicy(Arc::new(|_| true)))
    }
    fn write(&self, file: &str, text: &str) -> PathBuf {
        let path = self.root.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, text).unwrap();
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn provider(id: &str) -> ProviderConfiguration {
    ProviderConfiguration {
        provider_id: id.into(),
        endpoint: Endpoint::OpenAi {
            base_url: "http://localhost:4567/v1".into(),
            api: EndpointApi::Chat,
        },
        catalog: false,
        models: None,
    }
}
fn local() -> ycoding_core::ycoding_schema::mcp::ServerConfig {
    ycoding_core::ycoding_schema::mcp::ServerConfig::decode(&parse_json(r#"{"type":"local","command":["fixture","--flag"],"environment":{"FIXTURE_KEY":"synthetic-secret"},"cwd":"./tools","disabled":true,"codemode":false,"timeout":{"startup":42}}"#).unwrap()).unwrap()
}

#[test]
fn backend_file_selection_follows_both_ts_precedence_lists() {
    for scope in [Scope::Global, Scope::Project] {
        for (index, selected) in [
            "ycoding.json",
            "ycoding.jsonc",
            ".ycoding/ycoding.json",
            ".ycoding/ycoding.jsonc",
        ]
        .iter()
        .enumerate()
        {
            let fixture = Fixture::new();
            let prefix = if scope == Scope::Global {
                "config/ycoding"
            } else {
                "project"
            };
            for file in [
                "ycoding.json",
                "ycoding.jsonc",
                ".ycoding/ycoding.json",
                ".ycoding/ycoding.jsonc",
            ]
            .iter()
            .skip(index)
            {
                fixture.write(&format!("{prefix}/{file}"), "{}\n");
            }
            let mut config = fixture.config();
            let written = config
                .write_mcp(scope, &"fixture".into(), &local())
                .unwrap();
            assert_eq!(written.path, fixture.root.join(prefix).join(selected));
            config.reload().unwrap();
            let definitions = mcp::configuration::from_entries(&config.entries).unwrap();
            assert!(
                definitions
                    .servers
                    .iter()
                    .any(|(name, _)| name.as_str() == Some("fixture")),
                "{scope:?} {selected} was written but not reloaded"
            );
            let written = config.write_provider(scope, &provider("fixture")).unwrap();
            assert_eq!(
                written.path,
                fixture
                    .root
                    .join(prefix)
                    .join(if index <= 1 { selected } else { "ycoding.json" })
            );
            assert_eq!(written.scope, scope);
        }
    }
    let fixture = Fixture::new();
    assert_eq!(
        fixture
            .config()
            .write_mcp(Scope::Project, &"fixture".into(), &local())
            .unwrap()
            .path,
        fixture.options.directory.join("ycoding.json")
    );
}

#[test]
fn provider_edit_preserves_jsonc_models_comments_formatting_and_false_fields() {
    let fixture = Fixture::new();
    let path = fixture.write("project/ycoding.jsonc", "{\r\n  // keep 😀\r\n  \"default_agent\" : \"god\",\r\n  \"providers\": {\r\n    \"fixture\": {\r\n      \"package\": \"aisdk:@ai-sdk/openai-compatible\",\r\n      \"settings\": {\"extra\":42}, // settings comment\r\n      \"models\": {\"code\": {\"name\":\"Existing\",\"family\":\"kept\",\"capabilities\":{\"input\":[\"text\"]}}},\r\n    },\r\n  },\r\n}\r\n");
    let mut input = provider("fixture");
    input.catalog = true;
    input.models = Some(vec![EndpointModel {
        id: "code".into(),
        model_id: Some("code-api".into()),
        name: None,
        family: None,
        api: Some(EndpointApi::Responses),
        disabled: Some(false),
        tools: Some(false),
    }]);
    let mut config = fixture.config();
    config.write_provider(Scope::Project, &input).unwrap();
    let output = fs::read_to_string(&path).unwrap();
    for retained in [
        "// keep 😀\r\n",
        "  \"default_agent\" : \"god\",",
        "\"extra\":42",
        "// settings comment",
        "\"name\":\"Existing\"",
        "\"family\":\"kept\"",
        "\"input\":[\"text\"]",
    ] {
        assert!(output.contains(retained), "lost {retained}");
    }
    assert!(!output.contains("apiKey"));
    config.reload().unwrap();
    assert!(config.diagnostics.is_empty(), "{:?}", config.diagnostics);
    let catalog = Catalog::from_config(vec![], &config).unwrap();
    let configured = catalog.provider(&provider::Id("fixture".into())).unwrap();
    assert_eq!(configured.package.as_str(), Some(input.package()));
    let model = &catalog.providers[0].models[0];
    assert_eq!(model.name.as_str(), Some("Existing"));
    assert_eq!(model.model_id.as_str(), Some("code-api"));
    assert!(!model.capabilities.tools);
    assert!(model.enabled);
    config.write_provider(Scope::Project, &input).unwrap();
    assert_eq!(fs::read_to_string(path).unwrap(), output);
}

#[tokio::test]
async fn mcp_secret_placement_reloads_real_disabled_local_and_remote_definitions() {
    let fixture = Fixture::new();
    let path = fixture.write(
        "project/ycoding.json",
        "{\n  /* retained */\n  \"default_agent\" : \"god\"\n}\n",
    );
    let mut config = fixture.config();
    config
        .write_mcp(Scope::Project, &"local".into(), &local())
        .unwrap();
    let remote = ycoding_core::ycoding_schema::mcp::ServerConfig::decode(&parse_json(r#"{"type":"remote","url":"https://example.invalid/mcp","headers":{"Authorization":"Bearer synthetic-header"},"oauth":{"client_secret":"synthetic-oauth"},"disabled":true}"#).unwrap()).unwrap();
    config
        .write_mcp(Scope::Project, &"remote".into(), &remote)
        .unwrap();
    let text = fs::read_to_string(path).unwrap();
    assert!(text.contains("/* retained */"));
    assert!(text.contains("  \"default_agent\" : \"god\""));
    let decoded = config::decode_document(&text, "fixture");
    let JsonValue::Object(document) = decoded.info.unwrap() else {
        panic!()
    };
    assert!(document.get(&"providers".into()).is_none());
    let ycoding_core::ycoding_schema::JsonValue::Object(mcp_document) =
        document.get(&"mcp".into()).unwrap()
    else {
        panic!()
    };
    let ycoding_core::ycoding_schema::JsonValue::Object(servers) =
        mcp_document.get(&"servers".into()).unwrap()
    else {
        panic!()
    };
    assert_eq!(
        ycoding_core::ycoding_schema::mcp::ServerConfig::decode(
            servers.get(&"local".into()).unwrap()
        )
        .unwrap(),
        local()
    );
    assert_eq!(
        ycoding_core::ycoding_schema::mcp::ServerConfig::decode(
            servers.get(&"remote".into()).unwrap()
        )
        .unwrap(),
        remote
    );
    config.reload().unwrap();
    let definitions = mcp::configuration::from_entries(&config.entries).unwrap();
    assert_eq!(definitions.servers.len(), 2);
    assert_eq!(definitions.servers[0].1, local());
    assert_eq!(definitions.servers[1].1, definitions.resolve(remote));
    let manager = mcp::Service::new(
        &config.entries,
        fixture.options.directory.clone(),
        "fixture".into(),
        Default::default(),
        Default::default(),
    )
    .unwrap();
    assert!(manager.servers().unwrap().iter().all(|server| matches!(
        server.status,
        ycoding_core::ycoding_schema::mcp::Status::Disabled
    )));
    manager.shutdown().await.unwrap();
}

#[test]
fn validation_collisions_and_denied_scopes_never_modify_files() {
    let fixture = Fixture::new();
    let path = fixture.write(
        "project/ycoding.json",
        "{\"providers\":{\"fixture\":{\"package\":\"other\"}}}\n",
    );
    assert_eq!(
        fixture
            .config()
            .write_provider(Scope::Project, &provider("fixture")),
        Err(WriteError::ProviderCollision)
    );
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "{\"providers\":{\"fixture\":{\"package\":\"other\"}}}\n"
    );
    for text in [
        "{broken",
        "[]",
        "{\"providers\":false}",
        "{\"providers\":{\"fixture\":{\"settings\":[]}}}",
        "{\"providers\":{\"fixture\":{\"models\":false}}}",
    ] {
        fs::write(&path, text).unwrap();
        assert_eq!(
            fixture
                .config()
                .write_provider(Scope::Project, &provider("fixture")),
            Err(WriteError::InvalidConfig)
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
    }
    fs::write(&path, "{}\n").unwrap();
    let config = Configuration::load(fixture.options.clone()).unwrap();
    assert_eq!(
        config.write_provider(Scope::Project, &provider("fixture")),
        Err(WriteError::ScopeNotAllowed)
    );
    let config = config.with_mutation_policy(MutationPolicy(Arc::new(|mutation| matches!(mutation, Mutation::Configuration(target) if target.scope == Scope::Project))));
    assert_eq!(
        config.write_provider(Scope::Global, &provider("fixture")),
        Err(WriteError::ScopeNotAllowed)
    );
    assert!(!fixture.options.roots.config.join("ycoding.json").exists());
    let mut options = fixture.options.clone();
    options.project = false;
    let config = Configuration::load(options)
        .unwrap()
        .with_mutation_policy(MutationPolicy(Arc::new(|_| true)));
    assert_eq!(
        config.write_mcp(Scope::Project, &"fixture".into(), &local()),
        Err(WriteError::ScopeNotAllowed)
    );
    assert_eq!(fs::read_to_string(path).unwrap(), "{}\n");
}

#[test]
fn endpoint_and_model_boundaries_reject_invalid_input() {
    let fixture = Fixture::new();
    let config = fixture.config();
    for url in [
        "relative",
        "file:///tmp/file",
        "https://user:secret@example.invalid/v1",
        "https://example.invalid/?api_key=synthetic",
        "https://example.invalid/#token",
    ] {
        let mut input = provider("fixture");
        input.endpoint = Endpoint::OpenAi {
            base_url: url.into(),
            api: EndpointApi::Chat,
        };
        assert_eq!(
            config.write_provider(Scope::Project, &input),
            Err(WriteError::InvalidConfig)
        );
    }
    for id in ["", " leading", "line\nfeed"] {
        assert_eq!(
            config.write_provider(Scope::Project, &provider(id)),
            Err(WriteError::InvalidConfig)
        );
    }
    let mut input = provider("fixture");
    let model = EndpointModel {
        id: "code".into(),
        model_id: None,
        name: None,
        family: None,
        api: None,
        disabled: None,
        tools: None,
    };
    input.models = Some(vec![model.clone(), model]);
    assert_eq!(
        config.write_provider(Scope::Project, &input),
        Err(WriteError::InvalidConfig)
    );
    input.models = Some(vec![]);
    input.endpoint = Endpoint::Runpod {
        base_url: "https://api.runpod.ai/v2/endpoint_ID-1".into(),
        worker: config::EndpointWorker::Vllm,
    };
    config.write_provider(Scope::Project, &input).unwrap();
    let text = fs::read_to_string(fixture.options.directory.join("ycoding.json")).unwrap();
    assert!(text.contains("\"worker\": \"vllm\"") || text.contains("\"worker\":\"vllm\""));
    assert!(!text.contains("\"api\""));
    input.catalog = true;
    assert_eq!(
        config.write_provider(Scope::Project, &input),
        Err(WriteError::InvalidConfig)
    );
    input.catalog = false;
    input.endpoint = Endpoint::Runpod {
        base_url: "https://api.runpod.ai/v2/id/extra".into(),
        worker: config::EndpointWorker::Ollama,
    };
    assert_eq!(
        config.write_provider(Scope::Project, &input),
        Err(WriteError::InvalidConfig)
    );
}

#[test]
fn concurrent_writers_preserve_every_named_definition() {
    let fixture = Fixture::new();
    let configuration = Arc::new(fixture.config());
    std::thread::scope(|scope| {
        for index in 0..8 {
            let configuration = configuration.clone();
            scope.spawn(move || {
                configuration
                    .write_mcp(
                        Scope::Project,
                        &format!("server-{index}").as_str().into(),
                        &local(),
                    )
                    .unwrap()
            });
        }
    });
    let configuration = fixture.config();
    assert_eq!(
        mcp::configuration::from_entries(&configuration.entries)
            .unwrap()
            .servers
            .len(),
        8
    );
}

#[tokio::test]
async fn ts_endpoint_packages_reload_and_register_native_routes_without_dynamic_loading() {
    let fixture = Fixture::new();
    fixture.write("project/ycoding.jsonc", r#"{
      // TS custom endpoint declarations
      "providers": {
        "compatible": {"package":"aisdk:@ai-sdk/openai-compatible","settings":{"baseURL":"http://localhost:4567/v1","api":"responses"},"models":{"code":{"capabilities":{"tools":false}}}},
        "jobs": {"package":"@ycoding-ai/ai/providers/runpod","settings":{"baseURL":"https://api.runpod.ai/v2/fixture","worker":"ollama"},"models":{"code":{}}}
      }
    }"#);
    let mut config = fixture.config();
    config.reload().unwrap();
    assert!(config.diagnostics.is_empty());
    ycoding_core::extension::Configuration::reject_obsolete(&config).unwrap();
    let catalog = Catalog::from_config(vec![], &config).unwrap();
    let store = ycoding_core::ycoding_store::Store::initialize(
        fixture.root.join("auth.redb"),
        ycoding_core::ycoding_store::Options::core(),
        ycoding_core::ycoding_store::import::catalog(
            ycoding_core::ycoding_store::import::DatabaseKind::Core,
        ),
        ycoding_core::ycoding_store::Metadata::new([43; 16], 1),
    )
    .unwrap();
    let credentials = ycoding_core::resources::credential::Service::new(store.client());
    let registry = ycoding_core::resources::auth::integration::Registry::new(
        credentials.clone(),
        Default::default(),
    );
    let mut draft = ycoding_core::resources::auth::integration::Draft::default();
    draft.register_endpoints(&catalog);
    let registration = registry
        .transform(move |current| current.extend(&draft))
        .unwrap();
    for (id, family) in [
        (
            "compatible",
            ycoding_core::resources::model::ProviderFamily::Compatible,
        ),
        (
            "jobs",
            ycoding_core::resources::model::ProviderFamily::RunPod,
        ),
    ] {
        let provider = catalog.provider(&provider::Id(id.into())).unwrap();
        assert_eq!(
            ycoding_core::resources::model::family(&provider.package).unwrap(),
            family
        );
        let integration = registry.get(&id.into()).unwrap().unwrap();
        assert_eq!(integration.id.as_lossless(), &id.into());
        assert!(integration.methods.iter().any(|method| matches!(
            method,
            ycoding_core::ycoding_schema::integration::Method::Key(_)
        )));
    }
    assert!(credentials.all().unwrap().is_empty());
    drop(registration);
    registry.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
}

#[test]
fn both_guards_keep_every_unapproved_package_and_singular_provider_form_rejected() {
    let fixture = Fixture::new();
    for declaration in [
        r#"{"providers":{"fixture":{"package":"@example/provider"}}}"#,
        r#"{"providers":{"fixture":{"package":"@ai-sdk/openai-compatible"}}}"#,
        r#"{"providers":{"fixture":{"package":"aisdk:@ai-sdk/openai-compatible","models":{"code":{"package":"aisdk:@ai-sdk/openai-compatible"}}}}}"#,
        r#"{"providers":{"fixture":{"package":"@ycoding-ai/ai/providers/runpod","npm":"@example/provider"}}}"#,
        r#"{"providers":{"fixture":{"package":"@ycoding-ai/ai/providers/runpod","plugin":"@example/provider"}}}"#,
        r#"{"provider":{"fixture":{"package":"aisdk:@ai-sdk/openai-compatible"}}}"#,
        r#"{"npm":[]}"#,
        r#"{"plugin":"@example/provider"}"#,
    ] {
        let decoded = config::decode_document(declaration, "fixture");
        assert!(decoded.info.is_none(), "accepted {declaration}");
        let mut options = fixture.options.clone();
        options.content = Some(declaration.into());
        let configuration = Configuration::load(options).unwrap();
        assert!(matches!(
            ycoding_core::extension::Configuration::reject_obsolete(&configuration),
            Err(ycoding_core::extension::Error::ObsoleteConfiguration)
        ));
        let mut configuration = fixture.config();
        configuration.entries.push(config::Entry::Document {
            path: None,
            info: parse_json(declaration).unwrap(),
        });
        assert!(
            matches!(
                ycoding_core::extension::Configuration::reject_obsolete(&configuration),
                Err(ycoding_core::extension::Error::ObsoleteConfiguration)
            ),
            "supervisor accepted {declaration}"
        );
    }
}

#[test]
fn scoped_writes_reload_under_ordered_global_project_and_source_overlays() {
    let mut fixture = Fixture::new();
    fixture.write("config/ycoding/ycoding.json", r#"{"providers":{"fixture":{"package":"aisdk:@ai-sdk/openai-compatible","settings":{"extra":"global"},"models":{"code":{"name":"Global","family":"global-family"}}}}}"#);
    fixture.write(
        "project/.ycoding/ycoding.jsonc",
        r#"{"providers":{"fixture":{"models":{"code":{"family":"project-family"}}}}}"#,
    );
    fixture.options.content =
        Some(r#"{"providers":{"fixture":{"models":{"code":{"name":"Source"}}}}}"#.into());
    let mut config = fixture.config();
    let mut input = provider("fixture");
    input.models = Some(vec![EndpointModel {
        id: "code".into(),
        model_id: Some("served-code".into()),
        name: Some("Written".into()),
        family: None,
        api: None,
        disabled: Some(false),
        tools: Some(false),
    }]);
    let target = config.write_provider(Scope::Project, &input).unwrap();
    assert_eq!(target.path, fixture.options.directory.join("ycoding.json"));
    let written = fs::read_to_string(&target.path).unwrap();
    assert!(written.starts_with("{\n  \"providers\": {\n    \"fixture\": {\n"));
    config.reload().unwrap();
    let catalog = Catalog::from_config(vec![], &config).unwrap();
    let model = &catalog.providers[0].models[0];
    assert_eq!(model.name.as_str(), Some("Source"));
    assert_eq!(
        model.family.as_ref().unwrap().as_str(),
        Some("project-family")
    );
    assert_eq!(model.model_id.as_str(), Some("served-code"));
    assert!(
        fs::read_to_string(fixture.options.roots.config.join("ycoding.json"))
            .unwrap()
            .contains("Global")
    );
}

#[test]
fn invalid_mcp_and_io_failures_are_explicit_and_jsonc_bom_is_preserved() {
    let fixture = Fixture::new();
    let configuration = fixture.config();
    for config in [
        r#"{"type":"local","command":[]}"#,
        r#"{"type":"local","command":[""]}"#,
        r#"{"type":"remote","url":"relative"}"#,
    ] {
        let config =
            ycoding_core::ycoding_schema::mcp::ServerConfig::decode(&parse_json(config).unwrap())
                .unwrap();
        assert_eq!(
            configuration.write_mcp(Scope::Project, &"fixture".into(), &config),
            Err(WriteError::InvalidConfig)
        );
    }
    assert!(!fixture.options.directory.join("ycoding.json").exists());
    fs::create_dir(fixture.options.directory.join("ycoding.json")).unwrap();
    assert_eq!(
        configuration.write_provider(Scope::Project, &provider("fixture")),
        Err(WriteError::WriteFailed)
    );
    let fixture = Fixture::new();
    let path = fixture.write(
        "project/ycoding.jsonc",
        "\u{feff}{\r\n  // retained BOM comment\r\n  \"default_agent\" : \"god\"\r\n}\r\n",
    );
    fixture
        .config()
        .write_mcp(Scope::Project, &"fixture".into(), &local())
        .unwrap();
    let text = fs::read_to_string(path).unwrap();
    assert!(text.starts_with('\u{feff}'));
    assert!(text.contains("// retained BOM comment\r\n"));
    assert!(fixture.config().diagnostics.is_empty());
}
