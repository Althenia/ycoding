use super::{
    discovery::SYSTEM_CONFIG_PATH,
    encoding::ascii_lower,
    error::ExecutorError,
    policy::{self, SEP},
    toml::{
        TomlParseError, TomlTable, TomlValue, env_keys_match, merge_toml, parse_toml, project_toml,
        project_toml_selectors, stringify_toml,
    },
    value::{JsonObject, LosslessString, Value, concat, os_text, trim},
};
use std::{collections::HashMap, io, path::PathBuf, sync::Arc};

pub const SYSTEM_REQUIREMENTS_PATH: &str = "/etc/codex/requirements.toml";
pub const MANAGED_CONFIG_PATH: &str = "/etc/codex/managed_config.toml";

const CONFIG_TOML_FILE: &str = "config.toml";
const MAX_GIT_METADATA_FILE_BYTES: u64 = 64 * 1024;
const PROJECT_LOCAL_CONFIG_DENYLIST: [&str; 12] = [
    "openai_base_url",
    "chatgpt_base_url",
    "apps_mcp_product_sku",
    "responses_api_metadata",
    "model_provider",
    "model_providers",
    "notify",
    "profile",
    "profiles",
    "experimental_realtime_webrtc_call_base_url",
    "experimental_realtime_ws_base_url",
    "otel",
];
const CREDENTIAL_BROKER_PROVIDER_ENV_KEYS: [&str; 7] = [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GH_HOST",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
];
const BROKER_REQUIREMENT_PATHS: [[&str; 2]; 5] = [
    ["features", "network_proxy"],
    ["features", "credential_masking"],
    ["feature_requirements", "network_proxy"],
    ["feature_requirements", "credential_masking"],
    ["experimental_network", "enabled"],
];
const GRANULAR_FIELDS: [(&str, bool); 5] = [
    ("sandbox_approval", true),
    ("rules", true),
    ("skill_approval", false),
    ("request_permissions", false),
    ("mcp_elicitations", true),
];

#[derive(Clone, Debug)]
pub struct EnvironmentConfigReadParams {
    pub cwd: String,
    pub config_paths: Vec<Vec<LosslessString>>,
    pub requirements_paths: Vec<Vec<LosslessString>>,
}

