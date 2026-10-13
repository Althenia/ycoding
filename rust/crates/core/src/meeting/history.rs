use super::store::{MeetingDatabase, from_store, to_store};
use crate::tools::registry::{
    DynamicTool, Failure, Options, Registration, RegistrationError, Registry, Tool,
};
use serde_json::{Value, json};
use std::sync::Arc;
use ycoding_ai::llm::ToolOutput;
use ycoding_schema::JsonValue;
use ycoding_schema::llm::{ToolContent, ToolTextContent};

pub const NAME: &str = "meeting_history";
const DESCRIPTION: &str = "Read retained local meeting history, finalized transcript evidence, findings and summaries. No capture, model download, approval, source-code edit, or knowledge-write capability.";
const LIST_LIMIT: u64 = 20;
const SEGMENT_LIMIT: u64 = 100;

pub fn register(
    registry: &Registry,
    database: MeetingDatabase,
) -> Result<Registration, RegistrationError> {
    registry.register(vec![(NAME.into(), tool(database))], Options::direct())
}

pub fn tool(database: MeetingDatabase) -> Arc<dyn Tool> {
    Arc::new(DynamicTool::new(
        DESCRIPTION,
        input_schema(),
        None,
        None,
        move |input, _| {
            let database = database.clone();
            Box::pin(async move {
                let output = history(&database, input).map_err(Failure::message)?;
                let text = output.to_string();
                Ok(ToolOutput {
                    structured: to_store(&output).map_err(|error| Failure::message(error.0))?,
                    content: vec![ToolContent::Text(ToolTextContent { text: text.into() })],
                })
            })
        },
    ))
}

fn input_schema() -> JsonValue {
    to_store(&json!({
        "type": "object",
        "properties": {
            "query": { "type": "string", "maxLength": 200 },
            "meetingID": { "type": "string", "maxLength": 200 },
            "after": { "type": "integer", "minimum": 0 },
        },
        "additionalProperties": false,
    }))
    .unwrap_or(JsonValue::Null)
}

fn history(database: &MeetingDatabase, input: JsonValue) -> Result<Value, String> {
    let input = from_store(&input).map_err(|error| error.0)?;
    let map = input
        .as_object()
        .ok_or("Invalid tool input: expected an object")?;
    if map
        .keys()
        .any(|key| !["query", "meetingID", "after"].contains(&key.as_str()))
    {
        return Err("Invalid tool input: unexpected field".into());
    }
    let text = |key: &str| -> Result<Option<&str>, String> {
        match map.get(key) {
            None => Ok(None),
            Some(Value::String(text)) if text.encode_utf16().count() <= 200 => Ok(Some(text)),
            Some(_) => Err(format!("Invalid tool input: {key}")),
        }
    };
    let query = text("query")?;
    let meeting = text("meetingID")?;
    let after = match map.get("after") {
        None => -1,
        Some(value) => value
            .as_u64()
            .filter(|after| *after <= 9_007_199_254_740_991)
            .map(|after| after as i64)
            .ok_or("Invalid tool input: after")?,
    };
    let fail = |error: super::store::StoreError| error.0;
    let Some(id) = meeting else {
        return Ok(json!(
            database
                .list_meetings(query.unwrap_or(""), LIST_LIMIT)
                .map_err(fail)?
        ));
    };
    let mut output = json!({
        "segments": database.segments(id, after, SEGMENT_LIMIT).map_err(fail)?,
        "findings": database.findings(id).map_err(fail)?,
        "proposals": database.proposals(id).map_err(fail)?,
    });
    if let Some(meeting) = database.get_meeting(id).map_err(fail)? {
        output["meeting"] = meeting;
    }
    if let Some(summary) = database.checkpoints(id).map_err(fail)?.pop() {
        output["summary"] = summary;
    }
    Ok(output)
}
