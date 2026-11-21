use super::{Error, field, string};
use crate::dots::{
    access::{ConversationProblem as Problem, UpstreamRejection},
    enrollment::cca_headers,
    native::{Configuration, Host, Subscription},
};
use ring::rand::{SecureRandom, SystemRandom};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
    time::Instant,
};
use tokio_tungstenite::tungstenite::{
    Message,
    client::IntoClientRequest,
    http::{HeaderValue, Request},
};
use ycoding_schema::{JsonValue, ObjectEncoder, parse_json, stringify_json};

pub type SocketFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub enum SocketError {
    Read,
    Write,
}
pub trait Socket: Send {
    fn ready(&mut self) -> SocketFuture<'_, Result<(), SocketError>>;
    fn start_send(&mut self, message: Message) -> Result<(), SocketError>;
    fn flush(&mut self) -> SocketFuture<'_, Result<(), SocketError>>;
    fn next(&mut self) -> SocketFuture<'_, Option<Result<Message, SocketError>>>;
}
pub struct ConnectError {
    pub status: Option<u16>,
}
pub type Connect = Arc<
    dyn Fn(Request<()>) -> SocketFuture<'static, Result<Box<dyn Socket>, ConnectError>>
        + Send
        + Sync,
>;
type Wire = Box<dyn Socket>;

struct Delivery {
    submitted: bool,
    result: Option<Reply>,
}
struct Dispatch {
    deadline: Instant,
    delivery: Mutex<Delivery>,
}
impl Dispatch {
    fn finish(&self, reply: Reply) -> Reply {
        let mut delivery = self
            .delivery
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(result) = &delivery.result {
            return result.clone();
        }
        let reply = if matches!(reply, Reply::Unknown) && !delivery.submitted {
            Reply::NotSent
        } else {
            reply
        };
        delivery.result = Some(reply.clone());
        reply
    }
    fn expire(&self) -> Reply {
        self.finish(Reply::Unknown)
    }
}
struct Cancellation(Arc<Dispatch>);
impl Cancellation {
    async fn wait(self, answer: oneshot::Receiver<Reply>) -> Reply {
        match tokio::time::timeout_at(self.0.deadline, answer).await {
            Ok(Ok(reply)) => reply,
            _ => self.0.expire(),
        }
    }
}
impl Drop for Cancellation {
    fn drop(&mut self) {
        self.0.expire();
    }
}
struct Answer {
    dispatch: Arc<Dispatch>,
    sender: Option<oneshot::Sender<Reply>>,
}
impl Answer {
    fn channel(deadline: Instant) -> (Self, oneshot::Receiver<Reply>, Cancellation) {
        let dispatch = Arc::new(Dispatch {
            deadline,
            delivery: Mutex::new(Delivery {
                submitted: false,
                result: None,
            }),
        });
        let (sender, receiver) = oneshot::channel();
        let cancel = Cancellation(dispatch.clone());
        (
            Self {
                dispatch,
                sender: Some(sender),
            },
            receiver,
            cancel,
        )
    }
    fn observe(deadline: Instant) -> Self {
        Self {
            dispatch: Arc::new(Dispatch {
                deadline,
                delivery: Mutex::new(Delivery {
                    submitted: false,
                    result: None,
                }),
            }),
            sender: None,
        }
    }
    fn send(self, reply: Reply) -> Result<(), Reply> {
        let reply = self.dispatch.finish(reply);
        match self.sender {
            Some(sender) => sender.send(reply),
            None => Ok(()),
        }
    }
    fn join(&self) -> bool {
        let mut delivery = self
            .dispatch
            .delivery
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if delivery.result.is_some() || self.dispatch.deadline <= Instant::now() {
            return false;
        }
        delivery.submitted = true;
        true
    }
    fn submitted(&self) -> bool {
        self.dispatch
            .delivery
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .submitted
    }
}

