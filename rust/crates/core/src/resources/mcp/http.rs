use super::oauth;
use crate::resources::credential::{Info, Service};
use reqwest::header::{
    ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderName, HeaderValue, WWW_AUTHENTICATE,
};
use rmcp::{
    model::{ClientJsonRpcMessage, ServerJsonRpcMessage},
    transport::{
        common::client_side_sse::BoxedSseResponse,
        common::http_header::{
            EVENT_STREAM_MIME_TYPE, HEADER_LAST_EVENT_ID, HEADER_SESSION_ID, JSON_MIME_TYPE,
        },
        streamable_http_client::{
            AuthRequiredError, InsufficientScopeError, StreamableHttpClient, StreamableHttpError,
            StreamableHttpPostResponse,
        },
    },
};
use std::{collections::HashMap, future::Future, sync::Arc};
use tokio::sync::Mutex;
use ycoding_schema::{LosslessString, credential, mcp::RemoteConfig};

struct Authentication {
    service: Service,
    config: RemoteConfig,
    credential: Option<LosslessString>,
    current: Option<Info>,
    last_scope_header: Option<String>,
}
impl Authentication {
    // Other connections and processes rotate the same credential row, so every request starts from it.
    fn reload(&mut self) -> Result<(), StreamableHttpError<reqwest::Error>> {
        let Some(id) = &self.credential else {
            return Ok(());
        };
        self.current = self.service.get(id).map_err(|_| {
            StreamableHttpError::Auth(rmcp::transport::auth::AuthError::CredentialStoreError(
                "MCP credential storage failed".into(),
            ))
        })?;
        Ok(())
    }
}

