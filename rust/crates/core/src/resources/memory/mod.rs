use crate::resources::{
    config::Configuration,
    discovery,
    project_artifact::filesystem::{self, Hooks, MutationRequest},
};
use std::{
    collections::BTreeSet,
    fmt, fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
use ycoding_schema::JsonValue;
pub mod boundary;
pub mod format;
mod frontmatter;
pub mod graph;
pub mod instructions;
mod migration;
mod recall;
mod search;
pub use format::{Concept, Summary, Warning};
use format::{parse, require_id, sha256, text_value};

const SIDECAR_LIMIT: usize = 4096;
const GENERATED_INDEX: &str = "Generated index. Edit concept Markdown, not this file.";
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Scope {
    #[default]
    Repository,
    Knowledge,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Limits {
    pub enabled: bool,
    pub path: Option<String>,
    pub max_concept_bytes: usize,
    pub max_bundle_bytes: usize,
    pub max_concepts: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            enabled: true,
            path: None,
            max_concept_bytes: 65_536,
            max_bundle_bytes: 8_388_608,
            max_concepts: 1_000,
        }
    }
}
impl Limits {
    pub fn from_configuration(configuration: &Configuration) -> Self {
        let mut result = Self::default();
        for value in configuration.values("memory") {
            if let JsonValue::Object(value) = value {
                if let Some(JsonValue::Bool(enabled)) = value.get(&"enabled".into()) {
                    result.enabled = *enabled;
                }
                if let Some(JsonValue::String(path)) = value.get(&"path".into()) {
                    result.path = path.as_str().map(String::from);
                }
                for (key, target) in [
                    ("max_concept_bytes", &mut result.max_concept_bytes),
                    ("max_bundle_bytes", &mut result.max_bundle_bytes),
                    ("max_concepts", &mut result.max_concepts),
                ] {
                    if let Some(JsonValue::Number(value)) = value.get(&key.into()) {
                        *target = *value as usize;
                    }
                }
            }
        }
        result
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Repository {
    pub directory: PathBuf,
    pub common_directory: PathBuf,
    pub worktrees: Vec<PathBuf>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepositoryInfo {
    pub id: String,
    pub directory: PathBuf,
    pub common_directory: PathBuf,
    pub worktrees: Vec<PathBuf>,
}
pub struct Options {
    pub directory: PathBuf,
    pub home: PathBuf,
    pub data: PathBuf,
    pub repository: Option<Repository>,
    pub limits: Limits,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct State {
    pub enabled: bool,
    pub scope: Scope,
    pub directory: PathBuf,
    pub base: PathBuf,
    pub root: PathBuf,
    pub knowledge_root: PathBuf,
    pub repository: Option<RepositoryInfo>,
    pub limits: Limits,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Disabled,
    NotFound,
    InvalidConcept,
    InvalidYaml,
    UnterminatedFrontmatter,
    UnsafePath,
    StaleContent,
    TooLarge,
    Unavailable,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
        Self::Disabled => "Workspace memory is disabled.", Self::NotFound => "Concept, trash entry, or Git repository not found.",
        Self::InvalidConcept => "Invalid concept: begin with a --- line, supply a nonempty YAML string type, valid optional metadata, and defined source footnotes.",
        Self::InvalidYaml => "Invalid YAML frontmatter: provide a single YAML mapping with unique keys between the --- lines. Quote a string containing a colon followed by a space.",
        Self::UnterminatedFrontmatter => "Unterminated frontmatter: add a closing --- line after the YAML fields and before the Markdown body. To repair an existing entry, read it first and supply its digest to write.",
        Self::UnsafePath => "Unsafe memory path or changed memory location.", Self::StaleContent => "Content changed or preview is stale; read and supply its current digest.",
        Self::TooLarge => "Workspace memory exceeds a configured concept or bundle limit.", Self::Unavailable => "Workspace memory is unavailable; check storage access and configuration.",
    })
    }
}
impl std::error::Error for Error {}
impl From<io::Error> for Error {
    fn from(_: io::Error) -> Self {
        Self::Unavailable
    }
}
impl From<filesystem::Error> for Error {
    fn from(error: filesystem::Error) -> Self {
        match error {
            filesystem::Error::Unsafe(_) => Self::UnsafePath,
            filesystem::Error::Io(_) => Self::Unavailable,
        }
    }
}

#[derive(Debug)]
pub struct Listing {
    pub concepts: Vec<Summary>,
    pub total: usize,
    pub warnings: Vec<Warning>,
}
#[derive(Debug)]
pub struct ReadResult {
    pub id: String,
    pub content: String,
    pub digest: String,
}
#[derive(Debug)]
pub struct WriteResult {
    pub id: String,
    pub digest: String,
    pub created: bool,
    pub warnings: Vec<Warning>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrashEntry {
    pub id: String,
    pub trash_id: String,
    pub digest: String,
}
#[derive(Debug)]
pub struct TrashListing {
    pub entries: Vec<TrashEntry>,
    pub total: usize,
    pub warnings: Vec<Warning>,
}
#[derive(Debug)]
pub struct DeleteResult {
    pub id: String,
    pub trash_id: String,
    pub digest: String,
    pub warnings: Vec<Warning>,
}
#[derive(Debug)]
pub struct RestoreResult {
    pub id: String,
    pub digest: String,
    pub warnings: Vec<Warning>,
}
#[derive(Debug)]
pub struct PurgeResult {
    pub trash_id: String,
    pub purged: bool,
    pub warnings: Vec<Warning>,
}
#[derive(Debug)]
pub struct VacuumResult {
    pub dry_run: bool,
    pub digest: String,
    pub removed: Vec<String>,
    pub warnings: Vec<Warning>,
}
#[derive(Debug)]
pub struct SearchHit {
    pub summary: Summary,
    pub score: f64,
    pub snippet: ycoding_schema::LosslessString,
    pub(crate) automatic_reason: Option<&'static str>,
}
#[derive(Debug)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    pub warnings: Vec<Warning>,
}
pub struct Search<'a> {
    pub query: &'a str,
    pub limit: Option<usize>,
    pub type_: Option<&'a str>,
    pub tag: Option<&'a str>,
}
pub struct Service {
    options: std::sync::RwLock<Options>,
    indexes: [std::sync::Mutex<recall::Cache>; 2],
}
impl Service {
    pub fn new(options: Options) -> Result<Self, Error> {
        if options.limits.max_concepts == 0
            || options.limits.max_bundle_bytes == 0
            || options.limits.max_concept_bytes == 0
        {
            return Err(Error::InvalidConcept);
        }
        Ok(Self {
            options: std::sync::RwLock::new(options),
            indexes: Default::default(),
        })
    }
    pub fn configure(&self, limits: Limits) -> Result<(), Error> {
        if limits.max_concepts == 0 || limits.max_bundle_bytes == 0 || limits.max_concept_bytes == 0
        {
            return Err(Error::InvalidConcept);
        }
        self.options.write().map_err(|_| Error::Unavailable)?.limits = limits;
        Ok(())
    }
    pub fn status(&self, scope: Scope) -> Result<State, Error> {
        let (state, configured_base) = self.describe(scope)?;
        if state.enabled {
            let verify = |base: &Path| {
                migration::verify_published(base).map_err(|error| match error {
                    migration::MigrationError::Unsafe(_) => Error::UnsafePath,
                    _ => Error::Unavailable,
                })
            };
            if configured_base != state.base
                && let Some((parent, name)) =
                    configured_base.parent().zip(configured_base.file_name())
            {
                let configured_base = canonical(parent)?.join(name);
                if configured_base != state.base {
                    verify(&configured_base)?;
                }
            }
            verify(&state.base)?;
        }
        Ok(state)
    }
    fn describe(&self, scope: Scope) -> Result<(State, PathBuf), Error> {
        let input = self.options.read().map_err(|_| Error::Unavailable)?;
        let directory = fs::canonicalize(&input.directory)?;
        if scope == Scope::Repository && input.repository.is_none() {
            return Err(Error::NotFound);
        }
        let repository = input
            .repository
            .as_ref()
            .map(|repository| {
                let common_directory = canonical(&repository.common_directory)?;
                let directory = canonical(&repository.directory)?;
                let worktrees = if repository.worktrees.is_empty() {
                    vec![directory.clone()]
                } else {
                    repository
                        .worktrees
                        .iter()
                        .map(|p| canonical(p))
                        .collect::<Result<_, _>>()?
                };
                Ok::<_, Error>(RepositoryInfo {
                    id: format!(
                        "repo_{}",
                        sha256(common_directory.to_str().ok_or(Error::UnsafePath)?)
                    ),
                    directory,
                    common_directory,
                    worktrees,
                })
            })
            .transpose()?;
        let anchor = repository
            .as_ref()
            .map(|r| r.worktrees.first().unwrap_or(&r.directory))
            .unwrap_or(&directory);
        let configured_base = match &input.limits.path {
            None => input.data.join("memory"),
            Some(path) => {
                let expanded = if path == "~" {
                    input.home.clone()
                } else if let Some(path) = path.strip_prefix("~/") {
                    input.home.join(path)
                } else {
                    PathBuf::from(path)
                };
                if expanded.is_absolute() {
                    expanded
                } else {
                    anchor.join(expanded)
                }
            }
        };
        let base = canonical(&configured_base)?;
        let knowledge_root = base.join("knowledge");
        let root = if scope == Scope::Knowledge {
            knowledge_root.clone()
        } else {
            base.join("repository")
                .join(&repository.as_ref().ok_or(Error::NotFound)?.id)
        };
        Ok((
            State {
                enabled: input.limits.enabled,
                scope,
                directory,
                base,
                root,
                knowledge_root,
                repository,
                limits: input.limits.clone(),
            },
            configured_base,
        ))
    }
    fn operate(&self, scope: Scope) -> Result<State, Error> {
        let state = self.status(scope)?;
        if !state.enabled {
            return Err(Error::Disabled);
        }
        Ok(state)
    }
    fn require_current(&self, state: &State) -> Result<(), Error> {
        if self.operate(state.scope)? != *state {
            return Err(Error::UnsafePath);
        }
        Ok(())
    }
    pub fn list(
        &self,
        scope: Scope,
        limit: Option<usize>,
        offset: Option<usize>,
    ) -> Result<Listing, Error> {
        self.list_at(&self.describe(scope)?.0, limit, offset)
    }
    pub fn list_at(
        &self,
        state: &State,
        limit: Option<usize>,
        offset: Option<usize>,
    ) -> Result<Listing, Error> {
        self.require_current(state)?;
        let (limit, offset) = page(limit, offset)?;
        let bundle = scan(state)?;
        Ok(Listing {
            total: bundle.concepts.len(),
            concepts: bundle
                .concepts
                .into_iter()
                .skip(offset)
                .take(limit)
                .map(|c| c.summary)
                .collect(),
            warnings: bundle.warnings,
        })
    }
    pub fn read(&self, scope: Scope, id: &str) -> Result<ReadResult, Error> {
        self.read_at(&self.describe(scope)?.0, id)
    }
    pub fn read_at(&self, state: &State, id: &str) -> Result<ReadResult, Error> {
        self.require_current(state)?;
        require_id(id)?;
        let (concept, _) = format::stored(
            id,
            &read_content(state, &state.root.join(format!("{id}.md")))?,
        )?;
        Ok(ReadResult {
            id: id.into(),
            content: concept.content,
            digest: concept.summary.digest,
        })
    }
    pub fn search(&self, scope: Scope, options: Search<'_>) -> Result<SearchResult, Error> {
        self.search_at(&self.describe(scope)?.0, options)
    }
    pub fn search_at(&self, state: &State, options: Search<'_>) -> Result<SearchResult, Error> {
        self.require_current(state)?;
        let limit = options.limit.unwrap_or(10);
        if !(1..=50).contains(&limit)
            || discovery::trim(options.query).is_empty()
            || options.query.encode_utf16().count() > 1024
        {
            return Err(Error::InvalidConcept);
        }
        let bundle = scan(state)?;
        let data = self
            .options
            .read()
            .map_err(|_| Error::Unavailable)?
            .data
            .clone();
        let cache = data
            .join("recall/index")
            .join(sha256(state.root.as_os_str().as_encoded_bytes()));
        if cache.starts_with(&state.root) {
            return Err(Error::UnsafePath);
        }
        let mut index = self.indexes[usize::from(state.scope == Scope::Knowledge)]
            .lock()
            .map_err(|_| Error::Unavailable)?;
        Ok(SearchResult {
            hits: search::rank(
                &mut index,
                &cache,
                bundle.concepts,
                &search::Query {
                    text: options.query,
                    limit,
                    type_: options.type_,
                    tag: options.tag,
                },
            )?,
            warnings: bundle.warnings,
        })
    }
    pub async fn write(
        &self,
        scope: Scope,
        id: &str,
        content: &str,
        expected_digest: Option<&str>,
    ) -> Result<WriteResult, Error> {
        let state = self.operate(scope)?;
        require_id(id)?;
        if content.len() > state.limits.max_concept_bytes {
            return Err(Error::TooLarge);
        }
        let concept = parse(id, content)?;
        create_root(&state.root)?;
        let _lock = lock(&state.root).await?;
        let target = state.root.join(format!("{id}.md"));
        let before = if safe_path(&state.root, &target)? {
            Some(read_content(&state, &target)?)
        } else {
            None
        };
        if before.as_ref().is_some_and(|before| {
            before != content && Some(sha256(before).as_str()) != expected_digest
        }) || before.is_none() && expected_digest.is_some()
        {
            return Err(Error::StaleContent);
        }
        let bundle = scan(&state)?;
        if bundle.count + usize::from(before.is_none()) > state.limits.max_concepts
            || bundle.bytes - before.as_ref().map_or(0, |text| text.len()) + content.len()
                > state.limits.max_bundle_bytes
        {
            return Err(Error::TooLarge);
        }
        create_parents(&state.root, target.parent().ok_or(Error::UnsafePath)?)?;
        if before.as_deref() != Some(content) {
            atomic(&state.root, &target, content)?;
        }
        let digest = concept.summary.digest.clone();
        let mut concepts = bundle
            .concepts
            .into_iter()
            .filter(|c| c.summary.id != id)
            .collect::<Vec<_>>();
        concepts.push(concept);
        concepts.sort_by(|a, b| a.summary.id.cmp(&b.summary.id));
        Ok(WriteResult {
            id: id.into(),
            digest,
            created: before.is_none(),
            warnings: refresh(&state, Some(&concepts), id),
        })
    }
    pub fn trash(
        &self,
        scope: Scope,
        limit: Option<usize>,
        offset: Option<usize>,
    ) -> Result<TrashListing, Error> {
        let state = self.operate(scope)?;
        let (limit, offset) = page(limit, offset)?;
        let trash = list_trash(&state)?;
        Ok(TrashListing {
            total: trash.entries.len(),
            entries: trash.entries.into_iter().skip(offset).take(limit).collect(),
            warnings: trash.warnings,
        })
    }
    pub async fn delete(
        &self,
        scope: Scope,
        id: &str,
        expected_digest: &str,
    ) -> Result<DeleteResult, Error> {
        let state = self.operate(scope)?;
        require_id(id)?;
        require_root(&state.root)?;
        let _lock = lock(&state.root).await?;
        let target = state.root.join(format!("{id}.md"));
        let before = read_content(&state, &target)?;
        if sha256(&before) != expected_digest {
            return Err(Error::StaleContent);
        }
        let trash_id = receipt(id, expected_digest);
        let stored = state.root.join("trash").join(format!("{trash_id}.md"));
        let archived = safe_path(&state.root, &stored)?;
        if !archived {
            let trash = list_trash(&state)?;
            if trash
                .warnings
                .iter()
                .any(|warning| warning.code != "unpaired-trash")
                || trash.entries.len() + 1 > state.limits.max_concepts
                || trash.bytes + before.len() > state.limits.max_bundle_bytes
            {
                return Err(Error::TooLarge);
            }
        }
        scan(&state)?;
        create_parents(&state.root, stored.parent().ok_or(Error::UnsafePath)?)?;
        if archived {
            let (entry, content) = read_trash(&state, &trash_id)?;
            if entry.id != id || content != before {
                return Err(Error::StaleContent);
            }
            filesystem::remove(&state.root, &target, false, &Hooks::default())?;
        } else {
            atomic(
                &state.root,
                &stored.with_extension("json"),
                &format!("{{\"version\":1,\"id\":{}}}\n", json_string(id)),
            )?;
            filesystem::move_across(
                &state.root,
                &state.root,
                &target,
                &stored,
                &Hooks::default(),
            )?;
        }
        Ok(DeleteResult {
            id: id.into(),
            trash_id,
            digest: expected_digest.into(),
            warnings: refresh(&state, None, id),
        })
    }
    pub async fn restore(
        &self,
        scope: Scope,
        trash_id: &str,
        expected_digest: &str,
    ) -> Result<RestoreResult, Error> {
        let state = self.operate(scope)?;
        require_root(&state.root)?;
        let _lock = lock(&state.root).await?;
        let (entry, content) = read_trash(&state, trash_id)?;
        if entry.digest != expected_digest {
            return Err(Error::StaleContent);
        }
        let target = state.root.join(format!("{}.md", entry.id));
        if safe_path(&state.root, &target)? {
            return Err(Error::StaleContent);
        }
        let bundle = scan(&state)?;
        if bundle.count + 1 > state.limits.max_concepts
            || bundle.bytes + content.len() > state.limits.max_bundle_bytes
        {
            return Err(Error::TooLarge);
        }
        create_parents(&state.root, target.parent().ok_or(Error::UnsafePath)?)?;
        filesystem::move_across(
            &state.root,
            &state.root,
            &state.root.join("trash").join(format!("{trash_id}.md")),
            &target,
            &Hooks::default(),
        )?;
        let mut warnings = remove_sidecar(&state, trash_id);
        warnings.extend(refresh(&state, None, &entry.id));
        Ok(RestoreResult {
            warnings,
            id: entry.id,
            digest: entry.digest,
        })
    }
    pub async fn purge(
        &self,
        scope: Scope,
        trash_id: &str,
        expected_digest: &str,
    ) -> Result<PurgeResult, Error> {
        let state = self.operate(scope)?;
        require_root(&state.root)?;
        let _lock = lock(&state.root).await?;
        let (entry, _) = read_trash(&state, trash_id)?;
        if entry.digest != expected_digest {
            return Err(Error::StaleContent);
        }
        filesystem::remove(
            &state.root,
            &state.root.join("trash").join(format!("{trash_id}.md")),
            false,
            &Hooks::default(),
        )?;
        let mut warnings = remove_sidecar(&state, trash_id);
        warnings.extend(refresh(&state, None, &entry.id));
        Ok(PurgeResult {
            trash_id: trash_id.into(),
            purged: true,
            warnings,
        })
    }
    pub async fn vacuum(
        &self,
        scope: Scope,
        dry_run: Option<bool>,
        expected_digest: Option<&str>,
    ) -> Result<VacuumResult, Error> {
        let state = self.operate(scope)?;
        let dry_run = dry_run.unwrap_or(true);
        if !safe_path(&state.root, &state.root)? {
            let digest = inventory_digest(&[], &[], &[]);
            if !dry_run {
                if expected_digest != Some(digest.as_str()) {
                    return Err(Error::StaleContent);
                }
                create_root(&state.root)?;
            }
            return Ok(VacuumResult {
                dry_run,
                digest,
                removed: Vec::new(),
                warnings: Vec::new(),
            });
        }
        if !dry_run && expected_digest.is_none() {
            return Err(Error::StaleContent);
        }
        let _lock = if dry_run {
            None
        } else {
            create_root(&state.root)?;
            Some(lock(&state.root).await?)
        };
        let bundle = scan(&state)?;
        let trash = list_trash(&state)?;
        let plan = cleanup_plan(&state, &bundle.concepts, &trash.orphans)?;
        let digest = inventory_digest(&plan, &bundle.concepts, &trash.entries);
        if dry_run {
            return Ok(VacuumResult {
                dry_run,
                digest,
                removed: plan.into_iter().map(|(path, _)| path).collect(),
                warnings: bundle.warnings.into_iter().chain(trash.warnings).collect(),
            });
        }
        if expected_digest != Some(digest.as_str()) {
            return Err(Error::StaleContent);
        }
        let mut removed = Vec::new();
        let mut failures = Vec::new();
        for (path, _) in plan {
            let target = state.root.join(&path);
            let committed = safe_path(&state.root, &target).and_then(|exists| {
                if exists {
                    filesystem::remove(&state.root, &target, false, &Hooks::default())?;
                }
                Ok(())
            });
            if committed.is_ok() {
                removed.push(path);
            } else {
                failures.push(warning(&path, "vacuum-incomplete"));
            }
        }
        let mut directories = removed
            .iter()
            .filter_map(|path| Path::new(path).parent())
            .filter(|path| !path.as_os_str().is_empty())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        directories.sort_by_key(|path| std::cmp::Reverse(path.as_os_str().len()));
        for path in directories {
            let target = state.root.join(path);
            if fs::read_dir(&target).is_ok_and(|mut entries| entries.next().is_none()) {
                let _ = fs::remove_dir(target);
            }
        }
        let rebuilt = indexes(&state, &bundle.concepts)
            .err()
            .map(|_| warning("", "index-out-of-date"));
        let warnings = bundle
            .warnings
            .into_iter()
            .chain(trash.warnings.into_iter().filter(|warning| {
                warning.code != "unreadable-trash"
                    || !removed.contains(&format!("trash/{}.json", warning.id))
            }))
            .chain(failures)
            .chain(rebuilt)
            .collect();
        Ok(VacuumResult {
            dry_run,
            digest,
            removed,
            warnings,
        })
    }
}

