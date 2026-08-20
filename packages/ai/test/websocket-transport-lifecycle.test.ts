import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Queue, Stream } from "effect"
import { Headers } from "effect/unstable/http"
import { LLM, LLMError, Message } from "../src"
import { ProviderShared } from "../src/protocols/shared"
import * as OpenAIResponses from "../src/protocols/openai-responses"
import { Auth, LLMClient, RequestExecutor, WebSocketExecutor } from "../src/route"
import type { Interface, WebSocketConnection } from "../src/route/transport/websocket"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const model = OpenAIResponses.webSocketRoute
  .with({
    id: "lifecycle-test",
    endpoint: { baseURL: "https://chatgpt.test/backend-api/codex" },
    auth: Auth.bearer("test"),
  })
  .model({ id: "gpt-5.6" })

const metadata = (sessionKey: string) => ({
  openai: {
    store: false,
    promptCacheKey: `cache-${sessionKey}`,
    responsesWebSocket: { sessionKey, fingerprint: "fingerprint", messageBoundary: 1, fullReplay: false },
  },
})

const response = (id: string) =>
  ProviderShared.encodeJson({
    type: "response.completed",
    response: { id },
  })

const connection = (closed: { value: boolean }, messages: Queue.Queue<string, LLMError>): WebSocketConnection => ({
  sendText: () => Queue.offer(messages, response("response")),
  messages: Stream.fromQueue(messages),
  close: Effect.sync(() => {
    closed.value = true
  }),
  isOpen: () => !closed.value,
})

const clientWith = (open: Interface["open"]) =>
  LLMClient.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RequestExecutor.Service, RequestExecutor.Service.of({ execute: () => Effect.die("unexpected HTTP request") })),
        Layer.succeed(WebSocketExecutor.Service, WebSocketExecutor.Service.of({ open })),
      ),
    ),
  )

