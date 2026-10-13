use crate::{
    Error,
    auth::Auth,
    framing::Framing,
    json::{self, get, s},
    llm::{
        Defaults, Event, Finish, FinishReason, Media, MediaData, Model, Part, Request, Role,
        ToolChoice, ToolInputEvent, ToolResultValue, Usage,
    },
    media,
    openai_shared::{Lifecycle, PendingTool, Tools, pick, string, wrapped_system},
    provider_error::{Failure, classify},
    route::{
        Endpoint, InputUsageSemantics, Protocol, Route, StreamParser, normalize_input_usage,
        sum_tokens,
    },
    tool_schema,
};
use std::{collections::BTreeMap, sync::Arc};
use ycoding_schema::{JsonValue, LosslessString, provider};

pub struct BedrockConverse;
impl Protocol for BedrockConverse {
    fn id(&self) -> &'static str {
        "bedrock-converse"
    }
    fn lower(&self, request: &Request) -> Result<JsonValue, Error> {
        lower(request)
    }
    fn parser(&self, _request: &Request) -> Box<dyn StreamParser> {
        Box::new(Parser::default())
    }
}
#[derive(Default)]
pub struct Parser {
    lifecycle: Lifecycle,
    tools: Tools,
    signatures: BTreeMap<LosslessString, LosslessString>,
    pending: Option<FinishReason>,
    usage: Option<Usage>,
    has_tools: bool,
    unreported_reasoning: bool,
    terminal: bool,
}
impl StreamParser for Parser {
    fn push(&mut self, event: &JsonValue) -> Result<Vec<Event>, Error> {
        if self.terminal {
            return Err(Error::output(
                "Provider emitted an event after the terminal event",
            ));
        }
        validate_event(event)?;
        let mut events = Vec::new();
        if let Some(block) = get(event, "contentBlockStart")
            && let Some(tool) = get(block, "start").and_then(|start| get(start, "toolUse"))
        {
            let id = required_string(tool, "toolUseId")?.clone();
            let name = required_string(tool, "name")?.clone();
            self.lifecycle.start(&mut events);
            self.tools.start(
                index(block)?,
                PendingTool {
                    id: id.clone(),
                    name: name.clone(),
                    input: "".into(),
                    metadata: None,
                },
            );
            events.push(Event::ToolInputStart(ToolInputEvent {
                id,
                name,
                provider_executed: None,
                provider_metadata: None,
            }));
            return Ok(events);
        }
        if let Some(block) = get(event, "contentBlockDelta")
            && let Some(delta) = get(block, "delta")
        {
            let key = index(block)?;
            if let Some(text) = string(delta, "text").filter(|text| !text.is_empty()) {
                self.lifecycle
                    .text_delta(&mut events, prefixed("text-", &key), text.clone(), None);
                return Ok(events);
            }
            if let Some(reasoning) = get(delta, "reasoningContent") {
                if let Some(text) = string(reasoning, "text").filter(|text| !text.is_empty()) {
                    self.lifecycle.reasoning_delta(
                        &mut events,
                        prefixed("reasoning-", &key),
                        text.clone(),
                        None,
                    );
                }
                if let Some(signature) =
                    string(reasoning, "signature").filter(|text| !text.is_empty())
                {
                    self.signatures.insert(key, signature.clone());
                }
                self.unreported_reasoning = true;
                return Ok(events);
            }
            if let Some(tool) = get(delta, "toolUse") {
                if self.tools.get(&key).is_none() {
                    return Err(Error::output(
                        "Bedrock Converse tool delta is missing its tool call",
                    ));
                }
                let deltas = self.tools.append(&key, required_string(tool, "input")?)?;
                if !deltas.is_empty() {
                    self.lifecycle.start(&mut events);
                }
                events.extend(deltas);
                return Ok(events);
            }
        }
        if let Some(block) = get(event, "contentBlockStop") {
            let key = index(block)?;
            let tool_events = self.tools.finish(&key, None);
            if !tool_events.is_empty() {
                self.lifecycle.start(&mut events);
                self.has_tools |= tool_events.iter().any(|event| {
                    matches!(event, Event::ToolCall(_) | Event::ToolInputError { .. })
                });
                events.extend(tool_events);
                self.signatures.remove(&key);
                return Ok(events);
            }
            self.lifecycle
                .end(&mut events, &prefixed("text-", &key), false, None);
            let signature = self
                .signatures
                .remove(&key)
                .map(|signature| metadata(json::object([("signature", s(signature))])));
            self.lifecycle
                .end(&mut events, &prefixed("reasoning-", &key), true, signature);
            return Ok(events);
        }
        if let Some(stop) = get(event, "messageStop") {
            self.pending = Some(map_finish(
                required_string(stop, "stopReason")?.as_str().unwrap_or(""),
            ));
            return Ok(events);
        }
        if let Some(raw) = get(event, "metadata") {
            self.pending.get_or_insert(FinishReason::Stop);
            self.usage = get(raw, "usage").map(|raw| {
                let normalized = normalize_input_usage(
                    None,
                    get(raw, "inputTokens").and_then(json::number),
                    get(raw, "cacheReadInputTokens").and_then(json::number),
                    get(raw, "cacheWriteInputTokens").and_then(json::number),
                    InputUsageSemantics::Exclusive,
                );
                let output = get(raw, "outputTokens").and_then(json::number);
                Usage {
                    output_tokens: output,
                    total_tokens: sum_tokens(&[normalized.input_tokens, output]),
                    provider_metadata: Some(metadata(pick(
                        raw,
                        &[
                            "inputTokens",
                            "outputTokens",
                            "totalTokens",
                            "cacheReadInputTokens",
                            "cacheWriteInputTokens",
                        ],
                    ))),
                    ..normalized
                }
            });
            return Ok(events);
        }
        for code in [
            "internalServerException",
            "modelStreamErrorException",
            "serviceUnavailableException",
            "throttlingException",
            "validationException",
        ] {
            if let Some(error) = get(event, code) {
                return Err(classify(Failure {
                    code: Some(code.into()),
                    ..Failure::message(
                        required_string(error, "message")?
                            .as_str()
                            .unwrap_or("Bedrock Converse stream error"),
                    )
                }));
            }
        }
        Ok(events)
    }
    fn finish(&mut self) -> Result<Vec<Event>, Error> {
        if self.terminal {
            return Ok(Vec::new());
        }
        let reason = self.pending.ok_or_else(Error::missing_terminal)?;
        self.terminal = true;
        if let Some(usage) = &mut self.usage {
            usage.output_may_include_unreported_reasoning =
                self.unreported_reasoning.then_some(true);
        }
        let mut events = Vec::new();
        self.lifecycle.finish(
            &mut events,
            Finish {
                reason: if reason == FinishReason::Stop && self.has_tools {
                    FinishReason::ToolCalls
                } else {
                    reason
                },
                usage: self.usage.clone(),
                provider_metadata: None,
            },
        );
        Ok(events)
    }
}

