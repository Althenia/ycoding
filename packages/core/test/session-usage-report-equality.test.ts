import { expect, test } from "bun:test"
import { Duration, Effect, Layer } from "effect"
import { Agent } from "../src/agent"
import { Catalog } from "../src/catalog"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Location } from "../src/location"
import { LocationServiceMap } from "../src/location-service-map"
import type { LocationServices } from "../src/location-services"
import { CatalogModel } from "../src/model"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { Provider } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { Session } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionSchema } from "../src/session/schema"
import { SessionProviderRequestTable, SessionTable } from "../src/session/sql"
import { SessionProviderRequest } from "../src/session/provider-request"
import { UsageAnalytics } from "../src/usage-analytics"
import { UsageStage } from "../src/usage-stage"
import { Money } from "@ycoding-ai/schema/money"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { fixedLocations } from "./fixture/location-map"

const day = 86_400_000
const start = Date.UTC(2026, 2, 1)
const updated = Date.now()
const projectB = Project.ID.make("equality-project")
const rootID = SessionSchema.ID.make("ses_equality_root")
const sessionIDs = [
  rootID,
  SessionSchema.ID.make("ses_equality_child_a"),
  SessionSchema.ID.make("ses_equality_child_b"),
  SessionSchema.ID.make("ses_equality_other_a"),
  SessionSchema.ID.make("ses_equality_other_b"),
  SessionSchema.ID.make("ses_equality_other_c"),
]
const family = new Set(sessionIDs.slice(0, 3))
const model = (providerID: string, id: string, variant?: string, profile?: string) =>
  CatalogModel.Ref.make({
    providerID: Provider.ID.make(providerID),
    id: CatalogModel.ID.make(id),
    ...(variant === undefined ? {} : { variant: CatalogModel.VariantID.make(variant) }),
    ...(profile === undefined ? {} : { profile }),
  })
const models = [
  model("openai", "gpt-equality"),
  model("openai", "gpt-equality", "high"),
  model("openai", "gpt-equality", undefined, "work account"),
  model("anthropic", "claude/equality"),
  model("custom", "ünï cödé 😀", "x", "p"),
  model("custom", "plain"),
  model("p", "m", undefined, "x"),
  model("p", "m", "x"),
]
const agents = [Agent.ID.make("build"), Agent.ID.make("plan"), Agent.ID.make("ünï-agent")]
const sources = ["step", "step", "title", "step", "goal", "step", "decision"] as const
const continuations = ["full", "continued", "fallback", "full"] as const

type Fixture = ReturnType<typeof fixture>[number]

function fixture() {
  return Array.from({ length: 480 }, (_, index) => {
    const timing =
      index % 4 === 0
        ? {
            firstOutputMs: (index * 53) % 900,
            totalMs: 1000 + ((index * 29) % 4000),
            generatedTokens: 50 + (index % 200),
            generationDurationNs: 1_000_000_000 + index * 1_000_000,
          }
        : index % 4 === 1
          ? {
              firstOutputMs: (index * 31) % 700,
              totalMs: 900 + ((index * 17) % 3000),
              generatedTokens: 20 + (index % 90),
              observedGenerationDurationNs: 1_500_000_000 + index * 2_000_000,
            }
          : index % 4 === 2
            ? { totalMs: 500 + ((index * 7) % 800), receivedOutput: { estimatedTokens: 999, durationNs: 1_000_000_000 } }
            : undefined
    return {
      id: ProviderRequest.ID.make(`prq_equality_${index.toString().padStart(4, "0")}`),
      session_id: sessionIDs[index % sessionIDs.length]!,
      source: sources[index % sources.length]!,
      agent: agents[index % agents.length]!,
      model: models[index % models.length]!,
      route_id: "test",
      prompt_cache_key: "key",
      system_digest: "system",
      tool_digest: "tools",
      request: Math.floor(index / sessionIDs.length) + 1,
      attempts: 1 + (index % 2),
      invalidation: "first-request" as const,
      continuation: continuations[index % continuations.length]!,
      cache_read_reported: index % 6 === 0 ? false : index % 6 === 1 ? null : true,
      timing,
      cost: index % 4 === 0 ? null : ((index % 9) + 1) / 1000,
      tokens: {
        input: 100 + ((index * 37) % 900),
        output: (index * 13) % 300,
        reasoning: index % 5 === 0 ? 40 : 0,
        cache: { read: (index * 101) % 2000, write: (index * 17) % 500 },
      },
      time_created: start + index * 7_700_000 + (index % 7) * 1000,
    }
  })
}

