use super::{Local, error, helper::StreamInput};
use crate::session::{
    compaction::{self, Input, LiveState},
    compaction_execution::{self, ManifestFuture},
    compaction_gate, compaction_job,
    compaction_policy::Resolved,
    compaction_summary::{Generate, SUMMARY_TEMPLATE},
    context_pressure::{self, Capabilities},
    live_state, projector, prompt_cache,
    run_coordinator::{Error, Outcome},
    usage_attribution::Attribution,
};
use crate::tools::policy::helper::{CompactionScope, Role};
use std::{future::Future, ops::Bound, pin::Pin};
use ycoding_ai::llm;
use ycoding_schema::{
    DomainEncode, JsonValue, ObjectEncoder, model, session, session_compaction, session_event,
    session_message,
};
use ycoding_store::{
    IndexOrder,
    session::{ContextStateTable, Job, MessageTable, NewEvent},
};

pub(super) struct Helper {
    pub model: llm::Model,
    pub selection: model::Ref,
    pub costs: Vec<model::Cost>,
    pub account_identity: Option<String>,
    pub context_window: i64,
    pub binding: Option<session_event::ProfileBinding>,
}

pub(super) enum Gate {
    Proceed,
    Restart,
    Exceeded(Error),
}

pub(super) struct GateInput<'a> {
    pub agent: &'a ycoding_schema::agent::Id,
    pub session: &'a session::Info,
    pub selection: &'a model::Ref,
    pub context_window: i64,
    pub request: &'a llm::Request,
    pub history: &'a [session_message::Info],
    pub output_limit: i64,
    pub force: bool,
}

impl Local {
    pub(super) async fn ensure_within_limit(&self, input: GateInput<'_>) -> Result<Gate, Error> {
        let lock = self.ingress_lock(crate::instructions::join(
            &["compact:".into(), input.session.id.as_lossless().clone()],
            "",
        ));
        let _guard = lock.lock().await;
        let services = &self.0.services;
        let policy = &services.compaction;
        let capabilities = Capabilities {
            context_window_tokens: input.context_window,
            max_output_tokens: input
                .request
                .generation
                .max_tokens
                .map_or(input.output_limit, |tokens| tokens as i64),
            context_safety_margin_tokens: policy.context_safety_margin_tokens,
        };
        let cap = context_pressure::hard_input_cap_tokens(&capabilities);
        if cap <= 0 {
            return Ok(Gate::Exceeded(budget_error(0, cap)));
        }
        let estimate = compaction_gate::estimated_provider_input_tokens(input.request);
        let pressure = estimate;
        let blocked = || {
            Ok(if pressure < cap {
                Gate::Proceed
            } else {
                Gate::Exceeded(budget_error(pressure, cap))
            })
        };
        if !input.force && pressure < cap {
            if let Some(tools) = &services.session_tools {
                let admitted = tools
                    .conversation_compact
                    .observe(
                        crate::tools::builtin::conversation_compact::Context {
                            session: &input.session.id,
                            agent: input.agent,
                            capabilities: Some(capabilities),
                            request: input.request,
                        },
                        |trigger, estimate| {
                            let Some((boundary, seq)) = self
                                .latest_complete_boundary(&input.session.id)
                                .map_err(|_| compaction_job::CompactionError::Conflict {
                                    id: None,
                                    message: "Compaction boundary is unavailable".into(),
                                })?
                            else {
                                return Err(compaction_job::CompactionError::Conflict {
                                    id: None,
                                    message: "No completed compaction boundary is available".into(),
                                });
                            };
                            let revision = services
                                .store
                                .client
                                .snapshot()?
                                .get::<ContextStateTable>(&crate::session::key(
                                    input.session.id.as_lossless(),
                                ))?
                                .map_or(0, |state| state.revision);
                            Ok(compaction_job::AdmitInput {
                                id: None,
                                session: input.session.id.clone(),
                                trigger,
                                requested_through_message: boundary,
                                requested_through_seq: seq,
                                base_context_revision: revision,
                                target_max_input_tokens: compaction_gate::target_input_tokens(
                                    input.context_window,
                                    policy,
                                ),
                                config_digest: crate::session::compaction_policy::admission_digest(
                                    policy,
                                ),
                                pressure: Some(session_compaction::Pressure {
                                    estimated_input_tokens: non_negative(estimate),
                                    safe_input_tokens: non_negative(cap),
                                }),
                            })
                        },
                    )
                    .await;
                match admitted {
                    Ok(Some(job)) => {
                        self.settle(&input, &job).await?;
                        return Ok(Gate::Restart);
                    }
                    Ok(None) => {}
                    Err(compaction_job::CompactionError::Store(failure)) => {
                        return Err(failure.into());
                    }
                    Err(_) => tracing::warn!("Advisory compaction admission is unavailable"),
                }
            }
            return Ok(Gate::Proceed);
        }
        let (revision, restored) = services
            .store
            .ensure_compaction_revision(&input.session.id, services.clock.now())
            .await?;
        if restored {
            return Ok(Gate::Restart);
        }
        let pending = services.store.compaction_pending(&input.session.id).await?;
        if let Some(existing) = pending.first() {
            self.settle(&input, existing).await?;
            return Ok(Gate::Restart);
        }
        let boundaries = self.mandatory_boundaries(&input, cap, revision)?;
        if boundaries.is_empty() {
            return blocked();
        }
        let target = compaction_gate::target_input_tokens(input.context_window, policy).min(cap);
        let admission = |(boundary, seq): &(session_message::Id, i64)| compaction_job::AdmitInput {
            id: None,
            session: input.session.id.clone(),
            trigger: session_compaction::Trigger::Mandatory,
            requested_through_message: boundary.clone(),
            requested_through_seq: *seq,
            base_context_revision: revision,
            target_max_input_tokens: target,
            config_digest: crate::session::compaction_policy::admission_digest(policy),
            pressure: Some(session_compaction::Pressure {
                estimated_input_tokens: non_negative(pressure),
                safe_input_tokens: non_negative(cap),
            }),
        };
        let now = services.clock.now();
        let mut boundary = None;
        for candidate in boundaries {
            if !services
                .store
                .compaction_has_unchanged_deterministic_failure(admission(&candidate))
                .await?
            {
                boundary = Some(candidate);
                break;
            }
        }
        let Some(boundary) = boundary else {
            return blocked();
        };
        let admitted = match services
            .store
            .compaction_admit(admission(&boundary), now)
            .await
        {
            Ok(job) => job,
            Err(compaction_job::CompactionError::Store(failure)) => return Err(failure.into()),
            Err(failure) => return Err(error("compaction.admission", &failure.to_string())),
        };
        self.settle(&input, &admitted).await?;
        Ok(Gate::Restart)
    }

