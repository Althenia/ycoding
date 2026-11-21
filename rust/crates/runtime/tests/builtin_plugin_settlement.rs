#![cfg(unix)]

#[path = "support/production_owner.rs"]
mod production_owner;

use std::{
    fs,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use ycoding_core::{
    resources::{catalog::models_dev, config},
    ycoding_store::{Metadata, Options, Store},
};
use ycoding_runtime::{Core, Production};

#[test]
fn a_loaded_plugin_declaring_a_built_in_tool_id_re_enables_that_tool() {
    production_owner::run(|host| {
        Box::pin(async move {
            tokio::time::timeout(Duration::from_secs(120), declared_built_in_tool(host))
                .await
                .unwrap();
        })
    });
}

async fn declared_built_in_tool(host: &production_owner::Host) {
    let root = std::env::temp_dir().join(format!(
        "runtime-builtin-plugin-settlement-{}-{}",
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
    let bun = String::from_utf8(
        std::process::Command::new("sh")
            .args(["-c", "command -v bun"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_owned();
    assert!(!bun.is_empty(), "the plugin host integration requires bun");
    let frontend = root.join("frontend");
    fs::write(
        &frontend,
        format!(
            "#!/bin/sh\nexec '{bun}' '{}' \"$@\"\n",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../packages/cli/src/plugin-host/main.ts"
            )
        ),
    )
    .unwrap();
    fs::set_permissions(
        &frontend,
        <fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o755),
    )
    .unwrap();
    let cases = [
        (
            "re-enabled",
            r#"["-ycoding.tool.webfetch", "-ycoding.command", "./declares.mjs", "./commands.mjs"]"#,
            true,
        ),
        (
            "hidden",
            r#"["./declares.mjs", "./commands.mjs", "-ycoding.tool.webfetch", "-ycoding.command"]"#,
            false,
        ),
    ];
    for (name, plugins, _) in cases {
        let directory = root.join(name);
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("declares.mjs"),
            "export default { id: \"ycoding.tool.webfetch\", setup: async () => {} }\n",
        )
        .unwrap();
        fs::write(
            directory.join("commands.mjs"),
            "export default { id: \"ycoding.command\", setup: async () => {} }\n",
        )
        .unwrap();
        fs::write(
            directory.join("ycoding.jsonc"),
            format!("{{\"plugins\": {plugins}}}\n"),
        )
        .unwrap();
    }
    let store = host.retain(
        Store::initialize(
            root.join("core.redb"),
            Options::core(),
            ycoding_core::ycoding_store::native::catalog(
                ycoding_core::ycoding_store::native::DatabaseKind::Core,
            ),
            Metadata::new([32; 16], 1),
        )
        .unwrap(),
        Some(&root),
    );
    let core = Core::production(
        &host.owner,
        store.clone(),
        Production {
            analytics: roots.data.join("analytics"),
            configuration: config::LoadOptions {
                directory: root.clone(),
                roots: roots.clone(),
                project: true,
                file: None,
                content: None,
                env: [(
                    "YCODING_FRONTEND_EXECUTABLE".to_owned(),
                    frontend.to_str().unwrap().to_owned(),
                )]
                .into_iter()
                .collect(),
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
    for (name, _, active) in cases {
        let directory = root.join(name).to_str().unwrap().to_owned();
        let services = core
            .locations
            .location(&directory.as_str().into(), None)
            .unwrap();
        let composed = services.production.as_ref().unwrap();
        let tools = composed
            .tools
            .materialize(&services.agents.snapshot().default().unwrap().permissions)
            .definitions
            .iter()
            .filter_map(|tool| tool.name.as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        assert_eq!(
            tools.iter().any(|tool| tool == "webfetch"),
            active,
            "{name}: {tools:?}"
        );
        assert_eq!(
            composed
                .plugins
                .iter()
                .any(|plugin| plugin.id.as_str() == Some("ycoding.tool.webfetch")),
            active,
            "{name}"
        );
        assert_eq!(
            composed
                .commands
                .snapshot()
                .list()
                .iter()
                .any(|command| command.name.as_str() == Some("init")),
            active,
            "{name}: the bundled command follows the settled set"
        );
        assert!(
            !composed
                .configuration
                .diagnostics
                .iter()
                .chain(&composed.plugin_diagnostics)
                .any(
                    |diagnostic| diagnostic.json_path.as_ref().and_then(|path| path.as_str())
                        == Some("$.plugins")
                ),
            "{name}"
        );
    }
    core.shutdown().await.unwrap();
    drop(core);
    drop(store);
}
