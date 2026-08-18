import { Cause, Context, Effect, Layer, Queue, Schema, Semaphore, Stream } from "effect"
import { Headers } from "effect/unstable/http"
import { LLMError, TransportReason, type LLMRequest } from "../../schema"
import * as ProviderShared from "../../protocols/shared"
import { Framing } from "../framing"
import * as HttpTransport from "./http"
import type { Transport } from "./index"
import { TransportAttempt } from "./attempt"

export interface WebSocketRequest {
  readonly url: string
  readonly headers: Headers.Headers
}

export interface WebSocketConnection {
  readonly sendText: (message: string) => Effect.Effect<void, LLMError>
  readonly messages: Stream.Stream<string | Uint8Array, LLMError>
  readonly close: Effect.Effect<void, never>
  readonly isOpen?: () => boolean
}

export interface Interface {
  readonly open: (input: WebSocketRequest) => Effect.Effect<WebSocketConnection, LLMError>
}

type WebSocketConstructorWithHeaders = new (
  url: string,
  options?: { readonly headers?: Headers.Headers },
) => globalThis.WebSocket

export class Service extends Context.Service<Service, Interface>()("@ycoding/LLM/WebSocketExecutor") {}

const transportError = (
  method: string,
  message: string,
  input: { readonly url?: string; readonly kind?: string } = {},
) =>
  new LLMError({
    module: "WebSocketExecutor",
    method,
    reason: new TransportReason({ message, url: input.url, kind: input.kind }),
  })

const eventMessage = (event: Event) => {
  if ("message" in event && typeof event.message === "string") return event.message
  return event.type
}

const binaryMessage = (data: unknown) => {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return undefined
}

