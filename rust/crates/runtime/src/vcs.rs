use crate::{
    convert,
    dispatch::{Failure, Invocation},
    platform_services,
};
use ycoding_core::{platform::git::vcs, ycoding_schema::file_diff::Status};
use ycoding_protocol::v5;

pub async fn branch(
    invocation: Invocation,
    request: v5::VcsBranchRequest,
) -> Result<v5::VcsBranchResult, Failure> {
    let q = request.query.location.as_ref();
    let (location, services) = platform_services::resolve(
        &invocation,
        q.and_then(|q| q.directory.as_ref()),
        q.and_then(|q| q.workspace.as_ref()),
    )?;
    let result = tokio::task::spawn_blocking(move || {
        vcs::branch(&services.git, services.filesystem.directory())
    })
    .await
    .map_err(|error| Failure::Unavailable(error.to_string()))?;
    Ok(v5::VcsBranchResult {
        location: convert::location_info(&location),
        data: v5::VcsBranch {
            current: result.current.as_deref().map(convert::text),
            default: result.default.as_deref().map(convert::text),
        },
    })
}

pub async fn status(
    invocation: Invocation,
    request: v5::VcsStatusRequest,
) -> Result<v5::VcsStatusResult, Failure> {
    let q = request.query.location.as_ref();
    let (location, services) = platform_services::resolve(
        &invocation,
        q.and_then(|q| q.directory.as_ref()),
        q.and_then(|q| q.workspace.as_ref()),
    )?;
    let result = tokio::task::spawn_blocking(move || {
        vcs::status(&services.git, services.filesystem.directory())
    })
    .await
    .map_err(|error| Failure::Unavailable(error.to_string()))?;
    Ok(v5::VcsStatusResult {
        location: convert::location_info(&location),
        data: v5::VcsStatusResultData {
            items: result
                .iter()
                .map(|item| v5::VcsFileStatus {
                    file: convert::text(&item.file),
                    additions: item.additions,
                    deletions: item.deletions,
                    status: match item.status {
                        Status::Added => v5::VcsFileStatusStatus::VcsFilestatusStatusAdded,
                        Status::Deleted => v5::VcsFileStatusStatus::VcsFilestatusStatusDeleted,
                        Status::Modified => v5::VcsFileStatusStatus::VcsFilestatusStatusModified,
                    } as i32,
                })
                .collect(),
        },
    })
}

pub async fn diff(
    invocation: Invocation,
    request: v5::VcsDiffRequest,
) -> Result<v5::VcsDiffResult, Failure> {
    let q = request.query.location.as_ref();
    let (location, services) = platform_services::resolve(
        &invocation,
        q.and_then(|q| q.directory.as_ref()),
        q.and_then(|q| q.workspace.as_ref()),
    )?;
    let mode = v5::VcsMode::try_from(request.query.mode)
        .map_err(|_| Failure::Invalid("Invalid diff mode".into()))?;
    let result = tokio::task::spawn_blocking(move || {
        vcs::diff(
            &services.git,
            services.filesystem.directory(),
            mode == v5::VcsMode::Branch,
            request.query.context,
        )
    })
    .await
    .map_err(|error| Failure::Unavailable(error.to_string()))?;
    Ok(v5::VcsDiffResult {
        location: convert::location_info(&location),
        data: v5::VcsDiffResultData {
            items: result.iter().map(convert::file_diff_info).collect(),
        },
    })
}
