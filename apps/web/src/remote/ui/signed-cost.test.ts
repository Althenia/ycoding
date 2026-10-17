import { expect, test } from "bun:test"
import { costText } from "./usage-accounting"
import {
  compactUsageTotal,
  money,
  providerDistribution,
  spendCostText,
  spendMetrics,
  type UsageReport,
} from "./usage-model"

const metrics = (cost: number, input: number, pricedRequests = 1) => ({
  logical: 1,
  physical: 1,
  helpers: 0,
  continued: 0,
  fallback: 0,
  tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  cost,
  costProvenance: "recorded" as const,
  costCoverage: { pricedRequests, unpricedRequests: 0 },
})

test("sub-cent credits keep the same precision as sub-cent charges", () => {
  expect(money(0.004)).toBe("$0.004")
  expect(money(-0.004)).toBe("-$0.004")
  expect(
    costText({ total: -0.004, known: -0.004, pricedRequests: 1, unpricedRequests: 0, provenance: "recorded" }),
  ).toBe("-$0.004")
  expect(costText({ known: -0.004, pricedRequests: 1, unpricedRequests: 1, provenance: "recorded" })).toBe(
    "Known -$0.004 + unreported",
  )
})

test("compact spend totals put a credit's sign before the currency symbol", () => {
  expect(compactUsageTotal(-1_234, "spend")).toBe("-$1.2k")
  expect(compactUsageTotal(-1_234_567, "spend")).toBe("-$1.2m")
})

test("signed daily totals net credits against charges and keep sub-cent credits", () => {
  const day = (cost: number) => ({
    cost,
    tokens: 10,
    requests: 1,
    costReported: true,
    costCoverage: { pricedRequests: 1, unpricedRequests: 0 },
  })
  expect(spendCostText(spendMetrics([day(5), day(-2)]))).toBe("$3.00")
  expect(spendCostText(spendMetrics([day(-0.004)]))).toBe("-$0.004")
})

test("a paged credit remainder keeps its negative Other cost and makes spend shares unavailable", () => {
  const report = {
    group: "model",
    rows: [{ key: "openai/model", label: "openai/model", ...metrics(5, 100) }],
    total: metrics(3, 150, 2),
    rowCount: 2,
    nextOffset: 1,
  } satisfies UsageReport
  const tokens = providerDistribution(report, [], "tokens")
  expect(tokens.total).toBe(150)
  expect(tokens.segments.map((segment) => [segment.providerID, segment.value, segment.costLabel])).toEqual([
    ["openai", 100, "$5.00"],
    ["other", 50, "-$2.00"],
  ])
  expect(providerDistribution(report, [], "spend")).toMatchObject({ total: 3, segments: [] })
})

test("a credit row makes spend shares unavailable without hiding the signed total or token shares", () => {
  const report = {
    group: "model",
    rows: [
      { key: "openai/model", label: "openai/model", ...metrics(5, 100) },
      { key: "anthropic/model", label: "anthropic/model", ...metrics(-2, 300) },
    ],
    total: metrics(3, 400, 2),
    rowCount: 2,
  } satisfies UsageReport
  expect(providerDistribution(report, [], "spend")).toMatchObject({ total: 3, segments: [] })
  const tokens = providerDistribution(report, [], "tokens")
  expect(tokens.total).toBe(400)
  expect(tokens.segments.map((segment) => [segment.providerID, segment.share, segment.costLabel])).toEqual([
    ["openai", 0.25, "$5.00"],
    ["anthropic", 0.75, "-$2.00"],
  ])
})

test("a paged micro-credit remainder keeps the exact net total, shows no spend shares and a known negative Other cost", () => {
  const report = {
    group: "model",
    rows: [{ key: "openai/model", label: "openai/model", ...metrics(5, 100) }],
    total: metrics(4.9999995, 150, 2),
    rowCount: 2,
    nextOffset: 1,
  } satisfies UsageReport
  const spend = providerDistribution(report, [], "spend")
  expect(spend.total).toBe(4.9999995)
  expect(spend.segments).toEqual([])
  const tokens = providerDistribution(report, [], "tokens")
  expect(tokens.segments.map((segment) => [segment.providerID, segment.value])).toEqual([
    ["openai", 100],
    ["other", 50],
  ])
  const other = tokens.segments.find((segment) => segment.providerID === "other")
  expect(other?.costLabel).toMatch(/^-\$/)
  expect(other?.costLabel).not.toBe("unreported")
})

test("a micro-credit row alone makes spend shares unavailable without hiding the exact net total", () => {
  const report = {
    group: "model",
    rows: [
      { key: "openai/model", label: "openai/model", ...metrics(5, 100) },
      { key: "anthropic/model", label: "anthropic/model", ...metrics(-0.0000005, 300) },
    ],
    total: metrics(4.9999995, 400, 2),
    rowCount: 2,
  } satisfies UsageReport
  const spend = providerDistribution(report, [], "spend")
  expect(spend.total).toBe(4.9999995)
  expect(spend.segments).toEqual([])
})

test("charges that sum to their reported total do not make spend shares unavailable", () => {
  const report = {
    group: "model",
    rows: [
      { key: "openai/a", label: "a", ...metrics(0.1, 100) },
      { key: "anthropic/b", label: "b", ...metrics(0.2, 100) },
    ],
    total: metrics(0.30000000000000004, 300, 3),
    rowCount: 3,
    nextOffset: 2,
  } satisfies UsageReport
  expect(providerDistribution(report, [], "spend").segments.map((segment) => segment.providerID)).toEqual([
    "openai",
    "anthropic",
  ])
})

test("a representable negative remainder below any float-noise bound is a credit, not zero", () => {
  const total = 1_000_000 - 2 ** -32
  const report = {
    group: "model",
    rows: [{ key: "openai/model", label: "openai/model", ...metrics(1_000_000, 100) }],
    total: metrics(total, 150, 2),
    rowCount: 2,
    nextOffset: 1,
  } satisfies UsageReport
  expect(total).toBeLessThan(1_000_000)
  const spend = providerDistribution(report, [], "spend")
  expect(spend.total).toBe(total)
  expect(spend.segments).toEqual([])
  expect(providerDistribution(report, [], "tokens").segments.find((segment) => segment.providerID === "other")?.costLabel).toMatch(/^-\$/)
})
