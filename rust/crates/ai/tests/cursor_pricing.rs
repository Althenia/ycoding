use ycoding_ai::cursor::pricing;

#[test]
fn cursor_pricing_preserves_known_rates_fast_and_long_context_tiers_without_unknown_zero() {
    let base = pricing::get(&"gpt-5.6-sol".into()).unwrap().unwrap();
    let synthetic = pricing::get(&"gpt-5.6-sol-1m-2".into()).unwrap().unwrap();
    assert_eq!(base, synthetic);
    assert_eq!(base.input, 4.0);
    assert_eq!(base.output, 20.0);
    assert_eq!(base.context_over_200k.as_ref().unwrap().input, 8.0);
    let fast = pricing::get(&"grok-4.7-1m-fast".into()).unwrap().unwrap();
    assert_eq!(fast.input, 4.0);
    assert_eq!(fast.context_over_200k.as_ref().unwrap().input, 6.0);
    assert!(pricing::get(&"unknown".into()).unwrap().is_none());
    assert!(pricing::get(&"default".into()).unwrap().is_none());
    assert!(pricing::has_fast(&"composer-2.5".into()).unwrap());
    let tiers = pricing::tiers(Some(&base));
    assert_eq!(tiers.len(), 2);
    assert_eq!(tiers[1].context_size, Some(200_000));
    assert_eq!(tiers[0].cache_write, 5.0);
    assert!(pricing::tiers(None).is_empty());
}

#[test]
fn cursor_pricing_validation_rejects_bad_rates_and_preserves_reported_zero() {
    for value in [
        r#"null"#,
        r#"{"input":-1,"output":0}"#,
        r#"{"input":1,"output":2,"cache_read":"1"}"#,
        r#"{"input":1,"output":2,"cache_read":null}"#,
        r#"{"input":1,"output":2,"context_over_200k":{"input":3}}"#,
    ] {
        assert!(pricing::validate(&ycoding_schema::parse_json(value).unwrap()).is_err());
    }
    let zero = pricing::validate(
        &ycoding_schema::parse_json(r#"{"input":0,"output":0,"cache_read":0}"#).unwrap(),
    )
    .unwrap();
    assert_eq!(zero.cache_read, Some(0.0));
    assert_eq!(zero.cache_write, None);
}
