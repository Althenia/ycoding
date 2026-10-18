import { expect, test } from "bun:test"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "../src/database/migration"
import { Sqlite } from "../src/database/sqlite"
import { sqliteLayer } from "../src/database/sqlite.bun"
import { SessionUsageRead } from "../src/session/usage-read"

type Shape = { kind: "partial" | "sample"; plan: string[]; functions: string[] }

test("global stage and sample reads are served from the covering metrics index with no JSON function calls", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const native = (yield* Sqlite.Native) as import("bun:sqlite").Database
      const shapes: Shape[] = []
      const db = yield* EffectDrizzleSqlite.make().pipe(
        Effect.provideService(EffectDrizzleSqlite.EffectLogger, {
          logQuery: (query, params) =>
            Effect.sync(() => {
              if (!/^\s*INSERT INTO temp\.usage_(partial|sample)/.test(query)) return
              const all = (text: string) => {
                const statement = native.prepare(text)
                const rows = statement.all(...(params as import("bun:sqlite").SQLQueryBindings[])) as Record<string, unknown>[]
                statement.finalize()
                return rows
              }
              shapes.push({
                kind: query.includes("usage_sample") ? "sample" : "partial",
                plan: all(`EXPLAIN QUERY PLAN ${query}`).map((row) => String(row.detail)),
                functions: all(`EXPLAIN ${query}`)
                  .filter((row) => /Func/.test(String(row.opcode)))
                  .map((row) => String(row.p4)),
              })
            }),
        }),
        Effect.provide(EffectDrizzleSqlite.DefaultServices),
      )
      yield* DatabaseMigration.apply(db)
      yield* db.run(
        `INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('global', '/index', '[]', 0, 0)`,
      )
      yield* db.run(sql`
        WITH RECURSIVE n(value) AS (SELECT 0 UNION ALL SELECT value + 1 FROM n WHERE value < 200)
        INSERT INTO usage_analytics_request
          (id, session_id, project_id, directory, session_updated, agent, source, model, task_path, request, attempts,
            continuation, invalidation, prompt_cache_key, tokens, cost, timing, time_created)
        SELECT printf('prq_%05d', value), printf('ses_%d', value % 7), 'global', '/index', 5, 'build', 'step',
          '{"providerID":"p","id":"m"}', '[]', value + 1, 1, 'full', 'first-request', 'cache',
          '{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}', 0.5,
          '{"firstOutputMs":5,"totalMs":9,"generatedTokens":3,"generationDurationNs":1000000000}', value
        FROM n
      `)
      for (const group of ["model", "day"] as const)
        yield* SessionUsageRead.report(db, {
          where: sql`1`,
          group,
          from: 0,
          to: 1_000,
          order: sql`key ASC`,
          offset: 0,
          limit: 100,
          corrections: {},
        })
      expect(shapes.map((shape) => shape.kind)).toEqual(["partial", "sample", "partial", "sample"])
      for (const shape of shapes)
        expect(shape.plan.some((row) => row.includes("COVERING INDEX usage_analytics_request_metrics_idx"))).toBe(true)
      for (const shape of shapes.slice(0, 2)) expect(shape.functions).toEqual([])
      for (const shape of shapes.slice(2)) expect(shape.functions).toEqual(["strftime(-1)"])
    }).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" })), Effect.scoped),
  ))
