import { Effect } from "effect"
import { define } from "@ycoding-ai/plugin/effect/plugin"
import { ProviderV2 } from "../../provider"

export const KiloPlugin = define({
  id: "ycoding.provider.kilo",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform((evt) => {
      for (const item of evt.provider.list()) {
        if (!ProviderV2.isAISDK(item.provider.package)) continue
        if (ProviderV2.packageName(item.provider.package) !== "@ai-sdk/openai-compatible") continue
        if (item.provider.settings?.baseURL !== "https://api.kilo.ai/api/gateway") continue
        evt.provider.update(item.provider.id, (provider) => {
          provider.headers = { ...provider.headers, "X-Title": "YCoding" }
        })
      }
    })
  }),
})
