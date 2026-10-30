import { DotsAccess } from "@ycoding-ai/core/dots/access"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ConflictError, InvalidRequestError } from "@ycoding-ai/protocol/errors"
import { Api } from "../api"

export const DotsHandler = HttpApiBuilder.group(Api, "server.dots", (handlers) =>
  handlers
    .handle("dots.get", Effect.fn(function* () {
      const access = yield* DotsAccess.Service
      return { data: yield* access.status().pipe(Effect.mapError((error) => new InvalidRequestError({ message: error.message }))) }
    }))
    .handle("dots.set", Effect.fn(function* (ctx) {
      const access = yield* DotsAccess.Service
      yield* access.set(ctx.payload).pipe(Effect.mapError((error) => error.code === "conflict"
        ? new ConflictError({ message: error.message, resource: "dots" }) : new InvalidRequestError({ message: error.message })))
      return { data: yield* access.status().pipe(Effect.mapError((error) => new InvalidRequestError({ message: error.message }))) }
    }))
    .handle("dots.attach", Effect.fn(function* (ctx) {
      const access = yield* DotsAccess.Service
      return { data: yield* access.attachComputer(ctx.payload.expectedTarget).pipe(Effect.mapError((error) => new InvalidRequestError({ message: error.message }))) }
    })),
)
