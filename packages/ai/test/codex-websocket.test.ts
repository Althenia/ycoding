import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Queue, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import * as TestClock from "effect/testing/TestClock"
import { LLM, LLMError, Message, TransportReason } from "../src"
import { ProviderShared } from "../src/protocols/shared"
import * as OpenAIResponses from "../src/protocols/openai-responses"
import { Auth, LLMClient, RequestExecutor, WebSocketExecutor } from "../src/route"
import { testEffect } from "./lib/effect"
import { sseEvents } from "./lib/sse"

const it = testEffect(Layer.empty)

const model = OpenAIResponses.webSocketRoute
  .with({
    id: "openai-codex-responses",
    endpoint: { baseURL: "https://chatgpt.test/backend-api/codex" },
    auth: Auth.bearer("test"),
  })
  .model({ id: "gpt-5.6" })

const httpModel = OpenAIResponses.route
  .with({
    id: "openai-codex-responses",
    endpoint: { baseURL: "https://chatgpt.test/backend-api/codex" },
    auth: Auth.bearer("test"),
  })
  .model({ id: "gpt-5.6" })

const metadata = (
  sessionKey: string,
  messageBoundary: number,
  fingerprint = "fingerprint",
  fullReplay = false,
  forceHttp = false,
) => ({
  openai: {
    store: false,
    promptCacheKey: `cache-${sessionKey}`,
    responsesWebSocket: { sessionKey, fingerprint, messageBoundary, fullReplay, forceHttp },
  },
})

const liveState = (value: string) => Message.make({ role: "system", content: value, volatile: true })

