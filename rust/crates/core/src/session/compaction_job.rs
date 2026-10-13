use super::{key, message_updater, projector, store::Service};
use std::ops::Bound;
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder, ObjectEncoder,
    session, session_compaction, session_event, session_message,
};
use ycoding_store::{
    Error, IndexOrder, IndexQuery, KeyPart, Write,
    session::{
        ContextState, ContextStateTable, Document, Event, Exclusion, ExclusionTable, Job, JobTable,
        ManifestTable, Message, MessageTable, NewEvent, Revision, RevisionTable,
    },
    tuple_key,
};

#[derive(Debug)]
pub enum CompactionError {
    Conflict {
        id: Option<LosslessString>,
        message: String,
    },
    Ownership {
        id: LosslessString,
        owner: Option<String>,
        message: String,
    },
    Store(Error),
}

impl std::fmt::Display for CompactionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Conflict { message, .. } | Self::Ownership { message, .. } => {
                write!(formatter, "{message}")
            }
            Self::Store(error) => write!(formatter, "{error}"),
        }
    }
}
impl std::error::Error for CompactionError {}
impl From<Error> for CompactionError {
    fn from(error: Error) -> Self {
        Self::Store(error)
    }
}

type Settled<T> = Result<T, CompactionError>;

pub struct AdmitInput {
    pub id: Option<session_compaction::Id>,
    pub session: session::Id,
    pub trigger: session_compaction::Trigger,
    pub requested_through_message: session_message::Id,
    pub requested_through_seq: i64,
    pub base_context_revision: i64,
    pub target_max_input_tokens: i64,
    pub config_digest: String,
    pub pressure: Option<session_compaction::Pressure>,
}

pub struct Lease {
    pub owner: String,
    pub now: i64,
    pub expires_at: i64,
}

pub enum Target {
    Session(session::Id),
    Job(session_compaction::Id),
}

pub struct EndInput {
    pub id: session_compaction::Id,
    pub owner: String,
    pub manifest_digest: String,
    pub revision: i64,
    pub boundary: session_compaction::Boundary,
    pub metrics: session_compaction::Metrics,
    pub now: i64,
}

pub struct FailInput {
    pub id: session_compaction::Id,
    pub owner: Option<String>,
    pub code: session_compaction::FailureCode,
    pub now: i64,
}

impl Service {
    pub async fn compaction_admit(&self, input: AdmitInput, now: i64) -> Settled<Job> {
        self.client
            .submit(move |tx| admit(tx, &input, now))?
            .await?
    }

    pub fn compaction_job(&self, id: &session_compaction::Id) -> Result<Option<Job>, Error> {
        self.client.snapshot()?.get::<JobTable>(&key(&text(id)))
    }

    pub async fn compaction_pending(&self, session: &session::Id) -> Result<Vec<Job>, Error> {
        let session = session.as_lossless().clone();
        self.client.submit(move |tx| active(tx, &session))?.await
    }

    pub async fn compaction_has_unchanged_deterministic_failure(
        &self,
        input: AdmitInput,
    ) -> Result<bool, Error> {
        self.client
            .submit(move |tx| {
                Ok(jobs(tx, "failed")?.into_iter().any(|row| {
                    row.session_id == *input.session.as_lossless()
                        && matches!(
                            row.error_code.as_ref().and_then(|code| code.as_str()),
                            Some("context_limit_unresolved" | "invalid_manifest")
                        )
                        && row.requested_through_message_id
                            == text(&input.requested_through_message)
                        && row.requested_through_seq == input.requested_through_seq
                        && row.base_context_revision == input.base_context_revision
                        && row.target_max_input_tokens == Some(input.target_max_input_tokens)
                        && row
                            .config_digest
                            .as_ref()
                            .and_then(|digest| digest.as_str())
                            == Some(input.config_digest.as_str())
                }))
            })?
            .await
    }

