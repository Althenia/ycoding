use super::{Error, schema, v5, wire};
use crate::{
    platform::process,
    tools::{
        context::{Context, Progress, policy::LeafPolicy},
        registry::{self, Failure, Registration, Registry, Tool, ToolFuture},
    },
};
use prost::Message;
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
    time::{Instant, timeout},
};
use ycoding_ai::llm::{ToolDefinition, ToolOutput};
use ycoding_schema::{JsonValue, session_error};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolGrant {
    pub namespace: String,
    pub tools: Vec<String>,
    pub action: String,
    pub resources: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FamilyGrant {
    pub family: v5::CapabilityFamily,
    pub scopes: Vec<String>,
    pub action: String,
    pub resources: Vec<String>,
}
#[derive(Clone)]
pub struct SessionHost {
    pub store: crate::session::store::Service,
    pub location: ycoding_schema::location::Ref,
}
#[derive(Clone, Default)]
pub struct Host {
    pub mcp: Option<Arc<crate::resources::mcp::Service>>,
    pub integrations: Option<crate::resources::auth::integration::Registry>,
    pub sessions: Option<SessionHost>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Configuration {
    pub identity: String,
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub directory: PathBuf,
    pub grants: Vec<ToolGrant>,
    pub families: Vec<FamilyGrant>,
    pub registration_order: u32,
}
impl Configuration {
    pub fn load(
        configuration: &crate::resources::config::Configuration,
        directory: PathBuf,
    ) -> Result<Vec<Self>, Error> {
        Self::reject_obsolete(configuration)?;
        let mut extensions: Vec<Self> = Vec::new();
        for value in configuration.values("extensions") {
            let JsonValue::Array(entries) = value else {
                return Err(Error::InvalidConfiguration);
            };
            for entry in entries {
                let JsonValue::Object(entry) = entry else {
                    return Err(Error::InvalidConfiguration);
                };
                if entry.iter().any(|(key, _)| {
                    !key.as_str().is_some_and(|key| {
                        ["identity", "executable", "args", "grants"].contains(&key)
                    })
                }) {
                    return Err(Error::InvalidConfiguration);
                }
                let identity = config_text(entry.get(&"identity".into()))?;
                let executable = config_text(entry.get(&"executable".into()))?.into();
                let args = match entry.get(&"args".into()) {
                    None => vec![],
                    value => config_strings(value)?,
                };
                let Some(JsonValue::Array(grants)) = entry.get(&"grants".into()) else {
                    return Err(Error::InvalidConfiguration);
                };
                let families = grants.iter().filter(|grant| matches!(grant, JsonValue::Object(object) if config_text(object.get(&"family".into())).is_ok_and(|family| family != "tools"))).map(|grant| {
                    let JsonValue::Object(grant) = grant else { return Err(Error::InvalidConfiguration); };
                    if grant.iter().any(|(key, _)| !key.as_str().is_some_and(|key| ["family", "scopes", "action", "resources"].contains(&key))) { return Err(Error::InvalidConfiguration); }
                    let family = match config_text(grant.get(&"family".into()))?.as_str() { "hooks" => v5::CapabilityFamily::Hooks, "transforms" => v5::CapabilityFamily::Transforms, "events" => v5::CapabilityFamily::Events, "registrations" => v5::CapabilityFamily::Registrations, "mcp" => v5::CapabilityFamily::Mcp, "auth" => v5::CapabilityFamily::Auth, "session" => v5::CapabilityFamily::Session, "providers" => v5::CapabilityFamily::Providers, _ => return Err(Error::InvalidConfiguration) };
                    Ok(FamilyGrant { family, scopes: config_strings(grant.get(&"scopes".into()))?, action: config_text(grant.get(&"action".into()))?, resources: config_strings(grant.get(&"resources".into()))? })
                }).collect::<Result<Vec<_>, Error>>()?;
                let grants = grants
                    .iter()
                    .filter(|grant| !matches!(grant, JsonValue::Object(object) if config_text(object.get(&"family".into())).is_ok_and(|family| family != "tools")))
                    .map(|grant| {
                        let JsonValue::Object(grant) = grant else {
                            return Err(Error::InvalidConfiguration);
                        };
                        if grant.iter().any(|(key, _)| {
                            !key.as_str().is_some_and(|key| {
                                ["family", "namespace", "tools", "action", "resources"]
                                    .contains(&key)
                            })
                        }) || config_text(grant.get(&"family".into()))? != "tools"
                        {
                            return Err(Error::InvalidConfiguration);
                        }
                        Ok(ToolGrant {
                            namespace: config_text(grant.get(&"namespace".into()))?,
                            tools: config_strings(grant.get(&"tools".into()))?,
                            action: config_text(grant.get(&"action".into()))?,
                            resources: config_strings(grant.get(&"resources".into()))?,
                        })
                    })
                    .collect::<Result<Vec<_>, Error>>()?;
                let position = extensions
                    .iter()
                    .position(|extension| extension.identity == identity)
                    .unwrap_or(extensions.len());
                let resolved = Self {
                    identity,
                    executable,
                    args,
                    directory: directory.clone(),
                    grants,
                    families,
                    registration_order: position as u32,
                };
                resolved.validate()?;
                if position == extensions.len() {
                    extensions.push(resolved);
                } else {
                    extensions[position] = resolved;
                }
            }
        }
        Ok(extensions)
    }
    pub fn reject_obsolete(
        configuration: &crate::resources::config::Configuration,
    ) -> Result<(), Error> {
        if configuration.diagnostics.iter().any(|diagnostic| {
            diagnostic.fail_closed == Some(true)
                && diagnostic.reason.0.as_str() == Some("removed-keys")
        }) {
            return Err(Error::ObsoleteConfiguration);
        }
        if configuration.diagnostics.iter().any(|diagnostic| {
            diagnostic.json_path.as_ref().is_some_and(|path| {
                path.as_str()
                    .is_some_and(|path| path.starts_with("$.extensions"))
            })
        }) {
            return Err(Error::InvalidConfiguration);
        }
        for key in ["plugins", "plugin", "npm"] {
            if configuration.latest(key).is_some() {
                return Err(Error::ObsoleteConfiguration);
            }
        }
        if configuration
            .values("providers")
            .chain(configuration.values("provider"))
            .any(obsolete_provider)
        {
            return Err(Error::ObsoleteConfiguration);
        }
        Ok(())
    }
    pub fn validate(&self) -> Result<(), Error> {
        if !identifier(&self.identity)
            || !self.executable.is_absolute()
            || !self.executable.is_file()
            || !self.directory.is_absolute()
            || !self.directory.is_dir()
            || self.args.len() > 64
            || self
                .args
                .iter()
                .any(|arg| arg.contains('\0') || arg.len() > 4096)
            || (self.grants.is_empty() && self.families.is_empty())
            || self.grants.len() > 64
        {
            return Err(Error::InvalidConfiguration);
        }
        if self.executable.extension().is_some_and(|extension| {
            ["js", "ts", "mjs", "cjs"]
                .iter()
                .any(|item| extension == *item)
        }) || self.executable.file_stem().is_some_and(|stem| {
            ["node", "bun", "npm", "npx"]
                .iter()
                .any(|item| stem == *item)
        }) {
            return Err(Error::ObsoleteConfiguration);
        }
        let mut scopes = BTreeSet::new();
        let mut family_scopes = BTreeSet::new();
        for grant in &self.families {
            if grant.scopes.iter().any(|scope| {
                !super::families::valid_scope(grant.family, scope)
                    || !family_scopes.insert((grant.family as i32, scope.as_str()))
            }) {
                return Err(Error::InvalidConfiguration);
            }
            if grant.family == v5::CapabilityFamily::Tools
                || grant.scopes.is_empty()
                || grant.scopes.len() > 64
                || !identifier(&grant.action)
                || grant.resources.is_empty()
                || grant.resources.len() > 64
                || grant.scopes.iter().any(|scope| {
                    scope.is_empty() || scope.len() > 256 || scope.chars().any(char::is_control)
                })
                || grant.resources.iter().any(|resource| {
                    resource.is_empty()
                        || resource.len() > 1024
                        || resource.chars().any(char::is_control)
                })
            {
                return Err(Error::InvalidConfiguration);
            }
        }
        for grant in &self.grants {
            if registry::validate_namespace(&grant.namespace).is_err()
                || !identifier(&grant.action)
                || grant.tools.is_empty()
                || grant.tools.len() > 64
                || grant.resources.is_empty()
                || grant.resources.len() > 64
                || grant.resources.iter().any(|resource| {
                    resource.is_empty()
                        || resource.len() > 1024
                        || resource.chars().any(char::is_control)
                })
            {
                return Err(Error::InvalidConfiguration);
            }
            for tool in &grant.tools {
                if !identifier(tool)
                    || registry::normalize_name(tool) != *tool
                    || !scopes.insert(format!("{}_{}", grant.namespace.replace('.', "_"), tool))
                {
                    return Err(Error::InvalidConfiguration);
                }
            }
        }
        if hello(self, &"g".repeat(128)).encoded_len() + 140 > wire::STARTUP_BYTES {
            return Err(Error::InvalidConfiguration);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if std::fs::metadata(&self.executable)
                .map_err(|_| Error::InvalidConfiguration)?
                .permissions()
                .mode()
                & 0o111
                == 0
            {
                return Err(Error::InvalidConfiguration);
            }
        }
        Ok(())
    }
}
fn config_text(value: Option<&JsonValue>) -> Result<String, Error> {
    match value {
        Some(JsonValue::String(value)) => value
            .as_str()
            .map(str::to_owned)
            .ok_or(Error::InvalidConfiguration),
        _ => Err(Error::InvalidConfiguration),
    }
}
fn config_strings(value: Option<&JsonValue>) -> Result<Vec<String>, Error> {
    let Some(JsonValue::Array(items)) = value else {
        return Err(Error::InvalidConfiguration);
    };
    items.iter().map(|item| config_text(Some(item))).collect()
}
fn obsolete_provider(value: &JsonValue) -> bool {
    match value {
        JsonValue::Object(object) => object.iter().any(|(key, value)| {
            key.as_str()
                .is_some_and(|key| ["npm", "package", "plugin"].contains(&key))
                || obsolete_provider(value)
        }),
        JsonValue::Array(items) => items.iter().any(obsolete_provider),
        _ => false,
    }
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
}
fn hello(configuration: &Configuration, generation: &str) -> v5::Hello {
    v5::Hello {
        revision: wire::REVISION,
        identity: configuration.identity.clone(),
        generation: generation.into(),
        grants: configuration
            .grants
            .iter()
            .map(|grant| v5::Grant {
                family: v5::CapabilityFamily::Tools as i32,
                scope: Some(v5::ToolScope {
                    namespace: grant.namespace.clone(),
                    tools: grant.tools.clone(),
                    action: grant.action.clone(),
                    resources: grant.resources.clone(),
                }),
                family_scope: None,
            })
            .chain(configuration.families.iter().map(|grant| v5::Grant {
                family: grant.family as i32,
                scope: None,
                family_scope: Some(v5::FamilyScope {
                    scopes: grant.scopes.clone(),
                    action: grant.action.clone(),
                    resources: grant.resources.clone(),
                }),
            }))
            .collect(),
        registration_order: configuration.registration_order,
    }
}

#[derive(Clone, Debug)]
pub struct Options {
    pub startup: Duration,
    pub execution: Duration,
    pub cleanup: Duration,
    pub shutdown: Duration,
    pub write: Duration,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            startup: Duration::from_secs(5),
            execution: Duration::from_secs(12 * 3600),
            cleanup: Duration::from_secs(2),
            shutdown: Duration::from_secs(2),
            write: Duration::from_secs(5),
        }
    }
}
pub(super) struct Shared {
    sender: mpsc::Sender<Request>,
    pub(super) launch: Context,
    pub(super) accepting: AtomicBool,
    next: AtomicU64,
    diagnostics: Mutex<VecDeque<v5::DiagnosticCode>>,
    control: process::Control,
    closed: tokio::sync::watch::Sender<bool>,
    task: tokio::sync::Mutex<Option<JoinHandle<()>>>,
    pub(super) families: Vec<FamilyGrant>,
    pub(super) host: Host,
    pub(super) policy: Arc<LeafPolicy>,
    pub(super) subscriptions: Mutex<BTreeMap<u64, Vec<String>>>,
    pending_events: Mutex<BTreeSet<u64>>,
}
pub struct Extension {
    pub(super) shared: Arc<Shared>,
    pub generation: String,
    pub(super) order: u32,
    pub(super) declarations: Vec<v5::TransformRegistration>,
    pub(super) domains: Vec<v5::DomainRegistration>,
}
impl Shared {
    pub(super) async fn auth(
        self: &Arc<Self>,
        operation: v5::auth_request::Operation,
    ) -> Result<(u64, v5::auth_reply::Outcome), Error> {
        if !self.accepting.load(Ordering::Acquire) {
            return Err(Error::Stopped);
        }
        let request = self.next.fetch_add(1, Ordering::Relaxed);
        let (reply, receive) = oneshot::channel();
        self.sender
            .send(Request::Auth {
                request: v5::AuthRequest {
                    request,
                    operation: Some(operation),
                },
                reply,
            })
            .await
            .map_err(|_| Error::Stopped)?;
        let outcome = receive.await.map_err(|_| Error::UnknownOutcome)?;
        Ok((request, outcome?))
    }
    pub(super) async fn provider_attempt(
        self: &Arc<Self>,
        attempt: v5::ProviderAttempt,
    ) -> Result<
        (
            u64,
            oneshot::Receiver<Result<Vec<ycoding_schema::JsonValue>, Error>>,
        ),
        Error,
    > {
        if !self.accepting.load(Ordering::Acquire) {
            return Err(Error::Stopped);
        }
        let request = self.next.fetch_add(1, Ordering::Relaxed);
        let (reply, receive) = oneshot::channel();
        self.sender
            .send(Request::Provider {
                id: request,
                attempt,
                reply,
            })
            .await
            .map_err(|_| Error::Stopped)?;
        Ok((request, receive))
    }
    pub(super) fn provider_cancel(&self, request: u64) {
        let _ = self.sender.try_send(Request::ProviderCancel(request));
    }
    pub(super) async fn transform(
        self: &Arc<Self>,
        registration: &v5::TransformRegistration,
        context: &Context,
        revision: u64,
        draft: JsonValue,
    ) -> Result<JsonValue, Error> {
        if !self.accepting.load(Ordering::Acquire) {
            return Err(Error::Stopped);
        }
        let stage =
            v5::TransformStage::try_from(registration.stage).map_err(|_| Error::Protocol)?;
        let family = super::families::stage_family(stage);
        let grant = super::families::grant(self, family, super::families::scope(stage))?;
        self.policy
            .assert(
                context,
                &grant.action,
                grant
                    .resources
                    .iter()
                    .map(|resource| resource.as_str().into())
                    .collect(),
                vec![],
                None,
            )
            .await
            .map_err(|_| Error::Permission)?;
        let _reservation = self
            .policy
            .reserve(
                context,
                &grant.action,
                grant
                    .resources
                    .iter()
                    .map(|resource| resource.as_str().into())
                    .collect(),
                None,
            )
            .await
            .map_err(|_| Error::Permission)?;
        wire::check_value(&draft)?;
        let invocation = self.next.fetch_add(1, Ordering::Relaxed);
        let call = v5::Call {
            invocation,
            session_id: context
                .session_id
                .as_lossless()
                .as_str()
                .ok_or(Error::Protocol)?
                .into(),
            message_id: context
                .message_id
                .as_lossless()
                .as_str()
                .ok_or(Error::Protocol)?
                .into(),
            call_id: wire::text(&context.call_id),
            agent: context.agent.as_str().ok_or(Error::Protocol)?.into(),
        };
        let (reply, mut receive) = oneshot::channel();
        self.sender
            .send(Request::Transform {
                transform: Box::new(v5::Transform {
                    call,
                    registration: registration.id.clone(),
                    stage: registration.stage,
                    revision,
                    draft: wire::value(&draft),
                }),
                context: context.clone(),
                reply,
            })
            .await
            .map_err(|_| Error::Stopped)?;
        let mut guard = Invocation {
            shared: self.clone(),
            invocation,
            armed: true,
        };
        let result = tokio::select! { result = &mut receive => result, _ = context.cancellation.cancelled() => { let _ = self.sender.send(Request::Cancel(invocation)).await; receive.await } }.map_err(|_| Error::UnknownOutcome)?;
        guard.armed = false;
        let result = result?;
        if !self.accepting.load(Ordering::Acquire) {
            return Err(Error::Stopped);
        }
        Ok(result)
    }
}
impl Extension {
    pub async fn start(
        configuration: Configuration,
        options: Options,
        registry: &Registry,
        policy: Arc<LeafPolicy>,
        launch: &Context,
        host: Host,
    ) -> Result<Self, Error> {
        configuration.validate()?;
        if [
            &options.startup,
            &options.cleanup,
            &options.shutdown,
            &options.write,
        ]
        .iter()
        .any(|duration| duration.is_zero() || **duration > Duration::from_secs(5))
            || options.execution.is_zero()
            || options.execution > Duration::from_secs(12 * 3600)
        {
            return Err(Error::InvalidConfiguration);
        }
        let executable = configuration
            .executable
            .to_str()
            .ok_or(Error::InvalidConfiguration)?;
        policy
            .assert(
                launch,
                "extension.launch",
                vec![executable.into()],
                vec![],
                None,
            )
            .await
            .map_err(|_| Error::Permission)?;
        let _reservation = policy
            .reserve(launch, "extension.launch", vec![executable.into()], None)
            .await
            .map_err(|_| Error::Permission)?;
        for grant in &configuration.families {
            policy
                .assert(
                    launch,
                    &grant.action,
                    grant
                        .resources
                        .iter()
                        .map(|resource| resource.as_str().into())
                        .collect(),
                    vec![],
                    None,
                )
                .await
                .map_err(|_| Error::Permission)?;
        }
        let generation = crate::platform::identifier("ext_").map_err(|_| Error::Spawn)?;
        let mut command = process::Command::new(executable, configuration.args.clone());
        command.cwd = Some(configuration.directory.clone());
        let mut process = process::spawn(command).await.map_err(|_| Error::Spawn)?;
        let output = process.take_output().ok_or(Error::Spawn)?;
        let (sender, receiver) = mpsc::channel(32);
        let shared = Arc::new(Shared {
            sender,
            accepting: AtomicBool::new(false),
            next: AtomicU64::new(1),
            diagnostics: Mutex::new(VecDeque::new()),
            control: process.control(),
            closed: tokio::sync::watch::channel(false).0,
            task: tokio::sync::Mutex::new(None),
            families: configuration.families.clone(),
            host,
            policy: policy.clone(),
            launch: launch.clone(),
            subscriptions: Mutex::new(BTreeMap::new()),
            pending_events: Mutex::new(BTreeSet::new()),
        });
        let mut owner = Owner {
            process,
            output,
            decoder: wire::Decoder::default(),
            frames: VecDeque::new(),
            shared: shared.clone(),
            generation: generation.clone(),
            options,
            registration: None,
            active: BTreeMap::new(),
            seen: BTreeSet::new(),
            transforms: BTreeMap::new(),
            hooks: Vec::new(),
            event_credits: BTreeMap::new(),
            host_calls: BTreeMap::new(),
            host_requests: BTreeSet::new(),
            auth: BTreeMap::new(),
            providers: BTreeMap::new(),
            auth_registration: None,
        };
        let negotiated = timeout(owner.options.startup, owner.negotiate(&configuration))
            .await
            .unwrap_or(Err(Error::Timeout));
        let declarations = match negotiated {
            Ok(tools) => tools,
            Err(error) => {
                owner.finish(error).await;
                return Err(error);
            }
        };
        let mut batches = Vec::new();
        let mut names = BTreeSet::new();
        if let Err(error) = super::families::validate_batch(&shared, &declarations) {
            owner.finish(error).await;
            return Err(error);
        }
        for declaration in declarations.tools {
            let grant = configuration
                .grants
                .iter()
                .find(|grant| {
                    grant.namespace == declaration.namespace
                        && grant.tools.contains(&declaration.name)
                })
                .ok_or(Error::Unauthorized);
            let prepared = grant.and_then(|grant| {
                if !names.insert((declaration.namespace.clone(), declaration.name.clone()))
                    || !identifier(&declaration.name)
                    || (!declaration.direct && !declaration.code_mode)
                {
                    return Err(Error::Unauthorized);
                }
                let input = wire::read_value(declaration.input_schema.clone())?;
                let output = wire::read_value(declaration.output_schema.clone())?;
                schema::check(&input)?;
                schema::check(&output)?;
                let description = wire::read_text(declaration.description.clone())?;
                if description.as_str().is_none() {
                    return Err(Error::Schema);
                }
                Ok(Arc::new(ProcessTool {
                    shared: shared.clone(),
                    namespace: declaration.namespace.clone(),
                    name: declaration.name.clone(),
                    description,
                    input,
                    output,
                    grant: grant.clone(),
                    policy: policy.clone(),
                }) as Arc<dyn Tool>)
            });
            let tool = match prepared {
                Ok(tool) => tool,
                Err(error) => {
                    owner.finish(error).await;
                    return Err(error);
                }
            };
            batches.push(registry::ProcessRegistration {
                name: declaration.name,
                tool,
                namespace: declaration.namespace,
                direct: declaration.direct,
                code_mode: declaration.code_mode,
            });
        }
        match registry.register_process_batch(batches) {
            Ok(registration) => owner.registration = Some(registration),
            Err(_) => {
                owner.finish(Error::Unauthorized).await;
                return Err(Error::Unauthorized);
            }
        }
        owner.hooks = super::families::install_hooks(
            &shared,
            &declarations.transforms,
            configuration.registration_order,
            registry,
        );
        match super::families::install_auth(&shared, &declarations.oauth) {
            Ok(registration) => owner.auth_registration = registration,
            Err(error) => {
                owner.finish(error).await;
                return Err(error);
            }
        }
        shared.accepting.store(true, Ordering::Release);
        diagnose(&shared, v5::DiagnosticCode::Started);
        let task = tokio::spawn(async move {
            owner.run(receiver).await;
        });
        *shared.task.lock().await = Some(task);
        super::provider::register_generation(&shared, &generation);
        Ok(Self {
            shared,
            generation,
            order: configuration.registration_order,
            declarations: declarations.transforms,
            domains: declarations.domains,
        })
    }
    pub fn pid(&self) -> u32 {
        self.shared.control.pid()
    }
    pub fn publish<E: ycoding_schema::event::EventType>(
        &self,
        event: &ycoding_schema::event::EphemeralPayload<E>,
    ) -> Result<usize, Error> {
        use ycoding_schema::DomainEncode;
        self.publish_value(E::TYPE, event.encode())
    }
    pub fn publish_durable<E: ycoding_schema::event::DurableEventType>(
        &self,
        event: &ycoding_schema::event::DurablePayload<E>,
    ) -> Result<usize, Error> {
        use ycoding_schema::DomainEncode;
        self.publish_value(E::TYPE, event.encode())
    }
    fn publish_value(&self, family: &str, envelope: JsonValue) -> Result<usize, Error> {
        if !self.shared.accepting.load(Ordering::Acquire) {
            return Err(Error::Stopped);
        }
        super::families::grant(&self.shared, v5::CapabilityFamily::Events, family)?;
        wire::check_value(&envelope)?;
        let subscriptions = self
            .shared
            .subscriptions
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .filter(|(_, families)| families.iter().any(|item| item == family))
            .map(|(id, _)| *id)
            .collect::<Vec<_>>();
        let events = subscriptions
            .iter()
            .map(|subscription| v5::EventDelivery {
                delivery: self.shared.next.fetch_add(1, Ordering::Relaxed),
                subscription: *subscription,
                family: family.into(),
                envelope: wire::value(&envelope),
            })
            .collect::<Vec<_>>();
        if events.iter().any(|event| {
            v5::HostFrame {
                generation: self.generation.clone(),
                body: Some(v5::host_frame::Body::Event(event.clone())),
            }
            .encoded_len()
                > wire::EVENT_BYTES
        }) {
            return Err(Error::Capacity);
        }
        let permits = (0..events.len())
            .map(|_| {
                self.shared
                    .sender
                    .clone()
                    .try_reserve_owned()
                    .map_err(|_| Error::Capacity)
            })
            .collect::<Result<Vec<_>, Error>>()?;
        let mut pending = self
            .shared
            .pending_events
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !self.shared.accepting.load(Ordering::Acquire) {
            return Err(Error::Stopped);
        }
        if pending.len() + events.len() > wire::MAX_EVENT_DELIVERIES {
            return Err(Error::Capacity);
        }
        for (event, permit) in events.into_iter().zip(permits) {
            pending.insert(event.delivery);
            permit.send(Request::Event(event));
        }
        Ok(subscriptions.len())
    }
    pub async fn closed(&self) {
        let mut closed = self.shared.closed.subscribe();
        while !*closed.borrow_and_update() {
            if closed.changed().await.is_err() {
                break;
            }
        }
    }
    pub fn diagnostics(&self) -> Vec<v5::DiagnosticCode> {
        self.shared
            .diagnostics
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .copied()
            .collect()
    }
    pub async fn shutdown(&self) {
        self.shared.accepting.store(false, Ordering::Release);
        let _ = self.shared.sender.send(Request::Stop).await;
        if let Some(task) = self.shared.task.lock().await.take() {
            let _ = task.await;
        }
    }
    pub async fn replace(
        &self,
        configuration: Configuration,
        options: Options,
        registry: &Registry,
        policy: Arc<LeafPolicy>,
        launch: &Context,
        host: Host,
    ) -> Result<Self, Error> {
        configuration.validate()?;
        self.shutdown().await;
        Self::start(configuration, options, registry, policy, launch, host).await
    }
}
impl Drop for Extension {
    fn drop(&mut self) {
        self.shared.accepting.store(false, Ordering::Release);
        if self.shared.sender.try_send(Request::Stop).is_err() {
            self.shared.control.terminate_now();
        }
    }
}
fn diagnose(shared: &Shared, code: v5::DiagnosticCode) {
    let mut entries = shared
        .diagnostics
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if entries.len() == 32 {
        entries.pop_front();
    }
    entries.push_back(code);
}
struct ProcessTool {
    shared: Arc<Shared>,
    namespace: String,
    name: String,
    description: ycoding_schema::LosslessString,
    input: JsonValue,
    output: JsonValue,
    grant: ToolGrant,
    policy: Arc<LeafPolicy>,
}
impl Tool for ProcessTool {
    fn definition(&self, name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.into(),
            description: self.description.clone(),
            input_schema: self.input.clone(),
            output_schema: Some(self.output.clone()),
            cache: None,
            metadata: None,
            native: None,
        }
    }
    fn permission(&self) -> Option<&str> {
        Some(&self.grant.action)
    }
    fn validate_output(&self, output: &ToolOutput) -> Result<(), Failure> {
        schema::validate(&self.output, &output.structured).map_err(failure)
    }
    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            if !self.shared.accepting.load(Ordering::Acquire) {
                return Err(failure(Error::Stopped));
            }
            wire::check_value(&input).map_err(failure)?;
            schema::validate(&self.input, &input).map_err(failure)?;
            self.policy
                .assert(
                    &context,
                    &self.grant.action,
                    self.grant
                        .resources
                        .iter()
                        .map(|resource| resource.as_str().into())
                        .collect(),
                    vec![],
                    None,
                )
                .await?;
            let _reservation = self
                .policy
                .reserve(
                    &context,
                    &self.grant.action,
                    self.grant
                        .resources
                        .iter()
                        .map(|resource| resource.as_str().into())
                        .collect(),
                    None,
                )
                .await?;
            if !self.shared.accepting.load(Ordering::Acquire) {
                return Err(failure(Error::Stopped));
            }
            let invocation = self.shared.next.fetch_add(1, Ordering::Relaxed);
            let call = v5::Call {
                invocation,
                session_id: context
                    .session_id
                    .as_lossless()
                    .as_str()
                    .ok_or_else(|| failure(Error::Protocol))?
                    .into(),
                message_id: context
                    .message_id
                    .as_lossless()
                    .as_str()
                    .ok_or_else(|| failure(Error::Protocol))?
                    .into(),
                call_id: wire::text(&context.call_id),
                agent: context
                    .agent
                    .as_str()
                    .ok_or_else(|| failure(Error::Protocol))?
                    .into(),
            };
            let (send, mut receive) = oneshot::channel();
            let request = Request::Execute {
                execute: Box::new(v5::Execute {
                    call,
                    namespace: self.namespace.clone(),
                    tool: self.name.clone(),
                    input: wire::value(&input),
                }),
                context: context.clone(),
                reply: send,
            };
            self.shared
                .sender
                .send(request)
                .await
                .map_err(|_| failure(Error::Stopped))?;
            let mut guard = Invocation {
                shared: self.shared.clone(),
                invocation,
                armed: true,
            };
            let result = tokio::select! {
                result = &mut receive => result,
                _ = context.cancellation.cancelled() => {
                    let _ = self.shared.sender.send(Request::Cancel(invocation)).await;
                    receive.await
                }
            }
            .map_err(|_| failure(Error::UnknownOutcome))?;
            guard.armed = false;
            let output = result.map_err(failure)?;
            schema::validate(&self.output, &output.structured).map_err(failure)?;
            Ok(output)
        })
    }
}
pub(super) fn failure(error: Error) -> Failure {
    if error == Error::Cancelled {
        return Failure::Cancelled;
    }
    Failure::Tool {
        message: error.to_string(),
        error: Some(session_error::Error {
            r#type: match error {
                Error::UnknownOutcome => "extension.unknown_outcome",
                Error::Timeout => "extension.timeout",
                _ => "extension.failure",
            }
            .into(),
            message: error.to_string().into(),
        }),
    }
}
struct Invocation {
    shared: Arc<Shared>,
    invocation: u64,
    armed: bool,
}
impl Drop for Invocation {
    fn drop(&mut self) {
        if self.armed
            && self
                .shared
                .sender
                .try_send(Request::Cancel(self.invocation))
                .is_err()
        {
            self.shared.control.terminate_now();
        }
    }
}
pub(super) enum Request {
    Execute {
        execute: Box<v5::Execute>,
        context: Context,
        reply: oneshot::Sender<Result<ToolOutput, Error>>,
    },
    Cancel(u64),
    Transform {
        transform: Box<v5::Transform>,
        context: Context,
        reply: oneshot::Sender<Result<JsonValue, Error>>,
    },
    Event(v5::EventDelivery),
    HostReply {
        call: v5::Call,
        request: u64,
        outcome: v5::host_reply::Outcome,
    },
    Auth {
        request: v5::AuthRequest,
        reply: oneshot::Sender<Result<v5::auth_reply::Outcome, Error>>,
    },
    Provider {
        id: u64,
        attempt: v5::ProviderAttempt,
        reply: oneshot::Sender<Result<Vec<ycoding_schema::JsonValue>, Error>>,
    },
    ProviderCancel(u64),
    Stop,
}
#[derive(Clone, Copy, PartialEq)]
enum AuthKind {
    Authorize,
    Callback,
    Submit,
    Refresh,
    Label,
}
impl AuthKind {
    fn accepts(self, outcome: &v5::auth_reply::Outcome) -> bool {
        use v5::auth_reply::Outcome;
        match (self, outcome) {
            (_, Outcome::Failure(failure)) => v5::FailureCode::try_from(failure.code).is_ok(),
            (Self::Authorize, Outcome::Authorization(_))
            | (Self::Callback | Self::Refresh, Outcome::Credential(_))
            | (Self::Submit, Outcome::Done(_))
            | (Self::Label, Outcome::Label(_) | Outcome::Done(_)) => true,
            _ => false,
        }
    }
}
fn auth_kind(request: &v5::AuthRequest) -> Option<AuthKind> {
    use v5::auth_request::Operation;
    Some(match request.operation.as_ref()? {
        Operation::Authorize(_) => AuthKind::Authorize,
        Operation::Callback(_) => AuthKind::Callback,
        Operation::Submit(_) => AuthKind::Submit,
        Operation::Refresh(_) => AuthKind::Refresh,
        Operation::Label(_) => AuthKind::Label,
    })
}
struct PendingAuth {
    kind: AuthKind,
    reply: oneshot::Sender<Result<v5::auth_reply::Outcome, Error>>,
    deadline: Instant,
}
struct PendingProvider {
    reply: oneshot::Sender<Result<Vec<ycoding_schema::JsonValue>, Error>>,
    deadline: Instant,
}
struct HostInflight {
    invocation: u64,
    signal: watch::Sender<bool>,
    task: JoinHandle<()>,
}
struct Active {
    call: v5::Call,
    context: Context,
    reply: oneshot::Sender<Result<ToolOutput, Error>>,
    deadline: Instant,
    cancellation: Option<Error>,
    progress: usize,
}
struct ActiveTransform {
    call: v5::Call,
    stage: i32,
    revision: u64,
    context: Context,
    reply: oneshot::Sender<Result<JsonValue, Error>>,
    deadline: Instant,
    cancellation: Option<Error>,
}
struct Owner {
    process: process::Process,
    output: mpsc::Receiver<process::Chunk>,
    decoder: wire::Decoder,
    frames: VecDeque<v5::ChildFrame>,
    shared: Arc<Shared>,
    generation: String,
    options: Options,
    registration: Option<Registration>,
    active: BTreeMap<u64, Active>,
    seen: BTreeSet<(String, String, ycoding_schema::LosslessString)>,
    transforms: BTreeMap<u64, ActiveTransform>,
    hooks: Vec<crate::tools::materialization::HookRegistration>,
    event_credits: BTreeMap<u64, Instant>,
    host_calls: BTreeMap<u64, HostInflight>,
    host_requests: BTreeSet<u64>,
    auth: BTreeMap<u64, PendingAuth>,
    providers: BTreeMap<u64, PendingProvider>,
    auth_registration: Option<crate::resources::auth::integration::Registration>,
}
impl Owner {
    async fn send(&self, body: v5::host_frame::Body) -> Result<(), Error> {
        let bytes = wire::encode(&v5::HostFrame {
            generation: self.generation.clone(),
            body: Some(body),
        })?;
        timeout(self.options.write, self.process.write(bytes))
            .await
            .map_err(|_| Error::UnknownOutcome)?
            .map_err(|_| Error::UnknownOutcome)
    }
    async fn next(&mut self, limit: usize) -> Result<v5::ChildFrame, Error> {
        loop {
            if let Some(frame) = self.frames.pop_front() {
                if frame.generation != self.generation || frame.body.is_none() {
                    return Err(Error::Protocol);
                }
                return Ok(frame);
            }
            let chunk = self.output.recv().await.ok_or(if self.decoder.is_empty() {
                Error::UnknownOutcome
            } else {
                Error::Protocol
            })?;
            if chunk.kind == process::StreamKind::Stderr {
                diagnose(&self.shared, v5::DiagnosticCode::StderrDiscarded);
                continue;
            }
            if chunk.kind != process::StreamKind::Stdout {
                return Err(Error::Protocol);
            }
            self.frames.extend(self.decoder.push(&chunk.bytes, limit)?);
        }
    }
    async fn negotiate(
        &mut self,
        configuration: &Configuration,
    ) -> Result<v5::RegisterTools, Error> {
        self.send(v5::host_frame::Body::Hello(hello(
            configuration,
            &self.generation,
        )))
        .await?;
        let frame = self.next(wire::STARTUP_BYTES).await?;
        let Some(v5::child_frame::Body::Ready(ready)) = frame.body else {
            return Err(Error::Negotiation);
        };
        if ready.revision != wire::REVISION
            || ready.identity != configuration.identity
            || ready.generation != self.generation
        {
            return Err(Error::Negotiation);
        }
        let frame = self.next(wire::STARTUP_BYTES).await?;
        let Some(v5::child_frame::Body::RegisterTools(tools)) = frame.body else {
            return Err(Error::Protocol);
        };
        let count = tools.tools.len()
            + tools.transforms.len()
            + tools.domains.len()
            + tools.subscriptions.len()
            + tools.oauth.len();
        if count == 0 || count > 64 {
            return Err(Error::Capacity);
        }
        Ok(tools)
    }
    fn release_host_calls(&mut self, invocation: u64) {
        self.host_calls.retain(|_, call| {
            if call.invocation != invocation {
                return true;
            }
            call.signal.send_replace(true);
            false
        });
    }
    async fn host_call(&mut self, host: v5::HostCall) -> Result<(), Error> {
        let context = self.owned_context(&host.call)?;
        let operation = host.operation.ok_or(Error::Protocol)?;
        if self.host_requests.len() >= 4096 || !self.host_requests.insert(host.request) {
            return Err(Error::Protocol);
        }
        if self.host_calls.len() >= 8 {
            return self
                .send(v5::host_frame::Body::HostReply(v5::HostReply {
                    call: host.call,
                    request: host.request,
                    outcome: Some(v5::host_reply::Outcome::Failure(v5::Failure {
                        code: v5::FailureCode::Rejected as i32,
                    })),
                }))
                .await;
        }
        let (signal, cancelled) = watch::channel(false);
        let shared = self.shared.clone();
        let (call, request) = (host.call.clone(), host.request);
        let task = tokio::spawn(async move {
            let outcome =
                super::families::host_operation(&shared, &context, operation, cancelled).await;
            let _ = shared
                .sender
                .send(Request::HostReply {
                    call,
                    request,
                    outcome,
                })
                .await;
        });
        self.host_calls.insert(
            host.request,
            HostInflight {
                invocation: host.call.invocation,
                signal,
                task,
            },
        );
        Ok(())
    }
    fn owned_context(&self, call: &v5::Call) -> Result<Context, Error> {
        if let Some(active) = self.active.get(&call.invocation)
            && active.call == *call
            && active.cancellation.is_none()
        {
            return Ok(active.context.clone());
        }
        if let Some(active) = self.transforms.get(&call.invocation)
            && active.call == *call
            && active.cancellation.is_none()
        {
            return Ok(active.context.clone());
        }
        Err(Error::Protocol)
    }
    async fn cancel(&mut self, id: u64, reason: Error) -> Result<(), Error> {
        self.release_host_calls(id);
        if let Some(active) = self.transforms.get_mut(&id) {
            if active.cancellation.is_some() {
                return Ok(());
            }
            active.cancellation = Some(reason);
            active.deadline = Instant::now() + self.options.cleanup;
            let call = active.call.clone();
            return self
                .send(v5::host_frame::Body::Cancel(v5::Cancel { call }))
                .await;
        }
        let Some(active) = self.active.get_mut(&id) else {
            return Ok(());
        };
        if active.cancellation.is_some() {
            return Ok(());
        }
        active.cancellation = Some(reason);
        active.deadline = Instant::now() + self.options.cleanup;
        let call = active.call.clone();
        self.send(v5::host_frame::Body::Cancel(v5::Cancel { call }))
            .await
    }
    async fn run(&mut self, mut receiver: mpsc::Receiver<Request>) {
        let mut stopping = None;
        let terminal = loop {
            if stopping.is_some() && self.active.is_empty() && self.transforms.is_empty() {
                self.registration.take();
                self.auth_registration.take();
                self.hooks.clear();
                self.shared
                    .subscriptions
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .clear();
                if self
                    .send(v5::host_frame::Body::Shutdown(v5::Shutdown {}))
                    .await
                    .is_err()
                {
                    break Error::UnknownOutcome;
                }
                let deadline = Instant::now() + self.options.shutdown;
                loop {
                    match tokio::time::timeout_at(deadline, self.next(wire::FRAME_BYTES)).await {
                        Ok(Ok(frame))
                            if matches!(frame.body, Some(v5::child_frame::Body::Stopped(_))) =>
                        {
                            break;
                        }
                        Ok(Ok(frame))
                            if matches!(frame.body, Some(v5::child_frame::Body::Diagnostic(_))) => {
                        }
                        _ => break,
                    }
                }
                break Error::Stopped;
            }
            let deadline = self
                .active
                .values()
                .map(|active| active.deadline)
                .chain(self.transforms.values().map(|active| active.deadline))
                .chain(self.event_credits.values().copied())
                .chain(self.auth.values().map(|pending| pending.deadline))
                .chain(self.providers.values().map(|pending| pending.deadline))
                .chain(stopping)
                .min()
                .unwrap_or_else(|| Instant::now() + Duration::from_secs(86400));
            tokio::select! {
                request = receiver.recv() => match request {
                    Some(Request::Execute { execute, context, reply }) => {
                        if stopping.is_some() || !self.shared.accepting.load(Ordering::Acquire) { let _ = reply.send(Err(Error::Stopped)); continue; }
                        let identity = (execute.call.session_id.clone(), execute.call.message_id.clone(), context.call_id.clone());
                        if self.active.len() + self.transforms.len() >= 32 || self.seen.len() >= 4096 || !self.seen.insert(identity) { let _ = reply.send(Err(Error::Capacity)); continue; }
                        let id = execute.call.invocation;
                        self.active.insert(id, Active { call: execute.call.clone(), context, reply, deadline: Instant::now() + self.options.execution, cancellation: None, progress: 0 });
                        if let Err(error) = self.send(v5::host_frame::Body::Execute(*execute)).await { break error; }
                    }
                    Some(Request::Transform { transform, context, reply }) => {
                        if stopping.is_some() || !self.shared.accepting.load(Ordering::Acquire) { let _ = reply.send(Err(Error::Stopped)); continue; }
                        if self.active.len() + self.transforms.len() >= 32 || context.cancellation.is_cancelled() { let _ = reply.send(Err(Error::Cancelled)); continue; }
                        self.transforms.insert(transform.call.invocation, ActiveTransform { call: transform.call.clone(), stage: transform.stage, revision: transform.revision, context, reply, deadline: Instant::now() + self.options.execution, cancellation: None });
                        if let Err(error) = self.send(v5::host_frame::Body::Transform(*transform)).await { break error; }
                    }
                    Some(Request::Event(event)) => {
                        if stopping.is_some() || !self.shared.accepting.load(Ordering::Acquire) {
                            self.shared.pending_events.lock().unwrap_or_else(|error| error.into_inner()).remove(&event.delivery);
                            continue;
                        }
                        if self.event_credits.len() >= wire::MAX_EVENT_DELIVERIES { break Error::Capacity; }
                        let allowed = self.shared.subscriptions.lock().unwrap_or_else(|error| error.into_inner()).get(&event.subscription).is_some_and(|families| families.contains(&event.family));
                        if !allowed { self.shared.pending_events.lock().unwrap_or_else(|error| error.into_inner()).remove(&event.delivery); continue; }
                        self.event_credits.insert(event.delivery, Instant::now() + self.options.write);
                        if let Err(error) = self.send(v5::host_frame::Body::Event(event)).await { break error; }
                    }
                    Some(Request::Auth { request, reply }) => {
                        if stopping.is_some() || !self.shared.accepting.load(Ordering::Acquire) { let _ = reply.send(Err(Error::Stopped)); continue; }
                        let Some(kind) = auth_kind(&request) else { let _ = reply.send(Err(Error::Protocol)); continue; };
                        if self.auth.len() >= 8 { let _ = reply.send(Err(Error::Capacity)); continue; }
                        self.auth.insert(request.request, PendingAuth { kind, reply, deadline: Instant::now() + self.options.execution });
                        if let Err(error) = self.send(v5::host_frame::Body::Auth(request)).await { break error; }
                    }
                    Some(Request::Provider { id, attempt, reply }) => {
                        if stopping.is_some() || !self.shared.accepting.load(Ordering::Acquire) { let _ = reply.send(Err(Error::Stopped)); continue; }
                        if self.providers.len() >= 8 { let _ = reply.send(Err(Error::Capacity)); continue; }
                        self.providers.insert(id, PendingProvider { reply, deadline: Instant::now() + self.options.execution });
                        if let Err(error) = self.send(v5::host_frame::Body::Provider(v5::ProviderRequest { request: id, attempt })).await { break error; }
                    }
                    Some(Request::ProviderCancel(id)) => {
                        if self.providers.remove(&id).is_some()
                            && let Err(error) = self.send(v5::host_frame::Body::ProviderCancel(v5::ProviderCancel { request: id })).await { break error; }
                    }
                    Some(Request::HostReply { call, request, outcome }) => {
                        if self.host_calls.remove(&request).is_none() { continue; }
                        let reply = v5::HostReply { call, request, outcome: Some(outcome) };
                        if let Err(error) = self.send(v5::host_frame::Body::HostReply(reply)).await { break error; }
                    }
                    Some(Request::Cancel(id)) => if let Err(error) = self.cancel(id, Error::Cancelled).await { break error; },
                    Some(Request::Stop) | None => {
                        if stopping.is_none() {
                            self.shared.accepting.store(false, Ordering::Release);
                            stopping = Some(Instant::now() + self.options.cleanup);
                            for pending in std::mem::take(&mut self.auth).into_values() { let _ = pending.reply.send(Err(Error::Stopped)); }
                            for pending in std::mem::take(&mut self.providers).into_values() { let _ = pending.reply.send(Err(Error::Stopped)); }
                            for id in self.active.keys().copied().collect::<Vec<_>>() { if let Err(error) = self.cancel(id, Error::Cancelled).await { self.finish(error).await; return; } }
                            for id in self.transforms.keys().copied().collect::<Vec<_>>() { if let Err(error) = self.cancel(id, Error::Cancelled).await { self.finish(error).await; return; } }
                        }
                    }
                },
                frame = self.next(wire::FRAME_BYTES) => {
                    let frame = match frame { Ok(frame) => frame, Err(error) => break error };
                    if let Err(error) = self.receive(frame).await { break error; }
                }
                _ = tokio::time::sleep_until(deadline) => {
                    if stopping.is_some_and(|deadline| Instant::now() >= deadline) { break Error::Timeout; }
                    if self.event_credits.values().any(|deadline| Instant::now() >= *deadline) { break Error::Timeout; }
                    if self.auth.values().any(|pending| Instant::now() >= pending.deadline) { break Error::Timeout; }
                    if self.providers.values().any(|pending| Instant::now() >= pending.deadline) { break Error::Timeout; }
                    let expired = self.active.iter().filter(|(_, active)| Instant::now() >= active.deadline).map(|(id, _)| *id).collect::<Vec<_>>();
                    for id in expired {
                        if self.active[&id].cancellation.is_some() { self.finish(Error::Timeout).await; return; }
                        if let Err(error) = self.cancel(id, Error::Timeout).await { self.finish(error).await; return; }
                    }
                    for id in self.transforms.iter().filter(|(_, active)| Instant::now() >= active.deadline).map(|(id, _)| *id).collect::<Vec<_>>() {
                        if self.transforms[&id].cancellation.is_some() { self.finish(Error::Timeout).await; return; }
                        if let Err(error) = self.cancel(id, Error::Timeout).await { self.finish(error).await; return; }
                    }
                }
            }
        };
        self.finish(terminal).await;
        while let Ok(request) = receiver.try_recv() {
            match request {
                Request::Execute { reply, .. } => {
                    let _ = reply.send(Err(Error::Stopped));
                }
                Request::Transform { reply, .. } => {
                    let _ = reply.send(Err(Error::Stopped));
                }
                Request::Provider { reply, .. } => {
                    let _ = reply.send(Err(Error::Stopped));
                }
                _ => (),
            }
        }
    }
    async fn receive(&mut self, frame: v5::ChildFrame) -> Result<(), Error> {
        match frame.body.ok_or(Error::Protocol)? {
            v5::child_frame::Body::AuthReply(reply) => {
                let pending = self.auth.remove(&reply.request).ok_or(Error::Protocol)?;
                let outcome = reply.outcome.ok_or(Error::Protocol)?;
                if !pending.kind.accepts(&outcome) {
                    return Err(Error::Protocol);
                }
                let _ = pending.reply.send(Ok(outcome));
            }
            v5::child_frame::Body::ProviderResult(result) => {
                let Some(pending) = self.providers.remove(&result.request) else {
                    return Ok(());
                };
                let outcome = result.outcome.ok_or(Error::Protocol)?;
                match outcome {
                    v5::provider_result::Outcome::Frames(frames) => {
                        let frames = wire::read_value(frames).map_err(|_| Error::Protocol)?;
                        let JsonValue::Array(frames) = frames else {
                            return Err(Error::Protocol);
                        };
                        if wire::check_value(&JsonValue::Array(frames.clone())).is_err() {
                            let _ = pending.reply.send(Err(Error::ExecutionFailed));
                            return Ok(());
                        }
                        let _ = pending.reply.send(Ok(frames));
                    }
                    v5::provider_result::Outcome::Failure(failure) => {
                        let _ = pending.reply.send(Err(
                            match v5::FailureCode::try_from(failure.code)
                                .map_err(|_| Error::Protocol)?
                            {
                                v5::FailureCode::Rejected => Error::Rejected,
                                v5::FailureCode::ExecutionFailed => Error::ExecutionFailed,
                                v5::FailureCode::UnknownOutcome => Error::UnknownOutcome,
                            },
                        ));
                    }
                }
            }
            v5::child_frame::Body::HostCall(host) => self.host_call(host).await?,
            v5::child_frame::Body::Subscribe(subscription) => {
                super::families::subscribe(&self.shared, subscription)?
            }
            v5::child_frame::Body::Unsubscribe(unsubscribe) => {
                if self
                    .shared
                    .subscriptions
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .remove(&unsubscribe.subscription)
                    .is_none()
                {
                    return Err(Error::Protocol);
                }
            }
            v5::child_frame::Body::EventReceipt(receipt) => {
                if self.event_credits.remove(&receipt.delivery).is_none() {
                    return Err(Error::Protocol);
                }
                if !self
                    .shared
                    .pending_events
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .remove(&receipt.delivery)
                {
                    return Err(Error::Protocol);
                }
            }
            v5::child_frame::Body::Transformed(result) => {
                let active = self
                    .transforms
                    .get(&result.call.invocation)
                    .ok_or(Error::Protocol)?;
                if active.call != result.call
                    || active.stage != result.stage
                    || active.revision != result.revision
                    || active.cancellation.is_some()
                {
                    return Err(Error::Protocol);
                }
                let outcome = match result.outcome.ok_or(Error::Protocol)? {
                    v5::transformed::Outcome::Draft(draft) => Ok(wire::read_value(draft)?),
                    v5::transformed::Outcome::Failure(failure) => Err(
                        match v5::FailureCode::try_from(failure.code)
                            .map_err(|_| Error::Protocol)?
                        {
                            v5::FailureCode::Rejected => Error::Rejected,
                            v5::FailureCode::ExecutionFailed => Error::ExecutionFailed,
                            v5::FailureCode::UnknownOutcome => Error::UnknownOutcome,
                        },
                    ),
                };
                let active = self
                    .transforms
                    .remove(&result.call.invocation)
                    .ok_or(Error::Protocol)?;
                self.release_host_calls(result.call.invocation);
                let _ = active.reply.send(outcome);
            }
            v5::child_frame::Body::Diagnostic(diagnostic) => {
                if diagnostic.code != v5::DiagnosticCode::ChildWarning as i32 {
                    return Err(Error::Protocol);
                }
                diagnose(&self.shared, v5::DiagnosticCode::ChildWarning);
            }
            v5::child_frame::Body::Result(result) => {
                let active = self
                    .active
                    .get(&result.call.invocation)
                    .ok_or(Error::Protocol)?;
                if active.call != result.call || active.cancellation.is_some() {
                    return Err(Error::Protocol);
                }
                let outcome = match result.outcome.ok_or(Error::Protocol)? {
                    v5::result::Outcome::Output(output) => Ok(wire::read_output(output)?),
                    v5::result::Outcome::Failure(failure) => Err(match v5::FailureCode::try_from(
                        failure.code,
                    )
                    .map_err(|_| Error::Protocol)?
                    {
                        v5::FailureCode::Rejected => Error::Rejected,
                        v5::FailureCode::ExecutionFailed => Error::ExecutionFailed,
                        v5::FailureCode::UnknownOutcome => Error::UnknownOutcome,
                    }),
                };
                let active = self
                    .active
                    .remove(&result.call.invocation)
                    .ok_or(Error::Protocol)?;
                self.release_host_calls(result.call.invocation);
                let _ = active.reply.send(outcome);
            }
            v5::child_frame::Body::Progress(progress) => {
                let active = self
                    .active
                    .get_mut(&progress.call.invocation)
                    .ok_or(Error::Protocol)?;
                if active.call != progress.call
                    || active.cancellation.is_some()
                    || active.progress >= 128
                {
                    return Err(Error::Protocol);
                }
                active.progress += 1;
                let output = wire::read_output(progress.output)?;
                let JsonValue::Object(structured) = output.structured else {
                    return Err(Error::Protocol);
                };
                timeout(
                    self.options.write,
                    active.context.report(Progress {
                        structured,
                        content: output.content,
                    }),
                )
                .await
                .map_err(|_| Error::Timeout)?;
            }
            v5::child_frame::Body::Cleanup(cleanup) => {
                if let Some(active) = self.transforms.get(&cleanup.call.invocation) {
                    if active.call != cleanup.call {
                        return Err(Error::Protocol);
                    }
                    let reason = active.cancellation.ok_or(Error::Protocol)?;
                    let active = self
                        .transforms
                        .remove(&cleanup.call.invocation)
                        .ok_or(Error::Protocol)?;
                    let _ = active.reply.send(Err(reason));
                    return Ok(());
                }
                let active = self
                    .active
                    .get(&cleanup.call.invocation)
                    .ok_or(Error::Protocol)?;
                if active.call != cleanup.call {
                    return Err(Error::Protocol);
                }
                let reason = active.cancellation.ok_or(Error::Protocol)?;
                let active = self
                    .active
                    .remove(&cleanup.call.invocation)
                    .ok_or(Error::Protocol)?;
                let _ = active.reply.send(Err(reason));
            }
            _ => return Err(Error::Protocol),
        }
        Ok(())
    }
    async fn finish(&mut self, error: Error) {
        self.shared.accepting.store(false, Ordering::Release);
        diagnose(
            &self.shared,
            match error {
                Error::Protocol | Error::Negotiation | Error::Unauthorized | Error::Schema => {
                    v5::DiagnosticCode::ProtocolRejected
                }
                Error::Timeout => v5::DiagnosticCode::DeadlineExceeded,
                Error::Stopped => v5::DiagnosticCode::Stopped,
                _ => v5::DiagnosticCode::ProcessExited,
            },
        );
        self.registration.take();
        self.auth_registration.take();
        self.hooks.clear();
        self.shared
            .subscriptions
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        for pending in std::mem::take(&mut self.auth).into_values() {
            let _ = pending.reply.send(Err(Error::UnknownOutcome));
        }
        for pending in std::mem::take(&mut self.providers).into_values() {
            let _ = pending.reply.send(Err(Error::UnknownOutcome));
        }
        super::provider::unregister_generation(&self.generation);
        self.event_credits.clear();
        for call in std::mem::take(&mut self.host_calls).into_values() {
            call.signal.send_replace(true);
            call.task.abort();
        }
        self.shared
            .pending_events
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        self.output.close();
        if error == Error::Stopped {
            if !matches!(
                self.process
                    .shutdown_gracefully(self.options.shutdown)
                    .await,
                Ok(Some(_))
            ) {
                self.process.control().terminate_now();
            }
        } else {
            self.process.control().terminate_now();
        }
        let reaped = self.process.wait().await.is_ok();
        for (_, active) in std::mem::take(&mut self.active) {
            let _ = active.reply.send(Err(if reaped {
                active.cancellation.unwrap_or(Error::UnknownOutcome)
            } else {
                Error::UnknownOutcome
            }));
        }
        for (_, active) in std::mem::take(&mut self.transforms) {
            let _ = active.reply.send(Err(if reaped {
                active.cancellation.unwrap_or(Error::UnknownOutcome)
            } else {
                Error::UnknownOutcome
            }));
        }
        self.shared.closed.send_replace(true);
    }
}
