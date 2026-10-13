mod compaction;
mod diagnostics;
mod helper;
mod ingress;
mod max_steps;
mod messages;
mod notifier;
mod publisher;

pub use ingress::{CommandInput, IngressError, ShellInput};
pub use notifier::{Wake, mcp_notifier};
pub use ycoding_ai::route::Executor;

use super::{
    cache_diagnostics, compaction_gate, continuation, execution, history, live_state,
    orchestration, projector, prompt_cache, provider_request,
    run_coordinator::{Drain, DrainRequest, Error, Outcome, RunFuture},
    skill,
    store::Service,
    usage,
};
use crate::{
    instructions::Source,
    resources::{agent, attachment_store, credential, cursor, model},
    tools::{
        code_mode,
        context::{Context, Progress},
        materialization,
        registry::Registry,
    },
};
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};
use ycoding_ai::{llm, provider_error};
use ycoding_schema::{
    DomainDecode, JsonObject, JsonValue, LosslessString, ObjectEncoder, instruction, session,
    session_message, session_pending, skill as skill_schema,
};

pub trait Clock: Send + Sync {
    fn now(&self) -> i64;
    fn nanos(&self) -> u64 {
        static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        START
            .get_or_init(std::time::Instant::now)
            .elapsed()
            .as_nanos() as u64
    }
    fn sleep(&self, milliseconds: u64) -> Pin<Box<dyn Future<Output = ()> + Send>>;
}
pub struct WallClock;
impl Clock for WallClock {
    fn now(&self) -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
    fn sleep(&self, milliseconds: u64) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        Box::pin(tokio::time::sleep(std::time::Duration::from_millis(
            milliseconds,
        )))
    }
}

pub struct Services {
    pub store: Service,
    pub events: crate::event_feed::Feed,
    pub location: ycoding_schema::location::Ref,
    pub models: Arc<model::Resolver>,
    pub agents: Arc<agent::Service>,
    pub credentials: credential::Service,
    pub tools: Arc<Registry>,
    pub attachments: Arc<attachment_store::Store>,
    pub instructions: Vec<Source>,
    pub analysis: Option<Arc<super::analysis::Analysis>>,
    pub clock: Arc<dyn Clock>,
    pub executor: Arc<Executor>,
    pub compaction: super::compaction_policy::Resolved,
    pub guardrails: crate::process::guardrails::Guardrails,
    pub helpers: crate::tools::policy::helper::Settings,
    pub cursor: Option<crate::resources::cursor::route::Host>,
    pub claude: Option<model::ClaudeHost>,
    pub auth: Option<crate::resources::auth::Preparation>,
    pub skill_resolver: Option<Arc<dyn skill::Resolver>>,
    pub snapshots: Option<Arc<dyn super::revert::Snapshots + Send + Sync>>,
    pub configuration: Option<Arc<crate::resources::config::Configuration>>,
    pub image_analyzer: Option<super::image_analyzer::Service>,
    pub extensions: Vec<Arc<crate::extension::Extension>>,
    pub session_tools: Option<crate::tools::context::consumers::SessionTools>,
}

struct Work {
    assistant: session_message::Id,
    tasks: tokio::sync::Mutex<tokio::task::JoinSet<Outcome>>,
    cancellation: code_mode::Cancellation,
    progress_error: Mutex<Option<Error>>,
    usage: Mutex<Option<JsonValue>>,
    attempts: std::sync::atomic::AtomicU32,
    timing: Mutex<Timing>,
    recording: Mutex<Option<Recording>>,
    continuation_used: bool,
    fallback: std::sync::atomic::AtomicBool,
    overflow: std::sync::atomic::AtomicBool,
    text_only: bool,
    start_snapshot: Option<ycoding_schema::snapshot::Id>,
}
#[derive(Clone, Copy, PartialEq)]
enum Overflow {
    Pending,
    Used,
}
struct Timing {
    started: std::time::Instant,
    first_output: Option<std::time::Instant>,
    ended: Option<std::time::Instant>,
    waiting: Option<std::time::Instant>,
    retry_wait: std::time::Duration,
    generation: usage::GenerationTimes,
}
struct Recording {
    tracked: Tracked,
    agent: ycoding_schema::agent::Id,
    costs: Vec<ycoding_schema::model::Cost>,
    route_id: String,
}
#[derive(Clone)]
struct Tracked {
    begin: provider_request::Begin,
    pending: provider_request::Pending,
    continuation: ContinuationPlan,
}
#[derive(Clone)]
struct ContinuationPlan {
    fingerprint: continuation::Fingerprint,
    eligible: bool,
    used: bool,
}
struct Inner {
    services: Services,
    providers: Result<model::ProviderContext, model::Error>,
    active: Mutex<BTreeMap<session::Id, Arc<Work>>>,
    ingress: Mutex<BTreeMap<ycoding_schema::LosslessString, Arc<tokio::sync::Mutex<()>>>>,
}
#[derive(Clone)]
pub struct Local(Arc<Inner>);

enum AttemptError {
    Provider(ycoding_ai::Error),
    Local(Error),
}
impl From<Error> for AttemptError {
    fn from(error: Error) -> Self {
        Self::Local(error)
    }
}
struct Consumption<'a> {
    ids: &'a [session_message::Id],
    observed: bool,
}

struct Resolution {
    resolved: model::Resolved,
    model: llm::Model,
    account_identity: Option<String>,
    connection: Option<credential::Info>,
    binding: Option<ycoding_schema::session_event::ProfileBinding>,
}

struct SelectedModel {
    resolved: model::Resolved,
    account_identity: Option<String>,
    connection: Option<credential::Info>,
    binding: Option<ycoding_schema::session_event::ProfileBinding>,
}

impl Local {
    pub fn new(services: Services) -> Self {
        let providers = services
            .auth
            .as_ref()
            .and_then(|auth| auth.providers.clone())
            .map(Ok)
            .unwrap_or_else(|| {
                model::ProviderContext::new(std::env::vars().collect(), env!("CARGO_PKG_VERSION"))
            });
        Self(Arc::new(Inner {
            services,
            providers,
            active: Mutex::new(BTreeMap::new()),
            ingress: Mutex::new(BTreeMap::new()),
        }))
    }

    fn select_model(
        &self,
        selection: &ycoding_schema::model::Ref,
        saved: &[credential::Info],
        saved_binding: Option<&ycoding_schema::session_event::ProfileBinding>,
    ) -> Result<SelectedModel, Error> {
        let services = &self.0.services;
        let catalog = services.models.catalog();
        let provider = catalog.provider(&selection.provider_id).ok_or_else(|| {
            model_resolution_error(selection, model::Error::ModelUnavailable, None)
        })?;
        let integration = provider
            .integration_id
            .as_ref()
            .map(|id| id.as_lossless())
            .unwrap_or(&provider.id.0);
        let binding = selection
            .profile
            .as_ref()
            .map(|profile| {
                if let Some(binding) = saved_binding.filter(|binding| {
                    binding.provider_id == selection.provider_id && binding.profile == *profile
                }) {
                    return Ok(credential::Binding::from_domain(binding.clone()));
                }
                services.credentials.bind(
                    selection.provider_id.0.clone(),
                    integration.clone(),
                    profile.0.clone(),
                )
            })
            .transpose()
            .map_err(|_| {
                error(
                    "model.profile",
                    "Selected profile is unavailable; select the profile again",
                )
            })?;
        let connection = if let (Some(binding), Some(profile)) = (&binding, &selection.profile) {
            Some(
                services
                    .credentials
                    .resolve_selection(&selection.provider_id.0, integration, &profile.0, binding)
                    .map_err(|_| {
                        error(
                            "model.profile",
                            "Selected profile is unavailable; select the profile again",
                        )
                    })?,
            )
        } else {
            services
                .credentials
                .active(integration)
                .map_err(|_| error("provider.auth", "Provider account is unavailable"))?
        };
        let resolved = model::resolve_catalog(&catalog, selection, saved, connection.as_ref())
            .map_err(|cause| model_resolution_error(selection, cause, None))?;
        let account_identity =
            account_identity_digest(connection.as_ref(), &resolved.info, integration);
        let binding = binding
            .map(|binding| binding.domain())
            .transpose()
            .map_err(|_| error("model.profile", "Selected profile binding is invalid"))?;
        Ok(SelectedModel {
            resolved,
            account_identity,
            connection,
            binding,
        })
    }

    async fn resolve_model(
        &self,
        selection: &ycoding_schema::model::Ref,
        saved: &[credential::Info],
        saved_binding: Option<&ycoding_schema::session_event::ProfileBinding>,
    ) -> Result<Resolution, Error> {
        let services = &self.0.services;
        let selected = self.select_model(selection, saved, saved_binding)?;
        let SelectedModel {
            resolved,
            account_identity,
            connection,
            binding,
        } = selected;
        let preparation = services.auth.clone().unwrap_or_default();
        let secret = match &connection {
            Some(connection) => {
                let prepared = preparation
                    .prepare_value(
                        &services.credentials,
                        connection.clone(),
                        services.clock.now(),
                        services.claude.as_ref().map(|host| &host.accounts),
                    )
                    .await
                    .map_err(|_| error("model.profile", if connection.integration_id().as_str() == Some("anthropic") {
                        ycoding_ai::claude_code::RECONNECT
                    } else {
                        "Selected profile requires reconnect. Sign in to this profile again."
                    }))?;
                Some(
                    prepared
                        .domain()
                        .map_err(|_| error("provider.auth", "Provider credentials are invalid"))?,
                )
            }
            None => None,
        };
        let context = self
            .0
            .providers
            .as_ref()
            .map_err(|_| error("provider.auth", "Provider context is unavailable"))?;
        let model = context
            .selected_model(
                &resolved.info,
                secret.as_ref(),
                connection.as_ref(),
                services.claude.as_ref(),
                services.cursor.as_ref(),
                preparation.cursor.as_ref(),
            )
            .await
            .map_err(|cause| match cause {
                model::Error::ProfileUnavailable => error(
                    "model.profile",
                    "Selected profile requires reconnect. Sign in to this profile again.",
                ),
                cause => model_resolution_error(selection, cause, resolved.info.package.as_ref()),
            })?;
        Ok(Resolution {
            resolved,
            model,
            account_identity,
            connection,
            binding,
        })
    }