    fn mandatory_boundaries(
        &self,
        input: &GateInput<'_>,
        cap: i64,
        revision: i64,
    ) -> Result<Vec<(session_message::Id, i64)>, Error> {
        let last_user = input
            .history
            .iter()
            .rposition(|message| matches!(message, session_message::Info::User(_)));
        let current_user = last_user.filter(|index| {
            let later = &input.history[index + 1..];
            !later.iter().any(|message| matches!(message, session_message::Info::Assistant(assistant) if assistant.time.completed.is_some()))
                || later.iter().any(|message| matches!(message, session_message::Info::Assistant(assistant) if assistant.time.completed.is_none()))
        });
        let snapshot = self.0.services.store.client.snapshot()?;
        let mut candidates = Vec::new();
        let mut failed = Vec::new();
        for (index, message) in input.history.iter().enumerate() {
            if Some(index) == current_user
                || matches!(message, session_message::Info::Assistant(assistant) if assistant.time.completed.is_none())
            {
                break;
            }
            if let session_message::Info::User(user) = message
                && user.time.consumed.is_none()
                && self.0.services.store.pending(&user.id)?.is_some()
            {
                break;
            }
            if let session_message::Info::Compaction(session_message::Compaction::Failed(marker)) =
                message
            {
                if let Some(job) = self.0.services.store.compaction_job(&marker.job_id)?
                    && job.base_context_revision == revision
                    && matches!(
                        marker.code,
                        session_compaction::FailureCode::ContextLimitUnresolved
                            | session_compaction::FailureCode::InvalidManifest
                    )
                {
                    failed.push((job.requested_through_message_id, job.requested_through_seq));
                }
                continue;
            }
            let JsonValue::Object(encoded) = message.encode() else {
                continue;
            };
            let Some(JsonValue::String(id)) = encoded.get(&"id".into()) else {
                continue;
            };
            let row = match snapshot.get::<MessageTable>(&crate::session::key(id))? {
                Some(row) => row,
                None => {
                    let Some(state) = snapshot.get::<ContextStateTable>(&crate::session::key(
                        input.session.id.as_lossless(),
                    ))?
                    else {
                        continue;
                    };
                    if state.status.as_str() != Some("active")
                        || state.covered_through_seq.is_none()
                    {
                        continue;
                    }
                    let Some(summary) = crate::session::model_history::summary(
                        &snapshot,
                        &input.session.id,
                        &state,
                    )?
                    else {
                        continue;
                    };
                    if crate::session::compaction_summary::checkpoint_memory(
                        summary.sequence,
                        message,
                    )
                    .is_none()
                    {
                        continue;
                    }
                    let rows = ycoding_store::session::messages(
                        &snapshot,
                        input.session.id.as_lossless(),
                        Bound::Included(summary.sequence),
                        Bound::Included(summary.sequence),
                        IndexOrder::Ascending,
                        None,
                        1,
                    )?;
                    let Some(row) = rows.into_iter().next() else {
                        continue;
                    };
                    row.record
                }
            };
            let id = session_message::Id::new(row.id.to_utf8().unwrap_or_default())
                .map_err(|_| error("unknown", "Stored message identity is invalid"))?;
            candidates.push((index, (id, row.seq)));
        }
        if candidates.is_empty() {
            return Ok(Vec::new());
        }
        let mut lower = 0;
        let mut upper = candidates.len();
        while lower < upper {
            let middle = (lower + upper) / 2;
            if compaction_gate::can_reduce(
                input.request,
                &input.history[..=candidates[middle].0],
                cap,
            ) {
                upper = middle;
            } else {
                lower = middle + 1;
            }
        }
        let start = lower.min(candidates.len() - 1);
        let mut boundaries = candidates[start..]
            .iter()
            .chain(
                candidates[..if lower == candidates.len() { start } else { 0 }]
                    .iter()
                    .rev(),
            )
            .map(|(_, boundary)| boundary.clone())
            .collect::<Vec<_>>();
        boundaries.sort_by_key(|(id, seq)| {
            failed
                .iter()
                .any(|(failed_id, failed_seq)| failed_id == id.as_lossless() && failed_seq == seq)
        });
        Ok(boundaries)
    }

