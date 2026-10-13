use super::context_pressure;
use ycoding_ai::llm;
use ycoding_schema::{JsonValue, model, schema::NonNegativeInt, session, session_message};

#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    Switched,
    Blocked(session::ModelSwitchBlocked),
}

pub fn estimate(messages: &[llm::Message]) -> i64 {
    context_pressure::estimate_json(&JsonValue::Array(
        messages
            .iter()
            .map(context_pressure::message_value)
            .collect(),
    ))
}

pub fn decide(
    current: Option<&model::Ref>,
    target: &model::Ref,
    messages: &[llm::Message],
    budget: i64,
) -> Outcome {
    let Some(current) = current else {
        return Outcome::Switched;
    };
    let tokens = estimate(messages);
    if tokens <= budget {
        return Outcome::Switched;
    }
    let nonnegative = |value| NonNegativeInt::new(value).expect("nonnegative context metric");
    Outcome::Blocked(session::ModelSwitchBlocked {
        status: "blocked".into(),
        current_model: current.clone(),
        target_model: target.clone(),
        current_context_tokens: nonnegative(tokens),
        target_safe_input_tokens: nonnegative(budget.max(0)),
        required_reduction_tokens: nonnegative(tokens - budget.max(0)),
        maximum_safe_summary_boundary: None::<session_message::Id>,
        reason: "context-window-exceeded".into(),
    })
}
