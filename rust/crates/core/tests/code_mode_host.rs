mod code_mode_regexp_fixture;
use std::sync::{Arc, Mutex};
use ycoding_core::tools::code_mode::{
    Cancellation, DiagnosticKind, ExecutionLimits, Runtime, ToolCallEnded, ToolCallOutcome,
    ToolCallStarted, ToolDescription, ToolFailure, ToolFuture, ToolHookFuture, ToolHost,
};
use ycoding_schema::{JsonObject, JsonValue, LosslessString, parse_json};

#[derive(Default)]
struct Host {
    events: Mutex<Vec<String>>,
    inputs: Mutex<Vec<Option<JsonValue>>>,
}

impl ToolHost for Host {
    fn catalog(&self) -> Vec<ToolDescription> {
        [
            "echo",
            "undefined",
            "null",
            "safe",
            "internal",
            "invalid",
            "pending",
        ]
        .map(|name| ToolDescription {
            path: format!("host.{name}").into(),
            description: name.into(),
            signature: format!("tools.host.{name}(input: unknown): Promise<unknown>"),
            input_properties: Vec::new(),
        })
        .into()
    }
    fn decode_input(
        &self,
        _: &LosslessString,
        input: Option<JsonValue>,
    ) -> Result<Option<JsonValue>, ToolFailure> {
        if input == Some(JsonValue::String("reject".into())) {
            return Err(ToolFailure::InvalidInput("Expected input".into()));
        }
        Ok(input.map(|input| {
            let mut object = JsonObject::new();
            object.insert("decoded".into(), input);
            JsonValue::Object(object)
        }))
    }
    fn invoke(
        &self,
        path: LosslessString,
        input: Option<JsonValue>,
        cancel: Cancellation,
    ) -> ToolFuture<'_> {
        Box::pin(async move {
            self.inputs.lock().unwrap().push(input.clone());
            match path.as_str().unwrap() {
                "host.undefined" => Ok(None),
                "host.null" => Ok(Some(JsonValue::Null)),
                "host.safe" => Err(ToolFailure::Safe("Lookup refused".into())),
                "host.internal" => Err(ToolFailure::Internal),
                "host.pending" => {
                    cancel.cancelled().await;
                    Err(ToolFailure::Cancelled)
                }
                _ => Ok(input),
            }
        })
    }
    fn decode_output(
        &self,
        path: &LosslessString,
        output: Option<JsonValue>,
    ) -> Result<Option<JsonValue>, ToolFailure> {
        if path.as_str() == Some("host.invalid") {
            return Err(ToolFailure::InvalidOutput);
        }
        Ok(output)
    }
    fn on_tool_call_start(&self, call: ToolCallStarted) -> ToolHookFuture<'_> {
        Box::pin(async move {
            self.events.lock().unwrap().push(format!(
                "start:{}:{}:{}",
                call.index,
                call.name.to_utf8().unwrap(),
                ycoding_schema::stringify_json(call.input.as_ref().unwrap_or(&JsonValue::Null))
            ));
        })
    }
    fn on_tool_call_end(&self, call: ToolCallEnded) -> ToolHookFuture<'_> {
        Box::pin(async move {
            assert!(call.duration_ms < 1_000);
            let outcome = match call.outcome {
                ToolCallOutcome::Success => "success".into(),
                ToolCallOutcome::Failure(message) => format!("failure:{message}"),
            };
            self.events.lock().unwrap().push(format!(
                "end:{}:{}:{outcome}",
                call.call.index,
                call.call.name.to_utf8().unwrap()
            ));
        })
    }
}

fn runtime(host: Arc<Host>) -> Runtime {
    Runtime::new(
        host,
        ExecutionLimits {
            timeout_ms: Some(1_000),
            ..ExecutionLimits::default()
        },
        Arc::new(ycoding_core::tools::code_mode::regexp::NativeRegExpEngine),
        code_mode_regexp_fixture::collation(),
    )
    .unwrap()
}

#[tokio::test]
async fn undefined_output_is_distinct_from_null_and_normalizes_only_at_data_boundaries() {
    let host = Arc::new(Host::default());
    let runtime = runtime(host.clone());
    let result=runtime.execute("const missing=await tools.host.undefined({}); const nil=await tools.host.null({}); await tools.host.echo({missing,nil}); return [missing===undefined,nil===null,{missing,nil},[missing,nil]]",Cancellation::default()).await;
    assert_eq!(
        result.value,
        Ok(parse_json("[true,true,{\"missing\":null,\"nil\":null},[null,null]]").unwrap())
    );
    assert_eq!(
        host.inputs.lock().unwrap().last(),
        Some(&Some(parse_json("{\"decoded\":{\"nil\":null}}").unwrap()))
    );
}

#[tokio::test]
async fn hooks_observe_only_admitted_decoded_calls_and_settled_sanitized_outcomes() {
    let host = Arc::new(Host::default());
    let runtime = runtime(host.clone());
    assert!(runtime.execute("if(false) await tools.host.echo('skip'); try{await tools.host.echo('reject')}catch{}; return await tools.host.echo('ok')",Cancellation::default()).await.value.is_ok());
    assert_eq!(
        *host.inputs.lock().unwrap(),
        vec![Some(parse_json("{\"decoded\":\"ok\"}").unwrap())]
    );
    for (path, kind, message) in [
        ("safe", DiagnosticKind::ToolFailure, "Lookup refused"),
        (
            "internal",
            DiagnosticKind::ToolFailure,
            "Tool execution failed",
        ),
        (
            "invalid",
            DiagnosticKind::InvalidToolOutput,
            "Invalid output from tool 'host.invalid'.",
        ),
    ] {
        let result = runtime
            .execute(
                format!("return await tools.host.{path}({{}})"),
                Cancellation::default(),
            )
            .await;
        assert_eq!(result.value.unwrap_err()[0].kind, kind);
        assert_eq!(
            host.events.lock().unwrap().last().unwrap(),
            &format!("end:0:host.{path}:failure:{message}")
        );
    }
    assert_eq!(
        &host.events.lock().unwrap()[..2],
        &[
            "start:0:host.echo:{\"decoded\":\"ok\"}",
            "end:0:host.echo:success"
        ]
    );
}

#[tokio::test]
async fn abandoned_calls_emit_start_without_a_settled_end_outcome() {
    let host = Arc::new(Host::default());
    let result = runtime(host.clone())
        .execute("tools.host.pending({}); return 1", Cancellation::default())
        .await;
    assert_eq!(result.value, Ok(JsonValue::Number(1.0)));
    assert_eq!(
        *host.events.lock().unwrap(),
        vec!["start:0:host.pending:{\"decoded\":{}}"]
    );
}

#[tokio::test]
async fn search_uses_promise_admission_and_the_same_observation_boundary() {
    let host = Arc::new(Host::default());
    let result=runtime(host.clone()).execute("const promise=search({query:'echo',limit:1,ignored:'drop'}); const result=await promise; await tools.host.echo({}); return [promise instanceof Promise,result.items[0].path]",Cancellation::default()).await;
    assert_eq!(
        result.value,
        Ok(parse_json("[true,\"tools.host.echo\"]").unwrap())
    );
    assert_eq!(
        *host.events.lock().unwrap(),
        vec![
            "start:0:search:{\"query\":\"echo\",\"limit\":1}",
            "end:0:search:success",
            "start:1:host.echo:{\"decoded\":{}}",
            "end:1:host.echo:success"
        ]
    );
}
