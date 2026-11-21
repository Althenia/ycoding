use crate::{
    auth::origin_allowed,
    connection,
    dispatch::{Dispatcher, RegistrationError},
    handlers,
    services::{Environment, Identity, Services, Subscriptions},
};
use axum::{
    Router,
    body::Bytes,
    extract::{
        ConnectInfo, Path, State, WebSocketUpgrade,
        ws::{CloseFrame, Message, rejection::WebSocketUpgradeRejection},
    },
    http::{HeaderMap, StatusCode, Uri, header::WWW_AUTHENTICATE},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use std::{
    io,
    net::SocketAddr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::TcpListener,
    runtime::{Handle, RuntimeFlavor},
    sync::{mpsc, watch},
    task::JoinHandle,
    time::timeout,
};
use ycoding_protocol::limits;

const ROUTE: &str = "/ws/v5/local";
const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);

pub(crate) struct Shared {
    interaction: Option<Arc<ycoding_core::platform::interaction::chrome::Transport>>,
    pub dispatcher: Dispatcher,
    pub environment: Arc<Environment>,
    pub shutdown: watch::Sender<bool>,
    drain: mpsc::Sender<()>,
    boot: u128,
    epochs: AtomicU64,
}

impl Shared {
    pub(crate) fn next_epoch(&self) -> String {
        format!(
            "{:x}-{:x}",
            self.boot,
            self.epochs.fetch_add(1, Ordering::Relaxed)
        )
    }
}

pub struct Server {
    address: SocketAddr,
    shutdown: watch::Sender<bool>,
    task: JoinHandle<io::Result<()>>,
    drained: mpsc::Receiver<()>,
}

pub(crate) struct Managed {
    identity: Identity,
    auth: crate::LocalAuth,
    cors: Vec<String>,
    address: SocketAddr,
    shutdown: watch::Sender<bool>,
    stage: Mutex<Stage>,
}

enum Stage {
    Starting(mpsc::Sender<()>),
    Ready(Arc<Shared>),
    Failed,
    Stopping,
}

impl Managed {
    pub(crate) fn ready(&self, services: Services, announce: impl FnOnce()) -> io::Result<()> {
        let dispatcher = handlers::standard().map_err(registration_error)?;
        let mut stage = self
            .stage
            .lock()
            .map_err(|_| io::Error::other("managed state lock poisoned"))?;
        let Stage::Starting(drain) = &*stage else {
            return match &*stage {
                Stage::Stopping => Ok(()),
                _ => Err(io::Error::other("managed bootstrap already settled")),
            };
        };
        *stage = Stage::Ready(shared(
            services,
            dispatcher,
            self.address,
            self.shutdown.clone(),
            drain.clone(),
        )?);
        announce();
        Ok(())
    }

    pub(crate) fn failed(&self) -> io::Result<()> {
        let mut stage = self
            .stage
            .lock()
            .map_err(|_| io::Error::other("managed state lock poisoned"))?;
        if !matches!(&*stage, Stage::Stopping) {
            *stage = Stage::Failed;
        }
        Ok(())
    }

    pub(crate) fn stopping(&self) -> io::Result<()> {
        let mut stage = self
            .stage
            .lock()
            .map_err(|_| io::Error::other("managed state lock poisoned"))?;
        *stage = Stage::Stopping;
        Ok(())
    }

    fn current(&self) -> Result<Arc<Shared>, StatusCode> {
        let stage = self
            .stage
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        match &*stage {
            Stage::Ready(shared) => Ok(shared.clone()),
            _ => Err(StatusCode::SERVICE_UNAVAILABLE),
        }
    }
}

pub(crate) async fn serve_managed(
    listener: TcpListener,
    identity: Identity,
    auth: crate::LocalAuth,
    cors: Vec<String>,
) -> io::Result<(Server, Arc<Managed>)> {
    check_runtime()?;
    let address = listener.local_addr()?;
    let (shutdown, stopped) = watch::channel(false);
    let (drain, drained) = mpsc::channel(1);
    let managed = Arc::new(Managed {
        identity,
        auth,
        cors,
        address,
        shutdown: shutdown.clone(),
        stage: Mutex::new(Stage::Starting(drain)),
    });
    let router = Router::new()
        .route(ROUTE, get(managed_upgrade))
        .route("/api/browser/connect", get(managed_browser))
        .route(
            ycoding_core::platform::interaction::chrome::CONNECT_PATH,
            get(managed_interaction),
        )
        .route("/api/pty/{id}/connect", get(managed_pty))
        .route("/api/health", get(managed_health))
        .route("/health", get(managed_health))
        .route("/api/service/stop", post(managed_stop))
        .with_state(managed.clone());
    Ok((
        start(listener, router, address, shutdown, stopped, drained),
        managed,
    ))
}

