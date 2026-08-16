export * as SessionCacheDiagnostics from "./cache-diagnostics"

import { cacheProfile } from "@ycoding-ai/ai/cache-profile"
import { Session } from "@ycoding-ai/schema/session"
import { Money } from "@ycoding-ai/schema/money"
import type { TokenUsage } from "@ycoding-ai/schema/token-usage"
import type { ModelV2 } from "../model"
import { OpenAICodex } from "../plugin/provider/openai-codex"
import type { SessionMessage } from "./message"

export interface CalculateInput {
  readonly model: ModelV2.Ref
  readonly tokens: TokenUsage.Info
  readonly estimatedCost: Money.USD
  readonly contextLimit?: number
  readonly routeID?: string
  readonly providerCache?: Session.ProviderCacheDiagnostics
}

const safe = (value: number) => Math.max(0, Number.isFinite(value) ? value : 0)

// Route id → cache mechanism. Native protocol routes (`anthropic-messages`,
// `openrouter`, `google-vertex-*`, …) and the AI SDK adapter routes both land
// here, so a provider added on one path does not silently report `none` on the
// other. Keep in sync with `@ycoding-ai/ai`'s cache-policy route sets.
const ROUTE_MECHANISMS: Record<string, Session.CacheMechanism | undefined> = {
  "anthropic-messages": "anthropic-cache-control",
  "google-vertex-messages": "anthropic-cache-control",
  "ai-sdk:@ai-sdk/anthropic": "anthropic-cache-control",
  "ai-sdk:@ai-sdk/google-vertex/anthropic": "anthropic-cache-control",
  openrouter: "openrouter-cache-control",
  "ai-sdk:@openrouter/ai-sdk-provider": "openrouter-cache-control",
  "bedrock-converse": "bedrock-cache-point",
  "ai-sdk:@ai-sdk/amazon-bedrock": "bedrock-cache-point",
  "openai-chat": "openai-prefix-cache",
  "openai-responses": "openai-prefix-cache",
  "openai-responses-websocket": "openai-prefix-cache",
  "github-copilot-chat": "openai-prefix-cache",
  "github-copilot-responses": "openai-prefix-cache",
  [OpenAICodex.routeID]: "openai-prefix-cache",
  "openai-compatible-chat": "openai-prefix-cache",
  "openai-compatible-responses": "openai-prefix-cache",
  "azure-openai-chat": "openai-prefix-cache",
  "azure-openai-responses": "openai-prefix-cache",
  "google-vertex-chat": "openai-prefix-cache",
  "google-vertex-responses": "openai-prefix-cache",
  "cloudflare-ai-gateway": "openai-prefix-cache",
  "cloudflare-workers-ai": "openai-prefix-cache",
  "ai-sdk:@ai-sdk/openai": "openai-prefix-cache",
  "ai-sdk:@ai-sdk/azure": "openai-prefix-cache",
  gemini: "gemini-prefix-cache",
  "google-vertex-gemini": "gemini-prefix-cache",
  "ai-sdk:@ai-sdk/google": "gemini-prefix-cache",
  "ai-sdk:@ai-sdk/google-vertex": "gemini-prefix-cache",
}

export function mechanism(
  routeID: string,
  model: ModelV2.Ref,
  tokens: TokenUsage.Info,
): Session.CacheMechanism {
  const known = ROUTE_MECHANISMS[routeID]
  if (known) return known
  if (routeID === "unknown") {
    switch (model.providerID) {
      case "openai":
      case "azure":
      case "github-copilot":
      case "ycoding":
        return "openai-prefix-cache"
      case "openrouter":
        return "openrouter-cache-control"
      case "anthropic":
        return "anthropic-cache-control"
      case "amazon-bedrock":
        return "bedrock-cache-point"
      case "google":
      case "google-vertex":
        return "gemini-prefix-cache"
    }
  }
  return tokens.cache.read > 0 || tokens.cache.write > 0 ? "provider-reported" : "none"
}

export function calculate(input: CalculateInput): Session.CacheDiagnostics {
  const uncachedInput = safe(input.tokens.input)
  const output = safe(input.tokens.output)
  const reasoning = safe(input.tokens.reasoning)
  const cacheRead = safe(input.tokens.cache.read)
  const cacheWrite = safe(input.tokens.cache.write)
  const total = uncachedInput + output + reasoning + cacheRead + cacheWrite
  const eligible = uncachedInput + cacheRead + cacheWrite
  const limit = input.contextLimit !== undefined && input.contextLimit > 0 ? Math.trunc(input.contextLimit) : undefined
  const readReported = input.providerCache?.readReported ?? cacheRead > 0
  const writeReported = input.providerCache?.writeReported ?? cacheWrite > 0
  const selectedMechanism =
    input.providerCache?.mechanism ?? mechanism(input.routeID ?? "unknown", input.model, input.tokens)
  // A prefix below the model's minimum is accepted and then ignored by the
  // provider, so surface the threshold instead of reporting a bare 0% ratio.
  const minimumTokens = cacheProfile(input.model.id)?.minimumTokens

  return {
    model: input.model,
    context: {
      total,
      ...(limit === undefined
        ? {}
        : {
            limit,
            remaining: Math.max(0, limit - total),
            percent: Math.round((total / limit) * 100),
          }),
    },
    tokens: { uncachedInput, output, reasoning, cacheRead, cacheWrite },
    cache: {
      eligible,
      ...(readReported && eligible > 0 ? { hitRatio: cacheRead / eligible } : {}),
      mechanism: selectedMechanism,
      readReported,
      writeReported,
      ...(minimumTokens === undefined ? {} : { minimumTokens, belowMinimum: eligible < minimumTokens }),
    },
    estimatedCost: input.estimatedCost,
  }
}

export function latestAssistant(
  messages: ReadonlyArray<SessionMessage.Info>,
  boundary?: SessionMessage.ID,
): (SessionMessage.Assistant & { readonly tokens: TokenUsage.Info }) | undefined {
  const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1
  if (boundary && boundaryIndex === -1) return undefined
  const end = boundaryIndex === -1 ? messages.length : boundaryIndex
  const compactionIndex = messages.findLastIndex(
    (message, index) => message.type === "compaction" && message.status === "completed" && index < end,
  )
  return messages.findLast(
    (message, index): message is SessionMessage.Assistant & { readonly tokens: TokenUsage.Info } =>
      message.type === "assistant" && message.tokens !== undefined && index > compactionIndex && index < end,
  )
}

export function fromMessages(
  messages: ReadonlyArray<SessionMessage.Info>,
  boundary?: SessionMessage.ID,
): Session.CacheDiagnostics | undefined {
  const last = latestAssistant(messages, boundary)
  if (!last) return undefined
  return calculate({
    model: last.model,
    tokens: last.tokens,
    estimatedCost: last.cost ?? Money.USD.zero,
    contextLimit: last.diagnostics?.contextLimit,
    providerCache: last.diagnostics?.providerCache,
  })
}
