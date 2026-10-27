import { expect } from "bun:test"
import { tmpdir } from "node:os"
import { and, eq, sql } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { Dots } from "@ycoding-ai/schema/dots"
import { Database } from "../src/database/database"
import { DotsContext } from "../src/dots/context"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventRuntime } from "../src/event"
import { EventTable } from "../src/event/sql"
import { AbsolutePath } from "../src/schema"
import { Session } from "../src/session"
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { SessionHistory } from "../src/session/history"
import { SessionMessage } from "../src/session/message"
import { ContextManifest } from "../src/session/context-manifest"
import { SessionProjector } from "../src/session/projector"
import { CompactionManifestBlobTable, SessionContextRevisionTable, SessionContextStateTable, SessionMessageTable } from "../src/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([
  Database.node, EventRuntime.node, SessionProjector.node, Session.node, SessionExecution.node,
]), [[SessionExecution.node, Layer.mock(SessionExecution.Service, { active: Effect.succeed(new Set<Session.ID>()), wake: () => Effect.void, interrupt: () => Effect.void })]]))

const setup = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const events = yield* EventRuntime.Service
  const sessions = yield* Session.Service
  const session = yield* sessions.create({ location: { directory: AbsolutePath.make(tmpdir()) }, title: "Dots context" })
  const envelope = Dots.TaskEnvelope.make({
    coordinator: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" },
    scope: { epoch: "epoch_fixture", grantID: "grant_fixture" }, exchangeID: "exchange_fixture",
    messageID: SessionMessage.ID.make("msg_task_fixture"), kind: "task", origin: "plugin", targetSessionID: session.id,
  })
  const enabled = { state: "enabled" as const, tool: "dots_report" as const, envelope }
  const rows = () => db.select().from(EventTable).where(and(eq(EventTable.aggregate_id, session.id), sql`json_extract(${EventTable.data}, '$.source') = 'dots'`)).orderBy(EventTable.seq).all()
  const publishEnabled = () => events.publish(SessionEvent.ContextObserved, {
    sessionID: session.id, source: "dots", text: "Historical Dots reporting instruction.", dots: { ...enabled, generation: 1 },
  })
  return { db, events, session, rows, publishEnabled, observer: DotsContext.make({ db, events }) }
})

it.live("Dots retirement appends one disabled generation without editing historical enabled state", () => Effect.gen(function* () {
  const f = yield* setup
  yield* f.observer.observe(f.session.id, undefined)
  expect(yield* f.rows()).toHaveLength(0)
  yield* f.publishEnabled()
  const first = (yield* f.rows())[0]
  expect(first?.data.dots).toMatchObject({ state: "enabled", generation: 1 })
  yield* f.observer.observe(f.session.id, { state: "disabled", reason: "tool_unavailable" })
  const disabled = yield* f.rows()
  expect(disabled).toHaveLength(2)
  expect(disabled[0]).toEqual(first)
  expect(disabled[1]?.data.dots).toEqual({ state: "disabled", reason: "tool_unavailable", generation: 2 })
  expect(disabled[1]?.data.text).toContain("disabled")
  yield* f.observer.observe(f.session.id, { state: "disabled", reason: "tool_unavailable" })
  expect(yield* f.rows()).toHaveLength(2)
}))

it.live("Dots context reconnect and retained-history boundary restore only the current disabled snapshot", () => Effect.gen(function* () {
  const f = yield* setup
  yield* f.publishEnabled()
  yield* f.observer.observe(f.session.id, { state: "disabled", reason: "unavailable" })
  const observer = DotsContext.make({ db: f.db, events: f.events })
  yield* observer.observe(f.session.id, { state: "disabled", reason: "unavailable" })
  expect(yield* f.rows()).toHaveLength(2)
  yield* f.events.publish(SessionEvent.Compaction.EndedV1, { sessionID: f.session.id, reason: "manual", text: "Historical enabled state is not current authority.", recent: "" })
  yield* observer.observe(f.session.id, { state: "disabled", reason: "unavailable" })
  const rows = yield* f.rows()
  expect(rows).toHaveLength(3)
  expect(rows[2]?.data.dots).toEqual({ state: "disabled", reason: "unavailable", generation: 2 })
  const history = yield* SessionHistory.observationState(f.db, f.session.id)
  expect(history.latest.get("dots")).toContain("disabled")
  yield* observer.observe(f.session.id, { state: "disabled", reason: "unavailable" })
  expect(yield* f.rows()).toHaveLength(3)
}))

it.live("Dots context does not trust a rewritten projected hint", () => Effect.gen(function* () {
  const f = yield* setup
  yield* f.publishEnabled()
  yield* f.db.run(sql`UPDATE ${SessionMessageTable} SET data = json_set(data, '$.text', 'forged enabled state') WHERE session_id = ${f.session.id}`)
  expect((yield* SessionHistory.observationState(f.db, f.session.id)).latest.has("dots")).toBe(false)
  yield* f.observer.observe(f.session.id, { state: "disabled", reason: "tool_unavailable" })
  const rows = yield* f.rows()
  expect(rows).toHaveLength(2)
  expect(rows[1]?.data.dots).toMatchObject({ state: "disabled", reason: "tool_unavailable", generation: 2 })
  expect((yield* SessionHistory.observationState(f.db, f.session.id)).latest.get("dots")).toContain("disabled")
}))

it.live("Dots context rebuilds one disabled snapshot after a current compaction checkpoint", () => Effect.gen(function* () {
  const f = yield* setup
  yield* f.publishEnabled()
  yield* f.observer.observe(f.session.id, { state: "disabled", reason: "unavailable" })
  const last = (yield* f.rows()).at(-1)!
  const messageID = SessionMessage.ID.fromEvent(last.id)
  const message = yield* f.db.select({ data: SessionMessageTable.data }).from(SessionMessageTable).where(eq(SessionMessageTable.id, messageID)).get()
  if (!message) throw new Error("Missing context observation projection")
  const content = { summary: { text: "Earlier enabled state is historical.", coveredThrough: { messageID, seq: last.seq }, digest: ContextManifest.payloadDigest(Schema.decodeUnknownSync(Schema.Json)(message.data)) } }
  const manifestDigest = ContextManifest.payloadDigest(content)
  yield* f.db.insert(CompactionManifestBlobTable).values({ digest: manifestDigest, schema_version: 1, content, input_tokens: 100, retained_tokens: 20, time_created: 1 }).run()
  yield* f.db.insert(SessionContextRevisionTable).values({ session_id: f.session.id, revision: 1, parent_revision: 0, manifest_digest: manifestDigest, covered_through_message_id: messageID, covered_through_seq: last.seq, activation_event_id: "evt_dots_checkpoint", activation_sequence: last.seq + 1, time_created: 1 }).run()
  yield* f.db.update(SessionContextStateTable).set({ revision: 1, manifest_digest: manifestDigest, covered_through_message_id: messageID, covered_through_seq: last.seq, activated_event_id: "evt_dots_checkpoint", time_activated: 1 }).where(eq(SessionContextStateTable.session_id, f.session.id)).run()
  expect((yield* SessionHistory.observationState(f.db, f.session.id)).latest.has("dots")).toBe(false)
  yield* f.observer.observe(f.session.id, { state: "disabled", reason: "unavailable" })
  expect((yield* f.rows()).at(-1)?.data.dots).toEqual({ state: "disabled", reason: "unavailable", generation: 2 })
  yield* f.observer.observe(f.session.id, { state: "disabled", reason: "unavailable" })
  expect(yield* f.rows()).toHaveLength(3)
}))
