import { SessionMcpEvents } from "@ycoding-ai/core/mcp-events/index"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const McpEventsHandler = HttpApiBuilder.group(Api, "server.mcpEvents", (handlers) =>
  Effect.gen(function* () {
    const events = yield* SessionMcpEvents.Service
    return handlers
      .handle("mcpEvents.status", () => events.status().pipe(Effect.map((data) => ({ data }))))
      .handle("mcpEvents.list", (ctx) => events.list(ctx.query).pipe(Effect.map((data) => ({ data }))))
      .handle("mcpEvents.subscribe", (ctx) => events.subscribe(ctx.payload).pipe(Effect.map((data) => ({ data }))))
      .handle("mcpEvents.unsubscribe", (ctx) => events.unsubscribe(ctx.payload).pipe(Effect.map((data) => ({ data }))))
  }),
)
