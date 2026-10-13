use super::{
    filesystem::Paths,
    native::{CallPolicy, definition, output, to_json, to_serde},
};
use crate::{
    platform::computer::{boundary, service::Service},
    tools::{
        context::{Context, policy::LeafPolicy},
        registry::{Failure, Tool, ToolFuture},
    },
};
use std::sync::Arc;
use ycoding_ai::llm::ToolDefinition;
use ycoding_schema::JsonValue;

pub struct Computer {
    pub service: Arc<Service>,
    pub paths: Arc<Paths>,
    pub policy: Arc<LeafPolicy>,
}

impl Tool for Computer {
    fn definition(&self, name: &str) -> ToolDefinition {
        definition(name, include_str!("computer.tool.json"))
    }

    fn permission(&self) -> Option<&str> {
        None
    }

    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            let input = boundary::decode_input(&to_serde(&input)?).map_err(Failure::message)?;
            let policy = CallPolicy {
                policy: self.policy.clone(),
                paths: self.paths.clone(),
                context: context.clone(),
            };
            let call = policy.call()?;
            let result = tokio::select! {
                result = boundary::execute(&self.service, &policy, &call, input) => result.map_err(Failure::message)?,
                () = context.cancellation.cancelled() => return Err(Failure::Cancelled),
            };
            Ok(output(to_json(&result)?, boundary::model_output(&result)))
        })
    }
}
