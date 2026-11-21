use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};
pub type Id = crate::project_id::ProjectId;
crate::schema::literal_enum_type!(Vcs,{Git=>"git",Hg=>"hg"});
#[derive(Clone, Debug, PartialEq)]
pub struct Current {
    pub id: Id,
    pub directory: crate::schema::AbsolutePath,
}
impl DomainDecode for Current {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            id: o.field("id")?,
            directory: o.field("directory")?,
        })
    }
}
impl DomainEncode for Current {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("directory", &self.directory)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Directory {
    pub directory: crate::schema::AbsolutePath,
    pub strategy: Option<LosslessString>,
}
impl DomainDecode for Directory {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            directory: o.field("directory")?,
            strategy: o.optional("strategy")?,
        })
    }
}
impl DomainEncode for Directory {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("directory", &self.directory)
            .optional("strategy", &self.strategy)
            .finish()
    }
}
pub type Directories = Vec<Directory>;
#[derive(Clone, Debug, PartialEq)]
pub struct DirectoriesInput {
    pub project_id: Id,
}
impl DomainDecode for DirectoriesInput {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            project_id: ObjectDecoder::new(v, p)?.field("projectID")?,
        })
    }
}
impl DomainEncode for DirectoriesInput {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("projectID", &self.project_id)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct InventoryEntry {
    pub project_id: Id,
    pub project_name: Option<LosslessString>,
    pub project_worktree: crate::schema::AbsolutePath,
    pub directory: crate::schema::AbsolutePath,
    pub strategy: Option<LosslessString>,
    pub sessions: crate::schema::NonNegativeInt,
    pub time_active: crate::schema::NonNegativeInt,
    pub available: bool,
}
impl DomainDecode for InventoryEntry {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            project_id: o.field("projectID")?,
            project_name: o.optional("projectName")?,
            project_worktree: o.field("projectWorktree")?,
            directory: o.field("directory")?,
            strategy: o.optional("strategy")?,
            sessions: o.field("sessions")?,
            time_active: o.field("timeActive")?,
            available: o.field("available")?,
        })
    }
}
impl DomainEncode for InventoryEntry {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("projectID", &self.project_id)
            .optional("projectName", &self.project_name)
            .field("projectWorktree", &self.project_worktree)
            .field("directory", &self.directory)
            .optional("strategy", &self.strategy)
            .field("sessions", &self.sessions)
            .field("timeActive", &self.time_active)
            .field("available", &self.available)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct InventoryAnchor {
    pub project_worktree: crate::schema::AbsolutePath,
    pub project_id: Id,
    pub directory: crate::schema::AbsolutePath,
}
impl DomainDecode for InventoryAnchor {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            project_worktree: o.field("projectWorktree")?,
            project_id: o.field("projectID")?,
            directory: o.field("directory")?,
        })
    }
}
impl DomainEncode for InventoryAnchor {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("projectWorktree", &self.project_worktree)
            .field("projectID", &self.project_id)
            .field("directory", &self.directory)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Icon {
    pub url: Option<LosslessString>,
    pub override_: Option<LosslessString>,
    pub color: Option<LosslessString>,
}
impl DomainDecode for Icon {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            url: o.optional("url")?,
            override_: o.optional("override")?,
            color: o.optional("color")?,
        })
    }
}
impl DomainEncode for Icon {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .optional("url", &self.url)
            .optional("override", &self.override_)
            .optional("color", &self.color)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Commands {
    pub start: Option<LosslessString>,
}
impl DomainDecode for Commands {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            start: ObjectDecoder::new(v, p)?.optional("start")?,
        })
    }
}
impl DomainEncode for Commands {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new().optional("start", &self.start).finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Time {
    pub created: crate::schema::NonNegativeInt,
    pub updated: crate::schema::NonNegativeInt,
    pub initialized: Option<crate::schema::NonNegativeInt>,
}
impl DomainDecode for Time {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            created: o.field("created")?,
            updated: o.field("updated")?,
            initialized: o.optional("initialized")?,
        })
    }
}
impl DomainEncode for Time {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("created", &self.created)
            .field("updated", &self.updated)
            .optional("initialized", &self.initialized)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub id: Id,
    pub worktree: LosslessString,
    pub vcs: Option<Vcs>,
    pub name: Option<LosslessString>,
    pub icon: Option<Icon>,
    pub commands: Option<Commands>,
    pub time: Time,
    pub sandboxes: Vec<LosslessString>,
}
impl DomainDecode for Info {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(v, p)?;
        Ok(Self {
            id: o.field("id")?,
            worktree: o.field("worktree")?,
            vcs: o.optional("vcs")?,
            name: o.optional("name")?,
            icon: o.optional("icon")?,
            commands: o.optional("commands")?,
            time: o.field("time")?,
            sandboxes: o.field("sandboxes")?,
        })
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("worktree", &self.worktree)
            .optional("vcs", &self.vcs)
            .optional("name", &self.name)
            .optional("icon", &self.icon)
            .optional("commands", &self.commands)
            .field("time", &self.time)
            .field("sandboxes", &self.sandboxes)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct UpdatedData(pub Info);
impl DomainDecode for UpdatedData {
    fn decode_at(v: &JsonValue, p: &JsonPath) -> Result<Self, DecodeError> {
        Info::decode_at(v, p).map(Self)
    }
}
impl DomainEncode for UpdatedData {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}
pub struct Updated;
impl crate::event::EventType for Updated {
    const TYPE: &'static str = "project.updated";
    type Data = UpdatedData;
}
pub type UpdatedPayload = crate::event::EphemeralPayload<Updated>;
