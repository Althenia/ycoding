import { afterAll, expect, test } from "bun:test"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Context, DateTime, Effect, Exit, Layer } from "effect"
import { sql } from "drizzle-orm"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Catalog } from "../src/catalog"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { sqliteLayer } from "../src/database/sqlite.bun"
import { Sqlite } from "../src/database/sqlite"
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
import { RetentionSettings } from "../src/retention-settings"
import { Session } from "../src/session"
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { SessionSchema } from "../src/session/schema"
import { SessionProviderRequestTable, SessionTable } from "../src/session/sql"
import { SessionUsageCleanup } from "../src/session/usage-cleanup"
import { SessionUsageRead } from "../src/session/usage-read"
import { UsageAnalytics } from "../src/usage-analytics"
import { Agent } from "@ycoding-ai/schema/agent"
import { Model } from "@ycoding-ai/schema/model"
import { Money } from "@ycoding-ai/schema/money"
import { Provider } from "@ycoding-ai/schema/provider"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { AbsolutePath } from "@ycoding-ai/schema/schema"
import { SessionMessage } from "@ycoding-ai/schema/session-message"

const minute = 60_000
const hour = 3_600_000
const day = 86_400_000
const directories: string[] = []

afterAll(() => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))))

const rawSource = /\b(?:from|join)\s+["`]?(usage_analytics_request|session_provider_request)["`]?(?![\w$])/i
const isRawAggregation = (query: string) =>
  /^\s*(?:select|with|insert)\b/i.test(query) && /\bselect\b/i.test(query) && rawSource.test(query)

type Timing = ProviderRequest.Timing
type Spec = {
  readonly id: string
  readonly session: string
  readonly request: number
  readonly time: number
  readonly provider: string
  readonly model: string
  readonly variant?: string
  readonly profile?: string
  readonly agent?: string
  readonly source?: ProviderRequest.Source
  readonly cost?: number
  readonly input: number
  readonly output?: number
  readonly read?: number
  readonly write?: number
  readonly timing?: Timing
  readonly anchor?: { readonly sessionID: string; readonly inputID: string }
  readonly inputID?: string
}

type SessionSpec = { readonly id: string; readonly directory: string; readonly workspaceID?: string; readonly parentID?: string }

function harness(options: { readonly path?: string } = {}) {
  const queries: string[] = []
  const logged: { sql: string; params: unknown[] }[] = []
  const prices = new Map<string, ReadonlyArray<Model.Cost>>()
  const unavailable = new Set<string>()
  const retention = { recordsDays: 30, usageDays: 30 }
  let native: import("bun:sqlite").Database | undefined
  const database = Layer.effect(
    Database.Service,
    Effect.gen(function* () {
      native = (yield* Sqlite.Native) as import("bun:sqlite").Database
      const db = yield* EffectDrizzleSqlite.make().pipe(
        Effect.provideService(EffectDrizzleSqlite.EffectLogger, {
          logQuery: (query, params) =>
            Effect.sync(() => {
              queries.push(query)
              logged.push({ sql: query, params })
            }),
        }),
        Effect.provide(EffectDrizzleSqlite.DefaultServices),
      )
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* DatabaseMigration.apply(db)
      return { db }
    }),
  ).pipe(Layer.provide(sqliteLayer({ filename: options.path ?? ":memory:" })))
  const catalog = (directory: string) =>
    Context.make(Catalog.Service, {
      model: {
        get: (provider: Provider.ID, id: CatalogModel.ID) =>
          Effect.sync(() => ({
            ...CatalogModel.Info.empty(provider, id),
            cost: prices.get(`${directory}|${provider}|${id}`) ?? [],
          })),
      },
    } as unknown as Catalog.Interface) as Context.Context<LocationServices>
  const locations = Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const map = yield* fixedLocations(
        (ref: Location.Ref) => Layer.effectContext(Effect.sync(() => catalog(ref.directory))),
        { idleTimeToLive: "60 minutes" },
      )
      return LocationServiceMap.Service.of({
        ...map,
        contextEffect: (ref, nodes) =>
          Effect.suspend(() =>
            unavailable.has(ref.directory)
              ? Effect.die({ _tag: "PlatformError", reason: { _tag: "NotFound" } })
              : map.contextEffect(ref, nodes),
          ),
      })
    }),
  )
  const runtime = AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventRuntime.node,
      Session.node,
      UsageAnalytics.node,
      SessionUsageCleanup.node,
      LocationServiceMap.node,
    ]),
    [
      [Database.node, database],
      [SessionExecution.node, SessionExecution.noopLayer],
      [LocationServiceMap.node, locations],
      [
        RetentionSettings.node,
        Layer.succeed(RetentionSettings.Service, {
          read: () =>
            Effect.sync(() => ({
              recordsDays: retention.recordsDays,
              usageDays: retention.usageDays,
              latencyDays: 30,
              incidentDays: 30,
            })),
        }),
      ],
    ],
  )
  const reads = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      queries.length = 0
      const result = yield* effect
      return { result, raw: queries.filter(isRawAggregation) }
    })
  const explain = (query: string, params: ReadonlyArray<unknown>) => {
    const statement = native!.prepare<{ detail: string }, import("bun:sqlite").SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${query}`)
    try {
      return statement.all(...(params as import("bun:sqlite").SQLQueryBindings[]))
    } finally {
      statement.finalize()
    }
  }
  return { queries, logged, prices, unavailable, retention, runtime, reads, explain }
}

const seedSessions = (sessions: ReadonlyArray<SessionSpec>) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/stage"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
    for (const session of sessions)
      yield* db
        .insert(SessionTable)
        .values({
          id: SessionSchema.ID.make(session.id),
          project_id: Project.ID.global,
          directory: session.directory,
          workspace_id: session.workspaceID as never,
          parent_id: session.parentID === undefined ? undefined : SessionSchema.ID.make(session.parentID),
          title: session.id,
        })
        .run()
  }).pipe(Effect.orDie)

const record = (spec: Spec) =>
  Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    yield* events.publish(SessionEvent.ProviderRequestRecorded, recorded(spec))
  })

