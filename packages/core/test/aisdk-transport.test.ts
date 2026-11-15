import { APICallError } from "@ai-sdk/provider"
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { InvalidProviderOutputReason, LLM, LLMError } from "@ycoding-ai/ai"
import { LLMClient, RequestExecutor } from "@ycoding-ai/ai/route"
import { AISDK } from "@ycoding-ai/core/aisdk"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Provider } from "@ycoding-ai/core/provider"
import { SessionRunnerRetry } from "@ycoding-ai/core/session/runner/retry"
import { expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(AISDK.locationLayer)
const client = LLMClient.layer.pipe(
  Layer.provide(Layer.succeed(RequestExecutor.Service, { execute: () => Effect.die("Unexpected native HTTP") })),
)
const model = CatalogModel.Info.make({
  ...CatalogModel.Info.empty(Provider.ID.make("synthetic"), CatalogModel.ID.make("synthetic")),
  package: Provider.aisdk("@ai-sdk/openai"),
})

const failed = (failure: unknown, boundary: "call" | "read" | "event" = "call") =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      const language: LanguageModelV3 = {
        specificationVersion: "v3",
        provider: "synthetic",
        modelId: "synthetic",
        supportedUrls: {},
        doGenerate: () => Promise.reject(new Error("Unexpected generate")),
        doStream: () => {
          if (boundary === "call") return Promise.reject(failure)
          return Promise.resolve({
            stream: new ReadableStream({
              start(controller) {
                if (boundary === "read") return controller.error(failure)
                controller.enqueue({ type: "error", error: failure })
                controller.close()
              },
            }),
          })
        },
      }
      event.sdk = { languageModel: () => language }
    })
    const resolved = yield* aisdk.model(model)
    return yield* LLMClient.generate(LLM.request({ model: resolved, prompt: "Synthetic" })).pipe(
      Effect.provide(client),
      Effect.exit,
    )
  })

const errorOf = (exit: Exit.Exit<unknown, LLMError>) => {
  if (Exit.isSuccess(exit)) throw new Error("Expected failure")
  const error = Cause.squash(exit.cause)
  if (!(error instanceof LLMError)) throw new Error("Expected LLMError")
  return error
}

for (const code of [
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
  "SocketTimeout",
]) {
  it.effect(`retries structured transport code ${code} through APICallError`, () =>
    Effect.gen(function* () {
      const error = errorOf(
        yield* failed(
          new APICallError({
            message: "Cannot connect to API",
            url: "https://synthetic.invalid",
            requestBodyValues: {},
            cause: Object.assign(new Error("Synthetic socket failure"), { code, errno: -54, syscall: "connect" }),
          }),
        ),
      )
      expect(error.reason).toMatchObject({ _tag: "Transport", kind: code, message: "Synthetic socket failure" })
      expect(SessionRunnerRetry.isRetryable(error)).toBe(true)
    }),
  )
}

for (const boundary of ["call", "read", "event"] as const) {
  it.effect(`unwraps the exhausted RetryError at the ${boundary} boundary`, () =>
    Effect.gen(function* () {
      const failure = new APICallError({
        message:
          "Cannot connect to API: ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
        url: "https://synthetic.invalid",
        requestBodyValues: {},
        cause: Object.assign(new Error("Underlying reset"), { code: "ECONNRESET" }),
      })
      const wrapper = Object.assign(new Error("Failed after retries"), {
        name: "AI_RetryError",
        errors: [new Error("Earlier attempt"), failure],
        lastError: failure,
      })
      const error = errorOf(yield* failed(wrapper, boundary))
      expect(error.reason).toMatchObject({ _tag: "Transport", kind: "ECONNRESET", message: "Underlying reset" })
    }),
  )
}

for (const [name, failure] of [
  ["errno", { errno: "ECONNRESET", syscall: "read", message: "Read reset" }],
  ["Bun name", { name: "ConnectionClosed", message: "Synthetic close" }],
  ["fetch TypeError", new TypeError("fetch failed")],
  ["Bun verbose-hint wrapper", new APICallError({
    message: "Cannot connect to API: ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
    url: "https://synthetic.invalid", requestBodyValues: {},
  })],
  ["socket hangup", new Error("socket hang up")],
  ["SDK retry flag", { name: "AI_APICallError", isRetryable: true, message: "Synthetic retryable failure" }],
  ["AggregateError", new AggregateError([Object.assign(new Error("Nested reset"), { code: "ECONNRESET" })])],
] as const) {
  it.effect(`recognizes ${name} transport evidence`, () =>
    Effect.gen(function* () {
      expect(errorOf(yield* failed(failure)).reason._tag).toBe("Transport")
    }),
  )
}

for (const [status, tag] of [
  [408, "ProviderInternal"],
  [429, "RateLimit"],
  [500, "ProviderInternal"],
  [503, "ProviderInternal"],
  ...Array.from({ length: 10 }, (_, index) => [520 + index, "ProviderInternal"] as const),
  [400, "InvalidRequest"],
  [401, "Authentication"],
  [403, "Authentication"],
  [404, "InvalidRequest"],
  [422, "InvalidRequest"],
] as const) {
  it.effect(`retains HTTP ${status} classification through nested wrappers`, () =>
    Effect.gen(function* () {
      const failure = Object.assign(new Error("Synthetic HTTP failure"), {
        status,
        isRetryable: true,
        cause: { code: "ECONNRESET" },
      })
      const error = errorOf(yield* failed({ lastError: failure, errors: [failure] }))
      expect(error.reason._tag).toBe(tag)
      expect(SessionRunnerRetry.isRetryable(error)).toBe(status === 408 || status === 429 || status >= 500)
    }),
  )
}

