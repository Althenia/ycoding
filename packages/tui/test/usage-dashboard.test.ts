import { expect, test } from "bun:test"
import type { UsageDashboardInput, UsageDashboardOutput, UsageReportOutput } from "@ycoding-ai/client"
import { createUsageLivePoll, readBreakdown, readStats, USAGE_LIVE_POLL_MS, type UsageLive } from "../src/routes/session/usage-dashboard"

type Ready = Extract<UsageDashboardOutput, { status: "ready" }>
type Slots = Partial<Pick<Ready, "daily" | "monthly" | "breakdown" | "live">>

const tokens = { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }
const metrics = { logical: 1, physical: 1, helpers: 0, continued: 0, fallback: 0, tokens }
const report = (group: UsageReportOutput["group"], keys: string[], extra: { rowCount?: number; nextOffset?: number } = {}): UsageReportOutput => ({
  group,
  rows: keys.map((key) => ({ key, label: key, ...metrics })),
  total: metrics,
  rowCount: extra.rowCount ?? keys.length,
  ...(extra.nextOffset === undefined ? {} : { nextOffset: extra.nextOffset }),
})
const ready = (slots: Slots): Ready => ({
  status: "ready",
  asOf: 1,
  revision: "r1",
  summary: metrics,
  quota: { status: "ready", providers: [], forecast: { asOf: 1, localScope: "backend" } },
  live: { asOf: 1, active: 0, streaming: 0, models: [], history: [] },
  ...slots,
})

test("a report view sends one composed read carrying only its own recipe", async () => {
  const inputs: UsageDashboardInput[] = []
  const query = { group: "session" as const, offset: 25, limit: 100, sort: "tokens" as const, order: "desc" as const, providerID: "openai" }
  const result = await readBreakdown(async (input) => {
    inputs.push(input)
    return ready({ breakdown: report("session", ["b"]) })
  }, query)
  expect(inputs).toEqual([{ breakdown: query }])
  expect("rows" in result && result.rows.map((row) => row.key)).toEqual(["b"])
})

test("Preparing, failure, and an omitted requested slot never become a ready report", async () => {
  await expect(readBreakdown(async () => ({ status: "preparing" }), { group: "model" })).resolves.toEqual({ status: "preparing" })
  await expect(readBreakdown(async () => ({ status: "error", message: "Prepared read failed" }), { group: "model" })).rejects.toThrow("Prepared read failed")
  await expect(readBreakdown(async () => ready({}), { group: "model" })).rejects.toThrow("omitted the requested breakdown")
})

const statsQuery = { group: "day" as const, from: 10, to: 20, offset: 0, limit: 200, sort: "key" as const, order: "asc" as const }
const statsHead = (nextOffset?: number) =>
  ready({
    daily: report("day", ["d0"], { nextOffset }),
    monthly: report("model", ["Favorite"]),
    breakdown: report("session", [], { rowCount: 7 }),
  })

test("Stats sends its three slots once and derives the graph, favorite model, and Session count", async () => {
  const inputs: UsageDashboardInput[] = []
  const result = await readStats(async (input) => {
    inputs.push(input)
    return statsHead()
  }, statsQuery)
  expect(inputs).toHaveLength(1)
  expect(inputs[0]!.daily).toEqual(statsQuery)
  expect(inputs[0]!.monthly).toMatchObject({ group: "model", from: 10, to: 20, limit: 1, sort: "tokens", order: "desc" })
  expect(inputs[0]!.breakdown).toMatchObject({ group: "session", from: 10, to: 20, limit: 1, offset: 0 })
  expect(result).toMatchObject({ stats: { favoriteModel: "Favorite", sessions: 7 } })
})

test("Stats follows every day cursor until none remains and asks later pages for the daily slot only", async () => {
  const inputs: UsageDashboardInput[] = []
  const cursors = [200, 400, 600]
  const result = await readStats(async (input) => {
    inputs.push(input)
    const offset = input.daily?.offset ?? 0
    if (offset === 0) return statsHead(200)
    const index = cursors.indexOf(offset)
    return ready({ daily: report("day", [`d${offset}`], { nextOffset: cursors[index + 1] }) })
  }, statsQuery)
  expect(inputs.map((input) => input.daily?.offset ?? 0)).toEqual([0, 200, 400, 600])
  expect(inputs.slice(1).every((input) => input.monthly === undefined && input.breakdown === undefined)).toBe(true)
  expect("report" in result && result.report.rows.map((row) => row.key)).toEqual(["d0", "d200", "d400", "d600"])
  expect("report" in result && result.report.nextOffset).toBeUndefined()
})

test("Preparing, failure, or an omitted slot on any later page yields no partial Stats", async () => {
  const page = (outcome: UsageDashboardOutput | "omitted") => async (input: UsageDashboardInput) => {
    if ((input.daily?.offset ?? 0) === 0) return statsHead(200)
    return outcome === "omitted" ? ready({}) : outcome
  }
  await expect(readStats(page({ status: "preparing" }), statsQuery)).resolves.toEqual({ status: "preparing" })
  await expect(readStats(page({ status: "error", message: "Later page failed" }), statsQuery)).rejects.toThrow("Later page failed")
  await expect(readStats(page("omitted"), statsQuery)).rejects.toThrow("omitted the requested daily")
  await expect(readStats(async () => ready({ daily: report("day", []) }), statsQuery)).rejects.toThrow("omitted the requested monthly")
})

