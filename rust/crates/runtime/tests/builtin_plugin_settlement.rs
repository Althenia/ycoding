#![cfg(unix)]

#[path = "support/production_owner.rs"]
mod production_owner;

use std::{
    fs,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use ycoding_core::{
    resources::{catalog::models_dev, config},
    ycoding_schema::DomainDecode,
    ycoding_store::{Metadata, Options, Store},
};
use ycoding_runtime::{Core, Production};

#[test]
fn native_tool_command_and_prompt_hook_follow_ordered_builtin_selectors() {
    production_owner::run(|host| {
        Box::pin(async move {
            tokio::time::timeout(Duration::from_secs(120), settle_builtins(host))
                .await
                .unwrap();
        })
    });
}

async fn settle_builtins(host: &production_owner::Host) {
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
    let frontend = root.join("frontend");
    let launched = root.join("frontend-launched");
    fs::write(
        &frontend,
        format!(
            "#!/bin/sh\nprintf started > '{}'\nexit 1\n",
            launched.display()
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
            r#"["-ycoding.tool.webfetch", "-ycoding.command", "-ycoding.system-prompt.anthropic", "ycoding.tool.webfetch", "ycoding.command", "ycoding.system-prompt.*"]"#,
            true,
        ),
        (
            "hidden",
            r#"["ycoding.tool.webfetch", "ycoding.command", "./declares.mjs", "-ycoding.tool.webfetch", "-ycoding.command", "-ycoding.system-prompt.anthropic"]"#,
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
            directory.join("ycoding.jsonc"),
            format!(r#"{{"plugins": {plugins}, "providers": {{"anthropic": {{"models": {{"claude-sonnet-4": {{}}}}}}}}}}"#),
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
        let selection = ycoding_core::ycoding_schema::model::Ref::decode(
            &ycoding_core::ycoding_schema::parse_json(
                r#"{"providerID":"anthropic","id":"claude-sonnet-4"}"#,
            )
            .unwrap(),
        )
        .unwrap();
        let prompt = ycoding_core::session::generate::system(
            &ycoding_core::resources::agent::empty("build".into()),
            &composed.models.catalog(),
            &selection,
            &[],
            "".into(),
        );
        let expected = if active {
            include_str!("../../core/src/session/system_prompt/anthropic.txt")
        } else {
            include_str!("../../../../packages/core/src/session/runner/prompt/base.txt")
        };
        assert_eq!(
            prompt
                .iter()
                .map(|part| part.text.as_str().unwrap())
                .collect::<Vec<_>>(),
            [expected]
        );
        assert!(composed.extension_diagnostics.is_empty());
        assert!(composed.activation.extensions().await.is_empty());
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
    assert!(
        !launched.exists(),
        "the frontend executable is only an asset path"
    );
    core.shutdown().await.unwrap();
    drop(core);
    drop(store);
}
