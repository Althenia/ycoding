use super::{Local, error, messages, publish};
use crate::{
    instructions,
    platform::shell::Shell,
    process::guardrails,
    resources::{
        command,
        config::Configuration,
        model,
        project_artifact::source::{ActivationInput, ActivationSource},
    },
    session::{
        compaction_job, compaction_policy, model_switch, pending, projector,
        run_coordinator::{Coordinator, Error, InterruptReason},
    },
};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, PoisonError},
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonObject, JsonValue, LosslessString, ObjectEncoder, event,
    instruction, location, model as model_schema, project_artifact, project_artifact::NonEmptyText,
    schema::RelativePath, session, session_compaction, session_message, session_pending,
    session_skill_status, shell, skill,
};
use ycoding_store::session::{ContextStateTable, Job, NewEvent, Pending};

#[derive(Debug)]
pub enum IngressError {
    Execution(Error),
    Compaction(compaction_job::CompactionError),
    SkillNotFound(skill::Id),
    SkillConflictNotFound,
    CommandNotFound(LosslessString),
    CommandEvaluation {
        command: LosslessString,
        message: String,
    },
    Invalid(String),
    Io(std::io::Error),
    Guardrail(guardrails::Error),
}
impl From<Error> for IngressError {
    fn from(error: Error) -> Self {
        Self::Execution(error)
    }
}
impl From<ycoding_store::Error> for IngressError {
    fn from(error: ycoding_store::Error) -> Self {
        Self::Execution(error.into())
    }
}
impl From<compaction_job::CompactionError> for IngressError {
    fn from(error: compaction_job::CompactionError) -> Self {
        Self::Compaction(error)
    }
}
impl std::fmt::Display for IngressError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{self:?}")
    }
}
impl std::error::Error for IngressError {}

pub struct CommandInput<'a> {
    pub request: pending::Request,
    pub name: &'a LosslessString,
    pub arguments: &'a LosslessString,
    pub agent: Option<ycoding_schema::agent::Id>,
    pub model: Option<model_schema::Ref>,
    pub resume: Option<bool>,
}

pub struct ShellInput<'a> {
    pub session: &'a session::Id,
    pub id: Option<session_message::Id>,
    pub command: LosslessString,
    pub shell: &'a Shell,
    pub config: &'a Configuration,
}

impl Local {
    pub async fn create(
        &self,
        event: NewEvent,
        inherited_binding: Option<&ycoding_schema::session_event::ProfileBinding>,
    ) -> Result<session::Info, Error> {
        let store = &self.0.services.store;
        let id = session::Id::new(event.aggregate_id.clone())
            .map_err(|_| error("session.create", "Session ID is invalid"))?;
        if let Some(recorded) = store.get(&id)? {
            return Ok(recorded);
        }
        let selection: Option<model_schema::Ref> =
            ycoding_schema::ObjectDecoder::new(&event.data, &ycoding_schema::JsonPath::default())
                .and_then(|object| object.optional("model"))
                .map_err(|_| error("session.create", "Session model is invalid"))?;
        let binding =
            match selection.filter(|selection| selection.profile.is_some()) {
                Some(selection) => {
                    let saved =
                        self.0.services.credentials.all().map_err(|_| {
                            error("provider.auth", "Provider account is unavailable")
                        })?;
                    self.resolve_model(&selection, &saved, inherited_binding)
                        .await?
                        .binding
                }
                None => None,
            };
        Ok(store.create_with_binding(event, binding).await?)
    }

