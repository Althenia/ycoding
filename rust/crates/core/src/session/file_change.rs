use super::{key, projector::record_error, store::Service};
use std::ops::Bound;
use ycoding_schema::{LosslessString, ObjectDecoder, schema::NonNegativeInt, session};
use ycoding_store::{
    Error, IndexOrder, IndexQuery, KeyPart, Write,
    session::{Event, FileChange, FileChangeTable, SessionTable, TaskTable},
    tuple_key,
};

impl Service {
    pub fn file_changes(&self, id: &session::Id) -> Result<Vec<FileChange>, Error> {
        let snapshot = self.client.snapshot()?;
        snapshot
            .get::<SessionTable>(&key(id.as_lossless()))?
            .ok_or(Error::Domain {
                kind: "not_found",
                message: "Session not found",
            })?;
        let mut after = None;
        let mut changes = Vec::new();
        loop {
            let page = snapshot.index_range::<FileChangeTable>(
                "session_file_change_path_session_idx",
                IndexQuery {
                    lower: Bound::Unbounded,
                    upper: Bound::Unbounded,
                    prefix: None,
                    order: IndexOrder::Ascending,
                    after: after.as_ref(),
                    limit: 128,
                },
            )?;
            if page.is_empty() {
                return Ok(changes);
            }
            after = page.last().map(|entry| entry.cursor.clone());
            for entry in page {
                let row = entry.record;
                if &row.session_id == id.as_lossless()
                    || snapshot
                        .get::<TaskTable>(&key(&row.session_id))?
                        .is_some_and(|task| {
                            &task.parent_id == id.as_lossless()
                                && task.state.as_str() == Some("completed")
                        })
                {
                    changes.push(row);
                }
            }
        }
    }
}

pub(crate) fn apply(
    tx: &mut Write<'_>,
    event: &Event,
    object: &ObjectDecoder<'_>,
) -> Result<(), Error> {
    let change = object
        .field::<ycoding_schema::JsonValue>("change")
        .map_err(record_error)?;
    let path = ycoding_schema::JsonPath::default();
    let change = ObjectDecoder::new(&change, &path).map_err(record_error)?;
    let path: LosslessString = change.field("path").map_err(record_error)?;
    let previous = tx.get::<FileChangeTable>(&tuple_key(&[
        KeyPart::String(&event.aggregate_id),
        KeyPart::String(&path),
    ]))?;
    FileChangeTable::put(
        tx,
        &FileChange {
            session_id: event.aggregate_id.clone(),
            path,
            patch: change.field("patch").map_err(record_error)?,
            additions: previous.as_ref().map_or(0, |row| row.additions)
                + change
                    .field::<NonNegativeInt>("additions")
                    .map_err(record_error)?
                    .get(),
            deletions: previous.as_ref().map_or(0, |row| row.deletions)
                + change
                    .field::<NonNegativeInt>("deletions")
                    .map_err(record_error)?
                    .get(),
            latest_seq: event.seq,
        },
    )
}
