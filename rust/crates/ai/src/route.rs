use crate::{
    Error,
    auth::{Auth, Input, ProviderAuth},
    framing::{AwsEventStream, Framing, Sse},
    json,
    llm::{Defaults, Event, Model, Request, Response},
    provider_error::{Failure, HttpContext, classify, rate_limit_details, retry_after_ms},
    websocket,
};
use reqwest::{
    Client, Url,
    header::{HeaderMap, HeaderName, HeaderValue},
};
use std::{
    collections::{BTreeMap, VecDeque},
    fmt,
    future::Future,
    pin::Pin,
    sync::Arc,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use ycoding_schema::{JsonValue, LosslessString, parse_json, provider, stringify_json};

pub trait StreamParser: Send {
    fn push(&mut self, event: &JsonValue) -> Result<Vec<Event>, Error>;
    fn finish(&mut self) -> Result<Vec<Event>, Error>;
}
pub trait Protocol: Send + Sync {
    fn request_headers(&self, _request: &Request, headers: HeaderMap) -> Result<HeaderMap, Error> {
        Ok(headers)
    }
    fn response_headers(&self, _request: &Request, _headers: &HeaderMap) {}
    fn native(&self) -> Option<&crate::cursor::provider::Provider> {
        None
    }
    fn id(&self) -> &'static str;
    fn lower(&self, request: &Request) -> Result<JsonValue, Error>;
    fn parser(&self, request: &Request) -> Box<dyn StreamParser>;
    fn terminal(&self, _event: &JsonValue) -> bool {
        false
    }
}
type Path = Arc<dyn Fn(&Request, &JsonValue) -> String + Send + Sync>;
#[derive(Clone)]
pub struct Endpoint {
    pub base_url: String,
    pub path: String,
    pub dynamic_path: Option<Path>,
    pub query: BTreeMap<String, String>,
}
impl Endpoint {
    pub fn new(base_url: impl Into<String>, path: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            path: path.into(),
            dynamic_path: None,
            query: BTreeMap::new(),
        }
    }
    pub fn render(&self, request: &Request, body: &JsonValue) -> Result<Url, Error> {
        let path = self
            .dynamic_path
            .as_ref()
            .map(|path| path(request, body))
            .unwrap_or_else(|| self.path.clone());
        let url = Url::parse(&format!("{}{path}", self.base_url.trim_end_matches('/')))
            .map_err(|_| Error::invalid("Invalid provider endpoint URL"))?;
        Ok(apply_query(
            url,
            self.query.iter().chain(request.http.query.iter()),
        ))
    }
}
#[derive(Clone)]
pub enum Transport {
    Native,
    Http(Framing),
    Muse(Arc<crate::muse::Connection>),
    RunPodJobs,
    WebSocket(Arc<websocket::JsonTransport>),
    Process(Arc<dyn ProcessAttempt>),
}
#[derive(Clone, Debug)]
pub struct ProcessInput {
    pub model: LosslessString,
    pub options: Option<JsonValue>,
    pub body: JsonValue,
}
pub type AttemptFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Vec<JsonValue>, Error>> + Send + 'a>>;
pub trait ProcessAttempt: Send + Sync {
    fn attempt(&self, input: ProcessInput) -> AttemptFuture<'_>;
}
#[derive(Clone)]
pub struct Route {
    pub id: String,
    pub provider: provider::Id,
    pub provider_metadata_key: Option<String>,
    pub protocol: Arc<dyn Protocol>,
    pub endpoint: Endpoint,
    pub auth: Auth,
    pub transport: Transport,
    pub headers: BTreeMap<String, String>,
    pub defaults: Defaults,
}
impl Route {
    pub fn openai_chat() -> Self {
        Self {
            id: "openai-chat".into(),
            provider: provider::Id("openai".into()),
            provider_metadata_key: Some("openai".into()),
            protocol: Arc::new(crate::openai_chat::OpenAIChat),
            endpoint: Endpoint::new("https://api.openai.com/v1", "/chat/completions"),
            auth: Auth::None,
            transport: Transport::Http(Framing::Sse),
            headers: BTreeMap::new(),
            defaults: Defaults::default(),
        }
    }
    pub fn openai_responses() -> Self {
        Self {
            id: "openai-responses".into(),
            provider: provider::Id("openai".into()),
            provider_metadata_key: Some("openai".into()),
            protocol: Arc::new(crate::openai_responses::OpenAIResponses),
            endpoint: Endpoint::new("https://api.openai.com/v1", "/responses"),
            auth: Auth::None,
            transport: Transport::Http(Framing::Sse),
            headers: BTreeMap::new(),
            defaults: Defaults {
                provider_options: Some(json::object([(
                    "openai",
                    json::object([("store", JsonValue::Bool(false))]),
                )])),
                ..Defaults::default()
            },
        }
    }
    pub fn openai_responses_websocket() -> Self {
        let mut route = Self::openai_responses();
        route.id = "openai-responses-websocket".into();
        route.transport =
            Transport::WebSocket(Arc::new(crate::openai_responses::websocket_transport()));
        route
    }
    pub fn anthropic() -> Self {
        Self {
            id: "anthropic-messages".into(),
            provider: provider::Id("anthropic".into()),
            provider_metadata_key: Some("anthropic".into()),
            protocol: Arc::new(crate::anthropic::AnthropicMessages),
            endpoint: Endpoint::new("https://api.anthropic.com/v1", "/messages"),
            auth: Auth::None,
            transport: Transport::Http(Framing::Sse),
            headers: BTreeMap::from([("anthropic-version".into(), "2023-06-01".into())]),
            defaults: Defaults::default(),
        }
    }
    pub fn anthropic_provider(auth: ProviderAuth) -> Self {
        let mut route = Self::anthropic();
        route.auth = auth.apply();
        route
    }
    pub fn anthropic_compatible(
        base_url: impl Into<String>,
        provider: Option<provider::Id>,
        auth: ProviderAuth,
    ) -> Result<Self, Error> {
        let base_url = base_url.into();
        if base_url.is_empty() {
            return Err(Error::invalid(
                "Anthropic-compatible providers require a baseURL",
            ));
        }
        let mut route = Self::anthropic();
        route.provider = provider.unwrap_or_else(|| provider::Id("anthropic-compatible".into()));
        route.endpoint.base_url = base_url;
        route.auth = auth.apply();
        Ok(route)
    }
    pub fn model(&self, id: impl Into<LosslessString>) -> Model {
        Model {
            id: id.into(),
            provider: self.provider.clone(),
            route: Arc::new(self.clone()),
            defaults: Defaults::default(),
            tool_schema: None,
        }
    }
    pub fn prepare(&self, request: &Request) -> Result<Prepared, Error> {
        let mut request = request.resolved();
        crate::cache::apply(&mut request);
        if let Some(native) = self.protocol.native() {
            return native.prepare(self, request);
        }
        let body = self.protocol.lower(&request)?;
        let wire_body = if let Some(overlay) = &request.http.body {
            let JsonValue::Object(fields) = overlay else {
                return Err(Error::invalid("http.body must be a JSON object"));
            };
            let forbidden: Vec<_> = fields
                .iter()
                .filter_map(|(key, _)| {
                    key.as_str()
                        .filter(|key| PROTOCOL_BODY_OVERLAY_DENYLIST.contains(key))
                })
                .collect();
            if !forbidden.is_empty() {
                return Err(Error::invalid(format!(
                    "http.body cannot overlay protocol-owned field(s): {}",
                    forbidden.join(", ")
                )));
            }
            if !matches!(body, JsonValue::Object(_)) {
                return Err(Error::invalid(
                    "http.body can only overlay JSON object request bodies",
                ));
            }
            json::merge(&body, overlay)
        } else {
            body.clone()
        };
        let encoded_body = stringify_json(&wire_body);
        let url = self.endpoint.render(&request, &body)?;
        let headers = request_headers(self.headers.iter().chain(request.http.headers.iter()))?;
        let mut headers = self.auth.apply(Input {
            method: "POST",
            url: url.as_str(),
            body: &encoded_body,
            headers,
        })?;
        headers.insert("content-type", HeaderValue::from_static("application/json"));
        let headers = self.protocol.request_headers(&request, headers)?;
        Ok(Prepared {
            id: request.id.clone().unwrap_or_else(|| "request".into()),
            route: self.id.clone(),
            protocol: self.protocol.id(),
            body,
            wire_body,
            url,
            headers,
            encoded_body,
            request,
        })
    }
}
const PROTOCOL_BODY_OVERLAY_DENYLIST: &[&str] = &[
    "anthropic_version",
    "content",
    "contents",
    "frequencyPenalty",
    "frequency_penalty",
    "generationConfig",
    "inferenceConfig",
    "input",
    "maxTokens",
    "max_tokens",
    "messages",
    "model",
    "presencePenalty",
    "presence_penalty",
    "responseFormat",
    "response_format",
    "seed",
    "stop",
    "stopSequences",
    "stop_sequences",
    "stream",
    "streamOptions",
    "stream_options",
    "system",
    "systemInstruction",
    "system_instruction",
    "temperature",
    "thinking",
    "toolChoice",
    "toolConfig",
    "tool_choice",
    "tool_config",
    "tools",
    "topK",
    "topP",
    "top_k",
    "top_p",
];
pub(crate) fn apply_query<'a>(
    mut url: Url,
    values: impl Iterator<Item = (&'a String, &'a String)>,
) -> Url {
    let values: BTreeMap<_, _> = values.collect();
    for (key, value) in values {
        let mut query: Vec<_> = url
            .query_pairs()
            .filter(|(name, _)| name != key.as_str())
            .map(|(name, value)| (name.into_owned(), value.into_owned()))
            .collect();
        query.push((key.clone(), value.clone()));
        url.query_pairs_mut().clear().extend_pairs(query);
    }
    url
}
pub(crate) fn request_headers<'a>(
    values: impl Iterator<Item = (&'a String, &'a String)>,
) -> Result<HeaderMap, Error> {
    let mut headers = HeaderMap::new();
    for (name, value) in values {
        headers.insert(
            HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| Error::invalid("Invalid provider header name"))?,
            HeaderValue::from_str(value)
                .map_err(|_| Error::invalid("Invalid provider header value"))?,
        );
    }
    Ok(headers)
}
pub struct Prepared {
    pub id: LosslessString,
    pub route: String,
    pub protocol: &'static str,
    pub body: JsonValue,
    pub wire_body: JsonValue,
    pub url: Url,
    pub headers: HeaderMap,
    pub encoded_body: String,
    pub(crate) request: Request,
}
impl fmt::Debug for Prepared {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Prepared")
            .field("route", &self.route)
            .field("protocol", &self.protocol)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttemptPhase {
    Started,
    Succeeded,
    Failed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttemptStage {
    Request,
    Stream,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Attempt {
    pub request_id: LosslessString,
    pub route_id: String,
    pub transport: &'static str,
    pub attempt: u32,
    pub phase: AttemptPhase,
    pub stage: Option<AttemptStage>,
    pub time_ms: u128,
    pub elapsed_ms: Option<u128>,
    pub status: Option<u16>,
    pub failure: Option<&'static str>,
}
pub type Observer = Arc<dyn Fn(Attempt) -> Result<(), ()> + Send + Sync>;
pub(crate) struct Tracker {
    base: Attempt,
    observer: Option<Observer>,
    started: Instant,
    settled: bool,
}
impl Tracker {
    pub(crate) fn new(
        prepared: &Prepared,
        transport: &'static str,
        observer: Option<Observer>,
    ) -> Self {
        let base = Attempt {
            request_id: prepared.id.clone(),
            route_id: prepared.route.clone(),
            transport,
            attempt: 1,
            phase: AttemptPhase::Started,
            stage: if transport == "http-json" {
                Some(AttemptStage::Request)
            } else {
                None
            },
            time_ms: now_ms(),
            elapsed_ms: None,
            status: None,
            failure: None,
        };
        let tracker = Self {
            base,
            observer,
            started: Instant::now(),
            settled: false,
        };
        tracker.observe(tracker.base.clone());
        tracker
    }
    fn observe(&self, attempt: Attempt) {
        if let Some(observer) = &self.observer {
            let _ = observer(attempt);
        }
    }
    pub(crate) fn settle(&mut self, success: bool, stream: bool, status: Option<u16>) {
        if self.settled {
            return;
        }
        self.settled = true;
        let mut attempt = self.base.clone();
        attempt.phase = if success {
            AttemptPhase::Succeeded
        } else {
            AttemptPhase::Failed
        };
        attempt.time_ms = now_ms();
        if attempt.transport == "http-json" {
            attempt.stage = Some(if stream {
                AttemptStage::Stream
            } else {
                AttemptStage::Request
            });
            attempt.elapsed_ms = Some(self.started.elapsed().as_millis());
        }
        attempt.status = status;
        attempt.failure = if success {
            None
        } else if stream {
            Some("response-read")
        } else {
            Some("request")
        };
        self.observe(attempt);
    }
}
fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
impl Drop for Tracker {
    fn drop(&mut self) {
        self.settle(false, false, None);
    }
}
pub struct Executor {
    client: Client,
    pub observer: Option<Observer>,
}
impl Executor {
    pub fn new(client: Client) -> Self {
        Self {
            client,
            observer: None,
        }
    }
    pub fn http_client() -> Result<Client, Error> {
        Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .map_err(|_| Error::transport("Failed to construct HTTP client", "client"))
    }
    pub async fn execute(&self, prepared: &Prepared) -> Result<reqwest::Response, Error> {
        self.execute_http_inner(
            &prepared.url,
            &prepared.headers,
            reqwest::Method::POST,
            prepared.encoded_body.as_bytes().to_vec(),
            Some(prepared),
        )
        .await
    }
    pub(crate) async fn execute_http(
        &self,
        url: &Url,
        request_headers: &HeaderMap,
        method: reqwest::Method,
        body: Vec<u8>,
    ) -> Result<reqwest::Response, Error> {
        self.execute_http_inner(url, request_headers, method, body, None)
            .await
    }
    async fn execute_http_inner(
        &self,
        url: &Url,
        request_headers: &HeaderMap,
        method: reqwest::Method,
        body: Vec<u8>,
        prepared: Option<&Prepared>,
    ) -> Result<reqwest::Response, Error> {
        let mut headers = request_headers.clone();
        headers.insert("connection", HeaderValue::from_static("close"));
        let request = self
            .client
            .request(method.clone(), url.clone())
            .headers(headers)
            .body(body)
            .build()
            .map_err(|_| Error::invalid("Invalid provider HTTP request"))?;
        let response = self.client.execute(request).await.map_err(|error| {
            let mut error = transport_error(&error, url, request_headers);
            if let Some(http) = &mut error.http {
                http.method = method.to_string();
            }
            error
        })?;
        if let Some(prepared) = prepared {
            prepared
                .request
                .model
                .route
                .protocol
                .response_headers(&prepared.request, response.headers());
        }
        if response.status().as_u16() < 400 {
            return Ok(response);
        }
        let status = response.status().as_u16();
        let response_secrets: Vec<_> = response
            .headers()
            .iter()
            .filter(|(name, value)| sensitive(name.as_str()) || value.is_sensitive())
            .filter_map(|(_, value)| value.to_str().ok().map(String::from))
            .filter(|value| value.len() >= 4)
            .collect();
        let headers = headers_map(response.headers())
            .into_iter()
            .map(|(key, value)| (key, redact_http(&value, url, request_headers)))
            .collect();
        let raw = response.text().await.ok();
        let raw = raw
            .map(|body| redact_with(&redact_http(&body, url, request_headers), &response_secrets));
        let retry = retry_after_ms(&headers, now_ms() as i64);
        let rate_limit = rate_limit_details(&headers, retry);
        let body_truncated = raw
            .as_ref()
            .is_some_and(|body| body.encode_utf16().count() > 16384);
        let body = raw.map(|body| {
            body.chars()
                .scan(0, |count, ch| {
                    *count += ch.len_utf16();
                    (*count <= 16384).then_some(ch)
                })
                .collect::<String>()
        });
        let message = if body
            .as_ref()
            .is_some_and(|body| body.encode_utf16().count() <= 500)
        {
            format!(
                "Provider request failed with HTTP {status}: {}",
                body.as_deref().unwrap_or("")
            )
        } else {
            format!("Provider request failed with HTTP {status}")
        };
        let request_id = [
            "x-request-id",
            "request-id",
            "x-amzn-requestid",
            "x-amz-request-id",
            "x-goog-request-id",
            "cf-ray",
        ]
        .into_iter()
        .find_map(|key| headers.get(key).cloned());
        Err(classify(Failure {
            message,
            status: Some(status),
            retry_after_ms: retry,
            rate_limit: rate_limit.clone(),
            http: Some(HttpContext {
                method: method.to_string(),
                url: redact_url(url.as_str()),
                request_headers: redact_headers(request_headers),
                status: Some(status),
                response_headers: headers
                    .into_iter()
                    .map(|(key, value)| {
                        let value = if sensitive(&key) {
                            "<redacted>".into()
                        } else {
                            redact_http(&value, url, request_headers)
                        };
                        (key, value)
                    })
                    .collect(),
                body,
                body_truncated,
                request_id: request_id.map(|id| redact_http(&id, url, request_headers)),
                rate_limit,
            }),
            ..Failure::default()
        }))
    }
    pub async fn stream(&self, request: &Request) -> Result<EventStream, Error> {
        let prepared = request.model.route.prepare(request)?;
        if let Some(native) = prepared.request.model.route.protocol.native() {
            let native = native
                .stream(self, &prepared, self.observer.clone())
                .await?;
            return Ok(EventStream {
                native: Some(Box::new(native)),
                transport: StreamTransport::Done,
                parser: prepared
                    .request
                    .model
                    .route
                    .protocol
                    .parser(&prepared.request),
                frames: VecDeque::new(),
                events: VecDeque::new(),
                terminal: false,
                ended: false,
                textual: TextualTools::default(),
                redaction: prepared,
            });
        }
        let parser = prepared
            .request
            .model
            .route
            .protocol
            .parser(&prepared.request);
        match &prepared.request.model.route.transport {
            Transport::Native => Err(Error::invalid(
                "Native transport requires a native protocol handler",
            )),
            Transport::RunPodJobs => {
                let frame = crate::runpod::frames(self, &prepared)
                    .await
                    .map_err(|mut error| {
                        error.message = redact(&error.message, &prepared);
                        error
                    })?;
                Ok(EventStream {
                    native: None,
                    transport: StreamTransport::Buffered,
                    parser,
                    frames: VecDeque::from([frame]),
                    events: VecDeque::new(),
                    terminal: false,
                    ended: false,
                    textual: TextualTools::default(),
                    redaction: prepared,
                })
            }
            Transport::Process(attempt) => {
                let input = ProcessInput {
                    model: prepared.request.model.id.clone(),
                    options: prepared.request.model.defaults.provider_options.clone(),
                    body: prepared.body.clone(),
                };
                let frames = attempt.attempt(input).await.map_err(|mut error| {
                    error.message = redact(&error.message, &prepared);
                    error
                })?;
                Ok(EventStream {
                    native: None,
                    transport: StreamTransport::Buffered,
                    parser,
                    frames: VecDeque::from(frames),
                    events: VecDeque::new(),
                    terminal: false,
                    ended: false,
                    textual: TextualTools::default(),
                    redaction: prepared,
                })
            }
            Transport::Http(_) | Transport::Muse(_) => {
                let mut tracker = Tracker::new(&prepared, "http-json", self.observer.clone());
                let result = match &prepared.request.model.route.transport {
                    Transport::Muse(connection) => connection.execute(self, &prepared).await,
                    _ => self.execute(&prepared).await,
                };
                let response = match result {
                    Ok(response) => response,
                    Err(error) => {
                        tracker.settle(false, false, None);
                        return Err(error);
                    }
                };
                let status = response.status().as_u16();
                let framing = match &prepared.request.model.route.transport {
                    Transport::Http(Framing::AwsEventStream) => {
                        Decoder::Aws(AwsEventStream::default())
                    }
                    _ => Decoder::Sse(Sse::default()),
                };
                Ok(EventStream {
                    native: None,
                    transport: StreamTransport::Http {
                        response,
                        decoder: framing,
                        tracker,
                        status,
                    },
                    parser,
                    frames: VecDeque::new(),
                    events: VecDeque::new(),
                    terminal: false,
                    ended: false,
                    textual: TextualTools::default(),
                    redaction: prepared,
                })
            }
            Transport::WebSocket(transport) => {
                let connection = transport.open(&prepared, self.observer.clone()).await?;
                Ok(EventStream {
                    native: None,
                    transport: StreamTransport::WebSocket(connection),
                    parser,
                    frames: VecDeque::new(),
                    events: VecDeque::new(),
                    terminal: false,
                    ended: false,
                    textual: TextualTools::default(),
                    redaction: prepared,
                })
            }
        }
    }
    pub async fn generate(&self, request: &Request) -> Result<Response, Error> {
        let mut stream = self.stream(request).await?;
        let mut events = Vec::new();
        while let Some(event) = stream.next().await? {
            events.push(event);
        }
        Response::from_events(events)
    }
    pub async fn generate_object(
        &self,
        request: &Request,
        schema: JsonValue,
    ) -> Result<(JsonValue, Response), Error> {
        let mut request = request.clone();
        request.tools = vec![crate::llm::ToolDefinition {
            name: "generate_object".into(),
            description: "Return the structured result by calling this tool.".into(),
            input_schema: schema,
            output_schema: None,
            cache: None,
            metadata: None,
            native: None,
        }];
        request.tool_choice = Some(crate::llm::ToolChoice::Tool("generate_object".into()));
        let response = self.generate(&request).await?;
        let value = response
            .events
            .iter()
            .find_map(|event| match event {
                Event::ToolCall(call) if call.name.as_str() == Some("generate_object") => {
                    Some(call.input.clone())
                }
                _ => None,
            })
            .ok_or_else(|| {
                Error::output(
                    "generateObject: model did not call the forced `generate_object` tool",
                )
            })?;
        Ok((value, response))
    }
}
enum Decoder {
    Sse(Sse),
    Aws(AwsEventStream),
}
enum StreamTransport {
    Done,
    Buffered,
    Http {
        response: reqwest::Response,
        decoder: Decoder,
        tracker: Tracker,
        status: u16,
    },
    WebSocket(websocket::Connection),
}
pub struct EventStream {
    native: Option<Box<crate::cursor::provider::Stream>>,
    transport: StreamTransport,
    parser: Box<dyn StreamParser>,
    frames: VecDeque<JsonValue>,
    events: VecDeque<Event>,
    terminal: bool,
    ended: bool,
    textual: TextualTools,
    redaction: Prepared,
}
impl EventStream {
    pub async fn next(&mut self) -> Result<Option<Event>, Error> {
        let result = self.next_inner().await;
        if result.is_err() {
            self.ended = true;
            self.events.clear();
            self.frames.clear();
            self.transport = StreamTransport::Done;
        }
        result.map_err(|mut error| {
            error.message = redact(&error.message, &self.redaction);
            error.code = error.code.map(|code| redact(&code, &self.redaction));
            error
        })
    }
    async fn next_inner(&mut self) -> Result<Option<Event>, Error> {
        if let Some(native) = &mut self.native {
            let result = native.next().await;
            if result.is_err()
                || result
                    .as_ref()
                    .is_ok_and(|event| event.as_ref().is_none_or(Event::terminal))
            {
                self.native = None;
                self.ended = true;
            }
            return result;
        }
        loop {
            if let Some(event) = self.events.pop_front() {
                if self.terminal {
                    return Err(Error::output(
                        "Provider emitted an event after the terminal event",
                    ));
                }
                if event.terminal() {
                    self.terminal = true;
                }
                return Ok(Some(event));
            }
            if self.ended {
                self.transport = StreamTransport::Done;
                return Ok(None);
            }
            if let Some(frame) = self.frames.pop_front() {
                let terminal = self.redaction.request.model.route.protocol.terminal(&frame);
                let events = self.parser.push(&frame)?;
                for event in events {
                    self.events.extend(self.textual.event(event)?);
                }
                if terminal {
                    self.frames.clear();
                    let events = self.parser.finish()?;
                    for event in events {
                        self.events.extend(self.textual.event(event)?);
                    }
                    self.ended = true;
                }
                continue;
            }
            match &mut self.transport {
                StreamTransport::Done => return Ok(None),
                StreamTransport::Buffered => {}
                StreamTransport::Http {
                    response,
                    decoder,
                    tracker,
                    status,
                } => {
                    let bytes = match response.chunk().await {
                        Ok(bytes) => bytes,
                        Err(error) => {
                            tracker.settle(false, true, Some(*status));
                            return Err(read_error(&error));
                        }
                    };
                    if let Some(bytes) = bytes {
                        match decoder {
                            Decoder::Sse(parser) => {
                                for frame in parser.push(&bytes) {
                                    if let Some(frame) = decode_frame(&frame, &self.redaction)? {
                                        self.frames.push_back(frame);
                                    }
                                }
                            }
                            Decoder::Aws(parser) => match parser.push(&bytes) {
                                Ok(frames) => self.frames.extend(frames),
                                Err(error) => {
                                    tracker.settle(false, true, Some(*status));
                                    return Err(error);
                                }
                            },
                        }
                        continue;
                    }
                    tracker.settle(true, true, Some(*status));
                    if matches!(
                        self.redaction.request.model.route.transport,
                        Transport::Muse(_)
                    ) {
                        if let Decoder::Sse(parser) = decoder {
                            for frame in parser.finish_muse() {
                                if let Some(frame) = decode_frame(&frame, &self.redaction)? {
                                    self.frames.push_back(frame);
                                }
                            }
                        }
                        self.transport = StreamTransport::Buffered;
                        continue;
                    }
                }
                StreamTransport::WebSocket(connection) => {
                    if let Some(frame) = connection.next().await? {
                        self.frames.push_back(
                            parse_json(&frame)
                                .map_err(|_| Error::output("Invalid provider stream event"))?,
                        );
                        continue;
                    }
                }
            }
            let events = self.parser.finish()?;
            for event in events {
                self.events.extend(self.textual.event(event)?);
            }
            self.ended = true;
            if !self.terminal && self.events.is_empty() {
                return Err(Error::missing_terminal());
            }
        }
    }
}
fn decode_frame(frame: &str, prepared: &Prepared) -> Result<Option<JsonValue>, Error> {
    let quota = frame
        .trim_start()
        .strip_prefix('{')
        .and_then(|v| v.trim_start().strip_prefix("\"type\""))
        .and_then(|v| v.trim_start().strip_prefix(':'))
        .and_then(|v| {
            v.trim_start()
                .strip_prefix("\"response.subscription_usage\"")
        })
        .is_some_and(|v| v.trim_start().starts_with([',', '}']));
    match parse_json(frame) {
        Ok(frame) => Ok(Some(frame)),
        Err(_) if matches!(prepared.request.model.route.transport, Transport::Muse(_)) && quota => {
            tracing::warn!("invalid Muse subscription usage event");
            Ok(None)
        }
        Err(_) => Err(Error::output("Invalid provider stream event")),
    }
}

impl Drop for StreamTransport {
    fn drop(&mut self) {
        if let StreamTransport::Http {
            tracker, status, ..
        } = self
        {
            tracker.settle(true, true, Some(*status));
        }
    }
}
fn transport_error(error: &reqwest::Error, url: &Url, headers: &HeaderMap) -> Error {
    let mut error = Error::transport(
        if error.is_timeout() {
            "HTTP transport timed out"
        } else {
            "HTTP transport failed"
        },
        if error.is_timeout() {
            "Timeout"
        } else {
            "TransportError"
        },
    );
    error.http = Some(Box::new(HttpContext {
        method: "POST".into(),
        url: redact_url(url.as_str()),
        request_headers: redact_headers(headers),
        status: None,
        response_headers: BTreeMap::new(),
        body: None,
        body_truncated: false,
        request_id: None,
        rate_limit: None,
    }));
    error
}
fn read_error(error: &reqwest::Error) -> Error {
    Error::transport(
        if error.is_timeout() {
            "The response stream timed out"
        } else {
            "The HTTP response stream failed"
        },
        "read",
    )
}
fn headers_map(headers: &HeaderMap) -> BTreeMap<String, String> {
    headers
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().into(), value.into()))
        })
        .collect()
}
pub(crate) fn sensitive(name: &str) -> bool {
    let name = name.to_lowercase();
    [
        "authorization",
        "apikey",
        "api-key",
        "api_key",
        "token",
        "secret",
        "credential",
        "signature",
        "x-codex-turn-state",
        "chatgpt-account-id",
    ]
    .iter()
    .any(|pattern| name.contains(pattern))
}
pub fn redact_url(value: &str) -> String {
    let Ok(mut url) = Url::parse(value) else {
        return "<redacted>".into();
    };
    let pairs: Vec<_> = url
        .query_pairs()
        .map(|(key, value)| {
            let value = if sensitive(&key) || matches!(key.to_lowercase().as_str(), "key" | "sig") {
                "<redacted>".into()
            } else {
                value.into_owned()
            };
            (key.into_owned(), value)
        })
        .collect();
    if url.query().is_some() {
        url.query_pairs_mut().clear().extend_pairs(pairs);
    }
    url.into()
}
fn redact_headers(headers: &HeaderMap) -> BTreeMap<String, String> {
    headers
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().into(),
                if sensitive(name.as_str()) || value.is_sensitive() {
                    "<redacted>".into()
                } else {
                    value.to_str().unwrap_or("<redacted>").into()
                },
            )
        })
        .collect()
}
pub(crate) fn redact(value: &str, prepared: &Prepared) -> String {
    redact_with(value, &secrets(prepared))
}
pub(crate) fn secrets(prepared: &Prepared) -> Vec<String> {
    http_secrets(&prepared.url, &prepared.headers)
}
pub(crate) fn redact_http(value: &str, url: &Url, headers: &HeaderMap) -> String {
    redact_with(value, &http_secrets(url, headers))
}
fn http_secrets(url: &Url, headers: &HeaderMap) -> Vec<String> {
    let mut secrets: Vec<_> = headers
        .iter()
        .filter(|(name, value)| sensitive(name.as_str()) || value.is_sensitive())
        .filter_map(|(_, value)| value.to_str().ok())
        .flat_map(|value| {
            [
                Some(value.to_owned()),
                value.strip_prefix("Bearer ").map(String::from),
            ]
        })
        .flatten()
        .chain(
            url.query_pairs()
                .filter(|(name, _)| {
                    sensitive(name) || matches!(name.to_lowercase().as_str(), "key" | "sig")
                })
                .map(|(_, value)| value.into_owned()),
        )
        .filter(|value| value.len() >= 4)
        .collect();
    secrets.sort_by_key(|value| std::cmp::Reverse(value.len()));
    secrets.dedup();
    secrets
}
pub(crate) fn redact_with(value: &str, secrets: &[String]) -> String {
    fn structure(value: &JsonValue) -> JsonValue {
        match value {
            JsonValue::Object(fields) => json::object(fields.iter().map(|(key, value)| {
                (
                    key.clone(),
                    if sensitive(key.as_str().unwrap_or(""))
                        || key
                            .as_str()
                            .is_some_and(|key| key.eq_ignore_ascii_case("key"))
                    {
                        json::s("<redacted>")
                    } else {
                        structure(value)
                    },
                )
            })),
            JsonValue::Array(values) => JsonValue::Array(values.iter().map(structure).collect()),
            _ => value.clone(),
        }
    }
    let mut value = match parse_json(value) {
        Ok(json) => stringify_json(&structure(&json)),
        Err(_) => value.into(),
    };
    for secret in secrets {
        value = value.replace(secret, "<redacted>");
        let encoded: String = secret
            .bytes()
            .map(|byte| {
                if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                    (byte as char).to_string()
                } else {
                    format!("%{byte:02X}")
                }
            })
            .collect();
        value = value.replace(&encoded, "<redacted>");
    }
    let mut result = String::new();
    for word in value.split_inclusive(char::is_whitespace) {
        if let Some((name, _)) = word.trim_end().split_once('=')
            && (sensitive(name) || name.eq_ignore_ascii_case("key"))
        {
            result.push_str(name);
            result.push_str("=<redacted>");
            result.extend(
                word.chars()
                    .rev()
                    .take_while(|ch| ch.is_whitespace())
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev(),
            );
            continue;
        }
        result.push_str(word);
    }
    result
}
pub fn sum_tokens(values: &[Option<f64>]) -> Option<f64> {
    values
        .iter()
        .any(Option::is_some)
        .then(|| values.iter().flatten().sum())
}
pub fn normalize_input_usage(
    total: Option<f64>,
    non_cached: Option<f64>,
    read: Option<f64>,
    write: Option<f64>,
    semantics: InputUsageSemantics,
) -> crate::llm::Usage {
    let count = |value: Option<f64>| {
        value
            .filter(|value| value.is_finite())
            .map(|value| value.max(0.0))
    };
    let total = count(total);
    let non_cached = count(non_cached);
    let read = count(read);
    let write = count(write);
    if semantics == InputUsageSemantics::Exclusive {
        return crate::llm::Usage {
            input_tokens: sum_tokens(&[non_cached, read, write]),
            non_cached_input_tokens: non_cached,
            cache_read_input_tokens: read,
            cache_write_input_tokens: write,
            ..Default::default()
        };
    }
    let input = total.or_else(|| sum_tokens(&[non_cached, read, write]));
    let read = read.map(|read| input.map(|total| read.min(total)).unwrap_or(read));
    let remaining = input.map(|input| (input - read.unwrap_or(0.0)).max(0.0));
    let write = write.map(|write| {
        remaining
            .map(|remaining| write.min(remaining))
            .unwrap_or(write)
    });
    let derived = remaining.map(|remaining| (remaining - write.unwrap_or(0.0)).max(0.0));
    let reported = sum_tokens(&[non_cached, read, write]);
    crate::llm::Usage {
        input_tokens: input,
        non_cached_input_tokens: if semantics == InputUsageSemantics::AiSdk
            && input.is_some()
            && reported.is_some()
            && input != reported
        {
            derived
        } else {
            non_cached.or(derived)
        },
        cache_read_input_tokens: read,
        cache_write_input_tokens: write,
        ..Default::default()
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputUsageSemantics {
    Inclusive,
    Exclusive,
    AiSdk,
}

#[derive(Default)]
struct TextualTools {
    buffer: String,
    call: Option<String>,
    next_id: u32,
}
const CALLS_BEGIN: &str = "<｜ tool▁calls▁begin｜ >";
const CALLS_END: &str = "<｜ tool▁calls▁end｜ >";
const CALL_BEGIN: &str = "<｜ tool▁call▁begin｜ >";
const CALL_END: &str = "<｜ tool▁call▁end｜ >";
const SEPARATOR: &str = "<｜ tool▁sep｜ >";
impl TextualTools {
    fn event(&mut self, event: Event) -> Result<Vec<Event>, Error> {
        if let Event::TextDelta(delta) = event {
            let Some(text) = delta.text.as_str() else {
                return Ok(vec![Event::TextDelta(delta)]);
            };
            self.buffer.push_str(text);
            let mut events = Vec::new();
            loop {
                if let Some(call) = &mut self.call {
                    if let Some(end) = self.buffer.find(CALLS_END) {
                        call.push_str(&self.buffer[..end]);
                        let raw = self.call.take().unwrap_or_default();
                        events.extend(self.parse_calls(&raw)?);
                        self.buffer = self.buffer[end + CALLS_END.len()..].into();
                        continue;
                    }
                    call.push_str(&self.buffer);
                    self.buffer.clear();
                    break;
                }
                if let Some(start) = self.buffer.find(CALLS_BEGIN) {
                    if start > 0 {
                        events.push(Event::TextDelta(crate::llm::DeltaEvent {
                            text: self.buffer[..start].into(),
                            ..delta.clone()
                        }));
                    }
                    self.buffer = self.buffer[start + CALLS_BEGIN.len()..].into();
                    self.call = Some(String::new());
                    continue;
                }
                let prefix = (1..CALLS_BEGIN.len())
                    .rev()
                    .find(|size| {
                        self.buffer.len() >= *size
                            && self.buffer.is_char_boundary(self.buffer.len() - size)
                            && CALLS_BEGIN.starts_with(&self.buffer[self.buffer.len() - size..])
                    })
                    .unwrap_or(0);
                let visible = self.buffer.len() - prefix;
                if visible > 0 {
                    events.push(Event::TextDelta(crate::llm::DeltaEvent {
                        text: self.buffer[..visible].into(),
                        ..delta.clone()
                    }));
                }
                self.buffer = self.buffer[visible..].into();
                break;
            }
            return Ok(events);
        }
        if matches!(event, Event::TextEnd(_) | Event::Finish(_)) && self.call.is_some() {
            return Err(Error::output(
                "Provider ended a textual tool call without closing it",
            ));
        }
        if let Event::TextEnd(block) = &event
            && !self.buffer.is_empty()
        {
            let text = std::mem::take(&mut self.buffer);
            return Ok(vec![
                Event::TextDelta(crate::llm::DeltaEvent {
                    id: block.id.clone(),
                    text: text.into(),
                    provider_metadata: block.provider_metadata.clone(),
                }),
                event,
            ]);
        }
        Ok(vec![event])
    }
    fn parse_calls(&mut self, raw: &str) -> Result<Vec<Event>, Error> {
        let invalid = || Error::output("Provider emitted a malformed textual tool call");
        let mut remaining = raw;
        let mut events = Vec::new();
        while !remaining.trim().is_empty() {
            remaining = remaining.trim_start();
            let raw = remaining.strip_prefix(CALL_BEGIN).ok_or_else(invalid)?;
            let end = raw.find(CALL_END).ok_or_else(invalid)?;
            let call = &raw[..end];
            let (kind, body) = call.split_once(SEPARATOR).ok_or_else(invalid)?;
            if kind.trim() != "function" {
                return Err(invalid());
            }
            let (name, input) = body.trim().split_once('\n').ok_or_else(invalid)?;
            let name = name.trim();
            if name.is_empty() {
                return Err(invalid());
            }
            let input = input.trim();
            let input = input
                .strip_suffix("```json")
                .or_else(|| input.strip_suffix("```"))
                .unwrap_or(input)
                .trim();
            let input = parse_json(if input.is_empty() { "{}" } else { input }).map_err(|_| {
                Error::output(format!(
                    "Provider emitted invalid JSON for textual tool call {name}"
                ))
            })?;
            events.push(Event::ToolCall(crate::llm::ToolCall {
                id: format!("textual-tool-{}", self.next_id).into(),
                name: name.into(),
                input,
                provider_executed: None,
                provider_metadata: None,
            }));
            self.next_id += 1;
            remaining = &raw[end + CALL_END.len()..];
        }
        if events.is_empty() {
            return Err(invalid());
        }
        Ok(events)
    }
}
