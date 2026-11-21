use super::{
    error::{RpcError, echo},
    json::{self, NumberStyle, lossy},
    types::*,
};
use ycoding_core::ycoding_schema::{JsonObject, JsonValue};

fn invalid(message: impl Into<Text>) -> RpcError {
    RpcError::invalid_params(message)
}

fn unexpected(value: Option<&JsonValue>) -> String {
    value.map_or_else(
        || "null".to_string(),
        |value| json::unexpected(value, NumberStyle::Plain),
    )
}

fn tagged_unexpected(value: &JsonValue) -> String {
    json::unexpected(value, NumberStyle::Integral)
}

fn missing(object: &JsonObject, required: &[&str]) -> Result<(), RpcError> {
    match required.iter().find(|key| !json::has(object, key)) {
        Some(key) => Err(invalid(format!("missing field `{key}`"))),
        None => Ok(()),
    }
}

fn structure<'a>(value: Option<&'a JsonValue>, name: &str) -> Result<&'a JsonObject, RpcError> {
    match value {
        Some(JsonValue::Object(object)) => Ok(object),
        other => Err(invalid(format!(
            "invalid type: {}, expected struct {name}",
            unexpected(other)
        ))),
    }
}

fn expect_string(value: &JsonValue) -> Result<Text, RpcError> {
    match value {
        JsonValue::String(text) => Ok(text.clone()),
        other => Err(invalid(format!(
            "invalid type: {}, expected a string",
            unexpected(Some(other))
        ))),
    }
}

fn sequence(value: &JsonValue) -> Result<&Vec<JsonValue>, RpcError> {
    match value {
        JsonValue::Array(items) => Ok(items),
        other => Err(invalid(format!(
            "invalid type: {}, expected a sequence",
            unexpected(Some(other))
        ))),
    }
}

