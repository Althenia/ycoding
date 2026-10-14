use super::filesystem::{self, Hooks};
use ring::digest;
use ring::rand::{SecureRandom, SystemRandom};
use std::{
    convert::Infallible,
    fmt, fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use ycoding_schema::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder, project_artifact,
};
mod reconcile;
mod state;
mod trash;
pub use reconcile::{
    StandardIssue, StandardReconcileInput, StandardReconciliation, StandardRoots, reconcile,
    reconcile_standard,
};
pub use state::{
    StateMutationInput, StateMutationMetadata, StateOperation, StatePhase,
    cleanup_state_transaction, disabled_content_path, read_state_transactions, state_mutation,
    state_transaction,
};
pub use trash::{
    Layout, TrashInput, TrashManifest, TrashManifestEntry, TrashPhase, purge, read_trash_manifest,
    restore, trash, validate_trash,
};

#[derive(Clone, Debug, PartialEq)]
pub struct Marker {
    pub scope_id: project_artifact::ScopeId,
    pub storage_id: project_artifact::StorageId,
    pub kind: project_artifact::Kind,
    pub id: project_artifact::Id,
    pub version_id: project_artifact::VersionId,
    pub content_digest: project_artifact::Digest,
    pub content_relpath: project_artifact::ContentRelpath,
}
impl DomainDecode for Marker {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        object.literal("schema", &JsonValue::Number(1.0))?;
        Ok(Self {
            scope_id: object.field("scopeID")?,
            storage_id: object.field("storageID")?,
            kind: object.field("kind")?,
            id: object.field("id")?,
            version_id: object.field("versionID")?,
            content_digest: object.field("contentDigest")?,
            content_relpath: object.field("contentRelpath")?,
        })
    }
}
impl DomainEncode for Marker {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("schema", &1.0)
            .field("scopeID", &self.scope_id)
            .field("storageID", &self.storage_id)
            .field("kind", &self.kind)
            .field("id", &self.id)
            .field("versionID", &self.version_id)
            .field("contentDigest", &self.content_digest)
            .field("contentRelpath", &self.content_relpath)
            .finish()
    }
}
pub struct MarkerInput {
    pub scope_id: project_artifact::ScopeId,
    pub storage_id: project_artifact::StorageId,
    pub kind: project_artifact::Kind,
    pub id: project_artifact::Id,
    pub version_id: project_artifact::VersionId,
    pub content: LosslessString,
}
pub fn sha256(content: &LosslessString) -> project_artifact::Digest {
    let text = String::from_utf16_lossy(&content.code_units().collect::<Vec<_>>());
    let hex = digest::digest(&digest::SHA256, text.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    project_artifact::Digest::decode(&JsonValue::String(hex.as_str().into()))
        .expect("SHA-256 hex digest")
}
pub fn marker(input: MarkerInput) -> Marker {
    Marker {
        content_digest: sha256(&input.content),
        content_relpath: project_artifact::ContentRelpath::decode(&JsonValue::String(
            relative_content_path(&input.kind, &input.id)
                .as_str()
                .into(),
        ))
        .expect("fixed content filename"),
        scope_id: input.scope_id,
        storage_id: input.storage_id,
        kind: input.kind,
        id: input.id,
        version_id: input.version_id,
    }
}
pub fn active_content_path(
    root: &Path,
    kind: &project_artifact::Kind,
    id: &project_artifact::Id,
) -> PathBuf {
    let id = id.as_lossless().as_str().expect("validated artifact ID");
    match kind.as_lossless().as_str() {
        Some("skill") => root.join("active/skills").join(id).join("SKILL.md"),
        Some("command") => root.join("active/commands").join(format!("{id}.md")),
        Some("agent") => root.join("active/agents").join(format!("{id}.md")),
        _ => root.join("active/plugins").join(format!("{id}.ts")),
    }
}
pub fn active_marker_path(
    root: &Path,
    kind: &project_artifact::Kind,
    id: &project_artifact::Id,
) -> PathBuf {
    root.join("metadata")
        .join(kind.as_lossless().as_str().expect("validated kind"))
        .join(format!(
            "{}.json",
            id.as_lossless().as_str().expect("validated ID")
        ))
}
pub fn version_root(root: &Path, value: &Marker) -> PathBuf {
    root.join("versions")
        .join(value.kind.as_lossless().as_str().expect("validated kind"))
        .join(value.id.as_lossless().as_str().expect("validated ID"))
        .join(
            value
                .version_id
                .as_lossless()
                .as_str()
                .expect("validated version ID"),
        )
}
pub fn version_content_path(root: &Path, value: &Marker) -> PathBuf {
    version_root(root, value).join(
        value
            .content_relpath
            .as_lossless()
            .as_str()
            .expect("validated relative path"),
    )
}
pub fn version_marker_path(root: &Path, value: &Marker) -> PathBuf {
    version_root(root, value).join(".ycoding-project-artifact.json")
}
pub fn scope_marker_path(root: &Path) -> PathBuf {
    root.join(".ycoding-scope.json")
}

#[derive(Clone, Debug)]
pub struct Failure {
    pub code: project_artifact::ErrorCode,
}
impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Project Artifact package operation failed")
    }
}
impl std::error::Error for Failure {}
impl From<filesystem::Error> for Failure {
    fn from(error: filesystem::Error) -> Self {
        failure(match error {
            filesystem::Error::Unsafe(_) => "OwnershipMismatch",
            filesystem::Error::Io(_) => "StorageUnavailable",
        })
    }
}
#[derive(Debug)]
pub enum TransactionError<E> {
    Package(Failure),
    Hook(E),
    Interrupted,
}
#[derive(Clone, Default)]
pub struct Cancellation(Arc<AtomicBool>);
impl Cancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}
impl<E> From<Failure> for TransactionError<E> {
    fn from(error: Failure) -> Self {
        Self::Package(error)
    }
}
type TransactionHook<'a, M, E> = &'a dyn Fn(&M) -> Result<(), E>;
pub struct TransactionHooks<'a, M, E> {
    pub reserve: Option<TransactionHook<'a, M, E>>,
    pub finalize: Option<TransactionHook<'a, M, E>>,
    pub abort: Option<TransactionHook<'a, M, E>>,
    pub cancellation: Option<&'a Cancellation>,
    pub can_compensate: Option<&'a dyn Fn() -> bool>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CommitPhase {
    Prepared,
    Reserved,
    ArchivingContent,
    ArchivingMarker,
    ActivatingContent,
    ActivatingMarker,
    Available,
    Finalizing,
    Committed,
    Compensating,
    Compensated,
}
impl DomainEncode for CommitPhase {
    fn encode(&self) -> JsonValue {
        JsonValue::String(
            match self {
                Self::Prepared => "prepared",
                Self::Reserved => "reserved",
                Self::ArchivingContent => "archiving-content",
                Self::ArchivingMarker => "archiving-marker",
                Self::ActivatingContent => "activating-content",
                Self::ActivatingMarker => "activating-marker",
                Self::Available => "available",
                Self::Finalizing => "finalizing",
                Self::Committed => "committed",
                Self::Compensating => "compensating",
                Self::Compensated => "compensated",
            }
            .into(),
        )
    }
}
impl DomainDecode for CommitPhase {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        match LosslessString::decode_at(value, path)?.as_str() {
            Some("prepared") => Ok(Self::Prepared),
            Some("reserved") => Ok(Self::Reserved),
            Some("archiving-content") => Ok(Self::ArchivingContent),
            Some("archiving-marker") => Ok(Self::ArchivingMarker),
            Some("activating-content") => Ok(Self::ActivatingContent),
            Some("activating-marker") => Ok(Self::ActivatingMarker),
            Some("available") => Ok(Self::Available),
            Some("finalizing") => Ok(Self::Finalizing),
            Some("committed") => Ok(Self::Committed),
            Some("compensating") => Ok(Self::Compensating),
            Some("compensated") => Ok(Self::Compensated),
            _ => Err(path.error(ycoding_schema::DecodeErrorKind::Expected(
                "commit transaction phase",
            ))),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct CommitTransactionMetadata {
    pub operation_id: String,
    pub phase: CommitPhase,
    pub marker: Marker,
    pub previous: Option<Marker>,
    pub stage_root: PathBuf,
    pub content_path: PathBuf,
    pub marker_path: PathBuf,
    pub standard: bool,
}
impl DomainDecode for CommitTransactionMetadata {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        object.literal("schema", &JsonValue::Number(1.0))?;
        Ok(Self {
            operation_id: string_field(&object, path, "operationID")?,
            phase: object.field("phase")?,
            marker: object.field("marker")?,
            previous: object.optional("previous")?,
            stage_root: string_field(&object, path, "stageRoot")?.into(),
            content_path: string_field(&object, path, "contentPath")?.into(),
            marker_path: string_field(&object, path, "markerPath")?.into(),
            standard: object.field("standard")?,
        })
    }
}
impl DomainEncode for CommitTransactionMetadata {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("schema", &1.0)
            .field("operationID", self.operation_id.as_str())
            .field("phase", &self.phase)
            .field("marker", &self.marker)
            .optional("previous", &self.previous)
            .field("stageRoot", &path_text(&self.stage_root))
            .field("contentPath", &path_text(&self.content_path))
            .field("markerPath", &path_text(&self.marker_path))
            .field("standard", &self.standard)
            .finish()
    }
}
#[derive(Clone, Copy)]
pub struct StandardTarget<'a> {
    pub content_path: &'a Path,
    pub marker_path: &'a Path,
}
#[derive(Clone, Copy)]
pub struct CommitInput<'a> {
    pub root: &'a Path,
    pub marker: &'a Marker,
    pub content: &'a LosslessString,
    pub expected_version_id: Option<&'a project_artifact::VersionId>,
    pub operation_id: Option<&'a str>,
    pub standard: Option<StandardTarget<'a>>,
    pub no_overwrite: bool,
}
pub struct PreparedCommit<'a> {
    pub input: CommitInput<'a>,
    pub metadata: CommitTransactionMetadata,
    pub stage_content: PathBuf,
    pub stage_marker: PathBuf,
}

