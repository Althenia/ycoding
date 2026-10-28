import { expect, test } from "bun:test"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { DateTime, Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { sqliteLayer } from "../src/database/sqlite.bun"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventRuntime } from "../src/event"
import { Session } from "../src/session"
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { SessionUsageRead } from "../src/session/usage-read"
import { UsageAnalytics } from "../src/usage-analytics"
import { Agent } from "@ycoding-ai/schema/agent"
import { Model } from "@ycoding-ai/schema/model"
import { Money } from "@ycoding-ai/schema/money"
import { Provider } from "@ycoding-ai/schema/provider"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { AbsolutePath } from "@ycoding-ai/schema/schema"

const minute = 60_000
const day = 86_400_000
const dayStart = Math.floor((Date.now() - 3 * day) / day) * day
const t0 = dayStart + 10 * 60 * minute

const rawSource = /\b(?:from|join)\s+["`]?(usage_analytics_request|session_provider_request)["`]?(?![\w$])/i
const isRawAggregation = (query: string) =>
  /^\s*(?:select|with|insert)\b/i.test(query) && /\bselect\b/i.test(query) && rawSource.test(query)

const queries: string[] = []

const database = Layer.effect(
  Database.Service,
  Effect.gen(function* () {
    const db = yield* EffectDrizzleSqlite.make().pipe(
      Effect.provideService(EffectDrizzleSqlite.EffectLogger, {
        logQuery: (query) => Effect.sync(() => void queries.push(query)),
      }),
      Effect.provide(EffectDrizzleSqlite.DefaultServices),
    )
    yield* DatabaseMigration.apply(db)
    return { db }
  }),
).pipe(Layer.provide(sqliteLayer({ filename: ":memory:" })))

const runtime = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventRuntime.node, Session.node, UsageAnalytics.node]),
  [
    [Database.node, database],
    [SessionExecution.node, SessionExecution.noopLayer],
  ],
)

type Spec = {
  readonly key: string
  readonly session: "a" | "b"
  readonly request: number
  readonly provider: string
  readonly model: string
  readonly offsetMinutes: number
  readonly cost?: number
  readonly input: number
  readonly output: number
  readonly timing?: { readonly totalMs: number; readonly firstOutputMs: number; readonly generationDurationNs: number; readonly generatedTokens: number }
}

const specs: ReadonlyArray<Spec> = [
  { key: "r1", session: "a", request: 1, provider: "openai", model: "gpt-a", offsetMinutes: 0, cost: 0.1, input: 100, output: 50, timing: { totalMs: 100, firstOutputMs: 10, generationDurationNs: 1e9, generatedTokens: 100 } },
  { key: "r2", session: "a", request: 2, provider: "openai", model: "gpt-a", offsetMinutes: 10, cost: 0.2, input: 200, output: 100, timing: { totalMs: 200, firstOutputMs: 20, generationDurationNs: 2e9, generatedTokens: 100 } },
  { key: "r3", session: "a", request: 3, provider: "openai", model: "gpt-a", offsetMinutes: 70, cost: 0.3, input: 300, output: 150, timing: { totalMs: 300, firstOutputMs: 30, generationDurationNs: 4e9, generatedTokens: 100 } },
  { key: "r4", session: "b", request: 1, provider: "openai", model: "gpt-a", offsetMinutes: 75, cost: 0.4, input: 400, output: 200, timing: { totalMs: 400, firstOutputMs: 40, generationDurationNs: 5e9, generatedTokens: 100 } },
  { key: "r5", session: "b", request: 2, provider: "anthropic", model: "claude-b", offsetMinutes: 80, cost: 0.5, input: 500, output: 250 },
  { key: "r6", session: "b", request: 3, provider: "anthropic", model: "claude-b", offsetMinutes: 90, input: 600, output: 300 },
]

const late: Spec = {
  key: "r7", session: "a", request: 4, provider: "openai", model: "gpt-a", offsetMinutes: 100, cost: 0.6, input: 700, output: 350,
  timing: { totalMs: 500, firstOutputMs: 50, generationDurationNs: 10e9, generatedTokens: 100 },
}

const setup = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const events = yield* EventRuntime.Service
  const db = yield* Database.Service
  const directory = (name: string) =>
    Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), `prepared-usage-${name}-`))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    )
  const a = yield* sessions.create({ location: { directory: AbsolutePath.make(yield* directory("a")) } })
  const b = yield* sessions.create({ location: { directory: AbsolutePath.make(yield* directory("b")) } })
  const publish = (spec: Spec) =>
    events.publish(SessionEvent.ProviderRequestRecorded, {
      id: ProviderRequest.ID.make(`prq_prepared_${spec.key}`),
      sessionID: (spec.session === "a" ? a : b).id,
      source: "step" as const,
      agent: Agent.ID.make("build"),
      model: Model.Ref.make({ providerID: Provider.ID.make(spec.provider), id: Model.ID.make(spec.model) }),
      routeID: "route",
      promptCacheKey: "namespace",
      systemDigest: "system",
      toolDigest: "tools",
      request: spec.request,
      attempts: 1,
      invalidation: "first-request" as const,
      continuation: "full" as const,
      ...(spec.cost === undefined ? {} : { cost: Money.USD.make(spec.cost) }),
      ...(spec.timing === undefined ? {} : { timing: spec.timing }),
      tokens: { input: spec.input, output: spec.output, reasoning: 0, cache: { read: 0, write: 0 } },
      time: DateTime.makeUnsafe(t0 + spec.offsetMinutes * minute),
    })
  const reads = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      queries.length = 0
      const result = yield* effect
      return { result, raw: queries.filter(isRawAggregation) }
    })
  const warm = Effect.gen(function* () {
    yield* sessions.usageAll()
    yield* sessions.usageReportAll({ group: "model" })
    yield* SessionUsageRead.localSpend(db, { dayStart, dayEnd: dayStart + day })
    yield* SessionUsageRead.localUsage(db, { from: t0, to: t0 + 120 * minute, scope: { type: "backend" } })
  })
  const factCount = (table: string) =>
    db.db.get<{ count: number }>(sql.raw(`SELECT count(*) AS count FROM ${table}`)).pipe(Effect.map((row) => row?.count))
  return { sessions, db, a, b, publish, reads, warm, factCount }
})

const rowByInput = <T extends { readonly tokens: { readonly input: number } }>(rows: ReadonlyArray<T>, input: number) => {
  const row = rows.find((item) => item.tokens.input === input)
  if (!row) throw new Error(`No report row with input ${input}`)
  return row
}

const binsWithRequests = (
  bins: ReadonlyArray<{ readonly providerID: string; readonly modelID: string; readonly start: number; readonly requests: number; readonly knownUSD?: number }>,
  providerID: string,
) =>
  bins
    .filter((bin) => bin.providerID === providerID && bin.requests > 0)
    .map((bin) => [(bin.start - t0) / minute, bin.requests, bin.knownUSD] as const)

test("regrouping, filtering, range, local spend and local rate reads are served from prepared data", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* setup
      const { sessions, db } = fixture
      for (const spec of specs) yield* fixture.publish(spec)
      yield* fixture.warm

      const summary = yield* fixture.reads(sessions.usageAll())
      expect(summary.result.logical).toBe(6)
      expect(summary.result.tokens.input).toBe(2100)
      expect(summary.result.tokens.output).toBe(1050)
      expect(summary.result.cost).toBeCloseTo(1.5, 9)
      expect(summary.result.models).toHaveLength(2)

      const model = yield* fixture.reads(sessions.usageReportAll({ group: "model" }))
      expect(model.result.rowCount).toBe(2)
      expect(model.result.total.costCoverage).toEqual({ pricedRequests: 5, unpricedRequests: 1 })
      expect(model.result.total.costProvenance).toBe("recorded")
      const gpt = rowByInput(model.result.rows, 1000)
      expect(gpt.logical).toBe(4)
      expect(gpt.cost).toBeCloseTo(1.0, 9)
      expect(gpt.costProvenance).toBe("recorded")
      expect(gpt.speed?.totalP50Ms).toBe(200)
      expect(gpt.speed?.totalP95Ms).toBe(400)
      expect(gpt.speed?.firstOutputP50Ms).toBe(20)
      expect(gpt.speed?.firstOutputP95Ms).toBe(40)
      expect(gpt.speed?.generationSamples).toBe(4)
      expect(gpt.speed?.providerTimedSamples).toBe(4)
      expect(gpt.speed?.generationP50TokensPerSecond).toBeCloseTo(25, 6)
      expect(gpt.speed?.generationP90TokensPerSecond).toBeCloseTo(100, 6)
      const claude = rowByInput(model.result.rows, 1100)
      expect(claude.logical).toBe(2)
      expect(claude.cost).toBeCloseTo(0.5, 9)
      expect(claude.costCoverage).toEqual({ pricedRequests: 1, unpricedRequests: 1 })
      expect(claude.speed?.totalP50Ms).toBeUndefined()

      const hour = yield* fixture.reads(sessions.usageReportAll({ group: "hour" }))
      expect(hour.result.rowCount).toBe(2)
      expect(rowByInput(hour.result.rows, 300).logical).toBe(2)
      expect(rowByInput(hour.result.rows, 300).cost).toBeCloseTo(0.3, 9)
      expect(rowByInput(hour.result.rows, 1800).logical).toBe(4)
      expect(rowByInput(hour.result.rows, 1800).cost).toBeCloseTo(1.2, 9)

      const daily = yield* fixture.reads(sessions.usageReportAll({ group: "day", timeZone: "UTC" }))
      expect(daily.result.rowCount).toBe(1)
      expect(daily.result.rows[0]!.logical).toBe(6)

      const provider = yield* fixture.reads(sessions.usageReportAll({ group: "provider" }))
      expect(provider.result.rowCount).toBe(2)
      expect(rowByInput(provider.result.rows, 1000).cost).toBeCloseTo(1.0, 9)
      expect(rowByInput(provider.result.rows, 1100).cost).toBeCloseTo(0.5, 9)

      const session = yield* fixture.reads(sessions.usageReportAll({ group: "session" }))
      expect(session.result.rowCount).toBe(2)
      expect(rowByInput(session.result.rows, 600).logical).toBe(3)
      expect(rowByInput(session.result.rows, 1500).logical).toBe(3)

      const filtered = yield* fixture.reads(
        sessions.usageReportAll({
          group: "model",
          providerID: Provider.ID.make("openai"),
          from: t0 + 60 * minute,
          to: t0 + 120 * minute,
        }),
      )
      expect(filtered.result.rowCount).toBe(1)
      expect(filtered.result.total.logical).toBe(2)
      expect(filtered.result.total.tokens.input).toBe(700)
      expect(filtered.result.total.cost).toBeCloseTo(0.7, 9)
      expect(filtered.result.rows[0]!.speed?.totalP50Ms).toBe(300)
      expect(filtered.result.rows[0]!.speed?.totalP95Ms).toBe(400)

      const paged = yield* fixture.reads(sessions.usageReportAll({ group: "hour", limit: 1, sort: "cost", order: "desc" }))
      expect(paged.result.rowCount).toBe(2)
      expect(paged.result.rows).toHaveLength(1)
      expect(paged.result.rows[0]!.tokens.input).toBe(1800)
      expect(paged.result.nextOffset).toBe(1)

      const spendDay = yield* fixture.reads(SessionUsageRead.localSpend(db, { dayStart, dayEnd: dayStart + day }))
      expect(spendDay.result).toEqual([
        { providerID: Provider.ID.make("anthropic"), knownUSD: 0.5, pricedRequests: 1, unpricedRequests: 1 },
        { providerID: Provider.ID.make("openai"), knownUSD: expect.closeTo(1.0, 9), pricedRequests: 4, unpricedRequests: 0 },
      ])
      const spendNarrow = yield* fixture.reads(
        SessionUsageRead.localSpend(db, { dayStart: t0 + 60 * minute, dayEnd: t0 + 86 * minute }),
      )
      expect(spendNarrow.result).toEqual([
        { providerID: Provider.ID.make("anthropic"), knownUSD: 0.5, pricedRequests: 1, unpricedRequests: 0 },
        { providerID: Provider.ID.make("openai"), knownUSD: expect.closeTo(0.7, 9), pricedRequests: 2, unpricedRequests: 0 },
      ])

      const rateBackend = yield* fixture.reads(
        SessionUsageRead.localUsage(db, { from: t0, to: t0 + 120 * minute, scope: { type: "backend" } }),
      )
      expect(binsWithRequests(rateBackend.result, "openai")).toEqual([
        [0, 1, expect.closeTo(0.1, 9)],
        [10, 1, expect.closeTo(0.2, 9)],
        [70, 1, expect.closeTo(0.3, 9)],
        [75, 1, expect.closeTo(0.4, 9)],
      ])
      expect(binsWithRequests(rateBackend.result, "anthropic")).toEqual([
        [80, 1, expect.closeTo(0.5, 9)],
        [90, 1, undefined],
      ])
      const rateLocation = yield* fixture.reads(
        SessionUsageRead.localUsage(db, {
          from: t0,
          to: t0 + 120 * minute,
          scope: { type: "location", location: fixture.a.location },
        }),
      )
      expect(binsWithRequests(rateLocation.result, "openai").map((bin) => bin[0])).toEqual([0, 10, 70])
      expect(binsWithRequests(rateLocation.result, "anthropic")).toEqual([])

      const raw = [summary, model, hour, daily, provider, session, filtered, paged, spendDay, spendNarrow, rateBackend, rateLocation].flatMap(
        (read) => read.raw,
      )
      expect(raw).toEqual([])
      expect(yield* fixture.factCount("usage_analytics_request")).toBe(6)
      expect(yield* fixture.factCount("session_provider_request")).toBe(6)
    }).pipe(Effect.provide(runtime), Effect.scoped),
  ), 30_000)

test("a new request updates prepared results once, ignores duplicate events, and never rescans raw history", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* setup
      const { sessions, db } = fixture
      for (const spec of specs) yield* fixture.publish(spec)
      yield* fixture.warm

      yield* fixture.publish(late)
      yield* fixture.publish(late)
      yield* fixture.publish(specs[0]!)

      const summary = yield* fixture.reads(sessions.usageAll())
      expect(summary.result.logical).toBe(7)
      expect(summary.result.tokens.input).toBe(2800)
      expect(summary.result.tokens.output).toBe(1400)
      expect(summary.result.cost).toBeCloseTo(2.1, 9)

      const model = yield* fixture.reads(sessions.usageReportAll({ group: "model" }))
      const gpt = rowByInput(model.result.rows, 1700)
      expect(gpt.logical).toBe(5)
      expect(gpt.cost).toBeCloseTo(1.6, 9)
      expect(gpt.costProvenance).toBe("recorded")
      expect(gpt.speed?.totalP50Ms).toBe(300)
      expect(gpt.speed?.totalP95Ms).toBe(500)
      expect(gpt.speed?.firstOutputP50Ms).toBe(30)
      expect(gpt.speed?.firstOutputP95Ms).toBe(50)
      expect(gpt.speed?.generationSamples).toBe(5)
      expect(gpt.speed?.generationP50TokensPerSecond).toBeCloseTo(25, 6)
      expect(gpt.speed?.generationP90TokensPerSecond).toBeCloseTo(100, 6)
      expect(model.result.total.costCoverage).toEqual({ pricedRequests: 6, unpricedRequests: 1 })

      const hour = yield* fixture.reads(sessions.usageReportAll({ group: "hour" }))
      expect(hour.result.rowCount).toBe(2)
      expect(rowByInput(hour.result.rows, 2500).logical).toBe(5)
      expect(rowByInput(hour.result.rows, 2500).cost).toBeCloseTo(1.8, 9)

      const spend = yield* fixture.reads(SessionUsageRead.localSpend(db, { dayStart, dayEnd: dayStart + day }))
      expect(spend.result).toEqual([
        { providerID: Provider.ID.make("anthropic"), knownUSD: 0.5, pricedRequests: 1, unpricedRequests: 1 },
        { providerID: Provider.ID.make("openai"), knownUSD: expect.closeTo(1.6, 9), pricedRequests: 5, unpricedRequests: 0 },
      ])
      const rate = yield* fixture.reads(
        SessionUsageRead.localUsage(db, { from: t0, to: t0 + 120 * minute, scope: { type: "backend" } }),
      )
      expect(binsWithRequests(rate.result, "openai")).toEqual([
        [0, 1, expect.closeTo(0.1, 9)],
        [10, 1, expect.closeTo(0.2, 9)],
        [70, 1, expect.closeTo(0.3, 9)],
        [75, 1, expect.closeTo(0.4, 9)],
        [100, 1, expect.closeTo(0.6, 9)],
      ])

      expect([summary, model, hour, spend, rate].flatMap((read) => read.raw)).toEqual([])
      expect(yield* fixture.factCount("usage_analytics_request")).toBe(7)
      expect(yield* fixture.factCount("session_provider_request")).toBe(7)
    }).pipe(Effect.provide(runtime), Effect.scoped),
  ), 30_000)
