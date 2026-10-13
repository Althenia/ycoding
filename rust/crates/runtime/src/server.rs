use crate::{
    auth::origin_allowed,
    connection,
    dispatch::{Dispatcher, RegistrationError},
    handlers,
    services::{Environment, Services, Subscriptions},
};
use axum::{
    Router,
    extract::{State, WebSocketUpgrade},
    http::{HeaderMap, StatusCode, header::WWW_AUTHENTICATE},
    response::{IntoResponse, Response},
    routing::get,
};
use std::{
    io,
    net::SocketAddr,
    sync::{
        Arc,
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

pub async fn serve(listener: TcpListener, services: Services) -> io::Result<Server> {
    let dispatcher = handlers::standard().map_err(registration_error)?;
    serve_with(listener, services, dispatcher).await
}

pub async fn serve_with(
    listener: TcpListener,
    services: Services,
    dispatcher: Dispatcher,
) -> io::Result<Server> {
    if Handle::current().runtime_flavor() != RuntimeFlavor::MultiThread {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "the v5 local bridge requires a multi-thread Tokio runtime",
        ));
    }
    let address = listener.local_addr()?;
    let (shutdown, mut stopped) = watch::channel(false);
    let (drain, drained) = mpsc::channel(1);
    let shared = Arc::new(Shared {
        dispatcher,
        environment: Arc::new(Environment {
            services,
            urls: vec![format!("http://{address}")],
            subscriptions: Subscriptions::default(),
        }),
        shutdown: shutdown.clone(),
        drain,
        boot: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos()),
        epochs: AtomicU64::new(1),
    });
    let router = Router::new()
        .route(ROUTE, get(upgrade))
        .route("/api/pty/{id}/connect", get(crate::pty_stream::upgrade))
        .with_state(shared);
    let task = tokio::spawn(
        axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = stopped.wait_for(|stopped| *stopped).await;
            })
            .into_future(),
    );
    Ok(Server {
        address,
        shutdown,
        task,
        drained,
    })
}

impl Server {
    pub fn address(&self) -> SocketAddr {
        self.address
    }

    pub async fn shutdown(mut self) -> io::Result<()> {
        let _ = self.shutdown.send(true);
        match timeout(SHUTDOWN_GRACE, &mut self.task).await {
            Ok(joined) => joined.map_err(io::Error::other)??,
            Err(_) => {
                self.task.abort();
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "v5 local bridge did not stop within the grace period",
                ));
            }
        }
        timeout(SHUTDOWN_GRACE, self.drained.recv())
            .await
            .map(|_| ())
            .map_err(|_| {
                io::Error::new(
                    io::ErrorKind::TimedOut,
                    "v5 connections did not drain within the grace period",
                )
            })
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
