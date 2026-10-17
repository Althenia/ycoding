use super::{history::Entry, key, model_history, store::Service};
use std::{
    collections::{BTreeMap, BTreeSet},
    ops::Bound,
    sync::Arc,
};
use ycoding_schema::{JsonObject, JsonValue, LosslessString, session, session_message};
use ycoding_store::{
    Error, IndexCursor, IndexOrder, IndexQuery, KeyPart, Snapshot, TableSpec, Write,
    session::{
        ContextState, ContextStateTable, Event, EventTable, Job, JobTable, ManifestTable, Message,
        MessageTable, PruneBatch, SessionTable, prune_events, prune_messages,
    },
    tuple_key,
};

#[derive(Clone, Debug, PartialEq)]
pub struct Checkpoint {
    pub through: i64,
    pub manifest_digest: LosslessString,
    pub text: LosslessString,
    pub activated: i64,
    pub ended: i64,
    pub job: LosslessString,
    pub state: ContextState,
}

pub(crate) struct Floor {
    pub(crate) lower: Bound<i64>,
    pub(crate) checkpoint: Option<Checkpoint>,
}

/// The active valid local summary checkpoint of a Session whose manifest an ended compaction job carries.
pub fn checkpoint(snapshot: &Snapshot, id: &session::Id) -> Result<Option<Checkpoint>, Error> {
    let Some(state) = snapshot
        .get::<ContextStateTable>(&key(id.as_lossless()))?
        .filter(|state| {
            state.status.as_str() == Some("active") && state.covered_through_seq.is_some()
        })
    else {
        return Ok(None);
    };
    let Some(summary) = model_history::summary(snapshot, id, &state)? else {
        return Ok(None);
    };
    let Some((job, ended)) = ended_job(snapshot, id, &summary.digest)? else {
        return Ok(None);
    };
    Ok(Some(Checkpoint {
        through: summary.sequence,
        manifest_digest: summary.digest,
        text: summary.text,
        activated: summary.activated,
        ended,
        job,
        state,
    }))
}

pub fn checkpoint_message(checkpoint: &Checkpoint) -> Result<Entry, Error> {
    let mut entry = model_history::checkpoint_entry(
        checkpoint.through,
        checkpoint.text.clone(),
        checkpoint
            .manifest_digest
            .as_str()
            .ok_or(Error::Rejected("manifest digest is not ASCII"))?,
        checkpoint.activated,
    )?;
    let session_message::Info::Synthetic(message) = &mut entry.message else {
        return Err(Error::Rejected("checkpoint entry is not synthetic"));
    };
    let mut marker = JsonObject::new();
    marker.insert(
        "manifestDigest".into(),
        JsonValue::String(checkpoint.manifest_digest.clone()),
    );
    marker.insert(
        "through".into(),
        JsonValue::Number(checkpoint.through as f64),
    );
    let mut metadata = JsonObject::new();
    metadata.insert("compactionCheckpoint".into(), JsonValue::Object(marker));
    message.metadata = Some(metadata);
    message.description = Some("Compaction checkpoint".into());
    Ok(entry)
}

pub(crate) fn checkpoint_in(
    tx: &mut Write<'_>,
    id: &session::Id,
) -> Result<Option<Checkpoint>, Error> {
    let Some(state) = tx
        .get::<ContextStateTable>(&key(id.as_lossless()))?
        .filter(|state| {
            state.status.as_str() == Some("active") && state.covered_through_seq.is_some()
        })
    else {
        return Ok(None);
    };
    let blob = state
        .manifest_digest
        .as_ref()
        .map(|digest| tx.get::<ManifestTable>(&key(digest)))
        .transpose()?
        .flatten();
    let Some(summary) = model_history::summary_from(id, &state, blob.as_ref(), |id| {
        tx.get::<MessageTable>(&key(id))
    })?
    else {
        return Ok(None);
    };
    let mut after = None;
    let mut ended = None;
    loop {
        let jobs = tx.index::<JobTable>(
            "session_compaction_job_manifest_idx",
            &key(&summary.digest),
            after.as_deref(),
            128,
        )?;
        let Some(last) = jobs.last() else { break };
        after = Some(JobTable::primary_key(last));
        for job in jobs.into_iter().filter(|job| {
            job.session_id == *id.as_lossless() && job.status.as_str() == Some("ended")
        }) {
            if let Some(time) = job.time_ended
                && ended.as_ref().is_none_or(|(_, previous)| time > *previous)
            {
                ended = Some((job.id, time));
            }
        }
    }
    Ok(ended.map(|(job, ended)| Checkpoint {
        through: summary.sequence,
        manifest_digest: summary.digest,
        text: summary.text,
        activated: summary.activated,
        ended,
        job,
        state,
    }))
}

