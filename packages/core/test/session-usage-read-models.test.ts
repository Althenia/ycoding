import { expect, test } from "bun:test"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Effect, Layer } from "effect"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { sqliteLayer } from "../src/database/sqlite.bun"
import { Sqlite } from "../src/database/sqlite"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { Session } from "../src/session"
import { SessionSchema } from "../src/session/schema"
import { SessionProviderRequestTable, SessionTable } from "../src/session/sql"
import { SessionExecution } from "../src/session/execution"
import { CatalogModel } from "../src/model"
import { Provider } from "../src/provider"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { Agent } from "../src/agent"
import { SessionUsageRead, timeZoneOffsets } from "../src/session/usage-read"
import { UsageAnalytics } from "../src/usage-analytics"
import { sql } from "drizzle-orm"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("global usage pages high-cardinality Session groups in SQL with exact totals and bounded results", () => {
  const queries: { sql: string; params: unknown[] }[] = []
  const database = Layer.effect(
    Database.Service,
    Effect.gen(function* () {
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
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      const rootID = SessionSchema.ID.make("ses_usage_root")
      yield* db
        .insert(SessionTable)
        .values({
          id: rootID,
          project_id: Project.ID.global,
          directory: "/project",
          title: "Root",
          permission: [{ action: "read", effect: "allow", resource: "x".repeat(256_000) }],
        })
        .run()
      const sessions = Array.from({ length: 405 }, (_, index) => ({
        id: SessionSchema.ID.make(`ses_usage_${index.toString().padStart(3, "0")}`),
        project_id: Project.ID.global,
        directory: "/project",
        title: `Session ${index}`,
        parent_id: rootID,
        permission: [
          { action: "read", effect: "allow" as const, resource: index === 0 ? "x".repeat(256_000) : "file" },
        ],
      }))
      yield* db.insert(SessionTable).values(sessions).run()
      yield* db
        .insert(SessionProviderRequestTable)
        .values(
          sessions.map((session, index) => ({
            id: ProviderRequest.ID.make(`prq_usage_${index}`),
            session_id: session.id,
            source: "step" as const,
            agent: Agent.defaultID,
            model: CatalogModel.Ref.make({
              providerID: Provider.ID.make("openai"),
              id: CatalogModel.ID.make(`model_${index.toString().padStart(3, "0")}`),
            }),
            route_id: "test",
            prompt_cache_key: "key",
            system_digest: "system",
            tool_digest: "tools",
            request: 1,
            attempts: 1,
            invalidation: "first-request" as const,
            continuation: "full" as const,
            cost: 1,
            cache_read_reported: true,
            tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            timing: {
              firstOutputMs: index,
              totalMs: index * 2,
              generatedTokens: 1,
              generationDurationNs: 1_000_000_000,
            },
            time_created: index,
          })),
        )
        .run()
      yield* db.transaction(() => UsageAnalytics.backfill(db))
      return { db }
    }),
  ).pipe(Layer.provide(sqliteLayer({ filename: ":memory:" })))
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const session = yield* Session.Service
      queries.length = 0
      const report = yield* session.usageReportAll({
        group: "session",
        sort: "steps",
        order: "desc",
        offset: 300,
        limit: 3,
      })
      expect(report).toMatchObject({
        rowCount: 405,
        nextOffset: 303,
        total: { logical: 405, physical: 405, cost: 405, tokens: { input: 405 }, cacheReadReported: true },
      })
      expect(report.rows.map((row) => row.key)).toEqual(["ses_usage_300", "ses_usage_301", "ses_usage_302"])
      expect(report.rows[0]?.speed).toEqual({
        samples: 1,
        generationSamples: 1,
        providerTimedSamples: 1,
        observedSamples: 0,
        generationP50TokensPerSecond: 1,
        generationP90TokensPerSecond: 1,
        firstOutputP50Ms: 300,
        firstOutputP95Ms: 300,
        totalP50Ms: 600,
        totalP95Ms: 600,
        outputTokensPerSecond: 1,
      })
      expect(
        queries.filter((query) =>
          /\b(?:from|join)\s+["`]?(?:session|project|session_provider_request)["`]?(?:\s|$)/i.test(query.sql),
        ),
      ).toEqual([])
      const reads = queries.filter(
        (query) =>
          /^\s*select/i.test(query.sql) &&
          /usage_analytics_request|\bfrom ["`]?session\b/i.test(query.sql) &&
          !/temp\./i.test(query.sql),
      )
      expect(reads.length).toBeGreaterThan(0)
      for (const query of reads) {
        const rows = yield* db.$client.unsafe(query.sql, query.params)
        expect(rows.length).toBeLessThanOrEqual(200)
        expect(JSON.stringify(rows).length).toBeLessThan(32_768)
      }
      expect((yield* session.usageReportAll({ group: "session", offset: 999_999, limit: 3 })).rows).toEqual([])
      queries.length = 0
      const scoped = yield* session.usageReport({
        sessionID: SessionSchema.ID.make("ses_usage_root"),
        group: "session",
        offset: 300,
        limit: 3,
      })
      expect(scoped.total.logical).toBe(405)
      expect(scoped.rowCount).toBe(405)
      expect(scoped.rows.map((row) => row.key)).toEqual(["ses_usage_300", "ses_usage_301", "ses_usage_302"])
      const familyReads = queries.filter(
        (query) => /^\s*select/i.test(query.sql) && /\bfrom ["`]?session["`]?\s/i.test(query.sql),
      )
      for (const query of familyReads) {
        const rows = yield* db.$client.unsafe(query.sql, query.params)
        expect(rows.length).toBeLessThanOrEqual(200)
        expect(JSON.stringify(rows).length).toBeLessThan(32_768)
      }
      for (const group of ["session", "model"] as const) {
        queries.length = 0
        const wide = yield* session.usageReportAll({ group, offset: 100, limit: 100 })
        expect(wide.rows).toHaveLength(100)
        expect(wide.total.logical).toBe(405)
        expect(wide.rows.filter((row) => row.speed !== undefined)).toHaveLength(100)
        const scans = queries.filter((query) => /from\s+["`]?usage_analytics_request/i.test(query.sql))
        expect(scans.length).toBeGreaterThan(0)
        expect(scans.some((query) => /recursive/i.test(query.sql))).toBe(false)
        expect(queries.some((query) => /drop table if exists temp\.usage_partial/i.test(query.sql))).toBe(true)
      }
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([Database.node, Session.node]), [
          [UsageAnalytics.node, Layer.mock(UsageAnalytics.Service, {})],
          [Database.node, database],
          [SessionExecution.node, SessionExecution.noopLayer],
        ]),
      ),
      Effect.scoped,
    ),
  )
})

