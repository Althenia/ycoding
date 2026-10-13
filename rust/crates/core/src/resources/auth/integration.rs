use super::{Error, credential_id, now};
use crate::resources::credential::{Info, Service};
use std::{
    collections::BTreeMap,
    fmt,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::{sync::broadcast, task::JoinHandle};
use ycoding_schema::{
    DomainEncode, LosslessString, connection, integration, integration_id::IntegrationMethodId,
};
use ycoding_store::resources::Secret;

type Exchange = Pin<Box<dyn Future<Output = Result<Secret, Error>> + Send>>;
type CodeCallback = Arc<dyn Fn(String) -> Exchange + Send + Sync>;
type CodeSubmission =
    Arc<dyn Fn(String) -> Pin<Box<dyn Future<Output = Result<(), Error>> + Send>> + Send + Sync>;
type Transform = Arc<dyn Fn(&mut Draft) + Send + Sync>;
type Authorize = Arc<
    dyn Fn(
            integration::Inputs,
        ) -> Pin<Box<dyn Future<Output = Result<Authorization, Error>> + Send>>
        + Send
        + Sync,
>;
type Refresh = Arc<dyn Fn(ycoding_schema::credential::OAuth) -> Exchange + Send + Sync>;
type Label = Arc<dyn Fn(&Secret) -> Option<LosslessString> + Send + Sync>;

#[derive(Clone)]
pub struct OAuthImplementation {
    pub integration: LosslessString,
    pub method: integration::OAuthMethod,
    pub authorize: Authorize,
    pub refresh: Option<Refresh>,
    pub label: Option<Label>,
}
enum Mode {
    Auto(Option<Exchange>),
    Code(CodeCallback),
    Command,
}
pub struct Authorization {
    url: String,
    instructions: String,
    expires_at: Option<i64>,
    mode: Mode,
    submit: Option<CodeSubmission>,
}
impl Authorization {
    pub fn code(url: String, instructions: String, callback: CodeCallback) -> Self {
        Self {
            url,
            instructions,
            expires_at: None,
            mode: Mode::Code(callback),
            submit: None,
        }
    }
    pub fn automatic(
        url: String,
        instructions: String,
        callback: Exchange,
        submit: Option<CodeSubmission>,
        expires_at: Option<i64>,
    ) -> Self {
        Self {
            url,
            instructions,
            expires_at,
            mode: Mode::Auto(Some(callback)),
            submit,
        }
    }
}
impl fmt::Debug for Authorization {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Authorization([redacted])")
    }
}
#[derive(Clone)]
struct Entry {
    reference: integration::Ref,
    methods: Vec<integration::Method>,
    implementations: BTreeMap<IntegrationMethodId, OAuthImplementation>,
}
#[derive(Clone, Default)]
pub struct Draft {
    entries: BTreeMap<LosslessString, Entry>,
    order: Vec<LosslessString>,
}
impl Draft {
    pub fn register_endpoints(&mut self, catalog: &crate::resources::catalog::Catalog) {
        for record in &catalog.providers {
            if crate::resources::model::family(&record.provider.package).is_err()
                && !record.models.iter().any(|model| {
                    model
                        .package
                        .as_ref()
                        .is_some_and(|package| crate::resources::model::family(package).is_ok())
                })
            {
                continue;
            }
            let id = record.provider.integration_id.as_ref().map_or_else(
                || record.provider.id.0.clone(),
                |id| id.as_lossless().clone(),
            );
            self.update(id.clone(), |reference| {
                reference.name = record.provider.name.clone()
            });
            self.method(
                id.clone(),
                integration::Method::Key(integration::KeyMethod {
                    label: Some("API key".into()),
                }),
            );
            if !record.environment.is_empty() {
                self.method(
                    id,
                    integration::Method::Env(integration::EnvMethod {
                        names: record.environment.clone(),
                    }),
                );
            }
        }
    }

