import { McpEvents } from "@ycoding-ai/schema/mcp-events"
export { McpEvents } from "@ycoding-ai/schema/mcp-events"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const SubscribeRequest = Schema.Struct({
  context: McpEvents.RequestContext,
  subscription: McpEvents.Subscribe,
})

export const UnsubscribeRequest = Schema.Struct({
  context: McpEvents.RequestContext,
  subscription: McpEvents.Unsubscribe,
})

export const ListQuery = Schema.Struct({ cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))) })

const failure = McpEvents.Failure.annotate({ identifier: "McpEventsFailure", httpApiStatus: 400 })

export const McpEventsGroup = HttpApiGroup.make("server.mcpEvents")
  .add(
    HttpApiEndpoint.get("mcpEvents.status", "/api/remote/mcp/events/status", {
      success: Schema.Struct({ data: Schema.Struct({ available: Schema.Boolean }) }),
    }).annotateMerge(OpenApi.annotations({
      identifier: "mcpEvents.status",
      summary: "Get relay MCP Events availability",
      description: "Read whether the local runtime can authorize MCP Events subscriptions.",
    })),
  )
  .add(
    HttpApiEndpoint.get("mcpEvents.list", "/api/remote/mcp/events/catalog", {
      query: ListQuery,
      success: Schema.Struct({ data: McpEvents.ListResult }),
    }).annotateMerge(OpenApi.annotations({
      identifier: "mcpEvents.list",
      summary: "List relay MCP Events",
      description: "Read the event catalog from the local runtime.",
    })),
  )
  .add(
    HttpApiEndpoint.post("mcpEvents.subscribe", "/api/remote/mcp/events/subscribe", {
      payload: SubscribeRequest,
      success: Schema.Struct({ data: McpEvents.Subscription }),
      error: failure,
    }).annotateMerge(OpenApi.annotations({
      identifier: "mcpEvents.subscribe",
      summary: "Subscribe to relay MCP Events",
      description: "Validate the relay request context and register a Session event webhook.",
    })),
  )
  .add(
    HttpApiEndpoint.post("mcpEvents.unsubscribe", "/api/remote/mcp/events/unsubscribe", {
      payload: UnsubscribeRequest,
      success: Schema.Struct({ data: Schema.Struct({}) }),
      error: failure,
    }).annotateMerge(OpenApi.annotations({
      identifier: "mcpEvents.unsubscribe",
      summary: "Unsubscribe from relay MCP Events",
      description: "Validate the relay request context and cancel a Session event webhook.",
    })),
  )
  .annotateMerge(OpenApi.annotations({ title: "mcp-events" }))
