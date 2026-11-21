use super::{Error, Hooks, Service, error, key, package, reject, scope_ids, scope_root, sql};
use crate::resources::project_artifact::accounting;
use ycoding_schema::{DomainDecode, LosslessString, ObjectEncoder, project_artifact};
use ycoding_store::artifacts;

#[derive(Clone, Copy)]
pub struct LifecycleInput<'a> {
    pub scope_id: &'a project_artifact::ScopeId,
    pub kind: &'a project_artifact::Kind,
    pub id: &'a project_artifact::Id,
    pub expected: &'a project_artifact::MutationExpectation,
    pub now: i64,
}
pub(super) enum Change<'a> {
    Disable,
    Enable,
    Revert(Option<&'a project_artifact::VersionId>),
}
impl Service {
    pub fn disable(&self, input: LifecycleInput<'_>) -> Result<(), Error> {
        self.change_state(input, Change::Disable)
    }
    pub fn enable(&self, input: LifecycleInput<'_>) -> Result<(), Error> {
        self.change_state(input, Change::Enable)
    }
    pub fn revert(
        &self,
        input: LifecycleInput<'_>,
        target: Option<&project_artifact::VersionId>,
    ) -> Result<(), Error> {
        self.change_state(input, Change::Revert(target))
    }
    fn change_state(&self, input: LifecycleInput<'_>, change: Change<'_>) -> Result<(), Error> {
        let snapshot = self.client.snapshot()?;
        let scope = self.scope_from_snapshot(&snapshot, input.scope_id)?;
        if !matches!(scope, project_artifact::Scope::Project(_)) {
            return Err(error("InvalidScope"));
        }
        let _scope = package::package_lock(
            &self.paths.data,
            &format!(
                "project-artifact-scope:{}",
                input.scope_id.as_lossless().as_str().expect("scope")
            ),
        )?;
        self.change_state_locked(input, change)
    }
    pub(super) fn change_state_locked(
        &self,
        input: LifecycleInput<'_>,
        change: Change<'_>,
    ) -> Result<(), Error> {
        let snapshot = self.client.snapshot()?;
        let scope = self.scope_from_snapshot(&snapshot, input.scope_id)?;
        let (_, storage) = scope_ids(&scope);
        let root = scope_root(&self.paths.data, storage);
        let target = match change {
            Change::Revert(Some(target)) => Some(
                snapshot
                    .get::<artifacts::VersionTable>(&key(target.as_lossless()))?
                    .filter(|version| {
                        version.scope_id == *input.scope_id.as_lossless()
                            && version.kind == *input.kind.as_lossless()
                            && version.artifact_id == *input.id.as_lossless()
                    })
                    .ok_or_else(|| error("VersionNotFound"))?,
            ),
            _ => None,
        };
        let operation = match change {
            Change::Disable => "disable",
            Change::Enable => "enable",
            Change::Revert(_) if target.is_some() => "revert",
            Change::Revert(_) => "disable",
        };
        let mut values = vec![
            input.scope_id.as_lossless().clone(),
            input.kind.as_lossless().clone(),
            input.id.as_lossless().clone(),
            operation.into(),
        ];
        if matches!(change, Change::Revert(_)) {
            values.push("false".into());
        }
        values.extend([
            input
                .expected
                .expected_revision
                .get()
                .to_string()
                .as_str()
                .into(),
            input.expected.expected_version_id.as_lossless().clone(),
            input.expected.expected_digest.as_lossless().clone(),
        ]);
        if matches!(change, Change::Revert(_)) {
            values.extend([
                target
                    .as_ref()
                    .map_or_else(|| "".into(), |target| target.id.clone()),
                target
                    .as_ref()
                    .map_or_else(|| "".into(), |target| target.content_digest.clone()),
            ]);
        }
        let fingerprint = package::sha256(&crate::resources::discovery::join(&values, "\0"));
        let operation_id = format!(
            "pop_{}",
            &fingerprint.as_lossless().as_str().expect("digest")[..32]
        );
        if snapshot
            .get::<artifacts::OperationTable>(&key(&operation_id.as_str().into()))?
            .is_some_and(|operation| operation.phase.as_str() == Some("finalized"))
        {
            for metadata in package::read_state_transactions(&root, &Hooks::default())?
                .iter()
                .filter(|metadata| metadata.operation_id == operation_id)
            {
                package::cleanup_state_transaction(metadata, &Hooks::default())?;
            }
            return Ok(());
        }
        let artifact = snapshot
            .get::<artifacts::ArtifactTable>(&artifacts::identity(
                input.scope_id.as_lossless(),
                input.kind.as_lossless(),
                input.id.as_lossless(),
            ))?
            .ok_or_else(|| error("ArtifactNotFound"))?;
        let current = snapshot
            .get::<artifacts::VersionTable>(&key(&artifact.current_version_id))?
            .ok_or_else(|| error("VersionNotFound"))?;
        super::check_expectation(Some(&artifact), Some(&current), Some(input.expected))?;
        let changes = match change {
            Change::Enable => matches!(artifact.stage.as_str(), Some("disabled" | "degraded")),
            Change::Disable => artifact.stage.as_str() != Some("disabled"),
            Change::Revert(_) => true,
        };
        let marker_scope = snapshot
            .get::<artifacts::ScopeTable>(&key(input.scope_id.as_lossless()))?
            .ok_or_else(|| error("InvalidScope"))?;
        let marker = sql::marker_value(&marker_scope, &current)?;
        let target_marker = target
            .as_ref()
            .map(|target| sql::marker_value(&marker_scope, target))
            .transpose()?;
        let now = input.now;
        let operation = artifacts::Operation {
            id: operation_id.as_str().into(),
            scope_id: artifact.scope_id.clone(),
            kind: artifact.kind.clone(),
            artifact_id: artifact.artifact_id.clone(),
            operation: operation.into(),
            request_fingerprint: fingerprint.as_lossless().clone(),
            expected_revision: Some(artifact.revision),
            expected_version_id: Some(current.id.clone()),
            expected_digest: Some(current.content_digest.clone()),
            source_scope_id: None,
            source_version_id: None,
            source_digest: None,
            target_version_id: Some(
                target
                    .as_ref()
                    .map_or_else(|| current.id.clone(), |target| target.id.clone()),
            ),
            target_digest: Some(target.as_ref().map_or_else(
                || current.content_digest.clone(),
                |target| target.content_digest.clone(),
            )),
            final_version_id: None,
            deletion_id: None,
            automatic_session_id: None,
            automatic_insight_digest: None,
            phase: "preparing".into(),
            time_created: now,
            time_updated: now,
        };
        let client = self.client.clone();
        let reserved = operation.clone();
        let reserve = move || {
            let operation = reserved.clone();
            client
                .submit(move |tx| {
                    if let Some(existing) =
                        tx.get::<artifacts::OperationTable>(&key(&operation.id))?
                    {
                        if existing.request_fingerprint != operation.request_fingerprint {
                            return Err(reject(tx, "VersionConflict"));
                        }
                        return Ok(());
                    }
                    artifacts::OperationTable::insert(tx, &operation)
                })?
                .wait()
                .map_err(Error::from)
        };
        let feedback_action = match change {
            Change::Disable => "disable",
            Change::Enable => "enable",
            Change::Revert(_) => "revert",
        };
        let stage = match change {
            Change::Enable => "trial",
            Change::Revert(_) if target.is_some() => "active",
            _ => "disabled",
        };
        let client = self.client.clone();
        let finalized = operation.clone();
        let finalize = move || {
            let mut operation = finalized.clone();
            let mut artifact = artifact.clone();
            let mut current = current.clone();
            let mut target = target.clone();
            client
                .submit(move |tx| {
                    let live = tx
                        .get::<artifacts::ArtifactTable>(&artifacts::identity(
                            &artifact.scope_id,
                            &artifact.kind,
                            &artifact.artifact_id,
                        ))?
                        .ok_or_else(|| reject(tx, "ArtifactNotFound"))?;
                    if live.revision != artifact.revision
                        || live.current_version_id != artifact.current_version_id
                    {
                        return Err(reject(tx, "VersionConflict"));
                    }
                    if changes {
                        current.state = if target.is_some() { "disabled" } else { stage }.into();
                        current.time_state_changed = now;
                        artifacts::VersionTable::put(tx, &current)?;
                        if let Some(target) = &mut target {
                            target.state = "active".into();
                            target.time_state_changed = now;
                            artifacts::VersionTable::put(tx, target)?;
                        }
                        artifact.revision += 1;
                        artifact.stage = stage.into();
                        artifact.time_updated = now;
                        if let Some(target) = &target {
                            artifact.current_version_id = target.id.clone();
                            artifact.fallback_version_id = target.parent_version_id.clone();
                        }
                        artifacts::ArtifactTable::put(tx, &artifact)?;
                        let feedback = project_artifact::Feedback::decode(
                            &ObjectEncoder::new()
                                .field(
                                    "artifact",
                                    &ObjectEncoder::new()
                                        .field("scopeID", &current.scope_id)
                                        .field("kind", &current.kind)
                                        .field("id", &current.artifact_id)
                                        .field("versionID", &current.id)
                                        .finish(),
                                )
                                .field("action", &LosslessString::from(feedback_action))
                                .field("actor", &LosslessString::from("user"))
                                .field("timeCreated", &(operation.time_created as f64))
                                .finish(),
                        )
                        .expect("feedback");
                        accounting::Service::record_feedback(tx, &feedback)
                            .map_err(|_| reject(tx, "ReconciliationRequired"))?;
                    }
                    operation.phase = "finalized".into();
                    operation.final_version_id = Some(artifact.current_version_id);
                    operation.time_updated = now;
                    artifacts::OperationTable::put(tx, &operation)
                })?
                .wait()
                .map_err(Error::from)
        };
        let client = self.client.clone();
        let aborted = operation.clone();
        let abort = move |_: &package::StateMutationMetadata| {
            let mut operation = aborted.clone();
            client
                .submit(move |tx| {
                    operation.phase = "aborted".into();
                    artifacts::OperationTable::put(tx, &operation)
                })?
                .wait()
                .map_err(Error::from)
        };
        drop(snapshot);
        if !changes {
            reserve()?;
            return finalize();
        }
        let reserve_hook = |_: &package::StateMutationMetadata| reserve();
        let finalize_hook = |_: &package::StateMutationMetadata| finalize();
        let can_compensate = || !self.client.is_fenced();
        let content_path = matches!(scope, project_artifact::Scope::Global(_)).then(|| {
            super::adapter::global_path(
                input.kind,
                &self.paths.home,
                &self.paths.config,
                input.id.as_lossless().as_str().expect("ID"),
            )
        });
        let marker_path = content_path
            .as_ref()
            .map(|path| super::standard_marker_path(path, input.kind, input.id));
        package::state_transaction(
            package::StateMutationInput {
                root: &root,
                operation_id: &operation_id,
                operation: match change {
                    Change::Enable => package::StateOperation::Enable,
                    Change::Revert(_) if target_marker.is_some() => {
                        package::StateOperation::Rollback
                    }
                    _ => package::StateOperation::Disable,
                },
                current: &marker,
                target: target_marker.as_ref(),
                standard: content_path.as_ref().zip(marker_path.as_ref()).map(
                    |(content_path, marker_path)| package::StandardTarget {
                        content_path,
                        marker_path,
                    },
                ),
                context: None,
            },
            &Hooks::default(),
            &package::TransactionHooks {
                reserve: Some(&reserve_hook),
                finalize: Some(&finalize_hook),
                abort: Some(&abort),
                cancellation: None,
                can_compensate: Some(&can_compensate),
            },
        )
        .map_err(|failure| match failure {
            package::TransactionError::Package(error) => Error::from(error),
            package::TransactionError::Hook(error) => error,
            package::TransactionError::Interrupted => error("ReconciliationRequired"),
        })?;
        Ok(())
    }
}
