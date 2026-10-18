export * as McpEventsAuthorization from "./mcp-events-authorization"

import { Effect, Layer } from "effect"
import { SessionMcpEvents } from "@ycoding-ai/core/mcp-events/index"
import { McpEvents } from "@ycoding-ai/protocol/groups/mcp-events"
import type { RemoteConnection } from "./remote-connection"

const unavailable = () => new McpEvents.Failure({ category: "unavailable", reason: "authorization_unavailable" })
const failure = (error: unknown) => error instanceof McpEvents.Failure ? error : unavailable()

export function layer(remote: RemoteConnection.Interface) {
  return Layer.succeed(SessionMcpEvents.Authorization.Service, SessionMcpEvents.Authorization.Service.of({
    capabilities: Effect.tryPromise({
      try: () => remote.mcpEvents?.capabilities() ?? Promise.resolve(false),
      catch: failure,
    }).pipe(Effect.catch(() => Effect.succeed(false))),
    resolve: (context) => Effect.tryPromise({
      try: (signal) => remote.mcpEvents?.resolve(context, signal) ?? Promise.reject(unavailable()),
      catch: failure,
    }),
    check: (principal) => Effect.tryPromise({
      try: (signal) => remote.mcpEvents?.check(principal, signal) ?? Promise.reject(unavailable()),
      catch: failure,
    }),
  }))
}
