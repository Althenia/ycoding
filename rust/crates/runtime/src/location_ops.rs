use crate::{
    convert,
    dispatch::{Failure, Invocation},
};
use std::path::Path;
use ycoding_protocol::v5;

pub async fn get(
    invocation: Invocation,
    request: v5::LocationGetRequest,
) -> Result<v5::LocationGetResult, Failure> {
    let location = invocation.location_info(request.query.location.as_ref())?;
    let roots = invocation
        .core()?
        .roots
        .as_ref()
        .ok_or_else(|| Failure::Unavailable("Backend paths are not composed".into()))?;
    invocation.core()?.locations.record(&location, true).await?;
    Ok(v5::LocationGetResult {
        data: v5::LocationInfo {
            backend_paths: Some(v5::BackendPaths {
                home: backend_path(&roots.home)?,
                state: backend_path(&roots.state)?,
                worktree: backend_path(&roots.data.join("worktree"))?,
                config: backend_path(&roots.config)?,
            }),
            ..convert::location_info(&location)
        },
    })
}

pub async fn list(
    invocation: Invocation,
    _: v5::DebugLocationRequest,
) -> Result<v5::DebugLocationResult, Failure> {
    Ok(v5::DebugLocationResult {
        items: invocation
            .core()?
            .locations
            .cached()
            .iter()
            .map(|(directory, workspace)| v5::LocationRef {
                directory: convert::wire(directory),
                workspace_id: workspace.as_ref().map(convert::wire),
            })
            .collect(),
    })
}

pub async fn evict(
    invocation: Invocation,
    request: v5::DebugLocationEvictRequest,
) -> Result<v5::DebugLocationEvictResult, Failure> {
    let core = invocation.core()?;
    let (directory, workspace) = invocation.location_key(request.query.location.as_ref())?;
    core.locations.evict(&directory, workspace.as_ref())?;
    Ok(v5::DebugLocationEvictResult { data: v5::Empty {} })
}

fn backend_path(path: &Path) -> Result<v5::LosslessString, Failure> {
    path.to_str()
        .map(convert::text)
        .ok_or_else(|| Failure::Unavailable("Backend path is not representable".into()))
}
