import { afterAll, expect, test } from "bun:test"
import { Config } from "@ycoding-ai/core/config"
import { Database } from "@ycoding-ai/core/database/database"
import { UsageStage } from "@ycoding-ai/core/usage-stage"
import { ServerProcess } from "@ycoding-ai/server/process"
import { Effect, Exit, Logger, Schema, Scope } from "effect"
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RemoteUsageDashboard } from "@ycoding-ai/remote"
import { UsageDashboard } from "@ycoding-ai/schema/usage-dashboard"
import { RemoteAgent, type ConnectionInput, type RelayConnection } from "../src/remote-bridge"
import { createLocalServer, type LocalServer } from "../src/remote-local"
import { createRemoteQueries, createRemoteQueryClient, type QueryScope, type RemoteLink } from "../../../apps/web/src/remote/queries"
import { createRemoteTransport } from "../../../apps/web/src/remote/transport"
import { usageReportInputs } from "../../../apps/web/src/remote/ui/usage-model"
import { auth, availablePort, password } from "./remote-harness"

const rows = 200_000
const locations = 2_500
const unpricedLocations = 100
const day = 86_400_000
const budget = { first: 10_000, warm: 2_000, local: 100, cold: 250 }
const pollMs = 50
const scope: QueryScope = { deviceID: "dev_usage_perf", generation: 1 }
const directories: string[] = []

afterAll(() => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))))

const round = (value: number) => Math.round(value * 10) / 10

function seed(file: string, locationRoot: string) {
  const now = Date.now()
  return Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db.run(`
      WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows - 1}),
      shaped AS (
        SELECT i, i % ${locations} AS loc, (i / 7) % 12 AS m, (i % ${locations}) < ${unpricedLocations} AS unpriced FROM n
      )
      INSERT INTO usage_analytics_request
        (id, session_id, project_id, directory, workspace_id, session_updated, agent, source, model, usage_anchor, task_path,
          request, attempts, continuation, invalidation, prompt_cache_key, cache_read_reported, tokens, cost, timing, time_created)
      SELECT printf('prq_perf_%07d', i), printf('ses_perf_%05d', i % 20000), printf('prj_perf_%02d', loc % 50),
        printf('${locationRoot}/location-%04d', loc), NULL, ${now} - (i % 20000), 'build',
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
        ${now} - CAST((i * 1.0 * ${30 * day - 3_600_000}) / ${rows} AS INTEGER)
      FROM shaped
    `)
    const count = yield* database.db.get<{ count: number }>("SELECT count(*) AS count FROM usage_analytics_request")
    expect(count?.count).toBe(rows)
    yield* database.db.transaction(() => UsageStage.backfill(database.db))
  }).pipe(Effect.provide(Database.layer({ path: file })), Effect.scoped)
}

const rates = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }

const pricing = {
  providers: {
    local: {
      package: "aisdk:@ai-sdk/openai-compatible",
      name: "Local synthetic",
      settings: { baseURL: "http://127.0.0.1:9/v1", apiKey: "synthetic" },
      models: Object.fromEntries(
        [0, 1, 2].map((index) => [
          `local-${index}`,
          { name: `Local ${index}`, cost: { input: rates.input, output: rates.output, cache: { read: rates.cacheRead, write: rates.cacheWrite } } },
        ]),
      ),
    },
  },
}

type Shape = {
  readonly total: number
  readonly locations: number
  readonly unpricedLocations: number
  readonly oldest: number
  readonly newest: number
  readonly recordedRequests: number
  readonly recordedCost: number
  readonly decisionUnpriced: number
  readonly catalogPricedRequests: number
  readonly catalogCost: number
}