    pub fn extend(&mut self, other: &Self) {
        for id in &other.order {
            if !self.entries.contains_key(id) {
                self.order.push(id.clone());
            }
            if let Some(entry) = other.entries.get(id) {
                self.entries.insert(id.clone(), entry.clone());
            }
        }
    }
    fn entry(&mut self, id: LosslessString) -> &mut Entry {
        if !self.entries.contains_key(&id) {
            self.order.push(id.clone());
        }
        self.entries.entry(id.clone()).or_insert_with(|| Entry {
            reference: integration::Ref {
                id: ycoding_schema::integration_id::IntegrationId::new(id.clone())
                    .expect("integration ID"),
                name: id,
            },
            methods: Vec::new(),
            implementations: BTreeMap::new(),
        })
    }
    pub fn get(&self, id: &LosslessString) -> Option<&integration::Ref> {
        self.entries.get(id).map(|entry| &entry.reference)
    }
    pub fn references(&self) -> Vec<&integration::Ref> {
        self.order.iter().filter_map(|id| self.get(id)).collect()
    }
    pub fn update(&mut self, id: LosslessString, update: impl FnOnce(&mut integration::Ref)) {
        let entry = self.entry(id.clone());
        update(&mut entry.reference);
        entry.reference.id =
            ycoding_schema::integration_id::IntegrationId::new(id).expect("integration ID");
    }
    pub fn remove(&mut self, id: &LosslessString) {
        self.entries.remove(id);
        self.order.retain(|candidate| candidate != id);
    }
    pub fn methods(&self, id: &LosslessString) -> &[integration::Method] {
        self.entries
            .get(id)
            .map_or(&[], |entry| entry.methods.as_slice())
    }
    pub fn method(&mut self, integration: LosslessString, method: integration::Method) {
        let entry = self.entry(integration);
        if let Some(index) = entry
            .methods
            .iter()
            .position(|candidate| same_method(candidate, &method))
        {
            entry.methods[index] = method;
            return;
        }
        entry.methods.push(method);
    }
    pub fn oauth(&mut self, implementation: OAuthImplementation) {
        self.method(
            implementation.integration.clone(),
            integration::Method::OAuth(implementation.method.clone()),
        );
        self.entry(implementation.integration.clone())
            .implementations
            .insert(implementation.method.id.clone(), implementation);
    }
    pub fn remove_method(&mut self, id: &LosslessString, method: &integration::Method) {
        let Some(entry) = self.entries.get_mut(id) else {
            return;
        };
        entry
            .methods
            .retain(|candidate| !same_method(candidate, method));
        if let integration::Method::OAuth(method) = method {
            entry.implementations.remove(&method.id);
        }
    }
}
fn same_method(first: &integration::Method, second: &integration::Method) -> bool {
    match (first, second) {
        (integration::Method::OAuth(a), integration::Method::OAuth(b)) => a.id == b.id,
        (integration::Method::Command(a), integration::Method::Command(b)) => a.id == b.id,
        (integration::Method::Key(_), integration::Method::Key(_))
        | (integration::Method::Env(_), integration::Method::Env(_)) => true,
        _ => false,
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    Updated,
    ConnectionUpdated(LosslessString),
}
struct Attempt {
    integration: LosslessString,
    method: IntegrationMethodId,
    kind: Kind,
    label: Option<LosslessString>,
    time: integration::AttemptTime,
    status: super::Status,
    authorization: Option<Authorization>,
    completing: bool,
    persisting: bool,
    submitted: bool,
    remove_at: Option<i64>,
    task: Option<JoinHandle<()>>,
    submission: Option<JoinHandle<()>>,
    cancellation: Option<tokio::sync::watch::Sender<bool>>,
    message: Option<LosslessString>,
}
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    OAuth,
    Command,
}
enum Completion {
    Submit(CodeSubmission, String),
    Exchange(Exchange),
}
struct State {
    closed: bool,
    next_transform: u64,
    transforms: BTreeMap<u64, Transform>,
    draft: Draft,
    wellknown: Vec<(LosslessString, LosslessString, Vec<LosslessString>)>,
    attempts: BTreeMap<integration::AttemptId, Attempt>,
    scrubber: Option<JoinHandle<()>>,
}
struct Inner {
    event_source: crate::event_feed::EventSource,
    credentials: Service,
    env: BTreeMap<String, String>,
    preparation: super::Preparation,
    claude: Option<crate::resources::model::ClaudeHost>,
    state: Mutex<State>,
    events: broadcast::Sender<Event>,
}
#[derive(Clone)]
pub struct Registry(Arc<Inner>);

impl Inner {
    fn publish(&self, event: Event) {
        let data = match &event {
            Event::Updated => crate::event_feed::Data::IntegrationUpdated(Box::new(
                ycoding_schema::integration::Empty,
            )),
            Event::ConnectionUpdated(id) => crate::event_feed::Data::IntegrationConnectionUpdated(
                Box::new(ycoding_schema::integration::ConnectionUpdatedData {
                    integration_id: ycoding_schema::integration::Id::new(id.clone())
                        .expect("registry connection IDs are Integration IDs"),
                }),
            ),
        };
        if self.event_source.emit(data).is_err() {
            eprintln!("Integration event publication failed");
        }
        let _ = self.events.send(event);
    }
}

pub struct WellKnown {
    discovery: tokio::sync::Mutex<crate::resources::discovery::wellknown::Service>,
    registries: Mutex<Vec<Weak<Inner>>>,
}

impl WellKnown {
    pub fn new(discovery: crate::resources::discovery::wellknown::Service) -> Self {
        Self {
            discovery: tokio::sync::Mutex::new(discovery),
            registries: Mutex::new(Vec::new()),
        }
    }
    pub async fn attach(
        &self,
        registry: &Registry,
    ) -> Result<(), crate::resources::discovery::wellknown::Error> {
        let mut discovery = self.discovery.lock().await;
        let entries = discovery.entries().await?;
        registry
            .wellknown(&entries)
            .map_err(|_| crate::resources::discovery::wellknown::Error::InvalidManifest)?;
        let mut registries = self
            .registries
            .lock()
            .map_err(|_| crate::resources::discovery::wellknown::Error::InvalidManifest)?;
        registries.retain(|registry| registry.strong_count() > 0);
        if !registries
            .iter()
            .any(|attached| attached.ptr_eq(&Arc::downgrade(&registry.0)))
        {
            registries.push(Arc::downgrade(&registry.0));
        }
        Ok(())
    }
    pub async fn add(
        &self,
        origin: &str,
        time: i64,
    ) -> Result<(), crate::resources::discovery::wellknown::Error> {
        let mut discovery = self.discovery.lock().await;
        discovery.add(origin, time).await?;
        let registries = {
            let mut registries = self
                .registries
                .lock()
                .map_err(|_| crate::resources::discovery::wellknown::Error::InvalidManifest)?;
            registries.retain(|registry| registry.strong_count() > 0);
            registries
                .iter()
                .filter_map(Weak::upgrade)
                .collect::<Vec<_>>()
        };
        for registry in registries {
            match Registry(registry).wellknown(discovery.snapshot()) {
                Ok(()) | Err(Error::Closed) => (),
                Err(_) => {
                    return Err(crate::resources::discovery::wellknown::Error::InvalidManifest);
                }
            }
        }
        Ok(())
    }
}

