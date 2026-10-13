pub mod consumers;
pub mod policy;
use crate::tools::code_mode::Cancellation;
use std::{future::Future, pin::Pin, sync::Arc};
use ycoding_schema::{
    JsonObject, LosslessString, agent, llm::ToolContent, session, session_message,
};

pub type ProgressFuture = Pin<Box<dyn Future<Output = ()> + Send>>;
pub type ProgressSink = Arc<dyn Fn(Progress) -> ProgressFuture + Send + Sync>;

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
    pub progress: Option<ProgressSink>,
    pub cancellation: Cancellation,
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
            progress: None,
            cancellation: Cancellation::default(),
        })
    }

    pub async fn report(&self, update: Progress) {
        if let Some(progress) = &self.progress {
            progress(update).await;
        }
    }
}
