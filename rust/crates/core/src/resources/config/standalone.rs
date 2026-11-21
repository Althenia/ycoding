use super::{Configuration, Entry, Error, LoadOptions, Roots, capabilities, jsonc, roots};
use std::{collections::BTreeMap, path::PathBuf};
use ycoding_schema::JsonValue;

#[derive(Clone)]
pub struct Snapshot {
    pub configuration: Configuration,
    sources: Vec<(PathBuf, Option<String>)>,
}

impl Snapshot {
    pub fn read(roots: &Roots) -> Result<Self, Error> {
        let mut entries = Vec::new();
        let mut sources = Vec::new();
        for name in ["ycoding.json", "ycoding.jsonc"] {
            let path = roots.config.join(name);
            roots.check(&path)?;
            let text = match std::fs::read_to_string(&path) {
                Ok(text) => Some(text),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(roots::io_error(&path, error)),
            };
            if let Some(text) = &text {
                let input = jsonc::parse(text).map_err(|_| invalid())?;
                let JsonValue::Object(input) = input else {
                    return Err(invalid());
                };
                let mut selected = ycoding_schema::JsonObject::new();
                for key in [
                    "model",
                    "model_fallbacks",
                    "default_agent",
                    "permissions",
                    "providers",
                    "efficiency",
                    "guardrails",
                    "coordination",
                    "memory",
                    "capabilities",
                    "compaction",
                    "experimental",
                ] {
                    if let Some(value) = input.get(&key.into()) {
                        selected.insert(key.into(), value.clone());
                    }
                }
                if let Some(value) = input.get(&"agents".into()) {
                    let JsonValue::Object(agents) = value else {
                        return Err(invalid());
                    };
                    let builtins = crate::resources::agent::builtin::catalog(
                        roots,
                        ycoding_schema::session_scope::Scope::Standalone,
                    )
                    .map_err(|_| invalid())?;
                    let mut configured = ycoding_schema::JsonObject::new();
                    for (id, value) in agents.iter() {
                        if builtins.iter().any(|agent| agent.id == *id) {
                            configured.insert(id.clone(), value.clone());
                        }
                    }
                    selected.insert("agents".into(), JsonValue::Object(configured));
                }
                let projected = ycoding_schema::stringify_json(&JsonValue::Object(selected));
                if projected.contains("{env:") || projected.contains("{file:") {
                    return Err(invalid());
                }
                let decoded = super::decode_document(&projected, "standalone global configuration");
                if !decoded.diagnostics.is_empty() {
                    return Err(invalid());
                }
                entries.push(Entry::Document {
                    path: Some(path.clone()),
                    info: decoded.info.ok_or_else(invalid)?,
                });
            }
            sources.push((path, text));
        }
        let capabilities = capabilities::ConfigCapabilities::resolve(&entries);
        Ok(Self {
            configuration: Configuration {
                event_source: Default::default(),
                entries,
                diagnostics: Vec::new(),
                capabilities,
                options: LoadOptions {
                    directory: roots.config.clone(),
                    roots: roots.clone(),
                    project: false,
                    file: None,
                    content: None,
                    env: BTreeMap::new(),
                },
                sources: Vec::new(),
                mutation_policy: None,
            },
            sources,
        })
    }

    pub fn assert_current(&self) -> Result<(), Error> {
        let next = Self::read(self.configuration.roots())?;
        if next.sources != self.sources {
            return Err(invalid());
        }
        Ok(())
    }
}

fn invalid() -> Error {
    Error {
        path: None,
        virtual_source: None,
        message: "Standalone configuration is unavailable or changed".into(),
        cause: None,
    }
}
