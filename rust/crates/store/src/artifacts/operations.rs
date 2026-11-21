use super::tables::{
    ActivationTable, Artifact, ArtifactTable, AutomaticWrite, FeedbackTable, GlobalScope,
    GlobalScopeTable, ObservationTable, Operation, OperationTable, ProjectScope, ProjectScopeTable,
    Scope, ScopeTable, Trash, TrashTable, Version, VersionTable, WriteTable, identity,
};
use crate::session::codec::{key, require};
use crate::{Error, IndexCursor, IndexOrder, IndexQuery, Snapshot, TableSpec, Write};
use std::ops::Bound;
use ycoding_schema::LosslessString;

pub(crate) fn reject(tx: &mut Write<'_>, kind: &'static str, message: &'static str) -> Error {
    tx.reject(Error::Domain { kind, message })
}

pub(crate) fn owner(
    tx: &mut Write<'_>,
    version: &LosslessString,
    scope: &LosslessString,
    kind: &LosslessString,
    id: &LosslessString,
    digest: Option<&LosslessString>,
) -> Result<(), Error> {
    if !tx.get::<VersionTable>(&key(version))?.is_some_and(|r| {
        &r.scope_id == scope
            && &r.kind == kind
            && &r.artifact_id == id
            && digest.is_none_or(|d| &r.content_digest == d)
    }) {
        return Err(reject(
            tx,
            "foreign_reference",
            "version owner or digest is missing",
        ));
    }
    Ok(())
}

pub(crate) fn project_scope_references(tx: &mut Write<'_>, r: &ProjectScope) -> Result<(), Error> {
    require::<crate::project::ProjectTable>(tx, &key(&r.project_id))?;
    scope_type(tx, &r.scope_id, "project")
}
pub(crate) fn global_scope_references(tx: &mut Write<'_>, r: &GlobalScope) -> Result<(), Error> {
    scope_type(tx, &r.scope_id, "global")
}
fn scope_type(tx: &mut Write<'_>, id: &LosslessString, type_: &str) -> Result<(), Error> {
    if !tx
        .get::<ScopeTable>(&key(id))?
        .is_some_and(|r| r.type_.as_str() == Some(type_))
    {
        return Err(reject(
            tx,
            "foreign_reference",
            "scope membership has a different parent type",
        ));
    }
    Ok(())
}
pub(crate) fn scope_references(tx: &mut Write<'_>, r: &Scope) -> Result<(), Error> {
    if (tx.get::<ProjectScopeTable>(&key(&r.id))?.is_some() && r.type_.as_str() != Some("project"))
        || (tx.get::<GlobalScopeTable>(&key(&r.id))?.is_some()
            && r.type_.as_str() != Some("global"))
    {
        return Err(reject(
            tx,
            "foreign_reference",
            "scope type is still referenced",
        ));
    }
    Ok(())
}
pub(crate) fn artifact_references(tx: &mut Write<'_>, r: &Artifact) -> Result<(), Error> {
    require::<ScopeTable>(tx, &key(&r.scope_id))?;
    if let Some(shadow) = &r.shadowed_scope_id {
        require::<ScopeTable>(tx, &key(shadow))?;
    }
    owner(
        tx,
        &r.current_version_id,
        &r.scope_id,
        &r.kind,
        &r.artifact_id,
        None,
    )?;
    if let Some(fallback) = &r.fallback_version_id {
        owner(tx, fallback, &r.scope_id, &r.kind, &r.artifact_id, None)?;
    }
    Ok(())
}
pub(crate) fn version_references(tx: &mut Write<'_>, r: &Version) -> Result<(), Error> {
    require::<ArtifactTable>(tx, &identity(&r.scope_id, &r.kind, &r.artifact_id))?;
    if let Some(parent) = &r.parent_version_id
        && parent != &r.id
    {
        owner(tx, parent, &r.scope_id, &r.kind, &r.artifact_id, None)?;
    }
    if let (Some(origin), Some(scope)) = (&r.origin_version_id, &r.origin_scope_id) {
        if origin == &r.id {
            if scope != &r.scope_id {
                return Err(reject(tx, "foreign_reference", "self origin owner differs"));
            }
        } else {
            owner(tx, origin, scope, &r.kind, &r.artifact_id, None)?;
        }
    }
    if let Some(old) = tx.get::<VersionTable>(&key(&r.id))?
        && (old.scope_id != r.scope_id
            || old.kind != r.kind
            || old.artifact_id != r.artifact_id
            || old.content_digest != r.content_digest)
    {
        incoming_version(tx, r)?;
    }
    Ok(())
}
pub(crate) fn trash_references(tx: &mut Write<'_>, r: &Trash) -> Result<(), Error> {
    require::<ArtifactTable>(tx, &identity(&r.scope_id, &r.kind, &r.artifact_id))?;
    owner(
        tx,
        &r.prior_version_id,
        &r.scope_id,
        &r.kind,
        &r.artifact_id,
        None,
    )
}
pub(crate) fn operation_references(tx: &mut Write<'_>, r: &Operation) -> Result<(), Error> {
    require::<ScopeTable>(tx, &key(&r.scope_id))?;
    if let (Some(id), Some(digest)) = (&r.expected_version_id, &r.expected_digest) {
        owner(tx, id, &r.scope_id, &r.kind, &r.artifact_id, Some(digest))?;
    }
    if let (Some(id), Some(scope), Some(digest)) =
        (&r.source_version_id, &r.source_scope_id, &r.source_digest)
    {
        owner(tx, id, scope, &r.kind, &r.artifact_id, Some(digest))?;
    }
    if let (Some(id), Some(digest)) = (&r.final_version_id, &r.target_digest) {
        owner(tx, id, &r.scope_id, &r.kind, &r.artifact_id, Some(digest))?;
    }
    Ok(())
}
pub(crate) fn write_references(tx: &mut Write<'_>, r: &AutomaticWrite) -> Result<(), Error> {
    require::<ScopeTable>(tx, &key(&r.scope_id))?;
    if !tx
        .get::<VersionTable>(&key(&r.version_id))?
        .is_some_and(|v| v.scope_id == r.scope_id && v.content_digest == r.content_digest)
    {
        return Err(reject(
            tx,
            "foreign_reference",
            "write version owner or digest is missing",
        ));
    }
    Ok(())
}

