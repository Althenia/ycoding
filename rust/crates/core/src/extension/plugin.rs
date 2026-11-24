use super::capabilities;
use crate::resources::config;
use std::{collections::BTreeSet, path::Path};
use ycoding_schema::{JsonObject, JsonValue, LosslessString};

#[derive(Clone, Debug, PartialEq)]
pub enum Operation {
    Add { target: String, options: JsonValue },
    Remove(String),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Builtins {
    pub disabled: BTreeSet<String>,
    pub unsupported: Vec<String>,
}

impl Builtins {
    pub fn is_disabled(&self, id: &str) -> bool {
        self.disabled.contains(id)
    }

    pub fn diagnostic(&self) -> Option<ycoding_schema::config::Diagnostic> {
        if self.unsupported.is_empty() {
            return None;
        }
        Some(ycoding_schema::config::Diagnostic {
            path: "plugins".into(),
            reason: ycoding_schema::config::DiagnosticReason("invalid-values".into()),
            json_path: Some("$.plugins".into()),
            fail_closed: Some(false),
            message: format!(
                "Built-in plugins cannot be disabled and remain active: {}",
                self.unsupported.join(", ")
            )
            .into(),
        })
    }
}

pub fn resolve_builtins(operations: &[Operation]) -> Builtins {
    resolve(operations, &[]).0
}

pub(super) fn resolve(
    operations: &[Operation],
    parent_ids: &[LosslessString],
) -> (Builtins, BTreeSet<LosslessString>) {
    let builtins = capabilities::PRE
        .iter()
        .chain(capabilities::POST)
        .map(|id| LosslessString::from(*id))
        .collect::<Vec<_>>();
    let ids = || builtins.iter().chain(parent_ids);
    let mut enabled = ids().cloned().collect::<BTreeSet<_>>();
    let mut seen = Vec::new();
    for operation in operations {
        if seen.contains(&operation) {
            continue;
        }
        seen.push(operation);
        match operation {
            Operation::Remove(selector) => {
                for id in ids().filter(|id| matches(selector, id)) {
                    enabled.remove(id);
                }
            }
            Operation::Add { target, .. } => {
                enabled.extend(ids().filter(|id| matches(target, id)).cloned());
            }
        }
    }
    (builtins_from_enabled(&builtins, &enabled), enabled)
}

pub fn disabled_from_entries(entries: &[config::Entry], _directory: &Path) -> Builtins {
    resolve_builtins(&operations(entries))
}

fn builtins_from_enabled(
    builtins: &[LosslessString],
    enabled: &BTreeSet<LosslessString>,
) -> Builtins {
    let mut result = Builtins::default();
    for id in builtins {
        if enabled.contains(id) {
            continue;
        }
        let Some(text) = id.as_str() else {
            continue;
        };
        if capabilities::DISABLEABLE.contains(&text) {
            result.disabled.insert(text.into());
        } else {
            result.unsupported.push(text.into());
        }
    }
    result
}

pub(super) fn operations(entries: &[config::Entry]) -> Vec<Operation> {
    entries
        .iter()
        .filter_map(|entry| match entry {
            config::Entry::Document { info, .. } => match field(info, "plugins") {
                Some(JsonValue::Array(items)) => Some(items),
                _ => None,
            },
            _ => None,
        })
        .flatten()
        .filter_map(|item| match item {
            JsonValue::String(target) => match target.as_str()?.strip_prefix('-') {
                Some(selector) => {
                    (!selector.is_empty()).then(|| Operation::Remove(selector.into()))
                }
                None => Some(Operation::Add {
                    target: target.to_utf8().ok()?,
                    options: JsonValue::Object(JsonObject::new()),
                }),
            },
            JsonValue::Object(_) => {
                let JsonValue::String(target) = field(item, "package")? else {
                    return None;
                };
                let options = match field(item, "options") {
                    Some(JsonValue::Object(options)) => options.clone(),
                    None => JsonObject::new(),
                    Some(_) => return None,
                };
                Some(Operation::Add {
                    target: target.to_utf8().ok()?,
                    options: JsonValue::Object(options),
                })
            }
            _ => None,
        })
        .collect()
}

fn matches(selector: &str, id: &LosslessString) -> bool {
    match selector.strip_suffix('*') {
        Some("") => true,
        Some(prefix) if prefix.ends_with('.') => {
            let mut units = id.code_units();
            prefix.encode_utf16().all(|unit| units.next() == Some(unit))
        }
        _ => id.as_str() == Some(selector),
    }
}

fn field<'a>(value: &'a JsonValue, name: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(&name.into()),
        _ => None,
    }
}