fn page(limit: Option<usize>, offset: Option<usize>) -> Result<(usize, usize), Error> {
    let limit = limit.unwrap_or(20);
    let offset = offset.unwrap_or(0);
    if !(1..=100).contains(&limit) || offset as u64 > 9_007_199_254_740_991 {
        return Err(Error::InvalidConcept);
    }
    Ok((limit, offset))
}
fn canonical(path: &Path) -> Result<PathBuf, Error> {
    let path = discovery::absolute(path).map_err(|_| Error::UnsafePath)?;
    match fs::canonicalize(&path) {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(canonical(path.parent().ok_or(Error::UnsafePath)?)?
                .join(path.file_name().ok_or(Error::UnsafePath)?))
        }
        Err(error) => Err(error.into()),
    }
}
fn safe_path(root: &Path, target: &Path) -> Result<bool, Error> {
    let relative = target.strip_prefix(root).map_err(|_| Error::UnsafePath)?;
    if relative
        .components()
        .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(Error::UnsafePath);
    }
    match fs::symlink_metadata(root) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
        Ok(_) => {}
    }
    filesystem::assert_safe_path(root, target)?;
    match fs::symlink_metadata(target) {
        Ok(_) => {
            if fs::canonicalize(target)? != target {
                return Err(Error::UnsafePath);
            }
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}
fn require_root(root: &Path) -> Result<(), Error> {
    if !safe_path(root, root)? {
        return Err(Error::NotFound);
    }
    Ok(())
}
fn create_root(root: &Path) -> Result<(), Error> {
    let parent = root.parent().ok_or(Error::UnsafePath)?;
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(parent)?;
    if fs::canonicalize(parent)? != parent {
        return Err(Error::UnsafePath);
    }
    if !safe_path(root, root)? {
        builder.create(root)?;
    }
    if !fs::metadata(root)?.is_dir() {
        return Err(Error::UnsafePath);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
    }
    create_parents(root, &root.join(".locks"))?;
    Ok(())
}
fn create_parents(root: &Path, directory: &Path) -> Result<(), Error> {
    let mut current = root.to_path_buf();
    for component in directory
        .strip_prefix(root)
        .map_err(|_| Error::UnsafePath)?
        .components()
    {
        current.push(component);
        if safe_path(root, &current)? {
            continue;
        }
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&current) {
            Ok(()) => {}
            Err(e)
                if e.kind() == io::ErrorKind::AlreadyExists
                    && safe_path(root, &current)?
                    && fs::symlink_metadata(&current)?.is_dir() => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
async fn lock(root: &Path) -> Result<fs::File, Error> {
    create_parents(root, &root.join(".locks"))?;
    let target = root.join(".locks/collection.lock");
    safe_path(root, &target)?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(target)?;
    let started = Instant::now();
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(fs::TryLockError::WouldBlock) => {}
            Err(_) => return Err(Error::Unavailable),
        }
        if started.elapsed() >= Duration::from_secs(300) {
            return Err(Error::Unavailable);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
fn read_bounded(target: &Path, limit: usize) -> Result<String, Error> {
    let info = fs::symlink_metadata(target)?;
    if !info.is_file() || info.is_symlink() {
        return Err(Error::UnsafePath);
    }
    if info.len() > limit as u64 {
        return Err(Error::TooLarge);
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(target_os = "macos")]
        options.custom_flags(0x100);
        #[cfg(target_os = "linux")]
        options.custom_flags(0x20000);
    }
    let file = options.open(target)?;
    if !file.metadata()?.is_file() {
        return Err(Error::UnsafePath);
    }
    let mut bytes = Vec::new();
    file.take(info.len() + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 != info.len() {
        return Err(Error::StaleContent);
    }
    String::from_utf8(bytes).map_err(|_| Error::InvalidConcept)
}
fn read_content(state: &State, target: &Path) -> Result<String, Error> {
    if !safe_path(&state.root, target)? {
        return Err(Error::NotFound);
    }
    read_bounded(target, state.limits.max_concept_bytes)
}
struct Bundle {
    concepts: Vec<Concept>,
    warnings: Vec<Warning>,
    bytes: usize,
    count: usize,
}
fn scan(state: &State) -> Result<Bundle, Error> {
    let mut bundle = Bundle {
        concepts: Vec::new(),
        warnings: Vec::new(),
        bytes: 0,
        count: 0,
    };
    if !safe_path(&state.root, &state.root)? {
        return Ok(bundle);
    }
    visit(state, &state.root, &mut bundle)?;
    bundle
        .concepts
        .sort_by(|a, b| a.summary.id.cmp(&b.summary.id));
    Ok(bundle)
}
fn entries(directory: &Path) -> Result<Vec<fs::DirEntry>, Error> {
    let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by(|a, b| {
        a.file_name()
            .to_string_lossy()
            .encode_utf16()
            .cmp(b.file_name().to_string_lossy().encode_utf16())
    });
    Ok(entries)
}
fn visit(state: &State, directory: &Path, bundle: &mut Bundle) -> Result<(), Error> {
    if !fs::symlink_metadata(directory)?.is_dir() {
        return Err(Error::UnsafePath);
    }
    for entry in entries(directory)? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.')
            || matches!(
                name.as_str(),
                "index.md" | "log.md" | "graph.html" | "_meta.json" | "trash"
            )
        {
            continue;
        }
        let target = entry.path();
        let id = target
            .strip_prefix(&state.root)
            .map_err(|_| Error::UnsafePath)?
            .to_string_lossy()
            .trim_end_matches(".md")
            .to_owned();
        let info = entry.file_type()?;
        if info.is_symlink() {
            bundle.warnings.push(warning(&id, "unsafe-link"));
            continue;
        }
        if info.is_dir() {
            safe_path(&state.root, &target)?;
            visit(state, &target, bundle)?;
            continue;
        }
        if !name.ends_with(".md") {
            continue;
        }
        bundle.count += 1;
        let bytes = fs::symlink_metadata(&target)?.len() as usize;
        bundle.bytes += bytes;
        if bundle.count > state.limits.max_concepts
            || bytes > state.limits.max_concept_bytes
            || bundle.bytes > state.limits.max_bundle_bytes
        {
            return Err(Error::TooLarge);
        }
        match read_content(state, &target).and_then(|content| format::stored(&id, &content)) {
            Ok((concept, diagnostic)) => {
                bundle.concepts.push(concept);
                if let Some(diagnostic) = diagnostic {
                    bundle.warnings.push(diagnostic);
                }
            }
            Err(Error::TooLarge) => return Err(Error::TooLarge),
            Err(Error::InvalidConcept | Error::InvalidYaml) => {
                bundle.warnings.push(warning(&id, "invalid-concept"))
            }
            Err(_) => bundle.warnings.push(warning(&id, "unreadable-concept")),
        }
    }
    Ok(())
}
fn atomic(root: &Path, target: &Path, content: impl AsRef<[u8]>) -> Result<(), Error> {
    safe_path(root, target)?;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let temporary = target.with_file_name(format!(
        ".{}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    let result = (|| {
        file.write_all(content.as_ref())?;
        file.sync_all()?;
        drop(file);
        filesystem::execute_mutation(
            MutationRequest::Rename {
                source_root: root,
                destination_root: root,
                source: &temporary,
                destination: target,
                replace: true,
            },
            &Hooks::default(),
        )?;
        Ok(())
    })();
    match fs::remove_file(&temporary) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) if result.is_ok() => return Err(error.into()),
        Err(_) => {}
    }
    result
}
fn receipt(id: &str, digest: &str) -> String {
    format!("trash_{}", sha256(format!("{id}\0{digest}")))
}
fn valid_receipt(id: &str) -> bool {
    id.strip_prefix("trash_").is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn read_trash(state: &State, trash_id: &str) -> Result<(TrashEntry, String), Error> {
    if !valid_receipt(trash_id) {
        return Err(Error::NotFound);
    }
    let directory = state.root.join("trash");
    let content = read_content(state, &directory.join(format!("{trash_id}.md")))?;
    let metadata = directory.join(format!("{trash_id}.json"));
    safe_path(&state.root, &metadata)?;
    let text = read_bounded(&metadata, SIDECAR_LIMIT).map_err(|_| Error::NotFound)?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|_| Error::NotFound)?;
    let id = value
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or(Error::NotFound)?;
    require_id(id).map_err(|_| Error::NotFound)?;
    let digest = sha256(&content);
    if receipt(id, &digest) != trash_id {
        return Err(Error::NotFound);
    }
    Ok((
        TrashEntry {
            id: id.into(),
            trash_id: trash_id.into(),
            digest,
        },
        content,
    ))
}
struct Trash {
    entries: Vec<TrashEntry>,
    bytes: usize,
    warnings: Vec<Warning>,
    orphans: Vec<(String, String)>,
}
fn missing(path: &Path) -> Result<bool, Error> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error.into()),
    }
}
fn trash_name(name: &str) -> Option<(&str, bool)> {
    let (id, extension) = name.rsplit_once('.')?;
    valid_receipt(id).then_some(())?;
    match extension {
        "json" => Some((id, false)),
        "md" => Some((id, true)),
        _ => None,
    }
}
fn orphan_receipt(directory: &Path, trash_id: &str) -> Option<(String, String)> {
    let target = directory.join(format!("{trash_id}.json"));
    let info = fs::symlink_metadata(&target).ok()?;
    if !info.is_file() || info.len() > SIDECAR_LIMIT as u64 {
        return None;
    }
    if !missing(&directory.join(format!("{trash_id}.md"))).ok()? {
        return None;
    }
    let text = read_bounded(&target, SIDECAR_LIMIT).ok()?;
    format::is_receipt(&text).then(|| (format!("trash/{trash_id}.json"), sha256(&text)))
}
fn list_trash(state: &State) -> Result<Trash, Error> {
    let directory = state.root.join("trash");
    let mut trash = Trash {
        entries: Vec::new(),
        bytes: 0,
        warnings: Vec::new(),
        orphans: Vec::new(),
    };
    let mut advisory = Vec::new();
    match fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(trash),
        Ok(info) if info.is_symlink() || !info.is_dir() => return Ok(trash),
        Err(error) => return Err(error.into()),
        _ => {}
    }
    if fs::canonicalize(&directory)? != directory {
        return Ok(trash);
    }
    let warning_limit = state.limits.max_concepts.saturating_sub(1);
    for entry in entries(&directory)? {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some((trash_id, archive)) = trash_name(&name) else {
            continue;
        };
        if archive {
            if advisory.len() < state.limits.max_concepts
                && missing(&directory.join(format!("{trash_id}.json")))?
            {
                advisory.push(warning(trash_id, "unpaired-trash"));
            }
            continue;
        }
        if trash.entries.len() >= state.limits.max_concepts {
            trash.warnings.push(warning(trash_id, "trash-limit"));
            break;
        }
        if let Ok((entry, content)) = read_trash(state, trash_id) {
            if trash.bytes + content.len() > state.limits.max_bundle_bytes {
                trash.warnings.push(warning(trash_id, "trash-limit"));
                break;
            }
            trash.bytes += content.len();
            trash.entries.push(entry);
            continue;
        }
        if trash.orphans.len() < state.limits.max_concepts
            && let Some(orphan) = orphan_receipt(&directory, trash_id)
        {
            trash.orphans.push(orphan);
        }
        if trash.warnings.len() >= warning_limit {
            trash.warnings.push(warning(trash_id, "trash-limit"));
            break;
        }
        trash.warnings.push(warning(trash_id, "unreadable-trash"));
    }
    trash
        .entries
        .sort_by(|a, b| format::compare(&a.trash_id, &b.trash_id));
    let room = state
        .limits
        .max_concepts
        .saturating_sub(trash.warnings.len());
    trash.warnings.extend(advisory.into_iter().take(room));
    Ok(trash)
}
fn remove_sidecar(state: &State, trash_id: &str) -> Vec<Warning> {
    let target = state.root.join("trash").join(format!("{trash_id}.json"));
    match safe_path(&state.root, &target).and_then(|exists| {
        if exists {
            filesystem::remove(&state.root, &target, false, &Hooks::default())?;
        }
        Ok(())
    }) {
        Ok(()) => Vec::new(),
        Err(_) => vec![warning(trash_id, "trash-metadata-out-of-date")],
    }
}
fn warning(id: &str, code: &str) -> Warning {
    Warning {
        id: id.into(),
        code: code.into(),
    }
}
fn refresh(state: &State, concepts: Option<&[Concept]>, id: &str) -> Vec<Warning> {
    let bundle = if concepts.is_none() {
        scan(state).ok()
    } else {
        None
    };
    let result = concepts
        .or_else(|| bundle.as_ref().map(|b| b.concepts.as_slice()))
        .ok_or(Error::Unavailable)
        .and_then(|concepts| indexes(state, concepts));
    let graph = filesystem::remove(
        &state.root,
        &state.root.join("graph.html"),
        false,
        &Hooks::default(),
    );
    if result.is_err() || graph.is_err() {
        vec![warning(id, "index-out-of-date")]
    } else {
        Vec::new()
    }
}
fn prefixes(concepts: &[Concept]) -> BTreeSet<String> {
    let mut directories = BTreeSet::from([String::new()]);
    for concept in concepts {
        let parts = concept.summary.id.split('/').collect::<Vec<_>>();
        for i in 1..parts.len() {
            directories.insert(parts[..i].join("/"));
        }
    }
    directories
}
fn indexes(state: &State, concepts: &[Concept]) -> Result<(), Error> {
    for directory in prefixes(concepts) {
        let target = state.root.join(&directory).join("index.md");
        if safe_path(&state.root, &target)?
            && !read_bounded(&target, state.limits.max_bundle_bytes)?.contains(GENERATED_INDEX)
        {
            continue;
        }
        let prefix = if directory.is_empty() {
            String::new()
        } else {
            format!("{directory}/")
        };
        let mut lines = Vec::new();
        if directory.is_empty() {
            if state.scope == Scope::Knowledge {
                lines.extend([
                    "---".into(),
                    "type: Index".into(),
                    "title: Shared knowledge".into(),
                    "---".into(),
                    String::new(),
                ]);
            }
            if state.scope == Scope::Repository {
                let repo = state.repository.as_ref().ok_or(Error::NotFound)?;
                lines.extend([
                    "---".into(),
                    "type: Index".into(),
                    format!("repository: {}", repo.id),
                    "worktrees:".into(),
                ]);
                lines.extend(
                    repo.worktrees
                        .iter()
                        .map(|path| format!("  - {}", json_string(&path.to_string_lossy()))),
                );
                lines.extend(["---".into(), String::new()]);
            }
        }
        lines.push(if !directory.is_empty() {
            format!("# {directory}")
        } else if state.scope == Scope::Knowledge {
            "# Shared knowledge".into()
        } else {
            "# Repository memory".into()
        });
        lines.extend([String::new(), GENERATED_INDEX.into(), String::new()]);
        for concept in concepts
            .iter()
            .filter(|c| c.summary.id.starts_with(&prefix))
        {
            let summary = &concept.summary;
            let title = summary
                .title
                .as_ref()
                .map(text_value)
                .unwrap_or_else(|| summary.id.clone())
                .replace('\\', "\\\\")
                .replace('[', "\\[")
                .replace(']', "\\]");
            lines.push(format!(
                "- [{}]({}.md) — {}",
                collapse(&title),
                &summary.id[prefix.len()..],
                collapse(&text_value(&summary.type_))
            ));
        }
        if directory.is_empty() && state.scope == Scope::Repository {
            lines.extend([
                String::new(),
                "Shared knowledge: [../../knowledge/index.md](../../knowledge/index.md)".into(),
            ]);
        }
        lines.push(String::new());
        atomic(&state.root, &target, &lines.join("\n"))?;
    }
    Ok(())
}
fn collapse(text: &str) -> String {
    let mut result = String::new();
    let mut space = false;
    for ch in text.chars() {
        if discovery::whitespace(ch) {
            if !space {
                result.push(' ');
            }
            space = true;
            continue;
        }
        result.push(ch);
        space = false;
    }
    result
}
fn find_obsolete(state: &State, concepts: &[Concept]) -> Result<Vec<(String, String)>, Error> {
    let prefixes = prefixes(concepts);
    let mut result = Vec::new();
    find_obsolete_in(state, &state.root, &prefixes, &mut result)?;
    result.sort_by(|a, b| format::compare(&a.0, &b.0));
    Ok(result)
}
fn cleanup_plan(
    state: &State,
    concepts: &[Concept],
    orphans: &[(String, String)],
) -> Result<Vec<(String, String)>, Error> {
    let mut plan = find_obsolete(state, concepts)?;
    plan.extend(orphans.iter().cloned());
    plan.sort_by(|a, b| format::compare(&a.0, &b.0));
    Ok(plan)
}
fn find_obsolete_in(
    state: &State,
    directory: &Path,
    prefixes: &BTreeSet<String>,
    result: &mut Vec<(String, String)>,
) -> Result<(), Error> {
    for entry in entries(directory)? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "trash" || entry.file_type()?.is_symlink() {
            continue;
        }
        if entry.file_type()?.is_dir() {
            find_obsolete_in(state, &entry.path(), prefixes, result)?;
            continue;
        }
        let relative = directory
            .strip_prefix(&state.root)
            .map_err(|_| Error::UnsafePath)?
            .to_string_lossy();
        if name != "index.md" || prefixes.contains(relative.as_ref()) {
            continue;
        }
        if let Ok(content) = read_bounded(&entry.path(), state.limits.max_bundle_bytes)
            && content.contains(GENERATED_INDEX)
        {
            result.push((
                entry
                    .path()
                    .strip_prefix(&state.root)
                    .map_err(|_| Error::UnsafePath)?
                    .to_string_lossy()
                    .into_owned(),
                sha256(content),
            ));
        }
    }
    Ok(())
}
fn inventory_digest(
    obsolete: &[(String, String)],
    concepts: &[Concept],
    trash: &[TrashEntry],
) -> String {
    let pairs = |pairs: Vec<(&str, &str)>| {
        format!(
            "[{}]",
            pairs
                .into_iter()
                .map(|(a, b)| format!("[{},{}]", json_string(a), json_string(b)))
                .collect::<Vec<_>>()
                .join(",")
        )
    };
    sha256(format!(
        "{{\"removed\":{},\"concepts\":{},\"trash\":{}}}",
        pairs(
            obsolete
                .iter()
                .map(|(a, b)| (a.as_str(), b.as_str()))
                .collect()
        ),
        pairs(
            concepts
                .iter()
                .map(|c| (c.summary.id.as_str(), c.summary.digest.as_str()))
                .collect()
        ),
        pairs(
            trash
                .iter()
                .map(|e| (e.trash_id.as_str(), e.digest.as_str()))
                .collect()
        )
    ))
}
fn json_string(text: &str) -> String {
    ycoding_schema::stringify_json(&JsonValue::String(text.into()))
}
fn json_lossless(text: &ycoding_schema::LosslessString) -> String {
    ycoding_schema::stringify_json(&JsonValue::String(text.clone()))
}
