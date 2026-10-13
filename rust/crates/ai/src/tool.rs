use crate::{
    json,
    llm::{Event, ToolCall, ToolDefinition, ToolOutput, ToolResult, ToolResultValue},
};
use std::{collections::BTreeMap, future::Future, pin::Pin, sync::Arc};
use ycoding_schema::{JsonValue, LosslessString};

#[derive(Clone, Debug, PartialEq, thiserror::Error)]
#[error("{message:?}")]
pub struct ToolFailure {
    pub message: LosslessString,
    pub error: Option<JsonValue>,
}
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum DispatchError {
    #[error("tool failure")]
    Failure(ToolFailure),
    #[error("tool handler defect")]
    Defect(LosslessString),
}
type Execute = Arc<
    dyn Fn(
            JsonValue,
            ToolCall,
        ) -> Pin<Box<dyn Future<Output = Result<JsonValue, DispatchError>> + Send>>
        + Send
        + Sync,
>;
type Codec = Arc<dyn Fn(JsonValue) -> Result<JsonValue, ToolFailure> + Send + Sync>;
type Project = Arc<dyn Fn(JsonValue, LosslessString, JsonValue) -> ToolOutput + Send + Sync>;
#[derive(Clone)]
pub struct Tool {
    pub definition: ToolDefinition,
    pub execute: Option<Execute>,
    pub decode: Option<Codec>,
    pub encode: Option<Codec>,
    pub project: Option<Project>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Settlement {
    pub result: ToolResultValue,
    pub output: Option<ToolOutput>,
    pub events: Vec<Event>,
}
impl Tool {
    pub fn dynamic(definition: ToolDefinition) -> Self {
        Self {
            definition,
            execute: None,
            decode: None,
            encode: None,
            project: None,
        }
    }
    pub fn with_execute<F, Fut>(mut self, execute: F) -> Self
    where
        F: Fn(JsonValue, ToolCall) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<JsonValue, DispatchError>> + Send + 'static,
    {
        self.execute = Some(Arc::new(move |input, call| Box::pin(execute(input, call))));
        self
    }
}
pub fn definitions(tools: &BTreeMap<LosslessString, Tool>) -> Vec<ToolDefinition> {
    tools
        .iter()
        .map(|(name, tool)| {
            let mut definition = tool.definition.clone();
            definition.name = name.clone();
            definition
        })
        .collect()
}
fn settle(
    call: &ToolCall,
    result: ToolResultValue,
    output: Option<ToolOutput>,
    error: Option<JsonValue>,
) -> Settlement {
    let mut events = Vec::new();
    if let ToolResultValue::Error(value) = &result {
        events.push(Event::ToolError {
            id: call.id.clone(),
            name: call.name.clone(),
            message: ToolResultValue::Text(value.clone()).to_text(),
            error,
        });
    }
    events.push(Event::ToolResult(ToolResult {
        id: call.id.clone(),
        name: call.name.clone(),
        result: result.clone(),
        output: output.clone(),
        cache: None,
        provider_executed: None,
        provider_metadata: None,
    }));
    Settlement {
        result,
        output,
        events,
    }
}
pub async fn dispatch(
    tools: &BTreeMap<LosslessString, Tool>,
    call: &ToolCall,
) -> Result<Settlement, DispatchError> {
    let Some(tool) = tools.get(&call.name) else {
        return Ok(settle(
            call,
            ToolResultValue::Error(json::s(format!(
                "Unknown tool: {}",
                call.name.as_str().unwrap_or("")
            ))),
            None,
            None,
        ));
    };
    let Some(execute) = &tool.execute else {
        return Ok(settle(
            call,
            ToolResultValue::Error(json::s(format!(
                "Tool has no execute handler: {}",
                call.name.as_str().unwrap_or("")
            ))),
            None,
            None,
        ));
    };
    let input = match &tool.decode {
        Some(decode) => match decode(call.input.clone()) {
            Ok(input) => input,
            Err(failure) => {
                return Ok(settle(
                    call,
                    ToolResultValue::Error(json::s(format!(
                        "Invalid tool input: {}",
                        failure.message.as_str().unwrap_or("")
                    ))),
                    None,
                    None,
                ));
            }
        },
        None => call.input.clone(),
    };
    let value = match execute(input.clone(), call.clone()).await {
        Ok(value) => value,
        Err(DispatchError::Failure(failure)) => {
            return Ok(settle(
                call,
                ToolResultValue::Error(json::s(failure.message)),
                None,
                failure.error,
            ));
        }
        Err(defect) => return Err(defect),
    };
    let value = match &tool.encode {
        Some(encode) => match encode(value) {
            Ok(value) => value,
            Err(failure) => {
                return Ok(settle(
                    call,
                    ToolResultValue::Error(json::s(format!(
                        "Tool returned an invalid value for its success schema: {}",
                        failure.message.as_str().unwrap_or("")
                    ))),
                    None,
                    None,
                ));
            }
        },
        None => value,
    };
    if tool.decode.is_none()
        && tool.encode.is_none()
        && tool.project.is_none()
        && let (Some(kind), Some(value)) = (
            json::get(&value, "type").and_then(json::text),
            json::get(&value, "value"),
        )
    {
        let result = match kind {
            "text" => Some(ToolResultValue::Text(value.clone())),
            "json" => Some(ToolResultValue::Json(value.clone())),
            "error" => Some(ToolResultValue::Error(value.clone())),
            "content" => {
                use ycoding_schema::DomainDecode;
                json::array(value)
                    .map(|values| {
                        values
                            .iter()
                            .map(ycoding_schema::llm::ToolContent::decode)
                            .collect::<Result<Vec<_>, _>>()
                    })
                    .transpose()
                    .map_err(|_| DispatchError::Defect("Invalid tool content".into()))?
                    .map(ToolResultValue::Content)
            }
            _ => None,
        };
        if let Some(result) = result {
            return Ok(settle(
                call,
                result.clone(),
                ToolOutput::from_result(&result),
                None,
            ));
        }
    }
    let output = match &tool.project {
        Some(project) => project(input, call.id.clone(), value),
        None => ToolOutput {
            content: json::string(&value)
                .map(|text| {
                    vec![ycoding_schema::llm::ToolContent::Text(
                        ycoding_schema::llm::ToolTextContent { text: text.clone() },
                    )]
                })
                .unwrap_or_default(),
            structured: value,
        },
    };
    Ok(settle(call, output.result(), Some(output), None))
}