const waitOpen = (ws: globalThis.WebSocket, input: WebSocketRequest) => {
  if (ws.readyState === globalThis.WebSocket.OPEN) return Effect.void
  if (ws.readyState === globalThis.WebSocket.CLOSING || ws.readyState === globalThis.WebSocket.CLOSED) {
    return Effect.fail(
      transportError("open", `WebSocket closed before opening (state ${ws.readyState})`, {
        url: input.url,
        kind: "open",
      }),
    )
  }
  return Effect.callback<void, LLMError>((resume, signal) => {
    const cleanup = () => {
      ws.removeEventListener("open", onOpen)
      ws.removeEventListener("error", onError)
      ws.removeEventListener("close", onClose)
      signal.removeEventListener("abort", onAbort)
    }
    const onAbort = () => {
      cleanup()
      if (ws.readyState !== globalThis.WebSocket.CLOSED && ws.readyState !== globalThis.WebSocket.CLOSING)
        ws.close(1000)
      resume(
        Effect.fail(
          transportError("open", "WebSocket open aborted", { url: input.url, kind: "open" }),
        ),
      )
    }
    const onOpen = () => {
      cleanup()
      resume(Effect.void)
    }
    const onError = (event: Event) => {
      cleanup()
      resume(
        Effect.fail(
          transportError("open", `Failed to open WebSocket: ${eventMessage(event)}`, { url: input.url, kind: "open" }),
        ),
      )
    }
    const onClose = (event: CloseEvent) => {
      cleanup()
      resume(
        Effect.fail(
          transportError("open", `WebSocket closed before opening with code ${event.code}`, {
            url: input.url,
            kind: "open",
          }),
        ),
      )
    }
    ws.addEventListener("open", onOpen, { once: true })
    ws.addEventListener("error", onError, { once: true })
    ws.addEventListener("close", onClose, { once: true })
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

const webSocketUrl = (value: string) =>
  Effect.try({
    try: () => {
      const url = new URL(value)
      if (url.protocol === "https:") {
        url.protocol = "wss:"
        return url.toString()
      }
      if (url.protocol === "http:") {
        url.protocol = "ws:"
        return url.toString()
      }
      throw new Error(`Unsupported WebSocket URL protocol ${url.protocol}`)
    },
    catch: (error) =>
      transportError("prepare", error instanceof Error ? error.message : "Invalid WebSocket URL", {
        url: value,
        kind: "websocket",
      }),
  })

export const open = (input: WebSocketRequest) =>
  Effect.try({
    try: () =>
      new (globalThis.WebSocket as unknown as WebSocketConstructorWithHeaders)(input.url, { headers: input.headers }),
    catch: (error) =>
      transportError("open", error instanceof Error ? error.message : "Failed to construct WebSocket", {
        url: input.url,
        kind: "open",
      }),
  }).pipe(Effect.flatMap((ws) => fromWebSocket(ws, input)))

export const layer: Layer.Layer<Service> = Layer.succeed(Service, Service.of({ open }))

export const fromWebSocket = (
  ws: globalThis.WebSocket,
  input: WebSocketRequest,
): Effect.Effect<WebSocketConnection, LLMError> =>
  Effect.gen(function* () {
    yield* waitOpen(ws, input)
    const messages = yield* Queue.bounded<string | Uint8Array, LLMError | Cause.Done<void>>(128)

    const onMessage = (event: MessageEvent) => {
      if (typeof event.data === "string") return Queue.offerUnsafe(messages, event.data)
      const binary = binaryMessage(event.data)
      if (binary) return Queue.offerUnsafe(messages, binary)
      Queue.failCauseUnsafe(
        messages,
        Cause.fail(
          transportError("message", "Unsupported WebSocket message payload", { url: input.url, kind: "message" }),
        ),
      )
    }
    let closed = false
    const onError = (event: Event) => {
      closed = true
      Queue.failCauseUnsafe(
        messages,
        Cause.fail(
          transportError("message", `WebSocket error: ${eventMessage(event)}`, { url: input.url, kind: "message" }),
        ),
      )
    }
    const onClose = (event: CloseEvent) => {
      closed = true
      if (event.code === 1000 || event.code === 1005) return Queue.endUnsafe(messages)
      Queue.failCauseUnsafe(
        messages,
        Cause.fail(
          transportError("message", `WebSocket closed with code ${event.code}`, { url: input.url, kind: "close" }),
        ),
      )
    }
    let pingInterval: ReturnType<typeof setInterval> | undefined
    const cleanup = Effect.sync(() => {
      closed = true
      ws.removeEventListener("message", onMessage)
      ws.removeEventListener("error", onError)
      ws.removeEventListener("close", onClose)
      if (pingInterval !== undefined) clearInterval(pingInterval)
    }).pipe(Effect.andThen(Queue.shutdown(messages)))

    ws.addEventListener("message", onMessage)
    ws.addEventListener("error", onError)
    ws.addEventListener("close", onClose)
    // Keep idle wss alive through proxies that close after ~60s idle.
    if (typeof (ws as unknown as { ping?: () => void }).ping === "function") {
      pingInterval = setInterval(() => {
        try {
          ;(ws as unknown as { ping: () => void }).ping()
        } catch {}
      }, 25_000)
      if (typeof (pingInterval as unknown as { unref?: () => void }).unref === "function") {
        ;(pingInterval as unknown as { unref: () => void }).unref!()
      }
    }

    return {
      sendText: (message) =>
        Effect.try({
          try: () => ws.send(message),
          catch: (error) =>
            transportError("sendText", error instanceof Error ? error.message : "Failed to send WebSocket message", {
              url: input.url,
              kind: "write",
            }),
        }),
      messages: Stream.fromQueue(messages),
      close: cleanup.pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (ws.readyState === globalThis.WebSocket.CLOSED || ws.readyState === globalThis.WebSocket.CLOSING) return
            ws.close(1000)
          }),
        ),
      ),
      isOpen: () => !closed && ws.readyState === globalThis.WebSocket.OPEN,
    }
  })

export const messageText = (message: string | Uint8Array, decoder: TextDecoder) =>
  typeof message === "string" ? message : decoder.decode(message)

