import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { RemoteConnection } from "../remote-connection"

export const RemoteHandler = HttpApiBuilder.group(Api, "server.remote", (handlers) =>
  Effect.gen(function* () {
    const remote = yield* RemoteConnection.Service
    return handlers
      .handle("remote.get", () => Effect.promise(() => remote.status()).pipe(Effect.map((data) => ({ data }))))
      .handle("remote.set", (ctx) => Effect.promise(() => remote.set(ctx.payload.enabled)).pipe(Effect.map((data) => ({ data }))))
      .handle("remote.mcp.get", () => Effect.promise(() => remote.mcpStatus()).pipe(Effect.map((data) => ({ data }))))
      .handle("remote.mcp.set", (ctx) => Effect.promise(() => remote.setMcp(ctx.payload.enabled)).pipe(Effect.map((data) => ({ data }))))
  }),
)