const rows = fixture()

function priced(row: Fixture) {
  return row.cost === null && row.source !== "decision" && row.model.providerID === "openai"
    ? (row.tokens.input * 2) / 1_000_000
    : undefined
}

function localParts(time: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(time)
  const value = (type: string) => Number(parts.find((part) => part.type === type)!.value)
  const local = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second"),
  )
  const minutes = Math.round((local - Math.floor(time / 1000) * 1000) / 60_000)
  const pad = (number: number) => number.toString().padStart(2, "0")
  return {
    date: `${value("year")}-${pad(value("month"))}-${pad(value("day"))}`,
    hour: pad(value("hour")),
    offset: `${minutes < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`,
  }
}

function keyOf(row: Fixture, group: ProviderRequest.ReportGroup, timeZone?: string) {
  if (group === "model")
    return [row.model.providerID, row.model.id, row.model.variant, row.model.profile]
      .flatMap((part) => (part === undefined ? [] : [encodeURIComponent(part)]))
      .join("/")
  if (group === "session") return row.session_id
  if (group === "project")
    return family.has(row.session_id) || row.session_id.endsWith("a") ? Project.ID.global : projectB
  if (group === "agent") return row.agent
  if (timeZone) {
    const local = localParts(row.time_created, timeZone)
    if (group === "day") return local.date
    if (group === "month") return local.date.slice(0, 7)
    return `${local.date}T${local.hour}:00:00${local.offset}`
  }
  const iso = new Date(row.time_created).toISOString()
  if (group === "day") return iso.slice(0, 10)
  if (group === "month") return iso.slice(0, 7)
  return `${iso.slice(0, 13)}:00:00.000Z`
}

function nearestRank(values: number[], percentile: number) {
  const sorted = values.toSorted((left, right) => left - right)
  return sorted[Math.ceil((percentile * sorted.length) / 100) - 1]!
}

