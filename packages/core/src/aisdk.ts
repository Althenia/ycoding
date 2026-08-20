export * as AISDK from "./aisdk"

import { makeLocationNode } from "./effect/app-node"
import type {
  JSONSchema7,
  JSONValue,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3FunctionTool,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolChoice,
  SharedV3ProviderOptions,
} from "@ai-sdk/provider"
import {
  AnthropicModel,
  FinishReason,
  HttpContext,
  HttpRequestDetails,
  HttpResponseDetails,
  InvalidProviderOutputReason,
  LLMEvent,
  LLMError,
  Model,
  ProviderID,
  ProviderMetadata,
  TransportReason,
  ToolResultValue,
  ToolSchemaProjection,
  UnknownProviderReason,
  type ContentPart,
  type LLMRequest,
  type ToolDefinition,
  type UsageInput,
} from "@ycoding-ai/ai"
import { classifyProviderFailure, rateLimitDetails, retryAfterMsFromHeaders } from "@ycoding-ai/ai/provider-error"
import { Auth, Endpoint, type AnyRoute } from "@ycoding-ai/ai/route"
import { ProviderShared } from "@ycoding-ai/ai/protocols/shared"
import { Cause, Context, Effect, Layer, Option, Schema, Scope, Stream } from "effect"
import { AISDKCache } from "./aisdk-cache"
import { ModelV2 } from "./model"
import { ProviderV2 } from "./provider"
import { State } from "./state"

type SDK = any
type UserContent = Extract<LanguageModelV3Message, { role: "user" }>["content"]
type AssistantContent = Extract<LanguageModelV3Message, { role: "assistant" }>["content"]
type ToolResultContent = Extract<AssistantContent[number], { type: "tool-result" }>

export interface SDKEvent {
  readonly model: ModelV2.Info
  readonly package: string
  readonly options: Record<string, any>
  sdk?: SDK
}

export interface LanguageEvent {
  readonly model: ModelV2.Info
  readonly sdk: SDK
  readonly options: Record<string, any>
  language?: LanguageModelV3
}

function wrapSSE(res: Response, ms: number, ctl: AbortController) {
  if (typeof ms !== "number" || ms <= 0) return res
  if (!res.body) return res
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return res

  const reader = res.body.getReader()

  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      let id: ReturnType<typeof setTimeout> | undefined
      const clear = () => {
        if (id !== undefined) {
          clearTimeout(id)
          id = undefined
        }
      }
      try {
        const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
          id = setTimeout(() => {
            const err = new Error("SSE read timed out")
            try {
              ctl.abort(err)
            } catch {}
            void reader.cancel(err).finally(clear)
            reject(err)
          }, ms)

          reader.read().then(
            (part) => {
              clear()
              resolve(part)
            },
            (err) => {
              clear()
              reject(err)
            },
          )
        })

        if (part.done) {
          clear()
          ctrl.close()
          return
        }

        ctrl.enqueue(part.value)
      } catch (error) {
        clear()
        const reason = error instanceof Error ? error : new Error(String(error))
        try {
          await reader.cancel(reason)
        } catch {}
        throw error
      }
    },
    async cancel(reason) {
      try {
        ctl.abort(reason)
      } catch {}
      try {
        await reader.cancel(reason)
      } catch {}
    },
  })

  return new Response(body, {
    headers: new Headers(res.headers),
    status: res.status,
    statusText: res.statusText,
  })
}

function prepareOptions(model: ModelV2.Info, pkg: string) {
  const projected = mapBodyToProviderOptions(model, pkg)
  const options: Record<string, any> = {
    name: model.providerID,
    ...(model.settings ?? {}),
    headers: model.headers,
    body: projected.body,
  }

  const customFetch = options.fetch
  const chunkTimeout = options.chunkTimeout
  delete options.chunkTimeout
  options.fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const opts = { ...(init ?? {}) }
    const signals = [
      opts.signal,
      typeof chunkTimeout === "number" && chunkTimeout > 0 ? new AbortController() : undefined,
      options.timeout !== undefined && options.timeout !== null && options.timeout !== false
        ? AbortSignal.timeout(options.timeout)
        : undefined,
    ].filter((item): item is AbortSignal | AbortController => Boolean(item))
    const chunkAbortCtl = signals.find((item): item is AbortController => item instanceof AbortController)
    const abortSignals = signals.map((item) => (item instanceof AbortController ? item.signal : item))
    if (abortSignals.length === 1) opts.signal = abortSignals[0]
    if (abortSignals.length > 1) opts.signal = AbortSignal.any(abortSignals)

    if (
      (pkg === "@ai-sdk/openai" || pkg === "@ai-sdk/azure" || pkg === "@ai-sdk/amazon-bedrock/mantle") &&
      opts.body &&
      opts.method === "POST"
    ) {
      const body = JSON.parse(opts.body as string)
      if (body.store !== true && Array.isArray(body.input)) {
        for (const item of body.input) {
          if ("id" in item) delete item.id
        }
        opts.body = JSON.stringify(body)
      }
    }

    if (typeof opts.body === "string" && model.body !== undefined) {
      const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(opts.body))
      if (Schema.is(Schema.Record(Schema.String, Schema.Json))(decoded)) {
        opts.body = JSON.stringify(ProviderV2.mergeOverlay(decoded, model.body))
      }
    }

    const res = await (typeof customFetch === "function" ? customFetch : fetch)(input, {
      ...opts,
      timeout: false,
    })
    if (!chunkAbortCtl || typeof chunkTimeout !== "number") return res
    return wrapSSE(res, chunkTimeout, chunkAbortCtl)
  }

  return options
}

