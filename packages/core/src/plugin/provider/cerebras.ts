import { Effect } from "effect"
import { define } from "@ycoding-ai/plugin/effect/plugin"
import { ProviderV2 } from "../../provider"

export const CerebrasPlugin = define({
  id: "ycoding.provider.cerebras",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform((evt) => {
      for (const item of evt.provider.list()) {
        if (!ProviderV2.isAISDK(item.provider.package)) continue
        if (ProviderV2.packageName(item.provider.package) !== "@ai-sdk/cerebras") continue
        evt.provider.update(item.provider.id, (provider) => {
          provider.headers = { ...provider.headers, "X-Cerebras-3rd-Party-Integration": "ycoding" }
        })
      }
    })
    yield* ctx.aisdk.hook(
      "sdk",
      Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/cerebras") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/cerebras"))
        evt.sdk = mod.createCerebras(evt.options)
      }),
    )
  }),
})
