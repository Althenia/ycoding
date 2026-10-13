use super::{info, key};
use ycoding_schema::{session, session_message};
use ycoding_store::{
    Client, Error,
    session::{MessageTable, SessionTable},
};

#[derive(Clone)]
pub struct Service {
    pub(crate) client: Client,
}

impl Service {
    pub fn new(client: Client) -> Self {
        Self { client }
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