    async fn settle(&self, input: &GateInput<'_>, job: &Job) -> Outcome {
        let services = &self.0.services;
        let settled = match self
            .run_compaction(input.session, input.selection, job)
            .await
        {
            Ok(settled) => settled,
            Err(compaction_job::CompactionError::Store(failure)) => return Err(failure.into()),
            Err(failure) => return Err(error("compaction.execution", &failure.to_string())),
        };
        if settled.status.as_str() == Some("ended") {
            services
                .store
                .clear_continuation(&input.session.id, services.clock.now())
                .await?;
        }
        Ok(())
    }

    pub(super) async fn run_compaction(
        &self,
        owner: &session::Info,
        selection: &model::Ref,
        job: &Job,
    ) -> Result<Job, compaction_job::CompactionError> {
        let runner = self.clone();
        let owner = owner.clone();
        let selection = selection.clone();
        let job = job.clone();
        tokio::spawn(async move {
            let lock = runner.ingress_lock(crate::instructions::join(
                &["compact-worker:".into(), owner.id.as_lossless().clone()],
                "",
            ));
            let _guard = lock.lock().await;
            let id = compaction_execution::job_id(&job.id)?;
            let store = &runner.0.services.store;
            if let Some(settled) = store.compaction_job(&id)?
                && matches!(settled.status.as_str(), Some("ended" | "failed"))
            {
                return Ok(settled);
            }
            runner
                .execute_compaction(&owner, &selection, &job, &id)
                .await
        })
        .await
        .map_err(|_| ycoding_store::Error::Domain {
            kind: "compaction.worker",
            message: "Compaction worker stopped before settlement",
        })?
    }

