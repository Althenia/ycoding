export * as SessionRunnerCache from "./cache"

import type { CachePolicy, LLMRequest } from "@ycoding-ai/ai"
import { OPENAI_PROMPT_CACHE_READ_CANDIDATE_LIMIT } from "@ycoding-ai/ai/cache-policy"
import { cacheProfile } from "@ycoding-ai/ai/cache-profile"
import { OpenAIOptions } from "@ycoding-ai/ai/protocols/utils/openai-options"
import type { ConfigEfficiency } from "../../config/efficiency"
import type { PermissionV2 } from "../../permission"
import { Hash } from "../../util/hash"

export interface PromptCacheNamespaceInput {
  readonly scope?: "compaction"
  readonly projectID: string
  readonly directory: string
  readonly workspaceID?: string
  readonly providerID: string
  readonly modelID: string
  readonly variant: string
  readonly policyRevision: string
  readonly permissions: PermissionV2.Ruleset
  readonly system: LLMRequest["system"]
  readonly tools: LLMRequest["tools"]
}

export const systemDigest = (system: LLMRequest["system"]): string =>
  Hash.sha256(
    canonicalJson(
      system.map((part) => ({
        type: part.type,
        text: part.text,
        cache: part.cache ? { type: part.cache.type, ttlSeconds: part.cache.ttlSeconds } : undefined,
      })),
    ),
  )

export const toolDigest = (tools: LLMRequest["tools"]): string =>
  Hash.sha256(
    canonicalJson(
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        cache: tool.cache ? { type: tool.cache.type, ttlSeconds: tool.cache.ttlSeconds } : undefined,
        native: tool.native,
      })),
    ),
  )

export const PROMPT_CACHE_ROTATION_INTERVAL_MS = 10 * 60 * 1000

// Deprecated: rotation window is retained only for test compatibility;
// promptCacheNamespace is now stable and does not include a time window.
// New code should not depend on rotation.
export const promptCacheRotationWindow = (_now = Date.now()): number => 0

// Routes that wire `prompt_cache_key` through the provider request. Keep
// the set explicit so a new route does not silently inherit rotation before
// it has a verified cache capability.
const PROMPT_CACHE_KEY_ROUTES = new Set([
  "openai-chat",
  "openai-responses",
  "openai-responses-websocket",
  "openai-codex-responses",
  "openai-codex-websocket-responses",
  "openai-compatible-chat",
  "openai-compatible-responses",
  "github-copilot-chat",
  "github-copilot-responses",
  "ai-sdk:@openrouter/ai-sdk-provider",
  "openrouter",
  "openrouter-responses",
])

const supportsPromptCacheKey = (routeID: string | undefined): boolean => {
  if (routeID === undefined) return false
  if (PROMPT_CACHE_KEY_ROUTES.has(routeID)) return true
  return routeID.includes("openai") || routeID.includes("openrouter")
}

export const promptCacheNamespace = (
  input: PromptCacheNamespaceInput & { readonly routeID?: string },
  _now = Date.now(),
): string =>
  Hash.sha256(
    canonicalJson({
      namespace: "session-prompt-cache/v2",
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      projectID: input.projectID,
      directory: input.directory,
      workspaceID: input.workspaceID,
      providerID: input.providerID,
      modelID: input.modelID,
      variant: input.variant,
      policyRevision: input.policyRevision,
      permissions: input.permissions.map((rule) => ({
        action: rule.action,
        resource: rule.resource,
        effect: rule.effect,
      })),
      system: input.system.map((part) => ({
        type: part.type,
        text: part.text,
        cache: part.cache ? { type: part.cache.type, ttlSeconds: part.cache.ttlSeconds } : undefined,
      })),
      tools: input.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        cache: tool.cache ? { type: tool.cache.type, ttlSeconds: tool.cache.ttlSeconds } : undefined,
        native: tool.native,
      })),
    }),
  )

export const promptCacheKeyForGeneration = (sessionID: string, baselineKey: string, generation = 0): string => {
  if (generation === 0) return baselineKey
  return Hash.sha256(
    canonicalJson({
      namespace: "session-prompt-cache-generation/v1",
      sessionID,
      baselineKey,
      generation,
    }),
  )
}

export interface ProviderSessionNamespaceInput {
  readonly projectID: string
  readonly sessionID: string
  readonly providerID: string
}

export const providerSessionNamespace = (input: ProviderSessionNamespaceInput): string =>
  Hash.sha256(
    canonicalJson({
      namespace: "provider-session/v1",
      projectID: input.projectID,
      sessionID: input.sessionID,
      providerID: input.providerID,
    }),
  )

export interface EfficiencySettings {
  readonly anthropicTtl: "adaptive" | "5m" | "1h"
  readonly openaiMode: "auto" | "implicit" | "explicit"
  readonly openaiExtendedRetention: boolean
}

export const efficiencySettings = (input?: ConfigEfficiency.Info): EfficiencySettings => ({
  anthropicTtl: input?.prompt_cache?.anthropic_ttl ?? "adaptive",
  openaiMode: input?.prompt_cache?.openai_mode ?? "auto",
  openaiExtendedRetention: input?.prompt_cache?.openai_extended_retention ?? false,
})

export interface ProviderOptionsInput extends PromptCacheNamespaceInput {
  readonly apiModelID: string
  readonly sessionID: string
  readonly routeID: string
  readonly generation?: number
  readonly anthropicTtlSeconds?: 300 | 3600
  readonly openaiMode?: "auto" | "implicit" | "explicit"
  readonly openaiExtendedRetention?: boolean
}

