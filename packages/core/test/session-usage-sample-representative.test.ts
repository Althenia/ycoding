import { expect, test } from "bun:test"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Effect, Schema } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "../src/database/migration"
import { sqliteLayer } from "../src/database/sqlite.bun"
import { CatalogModel } from "../src/model"
import { SessionSchema } from "../src/session/schema"
import { SessionUsageRead } from "../src/session/usage-read"
import { UsageStage } from "../src/usage-stage"

const first = '{"providerID":"p","id":"m"}'
const second = '{"id":"m","providerID":"p"}'
const timing = (generated: unknown, duration: unknown) =>
  JSON.stringify({ firstOutputMs: 5, totalMs: 9, generatedTokens: generated, generationDurationNs: duration })

const decodeModel = Schema.decodeUnknownSync(Schema.fromJsonString(CatalogModel.Ref))

const database = Effect.gen(function* () {
  const db = yield* EffectDrizzleSqlite.make().pipe(Effect.provide(EffectDrizzleSqlite.DefaultServices))
  yield* DatabaseMigration.apply(db)
  yield* db.run(
    `INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('global', '/sample', '[]', 0, 0)`,
  )
  return db
})

const report = (db: Effect.Success<typeof database>, sessions?: ReadonlyArray<SessionSchema.ID>) =>
  Effect.andThen(UsageStage.backfill(db), SessionUsageRead.report(db, {
    where: sessions ? sql`r.session_id IN (SELECT value FROM json_each(${JSON.stringify(sessions)}))` : sql`1`,
    sessions,
    group: "model",
    plan: { pieces: SessionUsageRead.pieces({}), offsets: [] },
    order: sql`key ASC`,
    offset: 0,
    limit: 100,
    corrections: {},
  }))

test("a model group decodes to one ModelRef and counts every sample across slices for either raw JSON key order", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* database
      yield* db.run(sql`
        WITH RECURSIVE n(value) AS (SELECT 0 UNION ALL SELECT value + 1 FROM n WHERE value < 10050)
        INSERT INTO usage_analytics_request
          (id, session_id, project_id, directory, session_updated, agent, source, model, task_path, request, attempts,
            continuation, invalidation, prompt_cache_key, tokens, cost, timing, time_created)
        SELECT printf('prq_%07d', value), printf('ses_%05d', value), 'global', '/sample',
          CASE WHEN value = 10050 THEN 1 ELSE 1000 + value END, 'build', 'step',
          CASE WHEN value = 10050 THEN ${second} ELSE ${first} END, '[]', value + 1, 1, 'full', 'first-request', 'cache',
          '{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}', 0.5,
          ${timing(3, 1_000_000_000)}, value
        FROM n
      `)
      const result = yield* report(db)
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0]).toMatchObject({ key: "p/m", logical: 10_051 })
      expect(decodeModel(result.rows[0]!.model)).toEqual(decodeModel(first))
      expect(decodeModel(second)).toEqual(decodeModel(first))
      expect(result.rows[0]!.speed).toMatchObject({ samples: 10_051, generationSamples: 10_051 })
    }).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" })), Effect.scoped),
  ), 120_000)

test("Session family speed counts every owner population and only valid generation samples", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* database
      const family = [SessionSchema.ID.make("ses_b"), SessionSchema.ID.make("ses_a")]
      for (const id of family)
        yield* db.run(
          `INSERT INTO session (id, project_id, directory, title, time_created, time_updated) VALUES ('${id}', 'global', '/sample', '${id}', 0, 0)`,
        )
      const rows = [
        ["ses_a", 1, second, timing(3, 1_000_000_000)],
        ["ses_b", 9, second, timing(3, 0)],
        ["ses_b", 8, first, timing(0, 1_000_000_000)],
        ["ses_b", 7, first, timing(3.5, 1_000_000_000)],
        ["ses_b", 6, first, timing(6, 1_000_000_000)],
      ] as const
      for (const [sessionID, request, model, value] of rows)
        yield* db.run(sql`
          INSERT INTO session_provider_request
            (id, session_id, source, agent, model, route_id, prompt_cache_key, system_digest, tool_digest, request,
              attempts, invalidation, continuation, tokens, timing, cost, time_created)
          VALUES (${`prq_${sessionID}_${request}`}, ${sessionID}, 'step', 'build', ${model}, 'test', 'cache', 'system', 'tools',
            ${request}, 1, 'first-request', 'full',
            '{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}', ${value}, 0.5, ${request})
        `)
      const result = yield* report(db, family)
      expect(result.rows[0]).toMatchObject({ key: "p/m" })
      expect(decodeModel(result.rows[0]!.model)).toEqual(decodeModel(first))
      expect(result.rows[0]!.speed).toMatchObject({
        samples: 5,
        generationSamples: 2,
        providerTimedSamples: 2,
        observedSamples: 0,
        generationP50TokensPerSecond: 3,
        generationP90TokensPerSecond: 6,
        outputTokensPerSecond: 4.5,
      })
    }).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" })), Effect.scoped),
  ), 120_000)

