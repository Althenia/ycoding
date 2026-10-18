use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    ObjectDecoder, ObjectEncoder, agent, domain, form, guardrail, permission, question,
    schema::NonNegativeInt,
    session_id::SessionId,
    session_message_id,
    session_orchestration::{self, QuestionId},
};

crate::schema::string_type!(Id, "rvw_");
crate::schema::literal_enum_type!(Kind,{Question=>"question",SubagentQuestion=>"subagent_question",Guardrail=>"guardrail",Permission=>"permission",Recovery=>"recovery"});
crate::schema::literal_enum_type!(Reason,{Disabled=>"disabled",FreeText=>"free_text",Refused=>"refused",LowConfidence=>"low_confidence",Escalated=>"escalated",Error=>"error",Timeout=>"timeout",SleepEntry=>"sleep_entry",Restart=>"restart",Unavailable=>"unavailable",InvalidRequest=>"invalid-request",ProviderFailed=>"provider-failed",InputTooLarge=>"input-too-large",InvalidOutput=>"invalid-output",TruncatedOutput=>"truncated-output",UnsupportedOutput=>"unsupported-output",ConflictingGrades=>"conflicting_grades"});
crate::schema::literal_enum_type!(RecoveryChoice,{Continue=>"continue",Stop=>"stop"});
crate::schema::literal_enum_type!(Dismissable,{Question=>"question",SubagentQuestion=>"subagent_question"});

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Fingerprint(LosslessString);
impl Fingerprint {
    pub fn as_lossless(&self) -> &LosslessString {
        &self.0
    }
}
impl DomainDecode for Fingerprint {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let text = LosslessString::decode_at(v, p)?;
        if text.len() == 64
            && text
                .code_units()
                .all(|unit| matches!(unit, 0x30..=0x39 | 0x61..=0x66))
        {
            return Ok(Self(text));
        }
        Err(p.error(DecodeErrorKind::Expected("lowercase sha256 digest")))
    }
}
impl DomainEncode for Fingerprint {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Origin {
    Tool {
        message_id: session_message_id::Id,
        call_id: LosslessString,
    },
    Question {
        question_id: QuestionId,
    },
    Request {
        request_id: LosslessString,
    },
}
impl DomainDecode for Origin {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        if let (Ok(message_id), Ok(call_id)) = (o.field("messageID"), o.field("callID")) {
            return Ok(Self::Tool {
                message_id,
                call_id,
            });
        }
        if let Ok(question_id) = o.field("questionID") {
            return Ok(Self::Question { question_id });
        }
        let request_id: LosslessString = o.field("requestID")?;
        if request_id.is_empty() {
            return Err(p.key("requestID").error(DecodeErrorKind::Length {
                minimum: 1,
                maximum: usize::MAX,
            }));
        }
        Ok(Self::Request { request_id })
    }
}
impl DomainEncode for Origin {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Tool {
                message_id,
                call_id,
            } => ObjectEncoder::new()
                .field("messageID", message_id)
                .field("callID", call_id)
                .finish(),
            Self::Question { question_id } => ObjectEncoder::new()
                .field("questionID", question_id)
                .finish(),
            Self::Request { request_id } => {
                ObjectEncoder::new().field("requestID", request_id).finish()
            }
        }
    }
}

fn tagged(kind: &'static str) -> ObjectEncoder {
    ObjectEncoder::new().field("type", &LosslessString::from(kind))
}

