import { expect, test } from "bun:test"
import { stat } from "node:fs/promises"
import { WireLimit, type RemoteUsageDashboard } from "@ycoding-ai/remote"
import { createRemoteQueries, createRemoteQueryClient, type QueryScope, type RemoteLink } from "../../../apps/web/src/remote/queries"
import { createRemoteTransport, type RemoteRequestTiming } from "../../../apps/web/src/remote/transport"
import { usageReportInputs } from "../../../apps/web/src/remote/ui/usage-model"
import { createUsageFixture, createUsageRelay, day, locations, rates, round, rows, unpricedLocations } from "./support/native-usage-performance"

const budget = { first: 10_000, warm: 2_000, local: 100, cold: 250 }
const producerBudget = budget.first * 3
const pollMs = 50
const localPollMs = Math.ceil((8 * WireLimit.RATE_WINDOW_MS) / WireLimit.CLIENT_RATE)
const scope: QueryScope = { deviceID: "dev_usage_perf", generation: 1 }
const near = (actual: number | undefined, expected: number) => expect(Math.abs((actual ?? Number.NaN) - expected)).toBeLessThan(1e-4)

async function waitUntil(ready: () => boolean | Promise<boolean>, timeout: number, description: string) {
  const stop = performance.now() + timeout
  while (!(await ready())) {
    if (performance.now() >= stop) throw new Error(`${description} did not become ready`)
    await Bun.sleep(localPollMs)
  }
}

function failureCode(error: unknown) {
  if (typeof error !== "object" || error === null) return "untyped"
  for (const key of ["kind", "status", "_tag"] as const) {
    const value = Reflect.get(error, key)
    if (typeof value === "string" && /^[\w.:-]{1,80}$/.test(value)) return value
  }
  return "untyped"
}

function direct<T>(request: Promise<T>, operation: string) {
  return request.catch((error: unknown) => { throw new Error(`${operation}: ${failureCode(error)}`) })
}

function prepared<T>(request: Promise<T>, operation: string) {
  return request.then((value) => ({ status: "ready", value }) as const, (error: unknown) => {
    const code = failureCode(error)
    if (code === "unavailable") return { status: code } as const
    throw new Error(`${operation}: ${code}`)
  })
}

