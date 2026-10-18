import { afterAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Context, Effect, Layer, LayerMap, Option, Tracer } from "effect"
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
import { Money } from "@ycoding-ai/schema/money"
import type { ProviderRequest } from "@ycoding-ai/schema/provider-request"

const rows = 200_000
const locations = 2_500
const unpricedLocations = 100
const day = 86_400_000
const now = Date.now()
const budget = { cold: 10_000, warm: 2_000 }
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
      const map = yield* LayerMap.make(
        (ref: Location.Ref) =>
          Layer.effectContext(Effect.succeed(catalog).pipe(Effect.withSpan("perf.location.boot", { attributes: { directory: ref.directory } }))),
        { idleTimeToLive: "60 minutes" },
      )
      return { ...map, contextEffect: (ref: Location.Ref) => map.contextEffect(ref).pipe(Effect.withSpan("perf.location.context")) }
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
  return AppNodeBuilder.build(LayerNode.group([Database.node, Session.node, LocationServiceMap.node, EventRuntime.node]), [
    [UsageAnalytics.node, Layer.mock(UsageAnalytics.Service, {})],
    [Database.node, database],
    [SessionExecution.node, SessionExecution.noopLayer],
    [LocationServiceMap.node, locationMap()],
  ])
}

const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate())
const range = { from: today - 29 * day, to: today + day }
const reports = {
  daily: { group: "day", ...range, limit: 30, sort: "key", order: "asc" },
  monthly: {
    group: "model",
    from: Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1),
    to: range.to,
    limit: 200,
    sort: "cost",
    order: "desc",
  },
  breakdown: { group: "model", ...range, offset: 0, limit: 25, sort: "cost", order: "desc" },
} satisfies Record<string, ProviderRequest.ReportInput>

const operations = {
  summary: Effect.gen(function* () {
    const session = yield* Session.Service
    return (yield* session.usageAll()).logical
  }),
  daily: Effect.gen(function* () {
    const session = yield* Session.Service
    return (yield* session.usageReportAll(reports.daily)).total.logical
  }),
  monthly: Effect.gen(function* () {
    const session = yield* Session.Service
    return (yield* session.usageReportAll(reports.monthly)).total.logical
  }),
  breakdown: Effect.gen(function* () {
    const session = yield* Session.Service
    return (yield* session.usageReportAll(reports.breakdown)).total.logical
  }),
  localSpend: Effect.gen(function* () {
    const database = yield* Database.Service
    const reads = ProviderUsageRuntime.localReads(
      database,
      Location.Ref.make({ directory: AbsolutePath.make("/perf/location-0000"), workspaceID: undefined }),
    )
    return (yield* reads.localSpend()).reduce((total, row) => total + row.pricedRequests + row.unpricedRequests, 0)
  }),
  localUsage: Effect.gen(function* () {
    const database = yield* Database.Service
    const reads = ProviderUsageRuntime.localReads(
      database,
      Location.Ref.make({ directory: AbsolutePath.make("/perf/location-0000"), workspaceID: undefined }),
    )
    return (yield* reads.localUsage("backend", Date.now())).reduce((total, bin) => total + bin.requests, 0)
  }),
}
type Name = keyof typeof operations
const names = Object.keys(operations) as Name[]

const timed = (name: string, effect: Effect.Effect<number, unknown, Session.Service | Database.Service>) =>
  Effect.gen(function* () {
    const started = performance.now()
    const value = yield* effect.pipe(Effect.withSpan(`perf.op.${name}`))
    return { name, value, ms: performance.now() - started }
  })

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

