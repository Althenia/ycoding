use super::{configuration, output_schema, skills, stdio::Stdio, transport::Pinned};
use crate::platform::process;
use rmcp::{
    RoleClient, ServiceExt,
    model::{
        ClientConfig, ClientRequest, ClientResult, CustomRequest, ErrorCode, ErrorData,
        ProtocolVersion, ServerNotification, ServerRequest,
    },
    service::{
        NotificationContext, Peer, PeerRequestOptions, RequestContext, RunningService, ServiceError,
    },
    transport::{
        StreamableHttpClientTransport, streamable_http_client::StreamableHttpClientTransportConfig,
    },
};
use serde_json::{Value, json};
use std::{
    borrow::Cow,
    collections::{BTreeMap, BTreeSet},
    fmt,
    future::Future,
    path::Path,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{broadcast, watch},
    task::JoinSet,
};
use ycoding_schema::{DomainDecode, LosslessString, mcp::ServerConfig, mcp_skill, parse_json};

pub const SUPPORTED_VERSIONS: [&str; 5] = [
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];

#[derive(Debug, Clone, PartialEq)]
pub enum Error {
    Connect(String),
    NeedsAuth(String),
    Timeout,
    Cancelled,
    Closed,
    Rpc { code: i64, message: String },
    InvalidResult(&'static str),
    UnsupportedSchema(String),
    OutputSchema,
    Skill(mcp_skill::Reason),
    NotFound(String),
    Storage,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Connect(message) => f.write_str(message),
            Self::NeedsAuth(server) => write!(f, "MCP server requires authentication: {server}"),
            Self::Timeout => f.write_str("MCP request timed out"),
            Self::Cancelled => f.write_str("MCP request cancelled"),
            Self::Closed => f.write_str("Connection closed"),
            Self::Rpc { code, message } => write!(f, "MCP error {code}: {message}"),
            Self::InvalidResult(field) => write!(f, "Invalid MCP result: {field}"),
            Self::UnsupportedSchema(keyword) => {
                write!(f, "Unsupported MCP outputSchema keyword: {keyword}")
            }
            Self::OutputSchema => {
                f.write_str("Structured content does not match the tool's output schema")
            }
            Self::Skill(reason) => write!(f, "MCP skill verification failed: {reason:?}"),
            Self::NotFound(server) => write!(f, "MCP server not found: {server}"),
            Self::Storage => f.write_str("MCP credential storage failed"),
        }
    }
}
impl std::error::Error for Error {}

type ElicitationFuture = Pin<Box<dyn Future<Output = Result<Value, Error>> + Send>>;
pub type ElicitationHandler =
    Arc<dyn Fn(String, Value, watch::Receiver<bool>) -> ElicitationFuture + Send + Sync>;

#[derive(Clone, Default)]
pub struct Hooks {
    pub elicitation: Option<ElicitationHandler>,
    pub credentials: Option<crate::resources::credential::Service>,
    pub integrations: Option<crate::resources::auth::integration::Registry>,
}

#[derive(Clone, Debug)]
pub struct Notification {
    pub method: String,
    pub params: Value,
}

struct Handler {
    server: String,
    root: String,
    info: ClientConfig,
    hooks: Hooks,
    notifications: broadcast::Sender<Notification>,
}