    async fn resolve_requested_skills(
        &self,
        session: &session::Info,
        agent: &ycoding_schema::agent::Info,
        inputs: &[ycoding_store::session::Pending],
    ) -> Result<Vec<(skill_schema::Info, ycoding_schema::LosslessString)>, Error> {
        let services = &self.0.services;
        let mut requested = Vec::new();
        let mut has_mentions = false;
        for input in inputs
            .iter()
            .filter(|input| input.type_.as_str() == Some("user"))
        {
            let data = session_pending::UserData::decode(&input.data)
                .map_err(|_| error("skill.unavailable", "Pending skill metadata is invalid"))?;
            requested.extend(skill::selected(data.metadata.as_ref()));
            has_mentions |= data.text.code_units().any(|unit| unit == u16::from(b'$'));
        }
        let Some(resolver) = &services.skill_resolver else {
            if requested.is_empty() {
                return Ok(Vec::new());
            }
            return Err(error(
                "skill.unavailable",
                "Session skill catalog is unavailable",
            ));
        };
        if requested.is_empty() && !has_mentions {
            return Ok(Vec::new());
        }
        let catalog = resolver
            .list()
            .await
            .map_err(|_| error("skill.unavailable", "Session skills could not be listed"))?;
        let available = catalog
            .iter()
            .map(|skill| skill.id.clone())
            .collect::<Vec<_>>();
        for input in inputs
            .iter()
            .filter(|input| input.type_.as_str() == Some("user"))
        {
            let data = session_pending::UserData::decode(&input.data)
                .map_err(|_| error("skill.unavailable", "Pending skill metadata is invalid"))?;
            requested.extend(skill::selected(data.metadata.as_ref()));
            requested.extend(skill::mentions(&data.text, &available));
        }
        let mut ids = Vec::new();
        for id in requested {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut permissions = agent.permissions.clone();
        permissions.extend(
            session
                .permission_ceiling
                .as_deref()
                .unwrap_or_default()
                .iter()
                .cloned(),
        );
        let mut resolved = Vec::new();
        for id in ids {
            let Some(info) = catalog.iter().find(|info| info.id == id) else {
                return Err(error(
                    "skill.unavailable",
                    &format!("Skill unavailable: {}", id.to_utf8().unwrap_or_default()),
                ));
            };
            if crate::tools::policy::evaluate(&"skill".into(), &id, &permissions)
                .effect
                .0
                .as_str()
                == Some("deny")
            {
                return Err(error(
                    "permission.rejected",
                    &format!(
                        "Permission denied: skill ({})",
                        id.to_utf8().unwrap_or_default()
                    ),
                ));
            }
            let content = resolver.instructions(info).await.map_err(|_| {
                error(
                    "skill.unavailable",
                    "Skill instructions could not be loaded",
                )
            })?;
            resolved.push((info.clone(), content));
        }
        Ok(resolved)
    }

    async fn activate_skills(
        &self,
        session: &session::Info,
        assembly: &super::instruction_assembly::Assembly,
        skills: Vec<(skill_schema::Info, ycoding_schema::LosslessString)>,
    ) -> Outcome {
        let services = &self.0.services;
        let lock = self.ingress_lock(crate::instructions::join(
            &["skill:".into(), session.id.as_lossless().clone()],
            "",
        ));
        let _guard = lock.lock().await;
        let instruction_keys = assembly
            .current
            .iter()
            .filter_map(|(key, _)| instruction::Key::decode(&JsonValue::String(key.clone())).ok())
            .collect::<Vec<_>>();
        for (info, content) in skills {
            if services
                .store
                .skills(&session.id, &instruction_keys)?
                .iter()
                .any(|status| {
                    status.id == info.id
                        && status.state == ycoding_schema::session_skill_status::State::Active
                })
            {
                continue;
            }
            super::skill::activate(
                &services.store,
                &session.id,
                ObjectEncoder::new()
                    .field("id", &info.id)
                    .field("name", &info.name)
                    .field("text", &content)
                    .optional("conflicts", &info.conflicts)
                    .finish(),
                services.clock.now(),
            )
            .await?;
        }
        Ok(())
    }

    async fn run(&self, request: DrainRequest) -> Outcome {
        let services = &self.0.services;
        let mut step = 1u64;
        let mut force = request.force;
        let mut recovery = false;
        let mut recovery_used = false;
        let mut continuation = false;
        let mut gate_admissions = 0u8;
        let mut gate_rounds = 0u8;
        let mut overflow = None;
        let mut restart: Option<(session_message::Id, u32, provider_request::Pending)> = None;
        let mut request_skills: Vec<(skill_schema::Info, ycoding_schema::LosslessString)> =
            Vec::new();
        loop {
            let pending = services.store.pending_list(&request.session_id)?;
            let eligible = services.store.has_eligible_pending(&request.session_id)?;
            if !force && !eligible {
                return Ok(());
            }
            let session = services
                .store
                .get(&request.session_id)?
                .ok_or_else(|| error("not_found", "Session not found"))?;
            if session.location != services.location {
                return Err(error("location", "Session belongs to another Location"));
            }
            let agent = services
                .agents
                .resolve(session.agent.as_ref())
                .ok_or_else(|| error("agent.not-found", "Selected agent is unavailable"))?;
            let saved = services
                .credentials
                .all()
                .map_err(|_| error("provider.auth", "Credentials could not be read"))?;
            let selection = session
                .model
                .as_ref()
                .or(agent.model.as_ref())
                .cloned()
                .or_else(|| services.models.catalog().default_selection(&saved))
                .ok_or_else(|| error("model.not-selected", "No model is selected"))?;
            let saved_binding = services.store.profile_binding(&session.id)?;
            let Resolution {
                resolved,
                mut model,
                account_identity,
                connection,
                binding,
            } = self
                .resolve_model(&selection, &saved, saved_binding.as_ref())
                .await?;
            if let Some(daybreak) = &session.daybreak
                && resolved.info.provider_id.0 == "openai".into()
                && matches!(
                    model.route.id.as_str(),
                    ycoding_ai::openai_codex::ROUTE_ID
                        | ycoding_ai::openai_codex::WEBSOCKET_ROUTE_ID
                )
                && resolved
                    .info
                    .daybreak
                    .as_ref()
                    .is_some_and(|programs| programs.contains(daybreak))
            {
                let route = Arc::make_mut(&mut model.route);
                route.defaults.http.body = Some(crate::resources::catalog::merge_json(
                    route
                        .defaults
                        .http
                        .body
                        .as_ref()
                        .unwrap_or(&crate::resources::catalog::object(&[])),
                    &crate::resources::catalog::object(&[(
                        "access_programs",
                        crate::resources::catalog::object(&[(
                            "cyber",
                            JsonValue::String(daybreak.0.clone()),
                        )]),
                    )]),
                ));
            }
            let mut prepared = llm::Request::new(model);
            for (name, value) in agent.request.headers.iter() {
                let invalid = || {
                    error(
                        "agent.request",
                        "Selected agent request headers are invalid",
                    )
                };
                let name = name.to_utf8().map_err(|_| invalid())?;
                let JsonValue::String(value) = value else {
                    return Err(invalid());
                };
                let value = value.to_utf8().map_err(|_| invalid())?;
                prepared
                    .model
                    .defaults
                    .http
                    .headers
                    .retain(|key, _| !key.eq_ignore_ascii_case(&name));
                prepared.http.headers.insert(name, value);
            }
            let body = &agent.request.body.0;
            for (name, target) in [
                ("max_tokens", &mut prepared.generation.max_tokens),
                ("temperature", &mut prepared.generation.temperature),
                ("top_p", &mut prepared.generation.top_p),
                ("top_k", &mut prepared.generation.top_k),
                (
                    "frequency_penalty",
                    &mut prepared.generation.frequency_penalty,
                ),
                (
                    "presence_penalty",
                    &mut prepared.generation.presence_penalty,
                ),
                ("seed", &mut prepared.generation.seed),
            ] {
                if let Some(value) = body.get(&name.into()) {
                    let JsonValue::Number(value) = value else {
                        return Err(error(
                            "agent.request",
                            "Selected agent generation options are invalid",
                        ));
                    };
                    *target = Some(*value);
                }
            }
            if let Some(value) = body.get(&"stop".into()) {
                let JsonValue::Array(values) = value else {
                    return Err(error(
                        "agent.request",
                        "Selected agent stop sequences are invalid",
                    ));
                };
                prepared.generation.stop = Some(
                    values
                        .iter()
                        .map(|value| match value {
                            JsonValue::String(value) => Ok(value.clone()),
                            _ => Err(error(
                                "agent.request",
                                "Selected agent stop sequences are invalid",
                            )),
                        })
                        .collect::<Result<_, _>>()?,
                );
            }
            let mut overlay = ycoding_schema::JsonObject::new();
            for (name, value) in body.iter().filter(|(name, _)| {
                !matches!(
                    name.as_str(),
                    Some(
                        "max_tokens"
                            | "temperature"
                            | "top_p"
                            | "top_k"
                            | "frequency_penalty"
                            | "presence_penalty"
                            | "seed"
                            | "stop"
                    )
                )
            }) {
                overlay.insert(name.clone(), value.clone());
            }
            prepared.http.body = (!overlay.is_empty()).then_some(JsonValue::Object(overlay));
            if saved_binding != binding {
                publish(
                    &services.store,
                    &session.id,
                    None,
                    "session.profile.bound",
                    ObjectEncoder::new().optional("binding", &binding).finish(),
                    services.clock.now(),
                )
                .await?;
            }
            let sources = crate::instructions::combine(vec![
                services.instructions.clone(),
                services.store.instruction_entry_sources(&session.id)?,
            ])
            .map_err(|_| error("instructions", "Instruction source keys are duplicated"))?;
            services
                .store
                .prepare_instructions(&session.id, &sources, services.clock.now())
                .await
                .map_err(|_| error("instructions", "Session instructions could not be prepared"))?;
            let assembly = services
                .store
                .assemble_instructions(&session.id, &sources)
                .map_err(|_| {
                    error(
                        "instructions",
                        "Session instructions could not be assembled",
                    )
                })?;
            let mut to_promote = if eligible && !continuation {
                pending
                    .iter()
                    .find(|pending| {
                        pending
                            .delivery
                            .as_ref()
                            .and_then(|delivery| delivery.as_str())
                            == Some("queue")
                    })
                    .cloned()
                    .into_iter()
                    .collect::<Vec<_>>()
            } else {
                Vec::new()
            };
            to_promote.extend(
                pending
                    .iter()
                    .filter(|pending| {
                        pending
                            .delivery
                            .as_ref()
                            .and_then(|delivery| delivery.as_str())
                            == Some("steer")
                    })
                    .cloned(),
            );
            let mut promoted = 0;
            let mut promoted_skills = Vec::new();
            if !to_promote.is_empty() && !services.store.has_pending_compaction(&session.id)? {
                for input in to_promote {
                    let prepared = self
                        .resolve_requested_skills(&session, agent, std::slice::from_ref(&input))
                        .await?;
                    match services
                        .store
                        .promote_input(&session.id, &input.id, services.clock.now())
                        .await?
                    {
                        super::pending::Promotion::Promoted
                        | super::pending::Promotion::Reconciled => promoted += 1,
                        super::pending::Promotion::Missing => break,
                    }
                    promoted_skills.extend(prepared.clone());
                    self.activate_skills(&session, &assembly, prepared).await?;
                }
            }
            if promoted > 0 {
                request_skills = promoted_skills;
                step = 1;
                recovery = false;
                recovery_used = false;
            }
            self.activate_skills(&session, &assembly, request_skills.clone())
                .await?;
            self.observe_context(
                &session.id,
                agent.steps.as_ref().map(|maximum| maximum.get() as u64),
                step,
                recovery,
            )
            .await?;
            let mut entries = services.store.model_history(&session.id)?;
            entries.extend(assembly.updates);
            entries.sort_by_key(|entry| entry.seq);
            let loaded = entries
                .into_iter()
                .map(|entry| entry.message)
                .collect::<Vec<_>>();
            let inputs = loaded
                .iter()
                .filter_map(|message| {
                    if let session_message::Info::User(user) = message {
                        user.time.consumed.is_none().then(|| user.id.clone())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>();
            let mut permissions = agent.permissions.clone();
            permissions.extend(
                session
                    .permission_ceiling
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .cloned(),
            );
            let materialized = Arc::new(services.tools.materialize(&permissions));
            prepared.http.headers.extend(
                helper::cursor_session_headers(
                    &session.id,
                    &session.project_id,
                    session.parent_id.as_ref(),
                    account_identity.as_deref(),
                )
                .into_iter()
                .filter(|(name, _)| matches!(name.as_str(), "x-ycoding-session" | "x-session-id")),
            );
            if !assembly.initial.is_empty() {
                prepared.system.push(assembly.initial.into());
            }
            if let Some(system) = &agent.system {
                prepared.system.push(system.clone().into());
            }
            let metadata_key = prepared
                .model
                .route
                .provider_metadata_key
                .clone()
                .unwrap_or_else(|| prepared.model.provider.0.to_utf8().unwrap_or_default());
            let direct_responses = prepared.model.provider.0.as_str() == Some("openai")
                && continuation::is_responses_route(&prepared.model.route.id);
            let efficiency = prompt_cache::Settings::read(services.configuration.as_deref());
            if direct_responses {
                prepared.provider_options = Some(with_openai(
                    ObjectEncoder::new()
                        .field("openai", &JsonObject::new())
                        .finish(),
                    &[("store", JsonValue::Bool(efficiency.responses_stored))],
                ));
            }
            let accounts = match &account_identity {
                Some(digest) => services.store.provider_accounts(&session.id, digest)?,
                None => Default::default(),
            };
            let states = if stateless(&prepared) {
                services.store.provider_states(
                    &session.id,
                    &prepared.model.provider.0,
                    &text(&selection.id),
                    &accounts,
                )?
            } else {
                Default::default()
            };
            let replay = messages::Replay {
                model: selection.clone(),
                metadata_key: metadata_key.clone(),
                accounts,
                states,
            };
            let descriptions =
                if super::image_analyzer::is_multimodal(Some(&resolved.info.capabilities)) {
                    None
                } else if let Some(analyzer) = &services.image_analyzer {
                    let mut image_session = session.clone();
                    image_session.model = Some(selection.clone());
                    analyzer
                        .descriptions_for_history(
                            &loaded,
                            &services.attachments,
                            &image_session,
                            Some(&resolved.info.capabilities),
                            &code_mode::Cancellation::default(),
                        )
                        .await
                        .map_err(|_| error("image.analysis", "Image analysis cancelled"))?
                } else {
                    let collected = super::image_analyzer::collect(&loaded, &services.attachments);
                    let reason = if services
                        .configuration
                        .as_ref()
                        .and_then(|config| config.latest("image_analyzer"))
                        .is_none()
                    {
                        "image analyzer not configured"
                    } else {
                        "vision analyzer unavailable"
                    };
                    let descriptions = collected
                        .inputs
                        .iter()
                        .map(|input| {
                            (
                                input.file.digest.clone(),
                                super::image_analyzer::failure_block(&input.file, reason),
                            )
                        })
                        .collect::<BTreeMap<_, _>>();
                    let tools = collected
                        .tool_uris
                        .into_iter()
                        .filter_map(|(uri, digest)| {
                            descriptions
                                .get(&digest)
                                .map(|description| (uri, description.clone()))
                        })
                        .collect();
                    Some(super::image_analyzer::Descriptions {
                        attachments: descriptions,
                        tools,
                    })
                };
            let lowered = loaded
                .iter()
                .map(|message| {
                    messages::convert(
                        std::slice::from_ref(message),
                        &services.attachments,
                        &replay,
                        descriptions.as_ref(),
                    )
                })
                .collect::<Vec<_>>();
            prepared.messages = lowered.iter().flatten().cloned().collect();
            let text_only = recovery
                || agent
                    .steps
                    .as_ref()
                    .is_some_and(|maximum| step >= maximum.get() as u64);
            prepared.tools = if text_only {
                Vec::new()
            } else {
                materialized.definitions.clone()
            };
            if let Some(tools) = services.session_tools.as_ref().filter(|_| !text_only) {
                let context = Context {
                    session_id: session.id.clone(),
                    agent: agent.id.clone(),
                    message_id: match inputs.last() {
                        Some(message) => message.clone(),
                        None => session_message::Id::from_event(&projector::random_event_id()?),
                    },
                    call_id: "session.tools".into(),
                    progress: None,
                    cancellation: Default::default(),
                };
                tools.decorate(&context, &mut prepared.tools).map_err(|_| {
                    error("session.tools", "Session tool definitions are unavailable")
                })?;
            }
            if text_only {
                prepared.tool_choice = Some(llm::ToolChoice::None);
            }
            if !services.extensions.is_empty() {
                let context = Context {
                    session_id: session.id.clone(),
                    agent: agent.id.clone(),
                    message_id: match inputs.last() {
                        Some(message) => message.clone(),
                        None => session_message::Id::from_event(&projector::random_event_id()?),
                    },
                    call_id: "session.context".into(),
                    progress: None,
                    cancellation: code_mode::Cancellation::default(),
                };
                prepared = crate::extension::context::prepare(
                    &prepared,
                    &selection,
                    Some(&prepared.model.route.id),
                    &context,
                    &services
                        .extensions
                        .iter()
                        .map(Arc::as_ref)
                        .collect::<Vec<_>>(),
                )
                .await
                .map_err(|error_| error("extension.context", &error_.to_string()))?;
            }
            prompt_cache::canonical_tools(&mut prepared.tools);
            if let Some(analysis) = &services.analysis {
                analysis.restrict(&session.id, &mut prepared)?;
            }
            prepared.system = cursor::system::system(&prepared.model, &prepared.system);
            prepared.generation.max_tokens = prepared
                .generation
                .max_tokens
                .or(prepared.model.defaults.output_limit);
            let context_window = resolved.info.limit.context.get();
            let gate = self
                .ensure_within_limit(compaction::GateInput {
                    agent: &agent.id,
                    session: &session,
                    selection: &selection,
                    context_window,
                    request: &prepared,
                    history: &loaded,
                    output_limit: resolved.info.limit.output.get(),
                    force: overflow == Some(Overflow::Pending) && gate_rounds == 0,
                    admissions: &mut gate_admissions,
                })
                .await?;
            if matches!(gate, compaction::Gate::Restart) {
                gate_rounds += 1;
                force = true;
                continue;
            }
            if overflow == Some(Overflow::Pending) {
                overflow = Some(Overflow::Used);
            }
            let begin = provider_request::Begin {
                session: session.id.clone(),
                model: selection.clone(),
                route_id: prepared.model.route.id.clone(),
                connection_identity_digest: account_identity.clone(),
                prompt_cache_key: prompt_cache::namespace(&prompt_cache::Namespace {
                    project_id: text(&session.project_id),
                    directory: text(&session.location.directory),
                    workspace_id: session.location.workspace_id.as_ref().map(text),
                    provider_id: text(&selection.provider_id),
                    model_id: text(&selection.id),
                    variant: selection.variant.as_ref().map(text),
                    account_identity_digest: account_identity.as_deref(),
                    permissions: &permissions,
                    system: &prepared.system,
                    tools: &prepared.tools,
                }),
                system_digest: prompt_cache::system_digest(&prepared.system),
                tool_digest: prompt_cache::tool_digest(&prepared.tools),
            };
            let project_id = text(&session.project_id);
            let provider_id = text(&selection.provider_id);
            let session_text = session.id.as_lossless().clone();
            let cache = prompt_cache::provider_options(&prompt_cache::OptionsInput {
                route_id: &prepared.model.route.id,
                api_model_id: prepared.model.id.as_str().unwrap_or_default(),
                session_id: &session_text,
                project_id: &project_id,
                provider_id: &provider_id,
                baseline_key: &begin.prompt_cache_key,
                interactive: session.parent_id.is_none(),
                settings: &efficiency,
            });
            let mut openai_options = vec![];
            if direct_responses {
                openai_options.push(("store", JsonValue::Bool(efficiency.responses_stored)));
            }
            prepared.provider_options =
                Some(with_openai(cache.provider_options.clone(), &openai_options));
            if let Some(policy) = cache.cache.clone() {
                prepared.cache = policy;
            }
            let authority = if direct_responses {
                let authority = services.store.continuation_authority(&session.id).await?;
                (authority.generation, authority.context_revision)
            } else {
                (0, 0)
            };
            let fingerprint = continuation::Fingerprint {
                session: session_text.clone(),
                context_revision: authority.1,
                continuation_generation: authority.0,
                provider: prepared.model.provider.0.to_utf8().unwrap_or_default(),
                route_id: prepared.model.route.id.clone(),
                model_id: text(&selection.id).to_utf8().unwrap_or_default(),
                variant: selection
                    .variant
                    .as_ref()
                    .map(|variant| text(variant).to_utf8().unwrap_or_default()),
                connection_identity_digest: connection_identity_digest(
                    &resolved.info,
                    &selection,
                    &prepared.model.route.id,
                    &prepared.model.route.endpoint.base_url,
                    account_identity.as_deref(),
                    connection.as_ref(),
                ),
                represented_through_message_id: loaded.last().and_then(message_id),
                represented_message_count: loaded.len() as i64,
                prompt_cache_key: begin.prompt_cache_key.clone(),
                instructions_digest: continuation::instructions_digest(
                    &prepared.system,
                    &prepared
                        .messages
                        .iter()
                        .filter(|message| message.role == llm::Role::System)
                        .collect::<Vec<_>>(),
                ),
                tools_digest: begin.tool_digest.clone(),
                options_digest: continuation::options_digest(&prepared),
                volatile_context_digest: continuation::volatile_digest(&[]),
            };
            let eligible = direct_responses
                && account_identity.is_some()
                && efficiency.responses_stored
                && efficiency.responses_continuation
                && !stateless(&prepared)
                && !recovery
                && !services
                    .analysis
                    .as_ref()
                    .is_some_and(|analysis| analysis.contains(&session.id));
            let state = if eligible {
                services.store.select_continuation(
                    &fingerprint,
                    &loaded.iter().filter_map(message_id).collect::<Vec<_>>(),
                )?
            } else {
                None
            };
            if let Some(state) = &state {
                let start = lowered
                    .iter()
                    .take(state.fingerprint.represented_message_count as usize)
                    .map(Vec::len)
                    .sum::<usize>()
                    + 1;
                openai_options.push((
                    "previousResponseId",
                    JsonValue::String(state.response_id.clone()),
                ));
                openai_options.push(("continuationInputStart", JsonValue::Number(start as f64)));
                prepared.provider_options =
                    Some(with_openai(cache.provider_options, &openai_options));
            }
            let continuation_plan = ContinuationPlan {
                fingerprint,
                eligible,
                used: state.is_some(),
            };
            let resumed = restart.take();
            let assistant = match &resumed {
                Some((assistant, ..)) => assistant.clone(),
                None => session_message::Id::from_event(&projector::random_event_id()?),
            };
            prepared.caller = Some(llm::Caller {
                session_id: session.id.as_lossless().clone(),
                agent: agent.id.clone(),
                message_id: assistant.as_lossless().clone(),
            });
            let tracked = Tracked {
                pending: match &resumed {
                    Some((_, _, pending)) => pending.clone(),
                    None => services.store.begin_provider_request(&begin).await?,
                },
                begin,
                continuation: continuation_plan,
            };
            let work = Arc::new(Work {
                assistant: assistant.clone(),
                tasks: tokio::sync::Mutex::new(tokio::task::JoinSet::new()),
                cancellation: code_mode::Cancellation::default(),
                progress_error: Mutex::new(None),
                usage: Mutex::new(None),
                attempts: std::sync::atomic::AtomicU32::new(
                    resumed.as_ref().map_or(0, |(_, attempts, _)| *attempts),
                ),
                timing: Mutex::new(Timing {
                    started: std::time::Instant::now(),
                    first_output: None,
                    ended: None,
                    waiting: None,
                    retry_wait: std::time::Duration::ZERO,
                    generation: usage::GenerationTimes::default(),
                }),
                recording: Mutex::new(None),
                continuation_used: tracked.continuation.used,
                fallback: std::sync::atomic::AtomicBool::new(false),
                overflow: std::sync::atomic::AtomicBool::new(false),
                text_only,
                start_snapshot: if resumed.is_some() {
                    services
                        .store
                        .message(&assistant)?
                        .and_then(|(_, message)| match message {
                            session_message::Info::Assistant(assistant) => {
                                assistant.snapshot.and_then(|snapshot| snapshot.start)
                            }
                            _ => None,
                        })
                } else {
                    services
                        .snapshots
                        .as_ref()
                        .and_then(|snapshots| snapshots.capture())
                },
            });
            self.0
                .active
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(session.id.clone(), work.clone());
            if resumed.is_none() {
                publish(
                    &services.store,
                    &session.id,
                    Some(&assistant),
                    "session.step.started",
                    ObjectEncoder::new()
                        .field("agent", &agent.id)
                        .field("model", &selection)
                        .optional("snapshot", &work.start_snapshot)
                        .finish(),
                    services.clock.now(),
                )
                .await?;
            }
            *work
                .recording
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = Some(Recording {
                tracked: tracked.clone(),
                agent: agent.id.clone(),
                costs: resolved.info.cost.clone(),
                route_id: prepared.model.route.id.clone(),
            });
            let mut publisher = publisher::Publisher::new(
                services.store.clone(),
                services.events.clone(),
                services.location.clone(),
                session.id.clone(),
                assistant.clone(),
                metadata_key.clone(),
            );
            let result = self
                .attempt(
                    &prepared,
                    &mut publisher,
                    &inputs,
                    materialized,
                    &agent.id,
                    &work,
                )
                .await;
            let mut tasks = work.tasks.lock().await;
            let mut tool_error = None;
            while let Some(result) = tasks.join_next().await {
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => tool_error = Some(error),
                    Err(_) => tool_error = Some(error("tool.execution", "Tool task panicked")),
                }
            }
            drop(tasks);
            if let Some(error) = work
                .progress_error
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take()
            {
                tool_error = Some(error);
            }
            let result = result.and_then(|_| tool_error.map_or(Ok(()), Err));
            publisher.flush(services.clock.now()).await?;
            if let Some(settlement) = publisher.settlement.as_ref() {
                *work.usage.lock().unwrap_or_else(|error| error.into_inner()) = Some(
                    with_usage(
                        ObjectEncoder::new(),
                        settlement,
                        &resolved.info.cost,
                        &prepared,
                        selection.provider_id.0.as_str().unwrap_or_default(),
                    )
                    .finish(),
                );
            }
            match result {
                Err(failure) => {
                    let overflowed = work.overflow.load(std::sync::atomic::Ordering::Relaxed);
                    if overflowed
                        && overflow.is_none()
                        && compaction_gate::can_reduce(
                            &prepared,
                            &loaded,
                            compaction_gate::target_input_tokens(
                                context_window,
                                &services.compaction,
                            ),
                        )
                    {
                        overflow = Some(Overflow::Pending);
                        restart = Some((
                            assistant.clone(),
                            work.attempts.load(std::sync::atomic::Ordering::Relaxed),
                            tracked.pending.clone(),
                        ));
                        force = true;
                        continue;
                    }
                    let failure = if overflowed && overflow == Some(Overflow::Used) {
                        error(
                            "context.limit",
                            "The provider still rejected the request for context overflow after one compaction rebase",
                        )
                    } else {
                        failure
                    };
                    self.fail(&session.id, &work, &failure).await?;
                    // Recording is best effort after a failed Step; the Step failure stays the cause.
                    let _ = self
                        .record_request(
                            &tracked,
                            &agent.id,
                            &work,
                            publisher.settlement.as_ref(),
                            &resolved.info.cost,
                            &prepared.model.route.id,
                        )
                        .await;
                    self.remove(&session.id);
                    return Err(failure);
                }
                Ok(()) => {
                    let Some(settlement) = publisher.settlement.as_ref() else {
                        let failure = error(
                            "provider.invalid-output",
                            "Provider did not settle the step",
                        );
                        self.fail(&session.id, &work, &failure).await?;
                        let _ = self
                            .record_request(
                                &tracked,
                                &agent.id,
                                &work,
                                None,
                                &resolved.info.cost,
                                &prepared.model.route.id,
                            )
                            .await;
                        self.remove(&session.id);
                        return Err(failure);
                    };
                    if recovery && !publisher.assistant_text {
                        let failure = error(
                            "provider.invalid-output",
                            "The provider returned no answer after text-only recovery. Retry the request or choose another model.",
                        );
                        self.fail(&session.id, &work, &failure).await?;
                        let _ = self
                            .record_request(
                                &tracked,
                                &agent.id,
                                &work,
                                Some(settlement),
                                &resolved.info.cost,
                                &prepared.model.route.id,
                            )
                            .await;
                        self.remove(&session.id);
                        return Err(failure);
                    }
                    self.fail_unsettled(
                        &session.id,
                        &work,
                        &ycoding_schema::session_error::Error {
                            r#type: "tool.execution".into(),
                            message: "Tool did not return a result".into(),
                        },
                    )
                    .await?;
                    let terminal = event(
                        &session.id,
                        Some(&assistant),
                        "session.step.ended",
                        with_usage(
                            self.snapshot_end(
                                &work,
                                ObjectEncoder::new().field("finish", finish(settlement.reason)),
                            ),
                            settlement,
                            &resolved.info.cost,
                            &prepared,
                            selection.provider_id.0.as_str().unwrap_or_default(),
                        )
                        .finish(),
                        services.clock.now(),
                    )?;
                    let continuation = tracked
                        .continuation
                        .eligible
                        .then(|| response_id(settlement, &metadata_key))
                        .flatten()
                        .map(|response_id| continuation::State {
                            fingerprint: tracked.continuation.fingerprint.clone(),
                            response_id,
                        });
                    if let Err(failure) = services
                        .store
                        .publish_step_end(
                            terminal,
                            prepared.model.provider.0.clone(),
                            text(&selection.id),
                            std::mem::take(&mut publisher.captures),
                            continuation,
                        )
                        .await
                    {
                        let failure = Error::from(failure);
                        self.fail(&session.id, &work, &failure).await?;
                        self.remove(&session.id);
                        return Err(failure);
                    }
                    self.record_request(
                        &tracked,
                        &agent.id,
                        &work,
                        Some(settlement),
                        &resolved.info.cost,
                        &prepared.model.route.id,
                    )
                    .await?;
                }
            }
            self.remove(&session.id);
            step += 1;
            gate_admissions = 0;
            gate_rounds = 0;
            overflow = None;
            force = publisher.continuation;
            if !publisher.assistant_text && !force && !recovery_used {
                recovery_used = true;
                recovery = true;
                force = true;
            } else {
                recovery = false;
            }
            continuation = publisher.continuation || recovery;
        }
    }

    async fn attempt(
        &self,
        request: &llm::Request,
        publisher: &mut publisher::Publisher,
        inputs: &[session_message::Id],
        tools: Arc<materialization::Materialization>,
        agent: &ycoding_schema::agent::Id,
        work: &Arc<Work>,
    ) -> Outcome {
        let mut consumption = Consumption {
            ids: inputs,
            observed: false,
        };
        let mut current = std::borrow::Cow::Borrowed(request);
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            work.attempts
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            work.timing
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .ended = None;
            match self
                .physical(
                    &current,
                    publisher,
                    tools.clone(),
                    agent,
                    work,
                    &mut consumption,
                )
                .await
            {
                Ok(()) => return Ok(()),
                Err(AttemptError::Local(error)) => return Err(error),
                Err(AttemptError::Provider(failure)) => {
                    if work.continuation_used
                        && !publisher.evidence
                        && !work.fallback.load(std::sync::atomic::Ordering::Relaxed)
                        && stale_continuation(&failure)
                    {
                        work.fallback
                            .store(true, std::sync::atomic::Ordering::Relaxed);
                        self.0
                            .services
                            .store
                            .clear_continuation(&publisher.session, self.0.services.clock.now())
                            .await?;
                        current = std::borrow::Cow::Owned(without_continuation(&current));
                        attempt -= 1;
                        continue;
                    }
                    if attempt == 10
                        || publisher.evidence
                        || !matches!(
                            failure.reason,
                            provider_error::Reason::RateLimit
                                | provider_error::Reason::ProviderInternal
                                | provider_error::Reason::Transport
                        )
                        || failure
                            .retry_after_ms
                            .is_some_and(|delay| delay > 120_000.0)
                    {
                        work.overflow.store(
                            failure.context_overflow && !publisher.evidence,
                            std::sync::atomic::Ordering::Relaxed,
                        );
                        return Err(ai_error(failure));
                    }
                    publisher.flush(self.0.services.clock.now()).await?;
                    let exponential = (2000 * 2u64.pow(attempt - 1)).min(120_000);
                    let delay = failure
                        .retry_after_ms
                        .filter(|delay| delay.is_finite() && *delay >= 0.0)
                        .map_or(exponential, |delay| exponential.max(delay as u64));
                    let at = self.0.services.clock.now().saturating_add(delay as i64);
                    let Error::Runner(failure) = ai_error(failure) else {
                        unreachable!("provider errors map to Session errors")
                    };
                    publisher
                        .event(
                            "session.retry.scheduled",
                            ObjectEncoder::new()
                                .field("attempt", &((attempt + 1) as f64))
                                .field("at", &(at as f64))
                                .field("error", &failure)
                                .finish(),
                            self.0.services.clock.now(),
                        )
                        .await?;
                    work.timing
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .waiting = Some(std::time::Instant::now());
                    self.0.services.clock.sleep(delay).await;
                    let mut timing = work
                        .timing
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    if let Some(waiting) = timing.waiting.take() {
                        timing.retry_wait += waiting.elapsed();
                    }
                    drop(timing);
                    *publisher = publisher::Publisher::new(
                        publisher.store.clone(),
                        self.0.services.events.clone(),
                        self.0.services.location.clone(),
                        publisher.session.clone(),
                        publisher.assistant.clone(),
                        publisher.metadata_key.clone(),
                    );
                }
            }
        }
    }

    async fn physical(
        &self,
        request: &llm::Request,
        publisher: &mut publisher::Publisher,
        tools: Arc<materialization::Materialization>,
        agent: &ycoding_schema::agent::Id,
        work: &Arc<Work>,
        consumption: &mut Consumption<'_>,
    ) -> Result<(), AttemptError> {
        let services = &self.0.services;
        let mut stream = services
            .executor
            .stream(request)
            .await
            .map_err(AttemptError::Provider)?;
        while let Some(event) = stream.next().await.map_err(AttemptError::Provider)? {
            {
                let mut timing = work
                    .timing
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                let output = match &event {
                    llm::Event::TextDelta(delta) | llm::Event::ReasoningDelta(delta) => {
                        !delta.text.is_empty()
                    }
                    llm::Event::ToolInputDelta { text, .. } => !text.is_empty(),
                    llm::Event::ToolCall(_) => true,
                    _ => false,
                };
                let received = services.clock.nanos();
                match &event {
                    llm::Event::TextDelta(delta) if generation_output(&delta.text) => {
                        timing.generation.text.get_or_insert(received);
                    }
                    llm::Event::ReasoningDelta(delta) if generation_output(&delta.text) => {
                        timing.generation.reasoning.get_or_insert(received);
                    }
                    llm::Event::ToolInputDelta { text, .. } if generation_output(text) => {
                        timing.generation.tool_input.get_or_insert(received);
                    }
                    llm::Event::StepFinish { .. } => {
                        timing.generation.ended.get_or_insert(received);
                    }
                    _ => {}
                }
                if output {
                    timing
                        .first_output
                        .get_or_insert_with(std::time::Instant::now);
                }
                if matches!(event, llm::Event::StepFinish { .. } | llm::Event::Finish(_)) {
                    timing.ended.get_or_insert_with(std::time::Instant::now);
                }
            }
            if work.continuation_used
                && !publisher.evidence
                && let llm::Event::ProviderError {
                    message,
                    context_overflow: false,
                    ..
                } = &event
            {
                return Err(AttemptError::Provider(ycoding_ai::Error::new(
                    provider_error::Reason::InvalidRequest,
                    message.to_utf8().unwrap_or_default(),
                )));
            }
            if work.text_only
                && matches!(
                    event,
                    llm::Event::ToolInputStart(_)
                        | llm::Event::ToolInputDelta { .. }
                        | llm::Event::ToolInputEnd(_)
                        | llm::Event::ToolInputError { .. }
                        | llm::Event::ToolCall(_)
                )
            {
                return Err(error(
                    "provider.invalid-output",
                    "Provider called a tool during a text-only step",
                )
                .into());
            }
            if !consumption.observed && !consumption.ids.is_empty() {
                consumption.observed = true;
                publish(
                    &services.store,
                    &publisher.session,
                    None,
                    "session.input.consumed",
                    ObjectEncoder::new()
                        .field("inputIDs", &consumption.ids.to_vec())
                        .finish(),
                    services.clock.now(),
                )
                .await?;
            }
            if matches!(
                event,
                llm::Event::ProviderError {
                    context_overflow: true,
                    ..
                }
            ) && !publisher.evidence
            {
                work.overflow
                    .store(true, std::sync::atomic::Ordering::Relaxed);
            }
            let settled = matches!(event, llm::Event::StepFinish { .. });
            let call = publisher.push(event, services.clock.now()).await?;
            if settled {
                self.publish_diagnostics(request, publisher, work)?;
            }
            if let Some(call) = call {
                if request.tools.is_empty() {
                    return Err(error(
                        "provider.invalid-output",
                        "Provider called a tool while tools were disabled",
                    )
                    .into());
                }
                let tools = tools.clone();
                let store = services.store.clone();
                let clock = services.clock.clone();
                let session = publisher.session.clone();
                let assistant = publisher.assistant.clone();
                let cancellation = work.cancellation.clone();
                let agent = agent.clone();
                let progress_work = work.clone();
                work.tasks.lock().await.spawn(async move {
                    let progress_store = store.clone();
                    let progress_session = session.clone();
                    let progress_assistant = assistant.clone();
                    let progress_call = call.id.clone();
                    let progress_clock = clock.clone();
                    let context = Context {
                        session_id: session.clone(),
                        agent,
                        message_id: assistant.clone(),
                        call_id: call.id.clone(),
                        cancellation,
                        progress: Some(Arc::new(move |progress: Progress| {
                            let store = progress_store.clone();
                            let session = progress_session.clone();
                            let assistant = progress_assistant.clone();
                            let call = progress_call.clone();
                            let clock = progress_clock.clone();
                            let work = progress_work.clone();
                            Box::pin(async move {
                                if let Err(error) = publish(
                                    &store,
                                    &session,
                                    Some(&assistant),
                                    "session.tool.progress",
                                    ObjectEncoder::new()
                                        .field("callID", &call)
                                        .field("structured", &progress.structured)
                                        .field("content", &progress.content)
                                        .finish(),
                                    clock.now(),
                                )
                                .await
                                {
                                    *work
                                        .progress_error
                                        .lock()
                                        .unwrap_or_else(|error| error.into_inner()) = Some(error);
                                }
                            })
                        })),
                    };
                    let result = tools
                        .invoke(
                            call.name
                                .as_str()
                                .ok_or_else(|| error("tool.unknown", "Tool name is not UTF-8"))?,
                            call.input,
                            context,
                        )
                        .await;
                    match result {
                        Ok(settlement) => {
                            if let Some(failure) = settlement.error {
                                return publish(
                                    &store,
                                    &session,
                                    Some(&assistant),
                                    "session.tool.failed",
                                    ObjectEncoder::new()
                                        .field("callID", &call.id)
                                        .field("executed", &false)
                                        .field("error", &failure)
                                        .finish(),
                                    clock.now(),
                                )
                                .await;
                            }
                            let output = settlement.output.ok_or_else(|| {
                                error("tool.execution", "Tool result has no output")
                            })?;
                            let structured = match output.structured {
                                JsonValue::Object(structured) => structured,
                                value => {
                                    let mut wrapped = ycoding_schema::JsonObject::new();
                                    wrapped.insert("value".into(), value);
                                    wrapped
                                }
                            };
                            publish(
                                &store,
                                &session,
                                Some(&assistant),
                                "session.tool.success",
                                ObjectEncoder::new()
                                    .field("callID", &call.id)
                                    .field("executed", &false)
                                    .field("structured", &structured)
                                    .field("content", &output.content)
                                    .field("result", &settlement.result.to_json())
                                    .finish(),
                                clock.now(),
                            )
                            .await
                        }
                        Err(materialization::Error::Execution(
                            crate::tools::registry::Failure::Cancelled,
                        )) => Err(Error::Interrupted(
                            super::run_coordinator::InterruptReason::User,
                        )),
                        Err(materialization::Error::Execution(failure)) => {
                            publish(
                                &store,
                                &session,
                                Some(&assistant),
                                "session.tool.failed",
                                ObjectEncoder::new()
                                    .field("callID", &call.id)
                                    .field("executed", &false)
                                    .field(
                                        "error",
                                        &ycoding_schema::session_error::Error {
                                            r#type: "tool.execution".into(),
                                            message: format!("{failure:?}").into(),
                                        },
                                    )
                                    .finish(),
                                clock.now(),
                            )
                            .await
                        }
                        Err(materialization::Error::Storage(_)) => {
                            Err(error("unknown", "Tool output storage failed"))
                        }
                    }
                });
            }
        }
        Ok(())
    }

    fn timing(&self, work: &Work, usage: Option<&llm::Usage>) -> Result<Option<JsonValue>, Error> {
        let mut timing = match usage::timing(usage) {
            Some(JsonValue::Object(fields)) => fields,
            _ => ycoding_schema::JsonObject::new(),
        };
        if let Some(JsonValue::Object(generation)) = usage::generation_timing(
            usage,
            &work
                .timing
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .generation,
        ) {
            for (name, value) in generation.iter() {
                timing.insert(name.clone(), value.clone());
            }
        }
        if self.0.services.store.telemetry_enabled()? {
            let state = work
                .timing
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let now = std::time::Instant::now();
            let millis =
                |duration: std::time::Duration| JsonValue::Number(duration.as_millis() as f64);
            if let Some(first) = state.first_output {
                timing.insert(
                    "firstOutputMs".into(),
                    millis(first.duration_since(state.started)),
                );
            }
            timing.insert(
                "totalMs".into(),
                millis(state.ended.unwrap_or(now).duration_since(state.started)),
            );
            timing.insert(
                "retryWaitMs".into(),
                millis(
                    state.retry_wait
                        + state
                            .waiting
                            .map_or(std::time::Duration::ZERO, |waiting| waiting.elapsed()),
                ),
            );
        }
        let populated = timing.iter().next().is_some();
        Ok(populated.then_some(JsonValue::Object(timing)))
    }

    async fn record_request(
        &self,
        tracked: &Tracked,
        agent: &ycoding_schema::agent::Id,
        work: &Work,
        settlement: Option<&llm::Finish>,
        costs: &[ycoding_schema::model::Cost],
        route_id: &str,
    ) -> Outcome {
        let services = &self.0.services;
        let usage = settlement.and_then(|settlement| settlement.usage.as_ref());
        let tokens = usage::tokens(settlement.and_then(|settlement| settlement.usage.as_ref()));
        let reported = settlement.map(|_| {
            cache_diagnostics::reported(
                route_id,
                tracked
                    .begin
                    .model
                    .provider_id
                    .0
                    .as_str()
                    .unwrap_or_default(),
                usage,
            )
        });
        let cache_read = usage
            .and_then(|usage| usage.cache_read_input_tokens)
            .unwrap_or(0.0);
        let invalidation = {
            if settlement.is_none() {
                "provider-not-reported"
            } else if work.fallback.load(std::sync::atomic::Ordering::Relaxed) {
                "retry-fallback"
            } else if tracked.pending.default_invalidation == "compaction-reset" {
                "compaction-reset"
            } else if settlement.is_some() && cache_read > 0.0 {
                "stable-hit"
            } else if reported
                .as_ref()
                .is_some_and(|reported| reported.mechanism == "none")
            {
                "cache-disabled"
            } else if reported.as_ref().is_some_and(|reported| !reported.read) {
                "provider-not-reported"
            } else {
                tracked.pending.default_invalidation
            }
        };
        let fields = provider_request::recorded_fields(
            &tracked.begin,
            &tracked.pending,
            &provider_request::Completion {
                source: "step",
                agent,
                invalidation,
                continuation: if work.fallback.load(std::sync::atomic::Ordering::Relaxed) {
                    "fallback"
                } else if tracked.continuation.used {
                    "continued"
                } else {
                    "full"
                },
                attempts: work.attempts.load(std::sync::atomic::Ordering::Relaxed),
                cache_read_reported: reported.as_ref().map(|reported| reported.read),
                timing: self.timing(work, usage)?,
                cost: settlement.and_then(|_| {
                    usage::estimated_cost(costs, &tokens, usage::one_hour_cache_writes(usage))
                }),
                tokens: &tokens,
                time: services.clock.now(),
            },
        )?;
        publish(
            &services.store,
            &tracked.begin.session,
            Some(&work.assistant),
            "session.provider.request.recorded",
            fields,
            services.clock.now(),
        )
        .await
    }

    fn remove(&self, id: &session::Id) {
        self.0
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(id);
    }
    async fn fail(&self, id: &session::Id, work: &Work, failure: &Error) -> Outcome {
        let services = &self.0.services;
        let Some((_, session_message::Info::Assistant(assistant))) =
            services.store.message(&work.assistant)?
        else {
            return Ok(());
        };
        if assistant.time.completed.is_some() {
            return Ok(());
        }
        let failure = match failure {
            Error::Runner(error) => error.clone(),
            Error::Interrupted(_) => ycoding_schema::session_error::Error {
                r#type: "aborted".into(),
                message: "Step interrupted".into(),
            },
            _ => ycoding_schema::session_error::Error {
                r#type: "unknown".into(),
                message: failure.to_string().into(),
            },
        };
        self.fail_unsettled(id, work, &failure).await?;
        let mut fields = self
            .snapshot_end(work, ObjectEncoder::new().field("error", &failure))
            .finish();
        if let (JsonValue::Object(fields), Some(JsonValue::Object(usage))) = (
            &mut fields,
            work.usage
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take(),
        ) {
            for (key, value) in usage.iter() {
                fields.insert(key.clone(), value.clone());
            }
        }
        publish(
            &services.store,
            id,
            Some(&work.assistant),
            "session.step.failed",
            fields,
            services.clock.now(),
        )
        .await
    }

    fn snapshot_end(&self, work: &Work, fields: ObjectEncoder) -> ObjectEncoder {
        let snapshot = self
            .0
            .services
            .snapshots
            .as_ref()
            .and_then(|snapshots| snapshots.capture());
        let files = work
            .start_snapshot
            .as_ref()
            .zip(snapshot.as_ref())
            .and_then(|(from, to)| self.0.services.snapshots.as_ref()?.files(from, to).ok());
        fields
            .optional("snapshot", &snapshot)
            .optional("files", &files)
    }

    async fn observe_context(
        &self,
        id: &session::Id,
        limit: Option<u64>,
        step: u64,
        recovery: bool,
    ) -> Outcome {
        let services = &self.0.services;
        let observed = services.store.observation_state(id)?;
        let (state, team) = if services
            .analysis
            .as_ref()
            .is_some_and(|analysis| analysis.contains(id))
        {
            (None, None)
        } else {
            let state = live_state::load(&services.store.client, id, || {
                services
                    .guardrails
                    .snapshot(id)
                    .map(|snapshot| live_state::Source {
                        sequence: snapshot.sequence,
                        digest: snapshot.digest,
                    })
            })
            .map_err(|_| error("session.state", "Session state could not be loaded"))?;
            let team = match state.team_view {
                Some(view) => Some(view.text),
                None if observed.has(history::Source::TeamView) => Some(
                    orchestration::render_team_observation(&[], orchestration::TEAM_VIEW_BYTES)
                        .text,
                ),
                None => None,
            };
            (Some(state.text), team)
        };
        let step_limit = if recovery {
            None
        } else if limit.is_some_and(|limit| step >= limit) {
            Some(max_steps::PROMPT)
        } else if observed.has(history::Source::StepLimit) {
            Some(max_steps::RESET_PROMPT)
        } else {
            None
        };
        let observations = [
            (history::Source::SessionState, state),
            (history::Source::TeamView, team),
            (history::Source::StepLimit, step_limit.map(str::to_owned)),
        ];
        for (source, text) in observations {
            let Some(text) = text.filter(|text| {
                observed
                    .text(source)
                    .and_then(|latest| latest.to_utf8().ok())
                    .as_deref()
                    != Some(text.as_str())
            }) else {
                continue;
            };
            publish(
                &services.store,
                id,
                None,
                "session.context.observed",
                ObjectEncoder::new()
                    .field("source", source.as_str())
                    .field("text", text.as_str())
                    .finish(),
                services.clock.now(),
            )
            .await?;
        }
        Ok(())
    }
    async fn fail_unsettled(
        &self,
        id: &session::Id,
        work: &Work,
        failure: &ycoding_schema::session_error::Error,
    ) -> Outcome {
        let services = &self.0.services;
        let Some((_, session_message::Info::Assistant(assistant))) =
            services.store.message(&work.assistant)?
        else {
            return Ok(());
        };
        for part in &assistant.content {
            if let session_message::AssistantContent::Tool(tool) = part
                && matches!(
                    tool.state,
                    session_message::ToolState::Streaming(_)
                        | session_message::ToolState::Running(_)
                )
            {
                publish(
                    &services.store,
                    id,
                    Some(&work.assistant),
                    "session.tool.failed",
                    ObjectEncoder::new()
                        .field("callID", &tool.id)
                        .field("executed", &(tool.executed == Some(true)))
                        .field("error", failure)
                        .finish(),
                    services.clock.now(),
                )
                .await?;
            }
        }
        Ok(())
    }
    fn cleanup(&self, id: session::Id, outcome: Outcome) -> RunFuture {
        let local = self.clone();
        Box::pin(async move {
            let work = local
                .0
                .active
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&id);
            if let Some(work) = work {
                work.cancellation.cancel();
                let mut tasks = work.tasks.lock().await;
                tasks.abort_all();
                let mut failure = outcome
                    .err()
                    .unwrap_or_else(|| error("aborted", "Step ownership ended before settlement"));
                while let Some(result) = tasks.join_next().await {
                    match result {
                        Ok(Err(error)) if !matches!(error, Error::Interrupted(_)) => {
                            failure = error
                        }
                        Err(error_) if !error_.is_cancelled() => failure = Error::Panicked,
                        _ => {}
                    }
                }
                drop(tasks);
                local.fail(&id, &work, &failure).await?;
                let recording = work
                    .recording
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .take();
                if let Some(recording) = recording {
                    // The interrupted Step stays the cause; recording its request is best effort.
                    let _ = local
                        .record_request(
                            &recording.tracked,
                            &recording.agent,
                            &work,
                            None,
                            &recording.costs,
                            &recording.route_id,
                        )
                        .await;
                }
            }
            Ok(())
        })
    }
}

impl execution::Runner for Local {
    fn prepare_input(&self, input: session_pending::Message) -> execution::PrepareInputFuture<'_> {
        let resolver = self.0.services.skill_resolver.clone();
        Box::pin(async move {
            let session_pending::Message::User(mut user) = input else {
                return Ok(input);
            };
            let Some(resolver) = resolver else {
                return Ok(session_pending::Message::User(user));
            };
            let catalog = resolver
                .list()
                .await
                .map_err(|_| error("skill.unavailable", "Session skills could not be listed"))?;
            let available = catalog
                .iter()
                .map(|skill| skill.id.clone())
                .collect::<Vec<_>>();
            let mentioned = skill::mentions(&user.data.text, &available);
            if mentioned.is_empty() {
                return Ok(session_pending::Message::User(user));
            }
            let selected = skill::selected(user.data.metadata.as_ref());
            let additions = mentioned
                .iter()
                .filter(|id| !selected.contains(id))
                .filter_map(|id| catalog.iter().find(|candidate| &candidate.id == id))
                .map(|skill| {
                    ObjectEncoder::new()
                        .field("id", &skill.id)
                        .field("name", &skill.name)
                        .finish()
                })
                .filter_map(|value| match value {
                    JsonValue::Object(object) => Some(JsonValue::Object(object)),
                    _ => None,
                })
                .collect::<Vec<_>>();
            if additions.is_empty() {
                return Ok(session_pending::Message::User(user));
            }
            let metadata = user.data.metadata.get_or_insert_with(JsonObject::new);
            let skills = match metadata.get(&"skills".into()) {
                Some(JsonValue::Array(skills)) => skills.clone(),
                _ => Vec::new(),
            };
            let mut skills = skills;
            skills.extend(additions);
            metadata.insert("skills".into(), JsonValue::Array(skills));
            Ok(session_pending::Message::User(user))
        })
    }
    fn drain(&self, request: DrainRequest) -> RunFuture {
        let local = self.clone();
        Box::pin(async move { local.run(request).await })
    }
    fn settled(&self, id: session::Id, outcome: Outcome) -> RunFuture {
        self.cleanup(id, outcome)
    }
}
impl Drain for Local {
    fn drain(&self, request: DrainRequest) -> RunFuture {
        execution::Runner::drain(self, request)
    }
    fn settled(&self, id: session::Id, outcome: Outcome) -> RunFuture {
        self.cleanup(id, outcome)
    }
}