#[derive(Clone)]
pub(super) enum Reply {
    Result(JsonValue),
    Rejected(UpstreamRejection),
    NotSent,
    Unknown,
    Stale,
}
impl Reply {
    pub fn result(self) -> Result<JsonValue, Error> {
        match self {
            Self::Result(value) => Ok(value),
            Self::Rejected(rejection) => Err(Error {
                problem: Problem::Rejected,
                rejection: Some(rejection),
            }),
            Self::Stale => Err(Error::new(Problem::Stale)),
            _ => Err(Error::new(Problem::DurableUnavailable)),
        }
    }
    pub fn archived(&self) -> bool {
        match self {
            Self::Rejected(rejection) => {
                rejection.error_type.as_deref() == Some("thread_archived")
                    || rejection.message.as_ref().is_some_and(|message| {
                        let message = message.to_ascii_lowercase();
                        let phrase = "is archived";
                        message.match_indices(phrase).any(|(index, _)| {
                            !message[index + phrase.len()..]
                                .bytes()
                                .next()
                                .is_some_and(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                        })
                    })
            }
            _ => false,
        }
    }
}

#[derive(Clone)]
pub(super) struct Pending {
    pub id: String,
    raw_id: JsonValue,
    pub method: String,
    pub params: JsonValue,
}

#[derive(Default)]
struct Shared {
    configuration: Option<Configuration>,
    requests: BTreeMap<String, Pending>,
}

enum Command {
    Request {
        configuration: Configuration,
        method: &'static str,
        params: JsonValue,
        deadline: Instant,
        reply: Answer,
        subscription: Option<String>,
        force: bool,
    },
    Answer {
        configuration: Configuration,
        thread: String,
        id: String,
        result: JsonValue,
        reply: Answer,
    },
}

pub(super) struct Durable {
    commands: mpsc::Sender<Command>,
    shared: Arc<Mutex<Shared>>,
    stop: watch::Sender<bool>,
    task: Mutex<Option<JoinHandle<()>>>,
    _subscription: Mutex<Subscription>,
}

pub(super) fn request_id() -> Result<String, Error> {
    let mut bytes = [0u8; 16];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| Error::new(Problem::Connection))?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let hex = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

impl Durable {
    pub fn start(host: Host, owner: Arc<dyn Fn() -> bool + Send + Sync>, connect: Connect) -> Self {
        let (commands, receiver) = mpsc::channel(256);
        let (stop, stopped) = watch::channel(false);
        let (changed, changes) = watch::channel(());
        let subscription = host.subscribe_configuration(Arc::new(move || {
            changed.send_replace(());
        }));
        let shared = Arc::new(Mutex::new(Shared::default()));
        let task = tokio::spawn(run(
            host,
            owner,
            connect,
            receiver,
            shared.clone(),
            stopped,
            changes,
        ));
        Self {
            commands,
            shared,
            stop,
            task: Mutex::new(Some(task)),
            _subscription: Mutex::new(subscription),
        }
    }

    pub fn connected(&self, configuration: &Configuration) -> bool {
        self.shared
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .configuration
            .as_ref()
            == Some(configuration)
    }

    pub async fn request(
        &self,
        configuration: &Configuration,
        method: &'static str,
        params: JsonValue,
        seconds: u64,
    ) -> Reply {
        self.call(configuration, method, params, seconds, None, false)
            .await
    }

    pub async fn watch(&self, configuration: &Configuration, thread: &str, force: bool) -> Reply {
        self.call(
            configuration,
            "thread/resume",
            ObjectEncoder::new()
                .field("threadId", thread)
                .field("excludeTurns", &true)
                .finish(),
            120,
            Some(thread.to_owned()),
            force,
        )
        .await
    }

    pub fn observe(&self, configuration: &Configuration, thread: &str) {
        let deadline = Instant::now() + Duration::from_secs(120);
        let reply = Answer::observe(deadline);
        if self
            .commands
            .try_send(Command::Request {
                configuration: configuration.clone(),
                method: "thread/resume",
                params: ObjectEncoder::new()
                    .field("threadId", thread)
                    .field("excludeTurns", &true)
                    .finish(),
                deadline,
                reply,
                subscription: Some(thread.into()),
                force: false,
            })
            .is_err()
        {
            tracing::warn!("Dots thread observation queue is full or closed");
        }
    }

