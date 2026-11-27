use std::path::Path;
use ycoding_core::{
    coordination::{self, Role},
    instructions::Observation,
    resources::config::{Configuration, LoadOptions, Roots},
};

fn isolated_home(name: &str) -> Roots {
    let root = std::env::temp_dir().join(format!("ycoding-swarm-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    Roots::development(&root).unwrap()
}

fn assert_without_user_instructions(roots: &Roots) {
    for directory in [&roots.home, &roots.config] {
        assert!(
            !Path::new(directory).join("AGENTS.md").exists(),
            "{directory:?}"
        );
    }
    let configuration = Configuration::load(LoadOptions {
        directory: roots.home.clone(),
        roots: roots.clone(),
        project: false,
        file: None,
        content: Some("{}".into()),
        env: Default::default(),
    })
    .unwrap();
    assert!(configuration.diagnostics.is_empty());
}

async fn rendered(role: Role, coordinating: bool) -> String {
    let source = coordination::instructions::source(role, coordinating);
    let Observation::Value(value) = (source.read)().await.unwrap() else {
        panic!("coordination instruction source must yield a value")
    };
    (source.initial)(&value)
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned()
}

fn once(text: &str, clause: &str) {
    assert_eq!((clause, text.split(clause).count()), (clause, 2));
}

const SHARED: [&str; 5] = [
    "Serialize only real dependencies, overlapping writes and shared integration; run everything else concurrently.",
    "never launch filler",
    "Preserve the configured route, concurrency limits, Project boundaries, pauses and enforced controls.",
    "records a durable `coordination.subagent.request.blocked` event naming the parent Session, the requested agent and the reason, and creates no child",
    "treat that request as not running",
];

#[tokio::test]
async fn built_in_coordinator_instructions_carry_swarm_execution_without_user_instructions() {
    let roots = isolated_home("coordinator");
    assert_without_user_instructions(&roots);
    for role in [Role::Master, Role::Supervisor] {
        let text = rendered(role, false).await;
        for clause in SHARED {
            once(&text, clause);
        }
        once(
            &text,
            "Launch every ready, genuinely independent member lane at once.",
        );
        once(
            &text,
            "run your own independent integration and verification checks within your read-only authority instead of waiting on members",
        );
        assert!(!text.contains("Keep integration and verification yourself"));
    }
}

#[tokio::test]
async fn built_in_member_instructions_delegate_independent_subtasks_and_keep_integration() {
    let roots = isolated_home("member");
    assert_without_user_instructions(&roots);
    let text = rendered(Role::Executor, false).await;
    for clause in SHARED {
        once(&text, clause);
    }
    once(
        &text,
        "Delegate genuinely independent subtasks to native subagents and run them concurrently.",
    );
    once(
        &text,
        "Keep integration and verification yourself; never hand either to a subagent.",
    );
    assert!(!text.contains("Launch every ready, genuinely independent member lane"));
}

#[tokio::test]
async fn a_master_subagent_gets_no_delegation_rules() {
    let text = rendered(Role::Executor, true).await;
    assert!(text.starts_with("Project role: Master's subagent."));
    assert!(!text.contains("never launch filler"));
}
