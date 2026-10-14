use std::path::Path;
use ycoding_core::resources::{agent, discovery, reference, skill};
use ycoding_schema::{DomainDecode, parse_json};

fn configuration(content: &str) -> std::sync::Arc<ycoding_core::resources::config::Configuration> {
    use ycoding_core::resources::config::{Configuration, LoadOptions, Roots};
    let roots = Roots::development(
        &std::env::temp_dir().join(format!("ycoding-guidance-{}", std::process::id())),
    )
    .unwrap();
    std::sync::Arc::new(
        Configuration::load(LoadOptions {
            directory: roots.home.clone(),
            roots,
            project: false,
            file: None,
            content: Some(content.into()),
            env: Default::default(),
        })
        .unwrap(),
    )
}

#[tokio::test]
async fn builtin_tool_dependencies_follow_agent_ceiling_and_codemode() {
    use std::sync::Arc;
    use ycoding_core::{
        instructions::{self, Observation, builtins},
        resources::{memory, project_artifact, tool_output_store},
        session::instruction_assembly,
        tools::registry::{DynamicTool, Options, Registry},
    };
    for (content, codemode, subagent, denied) in [
        (
            r#"{}"#,
            false,
            false,
            vec!["core/shell-memory", "ycoding/workspace-memory"],
        ),
        (
            r#"{"capabilities":{"tools":{"deny":["execute"]}}}"#,
            true,
            false,
            vec![
                "core/shell-memory",
                "core/subagent-reuse",
                "core/decision-use",
                "core/task-completion",
                "core/human-input",
                "core/project-artifact-authoring",
                "ycoding/project-artifact-authoring",
                "ycoding/workspace-memory",
            ],
        ),
        (
            r#"{"capabilities":{"tools":{"allow":["shell"]}}}"#,
            true,
            false,
            vec![
                "core/subagent-reuse",
                "core/decision-use",
                "ycoding/workspace-memory",
            ],
        ),
        (
            r#"{}"#,
            false,
            true,
            vec![
                "core/subagent-reuse",
                "core/shell-memory",
                "ycoding/workspace-memory",
            ],
        ),
        (
            r#"{"capabilities":{"builtin_instructions":{"deny":["date","decision-use"]},"project_artifacts":false}}"#,
            false,
            false,
            vec![
                "core/date",
                "core/decision-use",
                "core/project-artifact-authoring",
                "ycoding/project-artifact-authoring",
            ],
        ),
    ] {
        let config = configuration(content);
        let registry = Registry::new(
            Arc::new(tool_output_store::Store::new(config.roots())),
            Some(config.clone()),
            Default::default(),
            Arc::new(|a, b| a.cmp(b)),
        );
        let _scope = registry
            .register(
                [
                    "subagent",
                    "shell",
                    "question",
                    "decision",
                    "task_complete",
                    "project_artifact",
                    "memory",
                ]
                .iter()
                .map(|name| {
                    (
                        (*name).into(),
                        Arc::new(DynamicTool::new(
                            "test",
                            ycoding_schema::JsonValue::Null,
                            None,
                            None,
                            |_, _| {
                                Box::pin(async {
                                    Ok(ycoding_ai::llm::ToolOutput {
                                        structured: ycoding_schema::JsonValue::Null,
                                        content: vec![],
                                    })
                                })
                            },
                        )) as Arc<dyn ycoding_core::tools::registry::Tool>,
                    )
                })
                .collect(),
                Options {
                    namespace: None,
                    codemode,
                },
            )
            .unwrap();
        let mut agent = agent::empty("build".into());
        agent.mode = if subagent { "subagent" } else { "primary" }.into();
        let ceiling = if content == "{}" {
            ["shell", "memory"]
                .iter()
                .map(|action| ycoding_schema::permission::Rule {
                    action: (*action).into(),
                    effect: ycoding_schema::permission::Effect("deny".into()),
                    resource: "*".into(),
                })
                .collect::<Vec<_>>()
        } else {
            vec![]
        };
        let mut sources = builtins::load(
            builtins::Environment {
                directory: "/project".into(),
                project_root: "/project".into(),
                git: true,
                platform: "test".into(),
            },
            Arc::new(|| 0),
        );
        sources.push(memory::instructions::source());
        sources.push(project_artifact::instructions::source());
        let selected =
            instruction_assembly::select_sources(&sources, &agent, &ceiling, &config, &registry);
        let observed = instructions::read(&selected).await.unwrap();
        assert_eq!(selected.len(), sources.len());
        for key in denied {
            assert_eq!(
                observed
                    .iter()
                    .find(|entry| ycoding_schema::DomainEncode::encode(&entry.key)
                        == ycoding_schema::JsonValue::String(key.into()))
                    .unwrap()
                    .value,
                Observation::Removed,
                "{content}/{key}"
            );
        }
        assert!(matches!(observed[0].value, Observation::Value(_)));
        if content.contains(r#""allow":["shell"]"#) {
            assert!(matches!(
                observed
                    .iter()
                    .find(|entry| ycoding_schema::DomainEncode::encode(&entry.key)
                        == ycoding_schema::JsonValue::String("core/shell-memory".into()))
                    .unwrap()
                    .value,
                Observation::Value(_)
            ));
        }
    }
}