    async fn call(
        &self,
        configuration: &Configuration,
        method: &'static str,
        params: JsonValue,
        seconds: u64,
        subscription: Option<String>,
        force: bool,
    ) -> Reply {
        if !self.connected(configuration) {
            return Reply::NotSent;
        }
        let deadline = Instant::now() + Duration::from_secs(seconds);
        let (reply, answer, cancel) = Answer::channel(deadline);
        if self
            .commands
            .try_send(Command::Request {
                configuration: configuration.clone(),
                method,
                params,
                deadline,
                reply,
                subscription,
                force,
            })
            .is_err()
        {
            return Reply::NotSent;
        }
        cancel.wait(answer).await
    }

    pub fn pending(&self, configuration: &Configuration, thread: &str) -> Vec<Pending> {
        let shared = self
            .shared
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if shared.configuration.as_ref() != Some(configuration) {
            return Vec::new();
        }
        shared
            .requests
            .values()
            .filter(|entry| string(&entry.params, "threadId") == Some(thread))
            .cloned()
            .collect()
    }

    pub async fn answer(
        &self,
        configuration: &Configuration,
        thread: &str,
        id: &str,
        result: JsonValue,
    ) -> Reply {
        if !self.connected(configuration) {
            return Reply::Stale;
        }
        let (reply, answer, cancel) = Answer::channel(Instant::now() + Duration::from_secs(30));
        if self
            .commands
            .try_send(Command::Answer {
                configuration: configuration.clone(),
                thread: thread.into(),
                id: id.into(),
                result,
                reply,
            })
            .is_err()
        {
            return Reply::NotSent;
        }
        cancel.wait(answer).await
    }

    pub async fn close(&self) -> Result<(), Error> {
        self.stop.send_replace(true);
        let task = self
            .task
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(task) = task {
            task.await.map_err(|_| Error::new(Problem::Connection))?;
        }
        Ok(())
    }
}
impl Drop for Durable {
    fn drop(&mut self) {
        self.stop.send_replace(true);
        if let Some(task) = self
            .task
            .get_mut()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            task.abort();
        }
    }
}

struct Call {
    answers: Vec<Answer>,
    deadline: Instant,
    subscription: Option<String>,
}

async fn write(socket: &mut Wire, value: &JsonValue) -> bool {
    write_message(socket, Message::Text(stringify_json(value).into())).await
}
async fn write_message(socket: &mut Wire, message: Message) -> bool {
    matches!(
        tokio::time::timeout(Duration::from_secs(15), async {
            socket.ready().await?;
            socket.start_send(message)?;
            socket.flush().await
        })
        .await,
        Ok(Ok(()))
    )
}
enum Write {
    Sent,
    Expired,
    Failed,
}
async fn write_call(
    socket: &mut Wire,
    value: &JsonValue,
    answer: &Answer,
    host: &Host,
    owner: &(dyn Fn() -> bool + Send + Sync),
    configuration: &Configuration,
    stopped: &watch::Receiver<bool>,
) -> Write {
    let message = Message::Text(stringify_json(value).into());
    let deadline = answer
        .dispatch
        .deadline
        .min(Instant::now() + Duration::from_secs(15));
    let result = tokio::time::timeout_at(deadline, async {
        socket.ready().await?;
        if *stopped.borrow()
            || !owner()
            || host.configuration().ok().as_ref() != Some(configuration)
        {
            return Ok(false);
        }
        {
            let mut delivery = answer
                .dispatch
                .delivery
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if delivery.result.is_some() || deadline <= Instant::now() {
                return Ok(false);
            }
            delivery.submitted = true;
            socket.start_send(message)?;
        }
        socket.flush().await?;
        Ok::<bool, SocketError>(true)
    })
    .await;
    match result {
        Ok(Ok(true)) => Write::Sent,
        Ok(Ok(false)) => Write::Expired,
        _ => Write::Failed,
    }
}