impl rmcp::Service<RoleClient> for Handler {
    async fn handle_request(
        &self,
        request: ServerRequest,
        context: RequestContext<RoleClient>,
    ) -> Result<ClientResult, ErrorData> {
        let value = serde_json::to_value(request)
            .map_err(|_| ErrorData::new(ErrorCode(-32603), "Invalid request", None))?;
        let result = match value["method"].as_str() {
            Some("ping") => json!({}),
            Some("roots/list") => json!({"roots":[{"uri":self.root}]}),
            Some("elicitation/create") => {
                let Some(handler) = &self.hooks.elicitation else {
                    return Err(ErrorData::new(
                        ErrorCode(-32601),
                        "Elicitation is unavailable",
                        None,
                    ));
                };
                if value["params"]["mode"] != "url"
                    && value["params"]["requestedSchema"]["properties"]
                        .as_object()
                        .is_some_and(serde_json::Map::is_empty)
                {
                    return serde_json::from_value(json!({"action":"accept","content":{}}))
                        .map_err(|_| {
                            ErrorData::new(ErrorCode(-32603), "Invalid client result", None)
                        });
                }
                let (cancel, signal) = watch::channel(false);
                let mut result = tokio::select! {
                    result=handler(self.server.clone(),value["params"].clone(),signal)=>result.map_err(|_|ErrorData::new(ErrorCode(-32603),"Elicitation failed",None))?,
                    _=context.ct.cancelled()=>{cancel.send_replace(true);return Err(ErrorData::new(ErrorCode(-32000),"Elicitation cancelled",None))},
                };
                if value["params"]["mode"] == "url" {
                    result = json!({"action":result["action"]});
                }
                if result["action"] == "accept"
                    && value["params"]["mode"] != "url"
                    && let (Some(properties), Some(content)) = (
                        value["params"]["requestedSchema"]["properties"].as_object(),
                        result["content"].as_object_mut(),
                    )
                {
                    for (key, schema) in properties {
                        if !content.contains_key(key)
                            && let Some(default) = schema.get("default")
                        {
                            content.insert(key.clone(), default.clone());
                        }
                    }
                }
                result
            }
            _ => return Err(ErrorData::new(ErrorCode(-32601), "Method not found", None)),
        };
        serde_json::from_value(result)
            .map_err(|_| ErrorData::new(ErrorCode(-32603), "Invalid client result", None))
    }
    async fn handle_notification(
        &self,
        notification: ServerNotification,
        _context: NotificationContext<RoleClient>,
    ) -> Result<(), ErrorData> {
        let value = serde_json::to_value(notification)
            .map_err(|_| ErrorData::new(ErrorCode(-32603), "Invalid notification", None))?;
        if let Some(method) = value["method"].as_str() {
            let _ = self.notifications.send(Notification {
                method: method.into(),
                params: value["params"].clone(),
            });
        }
        Ok(())
    }
    fn get_info(&self) -> ClientConfig {
        self.info.clone()
    }
    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Owned(
            SUPPORTED_VERSIONS
                .iter()
                .map(|version| {
                    serde_json::from_value(json!(version)).expect("pinned protocol version")
                })
                .collect(),
        )
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Content {
    Text(String),
    Media { data: String, mime_type: String },
}
#[derive(Clone, Debug, PartialEq)]
pub struct ToolResult {
    pub is_error: bool,
    pub structured: Option<Value>,
    pub content: Vec<Content>,
}

pub struct Connection {
    server: String,
    peer: Peer<RoleClient>,
    running: Mutex<Option<RunningService<RoleClient, Handler>>>,
    cancellations: Arc<Mutex<JoinSet<()>>>,
    notifications: broadcast::Sender<Notification>,
    pub instructions: Option<String>,
    pub skills: Option<mcp_skill::Capability>,
    capabilities: Value,
    protocol_version: String,
    process_id: Option<u32>,
    catalog_timeout: Duration,
    execution_timeout: Duration,
    resource_methods: Mutex<(bool, bool)>,
    output_schemas: Mutex<BTreeMap<String, Value>>,
}

impl Connection {
    pub async fn connect(
        server: &str,
        config: &ServerConfig,
        directory: &Path,
        version: &str,
        environment: &BTreeMap<String, String>,
        hooks: Hooks,
    ) -> Result<Self, Error> {
        let (notifications, _) = broadcast::channel(256);
        let mut capabilities = json!({"roots":{}});
        if hooks.elicitation.is_some() {
            capabilities["elicitation"] = json!({"form":{"applyDefaults":true},"url":{}});
        }
        let info:ClientConfig=serde_json::from_value(json!({"protocolVersion":SUPPORTED_VERSIONS[0],"capabilities":capabilities,"clientInfo":{"name":"ycoding","version":version}})).map_err(|_|Error::Connect("Invalid MCP client capabilities".into()))?;
        let handler = Handler {
            server: server.into(),
            root: url::Url::from_file_path(directory)
                .map_err(|_| Error::Connect("Invalid Location directory".into()))?
                .into(),
            info,
            hooks,
            notifications: notifications.clone(),
        };
        let timeout = match config {
            ServerConfig::Local(config) => config.timeout.as_ref(),
            ServerConfig::Remote(config) => config.timeout.as_ref(),
        };
        let startup = Duration::from_millis(
            timeout
                .and_then(|timeout| timeout.startup)
                .map_or(30_000, |value| value.get() as u64),
        );
        let mut process_id = None;
        let running = match config {
            ServerConfig::Local(config) => {
                let cwd = configuration::working_directory(
                    directory,
                    config.cwd.as_ref().and_then(LosslessString::as_str),
                );
                let metadata = tokio::fs::metadata(&cwd).await.map_err(|error| {
                    Error::Connect(
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                        ) {
                            format!("Working directory does not exist: {}", cwd.display())
                        } else {
                            error.to_string()
                        },
                    )
                })?;
                if !metadata.is_dir() {
                    return Err(Error::Connect(format!(
                        "Working directory is not a directory: {}",
                        cwd.display()
                    )));
                }
                let command = config
                    .command
                    .first()
                    .and_then(LosslessString::as_str)
                    .ok_or_else(|| Error::Connect("Missing MCP command".into()))?;
                let mut command = process::Command::new(
                    command,
                    config
                        .command
                        .iter()
                        .skip(1)
                        .map(|argument| {
                            argument
                                .to_utf8()
                                .map_err(|_| Error::Connect("Invalid MCP command argument".into()))
                        })
                        .collect::<Result<Vec<_>, _>>()?,
                );
                command.cwd = Some(cwd);
                command.env = environment.clone();
                if command.program == "ycoding" {
                    command.env.insert("BUN_BE_BUN".into(), "1".into());
                }
                if let Some(environment) = &config.environment {
                    for (key, value) in environment.iter() {
                        command.env.insert(
                            key.to_utf8()
                                .map_err(|_| Error::Connect("Invalid MCP environment".into()))?,
                            LosslessString::decode(value)
                                .map_err(|_| Error::Connect("Invalid MCP environment".into()))?
                                .to_utf8()
                                .map_err(|_| Error::Connect("Invalid MCP environment".into()))?,
                        );
                    }
                }
                let transport = Stdio::spawn(command)
                    .await
                    .map_err(|error| Error::Connect(error.to_string()))?;
                process_id = Some(transport.pid());
                tokio::time::timeout(
                    startup,
                    handler.serve(Pinned {
                        inner: transport,
                        notifications: notifications.clone(),
                    }),
                )
                .await
                .map_err(|_| Error::Timeout)?
                .map_err(|error| Error::Connect(error.to_string()))?
            }
            ServerConfig::Remote(config) => {
                let uri = config
                    .url
                    .to_utf8()
                    .map_err(|_| Error::Connect("Invalid MCP URL".into()))?;
                let parsed = url::Url::parse(&uri)
                    .map_err(|_| Error::Connect(format!("Invalid MCP URL for \"{server}\"")))?;
                if !["http", "https"].contains(&parsed.scheme()) {
                    return Err(Error::Connect("Unsupported MCP URL scheme".into()));
                }
                let mut transport_config = StreamableHttpClientTransportConfig::with_uri(uri);
                transport_config.retry_config = Arc::new(super::transport::SdkRetry);
                transport_config.max_sse_event_size = usize::MAX;
                if let Some(headers) = &config.headers {
                    for (name, value) in headers.iter() {
                        transport_config.custom_headers.insert(
                            reqwest::header::HeaderName::from_bytes(
                                name.to_utf8()
                                    .map_err(|_| Error::Connect("Invalid MCP header name".into()))?
                                    .as_bytes(),
                            )
                            .map_err(|_| Error::Connect("Invalid MCP header name".into()))?,
                            reqwest::header::HeaderValue::from_str(
                                &LosslessString::decode(value)
                                    .map_err(|_| Error::Connect("Invalid MCP header value".into()))?
                                    .to_utf8()
                                    .map_err(|_| {
                                        Error::Connect("Invalid MCP header value".into())
                                    })?,
                            )
                            .map_err(|_| Error::Connect("Invalid MCP header value".into()))?,
                        );
                    }
                }
                let enabled = !matches!(config.oauth, Some(ycoding_schema::mcp::OAuth::Disabled));
                let http =
                    super::http::Http::new(server, config, handler.hooks.credentials.as_ref())
                        .map_err(|_| Error::Storage)?;
                let transport = StreamableHttpClientTransport::with_client(http, transport_config);
                tokio::time::timeout(
                    startup,
                    handler.serve(Pinned {
                        inner: transport,
                        notifications: notifications.clone(),
                    }),
                )
                .await
                .map_err(|_| Error::Timeout)?
                .map_err(|error| {
                    if enabled && error.auth_challenge().is_some() {
                        Error::NeedsAuth(server.into())
                    } else {
                        Error::Connect(error.to_string())
                    }
                })?
            }
        };
        let info = running
            .peer_info()
            .ok_or_else(|| Error::Connect("Missing MCP initialization result".into()))?;
        let protocol_version = info.protocol_version.to_string();
        if !SUPPORTED_VERSIONS.contains(&protocol_version.as_str()) {
            running.cancel().await.map_err(|_| Error::Closed)?;
            return Err(Error::Connect(format!(
                "Server's protocol version is not supported: {protocol_version}"
            )));
        }
        let capabilities = serde_json::to_value(&info.capabilities)
            .map_err(|_| Error::InvalidResult("capabilities"))?;
        let skill_capability = skills::capability(
            &parse_json(&capabilities.to_string())
                .map_err(|_| Error::InvalidResult("capabilities"))?,
        );
        let resources = capabilities.get("resources").is_some();
        Ok(Self {
            server: server.into(),
            peer: running.peer().clone(),
            running: Mutex::new(Some(running)),
            cancellations: Arc::new(Mutex::new(JoinSet::new())),
            notifications,
            instructions: info
                .instructions
                .as_deref()
                .map(crate::resources::discovery::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned),
            skills: skill_capability,
            capabilities,
            protocol_version,
            process_id,
            catalog_timeout: Duration::from_millis(
                timeout
                    .and_then(|timeout| timeout.catalog)
                    .map_or(30_000, |value| value.get() as u64),
            ),
            execution_timeout: Duration::from_millis(
                timeout
                    .and_then(|timeout| timeout.execution)
                    .map_or(12 * 60 * 60 * 1000, |value| value.get() as u64),
            ),
            resource_methods: Mutex::new((resources, resources)),
            output_schemas: Mutex::new(BTreeMap::new()),
        })
    }

