use super::{
    config::{Entry, Roots},
    discovery::{self, Diagnostic, Error, repository},
};
use std::path::Path;
use ycoding_schema::{
    DomainDecode, JsonValue,
    reference::{self, Info, Source},
};
#[derive(Clone)]
pub struct Service {
    pub event_source: crate::event_feed::EventSource,
    references: Vec<Info>,
}
pub mod instructions;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refresh {
    Cached,
    Fetch,
}

impl Service {
    pub fn materialize(
        &self,
        repositories: &crate::platform::repository_cache::Service,
        refresh: Refresh,
    ) -> Result<
        Vec<crate::platform::repository_cache::Ensured>,
        crate::platform::repository_cache::Error,
    > {
        let mut ensured = Vec::new();
        for reference in &self.references {
            let Source::Git(source) = &reference.source else {
                continue;
            };
            let repository = crate::platform::repository_cache::parse_remote(
                source.repository.as_str().unwrap_or(""),
                None,
            )?;
            if ensured
                .iter()
                .any(|current: &crate::platform::repository_cache::Ensured| {
                    current.repository == repository.label
                })
            {
                continue;
            }
            ensured.push(
                repositories.ensure(crate::platform::repository_cache::EnsureInput {
                    reference: &repository,
                    refresh: refresh == Refresh::Fetch,
                    branch: source.branch.as_ref().and_then(|branch| branch.as_str()),
                })?,
            );
        }
        Ok(ensured)
    }
    pub fn from_infos(references: Vec<Info>) -> Self {
        Self {
            references,
            event_source: Default::default(),
        }
    }
    pub fn from_entries(
        entries: &[Entry],
        directory: &Path,
        roots: &Roots,
        diagnostics: &mut Vec<Diagnostic>,
    ) -> Result<Self, Error> {
        let mut sources = Vec::new();
        for entry in entries {
            let Entry::Document { path, info } = entry else {
                continue;
            };
            let Some(references) = discovery::object(info)?.get(&"references".into()) else {
                continue;
            };
            for (name, value) in discovery::object(references)?.iter() {
                let alias = name.as_str().unwrap_or("");
                if alias.is_empty()
                    || alias
                        .chars()
                        .any(|c| discovery::whitespace(c) || matches!(c, '/' | '`' | ','))
                {
                    diagnostics.push(Diagnostic { path: path.as_ref().map_or_else(|| "YCODING_CONFIG_CONTENT".into(), |p| p.display().to_string()), reason: "invalid-alias".into(), message: "Reference aliases must be nonempty and cannot contain /, whitespace, backticks, or commas".into() });
                    continue;
                }
                let source = source(
                    value,
                    path.as_deref().and_then(Path::parent).unwrap_or(directory),
                    &roots.home,
                )?;
                if let Some((_, current)) = sources.iter_mut().find(|(key, _)| key == name) {
                    *current = source;
                    continue;
                }
                sources.push((name.clone(), source));
            }
        }
        let mut references = Vec::new();
        let mut seen = Vec::new();
        for (name, source) in sources {
            let (path, description, hidden) = match &source {
                Source::Local(s) => (s.path.clone(), s.description.clone(), s.hidden),
                Source::Git(s) => {
                    let input = s.repository.as_str().unwrap_or("");
                    let repo = match repository::parse_remote(input, None) {
                        Ok(repo) => repo,
                        Err(e) => {
                            diagnostics.push(Diagnostic {
                                path: name.to_utf8().unwrap_or_default(),
                                reason: "invalid-repository".into(),
                                message: e.to_string(),
                            });
                            continue;
                        }
                    };
                    if let Some(branch) = &s.branch
                        && !branch.is_empty()
                        && repository::validate_branch(branch.as_str().unwrap_or("")).is_err()
                    {
                        diagnostics.push(Diagnostic {
                            path: name.to_utf8().unwrap_or_default(),
                            reason: "invalid-branch".into(),
                            message: repository::Error::InvalidBranch.to_string(),
                        });
                        continue;
                    }
                    let target = repo.cache_path(&roots.repos);
                    if seen
                        .iter()
                        .any(|(path, branch)| path == &target && branch != &s.branch)
                    {
                        diagnostics.push(Diagnostic {
                            path: name.to_utf8().unwrap_or_default(),
                            reason: "branch-conflict".into(),
                            message:
                                "The same repository cache target cannot use different branches"
                                    .into(),
                        });
                        continue;
                    }
                    seen.push((target.clone(), s.branch.clone()));
                    (
                        discovery::absolute_path(&target)?,
                        s.description.clone(),
                        s.hidden,
                    )
                }
            };
            references.push(Info {
                name,
                path,
                description,
                hidden,
                source,
            });
        }
        Ok(Self::from_infos(references))
    }
    pub fn list(&self) -> &[Info] {
        &self.references
    }
    pub fn replace(&mut self, references: Vec<Info>) -> Result<(), String> {
        self.references = references;
        self.event_source
            .emit(crate::event_feed::Data::ReferenceUpdated(Box::new(
                ycoding_schema::models_dev::Empty,
            )))
    }
}

fn source(value: &JsonValue, directory: &Path, home: &Path) -> Result<Source, Error> {
    let text = match value {
        JsonValue::String(s) => Some(s),
        _ => None,
    };
    let local = text.is_some_and(|s| s.as_str().is_some_and(|s| s.starts_with(['.', '/', '~'])))
        || matches!(value, JsonValue::Object(o) if o.get(&"path".into()).is_some());
    let (value, description, hidden, branch) = if let Some(text) = text {
        (text.clone(), None, None, None)
    } else {
        let o = discovery::object(value)?;
        let value = o
            .get(&if local {
                "path".into()
            } else {
                "repository".into()
            })
            .ok_or_else(|| {
                ycoding_schema::JsonPath::default().error(ycoding_schema::DecodeErrorKind::Missing)
            })?;
        (
            ycoding_schema::LosslessString::decode(value)?,
            o.get(&"description".into())
                .map(ycoding_schema::LosslessString::decode)
                .transpose()?,
            o.get(&"hidden".into()).map(bool::decode).transpose()?,
            o.get(&"branch".into())
                .map(ycoding_schema::LosslessString::decode)
                .transpose()?,
        )
    };
    if !local {
        return Ok(Source::Git(reference::GitSource {
            repository: value,
            branch,
            description,
            hidden,
        }));
    }
    let text = value
        .as_str()
        .ok_or_else(|| Error::InvalidPath(directory.into()))?;
    let path = if let Some(text) = text.strip_prefix("~/") {
        home.join(text)
    } else {
        directory.join(text)
    };
    Ok(Source::Local(reference::LocalSource {
        path: discovery::absolute_path(&path)?,
        description,
        hidden,
    }))
}
