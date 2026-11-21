use ycoding_schema::{DomainDecode, DomainEncode, JsonValue, dots, parse_json};

fn json(text: &str) -> JsonValue {
    parse_json(text).unwrap()
}

#[test]
fn a_rejection_round_trips_every_optional_field() {
    for text in [
        "{}",
        r#"{"code":-32602}"#,
        r#"{"code":-32602,"errorCode":"busy","errorType":"thread_busy","message":"thread busy"}"#,
        r#"{"message":"only a message"}"#,
    ] {
        let value = json(text);
        assert_eq!(
            dots::Rejection::decode(&value).unwrap().encode(),
            value,
            "{text}"
        );
    }
}

#[test]
fn a_rejection_bounds_its_labels_and_requires_a_safe_integer_code() {
    let long = |length: usize| "z".repeat(length);
    for valid in [
        format!(r#"{{"errorCode":"{}"}}"#, long(128)),
        format!(r#"{{"errorType":"{}"}}"#, long(128)),
        format!(r#"{{"message":"{}"}}"#, long(1000)),
        r#"{"code":9007199254740991}"#.to_owned(),
        r#"{"code":-9007199254740991}"#.to_owned(),
    ] {
        assert!(dots::Rejection::decode(&json(&valid)).is_ok(), "{valid}");
    }
    for invalid in [
        format!(r#"{{"errorCode":"{}"}}"#, long(129)),
        format!(r#"{{"errorType":"{}"}}"#, long(129)),
        format!(r#"{{"message":"{}"}}"#, long(1001)),
        r#"{"message":""}"#.to_owned(),
        r#"{"message":"bell\u0007"}"#.to_owned(),
        r#"{"errorCode":"del\u007f"}"#.to_owned(),
        r#"{"code":2.5}"#.to_owned(),
        r#"{"code":9007199254740992}"#.to_owned(),
        r#"{"code":"-32602"}"#.to_owned(),
    ] {
        assert!(
            dots::Rejection::decode(&json(&invalid)).is_err(),
            "{invalid}"
        );
    }
}