    pub fn protocol_version(&self) -> &str {
        &self.protocol_version
    }
    pub fn process_id(&self) -> Option<u32> {
        self.process_id
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Notification> {
        self.notifications.subscribe()
    }
    pub fn is_closed(&self) -> bool {
        self.peer.is_transport_closed()
    }
    pub(crate) fn list_changed(&self, kind: &str) -> bool {
        self.capabilities[kind]["listChanged"] == true
    }

    pub async fn close(&self) -> Result<(), Error> {
        let mut cancellations = std::mem::replace(
            &mut *self.cancellations.lock().map_err(|_| Error::Closed)?,
            JoinSet::new(),
        );
        while let Some(result) = cancellations.join_next().await {
            result.map_err(|_| Error::Closed)?;
        }
        let running = self.running.lock().map_err(|_| Error::Closed)?.take();
        if let Some(running) = running {
            running.cancel().await.map_err(|_| Error::Closed)?;
        }
        Ok(())
    }

    async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        signal: Option<watch::Receiver<bool>>,
    ) -> Result<Value, Error> {
        if signal.as_ref().is_some_and(|signal| *signal.borrow()) {
            return Err(Error::Cancelled);
        }
        let handle = self
            .peer
            .send_cancellable_request(
                ClientRequest::CustomRequest(CustomRequest::new(method, Some(params))),
                PeerRequestOptions::with_timeout(timeout),
            )
            .await
            .map_err(service_error)?;
        let mut guard = CancelOnDrop {
            peer: self.peer.clone(),
            id: Some(handle.id.clone()),
            tasks: self.cancellations.clone(),
        };
        let response = tokio::select! {result=handle.await_response()=>result.map_err(service_error),_=cancelled(signal)=>Err(Error::Cancelled)};
        if !matches!(response, Err(Error::Cancelled)) {
            guard.id = None;
        }
        serde_json::to_value(response?).map_err(|_| Error::InvalidResult("response"))
    }

