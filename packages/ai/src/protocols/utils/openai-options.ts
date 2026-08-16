import { Schema } from "effect"
import type { LLMRequest, TextVerbosity as TextVerbosityValue } from "../../schema"
import { ReasoningEfforts, TextVerbosity } from "../../schema"
import { isRecord } from "../shared"

export const OpenAIReasoningEfforts = ReasoningEfforts
export type OpenAIReasoningEffort = string

// Mirrors OpenAI's `ResponseIncludable` union from the official SDK. Keep this
// in lockstep with `openai-node/src/resources/responses/responses.ts`.
export const OpenAIResponseIncludables = [
  "file_search_call.results",
  "web_search_call.results",
  "web_search_call.action.sources",
  "message.input_image.image_url",
  "computer_call_output.output.image_url",
  "code_interpreter_call.outputs",
  "reasoning.encrypted_content",
  "message.output_text.logprobs",
] as const
export type OpenAIResponseIncludable = (typeof OpenAIResponseIncludables)[number]
export const OpenAIServiceTiers = ["auto", "default", "flex", "priority"] as const
export type OpenAIServiceTier = (typeof OpenAIServiceTiers)[number]
export const OpenAIImageDetails = ["auto", "low", "high", "original"] as const
export type OpenAIImageDetail = (typeof OpenAIImageDetails)[number]

// `prompt_cache_retention` — models before the GPT-5.6 family only. Deprecated
// for GPT-5.6 and later, which reject it with a 400.
export const OpenAIPromptCacheRetentions = ["in_memory", "24h"] as const
export type OpenAIPromptCacheRetention = (typeof OpenAIPromptCacheRetentions)[number]

// `prompt_cache_options` — GPT-5.6 and later only. Pre-5.6 models reject this
// field with a 400. `ttl` currently only accepts "30m".
export const OpenAIPromptCacheOptionsModes = ["implicit", "explicit"] as const
export type OpenAIPromptCacheOptionsMode = (typeof OpenAIPromptCacheOptionsModes)[number]
export interface OpenAIPromptCacheOptions {
  readonly mode?: OpenAIPromptCacheOptionsMode
  readonly ttl?: "30m"
}

export interface OpenAIContextManagementEntry {
  readonly type: "compaction"
  readonly compactThreshold?: number
}

export interface OpenAIResponsesWebSocketSession {
  readonly sessionKey: string
  readonly fingerprint: string
  readonly messageBoundary: number
  readonly fullReplay: boolean
}

export const OpenAIContextManagement = Schema.Struct({
  type: Schema.tag("compaction"),
  compact_threshold: Schema.optional(Schema.Number),
})

const TEXT_VERBOSITY = new Set<string>(["low", "medium", "high"])
const INCLUDABLES = new Set<string>(OpenAIResponseIncludables)
const SERVICE_TIERS = new Set<string>(OpenAIServiceTiers)
const PROMPT_CACHE_RETENTIONS = new Set<string>(OpenAIPromptCacheRetentions)
const PROMPT_CACHE_OPTIONS_MODES = new Set<string>(OpenAIPromptCacheOptionsModes)
const EXTENDED_PROMPT_CACHE_MODELS = new Set([
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.2",
  "gpt-5.1-codex-max",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5.1-chat-latest",
  "gpt-5",
  "gpt-5-codex",
  "gpt-4.1",
])
const MODEL_SNAPSHOT_SUFFIX = /-\d{4}-\d{2}-\d{2}$/

export const OpenAIReasoningEffort = Schema.String
export const OpenAIReasoningContext = Schema.Literal("all_turns")
export const OpenAITextVerbosity = TextVerbosity
export const OpenAIResponseIncludable = Schema.Literals(OpenAIResponseIncludables)
export const OpenAIServiceTier = Schema.Literals(OpenAIServiceTiers)
export const OpenAIImageDetail = Schema.Literals(OpenAIImageDetails)
export const OpenAIPromptCacheRetention = Schema.Literals(OpenAIPromptCacheRetentions)
// Only "explicit" is a valid `prompt_cache_breakpoint.mode` — marking a block
// with any other value is a caller error, not a wire option.
export const OpenAIPromptCacheBreakpoint = Schema.Struct({ mode: Schema.tag("explicit") })
export type OpenAIPromptCacheBreakpoint = Schema.Schema.Type<typeof OpenAIPromptCacheBreakpoint>

