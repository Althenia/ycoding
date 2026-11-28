use super::config::{Entry, Roots};
use crate::platform::filesystem::contains;
use crate::resources::discovery::{
    Diagnostic, Error, Kind, absolute_path, markdown, object, read_text, scan, trim,
};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, instruction,
    skill::{Conflicts, DirectorySource, Info, Source, UrlSource},
};
pub mod builtin;
pub mod discovery;
pub mod document;
pub mod instructions;
pub mod spec;
#[derive(Clone)]
pub struct Service {
    pub event_source: crate::event_feed::EventSource,
    sources: Vec<Source>,
    revision: u64,
    cache: PathBuf,
    pulled: BTreeMap<LosslessString, Vec<PathBuf>>,
    diagnostics: Vec<Diagnostic>,
    capabilities: super::config::capabilities::ConfigCapabilities,
    records: BTreeMap<LosslessString, Record>,
    bundled: BTreeMap<LosslessString, ycoding_schema::JsonObject>,
}
#[derive(Clone)]
struct Record {
    info: Info,
    metadata: ycoding_schema::JsonObject,
    hash: String,
}
impl Service {
    pub fn new(cache: &Path) -> Self {
        Self {
            event_source: Default::default(),
            sources: Vec::new(),
            revision: 0,
            cache: cache.into(),
            pulled: BTreeMap::new(),
            diagnostics: Vec::new(),
            capabilities: Default::default(),
            records: BTreeMap::new(),
            bundled: BTreeMap::new(),
        }
    }
    pub fn from_entries(
        entries: &[Entry],
        directory: &Path,
        home: &Path,
        cache: &Path,
    ) -> Result<Self, Error> {
        let mut service = Self::new(cache);
        service.configure(entries, directory, home)?;
        service.settle_builtins(
            &crate::extension::plugin::disabled_from_entries(entries, directory),
            entries,
            directory,
        )?;
        Ok(service)
    }
    pub fn configure(
        &mut self,
        entries: &[Entry],
        directory: &Path,
        home: &Path,
    ) -> Result<(), Error> {
        self.capabilities = super::config::capabilities::ConfigCapabilities::resolve(entries);
        for ecosystem in [true, false] {
            for entry in entries {
                let path = match entry {
                    Entry::ClaudeDirectory(path) if ecosystem => path,
                    Entry::AgentsDirectory(path) if !ecosystem => path,
                    _ => continue,
                };
                self.source(Source::Directory(DirectorySource {
                    path: absolute_path(&path.join("skills"))?,
                }));
            }
        }
        for entry in entries {
            let Entry::Directory(path) = entry else {
                continue;
            };
            for name in ["skill", "skills"] {
                self.source(Source::Directory(DirectorySource {
                    path: absolute_path(&path.join(name))?,
                }));
            }
        }
        for entry in entries {
            let Entry::Document { info, .. } = entry else {
                continue;
            };
            let Some(items) = object(info)?.get(&"skills".into()) else {
                continue;
            };
            for item in Vec::<LosslessString>::decode(items)? {
                let text = item
                    .as_str()
                    .ok_or_else(|| Error::InvalidPath(directory.into()))?;
                if url::Url::parse(text).is_ok_and(|u| ["http", "https"].contains(&u.scheme())) {
                    self.source(Source::Url(UrlSource { url: item }));
                    continue;
                }
                let path = if let Some(text) = text.strip_prefix("~/") {
                    home.join(text)
                } else {
                    directory.join(text)
                };
                self.source(Source::Directory(DirectorySource {
                    path: absolute_path(&path)?,
                }));
            }
        }
        Ok(())
    }
    pub fn settle_builtins(
        &mut self,
        builtins: &crate::extension::plugin::Builtins,
        entries: &[Entry],
        directory: &Path,
    ) -> Result<(), Error> {
        let bundled = builtin::sources(entries, directory, |key| {
            std::env::var_os(key).map(|value| value.to_string_lossy().into_owned())
        })?;
        self.bundled = builtin::metadata()?;
        let before = self.sources.len();
        self.sources.retain(|source| {
            !bundled.iter().any(|item| match (item, source) {
                (Source::Embedded(item), Source::Embedded(source)) => {
                    item.skill.id == source.skill.id && item.skill.location == source.skill.location
                }
                _ => false,
            })
        });
        let enabled = !builtins.is_disabled("ycoding.skill");
        if enabled {
            self.sources.splice(0..0, bundled);
        }
        if (before != self.sources.len() || enabled)
            && self
                .event_source
                .emit(crate::event_feed::Data::SkillUpdated(Box::new(
                    ycoding_schema::models_dev::Empty,
                )))
                .is_err()
        {
            eprintln!("Skill event publication failed");
        }
        Ok(())
    }
    pub fn source(&mut self, source: Source) {
        if !self.sources.iter().any(|s| s.equals(&source)) {
            self.sources.push(source);
            if self
                .event_source
                .emit(crate::event_feed::Data::SkillUpdated(Box::new(
                    ycoding_schema::models_dev::Empty,
                )))
                .is_err()
            {
                eprintln!("Skill event publication failed");
            }
        }
    }
    pub fn sources(&self) -> &[Source] {
        &self.sources
    }
    pub fn embedded(&self) -> Vec<&Info> {
        self.sources
            .iter()
            .filter_map(|s| match s {
                Source::Embedded(s) if self.allows(&s.skill.id) => Some(&s.skill),
                _ => None,
            })
            .collect()
    }
    pub async fn list_resolved(sources: Vec<Source>) -> Result<Vec<Info>, Error> {
        if sources
            .iter()
            .any(|source| matches!(source, Source::Url(_)))
        {
            return Err(Error::Rejected("Skill source has not been resolved"));
        }
        Self {
            sources,
            ..Self::new(Path::new(""))
        }
        .list()
        .await
    }
    pub async fn list(&mut self) -> Result<Vec<Info>, Error> {
        self.diagnostics.clear();
        self.records.clear();
        let mut skills: Vec<Info> = Vec::new();
        for source in &self.sources {
            let directories = match source {
                Source::Embedded(s) => {
                    self.records.remove(&s.skill.id);
                    if s.skill
                        .location
                        .as_lossless()
                        .as_str()
                        .is_some_and(|location| location.starts_with("/builtin/"))
                        && let Some(metadata) = self.bundled.get(&s.skill.id)
                    {
                        self.records.insert(
                            s.skill.id.clone(),
                            Record {
                                info: s.skill.clone(),
                                metadata: metadata.clone(),
                                hash: document::sha256_hex(
                                    &s.skill.content.to_utf8().unwrap_or_default(),
                                ),
                            },
                        );
                    }
                    insert_skill(&mut skills, s.skill.clone());
                    continue;
                }
                Source::Directory(s) => vec![PathBuf::from(
                    s.path
                        .as_lossless()
                        .as_str()
                        .ok_or_else(|| Error::InvalidPath(self.cache.clone()))?,
                )],
                Source::Url(s) => {
                    if !self.pulled.contains_key(&s.url) {
                        let result = discovery::pull(
                            s.url
                                .as_str()
                                .ok_or(Error::Rejected("Invalid skill source URL"))?,
                            &self.cache,
                        )
                        .await?;
                        self.diagnostics.extend(result.diagnostics);
                        self.pulled.insert(s.url.clone(), result.directories);
                    }
                    self.pulled
                        .get(&s.url)
                        .expect("URL pull was memoized")
                        .clone()
                }
            };
            for directory in directories {
                let files = match scan(&directory, Kind::Skill) {
                    Ok(files) => files,
                    Err(e) => {
                        self.diagnostics.push(Diagnostic {
                            path: directory.display().to_string(),
                            reason: "unavailable".into(),
                            message: e.to_string(),
                        });
                        continue;
                    }
                };
                for file in files {
                    let loaded = || load(&file);
                    match loaded() {
                        Ok(Some((skill, metadata, hash))) => {
                            self.records.insert(
                                skill.id.clone(),
                                Record {
                                    info: skill.clone(),
                                    metadata,
                                    hash,
                                },
                            );
                            insert_skill(&mut skills, skill);
                        }
                        Ok(None) => {}
                        Err(message) => self.diagnostics.push(Diagnostic {
                            path: file.display().to_string(),
                            reason: "invalid-frontmatter".into(),
                            message,
                        }),
                    }
                }
            }
        }
        skills.retain(|skill| self.allows(&skill.id));
        Ok(skills)
    }
    pub fn allows(&self, id: &ycoding_schema::skill::Id) -> bool {
        self.capabilities.skills.allows(id)
    }
    pub fn activation_metadata(&self, info: &Info) -> Option<ycoding_schema::JsonObject> {
        self.records
            .get(&info.id)
            .filter(|record| record.info == *info && self.allows(&info.id))
            .map(|record| activation_view(&record.metadata))
            .filter(|view| !view.is_empty())
    }
    pub fn documents(
        &self,
        skills: &[Info],
        origin: impl Fn(&Info) -> document::Origin,
    ) -> Vec<crate::resources::recall::document::Document> {
        skills
            .iter()
            .filter(|info| self.allows(&info.id))
            .map(|info| {
                let record = self
                    .records
                    .get(&info.id)
                    .filter(|record| record.info == *info);
                document::build(
                    info,
                    record.map(|record| &record.metadata),
                    record.map(|record| record.hash.as_str()),
                    origin(info),
                )
            })
            .collect()
    }
    pub fn mcp(
        &self,
        entries: Vec<ycoding_schema::mcp_skill::Entry>,
    ) -> Vec<ycoding_schema::mcp_skill::Entry> {
        entries
            .into_iter()
            .filter(|entry| self.allows(&super::mcp::skills::id(&entry.server, &entry.uri).into()))
            .collect()
    }
    pub fn diagnostics(&self) -> &[Diagnostic] {
        &self.diagnostics
    }
    pub fn changed(&mut self, file: &Path) -> bool {
        let matched = self.sources.iter().any(|s| match s {
            Source::Directory(s) => s
                .path
                .as_lossless()
                .as_str()
                .is_some_and(|p| file.starts_with(p)),
            _ => false,
        });
        if matched {
            self.revision += 1;
            if self
                .event_source
                .emit(crate::event_feed::Data::SkillUpdated(Box::new(
                    ycoding_schema::models_dev::Empty,
                )))
                .is_err()
            {
                eprintln!("Skill event publication failed");
            }
        }
        matched
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
}
fn insert_skill(skills: &mut Vec<Info>, skill: Info) {
    if let Some(current) = skills.iter_mut().find(|s| s.id == skill.id) {
        *current = skill;
        return;
    }
    skills.push(skill);
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Global,
    Project,
}
pub fn scope(info: &Info, project: Option<&Path>, roots: &Roots) -> Option<Scope> {
    let location = Path::new(info.location.as_lossless().as_str()?);
    if project.is_some_and(|project| contains(project, location)) {
        return Some(Scope::Project);
    }
    [
        roots.home.join(".agents/skills"),
        roots.home.join(".claude/skills"),
        roots.config.join("skills"),
    ]
    .iter()
    .any(|directory| contains(directory, location))
    .then_some(Scope::Global)
}
pub fn available<'a>(skills: &'a [Info], agent: &ycoding_schema::agent::Info) -> Vec<&'a Info> {
    skills
        .iter()
        .filter(|skill| {
            crate::tools::policy::evaluate(&"skill".into(), &skill.id, &agent.permissions)
                .effect
                .0
                != "deny".into()
        })
        .collect()
}

