import { Config } from "@ycoding-ai/core/config"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { requestRef, response } from "../location"

export const ConfigHandler = HttpApiBuilder.group(Api, "server.config", (handlers) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    return handlers.handle(
      "config.diagnostics",
      Effect.fn(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* response(Config.Service.use((config) => config.diagnostics())).pipe(
          Effect.provide(locations.get(requestRef(request), [Location.node, Config.node])),
        )
      }),
    )
  }),
)
