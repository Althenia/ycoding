use super::{
    Failure, Marker, StandardTarget, TransactionError, TransactionHooks, directories, exists,
    failure, location, lock_key, package_lock, path_text, read_marker, relative_content_path,
    replace_file, require_complete_layout, same_ownership, scope_ownership, string_field,
    transaction_root, valid_operation_id, valid_standard_paths, with_artifact_lock,
};
use crate::resources::project_artifact::filesystem::{self, Hooks};
use std::{
    convert::Infallible,
    path::{Path, PathBuf},
};
use ycoding_schema::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder,
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum StateOperation {
    Disable,
    Enable,
    Rollback,
}
impl DomainEncode for StateOperation {
    fn encode(&self) -> JsonValue {
        JsonValue::String(
            match self {
                Self::Disable => "disable",
                Self::Enable => "enable",
                Self::Rollback => "rollback",
            }
            .into(),
        )
    }
}
impl DomainDecode for StateOperation {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        match LosslessString::decode_at(value, path)?.as_str() {
            Some("disable") => Ok(Self::Disable),
            Some("enable") => Ok(Self::Enable),
            Some("rollback") => Ok(Self::Rollback),
            _ => Err(path.error(ycoding_schema::DecodeErrorKind::Expected(
                "state mutation operation",
            ))),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum StatePhase {
    Prepared,
    MovingCurrentContent,
    MovingCurrentMarker,
    MovingTargetContent,
    MovingTargetMarker,
    RestoringTargetContent,
    RestoringTargetMarker,
    RestoringCurrentContent,
    RestoringCurrentMarker,
    Available,
    Finalizing,
    Committed,
    Compensating,
    Compensated,
}
impl DomainEncode for StatePhase {
    fn encode(&self) -> JsonValue {
        JsonValue::String(
            match self {
                Self::Prepared => "prepared",
                Self::MovingCurrentContent => "moving-current-content",
                Self::MovingCurrentMarker => "moving-current-marker",
                Self::MovingTargetContent => "moving-target-content",
                Self::MovingTargetMarker => "moving-target-marker",
                Self::RestoringTargetContent => "restoring-target-content",
                Self::RestoringTargetMarker => "restoring-target-marker",
                Self::RestoringCurrentContent => "restoring-current-content",
                Self::RestoringCurrentMarker => "restoring-current-marker",
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
impl DomainDecode for StatePhase {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        match LosslessString::decode_at(value, path)?.as_str() {
            Some("prepared") => Ok(Self::Prepared),
            Some("moving-current-content") => Ok(Self::MovingCurrentContent),
            Some("moving-current-marker") => Ok(Self::MovingCurrentMarker),
            Some("moving-target-content") => Ok(Self::MovingTargetContent),
            Some("moving-target-marker") => Ok(Self::MovingTargetMarker),
            Some("restoring-target-content") => Ok(Self::RestoringTargetContent),
            Some("restoring-target-marker") => Ok(Self::RestoringTargetMarker),
            Some("restoring-current-content") => Ok(Self::RestoringCurrentContent),
            Some("restoring-current-marker") => Ok(Self::RestoringCurrentMarker),
            Some("available") => Ok(Self::Available),
            Some("finalizing") => Ok(Self::Finalizing),
            Some("committed") => Ok(Self::Committed),
            Some("compensating") => Ok(Self::Compensating),
            Some("compensated") => Ok(Self::Compensated),
            _ => Err(path.error(ycoding_schema::DecodeErrorKind::Expected(
                "state mutation phase",
            ))),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct StateMutationMetadata {
    pub operation_id: String,
    pub phase: StatePhase,
    pub operation: StateOperation,
    pub current: Marker,
    pub target: Option<Marker>,
    pub stage_root: PathBuf,
    pub content_path: PathBuf,
    pub marker_path: PathBuf,
    pub standard: bool,
    pub context: Option<LosslessString>,
}
impl DomainDecode for StateMutationMetadata {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        object.literal("schema", &JsonValue::Number(1.0))?;
        Ok(Self {
            operation_id: string_field(&object, path, "operationID")?,
            phase: object.field("phase")?,
            operation: object.field("operation")?,
            current: object.field("current")?,
            target: object.optional("target")?,
            stage_root: string_field(&object, path, "stageRoot")?.into(),
            content_path: string_field(&object, path, "contentPath")?.into(),
            marker_path: string_field(&object, path, "markerPath")?.into(),
            standard: object.field("standard")?,
            context: object.optional("context")?,
        })
    }
}
impl DomainEncode for StateMutationMetadata {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("schema", &1.0)
            .field("operationID", self.operation_id.as_str())
            .field("phase", &self.phase)
            .field("operation", &self.operation)
            .field("current", &self.current)
            .optional("target", &self.target)
            .field("stageRoot", &path_text(&self.stage_root))
            .field("contentPath", &path_text(&self.content_path))
            .field("markerPath", &path_text(&self.marker_path))
            .field("standard", &self.standard)
            .optional("context", &self.context)
            .finish()
    }
}
#[derive(Clone, Copy)]
pub struct StateMutationInput<'a> {
    pub root: &'a Path,
    pub operation_id: &'a str,
    pub operation: StateOperation,
    pub current: &'a Marker,
    pub target: Option<&'a Marker>,
    pub standard: Option<StandardTarget<'a>>,
    pub context: Option<&'a str>,
}
pub fn state_mutation(
    input: StateMutationInput<'_>,
    filesystem: &Hooks<'_>,
) -> Result<StateMutationMetadata, Failure> {
    match state_transaction::<Infallible>(
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
        Err(TransactionError::Interrupted) => {
            unreachable!("state_mutation has no cancellation token")
        }
    }
}
pub fn state_transaction<E>(
    input: StateMutationInput<'_>,
    filesystem: &Hooks<'_>,
    hooks: &TransactionHooks<'_, StateMutationMetadata, E>,
) -> Result<StateMutationMetadata, TransactionError<E>> {
    let _gate = package_lock(input.root, "project-artifact:reconcile")?;
    let _artifact = package_lock(input.root, &lock_key(input.current))?;
    let prepared = prepare_or_resume(input, filesystem)?;
    if prepared.phase == StatePhase::Committed {
        let _ = cleanup_state_transaction_unsafe(&prepared, filesystem);
        return Ok(prepared);
    }
    let before_finalize = (|| {
        super::check_cancellation(hooks.cancellation)?;
        let available = matches!(
            prepared.phase,
            StatePhase::Available | StatePhase::Finalizing
        );
        let metadata = StateMutationMetadata {
            phase: if available {
                StatePhase::Available
            } else {
                prepared.phase
            },
            ..prepared.clone()
        };
        if let Some(reserve) = hooks.reserve {
            reserve(&metadata).map_err(TransactionError::Hook)?;
        }
        super::check_cancellation(hooks.cancellation)?;
        let ready = if available {
            metadata
        } else {
            make_available(&prepared, filesystem)?
        };
        super::check_cancellation(hooks.cancellation)?;
        write_phase(&ready, StatePhase::Finalizing, filesystem)?;
        super::check_cancellation(hooks.cancellation)?;
        Ok(ready)
    })();
    let ready = match before_finalize {
        Ok(metadata) => metadata,
        Err(error) => return compensate_failure(error, &prepared, filesystem, hooks),
    };
    if let Some(finalize) = hooks.finalize
        && let Err(error) = finalize(&ready)
    {
        if hooks.can_compensate.is_some_and(|allowed| !allowed()) {
            return Err(TransactionError::Hook(error));
        }
        return compensate_failure(TransactionError::Hook(error), &prepared, filesystem, hooks);
    }
    let committed = match write_phase(&ready, StatePhase::Committed, filesystem) {
        Ok(metadata) => metadata,
        Err(_) => {
            super::check_cancellation(hooks.cancellation)?;
            return Ok(StateMutationMetadata {
                phase: StatePhase::Finalizing,
                ..ready
            });
        }
    };
    let _ = filesystem::remove(input.root, &committed.stage_root, true, filesystem);
    super::check_cancellation(hooks.cancellation)?;
    Ok(committed)
}
pub fn disabled_content_path(root: &Path, marker: &Marker) -> PathBuf {
    disabled_root(root, marker).join(
        marker
            .content_relpath
            .as_lossless()
            .as_str()
            .expect("validated path"),
    )
}
pub(super) fn disabled_root(root: &Path, marker: &Marker) -> PathBuf {
    root.join("disabled")
        .join(marker.kind.as_lossless().as_str().expect("validated kind"))
        .join(marker.id.as_lossless().as_str().expect("validated ID"))
        .join(
            marker
                .version_id
                .as_lossless()
                .as_str()
                .expect("validated version ID"),
        )
}
pub fn read_state_transactions(
    root: &Path,
    filesystem: &Hooks<'_>,
) -> Result<Vec<StateMutationMetadata>, Failure> {
    let scope = scope_ownership(root, filesystem)?;
    let mut values = Vec::new();
    for stage_root in directories(&root.join("staging")) {
        let Some(metadata) = read_journal(root, &stage_root, filesystem) else {
            if exists(&journal_path(&stage_root)) {
                return Err(failure("ReconciliationRequired"));
            }
            continue;
        };
        if (&metadata.current.scope_id, &metadata.current.storage_id) != (&scope.0, &scope.1)
            || !valid_metadata(root, &metadata)
        {
            return Err(failure("ReconciliationRequired"));
        }
        values.push(metadata);
    }
    values.sort_by(|a, b| a.operation_id.cmp(&b.operation_id));
    Ok(values)
}
pub fn cleanup_state_transaction(
    metadata: &StateMutationMetadata,
    filesystem: &Hooks<'_>,
) -> Result<StateMutationMetadata, Failure> {
    let root = transaction_root(&metadata.stage_root)?;
    with_artifact_lock(root, &metadata.current, || {
        cleanup_state_transaction_unsafe(metadata, filesystem)
    })
}
fn cleanup_state_transaction_unsafe(
    metadata: &StateMutationMetadata,
    filesystem: &Hooks<'_>,
) -> Result<StateMutationMetadata, Failure> {
    let root = transaction_root(&metadata.stage_root)?;
    let scope = scope_ownership(root, filesystem)?;
    if (&metadata.current.scope_id, &metadata.current.storage_id) != (&scope.0, &scope.1)
        || !valid_metadata(root, metadata)
    {
        return Err(failure("ReconciliationRequired"));
    }
    let stored = read_journal(root, &metadata.stage_root, filesystem);
    if stored.is_none() && exists(&metadata.stage_root) {
        return Err(failure("ReconciliationRequired"));
    }
    let value = stored.unwrap_or_else(|| metadata.clone());
    if (StateMutationMetadata {
        phase: metadata.phase,
        ..value.clone()
    }) != *metadata
        || !matches!(value.phase, StatePhase::Finalizing | StatePhase::Committed)
    {
        return Err(failure("ReconciliationRequired"));
    }
    require_available(&value, filesystem)?;
    filesystem::remove(root, &value.stage_root, true, filesystem)?;
    Ok(value)
}
fn prepare_or_resume(
    input: StateMutationInput<'_>,
    filesystem: &Hooks<'_>,
) -> Result<StateMutationMetadata, Failure> {
    if !valid_operation_id(input.operation_id) {
        return Err(failure("InvalidArtifact"));
    }
    let stage_root = input.root.join("staging").join(input.operation_id);
    let (content_path, marker_path) = location(input.root, input.current, input.standard)?;
    if exists(&stage_root) {
        let Some(pending) = read_journal(input.root, &stage_root, filesystem) else {
            return Err(failure("ReconciliationRequired"));
        };
        if !valid_metadata(input.root, &pending)
            || pending.operation_id != input.operation_id
            || pending.operation != input.operation
            || pending.current.version_id != input.current.version_id
            || pending.current.content_digest != input.current.content_digest
            || !same_ownership(&pending.current, input.current)
            || pending
                .target
                .as_ref()
                .map(|m| (&m.version_id, &m.content_digest))
                != input.target.map(|m| (&m.version_id, &m.content_digest))
            || pending
                .target
                .as_ref()
                .zip(input.target)
                .is_some_and(|(a, b)| !same_ownership(a, b))
            || pending.content_path != content_path
            || pending.marker_path != marker_path
            || pending.standard != input.standard.is_some()
            || pending.context.as_ref().and_then(LosslessString::as_str) != input.context
        {
            return Err(failure("ReconciliationRequired"));
        }
        if pending.phase != StatePhase::Compensated {
            return Ok(pending);
        }
        filesystem::remove(input.root, &stage_root, true, filesystem)?;
    }
    let scope = scope_ownership(input.root, filesystem)?;
    if (&input.current.scope_id, &input.current.storage_id) != (&scope.0, &scope.1) {
        return Err(failure("OwnershipMismatch"));
    }
    if input.operation == StateOperation::Rollback {
        if !input.target.is_some_and(|target| {
            (&target.scope_id, &target.storage_id) == (&scope.0, &scope.1)
                && same_ownership(target, input.current)
        }) {
            return Err(failure("OwnershipMismatch"));
        }
    } else if input.target.is_some() {
        return Err(failure("InvalidArtifact"));
    }
    let content_root = if input.standard.is_some() {
        content_path.parent().expect("validated standard path")
    } else {
        input.root
    };
    let marker_root = if input.standard.is_some() {
        marker_path.parent().expect("validated standard path")
    } else {
        input.root
    };
    filesystem::assert_safe_path(content_root, &content_path)?;
    filesystem::assert_safe_path(marker_root, &marker_path)?;
    if input.operation == StateOperation::Enable {
        require_complete_layout(
            input.root,
            &disabled_content_path(input.root, input.current),
            input.root,
            &disabled_root(input.root, input.current).join(".ycoding-project-artifact.json"),
            input.current,
            filesystem,
        )?;
        if exists(&content_path) || exists(&marker_path) {
            return Err(failure("DestinationExists"));
        }
    } else {
        require_complete_layout(
            content_root,
            &content_path,
            marker_root,
            &marker_path,
            input.current,
            filesystem,
        )?;
        if exists(&disabled_root(input.root, input.current)) {
            return Err(failure("DestinationExists"));
        }
    }
    if let Some(target) = input.target {
        require_complete_layout(
            input.root,
            &super::version_content_path(input.root, target),
            input.root,
            &super::version_marker_path(input.root, target),
            target,
            filesystem,
        )?;
    }
    filesystem::mkdir(input.root, &stage_root, filesystem)?;
    let metadata = StateMutationMetadata {
        operation_id: input.operation_id.into(),
        phase: StatePhase::Prepared,
        operation: input.operation,
        current: input.current.clone(),
        target: input.target.cloned(),
        stage_root,
        content_path,
        marker_path,
        standard: input.standard.is_some(),
        context: input.context.map(Into::into),
    };
    filesystem::write(
        input.root,
        &journal_path(&metadata.stage_root),
        &ycoding_schema::stringify_json(&metadata.encode()),
        true,
        filesystem,
    )?;
    Ok(metadata)
}
fn make_available(
    metadata: &StateMutationMetadata,
    filesystem: &Hooks<'_>,
) -> Result<StateMutationMetadata, Failure> {
    let root = transaction_root(&metadata.stage_root)?;
    let (content_root, marker_root) = roots(root, metadata);
    let disabled = disabled_root(root, &metadata.current);
    if metadata.operation == StateOperation::Enable {
        write_phase(metadata, StatePhase::MovingCurrentContent, filesystem)?;
        filesystem::move_across(
            root,
            content_root,
            &disabled_content_path(root, &metadata.current),
            &metadata.content_path,
            filesystem,
        )?;
        write_phase(metadata, StatePhase::MovingCurrentMarker, filesystem)?;
        filesystem::move_across(
            root,
            marker_root,
            &disabled.join(".ycoding-project-artifact.json"),
            &metadata.marker_path,
            filesystem,
        )?;
        filesystem::remove(root, &disabled, true, filesystem)?;
    } else {
        filesystem::mkdir(root, &disabled, filesystem)?;
        write_phase(metadata, StatePhase::MovingCurrentContent, filesystem)?;
        filesystem::move_across(
            content_root,
            root,
            &metadata.content_path,
            &disabled_content_path(root, &metadata.current),
            filesystem,
        )?;
        write_phase(metadata, StatePhase::MovingCurrentMarker, filesystem)?;
        filesystem::move_across(
            marker_root,
            root,
            &metadata.marker_path,
            &disabled.join(".ycoding-project-artifact.json"),
            filesystem,
        )?;
        if let Some(target) = &metadata.target {
            write_phase(metadata, StatePhase::MovingTargetContent, filesystem)?;
            filesystem::move_across(
                root,
                content_root,
                &super::version_content_path(root, target),
                &metadata.content_path,
                filesystem,
            )?;
            write_phase(metadata, StatePhase::MovingTargetMarker, filesystem)?;
            filesystem::move_across(
                root,
                marker_root,
                &super::version_marker_path(root, target),
                &metadata.marker_path,
                filesystem,
            )?;
            filesystem::remove(root, &super::version_root(root, target), true, filesystem)?;
        }
    }
    require_available(metadata, filesystem)?;
    write_phase(metadata, StatePhase::Available, filesystem)
}
fn compensate_failure<E>(
    attempt: TransactionError<E>,
    prepared: &StateMutationMetadata,
    filesystem: &Hooks<'_>,
    hooks: &TransactionHooks<'_, StateMutationMetadata, E>,
) -> Result<StateMutationMetadata, TransactionError<E>> {
    if hooks.can_compensate.is_some_and(|allowed| !allowed()) {
        return Err(attempt);
    }
    let compensation = (|| {
        let metadata = write_phase(prepared, StatePhase::Compensating, filesystem)?;
        compensate(&metadata, filesystem)?;
        write_phase(&metadata, StatePhase::Compensated, filesystem)
    })();
    let metadata = match compensation {
        Ok(metadata) => metadata,
        Err(_) => return Err(attempt),
    };
    if let Some(abort) = hooks.abort {
        abort(&metadata).map_err(TransactionError::Hook)?;
    }
    filesystem::remove(
        transaction_root(&prepared.stage_root)?,
        &metadata.stage_root,
        true,
        filesystem,
    )
    .map_err(Failure::from)?;
    Err(attempt)
}
fn compensate(metadata: &StateMutationMetadata, filesystem: &Hooks<'_>) -> Result<(), Failure> {
    let root = transaction_root(&metadata.stage_root)?;
    let (content_root, marker_root) = roots(root, metadata);
    let disabled = disabled_root(root, &metadata.current);
    if metadata.operation == StateOperation::Enable {
        filesystem::mkdir(root, &disabled, filesystem)?;
        if !exists(&disabled_content_path(root, &metadata.current))
            && super::content_matches(
                content_root,
                &metadata.content_path,
                &metadata.current,
                filesystem,
            )
        {
            write_phase(metadata, StatePhase::RestoringCurrentContent, filesystem)?;
            filesystem::move_across(
                content_root,
                root,
                &metadata.content_path,
                &disabled_content_path(root, &metadata.current),
                filesystem,
            )?;
        }
        if !exists(&disabled.join(".ycoding-project-artifact.json"))
            && read_marker(marker_root, &metadata.marker_path, filesystem)
                .is_some_and(|m| m.version_id == metadata.current.version_id)
        {
            write_phase(metadata, StatePhase::RestoringCurrentMarker, filesystem)?;
            filesystem::move_across(
                marker_root,
                root,
                &metadata.marker_path,
                &disabled.join(".ycoding-project-artifact.json"),
                filesystem,
            )?;
        }
        require_complete_layout(
            root,
            &disabled_content_path(root, &metadata.current),
            root,
            &disabled.join(".ycoding-project-artifact.json"),
            &metadata.current,
            filesystem,
        )?;
        if exists(&metadata.content_path) || exists(&metadata.marker_path) {
            return Err(failure("ReconciliationRequired"));
        }
        return Ok(());
    }
    if let Some(target) = &metadata.target {
        filesystem::mkdir(root, &super::version_root(root, target), filesystem)?;
        if !exists(&super::version_content_path(root, target))
            && super::content_matches(content_root, &metadata.content_path, target, filesystem)
        {
            write_phase(metadata, StatePhase::RestoringTargetContent, filesystem)?;
            filesystem::move_across(
                content_root,
                root,
                &metadata.content_path,
                &super::version_content_path(root, target),
                filesystem,
            )?;
        }
        if !exists(&super::version_marker_path(root, target))
            && read_marker(marker_root, &metadata.marker_path, filesystem)
                .is_some_and(|m| m.version_id == target.version_id)
        {
            write_phase(metadata, StatePhase::RestoringTargetMarker, filesystem)?;
            filesystem::move_across(
                marker_root,
                root,
                &metadata.marker_path,
                &super::version_marker_path(root, target),
                filesystem,
            )?;
        }
        require_complete_layout(
            root,
            &super::version_content_path(root, target),
            root,
            &super::version_marker_path(root, target),
            target,
            filesystem,
        )?;
    }
    if !exists(&metadata.content_path) && exists(&disabled_content_path(root, &metadata.current)) {
        write_phase(metadata, StatePhase::RestoringCurrentContent, filesystem)?;
        filesystem::move_across(
            root,
            content_root,
            &disabled_content_path(root, &metadata.current),
            &metadata.content_path,
            filesystem,
        )?;
    }
    if !exists(&metadata.marker_path) && exists(&disabled.join(".ycoding-project-artifact.json")) {
        write_phase(metadata, StatePhase::RestoringCurrentMarker, filesystem)?;
        filesystem::move_across(
            root,
            marker_root,
            &disabled.join(".ycoding-project-artifact.json"),
            &metadata.marker_path,
            filesystem,
        )?;
    }
    require_complete_layout(
        content_root,
        &metadata.content_path,
        marker_root,
        &metadata.marker_path,
        &metadata.current,
        filesystem,
    )?;
    filesystem::remove(root, &disabled, true, filesystem)?;
    Ok(())
}
fn require_available(
    metadata: &StateMutationMetadata,
    filesystem: &Hooks<'_>,
) -> Result<(), Failure> {
    let root = transaction_root(&metadata.stage_root)?;
    let (content_root, marker_root) = roots(root, metadata);
    if metadata.operation == StateOperation::Disable {
        require_complete_layout(
            root,
            &disabled_content_path(root, &metadata.current),
            root,
            &disabled_root(root, &metadata.current).join(".ycoding-project-artifact.json"),
            &metadata.current,
            filesystem,
        )?;
        if exists(&metadata.content_path) || exists(&metadata.marker_path) {
            return Err(failure("ReconciliationRequired"));
        }
        return Ok(());
    }
    let expected = metadata.target.as_ref().unwrap_or(&metadata.current);
    require_complete_layout(
        content_root,
        &metadata.content_path,
        marker_root,
        &metadata.marker_path,
        expected,
        filesystem,
    )?;
    if metadata.operation == StateOperation::Rollback {
        require_complete_layout(
            root,
            &disabled_content_path(root, &metadata.current),
            root,
            &disabled_root(root, &metadata.current).join(".ycoding-project-artifact.json"),
            &metadata.current,
            filesystem,
        )?;
    }
    Ok(())
}
pub(super) fn reconcile(
    metadata: &StateMutationMetadata,
    filesystem: &Hooks<'_>,
) -> Result<(), Failure> {
    let root = transaction_root(&metadata.stage_root)?;
    if matches!(
        metadata.phase,
        StatePhase::Committed | StatePhase::Finalizing | StatePhase::Available
    ) {
        require_available(metadata, filesystem)?;
        if metadata.phase == StatePhase::Committed {
            filesystem::remove(root, &metadata.stage_root, true, filesystem)?;
        }
        return Ok(());
    }
    compensate(metadata, filesystem)?;
    filesystem::remove(root, &metadata.stage_root, true, filesystem)?;
    Ok(())
}
pub(super) fn read_journal(
    root: &Path,
    stage_root: &Path,
    filesystem: &Hooks<'_>,
) -> Option<StateMutationMetadata> {
    StateMutationMetadata::decode(
        &ycoding_schema::parse_json(
            &filesystem::read_text(root, &journal_path(stage_root), filesystem).ok()?,
        )
        .ok()?,
    )
    .ok()
}
pub(super) fn valid_metadata(root: &Path, metadata: &StateMutationMetadata) -> bool {
    if !valid_operation_id(&metadata.operation_id)
        || metadata.stage_root != root.join("staging").join(&metadata.operation_id)
        || metadata.current.content_relpath.as_lossless().as_str()
            != Some(&relative_content_path(
                &metadata.current.kind,
                &metadata.current.id,
            ))
        || (metadata.operation == StateOperation::Rollback) != metadata.target.is_some()
        || metadata.target.as_ref().is_some_and(|target| {
            !same_ownership(&metadata.current, target)
                || target.version_id == metadata.current.version_id
                || target.content_relpath.as_lossless().as_str()
                    != Some(&relative_content_path(&target.kind, &target.id))
        })
    {
        return false;
    }
    if metadata.standard {
        return valid_standard_paths(
            &metadata.current,
            &metadata.content_path,
            &metadata.marker_path,
        );
    }
    metadata.content_path
        == super::active_content_path(root, &metadata.current.kind, &metadata.current.id)
        && metadata.marker_path
            == super::active_marker_path(root, &metadata.current.kind, &metadata.current.id)
}
pub(super) fn journal_path(stage_root: &Path) -> PathBuf {
    stage_root.join(".ycoding-state-operation.json")
}
fn roots<'a>(root: &'a Path, metadata: &'a StateMutationMetadata) -> (&'a Path, &'a Path) {
    if metadata.standard {
        return (
            metadata
                .content_path
                .parent()
                .expect("validated content path"),
            metadata
                .marker_path
                .parent()
                .expect("validated marker path"),
        );
    }
    (root, root)
}
fn write_phase(
    metadata: &StateMutationMetadata,
    phase: StatePhase,
    filesystem: &Hooks<'_>,
) -> Result<StateMutationMetadata, Failure> {
    let value = StateMutationMetadata {
        phase,
        ..metadata.clone()
    };
    replace_file(
        transaction_root(&metadata.stage_root)?,
        &journal_path(&metadata.stage_root),
        &ycoding_schema::stringify_json(&value.encode()),
        filesystem,
    )?;
    Ok(value)
}