const ACTIVATION_KEYS: [&str; 7] = [
    "activation",
    "version",
    "keywords",
    "events",
    "commands",
    "paths",
    "tags",
];
const METADATA_KEYS: [&str; 16] = [
    "activation",
    "version",
    "keywords",
    "events",
    "commands",
    "paths",
    "display-name",
    "slash",
    "conflicts",
    "tags",
    "purpose",
    "applicability",
    "triggers",
    "capabilities",
    "prerequisites",
    "related",
];
const FRONTMATTER_KEYS: [&str; 5] = [
    "name",
    "description",
    "license",
    "compatibility",
    "allowed-tools",
];

fn load(file: &Path) -> Result<Option<(Info, ycoding_schema::JsonObject, String)>, String> {
    let Some(content) = read_text(file)
        .map_err(|e| e.to_string())?
        .filter(|s| !s.is_empty())
    else {
        return Ok(None);
    };
    let parsed = markdown::parse(&content).map_err(|e| e.to_string())?;
    if !matches!(parsed.data, markdown::Value::Object(_)) {
        return Err("Skill frontmatter must be an object".into());
    }
    let mut data = parsed
        .data
        .fields(&FRONTMATTER_KEYS)
        .map_err(|e| e.to_string())?;
    if let Some(metadata) = parsed.data.get("metadata") {
        match metadata {
            markdown::Value::Object(_) => {
                data.insert(
                    "metadata".into(),
                    JsonValue::Object(metadata_projection(metadata)),
                );
            }
            _ => {
                data.insert("metadata".into(), JsonValue::Null);
            }
        }
    }
    let metadata = match data.get(&"metadata".into()) {
        Some(JsonValue::Object(metadata)) => metadata.clone(),
        _ => ycoding_schema::JsonObject::new(),
    };
    let hash = document::sha256_hex(&content);
    from_frontmatter(file, &JsonValue::Object(data), &parsed.content)
        .map(|info| Some((info, metadata, hash)))
        .map_err(|e| e.to_string())
}