function expectedMetrics(group: readonly Fixture[]) {
  const corrections = group.flatMap((row) => priced(row) ?? [])
  const recorded = group.flatMap((row) => (row.cost === null ? [] : [row.cost]))
  const first = group.flatMap((row) => row.timing?.firstOutputMs ?? [])
  const total = group.flatMap((row) => row.timing?.totalMs ?? [])
  const generation = group.flatMap((row) => {
    const observed = row.timing?.observedGenerationDurationNs
    const duration =
      row.timing?.generationDurationNs ?? (observed !== undefined && observed >= 1e9 ? observed : undefined)
    const tokens = row.timing?.generatedTokens
    return duration !== undefined && duration > 0 && tokens !== undefined && tokens > 0
      ? [{ duration, tokens, providerTimed: row.timing?.generationDurationNs !== undefined }]
      : []
  })
  return {
    logical: group.length,
    physical: group.reduce((sum, row) => sum + row.attempts, 0),
    helpers: group.filter((row) => row.source !== "step").length,
    continued: group.filter((row) => row.continuation === "continued").length,
    fallback: group.filter((row) => row.continuation === "fallback").length,
    costCoverage: {
      pricedRequests: recorded.length + corrections.length,
      unpricedRequests: group.length - recorded.length - corrections.length,
    },
    tokens: {
      input: group.reduce((sum, row) => sum + row.tokens.input, 0),
      output: group.reduce((sum, row) => sum + row.tokens.output, 0),
      reasoning: group.reduce((sum, row) => sum + row.tokens.reasoning, 0),
      cache: {
        read: group.reduce((sum, row) => sum + row.tokens.cache.read, 0),
        write: group.reduce((sum, row) => sum + row.tokens.cache.write, 0),
      },
    },
    cacheReadReported: group.every((row) => row.cache_read_reported === true),
    cost:
      recorded.length + corrections.length === 0
        ? undefined
        : [...recorded, ...corrections].reduce((sum, cost) => sum + cost, 0),
    costProvenance: corrections.length > 0 ? "current_catalog" : "recorded",
    speed:
      first.length + total.length + generation.length === 0
        ? undefined
        : {
            samples: first.length,
            generationSamples: generation.length,
            providerTimedSamples: generation.filter((sample) => sample.providerTimed).length,
            observedSamples: generation.filter((sample) => !sample.providerTimed).length,
            ...(generation.length === 0
              ? {}
              : {
                  generationP50TokensPerSecond: nearestRank(
                    generation.map((sample) => (sample.tokens * 1_000_000_000) / sample.duration),
                    50,
                  ),
                  generationP90TokensPerSecond: nearestRank(
                    generation.map((sample) => (sample.tokens * 1_000_000_000) / sample.duration),
                    90,
                  ),
                }),
            ...(first.length === 0
              ? {}
              : { firstOutputP50Ms: nearestRank(first, 50), firstOutputP95Ms: nearestRank(first, 95) }),
            ...(total.length === 0 ? {} : { totalP50Ms: nearestRank(total, 50), totalP95Ms: nearestRank(total, 95) }),
            ...(generation.length === 0
              ? {}
              : {
                  outputTokensPerSecond:
                    generation.reduce((sum, item) => sum + item.tokens, 0) /
                    (generation.reduce((sum, item) => sum + item.duration, 0) / 1_000_000_000),
                }),
          },
  }
}

