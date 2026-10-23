import { CoordinationService } from "@ycoding-ai/core/coordination/index"
import { CoordinationSettings } from "@ycoding-ai/core/coordination-settings"
import { CoordinationError } from "@ycoding-ai/protocol/groups/coordination"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

const response = <A, E extends { readonly _tag: string; readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.map((data) => ({ data })), Effect.mapError((error) => new CoordinationError({ reason: error._tag, message: error.message })))

export const CoordinationHandler = HttpApiBuilder.group(Api, "server.coordination", (handlers) => Effect.gen(function* () {
  const coordination = yield* CoordinationService.Service
  const settings = yield* CoordinationSettings.Service
  const human = { kind: "human" as const }
  return handlers
    .handle("coordination.settings", () => response(settings.read()))
    .handle("coordination.list", () => response(coordination.list({})))
    .handle("coordination.get", (ctx) => response(Effect.gen(function* () {
      const group = yield* coordination.get(ctx.params.groupID)
      const claims = yield* coordination.claims({ groupID: ctx.params.groupID })
      const dispatches = yield* coordination.dispatches({ groupID: ctx.params.groupID })
      return { ...group, claims, dispatches }
    })))
    .handle("coordination.create", (ctx) => response(coordination.create(human, ctx.payload)))
    .handle("coordination.members", (ctx) => response(coordination.updateRoster(human, {
      groupID: ctx.params.groupID, expectedRevision: ctx.payload.revision, name: ctx.payload.name, members: ctx.payload.members, policy: ctx.payload.policy,
    })))
    .handle("coordination.arm", (ctx) => response(coordination.arm(human, { groupID: ctx.params.groupID, expectedRevision: ctx.payload.revision })))
    .handle("coordination.stop", (ctx) => response(coordination.stop(human, { groupID: ctx.params.groupID, expectedRevision: ctx.payload.revision })))
    .handle("coordination.complete", (ctx) => response(coordination.complete(human, { groupID: ctx.params.groupID, expectedRevision: ctx.payload.revision })))
    .handle("coordination.claim", (ctx) => response(coordination.claim({ kind: "coordinator", sessionID: ctx.payload.holderSessionID }, {
      groupID: ctx.params.groupID, expectedRevision: ctx.payload.revision, targetSessionID: ctx.payload.targetSessionID, leaseMs: ctx.payload.leaseMs,
    })))
    .handle("coordination.release", (ctx) => response(coordination.release({ kind: "coordinator", sessionID: ctx.payload.holderSessionID }, {
      groupID: ctx.params.groupID, expectedRevision: ctx.payload.revision, targetSessionID: ctx.payload.targetSessionID, generation: ctx.payload.generation,
    })))
    .handle("coordination.dispatch", (ctx) => response(coordination.dispatch({ kind: "coordinator", sessionID: ctx.payload.holderSessionID }, {
      ...ctx.payload, groupID: ctx.params.groupID, expectedRevision: ctx.payload.revision,
    })))
    .handle("coordination.receipts", (ctx) => response(coordination.receipts({ groupID: ctx.params.groupID })))
    .handle("coordination.wait", (ctx) => response(coordination.wait({ kind: "coordinator", sessionID: ctx.payload.holderSessionID }, {
      ...ctx.payload, groupID: ctx.params.groupID, expectedRevision: ctx.payload.revision,
    })))
    .handle("coordination.cancelWait", (ctx) => response(coordination.cancelWait({ kind: "coordinator", sessionID: ctx.payload.holderSessionID }, {
      groupID: ctx.params.groupID, expectedRevision: ctx.payload.revision, waitID: ctx.payload.waitID,
    })))
    .handle("coordination.capacity", (ctx) => response(coordination.capacity(ctx.params.groupID)))
}))
