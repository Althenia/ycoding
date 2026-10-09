import { Config } from "@ycoding-ai/core/config"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const ConfigHandler = HttpApiBuilder.group(Api, "server.config", (handlers) =>
  handlers.handle(
    "config.diagnostics",
    Effect.fn(function* () {
      const config = yield* Config.Service
      return yield* response(config.diagnostics())
    }),
  ),
)
