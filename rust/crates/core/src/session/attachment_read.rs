use super::store::Service;
use crate::resources::attachment_store;
use std::ops::Bound;
use ycoding_schema::{
    LosslessString, prompt::FileAttachment, session, session_message, session_pending,
};
use ycoding_store::{Error, IndexOrder, IndexQuery, KeyPart, session::MessageTable, tuple_key};

pub const MAX_READ_BYTES: i64 = 10 * 1024 * 1024;

pub struct Read {
    pub mime: LosslessString,
    pub bytes: Vec<u8>,
}

#[derive(Debug)]
pub enum ReadError {
    InvalidDigest,
    SessionNotFound,
    NotFound,
    TooLarge,
    Store(Error),
}

impl Service {
    pub fn attachment_read(
        &self,
        attachments: &attachment_store::Store,
        id: &session::Id,
        digest: &LosslessString,
    ) -> Result<Read, ReadError> {
        if !digest.as_str().is_some_and(|digest| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        }) {
            return Err(ReadError::InvalidDigest);
        }
        self.get(id)
            .map_err(ReadError::Store)?
            .ok_or(ReadError::SessionNotFound)?;
        let file = self
            .attachment(id, digest)
            .map_err(ReadError::Store)?
            .ok_or(ReadError::NotFound)?;
        if file.content.bytes.get() > MAX_READ_BYTES {
            return Err(ReadError::TooLarge);
        }
        let bytes = attachments.read(&file.content).map_err(|error| {
            tracing::warn!(reason = %error, "Managed Session attachment unavailable");
            ReadError::NotFound
        })?;
        Ok(Read {
            mime: file.mime,
            bytes,
        })
    }

    fn attachment(
        &self,
        id: &session::Id,
        digest: &LosslessString,
    ) -> Result<Option<FileAttachment>, Error> {
        let matching = |files: Option<Vec<FileAttachment>>| {
            files
                .into_iter()
                .flatten()
                .find(|file| file.content.digest.0 == *digest)
        };
        let snapshot = self.client.snapshot()?;
        let prefix = tuple_key(&[
            KeyPart::String(id.as_lossless()),
            KeyPart::String(&"user".into()),
        ]);
        let mut after = None;
        loop {
            let rows = snapshot.index_range::<MessageTable>(
                "session_message_session_type_seq_idx",
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
                break;
            };
            after = Some(last.cursor.clone());
            for row in &rows {
                if let session_message::Info::User(user) = row.record.info()?
                    && let Some(file) = matching(user.files)
                {
                    return Ok(Some(file));
                }
            }
        }
        for row in self.pending_list(id)? {
            if let session_pending::LegacyInfo::User(user) = row.info()?
                && let Some(file) = matching(user.data.files)
            {
                return Ok(Some(file));
            }
        }
        Ok(None)
    }
}
