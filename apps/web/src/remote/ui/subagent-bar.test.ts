import { expect, test } from "bun:test"
import { subagentMetrics } from "./subagent-bar"
import { accountedTask } from "../../../test/usage-fixture"

const read = (metrics: ReturnType<typeof subagentMetrics>) => metrics.map((metric) => `${metric.label}: ${metric.value}`)

test("labels every reported subagent fact once, in a stable order", () => {
  expect(read(subagentMetrics("openai/gpt-6-sol#high", { accounting: accountedTask("ses_child", 0.08, 2300), cacheHitRatio: 0.5, cacheRead: 1_200, cacheWrite: 300, contextTotal: 74_000, contextLimit: 258_000 }))).toEqual([
    "Model: openai/gpt-6-sol#high",
    "Tokens (inclusive): 2,300",
    "Cache: 50% hit · 1,200 read · 300 write",
    "Cost (inclusive): $0.08",
    "Context: 74,000 / 258,000",
  ])
})

test("names an unreported cache side or context limit instead of showing zero", () => {
  expect(read(subagentMetrics(undefined, { cacheHitRatio: 1, contextTotal: 10 }))).toEqual([
    "Cache: 100% hit · read unreported · write unreported",
    "Context: 10 / unreported",
  ])
})

test("omits facts the machine has not reported and keeps a reported zero", () => {
  expect(subagentMetrics(undefined, undefined)).toEqual([])
  expect(read(subagentMetrics(undefined, { accounting: accountedTask("ses_child", 0, 0) }))).toEqual(["Tokens (inclusive): 0", "Cost (inclusive): $0.00"])
})

test("shows a partial cost as its known amount and an unpriced one as $0.00 with its qualifiers", () => {
  const task = accountedTask("ses_child", 0.25, 20)
  const withCost = (cost: typeof task.total.cost, status: typeof task.status = "so-far") => ({ accounting: { ...task, status, total: { ...task.total, cost } } })
  const cost = (value: Parameters<typeof withCost>[0], status?: typeof task.status) => read(subagentMetrics(undefined, withCost(value, status))).at(-1)
  expect(cost({ known: 0.25, pricedRequests: 1, unpricedRequests: 1, provenance: "recorded" })).toBe("Cost (inclusive): $0.25 · so far · incomplete")
  expect(cost({ pricedRequests: 0, unpricedRequests: 1 })).toBe("Cost (inclusive): $0.00 · so far · incomplete")
  expect(cost({ pricedRequests: 0, unpricedRequests: 1 }, "settled")).toBe("Cost (inclusive): $0.00 · incomplete")
})

test("shows the child's own speed once and keeps it absent before output", () => {
  expect(read(subagentMetrics(undefined, { speed: { label: "≈ 100 tok/s", description: "Estimated generation speed" } })))
    .toEqual(["Speed: ≈ 100 tok/s"])
  expect(subagentMetrics(undefined, {}).some((metric) => metric.key === "speed")).toBe(false)
})
