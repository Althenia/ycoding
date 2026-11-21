use crate::{
    Error,
    json::{self, get},
    llm::{BlockEvent, DeltaEvent, Event, Finish, ToolCall, ToolInputEvent, Usage},
    route::{InputUsageSemantics, normalize_input_usage, sum_tokens},
};
use ycoding_schema::{JsonValue, LosslessString};

pub fn metadata(value: JsonValue) -> Option<JsonValue> {
    Some(json::object([("openai", value)]))
}
pub fn join(parts: impl IntoIterator<Item = LosslessString>, separator: &str) -> LosslessString {
    let mut text = LosslessString::default();
    for (index, part) in parts.into_iter().enumerate() {
        if index > 0 {
            json::concat(&mut text, &separator.into());
        }
        json::concat(&mut text, &part);
    }
    text
}
pub fn string<'a>(value: &'a JsonValue, key: &str) -> Option<&'a LosslessString> {
    get(value, key).and_then(json::string)
}
pub fn truthy(value: &JsonValue) -> bool {
    match value {
        JsonValue::Null => false,
        JsonValue::Bool(value) => *value,
        JsonValue::Number(value) => *value != 0.0 && !value.is_nan(),
        JsonValue::String(value) => !value.is_empty(),
        _ => true,
    }
}
pub fn pick(value: &JsonValue, keys: &[&str]) -> JsonValue {
    json::object(
        keys.iter()
            .filter_map(|key| get(value, key).map(|value| (*key, value.clone()))),
    )
}
pub fn usage(raw: &JsonValue, chat: bool, reasoning: bool, discount: Option<&JsonValue>) -> Usage {
    let input_key = if chat {
        "prompt_tokens"
    } else {
        "input_tokens"
    };
    let output_key = if chat {
        "completion_tokens"
    } else {
        "output_tokens"
    };
    let input_details = get(
        raw,
        if chat {
            "prompt_tokens_details"
        } else {
            "input_tokens_details"
        },
    );
    let output_details = get(
        raw,
        if chat {
            "completion_tokens_details"
        } else {
            "output_tokens_details"
        },
    );
    let input = get(raw, input_key).and_then(json::number);
    let output = get(raw, output_key).and_then(json::number);
    let read = input_details
        .and_then(|value| get(value, "cached_tokens"))
        .and_then(json::number)
        .or_else(|| {
            if chat {
                get(raw, "prompt_cache_hit_tokens").and_then(json::number)
            } else {
                None
            }
        });
    let write = input_details
        .and_then(|value| get(value, "cache_write_tokens"))
        .and_then(json::number);
    let hidden = output_details
        .and_then(|value| get(value, "reasoning_tokens"))
        .and_then(json::number);
    let mut native = pick(
        raw,
        if chat {
            &[
                "prompt_tokens",
                "prompt_cache_hit_tokens",
                "prompt_cache_miss_tokens",
                "completion_tokens",
                "total_tokens",
                "prompt_tokens_details",
                "completion_tokens_details",
            ]
        } else {
            &[
                "input_tokens",
                "input_tokens_details",
                "output_tokens",
                "output_tokens_details",
                "total_tokens",
            ]
        },
    );
    for (key, fields) in [
        (
            if chat {
                "prompt_tokens_details"
            } else {
                "input_tokens_details"
            },
            &["cached_tokens", "cache_write_tokens"][..],
        ),
        (
            if chat {
                "completion_tokens_details"
            } else {
                "output_tokens_details"
            },
            &["reasoning_tokens"][..],
        ),
    ] {
        if let Some(value) = get(raw, key)
            && matches!(value, JsonValue::Object(_))
        {
            json::set(&mut native, key, pick(value, fields));
        }
    }
    if let Some(discount) = discount.filter(|value| !matches!(value, JsonValue::Null)) {
        json::set(&mut native, "cache_discount", discount.clone());
    }
    Usage {
        output_tokens: output,
        reasoning_tokens: hidden,
        total_tokens: get(raw, "total_tokens")
            .and_then(json::number)
            .or_else(|| sum_tokens(&[input, output])),
        output_may_include_unreported_reasoning: (reasoning && hidden.is_none()).then_some(true),
        provider_metadata: metadata(native),
        ..normalize_input_usage(input, None, read, write, InputUsageSemantics::Inclusive)
    }
}
#[derive(Default)]
pub struct Lifecycle {
    pub started: bool,
    pub text: Vec<LosslessString>,
    pub reasoning: Vec<LosslessString>,
}
impl Lifecycle {
    pub fn start(&mut self, events: &mut Vec<Event>) {
        if !self.started {
            self.started = true;
            events.push(Event::StepStart { index: 0.0 });
        }
    }
    pub fn text_delta(
        &mut self,
        events: &mut Vec<Event>,
        id: LosslessString,
        text: LosslessString,
        metadata: Option<JsonValue>,
    ) {
        self.start(events);
        if !self.text.contains(&id) {
            self.text.push(id.clone());
            events.push(Event::TextStart(BlockEvent {
                id: id.clone(),
                provider_metadata: metadata.clone(),
            }));
        }
        events.push(Event::TextDelta(DeltaEvent {
            id,
            text,
            provider_metadata: metadata,
        }));
    }
    pub fn reasoning_start(
        &mut self,
        events: &mut Vec<Event>,
        id: LosslessString,
        metadata: Option<JsonValue>,
    ) {
        if self.reasoning.contains(&id) {
            return;
        }
        self.start(events);
        self.reasoning.push(id.clone());
        events.push(Event::ReasoningStart(BlockEvent {
            id,
            provider_metadata: metadata,
        }));
    }
    pub fn reasoning_delta(
        &mut self,
        events: &mut Vec<Event>,
        id: LosslessString,
        text: LosslessString,
        metadata: Option<JsonValue>,
    ) {
        self.reasoning_start(events, id.clone(), metadata.clone());
        events.push(Event::ReasoningDelta(DeltaEvent {
            id,
            text,
            provider_metadata: metadata,
        }));
    }
    pub fn end(
        &mut self,
        events: &mut Vec<Event>,
        id: &LosslessString,
        reasoning: bool,
        metadata: Option<JsonValue>,
    ) {
        let ids = if reasoning {
            &mut self.reasoning
        } else {
            &mut self.text
        };
        if !ids.contains(id) {
            return;
        }
        ids.retain(|value| value != id);
        let block = BlockEvent {
            id: id.clone(),
            provider_metadata: metadata,
        };
        events.push(if reasoning {
            Event::ReasoningEnd(block)
        } else {
            Event::TextEnd(block)
        });
    }
    pub fn finish(&mut self, events: &mut Vec<Event>, finish: Finish) {
        self.start(events);
        for id in self.reasoning.clone() {
            self.end(events, &id, true, None);
        }
        for id in self.text.clone() {
            self.end(events, &id, false, None);
        }
        events.push(Event::StepFinish {
            index: 0.0,
            finish: finish.clone(),
        });
        events.push(Event::Finish(finish));
        self.started = false;
    }
}
#[derive(Clone)]
pub struct PendingTool {
    pub id: LosslessString,
    pub name: LosslessString,
    pub input: LosslessString,
    pub metadata: Option<JsonValue>,
}
#[derive(Default)]
pub struct Tools(pub Vec<(LosslessString, PendingTool)>);
impl Tools {
    pub fn get(&self, key: &LosslessString) -> Option<&PendingTool> {
        self.0
            .iter()
            .find(|(id, _)| id == key)
            .map(|(_, tool)| tool)
    }
    pub fn start(&mut self, key: LosslessString, tool: PendingTool) {
        if let Some((_, prior)) = self.0.iter_mut().find(|(id, _)| id == &key) {
            *prior = tool;
        } else {
            self.0.push((key, tool));
        }
    }
    pub fn append(
        &mut self,
        key: &LosslessString,
        text: &LosslessString,
    ) -> Result<Vec<Event>, Error> {
        let tool = self
            .0
            .iter_mut()
            .find(|(id, _)| id == key)
            .map(|(_, tool)| tool)
            .ok_or_else(|| Error::output("OpenAI tool argument delta is missing its tool call"))?;
        json::concat(&mut tool.input, text);
        Ok(if text.is_empty() {
            Vec::new()
        } else {
            vec![Event::ToolInputDelta {
                id: tool.id.clone(),
                name: tool.name.clone(),
                text: text.clone(),
            }]
        })
    }
    pub fn finish(
        &mut self,
        key: &LosslessString,
        override_input: Option<LosslessString>,
    ) -> Vec<Event> {
        let Some(index) = self.0.iter().position(|(id, _)| id == key) else {
            return Vec::new();
        };
        let tool = self.0.remove(index).1;
        let raw = override_input.unwrap_or(tool.input);
        match json::parse_tool_input(&raw) {
            Ok(input) => vec![
                Event::ToolInputEnd(ToolInputEvent {
                    id: tool.id.clone(),
                    name: tool.name.clone(),
                    provider_executed: None,
                    provider_metadata: tool.metadata.clone(),
                }),
                Event::ToolCall(ToolCall {
                    id: tool.id,
                    name: tool.name,
                    input,
                    provider_executed: None,
                    provider_metadata: tool.metadata,
                }),
            ],
            Err(_) => vec![Event::ToolInputError {
                id: tool.id,
                name: tool.name,
                raw,
            }],
        }
    }
    pub fn finish_all(&mut self) -> Vec<Event> {
        let keys = json::object(self.0.iter().map(|(id, _)| (id.clone(), JsonValue::Null)));
        let JsonValue::Object(keys) = keys else {
            return Vec::new();
        };
        keys.iter()
            .flat_map(|(id, _)| self.finish(id, None))
            .collect()
    }
}
pub fn wrapped_system(message: &crate::llm::Message, route: &str) -> Result<LosslessString, Error> {
    let parts = message
        .content
        .iter()
        .map(|part| {
            if let crate::llm::Part::Text(part) = part {
                Ok(part.text.clone())
            } else {
                Err(Error::invalid(format!(
                    "{route} system messages only support text content for now"
                )))
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    let text = join(parts, "\n");
    let mut escaped = Vec::new();
    for unit in text.code_units() {
        match unit {
            38 => escaped.extend("&amp;".encode_utf16()),
            60 => escaped.extend("&lt;".encode_utf16()),
            62 => escaped.extend("&gt;".encode_utf16()),
            _ => escaped.push(unit),
        }
    }
    Ok(LosslessString::from_utf16(
        "<system-update>\n"
            .encode_utf16()
            .chain(escaped)
            .chain("\n</system-update>".encode_utf16())
            .collect(),
    ))
}
pub fn validate(
    value: &JsonValue,
    strings: &[&str],
    nullable_strings: &[&str],
    numbers: &[&str],
) -> bool {
    matches!(value, JsonValue::Object(_))
        && strings
            .iter()
            .all(|key| get(value, key).is_none_or(|value| matches!(value, JsonValue::String(_))))
        && nullable_strings.iter().all(|key| {
            get(value, key)
                .is_none_or(|value| matches!(value, JsonValue::String(_) | JsonValue::Null))
        })
        && numbers
            .iter()
            .all(|key| get(value, key).is_none_or(|value| matches!(value, JsonValue::Number(_))))
}
