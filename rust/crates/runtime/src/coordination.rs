use crate::{
    connector::mcp::json,
    convert,
    dispatch::{Dispatcher, Failure, Invocation, RegistrationError},
    locations::WeakLocations,
};
use prost::{Message, Name};
use std::sync::{Arc, Mutex, PoisonError};
use tokio::{
    sync::{Notify, watch},
    task::JoinHandle,
};
use ycoding_core::{
    coordination::{
        Error,
        decisions::{
            CoordinationDecisions, Locate, Options as DecisionOptions,
            Services as DecisionServices, Settings as SettingsSource,
        },
        runtime::{
            AttachInput, AuthorizeLocation, CreateContext, CreateDirectory, CreatedWorktree,
            Future, HANDLED_EVENTS, MemberCreator, MemberInput, ModelServices,
            ModelServicesFactory, Options, Runtime, ValidateModel,
        },
    },
    event_feed::{Feed, Scope, Subscriber},
    resources::config,
    session::{execution::Execution, store},
    tools::{
        builtin::{filesystem::Paths, worktree::create_managed_worktree},
        context::{Context, policy::LeafPolicy},
        registry::Failure as ToolFailure,
    },
    ycoding_schema::{
        DomainDecode, DomainEncode, ObjectEncoder, agent, coordination as c, location, model,
        permission, project, schema::AbsolutePath, session,
    },
};
use ycoding_protocol::{domain_json, limits, v5};

pub(crate) struct Bindings {
    pub coordination: ycoding_core::coordination::Service,
    pub sessions: store::Service,
    pub execution: &'static Execution,
    pub locations: WeakLocations,
    pub settings: SettingsSource,
}

pub(crate) fn bind(bindings: Bindings) -> Runtime {
    let decisions = CoordinationDecisions::new(DecisionOptions {
        coordination: bindings.coordination.clone(),
        settings: bindings.settings,
        services: locate(bindings.locations.clone()),
        now: None,
    });
    let creator = Creator {
        locations: bindings.locations.clone(),
        sessions: bindings.sessions.clone(),
    };
    Runtime::new(Options {
        coordination: bindings.coordination,
        sessions: bindings.sessions.clone(),
        execution: bindings.execution,
        decisions: Arc::new(decisions),
        jobs: bindings.execution.jobs().clone(),
        model_services: model_services(bindings.locations.clone(), bindings.sessions.clone()),
        validate_model: validate_model(bindings.locations),
        creator: Some(Arc::new(creator)),
    })
}

fn model_services(locations: WeakLocations, sessions: store::Service) -> ModelServicesFactory {
    Arc::new(move |id| {
        let locations = locations.clone();
        let sessions = sessions.clone();
        Box::pin(async move {
            let current = locations.upgrade().ok_or_else(unavailable)?;
            let (_, held) = current
                .session(&id)
                .map_err(|failure| session_failure(&id, failure))?;
            if !current.is_current(&held) {
                return Err(unavailable());
            }
            let composed = held.production.as_ref().ok_or_else(unavailable)?;
            let resolver = ycoding_core::session::orchestration::ModelSwitch::new(
                sessions,
                composed.models.clone(),
                composed.credentials.clone(),
                composed.runner.compaction(),
                composed.runner.attachments(),
            );
            let pinned = held.clone();
            let weak = current.downgrade();
            Ok(ModelServices {
                resolver,
                lease: held,
                is_current: Arc::new(move || {
                    weak.upgrade()
                        .is_some_and(|locations| locations.is_current(&pinned))
                }),
            })
        })
    })
}

pub(crate) fn configured_settings(global: Arc<config::Configuration>) -> SettingsSource {
    Arc::new(move || -> Future<'static, c::Settings> {
        let global = global.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || global.coordination_settings())
                .await
                .map_err(|_| unavailable())?
                .map_err(|_| unavailable())
        })
    })
}

pub(crate) fn default_settings() -> SettingsSource {
    Arc::new(|| -> Future<'static, c::Settings> {
        Box::pin(async {
            Ok(c::Settings {
                enabled: true,
                categories: vec![
                    c::RequestKind::Question,
                    c::RequestKind::Permission,
                    c::RequestKind::Review,
                ],
                actions: None,
                resources: None,
                expires_at: None,
            })
        })
    })
}

