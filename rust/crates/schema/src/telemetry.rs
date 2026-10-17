use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    ObjectDecoder, ObjectEncoder,
};
pub const CURRENT_NOTICE_VERSION: i64 = 1;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NoticeVersion;
impl DomainDecode for NoticeVersion {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        crate::domain::literal(v, &[JsonValue::Number(1.0)], p).map(|_| Self)
    }
}
impl DomainEncode for NoticeVersion {
    fn encode(&self) -> JsonValue {
        JsonValue::Number(1.0)
    }
}
pub const MAX_DURATION_MS: i64 = 600_000;
crate::schema::literal_enum_type!(Operation,{
    V0=>"provider.auth.list",V1=>"provider.auth.key",V2=>"provider.auth.begin",V3=>"provider.auth.status",V4=>"provider.auth.complete",V5=>"provider.auth.cancel",V6=>"workspace.list",V7=>"session.list",V8=>"session.active",V9=>"session.get",V10=>"session.messages",V11=>"session.capturedChanges.list",V12=>"session.compaction.list",V13=>"session.compact",V14=>"session.snapshot",V15=>"session.pending.list",V16=>"session.attachment.read",V17=>"session.message.stream",V18=>"session.todo.list",V19=>"session.subagent.list",V20=>"session.pin",V21=>"session.unpin",V22=>"session.subagent.cancel",V23=>"session.subagent.answer",V24=>"session.team.economics",V25=>"session.team.shell.list",V26=>"session.team.shell.kill",V27=>"session.side-chat.list",V28=>"session.side-chat.create",V29=>"session.family.activity",V30=>"session.log",V31=>"session.subscribe",V32=>"session.unsubscribe",V33=>"session.prompt",V34=>"session.attachment.upload",V35=>"session.interrupt",V36=>"session.prediction",V37=>"session.promptGenerate",V38=>"session.permission.list",V39=>"session.permission.reply",V40=>"session.guardrail.status",V41=>"session.guardrail.request.list",V42=>"session.guardrail.reply",V43=>"session.form.list",V44=>"session.form.reply",V45=>"session.form.cancel",V46=>"session.shell.output",V47=>"session.autonomy.get",V48=>"session.autonomy.set",V49=>"session.goal.set",V50=>"session.goal.stop",V51=>"session.create",V52=>"session.status",V53=>"session.catalog",V54=>"workspace.catalog",V55=>"session.file.find",V56=>"workspace.file.find",V57=>"session.switchModel",V58=>"session.switchAgent",V59=>"session.command",V60=>"session.skill",V61=>"usage.providers",V62=>"usage.summary",V63=>"usage.report",V64=>"machine.keepAwake.get",V65=>"machine.keepAwake.set",
    V66=>"session.usageReport",V67=>"session.promptCosts",V68=>"session.taskCosts",V69=>"usage.forecast",V70=>"session.review.list",V71=>"session.review.decide",V72=>"incident.report",V73=>"incident.recent",V74=>"incident.guidance",V75=>"incident.guidance.get",V76=>"incident.guidance.clear"
});
crate::schema::literal_enum_type!(Outcome,{Ok=>"ok",Failed=>"failed",Unknown=>"unknown",Unavailable=>"unavailable"});
crate::schema::literal_enum_type!(Reason,{NotConnected=>"not-connected",InFlightLimit=>"in-flight-limit",RequestLimit=>"request-limit",Cancelled=>"cancelled"});
crate::schema::literal_enum_type!(Surface,{Tui=>"tui",Web=>"web"});
crate::schema::literal_enum_type!(Metric,{PromptAdmit=>"prompt.admit",StreamDelay=>"stream.delay",TranscriptLoad=>"transcript.load"});
fn strict(v: &JsonValue, p: &JsonPath, allowed: &[&str]) -> Result<(), DecodeError> {
    let JsonValue::Object(o) = v else {
        return Err(p.error(DecodeErrorKind::Expected("object")));
    };
    for (k, _) in o.iter() {
        if !allowed.iter().any(|name| k == &LosslessString::from(*name)) {
            return Err(p
                .key(k.clone())
                .error(DecodeErrorKind::Expected("no excess property")));
        }
    }
    Ok(())
}
fn at(v: &JsonValue, p: &JsonPath) -> Result<LosslessString, DecodeError> {
    let s = LosslessString::decode_at(v, p)?;
    let Some(x) = s.as_str() else {
        return Err(p.error(DecodeErrorKind::Expected("UTC timestamp")));
    };
    let x = x
        .strip_suffix(['\n', '\r', '\u{2028}', '\u{2029}'].as_slice())
        .unwrap_or(x);
    let b = x.as_bytes();
    if b.len() == 24
        && b[4] == b'-'
        && b[7] == b'-'
        && b[10] == b'T'
        && b[13] == b':'
        && b[16] == b':'
        && b[19] == b'.'
        && b[23] == b'Z'
        && b.iter()
            .enumerate()
            .all(|(i, c)| [4, 7, 10, 13, 16, 19, 23].contains(&i) || c.is_ascii_digit())
    {
        Ok(s)
    } else {
        Err(p.error(DecodeErrorKind::Expected("UTC timestamp")))
    }
}
fn duration(v: &JsonValue, p: &JsonPath, min: i64) -> Result<crate::schema::Int, DecodeError> {
    let x = crate::schema::Int::decode_at(v, p)?;
    if x.get() >= min && x.get() <= MAX_DURATION_MS {
        Ok(x)
    } else {
        Err(p.error(DecodeErrorKind::NumberRange {
            minimum: min as f64,
            maximum: MAX_DURATION_MS as f64,
            integer: true,
        }))
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Consent {
    pub enabled: bool,
    pub notice_version: NoticeVersion,
    pub decided_at: crate::schema::Int,
}
impl DomainDecode for Consent {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let notice_version = o.field("noticeVersion")?;
        let decided_at: crate::schema::Int = o.field("decidedAt")?;
        if decided_at.get() < 0 {
            return Err(p.key("decidedAt").error(DecodeErrorKind::NumberRange {
                minimum: 0.0,
                maximum: 9_007_199_254_740_991.0,
                integer: true,
            }));
        }
        Ok(Self {
            enabled: o.field("enabled")?,
            notice_version,
            decided_at,
        })
    }
}
impl DomainEncode for Consent {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("enabled", &self.enabled)
            .field("noticeVersion", &self.notice_version)
            .field("decidedAt", &self.decided_at)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ConsentState {
    pub consent: Option<Consent>,
    pub notice_version: NoticeVersion,
}
impl DomainDecode for ConsentState {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            consent: o.optional("consent")?,
            notice_version: o.field("noticeVersion")?,
        })
    }
}
impl DomainEncode for ConsentState {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("consent", &self.consent)
            .field("noticeVersion", &self.notice_version)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ConsentInput {
    pub enabled: bool,
    pub notice_version: NoticeVersion,
}
impl DomainDecode for ConsentInput {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        strict(v, p, &["enabled", "noticeVersion"])?;
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            enabled: o.field("enabled")?,
            notice_version: o.field("noticeVersion")?,
        })
    }
}
impl DomainEncode for ConsentInput {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("enabled", &self.enabled)
            .field("noticeVersion", &self.notice_version)
            .finish()
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TelemetryDisabled;
impl DomainDecode for TelemetryDisabled {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        ObjectDecoder::new(v, p)?
            .literal("_tag", &JsonValue::String("TelemetryDisabled".into()))?;
        Ok(Self)
    }
}
impl DomainEncode for TelemetryDisabled {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("_tag", &LosslessString::from("TelemetryDisabled"))
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct RequestSample {
    pub at: LosslessString,
    pub operation: Operation,
    pub outcome: Outcome,
    pub reason: Option<Reason>,
    pub queue_ms: crate::schema::Int,
    pub settlement_ms: Option<crate::schema::Int>,
    pub total_ms: crate::schema::Int,
}
impl DomainDecode for RequestSample {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        strict(
            v,
            p,
            &[
                "kind",
                "at",
                "operation",
                "outcome",
                "reason",
                "queueMs",
                "settlementMs",
                "totalMs",
            ],
        )?;
        let o = ObjectDecoder::new(v, p)?;
        o.literal("kind", &JsonValue::String("request".into()))?;
        let at = at(&o.field::<JsonValue>("at")?, &p.key("at"))?;
        Ok(Self {
            at,
            operation: o.field("operation")?,
            outcome: o.field("outcome")?,
            reason: o.optional("reason")?,
            queue_ms: duration(&o.field::<JsonValue>("queueMs")?, &p.key("queueMs"), 0)?,
            settlement_ms: o
                .optional::<JsonValue>("settlementMs")?
                .map(|x| duration(&x, &p.key("settlementMs"), 0))
                .transpose()?,
            total_ms: duration(&o.field::<JsonValue>("totalMs")?, &p.key("totalMs"), 0)?,
        })
    }
}
impl DomainEncode for RequestSample {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("kind", &LosslessString::from("request"))
            .field("at", &self.at)
            .field("operation", &self.operation)
            .field("outcome", &self.outcome)
            .optional("reason", &self.reason)
            .field("queueMs", &self.queue_ms)
            .optional("settlementMs", &self.settlement_ms)
            .field("totalMs", &self.total_ms)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct LongTaskSample {
    pub at: LosslessString,
    pub duration_ms: crate::schema::Int,
}
impl DomainDecode for LongTaskSample {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        strict(v, p, &["kind", "at", "durationMs"])?;
        let o = ObjectDecoder::new(v, p)?;
        o.literal("kind", &JsonValue::String("long-task".into()))?;
        Ok(Self {
            at: at(&o.field::<JsonValue>("at")?, &p.key("at"))?,
            duration_ms: duration(
                &o.field::<JsonValue>("durationMs")?,
                &p.key("durationMs"),
                50,
            )?,
        })
    }
}
impl DomainEncode for LongTaskSample {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("kind", &LosslessString::from("long-task"))
            .field("at", &self.at)
            .field("durationMs", &self.duration_ms)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ClientSample {
    pub at: LosslessString,
    pub surface: Surface,
    pub metric: Metric,
    pub duration_ms: crate::schema::Int,
}
impl DomainDecode for ClientSample {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        strict(v, p, &["kind", "at", "surface", "metric", "durationMs"])?;
        let o = ObjectDecoder::new(v, p)?;
        o.literal("kind", &JsonValue::String("client".into()))?;
        Ok(Self {
            at: at(&o.field::<JsonValue>("at")?, &p.key("at"))?,
            surface: o.field("surface")?,
            metric: o.field("metric")?,
            duration_ms: duration(
                &o.field::<JsonValue>("durationMs")?,
                &p.key("durationMs"),
                0,
            )?,
        })
    }
}
impl DomainEncode for ClientSample {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("kind", &LosslessString::from("client"))
            .field("at", &self.at)
            .field("surface", &self.surface)
            .field("metric", &self.metric)
            .field("durationMs", &self.duration_ms)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum Sample {
    Request(RequestSample),
    LongTask(LongTaskSample),
    Client(ClientSample),
}
impl DomainDecode for Sample {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        match o.tag("kind", &["request", "long-task", "client"])?.as_str() {
            Some("request") => RequestSample::decode_at(v, p).map(Self::Request),
            Some("long-task") => LongTaskSample::decode_at(v, p).map(Self::LongTask),
            Some("client") => ClientSample::decode_at(v, p).map(Self::Client),
            _ => Err(p.error(DecodeErrorKind::Expected("telemetry sample"))),
        }
    }
}
impl DomainEncode for Sample {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Request(x) => x.encode(),
            Self::LongTask(x) => x.encode(),
            Self::Client(x) => x.encode(),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Batch {
    pub samples: Vec<Sample>,
}
impl DomainDecode for Batch {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        strict(v, p, &["samples"])?;
        let o = ObjectDecoder::new(v, p)?;
        let samples: Vec<Sample> = o.field("samples")?;
        if !(1..=20).contains(&samples.len()) {
            return Err(p.key("samples").error(DecodeErrorKind::Length {
                minimum: 1,
                maximum: 20,
            }));
        }
        Ok(Self { samples })
    }
}
impl DomainEncode for Batch {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("samples", &self.samples)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct PageEntry {
    pub received_at: crate::schema::Int,
    pub sample: Sample,
}
impl DomainDecode for PageEntry {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let received_at: crate::schema::Int = o.field("receivedAt")?;
        if received_at.get() < 0 {
            return Err(p.key("receivedAt").error(DecodeErrorKind::NumberRange {
                minimum: 0.0,
                maximum: 9_007_199_254_740_991.0,
                integer: true,
            }));
        }
        Ok(Self {
            received_at,
            sample: o.field("sample")?,
        })
    }
}
impl DomainEncode for PageEntry {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("receivedAt", &self.received_at)
            .field("sample", &self.sample)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Cursor {
    pub next: Option<LosslessString>,
}
impl DomainDecode for Cursor {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            next: ObjectDecoder::new(v, p)?.optional("next")?,
        })
    }
}
impl DomainEncode for Cursor {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new().optional("next", &self.next).finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Page {
    pub data: Vec<PageEntry>,
    pub cursor: Cursor,
}
impl DomainDecode for Page {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            data: o.field("data")?,
            cursor: o.field("cursor")?,
        })
    }
}
impl DomainEncode for Page {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("data", &self.data)
            .field("cursor", &self.cursor)
            .finish()
    }
}