export const isReasoningEffort = (effort: unknown): effort is OpenAIReasoningEffort => typeof effort === "string"

const isTextVerbosity = (value: unknown): value is TextVerbosityValue =>
  typeof value === "string" && TEXT_VERBOSITY.has(value)

const options = (request: LLMRequest) => request.providerOptions?.openai

export const store = (request: LLMRequest): boolean | undefined => {
  const value = options(request)?.store
  return typeof value === "boolean" ? value : undefined
}

export const previousResponseId = (request: LLMRequest): string | undefined => {
  const value = options(request)?.previousResponseId
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export const continuationInputStart = (request: LLMRequest): number | undefined => {
  const value = options(request)?.continuationInputStart
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export const responsesWebSocket = (request: LLMRequest): OpenAIResponsesWebSocketSession | undefined => {
  const value = options(request)?.responsesWebSocket
  if (!isRecord(value)) return undefined
  if (typeof value.sessionKey !== "string" || value.sessionKey.length === 0) return undefined
  if (typeof value.fingerprint !== "string" || value.fingerprint.length === 0) return undefined
  if (typeof value.messageBoundary !== "number" || !Number.isSafeInteger(value.messageBoundary) || value.messageBoundary < 0)
    return undefined
  return {
    sessionKey: value.sessionKey,
    fingerprint: value.fingerprint,
    messageBoundary: value.messageBoundary,
    fullReplay: value.fullReplay === true,
  }
}

export const reasoningEffort = (request: LLMRequest): string | undefined => {
  const value = options(request)?.reasoningEffort
  return typeof value === "string" ? value : undefined
}

export const reasoningSummary = (request: LLMRequest): "auto" | undefined =>
  options(request)?.reasoningSummary === "auto" ? "auto" : undefined

export const reasoningContext = (request: LLMRequest): "all_turns" | undefined =>
  options(request)?.reasoningContext === "all_turns" ? "all_turns" : undefined

// Resolve the OpenAI Responses `include` field. Filters out unknown
// includable values defensively so a typo in upstream config drops the
// invalid entry instead of poisoning the wire body. An empty array (either
// passed directly or produced by filtering) is treated as "no include" and
// returns undefined so the request body omits the field entirely.
export const include = (request: LLMRequest): ReadonlyArray<OpenAIResponseIncludable> | undefined => {
  const value = options(request)?.include
  if (!Array.isArray(value)) return undefined
  const filtered = value.filter((entry): entry is OpenAIResponseIncludable => INCLUDABLES.has(entry))
  return filtered.length > 0 ? filtered : undefined
}

export const promptCacheKey = (request: LLMRequest) => {
  const value = options(request)?.promptCacheKey
  return typeof value === "string" ? value : undefined
}

export const textVerbosity = (request: LLMRequest) => {
  const value = options(request)?.textVerbosity
  return isTextVerbosity(value) ? value : undefined
}

export const serviceTier = (request: LLMRequest) => {
  const value = options(request)?.serviceTier
  return typeof value === "string" && SERVICE_TIERS.has(value) ? (value as OpenAIServiceTier) : undefined
}

export const imageDetail = (request: LLMRequest): OpenAIImageDetail | undefined => {
  const value = options(request)?.imageDetail
  return OpenAIImageDetails.find((detail) => detail === value)
}

export const invalidImageDetail = (request: LLMRequest) => {
  const value = options(request)?.imageDetail
  return value !== undefined && !OpenAIImageDetails.some((detail) => detail === value) ? value : undefined
}

export const instructions = (request: LLMRequest) => {
  const value = options(request)?.instructions
  return typeof value === "string" ? value : undefined
}

export const promptCacheRetention = (request: LLMRequest): OpenAIPromptCacheRetention | undefined => {
  const value = options(request)?.promptCacheRetention
  return typeof value === "string" && PROMPT_CACHE_RETENTIONS.has(value) ? (value as OpenAIPromptCacheRetention) : undefined
}

export const promptCacheOptions = (request: LLMRequest): OpenAIPromptCacheOptions | undefined => {
  const value = options(request)?.promptCacheOptions
  if (!isRecord(value)) return undefined
  const mode =
    typeof value.mode === "string" && PROMPT_CACHE_OPTIONS_MODES.has(value.mode)
      ? (value.mode as OpenAIPromptCacheOptionsMode)
      : undefined
  const ttl = value.ttl === "30m" ? ("30m" as const) : undefined
  return mode === undefined && ttl === undefined ? undefined : { mode, ttl }
}

export const contextManagement = (request: LLMRequest): ReadonlyArray<OpenAIContextManagementEntry> | undefined => {
  const value = options(request)?.contextManagement
  if (!Array.isArray(value)) return undefined
  return value.flatMap((entry): OpenAIContextManagementEntry[] => {
    if (!isRecord(entry) || entry.type !== "compaction") return []
    const compactThreshold = entry.compactThreshold
    if (compactThreshold !== undefined && (typeof compactThreshold !== "number" || !Number.isFinite(compactThreshold)))
      return []
    return [{ type: "compaction", compactThreshold }]
  })
}

// GPT version family gate for the two mutually-exclusive retention controls:
// `prompt_cache_retention` (pre-5.6) vs `prompt_cache_options` /
// `prompt_cache_breakpoint` (5.6+). Sending either to the wrong family returns
// a 400, so every caller of these wire fields must gate on this first.
// Aggregators and gateways prefix the vendor onto the id (`openai/gpt-5.6`),
// so the family name is matched at the start or immediately after a slash.
const GPT_VERSION = /(?:^|\/)gpt-(\d+)(?:\.(\d+))?/

export const isGpt56OrLater = (modelID: string): boolean => {
  const match = GPT_VERSION.exec(modelID.toLowerCase())
  if (!match) return false
  const major = Number(match[1])
  const minor = match[2] ? Number(match[2]) : 0
  return major > 5 || (major === 5 && minor >= 6)
}

export const supportsOriginalImageDetail = (modelID: string): boolean => {
  const match = GPT_VERSION.exec(modelID.toLowerCase())
  if (!match) return false
  const major = Number(match[1])
  const minor = match[2] ? Number(match[2]) : 0
  if (major > 5 || (major === 5 && minor > 4)) return true
  if (major !== 5 || minor !== 4) return false
  return !/gpt-5\.4-(mini|nano)(?:$|[-/])/.test(modelID.toLowerCase())
}

export const DefaultCompactionThreshold = 200_000

const DIRECT_OPENAI_RESPONSE_ROUTES = new Set(["openai-responses", "openai-responses-websocket"])

const supportsDirectGpt56 = (routeID: string, modelID: string) =>
  DIRECT_OPENAI_RESPONSE_ROUTES.has(routeID) && isGpt56OrLater(modelID)

export const defaultContextManagement = (
  routeID: string,
  modelID: string,
): ReadonlyArray<OpenAIContextManagementEntry> | undefined =>
  supportsDirectGpt56(routeID, modelID)
    ? [{ type: "compaction", compactThreshold: DefaultCompactionThreshold }]
    : undefined

export const resolvedReasoningContext = (request: LLMRequest) =>
  supportsDirectGpt56(request.model.route.id, request.model.id) ? reasoningContext(request) : undefined

export const resolvedContextManagement = (request: LLMRequest) => {
  if (!supportsDirectGpt56(request.model.route.id, request.model.id)) return undefined
  return contextManagement(request) ?? defaultContextManagement(request.model.route.id, request.model.id)
}

export const supportsExtendedPromptCacheRetention = (modelID: string): boolean => {
  const normalized = modelID.toLowerCase().split("/").at(-1)?.replace(MODEL_SNAPSHOT_SUFFIX, "")
  return normalized !== undefined && EXTENDED_PROMPT_CACHE_MODELS.has(normalized)
}

export type PublicOpenAIPromptCacheCapability = "key-only" | "legacy" | "gpt-5.6"

const PUBLIC_OPENAI_CACHE_ROUTES = new Set(["openai-chat", "openai-responses", "openai-responses-websocket"])

export const supportsPromptCacheBreakpoints = (routeID: string, modelID: string): boolean =>
  PUBLIC_OPENAI_CACHE_ROUTES.has(routeID) && isGpt56OrLater(modelID)

export const publicPromptCacheCapability = (
  routeID: string,
  modelID: string,
): PublicOpenAIPromptCacheCapability => {
  if (!PUBLIC_OPENAI_CACHE_ROUTES.has(routeID)) return "key-only"
  return isGpt56OrLater(modelID) ? "gpt-5.6" : "legacy"
}

export * as OpenAIOptions from "./openai-options"
