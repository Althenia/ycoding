use ycoding_schema::{DomainDecode, DomainEncode, JsonValue, parse_json, provider_request};

fn field<'a>(value: &'a JsonValue, name: &str) -> &'a JsonValue {
    match value {
        JsonValue::Object(object) => object.get(&name.into()).unwrap(),
        _ => panic!("expected object"),
    }
}

#[test]
fn received_output_timing_round_trips_without_becoming_provider_tokens() {
    let value = parse_json(
        r#"{"totalMs":100,"receivedOutput":{"estimatedTokens":4,"durationNs":100000000}}"#,
    )
    .unwrap();
    let encoded = provider_request::Timing::decode(&value).unwrap().encode();
    assert_eq!(
        field(&encoded, "receivedOutput"),
        field(&value, "receivedOutput")
    );
    for received in [
        r#"{"estimatedTokens":0,"durationNs":1}"#,
        r#"{"estimatedTokens":1,"durationNs":0}"#,
    ] {
        let value =
            parse_json(&format!(r#"{{"totalMs":100,"receivedOutput":{received}}}"#)).unwrap();
        assert!(provider_request::Timing::decode(&value).is_err());
    }
}

#[test]
fn speed_keeps_the_tail_percentiles_and_mean() {
    let value = parse_json(r#"{"samples":1,"generationSamples":1,"providerTimedSamples":1,"observedSamples":0,"generationP95TokensPerSecond":8,"meanTokensPerSecond":4,"firstOutputP99Ms":20,"totalP99Ms":100}"#).unwrap();
    let encoded = provider_request::Speed::decode(&value).unwrap().encode();
    for key in [
        "generationP95TokensPerSecond",
        "meanTokensPerSecond",
        "firstOutputP99Ms",
        "totalP99Ms",
    ] {
        assert_eq!(field(&encoded, key), field(&value, key));
    }
}