describe("WebSocket JSON transport lifecycle", () => {
  it.effect("closes a WebSocket that errors while opening", () =>
    Effect.gen(function* () {
      let readyState = globalThis.WebSocket.CONNECTING
      const closeCodes: number[] = []
      const socket = new EventTarget()
      Object.defineProperties(socket, {
        readyState: { get: () => readyState },
        close: {
          value: (code: number) => {
            closeCodes.push(code)
            readyState = globalThis.WebSocket.CLOSING
          },
        },
      })
      const opening = yield* WebSocketExecutor.fromWebSocket(
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- waitOpen uses only the WebSocket members defined above.
        socket as globalThis.WebSocket,
        { url: "wss://api.openai.test/v1/responses", headers: Headers.empty },
      ).pipe(Effect.exit, Effect.forkChild)
      yield* Effect.yieldNow

      socket.dispatchEvent(new Event("error"))
      const exit = yield* Fiber.join(opening)

      expect(exit._tag).toBe("Failure")
      expect(closeCodes).toEqual([1000])
    }),
  )

  it.effect("classifies abnormal WebSocket close 1006 as a transport failure", () =>
    Effect.gen(function* () {
      const socket = new EventTarget()
      Object.defineProperties(socket, {
        readyState: { value: globalThis.WebSocket.OPEN },
        send: { value: () => undefined },
        close: { value: () => undefined },
      })
      const live = yield* WebSocketExecutor.fromWebSocket(
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the lifecycle adapter uses only the WebSocket members defined above.
        socket as globalThis.WebSocket,
        { url: "wss://api.openai.test/v1/responses", headers: Headers.empty },
      )
      const close = new Event("close")
      Object.defineProperty(close, "code", { value: 1006 })
      socket.dispatchEvent(close)

      const error = yield* live.messages.pipe(Stream.runDrain, Effect.flip)

      expect(error).toMatchObject({
        method: "message",
        reason: { _tag: "Transport", kind: "close", message: "WebSocket closed with code 1006" },
      })
    }),
  )

  it.effect("surfaces close 1006 through frames and uses HTTP on the following physical request", () =>
    Effect.gen(function* () {
      let websocketRequests = 0
      let httpRequests = 0
      let closed = false
      const client = LLMClient.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(
              RequestExecutor.Service,
              RequestExecutor.Service.of({
                execute: () => {
                  httpRequests += 1
                  return Effect.succeed({
                    stream: Stream.make(
                      new TextEncoder().encode(`data: ${response("http-fallback-response")}\n\n`),
                    ),
                  })
                },
              }),
            ),
            Layer.succeed(
              WebSocketExecutor.Service,
              WebSocketExecutor.Service.of({
                open: (input) =>
                  Effect.gen(function* () {
                    websocketRequests += 1
                    const socket = new EventTarget()
                    Object.defineProperties(socket, {
                      readyState: { value: globalThis.WebSocket.OPEN },
                      send: { value: () => undefined },
                      close: {
                        value: () => {
                          closed = true
                        },
                      },
                    })
                    const live = yield* WebSocketExecutor.fromWebSocket(
                      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the lifecycle adapter uses only the WebSocket members defined above.
                      socket as globalThis.WebSocket,
                      input,
                    )
                    const close = new Event("close")
                    Object.defineProperty(close, "code", { value: 1006 })
                    socket.dispatchEvent(close)
                    return live
                  }),
              }),
            ),
          ),
        ),
      )
      const request = LLM.request({
        model,
        messages: [Message.user("fallback")],
        providerOptions: metadata("1006-fallback"),
      })

      const error = yield* LLMClient.generate(request).pipe(Effect.provide(client), Effect.flip)

      expect(error).toBeInstanceOf(LLMError)
      if (!(error instanceof LLMError)) return
      expect(error.method).toBe("frames")
      expect(error.reason._tag).toBe("Transport")
      if (error.reason._tag !== "Transport") return
      expect(error.reason.kind).toBe("websocket-fallback")
      expect(error.reason.message).toContain("WebSocket closed with code 1006")
      yield* LLMClient.generate(request).pipe(Effect.provide(client))
      expect(websocketRequests).toBe(1)
      expect(httpRequests).toBe(1)
      expect(closed).toBe(true)
    }),
  )

  it.effect("closes a retained connection when idle eviction runs", () =>
    Effect.gen(function* () {
      const closed = { value: false }
      const timers: Array<() => void> = []
      const originalSetTimeout = setTimeout
      Object.defineProperty(globalThis, "setTimeout", {
        configurable: true,
        value: (callback: () => void) => {
          timers.push(callback)
          return 1
        },
      })
      const client = clientWith(() =>
        Effect.gen(function* () {
          const messages = yield* Queue.unbounded<string, LLMError>()
          return connection(closed, messages)
        }),
      )
      yield* LLMClient.generate(
        LLM.request({ model, messages: [Message.user("idle")], providerOptions: metadata("idle") }),
      ).pipe(Effect.provide(client))
      timers[0]!()
      expect(closed.value).toBe(true)
      Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: originalSetTimeout })
    }),
  )

  it.effect("closes the oldest retained connection on capacity eviction", () =>
    Effect.gen(function* () {
      const closed: Array<{ value: boolean }> = []
      const client = clientWith(() =>
        Effect.gen(function* () {
          const state = { value: false }
          closed.push(state)
          return connection(state, yield* Queue.unbounded<string, LLMError>())
        }),
      )
      for (let index = 0; index < 65; index += 1)
        yield* LLMClient.generate(
          LLM.request({ model, messages: [Message.user(`capacity-${index}`)], providerOptions: metadata(`capacity-${index}`) }),
        ).pipe(Effect.provide(client))
      expect(closed[0]?.value).toBe(true)
    }),
  )

  it.effect("evicts the oldest inactive session when the oldest session is active", () =>
    Effect.gen(function* () {
      const closed: Array<{ value: boolean }> = []
      const activeMessages = yield* Queue.unbounded<string, LLMError>()
      const activeStarted = yield* Deferred.make<void>()
      const client = clientWith(() =>
        Effect.gen(function* () {
          const state = { value: false }
          closed.push(state)
          if (closed.length === 1)
            return {
              ...connection(state, activeMessages),
              sendText: () => Deferred.succeed(activeStarted, undefined),
            }
          return connection(state, yield* Queue.unbounded<string, LLMError>())
        }),
      )
      const active = yield* LLMClient.generate(
        LLM.request({ model, messages: [Message.user("active-oldest")], providerOptions: metadata("active-oldest") }),
      ).pipe(Effect.provide(client), Effect.forkChild)
      yield* Deferred.await(activeStarted)

      for (let index = 1; index <= 64; index += 1)
        yield* LLMClient.generate(
          LLM.request({
            model,
            messages: [Message.user(`inactive-${index}`)],
            providerOptions: metadata(`active-oldest-${index}`),
          }),
        ).pipe(Effect.provide(client))

      const activeClosed = closed[0]?.value
      const oldestInactiveClosed = closed[1]?.value
      yield* Queue.offer(activeMessages, response("active-oldest-response"))
      yield* Fiber.join(active)

      expect(activeClosed).toBe(false)
      expect(oldestInactiveClosed).toBe(true)
    }),
  )

  it.effect("trims temporary session overflow after an active request settles", () =>
    Effect.gen(function* () {
      const closed: Array<{ value: boolean }> = []
      const messages: Array<Queue.Queue<string, LLMError>> = []
      const client = clientWith(() =>
        Effect.gen(function* () {
          const state = { value: false }
          const queue = yield* Queue.unbounded<string, LLMError>()
          closed.push(state)
          messages.push(queue)
          return { ...connection(state, queue), sendText: () => Effect.void }
        }),
      )
      const settled = yield* Deferred.make<void>()
      const all = yield* Effect.forEach(
        Array.from({ length: 65 }, (_, index) => index),
        (index) => {
          const request = LLMClient.generate(
            LLM.request({
              model,
              messages: [Message.user(`active-${index}`)],
              providerOptions: metadata(`all-active-${index}`),
            }),
          ).pipe(Effect.provide(client))
          return index === 64 ? request.pipe(Effect.tap(() => Deferred.succeed(settled, undefined))) : request
        },
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild)
      while (messages.length < 65) yield* Effect.yieldNow

      yield* Queue.offer(messages[64]!, response("settled-overflow"))
      yield* Deferred.await(settled)
      const settledClosed = closed[64]?.value
      yield* Effect.forEach(messages.slice(0, 64), (queue, index) =>
        Queue.offer(queue, response(`active-${index}-response`)),
      )
      yield* Fiber.join(all)

      expect(settledClosed).toBe(true)
    }),
  )

  it.effect("discards a stale retained connection before sending", () =>
    Effect.gen(function* () {
      const opened: Array<{ value: boolean }> = []
      const client = clientWith(() =>
        Effect.gen(function* () {
          const state = { value: false }
          opened.push(state)
          return connection(state, yield* Queue.unbounded<string, LLMError>())
        }),
      )
      const request = (key: string) =>
        LLM.request({ model, messages: [Message.user("stale")], providerOptions: metadata(key) })
      yield* LLMClient.generate(request("stale")).pipe(Effect.provide(client))
      opened[0]!.value = true
      yield* LLMClient.generate(request("stale")).pipe(Effect.provide(client))
      expect(opened).toHaveLength(2)
    }),
  )
})