    async fn list(
        &self,
        method: &str,
        key: &'static str,
        params: Value,
        timeout: Duration,
        cache_fields: bool,
    ) -> Result<Vec<Value>, Error> {
        let mut collected = Vec::new();
        let mut cursors = BTreeSet::new();
        let mut params = params;
        loop {
            let result = self.request(method, params.clone(), timeout, None).await?;
            if cache_fields
                && (result["resultType"] != "complete"
                    || !result["ttlMs"].is_number()
                    || !result["cacheScope"].is_string())
            {
                return Err(Error::InvalidResult("resultType/ttlMs/cacheScope"));
            }
            if method == mcp_skill::DIRECTORY_READ_METHOD && result["resultType"] != "complete" {
                return Err(Error::InvalidResult("resultType"));
            }
            collected.extend(
                result[key]
                    .as_array()
                    .ok_or(Error::InvalidResult(key))?
                    .iter()
                    .cloned(),
            );
            let Some(cursor) = result.get("nextCursor") else {
                return Ok(collected);
            };
            let cursor = cursor.as_str().ok_or(Error::InvalidResult("nextCursor"))?;
            if !cursors.insert(cursor.to_string()) {
                return Err(Error::Connect(format!(
                    "MCP list returned duplicate cursor: {cursor}"
                )));
            }
            params["cursor"] = json!(cursor);
        }
    }

