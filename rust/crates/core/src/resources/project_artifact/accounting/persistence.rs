use super::{
    DAY, DecisionInput, GovernorState, GovernorTransition, Outcome, ProjectBucketSample,
    ProjectBucketTotal, SampleCounts, decision, eligible, penalty, project_bucket,
    project_bucket_totals, reward, score, wilson,
};
use crate::resources::project_artifact::package;
use std::{collections::BTreeMap, ops::Bound};
use ycoding_schema::{
    DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder, project, project_artifact, session,
};
use ycoding_store::{
    Client, Error, IndexCursor, IndexEntry, IndexOrder, IndexQuery, KeyPart, Snapshot, TableSpec,
    Write, artifacts, tuple_key,
};

#[derive(Clone)]
pub struct ObserveInput {
    pub project_id: project::Id,
    pub session_id: session::Id,
    pub terminal_message_id: Option<project_artifact::NonEmptyText>,
    pub boundary_seq: project_artifact::Revision,
    pub kind: project_artifact::Kind,
    pub agent_id: Option<ycoding_schema::agent::Id>,
    pub model_id: LosslessString,
    pub goal_mode: bool,
    pub standard_invocation_count: project_artifact::Revision,
    pub external_confounded: bool,
    pub terminal_outcome: project_artifact::TerminalOutcome,
    pub goal_status: project_artifact::GoalStatus,
    pub repeat_fix: bool,
    pub latency_ms: Option<project_artifact::TimestampMillis>,
    pub input_tokens: Option<project_artifact::Revision>,
    pub output_tokens: Option<project_artifact::Revision>,
    pub cache_read_tokens: Option<project_artifact::Revision>,
    pub completed_tool_count: Option<project_artifact::Revision>,
    pub failed_tool_count: Option<project_artifact::Revision>,
    pub observed_at: project_artifact::TimestampMillis,
}
impl DomainDecode for ObserveInput {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let o = ObjectDecoder::new(value, path)?;
        Ok(Self {
            project_id: o.field("projectID")?,
            session_id: o.field("sessionID")?,
            terminal_message_id: o.optional("terminalMessageID")?,
            boundary_seq: o.field("boundarySeq")?,
            kind: o.field("kind")?,
            agent_id: o.optional("agentID")?,
            model_id: o.field("modelID")?,
            goal_mode: o.field("goalMode")?,
            standard_invocation_count: o.field("standardInvocationCount")?,
            external_confounded: o.field("externalConfounded")?,
            terminal_outcome: o.field("terminalOutcome")?,
            goal_status: o.field("goalStatus")?,
            repeat_fix: o.field("repeatFix")?,
            latency_ms: o.optional("latencyMs")?,
            input_tokens: o.optional("inputTokens")?,
            output_tokens: o.optional("outputTokens")?,
            cache_read_tokens: o.optional("cacheReadTokens")?,
            completed_tool_count: o.optional("completedToolCount")?,
            failed_tool_count: o.optional("failedToolCount")?,
            observed_at: o.field("observedAt")?,
        })
    }
}
#[derive(Clone)]
pub enum CohortScope {
    Project(project::Id),
    Global,
}
#[derive(Clone)]
pub struct CohortInput {
    pub scope: CohortScope,
    pub version_id: project_artifact::VersionId,
    pub kind: project_artifact::Kind,
    pub agent_id: Option<ycoding_schema::agent::Id>,
    pub model_id: LosslessString,
    pub goal_mode: bool,
    pub now: i64,
}
#[derive(Debug)]
pub struct CohortResult {
    pub candidate: SampleCounts,
    pub baseline: SampleCounts,
    pub project_buckets: Vec<ProjectBucketTotal>,
}
#[derive(Debug)]
pub struct DecideResult {
    pub transition: GovernorTransition,
    pub cohort: CohortResult,
}
#[derive(Clone)]
pub struct Service {
    client: Client,
    bucket_secret: String,
}
impl Service {
    pub fn new(client: Client, bucket_secret: String) -> Self {
        Self {
            client,
            bucket_secret,
        }
    }
    pub fn activate(
        &self,
        input: &project_artifact::Activation,
    ) -> Result<project_artifact::Activation, Error> {
        let input = input.clone();
        self.client
            .submit(move |tx| Self::activate_in_transaction(tx, &input))?
            .wait()
    }
    pub fn activate_in_transaction(
        tx: &mut Write<'_>,
        input: &project_artifact::Activation,
    ) -> Result<project_artifact::Activation, Error> {
        let row = activation_row(input);
        let output = input.clone();
        let existing = tx.get::<artifacts::ActivationTable>(&key(&row.id))?;
        if let Some(existing) = existing {
            if existing != row {
                return Err(reject(tx, "Conflicting activation ID"));
            }
            return Ok(output);
        }
        let (index, identity) = activation_identity(&row);
        if let Some(existing) = rows::<artifacts::ActivationTable>(tx, index, &identity)?.first() {
            if existing != &row {
                return Err(reject(tx, "Conflicting activation identity"));
            }
            return Ok(output);
        }
        artifacts::ActivationTable::insert(tx, &row)?;
        Ok(output)
    }
    pub fn observe(
        &self,
        input: &ObserveInput,
    ) -> Result<Vec<project_artifact::Observation>, Error> {
        let input = input.clone();
        self.client
            .submit(move |tx| {
                let activations = rows::<artifacts::ActivationTable>(
                    tx,
                    "project_artifact_activation_session_open_idx",
                    &tuple_key(&[
                        KeyPart::String(input.session_id.as_lossless()),
                        KeyPart::Null,
                    ]),
                )?;
                let confounded =
                    input.external_confounded || input.standard_invocation_count.get() > 0;
                let terminal = terminal_row(&input, activations.len(), confounded);
                persist_terminal(tx, &terminal)?;
                let mut versions = activations
                    .iter()
                    .map(|activation| activation.version_id.clone())
                    .collect::<Vec<_>>();
                versions.sort();
                let activation_digest =
                    package::sha256(&crate::resources::discovery::join(&versions, "\0"));
                let outcome = literal(&input.terminal_outcome);
                let goal = literal(&input.goal_status);
                let eligible = eligible(&Outcome {
                    active_artifact_count: activations.len() as f64,
                    standard_invocation_count: input.standard_invocation_count.get() as f64,
                    external_confounded: confounded,
                    terminal_outcome: outcome.as_str().expect("terminal outcome"),
                    goal_status: goal.as_str().expect("goal status"),
                });
                let mut output = Vec::new();
                for activation in &activations {
                    let id = digest_id(
                        "pao",
                        &[
                            activation.version_id.clone(),
                            input.session_id.as_lossless().clone(),
                            input
                                .terminal_message_id
                                .as_ref()
                                .map(|message| message.as_lossless().clone())
                                .unwrap_or_else(|| "<absent>".into()),
                        ],
                    );
                    let row = artifacts::Observation {
                        id,
                        scope_id: activation.scope_id.clone(),
                        kind: activation.kind.clone(),
                        artifact_id: activation.artifact_id.clone(),
                        version_id: activation.version_id.clone(),
                        project_id: Some(input.project_id.as_lossless().clone()),
                        session_id: Some(input.session_id.as_lossless().clone()),
                        activation_set_digest: activation_digest.as_lossless().clone(),
                        active_artifact_count: activations.len() as i64,
                        external_confounded: i64::from(confounded),
                        eligible: i64::from(eligible),
                        terminal_outcome: outcome.clone(),
                        goal_status: goal.clone(),
                        repeat_fix: i64::from(input.repeat_fix),
                        latency_ms: input.latency_ms.map(|v| v.get()),
                        input_tokens: input.input_tokens.map(|v| v.get()),
                        output_tokens: input.output_tokens.map(|v| v.get()),
                        cache_read_tokens: input.cache_read_tokens.map(|v| v.get()),
                        completed_tool_count: input.completed_tool_count.map(|v| v.get()),
                        failed_tool_count: input.failed_tool_count.map(|v| v.get()),
                        terminal_message_id: input
                            .terminal_message_id
                            .as_ref()
                            .map(|v| v.as_lossless().clone()),
                        observed_at: input.observed_at.get(),
                    };
                    if let Some(existing) = tx.get::<artifacts::ObservationTable>(&key(&row.id))? {
                        if existing != row {
                            return Err(reject(tx, "Conflicting observation identity"));
                        }
                        output.push(observation_value(&row)?);
                        continue;
                    }
                    let (index, identity) = observation_identity(&row);
                    if let Some(existing) =
                        rows::<artifacts::ObservationTable>(tx, index, &identity)?.first()
                    {
                        if existing != &row {
                            return Err(reject(tx, "Conflicting observation identity"));
                        }
                        output.push(observation_value(&row)?);
                        continue;
                    }
                    artifacts::ObservationTable::insert(tx, &row)?;
                    output.push(observation_value(&row)?);
                }
                Ok(output)
            })?
            .wait()
    }
    pub fn feedback(&self, input: &project_artifact::Feedback) -> Result<LosslessString, Error> {
        let service = self.clone();
        let input = input.clone();
        self.client
            .submit(move |tx| service.feedback_in_transaction(tx, &input))?
            .wait()
    }
    pub fn feedback_in_transaction(
        &self,
        tx: &mut Write<'_>,
        input: &project_artifact::Feedback,
    ) -> Result<LosslessString, Error> {
        Self::record_feedback(tx, input)
    }
    pub fn record_feedback(
        tx: &mut Write<'_>,
        input: &project_artifact::Feedback,
    ) -> Result<LosslessString, Error> {
        let mut version = load_owner(tx, &input.artifact.version_id)?.0;
        if version.scope_id != *input.artifact.identity.scope_id.as_lossless()
            || version.kind != *input.artifact.identity.kind.as_lossless()
            || version.artifact_id != *input.artifact.identity.id.as_lossless()
        {
            return Err(reject(tx, "Version owner mismatch"));
        }
        let action = literal(&input.action);
        let actor = literal(&input.actor);
        let id = digest_id(
            "paf",
            &[
                version.scope_id.clone(),
                version.kind.clone(),
                version.artifact_id.clone(),
                version.id.clone(),
                action.clone(),
                actor.clone(),
                input.time_created.get().to_string().as_str().into(),
            ],
        );
        let row = artifacts::Feedback {
            id: id.clone(),
            scope_id: version.scope_id.clone(),
            kind: version.kind.clone(),
            artifact_id: version.artifact_id.clone(),
            version_id: version.id.clone(),
            action: action.clone(),
            actor,
            time_created: input.time_created.get(),
        };
        if let Some(existing) = tx.get::<artifacts::FeedbackTable>(&key(&id))? {
            if existing != row {
                return Err(reject(tx, "Conflicting feedback ID"));
            }
        } else {
            artifacts::FeedbackTable::insert(tx, &row)?;
        }
        if matches!(
            action.as_str(),
            Some("disable" | "delete" | "revert" | "restore" | "enable")
        ) {
            version.first_qualified_at = None;
            if matches!(action.as_str(), Some("restore" | "enable")) {
                version.last_restored_at = Some(
                    version
                        .last_restored_at
                        .map_or(row.time_created, |at| at.max(row.time_created)),
                );
            }
            artifacts::VersionTable::put(tx, &version)?;
        }
        Ok(id)
    }
    pub fn deactivate_project(
        &self,
        session: &session::Id,
        project: &project::Id,
        boundary_seq: i64,
        deactivated_at: i64,
    ) -> Result<usize, Error> {
        let session = session.as_lossless().clone();
        let project = project.as_lossless().clone();
        let service = self.clone();
        self.client
            .submit(move |tx| {
                service.deactivate_project_in_transaction(
                    tx,
                    &session,
                    &project,
                    boundary_seq,
                    deactivated_at,
                )
            })?
            .wait()
    }
    pub fn deactivate_project_in_transaction(
        &self,
        tx: &mut Write<'_>,
        session: &LosslessString,
        project: &LosslessString,
        boundary_seq: i64,
        deactivated_at: i64,
    ) -> Result<usize, Error> {
        let activations = rows::<artifacts::ActivationTable>(
            tx,
            "project_artifact_activation_session_open_idx",
            &tuple_key(&[KeyPart::String(session), KeyPart::Null]),
        )?;
        let mut count = 0;
        for mut activation in activations {
            if tx
                .get::<artifacts::ProjectScopeTable>(&key(&activation.scope_id))?
                .is_some_and(|scope| scope.project_id == *project)
            {
                activation.deactivated_at = Some(deactivated_at);
                activation.boundary_seq = boundary_seq;
                artifacts::ActivationTable::put(tx, &activation)?;
                count += 1;
            }
        }
        Ok(count)
    }
    pub fn metrics(
        &self,
        version: &project_artifact::VersionId,
    ) -> Result<project_artifact::Metrics, Error> {
        Self::read_metrics(&self.client, version)
    }
    pub fn read_metrics(
        client: &Client,
        version: &project_artifact::VersionId,
    ) -> Result<project_artifact::Metrics, Error> {
        let mut snapshot = client.snapshot()?;
        let observations = rows::<artifacts::ObservationTable>(
            &mut snapshot,
            "project_artifact_observation_version_eligible_observed_idx",
            &key(version.as_lossless()),
        )?;
        let feedback = rows::<artifacts::FeedbackTable>(
            &mut snapshot,
            "project_artifact_feedback_version_created_idx",
            &key(version.as_lossless()),
        )?;
        let mut samples = BTreeMap::new();
        for observation in observations.into_iter().filter(|row| row.eligible == 1) {
            let key = observation
                .session_id
                .as_ref()
                .unwrap_or(&observation.id)
                .clone();
            if samples
                .get(&key)
                .is_none_or(|current: &artifacts::Observation| {
                    current.observed_at < observation.observed_at
                })
            {
                samples.insert(key, observation);
            }
        }
        let success_count = samples
            .values()
            .filter(|row| {
                row.terminal_outcome.as_str() == Some("succeeded")
                    && row.goal_status.as_str() != Some("exhausted")
            })
            .count();
        let interval = wilson(samples.len() as f64, success_count as f64);
        let rewards = samples
            .values()
            .map(|row| {
                reward(
                    row.terminal_outcome.as_str().expect("outcome"),
                    row.goal_status.as_str().expect("goal"),
                    row.repeat_fix == 1,
                )
            })
            .collect::<Vec<_>>();
        let reward_units = rewards.iter().filter(|value| **value > 0.0).sum::<f64>();
        let penalty_units = rewards
            .iter()
            .filter(|value| **value < 0.0)
            .map(|value| value.abs())
            .sum::<f64>()
            + feedback
                .iter()
                .map(|row| penalty(row.action.as_str().expect("feedback")))
                .sum::<f64>();
        project_artifact::Metrics::decode(
            &ObjectEncoder::new()
                .field("score", &score(reward_units, penalty_units))
                .field(
                    "confidence",
                    &ObjectEncoder::new()
                        .field("sampleCount", &(samples.len() as f64))
                        .field("successCount", &(success_count as f64))
                        .field("lowerBound", &interval.lower_bound)
                        .field("upperBound", &interval.upper_bound)
                        .field("eligible", &(samples.len() >= 20))
                        .finish(),
                )
                .field("rewardUnits", &reward_units)
                .field("penaltyUnits", &penalty_units)
                .finish(),
        )
        .map_err(record_error)
    }
    pub fn cohort(&self, input: &CohortInput) -> Result<CohortResult, Error> {
        let mut snapshot = self.client.snapshot()?;
        let owner = require_cohort_owner(&mut snapshot, input)?;
        Ok(derive_cohort(&mut snapshot, input, &owner, &self.bucket_secret)?.0)
    }
    pub fn decide(
        &self,
        input: &CohortInput,
        explicit_negative: bool,
    ) -> Result<DecideResult, Error> {
        let service = self.clone();
        let input = input.clone();
        self.client
            .submit(move |tx| {
                let result = service.decide_in_transaction(tx, &input, explicit_negative)?;
                if result.transition.action != "none" {
                    return Err(reject(
                        tx,
                        "Actionable decision requires caller transaction",
                    ));
                }
                Ok(result)
            })?
            .wait()
    }
    pub fn decide_in_transaction(
        &self,
        tx: &mut Write<'_>,
        input: &CohortInput,
        explicit_negative: bool,
    ) -> Result<DecideResult, Error> {
        let (mut version, project) = require_cohort_owner(tx, input)?;
        if !matches!(version.state.as_str(), Some("trial" | "active")) {
            return Err(reject(tx, "Version is not governable"));
        }
        let (cohort, samples) =
            derive_cohort(tx, input, &(version.clone(), project), &self.bucket_secret)?;
        let feedback = rows::<artifacts::FeedbackTable>(
            tx,
            "project_artifact_feedback_version_created_idx",
            &key(&version.id),
        )?;
        let restored_at = feedback
            .iter()
            .filter(|row| row.action.as_str() == Some("restore"))
            .fold(version.last_restored_at, |latest, row| {
                Some(latest.map_or(row.time_created, |latest| latest.max(row.time_created)))
            });
        let transition = decision(&DecisionInput {
            stage: version.state.as_str().expect("governable state"),
            created_at: version.time_created as f64,
            last_transition_at: version
                .last_governor_transition_at
                .unwrap_or(version.time_state_changed) as f64,
            restored_at: restored_at.map(|at| at as f64),
            state: GovernorState {
                first_qualified_at: version.first_qualified_at.map(|at| at as f64),
            },
            now: input.now as f64,
            candidate: cohort.candidate,
            baseline: Some(cohort.baseline),
            explicit_negative: explicit_negative
                || feedback.iter().any(|row| {
                    matches!(row.action.as_str(), Some("disable" | "delete" | "revert"))
                }),
            global: matches!(input.scope, CohortScope::Global),
            global_samples: &samples,
        });
        version.first_qualified_at = transition.state.first_qualified_at.map(|at| at as i64);
        version.last_evaluated_at = Some(input.now);
        version.last_restored_at = restored_at;
        if transition.action != "none" {
            version.last_governor_transition_at = Some(input.now);
        }
        artifacts::VersionTable::put(tx, &version)?;
        Ok(DecideResult { transition, cohort })
    }
}