fn initialize() -> JsonValue {
    let notifications = parse_json(r#"["thread/project/updated","thread/prediction/updated","rawResponseItem/completed","command/exec/outputDelta","project/changed","externalAgentConfig/import/progress","thread/compacted","windows/worldWritableWarning","modelProvider/authRecoveryStarted","modelProvider/authRecoveryCompleted","authStatusChange","loginChatGptComplete","codex/event/task_started","codex/event/agent_reasoning","codex/event/agent_message","codex/event/task_complete","codex/event/mcp_tool_call_begin","codex/event/mcp_tool_call_end","codex/event/exec_command_begin","codex/event/exec_command_end","codex/event/exec_command_output_delta","codex/event/exec_approval_request","codex/event/apply_patch_approval_request","codex/event/background_event","codex/event/turn_diff","codex/event/get_history_entry_response","codex/event/agent_reasoning_delta","codex/event/agent_reasoning_section_break","codex/event/agent_message_delta","codex/event/stream_error","codex/event/error","codex/event/turn_aborted","codex/event/plan_delta","codex/event/plan_update","codex/event/patch_apply_begin","codex/event/patch_apply_end","codex/event/item_started","codex/event/item_completed","codex/event/user_message","codex/event/agent_reasoning_raw_content","codex/event/agent_reasoning_raw_content_delta","codex/event/web_search_begin","codex/event/web_search_end","codex/event/mcp_list_tools_response","codex/event/list_skills_response","codex/event/list_remote_skills_response","codex/event/remote_skill_downloaded","codex/event/list_custom_prompts_response","codex/event/raw_response_item","codex/event/agent_message_content_delta","codex/event/reasoning_content_delta","codex/event/reasoning_raw_content_delta","codex/event/warning","codex/event/undo_started","codex/event/undo_completed","codex/event/shutdown_complete","codex/event/entered_review_mode","codex/event/exited_review_mode","codex/event/view_image_tool_call","codex/event/mcp_startup_update","codex/event/mcp_startup_complete","codex/event/remote_task_created","codex/event/thread_rolled_back","codex/event/thread_name_updated","codex/event/elicitation_request","codex/event/dynamic_tool_call_request","codex/event/request_user_input","codex/event/terminal_interaction","codex/event/token_count","codex/event/deprecation_notice","thread/closed","thread/reverted","rawResponse/completed","warning","turn/diff/updated"]"#).unwrap();
    ObjectEncoder::new()
        .field(
            "clientInfo",
            &ObjectEncoder::new()
                .field("name", cca_headers::ORIGINATOR)
                .field("title", cca_headers::ORIGINATOR)
                .field("version", cca_headers::DESKTOP_VERSION)
                .finish(),
        )
        .field(
            "capabilities",
            &ObjectEncoder::new()
                .field("experimentalApi", &true)
                .field("optOutNotificationMethods", &notifications)
                .finish(),
        )
        .finish()
}

async fn dial(
    host: &Host,
    owner: &(dyn Fn() -> bool + Send + Sync),
    connect: &Connect,
    configuration: &Configuration,
    rejected: Option<String>,
) -> Result<Wire, Option<String>> {
    let Configuration::Enabled { profile, .. } = configuration else {
        return Err(None);
    };
    let credential = host
        .credential(profile, rejected)
        .await
        .map_err(|_| None)?
        .ok_or(None)?;
    if !owner() || host.configuration().ok().as_ref() != Some(configuration) {
        return Err(None);
    }
    let mut request = "wss://codex-cloud-backend.chatgpt.com/"
        .into_client_request()
        .map_err(|_| None)?;
    let headers = request.headers_mut();
    for (name, value) in [
        (
            "sec-websocket-protocol",
            format!(
                "codex-app-server, codex-client.desktop, openai-bearer.{}",
                credential.access_token
            ),
        ),
        ("x-openai-product-sku", "codex".into()),
        ("chatgpt-account-id", credential.account_id),
        ("originator", cca_headers::ORIGINATOR.into()),
        ("user-agent", cca_headers::user_agent()),
    ] {
        headers.insert(name, HeaderValue::from_str(&value).map_err(|_| None)?);
    }
    let mut socket = match tokio::time::timeout(Duration::from_secs(15), connect(request)).await {
        Ok(Ok(socket)) => socket,
        Ok(Err(ConnectError { status: Some(401) })) => return Err(Some(credential.access_token)),
        _ => return Err(None),
    };
    if !owner() || host.configuration().ok().as_ref() != Some(configuration) {
        return Err(None);
    }
    let id = format!("initialize:{}", request_id().map_err(|_| None)?);
    if !write(
        &mut socket,
        &ObjectEncoder::new()
            .field("id", id.as_str())
            .field("method", "initialize")
            .field("params", &initialize())
            .finish(),
    )
    .await
    {
        return Err(None);
    }
    let initialized = tokio::time::timeout(Duration::from_secs(30), async {
        while let Some(message) = socket.next().await {
            let Ok(message) = message else {
                return false;
            };
            let Ok(text) = message.to_text() else {
                continue;
            };
            let Ok(value) = parse_json(text) else {
                continue;
            };
            if string(&value, "id") == Some(id.as_str()) {
                return matches!(field(&value, "error"), JsonValue::Null);
            }
        }
        false
    })
    .await
    .unwrap_or(false);
    if !initialized || !owner() || host.configuration().ok().as_ref() != Some(configuration) {
        return Err(None);
    }
    if !write(
        &mut socket,
        &ObjectEncoder::new()
            .field("method", "initialized")
            .field("params", &ObjectEncoder::new().finish())
            .finish(),
    )
    .await
    {
        return Err(None);
    }
    Ok(socket)
}

async fn run(
    host: Host,
    owner_fence: Arc<dyn Fn() -> bool + Send + Sync>,
    connect: Connect,
    mut commands: mpsc::Receiver<Command>,
    shared: Arc<Mutex<Shared>>,
    mut stopped: watch::Receiver<bool>,
    mut changes: watch::Receiver<()>,
) {
    let mut watched = VecDeque::<String>::new();
    let mut owner = None;
    let mut delay = 1000u64;
    loop {
        if *stopped.borrow() || !owner_fence() {
            break;
        }
        let configuration = host.configuration().ok();
        if configuration != owner {
            watched.clear();
            owner = configuration.clone();
            delay = 1000;
        }
        if let Some(configuration @ Configuration::Enabled { .. }) = configuration {
            let attempt = async {
                match dial(&host, owner_fence.as_ref(), &connect, &configuration, None).await {
                    Err(Some(rejected)) => {
                        dial(
                            &host,
                            owner_fence.as_ref(),
                            &connect,
                            &configuration,
                            Some(rejected),
                        )
                        .await
                    }
                    value => value,
                }
            };
            let dialed = tokio::select! {
                biased;
                _ = stopped.changed() => break,
                _ = changes.changed() => continue,
                value = attempt => value,
            };
            match dialed {
                Ok(mut socket) => {
                    delay = 1000;
                    shared
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .configuration = Some(configuration.clone());
                    connected(
                        OwnerFence {
                            host: &host,
                            owner: owner_fence.as_ref(),
                            configuration: &configuration,
                        },
                        &mut socket,
                        &mut commands,
                        &shared,
                        &mut watched,
                        &mut stopped,
                        &mut changes,
                    )
                    .await;
                }
                Err(Some(_)) => {
                    tokio::select! { _ = stopped.changed() => break, _ = changes.changed() => continue }
                }
                Err(None) => {}
            }
        }
        {
            let mut shared = shared.lock().unwrap_or_else(|error| error.into_inner());
            shared.configuration = None;
            shared.requests.clear();
        }
        while let Ok(command) = commands.try_recv() {
            match command {
                Command::Request {
                    configuration,
                    subscription,
                    reply,
                    ..
                } => {
                    if owner.as_ref() == Some(&configuration)
                        && let Some(thread) = subscription
                    {
                        watched.retain(|id| id != &thread);
                        watched.push_back(thread);
                        if watched.len() > 32 {
                            watched.pop_front();
                        }
                    }
                    let _ = reply.send(Reply::NotSent);
                }
                Command::Answer { reply, .. } => {
                    let _ = reply.send(Reply::Stale);
                }
            }
        }
        let mut bytes = [0u8; 8];
        if SystemRandom::new().fill(&mut bytes).is_err() {
            tracing::error!("Dots reconnect randomness unavailable");
            break;
        }
        let jitter = u64::from_le_bytes(bytes) % delay;
        tokio::select! { _ = stopped.changed() => break, _ = changes.changed() => {}, _ = tokio::time::sleep(Duration::from_millis(delay + jitter)) => {} }
        delay = (delay * 2).min(10000);
    }
    let mut shared = shared.lock().unwrap_or_else(|error| error.into_inner());
    shared.configuration = None;
    shared.requests.clear();
    drop(shared);
    while let Ok(command) = commands.try_recv() {
        match command {
            Command::Request { reply, .. } => {
                let _ = reply.send(Reply::NotSent);
            }
            Command::Answer { reply, .. } => {
                let _ = reply.send(Reply::Stale);
            }
        }
    }
}

struct OwnerFence<'a> {
    host: &'a Host,
    owner: &'a (dyn Fn() -> bool + Send + Sync),
    configuration: &'a Configuration,
}

