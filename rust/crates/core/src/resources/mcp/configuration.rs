use crate::resources::config::Entry;
use std::path::{Component, Path, PathBuf};
use ycoding_schema::{
    DecodeError, DomainDecode, JsonValue, LosslessString,
    mcp::{ServerConfig, TimeoutConfig},
};

pub struct Definitions {
    pub timeout: TimeoutConfig,
    pub servers: Vec<(LosslessString, ServerConfig)>,
}

pub fn from_entries(entries: &[Entry]) -> Result<Definitions, DecodeError> {
    let documents = entries
        .iter()
        .filter_map(|entry| {
            let Entry::Document {
                info: JsonValue::Object(info),
                ..
            } = entry
            else {
                return None;
            };
            let Some(JsonValue::Object(mcp)) = info.get(&"mcp".into()) else {
                return None;
            };
            Some(mcp)
        })
        .collect::<Vec<_>>();
    let mut definitions = Definitions {
        timeout: TimeoutConfig {
            startup: None,
            catalog: None,
            execution: None,
        },
        servers: Vec::new(),
    };
    for document in &documents {
        if let Some(timeout) = document.get(&"timeout".into()) {
            definitions.timeout = overlay(&definitions.timeout, &TimeoutConfig::decode(timeout)?);
        }
    }
    for document in documents {
        let Some(JsonValue::Object(servers)) = document.get(&"servers".into()) else {
            continue;
        };
        for (name, value) in servers.iter() {
            let config = definitions.resolve(ServerConfig::decode(value)?);
            if let Some(existing) = definitions
                .servers
                .iter_mut()
                .find(|entry| &entry.0 == name)
            {
                existing.1 = config;
                continue;
            }
            definitions.servers.push((name.clone(), config));
        }
    }
    Ok(definitions)
}

impl Definitions {
    pub fn resolve(&self, mut config: ServerConfig) -> ServerConfig {
        let timeout = match &mut config {
            ServerConfig::Local(config) => &mut config.timeout,
            ServerConfig::Remote(config) => &mut config.timeout,
        };
        *timeout = Some(timeout.as_ref().map_or_else(
            || self.timeout.clone(),
            |timeout| overlay(&self.timeout, timeout),
        ));
        config
    }
}

fn overlay(defaults: &TimeoutConfig, current: &TimeoutConfig) -> TimeoutConfig {
    TimeoutConfig {
        startup: current.startup.or(defaults.startup),
        catalog: current.catalog.or(defaults.catalog),
        execution: current.execution.or(defaults.execution),
    }
}

pub fn working_directory(directory: &Path, cwd: Option<&str>) -> PathBuf {
    let path = cwd.map_or_else(|| directory.to_path_buf(), |cwd| directory.join(cwd));
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => (),
            Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    normalized
}
