import { describe, expect, test } from "bun:test"
import { ProviderUsageForecast } from "@ycoding-ai/core/provider-usage/forecast"
import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { Provider } from "@ycoding-ai/schema/provider"
import { ClaudeUsage } from "@ycoding-ai/core/provider-usage/claude"
import { UsageForecast } from "@ycoding-ai/schema/usage-forecast"
import { Schema } from "effect"

const start = 1_800_000_000_000
const period = 10_000_000
const resetAt = start + period
const evaluate = (used: number | undefined, elapsed = period / 2, extra: Partial<ProviderUsage.Window> = {}, semantics: ProviderUsageForecast.Semantics = "fixed-reset") => {
  const window = new ProviderUsage.Window({ id: "fixed", label: "Fixed quota", unit: "tokens", used, limit: 100, resetAt, periodSeconds: period / 1000, ...extra })
  return ProviderUsageForecast.pace({ window, now: start + elapsed, semantics })
}

describe("whole-window quota pace", () => {
  test("omits empty, unknown, invalid, early, and expired windows", () => {
    expect(evaluate(0)).toBeUndefined()
    expect(evaluate(undefined)).toBeUndefined()
    expect(evaluate(1, period / 100 - 1)).toBeUndefined()
    expect(evaluate(1, period / 100)).toBeDefined()
    expect(evaluate(1, -1)).toBeUndefined()
    expect(evaluate(60, period)).toBeUndefined()
    expect(evaluate(60, period + 1)).toBeUndefined()
    expect(evaluate(10, undefined, { limit: undefined })).toBeUndefined()
    expect(evaluate(10, undefined, { resetAt: undefined })).toBeUndefined()
    expect(evaluate(10, undefined, { periodSeconds: undefined })).toBeUndefined()
    expect(evaluate(10, undefined, { limit: 0 })).toBeUndefined()
    expect(evaluate(10, undefined, { unlimited: true })).toBeUndefined()
  })

  test.each(["rolling", "balance", "unknown"] as const)("omits %s semantics", (semantics) => {
    expect(evaluate(90, undefined, {}, semantics)).toBeUndefined()
  })

  test.each([
    [45, "ahead", 90],
    [45.0001, "cutting-it-close", 90.0002],
    [50, "cutting-it-close", 100],
    [50.0001, "will-run-out", 100.0002],
    [100, "will-run-out", 200],
  ] as const)("classifies %s used with half the window elapsed", (used, verdict, projectedUsedAtReset) => {
    expect(evaluate(used)).toMatchObject({ verdict, projectedUsedAtReset })
  })

  test("shows a run-out only for a future exhaustion before reset", () => {
    expect(evaluate(45)?.exhaustionAt).toBeUndefined()
    expect(evaluate(50)?.exhaustionAt).toBeUndefined()
    expect(evaluate(60)?.exhaustionAt).toBe(Math.trunc(start + period / 2 + 40 / (60 / (period / 2))))
    expect(evaluate(100)?.exhaustionAt).toBeUndefined()
    expect(evaluate(110)?.exhaustionAt).toBeUndefined()
  })

  test("enforces the one-minute floor for short windows", () => {
    expect(evaluate(1, 59_999, { resetAt: start + 3_600_000, periodSeconds: 3600 })).toBeUndefined()
    expect(evaluate(1, 60_000, { resetAt: start + 3_600_000, periodSeconds: 3600 })).toBeDefined()
  })

  test("percent units use their defined denominator without fabricating a reported limit", () => {
    expect(evaluate(45, undefined, { unit: "percent", limit: undefined })).toMatchObject({ verdict: "ahead", projectedUsedAtReset: 90 })
    expect(evaluate(60, undefined, { unit: "percent", limit: undefined })).toMatchObject({ verdict: "will-run-out", projectedUsedAtReset: 120 })
  })

  test("Claude's fixed bucket contracts supply their five-hour and seven-day durations", () => {
    const snapshot = ClaudeUsage.normalizeOAuth({ providerID: Provider.ID.make("anthropic"), label: "Claude", updatedAt: start,
      response: { five_hour: { utilization: 45, resets_at: new Date(start + 9_000_000).toISOString() }, seven_day: { utilization: 25, resets_at: new Date(start + 302_400_000).toISOString() } } })
    expect(snapshot.windows.map((window) => window.periodSeconds)).toEqual([18_000, 604_800])
    expect(snapshot.windows.every((window) => window.limit === undefined)).toBe(true)
    expect(snapshot.windows.map((window) => ProviderUsageForecast.pace({ window, now: start, semantics: "fixed-reset" })?.verdict)).toEqual(["ahead", "ahead"])
  })

  test("pace remains available independently of recent-delta evidence and survives the public quota schema", () => {
    const window = new ProviderUsage.Window({ id: "fixed", label: "Fixed quota", unit: "percent", used: 45, resetAt, periodSeconds: period / 1000 })
    const snapshot = new ProviderUsage.Snapshot({ providerID: Provider.ID.make("anthropic"), label: "Claude", status: "available", source: "provider_api", stability: "stable", updatedAt: start + period / 2, windows: [window] })
    const result = ProviderUsageForecast.make().quota({ account: "synthetic-account", snapshot, window, now: snapshot.updatedAt, semantics: "fixed-reset" })
    expect(result.state).toBe("insufficient")
    expect(result.pace).toMatchObject({ verdict: "ahead", projectedUsedAtReset: 90 })
    const encoded = Schema.encodeSync(UsageForecast.Quota)({ providerID: snapshot.providerID, windowID: window.id, unit: window.unit, ...result })
    expect(encoded).toMatchObject({ pace: { verdict: "ahead", projectedUsedAtReset: 90 } })
    expect(encoded.pace).not.toHaveProperty("exhaustionAt")
    expect(ProviderUsageForecast.make().quota({ account: "synthetic-account", snapshot: new ProviderUsage.Snapshot({ ...snapshot, status: "stale" }), window, now: snapshot.updatedAt, semantics: "fixed-reset" }).pace).toBeUndefined()
  })
})
