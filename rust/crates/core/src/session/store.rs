use super::{info, key};
use ycoding_schema::{ObjectEncoder, session, session_message};
use ycoding_store::{
    Client, Error,
    session::{MessageTable, NewEvent, SessionTable},
};

#[derive(Clone)]
pub struct Service {
    pub(crate) client: Client,
    artifact_source: Option<crate::resources::project_artifact::source::Service>,
}

impl Service {
    pub fn new(client: Client) -> Self {
        Self {
            client,
            artifact_source: None,
        }
    }

    pub fn with_artifact_source(
        mut self,
        source: crate::resources::project_artifact::source::Service,
    ) -> Self {
        self.artifact_source = Some(source);
        self
    }

    pub fn artifact_source(&self) -> Option<&crate::resources::project_artifact::source::Service> {
        self.artifact_source.as_ref()
    }

    pub fn get(&self, id: &session::Id) -> Result<Option<session::Info>, Error> {
        self.client
            .snapshot()?
            .get::<SessionTable>(&key(id.as_lossless()))?
            .as_ref()
            .map(info::from_row)
            .transpose()
    }

    pub fn message(
        &self,
        id: &session_message::Id,
    ) -> Result<Option<(session::Id, session_message::Info)>, Error> {
        self.client
            .snapshot()?
            .get::<MessageTable>(&key(id.as_lossless()))?
            .map(|row| {
                let message = row.info()?;
                Ok((
                    session::Id::new(row.session_id)
                        .map_err(|error| Error::Record(Box::new(error)))?,
                    message,
                ))
            })
            .transpose()
    }

    pub async fn delete_message(
        &self,
        id: &session::Id,
        message_id: &session_message::Id,
        now: i64,
    ) -> Result<(), Error> {
        let id = id.clone();
        let message_id = message_id.clone();
        self.client
            .submit(move |tx| {
                if tx.get::<SessionTable>(&key(id.as_lossless()))?.is_none() {
                    return Err(Error::Domain {
                        kind: "not_found",
                        message: "Session not found",
                    });
                }
                let row = tx
                    .get::<MessageTable>(&key(message_id.as_lossless()))?
                    .filter(|row| row.session_id == *id.as_lossless())
                    .ok_or(Error::Domain {
                        kind: "message_not_found",
                        message: "This message is no longer available.",
                    })?;
                let not_owned = Error::Domain {
                    kind: "message_not_owned",
                    message: "You can only delete your own messages.",
                };
                let session_message::Info::User(user) = row.info()? else {
                    return Err(not_owned);
                };
                if super::pending::input_origin(user.metadata.as_ref()) != Some("direct") {
                    return Err(not_owned);
                }
                if user.time.consumed.is_some() {
                    return Err(Error::Domain {
                        kind: "message_read",
                        message: "YCoding has already read this message.",
                    });
                }
                super::projector::append(
                    tx,
                    &NewEvent {
                        id: super::projector::random_event_id()?.as_lossless().clone(),
                        aggregate_id: id.as_lossless().clone(),
                        created: now,
                        type_: "session.input.deleted.1".into(),
                        data: ObjectEncoder::new()
                            .field("sessionID", &id)
                            .field("inputID", &message_id)
                            .finish(),
                    },
                )?;
                Ok(())
            })?
            .await
    }

    pub fn profile_binding(
        &self,
        id: &session::Id,
    ) -> Result<Option<ycoding_schema::session_event::ProfileBinding>, Error> {
        self.client
            .snapshot()?
            .get::<SessionTable>(&key(id.as_lossless()))?
            .and_then(|row| row.profile_binding)
            .map(|binding| binding.domain())
            .transpose()
    }

    pub async fn consume_suspended(&self, id: &session::Id) -> Result<bool, Error> {
        let id = id.as_lossless().clone();
        self.client
            .submit(move |tx| {
                let Some(mut row) = tx.get::<SessionTable>(&key(&id))? else {
                    return Ok(false);
                };
                if row.time_suspended.take().is_none() {
                    return Ok(false);
                }
                SessionTable::put(tx, &row)?;
                Ok(true)
            })?
            .await
    }

    pub async fn suspend(&self, ids: &[session::Id], now: i64) -> Result<(), Error> {
        let ids = ids.to_vec();
        self.client
            .submit(move |tx| {
                for id in ids {
                    if let Some(mut row) = tx.get::<SessionTable>(&key(id.as_lossless()))?
                        && row.time_suspended.is_none()
                    {
                        row.time_suspended = Some(now);
                        SessionTable::put(tx, &row)?;
                    }
                }
                Ok(())
            })?
            .await
    }
}
