use super::{Configuration, Entry, Error, Scope, WriteError, jsonc, load_file};
use crate::session::autonomy::{Defaults, DefaultsChange, Refusal};
use std::cell::Cell;
use ycoding_schema::JsonValue;

fn defaults_value(root: &JsonValue) -> Option<&JsonValue> {
    let JsonValue::Object(root) = root else {
        return None;
    };
    match root.get(&"autonomy".into()) {
        Some(JsonValue::Object(autonomy)) => autonomy.get(&"defaults".into()),
        _ => None,
    }
}

impl Configuration {
    pub fn autonomy_defaults(&self) -> Result<Defaults, Error> {
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
            return Ok(Defaults::default());
        }
        Ok(entries
            .iter()
            .filter_map(|entry| match entry {
                Entry::Document { info, .. } => defaults_value(info),
                _ => None,
            })
            .next_back()
            .map_or_else(Defaults::default, |value| Defaults::decode(Some(value))))
    }

    pub fn write_autonomy_defaults(
        &self,
        change: DefaultsChange,
        now: u64,
    ) -> Result<Result<Defaults, Refusal>, WriteError> {
        let refusal = Cell::new(None);
        let written = self.write(Scope::Global, false, |text| {
            let current = jsonc::parse(text.trim_start_matches('\u{feff}'))
                .map_err(|_| WriteError::InvalidConfig)?;
            if !matches!(current, JsonValue::Object(_)) {
                return Err(WriteError::InvalidConfig);
            }
            let next = match Defaults::decode(defaults_value(&current)).apply(change, now) {
                Ok(next) => next,
                Err(reason) => {
                    refusal.set(Some(reason));
                    return Err(WriteError::InvalidConfig);
                }
            };
            jsonc::modify(
                text,
                &["autonomy".into(), "defaults".into()],
                &next.encode(),
            )
            .map_err(|_| WriteError::InvalidConfig)
        });
        if let Some(reason) = refusal.get() {
            return Ok(Err(reason));
        }
        written?;
        self.autonomy_defaults()
            .map(Ok)
            .map_err(|_| WriteError::WriteFailed)
    }
}
