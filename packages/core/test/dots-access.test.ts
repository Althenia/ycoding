import { expect } from "bun:test"
import { DateTime, Deferred, Effect, Fiber, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../src/database/database"
import { DotsAccess } from "../src/dots/access"
import { EventRuntime } from "../src/event"
import { KV } from "../src/kv"
import { Session } from "../src/session"
import { AbsolutePath } from "../src/schema"
import { reviewLayer } from "./fixture/review"
import { testEffect } from "./lib/effect"
import { SessionEvent } from "../src/session/event"
import { EventTable } from "../src/event/sql"
import { SessionHistoryPruning } from "../src/session/history-pruning"

const it = testEffect(reviewLayer())
const setup = Effect.gen(function* () {
  const db = yield* Database.Service
  const kv = yield* KV.Service
  let ready = true
  const configuration = () => Effect.succeed({ ready, profile: "trusted" })
  const make = () => DotsAccess.make({ db, kv, configuration })
  return { db, kv, make, access: make(), unavailable: () => { ready = false } }
})

it.live("global access defaults off despite historical family grants and persists independently of Session creation", () => Effect.gen(function* () {
  const f = yield* setup
  const sessions = yield* Session.Service
  const events = yield* EventRuntime.Service
  const root = yield* sessions.create({ location: { directory: AbsolutePath.make(process.cwd()) } })
  yield* sessions.create({ parentID: root.id })
  yield* events.publish(SessionEvent.DotsAccessChanged, { sessionID: root.id, enabled: true, revision: 9 })
  expect(yield* f.access.get()).toEqual({ enabled: false, revision: 0 })
  expect(yield* f.access.set({ enabled: true, expectedRevision: 0 })).toEqual({ enabled: true, revision: 1 })
  yield* sessions.create({ location: root.location })
  yield* sessions.fork({ sessionID: root.id })
  expect(yield* f.make().get()).toEqual({ enabled: true, revision: 1 })
  const log = yield* events.log({ aggregateID: root.id, follow: false }).pipe(Stream.runCollect)
  expect(log.filter((event) => event.type === SessionEvent.DotsAccessChanged.type)).toHaveLength(1)
  f.unavailable()
  expect((yield* f.access.set({ enabled: true, expectedRevision: 1 }).pipe(Effect.exit))._tag).toBe("Failure")
  expect(yield* f.access.set({ enabled: false, expectedRevision: 1 })).toEqual({ enabled: false, revision: 2 })
  expect((yield* f.access.set({ enabled: true, expectedRevision: 2 }).pipe(Effect.exit))._tag).toBe("Failure")
  expect(yield* f.access.get()).toEqual({ enabled: false, revision: 2 })
}))

it.live("global transactional CAS admits one writer, checks stale noops and preserves unrelated KV data", () => Effect.gen(function* () {
  const f = yield* setup
  yield* f.kv.set("synthetic.unrelated", { keep: true })
  let notified = 0
  const stop = f.access.subscribe(() => { notified++ })
  expect(yield* f.access.set({ enabled: false, expectedRevision: 0 })).toEqual({ enabled: false, revision: 0 })
  expect(notified).toBe(0)
  const results = yield* Effect.all([
    f.access.set({ enabled: true, expectedRevision: 0 }).pipe(Effect.exit),
    f.make().set({ enabled: true, expectedRevision: 0 }).pipe(Effect.exit),
  ], { concurrency: "unbounded" })
  expect(results.map((result) => result._tag).sort()).toEqual(["Failure", "Success"])
  expect((yield* f.access.set({ enabled: true, expectedRevision: 0 }).pipe(Effect.flip)).code).toBe("conflict")
  expect(yield* f.access.set({ enabled: true, expectedRevision: 1 })).toEqual({ enabled: true, revision: 1 })
  expect(notified).toBeLessThanOrEqual(1)
  stop()
  expect(yield* f.kv.get("synthetic.unrelated")).toEqual({ keep: true })
}))

it.live("malformed global preference fails closed without overwriting stored data", () => Effect.gen(function* () {
  const f = yield* setup
  const malformed = { enabled: true, revision: -1 }
  yield* f.kv.set("dots.native-access", malformed)
  expect((yield* f.access.get().pipe(Effect.exit))._tag).toBe("Failure")
  expect((yield* f.access.status().pipe(Effect.flip)).code).toBe("unavailable")
  expect((yield* f.access.set({ enabled: false, expectedRevision: 0 }).pipe(Effect.exit))._tag).toBe("Failure")
  expect(yield* f.kv.get("dots.native-access")).toEqual(malformed)
}))

it.live("historical family access remains decodable after pruning without granting global access", () => Effect.gen(function* () {
  const f = yield* setup
  const sessions = yield* Session.Service
  const events = yield* EventRuntime.Service
  const root = yield* sessions.create({ location: { directory: AbsolutePath.make(process.cwd()) } })
  const sequence = (yield* events.sequences([root.id])).get(root.id)!
  yield* events.replay({ id: EventRuntime.ID.create(), created: DateTime.makeUnsafe(0),
    type: EventRuntime.versionedType(SessionEvent.DotsAccessChanged.type, 1), aggregateID: root.id,
    seq: sequence + 1, data: { sessionID: root.id, enabled: true, revision: 1 } })
  yield* events.publish(SessionEvent.Execution.Succeeded, { sessionID: root.id })
  yield* f.db.db.update(EventTable).set({ created: 0 }).where(eq(EventTable.aggregate_id, root.id)).run()
  yield* SessionHistoryPruning.make(f.db.db, Effect.succeed(new Set<Session.ID>())).prune(root.id)
  const log = yield* events.log({ aggregateID: root.id, follow: false }).pipe(Stream.runCollect)
  expect(log.filter((event) => event.type === SessionEvent.DotsAccessChanged.type)).toHaveLength(1)
  expect(yield* f.access.get()).toEqual({ enabled: false, revision: 0 })
}))

it.live("native status distinguishes configuration, global access and attached transport", () => Effect.gen(function* () {
  const f = yield* setup
  expect(yield* f.access.status()).toEqual({ access: { enabled: false, revision: 0 }, configuration: { ready: true, profile: "trusted" }, connection: { state: "unavailable" } })
  const release = f.access.attachTransport({ status: async () => ({ state: "connected", hostname: "Synthetic.local" }) })
  expect((yield* f.access.status()).connection).toEqual({ state: "off", hostname: "Synthetic.local" })
  yield* f.access.set({ enabled: true, expectedRevision: 0 })
  expect((yield* f.access.status()).connection).toEqual({ state: "connected", hostname: "Synthetic.local" })
  f.unavailable()
  expect((yield* f.access.status()).connection).toEqual({ state: "off", hostname: "Synthetic.local" })
  expect((yield* f.access.get()).enabled).toBe(true)
  release()
  expect((yield* f.access.status()).connection.state).toBe("unavailable")
}))

it.live("transport attachment rejects replacement and fences stale release and delayed status", () => Effect.gen(function* () {
  const f = yield* setup
  yield* f.access.set({ enabled: true, expectedRevision: 0 })
  const entered = yield* Deferred.make<void>()
  const result = yield* Deferred.make<DotsAccess.TransportStatus>()
  const release = f.access.attachTransport({ status: () => Effect.runPromise(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(result)))) })
  expect(() => f.access.attachTransport({ status: async () => ({ state: "off" }) })).toThrow()
  const reading = yield* f.access.status().pipe(Effect.forkChild)
  yield* Deferred.await(entered)
  release()
  const next = f.access.attachTransport({ status: async () => ({ state: "connecting" }) })
  release()
  yield* Deferred.succeed(result, { state: "connected", hostname: "Old.local" })
  expect((yield* Fiber.join(reading)).connection).toEqual({ state: "unavailable" })
  expect((yield* f.access.status()).connection).toEqual({ state: "connecting" })
  next()
}))