    pub async fn compaction_claim(&self, target: Target, lease: Lease) -> Settled<Option<Job>> {
        self.client
            .submit(move |tx| claim(tx, &target, &lease))?
            .await?
    }

    pub async fn compaction_heartbeat(
        &self,
        id: session_compaction::Id,
        owner: String,
        expires_at: i64,
    ) -> Settled<Job> {
        self.client
            .submit(move |tx| heartbeat(tx, &id, &owner, expires_at))?
            .await?
    }

    pub async fn compaction_end(&self, input: EndInput) -> Settled<Job> {
        self.client.submit(move |tx| end(tx, &input))?.await?
    }

    pub async fn compaction_fail(&self, input: FailInput) -> Settled<Job> {
        self.client.submit(move |tx| fail(tx, &input))?.await?
    }
}

fn admit(tx: &mut Write<'_>, input: &AdmitInput, now: i64) -> Result<Settled<Job>, Error> {
    let session = input.session.as_lossless();
    if let Some(id) = &input.id
        && let Some(exact) = tx.get::<JobTable>(&key(&text(id)))?
    {
        return Ok(if matches_admission(&exact, input) {
            Ok(exact)
        } else {
            conflict(
                Some(exact.id),
                "Compaction job ID was reused with different admission input",
            )
        });
    }
    let active = active(tx, session)?;
    if matches!(
        input.trigger,
        session_compaction::Trigger::Consider | session_compaction::Trigger::Advised
    ) && let Some(existing) = active
        .iter()
        .find(|row| row.status.as_str() == Some("running"))
        .or(active.first())
    {
        return Ok(Ok(existing.clone()));
    }
    if let Err(error) = validate(tx, input)? {
        return Ok(Err(error));
    }
    let pending = active
        .iter()
        .filter(|row| row.status.as_str() == Some("pending"))
        .collect::<Vec<_>>();
    if pending.len() > 1 {
        return Ok(conflict(
            input.id.as_ref().map(text),
            "Session has more than one pending compaction job",
        ));
    }
    if let Some(existing) = pending.first() {
        if compatible(existing, input) {
            if input.requested_through_seq <= existing.requested_through_seq {
                return Ok(Ok((*existing).clone()));
            }
            let advanced = Job {
                requested_through_message_id: text(&input.requested_through_message),
                requested_through_seq: input.requested_through_seq,
                ..(*existing).clone()
            };
            JobTable::put(tx, &advanced)?;
            return Ok(Ok(advanced));
        }
        settle_failed(
            tx,
            existing,
            session_compaction::FailureCode::Superseded,
            now,
        )?;
    }
    let id = match &input.id {
        Some(id) => id.clone(),
        None => new_id()?,
    };
    let job = Job {
        id: text(&id),
        session_id: session.clone(),
        legacy_input_id: None,
        trigger: input.trigger.as_str().into(),
        requested_through_message_id: text(&input.requested_through_message),
        requested_through_seq: input.requested_through_seq,
        base_context_revision: input.base_context_revision,
        target_max_input_tokens: Some(input.target_max_input_tokens),
        config_digest: Some(input.config_digest.as_str().into()),
        status: "pending".into(),
        lease_owner: None,
        lease_expires_at: None,
        attempts: 0,
        manifest_digest: None,
        error_code: None,
        error_message: None,
        time_created: now,
        time_started: None,
        time_ended: None,
    };
    JobTable::insert(tx, &job)?;
    publish(
        tx,
        session,
        now,
        "session.compaction.admitted.2",
        ObjectEncoder::new()
            .field("sessionID", &input.session)
            .field("jobID", &id)
            .optional("pressure", &input.pressure)
            .finish(),
    )?;
    Ok(Ok(job))
}