pub fn with_artifact_lock<T>(
    root: &Path,
    marker: &Marker,
    body: impl FnOnce() -> Result<T, Failure>,
) -> Result<T, Failure> {
    let _gate = package_lock(root, "project-artifact:reconcile")?;
    let _artifact = package_lock(root, &lock_key(marker))?;
    body()
}
pub fn commit(
    input: CommitInput<'_>,
    filesystem: &Hooks<'_>,
) -> Result<CommitTransactionMetadata, Failure> {
    match commit_transaction::<Infallible>(
        input,
        filesystem,
        &TransactionHooks {
            reserve: None,
            finalize: None,
            abort: None,
            cancellation: None,
            can_compensate: None,
        },
    ) {
        Ok(metadata) => Ok(metadata),
        Err(TransactionError::Package(error)) => Err(error),
        Err(TransactionError::Hook(error)) => match error {},
        Err(TransactionError::Interrupted) => unreachable!("commit has no cancellation token"),
    }
}
pub fn commit_transaction<E>(
    input: CommitInput<'_>,
    filesystem: &Hooks<'_>,
    hooks: &TransactionHooks<'_, CommitTransactionMetadata, E>,
) -> Result<CommitTransactionMetadata, TransactionError<E>> {
    let _gate = package_lock(input.root, "project-artifact:reconcile")?;
    let _artifact = package_lock(input.root, &lock_key(input.marker))?;
    let prepared = prepare_or_resume_commit(input, filesystem)?;
    if prepared.metadata.phase == CommitPhase::Committed {
        let _ = cleanup_commit_transaction_unsafe(&prepared.metadata, filesystem);
        return Ok(prepared.metadata);
    }
    let before_finalize = (|| {
        check_cancellation(hooks.cancellation)?;
        let available = matches!(
            prepared.metadata.phase,
            CommitPhase::Available | CommitPhase::Finalizing
        );
        let mut metadata = prepared.metadata.clone();
        if available {
            metadata.phase = CommitPhase::Available;
        }
        if let Some(reserve) = hooks.reserve {
            reserve(&metadata).map_err(TransactionError::Hook)?;
        }
        check_cancellation(hooks.cancellation)?;
        let ready = if available {
            metadata
        } else {
            write_commit_phase(
                input.root,
                &prepared.metadata,
                CommitPhase::Reserved,
                filesystem,
            )?;
            make_available(&prepared, filesystem)?
        };
        check_cancellation(hooks.cancellation)?;
        write_commit_phase(
            input.root,
            &prepared.metadata,
            CommitPhase::Finalizing,
            filesystem,
        )?;
        check_cancellation(hooks.cancellation)?;
        Ok(ready)
    })();
    let ready = match before_finalize {
        Ok(metadata) => metadata,
        Err(error) => return compensate_commit_failure(error, &prepared, filesystem, hooks),
    };
    if let Some(finalize) = hooks.finalize
        && let Err(error) = finalize(&ready)
    {
        if hooks.can_compensate.is_some_and(|allowed| !allowed()) {
            return Err(TransactionError::Hook(error));
        }
        return compensate_commit_failure(
            TransactionError::Hook(error),
            &prepared,
            filesystem,
            hooks,
        );
    }
    let committed = match write_commit_phase(
        input.root,
        &prepared.metadata,
        CommitPhase::Committed,
        filesystem,
    ) {
        Ok(metadata) => metadata,
        Err(_) => {
            check_cancellation(hooks.cancellation)?;
            return Ok(CommitTransactionMetadata {
                phase: CommitPhase::Finalizing,
                ..ready
            });
        }
    };
    let _ = filesystem::remove(input.root, &prepared.metadata.stage_root, true, filesystem);
    check_cancellation(hooks.cancellation)?;
    Ok(committed)
}
pub fn prepare_commit<'a>(
    input: CommitInput<'a>,
    filesystem: &Hooks<'_>,
) -> Result<PreparedCommit<'a>, Failure> {
    if sha256(input.content) != input.marker.content_digest {
        return Err(failure("InvalidArtifact"));
    }
    let scope = scope_ownership(input.root, filesystem)?;
    if (&input.marker.scope_id, &input.marker.storage_id) != (&scope.0, &scope.1) {
        return Err(failure("OwnershipMismatch"));
    }
    let (content_path, marker_path) = location(input.root, input.marker, input.standard)?;
    let content_root = if input.standard.is_some() {
        content_path.parent().expect("standard content parent")
    } else {
        input.root
    };
    let marker_root = if input.standard.is_some() {
        marker_path.parent().expect("standard marker parent")
    } else {
        input.root
    };
    filesystem::assert_safe_path(content_root, &content_path)?;
    filesystem::assert_safe_path(marker_root, &marker_path)?;
    if input.standard.is_some()
        && input.no_overwrite
        && (exists(&content_path) || exists(&marker_path))
    {
        return Err(failure("DestinationExists"));
    }
    let current = read_marker(marker_root, &marker_path, filesystem);
    if let Some(current) = &current
        && ((&current.scope_id, &current.storage_id) != (&scope.0, &scope.1)
            || !same_ownership(current, input.marker)
            || current.content_relpath.as_lossless().as_str()
                != Some(&relative_content_path(&current.kind, &current.id))
            || !content_matches(content_root, &content_path, current, filesystem))
    {
        return Err(failure("OwnershipMismatch"));
    }
    validate_expectation(current.as_ref(), input.expected_version_id)?;
    let operation_id = input
        .operation_id
        .map(str::to_owned)
        .map_or_else(uuid, Ok)?;
    if !valid_operation_id(&operation_id) {
        return Err(failure("InvalidArtifact"));
    }
    let stage_root = input.root.join("staging").join(&operation_id);
    if exists(&stage_root) {
        return Err(failure("ReconciliationRequired"));
    }
    let stage_content = stage_root.join(
        input
            .marker
            .content_relpath
            .as_lossless()
            .as_str()
            .expect("validated relative path"),
    );
    let stage_marker = stage_root.join(".ycoding-project-artifact.json");
    filesystem::write(
        input.root,
        &stage_content,
        &String::from_utf16_lossy(&input.content.code_units().collect::<Vec<_>>()),
        true,
        filesystem,
    )?;
    filesystem::write(
        input.root,
        &stage_marker,
        &ycoding_schema::stringify_json(&input.marker.encode()),
        true,
        filesystem,
    )?;
    if !content_matches(input.root, &stage_content, input.marker, filesystem) {
        return Err(failure("StorageUnavailable"));
    }
    let metadata = CommitTransactionMetadata {
        operation_id,
        phase: CommitPhase::Prepared,
        marker: input.marker.clone(),
        previous: current,
        stage_root,
        content_path,
        marker_path,
        standard: input.standard.is_some(),
    };
    filesystem::write(
        input.root,
        &commit_journal_path(&metadata.stage_root),
        &ycoding_schema::stringify_json(&metadata.encode()),
        true,
        filesystem,
    )?;
    Ok(PreparedCommit {
        input,
        metadata,
        stage_content,
        stage_marker,
    })
}
pub fn make_available(
    prepared: &PreparedCommit<'_>,
    filesystem: &Hooks<'_>,
) -> Result<CommitTransactionMetadata, Failure> {
    let input = prepared.input;
    let metadata = &prepared.metadata;
    let content_root = content_root(input.root, metadata);
    let marker_root = marker_root(input.root, metadata);
    if let Some(current) = &metadata.previous {
        if exists(&version_root(input.root, current)) {
            return Err(failure("VersionConflict"));
        }
        filesystem::mkdir(input.root, &version_root(input.root, current), filesystem)?;
        write_commit_phase(
            input.root,
            metadata,
            CommitPhase::ArchivingContent,
            filesystem,
        )?;
        filesystem::move_across(
            content_root,
            input.root,
            &metadata.content_path,
            &version_content_path(input.root, current),
            filesystem,
        )?;
        write_commit_phase(
            input.root,
            metadata,
            CommitPhase::ArchivingMarker,
            filesystem,
        )?;
        filesystem::move_across(
            marker_root,
            input.root,
            &metadata.marker_path,
            &version_marker_path(input.root, current),
            filesystem,
        )?;
    }
    if metadata.standard
        && input.no_overwrite
        && (exists(&metadata.content_path) || exists(&metadata.marker_path))
    {
        return Err(failure("DestinationExists"));
    }
    filesystem::mkdir(
        content_root,
        metadata
            .content_path
            .parent()
            .ok_or_else(|| failure("OwnershipMismatch"))?,
        filesystem,
    )?;
    filesystem::mkdir(
        marker_root,
        metadata
            .marker_path
            .parent()
            .ok_or_else(|| failure("OwnershipMismatch"))?,
        filesystem,
    )?;
    write_commit_phase(
        input.root,
        metadata,
        CommitPhase::ActivatingContent,
        filesystem,
    )?;
    filesystem::move_across(
        input.root,
        content_root,
        &prepared.stage_content,
        &metadata.content_path,
        filesystem,
    )?;
    write_commit_phase(
        input.root,
        metadata,
        CommitPhase::ActivatingMarker,
        filesystem,
    )?;
    filesystem::move_across(
        input.root,
        marker_root,
        &prepared.stage_marker,
        &metadata.marker_path,
        filesystem,
    )?;
    write_commit_phase(input.root, metadata, CommitPhase::Available, filesystem)
}
pub fn finalize_commit(
    prepared: &PreparedCommit<'_>,
    filesystem: &Hooks<'_>,
) -> Result<(), Failure> {
    write_commit_phase(
        prepared.input.root,
        &prepared.metadata,
        CommitPhase::Committed,
        filesystem,
    )?;
    filesystem::remove(
        prepared.input.root,
        &prepared.metadata.stage_root,
        true,
        filesystem,
    )?;
    Ok(())
}
pub fn read_active(
    root: &Path,
    kind: &project_artifact::Kind,
    id: &project_artifact::Id,
    filesystem: &Hooks<'_>,
) -> Result<Option<Marker>, Failure> {
    Ok(read_marker(
        root,
        &active_marker_path(root, kind, id),
        filesystem,
    ))
}
pub fn read_commit_transactions(
    root: &Path,
    filesystem: &Hooks<'_>,
) -> Result<Vec<CommitTransactionMetadata>, Failure> {
    let scope = scope_ownership(root, filesystem)?;
    let mut values = Vec::new();
    for stage_root in directories(&root.join("staging")) {
        let metadata = read_commit_journal(root, &stage_root, filesystem);
        let Some(metadata) = metadata else {
            if exists(&commit_journal_path(&stage_root)) {
                return Err(failure("ReconciliationRequired"));
            }
            continue;
        };
        if (&metadata.marker.scope_id, &metadata.marker.storage_id) != (&scope.0, &scope.1)
            || !valid_commit_metadata(root, &metadata)
        {
            return Err(failure("ReconciliationRequired"));
        }
        values.push(metadata);
    }
    values.sort_by(|a, b| a.operation_id.cmp(&b.operation_id));
    Ok(values)
}
pub fn cleanup_commit_transaction(
    metadata: &CommitTransactionMetadata,
    filesystem: &Hooks<'_>,
) -> Result<CommitTransactionMetadata, Failure> {
    let root = transaction_root(&metadata.stage_root)?;
    with_artifact_lock(root, &metadata.marker, || {
        cleanup_commit_transaction_unsafe(metadata, filesystem)
    })
}

