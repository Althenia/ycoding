import { expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { sql, type SQL } from "drizzle-orm"
import { Catalog } from "../src/catalog"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventRuntime } from "../src/event"
import { Location } from "../src/location"
import { LocationServiceMap } from "../src/location-service-map"
import { fixedLocations } from "./fixture/location-map"
import type { LocationServices } from "../src/location-services"
import { CatalogModel } from "../src/model"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { Provider } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { Session } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionMessage } from "../src/session/message"
import { SessionSchema } from "../src/session/schema"
import { SessionTable } from "../src/session/sql"
import { SessionUsageRead, type Unpriced } from "../src/session/usage-read"
import { UsageAnalytics } from "../src/usage-analytics"
import { UsageStage } from "../src/usage-stage"
import { Money } from "@ycoding-ai/schema/money"

const statementRows = 10_000
const wide = 12_000
const tied = 10_050
const wideTime = 1_700_000_000_123
const tiedTime = wideTime + 7
const tierSize = 6_000
const wideSession = SessionSchema.ID.make("ses_bounded_wide")
const tiedSession = SessionSchema.ID.make("ses_bounded_tied")

type Bounds = { rows: number; changes: number }

const watch = (db: Database.Interface["db"], bounds: Bounds) =>
  new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (property === "all") {
        const all = value.bind(target) as (...args: ReadonlyArray<unknown>) => Effect.Effect<ReadonlyArray<unknown>, unknown>
        return (...args: ReadonlyArray<unknown>) =>
          all(...args).pipe(Effect.tap((rows) => Effect.sync(() => void (bounds.rows = Math.max(bounds.rows, rows.length)))))
      }
      if (property === "run") {
        const run = value.bind(target) as (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>
        return (...args: ReadonlyArray<unknown>) =>
          run(...args).pipe(
            Effect.tap(() =>
              target
                .get<{ count: number }>(sql`SELECT changes() AS count`)
                .pipe(Effect.tap((row) => Effect.sync(() => void (bounds.changes = Math.max(bounds.changes, row?.count ?? 0))))),
            ),
          )
      }
      return typeof value === "function" ? value.bind(target) : value
    },
  })

const seed = (db: Database.Interface["db"], taskPath?: ReadonlyArray<SessionSchema.ID>) =>
  Effect.gen(function* () {
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/bounded"), sandboxes: [] }).run()
    yield* db
      .insert(SessionTable)
      .values(
        [wideSession, tiedSession].map((id) => ({ id, project_id: Project.ID.global, directory: "/bounded", title: id })),
      )
      .run()
    const insert = (rows: SQL) =>
      db.run(sql`
        WITH RECURSIVE n(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM n WHERE k < ${wide})
        INSERT INTO session_provider_request (id, session_id, input_id, source, agent, model, route_id, prompt_cache_key,
          system_digest, tool_digest, request, attempts, invalidation, continuation, timing, cost, tokens, time_created)
        ${rows}
      `)
    yield* insert(sql`
      SELECT printf('prq_wide_%05d', k), ${wideSession}, NULL, 'step', 'build', '{"providerID":"openai","id":"tiered"}',
        'route', printf('w%07d', k), 'system', 'tools', k, 1, 'first-request', 'full',
        json_object('firstOutputMs', k, 'totalMs', 2 * k, 'generatedTokens', 100, 'generationDurationNs', k * 1000000),
        NULL, json_object('input', k, 'output', 0, 'reasoning', 0, 'cache', json_object('read', 0, 'write', 0)), ${wideTime}
      FROM n
    `)
    yield* insert(sql`
      SELECT printf('prq_tied_%05d', k), ${tiedSession}, printf('msg_tied_%05d', k), 'step', printf('a%05d', ${tied} - k),
        '{"providerID":"recorded","id":"flat"}', 'route', printf('t%07d', k), 'system', 'tools', k, 1, 'first-request', 'full',
        NULL, 0.001, json_object('input', 1, 'output', 0, 'reasoning', 0, 'cache', json_object('read', 0, 'write', 0)), ${tiedTime}
      FROM n WHERE k <= ${tied}
    `)
    yield* db.transaction(() =>
      UsageAnalytics.backfill(db).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            if (taskPath === undefined) return
            yield* db.run(
              sql`UPDATE usage_analytics_request SET task_path = ${JSON.stringify(taskPath)} WHERE session_id = ${wideSession}`,
            )
          }),
        ),
        Effect.andThen(UsageStage.backfill(db)),
      ),
    )
  })

