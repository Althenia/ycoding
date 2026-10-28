import { afterAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Context, Effect, Layer, Option, type Scope, Tracer } from "effect"
import { Catalog } from "../src/catalog"
import { Database } from "../src/database/database"
import { sqliteLayer } from "../src/database/sqlite.bun"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventRuntime } from "../src/event"
import { Location } from "../src/location"
import { LocationServiceMap } from "../src/location-service-map"
import type { LocationServices } from "../src/location-services"
import { CatalogModel } from "../src/model"
import { Provider } from "../src/provider"
import { ProviderUsageRuntime } from "../src/provider-usage"
import { AbsolutePath } from "../src/schema"
import { Session } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { UsageAnalytics } from "../src/usage-analytics"
import { UsageStage } from "../src/usage-stage"
import { UsageDashboardRuntime } from "../src/usage-dashboard"
import { UsageDashboardRead } from "../src/usage-dashboard-read"
import { GenerationActivity } from "../src/generation-activity"
import { UsageViewRecipe } from "../src/usage-view-recipe"
import { UsageViews } from "../src/usage-view"
import { UsageViewStart } from "../src/usage-view-start"
import type { UsageDashboard } from "@ycoding-ai/schema/usage-dashboard"
import { Money } from "@ycoding-ai/schema/money"
import { fixedLocations } from "./fixture/location-map"

const rows = 200_000
const locations = 2_500
const unpricedLocations = 100
const day = 86_400_000
const now = Date.now()
const budget = { producer: 10_000, first: 100, warm: 2_000, during: 100 }
const contexts = { active: 0, peak: 0 }
const directories: string[] = []

afterAll(() => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))))

type Recorded = {
  id: string
  parent?: string
  name: string
  start: bigint
  end?: bigint
  connection?: unknown
  text?: string
}

type Probe = {
  spans: Recorded[]
  statements: Array<{ query: string; params: unknown[] }>
  explain: boolean
}

const tracer = (probe: Probe) =>
  Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      const parent = Option.getOrUndefined(options.parent)
      const recorded: Recorded = { id: span.spanId, parent: parent?.spanId, name: options.name, start: options.startTime }
      probe.spans.push(recorded)
      const attribute = span.attribute.bind(span)
      const end = span.end.bind(span)
      span.attribute = (key, value) => {
        if (key === "ycoding.connection") recorded.connection = value
        if (key === "db.query.text") recorded.text = String(value)
        attribute(key, value)
      }
      span.end = (endTime, exit) => {
        recorded.end = endTime
        end(endTime, exit)
      }
      return span
    },
  })