fn model_resolution_error(
    selection: &ycoding_schema::model::Ref,
    cause: model::Error,
    package: Option<&LosslessString>,
) -> Error {
    let identity = crate::instructions::join(
        &[selection.provider_id.0.clone(), selection.id.clone()],
        "/",
    );
    let (kind, message) = match cause {
        model::Error::ModelUnavailable => (
            "model.unavailable",
            crate::instructions::join(&["Model unavailable: ".into(), identity], ""),
        ),
        model::Error::VariantUnavailable => (
            "model.variant",
            crate::instructions::join(
                &[
                    "Variant unavailable for ".into(),
                    identity,
                    ": ".into(),
                    selection
                        .variant
                        .as_ref()
                        .expect("variant failure requires a selected variant")
                        .clone(),
                ],
                "",
            ),
        ),
        model::Error::UnsupportedPackage => (
            "model.unsupported",
            crate::instructions::join(
                &[
                    "Unsupported package for ".into(),
                    identity,
                    ": ".into(),
                    package.cloned().unwrap_or_else(|| "unknown".into()),
                ],
                "",
            ),
        ),
        model::Error::ProfileUnavailable => (
            "model.profile",
            crate::instructions::join(
                &[
                    "Profile unavailable for ".into(),
                    selection.provider_id.0.clone(),
                    ": ".into(),
                    selection
                        .profile
                        .as_ref()
                        .expect("profile failure requires a selected profile")
                        .0
                        .clone(),
                    ". Select the profile again.".into(),
                ],
                "",
            ),
        ),
        model::Error::InvalidSettings => (
            "model.unavailable",
            "Selected model route is unavailable".into(),
        ),
    };
    Error::Runner(ycoding_schema::session_error::Error {
        r#type: kind.into(),
        message,
    })
}

