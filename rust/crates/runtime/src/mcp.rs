use crate::{
    convert,
    dispatch::{Dispatcher, Failure, Invocation, RegistrationError},
    mcp_convert,
};
use std::sync::Arc;
use ycoding_core::resources::mcp::{Service, client::Error};
use ycoding_core::ycoding_schema::LosslessString;
use ycoding_protocol::v5;

pub fn register(dispatcher: &mut Dispatcher) -> Result<(), RegistrationError> {
    dispatcher.handle("mcp.add", add)?;
    dispatcher.handle("mcp.connect", connect)?;
    dispatcher.handle("mcp.disconnect", disconnect)?;
    dispatcher.handle("mcp.list", list)?;
    dispatcher.handle("mcp.remove", remove)?;
    dispatcher.handle("mcp.resource.catalog", resource_catalog)?;
    Ok(())
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
