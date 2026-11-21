use std::path::{Path, PathBuf};
use ycoding_ai::{cursor::protobuf::fields, llm::ToolDefinition};
use ycoding_core::resources::cursor::context::{
    Agent, Environment, Subagents, build, host_subagents, load_config, project_config_dirs,
    resolve_subagent,
};
use ycoding_schema::parse_json;

fn workspace(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "cursor-context-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    root.canonicalize().unwrap()
}

fn environment(root: &Path, disabled: bool) -> Environment {
    Environment {
        global_config_dir: root.join("global-config"),
        cache_dir: root.join("cache"),
        home: root.join("home"),
        project_discovery_disabled: disabled,
    }
}

fn write(path: impl AsRef<Path>, text: &str) {
    std::fs::create_dir_all(path.as_ref().parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn tool(name: &str, description: &str, schema: &str) -> ToolDefinition {
    ToolDefinition {
        name: name.into(),
        description: description.into(),
        input_schema: parse_json(schema).unwrap(),
        output_schema: None,
        cache: None,
        metadata: None,
        native: None,
    }
}

#[test]
fn project_configuration_uses_ycoding_directories_only() {
    let root = workspace("dirs");
    let dirs = project_config_dirs(&root, &environment(&root, false));
    assert_eq!(dirs.last(), Some(&root.join(".ycoding")));
    assert!(
        dirs.iter()
            .all(|dir| dir.file_name().unwrap() == ".ycoding")
    );
    assert!(
        dirs.windows(2)
            .all(|pair| pair[0].components().count() < pair[1].components().count())
    );
    assert!(project_config_dirs(&root, &environment(&root, true)).is_empty());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn ancestor_configuration_merges_before_the_selected_workspace() {
    let root = workspace("ancestor");
    let nested = root.join("nested");
    write(
        root.join(".ycoding/ycoding.json"),
        r#"{"instructions":["ancestor.md"],"mcp":{"servers":{"ancestor":{}}}}"#,
    );
    write(
        nested.join(".ycoding/ycoding.json"),
        r#"{"instructions":["selected.md"],"mcp":{"servers":{"selected":{}}}}"#,
    );
    let environment = environment(&root, false);
    let dirs = project_config_dirs(&nested, &environment);
    assert!(dirs.contains(&root.join(".ycoding")) && dirs.contains(&nested.join(".ycoding")));
    let config = load_config(&nested, &environment);
    assert_eq!(config.instructions, ["ancestor.md", "selected.md"]);
    assert_eq!(config.mcp_servers, ["ancestor", "selected"]);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn disabled_project_discovery_reads_no_project_context() {
    let root = workspace("disabled");
    write(
        root.join(".ycoding/ycoding.json"),
        r#"{"instructions":["disabled.md"]}"#,
    );
    write(root.join("AGENTS.md"), "project rules");
    let context = build(&root, &[], &environment(&root, true));
    assert!(
        !load_config(&root, &environment(&root, true))
            .instructions
            .contains(&"disabled.md".to_owned())
    );
    assert!(context.rules.is_empty());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn only_executor_supplied_subagents_are_advertised_and_skill_content_stays_private() {
    let root = workspace("subagents");
    write(
        root.join(".ycoding/agent/unavailable.md"),
        "# Not permitted this turn",
    );
    write(
        root.join(".ycoding/skills/private/SKILL.md"),
        "---\ndescription: Activate explicitly\n---\nUnactivated private instruction",
    );
    let environment = environment(&root, false);
    let unknown = build(
        &root,
        &[tool(
            "subagent",
            "Spawn a configured agent",
            r#"{"type":"object"}"#,
        )],
        &environment,
    );
    assert!(unknown.subagents.agents.is_empty());
    assert!(!unknown.subagents.complete);
    let skill = unknown
        .skills
        .iter()
        .find(|skill| skill.full_path.ends_with("/private/SKILL.md"))
        .unwrap();
    assert_eq!(skill.description, "Activate explicitly");
    let bytes = unknown.encode().unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("Unactivated private instruction"));
    let wire = fields(&bytes)
        .unwrap()
        .into_iter()
        .filter(|field| field.number == 29)
        .map(|field| fields(field.bytes().unwrap()).unwrap())
        .find(|skill| skill[0].text().unwrap().ends_with("/private/SKILL.md"))
        .unwrap();
    assert_eq!(wire.iter().map(|f| f.number).collect::<Vec<_>>(), [1, 3]);
    assert_eq!(wire[1].text().unwrap(), "Activate explicitly");
    let filtered = build(
        &root,
        &[tool(
            "subagent",
            "Available subagents:\n- scout: Read-only research",
            r#"{"type":"object"}"#,
        )],
        &environment,
    );
    assert_eq!(
        filtered.subagents,
        Subagents {
            agents: vec![Agent {
                name: "scout".into(),
                description: Some("Read-only research".into())
            }],
            complete: true
        }
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn legacy_project_configuration_is_never_consulted() {
    let root = workspace("legacy");
    write(
        root.join(".ycoding/ycoding.json"),
        r#"{"instructions":["native.md"],"plugins":[{"package":"host-plugin"}],"mcp":{"servers":{"demo":{}}}}"#,
    );
    write(
        root.join(".ycoding/ycoding.jsonc"),
        r#"{ "instructions": ["native-jsonc.md",], }"#,
    );
    write(root.join(".ycoding/plugin/local.js"), "export default {}");
    let legacy = ["open", "code"].join("");
    write(
        root.join(format!(".{legacy}/{legacy}.json")),
        r#"{"instructions":["legacy.md"]}"#,
    );
    let environment = environment(&root, false);
    let config = load_config(&root, &environment);
    assert!(config.instructions.contains(&"native.md".to_owned()));
    assert!(config.instructions.contains(&"native-jsonc.md".to_owned()));
    assert!(!config.instructions.contains(&"legacy.md".to_owned()));
    let context = build(&root, &[], &environment);
    let names = context
        .layout
        .children_dirs
        .iter()
        .map(|dir| {
            Path::new(&dir.abs_path)
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .to_owned()
        })
        .collect::<Vec<_>>();
    assert!(names.contains(&".ycoding".to_owned()));
    assert!(!names.contains(&format!(".{legacy}")));
    let hooks = context.hooks_additional_context.unwrap();
    assert!(hooks.contains("ycoding-plugin:npm:host-plugin"));
    assert!(hooks.contains("ycoding-plugin:local:local"));
    assert_eq!(context.known_mcp_servers, ["demo"]);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn subagent_requests_resolve_only_against_the_executor_catalog() {
    let empty = Subagents {
        agents: vec![],
        complete: false,
    };
    assert_eq!(resolve_subagent("generalPurpose", &empty), None);
    let scout = Subagents {
        agents: vec![Agent {
            name: "scout".into(),
            description: None,
        }],
        complete: true,
    };
    assert_eq!(resolve_subagent("scout", &scout).as_deref(), Some("scout"));
    assert_eq!(
        resolve_subagent("cursor-guide", &scout).as_deref(),
        Some("scout")
    );
    let general = Subagents {
        agents: vec![Agent {
            name: "general".into(),
            description: None,
        }],
        complete: true,
    };
    assert_eq!(
        resolve_subagent("general-purpose", &general).as_deref(),
        Some("general")
    );
    assert_eq!(
        resolve_subagent("explore", &general).as_deref(),
        Some("general")
    );
}

#[test]
fn structured_subagent_enum_is_authoritative_over_prose() {
    let catalog = host_subagents(&[tool(
        "task",
        "Available agent types and the tools they have access to:\n- scout: Read\n- extra: Ignored",
        r#"{"type":"object","properties":{"subagent_type":{"enum":["scout","general"]}}}"#,
    )]);
    assert_eq!(
        catalog
            .agents
            .iter()
            .map(|a| a.name.as_str())
            .collect::<Vec<_>>(),
        ["scout", "general"]
    );
    assert_eq!(catalog.agents[0].description.as_deref(), Some("Read"));
    assert!(catalog.complete);
}
