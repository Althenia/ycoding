include!("tool_fixture.rs");

use ycoding_core::{
    session::{
        autonomy::{self, FailureCause, GoalStatus},
        store,
    },
    tools::{
        builtin::goal::Goal,
        context::Context,
        registry::{Failure, Tool},
    },
};
use ycoding_schema::{parse_json, session};

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}
fn tool(f: &ToolFixture) -> Goal {
    Goal {
        autonomy: autonomy::Service::new(f.authority.store.client()),
        sessions: store::Service::new(f.authority.store.client()),
        policy: f.policy.clone(),
    }
}
async fn call(
    tool: &Goal,
    session: &str,
    input: serde_json::Value,
) -> Result<ycoding_ai::llm::ToolOutput, Failure> {
    tool.settle(
        parse_json(&input.to_string()).unwrap(),
        Context::new(session, "test", "msg_tool", "call_tool").unwrap(),
    )
    .await
}
fn error(result: Result<ycoding_ai::llm::ToolOutput, Failure>) -> String {
    format!("{:?}", result.unwrap_err())
}
fn record(
    f: &ToolFixture,
    session: &str,
    sequence: i64,
    name: &str,
    input: serde_json::Value,
    structured: serde_json::Value,
    failure: Option<&str>,
) {
    let state = match failure {
        Some(message) => {
            serde_json::json!({"status":"error","input":input,"structured":structured,"content":[],"error":{"type":"tool.execution","message":message}})
        }
        None => {
            serde_json::json!({"status":"completed","input":input,"structured":structured,"content":[]})
        }
    };
    let data = serde_json::json!({"agent":"test","model":{"providerID":"fake","id":"fake"},"time":{"created":sequence,"completed":sequence},"content":[{"type":"tool","id":format!("call_{sequence}"),"name":name,"time":{"created":sequence,"completed":sequence},"state":state}]});
    let row = ycoding_store::session::Message {
        id: format!("msg_{session}_{sequence}").into(),
        session_id: session.into(),
        type_: "assistant".into(),
        seq: sequence,
        time_created: sequence,
        time_updated: sequence,
        data: parse_json(&data.to_string()).unwrap(),
    };
    f.authority
        .store
        .submit(move |tx| ycoding_store::session::MessageTable::insert(tx, &row))
        .unwrap()
        .wait()
        .unwrap();
}

#[tokio::test]
async fn child_rework_requires_evidence_updates_owner_and_preserves_retry_budget() {
    let f = ToolFixture::new();
    let tool = tool(&f);
    tool.autonomy
        .set_goal(
            &id("ses_tool"),
            autonomy::Goal::new("Finish every lane", None, None),
        )
        .await
        .unwrap();
    f.authority
        .session("ses_child", Some("ses_tool"), 0, false, None);
    assert!(
        error(
            call(
                &tool,
                "ses_child",
                serde_json::json!({"action":"rework","unit":"parser","state":"opened"})
            )
            .await
        )
        .contains("requires unit, state")
    );
    assert!(error(call(&tool, "ses_child", serde_json::json!({"action":"rework","unit":"parser","state":"resolved","evidence":"parser check passed"})).await).contains("No open rework"));
    for _ in 0..20 {
        call(&tool, "ses_child", serde_json::json!({"action":"rework","unit":"parser","state":"opened","reason":"parser check failed"})).await.unwrap();
    }
    let goal = tool.autonomy.get(&id("ses_tool")).unwrap().goal.unwrap();
    assert_eq!(
        (goal.rework, goal.no_progress, goal.phase()),
        (Some(20), 0, autonomy::GoalPhase::Rework)
    );
    assert_eq!(goal.rework_open.as_ref().unwrap().len(), 1);
    assert!(
        error(
            call(
                &tool,
                "ses_tool",
                serde_json::json!({"action":"rework","unit":"parser","state":"resolved"})
            )
            .await
        )
        .contains("requires evidence")
    );
    call(&tool, "ses_tool", serde_json::json!({"action":"rework","unit":"parser","state":"resolved","evidence":"cargo test parser passed"})).await.unwrap();
    let goal = tool.autonomy.get(&id("ses_tool")).unwrap().goal.unwrap();
    assert!(goal.rework_open.is_none() && goal.phase.is_none());
    call(&tool, "ses_tool", serde_json::json!({"action":"complete"}))
        .await
        .unwrap();
    assert_eq!(
        tool.autonomy
            .get(&id("ses_tool"))
            .unwrap()
            .goal
            .unwrap()
            .status,
        GoalStatus::Completed
    );
    f.cleanup();
}

