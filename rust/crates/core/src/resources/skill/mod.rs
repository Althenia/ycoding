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
pub mod instructions;
#[derive(Clone)]
pub struct Service {
    pub event_source: crate::event_feed::EventSource,
    sources: Vec<Source>,
    revision: u64,
    cache: PathBuf,
    pulled: BTreeMap<LosslessString, Vec<PathBuf>>,
    diagnostics: Vec<Diagnostic>,
    capabilities: super::config::capabilities::ConfigCapabilities,
    activation: BTreeMap<LosslessString, (Info, ycoding_schema::JsonObject)>,
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
            activation: BTreeMap::new(),
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
        self.activation.clear();
        let mut skills: Vec<Info> = Vec::new();
        for source in &self.sources {
            let directories = match source {
                Source::Embedded(s) => {
                    self.activation.remove(&s.skill.id);
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
                    let loaded =
                        || -> Result<Option<(Info, Option<ycoding_schema::JsonObject>)>, String> {
                            let Some(content) = read_text(&file)
                                .map_err(|e| e.to_string())?
                                .filter(|s| !s.is_empty())
                            else {
                                return Ok(None);
                            };
                            let parsed = markdown::parse(&content).map_err(|e| e.to_string())?;
                            if matches!(
                                parsed.data,
                                markdown::Value::Array(_)
                                    | markdown::Value::String(_)
                                    | markdown::Value::Null
                                    | markdown::Value::Bool(_)
                                    | markdown::Value::Number(_)
                            ) {
                                return Err("Skill frontmatter must be an object".into());
                            }
                            let mut data = parsed
                                .data
                                .fields(&["name", "description", "slash"])
                                .map_err(|e| e.to_string())?;
                            if let Some(metadata) = parsed.data.get("metadata")
                                && let markdown::Value::Object(_) = metadata
                            {
                                let mut values = ycoding_schema::JsonObject::new();
                                for key in [
                                    "ycoding/slash",
                                    "ycoding/autoinvoke",
                                    "activation",
                                    "keywords",
                                    "events",
                                    "commands",
                                    "paths",
                                    "version",
                                ] {
                                    if let Some(value) = metadata.get(key) {
                                        values.insert(
                                            key.into(),
                                            value.json().unwrap_or(JsonValue::Null),
                                        );
                                    }
                                }
                                if let Some(conflicts) = metadata.get("ycoding/conflicts") {
                                    let value = match conflicts {
                                        markdown::Value::Timestamp(_)
                                        | markdown::Value::Binary(_)
                                        | markdown::Value::Cycle => {
                                            JsonValue::Object(Default::default())
                                        }
                                        markdown::Value::Object(_) => JsonValue::Object(
                                            conflicts
                                                .fields(&["skills", "instructions"])
                                                .map_err(|e| e.to_string())?,
                                        ),
                                        _ => conflicts.json().map_err(|e| e.to_string())?,
                                    };
                                    values.insert("ycoding/conflicts".into(), value);
                                }
                                data.insert("metadata".into(), JsonValue::Object(values));
                            }
                            let metadata = match data.get(&"metadata".into()) {
                                Some(JsonValue::Object(metadata)) => Some(metadata.clone()),
                                _ => None,
                            };
                            from_frontmatter(
                                &file,
                                &directory,
                                &JsonValue::Object(data),
                                &parsed.content,
                            )
                            .map(|info| Some((info, metadata)))
                            .map_err(|e| e.to_string())
                        };
                    match loaded() {
                        Ok(Some((skill, metadata))) => {
                            self.activation.remove(&skill.id);
                            if let Some(metadata) = metadata {
                                self.activation
                                    .insert(skill.id.clone(), (skill.clone(), metadata));
                            }
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
        self.activation
            .get(&info.id)
            .and_then(|(current, metadata)| {
                (current == info && self.allows(&info.id)).then(|| metadata.clone())
            })
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

pub fn from_frontmatter(
    filepath: &Path,
    directory: &Path,
    data: &JsonValue,
    content: &str,
) -> Result<Info, Error> {
    let data = object(data)?;
    let id = if filepath.parent() == Some(directory) {
        filepath.file_stem()
    } else {
        filepath.parent().and_then(Path::file_name)
    }
    .and_then(|s| s.to_str())
    .ok_or_else(|| Error::InvalidPath(filepath.into()))?;
    let metadata = data.get(&"metadata".into()).and_then(|v| match v {
        JsonValue::Object(o) => Some(o),
        _ => None,
    });
    let slash = data.get(&"slash".into()).map(bool::decode).transpose()?;
    let flag = |key: &str| {
        metadata
            .and_then(|m| m.get(&key.into()))
            .and_then(|v| match v {
                JsonValue::Bool(v) => Some(*v),
                JsonValue::String(v) => match trim(v.as_str()?).to_lowercase().as_str() {
                    "true" => Some(true),
                    "false" => Some(false),
                    _ => None,
                },
                _ => None,
            })
    };
    let conflicts = metadata
        .and_then(|m| m.get(&"ycoding/conflicts".into()))
        .map(|value| {
            let o = object(value)?;
            let normalize = |key: &str| -> Result<Vec<LosslessString>, Error> {
                let Some(value) = o.get(&key.into()) else {
                    return Ok(Vec::new());
                };
                let mut result = Vec::new();
                for value in Vec::<LosslessString>::decode(value)? {
                    let units = value.code_units().collect::<Vec<_>>();
                    let whitespace = |u: &u16| {
                        char::from_u32(u32::from(*u))
                            .is_some_and(crate::resources::discovery::whitespace)
                    };
                    let start = units
                        .iter()
                        .position(|u| !whitespace(u))
                        .unwrap_or(units.len());
                    let end = units
                        .iter()
                        .rposition(|u| !whitespace(u))
                        .map_or(start, |i| i + 1);
                    if start == end {
                        return Err(ycoding_schema::JsonPath::default()
                            .key(key)
                            .error(ycoding_schema::DecodeErrorKind::Expected("nonempty string"))
                            .into());
                    }
                    let value = LosslessString::from_utf16(units[start..end].to_vec());
                    if !result.contains(&value) {
                        result.push(value);
                    }
                }
                Ok(result)
            };
            Ok::<_, Error>(Conflicts {
                skills: normalize("skills")?,
                instructions: normalize("instructions")?
                    .iter()
                    .map(|v| instruction::Key::decode(&JsonValue::String(v.clone())))
                    .collect::<Result<Vec<_>, _>>()?,
            })
        })
        .transpose()?;
    Ok(Info {
        id: id.into(),
        name: data
            .get(&"name".into())
            .map(LosslessString::decode)
            .transpose()?
            .unwrap_or_else(|| id.into()),
        description: data
            .get(&"description".into())
            .map(LosslessString::decode)
            .transpose()?,
        slash: flag("ycoding/slash").or(slash),
        autoinvoke: match metadata.and_then(|m| m.get(&"activation".into())) {
            Some(JsonValue::String(mode)) if mode.as_str() == Some("auto") => Some(
                metadata.is_some_and(valid_activation) && flag("ycoding/autoinvoke") != Some(false),
            ),
            Some(_) => Some(false),
            None => flag("ycoding/autoinvoke"),
        },
        conflicts,
        location: absolute_path(filepath)?,
        content: content.into(),
    })
}

fn valid_activation(metadata: &ycoding_schema::JsonObject) -> bool {
    ["version", "keywords", "events", "commands", "paths"]
        .into_iter()
        .all(|key| {
            let Some(value) = metadata.get(&key.into()) else {
                return true;
            };
            let JsonValue::String(value) = value else {
                return false;
            };
            let Some(value) = value.as_str() else {
                return false;
            };
            if key == "version" {
                return !value.trim().is_empty();
            }
            value.split(',').map(str::trim).all(|item| {
                !item.is_empty()
                    && (key != "events" || !item.chars().any(char::is_whitespace))
                    && (key != "paths"
                        || !item.contains(['\\', ':'])
                            && item.split('/').all(|part| !matches!(part, "" | "." | "..")))
            })
        })
}
