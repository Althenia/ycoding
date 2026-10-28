import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ProviderRequest } from "../src/provider-request.js"
import { Telemetry } from "../src/telemetry.js"
import { UsageDashboard } from "../src/usage-dashboard.js"

const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const metrics = { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens }
const report = (group: ProviderRequest.ReportGroup) => ({ group, rows: [], total: metrics, rowCount: 0 })
const input = {
  daily: { group: "day", from: 0, to: 10, timeZone: "UTC" },
  monthly: { group: "month", from: 0, to: 10 },
  breakdown: { group: "provider-model", limit: 200 },
} satisfies UsageDashboard.Input
const ready = {
  status: "ready",
  asOf: 5,
  revision: "r1",
  summary: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens },
  quota: { status: "ready", providers: [], forecast: { asOf: 4, localScope: "backend" } },
  daily: report("day"),
  monthly: report("month"),
  breakdown: report("provider-model"),
} satisfies UsageDashboard.Ready

test("dashboard input requires three reports and an optional one-shot refresh", () => {
  const decode = Schema.decodeUnknownSync(UsageDashboard.Input)
  expect(decode(input)).toEqual(input)
  expect(decode({ ...input, refresh: true }).refresh).toBe(true)
  expect(() => decode({ ...input, refresh: "yes" })).toThrow()
})

test("dashboard input accepts no slots or any single slot and validates each provided one", () => {
  const decode = Schema.decodeUnknownSync(UsageDashboard.Input)
  expect(decode({})).toEqual({})
  expect(decode({ refresh: true })).toEqual({ refresh: true })
  expect(decode({ breakdown: input.breakdown })).toEqual({ breakdown: input.breakdown })
  expect(decode({ daily: input.daily, monthly: input.monthly })).toEqual({ daily: input.daily, monthly: input.monthly })
  expect(() => decode({ breakdown: { group: "day", from: 5, to: 5 } })).toThrow()
  expect(() => decode({ daily: { group: "nope" } })).toThrow()
  expect(Schema.encodeSync(UsageDashboard.Input)({ daily: undefined, monthly: undefined, breakdown: input.breakdown } as typeof UsageDashboard.Input.Type)).toEqual({ breakdown: input.breakdown })
})

test("dashboard input keeps report range and group validation", () => {
  const decode = Schema.decodeUnknownSync(UsageDashboard.Input)
  expect(() => decode({ ...input, daily: { group: "day", from: 10, to: 10 } })).toThrow()
  expect(() => decode({ ...input, breakdown: { group: "unknown" } })).toThrow()
  expect(() => decode({ ...input, monthly: { group: "month", limit: 201 } })).toThrow()
  expect(() => decode({ ...input, daily: { group: "day", timeZone: "" } })).toThrow()
})

test("dashboard info round-trips preparing, error, and ready", () => {
  const decode = Schema.decodeUnknownSync(UsageDashboard.Info)
  const encode = Schema.encodeSync(UsageDashboard.Info)
  for (const value of [{ status: "preparing" }, { status: "error", message: "failed" }, ready] as const)
    expect(encode(decode(value))).toEqual(value)
})

test("dashboard info requires summary and quota and rejects unknown status", () => {
  const decode = Schema.decodeUnknownSync(UsageDashboard.Info)
  const { breakdown: _breakdown, ...incomplete } = ready
  expect(() => decode(incomplete)).not.toThrow()
  const { summary: _summary, ...withoutSummary } = ready
  const { quota: _quota, ...withoutQuota } = ready
  for (const missing of [withoutSummary, withoutQuota]) expect(() => decode(missing)).toThrow()
  const { quota: _removed, ...accounting } = ready
  expect(() => decode({ ...accounting, providers: [], forecast: { asOf: 4, localScope: "backend" } })).toThrow()
  const bare = Schema.encodeSync(UsageDashboard.Info)({ ...decode(ready), daily: undefined, monthly: undefined, breakdown: undefined } as UsageDashboard.Info)
  expect(Object.keys(bare)).toEqual(["status", "asOf", "revision", "summary", "quota"])
  expect(() => decode({ ...ready, asOf: -1 })).toThrow()
  expect(() => decode({ status: "stale" })).toThrow()
  expect(() => decode({ status: "error" })).toThrow()
})

test("dashboard quota is preparing or ready with providers and forecast", () => {
  const decode = Schema.decodeUnknownSync(UsageDashboard.Quota)
  const encode = Schema.encodeSync(UsageDashboard.Quota)
  for (const value of [{ status: "preparing" }, ready.quota, { status: "error", message: "Provider quota is unavailable." }] as const) expect(encode(decode(value))).toEqual(value)
  expect(() => decode({ status: "ready" })).toThrow()
  expect(() => decode({ status: "ready", providers: [] })).toThrow()
  expect(() => decode({ status: "ready", forecast: ready.quota.forecast })).toThrow()
  expect(() => decode({ status: "error" })).toThrow()
  expect(() => decode({ status: "error", message: 1 })).toThrow()
  expect(() => decode({ status: "stale" })).toThrow()
  expect(Schema.decodeUnknownSync(UsageDashboard.Info)({ ...ready, quota: { status: "preparing" } })).toMatchObject({ quota: { status: "preparing" } })
})

test("dashboard encoding omits an absent refresh and keeps stable public identifiers", () => {
  expect(Schema.encodeSync(UsageDashboard.Input)({ ...input, refresh: undefined } as typeof UsageDashboard.Input.Type)).toEqual(input)
  expect(Schema.encodeSync(UsageDashboard.Input)({ ...input, refresh: false } as typeof UsageDashboard.Input.Type)).toEqual({ ...input, refresh: false })
  expect([UsageDashboard.Input, UsageDashboard.Preparing, UsageDashboard.Failed, UsageDashboard.QuotaPreparing, UsageDashboard.QuotaReady, UsageDashboard.QuotaFailed, UsageDashboard.Quota, UsageDashboard.Ready, UsageDashboard.Info].map((schema) => schema.ast.annotations?.identifier)).toEqual([
    "UsageDashboard.Input", "UsageDashboard.Preparing", "UsageDashboard.Error", "UsageDashboard.QuotaPreparing", "UsageDashboard.QuotaReady", "UsageDashboard.QuotaFailed", "UsageDashboard.Quota", "UsageDashboard.Ready", "UsageDashboard.Info",
  ])
})

test("dashboard latency samples are accepted for the composed operation", () => {
  expect(Schema.decodeUnknownSync(Telemetry.Operation)("usage.dashboard")).toBe("usage.dashboard")
})
