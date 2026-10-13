use crate::{
    convert,
    dispatch::{Failure, Invocation},
    platform_services,
};
use ycoding_core::ycoding_schema::{
    filesystem::{Entry, EntryType, FindInput},
    schema::{PositiveInt, RelativePath},
};
use ycoding_protocol::{Asset, v5};

fn entry(entry: &Entry) -> v5::FileSystemEntry {
    v5::FileSystemEntry {
        path: convert::wire(entry.path.as_lossless()),
        uri: None,
        r#type: match entry.r#type {
            EntryType::File => v5::FileSystemEntryType::FilesystemEntryTypeFile,
            EntryType::Directory => v5::FileSystemEntryType::FilesystemEntryTypeDirectory,
        } as i32,
    }
}

pub async fn list(
    invocation: Invocation,
    request: v5::FsListRequest,
) -> Result<v5::FsListResult, Failure> {
    let q = request.query.location.as_ref();
    let (location, services) = platform_services::resolve(
        &invocation,
        q.and_then(|q| q.directory.as_ref()),
        q.and_then(|q| q.workspace.as_ref()),
    )?;
    let path = request
        .query
        .path
        .as_ref()
        .map(convert::identifier::<RelativePath>)
        .transpose()?;
    let entries = tokio::task::spawn_blocking(move || {
        services.filesystem.list(
            path.as_ref()
                .map(|path| path.as_lossless().to_utf8())
                .transpose()
                .map_err(std::io::Error::other)?
                .as_deref(),
        )
    })
    .await
    .map_err(|error| Failure::Unavailable(error.to_string()))?
    .map_err(platform_services::io)?;
    Ok(v5::FsListResult {
        location: convert::location_info(&location),
        data: v5::FsListResultData {
            items: entries.iter().map(entry).collect(),
        },
    })
}

pub async fn find(
    invocation: Invocation,
    request: v5::FsFindRequest,
) -> Result<v5::FsFindResult, Failure> {
    let q = request.query.location.as_ref();
    let (location, services) = platform_services::resolve(
        &invocation,
        q.and_then(|q| q.directory.as_ref()),
        q.and_then(|q| q.workspace.as_ref()),
    )?;
    let input = FindInput {
        query: convert::domain(&request.query.query)?,
        r#type: request
            .query
            .r#type
            .map(|value| match v5::FsFindRequestQueryType::try_from(value) {
                Ok(v5::FsFindRequestQueryType::File) => Ok(EntryType::File),
                Ok(v5::FsFindRequestQueryType::Directory) => Ok(EntryType::Directory),
                _ => Err(Failure::Invalid("Invalid entry type".into())),
            })
            .transpose()?,
        limit: request
            .query
            .limit
            .map(|value| PositiveInt::new(value as i64))
            .transpose()
            .map_err(|error| Failure::Invalid(error.to_string()))?,
    };
    let entries = tokio::task::spawn_blocking(move || services.search.find(&input))
        .await
        .map_err(|error| Failure::Unavailable(error.to_string()))?
        .map_err(platform_services::io)?;
    Ok(v5::FsFindResult {
        location: Some(convert::location_info(&location)),
        data: v5::FsFindResultData {
            items: entries.iter().map(entry).collect(),
        },
    })
}

pub async fn read(
    invocation: Invocation,
    request: v5::FsReadRequest,
) -> Result<Asset<v5::FsReadResult>, Failure> {
    let q = request.query.location.as_ref();
    let (_, services) = platform_services::resolve(
        &invocation,
        q.and_then(|q| q.directory.as_ref()),
        q.and_then(|q| q.workspace.as_ref()),
    )?;
    let path = convert::identifier::<RelativePath>(&request.params.path)?;
    let file = tokio::task::spawn_blocking(move || {
        services.filesystem.read(
            &path
                .as_lossless()
                .to_utf8()
                .map_err(std::io::Error::other)?,
        )
    })
    .await
    .map_err(|error| Failure::Unavailable(error.to_string()))?
    .map_err(platform_services::io)?;
    Asset::new(
        v5::FsReadResult {
            data: v5::PlatformAssetMetadata {
                mime: convert::text(file.mime),
                byte_count: file.content.len() as u64,
            },
        },
        file.content,
    )
    .map_err(|error| Failure::Invalid(error.to_string()))
}
