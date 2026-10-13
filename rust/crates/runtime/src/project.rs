use crate::{
    convert,
    dispatch::{Failure, Invocation},
    ids,
};
use ycoding_core::{
    event_feed::Ephemeral,
    session::project::InventoryQuery,
    ycoding_schema::{LosslessString, project as contract},
};
use ycoding_protocol::v5;

pub async fn current(
    invocation: Invocation,
    request: v5::ProjectCurrentRequest,
) -> Result<v5::ProjectCurrentResult, Failure> {
    let services = invocation.location(request.query.location.as_ref())?;
    Ok(v5::ProjectCurrentResult {
        data: v5::ProjectCurrent {
            id: convert::wire(services.info.project.id.as_lossless()),
            directory: convert::wire(services.info.project.directory.as_lossless()),
        },
    })
}

pub async fn list(
    invocation: Invocation,
    _request: v5::ProjectListRequest,
) -> Result<v5::ProjectListResult, Failure> {
    let projects = invocation
        .core()?
        .sessions
        .project_list()
        .map_err(|_| Failure::Unavailable("Project store unavailable".into()))?;
    Ok(v5::ProjectListResult {
        items: projects.iter().map(project).collect::<Result<_, _>>()?,
    })
}

pub async fn directories(
    invocation: Invocation,
    request: v5::ProjectDirectoriesRequest,
) -> Result<v5::ProjectDirectoriesResult, Failure> {
    invocation.location(request.query.location.as_ref())?;
    let project_id = convert::domain(&request.params.project_id)?;
    let directories = invocation
        .core()?
        .sessions
        .project_directories(&project_id)
        .map_err(|_| Failure::Unavailable("Project store unavailable".into()))?;
    Ok(v5::ProjectDirectoriesResult {
        data: v5::ProjectDirectories {
            items: directories
                .iter()
                .map(|directory| v5::ProjectDirectory {
                    directory: convert::wire(directory.directory.as_lossless()),
                    strategy: directory.strategy.as_ref().map(convert::wire),
                })
                .collect(),
        },
    })
}

pub async fn forget(
    invocation: Invocation,
    request: v5::ProjectForgetRequest,
) -> Result<v5::ProjectForgetResult, Failure> {
    let core = invocation.core()?;
    let project_id = convert::domain(&request.params.project_id)?;
    let project_event_id = contract::Id::new(project_id.clone())
        .map_err(|_| Failure::Invalid("invalid Project ID".into()))?;
    let directory = absolute_path(&request.payload.directory)?;
    let event_id = ids::event_id()
        .map_err(|_| Failure::Unavailable("project event ID generation failed".into()))?;
    let removed = core
        .sessions
        .project_forget(&project_id, &directory)
        .await
        .map_err(|_| Failure::Unavailable("Project store unavailable".into()))?;
    if removed {
        core.events.publish(Ephemeral {
            id: event_id.as_lossless().clone(),
            created: ids::now_millis(),
            session: None,
            metadata: None,
            location: None,
            data: ycoding_core::event_feed::Data::ProjectDirectoriesUpdated(Box::new(
                ycoding_core::ycoding_schema::project_directories::UpdatedData {
                    project_id: project_event_id,
                },
            )),
        });
    }
    Ok(v5::ProjectForgetResult { data: v5::Empty {} })
}

pub async fn inventory(
    invocation: Invocation,
    request: v5::ProjectInventoryRequest,
) -> Result<v5::ProjectInventoryResult, Failure> {
    let (search, after) = match request.query.cursor.as_ref() {
        Some(cursor) => {
            let cursor = convert::readable(&convert::domain(cursor)?);
            let (search, anchor) = crate::cursor::decode_project_inventory(&cursor)?;
            (search, Some(anchor))
        }
        None => (
            request
                .query
                .search
                .as_ref()
                .map(convert::domain)
                .transpose()?,
            None,
        ),
    };
    let limit = match request.query.limit {
        Some(limit) => usize::try_from(limit)
            .ok()
            .filter(|limit| (1..=200).contains(limit))
            .ok_or_else(|| Failure::InvalidField {
                message: "limit must be between 1 and 200".into(),
                field: "limit",
            })?,
        None => 50,
    };
    let page = invocation
        .core()?
        .sessions
        .project_inventory(&InventoryQuery {
            limit,
            search: search.clone(),
            after,
        })
        .map_err(|_| Failure::Unavailable("Project inventory unavailable".into()))?;
    let next = page
        .next
        .as_ref()
        .map(|anchor| crate::cursor::encode_project_inventory(search.as_ref(), anchor))
        .map(|cursor| convert::text(&cursor));
    Ok(v5::ProjectInventoryResult {
        data: v5::ProjectInventoryResponse {
            data: v5::ProjectInventoryResponseData {
                items: page
                    .data
                    .iter()
                    .map(|entry| v5::ProjectInventoryEntry {
                        project_id: convert::wire(entry.project_id.as_lossless()),
                        project_name: entry.project_name.as_ref().map(convert::wire),
                        project_worktree: convert::wire(entry.project_worktree.as_lossless()),
                        directory: convert::wire(entry.directory.as_lossless()),
                        strategy: entry.strategy.as_ref().map(convert::wire),
                        sessions: entry.sessions.get() as u64,
                        time_active: entry.time_active.get() as u64,
                        available: entry.available,
                    })
                    .collect(),
            },
            cursor: v5::ProjectInventoryResponseCursor { next },
        },
    })
}

fn project(info: &contract::Info) -> Result<v5::Project, Failure> {
    Ok(v5::Project {
        id: convert::wire(info.id.as_lossless()),
        worktree: convert::wire(&info.worktree),
        vcs: info.vcs.as_ref().map(|vcs| match vcs {
            contract::Vcs::Git => v5::ProjectVcs::Git as i32,
            contract::Vcs::Hg => v5::ProjectVcs::Hg as i32,
        }),
        name: info.name.as_ref().map(convert::wire),
        icon: info.icon.as_ref().map(|icon| v5::ProjectIcon {
            url: icon.url.as_ref().map(convert::wire),
            r#override: icon.override_.as_ref().map(convert::wire),
            color: icon.color.as_ref().map(convert::wire),
        }),
        commands: info.commands.as_ref().map(|commands| v5::ProjectCommands {
            start: commands.start.as_ref().map(convert::wire),
        }),
        time: v5::ProjectTime {
            created: info.time.created.get() as u64,
            updated: info.time.updated.get() as u64,
            initialized: info.time.initialized.map(|value| value.get() as u64),
        },
        sandboxes: v5::ProjectSandboxes {
            items: info.sandboxes.iter().map(convert::wire).collect(),
        },
    })
}

fn absolute_path(value: &v5::LosslessString) -> Result<LosslessString, Failure> {
    let value = convert::domain(value)?;
    ycoding_core::ycoding_schema::schema::AbsolutePath::new(value.clone())
        .map_err(|_| Failure::Invalid("invalid directory path".into()))?;
    Ok(value)
}