function seed(file: string) {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db.run(sql`
      WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows - 1}),
      shaped AS (
        SELECT i, i % ${locations} AS loc, (i / 7) % 12 AS m, (i % ${locations}) < ${unpricedLocations} AS unpriced FROM n
      )
      INSERT INTO usage_analytics_request
        (id, session_id, project_id, directory, workspace_id, session_updated, agent, source, model, usage_anchor, task_path,
          request, attempts, continuation, invalidation, prompt_cache_key, cache_read_reported, tokens, cost, timing, time_created)
      SELECT printf('prq_perf_%07d', i), printf('ses_perf_%05d', i % 20000), printf('prj_perf_%02d', loc % 50),
        printf('/perf/location-%04d', loc), NULL, ${now} - (i % 20000), 'build',
        CASE WHEN i % 41 = 0 THEN 'title' WHEN i % 97 = 0 THEN 'decision' ELSE 'step' END,
        CASE WHEN unpriced THEN json_object('providerID', 'local', 'id', printf('local-%d', i % 3))
          ELSE json_remove(json_object('providerID', json_extract('["openai","anthropic","google","xai"]', printf('$[%d]', m % 4)),
            'id', printf('model-%02d', m), 'variant', 'high', 'profile', 'work'),
            CASE WHEN m % 3 = 0 THEN '$.none' ELSE '$.variant' END, CASE WHEN m % 5 = 0 THEN '$.none' ELSE '$.profile' END) END,
        NULL, '[]', i / 20000 + 1, 1 + (i % 50 = 0),
        CASE WHEN i % 53 = 0 THEN 'continued' WHEN i % 89 = 0 THEN 'fallback' ELSE 'full' END,
        CASE WHEN i % 20000 = 0 THEN 'first-request' ELSE 'stable-hit' END, 'perfkey0', 1,
        json_object('input', 1000 + i % 9000, 'output', 100 + i % 900, 'reasoning', i % 300,
          'cache', json_object('read', i % 5000, 'write', i % 700)),
        CASE WHEN unpriced THEN NULL ELSE (i % 17) * 0.0001 END,
        json_object('firstOutputMs', 200 + i % 3000, 'totalMs', 1000 + i % 60000, 'generatedTokens', 100 + i % 900,
          'generationDurationNs', 1000000000 + (i % 9) * 100000000),
        ${now} - CAST((i * 1.0 * ${30 * day - 1}) / ${rows} AS INTEGER)
      FROM shaped
    `)
    const count = yield* database.db.get<{ count: number }>(sql`SELECT count(*) AS count FROM usage_analytics_request`)
    expect(count?.count).toBe(rows)
    yield* database.db.transaction(() => UsageStage.backfill(database.db))
  }).pipe(Effect.provide(Database.layer({ path: file })), Effect.scoped)
}

function locationMap() {
  const catalog = Context.make(Catalog.Service, {
    model: {
      get: (provider: Provider.ID, id: CatalogModel.ID) =>
        Effect.succeed({
          ...CatalogModel.Info.empty(provider, id),
          cost:
            provider === Provider.ID.openrouter
              ? []
              : [
                  {
                    input: Money.USDPerMillionTokens.make(1),
                    output: Money.USDPerMillionTokens.make(2),
                    cache: { read: Money.USDPerMillionTokens.make(0), write: Money.USDPerMillionTokens.make(0) },
                  },
                ],
        }).pipe(Effect.withSpan("perf.catalog.get")),
    },
  } as unknown as Catalog.Interface) as Context.Context<LocationServices>
  return Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const map = yield* fixedLocations(
        (ref: Location.Ref) =>
          Layer.effectContext(Effect.succeed(catalog).pipe(Effect.withSpan("perf.location.boot", { attributes: { directory: ref.directory } }))),
        { idleTimeToLive: "60 minutes" },
      )
      return LocationServiceMap.Service.of({
        ...map,
        contextEffect: (ref, nodes) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              contexts.active += 1
              contexts.peak = Math.max(contexts.peak, contexts.active)
            }),
            () => Effect.sync(() => void (contexts.active -= 1)),
          ).pipe(Effect.andThen(map.contextEffect(ref, nodes)), Effect.withSpan("perf.location.context")),
      })
    }),
  )
}

function runtime(file: string, probe: Probe) {
  const database = Layer.effect(
    Database.Service,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const context = yield* Layer.build(
        sqliteLayer({
          filename: file,
          readonly: true,
          readwrite: false,
          create: false,
          disableWAL: true,
          spanAttributes: { "ycoding.connection": "reader" },
        }),
      )
      const reader: Database.Interface["db"] = yield* EffectDrizzleSqlite.make().pipe(
        Effect.provideService(EffectDrizzleSqlite.EffectLogger, {
          logQuery: (query, params) =>
            Effect.sync(() => {
              if (probe.explain) probe.statements.push({ query, params })
            }),
        }),
        Effect.provide(EffectDrizzleSqlite.DefaultServices),
        Effect.provide(context),
      )
      const transaction = reader.transaction.bind(reader)
      reader.transaction = ((run, config) =>
        transaction(run, config).pipe(Effect.withSpan("perf.reader.transaction"))) as typeof reader.transaction
      yield* Effect.all([
        reader.run("PRAGMA busy_timeout = 5000"),
        reader.run("PRAGMA cache_size = -64000"),
        reader.run("PRAGMA temp_store = MEMORY"),
      ])
      return { ...database, reader }
    }),
  ).pipe(Layer.provide(Database.layer({ path: file })))
  return AppNodeBuilder.build(
    LayerNode.group([Database.node, Session.node, LocationServiceMap.node, EventRuntime.node, UsageViews.node, UsageViewStart.node]),
    [
    [UsageAnalytics.node, Layer.mock(UsageAnalytics.Service, {})],
    [Database.node, database],
    [SessionExecution.node, SessionExecution.noopLayer],
    [LocationServiceMap.node, locationMap()],
    ],
  )
}