test("SQL model grouping preserves encodeURIComponent keys and ordering", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      const sessionID = SessionSchema.ID.make("ses_encoded_usage")
      yield* db
        .insert(SessionTable)
        .values({ id: sessionID, project_id: Project.ID.global, directory: "/project", title: "Encoded keys" })
        .run()
      const models = ["space model", "quote'()!*", "unicode-ไทย-😀", "slash/model", "percent%model"].map((id, index) =>
        CatalogModel.Ref.make({
          providerID: Provider.ID.make("custom"),
          id: CatalogModel.ID.make(id),
          ...(index === 0 ? { variant: CatalogModel.VariantID.make("high") } : {}),
          ...(index === 1 ? { profile: "named profile" } : {}),
        }),
      )
      yield* db
        .insert(SessionProviderRequestTable)
        .values(
          models.map((model, index) => ({
            id: ProviderRequest.ID.make(`prq_encoded_${index}`),
            session_id: sessionID,
            source: "step" as const,
            agent: Agent.defaultID,
            model,
            route_id: "test",
            prompt_cache_key: "key",
            system_digest: "system",
            tool_digest: "tools",
            request: index + 1,
            attempts: 1,
            invalidation: "first-request" as const,
            continuation: "full" as const,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time_created: index === 0 ? -1 : index,
          })),
        )
        .run()
      yield* db.transaction(() => UsageAnalytics.backfill(db))
      const keys = (group: "model" | "day", timeZone?: string) =>
        SessionUsageRead.report(db, {
          where: sql`1`,
          group,
          ...(timeZone === undefined ? {} : { timeZone }),
          order: sql`key ASC`,
          offset: 0,
          limit: 100,
          corrections: {},
        }).pipe(Effect.map((page) => page.rows.map((row) => row.key)))
      expect(yield* keys("model")).toEqual(
        models
          .map((model) =>
            [model.providerID, model.id, model.variant, model.profile]
              .flatMap((part) => (part === undefined ? [] : [encodeURIComponent(part)]))
              .join("/"),
          )
          .sort(),
      )
      expect(yield* keys("day")).toEqual(["1969-12-31", "1970-01-01"])
      expect(yield* keys("day", "Asia/Kolkata")).toEqual(["1970-01-01"])
    }).pipe(Effect.provide(Database.layer({ path: ":memory:" })), Effect.scoped),
  ))

