use serde_json::{Value, json};
use ycoding_ai::{
    auth::Auth,
    llm::{Message, Request, ResponseFormat, ToolDefinition},
    provider_error::Reason,
    providers::{self, Config, OpenRouterConfig},
    route::{Route, Transport},
};
use ycoding_schema::parse_json;

const SCHEMA: &str = r##"{
    "type":"object",
    "properties":{
        "answers":{
            "type":"array","minItems":1,
            "items":{
                "type":"object",
                "properties":{
                    "name":{"type":"string","enum":["route","decision"]},
                    "choice":{"anyOf":[{"type":"boolean"},{"type":"string"},{"type":"null"}]},
                    "minimum":{"$ref":"#/$defs/confidence"}
                },
                "required":["name","choice","minimum"],
                "additionalProperties":false
            }
        }
    },
    "$defs":{"confidence":{"type":"number"}},
    "required":["answers"],
    "additionalProperties":false
}"##;

fn request(route: &Route) -> Request {
    let mut request = Request::new(route.model(if route.id == "anthropic-messages" {
        "claude-opus-5"
    } else {
        "gpt-5.6"
    }));
    request
        .messages
        .push(Message::user("Classify the supplied evidence."));
    request
}

fn wire(request: &Request) -> Value {
    serde_json::from_str(&request.model.route.prepare(request).unwrap().encoded_body).unwrap()
}

fn routes() -> [Route; 4] {
    [
        Route::openai_responses(),
        Route::openai_responses_websocket(),
        Route::openai_chat(),
        Route::anthropic(),
    ]
}

fn tool() -> ToolDefinition {
    ToolDefinition {
        name: "decision".into(),
        description: "Return the bounded decision".into(),
        input_schema: parse_json(SCHEMA).unwrap(),
        output_schema: None,
        cache: None,
        metadata: None,
        native: None,
    }
}