#[tokio::test]
async fn memory_off_removes_all_memory_guidance() {
    use std::sync::Arc;
    use ycoding_core::{
        instructions::{self, Observation},
        resources::{memory, tool_output_store},
        session::instruction_assembly,
        tools::registry::{DynamicTool, Options, Registry},
    };
    let config = configuration(r#"{"memory":{"enabled":false}}"#);
    let registry = Registry::new(
        Arc::new(tool_output_store::Store::new(config.roots())),
        Some(config.clone()),
        Default::default(),
        Arc::new(|a, b| a.cmp(b)),
    );
    let _scope = registry
        .register(
            vec![(
                "memory".into(),
                Arc::new(DynamicTool::new(
                    "memory",
                    ycoding_schema::JsonValue::Null,
                    None,
                    None,
                    |_, _| Box::pin(async { unreachable!() }),
                )),
            )],
            Options::direct(),
        )
        .unwrap();
    let sources = [
        memory::instructions::source(),
        instructions::constant("core/memory", memory::instructions::CONTENT),
    ];
    let selected = instruction_assembly::select_sources(
        &sources,
        &agent::empty("build".into()),
        &[],
        &config,
        &registry,
    );
    assert!(
        instructions::read(&selected)
            .await
            .unwrap()
            .iter()
            .all(|entry| entry.value == Observation::Removed)
    );
}

#[test]
fn skill_guidance_filters_denies_and_autoinvoke_and_escapes_xml_then_renders_deltas() {
    let a = skill::from_frontmatter(
        Path::new("/skills/a.md"),
        Path::new("/skills"),
        &parse_json(r#"{"name":"<A & 'quote'\">","description":"Description"}"#).unwrap(),
        "A",
    )
    .unwrap();
    let mut b = a.clone();
    b.id = "b".into();
    b.name = "B".into();
    b.description = Some("B description".into());
    let mut c = a.clone();
    c.id = "c".into();
    c.autoinvoke = Some(false);
    let mut selected = agent::empty("reviewer".into());
    selected.permissions.push(
        ycoding_schema::permission::Rule::decode(
            &parse_json(r#"{"action":"s?ill","resource":"b","effect":"deny"}"#).unwrap(),
        )
        .unwrap(),
    );
    let skills = vec![a.clone(), b.clone(), c];
    let allowed = skill::available(&skills, &selected);
    assert_eq!(
        allowed.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
        vec!["a".into(), "c".into()]
    );
    let before = skill::instructions::summaries_by(&allowed, |a, b| a.cmp(b));
    assert_eq!(before.len(), 1);
    let rendered = skill::instructions::render(&before).to_utf8().unwrap();
    assert!(rendered.contains("<name>&lt;A &amp; &apos;quote&apos;&quot;&gt;</name>"));
    let after = skill::instructions::summaries_by(&[&a, &b], |a, b| a.cmp(b));
    assert!(
        skill::instructions::changed(&before, &after)
            .to_utf8()
            .unwrap()
            .starts_with("New skills are available in addition to those previously listed:")
    );
    assert!(
        skill::instructions::changed(&after, &before)
            .to_utf8()
            .unwrap()
            .contains("The following skill IDs are no longer available and must not be used: b.")
    );
    let mut modified = after.clone();
    modified[0].description = "Changed".into();
    assert!(
        skill::instructions::changed(&after, &modified)
            .to_utf8()
            .unwrap()
            .starts_with("The available skills have changed. This list supersedes")
    );
    assert!(
        skill::instructions::render(&[])
            .to_utf8()
            .unwrap()
            .ends_with("No skills are currently available.")
    );
}

#[test]
fn reference_guidance_includes_described_even_hidden_sources_and_preserves_ts_markup_and_deltas() {
    let source = ycoding_schema::reference::Source::Local(ycoding_schema::reference::LocalSource {
        path: discovery::absolute_path(Path::new("/one")).unwrap(),
        description: Some("<raw>".into()),
        hidden: Some(true),
    });
    let first = ycoding_schema::reference::Info {
        name: "one".into(),
        path: discovery::absolute_path(Path::new("/one")).unwrap(),
        description: Some("<raw>".into()),
        hidden: Some(true),
        source,
    };
    let mut second = first.clone();
    second.name = "two".into();
    second.path = discovery::absolute_path(Path::new("/two")).unwrap();
    let before =
        reference::instructions::summaries_by(std::slice::from_ref(&first), |a, b| a.cmp(b));
    assert_eq!(before.len(), 1);
    assert!(
        reference::instructions::render(&before)
            .to_utf8()
            .unwrap()
            .contains("<description><raw></description>")
    );
    let after = reference::instructions::summaries_by(&[first, second], |a, b| b.cmp(a));
    assert_eq!(after[0].name, "two".into());
    assert!(
        reference::instructions::changed(&before, &after)
            .to_utf8()
            .unwrap()
            .starts_with(
                "New project references are available in addition to those previously listed:"
            )
    );
    assert!(reference::instructions::changed(&after,&before).to_utf8().unwrap().ends_with("The following project references are no longer available and must not be used: two."));
    let mut changed = before.clone();
    changed[0].path = "/new".into();
    assert!(
        reference::instructions::changed(&before, &changed)
            .to_utf8()
            .unwrap()
            .starts_with("The available project references have changed. This list supersedes")
    );
}
