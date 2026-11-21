#[path = "support/production_owner.rs"]
mod production_owner;

use std::{collections::BTreeMap, process::Command};
use ycoding_core::{
    resources::{catalog::models_dev, config},
    ycoding_store::{Metadata, Options, Store},
};
use ycoding_runtime::{Core, Production};

fn run_in_fresh_process(test: &str) -> bool {
    const CHILD: &str = "YCODING_GOAL_DECISIONS_BINDING_CHILD";
    if std::env::var_os(CHILD).as_deref() == Some(std::ffi::OsStr::new(test)) {
        return false;
    }
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture"])
        .env(CHILD, test)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains("test result: ok. 1 passed"),
        "isolated {test} ended with {}\n{stdout}\n{}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    true
}

struct Fixture {
    core: Core,
    _store: ycoding_core::ycoding_store::Client,
}

impl Fixture {
    async fn open(host: &production_owner::Host) -> Self {
        let root = std::env::temp_dir().join(format!(
            "goal-decisions-binding-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let roots = config::Roots::development(&root).unwrap();
        roots.initialize().unwrap();
        let directory = root.join("project");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(roots.config.join("ycoding.json"), "{}").unwrap();
        let catalog = roots.cache.join("models.json");
        std::fs::write(&catalog, "{}").unwrap();
        let store = host.retain(
            Store::initialize(
                root.join("store.redb"),
                Options::core(),
                ycoding_core::ycoding_store::native::catalog(
                    ycoding_core::ycoding_store::native::DatabaseKind::Core,
                ),
                Metadata::new([6; 16], 1),
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
                    directory,
                    roots: roots.clone(),
                    project: true,
                    file: None,
                    content: None,
                    env: BTreeMap::new(),
                },
                catalog: models_dev::Options {
                    source: "https://models.dev/api.json".into(),
                    cache: roots.cache.join("catalog.json"),
                    file: Some(catalog),
                    bundled: None,
                    fetch: false,
                    user_agent: "ycoding/test".into(),
                },
                cursor: None,
                steer: None,
                ripgrep: "rg".into(),
                meeting: false,
            },
        )
        .await
        .unwrap();
        Self {
            core,
            _store: store,
        }
    }

    async fn finish(self) {
        self.core.shutdown().await.unwrap();
    }
}

#[test]
fn production_binds_the_session_status_feed_once_during_bootstrap() {
    if run_in_fresh_process("production_binds_the_session_status_feed_once_during_bootstrap") {
        return;
    }
    production_owner::run(|host| {
        Box::pin(async move {
            let fixture = Fixture::open(host).await;
            let rebound = fixture
                .core
                .execution
                .bind_status(fixture.core.events.clone());
            assert_eq!(
                rebound,
                Err("Session status feed is already bound".to_owned()),
                "bootstrap must bind the status feed before any Session runs"
            );
            fixture.finish().await;
        })
    });
}

#[test]
fn production_goal_decisions_start_and_stop_with_the_core() {
    if run_in_fresh_process("production_goal_decisions_start_and_stop_with_the_core") {
        return;
    }
    production_owner::run(|host| {
        Box::pin(async move {
            let fixture = Fixture::open(host).await;
            let events = fixture.core.events.clone();
            let subscribers = events.subscribers();
            assert!(
                subscribers >= 2,
                "the Project worker and the Goal decisions must both subscribe: {subscribers}"
            );
            fixture.finish().await;
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
            while events.subscribers() >= subscribers {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "Core shutdown must release the Goal decision subscription"
                );
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
    });
}
