#![cfg(unix)]

include!("tool_fixture.rs");

use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use ycoding_ai::llm::ToolOutput;
use ycoding_core::{
    extension::{
        Activation, Host, Launch,
        plugin::{Operation, resolve_builtins},
    },
    resources::{
        agent,
        catalog::Catalog,
        command::Service as CommandService,
        config::{Configuration, Entry, LoadOptions, Roots},
        model::ProviderContext,
        skill::Service as SkillService,
    },
    session::generate,
    tools::registry::{DynamicTool, Options as RegistryOptions, Registry, Tool},
};
use ycoding_schema::{DomainDecode, JsonValue, model, parse_json};

static NEXT: AtomicU64 = AtomicU64::new(0);

fn remove(selector: &str) -> Operation {
    Operation::Remove(selector.into())
}

fn add(target: &str) -> Operation {
    Operation::Add {
        target: target.into(),
        options: JsonValue::Object(Default::default()),
    }
}

#[test]
fn ordered_operations_disable_and_reselect_disableable_built_ins() {
    let builtins = resolve_builtins(&[remove("ycoding.tool.read"), remove("ycoding.tool.*")]);
    assert!(builtins.is_disabled("ycoding.tool.read"));
    assert!(builtins.is_disabled("ycoding.tool.shell"));
    assert!(!builtins.is_disabled("ycoding.tool.conversation-compact"));
    assert_eq!(builtins.unsupported, ["ycoding.tool.conversation-compact"]);
    let reselected = resolve_builtins(&[remove("ycoding.tool.read"), add("ycoding.tool.read")]);
    assert!(!reselected.is_disabled("ycoding.tool.read"));
    assert!(reselected.disabled.is_empty());
    assert!(reselected.unsupported.is_empty());
    assert!(reselected.diagnostic().is_none());
}

#[test]
fn remove_all_then_ycoding_wildcard_restores_every_disableable_built_in() {
    let builtins = resolve_builtins(&[remove("*"), add("ycoding.*")]);
    assert!(builtins.disabled.is_empty(), "{:?}", builtins.disabled);
    assert_eq!(builtins.unsupported, ["opencode.provider.opencode"]);
    let restored = resolve_builtins(&[remove("*"), add("*")]);
    assert!(restored.disabled.is_empty());
    assert!(restored.unsupported.is_empty());
    assert!(restored.diagnostic().is_none());
}

#[test]
fn non_disableable_built_ins_report_one_bounded_diagnostic_and_stay_enabled() {
    let builtins = resolve_builtins(&[
        remove("ycoding.agent"),
        remove("ycoding.provider.*"),
        remove("ycoding.config.skill"),
        remove("ycoding.provider.dynamic"),
    ]);
    assert!(builtins.is_disabled("ycoding.provider.dynamic"));
    assert!(!builtins.is_disabled("ycoding.agent"));
    assert!(!builtins.is_disabled("ycoding.provider.openai"));
    assert!(!builtins.is_disabled("ycoding.config.skill"));
    let diagnostic = builtins.diagnostic().expect("one diagnostic");
    assert_eq!(diagnostic.fail_closed, Some(false));
    let message = diagnostic.message.to_utf8().unwrap();
    for id in [
        "ycoding.agent",
        "ycoding.provider.openai",
        "ycoding.config.skill",
    ] {
        assert!(message.contains(id), "{message}");
    }
    assert!(!message.contains("ycoding.provider.dynamic"), "{message}");
    assert!(builtins.unsupported.len() > 3);
}