    pub async fn tools(&self) -> Result<Vec<Value>, Error> {
        if self.capabilities.get("tools").is_none() {
            return Ok(Vec::new());
        }
        let mut tools = self
            .list(
                "tools/list",
                "tools",
                json!({}),
                self.catalog_timeout,
                false,
            )
            .await?;
        let mut schemas = BTreeMap::new();
        for tool in &mut tools {
            let name = tool["name"]
                .as_str()
                .ok_or(Error::InvalidResult("tool.name"))?
                .to_string();
            if !tool["inputSchema"].is_object() {
                return Err(Error::InvalidResult("tool.inputSchema"));
            }
            if let Some(schema) = tool.get("outputSchema") {
                output_schema::check(schema)?;
                schemas.insert(name, schema.clone());
            }
        }
        *self.output_schemas.lock().map_err(|_| Error::Closed)? = schemas;
        Ok(tools)
    }
    pub async fn prompts(&self) -> Result<Vec<Value>, Error> {
        if self.capabilities.get("prompts").is_none() {
            return Ok(Vec::new());
        }
        let prompts = self
            .list(
                "prompts/list",
                "prompts",
                json!({}),
                self.catalog_timeout,
                false,
            )
            .await?;
        if prompts.iter().any(|prompt| !prompt["name"].is_string()) {
            return Err(Error::InvalidResult("prompt.name"));
        }
        Ok(prompts)
    }
    pub async fn resources(&self) -> Result<Vec<Value>, Error> {
        self.resource_list(false).await
    }
    pub async fn resource_templates(&self) -> Result<Vec<Value>, Error> {
        self.resource_list(true).await
    }
    async fn resource_list(&self, templates: bool) -> Result<Vec<Value>, Error> {
        let unsupported = {
            let supported = self.resource_methods.lock().map_err(|_| Error::Closed)?;
            if templates {
                !supported.1
            } else {
                !supported.0
            }
        };
        if unsupported {
            return Ok(Vec::new());
        }
        match self
            .list(
                if templates {
                    "resources/templates/list"
                } else {
                    "resources/list"
                },
                if templates {
                    "resourceTemplates"
                } else {
                    "resources"
                },
                json!({}),
                self.catalog_timeout,
                false,
            )
            .await
        {
            Err(Error::Rpc { code: -32601, .. }) => {
                let mut supported = self.resource_methods.lock().map_err(|_| Error::Closed)?;
                if templates {
                    supported.1 = false
                } else {
                    supported.0 = false
                }
                Ok(Vec::new())
            }
            result => result.map(|items| {
                items
                    .iter()
                    .map(|item| {
                        project(
                            item,
                            if templates {
                                &["name", "uriTemplate", "description", "mimeType"]
                            } else {
                                &["name", "uri", "description", "mimeType"]
                            },
                        )
                    })
                    .collect()
            }),
        }
    }
    pub async fn read_resource(
        &self,
        uri: &str,
        signal: Option<watch::Receiver<bool>>,
    ) -> Result<Option<Value>, Error> {
        if self.capabilities.get("resources").is_none() {
            return Ok(None);
        }
        let mut result = self
            .request(
                "resources/read",
                json!({"uri":uri}),
                self.execution_timeout,
                signal,
            )
            .await?;
        let contents = result["contents"]
            .as_array_mut()
            .ok_or(Error::InvalidResult("contents"))?;
        for part in contents {
            if !part["uri"].is_string() {
                return Err(Error::InvalidResult("contents.uri"));
            }
            let (kind, keys) = if part["text"].is_string() {
                ("text", ["uri", "text", "mimeType"])
            } else if part["blob"].is_string() {
                ("blob", ["uri", "blob", "mimeType"])
            } else {
                return Err(Error::InvalidResult("contents.text/blob"));
            };
            let mut projected = project(part, &keys);
            projected["type"] = json!(kind);
            *part = projected;
        }
        Ok(Some(result))
    }
    pub async fn prompt(
        &self,
        name: &str,
        args: Value,
        signal: Option<watch::Receiver<bool>>,
    ) -> Result<Value, Error> {
        let result = self
            .request(
                "prompts/get",
                json!({"name":name,"arguments":args}),
                self.execution_timeout,
                signal,
            )
            .await?;
        let messages = result["messages"]
            .as_array()
            .ok_or(Error::InvalidResult("messages"))?;
        if messages.iter().any(|message| {
            !matches!(message["role"].as_str(), Some("user" | "assistant"))
                || !message["content"].is_object()
        }) {
            return Err(Error::InvalidResult("messages.role/content"));
        }
        Ok(result)
    }
    pub async fn call_tool(
        &self,
        name: &str,
        args: Value,
        signal: Option<watch::Receiver<bool>>,
    ) -> Result<ToolResult, Error> {
        let result = self
            .request(
                "tools/call",
                json!({"name":name,"arguments":args}),
                self.execution_timeout,
                signal,
            )
            .await?;
        let schema = self
            .output_schemas
            .lock()
            .map_err(|_| Error::Closed)?
            .get(name)
            .cloned();
        if let Some(schema) = schema {
            if let Some(structured) = result.get("structuredContent") {
                output_schema::validate(&schema, structured)?;
            } else if result["isError"] != true {
                return Err(Error::OutputSchema);
            }
        }
        tool_result(&result)
    }
    pub async fn skill_entries(&self) -> Result<Vec<mcp_skill::Entry>, Error> {
        if self.skills.is_none() {
            return Ok(Vec::new());
        }
        Ok(self
            .list(
                mcp_skill::LIST_METHOD,
                "skills",
                json!({}),
                self.catalog_timeout,
                true,
            )
            .await?
            .iter()
            .filter_map(|raw| {
                parse_json(&raw.to_string())
                    .ok()
                    .and_then(|raw| skills::entry(&self.server.clone().into(), &raw).ok())
            })
            .collect())
    }
    pub async fn skill_entry(&self, uri: &str) -> Result<mcp_skill::Entry, Error> {
        if self.skills.is_none() {
            return Err(Error::Skill(mcp_skill::Reason::ExtensionUnsupported));
        }
        let result = self
            .request(
                mcp_skill::GET_METHOD,
                json!({"uri":uri}),
                self.execution_timeout,
                None,
            )
            .await?;
        if result["resultType"] != "complete"
            || !result["ttlMs"].is_number()
            || !result["cacheScope"].is_string()
        {
            return Err(Error::InvalidResult("resultType/ttlMs/cacheScope"));
        }
        if result["skill"]["uri"]
            .as_str()
            .is_some_and(|actual| actual != uri)
        {
            return Err(Error::Skill(mcp_skill::Reason::UriMismatch));
        }
        skills::entry(
            &self.server.clone().into(),
            &parse_json(&result["skill"].to_string())
                .map_err(|_| Error::Skill(mcp_skill::Reason::DecodeError))?,
        )
        .map_err(Error::Skill)
    }
    pub async fn read_resource_directory(&self, uri: &str) -> Result<Option<Vec<Value>>, Error> {
        if self
            .skills
            .as_ref()
            .is_none_or(|capability| capability.directory_read != Some(true))
        {
            return Ok(None);
        }
        self.list(
            mcp_skill::DIRECTORY_READ_METHOD,
            "resources",
            json!({"uri":uri}),
            self.execution_timeout,
            false,
        )
        .await
        .map(|entries| {
            Some(
                entries
                    .iter()
                    .map(|entry| project(entry, &["uri", "name", "mimeType"]))
                    .collect(),
            )
        })
    }
    pub async fn read_skill_resource(
        &self,
        entry: &mcp_skill::Entry,
        uri: &str,
    ) -> Result<mcp_skill::File, Error> {
        let uri = LosslessString::from(uri);
        skills::authorize_read(&self.server.clone().into(), entry, &uri).map_err(Error::Skill)?;
        let result = self
            .read_resource(
                uri.as_str()
                    .ok_or(Error::Skill(mcp_skill::Reason::MalformedUri))?,
                None,
            )
            .await?
            .ok_or(Error::Skill(mcp_skill::Reason::ExtensionUnsupported))?;
        let part = result["contents"]
            .as_array()
            .and_then(|parts| {
                parts
                    .iter()
                    .find(|part| part["uri"].as_str() == uri.as_str())
            })
            .ok_or(Error::Skill(mcp_skill::Reason::UnlistedResource))?;
        let text = part["text"].as_str().map(LosslessString::from);
        let bytes = match &text {
            Some(text) => text
                .to_utf8()
                .map_err(|_| Error::Skill(mcp_skill::Reason::DecodeError))?
                .into_bytes(),
            None => skills::decode_base64(
                part["blob"]
                    .as_str()
                    .ok_or(Error::Skill(mcp_skill::Reason::DecodeError))?,
            ),
        };
        let blob = text
            .is_none()
            .then(|| LosslessString::from(skills::encode_base64(&bytes, false)));
        let mime_type = part["mimeType"].as_str().map(LosslessString::from);
        skills::file(&skills::FileInput {
            entry,
            uri: &uri,
            size: bytes.len(),
            digest: skills::digest(&bytes),
            mime_type: mime_type.as_ref(),
            text: text.as_ref(),
            blob: blob.as_ref(),
        })
        .map_err(Error::Skill)
    }
}