fn cleanup_commit_transaction_unsafe(
    metadata: &CommitTransactionMetadata,
    filesystem: &Hooks<'_>,
) -> Result<CommitTransactionMetadata, Failure> {
    let root = transaction_root(&metadata.stage_root)?;
    let scope = scope_ownership(root, filesystem)?;
    if (&metadata.marker.scope_id, &metadata.marker.storage_id) != (&scope.0, &scope.1)
        || !valid_commit_metadata(root, metadata)
    {
        return Err(failure("ReconciliationRequired"));
    }
    let stored = read_commit_journal(root, &metadata.stage_root, filesystem);
    if stored.is_none() && exists(&metadata.stage_root) {
        return Err(failure("ReconciliationRequired"));
    }
    let stored = stored.unwrap_or_else(|| metadata.clone());
    if (CommitTransactionMetadata {
        phase: metadata.phase,
        ..stored.clone()
    }) != *metadata
        || !matches!(
            stored.phase,
            CommitPhase::Finalizing | CommitPhase::Committed
        )
    {
        return Err(failure("ReconciliationRequired"));
    }
    require_available_commit(root, &stored, filesystem)?;
    filesystem::remove(root, &stored.stage_root, true, filesystem)?;
    Ok(stored)
}
fn prepare_or_resume_commit<'a>(
    input: CommitInput<'a>,
    filesystem: &Hooks<'_>,
) -> Result<PreparedCommit<'a>, Failure> {
    let (content_path, marker_path) = location(input.root, input.marker, input.standard)?;
    let mut matches = Vec::new();
    for metadata in read_commit_transactions(input.root, filesystem)? {
        if same_ownership(&metadata.marker, input.marker)
            && metadata.marker.version_id != input.marker.version_id
        {
            return Err(failure("VersionConflict"));
        }
        if metadata.marker.version_id != input.marker.version_id
            || metadata.marker.content_digest != input.marker.content_digest
            || !same_ownership(&metadata.marker, input.marker)
        {
            continue;
        }
        if metadata.content_path != content_path
            || metadata.marker_path != marker_path
            || metadata.standard != input.standard.is_some()
            || input
                .operation_id
                .is_some_and(|id| metadata.operation_id != id)
        {
            return Err(failure("ReconciliationRequired"));
        }
        matches.push(metadata);
    }
    if matches.len() > 1 {
        return Err(failure("ReconciliationRequired"));
    }
    let Some(metadata) = matches.pop() else {
        return prepare_commit(input, filesystem);
    };
    let prepared = PreparedCommit {
        stage_content: metadata.stage_root.join(
            metadata
                .marker
                .content_relpath
                .as_lossless()
                .as_str()
                .expect("validated path"),
        ),
        stage_marker: metadata.stage_root.join(".ycoding-project-artifact.json"),
        input,
        metadata,
    };
    if matches!(
        prepared.metadata.phase,
        CommitPhase::Available | CommitPhase::Finalizing | CommitPhase::Committed
    ) {
        return Ok(prepared);
    }
    reconcile_prepared_commit(input.root, &prepared.metadata, filesystem)?;
    if !exists(&prepared.metadata.stage_root) {
        return prepare_commit(input, filesystem);
    }
    let metadata = read_commit_journal(input.root, &prepared.metadata.stage_root, filesystem)
        .ok_or_else(|| failure("ReconciliationRequired"))?;
    Ok(PreparedCommit {
        metadata,
        ..prepared
    })
}
fn compensate_commit_failure<E>(
    attempt: TransactionError<E>,
    prepared: &PreparedCommit<'_>,
    filesystem: &Hooks<'_>,
    hooks: &TransactionHooks<'_, CommitTransactionMetadata, E>,
) -> Result<CommitTransactionMetadata, TransactionError<E>> {
    if hooks.can_compensate.is_some_and(|allowed| !allowed()) {
        return Err(attempt);
    }
    let interrupted = read_commit_journal(
        prepared.input.root,
        &prepared.metadata.stage_root,
        filesystem,
    );
    let compensation = (|| {
        write_commit_phase(
            prepared.input.root,
            &prepared.metadata,
            CommitPhase::Compensating,
            filesystem,
        )?;
        compensate_metadata(prepared.input.root, &prepared.metadata, filesystem)?;
        write_commit_phase(
            prepared.input.root,
            &prepared.metadata,
            CommitPhase::Compensated,
            filesystem,
        )
    })();
    let metadata = match compensation {
        Ok(metadata) => metadata,
        Err(_) => {
            if let Some(interrupted) = interrupted {
                let _ = write_commit_phase(
                    prepared.input.root,
                    &prepared.metadata,
                    interrupted.phase,
                    filesystem,
                );
            }
            return Err(attempt);
        }
    };
    if let Some(abort) = hooks.abort {
        abort(&metadata).map_err(TransactionError::Hook)?;
    }
    filesystem::remove(
        prepared.input.root,
        &prepared.metadata.stage_root,
        true,
        filesystem,
    )
    .map_err(Failure::from)?;
    Err(attempt)
}
pub(super) fn check_cancellation<E>(
    cancellation: Option<&Cancellation>,
) -> Result<(), TransactionError<E>> {
    if cancellation.is_some_and(Cancellation::is_cancelled) {
        return Err(TransactionError::Interrupted);
    }
    Ok(())
}
fn compensate_metadata(
    root: &Path,
    metadata: &CommitTransactionMetadata,
    filesystem: &Hooks<'_>,
) -> Result<(), Failure> {
    let content_root = content_root(root, metadata);
    let marker_root = marker_root(root, metadata);
    let active = read_marker(marker_root, &metadata.marker_path, filesystem);
    if active
        .as_ref()
        .is_some_and(|active| active.version_id == metadata.marker.version_id)
    {
        if exists(&metadata.marker_path) {
            filesystem::remove(marker_root, &metadata.marker_path, false, filesystem)?;
        }
        if exists(&metadata.content_path) {
            filesystem::remove(content_root, &metadata.content_path, false, filesystem)?;
        }
    } else if active.is_none()
        && content_matches(
            content_root,
            &metadata.content_path,
            &metadata.marker,
            filesystem,
        )
    {
        filesystem::remove(content_root, &metadata.content_path, false, filesystem)?;
    }
    let Some(current) = &metadata.previous else {
        return Ok(());
    };
    let historical_content = version_content_path(root, current);
    let historical_marker = version_marker_path(root, current);
    if !exists(&metadata.content_path) && exists(&historical_content) {
        filesystem::move_across(
            root,
            content_root,
            &historical_content,
            &metadata.content_path,
            filesystem,
        )?;
    }
    if !exists(&metadata.marker_path) && exists(&historical_marker) {
        filesystem::write(
            marker_root,
            &metadata.marker_path,
            &filesystem::read_text(root, &historical_marker, filesystem)?,
            true,
            filesystem,
        )?;
        filesystem::remove(root, &historical_marker, false, filesystem)?;
    }
    require_complete_layout(
        content_root,
        &metadata.content_path,
        marker_root,
        &metadata.marker_path,
        current,
        filesystem,
    )
    .map_err(|_| failure("ReconciliationRequired"))?;
    if exists(&version_root(root, current)) {
        filesystem::remove(root, &version_root(root, current), true, filesystem)?;
    }
    Ok(())
}
fn reconcile_prepared_commit(
    root: &Path,
    metadata: &CommitTransactionMetadata,
    filesystem: &Hooks<'_>,
) -> Result<(), Failure> {
    match metadata.phase {
        CommitPhase::Prepared
        | CommitPhase::Reserved
        | CommitPhase::ArchivingContent
        | CommitPhase::ArchivingMarker
        | CommitPhase::Compensating
        | CommitPhase::Compensated => {
            compensate_metadata(root, metadata, filesystem)?;
            filesystem::remove(root, &metadata.stage_root, true, filesystem)?;
            return Ok(());
        }
        CommitPhase::Finalizing => return require_available_commit(root, metadata, filesystem),
        CommitPhase::Committed => {
            require_available_commit(root, metadata, filesystem)?;
            filesystem::remove(root, &metadata.stage_root, true, filesystem)?;
            return Ok(());
        }
        _ => {}
    }
    let content_root = content_root(root, metadata);
    let marker_root = marker_root(root, metadata);
    let stage_content = metadata.stage_root.join(
        metadata
            .marker
            .content_relpath
            .as_lossless()
            .as_str()
            .expect("validated path"),
    );
    let stage_marker = metadata.stage_root.join(".ycoding-project-artifact.json");
    if !content_matches(
        content_root,
        &metadata.content_path,
        &metadata.marker,
        filesystem,
    ) {
        if !content_matches(root, &stage_content, &metadata.marker, filesystem) {
            return Err(failure("ReconciliationRequired"));
        }
        filesystem::move_across(
            root,
            content_root,
            &stage_content,
            &metadata.content_path,
            filesystem,
        )?;
    }
    if !read_marker(marker_root, &metadata.marker_path, filesystem)
        .is_some_and(|active| active.version_id == metadata.marker.version_id)
    {
        if !read_marker(root, &stage_marker, filesystem)
            .is_some_and(|staged| staged.version_id == metadata.marker.version_id)
            || exists(&metadata.marker_path)
        {
            return Err(failure("ReconciliationRequired"));
        }
        filesystem::move_across(
            root,
            marker_root,
            &stage_marker,
            &metadata.marker_path,
            filesystem,
        )?;
    }
    require_available_commit(root, metadata, filesystem)
        .map_err(|_| failure("ReconciliationRequired"))?;
    write_commit_phase(root, metadata, CommitPhase::Available, filesystem)?;
    Ok(())
}
fn require_available_commit(
    root: &Path,
    metadata: &CommitTransactionMetadata,
    filesystem: &Hooks<'_>,
) -> Result<(), Failure> {
    require_complete_layout(
        content_root(root, metadata),
        &metadata.content_path,
        marker_root(root, metadata),
        &metadata.marker_path,
        &metadata.marker,
        filesystem,
    )
}
fn require_complete_layout(
    content_root: &Path,
    content_path: &Path,
    marker_root: &Path,
    marker_path: &Path,
    expected: &Marker,
    filesystem: &Hooks<'_>,
) -> Result<(), Failure> {
    let Some(stored) = read_marker(marker_root, marker_path, filesystem) else {
        return Err(failure("OwnershipMismatch"));
    };
    if stored.version_id != expected.version_id
        || stored.content_digest != expected.content_digest
        || !same_ownership(&stored, expected)
        || !content_matches(content_root, content_path, &stored, filesystem)
    {
        return Err(failure("OwnershipMismatch"));
    }
    Ok(())
}
fn write_commit_phase(
    root: &Path,
    metadata: &CommitTransactionMetadata,
    phase: CommitPhase,
    filesystem: &Hooks<'_>,
) -> Result<CommitTransactionMetadata, Failure> {
    let value = CommitTransactionMetadata {
        phase,
        ..metadata.clone()
    };
    replace_file(
        root,
        &commit_journal_path(&metadata.stage_root),
        &ycoding_schema::stringify_json(&value.encode()),
        filesystem,
    )?;
    Ok(value)
}
fn read_commit_journal(
    root: &Path,
    stage_root: &Path,
    filesystem: &Hooks<'_>,
) -> Option<CommitTransactionMetadata> {
    CommitTransactionMetadata::decode(
        &ycoding_schema::parse_json(
            &filesystem::read_text(root, &commit_journal_path(stage_root), filesystem).ok()?,
        )
        .ok()?,
    )
    .ok()
}
fn valid_commit_metadata(root: &Path, metadata: &CommitTransactionMetadata) -> bool {
    if !valid_operation_id(&metadata.operation_id)
        || metadata.stage_root != root.join("staging").join(&metadata.operation_id)
        || metadata.marker.content_relpath.as_lossless().as_str()
            != Some(&relative_content_path(
                &metadata.marker.kind,
                &metadata.marker.id,
            ))
        || metadata.previous.as_ref().is_some_and(|previous| {
            !same_ownership(previous, &metadata.marker)
                || previous.version_id == metadata.marker.version_id
                || previous.content_relpath.as_lossless().as_str()
                    != Some(&relative_content_path(&previous.kind, &previous.id))
        })
    {
        return false;
    }
    if metadata.standard {
        return valid_standard_paths(
            &metadata.marker,
            &metadata.content_path,
            &metadata.marker_path,
        );
    }
    metadata.content_path == active_content_path(root, &metadata.marker.kind, &metadata.marker.id)
        && metadata.marker_path
            == active_marker_path(root, &metadata.marker.kind, &metadata.marker.id)
}
fn location(
    root: &Path,
    marker: &Marker,
    standard: Option<StandardTarget<'_>>,
) -> Result<(PathBuf, PathBuf), Failure> {
    if let Some(target) = standard {
        if !valid_standard_paths(marker, target.content_path, target.marker_path) {
            return Err(failure("OwnershipMismatch"));
        }
        return Ok((target.content_path.into(), target.marker_path.into()));
    }
    Ok((
        active_content_path(root, &marker.kind, &marker.id),
        active_marker_path(root, &marker.kind, &marker.id),
    ))
}
fn valid_standard_paths(marker: &Marker, content: &Path, metadata: &Path) -> bool {
    if !content.is_absolute() || !metadata.is_absolute() || content.parent() != metadata.parent() {
        return false;
    }
    let id = marker.id.as_lossless().as_str().expect("validated ID");
    if marker.kind.as_lossless().as_str() == Some("skill") {
        return content
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name == id)
            && content.file_name().is_some_and(|name| name == "SKILL.md")
            && metadata
                .file_name()
                .is_some_and(|name| name == ".ycoding-project-artifact.json");
    }
    content
        .file_name()
        .is_some_and(|name| name == relative_content_path(&marker.kind, &marker.id).as_str())
        && metadata
            .file_name()
            .is_some_and(|name| name == format!(".{id}.ycoding-project-artifact.json").as_str())
}
fn validate_expectation(
    current: Option<&Marker>,
    expected: Option<&project_artifact::VersionId>,
) -> Result<(), Failure> {
    match (current, expected) {
        (None, Some(_)) => Err(failure("VersionConflict")),
        (Some(_), None) => Err(failure("ArtifactCollision")),
        (Some(current), Some(expected)) if &current.version_id != expected => {
            Err(failure("VersionConflict"))
        }
        _ => Ok(()),
    }
}
fn same_ownership(left: &Marker, right: &Marker) -> bool {
    left.scope_id == right.scope_id
        && left.storage_id == right.storage_id
        && left.kind == right.kind
        && left.id == right.id
}
fn scope_ownership(
    root: &Path,
    filesystem: &Hooks<'_>,
) -> Result<(project_artifact::ScopeId, project_artifact::StorageId), Failure> {
    let value = ycoding_schema::parse_json(
        &filesystem::read_text(root, &scope_marker_path(root), filesystem)
            .map_err(|_| failure("OwnershipMismatch"))?,
    )
    .map_err(|_| failure("OwnershipMismatch"))?;
    let path = JsonPath::default();
    let object = ObjectDecoder::new(&value, &path).map_err(|_| failure("OwnershipMismatch"))?;
    Ok((
        object
            .field("scopeID")
            .map_err(|_| failure("OwnershipMismatch"))?,
        object
            .field("storageID")
            .map_err(|_| failure("OwnershipMismatch"))?,
    ))
}
fn content_matches(root: &Path, path: &Path, marker: &Marker, filesystem: &Hooks<'_>) -> bool {
    filesystem::read_text(root, path, filesystem)
        .is_ok_and(|content| sha256(&content.as_str().into()) == marker.content_digest)
}
fn read_marker(root: &Path, path: &Path, filesystem: &Hooks<'_>) -> Option<Marker> {
    Marker::decode(
        &ycoding_schema::parse_json(&filesystem::read_text(root, path, filesystem).ok()?).ok()?,
    )
    .ok()
}
fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| !metadata.is_symlink())
}
fn directories(path: &Path) -> Vec<PathBuf> {
    fs::read_dir(path)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_type()
                .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
        })
        .map(|entry| entry.path())
        .collect()
}
fn replace_file(
    root: &Path,
    path: &Path,
    content: &str,
    filesystem: &Hooks<'_>,
) -> Result<(), Failure> {
    let temporary = path.with_file_name(format!(
        "{}.{}.tmp",
        path.file_name()
            .ok_or_else(|| failure("OwnershipMismatch"))?
            .to_string_lossy(),
        uuid()?
    ));
    filesystem::write(root, &temporary, content, true, filesystem)?;
    let result = filesystem::execute_mutation(
        filesystem::MutationRequest::Rename {
            source_root: root,
            destination_root: root,
            source: &temporary,
            destination: path,
            replace: true,
        },
        filesystem,
    );
    if let Err(error) = result {
        filesystem::remove(root, &temporary, false, filesystem)?;
        return Err(error.into());
    }
    Ok(())
}
pub(super) fn package_lock(root: &Path, key: &str) -> Result<fs::File, Failure> {
    filesystem::mkdir(root, &root.join("locks"), &Hooks::default())?;
    let hash = digest::digest(&digest::SHA1_FOR_LEGACY_USE_ONLY, key.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let path = root.join("locks").join(format!("{hash}.lock"));
    filesystem::assert_safe_path(root, &path)?;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)
        .map_err(|_| failure("StorageUnavailable"))?;
    let started = Instant::now();
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(fs::TryLockError::WouldBlock) => {}
            Err(_) => return Err(failure("StorageUnavailable")),
        }
        if started.elapsed() >= Duration::from_secs(300) {
            return Err(failure("LockTimeout"));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
fn lock_key(marker: &Marker) -> String {
    lock_identity(&marker.scope_id, &marker.kind, &marker.id)
}
fn lock_identity(
    scope: &project_artifact::ScopeId,
    kind: &project_artifact::Kind,
    id: &project_artifact::Id,
) -> String {
    format!(
        "project-artifact:{}:{}:{}",
        scope.as_lossless().as_str().expect("validated scope ID"),
        kind.as_lossless().as_str().expect("validated kind"),
        id.as_lossless().as_str().expect("validated ID")
    )
}
fn commit_journal_path(stage_root: &Path) -> PathBuf {
    stage_root.join(".ycoding-operation.json")
}
fn transaction_root(stage_root: &Path) -> Result<&Path, Failure> {
    stage_root
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| failure("ReconciliationRequired"))
}
fn content_root<'a>(root: &'a Path, metadata: &'a CommitTransactionMetadata) -> &'a Path {
    if metadata.standard {
        metadata
            .content_path
            .parent()
            .expect("validated content path")
    } else {
        root
    }
}
fn marker_root<'a>(root: &'a Path, metadata: &'a CommitTransactionMetadata) -> &'a Path {
    if metadata.standard {
        metadata
            .marker_path
            .parent()
            .expect("validated marker path")
    } else {
        root
    }
}
fn valid_operation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}
fn path_text(path: &Path) -> LosslessString {
    path.to_string_lossy().as_ref().into()
}
fn string_field(
    object: &ObjectDecoder<'_>,
    path: &JsonPath,
    key: &str,
) -> Result<String, DecodeError> {
    object.field::<LosslessString>(key)?.to_utf8().map_err(|_| {
        path.key(key)
            .error(ycoding_schema::DecodeErrorKind::Expected(
                "Unicode filesystem text",
            ))
    })
}
pub(super) fn uuid() -> Result<String, Failure> {
    let mut bytes = [0u8; 16];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| failure("StorageUnavailable"))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(bytes
        .iter()
        .enumerate()
        .map(|(index, byte)| {
            format!(
                "{}{byte:02x}",
                if [4, 6, 8, 10].contains(&index) {
                    "-"
                } else {
                    ""
                }
            )
        })
        .collect())
}
fn failure(code: &str) -> Failure {
    Failure {
        code: project_artifact::ErrorCode::decode(&JsonValue::String(code.into()))
            .expect("fixed package failure code"),
    }
}

fn relative_content_path(kind: &project_artifact::Kind, id: &project_artifact::Id) -> String {
    match kind.as_lossless().as_str() {
        Some("skill") => "SKILL.md".into(),
        Some("command" | "agent") => {
            format!("{}.md", id.as_lossless().as_str().expect("validated ID"))
        }
        _ => format!("{}.ts", id.as_lossless().as_str().expect("validated ID")),
    }
}
