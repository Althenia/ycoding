use super::{history::Entry, key, model_history};
use std::ops::Bound;
use ycoding_schema::{JsonObject, JsonValue, LosslessString, session, session_message};
use ycoding_store::{
    Error, IndexOrder, IndexQuery, KeyPart, Snapshot,
    session::{ContextState, ContextStateTable, JobTable},
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
    let status = LosslessString::from("ended");
    let prefix = tuple_key(&[
        KeyPart::String(&status),
        KeyPart::Null,
        KeyPart::String(id.as_lossless()),
    ]);
    let mut newest: Option<(LosslessString, i64)> = None;
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
            return Ok(newest);
        };
        after = Some(last.cursor.clone());
        for row in rows {
            let job = row.record;
            let Some(ended) = job.time_ended else {
                continue;
            };
            if job.manifest_digest.as_ref() == Some(digest)
                && newest.as_ref().is_none_or(|(_, newest)| ended > *newest)
            {
                newest = Some((job.id, ended));
            }
        }
    }
}