test("time-zone offsets reproduce every hourly offset across daylight-saving and calendar changes", () => {
  const first = Date.UTC(2011, 0, 1)
  const last = Date.UTC(2013, 0, 1)
  for (const timeZone of [
    "America/New_York",
    "Europe/London",
    "Australia/Lord_Howe",
    "Asia/Kolkata",
    "Pacific/Apia",
    "America/Sao_Paulo",
    "UTC",
  ]) {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    const label = (time: number) =>
      formatter
        .formatToParts(time)
        .find((part) => part.type === "timeZoneName")!
        .value.replace("GMT", "") || "+00:00"
    const offsets = timeZoneOffsets(timeZone, first, last)
    for (let time = first; time <= last; time += 3_600_000)
      expect({ timeZone, time, label: offsets.findLast((offset) => offset.start <= time)!.label }).toEqual({
        timeZone,
        time,
        label: label(time),
      })
    offsets.slice(1).forEach((offset) => expect(label(offset.start - 1)).not.toBe(label(offset.start)))
  }
  expect(timeZoneOffsets("Asia/Kolkata", first, last)).toEqual([{ start: first, label: "+05:30", seconds: 19_800 }])
})

test("unpriced analytics slices seek through the request-time index", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const plan = yield* db.all<{ detail: string }>(
        sql`EXPLAIN QUERY PLAN SELECT r.id FROM usage_analytics_request AS r INDEXED BY usage_analytics_request_time_created_id_idx
          WHERE r.cost IS NULL AND r.source <> 'decision' AND (r.time_created,r.id) > (0,${"prq_a"})
          ORDER BY r.time_created,r.id LIMIT 200`,
      )
      expect(plan.some((row) => row.detail.includes("usage_analytics_request_time_created_id_idx"))).toBe(true)
    }).pipe(Effect.provide(Database.layer({ path: ":memory:" })), Effect.scoped),
  ))