    async fn execute_compaction(
        &self,
        owner: &session::Info,
        selection: &model::Ref,
        job: &Job,
        id: &session_compaction::Id,
    ) -> Result<Job, compaction_job::CompactionError> {
        let services = &self.0.services;
        let attribution = Attribution::explicit(
            job.usage_anchor
                .as_ref()
                .and_then(|anchor| anchor.domain().ok()),
        );
        let _activity = crate::session::usage_activity::contribute(
            &services.store.client,
            owner.id.clone(),
            attribution.anchor().cloned(),
        );
        let helper = self.resolve_helper(owner, selection).await;
        let helper_session = match &helper {
            Some(helper) => Some(self.helper_session(owner, helper, job).await?),
            None => None,
        };
        let resolved = helper.as_ref().zip(helper_session.as_ref());
        let generate =
            |prompt: String| -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>> {
                let attribution = attribution.clone();
                Box::pin(async move {
                    let (helper, session) = resolved?;
                    self.helper_request(helper, session, prompt, attribution)
                        .await
                })
            };
        let generate: Generate<'_> = &generate;
        let policy: &Resolved = &services.compaction;
        let live = |id: &session::Id| {
            live_state::load(&services.store.client, id, || {
                services
                    .guardrails
                    .snapshot(id)
                    .map(|snapshot| live_state::Source {
                        sequence: snapshot.sequence,
                        digest: snapshot.digest,
                    })
            })
            .map(|state| LiveState {
                required_texts: vec![state.text],
                protected_state: live_state::protected_state(&state.sources),
            })
            .map_err(|_| session_compaction::FailureCode::MigrationFailed)
        };
        let builder = |job: Job| -> ManifestFuture<'_> {
            Box::pin(async move {
                compaction::manifest(Input {
                    store: &services.store,
                    job: &job,
                    policy,
                    helper_context_window: resolved.map(|(helper, _)| helper.context_window),
                    generate: resolved.map(|_| generate),
                    live_state: &live,
                })
                .await
            })
        };
        compaction_execution::run(&services.store, &*services.clock, id, &builder).await
    }

    async fn resolve_helper(
        &self,
        owner: &session::Info,
        selection: &model::Ref,
    ) -> Option<Helper> {
        let services = &self.0.services;
        let agents = services.agents.snapshot();
        let scope = if owner.parent_id.is_some() {
            CompactionScope::Subagent
        } else {
            CompactionScope::Main
        };
        let pinned = agents
            .get(&"compaction".into())
            .and_then(|compaction| compaction.model.as_ref());
        let selected = services
            .helpers
            .select(Role::Compaction, scope, pinned, owner.model.as_ref())
            .unwrap_or(selection);
        let saved = services.credentials.all().ok()?;
        let binding = if self.0.standalone.is_some()
            && owner.model.as_ref().is_some_and(|model| {
                model.provider_id == selected.provider_id && model.profile == selected.profile
            }) {
            services.store.profile_binding(&owner.id).ok()?
        } else {
            None
        };
        let resolution = self
            .resolve_model(selected, &saved, binding.as_ref())
            .await
            .ok()?;
        Some(Helper {
            model: resolution.model,
            selection: selected.clone(),
            costs: resolution.resolved.info.cost.clone(),
            account_identity: resolution.account_identity,
            context_window: resolution.resolved.info.limit.context.get(),
            binding: resolution.binding,
        })
    }

    async fn helper_session(
        &self,
        owner: &session::Info,
        helper: &Helper,
        job: &Job,
    ) -> Result<session::Id, compaction_job::CompactionError> {
        let services = &self.0.services;
        let digest = prompt_cache::sha256(&job.id.to_utf8().unwrap_or_default());
        let id = session::Id::new(format!("ses_compaction_{}", &digest[..24])).map_err(|_| {
            compaction_job::CompactionError::Conflict {
                id: Some(job.id.clone()),
                message: "Compaction helper Session identity is invalid".into(),
            }
        })?;
        let now = services.clock.now();
        services
            .store
            .create(NewEvent {
                id: projector::random_event_id()?.as_lossless().clone(),
                aggregate_id: id.as_lossless().clone(),
                created: now,
                type_: "session.created.2".into(),
                data: ObjectEncoder::new()
                    .field("sessionID", &id)
                    .field("projectID", &owner.project_id)
                    .field("scope", &owner.scope)
                    .field("location", &owner.location)
                    .optional("subpath", &owner.subpath)
                    .field(
                        "title",
                        format!("Compaction {}", job.id.to_utf8().unwrap_or_default()).as_str(),
                    )
                    .field("created", &(now as f64))
                    .field("parentID", &owner.id)
                    .field("agent", "compaction")
                    .field("model", &helper.selection)
                    .optional("permissionCeiling", &owner.permission_ceiling)
                    .finish(),
            })
            .await?;
        if let Some(binding) = &helper.binding {
            services
                .store
                .publish(NewEvent {
                    id: projector::random_event_id()?.as_lossless().clone(),
                    aggregate_id: id.as_lossless().clone(),
                    created: now,
                    type_: "session.profile.bound.1".into(),
                    data: ObjectEncoder::new()
                        .field("sessionID", &id)
                        .field("binding", binding)
                        .finish(),
                })
                .await?;
        }
        Ok(id)
    }

    async fn helper_request(
        &self,
        helper: &Helper,
        session: &session::Id,
        prompt: String,
        attribution: Attribution,
    ) -> Option<String> {
        let mut request = llm::Request::new(helper.model.clone());
        request.system = vec![SUMMARY_TEMPLATE.into()];
        request.messages = vec![llm::Message::user(prompt.as_str())];
        request.generation.max_tokens = request.model.defaults.output_limit;
        let capabilities = Capabilities {
            context_window_tokens: helper.context_window,
            max_output_tokens: request.generation.max_tokens.unwrap_or(0.0) as i64,
            context_safety_margin_tokens: self.0.services.compaction.context_safety_margin_tokens,
        };
        if compaction_gate::estimated_provider_input_tokens(&request)
            >= context_pressure::hard_input_cap_tokens(&capabilities)
        {
            return None;
        }
        let streamed = self
            .stream_helper(StreamInput {
                helper,
                session,
                source: "compaction",
                agent: &"compaction".into(),
                permissions: &[],
                system: SUMMARY_TEMPLATE,
                prompt,
                cancellation: None,
                character_limit: None,
                require_stop: true,
                attribution,
            })
            .await?;
        (!streamed.failed && !streamed.text.trim().is_empty()).then_some(streamed.text)
    }

    pub(super) fn latest_complete_boundary(
        &self,
        id: &session::Id,
    ) -> Result<Option<(session_message::Id, i64)>, Error> {
        self.complete_boundary(id, Bound::Unbounded)
    }

    fn complete_boundary(
        &self,
        id: &session::Id,
        upper: Bound<i64>,
    ) -> Result<Option<(session_message::Id, i64)>, Error> {
        let snapshot = self.0.services.store.client.snapshot()?;
        let mut after = None;
        loop {
            let page = ycoding_store::session::messages(
                &snapshot,
                id.as_lossless(),
                Bound::Unbounded,
                upper,
                IndexOrder::Descending,
                after.as_ref(),
                128,
            )?;
            let Some(last) = page.last() else {
                return Ok(None);
            };
            after = Some(last.cursor.clone());
            if let Some(row) = page.iter().find(|row| complete(&row.record)) {
                let message = session_message::Id::new(row.record.id.to_utf8().unwrap_or_default())
                    .map_err(|_| error("unknown", "Stored message identity is invalid"))?;
                return Ok(Some((message, row.record.seq)));
            }
        }
    }
}

fn complete(row: &ycoding_store::session::Message) -> bool {
    let time = |key: &str| {
        let JsonValue::Object(data) = &row.data else {
            return false;
        };
        matches!(
            data.get(&"time".into()),
            Some(JsonValue::Object(time)) if matches!(time.get(&key.into()), Some(JsonValue::Number(_)))
        )
    };
    match row.type_.as_str() {
        Some("user") => time("consumed"),
        Some("assistant" | "shell") => time("completed"),
        Some("compaction") => matches!(
            &row.data,
            JsonValue::Object(data) if matches!(
                data.get(&"status".into()),
                Some(JsonValue::String(status)) if status.as_str() == Some("completed")
            )
        ),
        _ => true,
    }
}

fn budget_error(pressure: i64, cap: i64) -> Error {
    error(
        "context.limit",
        &format!("The request exceeds the input budget of {pressure}/{cap} tokens"),
    )
}

fn non_negative(value: i64) -> ycoding_schema::schema::NonNegativeInt {
    ycoding_schema::schema::NonNegativeInt::new(value.max(0))
        .expect("clamped value is non-negative")
}
