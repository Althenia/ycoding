use super::{
    Error, Hooks, LifecycleInput, Service, error, key, package, recovery, reject, scope_ids,
    scope_root, sql,
};
use crate::resources::project_artifact::accounting;
use ycoding_schema::{
    DomainDecode, JsonPath, JsonValue, LosslessString, ObjectDecoder, ObjectEncoder,
    project_artifact,
};
use ycoding_store::{Write, artifacts};

pub struct GovernorInput<'a> {
    pub artifact: LifecycleInput<'a>,
    pub agent_id: Option<LosslessString>,
    pub model_id: LosslessString,
    pub goal_mode: bool,
}
impl Service {
    pub fn evaluate_governor(
        &self,
        input: GovernorInput<'_>,
    ) -> Result<accounting::DecideResult, Error> {
        let accounting = self
            .accounting
            .as_ref()
            .ok_or_else(|| error("StorageUnavailable"))?;
        let _scope = package::package_lock(
            &self.paths.data,
            &format!(
                "project-artifact-scope:{}",
                input
                    .artifact
                    .scope_id
                    .as_lossless()
                    .as_str()
                    .expect("scope")
            ),
        )?;
        let snapshot = self.client.snapshot()?;
        let scope = self.scope_from_snapshot(&snapshot, input.artifact.scope_id)?;
        let artifact = snapshot
            .get::<artifacts::ArtifactTable>(&artifacts::identity(
                input.artifact.scope_id.as_lossless(),
                input.artifact.kind.as_lossless(),
                input.artifact.id.as_lossless(),
            ))?
            .ok_or_else(|| error("ArtifactNotFound"))?;
        let version = snapshot
            .get::<artifacts::VersionTable>(&key(&artifact.current_version_id))?
            .ok_or_else(|| error("VersionNotFound"))?;
        super::check_expectation(
            Some(&artifact),
            Some(&version),
            Some(input.artifact.expected),
        )?;
        if !matches!(artifact.stage.as_str(), Some("trial" | "active")) {
            return Err(error("VersionConflict"));
        }
        let root = scope_root(&self.paths.data, scope_ids(&scope).1);
        let target = artifact
            .fallback_version_id
            .as_ref()
            .map(|id| snapshot.get::<artifacts::VersionTable>(&key(id)))
            .transpose()?
            .flatten();
        let operation = if target.is_some() {
            "revert"
        } else {
            "disable"
        };
        let fingerprint = package::sha256(&crate::resources::discovery::join(
            &[
                artifact.scope_id.clone(),
                artifact.kind.clone(),
                artifact.artifact_id.clone(),
                operation.into(),
                "automatic-governor".into(),
                artifact.revision.to_string().as_str().into(),
                version.id.clone(),
                version.content_digest.clone(),
                target
                    .as_ref()
                    .map_or_else(|| "".into(), |target| target.id.clone()),
                target
                    .as_ref()
                    .map_or_else(|| "".into(), |target| target.content_digest.clone()),
                input.agent_id.clone().unwrap_or_else(|| "".into()),
                input.model_id.clone(),
                input.goal_mode.to_string().as_str().into(),
            ],
            "\0",
        ));
        let operation_id = format!(
            "pop_{}",
            &fingerprint.as_lossless().as_str().expect("digest")[..32]
        );
        if matches!(scope, project_artifact::Scope::Global(_))
            && !package::read_state_transactions(&root, &Hooks::default())?
                .iter()
                .any(|metadata| metadata.operation_id == operation_id)
        {
            let sources = self
                .sources
                .lock()
                .map_err(|_| error("StorageUnavailable"))?
                .resolve("global", None, input.artifact.kind, input.artifact.id);
            if sources.is_empty()
                || sources.iter().any(|source| {
                    source.managed_scope_id.as_ref().map(|id| id.as_lossless())
                        != Some(&artifact.scope_id)
                        || source
                            .managed_version_id
                            .as_ref()
                            .map(|id| id.as_lossless())
                            != Some(&version.id)
                        || source.managed_digest.as_ref().map(|id| id.as_lossless())
                            != Some(&version.content_digest)
                })
            {
                return Err(error(if sources.is_empty() {
                    "OwnershipMismatch"
                } else {
                    "DestinationExists"
                }));
            }
        }
        let cohort = accounting::CohortInput {
            scope: match &scope {
                project_artifact::Scope::Project(scope) => {
                    accounting::CohortScope::Project(scope.project_id.clone())
                }
                project_artifact::Scope::Global(_) => accounting::CohortScope::Global,
            },
            version_id: input.artifact.expected.expected_version_id.clone(),
            kind: input.artifact.kind.clone(),
            agent_id: input.agent_id,
            model_id: input.model_id,
            goal_mode: input.goal_mode,
            now: input.artifact.now,
        };
        let now = cohort.now;
        let service = accounting.clone();
        let query = cohort.clone();
        let before = version.clone();
        let old_artifact = artifact.clone();
        let preflight = self
            .client
            .submit(move |tx| {
                let decision = service
                    .decide_in_transaction(tx, &query, false)
                    .map_err(|_| reject(tx, "ReconciliationRequired"))?;
                if decision.transition.action == "degrade" {
                    artifacts::VersionTable::put(tx, &before)?;
                    return Ok(decision);
                }
                if decision.transition.action == "activate" {
                    let mut live = tx
                        .get::<artifacts::ArtifactTable>(&artifacts::identity(
                            &old_artifact.scope_id,
                            &old_artifact.kind,
                            &old_artifact.artifact_id,
                        ))?
                        .ok_or_else(|| reject(tx, "VersionConflict"))?;
                    if live.revision != old_artifact.revision
                        || live.current_version_id != before.id
                    {
                        return Err(reject(tx, "VersionConflict"));
                    }
                    live.revision += 1;
                    live.stage = "active".into();
                    live.time_updated = now;
                    let mut version = tx
                        .get::<artifacts::VersionTable>(&key(&before.id))?
                        .ok_or_else(|| reject(tx, "VersionNotFound"))?;
                    version.state = "active".into();
                    version.time_state_changed = now;
                    artifacts::VersionTable::put(tx, &version)?;
                    artifacts::ArtifactTable::put(tx, &live)?;
                }
                Ok(decision)
            })?
            .wait()?;
        if preflight.transition.action != "degrade" {
            return Ok(preflight);
        }
        let operation = artifacts::Operation {
            id: operation_id.as_str().into(),
            scope_id: artifact.scope_id.clone(),
            kind: artifact.kind.clone(),
            artifact_id: artifact.artifact_id.clone(),
            operation: operation.into(),
            request_fingerprint: fingerprint.as_lossless().clone(),
            expected_revision: Some(artifact.revision),
            expected_version_id: Some(version.id.clone()),
            expected_digest: Some(version.content_digest.clone()),
            source_scope_id: None,
            source_version_id: None,
            source_digest: None,
            target_version_id: Some(
                target
                    .as_ref()
                    .map_or_else(|| version.id.clone(), |target| target.id.clone()),
            ),
            target_digest: Some(target.as_ref().map_or_else(
                || version.content_digest.clone(),
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
        let row = operation.clone();
        self.client
            .submit(move |tx| {
                if tx
                    .get::<artifacts::OperationTable>(&key(&row.id))?
                    .is_none()
                {
                    artifacts::OperationTable::insert(tx, &row)?;
                }
                Ok(())
            })?
            .wait()?;
        let scope_row = snapshot
            .get::<artifacts::ScopeTable>(&key(input.artifact.scope_id.as_lossless()))?
            .ok_or_else(|| error("InvalidScope"))?;
        let current_marker = sql::marker_value(&scope_row, &version)?;
        let target_marker = target
            .as_ref()
            .map(|target| sql::marker_value(&scope_row, target))
            .transpose()?;
        let context = ycoding_schema::stringify_json(
            &ObjectEncoder::new()
                .optional("agentID", &cohort.agent_id)
                .field("modelID", &cohort.model_id)
                .field("goalMode", &cohort.goal_mode)
                .field("now", &(now as f64))
                .finish(),
        );
        let client = self.client.clone();
        let accounting = accounting.clone();
        let finalized = operation.clone();
        let query = cohort.clone();
        let finalize = move |_: &package::StateMutationMetadata| {
            let operation = finalized.clone();
            let target = target.clone();
            let accounting = accounting.clone();
            let query = query.clone();
            client
                .submit(move |tx| {
                    finalize_governor(tx, &accounting, &operation, target.as_ref(), &query)
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
                    operation.final_version_id = None;
                    artifacts::OperationTable::put(tx, &operation)
                })?
                .wait()
                .map_err(Error::from)
        };
        let content_path = matches!(scope, project_artifact::Scope::Global(_)).then(|| {
            super::adapter::global_path(
                input.artifact.kind,
                &self.paths.home,
                &self.paths.config,
                input.artifact.id.as_lossless().as_str().expect("ID"),
            )
        });
        let marker_path = content_path
            .as_ref()
            .map(|path| super::standard_marker_path(path, input.artifact.kind, input.artifact.id));
        let can_compensate = || !self.client.is_fenced();
        package::state_transaction(
            package::StateMutationInput {
                root: &root,
                operation_id: &operation_id,
                operation: if target_marker.is_some() {
                    package::StateOperation::Rollback
                } else {
                    package::StateOperation::Disable
                },
                current: &current_marker,
                target: target_marker.as_ref(),
                standard: content_path.as_ref().zip(marker_path.as_ref()).map(
                    |(content_path, marker_path)| package::StandardTarget {
                        content_path,
                        marker_path,
                    },
                ),
                context: Some(&context),
            },
            &Hooks::default(),
            &package::TransactionHooks {
                reserve: None,
                finalize: Some(&finalize),
                abort: Some(&abort),
                cancellation: None,
                can_compensate: Some(&can_compensate),
            },
        )
        .map_err(governor_error)?;
        Ok(preflight)
    }
    pub(super) fn recover_governor(
        &self,
        operation: &artifacts::Operation,
        metadata: &package::StateMutationMetadata,
    ) -> Result<(), Error> {
        let accounting = self
            .accounting
            .as_ref()
            .ok_or_else(|| error("StorageUnavailable"))?;
        let context = metadata
            .context
            .as_ref()
            .and_then(|context| context.as_str())
            .ok_or_else(|| error("ReconciliationRequired"))?;
        let value =
            ycoding_schema::parse_json(context).map_err(|_| error("ReconciliationRequired"))?;
        let path = JsonPath::default();
        let object =
            ObjectDecoder::new(&value, &path).map_err(|_| error("ReconciliationRequired"))?;
        let now: f64 = object
            .field("now")
            .map_err(|_| error("ReconciliationRequired"))?;
        let scope_id =
            project_artifact::ScopeId::decode(&JsonValue::String(operation.scope_id.clone()))
                .map_err(|_| error("ReconciliationRequired"))?;
        let scope = self.scope_from_snapshot(&self.client.snapshot()?, &scope_id)?;
        let cohort = accounting::CohortInput {
            scope: match &scope {
                project_artifact::Scope::Project(scope) => {
                    accounting::CohortScope::Project(scope.project_id.clone())
                }
                project_artifact::Scope::Global(_) => accounting::CohortScope::Global,
            },
            version_id: metadata.current.version_id.clone(),
            kind: metadata.current.kind.clone(),
            agent_id: object
                .optional("agentID")
                .map_err(|_| error("ReconciliationRequired"))?,
            model_id: object
                .field("modelID")
                .map_err(|_| error("ReconciliationRequired"))?,
            goal_mode: object
                .field("goalMode")
                .map_err(|_| error("ReconciliationRequired"))?,
            now: now as i64,
        };
        let target = metadata
            .target
            .as_ref()
            .map(|marker| {
                self.client
                    .snapshot()?
                    .get::<artifacts::VersionTable>(&key(marker.version_id.as_lossless()))
            })
            .transpose()?
            .flatten();
        if metadata.target.is_some() && target.is_none() {
            return Err(error("ReconciliationRequired"));
        }
        let client = self.client.clone();
        let accounting = accounting.clone();
        let operation = operation.clone();
        let finalize = move |_: &package::StateMutationMetadata| {
            let operation = operation.clone();
            let accounting = accounting.clone();
            let cohort = cohort.clone();
            let target = target.clone();
            client
                .submit(move |tx| {
                    finalize_governor(tx, &accounting, &operation, target.as_ref(), &cohort)
                })?
                .wait()
                .map_err(Error::from)
        };
        let root = scope_root(&self.paths.data, scope_ids(&scope).1);
        let can_compensate = || !self.client.is_fenced();
        package::state_transaction(
            package::StateMutationInput {
                root: &root,
                operation_id: &metadata.operation_id,
                operation: metadata.operation,
                current: &metadata.current,
                target: metadata.target.as_ref(),
                standard: metadata.standard.then_some(package::StandardTarget {
                    content_path: &metadata.content_path,
                    marker_path: &metadata.marker_path,
                }),
                context: Some(context),
            },
            &Hooks::default(),
            &package::TransactionHooks {
                reserve: None,
                finalize: Some(&finalize),
                abort: None,
                cancellation: None,
                can_compensate: Some(&can_compensate),
            },
        )
        .map_err(governor_error)?;
        Ok(())
    }
}
fn finalize_governor(
    tx: &mut Write<'_>,
    accounting: &accounting::Service,
    operation: &artifacts::Operation,
    target: Option<&artifacts::Version>,
    query: &accounting::CohortInput,
) -> Result<(), ycoding_store::Error> {
    let mut artifact = tx
        .get::<artifacts::ArtifactTable>(&artifacts::identity(
            &operation.scope_id,
            &operation.kind,
            &operation.artifact_id,
        ))?
        .ok_or_else(|| reject(tx, "VersionConflict"))?;
    let version = tx
        .get::<artifacts::VersionTable>(&key(&artifact.current_version_id))?
        .ok_or_else(|| reject(tx, "VersionConflict"))?;
    if Some(artifact.revision) != operation.expected_revision
        || Some(&version.id) != operation.expected_version_id.as_ref()
        || Some(&version.content_digest) != operation.expected_digest.as_ref()
    {
        return Err(reject(tx, "VersionConflict"));
    }
    let decision = accounting
        .decide_in_transaction(tx, query, false)
        .map_err(|_| reject(tx, "ReconciliationRequired"))?;
    if decision.transition.action != "degrade" {
        return Err(reject(tx, "VersionConflict"));
    }
    let mut degraded = tx
        .get::<artifacts::VersionTable>(&key(&version.id))?
        .ok_or_else(|| reject(tx, "VersionNotFound"))?;
    degraded.state = "degraded".into();
    degraded.time_state_changed = query.now;
    artifacts::VersionTable::put(tx, &degraded)?;
    if let Some(target) = target {
        let mut target = target.clone();
        target.state = "active".into();
        target.time_state_changed = query.now;
        artifacts::VersionTable::put(tx, &target)?;
        artifact.current_version_id = target.id;
        artifact.fallback_version_id = target
            .parent_version_id
            .or_else(|| artifact.fallback_version_id.clone());
    }
    artifact.revision += 1;
    artifact.stage = if target.is_some() {
        "active"
    } else {
        "degraded"
    }
    .into();
    artifact.time_updated = query.now;
    artifacts::ArtifactTable::put(tx, &artifact)?;
    let feedback = project_artifact::Feedback::decode(
        &ObjectEncoder::new()
            .field(
                "artifact",
                &ObjectEncoder::new()
                    .field("scopeID", &version.scope_id)
                    .field("kind", &version.kind)
                    .field("id", &version.artifact_id)
                    .field("versionID", &version.id)
                    .finish(),
            )
            .field("action", &LosslessString::from("revert"))
            .field("actor", &LosslessString::from("automatic-governor"))
            .field("timeCreated", &(query.now as f64))
            .finish(),
    )
    .expect("feedback");
    accounting::Service::record_feedback(tx, &feedback)
        .map_err(|_| reject(tx, "ReconciliationRequired"))?;
    recovery::finalize_operation(tx, operation, Some(artifact.current_version_id), query.now)
}
fn governor_error(error: package::TransactionError<Error>) -> Error {
    match error {
        package::TransactionError::Package(error) => Error::from(error),
        package::TransactionError::Hook(error) => error,
        package::TransactionError::Interrupted => self::error("ReconciliationRequired"),
    }
}
