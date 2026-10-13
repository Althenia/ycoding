use crate::event;
use crate::{DomainDecode, JsonValue, LosslessString};
crate::schema::string_type!(Id, "msg_");

impl Id {
    pub fn from_event(event_id: &event::Id) -> Self {
        let units = "msg_"
            .encode_utf16()
            .chain(event_id.as_lossless().code_units().skip(4))
            .collect();
        Self::decode(&JsonValue::String(LosslessString::from_utf16(units)))
            .expect("event prefix becomes message prefix")
    }

    pub fn create(
        generator: &mut crate::identifier::Generator,
        timestamp: f64,
        entropy: [u8; 14],
    ) -> Result<Self, crate::DecodeError> {
        Self::new(format!(
            "msg_{}",
            generator
                .ascending(timestamp, entropy)?
                .to_utf8()
                .expect("generator emits ASCII")
        ))
    }
}
