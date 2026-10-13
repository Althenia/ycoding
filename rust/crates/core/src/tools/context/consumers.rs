use super::Context;
use crate::tools::registry::{Failure, Tool};
use std::{future::Future, path::PathBuf, pin::Pin, sync::Arc};
use ycoding_schema::{LosslessString, mcp_skill, skill};

pub type ConsumerFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, Failure>> + Send + 'a>>;

pub trait ReadInstructions: Send + Sync {
    fn load(&self, context: Context, paths: Vec<PathBuf>) -> ConsumerFuture<'_, ()>;
}

#[derive(Clone)]
pub struct ActiveSkill {
    pub id: skill::Id,
    pub name: skill::Name,
    pub entry: Option<mcp_skill::Entry>,
}
pub trait SkillHistory: Send + Sync {
    fn active(
        &self,
        context: Context,
        id: LosslessString,
    ) -> ConsumerFuture<'_, Option<ActiveSkill>>;
}

pub struct SessionTools {
    pub subagent: Arc<dyn Tool>,
    pub subagent_control: Arc<dyn Tool>,
    pub subagent_report: Arc<dyn Tool>,
    pub goal: Arc<dyn Tool>,
    pub question: Arc<dyn Tool>,
    pub decision: Arc<dyn Tool>,
    pub todowrite: Arc<dyn Tool>,
    pub conversation_compact: Arc<dyn Tool>,
    pub task_complete: Arc<dyn Tool>,
}
impl SessionTools {
    pub fn entries(self) -> Vec<(String, Arc<dyn Tool>)> {
        vec![
            ("subagent".into(), self.subagent),
            ("subagent_control".into(), self.subagent_control),
            ("subagent_report".into(), self.subagent_report),
            ("goal".into(), self.goal),
            ("question".into(), self.question),
            ("decision".into(), self.decision),
            ("todowrite".into(), self.todowrite),
            ("conversation_compact".into(), self.conversation_compact),
            ("task_complete".into(), self.task_complete),
        ]
    }
}
pub struct ControlTools {
    pub browser: Arc<dyn Tool>,
    pub computer: Arc<dyn Tool>,
}
impl ControlTools {
    pub fn entries(self) -> Vec<(String, Arc<dyn Tool>)> {
        vec![
            ("browser".into(), self.browser),
            ("computer".into(), self.computer),
        ]
    }
}
