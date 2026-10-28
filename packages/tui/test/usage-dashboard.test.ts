import { expect, test } from "bun:test"
import type { UsageDashboardInput, UsageDashboardOutput, UsageReportOutput } from "@ycoding-ai/client"
import { readBreakdown, readStats } from "../src/routes/session/usage-dashboard"

type Ready = Extract<UsageDashboardOutput, { status: "ready" }>
type Slots = Partial<Pick<Ready, "daily" | "monthly" | "breakdown">>

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
