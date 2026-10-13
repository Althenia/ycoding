use crate::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, ObjectDecoder, ObjectEncoder,
};
use crate::{project_id::ProjectId, schema::AbsolutePath, workspace_id::WorkspaceId};

#[derive(Clone, Debug, PartialEq)]
pub struct Ref {
    pub directory: AbsolutePath,
    pub workspace_id: Option<WorkspaceId>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Project {
    pub id: ProjectId,
    pub directory: AbsolutePath,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub directory: AbsolutePath,
    pub workspace_id: Option<WorkspaceId>,
    pub project: Project,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Response<T> {
    pub location: Info,
    pub data: T,
}
impl DomainDecode for Ref {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            directory: object.field("directory")?,
            workspace_id: object.optional("workspaceID")?,
        })
    }
}
impl DomainEncode for Ref {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("directory", &self.directory)
            .optional("workspaceID", &self.workspace_id)
            .finish()
    }
}
impl DomainDecode for Project {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            id: object.field("id")?,
            directory: object.field("directory")?,
        })
    }
}
impl DomainEncode for Project {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("directory", &self.directory)
            .finish()
    }
}
impl DomainDecode for Info {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            directory: object.field("directory")?,
            workspace_id: object.optional("workspaceID")?,
            project: object.field("project")?,
        })
    }
}
impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("directory", &self.directory)
            .optional("workspaceID", &self.workspace_id)
            .field("project", &self.project)
            .finish()
    }
}
impl<T: DomainDecode> DomainDecode for Response<T> {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            location: object.field("location")?,
            data: object.field("data")?,
        })
    }
}
impl<T: DomainEncode> DomainEncode for Response<T> {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("location", &self.location)
            .field("data", &self.data)
            .finish()
    }
}