impl Registry {
    pub fn new(credentials: Service, env: BTreeMap<String, String>) -> Self {
        Self::prepared(credentials, env, Default::default(), None)
    }
    pub fn prepared(
        credentials: Service,
        env: BTreeMap<String, String>,
        preparation: super::Preparation,
        claude: Option<crate::resources::model::ClaudeHost>,
    ) -> Self {
        let registry = Self(Arc::new(Inner {
            event_source: Default::default(),
            credentials,
            env,
            preparation,
            claude,
            state: Mutex::new(State {
                closed: false,
                next_transform: 0,
                transforms: BTreeMap::new(),
                draft: Draft::default(),
                wellknown: Vec::new(),
                attempts: BTreeMap::new(),
                scrubber: None,
            }),
            events: broadcast::channel(128).0,
        }));
        let inner = Arc::downgrade(&registry.0);
        let task = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                let Some(inner) = inner.upgrade() else {
                    return;
                };
                let Ok(time) = now() else {
                    return;
                };
                if Registry(inner).scrub(time).await.is_err() {
                    return;
                }
            }
        });
        if let Ok(mut state) = registry.0.state.lock() {
            state.scrubber = Some(task);
        }
        registry
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.0.events.subscribe()
    }
    pub fn bind_events(
        &self,
        feed: crate::event_feed::Feed,
        location: Option<ycoding_schema::location::Ref>,
    ) -> Result<(), String> {
        self.0.event_source.bind(feed, location)
    }
    pub fn transform(
        &self,
        update: impl Fn(&mut Draft) + Send + Sync + 'static,
    ) -> Result<Registration, Error> {
        let mut state = self.0.state.lock().map_err(|_| Error::Closed)?;
        if state.closed {
            return Err(Error::Closed);
        }
        let id = state.next_transform;
        state.next_transform = id.checked_add(1).ok_or(Error::Closed)?;
        state.transforms.insert(id, Arc::new(update));
        materialize(&mut state);
        self.0.publish(Event::Updated);
        Ok(Registration {
            registry: Arc::downgrade(&self.0),
            id,
        })
    }
    pub fn reload(&self) -> Result<(), Error> {
        let mut state = self.0.state.lock().map_err(|_| Error::Closed)?;
        materialize(&mut state);
        self.0.publish(Event::Updated);
        Ok(())
    }
    pub fn wellknown(
        &self,
        entries: &[crate::resources::discovery::wellknown::Entry],
    ) -> Result<(), Error> {
        let entries = entries
            .iter()
            .filter_map(|entry| entry.manifest.auth.as_ref().map(|auth| (entry, auth)))
            .map(|(entry, auth)| {
                let url = url::Url::parse(&entry.origin).map_err(|_| Error::Rejected)?;
                let hostname = url.host_str().ok_or(Error::Rejected)?;
                Ok((
                    entry.integration_id.as_str().into(),
                    hostname.into(),
                    auth.command.clone(),
                ))
            })
            .collect::<Result<Vec<_>, Error>>()?;
        let mut state = self.0.state.lock().map_err(|_| Error::Closed)?;
        if state.closed {
            return Err(Error::Closed);
        }
        state.wellknown = entries;
        materialize(&mut state);
        self.0.publish(Event::Updated);
        Ok(())
    }
    pub fn get(&self, id: &LosslessString) -> Result<Option<integration::Info>, Error> {
        let entry = self
            .0
            .state
            .lock()
            .map_err(|_| Error::Closed)?
            .draft
            .entries
            .get(id)
            .cloned();
        let Some(entry) = entry else {
            return Ok(None);
        };
        Ok(Some(integration::Info {
            id: entry.reference.id,
            name: entry.reference.name,
            methods: entry.methods.clone(),
            connections: self.connections(id, &entry.methods)?,
        }))
    }
    pub fn list_by(
        &self,
        compare: impl Fn(&LosslessString, &LosslessString) -> std::cmp::Ordering,
    ) -> Result<Vec<integration::Info>, Error> {
        let ids: Vec<_> = self
            .0
            .state
            .lock()
            .map_err(|_| Error::Closed)?
            .draft
            .order
            .clone();
        let mut items = ids
            .iter()
            .map(|id| self.get(id))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        items.sort_by(|first, second| compare(&first.name, &second.name));
        Ok(items)
    }
    fn connections(
        &self,
        id: &LosslessString,
        methods: &[integration::Method],
    ) -> Result<Vec<connection::Info>, Error> {
        let mut rows = self.0.credentials.list(id)?;
        rows.reverse();
        let active = rows
            .iter()
            .find(|row| row.active())
            .or_else(|| rows.first())
            .map(|row| row.id().clone());
        rows.sort_by_key(|row| row.id() != active.as_ref().unwrap_or(row.id()));
        let mut connections = rows
            .into_iter()
            .map(|row| {
                connection::Info::Credential(connection::CredentialInfo {
                    id: ycoding_schema::credential::Id(row.id().clone()),
                    label: row.label().clone(),
                    active: Some(row.id()) == active.as_ref(),
                })
            })
            .collect::<Vec<_>>();
        connections.extend(
            methods
                .iter()
                .flat_map(|method| match method {
                    integration::Method::Env(method) => method.names.as_slice(),
                    _ => &[],
                })
                .filter(|name| {
                    name.as_str()
                        .and_then(|name| self.0.env.get(name))
                        .is_some_and(|value| !value.is_empty())
                })
                .map(|name| connection::Info::Env(connection::EnvInfo { name: name.clone() })),
        );
        Ok(connections)
    }
    pub fn active(&self, id: &LosslessString) -> Result<Option<connection::Info>, Error> {
        let methods = self
            .0
            .state
            .lock()
            .map_err(|_| Error::Closed)?
            .draft
            .methods(id)
            .to_vec();
        Ok(self.connections(id, &methods)?.into_iter().next())
    }
    pub async fn snapshot(
        &self,
        connection: connection::Info,
        time: i64,
    ) -> Result<Snapshot, Error> {
        if let connection::Info::Env(env) = &connection {
            let value = env
                .name
                .as_str()
                .and_then(|name| self.0.env.get(name))
                .filter(|value| !value.is_empty())
                .map(|value| {
                    Secret::new(
                        ycoding_schema::credential::Value::Key(ycoding_schema::credential::Key {
                            key: value.clone().into(),
                            metadata: None,
                        })
                        .encode(),
                    )
                    .map_err(|_| Error::InvalidCredential)
                })
                .transpose()?;
            return Ok(Snapshot {
                connection,
                credential: None,
                value,
            });
        }
        let connection::Info::Credential(selected) = &connection else {
            unreachable!()
        };
        let Some(mut stored) = self.0.credentials.get(&selected.id.0)? else {
            return Ok(Snapshot {
                connection,
                credential: None,
                value: None,
            });
        };
        if let ycoding_schema::credential::Value::OAuth(value) = stored
            .secret()
            .domain()
            .map_err(|_| Error::InvalidCredential)?
            && stored.needs_refresh(time)?
        {
            let refresh = self
                .0
                .state
                .lock()
                .map_err(|_| Error::Closed)?
                .draft
                .entries
                .get(stored.integration_id())
                .and_then(|entry| entry.implementations.get(&value.method_id))
                .and_then(|implementation| implementation.refresh.clone());
            if let Some(refresh) = refresh {
                stored = self
                    .0
                    .credentials
                    .refresh(stored, time, refresh(value))
                    .await?
                    .ok_or(Error::ProfileUnavailable)?;
            }
        }
        let value = self
            .0
            .preparation
            .prepare_value(
                &self.0.credentials,
                stored.clone(),
                time,
                self.0.claude.as_ref().map(|host| &host.accounts),
            )
            .await?;
        Ok(Snapshot {
            connection,
            value: Some(value),
            credential: Some(stored),
        })
    }
    pub async fn selected_model(
        &self,
        info: &ycoding_schema::model::Info,
        value: Option<&ycoding_schema::credential::Value>,
        selected: Option<&Info>,
        cursor: Option<&crate::resources::cursor::route::Host>,
    ) -> Result<ycoding_ai::llm::Model, crate::resources::model::Error> {
        if let Some(providers) = &self.0.preparation.providers {
            return providers
                .selected_model(
                    info,
                    value,
                    selected,
                    self.0.claude.as_ref(),
                    cursor,
                    self.0.preparation.cursor.as_ref(),
                )
                .await;
        }
        crate::resources::model::from_catalog_model_with_claude(
            info,
            value,
            selected,
            self.0.claude.as_ref(),
        )
    }
    fn publish_connection(&self, integration: LosslessString) {
        self.0.publish(Event::ConnectionUpdated(integration));
        self.0.publish(Event::Updated);
    }
    pub async fn login_key(
        &self,
        integration: LosslessString,
        label: Option<LosslessString>,
        key: LosslessString,
        time: i64,
    ) -> Result<(), Error> {
        if !self
            .0
            .state
            .lock()
            .map_err(|_| Error::Closed)?
            .draft
            .methods(&integration)
            .iter()
            .any(|method| matches!(method, integration::Method::Key(_)))
        {
            return Err(Error::Rejected);
        }
        let secret = Secret::new(
            ycoding_schema::credential::Value::Key(ycoding_schema::credential::Key {
                key,
                metadata: None,
            })
            .encode(),
        )
        .map_err(|_| Error::InvalidCredential)?;
        self.0
            .credentials
            .create(credential_id()?, integration.clone(), label, secret, time)
            .await?;
        self.publish_connection(integration);
        Ok(())
    }
    pub async fn update(
        &self,
        id: LosslessString,
        label: Option<LosslessString>,
        time: i64,
    ) -> Result<(), Error> {
        let stored = self.0.credentials.get(&id)?;
        self.0.credentials.update(id, label, None, time).await?;
        if let Some(stored) = stored {
            self.publish_connection(stored.integration_id().clone());
            return Ok(());
        }
        self.0.publish(Event::Updated);
        Ok(())
    }
    pub async fn activate(&self, id: LosslessString, time: i64) -> Result<(), Error> {
        let Some(stored) = self.0.credentials.get(&id)? else {
            return Ok(());
        };
        self.0.credentials.activate(id, time).await?;
        self.publish_connection(stored.integration_id().clone());
        Ok(())
    }
    pub async fn remove(&self, id: LosslessString, time: i64) -> Result<(), Error> {
        let stored = self.0.credentials.get(&id)?;
        self.0.credentials.remove(id, time).await?;
        if let Some(stored) = stored {
            self.publish_connection(stored.integration_id().clone());
            return Ok(());
        }
        self.0.publish(Event::Updated);
        Ok(())
    }
    pub async fn connect(
        &self,
        integration: LosslessString,
        method: LosslessString,
        inputs: integration::Inputs,
        label: Option<LosslessString>,
        time: i64,
    ) -> Result<integration::Attempt, Error> {
        let method = IntegrationMethodId::new(method).map_err(|_| Error::Rejected)?;
        let implementation = self
            .0
            .state
            .lock()
            .map_err(|_| Error::Closed)?
            .draft
            .entries
            .get(&integration)
            .and_then(|entry| entry.implementations.get(&method))
            .cloned()
            .ok_or(Error::Rejected)?;
        let authorization = (implementation.authorize)(inputs).await?;
        self.insert_attempt(integration, method, label, authorization, time)
    }
    fn insert_attempt(
        &self,
        integration: LosslessString,
        method: IntegrationMethodId,
        label: Option<LosslessString>,
        mut authorization: Authorization,
        time: i64,
    ) -> Result<integration::Attempt, Error> {
        let id = integration::AttemptId(credential_id()?);
        let callback = match &mut authorization.mode {
            Mode::Auto(callback) => callback.take(),
            Mode::Code(_) | Mode::Command => None,
        };
        let info = integration::Attempt {
            attempt_id: id.clone(),
            url: authorization.url.clone().into(),
            instructions: authorization.instructions.clone().into(),
            mode: if matches!(authorization.mode, Mode::Code(_)) {
                "code"
            } else {
                "auto"
            }
            .into(),
            manual_code: authorization.submit.as_ref().map(|_| true),
            time: integration::AttemptTime {
                created: time as f64,
                expires: authorization
                    .expires_at
                    .unwrap_or(time.saturating_add(600_000)) as f64,
            },
        };
        let mut state = self.0.state.lock().map_err(|_| Error::Closed)?;
        if state.closed {
            return Err(Error::Closed);
        }
        let kind = if matches!(authorization.mode, Mode::Command) {
            Kind::Command
        } else {
            Kind::OAuth
        };
        state.attempts.insert(
            id.clone(),
            Attempt {
                integration,
                method,
                kind,
                label,
                time: info.time.clone(),
                status: super::Status::Pending,
                authorization: Some(authorization),
                completing: callback.is_some(),
                persisting: false,
                submitted: false,
                remove_at: None,
                task: None,
                submission: None,
                cancellation: None,
                message: None,
            },
        );
        if let Some(callback) = callback {
            let registry = self.clone();
            let worker_id = id.clone();
            let task = tokio::spawn(async move {
                let result = callback.await;
                let _ = registry
                    .settle(&worker_id, result, now().unwrap_or(time))
                    .await;
            });
            state.attempts.get_mut(&id).expect("inserted attempt").task = Some(task);
        }
        Ok(info)
    }
    pub fn status(
        &self,
        integration: &LosslessString,
        id: &integration::AttemptId,
    ) -> Result<integration::AttemptStatus, Error> {
        let state = self.0.state.lock().map_err(|_| Error::Closed)?;
        let attempt = state
            .attempts
            .get(id)
            .filter(|attempt| &attempt.integration == integration && attempt.kind == Kind::OAuth)
            .ok_or(Error::Rejected)?;
        Ok(match attempt.status {
            super::Status::Pending => integration::AttemptStatus::Pending(attempt.time.clone()),
            super::Status::Complete => integration::AttemptStatus::Complete(attempt.time.clone()),
            super::Status::Expired => integration::AttemptStatus::Expired(attempt.time.clone()),
            _ => integration::AttemptStatus::Failed {
                message: if attempt.status == super::Status::UnknownOutcome {
                    Error::UnknownOutcome
                } else {
                    Error::Rejected
                }
                .to_string()
                .into(),
                time: attempt.time.clone(),
            },
        })
    }
    pub async fn complete(
        &self,
        integration: &LosslessString,
        id: &integration::AttemptId,
        code: Option<&str>,
        time: i64,
    ) -> Result<(), Error> {
        let Some(completion) = self.claim_completion(integration, id, code)? else {
            return Ok(());
        };
        let callback = match completion {
            Completion::Exchange(callback) => callback,
            Completion::Submit(submit, code) => {
                let (sender, receiver) = tokio::sync::oneshot::channel();
                {
                    let mut state = self.0.state.lock().map_err(|_| Error::Closed)?;
                    let attempt = state
                        .attempts
                        .get_mut(id)
                        .filter(|attempt| {
                            attempt.status == super::Status::Pending && !attempt.persisting
                        })
                        .ok_or(Error::Rejected)?;
                    attempt.submission = Some(tokio::spawn(async move {
                        let _ = sender.send(submit(code).await);
                    }));
                }
                let result = receiver.await.unwrap_or(Err(Error::UnknownOutcome));
                if let Err(error) = result {
                    let _ = self.settle(id, Err(error), time).await;
                    let task = self
                        .0
                        .state
                        .lock()
                        .map_err(|_| Error::Closed)?
                        .attempts
                        .get_mut(id)
                        .filter(|attempt| {
                            !attempt.persisting && attempt.status != super::Status::Complete
                        })
                        .and_then(|attempt| attempt.task.take());
                    if let Some(task) = task {
                        task.abort();
                        if task.await.is_err_and(|error| !error.is_cancelled()) {
                            return Err(Error::UnknownOutcome);
                        }
                    }
                }
                return result;
            }
        };
        let (sender, receiver) = tokio::sync::oneshot::channel();
        {
            let mut state = self.0.state.lock().map_err(|_| Error::Closed)?;
            let attempt = state.attempts.get_mut(id).ok_or(Error::Rejected)?;
            let registry = self.clone();
            let id = id.clone();
            attempt.task = Some(tokio::spawn(async move {
                let result = registry.settle(&id, callback.await, time).await;
                let _ = sender.send(result);
            }));
        }
        receiver.await.map_err(|_| Error::UnknownOutcome)?
    }
    fn claim_completion(
        &self,
        integration: &LosslessString,
        id: &integration::AttemptId,
        code: Option<&str>,
    ) -> Result<Option<Completion>, Error> {
        let mut state = self.0.state.lock().map_err(|_| Error::Closed)?;
        let attempt = state
            .attempts
            .get_mut(id)
            .filter(|attempt| &attempt.integration == integration && attempt.kind == Kind::OAuth)
            .ok_or(Error::Rejected)?;
        if attempt.status != super::Status::Pending {
            return Ok(None);
        }
        let authorization = attempt.authorization.as_ref().ok_or(Error::Rejected)?;
        if let Some(submit) = &authorization.submit {
            let code = code
                .filter(|code| !code.trim().is_empty())
                .ok_or(Error::CodeRequired)?;
            if attempt.persisting || attempt.submitted {
                return Err(Error::Rejected);
            }
            attempt.submitted = true;
            return Ok(Some(Completion::Submit(submit.clone(), code.to_owned())));
        }
        let Mode::Code(callback) = &authorization.mode else {
            return Err(Error::Rejected);
        };
        let code = code.ok_or(Error::CodeRequired)?;
        if attempt.completing || attempt.persisting {
            return Err(Error::Rejected);
        }
        let callback = callback(code.into());
        attempt.completing = true;
        Ok(Some(Completion::Exchange(callback)))
    }
    async fn settle(
        &self,
        id: &integration::AttemptId,
        result: Result<Secret, Error>,
        time: i64,
    ) -> Result<(), Error> {
        let (integration, label) =
            {
                let mut state = self.0.state.lock().map_err(|_| Error::Closed)?;
                let Some(attempt) = state.attempts.get(id).filter(|attempt| {
                    attempt.status == super::Status::Pending && !attempt.persisting
                }) else {
                    return Ok(());
                };
                let integration = attempt.integration.clone();
                let method = attempt.method.clone();
                let label = attempt.label.clone().or_else(|| {
                    result.as_ref().ok().and_then(|value| {
                        state
                            .draft
                            .entries
                            .get(&integration)
                            .and_then(|entry| entry.implementations.get(&method))
                            .and_then(|implementation| implementation.label.as_ref())
                            .and_then(|label| label(value))
                    })
                });
                let attempt = state.attempts.get_mut(id).expect("pending attempt");
                if let Err(error) = &result {
                    attempt.status = if *error == Error::UnknownOutcome {
                        super::Status::UnknownOutcome
                    } else {
                        super::Status::Failed
                    };
                    attempt.remove_at = Some(time.saturating_add(60_000));
                    attempt.authorization.take();
                    if let Some(task) = attempt.submission.as_ref() {
                        task.abort();
                    }
                    return Err(*error);
                }
                attempt.persisting = true;
                (integration, label)
            };
        let result = self
            .0
            .credentials
            .create(credential_id()?, integration.clone(), label, result?, time)
            .await;
        {
            let mut state = self.0.state.lock().map_err(|_| Error::Closed)?;
            let attempt = state.attempts.get_mut(id).ok_or(Error::UnknownOutcome)?;
            attempt.status = if result.is_ok() {
                super::Status::Complete
            } else if result == Err(Error::UnknownOutcome) {
                super::Status::UnknownOutcome
            } else {
                super::Status::Failed
            };
            attempt.persisting = false;
            attempt.remove_at = Some(time.saturating_add(60_000));
            attempt.authorization.take();
            if let Some(task) = attempt.submission.as_ref() {
                task.abort();
            }
        }
        result?;
        self.publish_connection(integration);
        Ok(())
    }
    pub async fn cancel(
        &self,
        integration: &LosslessString,
        id: &integration::AttemptId,
    ) -> Result<(), Error> {
        self.cancel_kind(integration, id, Kind::OAuth).await
    }
    pub async fn cancel_command(
        &self,
        integration: &LosslessString,
        id: &integration::AttemptId,
    ) -> Result<(), Error> {
        self.cancel_kind(integration, id, Kind::Command).await
    }
    async fn cancel_kind(
        &self,
        integration: &LosslessString,
        id: &integration::AttemptId,
        kind: Kind,
    ) -> Result<(), Error> {
        let attempt = {
            let mut state = self.0.state.lock().map_err(|_| Error::Closed)?;
            if !state.attempts.get(id).is_some_and(|attempt| {
                &attempt.integration == integration
                    && attempt.kind == kind
                    && attempt.status == super::Status::Pending
                    && !attempt.persisting
            }) {
                return Ok(());
            }
            state.attempts.remove(id)
        };
        if let Some(mut attempt) = attempt {
            if let Some(signal) = attempt.cancellation.take() {
                signal.send_replace(true);
            }
            for task in [attempt.task.take(), attempt.submission.take()]
                .into_iter()
                .flatten()
            {
                if kind != Kind::Command {
                    task.abort();
                }
                if task.await.is_err_and(|error| !error.is_cancelled()) {
                    return Err(Error::UnknownOutcome);
                }
            }
        }
        Ok(())
    }
    pub fn command_status(
        &self,
        integration: &LosslessString,
        id: &integration::AttemptId,
    ) -> Result<integration::CommandAttemptStatus, Error> {
        let state = self.0.state.lock().map_err(|_| Error::Closed)?;
        let attempt = state
            .attempts
            .get(id)
            .filter(|attempt| &attempt.integration == integration && attempt.kind == Kind::Command)
            .ok_or(Error::Rejected)?;
        Ok(match attempt.status {
            super::Status::Pending => integration::CommandAttemptStatus::Pending {
                message: attempt.message.clone(),
                time: attempt.time.clone(),
            },
            super::Status::Complete => {
                integration::CommandAttemptStatus::Complete(attempt.time.clone())
            }
            super::Status::Expired => {
                integration::CommandAttemptStatus::Expired(attempt.time.clone())
            }
            _ => integration::CommandAttemptStatus::Failed {
                message: attempt
                    .message
                    .clone()
                    .unwrap_or_else(|| "Authentication failed".into()),
                time: attempt.time.clone(),
            },
        })
    }
    pub async fn scrub(&self, time: i64) -> Result<(), Error> {
        let tasks = {
            let mut state = self.0.state.lock().map_err(|_| Error::Closed)?;
            let mut tasks = Vec::new();
            for attempt in state.attempts.values_mut() {
                if attempt.status == super::Status::Pending
                    && !attempt.persisting
                    && attempt.time.expires <= time as f64
                {
                    attempt.status = super::Status::Expired;
                    attempt.authorization.take();
                    attempt.remove_at = Some(time.saturating_add(60_000));
                    if let Some(task) = attempt.task.take() {
                        if let Some(signal) = attempt.cancellation.take() {
                            signal.send_replace(true);
                        } else {
                            task.abort();
                        }
                        tasks.push(task);
                    }
                    if let Some(task) = attempt.submission.take() {
                        task.abort();
                        tasks.push(task);
                    }
                }
            }
            let removed: Vec<_> = state
                .attempts
                .extract_if(.., |_, attempt| {
                    attempt.status != super::Status::Pending
                        && attempt.remove_at.is_some_and(|remove| remove <= time)
                })
                .map(|(_, attempt)| attempt)
                .collect();
            tasks.extend(
                removed
                    .into_iter()
                    .flat_map(|attempt| [attempt.task, attempt.submission].into_iter().flatten()),
            );
            tasks
        };
        for task in tasks {
            if task.await.is_err_and(|error| !error.is_cancelled()) {
                return Err(Error::UnknownOutcome);
            }
        }
        Ok(())
    }
    pub async fn connect_command(
        &self,
        integration: LosslessString,
        method: LosslessString,
        label: Option<LosslessString>,
        time: i64,
    ) -> Result<integration::CommandAttempt, Error> {
        let method = IntegrationMethodId::new(method).map_err(|_| Error::Rejected)?;
        let command = self
            .0
            .state
            .lock()
            .map_err(|_| Error::Closed)?
            .draft
            .methods(&integration)
            .iter()
            .find_map(|candidate| match candidate {
                integration::Method::Command(candidate) if candidate.id == method => {
                    Some(candidate.command.clone())
                }
                _ => None,
            })
            .ok_or(Error::Rejected)?;
        if command.first().is_none_or(|command| command.is_empty()) {
            return Err(Error::Rejected);
        }
        let attempt = self.insert_attempt(
            integration,
            method,
            label,
            Authorization {
                url: String::new(),
                instructions: String::new(),
                expires_at: None,
                mode: Mode::Command,
                submit: None,
            },
            time,
        )?;
        let registry = self.clone();
        let id = attempt.attempt_id.clone();
        let (signal, receiver) = tokio::sync::watch::channel(false);
        let mut state = self.0.state.lock().map_err(|_| Error::Closed)?;
        let pending = state.attempts.get_mut(&id).ok_or(Error::Rejected)?;
        pending.cancellation = Some(signal);
        pending.task = Some(tokio::spawn(async move {
            let result = registry.run_command(&id, command, receiver).await;
            let _ = registry.settle(&id, result, now().unwrap_or(time)).await;
        }));
        Ok(integration::CommandAttempt {
            attempt_id: attempt.attempt_id,
            time: attempt.time,
        })
    }
    pub async fn shutdown(&self) -> Result<(), Error> {
        let (scrubber, tasks) = {
            let mut state = self.0.state.lock().map_err(|_| Error::Closed)?;
            state.closed = true;
            let tasks = state
                .attempts
                .values_mut()
                .flat_map(|attempt| {
                    if !attempt.persisting && attempt.status == super::Status::Pending {
                        attempt.status = super::Status::Cancelled;
                        attempt.authorization.take();
                    }
                    if let Some(signal) = attempt.cancellation.take() {
                        signal.send_replace(true);
                    }
                    let graceful = attempt.kind == Kind::Command || attempt.persisting;
                    [attempt.task.take(), attempt.submission.take()]
                        .into_iter()
                        .flatten()
                        .map(move |task| {
                            if !graceful {
                                task.abort();
                            }
                            (task, graceful)
                        })
                })
                .collect::<Vec<_>>();
            (state.scrubber.take(), tasks)
        };
        if let Some(task) = scrubber {
            task.abort();
            if task.await.is_err_and(|error| !error.is_cancelled()) {
                return Err(Error::UnknownOutcome);
            }
        }
        for (task, persisting) in &tasks {
            if !persisting {
                task.abort();
            }
        }
        for (task, _) in tasks {
            if task.await.is_err_and(|error| !error.is_cancelled()) {
                return Err(Error::UnknownOutcome);
            }
        }
        Ok(())
    }
    async fn run_command(
        &self,
        id: &integration::AttemptId,
        command: Vec<LosslessString>,
        mut cancellation: tokio::sync::watch::Receiver<bool>,
    ) -> Result<Secret, Error> {
        use crate::platform::process;
        if *cancellation.borrow() {
            return Err(Error::Rejected);
        }
        let mut command = process::Command::new(
            command
                .first()
                .and_then(LosslessString::as_str)
                .ok_or(Error::Rejected)?,
            command
                .iter()
                .skip(1)
                .map(|arg| arg.as_str().ok_or(Error::Rejected))
                .collect::<Result<Vec<_>, _>>()?,
        );
        command.env = self.0.env.clone();
        command.stdin = process::Input::Ignore;
        command.kill = process::KillOptions {
            signal: process::KillSignal::Kill,
            force_kill_after: Some(Duration::ZERO),
        };
        let mut process = match process::spawn(command).await {
            Ok(process) => process,
            Err(error) => {
                self.command_message(id, error.to_string())?;
                return Err(Error::Rejected);
            }
        };
        let mut output = process.take_output().ok_or(Error::Rejected)?;
        let mut stdout = Vec::new();
        let mut stderr = String::new();
        let mut held = Vec::new();
        let mut decoder_started = false;
        let mut cancelled = false;
        loop {
            tokio::select! {
                changed = cancellation.changed(), if !cancelled => {
                    if changed.is_err() || *cancellation.borrow() {
                        cancelled = true;
                        process.terminate(process::Termination::Cancelled).await.map_err(|_| Error::UnknownOutcome)?;
                    }
                }
                chunk = output.recv() => {
                    let Some(chunk) = chunk else { break; };
                    match chunk.kind {
                        process::StreamKind::Stdout => stdout.extend(chunk.bytes),
                        process::StreamKind::Stderr => {
                            held.extend(chunk.bytes);
                            let end = crate::platform::shell::paging::page_end(&held, held.len(), false);
                            let text = String::from_utf8_lossy(&held[..end]);
                            if !decoder_started && !text.is_empty() {
                                decoder_started = true;
                                stderr.push_str(text.strip_prefix('\u{feff}').unwrap_or(&text));
                            } else { stderr.push_str(&text); }
                            held.drain(..end);
                            if !stderr.is_empty() { self.command_message(id, stderr.clone())?; }
                        }
                        process::StreamKind::Fd(_) => (),
                    }
                }
            }
        }
        let tail = String::from_utf8_lossy(&held);
        stderr.push_str(if decoder_started {
            &tail
        } else {
            tail.strip_prefix('\u{feff}').unwrap_or(&tail)
        });
        if !stderr.is_empty() {
            self.command_message(id, stderr.clone())?;
        }
        let exit = process.wait().await.map_err(|_| Error::UnknownOutcome)?;
        if cancelled {
            return Err(Error::Rejected);
        }
        if exit.code != Some(0) {
            self.command_message(
                id,
                if stderr.trim().is_empty() {
                    format!("Authentication command exited {}", exit.code.unwrap_or(-1))
                } else {
                    stderr.trim().into()
                },
            )?;
            return Err(Error::Rejected);
        }
        let key = String::from_utf8_lossy(&stdout).trim().to_owned();
        if key.is_empty() {
            self.command_message(id, "Authentication command returned no credential".into())?;
            return Err(Error::Rejected);
        }
        Secret::new(
            ycoding_schema::credential::Value::Key(ycoding_schema::credential::Key {
                key: key.into(),
                metadata: None,
            })
            .encode(),
        )
        .map_err(|_| Error::InvalidCredential)
    }
    fn command_message(&self, id: &integration::AttemptId, message: String) -> Result<(), Error> {
        let mut state = self.0.state.lock().map_err(|_| Error::Closed)?;
        if let Some(attempt) = state.attempts.get_mut(id).filter(|attempt| {
            attempt.status == super::Status::Pending && attempt.kind == Kind::Command
        }) {
            attempt.message = Some(message.into());
        }
        Ok(())
    }
}
pub struct Snapshot {
    pub connection: connection::Info,
    pub credential: Option<Info>,
    pub value: Option<Secret>,
}
impl fmt::Debug for Snapshot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ConnectionSnapshot([redacted])")
    }
}
pub struct Registration {
    registry: Weak<Inner>,
    id: u64,
}
impl Registration {
    pub fn dispose(&self) -> Result<(), Error> {
        let Some(registry) = self.registry.upgrade() else {
            return Ok(());
        };
        let mut state = registry.state.lock().map_err(|_| Error::Closed)?;
        if state.transforms.remove(&self.id).is_some() {
            materialize(&mut state);
            registry.publish(Event::Updated);
        }
        Ok(())
    }
}
impl Drop for Registration {
    fn drop(&mut self) {
        let _ = self.dispose();
    }
}
fn materialize(state: &mut State) {
    let mut draft = Draft::default();
    for (id, name, command) in &state.wellknown {
        draft.update(id.clone(), |reference| reference.name = name.clone());
        draft.method(
            id.clone(),
            integration::Method::Command(integration::CommandMethod {
                id: IntegrationMethodId::new("login").expect("login method"),
                label: "Log in".into(),
                command: command.clone(),
            }),
        );
    }
    for transform in state.transforms.values() {
        transform(&mut draft);
    }
    state.draft = draft;
}
