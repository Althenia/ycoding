use icu_normalizer::ComposingNormalizer;
use ycoding_schema::{JsonObject, JsonValue};

pub const FILE: &str = "SKILL.md";
pub const MAX_NAME: usize = 64;
pub const MAX_DESCRIPTION: usize = 1024;
pub const MAX_COMPATIBILITY: usize = 500;
pub const MAX_LINES: usize = 500;
pub const MAX_DESCRIPTIVE: usize = 1024;
pub const DESCRIPTIVE: [&str; 6] = [
    "purpose",
    "applicability",
    "triggers",
    "capabilities",
    "prerequisites",
    "related",
];

fn normalize(value: &str) -> String {
    ComposingNormalizer::new_nfkc()
        .normalize(value.trim())
        .into_owned()
}

pub fn name_violation(name: &str, directory: &str) -> Option<String> {
    let name = normalize(name);
    if name.is_empty() {
        return Some("Field 'name' must be a non-empty string".into());
    }
    if name.chars().count() > MAX_NAME {
        return Some(format!("Skill name exceeds {MAX_NAME} characters"));
    }
    if name != name.to_lowercase() {
        return Some("Skill name must be lowercase".into());
    }
    if name.starts_with('-') || name.ends_with('-') {
        return Some("Skill name cannot start or end with a hyphen".into());
    }
    if name.contains("--") {
        return Some("Skill name cannot contain consecutive hyphens".into());
    }
    if !name.chars().all(|c| c.is_alphanumeric() || c == '-') {
        return Some("Skill name may contain only letters, digits and hyphens".into());
    }
    if normalize(directory) != name {
        return Some(format!(
            "Directory name '{directory}' must match skill name '{name}'"
        ));
    }
    None
}

pub fn description_violation(description: &str) -> Option<String> {
    if description.trim().is_empty() {
        return Some("Field 'description' must be a non-empty string".into());
    }
    (description.chars().count() > MAX_DESCRIPTION)
        .then(|| format!("Description exceeds {MAX_DESCRIPTION} characters"))
}

pub fn violation(directory: &str, data: &JsonObject) -> Option<String> {
    let text = |key: &str| match data.get(&key.into()) {
        None => Ok(None),
        Some(JsonValue::String(value)) => value
            .to_utf8()
            .map(Some)
            .map_err(|_| format!("Field '{key}' must be valid Unicode")),
        Some(_) => Err(format!("Field '{key}' must be a string")),
    };
    let name = match text("name") {
        Ok(Some(name)) => name,
        Ok(None) => return Some("Missing required field in frontmatter: name".into()),
        Err(message) => return Some(message),
    };
    if let Some(message) = name_violation(&name, directory) {
        return Some(message);
    }
    let description = match text("description") {
        Ok(Some(description)) => description,
        Ok(None) => return Some("Missing required field in frontmatter: description".into()),
        Err(message) => return Some(message),
    };
    if let Some(message) = description_violation(&description) {
        return Some(message);
    }
    for key in ["license", "allowed-tools"] {
        if let Err(message) = text(key) {
            return Some(message);
        }
    }
    match text("compatibility") {
        Err(message) => return Some(message),
        Ok(Some(value)) if value.is_empty() || value.chars().count() > MAX_COMPATIBILITY => {
            return Some(format!(
                "Field 'compatibility' must be 1-{MAX_COMPATIBILITY} characters"
            ));
        }
        Ok(_) => {}
    }
    match data.get(&"metadata".into()) {
        None => None,
        Some(JsonValue::Object(metadata)) => DESCRIPTIVE.into_iter().find_map(|key| {
            let value = metadata.get(&key.into())?;
            match value {
                JsonValue::String(text)
                    if text.to_utf8().is_ok_and(|text| {
                        !text.trim().is_empty() && text.chars().count() <= MAX_DESCRIPTIVE
                    }) =>
                {
                    None
                }
                _ => Some(format!(
                    "Metadata '{key}' must be a nonempty string of at most {MAX_DESCRIPTIVE} characters"
                )),
            }
        }),
        Some(_) => Some("Field 'metadata' must be a mapping".into()),
    }
}