function expectedReport(input: {
  group: ProviderRequest.ReportGroup
  timeZone?: string
  from?: number
  to?: number
  scope?: ReadonlySet<string>
  sort?: ProviderRequest.ReportInput["sort"]
  order?: "asc" | "desc"
  offset?: number
  limit?: number
}) {
  const scoped = rows.filter(
    (row) =>
      (input.scope === undefined || input.scope.has(row.session_id)) &&
      (input.from === undefined || row.time_created >= input.from) &&
      (input.to === undefined || row.time_created < input.to),
  )
  const groups = Map.groupBy(scoped, (row) => keyOf(row, input.group, input.timeZone))
  const entries = [...groups].map(([key, group]) => {
    const representative = group.toSorted(
      (left, right) =>
        (input.scope ? 1 : -1) * (sessionIDs.indexOf(left.session_id) - sessionIDs.indexOf(right.session_id)) ||
        left.request - right.request,
    )[0]!
    const label =
      input.group === "model"
        ? `${representative.model.providerID}/${representative.model.id}${representative.model.variant ? ` (${representative.model.variant})` : ""}${representative.model.profile ? ` · ${representative.model.profile}` : ""}`
        : undefined
    return { key, group, label, ...expectedMetrics(group) }
  })
  const metric = (entry: (typeof entries)[number]) =>
    input.sort === "cost"
      ? (entry.cost ?? 0)
      : input.sort === "tokens"
        ? entry.tokens.input +
          entry.tokens.output +
          entry.tokens.reasoning +
          entry.tokens.cache.read +
          entry.tokens.cache.write
        : input.sort === "steps"
          ? entry.logical
          : input.sort === "input"
            ? entry.tokens.input
            : input.sort === "output"
              ? entry.tokens.output
              : input.sort === "reasoning"
                ? entry.tokens.reasoning
                : input.sort === "cacheRead"
                  ? entry.tokens.cache.read
                  : input.sort === "cacheWrite"
                    ? entry.tokens.cache.write
                    : 0
  const direction = input.order === "desc" ? -1 : 1
  const chronological = (entry: (typeof entries)[number]) => Math.min(...entry.group.map((row) => row.time_created))
  const sorted = entries.toSorted((left, right) => {
    if (input.sort && input.sort !== "key")
      return direction * (metric(left) - metric(right)) || (left.key < right.key ? -1 : 1)
    if (input.group === "hour" && input.timeZone) return direction * (chronological(left) - chronological(right))
    return direction * (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
  })
  const offset = input.offset ?? 0
  return {
    total: expectedMetrics(scoped),
    rowCount: entries.length,
    rows: sorted.slice(offset, offset + (input.limit ?? 100)),
  }
}

function expectMetrics(
  actual: Omit<ProviderRequest.ReportMetrics, "costProvenance"> & {
    costProvenance?: string
    speed?: ProviderRequest.Speed
  },
  expected: ReturnType<typeof expectedMetrics>,
  label: string,
  compare: { readonly speed: boolean; readonly provenance: boolean } = { speed: false, provenance: true },
) {
  expect({ label, logical: actual.logical, physical: actual.physical, helpers: actual.helpers }).toEqual({
    label,
    logical: expected.logical,
    physical: expected.physical,
    helpers: expected.helpers,
  })
  expect({ label, continued: actual.continued, fallback: actual.fallback, tokens: actual.tokens }).toEqual({
    label,
    continued: expected.continued,
    fallback: expected.fallback,
    tokens: expected.tokens,
  })
  expect(actual.cacheReadReported).toBe(expected.cacheReadReported)
  if (expected.cost === undefined) expect(actual.cost).toBeUndefined()
  else {
    expect(actual.cost).toBeCloseTo(expected.cost, 9)
    if (compare.provenance) expect(actual.costProvenance).toBe(expected.costProvenance)
  }
  if (!compare.speed) return
  if (expected.speed === undefined) expect(actual.speed).toBeUndefined()
  else {
    const { outputTokensPerSecond, ...latency } = expected.speed
    expect({ label, ...actual.speed, outputTokensPerSecond: undefined }).toEqual({
      label,
      ...latency,
      outputTokensPerSecond: undefined,
    })
    if (outputTokensPerSecond === undefined) expect(actual.speed?.outputTokensPerSecond).toBeUndefined()
    else expect(actual.speed?.outputTokensPerSecond).toBeCloseTo(outputTokensPerSecond, 6)
  }
}

const catalogLayer = Layer.mock(Catalog.Service, {
  provider: {
    get: () => Effect.succeed(undefined),
    all: () => Effect.succeed([]),
    available: () => Effect.succeed([]),
  },
  model: {
    get: (provider, id) =>
      Effect.succeed({
        ...CatalogModel.Info.empty(provider, id),
        cost:
          provider === Provider.ID.make("openai")
            ? [
                {
                  input: Money.USDPerMillionTokens.make(2),
                  output: Money.USDPerMillionTokens.make(0),
                  cache: { read: Money.USDPerMillionTokens.make(0), write: Money.USDPerMillionTokens.make(0) },
                },
              ]
            : [],
      }),
    all: () => Effect.succeed([]),
    available: () => Effect.succeed([]),
    default: () => Effect.succeed(undefined),
    defaultSelection: () => Effect.succeed(undefined),
    forConnection: (model) => Effect.succeed(model),
    small: () => Effect.succeed(undefined),
  },
})

const locations = Layer.effect(
  LocationServiceMap.Service,
  Effect.gen(function* () {
    const map = yield* fixedLocations((_ref: Location.Ref) => catalogLayer as unknown as Layer.Layer<LocationServices>, {
      idleTimeToLive: Duration.zero,
    })
    return map
  }),
)

const seeded = Layer.effect(
  Database.Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db
      .insert(ProjectTable)
      .values([
        { id: Project.ID.global, worktree: AbsolutePath.make("/equality"), sandboxes: [] },
        { id: projectB, worktree: AbsolutePath.make("/equality-b"), sandboxes: [] },
      ])
      .run()
    yield* database.db
      .insert(SessionTable)
      .values(
        sessionIDs.map((id, index) => ({
          id,
          project_id: family.has(id) || id.endsWith("a") ? Project.ID.global : projectB,
          directory: "/equality",
          title: `Session ${index}`,
          time_updated: updated - index,
          parent_id: index === 1 || index === 2 ? rootID : undefined,
        })),
      )
      .run()
    yield* database.db.insert(SessionProviderRequestTable).values(rows).run()
    yield* database.db.transaction(() => UsageAnalytics.backfill(database.db).pipe(Effect.andThen(UsageStage.backfill(database.db))))
    return database
  }),
).pipe(Layer.provide(Database.layer({ path: ":memory:" })))