it.live("status discards a connected result delayed across global Off-On", () => Effect.gen(function* () {
  const f = yield* setup
  yield* f.access.set({ enabled: true, expectedRevision: 0 })
  const entered = yield* Deferred.make<void>()
  const result = yield* Deferred.make<DotsAccess.TransportStatus>()
  const release = f.access.attachTransport({ status: () => Effect.runPromise(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(result)))) })
  const reading = yield* f.access.status().pipe(Effect.forkChild)
  yield* Deferred.await(entered)
  yield* f.access.set({ enabled: false, expectedRevision: 1 })
  yield* f.access.set({ enabled: true, expectedRevision: 2 })
  yield* Deferred.succeed(result, { state: "connected", hostname: "Old.local" })
  expect((yield* Fiber.join(reading)).connection.state).not.toBe("connected")
  release()
}))

it.live("native status bounds display strings and exposes fixed error guidance rather than provider text", () => Effect.gen(function* () {
  const f = yield* setup
  const access = DotsAccess.make({ db: f.db, kv: f.kv, configuration: () => Effect.succeed({ ready: true, profile: "trusted\u001b\n" + "p".repeat(300) }) })
  yield* access.set({ enabled: true, expectedRevision: 0 })
  const release = access.attachTransport({ status: async () => ({ state: "connecting", hostname: "Synthetic\u001b\n" + "h".repeat(300), problem: "authentication", message: "synthetic private provider payload" }) })
  const status = yield* access.status()
  expect(status.configuration.profile!.length).toBeLessThanOrEqual(256)
  expect(status.connection.hostname!.length).toBeLessThanOrEqual(256)
  expect(status.connection.message).toContain("profile")
  expect(JSON.stringify(status)).not.toContain("private provider")
  expect(/[\u0000-\u001f\u007f-\u009f]/.test(status.configuration.profile! + status.connection.hostname!)).toBe(false)
  release()
}))

it.live("a failed transport status read reports a safe connection error without exposing its failure", () => Effect.gen(function* () {
  const f = yield* setup
  yield* f.access.set({ enabled: true, expectedRevision: 0 })
  const release = f.access.attachTransport({ status: async () => { throw new Error("synthetic private provider payload") } })
  const status = yield* f.access.status()
  expect(status.connection.state).toBe("error")
  expect(status.connection.message).toContain("retries automatically")
  expect(JSON.stringify(status)).not.toContain("private provider")
  release()
}))
