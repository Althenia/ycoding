use crate::{
    convert,
    dispatch::{Dispatcher, Failure, Invocation, RegistrationError},
    mcp_convert,
};
use std::sync::Arc;
use ycoding_core::resources::mcp::{Service, client::Error};
use ycoding_core::ycoding_schema::{LosslessString, parse_json, session_message};
use ycoding_protocol::v5;

pub fn register(dispatcher: &mut Dispatcher) -> Result<(), RegistrationError> {
    dispatcher.handle("mcp.add", add)?;
    dispatcher.handle("mcp.configure", crate::config_ops::configure_mcp)?;
    dispatcher.handle("mcp.connect", connect)?;
    dispatcher.handle("mcp.disconnect", disconnect)?;
    dispatcher.handle("mcp.list", list)?;
    dispatcher.handle("mcp.remove", remove)?;
    dispatcher.handle("mcp.resource.catalog", resource_catalog)?;
    dispatcher.handle("mcp.app.view", app_view)?;
    Ok(())
}

pub async fn app_view(
    invocation: Invocation,
    request: v5::McpAppViewRequest,
) -> Result<v5::McpAppViewResult, Failure> {
    let id = invocation.session(&request.params.session_id)?;
    let message = convert::identifier::<session_message::Id>(&request.query.message_id)?;
    let call = convert::domain(&request.query.call_id)?;
    if call
        .to_utf8()
        .is_ok_and(|text| text.chars().any(char::is_control))
    {
        return Err(Failure::Invalid("Invalid MCP tool call identity".into()));
    }
    let core = invocation.core()?;
    let session = core
        .sessions
        .get(&id)
        .map_err(|_| Failure::Unavailable("Session store is unavailable".into()))?
        .ok_or_else(|| Failure::SessionNotFound(convert::readable(id.as_lossless())))?;
    if session.time.archived.is_some() {
        return Ok(v5::McpAppViewResult { data: None });
    }
    let location = if invocation.remote {
        crate::remote_derived::target::verify(core, &id)?.1
    } else {
        core.locations.location(
            session.location.directory.as_lossless(),
            session
                .location
                .workspace_id
                .as_ref()
                .map(|workspace| workspace.as_lossless()),
        )?
    };
    let stored = core
        .sessions
        .message(&message)
        .map_err(|_| Failure::Unavailable("Session store is unavailable".into()))?;
    let Some((owner, session_message::Info::Assistant(assistant))) = stored else {
        return Ok(v5::McpAppViewResult { data: None });
    };
    if owner != id {
        return Ok(v5::McpAppViewResult { data: None });
    }
    let mut matches = assistant.content.iter().filter_map(|part| match part {
        session_message::AssistantContent::Tool(tool) if tool.id == call => Some(tool),
        _ => None,
    });
    if !matches
        .next()
        .is_some_and(|tool| matches!(tool.state, session_message::ToolState::Completed(_)))
        || matches.next().is_some()
    {
        return Ok(v5::McpAppViewResult { data: None });
    }
    let resolver = core
        .mcp
        .as_ref()
        .ok_or_else(|| Failure::Unavailable("Location MCP resolver is not composed".into()))?;
    let service = resolver(&location.info)
        .map_err(|_| Failure::Unavailable("Location MCP manager unavailable".into()))?;
    let app = service
        .app_view(&id, &message, &call)
        .await
        .map_err(|_| Failure::Unavailable("MCP App is unavailable".into()))?;
    let json_value = |value: String| {
        parse_json(&value)
            .map(|value| convert::json_to_value(&value))
            .map_err(|_| Failure::Unavailable("Invalid MCP App data".into()))
    };
    let data = if let Some(app) = app {
        Some(v5::McpAppView {
            resource_uri: convert::text(&app.resource_uri),
            html: convert::text(&app.html),
            tool: convert::text(&app.tool),
            input: json_value(app.input.to_string())?,
            output: json_value(app.output.to_string())?,
        })
    } else {
        None
    };
    Ok(v5::McpAppViewResult { data })
}

