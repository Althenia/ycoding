use super::value::{
    JsonObject, LosslessString, Value as PValue, concat, from_serde, object_get, os_text,
    trim as trim_units,
};
use super::{
    error::{BoxFuture, ExecutorError},
    executor::{FsDirectoryEntry, FsMetadata},
    policy::{SEP, basename, dirname, join, parse_path_uri, real_path, to_path_uri},
    signal::HandlerContext,
};
use serde_json::{Map, Value, json};
use std::{collections::BTreeSet, path::PathBuf, sync::Arc};
use tokio::sync::Semaphore;
use yaml_rust2::parser::{Event, EventReceiver, Parser};

pub const MAX_CAPABILITY_ROOTS_PER_REQUEST: usize = 128;
const MAX_SCAN_DEPTH: usize = 6;
const MAX_DIRECTORIES_PER_ROOT: usize = 2_000;
const MAX_ENTRIES_PER_ROOT: usize = 20_000;
const MAX_FILE_BYTES: usize = 1024 * 1024;
const MAX_BUNDLE_BYTES_PER_ROOT: usize = 16 * 1024 * 1024;
const MAX_CONCURRENT_ROOTS: usize = 8;
const SKILL_FILE_NAME: &str = "SKILL.md";
const SKILL_METADATA_PATH: &str = "agents/openai.yaml";
const DEFAULT_MCP_CONFIG_PATH: &str = ".mcp.json";
const DEFAULT_APP_CONFIG_PATH: &str = ".app.json";
const PLUGIN_MANIFEST_PATHS: [&str; 3] = [
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json",
    ".cursor-plugin/plugin.json",
];
const MAX_WALK_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const WALK_RESPONSE_ITEM_OVERHEAD_BYTES: usize = 64;
const READ_CHUNK_BASE64_CHARS: usize = 64 * 1024;
pub const SYSTEM_CONFIG_PATH: &str = "/etc/codex/config.toml";

fn cancelled() -> ExecutorError {
    ExecutorError::new(-32603, "capability root discovery cancelled")
}
fn check_cancelled(ctx: &HandlerContext) -> Result<(), ExecutorError> {
    if ctx.signal.is_cancelled() {
        Err(cancelled())
    } else {
        Ok(())
    }
}
fn error_text(error: &ExecutorError) -> LosslessString {
    if error.code == -32600 && error.message.as_str() == Some("Permission denied") {
        return "Operation not permitted (os error 1)".into();
    }
    error.message.clone()
}
fn uri(native: &str) -> Result<String, ExecutorError> {
    to_path_uri(native).map_err(|error| ExecutorError::new(-32602, error.message))
}
fn byte_order(left: &str, right: &str) -> std::cmp::Ordering {
    left.as_bytes().cmp(right.as_bytes())
}

pub trait ReadTreeSource: Send + Sync {
    fn open_read_tree(
        &self,
        path: String,
        sandbox: Option<PValue>,
        ctx: HandlerContext,
    ) -> BoxFuture<'_, Result<super::connection::ReadTree, ExecutorError>>;
}

