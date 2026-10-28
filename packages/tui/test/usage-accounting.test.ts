import { expect, test } from "bun:test"
import { costText, errorRateText, forecastLines, forecastSummary, measuredSpeedLines, outcomeLine, recordedRateLines, recordedRateRow, unitCostLines, type ForecastPresentation, type UnitCostPresentation } from "../src/util/usage-accounting"

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
  expect(measuredSpeedLines({ generationSamples: 4, generationP50TokensPerSecond: 20, generationP90TokensPerSecond: 50, providerTimedSamples: 1, observedSamples: 3, outputTokensPerSecond: 32, samples: 2 })).toEqual(["Measured generation median 20.0 tok/s · p90 50.0 tok/s", "4 measured requests · 1 provider-timed · 3 observed", "Aggregate throughput 32.0 tok/s · mean per request unreported · 2 first-output latency samples"])
  expect(measuredSpeedLines({ generationSamples: 4, generationP50TokensPerSecond: 20, generationP90TokensPerSecond: 50, generationP95TokensPerSecond: 60, meanTokensPerSecond: 28.5, providerTimedSamples: 1, observedSamples: 3, outputTokensPerSecond: 32, samples: 2 })).toEqual(["Measured generation median 20.0 tok/s · p90 50.0 tok/s · p95 60.0 tok/s", "4 measured requests · 1 provider-timed · 3 observed", "Aggregate throughput 32.0 tok/s · mean per request 28.5 tok/s · 2 first-output latency samples"])
  expect(measuredSpeedLines(undefined)[0]).toContain("median unreported · p90 unreported")
  expect(measuredSpeedLines(undefined)[1]).toBe("Generation sample coverage unreported")
  expect(forecastLines({ state: "insufficient", unit: "percent", evidence: "insufficient", updatedAt: 0, reason: "No increase observed" }, 120_000)).toEqual(["Forecast unavailable", "No supported method · insufficient evidence", "Updated 2m ago", "No increase observed"])
  expect(forecastLines({ state: "estimated", unit: "percent", method: "quota-delta-ema", evidence: "medium", updatedAt: 600_000, observedFrom: 0, observedTo: 600_000, ratePerHour: 10 }, 600_000)).toContain("Quota burn 10 percentage points/hour")
})

const quota = (input: Partial<ForecastPresentation>): ForecastPresentation => ({ state: "estimated", unit: "percent", evidence: "medium", updatedAt: 600_000, ...input })

test("default quota forecast is one concise status that keeps exhausted, flat, stale and estimated states distinct", () => {
  expect(forecastSummary(quota({ exhaustionAt: 900_000 }), 600_000)).toEqual({ text: "Estimated exhaustion 1970-01-01T00:15:00.000Z · medium evidence", tone: "warning" })
  expect(forecastSummary(quota({ exhaustionAt: 599_999 }), 300_000, 600_000).text).toBe("Estimated exhaustion now · medium evidence")
  expect(forecastSummary(quota({ evidence: "low", ratePerHour: 12.34 }), 600_000)).toEqual({ text: "Quota burn 12.3 percentage points/hour · low evidence", tone: "subdued" })
  expect(forecastSummary(quota({ projectedUsedAtReset: 80 }), 600_000).text).toBe("Projected at reset 80 percentage points · medium evidence")
  expect(forecastSummary(quota({ ratePerHour: 0 }), 600_000).text).toBe("No increase observed")
  expect(forecastSummary(quota({ state: "exhausted" }), 600_000)).toEqual({ text: "Exhausted", tone: "error" })
  expect(forecastSummary(quota({ state: "unlimited" }), 600_000).text).toBe("Unlimited")
  const insufficient = (reason?: string) => forecastSummary(quota({ state: "insufficient", evidence: "insufficient", reason }), 600_000).text
  expect(insufficient("No increase observed")).toBe("No increase observed")
  expect(insufficient("Observation stale after 2h")).toBe("Forecast stale")
  expect(insufficient("Quota window expired")).toBe("Forecast expired")
  expect(insufficient("Warming up after restart")).toBe("Forecast unavailable")
  expect(insufficient()).toBe("Forecast unavailable")
})

test("recorded consumption rows stay compact while details keep every exact metric", () => {
  const rate = { providerID: "openai", profile: "Work", modelID: "gpt-5", observedFrom: 0, observedTo: 60_000, tokensPerMinute: 1234.567, tokensPerMinute5: 1000.25, estimatedUSDPerHour: 0.4, coverage: { pricedRequests: 3, unpricedRequests: 1 } }
  expect(recordedRateRow(rate)).toEqual({ identity: "openai · Work · gpt-5", tokens: "1,235 tok/min", cost: "~$0.40/hour", partial: true })
  expect(recordedRateRow({ ...rate, estimatedUSDPerHour: undefined, coverage: { pricedRequests: 0, unpricedRequests: 4 } })).toMatchObject({ cost: "$/hour unreported", partial: false })
  expect(recordedRateRow({ ...rate, estimatedUSDPerHour: 2, coverage: { pricedRequests: 4, unpricedRequests: 0 } })).toMatchObject({ cost: "~$2.00/hour", partial: false })
  expect(recordedRateRow({ ...rate, estimatedUSDPerHour: 0.004 }).cost).toBe("<$0.01/hour")
  expect(recordedRateRow({ ...rate, estimatedUSDPerHour: 0.009 }).cost).toBe("<$0.01/hour")
  expect(recordedRateRow({ ...rate, estimatedUSDPerHour: 0.01 }).cost).toBe("~$0.01/hour")
  expect(recordedRateRow({ ...rate, estimatedUSDPerHour: 0 }).cost).toBe("~$0.00/hour")
  expect(recordedRateRow({ ...rate, tokensPerMinute: 0.04 }).tokens).toBe("<0.1 tok/min")
  expect(recordedRateRow({ ...rate, tokensPerMinute: 0 }).tokens).toBe("0 tok/min")
  expect(recordedRateLines(rate)).toEqual([
    "openai · profile Work · gpt-5",
    "Recorded consumption 1234.567 tokens/min · 5m 1000.25 · 60m unreported",
    "Estimated cost $0.4/hour · 3 priced / 1 unpriced",
    "Observed 1970-01-01T00:00:00.000Z – 1970-01-01T00:01:00.000Z",
  ])
  expect(recordedRateLines({ ...rate, tokensPerMinute: 0.04 })[1]).toContain("0.04 tokens/min")
  expect(recordedRateRow({ ...rate, profile: undefined }).identity).toBe("openai · provider default · gpt-5")
  expect(recordedRateLines({ ...rate, profile: undefined, modelID: undefined })[0]).toBe("openai · provider default at request time")
})

test("outcome counts and the failed share stay unreported until outcome data exists", () => {
  expect(errorRateText(undefined)).toBe("unreported")
  expect(errorRateText({ completed: 0, failed: 0, cancelled: 0 })).toBe("unreported")
  expect(errorRateText({ completed: 8, failed: 1, cancelled: 1 })).toBe("10.0%")
  expect(errorRateText({ completed: 5, failed: 0, cancelled: 2 })).toBe("0.0%")
  expect(outcomeLine(undefined)).toBe("Outcomes unreported")
  expect(outcomeLine({ completed: 1_200, failed: 3, cancelled: 0 })).toBe("Outcomes 1,200 completed · 3 failed · 0 cancelled · error rate 0.2%")
})
