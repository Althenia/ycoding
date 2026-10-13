use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonObject, JsonPath, JsonValue,
    LosslessString, ObjectDecoder, ObjectEncoder,
};
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct Id(LosslessString);
impl DomainDecode for Id {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        crate::domain::branded_string(v, "frm_", p).map(Self)
    }
}
impl DomainEncode for Id {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
pub type Metadata = JsonObject;
#[derive(Clone, Debug, PartialEq)]
pub struct Option {
    pub value: LosslessString,
    pub label: LosslessString,
    pub description: std::option::Option<LosslessString>,
}
impl DomainDecode for Option {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            value: o.field("value")?,
            label: o.field("label")?,
            description: o.optional("description")?,
        })
    }
}
impl DomainEncode for Option {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("value", &self.value)
            .field("label", &self.label)
            .optional("description", &self.description)
            .finish()
    }
}
crate::schema::literal_enum_type!(WhenOp,{Eq=>"eq",Neq=>"neq"});
#[derive(Clone, Debug, PartialEq)]
pub enum WhenValue {
    String(LosslessString),
    Number(f64),
    Boolean(bool),
}
impl DomainDecode for WhenValue {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        match v {
            JsonValue::String(x) => Ok(Self::String(x.clone())),
            JsonValue::Number(x) => Ok(Self::Number(*x)),
            JsonValue::Bool(x) => Ok(Self::Boolean(*x)),
            _ => Err(p.error(DecodeErrorKind::Expected("string, number, or boolean"))),
        }
    }
}
impl DomainEncode for WhenValue {
    fn encode(&self) -> JsonValue {
        match self {
            Self::String(x) => x.encode(),
            Self::Number(x) => x.encode(),
            Self::Boolean(x) => x.encode(),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct When {
    pub key: LosslessString,
    pub op: WhenOp,
    pub value: WhenValue,
}
impl DomainDecode for When {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            key: o.field("key")?,
            op: o.field("op")?,
            value: o.field("value")?,
        })
    }
}
impl DomainEncode for When {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("key", &self.key)
            .field("op", &self.op)
            .field("value", &self.value)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Base {
    pub key: LosslessString,
    pub title: std::option::Option<LosslessString>,
    pub description: std::option::Option<LosslessString>,
    pub required: std::option::Option<bool>,
    pub when: std::option::Option<Vec<When>>,
}
impl Base {
    fn decode(o: &ObjectDecoder<'_>) -> Result<Self, DecodeError> {
        Ok(Self {
            key: o.field("key")?,
            title: o.optional("title")?,
            description: o.optional("description")?,
            required: o.optional("required")?,
            when: o.optional("when")?,
        })
    }
    fn encode(&self, o: ObjectEncoder) -> ObjectEncoder {
        o.field("key", &self.key)
            .optional("title", &self.title)
            .optional("description", &self.description)
            .optional("required", &self.required)
            .optional("when", &self.when)
    }
}
crate::schema::literal_enum_type!(StringFormat,{Email=>"email",Uri=>"uri",Date=>"date",DateTime=>"date-time"});
#[derive(Clone, Debug, PartialEq)]
pub struct StringField {
    pub base: Base,
    pub format: std::option::Option<StringFormat>,
    pub min_length: std::option::Option<crate::schema::NonNegativeInt>,
    pub max_length: std::option::Option<crate::schema::NonNegativeInt>,
    pub pattern: std::option::Option<LosslessString>,
    pub placeholder: std::option::Option<LosslessString>,
    pub default: std::option::Option<LosslessString>,
    pub options: std::option::Option<Vec<Option>>,
    pub custom: std::option::Option<bool>,
}
impl DomainDecode for StringField {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("string".into()))?;
        Ok(Self {
            base: Base::decode(&o)?,
            format: o.optional("format")?,
            min_length: o.optional("minLength")?,
            max_length: o.optional("maxLength")?,
            pattern: o.optional("pattern")?,
            placeholder: o.optional("placeholder")?,
            default: o.optional("default")?,
            options: o.optional("options")?,
            custom: o.optional("custom")?,
        })
    }
}
impl DomainEncode for StringField {
    fn encode(&self) -> JsonValue {
        self.base
            .encode(ObjectEncoder::new())
            .field("type", &LosslessString::from("string"))
            .optional("format", &self.format)
            .optional("minLength", &self.min_length)
            .optional("maxLength", &self.max_length)
            .optional("pattern", &self.pattern)
            .optional("placeholder", &self.placeholder)
            .optional("default", &self.default)
            .optional("options", &self.options)
            .optional("custom", &self.custom)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct NumberField {
    pub base: Base,
    pub minimum: std::option::Option<f64>,
    pub maximum: std::option::Option<f64>,
    pub default: std::option::Option<f64>,
}
impl DomainDecode for NumberField {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("number".into()))?;
        Ok(Self {
            base: Base::decode(&o)?,
            minimum: o.optional("minimum")?,
            maximum: o.optional("maximum")?,
            default: o.optional("default")?,
        })
    }
}
impl DomainEncode for NumberField {
    fn encode(&self) -> JsonValue {
        self.base
            .encode(ObjectEncoder::new())
            .field("type", &LosslessString::from("number"))
            .optional("minimum", &self.minimum)
            .optional("maximum", &self.maximum)
            .optional("default", &self.default)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct IntegerField {
    pub base: Base,
    pub minimum: std::option::Option<f64>,
    pub maximum: std::option::Option<f64>,
    pub default: std::option::Option<f64>,
}
impl DomainDecode for IntegerField {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("integer".into()))?;
        Ok(Self {
            base: Base::decode(&o)?,
            minimum: o.optional("minimum")?,
            maximum: o.optional("maximum")?,
            default: o.optional("default")?,
        })
    }
}
impl DomainEncode for IntegerField {
    fn encode(&self) -> JsonValue {
        self.base
            .encode(ObjectEncoder::new())
            .field("type", &LosslessString::from("integer"))
            .optional("minimum", &self.minimum)
            .optional("maximum", &self.maximum)
            .optional("default", &self.default)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct BooleanField {
    pub base: Base,
    pub default: std::option::Option<bool>,
}
impl DomainDecode for BooleanField {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("boolean".into()))?;
        Ok(Self {
            base: Base::decode(&o)?,
            default: o.optional("default")?,
        })
    }
}
impl DomainEncode for BooleanField {
    fn encode(&self) -> JsonValue {
        self.base
            .encode(ObjectEncoder::new())
            .field("type", &LosslessString::from("boolean"))
            .optional("default", &self.default)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct MultiselectField {
    pub base: Base,
    pub options: Vec<Option>,
    pub min_items: std::option::Option<crate::schema::NonNegativeInt>,
    pub max_items: std::option::Option<crate::schema::NonNegativeInt>,
    pub custom: std::option::Option<bool>,
    pub default: std::option::Option<Vec<LosslessString>>,
}
impl DomainDecode for MultiselectField {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("multiselect".into()))?;
        Ok(Self {
            base: Base::decode(&o)?,
            options: o.field("options")?,
            min_items: o.optional("minItems")?,
            max_items: o.optional("maxItems")?,
            custom: o.optional("custom")?,
            default: o.optional("default")?,
        })
    }
}
impl DomainEncode for MultiselectField {
    fn encode(&self) -> JsonValue {
        self.base
            .encode(ObjectEncoder::new())
            .field("type", &LosslessString::from("multiselect"))
            .field("options", &self.options)
            .optional("minItems", &self.min_items)
            .optional("maxItems", &self.max_items)
            .optional("custom", &self.custom)
            .optional("default", &self.default)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ExternalField {
    pub key: LosslessString,
    pub title: std::option::Option<LosslessString>,
    pub description: std::option::Option<LosslessString>,
    pub url: LosslessString,
}
impl DomainDecode for ExternalField {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        o.literal("type", &JsonValue::String("external".into()))?;
        Ok(Self {
            key: o.field("key")?,
            title: o.optional("title")?,
            description: o.optional("description")?,
            url: o.field("url")?,
        })
    }
}
impl DomainEncode for ExternalField {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("key", &self.key)
            .field("type", &LosslessString::from("external"))
            .field("url", &self.url)
            .optional("title", &self.title)
            .optional("description", &self.description)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum Field {
    String(StringField),
    Number(NumberField),
    Integer(IntegerField),
    Boolean(BooleanField),
    Multiselect(MultiselectField),
    External(ExternalField),
}
impl DomainDecode for Field {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        match o
            .tag(
                "type",
                &[
                    "string",
                    "number",
                    "integer",
                    "boolean",
                    "multiselect",
                    "external",
                ],
            )?
            .as_str()
        {
            Some("string") => StringField::decode_at(v, p).map(Self::String),
            Some("number") => NumberField::decode_at(v, p).map(Self::Number),
            Some("integer") => IntegerField::decode_at(v, p).map(Self::Integer),
            Some("boolean") => BooleanField::decode_at(v, p).map(Self::Boolean),
            Some("multiselect") => MultiselectField::decode_at(v, p).map(Self::Multiselect),
            Some("external") => ExternalField::decode_at(v, p).map(Self::External),
            _ => Err(p.error(DecodeErrorKind::Expected("form field"))),
        }
    }
}
impl DomainEncode for Field {
    fn encode(&self) -> JsonValue {
        match self {
            Self::String(x) => x.encode(),
            Self::Number(x) => x.encode(),
            Self::Integer(x) => x.encode(),
            Self::Boolean(x) => x.encode(),
            Self::Multiselect(x) => x.encode(),
            Self::External(x) => x.encode(),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Fields(pub Vec<Field>);
impl DomainDecode for Fields {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let values = Vec::<Field>::decode_at(v, p)?;
        if values.is_empty() {
            Err(p.error(DecodeErrorKind::Length {
                minimum: 1,
                maximum: usize::MAX,
            }))
        } else {
            Ok(Self(values))
        }
    }
}
impl DomainEncode for Fields {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub id: Id,
    pub session_id: LosslessString,
    pub title: LosslessString,
    pub metadata: std::option::Option<Metadata>,
    pub fields: Fields,
}
impl DomainDecode for Info {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            id: o.field("id")?,
            session_id: o.field("sessionID")?,
            title: o.field("title")?,
            metadata: o.optional("metadata")?,
            fields: o.field("fields")?,
        })
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("sessionID", &self.session_id)
            .field("title", &self.title)
            .optional("metadata", &self.metadata)
            .field("fields", &self.fields)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    String(LosslessString),
    Number(f64),
    Boolean(bool),
    Strings(Vec<LosslessString>),
}
impl DomainDecode for Value {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        match v {
            JsonValue::String(x) => Ok(Self::String(x.clone())),
            JsonValue::Number(x) => Ok(Self::Number(*x)),
            JsonValue::Bool(x) => Ok(Self::Boolean(*x)),
            JsonValue::Array(_) => Vec::<LosslessString>::decode_at(v, p).map(Self::Strings),
            _ => Err(p.error(DecodeErrorKind::Expected("form value"))),
        }
    }
}
impl DomainEncode for Value {
    fn encode(&self) -> JsonValue {
        match self {
            Self::String(x) => x.encode(),
            Self::Number(x) => x.encode(),
            Self::Boolean(x) => x.encode(),
            Self::Strings(x) => x.encode(),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Answer(pub JsonObject);
impl DomainDecode for Answer {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let JsonValue::Object(map) = v else {
            return Err(p.error(DecodeErrorKind::Expected("object")));
        };
        for (k, val) in map.iter() {
            Value::decode_at(val, &p.key(k.clone()))?;
        }
        Ok(Self(map.clone()))
    }
}
impl DomainEncode for Answer {
    fn encode(&self) -> JsonValue {
        JsonValue::Object(self.0.clone())
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum State {
    Pending,
    Answered(Answer),
    Cancelled,
}
impl DomainDecode for State {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        match o
            .tag("status", &["pending", "answered", "cancelled"])?
            .as_str()
        {
            Some("pending") => Ok(Self::Pending),
            Some("answered") => Ok(Self::Answered(o.field("answer")?)),
            Some("cancelled") => Ok(Self::Cancelled),
            _ => Err(p.error(DecodeErrorKind::Expected("form state"))),
        }
    }
}
impl DomainEncode for State {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Pending => ObjectEncoder::new()
                .field("status", &LosslessString::from("pending"))
                .finish(),
            Self::Answered(x) => ObjectEncoder::new()
                .field("status", &LosslessString::from("answered"))
                .field("answer", x)
                .finish(),
            Self::Cancelled => ObjectEncoder::new()
                .field("status", &LosslessString::from("cancelled"))
                .finish(),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Reply {
    pub answer: Answer,
}
impl DomainDecode for Reply {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            answer: ObjectDecoder::new(v, p)?.field("answer")?,
        })
    }
}
impl DomainEncode for Reply {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new().field("answer", &self.answer).finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct CreatedData {
    pub form: Info,
}
impl DomainDecode for CreatedData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            form: ObjectDecoder::new(v, p)?.field("form")?,
        })
    }
}
impl DomainEncode for CreatedData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new().field("form", &self.form).finish()
    }
}
pub struct Created;
impl crate::event::EventType for Created {
    const TYPE: &'static str = "form.created";
    type Data = CreatedData;
}
#[derive(Clone, Debug, PartialEq)]
pub struct RepliedData {
    pub id: Id,
    pub session_id: LosslessString,
    pub answer: Answer,
}
impl DomainDecode for RepliedData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            id: o.field("id")?,
            session_id: o.field("sessionID")?,
            answer: o.field("answer")?,
        })
    }
}
impl DomainEncode for RepliedData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("sessionID", &self.session_id)
            .field("answer", &self.answer)
            .finish()
    }
}
pub struct Replied;
impl crate::event::EventType for Replied {
    const TYPE: &'static str = "form.replied";
    type Data = RepliedData;
}
#[derive(Clone, Debug, PartialEq)]
pub struct CancelledData {
    pub id: Id,
    pub session_id: LosslessString,
}
impl DomainDecode for CancelledData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            id: o.field("id")?,
            session_id: o.field("sessionID")?,
        })
    }
}
impl DomainEncode for CancelledData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("sessionID", &self.session_id)
            .finish()
    }
}
pub struct Cancelled;
impl crate::event::EventType for Cancelled {
    const TYPE: &'static str = "form.cancelled";
    type Data = CancelledData;
}
