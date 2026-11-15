import { expect, test } from "bun:test"
import { readUsageForecast } from "./usage-read"
import { visibleProviders, type UsageProvider } from "./ui/usage-model"

test("quota visibility uses typed status and retains supported errors even without a message", () => {
  const provider: UsageProvider = { providerID: "example", label: "Example", status: "available", source: "provider_api", stability: "stable", updatedAt: 1, windows: [] }
  const values: readonly UsageProvider[] = [
    { ...provider, status: "unsupported", message: "No supported credential is configured" },
    { ...provider, status: "unsupported", source: "response_stream", stability: "observed", message: "Usage unsupported" },
    { ...provider, status: "unauthorized" },
    { ...provider, status: "error" },
    { ...provider, status: "error", message: "Rate limited" },
    { ...provider, windows: [{ id: "week", label: "Weekly", unit: "percent", used: 0 }] },
    provider,
    { ...provider, status: "stale" },
  ]
  expect(visibleProviders(values)).toEqual(values.slice(2))
})

const quota = { providerID: "anthropic", windowID: "five-hour", unit: "percent", source: "response_headers", stability: "observed", updatedAt: 1_800_000_000_000, state: "insufficient", evidence: "insufficient" }
const forecast = (pace: unknown) => ({ asOf: quota.updatedAt, localScope: "backend", localRates: [], quotas: [{ ...quota, pace }] })

test("forecast reads retain a reported pace without inferring one from the last-hour forecast", () => {
  const pace = { verdict: "will-run-out", projectedUsedAtReset: 120, exhaustionAt: quota.updatedAt + 60_000 } as const
  expect(readUsageForecast(forecast(pace))?.quotas?.[0]?.pace).toEqual(pace)
  expect(readUsageForecast({ asOf: quota.updatedAt, localScope: "backend", quotas: [{ ...quota, state: "estimated", exhaustionAt: quota.updatedAt + 60_000 }] })?.quotas?.[0]).not.toHaveProperty("pace")
})

test("forecast reads reject malformed pace fields", () => {
  for (const pace of [null, { verdict: "healthy", projectedUsedAtReset: 90 }, { verdict: "ahead", projectedUsedAtReset: -1 }, { verdict: "will-run-out", projectedUsedAtReset: 120, exhaustionAt: "later" }, { verdict: "ahead", projectedUsedAtReset: 90, exhaustionAt: quota.updatedAt + 60_000 }])
    expect(readUsageForecast(forecast(pace))).toBeUndefined()
})
