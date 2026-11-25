import { MCP } from "@ycoding-ai/core/mcp/index"
import { Session } from "@ycoding-ai/core/session"
import { McpServerNotFoundError, SessionNotFoundError } from "@ycoding-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

const notFound = <A, R>(effect: Effect.Effect<A, MCP.NotFoundError, R>) =>
  effect.pipe(Effect.mapError((error) => new McpServerNotFoundError({ server: error.server, message: error.message })))

export const McpHandler = HttpApiBuilder.group(Api, "server.mcp", (handlers) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return handlers
      .handle(
        "mcp.list",
        Effect.fn(function* () {
          const service = yield* MCP.Service
          return yield* response(
            service
              .servers()
              .pipe(
                Effect.map((servers) =>
                  servers.map((info) => ({ name: info.name, status: info.status, integrationID: info.integrationID })),
                ),
              ),
          )
        }),
      )
      .handle(
        "mcp.add",
        Effect.fn(function* (ctx) {
          const service = yield* MCP.Service
          yield* service.add(ctx.params.server, ctx.payload.config)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "mcp.remove",
        Effect.fn(function* (ctx) {
          const service = yield* MCP.Service
          yield* notFound(service.remove(ctx.params.server))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "mcp.connect",
        Effect.fn(function* (ctx) {
          const service = yield* MCP.Service
          yield* notFound(service.connect(ctx.params.server))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "mcp.disconnect",
        Effect.fn(function* (ctx) {
          const service = yield* MCP.Service
          yield* notFound(service.disconnect(ctx.params.server))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "mcp.resource.catalog",
        Effect.fn(function* () {
          const service = yield* MCP.Service
          return yield* response(service.resourceCatalog())
        }),
      )
      .handle("mcp.app.view", Effect.fn(function* (ctx) {
        const service = yield* MCP.Service
        const sessionID = ctx.params.sessionID
        const session = yield* sessions.get(sessionID).pipe(Effect.mapError(() =>
          new SessionNotFoundError({ sessionID, message: "Session not found" }),
        ))
        if (session.time.archived !== undefined) return {}
        const message = yield* sessions.message({ sessionID, messageID: ctx.query.messageID })
        if (message?.type !== "assistant") return {}
        const calls = message.content.filter((part) => part.type === "tool" && part.id === ctx.query.callID)
        const call = calls[0]
        if (calls.length !== 1 || call?.type !== "tool" || call.state.status !== "completed") return {}
        const data = yield* service.appView({ sessionID, ...ctx.query })
        return data === undefined ? {} : { data }
      }))
  }),
)