#[derive(Clone, Debug)]
pub struct CapabilityRootRequest {
    pub id: LosslessString,
    pub path: String,
    pub sandbox: Option<PValue>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityTextFile {
    pub path: String,
    pub contents: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveredPluginFiles {
    pub manifest: CapabilityTextFile,
    pub mcp_config: Option<CapabilityTextFile>,
    pub apps_config: Option<CapabilityTextFile>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveredSkillFiles {
    pub instructions: CapabilityTextFile,
    pub metadata: Option<CapabilityTextFile>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityRootDiscovery {
    pub id: LosslessString,
    pub path: String,
    pub plugin: Option<DiscoveredPluginFiles>,
    pub skills: Vec<DiscoveredSkillFiles>,
    pub namespace_manifests: Vec<CapabilityTextFile>,
    pub warnings: Vec<LosslessString>,
    pub error: Option<LosslessString>,
}
impl CapabilityRootDiscovery {
    fn empty(request: &CapabilityRootRequest) -> Self {
        Self {
            id: request.id.clone(),
            path: request.path.clone(),
            plugin: None,
            skills: vec![],
            namespace_manifests: vec![],
            warnings: vec![],
            error: None,
        }
    }
}

fn text_file_json(file: &CapabilityTextFile) -> Value {
    json!({"path": file.path, "contents": file.contents})
}
impl CapabilityRootDiscovery {
    pub fn to_json(&self) -> PValue {
        let PValue::Object(mut object) = from_serde(&self.to_serde()) else {
            unreachable!()
        };
        object.insert("id".into(), PValue::String(self.id.clone()));
        object.insert(
            "warnings".into(),
            PValue::Array(self.warnings.iter().cloned().map(PValue::String).collect()),
        );
        object.insert(
            "error".into(),
            self.error.clone().map_or(PValue::Null, PValue::String),
        );
        PValue::Object(object)
    }
    fn to_serde(&self) -> Value {
        json!({
            "path": self.path,
            "plugin": self.plugin.as_ref().map(plugin_files_json),
            "skills": self.skills.iter().map(|skill| json!({"instructions": text_file_json(&skill.instructions), "metadata": skill.metadata.as_ref().map(text_file_json)})).collect::<Vec<_>>(),
            "namespaceManifests": self.namespace_manifests.iter().map(text_file_json).collect::<Vec<_>>(),
        })
    }
}
fn plugin_files_json(files: &DiscoveredPluginFiles) -> Value {
    json!({"manifest": text_file_json(&files.manifest), "mcpConfig": files.mcp_config.as_ref().map(text_file_json), "appsConfig": files.apps_config.as_ref().map(text_file_json)})
}

struct RootScan {
    tree: super::connection::ReadTree,
    ctx: HandlerContext,
    warnings: Vec<LosslessString>,
    budget: usize,
}
impl RootScan {
    async fn metadata(&self, native: &str) -> Result<FsMetadata, ExecutorError> {
        check_cancelled(&self.ctx)?;
        self.tree.get_metadata(&uri(native)?).await
    }
    async fn directory(&self, native: &str) -> Result<Vec<FsDirectoryEntry>, ExecutorError> {
        check_cancelled(&self.ctx)?;
        self.tree.read_directory(&uri(native)?).await
    }
    async fn identity(&self, native: &str) -> Result<String, ExecutorError> {
        check_cancelled(&self.ctx)?;
        let resolved = real_path(native)
            .await
            .map_err(|error| ExecutorError::new(-32603, error.to_string()))?;
        check_cancelled(&self.ctx)?;
        Ok(resolved)
    }

    async fn walk(&mut self, root: &str) -> Result<(Vec<String>, bool), ExecutorError> {
        let mut files: Vec<String> = vec![];
        let mut truncated = false;
        let mut response_bytes = 0usize;
        let mut visited = BTreeSet::new();
        visited.insert(self.identity(root).await?);
        let mut directories = 1usize;
        let mut entries = 0usize;
        let mut pending: std::collections::VecDeque<(String, usize)> =
            std::collections::VecDeque::new();
        pending.push_back((root.to_owned(), 0));
        while let Some((dir, depth)) = pending.pop_front() {
            let listing = match self.directory(&dir).await {
                Ok(listing) => listing,
                Err(error) => {
                    check_cancelled(&self.ctx)?;
                    let item = concat(&[
                        &format!("failed to scan capability path {}: ", uri(&dir)?).into(),
                        &error_text(&error),
                    ]);
                    response_bytes += uri(&dir)?.len()
                        + super::value::utf8_len(&error_text(&error))
                        + WALK_RESPONSE_ITEM_OVERHEAD_BYTES;
                    if response_bytes > MAX_WALK_RESPONSE_BYTES {
                        return Ok((files, true));
                    }
                    self.warnings.push(item);
                    continue;
                }
            };
            check_cancelled(&self.ctx)?;
            let mut sorted = listing;
            sorted.sort_by(|left, right| byte_order(&left.file_name, &right.file_name));
            for entry in sorted {
                check_cancelled(&self.ctx)?;
                if entries == MAX_ENTRIES_PER_ROOT {
                    return Ok((files, true));
                }
                entries += 1;
                let child = join(&dir, &[&entry.file_name]);
                if !entry.is_directory && !entry.is_file {
                    let followed = self.metadata(&child).await.ok();
                    check_cancelled(&self.ctx)?;
                    if !followed.is_some_and(|followed| followed.is_directory) {
                        continue;
                    }
                }
                response_bytes += uri(&child)?.len() + WALK_RESPONSE_ITEM_OVERHEAD_BYTES;
                if response_bytes > MAX_WALK_RESPONSE_BYTES {
                    truncated = true;
                    return Ok((files, truncated));
                }
                if entry.is_file {
                    files.push(child);
                    continue;
                }
                if depth >= MAX_SCAN_DEPTH {
                    continue;
                }
                let identity = match self.identity(&child).await {
                    Ok(identity) => identity,
                    Err(error) => {
                        check_cancelled(&self.ctx)?;
                        let item = concat(&[
                            &format!("failed to scan capability path {}: ", uri(&child)?).into(),
                            &error_text(&error),
                        ]);
                        response_bytes += uri(&child)?.len()
                            + super::value::utf8_len(&error_text(&error))
                            + WALK_RESPONSE_ITEM_OVERHEAD_BYTES;
                        if response_bytes > MAX_WALK_RESPONSE_BYTES {
                            return Ok((files, true));
                        }
                        self.warnings.push(item);
                        continue;
                    }
                };
                if !visited.insert(identity) {
                    continue;
                }
                if directories == MAX_DIRECTORIES_PER_ROOT {
                    truncated = true;
                    continue;
                }
                directories += 1;
                pending.push_back((child, depth + 1));
            }
        }
        Ok((files, truncated))
    }

    async fn text(&mut self, native: &str) -> Result<Option<CapabilityTextFile>, ExecutorError> {
        let file_uri = uri(native)?;
        let info = match self.metadata(native).await {
            Ok(info) => info,
            Err(error) => {
                check_cancelled(&self.ctx)?;
                if error.code != -32004 {
                    self.warnings.push(concat(&[
                        &format!("failed to inspect capability file {file_uri}: ").into(),
                        &error_text(&error),
                    ]));
                }
                return Ok(None);
            }
        };
        if !info.is_file {
            return Ok(None);
        }
        if info.size as usize > MAX_FILE_BYTES {
            self.warnings.push(
                format!("capability file {file_uri} exceeds the {MAX_FILE_BYTES}-byte limit")
                    .into(),
            );
            return Ok(None);
        }
        if self.budget + info.size as usize > MAX_BUNDLE_BYTES_PER_ROOT {
            self.warnings.push(
                format!(
                    "capability root bundle exceeds the {MAX_BUNDLE_BYTES_PER_ROOT}-byte limit"
                )
                .into(),
            );
            return Ok(None);
        }
        check_cancelled(&self.ctx)?;
        let data = match self.tree.read_file(&file_uri).await {
            Ok(data) => data,
            Err(error) => {
                check_cancelled(&self.ctx)?;
                self.warnings.push(concat(&[
                    &format!("failed to read capability file {file_uri}: ").into(),
                    &error_text(&error),
                ]));
                return Ok(None);
            }
        };
        check_cancelled(&self.ctx)?;
        let _ = READ_CHUNK_BASE64_CHARS;
        if data.len() > MAX_FILE_BYTES || self.budget + data.len() > MAX_BUNDLE_BYTES_PER_ROOT {
            self.warnings
                .push(format!("capability file {file_uri} exceeded its read limit").into());
            return Ok(None);
        }
        if let Some(invalid) = super::encoding::utf8_error_text(&data) {
            self.warnings
                .push(format!("capability file {file_uri} is not UTF-8: {invalid}").into());
            return Ok(None);
        }
        self.budget += data.len();
        Ok(Some(CapabilityTextFile {
            path: file_uri,
            contents: String::from_utf8_lossy(&data).into_owned(),
        }))
    }

    async fn first_manifest(
        &mut self,
        dir: &str,
    ) -> Result<Option<CapabilityTextFile>, ExecutorError> {
        for relative in PLUGIN_MANIFEST_PATHS {
            if let Some(manifest) = self.text(&join(dir, &[relative])).await? {
                return Ok(Some(manifest));
            }
        }
        Ok(None)
    }
}

fn manifest_priority(native: &str) -> Option<usize> {
    if basename(native) != "plugin.json" {
        return None;
    }
    let directory = basename(&dirname(native));
    PLUGIN_MANIFEST_PATHS
        .iter()
        .position(|relative| *relative == format!("{directory}/plugin.json"))
}
fn plugin_root(native: &str) -> String {
    dirname(&dirname(native))
}
fn declared_path(
    root: &str,
    field: &str,
    value: Option<&Json>,
    manifest_path: &str,
    warnings: &mut Vec<LosslessString>,
) -> Option<String> {
    let Some(Json::String(value)) = value else {
        return None;
    };
    let value = os_text(value);
    let Some(relative) = value.strip_prefix("./") else {
        warnings
            .push(format!("ignoring {field} in {manifest_path}: path must start with `./`").into());
        return None;
    };
    if relative.is_empty()
        || relative
            .split(['/', '\\'])
            .any(|component| component == "..")
    {
        warnings.push(
            format!(
                "ignoring {field} in {manifest_path}: path must remain below the capability root"
            )
            .into(),
        );
        return None;
    }
    let joined = join(root, &[relative]);
    if joined != root && !joined.starts_with(&format!("{root}{SEP}")) {
        warnings.push(
            format!(
                "ignoring {field} in {manifest_path}: path must remain below the capability root"
            )
            .into(),
        );
        return None;
    }
    Some(joined)
}

async fn discover_root(
    source: Arc<dyn ReadTreeSource>,
    request: CapabilityRootRequest,
    ctx: HandlerContext,
) -> Result<CapabilityRootDiscovery, ExecutorError> {
    let result = CapabilityRootDiscovery::empty(&request);
    let failed = |message: LosslessString| CapabilityRootDiscovery {
        error: Some(message),
        ..CapabilityRootDiscovery::empty(&request)
    };
    let root = match parse_path_uri(&request.path) {
        Ok(root) => root,
        Err(error) => {
            return Ok(failed(concat(&[
                &format!("failed to inspect capability root {}: ", request.path).into(),
                &error.message,
            ])));
        }
    };
    check_cancelled(&ctx)?;
    let tree = match source
        .open_read_tree(request.path.clone(), request.sandbox.clone(), ctx.clone())
        .await
    {
        Ok(tree) => tree,
        Err(error) => {
            check_cancelled(&ctx)?;
            return Ok(failed(concat(&[
                &format!("failed to inspect capability root {}: ", request.path).into(),
                &error_text(&error),
            ])));
        }
    };
    let outcome = scan_root(
        RootScan {
            tree: tree.clone(),
            ctx: ctx.clone(),
            warnings: vec![],
            budget: 0,
        },
        &root,
        &request,
        result,
        &ctx,
    )
    .await;
    let _ = tree.release().await;
    outcome
}

async fn scan_root(
    mut scan: RootScan,
    root: &str,
    request: &CapabilityRootRequest,
    mut result: CapabilityRootDiscovery,
    ctx: &HandlerContext,
) -> Result<CapabilityRootDiscovery, ExecutorError> {
    match scan.metadata(root).await {
        Ok(info) if !info.is_directory => {
            result.error =
                Some(format!("capability root {} is not a directory", request.path).into());
            return Ok(result);
        }
        Ok(_) => {}
        Err(error) => {
            check_cancelled(ctx)?;
            result.error = Some(concat(&[
                &format!("failed to inspect capability root {}: ", request.path).into(),
                &error_text(&error),
            ]));
            return Ok(result);
        }
    }
    let (files, truncated) = match scan.walk(root).await {
        Ok(walked) => walked,
        Err(error) => {
            check_cancelled(ctx)?;
            result.error = Some(concat(&[
                &format!("failed to scan capability root {}: ", request.path).into(),
                &error_text(&error),
            ]));
            return Ok(result);
        }
    };
    if truncated {
        scan.warnings.push(
            format!(
                "capability scan reached its traversal limit (root: {})",
                request.path
            )
            .into(),
        );
    }
    let mut skill_paths = files
        .iter()
        .filter(|file| basename(file) == SKILL_FILE_NAME)
        .cloned()
        .collect::<Vec<_>>();
    skill_paths.sort_by(|left, right| {
        byte_order(
            &uri(left).unwrap_or_default(),
            &uri(right).unwrap_or_default(),
        )
    });
    let mut manifest_paths = files
        .iter()
        .filter(|file| manifest_priority(file).is_some())
        .cloned()
        .collect::<Vec<_>>();
    manifest_paths.sort_by(|left, right| {
        let (left_root, right_root) = (
            uri(&plugin_root(left)).unwrap_or_default(),
            uri(&plugin_root(right)).unwrap_or_default(),
        );
        byte_order(&left_root, &right_root)
            .then(manifest_priority(left).cmp(&manifest_priority(right)))
    });
    let root_manifest = scan.first_manifest(root).await?;
    let mut inherited = root_manifest.clone();
    if inherited.is_none() {
        let mut ancestor = dirname(root);
        loop {
            inherited = scan.first_manifest(&ancestor).await?;
            if inherited.is_some() || dirname(&ancestor) == ancestor {
                break;
            }
            ancestor = dirname(&ancestor);
        }
    }
    let mut namespace_manifests = vec![];
    let mut seen_roots = BTreeSet::new();
    if let Some(inherited) = inherited {
        if let Ok(native) = parse_path_uri(&inherited.path) {
            seen_roots.insert(plugin_root(&native));
        }
        namespace_manifests.push(inherited);
    }
    for manifest_path in &manifest_paths {
        let owner = plugin_root(manifest_path);
        if !seen_roots.insert(owner) {
            continue;
        }
        if let Some(manifest) = scan.text(manifest_path).await? {
            namespace_manifests.push(manifest);
        }
    }
    let mut plugin = None;
    if let Some(manifest) = root_manifest {
        let declarations = parse_json(&manifest.contents).ok();
        let field = |name: &str| match &declarations {
            Some(Json::Object(entries)) => entries
                .iter()
                .rev()
                .find(|(key, _)| key.as_str() == Some(name))
                .map(|(_, value)| value.clone()),
            _ => None,
        };
        let mcp = field("mcpServers");
        let apps = field("apps");
        let mcp_inline = matches!(mcp, Some(Json::Object(_)));
        let mcp_declared = declared_path(
            root,
            "mcpServers",
            mcp.as_ref(),
            &manifest.path,
            &mut scan.warnings,
        );
        let apps_declared = declared_path(
            root,
            "apps",
            apps.as_ref(),
            &manifest.path,
            &mut scan.warnings,
        );
        let mcp_path = if mcp_inline {
            None
        } else {
            Some(mcp_declared.unwrap_or_else(|| join(root, &[DEFAULT_MCP_CONFIG_PATH])))
        };
        let mcp_config = match mcp_path {
            Some(path) => scan.text(&path).await?,
            None => None,
        };
        let apps_config = scan
            .text(&apps_declared.unwrap_or_else(|| join(root, &[DEFAULT_APP_CONFIG_PATH])))
            .await?;
        plugin = Some(DiscoveredPluginFiles {
            manifest,
            mcp_config,
            apps_config,
        });
    }
    let mut skills = vec![];
    for skill_path in &skill_paths {
        let Some(instructions) = scan.text(skill_path).await? else {
            continue;
        };
        let metadata = scan
            .text(&join(&dirname(skill_path), &[SKILL_METADATA_PATH]))
            .await?;
        skills.push(DiscoveredSkillFiles {
            instructions,
            metadata,
        });
    }
    result.plugin = plugin;
    result.skills = skills;
    result.namespace_manifests = namespace_manifests;
    result.warnings = scan.warnings;
    Ok(result)
}

pub async fn discover_capability_roots(
    source: Arc<dyn ReadTreeSource>,
    roots: Vec<CapabilityRootRequest>,
    ctx: &HandlerContext,
) -> Result<Vec<CapabilityRootDiscovery>, ExecutorError> {
    if roots.len() > MAX_CAPABILITY_ROOTS_PER_REQUEST {
        return Err(ExecutorError::new(
            -32600,
            format!(
                "capability root discovery accepts at most {MAX_CAPABILITY_ROOTS_PER_REQUEST} roots"
            ),
        ));
    }
    check_cancelled(ctx)?;
    let permits = Arc::new(Semaphore::new(MAX_CONCURRENT_ROOTS));
    let mut tasks = vec![];
    for request in roots {
        let (source, ctx, permits) = (source.clone(), ctx.clone(), permits.clone());
        tasks.push(tokio::spawn(async move {
            let _permit = permits.acquire().await.map_err(|_| cancelled())?;
            check_cancelled(&ctx)?;
            discover_root(source, request, ctx).await
        }));
    }
    let mut results = vec![];
    let mut failure = None;
    for task in tasks {
        match task.await {
            Ok(Ok(root)) => results.push(root),
            Ok(Err(error)) => failure = failure.or(Some(error)),
            Err(_) => failure = failure.or(Some(ExecutorError::internal())),
        }
    }
    match failure {
        Some(error) => Err(error),
        None => Ok(results),
    }
}

#[derive(Clone, Debug)]
pub enum Json {
    Object(Vec<(LosslessString, Json)>),
    Array(Vec<Json>),
    String(LosslessString),
    Number(String),
    Literal(Option<bool>),
}
struct JsonError(String);

fn parse_json(text: &str) -> Result<Json, ()> {
    struct Parser<'a> {
        text: &'a [u8],
        source: &'a str,
        index: usize,
    }
    impl Parser<'_> {
        fn space(&mut self) {
            while self.index < self.text.len() && b" \t\n\r".contains(&self.text[self.index]) {
                self.index += 1;
            }
        }
        fn value(&mut self, depth: usize) -> Result<Json, ()> {
            if depth > 512 {
                return Err(());
            }
            self.space();
            match self.text.get(self.index) {
                Some(b'{') => {
                    self.index += 1;
                    let mut entries = vec![];
                    self.space();
                    if self.text.get(self.index) == Some(&b'}') {
                        self.index += 1;
                        return Ok(Json::Object(entries));
                    }
                    loop {
                        self.space();
                        if self.text.get(self.index) != Some(&b'"') {
                            return Err(());
                        }
                        let key = self.string()?;
                        self.space();
                        if self.text.get(self.index) != Some(&b':') {
                            return Err(());
                        }
                        self.index += 1;
                        entries.push((key, self.value(depth + 1)?));
                        self.space();
                        match self.text.get(self.index) {
                            Some(b',') => self.index += 1,
                            Some(b'}') => {
                                self.index += 1;
                                return Ok(Json::Object(entries));
                            }
                            _ => return Err(()),
                        }
                    }
                }
                Some(b'[') => {
                    self.index += 1;
                    let mut items = vec![];
                    self.space();
                    if self.text.get(self.index) == Some(&b']') {
                        self.index += 1;
                        return Ok(Json::Array(items));
                    }
                    loop {
                        items.push(self.value(depth + 1)?);
                        self.space();
                        match self.text.get(self.index) {
                            Some(b',') => self.index += 1,
                            Some(b']') => {
                                self.index += 1;
                                return Ok(Json::Array(items));
                            }
                            _ => return Err(()),
                        }
                    }
                }
                Some(b'"') => Ok(Json::String(self.string()?)),
                _ => {
                    for (word, literal) in
                        [("true", Some(true)), ("false", Some(false)), ("null", None)]
                    {
                        if self.source[self.index..].starts_with(word) {
                            self.index += word.len();
                            return Ok(Json::Literal(literal));
                        }
                    }
                    let rest = &self.source[self.index..];
                    let mut end = 0;
                    let bytes = rest.as_bytes();
                    if bytes.get(end) == Some(&b'-') {
                        end += 1;
                    }
                    match bytes.get(end) {
                        Some(b'0') => end += 1,
                        Some(b'1'..=b'9') => {
                            while bytes.get(end).is_some_and(u8::is_ascii_digit) {
                                end += 1;
                            }
                        }
                        _ => return Err(()),
                    }
                    if bytes.get(end) == Some(&b'.')
                        && bytes.get(end + 1).is_some_and(u8::is_ascii_digit)
                    {
                        end += 1;
                        while bytes.get(end).is_some_and(u8::is_ascii_digit) {
                            end += 1;
                        }
                    }
                    if matches!(bytes.get(end), Some(b'e' | b'E')) {
                        let mut probe = end + 1;
                        if matches!(bytes.get(probe), Some(b'+' | b'-')) {
                            probe += 1;
                        }
                        if bytes.get(probe).is_some_and(u8::is_ascii_digit) {
                            while bytes.get(probe).is_some_and(u8::is_ascii_digit) {
                                probe += 1;
                            }
                            end = probe;
                        }
                    }
                    let raw = &rest[..end];
                    self.index += end;
                    let integral = !raw.contains(['.', 'e', 'E']);
                    if !integral && !raw.parse::<f64>().is_ok_and(f64::is_finite) {
                        return Err(());
                    }
                    Ok(Json::Number(raw.to_owned()))
                }
            }
        }
        fn string(&mut self) -> Result<LosslessString, ()> {
            let start = self.index;
            self.index += 1;
            while self.index < self.text.len() && self.text[self.index] != b'"' {
                self.index += if self.text[self.index] == b'\\' { 2 } else { 1 };
            }
            if self.index >= self.text.len() {
                return Err(());
            }
            self.index += 1;
            match super::value::parse_json(&self.source[start..self.index]).map_err(|_| ())? {
                PValue::String(text) => Ok(text),
                _ => Err(()),
            }
        }
    }
    let mut parser = Parser {
        text: text.as_bytes(),
        source: text,
        index: 0,
    };
    let value = parser.value(0)?;
    parser.space();
    if parser.index != text.len() {
        Err(())
    } else {
        Ok(value)
    }
}

fn format_float(value: f64) -> String {
    if value == 0.0 {
        return if value.is_sign_negative() {
            "-0.0".to_owned()
        } else {
            "0.0".to_owned()
        };
    }
    let sign = if value < 0.0 { "-" } else { "" };
    let exponential = format!("{:e}", value.abs());
    let (mantissa, exponent) = exponential.split_once('e').unwrap_or((&exponential, "0"));
    let digits = mantissa.replace('.', "");
    let point = exponent.parse::<i64>().unwrap_or(0) + 1;
    let zeros = point - digits.len() as i64;
    if zeros >= 0 && point <= 16 {
        return format!("{sign}{digits}{}.0", "0".repeat(zeros as usize));
    }
    if point > 0 && point <= 16 {
        return format!(
            "{sign}{}.{}",
            &digits[..point as usize],
            &digits[point as usize..]
        );
    }
    if point > -5 && point <= 0 {
        return format!("{sign}0.{}{digits}", "0".repeat((-point) as usize));
    }
    format!(
        "{sign}{}{}e{}",
        &digits[..1],
        if digits.len() > 1 {
            format!(".{}", &digits[1..])
        } else {
            String::new()
        },
        point - 1
    )
}
fn format_number(raw: &str) -> String {
    if !raw.contains(['.', 'e', 'E'])
        && raw != "-0"
        && let Ok(integer) = raw.parse::<i128>()
        && (-9_223_372_036_854_775_808i128..=18_446_744_073_709_551_615i128).contains(&integer)
    {
        return integer.to_string();
    }
    format_float(raw.parse::<f64>().unwrap_or(0.0))
}
fn stringify_json(value: &Json) -> String {
    match value {
        Json::Object(entries) => {
            let mut merged: Vec<(LosslessString, &Json)> = vec![];
            for (key, item) in entries {
                match merged.iter_mut().find(|(existing, _)| existing == key) {
                    Some(slot) => slot.1 = item,
                    None => merged.push((key.clone(), item)),
                }
            }
            format!(
                "{{{}}}",
                merged
                    .iter()
                    .map(|(key, item)| format!(
                        "{}:{}",
                        super::value::stringify_json(&PValue::String(key.clone())),
                        stringify_json(item)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Json::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(stringify_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Json::String(text) => super::value::stringify_json(&PValue::String(text.clone())),
        Json::Number(raw) => format_number(raw),
        Json::Literal(None) => "null".to_owned(),
        Json::Literal(Some(flag)) => flag.to_string(),
    }
}
fn json_struct(value: &Json, fields: &[&str]) -> Result<Vec<(String, Json)>, JsonError> {
    let Json::Object(entries) = value else {
        return Err(JsonError("expected an object".to_owned()));
    };
    let mut decoded: Vec<(String, Json)> = vec![];
    for (key, item) in entries {
        let Some(name) = key.as_str().filter(|name| fields.contains(name)) else {
            continue;
        };
        if decoded.iter().any(|(existing, _)| existing == name) {
            return Err(JsonError(format!("duplicate field `{name}`")));
        }
        decoded.push((name.to_owned(), item.clone()));
    }
    Ok(decoded)
}
fn get<'a>(fields: &'a [(String, Json)], name: &str) -> Option<&'a Json> {
    fields
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
}
fn json_string(value: Option<&Json>, nullable: bool) -> Result<Option<LosslessString>, JsonError> {
    match value {
        None => Ok(None),
        Some(Json::String(text)) => Ok(Some(text.clone())),
        Some(Json::Literal(None)) if nullable => Ok(None),
        _ => Err(JsonError("expected a string".to_owned())),
    }
}
fn manifest_name(contents: &str) -> Option<LosslessString> {
    let parsed = parse_json(contents).ok()?;
    let fields = json_struct(&parsed, &["name"]).ok()?;
    json_string(get(&fields, "name"), false)
        .ok()
        .map(Option::unwrap_or_default)
}
struct PluginManifestMetadata {
    name: LosslessString,
    display_name: Option<LosslessString>,
    mcp_servers: Option<Json>,
    apps: Option<LosslessString>,
}
fn plugin_manifest_metadata(contents: &str) -> Option<PluginManifestMetadata> {
    let parsed = parse_json(contents).ok()?;
    let fields = json_struct(&parsed, &["name", "interface", "mcpServers", "apps"]).ok()?;
    let mut display_name = None;
    if let Some(face) = get(&fields, "interface")
        && !matches!(face, Json::Literal(None))
    {
        let face_fields = json_struct(face, &["displayName"]).ok()?;
        display_name = json_string(get(&face_fields, "displayName"), true).ok()?;
    }
    let mcp_servers = get(&fields, "mcpServers")
        .filter(|value| !matches!(value, Json::Literal(None)))
        .cloned();
    Some(PluginManifestMetadata {
        name: json_string(get(&fields, "name"), false)
            .ok()?
            .unwrap_or_default(),
        display_name,
        mcp_servers,
        apps: json_string(get(&fields, "apps"), true).ok()?,
    })
}
fn parse_remote_plugin_id(contents: &str) -> Result<LosslessString, String> {
    let parsed = parse_json(contents).map_err(|_| "invalid JSON".to_owned())?;
    let fields =
        json_struct(&parsed, &["schema_version", "remote_plugin_id"]).map_err(|error| error.0)?;
    let version = get(&fields, "schema_version")
        .ok_or_else(|| "missing field `schema_version`".to_owned())?;
    let Json::Number(raw) = version else {
        return Err("invalid schema_version".to_owned());
    };
    if !raw.chars().all(|character| character.is_ascii_digit())
        || raw.parse::<u64>().map_or(true, |value| value > 255)
    {
        return Err("invalid schema_version".to_owned());
    }
    let id = json_string(get(&fields, "remote_plugin_id"), false)
        .map_err(|error| error.0)?
        .ok_or_else(|| "missing field `remote_plugin_id`".to_owned())?;
    if raw != "1" {
        return Err(format!(
            "unsupported remote plugin install metadata schema version: {raw}"
        ));
    }
    let trimmed = trim_units(&id);
    if trimmed.is_empty() {
        return Err(
            "invalid remote plugin install metadata: remote plugin id must not be blank".to_owned(),
        );
    }
    if super::value::utf8_len(&trimmed) > 1024 {
        return Err("remote plugin ID exceeds its byte limit".to_owned());
    }
    Ok(trimmed)
}

#[derive(Clone, Debug)]
enum Yaml {
    Scalar { value: String, plain: bool },
    Map(Vec<(String, Yaml)>),
    Seq(Vec<Yaml>),
}
struct YamlError(String);

#[derive(Default)]
struct TreeBuilder {
    stack: Vec<Frame>,
    anchors: std::collections::HashMap<usize, Yaml>,
    root: Option<Yaml>,
    failure: Option<String>,
}
enum Frame {
    Map {
        anchor: usize,
        entries: Vec<(String, Yaml)>,
        key: Option<String>,
    },
    Seq {
        anchor: usize,
        items: Vec<Yaml>,
    },
}
impl TreeBuilder {
    fn push(&mut self, value: Yaml) {
        match self.stack.last_mut() {
            None => self.root = Some(value),
            Some(Frame::Seq { items, .. }) => items.push(value),
            Some(Frame::Map { entries, key, .. }) => match key.take() {
                Some(name) => entries.push((name, value)),
                None => match value {
                    Yaml::Scalar { value, .. } => *key = Some(value),
                    _ => self.failure = Some("expected a field identifier".to_owned()),
                },
            },
        }
    }
}
impl EventReceiver for TreeBuilder {
    fn on_event(&mut self, event: Event) {
        match event {
            Event::Scalar(value, style, anchor, _) => {
                let node = Yaml::Scalar {
                    value,
                    plain: matches!(style, yaml_rust2::scanner::TScalarStyle::Plain),
                };
                if anchor > 0 {
                    self.anchors.insert(anchor, node.clone());
                }
                self.push(node);
            }
            Event::SequenceStart(anchor, _) => self.stack.push(Frame::Seq {
                anchor,
                items: vec![],
            }),
            Event::MappingStart(anchor, _) => self.stack.push(Frame::Map {
                anchor,
                entries: vec![],
                key: None,
            }),
            Event::SequenceEnd => {
                if let Some(Frame::Seq { anchor, items }) = self.stack.pop() {
                    let node = Yaml::Seq(items);
                    if anchor > 0 {
                        self.anchors.insert(anchor, node.clone());
                    }
                    self.push(node);
                }
            }
            Event::MappingEnd => {
                if let Some(Frame::Map {
                    anchor, entries, ..
                }) = self.stack.pop()
                {
                    let node = Yaml::Map(entries);
                    if anchor > 0 {
                        self.anchors.insert(anchor, node.clone());
                    }
                    self.push(node);
                }
            }
            Event::Alias(id) => match self.anchors.get(&id).cloned() {
                Some(node) => self.push(node),
                None => self.failure = Some("unknown anchor".to_owned()),
            },
            _ => {}
        }
    }
}
fn parse_yaml(text: &str) -> Result<Yaml, YamlError> {
    let mut builder = TreeBuilder::default();
    let mut parser = Parser::new_from_str(text);
    parser
        .load(&mut builder, false)
        .map_err(|error| YamlError(error.to_string()))?;
    if let Some(failure) = builder.failure {
        return Err(YamlError(failure));
    }
    Ok(builder.root.unwrap_or(Yaml::Scalar {
        value: String::new(),
        plain: true,
    }))
}
fn is_yaml_null(node: Option<&Yaml>) -> bool {
    match node {
        None => true,
        Some(Yaml::Scalar { value, plain: true }) => {
            ["", "~", "null", "Null", "NULL"].contains(&value.as_str())
        }
        _ => false,
    }
}
fn yaml_struct(node: &Yaml, fields: &[&[&str]]) -> Result<Vec<(String, Yaml)>, YamlError> {
    let Yaml::Map(entries) = node else {
        return Err(YamlError("expected a struct".to_owned()));
    };
    let mut decoded: Vec<(String, Yaml)> = vec![];
    for (key, value) in entries {
        let Some(field) = fields.iter().find(|names| names.contains(&key.as_str())) else {
            continue;
        };
        if decoded.iter().any(|(existing, _)| existing == field[0]) {
            return Err(YamlError(format!("duplicate field `{}`", field[0])));
        }
        decoded.push((field[0].to_owned(), value.clone()));
    }
    Ok(decoded)
}
fn yget<'a>(fields: &'a [(String, Yaml)], name: &str) -> Option<&'a Yaml> {
    fields
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
}
fn yaml_optional_string(node: Option<&Yaml>) -> Result<Option<String>, YamlError> {
    if is_yaml_null(node) {
        return Ok(None);
    }
    match node {
        Some(Yaml::Scalar { value, .. }) => Ok(Some(value.clone())),
        _ => Err(YamlError("expected a string".to_owned())),
    }
}
fn yaml_optional_bool(node: Option<&Yaml>) -> Result<Option<bool>, YamlError> {
    if is_yaml_null(node) {
        return Ok(None);
    }
    if let Some(Yaml::Scalar { value, plain: true }) = node {
        if ["true", "True", "TRUE"].contains(&value.as_str()) {
            return Ok(Some(true));
        }
        if ["false", "False", "FALSE"].contains(&value.as_str()) {
            return Ok(Some(false));
        }
    }
    Err(YamlError("expected a boolean".to_owned()))
}
fn yaml_optional_u16(node: Option<&Yaml>) -> Result<Option<u16>, YamlError> {
    if is_yaml_null(node) {
        return Ok(None);
    }
    let Some(Yaml::Scalar { value, plain: true }) = node else {
        return Err(YamlError("expected u16".to_owned()));
    };
    let unsigned = value.strip_prefix('+').unwrap_or(value);
    let radix = |prefix: &str, base: u32| {
        unsigned
            .strip_prefix(prefix)
            .filter(|rest| !rest.is_empty())
            .and_then(|rest| u64::from_str_radix(rest, base).ok())
    };
    let parsed = radix("0x", 16)
        .or_else(|| radix("0o", 8))
        .or_else(|| radix("0b", 2))
        .or_else(|| {
            (unsigned.chars().all(|character| character.is_ascii_digit())
                && !unsigned.is_empty()
                && !(unsigned.len() > 1 && unsigned.starts_with('0')))
            .then(|| unsigned.parse().ok())
            .flatten()
        });
    match parsed {
        Some(value) if value <= 65_535 => Ok(Some(value as u16)),
        _ => Err(YamlError("expected u16".to_owned())),
    }
}
fn yaml_sequence(node: Option<&Yaml>) -> Result<Vec<Yaml>, YamlError> {
    match node {
        None => Ok(vec![]),
        Some(Yaml::Seq(items)) => Ok(items.clone()),
        _ => Err(YamlError("expected a sequence".to_owned())),
    }
}
fn yaml_optional_struct(
    node: Option<&Yaml>,
    fields: &[&[&str]],
) -> Result<Option<Vec<(String, Yaml)>>, YamlError> {
    if is_yaml_null(node) {
        Ok(None)
    } else {
        yaml_struct(node.expect("non-null node"), fields).map(Some)
    }
}

const WHITESPACE: &[char] = &[
    '\t', '\n', '\u{b}', '\u{c}', '\r', ' ', '\u{85}', '\u{a0}', '\u{1680}', '\u{2000}',
    '\u{2001}', '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}', '\u{2006}', '\u{2007}', '\u{2008}',
    '\u{2009}', '\u{200a}', '\u{2028}', '\u{2029}', '\u{202f}', '\u{205f}', '\u{3000}',
];
fn collapse(raw: &str) -> String {
    raw.split(WHITESPACE)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}
fn trim_unicode(raw: &str) -> String {
    raw.trim_matches(WHITESPACE).to_owned()
}
fn char_count(text: &str) -> usize {
    text.chars().count()
}

fn extract_frontmatter(contents: &str) -> Option<String> {
    let mut lines = contents
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect::<Vec<_>>();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    if lines.is_empty() || trim_unicode(lines[0]) != "---" {
        return None;
    }
    let mut frontmatter: Vec<&str> = vec![];
    for line in &lines[1..] {
        if trim_unicode(line) == "---" {
            return if frontmatter.is_empty() {
                None
            } else {
                Some(frontmatter.join("\n"))
            };
        }
        frontmatter.push(line);
    }
    None
}

fn repair_frontmatter_scalar_fields(frontmatter: &str) -> Option<String> {
    let mut changed = false;
    let mut block_indent: Option<usize> = None;
    let mut repaired: Vec<String> = vec![];
    for line in frontmatter
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
    {
        let indent = line.len() - line.trim_start_matches(' ').len();
        if let Some(block) = block_indent {
            if trim_unicode(line).is_empty() || indent > block {
                repaired.push(line.to_owned());
                continue;
            }
            block_indent = None;
        }
        let Some(colon) = line.find(':') else {
            repaired.push(line.to_owned());
            continue;
        };
        let key = &line[..colon];
        let value = &line[colon + 1..];
        if trim_unicode(key).is_empty()
            || value
                .chars()
                .next()
                .is_some_and(|first| !WHITESPACE.contains(&first))
        {
            repaired.push(line.to_owned());
            continue;
        }
        let trimmed_start = value.trim_start_matches(WHITESPACE);
        let leading = &value[..value.len() - trimmed_start.len()];
        let mut scalar = trimmed_start;
        let mut comment = "";
        let characters = trimmed_start.char_indices().collect::<Vec<_>>();
        for (position, (offset, character)) in characters.iter().enumerate() {
            if *character == '#'
                && (position == 0 || WHITESPACE.contains(&characters[position - 1].1))
            {
                let comment_start = trimmed_start[..*offset].trim_end_matches(WHITESPACE).len();
                scalar = &trimmed_start[..comment_start];
                comment = &trimmed_start[comment_start..];
                break;
            }
        }
        let scalar = scalar.trim_end_matches(WHITESPACE);
        let Some(first) = scalar.chars().next() else {
            repaired.push(line.to_owned());
            continue;
        };
        if first == '|' || first == '>' {
            block_indent = Some(indent);
            repaired.push(line.to_owned());
            continue;
        }
        if first == '\'' || first == '"' {
            repaired.push(line.to_owned());
            continue;
        }
        let colon_separator = scalar.char_indices().any(|(offset, character)| {
            character == ':'
                && scalar[offset + 1..]
                    .chars()
                    .next()
                    .is_some_and(|next| WHITESPACE.contains(&next))
        });
        let invalid_flow_like = "[{@`".contains(first) && parse_yaml(scalar).is_err();
        if !colon_separator && !invalid_flow_like {
            repaired.push(line.to_owned());
            continue;
        }
        repaired.push(format!(
            "{key}:{leading}'{}'{comment}",
            scalar.replace('\'', "''")
        ));
        changed = true;
    }
    changed.then(|| repaired.join("\n"))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedSkillFrontmatter {
    pub name: String,
    pub description: String,
    pub short_description: Option<String>,
}
fn decode_frontmatter(frontmatter: &str) -> Result<[Option<String>; 3], YamlError> {
    let fields = yaml_struct(
        &parse_yaml(frontmatter)?,
        &[&["name"], &["description"], &["metadata"]],
    )?;
    let metadata = match yget(&fields, "metadata") {
        Some(node) => yaml_struct(node, &[&["short-description"]])?,
        None => vec![],
    };
    Ok([
        yaml_optional_string(yget(&fields, "name"))?,
        yaml_optional_string(yget(&fields, "description"))?,
        yaml_optional_string(yget(&metadata, "short-description"))?,
    ])
}
pub fn parse_skill_frontmatter(
    contents: &str,
    default_name: impl FnOnce() -> String,
) -> Result<ParsedSkillFrontmatter, String> {
    let Some(frontmatter) = extract_frontmatter(contents) else {
        return Err("missing YAML frontmatter delimited by ---".to_owned());
    };
    let [name, description, short_description] = match decode_frontmatter(&frontmatter) {
        Ok(parsed) => parsed,
        Err(error) => match repair_frontmatter_scalar_fields(&frontmatter) {
            None => return Err(format!("invalid YAML: {}", error.0)),
            Some(repaired) => {
                decode_frontmatter(&repaired).map_err(|_| format!("invalid YAML: {}", error.0))?
            }
        },
    };
    let name = match name.as_deref().map(collapse) {
        Some(name) if !name.is_empty() => name,
        _ => default_name(),
    };
    let description = description.as_deref().map(collapse).unwrap_or_default();
    let short_description = short_description
        .as_deref()
        .map(collapse)
        .filter(|text| !text.is_empty());
    if name.is_empty() {
        return Err("missing field `name`".to_owned());
    }
    if char_count(&name) > 64 {
        return Err("invalid name: exceeds maximum length of 64 characters".to_owned());
    }
    if description.is_empty() {
        return Err("missing field `description`".to_owned());
    }
    Ok(ParsedSkillFrontmatter {
        name,
        description,
        short_description,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillToolDependency {
    pub kind: String,
    pub value: String,
    pub description: Option<String>,
    pub transport: Option<String>,
    pub command: Option<String>,
    pub url: Option<String>,
    pub oauth_callback_port: Option<u16>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillPolicy {
    pub allow_implicit_invocation: Option<bool>,
    pub products: Vec<&'static str>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedSkillMetadata {
    pub dependencies: Option<Vec<SkillToolDependency>>,
    pub policy: Option<SkillPolicy>,
}
fn bounded_string(value: Option<&str>, max: usize) -> Option<String> {
    let collapsed = collapse(value?);
    (!collapsed.is_empty() && char_count(&collapsed) <= max).then_some(collapsed)
}
pub fn parse_skill_metadata(contents: &str) -> Result<ParsedSkillMetadata, String> {
    let run = || -> Result<ParsedSkillMetadata, YamlError> {
        let file = parse_yaml(contents)?;
        let fields = yaml_struct(&file, &[&["interface"], &["dependencies"], &["policy"]])?;
        if let Some(interface) = yaml_optional_struct(
            yget(&fields, "interface"),
            &[
                &["display_name"],
                &["short_description"],
                &["icon_small"],
                &["icon_large"],
                &["brand_color"],
                &["default_prompt"],
            ],
        )? {
            for (_, value) in &interface {
                yaml_optional_string(Some(value))?;
            }
        }
        let dependencies = yaml_optional_struct(yget(&fields, "dependencies"), &[&["tools"]])?;
        let mut tools = vec![];
        for item in yaml_sequence(
            dependencies
                .as_ref()
                .and_then(|dependencies| yget(dependencies, "tools")),
        )? {
            let tool = yaml_struct(
                &item,
                &[
                    &["type"],
                    &["value"],
                    &["description"],
                    &["transport"],
                    &["command"],
                    &["url"],
                    &["oauth"],
                ],
            )?;
            let string = |key: &str| yaml_optional_string(yget(&tool, key));
            let (kind, value, description, transport, command, url) = (
                string("type")?,
                string("value")?,
                string("description")?,
                string("transport")?,
                string("command")?,
                string("url")?,
            );
            let oauth =
                yaml_optional_struct(yget(&tool, "oauth"), &[&["callbackPort", "callback_port"]])?;
            let oauth_callback_port =
                yaml_optional_u16(oauth.as_ref().and_then(|oauth| yget(oauth, "callbackPort")))?;
            let (Some(kind), Some(value)) = (
                bounded_string(kind.as_deref(), 64),
                bounded_string(value.as_deref(), 1024),
            ) else {
                continue;
            };
            tools.push(SkillToolDependency {
                kind,
                value,
                description: bounded_string(description.as_deref(), 1024),
                transport: bounded_string(transport.as_deref(), 64),
                command: bounded_string(command.as_deref(), 1024),
                url: bounded_string(url.as_deref(), 1024),
                oauth_callback_port,
            });
        }
        let policy_fields = yaml_optional_struct(
            yget(&fields, "policy"),
            &[&["allow_implicit_invocation"], &["products"]],
        )?;
        let policy = match policy_fields {
            None => None,
            Some(policy_fields) => {
                let mut products = vec![];
                for product in yaml_sequence(yget(&policy_fields, "products"))? {
                    let name = match &product {
                        Yaml::Scalar { value, .. } => match value.as_str() {
                            "chatgpt" | "CHATGPT" => Some("chatgpt"),
                            "codex" | "CODEX" => Some("codex"),
                            "atlas" | "ATLAS" => Some("atlas"),
                            _ => None,
                        },
                        _ => None,
                    };
                    products.push(name.ok_or_else(|| YamlError("unknown product".to_owned()))?);
                }
                Some(SkillPolicy {
                    allow_implicit_invocation: yaml_optional_bool(yget(
                        &policy_fields,
                        "allow_implicit_invocation",
                    ))?,
                    products,
                })
            }
        };
        Ok(ParsedSkillMetadata {
            dependencies: if tools.is_empty() { None } else { Some(tools) },
            policy,
        })
    };
    run().map_err(|error| error.0)
}

const PLUGINS_CACHE_DIR: &str = "plugins/cache";
const REMOTE_PLUGIN_INSTALL_METADATA_FILE: &str = ".codex-remote-plugin-install.json";
const DEFAULT_PLUGIN_VERSION: &str = "local";
const AGENTS_SKILLS_SUFFIX: &str = ".agents/skills";
const MAX_LOCATIONS: usize = 512;
const MAX_LOCATION_WARNINGS: usize = 64;
const MAX_REMOTE_INSTALL_METADATA_BYTES: usize = 16 * 1024;
const MAX_CACHE_WALK_DIRECTORIES: usize = 2_000;
const MAX_CACHE_WALK_ENTRIES: usize = 20_000;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_CAPABILITIES: usize = 2_048;
const MAX_WARNINGS: usize = 64;
const MAX_QUALIFIED_NAME_LEN: usize = 64 * 2 + 1;
const MAX_CONCURRENT_LOCATIONS: usize = 8;
const LOCATIONS_INCOMPLETE: &str =
    "some capability locations could not be resolved; discovery may be incomplete";
const METADATA_INCOMPLETE: &str =
    "some capability metadata could not be loaded; discovery may be incomplete";
const SIZE_LIMIT_REACHED: &str = "capability discovery size limit reached";
const TRAVERSAL_LIMIT: &str = "plugin cache traversal limit reached";

fn io_text(error: &ExecutorError) -> LosslessString {
    if error.code == -32600 && error.message.as_str() == Some("Permission denied") {
        return "Permission denied (os error 13)".into();
    }
    error.message.clone()
}
fn is_permission_denied(error: &ExecutorError) -> bool {
    error.code == -32001
        || (error.code == -32600 && error.message.as_str() == Some("Permission denied"))
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SemVer {
    core: [u64; 3],
    pre: Vec<String>,
    build: Vec<String>,
}
fn parse_semver(text: &str) -> Option<SemVer> {
    let (rest, build) = match text.split_once('+') {
        Some((rest, build)) => (rest, Some(build)),
        None => (text, None),
    };
    let (core_text, pre) = match rest.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (rest, None),
    };
    let parts = core_text.split('.').collect::<Vec<_>>();
    if parts.len() != 3 {
        return None;
    }
    let numeric = |part: &str| {
        (part == "0"
            || (!part.starts_with('0')
                && !part.is_empty()
                && part.chars().all(|c| c.is_ascii_digit())))
        .then(|| part.parse::<u64>().ok())
        .flatten()
    };
    let core = [numeric(parts[0])?, numeric(parts[1])?, numeric(parts[2])?];
    let identifier = |part: &str| {
        !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    };
    let pre = pre.map_or(vec![], |pre| pre.split('.').map(str::to_owned).collect());
    if pre.iter().any(|part| {
        !identifier(part)
            || (part.chars().all(|c| c.is_ascii_digit())
                && !(part == "0" || !part.starts_with('0')))
    }) {
        return None;
    }
    let build = build.map_or(vec![], |build| {
        build.split('.').map(str::to_owned).collect()
    });
    if build.iter().any(|part| !identifier(part)) {
        return None;
    }
    Some(SemVer { core, pre, build })
}
fn compare_identifiers(
    left: &[String],
    right: &[String],
    numeric: impl Fn(&str, &str) -> std::cmp::Ordering,
) -> std::cmp::Ordering {
    for (index, a) in left.iter().enumerate() {
        let Some(b) = right.get(index) else {
            return std::cmp::Ordering::Greater;
        };
        let (a_numeric, b_numeric) = (
            a.chars().all(|c| c.is_ascii_digit()),
            b.chars().all(|c| c.is_ascii_digit()),
        );
        let order = if a_numeric && b_numeric {
            numeric(a, b)
        } else if a_numeric {
            std::cmp::Ordering::Less
        } else if b_numeric {
            std::cmp::Ordering::Greater
        } else {
            byte_order(a, b)
        };
        if order != std::cmp::Ordering::Equal {
            return order;
        }
    }
    left.len()
        .cmp(&right.len())
        .then(std::cmp::Ordering::Equal)
        .max(if left.len() == right.len() {
            std::cmp::Ordering::Equal
        } else {
            std::cmp::Ordering::Less
        })
}
fn compare_semver(left: &SemVer, right: &SemVer) -> std::cmp::Ordering {
    if left.core != right.core {
        return left.core.cmp(&right.core);
    }
    if left.pre.is_empty() || right.pre.is_empty() {
        if left.pre.len() != right.pre.len() {
            return if left.pre.is_empty() {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Less
            };
        }
    } else {
        let order = compare_identifiers(&left.pre, &right.pre, |a, b| {
            a.len().cmp(&b.len()).then(byte_order(a, b))
        });
        if order != std::cmp::Ordering::Equal {
            return order;
        }
    }
    let (lb, rb) = (
        if left.build.is_empty() {
            vec![String::new()]
        } else {
            left.build.clone()
        },
        if right.build.is_empty() {
            vec![String::new()]
        } else {
            right.build.clone()
        },
    );
    compare_identifiers(&lb, &rb, |a, b| {
        let (x, y) = (a.trim_start_matches('0'), b.trim_start_matches('0'));
        x.len()
            .cmp(&y.len())
            .then(byte_order(x, y))
            .then(a.len().cmp(&b.len()))
    })
}
fn compare_plugin_versions(left: &str, right: &str) -> std::cmp::Ordering {
    match (parse_semver(left), parse_semver(right)) {
        (Some(a), Some(b)) => compare_semver(&a, &b),
        _ => byte_order(left, right),
    }
}
fn valid_plugin_version(version: &str) -> bool {
    !version.is_empty()
        && version != "."
        && version != ".."
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._+-".contains(c))
}
pub fn active_plugin_version(versions: &[String]) -> Option<String> {
    let mut valid = versions
        .iter()
        .filter(|version| valid_plugin_version(version))
        .cloned()
        .collect::<Vec<_>>();
    valid.sort_by(|a, b| compare_plugin_versions(a, b));
    if valid.is_empty() {
        return None;
    }
    if valid
        .iter()
        .any(|version| version == DEFAULT_PLUGIN_VERSION)
    {
        Some(DEFAULT_PLUGIN_VERSION.to_owned())
    } else {
        valid.last().cloned()
    }
}
fn valid_plugin_segment(segment: &str, allow_dots: bool) -> bool {
    if segment.is_empty() {
        return false;
    }
    if allow_dots && (segment.starts_with('.') || segment.ends_with('.') || segment.contains(".."))
    {
        return false;
    }
    segment
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || (allow_dots && c == '.'))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillDiscoveryRoot {
    pub id: String,
    pub path: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutorSkill {
    pub name: LosslessString,
    pub description: String,
    pub short_description: Option<String>,
    pub path: String,
    pub discovery_root: Option<SkillDiscoveryRoot>,
    pub dependencies: Option<Vec<SkillToolDependency>>,
    pub policy: Option<SkillPolicy>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutorPlugin {
    pub id: String,
    pub display_name: LosslessString,
    pub remote_plugin_id: Option<LosslessString>,
    pub version: String,
    pub root: String,
    pub files: DiscoveredPluginFiles,
    pub skills: Vec<ExecutorSkill>,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DiscoverV2Result {
    pub plugins: Vec<ExecutorPlugin>,
    pub skills: Vec<ExecutorSkill>,
    pub warnings: Vec<LosslessString>,
}
fn skill_json(skill: &ExecutorSkill) -> PValue {
    let mut object = Map::new();
    object.insert("description".to_owned(), json!(skill.description));
    object.insert(
        "shortDescription".to_owned(),
        json!(skill.short_description),
    );
    object.insert("path".to_owned(), json!(skill.path));
    if let Some(root) = &skill.discovery_root {
        object.insert(
            "discoveryRoot".to_owned(),
            json!({"id": root.id, "path": root.path}),
        );
    }
    object.insert(
        "dependencies".to_owned(),
        skill.dependencies.as_ref().map_or(Value::Null, |tools| {
            json!({"tools": tools.iter().map(|tool| json!({
                "type": tool.kind, "value": tool.value, "description": tool.description, "transport": tool.transport,
                "command": tool.command, "url": tool.url, "oauthCallbackPort": tool.oauth_callback_port,
            })).collect::<Vec<_>>()})
        }),
    );
    object.insert(
        "policy".to_owned(),
        skill.policy.as_ref().map_or(Value::Null, |policy| json!({"allowImplicitInvocation": policy.allow_implicit_invocation, "products": policy.products})),
    );
    let PValue::Object(mut object) = from_serde(&Value::Object(object)) else {
        unreachable!()
    };
    object.insert("name".into(), PValue::String(skill.name.clone()));
    PValue::Object(object)
}
fn plugin_json(plugin: &ExecutorPlugin) -> PValue {
    let PValue::Object(mut object) = from_serde(&json!({
        "id": plugin.id, "version": plugin.version,
        "root": plugin.root, "files": plugin_files_json(&plugin.files),
    })) else {
        unreachable!()
    };
    object.insert(
        "displayName".into(),
        PValue::String(plugin.display_name.clone()),
    );
    object.insert(
        "remotePluginId".into(),
        plugin
            .remote_plugin_id
            .clone()
            .map_or(PValue::Null, PValue::String),
    );
    object.insert(
        "skills".into(),
        PValue::Array(plugin.skills.iter().map(skill_json).collect()),
    );
    PValue::Object(object)
}
impl DiscoverV2Result {
    pub fn to_json(&self) -> PValue {
        let mut object = JsonObject::new();
        object.insert(
            "plugins".into(),
            PValue::Array(self.plugins.iter().map(plugin_json).collect()),
        );
        object.insert(
            "skills".into(),
            PValue::Array(self.skills.iter().map(skill_json).collect()),
        );
        object.insert(
            "warnings".into(),
            PValue::Array(self.warnings.iter().cloned().map(PValue::String).collect()),
        );
        PValue::Object(object)
    }
}

#[derive(Clone, Debug)]
pub struct DiscoveryEnvironment {
    pub home_directory: PathBuf,
    pub codex_home_env: Option<String>,
    pub system_config_path: Option<PathBuf>,
    pub data_directory: PathBuf,
}

#[derive(Clone)]
struct InstalledPlugin {
    id: String,
    version: String,
    remote_plugin_id: Option<LosslessString>,
}
#[derive(Clone)]
struct CapabilityLocation {
    root: String,
    standalone_root_id: Option<String>,
    plugin: Option<InstalledPlugin>,
}
struct CapabilityLocations {
    locations: Vec<CapabilityLocation>,
    warnings: Vec<LosslessString>,
}
struct LocationRequest {
    codex_home: String,
    user_home: Option<String>,
    system_skills_root: String,
    dots_skills_root: String,
}

async fn resolve_location_request(
    environment: &DiscoveryEnvironment,
) -> Result<LocationRequest, String> {
    let home = environment.home_directory.to_string_lossy().into_owned();
    let codex_home = match environment
        .codex_home_env
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        Some(value) => {
            let quoted = Value::String(value.to_owned()).to_string();
            let info = tokio::fs::metadata(value).await.map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    format!("CODEX_HOME points to {quoted}, but that path does not exist")
                } else {
                    format!(
                        "failed to read CODEX_HOME {quoted}: {}",
                        node_io_text(&error)
                    )
                }
            })?;
            if !info.is_dir() {
                return Err(format!(
                    "CODEX_HOME points to {quoted}, but that path is not a directory"
                ));
            }
            real_path(value).await.map_err(|error| {
                format!(
                    "failed to canonicalize CODEX_HOME {quoted}: {}",
                    node_io_text(&error)
                )
            })?
        }
        None => {
            if home.is_empty() {
                return Err("Could not find home directory".to_owned());
            }
            join(&home, &[".codex"])
        }
    };
    let system_config = environment.system_config_path.as_ref().map_or_else(
        || SYSTEM_CONFIG_PATH.to_owned(),
        |path| path.to_string_lossy().into_owned(),
    );
    Ok(LocationRequest {
        codex_home,
        user_home: if home.is_empty() { None } else { Some(home) },
        system_skills_root: join(&dirname(&system_config), &["skills"]),
        dots_skills_root: join(
            &environment.data_directory.to_string_lossy(),
            &["dots", "skills"],
        ),
    })
}
fn node_io_text(error: &std::io::Error) -> String {
    error.to_string()
}

async fn existing_directory_tree(
    source: &Arc<dyn ReadTreeSource>,
    directory: &str,
    ctx: &HandlerContext,
) -> Result<Option<super::connection::ReadTree>, ExecutorError> {
    let tree = match source
        .open_read_tree(uri(directory)?, None, ctx.clone())
        .await
    {
        Ok(tree) => tree,
        Err(error) if error.code == -32004 => return Ok(None),
        Err(error) => return Err(error),
    };
    match tree.get_metadata(&uri(directory)?).await {
        Ok(metadata) if metadata.is_directory => return Ok(Some(tree)),
        Ok(_) => {}
        Err(error) => {
            let _ = tree.release().await;
            return if error.code == -32004 {
                Ok(None)
            } else {
                Err(error)
            };
        }
    }
    let _ = tree.release().await;
    Ok(None)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CacheKind {
    Directory,
    File,
    Other,
}
async fn cache_entries(
    tree: &super::connection::ReadTree,
    directory: &str,
) -> Result<Vec<(String, CacheKind)>, LosslessString> {
    let listing = tree
        .read_directory(&uri(directory).map_err(|error| error.message)?)
        .await
        .map_err(|error| {
            concat(&[
                &format!(
                    "failed to scan plugin cache path {}: ",
                    uri(directory).unwrap_or_default()
                )
                .into(),
                &io_text(&error),
            ])
        })?;
    let mut entries = vec![];
    for entry in listing {
        if entry.is_directory {
            entries.push((entry.file_name, CacheKind::Directory));
        } else if entry.is_file {
            entries.push((entry.file_name, CacheKind::File));
        } else if let Ok(target) = uri(&join(directory, &[&entry.file_name]))
            && let Ok(followed) = tree.get_metadata(&target).await
        {
            entries.push((
                entry.file_name,
                if followed.is_directory {
                    CacheKind::Directory
                } else if followed.is_file {
                    CacheKind::File
                } else {
                    CacheKind::Other
                },
            ));
        }
    }
    entries.sort_by(|left, right| byte_order(&left.0, &right.0));
    Ok(entries)
}
async fn cache_packages(
    tree: &super::connection::ReadTree,
    cache: &str,
    warnings: &mut Vec<LosslessString>,
) -> Result<Vec<(String, String)>, LosslessString> {
    let mut packages: Vec<(String, String)> = vec![];
    let mut marketplaces: Vec<String> = vec![];
    let mut directories = 1usize;
    let mut entries_seen = 0usize;
    let mut truncated = false;
    'walk: for depth in 0..2 {
        let level = if depth == 0 {
            vec![cache.to_owned()]
        } else {
            marketplaces.clone()
        };
        for directory in level {
            for (name, kind) in cache_entries(tree, &directory).await? {
                if entries_seen == MAX_CACHE_WALK_ENTRIES {
                    truncated = true;
                    break 'walk;
                }
                entries_seen += 1;
                if kind != CacheKind::Directory {
                    continue;
                }
                let child = join(&directory, &[&name]);
                if depth == 1 {
                    let marketplace = basename(&directory);
                    if valid_plugin_segment(&name, true)
                        && valid_plugin_segment(&marketplace, false)
                    {
                        let id = format!("{name}@{marketplace}");
                        match packages.iter_mut().find(|(existing, _)| *existing == id) {
                            Some(slot) => slot.1 = child,
                            None => packages.push((id, child)),
                        }
                    }
                } else if directories == MAX_CACHE_WALK_DIRECTORIES {
                    truncated = true;
                } else {
                    directories += 1;
                    marketplaces.push(child);
                }
            }
        }
    }
    if truncated {
        warnings.push(TRAVERSAL_LIMIT.into());
    }
    Ok(packages)
}
async fn read_remote_plugin_id(
    tree: &super::connection::ReadTree,
    package_root: &str,
) -> Result<Option<LosslessString>, LosslessString> {
    let target = uri(&join(package_root, &[REMOTE_PLUGIN_INSTALL_METADATA_FILE]))
        .map_err(|error| error.message)?;
    let data = match tree.read_file(&target).await {
        Ok(data) => data,
        Err(error) if error.code == -32004 => return Ok(None),
        Err(error) => return Err(error.message),
    };
    if data.len() > MAX_REMOTE_INSTALL_METADATA_BYTES {
        return Err("remote installation metadata exceeds its byte limit".into());
    }
    let text = String::from_utf8(data).map_err(|_| LosslessString::from("invalid utf-8"))?;
    parse_remote_plugin_id(&text)
        .map(Some)
        .map_err(LosslessString::from)
}
async fn discover_cached_plugins(
    tree: &super::connection::ReadTree,
    cache: &str,
) -> Result<(Vec<CapabilityLocation>, Vec<LosslessString>), LosslessString> {
    let mut warnings = vec![];
    let mut locations = vec![];
    let mut packages = cache_packages(tree, cache, &mut warnings).await?;
    packages.sort_by(|left, right| byte_order(&left.0, &right.0));
    for (id, package_root) in packages {
        let Ok(listing) = tree
            .read_directory(&uri(&package_root).map_err(|error| error.message)?)
            .await
        else {
            continue;
        };
        let versions = listing
            .iter()
            .filter(|entry| entry.is_directory)
            .map(|entry| entry.file_name.clone())
            .collect::<Vec<_>>();
        let Some(version) = active_plugin_version(&versions) else {
            continue;
        };
        if locations.len() == MAX_LOCATIONS {
            warnings
                .push(format!("plugin cache reached its {MAX_LOCATIONS}-location limit").into());
            break;
        }
        let remote_plugin_id = match read_remote_plugin_id(tree, &package_root).await {
            Ok(remote) => remote,
            Err(error) => {
                warnings.push(concat(&[
                    &format!("could not read remote installation metadata for {id}: ").into(),
                    &error,
                ]));
                None
            }
        };
        locations.push(CapabilityLocation {
            root: uri(&join(&package_root, &[&version])).map_err(|error| error.message)?,
            standalone_root_id: None,
            plugin: Some(InstalledPlugin {
                id,
                version,
                remote_plugin_id,
            }),
        });
    }
    Ok((locations, warnings))
}
async fn prewarm_locations(
    source: &Arc<dyn ReadTreeSource>,
    request: &LocationRequest,
    ctx: &HandlerContext,
) -> Result<CapabilityLocations, ExecutorError> {
    let cache = join(&request.codex_home, &[PLUGINS_CACHE_DIR]);
    let mut standalone: Vec<(String, String)> = vec![];
    let mut candidates = vec![(
        "codex-home-skills".to_owned(),
        join(&request.codex_home, &["skills"]),
    )];
    if let Some(user_home) = &request.user_home {
        candidates.push((
            "user-agent-skills".to_owned(),
            join(user_home, &[AGENTS_SKILLS_SUFFIX]),
        ));
    }
    candidates.push((
        "system-skills".to_owned(),
        request.system_skills_root.clone(),
    ));
    candidates.push((
        "ycoding-dots-skills".to_owned(),
        request.dots_skills_root.clone(),
    ));
    for (id, root) in candidates {
        if !standalone
            .iter()
            .any(|(_, existing)| uri(existing).ok() == uri(&root).ok())
        {
            standalone.push((id, root));
        }
    }
    let mut trees: Vec<(super::connection::ReadTree, String, Option<String>)> = vec![];
    let outcome = async {
        let all = std::iter::once((None, cache.clone()))
            .chain(
                standalone
                    .iter()
                    .map(|(id, root)| (Some(id.clone()), root.clone())),
            )
            .collect::<Vec<_>>();
        for (id, root) in all {
            if let Some(tree) = existing_directory_tree(source, &root, ctx).await? {
                trees.push((tree, root, id));
            }
        }
        let mut result = CapabilityLocations {
            locations: vec![],
            warnings: vec![],
        };
        for (tree, root, id) in &trees {
            match id {
                None => {
                    let (locations, warnings) = discover_cached_plugins(tree, root)
                        .await
                        .map_err(|message| ExecutorError::new(-32603, message))?;
                    result.locations.extend(locations);
                    result.warnings.extend(warnings);
                }
                Some(id) => result.locations.push(CapabilityLocation {
                    root: uri(root)?,
                    standalone_root_id: Some(id.clone()),
                    plugin: None,
                }),
            }
        }
        if result.locations.len() > MAX_LOCATIONS {
            result.warnings.truncate(MAX_LOCATION_WARNINGS - 1);
            result.warnings.push(
                format!("capability discovery reached its {MAX_LOCATIONS}-location limit").into(),
            );
            result.locations.truncate(MAX_LOCATIONS);
        }
        result.warnings.truncate(MAX_LOCATION_WARNINGS);
        Ok::<_, ExecutorError>(result)
    }
    .await;
    for (tree, _, _) in &trees {
        let _ = tree.release().await;
    }
    outcome
}

enum Source {
    Plugin(Box<ExecutorPlugin>),
    Skills(Vec<ExecutorSkill>),
}
struct CapabilityDiscovery {
    content: Source,
    warnings: Vec<LosslessString>,
}
fn empty_discovery(warnings: Vec<LosslessString>) -> CapabilityDiscovery {
    CapabilityDiscovery {
        content: Source::Skills(vec![]),
        warnings,
    }
}

fn parse_root(
    location: &CapabilityLocation,
    discovery: &CapabilityRootDiscovery,
) -> CapabilityDiscovery {
    let mut warnings = discovery.warnings.clone();
    warnings.extend(discovery.error.clone());
    if location.plugin.is_some() && discovery.plugin.is_none() {
        warnings.push(
            format!(
                "installed plugin at {} has no readable manifest",
                location.root
            )
            .into(),
        );
        return empty_discovery(warnings);
    }
    let mut namespaces: Vec<(String, LosslessString)> = vec![];
    for manifest in &discovery.namespace_manifests {
        let Ok(native) = parse_path_uri(&manifest.path) else {
            continue;
        };
        let owner = dirname(&dirname(&native));
        let Some(parsed) = manifest_name(&manifest.contents) else {
            continue;
        };
        let name = if trim_units(&parsed).is_empty() {
            basename(&owner).into()
        } else {
            parsed
        };
        if name.is_empty() {
            continue;
        }
        if !namespaces.iter().any(|(existing, _)| *existing == owner) {
            namespaces.push((owner, name));
        }
    }
    let mut skills = vec![];
    'skill: for file in &discovery.skills {
        let Ok(skill_path) = parse_path_uri(&file.instructions.path) else {
            continue;
        };
        let parsed = parse_skill_frontmatter(&file.instructions.contents, || {
            let name = collapse(&basename(&dirname(&skill_path)));
            if name.is_empty() {
                "skill".to_owned()
            } else {
                name
            }
        });
        let parsed = match parsed {
            Ok(parsed) => parsed,
            Err(message) => {
                warnings.push(
                    format!(
                        "invalid skill metadata at {}: {message}",
                        file.instructions.path
                    )
                    .into(),
                );
                continue;
            }
        };
        let mut namespace: Option<LosslessString> = None;
        let mut ancestor = dirname(&skill_path);
        loop {
            if let Some((_, name)) = namespaces.iter().find(|(owner, _)| *owner == ancestor) {
                if char::decode_utf16(name.code_units())
                    .count()
                    .min(MAX_QUALIFIED_NAME_LEN + 1)
                    + 1
                    + char_count(&parsed.name)
                    > MAX_QUALIFIED_NAME_LEN
                {
                    warnings.push(format!("invalid skill metadata at {}: qualified name exceeds {MAX_QUALIFIED_NAME_LEN} characters", file.instructions.path).into());
                    continue 'skill;
                }
                namespace = Some(name.clone());
                break;
            }
            if dirname(&ancestor) == ancestor {
                break;
            }
            ancestor = dirname(&ancestor);
        }
        let metadata = file
            .metadata
            .as_ref()
            .map(|metadata| parse_skill_metadata(&metadata.contents));
        let (dependencies, policy) = match metadata {
            Some(Ok(metadata)) => (metadata.dependencies, metadata.policy),
            _ => (None, None),
        };
        skills.push(ExecutorSkill {
            name: namespace.map_or_else(
                || parsed.name.clone().into(),
                |namespace| concat(&[&namespace, &":".into(), &parsed.name.as_str().into()]),
            ),
            description: parsed.description,
            short_description: parsed.short_description,
            path: file.instructions.path.clone(),
            discovery_root: location
                .standalone_root_id
                .as_ref()
                .map(|id| SkillDiscoveryRoot {
                    id: id.clone(),
                    path: location.root.clone(),
                }),
            dependencies,
            policy,
        });
    }
    let (Some(plugin), Some(files)) = (&location.plugin, &discovery.plugin) else {
        return CapabilityDiscovery {
            content: Source::Skills(skills),
            warnings,
        };
    };
    let Some(manifest) = plugin_manifest_metadata(&files.manifest.contents) else {
        warnings.push(format!("invalid plugin manifest at {}", files.manifest.path).into());
        return empty_discovery(warnings);
    };
    let root_native = parse_path_uri(&location.root).unwrap_or_default();
    let name = if trim_units(&manifest.name).is_empty() {
        let base = basename(&root_native);
        if base.is_empty() {
            manifest.name.clone()
        } else {
            base.into()
        }
    } else {
        manifest.name.clone()
    };
    let display_name = match &manifest.display_name {
        Some(display) if !trim_units(display).is_empty() => trim_units(display),
        _ => name,
    };
    let mut mcp_config = files.mcp_config.clone();
    if mcp_config.is_none() {
        match &manifest.mcp_servers {
            Some(servers @ Json::Object(_)) => mcp_config = Some(CapabilityTextFile { path: files.manifest.path.clone(), contents: stringify_json(servers) }),
            Some(Json::String(_)) => warnings.push(format!("plugin `{}` at {} declares an MCP configuration file, but discovery returned no contents", plugin.id, location.root).into()),
            _ => {}
        }
    }
    if files.apps_config.is_none() && manifest.apps.is_some() {
        warnings.push(format!("plugin `{}` at {} declares an Apps configuration file, but discovery returned no contents", plugin.id, location.root).into());
    }
    CapabilityDiscovery {
        content: Source::Plugin(Box::new(ExecutorPlugin {
            id: plugin.id.clone(),
            display_name,
            remote_plugin_id: plugin.remote_plugin_id.clone(),
            version: plugin.version.clone(),
            root: location.root.clone(),
            files: DiscoveredPluginFiles {
                manifest: files.manifest.clone(),
                mcp_config,
                apps_config: files.apps_config.clone(),
            },
            skills,
        })),
        warnings,
    }
}

struct SingleTree(super::connection::ReadTree);
impl ReadTreeSource for SingleTree {
    fn open_read_tree(
        &self,
        _path: String,
        _sandbox: Option<PValue>,
        _ctx: HandlerContext,
    ) -> BoxFuture<'_, Result<super::connection::ReadTree, ExecutorError>> {
        let tree = self.0.borrowed();
        Box::pin(async move { Ok(tree) })
    }
}

async fn load_capability_discovery(
    source: &Arc<dyn ReadTreeSource>,
    location: &CapabilityLocation,
    sandbox: Option<PValue>,
    ctx: &HandlerContext,
) -> Result<CapabilityDiscovery, ExecutorError> {
    let inspect = |error: &ExecutorError| {
        if error.code == -32004 || is_permission_denied(error) {
            empty_discovery(vec![])
        } else {
            empty_discovery(vec![concat(&[
                &format!("could not inspect capability root {}: ", location.root).into(),
                &io_text(error),
            ])])
        }
    };
    let tree = match source
        .open_read_tree(location.root.clone(), sandbox, ctx.clone())
        .await
    {
        Ok(tree) => tree,
        Err(error) => return Ok(inspect(&error)),
    };
    let outcome = async {
        match tree.get_metadata(&location.root).await {
            Ok(metadata) if !metadata.is_directory => return Ok(empty_discovery(vec![])),
            Ok(_) => {}
            Err(error) => return Ok(inspect(&error)),
        }
        let opened: Arc<dyn ReadTreeSource> = Arc::new(SingleTree(tree.clone()));
        let roots = discover_capability_roots(
            opened,
            vec![CapabilityRootRequest {
                id: location
                    .plugin
                    .as_ref()
                    .map(|plugin| plugin.id.clone())
                    .unwrap_or_default()
                    .into(),
                path: location.root.clone(),
                sandbox: None,
            }],
            ctx,
        )
        .await?;
        Ok(parse_root(location, &roots[0]))
    }
    .await;
    let _ = tree.release().await;
    outcome
}

fn json_bytes(value: &PValue) -> usize {
    super::value::stringify_json(value).len()
}
struct ResponseBudget {
    capabilities: usize,
    bytes: usize,
    truncated: bool,
}
fn admit(budget: &mut ResponseBudget, capabilities: usize, bytes: usize) -> bool {
    if budget.capabilities + capabilities > MAX_CAPABILITIES
        || budget.bytes + bytes > MAX_RESPONSE_BYTES
    {
        budget.truncated = true;
        return false;
    }
    budget.capabilities += capabilities;
    budget.bytes += bytes;
    true
}
fn append_discovery(
    response: &mut DiscoverV2Result,
    discovery: CapabilityDiscovery,
    budget: &mut ResponseBudget,
) {
    let room = MAX_WARNINGS.saturating_sub(response.warnings.len());
    response
        .warnings
        .extend(discovery.warnings.into_iter().take(room));
    match discovery.content {
        Source::Plugin(source) => {
            let remaining = MAX_CAPABILITIES - budget.capabilities;
            if remaining == 0 {
                budget.truncated = true;
                return;
            }
            if source.skills.len() > remaining - 1 {
                budget.truncated = true;
            }
            let mut plugin = *source;
            plugin.skills.truncate(remaining - 1);
            if admit(
                budget,
                1 + plugin.skills.len(),
                json_bytes(&plugin_json(&plugin)),
            ) {
                response.plugins.push(plugin);
            }
        }
        Source::Skills(skills) => {
            for skill in skills {
                if budget.capabilities == MAX_CAPABILITIES {
                    budget.truncated = true;
                    break;
                }
                if admit(budget, 1, json_bytes(&skill_json(&skill))) {
                    response.skills.push(skill);
                }
            }
        }
    }
}
fn finish_response(mut response: DiscoverV2Result, truncated: bool) -> DiscoverV2Result {
    response.plugins.sort_by(|left, right| {
        byte_order(&left.id, &right.id).then(byte_order(&left.root, &right.root))
    });
    response.warnings.truncate(MAX_WARNINGS);
    if truncated || super::value::stringify_json(&response.to_json()).len() > MAX_RESPONSE_BYTES {
        response.warnings.truncate(MAX_WARNINGS - 1);
        response.warnings.insert(0, SIZE_LIMIT_REACHED.into());
        while super::value::stringify_json(&response.to_json()).len() > MAX_RESPONSE_BYTES {
            if response.warnings.len() > 1 {
                response.warnings.truncate(1);
            } else if response.skills.pop().is_none() && response.plugins.pop().is_none() {
                break;
            }
        }
    }
    response
}

async fn load_capability_discoveries(
    source: &Arc<dyn ReadTreeSource>,
    locations: &CapabilityLocations,
    sandbox: Option<PValue>,
    ctx: &HandlerContext,
) -> Result<DiscoverV2Result, ExecutorError> {
    let mut response = DiscoverV2Result {
        plugins: vec![],
        skills: vec![],
        warnings: if locations.warnings.is_empty() {
            vec![]
        } else {
            vec![LOCATIONS_INCOMPLETE.into()]
        },
    };
    let mut budget = ResponseBudget {
        capabilities: 0,
        bytes: 0,
        truncated: false,
    };
    let permits = Arc::new(Semaphore::new(MAX_CONCURRENT_LOCATIONS));
    let mut tasks: Vec<tokio::task::JoinHandle<Result<CapabilityDiscovery, ExecutorError>>> =
        vec![];
    for location in &locations.locations {
        let (source, location, sandbox, ctx, permits) = (
            source.clone(),
            location.clone(),
            sandbox.clone(),
            ctx.clone(),
            permits.clone(),
        );
        tasks.push(tokio::spawn(async move {
            let _permit = permits
                .acquire()
                .await
                .map_err(|_| ExecutorError::internal())?;
            load_capability_discovery(&source, &location, sandbox, &ctx).await
        }));
    }
    let total = tasks.len();
    let mut stopped = false;
    for (index, task) in tasks.into_iter().enumerate() {
        if stopped {
            task.abort();
            continue;
        }
        let discovery = task.await.map_err(|_| ExecutorError::internal())??;
        let discovery = if discovery.warnings.is_empty() {
            discovery
        } else {
            CapabilityDiscovery {
                content: discovery.content,
                warnings: vec![METADATA_INCOMPLETE.into()],
            }
        };
        append_discovery(&mut response, discovery, &mut budget);
        if (budget.capabilities == MAX_CAPABILITIES || budget.bytes == MAX_RESPONSE_BYTES)
            && index + 1 < total
        {
            budget.truncated = true;
            stopped = true;
        }
    }
    Ok(finish_response(response, budget.truncated))
}

fn params_error(message: impl Into<LosslessString>) -> ExecutorError {
    ExecutorError::new(-32602, message)
}
fn unexpected(value: &PValue) -> String {
    match value {
        PValue::Null => "null".to_owned(),
        PValue::Bool(flag) => format!("boolean `{flag}`"),
        PValue::Number(_) => "number".to_owned(),
        PValue::String(text) => format!(
            "string {}",
            super::value::stringify_json(&PValue::String(text.clone()))
        ),
        PValue::Array(_) => "sequence".to_owned(),
        PValue::Object(_) => "map".to_owned(),
    }
}
fn tagged_unexpected(value: &PValue) -> String {
    match value {
        PValue::Number(number) => {
            if number.fract() == 0.0 {
                format!("integer `{number}`")
            } else {
                format!("floating point `{number}`")
            }
        }
        other => unexpected(other),
    }
}
fn decode_path_uri(value: &PValue) -> Result<(), ExecutorError> {
    let PValue::String(text) = value else {
        return Err(params_error(format!(
            "invalid type: {}, expected a string",
            unexpected(value)
        )));
    };
    let text = os_text(text);
    let trimmed = text.trim_matches(|character: char| character <= '\u{20}');
    let scheme_end = trimmed.find(':');
    let scheme = scheme_end.map(|index| &trimmed[..index]).filter(|scheme| {
        scheme
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    });
    let Some(scheme) = scheme else {
        return Err(params_error("invalid URI: relative URL without a base"));
    };
    let name = scheme.to_ascii_lowercase();
    if name != "file" {
        return Err(params_error(format!(
            "unsupported path URI scheme `{name}`"
        )));
    }
    let hash = trimmed.find('#');
    if hash.map_or(trimmed, |hash| &trimmed[..hash]).contains('?') {
        return Err(params_error(
            "query parameters are not allowed in path URIs",
        ));
    }
    if hash.is_some() {
        return Err(params_error("fragments are not allowed in path URIs"));
    }
    Ok(())
}
fn variants(names: &[&str]) -> String {
    names
        .iter()
        .map(|name| format!("`{name}`"))
        .collect::<Vec<_>>()
        .join(", ")
}
fn decode_sandbox(value: &PValue) -> Result<Option<PValue>, ExecutorError> {
    match value {
        PValue::Null => return Ok(None),
        PValue::Array(items) => {
            return Err(params_error(if items.is_empty() {
                "invalid length 0, expected struct FileSystemSandboxContext with 9 elements"
            } else {
                "invalid type: sequence, expected struct FileSystemSandboxContext"
            }));
        }
        PValue::Object(_) => {}
        other => {
            return Err(params_error(format!(
                "invalid type: {}, expected struct FileSystemSandboxContext",
                unexpected(other)
            )));
        }
    }
    let PValue::Object(object) = value else {
        unreachable!()
    };
    for (key, field) in object.iter() {
        match key.as_str() {
            Some("permissions") => {
                if matches!(field, PValue::Array(_)) {
                    return Err(params_error("missing field `type`"));
                }
                let PValue::Object(record) = field else {
                    return Err(params_error(format!(
                        "invalid type: {}, expected internally tagged enum ExecPermissionProfile",
                        tagged_unexpected(field)
                    )));
                };
                let Some(kind) = object_get(record, "type") else {
                    return Err(params_error("missing field `type`"));
                };
                if let PValue::String(kind) = kind
                    && !kind
                        .as_str()
                        .is_some_and(|kind| ["managed", "disabled", "external"].contains(&kind))
                {
                    return Err(params_error(concat(&[
                        &"unknown variant `".into(),
                        kind,
                        &format!(
                            "`, expected one of {}",
                            variants(&["managed", "disabled", "external"])
                        )
                        .into(),
                    ])));
                }
            }
            Some("cwd") => {
                decode_path_uri(field)?;
            }
            Some("workspaceRoots" | "temporaryDirectories") => {
                if key.as_str() == Some("temporaryDirectories") && matches!(field, PValue::Null) {
                    continue;
                }
                let PValue::Array(items) = field else {
                    return Err(params_error(format!(
                        "invalid type: {}, expected a sequence",
                        unexpected(field)
                    )));
                };
                for item in items {
                    decode_path_uri(item)?;
                }
            }
            Some("userHomeDir") => {
                if !matches!(field, PValue::Null) {
                    decode_path_uri(field)?;
                }
            }
            Some("windowsSandboxLevel") => match field {
                PValue::String(level) => {
                    if !level.as_str().is_some_and(|level| {
                        ["disabled", "restricted-token", "elevated", "mxc"].contains(&level)
                    }) {
                        return Err(params_error(concat(&[
                            &"unknown variant `".into(),
                            level,
                            &format!(
                                "`, expected one of {}",
                                variants(&["disabled", "restricted-token", "elevated", "mxc"])
                            )
                            .into(),
                        ])));
                    }
                }
                PValue::Object(_) => {}
                other => {
                    return Err(params_error(format!(
                        "invalid type: {}, expected string or map",
                        unexpected(other)
                    )));
                }
            },
            Some("useLegacyLandlock") if !matches!(field, PValue::Bool(_)) => {
                return Err(params_error(format!(
                    "invalid type: {}, expected a boolean",
                    unexpected(field)
                )));
            }
            _ => {}
        }
    }
    for required in ["permissions", "cwd", "windowsSandboxLevel"] {
        if object_get(object, required).is_none() {
            return Err(params_error(format!("missing field `{required}`")));
        }
    }
    Ok(Some(value.clone()))
}
pub fn decode_discover_v2_params(params: &PValue) -> Result<Option<PValue>, ExecutorError> {
    let mut sandbox = None;
    match params {
        PValue::Array(items) => {
            if items.is_empty() {
                return Err(params_error(
                    "invalid length 0, expected struct DiscoverV2CapabilitiesRequest with 2 elements",
                ));
            }
            decode_path_uri(&items[0])?;
            if items.len() > 1 {
                sandbox = decode_sandbox(&items[1])?;
            }
            if items.len() > 2 {
                return Err(params_error(format!(
                    "invalid length {}, expected fewer elements in array",
                    items.len()
                )));
            }
        }
        PValue::Object(object) => {
            let mut cwd = false;
            for (key, value) in object.iter() {
                if key.as_str() == Some("cwd") {
                    decode_path_uri(value)?;
                    cwd = true;
                } else if key.as_str() == Some("sandbox") {
                    sandbox = decode_sandbox(value)?;
                }
            }
            if !cwd {
                return Err(params_error("missing field `cwd`"));
            }
        }
        other => {
            return Err(params_error(format!(
                "invalid type: {}, expected struct DiscoverV2CapabilitiesRequest",
                unexpected(other)
            )));
        }
    }
    Ok(sandbox)
}

pub struct CapabilityDiscoveryV2 {
    source: Arc<dyn ReadTreeSource>,
    environment: DiscoveryEnvironment,
    closed: std::sync::atomic::AtomicBool,
}
impl CapabilityDiscoveryV2 {
    pub fn new(source: Arc<dyn ReadTreeSource>, environment: DiscoveryEnvironment) -> Self {
        Self {
            source,
            environment,
            closed: std::sync::atomic::AtomicBool::new(false),
        }
    }
    pub async fn discover(
        &self,
        params: &PValue,
        ctx: &HandlerContext,
    ) -> Result<DiscoverV2Result, ExecutorError> {
        if self.closed.load(std::sync::atomic::Ordering::Acquire) {
            return Err(ExecutorError::new(-32603, "capability discovery closed"));
        }
        let sandbox = decode_discover_v2_params(params)?;
        let run = async {
            let request = resolve_location_request(&self.environment)
                .await
                .map_err(|message| ExecutorError::new(-32603, message))?;
            let locations = prewarm_locations(&self.source, &request, ctx).await?;
            load_capability_discoveries(&self.source, &locations, sandbox, ctx).await
        };
        run.await
            .map_err(|error| ExecutorError::new(-32603, io_text(&error)))
    }
    pub fn close(&self) {
        self.closed
            .store(true, std::sync::atomic::Ordering::Release);
    }
}
