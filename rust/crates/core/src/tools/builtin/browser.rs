use super::{
    filesystem::Paths,
    native::{CallPolicy, definition, output},
};
use crate::{
    platform::browser::boundary::{self, Isolated, Paired, Services},
    tools::{
        context::{Context, policy::LeafPolicy},
        registry::{Failure, Tool, ToolFuture},
    },
};
use std::sync::Arc;
use ycoding_ai::llm::ToolDefinition;
use ycoding_schema::JsonValue;

pub struct Browser {
    pub paired: Arc<dyn Paired>,
    pub isolated: Option<Arc<dyn Isolated>>,
    pub paths: Arc<Paths>,
    pub policy: Arc<LeafPolicy>,
}

impl Tool for Browser {
    fn definition(&self, name: &str) -> ToolDefinition {
        definition(name, include_str!("browser.tool.json"))
    }

    fn permission(&self) -> Option<&str> {
        None
    }

    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            let input = boundary::decode_input(&input).map_err(Failure::message)?;
            let policy = CallPolicy {
                policy: self.policy.clone(),
                paths: self.paths.clone(),
                context: context.clone(),
            };
            let call = policy.call()?;
            let services = Services {
                paired: self.paired.as_ref(),
                isolated: self.isolated.as_deref(),
            };
            let structured = tokio::select! {
                result = boundary::execute(services, &policy, &call, input) => result.map_err(Failure::message)?,
                () = context.cancellation.cancelled() => return Err(Failure::Cancelled),
            };
            let parts = boundary::model_output(&structured);
            Ok(output(structured, parts))
        })
    }
}
