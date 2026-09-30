import { expect, test } from "bun:test"
import { subagentMetrics } from "./subagent-bar"

const read = (metrics: ReturnType<typeof subagentMetrics>) => metrics.map((metric) => `${metric.label}: ${metric.value}`)

test("labels every reported subagent fact once, in a stable order", () => {
  expect(read(subagentMetrics("openai/gpt-6-sol#high", { tokens: 2_300, cacheHitRatio: 0.5, cacheRead: 1_200, cacheWrite: 300, cost: 0.08, contextTotal: 74_000, contextLimit: 258_000 }))).toEqual([
    "Model: openai/gpt-6-sol#high",
    "Tokens: 2,300",
    "Cache: 50% hit · 1,200 read · 300 write",
    "Cost: $0.08",
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
  expect(read(subagentMetrics(undefined, { tokens: 0, cost: 0 }))).toEqual(["Tokens: 0", "Cost: $0.00"])
})
