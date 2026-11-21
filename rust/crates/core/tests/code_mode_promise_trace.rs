mod code_mode_regexp_fixture;
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;
use ycoding_core::tools::code_mode::{
    Cancellation, DiagnosticKind, ExecutionLimits, ExecutionResult, Runtime, ToolDescription,
    ToolFailure, ToolFuture, ToolHost,
};
use ycoding_schema::{JsonValue, LosslessString, parse_json, stringify_json};

#[derive(Default)]
struct Gate {
    open: AtomicBool,
    notification: Notify,
}

#[derive(Default)]
struct Trace {
    starts: Mutex<Vec<i64>>,
    active: AtomicUsize,
    max_active: AtomicUsize,
    completed: AtomicUsize,
    interrupted: AtomicUsize,
    captured: Mutex<Vec<Option<JsonValue>>>,
}

impl Trace {
    fn begin(&self, id: i64) {
        self.starts.lock().unwrap().push(id);
        let active = self.active.fetch_add(1, Ordering::AcqRel) + 1;
        self.max_active.fetch_max(active, Ordering::AcqRel);
    }
    fn complete(&self) {
        self.active.fetch_sub(1, Ordering::AcqRel);
        self.completed.fetch_add(1, Ordering::AcqRel);
    }
    fn interrupt(&self) {
        self.active.fetch_sub(1, Ordering::AcqRel);
        self.interrupted.fetch_add(1, Ordering::AcqRel);
    }
    fn starts(&self) -> Vec<i64> {
        self.starts.lock().unwrap().clone()
    }
    fn completed(&self) -> usize {
        self.completed.load(Ordering::Acquire)
    }
    fn interrupted(&self) -> usize {
        self.interrupted.load(Ordering::Acquire)
    }
    fn max_active(&self) -> usize {
        self.max_active.load(Ordering::Acquire)
    }
}

#[derive(Default)]
struct Host {
    trace: Arc<Trace>,
    gates: Mutex<BTreeMap<i64, Arc<Gate>>>,
}

fn identifier(input: &Option<JsonValue>) -> Result<i64, ToolFailure> {
    let Some(JsonValue::Object(input)) = input else {
        return Err(ToolFailure::InvalidInput("Expected id input".into()));
    };
    match input.get(&"id".into()) {
        Some(JsonValue::Number(id)) => Ok(*id as i64),
        _ => Err(ToolFailure::InvalidInput("Expected id input".into())),
    }
}

