import { afterAll, expect, test } from "bun:test"
import { Database as SqliteDatabase } from "bun:sqlite"
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
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { RetentionSettings } from "../src/retention-settings"
import { Session } from "../src/session"
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { SessionProviderRequest } from "../src/session/provider-request"
import { SessionSchema } from "../src/session/schema"
import { SessionTable } from "../src/session/sql"
import { UsageAnalytics } from "../src/usage-analytics"
import { Agent } from "@ycoding-ai/schema/agent"
import { Model } from "@ycoding-ai/schema/model"
import { Provider } from "@ycoding-ai/schema/provider"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { AbsolutePath } from "@ycoding-ai/schema/schema"

const hour = 3_600_000
const day = 86_400_000
const directories: string[] = []

afterAll(() => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))))

type Spec = {
  readonly id: string
  readonly session: string
  readonly request: number
  readonly time: number
  readonly provider: string
  readonly model: string
  readonly outcome?: ProviderRequest.Outcome
  readonly timing?: ProviderRequest.Timing
}

function harness(options: { readonly path?: string } = {}) {
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
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* DatabaseMigration.apply(db)
      return { db }
    }),
  ).pipe(Layer.provide(sqliteLayer({ filename: options.path ?? ":memory:" })))
  const runtime = AppNodeBuilder.build(LayerNode.group([Database.node, EventRuntime.node, Session.node, UsageAnalytics.node, SessionProviderRequest.node]), [
    [Database.node, database],
    [SessionExecution.node, SessionExecution.noopLayer],
    [
      RetentionSettings.node,
      Layer.succeed(RetentionSettings.Service, {
        read: () => Effect.sync(() => ({ recordsDays: 3_650, usageDays: 3_650, latencyDays: 30, incidentDays: 30 })),
      }),
    ],
  ])
  return { queries, runtime }
}

const seedSessions = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/tel"), sandboxes: [] }).run()
  yield* db
    .insert(SessionTable)
    .values({ id: SessionSchema.ID.make("ses_tel_root"), project_id: Project.ID.global, directory: "/tel", title: "root" })
    .run()
  yield* db
    .insert(SessionTable)
    .values({
      id: SessionSchema.ID.make("ses_tel_child"),
      project_id: Project.ID.global,
      directory: "/tel",
      title: "child",
      parent_id: SessionSchema.ID.make("ses_tel_root"),
    })
    .run()
}).pipe(Effect.orDie)

const record = (spec: Spec) =>
  Effect.flatMap(EventRuntime.Service, (events) =>
    events.publish(SessionEvent.ProviderRequestRecorded, {
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
      ...(spec.timing === undefined ? {} : { timing: spec.timing }),
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      time: DateTime.makeUnsafe(spec.time),
    }),
  )

const rank = (values: ReadonlyArray<number>, percent: number) => {
  const sorted = values.toSorted((left, right) => left - right)
  return sorted[Math.ceil((sorted.length * percent) / 100) - 1]!
}

const base = Math.floor((Date.now() - 5 * day) / day) * day

const telemetry: ReadonlyArray<Spec> = [
  {
    id: "prq_tel_a",
    session: "ses_tel_root",
    request: 1,
    time: base + hour + 1,
    provider: "openai",
    model: "gpt",
    outcome: "completed",
    timing: { totalMs: 1_800_000, firstOutputMs: 100, generatedTokens: 100, generationDurationNs: 1_000_000_000 },
  },
  {
    id: "prq_tel_b",
    session: "ses_tel_child",
    request: 1,
    time: base + hour + 2,
    provider: "openai",
    model: "gpt",
    outcome: "failed",
    timing: { totalMs: 3_600_000, firstOutputMs: 300, generatedTokens: 100, generationDurationNs: 9_000_000_000 },
  },
  {
    id: "prq_tel_c",
    session: "ses_tel_child",
    request: 2,
    time: base + 2 * hour,
    provider: "openai",
    model: "gpt",
    outcome: "cancelled",
    timing: { totalMs: 600, firstOutputMs: 200 },
  },
  {
    id: "prq_tel_d",
    session: "ses_tel_root",
    request: 2,
    time: base + 2 * hour + 5,
    provider: "anthropic",
    model: "claude",
    timing: { totalMs: 900, firstOutputMs: 50, generatedTokens: 30, observedGenerationDurationNs: 2_000_000_000 },
  },
  { id: "prq_tel_e", session: "ses_tel_root", request: 3, time: base + 3 * hour, provider: "google", model: "gemini" },
]

