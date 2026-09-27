import { expect, test } from "bun:test"
import { dailySpend, donutGeometry, modelIdentity, providerDistribution, providerHeading, quotaWindow, relativeFreshness, reportKey, spendMetrics, visibleProviders, type UsageProvider } from "./usage-model"

const tokens = { input: 900, output: 100, reasoning: 20, cache: { read: 300, write: 40 } }
const row = (label: string, cost?: number, costProvenance?: "recorded" | "current_catalog") => ({
  key: label, label, logical: 2, physical: 3, helpers: 0, continued: 0, fallback: 0, tokens, cost, costProvenance,
})

test("quota omits unknown values and calculates pace against the elapsed period", () => {
  const now = Date.UTC(2026, 8, 27, 12)
  expect(quotaWindow({ id: "week", label: "Weekly", unit: "percent", used: 30, limit: 100, resetAt: now + 3 * 86_400_000, periodSeconds: 7 * 86_400 }, now)).toMatchObject({
    used: "30%", remaining: undefined, fill: 30, pace: "Below pace", reset: "Resets in 3 days",
  })
  expect(quotaWindow({ id: "balance", label: "Balance", unit: "usd", remaining: 12.5 }, now)).toMatchObject({
    used: undefined, remaining: "$12.50", fill: undefined, reset: undefined, pace: undefined,
  })
  expect(quotaWindow({ id: "session", label: "Session", unit: "percent", used: 38, resetAt: now + 2 * 3600_000, periodSeconds: 5 * 3600 }, now)).toMatchObject({
    used: "38%", limit: undefined, fill: 38, pace: "Below pace",
  })
  expect(quotaWindow({ id: "none", label: "Unknown", unit: "count" }, now).used).toBeUndefined()
})

test("daily spend uses UTC days, all token buckets, zeroes unknown cost, and labels only catalog estimates", () => {
  const now = Date.UTC(2026, 8, 27, 14)
  const report = { group: "day" as const, rows: [row("2026-09-26", 3, "recorded"), row("2026-09-27", 5, "current_catalog")], total: row("total"), rowCount: 2 }
  const days = dailySpend(report, now)
  expect(days).toHaveLength(30)
  expect(days.at(-1)).toMatchObject({ label: "Today", cost: 5, provenance: "estimate", requests: 3 })
  expect(days.at(-2)).toMatchObject({ label: "Yesterday", cost: 3, provenance: undefined })
  expect(spendMetrics(days)).toMatchObject({ cost: 8, requests: 6, tokens: 2720, provenance: "estimate" })
  expect(reportKey({ group: "model", limit: 25, sort: "cost", order: "desc" })).toBe(reportKey({ order: "desc", sort: "cost", limit: 25, group: "model" }))
})

test("quota cards include only connected, supported snapshots with windows or an error message", () => {
  const snapshot = (providerID: string, status: UsageProvider["status"], windows: UsageProvider["windows"], message?: string): UsageProvider => ({
    providerID, label: providerID, status, windows, message, source: "provider_api", stability: "stable", updatedAt: 1,
  })
  const window = [{ id: "week", label: "Week", unit: "percent" as const, used: 25 }]
  expect(visibleProviders([
    snapshot("connected", "available", window), snapshot("stale", "stale", window), snapshot("failed", "error", [], "Quota refresh failed"),
    snapshot("unsupported", "unsupported", window), snapshot("unauthorized", "unauthorized", window),
    snapshot("available-empty", "available", []), snapshot("stale-empty", "stale", []), snapshot("error-empty", "error", []),
  ]).map((item) => item.providerID)).toEqual(["connected", "stale", "failed"])
  expect(visibleProviders([snapshot("unsupported", "unsupported", [])])).toEqual([])
})

