use super::{
    native::definition,
    session_action::{decode, invalid, output, permit},
    subagent_control::failure,
};
use crate::{
    job::{self, Jobs},
    resources::{agent, config::Configuration},
    session::{
        execution,
        orchestration::{self, Preflight},
        run_coordinator::{Outcome, RunFuture},
        store,
    },
    tools::{
        context::{Context, Progress, policy::LeafPolicy},
        registry::{Failure, Tool, ToolFuture},
    },
};
use std::{future::Future, pin::Pin, sync::Arc, time::Duration};
use ycoding_ai::llm::ToolDefinition;
use ycoding_schema::{
    JsonValue, LosslessString, ObjectEncoder, model, schema::PositiveInt, session, session_message,
};

pub const DEFAULT_TIMEOUT_MS: u64 = 3_600_000;
pub const MAX_TIMEOUT_MS: u64 = 86_400_000;
pub const PROGRESS_PROMPT: &str = "Report current status, blockers, and ETA.";
pub const NO_TEXT: &str = "Subagent completed without a text response.";
pub trait Execution: Send + Sync {
    fn resume(&self, id: session::Id) -> RunFuture;
    fn interrupt(&self, id: session::Id) -> RunFuture;
    fn request_interrupt(&self, id: &session::Id) -> Outcome;
}
impl Execution for &'static execution::Execution {
    fn resume(&self, id: session::Id) -> RunFuture {
        let service = *self;
        Box::pin(async move { service.resume(&id).await })
    }
    fn interrupt(&self, id: session::Id) -> RunFuture {
        let service = *self;
        Box::pin(async move { service.interrupt(&id).await })
    }
    fn request_interrupt(&self, id: &session::Id) -> Outcome {
        execution::Execution::request_interrupt(self, id)
    }
}
pub type Activation =
    Arc<dyn Fn(Context, LosslessString) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;