fn validate(tx: &mut Write<'_>, input: &AdmitInput) -> Result<Settled<()>, Error> {
    let invalid = input.base_context_revision < 0
        || input.target_max_input_tokens < 0
        || input.requested_through_seq < 0
        || !digest(&input.config_digest);
    if invalid {
        return Ok(conflict(
            input.id.as_ref().map(text),
            "Compaction admission values are invalid",
        ));
    }
    let state = tx.get::<ContextStateTable>(&key(input.session.as_lossless()))?;
    if state.as_ref().is_none_or(|state| {
        state.status.as_str() != Some("active") || state.revision != input.base_context_revision
    }) {
        return Ok(conflict(
            input.id.as_ref().map(text),
            "Compaction admission does not match the active context revision",
        ));
    }
    let boundary = tx
        .get::<MessageTable>(&key(&text(&input.requested_through_message)))?
        .filter(|row| row.session_id == *input.session.as_lossless());
    if boundary.is_none_or(|row| row.seq != input.requested_through_seq) {
        return Ok(conflict(
            input.id.as_ref().map(text),
            "Compaction admission boundary does not match canonical Session history",
        ));
    }
    Ok(Ok(()))
}

fn claim(
    tx: &mut Write<'_>,
    target: &Target,
    lease: &Lease,
) -> Result<Settled<Option<Job>>, Error> {
    if lease.owner.is_empty()
        || lease.now < 0
        || lease.expires_at < 0
        || lease.expires_at <= lease.now
    {
        return Ok(conflict(None, "Compaction claim lease values are invalid"));
    }
    let row = match target {
        Target::Job(id) => tx.get::<JobTable>(&key(&text(id)))?,
        Target::Session(session) => next_claimable(tx, session.as_lossless(), lease.now)?,
    };
    let Some(row) = row else {
        return Ok(Ok(None));
    };
    if let Target::Session(session) = target
        && row.session_id != *session.as_lossless()
    {
        return Ok(Ok(None));
    }
    if row.legacy_input_id.is_some() {
        return Ok(conflict(
            Some(row.id),
            "Legacy compaction work is not claimable by this authority",
        ));
    }
    match row.status.as_str() {
        Some("running") => {
            if row
                .lease_expires_at
                .is_none_or(|expires| expires > lease.now)
            {
                return Ok(Ok(None));
            }
            let reclaimed = Job {
                lease_owner: Some(lease.owner.as_str().into()),
                lease_expires_at: Some(lease.expires_at),
                attempts: row.attempts + 1,
                ..row
            };
            JobTable::put(tx, &reclaimed)?;
            Ok(Ok(Some(reclaimed)))
        }
        Some("pending") => {
            if active(tx, &row.session_id)?
                .iter()
                .any(|other| other.status.as_str() == Some("running"))
            {
                return Ok(Ok(None));
            }
            let started = Job {
                status: "running".into(),
                lease_owner: Some(lease.owner.as_str().into()),
                lease_expires_at: Some(lease.expires_at),
                attempts: row.attempts + 1,
                time_started: Some(lease.now),
                ..row
            };
            JobTable::put(tx, &started)?;
            publish(
                tx,
                &started.session_id,
                lease.now,
                "session.compaction.started.2",
                ObjectEncoder::new()
                    .field("sessionID", &started.session_id)
                    .field("jobID", &started.id)
                    .finish(),
            )?;
            Ok(Ok(Some(started)))
        }
        _ => Ok(Ok(None)),
    }
}

fn heartbeat(
    tx: &mut Write<'_>,
    id: &session_compaction::Id,
    owner: &str,
    expires_at: i64,
) -> Result<Settled<Job>, Error> {
    let identity = Some(text(id));
    if owner.is_empty() || expires_at < 0 {
        return Ok(conflict(identity, "Heartbeat lease values are invalid"));
    }
    let Some(row) = tx.get::<JobTable>(&key(&text(id)))? else {
        return Ok(conflict(identity, "Compaction job does not exist"));
    };
    if row.status.as_str() != Some("running")
        || row.lease_owner.as_ref().and_then(|value| value.as_str()) != Some(owner)
        || row.legacy_input_id.is_some()
    {
        return Ok(ownership(
            text(id),
            Some(owner),
            "Compaction heartbeat is not owned by this lease",
        ));
    }
    let updated = Job {
        lease_expires_at: Some(expires_at),
        ..row
    };
    JobTable::put(tx, &updated)?;
    Ok(Ok(updated))
}