export interface JsonPrepared<Message extends Record<string, unknown>> {
  readonly url: string
  readonly headers: Headers.Headers
  readonly message: Message
  readonly encodedMessage: string
  readonly http: HttpTransport.HttpPrepared<string>
}

export interface JsonContinuation<Message extends Record<string, unknown>> {
  readonly session: (request: LLMRequest) =>
    | {
        readonly key: string
        readonly fingerprint: string
        readonly messageBoundary: number
        readonly fullReplay: boolean
      }
    | undefined
  readonly replayMessage: (request: LLMRequest, messageCount: number) => Effect.Effect<Message, LLMError>
  readonly deltaMessage: (request: LLMRequest, messageStart: number) => Effect.Effect<Message, LLMError>
  readonly normalizeOutput: (item: unknown) => unknown | undefined
  readonly fallback: Framing.Definition<string>
}

export interface JsonInput<Body, Message extends Record<string, unknown>> {
  readonly toMessage: (body: Body | Record<string, unknown>) => Effect.Effect<Message, LLMError>
  readonly encodeMessage: (message: Message) => string
  readonly continuation?: JsonContinuation<Message>
}

export type JsonPatch<Body, Message extends Record<string, unknown>> = Partial<JsonInput<Body, Message>>

export interface JsonTransport<Body, Message extends Record<string, unknown>>
  extends Transport<Body, JsonPrepared<Message>, string> {
  readonly with: (patch: JsonPatch<Body, Message>) => JsonTransport<Body, Message>
}

interface JsonSession<Message extends Record<string, unknown>> {
  readonly permit: Semaphore.Semaphore
  fingerprint: string
  fallback: boolean
  active: boolean
  connection?: WebSocketConnection
  previous?: {
    readonly message: Message
    readonly responseID: string
    readonly output: ReadonlyArray<unknown>
    readonly messageBoundary: number
  }
  idleTimer?: ReturnType<typeof setTimeout>
  fallbackTimer?: ReturnType<typeof setTimeout>
}

const SESSION_MAX = 64
const IDLE_TTL_MS = 60_000
const FALLBACK_TTL_MS = 30_000

const decodedJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!ProviderShared.isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .flatMap((key) => (value[key] === undefined ? [] : [[key, canonicalValue(value[key])]])),
  )
}

const canonicalJson = (value: unknown) => ProviderShared.encodeJson(canonicalValue(value))

const messageProperties = (message: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(message).filter(([key]) => key !== "input" && key !== "previous_response_id" && key !== "type"),
  )

const incrementalMessage = <Message extends Record<string, unknown>>(
  request: LLMRequest,
  previous: NonNullable<JsonSession<Message>["previous"]> | undefined,
  continuation: JsonContinuation<Message>,
) =>
  Effect.gen(function* () {
    if (!previous) return undefined
    const representedMessageCount = previous.messageBoundary + 1
    const representedMessage = yield* continuation.replayMessage(request, representedMessageCount)
    if (!Array.isArray(representedMessage.input) || !Array.isArray(previous.message.input)) return undefined
    const representedInput = representedMessage.input
    const previousInput = previous.message.input
    if (
      canonicalJson(messageProperties(previous.message)) !== canonicalJson(messageProperties(representedMessage))
    )
      return undefined
    const represented = [...previousInput, ...previous.output]
    if (representedInput.length !== represented.length) return undefined
    if (!represented.every((item, index) => canonicalJson(item) === canonicalJson(representedInput[index])))
      return undefined
    const delta = yield* continuation.deltaMessage(request, representedMessageCount)
    return { ...delta, previous_response_id: previous.responseID }
  })

const responseErrorText = (event: Record<string, unknown>) => {
  const error = ProviderShared.isRecord(event.error) ? event.error : undefined
  const response = ProviderShared.isRecord(event.response) ? event.response : undefined
  const responseError = response && ProviderShared.isRecord(response.error) ? response.error : undefined
  return [event.message, event.code, error?.message, error?.code, responseError?.message, responseError?.code]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
}

