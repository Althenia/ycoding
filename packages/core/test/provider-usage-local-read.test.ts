import { expect, test } from "bun:test"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { ProviderUsageRuntime } from "@ycoding-ai/core/provider-usage"
import { Credential } from "@ycoding-ai/core/credential"
import { Database } from "@ycoding-ai/core/database/database"
import { Sqlite } from "@ycoding-ai/core/database/sqlite"
import { sqliteLayer } from "@ycoding-ai/core/database/sqlite.bun"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { AbsolutePath } from "@ycoding-ai/schema/schema"
import { Location } from "@ycoding-ai/schema/location"
import { Provider } from "@ycoding-ai/schema/provider"
import { Context, Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { UsageAnalytics } from "../src/usage-analytics"
import { UsageStage } from "../src/usage-stage"

test("quota listing and local forecasts use reader snapshots and bounded indexed slices across timestamp ties", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-quota-local-read-"))
  const file = join(directory, "usage.db")
  const now = new Date(2027, 0, 15, 12).getTime()
  const dayStart = new Date(now).setHours(0, 0, 0, 0)
  const dayEnd = new Date(dayStart).setDate(new Date(dayStart).getDate() + 1)
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const credentials = yield* Credential.Service
        yield* database.db.run(
          "INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('global', '/forecast-here', '[]', 0, 0)",
        )
        for (const suffix of ["here", "other"])
          yield* database.db.run(sql`
        INSERT INTO session (id, project_id, directory, title, time_created, time_updated)
        VALUES (${"ses_forecast_" + suffix}, 'global', ${"/forecast-" + suffix}, 'Forecast', 0, 0)
      `)
        for (let start = 0; start < 20_005; start += 5_000)
          yield* database.db.run(sql`
        WITH RECURSIVE n(value) AS (SELECT ${start} UNION ALL SELECT value + 1 FROM n WHERE value < ${Math.min(start + 4999, 20_004)})
        INSERT INTO session_provider_request
          (id, session_id, source, agent, model, route_id, prompt_cache_key, system_digest, tool_digest,
            request, attempts, invalidation, continuation, cost, tokens, timing, time_created)
        SELECT printf('prq_forecast_%09d', value), CASE WHEN value % 2 = 0 THEN 'ses_forecast_here' ELSE 'ses_forecast_other' END,
          'step', 'build', json_object('providerID', 'anthropic', 'id', 'fixture', 'profile', CASE WHEN value % 2 = 0 THEN 'Work' ELSE 'Personal' END),
          'fixture', 'cache', 'system', 'tools', value + 1, 1, 'first-request', 'full',
          CASE WHEN value % 3 = 0 THEN NULL ELSE 1 END,
          '{"input":1,"output":2,"reasoning":3,"cache":{"read":4,"write":5}}',
          '{"estimatedTokens":999999,"estimatedGenerationDurationNs":1000000000}', ${now - 60_000}
        FROM n
      `)
        for (const [index, at] of [dayStart - 1, dayEnd].entries())
          yield* database.db.run(sql`
        INSERT INTO session_provider_request
          (id, session_id, source, agent, model, route_id, prompt_cache_key, system_digest, tool_digest,
            request, attempts, invalidation, continuation, cost, tokens, time_created)
        VALUES (${"prq_outside_" + index}, 'ses_forecast_here', 'step', 'build', '{"providerID":"anthropic","id":"fixture"}',
          'fixture', 'cache', 'system', 'tools', ${30_000 + index}, 1, 'first-request', 'full', 500,
          '{"input":999999,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}', ${at})
      `)
        yield* database.db.transaction(() => UsageAnalytics.backfill(database.db).pipe(Effect.andThen(UsageStage.backfill(database.db))))
        const context = yield* Layer.build(
          sqliteLayer({ filename: file, readonly: true, readwrite: false, create: false, disableWAL: true }),
        )
        const native = Context.get(context, Sqlite.Native) as import("bun:sqlite").Database
        const queries: { sql: string; params: unknown[] }[] = []
        let reader: Database.Interface["db"]
        reader = yield* EffectDrizzleSqlite.make().pipe(
          Effect.provideService(EffectDrizzleSqlite.EffectLogger, {
            logQuery: (query, params) =>
              Effect.gen(function* () {
                queries.push({ sql: query, params })
                if (query.includes("FROM usage_analytics_cell AS r"))
                  expect((yield* Effect.serviceOption(reader.$client.transactionService))._tag).toBe("Some")
              }),
          }),
          Effect.provide(EffectDrizzleSqlite.DefaultServices),
          Effect.provide(context),
        )
        const service = ProviderUsageRuntime.make({
          credentials,
          providers: { available: () => Effect.succeed([{ id: Provider.ID.make("anthropic") }]) },
          adapters: {},
          now: () => now,
          ...ProviderUsageRuntime.localReads(
            { ...database, reader },
            Location.Ref.make({ directory: AbsolutePath.make("/forecast-here") }),
            () => now,
          ),
        })
        const listed = yield* service.list()
        expect(listed.find((value) => value.source === "local_session")).toMatchObject({
          windows: [{ id: "today", used: 13_336 }],
          message: "Known local spend excludes unreported prices",
        })
        const backend = yield* service.forecast({ localScope: "backend" })
        expect(backend.localRates!.reduce((sum, value) => sum + value.tokensPerMinute60!, 0)).toBe((20_005 * 15) / 60)
        expect(backend.localRates!.reduce((sum, value) => sum + value.coverage.unpricedRequests, 0)).toBe(6_669)
        expect(backend.localRates!.every((value) => value.estimatedUSDPerHour === undefined)).toBe(true)
        const location = yield* service.forecast({ localScope: "location" })
        expect(location.localRates).toHaveLength(1)
        expect(location.localRates![0]).toMatchObject({ profile: "Work", tokensPerMinute60: (10_003 * 15) / 60 })
        const reads = queries.filter((query) => query.sql.includes("FROM usage_analytics_cell AS r"))
        expect(reads.length).toBeGreaterThan(3)
        const populations = reads.map((query) => {
          const start = query.sql.indexOf("FROM usage_analytics_cell AS r")
          const source = query.sql.slice(start).replace(/GROUP BY[\s\S]*$/i, "")
          const offset = (query.sql.slice(0, start).match(/\?/g) ?? []).length
          const params = query.params.slice(
            offset,
            offset + (source.match(/\?/g) ?? []).length,
          ) as import("bun:sqlite").SQLQueryBindings[]
          const plan = native.query(`EXPLAIN QUERY PLAN SELECT r.id ${source}`).all(...params) as { detail: string }[]
          expect(plan.some((row) => row.detail.includes("usage_analytics_cell_span_bucket_key_idx"))).toBe(true)
          const row = native.query(`SELECT count(*) AS population FROM (SELECT r.id ${source})`).get(...params) as {
            population: number
          }
          return row.population
        })
        expect(Math.max(...populations)).toBeLessThanOrEqual(10_000)
      }).pipe(
        Effect.provide(
          LayerNode.compile(LayerNode.group([Credential.node, Database.node]), [
            [Database.node, Database.layer({ path: file })],
          ]),
        ),
        Effect.scoped,
      ),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
