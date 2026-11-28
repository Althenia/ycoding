use super::{
    native::definition,
    session_action::{decode, invalid, output, permit},
};
use crate::tools::{
    context::{Context, policy::LeafPolicy},
    policy::forms::{Error as FormError, Forms},
    registry::{Failure, Tool, ToolFuture},
};
use std::sync::Arc;
use ycoding_ai::llm::ToolDefinition;
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder, form, question,
};

pub struct Question {
    pub forms: Forms,
    pub policy: Arc<LeafPolicy>,
}
impl Tool for Question {
    fn definition(&self, name: &str) -> ToolDefinition {
        definition(name, include_str!("question.tool.json"))
    }
    fn permission(&self) -> Option<&str> {
        None
    }
    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            let questions: Vec<question::Info> =
                decode(&input)?.field("questions").map_err(invalid)?;
            if questions.is_empty() {
                return Err(Failure::message(
                    "Invalid tool input: questions must not be empty",
                ));
            }
            permit(
                &self.policy,
                &context,
                "question",
                "*",
                false,
                "Permission denied: question",
            )
            .await?;
            if context.cancellation.is_cancelled() {
                return Err(Failure::Cancelled);
            }
            let fields = questions
                .iter()
                .enumerate()
                .map(|(index, question)| {
                    ObjectEncoder::new()
                        .field("key", format!("q{index}").as_str())
                        .field("title", &question.header)
                        .field("description", &question.question)
                        .field(
                            "type",
                            if question.multiple == Some(true) {
                                "multiselect"
                            } else {
                                "string"
                            },
                        )
                        .field(
                            "options",
                            &question
                                .options
                                .iter()
                                .map(|option| {
                                    ObjectEncoder::new()
                                        .field("value", &option.label)
                                        .field("label", &option.label)
                                        .field("description", &option.description)
                                        .finish()
                                })
                                .collect::<Vec<_>>(),
                        )
                        .field("custom", &question.custom.unwrap_or(true))
                        .optional("required", &question.options.is_empty().then_some(true))
                        .finish()
                })
                .collect::<Vec<_>>();
            let form = form::Info::decode(
                &ObjectEncoder::new()
                    .field(
                        "id",
                        crate::platform::identifier("frm_")
                            .map_err(|error| Failure::Defect(error.to_string()))?
                            .as_str(),
                    )
                    .field("sessionID", &context.session_id)
                    .field("title", "Questions")
                    .field(
                        "metadata",
                        &ObjectEncoder::new()
                            .field("kind", "question")
                            .field(
                                "tool",
                                &ObjectEncoder::new()
                                    .field("messageID", &context.message_id)
                                    .field("callID", &context.call_id)
                                    .finish(),
                            )
                            .finish(),
                    )
                    .field("fields", &fields)
                    .finish(),
            )
            .map_err(invalid)?;
            let form_id = form.id.clone();
            let wait = match self.forms.ask(form) {
                Ok(wait) => wait,
                Err(FormError::ReviewFull { .. }) => return Ok(unanswered(questions.len(), "reviewFull", JsonValue::Bool(true), None, "The user's review box is full, so this question was not recorded. Do not guess an answer; continue independent work and stop when only blocked work remains.".into())),
                Err(error) => return Err(Failure::Defect(format!("{error:?}"))),
            };
            let state = tokio::select! { biased; _ = context.cancellation.cancelled() => return Err(Failure::Cancelled), state = wait => state.map_err(|_| Failure::Cancelled)? };
            if let Some(error) = self.forms.failure(&form_id) {
                if matches!(error, FormError::ReviewFull { .. }) {
                    return Ok(unanswered(questions.len(), "reviewFull", JsonValue::Bool(true), None, "The user's review box is full, so this question was not recorded. Do not guess an answer; continue independent work and stop when only blocked work remains.".into()));
                }
                return Err(Failure::Defect(format!("{error:?}")));
            }
            let settlement = || {
                self.forms
                    .settlement(&form_id)
                    .map_err(|error| Failure::Defect(format!("{error:?}")))
            };
            let answer = match state {
                form::State::Answered(answer) => answer,
                form::State::TimedOut { .. } => return Err(Failure::Cancelled),
                form::State::Deferred { item_id } => {
                    return Ok(unanswered(
                        questions.len(),
                        "deferredItemID",
                        ycoding_schema::DomainEncode::encode(&item_id),
                        settlement()?.assessment.as_ref(),
                        format!(
                            "Defer is on. These questions were added to the user's review box as item {}; the answer will arrive later as a user message. Do not guess the answer or act as if it were given. Continue with work that does not depend on it; if nothing else remains, summarize what waits on the user and stop.",
                            item_id.as_lossless().to_utf8().unwrap_or_default()
                        ),
                    ));
                }
                _ => return Err(Failure::Defect("The user dismissed this question".into())),
            };
            let settlement = settlement()?;
            let automatic = settlement.automatic.is_some();
            let answers = questions
                .iter()
                .enumerate()
                .map(
                    |(index, _)| match answer.0.get(&format!("q{index}").as_str().into()) {
                        None => Vec::new(),
                        Some(JsonValue::Array(items)) => items
                            .iter()
                            .filter_map(|value| {
                                if let JsonValue::String(text) = value {
                                    Some(text.clone())
                                } else {
                                    None
                                }
                            })
                            .collect(),
                        Some(JsonValue::String(text)) => vec![text.clone()],
                        Some(value) => vec![ycoding_schema::stringify_json(value).into()],
                    },
                )
                .collect::<Vec<_>>();
            let formatted = questions
                .iter()
                .zip(&answers)
                .map(|(question, answer)| {
                    format!(
                        "\"{}\"=\"{}\"",
                        question.question.to_utf8().unwrap_or_default(),
                        if answer.is_empty() {
                            "Unanswered".into()
                        } else {
                            answer
                                .iter()
                                .map(|value| value.to_utf8().unwrap_or_default())
                                .collect::<Vec<_>>()
                                .join(", ")
                        }
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            Ok(output(
                ObjectEncoder::new()
                    .field("answers", &answers)
                    .optional("automatic", &automatic.then_some(true))
                    .optional(
                        "via",
                        &settlement
                            .automatic
                            .as_ref()
                            .map(|automatic| LosslessString::from(automatic.via)),
                    )
                    .optional(
                        "confidence",
                        &settlement
                            .automatic
                            .as_ref()
                            .and_then(|automatic| automatic.confidence),
                    )
                    .optional(
                        "assessment",
                        &settlement.assessment.as_ref().map(DomainEncode::encode),
                    )
                    .optional(
                        "source",
                        &settlement.source.as_ref().map(DomainEncode::encode),
                    )
                    .finish(),
                if let Some(source) = &settlement.source
                    && let Some(text) = source_text(source, &formatted)
                {
                    text
                } else if automatic {
                    format!(
                        "Answers were selected automatically, not provided or approved by the user: {formatted}. Continue independent work within the authorized scope and follow the active goal when one exists. Do not reopen routine choices or treat an automatic selection to wait as a new user instruction or authorization constraint. Permissions and guardrails still apply."
                    )
                } else {
                    format!(
                        "User has answered your questions: {formatted}. You can now continue with the user's answers in mind."
                    )
                },
            ))
        })
    }
}

