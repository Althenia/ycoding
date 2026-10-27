import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Event } from "@ycoding-ai/schema/event"
import { SessionEvent } from "@ycoding-ai/schema/session-event"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"

const admittedType = Event.versionedType(SessionEvent.InputAdmitted.type, SessionEvent.InputAdmitted.durable.version)
const deferredType = Event.versionedType(SessionEvent.Review.Deferred.type, SessionEvent.Review.Deferred.durable.version)
const migration = () => {
  const value = migrations.find((entry) => entry.id.endsWith("_client-decision-provenance"))
  if (!value) throw new Error("Missing client decision provenance migration")
  return value
}

const fixture = Effect.gen(function* () {
  const db = yield* EffectDrizzleSqlite.makeWithDefaults()
  yield* db.run(sql`CREATE TABLE model_incident (id TEXT PRIMARY KEY, decided_by TEXT, details TEXT)`)
  yield* db.run(sql`CREATE TABLE session_message (id TEXT PRIMARY KEY, type TEXT, data TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER)`)
  yield* db.run(sql`CREATE TABLE session_pending (id TEXT PRIMARY KEY, type TEXT, data TEXT, admitted_seq INTEGER, delivery TEXT, time_created INTEGER)`)
  yield* db.run(sql`CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT, seq INTEGER, type TEXT, data TEXT, created INTEGER)`)
  yield* db.run(sql`CREATE TABLE mcp_event_outbox (seq INTEGER PRIMARY KEY, id TEXT, attention TEXT, attempts INTEGER, next_attempt_at INTEGER, delivered_at INTEGER, dead INTEGER)`)
  yield* db.run(sql`CREATE TABLE mcp_event_subscription (id TEXT PRIMARY KEY, secret_ciphertext TEXT, previous_secret_ciphertext TEXT, identity_hash TEXT, pruned_through INTEGER)`)
  for (const [index, decidedBy] of ["human", "client", "decision-model", null, "Human"].entries())
    yield* db.run(sql`INSERT INTO model_incident VALUES (${`inc_${index}`}, ${decidedBy}, 'human text')`)
  for (const [index, inputOrigin] of ["human", "direct", "plugin", "coordination", "subagent", "review", undefined, null, false, "Human"].entries()) {
    const data = { text: "human notify_human", metadata: { ...(inputOrigin === undefined ? {} : { inputOrigin }), unrelated: { inputOrigin: "human" }, requireHuman: true } }
    for (const type of ["user", "synthetic"]) {
      const id = `${type}_${index}`
      yield* db.run(sql`INSERT INTO session_message VALUES (${id}, ${type}, ${JSON.stringify(data)}, ${index}, 11, 12)`)
      yield* db.run(sql`INSERT INTO session_pending VALUES (${id}, ${type}, ${JSON.stringify(data)}, ${index}, 'queue', 13)`)
      yield* db.run(sql`INSERT INTO event VALUES (${id}, ${`ses_${index}`}, 1, ${admittedType}, ${JSON.stringify({ sessionID: `ses_${index}`, inputID: id, input: { type, data, delivery: "queue" } })}, 14)`)
    }
  }
  for (const [index, data] of ["not json", "null", "[]", '{"metadata":null}', '{"metadata":"human"}'].entries()) {
    yield* db.run(sql`INSERT INTO session_message VALUES (${`invalid_${index}`}, 'user', ${data}, 21, 11, 12)`)
    yield* db.run(sql`INSERT INTO session_pending VALUES (${`invalid_${index}`}, 'user', ${data}, 21, 'steer', 13)`)
    yield* db.run(sql`INSERT INTO event VALUES (${`invalid_${index}`}, 'ses_invalid', ${index}, ${admittedType}, ${data}, 14)`)
  }
  const permission = { type: "permission", action: "shell", resources: ["redacted"], fingerprint: "a".repeat(64), requestID: "per_retained" }
  for (const [id, type, kind, payload] of [
    ["evt_deferred_old", deferredType, "permission", permission],
    ["evt_deferred_one", deferredType, "permission", { ...permission, fingerprintVersion: 1 }],
    ["evt_deferred_two", deferredType, "permission", { ...permission, fingerprintVersion: 2 }],
    ["evt_deferred_null", deferredType, "permission", { ...permission, fingerprintVersion: null }],
    ["evt_deferred_other", deferredType, "permission", { ...permission, fingerprintVersion: 3 }],
    ["evt_deferred_wrong_kind", deferredType, "guardrail", permission],
    ["evt_deferred_wrong_type", deferredType, "permission", { ...permission, type: "guardrail" }],
    ["evt_deferred_other_event", "session.review.deferred.2", "permission", permission],
  ] as const)
    yield* db.run(sql`INSERT INTO event VALUES (${id}, ${`ses_${id}`}, 1, ${type}, ${JSON.stringify({ sessionID: `ses_${id}`, itemID: `rvw_${id}`, kind, reason: "disabled", origin: { requestID: "per_retained" }, payload })}, 14)`)
  yield* db.run(sql`INSERT INTO event VALUES ('evt_other', 'ses_other', 1, 'other.1', '{"input":{"type":"user","data":{"metadata":{"inputOrigin":"human"}}}}', 14)`)
  yield* db.run(sql`INSERT INTO event VALUES ('evt_receipt', 'ses_receipt', 1, 'session.dots.decision.settled.1', ${JSON.stringify({ target: { kind: "permission", requestID: "per_retained", fingerprint: "a".repeat(64) }, reply: "once" })}, 14)`)
  yield* db.run(sql`INSERT INTO mcp_event_outbox VALUES (9, 'evt_delivery', '{ "human_required": true, "actions": ["inspect", "notify_human"] }', 2, 30, NULL, 0)`)
  yield* db.run(sql`INSERT INTO mcp_event_subscription VALUES ('sub_retained', 'synthetic-current', 'synthetic-prior', 'synthetic-hash', 8)`)
  return db
})

