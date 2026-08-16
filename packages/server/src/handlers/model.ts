import { Catalog } from "@ycoding-ai/core/catalog"
import { PluginSupervisor } from "@ycoding-ai/core/plugin/supervisor"
import { ServiceUnavailableError } from "@ycoding-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const ModelHandler = HttpApiBuilder.group(Api, "server.model", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "model.list",
        Effect.fn(function* () {
          const catalog = yield* Catalog.Service
          return yield* response(catalog.model.available())
        }),
      )
      .handle(
        "model.default",
        Effect.fn(function* () {
          const plugins = yield* PluginSupervisor.Service
          yield* plugins.flush.pipe(
            Effect.timeoutOrElse({
              duration: "5 seconds",
              orElse: () =>
                Effect.fail(
                  new ServiceUnavailableError({
                    message: "Model catalog initialization timed out",
                    service: "model.catalog",
                  }),
                ),
            }),
          )
          const catalog = yield* Catalog.Service
          return yield* response(catalog.model.default())
        }),
      )
  }),
)