fn configured(content: &str) -> (Configuration, PathBuf) {
    let roots = Roots::development(&std::env::temp_dir().join(format!(
        "ycoding-builtin-plugins-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )))
    .unwrap();
    let directory = roots.home.clone();
    let configuration = Configuration::load(LoadOptions {
        directory: directory.clone(),
        roots,
        project: false,
        file: None,
        content: Some(content.into()),
        env: BTreeMap::new(),
    })
    .unwrap();
    assert!(configuration.diagnostics.is_empty());
    (configuration, directory)
}

fn tool(text: &'static str) -> Arc<dyn Tool> {
    Arc::new(DynamicTool::new(
        "Echo text",
        JsonValue::Null,
        None,
        None,
        move |_, _| {
            Box::pin(async move {
                Ok(ToolOutput {
                    structured: JsonValue::String(text.into()),
                    content: vec![],
                })
            })
        },
    ))
}

#[test]
fn disabled_tool_plugins_are_absent_from_the_registry_filter() {
    for (plugins, expected) in [
        (r#"["-ycoding.tool.read"]"#, vec!["shell", "task_complete"]),
        (
            r#"["-ycoding.tool.read","ycoding.tool.read"]"#,
            vec!["read", "shell", "task_complete"],
        ),
        (
            r#"["-ycoding.tool.task-complete","-ycoding.tool.subagent-report"]"#,
            vec!["read", "shell"],
        ),
    ] {
        let (configuration, _) = configured(&format!(r#"{{"plugins":{plugins}}}"#));
        let roots = configuration.roots().clone();
        let registry = Registry::new(
            Arc::new(ycoding_core::resources::tool_output_store::Store::new(
                &roots,
            )),
            Some(Arc::new(configuration)),
            Default::default(),
            Arc::new(|left, right| left.cmp(right)),
        );
        let _registration = registry
            .register(
                vec![
                    ("read".into(), tool("read")),
                    ("shell".into(), tool("shell")),
                    ("task_complete".into(), tool("task_complete")),
                ],
                RegistryOptions::direct(),
            )
            .unwrap();
        assert_eq!(
            registry.available(&[]).into_iter().collect::<Vec<_>>(),
            expected,
            "{plugins}"
        );
        assert_eq!(
            registry
                .materialize(&[])
                .definitions
                .iter()
                .filter_map(|definition| definition.name.as_str())
                .collect::<Vec<_>>(),
            [expected, vec!["execute"]].concat(),
            "{plugins}"
        );
    }
}

#[test]
fn disabling_the_command_plugin_removes_only_bundled_commands() {
    let entries = vec![Entry::Document {
        path: Some(PathBuf::from("/repo/ycoding.json")),
        info: parse_json(
            r#"{"plugins":["-ycoding.command"],"commands":{"mine":{"template":"custom"}}}"#,
        )
        .unwrap(),
    }];
    let service = CommandService::from_project_entries(
        &entries,
        Path::new("/fixture/project"),
        &mut Vec::new(),
    )
    .unwrap();
    assert_eq!(
        service
            .list()
            .iter()
            .map(|command| command.name.to_utf8().unwrap())
            .collect::<Vec<_>>(),
        ["mine"]
    );
    let enabled =
        CommandService::from_project_entries(&[], Path::new("/fixture/project"), &mut Vec::new())
            .unwrap();
    assert_eq!(enabled.list().len(), 2);
}

#[test]
fn disabling_the_skill_plugin_removes_only_bundled_skills() {
    let entries = vec![Entry::Document {
        path: Some(PathBuf::from("/repo/ycoding.json")),
        info: parse_json(r#"{"plugins":["-ycoding.skill"],"skills":["./skills"]}"#).unwrap(),
    }];
    let service = SkillService::from_entries(
        &entries,
        Path::new("/repo/nested"),
        Path::new("/home/test"),
        Path::new("/fixture/cache"),
    )
    .unwrap();
    assert!(service.embedded().is_empty());
    assert!(
        service.sources().iter().all(|source| !source
            .key()
            .to_utf8()
            .unwrap()
            .starts_with("embedded:"))
    );
    let enabled = SkillService::from_entries(
        &[],
        Path::new("/repo/nested"),
        Path::new("/home/test"),
        Path::new("/fixture/cache"),
    )
    .unwrap();
    assert_eq!(
        enabled
            .embedded()
            .iter()
            .map(|skill| skill.id.to_utf8().unwrap())
            .collect::<Vec<_>>(),
        [
            "ycoding",
            "report",
            "chatgpt-connectors",
            "browser-use",
            "computer-use"
        ]
    );
}

fn prompt_catalog(plugins: &str) -> Catalog {
    let mut catalog = Catalog::default();
    catalog
        .configure(&[parse_json(
            r#"{"providers":{"anthropic":{"models":{"claude-sonnet-4":{}}}}}"#,
        )
        .unwrap()])
        .unwrap();
    if !plugins.is_empty() {
        catalog
            .configure(&[parse_json(&format!(r#"{{"plugins":{plugins}}}"#)).unwrap()])
            .unwrap();
    }
    catalog
}

#[test]
fn a_disabled_system_prompt_family_falls_back_to_the_base_prompt() {
    let base = include_str!("../../../../packages/core/src/session/runner/prompt/base.txt");
    let anthropic = include_str!("../src/session/system_prompt/anthropic.txt");
    let selection = model::Ref::decode(
        &parse_json(r#"{"providerID":"anthropic","id":"claude-sonnet-4"}"#).unwrap(),
    )
    .unwrap();
    let texts = |catalog: &Catalog| {
        generate::system(
            &agent::empty("build".into()),
            catalog,
            &selection,
            &[],
            "".into(),
        )
        .into_iter()
        .map(|part| part.text.to_utf8().unwrap())
        .collect::<Vec<_>>()
    };
    assert_eq!(texts(&prompt_catalog("")), [anthropic]);
    assert_eq!(
        texts(&prompt_catalog(r#"["-ycoding.system-prompt.anthropic"]"#)),
        [base]
    );
    assert_eq!(
        texts(&prompt_catalog(
            r#"["-ycoding.system-prompt.anthropic","ycoding.system-prompt.*"]"#
        )),
        [anthropic]
    );
}

fn variant_catalog(plugins: &str) -> Catalog {
    let mut catalog = Catalog::default();
    catalog
        .configure(&[parse_json(&format!(
            r#"{{"plugins":{plugins},"providers":{{"configured":{{"package":"aisdk:@ai-sdk/openai-compatible","models":{{
                "glm-5.2":{{"variants":[{{"id":"high","settings":{{}},"headers":{{"custom":"true"}}}}]}},
                "routed":{{"modelID":"accounts/fireworks/models/GLM-5p2"}},
                "native":{{"package":"aisdk:@ai-sdk/anthropic","modelID":"glm-5-2"}},
                "other":{{"variants":[{{"id":"custom","settings":{{}}}}]}}
            }}}}}}}}"#
        ))
        .unwrap()])
        .unwrap();
    catalog
}

fn variants(catalog: &Catalog, model: &str) -> Vec<String> {
    catalog.providers[0]
        .models
        .iter()
        .find(|info| info.id.to_utf8().unwrap() == model)
        .unwrap()
        .variants
        .iter()
        .map(|variant| {
            format!(
                "{} {}",
                variant.id.to_utf8().unwrap(),
                ycoding_schema::stringify_json(&ycoding_schema::DomainEncode::encode(variant))
            )
        })
        .collect()
}

#[test]
fn the_variant_built_in_generates_glm_variants_after_configured_ones() {
    let catalog = variant_catalog("[]");
    assert!(!catalog.builtin_disabled("ycoding.variant"));
    let high = r#"high {"id":"high","settings":{"reasoningEffort":"high"}}"#;
    let max = r#"max {"id":"max","settings":{"reasoningEffort":"max"}}"#;
    let explicit = r#"high {"id":"high","settings":{},"headers":{"custom":"true"}}"#;
    assert_eq!(variants(&catalog, "glm-5.2"), [explicit, max]);
    assert_eq!(variants(&catalog, "routed"), [high, max]);
    assert!(variants(&catalog, "native").is_empty());
    assert_eq!(
        variants(&catalog, "other"),
        [r#"custom {"id":"custom","settings":{}}"#]
    );
    let reselected = variant_catalog(r#"["-ycoding.variant","ycoding.*"]"#);
    assert_eq!(variants(&reselected, "routed"), [high, max]);
}

#[test]
fn disabling_variants_omits_only_generated_variants() {
    let catalog = variant_catalog(r#"["-ycoding.variant"]"#);
    assert!(catalog.builtin_disabled("ycoding.variant"));
    assert!(!catalog.builtin_disabled("ycoding.agent"));
    assert_eq!(
        variants(&catalog, "glm-5.2"),
        [r#"high {"id":"high","settings":{},"headers":{"custom":"true"}}"#]
    );
    assert!(variants(&catalog, "routed").is_empty());
    assert_eq!(
        variants(&catalog, "other"),
        [r#"custom {"id":"custom","settings":{}}"#]
    );
    let mut sourced = Catalog::default();
    sourced
        .configure(&[parse_json(r#"{"providers":{"fixture":{"models":{"model-a":{}}}}}"#).unwrap()])
        .unwrap();
    sourced.providers[0].models[0].variants = vec![
        model::Variant::decode(&parse_json(r#"{"id":"high","settings":{}}"#).unwrap()).unwrap(),
    ];
    sourced
        .configure(&[parse_json(
            r#"{"plugins":["-ycoding.variant"],"providers":{"fixture":{"models":{"model-a":{"variants":[{"id":"custom","settings":{}}]}}}}}"#,
        )
        .unwrap()])
        .unwrap();
    assert_eq!(
        sourced.providers[0].models[0]
            .variants
            .iter()
            .map(|variant| variant.id.to_utf8().unwrap())
            .collect::<Vec<_>>(),
        ["high", "custom"],
        "source catalog variants are not generated by the variant built-in"
    );
}

#[tokio::test]
async fn plugin_list_omits_disabled_subset_ids_and_keeps_non_disableable_ids() {
    let fixture = ToolFixture::new();
    let (configuration, _) =
        configured(r#"{"plugins":["-ycoding.tool.read","-ycoding.agent","-ycoding.variant"]}"#);
    let activation = Activation::new(
        fixture.root.clone(),
        Default::default(),
        Arc::new(fixture.registry()),
        fixture.policy.clone(),
        Launch::default(),
        Host::default(),
    );
    activation.reload(&configuration).await.unwrap();
    let ids = activation
        .plugin_list()
        .await
        .into_iter()
        .map(|info| info.id.to_utf8().unwrap())
        .collect::<Vec<_>>();
    assert!(!ids.iter().any(|id| id == "ycoding.tool.read"));
    assert!(!ids.iter().any(|id| id == "ycoding.variant"));
    assert!(ids.iter().any(|id| id == "ycoding.agent"));
    assert!(
        ids.iter()
            .any(|id| id == "ycoding.tool.conversation-compact")
    );
    assert_eq!(
        activation.disabled_builtins().await,
        BTreeSet::from(["ycoding.tool.read".to_owned(), "ycoding.variant".to_owned()])
    );
    let diagnostic = activation.builtin_diagnostic().await.unwrap();
    assert!(
        diagnostic
            .message
            .to_utf8()
            .unwrap()
            .contains("ycoding.agent")
    );
    activation.close().await;
    fixture.cleanup();
}

#[tokio::test]
async fn a_disabled_dynamic_provider_fails_without_a_model_package_host() {
    let fixture = ToolFixture::new();
    let (configuration, _) = configured(r#"{"plugins":["-ycoding.provider.dynamic"]}"#);
    let activation = Arc::new(Activation::new(
        fixture.root.clone(),
        Default::default(),
        Arc::new(fixture.registry()),
        fixture.policy.clone(),
        Launch::default(),
        Host::default(),
    ));
    activation.reload(&configuration).await.unwrap();
    assert!(
        activation
            .builtin_disabled("ycoding.provider.dynamic")
            .await
    );
    let context = ProviderContext::new(BTreeMap::new(), "test")
        .unwrap()
        .at(&fixture.root);
    context.bind_plugins(&activation).unwrap();
    let info = model::Info::decode(
        &parse_json(
            r#"{"id":"catalog-alias","modelID":"wire-model","providerID":"fixture.team","name":"Fixture","package":"fixture-sdk","capabilities":{"tools":true,"input":["text"],"output":["text"]},"variants":[],"time":{"released":0},"cost":[],"status":"active","enabled":true,"limit":{"context":131072,"input":120000,"output":8192}}"#,
        )
        .unwrap(),
    )
    .unwrap();
    let failure = context.language_model(&info).await.err().unwrap();
    assert!(
        failure.message.contains("disabled"),
        "dynamic package failure must name the disabled host: {failure:?}"
    );
    activation.close().await;
    fixture.cleanup();
}
