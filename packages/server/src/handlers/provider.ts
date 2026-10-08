import { Catalog } from "@ycoding-ai/core/catalog"
import { Config } from "@ycoding-ai/core/config"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { ProviderNotFoundError } from "@ycoding-ai/protocol/errors"
import { response } from "../location"
import { Policy } from "@ycoding-ai/core/policy"
import { Integration } from "@ycoding-ai/core/integration"
import { PluginSupervisor } from "@ycoding-ai/core/plugin/supervisor"
import { ServiceUnavailableError } from "@ycoding-ai/protocol/errors"

export const ProviderHandler = HttpApiBuilder.group(Api, "server.provider", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "provider.integrations",
        Effect.fn(function* () {
          const plugins = yield* PluginSupervisor.Service
          yield* plugins.flush.pipe(Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(new ServiceUnavailableError({ message: "Provider integrations initialization timed out", service: "provider.integrations" })) }))
          const catalog = yield* Catalog.Service
          const policy = yield* Policy.Service
          const definitions = yield* catalog.provider.all()
          return yield* response(Effect.forEach(definitions.filter((provider) => !provider.disabled), (provider) => policy.evaluate("provider.use", provider.id, "allow").pipe(
            Effect.map((effect) => effect === "deny" ? undefined : { providerID: provider.id, integrationID: provider.integrationID ?? Integration.ID.make(provider.id) }),
          )).pipe(Effect.map((items) => items.filter((item) => item !== undefined))))
        }),
      )
      .handle(
        "provider.list",
        Effect.fn(function* () {
          const catalog = yield* Catalog.Service
          return yield* response(catalog.provider.available())
        }),
      )
      .handle(
        "provider.refresh",
        Effect.fn(function* () {
          const config = yield* Config.Service
          yield* config.reload()
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "provider.get",
        Effect.fn(function* (ctx) {
          const catalog = yield* Catalog.Service
          const provider = yield* catalog.provider.get(ctx.params.providerID)
          if (!provider)
            return yield* new ProviderNotFoundError({
              providerID: ctx.params.providerID,
              message: `Provider not found: ${ctx.params.providerID}`,
            })
          return yield* response(Effect.succeed(provider))
        }),
      )
  }),
)
