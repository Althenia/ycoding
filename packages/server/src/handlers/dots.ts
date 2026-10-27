import { DotsAccess } from "@ycoding-ai/core/dots/access"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ConflictError, InvalidRequestError, SessionNotFoundError } from "@ycoding-ai/protocol/errors"
import { Api } from "../api"

export const DotsHandler = HttpApiBuilder.group(Api, "server.dots", (handlers) =>
  handlers
    .handle("session.dots.access.get", Effect.fn(function* (ctx) {
      const access = yield* DotsAccess.Service
      return { data: yield* access.get(ctx.params.sessionID).pipe(Effect.mapError(() =>
        new SessionNotFoundError({ sessionID: ctx.params.sessionID, message: "Session Dots access is unavailable" }))) }
    }))
    .handle("session.dots.access.set", Effect.fn(function* (ctx) {
      const access = yield* DotsAccess.Service
      return { data: yield* access.set({ ...ctx.payload, sessionID: ctx.params.sessionID }).pipe(Effect.mapError((error) =>
        error.code === "conflict" ? new ConflictError({ message: error.message, resource: ctx.params.sessionID }) :
          error.code === "root_required" ? new InvalidRequestError({ message: error.message, field: "sessionID" }) :
            new SessionNotFoundError({ sessionID: ctx.params.sessionID, message: error.message }))) }
    })),
)