fn any<T: TableSpec>(
    tx: &mut Write<'_>,
    matches: impl Fn(&T::Record) -> bool,
) -> Result<bool, Error> {
    let mut after: Option<Vec<u8>> = None;
    loop {
        let rows = tx.scan::<T>(
            after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            128,
        )?;
        if rows.is_empty() {
            return Ok(false);
        }
        after = rows.last().map(T::primary_key);
        if rows.iter().any(&matches) {
            return Ok(true);
        }
    }
}

fn incoming_version(tx: &mut Write<'_>, v: &Version) -> Result<(), Error> {
    let owner_differs = |scope: &LosslessString, kind: &LosslessString, id: &LosslessString| {
        scope != &v.scope_id || kind != &v.kind || id != &v.artifact_id
    };
    let mismatch = any::<ArtifactTable>(tx, |r| {
        (r.current_version_id == v.id || r.fallback_version_id.as_ref() == Some(&v.id))
            && owner_differs(&r.scope_id, &r.kind, &r.artifact_id)
    })? || any::<VersionTable>(tx, |r| {
        if r.id == v.id {
            return false;
        }
        (r.parent_version_id.as_ref() == Some(&v.id)
            && owner_differs(&r.scope_id, &r.kind, &r.artifact_id))
            || (r.origin_version_id.as_ref() == Some(&v.id)
                && r.origin_scope_id
                    .as_ref()
                    .is_some_and(|scope| owner_differs(scope, &r.kind, &r.artifact_id)))
    })? || any::<TrashTable>(tx, |r| {
        r.prior_version_id == v.id && owner_differs(&r.scope_id, &r.kind, &r.artifact_id)
    })? || any::<ActivationTable>(tx, |r| {
        r.version_id == v.id && owner_differs(&r.scope_id, &r.kind, &r.artifact_id)
    })? || any::<ObservationTable>(tx, |r| {
        r.version_id == v.id && owner_differs(&r.scope_id, &r.kind, &r.artifact_id)
    })? || any::<FeedbackTable>(tx, |r| {
        r.version_id == v.id && owner_differs(&r.scope_id, &r.kind, &r.artifact_id)
    })? || any::<WriteTable>(tx, |r| {
        r.version_id == v.id && (r.scope_id != v.scope_id || r.content_digest != v.content_digest)
    })? || any::<OperationTable>(tx, |r| {
        (r.expected_version_id.as_ref() == Some(&v.id)
            && (owner_differs(&r.scope_id, &r.kind, &r.artifact_id)
                || r.expected_digest.as_ref() != Some(&v.content_digest)))
            || (r.source_version_id.as_ref() == Some(&v.id)
                && r.source_scope_id.as_ref().is_some_and(|scope| {
                    owner_differs(scope, &r.kind, &r.artifact_id)
                        || r.source_digest.as_ref() != Some(&v.content_digest)
                }))
            || (r.final_version_id.as_ref() == Some(&v.id)
                && (owner_differs(&r.scope_id, &r.kind, &r.artifact_id)
                    || r.target_digest.as_ref() != Some(&v.content_digest)))
    })?;
    if mismatch {
        return Err(reject(
            tx,
            "foreign_reference",
            "version owner or digest is still referenced",
        ));
    }
    Ok(())
}

