use super::{Configuration, Entry, Error, load_file};
use ycoding_schema::{JsonObject, JsonValue, LosslessString};

impl Configuration {
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
        if !diagnostics.is_empty() {
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
