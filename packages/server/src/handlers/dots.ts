import { DotsRuntime } from "@ycoding-ai/core/dots"
import { DotsExchange } from "@ycoding-ai/core/dots/exchange"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InvalidRequestError } from "@ycoding-ai/protocol/errors"
import { Api } from "../api"

const failure = (error: DotsRuntime.Error) => new InvalidRequestError({
  field: "dots", message: error.message,
  ...(error.code === "exchange_outcome_unknown" ? { kind: "outcome_unknown" } : {}),
})

export const DotsHandler = HttpApiBuilder.group(Api, "server.dots", (handlers) =>
  handlers
    .handle(
      "session.dots.exchange.create",
      Effect.fn(function* (ctx) {
        const exchanges = yield* DotsExchange.service
        return { data: yield* exchanges.create({ ...ctx.payload, sessionID: ctx.params.sessionID }).pipe(Effect.mapError(failure)) }
      }),
    )
    .handle(
      "session.dots.exchange.read",
      Effect.fn(function* (ctx) {
        const exchanges = yield* DotsExchange.service
        return { data: yield* exchanges.read({ ...ctx.payload, sessionID: ctx.params.sessionID }).pipe(Effect.mapError(failure)) }
      }),
    )
    .handle(
      "session.dots.targets",
      Effect.fn(function* (ctx) {
        const dots = yield* DotsRuntime.Service
        return { data: yield* dots.targets(ctx.query.profile).pipe(Effect.mapError(failure)) }
      }),
    )
    .handle(
      "session.dots.status",
      Effect.fn(function* (ctx) {
        const dots = yield* DotsRuntime.Service
        return { data: yield* dots.status(ctx.params.sessionID).pipe(Effect.mapError(failure)) }
      }),
    )
    .handle(
      "session.dots.bind",
      Effect.fn(function* (ctx) {
        const dots = yield* DotsRuntime.Service
        return {
          data: yield* dots
            .bind({ sessionID: ctx.params.sessionID, target: ctx.payload })
            .pipe(Effect.mapError(failure)),
        }
      }),
    )
    .handle(
      "session.dots.send",
      Effect.fn(function* (ctx) {
        const dots = yield* DotsRuntime.Service
        return {
          data: yield* dots.send({ ...ctx.payload, sessionID: ctx.params.sessionID }).pipe(Effect.mapError(failure)),
        }
      }),
    )
    .handle(
      "session.dots.pause",
      Effect.fn(function* (ctx) {
        const dots = yield* DotsRuntime.Service
        return {
          data: yield* dots
            .pause({ sessionID: ctx.params.sessionID, expectedTarget: ctx.payload.expectedTarget })
            .pipe(Effect.mapError(failure)),
        }
      }),
    )
    .handle(
      "session.dots.resume",
      Effect.fn(function* (ctx) {
        const dots = yield* DotsRuntime.Service
        return {
          data: yield* dots
            .resume({ sessionID: ctx.params.sessionID, expectedTarget: ctx.payload.expectedTarget })
            .pipe(Effect.mapError(failure)),
        }
      }),
    ),
)
