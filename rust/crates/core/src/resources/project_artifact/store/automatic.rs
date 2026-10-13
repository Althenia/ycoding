use super::{
    Error, Remaining, Service, WriteResult, adapter, error, key, package, scan_all, scope_root,
    validation,
};
use icu_normalizer::ComposingNormalizer;
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};
use ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, agent, project, project_artifact, session,
};
use ycoding_store::{TableSpec, artifacts};

pub struct AutomaticWriteInput<'a> {
    pub project_id: project::Id,
    pub session_id: session::Id,
    pub agent_id: Option<agent::Id>,
    pub insight_key: &'a str,
    pub id: &'a str,
    pub definition: &'a JsonValue,
    pub base_version_id: Option<project_artifact::VersionId>,
    pub now: i64,
}
#[derive(Clone)]
pub(super) struct AutomaticContext {
    pub session_id: session::Id,
    pub agent_id: Option<LosslessString>,
    pub insight_digest: project_artifact::Digest,
    pub operation_fingerprint: project_artifact::Digest,
    pub version_id: project_artifact::VersionId,
}
pub(super) struct WriteContext {
    pub now: i64,
    pub global: bool,
    pub automatic: Option<AutomaticContext>,
    pub snapshot: Option<super::SnapshotCommit>,
}
struct Counters {
    session: usize,
    daily: usize,
    artifacts: usize,
    kind_artifacts: usize,
    versions: usize,
    bytes: u64,
}
const DAY: i64 = 86_400_000;

