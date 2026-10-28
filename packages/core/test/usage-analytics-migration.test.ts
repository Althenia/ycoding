import { expect, test } from "bun:test"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "../src/database/migration"
import migration from "../src/database/migration/20261015122915_usage-analytics"
import unpricedIndex from "../src/database/migration/20261017230123_usage-analytics-unpriced-index"
import metricsIndex from "../src/database/migration/20261017232507_usage-analytics-metrics-index"
import { sqliteLayer } from "../src/database/sqlite.bun"
import { Sqlite } from "../src/database/sqlite"
import { SessionUsageRead } from "../src/session/usage-read"
import { UsageStage } from "../src/usage-stage"

test(
  "the additive migration backfills equal analytics measures and current ancestry through bounded Session-indexed slices",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const native = (yield* Sqlite.Native) as import("bun:sqlite").Database
        const queries: { sql: string; params: unknown[] }[] = []
        const db = yield* EffectDrizzleSqlite.make().pipe(
          Effect.provideService(EffectDrizzleSqlite.EffectLogger, {
            logQuery: (sql, params) =>
              Effect.sync(() => {
                queries.push({ sql, params })
              }),
          }),
          Effect.provide(EffectDrizzleSqlite.DefaultServices),
        )
        yield* DatabaseMigration.apply(db)
        yield* db.run(
          "INSERT INTO project (id,worktree,sandboxes,time_created,time_updated) VALUES ('global','/backfill','[]',0,0)",
        )
        yield* db.run(
          "INSERT INTO session (id,project_id,directory,title,time_created,time_updated) VALUES ('ses_backfill_root','global','/backfill','Root',0,0)",
        )
        yield* db.run(
          "INSERT INTO session (id,project_id,directory,parent_id,title,time_created,time_updated) VALUES ('ses_backfill_child','global','/backfill/child','ses_backfill_root','Child',0,0)",
        )
        yield* db.run(`INSERT INTO session_task
      (session_id,parent_id,parent_assistant_message_id,tool_call_id,input_id,description,agent,model,prompt_digest,background,delivery,state,time_created,time_updated)
      VALUES ('ses_backfill_child','ses_backfill_root','msg_parent','call','msg_child','Child','build','{"providerID":"p","id":"m"}','digest',1,'steer','completed',0,0)`)
        yield* db.run(`WITH RECURSIVE n(value) AS (SELECT 0 UNION ALL SELECT value + 1 FROM n WHERE value < 10004)
      INSERT INTO session_provider_request
        (id,session_id,source,agent,model,route_id,prompt_cache_key,system_digest,tool_digest,request,attempts,invalidation,continuation,cost,tokens,timing,time_created)
      SELECT printf('prq_backfill_%09d',value),'ses_backfill_child','step','build','{"providerID":"p","id":"m"}',
        'route','namespace-long','system','tools',value+1,1,'first-request','full',1,
        '{"input":1,"output":2,"reasoning":3,"cache":{"read":4,"write":5}}','{"estimatedTokens":999999,"estimatedGenerationDurationNs":1000000000}',0 FROM n`)
        const before = yield* db.get<{
          logical: number
          physical: number
          cost: number
          input: number
          output: number
        }>(sql`
      SELECT count(*) AS logical, sum(attempts) AS physical, sum(cost) AS cost,
        sum(json_extract(tokens, '$.input')) AS input, sum(json_extract(tokens, '$.output')) AS output FROM session_provider_request
    `)
        yield* db.run("DROP TABLE usage_analytics_request")
        yield* db.run("ALTER TABLE session DROP COLUMN usage_pruned_through")
        for (const table of ["session_provider_request", "session_task", "session_compaction_job"])
          yield* db.run(sql.raw(`ALTER TABLE ${table} DROP COLUMN usage_anchor`))
        queries.length = 0
        yield* db.transaction(migration.up)
        expect(yield* db.get(sql`SELECT usage_pruned_through FROM session WHERE id = 'ses_backfill_root'`)).toEqual({
          usage_pruned_through: null,
        })
        const population: number[] = []
        for (const query of queries.filter((query) => query.sql.includes("FROM session_provider_request"))) {
          expect(query.sql).toContain("session_provider_request_session_request_idx")
          const start = query.sql.indexOf("FROM session_provider_request")
          const source = query.sql.slice(start).replace(/ON CONFLICT[\s\S]*$/i, "")
          const offset = (query.sql.slice(0, start).match(/\?/g) ?? []).length
          const params = query.params.slice(
            offset,
            offset + (source.match(/\?/g) ?? []).length,
          ) as import("bun:sqlite").SQLQueryBindings[]
          const row = native.query(`SELECT count(*) AS count FROM (SELECT 1 ${source})`).get(...params) as {
            count: number
          }
          population.push(row.count)
        }
        expect(population.length).toBeGreaterThan(2)
        expect(Math.max(...population)).toBe(10_000)
        yield* db.transaction(unpricedIndex.up)
        yield* db.transaction(metricsIndex.up)
        yield* UsageStage.backfill(db)
        queries.length = 0
        const report = yield* SessionUsageRead.report(db, {
          where: sql`1`,
          group: "model",
          plan: { pieces: SessionUsageRead.pieces({}), offsets: [] },
          order: sql`key ASC`,
          offset: 0,
          limit: 100,
          corrections: {},
        })
        expect(report.total).toMatchObject(before!)
        expect(report.rows).toHaveLength(1)
        expect(report.rows[0]!.speed).toBeUndefined()
        expect(queries.some((query) => query.sql.includes("FROM session_provider_request"))).toBe(false)
        expect(
          yield* db.get<{ path: string; anchor: string | null; namespace: string }>(sql`
      SELECT task_path AS path, usage_anchor AS anchor, prompt_cache_key AS namespace FROM usage_analytics_request ORDER BY id LIMIT 1
    `),
        ).toEqual({ path: '["ses_backfill_child"]', anchor: null, namespace: "namespac" })
        expect(yield* db.all(sql`PRAGMA foreign_key_list('usage_analytics_request')`)).toEqual([])
        for (const table of ["session_provider_request", "session_task", "session_compaction_job"]) {
          const columns = yield* db.all<{ name: string; type: string; notnull: number }>(
            sql.raw(`PRAGMA table_info('${table}')`),
          )
          expect(columns.find((column) => column.name === "usage_anchor")).toMatchObject({ type: "TEXT", notnull: 0 })
        }
      }).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" })), Effect.scoped),
    ),
  30_000,
)