fn unavailable() -> Error {
    ycoding_core::ycoding_store::Error::Rejected("Project services are unavailable").into()
}

fn session_failure(id: &session::Id, failure: Failure) -> Error {
    match failure {
        Failure::SessionNotFound(_) => Error::refused(format!(
            "Session {} does not exist",
            convert::readable(id.as_lossless())
        )),
        _ => unavailable(),
    }
}

fn locate(locations: WeakLocations) -> Locate {
    Arc::new(
        move |id: session::Id| -> Future<'static, Option<DecisionServices>> {
            let locations = locations.clone();
            Box::pin(async move {
                let current = locations.upgrade().ok_or_else(unavailable)?;
                let Some(held) = current
                    .loaded_project_session(&id)
                    .map_err(|failure| session_failure(&id, failure))?
                else {
                    return Ok(None);
                };
                if !current.is_current(&held) {
                    return Err(unavailable());
                }
                let pinned = held.clone();
                let weak = current.downgrade();
                Ok(Some(DecisionServices {
                    permissions: held.permissions.clone(),
                    forms: held.forms.clone(),
                    guardrails: held.guardrails.clone(),
                    lease: held,
                    is_current: Arc::new(move || {
                        weak.upgrade()
                            .is_some_and(|locations| locations.is_current(&pinned))
                    }),
                }))
            })
        },
    )
}

struct Creator {
    locations: WeakLocations,
    sessions: store::Service,
}

impl Creator {
    fn held(
        &self,
        caller: &session::Id,
    ) -> Result<(session::Info, Arc<crate::locations::LocationServices>), Error> {
        let current = self.locations.upgrade().ok_or_else(unavailable)?;
        current
            .session(caller)
            .map_err(|failure| session_failure(caller, failure))
    }
    fn agent_rules(
        &self,
        caller: &session::Id,
        agent: &agent::Id,
    ) -> Result<Option<permission::Ruleset>, Error> {
        let (_, held) = self.held(caller)?;
        let production = held.production.as_ref().ok_or_else(unavailable)?;
        Ok(production
            .agents
            .snapshot()
            .get(agent)
            .map(|info| info.permissions.clone()))
    }
}