impl Route {
    pub fn bedrock(base_url: impl Into<String>, auth: Auth) -> Self {
        Self {
            id: "bedrock-converse".into(),
            provider: provider::Id("bedrock".into()),
            provider_metadata_key: Some("bedrock".into()),
            protocol: Arc::new(BedrockConverse),
            endpoint: Endpoint {
                dynamic_path: Some(Arc::new(|_, body| {
                    format!(
                        "/model/{}/converse-stream",
                        crate::bedrock_auth::uri_component(
                            get(body, "modelId").and_then(json::text).unwrap_or("")
                        )
                    )
                })),
                ..Endpoint::new(base_url, "")
            },
            auth,
            transport: crate::route::Transport::Http(Framing::AwsEventStream),
            headers: BTreeMap::new(),
            defaults: Defaults::default(),
        }
    }
}

pub struct Config {
    pub endpoint: String,
    pub auth: Auth,
    pub defaults: Defaults,
}
pub fn amazon_bedrock(id: impl Into<LosslessString>, config: Config) -> Model {
    let mut route = Route::bedrock(config.endpoint, config.auth);
    route.provider = provider::Id("amazon-bedrock".into());
    route.defaults = config.defaults;
    route.model(id)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Api {
    Converse,
    Mantle,
}
pub struct HostedConfig {
    pub endpoint: Option<String>,
    pub base_url: Option<String>,
    pub region: Option<String>,
    pub bearer_token: Option<crate::auth::Credential>,
    pub auth: Auth,
    pub environment: BTreeMap<String, String>,
    pub defaults: Defaults,
}
pub fn model(id: impl Into<LosslessString>, config: HostedConfig, api: Api) -> Model {
    let id = id.into();
    let region = config
        .region
        .as_deref()
        .or_else(|| config.environment.get("AWS_REGION").map(String::as_str))
        .unwrap_or("us-east-1");
    let endpoint = config
        .endpoint
        .or(config.base_url)
        .unwrap_or_else(|| match api {
            Api::Converse => format!("https://bedrock-runtime.{region}.amazonaws.com"),
            Api::Mantle => format!("https://bedrock-mantle.{region}.api.aws/v1"),
        });
    let token = config
        .environment
        .get("AWS_BEARER_TOKEN_BEDROCK")
        .map(|value| crate::auth::Credential::value(value.clone()))
        .or(config.bearer_token);
    let auth = token.map(crate::auth::Auth::bearer).unwrap_or(config.auth);
    if api == Api::Converse {
        return amazon_bedrock(
            regional_model_id(id.as_str().unwrap_or(""), region),
            Config {
                endpoint,
                auth,
                defaults: config.defaults,
            },
        );
    }
    let mut route = if matches!(
        id.as_str(),
        Some("openai.gpt-oss-safeguard-20b" | "openai.gpt-oss-safeguard-120b")
    ) {
        Route::openai_chat()
    } else {
        Route::openai_responses()
    };
    route.id = "bedrock-mantle".into();
    route.provider = provider::Id("amazon-bedrock".into());
    route.endpoint.base_url = endpoint;
    route.auth = auth;
    route.defaults = config.defaults;
    route.model(id)
}
pub fn regional_model_id(id: &str, region: &str) -> String {
    if ["global.", "us.", "eu.", "jp.", "apac.", "au."]
        .iter()
        .any(|prefix| id.starts_with(prefix))
    {
        return id.into();
    }
    let contains = |parts: &[&str]| parts.iter().any(|part| id.contains(part));
    if region.starts_with("us-") {
        return if !region.starts_with("us-gov")
            && contains(&[
                "nova-micro",
                "nova-lite",
                "nova-pro",
                "nova-premier",
                "nova-2",
                "claude",
                "deepseek",
            ]) {
            format!("us.{id}")
        } else {
            id.into()
        };
    }
    if region.starts_with("eu-") {
        return if [
            "eu-west-1",
            "eu-west-2",
            "eu-west-3",
            "eu-north-1",
            "eu-central-1",
            "eu-south-1",
            "eu-south-2",
        ]
        .iter()
        .any(|value| region.contains(value))
            && contains(&["claude", "nova-lite", "nova-micro", "llama3", "pixtral"])
        {
            format!("eu.{id}")
        } else {
            id.into()
        };
    }
    if !region.starts_with("ap-") {
        return id.into();
    }
    if matches!(region, "ap-southeast-2" | "ap-southeast-4")
        && contains(&["anthropic.claude-sonnet-4-5", "anthropic.claude-haiku"])
    {
        return format!("au.{id}");
    }
    if !contains(&["claude", "nova-lite", "nova-micro", "nova-pro"]) {
        return id.into();
    }
    format!(
        "{}.{id}",
        if region == "ap-northeast-1" {
            "jp"
        } else {
            "apac"
        }
    )
}

fn metadata(value: JsonValue) -> JsonValue {
    json::object([("bedrock", value)])
}
fn prefixed(prefix: &str, key: &LosslessString) -> LosslessString {
    format!("{prefix}{}", key.as_str().unwrap_or("")).into()
}
fn required_string<'a>(value: &'a JsonValue, key: &str) -> Result<&'a LosslessString, Error> {
    string(value, key).ok_or_else(|| Error::output("Invalid Bedrock Converse stream event"))
}
fn index(block: &JsonValue) -> Result<LosslessString, Error> {
    get(block, "contentBlockIndex")
        .filter(|value| matches!(value, JsonValue::Number(_)))
        .map(json::js_string)
        .ok_or_else(|| Error::output("Invalid Bedrock Converse stream event"))
}
fn map_finish(reason: &str) -> FinishReason {
    match reason {
        "end_turn" | "stop_sequence" => FinishReason::Stop,
        "max_tokens" => FinishReason::Length,
        "tool_use" => FinishReason::ToolCalls,
        "content_filtered" | "guardrail_intervened" => FinishReason::ContentFilter,
        _ => FinishReason::Unknown,
    }
}

