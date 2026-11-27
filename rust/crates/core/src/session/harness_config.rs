use crate::harness::{Ceiling, Mode, Settings};
use std::collections::BTreeSet;
use ycoding_schema::{
    DecodeError, DecodeErrorKind, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    schema::{NonNegativeInt, PositiveInt},
};

const DEFAULT_ITEM_BYTES: usize = 4_096;
const DEFAULT_ITEMS: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolved {
    pub settings: Settings,
    pub ceiling: Ceiling,
}

impl Default for Resolved {
    fn default() -> Self {
        Self {
            settings: Settings::default(),
            ceiling: Ceiling {
                max_item_bytes: DEFAULT_ITEM_BYTES,
                max_items: DEFAULT_ITEMS,
                ..Ceiling::default()
            },
        }
    }
}

fn mode(value: &LosslessString, path: &JsonPath) -> Result<Mode, DecodeError> {
    match value.as_str() {
        Some("adaptive") => Ok(Mode::Adaptive),
        Some("parallel") => Ok(Mode::Parallel),
        Some("sequential") => Ok(Mode::Sequential),
        Some("disabled") => Ok(Mode::Disabled),
        _ => Err(path.error(DecodeErrorKind::Expected(
            "adaptive, parallel, sequential or disabled",
        ))),
    }
}

fn names(
    object: &ObjectDecoder<'_>,
    key: &str,
    current: BTreeSet<String>,
) -> Result<BTreeSet<String>, DecodeError> {
    Ok(object
        .optional::<Vec<LosslessString>>(key)?
        .map_or(current, |items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        }))
}

fn layer(resolved: Resolved, value: &JsonValue, path: &JsonPath) -> Result<Resolved, DecodeError> {
    let object = ObjectDecoder::new(value, path)?;
    let positive = |key: &str| -> Result<Option<i64>, DecodeError> {
        Ok(object
            .optional::<PositiveInt>(key)?
            .map(|count| count.get()))
    };
    let count = |key: &str| -> Result<Option<i64>, DecodeError> {
        Ok(object
            .optional::<NonNegativeInt>(key)?
            .map(|count| count.get()))
    };
    let selected = match object.optional::<LosslessString>("mode")? {
        Some(text) => mode(&text, &path.key("mode"))?,
        None => resolved.settings.mode,
    };
    let depth = positive("max_depth")?;
    if depth.is_some_and(|depth| depth > i64::from(u8::MAX)) {
        return Err(path
            .key("max_depth")
            .error(DecodeErrorKind::Expected("integer from 1 to 255")));
    }
    let settings = Settings {
        mode: selected,
        steps: positive("steps")?.map_or(resolved.settings.steps, |value| value as usize),
        max_concurrency: positive("max_concurrency")?
            .map_or(resolved.settings.max_concurrency, |value| value as usize),
        max_depth: depth.map_or(resolved.settings.max_depth, |value| value as u8),
        max_tokens: positive("max_tokens")?
            .map_or(resolved.settings.max_tokens, |value| value as u64),
        max_latency_ms: positive("max_latency_ms")?
            .map_or(resolved.settings.max_latency_ms, |value| value as u64),
        min_signals: count("min_signals")?
            .map_or(resolved.settings.min_signals, |value| value as usize),
        recall_limit: count("recall_limit")?
            .map_or(resolved.settings.recall_limit, |value| value as usize),
    };
    let ceiling = match object.optional::<JsonValue>("ceiling")? {
        None => resolved.ceiling,
        Some(value) => {
            let path = path.key("ceiling");
            let object = ObjectDecoder::new(&value, &path)?;
            let bytes = object
                .optional::<PositiveInt>("max_item_bytes")?
                .map(|count| count.get() as usize);
            let items = object
                .optional::<PositiveInt>("max_items")?
                .map(|count| count.get() as usize);
            Ceiling {
                skills: names(&object, "skills", resolved.ceiling.skills)?,
                agents: names(&object, "agents", resolved.ceiling.agents)?,
                plugins: names(&object, "plugins", resolved.ceiling.plugins)?,
                scripts: names(&object, "scripts", resolved.ceiling.scripts)?,
                max_item_bytes: bytes.unwrap_or(resolved.ceiling.max_item_bytes),
                max_items: items.unwrap_or(resolved.ceiling.max_items),
            }
        }
    };
    Ok(Resolved { settings, ceiling })
}

pub fn resolve<'a>(
    mut values: impl Iterator<Item = &'a JsonValue>,
) -> Result<Option<Resolved>, DecodeError> {
    let path = JsonPath::default().key("harness");
    values.try_fold(None, |resolved: Option<Resolved>, value| {
        layer(resolved.unwrap_or_default(), value, &path).map(Some)
    })
}