async fn connected(
    fence: OwnerFence<'_>,
    socket: &mut Wire,
    commands: &mut mpsc::Receiver<Command>,
    shared: &Mutex<Shared>,
    watched: &mut VecDeque<String>,
    stopped: &mut watch::Receiver<bool>,
    changes: &mut watch::Receiver<()>,
) {
    let OwnerFence {
        host,
        owner,
        configuration,
    } = fence;
    let mut calls = BTreeMap::<String, Call>::new();
    let mut subscribed = BTreeSet::new();
    let mut restored = true;
    for thread in watched.iter() {
        if *stopped.borrow()
            || !owner()
            || host.configuration().ok().as_ref() != Some(configuration)
        {
            restored = false;
            break;
        }
        let Ok(id) = request_id() else {
            restored = false;
            break;
        };
        let id = format!("thread/resume:{id}");
        let params = ObjectEncoder::new()
            .field("threadId", thread.as_str())
            .field("excludeTurns", &true)
            .finish();
        calls.insert(
            id.clone(),
            Call {
                answers: Vec::new(),
                deadline: Instant::now() + Duration::from_secs(120),
                subscription: Some(thread.clone()),
            },
        );
        if !write(
            socket,
            &ObjectEncoder::new()
                .field("id", id.as_str())
                .field("method", "thread/resume")
                .field("params", &params)
                .finish(),
        )
        .await
        {
            restored = false;
            break;
        }
    }
    let mut ticker = tokio::time::interval(Duration::from_millis(250));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut ping_at = Instant::now() + Duration::from_secs(10);
    let mut pong_at = Instant::now();
    loop {
        if !restored
            || *stopped.borrow()
            || !owner()
            || host.configuration().ok().as_ref() != Some(configuration)
        {
            break;
        }
        tokio::select! {
            _ = stopped.changed() => break,
            _ = changes.changed() => break,
            _ = ticker.tick() => {
                let now = Instant::now();
                let expired = calls.iter().filter(|(_, call)| call.deadline <= now).map(|(id, _)| id.clone()).collect::<Vec<_>>();
                for id in expired { if let Some(call) = calls.remove(&id) { for answer in call.answers { let _ = answer.send(Reply::Unknown); } } }
                if now.duration_since(pong_at) > Duration::from_secs(60) { break; }
                if now >= ping_at {
                    if !write_message(socket, Message::Ping(Default::default())).await { break; }
                    ping_at = now + Duration::from_secs(10);
                }
            }
            command = commands.recv() => {
                let Some(command) = command else { break; };
                match command {
                    Command::Request { configuration: expected, method, params, deadline, reply, subscription, force } => {
                        if deadline <= Instant::now() || !owner() || &expected != configuration || host.configuration().ok().as_ref() != Some(configuration) { let _ = reply.send(Reply::NotSent); continue; }
                        if let Some(thread) = &subscription {
                            watched.retain(|id| id != thread);
                            watched.push_back(thread.clone());
                            if watched.len() > 32 { watched.pop_front(); }
                            if force { subscribed.remove(thread); }
                            if subscribed.contains(thread) { let _ = reply.send(Reply::Result(JsonValue::Null)); continue; }
                            if let Some(call) = calls.values_mut().find(|call| call.subscription.as_ref() == Some(thread)) {
                                if call.answers.len() < 256 && reply.join() { call.answers.push(reply); } else { let _ = reply.send(Reply::NotSent); }
                                continue;
                            }
                        }
                        if calls.len() >= 256 { let _ = reply.send(Reply::NotSent); continue; }
                        let Ok(id) = request_id() else { let _ = reply.send(Reply::NotSent); continue; };
                        let id = format!("{method}:{id}");
                        let written = write_call(socket, &ObjectEncoder::new().field("id", id.as_str()).field("method", method).field("params", &params).finish(), &reply, host, owner, configuration, stopped).await;
                        match written {
                            Write::Sent => { calls.insert(id, Call { answers: vec![reply], deadline, subscription }); }
                            Write::Expired => { let _ = reply.send(Reply::NotSent); }
                            Write::Failed => { let _ = reply.send(Reply::Unknown); break; }
                        }
                    }
                    Command::Answer { configuration: expected, thread, id, result, reply } => {
                        if !owner() || &expected != configuration || host.configuration().ok().as_ref() != Some(configuration) { let _ = reply.send(Reply::Stale); continue; }
                        let entry = {
                            let shared = shared.lock().unwrap_or_else(|error| error.into_inner());
                            shared.requests.get(&id).filter(|entry| string(&entry.params, "threadId") == Some(thread.as_str())).cloned()
                        };
                        let Some(entry) = entry else { let _ = reply.send(Reply::Stale); continue; };
                        let written = write_call(socket, &ObjectEncoder::new().field("id", &entry.raw_id).field("result", &result).finish(), &reply, host, owner, configuration, stopped).await;
                        if reply.submitted() { shared.lock().unwrap_or_else(|error| error.into_inner()).requests.remove(&id); }
                        match written {
                            Write::Sent => { let _ = reply.send(Reply::Result(JsonValue::Null)); }
                            Write::Expired => { let _ = reply.send(Reply::NotSent); }
                            Write::Failed => { let _ = reply.send(Reply::Unknown); break; }
                        }
                    }
                }
            }
            message = socket.next() => {
                let Some(Ok(message)) = message else { break; };
                if matches!(&message, Message::Pong(_)) { pong_at = Instant::now(); continue; }
                if matches!(&message, Message::Close(_)) { break; }
                let Ok(text) = message.to_text() else { continue; };
                let Ok(value) = parse_json(text) else { continue; };
                if let Some(method) = string(&value, "method") {
                    let params = field(&value, "params");
                    let raw_id = field(&value, "id");
                    if matches!(raw_id, JsonValue::Null) {
                        if method == "thread/archived" && let Some(thread) = string(params, "threadId") { subscribed.remove(thread); }
                        if method == "serverRequest/resolved" && let Some(id) = server_id(field(params, "requestId")) { shared.lock().unwrap_or_else(|error| error.into_inner()).requests.remove(&id); }
                        continue;
                    }
                    if !["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput"].contains(&method) { continue; }
                    if !string(params, "threadId").is_some_and(|thread| watched.iter().any(|id| id == thread)) { continue; }
                    let Some(id) = server_id(raw_id) else { continue; };
                    let mut shared = shared.lock().unwrap_or_else(|error| error.into_inner());
                    if shared.requests.len() < 256 && !shared.requests.contains_key(&id) {
                        shared.requests.insert(id.clone(), Pending { id, raw_id: raw_id.clone(), method: method.into(), params: params.clone() });
                    }
                    continue;
                }
                let Some(id) = string(&value, "id") else { continue; };
                let Some(call) = calls.remove(id) else { continue; };
                let error = field(&value, "error");
                let reply = if matches!(error, JsonValue::Null) {
                    if let Some(thread) = call.subscription { subscribed.insert(thread); }
                    Reply::Result(field(&value, "result").clone())
                } else {
                    Reply::Rejected(UpstreamRejection {
                        code: match field(error, "code") { JsonValue::Number(code) => Some(*code), _ => None },
                        message: string(error, "message").map(|text| text.chars().take(1000).collect()),
                        error_code: string(field(error, "data"), "code").map(|text| text.chars().take(128).collect()),
                        error_type: string(field(error, "data"), "errorType").map(|text| text.chars().take(128).collect()),
                    })
                };
                for answer in call.answers { let _ = answer.send(reply.clone()); }
            }
        }
    }
    for call in calls.into_values() {
        for answer in call.answers {
            let _ = answer.send(Reply::Unknown);
        }
    }
    let mut shared = shared.lock().unwrap_or_else(|error| error.into_inner());
    shared.configuration = None;
    shared.requests.clear();
}

fn server_id(value: &JsonValue) -> Option<String> {
    match value {
        JsonValue::String(value) if !value.is_empty() && value.len() <= 256 => value.to_utf8().ok(),
        JsonValue::Number(number) if number.is_finite() => Some(stringify_json(value)),
        _ => None,
    }
}
