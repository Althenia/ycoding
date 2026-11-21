use super::{
    Admission,
    access::{self, Access, Error},
    authority::{self, Gate, Lifetime},
    decisions::{Decisions, Pending},
    projection::{Answers, InputQuestion, Read, Stage},
};
use crate::{
    event_feed,
    resources::{config, credential},
    session::{self as sessions, info, key, pending, store::Service},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    ops::Bound,
    pin::Pin,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder, form, location, model,
    schema::AbsolutePath, session, session_message, session_pending,
};
use ycoding_store::{
    Client, KeyPart,
    project::{DirectoryTable, ProjectTable},
    resources::{self, KvTable},
    session::{Document, NewEvent, SequenceTable, SessionTable},
    tuple_key,
};

pub mod executor_authorization;
pub mod executor_scope;

pub type NativeFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, Error>> + Send + 'a>>;
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Configuration {
    Disabled,
    Enabled {
        access_revision: u64,
        profile: String,
        credential_id: String,
        account_id: String,
        account_generation: i64,
    },
}
#[derive(Clone)]
pub struct Pins {
    pub access_revision: u64,
    pub profile: String,
    pub credential_id: String,
    pub account_id: String,
    pub account_generation: i64,
    pub environment_id: String,
    pub connection_id: LosslessString,
    pub is_current: Arc<dyn Fn() -> bool + Send + Sync>,
}
impl Pins {
    fn configuration(&self) -> Configuration {
        Configuration::Enabled {
            access_revision: self.access_revision,
            profile: self.profile.clone(),
            credential_id: self.credential_id.clone(),
            account_id: self.account_id.clone(),
            account_generation: self.account_generation,
        }
    }
}
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct ChannelAddress {
    pub client_id: String,
    pub stream_id: String,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Model {
    pub id: String,
    pub provider_id: String,
    pub name: Option<String>,
    pub profile: Option<String>,
    pub active: Option<bool>,
    pub variants: Option<Vec<String>>,
    pub is_default: Option<bool>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Skill {
    pub id: String,
    pub name: Option<String>,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Waiting {
    Approval,
    UserInput,
}
#[derive(Clone, Debug, PartialEq)]
pub struct RootSnapshot {
    pub session: session::Info,
    pub selected_model: Option<model::Ref>,
    pub active: bool,
    pub waiting: Vec<Waiting>,
    pub snapshot_error: bool,
}
pub struct RootRead {
    pub root: RootSnapshot,
    pub messages: Vec<session_message::Info>,
}
pub struct ResolvedCredential {
    pub profile: String,
    pub credential_id: String,
    pub account_id: String,
    pub account_generation: i64,
    pub access_token: String,
}
pub struct Subscription(Option<Box<dyn FnOnce() + Send>>);
impl Subscription {
    pub fn new(stop: impl FnOnce() + Send + 'static) -> Self {
        Self(Some(Box::new(stop)))
    }
    pub fn stop(mut self) {
        if let Some(stop) = self.0.take() {
            stop();
        }
    }
}
impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(stop) = self.0.take() {
            stop();
        }
    }
}
pub type Listener = Arc<dyn Fn(&event_feed::Item) + Send + Sync>;
pub type Retirement = Arc<dyn Fn() + Send + Sync>;
pub type EscalationListener = Arc<dyn Fn(&session::Id) + Send + Sync>;
type CredentialResolver = Arc<
    dyn Fn(String, Option<String>) -> NativeFuture<'static, Option<ResolvedCredential>>
        + Send
        + Sync,
>;
pub trait RemovalLease: Send + Sync {
    fn members(&self) -> &[session::Id];
    fn is_current(&self) -> bool;
}
pub trait Backend: Send + Sync {
    fn decisions(&self, session: session::Info) -> NativeFuture<'_, Arc<Decisions>>;
    fn selected_model(&self, session: session::Info) -> NativeFuture<'_, Option<model::Ref>>;
    fn models(&self, location: location::Ref) -> NativeFuture<'_, Vec<Model>>;
    fn validate_model(
        &self,
        location: location::Ref,
        model: model::Ref,
    ) -> NativeFuture<'_, model::Ref>;
    fn switch_model(
        &self,
        session: session::Info,
        model: model::Ref,
        admission: Admission,
    ) -> NativeFuture<'_, ()>;
    fn retire_root(
        &self,
        root: session::Id,
        admission: Admission,
    ) -> NativeFuture<'_, Box<dyn RemovalLease>>;
    fn skills(&self, session: session::Info) -> NativeFuture<'_, Vec<Skill>>;
    fn active(&self, session: &session::Id) -> bool;
    fn prompt(&self, request: pending::Request, admission: Admission) -> NativeFuture<'_, ()>;
    fn interrupt(&self, session: session::Id) -> NativeFuture<'_, ()>;
    fn subscribe(&self, listener: Listener, on_retire: Retirement) -> Result<Subscription, Error>;
}
pub struct Options {
    pub access: Access,
    pub global: Arc<config::Configuration>,
    pub credentials: credential::Service,
    pub sessions: Service,
    pub client: Client,
    pub backend: Arc<dyn Backend>,
    pub credential: CredentialResolver,
}
struct State {
    previous: Configuration,
    closed: bool,
    connections: Vec<Weak<ConnectionInner>>,
    listeners: BTreeMap<u64, Arc<dyn Fn() + Send + Sync>>,
    next: u64,
}
struct Inner {
    options: Options,
    state: Mutex<State>,
    access_listener: Mutex<Option<access::Listener>>,
    event_listener: Mutex<Option<Subscription>>,
}
#[derive(Clone)]
pub struct Host(Arc<Inner>);
impl Host {
    pub fn new(options: Options) -> Result<Self, Error> {
        let host = Self(Arc::new(Inner {
            options,
            state: Mutex::new(State {
                previous: Configuration::Disabled,
                closed: false,
                connections: vec![],
                listeners: BTreeMap::new(),
                next: 0,
            }),
            access_listener: Mutex::new(None),
            event_listener: Mutex::new(None),
        }));
        let access_listener = host.0.options.access.listen(host.configuration_observer());
        *host
            .0
            .access_listener
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(access_listener);
        let weak = Arc::downgrade(&host.0);
        let failed = Arc::downgrade(&host.0);
        let event_listener = host.0.options.backend.subscribe(
            Arc::new(move |item| {
                let Some(host) = weak.upgrade() else {
                    return;
                };
                let host = Host(host);
                match &item.payload {
                    event_feed::Payload::Durable(event)
                        if matches!(
                            event.type_.as_str(),
                            Some("session.archived.2" | "session.deleted.2")
                        ) =>
                    {
                        let connections = host
                            .0
                            .state
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .connections
                            .iter()
                            .filter_map(Weak::upgrade)
                            .collect::<Vec<_>>();
                        if let Ok(root) = session::Id::new(event.aggregate_id.clone()) {
                            for connection in connections {
                                let channels = connection
                                    .channels
                                    .lock()
                                    .unwrap_or_else(|error| error.into_inner())
                                    .values()
                                    .filter_map(Weak::upgrade)
                                    .collect::<Vec<_>>();
                                for channel in channels {
                                    Channel(channel).retire_root(&root);
                                }
                            }
                        }
                    }
                    event_feed::Payload::Ephemeral(event)
                        if matches!(
                            event.data,
                            event_feed::Data::ConfigUpdated(_)
                                | event_feed::Data::IntegrationConnectionUpdated(_)
                        ) =>
                    {
                        let _ = host.configuration();
                    }
                    _ => {}
                }
            }),
            Arc::new(move || {
                if let Some(host) = failed.upgrade() {
                    Host(host).close();
                }
            }),
        )?;
        *host
            .0
            .event_listener
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(event_listener);
        host.configuration()?;
        Ok(host)
    }
    pub fn configuration_observer(&self) -> Retirement {
        let weak = Arc::downgrade(&self.0);
        Arc::new(move || {
            if let Some(host) = weak.upgrade() {
                let _ = Host(host).configuration();
            }
        })
    }
    pub fn attach_transport(
        &self,
        transport: Arc<dyn access::Transport>,
    ) -> Result<access::Attachment, Error> {
        if self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .closed
        {
            return Err(Error::Unavailable);
        }
        self.0.options.access.attach_transport(transport)
    }
    pub fn configuration(&self) -> Result<Configuration, Error> {
        let next = self.0.options.access.get().and_then(|preference| {
            resolve_configuration(
                preference,
                &self.0.options.global,
                &self.0.options.credentials,
            )
        });
        let current = next.as_ref().cloned().unwrap_or(Configuration::Disabled);
        let (retire, listeners, result) = {
            let mut state = self
                .0
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let current = if state.closed {
                Configuration::Disabled
            } else {
                current
            };
            if state.previous == current {
                (vec![], vec![], current)
            } else {
                state.previous = current.clone();
                (
                    std::mem::take(&mut state.connections),
                    state.listeners.values().cloned().collect(),
                    current,
                )
            }
        };
        for connection in retire
            .into_iter()
            .filter_map(|connection| connection.upgrade())
        {
            Connection(connection).retire();
        }
        for listener in listeners {
            listener();
        }
        next.map(|_| result)
    }
    pub async fn credential(
        &self,
        profile: &str,
        rejected_access_token: Option<String>,
    ) -> Result<Option<ResolvedCredential>, Error> {
        let expected = self.configuration()?;
        let Configuration::Enabled {
            profile: selected,
            credential_id,
            account_id,
            account_generation,
            ..
        } = &expected
        else {
            return Ok(None);
        };
        if selected != profile {
            return Ok(None);
        }
        let resolved = (self.0.options.credential)(profile.into(), rejected_access_token).await?;
        if self.configuration()? != expected {
            return Ok(None);
        }
        Ok(resolved.filter(|resolved| {
            &resolved.profile == selected
                && &resolved.credential_id == credential_id
                && &resolved.account_id == account_id
                && &resolved.account_generation == account_generation
        }))
    }
    pub fn name(&self) -> Result<Option<LosslessString>, Error> {
        self.0
            .options
            .global
            .native_dots_name()
            .map_err(|_| Error::Unavailable)
    }
    pub fn subscribe_configuration(&self, listener: Arc<dyn Fn() + Send + Sync>) -> Subscription {
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.next += 1;
        let id = state.next;
        state.listeners.insert(id, listener);
        let weak = Arc::downgrade(&self.0);
        Subscription::new(move || {
            if let Some(host) = weak.upgrade() {
                host.state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .listeners
                    .remove(&id);
            }
        })
    }
    pub fn attach(&self, pins: Pins) -> Result<Connection, Error> {
        if self.configuration()? != pins.configuration()
            || !identity(&pins.environment_id)
            || access::trim_units(&pins.connection_id.code_units().collect::<Vec<_>>()).is_empty()
            || crate::cca::value::utf8_len(&pins.connection_id) > 256
            || !(pins.is_current)()
        {
            return Err(Error::Unavailable);
        }
        let connection = Connection(Arc::new(ConnectionInner {
            host: self.clone(),
            pins,
            lifetime: Lifetime::new(),
            channels: Mutex::new(BTreeMap::new()),
        }));
        self.0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .connections
            .push(Arc::downgrade(&connection.0));
        connection.validate()?;
        Ok(connection)
    }
    pub fn close(&self) {
        let access_listener = self
            .0
            .access_listener
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        let event_listener = self
            .0
            .event_listener
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        drop(access_listener);
        drop(event_listener);
        let connections = {
            let mut state = self
                .0
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            state.closed = true;
            std::mem::take(&mut state.connections)
        };
        for connection in connections
            .into_iter()
            .filter_map(|connection| connection.upgrade())
        {
            Connection(connection).retire();
        }
    }
}
pub fn configuration_status(
    global: &config::Configuration,
    credentials: &credential::Service,
) -> Result<access::ConfigurationStatus, Error> {
    let selected = resolve_configuration(
        access::Preference {
            enabled: true,
            revision: 0,
        },
        global,
        credentials,
    )?;
    Ok(match selected {
        Configuration::Enabled { profile, .. } => access::ConfigurationStatus {
            ready: true,
            profile: Some(profile),
            message: None,
        },
        Configuration::Disabled => access::ConfigurationStatus {
            ready: false,
            profile: None,
            message: Some("Select one named ChatGPT profile in global Dots configuration.".into()),
        },
    })
}
fn resolve_configuration(
    preference: access::Preference,
    global: &config::Configuration,
    credentials: &credential::Service,
) -> Result<Configuration, Error> {
    let Some(profile) = global
        .native_dots_profile()
        .map_err(|_| Error::Unavailable)?
    else {
        return Ok(Configuration::Disabled);
    };
    if !preference.enabled {
        return Ok(Configuration::Disabled);
    }
    let binding = match credentials.bind("openai".into(), "openai".into(), profile.as_str().into())
    {
        Ok(binding) => binding,
        Err(credential::Error::ProfileUnavailable) => return Ok(Configuration::Disabled),
        Err(_) => return Err(Error::Unavailable),
    };
    let selected = credentials
        .resolve_binding(&binding)
        .map_err(|_| Error::Unavailable)?;
    let ycoding_schema::credential::Value::OAuth(value) =
        selected.secret().domain().map_err(|_| Error::Unavailable)?
    else {
        return Ok(Configuration::Disabled);
    };
    let Some(account_id) = authority::account(&value) else {
        return Ok(Configuration::Disabled);
    };
    Ok(Configuration::Enabled {
        access_revision: preference.revision,
        profile,
        credential_id: selected.id().to_utf8().map_err(|_| Error::Unavailable)?,
        account_id,
        account_generation: selected.account_generation(),
    })
}
fn identity(value: &str) -> bool {
    !access::trim_units(&value.encode_utf16().collect::<Vec<_>>()).is_empty() && value.len() <= 256
}
struct ConnectionInner {
    host: Host,
    pins: Pins,
    lifetime: Arc<Mutex<Lifetime>>,
    channels: Mutex<BTreeMap<ChannelAddress, Weak<ChannelInner>>>,
}
#[derive(Clone)]
pub struct Connection(Arc<ConnectionInner>);
impl Connection {
    fn validate(&self) -> Result<(), Error> {
        let active = self
            .0
            .lifetime
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .active;
        if !active
            || !(self.0.pins.is_current)()
            || self.0.host.configuration()? != self.0.pins.configuration()
        {
            return Err(Error::Unavailable);
        }
        Ok(())
    }
    pub fn channel(&self, address: ChannelAddress) -> Result<Channel, Error> {
        self.validate()?;
        if !identity(&address.client_id) || !identity(&address.stream_id) {
            return Err(Error::InvalidInput);
        }
        let mut channels = self
            .0
            .channels
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(channel) = channels.get(&address).and_then(Weak::upgrade) {
            return Ok(Channel(channel));
        }
        let channel = Channel(Arc::new(ChannelInner {
            connection: self.clone(),
            address: address.clone(),
            lifetime: Lifetime::new(),
            roots: Mutex::new(BTreeMap::new()),
        }));
        channels.insert(address, Arc::downgrade(&channel.0));
        Ok(channel)
    }
    pub fn retire(&self) {
        Lifetime::retire(&self.0.lifetime);
        let channels = std::mem::take(
            &mut *self
                .0
                .channels
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        for channel in channels
            .into_values()
            .filter_map(|channel| channel.upgrade())
        {
            Channel(channel).retire();
        }
    }
}
struct Root {
    lifetime: Arc<Mutex<Lifetime>>,
    drafts: BTreeMap<String, Draft>,
    next: u64,
}
struct Draft {
    handle: Arc<Opaque>,
    pending: Pending,
    service: Arc<Decisions>,
    stage: Stage,
    generation: u64,
}
struct Opaque;
pub struct Candidate(Arc<Opaque>);
pub struct NativeRequest {
    pub id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub questions: Vec<InputQuestion>,
    pub waiting: Waiting,
    pub handle: Candidate,
}
struct ChannelInner {
    connection: Connection,
    address: ChannelAddress,
    lifetime: Arc<Mutex<Lifetime>>,
    roots: Mutex<BTreeMap<session::Id, Root>>,
}
#[derive(Clone)]
pub struct Channel(Arc<ChannelInner>);
impl Channel {
    fn host(&self) -> &Host {
        &self.0.connection.0.host
    }
    fn gate(&self, root: Option<&session::Id>, request_id: Option<&str>) -> Result<Gate, Error> {
        self.0.connection.validate()?;
        if !self
            .0
            .lifetime
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .active
        {
            return Err(Error::Unavailable);
        }
        let mut lifetimes = vec![
            self.0.connection.0.lifetime.clone(),
            self.0.lifetime.clone(),
        ];
        if let Some(root) = root {
            let mut roots = self
                .0
                .roots
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            lifetimes.push(
                roots
                    .entry(root.clone())
                    .or_insert_with(|| Root {
                        lifetime: Lifetime::new(),
                        drafts: BTreeMap::new(),
                        next: 0,
                    })
                    .lifetime
                    .clone(),
            );
        }
        let pins = self.0.connection.0.pins.clone();
        let source = root
            .zip(request_id)
            .map(|(root, request_id)| {
                form::NativeReplySource::decode(
                    &ObjectEncoder::new()
                        .field("kind", "dots-native")
                        .field("profile", pins.profile.as_str())
                        .field("credentialID", pins.credential_id.as_str())
                        .field("accountID", pins.account_id.as_str())
                        .field("accountGeneration", &(pins.account_generation as f64))
                        .field("environmentID", pins.environment_id.as_str())
                        .field("connectionID", &pins.connection_id)
                        .field("clientID", self.0.address.client_id.as_str())
                        .field("streamID", self.0.address.stream_id.as_str())
                        .field("rootSessionID", root)
                        .field("accessRevision", &(pins.access_revision as f64))
                        .field("requestID", request_id)
                        .finish(),
                )
                .map_err(|_| Error::InvalidInput)
            })
            .transpose()?;
        Ok(Gate {
            configuration: pins.configuration(),
            global: self.host().0.options.global.clone(),
            pins,
            lifetimes,
            root: root.cloned(),
            source,
            current: None,
        })
    }
    fn validate(&self, root: Option<&session::Id>) -> Result<Gate, Error> {
        let gate = self.gate(root, None)?;
        let admitted = Admission { gate: gate.clone() };
        if admitted
            .validate(&self.host().0.options.sessions, root)
            .is_err()
        {
            if let Some(root) = root {
                self.retire_root(root);
            }
            return Err(Error::Unavailable);
        }
        Ok(gate)
    }
    fn retire_root(&self, root: &session::Id) {
        let root = self
            .0
            .roots
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(root);
        if let Some(root) = root {
            Lifetime::retire(&root.lifetime);
        }
    }
    fn session(&self, root: &session::Id) -> Result<session::Info, Error> {
        self.validate(Some(root))?;
        self.host()
            .0
            .options
            .sessions
            .get(root)
            .map_err(|_| Error::Unavailable)?
            .ok_or(Error::Unavailable)
    }
    fn catalog_visible(&self, sources: &[session::Id]) -> bool {
        sources
            .iter()
            .any(|source| self.validate(Some(source)).is_ok())
    }
    fn catalog_sessions(&self) -> Result<Vec<(session::Info, Vec<session::Id>)>, Error> {
        self.validate(None)?;
        let snapshot = self
            .host()
            .0
            .options
            .client
            .snapshot()
            .map_err(|_| Error::Unavailable)?;
        type CatalogGroup = (session::Info, Vec<session::Id>);
        let mut groups: BTreeMap<(Vec<u16>, Vec<u16>), CatalogGroup> = BTreeMap::new();
        let mut after = None;
        loop {
            let rows = snapshot
                .scan::<SessionTable>(
                    after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                    Bound::Unbounded,
                    128,
                )
                .map_err(|_| Error::Unavailable)?;
            if rows.is_empty() {
                break;
            }
            after = rows.last().map(|row| key(&row.id));
            for row in rows {
                if row
                    .parent_id
                    .as_ref()
                    .is_some_and(|parent| !parent.is_empty())
                    || row.time_archived.is_some()
                {
                    continue;
                }
                let Ok(id) = session::Id::new(row.id.clone()) else {
                    continue;
                };
                if self.validate(Some(&id)).is_err() {
                    continue;
                }
                let location = (
                    row.directory.code_units().collect::<Vec<_>>(),
                    row.workspace_id
                        .as_ref()
                        .map(|workspace| workspace.code_units().collect::<Vec<_>>())
                        .unwrap_or_default(),
                );
                match groups.entry(location) {
                    std::collections::btree_map::Entry::Vacant(entry) => {
                        let Ok(session) = info::from_row(&row) else {
                            continue;
                        };
                        entry.insert((session, vec![id]));
                    }
                    std::collections::btree_map::Entry::Occupied(mut entry) => {
                        entry.get_mut().1.push(id);
                    }
                }
            }
        }
        Ok(groups
            .into_values()
            .filter(|(_, sources)| self.catalog_visible(sources))
            .collect())
    }
    pub async fn models(&self) -> Result<Vec<Model>, Error> {
        let mut contributions = Vec::new();
        let sessions = self.catalog_sessions()?;
        if sessions.is_empty() {
            let items = self
                .host()
                .0
                .options
                .backend
                .models(self.home_location()?)
                .await?;
            self.validate(None)?;
            contributions.push((Vec::new(), items));
        }
        for (session, sources) in sessions {
            let items = self
                .host()
                .0
                .options
                .backend
                .models(session.location)
                .await?;
            contributions.push((sources, items));
        }
        let mut models: Vec<Model> = Vec::new();
        for (sources, items) in contributions {
            if !sources.is_empty() && !self.catalog_visible(&sources) {
                continue;
            }
            for model in items {
                if !models.iter().any(|item: &Model| {
                    item.id == model.id
                        && item.provider_id == model.provider_id
                        && item.profile == model.profile
                }) {
                    models.push(model);
                }
            }
        }
        self.validate(None)?;
        models.sort_by(|left, right| {
            (&left.provider_id, &left.id, &left.profile).cmp(&(
                &right.provider_id,
                &right.id,
                &right.profile,
            ))
        });
        Ok(models)
    }
    fn home_location(&self) -> Result<location::Ref, Error> {
        let home = self
            .host()
            .0
            .options
            .global
            .roots()
            .home
            .to_str()
            .ok_or(Error::Unavailable)?;
        let directory = AbsolutePath::new(home).map_err(|_| Error::Unavailable)?;
        Ok(location::Ref {
            directory,
            workspace_id: None,
        })
    }
    pub async fn default_model(&self) -> Result<Option<model::Ref>, Error> {
        let gate = self.validate(None)?;
        self.host()
            .0
            .options
            .client
            .submit(move |tx| {
                gate.with(tx, None, |tx| {
                    let value = tx.get::<KvTable>(&tuple_key(&[KeyPart::String(
                        &"dots.native.default-model".into(),
                    )]))?;
                    Ok(value.and_then(|row| {
                        row.value
                            .domain()
                            .ok()
                            .and_then(|value| model::Ref::decode(&value.into_value()).ok())
                            .and_then(|value| normalized_model(value).ok())
                    }))
                })
            })
            .map_err(|_| Error::Unavailable)?
            .await
            .map_err(|_| Error::Unavailable)
    }
    pub async fn set_default_model(&self, model: model::Ref) -> Result<model::Ref, Error> {
        let requested = normalized_model(model)?;
        let gate = self.validate(None)?;
        let mut locations = Vec::new();
        for (session, _) in self.catalog_sessions()? {
            if !locations
                .iter()
                .any(|item: &location::Ref| item.directory == session.location.directory)
            {
                locations.push(session.location);
            }
        }
        if locations.is_empty() {
            locations.push(self.home_location()?);
        }
        let mut selected = None;
        let mut first_error = None;
        for location in locations {
            self.validate(None)?;
            match self
                .host()
                .0
                .options
                .backend
                .validate_model(location, requested.clone())
                .await
            {
                Ok(model) => {
                    selected = Some(normalized_model(model)?);
                    break;
                }
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
        let selected = selected.ok_or(first_error.unwrap_or(Error::Unavailable))?;
        let value = Document::new(selected.encode()).map_err(|_| Error::InvalidInput)?;
        self.host()
            .0
            .options
            .client
            .submit(move |tx| {
                gate.with(tx, None, |tx| {
                    resources::set_kv(
                        tx,
                        &"dots.native.default-model".into(),
                        &value,
                        chrono::Utc::now().timestamp_millis(),
                    )
                })
            })
            .map_err(|_| Error::Unavailable)?
            .await
            .map_err(|_| Error::Unavailable)?;
        Ok(selected)
    }
    pub async fn select_model(
        &self,
        root: &session::Id,
        model: model::Ref,
    ) -> Result<RootSnapshot, Error> {
        let model = normalized_model(model)?;
        let session = self.session(root)?;
        let admission = Admission {
            gate: self.gate(Some(root), Some("model"))?,
        };
        admission
            .validate(&self.host().0.options.sessions, Some(root))
            .map_err(|_| Error::Unavailable)?;
        self.host()
            .0
            .options
            .backend
            .switch_model(session, model, admission)
            .await?;
        self.get_root(root).await?.ok_or(Error::Unavailable)
    }
    pub async fn skills(&self) -> Result<Vec<Skill>, Error> {
        let mut contributions = Vec::new();
        for (session, sources) in self.catalog_sessions()? {
            let items = self.host().0.options.backend.skills(session).await?;
            contributions.push((sources, items));
        }
        let mut skills: Vec<Skill> = Vec::new();
        for (sources, items) in contributions {
            if !self.catalog_visible(&sources) {
                continue;
            }
            for skill in items {
                if !skills.iter().any(|item: &Skill| item.id == skill.id) {
                    skills.push(skill);
                }
            }
        }
        self.validate(None)?;
        skills.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(skills)
    }
    pub async fn list_roots(&self) -> Result<Vec<RootSnapshot>, Error> {
        self.validate(None)?;
        let snapshot = self
            .host()
            .0
            .options
            .client
            .snapshot()
            .map_err(|_| Error::Unavailable)?;
        let mut after = None;
        let mut roots = Vec::new();
        loop {
            let rows = snapshot
                .scan::<SessionTable>(
                    after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                    Bound::Unbounded,
                    128,
                )
                .map_err(|_| Error::Unavailable)?;
            if rows.is_empty() {
                break;
            }
            after = rows.last().map(|row| key(&row.id));
            for row in rows {
                if row
                    .parent_id
                    .as_ref()
                    .is_some_and(|parent| !parent.is_empty())
                    || row.time_archived.is_some()
                {
                    continue;
                }
                let Ok(id) = session::Id::new(row.id) else {
                    continue;
                };
                match self.get_root(&id).await {
                    Ok(Some(root)) => roots.push(root),
                    Ok(None) => {}
                    Err(_) => {
                        if let Ok(session) = self.session(&id) {
                            tracing::warn!(
                                session_id = %id.as_lossless().to_utf8().unwrap_or_default(),
                                "Native Session snapshot failed"
                            );
                            roots.push(RootSnapshot {
                                session,
                                selected_model: None,
                                active: false,
                                waiting: Vec::new(),
                                snapshot_error: true,
                            });
                        }
                    }
                }
            }
        }
        self.validate(None)?;
        Ok(roots)
    }
    pub async fn get_root(&self, root: &session::Id) -> Result<Option<RootSnapshot>, Error> {
        self.validate(None)?;
        let session = match self.session(root) {
            Ok(session) => session,
            Err(Error::Unavailable) => {
                self.validate(None)?;
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        let selected_model = self
            .host()
            .0
            .options
            .backend
            .selected_model(session.clone())
            .await?;
        let pending = self.pending(root).await?;
        let waiting = pending.iter().fold(Vec::new(), |mut waiting, item| {
            if !waiting.contains(&item.waiting) {
                waiting.push(item.waiting.clone());
            }
            waiting
        });
        let active = self.host().0.options.backend.active(root);
        self.validate(Some(root))?;
        Ok(Some(RootSnapshot {
            session,
            selected_model,
            active,
            waiting,
            snapshot_error: false,
        }))
    }
    pub async fn read_root(&self, root: &session::Id) -> Result<RootRead, Error> {
        let root_snapshot = self.get_root(root).await?.ok_or(Error::Unavailable)?;
        let messages = self
            .host()
            .0
            .options
            .sessions
            .context(root)
            .map_err(|_| Error::Unavailable)?;
        self.validate(Some(root))?;
        Ok(RootRead {
            root: root_snapshot,
            messages,
        })
    }
    pub async fn create_root(
        &self,
        input_id: &str,
        directory: &str,
        title: Option<&str>,
        model: Option<model::Ref>,
    ) -> Result<RootSnapshot, Error> {
        if !identity(input_id) {
            return Err(Error::InvalidInput);
        }
        let location = location::Ref {
            directory: AbsolutePath::new(directory).map_err(|_| Error::InvalidInput)?,
            workspace_id: None,
        };
        let gate = self.validate(None)?;
        let model = match model {
            Some(model) => Some(normalized_model(
                self.host()
                    .0
                    .options
                    .backend
                    .validate_model(location, normalized_model(model)?)
                    .await?,
            )?),
            None => None,
        };
        let pins = &gate.pins;
        let digest = sessions::prompt_cache::sha256(&format!(
            "{}\0{}\0{}\0{}\0{}\0{}\0{}",
            pins.profile,
            pins.credential_id,
            pins.account_id,
            pins.account_generation,
            self.0.address.client_id,
            self.0.address.stream_id,
            input_id
        ));
        let id =
            session::Id::new(format!("ses_{}", &digest[..32])).map_err(|_| Error::InvalidInput)?;
        let result_id = id.clone();
        let directory = directory.to_owned();
        let title = title.unwrap_or("Native Session").to_owned();
        self.host()
            .0
            .options
            .client
            .submit(move |tx| {
                gate.with(tx, None, |tx| {
                    if let Some(existing) = tx.get::<SessionTable>(&key(id.as_lossless()))? {
                        if existing.parent_id.is_some()
                            || existing.directory.as_str() != Some(directory.as_str())
                        {
                            return Err(authority::unavailable());
                        }
                        return Ok(());
                    }
                    let directories =
                        tx.scan::<DirectoryTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)?;
                    let projects =
                        tx.scan::<ProjectTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)?;
                    let project_id = projects
                        .iter()
                        .find(|project| {
                            project.worktree.as_str() == Some(&directory)
                                || directories.iter().any(|entry| {
                                    entry.project_id == project.id
                                        && entry.directory.as_str() == Some(&directory)
                                })
                        })
                        .map(|project| project.id.clone())
                        .ok_or_else(authority::unavailable)?;
                    let now = chrono::Utc::now().timestamp_millis();
                    sessions::projector::append(
                        tx,
                        &NewEvent {
                            id: sessions::projector::random_event_id()?
                                .as_lossless()
                                .clone(),
                            aggregate_id: id.as_lossless().clone(),
                            created: now,
                            type_: "session.created.2".into(),
                            data: ObjectEncoder::new()
                                .field("sessionID", &id)
                                .field("projectID", &project_id)
                                .field(
                                    "location",
                                    &ObjectEncoder::new()
                                        .field("directory", directory.as_str())
                                        .finish(),
                                )
                                .field("title", title.as_str())
                                .optional("model", &model)
                                .field("origin", &session::Origin::DotsExecutor)
                                .field("created", &(now as f64))
                                .finish(),
                        },
                    )
                    .map(|_| ())
                })
            })
            .map_err(|_| Error::Unavailable)?
            .await
            .map_err(|_| Error::Unavailable)?;
        self.get_root(&result_id).await?.ok_or(Error::Unavailable)
    }
    pub fn profile(&self) -> Result<String, Error> {
        self.validate(None)?;
        Ok(self.0.connection.0.pins.profile.clone())
    }
    pub async fn rename_root(&self, root: &session::Id, title: &str) -> Result<(), Error> {
        if access::trim_units(&title.encode_utf16().collect::<Vec<_>>()).is_empty() {
            return Err(Error::InvalidInput);
        }
        let gate = self.validate(Some(root))?;
        let root = root.clone();
        let title = LosslessString::from(title);
        self.host()
            .0
            .options
            .client
            .submit(move |tx| {
                gate.with(tx, Some(&root), |tx| {
                    sessions::projector::append(
                        tx,
                        &NewEvent {
                            id: sessions::projector::random_event_id()?
                                .as_lossless()
                                .clone(),
                            aggregate_id: root.as_lossless().clone(),
                            created: chrono::Utc::now().timestamp_millis(),
                            type_: "session.renamed.1".into(),
                            data: ObjectEncoder::new()
                                .field("sessionID", &root)
                                .field("title", &title)
                                .finish(),
                        },
                    )
                    .map(|_| ())
                })
            })
            .map_err(|_| Error::Unavailable)?
            .await
            .map_err(|_| Error::Unavailable)
    }
    pub async fn archive_root(&self, root: &session::Id) -> Result<(), Error> {
        let gate = self.validate(Some(root))?;
        let target = root.clone();
        self.host()
            .0
            .options
            .client
            .submit(move |tx| {
                gate.with(tx, Some(&target), |tx| {
                    sessions::projector::append(
                        tx,
                        &NewEvent {
                            id: sessions::projector::random_event_id()?
                                .as_lossless()
                                .clone(),
                            aggregate_id: target.as_lossless().clone(),
                            created: chrono::Utc::now().timestamp_millis(),
                            type_: "session.archived.2".into(),
                            data: ObjectEncoder::new().field("sessionID", &target).finish(),
                        },
                    )
                    .map(|_| ())
                })
            })
            .map_err(|_| Error::Unavailable)?
            .await
            .map_err(|_| Error::Unavailable)?;
        self.retire_root(root);
        Ok(())
    }
    pub async fn unarchive_root(&self, root: &session::Id) -> Result<RootSnapshot, Error> {
        let gate = self.gate(Some(root), None)?;
        let target = root.clone();
        self.host()
            .0
            .options
            .client
            .submit(move |tx| {
                gate.with(tx, None, |tx| {
                    let row = tx
                        .get::<SessionTable>(&key(target.as_lossless()))?
                        .ok_or_else(authority::unavailable)?;
                    if row
                        .parent_id
                        .as_ref()
                        .is_some_and(|parent| !parent.is_empty())
                        || tx
                            .get::<SequenceTable>(&key(target.as_lossless()))?
                            .is_some_and(|sequence| sequence.owner_id.is_some())
                    {
                        return Err(authority::unavailable());
                    }
                    if row.time_archived.is_none() {
                        return Ok(());
                    }
                    sessions::projector::append(
                        tx,
                        &NewEvent {
                            id: sessions::projector::random_event_id()?
                                .as_lossless()
                                .clone(),
                            aggregate_id: target.as_lossless().clone(),
                            created: chrono::Utc::now().timestamp_millis(),
                            type_: "session.unarchived.2".into(),
                            data: ObjectEncoder::new().field("sessionID", &target).finish(),
                        },
                    )
                    .map(|_| ())
                })
            })
            .map_err(|_| Error::Unavailable)?
            .await
            .map_err(|_| Error::Unavailable)?;
        self.get_root(root).await?.ok_or(Error::Unavailable)
    }
    pub async fn remove_root(&self, root: &session::Id) -> Result<(), Error> {
        let gate = self.gate(Some(root), None)?;
        let admission = Admission { gate: gate.clone() };
        admission
            .validate(&self.host().0.options.sessions, Some(root))
            .map_err(|_| Error::Unavailable)?;
        let lease: Arc<dyn RemovalLease> = Arc::from(
            self.host()
                .0
                .options
                .backend
                .retire_root(root.clone(), admission)
                .await?,
        );
        let held = lease.clone();
        let target = root.clone();
        self.host()
            .0
            .options
            .client
            .submit(move |tx| {
                gate.with(tx, None, |tx| {
                    let row = tx
                        .get::<SessionTable>(&key(target.as_lossless()))?
                        .ok_or_else(authority::unavailable)?;
                    if row
                        .parent_id
                        .as_ref()
                        .is_some_and(|parent| !parent.is_empty())
                    {
                        return Err(authority::unavailable());
                    }
                    let members = {
                        let mut reader = sessions::family::Reader::Transaction(&mut *tx);
                        sessions::family::members(&mut reader, target.as_lossless())?
                    };
                    let expected: BTreeSet<_> = held
                        .members()
                        .iter()
                        .map(|member| member.as_lossless().clone())
                        .collect();
                    let current: BTreeSet<_> = members.iter().cloned().collect();
                    if !held.is_current() || current != expected {
                        return Err(authority::unavailable());
                    }
                    for member in &members {
                        if tx.get::<SessionTable>(&key(member))?.is_none()
                            || tx
                                .get::<SequenceTable>(&key(member))?
                                .is_some_and(|sequence| sequence.owner_id.is_some())
                        {
                            return Err(authority::unavailable());
                        }
                    }
                    let created = chrono::Utc::now().timestamp_millis();
                    for member in members.iter().rev() {
                        sessions::projector::append(
                            tx,
                            &NewEvent {
                                id: sessions::projector::random_event_id()?
                                    .as_lossless()
                                    .clone(),
                                aggregate_id: member.clone(),
                                created,
                                type_: "session.deleted.2".into(),
                                data: ObjectEncoder::new().field("sessionID", member).finish(),
                            },
                        )?;
                    }
                    Ok(())
                })
            })
            .map_err(|_| Error::Unavailable)?
            .await
            .map_err(|_| Error::Unavailable)?;
        drop(lease);
        self.retire_root(root);
        Ok(())
    }
    pub async fn subscribe_escalations(
        &self,
        listener: EscalationListener,
    ) -> Result<Subscription, Error> {
        self.validate(None)?;
        let stopped = Arc::new(AtomicBool::new(false));
        let notify: EscalationListener = {
            let stopped = stopped.clone();
            Arc::new(move |root: &session::Id| {
                if !stopped.load(Ordering::Acquire) {
                    listener(root);
                }
            })
        };
        let weak = Arc::downgrade(&self.0);
        let failed = weak.clone();
        let observed = notify.clone();
        let subscription = self.host().0.options.backend.subscribe(
            Arc::new(move |item| {
                let Some(channel) = weak.upgrade().map(Channel) else {
                    return;
                };
                if let Some(owner) = escalation_owner(item) {
                    channel.escalate(&owner, &observed);
                }
            }),
            Arc::new(move || {
                if let Some(channel) = failed.upgrade() {
                    Channel(channel).retire();
                }
            }),
        )?;
        let shared = Arc::new(Mutex::new(Some(subscription)));
        let owned = shared.clone();
        let fenced = stopped.clone();
        {
            let mut lifetime = self
                .0
                .lifetime
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if !lifetime.active {
                return Err(Error::Unavailable);
            }
            lifetime.stops.push(Box::new(move || {
                fenced.store(true, Ordering::Release);
                let stopped = owned
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .take();
                drop(stopped);
            }));
        }
        let stop = Subscription::new(move || {
            stopped.store(true, Ordering::Release);
            let stopped = shared
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take();
            drop(stopped);
        });
        let roots = match self.list_roots().await {
            Ok(roots) => roots,
            Err(error) => {
                stop.stop();
                return Err(error);
            }
        };
        for root in roots.iter().filter(|root| !root.waiting.is_empty()) {
            notify(&root.session.id);
        }
        if self.validate(None).is_err() {
            stop.stop();
            return Err(Error::Unavailable);
        }
        Ok(stop)
    }
    fn escalate(&self, owner: &session::Id, notify: &EscalationListener) {
        let Ok(snapshot) = self.host().0.options.client.snapshot() else {
            return;
        };
        let Ok(Some(root)) = sessions::family::root(
            &mut sessions::family::Reader::Snapshot(&snapshot),
            owner.as_lossless(),
        ) else {
            return;
        };
        let Ok(root) = session::Id::new(root) else {
            return;
        };
        if self.validate(Some(&root)).is_err() {
            return;
        }
        if root.as_lossless() != owner.as_lossless() {
            let Ok(gate) = self.gate(Some(&root), None) else {
                return;
            };
            if (Admission { gate })
                .validate(&self.host().0.options.sessions, Some(owner))
                .is_err()
            {
                return;
            }
        }
        notify(&root);
    }
    pub async fn prompt(
        &self,
        root: &session::Id,
        input_id: &str,
        text: &str,
        delivery: &str,
        model: Option<model::Ref>,
    ) -> Result<session_message::Id, Error> {
        if !identity(input_id)
            || access::trim_units(&text.encode_utf16().collect::<Vec<_>>()).is_empty()
            || !matches!(delivery, "steer" | "queue")
        {
            return Err(Error::InvalidInput);
        }
        let session = self.session(root)?;
        let digest = sessions::prompt_cache::sha256(&format!(
            "{}\0{}\0{}\0{}",
            ycoding_schema::stringify_json(&root.encode()),
            self.0.address.client_id,
            self.0.address.stream_id,
            input_id
        ));
        let id = session_message::Id::new(format!("msg_{}", &digest[..32]))
            .map_err(|_| Error::InvalidInput)?;
        let gate = self.gate(Some(root), Some(input_id))?;
        if let Some(model) = model {
            let model = normalized_model(model)?;
            let current = self
                .host()
                .0
                .options
                .backend
                .selected_model(session.clone())
                .await?;
            let admission = Admission { gate: gate.clone() };
            admission
                .validate(&self.host().0.options.sessions, Some(root))
                .map_err(|_| Error::Unavailable)?;
            if current.as_ref() != Some(&model) {
                self.host()
                    .0
                    .options
                    .backend
                    .switch_model(session, model, admission)
                    .await?;
            }
            self.validate(Some(root))?;
        }
        let input = session_pending::Message::decode(
            &ObjectEncoder::new()
                .field("type", "user")
                .field("delivery", delivery)
                .field("data", &ObjectEncoder::new().field("text", text).finish())
                .finish(),
        )
        .map_err(|_| Error::InvalidInput)?;
        self.host()
            .0
            .options
            .backend
            .prompt(
                pending::Request {
                    id: id.clone(),
                    session_id: root.clone(),
                    input,
                    event_id: sessions::projector::random_event_id()
                        .map_err(|_| Error::Unavailable)?,
                    created: chrono::Utc::now().timestamp_millis(),
                },
                Admission { gate },
            )
            .await?;
        Ok(id)
    }
    pub async fn interrupt(&self, root: &session::Id) -> Result<(), Error> {
        self.session(root)?;
        self.host().0.options.backend.interrupt(root.clone()).await
    }
    pub async fn pending(&self, root: &session::Id) -> Result<Vec<NativeRequest>, Error> {
        self.session(root)?;
        let snapshot = self
            .host()
            .0
            .options
            .client
            .snapshot()
            .map_err(|_| Error::Unavailable)?;
        let mut after = None;
        let mut pending = Vec::new();
        loop {
            let rows = snapshot
                .scan::<SessionTable>(
                    after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                    Bound::Unbounded,
                    128,
                )
                .map_err(|_| Error::Unavailable)?;
            if rows.is_empty() {
                break;
            }
            after = rows.last().map(|row| key(&row.id));
            for row in rows {
                let Ok(owner) = session::Id::new(row.id.clone()) else {
                    continue;
                };
                let gate = self.gate(Some(root), None)?;
                if (Admission { gate })
                    .validate(&self.host().0.options.sessions, Some(&owner))
                    .is_err()
                {
                    continue;
                }
                let service = self
                    .host()
                    .0
                    .options
                    .backend
                    .decisions(info::from_row(&row).map_err(|_| Error::Unavailable)?)
                    .await?;
                for item in service.pending(&owner)? {
                    pending.push((item, service.clone()));
                }
            }
        }
        self.validate(Some(root))?;
        let mut roots = self
            .0
            .roots
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let root_state = roots.get_mut(root).ok_or(Error::Unavailable)?;
        let mut drafts = std::mem::take(&mut root_state.drafts);
        let mut result = Vec::new();
        for (item, service) in pending {
            let key = item.id.clone();
            let draft = drafts
                .remove(&key)
                .filter(|draft| {
                    draft.pending.fingerprint == item.fingerprint
                        && draft.service.identity() == service.identity()
                })
                .unwrap_or_else(|| {
                    root_state.next += 1;
                    Draft {
                        handle: Arc::new(Opaque),
                        stage: item.stage.clone(),
                        pending: item,
                        service,
                        generation: root_state.next,
                    }
                });
            result.push(native_request(root, &key, &draft)?);
            root_state.drafts.insert(key, draft);
        }
        Ok(result)
    }
    pub async fn settle(&self, candidate: &Candidate, answers: &Answers) -> Result<(), Error> {
        self.validate(None)?;
        let found = {
            let roots = self
                .0
                .roots
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            roots.iter().find_map(|(root, state)| {
                state.drafts.iter().find_map(|(key, draft)| {
                    Arc::ptr_eq(&draft.handle, &candidate.0).then(|| (root.clone(), key.clone()))
                })
            })
        }
        .ok_or(Error::InvalidInput)?;
        let gate = self.gate(Some(&found.0), Some(&found.1))?;
        let (service, pending, answer) = {
            let mut roots = self
                .0
                .roots
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let root = roots.get_mut(&found.0).ok_or(Error::Unavailable)?;
            let draft = root
                .drafts
                .get_mut(&found.1)
                .filter(|draft| Arc::ptr_eq(&draft.handle, &candidate.0))
                .ok_or(Error::InvalidInput)?;
            if !draft.service.current(&draft.pending)? {
                root.drafts.remove(&found.1);
                return Err(Error::InvalidInput);
            }
            let answer = match draft.stage.read(answers)? {
                Read::Next(stage) => {
                    (Admission { gate })
                        .validate(
                            &self.host().0.options.sessions,
                            Some(&draft.pending.session_id),
                        )
                        .map_err(|_| Error::Unavailable)?;
                    draft.stage = stage;
                    draft.handle = Arc::new(Opaque);
                    root.next += 1;
                    draft.generation = root.next;
                    return Ok(());
                }
                Read::Answer(value) => Some(value),
                Read::Cancel => None,
            };
            (draft.service.clone(), draft.pending.clone(), answer)
        };
        service.settle(pending, gate, answer).await?;
        let mut roots = self
            .0
            .roots
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(root) = roots.get_mut(&found.0)
            && root
                .drafts
                .get(&found.1)
                .is_some_and(|draft| Arc::ptr_eq(&draft.handle, &candidate.0))
        {
            root.drafts.remove(&found.1);
        }
        Ok(())
    }
    pub fn subscribe(
        &self,
        root: &session::Id,
        listener: Listener,
        on_retire: Option<Box<dyn FnOnce() + Send>>,
    ) -> Result<Subscription, Error> {
        let gate = self.validate(Some(root))?;
        let services = self.host().0.options.sessions.clone();
        let root_id = root.clone();
        let gate_for_events = gate.clone();
        let weak = Arc::downgrade(&self.0);
        let event_root = root.clone();
        let failed = Arc::downgrade(&self.0);
        let failed_root = root.clone();
        let subscription = self.host().0.options.backend.subscribe(
            Arc::new(move |item| {
                let Some(channel) = weak.upgrade().map(Channel) else {
                    return;
                };
                if channel.validate(Some(&event_root)).is_err() {
                    channel.retire_root(&event_root);
                    return;
                }
                let owner = match &item.payload {
                    event_feed::Payload::Durable(event) => {
                        session::Id::new(event.aggregate_id.clone()).ok()
                    }
                    event_feed::Payload::Ephemeral(event) => event.session.clone(),
                };
                let Some(owner) = owner else {
                    return;
                };
                if (Admission {
                    gate: gate_for_events.clone(),
                })
                .validate(&services, Some(&owner))
                .is_ok()
                {
                    listener(item);
                }
            }),
            Arc::new(move || {
                if let Some(channel) = failed.upgrade() {
                    Channel(channel).retire_root(&failed_root);
                }
            }),
        )?;
        let shared = Arc::new(Mutex::new(Some(subscription)));
        let owned = shared.clone();
        let lifetime = gate.lifetimes.last().ok_or(Error::Unavailable)?;
        {
            let mut lifetime = lifetime.lock().unwrap_or_else(|error| error.into_inner());
            if !lifetime.active {
                return Err(Error::Unavailable);
            }
            lifetime.stops.push(Box::new(move || {
                let stopped = owned
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .take();
                drop(stopped);
                if let Some(on_retire) = on_retire {
                    on_retire();
                }
            }));
        }
        self.validate(Some(&root_id))?;
        Ok(Subscription::new(move || {
            let stopped = shared
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take();
            drop(stopped);
        }))
    }
    pub fn retire(&self) {
        Lifetime::retire(&self.0.lifetime);
        let roots = std::mem::take(
            &mut *self
                .0
                .roots
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        for root in roots.into_values() {
            Lifetime::retire(&root.lifetime);
        }
    }
}
fn normalized_model(value: model::Ref) -> Result<model::Ref, Error> {
    let value = model::Ref::decode(&value.encode()).map_err(|_| Error::InvalidInput)?;
    let nonempty = |value: &LosslessString| {
        !access::trim_units(&value.code_units().collect::<Vec<_>>()).is_empty()
    };
    if !nonempty(&value.provider_id.0)
        || !nonempty(&value.id)
        || value
            .profile
            .as_ref()
            .is_some_and(|profile| !nonempty(&profile.0))
        || value
            .variant
            .as_ref()
            .is_some_and(|variant| !nonempty(variant))
    {
        return Err(Error::InvalidInput);
    }
    Ok(value)
}
const ESCALATION_TYPES: [&str; 30] = [
    "permission.asked",
    "permission.replied",
    "permission.deferred",
    "permission.cancelled",
    "guardrail.asked",
    "guardrail.replied",
    "guardrail.decided",
    "guardrail.deferred",
    "guardrail.cancelled",
    "question.asked",
    "question.replied",
    "question.rejected",
    "question.timed_out",
    "question.deferred",
    "form.created",
    "form.replied",
    "form.cancelled",
    "form.timed_out",
    "form.deferred",
    "form.assessed",
    "session.review.deferred",
    "session.review.decided",
    "session.review.withdrawn",
    "session.review.consumed",
    "session.task.updated",
    "session.guardrail.escalated",
    "session.guardrail.decided",
    "session.guardrail.dismissed",
    "session.permission.assessed",
    "session.unarchived",
];
fn base_type(name: &str) -> &str {
    match name.rsplit_once('.') {
        Some((base, version))
            if !version.is_empty() && version.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            base
        }
        _ => name,
    }
}
fn escalation_owner(item: &event_feed::Item) -> Option<session::Id> {
    match &item.payload {
        event_feed::Payload::Durable(event) => {
            if !ESCALATION_TYPES.contains(&base_type(event.type_.as_str()?)) {
                return None;
            }
            session::Id::new(event.aggregate_id.clone()).ok()
        }
        event_feed::Payload::Ephemeral(event) => {
            if !ESCALATION_TYPES.contains(&event.data.name()) {
                return None;
            }
            event.session.clone().or_else(|| {
                let JsonValue::Object(data) = event.data.encode() else {
                    return None;
                };
                let session_of = |value: Option<&JsonValue>| match value {
                    Some(JsonValue::String(value)) => session::Id::new(value.clone()).ok(),
                    _ => None,
                };
                session_of(data.get(&"sessionID".into()))
                    .or_else(|| session_of(data.get(&"rootSessionID".into())))
                    .or_else(|| match data.get(&"form".into()) {
                        Some(JsonValue::Object(form)) => session_of(form.get(&"sessionID".into())),
                        _ => None,
                    })
            })
        }
    }
}
fn native_request(root: &session::Id, key: &str, draft: &Draft) -> Result<NativeRequest, Error> {
    Ok(NativeRequest {
        id: key.into(),
        thread_id: root
            .as_lossless()
            .to_utf8()
            .map_err(|_| Error::Unavailable)?,
        turn_id: draft.pending.turn_id.clone(),
        item_id: format!("{key}:{}", draft.generation),
        questions: draft.stage.questions.clone(),
        waiting: draft.pending.waiting.clone(),
        handle: Candidate(draft.handle.clone()),
    })
}