async function inspectSeed(file: string) {
  const { Database } = await import("bun:sqlite")
  const connection = new Database(file, { readonly: true })
  const shape = connection
    .query<Shape, []>(
      `SELECT count(*) AS total, count(DISTINCT directory) AS locations,
        count(DISTINCT CASE WHEN cost IS NULL THEN directory END) AS unpricedLocations,
        min(time_created) AS oldest, max(time_created) AS newest,
        sum(cost IS NOT NULL) AS recordedRequests, coalesce(sum(cost), 0) AS recordedCost,
        sum(cost IS NULL AND source = 'decision') AS decisionUnpriced,
        sum(cost IS NULL AND source <> 'decision') AS catalogPricedRequests,
        coalesce(sum(CASE WHEN cost IS NULL AND source <> 'decision' THEN
          (json_extract(tokens, '$.input') * ${rates.input} + (json_extract(tokens, '$.output') + json_extract(tokens, '$.reasoning')) * ${rates.output}
            + json_extract(tokens, '$.cache.read') * ${rates.cacheRead} + json_extract(tokens, '$.cache.write') * ${rates.cacheWrite}) / 1000000.0 END), 0) AS catalogCost
      FROM usage_analytics_request`,
    )
    .get()!
  const unpriced = connection
    .query<{ directory: string }, []>("SELECT DISTINCT directory FROM usage_analytics_request WHERE cost IS NULL ORDER BY directory")
    .all()
    .map((row) => row.directory)
  connection.close()
  return { shape, unpriced }
}

const near = (actual: number | undefined, expected: number) => expect(Math.abs((actual ?? Number.NaN) - expected)).toBeLessThan(1e-4)

type Span = { readonly start: number; end?: number; outcome?: string }

function loopbackRelay(spans: Map<string, Span>) {
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  let deliver: ((frame: unknown) => void) | undefined
  const labels = new Map<string, string>()
  const emit = (type: string, event: unknown = {}) => listeners.get(type)?.forEach((listener) => listener(event))
  const socket = {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
    readyState: 0,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      const current = listeners.get(type) ?? new Set()
      current.add(listener)
      listeners.set(type, current)
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => listeners.get(type)?.delete(listener),
    send(raw: string) {
      const frame = JSON.parse(raw) as { type: string; id?: string; operation?: string; input?: { limit?: number } }
      if (frame.type === "ping") return queueMicrotask(() => emit("message", { data: JSON.stringify({ type: "pong" }) }))
      if (frame.type === "priority") return
      if (frame.type === "request" && frame.id !== undefined) {
        const label = frame.operation!
        labels.set(frame.id, label)
        spans.set(frame.id, { start: performance.now() })
      }
      deliver?.(frame)
    },
    close() {
      socket.readyState = 3
    },
  }
  const connection = (input: ConnectionInput): RelayConnection => {
    return {
      connect: async () => input.onOpen(),
      send: async (value: string) => {
        const frame = JSON.parse(value) as { type: string; id?: string; ok?: boolean; chunk?: { last: boolean } }
        if (frame.type !== "response" || frame.id === undefined) return
        if (frame.chunk === undefined || frame.chunk.last) {
          const span = spans.get(frame.id)
          if (span !== undefined) {
            span.end = performance.now()
            span.outcome = frame.ok ? "ok" : "failed"
          }
        }
        queueMicrotask(() => emit("message", { data: value }))
      },
      onMessage: (handler) => {
        deliver = handler
      },
      disconnect: async () => undefined,
    }
  }
  return {
    connection,
    labels,
    createSocket: () => {
      queueMicrotask(() => {
        socket.readyState = 1
        emit("open")
      })
      return socket as unknown as WebSocket
    },
  }
}

type Attempt = { readonly ms: number; readonly status: string }
type Read = { readonly label: string; readonly ms: number; readonly status: string; readonly attempts: readonly Attempt[] }