const reports = UsageViewRecipe.standard(now, undefined)
const input: UsageDashboard.Input = { daily: reports[0]!, monthly: reports[1]!, breakdown: reports[2]! }

const providers = Layer.succeed(ProviderUsageRuntime.Service, {
  get: () => Effect.die("unused"),
  observe: () => Effect.void,
  list: () => Effect.succeed([]),
  forecast: (request: { readonly localScope: "backend" | "location" }) =>
    Effect.sync(() => ({ asOf: Date.now(), localScope: request.localScope })),
} as ProviderUsageRuntime.Interface)

const here = Location.Ref.make({ directory: AbsolutePath.make("/perf/dashboard"), workspaceID: undefined })

const facade = UsageDashboardRuntime.layer.pipe(Layer.provide(providers))

const dashboard = Effect.map(
  Layer.build(
    UsageDashboardRead.layer.pipe(
      Layer.provide(
        Layer.effect(
          LocationServiceMap.Service,
          fixedLocations(() => facade),
        ),
      ),
      Layer.provide(GenerationActivity.layer),
    ),
  ),
  (context) => {
    const service = Context.get(context, UsageDashboardRead.Service)
    return { read: (request: UsageDashboard.Input) => service.read(here, request) }
  },
)

const until = (name: string, read: Effect.Effect<UsageDashboard.Info>) =>
  Effect.gen(function* () {
    const started = performance.now()
    let reads = 0
    while (true) {
      reads += 1
      const value = yield* read.pipe(Effect.withSpan(`perf.read.${name}`))
      if (value.status === "error") return yield* Effect.die(new Error(`Dashboard preparation failed: ${value.message}`))
      if (value.status === "ready") return { name, ms: performance.now() - started, reads, value }
      if (performance.now() - started > budget.producer * 3) return { name, ms: performance.now() - started, reads, value }
      yield* Effect.sleep("25 millis")
    }
  }).pipe(Effect.withSpan(`perf.op.${name}`))

const pending = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return (yield* db
    .get<{ open: number; total: number }>(
      sql`SELECT count(*) FILTER (WHERE status IN ('pending', 'building')) AS open, count(*) AS total FROM usage_view_state`,
    )
    .pipe(Effect.orDie)) ?? { open: 0, total: 0 }
})

const produced = Effect.gen(function* () {
  const started = performance.now()
  while (true) {
    const state = yield* pending
    if (state.total > 0 && state.open === 0) break
    if (performance.now() - started > budget.producer * 3) break
    yield* Effect.sleep("25 millis")
  }
  const views = yield* UsageViews.Service
  while ((yield* views.read(reports)).status !== "ready" && performance.now() - started < budget.producer * 3)
    yield* Effect.sleep("25 millis")
  return round(performance.now() - started)
}).pipe(Effect.withSpan("perf.op.producer"))

const generations = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return yield* db
    .all<{ id: string; generation: number }>(sql`SELECT id, generation FROM usage_view_state ORDER BY id`)
    .pipe(Effect.orDie)
})

const pricing = (probe: Probe) => ({
  locationContexts: probe.spans.filter((span) => span.name === "perf.location.context").length,
  locationBoots: probe.spans.filter((span) => span.name === "perf.location.boot").length,
  catalogLookups: probe.spans.filter((span) => span.name === "perf.catalog.get").length,
})

