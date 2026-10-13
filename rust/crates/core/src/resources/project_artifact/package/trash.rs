use super::{
    Failure, Marker, StandardTarget, content_matches, exists, failure, location, path_text,
    read_marker, relative_content_path, replace_file, same_ownership, scope_ownership, sha256,
    string_field, valid_standard_paths, with_artifact_lock,
};
use crate::resources::project_artifact::filesystem::{self, Hooks};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use ycoding_schema::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder, project_artifact,
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Layout {
    Active,
    Version,
    Disabled,
}
impl Layout {
    fn text(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Version => "version",
            Self::Disabled => "disabled",
        }
    }
}
impl DomainEncode for Layout {
    fn encode(&self) -> JsonValue {
        JsonValue::String(self.text().into())
    }
}
impl DomainDecode for Layout {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        match LosslessString::decode_at(value, path)?.as_str() {
            Some("active") => Ok(Self::Active),
            Some("version") => Ok(Self::Version),
            Some("disabled") => Ok(Self::Disabled),
            _ => Err(path.error(ycoding_schema::DecodeErrorKind::Expected("trash layout"))),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TrashPhase {
    Trashing,
    Trashed,
    Restoring,
}
impl DomainEncode for TrashPhase {
    fn encode(&self) -> JsonValue {
        JsonValue::String(
            match self {
                Self::Trashing => "trashing",
                Self::Trashed => "trashed",
                Self::Restoring => "restoring",
            }
            .into(),
        )
    }
}
impl DomainDecode for TrashPhase {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        match LosslessString::decode_at(value, path)?.as_str() {
            Some("trashing") => Ok(Self::Trashing),
            Some("trashed") => Ok(Self::Trashed),
            Some("restoring") => Ok(Self::Restoring),
            _ => Err(path.error(ycoding_schema::DecodeErrorKind::Expected("trash phase"))),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct TrashManifestEntry {
    pub layout: Layout,
    pub version_id: project_artifact::VersionId,
    pub source: PathBuf,
    pub content: PathBuf,
    pub marker: PathBuf,
    pub content_digest: project_artifact::Digest,
    pub content_relpath: project_artifact::ContentRelpath,
}
impl DomainDecode for TrashManifestEntry {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            layout: object.field("layout")?,
            version_id: object.field("versionID")?,
            source: string_field(&object, path, "source")?.into(),
            content: string_field(&object, path, "content")?.into(),
            marker: string_field(&object, path, "marker")?.into(),
            content_digest: object.field("contentDigest")?,
            content_relpath: object.field("contentRelpath")?,
        })
    }
}
impl DomainEncode for TrashManifestEntry {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("layout", &self.layout)
            .field("versionID", &self.version_id)
            .field("source", &path_text(&self.source))
            .field("content", &path_text(&self.content))
            .field("marker", &path_text(&self.marker))
            .field("contentDigest", &self.content_digest)
            .field("contentRelpath", &self.content_relpath)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct TrashManifest {
    pub phase: TrashPhase,
    pub deletion_id: project_artifact::DeletionId,
    pub scope_id: project_artifact::ScopeId,
    pub storage_id: project_artifact::StorageId,
    pub kind: project_artifact::Kind,
    pub id: project_artifact::Id,
    pub prior_stage: project_artifact::Stage,
    pub deleted_at: f64,
    pub entry_count: f64,
    pub entries_digest: project_artifact::Digest,
    pub standard: bool,
    pub entries: Vec<TrashManifestEntry>,
}
impl DomainDecode for TrashManifest {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        object.literal("schema", &JsonValue::Number(1.0))?;
        let prior_stage: project_artifact::Stage = object.field("priorStage")?;
        if prior_stage.encode() == JsonValue::String("quarantine".into()) {
            return Err(path
                .key("priorStage")
                .error(ycoding_schema::DecodeErrorKind::Expected(
                    "restorable prior stage",
                )));
        }
        Ok(Self {
            phase: object.field("phase")?,
            deletion_id: object.field("deletionID")?,
            scope_id: object.field("scopeID")?,
            storage_id: object.field("storageID")?,
            kind: object.field("kind")?,
            id: object.field("id")?,
            prior_stage,
            deleted_at: object.field("deletedAt")?,
            entry_count: object.field("entryCount")?,
            entries_digest: object.field("entriesDigest")?,
            standard: object.field("standard")?,
            entries: object.field("entries")?,
        })
    }
}
impl DomainEncode for TrashManifest {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("schema", &1.0)
            .field("phase", &self.phase)
            .field("deletionID", &self.deletion_id)
            .field("scopeID", &self.scope_id)
            .field("storageID", &self.storage_id)
            .field("kind", &self.kind)
            .field("id", &self.id)
            .field("priorStage", &self.prior_stage)
            .field("deletedAt", &self.deleted_at)
            .field("entryCount", &self.entry_count)
            .field("entriesDigest", &self.entries_digest)
            .field("standard", &self.standard)
            .field("entries", &self.entries)
            .finish()
    }
}
#[derive(Clone, Copy)]
pub struct TrashInput<'a> {
    pub root: &'a Path,
    pub marker: &'a Marker,
    pub deletion_id: &'a project_artifact::DeletionId,
    pub prior_stage: Option<&'a project_artifact::Stage>,
    pub deleted_at: Option<u64>,
    pub now: Option<u64>,
    pub standard: Option<StandardTarget<'a>>,
}

