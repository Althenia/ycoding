import { ProviderUsageRuntime } from "@ycoding-ai/core/provider-usage"
import { Provider } from "@ycoding-ai/core/provider"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const listProviderUsage = (
  usage: ProviderUsageRuntime.Interface,
  refresh: boolean | undefined,
) => usage.list(refresh === undefined ? undefined : { refresh })

export const getProviderUsage = (
  usage: ProviderUsageRuntime.Interface,
  providerID: Provider.ID,
  refresh: boolean | undefined,
) => usage.get({ providerID, ...(refresh === undefined ? {} : { refresh }) })

export const ProviderUsageHandler = HttpApiBuilder.group(Api, "server.providerUsage", (handlers) =>
  handlers
    .handle(
      "providerUsage.list",
      Effect.fn(function* (ctx) {
        const usage = yield* ProviderUsageRuntime.Service
        return yield* response(listProviderUsage(usage, ctx.query.refresh))
      }),
    )
    .handle(
      "providerUsage.get",
      Effect.fn(function* (ctx) {
        const usage = yield* ProviderUsageRuntime.Service
        return yield* response(getProviderUsage(usage, ctx.params.providerID, ctx.query.refresh))
      }),
    ),
)
