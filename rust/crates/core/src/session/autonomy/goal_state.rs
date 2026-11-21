use ycoding_schema::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GoalPhase {
    Active,
    Waiting,
    Rework,
    Stalled,
}

impl GoalPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Waiting => "waiting",
            Self::Rework => "rework",
            Self::Stalled => "stalled",
        }
    }
    pub(super) fn parse(value: &str) -> Option<Self> {
        match value {
            "active" => Some(Self::Active),
            "waiting" => Some(Self::Waiting),
            "rework" => Some(Self::Rework),
            "stalled" => Some(Self::Stalled),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GoalWait {
    Child,
    Shell,
    Review,
}

impl GoalWait {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Child => "child",
            Self::Shell => "shell",
            Self::Review => "review",
        }
    }
    pub(super) fn parse(value: &str) -> Option<Self> {
        match value {
            "child" => Some(Self::Child),
            "shell" => Some(Self::Shell),
            "review" => Some(Self::Review),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct GoalRework {
    pub unit: LosslessString,
    pub reason: LosslessString,
}

impl DomainEncode for GoalRework {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("unit", &self.unit)
            .field("reason", &self.reason)
            .finish()
    }
}
impl DomainDecode for GoalRework {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            unit: object.field("unit")?,
            reason: object.field("reason")?,
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct FailureCause {
    pub fingerprint: LosslessString,
    pub class: LosslessString,
    pub unit: LosslessString,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GoalFailure {
    pub fingerprint: LosslessString,
    pub class: LosslessString,
    pub unit: LosslessString,
    pub count: u64,
    pub recovering: bool,
}

impl DomainEncode for GoalFailure {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("fingerprint", &self.fingerprint)
            .field("class", &self.class)
            .field("unit", &self.unit)
            .field("count", &(self.count as f64))
            .field("recovering", &self.recovering)
            .finish()
    }
}
impl DomainDecode for GoalFailure {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            fingerprint: object.field("fingerprint")?,
            class: object.field("class")?,
            unit: object.field("unit")?,
            count: positive_count(&object, path)?,
            recovering: object.field("recovering")?,
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RecoverySeen {
    pub fingerprint: LosslessString,
    pub count: u64,
}
impl DomainEncode for RecoverySeen {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("fingerprint", &self.fingerprint)
            .field("count", &(self.count as f64))
            .finish()
    }
}
impl DomainDecode for RecoverySeen {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            fingerprint: object.field("fingerprint")?,
            count: positive_count(&object, path)?,
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct GoalRecovery {
    pub condition: LosslessString,
    pub seen: Vec<RecoverySeen>,
}
impl DomainEncode for GoalRecovery {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("condition", &self.condition)
            .field("seen", &self.seen)
            .finish()
    }
}
impl DomainDecode for GoalRecovery {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            condition: object.field("condition")?,
            seen: object.field("seen")?,
        })
    }
}

fn positive_count(object: &ObjectDecoder<'_>, path: &JsonPath) -> Result<u64, DecodeError> {
    let count: f64 = object.field("count")?;
    if !count.is_finite() || count.fract() != 0.0 || !(1.0..=9007199254740991.0).contains(&count) {
        return Err(path
            .key("count")
            .error(ycoding_schema::DecodeErrorKind::NumberRange {
                minimum: 1.0,
                maximum: 9007199254740991.0,
                integer: true,
            }));
    }
    Ok(count as u64)
}