async function measure(file: string, run: (probe: Probe) => Effect.Effect<unknown, unknown, Session.Service | Database.Service>) {
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

test(
  "each dashboard Usage read meets its cold and warm budget",
  async () => {
    const seeded = await fixture()
    evidence.seed = { rows, locations, unpricedLocations, seedMs: seeded.seedMs }
    const sequential: Record<string, unknown> = {}
    for (const name of names) {
      const measured = await measure(seeded.file, () =>
        Effect.gen(function* () {
          const cold = yield* timed(`${name}.cold`, operations[name])
          const warm = yield* timed(`${name}.warm.1`, operations[name])
          const again = yield* timed(`${name}.warm.2`, operations[name])
          return { cold, warm, again }
        }),
      )
      const result = measured.result as Record<"cold" | "warm" | "again", { value: number; ms: number }>
      sequential[name] = {
        value: result.cold.value,
        cold: analyze(measured.probe, `perf.op.${name}.cold`),
        warm: analyze(measured.probe, `perf.op.${name}.warm.1`),
        warm2: analyze(measured.probe, `perf.op.${name}.warm.2`),
      }
    }
    evidence.sequential = sequential
    console.log(table("sequential", sequential))
    for (const name of names) {
      const value = sequential[name] as Record<"cold" | "warm" | "warm2", { totalMs: number }>
      expect({ name, cold: value.cold.totalMs <= budget.cold }).toEqual({ name, cold: true })
      expect({ name, warm: Math.max(value.warm.totalMs, value.warm2.totalMs) <= budget.warm }).toEqual({ name, warm: true })
    }
  },
  { timeout: 1_200_000 },
)

test(
  "six simultaneous dashboard Usage reads each meet the cold and warm budget",
  async () => {
    const seeded = await fixture()
    const measured = await measure(seeded.file, () =>
      Effect.gen(function* () {
        yield* Effect.all(
          names.map((name) => timed(`${name}.cold`, operations[name])),
          { concurrency: "unbounded" },
        )
        yield* Effect.all(
          names.map((name) => timed(`${name}.warm`, operations[name])),
          { concurrency: "unbounded" },
        )
      }),
    )
    const concurrent = Object.fromEntries(
      names.map((name) => [
        name,
        { cold: analyze(measured.probe, `perf.op.${name}.cold`), warm: analyze(measured.probe, `perf.op.${name}.warm`) },
      ]),
    )
    evidence.concurrent = concurrent
    console.log(table("concurrent", concurrent))
    for (const name of names) {
      expect({ name, cold: concurrent[name]!.cold.totalMs <= budget.cold }).toEqual({ name, cold: true })
      expect({ name, warm: concurrent[name]!.warm.totalMs <= budget.warm }).toEqual({ name, warm: true })
    }
  },
  { timeout: 1_200_000 },
)

test(
  "captures the query plan of every dashboard Usage statement",
  async () => {
    const seeded = await fixture()
    const measured = await measure(seeded.file, (probe) =>
      Effect.gen(function* () {
        probe.explain = true
        for (const name of names) yield* operations[name]
      }),
    )
    const sqlite = await import("bun:sqlite")
    const connection = new sqlite.Database(seeded.file, { readonly: true })
    const plans = new Map<string, { count: number; plan: string[] }>()
    for (const statement of measured.probe.statements) {
      if (/^\s*(CREATE|DROP)/i.test(statement.query)) {
        connection.run(statement.query)
        continue
      }
      const text = normalize(statement.query)
      const known = plans.get(text)
      if (known) {
        known.count++
        continue
      }
      const prepared = connection.prepare<{ detail: string }, never[]>(`EXPLAIN QUERY PLAN ${statement.query}`)
      plans.set(text, { count: 1, plan: prepared.all(...(statement.params as never[])).map((row) => row.detail) })
      prepared.finalize()
    }
    connection.close()
    evidence.plans = Object.fromEntries([...plans].map(([text, value]) => [text, value]))
    expect(plans.size).toBeGreaterThan(0)
  },
  { timeout: 1_200_000 },
)

function table(mode: string, values: Record<string, unknown>) {
  return Object.entries(values)
    .flatMap(([name, value]) =>
      Object.entries(value as Record<string, unknown>).flatMap(([phase, item]) => {
        if (typeof item !== "object" || item === null) return []
        const data = item as ReturnType<typeof analyze>
        return [
          [
            mode.padEnd(10),
            name.padEnd(10),
            phase.padEnd(5),
            `total=${data.totalMs}`,
            `sql=${data.readerSqlMs}`,
            `stmts=${data.readerStatements}`,
            `wait=${data.transactions.map((transaction) => transaction.waitMs).join("+")}`,
            `txn=${data.transactions.length}`,
            `contexts=${data.pricing.locationContexts}`,
            `boots=${data.pricing.locationBoots}`,
            `lookups=${data.pricing.catalogLookups}`,
          ].join(" "),
        ]
      }),
    )
    .join("\n")
}
