import { describe, expect } from "bun:test"
import { Cause, Effect, Layer, Queue, Stream } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { LLM, LLMError, Message, TransportReason } from "../src"
import { ProviderShared } from "../src/protocols/shared"
import * as OpenAIResponses from "../src/protocols/openai-responses"
import { Auth, LLMClient, RequestExecutor, WebSocketExecutor } from "../src/route"
import { testEffect } from "./lib/effect"
import { sseEvents } from "./lib/sse"

const it = testEffect(Layer.empty)

const model = OpenAIResponses.webSocketRoute
  .with({
    id: "openai-codex-websocket-responses",
    endpoint: { baseURL: "https://chatgpt.test/backend-api/codex" },
    auth: Auth.bearer("test"),
  })
  .model({ id: "gpt-5.6" })

const metadata = (sessionKey: string, messageBoundary: number, fingerprint = "fingerprint", fullReplay = false) => ({
  openai: {
    store: false,
    promptCacheKey: `cache-${sessionKey}`,
    responsesWebSocket: { sessionKey, fingerprint, messageBoundary, fullReplay },
  },
})

const liveState = (value: string) => Message.make({ role: "system", content: value, volatile: true })

const completed = (responseID: string, itemID: string, text: string) => [
  ProviderShared.encodeJson({
    type: "response.output_item.added",
    item: { type: "message", id: itemID, status: "in_progress", role: "assistant", phase: "commentary" },
  }),
  ProviderShared.encodeJson({ type: "response.output_text.delta", item_id: itemID, delta: text }),
  ProviderShared.encodeJson({
    type: "response.output_item.done",
    item: {
      type: "message",
      id: itemID,
      status: "completed",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
    },
  }),
  ProviderShared.encodeJson({ type: "response.completed", response: { id: responseID } }),
]

