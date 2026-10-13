use super::protobuf;
use crate::{
    Error, json, media,
    provider_error::{AuthenticationKind, Reason},
};

pub(crate) fn diagnostic(
    mut error: Error,
    origin: &str,
    transient: bool,
    replay_safe: bool,
) -> Error {
    error.provider_metadata = Some(Box::new(json::object([(
        "cursor",
        json::object([
            ("origin", json::s(origin)),
            ("transient", ycoding_schema::JsonValue::Bool(transient)),
            ("replaySafe", ycoding_schema::JsonValue::Bool(replay_safe)),
        ]),
    )])));
    error
}

pub(crate) fn protocol(message: &str) -> Error {
    diagnostic(Error::output(message), "protocol", false, false)
}

pub(crate) fn http(status: u16) -> Error {
    let reason = match status {
        401 | 403 => Reason::Authentication,
        429 => Reason::RateLimit,
        500..=599 => Reason::ProviderInternal,
        _ => Reason::UnknownProvider,
    };
    let authentication = reason == Reason::Authentication;
    diagnostic(
        Error {
            status: Some(status),
            authentication_kind: authentication.then_some(AuthenticationKind::Invalid),
            ..Error::new(
                reason,
                if authentication {
                    format!(
                        "Cursor authentication failed (HTTP {status}); reauthenticate with Cursor"
                    )
                } else {
                    format!("Cursor request failed with HTTP {status}")
                },
            )
        },
        if authentication { "auth" } else { "server" },
        status == 429 || status >= 500,
        !authentication,
    )
}

pub(crate) fn grpc(status: &str) -> Error {
    let normalized = status.to_ascii_lowercase().replace('-', "_");
    let reason = match normalized.as_str() {
        "7" | "16" | "permission_denied" | "unauthenticated" => Reason::Authentication,
        "8" | "resource_exhausted" => Reason::RateLimit,
        "13" | "14" | "internal" | "unavailable" => Reason::ProviderInternal,
        "3" | "invalid_argument" => Reason::InvalidRequest,
        _ => Reason::UnknownProvider,
    };
    let authentication = reason == Reason::Authentication;
    diagnostic(
        Error {
            code: Some(status.into()),
            authentication_kind: authentication.then_some(AuthenticationKind::Invalid),
            ..Error::new(
                reason,
                if authentication {
                    format!(
                        "Cursor authentication failed (gRPC {status}); reauthenticate with Cursor"
                    )
                } else {
                    format!("Cursor Run returned a gRPC failure ({status})")
                },
            )
        },
        if authentication { "auth" } else { "server" },
        matches!(
            normalized.as_str(),
            "8" | "13" | "14" | "internal" | "resource_exhausted" | "unavailable"
        ),
        !authentication,
    )
}

pub(crate) fn connect(payload: &[u8]) -> Error {
    let Ok(envelope) = serde_json::from_slice::<serde_json::Value>(payload) else {
        return protocol("Cursor returned a malformed Connect error envelope");
    };
    let code = envelope
        .get("error")
        .and_then(|value| value.get("code"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown");
    let mut error = grpc(code);
    if error.reason == Reason::Authentication {
        return error;
    }
    let body = &envelope["error"];
    let mut delay = body
        .get("retryAfter")
        .or_else(|| body.get("retry_after"))
        .and_then(retry_delay);
    let mut retry_info = false;
    if let Some(details) = body.get("details").and_then(serde_json::Value::as_array) {
        for detail in details {
            if detail
                .get("type")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| {
                    value == "google.rpc.RetryInfo" || value.ends_with("/google.rpc.RetryInfo")
                })
            {
                retry_info = true;
                delay = delay.or_else(|| {
                    detail
                        .get("retryDelay")
                        .or_else(|| detail.get("retry_delay"))
                        .or_else(|| detail.get("value"))
                        .and_then(retry_delay)
                });
            }
        }
    }
    error.retry_after_ms = delay.map(|delay| delay.min(30_000.0));
    if retry_info {
        set_flag(&mut error, "transient", true);
    }
    error
}

pub(crate) fn set_flag(error: &mut Error, key: &str, value: bool) {
    if let Some(metadata) = &mut error.provider_metadata
        && let Some(mut cursor) = json::get(metadata, "cursor").cloned()
    {
        json::set(&mut cursor, key, ycoding_schema::JsonValue::Bool(value));
        json::set(metadata, "cursor", cursor);
    }
}

fn retry_delay(value: &serde_json::Value) -> Option<f64> {
    if let Some(value) = value.as_str() {
        let value = value.trim();
        if let Some(seconds) = value.strip_suffix('s')
            && !seconds.is_empty()
            && seconds
                .bytes()
                .all(|byte| byte.is_ascii_digit() || byte == b'.')
            && let Ok(seconds) = seconds.parse::<f64>()
            && seconds.is_finite()
        {
            return Some((seconds * 1000.0).ceil());
        }
        if value.is_empty() || value.len() > 512 {
            return None;
        }
        let bytes = media::decode(&value.replace('-', "+").replace('_', "/")).ok()?;
        let fields = protobuf::fields(&bytes).ok()?;
        let field = fields.first().filter(|field| field.number == 1)?;
        let duration = protobuf::fields(field.bytes().ok()?).ok()?;
        let mut seconds = 0;
        let mut nanos = 0;
        for field in duration {
            let number = field.varint().ok()?;
            match field.number {
                1 => seconds = number,
                2 => nanos = number,
                _ => {}
            }
        }
        if seconds > 9_007_199_254_740_991 || nanos > 999_999_999 {
            return None;
        }
        return Some((seconds as f64 * 1000.0 + nanos as f64 / 1_000_000.0).ceil());
    }
    let object = value.as_object()?;
    let number = |key| {
        object
            .get(key)
            .map(|value| value.as_f64().or_else(|| value.as_str()?.parse().ok()))
            .unwrap_or(Some(0.0))
    };
    let seconds = number("seconds")?;
    let nanos = number("nanos")?;
    (seconds.is_finite() && nanos.is_finite() && seconds >= 0.0 && nanos >= 0.0)
        .then(|| (seconds * 1000.0 + nanos / 1_000_000.0).ceil())
}
