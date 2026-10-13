use super::{Local, error, helper::StreamInput};
use crate::session::{
    compaction::{self, Input, LiveState},
    compaction_execution::{self, ManifestFuture},
    compaction_gate, compaction_job,
    compaction_policy::Resolved,
    compaction_summary::{Generate, SUMMARY_TEMPLATE},
    context_pressure::{self, Capabilities, Usage},
    live_state, projector, prompt_cache,
    run_coordinator::{Error, Outcome},
};
use crate::tools::policy::helper::{CompactionScope, Role};
use std::{future::Future, ops::Bound, pin::Pin};
use ycoding_ai::llm;
use ycoding_schema::{
    JsonValue, ObjectEncoder, model, session, session_compaction, session_event, session_message,
};
use ycoding_store::{
    IndexOrder,
    session::{ContextStateTable, Job, NewEvent},
};

const MAXIMUM_GATE_ADMISSIONS: u8 = 2;

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
    pub admissions: &'a mut u8,
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
            max_output_tokens: input.output_limit,
            context_safety_margin_tokens: policy.context_safety_margin_tokens,
        };
        let cap = context_pressure::hard_input_cap_tokens(&capabilities);
        if cap <= 0 {
            return Ok(Gate::Proceed);
        }
        let estimate = compaction_gate::estimated_provider_input_tokens(input.request);
        let raw = context_pressure::estimated_input_tokens(Usage {
            system: &input.request.system,
            tools: &input.request.tools,
            messages: &input.request.messages,
        });
        let (provider_input, provider_total) = if estimate < raw {
            (None, None)
        } else {
            latest_provider_totals(input.history)
        };
        if !input.force
            && estimate < cap
            && provider_input.is_none_or(|total| total < cap)
            && provider_total.is_none_or(|total| total < cap)
        {
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
        if *input.admissions >= MAXIMUM_GATE_ADMISSIONS {
            return Ok(Gate::Proceed);
        }
        let Some((boundary, seq)) = self.latest_complete_boundary(&input.session.id)? else {
            return Ok(Gate::Proceed);
        };
        let Some(revision) = services
            .store
            .client
            .snapshot()?
            .get::<ContextStateTable>(&crate::session::key(input.session.id.as_lossless()))?
            .map(|state| state.revision)
        else {
            return Ok(Gate::Proceed);
        };
        let pending = services.store.compaction_pending(&input.session.id).await?;
        if let Some(existing) = pending.first() {
            self.settle(&input, existing).await?;
            return Ok(Gate::Restart);
        }
        let target = compaction_gate::target_input_tokens(input.context_window, policy);
        if !compaction_gate::can_reduce(input.request, input.history, target) {
            return Ok(Gate::Proceed);
        }
        let pressure = estimate
            .max(provider_input.unwrap_or(0))
            .max(provider_total.unwrap_or(0));
        let admission = || compaction_job::AdmitInput {
            id: None,
            session: input.session.id.clone(),
            trigger: session_compaction::Trigger::Mandatory,
            requested_through_message: boundary.clone(),
            requested_through_seq: seq,
            base_context_revision: revision,
            target_max_input_tokens: target,
            config_digest: crate::session::compaction_policy::admission_digest(policy),
            pressure: Some(session_compaction::Pressure {
                estimated_input_tokens: non_negative(pressure),
                safe_input_tokens: non_negative(cap),
            }),
        };
        let now = services.clock.now();
        if services
            .store
            .compaction_has_unchanged_deterministic_failure(admission())
            .await?
        {
            return Ok(Gate::Proceed);
        }
        let admitted = match services.store.compaction_admit(admission(), now).await {
            Ok(job) => job,
            Err(compaction_job::CompactionError::Store(failure)) => return Err(failure.into()),
            Err(_) => return Ok(Gate::Proceed),
        };
        *input.admissions += 1;
        self.settle(&input, &admitted).await?;
        Ok(Gate::Restart)
    }

    async fn settle(&self, input: &GateInput<'_>, job: &Job) -> Outcome {
        let services = &self.0.services;
        let settled = match self
            .run_compaction(input.session, input.selection, job)
            .await
        {
            Ok(settled) => settled,
            Err(compaction_job::CompactionError::Store(failure)) => return Err(failure.into()),
            Err(_) => return Ok(()),
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
        let services = &self.0.services;
        let helper = self.resolve_helper(owner, selection).await;
        let helper_session = match &helper {
            Some(helper) => Some(self.helper_session(owner, helper, job).await?),
            None => None,
        };
        let resolved = helper.as_ref().zip(helper_session.as_ref());
        let generate =
            |prompt: String| -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>> {
                Box::pin(async move {
                    let (helper, session) = resolved?;
                    self.helper_request(helper, session, prompt).await
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
        let id = compaction_execution::job_id(&job.id)?;
        compaction_execution::run(&services.store, &*services.clock, &id, &builder).await
    }

    async fn resolve_helper(
        &self,
        owner: &session::Info,
        selection: &model::Ref,
    ) -> Option<Helper> {
        let services = &self.0.services;
        let scope = if owner.parent_id.is_some() {
            CompactionScope::Subagent
        } else {
            CompactionScope::Main
        };
        let pinned = services
            .agents
            .get(&"compaction".into())
            .and_then(|compaction| compaction.model.as_ref());
        let selected = services
            .helpers
            .select(Role::Compaction, scope, pinned, owner.model.as_ref())
            .unwrap_or(selection);
        let saved = services.credentials.all().ok()?;
        let resolution = self.resolve_model(selected, &saved, None).await.ok()?;
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
    ) -> Option<String> {
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
            })
            .await?;
        (!streamed.failed && !streamed.text.trim().is_empty()).then_some(streamed.text)
    }

    pub(super) fn latest_complete_boundary(
        &self,
        id: &session::Id,
    ) -> Result<Option<(session_message::Id, i64)>, Error> {
        let snapshot = self.0.services.store.client.snapshot()?;
        let mut after = None;
        loop {
            let page = ycoding_store::session::messages(
                &snapshot,
                id.as_lossless(),
                Bound::Unbounded,
                Bound::Unbounded,
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
                Some(JsonValue::String(status)) if matches!(status.as_str(), Some("completed" | "failed"))
            )
        ),
        _ => true,
    }
}

fn latest_provider_totals(history: &[session_message::Info]) -> (Option<i64>, Option<i64>) {
    let Some(tokens) = history.iter().rev().find_map(|message| match message {
        session_message::Info::Assistant(assistant) => assistant.tokens.as_ref(),
        _ => None,
    }) else {
        return (None, None);
    };
    let input = tokens.input.get() + tokens.cache.read.get() + tokens.cache.write.get();
    (
        Some(input as i64),
        Some((input + tokens.output.get() + tokens.reasoning.get()) as i64),
    )
}

fn non_negative(value: i64) -> ycoding_schema::schema::NonNegativeInt {
    ycoding_schema::schema::NonNegativeInt::new(value.max(0))
        .expect("clamped value is non-negative")
}