pub(crate) fn error(kind: &str, message: &str) -> Error {
    Error::Runner(ycoding_schema::session_error::Error {
        r#type: kind.into(),
        message: message.into(),
    })
}
fn ai_error(error_: ycoding_ai::Error) -> Error {
    error(
        match error_.reason {
            provider_error::Reason::Authentication => "provider.auth",
            provider_error::Reason::RateLimit => "provider.rate-limit",
            provider_error::Reason::QuotaExceeded => "provider.quota",
            provider_error::Reason::Transport => "provider.transport",
            provider_error::Reason::ProviderInternal => "provider.internal",
            provider_error::Reason::InvalidProviderOutput => "provider.invalid-output",
            provider_error::Reason::ContentPolicy => "provider.content-policy",
            _ => "provider.invalid-request",
        },
        match error_.reason {
            provider_error::Reason::Authentication => "Provider authentication failed",
            provider_error::Reason::RateLimit => "Provider rate limit reached",
            provider_error::Reason::QuotaExceeded => "Provider quota exhausted",
            _ => &error_.message,
        },
    )
}
pub(crate) async fn publish(
    store: &Service,
    id: &session::Id,
    assistant: Option<&session_message::Id>,
    kind: &str,
    fields: JsonValue,
    now: i64,
) -> Outcome {
    store
        .publish(event(id, assistant, kind, fields, now)?)
        .await?;
    Ok(())
}

