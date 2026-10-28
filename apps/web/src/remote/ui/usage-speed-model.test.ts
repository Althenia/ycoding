import { expect, test } from "bun:test"
import {
  chartHeight, chartMax, chartWidth, dailyScopeLabel, dashboardBusy, fastestModels, generationFigures, latencyLabel, liveHistory, liveModels, liveRate, lineSegments, modelSpeedRows, rateLabel, speedCells, stackedBars, trendDays,
  type UsageLive,
} from "./usage-speed-model"
import type { UsageReport } from "./usage-model"

const tokens = { input: 1000, output: 400, reasoning: 50, cache: { read: 300, write: 20 } }
const speed = (overrides: Record<string, number> = {}) => ({
  samples: 3, generationSamples: 4, providerTimedSamples: 2, observedSamples: 2, meanTokensPerSecond: 40, outputTokensPerSecond: 36, firstOutputP50Ms: 300, firstOutputP95Ms: 1200, ...overrides,
})
const metrics = { logical: 5, physical: 6, helpers: 0, continued: 0, fallback: 0, tokens }
const live = (overrides: Partial<UsageLive> = {}): UsageLive => ({ asOf: 100_000, active: 0, streaming: 0, models: [], history: [], ...overrides })
const model = (key: string, extra: Record<string, unknown> = {}) => ({ key, label: key, ...metrics, model: { providerID: key.split("/")[0]!, id: key.split("/")[1]! }, ...extra })
const report = (rows: unknown[], total: Record<string, unknown> = {}, overall?: Record<string, unknown>) =>
  ({ group: "model", rows, total: { ...metrics, ...total }, rowCount: rows.length, ...(overall === undefined ? {} : { speed: overall }) }) as unknown as UsageReport

test("rates and latencies keep unmeasurable values distinct from zero and mark estimates", () => {
  expect(rateLabel(undefined)).toBe("N/A")
  expect(rateLabel(0)).toBe("0 tok/s")
  expect(rateLabel(42.46)).toBe("42.5 tok/s")
  expect(rateLabel(1234.6, true)).toBe("≈ 1,235 tok/s")
  expect(latencyLabel(undefined)).toBe("N/A")
  expect(latencyLabel(850)).toBe("850 ms")
  expect(latencyLabel(1250)).toBe("1.3 s")
})

test("aggregate live output reads Idle, Waiting, Measuring, or an estimated rate", () => {
  expect(liveRate({ active: 0, streaming: 0 })).toBe("Idle")
  expect(liveRate({ active: 2, streaming: 0 })).toBe("Waiting")
  expect(liveRate({ active: 2, streaming: 1 })).toBe("Measuring")
  expect(liveRate({ active: 2, streaming: 1, outputTokensPerSecond: 48.2 })).toBe("≈ 48.2 tok/s")
  expect(liveRate({ active: 0, streaming: 0, outputTokensPerSecond: 12 })).toBe("Idle")
})

test("live history is labelled relative to its own snapshot and active models list only running work", () => {
  const snapshot = live({
    active: 3, streaming: 1, outputTokensPerSecond: 10,
    history: [{ at: 40_000, active: 1 }, { at: 95_000, active: 2, outputTokensPerSecond: 8 }, { at: 100_000, active: 3, outputTokensPerSecond: 10 }],
    models: [
      { model: { providerID: "openai", id: "gpt-6-sol" }, active: 1, streaming: 0 },
      { model: { providerID: "anthropic", id: "claude-opus", variant: "high" }, active: 2, streaming: 1, outputTokensPerSecond: 30 },
      { model: { providerID: "openai", id: "idle" }, active: 0, streaming: 0 },
    ],
  })
  expect(liveHistory(snapshot).map((point) => [point.label, point.rate])).toEqual([["1m ago", undefined], ["5s ago", 8], ["now", 10]])
  expect(liveModels(snapshot).map((entry) => [entry.provider, entry.model, entry.rate])).toEqual([
    ["anthropic", "claude-opus · selected effort high", "≈ 30 tok/s"],
    ["openai", "gpt-6-sol", "Waiting"],
  ])
})

