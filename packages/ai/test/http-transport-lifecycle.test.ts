import { describe, expect } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { LLM } from "../src"
import { Endpoint, LLMClient, Protocol, Route, type FramingDef } from "../src/route"
import { Model } from "../src/schema"
import { testEffect } from "./lib/effect"
import { dynamicResponse } from "./lib/http"

const Event = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("finish"), reason: Schema.Literal("stop") }),
])
type Event = Schema.Schema.Type<typeof Event>

const framing: FramingDef<Event> = {
  id: "json-lines",
  frame: (bytes) =>
    bytes.pipe(
      Stream.decodeText(),
      Stream.mapEffect((text) => Schema.decodeUnknownEffect(Event)(JSON.parse(text))),
    ),
}

const protocol = Protocol.make({
  id: "http-lifecycle",
  body: {
    schema: Schema.Struct({ body: Schema.String }),
    from: () => Effect.succeed({ body: "hello" }),
  },
  stream: {
    event: Event,
    initial: () => undefined,
    step: (state, event) =>
      Effect.succeed([
        state,
        event.type === "finish"
          ? [{ type: "finish", reason: event.reason }]
          : [{ type: "text-delta", id: "text-0", text: event.text }],
      ] as const),
    terminal: (event) => event.type === "finish",
  },
})

const lifecycle = { cancelled: 0 }
const route = Route.make({
  id: "http-lifecycle",
  provider: "lifecycle-provider",
  protocol,
  endpoint: Endpoint.path("/stream", { baseURL: "https://lifecycle.test" }),
  framing,
})
const request = LLM.request({
  model: Model.make({ id: "lifecycle-model", provider: "lifecycle-provider", route }),
  prompt: "hello",
})

describe("HTTP transport stream lifecycle", () => {
  testEffect(
    dynamicResponse(({ respond }) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode('{"type":"text","text":"hello"}'))
          controller.enqueue(encoder.encode('{"type":"finish","reason":"stop"}'))
        },
        cancel() {
          lifecycle.cancelled += 1
        },
      })
      return Effect.succeed(respond(body, { headers: { "content-type": "text/event-stream" } }))
    }),
  ).effect("cancels the HTTP body when terminal detection stops early", () =>
    Effect.gen(function* () {
      lifecycle.cancelled = 0
      const response = yield* (yield* LLMClient.Service).stream(request).pipe(Stream.runCollect)

      expect(response.map((event) => event.type)).toEqual(["text-delta", "finish"])
      expect(lifecycle.cancelled).toBe(1)
    }),
  )

  testEffect(
    dynamicResponse(({ respond }) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"type":"text","text":"hello"}'))
        },
        cancel() {
          lifecycle.cancelled += 1
        },
      })
      return Effect.succeed(respond(body, { headers: { "content-type": "text/event-stream" } }))
    }),
  ).effect("cancels the HTTP body when a downstream consumer stops", () =>
    Effect.gen(function* () {
      lifecycle.cancelled = 0
      const response = yield* (yield* LLMClient.Service).stream(request).pipe(Stream.take(1), Stream.runCollect)

      expect(response.map((event) => event.type)).toEqual(["text-delta"])
      expect(lifecycle.cancelled).toBe(1)
    }),
  )
})
