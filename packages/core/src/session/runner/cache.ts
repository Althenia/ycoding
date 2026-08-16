export * as SessionRunnerCache from "./cache"

import type { CachePolicy, LLMRequest } from "@ycoding-ai/ai"
import { OpenAIOptions } from "@ycoding-ai/ai/protocols/utils/openai-options"
import type { ConfigEfficiency } from "../../config/efficiency"
import type { PermissionV2 } from "../../permission"
import { Hash } from "../../util/hash"

export interface PromptCacheNamespaceInput {
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

export const promptCacheNamespace = (input: PromptCacheNamespaceInput): string =>
  Hash.sha256(
    canonicalJson({
      namespace: "session-prompt-cache/v2",
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
  readonly sessionID: string
  readonly routeID: string
  readonly anthropicTtlSeconds?: 300 | 3600
  readonly openaiMode?: "auto" | "implicit" | "explicit"
  readonly openaiExtendedRetention?: boolean
}

const PUBLIC_OPENAI_CACHE_ROUTES = new Set(["openai-chat", "openai-responses"])
const ANTHROPIC_CACHE_ROUTES = new Set([
  "anthropic-messages",
  "google-vertex-messages",
  "ai-sdk:@ai-sdk/anthropic",
  "ai-sdk:@ai-sdk/google-vertex/anthropic",
  "ai-sdk:@ai-sdk/amazon-bedrock",
  "bedrock-converse",
])

export const providerOptions = (input: ProviderOptionsInput) => {
  const promptCacheKey = promptCacheNamespace(input)
  const providerSessionID = providerSessionNamespace({
    projectID: input.projectID,
    sessionID: input.sessionID,
    providerID: input.providerID,
  })
  const openrouter =
    input.routeID === "ai-sdk:@openrouter/ai-sdk-provider"
      ? { prompt_cache_key: promptCacheKey, session_id: providerSessionID }
      : { promptCacheKey, sessionID: providerSessionID }
  const directOpenAI = input.providerID === "openai" && PUBLIC_OPENAI_CACHE_ROUTES.has(input.routeID)
  const gpt56 = directOpenAI && OpenAIOptions.isGpt56OrLater(input.modelID)
  const controlledOpenAI =
    gpt56 &&
    input.openaiMode !== undefined &&
    input.openaiMode !== "implicit" &&
    (input.openaiMode === "auto" || input.openaiMode === "explicit")
  const openai = {
    promptCacheKey,
    ...(controlledOpenAI
      ? {
          promptCacheOptions: {
            mode: input.openaiMode === "explicit" ? ("explicit" as const) : ("implicit" as const),
            ttl: "30m" as const,
          },
        }
      : directOpenAI &&
          !gpt56 &&
          input.openaiExtendedRetention === true &&
          OpenAIOptions.supportsExtendedPromptCacheRetention(input.modelID)
        ? { promptCacheRetention: "24h" as const }
        : {}),
  }
  const cache: CachePolicy | undefined = controlledOpenAI
    ? {
        tools: true,
        system: true,
        messages: input.openaiMode === "auto" ? "latest-user-message" : { tail: 2 },
      }
    : input.anthropicTtlSeconds !== undefined && ANTHROPIC_CACHE_ROUTES.has(input.routeID)
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
