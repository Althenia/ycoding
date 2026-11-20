import { InteractionRuntime } from "@ycoding-ai/core/interaction/index"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Permission } from "@ycoding-ai/core/permission"
import type { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { ConflictError, ForbiddenError, SessionNotFoundError } from "@ycoding-ai/protocol/errors"
import { Effect, Option } from "effect"
import { HttpEffect, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const InteractionHandler = HttpApiBuilder.group(Api, "server.interaction", (handlers) =>
  Effect.gen(function* () {
    const interaction = yield* InteractionRuntime.Service
    const sessions = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const requireSession = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const session = yield* sessions.get(sessionID)
      if (!session) {
        interaction.revoke(sessionID)
        return yield* new SessionNotFoundError({ sessionID, message: "Session not found" })
      }
      if (session.scope !== "bound" || session.time.archived !== undefined) {
        interaction.revoke(sessionID)
        return yield* new ForbiddenError({ message: "Interaction is unavailable for this Session" })
      }
      return session
    })
    return handlers
      .handle("session.interaction.status", Effect.fnUntraced(function* (ctx) {
        yield* requireSession(ctx.params.sessionID)
        return { data: interaction.status(ctx.params.sessionID) }
      }))
      .handle("session.interaction.request", Effect.fnUntraced(function* (ctx) {
        yield* requireSession(ctx.params.sessionID)
        return { data: interaction.request(ctx.params.sessionID, ctx.payload) }
      }))
      .handle("session.interaction.preview", Effect.fnUntraced(function* (ctx) {
        const sessionID = ctx.params.sessionID
        const session = yield* requireSession(sessionID)
        const generation = ctx.query.generation
        yield* HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
        )
        const target = interaction.target(sessionID, generation)
        const withheld = { data: { state: "unavailable", generation } } as const
        if (!target) return withheld
        const pathname = target.kind === "macos-window" ? undefined : target.pathname
        const resource = target.kind === "macos-window" ? target.bundleID : target.origin + target.pathname
        const allowed = yield* Effect.gen(function* () {
          const permission = yield* Permission.Service
          for (const action of ["interaction", target.kind === "macos-window" ? "computer" : "browser_read"])
            if ((yield* permission.evaluateEffective({ sessionID, action, resource, agent: session.agent })) === "deny") return false
          return true
        }).pipe(Effect.provide(locations.get(session.location, [Permission.node])), Effect.option)
        if (Option.isNone(allowed) || !allowed.value) return withheld
        const data = yield* Effect.promise((signal) => interaction.preview(sessionID, generation, signal, pathname))
        return { data }
      }))
      .handle("session.interaction.stop", Effect.fnUntraced(function* (ctx) {
        yield* requireSession(ctx.params.sessionID)
        interaction.stop(ctx.params.sessionID, ctx.payload.generation)
        const data = interaction.status(ctx.params.sessionID)
        if (data.state !== "stopped" || data.generation !== ctx.payload.generation)
          return yield* new ConflictError({ message: "No Interaction matches this generation" })
        return { data }
      }))
  }),
)
