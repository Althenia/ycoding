use crate::{
    convert,
    dispatch::{Failure, Invocation},
    ids,
};
use ycoding_core::session::revert;
use ycoding_core::ycoding_schema::{DomainEncode, session, session_message};
use ycoding_protocol::v5;

pub async fn stage(
    invocation: Invocation,
    request: v5::SessionRevertStageRequest,
) -> Result<v5::SessionRevertStageResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let (info, services) = core.locations.session(&id)?;
    let message = convert::identifier::<session_message::Id>(&request.payload.message_id)?;
    let files = request.payload.files.unwrap_or(true);
    let sessions = core.sessions.clone();
    let execution = core.execution;
    let handle = tokio::runtime::Handle::current();
    let staged = {
        let id = id.clone();
        tokio::task::spawn_blocking(move || {
            let snapshots = services.snapshots(&info);
            handle.block_on(revert::stage_idle(
                &sessions,
                execution,
                &snapshots,
                &id,
                &message,
                files,
                ids::now_millis(),
            ))
        })
        .await
        .map_err(|_| Failure::Unavailable("Session revert unavailable".into()))?
    };
    let staged = staged.map_err(|error| failure(error, &id))?;
    Ok(v5::SessionRevertStageResult {
        data: convert::revert(&staged.encode()).map_err(|_| {
            Failure::Unavailable("staged revert is not representable on the wire".into())
        })?,
    })
}

pub async fn clear(
    invocation: Invocation,
    request: v5::SessionRevertClearRequest,
) -> Result<v5::SessionRevertClearResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let (info, services) = core.locations.session(&id)?;
    let sessions = core.sessions.clone();
    let execution = core.execution;
    let handle = tokio::runtime::Handle::current();
    let cleared = {
        let id = id.clone();
        tokio::task::spawn_blocking(move || {
            let snapshots = services.snapshots(&info);
            handle.block_on(revert::clear_idle(
                &sessions,
                execution,
                &snapshots,
                &id,
                ids::now_millis(),
            ))
        })
        .await
        .map_err(|_| Failure::Unavailable("Session revert unavailable".into()))?
    };
    cleared.map_err(|error| failure(error, &id))?;
    Ok(v5::SessionRevertClearResult { data: v5::Empty {} })
}

pub fn failure(error: revert::Error, id: &session::Id) -> Failure {
    match error {
        revert::Error::SessionNotFound { .. } => {
            Failure::SessionNotFound(convert::readable(id.as_lossless()))
        }
        revert::Error::MessageNotFound { message_id, .. } => Failure::MessageNotFound {
            session: convert::readable(id.as_lossless()),
            message: convert::readable(message_id.as_lossless()),
        },
        revert::Error::HistoryPruned { message_id, .. } => Failure::HistoryPruned {
            session: id.as_lossless().clone(),
            message: message_id.as_lossless().clone(),
        },
        revert::Error::Busy { .. } => Failure::SessionBusy(convert::readable(id.as_lossless())),
        _ => Failure::Unavailable("Session revert unavailable".into()),
    }
}
