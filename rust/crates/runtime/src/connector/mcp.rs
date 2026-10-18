mod call;
mod catalog;
pub(crate) mod json;
mod resources;
mod wire;

use super::Peer;
use crate::{Dispatcher, Environment};
use std::{path::PathBuf, sync::Arc};
use ycoding_core::ycoding_schema::{JsonValue, LosslessString};

pub use catalog::{Tool, tools};
pub use resources::{Access, Lease, Server};

pub const VERSION: &str = "2026-07-28";
pub const REQUEST_BYTES: usize = 128 * 1024;
pub const RESULT_BYTES: usize = 2 * 1024 * 1024;
pub const NESTING_DEPTH: usize = 256;

pub struct Context {
    pub environment: Arc<Environment>,
    pub dispatcher: Arc<Dispatcher>,
    pub peer: Peer,
    pub connection_id: String,
    pub home: PathBuf,
    pub access: Access,
    pub trusted_context: Option<ycoding_core::ycoding_schema::mcp_events::RequestContext>,
}

pub struct Request {
    pub body: LosslessString,
    pub headers: Vec<(String, LosslessString)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub content_type: &'static str,
    pub body: String,
    pub unknown: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lane {
    Session(String),
    Backend,
}

pub async fn handle(cx: &Context, request: Request) -> Response {
    if !cx.access.active() || !cx.access.bound_to(&cx.connection_id) {
        return unavailable();
    }
    if cx.peer.authorized() && cx.access.initialize().is_err() {
        return unavailable();
    }
    let response = wire::handle(cx, request).await;
    if !cx.access.active() {
        return unavailable();
    }
    if !cx.peer.authorized() {
        let error = json::parse(&response.body).ok().is_some_and(|value| {
            json::get(&value, "result").and_then(|result| json::get(result, "isError"))
                == Some(&JsonValue::Bool(true))
        });
        if !error {
            return unavailable();
        }
    }
    response
}

impl Context {
    fn authorized(&self) -> bool {
        self.peer.authorized() && self.access.authorized(&self.connection_id, &self.peer)
    }
}

fn unavailable() -> Response {
    Response {
        status: 503,
        content_type: "application/json",
        body: r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"Relay MCP is unavailable"}}"#.into(),
        unknown: false,
    }
}

pub fn register(dispatcher: &mut Dispatcher) -> Result<(), crate::RegistrationError> {
    dispatcher.handle("artifact.demo.preview", preview)?;
    dispatcher.handle("artifact.demo.export", export)?;
    Ok(())
}

async fn preview(
    invocation: crate::Invocation,
    _: ycoding_protocol::v5::ArtifactDemoPreviewRequest,
) -> Result<ycoding_protocol::v5::ArtifactDemoPreviewResult, crate::Failure> {
    invocation
        .mcp
        .as_ref()
        .ok_or(crate::Failure::Connector {
            code: 3,
            message: "Demo context is unavailable",
        })?
        .preview()
}

async fn export(
    invocation: crate::Invocation,
    _: ycoding_protocol::v5::ArtifactDemoExportRequest,
) -> Result<ycoding_protocol::v5::ArtifactDemoExportResult, crate::Failure> {
    invocation
        .mcp
        .as_ref()
        .ok_or(crate::Failure::Connector {
            code: 3,
            message: "Demo context is unavailable",
        })?
        .export()
}

pub fn lane(body: &LosslessString) -> Option<Lane> {
    let body = body.to_utf8().ok()?;
    if body.len() > REQUEST_BYTES {
        return None;
    }
    let message = json::parse(&body).ok()?;
    if json::text(json::get(&message, "method")?)? != "tools/call" {
        return None;
    }
    let params = json::get(&message, "params")?;
    let spec = catalog::spec(json::text(json::get(params, "name")?)?)?;
    if !spec.tool.mutation {
        return None;
    }
    let arguments = json::get(params, "arguments");
    let path = |keys: &[&str]| {
        keys.iter()
            .try_fold(arguments?, |value, key| json::get(value, key))
            .and_then(json::text)
    };
    let session = path(&["sessionID"])
        .or_else(|| path(&["input", "payload", "target", "sessionID"]))
        .or_else(|| match spec.tool.name {
            "session_create" => path(&["input", "payload", "id"]),
            "session_create_in_directory" => path(&["input", "id"]),
            _ => None,
        });
    Some(session.map_or(Lane::Backend, |id| Lane::Session(id.to_owned())))
}

fn arguments_of(value: Option<&JsonValue>) -> JsonValue {
    value
        .cloned()
        .unwrap_or_else(|| JsonValue::Object(Default::default()))
}