export class InitError extends Schema.TaggedErrorClass<InitError>()("AISDK.InitError", {
  providerID: ProviderV2.ID,
  cause: Schema.Defect(),
}) {}

function initError(providerID: ProviderV2.ID) {
  return Effect.catchCause((cause) => Effect.fail(new InitError({ providerID, cause: Cause.squash(cause) })))
}

export interface Interface {
  readonly hook: {
    readonly sdk: (
      callback: (event: SDKEvent) => Effect.Effect<void> | void,
    ) => Effect.Effect<State.Registration, never, Scope.Scope>
    readonly language: (
      callback: (event: LanguageEvent) => Effect.Effect<void> | void,
    ) => Effect.Effect<State.Registration, never, Scope.Scope>
  }
  readonly runSDK: (event: SDKEvent) => Effect.Effect<SDKEvent>
  readonly runLanguage: (event: LanguageEvent) => Effect.Effect<LanguageEvent>
  readonly language: (model: ModelV2.Info) => Effect.Effect<LanguageModelV3, InitError>
  readonly model: (model: ModelV2.Info) => Effect.Effect<Model, InitError>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/AISDK") {}

export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    let sdkHooks: ((event: SDKEvent) => Effect.Effect<void> | void)[] = []
    let languageHooks: ((event: LanguageEvent) => Effect.Effect<void> | void)[] = []
    const languages = new Map<string, LanguageModelV3>()
    const sdks = new Map<string, SDK>()
    const functionIDs = new WeakMap<object, number>()
    let nextFunctionID = 0
    const cacheKey = (input: unknown) =>
      JSON.stringify(input, (_key, value: unknown) => {
        if (typeof value !== "function") return value
        const existing = functionIDs.get(value)
        if (existing !== undefined) return `function:${existing}`
        const id = nextFunctionID++
        functionIDs.set(value, id)
        return `function:${id}`
      }) ?? ""

    const register = <Event>(
      hooks: () => ((event: Event) => Effect.Effect<void> | void)[],
      update: (hooks: ((event: Event) => Effect.Effect<void> | void)[]) => void,
    ) =>
      Effect.fn("AISDK.hook")(function* (callback: (event: Event) => Effect.Effect<void> | void) {
        const scope = yield* Scope.Scope
        let active = true
        update([...hooks(), callback])
        const dispose = Effect.sync(() => {
          if (!active) return
          active = false
          update(hooks().filter((item) => item !== callback))
        })
        yield* Scope.addFinalizer(scope, dispose)
        return { dispose }
      })

    const run = Effect.fnUntraced(function* <Event>(
      hooks: readonly ((event: Event) => Effect.Effect<void> | void)[],
      event: Event,
    ) {
      for (const hook of hooks) {
        const result = hook(event)
        if (Effect.isEffect(result)) yield* result
      }
      return event
    })

