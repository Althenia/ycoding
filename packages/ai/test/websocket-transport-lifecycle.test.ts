import { describe, expect } from "bun:test"
import { Effect, Layer, Queue, Stream } from "effect"
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
