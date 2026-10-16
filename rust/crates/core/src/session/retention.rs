use super::{key, removal, store::Service};
use crate::resources::config::Configuration;
use std::{collections::BTreeSet, ops::Bound};
use ycoding_schema::{JsonValue, LosslessString, session};
use ycoding_store::{
    Error, IndexOrder, IndexQuery, KeyPart, TableSpec, Write, resources,
    session::{
        ContextStateTable, EventTable, ExclusionTable, InstructionBlobTable, InstructionStateTable,
        JobTable, ManifestTable, PendingTable, RevisionTable, SequenceTable, SessionTable,
        delete_aggregate, manifest_references,
    },
    tuple_key,
};

pub const DEFAULT_DAYS: i64 = 7;
const DAY: i64 = 24 * 60 * 60 * 1000;
const PAGE: usize = 200;
const INSTRUCTION_CHUNK: usize = 500;
const INSTRUCTIONS_UPDATED: &str = "session.instructions.updated.2";

#[derive(Debug, Default)]
pub struct Sweep {
    pub deleted: usize,
    pub failures: Vec<(session::Id, Error)>,
}

#[derive(Debug, Default)]
pub struct Removal {
    pub members: Vec<session::Id>,
    pub instructions: BTreeSet<LosslessString>,
}

pub fn days(configuration: &Configuration) -> i64 {
    let Some(JsonValue::Object(retention)) = configuration.latest("session_retention") else {
        return DEFAULT_DAYS;
    };
    match retention.get(&"days".into()) {
        Some(JsonValue::Number(days)) => *days as i64,
        _ => DEFAULT_DAYS,
    }
}

impl Service {
    pub async fn retain<F>(&self, now: i64, days: i64, active: F) -> Result<Sweep, Error>
    where
        F: Fn() -> Vec<session::Id> + Clone + Send + 'static,
    {
        let cutoff = now.saturating_sub(days.saturating_mul(DAY));
        let mut sweep = Sweep::default();
        let mut instructions = BTreeSet::new();
        for root in self.idle_roots(cutoff)? {
            match self.remove_idle(&root, now, cutoff, active.clone()).await {
                Ok(removal) => {
                    sweep.deleted += removal.members.len();
                    instructions.extend(removal.instructions);
                }
                Err(error) => sweep.failures.push((root, error)),
            }
        }
        if sweep.deleted > 0 {
            self.remove_unreferenced_instructions(instructions).await?;
            self.reclaim_history().await?;
        }
        Ok(sweep)
    }

    pub fn idle_roots(&self, cutoff: i64) -> Result<Vec<session::Id>, Error> {
        let snapshot = self.client.snapshot()?;
        let mut roots = Vec::new();
        let mut after: Option<Vec<u8>> = None;
        loop {
            let page = snapshot.scan::<SessionTable>(
                after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                Bound::Unbounded,
                PAGE,
            )?;
            let Some(last) = page.last() else {
                break;
            };
            after = Some(SessionTable::primary_key(last));
            roots.extend(
                page.into_iter()
                    .filter(|row| row.parent_id.is_none() && row.time_updated < cutoff)
                    .map(|row| (row.time_updated, row.id)),
            );
        }
        roots.sort();
        roots
            .into_iter()
            .map(|(_, id)| session::Id::new(id).map_err(|error| Error::Record(Box::new(error))))
            .collect()
    }

    pub async fn remove_idle<F>(
        &self,
        root: &session::Id,
        now: i64,
        cutoff: i64,
        active: F,
    ) -> Result<Removal, Error>
    where
        F: Fn() -> Vec<session::Id> + Send + 'static,
    {
        if self.get(root)?.is_none() || !self.prepare_history_pruning(now).await? {
            return Ok(Removal::default());
        }
        let root = root.as_lossless().clone();
        let (family, instructions) = self
            .client
            .submit(move |tx| {
                let Some(row) = tx.get::<SessionTable>(&key(&root))? else {
                    return Ok((Vec::new(), BTreeSet::new()));
                };
                if row.parent_id.is_some() {
                    return Ok((Vec::new(), BTreeSet::new()));
                }
                let family = removal::family(tx, &root)?;
                if exempt(tx, &family, cutoff, &active())? {
                    return Ok((Vec::new(), BTreeSet::new()));
                }
                let manifests = manifests(tx, &family)?;
                let states = provider_states(tx, &family)?;
                let instructions = instruction_hashes(tx, &family)?;
                removal::delete(tx, &family, now)?;
                for member in &family {
                    delete_aggregate(tx, member)?;
                }
                for digest in manifests {
                    if manifest_references(tx, &digest)? == 0 {
                        tx.delete::<ManifestTable>(&key(&digest))?;
                    }
                }
                for digest in states {
                    if resources::state_blob_references(tx, &digest)? == 0 {
                        resources::delete_state_blob(tx, &digest)?;
                    }
                }
                Ok((family, instructions))
            })?
            .await?;
        Ok(Removal {
            members: family
                .into_iter()
                .map(|member| {
                    session::Id::new(member).map_err(|error| Error::Record(Box::new(error)))
                })
                .collect::<Result<_, _>>()?,
            instructions,
        })
    }

