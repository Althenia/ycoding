import { Effect, Schema } from "effect"
import { Route, type RouteDefaultsInput } from "../route/client"
import { Endpoint } from "../route/endpoint"
import { Framing } from "../route/framing"
import { Protocol } from "../route/protocol"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options"
import { LLMRequest, ProviderID, type ModelID, type ProviderOptions } from "../schema"
import type { ProviderPackage } from "../provider-package"
import * as OpenAICompatibleProfiles from "./openai-compatible-profile"
import * as OpenAIResponses from "../protocols/openai-responses"
import { isRecord } from "../protocols/shared"
import { ProviderShared } from "../protocols/shared"
import { OpenAIOptions } from "../protocols/utils/openai-options"
import { autoPlacementHint } from "../cache-policy"

export const profile = OpenAICompatibleProfiles.profiles.openrouter
export const id = ProviderID.make(profile.provider)
const ADAPTER = "openrouter-responses"

export interface OpenRouterOptions {
  readonly [key: string]: unknown
  readonly usage?: boolean | Record<string, unknown>
  readonly reasoning?: Record<string, unknown>
  readonly promptCacheKey?: string
  readonly sessionID?: string
  readonly prompt_cache_key?: string
  readonly session_id?: string
}

export type OpenRouterProviderOptionsInput = ProviderOptions & {
  readonly openrouter?: OpenRouterOptions
}

export type ModelOptions = Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
    readonly providerOptions?: OpenRouterProviderOptionsInput
  }

const OpenRouterResponsesBodyBase = Schema.Struct({
  model: Schema.String,
  input: Schema.Array(Schema.Any),
  instructions: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Any),
  tool_choice: Schema.optional(Schema.Any),
  store: Schema.optional(Schema.Boolean),
  previous_response_id: Schema.optional(Schema.String),
  service_tier: Schema.optional(Schema.Any),
  prompt_cache_key: Schema.optional(Schema.String),
  session_id: Schema.optional(Schema.String),
  prompt_cache_retention: Schema.optional(Schema.Any),
  prompt_cache_options: Schema.optional(Schema.Any),
  context_management: Schema.optional(Schema.Any),
  include: Schema.optional(Schema.Any),
  reasoning: Schema.optional(Schema.Any),
  text: Schema.optional(Schema.Any),
  max_output_tokens: Schema.optional(Schema.Number),
  temperature: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
  usage: Schema.optional(Schema.Any),
  cache_control: Schema.optional(Schema.Any),
  stream: Schema.Literal(true),
})

const OpenRouterResponsesBody = Schema.StructWithRest(OpenRouterResponsesBodyBase, [
  Schema.Record(Schema.String, Schema.Any),
])
export type OpenRouterBody = Schema.Schema.Type<typeof OpenRouterResponsesBody>

const bodyOptions = (input: unknown) => {
  const openrouter = isRecord(input) ? input : {}
  const promptCacheKey =
    typeof openrouter.promptCacheKey === "string"
      ? openrouter.promptCacheKey
      : typeof (openrouter as Record<string, unknown>).prompt_cache_key === "string"
        ? ((openrouter as Record<string, unknown>).prompt_cache_key as string)
        : undefined
  const sessionID =
    typeof openrouter.sessionID === "string"
      ? openrouter.sessionID
      : typeof (openrouter as Record<string, unknown>).session_id === "string"
        ? ((openrouter as Record<string, unknown>).session_id as string)
        : undefined
  return {
    ...(openrouter.usage === true
      ? { usage: { include: true } }
      : isRecord(openrouter.usage)
        ? { usage: openrouter.usage }
        : {}),
    ...(isRecord(openrouter.reasoning) ? { reasoning: openrouter.reasoning } : {}),
    ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
    ...(sessionID ? { session_id: sessionID } : {}),
  }
}

