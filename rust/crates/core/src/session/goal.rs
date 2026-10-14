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

pub const SYSTEM: &str = "Handle the task identified in the request using the recent conversation context.\n\n- For goal synthesis, preserve the user's authority and produce the current autonomous-work goal with its intended outcome and observable completion condition.\n- For a user-proxy steer, preserve the active goal exactly. Use the latest assistant response and context to direct the next useful action. Decide on the user's behalf: answer any question or choice the assistant raises with the safest reasonable option that serves the goal, so the user is not consulted until the goal is satisfied.\n- Never grant or imply human approval, permission, authorization, or confirmation. Do not weaken permission ceilings, guardrails, or required human review.\n\nOutput exactly one concise imperative sentence, or two only when required for clarity. Do not use Markdown, a preamble, an explanation, or quotation marks.";

pub fn agent() -> ycoding_schema::agent::Info {
    let mut info = agent::empty("goal".into());
    info.name = "Goal".into();
    info.mode = "primary".into();
    info.hidden = true;
    info.system = Some(SYSTEM.into());
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
        self.generate(session, format!(
            "User-proxy steer request:\nActive goal: {}\nPhase: {phase}\nCurrent iteration: {}\nLatest assistant response: {}\nPreserve the active goal and produce only the next concise user-proxy steer.",
            request.goal.text.to_utf8().map_err(|_| Error::CalculationFailed)?,
            request.goal.iteration,
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
                .filter_map(|part| match part {
                    session_message::AssistantContent::Text(text) => Some(text.text),
                    session_message::AssistantContent::Reasoning(reasoning) => Some(reasoning.text),
                    _ => None,
                })
                .map(|text| text.to_utf8())
                .collect::<Result<Vec<_>, _>>()?
                .join("\n")
        )),
        session_message::Info::System(message) => {
            Some(format!("Context: {}", message.text.to_utf8()?))
        }
        session_message::Info::Synthetic(message) => {
            Some(format!("Context: {}", message.text.to_utf8()?))
        }
        session_message::Info::Skill(message) => {
            Some(format!("Context: {}", message.text.to_utf8()?))
        }
        _ => None,
    })
}
