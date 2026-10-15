use crate::auth::LocalAuth;
use crate::ids;
use crate::locations::{Configuration, Locations};
use std::sync::Arc;
use std::{
    collections::HashMap,
    sync::{Mutex, PoisonError},
};
use ycoding_core::event_feed::{Ephemeral, Feed};
use ycoding_core::platform::browser::{isolated, service};
use ycoding_core::resources::credential;
use ycoding_core::session::{
    autonomy,
    execution::Execution,
    orchestration,
    run_coordinator::{Outcome, RunFuture},
    store::Service as SessionStore,
};
use ycoding_core::tools::policy;
use ycoding_core::ycoding_schema::{location, session};
use ycoding_core::ycoding_store::Client;
use ycoding_protocol::connection::Budgets;

#[derive(Clone)]
pub struct ArtifactServices {
    pub store: ycoding_core::resources::project_artifact::store::Service,
    pub refresh: Arc<dyn Fn() + Send + Sync>,
}

pub type ArtifactProvider = Arc<
    dyn Fn(&ycoding_core::ycoding_schema::location::Info) -> Option<ArtifactServices> + Send + Sync,
>;

#[derive(Clone)]
pub struct Identity {
    pub version: String,
    pub pid: u64,
    pub source_epoch: String,
}

#[derive(Clone)]
pub struct Core {
    pub integrations: Option<IntegrationResolver>,
    pub mcp: Option<McpResolver>,
    pub catalogs: Option<CatalogProvider>,
    pub artifacts: Option<ArtifactProvider>,
    pub remote: Option<crate::connector::Control>,
    pub sessions: SessionStore,
    pub execution: &'static Execution,
    pub autonomy: autonomy::Service,
    pub orchestration: orchestration::Service,
    pub events: Feed,
    pub publisher: policy::Publisher,
    pub locations: Locations,
    pub credentials: credential::Service,
    pub browser: Option<Arc<service::Service>>,
    pub isolated_browser: Option<IsolatedBrowserResolver>,
    pub platform: Option<PlatformResolver>,
    pub platform_default_location: Option<location::Ref>,
    pub telemetry: ycoding_core::telemetry::Service,
    pub keep_awake: ycoding_core::platform::keep_awake::Service,
    pub provider_usage: Option<ProviderUsageResolver>,
    pub usage_pricer: Option<UsagePricer>,
    pub(crate) maintenance: Option<Arc<crate::production::Maintenance>>,
}

pub type UsagePricer = Arc<
    dyn Fn(
            &ycoding_core::session::usage_read::PricingRef,
        ) -> Option<ycoding_core::session::usage_read::Pricing>
        + Send
        + Sync,
>;

pub struct ProviderUsageServices {
    pub quota: Arc<ycoding_core::resources::model::quota::Service>,
    pub providers: Vec<ycoding_core::ycoding_schema::provider::Id>,
}

pub type ProviderUsageResolver =
    Arc<dyn Fn(&location::Info) -> Result<ProviderUsageServices, String> + Send + Sync>;

pub type IsolatedBrowserResolver =
    Arc<dyn Fn(&location::Ref) -> Result<Arc<isolated::Service>, String> + Send + Sync>;

pub struct PlatformServices {
    pub shell: Arc<ycoding_core::platform::shell::Shell>,
    pub pty: Arc<ycoding_core::platform::pty::Pty>,
    pub tickets: Arc<Mutex<ycoding_core::platform::pty::ticket::Tickets>>,
    pub config: Arc<ycoding_core::resources::config::Configuration>,
    pub filesystem: Arc<ycoding_core::platform::filesystem::Location>,
    pub search: Arc<ycoding_core::platform::filesystem::search::Service>,
    pub git: Arc<ycoding_core::platform::git::Service>,
    pub copies: Arc<ycoding_core::platform::project_copy::Copies>,
}

pub type PlatformResolver =
    Arc<dyn Fn(&location::Ref) -> Result<Arc<PlatformServices>, String> + Send + Sync>;
#[derive(Clone)]
pub struct IntegrationServices {
    pub registry: ycoding_core::resources::auth::integration::Registry,
    pub wellknown: Option<Arc<ycoding_core::resources::auth::integration::WellKnown>>,
}

pub type IntegrationResolver =
    Arc<dyn Fn(&location::Info) -> Result<IntegrationServices, String> + Send + Sync>;
pub type McpResolver = Arc<
    dyn Fn(&location::Info) -> Result<Arc<ycoding_core::resources::mcp::Service>, String>
        + Send
        + Sync,
>;

impl Core {
    pub fn new(
        client: Client,
        execution: &'static Execution,
        configuration: Configuration,
    ) -> Self {
        let sessions = SessionStore::new(client.clone());
        let events = Feed::attach(&client);
        let sink = configuration.publisher.clone();
        let feed = events.clone();
        let source_sessions = sessions.clone();
        let publisher = Arc::new(move |event| {
            let mut ephemeral = ephemeral(&event)?;
            ephemeral.location = ephemeral
                .session
                .as_ref()
                .map(|id| {
                    source_sessions
                        .get(id)
                        .map(|session| session.map(|session| session.location))
                })
                .transpose()
                .map_err(|error| error.to_string())?
                .flatten();
            sink(event)?;
            feed.publish(ephemeral);
            Ok(())
        });
        let autonomy = autonomy::Service::new(client.clone());
        let credentials = credential::Service::new(client.clone());
        Self {
            publisher,
            integrations: None,
            mcp: None,
            catalogs: None,
            browser: None,
            isolated_browser: None,
            platform: None,
            platform_default_location: None,
            telemetry: ycoding_core::telemetry::Service::new(client.clone()),
            keep_awake: ycoding_core::platform::keep_awake::Service::new(),
            artifacts: None,
            provider_usage: None,
            usage_pricer: None,
            remote: None,
            locations: Locations::new(
                client,
                sessions.clone(),
                configuration,
                events.clone(),
                autonomy.clone(),
            ),
            events,
            autonomy,
            orchestration: orchestration::Service::new(
                sessions.clone(),
                Arc::new(LocalExecution(execution)),
            ),
            sessions,
            execution,
            credentials,
            maintenance: None,
        }
    }
}

