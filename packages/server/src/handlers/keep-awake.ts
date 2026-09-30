import { KeepAwake } from "@ycoding-ai/core/keep-awake"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const KeepAwakeHandler = HttpApiBuilder.group(Api, "server.keepAwake", (handlers) =>
  Effect.gen(function* () {
    const keepAwake = yield* KeepAwake.Service
    return handlers
      .handle("keepAwake.get", () => keepAwake.get.pipe(Effect.map((data) => ({ data }))))
      .handle("keepAwake.set", (ctx) => keepAwake.set(ctx.payload.enabled).pipe(Effect.map((data) => ({ data }))))
  }),
)
