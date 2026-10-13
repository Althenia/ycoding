use std::path::Path;
use ycoding_core::resources::{agent, command, config::Entry, project_artifact::adapter, skill};
use ycoding_schema::{DomainDecode, JsonValue, parse_json, project_artifact};

fn definition(input: &str) -> project_artifact::Definition {
    project_artifact::Definition::decode(&parse_json(input).unwrap()).unwrap()
}

#[test]
fn fixed_registry_rejects_plugin_activation() {
    assert_eq!(
        adapter::list().map(|a| a.kind.as_lossless().to_utf8().unwrap()),
        ["skill", "command", "agent", "plugin"]
    );
    assert_eq!(
        adapter::get(&project_artifact::Kind::decode(&JsonValue::String("plugin".into())).unwrap())
            .phase,
        "unsupported"
    );
    let value = adapter::VersionIndex {
        scope_id: project_artifact::ScopeId::decode(&JsonValue::String("pas_test".into())).unwrap(),
        version_id: project_artifact::VersionId::decode(&JsonValue::String("pav_test".into()))
            .unwrap(),
        id: project_artifact::Id::decode(&JsonValue::String("draft".into())).unwrap(),
        content_path: "/scope/disabled/plugins/draft/draft.ts".into(),
        definition: definition(
            r#"{"kind":"plugin","name":"Draft","description":"Draft plugin","draft":"export default {}"}"#,
        ),
    };
    assert!(adapter::activate(&value, adapter::RuntimeDraft::default()).is_err());
}

#[test]
fn round_trips_every_declarative_definition_with_exact_body_whitespace_and_permissions() {
    for input in [
        r#"{"kind":"skill","name":"Core review","description":"Review Core changes","content":"  Run focused Core checks.\n\n"}"#,
        r#"{"kind":"command","name":"Command display name","description":"Command description differs","template":"  Review the current change.\n\n","subtask":false}"#,
        r#"{"kind":"agent","name":"Builder","description":"Runs focused verification","system":"  Run the requested task.\n\n","mode":"subagent","permissions":[{"action":"shell","resource":"bun test*","effect":"allow"},{"action":"shell","resource":"*","effect":"ask"}]}"#,
        r#"{"kind":"agent","name":"Reviewer","description":"Reviews changes","system":"Review without modifying files.","mode":"subagent","permissions":[]}"#,
    ] {
        let value = definition(input);
        let rendered = adapter::render(&value).to_utf8().unwrap();
        assert_eq!(
            adapter::parse(&adapter::kind(&value), &rendered).unwrap(),
            value
        );
        assert!(!rendered.lines().any(|line| line.starts_with("model:")
            || line.starts_with("request:")
            || line.starts_with("agent:")));
    }
}

#[test]
fn renders_literal_standard_bytes_and_paths() {
    let value = definition(
        r#"{"kind":"skill","name":"Core review","description":"Review Core changes","content":"Run focused Core checks."}"#,
    );
    assert_eq!(adapter::render(&value), "---\nname: \"Core review\"\ndescription: \"Review Core changes\"\n---\nRun focused Core checks.".into());
    let kind = adapter::kind(&value);
    assert_eq!(
        adapter::project_path(&kind, Path::new("/scope"), "core-review"),
        Path::new("/scope/active/skills/core-review/SKILL.md")
    );
    assert_eq!(
        adapter::global_path(
            &kind,
            Path::new("/home"),
            Path::new("/config"),
            "core-review"
        ),
        Path::new("/home/.agents/skills/core-review/SKILL.md")
    );
    for (kind, project, global) in [
        (
            "command",
            "/scope/active/commands/review.md",
            "/config/commands/review.md",
        ),
        (
            "agent",
            "/scope/active/agents/review.md",
            "/config/agents/review.md",
        ),
        (
            "plugin",
            "/scope/disabled/plugins/review/review.ts",
            "/config/plugins/review.ts",
        ),
    ] {
        let kind = project_artifact::Kind::decode(&JsonValue::String(kind.into())).unwrap();
        assert_eq!(
            adapter::project_path(&kind, Path::new("/scope"), "review"),
            Path::new(project)
        );
        assert_eq!(
            adapter::global_path(&kind, Path::new("/home"), Path::new("/config"), "review"),
            Path::new(global)
        );
    }
}

#[test]
fn diagnoses_collisions_and_only_permits_exact_single_global_shadow() {
    let project = adapter::Existing {
        scope: "project",
        scope_id: None,
        version_id: "explicit",
    };
    let global = adapter::Existing {
        scope: "global",
        scope_id: Some("pas_global"),
        version_id: "pav_global",
    };
    assert!(adapter::collision(&[], None).is_none());
    assert_eq!(
        adapter::collision(&[project], None)
            .unwrap()
            .diagnostic_type,
        "existing-source"
    );
    assert_eq!(
        adapter::collision(
            std::slice::from_ref(&global),
            Some(("pas_global", "pav_global"))
        )
        .unwrap(),
        adapter::Collision {
            diagnostic_type: "project-over-global-shadow",
            allowed: true
        }
    );
    assert!(
        !adapter::collision(
            &[global.clone(), global.clone()],
            Some(("pas_global", "pav_global"))
        )
        .unwrap()
        .allowed
    );
    assert_eq!(
        adapter::collision(&[global], Some(("pas_global", "pav_stale")))
            .unwrap()
            .diagnostic_type,
        "cross-scope"
    );
}