#[derive(Clone, Default)]
pub struct EnvironmentConfigOptions {
    pub home_directory: PathBuf,
    pub codex_home_env: Option<String>,
    pub system_config_path: Option<PathBuf>,
    pub system_requirements_path: Option<PathBuf>,
    pub managed_config_path: Option<PathBuf>,
    pub hostname: Option<Arc<dyn Fn() -> String + Send + Sync>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnvironmentConfigLayer {
    pub source: String,
    pub base_dir: String,
    pub toml: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnvironmentConfigLayerStack {
    pub layers: Vec<EnvironmentConfigLayer>,
    pub cloud_insertion_index: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnvironmentConfigReadResult {
    pub user_home_dir: Option<String>,
    pub codex_home_dir: String,
    pub hostname: Option<String>,
    pub config: EnvironmentConfigLayerStack,
    pub requirements: EnvironmentConfigLayerStack,
}

fn text_value(text: &str) -> Value {
    Value::String(LosslessString::from(text))
}

fn optional_text_value(text: &Option<String>) -> Value {
    text.as_deref().map_or(Value::Null, text_value)
}

fn object(fields: Vec<(&str, Value)>) -> Value {
    let mut object = JsonObject::new();
    for (key, value) in fields {
        object.insert(LosslessString::from(key), value);
    }
    Value::Object(object)
}

impl EnvironmentConfigLayerStack {
    fn to_json(&self) -> Value {
        let layers = self
            .layers
            .iter()
            .map(|layer| {
                object(vec![
                    ("source", text_value(&layer.source)),
                    ("baseDir", text_value(&layer.base_dir)),
                    ("toml", text_value(&layer.toml)),
                ])
            })
            .collect();
        object(vec![
            ("layers", Value::Array(layers)),
            (
                "cloudInsertionIndex",
                Value::Number(self.cloud_insertion_index as f64),
            ),
        ])
    }
}

impl EnvironmentConfigReadResult {
    pub fn to_json(&self) -> Value {
        object(vec![
            ("userHomeDir", optional_text_value(&self.user_home_dir)),
            ("codexHomeDir", text_value(&self.codex_home_dir)),
            ("hostname", optional_text_value(&self.hostname)),
            ("config", self.config.to_json()),
            ("requirements", self.requirements.to_json()),
        ])
    }
}

struct LoadError(LosslessString);

impl LoadError {
    fn text(message: impl Into<String>) -> Self {
        Self(LosslessString::from(message.into()))
    }
    fn with_detail(prefix: String, detail: &LosslessString) -> Self {
        Self(concat(&[&LosslessString::from(prefix), detail]))
    }
}

type Load<T> = Result<T, LoadError>;

struct Layer {
    source: String,
    base_dir: String,
    toml: TomlValue,
}

struct Stack {
    layers: Vec<Layer>,
    cloud_insertion_index: usize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Trust {
    Trusted,
    Untrusted,
}

fn io_message(error: &io::Error) -> String {
    match error.kind() {
        io::ErrorKind::NotFound => "No such file or directory (os error 2)".to_owned(),
        io::ErrorKind::PermissionDenied => "Permission denied (os error 13)".to_owned(),
        io::ErrorKind::IsADirectory => "Is a directory (os error 21)".to_owned(),
        io::ErrorKind::NotADirectory => "Not a directory (os error 20)".to_owned(),
        _ => error.to_string(),
    }
}

fn table(value: Option<&TomlValue>) -> Option<&TomlTable> {
    value.and_then(TomlValue::as_table)
}

fn text_array(values: &[&str]) -> TomlValue {
    TomlValue::Array(
        values
            .iter()
            .map(|value| TomlValue::String((*value).to_owned()))
            .collect(),
    )
}

async fn read_text(file: &str) -> io::Result<Option<String>> {
    match tokio::fs::read(file).await {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn parse_file(file: &str, contents: &str) -> Load<TomlTable> {
    parse_toml(contents).map_err(|error: TomlParseError| {
        LoadError::with_detail(
            format!("{file}:{}:{}: ", error.line, error.column),
            &error.detail,
        )
    })
}

async fn required_layer(file: &str) -> Load<TomlTable> {
    let contents = read_text(file).await.map_err(|error| {
        LoadError::text(format!(
            "Failed to read config file {file}: {}",
            io_message(&error)
        ))
    })?;
    match contents {
        None => Ok(TomlTable::new()),
        Some(contents) => parse_file(file, &contents),
    }
}

async fn is_directory(file: &str) -> bool {
    tokio::fs::metadata(file)
        .await
        .map(|info| info.is_dir())
        .unwrap_or(false)
}

async fn exists(file: &str) -> bool {
    tokio::fs::metadata(file).await.is_ok()
}

async fn canonical(file: &str) -> String {
    policy::real_path(file)
        .await
        .unwrap_or_else(|_| file.to_owned())
}

async fn canonical_or_none(file: &str) -> Option<String> {
    policy::real_path(file).await.ok()
}

fn home_join(base: &str, part: &str) -> String {
    if base.is_empty() {
        policy::normalize(part)
    } else {
        policy::join(base, &[part])
    }
}

fn parent(dir: &str) -> Option<String> {
    let up = policy::dirname(dir);
    if up == dir { None } else { Some(up) }
}

fn relative(from: &str, to: &str) -> String {
    let from = policy::normalize(from);
    let to = policy::normalize(to);
    if from == to {
        return String::new();
    }
    if policy::root_of(&from) != policy::root_of(&to) {
        return to;
    }
    let split = |path: &str| -> Vec<String> {
        path[policy::root_of(path).len()..]
            .split(policy::is_sep)
            .filter(|segment| !segment.is_empty())
            .map(str::to_owned)
            .collect()
    };
    let from_parts = split(&from);
    let to_parts = split(&to);
    let common = from_parts
        .iter()
        .zip(&to_parts)
        .take_while(|(left, right)| left == right)
        .count();
    let mut parts: Vec<String> = vec!["..".to_owned(); from_parts.len() - common];
    parts.extend(to_parts[common..].iter().cloned());
    parts.join(&SEP.to_string())
}

fn project_root_markers(config: &TomlTable) -> Load<Vec<String>> {
    let Some(markers) = config.get("project_root_markers") else {
        return Ok(vec![".git".to_owned()]);
    };
    let invalid = || LoadError::text("project_root_markers must be an array of strings");
    let TomlValue::Array(items) = markers else {
        return Err(invalid());
    };
    items
        .iter()
        .map(|item| match item {
            TomlValue::String(text) => Ok(text.clone()),
            _ => Err(invalid()),
        })
        .collect()
}

fn projects_trust(config: &TomlTable) -> Load<HashMap<String, Trust>> {
    let mut out = HashMap::new();
    let Some(projects) = config.get("projects") else {
        return Ok(out);
    };
    let TomlValue::Table(projects) = projects else {
        return Err(LoadError::text("invalid type: projects, expected a map"));
    };
    for (key, project) in &projects.entries {
        let TomlValue::Table(project) = project else {
            return Err(LoadError::text(format!(
                "invalid type: projects.{key}, expected a map"
            )));
        };
        let Some(level) = project.get("trust_level") else {
            continue;
        };
        let trust = match level {
            TomlValue::String(text) if text == "trusted" => Trust::Trusted,
            TomlValue::String(text) if text == "untrusted" => Trust::Untrusted,
            _ => {
                return Err(LoadError::text(format!(
                    "unknown variant for projects.{key}.trust_level, expected `trusted` or `untrusted`"
                )));
            }
        };
        out.insert(key.clone(), trust);
    }
    Ok(out)
}

async fn trust_keys(dir: &str) -> Vec<String> {
    let resolved = canonical(dir).await;
    if resolved == dir {
        vec![dir.to_owned()]
    } else {
        vec![resolved, dir.to_owned()]
    }
}

async fn git_marker(dir: &str) -> bool {
    let marker = policy::join(dir, &[".git"]);
    let Ok(info) = tokio::fs::metadata(&marker).await else {
        return false;
    };
    !info.is_dir() || exists(&policy::join(&marker, &["HEAD"])).await
}

async fn discover_project_root(cwd: &str, markers: &[String]) -> Option<String> {
    if markers.is_empty() {
        return None;
    }
    for ancestor in policy::ancestors(cwd) {
        for marker in markers {
            let found = if marker == ".git" {
                git_marker(&ancestor).await
            } else {
                exists(&policy::join(&ancestor, &[marker.as_str()])).await
            };
            if found {
                return Some(ancestor);
            }
        }
    }
    None
}

async fn git_checkout_root(cwd: &str) -> Option<String> {
    let base = if is_directory(cwd).await {
        cwd.to_owned()
    } else {
        policy::dirname(cwd)
    };
    for dir in policy::ancestors(&base) {
        if git_marker(&dir).await {
            return Some(dir);
        }
    }
    None
}

struct Meta {
    is_directory: bool,
    is_file: bool,
    is_symlink: bool,
    size: u64,
}

async fn metadata(file: &str) -> Option<Meta> {
    let info = tokio::fs::metadata(file).await.ok()?;
    let link = tokio::fs::symlink_metadata(file).await.ok();
    Some(Meta {
        is_directory: info.is_dir(),
        is_file: info.is_file(),
        is_symlink: link.is_some_and(|link| link.file_type().is_symlink()),
        size: info.len(),
    })
}

fn trim_ascii(text: &str) -> &str {
    text.trim_matches(|character| matches!(character, '\t' | '\n' | '\u{c}' | '\r' | ' '))
}

async fn read_git_metadata_file(file: &str) -> Option<String> {
    let info = metadata(file).await?;
    if !info.is_file || info.is_symlink || info.size > MAX_GIT_METADATA_FILE_BYTES {
        return None;
    }
    let bytes = tokio::fs::read(file).await.ok()?;
    if bytes.len() as u64 > MAX_GIT_METADATA_FILE_BYTES {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

async fn read_gitdir_file(file: &str) -> Option<String> {
    let contents = read_git_metadata_file(file).await.unwrap_or_default();
    let contents = trim_ascii(&contents);
    let target = trim_ascii(contents.strip_prefix("gitdir:")?);
    if target.is_empty() {
        return None;
    }
    Some(policy::resolve(&policy::dirname(file), target))
}

async fn git_repo_root(cwd: &str) -> Option<String> {
    let mut base: Option<String> = if metadata(cwd).await.is_some_and(|info| info.is_directory) {
        Some(cwd.to_owned())
    } else {
        parent(cwd)
    };
    let repo_root: String;
    loop {
        let current = base.clone()?;
        let mut candidate: Option<String> = None;
        for dir in policy::ancestors(&current) {
            if metadata(&policy::join(&dir, &[".git"])).await.is_some() {
                candidate = Some(dir);
                break;
            }
        }
        let candidate = candidate?;
        let dot_git = metadata(&policy::join(&candidate, &[".git"])).await?;
        if !dot_git.is_directory
            || metadata(&policy::join(&candidate, &[".git", "HEAD"]))
                .await
                .is_some()
        {
            repo_root = candidate;
            break;
        }
        base = parent(&candidate);
    }
    let dot_git_path = policy::join(&repo_root, &[".git"]);
    let dot_git = metadata(&dot_git_path).await?;
    if dot_git.is_directory {
        return Some(repo_root);
    }
    if !dot_git.is_file || dot_git.is_symlink || dot_git.size > MAX_GIT_METADATA_FILE_BYTES {
        return None;
    }
    let git_dir = read_gitdir_file(&dot_git_path).await?;
    let git_dir_info = metadata(&git_dir).await?;
    if !git_dir_info.is_directory || git_dir_info.is_symlink {
        return None;
    }
    let canonical_git_dir = canonical_or_none(&git_dir).await?;
    if policy::basename(&policy::dirname(&canonical_git_dir)) != "worktrees" {
        return None;
    }
    let common_dir = policy::dirname(&policy::dirname(&canonical_git_dir));
    let worktree_gitdir =
        read_git_metadata_file(&policy::join(&canonical_git_dir, &["gitdir"])).await;
    let commondir = read_git_metadata_file(&policy::join(&canonical_git_dir, &["commondir"])).await;
    let registered_dot_git = trim_ascii(worktree_gitdir.as_deref().unwrap_or("")).to_owned();
    let linked_common = trim_ascii(commondir.as_deref().unwrap_or("")).to_owned();
    if registered_dot_git.is_empty() || linked_common.is_empty() {
        return None;
    }
    let worktree_dot_git = policy::resolve(&canonical_git_dir, &registered_dot_git);
    if policy::basename(&worktree_dot_git) != ".git" {
        return None;
    }
    let registered_checkout = canonical_or_none(&policy::dirname(&worktree_dot_git)).await;
    let checkout = canonical_or_none(&repo_root).await;
    let linked_common_dir =
        canonical_or_none(&policy::resolve(&canonical_git_dir, &linked_common)).await;
    if registered_checkout.is_none()
        || registered_checkout != checkout
        || linked_common_dir.as_deref() != Some(common_dir.as_str())
    {
        return None;
    }
    let main_root = policy::dirname(&policy::dirname(&policy::dirname(&git_dir)));
    let main_dot_git = policy::join(&main_root, &[".git"]);
    let main_info = metadata(&main_dot_git).await?;
    let main_git_dir = if main_info.is_directory {
        Some(main_dot_git)
    } else {
        read_gitdir_file(&main_dot_git).await
    };
    let main_git_dir = main_git_dir?;
    if canonical_or_none(&main_git_dir).await.as_deref() != Some(common_dir.as_str()) {
        return None;
    }
    Some(main_root)
}

fn hooks_folder_for_dir(dir: &str, checkout: Option<&str>, repo: Option<&str>) -> Option<String> {
    let (checkout, repo) = (checkout?, repo?);
    if checkout == repo {
        return None;
    }
    let path = relative(checkout, dir);
    if path == ".." || path.starts_with(&format!("..{SEP}")) || policy::is_absolute(&path) {
        return None;
    }
    Some(policy::join(repo, &[path.as_str(), ".codex"]))
}

fn lookup(trust: &HashMap<String, Trust>, keys: &[String]) -> Option<Trust> {
    keys.iter().find_map(|key| trust.get(key).copied())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BrokerState {
    Unconfigured,
    Disabled,
    Enabled,
}

struct Broker {
    state: BrokerState,
    provider_env_keys: Vec<String>,
}

enum Change {
    Keep,
    Remove,
    Replace(TomlTable),
}

fn rebuilt_tui(out: &TomlTable) -> Option<TomlTable> {
    let tui = table(out.get("tui"))?;
    let keymap = table(tui.get("keymap"))?;
    let chat = table(keymap.get("chat"))?;
    let mut next_chat = chat.clone();
    next_chat.remove("previous_permission_mode");
    next_chat.remove("next_permission_mode");
    let mut next_keymap = keymap.clone();
    next_keymap.insert("chat".to_owned(), TomlValue::Table(next_chat));
    let mut next_tui = tui.clone();
    next_tui.insert("keymap".to_owned(), TomlValue::Table(next_keymap));
    Some(next_tui)
}

fn sanitize_project_config(config: TomlTable, broker: &Broker) -> TomlTable {
    let mut out = config;
    for key in PROJECT_LOCAL_CONFIG_DENYLIST {
        out.remove(key);
    }
    let configured = broker.state != BrokerState::Unconfigured;
    let next_features = table(out.get("features")).map(|features| {
        let mut next = features.clone();
        if broker.state == BrokerState::Enabled {
            next.remove("shell_snapshot");
        }
        let multi_agent = table(next.get("multi_agent_v2"))
            .filter(|multi| multi.contains_key("message_board_remote"))
            .map(|multi| {
                let mut replaced = multi.clone();
                replaced.remove("message_board_remote");
                replaced
            });
        if let Some(replaced) = multi_agent {
            next.insert("multi_agent_v2".to_owned(), TomlValue::Table(replaced));
        }
        for key in [
            "respect_system_proxy",
            "system_proxy_fallback",
            "credential_masking",
        ] {
            next.remove(key);
        }
        let change = match next.get("network_proxy") {
            Some(TomlValue::Boolean(_)) if configured => Change::Remove,
            Some(TomlValue::Table(proxy)) => {
                let mut replaced = proxy.clone();
                replaced.remove("credential_broker");
                replaced.remove("credentials");
                if configured {
                    replaced.remove("enabled");
                }
                Change::Replace(replaced)
            }
            _ => Change::Keep,
        };
        match change {
            Change::Remove => {
                next.remove("network_proxy");
            }
            Change::Replace(replaced) => {
                next.insert("network_proxy".to_owned(), TomlValue::Table(replaced))
            }
            Change::Keep => {}
        }
        next
    });
    if let Some(next) = next_features {
        out.insert("features".to_owned(), TomlValue::Table(next));
    }
    if broker.state == BrokerState::Enabled {
        let next_policy = table(out.get("shell_environment_policy")).map(|policy| {
            let mut next = policy.clone();
            next.remove("experimental_use_profile");
            let injected = |key: &str| {
                ascii_lower(key) == "zdotdir"
                    || ascii_lower(key) == "bash_env"
                    || CREDENTIAL_BROKER_PROVIDER_ENV_KEYS
                        .iter()
                        .any(|candidate| env_keys_match(key, candidate))
                    || broker
                        .provider_env_keys
                        .iter()
                        .any(|candidate| env_keys_match(key, candidate))
            };
            let filtered = table(next.get("set")).map(|overrides| {
                TomlTable::from_entries(
                    overrides
                        .entries
                        .iter()
                        .filter(|(key, _)| !injected(key))
                        .map(|(key, value)| (key.clone(), value.clone())),
                )
            });
            if let Some(filtered) = filtered {
                next.insert("set".to_owned(), TomlValue::Table(filtered));
            }
            next
        });
        if let Some(next) = next_policy {
            out.insert(
                "shell_environment_policy".to_owned(),
                TomlValue::Table(next),
            );
        }
    }
    if let Some(next_tui) = rebuilt_tui(&out) {
        out.insert("tui".to_owned(), TomlValue::Table(next_tui));
    }
    out
}

fn credential_broker(config: &TomlTable) -> Broker {
    let network_proxy =
        table(table(config.get("features")).and_then(|features| features.get("network_proxy")));
    let broker = network_proxy.and_then(|proxy| proxy.get("credential_broker"));
    let enabled = network_proxy.and_then(|proxy| proxy.get("enabled"));
    let state = match broker {
        Some(TomlValue::Boolean(true)) => match enabled {
            Some(TomlValue::Boolean(true)) => BrokerState::Enabled,
            _ => BrokerState::Disabled,
        },
        _ => BrokerState::Unconfigured,
    };
    let mut provider_env_keys = Vec::new();
    if let Some(credentials) = table(network_proxy.and_then(|proxy| proxy.get("credentials"))) {
        for (_, provider) in &credentials.entries {
            let TomlValue::Table(provider) = provider else {
                continue;
            };
            if let Some(TomlValue::Array(items)) = provider.get("env") {
                for item in items {
                    if let TomlValue::String(text) = item {
                        provider_env_keys.push(text.clone());
                    }
                }
            }
            if let Some(TomlValue::String(text)) = provider.get("url_prefix_from_env") {
                provider_env_keys.push(text.clone());
            }
        }
    }
    Broker {
        state,
        provider_env_keys,
    }
}

struct BrokerRequirements {
    features: HashMap<String, bool>,
    network_enabled: Option<bool>,
}

fn broker_requirements(layers: &[Layer]) -> Load<BrokerRequirements> {
    let paths: Vec<Vec<String>> = BROKER_REQUIREMENT_PATHS
        .iter()
        .map(|path| path.iter().map(|segment| (*segment).to_owned()).collect())
        .collect();
    let mut merged = TomlTable::new();
    for layer in layers {
        let Some(Ok(projected)) = project_toml(&layer.toml, &paths).map(TomlValue::take_table)
        else {
            continue;
        };
        let fail = |message: String| {
            LoadError::text(format!(
                "failed to parse requirements layer {}: {message}",
                layer.source
            ))
        };
        if projected.contains_key("features") && projected.contains_key("feature_requirements") {
            return Err(fail("duplicate field `features`".to_owned()));
        }
        let mut regular = projected;
        if let Some(aliased) = regular.remove("feature_requirements") {
            regular.insert("features".to_owned(), aliased);
        }
        match regular.get("features") {
            Some(TomlValue::Table(features)) => {
                for (key, value) in &features.entries {
                    if !matches!(value, TomlValue::Boolean(_)) {
                        return Err(fail(format!(
                            "invalid type: {}, expected a boolean for key `features.{key}`",
                            value.kind()
                        )));
                    }
                }
            }
            Some(other) => {
                return Err(fail(format!(
                    "invalid type: {}, expected a map for key `features`",
                    other.kind()
                )));
            }
            None => {}
        }
        match regular.get("experimental_network") {
            Some(TomlValue::Table(network)) => {
                if let Some(enabled) = network.get("enabled")
                    && !matches!(enabled, TomlValue::Boolean(_))
                {
                    return Err(fail(format!(
                        "invalid type: {}, expected a boolean for key `experimental_network.enabled`",
                        enabled.kind()
                    )));
                }
            }
            Some(other) => {
                return Err(fail(format!(
                    "invalid type: {}, expected struct NetworkRequirementsToml for key `experimental_network`",
                    other.kind()
                )));
            }
            None => {}
        }
        merged = merge_toml(std::mem::take(&mut merged), &regular);
    }
    let mut features = HashMap::new();
    if let Some(table) = table(merged.get("features")) {
        for (key, value) in &table.entries {
            if let TomlValue::Boolean(flag) = value {
                features.insert(key.clone(), *flag);
            }
        }
    }
    let network_enabled = match table(merged.get("experimental_network"))
        .and_then(|network| network.get("enabled"))
    {
        Some(TomlValue::Boolean(flag)) => Some(*flag),
        _ => None,
    };
    Ok(BrokerRequirements {
        features,
        network_enabled,
    })
}

fn apply_broker_requirements(
    broker: Broker,
    requirements: &BrokerRequirements,
    trusted: &TomlTable,
) -> Broker {
    let trusted_masking = matches!(
        table(trusted.get("features")).and_then(|features| features.get("credential_masking")),
        Some(TomlValue::Boolean(true))
    );
    let masking = requirements
        .features
        .get("credential_masking")
        .copied()
        .unwrap_or(trusted_masking);
    if !masking && broker.state == BrokerState::Unconfigured {
        return broker;
    }
    let enabled = masking
        || requirements
            .features
            .get("network_proxy")
            .copied()
            .unwrap_or(broker.state == BrokerState::Enabled);
    let state = if enabled && requirements.network_enabled != Some(false) {
        BrokerState::Enabled
    } else {
        BrokerState::Disabled
    };
    Broker { state, ..broker }
}

async fn read_project_file(file: &str, label: &str) -> Load<Option<String>> {
    read_text(file).await.map_err(|error| {
        LoadError::text(format!(
            "Failed to read {label} {file}: {}",
            io_message(&error)
        ))
    })
}

async fn root_checkout_hooks(folder: &str) -> Load<Option<TomlValue>> {
    let file = policy::join(folder, &[CONFIG_TOML_FILE]);
    let Some(contents) = read_project_file(&file, "project hooks config file").await? else {
        return Ok(None);
    };
    match parse_toml(&contents) {
        Ok(parsed) => Ok(parsed.get("hooks").cloned()),
        Err(error) => Err(LoadError::with_detail(
            format!(
                "Error parsing project hooks config file {file}: {}:{}: ",
                error.line, error.column
            ),
            &error.detail,
        )),
    }
}

async fn project_layers(
    cwd: &str,
    codex_home: &str,
    discovery: &TomlTable,
    requirement_layers: &[Layer],
) -> Load<Vec<Layer>> {
    let markers = project_root_markers(discovery)?;
    let trust = projects_trust(discovery)?;
    let requirements = broker_requirements(requirement_layers)?;
    let project_root = discover_project_root(cwd, &markers)
        .await
        .unwrap_or_else(|| cwd.to_owned());
    let checkout_root = git_checkout_root(cwd).await;
    let repo_root = git_repo_root(cwd).await;
    let root_keys = trust_keys(&project_root).await;
    let repo_keys = match &repo_root {
        Some(root) => trust_keys(root).await,
        None => Vec::new(),
    };
    let broker = apply_broker_requirements(credential_broker(discovery), &requirements, discovery);
    let canonical_codex_home = canonical(codex_home).await;
    let mut dirs: Vec<String> = Vec::new();
    for dir in policy::ancestors(cwd) {
        let reached = dir == project_root;
        dirs.push(dir);
        if reached {
            break;
        }
    }
    dirs.reverse();
    let mut layers = Vec::new();
    for dir in dirs {
        let dot_codex = policy::join(&dir, &[".codex"]);
        if !is_directory(&dot_codex).await {
            continue;
        }
        if dot_codex == codex_home || canonical(&dot_codex).await == canonical_codex_home {
            continue;
        }
        let dir_keys = trust_keys(&dir).await;
        let trusted = lookup(&trust, &dir_keys)
            .or_else(|| lookup(&trust, &root_keys))
            .or_else(|| lookup(&trust, &repo_keys))
            == Some(Trust::Trusted);
        let file = policy::join(&dot_codex, &[CONFIG_TOML_FILE]);
        let contents = read_project_file(&file, "project config file").await?;
        let mut config = TomlTable::new();
        if let Some(contents) = contents {
            match parse_toml(&contents) {
                Ok(parsed) => config = parsed,
                Err(error) => {
                    if trusted {
                        return Err(LoadError::with_detail(
                            format!(
                                "Error parsing project config file {file}: {}:{}: ",
                                error.line, error.column
                            ),
                            &error.detail,
                        ));
                    }
                    continue;
                }
            }
        }
        if !trusted {
            continue;
        }
        let mut sanitized = sanitize_project_config(config, &broker);
        let hooks_folder =
            hooks_folder_for_dir(&dir, checkout_root.as_deref(), repo_root.as_deref());
        if hooks_folder.is_some() {
            sanitized.remove("hooks");
        }
        layers.push(Layer {
            source: format!("project ({dot_codex}/{CONFIG_TOML_FILE})"),
            base_dir: dot_codex.clone(),
            toml: TomlValue::Table(sanitized),
        });
        let Some(hooks_folder) = hooks_folder else {
            continue;
        };
        if let Some(hooks) = root_checkout_hooks(&hooks_folder).await? {
            layers.push(Layer {
                source: format!("project ({hooks_folder}/{CONFIG_TOML_FILE})"),
                base_dir: hooks_folder.clone(),
                toml: TomlValue::Table(TomlTable::from_entries([("hooks".to_owned(), hooks)])),
            });
        }
    }
    Ok(layers)
}

fn variant_error(key: &str, value: &TomlValue, variants: &[&str]) -> LoadError {
    let expected = variants
        .iter()
        .map(|variant| format!("`{variant}`"))
        .collect::<Vec<_>>()
        .join(", ");
    match value {
        TomlValue::String(text) => LoadError::text(format!(
            "Failed to parse config requirements as TOML: unknown variant `{text}` for `{key}`, expected one of {expected}"
        )),
        other => LoadError::text(format!(
            "Failed to parse config requirements as TOML: invalid type {} for `{key}`, expected one of {expected}",
            other.kind()
        )),
    }
}

fn legacy_approval_policy(value: &TomlValue) -> Load<TomlValue> {
    let variants = ["untrusted", "on-request", "on-failure", "granular", "never"];
    if let TomlValue::String(text) = value {
        return match text.as_str() {
            "on-failure" | "on-request" => Ok(TomlValue::String("on-request".to_owned())),
            "untrusted" | "never" => Ok(TomlValue::String(text.clone())),
            _ => Err(variant_error("approval_policy", value, &variants)),
        };
    }
    let granular = match value {
        TomlValue::Table(wrapper) if wrapper.len() == 1 => wrapper.get("granular"),
        _ => None,
    };
    let Some(TomlValue::Table(granular)) = granular else {
        return Err(variant_error("approval_policy", value, &variants));
    };
    let mut fields: Vec<(String, TomlValue)> = Vec::new();
    for (field, required) in GRANULAR_FIELDS {
        match granular.get(field) {
            None if required => {
                return Err(LoadError::text(format!(
                    "Failed to parse config requirements as TOML: missing field `{field}`"
                )));
            }
            None => fields.push((field.to_owned(), TomlValue::Boolean(false))),
            Some(TomlValue::Boolean(flag)) => {
                fields.push((field.to_owned(), TomlValue::Boolean(*flag)))
            }
            Some(other) => {
                return Err(LoadError::text(format!(
                    "Failed to parse config requirements as TOML: invalid type {} for `{field}`, expected a boolean",
                    other.kind()
                )));
            }
        }
    }
    Ok(TomlValue::Table(TomlTable::from_entries([(
        "granular".to_owned(),
        TomlValue::Table(TomlTable::from_entries(fields)),
    )])))
}

fn legacy_requirements(managed: &TomlTable) -> Load<TomlTable> {
    let mut out = TomlTable::new();
    if let Some(approval_policy) = managed.get("approval_policy") {
        out.insert(
            "allowed_approval_policies".to_owned(),
            TomlValue::Array(vec![legacy_approval_policy(approval_policy)?]),
        );
    }
    if let Some(reviewer) = managed.get("approvals_reviewer") {
        match reviewer {
            TomlValue::String(text) if text == "user" => out.insert(
                "allowed_approvals_reviewers".to_owned(),
                text_array(&["user"]),
            ),
            TomlValue::String(text) if text == "auto_review" || text == "guardian_subagent" => out
                .insert(
                    "allowed_approvals_reviewers".to_owned(),
                    text_array(&["auto_review", "user"]),
                ),
            _ => {
                return Err(variant_error(
                    "approvals_reviewer",
                    reviewer,
                    &["user", "auto_review", "guardian_subagent"],
                ));
            }
        }
    }
    if let Some(sandbox_mode) = managed.get("sandbox_mode") {
        let variants = ["read-only", "workspace-write", "danger-full-access"];
        let TomlValue::String(mode) = sandbox_mode else {
            return Err(variant_error("sandbox_mode", sandbox_mode, &variants));
        };
        if !variants.contains(&mode.as_str()) {
            return Err(variant_error("sandbox_mode", sandbox_mode, &variants));
        }
        let allowed = if mode == "read-only" {
            text_array(&["read-only"])
        } else {
            text_array(&["read-only", mode.as_str()])
        };
        out.insert("allowed_sandbox_modes".to_owned(), allowed);
    }
    Ok(out)
}

fn path_text(path: &Option<PathBuf>, fallback: &str) -> String {
    path.as_ref().map_or_else(
        || fallback.to_owned(),
        |path| path.to_string_lossy().into_owned(),
    )
}

pub async fn require_full_access(options: &EnvironmentConfigOptions) -> Result<(), ExecutorError> {
    let requirements_file = path_text(&options.system_requirements_path, SYSTEM_REQUIREMENTS_PATH);
    let managed_file = path_text(&options.managed_config_path, MANAGED_CONFIG_PATH);
    for (file, managed) in [(&requirements_file, false), (&managed_file, true)] {
        let contents = match tokio::fs::read_to_string(file).await {
            Ok(contents) => contents,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(ExecutorError::new(
                    -32603,
                    format!(
                        "failed to read deployment requirements {file}: {}",
                        io_message(&error)
                    ),
                ));
            }
        };
        let config = parse_file(file, &contents).map_err(|_| {
            ExecutorError::new(
                -32603,
                format!("invalid TOML in deployment requirements {file}"),
            )
        })?;
        let requirements = if managed {
            legacy_requirements(&config).map_err(|_| {
                ExecutorError::new(
                    -32603,
                    format!("invalid deployment requirements in {file}; check sandbox_mode and approval settings"),
                )
            })?
        } else {
            config
        };
        if let Some(value) = requirements.get("allowed_sandbox_modes") {
            let TomlValue::Array(modes) = value else {
                return Err(ExecutorError::new(
                    -32603,
                    format!("invalid allowed_sandbox_modes in {file}"),
                ));
            };
            if !modes.iter().all(|mode| matches!(mode, TomlValue::String(mode) if ["read-only", "workspace-write", "danger-full-access"].contains(&mode.as_str()))) {
                return Err(ExecutorError::new(-32603, format!("invalid allowed_sandbox_modes in {file}")));
            }
            if !modes
                .iter()
                .any(|mode| matches!(mode, TomlValue::String(mode) if mode == "danger-full-access"))
            {
                return Err(ExecutorError::new(
                    -32001,
                    format!("deployment requirements in {file} prohibit danger-full-access"),
                ));
            }
        }
    }
    Ok(())
}

async fn load_stacks(
    cwd: &str,
    codex_home: &str,
    options: &EnvironmentConfigOptions,
) -> Load<(Stack, Stack)> {
    let system_file = path_text(&options.system_config_path, SYSTEM_CONFIG_PATH);
    let user_file = home_join(codex_home, CONFIG_TOML_FILE);
    let managed_file = path_text(&options.managed_config_path, MANAGED_CONFIG_PATH);
    let system = required_layer(&system_file).await?;
    let user = required_layer(&user_file).await?;
    let managed_text = read_text(&managed_file).await.map_err(|error| {
        LoadError::text(format!(
            "Failed to read managed config file {managed_file}: {}",
            io_message(&error)
        ))
    })?;
    let managed = match &managed_text {
        Some(text) => Some(parse_file(&managed_file, text)?),
        None => None,
    };
    let mut discovery = merge_toml(system.clone(), &user);
    if let Some(managed) = &managed {
        discovery = merge_toml(discovery, managed);
    }
    let requirements_file = path_text(&options.system_requirements_path, SYSTEM_REQUIREMENTS_PATH);
    let requirements_text = read_text(&requirements_file).await.map_err(|error| {
        LoadError::text(format!(
            "Failed to read requirements file {requirements_file}: {}",
            io_message(&error)
        ))
    })?;
    let mut requirement_layers: Vec<Layer> = Vec::new();
    if let Some(text) = &requirements_text {
        requirement_layers.push(Layer {
            source: requirements_file.clone(),
            base_dir: policy::dirname(&requirements_file),
            toml: TomlValue::Table(parse_file(&requirements_file, text)?),
        });
    }
    if let Some(managed) = &managed {
        requirement_layers.push(Layer {
            source: managed_file.clone(),
            base_dir: policy::dirname(&managed_file),
            toml: TomlValue::Table(legacy_requirements(managed)?),
        });
    }
    let mut config_layers = vec![
        Layer {
            source: format!("system ({system_file})"),
            base_dir: policy::dirname(&system_file),
            toml: TomlValue::Table(system),
        },
        Layer {
            source: format!("user ({user_file})"),
            base_dir: codex_home.to_owned(),
            toml: TomlValue::Table(user),
        },
    ];
    config_layers.extend(project_layers(cwd, codex_home, &discovery, &requirement_layers).await?);
    if let Some(managed) = managed {
        config_layers.push(Layer {
            source: format!("legacy managed_config.toml ({managed_file})"),
            base_dir: policy::dirname(&managed_file),
            toml: TomlValue::Table(managed),
        });
    }
    Ok((
        Stack {
            layers: config_layers,
            cloud_insertion_index: 1,
        },
        Stack {
            layers: requirement_layers,
            cloud_insertion_index: if requirements_text.is_none() { 0 } else { 1 },
        },
    ))
}

fn project_stack(
    stack: &Stack,
    paths: &[Vec<Option<String>>],
) -> Result<EnvironmentConfigLayerStack, ExecutorError> {
    let mut layers = Vec::new();
    let mut cloud_insertion_index = 0;
    for (index, layer) in stack.layers.iter().enumerate() {
        let Some(projected) = project_toml_selectors(&layer.toml, paths) else {
            continue;
        };
        let TomlValue::Table(projected) = &projected else {
            continue;
        };
        if index < stack.cloud_insertion_index {
            cloud_insertion_index += 1;
        }
        let base_dir =
            policy::to_path_uri(&layer.base_dir).map_err(|_| ExecutorError::internal())?;
        layers.push(EnvironmentConfigLayer {
            source: layer.source.clone(),
            base_dir,
            toml: stringify_toml(projected),
        });
    }
    Ok(EnvironmentConfigLayerStack {
        layers,
        cloud_insertion_index,
    })
}

async fn codex_home(options: &EnvironmentConfigOptions) -> Result<String, ExecutorError> {
    let home = options.home_directory.to_string_lossy().into_owned();
    let Some(value) = options
        .codex_home_env
        .as_deref()
        .filter(|value| !value.is_empty())
    else {
        return Ok(home_join(&home, ".codex"));
    };
    let quoted = serde_json::Value::String(value.to_owned()).to_string();
    let info = tokio::fs::metadata(value).await.map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            ExecutorError::new(-32603, format!("failed to find Codex home: CODEX_HOME points to {quoted}, but that path does not exist"))
        } else {
            ExecutorError::new(-32603, format!("failed to find Codex home: failed to read CODEX_HOME {quoted}: {}", io_message(&error)))
        }
    })?;
    if !info.is_dir() {
        return Err(ExecutorError::new(
            -32603,
            format!(
                "failed to find Codex home: CODEX_HOME points to {quoted}, but that path is not a directory"
            ),
        ));
    }
    policy::real_path(value)
        .await
        .map_err(|_| ExecutorError::internal())
}

#[cfg(unix)]
fn system_hostname() -> String {
    let mut buffer = [0_u8; 256];
    if unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } != 0 {
        return String::new();
    }
    let end = buffer
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(buffer.len());
    String::from_utf8_lossy(&buffer[..end]).into_owned()
}

#[cfg(not(unix))]
fn system_hostname() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_default()
}

fn host_name(read: Option<&Arc<dyn Fn() -> String + Send + Sync>>) -> Option<String> {
    let raw = match read {
        Some(read) => read(),
        None => system_hostname(),
    };
    let trimmed = os_text(&trim(&LosslessString::from(raw)));
    let name = trimmed.trim_end_matches('.');
    if name.is_empty() {
        None
    } else {
        Some(name.to_lowercase())
    }
}

fn selectors(paths: &[Vec<LosslessString>]) -> Vec<Vec<Option<String>>> {
    paths
        .iter()
        .map(|path| path.iter().map(|segment| segment.to_utf8().ok()).collect())
        .collect()
}

pub async fn read_environment_config(
    params: EnvironmentConfigReadParams,
    options: &EnvironmentConfigOptions,
) -> Result<EnvironmentConfigReadResult, ExecutorError> {
    if params.config_paths.is_empty() && params.requirements_paths.is_empty() {
        return Err(ExecutorError::invalid_params(
            "at least one config or requirements path is required",
        ));
    }
    if params
        .config_paths
        .iter()
        .chain(&params.requirements_paths)
        .any(|path| path.is_empty())
    {
        return Err(ExecutorError::invalid_params(
            "TOML paths must contain at least one key segment",
        ));
    }
    let cwd = policy::parse_path_uri(&params.cwd)
        .map_err(|error| ExecutorError::invalid_params(error.message))?;
    let home = codex_home(options).await?;
    let (config_stack, requirements_stack) =
        load_stacks(&cwd, &home, options).await.map_err(|error| {
            ExecutorError::new(
                -32603,
                concat(&[
                    &LosslessString::from("failed to load executor-local config: "),
                    &error.0,
                ]),
            )
        })?;
    let user_home_dir = policy::to_path_uri(&options.home_directory.to_string_lossy()).ok();
    let codex_home_dir = policy::to_path_uri(&home).map_err(|_| ExecutorError::internal())?;
    let hostname = host_name(options.hostname.as_ref());
    let config = project_stack(&config_stack, &selectors(&params.config_paths))?;
    let requirements = project_stack(&requirements_stack, &selectors(&params.requirements_paths))?;
    Ok(EnvironmentConfigReadResult {
        user_home_dir,
        codex_home_dir,
        hostname,
        config,
        requirements,
    })
}
