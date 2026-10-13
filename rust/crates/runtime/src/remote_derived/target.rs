use crate::{
    Core, convert,
    dispatch::{Failure, Invocation},
    locations::LocationServices,
};
use std::{
    collections::BTreeMap,
    path::{Component, Path, PathBuf},
    sync::Arc,
};
use ycoding_core::{
    session::{list::Query, prompt_cache::sha256},
    ycoding_schema::{DomainEncode, JsonValue, LosslessString, location, session, stringify_json},
};
use ycoding_protocol::v5;

pub fn error(code: i32, message: &'static str) -> Failure {
    Failure::Connector { code, message }
}

pub fn verify(
    core: &Core,
    id: &session::Id,
) -> Result<(session::Info, Arc<LocationServices>), Failure> {
    if !living(core, id)? {
        return Err(error(5, "Session is deleted"));
    }
    let (info, services) = core
        .locations
        .session(id)
        .map_err(|failure| match failure {
            Failure::SessionNotFound(_) => {
                error(5, "Session is not available at its recorded Location")
            }
            _ => error(10, "Session Location is unavailable"),
        })?;
    if info.project_id.as_lossless() != services.info.project.id.as_lossless()
        || normalized(info.location.directory.as_lossless())?
            != normalized(services.info.directory.as_lossless())?
        || info.location.workspace_id != services.info.workspace_id
        || !std::fs::metadata(convert::readable(info.location.directory.as_lossless()))
            .is_ok_and(|metadata| metadata.is_dir())
    {
        return Err(error(5, "Session placement is unavailable"));
    }
    Ok((info, services))
}

pub fn living(core: &Core, id: &session::Id) -> Result<bool, Failure> {
    let mut after = None;
    loop {
        let page = core
            .sessions
            .log(id, after, 512)
            .map_err(|failure| match failure {
                ycoding_core::ycoding_store::Error::Domain {
                    kind: "not_found", ..
                } => error(5, "Session is unavailable"),
                _ => error(10, "Session lifecycle unavailable"),
            })?;
        if page
            .events
            .iter()
            .any(|entry| entry.event.0.event_type.as_str() == Some("session.deleted"))
        {
            return Ok(false);
        }
        let Some(last) = page.events.last() else {
            return Ok(true);
        };
        if page.events.len() < 512 {
            return Ok(true);
        }
        after = Some(last.seq);
    }
}

pub fn session(invocation: &Invocation) -> Result<(session::Info, Arc<LocationServices>), Failure> {
    let Some(v5::scope::Target::Session(id)) = &invocation.scope.target else {
        return Err(error(4, "Session scope required"));
    };
    verify(
        invocation.core()?,
        &session::Id::new(id.as_str()).map_err(|_| error(1, "Invalid Session ID"))?,
    )
}

pub fn root(invocation: &Invocation) -> Result<session::Info, Failure> {
    let info = session(invocation)?.0;
    if info.parent_id.is_some() {
        return Err(error(12, "Operation requires a root Session"));
    }
    Ok(info)
}

pub fn member(
    core: &Core,
    root: &session::Info,
    id: &session::Id,
    managed: bool,
) -> Result<session::Info, Failure> {
    if root.parent_id.is_some() {
        return Err(error(12, "Operation requires a root Session"));
    }
    let info = verify(core, id)?.0;
    if info.id != root.id
        && (info.parent_id.as_ref() != Some(&root.id)
            || managed
                && info
                    .agent
                    .as_ref()
                    .is_some_and(|agent| agent.as_str() == Some("btw")))
    {
        return Err(error(12, "Session is not a direct family member"));
    }
    Ok(info)
}

pub fn reference(info: &location::Info) -> location::Ref {
    location::Ref {
        directory: info.directory.clone(),
        workspace_id: info.workspace_id.clone(),
    }
}

pub struct Workspace {
    pub wire: v5::ConnectorWorkspace,
    pub project: LosslessString,
    pub directory: LosslessString,
    pub workspace: Option<LosslessString>,
}

fn normalized(directory: &LosslessString) -> Result<LosslessString, Failure> {
    let scalar = directory
        .to_utf8()
        .map_err(|_| error(1, "Invalid recorded directory"))?;
    let absolute =
        std::path::absolute(&scalar).map_err(|_| error(1, "Invalid recorded directory"))?;
    let mut path = PathBuf::new();
    for part in absolute.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                path.pop();
            }
            part => path.push(part.as_os_str()),
        }
    }
    path.to_str()
        .map(LosslessString::from)
        .ok_or_else(|| error(1, "Invalid recorded directory"))
}

fn permitted(directory: &LosslessString) -> bool {
    let Ok(path) = std::fs::canonicalize(convert::readable(directory)) else {
        return false;
    };
    if !path.is_dir() {
        return false;
    }
    let temp = std::fs::canonicalize(std::env::temp_dir()).unwrap_or_else(|_| std::env::temp_dir());
    if path.starts_with(temp)
        || ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"]
            .iter()
            .any(|root| path.starts_with(root))
    {
        return false;
    }
    let parts = path
        .to_string_lossy()
        .split('/')
        .filter(|part| !part.is_empty())
        .map(String::from)
        .collect::<Vec<_>>();
    let parts = if parts.first().is_some_and(|part| part == "private") {
        &parts[1..]
    } else {
        &parts[..]
    };
    !(parts.len() >= 5 && parts[0] == "var" && parts[1] == "folders" && parts[4] == "T")
}