struct Breakpoints {
    remaining: usize,
    dropped: usize,
}
impl Breakpoints {
    fn append(&mut self, blocks: &mut Vec<JsonValue>, hint: Option<&crate::cache::Hint>) {
        let Some(hint) = hint else {
            return;
        };
        if self.remaining == 0 {
            self.dropped += 1;
            return;
        }
        self.remaining -= 1;
        let mut cache = json::object([("type", s("default"))]);
        if hint.one_hour() {
            json::set(&mut cache, "ttl", s("1h"));
        }
        blocks.push(json::object([("cachePoint", cache)]));
    }
    fn text(
        &mut self,
        blocks: &mut Vec<JsonValue>,
        text: LosslessString,
        hint: Option<&crate::cache::Hint>,
    ) {
        blocks.push(json::object([("text", s(text))]));
        self.append(blocks, hint);
    }
}
pub fn lower(request: &Request) -> Result<JsonValue, Error> {
    if let Some(ToolChoice::Tool(name)) = &request.tool_choice
        && name.is_empty()
    {
        return Err(Error::invalid(
            "Bedrock Converse tool choice requires a tool name",
        ));
    }
    if request.model.id.as_str().is_none() {
        return Err(Error::invalid(
            "Bedrock Converse model ID cannot be encoded in a URL",
        ));
    }
    let mut breakpoints = Breakpoints {
        remaining: 4,
        dropped: 0,
    };
    let tool_config = if !request.tools.is_empty() && request.tool_choice != Some(ToolChoice::None)
    {
        let mut tools = Vec::new();
        for tool in &request.tools {
            let schema =
                tool_schema::model_compatibility(&tool.input_schema, request.model.tool_schema);
            if !matches!(schema, JsonValue::Object(_)) {
                return Err(Error::invalid(
                    "Bedrock Converse tool inputSchema.json must be an object",
                ));
            }
            tools.push(json::object([(
                "toolSpec",
                json::object([
                    ("name", s(tool.name.clone())),
                    ("description", s(tool.description.clone())),
                    ("inputSchema", json::object([("json", schema)])),
                ]),
            )]));
            breakpoints.append(&mut tools, tool.cache.as_ref());
        }
        let mut config = json::object([("tools", JsonValue::Array(tools))]);
        if let Some(choice) = &request.tool_choice {
            let choice = match choice {
                ToolChoice::Auto => json::object([("auto", json::empty())]),
                ToolChoice::Required => json::object([("any", json::empty())]),
                ToolChoice::Tool(name) => {
                    json::object([("tool", json::object([("name", s(name.clone()))]))])
                }
                ToolChoice::None => unreachable!(),
            };
            json::set(&mut config, "toolChoice", choice);
        }
        Some(config)
    } else {
        None
    };
    let mut system = Vec::new();
    for part in &request.system {
        breakpoints.text(&mut system, part.text.clone(), part.cache.as_ref());
    }
    let mut messages = Vec::new();
    for message in &request.messages {
        let mut content = Vec::new();
        if message.role == Role::System {
            breakpoints.text(
                &mut content,
                wrapped_system(message, "Bedrock Converse")?,
                message.content.last().and_then(Part::cache),
            );
            append_user(&mut messages, content, false);
            continue;
        }
        for part in &message.content {
            match (message.role, part) {
                (Role::User | Role::Assistant, Part::Text(part)) => {
                    breakpoints.text(&mut content, part.text.clone(), part.cache.as_ref())
                }
                (Role::User, Part::Media(part)) => content.push(recover_media(part, false)),
                (Role::Assistant, Part::Reasoning(part)) => {
                    let signature = part.encrypted.as_ref().or_else(|| {
                        part.provider_metadata
                            .as_ref()
                            .and_then(|metadata| get(metadata, "bedrock"))
                            .and_then(|metadata| string(metadata, "signature"))
                    });
                    let mut reasoning = json::object([("text", s(part.text.clone()))]);
                    if let Some(signature) = signature {
                        json::set(&mut reasoning, "signature", s(signature.clone()));
                    }
                    content.push(json::object([(
                        "reasoningContent",
                        json::object([("reasoningText", reasoning)]),
                    )]));
                }
                (Role::Assistant, Part::ToolCall(part)) => content.push(json::object([(
                    "toolUse",
                    json::object([
                        ("toolUseId", s(part.id.clone())),
                        ("name", s(part.name.clone())),
                        ("input", part.input.clone()),
                    ]),
                )])),
                (Role::Tool, Part::ToolResult(part)) => {
                    let result = match &part.result {
                        ToolResultValue::Text(_) | ToolResultValue::Error(_) => {
                            vec![json::object([("text", s(part.result.to_text()))])]
                        }
                        ToolResultValue::Json(value) => {
                            vec![json::object([("json", value.clone())])]
                        }
                        ToolResultValue::Content(items) => items
                            .iter()
                            .map(|item| match item {
                                ycoding_schema::llm::ToolContent::Text(text) => {
                                    json::object([("text", s(text.text.clone()))])
                                }
                                ycoding_schema::llm::ToolContent::File(file) => recover_media(
                                    &Media {
                                        mime: file.mime.clone(),
                                        data: MediaData::Encoded(file.uri.clone()),
                                        filename: file.name.clone(),
                                    },
                                    true,
                                ),
                            })
                            .collect(),
                    };
                    content.push(json::object([(
                        "toolResult",
                        json::object([
                            ("toolUseId", s(part.id.clone())),
                            ("content", JsonValue::Array(result)),
                            (
                                "status",
                                s(if matches!(part.result, ToolResultValue::Error(_)) {
                                    "error"
                                } else {
                                    "success"
                                }),
                            ),
                        ]),
                    )]));
                    breakpoints.append(&mut content, part.cache.as_ref());
                }
                _ => {
                    return Err(Error::invalid(match message.role {
                        Role::User => {
                            "Bedrock Converse user messages only support text and media content for now"
                        }
                        Role::Assistant => {
                            "Bedrock Converse assistant messages only support text, reasoning, and tool-call content for now"
                        }
                        _ => {
                            "Bedrock Converse tool messages only support tool-result content for now"
                        }
                    }));
                }
            }
        }
        if message.role == Role::Assistant {
            messages.push(json::object([
                ("role", s("assistant")),
                ("content", JsonValue::Array(content)),
            ]));
            continue;
        }
        append_user(&mut messages, content, message.volatile);
    }
    if breakpoints.dropped > 0 {
        tracing::warn!(
            "Bedrock Converse: dropped {} cache breakpoint(s); the API allows at most 4 per request.",
            breakpoints.dropped
        );
    }
    let mut body = json::object([
        ("modelId", s(request.model.id.clone())),
        ("messages", JsonValue::Array(messages)),
    ]);
    if !request.system.is_empty() {
        json::set(&mut body, "system", JsonValue::Array(system));
    }
    let mut inference = json::empty();
    for (key, value) in [
        ("maxTokens", request.generation.max_tokens),
        ("temperature", request.generation.temperature),
        ("topP", request.generation.top_p),
    ] {
        if let Some(value) = value {
            json::set(&mut inference, key, JsonValue::Number(value));
        }
    }
    if let Some(stop) = request
        .generation
        .stop
        .as_ref()
        .filter(|stop| !stop.is_empty() || inference != json::empty())
    {
        json::set(
            &mut inference,
            "stopSequences",
            JsonValue::Array(stop.iter().cloned().map(s).collect()),
        );
    }
    if inference != json::empty() {
        json::set(&mut body, "inferenceConfig", inference);
    }
    if let Some(config) = tool_config {
        json::set(&mut body, "toolConfig", config);
    }
    if let Some(top_k) = request.generation.top_k {
        json::set(
            &mut body,
            "additionalModelRequestFields",
            json::object([("top_k", JsonValue::Number(top_k))]),
        );
    }
    Ok(body)
}