const providerRow = (report: ProviderRequest.Report, provider: string) =>
  report.rows.find((row) => row.key === JSON.stringify(["provider", provider]))!

test("outcomes persist on both request stores and aggregate per group, total and Session tree without double counting", () => {
  const fixture = harness()
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* seedSessions
      for (const spec of telemetry) yield* record(spec)
      yield* record(telemetry[0]!)
      const { db } = yield* Database.Service
      for (const table of ["session_provider_request", "usage_analytics_request"])
        expect(yield* db.all(sql.raw(`SELECT id, outcome FROM ${table} ORDER BY id`))).toEqual([
          { id: "prq_tel_a", outcome: "completed" },
          { id: "prq_tel_b", outcome: "failed" },
          { id: "prq_tel_c", outcome: "cancelled" },
          { id: "prq_tel_d", outcome: null },
          { id: "prq_tel_e", outcome: null },
        ])
      const sessions = yield* Session.Service
      const backend = yield* sessions.usageReportAll({ group: "provider" })
      expect(providerRow(backend, "openai").outcomes).toEqual({ completed: 1, failed: 1, cancelled: 1 })
      expect(providerRow(backend, "anthropic").outcomes).toBeUndefined()
      expect(providerRow(backend, "google").outcomes).toBeUndefined()
      expect(backend.total.outcomes).toEqual({ completed: 3, failed: 1, cancelled: 1 })
      const tree = yield* sessions.usageReport({ sessionID: SessionSchema.ID.make("ses_tel_root"), group: "session" })
      expect(tree.total.logical).toBe(5)
      expect(tree.total.outcomes).toEqual({ completed: 3, failed: 1, cancelled: 1 })
      expect(Object.fromEntries(tree.rows.map((row) => [row.key, row.outcomes]))).toEqual({
        ses_tel_root: { completed: 3, failed: 0, cancelled: 0 },
        ses_tel_child: { completed: 0, failed: 1, cancelled: 1 },
      })
      const child = yield* sessions.usageReport({ sessionID: SessionSchema.ID.make("ses_tel_child"), group: "provider" })
      expect(child.total).toMatchObject({ logical: 2, outcomes: { completed: 0, failed: 1, cancelled: 1 } })
      const filtered = yield* sessions.usageReportAll({ group: "day", providerID: Provider.ID.make("openai") })
      expect(filtered.total.outcomes).toEqual({ completed: 1, failed: 1, cancelled: 1 })
      const historical = yield* sessions.usageReportAll({ group: "provider", providerID: Provider.ID.make("anthropic") })
      expect(historical.total.outcomes).toBeUndefined()
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 60_000)

test("speed reports request-average and aggregate throughput separately with sample percentiles, and stays absent when unknown", () => {
  const fixture = harness()
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* seedSessions
      for (const spec of telemetry) yield* record(spec)
      const sessions = yield* Session.Service
      for (const report of [
        yield* sessions.usageReportAll({ group: "provider" }),
        yield* sessions.usageReport({ sessionID: SessionSchema.ID.make("ses_tel_root"), group: "provider" }),
      ]) {
        const openai = providerRow(report, "openai").speed!
        expect(openai.generationSamples).toBe(2)
        expect(openai.meanTokensPerSecond).toBeCloseTo((100 + 100 / 9) / 2, 9)
        expect(openai.outputTokensPerSecond).toBeCloseTo(20, 9)
        expect(openai.meanTokensPerSecond! > openai.outputTokensPerSecond!).toBe(true)
        expect(openai.generationP50TokensPerSecond).toBeCloseTo(100 / 9, 9)
        expect(openai.generationP90TokensPerSecond).toBeCloseTo(100, 9)
        expect(openai.generationP95TokensPerSecond).toBeCloseTo(100, 9)
        expect(openai).toMatchObject({ firstOutputP50Ms: 200, firstOutputP95Ms: 300, firstOutputP99Ms: 300 })
        expect(openai).toMatchObject({ totalP50Ms: 1_800_000, totalP95Ms: 3_600_000, totalP99Ms: 3_600_000 })
        const anthropic = providerRow(report, "anthropic").speed!
        expect(anthropic.meanTokensPerSecond).toBeCloseTo(15, 9)
        expect(anthropic.outputTokensPerSecond).toBeCloseTo(15, 9)
        expect(anthropic.generationP95TokensPerSecond).toBeCloseTo(15, 9)
        expect(anthropic).toMatchObject({ firstOutputP99Ms: 50, totalP99Ms: 900 })
      }
      const backend = yield* sessions.usageReportAll({ group: "provider" })
      expect(providerRow(backend, "google").speed).toBeUndefined()
      const timedOnly = yield* sessions.usageReportAll({ group: "provider", providerID: Provider.ID.make("openai"), from: base + 2 * hour })
      expect(timedOnly.rows[0]!.speed).toMatchObject({ generationSamples: 0, totalP99Ms: 600, firstOutputP99Ms: 200 })
      for (const field of ["meanTokensPerSecond", "generationP95TokensPerSecond", "outputTokensPerSecond"] as const)
        expect(timedOnly.rows[0]!.speed![field]).toBeUndefined()
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 60_000)

test("percentiles come from merged stored samples for one, two, three and twenty requests", () => {
  const fixture = harness()
  const sizes = [1, 2, 3, 20]
  const specs = sizes.flatMap((size) =>
    Array.from({ length: size }, (_, index): Spec => ({
      id: `prq_tel_p${size}_${index.toString().padStart(2, "0")}`,
      session: "ses_tel_root",
      request: size * 100 + index,
      time: base + (index % 4) * 20 * 60_000 + size,
      provider: "openai",
      model: `p${size}`,
      timing: {
        totalMs: 1_000 + ((index * 7919) % 97) * 10,
        firstOutputMs: (index * 37) % 23,
        generatedTokens: 10 + index,
        generationDurationNs: 1_000_000_000 + ((index * 13) % 7) * 250_000_000,
      },
    })),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* seedSessions
      for (const spec of specs) yield* record(spec)
      const sessions = yield* Session.Service
      const report = yield* sessions.usageReportAll({ group: "model-id" })
      for (const size of sizes) {
        const selected = specs.filter((spec) => spec.model === `p${size}`)
        const totals = selected.map((spec) => spec.timing!.totalMs!)
        const firsts = selected.map((spec) => spec.timing!.firstOutputMs!)
        const rates = selected.map((spec) => (spec.timing!.generatedTokens! * 1_000_000_000) / spec.timing!.generationDurationNs!)
        const speed = report.rows.find((row) => row.key === JSON.stringify(["model-id", `p${size}`]))!.speed!
        expect({
          first: [speed.firstOutputP50Ms, speed.firstOutputP95Ms, speed.firstOutputP99Ms],
          total: [speed.totalP50Ms, speed.totalP95Ms, speed.totalP99Ms],
        }).toEqual({
          first: [rank(firsts, 50), rank(firsts, 95), rank(firsts, 99)],
          total: [rank(totals, 50), rank(totals, 95), rank(totals, 99)],
        })
        expect(speed.generationP50TokensPerSecond).toBeCloseTo(rank(rates, 50), 9)
        expect(speed.generationP90TokensPerSecond).toBeCloseTo(rank(rates, 90), 9)
        expect(speed.generationP95TokensPerSecond).toBeCloseTo(rank(rates, 95), 9)
        expect(speed.meanTokensPerSecond).toBeCloseTo(rates.reduce((sum, rate) => sum + rate, 0) / rates.length, 9)
      }
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 60_000)

test("time groups report average concurrency over each bucket's real length, including local daylight-saving days", () => {
  const fixture = harness()
  const dst = Date.UTC(2026, 2, 8, 12)
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* seedSessions
      for (const spec of telemetry) yield* record(spec)
      yield* record({
        id: "prq_tel_dst",
        session: "ses_tel_root",
        request: 9,
        time: dst,
        provider: "openai",
        model: "gpt",
        timing: { totalMs: 828_000 },
      })
      const sessions = yield* Session.Service
      const hours = yield* sessions.usageReportAll({ group: "hour", from: base, to: base + day })
      const concurrency = Object.fromEntries(hours.rows.map((row) => [row.key, row.concurrency]))
      const iso = (time: number) => `${new Date(time).toISOString().slice(0, 13)}:00:00.000Z`
      expect(concurrency[iso(base + hour)]).toBeCloseTo(1.5, 12)
      expect(concurrency[iso(base + 2 * hour)]).toBeCloseTo(1_500 / hour, 12)
      expect(iso(base + 3 * hour) in concurrency).toBe(true)
      expect(concurrency[iso(base + 3 * hour)]).toBeUndefined()
      const days = yield* sessions.usageReportAll({ group: "day", from: base, to: base + day })
      expect(days.rows[0]!.concurrency).toBeCloseTo(5_401_500 / day, 12)
      const start = new Date(base)
      const monthLength = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1) - Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)
      const months = yield* sessions.usageReportAll({ group: "month", from: base, to: base + day })
      expect(months.rows[0]!.concurrency).toBeCloseTo(5_401_500 / monthLength, 12)
      const local = yield* sessions.usageReportAll({ group: "day", timeZone: "America/New_York", from: dst - hour, to: dst + hour })
      expect(local.rows.map((row) => [row.key, row.concurrency])).toEqual([["2026-03-08", 828_000 / (23 * hour)]])
      const utc = yield* sessions.usageReportAll({ group: "day", from: dst - hour, to: dst + hour })
      expect(utc.rows[0]!.concurrency).toBeCloseTo(828_000 / day, 12)
      const nonTime = yield* sessions.usageReportAll({ group: "provider" })
      expect(nonTime.rows.every((row) => row.concurrency === undefined)).toBe(true)
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 60_000)

const expectSpeed = (actual: ProviderRequest.Speed | undefined, expected: ProviderRequest.Speed | undefined) => {
  if (expected === undefined) return expect(actual).toBeUndefined()
  const { meanTokensPerSecond, outputTokensPerSecond, ...exact } = expected
  expect({ ...actual, meanTokensPerSecond: undefined, outputTokensPerSecond: undefined }).toEqual({
    ...exact,
    meanTokensPerSecond: undefined,
    outputTokensPerSecond: undefined,
  })
  expect(actual!.meanTokensPerSecond).toBeCloseTo(meanTokensPerSecond!, 9)
  expect(actual!.outputTokensPerSecond).toBeCloseTo(outputTokensPerSecond!, 9)
}

test("stored records keep their outcome and report speed covers every filtered request once across groups and pages", () => {
  const fixture = harness()
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* seedSessions
      for (const spec of telemetry) yield* record(spec)
      const requests = yield* SessionProviderRequest.Service
      const outcomes = (records: ReadonlyArray<ProviderRequest.Record>) =>
        Object.fromEntries(records.map((item) => [item.id, item.outcome ?? null]))
      const all = yield* requests.listAll()
      expect(outcomes(all)).toEqual({
        prq_tel_a: "completed",
        prq_tel_b: "failed",
        prq_tel_c: "cancelled",
        prq_tel_d: null,
        prq_tel_e: null,
      })
      expect(outcomes(yield* requests.list(SessionSchema.ID.make("ses_tel_child")))).toEqual({
        prq_tel_b: "failed",
        prq_tel_c: "cancelled",
      })
      expect(outcomes(yield* requests.recentSteps(SessionSchema.ID.make("ses_tel_root")))).toEqual({
        prq_tel_a: "completed",
        prq_tel_d: null,
        prq_tel_e: null,
      })
      const expected = SessionProviderRequest.reportSpeed(all)!
      expect(expected.generationSamples).toBe(3)
      const sessions = yield* Session.Service
      for (const input of [
        { group: "provider", limit: 1 },
        { group: "session", offset: 1, limit: 1 },
        { group: "hour", timeZone: "Asia/Kathmandu" },
        { group: "model-id", sort: "cost", order: "desc" },
      ] as const) {
        expectSpeed((yield* sessions.usageReportAll(input)).speed, expected)
        expectSpeed((yield* sessions.usageReport({ ...input, sessionID: SessionSchema.ID.make("ses_tel_root") })).speed, expected)
      }
      const child = all.filter((item) => item.sessionID === "ses_tel_child")
      expectSpeed(
        (yield* sessions.usageReport({ group: "provider", sessionID: SessionSchema.ID.make("ses_tel_child") })).speed,
        SessionProviderRequest.reportSpeed(child),
      )
      const openai = all.filter((item) => item.model.providerID === "openai")
      expectSpeed(
        (yield* sessions.usageReportAll({ group: "day", providerID: Provider.ID.make("openai"), offset: 5 })).speed,
        SessionProviderRequest.reportSpeed(openai),
      )
      for (const report of [
        yield* sessions.usageReportAll({ group: "provider", providerID: Provider.ID.make("google") }),
        yield* sessions.usageReportAll({ group: "provider", from: base + 4 * day }),
      ])
        expect(report.speed).toBeUndefined()
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
}, 60_000)

test("a database that already applied and backfilled prepared usage upgrades by rebuilding every prepared cell", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-telemetry-upgrade-"))
  directories.push(directory)
  const path = join(directory, "usage.db")
  const telemetryMigration = "20261028131454_usage-telemetry"
  const telemetryColumns = {
    usage_analytics_request: ["outcome"],
    session_provider_request: ["outcome"],
    session_usage_cell: ["generation_rate", "busy_ms", "failed", "cancelled", "outcomes"],
    usage_analytics_cell: ["generation_rate", "busy_ms", "failed", "cancelled", "outcomes"],
    usage_view_row: ["generation_rate", "busy_ms", "failed", "cancelled", "outcomes"],
  }
  const columns = (file: SqliteDatabase) =>
    Object.fromEntries(
      Object.keys(telemetryColumns).map((table) => [
        table,
        file
          .query<{ name: string; type: string; notnull: number; dflt_value: string | null }, []>(`PRAGMA table_info(${table})`)
          .all()
          .map((column) => `${column.name} ${column.type} ${column.notnull} ${column.dflt_value}`)
          .toSorted(),
      ]),
    )
  const first = harness({ path })
  const before = await Effect.runPromise(
    Effect.gen(function* () {
      yield* seedSessions
      for (const { outcome: _, ...spec } of telemetry) yield* record(spec)
      const sessions = yield* Session.Service
      return yield* sessions.usageReportAll({ group: "hour", from: base, to: base + day })
    }).pipe(Effect.provide(first.runtime), Effect.scoped),
  )
  expect(before.rows.some((row) => (row.concurrency ?? 0) > 0)).toBe(true)
  expect(before.total.outcomes).toBeUndefined()

  const file = new SqliteDatabase(path)
  const freshColumns = columns(file)
  for (const [table, names] of Object.entries(telemetryColumns))
    for (const name of names) file.run(`ALTER TABLE ${table} DROP COLUMN ${name}`)
  file.run(`UPDATE session_usage_cell SET output = output + 1000`)
  file.run(`UPDATE usage_analytics_cell SET output = output + 1000`)
  for (const [id, status] of [["built", "ready"], ["broken", "error"], ["retired", "evicted"]])
    file.run(
      `INSERT INTO usage_view_state (id, recipe, generation, status, applied_seq, rows, version, refs, time_used)
       VALUES (?, 'recipe', 1, ?, 0, 0, 1, 0, 0)`,
      [id, status],
    )
  file.run(`DELETE FROM migration WHERE id = ?`, [telemetryMigration])
  expect(file.query<{ id: string }, []>(`SELECT id FROM migration WHERE id >= '20261028' ORDER BY id`).all()).toEqual([
    { id: "20261028041559_prepared-usage" },
  ])
  file.close()

  const reopened = harness({ path })
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      expect(yield* db.all(sql`SELECT id FROM migration WHERE id >= '20261028' ORDER BY id`)).toEqual([
        { id: "20261028041559_prepared-usage" },
        { id: telemetryMigration },
      ])
      expect(yield* db.all(sql`SELECT id, status FROM usage_view_state ORDER BY id`)).toEqual([
        { id: "broken", status: "pending" },
        { id: "built", status: "pending" },
        { id: "retired", status: "evicted" },
      ])
      const sessions = yield* Session.Service
      expect(yield* sessions.usageReportAll({ group: "hour", from: base, to: base + day })).toEqual(before)
    }).pipe(Effect.provide(reopened.runtime), Effect.scoped),
  )
  const upgraded = new SqliteDatabase(path, { readonly: true })
  expect(columns(upgraded)).toEqual(freshColumns)
  upgraded.close()
}, 60_000)

test("finalized outcomes and speed survive a restart from prepared stores without rereading raw requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-telemetry-"))
  directories.push(directory)
  const path = join(directory, "usage.db")
  const first = harness({ path })
  const before = await Effect.runPromise(
    Effect.gen(function* () {
      yield* seedSessions
      for (const spec of telemetry) yield* record(spec)
      const sessions = yield* Session.Service
      return yield* sessions.usageReportAll({ group: "hour", from: base, to: base + day })
    }).pipe(Effect.provide(first.runtime), Effect.scoped),
  )
  const reopened = harness({ path })
  await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      reopened.queries.length = 0
      const after = yield* sessions.usageReportAll({ group: "hour", from: base, to: base + day })
      expect(after).toEqual(before)
      expect(after.total.outcomes).toEqual({ completed: 3, failed: 1, cancelled: 1 })
      expect(reopened.queries.filter((query) => /\b(?:from|join)\s+[`"]?(?:usage_analytics_request|session_provider_request)\b/i.test(query))).toEqual([])
    }).pipe(Effect.provide(reopened.runtime), Effect.scoped),
  )
}, 60_000)