impl MemberCreator for Creator {
    fn agent_permissions(
        &self,
        caller: session::Id,
        agent: agent::Id,
    ) -> Future<'_, Option<permission::Ruleset>> {
        Box::pin(async move { self.agent_rules(&caller, &agent) })
    }
    fn worktree_allowed(&self, caller: session::Id) -> Future<'_, bool> {
        Box::pin(async move {
            let info = self.sessions.get(&caller)?.ok_or_else(|| {
                session_failure(
                    &caller,
                    Failure::SessionNotFound(convert::readable(caller.as_lossless())),
                )
            })?;
            let Some(agent) = &info.agent else {
                return Ok(false);
            };
            let Some(rules) = self.agent_rules(&caller, agent)? else {
                return Ok(false);
            };
            let (_, held) = self.held(&caller)?;
            let production = held.production.as_ref().ok_or_else(unavailable)?;
            Ok(production.tools.available(&rules).contains("worktree"))
        })
    }
    fn create_worktree(
        &self,
        context: CreateContext,
        name: ycoding_core::ycoding_schema::LosslessString,
        repository: Option<ycoding_core::ycoding_schema::LosslessString>,
    ) -> Future<'_, CreatedWorktree> {
        Box::pin(async move {
            let leaf = self.leaf(&context)?;
            let (source, missing) = match &repository {
                Some(requested) => {
                    let requested = requested.to_utf8().map_err(|_| {
                        Error::refused("The repository must be an absolute directory path")
                    })?;
                    let source = std::path::PathBuf::from(&requested);
                    if !source.is_absolute() {
                        return Err(Error::refused(
                            "The repository must be an absolute directory path",
                        ));
                    }
                    (
                        source,
                        format!("{requested} is not inside a Git repository"),
                    )
                }
                None => (
                    leaf.paths.directory.clone(),
                    "The current Location is not inside a Git repository".to_owned(),
                ),
            };
            let repository = leaf
                .paths
                .git
                .discover(&source)
                .map_err(|_| Error::refused("Unable to inspect the current Git repository"))?
                .ok_or_else(|| Error::refused(missing))?;
            let name = name
                .to_utf8()
                .map_err(|_| Error::refused("Invalid tool input: name is not valid Unicode"))?;
            let directory = create_managed_worktree(
                &leaf.paths,
                &leaf.policy,
                &leaf.context,
                &repository,
                &name,
            )
            .await
            .map_err(|failure| tool_refusal(failure, "Worktree creation was cancelled"))?;
            Ok(CreatedWorktree {
                directory: directory.into(),
                branch: name.into(),
            })
        })
    }
    fn directory(&self, context: CreateContext) -> Future<'_, CreateDirectory> {
        Box::pin(async move {
            let leaf = self.leaf(&context)?;
            let locations = self.locations.clone();
            Ok(CreateDirectory {
                home: leaf.home.clone(),
                open: Box::new(move |directory: AbsolutePath, missing: bool| {
                    Box::pin(async move {
                        let path = directory
                            .as_lossless()
                            .to_utf8()
                            .map_err(|_| Error::refused("The directory is not valid Unicode"))?;
                        if missing {
                            create_project_directory(&leaf, &path).await?;
                        }
                        let current = locations.upgrade().ok_or_else(unavailable)?;
                        let info = current.info(directory.as_lossless(), None).map_err(|_| {
                            Error::refused(format!(
                                "Project directory {path} could not be opened or created"
                            ))
                        })?;
                        current
                            .record(&info, true)
                            .await
                            .map_err(|_| unavailable())?;
                        Ok(info.project.id)
                    }) as Future<'static, project::Id>
                }),
            })
        })
    }
    fn attach_location(
        &self,
        context: CreateContext,
        session_id: session::Id,
    ) -> Future<'_, AuthorizeLocation> {
        Box::pin(async move {
            let leaf = self.leaf(&context)?;
            Ok(Box::new(move |location: location::Ref| {
                Box::pin(async move {
                    let path = location.directory.as_lossless().to_utf8().ok();
                    let refused = || {
                        Error::refused(format!(
                            "Session {} directory {} cannot be authorized",
                            convert::readable(session_id.as_lossless()),
                            convert::readable(location.directory.as_lossless())
                        ))
                    };
                    let target = path
                        .and_then(|path| leaf.paths.resolve(&path, true).ok())
                        .ok_or_else(refused)?;
                    target
                        .authorize_external(&leaf.policy, &leaf.context)
                        .await
                        .map_err(|failure| tool_refusal(failure, "Project attach was cancelled"))
                }) as Future<'static, ()>
            }) as AuthorizeLocation)
        })
    }
}

struct Leaf {
    _lease: Arc<crate::locations::LocationServices>,
    home: std::path::PathBuf,
    paths: Paths,
    policy: LeafPolicy,
    context: Context,
}

impl Creator {
    fn leaf(&self, context: &CreateContext) -> Result<Leaf, Error> {
        let (_, held) = self.held(&context.session_id)?;
        let production = held.production.as_ref().ok_or_else(unavailable)?;
        let roots = production.configuration.roots();
        let home = roots.home.clone();
        let data = roots.data.clone();
        let git = production.platform.git.clone();
        let directory = std::path::PathBuf::from(
            held.info
                .directory
                .as_lossless()
                .to_utf8()
                .map_err(|_| unavailable())?,
        );
        let policy = LeafPolicy {
            permissions: held.permissions.clone(),
            guardrails: held.guardrails.clone(),
        };
        Ok(Leaf {
            _lease: held,
            home,
            paths: Paths {
                directory,
                data,
                git,
            },
            policy,
            context: Context::new(
                &context
                    .session_id
                    .as_lossless()
                    .to_utf8()
                    .map_err(|_| unavailable())?,
                context.agent.as_str().ok_or_else(unavailable)?,
                &context
                    .message_id
                    .as_lossless()
                    .to_utf8()
                    .map_err(|_| unavailable())?,
                &context.call_id.to_utf8().map_err(|_| unavailable())?,
            )
            .map_err(|_| unavailable())?,
        })
    }
}