    pub fn location(&self) -> &location::Ref {
        &self.0.services.location
    }
    pub fn models(&self) -> &Arc<model::Resolver> {
        &self.0.services.models
    }
    pub fn agents(&self) -> &Arc<crate::resources::agent::Service> {
        &self.0.services.agents
    }
    pub fn subagent_depth(&self, config: &Configuration) -> usize {
        match config.latest("subagent_depth") {
            Some(JsonValue::Number(value)) => *value as usize,
            _ => 1,
        }
    }
    pub(super) fn ingress_lock(&self, key: LosslessString) -> Arc<tokio::sync::Mutex<()>> {
        self.0
            .ingress
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(key)
            .or_default()
            .clone()
    }
    fn require_session(&self, id: &session::Id) -> Result<session::Info, IngressError> {
        let session = self
            .0
            .services
            .store
            .get(id)?
            .ok_or_else(|| error("not_found", "Session not found"))?;
        if session.location != self.0.services.location {
            return Err(IngressError::Invalid("Session placement changed".into()));
        }
        Ok(session)
    }
    pub async fn skill_status(
        &self,
        id: &session::Id,
    ) -> Result<Vec<session_skill_status::Info>, IngressError> {
        let session = self.require_session(id)?;
        let services = &self.0.services;
        services
            .agents
            .resolve(session.agent.as_ref())
            .ok_or_else(|| error("agent.not_found", "Session agent unavailable"))?;
        let sources = instructions::combine(vec![
            services.instructions.clone(),
            services.store.instruction_entry_sources(id)?,
        ])
        .map_err(|error| IngressError::Invalid(error.to_string()))?;
        let observation = services
            .store
            .observe_instructions(id, &sources)
            .await
            .map_err(|error| IngressError::Invalid(error.to_string()))?;
        let keys = observation
            .current
            .0
            .iter()
            .filter_map(|(key, _)| instruction::Key::decode(&JsonValue::String(key.clone())).ok())
            .collect::<Vec<_>>();
        Ok(services.store.skills(id, &keys)?)
    }
    pub async fn load_skill(
        &self,
        id: &session::Id,
        message: Option<session_message::Id>,
        skill_id: &skill::Id,
    ) -> Result<bool, IngressError> {
        let session = self.require_session(id)?;
        let agent = self
            .0
            .services
            .agents
            .resolve(session.agent.as_ref())
            .ok_or_else(|| error("agent.not_found", "Session agent unavailable"))?;
        let mut rules = agent.permissions.clone();
        rules.extend(
            session
                .permission_ceiling
                .as_deref()
                .unwrap_or_default()
                .iter()
                .cloned(),
        );
        if crate::tools::policy::evaluate(&"skill".into(), skill_id, &rules)
            .effect
            .0
            .as_str()
            == Some("deny")
        {
            return Err(IngressError::SkillNotFound(skill_id.clone()));
        }
        let resolver =
            self.0.services.skill_resolver.as_ref().ok_or_else(|| {
                IngressError::Invalid("Session skill resolver unavailable".into())
            })?;
        let info = resolver
            .list()
            .await
            .map_err(IngressError::Invalid)?
            .into_iter()
            .find(|info| &info.id == skill_id)
            .ok_or_else(|| IngressError::SkillNotFound(skill_id.clone()))?;
        let lock = self.ingress_lock(instructions::join(
            &["skill:".into(), id.as_lossless().clone()],
            "",
        ));
        let _guard = lock.lock().await;
        if self.0.services.store.skills(id, &[])?.iter().any(|status| {
            status.id == info.id && status.state == session_skill_status::State::Active
        }) {
            return Ok(false);
        }
        let text = resolver
            .instructions(&info)
            .await
            .map_err(IngressError::Invalid)?;
        self.activate_skill(&session, message, &info, &text).await?;
        Ok(true)
    }
    pub(super) async fn activate_skill(
        &self,
        session: &session::Info,
        message: Option<session_message::Id>,
        info: &skill::Info,
        text: &LosslessString,
    ) -> Result<(), IngressError> {
        let id = message
            .as_ref()
            .map(|id| {
                event::Id::new(format!(
                    "evt_{}",
                    id.as_lossless()
                        .to_utf8()
                        .unwrap_or_default()
                        .trim_start_matches("msg_")
                ))
            })
            .transpose()
            .map_err(|error| IngressError::Invalid(error.to_string()))?
            .unwrap_or(projector::random_event_id()?);
        let mut event = NewEvent {
            id: id.as_lossless().clone(),
            aggregate_id: session.id.as_lossless().clone(),
            created: self.0.services.clock.now(),
            type_: "session.skill.activated.1".into(),
            data: ObjectEncoder::new()
                .field("sessionID", &session.id)
                .field("id", &info.id)
                .field("name", &info.name)
                .field("text", text)
                .optional("conflicts", &info.conflicts)
                .finish(),
        };
        let store = &self.0.services.store;
        let Some(source) = store.artifact_source() else {
            store.publish(event).await?;
            return Ok(());
        };
        let provenance = info
            .id
            .as_str()
            .and_then(|id| source.provenance(&artifact_kind("skill"), id));
        let (Some(message), Some(provenance)) = (message, provenance) else {
            source.publish_activation(event).await?;
            return Ok(());
        };
        if let JsonValue::Object(data) = &mut event.data {
            data.insert("artifact".into(), provenance.message().encode());
        }
        let message = NonEmptyText::decode(&JsonValue::String(message.as_lossless().clone()))
            .map_err(|error| IngressError::Invalid(error.to_string()))?;
        let (source, session_id, agent) =
            (source.clone(), session.id.clone(), session.agent.clone());
        store
            .client
            .submit(move |tx| {
                let event = projector::append(tx, &event)?;
                let mut activation = source
                    .activation_at(
                        &provenance,
                        &session_id,
                        agent,
                        "session-skill",
                        event.seq,
                        event.created,
                    )
                    .map_err(|error| tx.reject(error))?;
                activation.message_id = Some(message);
                source
                    .activate_in_transaction(tx, &activation)
                    .map_err(|error| tx.reject(error))
            })?
            .await?;
        Ok(())
    }
    pub async fn resolve_skill_conflict(
        &self,
        id: &session::Id,
        winner: &skill::Id,
        loser: &skill::Id,
    ) -> Result<(), IngressError> {
        let lock = self.ingress_lock(instructions::join(
            &["skill:".into(), id.as_lossless().clone()],
            "",
        ));
        let _guard = lock.lock().await;
        let statuses = self.skill_status(id).await?;
        let win = statuses.iter().find(|status| {
            &status.id == winner && status.state == session_skill_status::State::Active
        });
        let lose = statuses.iter().find(|status| {
            &status.id == loser && status.state == session_skill_status::State::Active
        });
        let Some(lose) = lose.filter(|lose| {
            win.is_some()
                && lose.conflicts.iter().any(|conflict| {
                    conflict.r#type.as_str() == Some("skill") && &conflict.id == winner
                })
        }) else {
            return Err(IngressError::SkillConflictNotFound);
        };
        publish(
            &self.0.services.store,
            id,
            None,
            "session.skill.deactivated",
            ObjectEncoder::new()
                .field("id", loser)
                .field("activationMessageID", &lose.activation_message_id)
                .field("reason", "conflict_resolved")
                .finish(),
            self.0.services.clock.now(),
        )
        .await?;
        Ok(())
    }
    pub async fn switch_agent(
        &self,
        id: &session::Id,
        agent: &ycoding_schema::agent::Id,
    ) -> Result<(), IngressError> {
        self.require_session(id)?;
        if agent.as_str() == Some("decision") {
            return Err(IngressError::Invalid(
                "The internal decision helper cannot be selected as a foreground Session agent."
                    .into(),
            ));
        }
        let store = &self.0.services.store;
        let event = NewEvent {
            id: projector::random_event_id()?.as_lossless().clone(),
            aggregate_id: id.as_lossless().clone(),
            created: self.0.services.clock.now(),
            type_: "session.agent.selected.1".into(),
            data: ObjectEncoder::new()
                .field("sessionID", id)
                .field("agent", agent)
                .finish(),
        };
        match store.artifact_source() {
            Some(source) => source.publish_activation(event).await?,
            None => store.publish(event).await?,
        };
        Ok(())
    }
    pub async fn switch_model(
        &self,
        coordinator: &Coordinator,
        id: &session::Id,
        target: &model_schema::Ref,
    ) -> Result<model_switch::Outcome, IngressError> {
        coordinator
            .with_transition(id, async {
                let current = self.require_session(id)?;
                if current.model.as_ref() == Some(target) && target.profile.is_none() {
                    return Ok(model_switch::Outcome::Switched);
                }
                let saved = self
                    .0
                    .services
                    .credentials
                    .all()
                    .map_err(|error| IngressError::Invalid(error.to_string()))?;
                let resolved = self.resolve_model(target, &saved, None).await?;
                let budget = resolved.resolved.info.limit.context.get()
                    - self.0.services.compaction.context_safety_margin_tokens;
                if budget <= 0 {
                    return Err(IngressError::Compaction(
                        compaction_job::CompactionError::Conflict {
                            id: None,
                            message: "Target model has no positive compaction input budget".into(),
                        },
                    ));
                }
                if coordinator.active().contains(id) {
                    coordinator.interrupt(id, InterruptReason::User).await?;
                    coordinator.await_idle(id).await;
                }
                let session = self.require_session(id)?;
                if session.model.as_ref() == Some(target) && target.profile.is_none() {
                    return Ok(model_switch::Outcome::Switched);
                }
                let checked = self.check_model_switch(&session, target, budget)?;
                if matches!(checked, model_switch::Outcome::Blocked(_))
                    && !self.compact_for_switch(&session, target, budget).await?
                {
                    return Ok(checked);
                }
                let reloaded = self.require_session(id)?;
                let selected = target.clone();
                let binding = resolved.binding;
                let id = id.clone();
                let now = self.0.services.clock.now();
                self.0
                    .services
                    .store
                    .client
                    .submit(move |tx| {
                        projector::append(
                            tx,
                            &NewEvent {
                                id: projector::random_event_id()?.as_lossless().clone(),
                                aggregate_id: id.as_lossless().clone(),
                                created: now,
                                type_: "session.model.selected.1".into(),
                                data: ObjectEncoder::new()
                                    .field("sessionID", &id)
                                    .field("model", &selected)
                                    .finish(),
                            },
                        )?;
                        if binding.is_some()
                            || reloaded
                                .model
                                .as_ref()
                                .is_some_and(|model| model.profile.is_some())
                        {
                            projector::append(
                                tx,
                                &NewEvent {
                                    id: projector::random_event_id()?.as_lossless().clone(),
                                    aggregate_id: id.as_lossless().clone(),
                                    created: now,
                                    type_: "session.profile.bound.1".into(),
                                    data: ObjectEncoder::new()
                                        .field("sessionID", &id)
                                        .optional("binding", &binding)
                                        .finish(),
                                },
                            )?;
                        }
                        Ok(())
                    })?
                    .await?;
                Ok(model_switch::Outcome::Switched)
            })
            .await?
    }
    fn check_model_switch(
        &self,
        session: &session::Info,
        target: &model_schema::Ref,
        budget: i64,
    ) -> Result<model_switch::Outcome, IngressError> {
        let history = self
            .0
            .services
            .store
            .model_history(&session.id)?
            .into_iter()
            .map(|entry| match entry.message {
                session_message::Info::User(mut user) => {
                    user.files = None;
                    session_message::Info::User(user)
                }
                message => message,
            })
            .collect::<Vec<_>>();
        let lowered = messages::convert(
            &history,
            &self.0.services.attachments,
            &messages::Replay {
                model: target.clone(),
                metadata_key: String::new(),
                accounts: Default::default(),
                states: Default::default(),
            },
            None,
        );
        Ok(model_switch::decide(
            session.model.as_ref(),
            target,
            &lowered,
            budget,
        ))
    }
    async fn compact_for_switch(
        &self,
        session: &session::Info,
        target: &model_schema::Ref,
        budget: i64,
    ) -> Result<bool, IngressError> {
        let lock = self.ingress_lock(instructions::join(
            &["compact:".into(), session.id.as_lossless().clone()],
            "",
        ));
        let _guard = lock.lock().await;
        let mut admitted = false;
        loop {
            let active = self
                .0
                .services
                .store
                .compaction_pending(&session.id)
                .await?;
            let job = match active.first() {
                Some(job) => job.clone(),
                None => {
                    if admitted || self.latest_complete_boundary(&session.id)?.is_none() {
                        return Ok(false);
                    }
                    let input = || {
                        self.compaction_input(
                            session,
                            None,
                            session_compaction::Trigger::Mandatory,
                            budget,
                        )
                    };
                    if self
                        .0
                        .services
                        .store
                        .compaction_has_unchanged_deterministic_failure(input()?)
                        .await?
                    {
                        return Ok(false);
                    }
                    admitted = true;
                    self.0
                        .services
                        .store
                        .compaction_admit(input()?, self.0.services.clock.now())
                        .await?
                }
            };
            let selected = session.model.as_ref().unwrap_or(target);
            if self
                .run_compaction(session, selected, &job)
                .await?
                .status
                .as_str()
                != Some("ended")
            {
                return Ok(false);
            }
            if self.check_model_switch(&self.require_session(&session.id)?, target, budget)?
                == model_switch::Outcome::Switched
            {
                return Ok(true);
            }
        }
    }
    pub async fn compact(
        &self,
        id: &session::Id,
        job_id: Option<session_compaction::Id>,
    ) -> Result<Job, IngressError> {
        let session = self.require_session(id)?;
        self.latest_complete_boundary(id)?.ok_or_else(|| {
            IngressError::Compaction(compaction_job::CompactionError::Conflict {
                id: None,
                message: "Session has no completed message boundary to compact".into(),
            })
        })?;
        let conflict = |message: String| {
            IngressError::Compaction(compaction_job::CompactionError::Conflict {
                id: None,
                message,
            })
        };
        let saved = self
            .0
            .services
            .credentials
            .all()
            .map_err(|error| IngressError::Invalid(error.to_string()))?;
        let selected = session
            .model
            .clone()
            .or_else(|| self.0.services.models.catalog().default_selection(&saved))
            .ok_or_else(|| conflict("Selected model unavailable".into()))?;
        let resolved = self
            .resolve_model(
                &selected,
                &saved,
                self.0.services.store.profile_binding(id)?.as_ref(),
            )
            .await
            .map_err(|error| match error {
                Error::Runner(error) => conflict(error.message.to_utf8().unwrap_or_default()),
                error => IngressError::Execution(error),
            })?;
        let policy = &self.0.services.compaction;
        let context = resolved.resolved.info.limit.context.get();
        let hard_cap = context - policy.context_safety_margin_tokens;
        if hard_cap <= 0 {
            return Err(IngressError::Compaction(
                compaction_job::CompactionError::Conflict {
                    id: None,
                    message: "Selected model has no positive compaction input budget".into(),
                },
            ));
        }
        let target = match policy.advisory {
            compaction_policy::Advisory::Disabled => hard_cap,
            compaction_policy::Advisory::Thresholds {
                consider_percent, ..
            } => context * consider_percent / 100,
        };
        let input = self.compaction_input(
            &session,
            job_id,
            session_compaction::Trigger::Manual,
            target,
        )?;
        let lock = self.ingress_lock(instructions::join(
            &["compact:".into(), id.as_lossless().clone()],
            "",
        ));
        let _guard = lock.lock().await;
        let active = self.0.services.store.compaction_pending(id).await?;
        let job = match active.first() {
            Some(job) => job.clone(),
            None => {
                self.0
                    .services
                    .store
                    .compaction_admit(input, self.0.services.clock.now())
                    .await?
            }
        };
        Ok(self.run_compaction(&session, &selected, &job).await?)
    }
    fn compaction_input(
        &self,
        session: &session::Info,
        id: Option<session_compaction::Id>,
        trigger: session_compaction::Trigger,
        budget: i64,
    ) -> Result<compaction_job::AdmitInput, IngressError> {
        let (message, seq) = self.latest_complete_boundary(&session.id)?.ok_or_else(|| {
            IngressError::Compaction(compaction_job::CompactionError::Conflict {
                id: None,
                message: "Session has no completed message boundary to compact".into(),
            })
        })?;
        let revision = self
            .0
            .services
            .store
            .client
            .snapshot()?
            .get::<ContextStateTable>(&crate::session::key(session.id.as_lossless()))?
            .map_or(0, |state| state.revision);
        Ok(compaction_job::AdmitInput {
            id,
            session: session.id.clone(),
            trigger,
            requested_through_message: message,
            requested_through_seq: seq,
            base_context_revision: revision,
            target_max_input_tokens: budget,
            config_digest: compaction_policy::admission_digest(&self.0.services.compaction),
            pressure: None,
        })
    }
    pub async fn command(
        &self,
        execution: &crate::session::execution::Execution,
        commands: &command::Service,
        mcp: Option<&crate::resources::mcp::Service>,
        config: &Configuration,
        input: CommandInput<'_>,
    ) -> Result<Pending, IngressError> {
        self.command_from(
            execution,
            commands,
            mcp,
            config,
            input,
            crate::session::autonomy::Origin::User,
        )
        .await
    }
    pub async fn command_from(
        &self,
        execution: &crate::session::execution::Execution,
        commands: &command::Service,
        mcp: Option<&crate::resources::mcp::Service>,
        config: &Configuration,
        input: CommandInput<'_>,
        origin: crate::session::autonomy::Origin,
    ) -> Result<Pending, IngressError> {
        let lock = self.ingress_lock(instructions::join(
            &["command:".into(), input.request.id.as_lossless().clone()],
            "",
        ));
        let _guard = lock.lock().await;
        let current = self.require_session(&input.request.session_id)?;
        if self.0.services.store.pending(&input.request.id)?.is_some()
            || self.0.services.store.message(&input.request.id)?.is_some()
        {
            return Ok(execution
                .prompt_with_origin(input.request, input.resume, origin)
                .await?);
        }
        let command = commands.get(input.name);
        let agent = command
            .and_then(|command| command.agent.as_ref())
            .or(input.agent.as_ref());
        if agent.and_then(LosslessString::as_str) == Some("decision") {
            return Err(IngressError::CommandEvaluation {
                command: input.name.clone(),
                message:
                    "The internal decision helper cannot be selected as a foreground Session agent."
                        .into(),
            });
        }
        let evaluated = match command {
            Some(command) => crate::session::command::evaluate(
                &command.template,
                input.arguments,
                Path::new(
                    current
                        .location
                        .directory
                        .as_lossless()
                        .as_str()
                        .ok_or_else(|| {
                            IngressError::Invalid("Session directory is not Unicode".into())
                        })?,
                ),
                config,
            )
            .await
            .map(Some),
            None => match mcp {
                Some(mcp) => {
                    crate::session::command::evaluate_mcp(mcp, input.name, input.arguments).await
                }
                None => Ok(None),
            },
        };
        let text = evaluated
            .map_err(|message| IngressError::CommandEvaluation {
                command: input.name.clone(),
                message,
            })?
            .ok_or_else(|| IngressError::CommandNotFound(input.name.clone()))?;
        let model = command
            .and_then(|command| command.model.as_ref())
            .or_else(|| {
                command
                    .and_then(|command| command.agent.as_ref())
                    .and_then(|agent| self.0.services.agents.get(agent))
                    .and_then(|agent| agent.model.as_ref())
            })
            .or(input.model.as_ref());
        if let Some(agent) = agent.filter(|agent| current.agent.as_ref() != Some(*agent)) {
            self.switch_agent(&current.id, agent).await?;
        }
        if let Some(model) = model {
            match self
                .switch_model(execution.coordinator(), &current.id, model)
                .await
            {
                Ok(_) => {}
                Err(error) => {
                    return Err(IngressError::CommandEvaluation {
                        command: input.name.clone(),
                        message: match error {
                            IngressError::Execution(Error::Runner(error)) => {
                                String::from_utf16_lossy(
                                    &error.message.code_units().collect::<Vec<_>>(),
                                )
                            }
                            error => error.to_string(),
                        },
                    });
                }
            }
        }
        let mut request = input.request;
        let session_pending::Message::User(user) = &mut request.input else {
            return Err(IngressError::Invalid("Command requires user input".into()));
        };
        user.data.text = text;
        let source = self.0.services.store.artifact_source();
        let provenance = source
            .zip(input.name.as_str())
            .and_then(|(source, name)| source.provenance(&artifact_kind("command"), name));
        user.data.metadata = provenance.as_ref().map(|provenance| {
            let mut metadata = JsonObject::new();
            metadata.insert("projectArtifact".into(), provenance.message().encode());
            metadata
        });
        let admitted = execution
            .prompt_with_origin(request, input.resume, origin)
            .await?;
        if let Some(source) = source.filter(|_| provenance.is_some())
            && source
                .activate(ActivationInput {
                    kind: artifact_kind("command"),
                    id: input.name.clone(),
                    session_id: current.id.clone(),
                    agent_id: current.agent.clone(),
                    source: ActivationSource::Command {
                        message_id: admitted.id.clone(),
                        call_id: None,
                    },
                })
                .is_err()
        {
            source.record_activation_failure();
        }
        Ok(admitted)
    }
    pub async fn shell(
        &self,
        coordinator: &Coordinator,
        input: ShellInput<'_>,
    ) -> Result<(), IngressError> {
        let session = self.require_session(input.session)?;
        let lock = self.ingress_lock(instructions::join(
            &["shell:".into(), input.session.as_lossless().clone()],
            "",
        ));
        let _guard = lock.lock().await;
        let outcome: Result<(), IngressError> = coordinator
            .with_transition(input.session, async {
                coordinator.await_idle(input.session).await;
                let mut metadata = JsonObject::new();
                metadata.insert(
                    "workdir".into(),
                    JsonValue::String(session.location.directory.as_lossless().clone()),
                );
                metadata.insert("source".into(), JsonValue::String("session.shell".into()));
                let admission = self
                    .0
                    .services
                    .guardrails
                    .assert(guardrails::Input {
                        session_id: session.id.clone(),
                        action: "shell".into(),
                        resources: vec![input.command.clone()],
                        metadata: Some(metadata),
                        skip_review: false,
                        holder: None,
                        defer_shell: false,
                        source: None,
                    })
                    .map_err(IngressError::Guardrail)?;
                let reservation = match admission.wait {
                    Some(wait) => wait
                        .await
                        .map_err(|_| {
                            IngressError::Invalid("Shell guardrail wait cancelled".into())
                        })?
                        .map_err(IngressError::Guardrail)?,
                    None => admission.reservation.ok_or_else(|| {
                        IngressError::Invalid("Shell admission lacks reservation".into())
                    })?,
                };
                let mut metadata = JsonObject::new();
                metadata.insert(
                    "sessionID".into(),
                    JsonValue::String(session.id.as_lossless().clone()),
                );
                let mut prepared = input
                    .shell
                    .prepare(
                        shell::CreateInput {
                            command: input.command,
                            cwd: Some(session.location.directory.as_lossless().clone()),
                            timeout: ycoding_schema::schema::NonNegativeInt::new(0).expect("zero"),
                            memory_limit_mb: None,
                            metadata: Some(metadata),
                        },
                        input.config,
                    )
                    .map_err(IngressError::Io)?;
                let started = input
                    .shell
                    .create(&mut prepared)
                    .await
                    .map_err(IngressError::Io)?;
                let event_id = input
                    .id
                    .map(|id| {
                        event::Id::new(format!(
                            "evt_{}",
                            id.as_lossless()
                                .to_utf8()
                                .unwrap_or_default()
                                .trim_start_matches("msg_")
                        ))
                    })
                    .transpose()
                    .map_err(|error| IngressError::Invalid(error.to_string()))?
                    .unwrap_or(projector::random_event_id()?);
                let event = NewEvent {
                    id: event_id.as_lossless().clone(),
                    aggregate_id: session.id.as_lossless().clone(),
                    created: self.0.services.clock.now(),
                    type_: "session.shell.started.1".into(),
                    data: ObjectEncoder::new()
                        .field("sessionID", &session.id)
                        .field("shell", &started)
                        .finish(),
                };
                let warnings = prepared
                    .warnings
                    .iter()
                    .map(|warning| JsonValue::String(warning.as_str().into()))
                    .collect::<Vec<_>>();
                if warnings.is_empty() {
                    self.0.services.store.publish(event).await?;
                } else {
                    let mut metadata = JsonObject::new();
                    metadata.insert("sandboxWarnings".into(), JsonValue::Array(warnings));
                    self.0
                        .services
                        .store
                        .client
                        .submit(move |tx| projector::append_with_metadata(tx, &event, metadata))?
                        .await?;
                }
                let ended = match input.shell.wait(&started.id).await {
                    Ok(ended) => ended,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        let mut ended = started.clone();
                        ended.status = shell::Status::Killed;
                        ended.time.completed = Some(
                            ycoding_schema::schema::Finite::new(self.0.services.clock.now() as f64)
                                .map_err(|error| IngressError::Invalid(error.to_string()))?,
                        );
                        ended
                    }
                    Err(error) => return Err(IngressError::Io(error)),
                };
                let output = match input.shell.output(&started.id, 0, 1024 * 1024).await {
                    Ok(output) => output,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        let output = "Shell command output is no longer available.".to_owned();
                        crate::platform::shell::paging::Page {
                            cursor: output.len(),
                            size: output.len(),
                            output,
                            truncated: false,
                        }
                    }
                    Err(error) => return Err(IngressError::Io(error)),
                };
                publish(
                    &self.0.services.store,
                    &session.id,
                    None,
                    "session.shell.ended",
                    ObjectEncoder::new()
                        .field("shell", &ended)
                        .field(
                            "output",
                            &ObjectEncoder::new()
                                .field("output", output.output.as_str())
                                .field("cursor", &(output.cursor as f64))
                                .field("size", &(output.size as f64))
                                .field("truncated", &output.truncated)
                                .finish(),
                        )
                        .finish(),
                    self.0.services.clock.now(),
                )
                .await?;
                reservation.release();
                Ok(())
            })
            .await?;
        let wake = coordinator.wake(input.session);
        outcome?;
        wake?;
        Ok(())
    }
    pub async fn move_to(
        &self,
        coordinator: &Coordinator,
        id: &session::Id,
        destination: &location::Info,
        accounting: Option<&crate::resources::project_artifact::accounting::Service>,
        destination_agent: Option<&ycoding_schema::agent::Id>,
    ) -> Result<(), IngressError> {
        let current = self.require_session(id)?;
        let target = location::Ref {
            directory: destination.directory.clone(),
            workspace_id: destination.workspace_id.clone(),
        };
        if current.location == target {
            return Ok(());
        }
        if coordinator.active().contains(id) {
            coordinator.interrupt(id, InterruptReason::User).await?;
            coordinator.await_idle(id).await;
        }
        if current.project_id != destination.project.id {
            let accounting = accounting
                .ok_or_else(|| error("artifact.accounting", "Artifact accounting unavailable"))?
                .clone();
            let old_agent = current.agent.as_ref().and_then(|agent| {
                self.0
                    .services
                    .store
                    .artifact_source()?
                    .provenance(&artifact_kind("agent"), agent.as_str()?)
            });
            let deactivated_at = self.0.services.clock.now();
            let ended = super::event(
                id,
                None,
                "session.project-artifacts-ended",
                ObjectEncoder::new()
                    .field("oldProjectID", &current.project_id)
                    .field("newProjectID", &destination.project.id)
                    .finish(),
                deactivated_at,
            )?;
            let session_id = id.as_lossless().clone();
            let project_id = current.project_id.as_lossless().clone();
            self.0
                .services
                .store
                .client
                .submit(move |tx| {
                    let event = projector::append(tx, &ended)?;
                    accounting
                        .deactivate_project_in_transaction(
                            tx,
                            &session_id,
                            &project_id,
                            event.seq,
                            deactivated_at,
                        )
                        .map_err(|error| tx.reject(error))?;
                    Ok(())
                })?
                .await?;
            if old_agent.is_some_and(|agent| agent.scope == "project")
                && let Some(agent) = destination_agent
            {
                publish(
                    &self.0.services.store,
                    id,
                    None,
                    "session.agent.selected",
                    ObjectEncoder::new().field("agent", agent).finish(),
                    self.0.services.clock.now(),
                )
                .await?;
            }
        }
        let directory = Path::new(
            destination
                .directory
                .as_lossless()
                .as_str()
                .ok_or_else(|| IngressError::Invalid("Destination is not Unicode".into()))?,
        );
        let project_directory = Path::new(
            destination
                .project
                .directory
                .as_lossless()
                .as_str()
                .ok_or_else(|| IngressError::Invalid("Project directory is not Unicode".into()))?,
        );
        let common = directory
            .components()
            .zip(project_directory.components())
            .take_while(|(left, right)| left == right)
            .count();
        let subpath = if common == 0 {
            directory.to_path_buf()
        } else {
            project_directory
                .components()
                .skip(common)
                .map(|_| Path::new(".."))
                .chain(
                    directory
                        .components()
                        .skip(common)
                        .map(|component| Path::new(component.as_os_str())),
                )
                .collect::<PathBuf>()
        }
        .to_string_lossy()
        .replace('\\', "/");
        let subpath =
            RelativePath::new(subpath).map_err(|error| IngressError::Invalid(error.to_string()))?;
        publish(
            &self.0.services.store,
            id,
            None,
            "session.moved",
            ObjectEncoder::new()
                .field("location", &target)
                .field("projectID", &destination.project.id)
                .field("subpath", &subpath)
                .finish(),
            self.0.services.clock.now(),
        )
        .await?;
        Ok(())
    }
}

fn artifact_kind(kind: &str) -> project_artifact::Kind {
    project_artifact::Kind::decode(&JsonValue::String(kind.into())).expect("fixed artifact kind")
}