test("monthly model report groups encoded provider keys and puts only the unpaged remainder into Other", () => {
  const metric = (input: number, cost?: number) => ({ ...row("unused", cost, cost === undefined ? undefined : "recorded"), tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
  const report = { group: "model" as const, rows: [
    { ...metric(120, 2), key: "openai/gpt-6-sol" }, { ...metric(80, 3), key: "openai/gpt-5" },
    { ...metric(300, 5), key: "open%2Frouter/deepseek-v4" }, { ...metric(100), key: "github-copilot/gpt-4o" },
  ], total: metric(700, 12), rowCount: 201, nextOffset: 200 }
  const providers = [{ providerID: "openai", label: "Codex" }, { providerID: "open/router", label: "OpenRouter" }]
  expect(providerDistribution(report, providers, "spend")).toMatchObject({ total: 12, segments: [
    { providerID: "openai", label: "Codex", value: 5 }, { providerID: "open/router", label: "OpenRouter", value: 5 },
    { providerID: "other", label: "Other", value: 2 },
  ] })
  expect(providerDistribution(report, providers, "tokens")).toMatchObject({ total: 700, segments: [
    { providerID: "openai", value: 200 }, { providerID: "open/router", value: 300 },
    { providerID: "github-copilot", value: 100 }, { providerID: "other", value: 100 },
  ] })
  expect(providerDistribution({ ...report, nextOffset: undefined, total: metric(600, 10) }, providers, "spend").segments.some((segment) => segment.label === "Other")).toBe(false)
})

test("donut geometry allocates one nonoverlapping circumference in report order", () => {
  const geometry = donutGeometry([{ providerID: "a", label: "A", value: 2, share: 0.25 }, { providerID: "b", label: "B", value: 6, share: 0.75 }], 60)
  expect(geometry).toHaveLength(2)
  expect(geometry[0]?.length).toBeCloseTo(30 * Math.PI)
  expect(geometry[0]?.offset).toBeCloseTo(0)
  expect(geometry[1]?.offset).toBeCloseTo(-30 * Math.PI)
  expect(geometry.reduce((sum, segment) => sum + segment.length, 0)).toBeCloseTo(120 * Math.PI)
})

test("pace pills warn only when a window is consumed faster than its period elapses", async () => {
  const css = await Bun.file(new URL("./usage.css", import.meta.url)).text()
  const rule = (selector: string) => css.match(new RegExp(`\\${selector} \\{([^}]*)\\}`))?.[1] ?? ""
  expect(rule(".usage-pace--ahead")).toContain("var(--yc-yellow-strong)")
  expect(rule(".usage-pace--below")).not.toMatch(/danger|yellow/)
  expect(rule(".usage-pace--below")).toContain("var(--yc-text-muted)")
})

test("usage surface uses rounded tokens and disables entrance motion when reduced motion is preferred", async () => {
  const css = await Bun.file(new URL("./usage.css", import.meta.url)).text()
  expect(css).toContain("border-radius: calc(var(--yc-radius-xl) - var(--yc-space-1))")
  expect(css).toContain("border-radius: calc(var(--yc-radius-xl) - var(--yc-space-2))")
  expect(css).toContain("border-radius: var(--yc-radius-pill)")
  expect(css).toContain("@media (prefers-reduced-motion: reduce)")
  expect(css).toContain(".usage-meter > span, .usage-donut__arc { animation: none; }")
  expect(css).toContain(".usage-tabs button, .usage-toggle::before { transition: none; }")
})

test("quota headers separate a reported plan and show truthful relative freshness", () => {
  expect(providerHeading({ label: "OpenRouter · Pay as you go" })).toEqual({ name: "OpenRouter", plan: "Pay as you go" })
  expect(providerHeading({ label: "Codex", profile: "Pro" })).toEqual({ name: "Codex", plan: "Pro" })
  expect(providerHeading({ label: "GitHub Copilot" })).toEqual({ name: "GitHub Copilot", plan: undefined })
  const now = Date.UTC(2026, 8, 27, 12)
  expect(relativeFreshness(now - 35_000, now)).toBe("just now")
  expect(relativeFreshness(now - 2 * 60_000, now)).toBe("2m ago")
  expect(relativeFreshness(now - 3 * 3_600_000, now)).toBe("3h ago")
})

test("model breakdown uses the encoded provider and model rather than guessing from its display label", () => {
  const providers = [{ providerID: "open/router", label: "OpenRouter · Pay as you go" }]
  expect(modelIdentity("open%2Frouter/deepseek%2Fv4/high", providers)).toEqual({ providerID: "open/router", provider: "OpenRouter", model: "deepseek/v4 · high" })
  expect(modelIdentity("openai/gpt-6-sol", [])).toEqual({ providerID: "openai", provider: "openai", model: "gpt-6-sol" })
  expect(modelIdentity("model_without_separator", providers)).toBeUndefined()
})
