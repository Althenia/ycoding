use ycoding_ai::{
    cursor::{framing, stream},
    provider_error::{AuthenticationKind, Reason},
};

#[test]
fn cursor_connect_retry_info_matches_committed_language_model_envelopes() {
    for (payload, code, delay, transient) in [
        (
            r#"{"error":{"code":"resource_exhausted","retryAfter":"1.25s"}}"#,
            "resource_exhausted",
            Some(1250.0),
            true,
        ),
        (
            r#"{"error":{"code":"unavailable","retry_after":{"seconds":"2","nanos":1}}}"#,
            "unavailable",
            Some(2001.0),
            true,
        ),
        (
            r#"{"error":{"code":"unknown","details":[{"type":"type.googleapis.com/google.rpc.RetryInfo","value":"CgQIARAB"}]}}"#,
            "unknown",
            Some(1001.0),
            true,
        ),
        (
            r#"{"error":{"code":"unknown","details":[{"type":"google.rpc.RetryInfo","retryDelay":"300s"}]}}"#,
            "unknown",
            Some(30000.0),
            true,
        ),
        (
            r#"{"error":{"code":"invalid_argument","retryAfter":{"seconds":-1}}}"#,
            "invalid_argument",
            None,
            false,
        ),
        (r#"{}"#, "unknown", None, false),
    ] {
        let error = stream::State::new()
            .push(&framing::encode(framing::END_STREAM, payload.as_bytes()).unwrap())
            .unwrap_err();
        assert_eq!(error.code.as_deref(), Some(code), "{payload}");
        assert_eq!(error.retry_after_ms, delay, "{payload}");
        let metadata = ycoding_schema::stringify_json(error.provider_metadata.as_ref().unwrap());
        assert!(
            metadata.contains(&format!("\"transient\":{transient}")),
            "{metadata}"
        );
        assert!(metadata.contains("\"replaySafe\":true"));
    }
}

#[test]
fn cursor_connect_auth_and_malformed_envelopes_are_not_transient_or_replayable() {
    for payload in [
        r#"{"error":{"code":"unauthenticated"}}"#,
        r#"{"error":{"code":"permission_denied","retryAfter":"5s"}}"#,
        "not-json",
    ] {
        let error = stream::State::new()
            .push(&framing::encode(framing::END_STREAM, payload.as_bytes()).unwrap())
            .unwrap_err();
        if payload == "not-json" {
            assert_eq!(error.reason, Reason::InvalidProviderOutput);
        } else {
            assert_eq!(error.reason, Reason::Authentication);
            assert_eq!(error.authentication_kind, Some(AuthenticationKind::Invalid));
        }
        assert_eq!(error.retry_after_ms, None);
        let metadata = ycoding_schema::stringify_json(error.provider_metadata.as_ref().unwrap());
        assert!(metadata.contains("\"transient\":false"));
        assert!(metadata.contains("\"replaySafe\":false"));
    }
}

#[test]
fn cursor_connect_numeric_codes_keep_auth_and_transient_separation() {
    for (payload, code, origin, transient, replay_safe) in [
        (r#"{"error":{"code":"14"}}"#, "14", "server", true, true),
        (r#"{"error":{"code":"16"}}"#, "16", "auth", false, false),
    ] {
        let error = stream::State::new()
            .push(&framing::encode(framing::END_STREAM, payload.as_bytes()).unwrap())
            .unwrap_err();
        assert_eq!(error.code.as_deref(), Some(code), "{payload}");
        if transient {
            assert_eq!(error.reason, Reason::ProviderInternal, "{payload}");
        } else {
            assert_eq!(error.reason, Reason::Authentication, "{payload}");
            assert_eq!(
                error.authentication_kind,
                Some(AuthenticationKind::Invalid),
                "{payload}"
            );
        }
        let metadata = ycoding_schema::stringify_json(error.provider_metadata.as_ref().unwrap());
        assert!(
            metadata.contains(&format!("\"origin\":\"{origin}\"")),
            "{metadata}"
        );
        assert!(
            metadata.contains(&format!("\"transient\":{transient}")),
            "{metadata}"
        );
        assert!(
            metadata.contains(&format!("\"replaySafe\":{replay_safe}")),
            "{metadata}"
        );
    }
}
