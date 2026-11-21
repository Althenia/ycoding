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
use ycoding_schema::{JsonValue, LosslessString, ObjectEncoder, session_error};

pub(super) struct ParentPreparation {
    pub entry: v5::ParentEntry,
    pub directory: PathBuf,
    pub order: u32,
    pub options: Options,
    pub registry: Arc<Registry>,
    pub policy: Arc<LeafPolicy>,
    pub launch: Launch,
    pub host: Host,
}

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
    pub services: Option<Arc<dyn Fn() -> Result<SessionServices, Error> + Send + Sync>>,
}
#[derive(Clone)]
pub struct SessionServices {
    pub runner: crate::session::runner::Local,
    pub generate: Arc<crate::session::generate::Service>,
    pub commands: crate::resources::domain_state::DomainState<crate::resources::command::Service>,
    pub configuration: Arc<crate::resources::config::Configuration>,
    pub reads: Option<Reads>,
}
#[derive(Clone)]
pub struct Reads {
    pub location: ycoding_schema::location::Info,
    pub references:
        crate::resources::domain_state::DomainState<crate::resources::reference::Service>,
    pub skills: Arc<tokio::sync::Mutex<crate::resources::skill::Service>>,
    pub credentials: crate::resources::credential::Service,
    pub activation: Arc<super::activation::Activation>,
    pub reload: super::reload::Reloader,
    pub agents_at: AgentsAt,
}
pub type AgentsAt = Arc<
    dyn Fn(
            &ycoding_schema::location::Ref,
        ) -> Result<(ycoding_schema::location::Info, Vec<JsonValue>), Error>
        + Send
        + Sync,
