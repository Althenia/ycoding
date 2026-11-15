import { describe, expect, test } from "bun:test"
import { Agent } from "@ycoding-ai/core/agent"
import { make as makeClient } from "../../client/src/promise/generated/client"
import { EventRuntime } from "@ycoding-ai/core/event"
import { YCodingEvent } from "@ycoding-ai/protocol/groups/event"
import { ServiceStatus } from "@ycoding-ai/protocol/groups/health"
import { DateTime, Deferred, Effect, Exit, Fiber, Option, Schema, Stream } from "effect"
import { it } from "../../core/test/lib/effect"
import { EventFeed } from "../src/event-feed"

const Internal = EventRuntime.ephemeral({ type: "test.internal", schema: { value: Schema.String } })
const sourceEpoch = ServiceStatus.Epoch.make("source_test")

const event = (id: string): EventRuntime.Payload<typeof Agent.Event.Updated> => ({
  id: EventRuntime.ID.make(`evt_${id}`),
  created: DateTime.makeUnsafe(Date.now()),
  type: Agent.Event.Updated.type,
  data: {},
})

const internal = (value: string): EventRuntime.Payload<typeof Internal> => ({
  id: EventRuntime.ID.create(),
  created: DateTime.makeUnsafe(Date.now()),
  type: Internal.type,
  data: { value },
})

function makeSource() {
  let subscriber: EventRuntime.Subscriber | undefined
  return {
    observe: (next: EventRuntime.Subscriber) =>
      Effect.sync(() => {
        subscriber = next
        return Effect.sync(() => {
          if (subscriber === next) subscriber = undefined
        })
      }),
    publish: (event: EventRuntime.Payload) => Effect.suspend(() => (subscriber ? subscriber(event) : Effect.void)),
  }
}

function clientForFrames(frames: readonly string[]) {
  return makeClient({
    baseUrl: "http://fixture.invalid",
    fetch: Object.assign(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame))
              controller.close()
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      { preconnect() {} },
    ),
  })
}

