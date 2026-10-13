use super::{Command, Record, Shared, format, identity, nanos};
use serde_json::{Value, json};
use std::{
    fmt,
    sync::Arc,
    time::{Instant, SystemTime},
};
use tracing::{
    Event, Subscriber,
    field::{Field, Visit},
    span::{Attributes, Id},
};
use tracing_subscriber::{Layer, layer::Context, registry::LookupSpan};

pub(super) struct Diagnostics {
    pub(super) shared: Arc<Shared>,
}
struct SpanData {
    time: SystemTime,
    started: Instant,
    name: String,
    fields: Vec<(String, Value)>,
    trace: Option<(String, String)>,
    parent: Option<String>,
    links: Vec<Value>,
}

impl<S> Layer<S> for Diagnostics
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn enabled(&self, metadata: &tracing::Metadata<'_>, _: Context<'_, S>) -> bool {
        metadata.is_span() || *metadata.level() <= self.shared.minimum
    }
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(id) else {
            return;
        };
        let parent = attrs.parent().and_then(|id| ctx.span(id)).or_else(|| {
            attrs
                .is_contextual()
                .then(|| ctx.lookup_current())
                .flatten()
        });
        let parent_trace = parent.as_ref().and_then(|span| {
            span.extensions()
                .get::<SpanData>()
                .and_then(|data| data.trace.clone())
        });
        let trace_id = parent_trace
            .as_ref()
            .map(|trace| trace.0.clone())
            .map(Ok)
            .unwrap_or_else(identity::<16>);
        let trace = trace_id
            .and_then(|trace| Ok((trace, identity::<8>()?)))
            .ok();
        let mut visitor = Fields::new(&self.shared.redactor);
        attrs.record(&mut visitor);
        span.extensions_mut().insert(SpanData {
            time: SystemTime::now(),
            started: Instant::now(),
            name: self.shared.redactor.text(attrs.metadata().name()),
            fields: visitor.values,
            trace,
            parent: parent_trace.map(|trace| trace.1),
            links: vec![],
        });
    }
    fn on_record(&self, id: &Id, record: &tracing::span::Record<'_>, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(id) else {
            return;
        };
        let mut extensions = span.extensions_mut();
        let Some(data) = extensions.get_mut::<SpanData>() else {
            return;
        };
        let mut visitor = Fields::new(&self.shared.redactor);
        record.record(&mut visitor);
        for (key, value) in visitor.values {
            if let Some(field) = data.fields.iter_mut().find(|field| field.0 == key) {
                field.1 = value;
            } else {
                data.fields.push((key, value));
            }
        }
    }
    fn on_follows_from(&self, id: &Id, follows: &Id, ctx: Context<'_, S>) {
        let Some(link) = ctx.span(follows).and_then(|span| {
            span.extensions()
                .get::<SpanData>()
                .and_then(|data| data.trace.clone())
        }) else {
            return;
        };
        let Some(span) = ctx.span(id) else {
            return;
        };
        if let Some(data) = span.extensions_mut().get_mut::<SpanData>() {
            data.links.push(json!({"traceId":link.0,"spanId":link.1,"attributes":[],"droppedAttributesCount":0}));
        }
    }
    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        let mut visitor = Fields::new(&self.shared.redactor);
        event.record(&mut visitor);
        let message = visitor
            .values
            .iter()
            .find(|(key, _)| key == "message")
            .map(|(_, value)| value.clone())
            .unwrap_or(json!(""));
        visitor.values.retain(|(key, _)| key != "message");
        let mut record = Record {
            level: *event.metadata().level(),
            time: SystemTime::now(),
            message,
            fields: visitor.values,
            spans: vec![],
            annotations: vec![],
            trace: None,
        };
        if let Some(scope) = ctx.event_scope(event) {
            for span in scope.from_root() {
                if let Some(data) = span.extensions().get::<SpanData>() {
                    record
                        .spans
                        .push((data.name.clone(), data.started.elapsed().as_millis() as u64));
                    record.annotations.extend(data.fields.clone());
                    record.trace = data.trace.clone();
                }
            }
        }
        self.shared.send(Command::Log(record));
    }
    fn on_close(&self, id: Id, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(&id) else {
            return;
        };
        let mut extensions = span.extensions_mut();
        let Some(data) = extensions.remove::<SpanData>() else {
            return;
        };
        let Some(trace) = data.trace else {
            return;
        };
        let mut fields = Vec::new();
        for (key, value) in data.fields {
            format::flatten(&key, &value, &mut fields);
        }
        self.shared.send(Command::Span(json!({
            "traceId":trace.0, "spanId":trace.1, "parentSpanId":data.parent.unwrap_or_default(),
            "name":data.name, "kind":1,
            "startTimeUnixNano":nanos(data.time), "endTimeUnixNano":nanos(SystemTime::now()),
            "attributes":super::otlp::attributes(fields), "droppedAttributesCount":0,
            "events":[], "droppedEventsCount":0, "links":data.links, "droppedLinksCount":0,
            "status":{"code":0},
        })));
    }
}

struct Fields<'a> {
    redactor: &'a format::Redactor,
    values: Vec<(String, Value)>,
}
impl<'a> Fields<'a> {
    fn new(redactor: &'a format::Redactor) -> Self {
        Self {
            redactor,
            values: vec![],
        }
    }
    fn push(&mut self, field: &Field, value: Value) {
        self.values.push((
            self.redactor.text(field.name()),
            self.redactor.clean(field.name(), value),
        ));
    }
}
impl Visit for Fields<'_> {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.push(field, json!(value));
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.push(field, json!(value));
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.push(field, json!(value));
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.push(field, json!(value));
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.push(field, json!(value));
    }
    fn record_error(&mut self, field: &Field, _: &(dyn std::error::Error + 'static)) {
        self.push(field, json!("[REDACTED]"));
    }
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        let text = format!("{value:?}");
        let value = if field.name() == "message" {
            json!(text)
        } else {
            serde_json::from_str(&text).unwrap_or_else(|_| {
                if text.contains('{') || text.contains('[') {
                    json!("[REDACTED]")
                } else {
                    json!(text)
                }
            })
        };
        self.push(field, value);
    }
}
