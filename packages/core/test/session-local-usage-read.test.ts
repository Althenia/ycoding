import { expect, test } from "bun:test"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { sqliteLayer } from "../src/database/sqlite.bun"
import { SessionUsageRead } from "../src/session/usage-read"
import { AbsolutePath } from "@ycoding-ai/schema/schema"
import { Location } from "@ycoding-ai/schema/location"
import { Workspace } from "@ycoding-ai/schema/workspace"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { UsageAnalytics } from "../src/usage-analytics"
import { UsageStage } from "../src/usage-stage"

const seed = (db: Database.Interface["db"]) => Effect.gen(function* () {
  yield* db.run("INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('global', '/local', '[]', 0, 0)")
  yield* db.run("INSERT INTO session (id, project_id, directory, title, time_created, time_updated) VALUES ('ses_local', 'global', '/local', 'Local', 0, 0)")
  yield* db.run("INSERT INTO session (id, project_id, directory, workspace_id, title, time_created, time_updated) VALUES ('ses_other', 'global', '/local', 'wrk_other', 'Other', 0, 0)")
})

test("local bins align to the lower bound, isolate Location and profile, and exclude estimated fields and invalid prices", () =>
  Effect.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    yield* seed(database.db)
    const from = 97_001
    const to = from + 600_000
    for (const [index, cost] of [0, 2, null, -5, Infinity].entries()) {
      yield* database.db.run(sql`
        INSERT INTO session_provider_request
          (id, session_id, source, agent, model, route_id, prompt_cache_key, system_digest, tool_digest,
            request, attempts, invalidation, continuation, cost, tokens, timing, time_created)
        VALUES (${"prq_local_" + index}, 'ses_local', 'step', 'build',
          ${JSON.stringify({ providerID: "p", id: "m", profile: "Work", variant: index % 2 ? "high" : "low" })},
          'route', 'cache', 'system', 'tools', ${index + 1}, 1, 'first-request', 'full', ${cost},
          '{"input":1,"output":2,"reasoning":3,"cache":{"read":4,"write":5}}',
          '{"generatedTokens":888888,"estimatedTokens":999999,"estimatedGenerationDurationNs":1000000000}',
          ${index === 0 ? from : from + 300_000})
      `)
    }
    for (const [index, sessionID, at] of [[0, "ses_other", from], [1, "ses_local", from - 1], [2, "ses_local", to]] as const)
      yield* database.db.run(sql`
        INSERT INTO session_provider_request
          (id, session_id, source, agent, model, route_id, prompt_cache_key, system_digest, tool_digest,
            request, attempts, invalidation, continuation, cost, tokens, time_created)
        VALUES (${"prq_edge_" + index}, ${sessionID}, 'step', 'build', '{"providerID":"p","id":"m"}',
          'route', 'cache', 'system', 'tools', ${100 + index}, 1, 'first-request', 'full', 7,
          '{"input":10,"output":20,"reasoning":30,"cache":{"read":40,"write":50}}', ${at})
      `)
    yield* database.db.transaction(() => UsageAnalytics.backfill(database.db).pipe(Effect.andThen(UsageStage.backfill(database.db))))
    const bins = yield* SessionUsageRead.localUsage(database, {
      from, to, scope: { type: "location", location: Location.Ref.make({ directory: AbsolutePath.make("/local") }) },
    })
    expect(bins).toHaveLength(2)
    expect(bins.map((bin) => bin.start)).toEqual([from, from + 300_000])
    expect(bins[0]).toMatchObject({ profile: "Work", requests: 1, knownUSD: 0, pricedRequests: 1, unpricedRequests: 0,
      tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } } })
    expect(bins[1]).toMatchObject({ profile: "Work", requests: 4, knownUSD: 2, pricedRequests: 1, unpricedRequests: 3,
      tokens: { input: 4, output: 8, reasoning: 12, cache: { read: 16, write: 20 } } })
    const backend = yield* SessionUsageRead.localUsage(database, { from, to, scope: { type: "backend" } })
    expect(backend).toHaveLength(4)
    expect(backend.reduce((sum, bin) => sum + bin.requests, 0)).toBe(6)
    const empty = backend.find((bin) => bin.profile === undefined && bin.start === from + 300_000)!
    expect(empty.requests).toBe(0)
    expect(empty).not.toHaveProperty("knownUSD")
    const workspace = yield* SessionUsageRead.localUsage(database, { from, to, scope: { type: "location", location: Location.Ref.make({
      directory: AbsolutePath.make("/local"), workspaceID: Workspace.ID.make("wrk_other"),
    }) } })
    expect(workspace).toHaveLength(2)
    expect(workspace.reduce((sum, bin) => sum + bin.requests, 0)).toBe(1)
    const spend = yield* SessionUsageRead.localSpend(database, { dayStart: from, dayEnd: to })
    expect(spend).toMatchObject([{ providerID: "p", knownUSD: 9, pricedRequests: 3, unpricedRequests: 3 }])
    expect((yield* SessionUsageRead.localSpend(database, { dayStart: to + 1, dayEnd: to + 2 }))).toEqual([])
    expect((yield* SessionUsageRead.localUsage(database, { from: to + 1, to: to + 2, scope: { type: "backend" } }))).toEqual([])
  }).pipe(Effect.provide(Database.layer({ path: ":memory:" })), Effect.scoped)),
)

