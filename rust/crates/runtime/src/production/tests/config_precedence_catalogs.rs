use super::{Fixture, fixture};
use std::{os::unix::fs::PermissionsExt, sync::Arc, time::Duration};
use ycoding_core::extension::v5::TransformStage;

const CONFIGURATION: &str = r#"{"commands":{"deploy":{"template":"configured template","description":"configured"}},"references":{"guide":{"path":"./configured-guide","description":"configured"}},"skills":["./configured-skills"]}"#;

const PLUGIN: &str = r#"let runs = 0
const here = (name) => new URL(`./${name}`, import.meta.url).pathname
export default {
  id: "fixture.catalog-precedence",
  setup: async (context) => {
    await context.command.transform((draft) => {
      runs += 1
      draft.update("deploy", (command) => {
        command.template = "plugin template"
        command.description = "plugin"
        command.agent = "god"
      })
      draft.update("plugin-only", (command) => {
        command.template = `run-${runs}`
      })
    })
    await context.reference.transform((draft) => {
      for (const name of ["guide", "plugin-guide"]) {
        const path = here(`plugin-${name}`)
        draft.add(name, { path, description: "plugin", source: { type: "local", path, description: "plugin" } })
      }
    })
    await context.skill.transform((draft) => {
      draft.source({ type: "directory", path: here("plugin-skills") })
    })
  },
}
"#;

#[derive(Debug, PartialEq)]
struct Observed {
    deploy: Option<(String, Option<String>, Option<String>)>,
    plugin_command: bool,
    references: Vec<(String, Option<String>)>,
    shared_skill: Option<String>,
    plugin_skill: bool,
}

fn expected() -> Observed {
    Observed {
        deploy: Some((
            "configured template".into(),
            Some("configured".into()),
            Some("god".into()),
        )),
        plugin_command: true,
        references: vec![
            ("plugin-guide".into(), Some("plugin".into())),
            ("guide".into(), Some("configured".into())),
        ],
        shared_skill: Some("configured".into()),
        plugin_skill: true,
    }
}

fn plugin_fixture() -> Fixture {
    let mut f = fixture(CONFIGURATION, r#"{"plugins":["./precedence.mjs"]}"#);
    let frontend = f.roots.data.join("plugin-frontend");
    std::fs::write(
        &frontend,
        format!(
            "#!/bin/sh\nexec bun '{}'\n",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../packages/cli/src/plugin-host/main.ts"
            )
        ),
    )
    .unwrap();
    std::fs::set_permissions(&frontend, std::fs::Permissions::from_mode(0o755)).unwrap();
    Arc::get_mut(&mut f.factory).unwrap().options.env.insert(
        crate::launch::FRONTEND_EXECUTABLE_KEY.into(),
        frontend.to_str().unwrap().into(),
    );
    let directory = f.directory();
    std::fs::write(directory.join("precedence.mjs"), PLUGIN).unwrap();
    for (root, skill, description) in [
        ("configured-skills", "shared", "configured"),
        ("plugin-skills", "shared", "plugin"),
        ("plugin-skills", "plugin-skill", "plugin"),
    ] {
        let skill_directory = directory.join(root).join(skill);
        std::fs::create_dir_all(&skill_directory).unwrap();
        std::fs::write(
            skill_directory.join("SKILL.md"),
            format!("---\nname: {skill}\ndescription: {description}\n---\nFixture skill body.\n"),
        )
        .unwrap();
    }
    for name in ["configured-guide", "plugin-guide", "plugin-plugin-guide"] {
        std::fs::create_dir_all(directory.join(name)).unwrap();
    }
    f
}

async fn observe(services: &crate::LocationServices) -> (Observed, Option<String>) {
    let composed = services.production.as_ref().unwrap();
    let commands = composed.commands.snapshot();
    let text = |value: &ycoding_core::ycoding_schema::LosslessString| {
        value.as_str().map(str::to_owned).unwrap_or_default()
    };
    let skills = composed
        .skills
        .lock()
        .await
        .list()
        .await
        .unwrap_or_default();
    let skill = |id: &str| {
        skills
            .iter()
            .find(|skill| skill.id.as_str() == Some(id))
            .map(|skill| skill.description.as_ref().map(text).unwrap_or_default())
    };
    let observed = Observed {
        deploy: commands.get(&"deploy".into()).map(|command| {
            (
                text(&command.template),
                command.description.as_ref().map(text),
                command
                    .agent
                    .as_ref()
                    .and_then(|agent| agent.as_str().map(str::to_owned)),
            )
        }),
        plugin_command: commands.get(&"plugin-only".into()).is_some(),
        references: composed
            .references
            .snapshot()
            .list()
            .iter()
            .map(|reference| {
                (
                    text(&reference.name),
                    reference.description.as_ref().map(text),
                )
            })
            .collect(),
        shared_skill: skill("shared"),
        plugin_skill: skill("plugin-skill").is_some(),
    };
    let marker = commands
        .get(&"plugin-only".into())
        .map(|command| text(&command.template));
    (observed, marker)
}

async fn composed_once() -> (Observed, Option<String>, String) {
    let f = plugin_fixture();
    let locations = f.locations();
    let services = f.services(&locations);
    let composed = services.production.as_ref().unwrap();
    let diagnostics = format!("{:?}", composed.extension_diagnostics);
    let (observed, marker) = observe(&services).await;
    composed.activation.close().await;
    locations.close().unwrap();
    (observed, marker, diagnostics)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn configured_command_wins_over_a_plugin_command_transform() {
    let (observed, marker, diagnostics) = composed_once().await;
    assert_eq!(diagnostics, "[]");
    assert_eq!(
        marker.as_deref(),
        Some("run-1"),
        "plugin transform must run"
    );
    assert_eq!(
        (observed.deploy, observed.plugin_command),
        (expected().deploy, expected().plugin_command)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn configured_reference_wins_over_a_plugin_reference_transform() {
    let (observed, _, diagnostics) = composed_once().await;
    assert_eq!(diagnostics, "[]");
    assert_eq!(observed.references, expected().references);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn configured_skill_source_wins_over_a_plugin_skill_source() {
    let (observed, _, diagnostics) = composed_once().await;
    assert_eq!(diagnostics, "[]");
    assert_eq!(
        (observed.shared_skill, observed.plugin_skill),
        (expected().shared_skill, expected().plugin_skill)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn catalog_configuration_precedence_survives_single_domain_reloads() {
    let f = plugin_fixture();
    let locations = f.locations();
    let services = f.services(&locations);
    let composed = services.production.as_ref().unwrap();
    let (_, initial) = observe(&services).await;
    let reloaded = tokio::time::timeout(Duration::from_secs(60), async {
        composed.reload.request(TransformStage::Commands).await?;
        composed.reload.request(TransformStage::References).await?;
        composed.reload.request(TransformStage::Skills).await
    })
    .await;
    let (observed, marker) = observe(&services).await;
    composed.activation.close().await;
    locations.close().unwrap();
    reloaded.unwrap().unwrap();
    assert_eq!(initial.as_deref(), Some("run-1"));
    assert_ne!(
        marker, initial,
        "command reload must rerun the plugin transform"
    );
    assert_eq!(observed, expected());
}
