use ycoding_schema::{DomainDecode, DomainEncode, JsonValue, parse_json, provider_usage};

#[test]
fn all_provider_usage_sources_including_muse_round_trip_as_literals() {
    for source in [
        "provider_api",
        "local_client_rpc",
        "response_headers",
        "provider_internal_api",
        "local_session",
        "response_stream",
    ] {
        let value = JsonValue::String(source.into());
        assert_eq!(
            provider_usage::Source::decode(&value).unwrap().encode(),
            value
        );
    }
    assert!(provider_usage::Source::decode(&JsonValue::String("unknown".into())).is_err());
}

#[test]
fn muse_snapshot_and_observation_preserve_response_stream_source() {
    let snapshot = parse_json(r#"{"providerID":"muse","label":"Muse (Meta)","status":"available","source":"response_stream","stability":"observed","updatedAt":0,"windows":[]}"#).unwrap();
    assert_eq!(
        provider_usage::Snapshot::decode(&snapshot)
            .unwrap()
            .encode(),
        snapshot
    );
    let observation = parse_json(r#"{"providerID":"muse","label":"Muse (Meta)","source":"response_stream","stability":"observed","observedAt":0,"windows":[]}"#).unwrap();
    assert_eq!(
        provider_usage::Observation::decode(&observation)
            .unwrap()
            .encode(),
        observation
    );
}