struct CancelOnDrop {
    peer: Peer<RoleClient>,
    id: Option<rmcp::model::RequestId>,
    tasks: Arc<Mutex<JoinSet<()>>>,
}
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(id) = self.id.take()
            && let Ok(mut tasks) = self.tasks.lock()
        {
            while tasks.try_join_next().is_some() {}
            let peer = self.peer.clone();
            tasks.spawn(async move {
                let _ = peer
                    .send_notification(
                        rmcp::model::CancelledNotification::new(
                            rmcp::model::CancelledNotificationParam::new(
                                Some(id),
                                Some("Request cancelled".into()),
                            ),
                        )
                        .into(),
                    )
                    .await;
            });
        }
    }
}

async fn cancelled(signal: Option<watch::Receiver<bool>>) {
    let Some(mut signal) = signal else {
        std::future::pending::<()>().await;
        return;
    };
    loop {
        if *signal.borrow() {
            return;
        }
        if signal.changed().await.is_err() {
            std::future::pending::<()>().await;
            return;
        }
    }
}

fn service_error(error: ServiceError) -> Error {
    match error {
        ServiceError::Timeout { .. } => Error::Timeout,
        ServiceError::McpError(error) => Error::Rpc {
            code: error.code.0 as i64,
            message: error.message.into_owned(),
        },
        ServiceError::TransportClosed => Error::Closed,
        error => Error::Connect(error.to_string()),
    }
}

