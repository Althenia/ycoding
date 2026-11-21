use super::protobuf;
use crate::{Error, json};
use ycoding_schema::{JsonValue, LosslessString, stringify_json};

#[derive(Clone, Debug, PartialEq)]
pub struct Descriptor {
    pub name: LosslessString,
    pub description: LosslessString,
    pub input_schema: JsonValue,
    pub provider: LosslessString,
    pub tool_name: LosslessString,
}
impl Descriptor {
    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        let mut bytes = Vec::new();
        protobuf::write_string(&mut bytes, 1, &self.name)?;
        protobuf::write_string(&mut bytes, 2, &self.description)?;
        protobuf::write_bytes(&mut bytes, 3, &protobuf::encode_value(&self.input_schema)?)?;
        protobuf::write_string(&mut bytes, 4, &self.provider)?;
        protobuf::write_string(&mut bytes, 5, &self.tool_name)?;
        Ok(bytes)
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct History {
    pub role: LosslessString,
    pub content: LosslessString,
}
impl History {
    pub fn new(role: impl Into<LosslessString>, content: impl Into<LosslessString>) -> Self {
        Self {
            role: role.into(),
            content: content.into(),
        }
    }
}
pub fn seed(system: Option<&LosslessString>, history: &[History]) -> Result<Vec<u8>, Error> {
    let mut bytes = Vec::new();
    let has_system = system.is_some_and(|value| !value.is_empty());
    for entry in system
        .filter(|value| !value.is_empty())
        .map(|content| History::new("system", content.clone()))
        .into_iter()
        .chain(
            history
                .iter()
                .filter(|entry| {
                    !entry.content.is_empty() && !(has_system && entry.role == "system".into())
                })
                .cloned(),
        )
    {
        let message = json::object([
            ("role", json::s(entry.role)),
            ("content", json::s(entry.content)),
        ]);
        protobuf::write_string(&mut bytes, 1, &stringify_json(&message).into())?;
    }
    Ok(bytes)
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Action {
    #[default]
    User,
    Resume,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Image {
    pub uuid: LosslessString,
    pub filename: Option<LosslessString>,
    pub mime_type: LosslessString,
    pub data: Vec<u8>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct RunRequest {
    pub conversation_id: LosslessString,
    pub group_id: Option<LosslessString>,
    pub message_id: LosslessString,
    pub model_id: LosslessString,
    pub text: LosslessString,
    pub system_prompt: Option<LosslessString>,
    pub history: Vec<History>,
    pub checkpoint: Option<Vec<u8>>,
    pub parameters: Vec<(LosslessString, LosslessString)>,
    pub max_mode: bool,
    pub action: Action,
    pub request_context: Option<Vec<u8>>,
    pub descriptors: Vec<Descriptor>,
    pub images: Vec<Image>,
}
impl RunRequest {
    pub fn new(
        conversation: impl Into<LosslessString>,
        message: impl Into<LosslessString>,
        model: impl Into<LosslessString>,
        text: impl Into<LosslessString>,
    ) -> Self {
        Self {
            conversation_id: conversation.into(),
            group_id: None,
            message_id: message.into(),
            model_id: model.into(),
            text: text.into(),
            system_prompt: None,
            history: Vec::new(),
            checkpoint: None,
            parameters: Vec::new(),
            max_mode: false,
            action: Action::User,
            request_context: None,
            descriptors: Vec::new(),
            images: Vec::new(),
        }
    }
    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        let mut action = Vec::new();
        if self.action == Action::Resume {
            protobuf::write_bytes(&mut action, 2, &[])?;
        } else {
            let mut message = Vec::new();
            protobuf::write_string(&mut message, 1, &self.text)?;
            protobuf::write_string(&mut message, 2, &self.message_id)?;
            if !self.images.is_empty() {
                let mut selected = Vec::new();
                for image in &self.images {
                    let mut encoded = Vec::new();
                    protobuf::write_string(&mut encoded, 2, &image.uuid)?;
                    if let Some(filename) = &image.filename {
                        protobuf::write_string(&mut encoded, 3, filename)?;
                    }
                    protobuf::write_string(&mut encoded, 7, &image.mime_type)?;
                    protobuf::write_bytes(&mut encoded, 8, &image.data)?;
                    protobuf::write_bytes(&mut selected, 1, &encoded)?;
                }
                protobuf::write_bytes(&mut message, 3, &selected)?;
            }
            let mut user = Vec::new();
            protobuf::write_bytes(&mut user, 1, &message)?;
            if let Some(context) = &self.request_context {
                protobuf::write_bytes(&mut user, 2, context)?;
            }
            protobuf::write_bytes(&mut action, 1, &user)?;
        }
        let mut tools = Vec::new();
        for descriptor in &self.descriptors {
            protobuf::write_bytes(&mut tools, 1, &descriptor.encode()?)?;
        }
        let mut model = Vec::new();
        protobuf::write_string(&mut model, 1, &self.model_id)?;
        protobuf::write_varint(&mut model, 2, u64::from(self.max_mode))?;
        for (id, value) in &self.parameters {
            let mut parameter = Vec::new();
            protobuf::write_string(&mut parameter, 1, id)?;
            protobuf::write_string(&mut parameter, 2, value)?;
            protobuf::write_bytes(&mut model, 3, &parameter)?;
        }
        let mut run = Vec::new();
        let checkpoint = self.checkpoint.as_deref().filter(|bytes| !bytes.is_empty());
        let seed = if checkpoint.is_none() {
            seed(self.system_prompt.as_ref(), &self.history)?
        } else {
            Vec::new()
        };
        protobuf::write_bytes(&mut run, 1, checkpoint.unwrap_or(&seed))?;
        protobuf::write_bytes(&mut run, 2, &action)?;
        protobuf::write_bytes(&mut run, 4, &tools)?;
        protobuf::write_string(&mut run, 5, &self.conversation_id)?;
        protobuf::write_bytes(&mut run, 9, &model)?;
        protobuf::write_varint(&mut run, 10, 0)?;
        protobuf::write_varint(&mut run, 12, 0)?;
        protobuf::write_string(
            &mut run,
            16,
            self.group_id.as_ref().unwrap_or(&self.conversation_id),
        )?;
        protobuf::write_string(&mut run, 25, &self.message_id)?;
        let mut client = Vec::new();
        protobuf::write_bytes(&mut client, 1, &run)?;
        Ok(client)
    }
}
pub fn heartbeat() -> Vec<u8> {
    vec![0x3a, 0]
}