export const protocol: any = Protocol.make({
  id: ADAPTER,
  body: {
    schema: OpenRouterResponsesBody as any,
    from: (request: LLMRequest) =>
      Effect.gen(function* () {
        const rawOpenai = isRecord(request.providerOptions?.openai) ? (request.providerOptions?.openai as Record<string, unknown>) : {}
        const rawOpenrouter = isRecord(request.providerOptions?.openrouter) ? (request.providerOptions?.openrouter as Record<string, unknown>) : {}
        const store =
          OpenAIOptions.store(request) ??
          (typeof rawOpenai.store === "boolean" ? (rawOpenai.store as boolean) : undefined) ??
          (typeof rawOpenrouter.store === "boolean" ? (rawOpenrouter.store as boolean) : undefined)
        const previousResponseId =
          OpenAIOptions.previousResponseId(request) ??
          (typeof rawOpenai.previousResponseId === "string" ? (rawOpenai.previousResponseId as string) : undefined) ??
          (typeof (rawOpenai as Record<string, unknown>).previous_response_id === "string" ? ((rawOpenai as Record<string, unknown>).previous_response_id as string) : undefined) ??
          (typeof rawOpenrouter.previousResponseId === "string" ? (rawOpenrouter.previousResponseId as string) : undefined) ??
          (typeof (rawOpenrouter as Record<string, unknown>).previous_response_id === "string" ? ((rawOpenrouter as Record<string, unknown>).previous_response_id as string) : undefined)
        if (store === true) return yield* ProviderShared.invalidRequest("OpenRouter Responses is stateless: store:true is not supported")
        if (previousResponseId !== undefined) return yield* ProviderShared.invalidRequest("OpenRouter Responses is stateless: previous_response_id is not supported")
        const promptCacheKey =
          typeof rawOpenrouter.promptCacheKey === "string"
            ? (rawOpenrouter.promptCacheKey as string)
            : typeof (rawOpenrouter as Record<string, unknown>).prompt_cache_key === "string"
              ? ((rawOpenrouter as Record<string, unknown>).prompt_cache_key as string)
              : typeof rawOpenai.promptCacheKey === "string"
                ? (rawOpenai.promptCacheKey as string)
                : typeof (rawOpenai as Record<string, unknown>).prompt_cache_key === "string"
                  ? ((rawOpenai as Record<string, unknown>).prompt_cache_key as string)
                  : undefined
        const sessionID =
          typeof rawOpenrouter.sessionID === "string"
            ? (rawOpenrouter.sessionID as string)
            : typeof (rawOpenrouter as Record<string, unknown>).session_id === "string"
              ? ((rawOpenrouter as Record<string, unknown>).session_id as string)
              : typeof rawOpenai.sessionID === "string"
                ? (rawOpenai.sessionID as string)
                : typeof (rawOpenai as Record<string, unknown>).session_id === "string"
                  ? ((rawOpenai as Record<string, unknown>).session_id as string)
                  : undefined
        const sanitizedProviderOptions: Record<string, unknown> = {
          ...request.providerOptions,
          openai: {
            ...rawOpenai,
            ...(promptCacheKey ? { promptCacheKey } : {}),
            store: undefined,
            previousResponseId: undefined,
            previous_response_id: undefined,
            prompt_cache_key: undefined,
            session_id: undefined,
            sessionID: undefined,
          },
          openrouter: {
            ...rawOpenrouter,
            store: undefined,
            previousResponseId: undefined,
            previous_response_id: undefined,
          },
        }
        const sanitized = LLMRequest.update(request, {
          providerOptions: sanitizedProviderOptions as typeof request.providerOptions,
        })
        const body = (yield* OpenAIResponses.protocol.body.from(sanitized)) as unknown as Record<string, unknown>
        const extras = bodyOptions(request.providerOptions?.openrouter)
        const cacheControl = autoPlacementHint(request)
        const promptExtra = promptCacheKey && !body.prompt_cache_key ? { prompt_cache_key: promptCacheKey } : {}
        const sessionExtra = sessionID && !(body as Record<string, unknown>).session_id ? { session_id: sessionID } : {}
        const { store: _store, previous_response_id: _prev, ...rest } = body
        return {
          ...rest,
          ...promptExtra,
          ...sessionExtra,
          ...extras,
          ...(cacheControl
            ? {
                cache_control: {
                  type: "ephemeral",
                  ...(cacheControl.ttlSeconds !== undefined && cacheControl.ttlSeconds >= 3_600 ? { ttl: "1h" } : {}),
                },
              }
            : {}),
          store: undefined,
          previous_response_id: undefined,
        } as unknown as OpenRouterBody
      }),
  },
  stream: OpenAIResponses.protocol.stream as any,
})

export const route = Route.make({
  id: ADAPTER,
  provider: profile.provider,
  protocol,
  endpoint: Endpoint.path("/responses", { baseURL: profile.baseURL }),
  framing: Framing.sse,
})

export const routes = [route]

const configuredRoute = (input: ModelOptions) => {
  const { apiKey: _, auth: _auth, baseURL, ...rest } = input
  return route.with({
    ...rest,
    endpoint: { baseURL: baseURL ?? profile.baseURL },
    auth: AuthOptions.bearer(input, "OPENROUTER_API_KEY"),
  })
}

export interface Settings extends ProviderPackage.Settings {
  readonly apiKey?: string
  readonly baseURL?: string
  readonly providerOptions?: OpenRouterProviderOptionsInput
}

export const configure = (input: ModelOptions = {}) => {
  const route = configuredRoute(input)
  return {
    id,
    model: (modelID: string | ModelID) => route.model({ id: modelID }),
    configure,
  }
}

export const provider = configure()
export const model: ProviderPackage.Definition<Settings>["model"] = (modelID, settings) =>
  configure({
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
    headers: settings.headers === undefined ? undefined : { ...settings.headers },
    http: settings.body === undefined ? undefined : { body: { ...settings.body } },
    limits: settings.limits,
    providerOptions: settings.providerOptions,
  }).model(modelID)
export const responses = model
