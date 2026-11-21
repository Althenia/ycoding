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
    ycoding_schema::{
        DomainEncode, JsonValue, LosslessString, location, schema::AbsolutePath, session,
        stringify_json, workspace_id::WorkspaceId,
    },
};
use ycoding_protocol::v5;

pub fn error(code: i32, message: &'static str) -> Failure {
    Failure::Connector { code, message }
}

pub fn verify(
    core: &Core,
    id: &session::Id,
) -> Result<(session::Info, Arc<LocationServices>), Failure> {
    verify_placement(core, id, false)
}

pub(crate) fn verify_loaded(
    core: &Core,
    id: &session::Id,
) -> Result<(session::Info, Arc<LocationServices>), Failure> {
    verify_placement(core, id, true)
}

pub(crate) fn prepare_session_usage(
    core: &Core,
    id: &session::Id,
    refresh: bool,
) -> Result<Option<Arc<LocationServices>>, Failure> {
    let info = verify_recorded(core, id)?;
    match core.locations.prepare_usage_location(
        info.location.directory.as_lossless(),
        info.location
            .workspace_id
            .as_ref()
            .map(|id| id.as_lossless()),
        refresh,
    )? {
        Some(_) => verify_loaded(core, id).map(|(_, services)| Some(services)),
        None => Ok(None),
    }
}

pub(crate) fn verify_recorded(core: &Core, id: &session::Id) -> Result<session::Info, Failure> {
    if !living(core, id)? {
        return Err(error(5, "Session is deleted"));
    }
    let info = recorded_session(core, id)?;
    recorded_project(core, info.project_id.as_lossless())?;
    normalized(info.location.directory.as_lossless())?;
    if !directory_exists(info.location.directory.as_lossless()) {
        return Err(error(5, "Session placement is unavailable"));
    }
    if let Some(services) = usage_loaded(
        core,
        info.location.directory.as_lossless(),
        info.location
            .workspace_id
            .as_ref()
            .map(|id| id.as_lossless()),
    )? {
        assert_session_placement(&info, &services)?;
    }
    Ok(info)
}

pub(crate) fn recorded_location(core: &Core, scope: &v5::Scope) -> Result<location::Ref, Failure> {
    let target = match &scope.target {
        Some(v5::scope::Target::Session(id) | v5::scope::Target::Form(id)) => {
            let id = session::Id::new(id.as_str())
                .map_err(|_| error(5, "Session identity is invalid"))?;
            return Ok(verify_recorded(core, &id)?.location);
        }
        Some(v5::scope::Target::Workspace(id)) => workspace_reference(core, &id.as_str().into())?,
        Some(v5::scope::Target::Machine(_)) => {
            let directory = std::env::current_dir()
                .map_err(|_| error(10, "Default machine placement unavailable"))?;
            return Ok(location::Ref {
                directory: AbsolutePath::new(
                    directory
                        .to_str()
                        .ok_or_else(|| error(10, "Default machine placement unavailable"))?,
                )
                .map_err(|_| error(10, "Default machine placement unavailable"))?,
                workspace_id: None,
            });
        }
        _ => return Err(error(5, "Remote placement scope is unavailable")),
    };
    recorded_project(core, &target.project)?;
    if let Some(services) = usage_loaded(core, &target.directory, target.workspace.as_ref())? {
        assert_workspace_placement(&target, &services)?;
    }
    Ok(location::Ref {
        directory: AbsolutePath::new(target.directory)
            .map_err(|_| error(5, "Workspace directory is invalid"))?,
        workspace_id: target
            .workspace
            .map(WorkspaceId::new)
            .transpose()
            .map_err(|_| error(5, "Workspace identity is invalid"))?,
    })
}

fn recorded_session(core: &Core, id: &session::Id) -> Result<session::Info, Failure> {
    core.sessions
        .get(id)
        .map_err(|_| error(10, "Session lifecycle unavailable"))?
        .ok_or_else(|| error(5, "Session is deleted"))
}