pub(crate) fn validate_target(
    id: &session::Id,
    message: Option<&Message>,
    load: impl FnOnce() -> Result<Option<Checkpoint>, Error>,
) -> Result<Option<Checkpoint>, Error> {
    if message.is_some_and(|message| message.session_id != *id.as_lossless()) {
        return Err(Error::Domain {
            kind: "message_not_found",
            message: "Message not found",
        });
    }
    let checkpoint = load()?;
    if checkpoint
        .as_ref()
        .is_some_and(|checkpoint| message.is_none_or(|message| message.seq <= checkpoint.through))
    {
        return Err(Error::Domain {
            kind: "history_pruned",
            message: "history through the compaction checkpoint was removed",
        });
    }
    if message.is_none() {
        return Err(Error::Domain {
            kind: "message_not_found",
            message: "Message not found",
        });
    }
    Ok(checkpoint)
}

/// First sequence of retained canonical history: past the completed legacy checkpoint and the qualifying summary checkpoint.
pub(crate) fn retained_floor(snapshot: &Snapshot, id: &session::Id) -> Result<Floor, Error> {
    let legacy = super::history::latest_compaction(snapshot, id)?;
    let checkpoint = checkpoint(snapshot, id)?;
    Ok(Floor {
        lower: legacy
            .into_iter()
            .chain(checkpoint.as_ref().map(|checkpoint| checkpoint.through + 1))
            .max()
            .map_or(Bound::Unbounded, Bound::Included),
        checkpoint,
    })
}

fn ended_job(
    snapshot: &Snapshot,
    id: &session::Id,
    digest: &LosslessString,
) -> Result<Option<(LosslessString, i64)>, Error> {
    Ok(ended_jobs(snapshot, id)?
        .into_iter()
        .filter(|(job, _)| job.manifest_digest.as_ref() == Some(digest))
        .max_by_key(|(_, ended)| *ended)
        .map(|(job, ended)| (job.id, ended)))
}

