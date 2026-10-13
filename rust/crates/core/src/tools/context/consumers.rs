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

#[derive(Clone)]
pub struct SessionTools {
    pub subagent: Arc<dyn Tool>,
    pub subagent_control: Arc<dyn Tool>,
    pub subagent_report: Arc<dyn Tool>,
    pub goal: Arc<dyn Tool>,
    pub question: Arc<dyn Tool>,
    pub decision: Arc<dyn Tool>,
    pub todowrite: Arc<dyn Tool>,
    pub conversation_compact: Arc<crate::tools::builtin::conversation_compact::Advisor>,
    pub task_complete: Arc<dyn Tool>,
    subagent_adapter: Arc<crate::tools::builtin::subagent::Subagent>,
    orchestration: Arc<crate::session::orchestration::Service>,
}
pub struct SessionDependencies {
    pub subagent: crate::tools::builtin::subagent::Subagent,
    pub forms: crate::tools::policy::forms::Forms,
    pub decisions: Arc<crate::resources::decision::Service>,
    pub publish: crate::tools::policy::Publisher,
    pub compaction: crate::session::compaction_policy::Resolved,
}
impl SessionTools {
    pub fn new(dependencies: SessionDependencies) -> Self {
        use crate::tools::builtin::{
            decision::Decision, goal::Goal, question::Question, subagent_control::SubagentControl,
            subagent_report::SubagentReport, task_complete::TaskComplete, todowrite::TodoWrite,
        };
        let subagent = Arc::new(dependencies.subagent);
        Self {
            subagent: subagent.clone(),
            subagent_control: Arc::new(SubagentControl {
                orchestration: subagent.orchestration.clone(),
                policy: subagent.policy.clone(),
            }),
            subagent_report: Arc::new(SubagentReport {
                orchestration: subagent.orchestration.clone(),
                execution: subagent.execution.clone(),
                jobs: subagent.jobs.clone(),
            }),
            goal: Arc::new(Goal {
                autonomy: crate::session::autonomy::Service::new(subagent.store.client.clone()),
                policy: subagent.policy.clone(),
            }),
            question: Arc::new(Question {
                forms: dependencies.forms,
                policy: subagent.policy.clone(),
            }),
            decision: Arc::new(Decision {
                decisions: dependencies.decisions,
                policy: subagent.policy.clone(),
            }),
            todowrite: Arc::new(TodoWrite {
                store: subagent.store.clone(),
                policy: subagent.policy.clone(),
                publish: dependencies.publish,
            }),
            task_complete: Arc::new(TaskComplete),
            conversation_compact: Arc::new(
                crate::tools::builtin::conversation_compact::Advisor::new(
                    subagent.store.clone(),
                    dependencies.compaction,
                ),
            ),
            orchestration: subagent.orchestration.clone(),
            subagent_adapter: subagent,
        }
    }
    pub fn decorate(
        &self,
        context: &Context,
        definitions: &mut Vec<ycoding_ai::llm::ToolDefinition>,
    ) -> Result<(), Failure> {
        if !self
            .orchestration
            .managed(&context.session_id)
            .map_err(|error| Failure::message(error.to_string()))?
        {
            definitions.retain(|definition| definition.name.as_str() != Some("subagent_report"));
        }
        if let Some(subagent) = definitions
            .iter_mut()
            .find(|definition| definition.name.as_str() == Some("subagent"))
        {
            subagent.description = self.subagent_adapter.description_for(context)?;
        }
        Ok(())
    }
    pub fn entries(self) -> Vec<(String, Arc<dyn Tool>)> {
        vec![
            ("subagent".into(), self.subagent),
            ("subagent_control".into(), self.subagent_control),
            ("subagent_report".into(), self.subagent_report),
            ("goal".into(), self.goal),
            ("question".into(), self.question),
            ("decision".into(), self.decision),
            ("todowrite".into(), self.todowrite),
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