fn metadata_projection(metadata: &markdown::Value) -> ycoding_schema::JsonObject {
    let mut values = ycoding_schema::JsonObject::new();
    for key in METADATA_KEYS.into_iter().chain(["instruction-conflicts"]) {
        if let Some(value) = metadata.get(key) {
            values.insert(key.into(), value.json().unwrap_or(JsonValue::Null));
        }
    }
    values
}

fn activation_view(metadata: &ycoding_schema::JsonObject) -> ycoding_schema::JsonObject {
    let mut view = ycoding_schema::JsonObject::new();
    for key in ACTIVATION_KEYS {
        if let Some(value) = metadata.get(&key.into()) {
            view.insert(key.into(), value.clone());
        }
    }
    view
}

pub fn from_frontmatter(filepath: &Path, data: &JsonValue, content: &str) -> Result<Info, Error> {
    let data = object(data)?;
    let id = filepath
        .parent()
        .and_then(Path::file_name)
        .and_then(|s| s.to_str())
        .ok_or_else(|| Error::InvalidPath(filepath.into()))?;
    if let Some(message) = spec::violation(id, data) {
        return Err(Error::Invalid(message));
    }
    let metadata = data.get(&"metadata".into()).and_then(|v| match v {
        JsonValue::Object(o) => Some(o),
        _ => None,
    });
    let text = |key: &str| {
        metadata
            .and_then(|m| m.get(&key.into()))
            .and_then(|v| match v {
                JsonValue::String(v) => v.as_str().map(trim),
                _ => None,
            })
    };
    let slash = metadata
        .and_then(|m| m.get(&"slash".into()))
        .and_then(|v| match v {
            JsonValue::Bool(v) => Some(*v),
            JsonValue::String(v) => match trim(v.as_str()?).to_lowercase().as_str() {
                "true" => Some(true),
                "false" => Some(false),
                _ => None,
            },
            _ => None,
        });
    let skills = conflict_list(metadata, "conflicts")?;
    let instructions = conflict_list(metadata, "instruction-conflicts")?;
    let conflicts = if skills.is_none() && instructions.is_none() {
        None
    } else {
        Some(Conflicts {
            skills: skills.unwrap_or_default(),
            instructions: instructions
                .unwrap_or_default()
                .iter()
                .map(|v| instruction::Key::decode(&JsonValue::String(v.clone())))
                .collect::<Result<Vec<_>, _>>()?,
        })
    };
    let name = LosslessString::decode(data.get(&"name".into()).expect("validated name"))?;
    Ok(Info {
        id: id.into(),
        name: text("display-name")
            .filter(|v| !v.is_empty())
            .map_or(name, LosslessString::from),
        description: data
            .get(&"description".into())
            .map(LosslessString::decode)
            .transpose()?,
        slash,
        autoinvoke: match metadata.and_then(|m| m.get(&"activation".into())) {
            Some(JsonValue::String(mode)) if mode.as_str() == Some("auto") => {
                Some(crate::session::skill::valid_automatic(&activation_view(
                    metadata.expect("activation lives in metadata"),
                )))
            }
            Some(_) => Some(false),
            None => None,
        },
        conflicts,
        location: absolute_path(filepath)?,
        content: content.into(),
    })
}

fn conflict_list(
    metadata: Option<&ycoding_schema::JsonObject>,
    key: &str,
) -> Result<Option<Vec<LosslessString>>, Error> {
    let Some(value) = metadata.and_then(|m| m.get(&key.into())) else {
        return Ok(None);
    };
    let JsonValue::String(value) = value else {
        return Err(Error::Invalid(format!("Metadata '{key}' must be a string")));
    };
    let value = value
        .to_utf8()
        .map_err(|_| Error::Invalid(format!("Metadata '{key}' must be valid Unicode")))?;
    let mut result: Vec<LosslessString> = Vec::new();
    for item in value.split(',').map(trim) {
        if item.is_empty() {
            return Err(Error::Invalid(format!(
                "Metadata '{key}' must list nonempty comma-separated items"
            )));
        }
        let item = LosslessString::from(item);
        if !result.contains(&item) {
            result.push(item);
        }
    }
    Ok(Some(result))
}
