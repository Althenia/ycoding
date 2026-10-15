pub mod builtins;

use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    pin::Pin,
    sync::Arc,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonObject, JsonValue, LosslessString, instruction, stringify_json,
};

#[derive(Debug)]
pub enum Error {
    Store(ycoding_store::Error),
    InitializationBlocked(Vec<instruction::Key>),
    DuplicateKey(instruction::Key),
    EmptyRender {
        key: instruction::Key,
        kind: &'static str,
    },
    ReaderFailed,
}

impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "Instructions: {self:?}")
    }
}
impl std::error::Error for Error {}
impl From<ycoding_store::Error> for Error {
    fn from(error: ycoding_store::Error) -> Self {
        Self::Store(error)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Observation {
    Value(JsonValue),
    Unavailable,
    Removed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Observed {
    pub key: instruction::Key,
    pub value: Observation,
}

pub type ReadFuture = Pin<Box<dyn Future<Output = Result<Observation, Error>> + Send>>;
pub type Initial = dyn Fn(&JsonValue) -> Option<LosslessString> + Send + Sync;
pub type Changed = dyn Fn(&JsonValue, &JsonValue) -> Option<LosslessString> + Send + Sync;

#[derive(Clone)]
pub struct Source {
    pub key: instruction::Key,
    pub read: Arc<dyn Fn() -> ReadFuture + Send + Sync>,
    pub initial: Arc<Initial>,
    pub changed: Arc<Changed>,
    pub removed: Option<Arc<Initial>>,
}

pub fn constant(key: &str, content: &'static str) -> Source {
    Source {
        key: instruction::Key::decode(&JsonValue::String(key.into()))
            .expect("static instruction key"),
        read: Arc::new(move || {
            Box::pin(async move { Ok(Observation::Value(JsonValue::String(content.into()))) })
        }),
        initial: Arc::new(|value| match value {
            JsonValue::String(value) => Some(value.clone()),
            _ => None,
        }),
        changed: Arc::new(|_, value| match value {
            JsonValue::String(value) => Some(value.clone()),
            _ => None,
        }),
        removed: None,
    }
}

pub fn when(enabled: bool, sources: Vec<Source>) -> Vec<Source> {
    sources
        .into_iter()
        .map(|mut source| {
            if !enabled {
                source.read = Arc::new(|| Box::pin(async { Ok(Observation::Removed) }));
            }
            if source.removed.is_none() {
                let key = key(&source.key);
                source.removed = Some(Arc::new(move |_| {
                    Some(join(
                        &[
                            "Instructions from ".into(),
                            key.clone(),
                            " no longer apply.".into(),
                        ],
                        "",
                    ))
                }));
            }
            source
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq)]
pub struct Admission {
    pub delta: instruction::Delta,
    pub blobs: BTreeMap<LosslessString, JsonValue>,
}

pub fn combine(groups: Vec<Vec<Source>>) -> Result<Vec<Source>, Error> {
    let mut keys = BTreeSet::new();
    groups
        .into_iter()
        .flatten()
        .map(|source| {
            if !keys.insert(source.key.clone()) {
                return Err(Error::DuplicateKey(source.key));
            }
            Ok(source)
        })
        .collect()
}

pub async fn read(sources: &[Source]) -> Result<Vec<Observed>, Error> {
    let mut readers = tokio::task::JoinSet::new();
    for (index, source) in sources.iter().cloned().enumerate() {
        readers.spawn(async move {
            Ok::<_, Error>((
                index,
                Observed {
                    key: source.key,
                    value: (source.read)().await?,
                },
            ))
        });
    }
    let mut observed = Vec::new();
    while let Some(result) = readers.join_next().await {
        observed.push(result.map_err(|_| Error::ReaderFailed)??);
    }
    observed.sort_by_key(|(index, _)| *index);
    Ok(observed.into_iter().map(|(_, entry)| entry).collect())
}

pub fn diff(
    observed: &[Observed],
    previous: Option<&instruction::Values>,
) -> Result<Admission, Error> {
    let blocked = observed
        .iter()
        .filter(|entry| previous.is_none() && entry.value == Observation::Unavailable)
        .map(|entry| entry.key.clone())
        .collect::<Vec<_>>();
    if !blocked.is_empty() {
        return Err(Error::InitializationBlocked(blocked));
    }
    let mut delta = JsonObject::new();
    let mut blobs = BTreeMap::new();
    for entry in observed {
        let key = key(&entry.key);
        match &entry.value {
            Observation::Unavailable => {}
            Observation::Removed => {
                if previous.is_some_and(|previous| previous.0.get(&key).is_some()) {
                    delta.insert(key, JsonValue::String("removed".into()));
                }
            }
            Observation::Value(value) => {
                let hash = hash(value);
                if previous.is_some_and(|previous| previous.0.get(&key) == Some(&hash.encode())) {
                    continue;
                }
                delta.insert(key, hash.encode());
                let JsonValue::String(hash) = hash.encode() else {
                    unreachable!("instruction hash encodes a string")
                };
                blobs.insert(hash, value.clone());
            }
        }
    }
    Ok(Admission {
        delta: instruction::Delta(delta),
        blobs,
    })
}

pub fn hash(value: &JsonValue) -> instruction::Hash {
    let digest = ring::digest::digest(&ring::digest::SHA256, canonical(value).as_bytes());
    instruction::Hash::decode(&JsonValue::String(
        digest
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
            .into(),
    ))
    .expect("SHA-256 encodes a valid instruction hash")
}

fn canonical(value: &JsonValue) -> String {
    match value {
        JsonValue::Array(values) => format!(
            "[{}]",
            values.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        JsonValue::Object(values) => {
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        stringify_json(&JsonValue::String(key.clone())),
                        canonical(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        _ => stringify_json(value),
    }
}

pub fn apply_hash_delta(
    values: &instruction::Values,
    delta: &instruction::Delta,
) -> instruction::Values {
    let mut result = JsonObject::new();
    for (key, value) in values.0.iter() {
        if delta.0.get(key) != Some(&JsonValue::String("removed".into())) {
            result.insert(key.clone(), value.clone());
        }
    }
    for (key, value) in delta.0.iter() {
        if value != &JsonValue::String("removed".into()) {
            result.insert(key.clone(), value.clone());
        }
    }
    instruction::Values(result)
}

pub fn apply_delta(
    values: &JsonObject,
    delta: &BTreeMap<LosslessString, Option<JsonValue>>,
) -> JsonObject {
    let mut result = JsonObject::new();
    for (key, value) in values.iter() {
        if delta.get(key) != Some(&None) {
            result.insert(key.clone(), value.clone());
        }
    }
    for (key, value) in delta {
        if let Some(value) = value {
            result.insert(key.clone(), value.clone());
        }
    }
    result
}

pub fn render_initial(sources: &[Source], values: &JsonObject) -> Result<LosslessString, Error> {
    let mut rendered = Vec::new();
    for source in sources {
        if let Some(value) = values.get(&key(&source.key))
            && let Some(text) = (source.initial)(value)
        {
            rendered.push(require_text(source, "initial", text)?);
        }
    }
    Ok(join(&rendered, "\n\n"))
}

pub fn render_update(
    sources: &[Source],
    previous: &JsonObject,
    delta: &BTreeMap<LosslessString, Option<JsonValue>>,
) -> Result<LosslessString, Error> {
    let mut rendered = Vec::new();
    for source in sources {
        let key = key(&source.key);
        let Some(current) = delta.get(&key) else {
            continue;
        };
        let text = match (previous.get(&key), current) {
            (Some(previous), None) => source
                .removed
                .as_ref()
                .and_then(|removed| removed(previous)),
            (Some(previous), Some(current)) => (source.changed)(previous, current),
            (None, Some(current)) => (source.initial)(current),
            (None, None) => None,
        };
        if let Some(text) = text {
            rendered.push(require_text(source, "update", text)?);
        }
    }
    Ok(join(&rendered, "\n\n"))
}

fn require_text(
    source: &Source,
    kind: &'static str,
    text: LosslessString,
) -> Result<LosslessString, Error> {
    if text.is_empty() {
        return Err(Error::EmptyRender {
            key: source.key.clone(),
            kind,
        });
    }
    Ok(text)
}

pub fn join(parts: &[LosslessString], separator: &str) -> LosslessString {
    let separator = LosslessString::from(separator);
    let mut units = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            units.extend(separator.code_units());
        }
        units.extend(part.code_units());
    }
    LosslessString::from_utf16(units)
}

pub fn key(key: &instruction::Key) -> LosslessString {
    let JsonValue::String(key) = key.encode() else {
        unreachable!("instruction key encodes a string")
    };
    key
}