test(
  "the composed dashboard read reaches ready through the real server and connector over a synthetic loopback relay within the first-ready and warm budgets",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ycoding-usage-dashboard-"))
    directories.push(root)
    const locationRoot = join(root, "locations")
    await mkdir(locationRoot, { recursive: true })
    await Promise.all(
      Array.from({ length: unpricedLocations }, (_, index) => mkdir(join(locationRoot, `location-${String(index).padStart(4, "0")}`))),
    )
    const file = join(root, "usage.db")
    const seedStarted = performance.now()
    await Effect.runPromise(seed(file, locationRoot))
    const seedMs = round(performance.now() - seedStarted)
    const seeded = await inspectSeed(file)
    expect({ rows: seeded.shape.total, locations: seeded.shape.locations, unpricedLocations: seeded.shape.unpricedLocations }).toEqual({
      rows,
      locations,
      unpricedLocations,
    })
    expect(seeded.shape.newest - seeded.shape.oldest).toBeGreaterThan(29 * day)
    expect(seeded.shape.newest - seeded.shape.oldest).toBeLessThan(30 * day)
    expect(seeded.shape.catalogPricedRequests).toBeGreaterThan(0)
    expect(seeded.shape.catalogCost).toBeGreaterThan(0)
    expect(seeded.shape.decisionUnpriced).toBeGreaterThan(0)
    expect(await Promise.all(seeded.unpriced.map(async (directory) => (await stat(directory)).isDirectory()))).toEqual(
      Array.from({ length: unpricedLocations }, () => true),
    )
    const declared = Schema.decodeUnknownSync(Config.Info)(pricing).providers?.local?.models
    expect(Object.keys(declared ?? {}).sort()).toEqual(["local-0", "local-1", "local-2"])
    expect(declared?.["local-0"]?.cost).toMatchObject({ input: rates.input, output: rates.output, cache: { read: rates.cacheRead, write: rates.cacheWrite } })

    const configDirectory = join(root, "config")
    await mkdir(configDirectory)
    const port = await availablePort()
    const serverScope = await Effect.runPromise(Scope.make())
    const startingRaw = ServerProcess.start<never, never>({
      hostname: "127.0.0.1",
      port,
      password,
      database: { path: file },
      config: { directory: configDirectory, project: false, content: JSON.stringify(pricing) },
      models: { fetch: false },
      fs: { filewatcher: false, fff: false },
    }).pipe(Effect.provideService(Scope.Scope, serverScope), Effect.provide(Logger.layer([], { mergeWithExisting: false })))
    const starting = startingRaw as Effect.Effect<Effect.Success<typeof startingRaw>, Effect.Error<typeof startingRaw>>
    const serverStarted = performance.now()
    await Effect.runPromise(starting)
    const serverStartMs = round(performance.now() - serverStarted)

    const localCalls: { label: string; start: number; end: number }[] = []
    const base = createLocalServer({ url: `http://127.0.0.1:${port}`, auth: { type: "basic", username: "ycoding", password } })
    const timed = <Args extends unknown[], Value>(label: (...args: Args) => string, run: (...args: Args) => Promise<Value>) =>
      async (...args: Args) => {
        const start = performance.now()
        try {
          return await run(...args)
        } finally {
          localCalls.push({ label: label(...args), start, end: performance.now() })
        }
      }
    const local: LocalServer = {
      ...base,
      usageDashboard: timed((_input: Parameters<LocalServer["usageDashboard"]>[0]) => "usage.dashboard", base.usageDashboard),
    }

    const spans = new Map<string, Span>()
    const relay = loopbackRelay(spans)
    const bridge = new RemoteAgent({
      relayURL: "https://relay.example",
      local,
      credentials: async () => ({ accessToken: "integration-token", accessExpiresAt: Date.now() + 600_000 }),
      createConnection: relay.connection,
      refreshIntervalMs: 3_600_000,
    })
    const timings: { operation: string; outcome: string; queueMs: number; settlementMs?: number; totalMs: number }[] = []
    const transport = createRemoteTransport({
      url: "wss://relay.example/client",
      createSocket: relay.createSocket,
      handlers: { onRequestTiming: (timing) => timings.push(timing) },
    })
    const outcomes: string[] = []
    const link: RemoteLink = {
      request: async (current, operation, request) => {
        const outcome = await transport.request(operation, request)
        outcomes.push(`${operation}:${outcome.status}`)
        return outcome
      },
      recoveries: () => 0,
      recovered: async () => false,
    }

    const readRound = async () => {
      localCalls.length = 0
      timings.length = 0
      outcomes.length = 0
      spans.clear()
      const client = createRemoteQueryClient()
      const queries = createRemoteQueries(link, client)
      const inputs = usageReportInputs(Date.now(), undefined)
      const read = async () => {
        const begin = performance.now()
        const attempts: Attempt[] = []
        let status = "unsettled"
        let info: RemoteUsageDashboard | undefined
        while (true) {
          const attemptBegin = performance.now()
          info = await client.fetchQuery(queries.usageDashboard(scope, true, inputs)).then(
            (value) => (value.status === "ready" ? value.data : undefined),
            (error: unknown) => {
              status = `error:${error instanceof Error ? error.message : String(error)}`
              return undefined
            },
          )
          if (info !== undefined) status = info.status === "error" ? `error:${info.message}` : info.status
          attempts.push({ ms: round(performance.now() - attemptBegin), status })
          if (status !== "preparing" || performance.now() - begin > budget.first) break
          await Bun.sleep(pollMs)
        }
        const result: Read = { label: "usage.dashboard", ms: round(performance.now() - begin), status, attempts }
        return { result, info }
      }
      const started = performance.now()
      const { result, info } = await read()
      const settled = [result]
      const wallMs = round(performance.now() - started)
      client.clear()
      const connector = [...spans.entries()].map(([id, span]) => ({
        label: relay.labels.get(id) ?? id,
        ms: round((span.end ?? performance.now()) - span.start),
        outcome: span.outcome ?? "unsettled",
      }))
      return {
        wallMs,
        info,
        reads: settled,
        connector,
        localServer: localCalls.map((call) => ({ label: call.label, ms: round(call.end - call.start) })),
        transport: timings.map((timing) => ({ operation: timing.operation, outcome: timing.outcome, queueMs: timing.queueMs, settlementMs: timing.settlementMs, totalMs: timing.totalMs })),
        outcomes: [...outcomes],
      }
    }

    const settleProducer = async () => {
      const { Database } = await import("bun:sqlite")
      const connection = new Database(file, { readonly: true })
      const begin = performance.now()
      try {
        for (;;) {
          const state = connection
            .query<{ open: number; total: number }, []>(
              "SELECT count(*) FILTER (WHERE status IN ('pending', 'building')) AS open, count(*) AS total FROM usage_view_state",
            )
            .get()
          if (state !== null && state.total > 0 && state.open === 0) return round(performance.now() - begin)
          if (performance.now() - begin > budget.first * 3) throw new Error(`The startup producer did not settle: ${JSON.stringify(state)}`)
          await Bun.sleep(pollMs)
        }
      } finally {
        connection.close()
      }
    }

    try {
      await bridge.connect()
      transport.connect()
      await Bun.sleep(0)
      expect(transport.status().kind).toBe("open")
      const producerMs = await settleProducer()
      const bootBegin = performance.now()
      await base.projectCurrent({ directory: process.cwd() })
      const locationBootMs = round(performance.now() - bootBegin)
      const quotaBegin = performance.now()
      for (;;) {
        const info = await base.usageDashboard(usageReportInputs(Date.now(), undefined))
        if (info.status === "ready" && info.quota.status !== "preparing") break
        if (performance.now() - quotaBegin > budget.first) throw new Error(`The request Location quota did not settle: ${JSON.stringify(info.status)}`)
        await Bun.sleep(pollMs)
      }
      const quotaSettleMs = round(performance.now() - quotaBegin)
      const first = await readRound()
      const warm1 = await readRound()
      const warm2 = await readRound()
      const inputs = usageReportInputs(Date.now(), undefined)
      const directBegin = performance.now()
      await base.usageDashboard(inputs)
      const direct = [{ label: "usage.dashboard", ms: round(performance.now() - directBegin) }]
      const coldDirectory = join(root, "cold-location")
      await mkdir(coldDirectory)
      const coldRead = async () => {
        const begin = performance.now()
        const response = await fetch(`http://127.0.0.1:${port}/api/usage/dashboard`, {
          method: "POST",
          headers: { authorization: auth, "content-type": "application/json", "x-ycoding-directory": encodeURIComponent(coldDirectory) },
          body: JSON.stringify(usageReportInputs(Date.now(), undefined)),
        })
        const body = Schema.decodeUnknownSync(Schema.Struct({ data: UsageDashboard.Info }))(await response.json())
        return { ms: round(performance.now() - begin), info: body.data }
      }
      const coldBegin = performance.now()
      const coldFirst = await coldRead()
      let coldSettled = coldFirst
      while (coldSettled.info.status === "ready" && coldSettled.info.quota.status === "preparing" && performance.now() - coldBegin < budget.first) {
        await Bun.sleep(pollMs)
        coldSettled = await coldRead()
      }
      const cold = {
        localServerMs: coldFirst.ms,
        status: coldFirst.info.status,
        quota: coldFirst.info.status === "ready" ? coldFirst.info.quota.status : undefined,
        overlappingBootMs: round(performance.now() - coldBegin),
        settledQuota: coldSettled.info.status === "ready" ? coldSettled.info.quota.status : undefined,
      }
      const everything = usageReportInputs(Date.now(), undefined, { group: "model", offset: 0, sort: "cost", order: "desc", range: "all" }).breakdown
      const total = (await base.usageReport(everything)).total
      const summary = await base.usageSummary()
      const expected = {
        logical: seeded.shape.total,
        costCoverage: { pricedRequests: seeded.shape.total - seeded.shape.decisionUnpriced, unpricedRequests: seeded.shape.decisionUnpriced },
        cost: seeded.shape.recordedCost + seeded.shape.catalogCost,
      }
      const pricingEvidence = {
        recordedRequests: seeded.shape.recordedRequests,
        recordedCost: seeded.shape.recordedCost,
        catalogPricedRequests: seeded.shape.catalogPricedRequests,
        catalogCost: seeded.shape.catalogCost,
        decisionUnpriced: seeded.shape.decisionUnpriced,
        expected,
        observed: { logical: total.logical, costCoverage: total.costCoverage, cost: total.cost, costProvenance: total.costProvenance, summaryCost: summary.cost },
      }
      const evidence = (value: typeof first) => {
        const { info, ...rest } = value
        return { ...rest, quota: info?.status === "ready" ? info.quota.status : undefined }
      }
      const report = { seedMs, serverStartMs, producerMs, locationBootMs, quotaSettleMs, cold, rows, locations, unpricedLocations, pricing: pricingEvidence, first: evidence(first), warm1: evidence(warm1), warm2: evidence(warm2), serverDirectWarm: direct }
      console.log(`usage-dashboard-performance ${JSON.stringify(report)}`)
      const evidenceDirectory = join(import.meta.dir, "..", "tmp")
      await mkdir(evidenceDirectory, { recursive: true })
      await Bun.write(join(evidenceDirectory, "usage-dashboard-performance.json"), JSON.stringify(report, null, 2))
      expect({ logical: total.logical, costCoverage: total.costCoverage, costProvenance: total.costProvenance }).toEqual({
        logical: expected.logical,
        costCoverage: expected.costCoverage,
        costProvenance: "current_catalog",
      })
      near(total.cost, expected.cost)
      expect(summary.logical).toBe(expected.logical)
      near(summary.cost, expected.cost)
      expect({
        over: [first, warm1, warm2].flatMap((value) =>
          value.localServer.filter((call) => call.ms > budget.local).map((call) => `${call.label}=${call.ms}ms`),
        ),
      }).toEqual({ over: [] })
      expect({ status: cold.status, quota: cold.quota, slow: cold.localServerMs > budget.cold }).toEqual({ status: "ready", quota: "preparing", slow: false })
      expect(cold.settledQuota).not.toBe("preparing")
      for (const [name, value, limit] of [["first", first, budget.first], ["warm1", warm1, budget.warm], ["warm2", warm2, budget.warm]] as const) {
        const attempts = value.reads.flatMap((read) => read.attempts.map((attempt) => attempt.status))
        expect({ name, final: value.reads.map((read) => `${read.label}:${read.status}`), info: value.info?.status }).toEqual({
          name,
          final: ["usage.dashboard:ready"],
          info: "ready",
        })
        expect({ name, attempts: attempts.slice(0, -1).every((status) => status === "preparing"), last: attempts.at(-1) }).toEqual({ name, attempts: true, last: "ready" })
        if (name !== "first") expect({ name, attempts }).toEqual({ name, attempts: ["ready"] })
        expect({ name, outcomes: [...value.outcomes] }).toEqual({ name, outcomes: attempts.map(() => "usage.dashboard:ok") })
        expect({ name, local: value.localServer.map((call) => call.label) }).toEqual({ name, local: attempts.map(() => "usage.dashboard") })
        expect({ name, over: value.reads.filter((read) => read.ms > limit).map((read) => `${read.label}=${read.ms}ms`) }).toEqual({ name, over: [] })
        const info = value.info
        if (info?.status !== "ready") throw new Error(`${name} dashboard is not ready`)
        expect(info.summary.logical).toBe(expected.logical)
        near(info.summary.cost, expected.cost)
        expect({ daily: info.daily?.group, monthly: info.monthly?.group, breakdown: info.breakdown?.group }).toEqual({
          daily: inputs.daily.group,
          monthly: inputs.monthly.group,
          breakdown: inputs.breakdown.group,
        })
        expect(["preparing", "ready", "error"]).toContain(info.quota.status)
        if (info.quota.status === "ready") expect(info.quota.forecast.localScope).toBe("backend")
        expect(info.asOf).toBeGreaterThan(0)
      }
    } finally {
      transport.close()
      await bridge.close()
      await Effect.runPromise(Scope.close(serverScope, Exit.void))
    }
  },
  { timeout: 900_000 },
)