    const service = Service.of({
      hook: {
        sdk: register(
          () => sdkHooks,
          (next) => (sdkHooks = next),
        ),
        language: register(
          () => languageHooks,
          (next) => (languageHooks = next),
        ),
      },
      runSDK: (event) => run(sdkHooks, event),
      runLanguage: (event) => run(languageHooks, event),
      language: Effect.fn("AISDK.language")(function* (model) {
        const key = cacheKey({
          providerID: model.providerID,
          id: model.id,
          modelID: model.modelID,
          package: model.package,
          settings: model.settings,
          headers: model.headers,
          body: model.body,
          limit: model.limit,
        })
        const existing = languages.get(key)
        if (existing) return existing
        if (!ProviderV2.isAISDK(model.package))
          return yield* new InitError({
            providerID: model.providerID,
            cause: new Error(`Unsupported package ${model.package}`),
          })

        const packageName = ProviderV2.packageName(model.package)
        const options = prepareOptions(model, packageName)
        const sdkKey = cacheKey({
          providerID: model.providerID,
          package: packageName,
          settings: model.settings,
          headers: model.headers,
          body: model.body,
        })
        const sdk =
          sdks.get(sdkKey) ??
          (yield* service.runSDK({ model, package: packageName, options }).pipe(initError(model.providerID))).sdk
        if (!sdk)
          return yield* new InitError({
            providerID: model.providerID,
            cause: new Error("No AISDK provider plugin returned an SDK"),
          })
        sdks.set(sdkKey, sdk)
        const result = yield* service.runLanguage({ model, sdk, options }).pipe(initError(model.providerID))
        const language = yield* Effect.sync(() => result.language ?? sdk.languageModel(model.modelID ?? model.id)).pipe(
          initError(model.providerID),
        )
        languages.set(key, language)
        return language
      }),
      model: Effect.fn("AISDK.model")(function* (model) {
        return modelFromLanguage(model, yield* service.language(model))
      }),
    })
    return service
  }),
)

export const defaultLayer = locationLayer

function modelFromLanguage(info: ModelV2.Info, language: LanguageModelV3) {
  const packageName = ProviderV2.packageName(info.package!)
  const projected = mapBodyToProviderOptions(info, packageName)
  const optionKey = providerOptionKey(packageName, info.providerID)
  const providerOptions = (() => {
    if (projected.settings === undefined) return
    if (packageName === "@ai-sdk/gateway") return gatewayProviderOptions(info.modelID ?? info.id, projected.settings)
    if (packageName === "@ai-sdk/azure") return { openai: projected.settings, azure: projected.settings }
    return { [optionKey]: projected.settings }
  })()
  const route: AnyRoute = {
    id: `ai-sdk:${packageName}`,
    provider: ProviderID.make(info.providerID),
    providerMetadataKey: optionKey,
    protocol: "ai-sdk",
    endpoint: Endpoint.path("/", { baseURL: "https://ai-sdk.local" }),
    auth: Auth.none,
    transport: {
      id: "ai-sdk",
      prepare: (input) => Effect.succeed(input.body),
      frames: () => Stream.empty,
    },
    defaults: {
      headers: info.headers,
      http:
        projected.body === undefined && info.headers === undefined
          ? undefined
          : {
              body: projected.body === undefined ? undefined : { ...projected.body },
              headers: info.headers,
            },
      limits: { context: info.limit.context, output: info.limit.output },
      providerOptions,
    },
    body: {
      schema: Schema.Unknown,
      from: (request) => Effect.succeed(callOptions(request)),
    },
    with: () => route,
    model: (input) => Model.make({ ...input, provider: "provider" in input ? input.provider : info.providerID, route }),
    prepareTransport: (body) => Effect.succeed(body),
    streamPrepared: (prepared) => streamLanguage(language, prepared as LanguageModelV3CallOptions),
  }
  return Model.make({ id: info.modelID ?? info.id, provider: info.providerID, route })
}

function gatewayProviderOptions(modelID: ModelV2.ID, settings: Readonly<Record<string, unknown>>) {
  const gateway =
    typeof settings.gateway === "object" && settings.gateway !== null && !Array.isArray(settings.gateway)
      ? Object.fromEntries(Object.entries(settings.gateway))
      : undefined
  const model = Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "gateway"))
  if (Object.keys(model).length === 0) return gateway === undefined ? undefined : { gateway }

  const separator = modelID.indexOf("/")
  const prefix = separator > 0 ? modelID.slice(0, separator) : undefined
  if (prefix)
    return { ...(gateway === undefined ? {} : { gateway }), [prefix === "amazon" ? "bedrock" : prefix]: model }
  if (typeof gateway === "object" && gateway !== null && !Array.isArray(gateway))
    return { gateway: { ...gateway, ...model } }
  return { gateway: model }
}

function providerOptionKey(packageName: string | undefined, providerID: ProviderV2.ID) {
  if (packageName === "@ai-sdk/google") return "google"
  if (packageName === "@ai-sdk/google-vertex") return "vertex"
  if (packageName === "@ai-sdk/google-vertex/anthropic") return "anthropic"
  if (packageName === "@ai-sdk/amazon-bedrock") return "bedrock"
  if (packageName === "@ai-sdk/amazon-bedrock/mantle") return "openai"
  if (packageName === "@ai-sdk/azure") return "azure"
  if (packageName === "@ai-sdk/github-copilot") return "copilot"
  if (packageName === "@jerome-benoit/sap-ai-provider-v2") return "sap-ai"
  if (packageName === "@ai-sdk/openai-compatible") return providerID.split(".")[0]
  if (packageName === "@openrouter/ai-sdk-provider") return "openrouter"
  if (packageName === "ai-gateway-provider") return "openaiCompatible"
  if (packageName?.startsWith("@ai-sdk/")) return packageName.slice("@ai-sdk/".length)
  return providerID
}

