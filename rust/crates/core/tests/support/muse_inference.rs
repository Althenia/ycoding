pub fn json(request: &str) -> serde_json::Value {
    serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap()
}

pub fn model(base: &str) -> ycoding_schema::model::Info {
    ycoding_core::resources::muse::models(
        &ycoding_schema::parse_json(
            &serde_json::json!({"data":[super::fixture::row("muse-wonder-1.0")]}).to_string(),
        )
        .unwrap(),
        base,
    )
    .unwrap()
    .models
    .remove(0)
}

pub fn inference() -> String {
    [
        serde_json::json!({"type":"response.created","response":{"id":"response-fixture","created_at":1,"model":"muse-wonder-1.0"}}),
        serde_json::json!({"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"reason-fixture","encrypted_content":"encrypted-fixture","summary":[]}}),
        serde_json::json!({"type":"response.reasoning_summary_text.delta","item_id":"reason-fixture","summary_index":0,"delta":"Thought"}),
        serde_json::json!({"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"reason-fixture","encrypted_content":"encrypted-fixture","summary":[{"type":"summary_text","text":"Thought"}]}}),
        serde_json::json!({"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"msg-fixture","role":"assistant","phase":"commentary","content":[]}}),
        serde_json::json!({"type":"response.output_text.delta","item_id":"msg-fixture","output_index":1,"content_index":0,"delta":"Hello こんにちは"}),
        serde_json::json!({"type":"response.output_item.done","output_index":1,"item":{"type":"message","id":"msg-fixture","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"Hello こんにちは","annotations":[]}]}}),
        serde_json::json!({"type":"response.completed","response":{"id":"response-fixture","status":"completed","usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":60},"output_tokens":20,"output_tokens_details":{"reasoning_tokens":12}}}}),
    ].iter().map(|v| format!("event: {}\ndata: {v}\n\n", v["type"].as_str().unwrap())).collect()
}
