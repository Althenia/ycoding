use super::{
    filesystem::Paths,
    native::{CallPolicy, definition, output, to_json, to_serde},
};
use crate::{
    platform::interaction::{Authority, boundary},
    tools::{
        context::{Context, policy::LeafPolicy},
        registry::{Failure, Tool, ToolFuture},
    },
};
use std::sync::Arc;
use ycoding_ai::llm::ToolDefinition;
use ycoding_schema::JsonValue;

pub struct Interaction {
    pub authority: Arc<Authority>,
    pub paths: Arc<Paths>,
    pub policy: Arc<LeafPolicy>,
}
impl Tool for Interaction {
    fn definition(&self, name: &str) -> ToolDefinition {
        definition(name, include_str!("interaction.tool.json"))
    }
    fn permission(&self) -> Option<&str> {
        None
    }
    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            let input = to_serde(&input)?;
            let policy = CallPolicy {
                policy: self.policy.clone(),
                paths: self.paths.clone(),
                context: context.clone(),
            };
            let mut call = policy.call()?;
            call.owner.call_id = context
                .invocation_id()
                .to_utf8()
                .map_err(|_| Failure::message("Invalid tool call identity"))?;
            let result = tokio::select! {result=boundary::execute(&self.authority,&policy,&call,input)=>result.map_err(Failure::message)?,()=context.cancellation.cancelled()=>return Err(Failure::Cancelled)};
            Ok(output(
                to_json(&result)?,
                vec![serde_json::json!({"type":"text","text":result.to_string()})],
            ))
        })
    }
}