function requestSettings(settings: Readonly<Record<string, unknown>> | undefined) {
  if (settings === undefined) return undefined
  const result = Object.fromEntries(
    Object.entries(settings).filter(
      ([key]) => !["apiKey", "authToken", "baseURL", "chunkTimeout", "fetch", "timeout"].includes(key),
    ),
  )
  return Object.keys(result).length === 0 ? undefined : result
}

function mapBodyToProviderOptions(model: ModelV2.Info, packageName: string) {
  const settings = requestSettings(model.settings)
  const pro = Schema.is(Schema.Struct({ mode: Schema.Literal("pro") }))(model.body?.reasoning)
  const forceReasoning =
    ["@ai-sdk/openai", "@ai-sdk/azure", "@ai-sdk/amazon-bedrock/mantle"].includes(packageName) &&
    (pro || settings?.reasoningEffort !== undefined || settings?.reasoningSummary !== undefined)
  const normalized = forceReasoning ? ProviderV2.mergeOverlay(settings, { forceReasoning: true }) : settings
  if (!pro) return { settings: normalized, body: model.body }
  const body = { ...model.body }
  delete body.reasoning
  return {
    settings: ProviderV2.mergeOverlay(normalized, { reasoningMode: "pro" }),
    body: Object.keys(body).length === 0 ? undefined : body,
  }
}

const ANTHROPIC_MESSAGE_ROUTES = new Set(["ai-sdk:@ai-sdk/anthropic", "ai-sdk:@ai-sdk/google-vertex/anthropic"])

function isAnthropicMessagesRoute(request: LLMRequest) {
  return ANTHROPIC_MESSAGE_ROUTES.has(request.model.route.id)
}

function usesAnthropicToolSchema(request: LLMRequest) {
  return isAnthropicMessagesRoute(request) || AnthropicModel.normalize(String(request.model.id)).family !== "unknown"
}

function callOptions(request: LLMRequest): LanguageModelV3CallOptions {
  return {
    prompt: prompt(request),
    maxOutputTokens: request.generation?.maxTokens ?? request.model.route.defaults.limits?.output,
    temperature: request.generation?.temperature,
    stopSequences: request.generation?.stop === undefined ? undefined : [...request.generation.stop],
    topP: request.generation?.topP,
    topK: request.generation?.topK,
    presencePenalty: request.generation?.presencePenalty,
    frequencyPenalty: request.generation?.frequencyPenalty,
    seed: request.generation?.seed,
    responseFormat: responseFormat(request),
    tools: request.tools.map((input) => tool(request, input)),
    toolChoice: toolChoice(request.toolChoice),
    headers: request.http?.headers,
    providerOptions: providerOptions(request.providerOptions),
  }
}

function prompt(request: LLMRequest): LanguageModelV3Prompt {
  const system = request.system
    .map((part) => part.text)
    .filter(Boolean)
    .join("\n\n")
  const messages = isAnthropicMessagesRoute(request)
    ? anthropicMessages(request)
    : request.messages.flatMap((input) => message(request, input))
  if (!system.length) return messages
  const options = AISDKCache.options(
    request.model.route.id,
    request.system.findLast((part) => part.cache !== undefined)?.cache,
  )
  return [
    {
      role: "system",
      content: system,
      ...(options === undefined ? {} : { providerOptions: options }),
    },
    ...messages,
  ]
}

function validAnthropicSystemUpdate(request: LLMRequest, index: number): boolean {
  if (!AnthropicModel.capabilities(String(request.model.id)).midConversationSystem) return false
  const previous = request.messages[index - 1]
  const next = request.messages[index + 1]
  const last = previous?.content.at(-1)
  const followsServerToolUse =
    previous?.role === "assistant" && last?.type === "tool-call" && last.providerExecuted === true
  return (
    previous !== undefined &&
    previous.role !== "system" &&
    (previous.role === "user" || previous.role === "tool" || followsServerToolUse) &&
    next?.role !== "system" &&
    (next === undefined || next.role === "assistant")
  )
}

function latestTextCache(parts: ReadonlyArray<ContentPart>) {
  const latest = parts.findLast((part) => part.type === "text" && part.cache !== undefined)
  return latest?.type === "text" ? latest.cache : undefined
}