fn end(tx: &mut Write<'_>, input: &EndInput) -> Result<Settled<Job>, Error> {
    let identity = Some(text(&input.id));
    let Some(row) = tx.get::<JobTable>(&key(&text(&input.id)))? else {
        return Ok(conflict(identity, "Compaction job does not exist"));
    };
    if row.legacy_input_id.is_some() {
        return Ok(conflict(
            identity,
            "Legacy compaction work is not settled by this authority",
        ));
    }
    if row.status.as_str() == Some("ended") {
        return Ok(
            if row
                .manifest_digest
                .as_ref()
                .and_then(|value| value.as_str())
                == Some(input.manifest_digest.as_str())
            {
                Ok(row)
            } else {
                conflict(
                    identity,
                    "Ended compaction job was settled with a different manifest",
                )
            },
        );
    }
    if row.status.as_str() != Some("running") {
        return Ok(ownership(
            row.id,
            Some(&input.owner),
            "Compaction job is not running",
        ));
    }
    if row.lease_owner.as_ref().and_then(|value| value.as_str()) != Some(input.owner.as_str()) {
        return Ok(ownership(
            row.id,
            Some(&input.owner),
            "Compaction settlement is not owned by this lease",
        ));
    }
    if input.revision != row.base_context_revision + 1
        || text(&input.boundary.message_id) != row.requested_through_message_id
        || input.boundary.seq.get() != row.requested_through_seq
    {
        return Ok(conflict(
            identity,
            "Compaction settlement does not match its admitted revision and boundary",
        ));
    }
    let metrics = &input.metrics;
    if !digest(&input.manifest_digest)
        || input.now < 0
        || [
            metrics.excluded_messages.get(),
            metrics.excluded_parts.get(),
            metrics.input_tokens.get(),
            metrics.retained_tokens.get(),
        ]
        .iter()
        .any(|value| *value < 0)
    {
        return Ok(conflict(
            identity,
            "Compaction settlement values are invalid",
        ));
    }
    if tx
        .get::<ManifestTable>(&key(&input.manifest_digest.as_str().into()))?
        .is_none()
    {
        return Ok(conflict(identity, "Compaction manifest is not durable"));
    }
    let Some(blob) = tx.get::<ManifestTable>(&key(&input.manifest_digest.as_str().into()))? else {
        return Ok(conflict(identity, "Compaction manifest is not durable"));
    };
    let Ok(manifest) = super::context_manifest::parse_manifest(blob.content.value()) else {
        return Ok(conflict(identity, "Compaction manifest content is invalid"));
    };
    if manifest.base_context_revision.get() != row.base_context_revision
        || text(&manifest.covered_through.message_id) != row.requested_through_message_id
        || manifest.covered_through.seq.get() != row.requested_through_seq
    {
        return Ok(conflict(
            identity,
            "Compaction manifest does not match its settled revision and boundary",
        ));
    }
    let state = tx.get::<ContextStateTable>(&key(&row.session_id))?;
    if state.as_ref().is_none_or(|state| {
        state.status.as_str() != Some("active") || state.revision != row.base_context_revision
    }) {
        return Ok(conflict(
            identity,
            "Compaction activation does not match the active context revision",
        ));
    }
    let boundary = tx
        .get::<MessageTable>(&key(&text(&manifest.covered_through.message_id)))?
        .filter(|message| message.session_id == row.session_id);
    if boundary.is_none_or(|message| message.seq != manifest.covered_through.seq.get()) {
        return Ok(conflict(
            identity,
            "Compaction activation boundary does not match canonical Session history",
        ));
    }
    let ended_event = publish(
        tx,
        &row.session_id,
        input.now,
        "session.compaction.ended.2",
        ObjectEncoder::new()
            .field("sessionID", &row.session_id)
            .field("jobID", &row.id)
            .field("revision", &(input.revision as f64))
            .field("boundary", &input.boundary)
            .field("metrics", &input.metrics)
            .finish(),
    )?;
    activate(
        tx,
        &row,
        &manifest,
        &input.manifest_digest,
        &ended_event,
        input.now,
    )?;
    let ended = Job {
        status: "ended".into(),
        lease_owner: None,
        lease_expires_at: None,
        manifest_digest: Some(input.manifest_digest.as_str().into()),
        time_ended: Some(input.now),
        ..row
    };
    JobTable::put(tx, &ended)?;
    Ok(Ok(ended))
}

