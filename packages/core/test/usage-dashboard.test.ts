import { expect, test } from "bun:test"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Clock, Context, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Scope } from "effect"
import { sql } from "drizzle-orm"
import { Catalog } from "../src/catalog"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { sqliteLayer } from "../src/database/sqlite.bun"
import { Sqlite } from "../src/database/sqlite"
import { UsageStage } from "../src/usage-stage"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TestClock } from "effect/testing"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventRuntime } from "../src/event"
import { Location } from "../src/location"
import { LocationServiceMap } from "../src/location-service-map"
import { CatalogContributions } from "../src/plugin/catalog-contributions"
import { fixedLocations } from "./fixture/location-map"
import type { LocationServices } from "../src/location-services"
import { CatalogModel } from "../src/model"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { ProviderUsageRuntime } from "../src/provider-usage"
import { RetentionSettings } from "../src/retention-settings"
import { Session } from "../src/session"
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { SessionSchema } from "../src/session/schema"
import { SessionTable } from "../src/session/sql"
import { UsageAnalytics } from "../src/usage-analytics"
import { UsageDashboardRuntime } from "../src/usage-dashboard"
import { UsageDashboardRead } from "../src/usage-dashboard-read"
import { GenerationActivity } from "../src/generation-activity"
import { UsageViews } from "../src/usage-view"
import { UsageViewStart } from "../src/usage-view-start"
import { UsageViewRecipe } from "../src/usage-view-recipe"
import { Agent } from "@ycoding-ai/schema/agent"
import { Model } from "@ycoding-ai/schema/model"
import { Money } from "@ycoding-ai/schema/money"
import { Provider } from "@ycoding-ai/schema/provider"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import type { UsageDashboard } from "@ycoding-ai/schema/usage-dashboard"
import { AbsolutePath } from "@ycoding-ai/schema/schema"

const minute = 60_000
const hour = 3_600_000
const day = 86_400_000
const base = Math.floor((Date.now() - 3 * day) / day) * day + 9 * hour

const Watched = Context.Reference<boolean>("test/usage-dashboard/Watched", { defaultValue: () => false })

const analytics = /\b(?:from|join)\s+["`]?(?:usage_analytics_request|session_provider_request|usage_analytics_cell\w*|session_usage_cell\w*)["`]?(?![\w$])/i

function harness(options: { readonly path?: string } = {}) {
  const queries: string[] = []
  const statements: { readonly sql: string; readonly params: ReadonlyArray<unknown> }[] = []
  let native: import("bun:sqlite").Database | undefined
  const hooks: {
    inspect?: (query: string, params: ReadonlyArray<unknown>) => void
    gate?: (query: string) => Effect.Effect<void>
  } = {}
  const lookups: string[] = []
  const prices = new Map<string, number>([["/dash-a", 2]])
  const unbootable = new Set<string>()
  const retention = { usageDays: 30 }
  const logged = EffectDrizzleSqlite.make().pipe(
    Effect.provideService(EffectDrizzleSqlite.EffectLogger, {
      logQuery: (query, params) =>
        Effect.gen(function* () {
          statements.push({ sql: query, params })
          hooks.inspect?.(query, params)
          if (yield* Watched) queries.push(query)
          if (hooks.gate) yield* hooks.gate(query)
        }),
    }),
    Effect.provide(EffectDrizzleSqlite.DefaultServices),
  )
  const readonly = (filename: string) =>
    Layer.build(sqliteLayer({ filename, readonly: true, readwrite: false, create: false, disableWAL: true })).pipe(
      Effect.flatMap((context) => logged.pipe(Effect.provide(context))),
      Effect.orDie,
    )
  const database = Layer.effect(
    Database.Service,
    Effect.gen(function* () {
      const db = yield* logged
      native = (yield* Sqlite.Native) as import("bun:sqlite").Database
      if (options.path) yield* db.run("PRAGMA journal_mode = WAL")
      yield* DatabaseMigration.apply(db)
      if (!options.path) return { db }
      return { db, reader: yield* readonly(options.path), connect: readonly(options.path) }
    }),
  ).pipe(Layer.provide(sqliteLayer({ filename: options.path ?? ":memory:" })))
  const catalog = (directory: string) =>
    Context.make(Catalog.Service, {
      model: {
        get: (provider: Provider.ID, id: CatalogModel.ID) =>
          Effect.gen(function* () {
            if (yield* Watched) lookups.push(`${directory}:${provider}:${id}`)
            const price = prices.get(directory)
            return {
              ...CatalogModel.Info.empty(provider, id),
              cost:
                price === undefined || provider === Provider.ID.openrouter
                  ? []
                  : [
                      {
                        input: Money.USDPerMillionTokens.make(price),
                        output: Money.USDPerMillionTokens.make(1),
                        cache: { read: Money.USDPerMillionTokens.make(0), write: Money.USDPerMillionTokens.make(0) },
                      },
                      {
                        tier: { type: "context" as const, size: 1_000 },
                        input: Money.USDPerMillionTokens.make(price * 3),
                        output: Money.USDPerMillionTokens.make(3),
                        cache: { read: Money.USDPerMillionTokens.make(0), write: Money.USDPerMillionTokens.make(0) },
                      },
                    ],
            }
          }),
      },
    } as unknown as Catalog.Interface) as Context.Context<LocationServices>
  const locations = Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const map = yield* fixedLocations(
        (ref: Location.Ref) =>
          Layer.effectContext(
            Effect.suspend(() =>
              unbootable.has(ref.directory) ? Effect.die(new Error("synthetic Location boot failure")) : Effect.succeed(catalog(ref.directory)),
            ),
          ),
        { idleTimeToLive: "60 minutes" },
      )
      return map
    }),
  )
  const runtime = AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventRuntime.node,
      Session.node,
      UsageAnalytics.node,
      UsageViews.node,
      LocationServiceMap.node,
      UsageViewStart.node,
    ]),
    [
      [Database.node, database],
      [SessionExecution.node, SessionExecution.noopLayer],
      [LocationServiceMap.node, locations],
      [
        RetentionSettings.node,
        Layer.succeed(RetentionSettings.Service, {
          read: () => Effect.sync(() => ({ recordsDays: 30, usageDays: retention.usageDays, latencyDays: 30, incidentDays: 30 })),
        }),
      ],
    ],
  )
  const watch = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      queries.length = 0
      const before = lookups.length
      const result = yield* effect.pipe(Effect.provideService(Watched, true))
      return {
        result,
        analytics: queries.filter((query) => analytics.test(query) || /\btemp\./i.test(query)),
        lookups: lookups.length - before,
      }
    })
  const explain = (query: string, params: ReadonlyArray<unknown>) => {
    const statement = native!.prepare<{ detail: string }, import("bun:sqlite").SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${query}`)
    try {
      return statement.all(...(params as import("bun:sqlite").SQLQueryBindings[]))
    } finally {
      statement.finalize()
    }
  }
  const count = (query: string, params: ReadonlyArray<unknown>) => {
    const statement = native!.prepare<{ count: number }, import("bun:sqlite").SQLQueryBindings[]>(`SELECT count(*) AS count FROM (${query})`)
    try {
      return statement.get(...(params as import("bun:sqlite").SQLQueryBindings[]))?.count ?? 0
    } finally {
      statement.finalize()
    }
  }
  return { queries, statements, hooks, lookups, prices, unbootable, retention, runtime, watch, explain, count }
}

