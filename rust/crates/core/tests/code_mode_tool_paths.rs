mod code_mode_regexp_fixture;
use std::sync::{Arc, Mutex};
use ycoding_core::tools::code_mode::{
    Cancellation, ExecutionLimits, Runtime, ToolCallStarted, ToolDescription, ToolFailure,
    ToolFuture, ToolHookFuture, ToolHost,
};
use ycoding_schema::{JsonValue, LosslessString, parse_json};

struct Host {
    paths: Vec<LosslessString>,
    calls: Mutex<Vec<LosslessString>>,
    observed: Mutex<Vec<LosslessString>>,
}
impl ToolHost for Host {
    fn catalog(&self) -> Vec<ToolDescription> {
        self.paths
            .iter()
            .map(|path| {
                ToolDescription::from_schemas(
                    path.clone(),
                    "Echo".into(),
                    &parse_json("{}").unwrap(),
                    None,
                )
            })
            .collect()
    }
    fn decode_input(
        &self,
        _: &LosslessString,
        input: Option<JsonValue>,
    ) -> Result<Option<JsonValue>, ToolFailure> {
        Ok(input)
    }
    fn invoke(
        &self,
        path: LosslessString,
        input: Option<JsonValue>,
        _: Cancellation,
    ) -> ToolFuture<'_> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(path);
            Ok(input)
        })
    }
    fn decode_output(
        &self,
        _: &LosslessString,
        output: Option<JsonValue>,
    ) -> Result<Option<JsonValue>, ToolFailure> {
        Ok(output)
    }
    fn on_tool_call_start(&self, call: ToolCallStarted) -> ToolHookFuture<'_> {
        Box::pin(async move {
            self.observed.lock().unwrap().push(call.name);
        })
    }
}

#[tokio::test]
async fn lossless_paths_flow_through_catalog_enumeration_search_and_real_host_calls() {
    let mut units = "raw".encode_utf16().collect::<Vec<_>>();
    units.push(0xd800);
    units.extend(".call".encode_utf16());
    let path = LosslessString::from_utf16(units);
    let host = Arc::new(Host {
        paths: vec![path.clone(), "raw�.call".into(), "raw\\ud800.call".into()],
        calls: Mutex::new(Vec::new()),
        observed: Mutex::new(Vec::new()),
    });
    let runtime = Runtime::new(
        host.clone(),
        ExecutionLimits {
            timeout_ms: Some(1_000),
            ..ExecutionLimits::default()
        },
        Arc::new(ycoding_core::tools::code_mode::regexp::NativeRegExpEngine),
        code_mode_regexp_fixture::collation(),
    )
    .unwrap();
    assert_eq!(runtime.catalog()[0].path, path);
    assert!(
        runtime
            .instructions(None)
            .unwrap()
            .contains("tools[\"raw\\ud800\"].call(input: unknown): Promise<unknown>")
    );
    let result=runtime.execute("const discovered=await search({query:'raw\\ud800.call'});const keys=Object.keys(tools);return [keys[0].charCodeAt(3),discovered.items[0].path,await tools['raw\\ud800'].call({id:1}),await tools['raw\\ud800.call']({id:2}),await tools['raw�'].call({id:3}),await tools['raw\\\\ud800'].call({id:4})]",Cancellation::default()).await;
    assert_eq!(result.value,Ok(parse_json("[55296,\"tools[\\\"raw\\\\ud800\\\"].call\",{\"id\":1},{\"id\":2},{\"id\":3},{\"id\":4}]").unwrap()));
    assert_eq!(
        result.tool_calls,
        vec![
            "search".into(),
            path.clone(),
            path.clone(),
            "raw�.call".into(),
            "raw\\ud800.call".into()
        ]
    );
    assert_eq!(*host.observed.lock().unwrap(), result.tool_calls);
    assert_eq!(
        *host.calls.lock().unwrap(),
        vec![
            path.clone(),
            path,
            "raw�.call".into(),
            "raw\\ud800.call".into()
        ]
    );
    let result = runtime
        .execute(
            "return (await search({namespace:'raw\\ud800'})).items.map(x=>x.path)",
            Cancellation::default(),
        )
        .await;
    assert_eq!(
        result.value,
        Ok(parse_json("[\"tools[\\\"raw\\\\ud800\\\"].call\"]").unwrap())
    );
}
