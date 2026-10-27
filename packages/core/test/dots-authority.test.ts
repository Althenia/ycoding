import { expect } from "bun:test"
import { Effect } from "effect"
import { Session } from "@ycoding-ai/schema/session"
import { SessionEvent } from "@ycoding-ai/schema/session-event"
import { DotsAuthority } from "../src/dots/authority"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventRuntime } from "../src/event"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventRuntime.node])))
const target = { profile: "synthetic", dotID: "dot", threadID: "thread", generation: "1", label: "Synthetic Dot" }

it.live("binding identity survives store reconstruction and renaming but not generation replacement or unbind", () => Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const events = yield* EventRuntime.Service
  const first = DotsAuthority.make({ db, events })
  const sessionID = Session.ID.make("ses_binding")
  const saved = yield* first.bind(sessionID, target, "a".repeat(64))
  const restarted = DotsAuthority.make({ db, events })
  expect(yield* restarted.binding(sessionID)).toEqual(saved)
  expect((yield* restarted.bind(sessionID, { ...target, label: "Renamed" }, saved.accountDigest)).id).toBe(saved.id)
  const next = yield* restarted.bind(sessionID, { ...target, generation: "2" }, saved.accountDigest)
  expect(next.id).not.toBe(saved.id)
  yield* first.unbind(sessionID, saved.id)
  expect(yield* restarted.binding(sessionID)).toEqual(next)
  yield* first.unbind(sessionID, next.id)
  expect(yield* restarted.binding(sessionID)).toBeUndefined()
  expect((yield* restarted.bind(sessionID, { ...target, generation: "2" }, saved.accountDigest)).id).not.toBe(next.id)
}))

it.live("persisted thread ownership excludes another anchor and clearing prevents resurrection", () => Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const events = yield* EventRuntime.Service
  const store = DotsAuthority.make({ db, events })
  const sessionID = Session.ID.make("ses_owner")
  const first = yield* store.bind(sessionID, target, "a".repeat(64))
  expect((yield* DotsAuthority.make({ db, events }).bind(Session.ID.make("ses_other"), target, first.accountDigest).pipe(Effect.exit))._tag).toBe("Failure")
  yield* store.clear()
  expect(yield* DotsAuthority.make({ db, events }).binding(sessionID)).toBeUndefined()
  expect((yield* store.bind(Session.ID.make("ses_other"), target, first.accountDigest)).id).not.toBe(first.id)
}))

it.live("deleting the owning Session releases durable conversation ownership without reviving its binding", () => Effect.gen(function* () {
  const events = yield* EventRuntime.Service
  const store = DotsAuthority.make({ db: (yield* Database.Service).db, events })
  const sessionID = Session.ID.make("ses_deleted_owner")
  const first = yield* store.bind(sessionID, target, "a".repeat(64))
  yield* events.publish(SessionEvent.Deleted, { sessionID })
  expect(yield* store.binding(sessionID)).toBeUndefined()
  expect((yield* store.bind(Session.ID.make("ses_new_owner"), target, first.accountDigest)).id).not.toBe(first.id)
}))
