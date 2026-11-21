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

pub fn frames(family: &str) -> &'static str {
    match family {
        "messages" => concat!(
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"structured-call\",\"name\":\"generate_object\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"value\\\":\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"result\\\"}\"}}\n\n",
            "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"}}\n\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        ),
        "chat" => concat!(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"structured-call\",\"type\":\"function\",\"function\":{\"name\":\"generate_object\",\"arguments\":\"{\\\"value\\\":\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"result\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n",
        ),
        "responses" => concat!(
            "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"id\":\"fc_fixture\",\"call_id\":\"structured-call\",\"name\":\"generate_object\"}}\n\n",
            "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_fixture\",\"delta\":\"{\\\"value\\\":\"}\n\n",
            "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_fixture\",\"delta\":\"\\\"result\\\"}\"}\n\n",
            "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"function_call\",\"id\":\"fc_fixture\",\"call_id\":\"structured-call\",\"name\":\"generate_object\"}}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r_structured\",\"status\":\"completed\"}}\n\n",
        ),
        _ => panic!("structured-output route lacks a replay oracle"),
    }
}
