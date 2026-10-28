import { Effect } from "effect"
import { define } from "../catalog-host"

export const GatewayPlugin = define({
  id: "ycoding.provider.gateway",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.aisdk.hook(
      "sdk",
      Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/gateway") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/gateway"))
        evt.sdk = mod.createGateway(evt.options)
      }),
    )
  }),
})
