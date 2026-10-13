use super::client::{Notification, SUPPORTED_VERSIONS};
use rmcp::{
    RoleClient,
    model::{ClientJsonRpcMessage, ServerJsonRpcMessage},
    transport::Transport,
};
use std::time::Duration;
use tokio::sync::broadcast;

#[derive(Debug)]
pub(crate) struct SdkRetry;
impl rmcp::transport::common::client_side_sse::SseRetryPolicy for SdkRetry {
    fn retry(&self, attempt: usize) -> Option<Duration> {
        (attempt < 2).then(|| Duration::from_secs_f64(1.5_f64.powi(attempt as i32).min(30.0)))
    }
}

pub(crate) struct Pinned<T> {
    pub inner: T,
    pub notifications: broadcast::Sender<Notification>,
}

impl<T: Transport<RoleClient>> Transport<RoleClient> for Pinned<T> {
    type Error = T::Error;
    fn send(
        &mut self,
        message: ClientJsonRpcMessage,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        let mut value = serde_json::to_value(&message).expect("MCP message serialization");
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
        self.inner
            .send(serde_json::from_value(value).expect("MCP metadata removal preserves message"))
    }
    async fn receive(&mut self) -> Option<ServerJsonRpcMessage> {
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