async fn create_project_directory(leaf: &Leaf, path: &str) -> Result<(), Error> {
    let target = leaf.paths.resolve(path, true).map_err(|error| {
        Error::refused(match error.kind() {
            std::io::ErrorKind::NotADirectory => format!("Project path {path} is not a directory"),
            _ => format!("Project directory {path} could not be opened or created"),
        })
    })?;
    target
        .authorize_external(&leaf.policy, &leaf.context)
        .await
        .map_err(|_| Error::refused("Unable to create Project directory: permission denied"))?;
    let resource = target
        .mutation
        .canonical
        .to_string_lossy()
        .replace('\\', "/");
    let metadata = match ObjectEncoder::new()
        .field("operation", "create_project_directory")
        .finish()
    {
        ycoding_core::ycoding_schema::JsonValue::Object(value) => value,
        _ => unreachable!(),
    };
    let rejected = || Error::refused("Session guardrail rejected directory creation");
    let reservation = leaf
        .policy
        .admit(
            &leaf.context,
            "file_mutation",
            vec![resource.into()],
            Some(metadata),
            false,
        )
        .await
        .map_err(|_| rejected())?
        .map_err(|error| error.review_message().map_or_else(rejected, Error::refused))?;
    let created = std::fs::create_dir_all(path);
    reservation.release();
    created.map_err(|error| {
        Error::refused(match error.kind() {
            std::io::ErrorKind::NotADirectory | std::io::ErrorKind::AlreadyExists => {
                format!("Project path {path} is not a directory")
            }
            _ => format!("Project directory {path} could not be opened or created"),
        })
    })
}

fn tool_refusal(failure: ToolFailure, cancelled: &str) -> Error {
    match failure {
        ToolFailure::Tool { message, .. } => Error::refused(message),
        ToolFailure::Defect(message) => Error::refused(message),
        ToolFailure::Cancelled => Error::refused(cancelled),
    }
}

fn validate_model(locations: WeakLocations) -> ValidateModel {
    Arc::new(
        move |id: session::Id, model: model::Ref| -> Future<'static, ()> {
            let locations = locations.clone();
            Box::pin(async move {
                let current = locations.upgrade().ok_or_else(unavailable)?;
                let (info, held) = current
                    .session(&id)
                    .map_err(|failure| session_failure(&id, failure))?;
                let refused = || {
                    Error::refused(format!(
                        "Model {}/{} is not available for Session {}",
                        convert::readable(&model.provider_id.0),
                        convert::readable(&model.id),
                        convert::readable(id.as_lossless())
                    ))
                };
                let composed = held.production.as_ref().ok_or_else(refused)?;
                composed
                    .session_generate
                    .models
                    .resolve(&info, &model)
                    .await
                    .map(drop)
                    .map_err(|_| refused())
            })
        },
    )
}

