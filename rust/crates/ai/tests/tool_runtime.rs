use std::{collections::BTreeMap, sync::Arc};
use ycoding_ai::{
    llm::{Event, ToolCall, ToolDefinition, ToolResultValue},
    tool::{self, DispatchError, Tool, ToolFailure},
};
use ycoding_schema::parse_json;

fn call() -> ToolCall {
    ToolCall {
        id: "call".into(),
        name: "lookup".into(),
        input: parse_json(r#"{"q":"hello"}"#).unwrap(),
        provider_executed: None,
        provider_metadata: None,
    }
}
fn definition() -> ToolDefinition {
    ToolDefinition {
        name: "ignored".into(),
        description: "lookup".into(),
        input_schema: parse_json(r#"{"type":"object"}"#).unwrap(),
        output_schema: None,
        cache: None,
        metadata: None,
        native: None,
    }
}
#[tokio::test]
async fn dispatch_success_failure_defect_and_absent_handler() {
    let missing = tool::dispatch(&BTreeMap::new(), &call()).await.unwrap();
    assert!(matches!(
        missing.events.as_slice(),
        [Event::ToolError { .. }, Event::ToolResult(_)]
    ));
    assert!(matches!(missing.result, ToolResultValue::Error(_)));
    let no_handler = BTreeMap::from([("lookup".into(), Tool::dynamic(definition()))]);
    assert!(matches!(
        tool::dispatch(&no_handler, &call()).await.unwrap().result,
        ToolResultValue::Error(_)
    ));
    let tools = BTreeMap::from([(
        "lookup".into(),
        Tool::dynamic(definition()).with_execute(|input, call| async move {
            assert_eq!(call.id.as_str(), Some("call"));
            assert_eq!(input, parse_json(r#"{"q":"hello"}"#).unwrap());
            Ok(parse_json(r#""answer""#).unwrap())
        }),
    )]);
    let output = tool::dispatch(&tools, &call()).await.unwrap();
    assert_eq!(
        output.result,
        ToolResultValue::Text(parse_json(r#""answer""#).unwrap())
    );
    assert_eq!(output.events.len(), 1);
    assert!(output.output.is_some());
    assert_eq!(tool::definitions(&tools)[0].name.as_str(), Some("lookup"));
    let failure = BTreeMap::from([(
        "lookup".into(),
        Tool::dynamic(definition()).with_execute(|_, _| async {
            Err(DispatchError::Failure(ToolFailure {
                message: "expected failure".into(),
                error: Some(parse_json(r#"{"kind":"fixture"}"#).unwrap()),
            }))
        }),
    )]);
    let output = tool::dispatch(&failure, &call()).await.unwrap();
    assert!(
        matches!(&output.events[0],Event::ToolError {message,error:Some(_),..} if message.as_str()==Some("expected failure"))
    );
    let defect = BTreeMap::from([(
        "lookup".into(),
        Tool::dynamic(definition())
            .with_execute(|_, _| async { Err(DispatchError::Defect("unexpected".into())) }),
    )]);
    assert!(matches!(
        tool::dispatch(&defect, &call()).await,
        Err(DispatchError::Defect(_))
    ));
}
#[tokio::test]
async fn decoder_and_success_encoder_failure_are_nonexecutable() {
    for input_failure in [true, false] {
        let mut item = Tool::dynamic(definition())
            .with_execute(|_, _| async { Ok(parse_json("{}").unwrap()) });
        let codec = Arc::new(|_: ycoding_schema::JsonValue| {
            Err(ToolFailure {
                message: "invalid fixture".into(),
                error: None,
            })
        });
        if input_failure {
            item.decode = Some(codec);
            item.execute = Some(Arc::new(|_, _| {
                Box::pin(async { panic!("invalid input executed") })
            }));
        } else {
            item.encode = Some(codec);
        }
        let tools = BTreeMap::from([("lookup".into(), item)]);
        let result = tool::dispatch(&tools, &call()).await.unwrap();
        assert!(matches!(result.result, ToolResultValue::Error(_)));
        assert!(result.output.is_none());
    }
    let tools = BTreeMap::from([(
        "lookup".into(),
        Tool::dynamic(definition()).with_execute(|_, _| async {
            Ok(parse_json(r#"{"type":"json","value":{"legacy":true}}"#).unwrap())
        }),
    )]);
    assert_eq!(
        tool::dispatch(&tools, &call()).await.unwrap().result,
        ToolResultValue::Json(parse_json(r#"{"legacy":true}"#).unwrap())
    );
}
