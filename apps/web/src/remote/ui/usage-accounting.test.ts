import { expect, test } from "bun:test"
import { consumptionNeedsProfile, consumptionRow, costCoverage, costText, forecastDetails, forecastStatus, measuredSpeedLines, providerProvenanceLines, residentUnitCosts, unitCostLines, type UnitCostPresentation } from "./usage-accounting"

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
  expect(measuredSpeedLines({ generationSamples: 4, providerTimedSamples: 1, observedSamples: 3, samples: 2, meanTokensPerSecond: 27.5, generationP95TokensPerSecond: 61, firstOutputP50Ms: 300, firstOutputP95Ms: 1200, firstOutputP99Ms: 2500, totalP95Ms: 9000 }).slice(3)).toEqual([
    "Mean of per-request rates 27.5 tok/s · p95 61 tok/s",
    "First output p50 300 ms · p95 1.2 s · p99 2.5 s",
    "Total request p50 unreported · p95 9 s · p99 unreported",
  ])
  expect(measuredSpeedLines(undefined)).toHaveLength(3)
  expect(measuredSpeedLines(undefined)[0]).toContain("median unreported · p90 unreported")
  expect(measuredSpeedLines(undefined)[1]).toBe("Generation sample coverage unreported")
})

const cold = { state: "insufficient" as const, unit: "percent", evidence: "insufficient" as const, updatedAt: 0, reason: "Warming up after restart" }
const estimated = { ...cold, state: "estimated" as const, method: "quota-delta-ema" as const, evidence: "medium" as const, ratePerHour: 10.25, projectedUsedAtReset: 60, observedFrom: 0, observedTo: 600_000, updatedAt: 600_000, reason: undefined }

test("the default forecast status is one concise line that names the state, never the diagnostics", () => {
  expect(forecastStatus(cold, 0)).toBe("Forecast unavailable")
  expect(forecastStatus({ ...cold, reason: "No increase observed" }, 0)).toBe("No increase observed")
  expect(forecastStatus({ ...cold, reason: "Quota observations are stale" }, 0)).toBe("Forecast stale")
  expect(forecastStatus({ ...cold, reason: "Quota window has expired" }, 0)).toBe("Forecast expired")
  expect(forecastStatus({ ...cold, reason: "Quota observations are stale and the window has expired" }, 0)).toBe("Forecast expired")
  expect(forecastStatus({ ...cold, state: "unlimited", reason: undefined }, 0)).toBe("Unlimited")
  expect(forecastStatus({ ...cold, state: "exhausted", reason: undefined }, 0)).toBe("Exhausted")
  expect(forecastStatus({ ...cold, reason: undefined }, 0)).toBe("Forecast unavailable")
})

test("an estimated status leads with the run-out, else the projection, else the burn, plus its evidence level", () => {
  expect(forecastStatus({ ...estimated, exhaustionAt: 600_000 }, 700_000)).toBe("Estimated · run-out now · medium evidence")
  expect(forecastStatus({ ...estimated, exhaustionAt: 500_000 }, 700_000)).toBe("Estimated · run-out now · medium evidence")
  expect(forecastStatus({ ...estimated, evidence: "low", exhaustionAt: 3_660_000 }, 700_000)).toBe("Estimated · run-out 1970-01-01 01:01 UTC · low evidence")
  expect(forecastStatus(estimated, 700_000)).toBe("Estimated · projected 60 percentage points at reset · medium evidence")
  expect(forecastStatus({ ...estimated, projectedUsedAtReset: undefined }, 700_000)).toBe("Estimated · 10.3 percentage points/hour burn · medium evidence")
  expect(forecastStatus({ ...estimated, projectedUsedAtReset: undefined, ratePerHour: undefined }, 700_000)).toBe("Estimated · medium evidence")
  expect(forecastStatus({ ...estimated, ratePerHour: 0, projectedUsedAtReset: 40 }, 700_000)).toBe("No increase observed")
  expect(forecastStatus({ ...estimated, ratePerHour: 0, exhaustionAt: 3_660_000 }, 700_000)).toBe("Estimated · run-out 1970-01-01 01:01 UTC · medium evidence")
  const text = forecastStatus({ ...estimated, exhaustionAt: 600_000 }, 700_000)
  for (const hidden of ["half-life", "Observed", "Updated", "quota-delta", "1970-01-01T"]) expect(text).not.toContain(hidden)
})

