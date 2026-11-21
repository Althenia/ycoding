pub mod consumers;
pub mod policy;
use crate::{session::usage_attribution::Attribution, tools::code_mode::Cancellation};
use std::{future::Future, pin::Pin, sync::Arc};
use ycoding_schema::{
    JsonObject, LosslessString, agent, llm::ToolContent, session, session_message,
};

pub type ProgressFuture = Pin<Box<dyn Future<Output = ()> + Send>>;
pub type ProgressSink = Arc<dyn Fn(Progress) -> ProgressFuture + Send + Sync>;
pub type InvocationFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
pub type InvocationSink =
    Arc<dyn Fn(ycoding_schema::tool_invocation::Settled) -> InvocationFuture + Send + Sync>;

#[derive(Clone, Debug, PartialEq)]
pub struct Progress {
    pub structured: JsonObject,
    pub content: Vec<ToolContent>,
}

#[derive(Clone)]
pub struct Context {
    pub session_id: session::Id,
    pub agent: agent::Id,
    pub message_id: session_message::Id,
    pub call_id: LosslessString,
    pub invocation_id: Option<LosslessString>,
    pub invocation_settled: Option<InvocationSink>,
    pub progress: Option<ProgressSink>,
    pub cancellation: Cancellation,
    pub attribution: Attribution,
}

impl Context {
    pub fn new(
        session_id: &str,
        agent: &str,
        message_id: &str,
        call_id: &str,
    ) -> Result<Self, ycoding_schema::DecodeError> {
        Ok(Self {
            session_id: session::Id::new(session_id)?,
            agent: agent.into(),
            message_id: session_message::Id::new(message_id)?,
            call_id: call_id.into(),
            invocation_id: None,
            invocation_settled: None,
            progress: None,
            cancellation: Cancellation::default(),
            attribution: Attribution::Unset,
        })
    }

    pub fn invocation_id(&self) -> &LosslessString {
        self.invocation_id.as_ref().unwrap_or(&self.call_id)
    }

    pub async fn report(&self, update: Progress) {
        if let Some(progress) = &self.progress {
            progress(update).await;
        }
    }
}
