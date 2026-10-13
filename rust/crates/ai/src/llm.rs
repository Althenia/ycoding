use crate::{
    Error,
    cache::{Hint, Policy},
    json,
    route::Route,
};
use std::{collections::BTreeMap, sync::Arc};
use ycoding_schema::{JsonValue, LosslessString, llm::ToolContent, model, provider};

#[derive(Clone)]
pub struct Model {
    pub id: model::Id,
    pub provider: provider::Id,
    pub route: Arc<Route>,
    pub defaults: Defaults,
    pub tool_schema: Option<ToolSchemaCompatibility>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolSchemaCompatibility {
    Gemini,
    Moonshot,
}
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Generation {
    pub max_tokens: Option<f64>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<f64>,
    pub frequency_penalty: Option<f64>,
    pub presence_penalty: Option<f64>,
    pub seed: Option<f64>,
    pub stop: Option<Vec<LosslessString>>,
}
impl Generation {
    pub fn overlay(&self, right: &Self) -> Self {
        Self {
            max_tokens: right.max_tokens.or(self.max_tokens),
            temperature: right.temperature.or(self.temperature),
            top_p: right.top_p.or(self.top_p),
            top_k: right.top_k.or(self.top_k),
            frequency_penalty: right.frequency_penalty.or(self.frequency_penalty),
            presence_penalty: right.presence_penalty.or(self.presence_penalty),
            seed: right.seed.or(self.seed),
            stop: right.stop.clone().or_else(|| self.stop.clone()),
        }
    }
}
#[derive(Clone, Default)]
pub struct HttpOptions {
    pub body: Option<JsonValue>,
    pub headers: BTreeMap<String, String>,
    pub query: BTreeMap<String, String>,
}
impl HttpOptions {
    pub fn overlay(&self, right: &Self) -> Self {
        Self {
            body: match (&self.body, &right.body) {
                (Some(a), Some(b)) => Some(json::merge(a, b)),
                (_, Some(b)) => Some(b.clone()),
                (a, None) => a.clone(),
            },
            headers: self
                .headers
                .iter()
                .chain(right.headers.iter())
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            query: self
                .query
                .iter()
                .chain(right.query.iter())
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        }
    }
}
#[derive(Clone, Default)]
pub struct Defaults {
    pub output_limit: Option<f64>,
    pub context_limit: Option<f64>,
    pub generation: Generation,
    pub provider_options: Option<JsonValue>,
    pub http: HttpOptions,
}
#[derive(Clone, Debug, PartialEq)]
pub struct TextPart {
    pub text: LosslessString,
    pub cache: Option<Hint>,
    pub metadata: Option<JsonValue>,
    pub provider_metadata: Option<JsonValue>,
}
impl From<&str> for TextPart {
    fn from(text: &str) -> Self {
        Self {
            text: text.into(),
            cache: None,
            metadata: None,
            provider_metadata: None,
        }
    }
}
impl From<LosslessString> for TextPart {
    fn from(text: LosslessString) -> Self {
        Self {
            text,
            cache: None,
            metadata: None,
            provider_metadata: None,
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum MediaData {
    Encoded(LosslessString),
    Bytes(Vec<u8>),
}
#[derive(Clone, Debug, PartialEq)]
pub struct Media {
    pub mime: LosslessString,
    pub data: MediaData,
    pub filename: Option<LosslessString>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Reasoning {
    pub text: LosslessString,
    pub encrypted: Option<LosslessString>,
    pub provider_metadata: Option<JsonValue>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct ToolCall {
    pub id: LosslessString,
    pub name: LosslessString,
    pub input: JsonValue,
    pub provider_executed: Option<bool>,
    pub provider_metadata: Option<JsonValue>,
}
#[derive(Clone, Debug, PartialEq)]
pub enum ToolResultValue {
    Json(JsonValue),
    Text(JsonValue),
    Error(JsonValue),
    Content(Vec<ToolContent>),
}
impl ToolResultValue {
    pub fn to_json(&self) -> JsonValue {
        match self {
            Self::Json(value) | Self::Text(value) | Self::Error(value) => value.clone(),
            Self::Content(content) => {
                use ycoding_schema::DomainEncode;
                JsonValue::Array(content.iter().map(DomainEncode::encode).collect())
            }
        }
    }
    pub fn to_text(&self) -> LosslessString {
        match self {
            Self::Text(value) => json::js_string(value),
            Self::Error(value) => {
                if matches!(value, JsonValue::Object(_) | JsonValue::Array(_)) {
                    ycoding_schema::stringify_json(value).into()
                } else {
                    json::js_string(value)
                }
            }
            _ => ycoding_schema::stringify_json(&self.to_json()).into(),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ToolOutput {
    pub structured: JsonValue,
    pub content: Vec<ToolContent>,
}
impl ToolOutput {
    pub fn result(&self) -> ToolResultValue {
        match self.content.as_slice() {
            [] => ToolResultValue::Json(self.structured.clone()),
            [ToolContent::Text(text)] => ToolResultValue::Text(json::s(text.text.clone())),
            _ => ToolResultValue::Content(self.content.clone()),
        }
    }
    pub fn from_result(result: &ToolResultValue) -> Option<Self> {
        match result {
            ToolResultValue::Json(value) => Some(Self {
                structured: value.clone(),
                content: Vec::new(),
            }),
            ToolResultValue::Text(value) => Some(Self {
                structured: json::empty(),
                content: vec![ToolContent::Text(ycoding_schema::llm::ToolTextContent {
                    text: json::string(value)
                        .cloned()
                        .unwrap_or_else(|| ycoding_schema::stringify_json(value).into()),
                })],
            }),
            ToolResultValue::Content(content) => Some(Self {
                structured: json::empty(),
                content: content.clone(),
            }),
            ToolResultValue::Error(_) => None,
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ToolResult {
    pub id: LosslessString,
    pub name: LosslessString,
    pub result: ToolResultValue,
    pub cache: Option<Hint>,
    pub provider_executed: Option<bool>,
    pub provider_metadata: Option<JsonValue>,
    pub output: Option<ToolOutput>,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Part {
    Text(TextPart),
    Media(Media),
    Reasoning(Reasoning),
    ToolCall(ToolCall),
    ToolResult(ToolResult),
}
impl Part {
    pub fn cache(&self) -> Option<&Hint> {
        match self {
            Self::Text(part) => part.cache.as_ref(),
            Self::ToolResult(part) => part.cache.as_ref(),
            _ => None,
        }
    }
    pub fn set_cache(&mut self, hint: Option<Hint>) {
        match self {
            Self::Text(part) => part.cache = hint,
            Self::ToolResult(part) => part.cache = hint,
            _ => {}
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
    System,
    Tool,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Message {
    pub id: Option<LosslessString>,
    pub role: Role,
    pub content: Vec<Part>,
    pub volatile: bool,
    pub metadata: Option<JsonValue>,
    pub native: Option<JsonValue>,
}
impl Message {
    pub fn new(role: Role, content: Vec<Part>) -> Self {
        Self {
            id: None,
            role,
            content,
            volatile: false,
            metadata: None,
            native: None,
        }
    }
    pub fn user(text: impl Into<LosslessString>) -> Self {
        Self::new(Role::User, vec![Part::Text(text.into().into())])
    }
    pub fn assistant(content: Vec<Part>) -> Self {
        Self::new(Role::Assistant, content)
    }
    pub fn system(text: impl Into<LosslessString>) -> Self {
        Self::new(Role::System, vec![Part::Text(text.into().into())])
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ToolDefinition {
    pub name: LosslessString,
    pub description: LosslessString,
    pub input_schema: JsonValue,
    pub output_schema: Option<JsonValue>,
    pub cache: Option<Hint>,
    pub metadata: Option<JsonValue>,
    pub native: Option<JsonValue>,
}
#[derive(Clone, Debug, PartialEq)]
pub enum ToolChoice {
    Auto,
    None,
    Required,
    Tool(LosslessString),
}
#[derive(Clone, Debug, PartialEq)]
pub enum ResponseFormat {
    Text,
    Json(JsonValue),
    Tool(ToolDefinition),
}
#[derive(Clone)]
pub struct Request {
    pub id: Option<LosslessString>,
    pub model: Model,
    pub system: Vec<TextPart>,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolDefinition>,
    pub tool_choice: Option<ToolChoice>,
    pub generation: Generation,
    pub provider_options: Option<JsonValue>,
    pub http: HttpOptions,
    pub cache: Policy,
    pub response_format: Option<ResponseFormat>,
    pub metadata: Option<JsonValue>,
}
impl Request {
    pub fn new(model: Model) -> Self {
        Self {
            id: None,
            model,
            system: Vec::new(),
            messages: Vec::new(),
            tools: Vec::new(),
            tool_choice: None,
            generation: Generation::default(),
            provider_options: None,
            http: HttpOptions::default(),
            cache: Policy::Auto,
            response_format: None,
            metadata: None,
        }
    }
    pub fn resolved(&self) -> Self {
        let mut request = self.clone();
        request.generation = self
            .model
            .route
            .defaults
            .generation
            .overlay(&self.model.defaults.generation)
            .overlay(&self.generation);
        request.http = self
            .model
            .route
            .defaults
            .http
            .overlay(&self.model.defaults.http)
            .overlay(&self.http);
        request.provider_options = [
            self.model.route.defaults.provider_options.as_ref(),
            self.model.defaults.provider_options.as_ref(),
            self.provider_options.as_ref(),
        ]
        .into_iter()
        .flatten()
        .cloned()
        .reduce(|a, b| json::merge(&a, &b));
        request
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FinishReason {
    Stop,
    Length,
    ToolCalls,
    ContentFilter,
    Error,
    Unknown,
}
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Usage {
    pub input_tokens: Option<f64>,
    pub output_tokens: Option<f64>,
    pub non_cached_input_tokens: Option<f64>,
    pub cache_read_input_tokens: Option<f64>,
    pub cache_write_input_tokens: Option<f64>,
    pub reasoning_tokens: Option<f64>,
    pub output_may_include_unreported_reasoning: Option<bool>,
    pub total_tokens: Option<f64>,
    pub prompt_eval_duration_ns: Option<f64>,
    pub generation_duration_ns: Option<f64>,
    pub load_duration_ns: Option<f64>,
    pub provider_metadata: Option<JsonValue>,
}
impl Usage {
    pub fn visible_output_tokens(&self) -> f64 {
        (self.output_tokens.unwrap_or(0.0) - self.reasoning_tokens.unwrap_or(0.0)).max(0.0)
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct BlockEvent {
    pub id: LosslessString,
    pub provider_metadata: Option<JsonValue>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct DeltaEvent {
    pub id: LosslessString,
    pub text: LosslessString,
    pub provider_metadata: Option<JsonValue>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct ToolInputEvent {
    pub id: LosslessString,
    pub name: LosslessString,
    pub provider_executed: Option<bool>,
    pub provider_metadata: Option<JsonValue>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Finish {
    pub reason: FinishReason,
    pub usage: Option<Usage>,
    pub provider_metadata: Option<JsonValue>,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    StepStart {
        index: f64,
    },
    TextStart(BlockEvent),
    TextDelta(DeltaEvent),
    TextEnd(BlockEvent),
    ReasoningStart(BlockEvent),
    ReasoningDelta(DeltaEvent),
    ReasoningEnd(BlockEvent),
    ToolInputStart(ToolInputEvent),
    ToolInputDelta {
        id: LosslessString,
        name: LosslessString,
        text: LosslessString,
    },
    ToolInputEnd(ToolInputEvent),
    ToolInputError {
        id: LosslessString,
        name: LosslessString,
        raw: LosslessString,
    },
    ToolCall(ToolCall),
    ToolResult(ToolResult),
    ToolError {
        id: LosslessString,
        name: LosslessString,
        message: LosslessString,
        error: Option<JsonValue>,
    },
    StepFinish {
        index: f64,
        finish: Finish,
    },
    Finish(Finish),
    ProviderError {
        message: LosslessString,
        context_overflow: bool,
        provider_metadata: Option<JsonValue>,
    },
}
impl Event {
    pub fn terminal(&self) -> bool {
        matches!(self, Self::Finish(_) | Self::ProviderError { .. })
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Response {
    pub message: Message,
    pub events: Vec<Event>,
    pub usage: Option<Usage>,
    pub finish_reason: FinishReason,
}
impl Response {
    pub fn from_events(events: Vec<Event>) -> Result<Self, Error> {
        let mut content = Vec::new();
        let mut positions = BTreeMap::new();
        let mut usage = None;
        let mut reason = None;
        for event in &events {
            if reason.is_some() {
                return Err(Error::output(
                    "Provider emitted an event after the terminal event",
                ));
            }
            match event {
                Event::TextStart(block) | Event::ReasoningStart(block) => {
                    let reasoning = matches!(event, Event::ReasoningStart(_));
                    positions
                        .entry((reasoning, block.id.clone()))
                        .or_insert_with(|| {
                            let index = content.len();
                            content.push(if reasoning {
                                Part::Reasoning(Reasoning {
                                    text: "".into(),
                                    encrypted: None,
                                    provider_metadata: block.provider_metadata.clone(),
                                })
                            } else {
                                Part::Text(TextPart {
                                    text: "".into(),
                                    cache: None,
                                    metadata: None,
                                    provider_metadata: block.provider_metadata.clone(),
                                })
                            });
                            index
                        });
                }
                Event::TextDelta(delta) | Event::ReasoningDelta(delta) => {
                    let reasoning = matches!(event, Event::ReasoningDelta(_));
                    let index = *positions
                        .entry((reasoning, delta.id.clone()))
                        .or_insert_with(|| {
                            let index = content.len();
                            content.push(if reasoning {
                                Part::Reasoning(Reasoning {
                                    text: "".into(),
                                    encrypted: None,
                                    provider_metadata: None,
                                })
                            } else {
                                Part::Text("".into())
                            });
                            index
                        });
                    match &mut content[index] {
                        Part::Text(part) => {
                            json::concat(&mut part.text, &delta.text);
                            if delta.provider_metadata.is_some() {
                                part.provider_metadata = delta.provider_metadata.clone();
                            }
                        }
                        Part::Reasoning(part) => {
                            json::concat(&mut part.text, &delta.text);
                            if delta.provider_metadata.is_some() {
                                part.provider_metadata = delta.provider_metadata.clone();
                            }
                        }
                        _ => {}
                    }
                }
                Event::TextEnd(block) | Event::ReasoningEnd(block) => {
                    if let Some(index) =
                        positions.get(&(matches!(event, Event::ReasoningEnd(_)), block.id.clone()))
                        && let Some(metadata) = &block.provider_metadata
                    {
                        match &mut content[*index] {
                            Part::Text(part) => part.provider_metadata = Some(metadata.clone()),
                            Part::Reasoning(part) => {
                                part.provider_metadata = Some(metadata.clone())
                            }
                            _ => {}
                        }
                    }
                }
                Event::ToolCall(call) => content.push(Part::ToolCall(call.clone())),
                Event::ToolResult(result) => content.push(Part::ToolResult(result.clone())),
                Event::StepFinish { finish, .. } => {
                    if finish.usage.is_some() {
                        usage = finish.usage.clone();
                    }
                }
                Event::Finish(finish) => {
                    reason = Some(finish.reason);
                    if finish.usage.is_some() {
                        usage = finish.usage.clone();
                    }
                }
                Event::ProviderError { .. } => reason = Some(FinishReason::Error),
                _ => {}
            }
        }
        Ok(Self {
            message: Message::assistant(content),
            events,
            usage,
            finish_reason: reason.ok_or_else(Error::missing_terminal)?,
        })
    }
    pub fn text(&self) -> LosslessString {
        LosslessString::from_utf16(
            self.events
                .iter()
                .filter_map(|event| {
                    if let Event::TextDelta(delta) = event {
                        Some(&delta.text)
                    } else {
                        None
                    }
                })
                .flat_map(LosslessString::code_units)
                .collect(),
        )
    }
    pub fn reasoning(&self) -> LosslessString {
        LosslessString::from_utf16(
            self.events
                .iter()
                .filter_map(|event| {
                    if let Event::ReasoningDelta(delta) = event {
                        Some(&delta.text)
                    } else {
                        None
                    }
                })
                .flat_map(LosslessString::code_units)
                .collect(),
        )
    }
}
