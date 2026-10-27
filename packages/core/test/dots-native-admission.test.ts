import { expect } from "bun:test"
import { Effect } from "effect"
import { Session } from "../src/session"
import { SessionStore } from "../src/session/store"
import { DotsAccess } from "../src/dots/access"
import { Database } from "../src/database/database"
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

it.live("native creation enables only a newly created root in the same event transaction", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const db = yield* Database.Service
  const events = yield* EventRuntime.Service
  const access = DotsAccess.make({ db, events, sessions: yield* SessionStore.Service, configured: () => Effect.succeed(true) })
  const id = Session.ID.create()
  const request = { id, location: { directory: AbsolutePath.make(process.cwd()) }, native: { validate: () => Effect.succeed(true) } }
  const root = yield* sessions.create(request)
  expect((yield* access.get(root.id)).enabled).toBe(true)
  const local = yield* sessions.create({ location: request.location })
  yield* sessions.create({ ...request, id: local.id })
  expect((yield* access.get(local.id)).enabled).toBe(false)
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
