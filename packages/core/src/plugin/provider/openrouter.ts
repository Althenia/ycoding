import { Effect } from "effect"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { define } from "@ycoding-ai/plugin/effect/plugin"

export const OpenRouterPlugin = define({
  id: "ycoding.provider.openrouter",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform((evt) => {
      for (const item of evt.provider.list()) {
        if (!ProviderV2.isAISDK(item.provider.package)) continue
        if (ProviderV2.packageName(item.provider.package) !== "@openrouter/ai-sdk-provider") continue
        evt.provider.update(item.provider.id, (provider) => {
          provider.headers = { ...provider.headers, "X-Title": "YCoding" }
        })
        for (const modelID of [ModelV2.ID.make("gpt-5-chat-latest"), ModelV2.ID.make("openai/gpt-5-chat")]) {
          if (!item.models.has(modelID)) continue
          evt.model.update(item.provider.id, modelID, (model) => {
            // These are OpenRouter-specific OpenAI chat aliases that do not work
            // on the generic path. Keep custom providers with matching IDs untouched.
            model.enabled = false
          })
        }
      }
    })
    yield* ctx.aisdk.hook(
      "sdk",
      Effect.fn(function* (evt) {
        if (evt.package !== "@openrouter/ai-sdk-provider") return
        const apiKey =
          typeof evt.options.apiKey === "string" && evt.options.apiKey.length > 0 ? evt.options.apiKey : undefined
        if (apiKey) {
          const upstream = typeof evt.options.fetch === "function" ? evt.options.fetch : fetch
          evt.options.fetch = Object.assign(
            async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
              const headers = new Headers(init?.headers)
              headers.set("Authorization", `Bearer ${apiKey}`)
              return upstream(input, { ...init, headers })
            },
            { preconnect: upstream.preconnect ?? fetch.preconnect },
          )
        }
        const mod = yield* Effect.promise(() => import("@openrouter/ai-sdk-provider"))
        evt.sdk = mod.createOpenRouter(evt.options)
      }),
    )
  }),
})
