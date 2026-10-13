use super::{
    Failure, Marker, active_content_path, active_marker_path, commit_journal_path, content_matches,
    directories, exists, failure, lock_key, package_lock, read_commit_journal, read_marker,
    reconcile_prepared_commit, relative_content_path, scope_ownership, uuid, valid_commit_metadata,
};
use crate::resources::project_artifact::filesystem::{self, Hooks};
use std::path::{Path, PathBuf};
use ycoding_schema::{DomainDecode, JsonValue, project_artifact};

pub fn reconcile(root: &Path, filesystem: &Hooks<'_>) -> Result<Vec<Marker>, Failure> {
    let _gate = package_lock(root, "project-artifact:reconcile")?;
    let scope = scope_ownership(root, filesystem)?;
    let mut stages = directories(&root.join("staging"));
    stages.sort();
    for stage in stages {
        if let Some(state) = super::state::read_journal(root, &stage, filesystem) {
            if (&state.current.scope_id, &state.current.storage_id) != (&scope.0, &scope.1)
                || !super::state::valid_metadata(root, &state)
                || state.stage_root != stage
                || Some(state.operation_id.as_str())
                    != stage.file_name().and_then(|name| name.to_str())
            {
                return Err(failure("ReconciliationRequired"));
            }
            let _artifact = package_lock(root, &lock_key(&state.current))?;
            let reloaded = super::state::read_journal(root, &stage, filesystem)
                .ok_or_else(|| failure("ReconciliationRequired"))?;
            if state != reloaded {
                return Err(failure("ReconciliationRequired"));
            }
            super::state::reconcile(&reloaded, filesystem)?;
            continue;
        }
        if exists(&super::state::journal_path(&stage)) {
            return Err(failure("ReconciliationRequired"));
        }
        if let Some(metadata) = read_commit_journal(root, &stage, filesystem) {
            if (&metadata.marker.scope_id, &metadata.marker.storage_id) != (&scope.0, &scope.1)
                || !valid_commit_metadata(root, &metadata)
                || metadata.stage_root != stage
                || Some(metadata.operation_id.as_str())
                    != stage.file_name().and_then(|name| name.to_str())
            {
                return Err(failure("ReconciliationRequired"));
            }
            let _artifact = package_lock(root, &lock_key(&metadata.marker))?;
            let reloaded = read_commit_journal(root, &stage, filesystem)
                .ok_or_else(|| failure("ReconciliationRequired"))?;
            if metadata != reloaded {
                return Err(failure("ReconciliationRequired"));
            }
            reconcile_prepared_commit(root, &reloaded, filesystem)?;
            continue;
        }
        if exists(&commit_journal_path(&stage)) {
            return Err(failure("ReconciliationRequired"));
        }
        let staged_marker = stage.join(".ycoding-project-artifact.json");
        let Some(marker) = read_marker(root, &staged_marker, filesystem)
            .filter(|marker| (&marker.scope_id, &marker.storage_id) == (&scope.0, &scope.1))
        else {
            filesystem::remove(root, &stage, true, filesystem)?;
            continue;
        };
        let _artifact = package_lock(root, &lock_key(&marker))?;
        let active_content = active_content_path(root, &marker.kind, &marker.id);
        let active_marker = active_marker_path(root, &marker.kind, &marker.id);
        let active = read_marker(root, &active_marker, filesystem);
        let staged_content = stage.join(
            marker
                .content_relpath
                .as_lossless()
                .as_str()
                .expect("validated path"),
        );
        if active.is_none()
            && content_matches(root, &active_content, &marker, filesystem)
            && exists(&staged_marker)
        {
            filesystem::move_across(root, root, &staged_marker, &active_marker, filesystem)?;
        } else if active.is_none()
            && !exists(&active_content)
            && content_matches(root, &staged_content, &marker, filesystem)
        {
            filesystem::move_across(root, root, &staged_content, &active_content, filesystem)?;
            filesystem::move_across(root, root, &staged_marker, &active_marker, filesystem)?;
        }
        filesystem::remove(root, &stage, true, filesystem)?;
    }
    let mut trash_directories = directories(&root.join("trash"));
    trash_directories.sort();
    for directory in trash_directories {
        let deletion = project_artifact::DeletionId::decode(&JsonValue::String(
            directory
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| failure("ReconciliationRequired"))?
                .into(),
        ))
        .map_err(|_| failure("ReconciliationRequired"))?;
        let manifest = super::read_trash_manifest(root, &deletion, filesystem)?;
        if (&manifest.scope_id, &manifest.storage_id) != (&scope.0, &scope.1)
            || manifest.deletion_id != deletion
        {
            return Err(failure("ReconciliationRequired"));
        }
        let entry = manifest
            .entries
            .first()
            .ok_or_else(|| failure("OwnershipMismatch"))?;
        let expected = super::trash::entry_marker(&manifest, entry);
        let _artifact = package_lock(root, &lock_key(&expected))?;
        let reloaded = super::read_trash_manifest(root, &deletion, filesystem)?;
        if reloaded != manifest {
            return Err(failure("ReconciliationRequired"));
        }
        super::trash::validate_manifest(root, &manifest, &expected, None, filesystem)?;
        if manifest.phase == super::TrashPhase::Trashed {
            continue;
        }
        super::trash::restore_entries(root, &manifest, filesystem)?;
        filesystem::remove(root, &directory, true, filesystem)?;
    }
    let mut files = walk(root, &root.join("metadata"))?;
    files.sort();
    let mut values = Vec::new();
    for path in files.into_iter().filter(|path| {
        path.extension()
            .is_some_and(|extension| extension == "json")
    }) {
        let relative = path
            .strip_prefix(root.join("metadata"))
            .map_err(|_| failure("ReconciliationRequired"))?
            .components()
            .collect::<Vec<_>>();
        if relative.len() != 2 {
            return Err(failure("ReconciliationRequired"));
        }
        let kind = project_artifact::Kind::decode(&JsonValue::String(
            relative[0]
                .as_os_str()
                .to_str()
                .ok_or_else(|| failure("ReconciliationRequired"))?
                .into(),
        ))
        .map_err(|_| failure("ReconciliationRequired"))?;
        let id = project_artifact::Id::decode(&JsonValue::String(
            path.file_stem()
                .and_then(|name| name.to_str())
                .ok_or_else(|| failure("ReconciliationRequired"))?
                .into(),
        ))
        .map_err(|_| failure("ReconciliationRequired"))?;
        let _artifact = package_lock(root, &super::lock_identity(&scope.0, &kind, &id))?;
        if !exists(&path) {
            continue;
        }
        let value = read_marker(root, &path, filesystem);
        let owned = value.as_ref().is_some_and(|marker| {
            (&marker.scope_id, &marker.storage_id) == (&scope.0, &scope.1)
                && marker.kind == kind
                && marker.id == id
                && active_marker_path(root, &marker.kind, &marker.id) == path
                && marker.content_relpath.as_lossless().as_str()
                    == Some(&relative_content_path(&marker.kind, &marker.id))
        });
        if !owned {
            quarantine(root, &path, value.as_ref(), false, filesystem)?;
            continue;
        }
        let value = value.expect("owned marker");
        if !content_matches(
            root,
            &active_content_path(root, &value.kind, &value.id),
            &value,
            filesystem,
        ) {
            quarantine(root, &path, Some(&value), true, filesystem)?;
            continue;
        }
        values.push(value);
    }
    Ok(values)
}

