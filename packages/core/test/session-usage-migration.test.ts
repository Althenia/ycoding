import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "@ycoding-ai/core/database/migration"
import sessionUsage from "../src/database/migration/20260803011247_session-usage"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

test("backfills model usage aggregates from existing provider requests", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* makeDb
      const defaultModel = JSON.stringify({ providerID: "openai", id: "gpt-5.6" })
      const highModel = JSON.stringify({ providerID: "openai", id: "gpt-5.6", variant: "high" })

      yield* db.run(sql.raw("CREATE TABLE session (id TEXT PRIMARY KEY)"))
      yield* db.run(
        sql.raw(
          "CREATE TABLE session_provider_request (session_id TEXT NOT NULL, model TEXT NOT NULL, source TEXT NOT NULL, attempts INTEGER NOT NULL, continuation TEXT NOT NULL, cost REAL, tokens TEXT NOT NULL)",
        ),
      )
      yield* db.run(sql`
        INSERT INTO session_provider_request (session_id, model, source, attempts, continuation, cost, tokens)
        VALUES
          ('ses_usage_migration', ${defaultModel}, 'step', 2, 'full', 0.25, ${JSON.stringify({ input: 10, output: 2, reasoning: 1, cache: { read: 5, write: 1 } })}),
          ('ses_usage_migration', ${defaultModel}, 'compaction', 1, 'continued', NULL, ${JSON.stringify({ input: 5, output: 3, reasoning: 2, cache: { read: 7, write: 4 } })}),
          ('ses_usage_migration', ${highModel}, 'goal', 3, 'fallback', 1, ${JSON.stringify({ input: 4, output: 1, reasoning: 0, cache: { read: 0, write: 0 } })})
      `)

      yield* DatabaseMigration.applyOnly(db, [sessionUsage])

      expect(
        yield* db.all(sql`
          SELECT model_key, model, logical, physical, helpers, continued, fallback, cost, input, output, reasoning, cache_read, cache_write
          FROM session_usage
          ORDER BY model_key
        `),
      ).toEqual([
        {
          model_key: '["openai","gpt-5.6","high"]',
          model: highModel,
          logical: 1,
          physical: 3,
          helpers: 1,
          continued: 0,
          fallback: 1,
          cost: 1,
          input: 4,
          output: 1,
          reasoning: 0,
          cache_read: 0,
          cache_write: 0,
        },
        {
          model_key: '["openai","gpt-5.6",null]',
          model: defaultModel,
          logical: 2,
          physical: 3,
          helpers: 1,
          continued: 1,
          fallback: 0,
          cost: null,
          input: 15,
          output: 5,
          reasoning: 3,
          cache_read: 12,
          cache_write: 5,
        },
      ])
    }),
  )
})
