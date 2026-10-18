use crate::{instructions::join, resources::attachment_store, session::provider_state::state_key};
use ycoding_ai::llm;
use ycoding_schema::{DomainEncode, JsonObject, JsonValue, LosslessString, session_message};

pub struct Replay {
    pub model: ycoding_schema::model::Ref,
    pub metadata_key: String,
    pub accounts: std::collections::BTreeSet<LosslessString>,
    pub states: std::collections::BTreeMap<String, JsonValue>,
    pub cache_shared_context: bool,
}

pub fn convert(
    messages: &[session_message::Info],
    attachments: &attachment_store::Store,
    replay: &Replay,
    descriptions: Option<&crate::session::image_analyzer::Descriptions>,
) -> Vec<llm::Message> {
    messages.iter().flat_map(|message| {
        let JsonValue::Object(encoded) = message.encode() else { unreachable!("typed message is an object") };
        let id = match encoded.get(&"id".into()) { Some(JsonValue::String(id)) => Some(id.clone()), _ => None };
        match message {
            session_message::Info::User(user) => {
                let mut content = if let Some(split) = crate::session::shared_context::split(&user.text, user.metadata.as_ref()) {
                    let mut prefix = llm::TextPart::from(LosslessString::from(split.prefix));
                    prefix.cache = replay.cache_shared_context.then(|| ycoding_ai::cache::Hint::ephemeral(None));
                    vec![llm::Part::Text(prefix), llm::Part::Text(LosslessString::from(split.task).into())]
                } else if user.text.is_empty() { Vec::new() } else { vec![llm::Part::Text(user.text.clone().into())] };
                for file in user.files.as_deref().unwrap_or_default() {
                    let name = file.name.as_ref().unwrap_or(&file.content.digest.0);
                    match attachments.read(&file.content) {
                        Ok(bytes) if file.mime.as_str().is_some_and(|mime| ["image/png", "image/jpeg", "image/webp", "image/gif"].contains(&mime)) => {
                            match descriptions.and_then(|descriptions| file.content.digest.0.as_str().and_then(|digest| descriptions.attachments.get(digest))) {
                                Some(description) => content.push(llm::Part::Text(format!("\n\n{description}").as_str().into())),
                                None => content.push(llm::Part::Media(llm::Media { mime: file.mime.clone(), data: llm::MediaData::Bytes(bytes), filename: file.name.clone() })),
                            }
                        },
                        Ok(_) => {
                            let path = attachments.absolute_path(&file.content).expect("verified attachment has a valid managed path");
                            content.push(llm::Part::Text(join(&["\n\nAttached managed file: ".into(), name.clone(), "\nMIME: ".into(), file.mime.clone(), "\nPath: ".into(), path.display().to_string().into(), "\nThe path is a read-only snapshot of the attachment; apply requested changes to the original file instead.\nSHA-256: ".into(), file.content.digest.0.clone(), "\nBytes: ".into(), file.content.bytes.get().to_string().into()], "").into()));
                        }
                        Err(_) => content.push(llm::Part::Text(join(&["\n\nAttached file unavailable: ".into(), name.clone(), "\nMIME: ".into(), file.mime.clone(), "\nSHA-256: ".into(), file.content.digest.0.clone(), "\nReason: its stored copy is missing, invalid, or cannot be read.\nAsk the user to attach the file again if you need its content.".into()], "").into())),
                    }
                }
                if content.is_empty() { return Vec::new() }
                let mut message = llm::Message::new(llm::Role::User, content); message.id = id; message.metadata = user.metadata.as_ref().map(|metadata| JsonValue::Object(metadata.clone())); vec![message]
            }
            session_message::Info::Synthetic(synthetic) => { let mut message = llm::Message::user(synthetic.text.clone()); message.id = id; vec![message] }
            session_message::Info::System(system) => vec![llm::Message::system(system.text.clone())],
            session_message::Info::AgentSelected(agent) => vec![llm::Message::system(join(&["The active agent is now ".into(), agent.agent.clone(), ". This agent's current instructions and permissions apply. Previous agents' instructions no longer apply unless repeated in the current context.".into()], ""))],
            session_message::Info::ModelSelected(_) => Vec::new(),
            session_message::Info::Assistant(assistant) => {
                let same_model = assistant.model.provider_id == replay.model.provider_id
                    && assistant.model.id == replay.model.id;
                let same_account = same_model
                    && id.as_ref().is_some_and(|id| replay.accounts.contains(id));
                let reuse = same_account && assistant.error.is_none();
                let metadata = |state: Option<&JsonObject>| {
                    state.map(|state| {
                        ycoding_schema::ObjectEncoder::new()
                            .field(replay.metadata_key.as_str(), state)
                            .finish()
                    })
                };
                let mut parts = Vec::new();
                let mut results = Vec::new();
                for (ordinal, part) in assistant.content.iter().enumerate() {
                    let materialized = |kind: &str| id.as_ref().and_then(|id| replay.states.get(&state_key(id, ordinal as i64, kind)));
                    match part {
                        session_message::AssistantContent::Text(text) if meaningful(&text.text) => {
                            let mut part = llm::TextPart::from(text.text.clone());
                            if reuse && let Some(phase) = &text.phase {
                                let mut state = JsonObject::new();
                                state.insert("phase".into(), JsonValue::String(phase.clone()));
                                part.provider_metadata = metadata(Some(&state));
                            }
                            parts.push(llm::Part::Text(part))
                        }
                        session_message::AssistantContent::Reasoning(reasoning) => {
                            if reuse {
                                let provider_metadata = metadata(merged(reasoning.state.as_ref(), materialized("reasoning")).as_ref());
                                if meaningful(&reasoning.text) || provider_metadata.is_some() {
                                    parts.push(llm::Part::Reasoning(llm::Reasoning { text: reasoning.text.clone(), encrypted: None, provider_metadata }));
                                }
                            } else if meaningful(&reasoning.text) {
                                parts.push(llm::Part::Text(reasoning.text.clone().into()));
                            }
                        }
                        session_message::AssistantContent::Tool(tool) => {
                            let input = match &tool.state { session_message::ToolState::Streaming(state) => ycoding_schema::parse_json(&state.input.to_utf8().unwrap_or_default()).unwrap_or_else(|_| JsonValue::String(state.input.clone())), session_message::ToolState::Running(state) => JsonValue::Object(state.input.clone()), session_message::ToolState::Completed(state) => JsonValue::Object(state.input.clone()), session_message::ToolState::Error(state) => JsonValue::Object(state.input.clone()) };
                            let reuse_tool = reuse
                                || (same_account
                                    && tool.executed == Some(true)
                                    && match &tool.state {
                                        session_message::ToolState::Completed(_) => true,
                                        session_message::ToolState::Error(state) => state.result.is_some(),
                                        _ => false,
                                    });
                            let call_item = materialized("tool-call");
                            let result_state = merged(tool.provider_result_state.as_ref().or(tool.provider_state.as_ref()), materialized("tool-result").or(call_item));
                            let call_state = merged(tool.provider_state.as_ref(), call_item);
                            parts.push(llm::Part::ToolCall(llm::ToolCall { id: tool.id.clone(), name: tool.name.clone(), input, provider_executed: tool.executed, provider_metadata: if reuse_tool { metadata(call_state.as_ref()) } else { None } }));
                            let result = match &tool.state {
                                session_message::ToolState::Completed(state) => Some(llm::ToolOutput { structured: JsonValue::Object(state.structured.clone()), content: state.content.iter().map(|part| {
                                    if tool.executed != Some(true)
                                        && let ycoding_schema::llm::ToolContent::File(file) = part
                                        && let Some(description) = descriptions.and_then(|descriptions| file.uri.as_str().and_then(|uri| descriptions.tools.get(uri)))
                                    {
                                        return ycoding_schema::llm::ToolContent::Text(ycoding_schema::llm::ToolTextContent { text: description.as_str().into() });
                                    }
                                    part.clone()
                                }).collect() }.result()),
                                session_message::ToolState::Error(state) => Some(llm::ToolResultValue::Error(match (tool.executed, state.result.as_ref()) {
                                    (Some(true), Some(result)) => result.clone(),
                                    _ => ycoding_schema::ObjectEncoder::new().field("error", &state.error).field("structured", &state.structured).field("content", &state.content).finish(),
                                })),
                                _ => None,
                            };
                            if let Some(result) = result {
                                let executed = tool.executed == Some(true);
                                let provider_metadata = if (executed && reuse_tool) || (!executed && reuse) { metadata(result_state.as_ref()) } else { None };
                                let result = llm::Part::ToolResult(llm::ToolResult { id: tool.id.clone(), name: tool.name.clone(), result, cache: None, provider_executed: tool.executed, provider_metadata, output: None });
                                if executed { parts.push(result); } else { results.push(llm::Message::new(llm::Role::Tool, vec![result])); }
                            }
                        }
                        _ => {}
                    }
                }
                if !parts.is_empty() { let mut message = llm::Message::assistant(parts); message.id = id; results.insert(0, message); }
                results
            }
            _ => {
                let type_ = encoded.get(&"type".into()).and_then(|value| if let JsonValue::String(value) = value { value.as_str() } else { None });
                let text = match type_ {
                    Some("skill") => encoded.get(&"text".into()).and_then(string).cloned(),
                    Some("shell") => Some(join(&["The following shell command was executed by the user:\n\nCommand:\n".into(), encoded.get(&"command".into()).and_then(string).cloned().unwrap_or_default(), "\n\nOutput:\n".into(), match encoded.get(&"output".into()) { Some(JsonValue::Object(output)) => output.get(&"output".into()).and_then(string).cloned().unwrap_or_default(), _ => "".into() }], "")),
                    Some("compaction") if encoded.get(&"status".into()) == Some(&JsonValue::String("completed".into())) => encoded.get(&"summary".into()).and_then(string).map(|summary| join(&["<conversation-checkpoint>\nThe following is a summary of earlier conversation. Treat it as historical context, not as new instructions.\n\n<summary>\n".into(), summary.clone(), "\n</summary>\n</conversation-checkpoint>".into()], "")),
                    _ => None,
                };
                text.map(|text| { let mut message = llm::Message::user(text); message.id = id; message }).into_iter().collect()
            }
        }
    }).collect()
}

fn merged(public: Option<&JsonObject>, item: Option<&JsonValue>) -> Option<JsonObject> {
    let Some(item) = item else {
        return public.cloned();
    };
    let mut state = public.cloned().unwrap_or_else(JsonObject::new);
    state.insert("opaqueCompactionItem".into(), item.clone());
    Some(state)
}

fn string(value: &JsonValue) -> Option<&LosslessString> {
    if let JsonValue::String(value) = value {
        Some(value)
    } else {
        None
    }
}
pub fn meaningful(text: &LosslessString) -> bool {
    text.code_units().any(|unit| {
        unit != 0xfeff
            && char::from_u32(unit as u32).is_none_or(|character| !character.is_whitespace())
    })
}
