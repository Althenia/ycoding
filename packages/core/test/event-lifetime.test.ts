import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { EventRuntime } from "../src/event"
import { SessionEvent } from "../src/session/event"
import { SessionSchema } from "../src/session/schema"
import { historyDatabase } from "./fixture/session-history-pruning"

const Message = EventRuntime.ephemeral({ type: "test.lifetime.message", schema: { text: Schema.String } })

test("repeated subscriber interruption removes queued payloads before the next subscriber starts", async () => {
  let queued: ReadonlyArray<number> = []
  const layer = EventRuntime.layerWith({ onLiveQueueChange: (value) => { queued = value } }).pipe(
    Layer.provideMerge(historyDatabase),
  )
  await Effect.runPromise(Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    for (let round = 0; round < 16; round++) {
      const entered = yield* Deferred.make<void>()
      const received: string[] = []
      const first = `${round}:` + "x".repeat(128 * 1024)
      const consumer = yield* events.subscribe(Message).pipe(
        Stream.runForEach((event) => Effect.gen(function* () {
          received.push(event.data.text)
          yield* Deferred.succeed(entered, undefined)
          yield* Effect.never
        })),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* events.publish(Message, { text: first })
      yield* Deferred.await(entered)
      yield* events.publish(Message, { text: `${round}:queued` + "y".repeat(128 * 1024) })
      expect(queued).toEqual([1])
      yield* Fiber.interrupt(consumer)
      expect(queued).toEqual([])
      yield* events.publish(Message, { text: "after cancellation" })
      expect(received).toEqual([first])
    }
    const next = yield* events.subscribe(Message).pipe(
      Stream.take(1), Stream.runCollect, Effect.forkScoped({ startImmediately: true }),
    )
    yield* events.publish(Message, { text: "replacement" })
    expect((yield* Fiber.join(next)).map((event) => event.data.text)).toEqual(["replacement"])
    expect(queued).toEqual([])
  }).pipe(Effect.provide(layer), Effect.scoped, Effect.timeout("5 seconds")))
})

test("repeated cancellation of pending historical reads leaves replacement cursors usable", async () => {
  let pause = true
  let pending = 0
  let cancelled = 0
  let entered = Deferred.makeUnsafe<void>()
  const layer = EventRuntime.layerWith({
    logReadPageSize: 2,
    beforeAggregateRead: () => Effect.suspend(() => pause ? Effect.gen(function* () {
      pending++
      yield* Deferred.succeed(entered, undefined)
      yield* Effect.never
    }).pipe(Effect.ensuring(Effect.sync(() => { pending--; cancelled++ }))) : Effect.void),
  }).pipe(Layer.provideMerge(historyDatabase))
  await Effect.runPromise(Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    const sessionID = SessionSchema.ID.make("ses_repeated_pending_replay")
    for (let index = 0; index < 9; index++)
      yield* events.publish(SessionEvent.Renamed, { sessionID, title: `${index}:` + "x".repeat(65536) })
    for (let round = 0; round < 16; round++) {
      entered = yield* Deferred.make<void>()
      const after = round % 8
      const reader = yield* events.log({ aggregateID: sessionID, after, follow: true }).pipe(
        Stream.runDrain, Effect.forkScoped({ startImmediately: true }),
      )
      yield* Deferred.await(entered)
      expect(pending).toBe(1)
      yield* Fiber.interrupt(reader)
      expect(pending).toBe(0)
      expect(cancelled).toBe(round + 1)
      pause = false
      const replacement = yield* events.log({ aggregateID: sessionID, after }).pipe(Stream.take(1), Stream.runCollect)
      expect(replacement.map((event) => EventRuntime.isSynced(event) ? event.type : Number(event.durable?.seq))).toEqual([after + 1])
      pause = true
    }
  }).pipe(Effect.provide(layer), Effect.scoped, Effect.timeout("5 seconds")))
})

test("repeated stalled replay cancellation stops page pulls and preserves the next durable event", async () => {
  let reads = 0
  const layer = EventRuntime.layerWith({
    logReadPageSize: 2,
    beforeAggregateRead: () => Effect.sync(() => { reads++ }),
  }).pipe(Layer.provideMerge(historyDatabase))
  await Effect.runPromise(Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    const sessionID = SessionSchema.ID.make("ses_repeated_stalled_replay")
    for (let index = 0; index < 9; index++)
      yield* events.publish(SessionEvent.Renamed, { sessionID, title: `${index}:` + "x".repeat(65536) })
    for (let round = 0; round < 16; round++) {
      const entered = yield* Deferred.make<void>()
      const after = round % 7
      const delivered: number[] = []
      const before = reads
      const reader = yield* events.log({ aggregateID: sessionID, after, follow: true }).pipe(
        Stream.runForEach((event) => Effect.gen(function* () {
          if (EventRuntime.isSynced(event)) return
          if (!event.durable) throw new Error("Expected a durable replay event")
          delivered.push(event.durable.seq)
          yield* Deferred.succeed(entered, undefined)
          yield* Effect.never
        })),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* Deferred.await(entered)
      expect(reads).toBe(before + 1)
      expect(delivered).toEqual([after + 1])
      yield* Fiber.interrupt(reader)
      expect(reads).toBe(before + 1)
      const replacement = yield* events.log({ aggregateID: sessionID, after: after + 1 }).pipe(
        Stream.take(1), Stream.runCollect,
      )
      expect(replacement.map((event) => EventRuntime.isSynced(event) ? event.type : Number(event.durable?.seq))).toEqual([after + 2])
      expect(reads).toBe(before + 2)
    }
  }).pipe(Effect.provide(layer), Effect.scoped, Effect.timeout("5 seconds")))
})
