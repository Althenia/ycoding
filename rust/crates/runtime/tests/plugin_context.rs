#![cfg(unix)]

#[path = "support/production_owner.rs"]
mod production_owner;

use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};
use ycoding_core::{
    resources::{catalog::models_dev, config},
    ycoding_store::{Metadata, Options, Store},
};
use ycoding_runtime::{Core, Production};

#[test]
fn retired_modules_do_not_participate_in_location_composition_or_reload() {
    production_owner::run(|host| Box::pin(native_context(host)));
}

async fn native_context(host: &production_owner::Host) {
    let root = std::env::temp_dir().join(format!(
        "runtime-plugin-context-{}-{}",
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
    let plugins = directory.join(".ycoding/plugins");
    fs::create_dir_all(&plugins).unwrap();
    let legacy = directory.join("probe.mjs");
    fs::write(&legacy, "throw new Error('legacy module imported')\n").unwrap();
    fs::write(plugins.join("probe.ts"), fs::read(&legacy).unwrap()).unwrap();
    let config_path = directory.join("ycoding.jsonc");
    fs::write(
        &config_path,
        r#"{"plugins":["./probe.mjs"],"agents":{"god":{"description":"initial"}}}"#,
    )
    .unwrap();
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
    let reference = directory.to_str().unwrap().into();
    let first = core.locations.location(&reference, None).unwrap();
    fs::write(
        &config_path,
        r#"{"plugins":["./probe.mjs"],"agents":{"god":{"description":"reloaded"}}}"#,
    )
    .unwrap();
    core.locations.reload(&first.info).unwrap();
    let current = core.locations.location(&reference, None).unwrap();
    for (services, description) in [(&first, "initial"), (&current, "reloaded")] {
        let composed = services.production.as_ref().unwrap();
        assert!(composed.extension_diagnostics.is_empty());
        assert!(composed.activation.declared_plugins().await.is_empty());
        assert!(composed.activation.extensions().await.is_empty());
        assert!(
            composed
                .plugins
                .iter()
                .any(|plugin| plugin.id.as_str() == Some("ycoding.agent"))
        );
        let agents = services.agents.snapshot();
        let agent = agents.get(&"god".into()).unwrap();
        assert_eq!(
            agent.description.as_ref().and_then(|value| value.as_str()),
            Some(description)
        );
    }
    assert!(!launched.exists());
    drop((first, current));
    core.shutdown().await.unwrap();
}
