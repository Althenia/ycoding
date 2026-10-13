use super::{
    context, display, errors, framing, headers, images, interactions, models, observations,
    persistence, planning, protobuf,
    request::{self, Action, Descriptor, History, RunRequest},
    stream::State,
    tools, transport, unary,
    wire::{Exec, ServerMessage, Update},
};
use crate::{
    Error,
    auth::Auth,
    json,
    llm::{
        Event, Finish, FinishReason, Message, Model, Part, Request, Role, ToolCall, ToolChoice,
        ToolDefinition, ToolResult, ToolResultValue,
    },
    providers,
    route::{self, Executor, Prepared, Protocol, StreamParser, Tracker},
};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::OwnedMutexGuard;
use ycoding_schema::{JsonValue, LosslessString, provider, stringify_json};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestContext(Vec<u8>);
impl RequestContext {
    pub fn new(bytes: Vec<u8>) -> Result<Self, Error> {
        if protobuf::fields(&bytes)?.is_empty() {
            return Err(Error::invalid(
                "Cursor RequestContext must be supplied by its Location owner",
            ));
        }
        Ok(Self(bytes))
    }
    pub fn bytes(&self) -> &[u8] {
        &self.0
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub conversation_id: LosslessString,
    pub checkpoint: Option<Vec<u8>>,
    pub blobs: BTreeMap<Vec<u8>, Vec<u8>>,
    pub last_user: Option<LosslessString>,
    pub descriptors: Vec<Descriptor>,
}
pub struct Runtime {
    client: transport::Client,
    sessions: Mutex<BTreeMap<String, Arc<tokio::sync::Mutex<Session>>>>,
    pub images: images::Stage,
}
struct Heartbeat(tokio::task::JoinHandle<()>);
impl Heartbeat {
    fn start(writer: transport::Writer, interval_ms: u64) -> Self {
        let frame = request::heartbeat();
        let interval = Duration::from_millis(interval_ms);
        Self(tokio::spawn(async move {
            loop {
                tokio::time::sleep(interval).await;
                if writer.write(&frame).await.is_err() {
                    writer.cancel();
                    return;
                }
            }
        }))
    }
}
impl Drop for Heartbeat {
    fn drop(&mut self) {
        self.0.abort();
    }
}
impl Session {
    fn release_run(&mut self) -> Option<transport::Run> {
        self.heartbeat = None;
        self.run.take()
    }
}
struct Session {
    snapshot: Snapshot,
    hydrated: bool,
    heartbeat: Option<Heartbeat>,
    state: State,
    run: Option<transport::Run>,
    pending: Option<Pending>,
    run_id: LosslessString,
    mirrored_todos: Vec<JsonValue>,
    image_hashes: VecDeque<[u8; 32]>,
    planning: planning::State,
}
struct Pending {
    reply: Reply,
    call: ToolCall,
    started: Instant,
}
enum Reply {
    Exec(Exec),
    Display,
    Question(interactions::Question),
    Native(tools::Native),
    Read {
        exec: Exec,
        request: observations::ReadRequest,
        host: Arc<dyn observations::Host>,
    },
    Image {
        exec: Exec,
        id: LosslessString,
        path: String,
        bytes: usize,
    },
}
impl Runtime {
    pub fn image_save_tool(self: &Arc<Self>, host: Arc<dyn images::Host>) -> crate::tool::Tool {
        let runtime = self.clone();
        crate::tool::Tool::dynamic(ToolDefinition {
            name: images::SAVE_TOOL.into(),
            description: "Save one staged Cursor image after host permissions are granted".into(),
            input_schema: json::object([
                ("type", json::s("object")),
                (
                    "properties",
                    json::object([("image_id", json::object([("type", json::s("string"))]))]),
                ),
                ("required", JsonValue::Array(vec![json::s("image_id")])),
                ("additionalProperties", JsonValue::Bool(false)),
            ]),
            output_schema: None,
            cache: None,
            metadata: None,
            native: None,
        })
        .with_execute(move |input, _| {
            let runtime = runtime.clone();
            let host = host.clone();
            async move {
                let JsonValue::Object(fields) = &input else {
                    return Err(crate::tool::DispatchError::Failure(
                        crate::tool::ToolFailure {
                            message: "Cursor image save accepts only image_id".into(),
                            error: None,
                        },
                    ));
                };
                if fields.len() != 1 {
                    return Err(crate::tool::DispatchError::Failure(
                        crate::tool::ToolFailure {
                            message: "Cursor image save accepts only image_id".into(),
                            error: None,
                        },
                    ));
                }
                let id = json::get(&input, "image_id")
                    .and_then(json::string)
                    .ok_or_else(|| {
                        crate::tool::DispatchError::Failure(crate::tool::ToolFailure {
                            message: "Cursor image save requires image_id".into(),
                            error: None,
                        })
                    })?;
                let receipt = runtime
                    .images
                    .save(
                        id,
                        host.as_ref(),
                        milliseconds().map_err(|error| {
                            crate::tool::DispatchError::Failure(crate::tool::ToolFailure {
                                message: error.message.into(),
                                error: None,
                            })
                        })?,
                    )
                    .await
                    .map_err(|error| {
                        crate::tool::DispatchError::Failure(crate::tool::ToolFailure {
                            message: error.message.into(),
                            error: None,
                        })
                    })?;
                Ok(json::object([
                    ("title", json::s(receipt.path.to_string_lossy().as_ref())),
                    (
                        "output",
                        json::s(format!(
                            "Saved the generated image to {} ({} bytes).",
                            receipt.path.display(),
                            receipt.bytes
                        )),
                    ),
                ]))
            }
        })
    }
    pub fn new(options: transport::Options) -> Result<Self, Error> {
        Ok(Self {
            client: transport::Client::new(options)?,
            sessions: Mutex::new(BTreeMap::new()),
            images: images::Stage::new(),
        })
    }
    fn session(&self, key: &str) -> Result<Arc<tokio::sync::Mutex<Session>>, Error> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| Error::transport("Cursor Session map lock failed", "client"))?;
        if let Some(session) = sessions.get(key) {
            return Ok(session.clone());
        }
        let conversation_id = uuid()?;
        let session = Arc::new(tokio::sync::Mutex::new(Session {
            snapshot: Snapshot {
                conversation_id,
                checkpoint: None,
                blobs: BTreeMap::new(),
                last_user: None,
                descriptors: Vec::new(),
            },
            state: State::new(),
            hydrated: false,
            heartbeat: None,
            run: None,
            pending: None,
            run_id: uuid()?,
            mirrored_todos: Vec::new(),
            image_hashes: VecDeque::new(),
            planning: planning::State::default(),
        }));
        sessions.insert(key.to_owned(), session.clone());
        Ok(session)
    }
    fn continuation_key(&self, results: &[&ToolResult]) -> Result<Option<String>, Error> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| Error::transport("Cursor Session map lock failed", "client"))?;
        Ok(results.iter().find_map(|result| {
            sessions.iter().find_map(|(key, session)| {
                let session = session.try_lock().ok()?;
                session
                    .pending
                    .as_ref()
                    .filter(|pending| pending.call.id == result.id && session.run.is_some())
                    .map(|_| key.clone())
            })
        }))
    }
    pub async fn snapshot(&self, key: &str) -> Result<Snapshot, Error> {
        Ok(self.session(key)?.lock().await.snapshot.clone())
    }
    pub async fn restore(&self, key: &str, snapshot: Snapshot) -> Result<(), Error> {
        let session = self.session(key)?;
        let mut session = session
            .try_lock()
            .map_err(|_| Error::invalid("Cannot restore an active Cursor Session"))?;
        if session.run.is_some() {
            return Err(Error::invalid("Cannot restore a held Cursor Run"));
        }
        session.snapshot = snapshot;
        session.hydrated = true;
        Ok(())
    }
    pub async fn shutdown(&self) {
        let sessions = self
            .sessions
            .lock()
            .map(|mut sessions| std::mem::take(&mut *sessions))
            .unwrap_or_default();
        for session in sessions.into_values() {
            let mut session = session.lock().await;
            if let Some(run) = session.release_run() {
                run.writer.cancel();
            }
            session.pending = None;
        }
        self.client.shutdown().await;
    }
}
pub struct Config {
    pub common: providers::Config,
    pub identity: headers::Identity,
    pub context: RequestContext,
    pub runtime: Arc<Runtime>,
    pub agent: Option<transport::Endpoint>,
    pub known_mcp_servers: Vec<String>,
    pub unary_timeout_ms: u64,
    pub telemetry_enabled: bool,
    pub models: Vec<models::Info>,
    pub image_host: Option<Arc<dyn images::Host>>,
    pub image_environment: Option<images::Environment>,
    pub planning_host: Option<Arc<dyn planning::Host>>,
    pub planning_seed: fn() -> Result<u64, Error>,
    pub observations: Option<Arc<dyn observations::Host>>,
    pub persistence: Option<Arc<dyn persistence::Store>>,
    pub continuation: Continuation,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Continuation {
    pub heartbeat_ms: u64,
    pub semantic_idle_ms: u64,
    pub hard_cap_ms: u64,
}
impl Default for Continuation {
    fn default() -> Self {
        Self {
            heartbeat_ms: 5_000,
            semantic_idle_ms: 120_000,
            hard_cap_ms: 600_000,
        }
    }
}
impl Config {
    pub fn new(
        auth: Auth,
        identity: headers::Identity,
        context: RequestContext,
        runtime: Arc<Runtime>,
    ) -> Self {
        Self {
            common: providers::Config::new(auth),
            identity,
            context,
            runtime,
            agent: None,
            known_mcp_servers: Vec::new(),
            unary_timeout_ms: 5000,
            telemetry_enabled: false,
            models: Vec::new(),
            image_host: None,
            image_environment: None,
            planning_host: None,
            planning_seed: milliseconds,
            observations: None,
            persistence: None,
            continuation: Continuation::default(),
        }
    }
}
pub fn model(id: impl Into<LosslessString>, config: Config) -> Result<Model, Error> {
    validate(&config.continuation)?;
    let base = config
        .common
        .base_url
        .clone()
        .unwrap_or_else(|| "https://api2.cursor.sh".into());
    let endpoint = route::Endpoint::new(base, "/agent.v1.AgentService/Run");
    let auth = config.common.auth.clone();
    let defaults = config.common.defaults.clone();
    let route = route::Route {
        id: "cursor-connect".into(),
        provider: provider::Id("cursor".into()),
        provider_metadata_key: Some("cursor".into()),
        protocol: Arc::new(Cursor {
            provider: Provider { config },
        }),
        endpoint,
        auth,
        transport: route::Transport::Native,
        headers: BTreeMap::new(),
        defaults,
    };
    Ok(route.model(id))
}
fn validate(continuation: &Continuation) -> Result<(), Error> {
    for (name, value) in [
        ("heartbeatMs", continuation.heartbeat_ms),
        ("semanticIdleMs", continuation.semantic_idle_ms),
        ("hardCapMs", continuation.hard_cap_ms),
    ] {
        if value == 0 || value > MAX_TIMER_MS {
            return Err(Error::invalid(format!(
                "Cursor continuation {name} must be a positive integer no greater than {MAX_TIMER_MS}"
            )));
        }
    }
    if continuation.heartbeat_ms >= continuation.semantic_idle_ms {
        return Err(Error::invalid(
            "Cursor continuation heartbeatMs must be less than semanticIdleMs",
        ));
    }
    if continuation.semantic_idle_ms > continuation.hard_cap_ms {
        return Err(Error::invalid(
            "Cursor continuation semanticIdleMs must be no greater than hardCapMs",
        ));
    }
    Ok(())
}
const MAX_TIMER_MS: u64 = 2_147_483_647;
struct Cursor {
    provider: Provider,
}
impl Protocol for Cursor {
    fn native(&self) -> Option<&Provider> {
        Some(&self.provider)
    }
    fn id(&self) -> &'static str {
        "cursor-connect"
    }
    fn lower(&self, request: &Request) -> Result<JsonValue, Error> {
        Ok(json::object([
            (
                "model",
                json::s(models::wire_id(
                    &request.model.id,
                    request
                        .provider_options
                        .as_ref()
                        .and_then(|options| json::get(options, "cursor")),
                )),
            ),
            (
                "messages",
                JsonValue::Array(
                    request
                        .messages
                        .iter()
                        .map(|message| {
                            json::object([
                                ("role", json::s(role(message.role))),
                                ("content", json::s(text(message))),
                            ])
                        })
                        .collect(),
                ),
            ),
        ]))
    }
    fn parser(&self, _request: &Request) -> Box<dyn StreamParser> {
        Box::new(BinaryOnly)
    }
}
struct BinaryOnly;
impl StreamParser for BinaryOnly {
    fn push(&mut self, _event: &JsonValue) -> Result<Vec<Event>, Error> {
        Err(Error::invalid(
            "Cursor uses the native binary stream, not JSON framing",
        ))
    }
    fn finish(&mut self) -> Result<Vec<Event>, Error> {
        Err(Error::invalid(
            "Cursor JSON framing cannot certify binary completion",
        ))
    }
}
pub struct Provider {
    config: Config,
}
impl Provider {
    pub(crate) fn prepare(
        &self,
        route: &route::Route,
        request: Request,
    ) -> Result<Prepared, Error> {
        if request.http.body.is_some() || !request.http.query.is_empty() {
            return Err(Error::invalid(
                "Cursor binary Run does not accept JSON body or query overlays",
            ));
        }
        let selection = models::selection(
            &request.model.id,
            request
                .provider_options
                .as_ref()
                .and_then(|options| json::get(options, "cursor")),
            &self.config.models,
        )?;
        images::validate_user(
            &request.messages,
            images::supports(&selection.id, &self.config.models),
        )?;
        let body = route.protocol.lower(&request)?;
        let url = if let Some(agent) = &self.config.agent {
            reqwest::Url::parse(agent.url())
                .map_err(|_| Error::invalid("Cursor agent endpoint is invalid"))?
        } else {
            route.endpoint.render(&request, &body)?
        };
        let extra = route
            .headers
            .iter()
            .chain(request.http.headers.iter())
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        let id = request.id.clone().unwrap_or(uuid()?);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Error::invalid("Cursor request clock precedes Unix epoch"))?
            .as_millis() as u64;
        let headers = headers::run(
            &route.auth,
            &self.config.identity,
            &utf8(&id),
            now,
            url.as_str(),
            &extra,
        )?;
        Ok(Prepared {
            id,
            route: route.id.clone(),
            protocol: "cursor-connect",
            wire_body: body.clone(),
            encoded_body: stringify_json(&body),
            body,
            url,
            headers,
            request,
        })
    }
    pub(crate) async fn stream(
        &self,
        executor: &Executor,
        prepared: &Prepared,
        observer: Option<route::Observer>,
    ) -> Result<Stream, Error> {
        let session_key = ["x-session-id", "x-session-affinity", "x-ycoding-session"]
            .into_iter()
            .find_map(|key| {
                prepared
                    .headers
                    .get(key)
                    .and_then(|value| value.to_str().ok())
                    .filter(|value| !value.trim().is_empty())
                    .map(|value| value.trim().to_owned())
            });
        let request = &prepared.request;
        let results = trailing_results(request);
        let key = self
            .config
            .runtime
            .continuation_key(&results)?
            .or(session_key.clone())
            .unwrap_or(utf8(&uuid()?));
        let mut session = self.config.runtime.session(&key)?.lock_owned().await;
        if !session.hydrated {
            session.hydrated = true;
            if let (Some(store), Some(key)) = (&self.config.persistence, &session_key)
                && let persistence::Loaded::Restored(snapshot) =
                    store.load(&key.clone().into()).await
            {
                session.snapshot = snapshot;
            }
        }
        if session.pending.as_ref().is_some_and(|pending| {
            pending.started.elapsed() >= Duration::from_millis(self.config.continuation.hard_cap_ms)
                || !results.is_empty() && !results.iter().any(|result| result.id == pending.call.id)
        }) {
            if let Some(run) = session.release_run() {
                run.writer.cancel();
            }
            session.pending = None;
        }
        let fresh = results.is_empty() && session.pending.is_some();
        let cancelled = fresh
            .then(|| {
                session.pending.as_ref().map(|pending| ToolResult {
                    id: pending.call.id.clone(),
                    name: pending.call.name.clone(),
                    result: ToolResultValue::Error(json::s(
                        "Host started a new user turn before this tool result was delivered",
                    )),
                    cache: None,
                    provider_executed: None,
                    provider_metadata: None,
                    output: None,
                })
            })
            .flatten();
        let resumed = if let Some(pending) = session.pending.as_ref() {
            let delivered = async {
            let result = results
                .iter()
                .find(|result| result.id == pending.call.id)
                .copied()
                .or(cancelled.as_ref())
                .ok_or_else(|| {
                    Error::invalid("Cursor held Run requires its pending tool result")
                })?;
            let run = session
                .run
                .as_ref()
                .ok_or_else(|| Error::output("Cursor pending tool has no originating Run"))?;
            let output = utf8(&result.result.to_text());
            let value = if matches!(result.result, ToolResultValue::Error(_)) {
                Err(output.as_str())
            } else {
                Ok(output.as_str())
            };
            let refreshed_todos = if pending.call.name.as_str() == Some("todoread") && value.is_ok()
            {
                display::read_snapshot(&output)
            } else {
                None
            };
            match &pending.reply {
                Reply::Exec(exec) => {
                    run.writer
                        .write(
                            &exec
                                .mcp_result(value, pending.started.elapsed().as_millis() as u64)?,
                        )
                        .await?;
                    run.writer.write(&exec.close()?).await?;
                }
                Reply::Question(question) => run.writer.write(&question.answer(result)?).await?,
                Reply::Read {
                    exec,
                    request,
                    host,
                } => {
                    let reply = if matches!(result.result, ToolResultValue::Error(_)) {
                        observations::read_error(exec, request, 2, Some(&output))?
                    } else {
                        match host.observe_read(request, result).await {
                            Ok(view) => observations::read_success(
                                exec,
                                &view,
                                pending.started.elapsed().as_millis() as u64,
                            )?,
                            Err(error) => {
                                observations::read_error(exec, request, 2, Some(&error.message))?
                            }
                        }
                    };
                    run.writer.write(&reply).await?;
                    run.writer.write(&exec.close()?).await?;
                }
                Reply::Native(native) => {
                    run.writer
                        .write(
                            &native.result(result, pending.started.elapsed().as_millis() as u64)?,
                        )
                        .await?;
                    run.writer.write(&native.exec.close()?).await?;
                }
                Reply::Image {
                    exec,
                    id,
                    path,
                    bytes,
                } => {
                    let mut value = Vec::new();
                    protobuf::write_string(&mut value, 1, &path.clone().into())?;
                    let variant = if matches!(result.result, ToolResultValue::Error(_)) {
                        if let Some(reason) = output.strip_prefix(images::PERMISSION_DENIED) {
                            protobuf::write_string(
                                &mut value,
                                2,
                                &std::path::Path::new(path)
                                    .parent()
                                    .map(|path| path.to_string_lossy().into_owned())
                                    .unwrap_or_default()
                                    .into(),
                            )?;
                            protobuf::write_string(&mut value, 3, &"write".into())?;
                            protobuf::write_string(&mut value, 4, &reason.trim_start().into())?;
                            protobuf::write_varint(&mut value, 5, 0)?;
                            3
                        } else {
                            protobuf::write_string(&mut value, 2, &output.clone().into())?;
                            5
                        }
                    } else {
                        let receipt = self
                            .config
                            .runtime
                            .images
                            .receipt(id, milliseconds()?)?
                            .ok_or_else(|| {
                                Error::output(
                                    "Cursor image result has no permission-gated save receipt",
                                )
                            })?;
                        if receipt.bytes != *bytes {
                            return Err(Error::output(
                                "Cursor image receipt byte count does not match its originating write",
                            ));
                        }
                        protobuf::write_varint(&mut value, 2, 0)?;
                        protobuf::write_varint(&mut value, 3, *bytes as u64)?;
                        1
                    };
                    let mut write = Vec::new();
                    protobuf::write_bytes(&mut write, variant, &value)?;
                    run.writer.write(&exec.result(3, &write, None)?).await?;
                    run.writer.write(&exec.close()?).await?;
                    self.config.runtime.images.discard(id)?;
                }
                Reply::Display => {}
            }
            Ok::<_, Error>(refreshed_todos)
            }.await;
            session.pending = None;
            match delivered {
                Ok(todos) => {
                    if let Some(todos) = todos {
                        session.mirrored_todos = todos;
                    }
                    true
                }
                Err(error) => {
                    if let Some(run) = session.release_run() {
                        run.writer.cancel();
                    }
                    if error.reason != crate::provider_error::Reason::Transport {
                        return Err(error);
                    }
                    false
                }
            }
        } else {
            false
        };
        if fresh && resumed {
            let drained = tokio::time::timeout(Duration::from_secs(8), async {
                loop {
                    let frame = session
                        .run
                        .as_mut()
                        .ok_or_else(|| Error::output("Cursor fresh-turn drain has no Run"))?
                        .reader
                        .next()
                        .await?
                        .ok_or_else(Error::missing_terminal)?;
                    let batch = session
                        .state
                        .push(&framing::encode(frame.flags, &frame.payload)?)?;
                    session.snapshot.checkpoint = session.state.checkpoint().map(<[u8]>::to_vec);
                    session.snapshot.blobs = session.state.blobs().clone();
                    for reply in batch.replies {
                        session
                            .run
                            .as_ref()
                            .ok_or_else(|| Error::output("Cursor drain reply has no Run"))?
                            .writer
                            .write(&reply)
                            .await?;
                    }
                    if batch
                        .events
                        .iter()
                        .any(|event| matches!(event, Event::Finish(_)))
                    {
                        return Ok::<_, Error>(());
                    }
                    if batch.controls.iter().any(|control| {
                        !matches!(
                            control,
                            ServerMessage::Interaction(
                                Update::Heartbeat
                                    | Update::PartialTool(_)
                                    | Update::StepStarted(_)
                                    | Update::StepCompleted(_)
                            )
                        )
                    }) {
                        return Err(Error::output("Cursor fresh-turn drain requires host input"));
                    }
                }
            })
            .await;
            if drained.is_ok_and(|result| result.is_ok())
                && let (Some(store), Some(key)) = (&self.config.persistence, &session_key)
            {
                store.save(&key.clone().into(), &session.snapshot).await;
            }
            if let Some(run) = session.release_run() {
                run.writer.cancel();
            }
        }
        if !resumed || fresh {
            if !results.is_empty() {
                session.snapshot.conversation_id = uuid()?;
                session.snapshot.checkpoint = None;
                session.snapshot.blobs.clear();
                session.image_hashes.clear();
            }
            if let Some(run) = session.release_run() {
                run.writer.cancel();
            }
            let endpoint = if let Some(agent) = &self.config.agent {
                agent.clone()
            } else {
                self.discover(executor, prepared).await?
            };
            let mut run_request = RunRequest::new(
                session.snapshot.conversation_id.clone(),
                uuid()?,
                request.model.id.clone(),
                "",
            );
            let newest = request
                .messages
                .iter()
                .rposition(|message| message.role == Role::User);
            let user = newest.map(|index| text(&request.messages[index]));
            let continuing = !results.is_empty();
            run_request.action = Action::User;
            if continuing {
                run_request.text = "Continue the interrupted turn from the conversation history above. Do not repeat completed work.".into();
            }
            if !continuing {
                run_request.text = user.clone().unwrap_or_default();
                if !matches!(request.tool_choice, Some(ToolChoice::None))
                    && let Some(reminder) =
                        planning::reminder(&mut session.planning, &request.tools)
                {
                    run_request.text = join([run_request.text, reminder.into()].into_iter());
                }
            }
            run_request.system_prompt =
                Some(join(request.system.iter().map(|part| part.text.clone())));
            run_request.history = request
                .messages
                .iter()
                .enumerate()
                .filter(|(index, _)| continuing || Some(*index) != newest)
                .map(|(_, message)| History::new(role(message.role), text(message)))
                .collect();
            run_request.checkpoint = session.snapshot.checkpoint.clone();
            let mut incoming = request.tools.clone();
            incoming.sort_by(|left, right| left.name.cmp(&right.name));
            for tool in incoming {
                let descriptor = descriptor(&tool, &self.config.known_mcp_servers);
                if !session.snapshot.descriptors.iter().any(|known| {
                    known.provider == descriptor.provider && known.tool_name == descriptor.tool_name
                }) {
                    session.snapshot.descriptors.push(descriptor);
                }
            }
            run_request.descriptors = session.snapshot.descriptors.clone();
            run_request.request_context = Some(context::materialize(
                self.config.context.bytes(),
                &run_request.descriptors,
            )?);
            let selection = models::selection(
                &request.model.id,
                request
                    .provider_options
                    .as_ref()
                    .and_then(|options| json::get(options, "cursor")),
                &self.config.models,
            )?;
            let (selected_images, image_hashes) = images::extract(
                &request.messages,
                images::supports(&selection.id, &self.config.models),
                &session.image_hashes,
                self.config.image_host.as_deref(),
            )
            .await?;
            run_request.images = selected_images;
            run_request.model_id = selection.id;
            run_request.parameters = selection.parameters;
            run_request.max_mode = selection.max_mode;
            let run = self
                .config
                .runtime
                .client
                .open(&endpoint, prepared.headers.clone())
                .await?;
            run.writer.write(&run_request.encode()?).await?;
            for hash in image_hashes {
                session.image_hashes.retain(|prior| prior != &hash);
                session.image_hashes.push_back(hash);
                while session.image_hashes.len() > 256 {
                    session.image_hashes.pop_front();
                }
            }
            session.state = State::new();
            let snapshot = session.snapshot.clone();
            session.state.restore_checkpoint(snapshot.checkpoint);
            session.state.restore_blobs(snapshot.blobs);
            session.snapshot.last_user = user;
            session.run_id = uuid()?;
            session.heartbeat = Some(Heartbeat::start(
                run.writer.clone(),
                self.config.continuation.heartbeat_ms,
            ));
            session.run = Some(run);
        }
        let context = RequestContext(context::materialize(
            self.config.context.bytes(),
            &session.snapshot.descriptors,
        )?);
        Ok(Stream {
            session,
            events: VecDeque::from([Event::StepStart { index: 0.0 }]),
            halted: false,
            tools: if matches!(request.tool_choice, Some(ToolChoice::None)) {
                Vec::new()
            } else {
                request.tools.clone()
            },
            context,
            tracker: Tracker::new(prepared, "cursor-connect", observer),
            runtime: self.config.runtime.clone(),
            image_environment: self.config.image_environment.clone(),
            image_host: self.config.image_host.is_some(),
            session_key: session_key.map(Into::into),
            planning_host: self.config.planning_host.clone(),
            planning_seed: self.config.planning_seed,
            observations: self.config.observations.clone(),
            persistence: self.config.persistence.clone(),
            semantic_idle: Duration::from_millis(self.config.continuation.semantic_idle_ms),
            semantic_deadline: Instant::now()
                + Duration::from_millis(self.config.continuation.semantic_idle_ms),
        })
    }
    async fn discover(
        &self,
        executor: &Executor,
        _prepared: &Prepared,
    ) -> Result<transport::Endpoint, Error> {
        unary::agent_url(
            executor,
            &self.config.common.auth,
            &self.config.identity,
            &unary::Options {
                base_url: self
                    .config
                    .common
                    .base_url
                    .clone()
                    .unwrap_or_else(|| "https://api2.cursor.sh".into()),
                timeout_ms: self.config.unary_timeout_ms,
                telemetry_enabled: self.config.telemetry_enabled,
                headers: BTreeMap::new(),
            },
        )
        .await
    }
}
pub struct Stream {
    session: OwnedMutexGuard<Session>,
    events: VecDeque<Event>,
    halted: bool,
    tools: Vec<ToolDefinition>,
    context: RequestContext,
    tracker: Tracker,
    runtime: Arc<Runtime>,
    image_environment: Option<images::Environment>,
    image_host: bool,
    session_key: Option<LosslessString>,
    planning_host: Option<Arc<dyn planning::Host>>,
    planning_seed: fn() -> Result<u64, Error>,
    observations: Option<Arc<dyn observations::Host>>,
    persistence: Option<Arc<dyn persistence::Store>>,
    semantic_idle: Duration,
    semantic_deadline: Instant,
}
impl Stream {
    fn ground(&self, reason: &str) -> String {
        context::ground(
            reason,
            context::workspace_root(self.context.bytes()).as_deref(),
        )
    }
    fn semantic_timeout(&self) -> Error {
        errors::diagnostic(
            Error {
                code: Some("CURSOR_SEMANTIC_IDLE_TIMEOUT".into()),
                ..Error::transport(
                    format!(
                        "Cursor semantic-progress timeout after {}ms",
                        self.semantic_idle.as_millis()
                    ),
                    "read",
                )
            },
            "transport",
            true,
            true,
        )
    }
    pub async fn next(&mut self) -> Result<Option<Event>, Error> {
        let mut result = self.next_inner().await;
        if let Err(error) = &mut result {
            if !self.session.state.replay_safe(true) {
                errors::set_flag(error, "replaySafe", false);
                errors::set_flag(error, "transient", false);
            }
            self.tracker.settle(false, true, None);
            self.halted = true;
            self.events.clear();
            if let Some(run) = self.session.release_run() {
                run.writer.cancel();
            }
            self.session.pending = None;
            self.session.planning.terminal_target = None;
        }
        result
    }
    async fn next_inner(&mut self) -> Result<Option<Event>, Error> {
        loop {
            if let Some(event) = self.events.pop_front() {
                return Ok(Some(event));
            }
            if self.halted {
                return Ok(None);
            }
            let bounded = self.session.pending.is_none();
            let next = self
                .session
                .run
                .as_mut()
                .ok_or_else(|| Error::output("Cursor stream has no Run"))?
                .reader
                .next();
            let frame = if bounded {
                tokio::time::timeout(
                    self.semantic_deadline
                        .saturating_duration_since(Instant::now()),
                    next,
                )
                .await
                .map_err(|_| self.semantic_timeout())??
            } else {
                next.await?
            }
            .ok_or_else(Error::missing_terminal)?;
            let batch = self
                .session
                .state
                .push(&framing::encode(frame.flags, &frame.payload)?)?;
            self.session.snapshot.checkpoint = self.session.state.checkpoint().map(<[u8]>::to_vec);
            self.session.snapshot.blobs = self.session.state.blobs().clone();
            for reply in batch.replies {
                self.session
                    .run
                    .as_ref()
                    .ok_or_else(|| Error::output("Cursor control reply has no Run"))?
                    .writer
                    .write(&reply)
                    .await?;
            }
            if batch.progress {
                self.semantic_deadline = Instant::now() + self.semantic_idle;
            }
            let turn_ended = batch
                .events
                .iter()
                .any(|event| matches!(event, Event::Finish(_)));
            for event in batch.events {
                if let Event::Finish(finish) = &event {
                    self.events.push_back(Event::StepFinish {
                        index: 0.0,
                        finish: finish.clone(),
                    });
                }
                self.events.push_back(event);
            }
            if turn_ended && let (Some(store), Some(key)) = (&self.persistence, &self.session_key) {
                store.save(key, &self.session.snapshot).await;
            }
            for control in batch.controls {
                match control {
                    ServerMessage::Exec(exec) if exec.variant == 10 => {
                        let mut success = Vec::new();
                        protobuf::write_bytes(&mut success, 1, self.context.bytes())?;
                        let mut result = Vec::new();
                        protobuf::write_bytes(&mut result, 1, &success)?;
                        self.reply(&exec, &exec.result(10, &result, None)?).await?;
                    }
                    ServerMessage::Exec(exec) if exec.variant == 36 => {
                        self.reply(&exec, &context::mcp_state(&exec, self.context.bytes())?)
                            .await?;
                    }
                    ServerMessage::Exec(exec) if exec.variant == 7 => {
                        let fields = protobuf::fields(&exec.args)?;
                        let path = fields
                            .iter()
                            .rev()
                            .find(|field| field.number == 1)
                            .map(|field| field.text())
                            .transpose()?
                            .unwrap_or_default();
                        let offset = fields
                            .iter()
                            .rev()
                            .find(|field| field.number == 4)
                            .map(|field| field.uint32())
                            .transpose()?
                            .filter(|value| *value as i32 > 0);
                        let limit = fields
                            .iter()
                            .rev()
                            .find(|field| field.number == 5)
                            .map(|field| field.uint32())
                            .transpose()?
                            .filter(|value| *value > 0);
                        let request = observations::ReadRequest {
                            session_id: self.session_key.clone().unwrap_or_default(),
                            path: path.into(),
                            offset,
                            limit,
                        };
                        let Some(host) = self.observations.clone().filter(|_| {
                            self.session_key.is_some()
                                && self
                                    .tools
                                    .iter()
                                    .any(|tool| tool.name.as_str() == Some("read"))
                        }) else {
                            self.reply(&exec, &observations::read_error(&exec, &request, 2, Some("Native read requires an advertised read tool and Location-owned observation host"))?).await?;
                            continue;
                        };
                        let path_kind = host.inspect_read(&request).await;
                        let denied = match path_kind {
                            Ok(observations::ReadPath::Regular) => None,
                            Ok(observations::ReadPath::Missing) => Some((4, None)),
                            Ok(observations::ReadPath::PermissionDenied) => Some((5, None)),
                            Ok(observations::ReadPath::Invalid(reason)) => Some((6, Some(reason))),
                            Err(error) => Some((2, Some(error.message))),
                        };
                        if let Some((kind, reason)) = denied {
                            self.reply(
                                &exec,
                                &observations::read_error(
                                    &exec,
                                    &request,
                                    kind,
                                    reason.as_deref(),
                                )?,
                            )
                            .await?;
                            continue;
                        }
                        let mut input = json::object([("path", json::s(request.path.clone()))]);
                        if let Some(offset) = offset {
                            json::set(&mut input, "offset", JsonValue::Number(f64::from(offset)));
                        }
                        if let Some(limit) = limit {
                            json::set(&mut input, "limit", JsonValue::Number(f64::from(limit)));
                        }
                        let (name, input) = tools::map("read", &input, &self.tools)?;
                        self.host_call(
                            format!("cursor_{}_{}", utf8(&self.session.run_id), exec.id),
                            &name,
                            input,
                            Reply::Read {
                                exec,
                                request,
                                host,
                            },
                        );
                    }
                    ServerMessage::Exec(exec) if exec.variant == 11 => {
                        let call = exec.mcp()?.ok_or_else(|| {
                            Error::output("Cursor MCP request is missing its arguments")
                        })?;
                        let name = if let Some(name) = call.tool_name {
                            if let Some(provider) =
                                call.provider.filter(|provider| provider != "opencode")
                            {
                                if name.starts_with(&format!("{provider}_")) {
                                    name
                                } else {
                                    format!("{provider}_{name}")
                                }
                            } else {
                                name
                            }
                        } else if let Some((provider, name)) = call.name.split_once('-') {
                            if provider == "opencode" {
                                name.to_owned()
                            } else {
                                format!("{provider}_{name}")
                            }
                        } else {
                            call.name
                        };
                        let (name, input) = tools::map(&name, &call.input, &self.tools)?;
                        if !self
                            .tools
                            .iter()
                            .any(|tool| tool.name.as_str() == Some(&name))
                        {
                            let reason = self.ground("The requested host tool is not available for this step; use an advertised tool");
                            self.reply(&exec, &exec.mcp_result(Err(&reason), 0)?)
                                .await?;
                            continue;
                        }
                        self.host_call(
                            format!("cursor_{}_{}", utf8(&self.session.run_id), exec.id),
                            &name,
                            input,
                            Reply::Exec(exec),
                        );
                    }
                    ServerMessage::Exec(exec) if exec.variant == 3 => {
                        if let Some(native) = tools::native(exec.clone(), &self.tools)? {
                            if !self
                                .tools
                                .iter()
                                .any(|tool| tool.name.as_str() == Some(&native.name))
                            {
                                let reason = self.ground("The requested host tool is not available for this step; use an advertised tool");
                                self.reply(&native.exec, &native.output(&reason, true, 0)?)
                                    .await?;
                                continue;
                            }
                            self.host_call(
                                format!("cursor_{}_{}", utf8(&self.session.run_id), exec.id),
                                &native.name.clone(),
                                native.input.clone(),
                                Reply::Native(native),
                            );
                            continue;
                        }
                        let args = protobuf::fields(&exec.args)?;
                        let path = args
                            .iter()
                            .rev()
                            .find(|field| field.number == 1)
                            .map(|field| field.text())
                            .transpose()?
                            .unwrap_or_default();
                        let data = args.iter().rev().find(|field| field.number == 5).map(|field| field.bytes()).transpose()?.filter(|bytes| !bytes.is_empty()).ok_or_else(|| Error::output("Cursor native text write has no supported host observation codec"))?;
                        let Some(environment) = self.image_environment.as_ref().filter(|_| {
                            self.session_key.is_some()
                                && self.image_host
                                && self
                                    .tools
                                    .iter()
                                    .any(|tool| tool.name.as_str() == Some(images::SAVE_TOOL))
                        }) else {
                            let mut error = Vec::new();
                            protobuf::write_string(&mut error, 1, &path.into())?;
                            protobuf::write_string(&mut error, 2, &self.ground("This OpenCode agent cannot write binary file content. Do not retry this write with the same bytes.").into())?;
                            let mut result = Vec::new();
                            protobuf::write_bytes(&mut result, 5, &error)?;
                            self.reply(&exec, &exec.result(3, &result, Some(0))?)
                                .await?;
                            continue;
                        };
                        if let Some(message) = images::size_refusal(data.len()) {
                            let mut error = Vec::new();
                            protobuf::write_string(&mut error, 1, &path.into())?;
                            protobuf::write_string(&mut error, 2, &self.ground(&message).into())?;
                            let mut result = Vec::new();
                            protobuf::write_bytes(&mut result, 5, &error)?;
                            self.reply(&exec, &exec.result(3, &result, Some(0))?)
                                .await?;
                            continue;
                        }
                        let target = images::map_target(&path, environment)?;
                        let bytes = data.len();
                        let id = self.runtime.images.stage(
                            images::StagedImage {
                                path: target.clone(),
                                environment: environment.clone(),
                                mime: images::mime_for_path(&target).into(),
                                data: data.to_vec(),
                                session_id: self.session_key.clone().ok_or_else(|| {
                                    Error::invalid(
                                        "Cursor image saves require a backend Session key",
                                    )
                                })?,
                            },
                            milliseconds()?,
                        )?;
                        let input = json::object([("image_id", json::s(id.clone()))]);
                        let call_id = format!("cursor_{}_{}", utf8(&self.session.run_id), exec.id);
                        self.host_call(
                            call_id,
                            images::SAVE_TOOL,
                            input,
                            Reply::Image {
                                exec,
                                id,
                                path: target.to_string_lossy().into_owned(),
                                bytes,
                            },
                        );
                    }
                    ServerMessage::Exec(exec) => {
                        let Some(native) = tools::native(exec, &self.tools)? else {
                            return Err(Error::output(
                                "Cursor native exec has no supported host bridge",
                            ));
                        };
                        let error = native.local_error.or_else(|| (!self.tools.iter().any(|tool| tool.name.as_str() == Some(&native.name))).then_some("The requested host tool is not available for this step; use an advertised tool"));
                        if let Some(error) = error {
                            let reason = self.ground(error);
                            self.reply(&native.exec, &native.output(&reason, true, 0)?)
                                .await?;
                            continue;
                        }
                        let id =
                            format!("cursor_{}_{}", utf8(&self.session.run_id), native.exec.id);
                        let input = native.input.clone();
                        let name = native.name.clone();
                        self.host_call(id, &name, input, Reply::Native(native));
                    }
                    ServerMessage::InteractionQuery(bytes) => {
                        if let Some(outcome) = planning::query(
                            &bytes,
                            &self.session.planning,
                            &self.tools,
                            self.session_key.as_ref(),
                            self.planning_host.as_deref(),
                            self.planning_seed,
                        )
                        .await?
                        {
                            self.write(&outcome.reply).await?;
                            if let Some(mode) = outcome.mode {
                                self.session.planning.mode = Some(mode);
                            }
                            if let Some(target) = outcome.terminal_target {
                                self.session.planning.terminal_target = Some(target);
                            }
                            continue;
                        }
                        let can_question = self
                            .tools
                            .iter()
                            .any(|tool| tool.name.as_str() == Some("question"));
                        let can_save = self.session_key.is_some()
                            && self.image_host
                            && self.image_environment.is_some()
                            && self
                                .tools
                                .iter()
                                .any(|tool| tool.name.as_str() == Some(images::SAVE_TOOL));
                        match interactions::query(&bytes, can_question, can_save)? {
                            interactions::Action::Reply(reply) => self.write(&reply).await?,
                            interactions::Action::Question(question) => {
                                if question.asynchronous {
                                    self.write(&question.acknowledgement()?).await?;
                                }
                                let id = format!(
                                    "cursor_{}_question_{}",
                                    utf8(&self.session.run_id),
                                    question.id
                                );
                                let input = question.input();
                                self.host_call(id, "question", input, Reply::Question(question));
                            }
                        }
                    }
                    ServerMessage::Interaction(Update::ToolCompleted(bytes)) => {
                        if let Some(call) =
                            display::completed(&bytes, &self.session.mirrored_todos)?
                            && self
                                .tools
                                .iter()
                                .any(|tool| tool.name.as_str() == Some(call.name))
                        {
                            if let Some(todos) = call.todos {
                                self.session.mirrored_todos = todos
                                    .into_iter()
                                    .filter(|todo| {
                                        json::get(todo, "id")
                                            .and_then(json::string)
                                            .is_none_or(|id| id != &"plan".into())
                                    })
                                    .collect();
                            }
                            self.host_call(
                                format!(
                                    "cursor_{}_display_{}",
                                    utf8(&self.session.run_id),
                                    call.id
                                ),
                                call.name,
                                call.input,
                                Reply::Display,
                            );
                        }
                    }
                    ServerMessage::Interaction(
                        Update::ToolStarted(_)
                        | Update::PartialTool(_)
                        | Update::StepStarted(_)
                        | Update::StepCompleted(_),
                    )
                    | ServerMessage::ExecControl(_) => {}
                    _ => {
                        return Err(Error::output(
                            "Cursor requested a native control without an implemented host bridge",
                        ));
                    }
                }
            }
            if self.events.iter().any(|event| {
                matches!(
                    event,
                    Event::Finish(Finish {
                        reason: FinishReason::Stop,
                        ..
                    })
                )
            }) {
                self.session.state.finish()?;
                if let Some(run) = self.session.release_run() {
                    run.writer.close().await?;
                }
                self.halted = true;
                if let Some(target) = self.session.planning.terminal_target.take()
                    && let (Some(host), Some(key)) =
                        (self.planning_host.as_ref(), self.session_key.as_ref())
                {
                    host.switch_agent(key, &target).await?;
                }
                self.tracker.settle(true, true, Some(200));
            }
        }
    }
    async fn reply(&self, exec: &Exec, bytes: &[u8]) -> Result<(), Error> {
        let run = self
            .session
            .run
            .as_ref()
            .ok_or_else(|| Error::output("Cursor exec reply has no originating Run"))?;
        run.writer.write(bytes).await?;
        run.writer.write(&exec.close()?).await
    }
    async fn write(&self, bytes: &[u8]) -> Result<(), Error> {
        self.session
            .run
            .as_ref()
            .ok_or_else(|| Error::output("Cursor interaction reply has no originating Run"))?
            .writer
            .write(bytes)
            .await
    }
    fn host_call(&mut self, id: String, name: &str, input: JsonValue, reply: Reply) {
        if name == "todowrite"
            && matches!(&reply, Reply::Exec(_))
            && let Some(todos) = json::get(&input, "todos").and_then(display::snapshot)
        {
            self.session.mirrored_todos = todos;
        }
        let call = ToolCall {
            id: id.into(),
            name: name.into(),
            input,
            provider_executed: Some(false),
            provider_metadata: None,
        };
        self.events.extend(self.session.state.close_spans());
        self.events.push_back(Event::ToolCall(call.clone()));
        let finish = Finish {
            reason: FinishReason::ToolCalls,
            usage: None,
            provider_metadata: None,
        };
        self.events.push_back(Event::StepFinish {
            index: 0.0,
            finish: finish.clone(),
        });
        self.events.push_back(Event::Finish(finish));
        self.session.pending = Some(Pending {
            reply,
            call,
            started: Instant::now(),
        });
        self.halted = true;
        self.tracker.settle(true, true, Some(200));
    }
}
impl Drop for Stream {
    fn drop(&mut self) {
        if !self.halted {
            if let Some(run) = self.session.release_run() {
                run.writer.cancel();
            }
            self.session.pending = None;
        }
    }
}
fn trailing_results(request: &Request) -> Vec<&ToolResult> {
    request
        .messages
        .iter()
        .rev()
        .take_while(|message| message.role == Role::Tool)
        .flat_map(|message| {
            message.content.iter().filter_map(|part| {
                if let Part::ToolResult(result) = part {
                    Some(result)
                } else {
                    None
                }
            })
        })
        .collect()
}
fn text(message: &Message) -> LosslessString {
    join(message.content.iter().filter_map(|part| {
        match part {
            Part::Text(text) => Some(text.text.clone()),
            Part::ToolCall(call) => Some(
                format!(
                    "Tool call {}: {}",
                    utf8(&call.name),
                    stringify_json(&call.input)
                )
                .into(),
            ),
            Part::ToolResult(result) => Some(
                format!(
                    "Tool result {}: {}",
                    utf8(&result.name),
                    utf8(&result.result.to_text())
                )
                .into(),
            ),
            _ => None,
        }
    }))
}
fn join(values: impl Iterator<Item = LosslessString>) -> LosslessString {
    let values = values.collect::<Vec<_>>();
    LosslessString::from_utf16(
        values
            .iter()
            .enumerate()
            .flat_map(|(index, value)| {
                if index == 0 {
                    value.code_units().collect::<Vec<_>>()
                } else {
                    [vec![10, 10], value.code_units().collect()].concat()
                }
            })
            .collect(),
    )
}
fn utf8(value: &LosslessString) -> String {
    String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>())
}
fn role(role: Role) -> &'static str {
    match role {
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::System => "system",
        Role::Tool => "tool",
    }
}
fn descriptor(tool: &ToolDefinition, servers: &[String]) -> Descriptor {
    let name = utf8(&tool.name);
    let mut servers = servers
        .iter()
        .map(|server| {
            server
                .chars()
                .map(|ch| {
                    if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                        ch
                    } else {
                        '_'
                    }
                })
                .collect::<String>()
        })
        .filter(|server| !server.is_empty())
        .collect::<Vec<_>>();
    servers.sort_by_key(|server| std::cmp::Reverse(server.len()));
    let identity = servers
        .iter()
        .find_map(|server| {
            name.strip_prefix(&format!("{server}_"))
                .filter(|bare| !bare.is_empty())
                .map(|bare| (server.as_str(), bare))
        })
        .unwrap_or(("opencode", name.as_str()));
    Descriptor {
        name: format!("{}-{}", identity.0, identity.1).into(),
        description: tool.description.clone(),
        input_schema: tool.input_schema.clone(),
        provider: identity.0.into(),
        tool_name: identity.1.into(),
    }
}
pub(crate) fn uuid() -> Result<LosslessString, Error> {
    let mut bytes = [0u8; 16];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes)
        .map_err(|_| Error::transport("Cursor identity randomness failed", "identity"))?;
    bytes[6] = bytes[6] & 0x0f | 0x40;
    bytes[8] = bytes[8] & 0x3f | 0x80;
    Ok(format!("{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",bytes[0],bytes[1],bytes[2],bytes[3],bytes[4],bytes[5],bytes[6],bytes[7],bytes[8],bytes[9],bytes[10],bytes[11],bytes[12],bytes[13],bytes[14],bytes[15]).into())
}
fn milliseconds() -> Result<u64, Error> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_millis() as u64)
        .map_err(|_| Error::invalid("Cursor image clock precedes Unix epoch"))
}