test("overview figures label estimates, averages, percentiles, and unreported values", () => {
  const monthly = report([model("openai/a", { physical: 10 })], {
    physical: 16, cost: 3.5, costProvenance: "current_catalog", costCoverage: { pricedRequests: 16, unpricedRequests: 0 }, cacheReadReported: true, outcomes: { completed: 12, failed: 3, cancelled: 1 },
  }, speed({ generationSamples: 4, meanTokensPerSecond: 40, firstOutputP50Ms: 300, firstOutputP95Ms: 2400 }))
  const figures = new Map(generationFigures(live({ active: 2, streaming: 1, outputTokensPerSecond: 44 }), monthly).map((figure) => [figure.id, figure]))
  expect(figures.get("active")).toMatchObject({ value: "2", note: "1 streaming now" })
  expect(figures.get("live")!.value).toBe("≈ 44 tok/s")
  expect(figures.get("live")!.note).toContain("estimated")
  expect(figures.get("average")).toMatchObject({ value: "40 tok/s", note: "Mean of 4 per-request rates this month" })
  expect(figures.get("ttft")).toMatchObject({ value: "p50 300 ms · p95 2.4 s", note: "Percentiles of this month's requests" })
  expect(figures.get("requests")!.value).toBe("16")
  expect(figures.get("tokens")!.value).toBe("1,000 in · 400 out")
  expect(figures.get("cache")).toMatchObject({ value: "300 read", note: "20 written" })
  expect(figures.get("cost")).toMatchObject({ value: "$3.50", note: "Estimate at current catalog prices" })
  expect(figures.get("outcomes")).toMatchObject({ value: "12 completed · 3 failed · 1 cancelled", note: "18.8% failed" })
})

test("absent speed, outcomes, cache, and totals stay N/A or unreported, never zero", () => {
  const bare = new Map(generationFigures(live(), report([model("openai/a")])).map((figure) => [figure.id, figure]))
  expect(bare.get("average")).toMatchObject({ value: "N/A", note: "No measurable requests this month" })
  expect(bare.get("ttft")).toMatchObject({ value: "N/A", note: "No first-output samples this month" })
  expect(bare.get("outcomes")).toMatchObject({ value: "unreported", note: "No outcome data recorded" })
  expect(bare.get("live")!.value).toBe("Idle")
  expect(bare.get("cache")!.value).toBe("300 read")
  expect(generationFigures(live(), report([], { tokens: { ...tokens, cache: { read: 0, write: 0 } } })).find((figure) => figure.id === "cache")!.value).toBe("unreported read")
  expect(generationFigures(live(), report([], { cacheReadReported: true, tokens: { ...tokens, cache: { read: 0, write: 0 } } })).find((figure) => figure.id === "cache")!.value).toBe("0 read")
  expect(generationFigures(live(), report([], {}, speed({ generationSamples: 0 }))).find((figure) => figure.id === "average")!.value).toBe("N/A")
  expect(generationFigures(live(), report([], {}, { samples: 0, generationSamples: 0, providerTimedSamples: 0, observedSamples: 0, firstOutputP95Ms: 900 })).find((figure) => figure.id === "ttft")!.value).toBe("p50 N/A · p95 900 ms")
  const missing = new Map(generationFigures(live(), undefined).map((figure) => [figure.id, figure.value]))
  expect(["requests", "tokens", "cache", "cost", "outcomes"].map((id) => missing.get(id))).toEqual(["unreported", "unreported", "unreported", "unreported", "unreported"])
})

test("the daily scope names the provider and model selection, and is absent when nothing is selected", () => {
  expect(dailyScopeLabel("", "")).toBeUndefined()
  expect(dailyScopeLabel("openai", "", "Codex")).toBe("Provider Codex")
  expect(dailyScopeLabel("openai", "gpt-6-sol")).toBe("Provider openai · Model gpt-6-sol")
  expect(dailyScopeLabel("", "gpt-6-sol")).toBe("Model gpt-6-sol")
})

