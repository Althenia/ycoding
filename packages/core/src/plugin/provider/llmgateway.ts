import { Effect } from "effect"
import { define } from "@ycoding-ai/plugin/effect/plugin"
import { Integration } from "../../integration"
import { ProviderV2 } from "../../provider"

export const LLMGatewayPlugin = define({
  id: "ycoding.provider.llmgateway",
  effect: Effect.fn(function* (ctx) {
    const integrations = yield* Integration.Service
    const configured = new Set((yield* integrations.list()).map((integration) => integration.id))
    yield* ctx.catalog.transform((evt) => {
      for (const item of evt.provider.list()) {
        if (item.provider.disabled) continue
        if (!ProviderV2.isAISDK(item.provider.package)) continue
        if (ProviderV2.packageName(item.provider.package) !== "@ai-sdk/openai-compatible") continue
        if (item.provider.settings?.baseURL !== "https://api.llmgateway.io/v1") continue
        if (!configured.has(Integration.ID.make(item.provider.id))) continue
        evt.provider.update(item.provider.id, (provider) => {
          provider.headers = {
            ...provider.headers,
            "X-Title": "YCoding",
            "X-Source": "YCoding",
          }
        })
      }
    })
  }),
})
