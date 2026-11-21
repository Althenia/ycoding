use super::{Configuration, Plugin, PluginRuntime, capabilities};
use crate::resources::config;
use std::{
    collections::BTreeSet,
    path::{Component, Path, PathBuf},
};
use ycoding_schema::{JsonObject, JsonValue, LosslessString};

#[derive(Clone, Debug, PartialEq)]
pub enum Operation {
    Add { target: String, options: JsonValue },
    Remove(String),
    InvalidFileUrl { target: String },
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
    let builtins = capabilities::PRE
        .iter()
        .chain(capabilities::POST)
        .map(|id| LosslessString::from(*id))
        .collect::<Vec<_>>();
    let mut enabled = builtins.iter().cloned().collect::<BTreeSet<_>>();
    let mut seen: Vec<Operation> = Vec::new();
    for operation in operations {
        if seen.contains(operation) {
            continue;
        }
        seen.push(operation.clone());
        match operation {
            Operation::Remove(selector) => {
                for id in builtins.iter().filter(|id| matches(selector, id)) {
                    enabled.remove(id);
                }
            }
            Operation::Add { target, .. } => {
                let matched = builtins
                    .iter()
                    .filter(|id| matches(target, id))
                    .cloned()
                    .collect::<Vec<_>>();
                if !matched.is_empty() || selects(target) {
                    enabled.extend(matched);
                }
            }
            Operation::InvalidFileUrl { .. } => {}
        }
    }
    builtins_from_enabled(&builtins, &enabled)
}

pub fn disabled_builtins(configuration: &config::Configuration, directory: &Path) -> Builtins {
    resolve_builtins(&operations(configuration, directory))
}

pub fn disabled_from_entries(entries: &[config::Entry], directory: &Path) -> Builtins {
    resolve_builtins(&operations_for(entries, directory))
}

pub(super) fn builtins_from_enabled(
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

pub fn operations(configuration: &config::Configuration, directory: &Path) -> Vec<Operation> {
    operations_for(&configuration.entries, directory)
}

pub fn operations_for(entries: &[config::Entry], directory: &Path) -> Vec<Operation> {
    let discovered = entries.iter().flat_map(|entry| match entry {
        config::Entry::Directory(directory) => discover(directory),
        _ => Vec::new(),
    });
    let configured = entries.iter().flat_map(|entry| match entry {
        config::Entry::Document { path, info } => {
            let base = path
                .as_deref()
                .and_then(Path::parent)
                .unwrap_or(directory)
                .to_path_buf();
            match field(info, "plugins") {
                Some(JsonValue::Array(items)) => items
                    .iter()
                    .filter_map(|item| operation(item, &base))
                    .collect(),
                _ => Vec::new(),
            }
        }
        _ => Vec::new(),
    });
    discovered.chain(configured).collect()
}

pub fn launch(
    target: String,
    options: JsonValue,
    directory: PathBuf,
    runtime: &PluginRuntime,
) -> Plugin {
    Plugin {
        configuration: Configuration {
            identity: identity(&target),
            executable: runtime.executable.clone(),
            args: runtime.args.clone(),
            directory,
            grants: vec![],
            families: vec![],
            registration_order: 0,
        },
        target,
        options,
        cache: runtime.cache.clone(),
        setup: runtime.setup,
        model_package: false,
        selection: Default::default(),
    }
}

pub fn identity(target: &str) -> String {
    let name = target
        .rsplit(['/', '\\'])
        .find(|segment| !segment.is_empty())
        .unwrap_or(target)
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"_.-".contains(&byte) {
                byte as char
            } else {
                '-'
            }
        })
        .take(64)
        .collect::<String>();
    let digest = target
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
        });
    format!("plugin.{name}.{digest:016x}")
}

pub(super) fn selects(target: &str) -> bool {
    target == "*" || target.ends_with(".*") || target.starts_with("ycoding.")
}

pub(super) fn matches(selector: &str, id: &LosslessString) -> bool {
    match selector.strip_suffix('*') {
        Some("") => true,
        Some(prefix) if prefix.ends_with('.') => {
            let mut units = id.code_units();
            prefix.encode_utf16().all(|unit| units.next() == Some(unit))
        }
        _ => *id == LosslessString::from(selector),
    }
}

fn discover(directory: &Path) -> Vec<Operation> {
    let mut files = ["plugin", "plugins"]
        .iter()
        .filter_map(|name| std::fs::read_dir(directory.join(name)).ok())
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .is_some_and(|extension| extension == "ts" || extension == "js")
        })
        .filter_map(|path| path.to_str().map(str::to_owned))
        .collect::<Vec<_>>();
    files.sort();
    files
        .into_iter()
        .map(|target| Operation::Add {
            target,
            options: JsonValue::Object(JsonObject::new()),
        })
        .collect()
}

fn operation(item: &JsonValue, base: &Path) -> Option<Operation> {
    match item {
        JsonValue::String(target) => {
            let target = target.as_str()?;
            match target.strip_prefix('-') {
                Some(selector) => {
                    (!selector.is_empty()).then(|| Operation::Remove(selector.to_owned()))
                }
                None => Some(addition(target, base, JsonValue::Object(JsonObject::new()))),
            }
        }
        JsonValue::Object(_) => {
            let JsonValue::String(target) = field(item, "package")? else {
                return None;
            };
            let options = match field(item, "options") {
                Some(JsonValue::Object(options)) => options.clone(),
                None => JsonObject::new(),
                Some(_) => return None,
            };
            Some(addition(target.as_str()?, base, JsonValue::Object(options)))
        }
        _ => None,
    }
}

fn addition(target: &str, base: &Path, options: JsonValue) -> Operation {
    match resolve(target, base) {
        Ok(target) => Operation::Add { target, options },
        Err(()) => Operation::InvalidFileUrl {
            target: target.to_owned(),
        },
    }
}

fn resolve(target: &str, base: &Path) -> Result<String, ()> {
    if target.starts_with("file://") {
        let parsed = url::Url::parse(target).map_err(|_| ())?;
        if parsed.scheme() != "file" || parsed.host_str().is_some() {
            return Err(());
        }
        return decode(parsed.path());
    }
    if target.starts_with("./") || target.starts_with("../") {
        return Ok(normalize(&base.join(target)).to_string_lossy().into_owned());
    }
    Ok(target.to_owned())
}

fn normalize(path: &Path) -> PathBuf {
    path.components()
        .fold(PathBuf::new(), |mut result, component| {
            match component {
                Component::ParentDir => {
                    result.pop();
                }
                Component::CurDir => {}
                other => result.push(other),
            }
            result
        })
}

fn decode(path: &str) -> Result<String, ()> {
    let bytes = path.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && let Some(value) = bytes
                .get(index + 1..index + 3)
                .and_then(|hex| std::str::from_utf8(hex).ok())
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
        {
            if value == b'/' {
                return Err(());
            }
            output.push(value);
            index += 3;
            continue;
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(output).map_err(|_| ())
}

fn field<'a>(value: &'a JsonValue, name: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(&name.into()),
        _ => None,
    }
}