describe("Codex Responses WebSocket transport", () => {
  it.effect("reuses one session socket and sends a semantic strict-extension delta", () =>
    Effect.gen(function* () {
      const sent: Array<Record<string, unknown>> = []
      const opened: string[] = []
      const responses = [completed("resp_1", "msg_1", "First answer"), completed("resp_2", "msg_2", "Second answer")]
      const socket = yield* Queue.unbounded<string, LLMError>()
      const deps = Layer.mergeAll(
        Layer.succeed(
          RequestExecutor.Service,
          RequestExecutor.Service.of({ execute: () => Effect.die("unexpected HTTP request") }),
        ),
        Layer.succeed(
          WebSocketExecutor.Service,
          WebSocketExecutor.Service.of({
            open: (input) =>
              Effect.sync(() => opened.push(input.headers["session-id"] ?? "opened")).pipe(
                Effect.as({
                  sendText: (message: string) =>
                    Effect.gen(function* () {
                      sent.push(ProviderShared.decodeJson(message) as Record<string, unknown>)
                      yield* Queue.offerAll(socket, responses[sent.length - 1] ?? [])
                    }),
                  messages: Stream.fromQueue(socket),
                  close: Effect.void,
                }),
              ),
          }),
        ),
      )
      const client = LLMClient.layer.pipe(Layer.provide(deps))
      const first = yield* LLMClient.generate(
        LLM.request({
          model,
          messages: [Message.user("First question"), liveState("state one")],
          providerOptions: metadata("reuse-session", 1),
        }),
      ).pipe(Effect.provide(client))
      yield* LLMClient.generate(
        LLM.request({
          model,
          messages: [
            Message.user("First question"),
            first.message,
            Message.user("Second question"),
            liveState("state two"),
          ],
          providerOptions: metadata("reuse-session", 3),
        }),
      ).pipe(Effect.provide(client))

      expect(opened).toHaveLength(1)
      expect(sent[0]).toMatchObject({ type: "response.create", store: false })
      expect(sent[0]).not.toHaveProperty("previous_response_id")
      expect(sent[1]).toMatchObject({ type: "response.create", store: false, previous_response_id: "resp_1" })
      expect(sent[1]?.input).toEqual([
        { role: "user", content: [{ type: "input_text", text: "Second question" }] },
        {
          role: "system",
          content: [{ type: "input_text", text: "state two" }],
        },
      ])
    }),
  )

  it.effect("full-replays on property, prefix, fingerprint, and Session mismatches", () =>
    Effect.gen(function* () {
      const sent: Array<Record<string, unknown>> = []
      let opens = 0
      const responses = Array.from({ length: 5 }, (_, index) => completed(`resp_${index}`, `msg_${index}`, `answer-${index}`))
      const deps = Layer.mergeAll(
        Layer.succeed(
          RequestExecutor.Service,
          RequestExecutor.Service.of({ execute: () => Effect.die("unexpected HTTP request") }),
        ),
        Layer.succeed(
          WebSocketExecutor.Service,
          WebSocketExecutor.Service.of({
            open: () =>
              Effect.gen(function* () {
                opens += 1
                const socket = yield* Queue.unbounded<string, LLMError>()
                return {
                  sendText: (message: string) =>
                    Effect.gen(function* () {
                      sent.push(ProviderShared.decodeJson(message) as Record<string, unknown>)
                      yield* Queue.offerAll(socket, responses[sent.length - 1] ?? [])
                    }),
                  messages: Stream.fromQueue(socket),
                  close: Effect.void,
                }
              }),
          }),
        ),
      )
      const client = LLMClient.layer.pipe(Layer.provide(deps))
      const run = (messages: ReadonlyArray<Message>, sessionKey: string, fingerprint = "fingerprint", temperature?: number) =>
        LLMClient.generate(
          LLM.request({
            model,
            messages,
            providerOptions: metadata(sessionKey, messages.filter((message) => message.volatile !== true).length, fingerprint),
            generation: temperature === undefined ? undefined : { temperature },
          }),
        ).pipe(Effect.provide(client))

      const first = yield* run([Message.user("one")], "mismatch-session-a")
      yield* run(
        [Message.user("one"), first.message, Message.user("two")],
        "mismatch-session-a",
        "fingerprint",
        0.2,
      )
      yield* run([Message.user("changed prefix"), Message.user("three")], "mismatch-session-a")
      yield* run([Message.user("four")], "mismatch-session-a", "changed-fingerprint")
      yield* run([Message.user("five")], "mismatch-session-b", "changed-fingerprint")

      expect(sent.slice(1).every((message) => !("previous_response_id" in message))).toBe(true)
      expect(opens).toBe(3)
    }),
  )

  it.effect("surfaces websocket failure as hard transport error without HTTP fallback", () =>
    Effect.gen(function* () {
      const sent: Array<Record<string, unknown>> = []
      const httpBodies: Array<Record<string, unknown>> = []
      const socket = yield* Queue.unbounded<string, LLMError>()
      const deps = Layer.mergeAll(
        Layer.succeed(
          RequestExecutor.Service,
          RequestExecutor.Service.of({
            execute: (request) =>
              Effect.gen(function* () {
                const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
                httpBodies.push((yield* Effect.promise(() => web.json())) as Record<string, unknown>)
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(sseEvents(
                    { type: "response.output_text.delta", item_id: "msg_http", delta: "Recovered" },
                    { type: "response.completed", response: { id: "resp_http" } },
                  ), { headers: { "content-type": "text/event-stream" } }),
                )
              }),
          }),
        ),
        Layer.succeed(
          WebSocketExecutor.Service,
          WebSocketExecutor.Service.of({
            open: () =>
              Effect.succeed({
                sendText: (message) =>
                  Effect.gen(function* () {
                    sent.push(ProviderShared.decodeJson(message) as Record<string, unknown>)
                    if (sent.length === 1) yield* Queue.offerAll(socket, completed("resp_1", "msg_1", "answer"))
                    if (sent.length === 2)
                      Queue.failCauseUnsafe(
                        socket,
                        Cause.fail(new LLMError({
                          module: "fixture",
                          method: "read",
                          reason: new TransportReason({ message: "socket closed", kind: "close" }),
                        })),
                      )
                  }),
                messages: Stream.fromQueue(socket),
                close: Effect.void,
              }),
          }),
        ),
      )
      const client = LLMClient.layer.pipe(Layer.provide(deps))
      const first = yield* LLMClient.generate(
        LLM.request({ model, messages: [Message.user("one")], providerOptions: metadata("fallback-session", 1) }),
      ).pipe(Effect.provide(client))
      const messages = [Message.user("one"), first.message, Message.user("two")]
      const failure = yield* LLMClient.generate(
        LLM.request({ model, messages, providerOptions: metadata("fallback-session", 3) }),
      ).pipe(Effect.provide(client), Effect.flip)
      expect(failure.reason._tag).toBe("Transport")
      expect(sent[1]).toHaveProperty("previous_response_id", "resp_1")
      expect(httpBodies).toHaveLength(0)
    }),
  )

  it.effect("preserves a rejected continuation for an exact WebSocket retry", () =>
    Effect.gen(function* () {
      const sent: Array<Record<string, unknown>> = []
      let opens = 0
      const deps = Layer.mergeAll(
        Layer.succeed(
          RequestExecutor.Service,
          RequestExecutor.Service.of({ execute: () => Effect.die("unexpected HTTP request") }),
        ),
        Layer.succeed(
          WebSocketExecutor.Service,
          WebSocketExecutor.Service.of({
            open: () =>
              Effect.gen(function* () {
                opens += 1
                const socket = yield* Queue.unbounded<string, LLMError>()
                return {
                  sendText: (message: string) =>
                    Effect.gen(function* () {
                      sent.push(ProviderShared.decodeJson(message) as Record<string, unknown>)
                      if (sent.length === 1) yield* Queue.offerAll(socket, completed("resp_1", "msg_1", "answer"))
                      if (sent.length === 2)
                        yield* Queue.offer(
                          socket,
                          ProviderShared.encodeJson({
                            type: "error",
                            error: {
                              code: "invalid_previous_response_id",
                              message: "Invalid previous_response_id",
                            },
                          }),
                        )
                      if (sent.length === 3)
                        yield* Queue.offerAll(socket, completed("resp_3", "msg_3", "recovered"))
                    }),
                  messages: Stream.fromQueue(socket),
                  close: Effect.void,
                }
              }),
          }),
        ),
      )
      const client = LLMClient.layer.pipe(Layer.provide(deps))
      const first = yield* LLMClient.generate(
        LLM.request({ model, messages: [Message.user("one")], providerOptions: metadata("retry-session", 1) }),
      ).pipe(Effect.provide(client))
      const messages = [Message.user("one"), first.message, Message.user("two")]
      const request = LLM.request({ model, messages, providerOptions: metadata("retry-session", 3) })

      yield* LLMClient.generate(request).pipe(Effect.provide(client), Effect.flip)
      yield* LLMClient.generate(request).pipe(Effect.provide(client))

      expect(sent[1]).toHaveProperty("previous_response_id", "resp_1")
      expect(sent[2]).toHaveProperty("previous_response_id", "resp_1")
      expect(sent[2]?.input).toEqual(sent[1]?.input)
      expect(opens).toBe(2)
    }),
  )
})
