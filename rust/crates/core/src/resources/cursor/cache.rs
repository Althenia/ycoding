use serde_json::{Map, Value, json};
use std::{
    future::Future,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use ycoding_ai::cursor::models::{Info, Variant};
use ycoding_schema::LosslessString;

pub const FILE: &str = "cursor-models.json";
pub const SCHEMA_VERSION: u64 = 3;
pub const TTL_MS: f64 = 86_400_000.0;

#[derive(Clone, Debug, PartialEq)]
pub struct Cache {
    pub models: Vec<Info>,
    pub fetched_at: f64,
}

pub fn path(directory: &Path) -> PathBuf {
    directory.join(FILE)
}

pub fn fresh(cache: &Cache, now: f64) -> bool {
    now - cache.fetched_at < TTL_MS
}

pub fn read(directory: &Path) -> Option<Cache> {
    let value = serde_json::from_slice::<Value>(&std::fs::read(path(directory)).ok()?).ok()?;
    let object = value.as_object()?;
    if object.get("schemaVersion")?.as_u64()? != SCHEMA_VERSION {
        return None;
    }
    Some(Cache {
        models: object
            .get("models")?
            .as_array()?
            .iter()
            .map(model)
            .collect::<Option<_>>()?,
        fetched_at: object
            .get("fetchedAt")?
            .as_f64()
            .filter(|v| v.is_finite())?,
    })
}

pub fn write(directory: &Path, cache: &Cache) -> std::io::Result<()> {
    std::fs::create_dir_all(directory)?;
    let temporary = directory.join(format!(
        ".{FILE}.{}.{}.tmp",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos())
    ));
    let document = json!({
        "models": cache.models.iter().map(encode_model).collect::<Vec<_>>(),
        "fetchedAt": cache.fetched_at,
        "schemaVersion": SCHEMA_VERSION,
    });
    let result = std::fs::write(&temporary, serde_json::to_vec_pretty(&document)?)
        .and_then(|()| std::fs::rename(&temporary, path(directory)));
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

pub async fn refresh<F, Fut, E>(directory: &Path, now: f64, fetch: F) -> Result<Vec<Info>, E>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Vec<Info>, E>>,
    E: From<std::io::Error>,
{
    let models = fetch().await?;
    write(
        directory,
        &Cache {
            models: models.clone(),
            fetched_at: now,
        },
    )?;
    Ok(models)
}

pub async fn discover<F, Fut, E>(
    directory: &Path,
    now: f64,
    force: bool,
    fetch: F,
) -> Result<Vec<Info>, E>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Vec<Info>, E>>,
    E: From<std::io::Error>,
{
    let cached = read(directory);
    if let Some(cache) = cached.as_ref().filter(|cache| !force && fresh(cache, now)) {
        return Ok(cache.models.clone());
    }
    match (refresh(directory, now, fetch).await, cached) {
        (Ok(models), _) => Ok(models),
        (Err(error), Some(_)) if force => Err(error),
        (Err(_), Some(cache)) => Ok(cache.models),
        (Err(error), None) => Err(error),
    }
}

fn encode_model(model: &Info) -> Value {
    let mut object = Map::new();
    object.insert("id".into(), text(&model.id).into());
    object.insert("displayName".into(), text(&model.display_name).into());
    object.insert("supportsThinking".into(), model.supports_thinking.into());
    object.insert("supportsAgent".into(), model.supports_agent.into());
    if let Some(images) = model.supports_images {
        object.insert("supportsImages".into(), images.into());
    }
    if let Some(context) = model.max_context {
        object.insert("maxContext".into(), context.into());
    }
    if let Some(context) = model.max_context_max_mode {
        object.insert("maxContextForMaxMode".into(), context.into());
    }
    object.insert("supportsMaxMode".into(), model.supports_max_mode.into());
    object.insert(
        "variants".into(),
        model
            .variants
            .iter()
            .map(|variant| {
                json!({
                    "key": text(&variant.key),
                    "displayName": text(&variant.display_name),
                    "parameterValues": variant.parameters.iter().map(|(id, value)| json!({"id": text(id), "value": text(value)})).collect::<Vec<_>>(),
                    "isDefaultNonMax": variant.default_non_max,
                    "isDefaultMax": variant.default_max,
                })
            })
            .collect::<Vec<_>>()
            .into(),
    );
    Value::Object(object)
}

fn model(value: &Value) -> Option<Info> {
    let object = value.as_object()?;
    let id = nonblank(object.get("id")?)?;
    Some(Info {
        display_name: optional(object, "displayName", string)?.unwrap_or_else(|| id.clone()),
        supports_thinking: optional(object, "supportsThinking", Value::as_bool)?.unwrap_or(false),
        supports_agent: optional(object, "supportsAgent", Value::as_bool)?.unwrap_or(false),
        supports_images: optional(object, "supportsImages", Value::as_bool)?,
        max_context: optional(object, "maxContext", positive)?,
        max_context_max_mode: optional(object, "maxContextForMaxMode", positive)?,
        supports_max_mode: optional(object, "supportsMaxMode", Value::as_bool)?.unwrap_or(false),
        variants: match object.get("variants") {
            None => Vec::new(),
            Some(variants) => variants
                .as_array()?
                .iter()
                .map(|variant| self::variant(variant, &id))
                .collect::<Option<_>>()?,
        },
        id,
    })
}

fn variant(value: &Value, fallback: &LosslessString) -> Option<Variant> {
    let object = value.as_object()?;
    Some(Variant {
        key: optional(object, "key", nonblank)?.unwrap_or_else(|| fallback.clone()),
        display_name: optional(object, "displayName", nonblank)?
            .unwrap_or_else(|| fallback.clone()),
        parameters: match object.get("parameterValues") {
            None => Vec::new(),
            Some(values) => values
                .as_array()?
                .iter()
                .map(|parameter| {
                    let parameter = parameter.as_object()?;
                    Some((
                        nonblank(parameter.get("id")?)?,
                        string(parameter.get("value")?)?,
                    ))
                })
                .collect::<Option<_>>()?,
        },
        default_non_max: optional(object, "isDefaultNonMax", Value::as_bool)?.unwrap_or(false),
        default_max: optional(object, "isDefaultMax", Value::as_bool)?.unwrap_or(false),
    })
}

fn optional<T>(
    object: &Map<String, Value>,
    name: &str,
    read: impl Fn(&Value) -> Option<T>,
) -> Option<Option<T>> {
    match object.get(name) {
        None => Some(None),
        Some(value) => read(value).map(Some),
    }
}

fn string(value: &Value) -> Option<LosslessString> {
    value.as_str().map(Into::into)
}

fn nonblank(value: &Value) -> Option<LosslessString> {
    value
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .map(Into::into)
}

fn positive(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|value| value.is_finite() && *value > 0.0)
}

fn text(value: &LosslessString) -> String {
    String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>())
}
