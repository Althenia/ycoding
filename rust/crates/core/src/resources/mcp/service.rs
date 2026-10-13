use super::{
    client::{Connection, Error, Hooks, Notification, ToolResult},
    configuration::{self, Definitions},
    instructions,
};
use crate::resources::{auth::integration, config::Entry};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::{
    sync::{broadcast, watch},
    task::JoinSet,
};
use ycoding_schema::{
    LosslessString, connection,
    mcp::{ServerConfig, Status},
    mcp_skill,
};

#[derive(Clone, Debug)]
pub struct ServerInfo {
    pub name: String,
    pub status: Status,
    pub integration_id: Option<LosslessString>,
    pub connection: Option<connection::Info>,
}
#[derive(Clone, Debug)]
pub struct Tool {
    pub server: String,
    pub codemode: Option<bool>,
    pub definition: Value,
}
#[derive(Clone, Debug)]
pub enum Event {
    StatusChanged(String),
    ToolsChanged(String),
    ResourcesChanged(String),
    PromptsChanged(String),
    Log { server: String, params: Value },
}
#[derive(Clone)]
struct View {
    status: Status,
    tools: Vec<Tool>,
    prompts: Vec<Value>,
    instructions: Option<String>,
}
struct State {
    config: ServerConfig,
    client: Option<Arc<Connection>>,
    removed: bool,
    registration: Option<integration::Registration>,
}
#[derive(Clone, Default)]
struct Authentication {
    integration_id: Option<LosslessString>,
}
struct Slot {
    state: tokio::sync::Mutex<State>,
    view: watch::Sender<View>,
    ready: watch::Sender<bool>,
    authentication: watch::Sender<Authentication>,
}
struct Inner {
    event_source: crate::event_feed::EventSource,
    definitions: Definitions,
    slots: Mutex<BTreeMap<String, Arc<Slot>>>,
    directory: PathBuf,
    version: String,
    environment: BTreeMap<String, String>,
    hooks: Hooks,
    events: broadcast::Sender<Event>,
    tasks: Mutex<JoinSet<()>>,
    closed: AtomicBool,
}
pub struct Service(Arc<Inner>);