pub async fn serve(listener: TcpListener, services: Services) -> io::Result<Server> {
    let dispatcher = handlers::standard().map_err(registration_error)?;
    serve_with(listener, services, dispatcher).await
}

pub async fn serve_with(
    listener: TcpListener,
    services: Services,
    dispatcher: Dispatcher,
) -> io::Result<Server> {
    check_runtime()?;
    let address = listener.local_addr()?;
    let (shutdown, stopped) = watch::channel(false);
    let (drain, drained) = mpsc::channel(1);
    let shared = shared(services, dispatcher, address, shutdown.clone(), drain)?;
    let router = Router::new()
        .route(ROUTE, get(upgrade))
        .route("/api/browser/connect", get(crate::browser_stream::upgrade))
        .route(
            ycoding_core::platform::interaction::chrome::CONNECT_PATH,
            get(interaction_upgrade),
        )
        .route("/api/pty/{id}/connect", get(crate::pty_stream::upgrade))
        .route("/api/health", get(health))
        .route("/health", get(health))
        .route("/api/service/stop", post(stop))
        .with_state(shared);
    Ok(start(listener, router, address, shutdown, stopped, drained))
}

fn check_runtime() -> io::Result<()> {
    if Handle::current().runtime_flavor() != RuntimeFlavor::MultiThread {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "the v5 local bridge requires a multi-thread Tokio runtime",
        ));
    }
    Ok(())
}

fn shared(
    services: Services,
    dispatcher: Dispatcher,
    address: SocketAddr,
    shutdown: watch::Sender<bool>,
    drain: mpsc::Sender<()>,
) -> io::Result<Arc<Shared>> {
    let interaction = services
        .core
        .as_ref()
        .and_then(|core| core.interaction.as_ref())
        .map(|authority| authority.bind_chrome(&format!("http://{address}")))
        .transpose()
        .map_err(|error| io::Error::other(format!("Interaction transport: {}", error.0)))?
        .flatten();
    Ok(Arc::new(Shared {
        interaction,
        dispatcher,
        environment: Arc::new(Environment {
            services,
            urls: vec![format!("http://{address}")],
            subscriptions: Subscriptions::default(),
            uploads: Default::default(),
        }),
        shutdown,
        drain,
        boot: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos()),
        epochs: AtomicU64::new(1),
    }))
}

fn start(
    listener: TcpListener,
    router: Router,
    address: SocketAddr,
    shutdown: watch::Sender<bool>,
    mut stopped: watch::Receiver<bool>,
    drained: mpsc::Receiver<()>,
) -> Server {
    let task = tokio::spawn(
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = stopped.wait_for(|stopped| *stopped).await;
        })
        .into_future(),
    );
    Server {
        address,
        shutdown,
        task,
        drained,
    }
}

impl Server {
    pub fn address(&self) -> SocketAddr {
        self.address
    }

    pub async fn shutdown(mut self) -> io::Result<()> {
        let _ = self.shutdown.send(true);
        let mut errors = Vec::new();
        let stopped = match timeout(SHUTDOWN_GRACE, &mut self.task).await {
            Ok(joined) => joined.map_err(io::Error::other).and_then(|result| result),
            Err(_) => {
                errors.push(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "v5 local bridge did not stop within the grace period",
                ));
                self.task.abort();
                match (&mut self.task).await {
                    Ok(result) => result,
                    Err(error) if error.is_cancelled() => Ok(()),
                    Err(error) => Err(io::Error::other(error)),
                }
            }
        };
        if let Err(error) = stopped {
            errors.push(error);
        }
        let drained = timeout(SHUTDOWN_GRACE, self.drained.recv())
            .await
            .map(|_| ())
            .map_err(|_| {
                io::Error::new(
                    io::ErrorKind::TimedOut,
                    "v5 connections did not drain within the grace period",
                )
            });
        if let Err(error) = drained {
            errors.push(error);
        }
        match errors.len() {
            0 => Ok(()),
            1 => Err(errors.remove(0)),
            _ => Err(io::Error::new(errors[0].kind(), ShutdownErrors(errors))),
        }
    }
}

#[derive(Debug)]
struct ShutdownErrors(Vec<io::Error>);

impl std::fmt::Display for ShutdownErrors {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for (index, error) in self.0.iter().enumerate() {
            if index != 0 {
                formatter.write_str("; additional shutdown failure: ")?;
            }
            write!(formatter, "{error}")?;
        }
        Ok(())
    }
}

impl std::error::Error for ShutdownErrors {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.0.first().map(|error| error as _)
    }
}

