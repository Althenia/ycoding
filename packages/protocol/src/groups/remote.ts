import { Remote } from "@ycoding-ai/schema/remote"
export { Remote } from "@ycoding-ai/schema/remote"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const RemoteGroup = HttpApiGroup.make("server.remote")
  .add(
    HttpApiEndpoint.get("remote.get", "/api/remote", {
      success: Schema.Struct({ data: Remote.Status }),
    }).annotateMerge(OpenApi.annotations({
      identifier: "remote.get",
      summary: "Get machine remote connection",
      description: "Read the server-hosted remote connector state for this machine.",
    })),
  )
  .add(
    HttpApiEndpoint.put("remote.set", "/api/remote", {
      payload: Schema.Struct({ enabled: Schema.Boolean }),
      success: Schema.Struct({ data: Remote.Status }),
    }).annotateMerge(OpenApi.annotations({
      identifier: "remote.set",
      summary: "Set machine remote connection",
      description: "Persist the machine remote switch and start or stop this server's connector.",
    })),
  )
  .add(
    HttpApiEndpoint.get("remote.mcp.get", "/api/remote/mcp", {
      success: Schema.Struct({ data: Remote.McpStatus }),
    }).annotateMerge(OpenApi.annotations({
      identifier: "remote.mcp.get",
      summary: "Get machine relay MCP access",
      description: "Read the server-owned relay MCP state and device resource URL.",
    })),
  )
  .add(
    HttpApiEndpoint.put("remote.mcp.set", "/api/remote/mcp", {
      payload: Schema.Struct({ enabled: Schema.Boolean }),
      success: Schema.Struct({ data: Remote.McpStatus }),
    }).annotateMerge(OpenApi.annotations({
      identifier: "remote.mcp.set",
      summary: "Set machine relay MCP access",
      description: "Persist relay MCP enablement. Remote must be connected; disabling revokes client grants.",
    })),
  )
  .annotateMerge(OpenApi.annotations({ title: "remote" }))