const recorded = (spec: Spec) => ({
  id: ProviderRequest.ID.make(spec.id),
  sessionID: SessionSchema.ID.make(spec.session),
  source: spec.source ?? ("step" as const),
  agent: Agent.ID.make(spec.agent ?? "build"),
  model: Model.Ref.make({
    providerID: Provider.ID.make(spec.provider),
    id: Model.ID.make(spec.model),
    ...(spec.variant === undefined ? {} : { variant: spec.variant as Model.VariantID }),
    ...(spec.profile === undefined ? {} : { profile: spec.profile as Model.ProfileName }),
  }),
  routeID: "route",
  promptCacheKey: `ns-${spec.id}-cache`,
  systemDigest: "system",
  toolDigest: "tools",
  request: spec.request,
  attempts: 1,
  invalidation: "first-request" as const,
  continuation: "full" as const,
  ...(spec.cost === undefined ? {} : { cost: Money.USD.make(spec.cost) }),
  ...(spec.timing === undefined ? {} : { timing: spec.timing }),
  ...(spec.anchor === undefined
    ? {}
    : {
        usageAnchor: {
          sessionID: SessionSchema.ID.make(spec.anchor.sessionID),
          inputID: SessionMessage.ID.make(spec.anchor.inputID),
        },
      }),
  ...(spec.inputID === undefined ? {} : { inputID: SessionMessage.ID.make(spec.inputID) }),
  tokens: {
    input: spec.input,
    output: spec.output ?? 0,
    reasoning: 0,
    cache: { read: spec.read ?? 0, write: spec.write ?? 0 },
  },
  time: DateTime.makeUnsafe(spec.time),
})

const inRange = (spec: Spec, range: { readonly from?: number; readonly to?: number }) =>
  spec.time >= (range.from ?? -Infinity) && spec.time < (range.to ?? Infinity)

const rank = (values: ReadonlyArray<number>, percent: number) => {
  const sorted = values.toSorted((left, right) => left - right)
  return sorted[Math.ceil((sorted.length * percent) / 100) - 1]
}

const generation = (timing: Timing | undefined) => {
  if (!timing) return undefined
  const duration =
    timing.generationDurationNs !== undefined
      ? timing.generationDurationNs
      : (timing.observedGenerationDurationNs ?? 0) >= 1_000_000_000
        ? timing.observedGenerationDurationNs
        : undefined
  const tokens = timing.generatedTokens
  if (duration === undefined || tokens === undefined || duration <= 0 || tokens <= 0) return undefined
  return { tokens, duration, provider: timing.generationDurationNs !== undefined }
}

const speedOracle = (specs: ReadonlyArray<Spec>) => {
  const first = specs.flatMap((spec) => (spec.timing?.firstOutputMs === undefined ? [] : [spec.timing.firstOutputMs]))
  const total = specs.flatMap((spec) => (spec.timing?.totalMs === undefined ? [] : [spec.timing.totalMs]))
  const valid = specs.flatMap((spec) => {
    const value = generation(spec.timing)
    return value ? [value] : []
  })
  if (first.length === 0 && total.length === 0 && valid.length === 0) return undefined
  const rates = valid.map((value) => (value.tokens * 1_000_000_000) / value.duration)
  return {
    samples: first.length,
    generationSamples: valid.length,
    providerTimedSamples: valid.filter((value) => value.provider).length,
    observedSamples: valid.filter((value) => !value.provider).length,
    ...(rates.length === 0
      ? {}
      : { generationP50TokensPerSecond: rank(rates, 50), generationP90TokensPerSecond: rank(rates, 90) }),
    ...(first.length === 0 ? {} : { firstOutputP50Ms: rank(first, 50), firstOutputP95Ms: rank(first, 95) }),
    ...(total.length === 0 ? {} : { totalP50Ms: rank(total, 50), totalP95Ms: rank(total, 95) }),
    ...(valid.length === 0
      ? {}
      : {
          outputTokensPerSecond: expect.closeTo(
            valid.reduce((sum, value) => sum + value.tokens, 0) /
              (valid.reduce((sum, value) => sum + value.duration, 0) / 1_000_000_000),
            9,
          ),
        }),
  }
}

const zoned = (timeZone: string, time: number) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(time)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? ""
  const date = `${part("year")}-${part("month")}-${part("day")}`
  return { day: date, hour: `${date}T${part("hour")}:00:00${part("timeZoneName").replace("GMT", "") || "+00:00"}` }
}

const tally = (specs: ReadonlyArray<Spec>, key: (spec: Spec) => string) => {
  const groups = new Map<string, { logical: number; input: number; cost: number; priced: number }>()
  for (const spec of specs) {
    const group = groups.get(key(spec)) ?? { logical: 0, input: 0, cost: 0, priced: 0 }
    group.logical += 1
    group.input += spec.input
    if (spec.cost !== undefined) {
      group.cost += spec.cost
      group.priced += 1
    }
    groups.set(key(spec), group)
  }
  return new Map([...groups].map(([name, group]) => [name, group]))
}

const reportTally = (rows: ReadonlyArray<ProviderRequest.ReportRow>) =>
  new Map(
    rows.map((row) => [
      row.key,
      {
        logical: row.logical,
        input: row.tokens.input,
        cost: row.cost ?? 0,
        priced: row.costCoverage?.pricedRequests ?? 0,
      },
    ]),
  )

const expectTally = (
  actual: Map<string, { logical: number; input: number; cost: number; priced: number }>,
  expected: Map<string, { logical: number; input: number; cost: number; priced: number }>,
) => {
  expect([...actual.keys()].toSorted()).toEqual([...expected.keys()].toSorted())
  for (const [key, value] of expected) {
    const got = actual.get(key)!
    expect({ key, logical: got.logical, input: got.input, priced: got.priced }).toEqual({
      key,
      logical: value.logical,
      input: value.input,
      priced: value.priced,
    })
    expect(got.cost).toBeCloseTo(value.cost, 9)
  }
}

const base = Math.floor((Date.now() - 2 * day) / day) * day + 10 * hour
const newYork = Date.UTC(2026, 2, 8, 6, 59, 59, 999)
const monrovia = Date.UTC(1971, 5, 1, 0, 44, 30)

const windowSessions: ReadonlyArray<SessionSpec> = [
  { id: "ses_stage_a", directory: "/stage-a" },
  { id: "ses_stage_b", directory: "/stage-b" },
  { id: "ses_stage_c", directory: "/stage-a", workspaceID: "wrk_stage" },
]

const timing = (total: number, first: number, tokens: number, durationNs: number, observed = false): Timing => ({
  totalMs: total,
  firstOutputMs: first,
  generatedTokens: tokens,
  ...(observed ? { observedGenerationDurationNs: durationNs } : { generationDurationNs: durationNs }),
})