#[tokio::test]
async fn activates_real_skill_command_and_agent_resources_and_clears_authority() {
    let root =
        std::env::temp_dir().join(format!("ycoding-artifact-adapter-{}", std::process::id()));
    let mut skills = skill::Service::new(&root.join("cache"));
    let mut commands = command::Service::default();
    let mut agents = agent::Service::new(Vec::new());
    commands.update("review".into(), |c| {
        c.agent = Some("old".into());
        c.model = Some(
            ycoding_schema::model::Ref::decode(
                &parse_json(r#"{"providerID":"test","id":"old"}"#).unwrap(),
            )
            .unwrap(),
        );
    });
    agents.update("reviewer".into(), |a| {
        a.hidden = true;
        a.model = Some(
            ycoding_schema::model::Ref::decode(
                &parse_json(r#"{"providerID":"test","id":"old"}"#).unwrap(),
            )
            .unwrap(),
        );
        a.request
            .headers
            .insert("old".into(), JsonValue::String("value".into()));
    });
    for (id, input) in [
        (
            "core-review",
            r#"{"kind":"skill","name":"Core review skill","description":"Discovers a rendered skill","content":"Run focused Core checks."}"#,
        ),
        (
            "review",
            r#"{"kind":"command","name":"Command display name","description":"Discovers a rendered command","template":"Review the current change.","subtask":false}"#,
        ),
        (
            "reviewer",
            r#"{"kind":"agent","name":"Agent display name","description":"Discovers a rendered agent","system":"Review without modifying files.","mode":"subagent","permissions":[]}"#,
        ),
    ] {
        let definition = definition(input);
        let path = adapter::project_path(&adapter::kind(&definition), &root, id);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, adapter::render(&definition).to_utf8().unwrap()).unwrap();
        adapter::activate(
            &adapter::VersionIndex {
                scope_id: project_artifact::ScopeId::decode(&JsonValue::String("pas_test".into()))
                    .unwrap(),
                version_id: project_artifact::VersionId::decode(&JsonValue::String(
                    "pav_test".into(),
                ))
                .unwrap(),
                id: project_artifact::Id::decode(&JsonValue::String(id.into())).unwrap(),
                content_path: path,
                definition,
            },
            adapter::RuntimeDraft {
                skill: Some(&mut skills),
                command: Some(&mut commands),
                agent: Some(&mut agents),
            },
        )
        .unwrap();
    }
    let skill = skills
        .list()
        .await
        .unwrap()
        .into_iter()
        .find(|s| s.id == "core-review".into())
        .unwrap();
    assert_eq!(skill.name, "Core review skill".into());
    assert_eq!(skill.content, "Run focused Core checks.".into());
    let command = commands.get(&"review".into()).unwrap();
    assert_eq!(command.template, "Review the current change.".into());
    assert_eq!(command.subtask, Some(false));
    assert!(command.agent.is_none() && command.model.is_none());
    let agent = agents.get(&"reviewer".into()).unwrap();
    assert_eq!(agent.name, "Agent display name".into());
    assert_eq!(agent.mode, "subagent".into());
    assert!(!agent.hidden && agent.model.is_none());
    assert_eq!(agent.permissions, ycoding_schema::permission::Ruleset::decode(&parse_json(r#"[{"action":"*","resource":"*","effect":"deny"},{"action":"read","resource":"*","effect":"allow"},{"action":"glob","resource":"*","effect":"allow"},{"action":"grep","resource":"*","effect":"allow"},{"action":"webfetch","resource":"*","effect":"allow"},{"action":"websearch","resource":"*","effect":"allow"},{"action":"edit","resource":"*","effect":"ask"},{"action":"write","resource":"*","effect":"ask"},{"action":"patch","resource":"*","effect":"ask"},{"action":"shell","resource":"*","effect":"ask"},{"action":"question","resource":"*","effect":"allow"},{"action":"subagent","resource":"*","effect":"deny"}]"#).unwrap()).unwrap());
    assert!(agent.request.settings.0.is_empty());
    assert!(agent.request.headers.is_empty());
    let entries = [Entry::Directory(root.join("active"))];
    let discovered_commands = command::Service::from_entries(&entries, &mut Vec::new()).unwrap();
    assert_eq!(
        discovered_commands
            .get(&"review".into())
            .unwrap()
            .description,
        Some("Discovers a rendered command".into())
    );
    assert_eq!(
        discovered_commands.get(&"review".into()).unwrap().subtask,
        Some(false)
    );
    let discovered_agents =
        agent::Service::from_entries(&entries, Path::new("/home"), Vec::new(), &mut Vec::new())
            .unwrap();
    assert_eq!(
        discovered_agents.get(&"reviewer".into()).unwrap().system,
        Some("Review without modifying files.".into())
    );
    assert_eq!(
        discovered_agents.get(&"reviewer".into()).unwrap().mode,
        "subagent".into()
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn requires_authoritative_names_and_decodes_plugins_without_activating_them() {
    for kind in ["skill", "command", "agent"] {
        let kind = project_artifact::Kind::decode(&JsonValue::String(kind.into())).unwrap();
        assert!(adapter::parse(&kind, "---\ndescription: Desc\n---\nBody").is_err());
    }
    let kind = project_artifact::Kind::decode(&JsonValue::String("plugin".into())).unwrap();
    assert_eq!(
        adapter::render(&adapter::parse(&kind, "export default {}").unwrap()),
        "export default {}".into()
    );
}