for (const fixture of [
  { requests: 100_000, ties: true },
  { requests: 1_000_000, ties: false },
])
  test(
    `bounded usage statements: ${fixture.requests} requests, timestamp ties=${fixture.ties}`,
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          let db: Database.Interface["db"]
          const populations: number[] = []
          const measured = { pricing: 0, first: 0, total: 0, generation: 0 }
          const native = (yield* Sqlite.Native) as import("bun:sqlite").Database
          const read = (query: string, params: unknown[] = []) =>
            Effect.acquireUseRelease(
              Effect.sync(() =>
                native.prepare<Record<string, unknown>, import("bun:sqlite").SQLQueryBindings[]>(query),
              ),
              (statement) => Effect.sync(() => statement.all(...(params as import("bun:sqlite").SQLQueryBindings[]))),
              (statement) => Effect.sync(() => statement.finalize()),
            )
          db = yield* EffectDrizzleSqlite.make().pipe(
            Effect.provideService(EffectDrizzleSqlite.EffectLogger, {
              logQuery: (query, params) =>
                Effect.gen(function* () {
                  if (/INSERT INTO temp\.usage_(partial|sample)\b/i.test(query)) {
                    const source = query
                      .slice(query.indexOf("FROM usage_analytics_request"))
                      .replace(/\)\s*SELECT raw,[\s\S]*$/i, "")
                      .replace(/GROUP BY 1\s*$/, "")
                    const start = query.indexOf("FROM usage_analytics_request")
                    const offset = (query.slice(0, start).match(/\?/g) ?? []).length
                    const count = yield* read(
                      `SELECT count(*) AS population ${source}`,
                      params.slice(offset, offset + (source.match(/\?/g) ?? []).length),
                    )
                    populations.push(Number(count[0]!.population))
                  }
                  if (/INSERT INTO temp\.usage_metric\b|FROM temp\.usage_sample GROUP BY slot/.test(query)) {
                    const count = yield* read("SELECT count(*) AS population FROM temp.usage_sample")
                    populations.push(Number(count[0]!.population))
                  }
                  const metric = /FROM temp\.usage_metric WHERE slot = \? AND metric = \?/.test(query)
                    ? (["first", "total", "generation"] as const)[Number(params[1])]
                    : /SELECT DISTINCT.*AS key/s.test(query) && query.includes("r.cost IS NULL")
                      ? "pricing"
                      : undefined
                  if (!metric) return
                  const start = performance.now()
                  yield* read(query, params)
                  measured[metric] = Math.max(measured[metric], performance.now() - start)
                  if (metric === "pricing") {
                    const count = yield* read(
                      `SELECT count(*) AS population ${query.slice(query.indexOf("FROM usage_analytics_request"))}`,
                      params,
                    )
                    populations.push(Number(count[0]!.population))
                    return
                  }
                  const plan = yield* read(`EXPLAIN QUERY PLAN ${query}`, params)
                  expect(plan.some((row) => /SEARCH temp\.usage_metric USING PRIMARY KEY \(slot=\? AND metric=\?/.test(String(row.detail)))).toBe(true)
                  expect(plan.some((row) => String(row.detail).includes("TEMP B-TREE"))).toBe(false)
                  const page = yield* read(query, params)
                  populations.push(page.length)
                }),
            }),
            Effect.provide(EffectDrizzleSqlite.DefaultServices),
          )
          yield* DatabaseMigration.apply(db)
          yield* db.run(
            `INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('global', '/bounded', '[]', 0, 0)`,
          )
          yield* db.run(
            `INSERT INTO session (id, project_id, directory, title, time_created, time_updated) VALUES ('ses_bounded', 'global', '/bounded', 'Bounded', 0, 0)`,
          )
          for (let start = 0; start < fixture.requests; start += 10_000)
            yield* db.run(sql`
            WITH RECURSIVE n(value) AS (SELECT ${start} UNION ALL SELECT value + 1 FROM n WHERE value < ${start + 9999})
            INSERT INTO session_provider_request
              (id, session_id, source, agent, model, route_id, prompt_cache_key, system_digest, tool_digest,
                request, attempts, invalidation, continuation, tokens, timing, time_created)
            SELECT printf('prq_%09d', value), 'ses_bounded', 'step', 'build', '{"providerID":"p","id":"m"}',
              'test', 'cache', 'system', 'tools', value + 1, 1, 'first-request', 'full',
              '{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}',
              json_object('firstOutputMs', ${fixture.ties ? sql`7` : sql`value % 1000`}, 'totalMs', ${fixture.ties ? sql`13` : sql`1000 + value % 2000`},
                'generatedTokens', 3, 'generationDurationNs', 1000000000), ${fixture.ties ? sql`0` : sql`value`}
            FROM n
          `)
          yield* db.transaction(() => UsageAnalytics.backfill(db))
          let after: string | undefined
          const refs = new Set<string>()
          while (true) {
            const page = yield* SessionUsageRead.pricingRefs(db, sql`1`, after)
            page.refs.forEach((ref) => refs.add(ref.key))
            if (page.after === undefined) break
            after = page.after
          }
          expect(refs.size).toBe(1)
          const result = yield* SessionUsageRead.report(db, {
            where: sql`1`,
            group: "model",
            order: sql`key ASC`,
            offset: 0,
            limit: 100,
            corrections: {},
          })
          expect(result.total.logical).toBe(fixture.requests)
          expect(result.rows[0]!.speed).toEqual({
            samples: fixture.requests,
            generationSamples: fixture.requests,
            providerTimedSamples: fixture.requests,
            observedSamples: 0,
            generationP50TokensPerSecond: 3,
            generationP90TokensPerSecond: 3,
            firstOutputP50Ms: fixture.ties ? 7 : 499,
            firstOutputP95Ms: fixture.ties ? 7 : 949,
            totalP50Ms: fixture.ties ? 13 : 1999,
            totalP95Ms: fixture.ties ? 13 : 2899,
            outputTokensPerSecond: 3,
          })
          if (fixture.ties) {
            const scoped = yield* SessionUsageRead.report(db, {
              where: sql`r.session_id = ${"ses_bounded"}`,
              sessions: [SessionSchema.ID.make("ses_bounded")],
              group: "model",
              order: sql`key ASC`,
              offset: 0,
              limit: 100,
              corrections: {},
            })
            expect(result.rows[0]?.title).toBe("ses_bounded")
            expect(scoped.rows).toEqual(result.rows.map((row) => ({ ...row, title: "Bounded" })))
            expect(scoped.total).toEqual(result.total)
          }
          console.log("usage statement fixture", { ...fixture, maxPopulation: Math.max(...populations), ...measured })
          expect(populations.length).toBeGreaterThan(0)
          expect(Math.max(...populations)).toBeLessThanOrEqual(10_000)
        }).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" })), Effect.scoped),
      ),
    120_000,
  )