#[derive(Default)]
pub struct StandardRoots<'a> {
    pub skill: Option<&'a Path>,
    pub command: Option<&'a Path>,
    pub agent: Option<&'a Path>,
}
pub struct StandardReconcileInput<'a> {
    pub root: &'a Path,
    pub scope_id: &'a project_artifact::ScopeId,
    pub storage_id: &'a project_artifact::StorageId,
    pub roots: StandardRoots<'a>,
}
#[derive(Debug, PartialEq)]
pub struct StandardIssue {
    pub kind: project_artifact::Kind,
    pub id: String,
    pub status: &'static str,
    pub ownership: &'static str,
}
pub struct StandardReconciliation {
    pub owned: Vec<Marker>,
    pub issues: Vec<StandardIssue>,
}
pub fn reconcile_standard(
    input: StandardReconcileInput<'_>,
    filesystem: &Hooks<'_>,
) -> Result<StandardReconciliation, Failure> {
    let mut owned = Vec::new();
    let mut issues = Vec::new();
    for (kind, root) in [
        ("skill", input.roots.skill),
        ("command", input.roots.command),
        ("agent", input.roots.agent),
    ] {
        let Some(root) = root else {
            continue;
        };
        let mut ids = Vec::new();
        for entry in super::trash::entries(root) {
            let name = entry.file_name().to_string_lossy().into_owned();
            let id = if kind == "skill" {
                entry
                    .file_type()
                    .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
                    .then_some(name)
            } else {
                name.strip_prefix('.')
                    .and_then(|name| name.strip_suffix(".ycoding-project-artifact.json"))
                    .map(str::to_owned)
                    .or_else(|| {
                        (!name.starts_with('.'))
                            .then(|| name.strip_suffix(".md").map(str::to_owned))
                            .flatten()
                    })
            };
            if let Some(id) = id.filter(|id| !id.is_empty())
                && !ids.contains(&id)
            {
                ids.push(id);
            }
        }
        ids.sort();
        for id in ids {
            let kind_value = project_artifact::Kind::decode(&JsonValue::String(kind.into()))
                .expect("fixed standard kind");
            let artifact_id = project_artifact::Id::decode(&JsonValue::String(id.as_str().into()))
                .map_err(|_| failure("InvalidArtifact"))?;
            let content = if kind == "skill" {
                root.join(&id).join("SKILL.md")
            } else {
                root.join(format!("{id}.md"))
            };
            let metadata = if kind == "skill" {
                root.join(&id).join(".ycoding-project-artifact.json")
            } else {
                root.join(format!(".{id}.ycoding-project-artifact.json"))
            };
            let _gate = package_lock(input.root, "project-artifact:reconcile")?;
            let _artifact = package_lock(
                input.root,
                &super::lock_identity(input.scope_id, &kind_value, &artifact_id),
            )?;
            let has_content = exists(&content);
            let has_marker = exists(&metadata);
            if !has_content && !has_marker {
                continue;
            }
            let value = has_marker
                .then(|| read_marker(root, &metadata, filesystem))
                .flatten();
            let issue = if !has_marker {
                Some(("content-only", "user-owned"))
            } else if value.is_none() {
                Some(("corrupt-marker", "unknown"))
            } else if value.as_ref().is_some_and(|marker| {
                &marker.scope_id != input.scope_id
                    || &marker.storage_id != input.storage_id
                    || marker.kind != kind_value
                    || marker.id != artifact_id
                    || marker.content_relpath.as_lossless().as_str()
                        != Some(&relative_content_path(&kind_value, &artifact_id))
            }) {
                Some(("copied-marker", "unknown"))
            } else if !has_content {
                Some(("marker-only", "owned"))
            } else if !content_matches(
                root,
                &content,
                value.as_ref().expect("decoded marker"),
                filesystem,
            ) {
                Some(("corrupt-marker", "owned"))
            } else {
                None
            };
            if let Some((status, ownership)) = issue {
                issues.push(StandardIssue {
                    kind: kind_value,
                    id,
                    status,
                    ownership,
                });
            } else {
                owned.push(value.expect("valid standard marker"));
            }
        }
    }
    owned.sort_by(|a, b| a.version_id.as_lossless().cmp(b.version_id.as_lossless()));
    Ok(StandardReconciliation { owned, issues })
}
fn quarantine(
    root: &Path,
    path: &Path,
    marker: Option<&Marker>,
    include_content: bool,
    filesystem: &Hooks<'_>,
) -> Result<(), Failure> {
    let destination = root
        .join("quarantine")
        .join(
            marker
                .map(|marker| marker.kind.as_lossless().to_utf8().expect("validated kind"))
                .unwrap_or_else(|| "invalid".into()),
        )
        .join(
            marker
                .map(|marker| marker.id.as_lossless().to_utf8().expect("validated ID"))
                .map_or_else(uuid, Ok)?,
        )
        .join(
            marker
                .map(|marker| {
                    marker
                        .version_id
                        .as_lossless()
                        .to_utf8()
                        .expect("validated version ID")
                })
                .map_or_else(uuid, Ok)?,
        );
    filesystem::mkdir(root, &destination, filesystem)?;
    if exists(path) {
        filesystem::move_across(
            root,
            root,
            path,
            &destination.join(".ycoding-project-artifact.json"),
            filesystem,
        )?;
    }
    if let Some(marker) = marker.filter(|_| include_content) {
        let content = active_content_path(root, &marker.kind, &marker.id);
        if exists(&content) {
            filesystem::move_across(
                root,
                root,
                &content,
                &destination.join(
                    marker
                        .content_relpath
                        .as_lossless()
                        .as_str()
                        .expect("validated path"),
                ),
                filesystem,
            )?;
        }
    }
    Ok(())
}
fn walk(root: &Path, directory: &Path) -> Result<Vec<PathBuf>, Failure> {
    filesystem::assert_safe_path(root, directory)?;
    let mut values = Vec::new();
    for entry in super::trash::entries(directory) {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            values.extend(walk(root, &entry.path())?);
        }
        if kind.is_file() {
            values.push(entry.path());
        }
    }
    Ok(values)
}