type Spec = {
  readonly id: string
  readonly session: string
  readonly request: number
  readonly time: number
  readonly provider: string
  readonly model: string
  readonly cost?: number
  readonly input: number
  readonly total?: number
  readonly first?: number
  readonly outcome?: ProviderRequest.Outcome
}

const seedSessions = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/dash"), sandboxes: [] }).run()
  for (const [id, directory] of [
    ["ses_dash_a", "/dash-a"],
    ["ses_dash_b", "/dash-b"],
  ] as const)
    yield* db
      .insert(SessionTable)
      .values({ id: SessionSchema.ID.make(id), project_id: Project.ID.global, directory, title: id })
      .run()
}).pipe(Effect.orDie)

const record = (spec: Spec) =>
  Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    yield* events.publish(SessionEvent.ProviderRequestRecorded, {
      id: ProviderRequest.ID.make(spec.id),
      sessionID: SessionSchema.ID.make(spec.session),
      source: "step" as const,
      agent: Agent.ID.make("build"),
      model: Model.Ref.make({ providerID: Provider.ID.make(spec.provider), id: Model.ID.make(spec.model) }),
      routeID: "route",
      promptCacheKey: `ns-${spec.id}`,
      systemDigest: "system",
      toolDigest: "tools",
      request: spec.request,
      attempts: 1,
      invalidation: "first-request" as const,
      continuation: "full" as const,
      ...(spec.outcome === undefined ? {} : { outcome: spec.outcome }),
      ...(spec.cost === undefined ? {} : { cost: Money.USD.make(spec.cost) }),
      ...(spec.total === undefined
        ? {}
        : {
            timing: {
              totalMs: spec.total,
              firstOutputMs: spec.first ?? 1,
              generatedTokens: 10 + (spec.total % 7),
              generationDurationNs: 1_000_000_000 + (spec.total % 5) * 100_000_000,
            },
          }),
      tokens: { input: spec.input, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
      time: DateTime.makeUnsafe(spec.time),
    })
  })

const specs = (count: number, offset = 0): Spec[] =>
  Array.from({ length: count }, (_, index) => {
    const value = index + offset
    return {
      id: `prq_dash_${value.toString().padStart(5, "0")}`,
      session: value % 3 === 0 ? "ses_dash_b" : "ses_dash_a",
      request: value + 1,
      time: base + value * 7 * minute + (value % 11),
      provider: value % 4 === 0 ? "anthropic" : "openai",
      model: `m${value % 3}`,
      ...(value % 5 === 0 ? {} : { cost: 0.001 * ((value % 9) + 1) }),
      input: value % 7 === 0 ? 1_500 : 100 + value,
      total: 50 + ((value * 37) % 400),
      first: (value * 13) % 50,
      ...(value % 4 === 0 ? {} : { outcome: (["completed", "failed", "cancelled"] as const)[(value % 4) - 1] }),
    }
  })

const normalize = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_, item) => (typeof item === "number" && !Number.isInteger(item) ? Number(item.toPrecision(12)) : item)))

const recipes: ReadonlyArray<ProviderRequest.ReportInput> = [
  { group: "day", from: base - day, to: base + 4 * day, timeZone: "America/New_York", limit: 30, sort: "key", order: "asc" },
  { group: "model", from: base, to: base + 3 * day, limit: 200, sort: "cost", order: "desc" },
  { group: "provider-model", from: base + 3_333, to: base + 2 * day + 17, offset: 1, limit: 2, sort: "tokens", order: "desc" },
  { group: "session", sort: "steps", order: "asc" },
  { group: "hour", timeZone: "Asia/Kathmandu", from: base, to: base + day, sort: "key", order: "desc", limit: 5 },
  { group: "provider", providerID: Provider.ID.make("openai"), from: base, to: base + 2 * day, sort: "cost", order: "desc" },
]

const filteredDaily: ProviderRequest.ReportInput = {
  group: "day",
  providerID: Provider.ID.make("openai"),
  modelID: Model.ID.make("m1"),
  timeZone: "America/New_York",
  from: base - day,
  to: base + 4 * day,
  sort: "key",
  order: "asc",
}

const readViewsCapability = Effect.map(
  LocationServiceMap.Service,
  (locations) => (ref: Location.Ref) =>
    Effect.map(locations.contextEffect(ref, CatalogContributions.nodes), (context) => Context.get(context, Catalog.Service)),
)

const anyHeld = () => Effect.succeed(true)

const readViews = (reports: ReadonlyArray<ProviderRequest.ReportInput>) =>
  Effect.flatMap(UsageViews.Service, (views) => views.read(reports))

const settled = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* until(
    db
      .get<{ count: number }>(
        sql`SELECT count(*) AS count FROM usage_view_state
        WHERE status IN ('pending', 'building') AND time_used >= ${Date.now() - 3_600_000}`,
      )
      .pipe(Effect.orDie, Effect.map((row) => row?.count ?? 0)),
    (count) => count === 0,
    "settled producer",
  )
})

const until = <A, E, R>(effect: Effect.Effect<A, E, R>, done: (value: A) => boolean, label: string) =>
  Effect.gen(function* () {
    const started = Date.now()
    while (true) {
      const value = yield* effect
      if (done(value)) return value
      if (Date.now() - started > 30_000) return yield* Effect.die(new Error(`Timed out waiting for ${label}`))
      yield* Effect.sleep("20 millis")
    }
  })

const ready = (reports: ReadonlyArray<ProviderRequest.ReportInput>) =>
  Effect.gen(function* () {
    return yield* until(readViews(reports), (value) => value.status === "ready", "ready views")
  }).pipe(Effect.map((value) => value as Extract<UsageViews.Lookup, { status: "ready" }>))