impl Service {
    pub fn bind_events(
        &self,
        feed: crate::event_feed::Feed,
        location: Option<ycoding_schema::location::Ref>,
    ) -> Result<(), String> {
        self.0.event_source.bind(feed, location)
    }
    pub fn new(
        entries: &[Entry],
        directory: PathBuf,
        version: String,
        environment: BTreeMap<String, String>,
        hooks: Hooks,
    ) -> Result<Self, Error> {
        let definitions = configuration::from_entries(entries)
            .map_err(|_| Error::Connect("Invalid MCP configuration".into()))?;
        let (events, _) = broadcast::channel(256);
        let mut slots = BTreeMap::new();
        for (name, config) in &definitions.servers {
            let name = name
                .to_utf8()
                .map_err(|_| Error::Connect("Invalid MCP server name".into()))?;
            let (authentication, registration) = registration(&name, config, &hooks)?;
            slots.insert(name, slot(config.clone(), authentication, registration));
        }
        let service = Self(Arc::new(Inner {
            event_source: hooks.event_source.clone(),
            definitions,
            slots: Mutex::new(slots),
            directory,
            version,
            environment,
            hooks,
            events,
            tasks: Mutex::new(JoinSet::new()),
            closed: AtomicBool::new(false),
        }));
        if let Some(registry) = &service.0.hooks.integrations {
            let mut events = registry.subscribe();
            let owner = Arc::downgrade(&service.0);
            service.0.spawn(async move {
                loop {
                    let event = match events.recv().await {
                        Ok(integration::Event::ConnectionUpdated(id)) => Some(id),
                        Ok(integration::Event::Updated) => continue,
                        Err(broadcast::error::RecvError::Closed) => return,
                        Err(broadcast::error::RecvError::Lagged(_)) => None,
                    };
                    let Some(inner) = owner.upgrade() else {
                        return;
                    };
                    let Ok(slots) = inner.slots.lock().map(|slots| {
                        slots
                            .iter()
                            .filter_map(|(name, slot)| {
                                let id = slot.authentication.borrow().integration_id.clone()?;
                                (event.as_ref().is_none_or(|event| event == &id)).then_some((
                                    name.clone(),
                                    slot.clone(),
                                    id,
                                ))
                            })
                            .collect::<Vec<_>>()
                    }) else {
                        return;
                    };
                    for (name, slot, id) in slots {
                        let owner = Arc::downgrade(&inner);
                        if inner
                            .spawn(async move {
                                let Some(inner) = owner.upgrade() else {
                                    return;
                                };
                                let mut state = slot.state.lock().await;
                                if state.removed
                                    || slot.authentication.borrow().integration_id.as_ref()
                                        != Some(&id)
                                    || slot.view.borrow().status == Status::Disabled
                                {
                                    return;
                                }
                                if let Err(error) = stop(&inner, &name, &slot, &mut state).await {
                                    slot.view.send_replace(empty_view(Status::Failed(
                                        error.to_string().into(),
                                    )));
                                    inner.publish(Event::StatusChanged(name));
                                    return;
                                }
                                start(&inner, &name, &slot, &mut state).await;
                            })
                            .is_err()
                        {
                            return;
                        }
                    }
                }
            })?;
        }
        for (name, slot) in service.slots()? {
            if slot.view.borrow().status != Status::Disabled {
                let inner = Arc::downgrade(&service.0);
                service.0.spawn(async move {
                    if let Some(inner) = inner.upgrade() {
                        let mut state = slot.state.lock().await;
                        start(&inner, &name, &slot, &mut state).await;
                    }
                })?;
            }
        }
        Ok(service)
    }
    fn slots(&self) -> Result<Vec<(String, Arc<Slot>)>, Error> {
        Ok(self
            .0
            .slots
            .lock()
            .map_err(|_| Error::Closed)?
            .iter()
            .map(|(name, slot)| (name.clone(), slot.clone()))
            .collect())
    }
    fn require(&self, name: &str) -> Result<Arc<Slot>, Error> {
        if self.0.closed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        self.0
            .slots
            .lock()
            .map_err(|_| Error::Closed)?
            .get(name)
            .cloned()
            .ok_or_else(|| Error::NotFound(name.into()))
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.0.events.subscribe()
    }
    pub fn servers(&self) -> Result<Vec<ServerInfo>, Error> {
        let mut servers = self
            .slots()?
            .into_iter()
            .map(|(name, slot)| {
                let integration_id = slot.authentication.borrow().integration_id.clone();
                let connection = match (&integration_id, &self.0.hooks.integrations) {
                    (Some(id), Some(registry)) => {
                        registry.active(id).map_err(|_| Error::Storage)?
                    }
                    _ => None,
                };
                Ok(ServerInfo {
                    name,
                    status: slot.view.borrow().status.clone(),
                    integration_id,
                    connection,
                })
            })
            .collect::<Result<Vec<_>, Error>>()?;
        servers.sort_by(|a, b| compare(&a.name, &b.name));
        Ok(servers)
    }
    pub async fn add(&self, name: &str, config: ServerConfig) -> Result<(), Error> {
        if self.0.closed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        let config = self.0.definitions.resolve(config);
        let slot = {
            let mut slots = self.0.slots.lock().map_err(|_| Error::Closed)?;
            if !slots.contains_key(name) {
                slots.insert(
                    name.into(),
                    slot(config.clone(), Authentication::default(), None),
                );
            }
            slots.get(name).expect("inserted MCP slot").clone()
        };
        let mut state = slot.state.lock().await;
        stop(&self.0, name, &slot, &mut state).await?;
        if let Some(registration) = state.registration.take() {
            registration.dispose().map_err(|_| Error::Storage)?;
        }
        state.config = config;
        state.removed = false;
        slot.ready.send_replace(false);
        let registered = registration(name, &state.config, &self.0.hooks);
        match registered {
            Ok((authentication, registration)) => {
                slot.authentication.send_replace(authentication);
                state.registration = registration;
            }
            Err(error) => {
                slot.authentication.send_replace(Authentication::default());
                slot.view
                    .send_replace(empty_view(Status::Failed(error.to_string().into())));
                slot.ready.send_replace(true);
                self.0.publish(Event::StatusChanged(name.into()));
                return Err(error);
            }
        }
        if disabled(&state.config) {
            slot.view.send_replace(empty_view(Status::Disabled));
            slot.ready.send_replace(true);
            self.0.publish(Event::StatusChanged(name.into()));
            return Ok(());
        }
        start(&self.0, name, &slot, &mut state).await;
        Ok(())
    }
    pub async fn connect(&self, name: &str) -> Result<(), Error> {
        let slot = self.require(name)?;
        let mut state = slot.state.lock().await;
        if state.removed {
            return Err(Error::NotFound(name.into()));
        }
        stop(&self.0, name, &slot, &mut state).await?;
        start(&self.0, name, &slot, &mut state).await;
        Ok(())
    }
    pub async fn disconnect(&self, name: &str) -> Result<(), Error> {
        let slot = self.require(name)?;
        let mut state = slot.state.lock().await;
        if state.removed {
            return Err(Error::NotFound(name.into()));
        }
        stop(&self.0, name, &slot, &mut state).await?;
        slot.view.send_replace(empty_view(Status::Disabled));
        self.0.publish(Event::StatusChanged(name.into()));
        slot.ready.send_replace(true);
        Ok(())
    }
    pub async fn remove(&self, name: &str) -> Result<(), Error> {
        let slot = self.require(name)?;
        let mut state = slot.state.lock().await;
        if state.removed {
            return Err(Error::NotFound(name.into()));
        }
        stop(&self.0, name, &slot, &mut state).await?;
        state.removed = true;
        if let Some(registration) = state.registration.take() {
            registration.dispose().map_err(|_| Error::Storage)?;
        }
        slot.authentication.send_replace(Authentication::default());
        slot.ready.send_replace(true);
        self.0.slots.lock().map_err(|_| Error::Closed)?.remove(name);
        self.0.publish(Event::StatusChanged(name.into()));
        Ok(())
    }
    pub async fn tools(&self) -> Result<Vec<Tool>, Error> {
        let slots = self.slots()?;
        for (_, slot) in &slots {
            ready(slot).await?;
        }
        let mut tools = slots
            .iter()
            .flat_map(|(_, slot)| slot.view.borrow().tools.clone())
            .collect::<Vec<_>>();
        tools.sort_by(|a, b| {
            a.server.cmp(&b.server).then_with(|| {
                a.definition["name"]
                    .as_str()
                    .cmp(&b.definition["name"].as_str())
            })
        });
        Ok(tools)
    }
    pub fn prompts(&self) -> Vec<Value> {
        self.slots()
            .map(|slots| {
                slots
                    .iter()
                    .flat_map(|(_, slot)| slot.view.borrow().prompts.clone())
                    .collect()
            })
            .unwrap_or_default()
    }
    pub async fn instructions(&self) -> Result<Vec<instructions::Summary>, Error> {
        let slots = self.slots()?;
        for (_, slot) in &slots {
            ready(slot).await?;
        }
        Ok(slots
            .iter()
            .filter_map(|(name, slot)| {
                slot.view
                    .borrow()
                    .instructions
                    .as_ref()
                    .map(|instructions| instructions::Summary {
                        server: name.clone().into(),
                        instructions: instructions.clone().into(),
                    })
            })
            .collect())
    }
    async fn client(&self, name: &str) -> Result<Option<Arc<Connection>>, Error> {
        let slot = self.require(name)?;
        ready(&slot).await?;
        let state = slot.state.lock().await;
        if state.removed {
            return Err(Error::NotFound(name.into()));
        }
        Ok(state.client.clone())
    }
    pub async fn call_tool(
        &self,
        server: &str,
        name: &str,
        args: Value,
        signal: Option<watch::Receiver<bool>>,
    ) -> Result<ToolResult, Error> {
        self.client(server)
            .await?
            .ok_or_else(|| Error::Connect("MCP server is not connected".into()))?
            .call_tool(name, args, signal)
            .await
    }
    pub async fn prompt(
        &self,
        server: &str,
        name: &str,
        args: Value,
        signal: Option<watch::Receiver<bool>>,
    ) -> Result<Option<Value>, Error> {
        let Some(client) = self.client(server).await? else {
            return Ok(None);
        };
        match client.prompt(name, args, signal).await {
            Ok(value) => Ok(Some(value)),
            Err(Error::Cancelled) => Err(Error::Cancelled),
            Err(_) => Ok(None),
        }
    }
    pub async fn read_resource(
        &self,
        server: &str,
        uri: &str,
        signal: Option<watch::Receiver<bool>>,
    ) -> Result<Option<Value>, Error> {
        let Some(client) = self.client(server).await? else {
            return Ok(None);
        };
        match client.read_resource(uri, signal).await {
            Ok(value) => Ok(value.map(|mut value| {
                value["server"] = Value::String(server.into());
                value["uri"] = Value::String(uri.into());
                value
            })),
            Err(Error::Cancelled) => Err(Error::Cancelled),
            Err(_) => Ok(None),
        }
    }
    pub async fn resource_catalog(&self) -> Result<Value, Error> {
        let mut resources = Vec::new();
        let mut templates = Vec::new();
        for (name, _) in self.slots()? {
            if let Some(client) = self.client(&name).await? {
                let (listed, templated) =
                    tokio::join!(client.resources(), client.resource_templates());
                resources.extend(listed.unwrap_or_default().into_iter().map(|mut value| {
                    value["server"] = Value::String(name.clone());
                    value
                }));
                templates.extend(templated.unwrap_or_default().into_iter().map(|mut value| {
                    value["server"] = Value::String(name.clone());
                    value
                }));
            }
        }
        resources.sort_by(|a, b| catalog_compare(a, b, "uri"));
        templates.sort_by(|a, b| catalog_compare(a, b, "uriTemplate"));
        Ok(serde_json::json!({"resources":resources,"templates":templates}))
    }
    pub async fn resource_catalog_typed(
        &self,
    ) -> Result<ycoding_schema::mcp::ResourceCatalog, Error> {
        use ycoding_schema::DomainDecode;
        let catalog = self.resource_catalog().await?;
        let catalog = ycoding_schema::parse_json(&catalog.to_string())
            .map_err(|_| Error::InvalidResult("resource catalog"))?;
        ycoding_schema::mcp::ResourceCatalog::decode(&catalog)
            .map_err(|_| Error::InvalidResult("resource catalog"))
    }
    pub async fn skill_catalog(&self) -> Result<Vec<mcp_skill::Entry>, Error> {
        let mut entries = Vec::new();
        for (name, _) in self.slots()? {
            if let Some(client) = self.client(&name).await? {
                entries.extend(client.skill_entries().await.unwrap_or_default());
            }
        }
        entries.sort_by(|a, b| a.server.cmp(&b.server).then_with(|| a.uri.cmp(&b.uri)));
        Ok(entries)
    }
    pub async fn get_skill(&self, server: &str, uri: &str) -> Result<mcp_skill::Entry, Error> {
        let client = self
            .client(server)
            .await?
            .ok_or(Error::Skill(mcp_skill::Reason::ExtensionUnsupported))?;
        client.skill_entry(uri).await.map_err(|error| match error {
            Error::Skill(_) => error,
            Error::Rpc { code: -32602, .. } => Error::Skill(mcp_skill::Reason::NotFound),
            Error::Rpc { code: -32601, .. } => {
                Error::Skill(mcp_skill::Reason::ExtensionUnsupported)
            }
            _ => Error::Skill(mcp_skill::Reason::DecodeError),
        })
    }
    pub async fn read_skill_resource(
        &self,
        server: &str,
        entry: &mcp_skill::Entry,
        uri: &str,
    ) -> Result<mcp_skill::File, Error> {
        self.client(server)
            .await?
            .ok_or(Error::Skill(mcp_skill::Reason::ExtensionUnsupported))?
            .read_skill_resource(entry, uri)
            .await
    }
    pub async fn shutdown(&self) -> Result<(), Error> {
        self.0.closed.store(true, Ordering::Release);
        for (name, slot) in self.slots()? {
            let mut state = slot.state.lock().await;
            stop(&self.0, &name, &slot, &mut state).await?;
            if let Some(registration) = state.registration.take() {
                registration.dispose().map_err(|_| Error::Storage)?;
            }
            slot.ready.send_replace(true);
        }
        let mut tasks = std::mem::replace(
            &mut *self.0.tasks.lock().map_err(|_| Error::Closed)?,
            JoinSet::new(),
        );
        tasks.abort_all();
        while let Some(result) = tasks.join_next().await {
            if let Err(error) = result
                && !error.is_cancelled()
            {
                return Err(Error::Closed);
            }
        }
        Ok(())
    }
}

