mod executor;
pub(super) mod executor_rpc;
mod operator;
mod relay;
mod relay_wire;
mod rendezvous;
pub(crate) mod state;
pub(crate) mod supervisor;
pub(crate) mod wire;

use futures_util::{sink::Sink, stream::Stream};
use std::{
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::{Error as SocketError, Message, http::Request};
use ycoding_core::dots::{enrollment, native};

#[cfg(test)]
#[path = "carrier/computer_controls_tests.rs"]
mod computer_controls_tests;
#[cfg(test)]
#[path = "carrier/computer_tests.rs"]
mod computer_tests;
#[cfg(test)]
#[path = "carrier/executor_tests.rs"]
mod executor_tests;
#[cfg(test)]
#[path = "carrier/relay_tests.rs"]
mod relay_tests;
#[cfg(test)]
#[path = "carrier/rendezvous_tests.rs"]
mod rendezvous_tests;
#[cfg(test)]
#[path = "carrier/test_support.rs"]
mod test_support;
#[cfg(test)]
#[path = "carrier/tests.rs"]
mod tests;

pub(super) const EXECUTOR_STATE_FILE: &str = "cca-executor.json";

pub(crate) struct ExecutorSettings {
    pub host: native::Host,
    pub state_path: PathBuf,
    pub hostname: String,
    pub home: PathBuf,
    pub data: PathBuf,
    pub name: supervisor::Name,
    pub installation: executor::Installation,
    pub post: enrollment::ExecutorPost,
    pub prepare: supervisor::Prepare,
    pub serve: supervisor::Serve,
}

pub(crate) async fn start_executor(
    settings: ExecutorSettings,
) -> Result<Arc<supervisor::Supervisor>, supervisor::PrepareError> {
    let prepare = operator::prepare(settings.data.clone(), settings.prepare);
    supervisor::Supervisor::start(supervisor::Settings {
        source: supervisor::Source::host(settings.host, settings.name),
        transport: supervisor::Transport::production(),
        ambient: supervisor::Ambient::system(),
        post: settings.post,
        installation: settings.installation,
        state_path: settings.state_path.with_file_name(EXECUTOR_STATE_FILE),
        hostname: settings.hostname,
        home: settings.home,
        data: settings.data,
        detached_ttl_ms: supervisor::DETACHED_TTL_MS,
        diagnostic: Arc::new(|message| tracing::warn!("{message}")),
        prepare,
        serve: settings.serve,
    })
    .await
}

pub(crate) trait Clock: Send + Sync {
    fn now(&self) -> u64;
    fn wall(&self) -> u64;
    fn sleep_until(&self, deadline: u64) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
}
struct SystemClock(Instant);
impl Clock for SystemClock {
    fn now(&self) -> u64 {
        self.0.elapsed().as_millis() as u64
    }
    fn wall(&self) -> u64 {
        wall_ms()
    }
    fn sleep_until(&self, deadline: u64) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        let wait = deadline.saturating_sub(self.now());
        Box::pin(tokio::time::sleep(Duration::from_millis(wait)))
    }
}

trait Wire:
    Stream<Item = Result<Message, SocketError>> + Sink<Message, Error = SocketError> + Unpin + Send
{
}
impl<T> Wire for T where
    T: Stream<Item = Result<Message, SocketError>>
        + Sink<Message, Error = SocketError>
        + Unpin
        + Send
{
}
type Socket = Box<dyn Wire>;
#[derive(Debug)]
struct ConnectError {
    status: Option<u16>,
}
type Connect = Arc<
    dyn Fn(Request<()>) -> Pin<Box<dyn Future<Output = Result<Socket, ConnectError>> + Send>>
        + Send
        + Sync,
>;

fn connect_with(
    config: Option<tokio_tungstenite::tungstenite::protocol::WebSocketConfig>,
) -> Connect {
    Arc::new(move |request| {
        let config = config;
        Box::pin(async move {
            match tokio_tungstenite::connect_async_with_config(request, config, false).await {
                Ok((socket, _)) => Ok(Box::new(socket) as Socket),
                Err(SocketError::Http(response)) => Err(ConnectError {
                    status: Some(response.status().as_u16()),
                }),
                Err(_) => Err(ConnectError { status: None }),
            }
        })
    })
}

#[cfg(test)]
impl Clock for test_support::TestClock {
    fn now(&self) -> u64 {
        test_support::TestClock::now(self)
    }
    fn wall(&self) -> u64 {
        test_support::TestClock::wall(self)
    }
    fn sleep_until(&self, deadline: u64) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(test_support::TestClock::sleep_until(self, deadline))
    }
}
fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

fn server_name_for_host(name: &str) -> String {
    if cfg!(target_os = "macos") && !name.contains('.') {
        format!("{name}.local")
    } else {
        name.to_owned()
    }
}

async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow() {
            return;
        }
        if cancel.changed().await.is_err() {
            return;
        }
    }
}

async fn until<T>(
    cancel: &mut watch::Receiver<bool>,
    future: impl Future<Output = T>,
) -> Option<T> {
    tokio::select! {
        biased;
        _ = cancelled(cancel) => None,
        value = future => Some(value),
    }
}