test("the native connector supplies the dashboard within the first-ready, warm, and cold quota budgets", async () => {
  const fixture = await createUsageFixture()
  try {
    const { seeded, now } = fixture
    expect({ rows: seeded.rows, locations: seeded.locations, unpricedLocations: seeded.unpricedDirectories.length }).toEqual({ rows, locations, unpricedLocations })
    expect(seeded.newest - seeded.oldest).toBeGreaterThan(29 * day)
    expect(seeded.newest - seeded.oldest).toBeLessThan(30 * day)
    expect(await Promise.all(seeded.unpricedDirectories.map(async (directory) => (await stat(directory)).isDirectory()))).toEqual(Array.from({ length: unpricedLocations }, () => true))

    const populations = seeded.populations
    const sum = (read: (population: (typeof populations)[number]) => number) => populations.reduce((total, population) => total + read(population), 0)
    const recordedRequests = sum((population) => population.recorded)
    const catalogPricedRequests = sum((population) => population.catalogPriced)
    const decisionUnpriced = sum((population) => population.decisionUnpriced)
    const recordedCost = sum((population) => population.recordedCost)
    const catalogCost = sum(({ catalogTokens: tokens }) => (tokens.input * rates.input + (tokens.output + tokens.reasoning) * rates.output + tokens.cacheRead * rates.cacheRead + tokens.cacheWrite * rates.cacheWrite) / 1_000_000)
    expect(sum((population) => population.requests)).toBe(rows)
    expect(recordedRequests + catalogPricedRequests + decisionUnpriced).toBe(rows)
    expect(catalogPricedRequests).toBeGreaterThan(0)
    expect(catalogCost).toBeGreaterThan(0)
    expect(decisionUnpriced).toBeGreaterThan(0)
    const expectedCost = recordedCost + catalogCost
    const costCoverage = { pricedRequests: recordedRequests + catalogPricedRequests, unpricedRequests: decisionUnpriced }

    const started = performance.now()
    const runtime = await fixture.startRuntime()
    const serverStartMs = round(performance.now() - started)
    const relay = createUsageRelay(scope.deviceID)
    const timings: RemoteRequestTiming[] = []
    const transport = createRemoteTransport({ url: relay.url, revision: () => scope.generation, admit: () => true, handlers: { onRequestTiming: (timing) => timings.push(timing) } })
    const link: RemoteLink = { request: (_current, operation, request) => transport.request(operation, request), recoveries: () => 0, recovered: async () => false }
    const inputs = usageReportInputs(now, undefined)
    const readRound = async (name: string) => {
      timings.length = 0
      relay.connector.length = 0
      const client = createRemoteQueryClient()
      const queries = createRemoteQueries(link, client)
      const attempts: { ms: number; status: RemoteUsageDashboard["status"] }[] = []
      const begin = performance.now()
      try {
        for (;;) {
          const attempt = performance.now()
          const value = await client.fetchQuery(queries.usageDashboard(scope, true, inputs))
          if (value.status !== "ready") throw new Error(`Dashboard query did not settle: ${JSON.stringify({ value, failures: relay.failures })}`)
          const info = value.data
          attempts.push({ ms: performance.now() - attempt, status: info.status })
          if (info.status === "error") throw new Error(`${name} dashboard preparation failed`)
          if (info.status === "ready") return { info, ms: performance.now() - begin, attempts, connector: [...relay.connector], transport: [...timings] }
          if (performance.now() - begin >= budget.first) {
            const options = { signal: AbortSignal.timeout(budget.first) }
            const [summary, daily, monthly, breakdown, quota] = await Promise.all([
              prepared(runtime.client.usage.get(options), "usage.get"),
              prepared(runtime.client.usage.report(inputs.daily, options), "usage.report daily"),
              prepared(runtime.client.usage.report(inputs.monthly, options), "usage.report monthly"),
              prepared(runtime.client.usage.report(inputs.breakdown, options), "usage.report breakdown"),
              runtime.client.providerUsage.list(undefined, options).then(() => "ready", failureCode),
            ])
            const evidence = { count: attempts.length, slowestMs: round(Math.max(...attempts.map(({ ms }) => ms))), summary: summary.status, daily: daily.status, monthly: monthly.status, breakdown: breakdown.status, quota }
            throw new Error(`${name} dashboard did not reach ready within ${budget.first}ms: ${JSON.stringify(evidence)}`)
          }
          await Bun.sleep(pollMs)
        }
      } finally {
        client.clear()
      }
    }

    try {
      await direct(runtime.client.remote.enroll({ relayOrigin: relay.origin, enrollmentID: "usage-performance", code: "ABCD-EFGH-JKLM-NPQR-STUV", name: "Usage performance fixture" }), "remote.enroll")
      await direct(runtime.client.remote.set({ enabled: true }), "remote.set")
      await waitUntil(async () => {
        const status = await direct(runtime.client.remote.get(), "remote.get")
        if (status.state === "error") throw new Error("Native connector entered an error state")
        return status.state === "on"
      }, budget.first, "Native connector")
      transport.connect()
      await waitUntil(() => transport.status().kind === "open", budget.first, "Web v5 transport")

      const producerStart = performance.now()
      const producerOptions = { signal: AbortSignal.timeout(producerBudget) }
      let accounting: Record<string, string> | undefined
      try {
        for (;;) {
          const [summary, daily, monthly, breakdown] = await Promise.all([
            prepared(runtime.client.usage.get(producerOptions), "usage.get"),
            prepared(runtime.client.usage.report(inputs.daily, producerOptions), "usage.report daily"),
            prepared(runtime.client.usage.report(inputs.monthly, producerOptions), "usage.report monthly"),
            prepared(runtime.client.usage.report(inputs.breakdown, producerOptions), "usage.report breakdown"),
          ])
          accounting = { summary: summary.status, daily: daily.status, monthly: monthly.status, breakdown: breakdown.status }
          if (Object.values(accounting).every((status) => status === "ready")) break
          if (performance.now() - producerStart + localPollMs >= producerBudget) throw new Error("Accounting presentations remained unavailable")
          await Bun.sleep(localPollMs)
        }
      } catch (cause) {
        const evidence = { seedMs: fixture.seedMs, serverStartMs, producerMs: round(performance.now() - producerStart), waitAborted: producerOptions.signal.aborted, accounting }
        throw new Error(`Usage producer did not settle: ${JSON.stringify(evidence)}`, { cause })
      }
      const producerMs = round(performance.now() - producerStart)

      const locationBootStart = performance.now()
      await direct(runtime.client.project.current(), "project.current")
      const locationBootMs = round(performance.now() - locationBootStart)

      const coldStart = performance.now()
      const coldOptions = { signal: AbortSignal.timeout(budget.first) }
      const coldTimings: { elapsedMs: number; dashboard: RemoteUsageDashboard["status"]; quota?: string }[] = []
      const readColdQuota = async () => {
        const started = performance.now()
        try {
          const value = await runtime.client.usage.dashboard(inputs, coldOptions)
          coldTimings.push({ elapsedMs: round(performance.now() - coldStart), dashboard: value.status,
            ...(value.status === "ready" ? { quota: value.quota.status } : {}) })
          return value
        } catch (cause) {
          const evidence = { seedMs: fixture.seedMs, serverStartMs, producerMs, locationBootMs, coldTimings,
            requestStartedMs: round(started - coldStart), elapsedMs: round(performance.now() - coldStart), aborted: coldOptions.signal.aborted }
          throw new Error(`cold machine usage.dashboard: ${failureCode(cause)} ${JSON.stringify(evidence)}`, { cause })
        }
      }
      let settled = await readColdQuota()
      const localMs = performance.now() - coldStart
      expect({ status: settled.status, quota: settled.status === "ready" ? settled.quota.status : undefined, over: localMs > budget.cold }).toEqual({ status: "ready", quota: "preparing", over: false })
      await waitUntil(async () => {
        settled = await readColdQuota()
        return settled.status === "ready" && settled.quota.status !== "preparing"
      }, budget.first, "Default machine dashboard quota")
      const cold = { localMs, settlementMs: performance.now() - coldStart, settledQuota: settled.status === "ready" ? settled.quota.status : settled.status }

      const first = await readRound("first")
      const warm1 = await readRound("warm1")
      const warm2 = await readRound("warm2")

      const directStarted = performance.now()
      const local = await direct(runtime.client.usage.dashboard(inputs), "usage.dashboard")
      const serverDirectWarmMs = performance.now() - directStarted
      const everything = usageReportInputs(now, undefined, { group: "model", offset: 0, sort: "cost", order: "desc", range: "all" }).breakdown
      const reportOptions = { signal: AbortSignal.timeout(producerBudget) }
      let allTime = await prepared(runtime.client.usage.report(everything, reportOptions), "usage.report all time")
      await waitUntil(async () => {
        if (allTime.status === "ready") return true
        allTime = await prepared(runtime.client.usage.report(everything, reportOptions), "usage.report all time")
        return allTime.status === "ready"
      }, producerBudget, "All-time Usage report")
      if (allTime.status !== "ready") throw new Error(`usage.report all time: ${allTime.status}`)
      const total = allTime.value.total
      const summary = await direct(runtime.client.usage.get(), "usage.get")

      const evidence = ({ info, ...timing }: typeof first) => ({ ...timing, quota: info.quota.status })
      console.log(`usage-dashboard-performance ${JSON.stringify({
        seedMs: fixture.seedMs, serverStartMs, producerMs, locationBootMs, serverDirectWarmMs, cold, rows, locations, unpricedLocations,
        pricing: { recordedRequests, recordedCost, catalogPricedRequests, catalogCost, decisionUnpriced, costCoverage, expectedCost, observed: { logical: total.logical, costCoverage: total.costCoverage, cost: total.cost, costProvenance: total.costProvenance, summaryCost: summary.cost } },
        first: evidence(first), warm1: evidence(warm1), warm2: evidence(warm2),
      })}`)
      expect(relay.failures).toEqual([])
      expect(local.status).toBe("ready")
      expect({ logical: total.logical, costCoverage: total.costCoverage, costProvenance: total.costProvenance }).toEqual({ logical: rows, costCoverage, costProvenance: "current_catalog" })
      near(total.cost, expectedCost)
      expect(summary.logical).toBe(rows)
      near(summary.cost, expectedCost)

      for (const [name, value, limit] of [["first", first, budget.first], ["warm1", warm1, budget.warm], ["warm2", warm2, budget.warm]] as const) {
        const attempts = value.attempts.map((attempt) => attempt.status)
        expect({ name, over: value.ms > limit }).toEqual({ name, over: false })
        if (name === "first") expect(attempts.slice(0, -1).every((status) => status === "preparing")).toBe(true)
        if (name === "warm1" || name === "warm2") expect(attempts).toEqual(["ready"])
        expect(value.transport.map((timing) => `${timing.operation}:${timing.outcome}`)).toEqual(attempts.map(() => "usage.dashboard:ok"))
        expect(value.connector.map((span) => span.outcome)).toEqual(attempts.map(() => "success"))
        expect({ name, over: value.connector.filter((span) => span.ms > budget.local).map((span) => round(span.ms)) }).toEqual({ name, over: [] })
        const info = value.info
        expect(info.summary.logical).toBe(rows)
        near(info.summary.cost, expectedCost)
        expect({ daily: info.daily?.group, monthly: info.monthly?.group, breakdown: info.breakdown?.group }).toEqual({ daily: inputs.daily.group, monthly: inputs.monthly.group, breakdown: inputs.breakdown.group })
        if (info.quota.status === "ready") expect(info.quota.forecast.localScope).toBe("backend")
        expect(info.asOf).toBeGreaterThan(0)
      }
    } finally {
      transport.close()
      try {
        await runtime.close()
      } finally {
        await relay.close()
      }
    }
  } finally {
    await fixture.remove()
  }
}, { timeout: 900_000 })
