use std::time::Duration;
use ycoding_core::{
    resources::memory::Scope,
    session::prompt_generator::{self, Input, Mode},
};
use ycoding_schema::JsonValue;

#[path = "session_support/generation.rs"]
mod support;
use support::{Fixture, Memory, Options, Reply, drain, field, predictions, text};

const DRAFT: &str = "Fix the build, keep the public API, and verify with the focused tests.";

async fn within<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(30), future)
        .await
        .expect("operation did not finish within 30 seconds")
}

async fn ready(options: Options) -> Fixture {
    let fixture = Fixture::new(options).await;
    fixture.provider.reply(Reply::Text(DRAFT.into()));
    fixture
}

fn input(mode: Mode, intent: &str, memory: Vec<Scope>) -> Input {
    Input {
        mode,
        intent: intent.into(),
        memory,
    }
}

fn steer() -> Input {
    input(Mode::Steer, "Cover the regression", vec![])
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn returns_generated_text_for_an_idle_session_and_records_prompt_usage_without_a_transcript_entry()
 {
    within(async {
        let f = ready(Options::default()).await;
        let observer = f.observe();
        let result = f
            .prompts()
            .request(
                &f.id,
                input(Mode::Start, "  Cover the regression  ", vec![]),
            )
            .await;
        assert_eq!(result.as_deref(), Some(DRAFT));
        assert_eq!(f.provider.seen().len(), 1);
        assert!(f.helper_system(0).contains("Output only the prompt text"));
        let message = f.helper_message(0);
        assert_eq!(text(&field(&message, "mode")), "start");
        assert_eq!(text(&field(&message, "intent")), "Cover the regression");
        let recent = field(&message, "recent");
        assert_eq!(text(&field(&recent, "user")), "Fix the failing build");
        assert_eq!(text(&field(&recent, "assistant")), "The build is fixed.");
        assert_eq!(field(&message, "memory"), JsonValue::Array(vec![]));
        let ledger = f.ledger();
        assert_eq!(ledger.len(), 1);
        assert_eq!(ledger[0].0, "prompt");
        assert_eq!(field(&ledger[0].1, "output"), JsonValue::Number(5.0));
        assert_eq!(f.sessions_context(), ["user", "assistant"]);
        assert!(predictions(&drain(&observer)).is_empty());
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn generates_for_a_running_child_session_with_an_active_goal_pending_input_and_an_unfinished_reply()
 {
    within(async {
        for options in [
            Options {
                running: true,
                goal: true,
                ..Options::default()
            },
            Options {
                pending: true,
                ..Options::default()
            },
            Options {
                child: true,
                ..Options::default()
            },
            Options {
                no_reply: true,
                ..Options::default()
            },
            Options {
                no_user: true,
                ..Options::default()
            },
        ] {
            let pending = options.pending;
            let f = ready(options).await;
            if pending {
                f.admit("Already next").await;
            }
            let result = f
                .prompts()
                .request(&f.id, input(Mode::Goal, "Ship the fix", vec![]))
                .await;
            assert_eq!(result.as_deref(), Some(DRAFT));
            assert_eq!(f.provider.seen().len(), 1);
        }
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn omits_absent_recent_parts_and_bounds_recent_text() {
    within(async {
        let empty = ready(Options {
            no_user: true,
            ..Options::default()
        })
        .await;
        empty
            .prompts()
            .request(&empty.id, input(Mode::Steer, "Open the task", vec![]))
            .await;
        let message = empty.helper_message(0);
        assert_eq!(field(&message, "recent"), JsonValue::Null);
        assert_eq!(text(&field(&message, "intent")), "Open the task");
        assert_eq!(field(&message, "memory"), JsonValue::Array(vec![]));

        let f = ready(Options {
            user: Some("U".repeat(2500)),
            assistant: Some("A".repeat(4500)),
            ..Options::default()
        })
        .await;
        f.prompts()
            .request(
                &f.id,
                input(
                    Mode::Queue,
                    &"I".repeat(100),
                    vec![Scope::Repository, Scope::Knowledge],
                ),
            )
            .await;
        let message = f.helper_message(0);
        assert_eq!(
            text(&field(&field(&message, "recent"), "user")),
            "U".repeat(2000)
        );
        assert_eq!(
            text(&field(&field(&message, "recent"), "assistant")),
            "A".repeat(4000)
        );
        assert_eq!(text(&field(&message, "mode")), "queue");
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn memory_is_searched_only_for_selected_scopes_and_ask_counts_as_consent() {
    within(async {
        let f = ready(Options::default()).await;
        let service = f.prompts();
        assert!(
            service
                .request(&f.id, input(Mode::Steer, "build", vec![Scope::Repository]))
                .await
                .is_some()
        );
        let JsonValue::Array(snippets) = field(&f.helper_message(0), "memory") else {
            panic!("memory is an array")
        };
        assert_eq!(snippets.len(), 3);
        assert!(
            snippets
                .iter()
                .all(|snippet| text(&field(snippet, "scope")) == "repository")
        );

        *f.access.lock().unwrap() = "ask";
        assert!(
            service
                .request(&f.id, input(Mode::Steer, "build", vec![Scope::Knowledge]))
                .await
                .is_some()
        );
        let sent = ycoding_schema::stringify_json(&f.helper_message(1));
        assert!(sent.contains("Test rule 0") && !sent.contains("Test rule 3"));
        assert!(!sent.contains(&"x".repeat(601)) && !sent.contains("digest"));
        assert!(
            f.acting
                .lock()
                .unwrap()
                .iter()
                .all(|agent| agent.as_deref() == Some("build"))
        );

        *f.access.lock().unwrap() = "deny";
        assert!(
            service
                .request(
                    &f.id,
                    input(
                        Mode::Steer,
                        "build",
                        vec![Scope::Repository, Scope::Knowledge]
                    )
                )
                .await
                .is_some()
        );
        assert_eq!(
            field(&f.helper_message(2), "memory"),
            JsonValue::Array(vec![])
        );

        *f.access.lock().unwrap() = "allow";
        assert!(service.request(&f.id, steer()).await.is_some());
        assert_eq!(
            field(&f.helper_message(3), "memory"),
            JsonValue::Array(vec![])
        );
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_missing_or_foreign_session_blank_intent_and_rejected_output_return_unavailable() {
    within(async {
        let f = ready(Options::default()).await;
        let missing = ycoding_schema::session::Id::new("ses_missing").unwrap();
        assert_eq!(f.prompts().request(&missing, steer()).await, None);
        assert_eq!(
            f.prompts()
                .request(&f.id, input(Mode::Steer, "   ", vec![]))
                .await,
            None
        );
        assert!(f.provider.seen().is_empty());

        let foreign = ready(Options {
            directory: Some("/other"),
            ..Options::default()
        })
        .await;
        assert_eq!(foreign.prompts().request(&foreign.id, steer()).await, None);
        assert!(foreign.provider.seen().is_empty());

        let rejected = ready(Options::default()).await;
        rejected
            .provider
            .reply(Reply::Text("I cannot draft this prompt".into()));
        assert_eq!(
            rejected.prompts().request(&rejected.id, steer()).await,
            None
        );
        assert_eq!(rejected.ledger()[0].0, "prompt");
        assert_eq!(rejected.sessions_context(), ["user", "assistant"]);
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rejected_request_and_a_non_stop_finish_return_unavailable() {
    within(async {
        let f = Fixture::new(Options::default()).await;
        f.provider.reply(Reply::Rejected);
        assert_eq!(f.prompts().request(&f.id, steer()).await, None);
        f.provider.reply(Reply::Finish(DRAFT.into(), "length"));
        assert_eq!(f.prompts().request(&f.id, steer()).await, None);
        assert_eq!(f.provider.seen().len(), 2);
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn strips_one_wrapping_fence_and_keeps_a_multiline_draft() {
    within(async {
        let f = Fixture::new(Options::default()).await;
        f.provider.reply(Reply::Text(
            "```markdown\nFix the build.\nVerify the focused tests.\n```".into(),
        ));
        assert_eq!(
            f.prompts().request(&f.id, steer()).await.as_deref(),
            Some("Fix the build.\nVerify the focused tests.")
        );
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_request_cancels_the_first_and_the_first_returns_unavailable() {
    within(async {
        let f = ready(Options::default()).await;
        let gate = f.provider.hold();
        let service = f.prompts();
        let first = tokio::spawn({
            let (service, id) = (service.clone(), f.id.clone());
            async move { service.request(&id, steer()).await }
        });
        f.provider.started().await;
        let second = tokio::spawn({
            let (service, id) = (service.clone(), f.id.clone());
            async move {
                service
                    .request(&id, input(Mode::Queue, "Follow up", vec![]))
                    .await
            }
        });
        assert_eq!(first.await.unwrap(), None);
        f.provider.started().await;
        gate.notify_one();
        assert_eq!(second.await.unwrap().as_deref(), Some(DRAFT));
        assert_eq!(f.provider.seen().len(), 2);
        f.provider.closed(1).await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn admission_and_execution_start_do_not_cancel_while_move_delete_and_archive_do() {
    within(async {
        let held = ready(Options::default()).await;
        let gate = held.provider.hold();
        let running = tokio::spawn({
            let (service, id) = (held.prompts(), held.id.clone());
            async move { service.request(&id, steer()).await }
        });
        held.provider.started().await;
        held.admit("New instruction").await;
        held.publish("session.execution.started.1", r#"{"sessionID":"ses_one"}"#)
            .await;
        gate.notify_one();
        assert_eq!(running.await.unwrap().as_deref(), Some(DRAFT));

        for (kind, data) in [
            (
                "session.moved.1",
                r#"{"sessionID":"ses_one","location":{"directory":"/moved"}}"#,
            ),
            ("session.deleted.2", r#"{"sessionID":"ses_one"}"#),
            ("session.archived.2", r#"{"sessionID":"ses_one"}"#),
        ] {
            let f = ready(Options::default()).await;
            f.provider.hold();
            let running = tokio::spawn({
                let (service, id) = (f.prompts(), f.id.clone());
                async move { service.request(&id, steer()).await }
            });
            f.provider.started().await;
            f.publish(kind, data).await;
            assert_eq!(running.await.unwrap(), None, "{kind}");
            f.provider.closed(1).await;
        }
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unavailable_memory_and_a_repository_outside_git_degrade_without_failing_the_draft() {
    within(async {
        let failed = ready(Options {
            memory: Memory::Unavailable,
            ..Options::default()
        })
        .await;
        let result = failed
            .prompts()
            .request(
                &failed.id,
                input(
                    Mode::Steer,
                    "build",
                    vec![Scope::Repository, Scope::Knowledge],
                ),
            )
            .await;
        assert_eq!(result.as_deref(), Some(DRAFT));
        assert_eq!(
            field(&failed.helper_message(0), "memory"),
            JsonValue::Array(vec![])
        );

        let outside = ready(Options {
            memory: Memory::OutsideGit,
            ..Options::default()
        })
        .await;
        assert!(
            outside
                .prompts()
                .request(
                    &outside.id,
                    input(
                        Mode::Steer,
                        "build",
                        vec![Scope::Repository, Scope::Knowledge]
                    )
                )
                .await
                .is_some()
        );
        let JsonValue::Array(snippets) = field(&outside.helper_message(0), "memory") else {
            panic!("memory is an array")
        };
        assert_eq!(snippets.len(), 3);
        assert!(
            snippets
                .iter()
                .all(|snippet| text(&field(snippet, "scope")) == "knowledge")
        );
    })
    .await;
}

#[test]
fn helper_output_filter_unwraps_one_fence_or_quote_pair_and_rejects_unsafe_text() {
    let limit = "x".repeat(8000);
    let over = "x".repeat(8001);
    for (value, expected) in [
        (
            "Fix the build and verify it.",
            Some("Fix the build and verify it."),
        ),
        ("```\nFix the build.\n```", Some("Fix the build.")),
        (
            "```ts\nLine one.\nLine two.\n```",
            Some("Line one.\nLine two."),
        ),
        ("\"Fix the build.\"", Some("Fix the build.")),
        ("'Fix the build.'", Some("Fix the build.")),
        ("“Fix the build.”", Some("Fix the build.")),
        ("‘Fix the build.’", Some("Fix the build.")),
        ("```\n\"Fix the build.\"\n```", Some("Fix the build.")),
        (
            "Keep going.\nThen verify.",
            Some("Keep going.\nThen verify."),
        ),
        ("Column\tone", Some("Column\tone")),
        ("Line\r\nbreak", Some("Line\r\nbreak")),
        (limit.as_str(), Some(limit.as_str())),
        ("", None),
        ("   ", None),
        (over.as_str(), None),
        ("I cannot draft this", None),
        ("I can't help with that", None),
        ("I can’t help with that", None),
        ("Sorry, no prompt", None),
        ("As an AI I should refuse", None),
        ("Fix the\u{0}build", None),
        ("Fix the\u{200e}build", None),
        ("Fix the\u{2028}build", None),
        ("Fix the\u{2029}build", None),
    ] {
        assert_eq!(
            prompt_generator::accept(value).as_deref(),
            expected,
            "{value:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unresolvable_helper_model_answers_unavailable_before_any_memory_access() {
    within(async {
        let f = ready(Options {
            unresolvable_model: true,
            ..Options::default()
        })
        .await;
        let result = f
            .prompts()
            .request(
                &f.id,
                input(
                    Mode::Steer,
                    "build",
                    vec![Scope::Repository, Scope::Knowledge],
                ),
            )
            .await;
        assert_eq!(result, None);
        assert!(f.acting.lock().unwrap().is_empty());
        assert!(f.provider.seen().is_empty());
    })
    .await;
}
