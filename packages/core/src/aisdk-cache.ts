export * as AISDKCache from "./aisdk-cache"

import type { SharedV3ProviderOptions } from "@ai-sdk/provider"
import type { CacheHint } from "@ycoding-ai/ai"

const ttl = (hint: CacheHint) => (hint.ttlSeconds !== undefined && hint.ttlSeconds >= 3_600 ? "1h" : "5m")

export const options = (routeID: string, hint: CacheHint | undefined): SharedV3ProviderOptions | undefined => {
  if (!hint) return
  if (routeID === "ai-sdk:@ai-sdk/anthropic" || routeID === "ai-sdk:@ai-sdk/google-vertex/anthropic")
    return { anthropic: { cacheControl: { type: "ephemeral", ttl: ttl(hint) } } }
  if (routeID === "ai-sdk:@openrouter/ai-sdk-provider")
    return { openrouter: { cacheControl: { type: "ephemeral", ttl: ttl(hint) } } }
  if (routeID === "ai-sdk:@ai-sdk/amazon-bedrock")
    return { bedrock: { cachePoint: { type: "default", ttl: ttl(hint) } } }
}

export const merge = (
  left: SharedV3ProviderOptions | undefined,
  right: SharedV3ProviderOptions | undefined,
): SharedV3ProviderOptions | undefined => {
  if (!left) return right
  if (!right) return left
  return Object.fromEntries(
    new Set([...Object.keys(left), ...Object.keys(right)]).values().map((key) => [
      key,
      { ...(left[key] ?? {}), ...(right[key] ?? {}) },
    ]),
  )
}
