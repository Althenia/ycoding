use super::{
    client::{Notification, SUPPORTED_VERSIONS},
    http::Http,
};
use reqwest::header::{HeaderName, HeaderValue};
use rmcp::{
    RoleClient,
    model::{ClientJsonRpcMessage, ClientRequest, GetExtensions, RequestId, ServerJsonRpcMessage},
    transport::{
        Transport,
        common::client_side_sse::BoxedSseResponse,
        streamable_http_client::{
            StreamableHttpClient, StreamableHttpError, StreamableHttpPostResponse,
        },
    },
};
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::broadcast;

#[derive(Clone)]
pub(super) struct AppRead;

#[derive(Debug)]
pub(crate) struct SdkRetry;
impl rmcp::transport::common::client_side_sse::SseRetryPolicy for SdkRetry {
    fn retry(&self, attempt: usize) -> Option<Duration> {
        (attempt < 2).then(|| Duration::from_secs_f64(1.5_f64.powi(attempt as i32).min(30.0)))
    }
}

pub(crate) struct Pinned<T> {
    inner: T,
    notifications: broadcast::Sender<Notification>,
    discovered: Option<Value>,
    replies: VecDeque<ServerJsonRpcMessage>,
}

impl<T> Pinned<T> {
    pub(crate) fn new(
        inner: T,
        notifications: broadcast::Sender<Notification>,
        discovered: Option<Value>,
    ) -> Self {
        Self {
            inner,
            notifications,
            discovered,
            replies: VecDeque::new(),
        }
    }
}

impl<T: Transport<RoleClient>> Transport<RoleClient> for Pinned<T> {
    type Error = T::Error;
    fn send(
        &mut self,
        message: ClientJsonRpcMessage,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        let app = app_read(&message);
        let mut value = serde_json::to_value(&message).expect("MCP message serialization");
        let replay = (value["method"] == "server/discover")
            .then(|| self.discovered.take())
            .flatten()
            .and_then(|result| {
                serde_json::from_value(
                    serde_json::json!({"jsonrpc":"2.0","id":value["id"],"result":result}),
                )
                .ok()
            });
        if let Some(reply) = replay {
            self.replies.push_back(reply);
            return forward(None);
        }
        if value["method"] != "tools/call"
            && let Some(params) = value["params"].as_object_mut()
            && let Some(meta) = params
                .get_mut("_meta")
                .and_then(serde_json::Value::as_object_mut)
        {
            meta.remove("progressToken");
            if meta.is_empty() {
                params.remove("_meta");
            }
        }
        let mut message =
            serde_json::from_value(value).expect("MCP metadata removal preserves message");
        if app && let ClientJsonRpcMessage::Request(request) = &mut message {
            request.request.extensions_mut().insert(AppRead);
        }
        forward(Some(self.inner.send(message)))
    }
    async fn receive(&mut self) -> Option<ServerJsonRpcMessage> {
        if let Some(reply) = self.replies.pop_front() {
            return Some(reply);
        }
        let message = self.inner.receive().await?;
        let value = serde_json::to_value(&message).ok()?;
        if let Some(version) = value["result"]["protocolVersion"].as_str()
            && !SUPPORTED_VERSIONS.contains(&version)
        {
            return serde_json::from_value(serde_json::json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32602,"message":format!("Server's protocol version is not supported: {version}")}})).ok();
        }
        Some(message)
    }
    async fn close(&mut self) -> Result<(), Self::Error> {
        let result = self.inner.close().await;
        let _ = self.notifications.send(Notification {
            method: "connection/closed".into(),
            params: serde_json::Value::Null,
        });
        result
    }
}

async fn forward<E, F: Future<Output = Result<(), E>> + Send + 'static>(
    send: Option<F>,
) -> Result<(), E> {
    match send {
        Some(send) => send.await,
        None => Ok(()),
    }
}

#[derive(Clone)]
pub(crate) struct Renewal {
    inner: Http,
    expired: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
    app_session_expired: Arc<AtomicBool>,
}

impl Renewal {
    pub(crate) fn new(
        inner: Http,
        failed: Arc<AtomicBool>,
        app_session_expired: Arc<AtomicBool>,
    ) -> Self {
        Self {
            inner,
            expired: Arc::new(AtomicBool::new(false)),
            failed,
            app_session_expired,
        }
    }
}

pub(super) fn app_read(message: &ClientJsonRpcMessage) -> bool {
    matches!(message, ClientJsonRpcMessage::Request(request) if request.request.extensions().get::<AppRead>().is_some())
}

pub(super) fn server_message(raw: &[u8]) -> serde_json::Result<ServerJsonRpcMessage> {
    let mut value: Value = serde_json::from_slice(raw)?;
    if let Some(contents) = value
        .get_mut("result")
        .and_then(|result| result.get_mut("contents"))
        .and_then(Value::as_array_mut)
        && contents.iter().any(|part| {
            part["uri"]
                .as_str()
                .is_some_and(|uri| uri.starts_with("ui://"))
                && part.get("text").is_some()
                && part.get("blob").is_some()
        })
    {
        contents.clear();
    }
    serde_json::from_value(value)
}