fn ended_jobs(snapshot: &Snapshot, id: &session::Id) -> Result<Vec<(Job, i64)>, Error> {
    let status = LosslessString::from("ended");
    let prefix = tuple_key(&[
        KeyPart::String(&status),
        KeyPart::Null,
        KeyPart::String(id.as_lossless()),
    ]);
    let mut jobs = Vec::new();
    let mut after = None;
    loop {
        let rows = snapshot.index_range::<JobTable>(
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
        let Some(last) = rows.last() else {
            return Ok(jobs);
        };
        after = Some(last.cursor.clone());
        jobs.extend(rows.into_iter().filter_map(|row| {
            let ended = row.record.time_ended?;
            Some((row.record, ended))
        }));
    }
}

const DAY: i64 = 24 * 60 * 60 * 1000;
pub const ERROR_RETENTION: i64 = 7 * DAY;
const SESSION_PAGE: usize = 200;
const MESSAGE_BATCH: usize = 50;
const EVENT_BATCH: usize = 100;
const CONTEXT_OBSERVED: &str = "session.context.observed.1";
const LATEST_TYPES: [&str; 8] = [
    CONTEXT_OBSERVED,
    "session.execution.started.1",
    "session.execution.succeeded.1",
    "session.execution.interrupted.1",
    "session.execution.failed.1",
    "session.step.started.1",
    "session.step.ended.1",
    "session.step.failed.1",
];
const MESSAGE_EVENT_TYPES: [&str; 22] = [
    "session.synthetic.1",
    CONTEXT_OBSERVED,
    "session.skill.activated.1",
    "session.skill.deactivated.1",
    "session.shell.started.1",
    "session.shell.ended.1",
    "session.step.started.1",
    "session.step.ended.1",
    "session.text.started.1",
    "session.text.ended.1",
    "session.reasoning.started.1",
    "session.reasoning.ended.1",
    "session.tool.input.started.1",
    "session.tool.input.ended.1",
    "session.tool.called.1",
    "session.tool.progress.1",
    "session.tool.success.1",
    "session.retry.scheduled.1",
    "session.input.consumed.1",
    "session.execution.started.1",
    "session.execution.succeeded.1",
    "session.execution.interrupted.1",
];
const ERROR_EVENT_TYPES: [&str; 4] = [
    "session.step.failed.1",
    "session.tool.failed.1",
    "session.execution.failed.1",
    "session.compaction.failed.2",
];

#[cfg(unix)]
pub fn free_bytes(directory: &std::path::Path) -> Result<u64, Error> {
    use std::os::unix::ffi::OsStrExt;
    let directory = std::ffi::CString::new(directory.as_os_str().as_bytes())
        .map_err(|_| Error::Rejected("invalid backup directory"))?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    if unsafe { libc::statvfs(directory.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let stats = unsafe { stats.assume_init() };
    Ok(u64::try_from(u128::from(stats.f_bavail) * u128::from(stats.f_frsize)).unwrap_or(u64::MAX))
}

#[cfg(windows)]
pub fn free_bytes(directory: &std::path::Path) -> Result<u64, Error> {
    use std::os::windows::ffi::OsStrExt;
    let directory = directory
        .as_os_str()
        .encode_wide()
        .chain([0])
        .collect::<Vec<_>>();
    let mut available = 0;
    if unsafe {
        windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
            directory.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(available)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Pruned {
    pub messages: usize,
    pub events: usize,
}

#[derive(Debug, Default)]
pub struct Sweep {
    pub pruned: Pruned,
    pub failures: Vec<(session::Id, Error)>,
}

struct Target {
    session: LosslessString,
    digest: LosslessString,
    through: i64,
    boundary: Message,
    job: LosslessString,
    state: ContextState,
}

#[derive(Clone)]
struct EventPlan {
    floor: i64,
    error_floor: i64,
    latest: BTreeSet<i64>,
    messages: BTreeSet<LosslessString>,
    shells: BTreeSet<LosslessString>,
}

impl Service {
    pub async fn prepare_history_pruning(&self, now: i64) -> Result<bool, Error> {
        let client = self.client.clone();
        let status = tokio::task::spawn_blocking(move || client.prepare_pruning(now, free_bytes))
            .await
            .map_err(|_| Error::WriterPanicked)??;
        match status {
            ycoding_store::backup::Status::Ready => Ok(true),
            ycoding_store::backup::Status::Blocked { notice } => {
                if let Some(reason) = notice {
                    tracing::warn!(%reason, "Session history pruning paused: verified backup unavailable");
                }
                Ok(false)
            }
        }
    }

    pub(crate) async fn reclaim_history(&self) -> Result<(), Error> {
        for _ in 0..2 {
            tokio::task::yield_now().await;
            self.client.reclaim()?.await?;
        }
        Ok(())
    }

    pub async fn prune_history<F>(&self, now: i64, active: F) -> Result<Sweep, Error>
    where
        F: Fn() -> Vec<session::Id> + Clone + Send + 'static,
    {
        let mut sweep = Sweep::default();
        let mut after: Option<Vec<u8>> = None;
        loop {
            let page = self.client.snapshot()?.scan::<ContextStateTable>(
                after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                Bound::Unbounded,
                SESSION_PAGE,
            )?;
            let Some(last) = page.last() else {
                return Ok(sweep);
            };
            after = Some(ContextStateTable::primary_key(last));
            for state in page.into_iter().filter(|state| {
                state.status.as_str() == Some("active") && state.manifest_digest.is_some()
            }) {
                let id = session::Id::new(state.session_id)
                    .map_err(|error| Error::Record(Box::new(error)))?;
                match self.prune_compacted(&id, now, active.clone()).await {
                    Ok(pruned) => {
                        sweep.pruned.messages += pruned.messages;
                        sweep.pruned.events += pruned.events;
                    }
                    Err(error) => sweep.failures.push((id, error)),
                }
                tokio::task::yield_now().await;
            }
        }
    }

    pub async fn prune_compacted<F>(
        &self,
        id: &session::Id,
        now: i64,
        active: F,
    ) -> Result<Pruned, Error>
    where
        F: Fn() -> Vec<session::Id> + Clone + Send + 'static,
    {
        let snapshot = self.client.snapshot()?;
        let Some(checkpoint) = checkpoint(&snapshot, id)? else {
            return Ok(Pruned::default());
        };
        let Some(boundary) = ycoding_store::session::messages(
            &snapshot,
            id.as_lossless(),
            Bound::Included(checkpoint.through),
            Bound::Included(checkpoint.through),
            IndexOrder::Ascending,
            None,
            1,
        )?
        .into_iter()
        .next() else {
            return Ok(Pruned::default());
        };
        drop(snapshot);
        if !self.prepare_history_pruning(now).await? {
            return Ok(Pruned::default());
        }
        let target = Arc::new(Target {
            session: id.as_lossless().clone(),
            digest: checkpoint.manifest_digest,
            through: checkpoint.through,
            boundary: boundary.record,
            job: checkpoint.job,
            state: checkpoint.state,
        });
        let messages = self
            .batches(target.clone(), active.clone(), |tx, target, after| {
                let first = first_user(tx, &target.session)?;
                let forks = fork_points(tx, &target.session)?;
                prune_messages(
                    tx,
                    &target.session,
                    target.through,
                    after,
                    MESSAGE_BATCH,
                    |row| {
                        row.type_.as_str() == Some("compaction")
                            || first.as_ref() == Some(&row.id)
                            || forks.contains(&row.id)
                    },
                )
            })
            .await?;
        let plan = Arc::new(event_plan(&self.client.snapshot()?, id, &target, now)?);
        let events = self
            .batches(target, active, move |tx, target, after| {
                let mut plan = (*plan).clone();
                kept_messages(tx, target, &mut plan)?;
                prune_events(
                    tx,
                    &target.session,
                    plan.floor,
                    after,
                    EVENT_BATCH,
                    |event| !deletable(event, &plan),
                )
            })
            .await?;
        if messages > 0 || events > 0 {
            self.reclaim_history().await?;
        }
        Ok(Pruned { messages, events })
    }

    async fn batches<F, S>(&self, target: Arc<Target>, active: F, step: S) -> Result<usize, Error>
    where
        F: Fn() -> Vec<session::Id> + Clone + Send + 'static,
        S: Fn(&mut Write<'_>, &Target, Option<&IndexCursor>) -> Result<PruneBatch, Error>
            + Clone
            + Send
            + 'static,
    {
        let mut deleted = 0;
        let mut after = None;
        loop {
            let (target, active, step, cursor) =
                (target.clone(), active.clone(), step.clone(), after.take());
            let batch = self
                .client
                .submit(move |tx| {
                    if !eligible(tx, &target, &active())? {
                        return Ok(None);
                    }
                    step(tx, &target, cursor.as_ref()).map(Some)
                })?
                .await?;
            let Some(batch) = batch else {
                return Ok(deleted);
            };
            deleted += batch.deleted;
            let Some(next) = batch.next else {
                return Ok(deleted);
            };
            after = Some(next);
            tokio::task::yield_now().await;
        }
    }
}

fn eligible(tx: &mut Write<'_>, target: &Target, active: &[session::Id]) -> Result<bool, Error> {
    if active.iter().any(|id| id.as_lossless() == &target.session) {
        return Ok(false);
    }
    let session_key = key(&target.session);
    if tx
        .get::<SessionTable>(&session_key)?
        .is_none_or(|session| session.revert.is_some())
    {
        return Ok(false);
    }
    if !tx
        .get::<ContextStateTable>(&session_key)?
        .is_some_and(|state| state == target.state)
    {
        return Ok(false);
    }
    if !tx
        .get::<MessageTable>(&key(&target.boundary.id))?
        .is_some_and(|row| {
            row.session_id == target.session
                && row.seq == target.through
                && row.data == target.boundary.data
        })
    {
        return Ok(false);
    }
    if !tx.get::<JobTable>(&key(&target.job))?.is_some_and(|job| {
        job.session_id == target.session
            && job.manifest_digest.as_ref() == Some(&target.digest)
            && job.status.as_str() == Some("ended")
            && job.time_ended.is_some()
    }) {
        return Ok(false);
    }
    for status in ["pending", "running"] {
        if compacting(tx, status, &target.session)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn compacting(tx: &mut Write<'_>, status: &str, session: &LosslessString) -> Result<bool, Error> {
    let prefix = key(&LosslessString::from(status));
    let mut after = None;
    loop {
        let rows = tx.index_range::<JobTable>(
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
        if rows.iter().any(|row| &row.record.session_id == session) {
            return Ok(true);
        }
        let Some(last) = rows.last() else {
            return Ok(false);
        };
        after = Some(last.cursor.clone());
    }
}

fn first_user(
    tx: &mut Write<'_>,
    session: &LosslessString,
) -> Result<Option<LosslessString>, Error> {
    let prefix = tuple_key(&[KeyPart::String(session), KeyPart::String(&"user".into())]);
    Ok(tx
        .index_range::<MessageTable>(
            "session_message_session_type_seq_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Ascending,
                after: None,
                limit: 1,
            },
        )?
        .into_iter()
        .next()
        .map(|row| row.record.id))
}

fn fork_points(
    tx: &mut Write<'_>,
    session: &LosslessString,
) -> Result<BTreeSet<LosslessString>, Error> {
    let mut points = BTreeSet::new();
    let mut after: Option<Vec<u8>> = None;
    loop {
        let page = tx.scan::<SessionTable>(
            after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            SESSION_PAGE,
        )?;
        let Some(last) = page.last() else {
            return Ok(points);
        };
        after = Some(SessionTable::primary_key(last));
        points.extend(
            page.into_iter()
                .filter(|row| row.fork_session_id.as_ref() == Some(session))
                .filter_map(|row| row.fork_message_id),
        );
    }
}

fn event_plan(
    snapshot: &Snapshot,
    id: &session::Id,
    target: &Target,
    now: i64,
) -> Result<EventPlan, Error> {
    let expired = ended_jobs(snapshot, id)?
        .into_iter()
        .filter(|(_, ended)| *ended <= now.saturating_sub(ERROR_RETENTION))
        .filter_map(|(job, _)| job.manifest_digest)
        .map(|digest| {
            Ok(snapshot
                .get::<ManifestTable>(&key(&digest))?
                .and_then(|blob| covered_seq(blob.content.value())))
        })
        .collect::<Result<Vec<_>, Error>>()?
        .into_iter()
        .flatten()
        .max();
    Ok(EventPlan {
        floor: target.through,
        error_floor: target.through.min(expired.unwrap_or(0)),
        latest: latest_events(snapshot, &target.session)?,
        messages: BTreeSet::new(),
        shells: BTreeSet::new(),
    })
}

fn kept_messages(tx: &mut Write<'_>, target: &Target, plan: &mut EventPlan) -> Result<(), Error> {
    let prefix = key(&target.session);
    let upper = tuple_key(&[
        KeyPart::String(&target.session),
        KeyPart::I64(target.through),
    ]);
    let mut after = None;
    loop {
        let rows = tx.index_range::<MessageTable>(
            "session_message_session_seq_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Excluded(&upper),
                prefix: Some(&prefix),
                order: IndexOrder::Ascending,
                after: after.as_ref(),
                limit: 128,
            },
        )?;
        let Some(last) = rows.last() else {
            break;
        };
        after = Some(last.cursor.clone());
        for row in rows {
            if row.record.type_.as_str() == Some("shell")
                && let Some(JsonValue::String(shell)) = field(&row.record.data, "shellID")
            {
                plan.shells.insert(shell.clone());
            }
            plan.messages.insert(row.record.id);
        }
    }
    Ok(())
}

fn latest_events(snapshot: &Snapshot, session: &LosslessString) -> Result<BTreeSet<i64>, Error> {
    let mut latest = BTreeSet::new();
    for type_ in LATEST_TYPES
        .iter()
        .filter(|type_| **type_ != CONTEXT_OBSERVED)
    {
        let prefix = tuple_key(&[KeyPart::String(session), KeyPart::String(&(*type_).into())]);
        latest.extend(
            snapshot
                .index_range::<EventTable>(
                    "event_aggregate_type_seq_idx",
                    IndexQuery {
                        lower: Bound::Unbounded,
                        upper: Bound::Unbounded,
                        prefix: Some(&prefix),
                        order: IndexOrder::Descending,
                        after: None,
                        limit: 1,
                    },
                )?
                .into_iter()
                .map(|row| row.record.seq),
        );
    }
    let prefix = tuple_key(&[
        KeyPart::String(session),
        KeyPart::String(&CONTEXT_OBSERVED.into()),
    ]);
    let mut sources = BTreeMap::new();
    let mut after = None;
    loop {
        let rows = snapshot.index_range::<EventTable>(
            "event_aggregate_type_seq_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Ascending,
                after: after.as_ref(),
                limit: 128,
            },
        )?;
        let Some(last) = rows.last() else {
            latest.extend(sources.into_values());
            return Ok(latest);
        };
        after = Some(last.cursor.clone());
        for row in rows {
            let source = match field(&row.record.data, "source") {
                Some(JsonValue::String(source)) => Some(source.clone()),
                _ => None,
            };
            sources.insert(source, row.record.seq);
        }
    }
}

fn deletable(event: &Event, plan: &EventPlan) -> bool {
    let type_ = event.type_.as_str().unwrap_or_default();
    ((MESSAGE_EVENT_TYPES.contains(&type_) && event.seq < plan.floor)
        || (ERROR_EVENT_TYPES.contains(&type_) && event.seq < plan.error_floor))
        && !plan.latest.contains(&event.seq)
        && !references(event, plan)
}

fn references(event: &Event, plan: &EventPlan) -> bool {
    let names = |name: &str, set: &BTreeSet<LosslessString>| matches!(field(&event.data, name), Some(JsonValue::String(id)) if set.contains(id));
    let projected = event
        .id
        .as_str()
        .and_then(|id| id.get(4..))
        .is_some_and(|suffix| {
            plan.messages
                .contains(&LosslessString::from(format!("msg_{suffix}").as_str()))
        });
    let inputs = matches!(
        field(&event.data, "inputIDs"),
        Some(JsonValue::Array(inputs)) if inputs
            .iter()
            .any(|input| matches!(input, JsonValue::String(id) if plan.messages.contains(id)))
    );
    let shell = matches!(
        field(&event.data, "shell").and_then(|shell| field(shell, "id")),
        Some(JsonValue::String(id)) if plan.shells.contains(id)
    );
    names("assistantMessageID", &plan.messages)
        || names("activationMessageID", &plan.messages)
        || projected
        || inputs
        || shell
}

fn covered_seq(manifest: &JsonValue) -> Option<i64> {
    match field(manifest, "summary")
        .and_then(|summary| field(summary, "coveredThrough"))
        .and_then(|covered| field(covered, "seq"))
    {
        Some(JsonValue::Number(seq)) if *seq >= 0.0 && seq.fract() == 0.0 => Some(*seq as i64),
        _ => None,
    }
}

fn field<'a>(value: &'a JsonValue, name: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(&name.into()),
        _ => None,
    }
}