const oracle = (reports: ReadonlyArray<ProviderRequest.ReportInput>) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return {
      summary: yield* sessions.usageAll(),
      reports: yield* Effect.forEach(reports, (input) => sessions.usageReportAll(input)),
    }
  })

test("registered views prepare exact summary and report recipes and serve ready reads without analytics or catalog work", () => {
  const fixture = harness()
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* seedSessions
      for (const spec of specs(60)) yield* record(spec)
      const miss = yield* fixture.watch(readViews(recipes))
      expect(miss.result.status).toBe("preparing")
      expect(miss.analytics).toEqual([])
      expect(miss.lookups).toBe(0)
      const prepared = yield* ready(recipes)
      const served = yield* fixture.watch(readViews(recipes))
      expect(served.result.status).toBe("ready")
      expect(served.analytics).toEqual([])
      expect(served.lookups).toBe(0)
      const expected = yield* oracle(recipes)
      expect(normalize(prepared.summary)).toEqual(normalize(expected.summary))
      expect(normalize(prepared.reports)).toEqual(normalize(expected.reports))
      expect(prepared.reports.every((report) => report.speed !== undefined)).toBe(true)
      const filtered = (yield* ready([filteredDaily])).reports[0]!
      expect(normalize(filtered)).toEqual(normalize((yield* oracle([filteredDaily])).reports[0]))
      expect(filtered.total.logical).toBeGreaterThan(0)
      expect(filtered.total.logical).toBeLessThan(prepared.reports[0]!.total.logical)
      expect(filtered.speed!.samples).toBe(filtered.total.logical)
      expect(filtered.rows.every((row) => row.concurrency !== undefined && row.outcomes !== undefined)).toBe(true)
      const tasks: ReadonlyArray<ProviderRequest.ReportInput> = [{ group: "task", sort: "cost", order: "desc" }]
      const task = yield* ready(tasks)
      expect(task.reports[0]!.speed).toBeDefined()
      expect(normalize(task.reports)).toEqual(normalize((yield* oracle(tasks)).reports))
      const empty = yield* fixture.watch(readViews([]))
      expect(empty.result).toMatchObject({ status: "ready", reports: [] })
      expect(empty.analytics).toEqual([])
      const other = yield* ready([recipes[1]!, { ...recipes[1]!, offset: 1, limit: 1 }])
      expect(other.revision).toBe(prepared.revision)
      const generation = yield* generationOf(filteredDaily)
      for (const spec of specs(24, 60)) yield* record(spec)
      const appended = yield* until(
        readViews([filteredDaily]),
        (value) => value.status === "ready" && value.revision !== prepared.revision,
        "filtered daily append",
      )
      expect(appended.status === "ready" && normalize(appended.reports)).toEqual(normalize((yield* oracle([filteredDaily])).reports))
      expect(appended.status === "ready" && appended.reports[0]!.total.logical).toBeGreaterThan(filtered.total.logical)
      expect(yield* generationOf(filteredDaily)).toBe(generation)
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 120_000)

test("retention removal and catalog revaluation invalidate only through exact republished views", () => {
  const fixture = harness()
  return Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventRuntime.Service
      const usage = yield* UsageAnalytics.Service
      yield* seedSessions
      for (const spec of specs(50)) yield* record(spec)
      const whole: ProviderRequest.ReportInput = { group: "model", sort: "cost", order: "desc" }
      const before = yield* ready([whole])
      const cutoff = base + 120 * minute + 5
      expect(yield* usage.cleanup(cutoff + 30 * day)).toBeGreaterThan(0)
      const removed = yield* until(
        readViews([whole]),
        (value) => value.status === "ready" && value.revision !== before.revision,
        "retention republish",
      )
      const expected = yield* oracle([whole])
      expect(removed.status === "ready" && normalize(removed.reports)).toEqual(normalize(expected.reports))
      expect(removed.status === "ready" && normalize(removed.summary)).toEqual(normalize(expected.summary))
      fixture.prices.set("/dash-a", 5)
      yield* events.publish(Catalog.Event.Updated, {})
      expect((yield* readViews([whole])).status).toBe("preparing")
      const repriced = yield* ready([whole])
      const revalued = yield* oracle([whole])
      expect(normalize(repriced.reports)).toEqual(normalize(revalued.reports))
      expect(normalize(repriced.summary)).toEqual(normalize(revalued.summary))
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 120_000)

test("registrations stay bounded by evicting the least recently used recipes", () => {
  const fixture = harness()
  return Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedSessions
      for (const index of Array.from({ length: UsageViews.limits.states + 8 }, (_, value) => value))
        yield* readViews([{ group: "model", from: base + index, to: base + day }])
      const count = yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM usage_view_state WHERE status <> 'evicted'`)
      expect(count!.count).toBeLessThanOrEqual(UsageViews.limits.states)
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 60_000)

const generations = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return new Map(
    (yield* db.all<{ id: string; generation: number }>(
      sql`SELECT id, generation FROM usage_view_state WHERE status = 'ready' ORDER BY id`,
    )).map((row) => [row.id, row.generation]),
  )
}).pipe(Effect.orDie)

const generationOf = (input: ProviderRequest.ReportInput) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return (yield* db.get<{ generation: number }>(
      sql`SELECT generation FROM usage_view_state WHERE id = ${JSON.stringify(UsageViewRecipe.state(input))}`,
    ))?.generation
  }).pipe(Effect.orDie)

test("registered views keep publishing ready revisions while a writer is still appending, without rebuilding existing recipes", () => {
  const fixture = harness()
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* seedSessions
      for (const spec of specs(40)) yield* record(spec)
      const first = yield* ready(recipes)
      const before = yield* generations
      const stop = yield* Deferred.make<void>()
      let writing = true
      let written = 0
      const writer = yield* Effect.gen(function* () {
        for (const spec of specs(400, 40)) {
          if (yield* Deferred.isDone(stop)) break
          yield* record(spec)
          written += 1
          yield* Effect.sleep("2 millis")
        }
      }).pipe(
        Effect.ensuring(Effect.sync(() => void (writing = false))),
        Effect.forkChild,
      )
      const revisions = new Set<string>([first.revision])
      const started = Date.now()
      while (revisions.size < 4) {
        expect(Date.now() - started).toBeLessThan(30_000)
        const read = yield* readViews(recipes)
        if (read.status === "ready") {
          expect(writing).toBe(true)
          revisions.add(read.revision)
        }
        yield* Effect.sleep("3 millis")
      }
      yield* Deferred.succeed(stop, undefined)
      yield* Fiber.join(writer)
      expect(written).toBeLessThan(400)
      expect(yield* generations).toEqual(before)
      const after = yield* ready(recipes)
      const expected = yield* oracle(recipes)
      expect(normalize(after.summary)).toEqual(normalize(expected.summary))
      expect(normalize(after.reports)).toEqual(normalize(expected.reports))
      expect(yield* generations).toEqual(before)
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 120_000)

test("the change journal holds only source references and markers, and retention leaves no expired facts in prepared views", () => {
  const fixture = harness()
  return Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const usage = yield* UsageAnalytics.Service
      yield* seedSessions
      for (const spec of specs(12)) yield* record(spec)
      const columns = (yield* db.all<{ name: string }>(sql`PRAGMA table_info('usage_view_change')`)).map((row) => row.name)
      expect(columns.toSorted()).toEqual(["kind", "seq", "source", "through"])
      expect((yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM usage_view_change WHERE kind = 'append'`))!.count).toBe(12)
      yield* settled
      expect(yield* usage.cleanup(base + 40 * day)).toBe(12)
      expect((yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM usage_analytics_request`))!.count).toBe(0)
      const remaining = Effect.forEach(
        [
          "usage_view_change",
          "usage_view_row WHERE key <> '' OR logical <> 0",
          "usage_view_sample",
          "usage_view_rank",
          "usage_view_ref",
        ],
        (table) =>
          db.get<{ count: number }>(sql.raw(`SELECT count(*) AS count FROM ${table}`)).pipe(Effect.orDie, Effect.map((row) => row?.count ?? 0)),
      )
      yield* until(remaining, (counts) => counts.every((count) => count === 0), "expired prepared facts")
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 60_000)

test("abandoned and failed consumers stop pinning the journal and recover only by explicit rebuild", () => {
  const fixture = harness()
  return Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const usage = yield* UsageAnalytics.Service
      const views = yield* UsageViews.Service
      yield* seedSessions
      for (const spec of specs(20)) yield* record(spec)
      yield* ready([recipes[1]!])
      yield* db.run(sql`UPDATE usage_view_state SET time_used = 0`)
      for (const spec of specs(10, 20)) yield* record(spec)
      yield* usage.cleanup(base - 400 * day)
      expect((yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM usage_view_change`))!.count).toBe(0)
      expect((yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM usage_view_state WHERE status = 'ready'`))!.count).toBe(0)
      const rebuilt = yield* ready([recipes[1]!])
      const expected = yield* oracle([recipes[1]!])
      expect(normalize(rebuilt.reports)).toEqual(normalize(expected.reports))
      yield* db
        .insert(SessionTable)
        .values({ id: SessionSchema.ID.make("ses_dash_c"), project_id: Project.ID.global, directory: "/dash-c", title: "c" })
        .run()
      yield* views.start(() => Effect.die(new Error("catalog unavailable")), anyHeld)
      const failing = yield* views.read([{ group: "provider", from: base, to: base + 9 * day }])
      yield* record({ id: "prq_dash_new_location", session: "ses_dash_c", request: 1, time: base + 3 * hour, provider: "openai", model: "m9", input: 42 })
      expect(failing.status).toBe("preparing")
      yield* until(
        views.read([{ group: "provider", from: base, to: base + 9 * day }]),
        (value) => value.status === "ready",
        "unpriced preparation",
      )
      yield* views.start(yield* readViewsCapability, anyHeld)
      const retried = yield* views.read([{ group: "provider", from: base, to: base + 9 * day }], { refresh: true })
      expect(retried.status).toBe("preparing")
      const recovered = yield* until(
        views.read([{ group: "provider", from: base, to: base + 9 * day }]),
        (value) => value.status === "ready",
        "explicit retry",
      )
      expect(recovered.status === "ready" && normalize(recovered.reports)).toEqual(
        normalize((yield* oracle([{ group: "provider", from: base, to: base + 9 * day }])).reports),
      )
      const generation = yield* generationOf({ group: "provider", from: base, to: base + 9 * day })
      for (let poll = 0; poll < 5; poll++) expect((yield* views.read([{ group: "provider", from: base, to: base + 9 * day }])).status).toBe("ready")
      expect(yield* generationOf({ group: "provider", from: base, to: base + 9 * day })).toBe(generation)
      for (const spec of specs(5, 30)) yield* record(spec)
      yield* usage.cleanup(base - 400 * day)
      const floor = (yield* db.get<{ floor: number | null }>(sql`SELECT min(applied_seq) AS floor FROM usage_view_state WHERE status = 'ready'`))!.floor
      expect((yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM usage_view_change WHERE seq <= ${floor ?? 0}`))!.count).toBe(0)
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 120_000)

