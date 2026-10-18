use super::{
    autonomy::{self, SteerFuture, SteerRequest},
    helper_generation::{Generate, Request, assistant_text, tail, trim, units},
    store,
};
use crate::{
    process::guardrails::is_whitespace,
    resources::agent,
    tools::{code_mode::Cancellation, policy::helper::Role},
};
use std::{string::FromUtf16Error, sync::Arc};
use ycoding_schema::{DomainDecode, location, parse_json, permission, session, session_message};

pub fn agent() -> ycoding_schema::agent::Info {
    let mut info = agent::empty("goal".into());
    info.name = "Goal".into();
    info.mode = "primary".into();
    info.hidden = true;
    info.system = Some(agent::prompts::GOAL.into());
    info.permissions = vec![
        permission::Rule::decode(
            &parse_json(r#"{"action":"*","resource":"*","effect":"deny"}"#)
                .expect("static permission rule"),
        )
        .expect("static permission rule decodes"),
    ];
    info
}

#[derive(Clone)]
pub struct Environment {
    pub location: location::Ref,
    pub agents: Arc<agent::Service>,
    pub generate: Arc<dyn Generate>,
}

pub type Provider = Arc<dyn Fn(&location::Ref) -> Option<Environment> + Send + Sync>;

pub struct Service {
    store: store::Service,
    provider: Provider,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    ModelUnavailable,
    CalculationFailed,
    Interrupted,
}

impl Service {
    pub fn new(store: store::Service, provider: Provider) -> Self {
        Self { store, provider }
    }

    pub async fn synthesize(
        &self,
        session: &session::Info,
        text: &str,
        cancellation: &Cancellation,
    ) -> Result<String, Error> {
        self.generate(
            session,
            format!("Goal synthesis request:\n{text}"),
            cancellation,
        )
        .await
    }

    pub async fn start(
        &self,
        session: &session::Info,
        goal: &autonomy::Goal,
        cancellation: &Cancellation,
    ) -> Result<String, Error> {
        self.steer_request(
            session,
            SteerRequest {
                session_id: session.id.clone(),
                goal: goal.clone(),
                latest_assistant_text: None,
            },
            "start",
            cancellation,
        )
        .await
    }

    async fn steer_request(
        &self,
        session: &session::Info,
        request: SteerRequest,
        phase: &str,
        cancellation: &Cancellation,
    ) -> Result<String, Error> {
        let latest = match request.latest_assistant_text {
            Some(text) => Some(text),
            None => match self
                .store
                .latest(&request.session_id, "assistant")
                .map_err(|_| Error::CalculationFailed)?
            {
                Some(session_message::Info::Assistant(assistant)) => {
                    Some(assistant_text(&assistant.content))
                }
                _ => None,
            },
        };
        let latest = latest.map(|text| tail(&trim(&text), 2_000));
        let automatic = autonomy::Service::new(self.store.client.clone())
            .can_auto_answer(&session.id)
            .unwrap_or(false);
        self.generate(session, format!(
            "User-proxy steer request:\nActive goal: {}\nPhase: {phase}\nCurrent iteration: {}\nAutomatic answering: {}\nLatest assistant response: {}\nPreserve the active goal and produce only the next concise user-proxy steer.",
            request.goal.text.to_utf8().map_err(|_| Error::CalculationFailed)?,
            request.goal.iteration,
            if automatic { "enabled" } else { "disabled" },
            latest.as_deref().filter(|text| !text.is_empty()).unwrap_or("(none)"),
        ), cancellation).await
    }

    async fn generate(
        &self,
        session: &session::Info,
        request: String,
        cancellation: &Cancellation,
    ) -> Result<String, Error> {
        if cancellation.is_cancelled() {
            return Err(Error::Interrupted);
        }
        let environment = (self.provider)(&session.location).ok_or(Error::ModelUnavailable)?;
        if environment.location != session.location {
            return Err(Error::ModelUnavailable);
        }
        let agent = environment
            .agents
            .get(&"goal".into())
            .ok_or(Error::ModelUnavailable)?;
        if !environment.generate.resolves(session, Role::Goal, agent) {
            return Err(Error::ModelUnavailable);
        }
        let context = self
            .store
            .recent(&session.id, 12)
            .map_err(|_| Error::CalculationFailed)?
            .into_iter()
            .map(context_message)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| Error::CalculationFailed)?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("\n");
        let context = tail(&context, 6_000);
        let prompt = format!(
            "Recent conversation context:\n{}\n\n{request}",
            if context.is_empty() {
                "(none)"
            } else {
                &context
            },
        );
        let attribution =
            super::usage_attribution::entry(&self.store.client, session.id.as_lossless())
                .await
                .map_err(|_| Error::CalculationFailed)?;
        let _activity = super::usage_activity::contribute(
            &self.store.client,
            session.id.clone(),
            attribution.anchor().cloned(),
        );
        let output = environment
            .generate
            .generate(Request {
                session,
                role: Role::Goal,
                source: "goal",
                agent,
                user: prompt,
                character_limit: usize::MAX,
                cancellation,
                attribution,
            })
            .await;
        if cancellation.is_cancelled() {
            return Err(Error::Interrupted);
        }
        let output = output.ok_or(Error::CalculationFailed)?;
        let text = units(&output)
            .split(|unit| is_whitespace(*unit))
            .filter(|part| !part.is_empty())
            .map(String::from_utf16_lossy)
            .collect::<Vec<_>>()
            .join(" ");
        (!text.is_empty())
            .then_some(text)
            .ok_or(Error::CalculationFailed)
    }
}