pub struct Subagent {
    pub store: store::Service,
    pub orchestration: Arc<orchestration::Service>,
    pub preflight: Preflight,
    pub execution: Arc<dyn Execution>,
    pub policy: Arc<LeafPolicy>,
    pub jobs: Jobs,
    pub agents: Arc<agent::Service>,
    pub config: Arc<Configuration>,
    pub collator: Arc<crate::tools::code_mode::Collation>,
    pub activate: Activation,
}
impl Subagent {
    pub fn available_agents(
        &self,
        context: &Context,
    ) -> Result<Vec<ycoding_schema::agent::Info>, Failure> {
        let mut available = self
            .agents
            .list()
            .into_iter()
            .filter(|agent| agent.mode.as_str() != Some("primary") && !agent.hidden)
            .filter_map(|agent| {
                match self.policy.permissions.evaluate_effective(
                    &context.session_id,
                    Some(&context.agent),
                    &"subagent".into(),
                    &agent.id,
                ) {
                    Ok(crate::tools::policy::Effect::Deny) => None,
                    Ok(_) => Some(Ok(agent.clone())),
                    Err(error) => Some(Err(Failure::message(format!("{error:?}")))),
                }
            })
            .collect::<Result<Vec<_>, _>>()?;
        available.sort_by(|left, right| {
            (self.collator)(
                &left.id.code_units().collect::<Vec<_>>(),
                &right.id.code_units().collect::<Vec<_>>(),
            )
        });
        Ok(available)
    }
    pub fn description_for(&self, context: &Context) -> Result<LosslessString, Failure> {
        let base = self.definition("subagent").description;
        let agents = self.available_agents(context)?;
        if agents.is_empty() {
            return Ok(base);
        }
        Ok(format!(
            "{}\n\nAvailable subagents:\n{}",
            base.to_utf8().unwrap_or_default(),
            agents
                .iter()
                .map(|agent| format!(
                    "- {}: {}",
                    agent.id.to_utf8().unwrap_or_default(),
                    agent
                        .description
                        .as_ref()
                        .map(|description| description.to_utf8().unwrap_or_default())
                        .unwrap_or_else(|| {
                            "This subagent should only be called when explicitly requested.".into()
                        })
                ))
                .collect::<Vec<_>>()
                .join("\n")
        )
        .into())
    }
}
impl Tool for Subagent {
    fn definition(&self, name: &str) -> ToolDefinition {
        definition(name, include_str!("subagent.tool.json"))
    }
    fn permission(&self) -> Option<&str> {
        None
    }
    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            let JsonValue::Object(raw) = &input else {
                return Err(Failure::message("Invalid subagent launch input"));
            };
            if raw.iter().any(|(key, _)| {
                !matches!(
                    key.as_str(),
                    Some("agent" | "description" | "prompt" | "background" | "model" | "timeout")
                )
            }) {
                return Err(Failure::message("Invalid subagent launch input"));
            }
            let fields = decode(&input)?;
            let agent: LosslessString = fields.field("agent").map_err(invalid)?;
            let description: LosslessString = fields.field("description").map_err(invalid)?;
            let prompt: LosslessString = fields.field("prompt").map_err(invalid)?;
            let _: Option<bool> = fields.optional("background").map_err(invalid)?;
            let selected: Option<model::Ref> = fields.optional("model").map_err(invalid)?;
            if let Some(JsonValue::Object(model)) = raw.get(&"model".into())
                && model.iter().any(|(key, _)| {
                    !matches!(
                        key.as_str(),
                        Some("id" | "providerID" | "variant" | "profile")
                    )
                })
            {
                return Err(Failure::message("Invalid subagent launch input"));
            }
            let timeout = fields
                .optional::<PositiveInt>("timeout")
                .map_err(invalid)?
                .map_or(DEFAULT_TIMEOUT_MS, |timeout| timeout.get() as u64);
            if timeout > MAX_TIMEOUT_MS
                || description.code_units().count() > 4096
                || prompt.code_units().count() > 65536
                || description.to_utf8().unwrap_or_default().len() > 4096
                || prompt.to_utf8().unwrap_or_default().len() > 65536
            {
                return Err(Failure::message("Invalid subagent launch input"));
            }
            if context.cancellation.is_cancelled() {
                return Err(Failure::Cancelled);
            }
            let limit = match self.config.latest("experimental") {
                Some(JsonValue::Object(value)) => value
                    .get(&"subagent_depth".into())
                    .and_then(|value| {
                        if let JsonValue::Number(number) = value {
                            Some(*number as usize)
                        } else {
                            None
                        }
                    })
                    .unwrap_or(1),
                _ => 1,
            };
            if self
                .orchestration
                .depth(&context.session_id)
                .map_err(failure)?
                >= limit
            {
                return Err(Failure::message(format!(
                    "Subagent depth limit reached ({limit}). Increase \"experimental.subagent_depth\" to allow nested subagents."
                )));
            }
            let prepared = self
                .preflight
                .prepare(
                    &context.session_id,
                    &orchestration::PreflightRequest {
                        agent: agent.clone(),
                        model: selected,
                        caller: Some(context.agent.clone()),
                    },
                )
                .map_err(failure)?;
            let target = prepared.agent.to_utf8().unwrap_or_default();
            permit(
                &self.policy,
                &context,
                "subagent",
                &target,
                true,
                &format!("Subagent denied: {target}"),
            )
            .await?;
            if context.cancellation.is_cancelled() {
                return Err(Failure::Cancelled);
            }
            let child = self
                .orchestration
                .launch_attributed(
                    orchestration::LaunchInput {
                        parent_id: context.session_id.clone(),
                        parent_assistant_message_id: context.message_id.clone(),
                        tool_call_id: context.call_id.to_utf8().unwrap_or_default(),
                        description: description.to_utf8().unwrap_or_default(),
                        prompt: prompt.to_utf8().unwrap_or_default(),
                        depth_limit: limit,
                        prepared,
                        guardrails: self.policy.guardrails.clone(),
                    },
                    &context.cancellation,
                    &context.attribution,
                )
                .await
                .map_err(failure)?;
            if context.cancellation.is_cancelled() {
                self.orchestration
                    .cancel(&context.session_id, &child.session_id)
                    .await
                    .map_err(failure)?;
                return Err(Failure::Cancelled);
            }
            if let Some(source) = self.store.artifact_source() {
                use crate::resources::project_artifact::source::{
                    ActivationInput, ActivationSource,
                };
                use ycoding_schema::DomainDecode;
                if source
                    .activate(ActivationInput {
                        kind: ycoding_schema::project_artifact::Kind::decode(&JsonValue::String(
                            "agent".into(),
                        ))
                        .expect("fixed kind"),
                        id: agent.clone(),
                        session_id: context.session_id.clone(),
                        agent_id: Some(agent.clone()),
                        source: ActivationSource::SubagentLaunch {
                            message_id: context.message_id.as_lossless().clone(),
                            call_id: Some(context.call_id.clone()),
                        },
                    })
                    .is_err()
                {
                    source.record_activation_failure();
                }
            }
            (self.activate)(context.clone(), agent).await;
            let JsonValue::Object(structured) = ObjectEncoder::new()
                .field("sessionID", &child.session_id)
                .field("status", "running")
                .finish()
            else {
                unreachable!()
            };
            context
                .report(Progress {
                    structured,
                    content: vec![],
                })
                .await;
            if context.cancellation.is_cancelled() {
                self.orchestration
                    .cancel(&context.session_id, &child.session_id)
                    .await
                    .map_err(failure)?;
                return Err(Failure::Cancelled);
            }
            let store = self.store.clone();
            let orchestration = self.orchestration.clone();
            let execution = self.execution.clone();
            let id = child.session_id.clone();
            let parent = context.session_id.clone();
            let attribution = context.attribution.clone();
            let job_id = id.as_lossless().to_utf8().unwrap_or_default();
            let jobs = self.jobs.clone();
            let started = self.jobs.start(job::StartInput {id: Some(job_id.clone()), kind: "subagent".into(), title: Some(description.to_utf8().unwrap_or_default()), metadata: Some(serde_json::Map::new()), run: Box::pin(async move {
                let mut guard = RunningChild {execution: execution.clone(), orchestration: orchestration.clone(), id: id.clone(), armed: true};
                let interrupted = std::sync::atomic::AtomicBool::new(false);
                let run = async {
                    let progress = async {
                        loop {
                            tokio::time::sleep(Duration::from_secs(600)).await;
                            let message = session_message::Id::new(crate::platform::identifier("msg_").map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
                            orchestration.send_attributed(&parent, &id, &message, PROGRESS_PROMPT, "steer", &attribution).await.map_err(|error| error.to_string())?;
                        }
                    };
                    tokio::select! {
                        result = execution.resume(id.clone()) => result.map_err(|error| {if matches!(error, crate::session::run_coordinator::Error::Interrupted(_)) {interrupted.store(true, std::sync::atomic::Ordering::Relaxed);} error.to_string()}),
                        result = progress => result,
                    }?;
                    let latest = store.recent(&id, 20).map_err(|error| error.to_string())?.into_iter().rev().find_map(|message| match message { session_message::Info::Assistant(assistant) if assistant.time.completed.is_some() && assistant.error.is_none() => Some(crate::session::helper_generation::assistant_text(&assistant.content)), _ => None }).filter(|text| !text.is_empty()).unwrap_or_else(|| NO_TEXT.into());
                    orchestration.settle(&id, orchestration::Settlement::Completed {excerpt: Some(latest.chars().take(16384).collect())}).await.map_err(|error| error.to_string())?;
                    Ok::<_, String>(latest)
                };
                let outcome = tokio::time::timeout(Duration::from_millis(timeout), run).await.unwrap_or_else(|_| Err(format!("Subagent timed out after {timeout} ms.")));
                if interrupted.load(std::sync::atomic::Ordering::Relaxed) {
                    guard.armed = false;
                    jobs.mark_cancelled(id.as_lossless().as_str().unwrap_or_default());
                    return outcome;
                }
                if let Err(error) = &outcome {
                    let _ = execution.interrupt(id.clone()).await;
                    orchestration.settle(&id, orchestration::Settlement::Failed {error: error.clone(), excerpt: Some(error.chars().take(16384).collect())}).await.map_err(|error| error.to_string())?;
                }
                guard.armed = false;
                outcome
            })});
            if let Err(error) = started {
                let _ = self.execution.interrupt(child.session_id.clone()).await;
                self.orchestration
                    .settle(
                        &child.session_id,
                        orchestration::Settlement::Failed {
                            error: error.to_string(),
                            excerpt: Some(error.to_string()),
                        },
                    )
                    .await
                    .map_err(failure)?;
                return Err(Failure::message(error.to_string()));
            }
            self.jobs
                .background(&job_id)
                .ok_or_else(|| Failure::message("Job not found"))?;
            let text = format!(
                "Subagent launched (id: {job_id}). Completion notifications are delivered automatically. Do not poll status or wait with sleep or no-op commands. Do not mention the launch or any running, completed, failed, or total status unless the user explicitly asks for subagent status."
            );
            Ok(output(
                ObjectEncoder::new()
                    .field("sessionID", &child.session_id)
                    .field("status", "running")
                    .field("output", text.as_str())
                    .finish(),
                text,
            ))
        })
    }
}
struct RunningChild {
    execution: Arc<dyn Execution>,
    orchestration: Arc<orchestration::Service>,
    id: session::Id,
    armed: bool,
}
impl Drop for RunningChild {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.execution.request_interrupt(&self.id);
        }
        self.orchestration.release_reservation(&self.id);
    }
}
