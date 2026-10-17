use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, parse_json, provider_request, session_cache_diagnostics,
};

const NEW_GROUPS: [&str; 7] = [
    "provider",
    "provider-profile-model",
    "provider-model",
    "model-id",
    "profile",
    "prompt",
    "task",
];
const OLD_GROUPS: [&str; 7] = [
    "model", "hour", "day", "month", "session", "project", "agent",
];
const TOKENS: &str = r#"{"input":1,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}"#;

fn json(value: &str) -> JsonValue {
    parse_json(value).unwrap()
}

fn at<'a>(value: &'a JsonValue, path: &str) -> &'a JsonValue {
    path.split('.').fold(value, |value, part| match value {
        JsonValue::Array(items) => &items[part.parse::<usize>().unwrap()],
        JsonValue::Object(object) => object
            .get(&part.into())
            .unwrap_or_else(|| panic!("missing {part} in {path}")),
        _ => panic!("cannot descend into {part} in {path}"),
    })
}

fn has(value: &JsonValue, path: &str) -> bool {
    let (parent, last) = path.rsplit_once('.').unwrap_or(("", path));
    let parent = if parent.is_empty() {
        value
    } else {
        at(value, parent)
    };
    matches!(parent, JsonValue::Object(object) if object.get(&last.into()).is_some())
}

fn text(value: &JsonValue, path: &str) -> String {
    match at(value, path) {
        JsonValue::String(text) => text.to_utf8().unwrap(),
        other => panic!("string expected at {path}: {other:?}"),
    }
}

fn input(value: &str) -> Result<provider_request::ReportInput, ycoding_schema::DecodeError> {
    provider_request::ReportInput::decode(&json(value))
}

fn speed(value: &str) -> Result<provider_request::Speed, ycoding_schema::DecodeError> {
    provider_request::Speed::decode(&json(value))
}

fn timing(value: &str) -> Result<provider_request::Timing, ycoding_schema::DecodeError> {
    provider_request::Timing::decode(&json(value))
}

fn metrics(extra: &str) -> String {
    format!(
        r#""logical":1,"physical":1,"helpers":0,"continued":0,"fallback":0,"tokens":{TOKENS}{extra}"#
    )
}