fn resolve(
    invocation: &Invocation,
    query: &v5::LocationQuery,
) -> Result<(v5::LocationInfo, Arc<Service>), Failure> {
    let location = invocation.location(query.location.as_ref())?;
    let resolver = invocation
        .core()?
        .mcp
        .as_ref()
        .ok_or_else(|| Failure::Unavailable("Location MCP resolver is not composed".into()))?;
    let service = resolver(&location.info)
        .map_err(|_| Failure::Unavailable("Location MCP manager unavailable".into()))?;
    service
        .bind_events(
            invocation.core()?.events.clone(),
            Some(ycoding_core::ycoding_schema::location::Ref {
                directory: location.info.directory.clone(),
                workspace_id: location.info.workspace_id.clone(),
            }),
        )
        .map_err(Failure::Unavailable)?;
    Ok((convert::location_info(&location.info), service))
}

fn name(value: &v5::LosslessString) -> Result<(LosslessString, String), Failure> {
    let name = convert::domain(value)?;
    let scalar = name
        .to_utf8()
        .map_err(|_| Failure::Unavailable("Core MCP names require scalar strings".into()))?;
    Ok((name, scalar))
}

fn failure(error: Error, server: LosslessString) -> Failure {
    match error {
        Error::NotFound(_) => Failure::McpServerNotFound(server),
        _ => Failure::Unavailable("MCP operation failed".into()),
    }
}

pub async fn add(
    invocation: Invocation,
    request: v5::McpAddRequest,
) -> Result<v5::McpAddResult, Failure> {
    let (_, service) = resolve(&invocation, &request.query)?;
    let (server, scalar) = name(&request.params.server)?;
    service
        .add(&scalar, mcp_convert::config(&request.payload.config)?)
        .await
        .map_err(|error| failure(error, server))?;
    Ok(v5::McpAddResult { data: v5::Empty {} })
}

pub async fn connect(
    invocation: Invocation,
    request: v5::McpConnectRequest,
) -> Result<v5::McpConnectResult, Failure> {
    let (_, service) = resolve(&invocation, &request.query)?;
    let (server, scalar) = name(&request.params.server)?;
    service
        .connect(&scalar)
        .await
        .map_err(|error| failure(error, server))?;
    Ok(v5::McpConnectResult { data: v5::Empty {} })
}

pub async fn disconnect(
    invocation: Invocation,
    request: v5::McpDisconnectRequest,
) -> Result<v5::McpDisconnectResult, Failure> {
    let (_, service) = resolve(&invocation, &request.query)?;
    let (server, scalar) = name(&request.params.server)?;
    service
        .disconnect(&scalar)
        .await
        .map_err(|error| failure(error, server))?;
    Ok(v5::McpDisconnectResult { data: v5::Empty {} })
}

pub async fn remove(
    invocation: Invocation,
    request: v5::McpRemoveRequest,
) -> Result<v5::McpRemoveResult, Failure> {
    let (_, service) = resolve(&invocation, &request.query)?;
    let (server, scalar) = name(&request.params.server)?;
    service
        .remove(&scalar)
        .await
        .map_err(|error| failure(error, server))?;
    Ok(v5::McpRemoveResult { data: v5::Empty {} })
}

pub async fn list(
    invocation: Invocation,
    request: v5::McpListRequest,
) -> Result<v5::McpListResult, Failure> {
    let (location, service) = resolve(&invocation, &request.query)?;
    let servers = service
        .servers()
        .map_err(|_| Failure::Unavailable("MCP manager unavailable".into()))?;
    Ok(v5::McpListResult {
        location,
        data: v5::McpListResultData {
            items: servers.iter().map(mcp_convert::server).collect(),
        },
    })
}

pub async fn resource_catalog(
    invocation: Invocation,
    request: v5::McpResourceCatalogRequest,
) -> Result<v5::McpResourceCatalogResult, Failure> {
    let (location, service) = resolve(&invocation, &request.query)?;
    let catalog = service
        .resource_catalog_typed()
        .await
        .map_err(|_| Failure::Unavailable("MCP resource catalog unavailable".into()))?;
    Ok(v5::McpResourceCatalogResult {
        location,
        data: mcp_convert::catalog(&catalog),
    })
}