fn event(
    id: &session::Id,
    assistant: Option<&session_message::Id>,
    kind: &str,
    fields: JsonValue,
    now: i64,
) -> Result<ycoding_store::session::NewEvent, Error> {
    let JsonValue::Object(fields) = fields else {
        return Err(error("unknown", "Session event fields must be an object"));
    };
    let JsonValue::Object(mut data) = ObjectEncoder::new()
        .field("sessionID", id)
        .optional("assistantMessageID", &assistant.cloned())
        .finish()
    else {
        unreachable!("event data encodes an object")
    };
    for (key, value) in fields.iter() {
        data.insert(key.clone(), value.clone());
    }
    Ok(ycoding_store::session::NewEvent {
        id: projector::random_event_id()?.as_lossless().clone(),
        aggregate_id: id.as_lossless().clone(),
        created: now,
        type_: format!("{kind}.1").into(),
        data: JsonValue::Object(data),
    })
}
fn finish(reason: llm::FinishReason) -> &'static str {
    match reason {
        llm::FinishReason::Stop => "stop",
        llm::FinishReason::Length => "length",
        llm::FinishReason::ToolCalls => "tool-calls",
        llm::FinishReason::ContentFilter => "content-filter",
        llm::FinishReason::Error => "error",
        llm::FinishReason::Unknown => "unknown",
    }
}

