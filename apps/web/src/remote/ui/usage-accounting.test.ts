import { expect, test } from "bun:test"
import { costCoverage, costText, forecastLines, measuredSpeedLines, promptCostLine, residentUnitCosts, unitCostLines, type UnitCostPresentation } from "./usage-accounting"

const zero = { total: 0, known: 0, pricedRequests: 1, unpricedRequests: 0 }
const partial = { known: 0, pricedRequests: 1, unpricedRequests: 2 }
const unit: UnitCostPresentation = { inputID: "first", cost: partial, main: zero, children: partial, helpers: [{ label: "Decision", cost: zero }], settled: false, complete: false, reason: "Historical attribution is partial" }

test("cost completeness preserves explicit zero and never calls a missing price complete", () => {
  expect(costText(zero)).toBe("$0.00")
  expect(costText(partial)).toBe("Known $0.00 + unreported")
  expect(costText({ pricedRequests: 0, unpricedRequests: 2 })).toBe("unreported")
  expect(costText(undefined)).toBe("unreported")
  expect(costText({ total: 5, known: 3, pricedRequests: 1, unpricedRequests: 1 })).toBe("Known $3.00 + unreported")
  expect(costCoverage({ ...partial, provenance: "current_catalog" })).toBe("1 priced · 2 unpriced · current-catalog estimate")
})

test("prompt cost separates children and helpers and qualifies running and historical coverage", () => {
  expect(unitCostLines(unit)).toEqual(["Prompt cost Known $0.00 + unreported · so far · incomplete", "Main $0.00 · Children Known $0.00 + unreported", "Decision $0.00", "1 priced · 2 unpriced", "Historical attribution is partial"])
  expect(unitCostLines({ ...unit, settled: true, complete: true, cost: zero })[0]).toBe("Prompt cost $0.00")
  expect(unitCostLines(unit, "Task cost (inclusive)")[0]).toBe("Task cost (inclusive) Known $0.00 + unreported · so far · incomplete")
})

test("pruned and synthetic anchors never mount or transfer to a newer resident prompt", () => {
  const newer = { ...unit, inputID: "newer", cost: zero }
  const synthetic = { ...unit, inputID: "synthetic" }
  expect(residentUnitCosts([unit, newer, newer, synthetic], [{ id: "newer", role: "user" }, { id: "synthetic", role: "user", synthetic: true }])).toEqual([newer])
  expect(residentUnitCosts([unit], [{ id: "first", role: "assistant" }])).toEqual([])
})

test("measured request percentiles, timing coverage, throughput and latency populations stay distinct", () => {
  expect(measuredSpeedLines({ generationSamples: 4, generationP50TokensPerSecond: 20, generationP90TokensPerSecond: 50, providerTimedSamples: 1, observedSamples: 3, outputTokensPerSecond: 32, samples: 2 })).toEqual(["Measured generation median 20 tok/s · p90 50 tok/s", "4 measured requests · 1 provider-timed · 3 observed", "Weighted throughput 32 tok/s · 2 first-output latency samples"])
  expect(measuredSpeedLines(undefined)[0]).toContain("median unreported · p90 unreported")
  expect(measuredSpeedLines(undefined)[1]).toBe("Generation sample coverage unreported")
})

test("forecast states keep native units, method, freshness and unavailable reason without invented projections", () => {
  const cold = { state: "insufficient" as const, unit: "percent", evidence: "insufficient" as const, updatedAt: 0, reason: "Warming up after restart" }
  expect(forecastLines(cold, 120_000)).toEqual(["Forecast unavailable", "No supported method · insufficient evidence", "Updated 2m ago", "Warming up after restart"])
  expect(forecastLines({ ...cold, reason: "No increase observed" }, 0).join(" ")).not.toContain("Unlimited")
  const estimate = forecastLines({ ...cold, state: "estimated", method: "quota-delta-ema", evidence: "medium", ratePerHour: 10, projectedUsedAtReset: 60, observedFrom: 0, observedTo: 600_000, reason: undefined }, 600_000)
  expect(estimate).toContain("Quota burn 10 percentage points/hour")
  expect(estimate).toContain("Projected at reset 60 percentage points")
  expect(estimate).toContain("Recent quota deltas · 15m half-life · 1h horizon · medium evidence")
  expect(estimate.some((line) => line.startsWith("Observed "))).toBe(true)
  expect(forecastLines({ ...cold, state: "unlimited", reason: undefined }, 0)[0]).toBe("Unlimited")
  expect(forecastLines({ ...cold, state: "exhausted", reason: undefined }, 0)[0]).toBe("Exhausted")
})

test("a run-out time at or before the forecast was computed reads as now", () => {
  const quota = { state: "estimated" as const, unit: "percent", evidence: "medium" as const, method: "quota-delta-ema" as const, updatedAt: 600_000, ratePerHour: 10 }
  expect(forecastLines({ ...quota, exhaustionAt: 600_000 }, 700_000, 600_000)).toContain("Estimated exhaustion now")
  expect(forecastLines({ ...quota, exhaustionAt: 500_000 }, 700_000, 600_000)).toContain("Estimated exhaustion now")
  expect(forecastLines({ ...quota, exhaustionAt: 600_001 }, 700_000, 600_000)).toContain("Estimated exhaustion 1970-01-01T00:10:00.001Z")
})

test("only an admitted prompt shows a cost line, and an unread unit says loading or unreported", () => {
  expect(promptCostLine("pending", false, "ready")).toBeUndefined()
  expect(promptCostLine("pending", true, "ready")).toBeUndefined()
  expect(promptCostLine(undefined, false, "ready")).toBeUndefined()
  expect(promptCostLine("promoted", true, "ready")).toEqual({ kind: "unit" })
  expect(promptCostLine("consumed", false, "loading")).toEqual({ kind: "loading" })
  expect(promptCostLine("consumed", false, "unavailable")).toEqual({ kind: "unreported" })
  expect(promptCostLine("consumed", false, undefined)).toEqual({ kind: "unreported" })
})