impl Service {
    pub fn write_automatic(&self, input: AutomaticWriteInput<'_>) -> Result<WriteResult, Error> {
        let errors = validation::validate_automatic(
            &JsonValue::String(input.id.into()),
            input.definition,
            &[],
        );
        if let Some(first) = errors.first() {
            return Err(Error {
                code: first.code.clone(),
            });
        }
        if let Some(first) = validation::validate_text(
            &JsonValue::String(input.insight_key.into()),
            "insightKey",
            512,
        )
        .first()
        {
            return Err(Error {
                code: first.code.clone(),
            });
        }
        if input.now < 0 {
            return Err(error("InvalidArtifact"));
        }
        let definition = project_artifact::Definition::decode(input.definition)
            .map_err(|_| error("InvalidArtifact"))?;
        let id = super::validate_definition(input.id, &definition)?;
        let kind = adapter::kind(&definition);
        let digest = package::sha256(&adapter::render(&definition));
        let normalized = ComposingNormalizer::new_nfkc().normalize(input.insight_key);
        let lowered = normalized
            .trim_matches(crate::resources::discovery::whitespace)
            .to_lowercase();
        let normalized = lowered
            .split(crate::resources::discovery::whitespace)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        let insight_digest = package::sha256(&normalized.as_str().into());
        let scope = self.resolve_project_scope(&input.project_id)?;
        let root = scope_root(&self.paths.data, &scope.storage_id);
        let _session = package::package_lock(
            &self.paths.data,
            &format!(
                "project-artifact-session:{}",
                input.session_id.as_lossless().as_str().expect("session ID")
            ),
        )?;
        let _scope = package::package_lock(
            &self.paths.data,
            &format!(
                "project-artifact-scope:{}",
                scope.id.as_lossless().as_str().expect("scope ID")
            ),
        )?;
        let now = input.now;
        self.client
            .submit(move |tx| {
                let mut after = None;
                loop {
                    let rows = tx.scan::<artifacts::WriteTable>(
                        after
                            .as_deref()
                            .map_or(std::ops::Bound::Unbounded, std::ops::Bound::Excluded),
                        std::ops::Bound::Unbounded,
                        128,
                    )?;
                    if rows.is_empty() {
                        break;
                    }
                    after = rows.last().map(artifacts::WriteTable::primary_key);
                    for row in rows
                        .into_iter()
                        .filter(|row| row.time_created < now - 30 * DAY)
                    {
                        tx.delete::<artifacts::WriteTable>(&artifacts::WriteTable::primary_key(
                            &row,
                        ))?;
                    }
                }
                Ok(())
            })?
            .wait()?;
        let request = request_fingerprint(
            &scope.id,
            &kind,
            &id,
            input.base_version_id.as_ref(),
            &digest,
        );
        let operation_fingerprint = package::sha256(&crate::resources::discovery::join(
            &[
                scope.id.as_lossless().clone(),
                input.session_id.as_lossless().clone(),
                insight_digest.as_lossless().clone(),
                request.as_lossless().clone(),
            ],
            "\0",
        ));
        let operation_id = format!(
            "pop_{}",
            &operation_fingerprint
                .as_lossless()
                .as_str()
                .expect("digest")[..32]
        );
        let version_id = project_artifact::VersionId::decode(&JsonValue::String(
            format!(
                "pav_{}",
                &package::sha256(&operation_id.as_str().into())
                    .as_lossless()
                    .as_str()
                    .expect("digest")[..32]
            )
            .as_str()
            .into(),
        ))
        .expect("version ID");
        let snapshot = self.client.snapshot()?;
        let prior = snapshot.get::<artifacts::WriteTable>(&ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(scope.id.as_lossless()),
            ycoding_store::KeyPart::String(input.session_id.as_lossless()),
            ycoding_store::KeyPart::String(insight_digest.as_lossless()),
        ]))?;
        if let Some(prior) = prior {
            let version = snapshot
                .get::<artifacts::VersionTable>(&key(&prior.version_id))?
                .ok_or_else(|| error("VersionConflict"))?;
            let base = if prior.result.as_str() == Some("created") {
                None
            } else if prior.result.as_str() == Some("reconciled") {
                Some(version.id.clone())
            } else {
                version.parent_version_id.clone()
            };
            if prior.content_digest != *digest.as_lossless()
                || version.content_digest != *digest.as_lossless()
                || version.kind != *kind.as_lossless()
                || version.artifact_id != *id.as_lossless()
                || base.as_ref() != input.base_version_id.as_ref().map(|id| id.as_lossless())
            {
                return Err(error("VersionConflict"));
            }
            cleanup_completed(&root, &operation_id)?;
            return self.automatic_result(&scope, &kind, &id, &prior, now);
        }
        let old = snapshot.get::<artifacts::ArtifactTable>(&artifacts::identity(
            scope.id.as_lossless(),
            kind.as_lossless(),
            id.as_lossless(),
        ))?;
        let version = old
            .as_ref()
            .map(|old| snapshot.get::<artifacts::VersionTable>(&key(&old.current_version_id)))
            .transpose()?
            .flatten();
        let recovering = package::read_active(&root, &kind, &id, &super::Hooks::default())?
            .is_some_and(|marker| {
                marker.scope_id == scope.id
                    && marker.storage_id == scope.storage_id
                    && marker.kind == kind
                    && marker.id == id
                    && marker.version_id == version_id
                    && marker.content_digest == digest
                    && fs::read_to_string(package::active_content_path(&root, &kind, &id))
                        .is_ok_and(|content| package::sha256(&content.as_str().into()) == digest)
            });
        let sources = self
            .sources
            .lock()
            .map_err(|_| error("StorageUnavailable"))?;
        if !sources
            .resolve("project", Some(&input.project_id), &kind, &id)
            .is_empty()
        {
            return Err(error("ArtifactCollision"));
        }
        let globals = sources.resolve("global", None, &kind, &id);
        drop(sources);
        let cross = scan_all::<artifacts::ArtifactTable>(&snapshot)?
            .into_iter()
            .find(|row| {
                row.scope_id != *scope.id.as_lossless()
                    && row.kind == *kind.as_lossless()
                    && row.artifact_id == *id.as_lossless()
            });
        if !globals.is_empty() || cross.is_some() {
            let exact = if let (Some(old), Some(cross)) = (&old, &cross) {
                let cross_version =
                    snapshot.get::<artifacts::VersionTable>(&key(&cross.current_version_id))?;
                if let Some(cross_version) = cross_version {
                    let confirmed = scan_all::<artifacts::OperationTable>(&snapshot)?
                        .iter()
                        .any(|operation| {
                            operation.kind == *kind.as_lossless()
                                && operation.artifact_id == *id.as_lossless()
                                && operation.phase.as_str() == Some("finalized")
                                && ((operation.operation.as_str() == Some("shadow")
                                    && operation.scope_id == *scope.id.as_lossless()
                                    && operation.source_scope_id.as_ref() == Some(&cross.scope_id)
                                    && operation.source_version_id.as_ref()
                                        == Some(&cross_version.id)
                                    && operation.source_digest.as_ref()
                                        == Some(&cross_version.content_digest))
                                    || (operation.operation.as_str() == Some("promotion")
                                        && operation.scope_id == cross.scope_id
                                        && operation.source_scope_id.as_ref()
                                            == Some(scope.id.as_lossless())
                                        && operation.target_version_id.as_ref()
                                            == Some(&cross_version.id)
                                        && operation.target_digest.as_ref()
                                            == Some(&cross_version.content_digest)))
                        });
                    old.shadowed_scope_id.as_ref() == Some(&cross.scope_id)
                        && confirmed
                        && !globals.is_empty()
                        && globals.iter().all(|source| {
                            source.managed_scope_id.as_ref().map(|id| id.as_lossless())
                                == Some(&cross.scope_id)
                                && source
                                    .managed_version_id
                                    .as_ref()
                                    .map(|id| id.as_lossless())
                                    == Some(&cross_version.id)
                                && source.managed_digest.as_ref().map(|id| id.as_lossless())
                                    == Some(&cross_version.content_digest)
                        })
                } else {
                    false
                }
            } else {
                false
            };
            if !exact {
                return Err(error("ArtifactCollision"));
            }
        }
        let expected = match (&old, &version, &input.base_version_id) {
            (None, None, None) => None,
            (Some(old), Some(version), Some(base))
                if old.current_version_id == *base.as_lossless() =>
            {
                Some(project_artifact::MutationExpectation {
                    expected_revision: project_artifact::Revision::decode(&JsonValue::Number(
                        old.revision as f64,
                    ))
                    .expect("revision"),
                    expected_version_id: base.clone(),
                    expected_digest: project_artifact::Digest::decode(&JsonValue::String(
                        version.content_digest.clone(),
                    ))
                    .expect("digest"),
                })
            }
            _ => return Err(error("VersionConflict")),
        };
        if let Some(version) = &version
            && version.content_digest == *digest.as_lossless()
        {
            let record = artifacts::AutomaticWrite {
                scope_id: scope.id.as_lossless().clone(),
                session_id: input.session_id.as_lossless().clone(),
                insight_digest: insight_digest.as_lossless().clone(),
                operation: "update".into(),
                result: "reconciled".into(),
                version_id: version.id.clone(),
                content_digest: digest.as_lossless().clone(),
                time_created: now,
            };
            let persisted = record.clone();
            self.client
                .submit(move |tx| artifacts::WriteTable::insert(tx, &persisted))?
                .wait()?;
            return self.automatic_result(&scope, &kind, &id, &record, now);
        }
        let counters = self.counters(&scope.id, &root, &kind, &id, Some(&input.session_id), now)?;
        if !recovering && (counters.session >= 3 || counters.daily >= 10) {
            return Err(error("WriteRateExceeded"));
        }
        let cap = match kind.as_lossless().as_str() {
            Some("skill") => 24,
            Some("command") => 8,
            Some("agent") => 4,
            _ => 0,
        };
        if !recovering
            && ((old.is_none() && (counters.artifacts >= 32 || counters.kind_artifacts >= cap))
                || (old.is_some() && counters.versions >= 16)
                || counters.bytes
                    + adapter::render(&definition)
                        .as_str()
                        .expect("validated content")
                        .len() as u64
                    > 8 * 1024 * 1024)
        {
            return Err(error("ScopeQuotaExceeded"));
        }
        if !recovering
            && version
                .as_ref()
                .is_some_and(|version| now - version.time_created < 3_600_000)
        {
            return Err(error("ArtifactCooldown"));
        }
        drop(snapshot);
        self.write_snapshot(
            &project_artifact::Scope::Project(scope),
            &id,
            &definition,
            expected.as_ref(),
            WriteContext {
                now,
                global: false,
                automatic: Some(AutomaticContext {
                    session_id: input.session_id,
                    agent_id: input.agent_id,
                    insight_digest,
                    operation_fingerprint,
                    version_id,
                }),
                snapshot: None,
            },
        )
    }
    fn automatic_result(
        &self,
        scope: &project_artifact::ProjectScope,
        kind: &project_artifact::Kind,
        id: &project_artifact::Id,
        record: &artifacts::AutomaticWrite,
        now: i64,
    ) -> Result<WriteResult, Error> {
        let session =
            session::Id::decode(&JsonValue::String(record.session_id.clone())).expect("session");
        Ok(WriteResult {
            result: project_artifact::AutomaticWriteResult::decode(&JsonValue::String(
                record.result.clone(),
            ))
            .expect("result"),
            scope_id: scope.id.clone(),
            kind: kind.clone(),
            id: id.clone(),
            version_id: project_artifact::VersionId::decode(&JsonValue::String(
                record.version_id.clone(),
            ))
            .expect("version"),
            content_digest: project_artifact::Digest::decode(&JsonValue::String(
                record.content_digest.clone(),
            ))
            .expect("digest"),
            stage: project_artifact::Stage::decode(&JsonValue::String("trial".into()))
                .expect("stage"),
            remaining: self.remaining(
                &scope.id,
                &scope_root(&self.paths.data, &scope.storage_id),
                kind,
                id,
                Some(&session),
                now,
            )?,
        })
    }
    pub(super) fn remaining(
        &self,
        scope: &project_artifact::ScopeId,
        root: &Path,
        kind: &project_artifact::Kind,
        id: &project_artifact::Id,
        session: Option<&session::Id>,
        now: i64,
    ) -> Result<Remaining, Error> {
        let counters = self.counters(scope, root, kind, id, session, now)?;
        Ok(Remaining {
            session: 3usize.saturating_sub(counters.session) as f64,
            project_daily: 10usize.saturating_sub(counters.daily) as f64,
            project_artifacts: 32usize.saturating_sub(counters.artifacts) as f64,
            versions: 16usize.saturating_sub(counters.versions) as f64,
            bytes: (8u64 * 1024 * 1024).saturating_sub(counters.bytes) as f64,
        })
    }
    fn counters(
        &self,
        scope: &project_artifact::ScopeId,
        root: &Path,
        kind: &project_artifact::Kind,
        id: &project_artifact::Id,
        session: Option<&session::Id>,
        now: i64,
    ) -> Result<Counters, Error> {
        let snapshot = self.client.snapshot()?;
        let writes = scan_all::<artifacts::WriteTable>(&snapshot)?
            .into_iter()
            .filter(|row| {
                row.time_created >= now - 30 * DAY && row.result.as_str() != Some("reconciled")
            })
            .collect::<Vec<_>>();
        let pending = scan_all::<artifacts::OperationTable>(&snapshot)?
            .into_iter()
            .filter(|row| {
                row.scope_id == *scope.as_lossless()
                    && matches!(row.phase.as_str(), Some("preparing" | "available"))
            })
            .collect::<Vec<_>>();
        let trash = scan_all::<artifacts::TrashTable>(&snapshot)?;
        let live = scan_all::<artifacts::ArtifactTable>(&snapshot)?
            .into_iter()
            .filter(|row| {
                row.scope_id == *scope.as_lossless()
                    && !trash.iter().any(|trash| {
                        trash.scope_id == row.scope_id
                            && trash.kind == row.kind
                            && trash.artifact_id == row.artifact_id
                    })
            })
            .collect::<Vec<_>>();
        let creates = pending
            .iter()
            .filter(|row| {
                row.operation.as_str() == Some("create")
                    && !live.iter().any(|artifact| {
                        artifact.kind == row.kind && artifact.artifact_id == row.artifact_id
                    })
            })
            .collect::<Vec<_>>();
        Ok(Counters {
            session: session.map_or(0, |session| {
                writes
                    .iter()
                    .filter(|row| row.session_id == *session.as_lossless())
                    .count()
                    + pending
                        .iter()
                        .filter(|row| {
                            row.automatic_session_id.as_ref() == Some(session.as_lossless())
                        })
                        .count()
            }),
            daily: writes
                .iter()
                .filter(|row| row.scope_id == *scope.as_lossless() && row.time_created >= now - DAY)
                .count()
                + pending
                    .iter()
                    .filter(|row| {
                        row.automatic_session_id.is_some() && row.time_created >= now - DAY
                    })
                    .count(),
            artifacts: live.len() + creates.len(),
            kind_artifacts: live
                .iter()
                .filter(|row| row.kind == *kind.as_lossless())
                .count()
                + creates
                    .iter()
                    .filter(|row| row.kind == *kind.as_lossless())
                    .count(),
            versions: scan_all::<artifacts::VersionTable>(&snapshot)?
                .iter()
                .filter(|row| {
                    row.scope_id == *scope.as_lossless()
                        && row.kind == *kind.as_lossless()
                        && row.artifact_id == *id.as_lossless()
                })
                .count()
                + pending
                    .iter()
                    .filter(|row| {
                        row.operation.as_str() == Some("update")
                            && row.kind == *kind.as_lossless()
                            && row.artifact_id == *id.as_lossless()
                    })
                    .count(),
            bytes: owned_bytes(root),
        })
    }
}
fn request_fingerprint(
    scope: &project_artifact::ScopeId,
    kind: &project_artifact::Kind,
    id: &project_artifact::Id,
    base: Option<&project_artifact::VersionId>,
    digest: &project_artifact::Digest,
) -> project_artifact::Digest {
    package::sha256(&crate::resources::discovery::join(
        &[
            scope.as_lossless().clone(),
            kind.as_lossless().clone(),
            id.as_lossless().clone(),
            if base.is_some() { "update" } else { "create" }.into(),
            base.map_or_else(|| "".into(), |base| base.as_lossless().clone()),
            digest.as_lossless().clone(),
        ],
        "\0",
    ))
}
fn owned_bytes(root: &Path) -> u64 {
    let files = collect_files(root);
    let trash = files
        .iter()
        .filter(|path| {
            path.file_name()
                .is_some_and(|name| name == ".ycoding-trash.json")
        })
        .filter_map(|path| path.parent())
        .collect::<Vec<_>>();
    let mut owned = files
        .iter()
        .filter(|path| {
            path.file_name().is_some_and(|name| {
                [
                    ".ycoding-scope.json",
                    ".ycoding-operation.json",
                    ".ycoding-trash.json",
                ]
                .iter()
                .any(|value| name == *value)
            }) || trash.iter().any(|trash| path.starts_with(trash))
        })
        .cloned()
        .collect::<BTreeSet<_>>();
    for file in &files {
        let marker = fs::read_to_string(file)
            .ok()
            .and_then(|text| ycoding_schema::parse_json(&text).ok())
            .and_then(|value| package::Marker::decode(&value).ok());
        let Some(marker) = marker else {
            continue;
        };
        let content = if *file == package::active_marker_path(root, &marker.kind, &marker.id) {
            package::active_content_path(root, &marker.kind, &marker.id)
        } else {
            file.parent()
                .expect("file parent")
                .join(marker.content_relpath.as_lossless().as_str().expect("path"))
        };
        if fs::read_to_string(&content)
            .is_ok_and(|text| package::sha256(&text.as_str().into()) == marker.content_digest)
        {
            owned.insert(file.clone());
            owned.insert(content);
        }
    }
    owned
        .iter()
        .filter_map(|path| fs::metadata(path).ok())
        .map(|metadata| metadata.len())
        .sum()
}
fn collect_files(root: &Path) -> Vec<PathBuf> {
    fs::read_dir(root)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .flat_map(|entry| {
            let Ok(kind) = entry.file_type() else {
                return Vec::new();
            };
            if kind.is_symlink() {
                return Vec::new();
            }
            if kind.is_dir() {
                return collect_files(&entry.path());
            }
            if kind.is_file() {
                return vec![entry.path()];
            }
            Vec::new()
        })
        .collect()
}
fn cleanup_completed(root: &Path, operation: &str) -> Result<(), Error> {
    for metadata in package::read_commit_transactions(root, &super::Hooks::default())?
        .iter()
        .filter(|metadata| metadata.operation_id == operation)
    {
        package::cleanup_commit_transaction(metadata, &super::Hooks::default())?;
    }
    Ok(())
}
