include!("tool_fixture.rs");

use std::{process::Command, sync::Arc};
use ycoding_ai::llm::ToolResultValue;
use ycoding_core::{
    platform::{git, worktree},
    tools::{
        builtin::{
            filesystem::{Paths, same_directory},
            worktree::Worktree,
        },
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

#[test]
fn directory_identity_requires_both_canonicalizations_to_succeed() {
    let fixture = ToolFixture::new();
    let present = fixture.root.join("present");
    let alias = fixture.root.join("alias");
    let other = fixture.root.join("other");
    std::fs::create_dir_all(&present).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    std::os::unix::fs::symlink(&present, &alias).unwrap();
    let missing = fixture.root.join("missing");
    let also_missing = fixture.root.join("also-missing");
    assert!(same_directory(&present, &alias));
    assert!(!same_directory(&present, &other));
    assert!(!same_directory(&present, &missing));
    assert!(!same_directory(&missing, &present));
    assert!(!same_directory(&missing, &also_missing));
    assert!(!same_directory(&missing, &missing));
    fixture.cleanup();
}

fn managed_paths(fixture: &ToolFixture) -> Paths {
    let name = fixture.root.file_name().unwrap().to_string_lossy();
    Paths {
        directory: fixture.root.clone(),
        data: fixture.root.with_file_name(format!("{name}-data")),
        git: Arc::new(git::Service::new(1024 * 1024)),
    }
}

#[test]
fn a_listed_managed_checkout_is_internal_and_an_unlisted_sibling_is_external() {
    let fixture = ToolFixture::new();
    init_repository(&fixture.root);
    let paths = managed_paths(&fixture);
    let repository = paths.git.discover(&paths.directory).unwrap().unwrap();
    let checkout =
        worktree::create_managed(&paths.git, &repository, &paths.data, "feature-one").unwrap();
    let managed = paths.resolve(
        &checkout.worktree.join("new/file.txt").to_string_lossy(),
        false,
    );
    assert!(managed.unwrap().external.is_none());
    let sibling = worktree::managed_destination(&paths.data, &repository, "feature-two").unwrap();
    std::fs::create_dir_all(&sibling).unwrap();
    let unlisted = paths
        .resolve(&sibling.join("file.txt").to_string_lossy(), false)
        .unwrap();
    assert!(unlisted.external.is_some());
    std::fs::remove_dir_all(&paths.data).unwrap();
    fixture.cleanup();
}

async fn settle_pending(
    guardrails: &ycoding_core::process::guardrails::Guardrails,
    session: &ycoding_schema::session_id::SessionId,
    human: bool,
) {
    let request = loop {
        if let Some((_, request)) = guardrails.list_ordered().into_iter().next() {
            break request;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    };
    if human {
        guardrails
            .reply(
                session,
                &request.id,
                ycoding_schema::guardrail::Reply::Reject,
            )
            .unwrap();
        return;
    }
    let fingerprint = guardrails
        .request_snapshot(session, &request.id)
        .unwrap()
        .unwrap()
        .fingerprint;
    let settled = guardrails
        .reconsider(
            session,
            &request.id,
            ycoding_core::coordination::decisions::Reconsider {
                fingerprint,
                source: ycoding_core::coordination::decisions::Source {
                    coordinator_session_id: ycoding_schema::session_id::SessionId::new(
                        "ses_coordinator",
                    )
                    .unwrap(),
                    group_id: Some("cgrp_synthetic".into()),
                    rationale: "Synthetic coordinator reason".into(),
                },
                decision: Some(ycoding_core::coordination::runtime::Decision::Decline),
                answer: None,
                confidence: None,
                gate: ycoding_core::coordination::decisions::Gate {
                    validate: Arc::new(|_| Box::pin(async { true })),
                    current: Arc::new(|| true),
                },
            },
        )
        .await
        .unwrap();
    assert!(settled.settled);
}

#[tokio::test]
async fn worktree_creation_reports_coordinator_feedback_and_keeps_a_human_decline_generic() {
    for scenario in ["coordinator", "human"] {
        let fixture = ToolFixture::new().with_guardrail_rule(
            ycoding_schema::guardrail::RuleDecision::Ask,
            "file_mutation",
        );
        init_repository(&fixture.root);
        fixture.authority.session_with(
            "ses_tool",
            None,
            ["manual", "manual", "manual"],
            false,
            None,
        );
        let session = ycoding_schema::session_id::SessionId::new("ses_tool").unwrap();
        let guardrails = fixture.policy.guardrails.clone();
        let (registry, _registration) = register_worktree(&fixture);
        let create = async {
            registry
                .materialize(&[])
                .invoke(
                    "worktree",
                    parse_json(r#"{"action":"create","name":"feature-one"}"#).unwrap(),
                    fixture.context(),
                )
                .await
                .unwrap()
        };
        let output = tokio::join!(
            create,
            settle_pending(&guardrails, &session, scenario == "human")
        )
        .0;
        let ToolResultValue::Error(JsonValue::String(message)) = output.result else {
            panic!("a denied creation is a tool error")
        };
        let message = message.to_utf8().unwrap();
        if scenario == "coordinator" {
            assert!(message.contains("Project coordination, not a human decision"));
            assert!(message.contains("Synthetic coordinator reason"));
        } else {
            assert_eq!(message, "Session guardrail rejected worktree creation");
        }
        let branches = Command::new("git")
            .args(["branch", "--list", "feature-one"])
            .current_dir(&fixture.root)
            .output()
            .unwrap();
        assert!(
            branches.stdout.is_empty(),
            "{scenario}: no worktree branch was created"
        );
        fixture.cleanup();
    }
}