const builds = (probe: Probe) =>
  probe.spans.filter((span) => span.name === "sql.execute" && /SET status = 'building'/.test(span.text ?? "")).length

const once = (name: string, read: Effect.Effect<UsageDashboard.Info>) =>
  Effect.gen(function* () {
    const started = performance.now()
    const value = yield* read
    return { name, ms: performance.now() - started, value }
  }).pipe(Effect.withSpan(`perf.op.${name}`))

function analyze(probe: Probe, root: string) {
  const byID = new Map(probe.spans.map((span) => [span.id, span]))
  const within = (span: Recorded, ancestor: string) => {
    for (let current: Recorded | undefined = span; current; current = current.parent ? byID.get(current.parent) : undefined)
      if (current.id === ancestor) return true
    return false
  }
  const op = probe.spans.findLast((span) => span.name === root)!
  const owned = probe.spans.filter((span) => span.id !== op.id && within(span, op.id))
  const ms = (span: Recorded) => Number((span.end ?? span.start) - span.start) / 1e6
  const statements = owned.filter((span) => span.name === "sql.execute" && !span.text?.startsWith("EXPLAIN"))
  const reader = statements.filter((span) => span.connection === "reader")
  const outer = owned.filter((span) => span.name === "perf.reader.transaction")
  const transactions = outer
    .filter((span) => !outer.some((other) => other.id !== span.id && within(span, other.id)))
    .map((transaction) => {
      const first = reader.find((span) => within(span, transaction.id))
      return {
        waitMs: round(first ? Number(first.start - transaction.start) / 1e6 : ms(transaction)),
        ms: round(ms(transaction)),
        statements: reader.filter((span) => within(span, transaction.id)).length,
        start: transaction.start,
        end: transaction.end ?? transaction.start,
      }
    })
  const grouped = new Map<string, { count: number; ms: number; max: number }>()
  for (const span of reader) {
    const key = normalize(span.text ?? "").slice(0, 220)
    const current = grouped.get(key) ?? { count: 0, ms: 0, max: 0 }
    grouped.set(key, { count: current.count + 1, ms: current.ms + ms(span), max: Math.max(current.max, ms(span)) })
  }
  const named = (name: string) => owned.filter((span) => span.name === name)
  return {
    totalMs: round(ms(op)),
    readerSqlMs: round(reader.reduce((total, span) => total + ms(span), 0)),
    readerStatements: reader.length,
    mainStatements: statements.length - reader.length,
    transactions: transactions.map((transaction) => ({ waitMs: transaction.waitMs, ms: transaction.ms, statements: transaction.statements })),
    pricingGapMs: round(
      transactions.slice(1).reduce((total, transaction, index) => total + Number(transaction.start - transactions[index]!.end) / 1e6, 0),
    ),
    pricing: {
      locationContexts: named("perf.location.context").length,
      locationContextMs: round(named("perf.location.context").reduce((total, span) => total + ms(span), 0)),
      locationBoots: named("perf.location.boot").length,
      catalogLookups: named("perf.catalog.get").length,
      catalogLookupMs: round(named("perf.catalog.get").reduce((total, span) => total + ms(span), 0)),
    },
    topStatements: [...grouped]
      .toSorted((left, right) => right[1].ms - left[1].ms)
      .slice(0, 6)
      .map(([text, value]) => ({ text, count: value.count, ms: round(value.ms), maxMs: round(value.max) })),
  }
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim()
const round = (value: number) => Math.round(value * 10) / 10

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-usage-dashboard-"))
  directories.push(directory)
  const file = join(directory, "usage.db")
  const started = performance.now()
  await Effect.runPromise(seed(file))
  return { file, seedMs: round(performance.now() - started) }
}

async function measure<A>(
  file: string,
  run: (
    probe: Probe,
  ) => Effect.Effect<
    A,
    unknown,
    Session.Service | Database.Service | UsageViews.Service | LocationServiceMap.Service | EventRuntime.Service | Scope.Scope
  >,
) {
  const probe: Probe = { spans: [], statements: [], explain: false }
  const result = await Effect.runPromise(
    run(probe).pipe(Effect.provide(runtime(file, probe)), Effect.scoped, Effect.withTracer(tracer(probe))),
  )
  return { probe, result }
}