test("forecast details keep exact native-unit values, method, observation interval, exact freshness and the raw reason", () => {
  expect(forecastDetails(cold, 120_000)).toEqual(["No supported method · insufficient evidence", "Updated 1970-01-01T00:00:00.000Z (2m ago)", "Reason: Warming up after restart"])
  const lines = forecastDetails({ ...estimated, exhaustionAt: 600_000 }, 700_000, 600_000)
  expect(lines).toContain("Quota burn 10.25 percentage points/hour")
  expect(lines).toContain("Projected at reset 60 percentage points")
  expect(lines).toContain("Estimated exhaustion now")
  expect(lines).toContain("Recent quota deltas · 15m half-life · 1h horizon · medium evidence")
  expect(lines).toContain("Observed 1970-01-01T00:00:00.000Z – 1970-01-01T00:10:00.000Z")
  expect(lines).toContain("Updated 1970-01-01T00:10:00.000Z (1m ago)")
  expect(forecastDetails({ ...estimated, exhaustionAt: 600_001 }, 700_000, 600_000)).toContain("Estimated exhaustion 1970-01-01T00:10:00.001Z")
  expect(forecastDetails({ ...estimated, unit: "usd", ratePerHour: 0.00123 }, 700_000)).toContain("Quota burn $0.00123/hour")
})

test("provider provenance keeps source, stability and the exact update time for the accessible details", () => {
  expect(providerProvenanceLines({ source: "provider_api", stability: "best_effort", updatedAt: 0 })).toEqual(["Source provider API · stability best effort", "Updated 1970-01-01T00:00:00.000Z"])
})

const rate = { providerID: "openai", profile: "Personal", modelID: "gpt-6-sol", observedFrom: 0, observedTo: 3_600_000, tokensPerMinute: 12_345.678, tokensPerMinute5: 15_000.25, tokensPerMinute60: 9_876.5, estimatedUSDPerHour: 1.23456, coverage: { pricedRequests: 40, unpricedRequests: 0 } }

test("a recorded consumption row aligns provider, model and profile with a whole compact token rate and an estimated cost rate", () => {
  expect(consumptionRow(rate)).toMatchObject({ identity: "openai · gpt-6-sol · profile Personal", tokens: "12.3k tokens/min", cost: "$1.23/hour est." })
  expect(consumptionRow({ ...rate, profile: undefined, modelID: undefined }).identity).toBe("openai · default profile")
  expect(consumptionRow({ ...rate, tokensPerMinute: 842.4 }).tokens).toBe("842 tokens/min")
  expect(consumptionRow({ ...rate, tokensPerMinute: 0.4 }).tokens).toBe("<1 tokens/min")
  expect(consumptionRow({ ...rate, tokensPerMinute: 0 }).tokens).toBe("0 tokens/min")
  expect(consumptionRow({ ...rate, tokensPerMinute: 2_500_000 }).tokens).toBe("2.5m tokens/min")
})

test("a recorded consumption row never turns a missing or partial cost rate into a complete zero", () => {
  expect(consumptionRow({ ...rate, estimatedUSDPerHour: undefined }).cost).toBe("cost rate unreported")
  expect(consumptionRow({ ...rate, estimatedUSDPerHour: 0 }).cost).toBe("$0.00/hour est.")
  expect(consumptionRow({ ...rate, coverage: { pricedRequests: 3, unpricedRequests: 2 } }).cost).toBe("Known $1.23/hour est. + unreported")
})

test("recorded consumption details keep exact rates, windows, coverage, observation interval and profile default", () => {
  const lines = consumptionRow(rate).details
  expect(lines).toContain("Rate 12,345.678 tokens/min")
  expect(lines).toContain("5m 15,000.25 tokens/min · 60m 9,876.5 tokens/min")
  expect(lines).toContain("Estimated cost rate $1.23456/hour")
  expect(lines).toContain("40 priced · 0 unpriced")
  expect(lines).toContain("Observed 1970-01-01T00:00:00.000Z – 1970-01-01T01:00:00.000Z")
  const sparse = consumptionRow({ ...rate, profile: undefined, tokensPerMinute5: undefined, tokensPerMinute60: undefined, estimatedUSDPerHour: undefined, coverage: { pricedRequests: 0, unpricedRequests: 7 } }).details
  expect(sparse).toContain("5m unreported · 60m unreported")
  expect(sparse).toContain("Estimated cost rate unreported")
  expect(sparse).toContain("Profile provider default at request time")
  expect(sparse).toContain("0 priced · 7 unpriced")
})

test("a recorded consumption row exposes provider, model and profile separately and asks for the profile only when rows would otherwise look identical", () => {
  expect(consumptionRow(rate).parts).toEqual({ provider: "openai", model: "gpt-6-sol", profile: "profile Personal" })
  expect(consumptionRow({ ...rate, profile: undefined }).parts.profile).toBe("default profile")
  const other = { ...rate, profile: "Work" }
  expect(consumptionNeedsProfile([rate, other], rate)).toBe(true)
  expect(consumptionNeedsProfile([rate, { ...rate, providerID: "anthropic" }], rate)).toBe(false)
  expect(consumptionNeedsProfile([rate], rate)).toBe(false)
})