test("local reads reject a non-ordered or non-safe-integer range with a typed error", () =>
  Effect.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    const ranges = [
      [-Infinity, 1_000],
      [0, Infinity],
      [-Infinity, Infinity],
      [0, 2 ** 60],
      [NaN, 1_000],
      [0, NaN],
      [1_000, 0],
      [1_000, 1_000],
      [0.5, 600_000.5],
    ] as const
    for (const [from, to] of ranges) {
      const usage = yield* Effect.flip(SessionUsageRead.localUsage(database, { from, to, scope: { type: "backend" } }))
      expect(usage).toBeInstanceOf(Error)
      expect(usage).not.toBeInstanceOf(RangeError)
      expect(usage.message).toBe("Local usage requires an ordered finite millisecond range")
      const spend = yield* Effect.flip(SessionUsageRead.localSpend(database, { dayStart: from, dayEnd: to }))
      expect(spend).toBeInstanceOf(Error)
      expect(spend).not.toBeInstanceOf(RangeError)
      expect(spend.message).toBe("Local usage requires an ordered finite millisecond range")
    }
  }).pipe(Effect.provide(Database.layer({ path: ":memory:" })), Effect.scoped)),
)

for (const mode of ["snapshot", "cancel"] as const)
  test(`local reads ${mode} release the shared reader while main-connection work stays available`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "ycoding-local-read-"))
    const file = join(directory, "usage.db")
    try {
      await Effect.runPromise(Effect.gen(function* () {
        const database = yield* Database.Service
        yield* seed(database.db)
        yield* database.db.run(sql`
          WITH RECURSIVE n(value) AS (SELECT 0 UNION ALL SELECT value + 1 FROM n WHERE value < 10004)
          INSERT INTO session_provider_request
            (id, session_id, source, agent, model, route_id, prompt_cache_key, system_digest, tool_digest,
              request, attempts, invalidation, continuation, cost, tokens, time_created)
          SELECT printf('prq_local_%09d', value), 'ses_local', 'step', 'build', '{"providerID":"p","id":"m"}',
            'route', 'cache', 'system', 'tools', value + 1, 1, 'first-request', 'full', 1,
            '{"input":1,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}', 100
          FROM n
        `)
        yield* database.db.transaction(() => UsageAnalytics.backfill(database.db).pipe(Effect.andThen(UsageStage.backfill(database.db))))
        const held = yield* Deferred.make<void>()
        const proceed = yield* Deferred.make<void>()
        const context = yield* Layer.build(sqliteLayer({ filename: file, readonly: true, readwrite: false, create: false, disableWAL: true }))
        let count = 0
        const reader: Database.Interface["db"] = yield* EffectDrizzleSqlite.make().pipe(
          Effect.provideService(EffectDrizzleSqlite.EffectLogger, {
            logQuery: (query) => Effect.gen(function* () {
              if (!query.includes("FROM usage_analytics_cell AS r")) return
              expect((yield* Effect.serviceOption(reader.$client.transactionService))._tag).toBe("Some")
              count += 1
              if (count !== 2) return
              yield* Deferred.succeed(held, undefined)
              yield* Deferred.await(proceed)
            }),
          }),
          Effect.provide(EffectDrizzleSqlite.DefaultServices),
          Effect.provide(context),
        )
        const input = { dayStart: 0, dayEnd: 1_000 }
        const fiber = yield* SessionUsageRead.localSpend({ ...database, reader }, input).pipe(Effect.forkChild)
        yield* Deferred.await(held)
        expect((yield* database.db.get<{ one: number }>(sql`SELECT 1 AS one`))?.one).toBe(1)
        if (mode === "cancel") {
          yield* Fiber.interrupt(fiber)
          expect((yield* SessionUsageRead.localUsage({ ...database, reader }, { from: 0, to: 1_000, scope: { type: "backend" } }))[0]?.requests).toBe(10_005)
          return
        }
        yield* database.db.run(sql`
          INSERT INTO session_provider_request
            (id, session_id, source, agent, model, route_id, prompt_cache_key, system_digest, tool_digest,
              request, attempts, invalidation, continuation, cost, tokens, time_created)
          VALUES ('prq_local_new', 'ses_local', 'step', 'build', '{"providerID":"p","id":"m"}',
            'route', 'cache', 'system', 'tools', 10006, 1, 'first-request', 'full', 1,
            '{"input":1,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}', 100)
        `)
        yield* database.db.transaction(() => UsageAnalytics.backfill(database.db).pipe(Effect.andThen(UsageStage.backfill(database.db))))
        yield* Deferred.succeed(proceed, undefined)
        expect((yield* Fiber.join(fiber))[0]?.knownUSD).toBe(10_005)
        const [spend, bins] = yield* Effect.all([
          SessionUsageRead.localSpend({ ...database, reader }, input),
          SessionUsageRead.localUsage({ ...database, reader }, { from: 0, to: 1_000, scope: { type: "backend" } }),
        ], { concurrency: 2 })
        expect(spend[0]?.knownUSD).toBe(10_006)
        expect(bins[0]?.requests).toBe(10_006)
      }).pipe(Effect.provide(Database.layer({ path: file })), Effect.scoped))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