const evidence: Record<string, unknown> = {}

afterAll(async () => {
  const directory = join(import.meta.dir, "..", "tmp")
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "usage-dashboard-performance.json"), JSON.stringify(evidence, (_, value) => typeof value === "bigint" ? Number(value) : value, 2))
})

const readyMs = (result: { readonly ms: number; readonly value: UsageDashboard.Info }) =>
  result.value.status === "ready" ? result.ms : Number.POSITIVE_INFINITY

test(
  "the producer prepares standard views before any client opens the dashboard, and the first dashboard reads are READY within budget",
  async () => {
    const seeded = await fixture()
    evidence.seed = { rows, locations, unpricedLocations, seedMs: seeded.seedMs }
    contexts.peak = 0
    const measured = await measure(seeded.file, () =>
      Effect.gen(function* () {
        const producerMs = yield* produced
        const service = yield* dashboard
        const first = yield* once("first", service.read(input))
        const warm = yield* once("warm.1", service.read(input))
        const services = yield* Effect.all(Array.from({ length: 6 }, () => dashboard))
        const concurrent = yield* Effect.all(
          services.map((client, index) => once(`first.${index}`, client.read(input))),
          { concurrency: "unbounded" },
        )
        return { producerMs, first, warm, concurrent }
      }),
    )
    const result = measured.result
    evidence.startup = {
      producerMs: result.producerMs,
      producer: pricing(measured.probe),
      peakLocationContexts: contexts.peak,
      builds: builds(measured.probe),
      first: { ms: result.first.ms, status: result.first.value.status, ...analyze(measured.probe, "perf.op.first") },
      warm: { ms: result.warm.ms, ...analyze(measured.probe, "perf.op.warm.1") },
      concurrent: result.concurrent.map((item) => ({ ms: item.ms, status: item.value.status })),
    }
    console.log(JSON.stringify(evidence.startup, null, 1))
    expect(result.producerMs).toBeLessThanOrEqual(budget.producer)
    expect(readyMs(result.first)).toBeLessThanOrEqual(budget.first)
    expect(readyMs(result.warm)).toBeLessThanOrEqual(budget.first)
    for (const item of result.concurrent) expect(readyMs(item)).toBeLessThanOrEqual(budget.first)
  },
  { timeout: 1_200_000 },
)

test(
  "a restart with an unchanged catalog serves the first dashboard read READY without rebuilding any view",
  async () => {
    const seeded = await fixture()
    const before = await measure(seeded.file, () =>
      Effect.gen(function* () {
        yield* produced
        return yield* generations
      }),
    )
    contexts.peak = 0
    const measured = await measure(seeded.file, () =>
      Effect.gen(function* () {
        const verifyMs = yield* produced
        const service = yield* dashboard
        const first = yield* once("restart.first", service.read(input))
        const services = yield* Effect.all(Array.from({ length: 6 }, () => dashboard))
        const concurrent = yield* Effect.all(
          services.map((client, index) => once(`restart.${index}`, client.read(input))),
          { concurrency: "unbounded" },
        )
        return { verifyMs, first, concurrent, generations: yield* generations }
      }),
    )
    const result = measured.result
    evidence.restart = {
      verifyMs: result.verifyMs,
      producer: pricing(measured.probe),
      peakLocationContexts: contexts.peak,
      builds: builds(measured.probe),
      first: { ms: result.first.ms, status: result.first.value.status, ...analyze(measured.probe, "perf.op.restart.first") },
      concurrent: result.concurrent.map((item) => ({ ms: item.ms, status: item.value.status })),
    }
    console.log(JSON.stringify(evidence.restart, null, 1))
    expect(builds(measured.probe)).toBe(0)
    expect(result.generations).toEqual(before.result)
    expect(readyMs(result.first)).toBeLessThanOrEqual(budget.first)
    for (const item of result.concurrent) expect(readyMs(item)).toBeLessThanOrEqual(budget.first)
  },
  { timeout: 1_200_000 },
)