impl autonomy::Steer for Service {
    fn steer(&self, request: SteerRequest) -> SteerFuture<'_> {
        Box::pin(async move {
            let session = self.store.get(&request.session_id).ok()??;
            self.steer_request(&session, request, "continue", &Cancellation::default())
                .await
                .ok()
        })
    }
}

fn context_message(message: session_message::Info) -> Result<Option<String>, FromUtf16Error> {
    Ok(match message {
        session_message::Info::User(user) => Some(format!("User: {}", user.text.to_utf8()?)),
        session_message::Info::Assistant(assistant) => Some(format!(
            "Assistant: {}",
            assistant
                .content
                .into_iter()
                .map(|part| match part {
                    session_message::AssistantContent::Text(text) => text.text.to_utf8().map(Some),
                    session_message::AssistantContent::Reasoning(reasoning) =>
                        reasoning.text.to_utf8().map(Some),
                    session_message::AssistantContent::Tool(tool)
                        if tool.name.as_str() == Some("question") =>
                    {
                        let session_message::ToolState::Completed(state) = tool.state else {
                            return Ok(None);
                        };
                        let origin = if state.structured.get(&"automatic".into())
                            == Some(&ycoding_schema::JsonValue::Bool(true))
                        {
                            "automatic"
                        } else {
                            "source unreported"
                        };
                        let questions = ycoding_schema::ObjectEncoder::new()
                            .optional("questions", &state.input.get(&"questions".into()).cloned())
                            .finish();
                        let answers = ycoding_schema::ObjectEncoder::new()
                            .optional("answers", &state.structured.get(&"answers".into()).cloned())
                            .finish();
                        Ok(Some(format!(
                            "Question details (bounded): {}\nQuestion tool result ({origin}): {}",
                            bounded_json(&questions),
                            bounded_json(&answers)
                        )))
                    }
                    _ => Ok(None),
                })
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join("\n")
        )),
        session_message::Info::System(message) => {
            Some(format!("Context: {}", message.text.to_utf8()?))
        }
        session_message::Info::Synthetic(message) => Some(format!(
            "Synthetic observation (not a human reply): {}",
            message.text.to_utf8()?
        )),
        session_message::Info::Skill(message) => {
            Some(format!("Context: {}", message.text.to_utf8()?))
        }
        _ => None,
    })
}

fn bounded_json(value: &ycoding_schema::JsonValue) -> String {
    let text = ycoding_schema::stringify_json(value);
    String::from_utf16_lossy(&text.encode_utf16().take(1_000).collect::<Vec<_>>())
}

#[cfg(test)]
mod context_tests {
    use super::*;

    #[test]
    fn completed_question_context_is_bounded_and_never_labels_automatic_choices_human() {
        let tool = |name: &str, automatic: bool| {
            serde_json::json!({
                "type":"tool", "id":format!("call_{name}"), "name":name,
                "time":{"created":1,"completed":2},
                "state":{"status":"completed","input":{"questions":[{"question":"Bounded choice","details":"x".repeat(2000)}]},"structured":{"answers":[["Continue independently"]],"automatic":automatic,"secret":"UNRELATED_STRUCTURED_PAYLOAD"},"content":[]}
            })
        };
        for automatic in [false, true] {
            let value = serde_json::json!({"type":"assistant","id":"msg_question","agent":"build","model":{"providerID":"openai","id":"test"},"time":{"created":1,"completed":2},"content":[tool("question",automatic),tool("shell",true)]});
            let message =
                session_message::Info::decode(&parse_json(&value.to_string()).unwrap()).unwrap();
            let context = context_message(message).unwrap().unwrap();
            assert!(context.contains(if automatic {
                "Question tool result (automatic)"
            } else {
                "Question tool result (source unreported)"
            }));
            assert!(context.contains("Continue independently"));
            assert!(!context.contains("UNRELATED_STRUCTURED_PAYLOAD"));
            assert!(!context.contains("User has answered"));
            assert!(context.encode_utf16().count() < 1200);
        }
        let synthetic = session_message::Info::decode(&parse_json(r#"{"type":"synthetic","id":"msg_synthetic","text":"An automatic selection","time":{"created":1}}"#).unwrap()).unwrap();
        assert_eq!(
            context_message(synthetic).unwrap().unwrap(),
            "Synthetic observation (not a human reply): An automatic selection"
        );
    }
}