fn source_text(source: &form::ReplySource, formatted: &str) -> Option<String> {
    let text = |name: &str| match source.0.get(&name.into()) {
        Some(JsonValue::String(text)) => text.as_str(),
        _ => None,
    };
    match text("kind")? {
        "dots-delegation" => Some(format!(
            "The delegated external client answered these questions under a native-approved Dots delegation: {formatted}. These answers grant no permission, consent, or explicit decision approval."
        )),
        "dots-client" => Some(format!(
            "The authenticated Dots client answered these questions: {formatted}. Answers do not approve a permission or guardrail request."
        )),
        "coordinator" if text("via") == Some("goal") => Some(format!(
            "The Goal agent answered these questions under the active goal from bounded task context: {formatted}. These answers grant no permission, consent, or explicit decision approval. This automatic answer is never a human reply."
        )),
        "coordinator" => Some(format!(
            "The native coordinator answered these questions{}: {formatted}. These answers grant no permission, consent, or explicit decision approval.",
            match text("via") {
                Some("yolo") => " through the Answers YOLO evaluator",
                Some("auto-answer") => " using deterministic Auto rules",
                _ => "",
            }
        )),
        _ => None,
    }
}

fn unanswered(
    count: usize,
    key: &str,
    value: JsonValue,
    assessment: Option<&form::Assessment>,
    message: String,
) -> ycoding_ai::llm::ToolOutput {
    output(
        ObjectEncoder::new()
            .field(
                "answers",
                &vec![Vec::<ycoding_schema::LosslessString>::new(); count],
            )
            .field(key, &value)
            .optional("assessment", &assessment.map(DomainEncode::encode))
            .finish(),
        message,
    )
}