test("a restarted owner catches up from the journal and rebuilds when its journal position was pruned", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-dashboard-"))
  const path = join(directory, "usage.db")
  try {
    const first = harness({ path })
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedSessions
        for (const spec of specs(20).map((spec) => ({ ...spec, cost: spec.cost ?? 0.002 }))) yield* record(spec)
        yield* ready([recipes[1]!])
      }).pipe(Effect.provide(first.runtime), Effect.scoped),
    )
    const second = harness({ path })
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        for (const spec of specs(6, 20).map((spec) => ({ ...spec, cost: spec.cost ?? 0.002 }))) yield* record(spec)
        const generation = yield* generationOf(recipes[1]!)
        const caught = yield* ready([recipes[1]!])
        expect(yield* generationOf(recipes[1]!)).toBe(generation)
        expect(normalize(caught.reports)).toEqual(normalize((yield* oracle([recipes[1]!])).reports))
        for (const spec of specs(3, 26).map((spec) => ({ ...spec, cost: spec.cost ?? 0.002 }))) yield* record(spec)
        const head = (yield* db.get<{ seq: number }>(sql`SELECT seq FROM sqlite_sequence WHERE name = 'usage_view_change'`))!.seq
        yield* db.run(sql`DELETE FROM usage_view_change`)
        yield* db.run(sql`INSERT INTO usage_view_journal (id, pruned) VALUES (1, ${head}) ON CONFLICT (id) DO UPDATE SET pruned = excluded.pruned`)
        const recovered = yield* ready([recipes[1]!])
        expect(yield* generationOf(recipes[1]!)).toBeGreaterThan(generation!)
        expect(normalize(recovered.reports)).toEqual(normalize((yield* oracle([recipes[1]!])).reports))
      }).pipe(Effect.provide(second.runtime), Effect.scoped),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 120_000)

