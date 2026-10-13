crate::schema::string_type!(ProjectId, "");

impl ProjectId {
    pub fn global() -> Self {
        Self::new("global").expect("unrestricted string")
    }
}