test("Stats returns Preparing instead of mixing pages prepared from different accounting revisions", async () => {
  const inputs: UsageDashboardInput[] = []
  const result = await readStats(async (input) => {
    inputs.push(input)
    const offset = input.daily?.offset ?? 0
    if (offset === 0) return statsHead(200)
    return { ...ready({ daily: report("day", ["later"], { nextOffset: 400 }) }), revision: "r2" }
  }, statsQuery)
  expect(result).toEqual({ status: "preparing" })
  expect(inputs.map((input) => input.daily?.offset ?? 0)).toEqual([0, 200])
})

const liveAt = (asOf: number, active: number): UsageLive => ({ asOf, active, streaming: 0, models: [], history: [] })

function pollHarness(responses: Array<UsageDashboardOutput | Error>) {
  const delays: number[] = []
  const entries: Array<{ run: () => void; cancelled: boolean; fired: boolean }> = []
  const events: string[] = []
  const loads: UsageDashboardInput[] = []
  const poll = createUsageLivePoll({
    load: async (input) => {
      loads.push(input)
      const next = responses.shift()
      if (next === undefined) throw new Error("unexpected poll")
      if (next instanceof Error) throw next
      return next
    },
    onLive: (live) => events.push(`live:${live.asOf}:${live.active}`),
    onFailed: () => events.push("failed"),
    onPreparing: () => events.push("preparing"),
    schedule: (run, delayMs) => {
      const entry = { run, cancelled: false, fired: false }
      entries.push(entry)
      delays.push(delayMs)
      return () => { entry.cancelled = true }
    },
  })
  const pending = () => entries.filter((entry) => !entry.cancelled && !entry.fired)
  const fire = async () => {
    const entry = pending()[0]
    if (!entry) throw new Error("no poll scheduled")
    entry.fired = true
    entry.run()
    await Bun.sleep(0)
  }
  return { poll, events, loads, delays, pending, fire }
}

test("live polling starts only while attempts are active and stops once the backend is idle", async () => {
  const harness = pollHarness([ready({ live: liveAt(20, 1) }), ready({ live: liveAt(30, 0) })])
  harness.poll.accept(liveAt(10, 0))
  expect(harness.pending()).toHaveLength(0)
  harness.poll.accept(liveAt(15, 2))
  expect(harness.delays).toEqual([USAGE_LIVE_POLL_MS])
  await harness.fire()
  expect(harness.loads).toEqual([{}])
  expect(harness.events).toEqual(["live:10:0", "live:15:2", "live:20:1"])
  expect(harness.pending()).toHaveLength(1)
  await harness.fire()
  expect(harness.events.at(-1)).toBe("live:30:0")
  expect(harness.pending()).toHaveLength(0)
  expect(harness.loads).toHaveLength(2)
})

test("an older live snapshot is ignored and never replaces newer state or restarts the cadence", async () => {
  const harness = pollHarness([ready({ live: liveAt(5, 0) }), ready({ live: liveAt(40, 0) })])
  harness.poll.accept(liveAt(30, 3))
  await harness.fire()
  expect(harness.events).toEqual(["live:30:3"])
  expect(harness.pending()).toHaveLength(1)
  expect(harness.poll.accept(liveAt(10, 0))).toBe(false)
  expect(harness.events).toEqual(["live:30:3"])
  expect(harness.pending()).toHaveLength(1)
  await harness.fire()
  expect(harness.events).toEqual(["live:30:3", "live:40:0"])
  expect(harness.pending()).toHaveLength(0)
})

test("a newer accepted snapshot cancels the in-flight cadence and a late poll result is dropped", async () => {
  const gate = Promise.withResolvers<UsageDashboardOutput>()
  const events: string[] = []
  const queue: Array<() => void> = []
  const poll = createUsageLivePoll({
    load: () => gate.promise,
    onLive: (live) => events.push(`live:${live.asOf}`),
    onFailed: () => events.push("failed"),
    onPreparing: () => events.push("preparing"),
    schedule: (run) => {
      queue.push(run)
      return () => undefined
    },
  })
  poll.accept(liveAt(1, 1))
  queue.shift()!()
  poll.accept(liveAt(2, 1))
  gate.resolve(ready({ live: liveAt(3, 0) }))
  await Bun.sleep(0)
  expect(events).toEqual(["live:1", "live:2"])
})

test("Preparing hands off to a refresh and a failed poll stops without scheduling again", async () => {
  const preparing = pollHarness([{ status: "preparing" }])
  preparing.poll.accept(liveAt(1, 1))
  await preparing.fire()
  expect(preparing.events).toEqual(["live:1:1", "preparing"])
  expect(preparing.pending()).toHaveLength(0)

  const failing = pollHarness([new Error("offline")])
  failing.poll.accept(liveAt(1, 1))
  await failing.fire()
  expect(failing.events).toEqual(["live:1:1", "failed"])
  expect(failing.pending()).toHaveLength(0)

  const errored = pollHarness([{ status: "error", message: "Prepared read failed" }])
  errored.poll.accept(liveAt(1, 1))
  await errored.fire()
  expect(errored.events).toEqual(["live:1:1", "failed"])
  expect(errored.pending()).toHaveLength(0)
})

test("stopping cancels the scheduled poll", () => {
  const harness = pollHarness([])
  harness.poll.accept(liveAt(1, 1))
  expect(harness.pending()).toHaveLength(1)
  harness.poll.stop()
  expect(harness.pending()).toHaveLength(0)
})
