import { expect, test } from "bun:test"
import { costText, forecastLines, measuredSpeedLines, unitCostLines, type UnitCostPresentation } from "../src/util/usage-accounting"

const zero = { total: 0, known: 0, pricedRequests: 1, unpricedRequests: 0 }
const unit: UnitCostPresentation = { inputID: "first", cost: { known: 0, pricedRequests: 1, unpricedRequests: 2 }, main: zero, children: { pricedRequests: 0, unpricedRequests: 2 }, helpers: [{ label: "Decision", cost: zero }], settled: false, complete: false }

test("unknown and partially priced costs never become complete zero", () => {
  expect(costText(zero)).toBe("$0.00")
  expect(costText(unit.cost)).toBe("Known $0.00 + unreported")
  expect(costText(unit.children)).toBe("unreported")
  expect(costText(undefined)).toBe("unreported")
  expect(unitCostLines(unit)).toEqual(["Prompt cost Known $0.00 + unreported · so far · incomplete", "Main $0.00 · Children unreported", "Decision $0.00", "1 priced · 2 unpriced"])
  expect(unitCostLines(unit, "Task cost (inclusive)")[0]).toBe("Task cost (inclusive) Known $0.00 + unreported · so far · incomplete")
})

test("measured speed populations and insufficient quota evidence remain distinct", () => {
  expect(measuredSpeedLines({ generationSamples: 4, generationP50TokensPerSecond: 20, generationP90TokensPerSecond: 50, providerTimedSamples: 1, observedSamples: 3, outputTokensPerSecond: 32, samples: 2 })).toEqual(["Measured generation median 20.0 tok/s · p90 50.0 tok/s", "4 measured requests · 1 provider-timed · 3 observed", "Weighted throughput 32.0 tok/s · 2 first-output latency samples"])
  expect(measuredSpeedLines(undefined)[0]).toContain("median unreported · p90 unreported")
  expect(measuredSpeedLines(undefined)[1]).toBe("Generation sample coverage unreported")
  expect(forecastLines({ state: "insufficient", unit: "percent", evidence: "insufficient", updatedAt: 0, reason: "No increase observed" }, 120_000)).toEqual(["Forecast unavailable", "No supported method · insufficient evidence", "Updated 2m ago", "No increase observed"])
  expect(forecastLines({ state: "estimated", unit: "percent", method: "quota-delta-ema", evidence: "medium", updatedAt: 600_000, observedFrom: 0, observedTo: 600_000, ratePerHour: 10 }, 600_000)).toContain("Quota burn 10 percentage points/hour")
})
