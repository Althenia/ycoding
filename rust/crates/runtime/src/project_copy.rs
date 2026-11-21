use crate::{
    convert,
    dispatch::{Failure, Invocation},
    platform_services,
};
use std::path::PathBuf;
use ycoding_core::ycoding_schema::{project_id::ProjectId, schema::AbsolutePath};
use ycoding_protocol::v5;

fn failure(error: ycoding_core::platform::git::Error) -> Failure {
    Failure::ProjectCopy {
        message: error.message,
        force_required: error.force_required,
    }
}
fn path(value: &v5::LosslessString) -> Result<PathBuf, Failure> {
    convert::identifier::<AbsolutePath>(value)?
        .as_lossless()
        .to_utf8()
        .map(PathBuf::from)
        .map_err(|error| Failure::Invalid(error.to_string()))
}

pub async fn create(
    invocation: Invocation,
    request: v5::ProjectCopyCreateRequest,
) -> Result<v5::ProjectCopyCreateResult, Failure> {
    let q = request.query.location.as_ref();
    let (location, services) = platform_services::resolve(
        &invocation,
        q.and_then(|q| q.directory.as_ref()),
        q.and_then(|q| q.workspace.as_ref()),
    )?;
    let project: ProjectId = convert::identifier(&request.params.project_id)?;
    let directory = services
        .copies
        .create(
            project.as_lossless().clone(),
            PathBuf::from(convert::readable(location.project.directory.as_lossless())),
            path(&request.payload.directory)?,
            request
                .payload
                .name
                .as_ref()
                .map(convert::domain)
                .transpose()?
                .map(|value| value.to_utf8())
                .transpose()
                .map_err(|error| Failure::Invalid(error.to_string()))?,
            convert::domain(&request.payload.strategy)?
                .to_utf8()
                .map_err(|error| Failure::Invalid(error.to_string()))?
                .trim()
                .to_owned(),
        )
        .await
        .map_err(failure)?;
    Ok(v5::ProjectCopyCreateResult {
        data: v5::ProjectCopyCopy {
            directory: convert::text(&directory.to_string_lossy()),
        },
    })
}

pub async fn remove(
    invocation: Invocation,
    request: v5::ProjectCopyRemoveRequest,
) -> Result<v5::ProjectCopyRemoveResult, Failure> {
    let q = request.query.location.as_ref();
    let (_, services) = platform_services::resolve(
        &invocation,
        q.and_then(|q| q.directory.as_ref()),
        q.and_then(|q| q.workspace.as_ref()),
    )?;
    let project: ProjectId = convert::identifier(&request.params.project_id)?;
    services
        .copies
        .remove(
            project.as_lossless().clone(),
            path(&request.payload.directory)?,
            request.payload.force,
        )
        .await
        .map_err(failure)?;
    Ok(v5::ProjectCopyRemoveResult { data: v5::Empty {} })
}

pub async fn refresh(
    invocation: Invocation,
    request: v5::ProjectCopyRefreshRequest,
) -> Result<v5::ProjectCopyRefreshResult, Failure> {
    let q = request.query.location.as_ref();
    let (_, services) = platform_services::resolve(
        &invocation,
        q.and_then(|q| q.directory.as_ref()),
        q.and_then(|q| q.workspace.as_ref()),
    )?;
    let project: ProjectId = convert::identifier(&request.params.project_id)?;
    services
        .copies
        .refresh(project.as_lossless().clone())
        .await
        .map_err(failure)?;
    Ok(v5::ProjectCopyRefreshResult { data: v5::Empty {} })
}
