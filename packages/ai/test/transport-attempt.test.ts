import { describe, expect } from "bun:test"
import { createServer } from "node:net"
import { Effect, Layer, Stream } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { LLM } from "../src"
import * as OpenAI from "../src/providers/openai"
import * as OpenAIChat from "../src/protocols/openai-chat"
import { ProviderShared } from "../src/protocols/shared"
import { Auth, LLMClient, RequestExecutor, WebSocketExecutor } from "../src/route"
import { testEffect } from "./lib/effect"
import { TransportAttempt } from "../src/route/transport/attempt"
import { deltaChunk, finishChunk, usageChunk } from "./lib/openai-chunks"
import { sseEvents } from "./lib/sse"

const it = testEffect(Layer.empty)

const resetServer = Effect.callback<ReturnType<typeof createServer>, Error>((resume) => {
  const server = createServer((socket) => {
    socket.once("data", () => {
      const event = `data: ${JSON.stringify(deltaChunk({ role: "assistant", content: "partial" }))}\n\n`
      const response = [
        "HTTP/1.1 200 OK",
        "Content-Type: text/event-stream",
        "Transfer-Encoding: chunked",
        "Connection: keep-alive",
        "",
        `${new TextEncoder().encode(event).byteLength.toString(16)}\r\n${event}\r\n`,
      ].join("\r\n")
      socket.write(response)
      setTimeout(() => socket.resetAndDestroy(), 10)
    })
  })
  const onError = (error: Error) => resume(Effect.fail(error))
  server.once("error", onError)
  server.listen(0, "127.0.0.1", () => {
    server.off("error", onError)
    resume(Effect.succeed(server))
  })
})

describe("TransportAttempt", () => {
  it.effect("observes one started and one succeeded event while containing observer failures", () =>
    Effect.gen(function* () {
      const events: TransportAttempt.Info[] = []
      const result = yield* TransportAttempt.track(
        {
          requestID: "req_1",
          routeID: "openai-responses",
          transport: "http-json",
          attempt: 1,
          now: () => 10,
          observer: (event) =>
            Effect.sync(() => {
              events.push(event)
              if (event.phase === "started") throw new Error("observer failure")
            }).pipe(Effect.catch(() => Effect.void)),
        },
        Effect.succeed("ok"),
      )

      expect(result).toBe("ok")
      expect(events.map((event) => event.phase)).toEqual(["started", "succeeded"])
      expect(events.every((event) => event.requestID === "req_1" && event.attempt === 1)).toBe(true)
    }),
  )

  it.effect("wires the configured observer through an HTTP provider request", () =>
    Effect.gen(function* () {
      const events: TransportAttempt.Info[] = []
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1" }, auth: Auth.bearer("test") })
        .model({ id: "gpt-4o-mini" })
      const body = sseEvents(
        deltaChunk({ role: "assistant", content: "hello" }),
        finishChunk("stop"),
        usageChunk({ prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }),
      )
      const executor = Layer.succeed(
        RequestExecutor.Service,
        RequestExecutor.Service.of({
          execute: (request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(body, { headers: { "content-type": "text/event-stream" } }),
              ),
            ),
        }),
      )
      const client = LLMClient.configured({
        observeAttempt: (event) => Effect.sync(() => events.push(event)),
      }).pipe(Layer.provide(executor))

      yield* LLMClient.stream(LLM.request({ id: "req_http", model, prompt: "hello" })).pipe(
        Stream.runDrain,
        Effect.provide(client),
      )

      expect(events.map((event) => event.phase)).toEqual(["started", "succeeded"])
      expect(events[0]).toMatchObject({
        requestID: "req_http",
        routeID: "openai-chat",
        transport: "http-json",
        attempt: 1,
      })
      expect(events.at(-1)).toMatchObject({ phase: "succeeded", stage: "stream", status: 200 })
    }),
  )

  it.live("observes a real HTTP 200 body reset as a stream-stage failure", () =>
    Effect.gen(function* () {
      const events: TransportAttempt.Info[] = []
      const server = yield* Effect.acquireRelease(
        resetServer,
        (server) =>
          Effect.callback<void>((resume) => {
            server.close(() => resume(Effect.void))
          }),
      )
      const address = server.address()
      if (!address || typeof address === "string") return yield* Effect.die(new Error("Expected TCP server address"))
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: `http://127.0.0.1:${address.port}/v1` }, auth: Auth.bearer("test") })
        .model({ id: "gpt-4o-mini" })
      const client = LLMClient.configured({
        observeAttempt: (event) => Effect.sync(() => events.push(event)),
      }).pipe(Layer.provide(RequestExecutor.fetchLayer))

      const error = yield* LLMClient.generate(LLM.request({ id: "req_socket_reset", model, prompt: "hello" })).pipe(
        Effect.provide(client),
        Effect.flip,
      )

      expect(error.reason).toMatchObject({ _tag: "Transport", kind: "read" })
      expect(events.map((event) => event.phase)).toEqual(["started", "failed"])
      expect(events.at(-1)).toMatchObject({
        phase: "failed",
        stage: "stream",
        status: 200,
        failure: "response-read",
      })
      expect(events.at(-1)?.error).toBeUndefined()
    }),
  )

  it.effect("wires the configured observer through a WebSocket provider request", () =>
    Effect.gen(function* () {
      const events: TransportAttempt.Info[] = []
      const deps = Layer.mergeAll(
        Layer.succeed(
          RequestExecutor.Service,
          RequestExecutor.Service.of({ execute: () => Effect.die("unexpected HTTP request") }),
        ),
        Layer.succeed(
          WebSocketExecutor.Service,
          WebSocketExecutor.Service.of({
            open: () =>
              Effect.succeed({
                sendText: () => Effect.void,
                messages: Stream.fromArray([
                  ProviderShared.encodeJson({ type: "response.output_text.delta", item_id: "msg_1", delta: "Hi" }),
                  ProviderShared.encodeJson({ type: "response.completed", response: { id: "resp_ws" } }),
                ]),
                close: Effect.void,
              }),
          }),
        ),
      )
      const client = LLMClient.configured({
        observeAttempt: (event) => Effect.sync(() => events.push(event)),
      }).pipe(Layer.provide(deps))
      const model = OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responsesWebSocket(
        "gpt-4.1-mini",
      )

      const response = yield* LLMClient.generate(LLM.request({ id: "req_ws", model, prompt: "hello" })).pipe(
        Effect.provide(client),
      )

      expect(response.text).toBe("Hi")
      expect(events.map((event) => event.phase)).toEqual(["started", "succeeded"])
      expect(events[0]).toMatchObject({
        requestID: "req_ws",
        routeID: "openai-responses-websocket",
        transport: "websocket-json",
        attempt: 1,
      })
    }),
  )

  it.effect("observes a failed terminal event and preserves the original failure", () =>
    Effect.gen(function* () {
      const events: TransportAttempt.Info[] = []
      const exit = yield* Effect.exit(
        TransportAttempt.track(
          {
            requestID: "req_2",
            routeID: "anthropic-messages",
            transport: "websocket-json",
            attempt: 2,
            now: () => 20,
            observer: (event) => Effect.sync(() => events.push(event)),
          },
          Effect.fail(new Error("provider failed")),
        ),
      )

      expect(exit._tag).toBe("Failure")
      expect(events.map((event) => event.phase)).toEqual(["started", "failed"])
      expect(events.at(-1)).toMatchObject({ phase: "failed", failure: "request" })
      expect(events.at(-1)?.error).toBeUndefined()
    }),
  )
})
