use super::{error, publish};
use crate::session::{
    provider_state::Capture,
    run_coordinator::{Error, Outcome},
    store::Service,
};
use std::collections::BTreeMap;
use ycoding_ai::llm;
use ycoding_schema::{
    JsonObject, JsonValue, LosslessString, ObjectEncoder, session, session_message,
};

const OPAQUE_COMPACTION_ITEM: &str = "opaqueCompactionItem";

struct Fragment {
    id: LosslessString,
    ordinal: usize,
    content: usize,
    text: LosslessString,
    state: Option<JsonObject>,
}
struct Tool {
    name: LosslessString,
    raw: LosslessString,
    ordinal: usize,
    input_open: bool,
    called: bool,
    settled: bool,
    provider: bool,
}

pub struct Publisher {
    pub store: Service,
    events: crate::event_feed::Feed,
    location: ycoding_schema::location::Ref,
    pub session: session::Id,
    pub assistant: session_message::Id,
    pub metadata_key: String,
    text: Option<Fragment>,
    reasoning: Option<Fragment>,
    text_ordinal: usize,
    reasoning_ordinal: usize,
    next_content: usize,
    tools: BTreeMap<LosslessString, Tool>,
    pub captures: Vec<Capture>,
    pub settlement: Option<llm::Finish>,
    pub evidence: bool,
    pub assistant_text: bool,
    pub continuation: bool,
}

