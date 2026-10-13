use super::{
    key,
    projector::{append, random_event_id},
    store::Service,
};
use ycoding_schema::{LosslessString, ObjectEncoder, session};
use ycoding_store::{
    Error,
    session::{NewEvent, SessionTable},
};

#[derive(Clone, Debug, PartialEq)]
pub enum Change {
    Archive,
    Unarchive,
    Pin,
    Unpin,
    Rename(LosslessString),
}

impl Service {
    pub async fn change(&self, id: &session::Id, change: Change) -> Result<bool, Error> {
        let event_id = random_event_id()?.as_lossless().clone();
        let created = chrono::Utc::now().timestamp_millis();
        let id = id.clone();
        self.client
            .submit(move |tx| {
                let Some(row) = tx.get::<SessionTable>(&key(id.as_lossless()))? else {
                    return Ok(false);
                };
                let (type_, data) = match &change {
                    Change::Archive if row.time_archived.is_none() => ("session.archived.2", None),
                    Change::Unarchive if row.time_archived.is_some() => {
                        ("session.unarchived.2", None)
                    }
                    Change::Pin if row.time_pinned.is_none() => ("session.pinned.1", None),
                    Change::Unpin if row.time_pinned.is_some() => ("session.unpinned.1", None),
                    Change::Rename(title) => ("session.renamed.1", Some(title)),
                    _ => return Ok(true),
                };
                let encoder = ObjectEncoder::new().field("sessionID", &id);
                append(
                    tx,
                    &NewEvent {
                        id: event_id,
                        aggregate_id: id.as_lossless().clone(),
                        created,
                        type_: type_.into(),
                        data: match data {
                            Some(title) => encoder.field("title", title).finish(),
                            None => encoder.finish(),
                        },
                    },
                )?;
                Ok(true)
            })?
            .await
    }
}
