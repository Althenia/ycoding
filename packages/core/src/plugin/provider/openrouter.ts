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
          provider.package = "@ycoding-ai/ai/providers/openrouter"
          // App attribution for OpenRouter rankings. User-supplied values win;
          // defaults fill in only when the user did not configure the header.
          provider.headers = {
            ...provider.headers,
            "HTTP-Referer": provider.headers?.["HTTP-Referer"] ?? "https://github.com/Althenia/ycoding",
            "X-OpenRouter-Title": provider.headers?.["X-OpenRouter-Title"] ?? "YCoding",
            "X-OpenRouter-Categories": provider.headers?.["X-OpenRouter-Categories"] ?? "cli-agent",
            "X-Title": "YCoding",
          }
        })
        for (const model of item.models.values()) {
          evt.model.update(item.provider.id, model.id, (draft) => {
            draft.package = "@ycoding-ai/ai/providers/openrouter"
          })
        }
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