pub fn insert_artifact(
    tx: &mut Write<'_>,
    artifact: &Artifact,
    version: &Version,
) -> Result<(), Error> {
    if tx
        .get::<ArtifactTable>(&ArtifactTable::primary_key(artifact))?
        .is_some()
    {
        return Err(reject(
            tx,
            "primary_key",
            "artifact identity already exists",
        ));
    }
    tx.put::<ArtifactTable>(artifact)?;
    VersionTable::insert(tx, version)?;
    ArtifactTable::put(tx, artifact)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Expectation {
    pub revision: i64,
    pub version_id: LosslessString,
    pub digest: LosslessString,
}

pub fn replace_artifact(
    tx: &mut Write<'_>,
    expected: &Expectation,
    replacement: &Artifact,
    version: Option<&Version>,
) -> Result<(), Error> {
    let old = tx
        .get::<ArtifactTable>(&ArtifactTable::primary_key(replacement))?
        .ok_or_else(|| {
            reject(
                tx,
                "version_conflict",
                "artifact expectation does not match",
            )
        })?;
    let current = tx
        .get::<VersionTable>(&key(&old.current_version_id))?
        .ok_or_else(|| {
            reject(
                tx,
                "foreign_reference",
                "current artifact version is missing",
            )
        })?;
    if old.revision != expected.revision
        || old.current_version_id != expected.version_id
        || current.content_digest != expected.digest
        || expected.revision.checked_add(1) != Some(replacement.revision)
    {
        return Err(reject(
            tx,
            "version_conflict",
            "artifact expectation or revision does not match",
        ));
    }
    tx.put::<ArtifactTable>(replacement)?;
    if let Some(version) = version {
        VersionTable::insert(tx, version)?;
    }
    ArtifactTable::put(tx, replacement)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JournalPhase {
    Preparing,
    Available,
    Finalized,
    Aborted,
}
impl JournalPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Preparing => "preparing",
            Self::Available => "available",
            Self::Finalized => "finalized",
            Self::Aborted => "aborted",
        }
    }
}

pub fn transition_operation(
    tx: &mut Write<'_>,
    id: &LosslessString,
    phase: JournalPhase,
    final_version: Option<LosslessString>,
    time: i64,
) -> Result<Option<Operation>, Error> {
    let Some(mut operation) = tx.get::<OperationTable>(&key(id))? else {
        if phase == JournalPhase::Aborted {
            return Ok(None);
        }
        return Err(reject(tx, "version_conflict", "operation is missing"));
    };
    if (phase == JournalPhase::Available && operation.phase.as_str() == Some("finalized"))
        || (phase == JournalPhase::Aborted
            && matches!(operation.phase.as_str(), Some("finalized" | "aborted")))
    {
        return Ok(Some(operation));
    }
    let allowed = match phase {
        JournalPhase::Preparing => operation.phase.as_str() == Some("aborted"),
        JournalPhase::Available | JournalPhase::Aborted => {
            matches!(operation.phase.as_str(), Some("preparing" | "available"))
        }
        JournalPhase::Finalized => matches!(
            operation.phase.as_str(),
            Some("preparing" | "available" | "finalized")
        ),
    };
    if !allowed {
        return Err(reject(
            tx,
            "version_conflict",
            "operation phase expectation does not match",
        ));
    }
    operation.phase = phase.as_str().into();
    operation.final_version_id = final_version;
    operation.time_updated = time;
    OperationTable::put(tx, &operation)?;
    Ok(Some(operation))
}

pub fn operations_in_phase(
    snapshot: &Snapshot,
    phase: JournalPhase,
    after: Option<&IndexCursor>,
    limit: usize,
) -> Result<Vec<crate::IndexEntry<Operation>>, Error> {
    snapshot.index_range::<OperationTable>(
        "project_artifact_operation_recovery_idx",
        IndexQuery {
            lower: Bound::Unbounded,
            upper: Bound::Unbounded,
            prefix: Some(&key(&phase.as_str().into())),
            order: IndexOrder::Ascending,
            after,
            limit,
        },
    )
}

pub fn restore(tx: &mut Write<'_>, deletion: &LosslessString) -> Result<bool, Error> {
    tx.delete::<TrashTable>(&key(deletion))
}

pub fn delete_version(tx: &mut Write<'_>, id: &LosslessString) -> Result<bool, Error> {
    if tx.get::<VersionTable>(&key(id))?.is_none() {
        return Ok(false);
    }
    restrict_versions(tx, |v| &v.id == id, |_, _, _| false)?;
    remove_version_children(tx, |v| v == id)?;
    tx.delete::<VersionTable>(&key(id))
}

