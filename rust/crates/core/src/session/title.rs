use crate::{
    resources::agent,
    session::{helper_generation::matches, store},
    tools::{
        code_mode::Cancellation,
        policy::helper::{self, Models, Role, StreamInput, TitleMode},
    },
};
use std::{
    collections::BTreeSet,
    ops::Bound,
    sync::{Arc, Mutex},
};
use ycoding_ai::{llm, route::Executor};
use ycoding_schema::{LosslessString, ObjectEncoder, session};
use ycoding_store::{
    IndexOrder, IndexQuery, KeyPart,
    session::{EventTable, NewEvent, SessionTable},
    tuple_key,
};

const REFUSAL: &str = r#"^(?:["'“‘`]\s*)?(?:unfortunately[,:]?\s+)?(?:(?:i|we)\s+(?:cannot|can['’]t|won['’]t|will not|(?:am|are)\s+(?:unable|not able)|(?:(?:must|have to)\s+)?(?:decline|refuse))\b|(?:i['’]m|we['’]re|i am|we are)\s+(?:sorry|unable|not able)\b|sorry\b|as an (?:ai|assistant)\b)"#;

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
        let prefix = rename_prefix(&session.id);
        if !self
            .store
            .client
            .snapshot()
            .map_err(|error| error.to_string())?
            .index_range::<EventTable>("event_aggregate_type_seq_idx", rename_query(&prefix))
            .map_err(|error| error.to_string())?
            .is_empty()
        {
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
                    let attribution = crate::session::usage_attribution::first_prompt(
                        &self.store.client,
                        session.id.as_lossless(),
                        user.id.as_lossless(),
                    )
                    .await
                    .map_err(|error| error.to_string())?;
                    let _activity = crate::session::usage_activity::contribute(
                        &self.store.client,
                        session.id.clone(),
                        attribution.anchor().cloned(),
                    );
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
                                    attribution,
                                },
                            )
                            .await?;
                            if result.cancelled {
                                return Ok(());
                            }
                            if result.failed {
                                local
                            } else {
                                first_line(&result.text)
                                    .filter(|title| !refusal(title))
                                    .unwrap_or(local)
                            }
                        }
                    }
                }
            }
        };
        if cancellation.is_cancelled() {
            return Ok(());
        }
        let session = session.clone();
        let event = NewEvent {
            id: super::projector::random_event_id()
                .map_err(|error| error.to_string())?
                .as_lossless()
                .clone(),
            aggregate_id: session.id.as_lossless().clone(),
            type_: "session.renamed.1".into(),
            data: ObjectEncoder::new()
                .field("sessionID", &session.id)
                .field("title", &title)
                .finish(),
            created: chrono::Utc::now().timestamp_millis(),
        };
        let cancellation = cancellation.clone();
        self.store
            .client
            .submit(move |tx| {
                let Some(row) = tx.get::<SessionTable>(&super::key(session.id.as_lossless()))?
                else {
                    return Ok(());
                };
                if cancellation.is_cancelled()
                    || row.title != session.title
                    || !tx
                        .index_range::<EventTable>(
                            "event_aggregate_type_seq_idx",
                            rename_query(&prefix),
                        )?
                        .is_empty()
                {
                    return Ok(());
                }
                super::projector::append(tx, &event)?;
                Ok(())
            })
            .map_err(|error| error.to_string())?
            .await
            .map_err(|error| error.to_string())
    }
}

fn rename_prefix(id: &session::Id) -> Vec<u8> {
    tuple_key(&[
        KeyPart::String(id.as_lossless()),
        KeyPart::String(&"session.renamed.1".into()),
    ])
}

fn rename_query(prefix: &[u8]) -> IndexQuery<'_> {
    IndexQuery {
        lower: Bound::Unbounded,
        upper: Bound::Unbounded,
        prefix: Some(prefix),
        order: IndexOrder::Descending,
        after: None,
        limit: 1,
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
fn refusal(title: &LosslessString) -> bool {
    matches(
        REFUSAL,
        "iu",
        &String::from_utf16_lossy(&title.code_units().collect::<Vec<_>>()),
    )
}
