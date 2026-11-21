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

pub async fn handle(cx: &Context, request: Request) -> Response {
    if !cx.access.active() || !cx.access.bound_to(&cx.connection_id) {
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

pub(crate) fn stable_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn arguments_of(value: Option<&JsonValue>) -> JsonValue {
    value
        .cloned()
        .unwrap_or_else(|| JsonValue::Object(Default::default()))
}
