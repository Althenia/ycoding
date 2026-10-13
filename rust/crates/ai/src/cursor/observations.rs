use super::{protobuf, wire::Exec};
use crate::{Error, llm::ToolResult};
use std::{future::Future, pin::Pin};
use ycoding_schema::LosslessString;

#[derive(Clone, Debug)]
pub struct ReadRequest {
    pub session_id: LosslessString,
    pub path: LosslessString,
    pub offset: Option<u32>,
    pub limit: Option<u32>,
}
#[derive(Clone, Debug)]
pub enum ReadPath {
    Regular,
    Missing,
    PermissionDenied,
    Invalid(String),
}
#[derive(Clone, Debug)]
pub struct ReadObservation {
    pub path: LosslessString,
    pub content: LosslessString,
    pub total_lines: u32,
    pub file_size: u64,
    pub truncated: bool,
    pub range_applied: bool,
}
pub trait Host: Send + Sync {
    fn inspect_read<'a>(
        &'a self,
        request: &'a ReadRequest,
    ) -> Pin<Box<dyn Future<Output = Result<ReadPath, Error>> + Send + 'a>>;
    fn observe_read<'a>(
        &'a self,
        request: &'a ReadRequest,
        result: &'a ToolResult,
    ) -> Pin<Box<dyn Future<Output = Result<ReadObservation, Error>> + Send + 'a>>;
}
pub(crate) fn read_error(
    exec: &Exec,
    request: &ReadRequest,
    kind: u32,
    reason: Option<&str>,
) -> Result<Vec<u8>, Error> {
    let mut value = Vec::new();
    protobuf::write_string(&mut value, 1, &request.path)?;
    if let Some(reason) = reason {
        protobuf::write_string(&mut value, 2, &reason.into())?;
    }
    let mut result = Vec::new();
    protobuf::write_bytes(&mut result, kind, &value)?;
    exec.result(7, &result, None)
}
pub(crate) fn read_success(
    exec: &Exec,
    view: &ReadObservation,
    elapsed: u64,
) -> Result<Vec<u8>, Error> {
    let mut value = Vec::new();
    protobuf::write_string(&mut value, 1, &view.path)?;
    protobuf::write_string(&mut value, 2, &view.content)?;
    protobuf::write_varint(&mut value, 3, u64::from(view.total_lines))?;
    protobuf::write_varint(&mut value, 4, view.file_size)?;
    protobuf::write_varint(&mut value, 6, u64::from(view.truncated))?;
    protobuf::write_varint(&mut value, 8, u64::from(view.range_applied))?;
    let mut result = Vec::new();
    protobuf::write_bytes(&mut result, 1, &value)?;
    exec.result(7, &result, Some(elapsed))
}