fn generation_output(text: &ycoding_schema::LosslessString) -> bool {
    text.code_units()
        .any(|unit| !crate::process::guardrails::is_whitespace(unit))
}
fn with_usage(
    encoder: ObjectEncoder,
    settlement: &llm::Finish,
    costs: &[ycoding_schema::model::Cost],
    request: &llm::Request,
    provider: &str,
) -> ObjectEncoder {
    let tokens = usage::tokens(settlement.usage.as_ref());
    encoder
        .field(
            "cost",
            &usage::cost(
                costs,
                &tokens,
                usage::one_hour_cache_writes(settlement.usage.as_ref()),
            ),
        )
        .field("tokens", &tokens)
        .optional("contextLimit", &request.model.defaults.context_limit)
        .field(
            "providerCache",
            &cache_diagnostics::provider_cache(
                &request.model.route.id,
                provider,
                settlement.usage.as_ref(),
            ),
        )
}
fn cursor_package(info: &ycoding_schema::model::Info) -> bool {
    info.package
        .as_ref()
        .and_then(|package| package.as_str())
        .and_then(|package| package.strip_prefix("aisdk:"))
        == Some(cursor::models::PACKAGE_NAME)
}

fn text<T: ycoding_schema::DomainEncode>(value: &T) -> ycoding_schema::LosslessString {
    match value.encode() {
        JsonValue::String(text) => text,
        _ => unreachable!("identifier encodes a string"),
    }
}
fn account_identity_digest(
    connection: Option<&credential::Info>,
    info: &ycoding_schema::model::Info,
    integration: &ycoding_schema::LosslessString,
) -> Option<String> {
    if let Some(connection) = connection {
        return Some(prompt_cache::sha256(&ycoding_schema::stringify_json(
            &ObjectEncoder::new()
                .field("integrationID", connection.integration_id())
                .field("credentialID", connection.id())
                .field(
                    "accountGeneration",
                    &(connection.account_generation() as f64),
                )
                .finish(),
        )));
    }
    let settings = info.settings.as_ref().map(|settings| &settings.0)?;
    let key = settings
        .get(&"apiKey".into())
        .and_then(|value| match value {
            JsonValue::String(key) if key.as_str() != Some("") => Some(value.clone()),
            _ => None,
        })?;
    Some(prompt_cache::sha256(&ycoding_schema::stringify_json(
        &ObjectEncoder::new()
            .field("namespace", "captured-auth/v1")
            .field("providerID", &info.provider_id)
            .field("integrationID", integration)
            .field(
                "material",
                &ObjectEncoder::new()
                    .field("type", "key")
                    .field("value", &key)
                    .finish(),
            )
            .optional(
                "organization",
                &settings.get(&"organization".into()).cloned(),
            )
            .optional("project", &settings.get(&"project".into()).cloned())
            .finish(),
    )))
}
fn message_id(message: &session_message::Info) -> Option<ycoding_schema::LosslessString> {
    let JsonValue::Object(fields) = ycoding_schema::DomainEncode::encode(message) else {
        return None;
    };
    match fields.get(&"id".into())? {
        JsonValue::String(id) => Some(id.clone()),
        _ => None,
    }
}
fn stateless(request: &llm::Request) -> bool {
    let key = if request.model.route.id == "ai-sdk:@ai-sdk/github-copilot" {
        "copilot"
    } else {
        "openai"
    };
    let Some(JsonValue::Object(options)) = request.resolved().provider_options else {
        return false;
    };
    matches!(
        options.get(&key.into()),
        Some(JsonValue::Object(provider))
            if provider.get(&"store".into()) == Some(&JsonValue::Bool(false))
    )
}
fn with_openai(options: JsonValue, entries: &[(&str, JsonValue)]) -> JsonValue {
    let JsonValue::Object(fields) = options else {
        return options;
    };
    let mut result = ycoding_schema::JsonObject::new();
    for (name, value) in fields.iter() {
        let value = match (name.as_str(), value) {
            (Some("openai"), JsonValue::Object(openai)) => {
                let mut openai = openai.clone();
                for (key, entry) in entries {
                    openai.insert((*key).into(), entry.clone());
                }
                JsonValue::Object(openai)
            }
            _ => value.clone(),
        };
        result.insert(name.clone(), value);
    }
    JsonValue::Object(result)
}
fn response_id(settlement: &llm::Finish, key: &str) -> Option<ycoding_schema::LosslessString> {
    let JsonValue::Object(metadata) = settlement.provider_metadata.as_ref()? else {
        return None;
    };
    let JsonValue::Object(state) = metadata.get(&key.into())? else {
        return None;
    };
    match state.get(&"responseId".into())? {
        JsonValue::String(id) if id.as_str().is_some_and(|id| !id.is_empty()) => Some(id.clone()),
        _ => None,
    }
}
fn connection_identity_digest(
    info: &ycoding_schema::model::Info,
    selection: &ycoding_schema::model::Ref,
    route_id: &str,
    base_url: &str,
    account_identity: Option<&str>,
    connection: Option<&credential::Info>,
) -> String {
    let setting = |name: &str| {
        info.settings
            .as_ref()
            .and_then(|settings| settings.0.get(&name.into()))
            .and_then(|value| match value {
                JsonValue::String(text) => Some(text.clone()),
                _ => None,
            })
    };
    let normalized = |url: &str| url.trim_end_matches('/').to_string();
    prompt_cache::sha256(&ycoding_schema::stringify_json(
        &ObjectEncoder::new()
            .field("provider", &info.provider_id)
            .field("model", &info.id)
            .field("apiModel", &info.model_id)
            .optional("variant", &selection.variant)
            .optional(
                "accountIdentityDigest",
                &account_identity.map(ycoding_schema::LosslessString::from),
            )
            .field("route", route_id)
            .field("endpoint", normalized(base_url).as_str())
            .optional("organization", &setting("organization"))
            .optional("project", &setting("project"))
            .optional(
                "connection",
                &connection.map(|connection| {
                    ObjectEncoder::new()
                        .field("type", "credential")
                        .field("integrationID", connection.integration_id())
                        .field("id", connection.id())
                        .field(
                            "accountGeneration",
                            &(connection.account_generation() as f64),
                        )
                        .field("generation", &(connection.generation() as f64))
                        .finish()
                }),
            )
            .field(
                "catalog",
                &ObjectEncoder::new()
                    .optional("package", &info.package)
                    .optional(
                        "baseURL",
                        &setting("baseURL")
                            .and_then(|url| url.to_utf8().ok())
                            .map(|url| {
                                ycoding_schema::LosslessString::from(normalized(&url).as_str())
                            }),
                    )
                    .finish(),
            )
            .finish(),
    ))
}
fn stale_continuation(failure: &ycoding_ai::Error) -> bool {
    let message = failure.message.to_lowercase();
    let previous = message.contains("previous_response") || message.contains("previous response");
    (previous
        && ["invalid", "expired", "not found", "unknown"]
            .iter()
            .any(|word| message.contains(word)))
        || (failure.reason == provider_error::Reason::InvalidRequest
            && !failure.context_overflow
            && message.contains("invalid_prompt"))
}
fn without_continuation(request: &llm::Request) -> llm::Request {
    let mut request = request.clone();
    if let Some(JsonValue::Object(fields)) = &request.provider_options {
        let mut options = ycoding_schema::JsonObject::new();
        for (name, value) in fields.iter() {
            let value = match (name.as_str(), value) {
                (Some("openai"), JsonValue::Object(openai)) => {
                    let mut openai_options = ycoding_schema::JsonObject::new();
                    for (key, entry) in openai.iter().filter(|(key, _)| {
                        !matches!(
                            key.as_str(),
                            Some("previousResponseId" | "continuationInputStart")
                        )
                    }) {
                        openai_options.insert(key.clone(), entry.clone());
                    }
                    JsonValue::Object(openai_options)
                }
                _ => value.clone(),
            };
            options.insert(name.clone(), value);
        }
        request.provider_options = Some(JsonValue::Object(options));
    }
    request
}