>;
impl SessionServices {
    pub fn reads(
        location: ycoding_schema::location::Info,
        references: crate::resources::domain_state::DomainState<
            crate::resources::reference::Service,
        >,
        skills: Arc<tokio::sync::Mutex<crate::resources::skill::Service>>,
        credentials: crate::resources::credential::Service,
        activation: Arc<super::activation::Activation>,
        reload: super::reload::Reloader,
        agents_at: AgentsAt,
    ) -> Reads {
        Reads {
            location,
            references,
            skills,
            credentials,
            activation,
            reload,
            agents_at,
        }
    }
}
// Configured extensions launch while a Location starts, before any Session exists. Explicit
// configured rules matching a launch or family grant still apply: deny and ask fail closed
// because no Session can answer an ask; when no rule matches, configuration trust admits it.
#[derive(Clone, Default)]
pub struct Launch {
    pub rules: Vec<ycoding_schema::permission::Rule>,
    pub cancellation: crate::tools::code_mode::Cancellation,
}
impl Launch {
    fn admit(&self, action: &str, resources: &[String]) -> Result<(), Error> {
        let action = action.into();
        for resource in resources {
            let resource = resource.as_str().into();
            let effect = self
                .rules
                .iter()
                .rev()
                .find(|rule| {
                    crate::tools::policy::wildcard(&action, &rule.action)
                        && crate::tools::policy::wildcard(&resource, &rule.resource)
                })
                .map(|rule| rule.effect.0.clone());
            match effect.as_ref().and_then(|effect| effect.as_str()) {
                Some("deny") => return Err(Error::Permission),
                Some("ask") => return Err(Error::ApprovalUnavailable),
                _ => {}
            }
        }
        Ok(())
    }
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
        for key in ["plugin", "npm", "provider"] {
            if configuration.latest(key).is_some() {
                return Err(Error::ObsoleteConfiguration);
            }
        }
        if configuration.values("providers").any(obsolete_provider) {
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
        if hello(self, None, &"g".repeat(128)).encoded_len() + 140 > wire::STARTUP_BYTES {
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
// A configured plugin is trusted by configuration: the native factory assigns that trust, and the
// child only learns it from the host Hello, so a child process can never raise its own authority.
#[derive(Clone, PartialEq)]
pub struct Plugin {
    pub(super) configuration: Configuration,
    pub(super) target: String,
    pub(super) options: JsonValue,
    pub(super) cache: PathBuf,
    pub(super) setup: Duration,
    pub(super) model_package: bool,
    pub(super) selection: crate::resources::config::capabilities::Selection,
}
impl std::fmt::Debug for Plugin {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Plugin")
            .field("identity", &self.configuration.identity)
            .field("target", &self.target)
            .finish_non_exhaustive()
    }
}
impl Plugin {
    pub fn identity(&self) -> &str {
        &self.configuration.identity
    }
    pub fn target(&self) -> &str {
        &self.target
    }
    pub fn options(&self) -> &JsonValue {
        &self.options
    }
    pub fn configuration(&self) -> &Configuration {
        &self.configuration
    }
    fn validate(&self) -> Result<(), Error> {
        let configuration = &self.configuration;
        if !identifier(&configuration.identity)
            || !configuration.executable.is_absolute()
            || !configuration.executable.is_file()
            || !configuration.directory.is_absolute()
            || !configuration.directory.is_dir()
            || configuration.args.len() > 64
            || configuration
                .args
                .iter()
                .any(|arg| arg.contains('\0') || arg.len() > 4096)
            || !configuration.grants.is_empty()
            || !configuration.families.is_empty()
            || self.target.is_empty()
            || self.target.len() > 4096
            || self.target.contains('\0')
            || !self.cache.is_absolute()
            || !matches!(self.options, JsonValue::Object(_))
            || self.setup.is_zero()
            || self.setup > Duration::from_secs(300)
        {
            return Err(Error::InvalidConfiguration);
        }
        wire::check_value(&self.options).map_err(|_| Error::InvalidConfiguration)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if std::fs::metadata(&configuration.executable)
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
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginRuntime {
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub cache: PathBuf,
    pub setup: Duration,
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
    obsolete_provider_value(value, &ycoding_schema::JsonPath::default().key("providers"))
}
fn obsolete_provider_value(value: &JsonValue, path: &ycoding_schema::JsonPath) -> bool {
    match value {
        JsonValue::Object(object) => object.iter().any(|(key, value)| {
            (key.as_str()
                .is_some_and(|key| ["npm", "package", "plugin"].contains(&key))
                && !(key.as_str() == Some("package")
                    && crate::resources::config::native_package_declaration(
                        value,
                        &path.key(key.clone()),
                    )))
                || obsolete_provider_value(value, &path.key(key.clone()))
        }),
        JsonValue::Array(items) => items
            .iter()
            .enumerate()
            .any(|(index, value)| obsolete_provider_value(value, &path.index(index))),
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
fn hello(configuration: &Configuration, plugin: Option<&Plugin>, generation: &str) -> v5::Hello {
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
        plugin: plugin.map(|plugin| v5::PluginLaunch {
            target: wire::text(&plugin.target.as_str().into()),
            options: wire::value(&plugin.options),
            cache: wire::text(&plugin.cache.to_string_lossy().as_ref().into()),
            model_package: plugin.model_package.then_some(true),
        }),
        parent_plugin: None,
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
    pub(super) accepting: AtomicBool,
    next: AtomicU64,
    diagnostics: Mutex<VecDeque<v5::DiagnosticCode>>,
    control: Option<process::Control>,
    pid: u32,
    closed: tokio::sync::watch::Sender<bool>,
    task: tokio::sync::Mutex<Option<JoinHandle<()>>>,
    pub(super) families: Vec<FamilyGrant>,
    pub(super) host: Host,
    pub(super) policy: Arc<LeafPolicy>,
    pub(super) subscriptions: Mutex<BTreeMap<u64, Vec<String>>>,
    pending_events: Mutex<BTreeSet<u64>>,
    pub(super) trusted: bool,
    pub(super) parent: bool,
    parent_handle: Option<super::ParentHandle>,
    parent_services: Mutex<Option<SessionServices>>,
    extra_declarations: Mutex<Vec<v5::TransformRegistration>>,
    extra_domains: Mutex<Vec<v5::DomainRegistration>>,
    setup: watch::Sender<Option<Result<(), Error>>>,
    setup_started: AtomicBool,
    integration_transforms: Mutex<
        Vec<(
            v5::TransformRegistration,
            Arc<crate::resources::auth::integration::Registration>,
        )>,
    >,
}
pub(super) struct Failed {
    pub(super) error: Error,
    pub(super) message: Option<ycoding_schema::LosslessString>,
}
type LanguageParts = mpsc::Receiver<Result<JsonValue, ycoding_ai::Error>>;
const LANGUAGE_PARTS: usize = 64;
impl From<Error> for Failed {
    fn from(error: Error) -> Self {
        Self {
            error,
            message: None,
        }
    }
}
pub struct Extension {
    pub(super) shared: Arc<Shared>,
    pub generation: String,
    pub(super) identity: String,
    pub(super) order: u32,
    pub(super) declarations: Vec<v5::TransformRegistration>,
    pub(super) domains: Vec<v5::DomainRegistration>,
    declared: Option<LosslessString>,
}
pub(super) struct Declaration {
    pub(super) id: ycoding_schema::LosslessString,
    pub(super) plugin: Plugin,
    owner: Owner,
    receiver: mpsc::Receiver<Request>,
    policy: Arc<LeafPolicy>,
    elapsed: Duration,
}
impl Declaration {
    pub(super) async fn prepare(
        mut self,
        registry: Arc<Registry>,
        order: u32,
    ) -> Result<Arc<Extension>, Error> {
        self.owner.configuration.registration_order = order;
        self.owner.registry = Some(registry);
        self.owner.options.startup = self.plugin.setup.saturating_sub(self.elapsed);
        Extension::reserve(self.owner, self.receiver).await
    }
    pub(super) async fn setup(
        mut self,
        order: u32,
        registry: &Registry,
        launch: &Launch,
    ) -> Result<Extension, Error> {
        self.plugin.configuration.registration_order = order;
        let deadline = Instant::now() + self.plugin.setup.saturating_sub(self.elapsed);
        if let Err(error) = self
            .owner
            .send(v5::host_frame::Body::Setup(v5::PluginSetup {}))
            .await
        {
            self.owner.finish(error).await;
            return Err(error);
        }
        Extension::complete(
            self.owner,
            self.receiver,
            &self.plugin.configuration,
            registry,
            self.policy,
            launch,
            deadline,
        )
        .await
    }
    pub(super) async fn discard(mut self) {
        let stopped = self.owner.stop().await;
        self.owner.finish(stopped).await;
    }
}
impl Shared {
    pub(super) fn setup_pending(&self) -> bool {
        self.setup.borrow().is_none()
    }
    pub(super) fn release(&self, implementation: u64) {
        if self.accepting.load(Ordering::Acquire)
            && self
                .sender
                .try_send(Request::Release(implementation))
                .is_err()
            && let Some(parent) = &self.parent_handle
        {
            parent.failure("Parent implementation release could not be queued");
        }
    }
    pub(super) fn services(&self) -> Result<SessionServices, Error> {
        if let Some(services) = self
            .parent_services
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
        {
            return Ok(services);
        }
        if self.parent {
            return Err(Error::Stopped);
        }
        self.host
            .sessions
            .as_ref()
            .and_then(|host| host.services.as_ref())
            .ok_or(Error::Stopped)?()
    }
    pub(super) async fn services_at(
        &self,
        location: &ycoding_schema::location::Ref,
    ) -> Result<SessionServices, Error> {
        let current = self.services()?;
        if current.runner.location() == location {
            return Ok(current);
        }
        let parent = self.parent_handle.as_ref().ok_or(Error::Unauthorized)?;
        if let Some(services) = parent.services(location) {
            return Ok(services);
        }
        let read = current
            .reads
            .as_ref()
            .ok_or(Error::Stopped)?
            .agents_at
            .clone();
        let requested = location.clone();
        tokio::task::spawn_blocking(move || read(&requested))
            .await
            .map_err(|_| Error::Stopped)??;
        parent.services(location).ok_or(Error::Stopped)
    }
    fn terminate(&self) {
        if let Some(control) = &self.control {
            control.terminate_now();
        }
    }
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
    pub(super) async fn resolve_language(
        self: &Arc<Self>,
        resolve: v5::LanguageResolve,
    ) -> Result<bool, Failed> {
        if !self.trusted {
            return Err(Error::Unauthorized.into());
        }
        if !self.accepting.load(Ordering::Acquire) {
            return Err(Error::Stopped.into());
        }
        let request = self.next.fetch_add(1, Ordering::Relaxed);
        let (reply, receive) = oneshot::channel();
        self.sender
            .send(Request::Resolve {
                resolve: v5::LanguageResolve { request, ..resolve },
                reply,
            })
            .await
            .map_err(|_| Failed::from(Error::Stopped))?;
        receive
            .await
            .map_err(|_| Failed::from(Error::UnknownOutcome))?
    }
    pub(super) async fn language(
        self: &Arc<Self>,
        attempt: v5::LanguageAttempt,
    ) -> Result<LanguageParts, Failed> {
        if !self.trusted {
            return Err(Error::Unauthorized.into());
        }
        if !self.accepting.load(Ordering::Acquire) {
            return Err(Error::Stopped.into());
        }
        let request = self.next.fetch_add(1, Ordering::Relaxed);
        let (parts, receive) = mpsc::channel(LANGUAGE_PARTS + 1);
        let terminal = parts
            .clone()
            .reserve_owned()
            .await
            .map_err(|_| Failed::from(Error::Stopped))?;
        let (ready, started) = oneshot::channel();
        self.sender
            .send(Request::Language {
                attempt: v5::LanguageAttempt { request, ..attempt },
                ready,
                parts,
                terminal,
            })
            .await
            .map_err(|_| Failed::from(Error::Stopped))?;
        started
            .await
            .map_err(|_| Failed::from(Error::UnknownOutcome))??;
        Ok(receive)
    }
    pub(super) fn provider_cancel(&self, request: u64) {
        let _ = self.sender.try_send(Request::ProviderCancel(request));
    }
    pub(super) async fn transform(
        self: &Arc<Self>,
        registration: &v5::TransformRegistration,
        context: Option<&Context>,
        revision: u64,
        draft: JsonValue,
    ) -> Result<JsonValue, Error> {
        self.transform_result(registration, context, revision, draft)
            .await
            .map(|value| value.draft)
    }
    pub(super) async fn transform_result(
        self: &Arc<Self>,
        registration: &v5::TransformRegistration,
        context: Option<&Context>,
        revision: u64,
        draft: JsonValue,
    ) -> Result<Transformed, Error> {
        if !self.accepting.load(Ordering::Acquire) {
            return Err(Error::Stopped);
        }
        let stage =
            v5::TransformStage::try_from(registration.stage).map_err(|_| Error::Protocol)?;
        let family = super::families::stage_family(stage);
        let grant = super::families::grant(self, family, super::families::scope(stage))?;
        let _reservation = if self.trusted {
            None
        } else {
            let context = context.ok_or(Error::Permission)?;
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
            Some(
                self.policy
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
                    .map_err(|_| Error::Permission)?,
            )
        };
        wire::check_value(&draft)?;
        let invocation = self.next.fetch_add(1, Ordering::Relaxed);
        let call = match context {
            Some(context) => v5::Call {
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
            },
            None => v5::Call {
                invocation,
                session_id: String::new(),
                message_id: String::new(),
                call_id: wire::text(&"".into()),
                agent: String::new(),
            },
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
                context: context.cloned(),
                reply,
            })
            .await
            .map_err(|_| Error::Stopped)?;
        let mut guard = Invocation {
            shared: self.clone(),
            invocation,
            armed: true,
        };
        let cancelled = async {
            match context {
                Some(context) => context.cancellation.cancelled().await,
                None => std::future::pending().await,
            }
        };
        let result = tokio::select! { result = &mut receive => result, _ = cancelled => { let _ = self.sender.send(Request::Cancel(invocation)).await; receive.await } }.map_err(|_| Error::UnknownOutcome)?;
        guard.armed = false;
        let result = result?;
        if !self.accepting.load(Ordering::Acquire) {
            return Err(Error::Stopped);
        }
        Ok(result)
    }
}
impl Extension {
    async fn reserve(owner: Owner, receiver: mpsc::Receiver<Request>) -> Result<Arc<Self>, Error> {
        let shared = owner.shared.clone();
        let extension = Arc::new(Self {
            shared: shared.clone(),
            generation: owner.generation.clone(),
            identity: owner.configuration.identity.clone(),
            order: owner.configuration.registration_order,
            declarations: vec![],
            domains: vec![],
            declared: owner.declared.clone(),
        });
        shared.accepting.store(true, Ordering::Release);
        *shared.task.lock().await = Some(tokio::spawn(async move {
            let mut owner = owner;
            owner.run(receiver).await;
        }));
        Ok(extension)
    }
    pub(super) async fn prepare_process(
        configuration: Configuration,
        options: Options,
        registry: Arc<Registry>,
        policy: Arc<LeafPolicy>,
        launch: &Launch,
        host: Host,
    ) -> Result<Arc<Self>, Error> {
        configuration.validate()?;
        let (mut owner, receiver, started) =
            Self::open(&configuration, None, options, policy, launch, host).await?;
        owner.registry = Some(registry);
        owner.setup_deadline = Some(started + owner.options.startup);
        Self::reserve(owner, receiver).await
    }
    pub(super) async fn prepare_parent(
        parent: super::ParentHandle,
        preparation: ParentPreparation,
    ) -> Result<Arc<Self>, Error> {
        let ParentPreparation {
            entry,
            directory,
            order,
            options,
            registry,
            policy,
            launch,
            host,
        } = preparation;
        if launch.cancellation.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let generation = crate::platform::identifier("ext_").map_err(|_| Error::Spawn)?;
        let channel = parent.channel(&entry, generation.clone()).await?;
        let (sender, receiver) = mpsc::channel(32);
        let shared = Arc::new(Shared {
            sender,
            accepting: AtomicBool::new(false),
            next: AtomicU64::new(1),
            diagnostics: Default::default(),
            control: None,
            pid: std::process::id(),
            closed: watch::channel(false).0,
            task: Default::default(),
            families: vec![],
            host,
            policy,
            subscriptions: Default::default(),
            pending_events: Default::default(),
            trusted: true,
            parent: true,
            parent_handle: Some(parent),
            parent_services: Default::default(),
            extra_declarations: Default::default(),
            extra_domains: Default::default(),
            setup: watch::channel(None).0,
            setup_started: AtomicBool::new(false),
            integration_transforms: Default::default(),
        });
        let configuration = Configuration {
            identity: entry.id.clone(),
            executable: PathBuf::new(),
            args: vec![],
            directory,
            grants: vec![],
            families: vec![],
            registration_order: order,
        };
        let mut owner = Owner {
            process: None,
            parent: Some(channel),
            output: mpsc::channel(1).1,
            decoder: Default::default(),
            frames: Default::default(),
            shared: shared.clone(),
            generation: generation.clone(),
            options,
            setup_deadline: None,
            registration: None,
            active: Default::default(),
            seen: Default::default(),
            transforms: Default::default(),
            hooks: vec![],
            event_credits: Default::default(),
            host_calls: Default::default(),
            host_requests: Default::default(),
            auth: Default::default(),
            providers: Default::default(),
            auth_registration: None,
            plugin_calls: Default::default(),
            last_plugin_request: 0,
            last_host_request: 0,
            seen_order: Default::default(),
            resolves: Default::default(),
            languages: Default::default(),
            declared: None,
            registry: Some(registry),
            configuration: configuration.clone(),
            extra_tools: Default::default(),
            extra_auth: vec![],
        };
        let hello = v5::Hello {
            revision: wire::REVISION,
            identity: entry.id.clone(),
            generation: generation.clone(),
            grants: vec![],
            registration_order: order,
            plugin: Some(v5::PluginLaunch {
                target: wire::text(&entry.id.as_str().into()),
                options: wire::value(&JsonValue::Object(Default::default())),
                cache: wire::text(&"".into()),
                model_package: None,
            }),
            parent_plugin: Some(true),
        };
        let opened = async {
            owner.send(v5::host_frame::Body::Hello(hello)).await?;
            let frame = owner.next(wire::STARTUP_BYTES).await?;
            let Some(v5::child_frame::Body::Ready(ready)) = frame.body else {
                return Err(Error::Negotiation);
            };
            if ready.revision != wire::REVISION
                || ready.identity != entry.id
                || ready.generation != generation
            {
                return Err(Error::Negotiation);
            }
            if owner
                .declared(Instant::now() + owner.options.startup)
                .await?
                != LosslessString::from(entry.id.clone())
            {
                return Err(Error::Negotiation);
            }
            Ok(())
        }
        .await;
        if let Err(error) = opened {
            owner.finish(error).await;
            return Err(error);
        }
        shared.accepting.store(true, Ordering::Release);
        let extension = Arc::new(Self {
            shared: shared.clone(),
            generation,
            identity: entry.id.clone(),
            order,
            declarations: vec![],
            domains: vec![],
            declared: Some(entry.id.into()),
        });
        *shared.task.lock().await = Some(tokio::spawn(async move {
            owner.run(receiver).await;
        }));
        Ok(extension)
    }
    pub async fn start(
        configuration: Configuration,
        options: Options,
        registry: &Registry,
        policy: Arc<LeafPolicy>,
        launch: &Launch,
        host: Host,
    ) -> Result<Self, Error> {
        configuration.validate()?;
        let (owner, receiver, started) =
            Self::open(&configuration, None, options, policy.clone(), launch, host).await?;
        let deadline = started + owner.options.startup;
        Self::complete(
            owner,
            receiver,
            &configuration,
            registry,
            policy,
            launch,
            deadline,
        )
        .await
    }
    pub async fn start_plugin(
        plugin: Plugin,
        options: Options,
        registry: &Registry,
        policy: Arc<LeafPolicy>,
        launch: &Launch,
        host: Host,
    ) -> Result<Option<Self>, Error> {
        let declaration = Self::declare(plugin, options, policy, launch, host).await?;
        if !declaration.plugin.selection.allows(&declaration.id) {
            declaration.discard().await;
            return Ok(None);
        }
        let order = declaration.plugin.configuration.registration_order;
        declaration.setup(order, registry, launch).await.map(Some)
    }
    pub(super) async fn declare(
        plugin: Plugin,
        options: Options,
        policy: Arc<LeafPolicy>,
        launch: &Launch,
        host: Host,
    ) -> Result<Declaration, Error> {
        plugin.validate()?;
        let (mut owner, receiver, started) = Self::open(
            &plugin.configuration,
            Some(&plugin),
            options,
            policy.clone(),
            launch,
            host,
        )
        .await?;
        let declared = tokio::select! {
            declared = owner.declared(started + plugin.setup) => declared,
            () = launch.cancellation.cancelled() => Err(Error::Cancelled),
        };
        match declared {
            Ok(id) => Ok(Declaration {
                id,
                plugin,
                owner,
                receiver,
                policy,
                elapsed: started.elapsed(),
            }),
            Err(error) => {
                owner.finish(error).await;
                Err(error)
            }
        }
    }
    async fn open(
        configuration: &Configuration,
        plugin: Option<&Plugin>,
        options: Options,
        policy: Arc<LeafPolicy>,
        launch: &Launch,
        host: Host,
    ) -> Result<(Owner, mpsc::Receiver<Request>, Instant), Error> {
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
        launch.admit(
            "extension.launch",
            &std::iter::once(executable.to_owned())
                .chain(plugin.map(|plugin| plugin.target.clone()))
                .collect::<Vec<_>>(),
        )?;
        for grant in &configuration.families {
            launch.admit(&grant.action, &grant.resources)?;
        }
        if launch.cancellation.is_cancelled() {
            return Err(Error::Cancelled);
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
            control: Some(process.control()),
            pid: process.control().pid(),
            closed: tokio::sync::watch::channel(false).0,
            task: tokio::sync::Mutex::new(None),
            families: configuration.families.clone(),
            host,
            policy,
            subscriptions: Mutex::new(BTreeMap::new()),
            pending_events: Mutex::new(BTreeSet::new()),
            trusted: plugin.is_some(),
            parent: false,
            parent_handle: None,
            parent_services: Default::default(),
            extra_declarations: Default::default(),
            extra_domains: Default::default(),
            setup: watch::channel(None).0,
            setup_started: AtomicBool::new(false),
            integration_transforms: Default::default(),
        });
        let mut owner = Owner {
            process: Some(process),
            parent: None,
            output,
            decoder: wire::Decoder::default(),
            frames: VecDeque::new(),
            shared,
            generation,
            options,
            setup_deadline: None,
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
            plugin_calls: BTreeMap::new(),
            last_plugin_request: 0,
            last_host_request: 0,
            seen_order: VecDeque::new(),
            resolves: BTreeMap::new(),
            languages: BTreeMap::new(),
            declared: None,
            registry: None,
            configuration: configuration.clone(),
            extra_tools: BTreeMap::new(),
            extra_auth: Vec::new(),
        };
        let negotiated = tokio::select! {
            negotiated = owner.hello(configuration, plugin) => negotiated,
            () = launch.cancellation.cancelled() => Err(Error::Cancelled),
        };
        match negotiated {
            Ok(started) => Ok((owner, receiver, started)),
            Err(error) => {
                owner.finish(error).await;
                Err(error)
            }
        }
    }
    async fn complete(
        mut owner: Owner,
        mut receiver: mpsc::Receiver<Request>,
        configuration: &Configuration,
        registry: &Registry,
        policy: Arc<LeafPolicy>,
        launch: &Launch,
        deadline: Instant,
    ) -> Result<Self, Error> {
        let registered = tokio::select! {
            registered = owner.tools(&mut receiver, deadline) => registered,
            () = launch.cancellation.cancelled() => Err(Error::Cancelled),
        };
        let declarations = match registered {
            Ok(tools) => tools,
            Err(error) => {
                owner.finish(error).await;
                return Err(error);
            }
        };
        let shared = owner.shared.clone();
        let generation = owner.generation.clone();
        let mut batches = Vec::new();
        let mut names = BTreeSet::new();
        if let Err(error) = super::families::validate_batch(&shared, &declarations) {
            owner.finish(error).await;
            return Err(error);
        }
        for declaration in declarations.tools {
            let prepared = prepare_tool(declaration, configuration, &shared, &policy, &mut names);
            match prepared {
                Ok(registration) => batches.push(registration),
                Err(error) => {
                    owner.finish(error).await;
                    return Err(error);
                }
            }
        }
        let registered = if shared.trusted {
            registry.register_batch(
                batches
                    .into_iter()
                    .map(|registration| {
                        (
                            vec![(registration.name, registration.tool)],
                            registry::Options {
                                namespace: Some(registration.namespace)
                                    .filter(|namespace| !namespace.is_empty()),
                                codemode: !registration.direct,
                            },
                        )
                    })
                    .collect(),
            )
        } else {
            registry.register_process_batch(batches)
        };
        match registered {
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
        let declared = owner.declared.clone();
        let task = tokio::spawn(async move {
            owner.run(receiver).await;
        });
        *shared.task.lock().await = Some(task);
        super::provider::register_generation(&shared, &generation);
        Ok(Self {
            shared,
            generation,
            identity: configuration.identity.clone(),
            order: configuration.registration_order,
            declarations: declarations.transforms,
            domains: declarations.domains,
            declared,
        })
    }
    pub fn pid(&self) -> u32 {
        self.shared.pid
    }
    pub fn declared_id(&self) -> Option<&LosslessString> {
        self.declared.as_ref()
    }
    pub fn trusted(&self) -> bool {
        self.shared.trusted
    }
    pub(super) fn declarations(&self) -> Vec<v5::TransformRegistration> {
        self.declarations
            .iter()
            .cloned()
            .chain(
                self.shared
                    .extra_declarations
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .iter()
                    .cloned(),
            )
            .collect()
    }
    pub(super) fn parent_services(&self, services: SessionServices) -> Result<(), Error> {
        *self
            .shared
            .parent_services
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(services);
        Ok(())
    }
    pub(super) fn retire(&self) {
        self.shared.accepting.store(false, Ordering::Release);
        let _ = self.shared.sender.try_send(Request::Stop);
    }
    pub(super) fn domains(&self) -> Vec<v5::DomainRegistration> {
        self.domains
            .iter()
            .cloned()
            .chain(
                self.shared
                    .extra_domains
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .iter()
                    .cloned(),
            )
            .collect()
    }
    pub(super) async fn setup_plugin(&self) -> Result<(), Error> {
        if self.shared.trusted && !self.shared.setup_started.swap(true, Ordering::AcqRel) {
            self.shared
                .sender
                .send(Request::Setup)
                .await
                .map_err(|_| Error::Stopped)?;
        }
        let mut setup = self.shared.setup.subscribe();
        loop {
            if let Some(result) = *setup.borrow_and_update() {
                return result;
            }
            setup.changed().await.map_err(|_| Error::Stopped)?;
        }
    }
    pub(super) async fn reload_integrations(&self) -> Result<(), Error> {
        if !self.shared.parent {
            return Ok(());
        }
        let transforms = self
            .shared
            .integration_transforms
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        let registry = self
            .shared
            .host
            .integrations
            .as_ref()
            .ok_or(Error::Stopped)?;
        for (registration, native) in transforms {
            let before = registry.before(&native).map_err(|_| Error::Stopped)?;
            let items = before
                .references()
                .into_iter()
                .map(|reference| {
                    ObjectEncoder::new()
                        .field("id", &reference.id)
                        .field("name", &reference.name)
                        .field(
                            "methods",
                            &before.methods(reference.id.as_lossless()).to_vec(),
                        )
                        .finish()
                })
                .collect::<Vec<_>>();
            let result = self
                .shared
                .transform_result(
                    &registration,
                    None,
                    0,
                    ObjectEncoder::new().field("items", &items).finish(),
                )
                .await?;
            super::families::replace_integration_draft(
                &self.shared,
                registry,
                &native,
                &result.draft,
                &result.oauth,
            )?;
        }
        Ok(())
    }
    pub(super) fn shared(&self) -> &Arc<Shared> {
        &self.shared
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
    pub fn publish_feed(
        &self,
        item: &crate::event_feed::Item,
        location: &ycoding_schema::location::Ref,
    ) -> Result<usize, Error> {
        use crate::event_feed::Payload;
        let (family, envelope) = match &item.payload {
            Payload::Ephemeral(event) => {
                if event
                    .location
                    .as_ref()
                    .is_some_and(|candidate| candidate != location)
                {
                    return Ok(0);
                }
                let metadata = event
                    .metadata
                    .as_ref()
                    .map(|metadata| JsonValue::Object(metadata.clone()));
                (
                    event.data.name().to_owned(),
                    ObjectEncoder::new()
                        .field("id", &event.id)
                        .field("created", &(event.created as f64))
                        .optional("metadata", &metadata)
                        .field("type", &LosslessString::from(event.data.name()))
                        .optional("location", &event.location)
                        .field("data", &event.data)
                        .finish(),
                )
            }
            Payload::Durable(event) => {
                let Some((family, version)) = event
                    .type_
                    .as_str()
                    .and_then(|value| value.rsplit_once('.'))
                    .and_then(|(family, version)| {
                        version.parse::<i64>().ok().map(|version| (family, version))
                    })
                else {
                    return Ok(0);
                };
                (
                    family.to_owned(),
                    ObjectEncoder::new()
                        .field("id", &event.id)
                        .field("created", &(event.created as f64))
                        .field("type", &LosslessString::from(family))
                        .field(
                            "durable",
                            &ObjectEncoder::new()
                                .field("aggregateID", &event.aggregate_id)
                                .field("seq", &(event.seq as f64))
                                .field("version", &(version as f64))
                                .finish(),
                        )
                        .field("data", &event.data)
                        .finish(),
                )
            }
        };
        self.publish_value(&family, envelope)
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
            .filter(|(_, families)| super::families::event_matches(families, family))
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
        let mut task = self.shared.task.lock().await;
        if let Some(task) = task.as_mut()
            && let Err(error) = task.await
            && let Some(parent) = &self.shared.parent_handle
        {
            parent.failure(&format!("Parent controller task failed: {error}"));
        }
        task.take();
    }
    pub async fn replace(
        &self,
        configuration: Configuration,
        options: Options,
        registry: &Registry,
        policy: Arc<LeafPolicy>,
        launch: &Launch,
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
            self.shared.terminate();
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
    code_path: Option<LosslessString>,
    implementation: Option<u64>,
    shared: Arc<Shared>,
    namespace: String,
    name: String,
    description: ycoding_schema::LosslessString,
    input: JsonValue,
    output: JsonValue,
    grant: ToolGrant,
    policy: Arc<LeafPolicy>,
}
impl Drop for ProcessTool {
    fn drop(&mut self) {
        if let Some(implementation) = self.implementation {
            self.shared.release(implementation);
        }
    }
}
impl Tool for ProcessTool {
    fn code_path(&self) -> Option<&LosslessString> {
        self.code_path.as_ref()
    }
    fn definition(&self, name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.into(),
            description: self.description.clone(),
            input_schema: self.input.clone(),
            output_schema: (!self.shared.trusted || self.output != JsonValue::Null)
                .then(|| self.output.clone()),
            cache: None,
            metadata: None,
            native: None,
        }
    }
    fn permission(&self) -> Option<&str> {
        Some(&self.grant.action)
    }
    fn validate_output(&self, output: &ToolOutput) -> Result<(), Failure> {
        if self.shared.trusted {
            return Ok(());
        }
        schema::validate(&self.output, &output.structured).map_err(failure)
    }
    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            if !self.shared.accepting.load(Ordering::Acquire) {
                return Err(failure(Error::Stopped));
            }
            wire::check_value(&input).map_err(failure)?;
            if !self.shared.trusted {
                schema::validate(&self.input, &input).map_err(failure)?;
            }
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
                    implementation: self.implementation,
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
            let output = result.map_err(|failed| match failed.message {
                Some(message) => Failure::Tool {
                    message: String::from_utf16_lossy(&message.code_units().collect::<Vec<_>>()),
                    error: Some(session_error::Error {
                        r#type: "extension.failure".into(),
                        message,
                    }),
                },
                None => failure(failed.error),
            })?;
            if !self.shared.trusted {
                schema::validate(&self.output, &output.structured).map_err(failure)?;
            }
            Ok(output)
        })
    }
}
fn failure_message(
    trusted: bool,
    message: Option<v5::Text>,
) -> Result<Option<ycoding_schema::LosslessString>, Error> {
    let Some(message) = message.filter(|_| trusted) else {
        return Ok(None);
    };
    let message = wire::read_text(message)?;
    if message.code_units().count() > 16_384 {
        return Err(Error::Protocol);
    }
    Ok(Some(message))
}
fn plugin_operation(operation: v5::plugin_call::Operation) -> v5::host_call::Operation {
    use v5::{host_call::Operation as Host, plugin_call::Operation as Plugin};
    match operation {
        Plugin::Servers(value) => Host::Servers(value),
        Plugin::Tools(value) => Host::Tools(value),
        Plugin::ReadResource(value) => Host::ReadResource(value),
        Plugin::CallTool(value) => Host::CallTool(value),
        Plugin::SessionGet(value) => Host::SessionGet(value),
        Plugin::SessionPrompt(value) => Host::SessionPrompt(value),
        Plugin::SessionInterrupt(value) => Host::SessionInterrupt(value),
        Plugin::SessionCreate(value) => Host::SessionCreate(value),
        Plugin::SessionGenerate(value) => Host::SessionGenerate(value),
        Plugin::SessionCommand(value) => Host::SessionCommand(value),
        Plugin::SessionSynthetic(value) => Host::SessionSynthetic(value),
        Plugin::AgentsList(value) => Host::AgentsList(value),
        Plugin::AgentGet(value) => Host::AgentGet(value),
        Plugin::AgentReload(value) => Host::AgentReload(value),
        Plugin::CommandsList(value) => Host::CommandsList(value),
        Plugin::CommandReload(value) => Host::CommandReload(value),
        Plugin::ReferencesList(value) => Host::ReferencesList(value),
        Plugin::ReferenceReload(value) => Host::ReferenceReload(value),
        Plugin::SkillsList(value) => Host::SkillsList(value),
        Plugin::SkillReload(value) => Host::SkillReload(value),
        Plugin::ProvidersList(value) => Host::ProvidersList(value),
        Plugin::ProviderGet(value) => Host::ProviderGet(value),
        Plugin::ModelsList(value) => Host::ModelsList(value),
        Plugin::ModelGet(value) => Host::ModelGet(value),
        Plugin::ModelDefault(value) => Host::ModelDefault(value),
        Plugin::CatalogReload(value) => Host::CatalogReload(value),
        Plugin::PluginsList(value) => Host::PluginsList(value),
        Plugin::IntegrationsList(value) => Host::IntegrationsList(value),
        Plugin::IntegrationGet(value) => Host::IntegrationGet(value),
        Plugin::IntegrationActive(value) => Host::IntegrationActive(value),
        Plugin::IntegrationReload(value) => Host::IntegrationReload(value),
        Plugin::IntegrationConnectKey(value) => Host::IntegrationConnectKey(value),
        Plugin::IntegrationOauthConnect(value) => Host::IntegrationOauthConnect(value),
        Plugin::IntegrationOauthStatus(value) => Host::IntegrationOauthStatus(value),
        Plugin::IntegrationOauthComplete(value) => Host::IntegrationOauthComplete(value),
        Plugin::IntegrationOauthCancel(value) => Host::IntegrationOauthCancel(value),
        Plugin::IntegrationCommandConnect(value) => Host::IntegrationCommandConnect(value),
        Plugin::IntegrationCommandStatus(value) => Host::IntegrationCommandStatus(value),
        Plugin::IntegrationCommandCancel(value) => Host::IntegrationCommandCancel(value),
        Plugin::IntegrationConnectionResolve(value) => Host::IntegrationConnectionResolve(value),
    }
}
fn prepare_tool(
    declaration: v5::Tool,
    configuration: &Configuration,
    shared: &Arc<Shared>,
    policy: &Arc<LeafPolicy>,
    names: &mut BTreeSet<(String, String)>,
) -> Result<registry::ProcessRegistration, Error> {
    if !names.insert((declaration.namespace.clone(), declaration.name.clone()))
        || !identifier(&declaration.name)
        || (!declaration.direct && !declaration.code_mode)
    {
        return Err(Error::Unauthorized);
    }
    if declaration.path.is_some() && !shared.trusted {
        return Err(Error::Unauthorized);
    }
    let code_path = declaration.path.map(wire::read_text).transpose()?;
    if code_path.as_ref().is_some_and(|path| {
        path.as_str()
            .is_none_or(|path| registry::validate_namespace(path).is_err())
    }) {
        return Err(Error::Unauthorized);
    }
    if shared.trusted && code_path.is_none() {
        let path = if declaration.namespace.is_empty() {
            declaration.name.clone()
        } else {
            format!("{}.{}", declaration.namespace, declaration.name)
        };
        registry::validate_namespace(&path).map_err(|_| Error::Unauthorized)?;
    }
    let grant = if shared.trusted {
        if registry::normalize_name(&declaration.name) != declaration.name
            || (!declaration.namespace.is_empty()
                && registry::validate_namespace(&declaration.namespace).is_err())
        {
            return Err(Error::Unauthorized);
        }
        let action = declaration
            .permission
            .clone()
            .unwrap_or_else(|| declaration.name.clone());
        if action.is_empty() || action.len() > 256 || action.chars().any(char::is_control) {
            return Err(Error::Unauthorized);
        }
        ToolGrant {
            namespace: declaration.namespace.clone(),
            tools: vec![declaration.name.clone()],
            action,
            resources: vec!["*".into()],
        }
    } else {
        if declaration.permission.is_some() {
            return Err(Error::Unauthorized);
        }
        configuration
            .grants
            .iter()
            .find(|grant| {
                grant.namespace == declaration.namespace && grant.tools.contains(&declaration.name)
            })
            .ok_or(Error::Unauthorized)?
            .clone()
    };
    let input = wire::read_value(declaration.input_schema)?;
    let output = wire::read_value(declaration.output_schema)?;
    if !shared.trusted {
        schema::check(&input)?;
        schema::check(&output)?;
    }
    let description = wire::read_text(declaration.description)?;
    if description.as_str().is_none() {
        return Err(Error::Schema);
    }
    Ok(registry::ProcessRegistration {
        tool: Arc::new(ProcessTool {
            code_path,
            implementation: declaration.implementation.filter(|_| shared.parent),
            shared: shared.clone(),
            namespace: declaration.namespace.clone(),
            name: declaration.name.clone(),
            description,
            input,
            output,
            grant,
            policy: policy.clone(),
        }) as Arc<dyn Tool>,
        name: declaration.name,
        namespace: declaration.namespace,
        direct: declaration.direct,
        code_mode: declaration.code_mode,
    })
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
            self.shared.terminate();
        }
    }
}
pub(super) enum Request {
    Setup,
    Release(u64),
    Execute {
        execute: Box<v5::Execute>,
        context: Context,
        reply: oneshot::Sender<Result<ToolOutput, Failed>>,
    },
    PluginReply {
        request: u64,
        outcome: v5::plugin_reply::Outcome,
    },
    Cancel(u64),
    Transform {
        transform: Box<v5::Transform>,
        context: Option<Context>,
        reply: oneshot::Sender<Result<Transformed, Error>>,
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
    Resolve {
        resolve: v5::LanguageResolve,
        reply: oneshot::Sender<Result<bool, Failed>>,
    },
    Language {
        attempt: v5::LanguageAttempt,
        ready: oneshot::Sender<Result<(), Failed>>,
        parts: mpsc::Sender<Result<JsonValue, ycoding_ai::Error>>,
        terminal: mpsc::OwnedPermit<Result<JsonValue, ycoding_ai::Error>>,
    },
    LanguageCredit {
        request: u64,
        permit: mpsc::OwnedPermit<Result<JsonValue, ycoding_ai::Error>>,
    },
    LanguageCancel(u64),
    Stop,
}
struct PendingLanguage {
    ready: Option<oneshot::Sender<Result<(), Failed>>>,
    parts: mpsc::Sender<Result<JsonValue, ycoding_ai::Error>>,
    terminal: mpsc::OwnedPermit<Result<JsonValue, ycoding_ai::Error>>,
    credit: Option<mpsc::OwnedPermit<Result<JsonValue, ycoding_ai::Error>>>,
    watcher: Option<JoinHandle<()>>,
    closed: JoinHandle<()>,
    deadline: Instant,
}
impl PendingLanguage {
    async fn grant(&mut self, request: u64, shared: &Shared) {
        if let Some(watcher) = self.watcher.take() {
            let _ = watcher.await;
        }
        let parts = self.parts.clone();
        let sender = shared.sender.clone();
        self.watcher = Some(tokio::spawn(async move {
            let message = match parts.reserve_owned().await {
                Ok(permit) => Request::LanguageCredit { request, permit },
                Err(_) => Request::LanguageCancel(request),
            };
            let _ = sender.send(message).await;
        }));
    }
    async fn settle(mut self, failure: Option<Failed>) {
        self.closed.abort();
        let _ = self.closed.await;
        if let Some(watcher) = self.watcher.take() {
            watcher.abort();
            let _ = watcher.await;
        }
        match (self.ready.take(), failure) {
            (Some(ready), failure) => {
                let _ = ready.send(failure.map_or(Ok(()), Err));
            }
            (None, Some(failure)) => {
                self.terminal.send(Err(language_error(failure)));
            }
            (None, None) => {}
        }
    }
}
pub(super) fn language_error(failure: Failed) -> ycoding_ai::Error {
    let message = failure
        .message
        .map(|message| String::from_utf16_lossy(&message.code_units().collect::<Vec<_>>()));
    match failure.error {
        Error::Rejected | Error::Unauthorized | Error::Permission => ycoding_ai::Error::invalid(
            message.unwrap_or_else(|| "Plugin language model rejected the request".into()),
        ),
        Error::Stopped | Error::Cancelled => ycoding_ai::Error::interrupted(),
        Error::UnknownOutcome => ycoding_ai::Error::transport(
            "Plugin language model outcome unknown; replay prohibited",
            "read",
        ),
        Error::Timeout => {
            ycoding_ai::Error::transport("Plugin language model deadline exceeded", "Timeout")
        }
        _ => ycoding_ai::Error::output(
            message.unwrap_or_else(|| "Plugin language model failed".into()),
        ),
    }
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
    reply: oneshot::Sender<Result<ToolOutput, Failed>>,
    deadline: Instant,
    cancellation: Option<Error>,
    progress: usize,
}
struct ActiveTransform {
    call: v5::Call,
    stage: i32,
    revision: u64,
    context: Option<Context>,
    reply: oneshot::Sender<Result<Transformed, Error>>,
    deadline: Instant,
    cancellation: Option<Error>,
}
struct Owner {
    process: Option<process::Process>,
    parent: Option<super::parent::Channel>,
    output: mpsc::Receiver<process::Chunk>,
    decoder: wire::Decoder,
    frames: VecDeque<v5::ChildFrame>,
    shared: Arc<Shared>,
    generation: String,
    options: Options,
    setup_deadline: Option<Instant>,
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
    plugin_calls: BTreeMap<u64, HostInflight>,
    last_plugin_request: u64,
    last_host_request: u64,
    seen_order: VecDeque<(String, String, ycoding_schema::LosslessString)>,
    resolves: BTreeMap<u64, (oneshot::Sender<Result<bool, Failed>>, Instant)>,
    languages: BTreeMap<u64, PendingLanguage>,
    declared: Option<LosslessString>,
    registry: Option<Arc<Registry>>,
    configuration: Configuration,
    extra_tools: BTreeMap<u64, Registration>,
    extra_auth: Vec<crate::resources::auth::integration::Registration>,
}
pub(super) struct Transformed {
    pub(super) draft: JsonValue,
    pub(super) oauth: Vec<v5::OAuthRegistration>,
}
impl Owner {
    fn install_initial(&mut self, batch: v5::RegisterTools) -> Result<(), Error> {
        let registry = self.registry.as_ref().ok_or(Error::Stopped)?;
        super::families::validate_batch(&self.shared, &batch)?;
        let mut names = BTreeSet::new();
        let prepared = batch
            .tools
            .into_iter()
            .map(|tool| {
                prepare_tool(
                    tool,
                    &self.configuration,
                    &self.shared,
                    &self.shared.policy,
                    &mut names,
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        let registration = if self.shared.trusted {
            registry.register_plugin_batch(prepared)
        } else {
            registry.register_process_batch(prepared)
        }
        .map_err(|_| Error::Unauthorized)?;
        self.registration = Some(registration);
        self.hooks.extend(super::families::install_hooks(
            &self.shared,
            &batch.transforms,
            self.configuration.registration_order,
            registry,
        ));
        self.shared
            .extra_declarations
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .extend(batch.transforms);
        self.shared
            .extra_domains
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .extend(batch.domains);
        self.auth_registration = super::families::install_auth(&self.shared, &batch.oauth)?;
        Ok(())
    }
    async fn registration_update(&mut self, update: v5::RegistrationUpdate) -> Result<(), Error> {
        if !self.shared.parent {
            return Err(Error::Unauthorized);
        }
        let result = self.install_update(update.add, &update.remove);
        let outcome = match result {
            Ok(()) => v5::registration_reply::Outcome::Done(v5::Null {}),
            Err(error) => v5::registration_reply::Outcome::Failure(v5::Failure {
                code: v5::FailureCode::Rejected as i32,
                message: Some(wire::text(&error.to_string().into())),
            }),
        };
        self.send(v5::host_frame::Body::RegistrationReply(
            v5::RegistrationReply {
                request: update.request,
                outcome: Some(outcome),
            },
        ))
        .await
    }
    fn install_update(
        &mut self,
        add: Option<v5::RegisterTools>,
        remove: &[String],
    ) -> Result<(), Error> {
        let registry = self.registry.as_ref().ok_or(Error::Stopped)?;
        if let Some(batch) = add {
            super::families::validate_batch(&self.shared, &batch)?;
            let mut names = BTreeSet::new();
            for declaration in batch.tools {
                let implementation = declaration.implementation.ok_or(Error::Protocol)?;
                if self.extra_tools.contains_key(&implementation) {
                    return Err(Error::Protocol);
                }
                let prepared = prepare_tool(
                    declaration,
                    &self.configuration,
                    &self.shared,
                    &self.shared.policy,
                    &mut names,
                )?;
                let registration = registry
                    .register_plugin_batch(vec![prepared])
                    .map_err(|_| Error::Unauthorized)?;
                self.extra_tools.insert(implementation, registration);
            }
            self.hooks.extend(super::families::install_hooks(
                &self.shared,
                &batch.transforms,
                self.configuration.registration_order,
                registry,
            ));
            for transform in &batch.transforms {
                if transform.stage == v5::TransformStage::Integrations as i32 {
                    let native = self
                        .shared
                        .host
                        .integrations
                        .as_ref()
                        .ok_or(Error::Unauthorized)?
                        .transform(|_| {})
                        .map_err(|_| Error::Stopped)?;
                    self.shared
                        .integration_transforms
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .push((transform.clone(), Arc::new(native)));
                }
            }
            self.shared
                .extra_declarations
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .extend(batch.transforms);
            if let Some(registration) = super::families::install_auth(&self.shared, &batch.oauth)? {
                self.extra_auth.push(registration);
            }
        }
        for selector in remove {
            let id = selector
                .strip_prefix("tool:")
                .and_then(|value| value.parse::<u64>().ok())
                .ok_or(Error::Protocol)?;
            self.extra_tools.remove(&id).ok_or(Error::Protocol)?;
        }
        Ok(())
    }
    async fn send(&self, body: v5::host_frame::Body) -> Result<(), Error> {
        let frame = v5::HostFrame {
            generation: self.generation.clone(),
            body: Some(body),
        };
        if let Some(parent) = &self.parent {
            return parent.send(frame).await;
        }
        let bytes = wire::encode(&frame)?;
        timeout(
            self.options.write,
            self.process.as_ref().ok_or(Error::Stopped)?.write(bytes),
        )
        .await
        .map_err(|_| Error::UnknownOutcome)?
        .map_err(|_| Error::UnknownOutcome)
    }
    async fn next(&mut self, limit: usize) -> Result<v5::ChildFrame, Error> {
        if let Some(parent) = &mut self.parent {
            return parent.next().await;
        }
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
    async fn hello(
        &mut self,
        configuration: &Configuration,
        plugin: Option<&Plugin>,
    ) -> Result<Instant, Error> {
        let started = Instant::now();
        tokio::time::timeout_at(started + self.options.startup, async {
            self.send(v5::host_frame::Body::Hello(hello(
                configuration,
                plugin,
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
            Ok(())
        })
        .await
        .unwrap_or(Err(Error::Timeout))?;
        Ok(started)
    }
    async fn declared(
        &mut self,
        deadline: Instant,
    ) -> Result<ycoding_schema::LosslessString, Error> {
        tokio::time::timeout_at(deadline, async {
            loop {
                match self.next(wire::FRAME_BYTES).await?.body {
                    Some(v5::child_frame::Body::Declared(declared)) => {
                        let id = wire::read_text(declared.id)?;
                        self.declared = Some(id.clone());
                        return Ok(id);
                    }
                    Some(v5::child_frame::Body::Diagnostic(diagnostic))
                        if diagnostic.code == v5::DiagnosticCode::ChildWarning as i32 =>
                    {
                        diagnose(&self.shared, v5::DiagnosticCode::ChildWarning)
                    }
                    _ => return Err(Error::Protocol),
                }
            }
        })
        .await
        .unwrap_or(Err(Error::Timeout))
    }
    async fn tools(
        &mut self,
        receiver: &mut mpsc::Receiver<Request>,
        deadline: Instant,
    ) -> Result<v5::RegisterTools, Error> {
        let trusted = self.shared.trusted;
        let limit = if trusted {
            wire::FRAME_BYTES
        } else {
            wire::STARTUP_BYTES
        };
        let tools = tokio::time::timeout_at(deadline, async {
            loop {
                tokio::select! {
                    frame = self.next(limit) => match frame?.body {
                        Some(v5::child_frame::Body::RegisterTools(tools)) => return Ok(tools),
                        Some(v5::child_frame::Body::PluginCall(call)) if trusted => self.plugin_call(call).await?,
                        Some(v5::child_frame::Body::Subscribe(subscription)) if trusted => super::families::subscribe(&self.shared, subscription)?,
                        Some(v5::child_frame::Body::Unsubscribe(unsubscribe)) if trusted => super::families::unsubscribe(&self.shared, unsubscribe.subscription)?,
                        Some(v5::child_frame::Body::Diagnostic(diagnostic)) if trusted && diagnostic.code == v5::DiagnosticCode::ChildWarning as i32 => diagnose(&self.shared, v5::DiagnosticCode::ChildWarning),
                        _ => return Err(Error::Protocol),
                    },
                    request = receiver.recv() => match request {
                        Some(Request::PluginReply { request, outcome }) => {
                            if self.plugin_calls.remove(&request).is_some() {
                                self.send(v5::host_frame::Body::PluginReply(v5::PluginReply { request, outcome: Some(outcome) })).await?;
                            }
                        }
                        _ => return Err(Error::Stopped),
                    },
                }
            }
        })
        .await
        .unwrap_or(Err(Error::Timeout))?;
        let count = tools.tools.len()
            + tools.transforms.len()
            + tools.domains.len()
            + tools.subscriptions.len()
            + tools.oauth.len();
        if (!trusted && count == 0) || count > if trusted { 256 } else { 64 } {
            return Err(Error::Capacity);
        }
        Ok(tools)
    }
    async fn stop(&mut self) -> Error {
        if self
            .send(v5::host_frame::Body::Shutdown(v5::Shutdown {}))
            .await
            .is_err()
        {
            return Error::UnknownOutcome;
        }
        let deadline = Instant::now()
            + if self.shared.parent {
                Duration::from_secs(12 * 3600)
            } else {
                self.options.shutdown
            };
        loop {
            match tokio::time::timeout_at(deadline, self.next(wire::FRAME_BYTES)).await {
                Ok(Ok(frame)) if matches!(frame.body, Some(v5::child_frame::Body::Stopped(_))) => {
                    break;
                }
                Ok(Ok(frame))
                    if matches!(frame.body, Some(v5::child_frame::Body::Diagnostic(_))) => {}
                _ => break,
            }
        }
        Error::Stopped
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
        if self.shared.trusted {
            if host.request <= self.last_host_request {
                return Err(Error::Protocol);
            }
            self.last_host_request = host.request;
        } else if self.host_requests.len() >= 4096 || !self.host_requests.insert(host.request) {
            return Err(Error::Protocol);
        }
        if self.host_calls.len() >= 8 {
            return self
                .send(v5::host_frame::Body::HostReply(v5::HostReply {
                    call: host.call,
                    request: host.request,
                    outcome: Some(v5::host_reply::Outcome::Failure(v5::Failure {
                        code: v5::FailureCode::Rejected as i32,
                        message: None,
                    })),
                }))
                .await;
        }
        let (signal, cancelled) = watch::channel(false);
        let shared = self.shared.clone();
        let (call, request) = (host.call.clone(), host.request);
        let task = tokio::spawn(async move {
            let outcome =
                super::families::host_operation(&shared, context.as_ref(), operation, cancelled)
                    .await;
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
    // A configured plugin may call the SDK outside any owned tool or hook call (setup, event
    // handlers, timers). Such calls have no Session principal; the generation owns them and
    // aborts them when it closes.
    async fn plugin_call(&mut self, call: v5::PluginCall) -> Result<(), Error> {
        if !self.shared.trusted || call.request <= self.last_plugin_request {
            return Err(Error::Protocol);
        }
        self.last_plugin_request = call.request;
        let operation = plugin_operation(call.operation.ok_or(Error::Protocol)?);
        if self.plugin_calls.len() >= 8 {
            return self
                .send(v5::host_frame::Body::PluginReply(v5::PluginReply {
                    request: call.request,
                    outcome: Some(v5::plugin_reply::Outcome::Failure(v5::Failure {
                        code: v5::FailureCode::Rejected as i32,
                        message: None,
                    })),
                }))
                .await;
        }
        let (signal, cancelled) = watch::channel(false);
        let shared = self.shared.clone();
        let request = call.request;
        let task = tokio::spawn(async move {
            let outcome = match super::families::host_operation(&shared, None, operation, cancelled)
                .await
            {
                v5::host_reply::Outcome::Value(value) => v5::plugin_reply::Outcome::Value(value),
                v5::host_reply::Outcome::Failure(failure) => {
                    v5::plugin_reply::Outcome::Failure(failure)
                }
            };
            let _ = shared
                .sender
                .send(Request::PluginReply { request, outcome })
                .await;
        });
        self.plugin_calls.insert(
            request,
            HostInflight {
                invocation: 0,
                signal,
                task,
            },
        );
        Ok(())
    }
    fn owned_context(&self, call: &v5::Call) -> Result<Option<Context>, Error> {
        if let Some(active) = self.active.get(&call.invocation)
            && active.call == *call
            && active.cancellation.is_none()
        {
            return Ok(Some(active.context.clone()));
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
                break self.stop().await;
            }
            let deadline = self
                .active
                .values()
                .map(|active| active.deadline)
                .chain(self.transforms.values().map(|active| active.deadline))
                .chain(self.event_credits.values().copied())
                .chain(self.auth.values().map(|pending| pending.deadline))
                .chain(self.providers.values().map(|pending| pending.deadline))
                .chain(self.resolves.values().map(|pending| pending.1))
                .chain(self.languages.values().map(|pending| pending.deadline))
                .chain(self.setup_deadline)
                .chain(stopping)
                .min()
                .unwrap_or_else(|| Instant::now() + Duration::from_secs(86400));
            tokio::select! {
                request = receiver.recv() => match request {
                    Some(Request::Setup) => {
                        if !self.shared.trusted || self.shared.parent_services.lock().unwrap_or_else(|error| error.into_inner()).is_none() { break Error::Stopped; }
                        if !self.shared.parent { self.setup_deadline = Some(Instant::now() + self.options.startup); }
                        if let Err(error) = self.send(v5::host_frame::Body::Setup(v5::PluginSetup {})).await { break error; }
                    }
                    Some(Request::Release(implementation)) => {
                        if let Err(error) = self.send(v5::host_frame::Body::Release(v5::Release { implementations: vec![implementation] })).await { break error; }
                    }
                    Some(Request::Execute { execute, context, reply }) => {
                        if stopping.is_some() || !self.shared.accepting.load(Ordering::Acquire) { let _ = reply.send(Err(Error::Stopped.into())); continue; }
                        let identity = (execute.call.session_id.clone(), execute.call.message_id.clone(), context.invocation_id().clone());
                        if self.shared.trusted && self.seen.len() >= 4096 && let Some(oldest) = self.seen_order.pop_front() { self.seen.remove(&oldest); }
                        if self.active.len() + self.transforms.len() >= 32 || self.seen.len() >= 4096 || !self.seen.insert(identity.clone()) { let _ = reply.send(Err(Error::Capacity.into())); continue; }
                        if self.shared.trusted { self.seen_order.push_back(identity); }
                        let id = execute.call.invocation;
                        self.active.insert(id, Active { call: execute.call.clone(), context, reply, deadline: Instant::now() + self.options.execution, cancellation: None, progress: 0 });
                        if let Err(error) = self.send(v5::host_frame::Body::Execute(*execute)).await { break error; }
                    }
                    Some(Request::Transform { transform, context, reply }) => {
                        if stopping.is_some() || !self.shared.accepting.load(Ordering::Acquire) { let _ = reply.send(Err(Error::Stopped)); continue; }
                        if self.active.len() + self.transforms.len() >= 32 || context.as_ref().is_some_and(|context| context.cancellation.is_cancelled()) { let _ = reply.send(Err(Error::Cancelled)); continue; }
                        self.transforms.insert(transform.call.invocation, ActiveTransform { call: transform.call.clone(), stage: transform.stage, revision: transform.revision, context, reply, deadline: Instant::now() + self.options.execution, cancellation: None });
                        if let Err(error) = self.send(v5::host_frame::Body::Transform(*transform)).await { break error; }
                    }
                    Some(Request::Event(event)) => {
                        if stopping.is_some() || !self.shared.accepting.load(Ordering::Acquire) {
                            self.shared.pending_events.lock().unwrap_or_else(|error| error.into_inner()).remove(&event.delivery);
                            continue;
                        }
                        if self.event_credits.len() >= wire::MAX_EVENT_DELIVERIES { break Error::Capacity; }
                        let allowed = self.shared.subscriptions.lock().unwrap_or_else(|error| error.into_inner()).get(&event.subscription).is_some_and(|families| super::families::event_matches(families, &event.family));
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
                    Some(Request::Resolve { resolve, reply }) => {
                        if stopping.is_some() || !self.shared.accepting.load(Ordering::Acquire) { let _ = reply.send(Err(Error::Stopped.into())); continue; }
                        if self.resolves.len() >= 8 { let _ = reply.send(Err(Error::Capacity.into())); continue; }
                        self.resolves.insert(resolve.request, (reply, Instant::now() + self.options.execution));
                        if let Err(error) = self.send(v5::host_frame::Body::LanguageResolve(resolve)).await { break error; }
                    }
                    Some(Request::Language { attempt, ready, parts, terminal }) => {
                        if stopping.is_some() || !self.shared.accepting.load(Ordering::Acquire) { let _ = ready.send(Err(Error::Stopped.into())); continue; }
                        if self.languages.len() >= 8 { let _ = ready.send(Err(Error::Capacity.into())); continue; }
                        let request = attempt.request;
                        let parts_closed = parts.clone();
                        let sender = self.shared.sender.clone();
                        let closed = tokio::spawn(async move {
                            parts_closed.closed().await;
                            let _ = sender.send(Request::LanguageCancel(request)).await;
                        });
                        let mut pending = PendingLanguage { ready: Some(ready), parts, terminal, credit: None, watcher: None, closed, deadline: Instant::now() + self.options.execution };
                        pending.grant(request, &self.shared).await;
                        self.languages.insert(request, pending);
                        if let Err(error) = self.send(v5::host_frame::Body::LanguageAttempt(attempt)).await { break error; }
                    }
                    Some(Request::LanguageCredit { request, permit }) => {
                        if let Some(pending) = self.languages.get_mut(&request) {
                            if pending.credit.replace(permit).is_some() { break Error::Protocol; }
                            if let Err(error) = self.send(v5::host_frame::Body::LanguageCredit(v5::LanguageCredit { request })).await { break error; }
                        }
                    }
                    Some(Request::LanguageCancel(id)) => {
                        if let Some(pending) = self.languages.remove(&id) {
                            pending.settle(Some(Error::Cancelled.into())).await;
                            if let Err(error) = self.send(v5::host_frame::Body::LanguageCancel(v5::LanguageCancel { request: id })).await { break error; }
                        }
                    }
                    Some(Request::ProviderCancel(id)) => {
                        if self.providers.remove(&id).is_some()
                            && let Err(error) = self.send(v5::host_frame::Body::ProviderCancel(v5::ProviderCancel { request: id })).await { break error; }
                    }
                    Some(Request::PluginReply { request, outcome }) => {
                        if self.plugin_calls.remove(&request).is_none() { continue; }
                        let reply = v5::PluginReply { request, outcome: Some(outcome) };
                        if let Err(error) = self.send(v5::host_frame::Body::PluginReply(reply)).await { break error; }
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
                            self.setup_deadline = None;
                            stopping = Some(Instant::now() + self.options.cleanup);
                            for pending in std::mem::take(&mut self.auth).into_values() { let _ = pending.reply.send(Err(Error::Stopped)); }
                            for pending in std::mem::take(&mut self.providers).into_values() { let _ = pending.reply.send(Err(Error::Stopped)); }
                            for (reply, _) in std::mem::take(&mut self.resolves).into_values() { let _ = reply.send(Err(Error::Stopped.into())); }
                            for pending in std::mem::take(&mut self.languages).into_values() { pending.settle(Some(Error::Stopped.into())).await; }
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
                    if self.setup_deadline.is_some_and(|deadline| Instant::now() >= deadline) { break Error::Timeout; }
                    if stopping.is_some_and(|deadline| Instant::now() >= deadline) { break Error::Timeout; }
                    if self.event_credits.values().any(|deadline| Instant::now() >= *deadline) { break Error::Timeout; }
                    if self.auth.values().any(|pending| Instant::now() >= pending.deadline) { break Error::Timeout; }
                    if self.providers.values().any(|pending| Instant::now() >= pending.deadline) { break Error::Timeout; }
                    if self.resolves.values().any(|pending| Instant::now() >= pending.1) || self.languages.values().any(|pending| Instant::now() >= pending.deadline) { break Error::Timeout; }
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
                    let _ = reply.send(Err(Error::Stopped.into()));
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
            v5::child_frame::Body::RegistrationUpdate(update) => {
                self.registration_update(update).await?
            }
            v5::child_frame::Body::RegisterTools(batch) if self.registry.is_some() => {
                if self.shared.setup.borrow().is_some() {
                    return Err(Error::Protocol);
                }
                if self.shared.parent {
                    self.install_update(Some(batch), &[])?;
                } else {
                    self.install_initial(batch)?;
                }
                self.setup_deadline = None;
                self.shared.setup.send_replace(Some(Ok(())));
            }
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
            v5::child_frame::Body::LanguageResolved(resolved) => {
                let (reply, _) = self
                    .resolves
                    .remove(&resolved.request)
                    .ok_or(Error::Protocol)?;
                let outcome = match resolved.failure {
                    Some(failure) => Err(Failed {
                        error: match v5::FailureCode::try_from(failure.code)
                            .map_err(|_| Error::Protocol)?
                        {
                            v5::FailureCode::Rejected => Error::Rejected,
                            v5::FailureCode::ExecutionFailed => Error::ExecutionFailed,
                            v5::FailureCode::UnknownOutcome => Error::UnknownOutcome,
                        },
                        message: failure_message(true, failure.message)?,
                    }),
                    None => Ok(resolved.handled),
                };
                let _ = reply.send(outcome);
            }
            v5::child_frame::Body::LanguageParts(parts) => {
                let Some(pending) = self.languages.get_mut(&parts.request) else {
                    return Ok(());
                };
                if let Some(ready) = pending.ready.take() {
                    if !parts.parts.is_empty() {
                        return Err(Error::Protocol);
                    }
                    let _ = ready.send(Ok(()));
                    return Ok(());
                }
                let [part] =
                    <[v5::Value; 1]>::try_from(parts.parts).map_err(|_| Error::Protocol)?;
                let value = wire::read_value(part)?;
                pending
                    .credit
                    .take()
                    .ok_or(Error::Protocol)?
                    .send(Ok(value));
                pending.grant(parts.request, &self.shared).await;
            }
            v5::child_frame::Body::LanguageResult(result) => {
                let Some(pending) = self.languages.remove(&result.request) else {
                    return Ok(());
                };
                let failure = match result.outcome.ok_or(Error::Protocol)? {
                    v5::language_result::Outcome::Done(_) => None,
                    v5::language_result::Outcome::Failure(failure) => Some(Failed {
                        error: match v5::FailureCode::try_from(failure.code)
                            .map_err(|_| Error::Protocol)?
                        {
                            v5::FailureCode::Rejected => Error::Rejected,
                            v5::FailureCode::ExecutionFailed => Error::ExecutionFailed,
                            v5::FailureCode::UnknownOutcome => Error::UnknownOutcome,
                        },
                        message: failure_message(true, failure.message)?,
                    }),
                };
                pending.settle(failure).await;
            }
            v5::child_frame::Body::HostCall(host) => self.host_call(host).await?,
            v5::child_frame::Body::PluginCall(call) => self.plugin_call(call).await?,
            v5::child_frame::Body::Subscribe(subscription) => {
                super::families::subscribe(&self.shared, subscription)?
            }
            v5::child_frame::Body::Unsubscribe(unsubscribe) => {
                super::families::unsubscribe(&self.shared, unsubscribe.subscription)?
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
                    v5::transformed::Outcome::Draft(draft) => Ok(Transformed {
                        draft: wire::read_value(draft)?,
                        oauth: result.oauth,
                    }),
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
                    v5::result::Outcome::Failure(failure) => Err(Failed {
                        error: match v5::FailureCode::try_from(failure.code)
                            .map_err(|_| Error::Protocol)?
                        {
                            v5::FailureCode::Rejected => Error::Rejected,
                            v5::FailureCode::ExecutionFailed => Error::ExecutionFailed,
                            v5::FailureCode::UnknownOutcome => Error::UnknownOutcome,
                        },
                        message: failure_message(self.shared.trusted, failure.message)?,
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
                let _ = active.reply.send(Err(reason.into()));
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
        self.extra_tools.clear();
        self.extra_auth.clear();
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
        for (reply, _) in std::mem::take(&mut self.resolves).into_values() {
            let _ = reply.send(Err(Error::UnknownOutcome.into()));
        }
        for pending in std::mem::take(&mut self.languages).into_values() {
            pending.settle(Some(Error::UnknownOutcome.into())).await;
        }
        super::provider::unregister_generation(&self.generation);
        self.event_credits.clear();
        for call in std::mem::take(&mut self.host_calls)
            .into_values()
            .chain(std::mem::take(&mut self.plugin_calls).into_values())
        {
            call.signal.send_replace(true);
            call.task.abort();
            let _ = call.task.await;
        }
        self.shared
            .pending_events
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        self.output.close();
        let reaped = if let Some(parent) = &mut self.parent {
            parent.close().await
        } else if let Some(process) = &mut self.process {
            if error == Error::Stopped {
                if !matches!(
                    process.shutdown_gracefully(self.options.shutdown).await,
                    Ok(Some(_))
                ) {
                    process.control().terminate_now();
                }
            } else {
                process.control().terminate_now();
            }
            process.wait().await.is_ok() && process.reap_group(self.options.shutdown).await.is_ok()
        } else {
            false
        };
        if self.shared.setup.borrow().is_none() {
            self.shared.setup.send_replace(Some(Err(error)));
        }
        for (_, active) in std::mem::take(&mut self.active) {
            let _ = active.reply.send(Err(if reaped {
                active.cancellation.unwrap_or(Error::UnknownOutcome)
            } else {
                Error::UnknownOutcome
            }
            .into()));
        }
        for (_, active) in std::mem::take(&mut self.transforms) {
            let _ = active.reply.send(Err(if reaped {
                active.cancellation.unwrap_or(Error::UnknownOutcome)
            } else {
                Error::UnknownOutcome
            }));
        }
        self.shared.closed.send_replace(true);
        self.shared
            .parent_services
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        self.shared
            .integration_transforms
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
    }
}
