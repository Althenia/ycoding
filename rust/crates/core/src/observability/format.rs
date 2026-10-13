use super::{Record, timestamp};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub(super) struct Redactor {
    values: Vec<String>,
}
impl Redactor {
    pub(super) fn new(env: &BTreeMap<String, String>) -> Self {
        Self {
            values: env
                .get("OTEL_EXPORTER_OTLP_HEADERS")
                .into_iter()
                .flat_map(|value| value.split(','))
                .filter_map(|entry| entry.split_once('=').map(|(_, value)| value.to_owned()))
                .filter(|value| !value.is_empty())
                .collect(),
        }
    }
    pub(super) fn clean(&self, key: &str, value: Value) -> Value {
        let key = key.to_ascii_lowercase().replace('-', "_");
        if key.split('.').any(|key| {
            matches!(
                key,
                "authorization"
                    | "proxy_authorization"
                    | "headers"
                    | "auth"
                    | "credential"
                    | "credentials"
                    | "credential_id"
                    | "credentialid"
                    | "token"
                    | "access_token"
                    | "accesstoken"
                    | "refresh_token"
                    | "refreshtoken"
                    | "api_key"
                    | "apikey"
                    | "password"
                    | "secret"
                    | "client_secret"
                    | "clientsecret"
                    | "payload"
                    | "raw"
                    | "body"
                    | "raw_payload"
                    | "raw_provider_payload"
                    | "provider_payload"
                    | "rawpayload"
                    | "rawproviderpayload"
                    | "providerpayload"
                    | "raw_response"
                    | "rawresponse"
            )
        }) {
            return json!("[REDACTED]");
        }
        match value {
            Value::Object(values) => Value::Object(
                values
                    .into_iter()
                    .map(|(key, value)| {
                        let value = self.clean(&key, value);
                        (self.text(&key), value)
                    })
                    .collect(),
            ),
            Value::Array(values) => Value::Array(
                values
                    .into_iter()
                    .map(|value| self.clean("", value))
                    .collect(),
            ),
            Value::String(value) => json!(self.text(&value)),
            value => value,
        }
    }
    pub(super) fn text(&self, input: &str) -> String {
        let mut value = input.to_owned();
        for secret in &self.values {
            value = value.replace(secret, "[REDACTED]");
        }
        for scheme in ["Bearer ", "bearer ", "Basic ", "basic "] {
            while let Some(start) = value.find(scheme) {
                let end = value[start + scheme.len()..]
                    .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ',' | '}' | ']'))
                    .map_or(value.len(), |end| start + scheme.len() + end);
                value.replace_range(start..end, "[REDACTED]");
            }
        }
        value
    }
}

pub(super) fn flatten(key: &str, value: &Value, output: &mut Vec<(String, Value)>) {
    if let Value::Object(values) = value {
        if !values.is_empty() {
            for (name, value) in values {
                flatten(
                    &if key.is_empty() {
                        name.clone()
                    } else {
                        format!("{key}.{name}")
                    },
                    value,
                    output,
                );
            }
            return;
        }
    }
    output.push((key.into(), value.clone()));
}

pub(super) fn value(input: &Value) -> String {
    let text = input
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| input.to_string());
    if !text.is_empty()
        && !text
            .chars()
            .any(|ch| ch.is_whitespace() || matches!(ch, '=' | '"' | '\\'))
    {
        return text;
    }
    json!(text).to_string()
}

pub(super) fn record(record: &Record, run: &str) -> String {
    let mut fields = vec![
        ("timestamp".into(), json!(timestamp(record.time))),
        ("level".into(), json!(record.level.as_str())),
        ("run".into(), json!(run)),
    ];
    if record.message.is_object() {
        flatten("", &record.message, &mut fields);
    } else {
        fields.push(("message".into(), record.message.clone()));
    }
    for (key, value) in &record.fields {
        if key != "cause" {
            flatten(key, value, &mut fields);
        }
    }
    for (key, value) in &record.fields {
        if key == "cause" {
            fields.push((key.clone(), value.clone()));
        }
    }
    fields.extend(
        record
            .spans
            .iter()
            .map(|(key, value)| (key.clone(), json!(value))),
    );
    for (key, value) in &record.annotations {
        flatten(key, value, &mut fields);
    }
    fields
        .into_iter()
        .map(|(key, input)| format!("{key}={}", value(&input)))
        .collect::<Vec<_>>()
        .join(" ")
        + "\n"
}

#[cfg(test)]
mod tests {
    use super::{Redactor, value};
    use serde_json::json;
    use std::collections::BTreeMap;

    #[test]
    fn values_quote_empty_whitespace_equals_quotes_and_backslashes() {
        for (input, expected) in [
            (json!(""), "\"\""),
            (json!("x=y"), "\"x=y\""),
            (json!("a\nb"), "\"a\\nb\""),
            (json!("a\\b"), "\"a\\\\b\""),
            (json!(42), "42"),
            (json!(null), "null"),
            (json!({}), "{}"),
            (json!(["a"]), "\"[\\\"a\\\"]\""),
        ] {
            assert_eq!(value(&input), expected);
        }
    }
    #[test]
    fn redaction_is_recursive_in_arrays_and_dotted_fields() {
        let redactor = Redactor::new(&BTreeMap::from([(
            "OTEL_EXPORTER_OTLP_HEADERS".into(),
            "Authorization=fixture-value".into(),
        )]));
        assert_eq!(redactor.clean("request",json!({"headers":{"Authorization":"private"},"items":[{"apiKey":"private","method":"GET"}]})),json!({"headers":"[REDACTED]","items":[{"apiKey":"[REDACTED]","method":"GET"}]}));
        assert_eq!(
            redactor.clean("request.auth.token", json!("private")),
            json!("[REDACTED]")
        );
        assert_eq!(
            redactor.text("Bearer private fixture-value"),
            "[REDACTED] [REDACTED]"
        );
        let redactor = Redactor::new(&BTreeMap::from([(
            "OTEL_EXPORTER_OTLP_HEADERS".into(),
            "x=fixture-first,x=fixture-second".into(),
        )]));
        assert_eq!(
            redactor.text("fixture-first fixture-second"),
            "[REDACTED] [REDACTED]"
        );
        assert_eq!(redactor.clean("account",json!({"accessToken":"private","refreshToken":"private","clientSecret":"private","rawResponse":"private"})),json!({"accessToken":"[REDACTED]","refreshToken":"[REDACTED]","clientSecret":"[REDACTED]","rawResponse":"[REDACTED]"}));
    }
}
