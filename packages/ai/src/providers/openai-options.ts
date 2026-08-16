import type { ProviderOptions, ReasoningEffort, TextVerbosity } from "../schema"
import { mergeProviderOptions } from "../schema"
import { isGpt56OrLater } from "../protocols/utils/openai-options"
import type {
  OpenAIPromptCacheOptions,
  OpenAIPromptCacheRetention,
  OpenAIContextManagementEntry,
  OpenAIImageDetail,
  OpenAIResponseIncludable,
  OpenAIServiceTier,
} from "../protocols/utils/openai-options"

export type {
  OpenAIPromptCacheOptions,
  OpenAIPromptCacheRetention,
  OpenAIContextManagementEntry,
  OpenAIImageDetail,
  OpenAIResponseIncludable,
  OpenAIServiceTier,
} from "../protocols/utils/openai-options"

export interface OpenAIOptionsInput {
  readonly [key: string]: unknown
  readonly store?: boolean
  readonly previousResponseId?: string
  readonly continuationInputStart?: number
  readonly promptCacheKey?: string
  // Pre-GPT-5.6 only: selects the maximum-retention policy. Rejected with a
  // 400 by GPT-5.6 and later models.
  readonly promptCacheRetention?: OpenAIPromptCacheRetention
  // GPT-5.6 and later only: request-wide explicit/implicit breakpoint policy.
  // Rejected with a 400 by pre-GPT-5.6 models.
  readonly promptCacheOptions?: OpenAIPromptCacheOptions
  readonly contextManagement?: ReadonlyArray<OpenAIContextManagementEntry>
  readonly reasoningEffort?: ReasoningEffort
  readonly reasoningSummary?: "auto"
  readonly reasoningContext?: "all_turns"
  // OpenAI Responses `include` wire field. Mirrors the official SDK's
  // `ResponseIncludable[]` union exactly so AI SDK callers and direct
  // native-SDK callers share one shape and no translation is required.
  readonly include?: ReadonlyArray<OpenAIResponseIncludable>
  readonly textVerbosity?: TextVerbosity
  readonly serviceTier?: OpenAIServiceTier
  readonly imageDetail?: OpenAIImageDetail
}

export type OpenAIProviderOptionsInput = ProviderOptions & {
  readonly openai?: OpenAIOptionsInput
}

const definedEntries = (input: Record<string, unknown>) =>
  Object.entries(input).filter((entry) => entry[1] !== undefined)

const openAIProviderOptions = (options: OpenAIOptionsInput | undefined): ProviderOptions | undefined => {
  const openai = Object.fromEntries(
    definedEntries({
      store: options?.store,
      previousResponseId: options?.previousResponseId,
      continuationInputStart: options?.continuationInputStart,
      promptCacheKey: options?.promptCacheKey,
      contextManagement: options?.contextManagement,
      reasoningEffort: options?.reasoningEffort,
      reasoningSummary: options?.reasoningSummary,
      reasoningContext: options?.reasoningContext,
      include: options?.include,
      textVerbosity: options?.textVerbosity,
      serviceTier: options?.serviceTier,
      imageDetail: options?.imageDetail,
    }),
  )
  if (Object.keys(openai).length === 0) return undefined
  return { openai }
}

export const gpt5DefaultOptions = (
  modelID: string,
  options: { readonly textVerbosity?: boolean } = {},
): ProviderOptions | undefined => {
  const id = modelID.toLowerCase()
  if (!id.includes("gpt-5") || id.includes("gpt-5-chat") || id.includes("gpt-5-pro")) return undefined
  return openAIProviderOptions({
    reasoningEffort: "medium",
    reasoningSummary: "auto",
    // Shared OpenAI-compatible defaults remain stateless, and direct OpenAI
    // callers may explicitly opt out of storage. Keep encrypted reasoning
    // available so either stateless path can replay a follow-up turn.
    include: ["reasoning.encrypted_content"],
    textVerbosity:
      options.textVerbosity === true && id.includes("gpt-5.") && !id.includes("codex") && !id.includes("-chat")
        ? "low"
        : undefined,
  })
}

export const openAIDefaultOptions = (
  modelID: string,
  options: { readonly textVerbosity?: boolean; readonly store?: boolean; readonly retainedReasoning?: boolean } = {},
): ProviderOptions | undefined =>
  mergeProviderOptions(
    openAIProviderOptions({
      store: options.store ?? false,
      reasoningContext: options.retainedReasoning === true && isGpt56OrLater(modelID) ? "all_turns" : undefined,
    }),
    gpt5DefaultOptions(modelID, options),
  )

export const withOpenAIOptions = <Options extends { readonly providerOptions?: OpenAIProviderOptionsInput }>(
  modelID: string,
  options: Options,
  defaults: { readonly textVerbosity?: boolean; readonly store?: boolean; readonly retainedReasoning?: boolean } = {},
): Omit<Options, "providerOptions"> & { readonly providerOptions?: ProviderOptions } => {
  return {
    ...options,
    providerOptions: mergeProviderOptions(openAIDefaultOptions(modelID, defaults), options.providerOptions),
  }
}

export * as OpenAIProviderOptions from "./openai-options"