fn recorded_project(core: &Core, id: &LosslessString) -> Result<(), Failure> {
    if !core
        .sessions
        .project_list()
        .map_err(|_| error(10, "Project inventory unavailable"))?
        .iter()
        .any(|project| project.id.as_lossless() == id)
    {
        return Err(error(5, "Recorded Project is unavailable"));
    }
    Ok(())
}

fn directory_exists(directory: &LosslessString) -> bool {
    std::fs::metadata(convert::readable(directory)).is_ok_and(|metadata| metadata.is_dir())
}

fn usage_loaded(
    core: &Core,
    directory: &LosslessString,
    workspace: Option<&LosslessString>,
) -> Result<Option<Arc<LocationServices>>, Failure> {
    match core.locations.loaded_location(directory, workspace) {
        Ok(services) => Ok(Some(services)),
        Err(Failure::Unavailable(_)) => Ok(None),
        Err(error) => Err(error),
    }
}

fn verify_placement(
    core: &Core,
    id: &session::Id,
    loaded: bool,
) -> Result<(session::Info, Arc<LocationServices>), Failure> {
    if !living(core, id)? {
        return Err(error(5, "Session is deleted"));
    }
    let placement = || {
        if !loaded {
            return core.locations.session(id);
        }
        let info = recorded_session(core, id)?;
        let services = core.locations.loaded_location(
            info.location.directory.as_lossless(),
            info.location
                .workspace_id
                .as_ref()
                .map(|id| id.as_lossless()),
        )?;
        Ok((info, services))
    };
    let (info, services) = placement().map_err(|failure| match failure {
        Failure::SessionNotFound(_) => {
            error(5, "Session is not available at its recorded Location")
        }
        _ => error(10, "Session Location is unavailable"),
    })?;
    assert_session_placement(&info, &services)?;
    Ok((info, services))
}

fn assert_session_placement(
    info: &session::Info,
    services: &LocationServices,
) -> Result<(), Failure> {
    if info.project_id.as_lossless() != services.info.project.id.as_lossless()
        || normalized(info.location.directory.as_lossless())?
            != normalized(services.info.directory.as_lossless())?
        || info.location.workspace_id != services.info.workspace_id
        || !directory_exists(info.location.directory.as_lossless())
    {
        return Err(error(5, "Session placement is unavailable"));
    }
    Ok(())
}

pub fn living(core: &Core, id: &session::Id) -> Result<bool, Failure> {
    living_log(|after| core.sessions.log(id, after, 512))
}

