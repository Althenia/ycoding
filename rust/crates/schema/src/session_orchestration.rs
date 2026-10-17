use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    ObjectDecoder, ObjectEncoder, stringify_json,
};
use crate::{
    agent, domain, model, schema::NonNegativeInt, session_delivery::Delivery,
    session_id::SessionId, session_message_id,
};

#[derive(Clone, Debug, PartialEq)]
pub struct Progress {
    pub text: LosslessString,
    pub time: NonNegativeInt,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Question {
    pub id: QuestionId,
    pub text: LosslessString,
    pub data: Option<domain::Json>,
    pub time: NonNegativeInt,
    pub deferred: Option<bool>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Answer {
    pub question_id: QuestionId,
    pub text: Option<LosslessString>,
    pub data: Option<domain::Json>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Task {
    pub session_id: SessionId,
    pub parent_id: SessionId,
    pub description: LosslessString,
    pub agent: agent::Id,
    pub model: model::Ref,
    pub background: bool,
    pub state: State,
    pub progress: Option<Progress>,
    pub question: Option<Question>,
    pub revision: NonNegativeInt,
    pub time: TaskTime,
    pub pinned_at: Option<NonNegativeInt>,
    pub stopped_recovery: Option<StoppedRecovery>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct StoppedRecovery {
    pub item_id: crate::session_review::Id,
}
#[derive(Clone, Debug, PartialEq)]
pub struct TaskTime {
    pub created: NonNegativeInt,
    pub updated: NonNegativeInt,
}
#[derive(Clone, Debug, PartialEq)]
pub struct QuestionId(pub LosslessString);
#[derive(Clone, Debug, PartialEq)]
pub enum State {
    Starting,
    Running,
    Waiting,
    Cancelling,
    Cancelled,
    Completed,
    Failed,
    Lost,
}
#[derive(Clone, Debug, PartialEq)]
pub enum TerminalState {
    Cancelled,
    Completed,
    Failed,
    Lost,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ListRank(pub u8);
#[derive(Clone, Debug, PartialEq)]
pub struct ListAnchor {
    pub rank: ListRank,
    pub updated: NonNegativeInt,
    pub session_id: SessionId,
    pub direction: Direction,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Direction {
    Previous,
    Next,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Summary {
    pub total: NonNegativeInt,
    pub active: NonNegativeInt,
    pub running: NonNegativeInt,
    pub waiting: NonNegativeInt,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Cursor {
    pub previous: Option<LosslessString>,
    pub next: Option<LosslessString>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Page {
    pub data: Vec<Task>,
    pub summary: Summary,
    pub cursor: Cursor,
}
#[derive(Clone, Debug, PartialEq)]
pub struct TeamView {
    pub children: Vec<Task>,
    pub omitted: NonNegativeInt,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Control {
    List,
    Send {
        session_id: SessionId,
        text: LosslessString,
        delivery: Delivery,
    },
    Answer {
        session_id: SessionId,
        question_id: QuestionId,
        text: Option<LosslessString>,
        data: Option<domain::Json>,
    },
    Cancel {
        session_id: SessionId,
    },
    Resume {
        session_id: SessionId,
    },
}
#[derive(Clone, Debug, PartialEq)]
pub enum Report {
    Progress {
        text: LosslessString,
    },
    Question {
        text: LosslessString,
        data: Option<domain::Json>,
    },
}
#[derive(Clone, Debug, PartialEq)]
pub struct Notification {
    pub id: LosslessString,
    pub parent_id: SessionId,
    pub child_id: SessionId,
    pub r#type: NotificationType,
    pub excerpt: Option<LosslessString>,
    pub revision: NonNegativeInt,
}
#[derive(Clone, Debug, PartialEq)]
pub enum NotificationType {
    Question,
    Completed,
    Failed,
    Cancelled,
    Lost,
    Resumed,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Change {
    Launched {
        parent_id: SessionId,
        parent_assistant_message_id: session_message_id::Id,
        tool_call_id: LosslessString,
        input_id: session_message_id::Id,
        description: LosslessString,
        agent: agent::Id,
        model: Box<model::Ref>,
        prompt_digest: LosslessString,
        background: bool,
        delivery: Delivery,
        usage_anchor: Option<crate::usage_anchor::Ref>,
    },
    Started,
    Backgrounded,
    Progressed {
        progress: Progress,
    },
    QuestionAsked {
        question: Question,
    },
    QuestionAnswered {
        answer: Answer,
    },
    QuestionTimedOut {
        question_id: QuestionId,
    },
    CancelRequested,
    Cancelled,
    Completed {
        excerpt: Option<LosslessString>,
    },
    Failed {
        error: LosslessString,
        excerpt: Option<LosslessString>,
    },
    Lost {
        excerpt: Option<LosslessString>,
    },
    Resumed,
}

pub(crate) fn bounded(
    value: &JsonValue,
    path: &JsonPath,
    max: usize,
) -> Result<LosslessString, DecodeError> {
    let text = LosslessString::decode_at(value, path)?;
    let bytes = text
        .code_units()
        .fold((0usize, false), |(size, pending), unit| {
            if (0xd800..=0xdbff).contains(&unit) {
                (size + 3, true)
            } else if (0xdc00..=0xdfff).contains(&unit) {
                if pending {
                    (size + 1, false)
                } else {
                    (size + 3, false)
                }
            } else {
                let n = if unit <= 0x7f {
                    1
                } else if unit <= 0x7ff {
                    2
                } else {
                    3
                };
                (size + n, false)
            }
        })
        .0;
    if bytes <= max {
        Ok(text)
    } else {
        Err(path.error(DecodeErrorKind::Length {
            minimum: 0,
            maximum: max,
        }))
    }
}
pub(crate) fn answer_data(value: &JsonValue, path: &JsonPath) -> Result<domain::Json, DecodeError> {
    let data = domain::Json::decode_at(value, path)?;
    if stringify_json(value).len() <= 8192 {
        Ok(data)
    } else {
        Err(path.error(DecodeErrorKind::Length {
            minimum: 0,
            maximum: 8192,
        }))
    }
}
fn str_field(
    o: &ObjectDecoder<'_>,
    p: &JsonPath,
    key: &str,
    max: usize,
) -> Result<LosslessString, DecodeError> {
    bounded(&o.field::<JsonValue>(key)?, &p.key(key), max)
}
fn opt_str(
    o: &ObjectDecoder<'_>,
    p: &JsonPath,
    key: &str,
    max: usize,
) -> Result<Option<LosslessString>, DecodeError> {
    o.optional::<JsonValue>(key)?
        .map(|v| bounded(&v, &p.key(key), max))
        .transpose()
}

impl DomainDecode for State {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let text = LosslessString::decode_at(v, p)?;
        match text.as_str() {
            Some("starting") => Ok(Self::Starting),
            Some("running") => Ok(Self::Running),
            Some("waiting") => Ok(Self::Waiting),
            Some("cancelling") => Ok(Self::Cancelling),
            Some("cancelled") => Ok(Self::Cancelled),
            Some("completed") => Ok(Self::Completed),
            Some("failed") => Ok(Self::Failed),
            Some("lost") => Ok(Self::Lost),
            _ => Err(p.error(DecodeErrorKind::Literal(
                [
                    "starting",
                    "running",
                    "waiting",
                    "cancelling",
                    "cancelled",
                    "completed",
                    "failed",
                    "lost",
                ]
                .iter()
                .map(|s| JsonValue::String((*s).into()))
                .collect(),
            ))),
        }
    }
}
impl DomainEncode for State {
    fn encode(&self) -> JsonValue {
        LosslessString::from(match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::Cancelling => "cancelling",
            Self::Cancelled => "cancelled",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Lost => "lost",
        })
        .encode()
    }
}
impl DomainDecode for TerminalState {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        match LosslessString::decode_at(v, p)?.as_str() {
            Some("cancelled") => Ok(Self::Cancelled),
            Some("completed") => Ok(Self::Completed),
            Some("failed") => Ok(Self::Failed),
            Some("lost") => Ok(Self::Lost),
            _ => Err(p.error(DecodeErrorKind::Literal(
                ["cancelled", "completed", "failed", "lost"]
                    .iter()
                    .map(|s| JsonValue::String((*s).into()))
                    .collect(),
            ))),
        }
    }
}
impl DomainEncode for TerminalState {
    fn encode(&self) -> JsonValue {
        LosslessString::from(match self {
            Self::Cancelled => "cancelled",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Lost => "lost",
        })
        .encode()
    }
}
impl DomainDecode for QuestionId {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        crate::domain::branded_string(v, "qst_", p).map(Self)
    }
}
impl DomainEncode for QuestionId {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
impl DomainDecode for Progress {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            text: str_field(&o, p, "text", 4096)?,
            time: o.field("time")?,
        })
    }
}
impl DomainEncode for Progress {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("text", &self.text)
            .field("time", &self.time)
            .finish()
    }
}
impl DomainDecode for Question {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let id = o.field("id")?;
        let data = o
            .optional::<JsonValue>("data")?
            .map(|x| answer_data(&x, &p.key("data")))
            .transpose()?;
        Ok(Self {
            id,
            text: str_field(&o, p, "text", 8192)?,
            data,
            time: o.field("time")?,
            deferred: o.optional("deferred")?,
        })
    }
}
impl DomainEncode for Question {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("text", &self.text)
            .optional("data", &self.data)
            .field("time", &self.time)
            .optional("deferred", &self.deferred)
            .finish()
    }
}
impl DomainDecode for Answer {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let data = o
            .optional::<JsonValue>("data")?
            .map(|x| answer_data(&x, &p.key("data")))
            .transpose()?;
        Ok(Self {
            question_id: o.field("questionID")?,
            text: opt_str(&o, p, "text", 65536)?,
            data,
        })
    }
}
impl DomainEncode for Answer {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("questionID", &self.question_id)
            .optional("text", &self.text)
            .optional("data", &self.data)
            .finish()
    }
}
impl DomainDecode for TaskTime {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            created: o.field("created")?,
            updated: o.field("updated")?,
        })
    }
}
impl DomainEncode for TaskTime {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("created", &self.created)
            .field("updated", &self.updated)
            .finish()
    }
}
impl DomainDecode for Task {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            session_id: o.field("sessionID")?,
            parent_id: o.field("parentID")?,
            description: str_field(&o, p, "description", 4096)?,
            agent: o.field("agent")?,
            model: o.field("model")?,
            background: o.field("background")?,
            state: o.field("state")?,
            progress: o.optional("progress")?,
            question: o.optional("question")?,
            revision: o.field("revision")?,
            time: o.field("time")?,
            pinned_at: o.optional("pinnedAt")?,
            stopped_recovery: o.optional("stoppedRecovery")?,
        })
    }
}
impl DomainDecode for StoppedRecovery {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            item_id: ObjectDecoder::new(v, p)?.field("itemID")?,
        })
    }
}
impl DomainEncode for StoppedRecovery {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new().field("itemID", &self.item_id).finish()
    }
}
impl DomainEncode for Task {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("parentID", &self.parent_id)
            .field("description", &self.description)
            .field("agent", &self.agent)
            .field("model", &self.model)
            .field("background", &self.background)
            .field("state", &self.state)
            .optional("progress", &self.progress)
            .optional("question", &self.question)
            .field("revision", &self.revision)
            .field("time", &self.time)
            .optional("pinnedAt", &self.pinned_at)
            .optional("stoppedRecovery", &self.stopped_recovery)
            .finish()
    }
}
impl DomainDecode for ListRank {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let n = crate::domain::integer_range(v, 0, 5, p)?;
        Ok(Self(n as u8))
    }
}
impl DomainEncode for ListRank {
    fn encode(&self) -> JsonValue {
        JsonValue::Number(self.0 as f64)
    }
}
impl DomainDecode for Direction {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        match LosslessString::decode_at(v, p)?.as_str() {
            Some("previous") => Ok(Self::Previous),
            Some("next") => Ok(Self::Next),
            _ => Err(p.error(DecodeErrorKind::Literal(
                ["previous", "next"]
                    .iter()
                    .map(|s| JsonValue::String((*s).into()))
                    .collect(),
            ))),
        }
    }
}
impl DomainEncode for Direction {
    fn encode(&self) -> JsonValue {
        LosslessString::from(match self {
            Self::Previous => "previous",
            Self::Next => "next",
        })
        .encode()
    }
}
impl DomainDecode for ListAnchor {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            rank: o.field("rank")?,
            updated: o.field("updated")?,
            session_id: o.field("sessionID")?,
            direction: o.field("direction")?,
        })
    }
}
impl DomainEncode for ListAnchor {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("rank", &self.rank)
            .field("updated", &self.updated)
            .field("sessionID", &self.session_id)
            .field("direction", &self.direction)
            .finish()
    }
}
impl DomainDecode for Summary {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            total: o.field("total")?,
            active: o.field("active")?,
            running: o.field("running")?,
            waiting: o.field("waiting")?,
        })
    }
}
impl DomainEncode for Summary {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("total", &self.total)
            .field("active", &self.active)
            .field("running", &self.running)
            .field("waiting", &self.waiting)
            .finish()
    }
}
impl DomainDecode for Cursor {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            previous: o.optional("previous")?,
            next: o.optional("next")?,
        })
    }
}
impl DomainEncode for Cursor {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("previous", &self.previous)
            .optional("next", &self.next)
            .finish()
    }
}
impl DomainDecode for Page {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            data: o.field("data")?,
            summary: o.field("summary")?,
            cursor: o.field("cursor")?,
        })
    }
}
impl DomainEncode for Page {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("data", &self.data)
            .field("summary", &self.summary)
            .field("cursor", &self.cursor)
            .finish()
    }
}
impl DomainDecode for TeamView {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            children: o.field("children")?,
            omitted: o.field("omitted")?,
        })
    }
}
impl DomainEncode for TeamView {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("children", &self.children)
            .field("omitted", &self.omitted)
            .finish()
    }
}
impl DomainDecode for Control {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        match o
            .tag("action", &["list", "send", "answer", "cancel", "resume"])?
            .as_str()
        {
            Some("list") => Ok(Self::List),
            Some("send") => Ok(Self::Send {
                session_id: o.field("sessionID")?,
                text: str_field(&o, p, "text", 65536)?,
                delivery: o.field("delivery")?,
            }),
            Some("answer") => {
                let data = o
                    .optional::<JsonValue>("data")?
                    .map(|x| answer_data(&x, &p.key("data")))
                    .transpose()?;
                Ok(Self::Answer {
                    session_id: o.field("sessionID")?,
                    question_id: o.field("questionID")?,
                    text: opt_str(&o, p, "text", 65536)?,
                    data,
                })
            }
            Some("cancel") => Ok(Self::Cancel {
                session_id: o.field("sessionID")?,
            }),
            Some("resume") => Ok(Self::Resume {
                session_id: o.field("sessionID")?,
            }),
            _ => Err(p.error(DecodeErrorKind::Expected("control"))),
        }
    }
}
impl DomainEncode for Control {
    fn encode(&self) -> JsonValue {
        match self {
            Self::List => ObjectEncoder::new().field("action", "list").finish(),
            Self::Send {
                session_id,
                text,
                delivery,
            } => ObjectEncoder::new()
                .field("action", "send")
                .field("sessionID", session_id)
                .field("text", text)
                .field("delivery", delivery)
                .finish(),
            Self::Answer {
                session_id,
                question_id,
                text,
                data,
            } => ObjectEncoder::new()
                .field("action", "answer")
                .field("sessionID", session_id)
                .field("questionID", question_id)
                .optional("text", text)
                .optional("data", data)
                .finish(),
            Self::Cancel { session_id } => ObjectEncoder::new()
                .field("action", "cancel")
                .field("sessionID", session_id)
                .finish(),
            Self::Resume { session_id } => ObjectEncoder::new()
                .field("action", "resume")
                .field("sessionID", session_id)
                .finish(),
        }
    }
}
impl DomainDecode for Report {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        match o.tag("action", &["progress", "question"])?.as_str() {
            Some("progress") => Ok(Self::Progress {
                text: str_field(&o, p, "text", 4096)?,
            }),
            Some("question") => {
                let data = o
                    .optional::<JsonValue>("data")?
                    .map(|x| answer_data(&x, &p.key("data")))
                    .transpose()?;
                Ok(Self::Question {
                    text: str_field(&o, p, "text", 8192)?,
                    data,
                })
            }
            _ => Err(p.error(DecodeErrorKind::Expected("report"))),
        }
    }
}
impl DomainEncode for Report {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Progress { text } => ObjectEncoder::new()
                .field("action", "progress")
                .field("text", text)
                .finish(),
            Self::Question { text, data } => ObjectEncoder::new()
                .field("action", "question")
                .field("text", text)
                .optional("data", data)
                .finish(),
        }
    }
}
impl DomainDecode for NotificationType {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        match LosslessString::decode_at(v, p)?.as_str() {
            Some("question") => Ok(Self::Question),
            Some("completed") => Ok(Self::Completed),
            Some("failed") => Ok(Self::Failed),
            Some("cancelled") => Ok(Self::Cancelled),
            Some("lost") => Ok(Self::Lost),
            Some("resumed") => Ok(Self::Resumed),
            _ => Err(p.error(DecodeErrorKind::Literal(
                [
                    "question",
                    "completed",
                    "failed",
                    "cancelled",
                    "lost",
                    "resumed",
                ]
                .iter()
                .map(|s| JsonValue::String((*s).into()))
                .collect(),
            ))),
        }
    }
}
impl DomainEncode for NotificationType {
    fn encode(&self) -> JsonValue {
        LosslessString::from(match self {
            Self::Question => "question",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Lost => "lost",
            Self::Resumed => "resumed",
        })
        .encode()
    }
}
impl DomainDecode for Notification {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            id: o.field("id")?,
            parent_id: o.field("parentID")?,
            child_id: o.field("childID")?,
            r#type: o.field("type")?,
            excerpt: opt_str(&o, p, "excerpt", 16384)?,
            revision: o.field("revision")?,
        })
    }
}
impl DomainEncode for Notification {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("parentID", &self.parent_id)
            .field("childID", &self.child_id)
            .field("type", &self.r#type)
            .optional("excerpt", &self.excerpt)
            .field("revision", &self.revision)
            .finish()
    }
}
impl DomainDecode for Change {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        match o
            .tag(
                "type",
                &[
                    "launched",
                    "started",
                    "backgrounded",
                    "progressed",
                    "question_asked",
                    "question_answered",
                    "question_timed_out",
                    "cancel_requested",
                    "cancelled",
                    "completed",
                    "failed",
                    "lost",
                    "resumed",
                ],
            )?
            .as_str()
        {
            Some("launched") => Ok(Self::Launched {
                parent_id: o.field("parentID")?,
                parent_assistant_message_id: o.field("parentAssistantMessageID")?,
                tool_call_id: str_field(&o, p, "toolCallID", 512)?,
                input_id: o.field("inputID")?,
                description: str_field(&o, p, "description", 4096)?,
                agent: o.field("agent")?,
                model: Box::new(o.field("model")?),
                prompt_digest: o.field("promptDigest")?,
                background: o.field("background")?,
                delivery: o.field("delivery")?,
                usage_anchor: o.optional("usageAnchor")?,
            }),
            Some("started") => Ok(Self::Started),
            Some("backgrounded") => Ok(Self::Backgrounded),
            Some("progressed") => Ok(Self::Progressed {
                progress: o.field("progress")?,
            }),
            Some("question_asked") => Ok(Self::QuestionAsked {
                question: o.field("question")?,
            }),
            Some("question_answered") => Ok(Self::QuestionAnswered {
                answer: o.field("answer")?,
            }),
            Some("question_timed_out") => Ok(Self::QuestionTimedOut {
                question_id: o.field("questionID")?,
            }),
            Some("cancel_requested") => Ok(Self::CancelRequested),
            Some("cancelled") => Ok(Self::Cancelled),
            Some("completed") => Ok(Self::Completed {
                excerpt: opt_str(&o, p, "excerpt", 16384)?,
            }),
            Some("failed") => Ok(Self::Failed {
                error: str_field(&o, p, "error", 16384)?,
                excerpt: opt_str(&o, p, "excerpt", 16384)?,
            }),
            Some("lost") => Ok(Self::Lost {
                excerpt: opt_str(&o, p, "excerpt", 16384)?,
            }),
            Some("resumed") => Ok(Self::Resumed),
            _ => Err(p.error(DecodeErrorKind::Expected("change"))),
        }
    }
}
impl DomainEncode for Change {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Launched {
                parent_id,
                parent_assistant_message_id,
                tool_call_id,
                input_id,
                description,
                agent,
                model,
                prompt_digest,
                background,
                delivery,
                usage_anchor,
            } => ObjectEncoder::new()
                .field("type", "launched")
                .field("parentID", parent_id)
                .field("parentAssistantMessageID", parent_assistant_message_id)
                .field("toolCallID", tool_call_id)
                .field("inputID", input_id)
                .field("description", description)
                .field("agent", agent)
                .field("model", model.as_ref())
                .field("promptDigest", prompt_digest)
                .field("background", background)
                .field("delivery", delivery)
                .optional("usageAnchor", usage_anchor)
                .finish(),
            Self::Started => ObjectEncoder::new().field("type", "started").finish(),
            Self::Backgrounded => ObjectEncoder::new().field("type", "backgrounded").finish(),
            Self::Progressed { progress } => ObjectEncoder::new()
                .field("type", "progressed")
                .field("progress", progress)
                .finish(),
            Self::QuestionAsked { question } => ObjectEncoder::new()
                .field("type", "question_asked")
                .field("question", question)
                .finish(),
            Self::QuestionAnswered { answer } => ObjectEncoder::new()
                .field("type", "question_answered")
                .field("answer", answer)
                .finish(),
            Self::QuestionTimedOut { question_id } => ObjectEncoder::new()
                .field("type", "question_timed_out")
                .field("questionID", question_id)
                .finish(),
            Self::CancelRequested => ObjectEncoder::new()
                .field("type", "cancel_requested")
                .finish(),
            Self::Cancelled => ObjectEncoder::new().field("type", "cancelled").finish(),
            Self::Completed { excerpt } => ObjectEncoder::new()
                .field("type", "completed")
                .optional("excerpt", excerpt)
                .finish(),
            Self::Failed { error, excerpt } => ObjectEncoder::new()
                .field("type", "failed")
                .field("error", error)
                .optional("excerpt", excerpt)
                .finish(),
            Self::Lost { excerpt } => ObjectEncoder::new()
                .field("type", "lost")
                .optional("excerpt", excerpt)
                .finish(),
            Self::Resumed => ObjectEncoder::new().field("type", "resumed").finish(),
        }
    }
}