fn scheme_of(text: &str) -> Option<&str> {
    let end = text.find(':')?;
    let scheme = &text[..end];
    let mut characters = scheme.chars();
    let first = characters.next()?;
    (first.is_ascii_alphabetic()
        && characters.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')))
    .then_some(scheme)
}

fn expect_path_uri(value: &JsonValue) -> Result<Text, RpcError> {
    let text = expect_string(value)?;
    let plain = lossy(&text);
    let Some(scheme) = scheme_of(&plain) else {
        return Err(invalid("invalid URI: relative URL without a base"));
    };
    if !scheme.eq_ignore_ascii_case("file") {
        return Err(invalid(format!("unsupported path URI scheme `{scheme}`")));
    }
    Ok(text)
}

fn expect_toml_paths(value: &JsonValue) -> Result<Vec<Vec<Text>>, RpcError> {
    sequence(value)?
        .iter()
        .map(|item| -> Result<Vec<Text>, RpcError> {
            sequence(item)?.iter().map(expect_string).collect()
        })
        .collect()
}

pub fn decode_environment_config_read(
    params: Option<&JsonValue>,
) -> Result<EnvironmentConfigReadParams, RpcError> {
    let record = structure(params, "EnvironmentConfigReadParams")?;
    let mut cwd = Text::default();
    let mut config_paths = Vec::new();
    let mut requirements_paths = Vec::new();
    for (key, value) in record.iter() {
        match lossy(key).as_str() {
            "cwd" => cwd = expect_path_uri(value)?,
            "configPaths" => config_paths = expect_toml_paths(value)?,
            "requirementsPaths" => requirements_paths = expect_toml_paths(value)?,
            _ => {}
        }
    }
    missing(record, &["cwd", "configPaths", "requirementsPaths"])?;
    Ok(EnvironmentConfigReadParams {
        cwd,
        config_paths,
        requirements_paths,
    })
}

pub fn decode_capability_roots_discover(
    params: Option<&JsonValue>,
) -> Result<CapabilityRootsDiscoverParams, RpcError> {
    let record = structure(params, "WireCapabilityRootsDiscoverParams")?;
    missing(record, &["roots"])?;
    let Some(roots) = json::get(record, "roots") else {
        return Err(invalid("missing field `roots`"));
    };
    let roots = sequence(roots)?;
    let mut decoded = Vec::new();
    for root in roots {
        let entry = structure(Some(root), "WireCapabilityRootDiscoverRequest")?;
        let mut id = Text::default();
        let mut path = Text::default();
        let mut sandbox = None;
        for (key, value) in entry.iter() {
            match lossy(key).as_str() {
                "id" => id = expect_string(value)?,
                "path" => path = expect_path_uri(value)?,
                "sandbox" if !matches!(value, JsonValue::Null) => {
                    sandbox = Some(structure(Some(value), "WireFileSystemSandboxContext")?.clone());
                }
                _ => {}
            }
        }
        missing(entry, &["id", "path"])?;
        decoded.push(CapabilityRootRequest { id, path, sandbox });
    }
    Ok(CapabilityRootsDiscoverParams { roots: decoded })
}

const PERMISSION_PROFILE_TYPES: [&str; 3] = ["managed", "disabled", "external"];
const WINDOWS_SANDBOX_LEVELS: [&str; 4] = ["disabled", "restricted-token", "elevated", "mxc"];

fn variants(names: &[&str]) -> String {
    names
        .iter()
        .map(|name| format!("`{name}`"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn is_trimmed_character(character: char) -> bool {
    character <= '\u{20}'
}

fn v2_path_uri(value: &JsonValue) -> Result<Text, RpcError> {
    let original = expect_string(value)?;
    let plain = lossy(&original);
    let trimmed = plain.trim_matches(is_trimmed_character);
    let Some(scheme) = scheme_of(trimmed) else {
        return Err(invalid("invalid URI: relative URL without a base"));
    };
    let name = scheme.to_ascii_lowercase();
    if name != "file" {
        return Err(invalid(format!("unsupported path URI scheme `{name}`")));
    }
    let hash = trimmed.find('#');
    if trimmed[..hash.unwrap_or(trimmed.len())].contains('?') {
        return Err(invalid("query parameters are not allowed in path URIs"));
    }
    if hash.is_some() {
        return Err(invalid("fragments are not allowed in path URIs"));
    }
    Ok(original)
}

fn v2_sandbox(value: &JsonValue) -> Result<Option<JsonObject>, RpcError> {
    let record = match value {
        JsonValue::Null => return Ok(None),
        JsonValue::Array(items) if items.is_empty() => {
            return Err(invalid(
                "invalid length 0, expected struct FileSystemSandboxContext with 9 elements",
            ));
        }
        JsonValue::Array(_) => {
            return Err(invalid(
                "invalid type: sequence, expected struct FileSystemSandboxContext",
            ));
        }
        JsonValue::Object(record) => record,
        other => {
            return Err(invalid(format!(
                "invalid type: {}, expected struct FileSystemSandboxContext",
                unexpected(Some(other))
            )));
        }
    };
    for (key, field) in record.iter() {
        match lossy(key).as_str() {
            "permissions" => {
                let profile = match field {
                    JsonValue::Array(_) => return Err(invalid("missing field `type`")),
                    JsonValue::Object(profile) => profile,
                    other => {
                        return Err(invalid(format!(
                            "invalid type: {}, expected internally tagged enum ExecPermissionProfile",
                            tagged_unexpected(other)
                        )));
                    }
                };
                let Some(kind) = json::get(profile, "type") else {
                    return Err(invalid("missing field `type`"));
                };
                if let JsonValue::String(kind) = kind
                    && !PERMISSION_PROFILE_TYPES.contains(&lossy(kind).as_str())
                {
                    return Err(invalid(echo(
                        "unknown variant `",
                        kind,
                        &format!("`, expected one of {}", variants(&PERMISSION_PROFILE_TYPES)),
                    )));
                }
            }
            "cwd" => {
                v2_path_uri(field)?;
            }
            "workspaceRoots" => {
                for item in sequence(field)? {
                    v2_path_uri(item)?;
                }
            }
            "userHomeDir" => {
                if !matches!(field, JsonValue::Null) {
                    v2_path_uri(field)?;
                }
            }
            "temporaryDirectories" => {
                if matches!(field, JsonValue::Null) {
                    continue;
                }
                for item in sequence(field)? {
                    v2_path_uri(item)?;
                }
            }
            "windowsSandboxLevel" => match field {
                JsonValue::String(level) => {
                    if !WINDOWS_SANDBOX_LEVELS.contains(&lossy(level).as_str()) {
                        return Err(invalid(echo(
                            "unknown variant `",
                            level,
                            &format!("`, expected one of {}", variants(&WINDOWS_SANDBOX_LEVELS)),
                        )));
                    }
                }
                JsonValue::Object(_) => {}
                other => {
                    return Err(invalid(format!(
                        "invalid type: {}, expected string or map",
                        unexpected(Some(other))
                    )));
                }
            },
            "useLegacyLandlock" if !matches!(field, JsonValue::Bool(_)) => {
                return Err(invalid(format!(
                    "invalid type: {}, expected a boolean",
                    unexpected(Some(field))
                )));
            }
            _ => {}
        }
    }
    missing(record, &["permissions", "cwd", "windowsSandboxLevel"])?;
    Ok(Some(record.clone()))
}

pub fn decode_discover_v2(params: Option<&JsonValue>) -> Result<DiscoverV2Params, RpcError> {
    match params {
        Some(JsonValue::Array(items)) => {
            if items.is_empty() {
                return Err(invalid(
                    "invalid length 0, expected struct DiscoverV2CapabilitiesRequest with 2 elements",
                ));
            }
            let cwd = v2_path_uri(&items[0])?;
            let sandbox = if items.len() > 1 {
                v2_sandbox(&items[1])?
            } else {
                None
            };
            if items.len() > 2 {
                return Err(invalid(format!(
                    "invalid length {}, expected fewer elements in array",
                    items.len()
                )));
            }
            Ok(DiscoverV2Params { cwd, sandbox })
        }
        Some(JsonValue::Object(record)) => {
            let mut cwd = None;
            let mut sandbox = None;
            for (key, value) in record.iter() {
                match lossy(key).as_str() {
                    "cwd" => cwd = Some(v2_path_uri(value)?),
                    "sandbox" => sandbox = v2_sandbox(value)?,
                    _ => {}
                }
            }
            match cwd {
                Some(cwd) => Ok(DiscoverV2Params { cwd, sandbox }),
                None => Err(invalid("missing field `cwd`")),
            }
        }
        other => Err(invalid(format!(
            "invalid type: {}, expected struct DiscoverV2CapabilitiesRequest",
            unexpected(other)
        ))),
    }
}