const snapshot = (db: Effect.Success<typeof fixture>) => Effect.gen(function* () {
  const rows = yield* db.all<{ id: string; type: string; data: string; aggregate_id: string; seq: number; created: number }>(sql`SELECT * FROM event ORDER BY id`)
  return {
    incidents: yield* db.all<{ id: string; decided_by: string | null; details: string }>(sql`SELECT * FROM model_incident ORDER BY id`),
    messages: yield* db.all<{ id: string; type: string; data: string; seq: number; time_created: number; time_updated: number }>(sql`SELECT * FROM session_message ORDER BY id`),
    pending: yield* db.all<{ id: string; type: string; data: string; admitted_seq: number; delivery: string; time_created: number }>(sql`SELECT * FROM session_pending ORDER BY id`),
    events: rows,
    outbox: yield* db.all(sql`SELECT * FROM mcp_event_outbox`),
    subscriptions: yield* db.all(sql`SELECT * FROM mcp_event_subscription`),
  }
})

test("client provenance migration changes only exact owned paths and preserves identities, hashes, text and historical deliveries", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const db = yield* fixture
    const before = yield* snapshot(db)
    yield* DatabaseMigration.applyOnly(db, [migration()])
    const after = yield* snapshot(db)
    expect(after.incidents).toEqual(before.incidents.map((row) => ({ ...row, decided_by: row.decided_by === "human" ? "client" : row.decided_by })))
    const migratedInput = <T extends { id: string; data: string }>(row: T) => ({ ...row, data: row.id === "user_0" ? row.data.replace('"inputOrigin":"human"', '"inputOrigin":"direct"') : row.data })
    expect(after.messages).toEqual(before.messages.map(migratedInput))
    expect(after.pending).toEqual(before.pending.map(migratedInput))
    expect(after.events).toEqual(before.events.map((row) => ({ ...row, data: row.id === "user_0"
      ? row.data.replace('"inputOrigin":"human"', '"inputOrigin":"direct"')
      : row.id === "evt_deferred_old" ? JSON.stringify({ ...JSON.parse(row.data), payload: { ...JSON.parse(row.data).payload, fingerprintVersion: 1 } }) : row.data })))
    expect(after.outbox).toEqual(before.outbox)
    expect(after.subscriptions).toEqual(before.subscriptions)
    yield* DatabaseMigration.applyOnly(db, [migration()])
    expect(yield* snapshot(db)).toEqual(after)
    expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([{ id: migration().id }])
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped))
})

test("client provenance migration rolls back every conversion and its ledger entry on failure", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const db = yield* fixture
    const before = yield* snapshot(db)
    yield* db.run(sql`CREATE TRIGGER reject_conversion BEFORE UPDATE ON event WHEN OLD.id = 'evt_deferred_old' BEGIN SELECT RAISE(ABORT, 'synthetic conversion failure'); END`)
    const result = yield* DatabaseMigration.applyOnly(db, [migration()]).pipe(Effect.exit)
    expect(result._tag).toBe("Failure")
    expect(yield* snapshot(db)).toEqual(before)
    expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([])
    yield* db.run(sql`DROP TRIGGER reject_conversion`)
    yield* DatabaseMigration.applyOnly(db, [migration()])
    expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([{ id: migration().id }])
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped))
})

test("fresh databases register client provenance conversion without changing their format or current permission hashes", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const db = yield* EffectDrizzleSqlite.makeWithDefaults()
    yield* DatabaseMigration.apply(db)
    expect(yield* db.all(sql`SELECT id FROM migration WHERE id = ${migration().id}`)).toEqual([{ id: migration().id }])
    const format = yield* db.all(sql`SELECT * FROM database_format`)
    const event = { kind: "permission", payload: { type: "permission", fingerprint: "b".repeat(64), fingerprintVersion: 2 } }
    yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('ses_fresh', 1)`)
    yield* db.run(sql`INSERT INTO event (id, aggregate_id, seq, created, type, data) VALUES ('evt_fresh', 'ses_fresh', 1, 1, ${deferredType}, ${JSON.stringify(event)})`)
    yield* DatabaseMigration.apply(db)
    expect(yield* db.all(sql`SELECT * FROM database_format`)).toEqual(format)
    expect(yield* db.get(sql`SELECT data FROM event WHERE id = 'evt_fresh'`)).toEqual({ data: JSON.stringify(event) })
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped))
})
