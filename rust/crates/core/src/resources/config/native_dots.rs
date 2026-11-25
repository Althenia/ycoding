use super::{Configuration, Entry, Error, decode_file, load_file, read_text};
use std::path::PathBuf;
use ycoding_schema::{JsonObject, JsonValue, LosslessString};

#[derive(Debug, PartialEq, Eq)]
pub struct FullAccessExecutorBinding {
    pub environment_id: String,
    pub harness_key_sha256: String,
}

impl Configuration {
    pub fn native_dots_full_access_executor(
        &self,
    ) -> Result<(PathBuf, Option<FullAccessExecutorBinding>), Error> {
        for name in ["ycoding.jsonc", "ycoding.json"] {
            let path = self.options.roots.config.join(name);
            self.options.roots.check(&path)?;
            let text = match read_text(&path) {
                Ok(text) if text.is_empty() => continue,
                Ok(text) => text,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(super::roots::io_error(&path, error)),
            };
            let invalid = || Error {
                path: Some(path.clone()),
                virtual_source: None,
                message: "Invalid trusted Dots configuration".into(),
                cause: None,
            };
            let decoded = decode_file(&path, &self.options, &text)?;
            if !decoded.diagnostics.is_empty() {
                return Err(invalid());
            }
            let Some(JsonValue::Object(info)) = decoded.info else {
                continue;
            };
            let Some(dots) = info.get(&"dots".into()) else {
                continue;
            };
            let JsonValue::Object(dots) = dots else {
                return Err(invalid());
            };
            let binding = match dots.get(&"fullAccessExecutor".into()) {
                Some(JsonValue::Object(binding)) => {
                    let field = |key: &str| match binding.get(&key.into()) {
                        Some(JsonValue::String(value)) => value.as_str().map(str::to_owned),
                        _ => None,
                    };
                    Some(FullAccessExecutorBinding {
                        environment_id: field("environmentId").ok_or_else(&invalid)?,
                        harness_key_sha256: field("harnessKeySha256").ok_or_else(&invalid)?,
                    })
                }
                None => None,
                _ => return Err(invalid()),
            };
            return Ok((path, binding));
        }
        Ok((self.options.roots.config.join("ycoding.json"), None))
    }

    fn trusted_dots(&self) -> Result<Option<JsonObject>, Error> {
        let mut entries = Vec::new();
        let mut diagnostics = Vec::new();
        for name in ["ycoding.json", "ycoding.jsonc"] {
            load_file(
                &self.options.roots.config.join(name),
                &self.options,
                &mut entries,
                &mut diagnostics,
            )?;
        }
        if diagnostics.iter().any(|diagnostic| {
            !diagnostic
                .json_path
                .as_ref()
                .and_then(LosslessString::as_str)
                .is_some_and(|path| {
                    path == "$.dots.fullAccessExecutor"
                        || path.starts_with("$.dots.fullAccessExecutor.")
                        || path.starts_with("$.dots.fullAccessExecutor[")
                })
        }) {
            return Ok(None);
        }
        let selected = entries
            .iter()
            .filter_map(|entry| match entry {
                Entry::Document {
                    info: JsonValue::Object(info),
                    ..
                } => info.get(&"dots".into()),
                _ => None,
            })
            .next_back();
        Ok(match selected {
            Some(JsonValue::Object(selected)) => Some(selected.clone()),
            _ => None,
        })
    }

    pub fn native_dots_profile(&self) -> Result<Option<String>, Error> {
        let Some(selected) = self.trusted_dots()? else {
            return Ok(None);
        };
        if selected.get(&"enabled".into()) != Some(&JsonValue::Bool(true)) {
            return Ok(None);
        }
        Ok(match selected.get(&"profile".into()) {
            Some(JsonValue::String(profile)) => profile
                .as_str()
                .filter(|value| !value.trim().is_empty() && value.len() <= 256)
                .map(str::to_owned),
            _ => None,
        })
    }

    pub fn native_dots_name(&self) -> Result<Option<LosslessString>, Error> {
        Ok(
            match self
                .trusted_dots()?
                .as_ref()
                .and_then(|selected| selected.get(&"name".into()))
            {
                Some(JsonValue::String(name)) => Some(name.clone()),
                _ => None,
            },
        )
    }
}