const insertAnalytics = (db: Effect.Success<typeof database>, rows: ReadonlyArray<{ id: string; sessionID?: string; updated?: number; request: number; model?: string; timing: string }>) =>
  Effect.forEach(
    rows,
    (row) =>
      db.run(sql`
        INSERT INTO usage_analytics_request
          (id, session_id, project_id, directory, session_updated, agent, source, model, task_path, request, attempts,
            continuation, invalidation, prompt_cache_key, tokens, cost, timing, time_created)
        VALUES (${row.id}, ${row.sessionID ?? "ses_rank"}, 'global', '/sample', ${row.updated ?? 1}, 'build', 'step',
          ${row.model ?? first}, '[]', ${row.request}, 1, 'full', 'first-request', 'cache',
          '{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}', 0.5, ${row.timing}, ${row.request})
      `),
    { discard: true },
  )

const rank = (values: ReadonlyArray<number>, percent: number) =>
  values.toSorted((left, right) => left - right)[Math.ceil((values.length * percent) / 100) - 1]

test("speed observations preserve repeated-value populations across slices and model groups", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* database
      yield* db.run(sql`
        WITH RECURSIVE n(value) AS (SELECT 0 UNION ALL SELECT value + 1 FROM n WHERE value < 10050)
        INSERT INTO usage_analytics_request
          (id, session_id, project_id, directory, session_updated, agent, source, model, task_path, request, attempts,
            continuation, invalidation, prompt_cache_key, tokens, cost, timing, time_created)
        SELECT printf('prq_weighted_%07d', value), 'ses_weighted', 'global', '/sample', 1, 'build', 'step',
          ${first}, '[]', value + 1, 1, 'full', 'first-request', 'cache',
          '{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}', 0.5,
          CASE WHEN value < 10000
            THEN '{"firstOutputMs":5,"totalMs":9,"generatedTokens":3,"generationDurationNs":1000000000}'
            ELSE '{"firstOutputMs":9000,"totalMs":90000,"generatedTokens":30,"generationDurationNs":1000000000}' END,
          value
        FROM n
      `)
      yield* insertAnalytics(db, [{ id: "prq_other", request: 10052, model: '{"providerID":"p","id":"other"}', timing: timing(7, 1_000_000_000) }])
      const result = yield* report(db)
      expect(result.rows).toHaveLength(2)
      expect(result.rows.find((row) => row.key === "p/m")?.speed).toMatchObject({
        samples: 10051,
        generationSamples: 10051,
        providerTimedSamples: 10051,
        observedSamples: 0,
        firstOutputP50Ms: 5,
        firstOutputP95Ms: 5,
        totalP50Ms: 9,
        totalP95Ms: 9,
        generationP50TokensPerSecond: 3,
        generationP90TokensPerSecond: 3,
        outputTokensPerSecond: (10000 * 3 + 51 * 30) / 10051,
      })
      expect(result.rows.find((row) => row.key === "p/other")?.speed).toMatchObject({
        samples: 1,
        generationSamples: 1,
        generationP50TokensPerSecond: 7,
        generationP90TokensPerSecond: 7,
      })
    }).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" })), Effect.scoped),
  ), 120_000)

const shapes: ReadonlyArray<[string, (index: number, size: number) => number]> = [
  ["distinct values", (index, size) => ((index * 7) % size) + 1],
  ["tied values", (index) => (index % 3 === 0 ? 5 : 9)],
  ["one repeated value", () => 4],
]

