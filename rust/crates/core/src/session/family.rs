use super::key;
use std::collections::BTreeSet;
use ycoding_schema::LosslessString;
use ycoding_store::{
    Error, IndexCursor, IndexEntry, IndexOrder, IndexQuery, Snapshot, Write,
    session::{Session, SessionTable},
};

const PAGE: usize = 128;

pub enum Reader<'a, 'b> {
    Snapshot(&'a Snapshot),
    Transaction(&'a mut Write<'b>),
}

impl Reader<'_, '_> {
    fn session(&mut self, id: &LosslessString) -> Result<Option<Session>, Error> {
        match self {
            Self::Snapshot(snapshot) => snapshot.get::<SessionTable>(&key(id)),
            Self::Transaction(tx) => tx.get::<SessionTable>(&key(id)),
        }
    }

    fn children(
        &mut self,
        parent: &LosslessString,
        after: Option<&IndexCursor>,
    ) -> Result<Vec<IndexEntry<Session>>, Error> {
        let prefix = key(parent);
        let query = IndexQuery {
            lower: std::ops::Bound::Unbounded,
            upper: std::ops::Bound::Unbounded,
            prefix: Some(&prefix),
            order: IndexOrder::Ascending,
            after,
            limit: PAGE,
        };
        match self {
            Self::Snapshot(snapshot) => {
                snapshot.index_range::<SessionTable>("session_parent_idx", query)
            }
            Self::Transaction(tx) => tx.index_range::<SessionTable>("session_parent_idx", query),
        }
    }
}

pub fn root(
    read: &mut Reader<'_, '_>,
    id: &LosslessString,
) -> Result<Option<LosslessString>, Error> {
    let Some(mut current) = read.session(id)? else {
        return Ok(None);
    };
    let mut seen = BTreeSet::from([current.id.clone()]);
    while let Some(parent) = current.parent_id.take().filter(|parent| !parent.is_empty()) {
        if !seen.insert(parent.clone()) {
            return Err(Error::Domain {
                kind: "session_parent_cycle",
                message: "Session parent chain contains a cycle",
            });
        }
        current = read.session(&parent)?.ok_or(Error::Domain {
            kind: "not_found",
            message: "Session parent not found",
        })?;
    }
    Ok(Some(current.id))
}

pub fn members(
    read: &mut Reader<'_, '_>,
    root: &LosslessString,
) -> Result<Vec<LosslessString>, Error> {
    if read.session(root)?.is_none() {
        return Ok(Vec::new());
    }
    let mut ordered = vec![root.clone()];
    let mut seen = BTreeSet::from([root.clone()]);
    let mut cursor = 0;
    while cursor < ordered.len() {
        let parent = ordered[cursor].clone();
        let mut after = None;
        loop {
            let page = read.children(&parent, after.as_ref())?;
            let Some(last) = page.last() else {
                break;
            };
            after = Some(last.cursor.clone());
            for entry in page {
                if seen.insert(entry.record.id.clone()) {
                    ordered.push(entry.record.id);
                }
            }
        }
        cursor += 1;
    }
    Ok(ordered)
}
