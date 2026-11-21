use super::{Configuration, Entry, Error, load_file};
use ycoding_schema::{
    DomainDecode, JsonObject, JsonValue,
    coordination::{RequestKind, Settings},
};

const FIELDS: [(&str, &str); 5] = [
    ("enabled", "enabled"),
    ("categories", "categories"),
    ("actions", "actions"),
    ("resources", "resources"),
    ("expires_at", "expiresAt"),
];

const CATEGORIES: [&str; 3] = ["question", "permission", "review"];

pub(super) fn settings(policies: &[&JsonObject]) -> Option<Settings> {
    let mut merged = JsonObject::new();
    for policy in policies {
        for (key, value) in policy.iter() {
            if let Some((_, name)) = FIELDS
                .iter()
                .find(|(source, _)| key.as_str() == Some(*source))
            {
                merged.insert((*name).into(), value.clone());
            }
        }
    }
    if merged.get(&"enabled".into()).is_none() {
        merged.insert("enabled".into(), JsonValue::Bool(true));
    }
    if merged.get(&"categories".into()).is_none() {
        merged.insert(
            "categories".into(),
            JsonValue::Array(
                CATEGORIES
                    .iter()
                    .map(|name| JsonValue::String((*name).into()))
                    .collect(),
            ),
        );
    }
    Settings::decode(&JsonValue::Object(merged)).ok()
}

fn disabled() -> Settings {
    Settings {
        enabled: false,
        categories: vec![
            RequestKind::Question,
            RequestKind::Permission,
            RequestKind::Review,
        ],
        actions: None,
        resources: None,
        expires_at: None,
    }
}

impl Configuration {
    pub fn coordination_settings(&self) -> Result<Settings, Error> {
        let mut entries = Vec::new();
        let mut diagnostics = Vec::new();
        let nested = self.options.roots.config.join(".ycoding");
        let mut directories = vec![self.options.roots.config.clone()];
        self.options.roots.check(&nested)?;
        if nested.is_dir() {
            directories.push(nested);
        }
        for directory in &directories {
            for name in ["ycoding.json", "ycoding.jsonc"] {
                load_file(
                    &directory.join(name),
                    &self.options,
                    &mut entries,
                    &mut diagnostics,
                )?;
            }
        }
        if diagnostics
            .iter()
            .any(|diagnostic| diagnostic.reason.0.as_str() == Some("invalid-json"))
        {
            return Ok(disabled());
        }
        let policies = entries
            .iter()
            .filter_map(|entry| match entry {
                Entry::Document {
                    info: JsonValue::Object(info),
                    ..
                } => match info.get(&"coordination".into()) {
                    Some(JsonValue::Object(coordination)) => {
                        match coordination.get(&"delegated_decisions".into()) {
                            Some(JsonValue::Object(policy)) => Some(policy),
                            _ => None,
                        }
                    }
                    _ => None,
                },
                _ => None,
            })
            .collect::<Vec<_>>();
        Ok(settings(&policies).unwrap_or_else(disabled))
    }
}