#[tokio::test]
async fn unresolved_owner_failure_blocks_both_completion_actions_until_matching_success() {
    let f = ToolFixture::new();
    let tool = tool(&f);
    tool.autonomy
        .set_goal(&id("ses_tool"), autonomy::Goal::new("Ship it", None, None))
        .await
        .unwrap();
    tool.autonomy
        .record_stall(
            &id("ses_tool"),
            Some(FailureCause {
                fingerprint: "tool.stalled:tool/shell".into(),
                class: "tool.stalled".into(),
                unit: "tool/shell".into(),
            }),
        )
        .await
        .unwrap();
    for input in [
        serde_json::json!({"action":"complete"}),
        serde_json::json!({"action":"update","status":"completed"}),
    ] {
        assert!(error(call(&tool, "ses_tool", input).await).contains("tool.stalled:tool/shell"));
    }
    tool.autonomy
        .resolve_failure(&id("ses_tool"), Some("read"))
        .await
        .unwrap();
    assert!(
        call(&tool, "ses_tool", serde_json::json!({"action":"complete"}))
            .await
            .is_err()
    );
    tool.autonomy
        .resolve_failure(&id("ses_tool"), None)
        .await
        .unwrap();
    assert!(
        tool.autonomy
            .get(&id("ses_tool"))
            .unwrap()
            .goal
            .unwrap()
            .failure
            .is_some()
    );
    tool.autonomy
        .resolve_failure(&id("ses_tool"), Some("shell"))
        .await
        .unwrap();
    call(&tool, "ses_tool", serde_json::json!({"action":"complete"}))
        .await
        .unwrap();
    f.cleanup();
}

#[test]
fn objective_check_extraction_ignores_filenames_and_normalizes_commands() {
    use autonomy::verification::required_checks;
    assert_eq!(
        required_checks("Fix it and run ./verify.sh."),
        ["./verify.sh"]
    );
    assert_eq!(
        required_checks(
            "Pass `bun test   parser.test.ts` and `../scripts/check.sh`, then ./verify.sh."
        ),
        [
            "bun test parser.test.ts",
            "../scripts/check.sh",
            "./verify.sh"
        ]
    );
    assert!(
        required_checks("Update `f.txt`, edit ./src/parser.ts and keep verify.sh green.")
            .is_empty()
    );
    assert!(required_checks("Ignore x./verify.sh and ./verify.sh.txt").is_empty());
    assert_eq!(
        required_checks("Ignore `broken\nthen `cargo test parser`"),
        ["cargo test parser"]
    );
}