const invalidPreviousResponse = (message: string) =>
  /previous[_ ]response(?:_id)?/i.test(message) && /invalid|expired|not found|unknown|missing/i.test(message)

const fallbackError = (method: string, message: string, url: string) =>
  transportError(method, message, { url, kind: "websocket-fallback" })

const continuationError = (message: string, url: string) =>
  transportError("continuation", message, { url, kind: "websocket-continuation" })

const isContinuationError = (error: LLMError) =>
  error.reason._tag === "Transport" && error.reason.kind === "websocket-continuation"

export const json = <Body, Message extends Record<string, unknown>>(
  input: JsonInput<Body, Message>,
): JsonTransport<Body, Message> => {
  const sessions = new Map<string, JsonSession<Message>>()

  const evict = (key: string) => {
    const existing = sessions.get(key)
    if (!existing) return
    // Never evict while a request holds the permit — that would close the
    // active websocket mid-stream and surface as a spurious interrupt after
    // exactly IDLE_TTL_MS (the 60s failure observed in production).
    if (existing.active) return
    if (existing.idleTimer) clearTimeout(existing.idleTimer)
    if (existing.fallbackTimer) clearTimeout(existing.fallbackTimer)
    if (existing.connection) Effect.runFork(existing.connection.close)
    sessions.delete(key)
  }

  const touch = (key: string, state: JsonSession<Message>) => {
    if (state.active) return
    if (state.idleTimer) clearTimeout(state.idleTimer)
    const timer = setTimeout(() => evict(key), IDLE_TTL_MS)
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      ;(timer as unknown as { unref: () => void }).unref()
    }
    state.idleTimer = timer
  }

  const clearIdle = (state: JsonSession<Message>) => {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer)
      state.idleTimer = undefined
    }
  }

  const resetFallback = (state: JsonSession<Message>) => {
    if (state.fallbackTimer) clearTimeout(state.fallbackTimer)
    if (!state.fallback) return
    const timer = setTimeout(() => {
      state.fallback = false
      if (state.fallbackTimer) {
        clearTimeout(state.fallbackTimer)
        state.fallbackTimer = undefined
      }
    }, FALLBACK_TTL_MS)
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      ;(timer as unknown as { unref: () => void }).unref()
    }
    state.fallbackTimer = timer
  }

  const ensureCapacity = () => {
    if (sessions.size < SESSION_MAX) return
    const oldest = sessions.keys().next().value as string | undefined
    if (oldest !== undefined) evict(oldest)
  }

  const httpFrames = (
    prepared: JsonPrepared<Message>,
    request: LLMRequest,
    runtime: Parameters<JsonTransport<Body, Message>["frames"]>[2],
  ) =>
    Stream.unwrap(
      TransportAttempt.track(
        {
          requestID: request.id ?? "request",
          routeID: request.model.route.id,
          transport: "http-json",
          attempt: 1,
          observer: runtime.observeAttempt,
        },
        runtime.http.execute(prepared.http.request),
      ).pipe(
        Effect.map((response) => {
          const route = `${request.model.provider}/${request.model.route.id}`
          return prepared.http.framing.frame(
            response.stream.pipe(
              Stream.mapError((error) => ProviderShared.streamReadError(route, error)),
            ),
          )
        }),
      ),
    )

  const oneShotFrames = (
    prepared: JsonPrepared<Message>,
    request: LLMRequest,
    runtime: Parameters<JsonTransport<Body, Message>["frames"]>[2],
  ) => {
    const webSocket = runtime.webSocket
    if (!webSocket)
      return Stream.fail(
        transportError("json", "WebSocket JSON transport requires WebSocketExecutor.Service", {
          url: prepared.url,
          kind: "websocket",
        }),
      )
    const decoder = new TextDecoder()
    return Stream.unwrap(
      Effect.gen(function* () {
        const connection = yield* Effect.acquireRelease(
          TransportAttempt.track(
            {
              requestID: request.id ?? "request",
              routeID: request.model.route.id,
              transport: "websocket-json",
              attempt: 1,
              observer: runtime.observeAttempt,
            },
            webSocket.open({ url: prepared.url, headers: prepared.headers }),
          ),
          (connection) => connection.close,
        )
        yield* connection.sendText(prepared.encodedMessage)
        return connection.messages.pipe(Stream.map((message) => messageText(message, decoder)))
      }),
    )
  }

  const sessionFrames = (
    prepared: JsonPrepared<Message>,
    request: LLMRequest,
    runtime: Parameters<JsonTransport<Body, Message>["frames"]>[2],
    metadata: NonNullable<ReturnType<JsonContinuation<Message>["session"]>>,
  ) => {
    const existed = sessions.has(metadata.key)
    const state = sessions.get(metadata.key) ?? {
      permit: Semaphore.makeUnsafe(1),
      fingerprint: metadata.fingerprint,
      fallback: false,
      active: false,
    }
    if (!existed) ensureCapacity()
    sessions.set(metadata.key, state)
    // Idle timer is managed via `active` flag. Do not arm it while the
    // permit will be held — see `touch`/`evict`/`clearIdle` for the 60s
    // mid-stream eviction fix.
    let acquired = false
    return Stream.fromEffect(
      state.permit.take(1).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            acquired = true
            state.active = true
            clearIdle(state)
          }),
        ),
      ),
    ).pipe(
      Stream.flatMap(() =>
        Stream.unwrap(
          Effect.gen(function* () {
            if (state.fingerprint !== metadata.fingerprint) {
              yield* state.connection?.close ?? Effect.void
              if (state.idleTimer) {
                clearTimeout(state.idleTimer)
                state.idleTimer = undefined
              }
              if (state.fallbackTimer) {
                clearTimeout(state.fallbackTimer)
                state.fallbackTimer = undefined
              }
              state.connection = undefined
              state.previous = undefined
              state.fallback = false
              state.fingerprint = metadata.fingerprint
              touch(metadata.key, state)
            }
            if (metadata.fullReplay) state.previous = undefined
            if (state.fallback) return httpFrames(prepared, request, runtime)

            // Only a liveness-reporting connection carried over from an earlier request may be
            // transparently replaced by HTTP mid-request. Connections without `isOpen` keep the
            // older behavior: fail this request and route the next one through HTTP.
            const reused = state.connection?.isOpen !== undefined
            const isStale = reused ? !state.connection!.isOpen?.() : false
            if (isStale) {
              yield* state.connection!.close.pipe(Effect.catch(() => Effect.void))
              state.connection = undefined
            }

            const webSocket = runtime.webSocket ?? { open }
            const connection =
              state.connection ??
              (yield* TransportAttempt.track(
                {
                  requestID: request.id ?? "request",
                  routeID: request.model.route.id,
                  transport: "websocket-json",
                  attempt: 1,
                  observer: runtime.observeAttempt,
                },
                webSocket.open({ url: prepared.url, headers: prepared.headers }),
              ).pipe(
                Effect.mapError((error) => {
                  state.fallback = true
                  resetFallback(state)
                  return fallbackError("open", error.message, prepared.url)
                }),
              ))
            state.connection = connection
            const continuedMessage = metadata.fullReplay
              ? undefined
              : yield* incrementalMessage(request, state.previous, input.continuation!)
            const sent = continuedMessage ?? prepared.message
            const continued = continuedMessage !== undefined
            const replayMessage = yield* input.continuation!.replayMessage(request, metadata.messageBoundary)
            yield* connection.sendText(input.encodeMessage(sent)).pipe(
              Effect.mapError((error) => {
                state.fallback = true
                resetFallback(state)
                return fallbackError("sendText", error.message, prepared.url)
              }),
              Effect.onError(() =>
                Effect.gen(function* () {
                  if (state.connection === connection) {
                    state.connection = undefined
                    if (!state.fallback) {
                      state.fallback = true
                      resetFallback(state)
                    }
                    yield* connection.close.pipe(Effect.catch(() => Effect.void))
                  }
                }),
              ),
            )

            const decoder = new TextDecoder()
            const output: unknown[] = []
            let emitted = false
            let completedResponseID: string | undefined
            let terminal = false
            let rejected = false
            return connection.messages.pipe(
              Stream.map((message) => messageText(message, decoder)),
              Stream.mapEffect((message) =>
                Effect.gen(function* () {
                  const decoded = decodedJson(message)
                  if (decoded._tag === "None" || !ProviderShared.isRecord(decoded.value)) return message
                  const event = decoded.value
                  if (event.type === "response.output_item.done") {
                    const normalized = input.continuation?.normalizeOutput(event.item)
                    if (normalized !== undefined) output.push(normalized)
                  }
                  if (event.type === "response.completed") {
                    terminal = true
                    const response = ProviderShared.isRecord(event.response) ? event.response : undefined
                    completedResponseID = typeof response?.id === "string" && response.id.length > 0 ? response.id : undefined
                  }
                  if (event.type === "response.incomplete" || event.type === "response.failed") terminal = true
                  const error = responseErrorText(event)
                  if (continued && error.length > 0 && invalidPreviousResponse(error)) {
                    rejected = true
                    return yield* continuationError(error, prepared.url)
                  }
                  return message
                }),
              ),
              Stream.tap(() => Effect.sync(() => {
                emitted = true
              })),
              Stream.mapError((error) => {
                state.previous = undefined
                if (isContinuationError(error)) return error
                state.fallback = true
                resetFallback(state)
                return fallbackError("frames", error.message, prepared.url)
              }),
              Stream.onEnd(
                Effect.suspend(() =>
                  terminal
                    ? Effect.void
                    : Effect.fail(fallbackError("frames", "WebSocket closed before a terminal response", prepared.url)),
                ),
              ),
              Stream.ensuring(
                Effect.gen(function* () {
                  state.previous =
                    completedResponseID === undefined
                      ? undefined
                      : {
                          message: replayMessage,
                          responseID: completedResponseID,
                          output,
                          messageBoundary: metadata.messageBoundary,
                        }
                  if (terminal && !rejected) {
                    touch(metadata.key, state)
                    return
                  }
                  state.connection = undefined
                  if (rejected) {
                    state.fallback = true
                    resetFallback(state)
                  }
                  yield* connection.close
                  touch(metadata.key, state)
                }),
              ),
            ).pipe(
              Stream.catch((error) => {
                if (!reused || emitted || isContinuationError(error)) return Stream.fail(error)
                return httpFrames(prepared, request, runtime)
              }),
            )
          }),
        ).pipe(
          Stream.ensuring(
            Effect.gen(function* () {
              if (acquired) {
                acquired = false
                state.active = false
                yield* state.permit.release(1)
                touch(metadata.key, state)
              }
            }),
          ),
        ),
      ),
    )
  }

  return {
    id: "websocket-json",
    with: (patch) => json({ ...input, ...patch }),
    prepare: (prepareInput) =>
      Effect.gen(function* () {
        const parts = yield* HttpTransport.jsonRequestParts({ ...prepareInput })
        const message = yield* input.toMessage(parts.jsonBody)
        return {
          url: yield* webSocketUrl(parts.url),
          headers: parts.headers,
          message,
          encodedMessage: input.encodeMessage(message),
          http: {
            request: ProviderShared.jsonPost({ url: parts.url, body: parts.bodyText, headers: parts.headers }),
            framing: input.continuation?.fallback ?? Framing.sse,
          },
        }
      }),
    frames: (prepared, request, runtime) => {
      const metadata = input.continuation?.session(request)
      return metadata === undefined
        ? oneShotFrames(prepared, request, runtime)
        : sessionFrames(prepared, request, runtime, metadata)
    },
  }
}

export const jsonTransport = {
  id: "websocket-json",
  with: json,
} as const

export const WebSocketExecutor = {
  Service,
  layer,
  open,
  fromWebSocket,
  messageText,
} as const

export const WebSocketTransport = {
  json,
  jsonTransport,
} as const
