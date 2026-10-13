use super::{
    errors::{self, diagnostic},
    framing, headers, proxy,
};
use crate::{Error, json};
use bytes::Bytes;
use futures_util::future::poll_fn;
use h2::{
    RecvStream, SendStream,
    client::{ResponseFuture, SendRequest},
};
use http::{HeaderMap, Request};
use reqwest::Url;
use rustls::{ClientConfig, pki_types::ServerName};
use std::{
    collections::{BTreeMap, VecDeque},
    net::SocketAddr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, BufReader},
    net::TcpStream,
    sync::watch,
    task::JoinHandle,
    time::timeout,
};
use tokio_rustls::TlsConnector;

pub fn tls_config() -> Result<Arc<ClientConfig>, Error> {
    let provider = rustls::crypto::CryptoProvider::get_default()
        .cloned()
        .unwrap_or_else(|| Arc::new(rustls::crypto::aws_lc_rs::default_provider()));
    let verifier = rustls_platform_verifier::Verifier::new(provider.clone()).map_err(|_| {
        Error::transport(
            "Cursor TLS platform verifier could not be constructed",
            "client",
        )
    })?;
    let mut config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|_| Error::transport("Cursor TLS protocol versions are invalid", "client"))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    config.alpn_protocols = vec![b"h2".to_vec()];
    Ok(Arc::new(config))
}
#[derive(Clone)]
pub struct Endpoint(Url);
impl Endpoint {
    pub fn agent(value: &str) -> Result<Self, Error> {
        let origin = headers::agent_origin(value)
            .ok_or_else(|| Error::invalid("Cursor Run requires an HTTPS Cursor agent origin"))?;
        Ok(Self(
            Url::parse(&format!("{origin}/agent.v1.AgentService/Run"))
                .map_err(|_| Error::invalid("Cursor Run origin is invalid"))?,
        ))
    }
    pub fn loopback(address: SocketAddr) -> Result<Self, Error> {
        if !address.ip().is_loopback() {
            return Err(Error::invalid(
                "Cursor cleartext test endpoints must be loopback addresses",
            ));
        }
        Ok(Self(
            Url::parse(&format!("http://{address}/agent.v1.AgentService/Run"))
                .map_err(|_| Error::invalid("Cursor loopback address is invalid"))?,
        ))
    }
    pub fn url(&self) -> &str {
        self.0.as_str()
    }
}
#[derive(Clone)]
pub struct Options {
    pub connect_timeout_ms: u64,
    pub ping_timeout_ms: u64,
    pub read_idle_ms: u64,
    pub write_drain_ms: u64,
    pub proxy: Option<Url>,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            connect_timeout_ms: 15_000,
            ping_timeout_ms: 5_000,
            read_idle_ms: 120_000,
            write_drain_ms: 15_000,
            proxy: None,
        }
    }
}
type Slot = Arc<tokio::sync::Mutex<Option<Arc<Session>>>>;
struct Pool {
    slots: Mutex<BTreeMap<String, Slot>>,
    tls: Arc<ClientConfig>,
    options: Options,
}
#[derive(Clone)]
pub struct Client {
    pool: Arc<Pool>,
}
struct Session {
    sender: SendRequest<Bytes>,
    ping: tokio::sync::Mutex<Option<h2::PingPong>>,
    driver: Mutex<Option<JoinHandle<Result<(), h2::Error>>>>,
    created: Instant,
    retired: AtomicBool,
}
impl Session {
    fn reusable(&self) -> bool {
        !self.retired.load(Ordering::Acquire)
            && self.created.elapsed() < Duration::from_secs(900)
            && self
                .driver
                .lock()
                .ok()
                .is_some_and(|driver| driver.as_ref().is_some_and(|driver| !driver.is_finished()))
    }
    async fn stop(&self) {
        let driver = self.driver.lock().ok().and_then(|mut driver| driver.take());
        if let Some(driver) = driver {
            driver.abort();
            let _ = driver.await;
        }
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        if let Ok(driver) = self.driver.get_mut()
            && let Some(driver) = driver.take()
        {
            driver.abort();
        }
    }
}
impl Client {
    pub fn new(options: Options) -> Result<Self, Error> {
        for value in [
            options.connect_timeout_ms,
            options.ping_timeout_ms,
            options.read_idle_ms,
            options.write_drain_ms,
        ] {
            if value == 0 || value > 2_147_483_647 {
                return Err(Error::invalid(
                    "Cursor transport timeouts must be positive integer milliseconds within int32",
                ));
            }
        }
        Ok(Self {
            pool: Arc::new(Pool {
                slots: Mutex::new(BTreeMap::new()),
                tls: tls_config()?,
                options,
            }),
        })
    }
    async fn session(&self, endpoint: &Endpoint) -> Result<Arc<Session>, Error> {
        let key = endpoint.0.origin().ascii_serialization();
        let slot = self
            .pool
            .slots
            .lock()
            .map_err(|_| Error::transport("Cursor connection cache lock failed", "client"))?
            .entry(key)
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(None)))
            .clone();
        let mut slot = slot.lock().await;
        if let Some(session) = slot.as_ref().filter(|session| session.reusable()) {
            let ping = async {
                session.sender.clone().ready().await.map_err(|error| {
                    io_error(
                        &error,
                        "Cursor cached HTTP/2 connection received GOAWAY",
                        true,
                    )
                })?;
                let mut ping = session.ping.lock().await;
                let ping = ping.as_mut().ok_or_else(|| {
                    Error::transport("Cursor connection cannot be pinged", "connect")
                })?;
                ping.ping(h2::Ping::opaque()).await.map_err(|_| {
                    Error::transport("Cursor cached HTTP/2 connection ping failed", "connect")
                })
            };
            if timeout(
                Duration::from_millis(self.pool.options.ping_timeout_ms),
                ping,
            )
            .await
            .is_ok_and(|result| result.is_ok())
            {
                return Ok(session.clone());
            }
            session.retired.store(true, Ordering::Release);
        }
        let connect = async {
            let host = endpoint
                .0
                .host_str()
                .ok_or_else(|| Error::invalid("Cursor endpoint has no host"))?;
            let host = host
                .strip_prefix('[')
                .and_then(|host| host.strip_suffix(']'))
                .unwrap_or(host);
            let port = endpoint
                .0
                .port_or_known_default()
                .ok_or_else(|| Error::invalid("Cursor endpoint has no port"))?;
            let socket = if let Some(proxy) = &self.pool.options.proxy {
                proxy::connect(proxy, host, port).await?
            } else {
                BufReader::new(TcpStream::connect((host, port)).await.map_err(|_| {
                    failure(
                        "Cursor TCP connection failed",
                        "CURSOR_CONNECT_FAILED",
                        true,
                    )
                })?)
            };
            if endpoint.0.scheme() == "http" {
                return establish(socket).await;
            }
            let name = ServerName::try_from(host.to_owned())
                .map_err(|_| Error::invalid("Cursor TLS server name is invalid"))?;
            let socket = TlsConnector::from(self.pool.tls.clone())
                .connect(name, socket)
                .await
                .map_err(|_| failure("Cursor TLS handshake failed", "CURSOR_TLS_FAILED", true))?;
            if socket.get_ref().1.alpn_protocol() != Some(b"h2".as_slice()) {
                return Err(failure(
                    "Cursor TLS peer did not negotiate HTTP/2",
                    "CURSOR_TLS_ALPN",
                    true,
                ));
            }
            establish(socket).await
        };
        let session = timeout(
            Duration::from_millis(self.pool.options.connect_timeout_ms),
            connect,
        )
        .await
        .map_err(|_| {
            failure(
                "Cursor HTTP/2 connect timed out",
                "CURSOR_CONNECT_TIMEOUT",
                true,
            )
        })??;
        let session = Arc::new(session);
        *slot = Some(session.clone());
        Ok(session)
    }
    pub async fn open(&self, endpoint: &Endpoint, headers: HeaderMap) -> Result<Run, Error> {
        let session = self.session(endpoint).await?;
        let mut sender = session
            .sender
            .clone()
            .ready()
            .await
            .map_err(|error| io_error(&error, "Cursor HTTP/2 connection is not ready", true))?;
        let mut request = Request::builder()
            .method("POST")
            .uri(endpoint.url())
            .body(())
            .map_err(|_| Error::invalid("Cursor HTTP/2 request is invalid"))?;
        request.headers_mut().extend(headers.clone());
        let (response, send) = sender
            .send_request(request, false)
            .map_err(|error| io_error(&error, "Cursor HTTP/2 Run request failed", true))?;
        let (closed, _) = watch::channel(false);
        let shared = Arc::new(Shared {
            closed,
            failure: Mutex::new(None),
        });
        Ok(Run {
            writer: Writer {
                send: Arc::new(tokio::sync::Mutex::new(send)),
                shared: shared.clone(),
                session: session.clone(),
                timeout_ms: self.pool.options.write_drain_ms,
            },
            reader: Reader {
                response: Some(response),
                body: None,
                headers: HeaderMap::new(),
                request_headers: headers,
                status: 0,
                shared,
                session,
                idle_ms: self.pool.options.read_idle_ms,
                decoder: framing::Decoder::default(),
                frames: VecDeque::new(),
            },
        })
    }
    pub async fn shutdown(&self) {
        let slots = self
            .pool
            .slots
            .lock()
            .map(|mut slots| std::mem::take(&mut *slots))
            .unwrap_or_default();
        for slot in slots.into_values() {
            if let Some(session) = slot.lock().await.take() {
                session.stop().await;
            }
        }
    }
}
async fn establish(
    socket: impl AsyncRead + AsyncWrite + Unpin + Send + 'static,
) -> Result<Session, Error> {
    let (sender, mut connection) = h2::client::handshake(socket)
        .await
        .map_err(|error| io_error(&error, "Cursor HTTP/2 handshake failed", true))?;
    let ping = connection.ping_pong();
    Ok(Session {
        sender,
        ping: tokio::sync::Mutex::new(ping),
        driver: Mutex::new(Some(tokio::spawn(connection))),
        created: Instant::now(),
        retired: AtomicBool::new(false),
    })
}
struct Shared {
    closed: watch::Sender<bool>,
    failure: Mutex<Option<Error>>,
}
pub struct Run {
    pub writer: Writer,
    pub reader: Reader,
}
#[derive(Clone)]
pub struct Writer {
    send: Arc<tokio::sync::Mutex<SendStream<Bytes>>>,
    shared: Arc<Shared>,
    session: Arc<Session>,
    timeout_ms: u64,
}
impl Writer {
    pub async fn write(&self, payload: &[u8]) -> Result<(), Error> {
        let mut closed = self.shared.closed.subscribe();
        if *closed.borrow() {
            return Err(diagnostic(
                Error::interrupted(),
                "local-cancel",
                false,
                false,
            ));
        }
        if let Some(error) = self
            .shared
            .failure
            .lock()
            .map_err(|_| Error::transport("Cursor terminal state lock failed", "write"))?
            .clone()
        {
            return Err(error);
        }
        let data = Bytes::from(framing::encode(0, payload)?);
        let write = async {
            let mut send = self.send.lock().await;
            let mut data = data;
            while !data.is_empty() {
                send.reserve_capacity(data.len());
                let capacity = poll_fn(|context| send.poll_capacity(context))
                    .await
                    .ok_or_else(|| {
                        failure(
                            "Cursor Run is no longer writable",
                            "CURSOR_STREAM_CLOSED",
                            false,
                        )
                    })?
                    .map_err(|error| io_error(&error, "Cursor Run write failed", false))?;
                if capacity == 0 {
                    continue;
                }
                let count = capacity.min(data.len());
                send.send_data(data.split_to(count), false)
                    .map_err(|error| io_error(&error, "Cursor Run write failed", false))?;
            }
            Ok(())
        };
        let result = tokio::select! {
            result = timeout(Duration::from_millis(self.timeout_ms), write) => result.map_err(|_| failure("Cursor Run write backpressure timed out", "CURSOR_WRITE_DRAIN_TIMEOUT", false)).and_then(|result| result),
            _ = closed.changed() => Err(diagnostic(Error::interrupted(), "local-cancel", false, false)),
        };
        if let Err(error) = &result {
            if let Ok(mut failure) = self.shared.failure.lock() {
                *failure = Some(error.clone());
            }
            self.session.retired.store(true, Ordering::Release);
            self.send.lock().await.send_reset(h2::Reason::CANCEL);
        }
        result
    }
    pub async fn close(&self) -> Result<(), Error> {
        self.shared.closed.send_replace(true);
        self.send
            .lock()
            .await
            .send_data(Bytes::new(), true)
            .map_err(|error| io_error(&error, "Cursor local close failed", false))
    }
    pub fn cancel(&self) {
        self.shared.closed.send_replace(true);
        if let Ok(mut send) = self.send.try_lock() {
            send.send_reset(h2::Reason::CANCEL);
        }
    }
}
impl Drop for Writer {
    fn drop(&mut self) {
        if Arc::strong_count(&self.send) == 1 && !*self.shared.closed.borrow() {
            self.cancel();
        }
    }
}
pub struct Reader {
    response: Option<ResponseFuture>,
    body: Option<RecvStream>,
    headers: HeaderMap,
    request_headers: HeaderMap,
    status: u16,
    shared: Arc<Shared>,
    session: Arc<Session>,
    idle_ms: u64,
    decoder: framing::Decoder,
    frames: VecDeque<framing::Frame>,
}
impl Reader {
    pub async fn next(&mut self) -> Result<Option<framing::Frame>, Error> {
        let mut closed = self.shared.closed.subscribe();
        if *closed.borrow() {
            self.frames.clear();
            return Ok(None);
        }
        let result = tokio::select! {
            result = self.read() => result,
            _ = closed.changed() => Ok(None),
        };
        if let Err(error) = &result {
            if let Ok(mut failure) = self.shared.failure.lock() {
                *failure = Some(error.clone());
            }
            self.session.retired.store(true, Ordering::Release);
        }
        result
    }
    async fn read(&mut self) -> Result<Option<framing::Frame>, Error> {
        loop {
            if let Some(frame) = self.frames.pop_front() {
                return Ok(Some(frame));
            }
            if let Some(error) = self
                .shared
                .failure
                .lock()
                .map_err(|_| Error::transport("Cursor terminal state lock failed", "read"))?
                .clone()
            {
                return Err(error);
            }
            if let Some(response) = self.response.take() {
                let response = timeout(Duration::from_millis(self.idle_ms), response)
                    .await
                    .map_err(|_| {
                        failure(
                            "Cursor Run response read-idle timeout",
                            "CURSOR_READ_IDLE_TIMEOUT",
                            true,
                        )
                    })?
                    .map_err(|error| io_error(&error, "Cursor Run response failed", true))?;
                self.status = response.status().as_u16();
                self.headers = response.headers().clone();
                self.body = Some(response.into_body());
            }
            let body = self
                .body
                .as_mut()
                .ok_or_else(|| Error::transport("Cursor Run has no response stream", "read"))?;
            let chunk = timeout(Duration::from_millis(self.idle_ms), body.data())
                .await
                .map_err(|_| {
                    failure(
                        "Cursor Run read-idle timeout",
                        "CURSOR_READ_IDLE_TIMEOUT",
                        true,
                    )
                })?;
            if let Some(chunk) = chunk {
                let chunk =
                    chunk.map_err(|error| self.termination(&HeaderMap::new(), Some(&error)))?;
                self.body
                    .as_mut()
                    .ok_or_else(|| Error::transport("Cursor Run has no body", "read"))?
                    .flow_control()
                    .release_capacity(chunk.len())
                    .map_err(|error| {
                        io_error(&error, "Cursor Run flow-control update failed", true)
                    })?;
                self.frames.extend(self.decoder.push(&chunk));
                continue;
            }
            let trailers = body
                .trailers()
                .await
                .map_err(|error| self.termination(&HeaderMap::new(), Some(&error)))?
                .unwrap_or_default();
            return Err(self.termination(&trailers, None));
        }
    }
    fn termination(&self, trailers: &HeaderMap, raw: Option<&h2::Error>) -> Error {
        let mut error = if let Some(raw) = raw {
            io_error(raw, "Cursor Run transport interrupted", true)
        } else if self.status != 0 && self.status != 200 {
            errors::http(self.status)
        } else if let Some(status) = trailers
            .get("grpc-status")
            .or_else(|| self.headers.get("grpc-status"))
            .and_then(|value| value.to_str().ok())
            .filter(|value| *value != "0")
        {
            let mut error = errors::grpc(status);
            if let Some(metadata) = &mut error.provider_metadata
                && let Some(cursor) = json::get(metadata, "cursor").cloned()
            {
                let mut cursor = cursor;
                json::set(&mut cursor, "grpcStatus", json::s(status));
                json::set(metadata, "cursor", cursor);
            }
            if let Some(message) = trailers
                .get("grpc-message")
                .or_else(|| self.headers.get("grpc-message"))
                .and_then(|value| value.to_str().ok())
            {
                error.message.push_str(&format!(": {message}"));
            }
            error
        } else {
            failure(
                "Cursor Run ended before turn_ended",
                "CURSOR_RUN_INTERRUPTED",
                true,
            )
        };
        for (name, header) in &self.request_headers {
            if (header.is_sensitive()
                || matches!(
                    name.as_str(),
                    "authorization" | "proxy-authorization" | "x-api-key" | "api-key" | "cookie"
                ))
                && let Ok(value) = header.to_str()
                && !value.is_empty()
            {
                error.message = error.message.replace(value, "<redacted>");
                if let Some(token) = value.strip_prefix("Bearer ") {
                    error.message = error.message.replace(token, "<redacted>");
                }
            }
        }
        error
    }
}
fn failure(message: &str, code: &str, safe: bool) -> Error {
    diagnostic(
        Error {
            code: Some(code.into()),
            ..Error::transport(message, "read")
        },
        "transport",
        code != "CURSOR_WRITE_DRAIN_TIMEOUT",
        safe,
    )
}
fn io_error(error: &h2::Error, message: &str, safe: bool) -> Error {
    let mut result = failure(message, "ERR_HTTP2_STREAM_ERROR", safe);
    if let Some(reason) = error.reason()
        && let Some(metadata) = &mut result.provider_metadata
        && let Some(cursor) = json::get(metadata, "cursor").cloned()
    {
        let mut cursor = cursor;
        json::set(
            &mut cursor,
            "rstCode",
            ycoding_schema::JsonValue::Number(f64::from(u32::from(reason))),
        );
        json::set(metadata, "cursor", cursor);
    }
    result
}
