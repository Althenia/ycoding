import { Config } from "@ycoding-ai/core/config"
import { ConfigError } from "@ycoding-ai/core/config/error"
import { ConfigInvalidError } from "@ycoding-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

/**
 * Core reports configuration rejection through `ConfigInvalidError`, whose `data` may carry a
 * document path and schema issues. The public error keeps the actionable reason and drops the
 * `issues` payload, which can echo configuration structure the client did not ask for.
 */
export const configError = (error: ConfigError.InvalidErrorType) =>
  new ConfigInvalidError({
    message: error.data.message ?? "invalid configuration",
    path: error.data.path,
  })

export const ConfigHandler = HttpApiBuilder.group(Api, "server.config", (handlers) =>
  handlers
    .handle(
      "config.get",
      Effect.fn(function* () {
        const config = yield* Config.Service
        return yield* response(config.read())
      }),
    )
    .handle(
      "config.preview",
      Effect.fn(function* (ctx) {
        const config = yield* Config.Service
        return yield* response(config.preview(ctx.payload).pipe(Effect.mapError(configError)))
      }),
    )
    .handle(
      "config.commit",
      Effect.fn(function* (ctx) {
        const config = yield* Config.Service
        return yield* response(config.commit(ctx.payload).pipe(Effect.mapError(configError)))
      }),
    ),
)
