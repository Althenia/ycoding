use crate::{
    convert,
    dispatch::{Failure, Invocation},
    session_attachment_upload,
};
use std::collections::BTreeSet;
use ycoding_core::{
    resources::{attachment_store, image},
    session::attachment_admission::{self, Input, MaterializeError},
    ycoding_schema::{location, prompt::FileAttachment, session},
};
use ycoding_protocol::v5;

pub async fn materialize(
    invocation: &Invocation,
    session: &session::Id,
    files: &[v5::PromptInputFileAttachment],
) -> Result<Vec<FileAttachment>, Failure> {
    let core = invocation.core()?;
    let (info, lease) = core.locations.session(session)?;
    let platform =
        core.platform.as_ref().ok_or_else(|| {
            Failure::Unavailable("Location platform resolver is not composed".into())
        })?(&info.location)
        .map_err(Failure::Unavailable)?;
    let inputs = files
        .iter()
        .map(|file| {
            Ok(Input {
                uri: convert::domain(&file.uri)?,
                name: file.name.as_ref().map(convert::domain).transpose()?,
                description: file.description.as_ref().map(convert::domain).transpose()?,
                mention: file
                    .mention
                    .as_ref()
                    .map(convert::mention_domain)
                    .transpose()?,
            })
        })
        .collect::<Result<Vec<_>, Failure>>()?;
    let inputs = if invocation.remote {
        authorize(invocation, &info, &lease.info, &inputs).await?;
        let session = convert::readable(info.id.as_lossless());
        inputs
            .into_iter()
            .map(|input| {
                let uri = convert::readable(&input.uri);
                if !uri.starts_with(session_attachment_upload::SCHEME) {
                    return Ok((input, None));
                }
                let bytes = invocation.environment.uploads.resolve(
                    &invocation.connection_id,
                    &session,
                    &uri,
                )?;
                Ok((input, Some(bytes)))
            })
            .collect::<Result<Vec<_>, Failure>>()?
    } else {
        inputs.into_iter().map(|input| (input, None)).collect()
    };
    let attachments = attachment_store::Store::new(platform.config.roots().data.clone())
        .map_err(|_| Failure::Unavailable("Managed attachments are unavailable".into()))?;
    let limits = image::Limits::from_configuration(&platform.config);
    let sessions = core.sessions.clone();
    tokio::task::spawn_blocking(move || {
        inputs
            .into_iter()
            .map(|(input, uploaded)| match uploaded {
                Some(bytes) => {
                    attachment_admission::materialize_upload(&attachments, limits, bytes, input)
                }
                None => sessions.materialize_attachment(&attachments, limits, input),
            })
            .collect::<Result<Vec<_>, _>>()
    })
    .await
    .map_err(|error| Failure::Unavailable(error.to_string()))?
    .map_err(|error| match error {
        MaterializeError::Attachment(message) => Failure::InvalidField {
            message,
            field: "files",
        },
        MaterializeError::Store(_) => Failure::Unavailable("Session store unavailable".into()),
    })
}

// Remote peers may attach files inside the Session Location, catalog references and
// resources, or staged uploads; uploads resolve against the same Session and connection.
async fn authorize(
    invocation: &Invocation,
    session: &session::Info,
    location: &location::Info,
    inputs: &[Input],
) -> Result<(), Failure> {
    let uris = inputs
        .iter()
        .map(|input| input.uri.to_utf8().map_err(|_| outside()))
        .collect::<Result<Vec<_>, _>>()?;
    let root = std::fs::canonicalize(convert::readable(session.location.directory.as_lossless()))
        .ok()
        .filter(|_| uris.iter().any(|uri| uri.starts_with("file:")));
    let required = uris
        .iter()
        .filter(|uri| {
            if uri.starts_with(session_attachment_upload::SCHEME) {
                return false;
            }
            if !uri.starts_with("file:") {
                return true;
            }
            let target = url::Url::parse(uri)
                .ok()
                .and_then(|url| url.to_file_path().ok())
                .and_then(|path| std::fs::canonicalize(path).ok());
            !root
                .as_ref()
                .zip(target)
                .is_some_and(|(root, target)| target.starts_with(root))
        })
        .collect::<Vec<_>>();
    if required.is_empty() {
        return Ok(());
    }
    let permitted = catalog(invocation, location).await?;
    if required.iter().any(|uri| !permitted.contains(uri.as_str())) {
        return Err(outside());
    }
    Ok(())
}

async fn catalog(
    invocation: &Invocation,
    location: &location::Info,
) -> Result<BTreeSet<String>, Failure> {
    let core = invocation.core()?;
    let unavailable = || Failure::Unavailable("Location catalog unavailable".into());
    let catalogs =
        core.catalogs.as_ref().ok_or_else(unavailable)?(location).map_err(|_| unavailable())?;
    let mcp = core.mcp.as_ref().ok_or_else(unavailable)?(location).map_err(|_| unavailable())?;
    let resources = mcp
        .resource_catalog_typed()
        .await
        .map_err(|_| unavailable())?
        .resources;
    let references = catalogs
        .references
        .list()
        .iter()
        .filter(|reference| reference.hidden != Some(true))
        .filter_map(|reference| {
            url::Url::from_file_path(convert::readable(reference.path.as_lossless()))
                .ok()
                .map(String::from)
        });
    Ok(references
        .chain(
            resources
                .iter()
                .map(|resource| convert::readable(&resource.uri)),
        )
        .collect())
}

fn outside() -> Failure {
    Failure::Connector {
        code: 1,
        message: "Attachment is outside the Session Location and current catalog",
    }
}
