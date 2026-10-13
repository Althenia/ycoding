use ycoding_core::tools::policy::forms::validate_answer;
use ycoding_schema::{DomainDecode, JsonObject, JsonValue, LosslessString, form, parse_json};

fn accepts(format: &str, value: LosslessString) -> bool {
    let input=form::Info::decode(&parse_json(&format!("{{\"id\":\"frm_format\",\"sessionID\":\"global\",\"title\":\"Format\",\"fields\":[{{\"key\":\"value\",\"type\":\"string\",\"format\":\"{format}\"}}]}}")).unwrap()).unwrap();
    let mut answer = JsonObject::new();
    answer.insert("value".into(), JsonValue::String(value));
    validate_answer(&input, &form::Answer(answer)).is_ok()
}

#[test]
fn date_time_acceptance_matches_bun_date_parse_oracle() {
    for value in [
        "2024-02-29",
        "2023-02-29",
        "2024-02-30",
        "2024-02-31T00:00:00Z",
        "2024-04-31T00:00:00Z",
        "2024-01-01T24:00:00Z",
        "2024-01-01t00:00:00z",
        "2024-01-01 00:00:00",
        "2024-01-01T00:00Z",
        "2024-01-01T00:00:00.123456Z",
        "2024",
        "2024-01",
        "1",
        "0",
        "01/02/2024",
        "2024/01/02",
        "Jan 2 2024",
        "Tue, 02 Jan 2024 00:00:00 GMT",
        "January 2, 2024",
        "2024-1-2",
        "2024-01-02 GMT",
        "+020024-01-02",
        "02 Jan 2024 00:00:00 +0200",
        "2024-01-01T00:00:00+02:30",
        "2024-01-01T00:00:00+0230",
    ] {
        assert!(accepts("date-time", value.into()), "{value}");
    }
    for value in [
        "2024-13-01",
        "2024-01-00",
        "2024-01-01T24:00:01Z",
        "not-a-date",
        " ",
        "2024-01-01T00:00:00+24:00",
        "2024-01-01T00:00:00+00:60",
    ] {
        assert!(!accepts("date-time", value.into()), "{value}");
    }
}

#[test]
fn date_is_exact_calendar_date_and_uri_uses_absolute_whatwg_urls() {
    for value in ["2024-02-29", "0000-01-01", "1970-01-01"] {
        assert!(accepts("date", value.into()), "{value}");
    }
    for value in [
        "2023-02-29",
        "2024-02-30",
        "2024-1-2",
        "2024-01-01T00:00Z",
        " 2024-01-01",
    ] {
        assert!(!accepts("date", value.into()), "{value}");
    }
    for value in [
        "https://example.com",
        "mailto:user@example.com",
        "urn:example:one",
        "file:///tmp/path",
        "custom:opaque",
        "http:example.com",
    ] {
        assert!(accepts("uri", value.into()), "{value}");
    }
    for value in [
        "relative/path",
        "//example.com",
        "https://",
        "http://[bad]",
        "http://example.com:99999",
    ] {
        assert!(!accepts("uri", value.into()), "{value}");
    }
    assert!(accepts(
        "uri",
        LosslessString::from_utf16(
            "https://example.com/"
                .encode_utf16()
                .chain([0xd800])
                .collect()
        )
    ));
}

#[test]
fn legacy_date_time_delimiters_clocks_offsets_and_comments_match_bun() {
    let cases=parse_json(r#"[["2024-01-01",true],["2024-01-01-",false],["2024-01-01--",false],["2024-01-01+",false],["2024-01-01++",false],["2024-01-01/",true],["2024-01-01//",true],["2024-01-01,",true],["2024-01-01.",true],["2024-01-01...",true],["2024-01-01 ",true],["2024-01-01Z",true],["2024-01-01 GMT",true],["2024-01-01 GMT+2500",true],["2024-01-01 GMT+05:99",false],["2024-01-01 junk",true],["2024-01-01 Tue",false],["2024-01-01 nonsense",false],["2024-01-01 (open",true],["2024-01-01 )",false],["Jan 2 2024",true],["Jan 2 2024-",true],["Jan 2 2024--",false],["Jan 2 2024+",false],["Jan 2 2024++",false],["Jan 2 2024/",true],["Jan 2 2024//",true],["Jan 2 2024,",true],["Jan 2 2024.",true],["Jan 2 2024...",true],["Jan 2 2024 ",true],["Jan 2 2024Z",true],["Jan 2 2024 GMT",true],["Jan 2 2024 GMT+2500",true],["Jan 2 2024 GMT+05:99",true],["Jan 2 2024 junk",true],["Jan 2 2024 Tue",false],["Jan 2 2024 nonsense",false],["Jan 2 2024 (open",true],["Jan 2 2024 )",false],["2024-1-2",true],["2024-1-2-",true],["2024-1-2--",false],["2024-1-2+",false],["2024-1-2++",false],["2024-1-2/",true],["2024-1-2//",true],["2024-1-2,",true],["2024-1-2.",true],["2024-1-2...",true],["2024-1-2 ",true],["2024-1-2Z",true],["2024-1-2 GMT",true],["2024-1-2 GMT+2500",true],["2024-1-2 GMT+05:99",false],["2024-1-2 junk",true],["2024-1-2 Tue",false],["2024-1-2 nonsense",false],["2024-1-2 (open",true],["2024-1-2 )",false],["2024-01-01T00:00",true],["2024-01-01T24:00",true],["2024-01-01T24:00:00.001",false],["2024-01-01T12:00:00.123",true],["2024-01-01T12:00.123",false],["2024-01-01T12:00:60",false],["2024-01-01T12:60:00",false],["2024-01-01T01:02+02",false],["2024-01-01T01:02+0230",true],["2024-01-01T01:02+02:30",true],["2024-01-01 00:00",true],["2024-01-01 24:00",true],["2024-01-01 24:00:00.001",false],["2024-01-01 12:00:00.123",true],["2024-01-01 12:00.123",false],["2024-01-01 12:00:60",false],["2024-01-01 12:60:00",false],["2024-01-01 01:02+02",true],["2024-01-01 01:02+0230",true],["2024-01-01 01:02+02:30",true],["Jan 2 2024 5",true],["Jan 2 2024 -12:00",false],["Jan 2 2024 12:00 GMT+2500",true],["Jan 2 2024 12:00 GMT+05:99",true],["2024-01-01\u0000tail",true],["nonsense 2024-01-01",true],["1-2",true],["0-2",true],["31-2",false],["2023-02-30",true],["275760-09-13",true],["275760-09-14",false],["-000000-01-01",true]]"#).unwrap();
    let JsonValue::Array(cases) = cases else {
        panic!("oracle array");
    };
    let failures = cases
        .into_iter()
        .filter_map(|case| {
            let JsonValue::Array(case) = case else {
                panic!("oracle pair");
            };
            let (JsonValue::String(value), JsonValue::Bool(expected)) = (&case[0], &case[1]) else {
                panic!("oracle types");
            };
            (accepts("date-time", value.clone()) != *expected).then(|| (value.clone(), *expected))
        })
        .collect::<Vec<_>>();
    assert!(failures.is_empty(), "{failures:?}");
}

#[test]
fn time_clip_includes_milliseconds_and_hour_24_checks_the_full_fraction() {
    for (value, expected) in [
        ("+275760-09-13T00:00:00.000Z", true),
        ("+275760-09-13T00:00:00.001Z", false),
        ("-271821-04-20T00:00:00.001Z", true),
        ("2024-01-01T24:00:00.0001Z", false),
    ] {
        assert_eq!(accepts("date-time", value.into()), expected, "{value}");
    }
}