for (const size of [1, 2, 20, 21])
  for (const [name, shape] of shapes)
    test(`speed percentiles use ceil ranks for ${size} samples of ${name}`, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* database
          const values = Array.from({ length: size }, (_, index) => shape(index, size))
          yield* insertAnalytics(
            db,
            values.map((value, index) => ({
              id: `prq_${String(index).padStart(3, "0")}`,
              request: index + 1,
              timing: `{"firstOutputMs":${value},"totalMs":${value * 10},"generatedTokens":${value},"generationDurationNs":1000000000}`,
            })),
          )
          const result = yield* report(db)
          expect(result.rows[0]!.speed).toMatchObject({
            samples: size,
            generationSamples: size,
            firstOutputP50Ms: rank(values, 50),
            firstOutputP95Ms: rank(values, 95),
            totalP50Ms: rank(values.map((value) => value * 10), 50),
            totalP95Ms: rank(values.map((value) => value * 10), 95),
            generationP50TokensPerSecond: rank(values, 50),
            generationP90TokensPerSecond: rank(values, 90),
          })
        }).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" })), Effect.scoped),
      ))

test("speed percentiles treat integer and real spellings of one number as the same value", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* database
      const spellings = ["5", "5.0", "5", "5.0", "9", "9.0"]
      yield* insertAnalytics(
        db,
        spellings.map((value, index) => ({
          id: `prq_${index}`,
          request: index + 1,
          timing: `{"firstOutputMs":${value},"totalMs":${value},"generatedTokens":${value},"generationDurationNs":1000000000}`,
        })),
      )
      const result = yield* report(db)
      expect(result.rows[0]!.speed).toMatchObject({
        samples: 6,
        firstOutputP50Ms: 5,
        firstOutputP95Ms: 9,
        totalP50Ms: 5,
        totalP95Ms: 9,
        generationP50TokensPerSecond: 5,
        generationP90TokensPerSecond: 9,
      })
    }).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" })), Effect.scoped),
  ))

test("speed generation samples accept observed durations of at least one second and reject shorter or non-integer inputs", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* database
      const timings = [
        '{"firstOutputMs":1,"totalMs":1,"generatedTokens":4,"observedGenerationDurationNs":2000000000}',
        '{"firstOutputMs":1,"totalMs":1,"generatedTokens":4,"observedGenerationDurationNs":999999999}',
        '{"firstOutputMs":1,"totalMs":1,"generatedTokens":4.5,"generationDurationNs":1000000000}',
        '{"firstOutputMs":1,"totalMs":1,"generatedTokens":4,"generationDurationNs":-1}',
        '{"firstOutputMs":1,"totalMs":1,"generatedTokens":8,"generationDurationNs":1000000000}',
      ]
      yield* insertAnalytics(db, timings.map((timing, index) => ({ id: `prq_${index}`, request: index + 1, timing })))
      const result = yield* report(db)
      expect(result.rows[0]!.speed).toMatchObject({
        samples: 5,
        generationSamples: 2,
        providerTimedSamples: 1,
        observedSamples: 1,
        generationP50TokensPerSecond: 2,
        generationP90TokensPerSecond: 8,
        outputTokensPerSecond: 12 / 3,
      })
    }).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" })), Effect.scoped),
  ))

test("an interrupted speed read drops every temporary table it created", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let interrupt = false
      const db = yield* EffectDrizzleSqlite.make().pipe(
        Effect.provideService(EffectDrizzleSqlite.EffectLogger, {
          logQuery: (query) =>
            interrupt && /INSERT INTO temp\.usage_(sample|metric)/.test(query) ? Effect.interrupt : Effect.void,
        }),
        Effect.provide(EffectDrizzleSqlite.DefaultServices),
      )
      yield* DatabaseMigration.apply(db)
      yield* db.run(
        `INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('global', '/sample', '[]', 0, 0)`,
      )
      yield* insertAnalytics(db, [{ id: "prq_1", request: 1, timing: timing(3, 1_000_000_000) }])
      interrupt = true
      const exit = yield* Effect.exit(report(db))
      interrupt = false
      expect(exit._tag).toBe("Failure")
      const leftover = yield* db.all<{ name: string }>(sql`SELECT name FROM sqlite_temp_master WHERE name LIKE 'usage_%'`)
      expect(leftover).toEqual([])
    }).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" })), Effect.scoped),
  ))
