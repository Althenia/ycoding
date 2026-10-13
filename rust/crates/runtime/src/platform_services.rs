use crate::{
    convert,
    dispatch::{Failure, Invocation},
    services::PlatformServices,
};
use std::sync::Arc;
use ycoding_core::ycoding_schema::location;
use ycoding_protocol::v5;

pub fn resolve(
    invocation: &Invocation,
    directory: Option<&v5::LosslessString>,
    workspace: Option<&v5::LosslessString>,
) -> Result<(location::Info, Arc<PlatformServices>), Failure> {
    let query = v5::LocationQueryLocation {
        directory: directory.cloned(),
        workspace: workspace.cloned(),
    };
    let location = invocation.location(Some(&query))?;
    let reference = location::Ref {
        directory: location.info.directory.clone(),
        workspace_id: location.info.workspace_id.clone(),
    };
    let services =
        invocation.core()?.platform.as_ref().ok_or_else(|| {
            Failure::Unavailable("Location platform resolver is not composed".into())
        })?(&reference)
        .map_err(Failure::Unavailable)?;
    let directory = convert::readable(reference.directory.as_lossless());
    if [
        services.filesystem.directory(),
        services.search.directory(),
        services.shell.directory(),
        services.pty.directory(),
        services.copies.directory(),
    ]
    .iter()
    .any(|path| *path != std::path::Path::new(&directory))
    {
        return Err(Failure::Unavailable(
            "Platform resolver returned another Location".into(),
        ));
    }
    Ok((location.info.clone(), services))
}

pub fn cwd(
    services: &PlatformServices,
    input: Option<&v5::LosslessString>,
) -> Result<ycoding_core::ycoding_schema::LosslessString, Failure> {
    Ok(input
        .map(convert::domain)
        .transpose()?
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            services
                .filesystem
                .directory()
                .to_string_lossy()
                .into_owned()
                .into()
        }))
}

pub fn io(error: std::io::Error) -> Failure {
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        return Failure::Forbidden(error.to_string());
    }
    Failure::Invalid(error.to_string())
}
