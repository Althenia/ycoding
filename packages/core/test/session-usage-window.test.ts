import { expect, test } from "bun:test"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "../src/database/migration"
import { sqliteLayer } from "../src/database/sqlite.bun"
import { SessionSchema } from "../src/session/schema"
import { SessionUsageRead } from "../src/session/usage-read"
import { UsageAnalytics } from "../src/usage-analytics"
import { UsageStage } from "../src/usage-stage"

const requests = 24_000
const tie = 4
const sparse = 40
const family = [SessionSchema.ID.make("ses_window")]

type Range = { from?: number; to?: number }

const expected = (range: Range) => {
  const rows = Array.from({ length: requests }, (_, value) => value).filter((value) => {
    const time = Math.floor(value / tie)
    return time >= (range.from ?? 0) && time < (range.to ?? Infinity)
  })
  const unpriced = rows.filter((value) => value % sparse < 2)
  return {
    logical: rows.length,
    priced: rows.length - unpriced.length,
    unpriced: unpriced.length,
    refs: new Set(unpriced.map((value) => value % 2)).size,
    input: rows.reduce((total, value) => total + 1 + (value % 3), 0),
    cost: (rows.length - unpriced.length) * 0.5,
  }
}

const fixture = Effect.gen(function* () {
  const queries: { sql: string; params: unknown[] }[] = []
  const db = yield* EffectDrizzleSqlite.make().pipe(
    Effect.provideService(EffectDrizzleSqlite.EffectLogger, {
      logQuery: (query, params) =>
        Effect.sync(() => {
          queries.push({ sql: query, params })
        }),
    }),
    Effect.provide(EffectDrizzleSqlite.DefaultServices),
  )
  yield* DatabaseMigration.apply(db)
  yield* db.run(
    `INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('global', '/window', '[]', 0, 0)`,
  )
  yield* db.run(
    `INSERT INTO session (id, project_id, directory, title, time_created, time_updated) VALUES ('ses_window', 'global', '/window', 'Window', 0, 0)`,
  )
  for (let start = 0; start < requests; start += 8_000)
    yield* db.run(sql`
      WITH RECURSIVE n(value) AS (SELECT ${start} UNION ALL SELECT value + 1 FROM n WHERE value < ${start + 7999})
      INSERT INTO session_provider_request
        (id, session_id, source, agent, model, route_id, prompt_cache_key, system_digest, tool_digest,
          request, attempts, invalidation, continuation, tokens, timing, cost, time_created)
      SELECT printf('prq_%09d', value), 'ses_window', 'step', 'build',
        CASE WHEN value % 2 = 0 THEN '{"providerID":"p","id":"even"}' ELSE '{"providerID":"p","id":"odd"}' END,
        'test', 'cache', 'system', 'tools', value + 1, 1, 'first-request', 'full',
        json_object('input', 1 + value % 3, 'output', 1, 'reasoning', 0, 'cache', json_object('read', 0, 'write', 0)),
        '{"firstOutputMs":7,"totalMs":13}', CASE WHEN value % ${sparse} < 2 THEN NULL ELSE 0.5 END, value / ${tie}
      FROM n
    `)
  yield* db.transaction(() => UsageAnalytics.backfill(db).pipe(Effect.andThen(UsageStage.backfill(db))))
  yield* db.run(`ANALYZE`)
  return { db, queries }
})

type Db = Effect.Success<typeof fixture>["db"]

const readAll = Effect.fnUntraced(function* (db: Db, range: Range, sessions?: typeof family) {
  const where = SessionUsageRead.usageWhere(range, sessions)
  const pieces = SessionUsageRead.pieces(range)
  const scopes = sessions ?? [undefined]
  let unpriced = 0
  const refs = new Set<string>()
  for (const sessionID of scopes) {
    let after: string | undefined
    while (true) {
      const page = yield* SessionUsageRead.unpriced(db, where, after, sessionID, pieces)
      unpriced += page.rows.reduce((total, row) => total + row.requests, 0)
      if (page.after === undefined) break
      after = page.after
    }
    after = undefined
    while (true) {
      const page: Effect.Success<ReturnType<typeof SessionUsageRead.pricingRefs>> = yield* SessionUsageRead.pricingRefs(db, where, after, sessionID, range)
      page.refs.forEach((ref) => refs.add(ref.key))
      if (page.after === undefined) break
      after = page.after
    }
  }
  const report = yield* SessionUsageRead.report(db, {
    where,
    sessions,
    group: "model",
    plan: { pieces, offsets: [] },
    order: sql`key ASC`,
    offset: 0,
    limit: 100,
    corrections: {},
  })
  return { unpriced, refs: refs.size, total: report.total }
})

const ranges: ReadonlyArray<[string, Range]> = [
  ["a multi-slice window", { from: 1_000, to: 5_000 }],
  ["a single millisecond", { from: 1_000, to: 1_001 }],
  ["an open upper bound", { from: 5_000 }],
  ["an open lower bound", { to: 1_000 }],
  ["an empty range", { from: 3_000, to: 3_000 }],
  ["a range past the ledger", { from: 100_000 }],
]

for (const [name, range] of ranges)
  test(`dated usage reads return exact accounting for ${name} in global and Session scope`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* fixture
        const want = expected(range)
        for (const sessions of [undefined, family]) {
          const got = yield* readAll(db, range, sessions)
          expect(got.unpriced).toBe(want.unpriced)
          expect(got.refs).toBe(want.refs)
          expect(got.total).toMatchObject({
            logical: want.logical,
            priced: want.priced,
            input: want.input,
            cost: want.cost,
          })
        }
      }).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" })), Effect.scoped),
    ),
  )

test("dated usage pages seek prepared cells by span, bucket and cell cursor instead of rescanning the date range", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, queries } = yield* fixture
      queries.length = 0
      const range = { from: 1_000, to: 5_000 }
      yield* readAll(db, range)

      const dated = queries.filter(
        (query) => query.sql.includes("FROM usage_analytics_cell AS r") && !/\btemp\.usage_(?:slot|sample)\b/.test(query.sql),
      )
      expect(dated.length).toBeGreaterThan(5)
      expect(queries.some((query) => /\b(?:from|join)\s+usage_analytics_request\b/i.test(query.sql))).toBe(false)
      const kinds = new Set<string>()
      for (const query of dated) {
        const plan = yield* db.$client.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query.sql.replace(/^\s*INSERT INTO temp\.usage_partial/, "")}`, query.params)
        const search = plan.find((row) => /SEARCH r USING (?:COVERING )?INDEX usage_analytics_cell_/.test(row.detail))!.detail
        const kind = query.sql.includes("DISTINCT")
          ? "pricing"
          : query.sql.includes("INSERT INTO temp.usage_partial")
            ? "stage"
            : query.sql.includes("r.unpriced > 0")
              ? "unpriced"
              : "other"
        kinds.add(kind)
        expect(search).toContain(
          kind === "pricing" || kind === "unpriced" ? "usage_analytics_cell_unpriced_idx" : "usage_analytics_cell_",
        )
        expect(search).toContain("span=?")
        expect(search).toMatch(/bucket>\?|\(bucket,key\)>\(\?,\?\)/)
      }
      expect([...kinds].filter((kind) => kind !== "other").toSorted()).toEqual(["pricing", "stage", "unpriced"])
    }).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" })), Effect.scoped),
  ), 120_000)
