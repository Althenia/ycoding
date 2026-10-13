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
        }
    }
    pub fn from_entries(
        entries: &[Entry],
        directory: &Path,
        home: &Path,
        cache: &Path,
    ) -> Result<Self, Error> {
        let mut service = Self::new(cache);
        for ecosystem in [true, false] {
            for entry in entries {
                let path = match entry {
                    Entry::ClaudeDirectory(path) if ecosystem => path,
                    Entry::AgentsDirectory(path) if !ecosystem => path,
                    _ => continue,
                };
                service.source(Source::Directory(DirectorySource {
                    path: absolute_path(&path.join("skills"))?,
                }));
            }
        }
        for entry in entries {
            let Entry::Directory(path) = entry else {
                continue;
            };
            for name in ["skill", "skills"] {
                service.source(Source::Directory(DirectorySource {
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
                    service.source(Source::Url(UrlSource { url: item }));
                    continue;
                }
                let path = if let Some(text) = text.strip_prefix("~/") {
                    home.join(text)
                } else {
                    directory.join(text)
                };
                service.source(Source::Directory(DirectorySource {
                    path: absolute_path(&path)?,
                }));
            }
        }
        Ok(service)
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
                Source::Embedded(s) => Some(&s.skill),
                _ => None,
            })
            .collect()
    }
    pub async fn list(&mut self) -> Result<Vec<Info>, Error> {
        self.diagnostics.clear();
        let mut skills: Vec<Info> = Vec::new();
        for source in &self.sources {
            let directories = match source {
                Source::Embedded(s) => {
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
                    let loaded = || -> Result<Option<Info>, String> {
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
                            for key in ["ycoding/slash", "ycoding/autoinvoke"] {
                                if let Some(value) = metadata.get(key)
                                    && let Ok(value) = value.json()
                                {
                                    values.insert(key.into(), value);
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
                        from_frontmatter(
                            &file,
                            &directory,
                            &JsonValue::Object(data),
                            &parsed.content,
                        )
                        .map(Some)
                        .map_err(|e| e.to_string())
                    };
                    match loaded() {
                        Ok(Some(skill)) => insert_skill(&mut skills, skill),
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
        Ok(skills)
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
pub fn scope(info: &Info, project: &Path, roots: &Roots) -> Option<Scope> {
    let location = Path::new(info.location.as_lossless().as_str()?);
    if contains(project, location) {
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
        autoinvoke: flag("ycoding/autoinvoke"),
        conflicts,
        location: absolute_path(filepath)?,
        content: content.into(),
    })
}
