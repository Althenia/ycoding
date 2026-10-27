import { expect } from "bun:test"
import { Effect, Stream } from "effect"
import { Session } from "../src/session"
import { DotsAccess } from "../src/dots/access"
import { Database } from "../src/database/database"
import { KV } from "../src/kv"
import { SessionEvent } from "../src/session/event"
import { EventRuntime } from "../src/event"
import { AbsolutePath } from "../src/schema"
import { SessionPending } from "../src/session/pending"
import { SessionMessage } from "../src/session/message"
import { reviewLayer } from "./fixture/review"
import { testEffect } from "./lib/effect"

const it = testEffect(reviewLayer())

it.live("native creation rejects a retired connection before creating a Session", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const id = Session.ID.create()
  const request = { id, location: { directory: AbsolutePath.make(process.cwd()) }, native: { validate: () => Effect.succeed(false) } }
  expect((yield* sessions.create(request).pipe(Effect.exit))._tag).toBe("Failure")
  expect((yield* sessions.get(id).pipe(Effect.exit))._tag).toBe("Failure")
}))

it.live("native and ordinary creation leave global access unchanged and emit no family grant", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const db = yield* Database.Service
  const events = yield* EventRuntime.Service
  const access = DotsAccess.make({ db, kv: yield* KV.Service, configuration: () => Effect.succeed({ ready: true }) })
  const id = Session.ID.create()
  const request = { id, location: { directory: AbsolutePath.make(process.cwd()) }, native: { validate: () => Effect.succeed(true) } }
  const root = yield* sessions.create(request)
  expect(yield* access.get()).toEqual({ enabled: false, revision: 0 })
  yield* access.set({ enabled: true, expectedRevision: 0 })
  const local = yield* sessions.create({ location: request.location })
  yield* sessions.create({ ...request, id: local.id })
  expect(yield* access.get()).toEqual({ enabled: true, revision: 1 })
  for (const session of [root, local]) {
    const log = yield* events.log({ aggregateID: session.id, follow: false }).pipe(Stream.runCollect)
    expect(log.filter((event) => event.type === SessionEvent.DotsAccessChanged.type)).toEqual([])
  }
}))

it.live("global revocation at native admission commit preserves no new Session or pending prompt", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const db = yield* Database.Service
  const access = DotsAccess.make({ db, kv: yield* KV.Service, configuration: () => Effect.succeed({ ready: true }) })
  yield* access.set({ enabled: true, expectedRevision: 0 })
  let checks = 0
  const validate = () => Effect.gen(function* () {
    const current = yield* access.get()
    if (++checks === 1) yield* access.set({ enabled: false, expectedRevision: 1 })
    return current.enabled
  }).pipe(Effect.catchTag("DotsAccess.Error", () => Effect.succeed(false)))
  const id = Session.ID.create()
  const location = { directory: AbsolutePath.make(process.cwd()) }
  expect((yield* sessions.create({ id, location, native: { validate } }).pipe(Effect.exit))._tag).toBe("Failure")
  expect((yield* sessions.get(id).pipe(Effect.exit))._tag).toBe("Failure")
  yield* access.set({ enabled: true, expectedRevision: 2 })
  const root = yield* sessions.create({ location })
  const inputID = SessionMessage.ID.create()
  checks = 0
  const source = { kind: "dots-native" as const, profile: "synthetic", credentialID: "synthetic", accountID: "synthetic", accountGeneration: 0, environmentID: "environment", connectionID: "connection", clientID: "client", streamID: "stream", rootSessionID: root.id, accessRevision: 3, requestID: "request" }
  const promptValidate = () => Effect.gen(function* () {
    const current = yield* access.get()
    if (++checks === 1) yield* access.set({ enabled: false, expectedRevision: 3 })
    return current.enabled
  }).pipe(Effect.catchTag("DotsAccess.Error", () => Effect.succeed(false)))
  expect((yield* sessions.prompt({ sessionID: root.id, id: inputID, text: "Synthetic admission", resume: false, native: { source, validate: promptValidate } }).pipe(Effect.exit))._tag).toBe("Failure")
  expect(yield* SessionPending.find(db.db, inputID)).toBeUndefined()
  expect(yield* access.get()).toEqual({ enabled: false, revision: 4 })
}))

it.live("native creation and prompt admission recheck retirement at the event commit boundary", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const database = yield* Database.Service
  let checks = 0
  const id = Session.ID.create()
  const creation = { id, location: { directory: AbsolutePath.make(process.cwd()) }, native: { validate: () => Effect.sync(() => ++checks === 1) } }
  expect((yield* sessions.create(creation).pipe(Effect.exit))._tag).toBe("Failure")
  expect(checks).toBe(2)
  expect((yield* sessions.get(id).pipe(Effect.exit))._tag).toBe("Failure")
  const root = yield* sessions.create({ location: creation.location })
  const inputID = SessionMessage.ID.create()
  checks = 0
  const source = { kind: "dots-native" as const, profile: "synthetic", credentialID: "synthetic", accountID: "synthetic", accountGeneration: 0, environmentID: "environment", connectionID: "connection", clientID: "client", streamID: "stream", rootSessionID: root.id, accessRevision: 1, requestID: "request" }
  expect((yield* sessions.prompt({ sessionID: root.id, id: inputID, text: "Retired before commit", resume: false, native: { source, validate: () => Effect.sync(() => ++checks === 1) } }).pipe(Effect.exit))._tag).toBe("Failure")
  expect(checks).toBe(2)
  expect(yield* SessionPending.find(database.db, inputID)).toBeUndefined()
}))
