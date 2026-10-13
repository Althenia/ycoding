use std::time::Duration;
use ycoding_core::{
    resources::memory::Scope,
    session::prediction::{self, Input},
};
use ycoding_schema::JsonValue;

#[path = "session_support/generation.rs"]
mod support;
use support::{Fixture, Memory, Options, Reply, drain, field, predictions, text};

const SUGGESTION: &str = "Run the focused tests";

async fn within<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(30), future)
        .await
        .expect("operation did not finish within 30 seconds")
}

async fn ready(options: Options) -> Fixture {
    let fixture = Fixture::new(options).await;
    fixture.provider.reply(Reply::Text(SUGGESTION.into()));
    fixture
}

fn plain() -> Input {
    Input::default()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn execution_success_does_not_request_or_publish_a_prediction() {
    within(async {
        let f = ready(Options::default()).await;
        let observer = f.observe();
        f.publish(
            "session.execution.succeeded.1",
            r#"{"sessionID":"ses_one"}"#,
        )
        .await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(f.provider.seen().is_empty());
        assert!(predictions(&drain(&observer)).is_empty());
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn request_returns_the_suggestion_publishes_it_and_includes_a_trimmed_bounded_hint_only_when_set()
 {
    within(async {
        let f = ready(Options::default()).await;
        let service = f.prediction();
        let observer = f.observe();
        let hinted = service
            .request(
                &f.id,
                Input {
                    memory: vec![],
                    hint: Some("  cover the regression tests  ".into()),
                },
            )
            .await;
        assert_eq!(hinted.as_deref(), Some(SUGGESTION));
        let published = predictions(&drain(&observer));
        assert_eq!(published.len(), 1);
        assert_eq!(text(&field(&published[0], "sessionID")), "ses_one");
        assert_eq!(
            text(&field(&published[0], "sourceMessageID")),
            "msg_assistant"
        );
        assert_eq!(text(&field(&published[0], "text")), SUGGESTION);
        let message = f.helper_message(0);
        assert_eq!(text(&field(&message, "user")), "Fix the failing build");
        assert_eq!(text(&field(&message, "assistant")), "The build is fixed.");
        assert_eq!(field(&message, "memory"), JsonValue::Array(vec![]));
        assert_eq!(text(&field(&message, "hint")), "cover the regression tests");
        assert!(f.helper_system(0).contains(
            "An optional hint is the user's guidance for what the next message should be about"
        ));

        let blank = service
            .request(
                &f.id,
                Input {
                    memory: vec![],
                    hint: Some("   ".into()),
                },
            )
            .await;
        assert_eq!(blank.as_deref(), Some(SUGGESTION));
        assert_eq!(field(&f.helper_message(1), "hint"), JsonValue::Null);

        assert!(service.request(&f.id, plain()).await.is_some());
        assert_eq!(field(&f.helper_message(2), "hint"), JsonValue::Null);

        let bounded = service
            .request(
                &f.id,
                Input {
                    memory: vec![],
                    hint: Some(format!(" {} ", "h".repeat(2500))),
                },
            )
            .await;
        assert!(bounded.is_some());
        assert_eq!(text(&field(&f.helper_message(3), "hint")), "h".repeat(2000));
        assert_eq!(predictions(&drain(&observer)).len(), 3);
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_idle_settled_root_reply_produces_a_bounded_helper_request_and_prediction_ledger_usage()
{
    within(async {
        let f = ready(Options::default()).await;
        let result = f.prediction().request(&f.id, plain()).await;
        assert_eq!(result.as_deref(), Some(SUGGESTION));
        assert_eq!(f.provider.seen().len(), 1);
        let JsonValue::Object(body) = &f.provider.seen()[0] else {
            panic!("request body is an object")
        };
        assert!(
            body.get(&"tools".into())
                .is_none_or(|tools| tools == &JsonValue::Array(vec![]))
        );
        let ledger = f.ledger();
        assert_eq!(ledger.len(), 1);
        assert_eq!(ledger[0].0, "prediction");
        assert_eq!(field(&ledger[0].1, "input"), JsonValue::Number(10.0));
        assert_eq!(field(&ledger[0].1, "output"), JsonValue::Number(5.0));
        let messages = f.sessions_context();
        assert_eq!(messages, ["user", "assistant"]);
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn memory_is_searched_only_for_selected_scopes_and_ask_counts_as_consent() {
    within(async {
        let f = ready(Options::default()).await;
        let service = f.prediction();
        assert!(
            service
                .request(
                    &f.id,
                    Input {
                        memory: vec![Scope::Repository],
                        hint: None
                    }
                )
                .await
                .is_some()
        );
        let memory = field(&f.helper_message(0), "memory");
        let JsonValue::Array(snippets) = &memory else {
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
                .request(
                    &f.id,
                    Input {
                        memory: vec![Scope::Knowledge],
                        hint: None
                    }
                )
                .await
                .is_some()
        );
        let JsonValue::Array(snippets) = field(&f.helper_message(1), "memory") else {
            panic!("memory is an array")
        };
        assert_eq!(snippets.len(), 3);
        assert!(
            snippets
                .iter()
                .all(|snippet| text(&field(snippet, "scope")) == "knowledge")
        );
        assert_eq!(text(&field(&snippets[0], "title")), "Test rule 0");
        assert!(
            snippets
                .iter()
                .all(|snippet| text(&field(snippet, "snippet")).encode_utf16().count() <= 600)
        );
        let sent = ycoding_schema::stringify_json(&f.helper_message(1));
        assert!(!sent.contains("Test rule 3") && !sent.contains(&"x".repeat(601)));
        assert!(!sent.contains("digest"));
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
                    Input {
                        memory: vec![Scope::Repository, Scope::Knowledge],
                        hint: None
                    }
                )
                .await
                .is_some()
        );
        assert_eq!(
            field(&f.helper_message(2), "memory"),
            JsonValue::Array(vec![])
        );

        *f.access.lock().unwrap() = "allow";
        assert!(service.request(&f.id, plain()).await.is_some());
        assert_eq!(
            field(&f.helper_message(3), "memory"),
            JsonValue::Array(vec![])
        );
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ineligible_sessions_return_unavailable_without_a_request_search_or_event() {
    within(async {
        for options in [
            Options {
                running: true,
                ..Options::default()
            },
            Options {
                pending: true,
                ..Options::default()
            },
            Options {
                compaction_pending: true,
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
                goal: true,
                ..Options::default()
            },
        ] {
            let pending = options.pending;
            let f = ready(options).await;
            if pending {
                f.admit("Already next").await;
            }
            let observer = f.observe();
            let result = f
                .prediction()
                .request(
                    &f.id,
                    Input {
                        memory: vec![Scope::Repository, Scope::Knowledge],
                        hint: None,
                    },
                )
                .await;
            assert_eq!(result, None);
            assert!(f.provider.seen().is_empty());
            assert!(predictions(&drain(&observer)).is_empty());
        }
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejected_helper_output_returns_unavailable_without_an_event_but_keeps_the_ledger_row() {
    within(async {
        let f = Fixture::new(Options::default()).await;
        f.provider
            .reply(Reply::Text("Suggestion: Run the tests".into()));
        let observer = f.observe();
        assert_eq!(f.prediction().request(&f.id, plain()).await, None);
        assert_eq!(f.provider.seen().len(), 1);
        assert!(predictions(&drain(&observer)).is_empty());
        assert_eq!(f.ledger()[0].0, "prediction");
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_request_cancels_the_first_and_the_first_returns_unavailable() {
    within(async {
        let f = ready(Options::default()).await;
        let gate = f.provider.hold();
        let service = f.prediction();
        let observer = f.observe();
        let first = tokio::spawn({
            let (service, id) = (service.clone(), f.id.clone());
            async move { service.request(&id, Input::default()).await }
        });
        f.provider.started().await;
        let second = tokio::spawn({
            let (service, id) = (service.clone(), f.id.clone());
            async move { service.request(&id, Input::default()).await }
        });
        assert_eq!(first.await.unwrap(), None);
        assert!(predictions(&drain(&observer)).is_empty());
        f.provider.started().await;
        gate.notify_one();
        assert_eq!(second.await.unwrap().as_deref(), Some(SUGGESTION));
        assert_eq!(f.ledger().len(), 2);
        assert_eq!(predictions(&drain(&observer)).len(), 1);
        assert_eq!(f.provider.seen().len(), 2);
        f.provider.closed(1).await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn input_admission_execution_start_agent_and_model_selection_interrupt_a_held_helper() {
    within(async {
        for (kind, data) in [
            ("input", ""),
            ("session.execution.started.1", r#"{"sessionID":"ses_one"}"#),
            (
                "session.agent.selected.1",
                r#"{"sessionID":"ses_one","agent":"review"}"#,
            ),
            (
                "session.model.selected.1",
                r#"{"sessionID":"ses_one","model":{"providerID":"openai","id":"other"}}"#,
            ),
        ] {
            let f = ready(Options::default()).await;
            f.provider.hold();
            let observer = f.observe();
            let running = tokio::spawn({
                let (service, id) = (f.prediction(), f.id.clone());
                async move { service.request(&id, Input::default()).await }
            });
            f.provider.started().await;
            if kind == "input" {
                f.admit("New instruction").await;
            } else {
                f.publish(kind, data).await;
            }
            assert_eq!(running.await.unwrap(), None, "{kind}");
            assert!(predictions(&drain(&observer)).is_empty(), "{kind}");
            assert_eq!(f.provider.seen().len(), 1, "{kind}");
            f.provider.closed(1).await;
            assert_eq!(f.ledger().len(), 1, "{kind}");
        }
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rejected_request_or_non_stop_finish_never_publishes_an_otherwise_valid_suggestion() {
    within(async {
        let f = Fixture::new(Options::default()).await;
        let observer = f.observe();
        f.provider.reply(Reply::Rejected);
        assert_eq!(f.prediction().request(&f.id, plain()).await, None);
        f.provider.reply(Reply::Finish(SUGGESTION.into(), "length"));
        assert_eq!(f.prediction().request(&f.id, plain()).await, None);
        assert_eq!(f.provider.seen().len(), 2);
        assert!(predictions(&drain(&observer)).is_empty());
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_complete_follow_up_above_the_old_output_cap_is_published_without_transcript_insertion() {
    within(async {
        let f = Fixture::new(Options::default()).await;
        let output = "Please review the implementation and run the focused regression tests, then summarize the results, explain any remaining risks, and identify whether the current changes preserve the selected model, provider profile, permissions, and composer draft behavior.";
        assert_eq!(output.split_whitespace().count(), 35);
        f.provider.reply(Reply::Text(output.into()));
        assert_eq!(f.prediction().request(&f.id, plain()).await.as_deref(), Some(output));
        assert!(f.helper_system(0).contains("2–40 words and at most 400 characters"));
        assert_eq!(f.sessions_context(), ["user", "assistant"]);
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recent_text_is_truncated_to_the_documented_bounds() {
    within(async {
        let f = ready(Options {
            user: Some("U".repeat(2500)),
            assistant: Some("A".repeat(4500)),
            ..Options::default()
        })
        .await;
        f.prediction().request(&f.id, plain()).await;
        let message = f.helper_message(0);
        assert_eq!(text(&field(&message, "user")), "U".repeat(2000));
        assert_eq!(text(&field(&message, "assistant")), "A".repeat(4000));
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unavailable_memory_degrades_to_a_conversation_only_helper() {
    within(async {
        let f = ready(Options {
            memory: Memory::Unavailable,
            ..Options::default()
        })
        .await;
        let observer = f.observe();
        let result = f
            .prediction()
            .request(
                &f.id,
                Input {
                    memory: vec![Scope::Repository, Scope::Knowledge],
                    hint: None,
                },
            )
            .await;
        assert_eq!(result.as_deref(), Some(SUGGESTION));
        assert_eq!(
            field(&f.helper_message(0), "memory"),
            JsonValue::Array(vec![])
        );
        assert_eq!(predictions(&drain(&observer)).len(), 1);
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outside_git_prediction_searches_shared_knowledge_only() {
    within(async {
        let f = ready(Options {
            memory: Memory::OutsideGit,
            ..Options::default()
        })
        .await;
        let result = f
            .prediction()
            .request(
                &f.id,
                Input {
                    memory: vec![Scope::Repository, Scope::Knowledge],
                    hint: None,
                },
            )
            .await;
        assert!(result.is_some());
        let JsonValue::Array(snippets) = field(&f.helper_message(0), "memory") else {
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
fn helper_output_filter_accepts_only_single_line_suggestions_in_bounds() {
    let previous = "Fix the failing build";
    let long_words = format!("{}b", "a ".repeat(39));
    let long_words_over = format!("{}b", "a ".repeat(40));
    let edge = format!("{} yz", "x".repeat(397));
    let over = format!("{} yz", "x".repeat(398));
    for (value, accepted) in [
        ("Run the tests", true),
        (long_words.as_str(), true),
        ("Thanks", false),
        (long_words_over.as_str(), false),
        ("", false),
        ("No suggestion", false),
        ("nothing", false),
        ("Nothing else to suggest", false),
        ("Suggestion: Run the tests", false),
        ("\"Run the tests\"", false),
        ("Error: request failed", false),
        ("I cannot predict the next message", false),
        ("Run tests\nThen report", false),
        ("Fix the failing build", false),
        ("An error occurred", false),
        ("User might ask to run tests", false),
        ("Suggested prompt: Run tests", false),
        ("No useful suggestion", false),
        ("Run \u{1b}[31mthe tests", false),
        (edge.as_str(), true),
        (over.as_str(), false),
        ("Run \u{200e}the tests", false),
        ("Run \u{200f}the tests", false),
        ("Run \u{61c}the tests", false),
        ("Run the\u{2028}tests", false),
        ("Run the\u{2029}tests", false),
    ] {
        assert_eq!(
            prediction::accept(value, previous).is_some(),
            accepted,
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
        let observer = f.observe();
        let result = f
            .prediction()
            .request(
                &f.id,
                Input {
                    memory: vec![Scope::Repository, Scope::Knowledge],
                    hint: None,
                },
            )
            .await;
        assert_eq!(result, None);
        assert!(f.acting.lock().unwrap().is_empty());
        assert!(f.provider.seen().is_empty());
        assert!(predictions(&drain(&observer)).is_empty());
    })
    .await;
}
