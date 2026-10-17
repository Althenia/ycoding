use super::{
    native::definition,
    session_action::{invalid, output, permit},
};
use crate::{
    session::orchestration,
    tools::{
        context::{Context, policy::LeafPolicy},
        registry::{Failure, Tool, ToolFuture},
    },
};
use std::sync::Arc;
use ycoding_ai::llm::ToolDefinition;
use ycoding_schema::{
    DomainDecode, JsonValue, ObjectEncoder, session_delivery::Delivery,
    session_orchestration::Control,
};

pub struct SubagentControl {
    pub orchestration: Arc<orchestration::Service>,
    pub policy: Arc<LeafPolicy>,
}
impl Tool for SubagentControl {
    fn definition(&self, name: &str) -> ToolDefinition {
        definition(name, include_str!("subagent-control.tool.json"))
    }
    fn permission(&self) -> Option<&str> {
        None
    }
    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            let input = Control::decode(&input).map_err(invalid)?;
            if context.cancellation.is_cancelled() {
                return Err(Failure::Cancelled);
            }
            if let Control::List = input {
                let result = ObjectEncoder::new()
                    .field("action", "list")
                    .field(
                        "tasks",
                        &self
                            .orchestration
                            .list(&context.session_id)
                            .map_err(failure)?,
                    )
                    .finish();
                return Ok(output(
                    result.clone(),
                    ycoding_schema::stringify_json(&result),
                ));
            }
            let id = match &input {
                Control::Send { session_id, .. }
                | Control::Answer { session_id, .. }
                | Control::Cancel { session_id }
                | Control::Resume { session_id } => session_id,
                Control::List => unreachable!(),
            };
            let target = self
                .orchestration
                .get(&context.session_id, id)
                .map_err(failure)?;
            let agent = target
                .agent
                .to_utf8()
                .map_err(|_| Failure::Defect("Agent identifier is not UTF-8".into()))?;
            permit(
                &self.policy,
                &context,
                "subagent",
                &agent,
                true,
                &format!("Subagent denied: {agent}"),
            )
            .await?;
            if context.cancellation.is_cancelled() {
                return Err(Failure::Cancelled);
            }
            let (action, task) = match input {
                Control::Send {
                    session_id,
                    text,
                    delivery,
                } => {
                    let message = orchestration::send_message_id(
                        &context
                            .session_id
                            .as_lossless()
                            .to_utf8()
                            .unwrap_or_default(),
                        &context
                            .message_id
                            .as_lossless()
                            .to_utf8()
                            .unwrap_or_default(),
                        &context.call_id.to_utf8().unwrap_or_default(),
                    );
                    (
                        "send",
                        self.orchestration
                            .send_attributed(
                                &context.session_id,
                                &session_id,
                                &message,
                                &text.to_utf8().unwrap_or_default(),
                                match delivery {
                                    Delivery::Steer => "steer",
                                    Delivery::Queue => "queue",
                                },
                                &context.attribution,
                            )
                            .await,
                    )
                }
                Control::Answer {
                    session_id,
                    question_id,
                    text,
                    data,
                } => (
                    "answer",
                    self.orchestration
                        .answer_attributed(
                            &context.session_id,
                            &session_id,
                            &question_id,
                            text.as_ref().and_then(|text| text.as_str()),
                            data,
                            &context.attribution,
                        )
                        .await,
                ),
                Control::Cancel { session_id } => (
                    "cancel",
                    self.orchestration
                        .cancel(&context.session_id, &session_id)
                        .await,
                ),
                Control::Resume { session_id } => (
                    "resume",
                    self.orchestration
                        .resume(&context.session_id, &session_id)
                        .await,
                ),
                Control::List => unreachable!(),
            };
            let result = ObjectEncoder::new()
                .field("action", action)
                .field("task", &task.map_err(failure)?)
                .finish();
            Ok(output(
                result.clone(),
                ycoding_schema::stringify_json(&result),
            ))
        })
    }
}
pub(super) fn failure(error: orchestration::Error) -> Failure {
    if matches!(error, orchestration::Error::Cancelled) {
        return Failure::Cancelled;
    }
    Failure::message(error.to_string())
}