function anthropicMessages(request: LLMRequest): LanguageModelV3Message[] {
  const messages: LanguageModelV3Message[] = []
  for (const [index, input] of request.messages.entries()) {
    if (input.role !== "system" || validAnthropicSystemUpdate(request, index)) {
      messages.push(...message(request, input))
      continue
    }

    const options = AISDKCache.options(request.model.route.id, latestTextCache(input.content))
    const block = {
      type: "text" as const,
      text: ProviderShared.wrapSystemUpdate(
        input.content.flatMap((part) => (part.type === "text" ? [{ text: part.text }] : [])),
      ),
      ...(options === undefined ? {} : { providerOptions: options }),
    }
    const previous = messages.at(-1)
    if (previous?.role === "user" && Array.isArray(previous.content)) {
      previous.content.push(block)
    } else {
      messages.push({ role: "user", content: [block] })
    }
  }
  return messages
}

function message(request: LLMRequest, input: LLMRequest["messages"][number]): LanguageModelV3Message[] {
  switch (input.role) {
    case "system": {
      if (isAnthropicMessagesRoute(request)) {
        const options = AISDKCache.options(request.model.route.id, latestTextCache(input.content))
        return [
          {
            role: "system",
            content: input.content.flatMap(text).join("\n\n"),
            ...(options === undefined ? {} : { providerOptions: options }),
          },
        ]
      }
      const options = AISDKCache.options(request.model.route.id, latestTextCache(input.content))
      const block = {
        type: "text" as const,
        text: ProviderShared.wrapSystemUpdate(
          input.content.flatMap((part) => (part.type === "text" ? [{ text: part.text }] : [])),
        ),
        ...(options === undefined ? {} : { providerOptions: options }),
      }
      return [{ role: "user", content: [block] }]
    }
    case "user":
      return [{ role: "user", content: input.content.flatMap((part) => userPart(request, part)) }]
    case "assistant":
      return [{ role: "assistant", content: input.content.flatMap((part) => assistantPart(request, part)) }]
    case "tool": {
      const content = input.content.flatMap((part) => toolResultPart(request, part))
      return content.length ? [{ role: "tool", content }] : []
    }
  }
}

function text(part: ContentPart) {
  return part.type === "text" ? [part.text] : []
}

function userPart(request: LLMRequest, part: ContentPart): UserContent {
  if (part.type === "text") {
    const options = AISDKCache.options(request.model.route.id, part.cache)
    return [
      {
        type: "text",
        text: part.text,
        ...(options === undefined ? {} : { providerOptions: options }),
      },
    ]
  }
  if (part.type === "media")
    return [{ type: "file", mediaType: part.mediaType, data: part.data, filename: part.filename }]
  return []
}

function assistantPart(request: LLMRequest, part: ContentPart): AssistantContent {
  switch (part.type) {
    case "text": {
      const options = AISDKCache.merge(
        providerOptions(part.providerMetadata),
        AISDKCache.options(request.model.route.id, part.cache),
      )
      return [
        {
          type: "text",
          text: part.text,
          ...(options === undefined ? {} : { providerOptions: options }),
        },
      ]
    }
    case "media":
      return [{ type: "file", mediaType: part.mediaType, data: part.data, filename: part.filename }]
    case "reasoning":
      return [{ type: "reasoning", text: part.text, providerOptions: providerOptions(part.providerMetadata) }]
    case "tool-call":
      return [
        {
          type: "tool-call",
          toolCallId: part.id,
          toolName: part.name,
          input: part.input,
          providerExecuted: part.providerExecuted,
          providerOptions: providerOptions(part.providerMetadata),
        },
      ]
    case "tool-result":
      return toolResultPart(request, part)
  }
}

function toolResultPart(request: LLMRequest, part: ContentPart): ToolResultContent[] {
  if (part.type !== "tool-result") return []
  const options = AISDKCache.merge(
    providerOptions(part.providerMetadata),
    AISDKCache.options(request.model.route.id, part.cache),
  )
  return [
    {
      type: "tool-result",
      toolCallId: part.id,
      toolName: part.name,
      output: toolOutput(part.result),
      ...(options === undefined ? {} : { providerOptions: options }),
    },
  ]
}

function toolOutput(result: ToolResultValue) {
  switch (result.type) {
    case "text":
    case "error":
      return { type: "text" as const, value: messageValue(result.value) }
  }
  return { type: "json" as const, value: jsonValue(result.value) }
}

function tool(request: LLMRequest, input: ToolDefinition): LanguageModelV3FunctionTool {
  const options = AISDKCache.options(request.model.route.id, input.cache)
  const schema = usesAnthropicToolSchema(request)
    ? ToolSchemaProjection.anthropic(input.inputSchema)
    : input.inputSchema
  return {
    type: "function",
    name: input.name,
    description: input.description,
    inputSchema: schema as JSONSchema7,
    ...(options === undefined ? {} : { providerOptions: options }),
  }
}

