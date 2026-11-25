use super::{client::Connection, service::Slot};
use crate::process::guardrails::redact_value;
use serde_json::{Map, Value};
use std::{
    collections::VecDeque,
    sync::{Arc, Weak},
};
use ycoding_schema::{JsonValue, LosslessString, session, session_message};

const MAX_ENTRIES: usize = 128;
const MAX_ID_UNITS: usize = 512;
const MAX_DATA_BYTES: usize = 32 * 1024;
const MAX_HTML_BYTES: usize = 256 * 1024;
const MIME: &str = "text/html;profile=mcp-app";

pub struct AppView {
    pub resource_uri: String,
    pub html: String,
    pub tool: String,
    pub input: Value,
    pub output: Value,
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Key(session::Id, session_message::Id, LosslessString);

impl Key {
    pub(super) fn new(
        session: &session::Id,
        message: &session_message::Id,
        call: &LosslessString,
    ) -> Option<Self> {
        [session.as_lossless(), message.as_lossless(), call]
            .into_iter()
            .all(|id| {
                matches!(
                    id.code_units().take(MAX_ID_UNITS + 1).count(),
                    1..=MAX_ID_UNITS
                )
            })
            .then(|| Self(session.clone(), message.clone(), call.clone()))
    }
}

pub(crate) struct Ticket {
    key: Key,
    owner: Arc<()>,
}

pub(crate) struct AppCall {
    pub(super) slot: Weak<Slot>,
    pub(super) connection: Weak<Connection>,
    pub(super) uri: String,
    pub(super) tool: String,
    pub(super) input: Value,
    pub(super) output: Value,
}

struct Entry {
    key: Key,
    owner: Option<Arc<()>>,
    app: Option<Arc<AppCall>>,
}

#[derive(Default)]
pub(super) struct Registry(VecDeque<Entry>);

impl Registry {
    pub(super) fn begin(&mut self, key: Key) -> Option<Ticket> {
        if let Some(entry) = self.0.iter_mut().find(|entry| entry.key == key) {
            entry.owner = None;
            entry.app = None;
            return None;
        }
        if self.0.len() == MAX_ENTRIES {
            self.0.pop_front();
        }
        let owner = Arc::new(());
        let ticket = Ticket {
            key: key.clone(),
            owner: owner.clone(),
        };
        self.0.push_back(Entry {
            key,
            owner: Some(owner),
            app: None,
        });
        Some(ticket)
    }

    pub(super) fn publish(&mut self, ticket: Ticket, app: AppCall) {
        if let Some(entry) = self.0.iter_mut().find(|entry| entry.key == ticket.key)
            && entry
                .owner
                .as_ref()
                .is_some_and(|owner| Arc::ptr_eq(owner, &ticket.owner))
        {
            entry.owner = None;
            entry.app = Some(Arc::new(app));
        }
    }

    pub(super) fn get(&self, key: &Key) -> Option<Arc<AppCall>> {
        self.0.iter().find(|entry| &entry.key == key)?.app.clone()
    }

    pub(super) fn detach(&mut self, connection: &Arc<Connection>) {
        let origin = Arc::downgrade(connection);
        for entry in &mut self.0 {
            if entry
                .app
                .as_ref()
                .is_some_and(|app| app.connection.ptr_eq(&origin))
            {
                entry.app = None;
            }
        }
    }
}

pub(super) fn declared_uri(definition: &Value) -> Option<&str> {
    let uri = definition["_meta"]["ui"]["resourceUri"].as_str()?;
    if uri.len() > 1024 || !uri.starts_with("ui://") {
        return None;
    }
    let parsed = url::Url::parse(uri).ok()?;
    (parsed.as_str() == uri
        && parsed.has_host()
        && !parsed.path().is_empty()
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.port().is_none()
        && parsed.query().is_none()
        && parsed.fragment().is_none())
    .then_some(uri)
}

pub(super) fn html(result: &Value, uri: &str) -> Option<String> {
    let [part] = result["contents"].as_array()?.as_slice() else {
        return None;
    };
    if part["uri"].as_str() != Some(uri) || part["mimeType"].as_str() != Some(MIME) {
        return None;
    }
    let html = match (part.get("text"), part.get("blob")) {
        (Some(Value::String(text)), None) if text.len() <= MAX_HTML_BYTES => text.clone(),
        (None, Some(Value::String(blob))) if blob.len() <= MAX_HTML_BYTES.div_ceil(3) * 4 => {
            let decoded = openssl::base64::decode_block(blob).ok()?;
            if decoded.len() > MAX_HTML_BYTES || openssl::base64::encode_block(&decoded) != *blob {
                return None;
            }
            String::from_utf8(decoded).ok()?
        }
        _ => return None,
    };
    (!html.trim().is_empty() && !html.contains('\0')).then_some(html)
}

pub(super) fn input(value: &Value) -> Option<Value> {
    let (mut bytes, mut nodes) = (MAX_DATA_BYTES, 512);
    project(value, 0, &mut bytes, &mut nodes)
}

pub(super) fn output(value: &Value) -> Option<Value> {
    if !matches!(value.get("isError"), None | Some(Value::Bool(false))) {
        return None;
    }
    let (mut bytes, mut nodes) = (MAX_DATA_BYTES, 512);
    let mut object = Map::new();
    for key in ["content", "structuredContent", "isError"] {
        if let Some(value) = value.get(key) {
            object.insert(key.into(), project(value, 0, &mut bytes, &mut nodes)?);
        }
    }
    Some(Value::Object(object))
}

fn project(value: &Value, depth: usize, bytes: &mut usize, nodes: &mut usize) -> Option<Value> {
    if depth > 16 {
        return None;
    }
    *nodes = nodes.checked_sub(1)?;
    *bytes = bytes.checked_sub(8)?;
    match value {
        Value::Array(values) => Some(Value::Array(
            values
                .iter()
                .map(|value| project(value, depth + 1, bytes, nodes))
                .collect::<Option<_>>()?,
        )),
        Value::Object(values) => {
            let mut object = Map::new();
            for (key, value) in values {
                *bytes = bytes.checked_sub(key.len())?;
                let field = key.replace(['-', '_'], "").to_ascii_lowercase();
                if matches!(
                    field.as_str(),
                    "meta"
                        | "authorization"
                        | "auth"
                        | "cookie"
                        | "setcookie"
                        | "headers"
                        | "env"
                        | "environment"
                        | "config"
                        | "serverconfig"
                        | "oauth"
                        | "csp"
                        | "permissions"
                ) || [
                    "password",
                    "secret",
                    "token",
                    "credential",
                    "apikey",
                    "privatekey",
                ]
                .iter()
                .any(|word| field.contains(word))
                    || redact(key)? != *key
                {
                    *nodes = nodes.checked_sub(1)?;
                    continue;
                }
                object.insert(key.clone(), project(value, depth + 1, bytes, nodes)?);
            }
            Some(Value::Object(object))
        }
        Value::String(value) => {
            *bytes = bytes.checked_sub(value.len())?;
            let text = redact(value)?;
            *bytes = bytes.checked_sub(text.len().saturating_sub(value.len()))?;
            Some(Value::String(text))
        }
        _ => Some(value.clone()),
    }
}

fn redact(text: &str) -> Option<String> {
    match redact_value(&JsonValue::String(text.into())) {
        JsonValue::String(text) => text.to_utf8().ok(),
        _ => None,
    }
}