fn fail(tx: &mut Write<'_>, input: &FailInput) -> Result<Settled<Job>, Error> {
    let identity = Some(text(&input.id));
    let Some(row) = tx.get::<JobTable>(&key(&text(&input.id)))? else {
        return Ok(conflict(identity, "Compaction job does not exist"));
    };
    if row.legacy_input_id.is_some() {
        return Ok(conflict(
            identity,
            "Legacy compaction work is not settled by this authority",
        ));
    }
    if row.status.as_str() == Some("failed") {
        return Ok(
            if row.error_code.as_ref().and_then(|value| value.as_str()) == Some(input.code.as_str())
            {
                Ok(row)
            } else {
                conflict(
                    identity,
                    "Failed compaction job was settled with a different code",
                )
            },
        );
    }
    if row.status.as_str() == Some("ended") {
        return Ok(conflict(identity, "Ended compaction job cannot fail"));
    }
    if input.now < 0 {
        return Ok(conflict(identity, "Compaction failure time is invalid"));
    }
    let pending = row.status.as_str() == Some("pending");
    if pending
        && !matches!(
            input.code,
            session_compaction::FailureCode::Cancelled
                | session_compaction::FailureCode::Superseded
        )
    {
        return Ok(conflict(
            identity,
            "Pending compaction work can only be cancelled or superseded",
        ));
    }
    if pending && input.owner.is_some() {
        return Ok(ownership(
            row.id,
            input.owner.as_deref(),
            "Pending compaction work has no lease owner",
        ));
    }
    if !pending
        && row.lease_owner.as_ref().and_then(|value| value.as_str()) != input.owner.as_deref()
    {
        return Ok(ownership(
            row.id,
            input.owner.as_deref(),
            "Compaction failure is not owned by this lease",
        ));
    }
    Ok(Ok(settle_failed(tx, &row, input.code, input.now)?))
}

fn settle_failed(
    tx: &mut Write<'_>,
    row: &Job,
    code: session_compaction::FailureCode,
    now: i64,
) -> Result<Job, Error> {
    let message = failure_message(code);
    let failed = Job {
        status: "failed".into(),
        lease_owner: None,
        lease_expires_at: None,
        error_code: Some(code.as_str().into()),
        error_message: Some(message.into()),
        time_ended: Some(now),
        ..row.clone()
    };
    JobTable::put(tx, &failed)?;
    publish(
        tx,
        &failed.session_id,
        now,
        "session.compaction.failed.2",
        ObjectEncoder::new()
            .field("sessionID", &failed.session_id)
            .field("jobID", &failed.id)
            .field("code", &code)
            .field(
                "error",
                &ycoding_schema::session_error::Error {
                    r#type: format!("compaction_{}", code.as_str()).as_str().into(),
                    message: message.into(),
                },
            )
            .finish(),
    )?;
    Ok(failed)
}