impl ToolHost for Host {
    fn catalog(&self) -> Vec<ToolDescription> {
        [
            "echo",
            "gated",
            "open",
            "pending",
            "fail",
            "interrupt",
            "completed",
            "stubborn",
            "decorate",
            "capture",
        ]
        .into_iter()
        .map(|name| ToolDescription {
            path: format!("host.{name}").into(),
            description: name.into(),
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
        cancellation: Cancellation,
    ) -> ToolFuture<'_> {
        Box::pin(async move {
            let trace = &self.trace;
            match path.to_utf8().unwrap().as_str() {
                "host.completed" => Ok(Some(JsonValue::Number(trace.completed() as f64))),
                "host.fail" => Err(ToolFailure::Safe("Lookup refused".into())),
                "host.interrupt" => Err(ToolFailure::Cancelled),
                "host.decorate" => {
                    let Some(JsonValue::String(text)) = input else {
                        return Err(ToolFailure::InvalidInput("Expected a string".into()));
                    };
                    Ok(Some(JsonValue::String(
                        format!("[{}]", text.to_utf8().unwrap()).into(),
                    )))
                }
                "host.capture" => {
                    trace.captured.lock().unwrap().push(input);
                    Ok(Some(JsonValue::String("ok".into())))
                }
                "host.echo" => {
                    let id = identifier(&input)?;
                    trace.starts.lock().unwrap().push(id);
                    trace.completed.fetch_add(1, Ordering::AcqRel);
                    Ok(Some(JsonValue::Number(id as f64)))
                }
                "host.open" => {
                    let gate = self
                        .gates
                        .lock()
                        .unwrap()
                        .entry(identifier(&input)?)
                        .or_default()
                        .clone();
                    let previous = gate.open.swap(true, Ordering::AcqRel);
                    gate.notification.notify_waiters();
                    Ok(Some(JsonValue::Bool(!previous)))
                }
                "host.gated" => {
                    let id = identifier(&input)?;
                    let gate = self.gates.lock().unwrap().entry(id).or_default().clone();
                    trace.begin(id);
                    loop {
                        let notified = gate.notification.notified();
                        tokio::pin!(notified);
                        notified.as_mut().enable();
                        if gate.open.load(Ordering::Acquire) {
                            trace.complete();
                            return Ok(Some(JsonValue::Number(id as f64)));
                        }
                        tokio::select! {
                            _ = cancellation.cancelled() => {
                                trace.interrupt();
                                return Err(ToolFailure::Cancelled);
                            }
                            _ = notified => {}
                        }
                    }
                }
                "host.pending" => {
                    trace.begin(identifier(&input)?);
                    cancellation.cancelled().await;
                    trace.interrupt();
                    Err(ToolFailure::Cancelled)
                }
                "host.stubborn" => {
                    let Some(JsonValue::Object(fields)) = &input else {
                        return Err(ToolFailure::InvalidInput("Expected cleanupMs".into()));
                    };
                    let Some(JsonValue::Number(cleanup)) = fields.get(&"cleanupMs".into()) else {
                        return Err(ToolFailure::InvalidInput("Expected cleanupMs".into()));
                    };
                    cancellation.cancelled().await;
                    trace.interrupted.fetch_add(1, Ordering::AcqRel);
                    tokio::time::sleep(Duration::from_millis(*cleanup as u64)).await;
                    Err(ToolFailure::Cancelled)
                }
                other => panic!("Unexpected tool {other}"),
            }
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

async fn run(code: &str, limits: ExecutionLimits) -> (Arc<Trace>, ExecutionResult) {
    let host = Arc::new(Host::default());
    let trace = host.trace.clone();
    let runtime = Runtime::new(
        host,
        limits,
        Arc::new(ycoding_core::tools::code_mode::regexp::NativeRegExpEngine),
        code_mode_regexp_fixture::collation(),
    )
    .unwrap();
    (trace, runtime.execute(code, Cancellation::default()).await)
}

fn guarded() -> ExecutionLimits {
    ExecutionLimits {
        timeout_ms: Some(10_000),
        ..ExecutionLimits::default()
    }
}

fn json(text: &str) -> JsonValue {
    parse_json(text).unwrap()
}

fn unhandled(kind: DiagnosticKind, reason: &str) -> (DiagnosticKind, String) {
    (
        kind,
        format!("Unhandled rejection from an un-awaited promise: {reason}"),
    )
}

fn warnings(result: &ExecutionResult) -> Vec<(DiagnosticKind, String)> {
    result
        .warnings
        .iter()
        .map(|warning| (warning.kind.clone(), warning.message.clone()))
        .collect()
}

#[tokio::test]
async fn unawaited_tool_calls_start_eagerly_in_call_order_before_any_await() {
    let (trace, result) = run(
        "const a = tools.host.gated({ id: 1 }); const b = tools.host.gated({ id: 2 }); await tools.host.open({ id: 1 }); await tools.host.open({ id: 2 }); const rb = await b; const ra = await a; return [ra, rb]",
        guarded(),
    )
    .await;
    assert_eq!(result.value, Ok(json("[1,2]")));
    assert_eq!(trace.starts(), [1, 2]);
    assert!(trace.max_active() > 1);
}

#[tokio::test]
async fn fire_and_forget_call_is_interrupted_when_the_program_returns() {
    let (trace, result) = run("tools.host.pending({ id: 1 }); return \"done\"", guarded()).await;
    assert_eq!(result.value, Ok(json("\"done\"")));
    assert!(result.warnings.is_empty());
    assert_eq!((trace.completed(), trace.interrupted()), (0, 1));
}

#[tokio::test]
async fn never_awaited_failing_call_preserves_the_result_and_reports_the_rejection() {
    let (_, result) = run("tools.host.fail({}); return \"done\"", guarded()).await;
    assert_eq!(result.value, Ok(json("\"done\"")));
    assert_eq!(
        warnings(&result),
        [unhandled(DiagnosticKind::ToolFailure, "Lookup refused")]
    );
}

#[tokio::test]
async fn output_truncation_bounds_warning_diagnostics_with_an_in_band_marker() {
    let (_, result) = run(
        "for (let i = 0; i < 100; i += 1) Promise.reject(new Error(\"x\".repeat(1000))); return \"done\"",
        ExecutionLimits {
            max_output_bytes: Some(64),
            ..guarded()
        },
    )
    .await;
    assert_eq!(result.value, Ok(json("\"done\"")));
    assert!(result.truncated);
    assert_eq!(
        warnings(&result),
        [(
            DiagnosticKind::Truncated,
            "100 additional warnings omitted by the output limit.".into()
        )]
    );
}

#[tokio::test]
async fn a_budget_consuming_value_does_not_starve_warnings() {
    let (_, result) = run(
        "Promise.reject(new Error(\"boom\")); return \"x\".repeat(500)",
        ExecutionLimits {
            max_output_bytes: Some(128),
            ..guarded()
        },
    )
    .await;
    assert!(result.truncated);
    assert!(matches!(result.value, Ok(JsonValue::String(_))));
    assert_eq!(
        warnings(&result),
        [unhandled(
            DiagnosticKind::ExecutionFailure,
            "Uncaught: boom"
        )]
    );
}

#[tokio::test]
async fn an_unawaited_async_function_pending_chain_is_interrupted_at_the_return() {
    let (trace, result) = run(
        "const run = async () => { await tools.host.pending({ id: 1 }); tools.host.fail({}) }; run(); return \"done\"",
        guarded(),
    )
    .await;
    assert_eq!(result.value, Ok(json("\"done\"")));
    assert!(result.warnings.is_empty());
    assert_eq!(trace.starts(), [1]);
    assert_eq!((trace.completed(), trace.interrupted()), (0, 1));
}

#[tokio::test]
async fn a_fatal_program_error_cancels_outstanding_work_without_reporting_unhandled_rejections() {
    let (trace, result) = run(
        "tools.host.pending({ id: 1 }); throw new Error(\"boom\")",
        guarded(),
    )
    .await;
    assert_eq!(result.value.unwrap_err()[0].message, "Uncaught: boom");
    assert!(result.warnings.is_empty());
    assert_eq!((trace.completed(), trace.interrupted()), (0, 1));
}

#[tokio::test]
async fn async_function_promises_remain_owned_by_the_execution_after_the_function_returns() {
    let (trace, result) = run(
        "const launch = async () => { tools.host.pending({ id: 1 }); Promise.all([tools.host.pending({ id: 2 })]); return \"returned\" }; return await launch()",
        guarded(),
    )
    .await;
    assert_eq!(result.value, Ok(json("\"returned\"")));
    assert_eq!(trace.starts(), [1, 2]);
    assert_eq!((trace.completed(), trace.interrupted()), (0, 2));
}

#[tokio::test]
async fn invalid_returned_data_cancels_pending_work() {
    let (trace, result) = run(
        "const pending = tools.host.pending({ id: 1 }); return { pending }",
        guarded(),
    )
    .await;
    assert_eq!(
        result.value.unwrap_err()[0].kind,
        DiagnosticKind::InvalidDataValue
    );
    assert_eq!((trace.completed(), trace.interrupted()), (0, 1));
}

#[tokio::test]
async fn separately_created_aggregate_batches_overlap_before_either_is_awaited() {
    let (trace, result) = run(
        "const first = Promise.all([tools.host.gated({ id: 1 })]); const second = Promise.all([tools.host.gated({ id: 2 })]); await tools.host.open({ id: 1 }); await tools.host.open({ id: 2 }); return [await first, await second]",
        guarded(),
    )
    .await;
    assert_eq!(result.value, Ok(json("[[1],[2]]")));
    assert_eq!(trace.starts(), [1, 2]);
    assert!(trace.max_active() > 1);
}

#[tokio::test]
async fn items_map_tool_calls_run_in_parallel() {
    let (trace, result) = run(
        "const ids = [1, 2, 3, 4]; const calls = ids.map((id) => tools.host.gated({ id })); for (const id of ids) await tools.host.open({ id }); return await Promise.all(calls)",
        guarded(),
    )
    .await;
    assert_eq!(result.value, Ok(json("[1,2,3,4]")));
    assert!(trace.max_active() > 1);
}

#[tokio::test]
async fn async_map_callbacks_run_concurrently() {
    let (trace, result) = run(
        "const ids = [1, 2, 3, 4]; const calls = ids.map(async (id) => await tools.host.gated({ id })); for (const id of ids) await tools.host.open({ id }); return await Promise.all(calls)",
        guarded(),
    )
    .await;
    assert_eq!(result.value, Ok(json("[1,2,3,4]")));
    assert!(trace.max_active() > 1);
}

#[tokio::test]
async fn live_tool_call_concurrency_is_not_capped() {
    let (trace, result) = run(
        "const ids = []; for (let i = 0; i < 20; i += 1) ids.push(i); const calls = ids.map((id) => tools.host.gated({ id })); for (const id of ids) await tools.host.open({ id }); const results = await Promise.all(calls); return results.length",
        guarded(),
    )
    .await;
    assert_eq!(result.value, Ok(json("20")));
    assert_eq!(trace.max_active(), 20);
}

#[tokio::test]
async fn a_rejection_settles_before_an_earlier_slow_promise_fulfills() {
    let (trace, result) = run(
        "try { await Promise.all([tools.host.pending({ id: 1 }), tools.host.fail({})]); return -1 } catch { return await tools.host.completed({}) }",
        guarded(),
    )
    .await;
    assert_eq!(result.value, Ok(json("0")));
    assert_eq!((trace.completed(), trace.interrupted()), (0, 1));
}

#[tokio::test]
async fn fail_fast_does_not_cancel_a_sibling_the_program_still_holds_and_awaits() {
    let (trace, result) = run(
        "const slow = tools.host.gated({ id: 1 }); try { await Promise.all([slow, tools.host.fail({})]); return \"no\" } catch {} await tools.host.open({ id: 1 }); return await slow",
        guarded(),
    )
    .await;
    assert_eq!(result.value, Ok(json("1")));
    assert_eq!((trace.completed(), trace.interrupted()), (1, 0));
}

#[tokio::test]
async fn a_slower_observed_sibling_is_interrupted_at_completion_after_failing_fast() {
    let (trace, result) = run(
        "const failLater = async () => { await tools.host.pending({ id: 1 }); throw new Error(\"later\") }; const aggregate = Promise.all([Promise.reject(new Error(\"first\")), failLater()]); try { await aggregate; return \"no\" } catch (error) { return error.message }",
        guarded(),
    )
    .await;
    assert_eq!(result.value, Ok(json("\"first\"")));
    assert_eq!((trace.completed(), trace.interrupted()), (0, 1));
}

#[tokio::test]
async fn exceeding_max_tool_calls_inside_promise_all_is_a_tool_call_limit_diagnostic() {
    let (_, result) = run(
        "return await Promise.all([tools.host.echo({ id: 1 }), tools.host.echo({ id: 2 }), tools.host.echo({ id: 3 })])",
        ExecutionLimits {
            max_tool_calls: Some(2),
            ..guarded()
        },
    )
    .await;
    assert_eq!(
        result.value.unwrap_err()[0].kind,
        DiagnosticKind::ToolCallLimitExceeded
    );
}

#[tokio::test]
async fn first_settlement_wins_and_a_direct_loser_is_interrupted_at_completion() {
    let (trace, result) = run(
        "const fast = tools.host.echo({ id: 1 }); const slow = tools.host.pending({ id: 2 }); return await Promise.race([fast, slow])",
        guarded(),
    )
    .await;
    assert_eq!(result.value, Ok(json("1")));
    assert_eq!((trace.completed(), trace.interrupted()), (1, 1));
}

#[tokio::test]
async fn a_nested_aggregate_loser_and_its_members_are_interrupted_at_completion() {
    let (trace, result) = run(
        "const nested = Promise.all([tools.host.pending({ id: 1 }), tools.host.pending({ id: 2 })]); return await Promise.race([\"immediate\", nested])",
        guarded(),
    )
    .await;
    assert_eq!(result.value, Ok(json("\"immediate\"")));
    assert_eq!((trace.completed(), trace.interrupted()), (0, 2));
}

#[tokio::test]
async fn a_plain_value_wins_over_pending_promises() {
    let (trace, result) = run(
        "return await Promise.race([tools.host.pending({ id: 1 }), \"immediate\"])",
        guarded(),
    )
    .await;
    assert_eq!(result.value, Ok(json("\"immediate\"")));
    assert_eq!((trace.completed(), trace.interrupted()), (0, 1));
}

#[tokio::test]
async fn the_execution_timeout_interrupts_in_flight_calls() {
    let (trace, result) = run(
        "const a = tools.host.pending({ id: 1 }); const b = tools.host.pending({ id: 2 }); return await a",
        ExecutionLimits {
            timeout_ms: Some(100),
            ..ExecutionLimits::default()
        },
    )
    .await;
    assert_eq!(
        result.value.unwrap_err()[0].kind,
        DiagnosticKind::TimeoutExceeded
    );
    assert_eq!(trace.starts(), [1, 2]);
    assert_eq!((trace.completed(), trace.interrupted()), (0, 2));
}

#[tokio::test]
async fn the_timeout_also_interrupts_calls_inside_promise_all() {
    let (trace, result) = run(
        "return await Promise.all([tools.host.pending({ id: 1 }), tools.host.pending({ id: 2 })])",
        ExecutionLimits {
            timeout_ms: Some(100),
            ..ExecutionLimits::default()
        },
    )
    .await;
    assert_eq!(
        result.value.unwrap_err()[0].kind,
        DiagnosticKind::TimeoutExceeded
    );
    assert_eq!(trace.interrupted(), 2);
}

#[tokio::test]
async fn a_non_settling_race_loser_cannot_hold_the_execution_to_the_timeout() {
    let (trace, result) = run(
        "return await Promise.race([\"winner\", tools.host.pending({ id: 1 })])",
        guarded(),
    )
    .await;
    assert_eq!(result.value, Ok(json("\"winner\"")));
    assert!(result.warnings.is_empty());
    assert_eq!(trace.starts(), [1]);
    assert_eq!((trace.completed(), trace.interrupted()), (0, 1));
}

const CLEANUP_WARNING: &str = "The program returned, but background work was still running at the 100ms timeout and was interrupted. Await all started promises.";

#[tokio::test]
async fn a_timeout_during_completion_cleanup_keeps_the_computed_value_and_warns() {
    let (trace, result) = run(
        "tools.host.stubborn({ cleanupMs: 400 }); return \"done\"",
        ExecutionLimits {
            timeout_ms: Some(100),
            ..ExecutionLimits::default()
        },
    )
    .await;
    assert_eq!(result.value, Ok(json("\"done\"")));
    assert_eq!(
        warnings(&result),
        [(DiagnosticKind::TimeoutExceeded, CLEANUP_WARNING.into())]
    );
    assert_eq!((trace.completed(), trace.interrupted()), (0, 1));
}

#[tokio::test]
async fn a_cleanup_timeout_warning_precedes_settled_rejection_warnings() {
    let (_, result) = run(
        "tools.host.fail({}); tools.host.stubborn({ cleanupMs: 400 }); return \"done\"",
        ExecutionLimits {
            timeout_ms: Some(100),
            ..ExecutionLimits::default()
        },
    )
    .await;
    assert_eq!(result.value, Ok(json("\"done\"")));
    assert_eq!(
        warnings(&result),
        [
            (DiagnosticKind::TimeoutExceeded, CLEANUP_WARNING.into()),
            unhandled(DiagnosticKind::ToolFailure, "Lookup refused"),
        ]
    );
}

#[tokio::test]
async fn first_tool_success_wins_and_failing_and_losing_calls_are_handled_silently() {
    let (trace, result) = run(
        "const winner = await Promise.any([tools.host.fail({}), tools.host.echo({ id: 1 }), tools.host.pending({ id: 2 })]); return winner",
        guarded(),
    )
    .await;
    assert_eq!(result.value, Ok(json("1")));
    assert!(result.warnings.is_empty());
    assert_eq!(trace.interrupted(), 1);
}

#[tokio::test]
async fn an_unawaited_constructed_rejection_is_reported_like_any_unhandled_rejection() {
    let (_, result) = run(
        "new Promise((_, reject) => reject(new Error(\"dropped\"))); await Promise.resolve(); await Promise.resolve(); return \"done\"",
        guarded(),
    )
    .await;
    assert_eq!(result.value, Ok(json("\"done\"")));
    assert_eq!(result.warnings.len(), 1);
    assert!(result.warnings[0].message.contains("Unhandled rejection"));
    assert!(result.warnings[0].message.contains("dropped"));
}

#[tokio::test]
async fn promise_returning_string_replacers_are_coerced_synchronously() {
    let (_, result) = run(
        "return \"a1b22\".replace(/\\d+/g, async (match) => await tools.host.decorate(match))",
        guarded(),
    )
    .await;
    assert_eq!(
        result.value,
        Ok(json("\"a[object Promise]b[object Promise]\""))
    );
    let (_, result) = run(
        "return \"a1\".replace(/\\d/, (match) => tools.host.decorate(match))",
        guarded(),
    )
    .await;
    assert_eq!(result.value, Ok(json("\"a[object Promise]\"")));
}

#[tokio::test]
async fn host_boundary_tool_arguments_serialize_dates_and_collections_as_json() {
    let (trace, result) = run(
        "return await tools.host.capture({ when: new Date(0), tags: new Map([[\"a\", 1]]) })",
        guarded(),
    )
    .await;
    assert_eq!(result.value, Ok(json("\"ok\"")));
    let captured = trace.captured.lock().unwrap().clone();
    assert_eq!(
        captured
            .iter()
            .map(|item| item.as_ref().map(stringify_json))
            .collect::<Vec<_>>(),
        [Some(
            "{\"when\":\"1970-01-01T00:00:00.000Z\",\"tags\":{}}".to_owned()
        )]
    );
}

#[tokio::test]
async fn tool_arguments_mirror_json_stringify_for_undefined() {
    let (trace, result) = run(
        "await tools.host.capture({ q: undefined, keep: 1 }); await tools.host.capture([1, undefined, 2]); await tools.host.capture({ nested: { a: undefined, b: [undefined] } }); await tools.host.capture(undefined); return { a: undefined }",
        guarded(),
    )
    .await;
    assert_eq!(result.value, Ok(json("{\"a\":null}")));
    let captured = trace.captured.lock().unwrap().clone();
    assert_eq!(
        captured,
        [
            Some(json("{\"keep\":1}")),
            Some(json("[1,null,2]")),
            Some(json("{\"nested\":{\"b\":[null]}}")),
            None,
        ]
    );
}
