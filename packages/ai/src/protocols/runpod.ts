import { Effect, Schema, Stream } from "effect"
import * as Option from "effect/Option"
import { HttpClientRequest } from "effect/unstable/http"
import { Route } from "../route/client"
import { Endpoint } from "../route/endpoint"
import { Protocol } from "../route/protocol"
import { HttpTransport } from "../route/transport"
import { RequestExecutor } from "../route/executor"
import { LLMEvent, Usage, type LLMError, type LLMRequest, type Message } from "../schema"
import { Lifecycle } from "./utils/lifecycle"
import { ProviderShared } from "./shared"
import { protocol as openAIChat } from "./openai-chat"

const OLLAMA = "runpod-ollama"
const VLLM = "runpod-vllm"
const OllamaBody = Schema.Struct({ input: Schema.Struct({
  messages: Schema.Array(Schema.Unknown),
  stream: Schema.Literal(false),
  options: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  tools: Schema.optional(Schema.Array(Schema.Unknown)),
}) })
const VLLMBody = Schema.Struct({ input: Schema.Struct({
  route: Schema.Literal("/v1/chat/completions"),
  method: Schema.Literal("POST"),
  body: Schema.Struct({
    model: Schema.String,
    messages: Schema.Array(Schema.Unknown),
    stream: Schema.Literal(false),
    tools: Schema.optional(Schema.Array(Schema.Unknown)),
    tool_choice: Schema.optional(Schema.Unknown),
    temperature: Schema.optional(Schema.Number),
    top_p: Schema.optional(Schema.Number),
    top_k: Schema.optional(Schema.Number),
    max_tokens: Schema.optional(Schema.Number),
    seed: Schema.optional(Schema.Number),
    stop: Schema.optional(Schema.Array(Schema.String)),
    frequency_penalty: Schema.optional(Schema.Number),
    presence_penalty: Schema.optional(Schema.Number),
  }),
}) })

const ToolCall = Schema.Struct({ function: Schema.Struct({ name: Schema.String, arguments: Schema.Record(Schema.String, Schema.Unknown) }) })
const OllamaResponse = Schema.Struct({
  message: Schema.Struct({ role: Schema.Literal("assistant"), content: Schema.String, tool_calls: Schema.optional(Schema.Array(ToolCall)) }),
  done: Schema.Literal(true),
  done_reason: Schema.optional(Schema.String),
  prompt_eval_count: Schema.optional(Schema.Number),
  eval_count: Schema.optional(Schema.Number),
})
const VLLMResponse = Schema.Struct({
  choices: Schema.Array(Schema.Struct({
    message: Schema.Struct({
      role: Schema.Literal("assistant"),
      content: Schema.NullOr(Schema.String),
      tool_calls: Schema.optional(Schema.Array(Schema.Struct({
        id: Schema.String,
        type: Schema.Literal("function"),
        function: Schema.Struct({ name: Schema.String, arguments: Schema.String }),
      }))),
    }),
    finish_reason: Schema.String,
  })),
  usage: Schema.optional(Schema.Struct({
    prompt_tokens: Schema.optional(Schema.Number),
    completion_tokens: Schema.optional(Schema.Number),
    total_tokens: Schema.optional(Schema.Number),
    prompt_tokens_details: Schema.optional(Schema.NullOr(Schema.Struct({ cached_tokens: Schema.optional(Schema.Number) }))),
  })),
})
const Envelope = Schema.Struct({
  id: Schema.optional(Schema.String),
  status: Schema.String,
  output: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
})

const lowerMessage = (message: Message) => Effect.gen(function* () {
  if (message.role === "system") {
    const update = yield* ProviderShared.wrappedSystemUpdate(OLLAMA, message)
    return { role: "user", content: update.text }
  }
  if (message.role === "tool") {
    if (message.content.length !== 1 || message.content[0]?.type !== "tool-result")
      return yield* ProviderShared.invalidRequest("Runpod Ollama tool messages require one tool result")
    return { role: "tool", content: ProviderShared.toolResultText(message.content[0]) }
  }
  if (message.content.some((part) => part.type !== "text" && (message.role !== "assistant" || part.type !== "tool-call")))
    return yield* ProviderShared.invalidRequest("Runpod Ollama supports text and assistant tool calls only")
  return {
    role: message.role,
    content: message.content.filter((part) => part.type === "text").map((part) => part.text).join(""),
    ...(message.role === "assistant" ? {
      tool_calls: message.content.filter((part) => part.type === "tool-call").map((part) => ({
        function: { name: part.name, arguments: part.input },
      })),
    } : {}),
  }
})

