use super::{Cancellation, HttpResponse, ResultFuture, authorization_unavailable};
use std::time::Duration;

pub struct Request {
    pub url: String,
    pub bearer: String,
    pub body: String,
}
pub trait Http: Send + Sync {
    fn post(&self, request: Request, cancellation: Cancellation) -> ResultFuture<'_, HttpResponse>;
}
pub struct RelayHttp {
    client: reqwest::Client,
}
impl RelayHttp {
    pub fn new() -> Result<Self, ycoding_schema::mcp_events::Failure> {
        Ok(Self {
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(10))
                .build()
                .map_err(|_| authorization_unavailable())?,
        })
    }
}
impl Http for RelayHttp {
    fn post(&self, request: Request, cancellation: Cancellation) -> ResultFuture<'_, HttpResponse> {
        Box::pin(async move {
            let work = async {
                let url = url::Url::parse(&request.url).map_err(|_| authorization_unavailable())?;
                let origin =
                    crate::remote::normalize_origin(url.origin().ascii_serialization().as_str())
                        .ok_or_else(authorization_unavailable)?;
                if !url.username().is_empty()
                    || url.password().is_some()
                    || url.query().is_some()
                    || url.fragment().is_some()
                    || !url.path().starts_with("/api/devices/")
                    || !url.path().ends_with("/mcp/events/authorize")
                    || request.body.len() > 32 * 1024
                    || request.bearer.is_empty()
                    || request.bearer.len() > 8192
                    || request
                        .bearer
                        .bytes()
                        .any(|byte| byte.is_ascii_whitespace() || byte < 32 || byte == 127)
                {
                    return Err(authorization_unavailable());
                }
                if url.origin().ascii_serialization() != origin {
                    return Err(authorization_unavailable());
                }
                let mut response = self
                    .client
                    .post(url)
                    .bearer_auth(request.bearer)
                    .header("content-type", "application/json")
                    .body(request.body)
                    .send()
                    .await
                    .map_err(|_| authorization_unavailable())?;
                if response.content_length().is_some_and(|bytes| bytes > 8192) {
                    return Err(authorization_unavailable());
                }
                let status = response.status().as_u16();
                let mut bytes = Vec::new();
                while let Some(chunk) = response
                    .chunk()
                    .await
                    .map_err(|_| authorization_unavailable())?
                {
                    if bytes.len().saturating_add(chunk.len()) > 8192 {
                        return Err(authorization_unavailable());
                    }
                    bytes.extend_from_slice(&chunk);
                }
                Ok(HttpResponse {
                    status,
                    body: String::from_utf8(bytes).map_err(|_| authorization_unavailable())?,
                })
            };
            tokio::select! {biased;_=cancellation.cancelled()=>Err(authorization_unavailable()),result=tokio::time::timeout(Duration::from_secs(10),work)=>result.map_err(|_|authorization_unavailable())?}
        })
    }
}
