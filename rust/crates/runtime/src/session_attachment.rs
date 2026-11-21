use crate::{
    convert,
    dispatch::{Failure, Invocation},
};
use ycoding_core::session::attachment_read::ReadError;
use ycoding_protocol::{Asset, v5};

pub async fn read(
    invocation: Invocation,
    request: v5::SessionAttachmentReadRequest,
) -> Result<Asset<v5::SessionAttachmentReadResult>, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let digest = convert::domain(&request.params.digest)?;
    let attachments = core
        .attachments
        .clone()
        .ok_or_else(|| Failure::Unavailable("Managed attachments are unavailable".into()))?;
    let sessions = core.sessions.clone();
    let session = id.clone();
    let read = tokio::task::spawn_blocking(move || {
        sessions.attachment_read(&attachments, &session, &digest)
    })
    .await
    .map_err(|error| Failure::Unavailable(error.to_string()))?
    .map_err(|error| match error {
        ReadError::InvalidDigest => Failure::Invalid("Invalid attachment digest".into()),
        ReadError::SessionNotFound => Failure::SessionNotFound(convert::readable(id.as_lossless())),
        ReadError::NotFound => Failure::AttachmentNotFound,
        ReadError::TooLarge => Failure::AttachmentTooLarge,
        ReadError::Store(_) => Failure::Unavailable("Session store unavailable".into()),
    })?;
    Asset::new(
        v5::SessionAttachmentReadResult {
            data: v5::SessionAssetMetadata {
                mime: convert::wire(&read.mime),
                bytes: read.bytes.len() as u64,
            },
        },
        read.bytes,
    )
    .map_err(|error| Failure::Invalid(error.to_string()))
}