const windowSpecs: ReadonlyArray<Spec> = [
  { id: "prq_w01", session: "ses_stage_a", request: 1, time: base + 1, provider: "openai", model: "gpt", cost: 0.1, input: 10, timing: timing(100, 10, 100, 1e9) },
  { id: "prq_w02", session: "ses_stage_a", request: 2, time: base + 59_999, provider: "openai", model: "gpt", variant: "high", cost: 0.2, input: 20, timing: timing(250, 30, 200, 4e9) },
  { id: "prq_w03", session: "ses_stage_b", request: 1, time: base + minute, provider: "anthropic", model: "claude", profile: "work", cost: 0.3, input: 30, timing: timing(300, 5, 50, 2e9, true) },
  { id: "prq_w04", session: "ses_stage_a", request: 3, time: base + minute, provider: "openai", model: "gpt", cost: 0.4, input: 40, timing: timing(120, 12, 90, 3e9) },
  { id: "prq_w05", session: "ses_stage_b", request: 2, time: base + 15 * minute - 1, provider: "anthropic", model: "claude", agent: "plan", cost: 0.5, input: 50, timing: timing(700, 70, 10, 5e8, true) },
  { id: "prq_w06", session: "ses_stage_c", request: 1, time: base + 15 * minute, provider: "openai", model: "gpt", cost: 0.6, input: 60, timing: timing(90, 9, 300, 1e9) },
  { id: "prq_w07", session: "ses_stage_a", request: 4, time: base + 15 * minute + 1, provider: "openai", model: "gpt", source: "decision", input: 70 },
  { id: "prq_w08", session: "ses_stage_b", request: 3, time: base + 30 * minute + 30_123, provider: "anthropic", model: "claude", cost: 0.8, input: 80, timing: timing(410, 41, 120, 6e9) },
  { id: "prq_w09", session: "ses_stage_a", request: 5, time: base + 2 * hour + 7, provider: "openai", model: "gpt", cost: 0.9, input: 90, timing: timing(510, 51, 100, 2e9) },
  { id: "prq_w10", session: "ses_stage_a", request: 6, time: base + 2 * hour + 7, provider: "openai", model: "gpt", cost: 1.0, input: 100, timing: timing(520, 52, 100, 5e9) },
  { id: "prq_w11", session: "ses_stage_b", request: 4, time: base + 4 * hour - 1, provider: "google", model: "gemini", input: 110 },
  { id: "prq_w12", session: "ses_stage_b", request: 5, time: newYork, provider: "openai", model: "gpt", cost: 1.2, input: 120 },
  { id: "prq_w13", session: "ses_stage_b", request: 6, time: newYork + 1, provider: "openai", model: "gpt", cost: 1.3, input: 130 },
  { id: "prq_w14", session: "ses_stage_b", request: 7, time: newYork + 30 * minute + 1, provider: "openai", model: "gpt", cost: 1.4, input: 140 },
  { id: "prq_w15", session: "ses_stage_a", request: 7, time: monrovia - 1, provider: "openai", model: "gpt", cost: 1.5, input: 150 },
  { id: "prq_w16", session: "ses_stage_a", request: 8, time: monrovia, provider: "openai", model: "gpt", cost: 1.6, input: 160 },
  { id: "prq_w17", session: "ses_stage_a", request: 9, time: monrovia + hour - 1, provider: "openai", model: "gpt", cost: 1.7, input: 170 },
  { id: "prq_w18", session: "ses_stage_a", request: 10, time: monrovia + hour, provider: "openai", model: "gpt", cost: 1.8, input: 180 },
]

const providerKey = (spec: Spec) => JSON.stringify(["provider", spec.provider])
const sessionKey = (spec: Spec) => spec.session
const profileModelKey = (spec: Spec) =>
  JSON.stringify(["provider-profile-model", spec.provider, spec.profile ?? null, spec.model])