fn living_log(
    mut read: impl FnMut(
        Option<i64>,
    )
        -> Result<ycoding_core::session::log::Page, ycoding_core::ycoding_store::Error>,
) -> Result<bool, Failure> {
    let mut after = None;
    loop {
        let page = match read(after) {
            Ok(page) => page,
            Err(ycoding_core::ycoding_store::Error::Domain {
                kind: "not_found", ..
            }) => return Ok(false),
            Err(_) => return Err(error(10, "Session lifecycle unavailable")),
        };
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

fn permitted(state: &Path, directory: &LosslessString) -> bool {
    if crate::session_placement::bound(state, directory).is_err() {
        return false;
    }
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
        .filter(|((_, directory, _), _)| permitted(&core.state, directory))
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
    workspace_placement(core, id, false)
}

pub(crate) fn workspace_loaded(
    core: &Core,
    id: &LosslessString,
) -> Result<Arc<LocationServices>, Failure> {
    workspace_placement(core, id, true)
}

pub(crate) fn prepare_workspace_usage(
    core: &Core,
    id: &LosslessString,
    refresh: bool,
) -> Result<Option<Arc<LocationServices>>, Failure> {
    let candidate = workspace_reference(core, id)?;
    recorded_project(core, &candidate.project)?;
    if let Some(services) = usage_loaded(core, &candidate.directory, candidate.workspace.as_ref())?
    {
        assert_workspace_placement(&candidate, &services)?;
    }
    match core.locations.prepare_usage_location(
        &candidate.directory,
        candidate.workspace.as_ref(),
        refresh,
    )? {
        Some(_) => workspace_loaded(core, id).map(Some),
        None => Ok(None),
    }
}

fn workspace_reference(core: &Core, id: &LosslessString) -> Result<Workspace, Failure> {
    inventory(core, false)?
        .into_iter()
        .find(|candidate| convert::domain(&candidate.wire.id).is_ok_and(|key| key == *id))
        .ok_or_else(|| error(1, "Workspace is unavailable"))
}

fn workspace_placement(
    core: &Core,
    id: &LosslessString,
    loaded: bool,
) -> Result<Arc<LocationServices>, Failure> {
    let candidate = workspace_reference(core, id)?;
    let services = if loaded {
        core.locations
            .loaded_location(&candidate.directory, candidate.workspace.as_ref())
    } else {
        core.locations
            .location(&candidate.directory, candidate.workspace.as_ref())
    }
    .map_err(|_| error(1, "Workspace is unavailable"))?;
    assert_workspace_placement(&candidate, &services)?;
    Ok(services)
}

fn assert_workspace_placement(
    candidate: &Workspace,
    services: &LocationServices,
) -> Result<(), Failure> {
    if services.info.project.id.as_lossless() != &candidate.project
        || normalized(services.info.directory.as_lossless())? != candidate.directory
    {
        return Err(error(1, "Workspace project changed"));
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::{Failure, living_log};
    use ycoding_core::{
        session::{list::Query, store::Service},
        ycoding_schema::{parse_json, session},
        ycoding_store::{
            Error, Metadata, Options, Store,
            native::{DatabaseKind, catalog},
            project,
            session::NewEvent,
        },
    };

    #[tokio::test]
    async fn status_lifecycle_skips_a_session_deleted_between_inventory_and_log_read() {
        let store = Store::disposable(
            Options::core(),
            catalog(DatabaseKind::Core),
            Metadata::new([24; 16], 1),
        )
        .unwrap();
        store
            .submit(|tx| {
                project::ProjectTable::insert(
                    tx,
                    &project::Project {
                        id: "prj_fixture".into(),
                        worktree: "/fixture".into(),
                        vcs: None,
                        name: None,
                        icon_url: None,
                        icon_url_override: None,
                        icon_color: None,
                        time_created: 1,
                        time_updated: 1,
                        time_initialized: None,
                        sandboxes: vec![],
                        commands: None,
                    },
                )
            })
            .unwrap()
            .await
            .unwrap();
        let sessions = Service::new(store.client());
        for id in ["ses_removed", "ses_retained"] {
            sessions.create(NewEvent {
                id: format!("evt_create_{id}").into(),
                aggregate_id: id.into(),
                created: 1,
                type_: "session.created.2".into(),
                data: parse_json(&format!(r#"{{"sessionID":"{id}","projectID":"prj_fixture","location":{{"directory":"/fixture"}},"title":"Fixture","created":1}}"#)).unwrap(),
            }).await.unwrap();
        }
        let listed = sessions.list(&Query::default()).unwrap();
        assert_eq!(listed.len(), 2);
        let mut removed = false;
        let mut retained = Vec::new();
        for info in listed {
            if !removed {
                sessions
                    .remove(&session::Id::new("ses_removed").unwrap())
                    .await
                    .unwrap();
                removed = true;
            }
            if living_log(|after| sessions.log(&info.id, after, 512)).unwrap() {
                retained.push(info.id);
            }
        }
        assert_eq!(retained, vec![session::Id::new("ses_retained").unwrap()]);
        assert!(matches!(
            living_log(|_| Err(Error::Domain {
                kind: "storage",
                message: "fixture failure"
            })),
            Err(Failure::Connector { code: 10, .. })
        ));
        store.shutdown().unwrap();
    }
}