const runtime = AppNodeBuilder.build(LayerNode.group([Database.node, Session.node, LocationServiceMap.node]), [
  [UsageAnalytics.node, Layer.mock(UsageAnalytics.Service, {})],
  [Database.node, seeded],
  [SessionExecution.node, SessionExecution.noopLayer],
  [LocationServiceMap.node, locations],
])

const zones = [undefined, "America/New_York", "Asia/Kolkata", "Australia/Sydney", "Pacific/Auckland"] as const
const groups = ["model", "session", "project", "agent", "hour", "day", "month"] as const

test("SQL and in-memory report speed ignore received-output estimates", () =>
  Effect.runPromise(Effect.gen(function* () {
    const session = yield* Session.Service
    const db = (yield* Database.Service).db
    const records = (yield* db.select().from(SessionProviderRequestTable).all()).map(SessionProviderRequest.rowRecord)
    const report = yield* session.usageReportAll({ group: "session", limit: 200 })
    for (const row of report.rows)
      expect(row.speed).toEqual(SessionProviderRequest.reportSpeed(records.filter((record) => record.sessionID === row.key)))
  }).pipe(Effect.provide(runtime), Effect.scoped)), 60_000)

test(
  "global usage reports equal independently computed aggregates for every group, time zone, and range",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* Session.Service
        const ranges = [
          {},
          { from: start + 5 * day, to: start + 30 * day },
          { from: start + 7 * day + 3_600_000 },
          { to: start + 10 * day },
        ]
        for (const group of groups)
          for (const timeZone of zones)
            for (const range of ranges) {
              const input = { group, ...(timeZone ? { timeZone } : {}), ...range, limit: 200 }
              const actual = yield* session.usageReportAll(input)
              const expected = expectedReport({ group, timeZone, ...range, limit: 200 })
              const label = JSON.stringify(input)
              expect({ label, rowCount: actual.rowCount }).toEqual({ label, rowCount: expected.rowCount })
              expect(actual.rows.map((row) => row.key)).toEqual(expected.rows.map((row) => row.key))
              expectMetrics(actual.total, expected.total, `${label} total`)
              actual.rows.forEach((row, index) => {
                if (group === "model") expect(row.label).toBe(expected.rows[index]!.label!)
                expectMetrics(row, expected.rows[index]!, `${label} ${row.key}`, { speed: true, provenance: true })
              })
            }
      }).pipe(Effect.provide(runtime), Effect.scoped),
    ),
  60_000,
)

test(
  "usage reports order and page by every sort metric",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* Session.Service
        for (const group of ["model", "session", "day"] as const)
          for (const sort of [
            "key",
            "tokens",
            "cost",
            "steps",
            "input",
            "output",
            "reasoning",
            "cacheRead",
            "cacheWrite",
          ] as const)
            for (const order of ["asc", "desc"] as const) {
              const input = { group, sort, order, offset: 1, limit: 3 }
              const actual = yield* session.usageReportAll(input)
              const expected = expectedReport(input)
              expect(actual.rows.map((row) => row.key)).toEqual(expected.rows.map((row) => row.key))
              expect(actual.nextOffset).toBe(
                1 + expected.rows.length < expected.rowCount ? 1 + expected.rows.length : undefined,
              )
            }
      }).pipe(Effect.provide(runtime), Effect.scoped),
    ),
  60_000,
)