impl Inner {
    fn publish(&self, event: Event) {
        let data = match &event {
            Event::StatusChanged(server) => Some(crate::event_feed::Data::McpStatusChanged(
                Box::new(ycoding_schema::mcp_event::ServerData {
                    server: server.as_str().into(),
                }),
            )),
            Event::ResourcesChanged(server) => Some(crate::event_feed::Data::McpResourcesChanged(
                Box::new(ycoding_schema::mcp_event::ServerData {
                    server: server.as_str().into(),
                }),
            )),
            Event::PromptsChanged(_) => Some(crate::event_feed::Data::CommandUpdated(Box::new(
                ycoding_schema::command::Empty,
            ))),
            Event::ToolsChanged(_) | Event::Log { .. } => None,
        };
        if let Some(data) = data {
            if self.event_source.emit(data).is_err() {
                eprintln!("MCP event publication failed");
            }
        }
        let _ = self.events.send(event);
    }
    fn spawn(&self, future: impl Future<Output = ()> + Send + 'static) -> Result<(), Error> {
        let mut tasks = self.tasks.lock().map_err(|_| Error::Closed)?;
        while let Some(result) = tasks.try_join_next() {
            result.map_err(|_| Error::Closed)?;
        }
        tasks.spawn(future);
        Ok(())
    }
}

