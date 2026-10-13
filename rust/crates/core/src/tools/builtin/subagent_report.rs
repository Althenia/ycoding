use super::{
    native::definition,
    session_action::{invalid, output},
    subagent::Execution,
    subagent_control::failure,
};
use crate::{
    job::Jobs,
    session::orchestration,
    tools::{
        context::Context,
        registry::{Failure, Tool, ToolFuture},
    },
};
use std::sync::Arc;
use ycoding_ai::llm::ToolDefinition;
use ycoding_schema::{DomainDecode, JsonValue, ObjectEncoder, session_orchestration::Report};

pub struct SubagentReport {
    pub orchestration: Arc<orchestration::Service>,
    pub execution: Arc<dyn Execution>,
    pub jobs: Jobs,
}
impl Tool for SubagentReport {
    fn definition(&self, name: &str) -> ToolDefinition {
        definition(name, include_str!("subagent-report.tool.json"))
    }
    fn permission(&self) -> Option<&str> {
        None
    }
    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            let input = Report::decode(&input).map_err(invalid)?;
            if context.cancellation.is_cancelled() {
                return Err(Failure::Cancelled);
            }
            let result = match input {
                Report::Progress { text } => ObjectEncoder::new()
                    .field("action", "progress")
                    .field(
                        "task",
                        &self
                            .orchestration
                            .progress(&context.session_id, &text.to_utf8().unwrap_or_default())
                            .await
                            .map_err(failure)?,
                    )
                    .finish(),
                Report::Question { text, data } => {
                    let asked = self
                        .orchestration
                        .question(
                            &context.session_id,
                            &text.to_utf8().unwrap_or_default(),
                            data,
                        )
                        .await
                        .map_err(failure)?;
                    if !asked.auto_answered {
                        self.jobs
                            .background(
                                context
                                    .session_id
                                    .as_lossless()
                                    .as_str()
                                    .unwrap_or_default(),
                            )
                            .ok_or_else(|| Failure::message("Job not found"))?;
                        self.execution
                            .request_interrupt(&context.session_id)
                            .map_err(|error| Failure::message(error.to_string()))?;
                    }
                    ObjectEncoder::new()
                        .field("action", "question")
                        .field("question", &asked.question)
                        .finish()
                }
            };
            Ok(output(
                result.clone(),
                ycoding_schema::stringify_json(&result),
            ))
        })
    }
}
