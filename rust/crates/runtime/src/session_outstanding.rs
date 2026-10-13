use crate::{
    convert,
    dispatch::{Failure, Invocation},
};
use ycoding_core::session::outstanding;
use ycoding_protocol::v5;

pub async fn read(
    invocation: Invocation,
    request: v5::SessionOutstandingRequest,
) -> Result<v5::SessionOutstandingResult, Failure> {
    let core = invocation.core()?;
    let active = core.execution.active();
    let sessions = core.sessions.clone();
    let orchestration = core.orchestration.clone();
    let jobs = core.execution.jobs().clone();
    let failures = request.query.failures.unwrap_or(false);
    let found = tokio::task::spawn_blocking(move || {
        outstanding::read(&sessions, &orchestration, &jobs, &active, failures)
    })
    .await
    .map_err(|_| Failure::Unavailable("Session outstanding work unavailable".into()))?
    .map_err(|_| Failure::Unavailable("Session store unavailable".into()))?;
    let items = |ids: &std::collections::BTreeSet<_>| ids.iter().map(convert::wire).collect();
    Ok(v5::SessionOutstandingResult {
        data: v5::SessionOutstandingResultData {
            items: items(&found.sessions),
        },
        running: v5::SessionOutstandingResultRunning {
            items: items(&found.running),
        },
        failed: v5::SessionOutstandingResultFailed {
            items: items(&found.failed),
        },
        lost: v5::SessionOutstandingResultLost {
            items: items(&found.lost),
        },
    })
}