#[tokio::test]
async fn named_checks_gate_unrun_stale_failed_and_timeout_runs_across_descendants() {
    let f = ToolFixture::new();
    let tool = tool(&f);
    tool.autonomy
        .set_goal(
            &id("ses_tool"),
            autonomy::Goal::new(
                "Verify the parser",
                Some("Run ./verify.sh and `cargo test parser`"),
                None,
            ),
        )
        .await
        .unwrap();
    f.authority
        .session("ses_child", Some("ses_tool"), 0, false, None);
    record(
        &f,
        "ses_tool",
        1,
        "shell",
        serde_json::json!({"command":"./verify.sh"}),
        serde_json::json!({"exit":0}),
        None,
    );
    record(
        &f,
        "ses_child",
        2,
        "execute",
        serde_json::json!({}),
        serde_json::json!({"toolCalls":[{"id":"nested","index":0,"name":"patch","tool":"tools.patch","status":"completed","input":{}}]}),
        None,
    );
    let rejection = error(call(&tool, "ses_tool", serde_json::json!({"action":"complete"})).await);
    assert!(rejection.contains("./verify.sh is stale since the latest edit"));
    assert!(rejection.contains("cargo test parser is unrun"));
    record(
        &f,
        "ses_tool",
        3,
        "shell",
        serde_json::json!({"command":"./verify.sh("}),
        serde_json::json!({"exit":0}),
        None,
    );
    assert!(
        error(call(&tool, "ses_tool", serde_json::json!({"action":"complete"})).await)
            .contains("./verify.sh is stale since the latest edit")
    );
    record(
        &f,
        "ses_tool",
        4,
        "shell",
        serde_json::json!({"command":"bash ./verify.sh"}),
        serde_json::json!({"exit":0}),
        None,
    );
    record(
        &f,
        "ses_child",
        4,
        "shell",
        serde_json::json!({"command":"cargo test parser"}),
        serde_json::json!({"exit":1}),
        None,
    );
    assert!(
        error(
            call(
                &tool,
                "ses_tool",
                serde_json::json!({"action":"update","status":"completed"})
            )
            .await
        )
        .contains("cargo test parser is failing")
    );
    record(
        &f,
        "ses_child",
        5,
        "shell",
        serde_json::json!({"command":"cargo test parser"}),
        serde_json::json!({"exit":0,"timeout":true}),
        None,
    );
    assert!(
        call(&tool, "ses_tool", serde_json::json!({"action":"complete"}))
            .await
            .is_err()
    );
    record(
        &f,
        "ses_child",
        6,
        "shell",
        serde_json::json!({"command":"cd parser && cargo test parser"}),
        serde_json::json!({"exit":0}),
        None,
    );
    call(&tool, "ses_tool", serde_json::json!({"action":"complete"}))
        .await
        .unwrap();
    assert_eq!(
        tool.autonomy
            .get(&id("ses_tool"))
            .unwrap()
            .goal
            .unwrap()
            .no_progress,
        0
    );
    f.cleanup();
}

#[tokio::test]
async fn identical_rejections_exhaust_only_without_new_owner_or_descendant_work() {
    let f = ToolFixture::new();
    let tool = tool(&f);
    tool.autonomy
        .set_goal(
            &id("ses_tool"),
            autonomy::Goal::new("Pass ./verify.sh", None, None),
        )
        .await
        .unwrap();
    f.authority
        .session("ses_child", Some("ses_tool"), 0, false, None);
    record(
        &f,
        "ses_tool",
        1,
        "edit",
        serde_json::json!({}),
        serde_json::json!({}),
        None,
    );
    let input = serde_json::json!({"action":"complete"});
    let first = call(&tool, "ses_tool", input.clone()).await.unwrap_err();
    let Failure::Tool { message, .. } = first else {
        panic!("tool failure")
    };
    record(
        &f,
        "ses_tool",
        2,
        "goal",
        input.clone(),
        serde_json::json!({}),
        Some(&message),
    );
    record(
        &f,
        "ses_tool",
        3,
        "shell",
        serde_json::json!({"command":"ls src"}),
        serde_json::json!({"exit":0}),
        None,
    );
    let Failure::Tool { message, .. } = call(&tool, "ses_tool", input.clone()).await.unwrap_err()
    else {
        panic!("tool failure")
    };
    assert!(!message.contains("charged"));
    record(
        &f,
        "ses_tool",
        4,
        "goal",
        input.clone(),
        serde_json::json!({}),
        Some(&message),
    );
    record(
        &f,
        "ses_child",
        5,
        "read",
        serde_json::json!({}),
        serde_json::json!({}),
        None,
    );
    let Failure::Tool { message, .. } = call(&tool, "ses_tool", input.clone()).await.unwrap_err()
    else {
        panic!("tool failure")
    };
    assert!(!message.contains("charged"));
    record(
        &f,
        "ses_tool",
        6,
        "goal",
        input,
        serde_json::json!({}),
        Some(&message),
    );
    for (sequence, action, count) in [
        (7, serde_json::json!({"action":"complete"}), 1),
        (
            8,
            serde_json::json!({"action":"update","status":"completed"}),
            2,
        ),
        (9, serde_json::json!({"action":"complete"}), 3),
    ] {
        let Failure::Tool { message, .. } =
            call(&tool, "ses_tool", action.clone()).await.unwrap_err()
        else {
            panic!("tool failure")
        };
        assert!(
            message.contains(&format!("no-progress attempt {count}/3 charged")),
            "{message}"
        );
        record(
            &f,
            "ses_tool",
            sequence,
            "goal",
            action,
            serde_json::json!({}),
            Some(&message),
        );
    }
    let goal = tool.autonomy.get(&id("ses_tool")).unwrap().goal.unwrap();
    assert_eq!((goal.status, goal.no_progress), (GoalStatus::Exhausted, 3));
    assert!(
        error(call(&tool, "ses_tool", serde_json::json!({"action":"complete"})).await)
            .contains("No active goal")
    );
    f.cleanup();
}