function toolChoice(input: LLMRequest["toolChoice"]): LanguageModelV3ToolChoice | undefined {
  if (!input) return undefined
  if (input.type === "tool") return input.name === undefined ? undefined : { type: "tool", toolName: input.name }
  return { type: input.type }
}

function responseFormat(request: LLMRequest): LanguageModelV3CallOptions["responseFormat"] {
  if (request.responseFormat?.type === "json")
    return { type: "json", schema: request.responseFormat.schema as JSONSchema7 }
  if (request.responseFormat) return { type: "text" }
}

function providerOptions(input: LLMRequest["providerOptions"]): SharedV3ProviderOptions | undefined {
  if (!input) return undefined
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, jsonObject(value)]))
}

function streamLanguage(language: LanguageModelV3, options: LanguageModelV3CallOptions) {
  const state = { step: 0, toolNames: {} as Record<string, string> }
  return Stream.concat(
    Stream.make(LLMEvent.stepStart({ index: state.step })),
    Stream.unwrap(
      Effect.tryPromise({
        try: () => language.doStream(options),
        catch: (error) => llmError("doStream", error),
      }).pipe(
        Effect.map((result) =>
          Stream.fromReadableStream({
            evaluate: () => result.stream,
            onError: (error) => llmError("readStream", error),
          }).pipe(
            Stream.mapEffect((event) => streamPartEvents(state, event)),
            Stream.flatMap((events) => Stream.fromIterable(events)),
          ),
        ),
      ),
    ),
  )
}

