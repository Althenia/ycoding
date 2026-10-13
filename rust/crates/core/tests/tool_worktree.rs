include!("tool_fixture.rs");

use std::{process::Command, sync::Arc};
use ycoding_ai::llm::ToolResultValue;
use ycoding_core::{
    platform::{git, worktree},
    tools::{
        builtin::{filesystem::Paths, worktree::Worktree},
        registry::{Options, Tool},
    },
};
use ycoding_schema::{JsonValue, parse_json};

fn register_worktree(
    fixture: &ToolFixture,
) -> (
    ycoding_core::tools::registry::Registry,
    ycoding_core::tools::registry::Registration,
) {
    let registry = fixture.registry();
    let registration = registry
        .register(
            vec![(
                "worktree".into(),
                Arc::new(Worktree {
                    paths: Arc::new(Paths {
                        directory: fixture.root.clone(),
                        data: fixture.root.join("data"),
                        git: Arc::new(git::Service::new(1024 * 1024)),
                    }),
                    policy: fixture.policy.clone(),
                }) as Arc<dyn Tool>,
            )],
            Options::direct(),
        )
        .unwrap();
    (registry, registration)
}

fn init_repository(root: &std::path::Path) {
    let init = Command::new("git")
        .args(["init", "-b", "main"])
        .current_dir(root)
        .status()
        .unwrap();
    assert!(init.success());
    let commit = Command::new("git")
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
        ])
        .current_dir(root)
        .status()
        .unwrap();
    assert!(commit.success());
}

#[tokio::test]
async fn lists_worktrees_with_current_branch_and_permissions() {
    let fixture = ToolFixture::new();
    init_repository(&fixture.root);
    let (registry, _registration) = register_worktree(&fixture);
    let output = registry
        .materialize(&[])
        .invoke(
            "worktree",
            parse_json(r#"{"action":"list"}"#).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert_eq!(
        output.result,
        ToolResultValue::Text(JsonValue::String(
            format!("Current: {} (main)", fixture.root.display()).into()
        ))
    );
    assert_eq!(
        output.output.unwrap().structured,
        parse_json(&format!(
            r#"{{"action":"list","worktrees":[{{"path":{},"branch":"main","current":true}}]}}"#,
            ycoding_schema::stringify_json(&JsonValue::String(
                fixture.root.to_string_lossy().as_ref().into()
            ))
        ))
        .unwrap()
    );
    fixture.deny("worktree", "*");
    let denied = registry
        .materialize(&[])
        .invoke(
            "worktree",
            parse_json(r#"{"action":"list"}"#).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert_eq!(
        denied.result,
        ToolResultValue::Error(JsonValue::String(
            "Unable to list worktrees: permission denied".into()
        ))
    );
    fixture.cleanup();
}

#[tokio::test]
async fn creates_a_named_managed_branch_and_rejects_duplicate_or_invalid_names() {
    let fixture = ToolFixture::new();
    init_repository(&fixture.root);
    let paths = Paths {
        directory: fixture.root.clone(),
        data: fixture.root.join("data"),
        git: Arc::new(git::Service::new(1024 * 1024)),
    };
    let repository = paths.git.discover(&paths.directory).unwrap().unwrap();
    let target = worktree::managed_destination(&paths.data, &repository, "feature-one").unwrap();
    let (registry, _registration) = register_worktree(&fixture);
    let output = registry
        .materialize(&[])
        .invoke(
            "worktree",
            parse_json(r#"{"action":"create","name":"feature-one"}"#).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert_eq!(
        output.result,
        ToolResultValue::Text(JsonValue::String(
            format!(
                "Created worktree on branch feature-one at {}",
                target.display()
            )
            .into()
        ))
    );
    assert!(target.is_dir());
    assert_eq!(
        registry
            .materialize(&[])
            .invoke(
                "worktree",
                parse_json(r#"{"action":"create","name":"feature-one"}"#).unwrap(),
                fixture.context(),
            )
            .await
            .unwrap()
            .result,
        ToolResultValue::Error(JsonValue::String(
            "A worktree named feature-one already exists".into()
        ))
    );
    assert!(matches!(
        registry
            .materialize(&[])
            .invoke(
                "worktree",
                parse_json(r#"{"action":"create","name":"Invalid"}"#).unwrap(),
                fixture.context(),
            )
            .await
            .unwrap()
            .result,
        ToolResultValue::Error(_)
    ));
    let existing_branch = Command::new("git")
        .args(["branch", "feature-two"])
        .current_dir(&fixture.root)
        .status()
        .unwrap();
    assert!(existing_branch.success());
    let branch_error = registry
        .materialize(&[])
        .invoke(
            "worktree",
            parse_json(r#"{"action":"create","name":"feature-two"}"#).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap()
        .result;
    let ToolResultValue::Error(JsonValue::String(branch_error)) = branch_error else {
        panic!("expected existing branch error")
    };
    assert!(branch_error.to_utf8().unwrap().contains("feature-two"));
    fixture.deny("worktree", "*");
    let denied_target =
        worktree::managed_destination(&paths.data, &repository, "denied-branch").unwrap();
    let denied = registry
        .materialize(&[])
        .invoke(
            "worktree",
            parse_json(r#"{"action":"create","name":"denied-branch"}"#).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    let denied_exists = denied_target.exists();
    if denied_exists {
        worktree::remove(&paths.git, &repository, &denied_target, true).unwrap();
    }
    std::fs::remove_dir_all(&target).unwrap();
    fixture.cleanup();
    assert!(matches!(denied.result, ToolResultValue::Error(_)));
    assert!(!denied_exists);
}
