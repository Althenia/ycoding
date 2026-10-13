use crate::{
    Error, gemini_media, gemini_schema,
    json::{self, get, s},
    llm::{
        BlockEvent, DeltaEvent, Event, Finish, FinishReason, Media, MediaData, Part, Request, Role,
        ToolCall, ToolChoice, ToolResultValue, Usage,
    },
    route::{InputUsageSemantics, Protocol, StreamParser, normalize_input_usage},
};
use ycoding_schema::{JsonValue, LosslessString, llm::ToolContent};

pub const DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";

pub struct Gemini;
impl Gemini {
    pub fn parser(_: &Request) -> Box<dyn StreamParser> {
        Box::new(Parser::default())
    }
}
impl Protocol for Gemini {
    fn id(&self) -> &'static str {
        "gemini"
    }
    fn lower(&self, request: &Request) -> Result<JsonValue, Error> {
        lower(request)
    }
    fn parser(&self, request: &Request) -> Box<dyn StreamParser> {
        Self::parser(request)
    }
}
fn signature(metadata: Option<&JsonValue>) -> Option<&LosslessString> {
    metadata
        .and_then(|metadata| get(metadata, "google"))
        .and_then(|google| get(google, "thoughtSignature"))
        .and_then(json::string)
}
fn google_metadata(signature: &LosslessString) -> Option<JsonValue> {
    Some(json::object([(
        "google",
        json::object([("thoughtSignature", s(signature.clone()))]),
    )]))
}
fn text_part(text: LosslessString) -> JsonValue {
    json::object([("text", s(text))])
}
fn join_text<'a>(parts: impl IntoIterator<Item = &'a LosslessString>) -> LosslessString {
    let mut result = LosslessString::default();
    for (index, part) in parts.into_iter().enumerate() {
        if index > 0 {
            json::concat(&mut result, &"\n".into());
        }
        json::concat(&mut result, part);
    }
    result
}
fn unsupported(role: &str, content: &str) -> Error {
    Error::invalid(format!(
        "Gemini {role} messages only support {content} content for now"
    ))
}
fn lower(request: &Request) -> Result<JsonValue, Error> {
    let mut contents = Vec::new();
    for message in &request.messages {
        if message.role == Role::System {
            let text = message
                .content
                .iter()
                .map(|part| match part {
                    Part::Text(part) => Ok(&part.text),
                    _ => Err(unsupported("system", "text")),
                })
                .collect::<Result<Vec<_>, _>>()?;
            let text = join_text(text);
            let mut wrapped = "<system-update>\n".encode_utf16().collect::<Vec<_>>();
            for unit in text.code_units() {
                match unit {
                    38 => wrapped.extend("&amp;".encode_utf16()),
                    60 => wrapped.extend("&lt;".encode_utf16()),
                    62 => wrapped.extend("&gt;".encode_utf16()),
                    _ => wrapped.push(unit),
                }
            }
            wrapped.extend("\n</system-update>".encode_utf16());
            let wrapped = LosslessString::from_utf16(wrapped);
            if let Some(previous) = contents.last_mut()
                && get(previous, "role").and_then(json::text) == Some("user")
            {
                let mut parts = get(previous, "parts")
                    .and_then(json::array)
                    .unwrap_or(&[])
                    .to_vec();
                parts.push(text_part(wrapped));
                json::set(previous, "parts", JsonValue::Array(parts));
                continue;
            }
            contents.push(json::object([
                ("role", s("user")),
                ("parts", JsonValue::Array(vec![text_part(wrapped)])),
            ]));
            continue;
        }
        let mut parts = Vec::new();
        for part in &message.content {
            match (message.role, part) {
                (Role::User, Part::Text(part)) | (Role::Assistant, Part::Text(part)) => {
                    parts.push(text_part(part.text.clone()))
                }
                (Role::User, Part::Media(part)) => parts.push(gemini_media::lower(part)),
                (Role::Assistant, Part::Reasoning(part)) => {
                    let mut lowered = json::object([
                        ("text", s(part.text.clone())),
                        ("thought", JsonValue::Bool(true)),
                    ]);
                    if let Some(signature) = signature(part.provider_metadata.as_ref()) {
                        json::set(&mut lowered, "thoughtSignature", s(signature.clone()));
                    }
                    parts.push(lowered);
                }
                (Role::Assistant, Part::ToolCall(part)) => {
                    let mut lowered = json::object([(
                        "functionCall",
                        json::object([
                            ("name", s(part.name.clone())),
                            ("args", part.input.clone()),
                        ]),
                    )]);
                    if let Some(signature) = signature(part.provider_metadata.as_ref()) {
                        json::set(&mut lowered, "thoughtSignature", s(signature.clone()));
                    }
                    parts.push(lowered);
                }
                (Role::Tool, Part::ToolResult(part)) => {
                    let text = match &part.result {
                        ToolResultValue::Content(content) => {
                            join_text(content.iter().filter_map(|part| match part {
                                ToolContent::Text(text) => Some(&text.text),
                                _ => None,
                            }))
                        }
                        result => result.to_text(),
                    };
                    parts.push(json::object([(
                        "functionResponse",
                        json::object([
                            ("name", s(part.name.clone())),
                            (
                                "response",
                                json::object([
                                    ("name", s(part.name.clone())),
                                    ("content", s(text)),
                                ]),
                            ),
                        ]),
                    )]));
                    if let ToolResultValue::Content(content) = &part.result {
                        for part in content {
                            if let ToolContent::File(file) = part {
                                parts.push(gemini_media::lower(&Media {
                                    mime: file.mime.clone(),
                                    data: MediaData::Encoded(file.uri.clone()),
                                    filename: file.name.clone(),
                                }));
                            }
                        }
                    }
                }
                (Role::User, _) => return Err(unsupported("user", "text and media")),
                (Role::Assistant, _) => {
                    return Err(unsupported("assistant", "text, reasoning, and tool-call"));
                }
                (Role::Tool, _) => return Err(unsupported("tool", "tool-result")),
                (Role::System, _) => unreachable!(),
            }
        }
        contents.push(json::object([
            (
                "role",
                s(if message.role == Role::Assistant {
                    "model"
                } else {
                    "user"
                }),
            ),
            ("parts", JsonValue::Array(parts)),
        ]));
    }
    let mut body = json::object([("contents", JsonValue::Array(contents))]);
    if !request.system.is_empty() {
        json::set(
            &mut body,
            "systemInstruction",
            json::object([(
                "parts",
                JsonValue::Array(vec![text_part(join_text(
                    request.system.iter().map(|part| &part.text),
                ))]),
            )]),
        );
    }
    if !request.tools.is_empty() && request.tool_choice != Some(ToolChoice::None) {
        let declarations = request
            .tools
            .iter()
            .map(|tool| {
                let schema = if request.model.tool_schema
                    == Some(crate::llm::ToolSchemaCompatibility::Gemini)
                {
                    gemini_schema::convert(&tool.input_schema).unwrap_or_else(json::empty)
                } else {
                    crate::tool_schema::model_compatibility(
                        &tool.input_schema,
                        request.model.tool_schema,
                    )
                };
                let mut lowered = json::object([
                    ("name", s(tool.name.clone())),
                    ("description", s(tool.description.clone())),
                ]);
                if let Some(schema) = gemini_schema::convert(&schema) {
                    json::set(&mut lowered, "parameters", schema);
                }
                lowered
            })
            .collect();
        json::set(
            &mut body,
            "tools",
            JsonValue::Array(vec![json::object([(
                "functionDeclarations",
                JsonValue::Array(declarations),
            )])]),
        );
        if let Some(choice) = &request.tool_choice {
            let mut config = json::object([(
                "mode",
                s(match choice {
                    ToolChoice::Auto => "AUTO",
                    ToolChoice::None => "NONE",
                    ToolChoice::Required | ToolChoice::Tool(_) => "ANY",
                }),
            )]);
            if let ToolChoice::Tool(name) = choice {
                json::set(
                    &mut config,
                    "allowedFunctionNames",
                    JsonValue::Array(vec![s(name.clone())]),
                );
            }
            json::set(
                &mut body,
                "toolConfig",
                json::object([("functionCallingConfig", config)]),
            );
        }
    }
    let mut generation = json::empty();
    for (key, number) in [
        ("maxOutputTokens", request.generation.max_tokens),
        ("temperature", request.generation.temperature),
        ("topP", request.generation.top_p),
        ("topK", request.generation.top_k),
    ] {
        if let Some(number) = number {
            json::set(&mut generation, key, JsonValue::Number(number));
        }
    }
    if let Some(stop) = &request.generation.stop {
        json::set(
            &mut generation,
            "stopSequences",
            JsonValue::Array(stop.iter().cloned().map(s).collect()),
        );
    }
    if let Some(thinking) = request
        .provider_options
        .as_ref()
        .and_then(|options| get(options, "gemini"))
        .and_then(|options| get(options, "thinkingConfig"))
    {
        let mut config = json::empty();
        if let Some(value) =
            get(thinking, "thinkingBudget").filter(|value| matches!(value, JsonValue::Number(_)))
        {
            json::set(&mut config, "thinkingBudget", value.clone());
        }
        if let Some(value) =
            get(thinking, "includeThoughts").filter(|value| matches!(value, JsonValue::Bool(_)))
        {
            json::set(&mut config, "includeThoughts", value.clone());
        }
        if matches!(&config,JsonValue::Object(fields) if !fields.is_empty()) {
            json::set(&mut generation, "thinkingConfig", config);
        }
    }
    if matches!(&generation,JsonValue::Object(fields) if !fields.is_empty()) {
        json::set(&mut body, "generationConfig", generation);
    }
    Ok(body)
}

