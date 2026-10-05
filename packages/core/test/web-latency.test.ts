import { expect } from "bun:test"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { adjust } from "effect/testing/TestClock"
import { Telemetry } from "@ycoding-ai/schema/telemetry"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { WebLatency } from "@ycoding-ai/core/web-latency"
import { WebLatencyTable } from "@ycoding-ai/core/web-latency/sql"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node])))
const sample = Schema.decodeUnknownSync(Telemetry.Sample)({
  kind: "request",
  at: "2026-10-04T12:00:00.000Z",
  operation: "session.list",
  outcome: "ok",
  queueMs: 5,
  settlementMs: 20,
  totalMs: 25,
})

it.effect("stores server receipt time and pages newest samples without Session or Location identity", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    expect(yield* WebLatency.append(db, [sample, { kind: "long-task", at: sample.at, durationMs: 70 }])).toEqual({
      accepted: 2,
    })
    const rows = yield* db.select().from(WebLatencyTable).all()
    expect(rows.map((row) => row.received_at)).toEqual([0, 0])
    expect(Object.keys(rows[0].sample).sort()).toEqual(
      ["at", "kind", "operation", "outcome", "queueMs", "settlementMs", "totalMs"].sort(),
    )
    const first = yield* WebLatency.list(db, { limit: 1 })
    expect(first.data).toEqual([{ receivedAt: 0, sample: { kind: "long-task", at: sample.at, durationMs: 70 } }])
    expect(first.cursor.next).toBeString()
    expect((yield* WebLatency.list(db, { limit: 1, before: first.cursor.next })).data).toEqual([
      { receivedAt: 0, sample },
    ])
    expect(yield* Effect.flip(WebLatency.list(db, { before: "not-a-cursor" }))).toBeInstanceOf(
      WebLatency.InvalidCursorError,
    )
  }),
)

it.effect("hides and prunes samples older than seven days by server receipt time", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* WebLatency.append(db, [sample])
    yield* adjust("7 days")
    expect((yield* WebLatency.list(db, {})).data).toEqual([{ receivedAt: 0, sample }])
    yield* adjust("1 millis")
    expect((yield* WebLatency.list(db, {})).data).toEqual([])
    expect(yield* db.select().from(WebLatencyTable).all()).toEqual([])
  }),
)

it.effect("removes expired samples during housekeeping without a read request", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* WebLatency.append(db, [sample])
    yield* adjust("7 days")
    yield* adjust("1 millis")
    yield* WebLatency.prune(db)
    expect(yield* db.select().from(WebLatencyTable).all()).toEqual([])
  }),
)

it.effect("retains at most ten thousand newest samples after a batch", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    for (let offset = 0; offset < 10_000; offset += 500)
      yield* db
        .insert(WebLatencyTable)
        .values(Array.from({ length: 500 }, () => ({ received_at: 0, sample })))
        .run()
    yield* WebLatency.append(db, [sample, sample])
    expect(yield* db.select({ id: WebLatencyTable.id }).from(WebLatencyTable).all()).toHaveLength(10_000)
    expect(yield* db.select().from(WebLatencyTable).where(eq(WebLatencyTable.id, 1)).get()).toBeUndefined()
    expect((yield* WebLatency.list(db, {})).data).toHaveLength(60)
  }),
)

it.live("reads retained samples after reopening the same isolated SQLite file", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const file = path.join(tmp.path, "web-latency.db")
        yield* Effect.gen(function* () {
          const database = yield* Database.Service
          return yield* WebLatency.append(database.db, [sample])
        }).pipe(Effect.provide(Database.layerFromPath(file)), Effect.scoped)
        const next = yield* Effect.gen(function* () {
          const database = yield* Database.Service
          return yield* WebLatency.list(database.db, {})
        }).pipe(Effect.provide(Database.layerFromPath(file)), Effect.scoped)
        expect(next.data).toEqual([{ receivedAt: expect.any(Number), sample }])
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
  ),
)
