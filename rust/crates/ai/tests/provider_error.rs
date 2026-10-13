use std::collections::BTreeMap;
use ycoding_ai::provider_error::{
    Failure, Reason, classify, is_context_overflow, rate_limit_details, retry_after_ms,
};

#[test]
fn ts_classification_vectors() {
    for message in [
        "tokens in request more than max tokens allowed",
        r#"{"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}"#,
        "Requested token count exceeds the model's maximum context length of 131072 tokens.",
        "Input length (265330) exceeds model's maximum context length (262144).",
        "Input length 131393 exceeds the maximum allowed input length of 131040 tokens.",
        "The input (516368 tokens) is longer than the model's context length (262144 tokens).",
        "Prompt has 5,958,968 tokens, but the configured context size is 256,000 tokens",
        "Too many tokens",
        "Token limit exceeded",
        "400 (no body)",
    ] {
        assert!(is_context_overflow(message), "{message}");
    }
    for message in [
        "Throttling error: Too many tokens, please wait before trying again.",
        "Rate limit exceeded, please retry after 30 seconds.",
        "Too many requests. Please slow down.",
    ] {
        assert!(!is_context_overflow(message));
    }
    for (message, expected) in [
        ("Request rate increased too quickly", Reason::RateLimit),
        (
            r#"{"code":"bad_request","error":{"code":"rate_limit_exceeded"}}"#,
            Reason::RateLimit,
        ),
        (r#"{"code":"resource_exhausted"}"#, Reason::ProviderInternal),
        (
            "server_error: An error occurred while processing your request.",
            Reason::ProviderInternal,
        ),
        (
            r#"{"code":"bad_request","error":{"code":"usage_not_included"}}"#,
            Reason::QuotaExceeded,
        ),
        (
            r#"{"code":"bad_request","error":{"type":"invalid_request_error"}}"#,
            Reason::InvalidRequest,
        ),
        (
            r#"{"error":{"message":"no_kv_space"}}"#,
            Reason::UnknownProvider,
        ),
        ("not-json", Reason::UnknownProvider),
        ("authentication_error: invalid", Reason::Authentication),
        ("permission_error: denied", Reason::Authentication),
        ("content policy violation", Reason::ContentPolicy),
    ] {
        assert_eq!(
            classify(Failure::message(message)).reason,
            expected,
            "{message}"
        );
    }
    let mut failure = Failure::message("too many tokens");
    failure.status = Some(503);
    assert_eq!(classify(failure).reason, Reason::ProviderInternal);
}

#[test]
fn rate_limit_scopes_and_retry_after() {
    let headers = BTreeMap::from([
        (
            "anthropic-ratelimit-unified-5h-remaining".into(),
            "0".into(),
        ),
        (
            "anthropic-ratelimit-unified-5h-reset".into(),
            "2026-07-25T18:00:00Z".into(),
        ),
        ("retry-after".into(), "90".into()),
    ]);
    assert_eq!(retry_after_ms(&headers, 0), Some(90_000.0));
    let mut failure = Failure::message("Provider reported rate_limit_error");
    failure.status = Some(429);
    failure.rate_limit = rate_limit_details(&headers, Some(90_000.0));
    assert_eq!(
        classify(failure).message,
        "Provider reported rate_limit_error (Claude subscription usage limit reached; retry after 90s; unified-5h resets at 2026-07-25T18:00:00Z)"
    );
    assert_eq!(
        retry_after_ms(
            &BTreeMap::from([("retry-after".into(), "Thu, 01 Jan 1970 00:00:10 GMT".into())]),
            1000
        ),
        Some(9000.0)
    );
    assert_eq!(retry_after_ms(&BTreeMap::new(), 0), None);
    assert!(rate_limit_details(&BTreeMap::new(), None).is_none());
}

#[test]
fn classification_matches_optional_separator_and_numeric_boundaries() {
    for (message, expected) in [
        ("contentpolicy violation", Reason::ContentPolicy),
        ("quotaexceeded", Reason::QuotaExceeded),
        ("insufficientquota", Reason::QuotaExceeded),
        ("too_manyrequests", Reason::RateLimit),
        ("rate\tlimit", Reason::RateLimit),
        ("server_error : failed", Reason::ProviderInternal),
    ] {
        let mut failure = Failure::message(message);
        if expected == Reason::QuotaExceeded {
            failure.status = Some(429);
        }
        assert_eq!(classify(failure).reason, expected, "{message}");
    }
    for message in [
        "exceeds unrelated limit of time; maximum context length (unknown)",
        "input (abc tokens) is longer than the model's context length (def tokens)",
        "maximum context length is 4 bytes",
        "too large for model with 4 kilograms",
    ] {
        assert!(!is_context_overflow(message), "{message}");
    }
    assert!(is_context_overflow("context_length exceeded"));
    assert!(is_context_overflow("context length_exceeded"));
}
