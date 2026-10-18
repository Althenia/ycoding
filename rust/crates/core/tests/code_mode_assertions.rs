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
use ycoding_schema::{JsonObject, JsonValue, LosslessString, parse_json};

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

fn assertion_matches(case: &JsonObject, actual: &JsonValue) -> bool {
    let expected = case.get(&"expected".into()).unwrap();
    if let Some(comparison) = case.get(&"comparison".into()) {
        let (JsonValue::Object(comparison), JsonValue::Array(actual), JsonValue::Array(expected)) =
            (comparison, actual, expected)
        else {
            return false;
        };
        if comparison.get(&"kind".into()) != Some(&JsonValue::String("math-ulp".into()))
            || comparison.get(&"maxUlps".into()) != Some(&JsonValue::Number(1.0))
            || case.get(&"assertion".into()) != Some(&JsonValue::String("toEqual".into()))
            || case.get(&"observe".into()) != Some(&JsonValue::String("value".into()))
            || actual.len() != expected.len()
        {
            return false;
        }
        let Some(JsonValue::Array(indices)) = comparison.get(&"indices".into()) else {
            return false;
        };
        if !indices.iter().enumerate().all(|(position, index)| {
            let JsonValue::Number(index) = index else {
                return false;
            };
            index.is_finite()
                && *index >= 0.0
                && index.fract() == 0.0
                && *index < expected.len() as f64
                && (position == 0
                    || matches!(indices[position - 1], JsonValue::Number(previous) if previous < *index))
        }) {
            return false;
        }
        return actual
            .iter()
            .zip(expected)
            .enumerate()
            .all(|(index, (actual, expected))| {
                let (JsonValue::Number(actual), JsonValue::Number(expected)) = (actual, expected)
                else {
                    return false;
                };
                // Corpus Math values are finite. Never let proximity hide NaN,
                // overflow, a changed sign, or the distinction between signed zeros.
                if !actual.is_finite() || !expected.is_finite() {
                    return false;
                }
                if indices.contains(&JsonValue::Number(index as f64))
                    && *actual != 0.0
                    && *expected != 0.0
                    && actual.is_sign_negative() == expected.is_sign_negative()
                {
                    return actual.to_bits().abs_diff(expected.to_bits()) <= 1;
                }
                actual.to_bits() == expected.to_bits()
            });
    }
    match text(case.get(&"assertion".into()).unwrap()).as_str() {
        "toContain" => {
            matches!(actual, JsonValue::String(_)) && text(actual).contains(&text(expected))
        }
        "not.toContain" => {
            matches!(actual, JsonValue::String(_)) && !text(actual).contains(&text(expected))
        }
        _ => actual == expected,
    }
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
        if !assertion_matches(case, &actual) {
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

fn math_case() -> JsonObject {
    let fixture = corpus();
    let Some(JsonValue::Array(cases)) = fixture.get(&"cases".into()) else {
        panic!("An assertion corpus must declare cases")
    };
    let cases = cases
        .iter()
        .filter_map(|case| match case {
            JsonValue::Object(case) if case.get(&"comparison".into()).is_some() => Some(case),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        cases.len(),
        1,
        "only the host-Math vector permits approximation"
    );
    cases[0].clone()
}

#[test]
fn math_comparison_metadata_preserves_exact_non_transcendental_entries() {
    let case = math_case();
    assert_eq!(text(case.get(&"suite".into()).unwrap()), "stdlib");
    assert_eq!(
        text(case.get(&"test".into()).unwrap()),
        "deterministic Math methods match the host runtime"
    );
    assert_eq!(
        case.get(&"comparison".into()),
        Some(
            &parse_json(
                r#"{"kind":"math-ulp","maxUlps":1,"indices":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14]}"#
            )
            .unwrap()
        )
    );
    let JsonValue::Array(expected) = case.get(&"expected".into()).unwrap() else {
        panic!("The host-Math result must be an array")
    };
    assert_eq!(expected.len(), 19);
    assert!(assertion_matches(
        &case,
        &JsonValue::Array(expected.clone())
    ));
    for (index, value) in expected.iter().enumerate() {
        let JsonValue::Number(value) = value else {
            panic!("The host-Math result must contain numbers")
        };
        for ulps in [-2, -1, 1, 2] {
            let mut actual = expected.clone();
            actual[index] = JsonValue::Number(f64::from_bits(
                value.to_bits().checked_add_signed(ulps).unwrap(),
            ));
            assert_eq!(
                assertion_matches(&case, &JsonValue::Array(actual)),
                index < 15 && ulps.abs() == 1,
                "index {index}, distance {ulps} ULP"
            );
        }
    }
    let mut exact = JsonObject::new();
    exact.insert("assertion".into(), JsonValue::String("toEqual".into()));
    exact.insert("expected".into(), JsonValue::Array(expected.clone()));
    let mut actual = expected.clone();
    let JsonValue::Number(first) = actual[0] else {
        unreachable!()
    };
    actual[0] = JsonValue::Number(f64::from_bits(first.to_bits() + 1));
    assert!(!assertion_matches(&exact, &JsonValue::Array(actual)));
    assert!(assertion_matches(
        &exact,
        &JsonValue::Array(expected.clone())
    ));
    assert!(!assertion_matches(
        &case,
        &JsonValue::Array(expected[1..].to_vec())
    ));
    let mut actual = expected.clone();
    actual[0] = JsonValue::Null;
    assert!(!assertion_matches(&case, &JsonValue::Array(actual)));
}

#[test]
fn math_comparison_rejects_nonfinite_values_wrong_signs_and_signed_zero_changes() {
    let mut case = math_case();
    let JsonValue::Array(expected) = case.get(&"expected".into()).unwrap() else {
        unreachable!()
    };
    let expected = expected.clone();
    for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0, 0.0, -0.0] {
        let mut actual = expected.clone();
        actual[0] = JsonValue::Number(value);
        assert!(
            !assertion_matches(&case, &JsonValue::Array(actual)),
            "{value:?}"
        );
    }
    for (wanted, actual, matches) in [
        (0.0, 0.0, true),
        (-0.0, -0.0, true),
        (0.0, -0.0, false),
        (-0.0, 0.0, false),
        (0.0, f64::from_bits(1), false),
        (-0.0, -f64::from_bits(1), false),
        (-1.0, f64::from_bits((-1.0_f64).to_bits() + 1), true),
        (-1.0, 1.0, false),
        (f64::NAN, f64::NAN, false),
        (f64::INFINITY, f64::INFINITY, false),
    ] {
        let mut values = expected.clone();
        values[0] = JsonValue::Number(wanted);
        case.insert("expected".into(), JsonValue::Array(values.clone()));
        values[0] = JsonValue::Number(actual);
        assert_eq!(
            assertion_matches(&case, &JsonValue::Array(values)),
            matches,
            "{wanted:?}, {actual:?}"
        );
    }
}

#[tokio::test]
async fn transcendental_math_preserves_specified_special_values() {
    let runtime = Runtime::new(
        Arc::new(Host::default()),
        ExecutionLimits::default(),
        Arc::new(ycoding_core::tools::code_mode::regexp::NativeRegExpEngine),
        code_mode_regexp_fixture::collation(),
    )
    .unwrap();
    // Observe special values before the JSON result boundary normalizes them.
    let result = runtime.execute(
        "return [
            Number.isNaN(Math.acos(NaN)), Number.isNaN(Math.acos(2)), Number.isNaN(Math.acos(-2)),
            Number.isNaN(Math.asin(NaN)), Number.isNaN(Math.asin(2)), Number.isNaN(Math.asin(-2)),
            Number.isNaN(Math.atanh(NaN)), Number.isNaN(Math.atanh(2)), Number.isNaN(Math.atanh(-2)),
            Object.is(Math.acos(1), 0),
            Object.is(Math.asin(0), 0), Object.is(Math.asin(-0), -0),
            Object.is(Math.atanh(0), 0), Object.is(Math.atanh(-0), -0),
            Math.atanh(1) === Infinity, Math.atanh(-1) === -Infinity
        ]",
        Cancellation::default(),
    ).await;
    assert_eq!(
        result.value.unwrap(),
        JsonValue::Array(vec![JsonValue::Bool(true); 16])
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