fn project(value: &Value, keys: &[&str]) -> Value {
    Value::Object(
        keys.iter()
            .filter_map(|key| Some((key.to_string(), value.get(*key)?.clone())))
            .collect(),
    )
}

pub fn tool_result(result: &Value) -> Result<ToolResult, Error> {
    let mut content = Vec::new();
    for part in result["content"]
        .as_array()
        .ok_or(Error::InvalidResult("content"))?
    {
        let text = |key| {
            part[key]
                .as_str()
                .map(str::to_string)
                .ok_or(Error::InvalidResult("content part"))
        };
        match part["type"].as_str() {
            Some("text") => content.push(Content::Text(text("text")?)),
            Some("image" | "audio") => content.push(Content::Media {
                data: text("data")?,
                mime_type: text("mimeType")?,
            }),
            Some("resource_link") => content.push(Content::Text(text("uri")?)),
            Some("resource") => {
                let resource = &part["resource"];
                if let Some(text) = resource["text"].as_str() {
                    content.push(Content::Text(text.into()));
                    continue;
                }
                if let (Some(blob), Some(mime_type)) =
                    (resource["blob"].as_str(), resource["mimeType"].as_str())
                {
                    content.push(Content::Media {
                        data: blob.into(),
                        mime_type: mime_type.into(),
                    });
                    continue;
                }
                content.push(Content::Text(
                    resource["uri"]
                        .as_str()
                        .ok_or(Error::InvalidResult("resource.uri"))?
                        .into(),
                ));
            }
            _ => return Err(Error::InvalidResult("content.type")),
        }
    }
    Ok(ToolResult {
        is_error: result["isError"] == true,
        structured: result.get("structuredContent").cloned(),
        content,
    })
}