fn failure_message(code: session_compaction::FailureCode) -> &'static str {
    match code {
        session_compaction::FailureCode::Cancelled => "Compaction was cancelled",
        session_compaction::FailureCode::Superseded => {
            "Compaction was superseded by a newer request"
        }
        session_compaction::FailureCode::InvalidManifest => {
            "Compaction produced an invalid manifest"
        }
        session_compaction::FailureCode::ProtectedStateChanged => {
            "Protected Session state changed during compaction"
        }
        session_compaction::FailureCode::ContextLimitUnresolved => {
            "Compaction did not resolve the context limit"
        }
        session_compaction::FailureCode::MigrationFailed => "Compaction migration failed",
        session_compaction::FailureCode::ProviderFailed => "Compaction provider request failed",
    }
}

fn publish(
    tx: &mut Write<'_>,
    session: &LosslessString,
    now: i64,
    kind: &str,
    data: JsonValue,
) -> Result<Event, Error> {
    projector::append(
        tx,
        &NewEvent {
            id: projector::random_event_id()?.as_lossless().clone(),
            aggregate_id: session.clone(),
            created: now,
            type_: kind.into(),
            data,
        },
    )
}

fn activate(
    tx: &mut Write<'_>,
    row: &Job,
    manifest: &super::context_manifest::Manifest,
    manifest_digest: &str,
    event: &Event,
    now: i64,
) -> Result<(), Error> {
    let revision = row.base_context_revision + 1;
    RevisionTable::insert(
        tx,
        &Revision {
            session_id: row.session_id.clone(),
            revision,
            parent_revision: Some(row.base_context_revision),
            manifest_digest: Some(manifest_digest.into()),
            covered_through_message_id: Some(text(&manifest.covered_through.message_id)),
            covered_through_seq: Some(manifest.covered_through.seq.get()),
            activation_event_id: Some(event.id.clone()),
            activation_sequence: Some(event.seq),
            time_created: now,
        },
    )?;
    let prefix = key(&row.session_id);
    let mut after = None;
    loop {
        let page = tx.index_range::<ExclusionTable>(
            "session_context_exclusion_current_target_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Ascending,
                after: after.as_ref(),
                limit: 128,
            },
        )?;
        if page.is_empty() {
            break;
        }
        after = page.last().map(|entry| entry.cursor.clone());
        for entry in page {
            let record = entry.record;
            tx.delete::<ExclusionTable>(&tuple_key(&[
                KeyPart::String(&record.session_id),
                KeyPart::I64(record.context_revision),
                KeyPart::String(&record.target_key),
            ]))?;
        }
    }
    for exclusion in &manifest.exclusions {
        ExclusionTable::insert(
            tx,
            &Exclusion {
                session_id: row.session_id.clone(),
                context_revision: revision,
                target_key: exclusion.target_key().into(),
                target_kind: exclusion.target_kind().into(),
                target_selector: Document::new(exclusion.target())?,
                dependency_group: exclusion.dependency_group().map(LosslessString::from),
                reason: exclusion.reason().into(),
                manifest_digest: manifest_digest.into(),
            },
        )?;
    }
    ContextStateTable::put(
        tx,
        &ContextState {
            session_id: row.session_id.clone(),
            status: "active".into(),
            revision,
            manifest_digest: Some(manifest_digest.into()),
            covered_through_message_id: Some(text(&manifest.covered_through.message_id)),
            covered_through_seq: Some(manifest.covered_through.seq.get()),
            activated_event_id: Some(event.id.clone()),
            time_activated: Some(now),
            error_code: None,
        },
    )?;
    ycoding_store::resources::rebase_state(tx, &row.session_id, manifest.covered_through.seq.get())
}