trait ReadTables {
    fn get<T: TableSpec>(&mut self, key: &[u8]) -> Result<Option<T::Record>, Error>;
    fn range<T: TableSpec>(
        &mut self,
        name: &str,
        query: IndexQuery<'_>,
    ) -> Result<Vec<IndexEntry<T::Record>>, Error>;
}
impl ReadTables for Snapshot {
    fn get<T: TableSpec>(&mut self, key: &[u8]) -> Result<Option<T::Record>, Error> {
        Snapshot::get::<T>(self, key)
    }
    fn range<T: TableSpec>(
        &mut self,
        name: &str,
        query: IndexQuery<'_>,
    ) -> Result<Vec<IndexEntry<T::Record>>, Error> {
        self.index_range::<T>(name, query)
    }
}
impl ReadTables for Write<'_> {
    fn get<T: TableSpec>(&mut self, key: &[u8]) -> Result<Option<T::Record>, Error> {
        Write::get::<T>(self, key)
    }
    fn range<T: TableSpec>(
        &mut self,
        name: &str,
        query: IndexQuery<'_>,
    ) -> Result<Vec<IndexEntry<T::Record>>, Error> {
        self.index_range::<T>(name, query)
    }
}
fn rows<T: TableSpec>(
    reader: &mut impl ReadTables,
    index: &str,
    prefix: &[u8],
) -> Result<Vec<T::Record>, Error> {
    let mut cursor: Option<IndexCursor> = None;
    let mut output = Vec::new();
    loop {
        let page = reader.range::<T>(
            index,
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(prefix),
                order: IndexOrder::Ascending,
                after: cursor.as_ref(),
                limit: 128,
            },
        )?;
        if page.is_empty() {
            return Ok(output);
        }
        cursor = page.last().map(|row| row.cursor.clone());
        output.extend(page.into_iter().map(|row| row.record));
    }
}
fn load_owner(
    reader: &mut impl ReadTables,
    id: &project_artifact::VersionId,
) -> Result<(artifacts::Version, Option<LosslessString>), Error> {
    let version = reader
        .get::<artifacts::VersionTable>(&key(id.as_lossless()))?
        .ok_or_else(|| domain_error("Version owner mismatch"))?;
    let scope = reader
        .get::<artifacts::ScopeTable>(&key(&version.scope_id))?
        .ok_or_else(|| domain_error("Version owner mismatch"))?;
    let project = reader.get::<artifacts::ProjectScopeTable>(&key(&version.scope_id))?;
    let global = reader.get::<artifacts::GlobalScopeTable>(&key(&version.scope_id))?;
    if scope.type_.as_str() == Some("project") && project.is_some() && global.is_none() {
        return Ok((version, project.map(|project| project.project_id)));
    }
    if scope.type_.as_str() == Some("global")
        && project.is_none()
        && global.is_some_and(|global| global.singleton == 1)
    {
        return Ok((version, None));
    }
    Err(domain_error("Version owner mismatch"))
}
fn require_cohort_owner(
    reader: &mut impl ReadTables,
    input: &CohortInput,
) -> Result<(artifacts::Version, Option<LosslessString>), Error> {
    let owner = load_owner(reader, &input.version_id)?;
    if owner.0.kind != *input.kind.as_lossless()
        || match &input.scope {
            CohortScope::Project(project) => owner.1.as_ref() != Some(project.as_lossless()),
            CohortScope::Global => owner.1.is_some(),
        }
    {
        return Err(domain_error("Version owner mismatch"));
    }
    Ok(owner)
}
fn derive_cohort(
    reader: &mut impl ReadTables,
    input: &CohortInput,
    owner: &(artifacts::Version, Option<LosslessString>),
    secret: &str,
) -> Result<(CohortResult, Vec<ProjectBucketSample>), Error> {
    let cutoff = input.now as f64 - 30.0 * DAY;
    let observations = rows::<artifacts::ObservationTable>(
        reader,
        "project_artifact_observation_version_eligible_observed_idx",
        &key(input.version_id.as_lossless()),
    )?;
    let terminals = rows::<artifacts::TerminalTable>(
        reader,
        "project_artifact_terminal_cohort_idx",
        &tuple_key(&[
            KeyPart::String(input.kind.as_lossless()),
            input
                .agent_id
                .as_ref()
                .map_or(KeyPart::Null, KeyPart::String),
            KeyPart::String(&input.model_id),
            KeyPart::I64(i64::from(input.goal_mode)),
        ]),
    )?;
    let matched = terminals
        .into_iter()
        .filter(|row| {
            row.observed_at as f64 >= cutoff
                && row.observed_at <= input.now
                && (matches!(input.scope, CohortScope::Global)
                    || Some(&row.project_id) == owner.1.as_ref())
        })
        .collect::<Vec<_>>();
    let mut by_identity = BTreeMap::new();
    for terminal in &matched {
        let key = (
            terminal.session_id.clone(),
            terminal.terminal_message_id.clone(),
        );
        if by_identity
            .get(&key)
            .is_none_or(|current: &&artifacts::Terminal| current.observed_at < terminal.observed_at)
        {
            by_identity.insert(key, terminal);
        }
    }
    let mut candidates = BTreeMap::new();
    for observation in observations {
        if observation.eligible != 1
            || observation.external_confounded != 0
            || (observation.observed_at as f64) < cutoff
            || observation.observed_at > input.now
            || observation.kind != owner.0.kind
        {
            continue;
        }
        let (Some(session), Some(project)) = (&observation.session_id, &observation.project_id)
        else {
            continue;
        };
        if matches!(input.scope, CohortScope::Project(_)) && Some(project) != owner.1.as_ref() {
            continue;
        }
        let Some(terminal) =
            by_identity.get(&(session.clone(), observation.terminal_message_id.clone()))
        else {
            continue;
        };
        if &terminal.project_id != project
            || terminal.managed_activation_count != 1
            || terminal.standard_invocation_count != 0
            || terminal.external_confounded != 0
        {
            continue;
        }
        if candidates
            .get(session)
            .is_none_or(|current: &artifacts::Observation| {
                current.observed_at < observation.observed_at
            })
        {
            candidates.insert(session.clone(), observation);
        }
    }
    let samples = if matches!(input.scope, CohortScope::Global) {
        candidates
            .iter()
            .map(|(session, observation)| ProjectBucketSample {
                sample_id: project_bucket(
                    secret,
                    &format!("session\0{}", session.as_str().expect("session ID")),
                ),
                bucket_id: project_bucket(
                    secret,
                    observation
                        .project_id
                        .as_ref()
                        .expect("candidate project")
                        .as_str()
                        .expect("project ID"),
                ),
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let buckets = samples
        .iter()
        .map(|sample| &sample.bucket_id)
        .collect::<std::collections::BTreeSet<_>>();
    let mut baselines = BTreeMap::new();
    for terminal in &matched {
        if terminal.managed_activation_count != 0
            || terminal.standard_invocation_count != 0
            || terminal.external_confounded != 0
            || terminal.terminal_outcome.as_str() == Some("interrupted")
            || terminal.goal_status.as_str() == Some("stopped")
            || (matches!(input.scope, CohortScope::Global)
                && !buckets.contains(&project_bucket(
                    secret,
                    terminal.project_id.as_str().expect("project ID"),
                )))
        {
            continue;
        }
        if baselines
            .get(&terminal.session_id)
            .is_none_or(|current: &&artifacts::Terminal| current.observed_at < terminal.observed_at)
        {
            baselines.insert(terminal.session_id.clone(), terminal);
        }
    }
    let candidate = SampleCounts {
        sample_count: candidates.len() as f64,
        success_count: candidates
            .values()
            .filter(|row| {
                row.terminal_outcome.as_str() == Some("succeeded")
                    && row.goal_status.as_str() != Some("exhausted")
            })
            .count() as f64,
    };
    let baseline = SampleCounts {
        sample_count: baselines.len() as f64,
        success_count: baselines
            .values()
            .filter(|row| {
                row.terminal_outcome.as_str() == Some("succeeded")
                    && row.goal_status.as_str() != Some("exhausted")
            })
            .count() as f64,
    };
    Ok((
        CohortResult {
            candidate,
            baseline,
            project_buckets: project_bucket_totals(&samples),
        },
        samples,
    ))
}
fn activation_row(input: &project_artifact::Activation) -> artifacts::Activation {
    artifacts::Activation {
        id: input.id.as_lossless().clone(),
        scope_id: input.artifact.identity.scope_id.as_lossless().clone(),
        kind: input.artifact.identity.kind.as_lossless().clone(),
        artifact_id: input.artifact.identity.id.as_lossless().clone(),
        version_id: input.artifact.version_id.as_lossless().clone(),
        project_id: input.project_id.as_ref().map(|id| id.as_lossless().clone()),
        session_id: input.session_id.as_ref().map(|id| id.as_lossless().clone()),
        agent_id: input.agent_id.clone(),
        source: literal(&input.source),
        message_id: input.message_id.as_ref().map(|id| id.as_lossless().clone()),
        call_id: input.call_id.as_ref().map(|id| id.as_lossless().clone()),
        boundary_seq: input.boundary_seq.get(),
        activated_at: input.activated_at.get(),
        deactivated_at: input.deactivated_at.map(|value| value.get()),
    }
}
fn terminal_row(input: &ObserveInput, count: usize, confounded: bool) -> artifacts::Terminal {
    artifacts::Terminal {
        id: digest_id(
            "pat",
            &[
                input.session_id.as_lossless().clone(),
                input
                    .terminal_message_id
                    .as_ref()
                    .map(|message| message.as_lossless().clone())
                    .unwrap_or_else(|| {
                        format!("boundary:{}", input.boundary_seq.get())
                            .as_str()
                            .into()
                    }),
            ],
        ),
        project_id: input.project_id.as_lossless().clone(),
        session_id: input.session_id.as_lossless().clone(),
        terminal_message_id: input
            .terminal_message_id
            .as_ref()
            .map(|message| message.as_lossless().clone()),
        boundary_seq: input.boundary_seq.get(),
        kind: input.kind.as_lossless().clone(),
        agent_id: input.agent_id.clone(),
        model_id: input.model_id.clone(),
        goal_mode: i64::from(input.goal_mode),
        managed_activation_count: count as i64,
        standard_invocation_count: input.standard_invocation_count.get(),
        external_confounded: i64::from(confounded),
        terminal_outcome: literal(&input.terminal_outcome),
        goal_status: literal(&input.goal_status),
        repeat_fix: i64::from(input.repeat_fix),
        observed_at: input.observed_at.get(),
    }
}
fn persist_terminal(tx: &mut Write<'_>, row: &artifacts::Terminal) -> Result<(), Error> {
    if let Some(existing) = tx.get::<artifacts::TerminalTable>(&key(&row.id))? {
        if &existing != row {
            return Err(reject(tx, "Conflicting terminal fact ID"));
        }
        return Ok(());
    }
    let (index, identity) = if let Some(message) = &row.terminal_message_id {
        (
            "project_artifact_terminal_message_identity_idx",
            tuple_key(&[KeyPart::String(&row.session_id), KeyPart::String(message)]),
        )
    } else {
        (
            "project_artifact_terminal_boundary_identity_idx",
            tuple_key(&[
                KeyPart::String(&row.session_id),
                KeyPart::I64(row.boundary_seq),
            ]),
        )
    };
    if let Some(existing) = rows::<artifacts::TerminalTable>(tx, index, &identity)?.first() {
        if existing != row {
            return Err(reject(tx, "Conflicting terminal fact identity"));
        }
        return Ok(());
    }
    artifacts::TerminalTable::insert(tx, row)
}
fn activation_identity(row: &artifacts::Activation) -> (&'static str, Vec<u8>) {
    if let Some(session) = &row.session_id {
        return (
            "project_artifact_activation_identity_idx",
            tuple_key(&[
                KeyPart::String(session),
                KeyPart::String(&row.version_id),
                KeyPart::String(&row.source),
                KeyPart::I64(row.boundary_seq),
            ]),
        );
    }
    (
        "project_artifact_activation_sessionless_identity_idx",
        tuple_key(&[
            KeyPart::String(&row.version_id),
            KeyPart::String(&row.source),
            KeyPart::I64(row.boundary_seq),
        ]),
    )
}
fn observation_identity(row: &artifacts::Observation) -> (&'static str, Vec<u8>) {
    if let Some(message) = &row.terminal_message_id {
        return (
            "project_artifact_observation_version_terminal_idx",
            tuple_key(&[KeyPart::String(&row.version_id), KeyPart::String(message)]),
        );
    }
    if let Some(session) = &row.session_id {
        return (
            "project_artifact_observation_version_session_absent_idx",
            tuple_key(&[KeyPart::String(&row.version_id), KeyPart::String(session)]),
        );
    }
    (
        "project_artifact_observation_sessionless_absent_idx",
        key(&row.version_id),
    )
}
fn observation_value(row: &artifacts::Observation) -> Result<project_artifact::Observation, Error> {
    let artifact = ObjectEncoder::new()
        .field("scopeID", &row.scope_id)
        .field("kind", &row.kind)
        .field("id", &row.artifact_id)
        .field("versionID", &row.version_id)
        .finish();
    let mut value = ObjectEncoder::new()
        .field("id", &row.id)
        .field("artifact", &artifact)
        .optional("projectID", &row.project_id)
        .optional("sessionID", &row.session_id)
        .field("activationSetDigest", &row.activation_set_digest)
        .field("activeArtifactCount", &(row.active_artifact_count as f64))
        .field("externalConfounded", &(row.external_confounded == 1))
        .field("eligible", &(row.eligible == 1))
        .field("terminalOutcome", &row.terminal_outcome)
        .field("goalStatus", &row.goal_status)
        .field("repeatFix", &(row.repeat_fix == 1));
    for (key, number) in [
        ("latencyMs", row.latency_ms),
        ("inputTokens", row.input_tokens),
        ("outputTokens", row.output_tokens),
        ("cacheReadTokens", row.cache_read_tokens),
        ("completedToolCount", row.completed_tool_count),
        ("failedToolCount", row.failed_tool_count),
    ] {
        value = value.optional(key, &number.map(|number| number as f64));
    }
    project_artifact::Observation::decode(
        &value
            .optional("terminalMessageID", &row.terminal_message_id)
            .field("observedAt", &(row.observed_at as f64))
            .finish(),
    )
    .map_err(record_error)
}
fn key(value: &LosslessString) -> Vec<u8> {
    tuple_key(&[KeyPart::String(value)])
}
fn literal(value: &impl DomainEncode) -> LosslessString {
    let JsonValue::String(value) = value.encode() else {
        unreachable!("string-domain projection")
    };
    value
}
fn digest_id(prefix: &str, parts: &[LosslessString]) -> LosslessString {
    format!(
        "{prefix}_{}",
        &package::sha256(&crate::resources::discovery::join(parts, "\0"))
            .as_lossless()
            .as_str()
            .expect("digest")[..32]
    )
    .as_str()
    .into()
}
fn domain_error(message: &'static str) -> Error {
    Error::Domain {
        kind: "artifact_accounting",
        message,
    }
}
fn reject(tx: &mut Write<'_>, message: &'static str) -> Error {
    tx.reject(domain_error(message))
}
fn record_error(error: DecodeError) -> Error {
    Error::Record(Box::new(error))
}
