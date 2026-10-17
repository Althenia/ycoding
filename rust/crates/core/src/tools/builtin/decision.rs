use super::{native::definition, session_action::permit};
use crate::{
    resources::decision::{self, judgment, toon},
    tools::{
        context::{Context, policy::LeafPolicy},
        registry::{Failure, Tool, ToolFuture},
    },
};
use std::sync::Arc;
use ycoding_ai::llm::{ToolDefinition, ToolOutput};
use ycoding_schema::{
    JsonValue,
    llm::{ToolContent, ToolTextContent},
};

pub struct Decision {
    pub decisions: Arc<decision::Service>,
    pub policy: Arc<LeafPolicy>,
}
impl Tool for Decision {
    fn definition(&self, name: &str) -> ToolDefinition {
        definition(name, include_str!("decision.tool.json"))
    }
    fn permission(&self) -> Option<&str> {
        None
    }
    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            let JsonValue::Object(fields) = &input else {
                return Err(Failure::message(invalid_input(&input)));
            };
            let request = fields
                .get(&"request".into())
                .ok_or_else(|| Failure::message(invalid_input(&input)))?;
            if fields.iter().count() != 2
                || fields.get(&"provider".into()) != Some(&JsonValue::String("agent".into()))
                || judgment::Request::decode(request).is_err()
            {
                return Err(Failure::message(invalid_input(&input)));
            }
            permit(
                &self.policy,
                &context,
                "decision",
                "agent",
                true,
                "Decision request is not permitted",
            )
            .await?;
            let output = self
                .decisions
                .evaluate(
                    &input,
                    decision::Invocation {
                        session_id: &context.session_id,
                        input_id: None,
                        cancellation: &context.cancellation,
                        attribution: context.attribution.clone(),
                    },
                )
                .await
                .map_err(|error| match error {
                    decision::Error::Cancelled => Failure::Cancelled,
                    _ => Failure::message(error.to_string()),
                })?;
            let mut content = vec![ToolContent::Text(ToolTextContent {
                text: toon::encode(&output).into(),
            })];
            if let JsonValue::Object(fields) = &output && let Some(JsonValue::Object(response)) = fields.get(&"response".into()) && let Some(JsonValue::Array(answers)) = response.get(&"answers".into()) && answers.iter().any(|answer| matches!(answer, JsonValue::Object(answer) if answer.get(&"type".into()) == Some(&JsonValue::String("refusal".into())))) {
                content.push(ToolContent::Text(ToolTextContent {text: "The helper refused at least one judgment. Treat refusal as uncertainty; supply missing bounded evidence or decide from evidence or ask the user. Do not retry an unchanged judgment.".into()}));
            }
            Ok(ToolOutput {
                structured: output,
                content,
            })
        })
    }
}
fn invalid_input(input: &JsonValue) -> String {
    let example = r#"{"provider":"agent","request":{"state":{},"questions":[{"type":"choice","name":"route","instructions":"Grade each route","grade":true,"choices":[{"value":"keep","description":"Keep current"},{"value":"change","description":"Use the alternative"}]}]}}"#;
    if let JsonValue::Object(input) = input
        && let Some(JsonValue::Object(request)) = input.get(&"request".into())
        && let Some(JsonValue::Array(questions)) = request.get(&"questions".into())
    {
        if questions.is_empty() {
            return "questions: expected at least one question; received []. Add one bounded question, or skip the decision tool if no judgment is needed.".into();
        }
        for (index, question) in questions.iter().enumerate() {
            let JsonValue::Object(question) = question else {
                continue;
            };
            if question.get(&"type".into()).is_some_and(|value| !matches!(value, JsonValue::String(value) if matches!(value.as_str(), Some("predicate" | "choice" | "score")))) {return format!("questions[{index}].type: expected \"predicate\", \"choice\", or \"score\"; received an unsupported value (redacted). Minimal valid request: {example}");}
            if question
                .get(&"grade".into())
                .is_some_and(|grade| !matches!(grade, JsonValue::Bool(_)))
            {
                return format!(
                    "request.questions[{index}].grade: Expected a Boolean; received an invalid value (redacted). Minimal valid request: {example}"
                );
            }
            if let Some(JsonValue::Array(choices)) = question.get(&"choices".into()) {
                for (choice_index, choice) in choices.iter().enumerate() {
                    if let JsonValue::Object(choice) = choice
                        && !matches!(
                            choice.get(&"value".into()),
                            Some(JsonValue::String(_) | JsonValue::Bool(_))
                        )
                    {
                        return format!(
                            "request.questions[{index}].choices[{choice_index}].value: Expected a string or Boolean; received an invalid value (redacted). Minimal valid request: {example}"
                        );
                    }
                }
            }
            if let Some(JsonValue::Array(levels)) = question.get(&"levels".into())
                && !(2..=10).contains(&levels.len())
            {
                return format!(
                    "request.questions[{index}].levels: Expected 2–10 rubric levels. Minimal valid request: {example}"
                );
            }
        }
    }
    format!(
        "input: Expected a value matching the declared schema; received an invalid value (redacted). Minimal valid request: {example}"
    )
}