#[test]
fn responses_http_and_websocket_preserve_strict_schema_and_verbosity() {
    for route in [
        Route::openai_responses(),
        Route::openai_responses_websocket(),
    ] {
        let mut request = request(&route);
        request.response_format = Some(ResponseFormat::Json(parse_json(SCHEMA).unwrap()));
        request.provider_options =
            Some(parse_json(r#"{"openai":{"textVerbosity":"low"}}"#).unwrap());
        let prepared = route.prepare(&request).unwrap();
        let body: Value = serde_json::from_str(&prepared.encoded_body).unwrap();
        let format = json!({
            "type": "json_schema",
            "name": "response",
            "schema": serde_json::from_str::<Value>(SCHEMA).unwrap(),
            "strict": true
        });
        assert_eq!(body["text"], json!({"verbosity":"low", "format":format}));
        assert!(body.get("response_format").is_none());
        assert!(body.get("tools").is_none());
        if let Transport::WebSocket(transport) = &route.transport {
            let message = (transport.to_message)(&prepared.wire_body).unwrap();
            let message: Value =
                serde_json::from_str(&ycoding_schema::stringify_json(&message)).unwrap();
            assert_eq!(message["type"], "response.create");
            assert_eq!(message["text"], body["text"]);
            assert!(message.get("stream").is_none());
        }
    }
}

#[test]
fn chat_preserves_the_exact_schema_in_its_strict_json_schema_envelope() {
    let route = Route::openai_chat();
    let mut request = request(&route);
    request.response_format = Some(ResponseFormat::Json(parse_json(SCHEMA).unwrap()));
    let body = wire(&request);
    assert_eq!(
        body["response_format"],
        json!({
            "type":"json_schema",
            "json_schema":{
                "name":"response",
                "schema":serde_json::from_str::<Value>(SCHEMA).unwrap(),
                "strict":true
            }
        })
    );
    assert!(body.get("text").is_none());
    assert!(body.get("tools").is_none());
}

#[test]
fn anthropic_preserves_the_exact_schema_and_existing_output_effort() {
    let route = Route::anthropic();
    let mut request = request(&route);
    request.response_format = Some(ResponseFormat::Json(parse_json(SCHEMA).unwrap()));
    request.provider_options = Some(parse_json(r#"{"anthropic":{"effort":"high"}}"#).unwrap());
    let body = wire(&request);
    assert_eq!(
        body["output_config"],
        json!({
            "effort":"high",
            "format":{
                "type":"json_schema",
                "schema":serde_json::from_str::<Value>(SCHEMA).unwrap()
            }
        })
    );
    assert!(body.get("response_format").is_none());
    assert!(body.get("tools").is_none());
}

#[test]
fn schema_projection_removes_unenforced_constraints_without_rewriting_data_or_property_names() {
    let schema = r#"{
        "type":"object",
        "properties":{
            "minimum":{"type":"integer","minimum":0,"maximum":4,"multipleOf":1},
            "label":{"type":"string","minLength":1,"maxLength":500},
            "items":{"type":"array","minItems":2,"maxItems":5,"uniqueItems":true,"items":{"type":"string"}},
            "literal":{"const":{"minimum":1,"maxItems":5},"default":{"minLength":2},"examples":[{"maximum":3}]},
            "enum":{"enum":[{"minimum":4}]}
        },
        "required":["minimum","label","items","literal","enum"],
        "additionalProperties":false,"minProperties":1,"maxProperties":5
    }"#;
    let expected = json!({
        "type":"object",
        "properties":{
            "minimum":{"type":"integer"},
            "label":{"type":"string"},
            "items":{"type":"array","items":{"type":"string"}},
            "literal":{"const":{"minimum":1,"maxItems":5},"default":{"minLength":2},"examples":[{"maximum":3}]},
            "enum":{"enum":[{"minimum":4}]}
        },
        "required":["minimum","label","items","literal","enum"],
        "additionalProperties":false
    });
    for route in routes() {
        let mut request = request(&route);
        request.response_format = Some(ResponseFormat::Json(parse_json(schema).unwrap()));
        let body = wire(&request);
        let schema = match route.id.as_str() {
            "openai-chat" => &body["response_format"]["json_schema"]["schema"],
            "anthropic-messages" => &body["output_config"]["format"]["schema"],
            _ => &body["text"]["format"]["schema"],
        };
        assert_eq!(schema, &expected, "{}", route.id);
    }
}

#[test]
fn explicit_text_matches_default_without_any_structured_output_fields() {
    for route in routes() {
        let mut request = request(&route);
        let default = wire(&request);
        request.response_format = Some(ResponseFormat::Text);
        assert_eq!(wire(&request), default, "{}", route.id);
        assert!(default.pointer("/text/format").is_none());
        assert!(default.get("response_format").is_none());
        assert!(default.pointer("/output_config/format").is_none());
    }
}

#[test]
fn unsupported_tool_response_format_is_rejected_by_each_request_planner() {
    for route in routes() {
        let mut request = request(&route);
        request.response_format = Some(ResponseFormat::Tool(tool()));
        let error = route.prepare(&request).unwrap_err();
        assert_eq!(error.reason, Reason::InvalidRequest, "{}", route.id);
        assert!(error.http.is_none());
    }
}

#[test]
fn openrouter_rejects_unadvertised_formats_before_transport_but_preserves_text() {
    let model = providers::openrouter(
        "openai/gpt-5.6",
        OpenRouterConfig {
            common: Config::new(Auth::None),
            reasoning: None,
        },
    );
    let mut request = Request::new(model);
    request
        .messages
        .push(Message::user("Classify the supplied evidence."));
    let default = wire(&request);
    request.response_format = Some(ResponseFormat::Text);
    assert_eq!(wire(&request), default);
    for format in [
        ResponseFormat::Json(parse_json(SCHEMA).unwrap()),
        ResponseFormat::Tool(tool()),
    ] {
        request.response_format = Some(format);
        let error = request.model.route.prepare(&request).unwrap_err();
        assert_eq!(error.reason, Reason::InvalidRequest);
        assert!(error.http.is_none());
    }
}