fn slot(
    config: ServerConfig,
    authentication: Authentication,
    registration: Option<integration::Registration>,
) -> Arc<Slot> {
    let disabled = disabled(&config);
    let (view, _) = watch::channel(empty_view(if disabled {
        Status::Disabled
    } else {
        Status::Pending
    }));
    let (ready, _) = watch::channel(disabled);
    Arc::new(Slot {
        state: tokio::sync::Mutex::new(State {
            config,
            client: None,
            removed: false,
            registration,
        }),
        view,
        ready,
        authentication: watch::channel(authentication).0,
    })
}

fn registration(
    name: &str,
    config: &ServerConfig,
    hooks: &Hooks,
) -> Result<(Authentication, Option<integration::Registration>), Error> {
    let (ServerConfig::Remote(config), Some(registry)) = (config, &hooks.integrations) else {
        return Ok((Authentication::default(), None));
    };
    if matches!(config.oauth, Some(ycoding_schema::mcp::OAuth::Disabled)) {
        return Ok((Authentication::default(), None));
    }
    let id = super::oauth::integration_id(name, &config.url).map_err(|_| Error::Storage)?;
    let name = name.to_string();
    let config = config.clone();
    let integration_id = id.clone();
    let registration=registry.transform(move |draft| {
        draft.update(integration_id.clone(),|reference| reference.name=name.clone().into());
        let name=name.clone(); let config=config.clone();
        draft.oauth(integration::OAuthImplementation {
            integration:integration_id.clone(),
            method:ycoding_schema::integration::OAuthMethod { id:ycoding_schema::integration_id::IntegrationMethodId::new(integration_id.clone()).expect("MCP integration ID"),label:name.clone().into(),prompts:None,remote:None },
            authorize:Arc::new(move |_| { let name=name.clone(); let config=config.clone(); Box::pin(async move {
                let attempt=super::oauth::authorize(&name,&config).await.map_err(|_|crate::resources::credential::Error::Rejected)?;
                Ok(integration::Authorization::automatic(attempt.url().into(),format!("Authorize {name} in your browser. This window will close automatically."),Box::pin(async move {attempt.finish().await.map_err(|_|crate::resources::credential::Error::Rejected)}),None,None))
            }) }), refresh:None,label:None,
        });
    }).map_err(|_|Error::Storage)?;
    Ok((
        Authentication {
            integration_id: Some(id),
        },
        Some(registration),
    ))
}
fn empty_view(status: Status) -> View {
    View {
        status,
        tools: Vec::new(),
        prompts: Vec::new(),
        instructions: None,
    }
}
fn disabled(config: &ServerConfig) -> bool {
    match config {
        ServerConfig::Local(config) => config.disabled == Some(true),
        ServerConfig::Remote(config) => config.disabled == Some(true),
    }
}
async fn ready(slot: &Slot) -> Result<(), Error> {
    let mut receiver = slot.ready.subscribe();
    loop {
        if *receiver.borrow() {
            return Ok(());
        }
        receiver.changed().await.map_err(|_| Error::Closed)?;
    }
}

