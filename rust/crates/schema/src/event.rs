use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonObject, JsonPath, JsonValue, LosslessString,
    ObjectDecoder, ObjectEncoder,
};
use crate::{location, schema::DateTimeUtcFromMillis, source_epoch::SourceEpoch};

crate::schema::string_type!(Id, "evt_");
crate::schema::integer_type!(Seq, 0);
crate::schema::integer_type!(Version, 1);

impl Id {
    pub fn create(
        generator: &mut crate::identifier::Generator,
        timestamp: f64,
        entropy: [u8; 14],
    ) -> Result<Self, DecodeError> {
        Self::new(format!(
            "evt_{}",
            generator
                .ascending(timestamp, entropy)?
                .to_utf8()
                .expect("generator emits ASCII")
        ))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DurableEnvelope {
    pub aggregate_id: LosslessString,
    pub seq: Seq,
    pub version: Version,
}
impl DomainDecode for DurableEnvelope {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            aggregate_id: object.field("aggregateID")?,
            seq: object.field("seq")?,
            version: object.field("version")?,
        })
    }
}
impl DomainEncode for DurableEnvelope {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("aggregateID", &self.aggregate_id)
            .field("seq", &self.seq)
            .field("version", &self.version)
            .finish()
    }
}

pub trait EventType {
    const TYPE: &'static str;
    type Data: DomainDecode + DomainEncode;
}
pub trait DurableEventType: EventType {
    const VERSION: i64;
    const AGGREGATE: &'static str;
}

#[derive(Clone, Debug, PartialEq)]
pub struct Payload<D> {
    pub id: Id,
    pub created: DateTimeUtcFromMillis,
    pub metadata: Option<JsonObject>,
    pub source_epoch: Option<SourceEpoch>,
    pub location: Option<location::Ref>,
    pub data: D,
}

pub struct DurablePayload<E: DurableEventType> {
    pub payload: Payload<E::Data>,
    pub durable: DurableEnvelope,
}
pub struct EphemeralPayload<E: EventType> {
    pub payload: Payload<E::Data>,
}

impl<E: DurableEventType> DomainDecode for DurablePayload<E> {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let payload = decode_payload::<E>(value, path)?;
        let durable_value = object.field::<JsonValue>("durable")?;
        let durable_path = path.key("durable");
        let durable_object = ObjectDecoder::new(&durable_value, &durable_path)?;
        durable_object.literal("version", &JsonValue::Number(E::VERSION as f64))?;
        let durable = DurableEnvelope::decode_at(&durable_value, &path.key("durable"))?;
        Ok(Self { payload, durable })
    }
}
impl<E: DurableEventType> DomainEncode for DurablePayload<E> {
    fn encode(&self) -> JsonValue {
        let durable = ObjectEncoder::new()
            .field("aggregateID", &self.durable.aggregate_id)
            .field("seq", &self.durable.seq)
            .field("version", &(E::VERSION as f64))
            .finish();
        encode_base::<E>(&self.payload)
            .field("durable", &durable)
            .optional("location", &self.payload.location)
            .field("data", &self.payload.data)
            .finish()
    }
}
impl<E: EventType> DomainDecode for EphemeralPayload<E> {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            payload: decode_payload::<E>(value, path)?,
        })
    }
}
impl<E: EventType> DomainEncode for EphemeralPayload<E> {
    fn encode(&self) -> JsonValue {
        encode_base::<E>(&self.payload)
            .optional("location", &self.payload.location)
            .field("data", &self.payload.data)
            .finish()
    }
}

fn decode_payload<E: EventType>(
    value: &JsonValue,
    path: &JsonPath,
) -> Result<Payload<E::Data>, DecodeError> {
    let object = ObjectDecoder::new(value, path)?;
    object.literal("type", &JsonValue::String(E::TYPE.into()))?;
    Ok(Payload {
        id: object.field("id")?,
        created: object.field("created")?,
        metadata: object.optional("metadata")?,
        source_epoch: object.optional("sourceEpoch")?,
        location: object.optional("location")?,
        data: object.field("data")?,
    })
}
fn encode_base<E: EventType>(payload: &Payload<E::Data>) -> ObjectEncoder {
    ObjectEncoder::new()
        .field("id", &payload.id)
        .field("created", &payload.created)
        .optional("metadata", &payload.metadata)
        .optional("sourceEpoch", &payload.source_epoch)
        .field("type", &LosslessString::from(E::TYPE))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Durability {
    Durable {
        version: Version,
        aggregate: LosslessString,
    },
    Ephemeral,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Definition {
    pub event_type: LosslessString,
    pub durability: Durability,
}
impl Definition {
    pub fn durable<E: DurableEventType>() -> Result<Self, DecodeError> {
        Ok(Self {
            event_type: E::TYPE.into(),
            durability: Durability::Durable {
                version: Version::new(E::VERSION)?,
                aggregate: E::AGGREGATE.into(),
            },
        })
    }
    pub fn ephemeral<E: EventType>() -> Self {
        Self {
            event_type: E::TYPE.into(),
            durability: Durability::Ephemeral,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("duplicate event definition for {key:?}")]
pub struct DuplicateDefinition {
    pub key: LosslessString,
}

pub fn versioned_type(event_type: &LosslessString, version: f64) -> LosslessString {
    let number = match version {
        number if number.is_nan() => "NaN".to_owned(),
        f64::INFINITY => "Infinity".to_owned(),
        f64::NEG_INFINITY => "-Infinity".to_owned(),
        number => crate::stringify_json(&JsonValue::Number(number)),
    };
    LosslessString::from_utf16(
        event_type
            .code_units()
            .chain(format!(".{number}").encode_utf16())
            .collect(),
    )
}

pub fn latest<'a>(
    definitions: &[&'a Definition],
) -> Result<Vec<(&'a LosslessString, &'a Definition)>, DuplicateDefinition> {
    let mut result: Vec<(&LosslessString, &Definition)> = Vec::new();
    for &definition in definitions {
        let Some((_, existing)) = result
            .iter_mut()
            .find(|(key, _)| **key == definition.event_type)
        else {
            result.push((&definition.event_type, definition));
            continue;
        };
        if let (
            Durability::Durable { version, .. },
            Durability::Durable {
                version: previous, ..
            },
        ) = (&definition.durability, &existing.durability)
            && version != previous
        {
            if version > previous {
                *existing = definition;
            }
            continue;
        }
        if !std::ptr::eq(definition, *existing) {
            return Err(DuplicateDefinition {
                key: definition.event_type.clone(),
            });
        }
    }
    Ok(result)
}

pub fn durable_map<'a>(
    definitions: &[&'a Definition],
) -> Result<Vec<(LosslessString, &'a Definition)>, DuplicateDefinition> {
    let mut result = Vec::new();
    for &definition in definitions {
        let Durability::Durable { version, .. } = &definition.durability else {
            continue;
        };
        let key = versioned_type(&definition.event_type, version.get() as f64);
        if result.iter().any(|(existing, _)| existing == &key) {
            return Err(DuplicateDefinition { key });
        }
        result.push((key, definition));
    }
    Ok(result)
}