pub type CatalogTask = Arc<dyn Fn() -> crate::dispatch::Boxed<Result<(), String>> + Send + Sync>;

#[derive(Clone)]
pub struct CatalogServices {
    pub session: Option<SessionServices>,
    pub models: Arc<ycoding_core::resources::model::Resolver>,
    pub agents: Arc<ycoding_core::resources::agent::Service>,
    pub commands: Arc<ycoding_core::resources::command::Service>,
    pub references: Arc<ycoding_core::resources::reference::Service>,
    pub skills: Arc<tokio::sync::Mutex<ycoding_core::resources::skill::Service>>,
    pub roots: ycoding_core::resources::config::Roots,
    pub diagnostics: Vec<ycoding_core::ycoding_schema::config::Diagnostic>,
    pub plugins: Vec<ycoding_core::ycoding_schema::plugin::Info>,
    pub ready: CatalogTask,
    pub refresh: CatalogTask,
    pub generate: Arc<ycoding_core::resources::generate::Service>,
}

#[derive(Clone)]
pub struct SessionServices {
    pub runner: ycoding_core::session::runner::Local,
    pub generate: Arc<ycoding_core::session::generate::Service>,
    pub destination: Option<DestinationServices>,
}

#[derive(Clone)]
pub struct DestinationServices {
    pub resolve: Arc<
        dyn Fn(location::Ref) -> crate::dispatch::Boxed<Result<location::Info, String>>
            + Send
            + Sync,
    >,
    pub invalidate:
        Arc<dyn Fn(location::Ref) -> crate::dispatch::Boxed<Result<(), String>> + Send + Sync>,
}

impl Core {
    pub fn session_services(
        &self,
        location: &crate::LocationServices,
    ) -> Result<(CatalogServices, SessionServices), crate::dispatch::Failure> {
        let catalogs = self.catalogs.as_ref().ok_or_else(|| {
            crate::dispatch::Failure::Unavailable(
                "Location catalog services are not composed".into(),
            )
        })?(&location.info)
        .map_err(crate::dispatch::Failure::Unavailable)?;
        let services = catalogs.session.clone().ok_or_else(|| {
            crate::dispatch::Failure::Unavailable(
                "Location Session ingress services are not composed".into(),
            )
        })?;
        let reference = location::Ref {
            directory: location.info.directory.clone(),
            workspace_id: location.info.workspace_id.clone(),
        };
        if services.runner.location() != &reference
            || services.generate.location != reference
            || !Arc::ptr_eq(services.runner.models(), &catalogs.models)
        {
            return Err(crate::dispatch::Failure::Unavailable(
                "Location Session owners disagree".into(),
            ));
        }
        Ok((catalogs, services))
    }
}

pub type CatalogProvider =
    Arc<dyn Fn(&location::Info) -> Result<CatalogServices, String> + Send + Sync>;

pub(crate) fn ephemeral(event: &policy::Event) -> Result<Ephemeral, String> {
    let data = ycoding_core::event_feed::Data::decode(event.type_, &event.data)?;
    let session = data.session()?;
    Ok(Ephemeral {
        id: ids::event_id()
            .map_err(|error| error.to_string())?
            .as_lossless()
            .clone(),
        created: ids::now_millis(),
        session,
        metadata: None,
        location: None,
        data,
    })
}

pub(crate) struct LocalExecution(pub(crate) &'static Execution);

impl orchestration::Execution for LocalExecution {
    fn wake(&self, id: &session::Id) -> Outcome {
        self.0.wake(id)
    }

    fn interrupt(&self, id: &session::Id) -> RunFuture {
        let execution = self.0;
        let id = id.clone();
        Box::pin(async move { execution.interrupt(&id).await })
    }
}

#[derive(Clone)]
pub struct Services {
    pub identity: Identity,
    pub auth: LocalAuth,
    pub cors: Vec<String>,
    pub budgets: Budgets,
    pub core: Option<Core>,
}

pub struct Environment {
    pub services: Services,
    pub urls: Vec<String>,
    pub subscriptions: Subscriptions,
    pub uploads: crate::session_attachment_upload::Staging,
}

#[derive(Debug, Default)]
pub struct Subscriptions {
    inner: Mutex<HashMap<String, Subscription>>,
}

#[derive(Debug)]
struct Subscription {
    owner: String,
    ended: bool,
}

impl Subscriptions {
    pub fn arm(&self, owner: &str, id: String) {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(
                id,
                Subscription {
                    owner: owner.into(),
                    ended: false,
                },
            );
    }

    pub fn end(&self, owner: &str, id: &str) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get_mut(id)
            .filter(|sub| sub.owner == owner && !sub.ended)
            .map(|sub| sub.ended = true)
            .is_some()
    }

    pub fn ended(&self, owner: &str, id: &str) -> Option<bool> {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
            .filter(|sub| sub.owner == owner)
            .map(|sub| sub.ended)
    }

    pub fn remove(&self, owner: &str, id: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        if inner.get(id).is_some_and(|sub| sub.owner == owner) {
            inner.remove(id);
        }
    }

    pub fn release(&self, owner: &str) {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|_, sub| sub.owner != owner);
    }
}