async fn health(State(shared): State<Arc<Shared>>, headers: HeaderMap) -> Response {
    health_response(
        &shared.environment.services.identity,
        &shared.environment.services.auth,
        &headers,
        StatusCode::OK,
    )
}

async fn managed_health(State(managed): State<Arc<Managed>>, headers: HeaderMap) -> Response {
    let status = match managed.stage.lock() {
        Ok(stage) => match &*stage {
            Stage::Ready(_) => StatusCode::OK,
            Stage::Failed => StatusCode::INTERNAL_SERVER_ERROR,
            Stage::Starting(_) | Stage::Stopping => StatusCode::SERVICE_UNAVAILABLE,
        },
        Err(_) => {
            return health_response(
                &managed.identity,
                &managed.auth,
                &headers,
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    health_response(&managed.identity, &managed.auth, &headers, status)
}

fn health_response(
    identity: &Identity,
    auth: &crate::LocalAuth,
    headers: &HeaderMap,
    status: StatusCode,
) -> Response {
    if !auth.authorized(headers) {
        return (
            StatusCode::UNAUTHORIZED,
            [(WWW_AUTHENTICATE, "Basic realm=\"Secure Area\"")],
        )
            .into_response();
    }
    let mut response = (
        status,
        [("content-type", "application/json")],
        crate::launch::health_json(identity),
    )
        .into_response();
    if status == StatusCode::SERVICE_UNAVAILABLE {
        response
            .headers_mut()
            .insert("retry-after", axum::http::HeaderValue::from_static("1"));
    }
    response
}

async fn stop(State(shared): State<Arc<Shared>>, headers: HeaderMap, body: Bytes) -> Response {
    stop_response(
        &shared.environment.services.identity,
        &shared.environment.services.auth,
        &headers,
        &body,
    )
}

async fn managed_stop(
    State(managed): State<Arc<Managed>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    stop_response(&managed.identity, &managed.auth, &headers, &body)
}

fn stop_response(
    identity: &Identity,
    auth: &crate::LocalAuth,
    headers: &HeaderMap,
    body: &[u8],
) -> Response {
    if !auth.authorized(headers) {
        return (
            StatusCode::UNAUTHORIZED,
            [(WWW_AUTHENTICATE, "Basic realm=\"Secure Area\"")],
        )
            .into_response();
    }
    let target = std::str::from_utf8(body)
        .ok()
        .and_then(|body| ycoding_core::ycoding_schema::parse_json(body).ok())
        .and_then(|value| crate::launch::json_string(&value, "instanceID"));
    let Some(target) = target else {
        return (
            StatusCode::BAD_REQUEST,
            [("content-type", "application/json")],
            "{\"code\":\"invalid_request\"}",
        )
            .into_response();
    };
    let accepted = crate::health::request_stop(&identity.source_epoch, &target);
    (
        StatusCode::OK,
        [("content-type", "application/json")],
        format!("{{\"accepted\":{accepted}}}"),
    )
        .into_response()
}

async fn managed_upgrade(
    State(managed): State<Arc<Managed>>,
    headers: HeaderMap,
    socket: WebSocketUpgrade,
) -> Response {
    if !origin_allowed(&headers, &managed.cors) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !managed.auth.authorized(&headers) {
        return (
            StatusCode::UNAUTHORIZED,
            [(WWW_AUTHENTICATE, "Basic realm=\"Secure Area\"")],
        )
            .into_response();
    }
    match managed.current() {
        Ok(shared) => upgrade(State(shared), headers, socket).await,
        Err(status) => status.into_response(),
    }
}

async fn managed_browser(
    State(managed): State<Arc<Managed>>,
    headers: HeaderMap,
    socket: WebSocketUpgrade,
) -> Response {
    match managed.current() {
        Ok(shared) => crate::browser_stream::upgrade(State(shared), headers, socket).await,
        Err(status) => status.into_response(),
    }
}
async fn managed_interaction(
    State(managed): State<Arc<Managed>>,
    peer: ConnectInfo<SocketAddr>,
    uri: Uri,
    headers: HeaderMap,
    socket: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    match managed.current() {
        Ok(shared) => interaction_upgrade(State(shared), peer, uri, headers, socket).await,
        Err(status) => status.into_response(),
    }
}
async fn interaction_upgrade(
    State(shared): State<Arc<Shared>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    uri: Uri,
    headers: HeaderMap,
    socket: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let Some(transport) = shared.interaction.clone() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let origin = headers
        .get("origin")
        .and_then(|h| h.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let url = uri.to_string();
    let address = peer.ip().to_string();
    if !transport.admit(&url, &origin, &address) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(socket) = socket else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    socket
        .max_message_size(262144)
        .max_frame_size(262144)
        .on_upgrade(move |socket| {
            interaction_socket(socket, shared, transport, url, origin, address)
        })
}
async fn interaction_socket(
    mut socket: axum::extract::ws::WebSocket,
    shared: Arc<Shared>,
    transport: Arc<ycoding_core::platform::interaction::chrome::Transport>,
    url: String,
    origin: String,
    address: String,
) {
    use ycoding_core::platform::interaction::chrome::Peer;
    let (send, mut receive) = mpsc::channel::<String>(32);
    let (closing, mut closed) = watch::channel(None);
    let overflow = closing.clone();
    let channel = match transport.connect(Peer {
        url,
        origin,
        address,
        send: Arc::new(move |message| {
            if send.try_send(message).is_ok() {
                true
            } else {
                overflow.send_replace(Some(1008));
                false
            }
        }),
        close: Arc::new(move |code| {
            closing.send_replace(Some(code));
        }),
    }) {
        Ok(channel) => Arc::new(channel),
        Err(_) => {
            interaction_write(
                &mut socket,
                Message::Close(Some(CloseFrame {
                    code: 1008,
                    reason: "".into(),
                })),
            )
            .await;
            return;
        }
    };
    let mut stopped = shared.shutdown.subscribe();
    let mut pending = tokio::task::JoinSet::new();
    let code = loop {
        tokio::select! {
            _ = async { let _ = stopped.wait_for(|v| *v).await; } => break 1012,
            code = async {
                closed.wait_for(|v| v.is_some()).await.ok()
                    .and_then(|value| *value).unwrap_or(1008)
            } => break code,
            message = receive.recv() => match message {
                Some(message) => {
                    if !interaction_write(&mut socket, Message::Text(message.into())).await {
                        break 1008;
                    }
                },
                None => break 1008,
            },
            joined = pending.join_next(), if !pending.is_empty() => {
                if !matches!(joined, Some(Ok(()))) { break 1011; }
            },
            message = socket.recv() => match message {
                Some(Ok(Message::Ping(bytes))) => {
                    if !interaction_write(&mut socket, Message::Pong(bytes)).await {
                        break 1008;
                    }
                },
                Some(Ok(Message::Pong(_))) => {},
                Some(Ok(message @ (Message::Text(_) | Message::Binary(_)))) => {
                    if pending.len() >= 16 { break 1008; }
                    let content = match message {
                        Message::Text(text) => text.to_string(),
                        Message::Binary(bytes) => match String::from_utf8(bytes.to_vec()) {
                            Ok(text) => text,
                            Err(_) => break 1008,
                        },
                        _ => break 1008,
                    };
                    let channel = channel.clone();
                    pending.spawn(async move { channel.receive(&content).await; });
                },
                _ => break 1008,
            }
        }
    };
    channel.disconnect();
    pending.abort_all();
    while pending.join_next().await.is_some() {}
    interaction_write(
        &mut socket,
        Message::Close(Some(CloseFrame {
            code,
            reason: "".into(),
        })),
    )
    .await;
    if channel.shutdown().await.is_err() {
        tracing::warn!("Interaction channel shutdown failed");
    }
}
async fn interaction_write(socket: &mut axum::extract::ws::WebSocket, message: Message) -> bool {
    timeout(Duration::from_secs(1), socket.send(message))
        .await
        .is_ok_and(|r| r.is_ok())
}

async fn managed_pty(
    State(managed): State<Arc<Managed>>,
    id: Path<String>,
    uri: Uri,
    headers: HeaderMap,
    socket: WebSocketUpgrade,
) -> Response {
    match managed.current() {
        Ok(shared) => crate::pty_stream::upgrade(State(shared), id, uri, headers, socket).await,
        Err(status) => status.into_response(),
    }
}

async fn upgrade(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    if !origin_allowed(&headers, &shared.environment.services.cors) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !shared.environment.services.auth.authorized(&headers) {
        return (
            StatusCode::UNAUTHORIZED,
            [(WWW_AUTHENTICATE, "Basic realm=\"Secure Area\"")],
        )
            .into_response();
    }
    upgrade
        .max_message_size(limits::CLIENT_FRAME_BYTES as usize)
        .max_frame_size(limits::CLIENT_FRAME_BYTES as usize)
        .on_upgrade(move |socket| async move {
            let shutdown = shared.shutdown.subscribe();
            let drain = shared.drain.clone();
            let runtime = Handle::current();
            let spawned = std::thread::Builder::new()
                .name("ycoding-v5-connection".into())
                .spawn(move || {
                    runtime.block_on(connection::run(socket, shared, shutdown));
                    drop(drain);
                });
            if let Err(error) = spawned {
                tracing::warn!(%error, "v5 connection thread was not started");
            }
        })
}

fn registration_error(error: RegistrationError) -> io::Error {
    io::Error::other(format!("{error:?}"))
}