#[tokio::test]
async fn edits_without_a_named_check_and_goals_without_edits_can_complete() {
    for (objective, edit) in [("Keep verify.sh green", true), ("Pass ./verify.sh", false)] {
        let f = ToolFixture::new();
        let tool = tool(&f);
        tool.autonomy
            .set_goal(&id("ses_tool"), autonomy::Goal::new(objective, None, None))
            .await
            .unwrap();
        if edit {
            record(
                &f,
                "ses_tool",
                1,
                "edit",
                serde_json::json!({}),
                serde_json::json!({}),
                None,
            );
        }
        call(&tool, "ses_tool", serde_json::json!({"action":"complete"}))
            .await
            .unwrap();
        f.cleanup();
    }
}

#[tokio::test]
async fn reviews_pause_reports_and_identical_rejection_charges() {
    let f = ToolFixture::new();
    let tool = tool(&f);
    tool.autonomy
        .set_goal(
            &id("ses_tool"),
            autonomy::Goal::new("Pass ./verify.sh", None, None),
        )
        .await
        .unwrap();
    record(
        &f,
        "ses_tool",
        1,
        "edit",
        serde_json::json!({}),
        serde_json::json!({}),
        None,
    );
    let input = serde_json::json!({"action":"complete"});
    let Failure::Tool { message, .. } = call(&tool, "ses_tool", input.clone()).await.unwrap_err()
    else {
        panic!("tool failure")
    };
    record(
        &f,
        "ses_tool",
        2,
        "goal",
        input.clone(),
        serde_json::json!({}),
        Some(&message),
    );
    f.authority.store.submit(|tx| {
        ycoding_store::session::append(tx, &ycoding_store::session::NewEvent { id: "evt_review_goal".into(), aggregate_id: "ses_tool".into(), created: 3, type_: "session.review.deferred.1".into(), data: parse_json(r#"{"sessionID":"ses_tool","itemID":"rvw_goal_gate","kind":"question","reason":"free_text","origin":{"requestID":"frm_goal_gate"},"payload":{"type":"form","title":"Plan","fields":[{"key":"plan","type":"string","required":true}]}}"#).unwrap() }, None).map(|_| ())
    }).unwrap().wait().unwrap();
    let Failure::Tool { message, .. } = call(&tool, "ses_tool", input).await.unwrap_err() else {
        panic!("tool failure")
    };
    assert!(!message.contains("charged"));
    let result = call(&tool, "ses_tool", serde_json::json!({"action":"report"}))
        .await
        .unwrap();
    assert!(ycoding_schema::stringify_json(&result.structured).contains("Not counted"));
    assert_eq!(
        tool.autonomy
            .get(&id("ses_tool"))
            .unwrap()
            .goal
            .unwrap()
            .no_progress,
        0
    );
    f.cleanup();
}

#[test]
fn verification_summary_tracks_completed_changes_opened_rework_and_later_shell_checks() {
    let f = ToolFixture::new();
    let tool = tool(&f);
    let summary =
        || autonomy::verification::verification(&tool.sessions.context(&id("ses_tool")).unwrap());
    assert!(summary().contains("no file changes"));
    record(
        &f,
        "ses_tool",
        1,
        "edit",
        serde_json::json!({}),
        serde_json::json!({}),
        Some("edit failed"),
    );
    assert!(summary().contains("no file changes"));
    record(
        &f,
        "ses_tool",
        2,
        "write",
        serde_json::json!({}),
        serde_json::json!({}),
        None,
    );
    assert!(summary().contains("next step must run"));
    record(
        &f,
        "ses_tool",
        3,
        "shell",
        serde_json::json!({"command":"cargo test parser"}),
        serde_json::json!({"exit":0}),
        None,
    );
    assert!(summary().contains("a check ran after"));
    record(
        &f,
        "ses_tool",
        4,
        "goal",
        serde_json::json!({"action":"rework","state":"opened","unit":"parser","reason":"regression"}),
        serde_json::json!({}),
        None,
    );
    assert!(summary().contains("next step must run"));
    f.cleanup();
}
