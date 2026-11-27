use super::{Error, Service, adapter, error, key, literal, package, scan_index};
use crate::resources::{
    memory::format::tokens,
    recall::{
        candidate::Query,
        document::{Document, Fields, Kind, Lifecycle, Scope, Source},
        hybrid::{Calibration, Retriever},
        index::Entry,
    },
};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use ycoding_schema::{DomainDecode, JsonValue, project, project_artifact};
use ycoding_store::artifacts;

pub const MAX_RESULTS: usize = 20;
const MAX_CANDIDATES: usize = 1000;

#[derive(Clone, Copy)]
pub struct SearchInput<'a> {
    pub project_id: &'a project::Id,
    pub query: &'a str,
    pub tags: &'a [project_artifact::Tag],
    pub kind: Option<&'a project_artifact::Kind>,
    pub limit: usize,
}
#[derive(Clone, Debug, PartialEq)]
pub struct SearchHit {
    pub kind: project_artifact::Kind,
    pub id: project_artifact::Id,
    pub name: project_artifact::DisplayName,
    pub description: project_artifact::Description,
    pub tags: Vec<project_artifact::Tag>,
    pub stage: project_artifact::Stage,
    pub version_id: project_artifact::VersionId,
    pub content_digest: project_artifact::Digest,
}