test(
  "a root Session usage report covers its family and a child Session covers only itself",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* Session.Service
        for (const group of groups) {
          const actual = yield* session.usageReport({
            sessionID: rootID,
            group,
            timeZone: "America/New_York",
            limit: 200,
          })
          const expected = expectedReport({ group, timeZone: "America/New_York", scope: family, limit: 200 })
          expect(actual.rows.map((row) => row.key)).toEqual(expected.rows.map((row) => row.key))
          expectMetrics(actual.total, expected.total, `${group} family total`)
          actual.rows.forEach((row, index) => {
            if (group === "model") expect(row.label).toBe(expected.rows[index]!.label!)
            expectMetrics(row, expected.rows[index]!, `${group} family ${row.key}`, { speed: true, provenance: true })
          })
        }
        const child = yield* session.usageReport({ sessionID: sessionIDs[1]!, group: "model", limit: 200 })
        expectMetrics(
          child.total,
          expectedReport({ group: "model", scope: new Set([sessionIDs[1]!]) }).total,
          "child total",
        )
      }).pipe(Effect.provide(runtime), Effect.scoped),
    ),
  60_000,
)

test(
  "usage summaries equal independently computed model aggregates for a root Session and globally",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* Session.Service
        for (const [summary, scope] of [
          [yield* session.usageAll(), undefined],
          [yield* session.usage(rootID), family],
        ] as const) {
          const scoped = rows.filter((row) => scope === undefined || scope.has(row.session_id))
          expectMetrics(summary, expectedMetrics(scoped), "summary", { speed: false, provenance: false })
          const newest = scoped.reduce((latest, row) => (row.time_created > latest.time_created ? row : latest))
          expect(summary.latestInvalidation).toBe(newest.invalidation)
          expect(summary.latestNamespace).toBe(newest.prompt_cache_key.slice(0, 8))
          expect(summary.latestTiming).toEqual(newest.timing)
          const byModel = Map.groupBy(scoped, (row) =>
            JSON.stringify([row.model.providerID, row.model.id, row.model.variant ?? null, row.model.profile ?? null]),
          )
          expect(summary.models?.length).toBe(byModel.size)
          for (const model of summary.models ?? []) {
            const expected = expectedMetrics(
              byModel.get(
                JSON.stringify([
                  model.model.providerID,
                  model.model.id,
                  model.model.variant ?? null,
                  model.model.profile ?? null,
                ]),
              )!,
            )
            expect(model.requests).toBe(expected.logical)
            expect(model.tokens).toEqual(expected.tokens)
            if (expected.cost === undefined) expect(model.cost).toBeUndefined()
            else expect(model.cost).toBeCloseTo(expected.cost, 9)
          }
        }
      }).pipe(Effect.provide(runtime), Effect.scoped),
    ),
  60_000,
)

test("an empty history reports zero rows, no cost, and an empty summary", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Session.Service
      const report = yield* session.usageReportAll({ group: "day", timeZone: "Asia/Kolkata" })
      expect(report).toMatchObject({ rowCount: 0, rows: [], total: { logical: 0 } })
      expect(report.total.cost).toBeUndefined()
      expect((yield* session.usageAll()).logical).toBe(0)
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([Database.node, Session.node, LocationServiceMap.node]), [
          [Database.node, Database.layer({ path: ":memory:" })],
          [SessionExecution.node, SessionExecution.noopLayer],
          [LocationServiceMap.node, locations],
        ]),
      ),
      Effect.scoped,
    ),
  ))