const fromOllamaRequest = Effect.fn("RunpodOllama.fromRequest")(function* (request: LLMRequest) {
  if (request.toolChoice && request.toolChoice.type !== "auto" && request.toolChoice.type !== "none")
    return yield* ProviderShared.invalidRequest("Runpod Ollama supports only automatic or disabled tool choice")
  if (request.responseFormat && request.responseFormat.type !== "text")
    return yield* ProviderShared.invalidRequest("Runpod Ollama does not support structured response format")
  if (request.generation?.frequencyPenalty !== undefined || request.generation?.presencePenalty !== undefined)
    return yield* ProviderShared.invalidRequest("Runpod Ollama does not support frequency or presence penalties")
  const messages = yield* Effect.forEach(request.messages, lowerMessage)
  const system = request.system.map((part) => part.text).join("\n")
  return {
    input: {
      messages: [...(system ? [{ role: "system", content: system }] : []), ...messages],
      stream: false as const,
      options: {
        ...(request.generation?.temperature === undefined ? {} : { temperature: request.generation.temperature }),
        ...(request.generation?.topP === undefined ? {} : { top_p: request.generation.topP }),
        ...(request.generation?.maxTokens === undefined ? {} : { num_predict: request.generation.maxTokens }),
        ...(request.generation?.topK === undefined ? {} : { top_k: request.generation.topK }),
        ...(request.generation?.seed === undefined ? {} : { seed: request.generation.seed }),
        ...(request.generation?.stop === undefined ? {} : { stop: request.generation.stop }),
      },
      ...(request.tools.length && request.toolChoice?.type !== "none" ? { tools: request.tools.map((tool) => ({
        type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      })) } : {}),
    },
  }
})

const fromVLLMRequest = Effect.fn("RunpodVLLM.fromRequest")(function* (request: LLMRequest) {
  if (request.responseFormat && request.responseFormat.type !== "text")
    return yield* ProviderShared.invalidRequest("Runpod vLLM chat proxy does not support structured response format")
  if (request.messages.some((message) => message.content.some((part) =>
    part.type === "media" || part.type === "tool-result" && part.result.type === "content" && part.result.value.some((item: { readonly type: string }) => item.type === "file"),
  ))) return yield* ProviderShared.invalidRequest("Runpod vLLM chat proxy supports text media only")
  const chat = yield* openAIChat.body.from(request)
  return { input: {
    route: "/v1/chat/completions" as const,
    method: "POST" as const,
    body: {
      model: chat.model,
      messages: chat.messages,
      stream: false as const,
      ...(chat.tools === undefined ? {} : { tools: chat.tools }),
      ...(chat.tool_choice === undefined ? {} : { tool_choice: chat.tool_choice }),
      ...(chat.temperature === undefined ? {} : { temperature: chat.temperature }),
      ...(chat.top_p === undefined ? {} : { top_p: chat.top_p }),
      ...(request.generation?.topK === undefined ? {} : { top_k: request.generation.topK }),
      ...(chat.max_tokens === undefined ? {} : { max_tokens: chat.max_tokens }),
      ...(chat.seed === undefined ? {} : { seed: chat.seed }),
      ...(chat.stop === undefined ? {} : { stop: chat.stop }),
      ...(chat.frequency_penalty === undefined ? {} : { frequency_penalty: chat.frequency_penalty }),
      ...(chat.presence_penalty === undefined ? {} : { presence_penalty: chat.presence_penalty }),
    },
  } }
})

const errorMessage = (error: unknown): string | undefined => {
  if (typeof error === "string") return error
  if (ProviderShared.isRecord(error) && typeof error.message === "string") return error.message
  return undefined
}

