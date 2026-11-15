import { expect, test } from "bun:test"
import { renderToString } from "solid-js/web"
import { QuotaForecastStatus } from "./usage-cost"
import { visibleProviders, type UsageProvider } from "./usage-model"

test("quota cards select supported configured snapshots independently of names and profile labels", () => {
  const base: UsageProvider = { providerID: "synthetic", label: "Same name", profile: "Same profile", status: "available", source: "provider_api", stability: "stable", updatedAt: 1, windows: [] }
  const snapshots: readonly UsageProvider[] = [
    { ...base, status: "unsupported" },
    base,
    { ...base, status: "unauthorized" },
    { ...base, status: "error", message: "HTTP 429" },
    { ...base, status: "error", message: "Fetch failed" },
  ]
  expect(visibleProviders(snapshots)).toEqual(snapshots.slice(1))
})

const forecast = { state: "estimated" as const, evidence: "medium" as const, unit: "percent", updatedAt: 600_000, ratePerHour: 12 }

test.each([
  ["ahead", "Ahead"],
  ["cutting-it-close", "Cutting it close"],
  ["will-run-out", "Will run out"],
] as const)("renders %s beside the recent quota forecast", (verdict, label) => {
  const value = { ...forecast, pace: { verdict, projectedUsedAtReset: 95 } }
  const html = renderToString(() => <QuotaForecastStatus forecast={value} asOf={600_000} />)
  expect(html).toContain(label)
  expect(html).toContain("12 percentage points/hour burn")
  expect(html).toContain("medium evidence")
})

test("a window without a pace verdict keeps only its reported forecast", () => {
  const html = renderToString(() => <QuotaForecastStatus forecast={forecast} asOf={600_000} />)
  for (const label of ["Ahead", "Cutting it close", "Will run out"]) expect(html).not.toContain(label)
  expect(html).toContain("12 percentage points/hour burn")
})