const ANTHROPIC_CACHE_ROUTES = new Set([
  "anthropic-messages",
  "google-vertex-messages",
  "ai-sdk:@ai-sdk/anthropic",
  "ai-sdk:@ai-sdk/google-vertex/anthropic",
  "ai-sdk:@ai-sdk/amazon-bedrock",
  "bedrock-converse",
  "openrouter",
  "openrouter-responses",
  "ai-sdk:@openrouter/ai-sdk-provider",
])
const PROFILE_GATED_ANTHROPIC_CACHE_ROUTES = new Set([
  "openrouter",
  "openrouter-responses",
  "ai-sdk:@openrouter/ai-sdk-provider",
])

export const providerOptions = (input: ProviderOptionsInput, now = Date.now()) => {
  const baselineKey = promptCacheNamespace(input, now)
  const promptCacheKey = supportsPromptCacheKey(input.routeID)
    ? promptCacheKeyForGeneration(input.sessionID, baselineKey, input.generation)
    : baselineKey
  const providerSessionID = providerSessionNamespace({
    projectID: input.projectID,
    sessionID: input.sessionID,
    providerID: input.providerID,
  })
  const isOpenRouter =
    input.routeID === "ai-sdk:@openrouter/ai-sdk-provider" ||
    input.routeID === "openrouter-responses" ||
    input.routeID === "openrouter"
  const openrouter = isOpenRouter
    ? {
        prompt_cache_key: promptCacheKey,
        session_id: providerSessionID,
        promptCacheKey,
        sessionID: providerSessionID,
      }
    : { promptCacheKey, sessionID: providerSessionID }
  const isCopilotGpt56 =
    (input.routeID === "github-copilot-chat" || input.routeID === "github-copilot-responses") &&
    OpenAIOptions.isGpt56OrLater(input.apiModelID)
  const openaiCacheCapability = isCopilotGpt56
    ? "key-only"
    : OpenAIOptions.publicPromptCacheCapability(input.routeID, input.apiModelID)
  const breakpointOpenAI =
    !isCopilotGpt56 &&
    OpenAIOptions.supportsPromptCacheBreakpoints(input.routeID, input.apiModelID) &&
    input.openaiMode !== undefined &&
    input.openaiMode !== "implicit" &&
    (input.openaiMode === "auto" || input.openaiMode === "explicit")
  const controlledOpenAI = openaiCacheCapability === "gpt-5.6" && breakpointOpenAI
  const openai = {
    promptCacheKey,
    ...(controlledOpenAI
      ? {
          promptCacheOptions: {
            mode: input.openaiMode === "explicit" ? ("explicit" as const) : ("implicit" as const),
            ttl: "30m" as const,
          },
        }
      : openaiCacheCapability === "legacy" &&
          input.openaiExtendedRetention === true &&
          OpenAIOptions.supportsExtendedPromptCacheRetention(input.apiModelID)
        ? { promptCacheRetention: "24h" as const }
        : {}),
  }
  const cache: CachePolicy | undefined = breakpointOpenAI
    ? {
        tools: false,
        system: true,
        // The AI lowerer reserves the system and managed implicit slots, then
        // selects the newest eligible boundaries within this provider limit.
        messages: { tail: OPENAI_PROMPT_CACHE_READ_CANDIDATE_LIMIT },
      }
    : input.anthropicTtlSeconds !== undefined &&
        ANTHROPIC_CACHE_ROUTES.has(input.routeID) &&
        (!PROFILE_GATED_ANTHROPIC_CACHE_ROUTES.has(input.routeID) ||
          cacheProfile(input.apiModelID)?.extendedTtl === true)
      ? { tools: true, system: true, messages: { tail: 2 }, ttlSeconds: input.anthropicTtlSeconds }
      : undefined
  return {
    promptCacheKey,
    systemDigest: systemDigest(input.system),
    toolDigest: toolDigest(input.tools),
    providerOptions: { openai, openrouter },
    ...(cache === undefined ? {} : { cache }),
  }
}

export function canonicalJson(value: unknown): string {
  const encode = (current: unknown, ancestors: ReadonlySet<object>): string | undefined => {
    if (current === undefined) return undefined
    if (current === null) return "null"
    if (typeof current === "boolean") return current ? "true" : "false"
    if (typeof current === "number") return Number.isFinite(current) ? JSON.stringify(current) : "null"
    if (typeof current === "string") return JSON.stringify(current)
    if (typeof current === "bigint" || typeof current === "function" || typeof current === "symbol")
      throw new TypeError("Prompt cache namespace contains an unsupported value")
    if (ancestors.has(current)) throw new TypeError("Prompt cache namespace contains a cycle")

    const nested = new Set(ancestors).add(current)
    if (Array.isArray(current))
      return `[${Array.from({ length: current.length }, (_, index) => encode(current[index], nested) ?? "null").join(",")}]`
    if (!isPlainRecord(current)) throw new TypeError("Prompt cache namespace contains an unsupported object")
    return `{${Object.keys(current)
      .toSorted(compareCodePoints)
      .flatMap((key) => {
        const item = encode(current[key], nested)
        return item === undefined ? [] : [`${JSON.stringify(key)}:${item}`]
      })
      .join(",")}}`
  }

  const encoded = encode(value, new Set())
  if (encoded === undefined) throw new TypeError("Prompt cache namespace is not JSON-serializable")
  return encoded
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function compareCodePoints(left: string, right: string) {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0)
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0)
  const shared = Math.min(leftPoints.length, rightPoints.length)
  const different = leftPoints.slice(0, shared).findIndex((value, index) => value !== rightPoints[index])
  if (different !== -1) return (leftPoints[different] ?? 0) - (rightPoints[different] ?? 0)
  return leftPoints.length - rightPoints.length
}
