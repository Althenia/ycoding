#![cfg(unix)]

#[path = "support/production_owner.rs"]
mod production_owner;

use std::{
    fs,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use ycoding_core::{
    resources::{
        catalog::models_dev,
        config,
        project_artifact::{source_registry::Registry, store},
    },
    ycoding_schema::{DomainDecode, JsonValue, ObjectEncoder, project, project_artifact},
    ycoding_store::{Metadata, Options, Store},
};
use ycoding_runtime::{Core, Production};

const INITIALIZE: &str =
    include_str!("../../../../packages/core/src/plugin/command/initialize.txt");

#[test]
fn settled_bundled_ids_are_the_standard_sources_for_artifact_collisions() {
    production_owner::run(|host| {
        Box::pin(async move {
            tokio::time::timeout(Duration::from_secs(120), collisions(host))
                .await
                .unwrap();
        })
    });
}

fn definition(kind: &str, name: &str, body: &str) -> project_artifact::Definition {
    project_artifact::Definition::decode(
        &ObjectEncoder::new()
            .field("kind", kind)
            .field("name", name)
            .field("description", "Reusable fixture")
            .field("subtask", &false)
            .field("mode", "subagent")
            .field("permissions", &JsonValue::Array(vec![]))
            .field(
                match kind {
                    "command" => "template",
                    "agent" => "system",
                    _ => "content",
                },
                body,
            )
            .finish(),
    )
    .unwrap()
}

async fn collisions(host: &production_owner::Host) {
    let root = std::env::temp_dir().join(format!(
        "runtime-builtin-standard-sources-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let root = fs::canonicalize(root).unwrap();
    let roots = config::Roots::development(&root).unwrap();
    roots.initialize().unwrap();
    let directory = root.join("project");
    fs::create_dir_all(&directory).unwrap();
    assert!(
        std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&directory)
            .status()
            .unwrap()
            .success()
    );
    fs::write(directory.join(".git/ycoding"), "prj_standard_sources").unwrap();
    let store = host.retain(
        Store::initialize(
            root.join("core.redb"),
            Options::core(),
            ycoding_core::ycoding_store::native::catalog(
                ycoding_core::ycoding_store::native::DatabaseKind::Core,
            ),
            Metadata::new([33; 16], 1),
        )
        .unwrap(),
        Some(&root),
    );
    let worktree = directory.to_str().unwrap().to_owned();
    store
        .submit(move |tx| {
            ycoding_core::ycoding_store::project::ProjectTable::insert(
                tx,
                &ycoding_core::ycoding_store::project::Project {
                    id: "prj_standard_sources".into(),
                    worktree: worktree.as_str().into(),
                    vcs: None,
                    name: None,
                    icon_url: None,
                    icon_url_override: None,
                    icon_color: None,
                    time_created: 1,
                    time_updated: 1,
                    time_initialized: None,
                    sandboxes: vec![],
                    commands: None,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let artifacts = store::Service::new(
        store.clone(),
        store::Paths {
            data: roots.data.clone(),
            home: roots.home.clone(),
            config: roots.config.clone(),
        },
        Arc::new(Mutex::new(Registry::default())),
    );
    let project_id = project::Id::new("prj_standard_sources").unwrap();
    artifacts
        .write_manual(store::ManualWriteInput {
            scope: project_artifact::ScopeSelector::Project,
            project_id: Some(project_id.clone()),
            id: "init",
            definition: &definition("command", "Init", "Artifact init template"),
            expected: None,
            now: 1000,
        })
        .unwrap();
    artifacts
        .write_manual(store::ManualWriteInput {
            scope: project_artifact::ScopeSelector::Project,
            project_id: Some(project_id),
            id: "report",
            definition: &definition("skill", "Report", "Artifact report guidance"),
            expected: None,
            now: 1000,
        })
        .unwrap();
    let core = Core::production(
        &host.owner,
        store.clone(),
        Production {
            analytics: roots.data.join("analytics"),
            configuration: config::LoadOptions {
                directory: directory.clone(),
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
    for (name, plugins, active) in [
        (
            "re-enabled",
            r#"["-ycoding.command", "-ycoding.skill", "ycoding.command", "ycoding.skill"]"#,
            true,
        ),
        (
            "hidden",
            r#"["ycoding.command", "ycoding.skill", "-ycoding.command", "-ycoding.skill"]"#,
            false,
        ),
    ] {
        fs::write(
            directory.join("ycoding.jsonc"),
            format!("{{\"plugins\": {plugins}}}\n"),
        )
        .unwrap();
        let services = core
            .locations
            .location(&directory.to_str().unwrap().into(), None)
            .unwrap();
        core.locations.reload(&services.info).unwrap();
        let services = core
            .locations
            .location(&directory.to_str().unwrap().into(), None)
            .unwrap();
        let composed = services.production.as_ref().unwrap();
        for id in ["ycoding.command", "ycoding.skill"] {
            assert_eq!(
                composed
                    .plugins
                    .iter()
                    .any(|plugin| plugin.id.as_str() == Some(id)),
                active,
                "{name}: {id} follows the settled set"
            );
        }
        let commands = composed.commands.snapshot();
        let init = commands.get(&"init".into()).unwrap();
        let skills = composed.skills.lock().await.list().await.unwrap();
        let report = skills
            .iter()
            .find(|skill| skill.id.as_str() == Some("report"))
            .unwrap();
        if active {
            assert_eq!(
                init.template.to_utf8().unwrap(),
                INITIALIZE.replacen("${path}", directory.to_str().unwrap(), 1),
                "{name}: the re-enabled bundled command is the standard source; the same-id artifact collides"
            );
            assert_eq!(
                report.location.as_lossless().as_str(),
                Some("/builtin/report.md"),
                "{name}: the re-enabled bundled skill is the standard source; the same-id artifact collides"
            );
            assert!(
                !report
                    .content
                    .to_utf8()
                    .unwrap()
                    .contains("Artifact report guidance"),
                "{name}"
            );
        } else {
            assert_eq!(
                init.template.to_utf8().unwrap(),
                "Artifact init template",
                "{name}: with the bundled command settled disabled, the same-id artifact is served"
            );
            assert!(
                report
                    .content
                    .to_utf8()
                    .unwrap()
                    .contains("Artifact report guidance"),
                "{name}: with the bundled skill settled disabled, the same-id artifact is served"
            );
        }
    }
    core.shutdown().await.unwrap();
    drop(core);
    drop(store);
}
