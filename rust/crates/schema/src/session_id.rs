crate::schema::string_type!(SessionId, "ses");

impl SessionId {
    pub fn create(
        generator: &mut crate::identifier::Generator,
        timestamp: f64,
        entropy: [u8; 14],
    ) -> Result<Self, crate::DecodeError> {
        Self::new(format!(
            "ses_{}",
            generator
                .descending(timestamp, entropy)?
                .to_utf8()
                .expect("generator emits ASCII")
        ))
    }
    pub fn descending(
        id: Option<crate::LosslessString>,
        generator: &mut crate::identifier::Generator,
        timestamp: f64,
        entropy: [u8; 14],
    ) -> Result<Self, crate::DecodeError> {
        match id {
            Some(id) => Self::new(id),
            None => Self::create(generator, timestamp, entropy),
        }
    }
}
