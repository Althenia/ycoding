use std::path::Path;
use ycoding_core::{
    coordination::{self, Role},
    instructions::Observation,
    resources::{
        agent,
        config::{Configuration, LoadOptions, Roots},
    },
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

const RULE: &str = "Drive assigned work as a swarm by default: swarm execution is the primary operating mode for every Session, whether Project Master, Project member or standalone, and single-lane execution is the exception for indivisible or tightly coupled work.";
const LANES: [&str; 5] = [
    "Whoever coordinates the work splits it into genuinely independent lanes, launches every ready lane at once, and runs its own independent integration and verification within its authority while the lanes run.",
    "Each lane delegates its genuinely independent subtasks to native subagents where its tools grant them, and keeps ownership of its own integration and verification.",
    "Serialize only real dependencies, overlapping writes and shared integration.",
    "Allow one writer per file, ref or build output, launch a lane or subagent only for work with its own owner, exclusive paths and checks, and never launch filler.",
    "The configured route, concurrency limits, Project boundaries, pauses and enforced controls stay as they are.",
];
const SEPARATE: [&str; 6] = [
    "swarm",
    "Launch every ready",
    "never launch filler",
    "native subagents and run them concurrently",
    "Keep integration and verification yourself",
    "coordination.subagent.request.blocked",
];

fn system(roots: &Roots, id: &str) -> String {
    agent::builtin::catalog(roots, ycoding_schema::session_scope::Scope::Bound)
        .unwrap()
        .into_iter()
        .find(|agent| agent.id == id.into())
        .and_then(|agent| agent.system)
        .unwrap()
        .to_utf8()
        .unwrap()
}

#[tokio::test]
async fn normal_master_and_member_sessions_get_swarm_execution_only_from_the_base_prompt() {
    let roots = isolated_home("base");
    assert_without_user_instructions(&roots);
    for (name, id, role) in [
        ("normal", "god", None),
        ("master", "god", Some(Role::Master)),
        ("supervisor", "god", Some(Role::Supervisor)),
        ("member", "zeus", Some(Role::Executor)),
    ] {
        let mut text = system(&roots, id);
        if let Some(role) = role {
            let injected = rendered(role, false).await;
            for separate in SEPARATE {
                assert!(!injected.contains(separate), "{name}: {separate}");
            }
            text.push_str("\n\n");
            text.push_str(&injected);
        }
        once(&text, RULE);
        for clause in LANES {
            once(&text, clause);
        }
    }
}

#[tokio::test]
async fn a_master_subagent_gets_no_delegation_rules() {
    let text = rendered(Role::Executor, true).await;
    assert!(text.starts_with("Project role: Master's subagent."));
    for separate in SEPARATE {
        assert!(!text.contains(separate), "{separate}");
    }
}
