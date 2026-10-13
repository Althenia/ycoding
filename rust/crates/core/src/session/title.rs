use crate::{
    resources::agent,
    session::store,
    tools::{
        code_mode::Cancellation,
        policy::helper::{self, Models, Role, StreamInput, TitleMode},
    },
};
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
};
use ycoding_ai::{llm, route::Executor};
use ycoding_schema::{LosslessString, ObjectEncoder, session};

pub struct Service {
    pub store: store::Service,
    pub agents: Arc<agent::Service>,
    pub models: Arc<Models>,
    pub executor: Arc<Executor>,
    attempted: Mutex<BTreeSet<session::Id>>,
}
impl Service {
    pub fn new(
        store: store::Service,
        agents: Arc<agent::Service>,
        models: Arc<Models>,
        executor: Arc<Executor>,
    ) -> Self {
        Self {
            store,
            agents,
            models,
            executor,
            attempted: Mutex::default(),
        }
    }
    pub async fn generate_for_first_prompt(
        &self,
        session: &session::Info,
        cancellation: &Cancellation,
    ) -> Result<(), String> {
        if session.parent_id.is_some() {
            return Ok(());
        }
        let Some(user) = self
            .store
            .first_user_message_if_only(&session.id)
            .map_err(|error| error.to_string())?
        else {
            return Ok(());
        };
        if !self
            .attempted
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(session.id.clone())
        {
            return Ok(());
        }
        if self.models.settings.title_mode == TitleMode::Off {
            return Ok(());
        }
        let local = helper::local_title(&user.text);
        let title = if self.models.settings.title_mode == TitleMode::Local {
            local
        } else {
            match self.agents.get(&"title".into()) {
                None => local,
                Some(agent) => {
                    match tokio::select! {biased; _ = cancellation.cancelled() => return Ok(()), resolved = self.models.role(session, Role::Title, agent) => resolved}
                    {
                        Err(_) => local,
                        Ok(resolved) => {
                            let request = helper::request(
                                session,
                                &resolved,
                                &agent.permissions,
                                agent.system.iter().cloned().map(Into::into).collect(),
                                vec![llm::Message::user(user.text.clone())],
                            );
                            let result = helper::stream(
                                &self.store,
                                &self.executor,
                                StreamInput {
                                    session,
                                    resolved: &resolved,
                                    agent,
                                    source: "title",
                                    input_id: Some(&user.id),
                                    request,
                                    cancellation,
                                    byte_limit: None,
                                    require_stop: false,
                                },
                            )
                            .await?;
                            if result.cancelled {
                                return Ok(());
                            }
                            if result.failed {
                                local
                            } else {
                                first_line(&result.text).unwrap_or(local)
                            }
                        }
                    }
                }
            }
        };
        if cancellation.is_cancelled() {
            return Ok(());
        }
        helper::publish(
            &self.store,
            &session.id,
            "session.renamed.1",
            ObjectEncoder::new()
                .field("sessionID", &session.id)
                .field("title", &title)
                .finish(),
            chrono::Utc::now().timestamp_millis(),
        )
        .await
    }
}
fn first_line(value: &LosslessString) -> Option<LosslessString> {
    let units = value.code_units().collect::<Vec<_>>();
    let line = units
        .split(|unit| *unit == 10)
        .map(|line| {
            let start = line
                .iter()
                .position(|unit| !crate::process::guardrails::is_whitespace(*unit))
                .unwrap_or(line.len());
            let end = line
                .iter()
                .rposition(|unit| !crate::process::guardrails::is_whitespace(*unit))
                .map_or(start, |index| index + 1);
            line[start..end].to_vec()
        })
        .find(|line| !line.is_empty())?;
    Some(LosslessString::from_utf16(if line.len() <= 100 {
        line
    } else {
        line[..97].iter().copied().chain([46, 46, 46]).collect()
    }))
}
