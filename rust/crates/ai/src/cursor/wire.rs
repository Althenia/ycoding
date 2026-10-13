use super::protobuf;
use crate::Error;
use ycoding_schema::JsonValue;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Counters {
    pub input: Option<u32>,
    pub output: Option<u32>,
    pub cache_read: Option<u32>,
    pub cache_write: Option<u32>,
    pub reasoning: Option<u32>,
}
impl Counters {
    pub fn decode(bytes: &[u8]) -> Result<Self, Error> {
        let mut counters = Self::default();
        for field in protobuf::fields(bytes)? {
            let target = match field.number {
                1 => &mut counters.input,
                2 => &mut counters.output,
                3 => &mut counters.cache_read,
                4 => &mut counters.cache_write,
                5 => &mut counters.reasoning,
                _ => continue,
            };
            *target = Some(field.uint32()?);
        }
        Ok(counters)
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Update {
    Text(String),
    Thinking(String),
    ToolStarted(Vec<u8>),
    ToolCompleted(Vec<u8>),
    PartialTool(Vec<u8>),
    Heartbeat,
    TurnEnded(Counters),
    StepStarted(Vec<u8>),
    StepCompleted(Vec<u8>),
    Unknown(u32, Vec<u8>),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Exec {
    pub id: u32,
    pub exec_id: Option<String>,
    pub variant: u32,
    pub args: Vec<u8>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct McpCall {
    pub name: String,
    pub input: JsonValue,
    pub call_id: String,
    pub provider: Option<String>,
    pub tool_name: Option<String>,
}
impl Exec {
    pub fn mcp(&self) -> Result<Option<McpCall>, Error> {
        if self.variant != 11 {
            return Ok(None);
        }
        let fields = protobuf::fields(&self.args)?;
        let text = |number| {
            fields
                .iter()
                .rev()
                .find(|field| field.number == number)
                .map(|field| field.text())
                .transpose()
        };
        Ok(Some(McpCall {
            name: text(1)?.unwrap_or_default(),
            input: protobuf::decode_entries(
                fields
                    .iter()
                    .filter(|field| field.number == 2)
                    .map(|field| field.bytes())
                    .collect::<Result<Vec<_>, _>>()?,
            )?,
            call_id: text(3)?.unwrap_or_default(),
            provider: text(4)?,
            tool_name: text(5)?,
        }))
    }
    pub fn mcp_result(
        &self,
        output: Result<&str, &str>,
        elapsed_ms: u64,
    ) -> Result<Vec<u8>, Error> {
        let mut result = Vec::new();
        match output {
            Ok(output) => {
                let mut text = Vec::new();
                protobuf::write_string(&mut text, 1, &output.into())?;
                let mut content = Vec::new();
                protobuf::write_bytes(&mut content, 1, &text)?;
                let mut success = Vec::new();
                protobuf::write_bytes(&mut success, 1, &content)?;
                protobuf::write_varint(&mut success, 2, 0)?;
                protobuf::write_bytes(&mut result, 1, &success)?;
            }
            Err(error) => {
                let mut bytes = Vec::new();
                protobuf::write_string(&mut bytes, 1, &error.into())?;
                protobuf::write_bytes(&mut result, 2, &bytes)?;
            }
        }
        self.result(11, &result, Some(elapsed_ms))
    }
    pub fn result(
        &self,
        variant: u32,
        result: &[u8],
        elapsed_ms: Option<u64>,
    ) -> Result<Vec<u8>, Error> {
        let mut exec = Vec::new();
        protobuf::write_varint(&mut exec, 1, u64::from(self.id))?;
        protobuf::write_bytes(&mut exec, variant, result)?;
        if let Some(elapsed_ms) = elapsed_ms {
            protobuf::write_varint(&mut exec, 39, elapsed_ms)?;
        }
        let mut client = Vec::new();
        protobuf::write_bytes(&mut client, 2, &exec)?;
        Ok(client)
    }
    pub fn close(&self) -> Result<Vec<u8>, Error> {
        let mut close = Vec::new();
        protobuf::write_varint(&mut close, 1, u64::from(self.id))?;
        let mut control = Vec::new();
        protobuf::write_bytes(&mut control, 1, &close)?;
        let mut client = Vec::new();
        protobuf::write_bytes(&mut client, 5, &control)?;
        Ok(client)
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ServerMessage {
    Interaction(Update),
    Exec(Exec),
    Checkpoint(Vec<u8>),
    Kv(Vec<u8>),
    ExecControl(Vec<u8>),
    InteractionQuery(Vec<u8>),
    Unknown(u32, Vec<u8>),
}

pub fn decode(payload: &[u8]) -> Result<ServerMessage, Error> {
    let fields = protobuf::fields(payload)?;
    let field = fields
        .iter()
        .rev()
        .find(|field| [1, 2, 3, 4, 5, 7].contains(&field.number))
        .or_else(|| fields.first())
        .ok_or_else(|| Error::output("Cursor server message is empty"))?;
    let bytes = field.bytes()?;
    match field.number {
        1 => {
            let fields = protobuf::fields(bytes)?;
            let field = fields
                .last()
                .ok_or_else(|| Error::output("Cursor interaction update is empty"))?;
            let bytes = field.bytes()?;
            let update = match field.number {
                1 | 4 => {
                    let fields = protobuf::fields(bytes)?;
                    let text = fields
                        .iter()
                        .rev()
                        .find(|field| field.number == 1)
                        .map(|field| field.text())
                        .transpose()?
                        .unwrap_or_default();
                    if field.number == 1 {
                        Update::Text(text)
                    } else {
                        Update::Thinking(text)
                    }
                }
                2 => Update::ToolStarted(bytes.to_vec()),
                3 => Update::ToolCompleted(bytes.to_vec()),
                7 => Update::PartialTool(bytes.to_vec()),
                13 => Update::Heartbeat,
                14 => Update::TurnEnded(Counters::decode(bytes)?),
                16 => Update::StepStarted(bytes.to_vec()),
                17 => Update::StepCompleted(bytes.to_vec()),
                number => Update::Unknown(number, bytes.to_vec()),
            };
            Ok(ServerMessage::Interaction(update))
        }
        2 => {
            let fields = protobuf::fields(bytes)?;
            let id = fields
                .iter()
                .rev()
                .find(|field| field.number == 1)
                .map(|field| field.uint32())
                .transpose()?
                .unwrap_or(0);
            let exec_id = fields
                .iter()
                .rev()
                .find(|field| field.number == 15)
                .map(|field| field.text())
                .transpose()?;
            let variant = fields
                .iter()
                .rev()
                .find(|field| ![1, 15, 19].contains(&field.number))
                .ok_or_else(|| Error::output("Cursor exec request has no variant"))?;
            Ok(ServerMessage::Exec(Exec {
                id,
                exec_id,
                variant: variant.number,
                args: variant.bytes()?.to_vec(),
            }))
        }
        3 => Ok(ServerMessage::Checkpoint(bytes.to_vec())),
        4 => Ok(ServerMessage::Kv(bytes.to_vec())),
        5 => Ok(ServerMessage::ExecControl(bytes.to_vec())),
        7 => Ok(ServerMessage::InteractionQuery(bytes.to_vec())),
        number => Ok(ServerMessage::Unknown(number, bytes.to_vec())),
    }
}
