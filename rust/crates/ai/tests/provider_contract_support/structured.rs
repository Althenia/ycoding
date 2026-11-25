use ycoding_ai::llm::ToolDefinition;
use ycoding_schema::{JsonValue, parse_json};

pub fn schema() -> JsonValue {
    parse_json(r#"{"type":"object","properties":{"value":{"type":"string"}},"required":["value"],"additionalProperties":false}"#).unwrap()
}

pub fn definition() -> ToolDefinition {
    ToolDefinition {
        name: "generate_object".into(),
        description: "Return the structured result by calling this tool.".into(),
        input_schema: schema(),
        output_schema: None,
        cache: None,
        metadata: None,
        native: None,
    }
}