pub(crate) struct Worker {
    stop: watch::Sender<bool>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl Worker {
    pub(crate) async fn start(runtime: Runtime, feed: Feed) -> Result<Self, Failure> {
        let notify = Arc::new(Notify::new());
        let subscriber =
            subscribe(&feed, &notify).map_err(|_| failed("Project notification subscription"))?;
        let recovery_started = std::time::Instant::now();
        runtime
            .recover()
            .await
            .map_err(|_| failed("Project notification recovery"))?;
        crate::launch::startup_stage("project_notification_recovery", recovery_started);
        let admission_started = std::time::Instant::now();
        runtime
            .resume_admitted()
            .await
            .map_err(|_| failed("Project admitted input resumption"))?;
        crate::launch::startup_stage("project_admitted_inputs", admission_started);
        let (stop, stopped) = watch::channel(false);
        let task = tokio::spawn(drive(runtime, feed, subscriber, notify, stopped));
        Ok(Self {
            stop,
            task: Mutex::new(Some(task)),
        })
    }
    pub(crate) async fn stop(&self) -> Result<(), Failure> {
        self.stop.send_replace(true);
        let task = self
            .task
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        match task {
            Some(task) => task
                .await
                .map_err(|_| failed("Project notification worker")),
            None => Ok(()),
        }
    }
}

fn failed(stage: &'static str) -> Failure {
    eprintln!("production composition diagnostic: stage={stage}; category=unavailable");
    Failure::Unavailable(format!("{stage} unavailable"))
}

fn subscribe(
    feed: &Feed,
    notify: &Arc<Notify>,
) -> Result<Subscriber, ycoding_core::event_feed::ResumeError> {
    let wake = notify.clone();
    feed.subscribe_types(Scope::Global, HANDLED_EVENTS, move || wake.notify_one())
}

async fn drive(
    runtime: Runtime,
    feed: Feed,
    mut subscriber: Subscriber,
    notify: Arc<Notify>,
    mut stopped: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {_=stopped.changed()=>return,_=notify.notified()=>{}}
        loop {
            if *stopped.borrow() {
                return;
            }
            match subscriber.next() {
                Ok(Some(item)) => {
                    if runtime.handle(&item.payload).await.is_err() {
                        tracing::error!("Project notification handling failed");
                    }
                }
                Ok(None) => break,
                Err(_) => {
                    match subscribe(&feed, &notify) {
                        Ok(next) => subscriber = next,
                        Err(_) => {
                            tracing::error!("Project notification subscription failed");
                            return;
                        }
                    }
                    if runtime.recover().await.is_err() {
                        tracing::error!("Project notification recovery failed");
                    }
                    break;
                }
            }
        }
    }
}

