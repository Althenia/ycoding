import { expect, test } from "bun:test"
import { accountedTask } from "../../test/usage-fixture"
import { readPromptCosts, readTaskCosts, readUsageCost, readUsageForecast } from "./usage-read"
import { accountingPresentation, unitCostLines } from "./ui/usage-accounting"
import { readUsageReport } from "./queries"

test("frozen accounting reads preserve zero and partial pricing and reject false complete totals", () => {
  const task = accountedTask("ses_child", 0, 0)
  expect(readTaskCosts({ tasks: [task], total: task.total, history: "retained" })?.tasks[0]?.total.cost.total).toBe(0)
  expect(readUsageCost({ ...task.total.cost, unpricedRequests: 1 })).toBeUndefined()
  expect(readUsageCost({ known: 1, pricedRequests: 0, unpricedRequests: 1, provenance: "recorded" })).toBeUndefined()
  const cost = { known: 2, pricedRequests: 1, unpricedRequests: 1, provenance: "recorded" as const }
  const prompt = { anchor: { sessionID: "ses_root", inputID: "msg_first" }, status: "so-far" as const, attribution: "partial" as const, history: "partial" as const, total: { ...task.total, cost }, main: task.main, children: { ...task.total, cost }, helpers: [{ ...task.total, source: "decision" as const }] }
  const response = readPromptCosts({ units: [prompt], unattributed: task.total, history: "partial" })
  expect(response?.units).toEqual([prompt])
  const view = accountingPresentation(prompt)
  expect(view.inputID).toBe("msg_first")
  expect(unitCostLines(view)).toContain("Prompt cost Known $2.00 + unreported · so far · incomplete")
  expect(unitCostLines(view)).toContain("partial attribution · Incomplete retained history")
  expect(view.helpers[0]?.label).toBe("Decision")
  expect(accountingPresentation(accountedTask(), true)).toMatchObject({ complete: false, reason: "Latest lookup unavailable; showing previous result" })
  expect(accountingPresentation({ ...task, total: { ...task.total, cost } }).complete).toBe(false)
})

test("forecast decoder preserves native-unit evidence and rejects invented numeric values", () => {
  const quota = { providerID: "openai", windowID: "week", unit: "percent", source: "provider_api", stability: "stable", updatedAt: 600_000, state: "insufficient", evidence: "insufficient", reason: "Warming up" }
  const value = { asOf: 600_000, localScope: "backend", localRates: [], quotas: [quota] }
  expect(readUsageForecast(value)?.quotas?.[0]?.ratePerHour).toBeUndefined()
  expect(readUsageForecast({ ...value, quotas: [{ ...quota, ratePerHour: NaN }] })).toBeUndefined()
  expect(readUsageForecast({ ...value, quotas: [{ ...quota, unit: "invented" }] })).toBeUndefined()
})

test("an absent forecast section stays absent while an empty one stays empty", () => {
  const quota = { providerID: "openai", windowID: "week", unit: "percent", source: "provider_api", stability: "stable", updatedAt: 600_000, state: "insufficient", evidence: "insufficient" }
  const base = { asOf: 600_000, localScope: "backend" as const }
  expect(readUsageForecast({ ...base, quotas: [quota] })?.quotas).toHaveLength(1)
  expect(readUsageForecast({ ...base, quotas: [quota] })?.localRates).toBeUndefined()
  expect(readUsageForecast({ ...base, localRates: [] })?.quotas).toBeUndefined()
  expect(readUsageForecast({ ...base, localRates: [], quotas: [] })).toMatchObject({ localRates: [], quotas: [] })
  expect(readUsageForecast({ ...base, localRates: "none" })).toBeUndefined()
  expect(readUsageForecast({ ...base, quotas: {} })).toBeUndefined()
})

test("USD amounts accept any finite value while token counts and rates stay nonnegative", () => {
  const credit = { total: -1.5, known: -1.5, pricedRequests: 1, unpricedRequests: 0, provenance: "recorded" as const }
  expect(readUsageCost(credit)).toEqual(credit)
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
    expect(readUsageCost({ ...credit, total: bad, known: bad })).toBeUndefined()
  const task = accountedTask("ses_child", -2, 5)
  expect(readTaskCosts({ tasks: [task], total: task.total, history: "retained" })?.tasks[0]?.total.cost.total).toBe(-2)
  expect(readTaskCosts({ tasks: [{ ...task, total: { ...task.total, tokens: { ...task.total.tokens, input: -1 } } }], total: task.total, history: "retained" })).toBeUndefined()
  const forecast = { asOf: 1, localScope: "backend", localRates: [{ providerID: "openai", observedFrom: 0, observedTo: 1, tokensPerMinute: 5, estimatedUSDPerHour: -0.25, coverage: { pricedRequests: 1, unpricedRequests: 0 } }] }
  expect(readUsageForecast(forecast)?.localRates?.[0]?.estimatedUSDPerHour).toBe(-0.25)
  expect(readUsageForecast({ ...forecast, localRates: [{ ...forecast.localRates[0], estimatedUSDPerHour: Number.NaN }] })).toBeUndefined()
  expect(readUsageForecast({ ...forecast, localRates: [{ ...forecast.localRates[0], tokensPerMinute: -1 }] })).toBeUndefined()
  const metrics = { logical: 1, physical: 1, helpers: 0, continued: 0, fallback: 0, tokens: task.total.tokens, cost: -3, costProvenance: "recorded" }
  const report = { group: "model", rows: [{ key: "a", label: "a", ...metrics }], total: metrics, rowCount: 1 }
  expect(readUsageReport(report, "model")?.rows[0]?.cost).toBe(-3)
  expect(readUsageReport({ ...report, total: { ...metrics, cost: Number.NaN } }, "model")).toBeUndefined()
})

