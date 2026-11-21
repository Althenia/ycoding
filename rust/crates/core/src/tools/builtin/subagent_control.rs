use super::{
    native::definition,
    session_action::{invalid, output, permit},
};
use crate::{
    session::orchestration,
    tools::{
        context::{Context, policy::LeafPolicy},
        registry::{Failure, Tool, ToolFuture},
    },
};
use std::sync::Arc;
use ycoding_ai::llm::ToolDefinition;
use ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, ObjectEncoder, session_delivery::Delivery,
    session_orchestration::Control,
};

pub struct SubagentControl {
    pub orchestration: Arc<orchestration::Service>,
    pub policy: Arc<LeafPolicy>,
    pub switch: Arc<orchestration::ModelSwitch>,
}
impl Tool for SubagentControl {
    fn definition(&self, name: &str) -> ToolDefinition {
        definition(name, include_str!("subagent-control.tool.json"))
    }
    fn permission(&self) -> Option<&str> {
        None
    }
    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            let input = Control::decode(&input).map_err(invalid)?;
            if context.cancellation.is_cancelled() {
                return Err(Failure::Cancelled);
            }
            if let Control::List = input {
                let result = ObjectEncoder::new()
                    .field("action", "list")
                    .field(
                        "tasks",
                        &self
                            .orchestration
                            .list(&context.session_id)
                            .map_err(failure)?,
                    )
                    .finish();
                return Ok(output(
                    result.clone(),
                    ycoding_schema::stringify_json(&result),
                ));
            }
            let id = match &input {
                Control::Send { session_id, .. }
                | Control::Answer { session_id, .. }
                | Control::Cancel { session_id }
                | Control::Resume { session_id }
                | Control::SwitchModel { session_id, .. } => session_id,
                Control::List => unreachable!(),
            };
            let target = self
                .orchestration
                .get(&context.session_id, id)
                .map_err(|error| {
                    if matches!(input, Control::SwitchModel { .. }) {
                        switch_failure(id, error)
                    } else {
                        failure(error)
                    }
                })?;
            let agent = target
                .agent
                .to_utf8()
                .map_err(|_| Failure::Defect("Agent identifier is not UTF-8".into()))?;
            if let Control::SwitchModel {
                session_id,
                expected_model,
                model,
            } = &input
            {
                let policy = self.policy.clone();
                let authorize_context = context.clone();
                let authorize_agent = agent.clone();
                let authorize: orchestration::SwitchAuthorize<'_> = Box::pin(async move {
                    permit(
                        &policy,
                        &authorize_context,
                        "subagent",
                        &authorize_agent,
                        true,
                        &format!("Subagent denied: {authorize_agent}"),
                    )
                    .await
                    .map_err(|denied| match denied {
                        Failure::Cancelled => orchestration::Error::Cancelled,
                        Failure::Defect(message) => orchestration::Error::Authorization(message),
                        Failure::Tool { message, .. } => {
                            orchestration::Error::Authorization(message)
                        }
                    })
                });
                let permitted_policy = self.policy.clone();
                let parent = context.session_id.clone();
                let source_agent = context.agent.clone();
                let action: LosslessString = "subagent".into();
                let resource: LosslessString = agent.clone().into();
                let task = self
                    .orchestration
                    .switch_model(orchestration::SwitchModel {
                        parent_id: &context.session_id,
                        child_id: session_id,
                        expected_model,
                        model,
                        resolver: &self.switch,
                        authorize: Some(tokio::sync::Mutex::new(authorize)),
                        permitted: Some(Arc::new(move || {
                            matches!(
                                permitted_policy.permissions.evaluate_effective(
                                    &parent,
                                    Some(&source_agent),
                                    &action,
                                    &resource,
                                ),
                                Ok(effect)
                                    if effect != crate::tools::policy::Effect::Deny
                            )
                        })),
                    })
                    .await
                    .map_err(|error| switch_failure(session_id, error))?;
                let result = ObjectEncoder::new()
                    .field("action", "switch_model")
                    .field("task", &task)
                    .finish();
                return Ok(output(
                    result.clone(),
                    ycoding_schema::stringify_json(&result),
                ));
            }
            permit(
                &self.policy,
                &context,
                "subagent",
                &agent,
                true,
                &format!("Subagent denied: {agent}"),
            )
            .await?;
            if context.cancellation.is_cancelled() {
                return Err(Failure::Cancelled);
            }
            let (action, task) = match input {
                Control::Send {
                    session_id,
                    text,
                    delivery,
                } => {
                    let message = orchestration::send_message_id(
                        &context
                            .session_id
                            .as_lossless()
                            .to_utf8()
                            .unwrap_or_default(),
                        &context
                            .message_id
                            .as_lossless()
                            .to_utf8()
                            .unwrap_or_default(),
                        &context.invocation_id().to_utf8().unwrap_or_default(),
                    );
                    (
                        "send",
                        self.orchestration
                            .send_attributed(
                                &context.session_id,
                                &session_id,
                                &message,
                                &text.to_utf8().unwrap_or_default(),
                                match delivery {
                                    Delivery::Steer => "steer",
                                    Delivery::Queue => "queue",
                                },
                                &context.attribution,
                            )
                            .await,
                    )
                }
                Control::Answer {
                    session_id,
                    question_id,
                    text,
                    data,
                } => (
                    "answer",
                    self.orchestration
                        .answer_attributed(
                            &context.session_id,
                            &session_id,
                            &question_id,
                            text.as_ref().and_then(|text| text.as_str()),
                            data,
                            &context.attribution,
                        )
                        .await,
                ),
                Control::Cancel { session_id } => (
                    "cancel",
                    self.orchestration
                        .cancel(&context.session_id, &session_id)
                        .await,
                ),
                Control::Resume { session_id } => (
                    "resume",
                    self.orchestration
                        .resume(&context.session_id, &session_id)
                        .await,
                ),
                Control::List | Control::SwitchModel { .. } => unreachable!(),
            };
            let result = ObjectEncoder::new()
                .field("action", action)
                .field("task", &task.map_err(failure)?)
                .finish();
            Ok(output(
                result.clone(),
                ycoding_schema::stringify_json(&result),
            ))
        })
    }
}
pub(super) fn failure(error: orchestration::Error) -> Failure {
    if matches!(error, orchestration::Error::Cancelled) {
        return Failure::Cancelled;
    }
    Failure::message(error.to_string())
}

fn switch_failure(
    child_id: &ycoding_schema::session_id::SessionId,
    error: orchestration::Error,
) -> Failure {
    match error {
        orchestration::Error::Cancelled => Failure::Cancelled,
        orchestration::Error::Forbidden { .. } => Failure::message(format!(
            "Model selection for child {} was rejected: the child is not a direct managed child of this Session.",
            child_id.as_lossless().to_utf8().unwrap_or_default()
        )),
        orchestration::Error::Authorization(_) => Failure::message(
            "Provider authorization failed for the selected model; reconnect the provider profile and retry",
        ),
        error => failure(error),
    }
}
