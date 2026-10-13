use std::sync::{Arc, Mutex};
use tokio::sync::Notify;
use ycoding_core::tools::code_mode::{
    Cancellation, DiagnosticKind, ExecutionLimits, Runtime, ToolDescription, ToolFailure,
    ToolFuture, ToolHost,
};
use ycoding_schema::{JsonValue, LosslessString, parse_json};
#[path = "code_mode_regexp_fixture.rs"]
mod regexp_fixture;

#[derive(Default)]
struct Host {
    trace: Mutex<Vec<String>>,
    gate: Notify,
}

impl ToolHost for Host {
    fn catalog(&self) -> Vec<ToolDescription> {
        ["echo", "gated", "open", "pending", "fail"]
            .iter()
            .map(|name| ToolDescription {
                path: format!("host.{name}").into(),
                description: format!("Test {name}"),
                signature: format!("tools.host.{name}(input: unknown): Promise<unknown>"),
                input_properties: Vec::new(),
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
        cancel: Cancellation,
    ) -> ToolFuture<'_> {
        Box::pin(async move {
            let path = path.to_utf8().unwrap();
            self.trace.lock().unwrap().push(format!("start:{path}"));
            if path == "host.open" {
                self.gate.notify_waiters();
                return Ok(Some(JsonValue::Bool(true)));
            }
            if path == "host.fail" {
                return Err(ToolFailure::Safe("Lookup refused".into()));
            }
            if path == "host.gated" || path == "host.pending" {
                let gate = self.gate.notified();
                tokio::select! {
                    _=cancel.cancelled()=>{self.trace.lock().unwrap().push(format!("cancel:{path}"));return Err(ToolFailure::Cancelled);},
                    _=gate,if path=="host.gated"=>{},
                }
            }
            self.trace.lock().unwrap().push(format!("end:{path}"));
            Ok(input.or(Some(JsonValue::Null)))
        })
    }
    fn decode_output(
        &self,
        _: &LosslessString,
        output: Option<JsonValue>,
    ) -> Result<Option<JsonValue>, ToolFailure> {
        Ok(output)
    }
}

#[tokio::test]
async fn deferred_reactions_and_plain_await_interleave_in_attach_order() {
    let host = Arc::new(Host::default());
    let runtime = Runtime::new(
        host,
        ExecutionLimits::default(),
        Arc::new(ycoding_core::tools::code_mode::regexp::NativeRegExpEngine),
        regexp_fixture::collation(),
    )
    .unwrap();
    for (code, expected) in [
        (
            "const order=[]; async function f(id) {order.push(id+'a'); await 0; order.push(id+'b')} const a=f('1'); const b=f('2'); await Promise.all([a,b]); return order",
            "[\"1a\",\"2a\",\"1b\",\"2b\"]",
        ),
        (
            "const order=[]; const p=Promise.resolve(1); p.then(()=>order.push('a')); p.then(()=>order.push('b')); order.push('sync'); await p; return order",
            "[\"sync\",\"a\",\"b\"]",
        ),
        (
            "const order=[]; const p=Promise.resolve(1); const a=Promise.all([p]); p.then(()=>order.push('member')); a.then(()=>order.push('all')); await a; return order",
            "[\"member\",\"all\"]",
        ),
        (
            "return await Promise.race([Promise.all([Promise.resolve('aggregate')]),'plain'])",
            "\"plain\"",
        ),
        (
            "return await Promise.resolve(2).then(x=>Promise.resolve(x+1)).finally(()=>99)",
            "3",
        ),
        ("return await Promise.any([Promise.reject('no'),4])", "4"),
        (
            "try {await Promise.any([Promise.reject('a'),Promise.reject('b')])} catch(e) {return [e.name,e.errors]}",
            "[\"AggregateError\",[\"a\",\"b\"]]",
        ),
        (
            "let resolve; const p=new Promise(r=>{resolve=r}); resolve(3); resolve(4); return [await p,await p]",
            "[3,3]",
        ),
        (
            "let resolve; const p=new Promise(r=>{resolve=r}); resolve(p); try {await p} catch(e) {return e.name}",
            "\"TypeError\"",
        ),
    ] {
        assert_eq!(
            runtime
                .execute(code, Cancellation::default())
                .await
                .value
                .unwrap(),
            parse_json(expected).unwrap(),
            "{code}"
        );
    }
}

#[tokio::test]
async fn tools_are_eager_run_once_and_parallel_with_ordered_results() {
    let host = Arc::new(Host::default());
    let runtime = Runtime::new(
        host.clone(),
        ExecutionLimits::default(),
        Arc::new(ycoding_core::tools::code_mode::regexp::NativeRegExpEngine),
        regexp_fixture::collation(),
    )
    .unwrap();
    let output=runtime.execute("const a=tools.host.gated(1); const b=tools.host.gated(2); await tools.host.open({}); return [await Promise.all([b,a]),await a]",Cancellation::default()).await;
    assert_eq!(output.value.unwrap(), parse_json("[[2,1],1]").unwrap());
    assert_eq!(
        output.tool_calls,
        ["host.gated", "host.gated", "host.open"].map(LosslessString::from)
    );
    assert_eq!(
        &host.trace.lock().unwrap()[..3],
        ["start:host.gated", "start:host.gated", "start:host.open"]
    );
}

#[tokio::test]
async fn interpolated_test262_statics_return_a_rejected_promise_for_invalid_input() {
    let runtime = Runtime::new(
        Arc::new(Host::default()),
        ExecutionLimits {
            timeout_ms: Some(1_000),
            ..ExecutionLimits::default()
        },
        Arc::new(ycoding_core::tools::code_mode::regexp::NativeRegExpEngine),
        regexp_fixture::collation(),
    )
    .unwrap();
    for name in ["all", "allSettled", "race", "any"] {
        let code = format!(
            "const promise=Promise.{name}(42); const returned=promise instanceof Promise; try{{await promise;return [returned,'fulfilled']}}catch(error){{return [returned,error.name]}}"
        );
        assert_eq!(
            runtime.execute(code, Cancellation::default()).await.value,
            Ok(parse_json("[true,\"TypeError\"]").unwrap()),
            "Promise.{name}"
        );
    }
}

#[tokio::test]
async fn completion_cancels_pending_work_and_preserves_unobserved_failure_warnings() {
    let host = Arc::new(Host::default());
    let runtime = Runtime::new(
        host.clone(),
        ExecutionLimits::default(),
        Arc::new(ycoding_core::tools::code_mode::regexp::NativeRegExpEngine),
        regexp_fixture::collation(),
    )
    .unwrap();
    let output = runtime
        .execute(
            "tools.host.pending({}); tools.host.fail({}); return 7",
            Cancellation::default(),
        )
        .await;
    assert_eq!(output.value.unwrap(), JsonValue::Number(7.0));
    assert_eq!(output.warnings.len(), 1);
    assert_eq!(output.warnings[0].kind, DiagnosticKind::ToolFailure);
    assert!(output.warnings[0].message.contains("Lookup refused"));
    assert!(
        host.trace
            .lock()
            .unwrap()
            .contains(&"cancel:host.pending".to_owned())
    );
}

#[tokio::test]
async fn optional_limits_are_enforced_and_absent_limits_are_unlimited() {
    let host = Arc::new(Host::default());
    let runtime = Runtime::new(
        host,
        ExecutionLimits {
            max_tool_calls: Some(1),
            ..ExecutionLimits::default()
        },
        Arc::new(ycoding_core::tools::code_mode::regexp::NativeRegExpEngine),
        regexp_fixture::collation(),
    )
    .unwrap();
    let output = runtime
        .execute(
            "await tools.host.echo(1); return await tools.host.echo(2)",
            Cancellation::default(),
        )
        .await;
    assert_eq!(
        output.value.unwrap_err()[0].kind,
        DiagnosticKind::ToolCallLimitExceeded
    );
    assert_eq!(output.tool_calls, [LosslessString::from("host.echo")]);
    let runtime = Runtime::new(
        Arc::new(Host::default()),
        ExecutionLimits {
            timeout_ms: Some(1),
            ..ExecutionLimits::default()
        },
        Arc::new(ycoding_core::tools::code_mode::regexp::NativeRegExpEngine),
        regexp_fixture::collation(),
    )
    .unwrap();
    assert_eq!(
        runtime
            .execute("while(true) {}", Cancellation::default())
            .await
            .value
            .unwrap_err()[0]
            .kind,
        DiagnosticKind::TimeoutExceeded
    );
    let runtime = Runtime::new(
        Arc::new(Host::default()),
        ExecutionLimits::default(),
        Arc::new(ycoding_core::tools::code_mode::regexp::NativeRegExpEngine),
        regexp_fixture::collation(),
    )
    .unwrap();
    assert_eq!(
        runtime
            .execute(
                "let n=0; for(let i=0;i<1500;i++) n+=await tools.host.echo(1); return n",
                Cancellation::default()
            )
            .await
            .value
            .unwrap(),
        JsonValue::Number(1500.0)
    );
}
