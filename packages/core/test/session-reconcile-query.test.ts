import { expect, test } from "bun:test"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { sqliteLayer } from "../src/database/sqlite.bun"
import { EventRuntime } from "../src/event"
import { SessionInterruptedExecution } from "../src/session/execution/interrupted"

test("startup execution reconciliation probes lifecycle indexes without scanning the event history", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const queries: { query: string; params: unknown[] }[] = []
      const db = yield* EffectDrizzleSqlite.make().pipe(
        Effect.provideService(EffectDrizzleSqlite.EffectLogger, {
          logQuery: (query, params) => Effect.sync(() => { queries.push({ query, params }) }),
        }),
        Effect.provide(EffectDrizzleSqlite.DefaultServices),
      )
      yield* DatabaseMigration.apply(db)
      const events = yield* EventRuntime.Service.pipe(
        Effect.provide(EventRuntime.layerWith()),
        Effect.provideService(Database.Service, { db }),
      )
      queries.length = 0
      yield* SessionInterruptedExecution.reconcile(db, events)
      const query = queries.find((entry) => entry.query.startsWith("select"))
      expect(query).toBeDefined()
      const plan = yield* db.$client.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query!.query}`, query!.params)
      expect(plan.filter((row) => /\bSCAN event\b/.test(row.detail))).toEqual([])
      expect(plan.some((row) => /SEARCH event USING COVERING INDEX event_aggregate_type_seq_idx/.test(row.detail))).toBe(true)
    }).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" })), Effect.scoped),
  ),
)