    async fn remove_unreferenced_instructions(
        &self,
        hashes: BTreeSet<LosslessString>,
    ) -> Result<(), Error> {
        let hashes: Vec<_> = hashes.into_iter().collect();
        for chunk in hashes.chunks(INSTRUCTION_CHUNK) {
            let chunk = chunk.to_vec();
            self.client
                .submit(move |tx| {
                    let referenced = referenced_instructions(tx)?;
                    for hash in chunk.iter().filter(|hash| !referenced.contains(*hash)) {
                        tx.delete::<InstructionBlobTable>(&key(hash))?;
                    }
                    Ok(())
                })?
                .await?;
        }
        Ok(())
    }
}

fn exempt(
    tx: &mut Write<'_>,
    family: &[LosslessString],
    cutoff: i64,
    active: &[session::Id],
) -> Result<bool, Error> {
    let members: BTreeSet<&LosslessString> = family.iter().collect();
    if active.iter().any(|id| members.contains(id.as_lossless())) {
        return Ok(true);
    }
    for member in family {
        let Some(row) = tx.get::<SessionTable>(&key(member))? else {
            return Ok(true);
        };
        if row.time_updated.max(row.time_active.unwrap_or(0)) >= cutoff
            || row.time_pinned.is_some()
            || row.time_suspended.is_some()
            || goal_active(row.autonomy.as_ref())
        {
            return Ok(true);
        }
        if !tx
            .index_range::<PendingTable>(
                "session_pending_session_admitted_seq_idx",
                prefixed(&key(member), 1),
            )?
            .is_empty()
        {
            return Ok(true);
        }
    }
    let mut after: Option<Vec<u8>> = None;
    loop {
        let page = tx.scan::<SessionTable>(
            after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            PAGE,
        )?;
        let Some(last) = page.last() else {
            return Ok(false);
        };
        after = Some(SessionTable::primary_key(last));
        if page.iter().any(|row| {
            row.fork_session_id
                .as_ref()
                .is_some_and(|source| members.contains(source))
                && !members.contains(&row.id)
        }) {
            return Ok(true);
        }
    }
}

fn goal_active(autonomy: Option<&JsonValue>) -> bool {
    let Some(JsonValue::Object(autonomy)) = autonomy else {
        return false;
    };
    let Some(JsonValue::Object(goal)) = autonomy.get(&"goal".into()) else {
        return false;
    };
    goal.get(&"status".into()) == Some(&JsonValue::String("active".into()))
}

fn manifests(
    tx: &mut Write<'_>,
    family: &[LosslessString],
) -> Result<BTreeSet<LosslessString>, Error> {
    let members: BTreeSet<&LosslessString> = family.iter().collect();
    let mut digests = BTreeSet::new();
    for member in family {
        let prefix = key(member);
        digests.extend(
            under::<RevisionTable>(tx, &prefix)?
                .into_iter()
                .filter_map(|row| row.manifest_digest),
        );
        digests.extend(
            under::<ExclusionTable>(tx, &prefix)?
                .into_iter()
                .map(|row| row.manifest_digest),
        );
        digests.extend(
            tx.get::<ContextStateTable>(&prefix)?
                .and_then(|row| row.manifest_digest),
        );
    }
    let mut after: Option<Vec<u8>> = None;
    loop {
        let page = tx.scan::<JobTable>(
            after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            PAGE,
        )?;
        let Some(last) = page.last() else {
            return Ok(digests);
        };
        after = Some(JobTable::primary_key(last));
        digests.extend(
            page.into_iter()
                .filter(|row| members.contains(&row.session_id))
                .filter_map(|row| row.manifest_digest),
        );
    }
}