impl Service {
    pub fn search(&self, input: SearchInput<'_>) -> Result<Vec<SearchHit>, Error> {
        if input.project_id.as_lossless().as_str() == Some("global") {
            return Err(error("ProjectIdentityUnavailable"));
        }
        let terms = tokens(input.query).map_err(|_| error("InvalidArtifact"))?;
        if terms.is_empty() && input.tags.is_empty() {
            return Err(error("InvalidArtifact"));
        }
        let snapshot = self.client.snapshot()?;
        let Some(member) = scan_index::<artifacts::ProjectScopeTable>(
            &snapshot,
            "project_artifact_project_scope_project_id_idx",
            &key(input.project_id.as_lossless()),
        )?
        .into_iter()
        .next() else {
            return Ok(Vec::new());
        };
        let scope_id = project_artifact::ScopeId::decode(&JsonValue::String(member.scope_id))
            .map_err(|_| error("ReconciliationRequired"))?;
        let scope = self.scope_from_snapshot(&snapshot, &scope_id)?;
        let project_artifact::Scope::Project(project_scope) = &scope else {
            return Err(error("InvalidScope"));
        };
        if &project_scope.project_id != input.project_id {
            return Err(error("InvalidScope"));
        }
        let trashed = super::scan_all::<artifacts::TrashTable>(&snapshot)?;
        let mut candidates = Vec::new();
        for artifact in scan_index::<artifacts::ArtifactTable>(
            &snapshot,
            "project_artifact_scope_stage_kind_updated_idx",
            &key(scope_id.as_lossless()),
        )? {
            if !matches!(artifact.stage.as_str(), Some("trial" | "active"))
                || input
                    .kind
                    .is_some_and(|kind| artifact.kind != *kind.as_lossless())
                || trashed.iter().any(|trash| {
                    trash.scope_id == artifact.scope_id
                        && trash.kind == artifact.kind
                        && trash.artifact_id == artifact.artifact_id
                })
            {
                continue;
            }
            let Some(version) = snapshot
                .get::<artifacts::VersionTable>(&key(&artifact.current_version_id))?
                .filter(|version| {
                    version.scope_id == artifact.scope_id
                        && version.kind == artifact.kind
                        && version.artifact_id == artifact.artifact_id
                })
            else {
                continue;
            };
            let Ok(content) = self.read_content(&scope, &artifact, &version) else {
                continue;
            };
            if package::sha256(&content.as_str().into()).as_lossless() != &version.content_digest {
                continue;
            }
            let (Ok(kind), Ok(id), Ok(stage), Ok(version_id), Ok(content_digest)) = (
                project_artifact::Kind::decode(&JsonValue::String(artifact.kind.clone())),
                project_artifact::Id::decode(&JsonValue::String(artifact.artifact_id.clone())),
                project_artifact::Stage::decode(&JsonValue::String(artifact.stage.clone())),
                project_artifact::VersionId::decode(&JsonValue::String(version.id.clone())),
                project_artifact::Digest::decode(&JsonValue::String(
                    version.content_digest.clone(),
                )),
            ) else {
                continue;
            };
            let Ok(definition) = adapter::parse(&kind, &content) else {
                continue;
            };
            let (name, description, tags) = match definition {
                project_artifact::Definition::Skill(value) => {
                    (value.name, value.description, value.tags)
                }
                project_artifact::Definition::Command(value) => {
                    (value.name, value.description, value.tags)
                }
                project_artifact::Definition::Agent(value) => {
                    (value.name, value.description, value.tags)
                }
                project_artifact::Definition::Plugin(_) => continue,
            };
            if !input.tags.iter().all(|tag| tags.contains(tag)) {
                continue;
            }
            candidates.push(SearchHit {
                kind,
                id,
                name,
                description,
                tags,
                stage,
                version_id,
                content_digest,
            });
            if candidates.len() == MAX_CANDIDATES {
                break;
            }
        }
        let limit = input.limit.clamp(1, MAX_RESULTS);
        if terms.is_empty() {
            candidates.sort_by(|a, b| {
                a.id.as_lossless()
                    .as_str()
                    .cmp(&b.id.as_lossless().as_str())
            });
            candidates.truncate(limit);
            return Ok(candidates);
        }
        let documents = candidates
            .iter()
            .map(|hit| {
                let id = format!(
                    "{}/{}",
                    hit.kind.as_lossless().as_str().unwrap_or(""),
                    hit.id.as_lossless().as_str().unwrap_or("")
                );
                let hash = hit
                    .content_digest
                    .as_lossless()
                    .as_str()
                    .unwrap_or("")
                    .to_owned();
                Document {
                    source: Source {
                        path: id.clone(),
                        revision: hash.clone(),
                        content_hash: hash,
                    },
                    id,
                    kind: Kind::Skill,
                    scope: Scope::Project,
                    fields: Fields {
                        title: hit.name.as_lossless().to_utf8().unwrap_or_default(),
                        description: hit.description.as_lossless().to_utf8().unwrap_or_default(),
                        tags: hit
                            .tags
                            .iter()
                            .map(|tag| literal(tag).to_utf8().unwrap_or_default())
                            .collect(),
                        ..Fields::default()
                    },
                    lifecycle: Lifecycle::default(),
                }
            })
            .collect::<Vec<_>>();
        let manifest = documents
            .iter()
            .map(|document| Entry {
                scope: document.scope,
                kind: document.kind,
                id: document.id.clone(),
                hash: document.source.content_hash.clone(),
            })
            .collect::<Vec<_>>();
        let by_id = documents
            .iter()
            .map(|document| (document.id.as_str(), document))
            .collect::<HashMap<_, _>>();
        let retriever = Retriever::open(None, None, Calibration::default());
        retriever
            .sync(
                &manifest,
                |entry| {
                    by_id
                        .get(entry.id.as_str())
                        .map(|document| (*document).clone())
                },
                Instant::now() + Duration::from_secs(60),
            )
            .map_err(|_| error("StorageUnavailable"))?;
        let positions = documents
            .iter()
            .enumerate()
            .map(|(index, document)| (document.id.as_str(), index))
            .collect::<HashMap<_, _>>();
        Ok(retriever
            .search(&Query {
                text: input.query.to_owned(),
                kinds: vec![Kind::Skill],
                limit,
                ..Query::default()
            })
            .candidates
            .iter()
            .filter_map(|candidate| positions.get(candidate.id.as_str()))
            .map(|index| candidates[*index].clone())
            .collect())
    }
}
