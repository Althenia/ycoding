use crate::json;
use std::collections::BTreeMap;
use ycoding_schema::{JsonValue, parse_json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    Authentication,
    ContentPolicy,
    InvalidRequest,
    InvalidProviderOutput,
    QuotaExceeded,
    RateLimit,
    ProviderInternal,
    UnknownProvider,
    Transport,
    Interrupted,
}
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RateLimitDetails {
    pub retry_after_ms: Option<f64>,
    pub limit: BTreeMap<String, String>,
    pub remaining: BTreeMap<String, String>,
    pub reset: BTreeMap<String, String>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct HttpContext {
    pub method: String,
    pub url: String,
    pub request_headers: BTreeMap<String, String>,
    pub status: Option<u16>,
    pub response_headers: BTreeMap<String, String>,
    pub body: Option<String>,
    pub body_truncated: bool,
    pub request_id: Option<String>,
    pub rate_limit: Option<RateLimitDetails>,
}
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct Error {
    pub reason: Reason,
    pub message: String,
    pub status: Option<u16>,
    pub code: Option<String>,
    pub retry_after_ms: Option<f64>,
    pub rate_limit: Option<Box<RateLimitDetails>>,
    pub http: Option<Box<HttpContext>>,
    pub provider_metadata: Option<Box<JsonValue>>,
    pub context_overflow: bool,
    pub authentication_kind: Option<AuthenticationKind>,
    pub transport_kind: Option<&'static str>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthenticationKind {
    Missing,
    Invalid,
    InsufficientPermissions,
}
impl Error {
    pub fn new(reason: Reason, message: impl Into<String>) -> Self {
        Self {
            reason,
            message: message.into(),
            status: None,
            code: None,
            retry_after_ms: None,
            rate_limit: None,
            http: None,
            provider_metadata: None,
            context_overflow: false,
            authentication_kind: None,
            transport_kind: None,
        }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(Reason::InvalidRequest, message)
    }
    pub fn output(message: impl Into<String>) -> Self {
        Self::new(Reason::InvalidProviderOutput, message)
    }
    pub fn transport(message: impl Into<String>, kind: &'static str) -> Self {
        Self {
            transport_kind: Some(kind),
            ..Self::new(Reason::Transport, message)
        }
    }
    pub fn missing_terminal() -> Self {
        Self::transport(
            "Provider stream ended without a terminal finish event",
            "read",
        )
    }
    pub fn interrupted() -> Self {
        Self::new(Reason::Interrupted, "Provider attempt interrupted")
    }
}
#[derive(Default)]
pub struct Failure {
    pub message: String,
    pub status: Option<u16>,
    pub code: Option<String>,
    pub retry_after_ms: Option<f64>,
    pub rate_limit: Option<RateLimitDetails>,
    pub http: Option<HttpContext>,
    pub provider_metadata: Option<JsonValue>,
}
impl Failure {
    pub fn message(message: &str) -> Self {
        Self {
            message: message.into(),
            ..Self::default()
        }
    }
}

fn separated(text: &str, terms: &[&str], hyphen: bool) -> bool {
    text.match_indices(terms[0]).any(|(index, _)| {
        let mut rest = &text[index + terms[0].len()..];
        for term in &terms[1..] {
            if let Some(next) = rest.strip_prefix(term) {
                rest = next;
                continue;
            }
            let Some(ch) = rest.chars().next() else {
                return false;
            };
            if !(ch == '_' || hyphen && ch == '-' || ch.is_whitespace() || ch == '\u{feff}') {
                return false;
            }
            let Some(next) = rest[ch.len_utf8()..].strip_prefix(term) else {
                return false;
            };
            rest = next;
        }
        true
    })
}
fn digits(text: &str, comma: bool) -> Option<&str> {
    let count = text
        .bytes()
        .take_while(|byte| byte.is_ascii_digit() || comma && *byte == b',')
        .count();
    (count > 0).then(|| &text[count..])
}
fn numeric(text: &str, prefix: &str, comma: bool, suffix: &str) -> bool {
    text.match_indices(prefix).any(|(index, _)| {
        digits(&text[index + prefix.len()..], comma).is_some_and(|rest| rest.starts_with(suffix))
    })
}
pub fn is_context_overflow(message: &str) -> bool {
    let text = message.to_lowercase();
    if text.starts_with("throttling error:")
        || text.starts_with("service unavailable:")
        || text.contains("rate limit")
        || text.contains("too many requests")
    {
        return false;
    }
    if [
        "prompt is too long",
        "request_too_large",
        "input is too long for requested model",
        "exceeds the context window",
        "tokens in request more than max tokens allowed",
        "reduce the length of the messages",
        "exceeds the available context size",
        "greater than the context length",
        "context window exceeds limit",
        "exceeded model token limit",
        "context_length_exceeded",
        "context length exceeded",
        "context_length exceeded",
        "context length_exceeded",
        "request entity too large",
        "model_context_window_exceeded",
        "too many tokens",
        "token limit exceeded",
    ]
    .iter()
    .any(|part| text.contains(part))
    {
        return true;
    }
    if text.match_indices("exceeds ").any(|(index, _)| {
        let rest = &text[index + 8..];
        let rest = rest.strip_prefix("the ").unwrap_or(rest);
        let rest = rest
            .strip_prefix("model's ")
            .or_else(|| rest.strip_prefix("models "))
            .unwrap_or(rest);
        let Some(rest) = rest.strip_prefix("maximum context length") else {
            return false;
        };
        rest.strip_prefix(" of ")
            .and_then(|rest| digits(rest, true))
            .is_some_and(|rest| rest.starts_with(" token"))
            || rest
                .trim_start()
                .strip_prefix('(')
                .and_then(|rest| digits(rest, true))
                .is_some_and(|rest| rest.starts_with(')'))
    }) {
        return true;
    }
    if text
        .split(['\n', '\r', '\u{2028}', '\u{2029}'])
        .any(|line| {
            ordered(line, &["input length", "exceeds", "context length"])
                || ordered(line, &["input token count", "exceeds the maximum"])
        })
    {
        return true;
    }
    if text.match_indices("input (").any(|(index, _)| {
        let Some(rest) = digits(&text[index + 7..], false)
            .and_then(|rest| rest.strip_prefix(" tokens) is longer than the model"))
        else {
            return false;
        };
        rest.strip_prefix("'s context length (")
            .or_else(|| rest.strip_prefix("s context length ("))
            .and_then(|rest| digits(rest, false))
            .is_some_and(|rest| rest.starts_with(" tokens)"))
    }) {
        return true;
    }
    if text.match_indices("prompt has ").any(|(index, _)| {
        let Some(rest) =
            digits(&text[index + 11..], true).and_then(|rest| rest.strip_prefix(" token"))
        else {
            return false;
        };
        let rest = rest.strip_prefix('s').unwrap_or(rest);
        rest.strip_prefix(", but the configured context size is ")
            .and_then(|rest| digits(rest, true))
            .is_some_and(|rest| rest.starts_with(" token"))
    }) {
        return true;
    }
    if numeric(&text, "maximum prompt length is ", false, "")
        || numeric(&text, "maximum context length is ", false, " tokens")
        || numeric(
            &text,
            "exceeds the maximum allowed input length of ",
            true,
            " token",
        )
        || numeric(
            &text,
            "exceeds maximum allowed input length of ",
            true,
            " token",
        )
        || numeric(&text, "exceeds the limit of ", false, "")
        || numeric(&text, "context length is only ", false, " tokens")
        || numeric(
            &text,
            "too large for model with ",
            false,
            " maximum context length",
        )
    {
        return true;
    }
    if text.contains("prompt too long; exceeded context length")
        || text.contains("prompt too long; exceeded max context length")
    {
        return true;
    }
    (text.starts_with("400") || text.starts_with("413"))
        && text[3..]
            .trim_start()
            .strip_prefix("status code")
            .unwrap_or(text[3..].trim_start())
            .trim_start()
            .starts_with("(no body)")
}
fn ordered(text: &str, parts: &[&str]) -> bool {
    let mut rest = text;
    for part in parts {
        let Some(index) = rest.find(part) else {
            return false;
        };
        rest = &rest[index + part.len()..];
    }
    true
}
fn codes(value: &str) -> Vec<String> {
    let mut codes = Vec::new();
    if let Some((prefix, _)) = value.trim_start().split_once(':')
        && prefix
            .trim_end()
            .starts_with(|ch: char| ch.is_ascii_alphabetic())
        && prefix
            .trim_end()
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'_' | b'-'))
    {
        codes.push(prefix.trim_end().to_lowercase());
    }
    if let Ok(value) = parse_json(value) {
        for code in [
            json::get(&value, "code"),
            json::get(&value, "error").and_then(|error| json::get(error, "code")),
            json::get(&value, "error").and_then(|error| json::get(error, "type")),
        ]
        .into_iter()
        .flatten()
        .filter_map(json::text)
        {
            codes.push(code.to_lowercase());
        }
    }
    codes
}
pub fn classify(input: Failure) -> Error {
    let body = input
        .http
        .as_ref()
        .and_then(|http| http.body.as_deref())
        .unwrap_or("");
    let codes: Vec<_> = input
        .code
        .iter()
        .map(|code| code.to_lowercase())
        .chain(codes(body))
        .chain(codes(&input.message))
        .collect();
    let text = if body.is_empty() {
        &input.message
    } else {
        body
    }
    .to_lowercase();
    let client = input
        .status
        .is_none_or(|status| (400..500).contains(&status));
    let overflow = client
        && (codes.iter().any(|code| {
            matches!(
                code.as_str(),
                "context_length_exceeded" | "model_context_window_exceeded"
            )
        }) || is_context_overflow(&text));
    let reason = if overflow {
        Reason::InvalidRequest
    } else if separated(&text, &["content", "policy"], true)
        || text.contains("content_filter")
        || text.contains("safety")
    {
        Reason::ContentPolicy
    } else if codes.iter().any(|code| {
        matches!(
            code.as_str(),
            "insufficient_quota" | "usage_not_included" | "billing_error"
        )
    }) || (input.status == Some(429)
        && (separated(&text, &["insufficient", "quota"], true)
            || separated(&text, &["quota", "exceeded"], true)))
    {
        Reason::QuotaExceeded
    } else if matches!(input.status, Some(401 | 403))
        || codes
            .iter()
            .any(|code| matches!(code.as_str(), "authentication_error" | "permission_error"))
    {
        Reason::Authentication
    } else if codes.iter().any(|code| {
        code.contains("rate_limit")
            || matches!(code.as_str(), "too_many_requests" | "throttlingexception")
    }) || text.contains("rate increased too quickly")
        || separated(&text, &["rate", "limit"], true)
        || separated(&text, &["too", "many", "requests"], false)
    {
        Reason::RateLimit
    } else if codes.iter().any(|code| {
        matches!(
            code.as_str(),
            "api_error"
                | "internal_error"
                | "internalserverexception"
                | "modelstreamerrorexception"
                | "overloaded_error"
                | "server_error"
                | "server_is_overloaded"
                | "serviceunavailableexception"
        ) || code.contains("exhausted")
            || code.contains("unavailable")
    }) {
        Reason::ProviderInternal
    } else if input.status == Some(429) {
        Reason::RateLimit
    } else if input.status.is_some_and(|status| status >= 500) {
        Reason::ProviderInternal
    } else if codes.iter().any(|code| {
        matches!(
            code.as_str(),
            "invalid_prompt" | "invalid_request_error" | "validationexception"
        )
    }) || matches!(input.status, Some(400 | 404 | 409 | 413 | 422))
    {
        Reason::InvalidRequest
    } else {
        Reason::UnknownProvider
    };
    let details = input
        .rate_limit
        .or_else(|| input.http.as_ref().and_then(|http| http.rate_limit.clone()));
    let retry_after_ms = input
        .retry_after_ms
        .or_else(|| details.as_ref().and_then(|details| details.retry_after_ms));
    let mut message = input.message;
    if reason == Reason::RateLimit {
        let mut hints = Vec::new();
        if details.as_ref().is_some_and(|details| {
            details
                .limit
                .keys()
                .chain(details.remaining.keys())
                .chain(details.reset.keys())
                .any(|scope| scope == "unified" || scope.starts_with("unified-"))
        }) {
            hints.push("Claude subscription usage limit reached".into());
        }
        if let Some(ms) = retry_after_ms {
            let seconds = (ms / 1000.0).max(0.0).round();
            let value = if seconds < 120.0 {
                format!("{seconds}s")
            } else {
                let minutes = (seconds / 60.0).round();
                if minutes < 120.0 {
                    format!("{minutes}m")
                } else {
                    format!("{}h", (minutes / 60.0).round())
                }
            };
            hints.push(format!("retry after {value}"));
        }
        if let Some(details) = &details {
            hints.extend(
                details
                    .reset
                    .iter()
                    .map(|(scope, value)| format!("{scope} resets at {value}")),
            );
        }
        if !hints.is_empty() {
            message.push_str(&format!(" ({})", hints.join("; ")));
        }
    }
    Error {
        reason,
        message,
        status: input.status,
        code: input.code,
        retry_after_ms,
        rate_limit: details.map(Box::new),
        http: input.http.map(Box::new),
        provider_metadata: input.provider_metadata.map(Box::new),
        context_overflow: overflow,
        authentication_kind: if reason == Reason::Authentication {
            Some(
                if input.status == Some(403) || codes.iter().any(|code| code == "permission_error")
                {
                    AuthenticationKind::InsufficientPermissions
                } else {
                    AuthenticationKind::Invalid
                },
            )
        } else {
            None
        },
        transport_kind: None,
    }
}
pub fn retry_after_ms(headers: &BTreeMap<String, String>, now_ms: i64) -> Option<f64> {
    if let Some(value) = headers
        .get("retry-after-ms")
        .and_then(|value| js_number(value))
    {
        return Some(value.max(0.0));
    }
    let value = headers
        .get("retry-after")
        .filter(|value| !value.is_empty())?;
    if let Some(value) = js_number(value) {
        return Some((value * 1000.0).max(0.0));
    }
    parse_date(value).map(|at| ((at - now_ms) as f64).max(0.0))
}
fn js_number(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    let number = if let Some(hex) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        u64::from_str_radix(hex, 16).ok().map(|value| value as f64)
    } else {
        trimmed.parse::<f64>().ok()
    };
    number.filter(|value| value.is_finite())
}
fn parse_date(value: &str) -> Option<i64> {
    let tokens: Vec<_> = value.split_whitespace().collect();
    let (year, month, day, time) = if tokens.len() >= 5 && tokens[0].ends_with(',') {
        let months = [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ];
        (
            tokens[3].parse::<i64>().ok()?,
            months
                .iter()
                .position(|month| month.eq_ignore_ascii_case(tokens[2]))? as i64
                + 1,
            tokens[1].parse::<i64>().ok()?,
            tokens[4],
        )
    } else {
        let (date, time) = value.split_once('T')?;
        let date: Vec<_> = date.split('-').collect();
        if date.len() != 3 {
            return None;
        }
        (
            date[0].parse().ok()?,
            date[1].parse().ok()?,
            date[2].parse().ok()?,
            time.trim_end_matches('Z'),
        )
    };
    let time: Vec<_> = time.split(':').collect();
    if time.len() != 3 || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let hour = time[0].parse::<i64>().ok()?;
    let minute = time[1].parse::<i64>().ok()?;
    let second = time[2].parse::<f64>().ok()?;
    if !(0..24).contains(&hour) || !(0..60).contains(&minute) || !(0.0..60.0).contains(&second) {
        return None;
    }
    let year = year - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
    Some((days * 86400 + hour * 3600 + minute * 60) * 1000 + (second * 1000.0) as i64)
}
pub fn rate_limit_details(
    headers: &BTreeMap<String, String>,
    retry_after_ms: Option<f64>,
) -> Option<RateLimitDetails> {
    let mut details = RateLimitDetails {
        retry_after_ms,
        ..RateLimitDetails::default()
    };
    for (name, value) in headers {
        let scoped = ["limit", "remaining", "reset"]
            .into_iter()
            .find_map(|kind| {
                name.strip_prefix(&format!("x-ratelimit-{kind}-"))
                    .map(|scope| (scope, kind))
            });
        let scoped = scoped.or_else(|| {
            name.strip_prefix("anthropic-ratelimit-").and_then(|name| {
                ["limit", "remaining", "reset"]
                    .into_iter()
                    .find_map(|kind| {
                        name.strip_suffix(&format!("-{kind}"))
                            .map(|scope| (scope, kind))
                    })
            })
        });
        if let Some((scope, kind)) = scoped.filter(|(scope, _)| !scope.is_empty()) {
            match kind {
                "limit" => &mut details.limit,
                "remaining" => &mut details.remaining,
                _ => &mut details.reset,
            }
            .insert(scope.into(), value.clone());
        }
    }
    if retry_after_ms.is_none()
        && details.limit.is_empty()
        && details.remaining.is_empty()
        && details.reset.is_empty()
    {
        None
    } else {
        Some(details)
    }
}