const jobOutput = (envelope: Schema.Schema.Type<typeof Envelope>) => Effect.gen(function* () {
  if (envelope.status !== "COMPLETED") return { type: "error" as const, message: errorMessage(envelope.error) ?? `Runpod job ${envelope.status}` }
  if (Array.isArray(envelope.output) && envelope.output.length !== 1)
    return yield* ProviderShared.eventError("runpod", "Expected one aggregated worker response")
  const output = Array.isArray(envelope.output) ? envelope.output[0] : envelope.output
  if (ProviderShared.isRecord(output) && "error" in output)
    return { type: "error" as const, message: errorMessage(output.error) ?? "Runpod worker failed" }
  if (!output) return yield* ProviderShared.eventError("runpod", "Missing worker response")
  return { type: "output" as const, output }
})

const stepOllama = (state: { readonly lifecycle: Lifecycle.State; readonly requestID: string }, envelope: Schema.Schema.Type<typeof Envelope>) => Effect.gen(function* () {
  const events: LLMEvent[] = []
  const job = yield* jobOutput(envelope)
  if (job.type === "error") {
    events.push(LLMEvent.providerError({ message: job.message }))
    return [state, events] as const
  }
  const response = yield* Schema.decodeUnknownEffect(OllamaResponse)(job.output).pipe(
    Effect.mapError(() => ProviderShared.eventError(OLLAMA, "Invalid Ollama response")),
  )
  const usage = Usage.from({
    inputTokens: response.prompt_eval_count,
    outputTokens: response.eval_count,
    totalTokens: response.prompt_eval_count === undefined || response.eval_count === undefined
      ? undefined : response.prompt_eval_count + response.eval_count,
  })
  const started = response.message.content ? Lifecycle.textDelta(state.lifecycle, events, "text-0", response.message.content) : state.lifecycle
  const closed = Lifecycle.textEnd(started, events, "text-0")
  if (response.message.tool_calls?.length) {
    Lifecycle.stepStart(closed, events)
    response.message.tool_calls.forEach((call, index) => events.push(LLMEvent.toolCall({
      id: `${state.requestID}-ollama-tool-${index}`, name: call.function.name, input: call.function.arguments,
    })))
  }
  const reason = response.message.tool_calls?.length ? "tool-calls" : response.done_reason === "length" ? "length" : "stop"
  return [{ ...state, lifecycle: Lifecycle.finish(closed, events, { reason, usage }) }, events] as const
})

const stepVLLM = (state: Lifecycle.State, envelope: Schema.Schema.Type<typeof Envelope>) => Effect.gen(function* () {
  const events: LLMEvent[] = []
  const job = yield* jobOutput(envelope)
  if (job.type === "error") {
    events.push(LLMEvent.providerError({ message: job.message }))
    return [state, events] as const
  }
  const response = yield* Schema.decodeUnknownEffect(VLLMResponse)(job.output).pipe(
    Effect.mapError(() => ProviderShared.eventError(VLLM, "Invalid vLLM response")),
  )
  if (response.choices.length !== 1) return yield* ProviderShared.eventError(VLLM, "Expected one vLLM choice")
  const choice = response.choices[0]
  if (choice.finish_reason !== "stop" && choice.finish_reason !== "length" && choice.finish_reason !== "tool_calls")
    return yield* ProviderShared.eventError(VLLM, `Unsupported vLLM finish reason: ${choice.finish_reason}`)
  if (choice.finish_reason === "tool_calls" && !choice.message.tool_calls?.length)
    return yield* ProviderShared.eventError(VLLM, "vLLM reported tool calls without tool inputs")
  const calls = yield* Effect.forEach(choice.message.tool_calls ?? [], (call) =>
    ProviderShared.parseToolInput(VLLM, call.function.name, call.function.arguments).pipe(
      Effect.map((input) => LLMEvent.toolCall({ id: call.id, name: call.function.name, input })),
    ))
  const started = choice.message.content ? Lifecycle.textDelta(state, events, "text-0", choice.message.content) : state
  const closed = Lifecycle.textEnd(started, events, "text-0")
  if (calls.length) Lifecycle.stepStart(closed, events)
  events.push(...calls)
  return [Lifecycle.finish(closed, events, { reason: calls.length || choice.finish_reason === "tool_calls" ? "tool-calls" : choice.finish_reason, usage: Usage.from({
    ...ProviderShared.normalizeInputUsage({ semantics: "inclusive-total", total: response.usage?.prompt_tokens,
      cacheRead: response.usage?.prompt_tokens_details?.cached_tokens }),
    outputTokens: response.usage?.completion_tokens,
    totalTokens: response.usage?.total_tokens,
  }) }), events] as const
})