async fn start(inner: &Arc<Inner>, name: &str, slot: &Arc<Slot>, state: &mut State) {
    if inner.closed.load(Ordering::Acquire) {
        slot.ready.send_replace(true);
        return;
    }
    slot.view.send_replace(empty_view(Status::Pending));
    inner.publish(Event::StatusChanged(name.into()));
    let result = async {
        let connection = Connection::connect(
            name,
            &state.config,
            &inner.directory,
            &inner.version,
            &inner.environment,
            inner.hooks.clone(),
        )
        .await?;
        let tools = match connection.tools().await {
            Ok(tools) => tools,
            Err(error) => {
                connection.close().await?;
                return Err(error);
            }
        };
        Ok::<_, Error>((Arc::new(connection), tools))
    }
    .await;
    match result {
        Ok((connection, tools)) => {
            let codemode = match &state.config {
                ServerConfig::Local(config) => config.codemode,
                ServerConfig::Remote(config) => config.codemode,
            };
            slot.view.send_replace(View {
                status: Status::Connected,
                tools: tools
                    .into_iter()
                    .map(|definition| Tool {
                        server: name.into(),
                        codemode,
                        definition,
                    })
                    .collect(),
                prompts: Vec::new(),
                instructions: connection.instructions.clone(),
            });
            state.client = Some(connection.clone());
            let mut notifications = connection.subscribe();
            let owner = Arc::downgrade(inner);
            let target = Arc::downgrade(slot);
            let name = name.to_string();
            inner.publish(Event::ToolsChanged(name.clone()));
            inner.publish(Event::ResourcesChanged(name.clone()));
            inner.publish(Event::StatusChanged(name.clone()));
            let started = inner.spawn(async move {
                let prompts = connection.prompts().await.unwrap_or_default();
                if let (Some(inner), Some(slot)) = (owner.upgrade(), target.upgrade()) {
                    let state = slot.state.lock().await;
                    if state
                        .client
                        .as_ref()
                        .is_some_and(|current| Arc::ptr_eq(current, &connection))
                    {
                        slot.view.send_modify(|view| {
                            view.prompts = prompts
                                .into_iter()
                                .map(|mut value| {
                                    value["server"] = Value::String(name.clone());
                                    value
                                })
                                .collect()
                        });
                        inner.publish(Event::PromptsChanged(name.clone()));
                    }
                }
                loop {
                    let notification = match notifications.recv().await {
                        Ok(notification) => notification,
                        Err(broadcast::error::RecvError::Lagged(_)) => Notification {
                            method: "catalog/resync".into(),
                            params: Value::Null,
                        },
                        Err(_) => return,
                    };
                    let (Some(inner), Some(slot)) = (owner.upgrade(), target.upgrade()) else {
                        return;
                    };
                    let mut state = slot.state.lock().await;
                    if !state
                        .client
                        .as_ref()
                        .is_some_and(|current| Arc::ptr_eq(current, &connection))
                    {
                        return;
                    }
                    match notification.method.as_str() {
                        "connection/closed" => {
                            state.client = None;
                            slot.view.send_replace(empty_view(Status::Failed(
                                "Connection closed".into(),
                            )));
                            inner.publish(Event::ToolsChanged(name.clone()));
                            inner.publish(Event::ResourcesChanged(name.clone()));
                            inner.publish(Event::PromptsChanged(name.clone()));
                            inner.publish(Event::StatusChanged(name.clone()));
                            return;
                        }
                        "notifications/tools/list_changed" | "catalog/resync"
                            if connection.list_changed("tools")
                                || notification.method == "catalog/resync" =>
                        {
                            if let Ok(tools) = connection.tools().await {
                                slot.view.send_modify(|view| {
                                    view.tools = tools
                                        .into_iter()
                                        .map(|definition| Tool {
                                            server: name.clone(),
                                            codemode,
                                            definition,
                                        })
                                        .collect()
                                });
                                inner.publish(Event::ToolsChanged(name.clone()));
                            }
                        }
                        "notifications/prompts/list_changed"
                            if connection.list_changed("prompts") =>
                        {
                            let prompts = connection.prompts().await.unwrap_or_default();
                            slot.view.send_modify(|view| {
                                view.prompts = prompts
                                    .into_iter()
                                    .map(|mut value| {
                                        value["server"] = Value::String(name.clone());
                                        value
                                    })
                                    .collect()
                            });
                            inner.publish(Event::PromptsChanged(name.clone()));
                        }
                        "notifications/resources/list_changed"
                            if connection.list_changed("resources") =>
                        {
                            inner.publish(Event::ResourcesChanged(name.clone()))
                        }
                        "notifications/message" => inner.publish(Event::Log {
                            server: name.clone(),
                            params: notification.params,
                        }),
                        _ => (),
                    }
                }
            });
            if started.is_err() {
                state.client = None;
                slot.view.send_replace(empty_view(Status::Failed(
                    "MCP task ownership failed".into(),
                )));
            }
        }
        Err(error) => {
            slot.view
                .send_replace(empty_view(if matches!(error, Error::NeedsAuth(_)) {
                    Status::NeedsAuth
                } else {
                    Status::Failed(error.to_string().into())
                }));
            inner.publish(Event::StatusChanged(name.into()));
        }
    }
    slot.ready.send_replace(true);
}

async fn stop(inner: &Inner, name: &str, slot: &Slot, state: &mut State) -> Result<(), Error> {
    let Some(connection) = state.client.take() else {
        return Ok(());
    };
    slot.view.send_replace(empty_view(Status::Pending));
    connection.close().await?;
    inner.publish(Event::ToolsChanged(name.into()));
    inner.publish(Event::ResourcesChanged(name.into()));
    inner.publish(Event::PromptsChanged(name.into()));
    Ok(())
}
fn catalog_compare(first: &Value, second: &Value, uri: &str) -> std::cmp::Ordering {
    ["server", "name", uri]
        .into_iter()
        .map(|key| {
            compare(
                first[key].as_str().unwrap_or_default(),
                second[key].as_str().unwrap_or_default(),
            )
        })
        .find(|order| !order.is_eq())
        .unwrap_or(std::cmp::Ordering::Equal)
}
fn compare(first: &str, second: &str) -> std::cmp::Ordering {
    crate::platform::filesystem::collation::compare(
        &first.encode_utf16().collect::<Vec<_>>(),
        &second.encode_utf16().collect::<Vec<_>>(),
    )
}