test("arbitrary millisecond windows, zones and forecast bins are served exactly from prepared cells", () => {
  const fixture = harness()
  return Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      yield* seedSessions(windowSessions)
      for (const spec of windowSpecs) yield* record(spec)
      const raw: string[] = []
      const ranges: ReadonlyArray<{ from?: number; to?: number }> = [
        { from: base + 1, to: base + 2 },
        { from: base, to: base + minute },
        { from: base + 59_999, to: base + minute + 1 },
        { from: base + 30_000, to: base + 15 * minute + 1 },
        { from: base + minute, to: base + 30 * minute + 30_124 },
        { to: base + 15 * minute },
        { from: base + 15 * minute },
        { from: base + 2 * hour + 7, to: base + 2 * hour + 8 },
        { from: base + 123, to: base + 4 * hour },
        { from: newYork - day, to: newYork + day },
      ]
      for (const range of ranges) {
        const selected = windowSpecs.filter((spec) => inRange(spec, range))
        for (const [group, key] of [
          ["provider", providerKey],
          ["session", sessionKey],
          ["provider-profile-model", profileModelKey],
        ] as const) {
          const report = yield* fixture.reads(sessions.usageReportAll({ group, ...range }))
          raw.push(...report.raw)
          expect(report.result.rowCount).toBe(new Set(selected.map(key)).size)
          expectTally(reportTally(report.result.rows), tally(selected, key))
          expect(report.result.total.logical).toBe(selected.length)
          expect(report.result.total.tokens.input).toBe(selected.reduce((sum, spec) => sum + spec.input, 0))
          expect(report.result.total.costCoverage).toEqual({
            pricedRequests: selected.filter((spec) => spec.cost !== undefined).length,
            unpricedRequests: selected.filter((spec) => spec.cost === undefined).length,
          })
          if (group === "provider")
            for (const row of report.result.rows) {
              const oracle = speedOracle(selected.filter((spec) => providerKey(spec) === row.key))
              if (oracle === undefined) expect(row.speed).toBeUndefined()
              else expect(row.speed).toEqual(oracle)
            }
        }
      }

      const effort = yield* fixture.reads(
        sessions.usageReportAll({ group: "model", selectedEffort: "high" as never, from: base, to: base + hour }),
      )
      raw.push(...effort.raw)
      expect(effort.result.total.logical).toBe(1)
      expect(effort.result.total.tokens.input).toBe(20)
      const profile = yield* fixture.reads(
        sessions.usageReportAll({ group: "agent", profile: "work" as never, from: base + 1, to: base + 30 * minute }),
      )
      raw.push(...profile.raw)
      expect(profile.result.rows.map((row) => [row.key, row.logical])).toEqual([["build", 1]])

      for (const [timeZone, group, range] of [
        ["America/New_York", "day", { from: newYork - day, to: newYork + day }],
        ["America/New_York", "hour", { from: newYork - hour, to: newYork + hour }],
        ["Asia/Kathmandu", "hour", { from: base, to: base + 5 * hour }],
        ["Africa/Monrovia", "hour", { from: monrovia - day, to: monrovia + day }],
        ["Africa/Monrovia", "day", { from: monrovia - day, to: monrovia + day }],
      ] as const) {
        const selected = windowSpecs.filter((spec) => inRange(spec, range))
        const key = (spec: Spec) => zoned(timeZone, spec.time)[group]
        const report = yield* fixture.reads(sessions.usageReportAll({ group, timeZone, ...range, limit: 500 }))
        raw.push(...report.raw)
        expectTally(reportTally(report.result.rows), tally(selected, key))
        const scoped = yield* fixture.reads(
          sessions.usageReport({ sessionID: SessionSchema.ID.make("ses_stage_a"), group, timeZone, ...range, limit: 500 }),
        )
        raw.push(...scoped.raw)
        expectTally(
          reportTally(scoped.result.rows),
          tally(
            selected.filter((spec) => spec.session === "ses_stage_a"),
            key,
          ),
        )
      }
      expect(new Set(windowSpecs.filter((spec) => spec.time >= monrovia - day).map((spec) => zoned("Africa/Monrovia", spec.time).day)).size).toBeGreaterThan(1)

      const summary = yield* fixture.reads(sessions.usageAll())
      raw.push(...summary.raw)
      expect(summary.result.logical).toBe(windowSpecs.length)
      expect(summary.result.cost).toBeCloseTo(
        windowSpecs.reduce((sum, spec) => sum + (spec.cost ?? 0), 0),
        9,
      )
      expect(summary.result.latestNamespace).toBe("ns-prq_w")
      expect(summary.result.latestTiming).toBeUndefined()

      for (const [dayStart, dayEnd] of [
        [base + 1, base + 15 * minute + 2],
        [base - 37, base + 4 * hour - 1],
        [newYork - 12 * hour, newYork + 12 * hour],
      ] as const) {
        const selected = windowSpecs.filter((spec) => inRange(spec, { from: dayStart, to: dayEnd }))
        const spend = yield* fixture.reads(SessionUsageRead.localSpend(database, { dayStart, dayEnd }))
        raw.push(...spend.raw)
        const providers = [...new Set(selected.map((spec) => spec.provider))].toSorted()
        expect(spend.result).toEqual(
          providers.map((providerID) => {
            const rows = selected.filter((spec) => spec.provider === providerID)
            const priced = rows.filter((spec) => spec.cost !== undefined)
            return {
              providerID: Provider.ID.make(providerID),
              ...(priced.length === 0
                ? {}
                : { knownUSD: expect.closeTo(priced.reduce((sum, spec) => sum + spec.cost!, 0), 9) }),
              pricedRequests: priced.length,
              unpricedRequests: rows.length - priced.length,
            }
          }),
        )
      }

      const asOf = base + 61 * minute + 4_321
      for (const scope of [
        { type: "backend" as const },
        { type: "location" as const, location: Location.Ref.make({ directory: AbsolutePath.make("/stage-a"), workspaceID: undefined }) },
      ]) {
        const from = asOf - hour
        const usage = yield* fixture.reads(SessionUsageRead.localUsage(database, { from, to: asOf, scope }))
        raw.push(...usage.raw)
        const selected = windowSpecs.filter(
          (spec) =>
            inRange(spec, { from, to: asOf }) &&
            (scope.type === "backend" || windowSessions.find((session) => session.id === spec.session)!.directory === "/stage-a" && windowSessions.find((session) => session.id === spec.session)!.workspaceID === undefined),
        )
        const groups = [...new Set(selected.map((spec) => JSON.stringify([spec.provider, spec.profile ?? null, spec.model])))].toSorted()
        expect(usage.result).toEqual(
          groups.flatMap((group) => {
            const [providerID, profile, modelID] = JSON.parse(group) as [string, string | null, string]
            return Array.from({ length: 12 }, (_, index) => {
              const start = from + index * 5 * minute
              const rows = selected.filter(
                (spec) =>
                  spec.provider === providerID &&
                  (spec.profile ?? null) === profile &&
                  spec.model === modelID &&
                  spec.time >= start &&
                  spec.time < start + 5 * minute,
              )
              const priced = rows.filter((spec) => spec.cost !== undefined)
              return {
                providerID: Provider.ID.make(providerID),
                ...(profile === null ? {} : { profile }),
                modelID: Model.ID.make(modelID),
                start,
                requests: rows.length,
                tokens: {
                  input: rows.reduce((sum, spec) => sum + spec.input, 0),
                  output: 0,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                },
                ...(priced.length === 0
                  ? {}
                  : { knownUSD: expect.closeTo(priced.reduce((sum, spec) => sum + spec.cost!, 0), 9) }),
                pricedRequests: priced.length,
                unpricedRequests: rows.length - priced.length,
              }
            })
          }),
        )
      }
      expect(raw).toEqual([])
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 60_000)

const tiered: ReadonlyArray<Model.Cost> = [
  {
    input: Money.USDPerMillionTokens.make(1),
    output: Money.USDPerMillionTokens.make(2),
    cache: { read: Money.USDPerMillionTokens.make(0.5), write: Money.USDPerMillionTokens.make(4) },
  },
  {
    tier: { type: "context", size: 1_000 },
    input: Money.USDPerMillionTokens.make(3),
    output: Money.USDPerMillionTokens.make(6),
    cache: { read: Money.USDPerMillionTokens.make(1.5), write: Money.USDPerMillionTokens.make(8) },
  },
]

const pricingSpecs: ReadonlyArray<Spec> = [
  { id: "prq_p1", session: "ses_price_a", request: 1, time: base + 10, provider: "openai", model: "tiered", input: 600, output: 10 },
  { id: "prq_p2", session: "ses_price_a", request: 2, time: base + 20, provider: "openai", model: "tiered", input: 900, read: 200 },
  { id: "prq_p3", session: "ses_price_a", request: 3, time: base + 30, provider: "openai", model: "tiered", input: 1_000 },
  { id: "prq_p4", session: "ses_price_a", request: 4, time: base + 40, provider: "openai", model: "tiered", input: 1_500, source: "decision" },
  { id: "prq_p5", session: "ses_price_a", request: 5, time: base + 50, provider: "openai", model: "tiered", input: 50, cost: 0.25 },
  { id: "prq_p6", session: "ses_price_router", request: 1, time: base + 60, provider: "anthropic", model: "claude", input: 2_000 },
  { id: "prq_p7", session: "ses_price_missing", request: 1, time: base + 70, provider: "openai", model: "tiered", input: 100 },
]

test("per-request catalog tiers, router fallback, revaluation and provenance come from prepared unpriced contexts", () => {
  const fixture = harness()
  fixture.prices.set("/price-a|openai|tiered", tiered)
  fixture.prices.set("/price-router|openrouter|anthropic/claude", [
    {
      input: Money.USDPerMillionTokens.make(5),
      output: Money.USDPerMillionTokens.make(0),
      cache: { read: Money.USDPerMillionTokens.make(0), write: Money.USDPerMillionTokens.make(0) },
    },
  ])
  fixture.unavailable.add("/price-missing")
  return Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const events = yield* EventRuntime.Service
      yield* seedSessions([
        { id: "ses_price_a", directory: "/price-a" },
        { id: "ses_price_router", directory: "/price-router" },
        { id: "ses_price_missing", directory: "/price-missing" },
      ])
      for (const spec of pricingSpecs) yield* record(spec)
      const raw: string[] = []
      const catalog = (600 * 1 + 10 * 2 + 900 * 3 + 200 * 1.5 + 1_000 * 1) / 1_000_000
      const router = (2_000 * 5) / 1_000_000

      const summary = yield* fixture.reads(sessions.usageAll())
      raw.push(...summary.raw)
      expect(summary.result.cost).toBeCloseTo(catalog + 0.25 + router, 12)
      const tieredModel = summary.result.models!.find((item) => item.model.id === "tiered")!
      expect(tieredModel.cost).toBeCloseTo(catalog + 0.25, 12)
      expect(tieredModel.costProvenance).toBe("current_catalog")

      const report = yield* fixture.reads(sessions.usageReportAll({ group: "session" }))
      raw.push(...report.raw)
      const rows = new Map(report.result.rows.map((row) => [row.key, row]))
      expect(rows.get("ses_price_a")!.cost).toBeCloseTo(catalog + 0.25, 12)
      expect(rows.get("ses_price_a")!.costCoverage).toEqual({ pricedRequests: 4, unpricedRequests: 1 })
      expect(rows.get("ses_price_a")!.costProvenance).toBe("current_catalog")
      expect(rows.get("ses_price_router")!.cost).toBeCloseTo(router, 12)
      expect(rows.get("ses_price_missing")!.cost).toBeUndefined()
      expect(rows.get("ses_price_missing")!.costCoverage).toEqual({ pricedRequests: 0, unpricedRequests: 1 })
      expect(report.result.total.costCoverage).toEqual({ pricedRequests: 5, unpricedRequests: 2 })

      const recordedOnly = yield* fixture.reads(
        sessions.usageReportAll({ group: "session", from: base + 50, to: base + 51 }),
      )
      raw.push(...recordedOnly.raw)
      expect(recordedOnly.result.rows[0]!.costProvenance).toBe("recorded")
      expect(recordedOnly.result.rows[0]!.cost).toBeCloseTo(0.25, 12)

      const scoped = yield* fixture.reads(sessions.usage(SessionSchema.ID.make("ses_price_a")))
      raw.push(...scoped.raw)
      expect(scoped.result.cost).toBeCloseTo(catalog + 0.25, 12)

      fixture.prices.set("/price-a|openai|tiered", [
        { ...tiered[0]!, input: Money.USDPerMillionTokens.make(2) },
        tiered[1]!,
      ])
      yield* events.publish(
        Catalog.Event.Updated,
        {},
        { location: Location.Ref.make({ directory: AbsolutePath.make("/price-a"), workspaceID: undefined }) },
      )
      const revalued = yield* fixture.reads(sessions.usageReportAll({ group: "session" }))
      raw.push(...revalued.raw)
      expect(revalued.result.rows.find((row) => row.key === "ses_price_a")!.cost).toBeCloseTo(
        (600 * 2 + 10 * 2 + 900 * 3 + 200 * 1.5 + 1_000 * 2) / 1_000_000 + 0.25,
        12,
      )
      fixture.unavailable.add("/price-a")
      const unavailable = yield* fixture.reads(sessions.usageAll())
      raw.push(...unavailable.raw)
      expect(unavailable.result.cost).toBeCloseTo(0.25 + router, 12)
      expect(raw).toEqual([])
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 60_000)

test("retention, idle pruning, deletion and rollback keep prepared results equal to retained source", () => {
  const fixture = harness()
  return Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const analytics = yield* UsageAnalytics.Service
      const cleanup = yield* SessionUsageCleanup.Service
      const events = yield* EventRuntime.Service
      yield* seedSessions([
        { id: "ses_old", directory: "/retain" },
        { id: "ses_idle", directory: "/retain" },
        { id: "ses_gone", directory: "/retain" },
      ])
      const cutoff = base + 7 * minute + 123
      const specs: Spec[] = [
        ...Array.from({ length: 1_100 }, (_, index): Spec => ({
          id: `prq_old_${index.toString().padStart(5, "0")}`,
          session: "ses_old",
          request: index + 1,
          time: cutoff - 10 * minute - 5,
          provider: "openai",
          model: "m1",
          cost: 0.001,
          input: 1,
          timing: timing(1_000 + index, 1, 10, 1e9),
        })),
        { id: "prq_edge_1", session: "ses_old", request: 1_101, time: cutoff - 1, provider: "openai", model: "m2", cost: 0.5, input: 5, timing: timing(10, 1, 10, 1e9) },
        { id: "prq_edge_2", session: "ses_old", request: 1_102, time: cutoff, provider: "openai", model: "m2", cost: 0.25, input: 7, timing: timing(30, 3, 10, 2e9) },
        { id: "prq_edge_3", session: "ses_old", request: 1_103, time: cutoff, provider: "openai", model: "m1", cost: 0.125, input: 11, timing: timing(20, 2, 10, 4e9) },
        { id: "prq_edge_4", session: "ses_old", request: 1_104, time: cutoff + 59_000, provider: "openai", model: "m1", input: 13, timing: timing(40, 4, 10, 1e9) },
        ...Array.from({ length: 250 }, (_, index): Spec => ({
          id: `prq_idle_${index.toString().padStart(4, "0")}`,
          session: "ses_idle",
          request: index + 1,
          time: cutoff + index * 1_000,
          provider: "anthropic",
          model: "idle",
          cost: 0.01,
          input: 2,
        })),
        { id: "prq_gone_1", session: "ses_gone", request: 1, time: cutoff + 5, provider: "google", model: "gone", cost: 0.3, input: 3 },
        { id: "prq_gone_2", session: "ses_gone", request: 2, time: cutoff + 6, provider: "google", model: "gone", cost: 0.3, input: 3 },
      ]
      for (const spec of specs) yield* record(spec)
      const raw: string[] = []
      const modelKey = (spec: Spec) => JSON.stringify(["provider-model", spec.provider, spec.model])

      yield* database.db.run(sql`UPDATE session SET time_updated = 0 WHERE id = 'ses_idle'`)
      yield* cleanup.cleanup()
      const idle = yield* fixture.reads(sessions.usage(SessionSchema.ID.make("ses_idle")))
      raw.push(...idle.raw)
      expect(idle.result.logical).toBe(0)
      expect(idle.result.latestNamespace).toBeUndefined()

      yield* database.db.run(sql`DELETE FROM session WHERE id = 'ses_gone'`)
      yield* seedSessions([{ id: "ses_gone", directory: "/retain" }])
      const gone = yield* fixture.reads(sessions.usage(SessionSchema.ID.make("ses_gone")))
      raw.push(...gone.raw)
      expect(gone.result.logical).toBe(0)

      const backendBefore = yield* fixture.reads(sessions.usageReportAll({ group: "provider-model" }))
      raw.push(...backendBefore.raw)
      expectTally(reportTally(backendBefore.result.rows), tally(specs, modelKey))

      fixture.retention.usageDays = 30
      expect(yield* analytics.cleanup(cutoff + 30 * day)).toBe(1_101)
      const retained = specs.filter((spec) => spec.time >= cutoff)
      for (const range of [{}, { from: cutoff - hour, to: cutoff + minute }, { from: cutoff, to: cutoff + 1 }]) {
        const selected = retained.filter((spec) => inRange(spec, range))
        const report = yield* fixture.reads(sessions.usageReportAll({ group: "provider-model", ...range }))
        raw.push(...report.raw)
        expectTally(reportTally(report.result.rows), tally(selected, modelKey))
        for (const row of report.result.rows) {
          const oracle = speedOracle(selected.filter((spec) => modelKey(spec) === row.key))
          if (oracle === undefined) expect(row.speed).toBeUndefined()
          else expect(row.speed).toEqual(oracle)
        }
      }
      const spend = yield* fixture.reads(
        SessionUsageRead.localSpend(database, { dayStart: cutoff - day, dayEnd: cutoff + day }),
      )
      raw.push(...spend.raw)
      expect(spend.result.find((item) => item.providerID === "openai")).toEqual({
        providerID: Provider.ID.make("openai"),
        knownUSD: expect.closeTo(0.375, 12),
        pricedRequests: 2,
        unpricedRequests: 1,
      })

      const old = yield* fixture.reads(sessions.usageReport({ sessionID: SessionSchema.ID.make("ses_old"), group: "provider-model" }))
      raw.push(...old.raw)
      expectTally(
        reportTally(old.result.rows),
        tally(
          specs.filter((spec) => spec.session === "ses_old"),
          modelKey,
        ),
      )
      const latest = yield* fixture.reads(sessions.usage(SessionSchema.ID.make("ses_old")))
      raw.push(...latest.raw)
      expect(latest.result.latestTiming).toEqual(timing(40, 4, 10, 1e9))

      const before = yield* sessions.usageAll()
      const failed = yield* database.db
        .transaction(() =>
          events
            .publish(
              SessionEvent.ProviderRequestRecorded,
              recorded({ id: "prq_rollback", session: "ses_old", request: 2_000, time: cutoff + 2 * minute, provider: "openai", model: "m1", cost: 9, input: 99 }),
            )
            .pipe(Effect.andThen(Effect.fail("rollback"))),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      const sourceCount = (table: string, where = sql`1`) =>
        database.db
          .get<{ count: number }>(sql`SELECT count(*) AS count FROM ${sql.raw(table)} WHERE ${where}`)
          .pipe(Effect.map((row) => row!.count))
      const after = yield* fixture.reads(sessions.usageAll())
      raw.push(...after.raw)
      expect(after.result.logical).toBe(yield* sourceCount("usage_analytics_request"))
      expect(after.result.logical).toBe(before.logical)
      const oldAfter = yield* sessions.usage(SessionSchema.ID.make("ses_old"))
      expect(oldAfter.logical).toBe(yield* sourceCount("session_provider_request", sql`session_id = 'ses_old'`))
      expect(raw).toEqual([])
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 120_000)

test("prompt and task costs aggregate prepared Session cells with per-context catalog prices", () => {
  const fixture = harness()
  fixture.prices.set("/prompt|openai|tiered", tiered)
  return Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* seedSessions([
        { id: "ses_root", directory: "/prompt" },
        { id: "ses_task", directory: "/prompt", parentID: "ses_root" },
      ])
      yield* db.run(sql`INSERT INTO session_task
        (session_id, parent_id, parent_assistant_message_id, tool_call_id, input_id, description, agent, model, prompt_digest,
          background, delivery, state, usage_anchor, time_created, time_updated)
        VALUES ('ses_task', 'ses_root', 'msg_parent', 'call', 'msg_child', 'Child', 'build', '{"providerID":"openai","id":"tiered"}',
          'digest', 1, 'steer', 'completed', '{"sessionID":"ses_root","inputID":"msg_first"}', ${base}, ${base})`)
      const anchor = { sessionID: "ses_root", inputID: "msg_first" }
      const specs: ReadonlyArray<Spec> = [
        { id: "prq_a1", session: "ses_root", request: 1, time: base + 1, provider: "openai", model: "tiered", anchor, cost: 1, input: 10 },
        { id: "prq_a2", session: "ses_root", request: 2, time: base + 2, provider: "openai", model: "tiered", anchor, input: 600 },
        { id: "prq_a3", session: "ses_root", request: 3, time: base + 3, provider: "openai", model: "tiered", anchor, source: "title", input: 1_200 },
        { id: "prq_a4", session: "ses_root", request: 4, time: base + 4, provider: "openai", model: "tiered", anchor, source: "decision", input: 5 },
        { id: "prq_a5", session: "ses_root", request: 5, time: base + 5, provider: "openai", model: "tiered", cost: 0.5, input: 1 },
        { id: "prq_t1", session: "ses_task", request: 1, time: base + 6, provider: "openai", model: "tiered", anchor, cost: 2, input: 20 },
        { id: "prq_t2", session: "ses_task", request: 2, time: base + 7, provider: "openai", model: "tiered", anchor, input: 1_100 },
      ]
      for (const spec of specs) yield* record(spec)
      const price = (input: number) => (input * (input > 1_000 ? 3 : 1)) / 1_000_000
      const raw: string[] = []
      const prompt = yield* fixture.reads(
        sessions.promptCosts({ sessionID: SessionSchema.ID.make("ses_root"), inputIDs: [SessionMessage.ID.make("msg_first")] }),
      )
      raw.push(...prompt.raw)
      const unit = prompt.result.units[0]!
      expect(unit.total.requests).toBe(6)
      expect(unit.total.tokens.input).toBe(10 + 600 + 1_200 + 5 + 20 + 1_100)
      expect(unit.total.cost.known).toBeCloseTo(1 + price(600) + price(1_200) + 2 + price(1_100), 12)
      expect(unit.total.cost).toMatchObject({ pricedRequests: 5, unpricedRequests: 1, provenance: "current_catalog" })
      expect(unit.main.requests).toBe(4)
      expect(unit.main.cost.known).toBeCloseTo(1 + price(600) + price(1_200), 12)
      expect(unit.children.requests).toBe(2)
      expect(unit.children.cost.known).toBeCloseTo(2 + price(1_100), 12)
      expect(unit.helpers.map((helper) => [helper.source, helper.requests, helper.cost.pricedRequests])).toEqual([
        ["decision", 1, 0],
        ["title", 1, 1],
      ])
      expect(prompt.result.unattributed).toMatchObject({ requests: 1, cost: { known: 0.5, pricedRequests: 1, provenance: "recorded" } })

      const task = yield* fixture.reads(
        sessions.taskCosts({ sessionID: SessionSchema.ID.make("ses_root"), sessionIDs: [SessionSchema.ID.make("ses_task")] }),
      )
      raw.push(...task.raw)
      expect(task.result.tasks[0]!.total.requests).toBe(2)
      expect(task.result.tasks[0]!.total.cost.known).toBeCloseTo(2 + price(1_100), 12)
      expect(task.result.tasks[0]!.total.cost).toMatchObject({ pricedRequests: 2, unpricedRequests: 0, provenance: "current_catalog" })
      expect(task.result.total.requests).toBe(2)

      const promptReport = yield* fixture.reads(
        sessions.usageReport({ sessionID: SessionSchema.ID.make("ses_root"), group: "prompt" }),
      )
      raw.push(...promptReport.raw)
      const attributed = promptReport.result.rows.find((row) => row.key === JSON.stringify(["prompt", "ses_root", "msg_first"]))!
      expect(attributed.logical).toBe(6)
      expect(attributed.cost).toBeCloseTo(1 + price(600) + price(1_200) + 2 + price(1_100), 12)
      const taskReport = yield* fixture.reads(
        sessions.usageReport({ sessionID: SessionSchema.ID.make("ses_root"), group: "task" }),
      )
      raw.push(...taskReport.raw)
      expect(taskReport.result.rows.find((row) => row.key === JSON.stringify(["task", "ses_task"]))!.logical).toBe(2)
      expect(raw).toEqual([])
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 60_000)

const seededRow = (index: number) => ({
  id: ProviderRequest.ID.make(`prq_seed_${index.toString().padStart(6, "0")}`),
  session_id: SessionSchema.ID.make(index % 3 === 0 ? "ses_seed_b" : "ses_seed_a"),
  source: "step" as const,
  agent: Agent.ID.make("build"),
  model: Model.Ref.make({ providerID: Provider.ID.make("openai"), id: Model.ID.make(`m${index % 4}`) }),
  route_id: "route",
  prompt_cache_key: "seeded-namespace",
  system_digest: "system",
  tool_digest: "tools",
  request: index + 1,
  attempts: 1,
  invalidation: "first-request" as const,
  continuation: "full" as const,
  cost: index % 5 === 0 ? null : 0.01,
  tokens: { input: 1 + (index % 7), output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  timing: { totalMs: index % 97, firstOutputMs: index % 13 },
  time_created: base + index * 7_919,
})

test("explicit backfill and the migration rebuild raw-seeded history idempotently and reopened databases stay prepared", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-stage-"))
  directories.push(directory)
  const path = join(directory, "usage.db")
  const { UsageStage } = await import("../src/usage-stage")
  const { migrations } = await import("../src/database/migration.gen")
  const migration = migrations.find((item) => item.id.endsWith("_prepared-usage"))!
  const rows = Array.from({ length: 12_345 }, (_, index) => seededRow(index))
  const expected = (selected: ReadonlyArray<ReturnType<typeof seededRow>>) => ({
    logical: selected.length,
    input: selected.reduce((sum, row) => sum + row.tokens.input, 0),
    priced: selected.filter((row) => row.cost !== null).length,
    cost: selected.reduce((sum, row) => sum + (row.cost ?? 0), 0),
  })
  const first = harness({ path })
  await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* seedSessions([
        { id: "ses_seed_a", directory: "/seed" },
        { id: "ses_seed_b", directory: "/seed" },
      ])
      for (let start = 0; start < rows.length; start += 500)
        yield* db.insert(SessionProviderRequestTable).values(rows.slice(start, start + 500)).run()
      yield* db.transaction(() => UsageAnalytics.backfill(db))
      yield* UsageStage.backfill(db)
      yield* UsageStage.backfill(db)
      const total = yield* sessions.usageReportAll({ group: "model" })
      expect(total.total).toMatchObject({
        logical: expected(rows).logical,
        tokens: { input: expected(rows).input },
        costCoverage: { pricedRequests: expected(rows).priced, unpricedRequests: rows.length - expected(rows).priced },
      })
      expect(total.total.cost).toBeCloseTo(expected(rows).cost, 9)
      const range = { from: base + 1_234_567, to: base + 54_321_987 }
      const ranged = rows.filter((row) => row.time_created >= range.from && row.time_created < range.to)
      expect((yield* sessions.usageReportAll({ group: "hour", ...range })).total.logical).toBe(ranged.length)
      const scoped = yield* sessions.usage(SessionSchema.ID.make("ses_seed_b"))
      expect(scoped.logical).toBe(expected(rows.filter((row) => row.session_id === "ses_seed_b")).logical)

      for (const table of ["usage_view_presentation", "usage_view_ref", "usage_view_rank", "usage_view_sample", "usage_view_row", "usage_view_state", "usage_view_change", "usage_view_journal"])
        yield* db.run(sql.raw(`DROP TABLE ${table}`))
      yield* db.run(sql`DROP TABLE usage_analytics_cell_leaf`)
      yield* db.run(sql`DROP TABLE session_usage_cell_leaf`)
      yield* db.run(sql`DROP TABLE usage_analytics_cell_sample`)
      yield* db.run(sql`DROP TABLE usage_analytics_cell_unpriced`)
      yield* db.run(sql`DROP TABLE usage_analytics_cell`)
      yield* db.run(sql`DROP TABLE session_usage_cell_sample`)
      yield* db.run(sql`DROP TABLE session_usage_cell_unpriced`)
      yield* db.run(sql`DROP TABLE session_usage_cell`)
      yield* db.transaction((tx) => migration.up(tx))
      const migrated = yield* sessions.usageReportAll({ group: "model" })
      expect(migrated.total.logical).toBe(rows.length)
      expect(migrated.total.cost).toBeCloseTo(expected(rows).cost, 9)
    }).pipe(Effect.provide(first.runtime), Effect.scoped),
  )
  const reopened = harness({ path })
  await Effect.runPromise(
    Effect.gen(function* () {
      expect(reopened.queries.filter((query) => /\b(?:insert into|delete from)\s+(?:usage_analytics|session_usage)_cell/i.test(query))).toEqual([])
      const sessions = yield* Session.Service
      const summary = yield* reopened.reads(sessions.usageAll())
      expect(summary.result.logical).toBe(rows.length)
      expect(summary.result.latestNamespace).toBe("seeded-n")
      const report = yield* reopened.reads(sessions.usageReportAll({ group: "day", timeZone: "Asia/Kathmandu" }))
      expect(report.result.total.logical).toBe(rows.length)
      expect([...summary.raw, ...report.raw]).toEqual([])
    }).pipe(Effect.provide(reopened.runtime), Effect.scoped),
  )
}, 120_000)

test("same-millisecond partial retention batches repair first and latest representatives through bounded indexed reads", async () => {
  const { UsageStage } = await import("../src/usage-stage")
  const fixture = harness()
  const at = base + 5 * minute + 17
  const first = '{"providerID":"p","id":"m"}'
  const second = '{"id":"m","providerID":"p"}'
  const total = 2_500
  const id = (request: number) =>
    `prq_tie_${(request === 1 ? 0 : request === total ? 1 : request + 1).toString().padStart(5, "0")}`
  const removed = (request: number) => request === 1 || request === total || request <= 998
  const remaining = Array.from({ length: total }, (_, index) => index + 1).filter((request) => !removed(request))
  await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* seedSessions([{ id: "ses_tie", directory: "/tie" }])
      yield* db.run(sql`
        WITH RECURSIVE n(request) AS (SELECT 1 UNION ALL SELECT request + 1 FROM n WHERE request < ${total})
        INSERT INTO session_provider_request
          (id, session_id, source, agent, model, route_id, prompt_cache_key, system_digest, tool_digest, request, attempts,
            invalidation, continuation, tokens, timing, cost, time_created)
        SELECT printf('prq_tie_%05d', CASE WHEN request = 1 THEN 0 WHEN request = ${total} THEN 1 ELSE request + 1 END),
          'ses_tie', 'step', 'build', CASE WHEN request IN (1, 1500) THEN ${first} ELSE ${second} END, 'route',
          'tie-namespace', 'system', 'tools', request, 1, 'first-request', 'full',
          '{"input":1,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}',
          json_object('totalMs', request, 'firstOutputMs', request % 97), 0.001, ${at}
        FROM n
      `)
      expect(id(1)).toBe("prq_tie_00000")
      yield* UsageAnalytics.backfill(db)
      yield* UsageStage.backfill(db)
      const rowids = yield* db.all<{ rowid: number }>(
        sql`SELECT rowid FROM session_provider_request WHERE session_id = 'ses_tie' AND (request <= 998 OR request = ${total}) ORDER BY request`,
      )
      expect(rowids).toHaveLength(999)
      const backend = sql`r.time_created < ${at + 1} AND (r.time_created, r.id) <= (${at}, ${"prq_tie_00999"})`
      const session = sql`r.session_id = ${"ses_tie"} AND r.rowid IN (${sql.join(
        rowids.map((row) => sql`${row.rowid}`),
        sql`, `,
      )})`
      fixture.logged.length = 0
      yield* db.transaction(() =>
        Effect.gen(function* () {
          yield* UsageStage.remove(db, "backend", backend)
          yield* db.run(sql`DELETE FROM usage_analytics_request AS r WHERE ${backend}`)
          yield* UsageStage.remove(db, "session", session)
          yield* db.run(sql`DELETE FROM session_provider_request AS r WHERE ${session}`)
        }),
      )
      const maintenance = fixture.logged.filter(
        (query) =>
          /\b(?:usage_analytics_request|session_provider_request)\b/.test(query.sql) && !/^\s*DELETE FROM (?:usage_analytics_request|session_provider_request)\b/.test(query.sql),
      )
      expect(maintenance.length).toBeGreaterThan(0)
      for (const query of maintenance) {
        const plan = fixture.explain(query.sql, query.params)
        expect(plan.filter((row) => /^SCAN (?:r|usage_analytics_request|session_provider_request)\b/.test(row.detail))).toEqual([])
      }
      for (const [table, predicate] of [
        ["usage_analytics_request", backend],
        ["session_provider_request", session],
      ] as const)
        expect(
          (yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM ${sql.raw(table)} AS r WHERE ${predicate}`))!.count,
        ).toBe(0)

      const pieces = SessionUsageRead.pieces({})
      for (const scope of [undefined, [SessionSchema.ID.make("ses_tie")]] as const) {
        const report = yield* SessionUsageRead.report(db, {
          where: scope ? sql`r.session_id IN (SELECT value FROM json_each(${JSON.stringify(scope)}))` : sql`1`,
          ...(scope ? { sessions: scope } : {}),
          group: "model",
          plan: { pieces, offsets: [] },
          order: sql`key ASC`,
          offset: 0,
          limit: 100,
          corrections: {},
        })
        expect(report.rows).toHaveLength(1)
        expect(report.rows[0]!.logical).toBe(remaining.length)
        expect(report.rows[0]!.model).toBe(second)
        expect(report.rows[0]!.speed).toMatchObject({
          samples: remaining.length,
          totalP50Ms: rank(remaining, 50),
          totalP95Ms: rank(remaining, 95),
        })
      }
      for (const summary of [yield* sessions.usageAll(), yield* sessions.usage(SessionSchema.ID.make("ses_tie"))]) {
        expect(summary.logical).toBe(remaining.length)
        expect(summary.latestTiming).toEqual({ totalMs: total - 1, firstOutputMs: (total - 1) % 97 })
        expect(summary.latestNamespace).toBe("tie-name")
      }
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 120_000)
