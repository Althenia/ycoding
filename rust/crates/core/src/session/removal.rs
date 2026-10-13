use super::{
    key,
    projector::{append, random_event_id},
    store::Service,
};
use std::{collections::BTreeSet, ops::Bound};
use ycoding_schema::{LosslessString, ObjectEncoder, session};
use ycoding_store::{
    Error, IndexOrder, IndexQuery, Write,
    session::{NewEvent, SessionTable},
};

const PAGE: usize = 128;

impl Service {
    pub async fn remove(&self, id: &session::Id) -> Result<Vec<session::Id>, Error> {
        let id = id.as_lossless().clone();
        let created = chrono::Utc::now().timestamp_millis();
        let family = self
            .client
            .submit(move |tx| {
                if tx.get::<SessionTable>(&key(&id))?.is_none() {
                    return Ok(Vec::new());
                }
                let family = family(tx, &id)?;
                delete(tx, &family, created)?;
                Ok(family)
            })?
            .await?;
        family
            .into_iter()
            .map(|member| session::Id::new(member).map_err(|error| Error::Record(Box::new(error))))
            .collect()
    }
}

pub(super) fn delete(
    tx: &mut Write<'_>,
    family: &[LosslessString],
    created: i64,
) -> Result<(), Error> {
    for member in family {
        append(
            tx,
            &NewEvent {
                id: random_event_id()?.as_lossless().clone(),
                aggregate_id: member.clone(),
                created,
                type_: "session.deleted.2".into(),
                data: ObjectEncoder::new().field("sessionID", member).finish(),
            },
        )?;
    }
    Ok(())
}

pub(super) fn family(
    tx: &mut Write<'_>,
    id: &LosslessString,
) -> Result<Vec<LosslessString>, Error> {
    let mut ordered = vec![id.clone()];
    let mut seen = BTreeSet::from([id.clone()]);
    let mut cursor = 0;
    while cursor < ordered.len() {
        let prefix = key(&ordered[cursor]);
        let mut after = None;
        loop {
            let page = tx.index_range::<SessionTable>(
                "session_parent_idx",
                IndexQuery {
                    lower: Bound::Unbounded,
                    upper: Bound::Unbounded,
                    prefix: Some(&prefix),
                    order: IndexOrder::Ascending,
                    after: after.as_ref(),
                    limit: PAGE,
                },
            )?;
            if page.is_empty() {
                break;
            }
            after = page.last().map(|entry| entry.cursor.clone());
            for entry in page {
                if seen.insert(entry.record.id.clone()) {
                    ordered.push(entry.record.id);
                }
            }
        }
        cursor += 1;
    }
    ordered.reverse();
    Ok(ordered)
}