#[derive(Default)]
struct Parser {
    started: bool,
    text: bool,
    reasoning: bool,
    reasoning_signature: Option<LosslessString>,
    next_tool_call: usize,
    usage: Option<Usage>,
    finish_reason: Option<LosslessString>,
    terminal: bool,
}
impl Parser {
    fn start(&mut self, events: &mut Vec<Event>) {
        if self.started {
            return;
        }
        self.started = true;
        events.push(Event::StepStart { index: 0.0 });
    }
    fn end_reasoning(&mut self, events: &mut Vec<Event>) {
        if !self.reasoning {
            return;
        }
        self.reasoning = false;
        events.push(Event::ReasoningEnd(BlockEvent {
            id: "reasoning-0".into(),
            provider_metadata: self.reasoning_signature.as_ref().and_then(google_metadata),
        }));
    }
}
impl StreamParser for Parser {
    fn push(&mut self, event: &JsonValue) -> Result<Vec<Event>, Error> {
        let event = decode_event(event)?;
        if let Some(usage) = get(&event, "usageMetadata") {
            self.usage = Some(map_usage(usage));
        }
        let candidate = get(&event, "candidates")
            .and_then(json::array)
            .and_then(|candidates| candidates.first());
        let mut events = Vec::new();
        if let Some(parts) = candidate
            .and_then(|candidate| get(candidate, "content"))
            .and_then(|content| get(content, "parts"))
            .and_then(json::array)
        {
            for part in parts {
                let signature = get(part, "thoughtSignature")
                    .and_then(json::string)
                    .filter(|value| !value.is_empty());
                let thought = get(part, "thought") == Some(&JsonValue::Bool(true));
                if thought && let Some(signature) = signature {
                    self.reasoning_signature = Some(signature.clone());
                }
                if let Some(text) = get(part, "text")
                    .and_then(json::string)
                    .filter(|value| !value.is_empty())
                {
                    self.start(&mut events);
                    if thought {
                        let metadata = signature.and_then(google_metadata);
                        if !self.reasoning {
                            self.reasoning = true;
                            events.push(Event::ReasoningStart(BlockEvent {
                                id: "reasoning-0".into(),
                                provider_metadata: metadata.clone(),
                            }));
                        }
                        events.push(Event::ReasoningDelta(DeltaEvent {
                            id: "reasoning-0".into(),
                            text: text.clone(),
                            provider_metadata: metadata,
                        }));
                        continue;
                    }
                    self.end_reasoning(&mut events);
                    if !self.text {
                        self.text = true;
                        events.push(Event::TextStart(BlockEvent {
                            id: "text-0".into(),
                            provider_metadata: None,
                        }));
                    }
                    events.push(Event::TextDelta(DeltaEvent {
                        id: "text-0".into(),
                        text: text.clone(),
                        provider_metadata: None,
                    }));
                    continue;
                }
                if let Some(call) = get(part, "functionCall") {
                    self.end_reasoning(&mut events);
                    self.start(&mut events);
                    events.push(Event::ToolCall(ToolCall {
                        id: format!("tool_{}", self.next_tool_call).into(),
                        name: get(call, "name")
                            .and_then(json::string)
                            .cloned()
                            .unwrap_or_default(),
                        input: get(call, "args").cloned().unwrap_or(JsonValue::Null),
                        provider_executed: None,
                        provider_metadata: signature.and_then(google_metadata),
                    }));
                    self.next_tool_call += 1;
                }
            }
        }
        if let Some(reason) = candidate
            .and_then(|candidate| get(candidate, "finishReason"))
            .and_then(json::string)
        {
            self.finish_reason = Some(reason.clone());
        }
        if self.terminal && !events.is_empty() {
            return Err(Error::output(
                "Provider emitted an event after the terminal event",
            ));
        }
        Ok(events)
    }
    fn finish(&mut self) -> Result<Vec<Event>, Error> {
        if self.terminal {
            return Ok(Vec::new());
        }
        if self
            .finish_reason
            .as_ref()
            .is_none_or(LosslessString::is_empty)
            && self.usage.is_none()
        {
            return Err(Error::missing_terminal());
        }
        let mut events = Vec::new();
        self.end_reasoning(&mut events);
        self.start(&mut events);
        if self.text {
            events.push(Event::TextEnd(BlockEvent {
                id: "text-0".into(),
                provider_metadata: None,
            }));
            self.text = false;
        }
        let reason = match self.finish_reason.as_ref().and_then(LosslessString::as_str) {
            Some("STOP") => {
                if self.next_tool_call > 0 {
                    FinishReason::ToolCalls
                } else {
                    FinishReason::Stop
                }
            }
            Some("MAX_TOKENS") => FinishReason::Length,
            Some(
                "IMAGE_SAFETY" | "RECITATION" | "SAFETY" | "BLOCKLIST" | "PROHIBITED_CONTENT"
                | "SPII",
            ) => FinishReason::ContentFilter,
            Some("MALFORMED_FUNCTION_CALL") => FinishReason::Error,
            _ => FinishReason::Unknown,
        };
        let finish = Finish {
            reason,
            usage: self.usage.clone(),
            provider_metadata: None,
        };
        events.push(Event::StepFinish {
            index: 0.0,
            finish: finish.clone(),
        });
        events.push(Event::Finish(finish));
        self.terminal = true;
        Ok(events)
    }
}
fn map_usage(raw: &JsonValue) -> Usage {
    let count = |key| get(raw, key).and_then(json::number);
    let normalized = normalize_input_usage(
        count("promptTokenCount"),
        None,
        count("cachedContentTokenCount"),
        None,
        InputUsageSemantics::Inclusive,
    );
    let output = count("candidatesTokenCount")
        .map(|visible| visible + count("thoughtsTokenCount").unwrap_or(0.0));
    Usage {
        output_tokens: output,
        reasoning_tokens: count("thoughtsTokenCount"),
        total_tokens: count("totalTokenCount")
            .or_else(|| crate::route::sum_tokens(&[count("promptTokenCount"), output])),
        provider_metadata: Some(json::object([("google", raw.clone())])),
        ..normalized
    }
}
fn decode_event(raw: &JsonValue) -> Result<JsonValue, Error> {
    let invalid = || Error::output("Invalid gemini stream event");
    if !matches!(raw, JsonValue::Object(_)) {
        return Err(invalid());
    }
    let mut event = json::empty();
    if let Some(candidates) = get(raw, "candidates") {
        let candidates = json::array(candidates)
            .ok_or_else(invalid)?
            .iter()
            .map(|candidate| {
                if !matches!(candidate, JsonValue::Object(_)) {
                    return Err(invalid());
                }
                let mut decoded = json::empty();
                if let Some(content) = get(candidate, "content") {
                    let role = get(content, "role")
                        .filter(|value| matches!(json::text(value), Some("user" | "model")))
                        .ok_or_else(invalid)?;
                    let parts = get(content, "parts")
                        .and_then(json::array)
                        .ok_or_else(invalid)?
                        .iter()
                        .map(decode_part)
                        .collect::<Result<Vec<_>, _>>()?;
                    json::set(
                        &mut decoded,
                        "content",
                        json::object([("role", role.clone()), ("parts", JsonValue::Array(parts))]),
                    );
                }
                if let Some(reason) = get(candidate, "finishReason") {
                    if !matches!(reason, JsonValue::String(_)) {
                        return Err(invalid());
                    }
                    json::set(&mut decoded, "finishReason", reason.clone());
                }
                Ok(decoded)
            })
            .collect::<Result<Vec<_>, _>>()?;
        json::set(&mut event, "candidates", JsonValue::Array(candidates));
    }
    if let Some(usage) = get(raw, "usageMetadata") {
        if !matches!(usage, JsonValue::Object(_)) {
            return Err(invalid());
        }
        let mut decoded = json::empty();
        for key in [
            "cachedContentTokenCount",
            "thoughtsTokenCount",
            "promptTokenCount",
            "candidatesTokenCount",
            "totalTokenCount",
        ] {
            if let Some(value) = get(usage, key) {
                if !matches!(value, JsonValue::Number(_)) {
                    return Err(invalid());
                }
                json::set(&mut decoded, key, value.clone());
            }
        }
        json::set(&mut event, "usageMetadata", decoded);
    }
    Ok(event)
}
fn decode_part(raw: &JsonValue) -> Result<JsonValue, Error> {
    let optional_signature =
        get(raw, "thoughtSignature").is_none_or(|value| matches!(value, JsonValue::String(_)));
    if let Some(text) = get(raw, "text").filter(|value| matches!(value, JsonValue::String(_)))
        && optional_signature
        && get(raw, "thought").is_none_or(|value| matches!(value, JsonValue::Bool(_)))
    {
        let mut part = json::object([("text", text.clone())]);
        for key in ["thought", "thoughtSignature"] {
            if let Some(value) = get(raw, key) {
                json::set(&mut part, key, value.clone());
            }
        }
        return Ok(part);
    }
    for (key, field) in [
        ("inlineData", "mimeType"),
        ("functionCall", "name"),
        ("functionResponse", "name"),
    ] {
        let Some(value) = get(raw, key) else {
            continue;
        };
        let Some(name) = get(value, field).filter(|value| matches!(value, JsonValue::String(_)))
        else {
            continue;
        };
        if key == "inlineData" {
            if let Some(data) =
                get(value, "data").filter(|value| matches!(value, JsonValue::String(_)))
            {
                return Ok(json::object([(
                    key,
                    json::object([(field, name.clone()), ("data", data.clone())]),
                )]));
            }
            continue;
        }
        if key == "functionCall" && !optional_signature {
            continue;
        }
        let argument = if key == "functionCall" {
            "args"
        } else {
            "response"
        };
        let Some(value) = get(value, argument) else {
            continue;
        };
        let decoded = json::object([(field, name.clone()), (argument, value.clone())]);
        let mut part = json::object([(key, decoded)]);
        if key == "functionCall"
            && let Some(signature) = get(raw, "thoughtSignature")
        {
            json::set(&mut part, "thoughtSignature", signature.clone());
        }
        return Ok(part);
    }
    Err(Error::output("Invalid gemini stream event"))
}