fn jobs(tx: &mut Write<'_>, status: &str) -> Result<Vec<Job>, Error> {
    let prefix = tuple_key(&[KeyPart::String(&status.into())]);
    let mut rows = Vec::new();
    let mut after = None;
    loop {
        let page = tx.index_range::<JobTable>(
            "session_compaction_job_recovery_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Ascending,
                after: after.as_ref(),
                limit: 128,
            },
        )?;
        let Some(last) = page.last() else {
            return Ok(rows);
        };
        after = Some(last.cursor.clone());
        rows.extend(page.into_iter().map(|entry| entry.record));
    }
}

fn active(tx: &mut Write<'_>, session: &LosslessString) -> Result<Vec<Job>, Error> {
    let mut rows = jobs(tx, "pending")?;
    rows.extend(jobs(tx, "running")?);
    rows.retain(|row| row.session_id == *session && row.legacy_input_id.is_none());
    rows.sort_by(|left, right| {
        left.time_created.cmp(&right.time_created).then_with(|| {
            left.id
                .to_utf8()
                .unwrap_or_default()
                .cmp(&right.id.to_utf8().unwrap_or_default())
        })
    });
    Ok(rows)
}

fn next_claimable(
    tx: &mut Write<'_>,
    session: &LosslessString,
    now: i64,
) -> Result<Option<Job>, Error> {
    let rows = active(tx, session)?;
    if let Some(running) = rows
        .iter()
        .find(|row| row.status.as_str() == Some("running"))
    {
        return Ok(running
            .lease_expires_at
            .is_some_and(|expires| expires <= now)
            .then(|| running.clone()));
    }
    Ok(rows
        .into_iter()
        .find(|row| row.status.as_str() == Some("pending")))
}

fn matches_admission(row: &Job, input: &AdmitInput) -> bool {
    row.session_id == *input.session.as_lossless()
        && row.trigger.as_str() == Some(input.trigger.as_str())
        && row.requested_through_message_id == text(&input.requested_through_message)
        && row.requested_through_seq == input.requested_through_seq
        && row.base_context_revision == input.base_context_revision
        && row.target_max_input_tokens == Some(input.target_max_input_tokens)
        && row.config_digest.as_ref().and_then(|value| value.as_str())
            == Some(input.config_digest.as_str())
}

fn compatible(row: &Job, input: &AdmitInput) -> bool {
    row.session_id == *input.session.as_lossless()
        && row.base_context_revision == input.base_context_revision
        && row.target_max_input_tokens == Some(input.target_max_input_tokens)
        && row.config_digest.as_ref().and_then(|value| value.as_str())
            == Some(input.config_digest.as_str())
}

fn conflict<T>(id: Option<LosslessString>, message: &str) -> Settled<T> {
    Err(CompactionError::Conflict {
        id,
        message: message.into(),
    })
}

fn ownership<T>(id: LosslessString, owner: Option<&str>, message: &str) -> Settled<T> {
    Err(CompactionError::Ownership {
        id,
        owner: owner.map(str::to_string),
        message: message.into(),
    })
}

fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn text<T: DomainEncode>(value: &T) -> LosslessString {
    match value.encode() {
        JsonValue::String(text) => text,
        _ => unreachable!("identifier encodes a string"),
    }
}

fn new_id() -> Result<session_compaction::Id, Error> {
    let entropy = projector::random_event_id()?;
    session_compaction::Id::decode(&JsonValue::String(
        format!(
            "cmp_{}",
            entropy
                .as_lossless()
                .to_utf8()
                .unwrap_or_default()
                .trim_start_matches("evt_")
        )
        .as_str()
        .into(),
    ))
    .map_err(projector::record_error)
}