function harness(taskPath?: ReadonlyArray<SessionSchema.ID>) {
  const bounds: Bounds = { rows: 0, changes: 0 }
  const tiers = [
    {
      input: Money.USDPerMillionTokens.make(1),
      output: Money.USDPerMillionTokens.make(0),
      cache: { read: Money.USDPerMillionTokens.make(0), write: Money.USDPerMillionTokens.make(0) },
    },
    {
      tier: { type: "context" as const, size: tierSize },
      input: Money.USDPerMillionTokens.make(3),
      output: Money.USDPerMillionTokens.make(0),
      cache: { read: Money.USDPerMillionTokens.make(0), write: Money.USDPerMillionTokens.make(0) },
    },
  ]
  const catalog = Context.make(Catalog.Service, {
    model: {
      get: (provider: Provider.ID, id: CatalogModel.ID) =>
        Effect.succeed({
          ...CatalogModel.Info.empty(provider, id),
          cost: provider === Provider.ID.make("openai") ? tiers : [],
        }),
    },
  } as unknown as Catalog.Interface) as Context.Context<LocationServices>
  const locations = Layer.effect(
    LocationServiceMap.Service,
    fixedLocations((_: Location.Ref) => Layer.effectContext(Effect.succeed(catalog)), { idleTimeToLive: "60 minutes" }),
  )
  const database = Layer.effect(
    Database.Service,
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* seed(database.db, taskPath)
      return { ...database, db: watch(database.db, bounds) }
    }),
  ).pipe(Layer.provide(Database.layer({ path: ":memory:" })))
  const runtime = AppNodeBuilder.build(
    LayerNode.group([Database.node, Session.node, LocationServiceMap.node, EventRuntime.node]),
    [
      [UsageAnalytics.node, Layer.mock(UsageAnalytics.Service, {})],
      [Database.node, database],
      [SessionExecution.node, SessionExecution.noopLayer],
      [LocationServiceMap.node, locations],
    ],
  )
  return { bounds, runtime }
}

const wideExpected = (() => {
  let cost = 0
  let input = 0
  for (let k = 1; k <= wide; k++) {
    cost += (k * (k > tierSize ? 3 : 1)) / 1_000_000
    input += k
  }
  const rank = (percent: number) => Math.ceil((wide * percent) / 100)
  const rate = (k: number) => (100 * 1_000_000_000) / (k * 1_000_000)
  return {
    cost,
    input,
    speed: {
      samples: wide,
      generationSamples: wide,
      providerTimedSamples: wide,
      observedSamples: 0,
      firstOutputP50Ms: rank(50),
      firstOutputP95Ms: rank(95),
      totalP50Ms: 2 * rank(50),
      totalP95Ms: 2 * rank(95),
      generationP50TokensPerSecond: rate(wide - rank(50) + 1),
      generationP90TokensPerSecond: rate(wide - rank(90) + 1),
      outputTokensPerSecond: (100 * wide) / ((input * 1_000_000) / 1_000_000_000),
    },
  }
})()

const expectSpeed = (speed: object | undefined) => {
  expect(speed).toBeDefined()
  for (const [name, value] of Object.entries(wideExpected.speed))
    expect((speed as Record<string, number>)[name]).toBeCloseTo(value, 6)
}

const drain = (db: Database.Interface["db"], sessionID?: SessionSchema.ID) =>
  Effect.gen(function* () {
    const where = SessionUsageRead.usageWhere({ providerID: Provider.ID.make("openai") }, sessionID ? [sessionID] : undefined)
    const pages: number[] = []
    const rows: Unpriced[] = []
    let after: string | undefined
    while (true) {
      const page = yield* SessionUsageRead.unpriced(db, where, after, sessionID, SessionUsageRead.pieces({}))
      pages.push(page.rows.length)
      rows.push(...page.rows)
      if (page.after === undefined) return { pages, rows }
      after = page.after
    }
  })

