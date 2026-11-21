use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
use crate::{agent, model, schema::AbsolutePath};
#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub name: LosslessString,
    pub template: LosslessString,
    pub description: Option<LosslessString>,
    pub agent: Option<agent::Id>,
    pub model: Option<model::Ref>,
    pub subtask: Option<bool>,
    pub locations: Option<Vec<AbsolutePath>>,
}
impl DomainDecode for Info {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            name: o.field("name")?,
            template: o.field("template")?,
            description: o.optional("description")?,
            agent: o.optional("agent")?,
            model: o.optional("model")?,
            subtask: o.optional("subtask")?,
            locations: o.optional("locations")?,
        })
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("name", &self.name)
            .field("template", &self.template)
            .optional("description", &self.description)
            .optional("agent", &self.agent)
            .optional("model", &self.model)
            .optional("subtask", &self.subtask)
            .optional("locations", &self.locations)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Empty;
impl DomainDecode for Empty {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let _ = ObjectDecoder::new(v, p)?;
        Ok(Self)
    }
}
impl DomainEncode for Empty {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new().finish()
    }
}
pub struct Updated;
impl crate::event::EventType for Updated {
    const TYPE: &'static str = "command.updated";
    type Data = Empty;
}
pub fn definition() -> crate::event::Definition {
    crate::event::Definition::ephemeral::<Updated>()
}
