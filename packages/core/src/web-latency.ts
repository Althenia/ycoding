export * as WebLatency from "./web-latency"

import { and, desc, gte, lt } from "drizzle-orm"
import { Clock, Effect, Schema } from "effect"
import { Telemetry } from "@ycoding-ai/schema/telemetry"
import type { Database } from "./database/database"
import { WebLatencyTable } from "./web-latency/sql"
import { TelemetryConsent } from "./telemetry-consent"

type Db = Database.Interface["db"]
const retentionMs = 30 * 24 * 60 * 60 * 1_000
const maxRows = 10_000

export class InvalidCursorError extends Schema.TaggedErrorClass<InvalidCursorError>()(
  "WebLatency.InvalidCursorError",
  {},
) {}

export const prune = Effect.fn("WebLatency.prune")(function* (db: Db) {
  const receivedAt = yield* Clock.currentTimeMillis
  yield* db
    .delete(WebLatencyTable)
    .where(lt(WebLatencyTable.received_at, receivedAt - retentionMs))
    .run()
    .pipe(Effect.orDie)
})

export const append = Effect.fn("WebLatency.append")(function* (db: Db, samples: readonly Telemetry.Sample[]) {
  const receivedAt = yield* Clock.currentTimeMillis
  yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        const consent = yield* TelemetryConsent.make(tx)
        if (!(yield* consent.enabled())) return yield* new Telemetry.TelemetryDisabled()
        yield* tx
          .delete(WebLatencyTable)
          .where(lt(WebLatencyTable.received_at, receivedAt - retentionMs))
          .run()
        yield* tx
          .insert(WebLatencyTable)
          .values(samples.map((sample) => ({ received_at: receivedAt, sample })))
          .run()
        const oldestRetained = yield* tx
          .select({ id: WebLatencyTable.id })
          .from(WebLatencyTable)
          .orderBy(desc(WebLatencyTable.id))
          .limit(1)
          .offset(maxRows - 1)
          .get()
        if (oldestRetained) yield* tx.delete(WebLatencyTable).where(lt(WebLatencyTable.id, oldestRetained.id)).run()
      }),
    )
    .pipe(Effect.catchTag("SqlError", Effect.die), Effect.catchTag("EffectDrizzleQueryError", Effect.die))
  return { accepted: samples.length }
})

export const list = Effect.fn("WebLatency.list")(function* (
  db: Db,
  input: { readonly limit?: number; readonly before?: string },
) {
  const before = input.before === undefined ? undefined : parseCursor(input.before)
  if (input.before !== undefined && before === undefined) return yield* new InvalidCursorError()
  yield* prune(db)
  const receivedAt = yield* Clock.currentTimeMillis
  const limit = input.limit ?? 60
  const rows = yield* db
    .select()
    .from(WebLatencyTable)
    .where(
      and(
        gte(WebLatencyTable.received_at, receivedAt - retentionMs),
        before === undefined ? undefined : lt(WebLatencyTable.id, before),
      ),
    )
    .orderBy(desc(WebLatencyTable.id))
    .limit(limit + 1)
    .all()
    .pipe(Effect.orDie)
  const retained = rows.slice(0, limit)
  return {
    data: retained.map((row) => ({
      receivedAt: row.received_at,
      sample: Schema.decodeUnknownSync(Telemetry.Sample)(row.sample),
    })),
    cursor:
      rows.length > limit && retained.length > 0
        ? { next: Buffer.from(String(retained.at(-1)!.id)).toString("base64url") }
        : {},
  }
})

function parseCursor(value: string) {
  const decoded = Buffer.from(value, "base64url").toString("utf8")
  const id = Number(decoded)
  return /^[1-9]\d*$/.test(decoded) && Number.isSafeInteger(id) && Buffer.from(decoded).toString("base64url") === value
    ? id
    : undefined
}