function streamPartEvents(
  state: { step: number; toolNames: Record<string, string> },
  event: LanguageModelV3StreamPart,
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMError> {
  switch (event.type) {
    case "stream-start":
    case "response-metadata":
    case "raw":
    case "file":
    case "source":
    case "tool-approval-request":
      return Effect.succeed([])
    case "text-start":
      return Effect.succeed([
        LLMEvent.textStart({ id: event.id, providerMetadata: providerMetadata(event.providerMetadata) }),
      ])
    case "text-delta":
      return Effect.succeed([
        LLMEvent.textDelta({
          id: event.id,
          text: event.delta,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])
    case "text-end":
      return Effect.succeed([
        LLMEvent.textEnd({ id: event.id, providerMetadata: providerMetadata(event.providerMetadata) }),
      ])
    case "reasoning-start":
      return Effect.succeed([
        LLMEvent.reasoningStart({ id: event.id, providerMetadata: providerMetadata(event.providerMetadata) }),
      ])
    case "reasoning-delta":
      return Effect.succeed([
        LLMEvent.reasoningDelta({
          id: event.id,
          text: event.delta,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])
    case "reasoning-end":
      return Effect.succeed([
        LLMEvent.reasoningEnd({ id: event.id, providerMetadata: providerMetadata(event.providerMetadata) }),
      ])
    case "tool-input-start":
      state.toolNames[event.id] = event.toolName
      return Effect.succeed([
        LLMEvent.toolInputStart({
          id: event.id,
          name: event.toolName,
          providerExecuted: event.providerExecuted,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])
    case "tool-input-delta":
      return Effect.succeed([
        LLMEvent.toolInputDelta({ id: event.id, name: state.toolNames[event.id] ?? "unknown", text: event.delta }),
      ])
    case "tool-input-end":
      return Effect.succeed([
        LLMEvent.toolInputEnd({
          id: event.id,
          name: state.toolNames[event.id] ?? "unknown",
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])
    case "tool-call":
      state.toolNames[event.toolCallId] = event.toolName
      return ProviderShared.parseToolInput("aisdk", event.toolName, event.input).pipe(
        Effect.map((input) => [
          LLMEvent.toolCall({
            id: event.toolCallId,
            name: event.toolName,
            input,
            providerExecuted: event.providerExecuted,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]),
        Effect.catch((error) =>
          event.providerExecuted
            ? Effect.fail(error)
            : Effect.succeed([
                LLMEvent.toolInputError({
                  id: event.toolCallId,
                  name: event.toolName,
                  raw: event.input,
                }),
              ]),
        ),
      )
    case "tool-result":
      delete state.toolNames[event.toolCallId]
      return Effect.succeed([
        LLMEvent.toolResult({
          id: event.toolCallId,
          name: event.toolName,
          result: ToolResultValue.make(event.result, event.isError ? "error" : "json"),
          providerExecuted: true,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])
    case "finish":
      return Effect.succeed([
        LLMEvent.stepFinish({
          index: state.step++,
          reason: finishReason(event.finishReason),
          usage: usage(event.usage),
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
        LLMEvent.finish({
          reason: finishReason(event.finishReason),
          usage: usage(event.usage),
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])
    case "error":
      return Effect.fail(llmError("stream", event.error))
  }
}

function usage(input: Extract<LanguageModelV3StreamPart, { type: "finish" }>["usage"]): UsageInput | undefined {
  const normalized = ProviderShared.normalizeInputUsage({
    semantics: "ai-sdk",
    total: input.inputTokens.total,
    nonCached: input.inputTokens.noCache,
    cacheRead: input.inputTokens.cacheRead,
    cacheWrite: input.inputTokens.cacheWrite,
  })
  const output = {
    ...normalized,
    outputTokens: input.outputTokens.total,
    reasoningTokens: input.outputTokens.reasoning,
    totalTokens:
      normalized.inputTokens === undefined || input.outputTokens.total === undefined
        ? undefined
        : normalized.inputTokens + input.outputTokens.total,
  }
  return Object.values(output).some((value) => value !== undefined) ? output : undefined
}

function finishReason(value: LanguageModelV3FinishReason): FinishReason {
  return value.unified === "other" ? "unknown" : value.unified
}

function providerMetadata(value: unknown) {
  return Schema.is(ProviderMetadata)(value) ? value : undefined
}

const decodeJsonValue = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))

function mutableJson(value: Schema.Json): JSONValue {
  if (Array.isArray(value)) return value.map(mutableJson)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mutableJson(item)]))
  return value
}

function jsonObject(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, jsonValue(value)]))
}

function jsonValue(input: unknown): JSONValue {
  try {
    const encoded = JSON.stringify(input)
    return encoded === undefined ? null : mutableJson(decodeJsonValue(encoded))
  } catch {
    return messageValue(input)
  }
}

function messageValue(input: unknown) {
  if (typeof input === "string") return input
  try {
    return JSON.stringify(input) ?? String(input)
  } catch {
    return String(input)
  }
}

const AISDK_ERROR_BODY_LIMIT = 16_384
const AISDK_REDACTED = "<redacted>"
const AISDK_SENSITIVE_NAME =
  /authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|credential|signature|cookie/i
const AISDK_SHORT_SENSITIVE_QUERY_NAME = /^(?:key|sig)$/i

const isSensitiveName = (name: string) => AISDK_SENSITIVE_NAME.test(name)
const isSensitiveQueryName = (name: string) => isSensitiveName(name) || AISDK_SHORT_SENSITIVE_QUERY_NAME.test(name)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function safeErrorHeaders(value: unknown) {
  const entries: Array<[string, string]> = []
  if (value instanceof Headers) {
    value.forEach((item, name) => entries.push([name, item]))
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (!Array.isArray(item) || item.length < 2 || typeof item[0] !== "string") continue
      entries.push([item[0], String(item[1])])
    }
  } else if (isRecord(value)) {
    for (const [name, item] of Object.entries(value)) {
      if (item === undefined || item === null) continue
      entries.push([name, Array.isArray(item) ? item.map(String).join(", ") : String(item)])
    }
  }
  return Object.fromEntries(
    entries.map(([name, item]) => {
      const normalized = name.toLowerCase()
      return [normalized, isSensitiveName(normalized) ? AISDK_REDACTED : item]
    }),
  )
}

function safeErrorUrl(value: unknown) {
  if (typeof value !== "string" || !URL.canParse(value)) return "about:blank"
  const url = new URL(value)
  url.searchParams.forEach((_, name) => {
    if (isSensitiveQueryName(name)) url.searchParams.set(name, AISDK_REDACTED)
  })
  return url.toString()
}

function redactErrorValue(value: unknown, name?: string): unknown {
  if (name !== undefined && isSensitiveName(name)) return AISDK_REDACTED
  if (Array.isArray(value)) return value.map((item) => redactErrorValue(item))
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactErrorValue(item, key)]))
  return value
}

function collectSensitiveValues(value: unknown, target = new Set<string>(), name?: string) {
  if (name !== undefined && isSensitiveName(name)) {
    if (typeof value === "string" && value.length >= 4) {
      target.add(value)
      target.add(encodeURIComponent(value))
    } else if (Array.isArray(value)) {
      value.forEach((item) => collectSensitiveValues(item, target, name))
    }
    return target
  }
  if (Array.isArray(value)) value.forEach((item) => collectSensitiveValues(item, target))
  else if (isRecord(value)) Object.entries(value).forEach(([key, item]) => collectSensitiveValues(item, target, key))
  return target
}

function urlSensitiveValues(value: unknown) {
  const target = new Set<string>()
  if (typeof value !== "string" || !URL.canParse(value)) return target
  new URL(value).searchParams.forEach((item, name) => {
    if (!isSensitiveQueryName(name) || item.length < 4) return
    target.add(item)
    target.add(encodeURIComponent(item))
  })
  return target
}

function redactSensitiveValues(value: string, secrets: ReadonlySet<string>) {
  return Array.from(secrets).reduce((text, secret) => text.split(secret).join(AISDK_REDACTED), value)
}

function safeErrorBody(value: unknown, secrets: ReadonlySet<string>) {
  if (typeof value !== "string") return {}
  let body: string
  try {
    body = JSON.stringify(redactErrorValue(JSON.parse(value)))
  } catch {
    body = value
      .replace(/\bBearer\s+[^\s"']+/gi, `Bearer ${AISDK_REDACTED}`)
      .replace(
        /((?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|credential|signature)\s*[=:]\s*)[^\s,"']+/gi,
        `$1${AISDK_REDACTED}`,
      )
  }
  body = redactSensitiveValues(body, secrets)
  if (body.length <= AISDK_ERROR_BODY_LIMIT) return { body }
  return { body: body.slice(0, AISDK_ERROR_BODY_LIMIT), bodyTruncated: true }
}

function providerErrorDetails(value: unknown) {
  if (typeof value !== "string") return {}
  try {
    const decoded = JSON.parse(value)
    if (!isRecord(decoded)) return {}
    const nested = isRecord(decoded.error) ? decoded.error : undefined
    const message =
      typeof nested?.message === "string"
        ? nested.message
        : typeof decoded.message === "string"
          ? decoded.message
          : undefined
    const code =
      typeof nested?.type === "string"
        ? nested.type
        : typeof nested?.code === "string"
          ? nested.code
          : typeof decoded.code === "string"
            ? decoded.code
            : typeof decoded.type === "string" && decoded.type !== "error"
              ? decoded.type
              : undefined
    return { message, code }
  } catch {
    return {}
  }
}

function responseRequestId(headers: Record<string, string>) {
  return (
    headers["x-request-id"] ??
    headers["request-id"] ??
    headers["x-amzn-requestid"] ??
    headers["x-amz-request-id"] ??
    headers["x-goog-request-id"] ??
    headers["cf-ray"]
  )
}

function meaningfulProviderMessage(value: string | undefined) {
  const message = value?.trim()
  if (!message || /^(?:error|unknown error|request failed)$/i.test(message)) return undefined
  return message
}

function aiSdkProviderReason(error: unknown) {
  if (!isRecord(error)) return undefined
  const structured = "statusCode" in error || "responseBody" in error || "responseHeaders" in error || "url" in error
  if (!structured) return undefined

  const status = typeof error.statusCode === "number" ? error.statusCode : undefined
  const responseBody = typeof error.responseBody === "string" ? error.responseBody : undefined
  const headers = safeErrorHeaders(error.responseHeaders)
  const secrets = collectSensitiveValues(error.requestBodyValues)
  urlSensitiveValues(error.url).forEach((value) => secrets.add(value))
  const body = safeErrorBody(responseBody, secrets)
  const provider = providerErrorDetails(responseBody)
  const original = error instanceof Error ? error.message : undefined
  const message =
    meaningfulProviderMessage(
      provider.message === undefined ? undefined : redactSensitiveValues(provider.message, secrets),
    ) ??
    meaningfulProviderMessage(original === undefined ? undefined : redactSensitiveValues(original, secrets)) ??
    (provider.code
      ? `Provider reported ${provider.code}`
      : status === undefined
        ? "Provider request failed"
        : `Provider request failed with HTTP ${status}`)
  const retryAfter = retryAfterMsFromHeaders(headers)
  const rateLimit = rateLimitDetails(headers, retryAfter)
  const http = new HttpContext({
    request: new HttpRequestDetails({ method: "POST", url: safeErrorUrl(error.url), headers: {} }),
    response: status === undefined ? undefined : new HttpResponseDetails({ status, headers }),
    ...body,
    requestId: responseRequestId(headers),
    rateLimit,
  })
  return classifyProviderFailure({
    status,
    message,
    code: provider.code,
    retryAfterMs: retryAfter,
    rateLimit,
    http,
  })
}

function llmError(method: string, error: unknown) {
  const reason =
    error instanceof LLMError
      ? new InvalidProviderOutputReason({ message: error.message })
      : (aiSdkProviderReason(error) ??
        (isTransportError(error)
          ? new TransportReason({ message: error.message })
          : new UnknownProviderReason({ message: error instanceof Error ? error.message : String(error) })))
  return new LLMError({
    module: "AISDK",
    method,
    reason,
  })
}

function isTransportError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false
  return /(?:socket|connection) (?:was )?closed unexpectedly|cannot connect to api|websocket closed with code 1006/i.test(
    error.message,
  )
}

export const node = makeLocationNode({ service: Service, layer: locationLayer, deps: [] })
