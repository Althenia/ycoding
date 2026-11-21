use crate::skill;
use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    ObjectDecoder, ObjectEncoder,
};

#[derive(Clone, Debug, PartialEq)]
pub enum State {
    Active,
    Inactive { inactive_reason: LosslessString },
}
#[derive(Clone, Debug, PartialEq)]
pub struct Conflict {
    pub r#type: LosslessString,
    pub id: LosslessString,
    pub name: LosslessString,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub id: skill::Id,
    pub name: skill::Name,
    pub activated_by: LosslessString,
    pub activation_message_id: crate::session_message_id::Id,
    pub content: LosslessString,
    pub conflicts: Vec<Conflict>,
    pub declarations: skill::Conflicts,
    pub state: State,
}

impl DomainDecode for State {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        match ObjectDecoder::new(value, path)?
            .tag("state", &["active", "inactive"])?
            .as_str()
        {
            Some("active") => {
                ObjectDecoder::new(value, path)?
                    .literal("state", &JsonValue::String("active".into()))?;
                Ok(Self::Active)
            }
            Some("inactive") => {
                let object = ObjectDecoder::new(value, path)?;
                let inactive_reason = object.tag(
                    "inactiveReason",
                    &["agent_switched", "compacted", "conflict_resolved"],
                )?;
                Ok(Self::Inactive { inactive_reason })
            }
            _ => Err(path.error(DecodeErrorKind::Expected("skill state"))),
        }
    }
}
impl DomainEncode for State {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Active => ObjectEncoder::new().field("state", "active").finish(),
            Self::Inactive { inactive_reason } => ObjectEncoder::new()
                .field("state", "inactive")
                .field("inactiveReason", inactive_reason)
                .finish(),
        }
    }
}
impl DomainDecode for Conflict {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let r#type = object.tag("type", &["skill", "instruction"])?;
        Ok(Self {
            r#type,
            id: object.field("id")?,
            name: object.field("name")?,
        })
    }
}
impl DomainEncode for Conflict {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("type", &self.r#type)
            .field("id", &self.id)
            .field("name", &self.name)
            .finish()
    }
}
impl DomainDecode for Info {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let id = object.field("id")?;
        let name = object.field("name")?;
        let activated_by = object.tag("activatedBy", &["reference", "tool"])?;
        let activation_message_id = object.field("activationMessageID")?;
        let content = object.field("content")?;
        let conflicts = object.field("conflicts")?;
        let declarations = object.field("declarations")?;
        let state = State::decode_at(value, path)?;
        if matches!(state, State::Active)
            && object.optional::<JsonValue>("inactiveReason")?.is_some()
        {
            return Err(path
                .key("inactiveReason")
                .error(DecodeErrorKind::Expected("missing")));
        }
        Ok(Self {
            id,
            name,
            activated_by,
            activation_message_id,
            content,
            conflicts,
            declarations,
            state,
        })
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        let mut object = ObjectEncoder::new()
            .field("id", &self.id)
            .field("name", &self.name)
            .field("activatedBy", &self.activated_by)
            .field("activationMessageID", &self.activation_message_id)
            .field("content", &self.content)
            .field("conflicts", &self.conflicts)
            .field("declarations", &self.declarations);
        match &self.state {
            State::Active => object = object.field("state", "active"),
            State::Inactive { inactive_reason } => {
                object = object
                    .field("state", "inactive")
                    .field("inactiveReason", inactive_reason)
            }
        }
        object.finish()
    }
}