fn provider_states(
    tx: &mut Write<'_>,
    family: &[LosslessString],
) -> Result<BTreeSet<LosslessString>, Error> {
    let mut digests = BTreeSet::new();
    for member in family {
        digests.extend(
            under::<resources::StateLinkTable>(tx, &key(member))?
                .into_iter()
                .map(|row| row.blob_digest),
        );
    }
    Ok(digests)
}

fn instruction_hashes(
    tx: &mut Write<'_>,
    family: &[LosslessString],
) -> Result<BTreeSet<LosslessString>, Error> {
    let mut hashes = BTreeSet::new();
    for member in family {
        instruction_references(tx, member, &mut hashes)?;
    }
    Ok(hashes)
}

fn referenced_instructions(tx: &mut Write<'_>) -> Result<BTreeSet<LosslessString>, Error> {
    let mut hashes = BTreeSet::new();
    let mut after: Option<Vec<u8>> = None;
    loop {
        let page = tx.scan::<SequenceTable>(
            after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            PAGE,
        )?;
        let Some(last) = page.last() else {
            break;
        };
        after = Some(SequenceTable::primary_key(last));
        for sequence in page {
            event_instructions(tx, &sequence.aggregate_id, &mut hashes)?;
        }
    }
    let mut after: Option<Vec<u8>> = None;
    loop {
        let page = tx.scan::<InstructionStateTable>(
            after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            PAGE,
        )?;
        let Some(last) = page.last() else {
            return Ok(hashes);
        };
        after = Some(InstructionStateTable::primary_key(last));
        for state in page {
            hashes.extend(values(state.initial_values.value()));
            hashes.extend(values(state.current_values.value()));
        }
    }
}

fn instruction_references(
    tx: &mut Write<'_>,
    session: &LosslessString,
    hashes: &mut BTreeSet<LosslessString>,
) -> Result<(), Error> {
    event_instructions(tx, session, hashes)?;
    if let Some(state) = tx.get::<InstructionStateTable>(&key(session))? {
        hashes.extend(values(state.initial_values.value()));
        hashes.extend(values(state.current_values.value()));
    }
    Ok(())
}

fn event_instructions(
    tx: &mut Write<'_>,
    aggregate: &LosslessString,
    hashes: &mut BTreeSet<LosslessString>,
) -> Result<(), Error> {
    let prefix = tuple_key(&[
        KeyPart::String(aggregate),
        KeyPart::String(&INSTRUCTIONS_UPDATED.into()),
    ]);
    let mut after = None;
    loop {
        let page = tx.index_range::<EventTable>(
            "event_aggregate_type_seq_idx",
            IndexQuery {
                after: after.as_ref(),
                ..prefixed(&prefix, PAGE)
            },
        )?;
        let Some(last) = page.last() else {
            return Ok(());
        };
        after = Some(last.cursor.clone());
        for entry in page {
            if let JsonValue::Object(data) = &entry.record.data
                && let Some(delta) = data.get(&"delta".into())
            {
                hashes.extend(values(delta).filter(|hash| hash.as_str() != Some("removed")));
            }
        }
    }
}

fn values(value: &JsonValue) -> impl Iterator<Item = LosslessString> + '_ {
    let entries = match value {
        JsonValue::Object(entries) => Some(entries.iter()),
        _ => None,
    };
    entries
        .into_iter()
        .flatten()
        .filter_map(|(_, value)| match value {
            JsonValue::String(hash) => Some(hash.clone()),
            _ => None,
        })
}

fn under<T: TableSpec>(tx: &mut Write<'_>, prefix: &[u8]) -> Result<Vec<T::Record>, Error> {
    let mut upper = prefix.to_vec();
    while upper.last() == Some(&u8::MAX) {
        upper.pop();
    }
    let Some(last) = upper.last_mut() else {
        return Err(Error::Rejected("cascade requires a bounded tuple prefix"));
    };
    *last += 1;
    tx.scan::<T>(Bound::Included(prefix), Bound::Excluded(&upper), usize::MAX)
}

fn prefixed(prefix: &[u8], limit: usize) -> IndexQuery<'_> {
    IndexQuery {
        lower: Bound::Unbounded,
        upper: Bound::Unbounded,
        prefix: Some(prefix),
        order: IndexOrder::Ascending,
        after: None,
        limit,
    }
}
