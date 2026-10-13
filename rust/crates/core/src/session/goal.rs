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
use ycoding_schema::{DomainDecode, location, parse_json, permission, session_message};

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

impl Service {
    pub fn new(store: store::Service, provider: Provider) -> Self {
        Self { store, provider }
    }

    async fn generate(&self, request: SteerRequest) -> Option<String> {
        let session = self.store.get(&request.session_id).ok()??;
        let environment = (self.provider)(&session.location)?;
        if environment.location != session.location {
            return None;
        }
        let mut agent = environment.agents.get(&"goal".into())?.clone();
        agent.system = Some(SYSTEM.into());
        if !environment.generate.resolves(&session, Role::Goal, &agent) {
            return None;
        }
        let latest = match request.latest_assistant_text {
            Some(text) => Some(text),
            None => match self.store.latest(&session.id, "assistant").ok()? {
                Some(session_message::Info::Assistant(assistant)) => {
                    Some(assistant_text(&assistant.content))
                }
                _ => None,
            },
        };
        let latest = latest.map(|text| tail(&trim(&text), 2_000));
        let context = self
            .store
            .recent(&session.id, 12)
            .ok()?
            .into_iter()
            .map(context_message)
            .collect::<Result<Vec<_>, _>>()
            .ok()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("\n");
        let context = tail(&context, 6_000);
        let prompt = format!(
            "Recent conversation context:\n{}\n\nUser-proxy steer request:\nActive goal: {}\nPhase: continue\nCurrent iteration: {}\nLatest assistant response: {}\nPreserve the active goal and produce only the next concise user-proxy steer.",
            if context.is_empty() {
                "(none)"
            } else {
                &context
            },
            request.goal.text.to_utf8().ok()?,
            request.goal.iteration,
            latest
                .as_deref()
                .filter(|text| !text.is_empty())
                .unwrap_or("(none)"),
        );
        let output = environment
            .generate
            .generate(Request {
                session: &session,
                role: Role::Goal,
                source: "goal",
                agent: &agent,
                user: prompt,
                character_limit: usize::MAX,
                cancellation: &Cancellation::default(),
            })
            .await?;
        let text = units(&output)
            .split(|unit| is_whitespace(*unit))
            .filter(|part| !part.is_empty())
            .map(String::from_utf16_lossy)
            .collect::<Vec<_>>()
            .join(" ");
        (!text.is_empty()).then_some(text)
    }
}

impl autonomy::Steer for Service {
    fn steer(&self, request: SteerRequest) -> SteerFuture<'_> {
        Box::pin(self.generate(request))
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
