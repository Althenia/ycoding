use super::{Error, Extension, families, v5};
use crate::tools::context::Context;
use std::{
    collections::BTreeSet,
    sync::{LazyLock, atomic::Ordering},
};
use ycoding_ai::{
    cache::{Hint, HintType},
    llm,
};
use ycoding_schema::{JsonPath, JsonValue, LosslessString, ObjectDecoder, ObjectEncoder, model};
static PATH: LazyLock<JsonPath> = LazyLock::new(JsonPath::default);

pub async fn prepare(
    request: &llm::Request,
    model: &model::Ref,
    route_id: Option<&str>,
    context: &Context,
    extensions: &[&Extension],
) -> Result<llm::Request, Error> {
    if request.model.provider != model.provider_id {
        return Err(Error::Unauthorized);
    }
    let mut output = request.clone();
    let mut extensions = extensions
        .iter()
        .copied()
        .filter(|extension| extension.shared.accepting.load(Ordering::Acquire))
        .collect::<Vec<_>>();
    extensions.sort_by_key(|extension| extension.order);
    for phase in [
        v5::TransformStage::ToolDefinitions,
        v5::TransformStage::SessionContext,
    ] {
        let advertised = output.tools.clone();
        for extension in &extensions {
            for registration in &extension.declarations {
                let stage = v5::TransformStage::try_from(registration.stage)
                    .map_err(|_| Error::Protocol)?;
                if stage != phase {
                    continue;
                }
                if stage == v5::TransformStage::ToolDefinitions {
                    let draft = ObjectEncoder::new()
                        .field("items", &output.tools.iter().map(tool).collect::<Vec<_>>())
                        .finish();
                    let response = extension
                        .shared
                        .transform(registration, context, 0, draft)
                        .await?;
                    let items: Vec<JsonValue> = decoder(&response)?
                        .field("items")
                        .map_err(|_| Error::Schema)?;
                    let next = items.iter().map(read_tool).collect::<Result<Vec<_>, _>>()?;
                    if next.len() != output.tools.len()
                        || next
                            .iter()
                            .zip(&output.tools)
                            .any(|(next, old)| !same_tool_owner(next, old))
                    {
                        return Err(Error::Unauthorized);
                    }
                    output.tools = next;
                    continue;
                }
                if stage != v5::TransformStage::SessionContext {
                    continue;
                }
                let draft = ObjectEncoder::new()
                    .field("sessionID", &context.session_id)
                    .field("agent", &context.agent)
                    .field("model", model)
                    .optional("routeID", &route_id.map(LosslessString::from))
                    .field(
                        "system",
                        &output.system.iter().map(text).collect::<Vec<_>>(),
                    )
                    .field(
                        "messages",
                        &output
                            .messages
                            .iter()
                            .enumerate()
                            .map(|(origin, value)| message(origin, value))
                            .collect::<Vec<_>>(),
                    )
                    .field("tools", &output.tools.iter().map(tool).collect::<Vec<_>>())
                    .finish();
                let response = extension
                    .shared
                    .transform(registration, context, 0, draft.clone())
                    .await;
                let response = match response {
                    Ok(response) => response,
                    Err(
                        Error::UnknownOutcome
                        | Error::Protocol
                        | Error::Stopped
                        | Error::ExecutionFailed,
                    ) => {
                        output.messages.push(llm::Message::user(
                            "Session context hook failed; its changes may be incomplete.",
                        ));
                        continue;
                    }
                    Err(error) => return Err(error),
                };
                let next = decoder(&response)?;
                let old = decoder(&draft)?;
                for field in ["sessionID", "agent", "model"] {
                    if next.field::<JsonValue>(field).map_err(|_| Error::Schema)?
                        != old.field::<JsonValue>(field).map_err(|_| Error::Schema)?
                    {
                        return Err(Error::Unauthorized);
                    }
                }
                if next
                    .optional::<JsonValue>("routeID")
                    .map_err(|_| Error::Schema)?
                    != old
                        .optional::<JsonValue>("routeID")
                        .map_err(|_| Error::Schema)?
                {
                    return Err(Error::Unauthorized);
                }
                let system = next
                    .field::<Vec<JsonValue>>("system")
                    .map_err(|_| Error::Schema)?
                    .iter()
                    .map(read_text)
                    .collect::<Result<Vec<_>, _>>()?;
                let message_values = next
                    .field::<Vec<JsonValue>>("messages")
                    .map_err(|_| Error::Schema)?;
                let messages = message_values
                    .iter()
                    .map(read_message)
                    .collect::<Result<Vec<_>, _>>()?;
                let tools = next
                    .field::<Vec<JsonValue>>("tools")
                    .map_err(|_| Error::Schema)?;
                let mut origins = BTreeSet::new();
                for (message, value) in messages.iter().zip(&message_values) {
                    let origin: f64 = decoder(value)?
                        .field("origin")
                        .map_err(|_| Error::Unauthorized)?;
                    if !origin.is_finite()
                        || origin < 0.
                        || origin.fract() != 0.
                        || origin >= output.messages.len() as f64
                        || !origins.insert(origin as usize)
                    {
                        return Err(Error::Unauthorized);
                    }
                    let original = &output.messages[origin as usize];
                    if original.id != message.id
                        || original.role != message.role
                        || original.volatile != message.volatile
                        || original.metadata != message.metadata
                        || original.native != message.native
                    {
                        return Err(Error::Unauthorized);
                    }
                }
                let mut names = BTreeSet::new();
                let tools = tools
                    .iter()
                    .filter_map(|value| {
                        let next = match decoder(value).and_then(|value| {
                            value
                                .field::<LosslessString>("name")
                                .map_err(|_| Error::Schema)
                        }) {
                            Ok(name) => name,
                            Err(error) => return Some(Err(error)),
                        };
                        let old = advertised.iter().find(|old| old.name == next)?;
                        if !names.insert(next) {
                            return None;
                        }
                        Some(read_tool(value).map(|next| {
                            let mut tool = old.clone();
                            tool.description = next.description;
                            tool.input_schema = next.input_schema;
                            tool
                        }))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                output.system = system;
                output.messages = messages;
                output.tools = tools;
            }
        }
    }
    Ok(output)
}
fn same_tool_owner(next: &llm::ToolDefinition, old: &llm::ToolDefinition) -> bool {
    next.name == old.name
        && next.output_schema == old.output_schema
        && next.cache == old.cache
        && next.metadata == old.metadata
        && next.native == old.native
}
fn decoder(value: &JsonValue) -> Result<ObjectDecoder<'_>, Error> {
    ObjectDecoder::new(value, &PATH).map_err(|_| Error::Schema)
}
fn hint(value: &Hint) -> JsonValue {
    ObjectEncoder::new()
        .field(
            "type",
            match value.kind {
                HintType::Ephemeral => "ephemeral",
                HintType::Persistent => "persistent",
            },
        )
        .optional("ttl", &value.ttl_seconds)
        .finish()
}
fn read_hint(value: JsonValue) -> Result<Hint, Error> {
    let value = decoder(&value)?;
    Ok(Hint {
        kind: match value
            .tag("type", &["ephemeral", "persistent"])
            .map_err(|_| Error::Schema)?
            .as_str()
        {
            Some("ephemeral") => HintType::Ephemeral,
            _ => HintType::Persistent,
        },
        ttl_seconds: value.optional("ttl").map_err(|_| Error::Schema)?,
    })
}
fn text(value: &llm::TextPart) -> JsonValue {
    ObjectEncoder::new()
        .field("text", &value.text)
        .optional("cache", &value.cache.as_ref().map(hint))
        .optional("metadata", &value.metadata)
        .optional("providerMetadata", &value.provider_metadata)
        .finish()
}
fn read_text(value: &JsonValue) -> Result<llm::TextPart, Error> {
    let value = decoder(value)?;
    Ok(llm::TextPart {
        text: value.field("text").map_err(|_| Error::Schema)?,
        cache: value
            .optional::<JsonValue>("cache")
            .map_err(|_| Error::Schema)?
            .map(read_hint)
            .transpose()?,
        metadata: value.optional("metadata").map_err(|_| Error::Schema)?,
        provider_metadata: value
            .optional("providerMetadata")
            .map_err(|_| Error::Schema)?,
    })
}
fn tool(value: &llm::ToolDefinition) -> JsonValue {
    ObjectEncoder::new()
        .field("name", &value.name)
        .field("description", &value.description)
        .field("input", &value.input_schema)
        .optional("output", &value.output_schema)
        .optional("cache", &value.cache.as_ref().map(hint))
        .optional("metadata", &value.metadata)
        .optional("native", &value.native)
        .finish()
}
fn read_tool(value: &JsonValue) -> Result<llm::ToolDefinition, Error> {
    let value = decoder(value)?;
    let input = value.field("input").map_err(|_| Error::Schema)?;
    if !matches!(input, JsonValue::Object(_) | JsonValue::Bool(_)) {
        return Err(Error::Schema);
    }
    let output = value
        .optional::<JsonValue>("output")
        .map_err(|_| Error::Schema)?;
    Ok(llm::ToolDefinition {
        name: value.field("name").map_err(|_| Error::Schema)?,
        description: value.field("description").map_err(|_| Error::Schema)?,
        input_schema: input,
        output_schema: output,
        cache: value
            .optional::<JsonValue>("cache")
            .map_err(|_| Error::Schema)?
            .map(read_hint)
            .transpose()?,
        metadata: value.optional("metadata").map_err(|_| Error::Schema)?,
        native: value.optional("native").map_err(|_| Error::Schema)?,
    })
}
fn message(origin: usize, value: &llm::Message) -> JsonValue {
    ObjectEncoder::new()
        .field("origin", &(origin as f64))
        .optional("id", &value.id)
        .field(
            "role",
            match value.role {
                llm::Role::User => "user",
                llm::Role::Assistant => "assistant",
                llm::Role::System => "system",
                llm::Role::Tool => "tool",
            },
        )
        .field(
            "content",
            &value.content.iter().map(part).collect::<Vec<_>>(),
        )
        .field("volatile", &value.volatile)
        .optional("metadata", &value.metadata)
        .optional("native", &value.native)
        .finish()
}
fn read_message(value: &JsonValue) -> Result<llm::Message, Error> {
    let value = decoder(value)?;
    Ok(llm::Message {
        id: value.optional("id").map_err(|_| Error::Schema)?,
        role: match value
            .tag("role", &["user", "assistant", "system", "tool"])
            .map_err(|_| Error::Schema)?
            .as_str()
        {
            Some("user") => llm::Role::User,
            Some("assistant") => llm::Role::Assistant,
            Some("system") => llm::Role::System,
            _ => llm::Role::Tool,
        },
        content: value
            .field::<Vec<JsonValue>>("content")
            .map_err(|_| Error::Schema)?
            .iter()
            .map(read_part)
            .collect::<Result<Vec<_>, _>>()?,
        volatile: value.field("volatile").map_err(|_| Error::Schema)?,
        metadata: value.optional("metadata").map_err(|_| Error::Schema)?,
        native: value.optional("native").map_err(|_| Error::Schema)?,
    })
}
fn part(value: &llm::Part) -> JsonValue {
    let (kind, value) = match value {
        llm::Part::Text(value) => ("text", text(value)),
        llm::Part::Media(value) => (
            "media",
            ObjectEncoder::new()
                .field("mime", &value.mime)
                .field(
                    "data",
                    &match &value.data {
                        llm::MediaData::Encoded(value) => value.clone(),
                        llm::MediaData::Bytes(value) => {
                            crate::resources::mcp::skills::encode_base64(value, false).into()
                        }
                    },
                )
                .field("bytes", &matches!(value.data, llm::MediaData::Bytes(_)))
                .optional("filename", &value.filename)
                .finish(),
        ),
        llm::Part::Reasoning(value) => (
            "reasoning",
            ObjectEncoder::new()
                .field("text", &value.text)
                .optional("encrypted", &value.encrypted)
                .optional("providerMetadata", &value.provider_metadata)
                .finish(),
        ),
        llm::Part::ToolCall(value) => (
            "tool-call",
            ObjectEncoder::new()
                .field("id", &value.id)
                .field("name", &value.name)
                .field("input", &value.input)
                .optional("providerExecuted", &value.provider_executed)
                .optional("providerMetadata", &value.provider_metadata)
                .finish(),
        ),
        llm::Part::ToolResult(value) => (
            "tool-result",
            ObjectEncoder::new()
                .field("id", &value.id)
                .field("name", &value.name)
                .field("result", &families::result_value(&value.result))
                .optional("cache", &value.cache.as_ref().map(hint))
                .optional("providerExecuted", &value.provider_executed)
                .optional("providerMetadata", &value.provider_metadata)
                .optional("output", &value.output.as_ref().map(families::output_value))
                .finish(),
        ),
    };
    ObjectEncoder::new()
        .field("type", kind)
        .field("value", &value)
        .finish()
}
fn read_part(value: &JsonValue) -> Result<llm::Part, Error> {
    let root = decoder(value)?;
    let value: JsonValue = root.field("value").map_err(|_| Error::Schema)?;
    let fields = decoder(&value)?;
    Ok(
        match root
            .tag(
                "type",
                &["text", "media", "reasoning", "tool-call", "tool-result"],
            )
            .map_err(|_| Error::Schema)?
            .as_str()
        {
            Some("text") => llm::Part::Text(read_text(&value)?),
            Some("media") => {
                let data: LosslessString = fields.field("data").map_err(|_| Error::Schema)?;
                llm::Part::Media(llm::Media {
                    mime: fields.field("mime").map_err(|_| Error::Schema)?,
                    data: if fields.field::<bool>("bytes").map_err(|_| Error::Schema)? {
                        let bytes = crate::resources::mcp::skills::decode_base64(
                            data.as_str().ok_or(Error::Schema)?,
                        );
                        if crate::resources::mcp::skills::encode_base64(&bytes, false).as_str()
                            != data.as_str().ok_or(Error::Schema)?
                        {
                            return Err(Error::Schema);
                        }
                        llm::MediaData::Bytes(bytes)
                    } else {
                        llm::MediaData::Encoded(data)
                    },
                    filename: fields.optional("filename").map_err(|_| Error::Schema)?,
                })
            }
            Some("reasoning") => llm::Part::Reasoning(llm::Reasoning {
                text: fields.field("text").map_err(|_| Error::Schema)?,
                encrypted: fields.optional("encrypted").map_err(|_| Error::Schema)?,
                provider_metadata: fields
                    .optional("providerMetadata")
                    .map_err(|_| Error::Schema)?,
            }),
            Some("tool-call") => llm::Part::ToolCall(llm::ToolCall {
                id: fields.field("id").map_err(|_| Error::Schema)?,
                name: fields.field("name").map_err(|_| Error::Schema)?,
                input: fields.field("input").map_err(|_| Error::Schema)?,
                provider_executed: fields
                    .optional("providerExecuted")
                    .map_err(|_| Error::Schema)?,
                provider_metadata: fields
                    .optional("providerMetadata")
                    .map_err(|_| Error::Schema)?,
            }),
            Some("tool-result") => llm::Part::ToolResult(llm::ToolResult {
                id: fields.field("id").map_err(|_| Error::Schema)?,
                name: fields.field("name").map_err(|_| Error::Schema)?,
                result: families::read_result(fields.field("result").map_err(|_| Error::Schema)?)?,
                cache: fields
                    .optional::<JsonValue>("cache")
                    .map_err(|_| Error::Schema)?
                    .map(read_hint)
                    .transpose()?,
                provider_executed: fields
                    .optional("providerExecuted")
                    .map_err(|_| Error::Schema)?,
                provider_metadata: fields
                    .optional("providerMetadata")
                    .map_err(|_| Error::Schema)?,
                output: fields
                    .optional::<JsonValue>("output")
                    .map_err(|_| Error::Schema)?
                    .map(families::read_output)
                    .transpose()?,
            }),
            _ => return Err(Error::Schema),
        },
    )
}
