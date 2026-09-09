import { describe, expect } from "bun:test"
import { Effect, Stream } from "effect"
import { LLM, LLMEvent } from "../src"
import { OpenAIResponses } from "../src/protocols/openai-responses"
import { ProviderShared } from "../src/protocols/shared"
import { Auth, LLMClient } from "../src/route"
import { it } from "./lib/effect"
import { dynamicResponse } from "./lib/http"
import { sseEvents } from "./lib/sse"

describe("SSE framing", () => {
  it.effect("ignores retry directives without dropping later chunks", () =>
    Effect.gen(function* () {
      const events = yield* Stream.fromIterable([
        "retry: 1000\n\n",
        "data: first\n\n",
        "retry: 2000\n\n",
        "data: last\n\n",
      ]).pipe(
        Stream.rechunk(1),
        Stream.map((text) => new TextEncoder().encode(text)),
        ProviderShared.sseFraming,
        Stream.runCollect,
      )
      expect(Array.from(events)).toEqual(["first", "last"])
    }),
  )

  it.effect("preserves a read failure after an ignored retry directive", () =>
    Effect.gen(function* () {
      const failure = ProviderShared.streamReadError("test", new Error("connection reset"))
      const error = yield* Stream.make(new TextEncoder().encode("retry: 1000\n\n")).pipe(
        Stream.concat(Stream.fail(failure)),
        ProviderShared.sseFraming,
        Stream.runDrain,
        Effect.flip,
      )
      expect(error).toBe(failure)
    }),
  )

  it.effect("preserves framing across every byte boundary and independent subscriptions", () =>
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode(
        ': keepalive\r\nretry: 1000\r\n\r\ndata: \r\n\r\nevent: message\r\ndata: {"text":"ไทย"}\r\n\r\n' +
          'data: [DONE]\r\n\r\nretry: 2000\n\ndata: first\ndata: second\n\ndata: unfinished',
      )
      yield* Effect.forEach(Array.from({ length: bytes.length + 1 }, (_, index) => index), (index) =>
        Effect.gen(function* () {
          const framed = Stream.make(bytes.slice(0, index), bytes.slice(index)).pipe(
            Stream.rechunk(1),
            ProviderShared.sseFraming,
          )
          const first = yield* framed.pipe(Stream.runCollect)
          const second = yield* framed.pipe(Stream.runCollect)
          expect(Array.from(first)).toEqual(['{"text":"ไทย"}', "first\nsecond"])
          expect(Array.from(second)).toEqual(Array.from(first))
        }),
      )
    }),
  )

  it.effect("does not treat a retry directive or DONE marker as provider completion", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(
        LLM.request({
          model: OpenAIResponses.route
            .with({ endpoint: { baseURL: "https://api.openai.test/v1" }, auth: Auth.bearer("test") })
            .model({ id: "gpt-4.1-mini" }),
          prompt: "Hello",
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) => Effect.succeed(input.respond("retry: 1000\n\ndata: [DONE]\n\n"))),
        ),
        Effect.flip,
      )
      expect(error.reason).toMatchObject({
        _tag: "InvalidProviderOutput",
        message: "Provider stream ended without a terminal finish event",
      })
    }),
  )

  it.effect("retains completion and usage after retry directives on the native Responses route", () =>
    Effect.gen(function* () {
      const requests: string[] = []
      const response = yield* LLMClient.generate(
        LLM.request({
          model: OpenAIResponses.route
            .with({ endpoint: { baseURL: "https://api.openai.test/v1" }, auth: Auth.bearer("test") })
            .model({ id: "gpt-4.1-mini" }),
          prompt: "Hello",
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.sync(() => {
              requests.push(input.request.method)
              const chunks = [
                "retry: 1000\n\n",
                sseEvents({ type: "response.output_text.delta", item_id: "msg_1", delta: "Hello" }),
                "retry: 2000\n\n",
                sseEvents({
                  type: "response.completed",
                  response: { usage: { input_tokens: 5, output_tokens: 1 } },
                }),
              ][Symbol.iterator]()
              return input.respond(
                new ReadableStream<Uint8Array>({
                  pull(controller) {
                    const chunk = chunks.next()
                    if (chunk.done) return controller.close()
                    controller.enqueue(new TextEncoder().encode(chunk.value))
                  },
                }),
                { headers: { "content-type": "text/event-stream" } },
              )
            }),
          ),
        ),
      )
      expect(response.message.content).toEqual([{ type: "text", text: "Hello" }])
      expect(response.events.filter(LLMEvent.is.finish)).toHaveLength(1)
      expect(response.usage).toMatchObject({ inputTokens: 5, outputTokens: 1 })
      expect(requests).toEqual(["POST"])
    }),
  )
})