test(
  "a warm READY dashboard read answers within budget while a different custom-range view is building",
  async () => {
    const seeded = await fixture()
    const measured = await measure(seeded.file, () =>
      Effect.gen(function* () {
        yield* produced
        const service = yield* dashboard
        const custom: UsageDashboard.Input = { breakdown: { ...input.breakdown!, from: input.breakdown!.from! + 1 } }
        expect((yield* service.read(custom)).status).toBe("preparing")
        const { db } = yield* Database.Service
        const state = JSON.stringify(UsageViewRecipe.state(custom.breakdown!))
        const started = performance.now()
        while (
          (yield* db.get<{ status: string }>(sql`SELECT status FROM usage_view_state WHERE id = ${state}`).pipe(Effect.orDie))?.status !==
            "building" &&
          performance.now() - started < budget.producer
        )
          yield* Effect.sleep("1 millis")
        const reads = []
        for (let index = 0; index < 10; index++) {
          const building = (yield* db.get<{ status: string }>(sql`SELECT status FROM usage_view_state WHERE id = ${state}`).pipe(Effect.orDie))?.status === "building"
          if (!building) break
          reads.push(yield* once(`during.${index}`, service.read(input)))
          yield* Effect.sleep("20 millis")
        }
        const finished = yield* until("custom", service.read(custom))
        return { reads, finished }
      }),
    )
    const result = measured.result
    evidence.during = {
      reads: result.reads.map((item) => ({ ms: round(item.ms), status: item.value.status })),
      maxMs: round(Math.max(...result.reads.map((item) => item.ms))),
      customReadyMs: round(result.finished.ms),
    }
    console.log(JSON.stringify(evidence.during))
    expect(result.reads.length).toBeGreaterThan(0)
    for (const item of result.reads) expect(readyMs(item)).toBeLessThanOrEqual(budget.during)
    expect(result.finished.value.status).toBe("ready")
  },
  { timeout: 1_200_000 },
)

test(
  "a warm READY dashboard read touches only prepared view storage, and its payload equals the standalone Usage reads",
  async () => {
    const seeded = await fixture()
    const measured = await measure(seeded.file, (probe) =>
      Effect.gen(function* () {
        const service = yield* dashboard
        const ready = yield* until("prepare", service.read(input))
        probe.statements.length = 0
        probe.explain = true
        const warm = yield* service.read(input)
        probe.explain = false
        const session = yield* Session.Service
        const standalone = {
          summary: yield* session.usageAll(),
          daily: yield* session.usageReportAll(input.daily!),
          monthly: yield* session.usageReportAll(input.monthly!),
          breakdown: yield* session.usageReportAll(input.breakdown!),
        }
        return { ready, warm, standalone }
      }),
    )
    const statements = measured.probe.statements
    evidence.plans = statements.map((statement) => normalize(statement.query))
    expect(statements.length).toBeGreaterThan(0)
    for (const statement of statements) {
      expect(statement.query).not.toMatch(/\b(?:usage_analytics_request|session_provider_request|usage_analytics_cell\w*|temp\.)/i)
      expect(statement.query).not.toMatch(/\bGROUP BY\b|\bOVER\s*\(/i)
    }
    const warm = measured.result.warm
    expect(warm.status).toBe("ready")
    if (warm.status !== "ready") return
    const round = (value: unknown) =>
      JSON.parse(JSON.stringify(value, (_, item) => (typeof item === "number" && !Number.isInteger(item) ? Number(item.toPrecision(12)) : item)))
    expect(round({ summary: warm.summary, daily: warm.daily, monthly: warm.monthly, breakdown: warm.breakdown })).toEqual(
      round(measured.result.standalone),
    )
  },
  { timeout: 1_200_000 },
)