for (const boundary of ["call", "read", "event"] as const) {
  it.effect(`cancellation dominates nested transient failures at the ${boundary} boundary`, () =>
    Effect.gen(function* () {
      const failure = new AggregateError([
        { code: "ECONNRESET" },
        { cause: new DOMException("Synthetic cancellation", "AbortError") },
      ])
      const exit = yield* failed(failure, boundary)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }),
  )
}

it.effect("walks cycles and throwing fields without losing nested socket evidence", () =>
  Effect.gen(function* () {
    const failure: Record<string, unknown> = { cause: { code: "EPIPE", message: "Synthetic pipe" } }
    failure.lastError = failure
    Object.defineProperty(failure, "statusCode", {
      get() {
        throw new Error("Synthetic getter")
      },
    })
    expect(errorOf(yield* failed(failure)).reason).toMatchObject({ _tag: "Transport", kind: "EPIPE" })
  }),
)

it.effect("retains an already classified permanent LLMError", () =>
  Effect.gen(function* () {
    const failure = new LLMError({
      module: "synthetic",
      method: "schema",
      reason: new InvalidProviderOutputReason({ message: "Invalid schema" }),
    })
    expect(errorOf(yield* failed(failure))).toBe(failure)
  }),
)

it.effect("uses the final RetryError failure instead of historical HTTP failures", () =>
  Effect.gen(function* () {
    const failure = Object.assign(new Error("Final unavailable"), { statusCode: 503 })
    const error = errorOf(
      yield* failed({
        lastError: failure,
        errors: [{ statusCode: 401, message: "Earlier authentication failure" }, failure],
      }),
    )
    expect(error.reason).toMatchObject({ _tag: "ProviderInternal", status: 503, message: "Final unavailable" })
  }),
)

for (const [name, failure, tag] of [
  [
    "context overflow",
    { statusCode: 400, responseBody: '{"error":{"code":"context_length_exceeded","message":"Input too large"}}' },
    "InvalidRequest",
  ],
  [
    "billing exhaustion",
    { statusCode: 429, responseBody: '{"error":{"code":"insufficient_quota","message":"Billing exhausted"}}' },
    "QuotaExceeded",
  ],
  [
    "content policy",
    { statusCode: 400, responseBody: '{"error":{"message":"Content policy violation"}}' },
    "ContentPolicy",
  ],
  [
    "schema validation",
    { name: "AI_TypeValidationError", message: "Invalid schema", isRetryable: true },
    "InvalidProviderOutput",
  ],
  ["unknown", new Error("Synthetic unknown failure"), "UnknownProvider"],
] as const) {
  it.effect(`does not retry ${name}`, () =>
    Effect.gen(function* () {
      const error = errorOf(yield* failed(failure))
      expect(error.reason._tag).toBe(tag)
      expect(SessionRunnerRetry.isRetryable(error)).toBe(false)
    }),
  )
}

it.effect("an aborted doStream signal dominates a socket rejection", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    const controller = new AbortController()
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {
        languageModel: () => ({
          specificationVersion: "v3",
          provider: "synthetic",
          modelId: "synthetic",
          supportedUrls: {},
          doStream: () => Promise.reject({ code: "ECONNRESET", message: "Reset after cancellation" }),
        }),
      }
    })
    const resolved = yield* aisdk.model(model)
    const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({ model: resolved, prompt: "Synthetic" }),
    ).pipe(Effect.provide(client))
    controller.abort()
    const exit = yield* resolved.route
      .streamPrepared(
        { ...prepared.body, abortSignal: controller.signal },
        LLM.request({ model: resolved, prompt: "Synthetic" }),
        { http: { execute: () => Effect.die("Unexpected HTTP") } },
      )
      .pipe(Stream.runDrain, Effect.exit)
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  }),
)

it.effect("preserves custom fetch options, SSE bytes, and cancellation", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    let request: typeof fetch | undefined
    let captured: (RequestInit & { timeout?: false; verbose?: boolean }) | undefined
    let cancelled: unknown
    const customFetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        captured = init
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: synthetic\n\n"))
            },
            cancel(reason) {
              cancelled = reason
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
      { preconnect: fetch.preconnect },
    )
    yield* aisdk.hook.sdk((event) => {
      request = event.options.fetch
      event.sdk = { languageModel: () => ({}) }
    })
    const settings = { chunkTimeout: 1000 }
    Object.defineProperty(settings, "fetch", { value: customFetch, enumerable: true })
    yield* aisdk.language({ ...model, package: Provider.aisdk("@ai-sdk/anthropic"), settings })
    if (!request) throw new Error("Expected fetch wrapper")
    const controller = new AbortController()
    const headers = { Authorization: "Bearer syn_secret_123" }
    const response = yield* Effect.promise(() =>
      request!("https://synthetic.invalid", {
        method: "POST",
        headers,
        body: "syn_request_body",
        signal: controller.signal,
        credentials: "include",
      }),
    )
    expect(captured).toMatchObject({
      method: "POST",
      headers,
      body: "syn_request_body",
      timeout: false,
      credentials: "include",
    })
    expect(captured).not.toHaveProperty("verbose")
    const reader = response.body!.getReader()
    const chunk = yield* Effect.promise(() => reader.read())
    expect(new TextDecoder().decode(chunk.value)).toBe("data: synthetic\n\n")
    yield* Effect.promise(() => reader.cancel("Synthetic cancellation"))
    expect(captured?.signal?.aborted).toBe(true)
    expect(controller.signal.aborted).toBe(false)
    expect(cancelled).toBe("Synthetic cancellation")
  }),
)
