use super::super::wire::encode_base64;
use super::{
    error::{RpcError, echo},
    json::{self, NumberStyle, ObjectBuilder, lossy},
    types::*,
    wire_fs::decode_base64,
};
use ycoding_core::ycoding_schema::{JsonObject, JsonValue};

pub const HTTP_REQUEST_BODY_DELTA_METHOD: &str = "http/request/bodyDelta";

fn invalid(message: impl Into<Text>) -> RpcError {
    RpcError::invalid_params(message)
}

fn invalid_type(value: &JsonValue, expected: &str) -> RpcError {
    invalid(format!(
        "invalid type: {}, expected {expected}",
        json::unexpected(value, NumberStyle::Integral)
    ))
}

fn require(object: &JsonObject, required: &[&str]) -> Result<(), RpcError> {
    match required.iter().find(|key| !json::has(object, key)) {
        Some(missing) => Err(invalid(format!("missing field `{missing}`"))),
        None => Ok(()),
    }
}

fn structure<'a>(value: &'a JsonValue, name: &str) -> Result<&'a JsonObject, RpcError> {
    match value {
        JsonValue::Object(object) => Ok(object),
        other => Err(invalid_type(other, &format!("struct {name}"))),
    }
}

fn string(value: &JsonValue) -> Result<Text, RpcError> {
    match value {
        JsonValue::String(text) => Ok(text.clone()),
        other => Err(invalid_type(other, "a string")),
    }
}

fn optional_string(value: &JsonValue) -> Result<Option<Text>, RpcError> {
    match value {
        JsonValue::Null => Ok(None),
        other => string(other).map(Some),
    }
}

fn boolean(value: &JsonValue) -> Result<bool, RpcError> {
    match value {
        JsonValue::Bool(flag) => Ok(*flag),
        other => Err(invalid_type(other, "a boolean")),
    }
}

fn u64_value(value: &JsonValue) -> Result<Option<u64>, RpcError> {
    match value {
        JsonValue::Null => Ok(None),
        JsonValue::Number(number) if json::is_integer(*number) => {
            if *number < 0.0 {
                Err(invalid(format!(
                    "invalid value: {}, expected u64",
                    json::unexpected(value, NumberStyle::Integral)
                )))
            } else {
                Ok(Some(*number as u64))
            }
        }
        other => Err(invalid_type(other, "u64")),
    }
}

fn redirect_policy(value: &JsonValue) -> Result<HttpRedirectPolicy, RpcError> {
    match value {
        JsonValue::String(text) => match lossy(text).as_str() {
            "follow" => Ok(HttpRedirectPolicy::Follow),
            "stop" => Ok(HttpRedirectPolicy::Stop),
            _ => Err(invalid(echo(
                "unknown variant `",
                text,
                "`, expected `follow` or `stop`",
            ))),
        },
        other => Err(invalid_type(other, "string or map")),
    }
}

fn header(value: &JsonValue) -> Result<HttpHeader, RpcError> {
    let object = structure(value, "HttpHeader")?;
    let mut name = Text::default();
    let mut header_value = Text::default();
    let mut value_env_var = None;
    for (key, field) in object.iter() {
        match lossy(key).as_str() {
            "name" => name = string(field)?,
            "value" => header_value = string(field)?,
            "valueEnvVar" => value_env_var = optional_string(field)?,
            _ => {}
        }
    }
    require(object, &["name", "value"])?;
    Ok(HttpHeader {
        name,
        value: header_value,
        value_env_var,
    })
}

fn headers(value: &JsonValue) -> Result<Vec<HttpHeader>, RpcError> {
    match value {
        JsonValue::Array(items) => items.iter().map(header).collect(),
        other => Err(invalid_type(other, "a sequence")),
    }
}

pub fn decode_request(params: &JsonValue) -> Result<HttpRequestParams, RpcError> {
    let object = structure(params, "HttpRequestParams")?;
    let mut decoded = HttpRequestParams {
        method: Text::default(),
        url: Text::default(),
        headers: Vec::new(),
        body: None,
        timeout_ms: None,
        redirect_policy: HttpRedirectPolicy::Follow,
        request_id: Text::default(),
        stream_response: false,
    };
    for (key, field) in object.iter() {
        match lossy(key).as_str() {
            "method" => decoded.method = string(field)?,
            "url" => decoded.url = string(field)?,
            "headers" => decoded.headers = headers(field)?,
            "bodyBase64" => {
                decoded.body = match field {
                    JsonValue::Null => None,
                    JsonValue::String(text) => Some(decode_base64(&lossy(text))?),
                    other => return Err(invalid_type(other, "a string")),
                }
            }
            "timeoutMs" => decoded.timeout_ms = u64_value(field)?,
            "redirectPolicy" => decoded.redirect_policy = redirect_policy(field)?,
            "requestId" => decoded.request_id = string(field)?,
            "streamResponse" => decoded.stream_response = boolean(field)?,
            _ => {}
        }
    }
    require(object, &["method", "url", "requestId"])?;
    Ok(decoded)
}

fn encode_header(header: &HttpHeader) -> JsonValue {
    ObjectBuilder::new()
        .field("name", json::lossless(&header.name))
        .field("value", json::lossless(&header.value))
        .optional(
            "valueEnvVar",
            header.value_env_var.as_ref().map(json::lossless),
        )
        .finish()
}

pub fn encode_response(response: &HttpResponse) -> JsonValue {
    ObjectBuilder::new()
        .field("status", json::uint(u64::from(response.status)))
        .field(
            "headers",
            JsonValue::Array(response.headers.iter().map(encode_header).collect()),
        )
        .field("bodyBase64", json::text(&encode_base64(&response.body)))
        .finish()
}

pub fn encode_body_delta(delta: &HttpBodyDelta) -> JsonValue {
    ObjectBuilder::new()
        .field("requestId", json::lossless(&delta.request_id))
        .field("seq", json::uint(delta.seq))
        .field("deltaBase64", json::text(&encode_base64(&delta.delta)))
        .field("done", JsonValue::Bool(delta.done))
        .field("error", json::nullable_text(delta.error.as_deref()))
        .finish()
}