pub(crate) fn register(dispatcher: &mut Dispatcher) -> Result<(), RegistrationError> {
    dispatcher.handle("coordination.settings", settings)?;
    dispatcher.handle("coordination.list", list)?;
    dispatcher.handle("coordination.get", get)?;
    dispatcher.handle("coordination.board", board)?;
    dispatcher.handle("coordination.create", create)?;
    dispatcher.handle("coordination.update", update)?;
    dispatcher.handle("coordination.attach", attach)?;
    dispatcher.handle("coordination.detach", detach)?;
    dispatcher.handle("coordination.delete", delete)?;
    Ok(())
}
async fn settings(
    invocation: Invocation,
    _request: v5::CoordinationSettingsRequest,
) -> Result<v5::CoordinationSettingsResult, Failure> {
    let settings = runtime(&invocation)?.settings().await.map_err(failure)?;
    result(&ObjectEncoder::new().field("data", &settings).finish())
}
async fn list(
    invocation: Invocation,
    _request: v5::CoordinationListRequest,
) -> Result<v5::CoordinationListResult, Failure> {
    let groups = runtime(&invocation)?.summaries().await.map_err(failure)?;
    result(&ObjectEncoder::new().field("data", &groups).finish())
}
async fn get(
    invocation: Invocation,
    request: v5::CoordinationGetRequest,
) -> Result<v5::CoordinationGetResult, Failure> {
    let id = convert::identifier::<c::GroupId>(&request.params.group_id)?;
    let group = runtime(&invocation)?.get(&id).await.map_err(failure)?;
    result(&ObjectEncoder::new().field("data", &group).finish())
}
async fn board(
    invocation: Invocation,
    request: v5::CoordinationBoardRequest,
) -> Result<v5::CoordinationBoardResult, Failure> {
    let id = convert::identifier::<c::GroupId>(&request.params.group_id)?;
    let board = runtime(&invocation)?.board(&id).await.map_err(failure)?;
    result(&ObjectEncoder::new().field("data", &board).finish())
}
async fn create(
    invocation: Invocation,
    request: v5::CoordinationCreateRequest,
) -> Result<v5::CoordinationCreateResult, Failure> {
    let runtime = runtime(&invocation)?;
    let input = decode::<c::CreateInput, _>(&request.payload)?;
    let group = invocation
        .core()?
        .coordination
        .create(input)
        .await
        .map_err(failure)?;
    let info = runtime.get(&group.id).await.map_err(failure)?;
    result(&ObjectEncoder::new().field("data", &info).finish())
}
async fn update(
    invocation: Invocation,
    request: v5::CoordinationUpdateRequest,
) -> Result<v5::CoordinationUpdateResult, Failure> {
    let runtime = runtime(&invocation)?;
    let id = convert::identifier::<c::GroupId>(&request.params.group_id)?;
    let input = decode::<c::UpdateInput, _>(&request.payload)?;
    let group = invocation
        .core()?
        .coordination
        .update(&id, input)
        .await
        .map_err(failure)?;
    let info = runtime.get(&group.id).await.map_err(failure)?;
    result(&ObjectEncoder::new().field("data", &info).finish())
}
async fn delete(
    invocation: Invocation,
    request: v5::CoordinationDeleteRequest,
) -> Result<v5::CoordinationDeleteResult, Failure> {
    runtime(&invocation)?;
    let id = convert::identifier::<c::GroupId>(&request.params.group_id)?;
    invocation
        .core()?
        .coordination
        .delete(&id)
        .await
        .map_err(failure)?;
    Ok(v5::CoordinationDeleteResult { data: v5::Empty {} })
}
async fn attach(
    invocation: Invocation,
    request: v5::CoordinationAttachRequest,
) -> Result<v5::CoordinationAttachReply, Failure> {
    let runtime = runtime(&invocation)?;
    let id = convert::identifier::<c::GroupId>(&request.params.group_id)?;
    let group = runtime.get(&id).await.map_err(failure)?;
    let input = decode::<c::AttachInput, _>(&request.payload)?;
    let attached = runtime
        .attach(
            &group.master.session_id,
            AttachInput {
                session_id: input.session_id,
                owner_session_id: input.owner_session_id,
            },
            Box::new(|_| Box::pin(async { Ok(()) })),
            Some(&id),
        )
        .await
        .map_err(failure)?;
    result(&ObjectEncoder::new().field("data", &attached).finish())
}
async fn detach(
    invocation: Invocation,
    request: v5::CoordinationDetachRequest,
) -> Result<v5::CoordinationDetachResult, Failure> {
    let runtime = runtime(&invocation)?;
    let id = convert::identifier::<c::GroupId>(&request.params.group_id)?;
    let group = runtime.get(&id).await.map_err(failure)?;
    let removed = runtime
        .remove(
            &group.master.session_id,
            MemberInput {
                session_id: convert::identifier::<session::Id>(&request.params.session_id)?,
            },
            Some(&id),
        )
        .await
        .map_err(failure)?;
    result(&ObjectEncoder::new().field("data", &removed).finish())
}
fn runtime(invocation: &Invocation) -> Result<&Runtime, Failure> {
    invocation
        .core()?
        .coordination_runtime
        .as_ref()
        .ok_or_else(|| Failure::Unavailable("Project runtime is not bound".into()))
}
fn decode<T: DomainDecode, Q: Message + Name>(message: &Q) -> Result<T, Failure> {
    let value = domain_json::decode(&Q::full_name(), &message.encode_to_vec())
        .map_err(|_| Failure::Invalid("Malformed Project payload".into()))?;
    T::decode(&json::value(&value)).map_err(|_| Failure::Coordination {
        message: "Invalid Project input".into(),
        reason: "Coordination.InvalidInputError",
    })
}
fn result<R: Message + Name + Default>(value: &impl DomainEncode) -> Result<R, Failure> {
    let bytes = domain_json::encode(
        &R::full_name(),
        &convert::json_domain(&value.encode()),
        limits::INLINE_BODY_BYTES as usize,
    )
    .map_err(|_| Failure::Unavailable("Project result cannot be encoded".into()))?;
    R::decode(bytes.as_slice())
        .map_err(|_| Failure::Unavailable("Project result cannot be decoded".into()))
}
fn failure(error: Error) -> Failure {
    if let Some(reason) = error.reason() {
        Failure::Coordination {
            message: error.to_string(),
            reason,
        }
    } else {
        Failure::Unavailable("Project service is unavailable".into())
    }
}
