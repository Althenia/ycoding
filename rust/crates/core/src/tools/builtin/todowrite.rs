use super::{
    native::definition,
    session_action::{decode, invalid, output, permit},
};
use crate::{
    session::store,
    tools::{
        context::{Context, policy::LeafPolicy},
        policy::{Event, Publisher},
        registry::{Failure, Tool, ToolFuture},
    },
};
use std::sync::Arc;
use ycoding_ai::llm::ToolDefinition;
use ycoding_schema::{DomainEncode, JsonValue, ObjectEncoder, session_todo};

pub struct TodoWrite {
    pub store: store::Service,
    pub policy: Arc<LeafPolicy>,
    pub publish: Publisher,
}
impl Tool for TodoWrite {
    fn definition(&self, name: &str) -> ToolDefinition {
        definition(name, include_str!("todowrite.tool.json"))
    }
    fn permission(&self) -> Option<&str> {
        None
    }
    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            let todos: Vec<session_todo::Info> = decode(&input)?.field("todos").map_err(invalid)?;
            permit(
                &self.policy,
                &context,
                "todowrite",
                "*",
                true,
                "Unable to update todos",
            )
            .await?;
            if context.cancellation.is_cancelled() {
                return Err(Failure::Cancelled);
            }
            self.store
                .update_todos(&context.session_id, &todos)
                .await
                .map_err(|error| Failure::Defect(error.to_string()))?;
            (self.publish)(Event {
                type_: "todo.updated",
                data: ObjectEncoder::new()
                    .field("sessionID", &context.session_id)
                    .field("todos", &todos)
                    .finish(),
            })
            .map_err(Failure::Defect)?;
            let pretty = serde_json::to_string_pretty(
                &serde_json::from_str::<serde_json::Value>(&ycoding_schema::stringify_json(
                    &todos.encode(),
                ))
                .map_err(|error| Failure::Defect(error.to_string()))?,
            )
            .map_err(|error| Failure::Defect(error.to_string()))?;
            Ok(output(
                ObjectEncoder::new().field("todos", &todos).finish(),
                pretty,
            ))
        })
    }
}