describe("EventFeed", () => {
  test("the consumer bounds oversized complete and incomplete UTF-8 frames", async () => {
    const payload = { ...event("oversized"), metadata: { output: "界".repeat(6 * 1024 * 1024) } }
    const oversized = EventFeed.frame(sourceEpoch, payload)
    for (const frame of [oversized, oversized.slice(0, -2)]) {
      const client = clientForFrames([frame])
      const failure = await Array.fromAsync(client.event.subscribe()).then(() => undefined, (error: unknown) => error)
      expect(failure).toMatchObject({ reason: "SseEventTooLarge" })
    }
  })

  it.effect("delivers coalesced legal frames without treating the transport chunk as one event", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(sourceEpoch, source.observe)
      const stream = yield* feed.subscribe
      const first = { ...event("one"), metadata: { output: "" } }
      const available = 16 * 1024 * 1024 - new TextEncoder().encode(EventFeed.frame(sourceEpoch, first)).byteLength
      first.metadata.output = "界".repeat(Math.floor(available / 3)) + "x".repeat(available % 3)
      expect(new TextEncoder().encode(EventFeed.frame(sourceEpoch, first)).byteLength).toBe(16 * 1024 * 1024)
      yield* source.publish(first)
      yield* source.publish({ ...event("two"), metadata: { output: "x".repeat(9 * 1024 * 1024) } })
      const frames = Array.from(yield* stream.pipe(Stream.take(2), Stream.runCollect))
      const ids = yield* Effect.promise(async () => {
        const client = clientForFrames([frames.join("")])
        const ids: string[] = []
        for await (const event of client.event.subscribe()) ids.push(event.id)
        return ids
      })
      expect(ids).toEqual(["evt_one", "evt_two"])
    }),
  )

  for (const character of ["x", "界"]) {
    it.effect(`keeps subscribers connected after an oversized ${character === "x" ? "ASCII" : "UTF-8"} frame`, () =>
      Effect.gen(function* () {
        const source = makeSource()
        const feed = yield* EventFeed.make(sourceEpoch, source.observe)
        const first = yield* feed.subscribe
        const second = yield* feed.subscribe
        const oversized = {
          ...event("large"),
          type: "session.tool.invocation-settled",
          durable: { aggregateID: "ses_source", seq: EventRuntime.Seq.make(2), version: EventRuntime.Version.make(1) },
          data: {
            sessionID: "ses_source",
            assistantMessageID: "msg_source",
            callID: "call_source",
            invocation: {
              id: "call_nested",
              index: 0,
              name: "shell",
              tool: "shell",
              status: "completed",
              structured: { output: character.repeat((character === "x" ? 17 : 6) * 1024 * 1024) },
            },
          },
        }
        expect(new TextEncoder().encode(EventFeed.frame(sourceEpoch, oversized)).byteLength).toBeGreaterThan(
          16 * 1024 * 1024,
        )
        const small = (id: string, seq: number) => ({
          ...oversized,
          id: EventRuntime.ID.make(`evt_${id}`),
          durable: { ...oversized.durable, seq: EventRuntime.Seq.make(seq) },
          data: { ...oversized.data, invocation: { ...oversized.data.invocation, structured: { output: id } } },
        })
        yield* source.publish(small("before", 1))
        yield* source.publish(oversized)
        yield* source.publish(small("after", 3))
        for (const stream of [first, second]) {
          const frames = Array.from(yield* stream.pipe(Stream.take(2), Stream.runCollect))
          const received = yield* Effect.promise(async () => {
            const client = clientForFrames(frames)
            const received = []
            for await (const event of client.event.subscribe())
              received.push({ id: event.id, seq: "durable" in event ? event.durable.seq : undefined })
            return received
          })
          expect(received).toEqual([{ id: "evt_before", seq: 1 }, { id: "evt_after", seq: 3 }])
        }
      }),
    )
  }

  test("preserves the public SSE frame encoding", () => {
    const payload = event("wire")
    expect(EventFeed.frame(sourceEpoch, payload)).toBe(
      `data: ${JSON.stringify(Schema.encodeUnknownSync(YCodingEvent)({ ...payload, sourceEpoch }))}\n\n`,
    )
  })

  it.effect("encodes once and delivers the same frame to every subscriber", () =>
    Effect.gen(function* () {
      let encodes = 0
      const source = makeSource()
      const feed = yield* EventFeed.make(sourceEpoch, source.observe, {
        encode: (event) => {
          encodes += 1
          return event.type
        },
      })
      const first = yield* feed.subscribe
      const second = yield* feed.subscribe
      const left = yield* first.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      const right = yield* second.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)

      yield* source.publish(event("example"))

      expect([Array.from(yield* Fiber.join(left)), Array.from(yield* Fiber.join(right))]).toEqual([
        [Agent.Event.Updated.type],
        [Agent.Event.Updated.type],
      ])
      expect(encodes).toBe(1)
    }),
  )

  it.effect("fails only the subscriber that exceeds its lag capacity", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(sourceEpoch, source.observe, {
        capacity: 1,
        encode: (event) => event.id,
      })
      const slow = yield* feed.subscribe
      const fast = yield* feed.subscribe
      const first = yield* Deferred.make<void>()
      const second = yield* Deferred.make<void>()
      const received = new Array<string>()
      const fastFiber = yield* fast.pipe(
        Stream.take(3),
        Stream.runForEach((frame) =>
          Effect.sync(() => received.push(frame)).pipe(
            Effect.andThen(
              frame === "evt_one"
                ? Deferred.succeed(first, undefined)
                : frame === "evt_two"
                  ? Deferred.succeed(second, undefined)
                  : Effect.void,
            ),
          ),
        ),
        Effect.forkScoped,
      )

      yield* source.publish(event("one"))
      yield* Deferred.await(first)
      yield* source.publish(event("two"))
      yield* Deferred.await(second)
      yield* source.publish(event("three"))

      yield* Fiber.join(fastFiber)

      const result = yield* slow.pipe(Stream.runCollect, Effect.exit)
      expect(received).toEqual(["evt_one", "evt_two", "evt_three"])
      expect(Exit.isFailure(result)).toBeTrue()
      if (Exit.isSuccess(result)) return
      expect(Option.getOrUndefined(Exit.findErrorOption(result))).toBeInstanceOf(EventFeed.SubscriberOverflowError)
    }),
  )

  it.effect("filters internal events before they consume subscriber capacity", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(sourceEpoch, source.observe, { capacity: 1, encode: (event) => event.type })
      const stream = yield* feed.subscribe

      yield* source.publish(internal("one"))
      yield* source.publish(internal("two"))
      yield* source.publish(event("public"))

      expect(Array.from(yield* stream.pipe(Stream.take(1), Stream.runCollect))).toEqual([Agent.Event.Updated.type])
    }),
  )

  it.effect("disconnects current subscribers after an encoding failure and continues for later subscribers", () =>
    Effect.gen(function* () {
      const source = makeSource()
      const feed = yield* EventFeed.make(sourceEpoch, source.observe, {
        encode: (event) => {
          if (event.id === EventRuntime.ID.make("evt_bad")) throw new Error("invalid event")
          return event.id
        },
      })
      const current = yield* feed.subscribe
      const failed = yield* current.pipe(Stream.runCollect, Effect.exit, Effect.forkScoped)

      yield* source.publish(event("bad"))
      const exit = yield* Fiber.join(failed)

      const next = yield* feed.subscribe
      const received = yield* next.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* source.publish(event("good"))

      expect(Exit.isFailure(exit)).toBeTrue()
      if (Exit.isSuccess(exit)) return
      expect(Option.getOrUndefined(Exit.findErrorOption(exit))).toBeInstanceOf(EventFeed.EncodingError)
      expect(Array.from(yield* Fiber.join(received))).toEqual(["evt_good"])
    }),
  )
})