const builds = (statements: ReadonlyArray<{ readonly sql: string }>) =>
  statements.filter((statement) => /SET status = 'building'/.test(statement.sql)).length

const states = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return new Map(
    (yield* db.all<{ id: string; generation: number; status: string }>(
      sql`SELECT id, generation, status FROM usage_view_state ORDER BY id`,
    )).map((row) => [row.id, row]),
  )
}).pipe(Effect.orDie)

test("a restart with unchanged catalog prices serves prepared views without rebuilding, and a changed price rebuilds only views that used it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-dashboard-"))
  const path = join(directory, "usage.db")
  const onlyB: ProviderRequest.ReportInput = { group: "model", from: base, to: base + 5 * 7 * minute, sort: "key", order: "asc" }
  const withA: ProviderRequest.ReportInput = { group: "model", from: base + 5 * 7 * minute, to: base + 11 * 7 * minute, sort: "key", order: "asc" }
  try {
    const first = harness({ path })
    const before = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedSessions
        for (const spec of specs(20)) yield* record(spec)
        const prepared = yield* ready([onlyB, withA])
        yield* settled
        return { prepared, states: yield* states }
      }).pipe(Effect.provide(first.runtime), Effect.scoped),
    )
    const second = harness({ path })
    await Effect.runPromise(
      Effect.gen(function* () {
        const served = yield* ready([onlyB, withA])
        expect(served.revision).toBe(before.prepared.revision)
        expect(normalize(served.reports)).toEqual(normalize(before.prepared.reports))
        yield* settled
        expect(builds(second.statements)).toBe(0)
        expect(yield* states).toEqual(before.states)
      }).pipe(Effect.provide(second.runtime), Effect.scoped),
    )
    const third = harness({ path })
    third.prices.set("/dash-a", 7)
    await Effect.runPromise(
      Effect.gen(function* () {
        const repriced = yield* ready([onlyB, withA])
        yield* settled
        const after = yield* states
        const generation = (input: ProviderRequest.ReportInput) => after.get(JSON.stringify(UsageViewRecipe.state(input)))?.generation
        const previous = (input: ProviderRequest.ReportInput) => before.states.get(JSON.stringify(UsageViewRecipe.state(input)))?.generation
        expect(generation(onlyB)).toBe(previous(onlyB))
        expect(generation(withA)).toBe(previous(withA)! + 1)
        expect(after.get(UsageViewRecipe.summaryState)?.generation).toBe(before.states.get(UsageViewRecipe.summaryState)!.generation + 1)
        expect(repriced.revision).not.toBe(before.prepared.revision)
        expect(normalize(repriced.reports)).toEqual(normalize((yield* oracle([onlyB, withA])).reports))
        expect(normalize(repriced.summary)).toEqual(normalize((yield* oracle([])).summary))
      }).pipe(Effect.provide(third.runtime), Effect.scoped),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 120_000)

test("a ready view answers while another view's build holds its snapshot open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-dashboard-"))
  const path = join(directory, "usage.db")
  const fixture = harness({ path })
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedSessions
        for (const spec of specs(30)) yield* record(spec)
        const warm = yield* ready([recipes[1]!])
        yield* settled
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        fixture.hooks.gate = (query) =>
          /temp\.usage_partial|temp\.usage_build_/.test(query)
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void
        const custom: ProviderRequest.ReportInput = { group: "session", from: base + 1, to: base + day, sort: "key", order: "asc" }
        expect((yield* readViews([custom])).status).toBe("preparing")
        yield* Deferred.await(entered).pipe(Effect.timeout("10 seconds"))
        const answered = yield* Deferred.make<UsageViews.Lookup>()
        const reading = yield* readViews([recipes[1]!]).pipe(
          Effect.flatMap((value) => Deferred.succeed(answered, value)),
          Effect.forkChild,
        )
        const during = yield* Deferred.await(answered).pipe(
          Effect.timeoutOption("2 seconds"),
          Effect.ensuring(
            Effect.suspend(() => {
              fixture.hooks.gate = undefined
              return Deferred.succeed(release, undefined)
            }),
          ),
        )
        yield* Fiber.join(reading)
        expect(Option.getOrUndefined(during)).toMatchObject({ status: "ready", revision: warm.revision })
        const built = yield* ready([custom])
        expect(normalize(built.reports)).toEqual(normalize((yield* oracle([custom])).reports))
      }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 120_000)