impl Publisher {
    pub fn new(
        store: Service,
        events: crate::event_feed::Feed,
        location: ycoding_schema::location::Ref,
        session: session::Id,
        assistant: session_message::Id,
        metadata_key: String,
    ) -> Self {
        Self {
            store,
            events,
            location,
            session,
            assistant,
            metadata_key,
            text: None,
            reasoning: None,
            text_ordinal: 0,
            reasoning_ordinal: 0,
            next_content: 0,
            tools: BTreeMap::new(),
            captures: Vec::new(),
            settlement: None,
            evidence: false,
            assistant_text: false,
            continuation: false,
        }
    }
    pub async fn event(&self, kind: &str, fields: JsonValue, now: i64) -> Outcome {
        publish(
            &self.store,
            &self.session,
            Some(&self.assistant),
            kind,
            fields,
            now,
        )
        .await
    }
    pub async fn push(
        &mut self,
        event: llm::Event,
        now: i64,
    ) -> Result<Option<llm::ToolCall>, Error> {
        match event {
            llm::Event::StepStart { index } => {
                if index != 0.0 {
                    return Err(error(
                        "provider.invalid-output",
                        "Provider emitted more than one step in an attempt",
                    ));
                }
            }
            llm::Event::TextStart(block) => {
                if self.text.is_some() {
                    return Err(error(
                        "provider.invalid-output",
                        "Duplicate or overlapping text start",
                    ));
                }
                let ordinal = self.text_ordinal;
                self.text_ordinal += 1;
                let content = self.next_content;
                self.next_content += 1;
                self.text = Some(Fragment {
                    state: state(&self.metadata_key, block.provider_metadata.as_ref()),
                    id: block.id,
                    ordinal,
                    content,
                    text: "".into(),
                });
                self.event(
                    "session.text.started",
                    ObjectEncoder::new()
                        .field("ordinal", &(ordinal as f64))
                        .finish(),
                    now,
                )
                .await?;
            }
            llm::Event::TextDelta(delta) => {
                let Some(fragment) = self
                    .text
                    .as_mut()
                    .filter(|fragment| fragment.id == delta.id)
                else {
                    return Err(error(
                        "provider.invalid-output",
                        "Text delta before matching start",
                    ));
                };
                let ordinal = fragment.ordinal;
                fragment.text =
                    crate::instructions::join(&[fragment.text.clone(), delta.text.clone()], "");
                merge(
                    &mut fragment.state,
                    state(&self.metadata_key, delta.provider_metadata.as_ref()),
                );
                self.evidence |= super::messages::meaningful(&fragment.text);
                self.events
                    .emit(
                        crate::event_feed::Data::SessionTextDelta(Box::new(
                            crate::event_feed::ephemeral::Fragment {
                                session_id: self.session.clone(),
                                assistant_message_id: self.assistant.clone(),
                                ordinal: ycoding_schema::schema::NonNegativeInt::new(
                                    ordinal as i64,
                                )
                                .map_err(|_| error("stream", "Invalid text ordinal"))?,
                                delta: delta.text,
                            },
                        )),
                        Some(self.location.clone()),
                    )
                    .map_err(|message| error("stream", &message))?;
            }
            llm::Event::TextEnd(block) => {
                if let Some(fragment) = self
                    .text
                    .as_mut()
                    .filter(|fragment| fragment.id == block.id)
                {
                    merge(
                        &mut fragment.state,
                        state(&self.metadata_key, block.provider_metadata.as_ref()),
                    );
                }
                self.end_text(Some(&block.id), now).await?
            }
            llm::Event::ReasoningStart(block) => {
                if self.reasoning.is_some() {
                    return Err(error(
                        "provider.invalid-output",
                        "Duplicate or overlapping reasoning start",
                    ));
                }
                let ordinal = self.reasoning_ordinal;
                self.reasoning_ordinal += 1;
                let content = self.next_content;
                self.next_content += 1;
                self.reasoning = Some(Fragment {
                    state: self.captured(block.provider_metadata.as_ref(), content, "reasoning"),
                    id: block.id,
                    ordinal,
                    content,
                    text: "".into(),
                });
                self.event(
                    "session.reasoning.started",
                    ObjectEncoder::new()
                        .field("ordinal", &(ordinal as f64))
                        .finish(),
                    now,
                )
                .await?;
            }
            llm::Event::ReasoningDelta(delta) => {
                let Some(content) = self
                    .reasoning
                    .as_ref()
                    .filter(|fragment| fragment.id == delta.id)
                    .map(|fragment| fragment.content)
                else {
                    return Err(error(
                        "provider.invalid-output",
                        "Reasoning delta before matching start",
                    ));
                };
                let next = self.captured(delta.provider_metadata.as_ref(), content, "reasoning");
                if let Some(fragment) = self.reasoning.as_mut() {
                    let ordinal = fragment.ordinal;
                    fragment.text =
                        crate::instructions::join(&[fragment.text.clone(), delta.text.clone()], "");
                    merge(&mut fragment.state, next);
                    self.evidence |= super::messages::meaningful(&fragment.text);
                    self.events
                        .emit(
                            crate::event_feed::Data::SessionReasoningDelta(Box::new(
                                crate::event_feed::ephemeral::Fragment {
                                    session_id: self.session.clone(),
                                    assistant_message_id: self.assistant.clone(),
                                    ordinal: ycoding_schema::schema::NonNegativeInt::new(
                                        ordinal as i64,
                                    )
                                    .map_err(|_| error("stream", "Invalid reasoning ordinal"))?,
                                    delta: delta.text,
                                },
                            )),
                            Some(self.location.clone()),
                        )
                        .map_err(|message| error("stream", &message))?;
                }
            }
            llm::Event::ReasoningEnd(block) => {
                let content = self
                    .reasoning
                    .as_ref()
                    .filter(|fragment| fragment.id == block.id)
                    .map(|fragment| fragment.content);
                if let Some(content) = content {
                    let next =
                        self.captured(block.provider_metadata.as_ref(), content, "reasoning");
                    if let Some(fragment) = self.reasoning.as_mut() {
                        merge(&mut fragment.state, next);
                    }
                }
                self.end_reasoning(Some(&block.id), now).await?
            }
            llm::Event::ToolInputStart(input) => {
                self.start_tool(
                    &input.id,
                    &input.name,
                    input.provider_executed == Some(true),
                    now,
                )
                .await?
            }
            llm::Event::ToolInputDelta { id, name, text } => {
                let Some(tool) = self
                    .tools
                    .get_mut(&id)
                    .filter(|tool| tool.name == name && tool.input_open)
                else {
                    return Err(error(
                        "provider.invalid-output",
                        "Tool input delta before matching start",
                    ));
                };
                tool.raw = crate::instructions::join(&[tool.raw.clone(), text.clone()], "");
                self.events
                    .emit(
                        crate::event_feed::Data::SessionToolInputDelta(Box::new(
                            crate::event_feed::ephemeral::ToolFragment {
                                session_id: self.session.clone(),
                                assistant_message_id: self.assistant.clone(),
                                call_id: id,
                                delta: text,
                            },
                        )),
                        Some(self.location.clone()),
                    )
                    .map_err(|message| error("stream", &message))?;
            }
            llm::Event::ToolInputEnd(input) => {
                self.end_tool(&input.id, &input.name, None, now).await?
            }
            llm::Event::ToolInputError { id, name, raw } => {
                if !self.tools.contains_key(&id) {
                    self.start_tool(&id, &name, false, now).await?;
                }
                if self.tools.get(&id).is_some_and(|tool| tool.input_open) {
                    self.end_tool(&id, &name, Some(raw), now).await?;
                }
                self.tools
                    .get_mut(&id)
                    .expect("started tool exists")
                    .settled = true;
                self.continuation = true;
                self.event("session.tool.failed", ObjectEncoder::new().field("callID", &id).field("executed", &false).field("error", &ycoding_schema::session_error::Error { r#type: "tool.input-json".into(), message: "Tool call arguments were malformed JSON and were not executed. Retry with valid JSON.".into() }).finish(), now).await?;
            }
            llm::Event::ToolCall(call) => {
                if !self.tools.contains_key(&call.id) {
                    self.start_tool(
                        &call.id,
                        &call.name,
                        call.provider_executed == Some(true),
                        now,
                    )
                    .await?;
                }
                if self.tools.get(&call.id).is_some_and(|tool| tool.input_open) {
                    self.end_tool(
                        &call.id,
                        &call.name,
                        Some(ycoding_schema::stringify_json(&call.input).into()),
                        now,
                    )
                    .await?;
                }
                let tool = self.tools.get_mut(&call.id).expect("started tool exists");
                if tool.called || tool.settled || tool.name != call.name {
                    return Err(error(
                        "provider.invalid-output",
                        "Duplicate or mismatched tool call",
                    ));
                }
                tool.called = true;
                tool.provider |= call.provider_executed == Some(true);
                let provider = tool.provider;
                let ordinal = tool.ordinal;
                self.evidence = true;
                let call_state =
                    self.captured(call.provider_metadata.as_ref(), ordinal, "tool-call");
                self.event(
                    "session.tool.called",
                    ObjectEncoder::new()
                        .field("callID", &call.id)
                        .field("input", &call.input)
                        .field("executed", &provider)
                        .optional("state", &call_state)
                        .finish(),
                    now,
                )
                .await?;
                if !provider {
                    self.continuation = true;
                    return Ok(Some(call));
                }
            }
            llm::Event::ToolResult(result) => {
                let Some(tool) = self
                    .tools
                    .get_mut(&result.id)
                    .filter(|tool| tool.called && !tool.settled && tool.provider)
                else {
                    return Err(error(
                        "provider.invalid-output",
                        "Provider tool result without an unsettled call",
                    ));
                };
                tool.settled = true;
                let ordinal = tool.ordinal;
                let result_state =
                    self.captured(result.provider_metadata.as_ref(), ordinal, "tool-result");
                let output = result
                    .output
                    .or_else(|| llm::ToolOutput::from_result(&result.result))
                    .ok_or_else(|| {
                        error(
                            "provider.invalid-output",
                            "Provider tool result has no output",
                        )
                    })?;
                let JsonValue::Object(structured) = output.structured else {
                    return Err(error(
                        "provider.invalid-output",
                        "Provider structured tool output is not an object",
                    ));
                };
                self.event(
                    "session.tool.success",
                    ObjectEncoder::new()
                        .field("callID", &result.id)
                        .field("executed", &true)
                        .field("structured", &structured)
                        .field("content", &output.content)
                        .field("result", &result.result.to_json())
                        .optional("resultState", &result_state)
                        .finish(),
                    now,
                )
                .await?;
            }
            llm::Event::ToolError { id, message, .. } => {
                let Some(tool) = self
                    .tools
                    .get_mut(&id)
                    .filter(|tool| tool.called && !tool.settled)
                else {
                    return Err(error(
                        "provider.invalid-output",
                        "Provider tool error without an unsettled call",
                    ));
                };
                tool.settled = true;
                self.event(
                    "session.tool.failed",
                    ObjectEncoder::new()
                        .field("callID", &id)
                        .field("executed", &true)
                        .field(
                            "error",
                            &ycoding_schema::session_error::Error {
                                r#type: "tool.execution".into(),
                                message,
                            },
                        )
                        .finish(),
                    now,
                )
                .await?;
            }
            llm::Event::StepFinish { index, finish } => {
                if index != 0.0 || self.settlement.is_some() {
                    return Err(error(
                        "provider.invalid-output",
                        "Duplicate or malformed provider step settlement",
                    ));
                }
                self.flush(now).await?;
                self.settlement = Some(finish);
            }
            llm::Event::Finish(_) => {}
            llm::Event::ProviderError {
                message,
                context_overflow,
                ..
            } => {
                return Err(error(
                    if context_overflow {
                        "context.limit"
                    } else {
                        "provider.invalid-output"
                    },
                    &message
                        .to_utf8()
                        .unwrap_or_else(|_| "Provider failed".into()),
                ));
            }
        }
        Ok(None)
    }
    async fn start_tool(
        &mut self,
        id: &LosslessString,
        name: &LosslessString,
        provider: bool,
        now: i64,
    ) -> Outcome {
        self.evidence = true;
        if self.tools.contains_key(id) {
            return Err(error(
                "provider.invalid-output",
                "Duplicate tool input start",
            ));
        }
        let ordinal = self.next_content;
        self.next_content += 1;
        self.tools.insert(
            id.clone(),
            Tool {
                name: name.clone(),
                raw: "".into(),
                ordinal,
                input_open: true,
                called: false,
                settled: false,
                provider,
            },
        );
        self.event(
            "session.tool.input.started",
            ObjectEncoder::new()
                .field("callID", id)
                .field("name", name)
                .finish(),
            now,
        )
        .await
    }
    async fn end_tool(
        &mut self,
        id: &LosslessString,
        name: &LosslessString,
        text: Option<LosslessString>,
        now: i64,
    ) -> Outcome {
        let Some(tool) = self
            .tools
            .get_mut(id)
            .filter(|tool| tool.input_open && &tool.name == name)
        else {
            return Err(error(
                "provider.invalid-output",
                "Tool input end before matching start",
            ));
        };
        tool.input_open = false;
        let text = text.unwrap_or_else(|| tool.raw.clone());
        self.event(
            "session.tool.input.ended",
            ObjectEncoder::new()
                .field("callID", id)
                .field("text", &text)
                .finish(),
            now,
        )
        .await
    }
    async fn end_text(&mut self, id: Option<&LosslessString>, now: i64) -> Outcome {
        let Some(fragment) = self.text.take() else {
            if id.is_none() {
                return Ok(());
            }
            return Err(error("provider.invalid-output", "Text end before start"));
        };
        if id.is_some_and(|id| *id != fragment.id) {
            return Err(error(
                "provider.invalid-output",
                "Text end identity changed",
            ));
        }
        self.assistant_text |= fragment.text.code_units().any(|unit| {
            char::from_u32(unit as u32).is_none_or(|character| !character.is_whitespace())
        });
        self.event(
            "session.text.ended",
            ObjectEncoder::new()
                .field("ordinal", &(fragment.ordinal as f64))
                .field("text", &fragment.text)
                .optional("phase", &phase(fragment.state.as_ref()))
                .finish(),
            now,
        )
        .await
    }
    async fn end_reasoning(&mut self, id: Option<&LosslessString>, now: i64) -> Outcome {
        let Some(fragment) = self.reasoning.take() else {
            if id.is_none() {
                return Ok(());
            }
            return Err(error(
                "provider.invalid-output",
                "Reasoning end before start",
            ));
        };
        if id.is_some_and(|id| *id != fragment.id) {
            return Err(error(
                "provider.invalid-output",
                "Reasoning end identity changed",
            ));
        }
        self.event(
            "session.reasoning.ended",
            ObjectEncoder::new()
                .field("ordinal", &(fragment.ordinal as f64))
                .field("text", &fragment.text)
                .optional("state", &fragment.state)
                .finish(),
            now,
        )
        .await
    }
    pub async fn flush(&mut self, now: i64) -> Outcome {
        self.end_text(None, now).await?;
        self.end_reasoning(None, now).await?;
        let open = self
            .tools
            .iter()
            .filter(|(_, tool)| tool.input_open)
            .map(|(id, tool)| (id.clone(), tool.name.clone()))
            .collect::<Vec<_>>();
        for (id, name) in open {
            self.end_tool(&id, &name, None, now).await?;
        }
        Ok(())
    }
    fn captured(
        &mut self,
        metadata: Option<&JsonValue>,
        ordinal: usize,
        kind: &'static str,
    ) -> Option<JsonObject> {
        let raw = raw_state(&self.metadata_key, metadata)?;
        if let Some(item) = raw.get(&OPAQUE_COMPACTION_ITEM.into()) {
            self.captures.push(Capture {
                message: self.assistant.clone(),
                ordinal,
                kind,
                item: item.clone(),
            });
        }
        redacted(raw)
    }
}

fn state(key: &str, metadata: Option<&JsonValue>) -> Option<JsonObject> {
    redacted(raw_state(key, metadata)?)
}
fn raw_state<'a>(key: &str, metadata: Option<&'a JsonValue>) -> Option<&'a JsonObject> {
    let JsonValue::Object(metadata) = metadata? else {
        return None;
    };
    let JsonValue::Object(state) = metadata.get(&key.into())? else {
        return None;
    };
    Some(state)
}
fn redacted(state: &JsonObject) -> Option<JsonObject> {
    let mut public = JsonObject::new();
    for (name, value) in state
        .iter()
        .filter(|(name, _)| name.as_str() != Some(OPAQUE_COMPACTION_ITEM))
    {
        public.insert(name.clone(), value.clone());
    }
    let populated = public.iter().next().is_some();
    populated.then_some(public)
}
fn merge(current: &mut Option<JsonObject>, next: Option<JsonObject>) {
    let Some(next) = next else { return };
    let merged = current.get_or_insert_with(JsonObject::new);
    for (name, value) in next.iter() {
        merged.insert(name.clone(), value.clone());
    }
}
fn phase(state: Option<&JsonObject>) -> Option<LosslessString> {
    match state?.get(&"phase".into())? {
        JsonValue::String(phase)
            if matches!(phase.as_str(), Some("commentary" | "final_answer")) =>
        {
            Some(phase.clone())
        }
        _ => None,
    }
}
