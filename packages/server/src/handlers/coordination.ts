import { CoordinationService } from "@ycoding-ai/core/coordination/index"
import { CoordinationSettings } from "@ycoding-ai/core/coordination-settings"
import { CoordinationRuntime } from "@ycoding-ai/core/session/coordination-runtime"
import { CoordinationError } from "@ycoding-ai/protocol/groups/coordination"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

const failed = <E extends { readonly _tag: string; readonly message: string }>(error: E) =>
  new CoordinationError({ reason: error._tag, message: error.message })

const response = <A, E extends { readonly _tag: string; readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.map((data) => ({ data })), Effect.mapError(failed))

export const CoordinationHandler = HttpApiBuilder.group(Api, "server.coordination", (handlers) => Effect.gen(function* () {
  const coordination = yield* CoordinationService.Service
  const runtime = yield* CoordinationRuntime.Service
  const settings = yield* CoordinationSettings.Service
  return handlers
    .handle("coordination.settings", () => response(settings.read()))
    .handle("coordination.list", () => response(runtime.summaries()))
    .handle("coordination.get", (ctx) => response(runtime.get(ctx.params.groupID)))
    .handle("coordination.create", (ctx) => response(coordination.create(ctx.payload).pipe(Effect.flatMap((group) => runtime.get(group.id)))))
    .handle("coordination.update", (ctx) => response(coordination.update(ctx.params.groupID, ctx.payload).pipe(Effect.flatMap((group) => runtime.get(group.id)))))
    .handle("coordination.delete", (ctx) => coordination.delete(ctx.params.groupID).pipe(Effect.mapError(failed)))
}))