const expectTimedFailure = (fiber: Fiber.RuntimeFiber<unknown, LLMError>) =>
  Effect.gen(function* () {
    yield* Effect.yieldNow
    yield* TestClock.adjust("120 seconds")
    yield* Effect.yieldNow
    const result = fiber.pollUnsafe()
    expect(result).toBeDefined()
    if (result === undefined) return
    return yield* Fiber.await(fiber)
  })

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
  it.effect("bounds a unary Codex compaction request", () =>
    Effect.gen(function* () {
      const deps = Layer.succeed(
        RequestExecutor.Service,
        RequestExecutor.Service.of({ execute: () => Effect.never }),
      )
      const fiber = yield* OpenAIResponses.compact(
        LLM.request({
          model: httpModel,
          prompt: "Compact this context",
          providerOptions: { openai: { ...metadata("compact-timeout", 0).openai, responsesLite: true } },
        }),
        "YCoding compaction instructions",
      ).pipe(Effect.provide(deps), Effect.forkScoped)

      yield* Effect.yieldNow
      yield* TestClock.adjust("8 minutes")
      yield* Effect.yieldNow
      const result = fiber.pollUnsafe()
      expect(result).toBeDefined()
      if (result === undefined || Exit.isSuccess(result)) return
      expect(Cause.prettyErrors(result.cause)[0]).toMatchObject({
        reason: { _tag: "Transport", kind: "codex-compact-timeout" },
      })
    }),
  )

  for (const [transport, compactModel] of [
    ["WebSocket", model],
    ["HTTP", httpModel],
  ] as const)
    it.effect(`uses the unary compact endpoint for ${transport} Codex sessions`, () =>
    Effect.gen(function* () {
      const requested: HttpClientRequest.HttpClientRequest[] = []
      const output = [
        {
          type: "message",
          id: "msg_compacted",
          status: "completed",
          role: "user",
          content: [{ type: "input_text", text: "Compact this context" }],
        },
        { type: "compaction", encrypted_content: "opaque-compaction" },
      ]
      const deps = Layer.succeed(
        RequestExecutor.Service,
        RequestExecutor.Service.of({
          execute: (request) =>
            Effect.sync(() => requested.push(request)).pipe(
              Effect.as(HttpClientResponse.fromWeb(request, Response.json({ output }))),
            ),
        }),
      )
      const request = LLM.request({
        model: compactModel,
        system: "Session instructions",
        prompt: "Compact this context",
        providerOptions: { openai: { ...metadata("compact", 0).openai, responsesLite: true } },
        metadata: { openaiCodexTurnState: { value: "turn-state" } },
      })

      expect(
        yield* OpenAIResponses.compact(request, "YCoding compaction instructions").pipe(Effect.provide(deps)),
      ).toEqual(output)
      expect(requested).toHaveLength(1)
      const compactRequest = requested[0]
      if (!compactRequest) return yield* Effect.die("Compaction request was not recorded")
      expect(compactRequest.url).toBe("https://chatgpt.test/backend-api/codex/responses/compact")
      expect(compactRequest.headers["x-codex-turn-state"]).toBe("turn-state")
      const compactBody = JSON.parse(new TextDecoder().decode((compactRequest.body as { body: Uint8Array }).body))
      expect(compactBody).toMatchObject({
        model: "gpt-5.6",
        instructions: "YCoding compaction instructions",
        input: expect.any(Array),
        parallel_tool_calls: false,
      })
      expect(JSON.stringify(compactBody)).not.toContain('"type":"additional_tools"')
      expect(compactBody).not.toHaveProperty("stream")
      expect(compactBody).not.toHaveProperty("store")
      expect(compactBody).not.toHaveProperty("max_output_tokens")
      expect(compactBody).not.toHaveProperty("tool_choice")
      const following = yield* OpenAIResponses.protocol.body.from(
        LLM.request({
          model: compactModel,
          prompt: "Continue from compacted context",
          providerOptions: {
            openai: { ...metadata("compact", 0).openai, responsesLite: true, compactionOutput: output },
          },
        }),
      )
      expect(following.input).toEqual([
        { type: "additional_tools", role: "developer", tools: [] },
        ...output,
      ])
    }),
    )

  it.effect("forces one canonical HTTP request without opening a WebSocket", () =>
    Effect.gen(function* () {
      const opened: string[] = []
      const requested: HttpClientRequest.HttpClientRequest[] = []
      const deps = Layer.mergeAll(
        Layer.succeed(
          RequestExecutor.Service,
          RequestExecutor.Service.of({
            execute: (request) =>
              Effect.sync(() => requested.push(request)).pipe(
                Effect.as(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response(sseEvents(...completed("resp_http", "msg_http", "Recovered over HTTP")), {
                      headers: { "content-type": "text/event-stream" },
                    }),
                  ),
                ),
              ),
          }),
        ),
        Layer.succeed(
          WebSocketExecutor.Service,
          WebSocketExecutor.Service.of({
            open: (input) => Effect.sync(() => opened.push(input.url)).pipe(Effect.andThen(Effect.die("unexpected"))),
          }),
        ),
      )

      const result = yield* LLMClient.generate(
        LLM.request({
          model,
          messages: [Message.user("Recover through HTTP")],
          providerOptions: metadata("forced-http", 1, "rotated", true, true),
        }),
      ).pipe(Effect.provide(LLMClient.layer.pipe(Layer.provide(deps))))

      expect(result.message).toMatchObject({ role: "assistant" })
      expect(requested).toHaveLength(1)
      expect(opened).toEqual([])
    }),
  )

  it.effect("reuses one session socket and sends a semantic strict-extension delta", () =>
    Effect.gen(function* () {
      const sent: Array<Record<string, unknown>> = []
      const opened: string[] = []
      const firstTransportState: Record<string, unknown> = {}
      const secondTransportState: Record<string, unknown> = {}
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
          metadata: { openaiCodexTransportState: firstTransportState },
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
          metadata: { openaiCodexTransportState: secondTransportState },
        }),
      ).pipe(Effect.provide(client))

      expect(opened).toHaveLength(1)
      expect(sent[0]).toMatchObject({ type: "response.create", store: false })
      expect(sent[0]).not.toHaveProperty("previous_response_id")
      expect(sent[1]).toMatchObject({ type: "response.create", store: false, previous_response_id: "resp_1" })
      expect(sent[1]?.input).toEqual([
        { role: "user", content: [{ type: "input_text", text: "Second question" }] },
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "<system-update>\nstate two\n</system-update>" }],
        },
      ])
      expect(firstTransportState).toEqual({ continuation: "full" })
      expect(secondTransportState).toEqual({ continuation: "continued" })
    }),
  )

  it.effect("bounds retained session sockets across 128 distinct sessions", () =>
    Effect.gen(function* () {
      let opens = 0
      let closes = 0
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
                const socketID = opens++
                const socket = yield* Queue.unbounded<string, LLMError>()
                return {
                  sendText: () =>
                    Queue.offerAll(socket, completed(`resp_${socketID}`, `msg_${socketID}`, `answer-${socketID}`)),
                  messages: Stream.fromQueue(socket),
                  close: Effect.sync(() => {
                    closes += 1
                  }),
                }
              }),
          }),
        ),
      )
      const client = LLMClient.layer.pipe(Layer.provide(deps))

      yield* Effect.forEach(
        Array.from({ length: 128 }, (_, index) => index),
        (index) =>
          LLMClient.generate(
            LLM.request({
              model,
              prompt: `session-${index}`,
              providerOptions: metadata(`bounded-session-${index}`, 1),
            }),
          ).pipe(Effect.provide(client)),
        { concurrency: 1, discard: true },
      )

      expect(opens).toBe(128)
      expect(closes).toBe(96)
    }),
  )

  it.effect("evicts an idle session socket after the retention TTL", () =>
    Effect.gen(function* () {
      let opens = 0
      let closes = 0
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
                const socketID = opens++
                const socket = yield* Queue.unbounded<string, LLMError>()
                return {
                  sendText: () =>
                    Queue.offerAll(socket, completed(`ttl_resp_${socketID}`, `ttl_msg_${socketID}`, "answer")),
                  messages: Stream.fromQueue(socket),
                  close: Effect.sync(() => {
                    closes += 1
                  }),
                }
              }),
          }),
        ),
      )
      const client = LLMClient.layer.pipe(Layer.provide(deps))
      const run = (session: string) =>
        LLMClient.generate(LLM.request({ model, prompt: session, providerOptions: metadata(session, 1) })).pipe(
          Effect.provide(client),
        )

      yield* run("ttl-session-a")
      yield* TestClock.adjust("15 minutes")
      yield* run("ttl-session-b")

      expect(opens).toBe(2)
      expect(closes).toBe(1)
    }),
  )

  it.effect("closes a retained session socket when sending defects", () =>
    Effect.gen(function* () {
      let opens = 0
      let closes = 0
      const deps = Layer.mergeAll(
        Layer.succeed(
          RequestExecutor.Service,
          RequestExecutor.Service.of({ execute: () => Effect.die("unexpected HTTP request") }),
        ),
        Layer.succeed(
          WebSocketExecutor.Service,
          WebSocketExecutor.Service.of({
            open: () =>
              Effect.sync(() => {
                opens += 1
                return {
                  sendText: () => Effect.die("send defect"),
                  messages: Stream.never,
                  close: Effect.sync(() => {
                    closes += 1
                  }),
                }
              }),
          }),
        ),
      )
      const request = LLM.request({
        model,
        prompt: "trigger send defect",
        providerOptions: metadata("send-defect-session", 1),
      })
      const client = LLMClient.layer.pipe(Layer.provide(deps))

      yield* Effect.forEach(
        [request, request],
        (input) => Effect.exit(LLMClient.generate(input).pipe(Effect.provide(client))),
        { concurrency: 1, discard: true },
      )

      expect(opens).toBe(2)
      expect(closes).toBe(2)
    }),
  )

  it.effect("aborts the underlying HTTP request on provider-frame inactivity", () =>
    Effect.gen(function* () {
      const signals: AbortSignal[] = []
      let cancellations = 0
      const executor = RequestExecutor.layer.pipe(
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request, _url, signal) =>
              Effect.sync(() => {
                signals.push(signal)
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    new ReadableStream<Uint8Array>({
                      cancel: () => {
                        cancellations += 1
                      },
                    }),
                    { headers: { "content-type": "text/event-stream" } },
                  ),
                )
              }),
            ),
          ),
        ),
      )
      const fiber = yield* LLMClient.generate(LLM.request({ model: httpModel, prompt: "stall" })).pipe(
        Effect.provide(LLMClient.layer.pipe(Layer.provide(executor))),
        Effect.forkScoped,
      )

      yield* Effect.yieldNow
      expect(signals).toHaveLength(1)
      expect(signals[0]?.aborted).toBe(false)
      yield* TestClock.adjust("120 seconds")
      yield* Fiber.await(fiber)

      expect(signals[0]?.aborted).toBe(true)
      expect(cancellations).toBe(1)
    }),
  )

  it.effect("captures WebSocket response metadata and sends the turn state on the next request", () =>
    Effect.gen(function* () {
      const sent: Array<Record<string, unknown>> = []
      const turnState: Record<string, unknown> = {}
      const socket = yield* Queue.unbounded<string, LLMError>()
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
                sendText: (message: string) =>
                  Effect.gen(function* () {
                    sent.push(ProviderShared.decodeJson(message) as Record<string, unknown>)
                    yield* Queue.offerAll(
                      socket,
                      sent.length === 1
                        ? [
                            ProviderShared.encodeJson({
                              type: "response.metadata",
                              headers: { "x-codex-turn-state": "turn-route-ws" },
                            }),
                            ...completed("resp_turn_1", "msg_turn_1", "First"),
                          ]
                        : completed("resp_turn_2", "msg_turn_2", "Second"),
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
        LLM.request({
          model,
          messages: [Message.user("First"), liveState("state one")],
          providerOptions: metadata("turn-state-session", 1),
          metadata: { openaiCodexTurnState: turnState },
        }),
      ).pipe(Effect.provide(client))
      yield* LLMClient.generate(
        LLM.request({
          model,
          messages: [Message.user("First"), first.message, Message.user("Second"), liveState("state two")],
          providerOptions: metadata("turn-state-session", 3),
          metadata: { openaiCodexTurnState: turnState },
        }),
      ).pipe(Effect.provide(client))

      expect(turnState).toEqual({ value: "turn-route-ws" })
      expect(sent[0]).not.toHaveProperty("client_metadata.x-codex-turn-state")
      expect(sent[1]).toHaveProperty("client_metadata.x-codex-turn-state", "turn-route-ws")
    }),
  )

  it.effect("should reject incremental continuation when the provider reports previous_response_not_found", () =>
    Effect.gen(function* () {
      const sent: Array<Record<string, unknown>> = []
      const socket = yield* Queue.unbounded<string, LLMError>()
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
                sendText: (message: string) =>
                  Effect.gen(function* () {
                    sent.push(ProviderShared.decodeJson(message) as Record<string, unknown>)
                    yield* Queue.offerAll(
                      socket,
                      sent.length === 1
                        ? completed("resp_1", "msg_1", "First answer")
                        : [
                            ProviderShared.encodeJson({
                              type: "error",
                              code: "previous_response_not_found",
                              message: "Continuation rejected",
                            }),
                          ],
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
        LLM.request({
          model,
          messages: [Message.user("First question")],
          providerOptions: metadata("stale-session", 1),
        }),
      ).pipe(Effect.provide(client))
      const failure = yield* LLMClient.generate(
        LLM.request({
          model,
          messages: [Message.user("First question"), first.message, Message.user("Second question")],
          providerOptions: metadata("stale-session", 3),
        }),
      ).pipe(Effect.provide(client), Effect.flip)

      expect(sent[1]).toHaveProperty("previous_response_id", "resp_1")
      expect(failure.reason).toMatchObject({ _tag: "Transport", kind: "websocket-continuation" })
    }),
  )

  it.effect("full-replays on property, prefix, fingerprint, and Session mismatches", () =>
    Effect.gen(function* () {
      const sent: Array<Record<string, unknown>> = []
      let opens = 0
      const responses = Array.from({ length: 5 }, (_, index) =>
        completed(`resp_${index}`, `msg_${index}`, `answer-${index}`),
      )
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
      const run = (
        messages: ReadonlyArray<Message>,
        sessionKey: string,
        fingerprint = "fingerprint",
        temperature?: number,
      ) =>
        LLMClient.generate(
          LLM.request({
            model,
            messages,
            providerOptions: metadata(
              sessionKey,
              messages.filter((message) => message.volatile !== true).length,
              fingerprint,
            ),
            generation: temperature === undefined ? undefined : { temperature },
          }),
        ).pipe(Effect.provide(client))

      const first = yield* run([Message.user("one")], "mismatch-session-a")
      yield* run([Message.user("one"), first.message, Message.user("two")], "mismatch-session-a", "fingerprint", 0.2)
      yield* run([Message.user("changed prefix"), Message.user("three")], "mismatch-session-a")
      yield* run([Message.user("four")], "mismatch-session-a", "changed-fingerprint")
      yield* run([Message.user("five")], "mismatch-session-b", "changed-fingerprint")

      expect(sent.slice(1).every((message) => !("previous_response_id" in message))).toBe(true)
      expect(opens).toBe(3)
    }),
  )

  it.effect("reopens the session socket when the provider reports the WebSocket connection limit", () =>
    Effect.gen(function* () {
      const sent: Array<Record<string, unknown>> = []
      let opens = 0
      let closes = 0
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
                const socketIndex = opens
                opens += 1
                const socket = yield* Queue.unbounded<string, LLMError>()
                return {
                  sendText: (message: string) =>
                    Effect.gen(function* () {
                      sent.push(ProviderShared.decodeJson(message) as Record<string, unknown>)
                      yield* Queue.offerAll(
                        socket,
                        socketIndex === 0
                          ? [
                              ProviderShared.encodeJson({
                                type: "error",
                                status: 400,
                                error: {
                                  type: "invalid_request_error",
                                  code: "websocket_connection_limit_reached",
                                  message:
                                    "Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.",
                                },
                              }),
                            ]
                          : completed("resp_renewed", "msg_renewed", "Renewed answer"),
                      )
                    }),
                  messages: Stream.fromQueue(socket),
                  close: Effect.sync(() => {
                    closes += 1
                  }),
                }
              }),
          }),
        ),
      )

      const response = yield* LLMClient.generate(
        LLM.request({
          model,
          messages: [Message.user("Continue after the connection expires")],
          providerOptions: metadata("connection-limit-session", 1),
        }),
      ).pipe(Effect.provide(LLMClient.layer.pipe(Layer.provide(deps))))

      expect(response.text).toBe("Renewed answer")
      expect(opens).toBe(2)
      expect(closes).toBe(1)
      expect(sent).toHaveLength(2)
      expect(sent[1]).toEqual(sent[0])
    }),
  )

  it.effect("full-replays an incremental request when the connection-limit renewal opens a new socket", () =>
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
                const socketIndex = opens
                opens += 1
                const socket = yield* Queue.unbounded<string, LLMError>()
                return {
                  sendText: (message: string) =>
                    Effect.gen(function* () {
                      sent.push(ProviderShared.decodeJson(message) as Record<string, unknown>)
                      yield* Queue.offerAll(
                        socket,
                        sent.length === 1
                          ? completed("resp_before_limit", "msg_before_limit", "First answer")
                          : socketIndex === 0
                            ? [
                                ProviderShared.encodeJson({
                                  type: "error",
                                  error: {
                                    code: "websocket_connection_limit_reached",
                                    message: "Create a new websocket connection to continue.",
                                  },
                                }),
                              ]
                            : completed("resp_after_limit", "msg_after_limit", "Second answer"),
                      )
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
        LLM.request({
          model,
          messages: [Message.user("First question"), liveState("state one")],
          providerOptions: metadata("incremental-renewal", 1),
        }),
      ).pipe(Effect.provide(client))
      const second = yield* LLMClient.generate(
        LLM.request({
          model,
          messages: [
            Message.user("First question"),
            first.message,
            Message.user("Second question"),
            liveState("state two"),
          ],
          providerOptions: metadata("incremental-renewal", 3),
        }),
      ).pipe(Effect.provide(client))

      expect(second.text).toBe("Second answer")
      expect(opens).toBe(2)
      expect(sent).toHaveLength(3)
      expect(sent[1]).toHaveProperty("previous_response_id", "resp_before_limit")
      expect(sent[2]).not.toHaveProperty("previous_response_id")
      expect((sent[2]?.input as ReadonlyArray<unknown>).length).toBeGreaterThan(
        (sent[1]?.input as ReadonlyArray<unknown>).length,
      )
    }),
  )

  it.effect("fails after one renewal when the replacement socket also reaches its connection limit", () =>
    Effect.gen(function* () {
      let opens = 0
      let sends = 0
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
                  sendText: () =>
                    Effect.gen(function* () {
                      sends += 1
                      yield* Queue.offer(
                        socket,
                        ProviderShared.encodeJson({
                          type: "error",
                          error: {
                            code: "websocket_connection_limit_reached",
                            message: "Create a new websocket connection to continue.",
                          },
                        }),
                      )
                    }),
                  messages: Stream.fromQueue(socket),
                  close: Effect.void,
                }
              }),
          }),
        ),
      )
      const failure = yield* LLMClient.generate(
        LLM.request({
          model,
          prompt: "Fail twice",
          providerOptions: metadata("bounded-renewal", 1),
        }),
      ).pipe(Effect.provide(LLMClient.layer.pipe(Layer.provide(deps))), Effect.flip)

      expect(failure.reason).toMatchObject({ _tag: "Transport", kind: "websocket-connection-limit" })
      expect(opens).toBe(2)
      expect(sends).toBe(2)
    }),
  )

  it.effect("switches an unhealthy session to HTTP with the full request body", () =>
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
                  new Response(
                    sseEvents(
                      { type: "response.output_text.delta", item_id: "msg_http", delta: "Recovered" },
                      { type: "response.completed", response: { id: "resp_http" } },
                    ),
                    { headers: { "content-type": "text/event-stream" } },
                  ),
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
                        Cause.fail(
                          new LLMError({
                            module: "fixture",
                            method: "read",
                            reason: new TransportReason({ message: "socket closed", kind: "close" }),
                          }),
                        ),
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
      expect(failure.reason).toMatchObject({ _tag: "Transport", kind: "websocket-fallback" })

      yield* LLMClient.generate(
        LLM.request({ model, messages, providerOptions: metadata("fallback-session", 3, "fingerprint", true) }),
      ).pipe(Effect.provide(client))
      expect(sent[1]).toHaveProperty("previous_response_id", "resp_1")
      expect(httpBodies).toHaveLength(1)
      expect(httpBodies[0]?.input).toHaveLength(3)
      expect(httpBodies[0]).not.toHaveProperty("previous_response_id")
    }),
  )

  it.effect("retries Codex WS close 1006 before output as HTTP full replay once", () =>
    Effect.gen(function* () {
      // HTTP remains the default transport; Codex WS is explicit opt-in via webSocketRoute.
      // A clean 1006 before any provider frame must be classified retryable and retried exactly once
      // via the existing HTTP SSE path with the canonical full history, not as a terminal failure.
      const httpBodies: Array<Record<string, unknown>> = []
      let wsOpens = 0
      let httpCalls = 0
      const deps = Layer.mergeAll(
        Layer.succeed(
          RequestExecutor.Service,
          RequestExecutor.Service.of({
            execute: (request) =>
              Effect.gen(function* () {
                httpCalls += 1
                const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
                httpBodies.push((yield* Effect.promise(() => web.json())) as Record<string, unknown>)
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    sseEvents(
                      { type: "response.output_text.delta", item_id: "msg_http", delta: "Recovered via HTTP" },
                      { type: "response.completed", response: { id: "resp_http" } },
                    ),
                    { headers: { "content-type": "text/event-stream" } },
                  ),
                )
              }),
          }),
        ),
        Layer.succeed(
          WebSocketExecutor.Service,
          WebSocketExecutor.Service.of({
            open: () =>
              Effect.gen(function* () {
                wsOpens += 1
                const socket = yield* Queue.unbounded<string, LLMError>()
                Queue.failCauseUnsafe(
                  socket,
                  Cause.fail(
                    new LLMError({
                      module: "WebSocketExecutor",
                      method: "message",
                      reason: new TransportReason({ message: "WebSocket closed with code 1006", kind: "close" }),
                    }),
                  ),
                )
                return {
                  sendText: () => Effect.void,
                  messages: Stream.fromQueue(socket),
                  close: Effect.void,
                }
              }),
          }),
        ),
      )
      const client = LLMClient.layer.pipe(Layer.provide(deps))
      const response = yield* LLMClient.generate(
        LLM.request({
          model,
          messages: [Message.user("First question"), Message.user("Second question")],
          providerOptions: metadata("retry-before-output", 2),
        }),
      ).pipe(Effect.provide(client))

      expect(response.text).toBe("Recovered via HTTP")
      expect(wsOpens).toBe(1)
      expect(httpCalls).toBe(1)
      // Full replay: HTTP body must carry the complete canonical input, not an incremental delta.
      expect(httpBodies[0]?.input).toHaveLength(2)
      expect(httpBodies[0]).not.toHaveProperty("previous_response_id")
    }),
  )

  it.effect("does not auto-replay Codex WS close 1006 after output", () =>
    Effect.gen(function* () {
      // After the provider has already emitted visible output/tool effects, a 1006 must not trigger
      // an automatic HTTP full-replay within the same request — that would duplicate side effects.
      let httpCalls = 0
      const deps = Layer.mergeAll(
        Layer.succeed(
          RequestExecutor.Service,
          RequestExecutor.Service.of({
            execute: () =>
              Effect.gen(function* () {
                httpCalls += 1
                return HttpClientResponse.fromWeb(
                  new HttpClientRequest.HttpClientRequest("POST", "https://chatgpt.test/backend-api/codex/responses"),
                  new Response(sseEvents({ type: "response.completed", response: { id: "resp_http" } }), {
                    headers: { "content-type": "text/event-stream" },
                  }),
                )
              }),
          }),
        ),
        Layer.succeed(
          WebSocketExecutor.Service,
          WebSocketExecutor.Service.of({
            open: () =>
              Effect.gen(function* () {
                const socket = yield* Queue.unbounded<string, LLMError>()
                return {
                  sendText: () =>
                    Effect.gen(function* () {
                      yield* Queue.offer(
                        socket,
                        ProviderShared.encodeJson({
                          type: "response.output_text.delta",
                          item_id: "msg_1",
                          delta: "partial",
                        }),
                      )
                      Queue.failCauseUnsafe(
                        socket,
                        Cause.fail(
                          new LLMError({
                            module: "WebSocketExecutor",
                            method: "message",
                            reason: new TransportReason({ message: "WebSocket closed with code 1006", kind: "close" }),
                          }),
                        ),
                      )
                    }),
                  messages: Stream.fromQueue(socket),
                  close: Effect.void,
                }
              }),
          }),
        ),
      )
      const client = LLMClient.layer.pipe(Layer.provide(deps))
      const failure = yield* LLMClient.generate(
        LLM.request({
          model,
          messages: [Message.user("Trigger")],
          providerOptions: metadata("retry-after-output", 1),
        }),
      ).pipe(Effect.provide(client), Effect.flip)

      expect(failure.reason).toBeDefined()
      // Must not have silently duplicated the partial output via an automatic HTTP replay.
      expect(httpCalls).toBe(0)
      // Current live maps both close cases to websocket-fallback; after-output must remain non-fallback
      // so the caller can surface the partial output without a silent retry. Expect RED until distinguished.
      expect(failure.reason).toMatchObject({ _tag: "Transport", kind: "close" })
    }),
  )

  it.effect("keeps session identity headers identical on HTTP fallback after 1006", () =>
    Effect.gen(function* () {
      const wsHeaders: Array<Record<string, string>> = []
      const httpHeaders: Array<Record<string, string>> = []
      const httpBodies: Array<Record<string, unknown>> = []
      const deps = Layer.mergeAll(
        Layer.succeed(
          RequestExecutor.Service,
          RequestExecutor.Service.of({
            execute: (request) =>
              Effect.gen(function* () {
                const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
                httpHeaders.push(Object.fromEntries(web.headers.entries()))
                httpBodies.push((yield* Effect.promise(() => web.json())) as Record<string, unknown>)
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    sseEvents(
                      { type: "response.output_text.delta", item_id: "msg_http", delta: "Recovered" },
                      { type: "response.completed", response: { id: "resp_http" } },
                    ),
                    { headers: { "content-type": "text/event-stream" } },
                  ),
                )
              }),
          }),
        ),
        Layer.succeed(
          WebSocketExecutor.Service,
          WebSocketExecutor.Service.of({
            open: (input) =>
              Effect.gen(function* () {
                const get = (name: string) => input.headers[name] ?? ""
                wsHeaders.push({
                  "session-id": get("session-id"),
                  "thread-id": get("thread-id"),
                  "x-client-request-id": get("x-client-request-id"),
                })
                const socket = yield* Queue.unbounded<string, LLMError>()
                Queue.failCauseUnsafe(
                  socket,
                  Cause.fail(
                    new LLMError({
                      module: "WebSocketExecutor",
                      method: "message",
                      reason: new TransportReason({ message: "WebSocket closed with code 1006", kind: "close" }),
                    }),
                  ),
                )
                return {
                  sendText: () => Effect.void,
                  messages: Stream.fromQueue(socket),
                  close: Effect.void,
                }
              }),
          }),
        ),
      )
      const client = LLMClient.layer.pipe(Layer.provide(deps))
      yield* LLMClient.generate(
        LLM.request({
          model,
          messages: [Message.user("Hello")],
          providerOptions: metadata("header-session", 1),
        }),
      ).pipe(Effect.provide(client))

      expect(wsHeaders).toHaveLength(1)
      expect(httpHeaders).toHaveLength(1)
      // Codex identity headers must survive the transport switch unchanged.
      expect(httpHeaders[0]["session-id"]).toBe(wsHeaders[0]["session-id"])
      expect(httpHeaders[0]["thread-id"]).toBe(wsHeaders[0]["thread-id"])
      expect(httpHeaders[0]["x-client-request-id"]).toBe(wsHeaders[0]["x-client-request-id"])
      expect(httpHeaders[0]["session-id"]).toBeTruthy()
      expect(httpBodies[0]?.prompt_cache_key).toBeDefined()
    }),
  )

  it.effect("replays a Codex WS provider-frame inactivity timeout through HTTP exactly once", () =>
    Effect.gen(function* () {
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
                  new Response(
                    sseEvents(
                      { type: "response.output_text.delta", item_id: "msg_http", delta: "Recovered" },
                      { type: "response.completed", response: { id: "resp_http" } },
                    ),
                    { headers: { "content-type": "text/event-stream" } },
                  ),
                )
              }),
          }),
        ),
        Layer.succeed(
          WebSocketExecutor.Service,
          WebSocketExecutor.Service.of({
            open: () =>
              Effect.succeed({
                sendText: () => Effect.void,
                messages: Stream.fromQueue(socket),
                close: Effect.void,
              }),
          }),
        ),
      )
      const fiber = yield* LLMClient.generate(
        LLM.request({
          model,
          messages: [Message.user("Replay the full history")],
          providerOptions: metadata("timeout-before-frame", 1),
        }),
      ).pipe(Effect.provide(LLMClient.layer.pipe(Layer.provide(deps))), Effect.forkScoped)

      const result = yield* expectTimedFailure(fiber)
      expect(result).toBeDefined()
      if (result === undefined) return
      expect(Exit.isSuccess(result)).toBe(true)
      expect(httpBodies).toHaveLength(1)
      expect(httpBodies[0]).not.toHaveProperty("previous_response_id")
      expect(httpBodies[0]?.input).toHaveLength(1)
    }),
  )

  it.effect("bounds the single HTTP replay after a Codex WS inactivity timeout", () =>
    Effect.gen(function* () {
      let httpCalls = 0
      const socket = yield* Queue.unbounded<string, LLMError>()
      const deps = Layer.mergeAll(
        Layer.succeed(
          RequestExecutor.Service,
          RequestExecutor.Service.of({
            execute: (request) =>
              Effect.sync(() => {
                httpCalls += 1
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } }),
                )
              }),
          }),
        ),
        Layer.succeed(
          WebSocketExecutor.Service,
          WebSocketExecutor.Service.of({
            open: () =>
              Effect.succeed({
                sendText: () => Effect.void,
                messages: Stream.fromQueue(socket),
                close: Effect.void,
              }),
          }),
        ),
      )
      const fiber = yield* LLMClient.generate(
        LLM.request({ model, prompt: "Bound the replay", providerOptions: metadata("timeout-http-replay", 0) }),
      ).pipe(Effect.provide(LLMClient.layer.pipe(Layer.provide(deps))), Effect.forkScoped)

      yield* Effect.yieldNow
      yield* TestClock.adjust("120 seconds")
      yield* Effect.yieldNow
      expect(httpCalls).toBe(1)
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("120 seconds")
      yield* Effect.yieldNow
      const result = yield* Fiber.await(fiber)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isSuccess(result)) return
      expect(Cause.prettyErrors(result.cause)[0]).toMatchObject({
        reason: { _tag: "Transport", kind: "codex-read-stall" },
      })
      expect(httpCalls).toBe(1)
    }),
  )

  it.effect("fails a Codex WS provider-frame inactivity timeout after a decoded frame without replay", () =>
    Effect.gen(function* () {
      let httpCalls = 0
      const socket = yield* Queue.unbounded<string, LLMError>()
      const deps = Layer.mergeAll(
        Layer.succeed(
          RequestExecutor.Service,
          RequestExecutor.Service.of({
            execute: () =>
              Effect.sync(() => {
                httpCalls += 1
              }).pipe(Effect.die),
          }),
        ),
        Layer.succeed(
          WebSocketExecutor.Service,
          WebSocketExecutor.Service.of({
            open: () =>
              Effect.succeed({
                sendText: () =>
                  Queue.offer(
                    socket,
                    ProviderShared.encodeJson({ type: "response.created", response: { id: "resp_1" } }),
                  ),
                messages: Stream.fromQueue(socket),
                close: Effect.void,
              }),
          }),
        ),
      )
      const fiber = yield* LLMClient.generate(
        LLM.request({ model, prompt: "Do not replay output", providerOptions: metadata("timeout-after-frame", 0) }),
      ).pipe(Effect.provide(LLMClient.layer.pipe(Layer.provide(deps))), Effect.forkScoped)

      const result = yield* expectTimedFailure(fiber)
      expect(result).toBeDefined()
      if (result === undefined || Exit.isSuccess(result)) return
      expect(Cause.prettyErrors(result.cause)[0]).toMatchObject({
        reason: { _tag: "Transport", kind: "codex-read-stall" },
      })
      expect(httpCalls).toBe(0)
    }),
  )

  it.effect("resets the Codex WS inactivity interval for each decoded provider frame", () =>
    Effect.gen(function* () {
      const socket = yield* Queue.unbounded<string, LLMError>()
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
                messages: Stream.fromQueue(socket),
                close: Effect.void,
              }),
          }),
        ),
      )
      const fiber = yield* LLMClient.generate(
        LLM.request({ model, prompt: "Reset the timeout", providerOptions: metadata("timeout-reset", 0) }),
      ).pipe(Effect.provide(LLMClient.layer.pipe(Layer.provide(deps))), Effect.forkScoped)

      yield* Effect.yieldNow
      yield* TestClock.adjust("119 seconds")
      yield* Queue.offer(socket, ProviderShared.encodeJson({ type: "response.created", response: { id: "resp_1" } }))
      yield* Effect.yieldNow
      yield* TestClock.adjust("119 seconds")
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("1 second")
      yield* Effect.yieldNow
      const result = yield* Fiber.await(fiber)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isSuccess(result)) return
      expect(Cause.prettyErrors(result.cause)[0]).toMatchObject({
        reason: { _tag: "Transport", kind: "codex-read-stall" },
      })
    }),
  )

  it.effect("fails a Codex HTTP SSE provider-frame inactivity timeout without retrying", () =>
    Effect.gen(function* () {
      let httpCalls = 0
      const httpModel = OpenAIResponses.route
        .with({
          id: "openai-codex-responses",
          endpoint: { baseURL: "https://chatgpt.test/backend-api/codex" },
          auth: Auth.bearer("test"),
        })
        .model({ id: "gpt-5.6" })
      const deps = Layer.succeed(
        RequestExecutor.Service,
        RequestExecutor.Service.of({
          execute: (request) =>
            Effect.sync(() => {
              httpCalls += 1
              return HttpClientResponse.fromWeb(
                request,
                new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } }),
              )
            }),
        }),
      )
      const fiber = yield* LLMClient.generate(
        LLM.request({ model: httpModel, prompt: "Timeout", providerOptions: metadata("http-timeout", 0) }),
      ).pipe(Effect.provide(LLMClient.layer.pipe(Layer.provide(deps))), Effect.forkScoped)

      const result = yield* expectTimedFailure(fiber)
      expect(result).toBeDefined()
      if (result === undefined || Exit.isSuccess(result)) return
      expect(Cause.prettyErrors(result.cause)[0]).toMatchObject({
        reason: { _tag: "Transport", kind: "codex-read-stall" },
      })
      expect(httpCalls).toBe(1)
    }),
  )

  it.effect("classifies a Codex WS forced-HTTP frame-read failure as a retryable transport failure", () =>
    Effect.gen(function* () {
      const deps = Layer.mergeAll(
        Layer.succeed(
          RequestExecutor.Service,
          RequestExecutor.Service.of({
            execute: (request) =>
              Effect.sync(() =>
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    new ReadableStream({
                      start(controller) {
                        controller.error(new Error("socket hang up"))
                      },
                    }),
                    { headers: { "content-type": "text/event-stream" } },
                  ),
                ),
              ),
          }),
        ),
        Layer.succeed(
          WebSocketExecutor.Service,
          WebSocketExecutor.Service.of({
            open: () => Effect.die("unexpected"),
          }),
        ),
      )

      const failure = yield* LLMClient.generate(
        LLM.request({
          model,
          messages: [Message.user("Recover through HTTP")],
          providerOptions: metadata("forced-http-stream-fail", 1, "rotated", true, true),
        }),
      ).pipe(Effect.provide(LLMClient.layer.pipe(Layer.provide(deps))), Effect.flip)

      expect(failure.reason).toMatchObject({ _tag: "Transport", kind: "stream-read" })
      expect((failure.reason as { message?: string }).message).toContain("Failed to read")
    }),
  )
})
