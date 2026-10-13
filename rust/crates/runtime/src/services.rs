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
use ycoding_core::ycoding_schema::{JsonPath, ObjectDecoder};
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
    pub artifacts: Option<ArtifactProvider>,
    pub sessions: SessionStore,
    pub execution: &'static Execution,
    pub autonomy: autonomy::Service,
    pub orchestration: orchestration::Service,
    pub events: Feed,
    pub locations: Locations,
    pub credentials: credential::Service,
    pub browser: Option<Arc<service::Service>>,
    pub isolated_browser: Option<IsolatedBrowserResolver>,
    pub telemetry: ycoding_core::telemetry::Service,
    pub keep_awake: ycoding_core::platform::keep_awake::Service,
}

pub type IsolatedBrowserResolver =
    Arc<dyn Fn(&location::Ref) -> Result<Arc<isolated::Service>, String> + Send + Sync>;

impl Core {
    pub fn new(
        client: Client,
        execution: &'static Execution,
        mut configuration: Configuration,
    ) -> Self {
        let sessions = SessionStore::new(client.clone());
        let events = Feed::attach(&client);
        let sink = configuration.publisher.clone();
        let feed = events.clone();
        configuration.publisher = Arc::new(move |event| {
            let ephemeral = ephemeral(&event)?;
            sink(event)?;
            feed.publish(ephemeral);
            Ok(())
        });
        let autonomy = autonomy::Service::new(client.clone());
        let credentials = credential::Service::new(client.clone());
        Self {
            browser: None,
            isolated_browser: None,
            telemetry: ycoding_core::telemetry::Service::new(client.clone()),
            keep_awake: ycoding_core::platform::keep_awake::Service::new(),
            artifacts: None,
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
        }
    }
}

fn ephemeral(event: &policy::Event) -> Result<Ephemeral, String> {
    let path = JsonPath::default();
    let object = ObjectDecoder::new(&event.data, &path).map_err(|error| error.to_string())?;
    Ok(Ephemeral {
        id: ids::event_id()
            .map_err(|error| error.to_string())?
            .as_lossless()
            .clone(),
        created: ids::now_millis(),
        event_type: event.type_.into(),
        session: object
            .optional::<session::Id>("sessionID")
            .map_err(|error| error.to_string())?,
        data: event.data.clone(),
    })
}

struct LocalExecution(&'static Execution);

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
}

#[derive(Debug, Default)]
pub struct Subscriptions {
    inner: Mutex<HashMap<String, bool>>,
}

impl Subscriptions {
    pub fn arm(&self, id: String) {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, false);
    }

    pub fn end(&self, id: &str) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get_mut(id)
            .map(|end| *end = true)
            .is_some()
    }

    pub fn ended(&self, id: &str) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
            .is_some_and(|end| *end)
    }

    pub fn remove(&self, id: &str) {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(id);
    }
}
