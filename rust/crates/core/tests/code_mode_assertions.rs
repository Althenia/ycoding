mod code_mode_regexp_fixture;
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::Notify;
use ycoding_core::tools::code_mode::{
    Cancellation, ExecutionLimits, ExecutionResult, Runtime, ToolDescription, ToolFailure,
    ToolFuture, ToolHost,
};
use ycoding_schema::{JsonValue, LosslessString, parse_json};

#[derive(Default)]
struct Gate {
    open: AtomicBool,
    notification: Notify,
}
#[derive(Default)]
struct Host {
    gates: Mutex<BTreeMap<String, Arc<Gate>>>,
    completed: std::sync::atomic::AtomicUsize,
}
impl ToolHost for Host {
    fn catalog(&self) -> Vec<ToolDescription> {
        [
            "echo",
            "gated",
            "open",
            "fail",
            "pending",
            "completed",
            "interrupt",
        ]
        .into_iter()
        .map(|name| ToolDescription {
            path: format!("host.{name}").into(),
            description: name.into(),
            signature: format!("tools.host.{name}(input: {{id: number}}): Promise<number>"),
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
            if path.as_str() == Some("host.completed") {
                return Ok(Some(JsonValue::Number(
                    self.completed.load(Ordering::Acquire) as f64,
                )));
            }
            if path.as_str() == Some("host.interrupt") {
                return Err(ToolFailure::Cancelled);
            }
            if path.as_str() == Some("host.fail") {
                return Err(ToolFailure::Safe("Lookup refused".into()));
            }
            let Some(JsonValue::Object(input)) = input else {
                return Err(ToolFailure::InvalidInput("Expected id input".into()));
            };
            let id = input
                .get(&"id".into())
                .cloned()
                .ok_or_else(|| ToolFailure::InvalidInput("Expected id input".into()))?;
            if path.as_str() == Some("host.echo") {
                self.completed.fetch_add(1, Ordering::AcqRel);
                return Ok(Some(id));
            }
            if path.as_str() == Some("host.pending") {
                cancellation.cancelled().await;
                return Err(ToolFailure::Cancelled);
            }
            let gate = self
                .gates
                .lock()
                .unwrap()
                .entry(ycoding_schema::stringify_json(&id))
                .or_default()
                .clone();
            if path.as_str() == Some("host.open") {
                let previous = gate.open.swap(true, Ordering::AcqRel);
                gate.notification.notify_waiters();
                return Ok(Some(JsonValue::Bool(!previous)));
            }
            loop {
                let notified = gate.notification.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if gate.open.load(Ordering::Acquire) {
                    self.completed.fetch_add(1, Ordering::AcqRel);
                    return Ok(Some(id));
                }
                tokio::select! { _ = cancellation.cancelled() => return Err(ToolFailure::Cancelled), _ = notified => {} }
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

fn corpus() -> ycoding_schema::JsonObject {
    let JsonValue::Object(fixture) = parse_json(include_str!("code-mode-assertions.json")).unwrap()
    else {
        panic!("An assertion corpus must be an object")
    };
    fixture
}

fn text(value: &JsonValue) -> String {
    let JsonValue::String(value) = value else {
        panic!("Expected a string: {value:?}")
    };
    value.to_utf8().unwrap()
}

fn observation(result: &ExecutionResult, observe: &str) -> Result<JsonValue, String> {
    let string = |value: String| JsonValue::String(value.into());
    let failure = || {
        result
            .value
            .as_ref()
            .err()
            .map(|errors| errors[0].clone())
            .ok_or_else(|| format!("expected a failure, got {:?}", result.value))
    };
    Ok(match observe {
        "value" => result
            .value
            .clone()
            .map_err(|errors| format!("expected success, got {errors:?}"))?,
        "ok" => JsonValue::Bool(result.value.is_ok()),
        "error.message" => string(failure()?.message),
        "error.kind" => string(format!("{:?}", failure()?.kind)),
        "logs.length" => JsonValue::Number(result.logs.len() as f64),
        "warnings" => JsonValue::Array(
            result
                .warnings
                .iter()
                .map(|warning| {
                    let mut object = ycoding_schema::JsonObject::new();
                    object.insert("kind".into(), string(format!("{:?}", warning.kind)));
                    object.insert("message".into(), string(warning.message.clone()));
                    JsonValue::Object(object)
                })
                .collect(),
        ),
        "toolCalls" => JsonValue::Array(
            result
                .tool_calls
                .iter()
                .map(|name| {
                    let mut object = ycoding_schema::JsonObject::new();
                    object.insert("name".into(), JsonValue::String(name.clone()));
                    JsonValue::Object(object)
                })
                .collect(),
        ),
        "logs" => JsonValue::Array(result.logs.iter().cloned().map(JsonValue::String).collect()),
        other => {
            let index = other
                .strip_prefix("logs[")
                .and_then(|rest| rest.strip_suffix(']'))
                .ok_or_else(|| format!("unknown observation {other}"))?
                .parse::<usize>()
                .map_err(|error| error.to_string())?;
            JsonValue::String(
                result
                    .logs
                    .get(index)
                    .ok_or_else(|| format!("missing log line {index}: {:?}", result.logs))?
                    .clone(),
            )
        }
    })
}

#[tokio::test]
async fn committed_typescript_literal_assertions() {
    let fixture = corpus();
    let Some(JsonValue::Array(cases)) = fixture.get(&"cases".into()) else {
        panic!("An assertion corpus must declare cases")
    };
    assert!(!cases.is_empty());
    let mut failures = Vec::new();
    for case in cases {
        let runtime = Runtime::new(
            Arc::new(Host::default()),
            ExecutionLimits {
                timeout_ms: Some(1_000),
                ..ExecutionLimits::default()
            },
            Arc::new(ycoding_core::tools::code_mode::regexp::NativeRegExpEngine),
            code_mode_regexp_fixture::collation(),
        )
        .unwrap();
        let JsonValue::Object(case) = case else {
            panic!("An assertion must be an object")
        };
        let code = text(
            case.get(&"code".into())
                .expect("An assertion must declare literal code"),
        );
        let result = runtime
            .execute(code.as_str(), Cancellation::default())
            .await;
        let expected = case.get(&"expected".into()).unwrap();
        let label = format!(
            "{}:{} {} [{}]",
            text(case.get(&"suite".into()).unwrap()),
            case.get(&"at".into())
                .map(|at| format!("{at:?}"))
                .unwrap_or_default(),
            code,
            text(case.get(&"observe".into()).unwrap())
        );
        let actual = match observation(&result, &text(case.get(&"observe".into()).unwrap())) {
            Ok(actual) => actual,
            Err(message) => {
                failures.push(format!("{label}: {message}"));
                continue;
            }
        };
        let matched = match text(case.get(&"assertion".into()).unwrap()).as_str() {
            "toContain" => {
                matches!(&actual, JsonValue::String(_)) && text(&actual).contains(&text(expected))
            }
            "not.toContain" => {
                matches!(&actual, JsonValue::String(_)) && !text(&actual).contains(&text(expected))
            }
            _ => &actual == expected,
        };
        if !matched {
            failures.push(format!("{label}: expected {expected:?}, got {actual:?}"));
        }
    }
    assert!(
        failures.is_empty(),
        "{} failures:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn manual_translations_name_existing_rust_tests_and_exclusions_state_concrete_reasons() {
    let fixture = corpus();
    let Some(JsonValue::Array(manual)) = fixture.get(&"manual".into()) else {
        panic!("An assertion corpus must declare manual translations")
    };
    for entry in manual {
        let JsonValue::Object(entry) = entry else {
            panic!("A manual translation must be an object")
        };
        let file = text(entry.get(&"file".into()).unwrap());
        let rust = text(entry.get(&"rust".into()).unwrap());
        let source = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests")
                .join(&file),
        )
        .unwrap_or_else(|error| panic!("{file}: {error}"));
        let lines = source.lines().collect::<Vec<_>>();
        let declared = lines.iter().enumerate().any(|(index, line)| {
            let line = line.trim_start();
            (line.starts_with(&format!("fn {rust}("))
                || line.starts_with(&format!("async fn {rust}(")))
                && index > 0
                && matches!(lines[index - 1].trim(), "#[test]" | "#[tokio::test]")
        });
        assert!(declared, "{file} must declare test {rust}: {entry:?}");
    }
    let Some(JsonValue::Array(excluded)) = fixture.get(&"excluded".into()) else {
        panic!("An assertion corpus must declare exclusions")
    };
    for entry in excluded {
        let JsonValue::Object(entry) = entry else {
            panic!("An exclusion must be an object")
        };
        let reason = text(entry.get(&"reason".into()).unwrap());
        assert!(
            !reason.starts_with("observation requires")
                && !reason.starts_with("assertion requires"),
            "An exclusion must state a concrete reason: {entry:?}"
        );
    }
}

#[tokio::test]
async fn sort_comparators_are_validated_even_when_nothing_is_compared() {
    let runtime = Runtime::new(
        Arc::new(Host::default()),
        ExecutionLimits::default(),
        Arc::new(ycoding_core::tools::code_mode::regexp::NativeRegExpEngine),
        code_mode_regexp_fixture::collation(),
    )
    .unwrap();
    for (code, expected) in [
        (
            "return [1].sort(42)",
            "Array.sort expects a function callback",
        ),
        (
            "return [].toSorted('x')",
            "Array.toSorted expects a function callback",
        ),
    ] {
        let diagnostics = runtime
            .execute(code, Cancellation::default())
            .await
            .value
            .unwrap_err();
        assert!(
            diagnostics[0].message.contains(expected),
            "{code}: {diagnostics:?}"
        );
    }
}
