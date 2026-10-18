use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue,
    mcp_events::{
        EventData, Failure, Payload, Principal, RequestContext, Subscribe, Subscription,
        Unsubscribe,
    },
    parse_json,
};

const SUBSCRIBE: &str = r#"{"name":"session.completed","arguments":{"session_id":"ses_synthetic"},"delivery":{"mode":"webhook","url":"https://callback.invalid/events","secret":"synthetic-schema-secret"}}"#;

fn set(input: &str, key: &str, value: JsonValue) -> JsonValue {
    let JsonValue::Object(mut object) = parse_json(input).unwrap() else {
        panic!("object")
    };
    object.insert(key.into(), value);
    JsonValue::Object(object)
}

#[test]
fn omitted_and_null_optional_values_are_accepted_and_descendant_filter_defaults_false() {
    let input = Subscribe::decode(&parse_json(SUBSCRIBE).unwrap()).unwrap();
    assert!(!input.arguments.include_descendants);
    for key in ["cursor", "ttlMs"] {
        assert!(Subscribe::decode(&set(SUBSCRIBE, key, JsonValue::Null)).is_ok());
    }
    for ttl in [0.0, 60_000.0, 9_007_199_254_740_991.0] {
        assert!(Subscribe::decode(&set(SUBSCRIBE, "ttlMs", JsonValue::Number(ttl))).is_ok());
    }
    for ttl in [-1.0, 0.5, 9_007_199_254_740_992.0] {
        assert!(Subscribe::decode(&set(SUBSCRIBE, "ttlMs", JsonValue::Number(ttl))).is_err());
    }
}

#[test]
fn unknown_keys_and_wrong_delivery_modes_are_rejected_at_each_subscription_boundary() {
    assert!(
        Subscribe::decode(&set(
            SUBSCRIBE,
            "context",
            parse_json(r#"{"grantID":"forged"}"#).unwrap()
        ))
        .is_err()
    );
    assert!(
        Subscribe::decode(&set(
            SUBSCRIBE,
            "arguments",
            parse_json(r#"{"session_id":"ses_synthetic","directory":"/outside"}"#).unwrap()
        ))
        .is_err()
    );
    assert!(
        Subscribe::decode(&set(
            SUBSCRIBE,
            "delivery",
            parse_json(
                r#"{"mode":"stream","url":"https://callback.invalid","secret":"synthetic"}"#
            )
            .unwrap()
        ))
        .is_err()
    );
    assert!(Subscribe::decode(&set(SUBSCRIBE,"delivery",parse_json(r#"{"mode":"webhook","url":"https://callback.invalid","secret":"synthetic","headers":{}}"#).unwrap())).is_err());
    assert!(Unsubscribe::decode(&parse_json(SUBSCRIBE).unwrap()).is_err());
    assert!(Unsubscribe::decode(&parse_json(r#"{"name":"session.completed","arguments":{"session_id":"ses_synthetic"},"delivery":{"mode":"webhook","url":"https://callback.invalid"}}"#).unwrap()).is_ok());
}

#[test]
fn request_context_contains_only_forwarded_request_identity_and_principal_adds_exact_grant() {
    let context = r#"{"requestID":"outer_synthetic","principal":{"ownerID":"owner_synthetic","deviceID":"device_synthetic","clientID":"https://client.invalid/manifest"},"epoch":"epoch_synthetic"}"#;
    assert!(RequestContext::decode(&parse_json(context).unwrap()).is_ok());
    assert!(
        RequestContext::decode(&set(context, "grantID", JsonValue::String("forged".into())))
            .is_err()
    );
    assert!(RequestContext::decode(&set(context,"principal",parse_json(r#"{"ownerID":"owner_synthetic","deviceID":"device_synthetic","clientID":"client","grantID":"forged"}"#).unwrap())).is_err());
    for principal in [
        r#"{"ownerID":"owner_synthetic","deviceID":"device_synthetic","clientID":"client","epoch":"epoch_synthetic"}"#,
        r#"{"ownerID":"owner_synthetic","deviceID":"device_synthetic","clientID":"client\nforged","grantID":"grant_synthetic","epoch":"epoch_synthetic"}"#,
    ] {
        assert!(Principal::decode(&parse_json(principal).unwrap()).is_err());
    }
    assert!(Principal::decode(&parse_json(r#"{"ownerID":"owner_synthetic","deviceID":"device_synthetic","clientID":"client","grantID":"grant_synthetic","epoch":"epoch_synthetic"}"#).unwrap()).is_ok());
}

#[test]
fn notification_payload_accepts_only_bounded_identifier_state_and_category_fields() {
    let data = r#"{"session_id":"ses_synthetic","root_session_id":"ses_root","state":"completed","request_id":"req_synthetic","category":"provider.rate_limit"}"#;
    assert!(EventData::decode(&parse_json(data).unwrap()).is_ok());
    for (key, value) in [
        ("command", JsonValue::String("private".into())),
        ("state", JsonValue::String("unknown".into())),
        ("request_id", JsonValue::String("/private/path".into())),
        ("reason", JsonValue::String("x".repeat(65).into())),
    ] {
        assert!(EventData::decode(&set(data, key, value)).is_err());
    }
    let payload = r#"{"eventId":"evt_synthetic","name":"session.completed","timestamp":"2026-10-19T00:00:00.000Z","data":{"session_id":"ses_synthetic","root_session_id":"ses_root","state":"completed"},"cursor":null}"#;
    let decoded = Payload::decode(&parse_json(payload).unwrap()).unwrap();
    assert_eq!(decoded.encode(), parse_json(payload).unwrap());
}

#[test]
fn subscription_results_and_failure_reasons_preserve_the_released_closed_shapes() {
    let result = r#"{"id":"sub_synthetic","refreshBefore":"2026-10-20T00:00:00.000Z","cursor":null,"truncated":false}"#;
    assert_eq!(
        Subscription::decode(&parse_json(result).unwrap())
            .unwrap()
            .encode(),
        parse_json(result).unwrap()
    );
    for (category, reason) in [
        ("invalid_params", "invalid_cursor"),
        ("callback_endpoint", "endpoint_rejected"),
        ("unauthorized", "grant_revoked"),
        ("unavailable", "secure_storage_unavailable"),
    ] {
        let value = parse_json(&format!(
            r#"{{"_tag":"McpEvents.Failure","category":"{category}","reason":"{reason}"}}"#
        ))
        .unwrap();
        assert_eq!(Failure::decode(&value).unwrap().encode(), value);
    }
    assert!(Failure::decode(&parse_json(r#"{"_tag":"McpEvents.Failure","category":"unavailable","reason":"arbitrary-provider-text"}"#).unwrap()).is_err());
}