pub fn trash(input: TrashInput<'_>, filesystem: &Hooks<'_>) -> Result<(), Failure> {
    with_artifact_lock(input.root, input.marker, || {
        let scope = scope_ownership(input.root, filesystem)?;
        if (&input.marker.scope_id, &input.marker.storage_id) != (&scope.0, &scope.1) {
            return Err(failure("OwnershipMismatch"));
        }
        if exists(&trash_root(input.root, input.deletion_id)) {
            return Err(failure("DestinationExists"));
        }
        let entries = collect_layouts(input.root, input.marker, input.standard, filesystem)?;
        if !entries.iter().any(|entry| {
            entry.version_id == input.marker.version_id
                && entry.content_digest == input.marker.content_digest
                && entry.content_relpath == input.marker.content_relpath
        }) {
            return Err(failure("OwnershipMismatch"));
        }
        let prior_stage = input.prior_stage.cloned().unwrap_or_else(|| {
            project_artifact::Stage::decode(&JsonValue::String("active".into()))
                .expect("default stage")
        });
        if prior_stage.encode() == JsonValue::String("quarantine".into()) {
            return Err(failure("InvalidArtifact"));
        }
        let manifest = TrashManifest {
            phase: TrashPhase::Trashing,
            deletion_id: input.deletion_id.clone(),
            scope_id: input.marker.scope_id.clone(),
            storage_id: input.marker.storage_id.clone(),
            kind: input.marker.kind.clone(),
            id: input.marker.id.clone(),
            prior_stage,
            deleted_at: input.deleted_at.map_or_else(now, Ok)? as f64,
            entry_count: entries.len() as f64,
            entries_digest: entries_digest(&entries),
            standard: input.standard.is_some(),
            entries,
        };
        filesystem::write(
            input.root,
            &manifest_path(input.root, input.deletion_id),
            &ycoding_schema::stringify_json(&manifest.encode()),
            true,
            filesystem,
        )?;
        let attempt = (|| {
            for entry in &manifest.entries {
                let destination = entry_root(input.root, &manifest, entry);
                filesystem::mkdir(input.root, &destination, filesystem)?;
                filesystem::move_across(
                    entry_content_root(input.root, &manifest, entry),
                    input.root,
                    &entry.content,
                    &destination.join(
                        entry
                            .content_relpath
                            .as_lossless()
                            .as_str()
                            .expect("validated path"),
                    ),
                    filesystem,
                )?;
                filesystem::move_across(
                    entry_marker_root(input.root, &manifest, entry),
                    input.root,
                    &entry.marker,
                    &destination.join(".ycoding-project-artifact.json"),
                    filesystem,
                )?;
            }
            write_phase(input.root, &manifest, TrashPhase::Trashed, filesystem)?;
            Ok(())
        })();
        if let Err(error) = attempt {
            restore_entries(input.root, &manifest, filesystem)?;
            filesystem::remove(
                input.root,
                &trash_root(input.root, input.deletion_id),
                true,
                filesystem,
            )?;
            return Err(error);
        }
        Ok(())
    })
}
pub fn restore(input: TrashInput<'_>, filesystem: &Hooks<'_>) -> Result<(), Failure> {
    with_artifact_lock(input.root, input.marker, || {
        let manifest = load_manifest(input, filesystem)?;
        if manifest.standard && input.standard.is_none() {
            return Err(failure("OwnershipMismatch"));
        }
        if manifest.phase != TrashPhase::Trashed {
            return Err(failure("ReconciliationRequired"));
        }
        if manifest
            .entries
            .iter()
            .any(|entry| exists(&entry.content) || exists(&entry.marker))
        {
            return Err(failure("DestinationExists"));
        }
        write_phase(input.root, &manifest, TrashPhase::Restoring, filesystem)?;
        let attempt = (|| {
            restore_entries(input.root, &manifest, filesystem)?;
            filesystem::remove(
                input.root,
                &trash_root(input.root, input.deletion_id),
                true,
                filesystem,
            )?;
            Ok(())
        })();
        if let Err(error) = attempt {
            return_entries(input.root, &manifest, filesystem)?;
            write_phase(input.root, &manifest, TrashPhase::Trashed, filesystem)?;
            return Err(error);
        }
        Ok(())
    })
}
pub fn validate_trash(
    input: TrashInput<'_>,
    filesystem: &Hooks<'_>,
) -> Result<TrashManifest, Failure> {
    with_artifact_lock(input.root, input.marker, || {
        load_manifest(input, filesystem)
    })
}
pub fn purge(input: TrashInput<'_>, filesystem: &Hooks<'_>) -> Result<(), Failure> {
    with_artifact_lock(input.root, input.marker, || {
        let manifest = load_manifest(input, filesystem)?;
        if manifest.phase != TrashPhase::Trashed {
            return Err(failure("ReconciliationRequired"));
        }
        if (input.now.map_or_else(now, Ok)? as f64) < manifest.deleted_at + 30.0 * 86_400_000.0 {
            return Err(failure("TrashExpired"));
        }
        filesystem::remove(
            input.root,
            &trash_root(input.root, input.deletion_id),
            true,
            filesystem,
        )?;
        Ok(())
    })
}
pub fn read_trash_manifest(
    root: &Path,
    deletion_id: &project_artifact::DeletionId,
    filesystem: &Hooks<'_>,
) -> Result<TrashManifest, Failure> {
    TrashManifest::decode(
        &ycoding_schema::parse_json(
            &filesystem::read_text(root, &manifest_path(root, deletion_id), filesystem)
                .map_err(|_| failure("OwnershipMismatch"))?,
        )
        .map_err(|_| failure("OwnershipMismatch"))?,
    )
    .map_err(|_| failure("OwnershipMismatch"))
}
fn load_manifest(input: TrashInput<'_>, filesystem: &Hooks<'_>) -> Result<TrashManifest, Failure> {
    if let Some(target) = input.standard
        && !valid_standard_paths(input.marker, target.content_path, target.marker_path)
    {
        return Err(failure("OwnershipMismatch"));
    }
    let manifest = read_trash_manifest(input.root, input.deletion_id, filesystem)?;
    if &manifest.deletion_id != input.deletion_id {
        return Err(failure("OwnershipMismatch"));
    }
    validate_manifest(
        input.root,
        &manifest,
        input.marker,
        input.standard,
        filesystem,
    )?;
    if !manifest.entries.iter().any(|entry| {
        entry.version_id == input.marker.version_id
            && entry.content_digest == input.marker.content_digest
            && entry.content_relpath == input.marker.content_relpath
    }) {
        return Err(failure("OwnershipMismatch"));
    }
    Ok(manifest)
}
fn collect_layouts(
    root: &Path,
    marker: &Marker,
    standard: Option<StandardTarget<'_>>,
    filesystem: &Hooks<'_>,
) -> Result<Vec<TrashManifestEntry>, Failure> {
    let (content, marker_path) = location(root, marker, standard)?;
    let mut values = Vec::new();
    if exists(&content) || exists(&marker_path) {
        let content_root = if standard.is_some() {
            content.parent().expect("standard path")
        } else {
            root
        };
        let marker_root = if standard.is_some() {
            marker_path.parent().expect("standard path")
        } else {
            root
        };
        let stored = read_marker(marker_root, &marker_path, filesystem)
            .ok_or_else(|| failure("OwnershipMismatch"))?;
        if !same_ownership(&stored, marker)
            || !content_matches(content_root, &content, &stored, filesystem)
        {
            return Err(failure("OwnershipMismatch"));
        }
        values.push(TrashManifestEntry {
            layout: Layout::Active,
            version_id: stored.version_id,
            source: content_root.into(),
            content,
            marker: marker_path,
            content_digest: stored.content_digest,
            content_relpath: stored.content_relpath,
        });
    }
    for (layout, directory) in [
        (Layout::Version, "versions"),
        (Layout::Disabled, "disabled"),
    ] {
        let directory = root
            .join(directory)
            .join(marker.kind.as_lossless().as_str().expect("validated kind"))
            .join(marker.id.as_lossless().as_str().expect("validated ID"));
        for entry in entries(&directory) {
            if !entry
                .file_type()
                .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
            {
                return Err(failure("OwnershipMismatch"));
            }
            let source = entry.path();
            let marker_path = source.join(".ycoding-project-artifact.json");
            let stored = read_marker(root, &marker_path, filesystem)
                .ok_or_else(|| failure("OwnershipMismatch"))?;
            let content = source.join(
                stored
                    .content_relpath
                    .as_lossless()
                    .as_str()
                    .expect("validated path"),
            );
            if stored.version_id.as_lossless().as_str() != entry.file_name().to_str()
                || !same_ownership(&stored, marker)
                || !content_matches(root, &content, &stored, filesystem)
            {
                return Err(failure("OwnershipMismatch"));
            }
            values.push(TrashManifestEntry {
                layout,
                version_id: stored.version_id,
                source,
                content,
                marker: marker_path,
                content_digest: stored.content_digest,
                content_relpath: stored.content_relpath,
            });
        }
    }
    for (index, entry) in values.iter().enumerate() {
        if values[..index]
            .iter()
            .any(|previous| previous.version_id == entry.version_id)
        {
            return Err(failure("OwnershipMismatch"));
        }
    }
    values.sort_by_key(|entry| {
        format!(
            "{}:{}",
            entry.layout.text(),
            entry
                .version_id
                .as_lossless()
                .as_str()
                .expect("validated version")
        )
    });
    Ok(values)
}
pub(super) fn validate_manifest(
    root: &Path,
    manifest: &TrashManifest,
    expected: &Marker,
    target: Option<StandardTarget<'_>>,
    filesystem: &Hooks<'_>,
) -> Result<(), Failure> {
    if manifest.scope_id != expected.scope_id
        || manifest.storage_id != expected.storage_id
        || manifest.kind != expected.kind
        || manifest.id != expected.id
        || !safe_integer(manifest.deleted_at)
        || !safe_integer(manifest.entry_count)
        || manifest.entry_count <= 0.0
        || manifest.entry_count != manifest.entries.len() as f64
        || manifest.entries_digest != entries_digest(&manifest.entries)
        || target.is_some_and(|_| !manifest.standard)
    {
        return Err(failure("OwnershipMismatch"));
    }
    for (index, entry) in manifest.entries.iter().enumerate() {
        if manifest.entries[..index]
            .iter()
            .any(|previous| previous.version_id == entry.version_id)
        {
            return Err(failure("OwnershipMismatch"));
        }
        validate_entry_path(root, manifest, entry, target)?;
    }
    let mut keys = manifest
        .entries
        .iter()
        .map(|entry| {
            format!(
                "{}:{}",
                entry.layout.text(),
                entry
                    .version_id
                    .as_lossless()
                    .as_str()
                    .expect("validated version")
            )
        })
        .collect::<Vec<_>>();
    keys.sort();
    let stored_keys = entry_keys(root, manifest)?;
    if stored_keys.iter().any(|key| !keys.contains(key)) {
        return Err(failure("OwnershipMismatch"));
    }
    if manifest.phase != TrashPhase::Trashed {
        return Ok(());
    }
    if stored_keys != keys {
        return Err(failure("OwnershipMismatch"));
    }
    for entry in &manifest.entries {
        let source = entry_root(root, manifest, entry);
        let expected = entry_marker(manifest, entry);
        super::require_complete_layout(
            root,
            &source.join(
                entry
                    .content_relpath
                    .as_lossless()
                    .as_str()
                    .expect("validated path"),
            ),
            root,
            &source.join(".ycoding-project-artifact.json"),
            &expected,
            filesystem,
        )?;
        let stored = read_marker(
            root,
            &source.join(".ycoding-project-artifact.json"),
            filesystem,
        )
        .ok_or_else(|| failure("OwnershipMismatch"))?;
        if stored.content_relpath != entry.content_relpath {
            return Err(failure("OwnershipMismatch"));
        }
    }
    Ok(())
}
fn validate_entry_path(
    root: &Path,
    manifest: &TrashManifest,
    entry: &TrashManifestEntry,
    target: Option<StandardTarget<'_>>,
) -> Result<(), Failure> {
    if entry.content_relpath.as_lossless().as_str()
        != Some(&relative_content_path(&manifest.kind, &manifest.id))
    {
        return Err(failure("OwnershipMismatch"));
    }
    let marker = entry_marker(manifest, entry);
    if entry.layout == Layout::Active && manifest.standard {
        if entry.content.parent() != Some(entry.source.as_path())
            || !valid_standard_paths(&marker, &entry.content, &entry.marker)
            || target.is_some_and(|target| {
                target.content_path != entry.content || target.marker_path != entry.marker
            })
        {
            return Err(failure("OwnershipMismatch"));
        }
        return Ok(());
    }
    let source = match entry.layout {
        Layout::Active => root.into(),
        Layout::Version => super::version_root(root, &marker),
        Layout::Disabled => super::state::disabled_root(root, &marker),
    };
    let content = if entry.layout == Layout::Active {
        super::active_content_path(root, &manifest.kind, &manifest.id)
    } else {
        source.join(
            entry
                .content_relpath
                .as_lossless()
                .as_str()
                .expect("validated path"),
        )
    };
    let marker_path = if entry.layout == Layout::Active {
        super::active_marker_path(root, &manifest.kind, &manifest.id)
    } else {
        source.join(".ycoding-project-artifact.json")
    };
    if entry.source != source || entry.content != content || entry.marker != marker_path {
        return Err(failure("OwnershipMismatch"));
    }
    Ok(())
}
pub(super) fn restore_entries(
    root: &Path,
    manifest: &TrashManifest,
    filesystem: &Hooks<'_>,
) -> Result<(), Failure> {
    for entry in &manifest.entries {
        let source = entry_root(root, manifest, entry);
        let content = source.join(
            entry
                .content_relpath
                .as_lossless()
                .as_str()
                .expect("validated path"),
        );
        let marker = source.join(".ycoding-project-artifact.json");
        if !exists(&entry.content) && exists(&content) {
            filesystem::move_across(
                root,
                entry_content_root(root, manifest, entry),
                &content,
                &entry.content,
                filesystem,
            )?;
        }
        if !exists(&entry.marker) && exists(&marker) {
            filesystem::move_across(
                root,
                entry_marker_root(root, manifest, entry),
                &marker,
                &entry.marker,
                filesystem,
            )?;
        }
        super::require_complete_layout(
            entry_content_root(root, manifest, entry),
            &entry.content,
            entry_marker_root(root, manifest, entry),
            &entry.marker,
            &entry_marker(manifest, entry),
            filesystem,
        )
        .map_err(|_| failure("ReconciliationRequired"))?;
    }
    Ok(())
}
fn return_entries(
    root: &Path,
    manifest: &TrashManifest,
    filesystem: &Hooks<'_>,
) -> Result<(), Failure> {
    for entry in manifest.entries.iter().rev() {
        let destination = entry_root(root, manifest, entry);
        filesystem::mkdir(root, &destination, filesystem)?;
        let marker = destination.join(".ycoding-project-artifact.json");
        let content = destination.join(
            entry
                .content_relpath
                .as_lossless()
                .as_str()
                .expect("validated path"),
        );
        if exists(&entry.marker) && !exists(&marker) {
            filesystem::move_across(
                entry_marker_root(root, manifest, entry),
                root,
                &entry.marker,
                &marker,
                filesystem,
            )?;
        }
        if exists(&entry.content) && !exists(&content) {
            filesystem::move_across(
                entry_content_root(root, manifest, entry),
                root,
                &entry.content,
                &content,
                filesystem,
            )?;
        }
    }
    Ok(())
}
pub(super) fn entry_marker(manifest: &TrashManifest, entry: &TrashManifestEntry) -> Marker {
    Marker {
        scope_id: manifest.scope_id.clone(),
        storage_id: manifest.storage_id.clone(),
        kind: manifest.kind.clone(),
        id: manifest.id.clone(),
        version_id: entry.version_id.clone(),
        content_digest: entry.content_digest.clone(),
        content_relpath: entry.content_relpath.clone(),
    }
}
pub(super) fn trash_root(root: &Path, deletion: &project_artifact::DeletionId) -> PathBuf {
    root.join("trash").join(
        deletion
            .as_lossless()
            .as_str()
            .expect("validated deletion ID"),
    )
}
fn manifest_path(root: &Path, deletion: &project_artifact::DeletionId) -> PathBuf {
    trash_root(root, deletion).join(".ycoding-trash.json")
}
fn entry_root(root: &Path, manifest: &TrashManifest, entry: &TrashManifestEntry) -> PathBuf {
    trash_root(root, &manifest.deletion_id)
        .join("entries")
        .join(entry.layout.text())
        .join(
            entry
                .version_id
                .as_lossless()
                .as_str()
                .expect("validated version ID"),
        )
}
fn entries_digest(entries: &[TrashManifestEntry]) -> project_artifact::Digest {
    sha256(
        &ycoding_schema::stringify_json(&JsonValue::Array(
            entries.iter().map(DomainEncode::encode).collect(),
        ))
        .as_str()
        .into(),
    )
}
fn write_phase(
    root: &Path,
    manifest: &TrashManifest,
    phase: TrashPhase,
    filesystem: &Hooks<'_>,
) -> Result<(), Failure> {
    replace_file(
        root,
        &manifest_path(root, &manifest.deletion_id),
        &ycoding_schema::stringify_json(
            &TrashManifest {
                phase,
                ..manifest.clone()
            }
            .encode(),
        ),
        filesystem,
    )
}
fn entry_content_root<'a>(
    root: &'a Path,
    manifest: &TrashManifest,
    entry: &'a TrashManifestEntry,
) -> &'a Path {
    if manifest.standard && entry.layout == Layout::Active {
        entry.content.parent().expect("validated standard path")
    } else {
        root
    }
}
fn entry_marker_root<'a>(
    root: &'a Path,
    manifest: &TrashManifest,
    entry: &'a TrashManifestEntry,
) -> &'a Path {
    if manifest.standard && entry.layout == Layout::Active {
        entry.marker.parent().expect("validated standard path")
    } else {
        root
    }
}
fn entry_keys(root: &Path, manifest: &TrashManifest) -> Result<Vec<String>, Failure> {
    let entries_root = trash_root(root, &manifest.deletion_id).join("entries");
    if entries(&entries_root).iter().any(|entry| {
        !entry
            .file_type()
            .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
            || !["active", "version", "disabled"]
                .contains(&entry.file_name().to_str().unwrap_or(""))
    }) {
        return Err(failure("OwnershipMismatch"));
    }
    let mut keys = Vec::new();
    for layout in ["active", "version", "disabled"] {
        for entry in entries(&entries_root.join(layout)) {
            if !entry
                .file_type()
                .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
            {
                return Err(failure("OwnershipMismatch"));
            }
            keys.push(format!("{layout}:{}", entry.file_name().to_string_lossy()));
        }
    }
    keys.sort();
    Ok(keys)
}
pub(super) fn entries(path: &Path) -> Vec<fs::DirEntry> {
    fs::read_dir(path)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .collect()
}
fn safe_integer(value: f64) -> bool {
    value.is_finite() && (0.0..=9_007_199_254_740_991.0).contains(&value) && value.fract() == 0.0
}
fn now() -> Result<u64, Failure> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| failure("StorageUnavailable"))
        .and_then(|duration| {
            u64::try_from(duration.as_millis()).map_err(|_| failure("StorageUnavailable"))
        })
}
