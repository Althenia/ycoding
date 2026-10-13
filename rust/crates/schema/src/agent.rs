use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    ObjectDecoder, ObjectEncoder,
};
use crate::{
    model, permission, provider,
    schema::{AbsolutePath, PositiveInt},
};
pub type Id = LosslessString;
pub type Name = LosslessString;
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Color(pub LosslessString);
#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub id: Id,
    pub name: Name,
    pub model: Option<model::Ref>,
    pub request: provider::Request,
    pub system: Option<LosslessString>,
    pub description: Option<LosslessString>,
    pub mode: LosslessString,
    pub hidden: bool,
    pub color: Option<Color>,
    pub steps: Option<PositiveInt>,
    pub locations: Option<Vec<AbsolutePath>>,
    pub permissions: permission::Ruleset,
}
impl DomainDecode for Color {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let s = LosslessString::decode_at(v, p)?;
        if s.as_str().is_some_and(|x| {
            x.len() == 7 && x.starts_with('#') && x[1..].bytes().all(|b| b.is_ascii_hexdigit())
        }) || [
            "primary",
            "secondary",
            "accent",
            "success",
            "warning",
            "error",
            "info",
        ]
        .contains(&s.as_str().unwrap_or(""))
        {
            Ok(Self(s))
        } else {
            Err(p.error(DecodeErrorKind::Expected("agent color")))
        }
    }
}
impl DomainEncode for Color {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
impl DomainDecode for Info {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            id: o.field("id")?,
            name: o.field("name")?,
            model: o.optional("model")?,
            request: o.field("request")?,
            system: o.optional("system")?,
            description: o.optional("description")?,
            mode: o.tag("mode", &["subagent", "primary", "all"])?,
            hidden: o.field("hidden")?,
            color: o.optional("color")?,
            steps: o.optional("steps")?,
            locations: o.optional("locations")?,
            permissions: o.field("permissions")?,
        })
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("name", &self.name)
            .optional("model", &self.model)
            .field("request", &self.request)
            .optional("system", &self.system)
            .optional("description", &self.description)
            .field("mode", &self.mode)
            .field("hidden", &self.hidden)
            .optional("color", &self.color)
            .optional("steps", &self.steps)
            .optional("locations", &self.locations)
            .field("permissions", &self.permissions)
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
    const TYPE: &'static str = "agent.updated";
    type Data = Empty;
}
pub fn definition() -> crate::event::Definition {
    crate::event::Definition::ephemeral::<Updated>()
}
