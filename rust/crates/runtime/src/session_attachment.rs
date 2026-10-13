use crate::{
    convert,
    dispatch::{Failure, Invocation},
};
use ycoding_core::{resources::attachment_store, session::attachment_read::ReadError};
use ycoding_protocol::{Asset, v5};

pub async fn read(
    invocation: Invocation,
    request: v5::SessionAttachmentReadRequest,
) -> Result<Asset<v5::SessionAttachmentReadResult>, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let digest = convert::domain(&request.params.digest)?;
    let (info, _lease) = core.locations.session(&id)?;
    let platform =
        core.platform.as_ref().ok_or_else(|| {
            Failure::Unavailable("Location platform resolver is not composed".into())
        })?(&info.location)
        .map_err(Failure::Unavailable)?;
    let attachments = attachment_store::Store::new(platform.config.roots().data.clone())
        .map_err(|_| Failure::Unavailable("Managed attachments are unavailable".into()))?;
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