pub fn inventory(core: &Core, sessions_only: bool) -> Result<Vec<Workspace>, Failure> {
    let projects = core
        .sessions
        .project_list()
        .map_err(|_| error(10, "Project inventory unavailable"))?;
    let sessions = core
        .sessions
        .list(&Query::default())
        .map_err(|_| error(10, "Session inventory unavailable"))?;
    let mut candidates = BTreeMap::<
        (LosslessString, LosslessString, Option<LosslessString>),
        Option<LosslessString>,
    >::new();
    let mut add = |project: &LosslessString,
                   directory: &LosslessString,
                   workspace: Option<LosslessString>|
     -> Result<(), Failure> {
        if !sessions_only && project.as_str() == Some("global") {
            return Ok(());
        }
        let directory = normalized(directory)?;
        let name = projects
            .iter()
            .find(|info| info.id.as_lossless() == project)
            .and_then(|info| info.name.clone())
            .or_else(|| {
                Some(
                    Path::new(&convert::readable(&directory))
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("")
                        .into(),
                )
            });
        candidates.insert((project.clone(), directory, workspace), name);
        Ok(())
    };
    if !sessions_only {
        for project in &projects {
            if project.id.as_lossless().as_str() != Some("global")
                && project.worktree.as_str() != Some("/")
            {
                add(project.id.as_lossless(), &project.worktree, None)?;
            }
            for directory in core
                .sessions
                .project_directories(project.id.as_lossless())
                .map_err(|_| error(10, "Project directories unavailable"))?
            {
                add(
                    project.id.as_lossless(),
                    directory.directory.as_lossless(),
                    None,
                )?;
            }
        }
    }
    for session in &sessions {
        if living(core, &session.id)? {
            add(
                session.project_id.as_lossless(),
                session.location.directory.as_lossless(),
                session
                    .location
                    .workspace_id
                    .as_ref()
                    .map(|id| id.as_lossless().clone()),
            )?;
        }
    }
    let mut entries = candidates
        .into_iter()
        .filter(|((_, directory, _), _)| permitted(directory))
        .map(|((project, directory, workspace), name)| {
            let tuple = JsonValue::Array(vec![
                project.encode(),
                directory.encode(),
                workspace
                    .as_ref()
                    .map_or(JsonValue::Null, DomainEncode::encode),
            ]);
            let key = format!(
                "wsp_{}",
                sha256(&format!(
                    "ycoding.remote.workspace.v1\0{}",
                    stringify_json(&tuple)
                ))
            );
            Workspace {
                wire: v5::ConnectorWorkspace {
                    id: convert::text(&key),
                    project_id: convert::wire(&project),
                    directory: convert::wire(&directory),
                    workspace_id: workspace.as_ref().map(convert::wire),
                    name: name.as_ref().map(convert::wire),
                },
                project,
                directory,
                workspace,
            }
        })
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| {
        compare(&a.project, &b.project)
            .then_with(|| compare(&a.directory, &b.directory))
            .then_with(|| {
                compare(
                    a.workspace.as_ref().unwrap_or(&LosslessString::default()),
                    b.workspace.as_ref().unwrap_or(&LosslessString::default()),
                )
            })
    });
    Ok(entries)
}

fn compare(a: &LosslessString, b: &LosslessString) -> std::cmp::Ordering {
    ycoding_core::platform::filesystem::collation::compare(
        &a.code_units().collect::<Vec<_>>(),
        &b.code_units().collect::<Vec<_>>(),
    )
}

pub fn workspace(core: &Core, id: &LosslessString) -> Result<Arc<LocationServices>, Failure> {
    let candidate = inventory(core, false)?
        .into_iter()
        .find(|candidate| convert::domain(&candidate.wire.id).is_ok_and(|key| key == *id))
        .ok_or_else(|| error(1, "Workspace is unavailable"))?;
    let services = core
        .locations
        .location(&candidate.directory, candidate.workspace.as_ref())
        .map_err(|_| error(1, "Workspace is unavailable"))?;
    if services.info.project.id.as_lossless() != &candidate.project
        || normalized(services.info.directory.as_lossless())? != candidate.directory
    {
        return Err(error(1, "Workspace project changed"));
    }
    Ok(services)
}

pub fn scoped(invocation: &Invocation) -> Result<Arc<LocationServices>, Failure> {
    match &invocation.scope.target {
        Some(v5::scope::Target::Session(_)) => Ok(session(invocation)?.1),
        Some(v5::scope::Target::Workspace(id)) => {
            workspace(invocation.core()?, &id.as_str().into())
        }
        _ => Err(error(
            12,
            "Catalog requires a backend Session or advertised workspace",
        )),
    }
}

pub fn auth(
    invocation: &Invocation,
    target: &v5::ConnectorAuthTarget,
) -> Result<Arc<LocationServices>, Failure> {
    match &target.kind {
        Some(v5::connector_auth_target::Kind::Value1(target)) => Ok(verify(
            invocation.core()?,
            &convert::identifier::<session::Id>(&target.session_id)?,
        )?
        .1),
        Some(v5::connector_auth_target::Kind::Value2(target)) => {
            workspace(invocation.core()?, &convert::domain(&target.workspace)?)
        }
        None => Err(error(1, "Invalid authentication target")),
    }
}

pub async fn list(
    invocation: Invocation,
    request: v5::WorkspaceListRequest,
) -> Result<v5::WorkspaceListResult, Failure> {
    Ok(v5::WorkspaceListResult {
        data: v5::WorkspaceListResultData {
            items: inventory(
                invocation.core()?,
                request.payload.sessions_only.unwrap_or(false),
            )?
            .into_iter()
            .map(|entry| entry.wire)
            .collect(),
        },
    })
}
