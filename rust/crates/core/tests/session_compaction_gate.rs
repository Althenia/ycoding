use ycoding_ai::{llm, route::Route};
use ycoding_core::session::{
    compaction_gate::{can_reduce, estimated_provider_input_tokens, target_input_tokens},
    compaction_policy::resolve,
    context_pressure::{Usage, estimated_input_tokens},
};
use ycoding_schema::{
    DomainDecode, LosslessString, parse_json, provider, schema::DateTimeUtcFromMillis,
    session_message,
};

fn policy(json: &str) -> ycoding_core::session::compaction_policy::Resolved {
    resolve(&[
        ycoding_core::session::compaction_policy::Info::decode(&parse_json(json).unwrap()).unwrap(),
    ])
}

fn model(route: Route) -> llm::Model {
    llm::Model {
        id: "gpt-test".into(),
        provider: provider::Id("openai".into()),
        route: std::sync::Arc::new(route),
        defaults: Default::default(),
        tool_schema: None,
    }
}

fn request(messages: &[llm::Message]) -> llm::Request {
    let mut request = llm::Request::new(model(Route::openai_chat()));
    request.messages = messages.to_vec();
    request
}

fn time(millis: i64) -> DateTimeUtcFromMillis {
    DateTimeUtcFromMillis::new(millis as f64).unwrap()
}

fn user(message: &str, consumed: Option<i64>) -> session_message::Info {
    session_message::Info::User(session_message::User {
        id: session_message::Id::new(message).unwrap(),
        metadata: None,
        time: session_message::UserTime {
            created: time(1),
            consumed: consumed.map(time),
        },
        text: "history".into(),
        files: None,
        agents: None,
    })
}

fn assistant(message: &str, completed: Option<i64>) -> session_message::Info {
    session_message::Info::Assistant(Box::new(session_message::Assistant {
        id: session_message::Id::new(message).unwrap(),
        metadata: None,
        time: session_message::CompletedTime {
            created: time(3),
            completed: completed.map(time),
        },
        agent: "agt_test".into(),
        model: ycoding_schema::model::Ref {
            id: "gpt-test".into(),
            provider_id: provider::Id("openai".into()),
            variant: None,
            profile: None,
        },
        content: Vec::new(),
        skill_deactivations: None,
        snapshot: None,
        finish: None,
        cost: None,
        tokens: None,
        diagnostics: None,
        error: None,
        retry: None,
    }))
}

fn identified(role: llm::Role, id: Option<&str>, text: &str) -> llm::Message {
    let mut message = match role {
        llm::Role::User => llm::Message::user(text),
        llm::Role::Assistant => {
            llm::Message::assistant(vec![llm::Part::Text(llm::TextPart::from(text))])
        }
        llm::Role::System => llm::Message::system(text),
        llm::Role::Tool => llm::Message::new(
            llm::Role::Tool,
            vec![llm::Part::Text(llm::TextPart::from(text))],
        ),
    };
    message.id = id.map(LosslessString::from);
    message
}

#[test]
fn targets_use_the_consider_threshold_with_a_disabled_fallback() {
    assert_eq!(target_input_tokens(1000, &resolve(&[])), 700);
    assert_eq!(
        target_input_tokens(1000, &policy(r#"{"advisory":false}"#)),
        700
    );
    assert_eq!(
        target_input_tokens(
            1000,
            &policy(r#"{"advisory":{"consider_percent":50,"strongly_advised_percent":80}}"#)
        ),
        500
    );
}

#[test]
fn reduction_keeps_system_volatile_and_unremovable_messages() {
    let history = vec![
        user("msg_a", Some(2)),
        assistant("msg_b", Some(4)),
        user("msg_c", Some(6)),
    ];
    let long_a = "a".repeat(400);
    let long_b = "b".repeat(400);
    let messages = vec![
        identified(llm::Role::System, None, "system"),
        identified(llm::Role::User, Some("msg_a"), &long_a),
        identified(llm::Role::Assistant, Some("msg_b"), &long_b),
        identified(llm::Role::User, Some("msg_c"), "keep"),
        llm::Message {
            volatile: true,
            ..identified(llm::Role::User, Some("msg_a"), &long_a)
        },
    ];
    let kept = vec![
        messages[0].clone(),
        messages[3].clone(),
        messages[4].clone(),
    ];
    let expected = estimated_input_tokens(Usage {
        system: &[],
        tools: &[],
        messages: &kept,
    });
    let full = estimated_input_tokens(Usage {
        system: &[],
        tools: &[],
        messages: &messages,
    });
    assert!(full > expected);
    assert!(expected > 0);
    let request = request(&messages);
    assert!(can_reduce(&request, &history, expected + 1));
    assert!(!can_reduce(&request, &history, expected));
}

#[test]
fn reduction_counts_the_request_system_prompt_and_tools() {
    let history = vec![user("msg_a", Some(2)), user("msg_c", Some(6))];
    let messages = vec![
        identified(llm::Role::User, Some("msg_a"), &"a".repeat(400)),
        identified(llm::Role::User, Some("msg_c"), "keep"),
    ];
    let bare = request(&messages);
    let mut loaded = request(&messages);
    loaded.system = vec!["s".repeat(4_000).as_str().into()];
    loaded.tools = vec![llm::ToolDefinition {
        name: "lookup".into(),
        description: "x".repeat(4_000).as_str().into(),
        input_schema: parse_json(r#"{"type":"object"}"#).unwrap(),
        output_schema: None,
        cache: None,
        metadata: None,
        native: None,
    }];
    let kept = vec![messages[1].clone()];
    let without_overhead = estimated_input_tokens(Usage {
        system: &[],
        tools: &[],
        messages: &kept,
    });
    let with_overhead = estimated_input_tokens(Usage {
        system: &loaded.system,
        tools: &loaded.tools,
        messages: &kept,
    });
    assert!(with_overhead > without_overhead + 1_500);
    assert!(can_reduce(&bare, &history, without_overhead + 1));
    assert!(!can_reduce(&loaded, &history, without_overhead + 1));
    assert!(can_reduce(&loaded, &history, with_overhead + 1));
    assert!(!can_reduce(&loaded, &history, with_overhead));
}

#[test]
fn reduction_needs_a_consumed_user_or_a_completed_assistant() {
    let history = vec![user("msg_a", None), user("msg_c", Some(6))];
    let messages = vec![
        identified(llm::Role::User, Some("msg_a"), &"a".repeat(400)),
        identified(llm::Role::User, Some("msg_c"), "keep"),
    ];
    let request = request(&messages);
    assert!(!can_reduce(&request, &history, i64::MAX));
    let pending = vec![user("msg_a", None)];
    assert!(!can_reduce(&request, &pending, i64::MAX));
}

#[test]
fn provider_estimates_match_the_pressure_estimator_on_plain_routes() {
    let mut chat = llm::Request::new(model(Route::openai_chat()));
    chat.messages = vec![llm::Message::user("hello"), llm::Message::system("system")];
    assert_eq!(
        estimated_provider_input_tokens(&chat),
        estimated_input_tokens(Usage {
            system: &chat.system,
            tools: &chat.tools,
            messages: &chat.messages,
        })
    );
    let mut responses = llm::Request::new(model(Route::openai_responses()));
    responses.messages = chat.messages.clone();
    assert_eq!(
        estimated_provider_input_tokens(&responses),
        estimated_provider_input_tokens(&chat)
    );
}