test("catalog updates for one Location neither unverify nor restart preparation of views priced from other Locations", () => {
  const fixture = harness()
  const onlyB: ProviderRequest.ReportInput = { group: "model", from: base, to: base + 5 * 7 * minute, sort: "key", order: "asc" }
  const withA: ProviderRequest.ReportInput = { group: "model", from: base + 5 * 7 * minute, to: base + 11 * 7 * minute, sort: "key", order: "asc" }
  return Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventRuntime.Service
      yield* seedSessions
      for (const spec of specs(20)) yield* record(spec)
      const first = yield* ready([onlyB])
      yield* settled
      const elsewhere = { location: Location.Ref.make({ directory: AbsolutePath.make("/dash-z"), workspaceID: undefined }) }
      yield* events.publish(Catalog.Event.Updated, {}, elsewhere)
      expect(yield* readViews([onlyB])).toMatchObject({ status: "ready", revision: first.revision })
      let published = 0
      fixture.hooks.gate = (query) =>
        /\bunpriced > 0\b/.test(query)
          ? Effect.suspend(() => {
              published += 1
              return events.publish(Catalog.Event.Updated, {}, elsewhere).pipe(Effect.asVoid)
            })
          : Effect.void
      expect((yield* readViews([withA])).status).toBe("preparing")
      const built = yield* until(readViews([withA]), (value) => value.status !== "preparing", "isolated preparation")
      fixture.hooks.gate = undefined
      expect(published).toBeGreaterThan(0)
      expect(built.status).toBe("ready")
      expect(built.status === "ready" && normalize(built.reports)).toEqual(normalize((yield* oracle([withA])).reports))
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 60_000)

test("repeated catalog updates for a Location that a view uses during its preparation still publish it once its prices verify", () => {
  const fixture = harness()
  const withA: ProviderRequest.ReportInput = { group: "model", from: base + 5 * 7 * minute, to: base + 11 * 7 * minute, sort: "key", order: "asc" }
  return Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventRuntime.Service
      yield* seedSessions
      for (const spec of specs(20)) yield* record(spec)
      yield* settled
      const used = { location: Location.Ref.make({ directory: AbsolutePath.make("/dash-a"), workspaceID: undefined }) }
      let published = 0
      fixture.hooks.gate = (query) =>
        /\bunpriced > 0\b/.test(query)
          ? Effect.suspend(() => {
              published += 1
              return events.publish(Catalog.Event.Updated, {}, used).pipe(Effect.asVoid)
            })
          : Effect.void
      expect((yield* readViews([withA])).status).toBe("preparing")
      const built = yield* until(readViews([withA]), (value) => value.status !== "preparing", "preparation during catalog updates")
      fixture.hooks.gate = undefined
      expect(published).toBeGreaterThan(3)
      expect(built.status).toBe("ready")
      expect(built.status === "ready" && normalize(built.reports)).toEqual(normalize((yield* oracle([withA])).reports))
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 60_000)

test("a historical Location that cannot boot leaves its requests unpriced instead of failing prepared accounting", () => {
  const fixture = harness()
  fixture.unbootable.add("/dash-a")
  const withA: ProviderRequest.ReportInput = { group: "model", from: base + 5 * 7 * minute, to: base + 11 * 7 * minute, sort: "key", order: "asc" }
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* seedSessions
      for (const spec of specs(20)) yield* record(spec)
      const prepared = yield* until(readViews([withA]), (value) => value.status !== "preparing", "unbootable preparation")
      expect(prepared.status).toBe("ready")
      fixture.unbootable.delete("/dash-a")
      fixture.prices.delete("/dash-a")
      const locations = yield* LocationServiceMap.Service
      yield* locations.invalidate(Location.Ref.make({ directory: AbsolutePath.make("/dash-a"), workspaceID: undefined }))
      const expected = yield* oracle([withA])
      expect(prepared.status === "ready" && normalize(prepared.reports)).toEqual(normalize(expected.reports))
      expect(prepared.status === "ready" && normalize(prepared.summary)).toEqual(normalize(expected.summary))
      expect(expected.reports[0]!.total.costCoverage?.unpricedRequests).toBeGreaterThan(0)
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 60_000)

test("project label changes republish project views while Session renames and deletions keep backend labels exact", () => {
  const fixture = harness()
  return Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedSessions
      for (const spec of specs(15)) yield* record(spec)
      const project: ProviderRequest.ReportInput = { group: "project", sort: "cost", order: "desc" }
      const session: ProviderRequest.ReportInput = { group: "session", sort: "key", order: "asc" }
      const first = yield* ready([project, session])
      expect(normalize(first.reports)).toEqual(normalize((yield* oracle([project, session])).reports))
      yield* db.run(sql`UPDATE project SET name = 'Renamed project'`)
      expect((yield* readViews([project])).status).toBe("preparing")
      const renamed = yield* ready([project, session])
      expect(normalize(renamed.reports)).toEqual(normalize((yield* oracle([project, session])).reports))
      expect(renamed.revision).toBe(first.revision)
      yield* db.run(sql`UPDATE session SET title = 'Renamed session' WHERE id = 'ses_dash_a'`)
      yield* db.run(sql`DELETE FROM session WHERE id = 'ses_dash_b'`)
      const kept = yield* readViews([project, session])
      expect(kept.status).toBe("ready")
      expect(kept.status === "ready" && normalize(kept.reports)).toEqual(normalize((yield* oracle([project, session])).reports))
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 60_000)

test("preparation of one high-volume cell with more than ten thousand distinct values pages bounded indexed samples exactly", () => {
  const fixture = harness()
  return Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedSessions
      const rows = 11_500
      yield* db.run(sql`
        WITH RECURSIVE n(value) AS (SELECT 0 UNION ALL SELECT value + 1 FROM n WHERE value < ${rows - 1})
        INSERT INTO session_provider_request
          (id, session_id, source, agent, model, route_id, prompt_cache_key, system_digest, tool_digest, request, attempts,
            invalidation, continuation, tokens, timing, cost, time_created)
        SELECT printf('prq_wide_%06d', value), 'ses_dash_a', 'step', 'build', '{"providerID":"openai","id":"wide"}', 'route',
          'wide-cache-key', 'system', 'tools', value + 1, 1, 'first-request', 'full',
          '{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}',
          json_object('totalMs', CASE WHEN value % 10 = 0 THEN 777 ELSE value END, 'firstOutputMs', value % 13), 0.001,
          ${base + 12_345}
        FROM n
      `)
      yield* UsageAnalytics.backfill(db)
      yield* UsageStage.backfill(db)
      fixture.statements.length = 0
      const pages: Array<{ readonly kind: "heavy" | "batch" | "total"; readonly rows: number; readonly seek: boolean }> = []
      fixture.hooks.inspect = (query, params) => {
        if (!query.trimStart().startsWith("INSERT INTO temp.usage_build_sample")) return
        if (query.includes("FROM temp.usage_build_sample")) {
          const body = `SELECT 1 ${query.slice(query.indexOf("FROM temp.usage_build_sample"), query.indexOf("ON CONFLICT"))}`
          pages.push({
            kind: "total",
            rows: fixture.count(body, params),
            seek: fixture
              .explain(body, params)
              .some((row) => /SEARCH (?:temp\.)?usage_build_sample USING PRIMARY KEY \((?:key>\?|\(key,metric,value\)>)/.test(row.detail)),
          })
          return
        }
        const heavy = query.indexOf("FROM (SELECT") >= 0 || /FROM \(\s*SELECT/.test(query)
        const body = heavy
          ? query.slice(query.search(/FROM \(\s*SELECT/) + 6, query.lastIndexOf(") WHERE 1"))
          : `SELECT 1 ${query.slice(query.indexOf("FROM usage_analytics_cell"), query.indexOf("GROUP BY"))}`
        pages.push({
          kind: heavy ? "heavy" : "batch",
          rows: fixture.count(body, params),
          seek: fixture.explain(body, params).some((row) => /SEARCH m USING (?:COVERING )?(?:INDEX \w+|PRIMARY KEY) \(cell=\?/.test(row.detail)),
        })
      }
      const wide: ProviderRequest.ReportInput = { group: "model", from: base, to: base + day, sort: "key", order: "asc" }
      const prepared = yield* ready([wide])
      fixture.hooks.inspect = undefined
      expect(normalize(prepared.reports)).toEqual(normalize((yield* oracle([wide])).reports))
      expect(pages.filter((page) => page.kind === "heavy" && page.rows > 0).length).toBeGreaterThanOrEqual(2)
      expect(pages.filter((page) => page.kind === "total" && page.rows > 0).length).toBeGreaterThanOrEqual(2)
      expect(Math.max(...pages.map((page) => page.rows))).toBeLessThanOrEqual(10_000)
      expect(pages.every((page) => page.seek)).toBe(true)
      expect(fixture.statements.some((statement) => /OVER\s*\(PARTITION BY key,\s*metric/i.test(statement.sql))).toBe(false)
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 120_000)

type Overlay = {
  calls: { list: number; refresh: number; forecast: number }
  label: string
  failing: boolean
  forecastFailing?: boolean
  status?: ProviderUsage.Status
}

const providerUsage = (state: Overlay) =>
  Layer.succeed(ProviderUsageRuntime.Service, {
    get: () => Effect.die("unused"),
    observe: () => Effect.void,
    list: (input?: { readonly refresh?: boolean }) =>
      Effect.suspend(() => {
        state.calls.list += 1
        if (input?.refresh) state.calls.refresh += 1
        if (state.failing) return Effect.die(new Error("synthetic decoder failure sk-synthetic-secret"))
        return Effect.succeed([
          new ProviderUsage.Snapshot({
            providerID: Provider.ID.make("openai"),
            label: state.label,
            status: state.status ?? "available",
            source: "provider_api",
            stability: "stable",
            updatedAt: Date.now(),
            windows: [],
          }),
        ])
      }),
    forecast: (input: { readonly localScope: "backend" | "location" }) =>
      Effect.suspend(() => {
        state.calls.forecast += 1
        if (state.forecastFailing) return Effect.die(new Error("synthetic forecast failure sk-synthetic-secret"))
        return Effect.succeed({ asOf: Date.now(), localScope: input.localScope })
      }),
  } as ProviderUsageRuntime.Interface)

const settle = (done: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 10_000 && !done(); attempt++) yield* Effect.yieldNow
    expect(done()).toBe(true)
  })

const quotaReady = (value: UsageDashboard.Info) => value.status === "ready" && value.quota.status === "ready"

const here = Location.Ref.make({ directory: AbsolutePath.make("/dash-here"), workspaceID: undefined })

const facadeOf = (state: Overlay, clock?: Clock.Clock) =>
  UsageDashboardRuntime.layer.pipe(
    Layer.provide(providerUsage(state)),
    Layer.provide(clock ? Layer.succeed(Clock.Clock, clock) : Layer.empty),
  )

const idle: UsageDashboard.Live = { asOf: 0, active: 0, streaming: 0, models: [], history: [] }

const activityOf = (live: { current: UsageDashboard.Live }) =>
  Layer.succeed(GenerationActivity.Service, { snapshot: () => Effect.sync(() => live.current) } as never)

const composed = (state: Overlay, clock?: Clock.Clock, live: { current: UsageDashboard.Live } = { current: idle }) =>
  UsageDashboardRead.layer.pipe(
    Layer.provide(
      Layer.effect(
        LocationServiceMap.Service,
        fixedLocations(() => facadeOf(state, clock)),
      ),
    ),
    Layer.provide(activityOf(live)),
  )

test("the dashboard answers ready accounting while the passive quota overlay prepares, and fences account changes", () => {
  const fixture = harness()
  const state: Overlay = { calls: { list: 0, refresh: 0, forecast: 0 }, label: "first", failing: false }
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* seedSessions
      for (const spec of specs(20)) yield* record(spec)
      const { db } = yield* Database.Service
      const clock = yield* TestClock.make()
      const dashboard = Context.get(yield* Layer.build(composed(state, clock)), UsageDashboardRead.Service)
      expect(state.calls).toEqual({ list: 0, refresh: 0, forecast: 0 })
      const input = { breakdown: recipes[1]! }
      expect((yield* dashboard.read(here, input)).status).toBe("preparing")
      const prepared = yield* until(dashboard.read(here, input), quotaReady, "dashboard")
      expect(prepared).toMatchObject({
        status: "ready",
        quota: { status: "ready", providers: [{ label: "first" }], forecast: { localScope: "backend" } },
      })
      expect("daily" in prepared || "monthly" in prepared).toBe(false)
      const before = { ...state.calls }
      const served = yield* fixture.watch(dashboard.read(here, input))
      expect(served.result.status).toBe("ready")
      expect(state.calls).toEqual(before)
      expect(served.analytics).toEqual([])
      const summaryOnly = yield* until(dashboard.read(here, {}), quotaReady, "summary only")
      expect(Object.keys(summaryOnly).toSorted()).toEqual(["asOf", "live", "quota", "revision", "status", "summary"])
      state.label = "second"
      yield* db.run(
        sql`INSERT INTO credential (id, integration_id, label, value, generation, account_generation, active, time_created, time_updated)
          VALUES ('cred_dash', 'openai', 'Other', '{"type":"api","key":"synthetic"}', 1, 1, 1, 0, 0)`,
      )
      const fenced = yield* dashboard.read(here, input)
      expect(fenced).toMatchObject({ status: "ready", revision: prepared.status === "ready" ? prepared.revision : "", quota: { status: "preparing" } })
      const switched = yield* until(dashboard.read(here, input), quotaReady, "account switch")
      expect(switched).toMatchObject({ quota: { providers: [{ label: "second" }] } })
      expect(switched.status === "ready" && prepared.status === "ready" && switched.revision === prepared.revision).toBe(true)
      expect((yield* dashboard.read(here, { ...input, refresh: true })).status).toBe("preparing")
      yield* settle(() => state.calls.refresh > 0)
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 120_000)

test("a failed provider list reports a fixed quota error beside ready accounting, retries, stops on close and revalidates after reopen", () => {
  const fixture = harness()
  const state: Overlay = { calls: { list: 0, refresh: 0, forecast: 0 }, label: "first", failing: true }
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* seedSessions
      for (const spec of specs(10)) yield* record(spec)
      const accounting = yield* ready([])
      const clock = yield* TestClock.make()
      const facade = composed(state, clock)
      const scope = yield* Scope.make()
      const dashboard = Context.get(yield* Layer.buildWithScope(facade, scope), UsageDashboardRead.Service)
      expect(yield* dashboard.read(here, {})).toMatchObject({ status: "ready", revision: accounting.revision, quota: { status: "preparing" } })
      yield* settle(() => state.calls.list === 1)
      const failed = yield* until(dashboard.read(here, {}), (value) => value.status === "ready" && value.quota.status === "error", "quota error")
      expect(failed).toMatchObject({
        status: "ready",
        revision: accounting.revision,
        quota: { status: "error", message: UsageDashboardRuntime.quotaFailure },
      })
      expect(JSON.stringify(failed)).not.toContain("sk-synthetic-secret")
      state.failing = false
      yield* clock.adjust(UsageDashboardRuntime.timing.retryMs)
      yield* settle(() => state.calls.list === 2)
      const recovered = yield* until(dashboard.read(here, {}), quotaReady, "retried overlay")
      expect(recovered).toMatchObject({ revision: accounting.revision, quota: { providers: [{ label: "first" }] } })
      yield* Scope.close(scope, Exit.void)
      const closed = { ...state.calls }
      yield* clock.adjust(UsageDashboardRuntime.timing.refreshMs * 4)
      for (let attempt = 0; attempt < 100; attempt++) yield* Effect.yieldNow
      expect(state.calls).toEqual(closed)
      const reopened = Context.get(yield* Layer.build(facade), UsageDashboardRead.Service)
      expect(yield* reopened.read(here, {})).toMatchObject({ status: "ready", quota: { status: "preparing" } })
      const revalidated = yield* until(reopened.read(here, {}), quotaReady, "reopened overlay")
      expect(revalidated).toMatchObject({ revision: accounting.revision, quota: { providers: [{ label: "first" }] } })
      expect(state.calls.list).toBe(closed.list + 1)
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 120_000)

test("failed providers and a failed forecast still settle quota as ready without inventing values", () => {
  const fixture = harness()
  const state: Overlay = { calls: { list: 0, refresh: 0, forecast: 0 }, label: "first", failing: false, forecastFailing: true, status: "error" }
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* seedSessions
      for (const spec of specs(10)) yield* record(spec)
      const accounting = yield* ready([])
      const dashboard = Context.get(yield* Layer.build(composed(state)), UsageDashboardRead.Service)
      expect(yield* dashboard.read(here, {})).toMatchObject({ status: "ready", revision: accounting.revision, quota: { status: "preparing" } })
      const settledQuota = yield* until(dashboard.read(here, {}), quotaReady, "settled quota")
      if (settledQuota.status !== "ready" || settledQuota.quota.status !== "ready") return yield* Effect.die(new Error("quota not ready"))
      expect(settledQuota.revision).toBe(accounting.revision)
      expect(settledQuota.quota.providers.map((item) => item.status)).toEqual(["error"])
      expect(Object.keys(settledQuota.quota.forecast).toSorted()).toEqual(["asOf", "localScope"])
      expect(settledQuota.quota.forecast.localScope).toBe("backend")
      expect(JSON.stringify(settledQuota)).not.toContain("sk-synthetic-secret")
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 60_000)

test("the dashboard services bootstrap through the node builder without multiplying the global owner", () => {
  const fixture = harness()
  const state = { calls: { list: 0, refresh: 0, forecast: 0 }, label: "first", failing: false }
  return Effect.runPromise(
    Effect.gen(function* () {
      const owner = yield* UsageViews.Service
      const first = yield* Layer.build(UsageDashboardRuntime.layer.pipe(Layer.provide(providerUsage(state))))
      const second = yield* Layer.build(UsageDashboardRuntime.layer.pipe(Layer.provide(providerUsage(state))))
      expect(Context.get(first, UsageDashboardRuntime.Service)).not.toBe(Context.get(second, UsageDashboardRuntime.Service))
      expect(yield* UsageViews.Service).toBe(owner)
      expect(state.calls).toEqual({ list: 0, refresh: 0, forecast: 0 })
      const { LocationServiceMap: map, locationServices } = yield* Effect.promise(() => import("../src/location-services"))
      void map
      expect(locationServices).toBeDefined()
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 60_000)

test("the dashboard graph keeps one global view owner that never depends on the Location service map", () => {
  const visit = (node: { readonly dependencies: ReadonlyArray<unknown> }, seen = new Set<unknown>()) => {
    for (const dependency of node.dependencies) {
      if (seen.has(dependency)) continue
      seen.add(dependency)
      visit(dependency as { readonly dependencies: ReadonlyArray<unknown> }, seen)
    }
    return seen
  }
  expect(visit(UsageViews.node).has(LocationServiceMap.node)).toBe(false)
  expect(visit(UsageDashboardRuntime.node).has(LocationServiceMap.node)).toBe(false)
  expect(visit(UsageDashboardRuntime.node).has(UsageViews.node)).toBe(false)
  expect(UsageDashboardRead.node.dependencies).toContain(UsageViews.node)
  expect(UsageDashboardRead.node.dependencies).toContain(LocationServiceMap.node)
  expect(UsageDashboardRead.node.dependencies).toContain(GenerationActivity.node)
  expect(visit(GenerationActivity.node).has(LocationServiceMap.node)).toBe(false)
  expect(UsageViewStart.node.dependencies).toContain(UsageViews.node)
  expect(UsageViewStart.node.dependencies).toContain(LocationServiceMap.node)
})

test("ready dashboards compose the in-memory live activity snapshot without changing the accounting revision or lookup", () => {
  const fixture = harness()
  const state: Overlay = { calls: { list: 0, refresh: 0, forecast: 0 }, label: "first", failing: false }
  const model = Model.Ref.make({ providerID: Provider.ID.make("openai"), id: Model.ID.make("m1") })
  const live = { current: idle }
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* seedSessions
      for (const spec of specs(12)) yield* record(spec)
      const accounting = yield* ready([recipes[1]!])
      const dashboard = Context.get(yield* Layer.build(composed(state, undefined, live)), UsageDashboardRead.Service)
      const input = { breakdown: recipes[1]! }
      const first = yield* until(dashboard.read(here, input), (value) => value.status === "ready", "ready dashboard")
      expect(first).toMatchObject({ status: "ready", revision: accounting.revision, live: idle })
      live.current = {
        asOf: Date.now(),
        active: 2,
        streaming: 1,
        outputTokensPerSecond: 42.5,
        models: [{ model, active: 2, streaming: 1, outputTokensPerSecond: 42.5 }],
        history: [{ at: Date.now() - 5_000, active: 1 }, { at: Date.now(), active: 2, outputTokensPerSecond: 42.5 }],
      }
      const served = yield* fixture.watch(dashboard.read(here, input))
      const statements = [...fixture.queries]
      expect(served.result).toMatchObject({ status: "ready", revision: accounting.revision, live: live.current })
      expect(served.analytics).toEqual([])
      expect(statements.filter((query) => /\busage_view_/i.test(query))).toHaveLength(2)
      live.current = { ...live.current, active: 0, streaming: 0, models: [] }
      const quiet = yield* dashboard.read(here, input)
      expect(quiet).toMatchObject({ status: "ready", revision: accounting.revision, live: { active: 0, streaming: 0, models: [] } })
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 120_000)
