import { Mcp } from "@ycoding-ai/schema/mcp"
import { Location } from "@ycoding-ai/schema/location"
import { Session } from "@ycoding-ai/schema/session"
import { SessionMessage } from "@ycoding-ai/schema/session-message"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ForbiddenError, McpServerNotFoundError, ServiceUnavailableError, SessionNotFoundError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

const McpGroup = HttpApiGroup.make("server.mcp")
  .add(
    HttpApiEndpoint.get("mcp.list", "/api/mcp", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Mcp.Server)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "mcp.list",
          summary: "List MCP servers",
          description: "Retrieve configured MCP servers and their connection status.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.put("mcp.add", "/api/mcp/:server", {
      params: { server: Schema.String },
      query: LocationQuery,
      // Wrapped in a struct because the client codegen flattens payload fields and cannot
      // represent a top-level union payload.
      payload: Schema.Struct({ config: Mcp.ServerConfig }),
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "mcp.add",
          summary: "Add MCP server",
          description: "Add an MCP server at runtime or replace an existing one, connecting it immediately.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("mcp.remove", "/api/mcp/:server", {
      params: { server: Schema.String },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: McpServerNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "mcp.remove",
          summary: "Remove MCP server",
          description: "Stop an MCP server and remove it from the runtime set until restart.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("mcp.connect", "/api/mcp/:server/connect", {
      params: { server: Schema.String },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: McpServerNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "mcp.connect",
          summary: "Connect MCP server",
          description: "Connect an MCP server at runtime, overriding a disabled configuration until restart.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("mcp.disconnect", "/api/mcp/:server/disconnect", {
      params: { server: Schema.String },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: McpServerNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "mcp.disconnect",
          summary: "Disconnect MCP server",
          description: "Disconnect an MCP server at runtime, removing its tools until reconnected.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("mcp.resource.catalog", "/api/mcp/resource", {
      query: LocationQuery,
      success: Location.response(Mcp.ResourceCatalog),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "mcp.resource.catalog",
          summary: "List MCP resources",
          description: "Retrieve resources and resource templates from connected MCP servers.",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "mcp", description: "MCP server and resource routes." }))

export const makeMcpGroup = <
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
>(
  locationMiddleware: Context.Key<LocationId, LocationService>,
  sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>,
) => McpGroup.middleware(locationMiddleware)
  .add(
    HttpApiEndpoint.get("mcp.app.view", "/api/session/:sessionID/mcp/app", {
      params: { sessionID: Session.ID },
      query: Schema.Struct({ messageID: SessionMessage.ID.check(Schema.isMinLength(1), Schema.isMaxLength(128)), callID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256), Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/u)) }),
      success: Schema.Struct({ data: Mcp.AppView.pipe(Schema.optional) }),
      error: [SessionNotFoundError, ForbiddenError, ServiceUnavailableError],
    }).middleware(sessionLocationMiddleware).annotateMerge(OpenApi.annotations({
      identifier: "mcp.app.view",
      summary: "Read the App for a Session tool result",
      description: "A missing view leaves the original tool result readable. The request cannot select an MCP server or resource URI.",
    })),
  )