fn append_user(messages: &mut Vec<JsonValue>, content: Vec<JsonValue>, volatile: bool) {
    if !volatile
        && let Some(previous) = messages.last_mut()
        && get(previous, "role").and_then(json::text) == Some("user")
    {
        let mut blocks = get(previous, "content")
            .and_then(json::array)
            .unwrap_or(&[])
            .to_vec();
        blocks.extend(content);
        json::set(previous, "content", JsonValue::Array(blocks));
        return;
    }
    messages.push(json::object([
        ("role", s("user")),
        ("content", JsonValue::Array(content)),
    ]));
}

fn recover_media(part: &Media, tool_result: bool) -> JsonValue {
    match lower_media(part).and_then(|block| {
        if tool_result && get(&block, "image").is_none() {
            return Err(Error::invalid(
                "Bedrock Converse only supports image media in tool results",
            ));
        }
        Ok(block)
    }) {
        Ok(block) => block,
        Err(error) => json::object([("text", s(media::notice(part, &error)))]),
    }
}
fn lower_media(part: &Media) -> Result<JsonValue, Error> {
    let mime = part.mime.as_str().unwrap_or("").to_lowercase();
    let (kind, format) = match mime.as_str() {
        "image/png" => ("image", "png"),
        "image/jpeg" | "image/jpg" => ("image", "jpeg"),
        "image/gif" => ("image", "gif"),
        "image/webp" => ("image", "webp"),
        "application/pdf" => ("document", "pdf"),
        "text/csv" => ("document", "csv"),
        "application/msword" => ("document", "doc"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => {
            ("document", "docx")
        }
        "application/vnd.ms-excel" => ("document", "xls"),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => ("document", "xlsx"),
        "text/html" => ("document", "html"),
        "text/plain" => ("document", "txt"),
        "text/markdown" => ("document", "md"),
        _ => {
            return Err(Error::invalid(format!(
                "Bedrock Converse does not support {}media type {}",
                if mime.starts_with("image/") {
                    "image "
                } else {
                    ""
                },
                part.mime.as_str().unwrap_or("")
            )));
        }
    };
    let bytes = match &part.data {
        MediaData::Bytes(bytes) => {
            if bytes.len() > 20 * 1024 * 1024 {
                return Err(Error::invalid(
                    "Bedrock Converse media exceeds the 20971520 byte decoded limit",
                ));
            }
            media::encode(bytes)
        }
        MediaData::Encoded(value) => {
            let value = value.as_str().ok_or_else(|| {
                Error::invalid("Bedrock Converse media must contain valid base64")
            })?;
            if let Some(data) = value.strip_prefix("data:") {
                let (actual, bytes) = data.split_once(";base64,").ok_or_else(|| {
                    Error::invalid("Bedrock Converse media data URL must contain valid base64")
                })?;
                if actual.is_empty()
                    || actual.contains([';', ','])
                    || bytes.len() - bytes.trim_end_matches('=').len() > 2
                    || !bytes
                        .trim_end_matches('=')
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
                {
                    return Err(Error::invalid(
                        "Bedrock Converse media data URL must contain valid base64",
                    ));
                }
                if actual.to_lowercase() != mime {
                    return Err(Error::invalid(format!(
                        "Bedrock Converse media type {} does not match data URL type {actual}",
                        part.mime.as_str().unwrap_or("")
                    )));
                }
                bytes.to_owned()
            } else {
                value.to_owned()
            }
        }
    };
    if bytes.len() > 28 * 1024 * 1024 {
        return Err(Error::invalid(
            "Bedrock Converse media exceeds the 29360128 byte encoded limit",
        ));
    }
    if bytes.is_empty() {
        return Err(Error::invalid(
            "Bedrock Converse media must contain valid base64",
        ));
    }
    let decoded = media::decode(&bytes)
        .map_err(|_| Error::invalid("Bedrock Converse media must contain valid base64"))?;
    if decoded.len() > 20 * 1024 * 1024 {
        return Err(Error::invalid(
            "Bedrock Converse media exceeds the 20971520 byte decoded limit",
        ));
    }
    if media::encode(&decoded) != bytes {
        return Err(Error::invalid(
            "Bedrock Converse media must contain canonical base64",
        ));
    }
    let mut block = json::object([("format", s(format))]);
    if kind == "document" {
        json::set(
            &mut block,
            "name",
            s(part
                .filename
                .clone()
                .unwrap_or_else(|| format!("document.{format}").into())),
        );
    }
    json::set(&mut block, "source", json::object([("bytes", s(bytes))]));
    Ok(json::object([(kind, block)]))
}

fn validate_event(event: &JsonValue) -> Result<(), Error> {
    let object = |value: &JsonValue| matches!(value, JsonValue::Object(_));
    let optional = |value: &JsonValue, key: &str, check: &dyn Fn(&JsonValue) -> bool| {
        get(value, key).is_none_or(check)
    };
    let text = |value: &JsonValue| matches!(value, JsonValue::String(_));
    let number = |value: &JsonValue| matches!(value, JsonValue::Number(_));
    let required = |value: &JsonValue, key: &str, check: &dyn Fn(&JsonValue) -> bool| {
        get(value, key).is_some_and(check)
    };
    let mut valid = object(event);
    for key in [
        "messageStart",
        "contentBlockStart",
        "contentBlockDelta",
        "contentBlockStop",
        "messageStop",
        "metadata",
        "internalServerException",
        "modelStreamErrorException",
        "validationException",
        "throttlingException",
        "serviceUnavailableException",
    ] {
        let Some(value) = get(event, key) else {
            continue;
        };
        valid &= object(value);
        valid &= match key {
            "messageStart" => required(value, "role", &text),
            "messageStop" => required(value, "stopReason", &text),
            "contentBlockStart" => {
                required(value, "contentBlockIndex", &number)
                    && optional(value, "start", &|start| {
                        object(start)
                            && optional(start, "toolUse", &|tool| {
                                object(tool)
                                    && required(tool, "toolUseId", &text)
                                    && required(tool, "name", &text)
                            })
                    })
            }
            "contentBlockDelta" => {
                required(value, "contentBlockIndex", &number)
                    && optional(value, "delta", &|delta| {
                        object(delta)
                            && optional(delta, "text", &text)
                            && optional(delta, "toolUse", &|tool| {
                                object(tool) && required(tool, "input", &text)
                            })
                            && optional(delta, "reasoningContent", &|reasoning| {
                                object(reasoning)
                                    && optional(reasoning, "text", &text)
                                    && optional(reasoning, "signature", &text)
                            })
                    })
            }
            "contentBlockStop" => required(value, "contentBlockIndex", &number),
            "metadata" => optional(value, "usage", &|usage| {
                object(usage)
                    && [
                        "inputTokens",
                        "outputTokens",
                        "totalTokens",
                        "cacheReadInputTokens",
                        "cacheWriteInputTokens",
                    ]
                    .iter()
                    .all(|key| optional(usage, key, &number))
            }),
            _ => required(value, "message", &text),
        };
    }
    if !valid {
        return Err(Error::output("Invalid Bedrock Converse stream event"));
    }
    Ok(())
}
