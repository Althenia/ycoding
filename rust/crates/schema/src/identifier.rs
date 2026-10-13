use crate::{DecodeError, DecodeErrorKind, JsonPath, LosslessString};

#[derive(Clone, Debug, Default)]
pub struct Generator {
    last_timestamp: f64,
    counter: f64,
}

impl Generator {
    pub fn create(
        &mut self,
        descending: bool,
        timestamp: f64,
        entropy: [u8; 14],
    ) -> Result<LosslessString, DecodeError> {
        if timestamp != self.last_timestamp {
            self.last_timestamp = timestamp;
            self.counter = 0.0;
        }
        self.counter += 1.0;
        if !timestamp.is_finite() || timestamp.fract() != 0.0 {
            return Err(JsonPath::default().error(DecodeErrorKind::InvalidTimestamp));
        }
        let current = (timestamp % 281_474_976_710_656.0) as i128 * 0x1000
            + (self.counter % 281_474_976_710_656.0) as i128;
        let value = if descending { !current } else { current };
        let chars = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
        let time = format!("{:012x}", value & 0xffff_ffff_ffff);
        let suffix: String = entropy
            .iter()
            .map(|byte| char::from(chars[usize::from(*byte) % 62]))
            .collect();
        Ok(format!("{time}{suffix}").into())
    }

    pub fn ascending(
        &mut self,
        timestamp: f64,
        entropy: [u8; 14],
    ) -> Result<LosslessString, DecodeError> {
        self.create(false, timestamp, entropy)
    }

    pub fn descending(
        &mut self,
        timestamp: f64,
        entropy: [u8; 14],
    ) -> Result<LosslessString, DecodeError> {
        self.create(true, timestamp, entropy)
    }
}