const ollamaProtocol = Protocol.make({
  id: OLLAMA,
  body: { schema: OllamaBody, from: fromOllamaRequest },
  stream: { event: Protocol.jsonEvent(Envelope), initial: (request) => ({ lifecycle: Lifecycle.initial(), requestID: request.id ?? crypto.randomUUID() }), step: stepOllama },
})

const vllmProtocol = Protocol.make({
  id: VLLM,
  body: { schema: VLLMBody, from: fromVLLMRequest },
  stream: { event: Protocol.jsonEvent(Envelope), initial: Lifecycle.initial, step: stepVLLM },
})

const framing = { id: "json", frame: (bytes: Stream.Stream<Uint8Array, LLMError>) => Stream.fromEffect(bytes.pipe(
  Stream.decodeText(), Stream.runFold(() => "", (body, chunk) => body + chunk),
)) }

const jobsTransport = <Body>() => {
  const http = HttpTransport.httpJson<Body, string>({ framing })
  return {
    id: "runpod-jobs",
    prepare: http.prepare,
    frames: (prepared: HttpTransport.HttpPrepared<string>, request: LLMRequest, runtime: Parameters<typeof http.frames>[2]) =>
      Stream.fromEffect(Effect.gen(function* () {
        const first = yield* http.frames(prepared, request, runtime).pipe(Stream.runHead)
        if (Option.isNone(first)) return yield* ProviderShared.eventError("runpod", "Missing job response")
        const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Envelope))
        const initial = yield* decode(first.value).pipe(Effect.mapError(() => ProviderShared.eventError("runpod", "Invalid job response")))
        if (initial.status !== "IN_QUEUE" && initial.status !== "IN_PROGRESS") return first.value
        if (!initial.id) return yield* ProviderShared.eventError("runpod", "Unfinished job has no id")
        const url = new URL(prepared.request.url)
        url.pathname = `${url.pathname.slice(0, -"/runsync".length)}/status/${encodeURIComponent(initial.id)}`
        url.search = ""
        const poll = (): Effect.Effect<string, LLMError> => Effect.gen(function* () {
          yield* Effect.sleep("1 second")
          const response = yield* RequestExecutor.withFreshConnectionEffect(runtime.http.execute(
            HttpClientRequest.get(url.toString()).pipe(HttpClientRequest.setHeaders(prepared.request.headers)),
          ))
          const body = yield* response.text.pipe(Effect.mapError((error) => ProviderShared.streamReadError("runpod", error)))
          const job = yield* decode(body).pipe(Effect.mapError(() => ProviderShared.eventError("runpod", "Invalid job response")))
          if (job.id !== undefined && job.id !== initial.id)
            return yield* ProviderShared.eventError("runpod", "Status response belongs to another job")
          if (job.status !== "IN_QUEUE" && job.status !== "IN_PROGRESS") return body
          return yield* Effect.suspend(poll)
        })
        return yield* poll()
      })),
  }
}

export const ollamaRoute = Route.make({
  id: OLLAMA,
  protocol: ollamaProtocol,
  endpoint: Endpoint.path("/runsync"),
  transport: jobsTransport<Schema.Schema.Type<typeof OllamaBody>>(),
})

export const vllmRoute = Route.make({
  id: VLLM,
  protocol: vllmProtocol,
  endpoint: Endpoint.path("/runsync"),
  transport: jobsTransport<Schema.Schema.Type<typeof VLLMBody>>(),
})
