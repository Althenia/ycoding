import { expect } from "bun:test"
import { DateTime, Effect, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../src/database/database"
import { EventRuntime } from "../src/event"
import { Session } from "../src/session"
import { SessionStore } from "../src/session/store"
import { AbsolutePath } from "../src/schema"
import { reviewLayer } from "./fixture/review"
import { testEffect } from "./lib/effect"
import { SessionEvent } from "../src/session/event"
import { EventTable } from "../src/event/sql"
import { SessionHistoryPruning } from "../src/session/history-pruning"

const it = testEffect(reviewLayer())

it.live("root access survives service reconstruction and children inherit without write authority", () => Effect.gen(function* () {
  const { DotsAccess } = yield* Effect.promise(() => import("../src/dots/access"))
  const sessions = yield* Session.Service
  const db = yield* Database.Service
  const events = yield* EventRuntime.Service
  const root = yield* sessions.create({ location: { directory: AbsolutePath.make(process.cwd()) } })
  const child = yield* sessions.create({ parentID: root.id })
  const store = yield* SessionStore.Service
  const access = DotsAccess.make({ db, events, sessions: store, configured: () => Effect.succeed(true) })
  expect(yield* access.get(root.id)).toEqual({ sessionID: root.id, rootSessionID: root.id, enabled: false, revision: 0, inherited: false, configured: true })
  expect(yield* access.get(child.id)).toEqual({ sessionID: child.id, rootSessionID: root.id, enabled: false, revision: 0, inherited: true, configured: true })
  expect((yield* access.set({ sessionID: child.id, enabled: true, expectedRevision: 0 }).pipe(Effect.exit))._tag).toBe("Failure")
  expect((yield* access.set({ sessionID: root.id, enabled: true, expectedRevision: 0 })).revision).toBe(1)
  expect((yield* access.set({ sessionID: root.id, enabled: true, expectedRevision: 1 })).revision).toBe(1)
  const reconstructed = DotsAccess.make({ db, events, sessions: store, configured: () => Effect.succeed(false) })
  expect(yield* reconstructed.get(child.id)).toEqual({ sessionID: child.id, rootSessionID: root.id, enabled: true, revision: 1, inherited: true, configured: false })
  expect((yield* reconstructed.set({ sessionID: root.id, enabled: false, expectedRevision: 0 }).pipe(Effect.exit))._tag).toBe("Failure")
  const log = yield* events.log({ aggregateID: root.id, follow: false }).pipe(Stream.runCollect)
  expect(Array.from(log).filter((event) => event.type === SessionEvent.DotsAccessChanged.type)).toHaveLength(1)
  const fork = yield* sessions.fork({ sessionID: root.id })
  expect((yield* reconstructed.get(fork.id)).enabled).toBe(false)
  yield* sessions.archive(root.id)
  expect((yield* access.get(root.id).pipe(Effect.exit))._tag).toBe("Failure")
  expect((yield* access.get(child.id).pipe(Effect.exit))._tag).toBe("Failure")
}))

it.live("deleted, missing, and remotely owned Sessions have no local access authority", () => Effect.gen(function* () {
  const { DotsAccess } = yield* Effect.promise(() => import("../src/dots/access"))
  const sessions = yield* Session.Service
  const db = yield* Database.Service
  const events = yield* EventRuntime.Service
  const root = yield* sessions.create({ location: { directory: AbsolutePath.make(process.cwd()) } })
  const access = DotsAccess.make({ db, events, sessions: yield* SessionStore.Service, configured: () => Effect.succeed(true) })
  yield* events.claim(root.id, "remote-owner")
  expect((yield* access.get(root.id).pipe(Effect.exit))._tag).toBe("Failure")
  const local = yield* sessions.create({ location: root.location })
  yield* sessions.remove(local.id)
  expect((yield* access.get(local.id).pipe(Effect.exit))._tag).toBe("Failure")
  expect((yield* access.get(Session.ID.make("ses_missing")).pipe(Effect.exit))._tag).toBe("Failure")
}))

it.live("concurrent access changes admit exactly one matching revision", () => Effect.gen(function* () {
  const { DotsAccess } = yield* Effect.promise(() => import("../src/dots/access"))
  const sessions = yield* Session.Service
  const db = yield* Database.Service
  const events = yield* EventRuntime.Service
  const root = yield* sessions.create({ location: { directory: AbsolutePath.make(process.cwd()) } })
  const store = yield* SessionStore.Service
  const access = DotsAccess.make({ db, events, sessions: store, configured: () => Effect.succeed(true) })
  const concurrent = DotsAccess.make({ db, events, sessions: store, configured: () => Effect.succeed(true) })
  const results = yield* Effect.all([
    concurrent.set({ sessionID: root.id, enabled: true, expectedRevision: 0 }).pipe(Effect.exit),
    access.set({ sessionID: root.id, enabled: true, expectedRevision: 0 }).pipe(Effect.exit),
  ], { concurrency: "unbounded" })
  expect(results.map((result) => result._tag).sort()).toEqual(["Failure", "Success"])
  expect((yield* access.get(root.id)).revision).toBe(1)
}))

it.live("replayed access remains readable after settled history pruning", () => Effect.gen(function* () {
  const { DotsAccess } = yield* Effect.promise(() => import("../src/dots/access"))
  const sessions = yield* Session.Service
  const database = yield* Database.Service
  const events = yield* EventRuntime.Service
  const root = yield* sessions.create({ location: { directory: AbsolutePath.make(process.cwd()) } })
  const sequence = (yield* events.sequences([root.id])).get(root.id)!
  yield* events.replay({ id: EventRuntime.ID.create(), created: DateTime.makeUnsafe(0),
    type: EventRuntime.versionedType(SessionEvent.DotsAccessChanged.type, 1), aggregateID: root.id,
    seq: sequence + 1, data: { sessionID: root.id, enabled: true, revision: 1 } })
  yield* events.publish(SessionEvent.Execution.Succeeded, { sessionID: root.id })
  yield* database.db.update(EventTable).set({ created: 0 }).where(eq(EventTable.aggregate_id, root.id)).run()
  yield* SessionHistoryPruning.make(database.db, Effect.succeed(new Set<Session.ID>())).prune(root.id)
  const access = DotsAccess.make({ db: database, events, sessions: yield* SessionStore.Service, configured: () => Effect.succeed(true) })
  expect((yield* access.get(root.id)).enabled).toBe(true)
  expect((yield* access.get(root.id)).revision).toBe(1)
}))