test("daily trends carry outcomes, percentiles, throughput, and concurrency with gaps for unmeasured days", () => {
  const now = Date.UTC(2026, 9, 28, 12)
  const today = "2026-10-28"
  const daily = { group: "day", rows: [
    { key: today, label: today, ...metrics, physical: 9, outcomes: { completed: 6, failed: 2, cancelled: 0 }, concurrency: 1.5, speed: speed({ totalP50Ms: 4000, totalP95Ms: 9000 }) },
    { key: "2026-10-27", label: "2026-10-27", ...metrics, physical: 3 },
  ], total: metrics, rowCount: 2 } as unknown as UsageReport
  const days = trendDays(daily, now)
  expect(days).toHaveLength(30)
  expect(days.at(-1)).toMatchObject({ key: today, requests: 9, errorRate: 25, ttftP50: 300, ttftP95: 1200, totalP95: 9000, rate: 36, concurrency: 1.5, cacheRead: 300 })
  expect(days.at(-2)).toMatchObject({ requests: 3, input: 1000 })
  expect(days.at(-2)!.errorRate).toBeUndefined()
  expect(days.at(-2)!.ttftP95).toBeUndefined()
  expect(days[0]).toMatchObject({ requests: 0, input: 0 })
})

test("chart geometry breaks lines at gaps, stacks bars, and scales by the largest value", () => {
  expect(chartMax([[1, undefined, 4], [2]], false)).toBe(4)
  expect(chartMax([[1, 2], [3, 1]], true)).toBe(4)
  expect(chartMax([[undefined], [0]], false)).toBe(1)
  const segments = lineSegments([2, 4, undefined, 1], 4)
  expect(segments.map((segment) => segment.length)).toEqual([2, 1])
  expect(segments[0]![1]).toEqual({ x: chartWidth / 3, y: 0 })
  expect(segments[1]![0]!.y).toBe(chartHeight - chartHeight / 4)
  expect(lineSegments([5], 5)[0]![0]).toEqual({ x: chartWidth / 2, y: 0 })
  expect(lineSegments([undefined, undefined], 1)).toEqual([])
  const bars = stackedBars([[1, 2], [1, 0]], 4)
  expect(bars[0]![1]).toMatchObject({ y: chartHeight - chartHeight / 2, height: chartHeight / 2 })
  expect(bars[1]![0]!.y).toBe(chartHeight - chartHeight / 4 - chartHeight / 4)
  expect(bars[1]![1]!.height).toBe(0)
})

test("model speed comparison ranks by mean per-request rate and leaves unmeasurable models out of the chart", () => {
  const monthly = report([
    model("openai/slow", { speed: speed({ meanTokensPerSecond: 20 }) }),
    model("anthropic/fast", { speed: speed({ meanTokensPerSecond: 80, firstOutputP95Ms: 500 }) }),
    model("local/silent"),
  ])
  const rows = modelSpeedRows(monthly, [{ providerID: "anthropic", label: "Claude" }])
  expect(rows.map((row) => [row.provider, row.mean, row.aggregate, row.ttftP95])).toEqual([["openai", 20, 36, 1200], ["Claude", 80, 36, 500], ["local", undefined, undefined, undefined]])
  expect(fastestModels(rows).map((row) => row.key)).toEqual(["anthropic/fast", "openai/slow"])
  expect(fastestModels(rows, 1)).toHaveLength(1)
})

test("breakdown speed cells show N/A for unmeasurable rows instead of zero", () => {
  expect(speedCells(undefined)).toEqual({ average: "N/A", aggregate: "N/A", ttft: "N/A" })
  expect(speedCells(speed() as never)).toEqual({ average: "40 tok/s", aggregate: "36 tok/s", ttft: "1.2 s" })
})

test("live polling refreshes stay quiet while explicit and report-changing refreshes stay busy", () => {
  const idle = { live: live() }
  const active = { live: live({ active: 1 }) }
  expect(dashboardBusy({ kind: "loading" }, false)).toBe(true)
  expect(dashboardBusy({ kind: "preparing" }, false)).toBe(true)
  expect(dashboardBusy({ kind: "idle" }, false)).toBe(false)
  expect(dashboardBusy({ kind: "ready", refreshing: false, stale: false, info: active }, true)).toBe(false)
  expect(dashboardBusy({ kind: "ready", refreshing: true, stale: false, info: active }, false)).toBe(false)
  expect(dashboardBusy({ kind: "ready", refreshing: true, stale: false, info: active }, true)).toBe(true)
  expect(dashboardBusy({ kind: "ready", refreshing: true, stale: true, info: active }, false)).toBe(true)
  expect(dashboardBusy({ kind: "ready", refreshing: true, stale: false, info: idle }, false)).toBe(true)
})