#[derive(Clone, Debug, PartialEq)]
pub struct FormPayload {
    pub title: LosslessString,
    pub fields: Vec<form::Field>,
    pub question_tool: bool,
}
impl DomainDecode for FormPayload {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("form".into()))?;
        let fields: Vec<form::Field> = o.field("fields")?;
        if fields.is_empty() {
            return Err(p.key("fields").error(DecodeErrorKind::Length {
                minimum: 1,
                maximum: usize::MAX,
            }));
        }
        let question_tool = match o.optional::<bool>("questionTool")? {
            None => false,
            Some(true) => true,
            Some(false) => {
                return Err(p
                    .key("questionTool")
                    .error(DecodeErrorKind::Expected("true")));
            }
        };
        Ok(Self {
            title: o.field("title")?,
            fields,
            question_tool,
        })
    }
}
impl DomainEncode for FormPayload {
    fn encode(&self) -> JsonValue {
        tagged("form")
            .field("title", &self.title)
            .field("fields", &self.fields)
            .optional("questionTool", &self.question_tool.then_some(true))
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct QuestionPayload {
    pub questions: Vec<question::Info>,
}
impl DomainDecode for QuestionPayload {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("question".into()))?;
        Ok(Self {
            questions: o.field("questions")?,
        })
    }
}
impl DomainEncode for QuestionPayload {
    fn encode(&self) -> JsonValue {
        tagged("question")
            .field("questions", &self.questions)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SubagentQuestionPayload {
    pub text: LosslessString,
    pub data: Option<domain::Json>,
}
impl DomainDecode for SubagentQuestionPayload {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("subagent_question".into()))?;
        Ok(Self {
            text: session_orchestration::bounded(
                &o.field::<JsonValue>("text")?,
                &p.key("text"),
                8192,
            )?,
            data: o
                .optional::<JsonValue>("data")?
                .map(|value| session_orchestration::answer_data(&value, &p.key("data")))
                .transpose()?,
        })
    }
}
impl DomainEncode for SubagentQuestionPayload {
    fn encode(&self) -> JsonValue {
        tagged("subagent_question")
            .field("text", &self.text)
            .optional("data", &self.data)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct GuardrailPayload {
    pub action: LosslessString,
    pub resources: Vec<LosslessString>,
    pub rule_ids: Vec<LosslessString>,
    pub reason: LosslessString,
    pub hard_review: bool,
    pub directories: Vec<LosslessString>,
    pub fingerprint: Fingerprint,
    pub request_id: guardrail::RequestId,
}
impl DomainDecode for GuardrailPayload {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("guardrail".into()))?;
        Ok(Self {
            action: o.field("action")?,
            resources: o.field("resources")?,
            rule_ids: o.field("ruleIDs")?,
            reason: o.field("reason")?,
            hard_review: o.field("hardReview")?,
            directories: o.field("directories")?,
            fingerprint: o.field("fingerprint")?,
            request_id: o.field("requestID")?,
        })
    }
}
impl DomainEncode for GuardrailPayload {
    fn encode(&self) -> JsonValue {
        tagged("guardrail")
            .field("action", &self.action)
            .field("resources", &self.resources)
            .field("ruleIDs", &self.rule_ids)
            .field("reason", &self.reason)
            .field("hardReview", &self.hard_review)
            .field("directories", &self.directories)
            .field("fingerprint", &self.fingerprint)
            .field("requestID", &self.request_id)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PermissionPayload {
    pub action: LosslessString,
    pub resources: Vec<LosslessString>,
    pub save: Option<Vec<LosslessString>>,
    pub fingerprint: Fingerprint,
    pub request_id: permission::Id,
}
impl DomainDecode for PermissionPayload {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("permission".into()))?;
        Ok(Self {
            action: o.field("action")?,
            resources: o.field("resources")?,
            save: o.optional("save")?,
            fingerprint: o.field("fingerprint")?,
            request_id: o.field("requestID")?,
        })
    }
}
impl DomainEncode for PermissionPayload {
    fn encode(&self) -> JsonValue {
        tagged("permission")
            .field("action", &self.action)
            .field("resources", &self.resources)
            .optional("save", &self.save)
            .field("fingerprint", &self.fingerprint)
            .field("requestID", &self.request_id)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RecoveryTool {
    pub message_id: session_message_id::Id,
    pub call_id: LosslessString,
    pub name: LosslessString,
}
impl DomainDecode for RecoveryTool {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            message_id: o.field("messageID")?,
            call_id: o.field("callID")?,
            name: o.field("name")?,
        })
    }
}
impl DomainEncode for RecoveryTool {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("messageID", &self.message_id)
            .field("callID", &self.call_id)
            .field("name", &self.name)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RecoveryPayload {
    pub tools: Vec<RecoveryTool>,
}
impl DomainDecode for RecoveryPayload {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("recovery".into()))?;
        let tools: Vec<RecoveryTool> = o.field("tools")?;
        if tools.is_empty() {
            return Err(p.key("tools").error(DecodeErrorKind::Length {
                minimum: 1,
                maximum: usize::MAX,
            }));
        }
        Ok(Self { tools })
    }
}
impl DomainEncode for RecoveryPayload {
    fn encode(&self) -> JsonValue {
        tagged("recovery").field("tools", &self.tools).finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Payload {
    Form(FormPayload),
    Question(QuestionPayload),
    SubagentQuestion(SubagentQuestionPayload),
    Guardrail(GuardrailPayload),
    Permission(PermissionPayload),
    Recovery(RecoveryPayload),
}
impl DomainDecode for Payload {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let tag = o.tag(
            "type",
            &[
                "form",
                "question",
                "subagent_question",
                "guardrail",
                "permission",
                "recovery",
            ],
        )?;
        match tag.as_str() {
            Some("form") => FormPayload::decode_at(v, p).map(Self::Form),
            Some("question") => QuestionPayload::decode_at(v, p).map(Self::Question),
            Some("subagent_question") => {
                SubagentQuestionPayload::decode_at(v, p).map(Self::SubagentQuestion)
            }
            Some("guardrail") => GuardrailPayload::decode_at(v, p).map(Self::Guardrail),
            Some("permission") => PermissionPayload::decode_at(v, p).map(Self::Permission),
            _ => RecoveryPayload::decode_at(v, p).map(Self::Recovery),
        }
    }
}
impl DomainEncode for Payload {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Form(payload) => payload.encode(),
            Self::Question(payload) => payload.encode(),
            Self::SubagentQuestion(payload) => payload.encode(),
            Self::Guardrail(payload) => payload.encode(),
            Self::Permission(payload) => payload.encode(),
            Self::Recovery(payload) => payload.encode(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Deferral {
    pub item_id: Id,
    pub kind: Kind,
    pub reason: Reason,
    pub choice: Option<LosslessString>,
    pub confidence: Option<guardrail::Confidence>,
    pub grades: Option<Vec<guardrail::Grade>>,
    pub origin: Origin,
    pub payload: Payload,
}
impl DomainDecode for Deferral {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            item_id: o.field("itemID")?,
            kind: o.field("kind")?,
            reason: o.field("reason")?,
            choice: o.optional("choice")?,
            confidence: o.optional("confidence")?,
            grades: o.optional("grades")?,
            origin: o.field("origin")?,
            payload: o.field("payload")?,
        })
    }
}
impl Deferral {
    pub fn encode_into(&self, object: ObjectEncoder) -> ObjectEncoder {
        object
            .field("itemID", &self.item_id)
            .field("kind", &self.kind)
            .field("reason", &self.reason)
            .optional("choice", &self.choice)
            .optional("confidence", &self.confidence)
            .optional("grades", &self.grades)
            .field("origin", &self.origin)
            .field("payload", &self.payload)
    }
}
impl DomainEncode for Deferral {
    fn encode(&self) -> JsonValue {
        self.encode_into(ObjectEncoder::new()).finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Child {
    pub agent: agent::Id,
    pub description: LosslessString,
}
impl DomainDecode for Child {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            agent: o.field("agent")?,
            description: session_orchestration::bounded(
                &o.field::<JsonValue>("description")?,
                &p.key("description"),
                4096,
            )?,
        })
    }
}
impl DomainEncode for Child {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("agent", &self.agent)
            .field("description", &self.description)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub deferral: Deferral,
    pub session_id: SessionId,
    pub root_session_id: SessionId,
    pub session_title: LosslessString,
    pub created: NonNegativeInt,
    pub child: Option<Child>,
}
fn pairs(kind: Kind, payload: &Payload) -> bool {
    matches!(
        (kind, payload),
        (Kind::Question, Payload::Form(_) | Payload::Question(_))
            | (Kind::SubagentQuestion, Payload::SubagentQuestion(_))
            | (Kind::Guardrail, Payload::Guardrail(_))
            | (Kind::Permission, Payload::Permission(_))
            | (Kind::Recovery, Payload::Recovery(_))
    )
}
impl DomainDecode for Item {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let deferral = Deferral::decode_at(v, p)?;
        if !pairs(deferral.kind, &deferral.payload) {
            return Err(p
                .key("payload")
                .error(DecodeErrorKind::Expected("payload matching the item kind")));
        }
        Ok(Self {
            deferral,
            session_id: o.field("sessionID")?,
            root_session_id: o.field("rootSessionID")?,
            session_title: o.field("sessionTitle")?,
            created: o.field("created")?,
            child: o.optional("child")?,
        })
    }
}
impl DomainEncode for Item {
    fn encode(&self) -> JsonValue {
        self.deferral
            .encode_into(ObjectEncoder::new())
            .field("sessionID", &self.session_id)
            .field("rootSessionID", &self.root_session_id)
            .field("sessionTitle", &self.session_title)
            .field("created", &self.created)
            .optional("child", &self.child)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Answers {
    Form(form::Answer),
    Questions(Vec<question::Answer>),
}
impl DomainDecode for Answers {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        match v {
            JsonValue::Object(_) => form::Answer::decode_at(v, p).map(Self::Form),
            JsonValue::Array(_) => Vec::<question::Answer>::decode_at(v, p).map(Self::Questions),
            _ => Err(p.error(DecodeErrorKind::Expected("form answer or question answers"))),
        }
    }
}
impl DomainEncode for Answers {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Form(answer) => answer.encode(),
            Self::Questions(answers) => answers.encode(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Decision {
    Question {
        answers: Answers,
    },
    SubagentQuestion {
        text: LosslessString,
        data: Option<domain::Json>,
    },
    Guardrail {
        reply: guardrail::Reply,
    },
    Permission {
        reply: permission::Reply,
    },
    Recovery {
        choice: RecoveryChoice,
    },
    Dismissed {
        kind: Dismissable,
    },
}
impl DomainDecode for Decision {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        let kind = o.tag(
            "kind",
            &[
                "question",
                "subagent_question",
                "guardrail",
                "permission",
                "recovery",
            ],
        )?;
        let decided = match kind.as_str() {
            Some("question") => o.field("answers").map(|answers| Self::Question { answers }),
            Some("subagent_question") => subagent(&o, p),
            Some("guardrail") => o.field("reply").map(|reply| Self::Guardrail { reply }),
            Some("permission") => o.field("reply").map(|reply| Self::Permission { reply }),
            _ => o.field("choice").map(|choice| Self::Recovery { choice }),
        };
        match decided {
            Ok(decision) => Ok(decision),
            Err(error) => {
                let dismissed = matches!(kind.as_str(), Some("question" | "subagent_question"))
                    && o.optional::<JsonValue>("dismissed")? == Some(JsonValue::Bool(true));
                if !dismissed {
                    return Err(error);
                }
                Ok(Self::Dismissed {
                    kind: Dismissable::decode_at(&kind.encode(), &p.key("kind"))?,
                })
            }
        }
    }
}
fn subagent(o: &ObjectDecoder<'_>, p: &JsonPath) -> Result<Decision, DecodeError> {
    Ok(Decision::SubagentQuestion {
        text: session_orchestration::bounded(
            &o.field::<JsonValue>("text")?,
            &p.key("text"),
            65536,
        )?,
        data: o
            .optional::<JsonValue>("data")?
            .map(|value| session_orchestration::answer_data(&value, &p.key("data")))
            .transpose()?,
    })
}
impl DomainEncode for Decision {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Question { answers } => ObjectEncoder::new()
                .field("kind", &LosslessString::from("question"))
                .field("answers", answers)
                .finish(),
            Self::SubagentQuestion { text, data } => ObjectEncoder::new()
                .field("kind", &LosslessString::from("subagent_question"))
                .field("text", text)
                .optional("data", data)
                .finish(),
            Self::Guardrail { reply } => ObjectEncoder::new()
                .field("kind", &LosslessString::from("guardrail"))
                .field("reply", reply)
                .finish(),
            Self::Permission { reply } => ObjectEncoder::new()
                .field("kind", &LosslessString::from("permission"))
                .field("reply", reply)
                .finish(),
            Self::Recovery { choice } => ObjectEncoder::new()
                .field("kind", &LosslessString::from("recovery"))
                .field("choice", choice)
                .finish(),
            Self::Dismissed { kind } => ObjectEncoder::new()
                .field("kind", kind)
                .field("dismissed", &true)
                .finish(),
        }
    }
}
