use super::{Options, Record, config, format::Redactor, nanos};
use reqwest::{
    Client, Url,
    header::{HeaderMap, HeaderName, HeaderValue},
};
use serde_json::{Value, json};
use std::{
    str::FromStr,
    time::{Duration, Instant},
};
use tracing::Level;

pub(super) struct Exporter {
    client: Client,
    endpoint: String,
    headers: HeaderMap,
    resource: Value,
    pub(super) logs: Vec<Value>,
    pub(super) spans: Vec<Value>,
    log_flush: Instant,
    span_flush: Instant,
    logs_disabled: Option<Instant>,
    spans_disabled: Option<Instant>,
}
impl Exporter {
    pub(super) fn new(options: &Options, run: &str, redactor: &Redactor) -> Option<Self> {
        let endpoint = options
            .environment
            .get("OTEL_EXPORTER_OTLP_ENDPOINT")
            .filter(|v| !v.is_empty())?;
        let url = Url::parse(endpoint).ok()?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return None;
        }
        let mut headers = HeaderMap::new();
        for (key, value) in config::headers(options.environment.get("OTEL_EXPORTER_OTLP_HEADERS")) {
            let name = HeaderName::from_str(&key).ok()?;
            let mut value = HeaderValue::from_str(&value).ok()?;
            value.set_sensitive(true);
            headers.insert(name, value);
        }
        let mut resource =
            config::resource_attributes(options.environment.get("OTEL_RESOURCE_ATTRIBUTES"));
        resource.extend([
            ("service.name".into(), "ycoding".into()),
            ("service.version".into(), options.version.clone()),
            (
                "deployment.environment.name".into(),
                options.channel.clone(),
            ),
            (
                "ycoding.client".into(),
                options
                    .environment
                    .get("YCODING_CLIENT")
                    .cloned()
                    .unwrap_or("cli".into()),
            ),
            ("ycoding.run".into(), run.into()),
            ("service.instance.id".into(), run.into()),
        ]);
        Some(Self {
            client: Client::builder()
                .timeout(Duration::from_secs(3))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .ok()?,
            endpoint: endpoint.clone(),
            headers,
            resource: json!({"attributes":attributes(resource.into_iter().map(|(key,value)| {
                let value = redactor.clean(&key,json!(value)); (key,value)
            })),"droppedAttributesCount":0}),
            logs: vec![],
            spans: vec![],
            log_flush: Instant::now(),
            span_flush: Instant::now(),
            logs_disabled: None,
            spans_disabled: None,
        })
    }
    pub(super) async fn flush(&mut self, closing: bool) {
        if !self.logs.is_empty()
            && (closing
                || self.logs.len() >= 1000
                || self.log_flush.elapsed() >= Duration::from_secs(1))
        {
            let records = std::mem::take(&mut self.logs);
            self.log_flush = Instant::now();
            if self
                .logs_disabled
                .is_none_or(|until| Instant::now() >= until)
            {
                let body = json!({"resourceLogs":[{"resource":self.resource,"scopeLogs":[{"scope":{"name":"ycoding"},"logRecords":records}]}]});
                self.logs_disabled = if self.export("logs", body).await {
                    None
                } else {
                    Some(Instant::now() + Duration::from_secs(60))
                };
            }
        }
        if !self.spans.is_empty()
            && (closing
                || self.spans.len() >= 512
                || self.span_flush.elapsed() >= Duration::from_secs(5))
        {
            let spans = std::mem::take(&mut self.spans);
            self.span_flush = Instant::now();
            if self
                .spans_disabled
                .is_none_or(|until| Instant::now() >= until)
            {
                let body = json!({"resourceSpans":[{"resource":self.resource,"scopeSpans":[{"scope":{"name":"ycoding"},"spans":spans}]}]});
                self.spans_disabled = if self.export("traces", body).await {
                    None
                } else {
                    Some(Instant::now() + Duration::from_secs(60))
                };
            }
        }
    }
    async fn export(&self, signal: &str, body: Value) -> bool {
        self.client
            .post(format!("{}/v1/{signal}", self.endpoint))
            .headers(self.headers.clone())
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
    }
}

pub(super) fn attributes(values: impl IntoIterator<Item = (String, Value)>) -> Vec<Value> {
    values
        .into_iter()
        .map(|(key, value)| json!({"key":key,"value":any(value)}))
        .collect()
}
fn any(value: Value) -> Value {
    match value {
        Value::String(value) => json!({"stringValue":value}),
        Value::Bool(value) => json!({"boolValue":value}),
        Value::Number(value) if value.is_i64() || value.is_u64() => {
            json!({"intValue":value.to_string()})
        }
        Value::Number(value) => json!({"doubleValue":value}),
        Value::Array(value) => {
            json!({"arrayValue":{"values":value.into_iter().map(any).collect::<Vec<_>>()}})
        }
        value => json!({"stringValue":value.to_string()}),
    }
}

pub(super) fn log(record: Record) -> Value {
    let (severity, number) = match record.level {
        Level::ERROR => ("Error", 17),
        Level::WARN => ("Warn", 13),
        Level::INFO => ("Info", 9),
        Level::DEBUG => ("Debug", 5),
        _ => ("Trace", 1),
    };
    let mut annotations = record.annotations;
    if let Some((_, cause)) = record.fields.iter().find(|(key, _)| key == "cause") {
        annotations.push(("log.error".into(), cause.clone()));
    }
    annotations.extend(
        record
            .spans
            .into_iter()
            .map(|(key, value)| (format!("logSpan.{key}"), json!(format!("{value}ms")))),
    );
    let fields: Vec<_> = record
        .fields
        .into_iter()
        .filter(|(key, _)| key != "cause")
        .collect();
    let message = if fields.is_empty() {
        record.message
    } else {
        Value::Array(vec![
            record.message,
            Value::Object(fields.into_iter().collect()),
        ])
    };
    let mut log = json!({
        "severityNumber":number, "severityText":severity,
        "timeUnixNano":nanos(record.time), "observedTimeUnixNano":nanos(record.time),
        "attributes":attributes(annotations), "body":any(message), "droppedAttributesCount":0,
    });
    if let Some((trace, span)) = record.trace {
        log["traceId"] = json!(trace);
        log["spanId"] = json!(span);
    }
    log
}