impl StreamableHttpClient for Renewal {
    type Error = reqwest::Error;
    async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session: Option<Arc<str>>,
        auth: Option<String>,
        custom: HashMap<HeaderName, HeaderValue>,
    ) -> Result<StreamableHttpPostResponse, StreamableHttpError<Self::Error>> {
        self.post_message_with_max_sse_event_size(uri, message, session, auth, custom, usize::MAX)
            .await
    }
    async fn post_message_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session: Option<Arc<str>>,
        auth: Option<String>,
        custom: HashMap<HeaderName, HeaderValue>,
        max: usize,
    ) -> Result<StreamableHttpPostResponse, StreamableHttpError<Self::Error>> {
        let app = app_read(&message);
        if app && self.app_session_expired.load(Ordering::Acquire) {
            return Err(StreamableHttpError::UnexpectedEndOfStream);
        }
        let attached = session.is_some();
        let bootstrap = match &message {
            ClientJsonRpcMessage::Request(request)
                if !attached
                    && matches!(
                        request.request,
                        ClientRequest::InitializeRequest(_) | ClientRequest::DiscoverRequest(_)
                    ) =>
            {
                Some(request.id.clone())
            }
            _ => None,
        };
        let renewing = !attached
            && self.expired.load(Ordering::SeqCst)
            && matches!(&message, ClientJsonRpcMessage::Request(request) if matches!(request.request, ClientRequest::InitializeRequest(_)));
        let result = self
            .inner
            .post_message_with_max_sse_event_size(uri, message, session, auth, custom, max)
            .await;
        let result = match (result, bootstrap) {
            (Ok(response), Some(id)) => bootstrap_response(response, &id).await,
            (result, _) => result,
        };
        if attached && matches!(result, Err(StreamableHttpError::SessionExpired)) {
            self.expired.store(true, Ordering::SeqCst);
            self.app_session_expired.store(true, Ordering::Release);
            if app {
                return Err(StreamableHttpError::UnexpectedEndOfStream);
            }
        }
        if renewing {
            self.expired.store(false, Ordering::SeqCst);
            if result.is_err() {
                self.failed.store(true, Ordering::SeqCst);
            }
        }
        result
    }
    async fn get_stream(
        &self,
        uri: Arc<str>,
        session: Option<Arc<str>>,
        last: Option<String>,
        auth: Option<String>,
        custom: HashMap<HeaderName, HeaderValue>,
    ) -> Result<BoxedSseResponse, StreamableHttpError<Self::Error>> {
        self.get_stream_with_max_sse_event_size(uri, session, last, auth, custom, usize::MAX)
            .await
    }
    async fn get_stream_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        session: Option<Arc<str>>,
        last: Option<String>,
        auth: Option<String>,
        custom: HashMap<HeaderName, HeaderValue>,
        max: usize,
    ) -> Result<BoxedSseResponse, StreamableHttpError<Self::Error>> {
        let attached = session.is_some();
        let result = self
            .inner
            .get_stream_with_max_sse_event_size(uri, session, last, auth, custom, max)
            .await;
        if attached && matches!(result, Err(StreamableHttpError::SessionExpired)) {
            self.app_session_expired.store(true, Ordering::Release);
        }
        result
    }
    async fn delete_session(
        &self,
        uri: Arc<str>,
        session: Arc<str>,
        auth: Option<String>,
        custom: HashMap<HeaderName, HeaderValue>,
    ) -> Result<(), StreamableHttpError<Self::Error>> {
        self.inner.delete_session(uri, session, auth, custom).await
    }
}

async fn bootstrap_response(
    response: StreamableHttpPostResponse,
    id: &RequestId,
) -> Result<StreamableHttpPostResponse, StreamableHttpError<reqwest::Error>> {
    let StreamableHttpPostResponse::Sse(mut stream, session) = response else {
        return Ok(response);
    };
    while let Some(event) = std::future::poll_fn(|context| stream.as_mut().poll_next(context)).await
    {
        let event = event?;
        let payload = event.data.unwrap_or_default();
        if payload.trim().is_empty() {
            continue;
        }
        let message = serde_json::from_str::<ServerJsonRpcMessage>(&payload)?;
        let matches = match &message {
            ServerJsonRpcMessage::Response(response) => &response.id == id,
            ServerJsonRpcMessage::Error(response) => response.id.as_ref() == Some(id),
            _ => false,
        };
        if matches {
            return Ok(StreamableHttpPostResponse::Json(message, session));
        }
    }
    Err(StreamableHttpError::UnexpectedEndOfStream)
}