test("a sparse Session reads only its own indexed population in a million-request file ledger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-usage-sparse-"))
  await Effect.runPromise(
    Effect.gen(function* () {
      const queries: { sql: string; params: unknown[] }[] = []
      const database = Layer.effect(
        Database.Service,
        Effect.gen(function* () {
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
          yield* db.run("PRAGMA cache_size = -64000")
          yield* db.run("PRAGMA temp_store = MEMORY")
          yield* db.run(
            `INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('global', '/sparse', '[]', 0, 0)`,
          )
          yield* db
            .insert(SessionTable)
            .values([
              {
                id: SessionSchema.ID.make("ses_background"),
                project_id: Project.ID.global,
                directory: "/sparse",
                title: "Background",
              },
              {
                id: SessionSchema.ID.make("ses_sparse"),
                project_id: Project.ID.global,
                directory: "/sparse",
                title: "Sparse",
              },
            ])
            .run()
          for (let start = 0; start < 1_000_000; start += 10_000)
            yield* db.run(sql`
          WITH RECURSIVE n(value) AS (SELECT ${start} UNION ALL SELECT value + 1 FROM n WHERE value < ${start + 9999})
          INSERT INTO session_provider_request
            (id, session_id, source, agent, model, route_id, prompt_cache_key, system_digest, tool_digest,
              request, attempts, invalidation, continuation, tokens, timing, cost, time_created)
          SELECT printf('prq_sparse_%09d', value), CASE WHEN value = 500000 THEN 'ses_sparse' ELSE 'ses_background' END,
            'step', 'build', '{"providerID":"p","id":"m"}', 'test', 'cache', 'system', 'tools', value + 1, 2,
            'first-request', 'full', '{"input":7,"output":3,"reasoning":1,"cache":{"read":2,"write":1}}',
            '{"firstOutputMs":7,"totalMs":13}', CASE WHEN value = 500000 THEN 0.5 END, value
          FROM n
        `)
          return { db }
        }),
      ).pipe(Layer.provide(sqliteLayer({ filename: join(directory, "usage.db") })))
      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const session = yield* Session.Service
        const sessions = [SessionSchema.ID.make("ses_sparse")]
        const where = sql`r.session_id IN (SELECT value FROM json_each(${JSON.stringify(sessions)}))`
        queries.length = 0
        const durations: number[] = []
        for (let sample = 0; sample < 2; sample++) {
          const start = performance.now()
          const models = yield* SessionUsageRead.models(db, where, sessions)
          durations.push(performance.now() - start)
          expect(models).toMatchObject([
            {
              logical: 1,
              physical: 2,
              input: 7,
              output: 3,
              reasoning: 1,
              cacheRead: 2,
              cacheWrite: 1,
              cost: 0.5,
              priced: 1,
            },
          ])
        }
        console.log("sparse Session models milliseconds", durations)
        const summary = yield* session.usage(sessions[0]!)
        expect(summary).toMatchObject({
          logical: 1,
          physical: 2,
          cost: 0.5,
          tokens: { input: 7, output: 3, reasoning: 1, cache: { read: 2, write: 1 } },
          latestInvalidation: "first-request",
          latestNamespace: "cache",
          latestTiming: { firstOutputMs: 7, totalMs: 13 },
        })
        expect(summary.models).toHaveLength(1)
        const report = yield* session.usageReport({ sessionID: sessions[0]!, group: "model" })
        expect(report).toMatchObject({
          rowCount: 1,
          total: { logical: 1, cost: 0.5 },
          rows: [
            {
              key: "p/m",
              label: "p/m",
              logical: 1,
              physical: 2,
              cost: 0.5,
              speed: { samples: 1, firstOutputP50Ms: 7, firstOutputP95Ms: 7, totalP50Ms: 13, totalP95Ms: 13 },
            },
          ],
        })
        const reads = queries.filter((query) => query.sql.includes("FROM session_provider_request AS r"))
        expect(reads.length).toBeGreaterThan(0)
        expect(reads.length).toBeLessThan(30)
        for (const query of reads) {
          const source = query.sql
            .slice(query.sql.indexOf("FROM session_provider_request"))
            .replace(/GROUP BY 1\s*$/, "")
            .replace(/JOIN temp\.usage_slot ON[^\n]+\n/, "")
          const selected = query.sql.includes("INSERT INTO temp.usage_")
            ? `SELECT count(*) AS population ${source}`
            : query.sql
          const plan = yield* db.$client.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${selected}`, query.params)
          expect(
            plan.some((row) => /SEARCH r USING (?:COVERING )?INDEX session_provider_request_session_/.test(row.detail)),
          ).toBe(true)
          if (!query.sql.includes("INSERT INTO temp.usage_")) continue
          const population = yield* db.$client.unsafe<{ population: number }>(
            `SELECT count(*) AS population ${source}`,
            query.params,
          )
          expect(population[0]!.population).toBe(1)
        }
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Database.node, Session.node]), [
            [Database.node, database],
            [SessionExecution.node, SessionExecution.noopLayer],
          ]),
        ),
      )
    }).pipe(Effect.scoped, Effect.ensuring(Effect.promise(() => rm(directory, { recursive: true, force: true })))),
  )
}, 120_000)
