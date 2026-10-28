import { Effect } from "effect"
import { define } from "../catalog-host"
import { Provider } from "../../provider"

export const ZenmuxPlugin = define({
  id: "ycoding.provider.zenmux",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform((evt) => {
      for (const item of evt.provider.list()) {
        if (!Provider.isAISDK(item.provider.package)) continue
        if (Provider.packageName(item.provider.package) !== "@ai-sdk/openai-compatible") continue
        if (item.provider.settings?.baseURL !== "https://zenmux.ai/api/v1") continue
        evt.provider.update(item.provider.id, (provider) => {
          provider.headers = {
            "X-Title": "YCoding",
            ...provider.headers,
          }
        })
      }
    })
  }),
})
