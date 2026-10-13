crate::schema::string_type!(WorkspaceId, "wrk");

impl WorkspaceId {
    pub fn create(
        generator: &mut crate::identifier::Generator,
        timestamp: f64,
        entropy: [u8; 14],
    ) -> Result<Self, crate::DecodeError> {
        Self::new(format!(
            "wrk_{}",
            generator
                .ascending(timestamp, entropy)?
                .to_utf8()
                .expect("generator emits ASCII")
        ))
    }
    pub fn ascending(
        id: Option<crate::LosslessString>,
        generator: &mut crate::identifier::Generator,
        timestamp: f64,
        entropy: [u8; 14],
    ) -> Result<Self, crate::DecodeError> {
        match id.filter(|id| !id.is_empty()) {
            Some(id) => Self::new(id),
            None => Self::create(generator, timestamp, entropy),
        }
    }
}