pub(crate) fn fold(
    tx: &mut Write<'_>,
    event: &Event,
    decoded: &session_event::Event,
) -> Result<(), Error> {
    let data = decoded.data.encode();
    let path = JsonPath::default();
    let object = ObjectDecoder::new(&data, &path).map_err(projector::record_error)?;
    let job_id: LosslessString = object.field("jobID").map_err(projector::record_error)?;
    let Some(job) = tx.get::<JobTable>(&key(&job_id))? else {
        return Ok(());
    };
    let current = current(tx, &event.aggregate_id, &job_id)?;
    let (base, pressure) = match &current {
        Some((_, _, base, pressure)) => (base.clone(), pressure.clone()),
        None => (
            session_message::CompactionBase {
                id: session_message::Id::from_event(&decoded.id),
                metadata: None,
                time: session_message::BaseTime {
                    created: ycoding_schema::schema::DateTimeUtcFromMillis::new(
                        job.time_created as f64,
                    )
                    .map_err(projector::record_error)?,
                },
            },
            None,
        ),
    };
    let job_id = session_compaction::Id::decode(&JsonValue::String(job.id.clone()))
        .map_err(projector::record_error)?;
    let trigger = session_compaction::Trigger::decode(&JsonValue::String(job.trigger.clone()))
        .map_err(projector::record_error)?;
    let pressure = pressure.or(object
        .optional("pressure")
        .map_err(projector::record_error)?);
    let compaction = match event.type_.as_str() {
        Some("session.compaction.admitted.2") => {
            session_message::Compaction::Pending(session_message::CompactionPending {
                base,
                job_id,
                trigger,
                pressure,
                summary: None,
                recent: None,
            })
        }
        Some("session.compaction.started.2") => {
            session_message::Compaction::Running(session_message::CompactionRunning {
                base,
                job_id,
                trigger,
                pressure,
                summary: None,
                recent: None,
            })
        }
        Some("session.compaction.ended.2") => {
            session_message::Compaction::Completed(session_message::CompactionCompleted {
                base,
                job_id,
                trigger,
                pressure,
                revision: object.field("revision").map_err(projector::record_error)?,
                boundary: object.field("boundary").map_err(projector::record_error)?,
                metrics: object.field("metrics").map_err(projector::record_error)?,
                summary: None,
                recent: None,
            })
        }
        _ => session_message::Compaction::Failed(session_message::CompactionFailed {
            base,
            job_id,
            trigger,
            pressure,
            code: object.field("code").map_err(projector::record_error)?,
            error: object.field("error").map_err(projector::record_error)?,
            summary: None,
            recent: None,
        }),
    };
    let message = session_message::Info::Compaction(compaction);
    match current {
        Some((row, ..)) => message_updater::update_message(tx, &row, &message),
        None => projector::insert_message(tx, event, &message),
    }
}

type Current = (
    Message,
    session_compaction::Id,
    session_message::CompactionBase,
    Option<session_compaction::Pressure>,
);

fn current(
    tx: &mut Write<'_>,
    session: &LosslessString,
    job_id: &LosslessString,
) -> Result<Option<Current>, Error> {
    let prefix = tuple_key(&[
        KeyPart::String(session),
        KeyPart::String(&"compaction".into()),
    ]);
    let rows = tx.index_range::<MessageTable>(
        "session_message_session_type_seq_idx",
        IndexQuery {
            lower: Bound::Unbounded,
            upper: Bound::Unbounded,
            prefix: Some(&prefix),
            order: IndexOrder::Ascending,
            after: None,
            limit: 1024,
        },
    )?;
    for entry in rows {
        let row = entry.record;
        let session_message::Info::Compaction(compaction) = row.info()? else {
            continue;
        };
        let (found, base, pressure) = match compaction {
            session_message::Compaction::Pending(value) => {
                (value.job_id, value.base, value.pressure)
            }
            session_message::Compaction::Running(value) => {
                (value.job_id, value.base, value.pressure)
            }
            session_message::Compaction::Completed(value) => {
                (value.job_id, value.base, value.pressure)
            }
            session_message::Compaction::Failed(value) => {
                (value.job_id, value.base, value.pressure)
            }
            _ => continue,
        };
        if text(&found) == *job_id {
            return Ok(Some((row, found, base, pressure)));
        }
    }
    Ok(None)
}