fn row(extra: &str) -> String {
    format!(r#"{{"key":"k","label":"l",{}}}"#, metrics(extra))
}

fn report(group: &str, rows: &[String], total_extra: &str) -> String {
    format!(
        r#"{{"group":"{group}","rows":[{}],"total":{{{}}},"rowCount":{}}}"#,
        rows.join(","),
        metrics(total_extra),
        rows.len()
    )
}

fn decode_report(value: &str) -> Result<provider_request::Report, ycoding_schema::DecodeError> {
    provider_request::Report::decode(&json(value))
}

fn dimension(group: &str) -> String {
    match group {
        "provider" => r#"{"group":"provider","providerID":"openai"}"#.into(),
        "provider-profile-model" => r#"{"group":"provider-profile-model","providerID":"openai","profile":"work","profileState":"recorded","modelID":"gpt"}"#.into(),
        "provider-model" => r#"{"group":"provider-model","providerID":"openai","modelID":"gpt"}"#.into(),
        "model-id" => r#"{"group":"model-id","modelID":"gpt"}"#.into(),
        "profile" => r#"{"group":"profile","providerID":"openai","profile":"work","profileState":"recorded"}"#.into(),
        "prompt" => r#"{"group":"prompt","anchor":{"sessionID":"ses_one","inputID":"msg_one"},"attribution":"complete"}"#.into(),
        "task" => r#"{"group":"task","sessionID":"ses_task","attribution":"complete"}"#.into(),
        other => panic!("not a new group: {other}"),
    }
}

#[test]
fn the_seven_new_groups_decode_and_the_existing_seven_keep_decoding() {
    for group in OLD_GROUPS.into_iter().chain(NEW_GROUPS) {
        let decoded = input(&format!(r#"{{"group":"{group}"}}"#)).unwrap();
        assert_eq!(text(&decoded.encode(), "group"), group);
    }
    for invalid in [
        "models",
        "Provider",
        "provider-profile",
        "tasks",
        "",
        "prompts",
    ] {
        assert!(
            input(&format!(r#"{{"group":"{invalid}"}}"#)).is_err(),
            "{invalid}"
        );
    }
    for group in NEW_GROUPS {
        let empty = report(group, &[], "");
        assert_eq!(
            text(&decode_report(&empty).unwrap().encode(), "group"),
            group
        );
    }
}

#[test]
fn the_four_filters_are_nonempty_strings_that_round_trip_beside_unchanged_paging() {
    let full = input(
        r#"{"group":"provider","providerID":"openai","profile":"work","modelID":"gpt","selectedEffort":"high","offset":5,"limit":200,"sort":"cost","order":"desc"}"#,
    )
    .unwrap();
    let encoded = full.encode();
    for (key, expected) in [
        ("providerID", "openai"),
        ("profile", "work"),
        ("modelID", "gpt"),
        ("selectedEffort", "high"),
    ] {
        assert_eq!(text(&encoded, key), expected, "{key}");
    }
    assert_eq!(input_again(&encoded), full);
    let bare = input(r#"{"group":"provider"}"#).unwrap().encode();
    for key in ["providerID", "profile", "modelID", "selectedEffort"] {
        assert!(!has(&bare, key), "{key} must be absent when not requested");
    }
    for key in ["providerID", "profile", "modelID", "selectedEffort"] {
        for invalid in [r#""""#, "null", "1", "true", r#"["x"]"#, r#"{"a":"b"}"#] {
            assert!(
                input(&format!(r#"{{"group":"provider","{key}":{invalid}}}"#)).is_err(),
                "{key}={invalid}"
            );
        }
    }
    assert!(input(r#"{"group":"provider","limit":201}"#).is_err());
    assert!(input(r#"{"group":"provider","limit":0}"#).is_err());
    assert!(input(r#"{"group":"provider","from":9,"to":9}"#).is_err());
}

fn input_again(value: &JsonValue) -> provider_request::ReportInput {
    provider_request::ReportInput::decode(value).unwrap()
}

#[test]
fn every_new_group_row_carries_its_typed_dimensions_and_no_model() {
    for group in NEW_GROUPS {
        let valid = report(
            group,
            &[row(&format!(r#","dimensions":{}"#, dimension(group)))],
            "",
        );
        let decoded = decode_report(&valid).unwrap();
        let encoded = decoded.encode();
        assert_eq!(text(&encoded, "rows.0.dimensions.group"), group);
        assert!(
            !has(&encoded, "rows.0.model"),
            "{group}: no representative model"
        );
        assert_eq!(decode_report(&encoded.encode_string()).unwrap(), decoded);

        let missing = report(group, &[row("")], "");
        assert!(decode_report(&missing).is_err(), "{group}: dimensions");
        let with_model = report(
            group,
            &[row(&format!(
                r#","model":{{"providerID":"openai","id":"gpt"}},"dimensions":{}"#,
                dimension(group)
            ))],
            "",
        );
        assert!(decode_report(&with_model).is_err(), "{group}: model");
        let other = NEW_GROUPS
            .into_iter()
            .find(|candidate| *candidate != group)
            .unwrap();
        let mismatched = report(
            group,
            &[row(&format!(r#","dimensions":{}"#, dimension(other)))],
            "",
        );
        assert!(decode_report(&mismatched).is_err(), "{group}: mismatch");
    }
}

trait EncodeString {
    fn encode_string(&self) -> String;
}

impl EncodeString for JsonValue {
    fn encode_string(&self) -> String {
        ycoding_schema::stringify_json(self)
    }
}

#[test]
fn model_rows_keep_their_model_and_never_gain_dimensions() {
    let valid = report(
        "model",
        &[row(
            r#","model":{"providerID":"openai","id":"gpt","variant":"high","profile":"work"}"#,
        )],
        "",
    );
    let encoded = decode_report(&valid).unwrap().encode();
    assert_eq!(text(&encoded, "rows.0.model.providerID"), "openai");
    assert_eq!(text(&encoded, "rows.0.model.variant"), "high");
    assert_eq!(text(&encoded, "rows.0.model.profile"), "work");
    assert!(!has(&encoded, "rows.0.dimensions"));
}

#[test]
fn profile_state_is_recorded_exactly_when_a_profile_is_present() {
    let accepted = [
        r#"{"group":"profile","providerID":"openai","profile":"work","profileState":"recorded"}"#,
        r#"{"group":"profile","providerID":"openai","profileState":"provider-default"}"#,
        r#"{"group":"provider-profile-model","providerID":"openai","profileState":"provider-default","modelID":"gpt"}"#,
        r#"{"group":"provider-profile-model","providerID":"openai","profile":"work","profileState":"recorded","modelID":"gpt"}"#,
    ];
    for dimensions in accepted {
        let group = text(&json(dimensions), "group");
        let value = report(
            &group,
            &[row(&format!(r#","dimensions":{dimensions}"#))],
            "",
        );
        let encoded = decode_report(&value).unwrap().encode();
        let state = text(&encoded, "rows.0.dimensions.profileState");
        assert_eq!(
            state == "recorded",
            has(&encoded, "rows.0.dimensions.profile"),
            "{dimensions}"
        );
    }
    let rejected = [
        r#"{"group":"profile","providerID":"openai","profileState":"recorded"}"#,
        r#"{"group":"profile","providerID":"openai","profile":"work","profileState":"provider-default"}"#,
        r#"{"group":"profile","providerID":"openai","profile":"work"}"#,
        r#"{"group":"profile","providerID":"openai","profileState":"current-default"}"#,
        r#"{"group":"profile","profileState":"provider-default"}"#,
        r#"{"group":"provider-profile-model","providerID":"openai","profileState":"recorded","modelID":"gpt"}"#,
        r#"{"group":"provider-profile-model","providerID":"openai","profile":"work","profileState":"provider-default","modelID":"gpt"}"#,
        r#"{"group":"provider-profile-model","providerID":"openai","profileState":"provider-default"}"#,
    ];
    for dimensions in rejected {
        let group = text(&json(dimensions), "group");
        let value = report(
            &group,
            &[row(&format!(r#","dimensions":{dimensions}"#))],
            "",
        );
        assert!(decode_report(&value).is_err(), "{dimensions}");
    }
}

#[test]
fn prompt_and_task_dimensions_distinguish_attribution_levels() {
    for (group, dimensions) in [
        (
            "prompt",
            r#"{"group":"prompt","attribution":"unattributed"}"#,
        ),
        (
            "prompt",
            r#"{"group":"prompt","anchor":{"sessionID":"ses_one","inputID":"msg_one"},"attribution":"partial"}"#,
        ),
        ("task", r#"{"group":"task","attribution":"unattributed"}"#),
        (
            "task",
            r#"{"group":"task","sessionID":"ses_task","attribution":"partial"}"#,
        ),
    ] {
        let value = report(group, &[row(&format!(r#","dimensions":{dimensions}"#))], "");
        assert!(decode_report(&value).is_ok(), "{dimensions}");
    }
    for (group, dimensions) in [
        (
            "prompt",
            r#"{"group":"prompt","attribution":"complete-ish"}"#,
        ),
        ("prompt", r#"{"group":"prompt"}"#),
        (
            "prompt",
            r#"{"group":"prompt","anchor":{"sessionID":"ses_one"},"attribution":"complete"}"#,
        ),
        (
            "prompt",
            r#"{"group":"prompt","anchor":null,"attribution":"unattributed"}"#,
        ),
        ("task", r#"{"group":"task"}"#),
        (
            "task",
            r#"{"group":"task","sessionID":"msg_task","attribution":"complete"}"#,
        ),
        (
            "task",
            r#"{"group":"task","sessionID":null,"attribution":"unattributed"}"#,
        ),
    ] {
        let value = report(group, &[row(&format!(r#","dimensions":{dimensions}"#))], "");
        assert!(decode_report(&value).is_err(), "{dimensions}");
    }
}

#[test]
fn cost_coverage_counts_priced_and_unpriced_requests_on_rows_and_totals() {
    let value = report(
        "agent",
        &[row(
            r#","costCoverage":{"pricedRequests":0,"unpricedRequests":3}"#,
        )],
        r#","costCoverage":{"pricedRequests":2,"unpricedRequests":0}"#,
    );
    let encoded = decode_report(&value).unwrap().encode();
    assert_eq!(
        at(&encoded, "rows.0.costCoverage"),
        &json(r#"{"pricedRequests":0,"unpricedRequests":3}"#)
    );
    assert_eq!(
        at(&encoded, "total.costCoverage"),
        &json(r#"{"pricedRequests":2,"unpricedRequests":0}"#)
    );
    let bare = decode_report(&report("agent", &[row("")], ""))
        .unwrap()
        .encode();
    assert!(!has(&bare, "rows.0.costCoverage"));
    assert!(!has(&bare, "total.costCoverage"));
    for invalid in [
        r#"{"pricedRequests":1}"#,
        r#"{"unpricedRequests":1}"#,
        r#"{"pricedRequests":-1,"unpricedRequests":0}"#,
        r#"{"pricedRequests":1.5,"unpricedRequests":0}"#,
        r#"{"pricedRequests":null,"unpricedRequests":0}"#,
    ] {
        assert!(
            decode_report(&report(
                "agent",
                &[row(&format!(r#","costCoverage":{invalid}"#))],
                ""
            ))
            .is_err(),
            "row {invalid}"
        );
        assert!(
            decode_report(&report(
                "agent",
                &[row("")],
                &format!(r#","costCoverage":{invalid}"#)
            ))
            .is_err(),
            "total {invalid}"
        );
    }
    assert!(
        provider_request::CostCoverage::decode(&json(
            r#"{"pricedRequests":4,"unpricedRequests":0}"#
        ))
        .is_ok()
    );
}

#[test]
fn speed_exposes_the_generation_population_and_exact_percentile_fields() {
    let full = speed(
        r#"{"firstOutputP50Ms":20,"firstOutputP95Ms":40,"totalP50Ms":200,"totalP95Ms":400,"outputTokensPerSecond":5,"generationSamples":3,"generationP50TokensPerSecond":5.5,"generationP90TokensPerSecond":9,"providerTimedSamples":2,"observedSamples":1,"samples":4}"#,
    )
    .unwrap();
    let encoded = full.encode();
    for (key, expected) in [
        ("generationSamples", 3.0),
        ("providerTimedSamples", 2.0),
        ("observedSamples", 1.0),
        ("samples", 4.0),
        ("generationP50TokensPerSecond", 5.5),
        ("generationP90TokensPerSecond", 9.0),
    ] {
        assert_eq!(at(&encoded, key), &JsonValue::Number(expected), "{key}");
    }
    assert_eq!(provider_request::Speed::decode(&encoded).unwrap(), full);

    let counts_only = speed(
        r#"{"generationSamples":0,"providerTimedSamples":0,"observedSamples":0,"samples":2}"#,
    )
    .unwrap()
    .encode();
    assert!(!has(&counts_only, "generationP50TokensPerSecond"));
    assert!(!has(&counts_only, "generationP90TokensPerSecond"));
    assert!(!has(&counts_only, "outputTokensPerSecond"));

    for missing in [
        "generationSamples",
        "providerTimedSamples",
        "observedSamples",
        "samples",
    ] {
        let mut fields = vec![
            ("generationSamples", "1"),
            ("providerTimedSamples", "1"),
            ("observedSamples", "0"),
            ("samples", "1"),
        ];
        fields.retain(|(key, _)| *key != missing);
        let body = fields
            .iter()
            .map(|(key, value)| format!(r#""{key}":{value}"#))
            .collect::<Vec<_>>()
            .join(",");
        assert!(speed(&format!("{{{body}}}")).is_err(), "missing {missing}");
    }
    let base = |extra: &str| {
        format!(
            r#"{{"generationSamples":1,"providerTimedSamples":1,"observedSamples":0,"samples":1{extra}}}"#
        )
    };
    for invalid in [
        r#","generationP50TokensPerSecond":-0.5"#,
        r#","generationP90TokensPerSecond":-1"#,
        r#","generationP50TokensPerSecond":null"#,
        r#","generationP90TokensPerSecond":"9""#,
    ] {
        assert!(speed(&base(invalid)).is_err(), "{invalid}");
    }
    for invalid in [
        r#"{"generationSamples":-1,"providerTimedSamples":0,"observedSamples":0,"samples":0}"#,
        r#"{"generationSamples":1.5,"providerTimedSamples":0,"observedSamples":0,"samples":0}"#,
        r#"{"generationSamples":0,"providerTimedSamples":-2,"observedSamples":0,"samples":0}"#,
        r#"{"generationSamples":0,"providerTimedSamples":0,"observedSamples":0.5,"samples":0}"#,
    ] {
        assert!(speed(invalid).is_err(), "{invalid}");
    }
    assert!(speed(&base(r#","generationP50TokensPerSecond":0"#)).is_ok());
}

#[test]
fn estimated_timing_is_stored_as_positive_integers_beside_measured_fields() {
    let value = timing(
        r#"{"firstOutputMs":5,"generatedTokens":7,"generationDurationNs":2000000000,"estimatedTokens":9,"estimatedGenerationDurationNs":3000000000}"#,
    )
    .unwrap();
    let encoded = value.encode();
    assert_eq!(at(&encoded, "estimatedTokens"), &JsonValue::Number(9.0));
    assert_eq!(
        at(&encoded, "estimatedGenerationDurationNs"),
        &JsonValue::Number(3_000_000_000.0)
    );
    assert_eq!(at(&encoded, "generatedTokens"), &JsonValue::Number(7.0));
    assert_eq!(provider_request::Timing::decode(&encoded).unwrap(), value);
    let only_estimated = timing(r#"{"estimatedTokens":1,"estimatedGenerationDurationNs":1}"#)
        .unwrap()
        .encode();
    assert!(!has(&only_estimated, "generatedTokens"));
    for invalid in [
        r#"{"estimatedTokens":0}"#,
        r#"{"estimatedGenerationDurationNs":0}"#,
        r#"{"estimatedTokens":-1}"#,
        r#"{"estimatedTokens":1.5}"#,
        r#"{"estimatedGenerationDurationNs":null}"#,
        r#"{"estimatedTokens":"3"}"#,
    ] {
        assert!(timing(invalid).is_err(), "{invalid}");
    }
}

#[test]
fn generation_speed_history_names_its_model_reason_and_estimated_flag() {
    let sample = |extra: &str| {
        format!(
            r#"{{"model":{{"providerID":"openai","id":"gpt"}},"tokens":10,"durationNs":2000000000,"tokensPerSecond":5{extra}}}"#
        )
    };
    let estimated =
        session_cache_diagnostics::GenerationSpeed::decode(&json(&sample(r#","estimated":true"#)))
            .unwrap();
    assert_eq!(at(&estimated.encode(), "estimated"), &JsonValue::Bool(true));
    let measured = session_cache_diagnostics::GenerationSpeed::decode(&json(&sample(""))).unwrap();
    assert!(!has(&measured.encode(), "estimated"));
    for invalid in [
        r#","estimated":null"#,
        r#","estimated":"yes""#,
        r#","estimated":1"#,
    ] {
        assert!(
            session_cache_diagnostics::GenerationSpeed::decode(&json(&sample(invalid))).is_err(),
            "{invalid}"
        );
    }
    let history = format!(
        r#"{{"model":{{"providerID":"openai","id":"gpt","variant":"high"}},"unreportedReason":"no timed output","latest":{},"recent":[{}]}}"#,
        sample(""),
        sample("")
    );
    let decoded =
        session_cache_diagnostics::GenerationSpeedHistory::decode(&json(&history)).unwrap();
    let encoded = decoded.encode();
    assert_eq!(text(&encoded, "model.id"), "gpt");
    assert_eq!(text(&encoded, "model.variant"), "high");
    assert_eq!(text(&encoded, "unreportedReason"), "no timed output");
    let bare = session_cache_diagnostics::GenerationSpeedHistory::decode(&json(r#"{"recent":[]}"#))
        .unwrap()
        .encode();
    assert!(!has(&bare, "model"));
    assert!(!has(&bare, "unreportedReason"));
    for invalid in [
        r#","model":null"#,
        r#","unreportedReason":null"#,
        r#","unreportedReason":3"#,
    ] {
        assert!(
            session_cache_diagnostics::GenerationSpeedHistory::decode(&json(&format!(
                r#"{{"recent":[]{invalid}}}"#
            )))
            .is_err(),
            "{invalid}"
        );
    }
    let nine = vec![sample(""); 9].join(",");
    assert!(
        session_cache_diagnostics::GenerationSpeedHistory::decode(&json(&format!(
            r#"{{"recent":[{nine}]}}"#
        )))
        .is_err()
    );
}
