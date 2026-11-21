use serde_json::{Map, Value, json};
use std::fmt;
use ycoding_schema::{DomainDecode, LosslessString, ObjectEncoder, model};

pub const DEFAULT_MODEL: &str = "biodatlab/whisper-th-large-v3-combined";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

#[derive(Clone, Debug, PartialEq)]
pub struct TranscriptionConfig {
    pub provider: String,
    pub model: String,
    pub language: String,
    pub device: String,
    pub cache_dir: String,
    pub python_executable: String,
    pub chunk_seconds: u32,
    pub overlap_seconds: u32,
    pub request_timeout_ms: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StreamingConfig {
    pub enabled: bool,
    pub vad: bool,
    pub sample_rate: u32,
    pub max_buffered_seconds: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct VocabularyConfig {
    pub preserve_technical_terms: bool,
    pub hints: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FallbackConfig {
    pub enabled: bool,
    pub provider: Option<String>,
    pub model: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AnalysisModel {
    Inherit,
    Explicit {
        id: String,
        provider_id: String,
        variant: Option<String>,
        profile: Option<String>,
    },
}

impl AnalysisModel {
    pub fn reference(&self) -> Result<Option<model::Ref>, ConfigError> {
        let Self::Explicit {
            id,
            provider_id,
            variant,
            profile,
        } = self
        else {
            return Ok(None);
        };
        model::Ref::decode(
            &ObjectEncoder::new()
                .field("id", id.as_str())
                .field("providerID", provider_id.as_str())
                .optional("variant", &variant.as_deref().map(LosslessString::from))
                .optional("profile", &profile.as_deref().map(LosslessString::from))
                .finish(),
        )
        .map(Some)
        .map_err(|error| ConfigError(error.to_string()))
    }

    pub fn to_value(&self) -> Value {
        let Self::Explicit {
            id,
            provider_id,
            variant,
            profile,
        } = self
        else {
            return json!("inherit");
        };
        let mut model = Map::new();
        model.insert("id".into(), json!(id));
        model.insert("providerID".into(), json!(provider_id));
        if let Some(variant) = variant {
            model.insert("variant".into(), json!(variant));
        }
        if let Some(profile) = profile {
            model.insert("profile".into(), json!(profile));
        }
        Value::Object(model)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AnalysisConfig {
    pub model: AnalysisModel,
    pub ask_model: AnalysisModel,
    pub incremental: bool,
    pub max_characters: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct KnowledgeBinding {
    pub server: String,
    pub search: String,
    pub read: String,
    pub write: Option<String>,
    pub enabled: bool,
}

impl KnowledgeBinding {
    pub fn to_value(&self) -> Value {
        let mut value = Map::new();
        value.insert("server".into(), json!(self.server));
        value.insert("search".into(), json!(self.search));
        value.insert("read".into(), json!(self.read));
        if let Some(write) = &self.write {
            value.insert("write".into(), json!(write));
        }
        value.insert("enabled".into(), json!(self.enabled));
        Value::Object(value)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct KnowledgeConfig {
    pub mcp_enabled: bool,
    pub retrieval_ttl: u32,
    pub bindings: Vec<KnowledgeBinding>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StorageConfig {
    pub retention_days: Option<u32>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MeetingConfig {
    pub transcription: TranscriptionConfig,
    pub streaming: StreamingConfig,
    pub vocabulary: VocabularyConfig,
    pub fallback: FallbackConfig,
    pub analysis: AnalysisConfig,
    pub knowledge: KnowledgeConfig,
    pub storage: StorageConfig,
}

impl MeetingConfig {
    pub fn parse(value: &Value) -> Result<Self, ConfigError> {
        let map = object(
            value,
            "",
            &[
                "transcription",
                "streaming",
                "vocabulary",
                "fallback",
                "analysis",
                "knowledge",
                "storage",
            ],
        )?;
        Ok(Self {
            transcription: TranscriptionConfig::parse_at(
                section(map, "transcription"),
                "transcription",
            )?,
            streaming: StreamingConfig::parse(section(map, "streaming"))?,
            vocabulary: VocabularyConfig::parse(section(map, "vocabulary"))?,
            fallback: FallbackConfig::parse(section(map, "fallback"))?,
            analysis: AnalysisConfig::parse(section(map, "analysis"))?,
            knowledge: KnowledgeConfig::parse(section(map, "knowledge"))?,
            storage: StorageConfig::parse(section(map, "storage"))?,
        })
    }

    pub fn defaults() -> Result<Self, ConfigError> {
        Self::parse(&json!({}))
    }

    pub fn to_value(&self) -> Value {
        json!({
            "transcription": self.transcription.to_value(),
            "streaming": {
                "enabled": self.streaming.enabled,
                "vad": self.streaming.vad,
                "sampleRate": self.streaming.sample_rate,
                "maxBufferedSeconds": number(self.streaming.max_buffered_seconds),
            },
            "vocabulary": {
                "preserveTechnicalTerms": self.vocabulary.preserve_technical_terms,
                "hints": self.vocabulary.hints,
            },
            "fallback": {
                "enabled": self.fallback.enabled,
                "provider": self.fallback.provider,
                "model": self.fallback.model,
            },
            "analysis": {
                "model": self.analysis.model.to_value(),
                "askModel": self.analysis.ask_model.to_value(),
                "incremental": self.analysis.incremental,
                "maxCharacters": self.analysis.max_characters,
            },
            "knowledge": {
                "mcpEnabled": self.knowledge.mcp_enabled,
                "autoApply": false,
                "requireApproval": true,
                "retrievalTTL": self.knowledge.retrieval_ttl,
                "bindings": self.knowledge.bindings.iter().map(KnowledgeBinding::to_value).collect::<Vec<_>>(),
            },
            "storage": {
                "provider": "sqlite",
                "retainAudio": false,
                "retentionDays": self.storage.retention_days,
            },
        })
    }
}

impl TranscriptionConfig {
    pub fn parse(value: &Value) -> Result<Self, ConfigError> {
        Self::parse_at(Some(value), "")
    }

    fn parse_at(value: Option<&Value>, path: &str) -> Result<Self, ConfigError> {
        let empty = Value::Object(Map::new());
        let map = object(
            value.unwrap_or(&empty),
            path,
            &[
                "provider",
                "model",
                "language",
                "task",
                "device",
                "cacheDir",
                "pythonExecutable",
                "chunkSeconds",
                "overlapSeconds",
                "requestTimeoutMs",
            ],
        )?;
        if let Some(task) = map.get("task")
            && task != "transcribe"
        {
            return Err(invalid(path, "task", "must be \"transcribe\""));
        }
        let device = text(map, path, "device", 1, usize::MAX, || Ok("auto".into()))?;
        if !["auto", "cpu", "cuda", "mps"].contains(&device.as_str()) {
            return Err(invalid(path, "device", "must be auto, cpu, cuda or mps"));
        }
        let chunk_seconds = integer(map, path, "chunkSeconds", 1, 30, 15)? as u32;
        let overlap_seconds = integer(map, path, "overlapSeconds", 0, 10, 2)? as u32;
        if overlap_seconds >= chunk_seconds {
            return Err(invalid(
                path,
                "overlapSeconds",
                "Overlap must be shorter than the chunk duration",
            ));
        }
        Ok(Self {
            provider: text(map, path, "provider", 1, usize::MAX, || {
                Ok("huggingface".into())
            })?,
            model: text(map, path, "model", 1, usize::MAX, || {
                Ok(DEFAULT_MODEL.into())
            })?,
            language: text(map, path, "language", 2, usize::MAX, || Ok("th".into()))?,
            device,
            cache_dir: text(map, path, "cacheDir", 1, usize::MAX, default_cache_dir)?,
            python_executable: text(map, path, "pythonExecutable", 1, usize::MAX, || {
                Ok("python3".into())
            })?,
            chunk_seconds,
            overlap_seconds,
            request_timeout_ms: integer(
                map,
                path,
                "requestTimeoutMs",
                1,
                20 * 60 * 1000,
                10 * 60 * 1000,
            )? as u64,
        })
    }

    pub fn with_model(&self, model: &str) -> Self {
        Self {
            model: model.into(),
            ..self.clone()
        }
    }

    pub fn to_value(&self) -> Value {
        json!({
            "provider": self.provider,
            "model": self.model,
            "language": self.language,
            "task": "transcribe",
            "device": self.device,
            "cacheDir": self.cache_dir,
            "pythonExecutable": self.python_executable,
            "chunkSeconds": self.chunk_seconds,
            "overlapSeconds": self.overlap_seconds,
            "requestTimeoutMs": self.request_timeout_ms,
        })
    }
}

impl StreamingConfig {
    fn parse(value: Option<&Value>) -> Result<Self, ConfigError> {
        let empty = Value::Object(Map::new());
        let map = object(
            value.unwrap_or(&empty),
            "streaming",
            &["enabled", "vad", "sampleRate", "maxBufferedSeconds"],
        )?;
        Ok(Self {
            enabled: boolean(map, "streaming", "enabled", true)?,
            vad: boolean(map, "streaming", "vad", true)?,
            sample_rate: integer(map, "streaming", "sampleRate", 8000, 48000, 16000)? as u32,
            max_buffered_seconds: float(map, "streaming", "maxBufferedSeconds", 30.0, 180.0, 60.0)?,
        })
    }
}

impl VocabularyConfig {
    fn parse(value: Option<&Value>) -> Result<Self, ConfigError> {
        let empty = Value::Object(Map::new());
        let map = object(
            value.unwrap_or(&empty),
            "vocabulary",
            &["preserveTechnicalTerms", "hints"],
        )?;
        let hints = match map.get("hints") {
            None => Vec::new(),
            Some(Value::Array(items)) if items.len() <= 64 => items
                .iter()
                .map(|item| match item {
                    Value::String(item) if (1..=100).contains(&units(item)) => Ok(item.clone()),
                    _ => Err(invalid(
                        "vocabulary",
                        "hints",
                        "each hint must be 1 to 100 characters",
                    )),
                })
                .collect::<Result<_, _>>()?,
            Some(_) => {
                return Err(invalid(
                    "vocabulary",
                    "hints",
                    "must be an array of at most 64 strings",
                ));
            }
        };
        Ok(Self {
            preserve_technical_terms: boolean(map, "vocabulary", "preserveTechnicalTerms", true)?,
            hints,
        })
    }
}

impl FallbackConfig {
    fn parse(value: Option<&Value>) -> Result<Self, ConfigError> {
        let empty = Value::Object(Map::new());
        let map = object(
            value.unwrap_or(&empty),
            "fallback",
            &["enabled", "provider", "model"],
        )?;
        Ok(Self {
            enabled: boolean(map, "fallback", "enabled", true)?,
            provider: nullable_text(map, "fallback", "provider")?,
            model: nullable_text(map, "fallback", "model")?,
        })
    }
}

impl AnalysisConfig {
    fn parse(value: Option<&Value>) -> Result<Self, ConfigError> {
        let empty = Value::Object(Map::new());
        let map = object(
            value.unwrap_or(&empty),
            "analysis",
            &["model", "askModel", "incremental", "maxCharacters"],
        )?;
        Ok(Self {
            model: selection(map, "model")?,
            ask_model: selection(map, "askModel")?,
            incremental: boolean(map, "analysis", "incremental", true)?,
            max_characters: integer(map, "analysis", "maxCharacters", 8000, 64000, 32000)? as u32,
        })
    }
}

impl KnowledgeConfig {
    fn parse(value: Option<&Value>) -> Result<Self, ConfigError> {
        let empty = Value::Object(Map::new());
        let map = object(
            value.unwrap_or(&empty),
            "knowledge",
            &[
                "mcpEnabled",
                "autoApply",
                "requireApproval",
                "retrievalTTL",
                "bindings",
            ],
        )?;
        if map
            .get("autoApply")
            .is_some_and(|value| value != &Value::Bool(false))
        {
            return Err(invalid("knowledge", "autoApply", "must be false"));
        }
        if map
            .get("requireApproval")
            .is_some_and(|value| value != &Value::Bool(true))
        {
            return Err(invalid("knowledge", "requireApproval", "must be true"));
        }
        let bindings = match map.get("bindings") {
            None => Vec::new(),
            Some(Value::Array(items)) if items.len() <= 4 => items
                .iter()
                .map(|item| {
                    let binding = object(
                        item,
                        "knowledge.bindings",
                        &["server", "search", "read", "write", "enabled"],
                    )?;
                    let name = |key: &str| {
                        text(binding, "knowledge.bindings", key, 1, 200, || {
                            Err(invalid("knowledge.bindings", key, "is required"))
                        })
                    };
                    Ok(KnowledgeBinding {
                        server: name("server")?,
                        search: name("search")?,
                        read: name("read")?,
                        write: match binding.get("write") {
                            None => None,
                            Some(_) => Some(name("write")?),
                        },
                        enabled: boolean(binding, "knowledge.bindings", "enabled", true)?,
                    })
                })
                .collect::<Result<_, ConfigError>>()?,
            Some(_) => {
                return Err(invalid(
                    "knowledge",
                    "bindings",
                    "must be an array of at most 4 bindings",
                ));
            }
        };
        Ok(Self {
            mcp_enabled: boolean(map, "knowledge", "mcpEnabled", true)?,
            retrieval_ttl: integer(map, "knowledge", "retrievalTTL", 0, 3_600_000, 300_000)? as u32,
            bindings,
        })
    }
}

impl StorageConfig {
    fn parse(value: Option<&Value>) -> Result<Self, ConfigError> {
        let empty = Value::Object(Map::new());
        let map = object(
            value.unwrap_or(&empty),
            "storage",
            &["provider", "retainAudio", "retentionDays"],
        )?;
        if map.get("provider").is_some_and(|value| value != "sqlite") {
            return Err(invalid("storage", "provider", "must be \"sqlite\""));
        }
        if map
            .get("retainAudio")
            .is_some_and(|value| value != &Value::Bool(false))
        {
            return Err(invalid("storage", "retainAudio", "must be false"));
        }
        let retention_days = match map.get("retentionDays") {
            None | Some(Value::Null) => None,
            Some(_) => Some(integer(map, "storage", "retentionDays", 1, 36500, 0)? as u32),
        };
        Ok(Self { retention_days })
    }
}

fn selection(map: &Map<String, Value>, key: &str) -> Result<AnalysisModel, ConfigError> {
    let path = format!("analysis.{key}");
    match map.get(key) {
        None => Ok(AnalysisModel::Inherit),
        Some(Value::String(literal)) if literal == "inherit" => Ok(AnalysisModel::Inherit),
        Some(value @ Value::Object(_)) => {
            let model = object(value, &path, &["id", "providerID", "variant", "profile"])?;
            let required = |field: &str| match model.get(field) {
                Some(Value::String(text)) if !text.is_empty() => Ok(text.clone()),
                _ => Err(invalid(&path, field, "is required and must not be empty")),
            };
            let optional = |field: &str| match model.get(field) {
                None => Ok(None),
                Some(Value::String(text)) => Ok(Some(text.clone())),
                Some(_) => Err(invalid(&path, field, "must be a string")),
            };
            Ok(AnalysisModel::Explicit {
                id: required("id")?,
                provider_id: required("providerID")?,
                variant: optional("variant")?,
                profile: optional("profile")?,
            })
        }
        Some(_) => Err(invalid(
            "analysis",
            key,
            "must be \"inherit\" or a model reference",
        )),
    }
}

fn default_cache_dir() -> Result<String, ConfigError> {
    if let Some(cache) = std::env::var_os("HF_HUB_CACHE") {
        return cache
            .into_string()
            .map_err(|_| ConfigError("HF_HUB_CACHE is not valid UTF-8".into()));
    }
    let home =
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).ok_or_else(|| {
            ConfigError("Home directory is unavailable; set transcription.cacheDir".into())
        })?;
    std::path::PathBuf::from(home)
        .join(".cache/huggingface/hub")
        .into_os_string()
        .into_string()
        .map_err(|_| ConfigError("Home directory is not valid UTF-8".into()))
}

fn section<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    map.get(key)
}

fn object<'a>(
    value: &'a Value,
    path: &str,
    allowed: &[&str],
) -> Result<&'a Map<String, Value>, ConfigError> {
    let Value::Object(map) = value else {
        return Err(ConfigError(format!(
            "{} must be an object",
            if path.is_empty() {
                "configuration"
            } else {
                path
            }
        )));
    };
    if let Some(unknown) = map.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid(path, unknown, "is not a recognized key"));
    }
    Ok(map)
}

fn invalid(path: &str, key: &str, message: &str) -> ConfigError {
    ConfigError(if path.is_empty() {
        format!("{key} {message}")
    } else {
        format!("{path}.{key} {message}")
    })
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

fn text(
    map: &Map<String, Value>,
    path: &str,
    key: &str,
    min: usize,
    max: usize,
    default: impl FnOnce() -> Result<String, ConfigError>,
) -> Result<String, ConfigError> {
    match map.get(key) {
        None => default(),
        Some(Value::String(value)) if (min..=max).contains(&units(value)) => Ok(value.clone()),
        Some(Value::String(_)) => Err(invalid(
            path,
            key,
            &format!("must be {min} to {max} characters"),
        )),
        Some(_) => Err(invalid(path, key, "must be a string")),
    }
}

fn nullable_text(
    map: &Map<String, Value>,
    path: &str,
    key: &str,
) -> Result<Option<String>, ConfigError> {
    match map.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(invalid(path, key, "must be a string or null")),
    }
}

fn boolean(
    map: &Map<String, Value>,
    path: &str,
    key: &str,
    default: bool,
) -> Result<bool, ConfigError> {
    match map.get(key) {
        None => Ok(default),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(invalid(path, key, "must be a boolean")),
    }
}

fn float(
    map: &Map<String, Value>,
    path: &str,
    key: &str,
    min: f64,
    max: f64,
    default: f64,
) -> Result<f64, ConfigError> {
    match map.get(key) {
        None => Ok(default),
        Some(Value::Number(value)) => value
            .as_f64()
            .filter(|value| value.is_finite() && (min..=max).contains(value))
            .ok_or_else(|| invalid(path, key, &format!("must be between {min} and {max}"))),
        Some(_) => Err(invalid(path, key, "must be a number")),
    }
}

fn integer(
    map: &Map<String, Value>,
    path: &str,
    key: &str,
    min: i64,
    max: i64,
    default: i64,
) -> Result<i64, ConfigError> {
    let Some(value) = map.get(key) else {
        return Ok(default);
    };
    let Value::Number(number) = value else {
        return Err(invalid(path, key, "must be an integer"));
    };
    number
        .as_f64()
        .filter(|value| value.fract() == 0.0 && (min as f64..=max as f64).contains(value))
        .map(|value| value as i64)
        .ok_or_else(|| {
            invalid(
                path,
                key,
                &format!("must be an integer between {min} and {max}"),
            )
        })
}

pub(crate) fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        return Value::from(value as i64);
    }
    Value::from(value)
}
