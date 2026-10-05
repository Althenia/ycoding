import { Effect, Schedule } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { ServerInfo } from "../server-info"
import { Database } from "@ycoding-ai/core/database/database"
import { WebLatency } from "@ycoding-ai/core/web-latency"
import { InvalidCursorError, InvalidRequestError } from "@ycoding-ai/protocol/errors"

export const ServerHandler = HttpApiBuilder.group(Api, "server.server", (handlers) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* WebLatency.prune(database.db)
    yield* Effect.sleep("1 hour").pipe(
      Effect.andThen(WebLatency.prune(database.db)),
      Effect.catchCause(() => Effect.logWarning("Could not prune expired Web latency samples")),
      Effect.repeat(Schedule.forever),
      Effect.forkScoped({ startImmediately: true }),
    )
    return handlers
      .handle("server.get", () =>
        Effect.gen(function* () {
          const info = yield* ServerInfo.Service
          return { urls: info.urls() }
        }),
      )
      .handle("telemetry.append", (ctx) =>
        Effect.gen(function* () {
          const valid = ctx.payload.samples.every((sample) => {
            const time = Date.parse(sample.at)
            if (!Number.isFinite(time) || new Date(time).toISOString() !== sample.at) return false
            if (sample.kind === "long-task") return true
            return (
              (sample.reason === undefined || sample.outcome === "unavailable") &&
              (sample.settlementMs === undefined
                ? sample.queueMs === sample.totalMs
                : sample.queueMs + sample.settlementMs === sample.totalMs)
            )
          })
          if (!valid) return yield* new InvalidRequestError({ message: "Invalid telemetry sample", field: "samples" })
          const database = yield* Database.Service
          return yield* WebLatency.append(database.db, ctx.payload.samples)
        }),
      )
      .handle("telemetry.list", (ctx) =>
        Effect.gen(function* () {
          const database = yield* Database.Service
          return yield* WebLatency.list(database.db, ctx.query).pipe(
            Effect.catchTag(
              "WebLatency.InvalidCursorError",
              () => new InvalidCursorError({ message: "Invalid telemetry cursor" }),
            ),
          )
        }),
      )
  }),
)