test("a single cell with more distinct pricing contexts and latency values than a statement window is read in bounded pages with exact results", () => {
  const fixture = harness()
  return Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Session.Service
      const database = yield* Database.Service
      fixture.bounds.rows = 0
      fixture.bounds.changes = 0

      for (const sessionID of [undefined, wideSession]) {
        const { pages, rows } = yield* drain(database.db, sessionID)
        expect(Math.max(...pages)).toBe(200)
        expect(rows.length).toBe(wide)
        expect(new Set(rows.map((row) => row.context)).size).toBe(wide)
        expect(rows.reduce((sum, row) => sum + row.requests, 0)).toBe(wide)
        expect(rows.reduce((sum, row) => sum + row.record.tokens.input, 0)).toBe(wideExpected.input)
      }

      const backend = yield* session.usageReportAll({ group: "model", providerID: Provider.ID.make("openai") })
      expect(backend.rowCount).toBe(1)
      expect(backend.total.logical).toBe(wide)
      expect(backend.total.cost).toBeCloseTo(wideExpected.cost, 9)
      expect(backend.total.costProvenance).toBe("current_catalog")
      expect(backend.rows[0]!.cost).toBeCloseTo(wideExpected.cost, 9)
      expectSpeed(backend.rows[0]!.speed)

      const family = yield* session.usageReport({ sessionID: wideSession, group: "model" })
      expect(family.total.cost).toBeCloseTo(wideExpected.cost, 9)
      expect(family.total.costProvenance).toBe("current_catalog")
      expectSpeed(family.rows[0]!.speed)

      const summary = yield* session.usage(wideSession)
      expect(summary.logical).toBe(wide)
      expect(summary.cost).toBeCloseTo(wideExpected.cost, 9)
      expect(summary.latestNamespace).toBe(`w${String(wide).padStart(7, "0")}`)

      const costs = yield* session.promptCosts({
        sessionID: wideSession,
        inputIDs: [SessionMessage.ID.make("msg_bounded_missing")],
      })
      expect(costs.unattributed.requests).toBe(wide)
      expect(costs.unattributed.tokens.input).toBe(wideExpected.input)
      expect(costs.unattributed.cost.pricedRequests).toBe(wide)
      expect(costs.unattributed.cost.unpricedRequests).toBe(0)
      expect(costs.unattributed.cost.known).toBeCloseTo(wideExpected.cost, 9)
      expect(costs.unattributed.cost.provenance).toBe("current_catalog")

      expect(fixture.bounds.rows).toBeLessThanOrEqual(statementRows)
      expect(fixture.bounds.changes).toBeLessThanOrEqual(statementRows)
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 300_000)

test("latest request and prompt attribution stay exact across more same-millisecond cells than a statement window", () => {
  const fixture = harness()
  return Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Session.Service
      fixture.bounds.rows = 0
      fixture.bounds.changes = 0
      const namespace = `t${String(tied).padStart(7, "0")}`

      expect((yield* session.usage(tiedSession)).latestNamespace).toBe(namespace)
      expect((yield* session.usageAll()).latestNamespace).toBe(namespace)

      const prompt = yield* session.usageReport({ sessionID: tiedSession, group: "prompt" })
      expect(prompt.rowCount).toBe(1)
      expect(prompt.rows[0]!.dimensions).toEqual({ group: "prompt", attribution: "unattributed" })
      expect(prompt.total.logical).toBe(tied)
      expect(prompt.total.cost).toBeCloseTo(tied * 0.001, 9)
      expect(prompt.total.costProvenance).toBe("recorded")

      expect(fixture.bounds.rows).toBeLessThanOrEqual(statementRows)
      expect(fixture.bounds.changes).toBeLessThanOrEqual(statementRows)
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 300_000)

test("a task path shared by two report rows pages each row's latency distribution through one cell exactly once per row", () => {
  const outer = SessionSchema.ID.make("ses_bounded_task_outer")
  const inner = SessionSchema.ID.make("ses_bounded_task_inner")
  const fixture = harness([outer, inner])
  return Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Session.Service
      fixture.bounds.rows = 0
      fixture.bounds.changes = 0

      const report = yield* session.usageReportAll({ group: "task", providerID: Provider.ID.make("openai") })
      expect(report.rowCount).toBe(2)
      expect(report.rows.map((row) => row.dimensions)).toEqual([
        { group: "task", attribution: "complete", sessionID: inner },
        { group: "task", attribution: "complete", sessionID: outer },
      ])
      for (const row of report.rows) {
        expect(row.logical).toBe(wide)
        expect(row.tokens.input).toBe(wideExpected.input)
        expect(row.cost).toBeCloseTo(wideExpected.cost, 9)
        expect(row.costProvenance).toBe("current_catalog")
        expect(row.costCoverage).toEqual({ pricedRequests: wide, unpricedRequests: 0 })
        expectSpeed(row.speed)
      }
      expect(report.total.logical).toBe(wide)
      expect(report.total.tokens.input).toBe(wideExpected.input)
      expect(report.total.cost).toBeCloseTo(wideExpected.cost, 9)
      expect(report.total.costProvenance).toBe("current_catalog")
      expect(report.total.costCoverage).toEqual({ pricedRequests: wide, unpricedRequests: 0 })

      expect(fixture.bounds.rows).toBeLessThanOrEqual(statementRows)
      expect(fixture.bounds.changes).toBeLessThanOrEqual(statementRows)
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 300_000)
