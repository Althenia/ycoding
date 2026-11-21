use super::{
    native::definition,
    session_action::{decode, output},
};
use crate::tools::{
    context::Context,
    registry::{Tool, ToolFuture},
};
use ycoding_ai::llm::ToolDefinition;
use ycoding_schema::{JsonValue, ObjectEncoder};

pub struct TaskComplete;
impl Tool for TaskComplete {
    fn definition(&self, name: &str) -> ToolDefinition {
        definition(name, include_str!("task-complete.tool.json"))
    }
    fn permission(&self) -> Option<&str> {
        None
    }
    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            decode(&input)?;
            if context.cancellation.is_cancelled() {
                return Err(crate::tools::registry::Failure::Cancelled);
            }
            Ok(output(
                ObjectEncoder::new().field("recorded", &true).finish(),
                "Completion declaration recorded. Final reply settlement is still pending.",
            ))
        })
    }
}