#[derive(Clone)]
pub(crate) struct Http {
    client: reqwest::Client,
    authentication: Option<Arc<Mutex<Authentication>>>,
}
impl Http {
    async fn post_app(
        &self,
        uri: &str,
        message: &ClientJsonRpcMessage,
        session: Option<&str>,
        token: Option<&str>,
        custom: HashMap<HeaderName, HeaderValue>,
    ) -> Result<StreamableHttpPostResponse, StreamableHttpError<reqwest::Error>> {
        let ClientJsonRpcMessage::Request(request) = message else {
            return Err(StreamableHttpError::UnexpectedEndOfStream);
        };
        let mut post = self
            .client
            .post(uri)
            .header(ACCEPT, "application/json, text/event-stream");
        if let Some(token) = token {
            post = post.bearer_auth(token);
        }
        if let Some(session) = session {
            post = post.header(HEADER_SESSION_ID, session);
        }
        for (key, value) in custom {
            if ["accept", HEADER_SESSION_ID, HEADER_LAST_EVENT_ID]
                .iter()
                .any(|name| key.as_str().eq_ignore_ascii_case(name))
            {
                return Err(StreamableHttpError::ReservedHeaderConflict(key.to_string()));
            }
            post = post.header(key, value);
        }
        let mut response = post.json(message).send().await?;
        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND && session.is_some() {
            return Err(StreamableHttpError::SessionExpired);
        }
        if let Some(challenge) = response
            .headers()
            .get(WWW_AUTHENTICATE)
            .and_then(|header| header.to_str().ok())
        {
            if status == reqwest::StatusCode::UNAUTHORIZED {
                return Err(StreamableHttpError::AuthRequired(AuthRequiredError::new(
                    challenge.to_owned(),
                )));
            }
            if status == reqwest::StatusCode::FORBIDDEN {
                return Err(StreamableHttpError::InsufficientScope(
                    InsufficientScopeError::new(
                        challenge.to_owned(),
                        oauth::header_field(challenge, "scope").map(str::to_owned),
                    ),
                ));
            }
        }
        response = response.error_for_status()?;
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        let streaming = content_type.starts_with(EVENT_STREAM_MIME_TYPE);
        if !streaming && !content_type.starts_with(JSON_MIME_TYPE) {
            return Err(StreamableHttpError::UnexpectedContentType(Some(
                content_type.to_owned(),
            )));
        }
        let mut buffer = Vec::new();
        let mut sse = ycoding_ai::framing::Sse::default();
        let mut remaining = 2 * 1024 * 1024_usize;
        while let Some(chunk) = response.chunk().await? {
            remaining = remaining
                .checked_sub(chunk.len())
                .ok_or(StreamableHttpError::UnexpectedEndOfStream)?;
            if streaming {
                for frame in sse.push(&chunk) {
                    let message = super::transport::server_message(frame.as_bytes())?;
                    if matches!(&message, ServerJsonRpcMessage::Response(result) if result.id == request.id)
                        || matches!(&message, ServerJsonRpcMessage::Error(result) if result.id.as_ref() == Some(&request.id))
                    {
                        return Ok(StreamableHttpPostResponse::Json(message, None));
                    }
                }
            } else {
                buffer.extend_from_slice(&chunk);
            }
        }
        if streaming {
            return Err(StreamableHttpError::UnexpectedEndOfStream);
        }
        Ok(StreamableHttpPostResponse::Json(
            super::transport::server_message(&buffer)?,
            None,
        ))
    }
    pub(crate) fn new(
        name: &str,
        config: &RemoteConfig,
        service: Option<&Service>,
    ) -> Result<Self, oauth::Error> {
        let service =
            service.filter(|_| !matches!(config.oauth, Some(ycoding_schema::mcp::OAuth::Disabled)));
        Ok(Self {
            client: reqwest::Client::new(),
            authentication: service
                .map(|service| {
                    let current = oauth::stored(service, name, config)?;
                    Ok::<_, oauth::Error>(Arc::new(Mutex::new(Authentication {
                        service: service.clone(),
                        config: config.clone(),
                        credential: current.as_ref().map(|info| info.id().clone()),
                        current,
                        last_scope_header: None,
                    })))
                })
                .transpose()?,
        })
    }
    async fn call<T, F, Fut>(
        &self,
        auth: Option<String>,
        invoke: F,
    ) -> Result<T, StreamableHttpError<reqwest::Error>>
    where
        F: Fn(Option<String>) -> Fut + Send + Sync,
        Fut: Future<Output = Result<T, StreamableHttpError<reqwest::Error>>> + Send,
        T: Send,
    {
        let Some(authentication) = &self.authentication else {
            return invoke(auth).await;
        };
        let mut expected = {
            let mut authentication = authentication.lock().await;
            authentication.reload()?;
            authentication.current.clone()
        };
        let mut token = access(expected.as_ref())?.or(auth);
        let mut completed_auth = false;
        loop {
            let result = invoke(token).await;
            if result.is_ok() {
                authentication.lock().await.last_scope_header = None;
                return result;
            }
            let upscoping = matches!(&result, Err(StreamableHttpError::InsufficientScope(_)));
            let challenge = match &result {
                Err(StreamableHttpError::AuthRequired(error)) => {
                    Some(error.www_authenticate_header.clone())
                }
                Err(StreamableHttpError::InsufficientScope(error))
                    if oauth::header_field(&error.www_authenticate_header, "error")
                        == Some("insufficient_scope") =>
                {
                    Some(error.www_authenticate_header.clone())
                }
                _ => None,
            };
            let Some(challenge) = challenge else {
                return result;
            };
            let mut authentication = authentication.lock().await;
            if upscoping {
                if authentication.last_scope_header.as_ref() == Some(&challenge) {
                    return result;
                }
                authentication.last_scope_header = Some(challenge.clone());
            } else if completed_auth {
                return result;
            }
            authentication.reload()?;
            let mut prepared = false;
            let renewed = match (&authentication.current, &expected) {
                (Some(current), Some(expected))
                    if current.generation() != expected.generation()
                        || current.account_generation() != expected.account_generation() =>
                {
                    Ok(current.clone())
                }
                (Some(current), _) => {
                    oauth::renew(
                        &authentication.service,
                        current,
                        &authentication.config,
                        Some(&challenge),
                    )
                    .await
                }
                (None, _) => {
                    oauth::prepare_authorization(&authentication.config, &challenge, None)
                        .await
                        .map_err(|_| {
                            StreamableHttpError::UnexpectedServerResponse(
                                "MCP OAuth authorization preparation failed".into(),
                            )
                        })?;
                    prepared = true;
                    Err(oauth::Error::NeedsAuth)
                }
            };
            match renewed {
                Ok(info) => authentication.current = Some(info),
                Err(oauth::Error::NeedsAuth) => {
                    authentication.current = match &authentication.current {
                        Some(info) => authentication.service.get(info.id()).map_err(|_| {
                            StreamableHttpError::Auth(
                                rmcp::transport::auth::AuthError::CredentialStoreError(
                                    "MCP credential storage failed".into(),
                                ),
                            )
                        })?,
                        None => None,
                    };
                    if !prepared {
                        oauth::prepare_authorization(
                            &authentication.config,
                            &challenge,
                            authentication.current.as_ref(),
                        )
                        .await
                        .map_err(|_| {
                            StreamableHttpError::UnexpectedServerResponse(
                                "MCP OAuth authorization preparation failed".into(),
                            )
                        })?;
                    }
                    return Err(StreamableHttpError::AuthRequired(AuthRequiredError::new(
                        challenge,
                    )));
                }
                Err(oauth::Error::Storage) => {
                    return Err(StreamableHttpError::Auth(
                        rmcp::transport::auth::AuthError::CredentialStoreError(
                            "MCP credential storage failed".into(),
                        ),
                    ));
                }
                Err(_) => {
                    return Err(StreamableHttpError::UnexpectedServerResponse(
                        "MCP OAuth authentication failed".into(),
                    ));
                }
            }
            if !upscoping {
                completed_auth = true;
            }
            expected = authentication.current.clone();
            token = access(authentication.current.as_ref())?;
            drop(authentication);
        }
    }
}
fn access(info: Option<&Info>) -> Result<Option<String>, StreamableHttpError<reqwest::Error>> {
    info.map(|info| {
        let credential::Value::OAuth(value) = info.secret().domain().map_err(|_| {
            StreamableHttpError::UnexpectedServerResponse("Invalid MCP credential".into())
        })?
        else {
            return Err(StreamableHttpError::UnexpectedServerResponse(
                "Invalid MCP credential".into(),
            ));
        };
        value.access.to_utf8().map_err(|_| {
            StreamableHttpError::UnexpectedServerResponse("Invalid MCP credential".into())
        })
    })
    .transpose()
}
fn headers(
    mut headers: HashMap<HeaderName, HeaderValue>,
    token: &Option<String>,
) -> HashMap<HeaderName, HeaderValue> {
    if token.is_some() {
        headers.remove(&AUTHORIZATION);
    }
    headers
}
impl StreamableHttpClient for Http {
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
        if super::transport::app_read(&message) {
            return self
                .call(auth, |token| {
                    let custom = headers(custom.clone(), &token);
                    let (uri, message, session) = (&uri, &message, session.as_deref());
                    async move {
                        self.post_app(uri, message, session, token.as_deref(), custom)
                            .await
                    }
                })
                .await;
        }
        self.call(auth, |token| {
            self.client.post_message_with_max_sse_event_size(
                uri.clone(),
                message.clone(),
                session.clone(),
                token.clone(),
                headers(custom.clone(), &token),
                max,
            )
        })
        .await
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
        self.call(auth, |token| {
            self.client.get_stream_with_max_sse_event_size(
                uri.clone(),
                session.clone(),
                last.clone(),
                token.clone(),
                headers(custom.clone(), &token),
                max,
            )
        })
        .await
    }
    async fn delete_session(
        &self,
        uri: Arc<str>,
        session: Arc<str>,
        auth: Option<String>,
        custom: HashMap<HeaderName, HeaderValue>,
    ) -> Result<(), StreamableHttpError<Self::Error>> {
        self.call(auth, |token| {
            self.client.delete_session(
                uri.clone(),
                session.clone(),
                token.clone(),
                headers(custom.clone(), &token),
            )
        })
        .await
    }
}
