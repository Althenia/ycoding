use super::{Configuration, jsonc};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicU64, Ordering},
    },
};
use ycoding_schema::{DomainEncode, JsonObject, JsonValue, LosslessString, mcp};

pub const ENDPOINT_PACKAGES: [&str; 2] = [
    "aisdk:@ai-sdk/openai-compatible",
    "@ycoding-ai/ai/providers/runpod",
];

pub fn is_native_endpoint_package(value: &JsonValue) -> bool {
    matches!(value, JsonValue::String(package) if package.as_str().is_some_and(|package| ENDPOINT_PACKAGES.contains(&package)))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Global,
    Project,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub scope: Scope,
    pub path: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteError {
    InvalidConfig,
    ScopeNotAllowed,
    ProviderCollision,
    WriteFailed,
}

pub enum Mutation<'a> {
    Configuration(&'a Target),
    FrontendPackage(&'a str),
}

#[derive(Clone)]
pub struct MutationPolicy(pub Arc<dyn Fn(Mutation<'_>) -> bool + Send + Sync>);

impl std::fmt::Debug for MutationPolicy {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("MutationPolicy")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndpointApi {
    Chat,
    Responses,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndpointWorker {
    Ollama,
    Vllm,
}
#[derive(Clone, Debug)]
pub enum Endpoint {
    OpenAi {
        base_url: String,
        api: EndpointApi,
    },
    Runpod {
        base_url: String,
        worker: EndpointWorker,
    },
}

#[derive(Clone, Debug)]
pub struct EndpointModel {
    pub id: LosslessString,
    pub model_id: Option<LosslessString>,
    pub name: Option<LosslessString>,
    pub family: Option<LosslessString>,
    pub api: Option<EndpointApi>,
    pub disabled: Option<bool>,
    pub tools: Option<bool>,
}

#[derive(Clone, Debug)]
pub struct ProviderConfiguration {
    pub provider_id: LosslessString,
    pub endpoint: Endpoint,
    pub catalog: bool,
    pub models: Option<Vec<EndpointModel>>,
}

impl ProviderConfiguration {
    pub fn package(&self) -> &'static str {
        match self.endpoint {
            Endpoint::OpenAi { .. } => ENDPOINT_PACKAGES[0],
            Endpoint::Runpod { .. } => ENDPOINT_PACKAGES[1],
        }
    }

    pub fn validate(&self) -> Result<(), WriteError> {
        identifier(&self.provider_id, 128)?;
        let base = match &self.endpoint {
            Endpoint::OpenAi { base_url, .. } | Endpoint::Runpod { base_url, .. } => base_url,
        };
        if base.encode_utf16().count() > 8192 {
            return Err(WriteError::InvalidConfig);
        }
        let url = url::Url::parse(base).map_err(|_| WriteError::InvalidConfig)?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query_pairs().any(|(key, _)| {
                let key = key.to_ascii_lowercase().replace(['-', '_'], "");
                [
                    "key",
                    "apikey",
                    "token",
                    "accesstoken",
                    "secret",
                    "password",
                    "authorization",
                    "credential",
                ]
                .iter()
                .any(|secret| key.contains(secret))
            })
            || url.fragment().is_some()
        {
            return Err(WriteError::InvalidConfig);
        }
        if matches!(self.endpoint, Endpoint::Runpod { .. }) {
            let id = base
                .strip_prefix("https://api.runpod.ai/v2/")
                .ok_or(WriteError::InvalidConfig)?;
            if id.is_empty()
                || !id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                || self.catalog
            {
                return Err(WriteError::InvalidConfig);
            }
        }
        let models = self.models.as_deref().unwrap_or_default();
        if models.len() > 256 {
            return Err(WriteError::InvalidConfig);
        }
        for (index, model) in models.iter().enumerate() {
            identifier(&model.id, 128)?;
            if models[..index]
                .iter()
                .any(|previous| previous.id == model.id)
            {
                return Err(WriteError::InvalidConfig);
            }
            for (value, max) in [
                (&model.model_id, 256),
                (&model.name, 256),
                (&model.family, 128),
            ] {
                if let Some(value) = value
                    && (value.is_empty() || value.code_units().count() > max)
                {
                    return Err(WriteError::InvalidConfig);
                }
            }
        }
        Ok(())
    }
}

impl Configuration {
    pub fn with_mutation_policy(mut self, policy: MutationPolicy) -> Self {
        self.mutation_policy = Some(policy);
        self
    }

    pub fn allows_mutation(&self, mutation: Mutation<'_>) -> bool {
        self.mutation_policy
            .as_ref()
            .is_some_and(|policy| (policy.0)(mutation))
    }

    pub fn write_provider(
        &self,
        scope: Scope,
        input: &ProviderConfiguration,
    ) -> Result<Target, WriteError> {
        input.validate()?;
        self.write(scope, false, |text| {
            let current = jsonc::parse(text.trim_start_matches('\u{feff}'))
                .map_err(|_| WriteError::InvalidConfig)?;
            let providers = record(&current, "providers")?;
            let existing = record(
                &providers,
                &input
                    .provider_id
                    .to_utf8()
                    .map_err(|_| WriteError::InvalidConfig)?,
            )?;
            if let Some(package) = field(&existing, "package")
                && package != &JsonValue::String(input.package().into())
            {
                return Err(WriteError::ProviderCollision);
            }
            record(&existing, "settings")?;
            let models = record(&existing, "models")?;
            if input.catalog {
                record(&existing, "catalog")?;
            }
            for model in input.models.as_deref().unwrap_or_default() {
                let existing = record(
                    &models,
                    &model.id.to_utf8().map_err(|_| WriteError::InvalidConfig)?,
                )?;
                if model.tools.is_some() {
                    record(&existing, "capabilities")?;
                }
            }
            let id = input
                .provider_id
                .to_utf8()
                .map_err(|_| WriteError::InvalidConfig)?;
            let mut changes = vec![(
                vec!["providers".to_owned(), id.clone(), "package".into()],
                JsonValue::String(input.package().into()),
            )];
            match &input.endpoint {
                Endpoint::OpenAi { base_url, api } => {
                    changes.push((
                        vec![
                            "providers".into(),
                            id.clone(),
                            "settings".into(),
                            "baseURL".into(),
                        ],
                        base_url.encode(),
                    ));
                    changes.push((
                        vec![
                            "providers".into(),
                            id.clone(),
                            "settings".into(),
                            "api".into(),
                        ],
                        api_text(*api).encode(),
                    ));
                    if input.catalog {
                        changes.push((
                            vec![
                                "providers".into(),
                                id.clone(),
                                "catalog".into(),
                                "source".into(),
                            ],
                            "openai-models".encode(),
                        ));
                    }
                }
                Endpoint::Runpod { base_url, worker } => {
                    changes.push((
                        vec![
                            "providers".into(),
                            id.clone(),
                            "settings".into(),
                            "baseURL".into(),
                        ],
                        base_url.encode(),
                    ));
                    changes.push((
                        vec![
                            "providers".into(),
                            id.clone(),
                            "settings".into(),
                            "worker".into(),
                        ],
                        match worker {
                            EndpointWorker::Ollama => "ollama",
                            EndpointWorker::Vllm => "vllm",
                        }
                        .encode(),
                    ));
                }
            }
            for model in input.models.as_deref().unwrap_or_default() {
                let model_id = model.id.to_utf8().map_err(|_| WriteError::InvalidConfig)?;
                let path = vec!["providers".into(), id.clone(), "models".into(), model_id];
                if field(
                    &models,
                    &model.id.to_utf8().map_err(|_| WriteError::InvalidConfig)?,
                )
                .is_none()
                {
                    changes.push((path.clone(), JsonValue::Object(JsonObject::new())));
                }
                for (name, value) in [
                    ("modelID", model.model_id.as_ref()),
                    ("name", model.name.as_ref()),
                    ("family", model.family.as_ref()),
                ] {
                    if let Some(value) = value {
                        let mut path = path.clone();
                        path.push(name.into());
                        changes.push((path, value.encode()));
                    }
                }
                for (name, value) in [
                    ("api", model.api.map(|api| api_text(api).encode())),
                    ("disabled", model.disabled.map(JsonValue::Bool)),
                ] {
                    if let Some(value) = value {
                        let mut path = path.clone();
                        path.push(name.into());
                        changes.push((path, value));
                    }
                }
                if let Some(tools) = model.tools {
                    let mut path = path;
                    path.extend(["capabilities".into(), "tools".into()]);
                    changes.push((path, JsonValue::Bool(tools)));
                }
            }
            changes
                .into_iter()
                .try_fold(text.to_owned(), |text, (path, value)| {
                    jsonc::modify(&text, &path, &value).map_err(|_| WriteError::InvalidConfig)
                })
        })
    }

    pub fn write_mcp(
        &self,
        scope: Scope,
        name: &LosslessString,
        input: &mcp::ServerConfig,
    ) -> Result<Target, WriteError> {
        identifier(name, 128)?;
        let scalar = name.to_utf8().map_err(|_| WriteError::InvalidConfig)?;
        match input {
            mcp::ServerConfig::Local(config)
                if config.command.is_empty() || config.command[0].is_empty() =>
            {
                return Err(WriteError::InvalidConfig);
            }
            mcp::ServerConfig::Remote(config) => {
                let url = config
                    .url
                    .to_utf8()
                    .map_err(|_| WriteError::InvalidConfig)?;
                let url = url::Url::parse(&url).map_err(|_| WriteError::InvalidConfig)?;
                if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
                    return Err(WriteError::InvalidConfig);
                }
            }
            _ => (),
        }
        self.write(scope, true, |text| {
            jsonc::modify(
                text,
                &["mcp".into(), "servers".into(), scalar.clone()],
                &input.encode(),
            )
            .map_err(|_| WriteError::InvalidConfig)
        })
    }

    fn write(
        &self,
        scope: Scope,
        mcp: bool,
        edit: impl FnOnce(&str) -> Result<String, WriteError>,
    ) -> Result<Target, WriteError> {
        if scope == Scope::Project && !self.options.project {
            return Err(WriteError::ScopeNotAllowed);
        }
        let directory = match scope {
            Scope::Global => &self.options.roots.config,
            Scope::Project => &self.options.directory,
        };
        let directory =
            super::roots::absolute(directory).map_err(|_| WriteError::ScopeNotAllowed)?;
        self.options
            .roots
            .check(&directory)
            .map_err(|_| WriteError::ScopeNotAllowed)?;
        let candidates = [
            "ycoding.json",
            "ycoding.jsonc",
            ".ycoding/ycoding.json",
            ".ycoding/ycoding.jsonc",
        ];
        let path = candidates[..if mcp { 4 } else { 2 }]
            .iter()
            .map(|file| directory.join(file))
            .find(|path| if mcp { path.is_file() } else { path.exists() })
            .unwrap_or_else(|| directory.join(candidates[0]));
        self.options
            .roots
            .check(&path)
            .map_err(|_| WriteError::ScopeNotAllowed)?;
        let target = Target { scope, path };
        let lock = target_lock(&target.path)?;
        let _guard = lock.lock().map_err(|_| WriteError::WriteFailed)?;
        if !self.allows_mutation(Mutation::Configuration(&target)) {
            return Err(WriteError::ScopeNotAllowed);
        }
        let text = match fs::read_to_string(&target.path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => "{}\n".into(),
            Err(_) => return Err(WriteError::WriteFailed),
        };
        let updated = edit(&text)?;
        atomic(&target.path, updated.as_bytes()).map_err(|_| WriteError::WriteFailed)?;
        Ok(target)
    }
}

pub(crate) fn target_lock(path: &Path) -> Result<Arc<Mutex<()>>, WriteError> {
    static LOCKS: OnceLock<Mutex<BTreeMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();
    let key = if path.exists() {
        fs::canonicalize(path).map_err(|_| WriteError::WriteFailed)?
    } else {
        path.to_path_buf()
    };
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| WriteError::WriteFailed)?;
    locks.retain(|_, value| value.strong_count() > 0);
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    Ok(lock)
}

pub(crate) fn atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("Missing parent"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".config-{}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        if let Ok(metadata) = fs::metadata(path) {
            file.set_permissions(metadata.permissions())?;
        }
        file.write_all(bytes)?;
        file.sync_all()?;
        crate::resources::project_artifact::filesystem::execute_mutation(
            crate::resources::project_artifact::filesystem::MutationRequest::Rename {
                source_root: parent,
                destination_root: parent,
                source: &temporary,
                destination: path,
                replace: true,
            },
            &crate::resources::project_artifact::filesystem::Hooks::default(),
        )
        .map_err(std::io::Error::other)?;
        Ok(())
    })();
    if temporary.exists() {
        fs::remove_file(temporary)?;
    }
    result
}

fn identifier(value: &LosslessString, maximum: usize) -> Result<(), WriteError> {
    let text = value.to_utf8().map_err(|_| WriteError::InvalidConfig)?;
    if text.is_empty()
        || value.code_units().count() > maximum
        || text.trim() != text
        || text.chars().any(char::is_control)
    {
        return Err(WriteError::InvalidConfig);
    }
    Ok(())
}

fn api_text(api: EndpointApi) -> &'static str {
    match api {
        EndpointApi::Chat => "chat",
        EndpointApi::Responses => "responses",
    }
}
fn field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(&key.into()),
        _ => None,
    }
}
fn record(value: &JsonValue, key: &str) -> Result<JsonValue, WriteError> {
    if !matches!(value, JsonValue::Object(_)) {
        return Err(WriteError::InvalidConfig);
    }
    match field(value, key) {
        None => Ok(JsonValue::Object(JsonObject::new())),
        Some(value @ JsonValue::Object(_)) => Ok(value.clone()),
        _ => Err(WriteError::InvalidConfig),
    }
}