fn restrict_versions(
    tx: &mut Write<'_>,
    removed: impl Fn(&Version) -> bool,
    removed_artifact: impl Fn(&LosslessString, &LosslessString, &LosslessString) -> bool,
) -> Result<(), Error> {
    let mut after: Option<Vec<u8>> = None;
    loop {
        let versions = tx.scan::<VersionTable>(
            after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            128,
        )?;
        if versions.is_empty() {
            return Ok(());
        }
        after = versions.last().map(VersionTable::primary_key);
        for version in versions.iter().filter(|v| removed(v)) {
            let id = &version.id;
            if any::<OperationTable>(tx, |r| {
                r.expected_version_id.as_ref() == Some(id)
                    || r.source_version_id.as_ref() == Some(id)
                    || r.final_version_id.as_ref() == Some(id)
            })? || any::<ArtifactTable>(tx, |r| {
                !removed_artifact(&r.scope_id, &r.kind, &r.artifact_id)
                    && (&r.current_version_id == id || r.fallback_version_id.as_ref() == Some(id))
            })? || any::<VersionTable>(tx, |r| {
                !removed(r)
                    && (r.parent_version_id.as_ref() == Some(id)
                        || r.origin_version_id.as_ref() == Some(id))
            })? || any::<TrashTable>(tx, |r| {
                &r.prior_version_id == id && !removed_artifact(&r.scope_id, &r.kind, &r.artifact_id)
            })? {
                return Err(reject(tx, "restrict", "version is still referenced"));
            }
        }
    }
}

fn remove_version_children(
    tx: &mut Write<'_>,
    removed: impl Fn(&LosslessString) -> bool,
) -> Result<(), Error> {
    crate::project::remove_children::<ActivationTable>(tx, |r| removed(&r.version_id))?;
    crate::project::remove_children::<ObservationTable>(tx, |r| removed(&r.version_id))?;
    crate::project::remove_children::<FeedbackTable>(tx, |r| removed(&r.version_id))?;
    crate::project::remove_children::<WriteTable>(tx, |r| removed(&r.version_id))
}

pub fn delete_artifact(
    tx: &mut Write<'_>,
    scope: &LosslessString,
    kind: &LosslessString,
    id: &LosslessString,
) -> Result<bool, Error> {
    let primary = identity(scope, kind, id);
    if tx.get::<ArtifactTable>(&primary)?.is_none() {
        return Ok(false);
    }
    restrict_versions(
        tx,
        |v| &v.scope_id == scope && &v.kind == kind && &v.artifact_id == id,
        |s, k, i| s == scope && k == kind && i == id,
    )?;
    let mut after: Option<Vec<u8>> = None;
    loop {
        let versions = tx.scan::<VersionTable>(
            after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            128,
        )?;
        if versions.is_empty() {
            break;
        }
        after = versions.last().map(VersionTable::primary_key);
        for version in versions
            .into_iter()
            .filter(|v| &v.scope_id == scope && &v.kind == kind && &v.artifact_id == id)
        {
            remove_version_children(tx, |v| v == &version.id)?;
            tx.delete::<VersionTable>(&key(&version.id))?;
        }
    }
    crate::project::remove_children::<TrashTable>(tx, |r| {
        &r.scope_id == scope && &r.kind == kind && &r.artifact_id == id
    })?;
    tx.delete::<ArtifactTable>(&primary)
}

pub fn delete_scope(tx: &mut Write<'_>, id: &LosslessString) -> Result<bool, Error> {
    if tx.get::<ScopeTable>(&key(id))?.is_none() {
        return Ok(false);
    }
    if any::<ArtifactTable>(tx, |r| r.shadowed_scope_id.as_ref() == Some(id))? {
        return Err(reject(tx, "restrict", "scope is still shadowed"));
    }
    restrict_versions(tx, |v| &v.scope_id == id, |scope, _, _| scope == id)?;
    crate::project::remove_children::<OperationTable>(tx, |r| &r.scope_id == id)?;
    let mut after: Option<Vec<u8>> = None;
    loop {
        let versions = tx.scan::<VersionTable>(
            after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            128,
        )?;
        if versions.is_empty() {
            break;
        }
        after = versions.last().map(VersionTable::primary_key);
        for version in versions.into_iter().filter(|v| &v.scope_id == id) {
            remove_version_children(tx, |v| v == &version.id)?;
            tx.delete::<VersionTable>(&key(&version.id))?;
        }
    }
    crate::project::remove_children::<TrashTable>(tx, |r| &r.scope_id == id)?;
    crate::project::remove_children::<ArtifactTable>(tx, |r| &r.scope_id == id)?;
    crate::project::remove_children::<WriteTable>(tx, |r| &r.scope_id == id)?;
    tx.delete::<ProjectScopeTable>(&key(id))?;
    tx.delete::<GlobalScopeTable>(&key(id))?;
    tx.delete::<ScopeTable>(&key(id))
}
