import { expect, test } from "bun:test"
import { compactUsageTotal, reportNeedsNewerConnector, unsupportedReportMessage, dailySpend, donutGeometry, matchingQuotaForecast, modelIdentity, money, providerDistribution, providerHeading, quotaGroupHeading, quotaWindow, relativeFreshness, reportKey, reportCostText, reportIdentity, reportLabel, spendCostText, spendMetrics, tooltipPosition, usageBounds, usageDashboardView, usageQuotaView, usageReportInputs, visibleProviders, type UsageDashboardReady, type UsageProvider } from "./usage-model"

const tokens = { input: 900, output: 100, reasoning: 20, cache: { read: 300, write: 40 } }
const row = (label: string, cost?: number, costProvenance?: "recorded" | "current_catalog") => ({
  key: label, label, logical: 2, physical: 3, helpers: 0, continued: 0, fallback: 0, tokens, cost, costProvenance,
})

test("a quota forecast belongs only to the matching provider, profile, window, native unit and observation", () => {
  const window = { id: "week", label: "Weekly", unit: "percent" as const, used: 50 }
  const provider: UsageProvider = { providerID: "openai", profile: "Work", label: "OpenAI", status: "available", source: "provider_api", stability: "stable", updatedAt: 600_000, windows: [window] }
  const quota = { providerID: "openai", profile: "Work", windowID: "week", unit: "percent" as const, source: "provider_api" as const, stability: "stable" as const, updatedAt: 600_000, state: "estimated" as const, evidence: "medium" as const, method: "quota-delta-ema" as const, observedFrom: 0, observedTo: 600_000, ratePerHour: 10 }
  expect(matchingQuotaForecast(provider, window, [quota])).toBe(quota)
  expect(matchingQuotaForecast({ ...provider, providerID: "anthropic" }, window, [quota])).toBeUndefined()
  expect(matchingQuotaForecast({ ...provider, profile: "Personal" }, window, [quota])).toBeUndefined()
  expect(matchingQuotaForecast(provider, { ...window, id: "month" }, [quota])).toBeUndefined()
  expect(matchingQuotaForecast(provider, { ...window, unit: "usd" }, [quota])).toBeUndefined()
  expect(matchingQuotaForecast({ ...provider, updatedAt: 600_001 }, window, [quota])).toBeUndefined()
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

test("a reported full or empty window is exhausted, while missing limits and partial use never are", () => {
  const now = 1_000_000
  expect(quotaWindow({ id: "week", label: "Weekly", unit: "percent", used: 100 }, now).exhausted).toBe(true)
  expect(quotaWindow({ id: "week", label: "Weekly", unit: "percent", used: 120 }, now).exhausted).toBe(true)
  expect(quotaWindow({ id: "credits", label: "Credits", unit: "count", used: 1000, limit: 1000, remaining: 0 }, now).exhausted).toBe(true)
  expect(quotaWindow({ id: "balance", label: "Balance", unit: "usd", remaining: 0 }, now).exhausted).toBe(true)
  expect(quotaWindow({ id: "credits", label: "Credits", unit: "usd", remaining: 0, unlimited: true }, now).exhausted).toBe(false)
  expect(quotaWindow({ id: "week", label: "Weekly", unit: "percent", used: 100, unlimited: true }, now).exhausted).toBe(false)
  expect(quotaWindow({ id: "week", label: "Weekly", unit: "percent", used: 99.9 }, now).exhausted).toBe(false)
  expect(quotaWindow({ id: "spend", label: "Spend", unit: "usd", used: 40 }, now).exhausted).toBe(false)
  expect(quotaWindow({ id: "daily", label: "Today", unit: "usd", used: 0 }, now).exhausted).toBe(false)
  expect(quotaWindow({ id: "none", label: "Unknown", unit: "count" }, now).exhausted).toBe(false)
})

test("provider token distributions preserve free, unpriced, partial and unpaged price coverage", () => {
  const rows = [
    { ...row("free/model", 0, "recorded"), costCoverage: { pricedRequests: 2, unpricedRequests: 0 } },
    { ...row("unknown/model"), costCoverage: { pricedRequests: 0, unpricedRequests: 2 } },
    { ...row("partial/model", 1, "recorded"), costCoverage: { pricedRequests: 1, unpricedRequests: 1 } },
  ] as const
  const total = { ...row("total", 1, "recorded"), logical: 6, physical: 9, tokens: { input: 2700, output: 300, reasoning: 60, cache: { read: 900, write: 120 } }, costCoverage: { pricedRequests: 3, unpricedRequests: 3 } }
  const report = { group: "model" as const, rows, total, rowCount: 3 }
  const labels = new Map(providerDistribution(report, [], "tokens").segments.map((segment) => [segment.providerID, segment.costLabel]))
  expect(labels.get("free")).toBe("$0.00")
  expect(labels.get("unknown")).toBe("")
  expect(labels.get("partial")).toBe("$1.00")
  const paged = providerDistribution({ ...report, rows: [rows[0], rows[2]], nextOffset: 2 }, [], "tokens")
  expect(paged.segments.find((segment) => segment.providerID === "other")?.costLabel).toBe("")
  expect(paged.total).toBe(4080)
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

test("quota cards include snapshots with windows, an error message, or any unauthorized status, and hide unsupported ones", () => {
  const snapshot = (providerID: string, status: UsageProvider["status"], windows: UsageProvider["windows"], message?: string): UsageProvider => ({
    providerID, label: providerID, status, windows, message, source: "provider_api", stability: "stable", updatedAt: 1,
  })
  const window = [{ id: "week", label: "Week", unit: "percent" as const, used: 25 }]
  expect(visibleProviders([
    snapshot("connected", "available", window), snapshot("stale", "stale", window), snapshot("failed", "error", [], "Quota refresh failed"),
    snapshot("unsupported", "unsupported", window), snapshot("unauthorized", "unauthorized", window),
    snapshot("unauthorized-message", "unauthorized", [], "Reconnect this provider"), snapshot("unauthorized-empty", "unauthorized", []),
    snapshot("available-empty", "available", []), snapshot("stale-empty", "stale", []), snapshot("error-empty", "error", []),
  ]).map((item) => item.providerID)).toEqual(["connected", "stale", "failed", "unauthorized", "unauthorized-message", "unauthorized-empty"])
  expect(visibleProviders([snapshot("unsupported", "unsupported", [])])).toEqual([])
})

test("a response-observed snapshot with no quota sample yet stays visible as a pending card, without unhiding genuine unsupported providers", () => {
  const pending: UsageProvider = {
    providerID: "muse", label: "Muse (Meta)", status: "unsupported", source: "response_stream", stability: "observed",
    updatedAt: 1, windows: [], message: "Quota is reported after the next Muse response",
  }
  expect(visibleProviders([pending]).map((item) => item.providerID)).toEqual(["muse"])
  expect(visibleProviders([{ ...pending, source: "provider_api" }])).toEqual([])
  expect(visibleProviders([{ ...pending, stability: "stable" }])).toEqual([])
  expect(visibleProviders([{ ...pending, message: undefined }])).toEqual([])
  expect(visibleProviders([{ ...pending, message: "   " }])).toEqual([])
  expect(visibleProviders([{ ...pending, providerID: "disconnected", status: "unauthorized", windows: [{ id: "window", label: "Window", unit: "percent", used: 10 }] }]).map((item) => item.providerID)).toEqual(["disconnected"])
  const observed: UsageProvider = { ...pending, status: "available", message: undefined, windows: [{ id: "window", label: "5-hour window", unit: "percent", used: 0 }] }
  expect(visibleProviders([observed]).map((item) => item.providerID)).toEqual(["muse"])
  expect(quotaWindow(observed.windows[0]!, 1_000).used).toBe("0%")
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
  const geometry = donutGeometry([{ providerID: "a", label: "A", value: 2, share: 0.25, costLabel: "" }, { providerID: "b", label: "B", value: 6, share: 0.75, costLabel: "$1.00" }], 60)
  expect(geometry).toHaveLength(2)
  expect(geometry[0]?.length).toBeCloseTo(30 * Math.PI)
  expect(geometry[0]?.offset).toBeCloseTo(0)
  expect(geometry[1]?.offset).toBeCloseTo(-30 * Math.PI)
  expect(geometry.reduce((sum, segment) => sum + segment.length, 0)).toBeCloseTo(120 * Math.PI)
})

test("donut total stays exact below the compact threshold and rounds compact values up through k, m, and b", () => {
  expect(compactUsageTotal(999.99, "spend")).toBe(money(999.99))
  expect(compactUsageTotal(999.99, "tokens")).toBe("999.99")
  expect(compactUsageTotal(1_000, "spend")).toBe("$1.0k")
  expect(compactUsageTotal(1_000, "tokens")).toBe("1.0k")
  expect(compactUsageTotal(999_950, "tokens")).toBe("1.0m")
  expect(compactUsageTotal(1_000_000, "spend")).toBe("$1.0m")
  expect(compactUsageTotal(123_456_789, "tokens")).toBe("123.5m")
  expect(compactUsageTotal(1_000_000_000, "tokens")).toBe("1.0b")
  expect(compactUsageTotal(1_234_567_890, "spend")).toBe("$1.2b")
  expect(compactUsageTotal(0.0001, "spend")).toBe(money(0.0001))
  expect(compactUsageTotal(-1_234, "spend")).toBe("$-1.2k")
  expect(compactUsageTotal(-1_234, "tokens")).toBe("-1.2k")
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
  expect(css).toContain("border-radius: calc(var(--yc-radius-xl) - var(--yc-space-2))")
  expect(css).toContain("border-radius: var(--yc-radius-pill)")
  expect(css).toContain("@media (prefers-reduced-motion: reduce)")
  expect(css).toContain(".usage-meter > span, .usage-donut__arc, .usage-chart__tooltip, .usage-distribution__tooltip { animation: none; }")
  expect(css).toContain(".usage-toggle::before { transition: none; }")
  expect(css).toContain(".usage-breakdown__head .custom-select")
  expect(css).toContain(".usage-chart__tooltip, .usage-distribution__tooltip { animation: none; }")
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
  expect(modelIdentity("open%2Frouter/deepseek%2Fv4/high", providers)).toEqual({ providerID: "open/router", provider: "OpenRouter", model: "deepseek/v4 · selected effort high" })
  expect(modelIdentity("openai/gpt-6-sol", [])).toEqual({ providerID: "openai", provider: "openai", model: "gpt-6-sol" })
  expect(modelIdentity("openai/gpt-6-sol/high/work", [], { providerID: "openai", id: "gpt-6-sol", variant: "high", profile: "work" })?.model).toBe("gpt-6-sol · selected effort high · profile work")
  expect(modelIdentity("openai/gpt-6-sol/work", [], { providerID: "openai", id: "gpt-6-sol", profile: "work" })?.model).toBe("gpt-6-sol · profile work")
  expect(modelIdentity("model_without_separator", providers)).toBeUndefined()
})

test("frozen report dimensions and filters preserve provider/profile identity and retained Session labels", () => {
  const base = row("mixed", 0)
  expect(reportIdentity({ ...base, dimensions: { group: "provider-profile-model", providerID: "openai", modelID: "shared", profileState: "provider-default" } }, [])).toMatchObject({ providerID: "openai", model: "shared · provider default at request time" })
  expect(reportIdentity({ ...base, dimensions: { group: "profile", providerID: "other", profile: "Work", profileState: "recorded" } }, [])).toMatchObject({ providerID: "other", model: "profile Work" })
  expect(reportLabel({ key: "ses_deleted", label: "" }, "session")).toBe("Session ses_deleted")
  expect(reportLabel({ key: "ses_deleted", label: "ses_deleted" }, "session")).toBe("Session ses_deleted")
  expect(reportLabel({ key: "ses_live", label: "Named session" }, "session")).toBe("Named session")
  const now = Date.UTC(2026, 9, 15)
  expect(usageReportInputs(now, undefined, { group: "prompt", range: "all", selectedEffort: "high", providerID: "openai", profile: "Work", modelID: "shared" }).breakdown).toEqual({ group: "prompt", selectedEffort: "high", providerID: "openai", profile: "Work", modelID: "shared", limit: 25, offset: undefined, sort: undefined, order: undefined })
  expect(reportKey({ group: "profile", providerID: "openai", profile: "Work" })).not.toBe(reportKey({ group: "profile", providerID: "other", profile: "Work" }))
  expect(reportKey({ group: "model", selectedEffort: "high" })).not.toBe(reportKey({ group: "model", selectedEffort: "low" }))
})

test("report, daily and summary costs show the known amount, keep an explicit zero, and are empty when nothing is priced", () => {
  expect(reportCostText({ cost: 0, costCoverage: { pricedRequests: 1, unpricedRequests: 0 } })).toBe("$0.00")
  expect(reportCostText({ cost: 0, costCoverage: { pricedRequests: 1, unpricedRequests: 1 } })).toBe("$0.00")
  expect(reportCostText({ cost: 2.5, costCoverage: { pricedRequests: 1, unpricedRequests: 1 } })).toBe("$2.50")
  expect(reportCostText({ cost: 2.5 })).toBe("$2.50")
  expect(reportCostText({ costCoverage: { pricedRequests: 0, unpricedRequests: 1 } })).toBe("")
  expect(reportCostText({})).toBe("")
  const days = dailySpend({ group: "day", rows: [{ ...row("2026-10-15"), costCoverage: { pricedRequests: 0, unpricedRequests: 3 } }], rowCount: 1, total: row("total") }, Date.UTC(2026, 9, 15))
  expect(spendCostText(days.at(-1)!)).toBe("")
  expect(spendCostText(spendMetrics(days))).toBe("")
  expect(spendCostText(days.at(-2)!)).toBe("No retained requests")
})

test("chart detail stays beside its anchor but inside both card and viewport", () => {
  const card = { left: 16, top: 100, width: 358, height: 360 }
  expect(tooltipPosition(card, { width: 390, height: 844 }, { x: 50, y: 250 }, { width: 220, height: 80 })).toEqual({ left: 46, top: 162 })
  expect(tooltipPosition(card, { width: 390, height: 844 }, { x: 360, y: 430 }, { width: 220, height: 80 })).toEqual({ left: 130, top: 272 })
  expect(tooltipPosition({ ...card, top: 700 }, { width: 390, height: 844 }, { x: 50, y: 810 }, { width: 220, height: 80 })).toEqual({ left: 46, top: 56 })
})

test("local report bounds use exact DST and non-hour-offset midnights", () => {
  expect(usageBounds(Date.UTC(2026, 2, 8, 18), "America/New_York")).toMatchObject({
    to: Date.UTC(2026, 2, 9, 4),
    monthFrom: Date.UTC(2026, 2, 1, 5),
  })
  expect(usageBounds(Date.UTC(2026, 4, 1, 1), "Asia/Kathmandu")).toMatchObject({
    to: Date.UTC(2026, 4, 1, 18, 15),
    monthFrom: Date.UTC(2026, 3, 30, 18, 15),
  })
  const now = Date.UTC(2026, 2, 8, 18)
  const report = { group: "day" as const, rows: [row("2026-03-07", 1, "recorded"), row("2026-03-08", 2, "recorded")], total: row("total"), rowCount: 2 }
  expect(dailySpend(report, now, "America/New_York").slice(-2).map((day) => [day.key, day.cost])).toEqual([["2026-03-07", 1], ["2026-03-08", 2]])
  expect(reportKey({ group: "day", timeZone: "America/New_York" })).not.toBe(reportKey({ group: "day" }))
})

test("usage report inputs stay identical within one day so revisits and preloads reuse the same reads", () => {
  const morning = Date.UTC(2026, 8, 27, 1)
  const evening = Date.UTC(2026, 8, 27, 22)
  expect(usageReportInputs(evening, undefined)).toEqual(usageReportInputs(morning, undefined))
  expect(usageReportInputs(morning, "Asia/Bangkok")).toEqual(usageReportInputs(Date.UTC(2026, 8, 27, 12), "Asia/Bangkok"))
  expect(usageReportInputs(evening, "Asia/Bangkok"), "a new local day starts new reads").not.toEqual(usageReportInputs(morning, "Asia/Bangkok"))
  const inputs = usageReportInputs(morning, "Asia/Bangkok")
  const bounds = usageBounds(morning, "Asia/Bangkok")
  expect(inputs.daily).toEqual({ group: "day", from: bounds.from, to: bounds.to, timeZone: "Asia/Bangkok", limit: 30, sort: "key", order: "asc" })
  expect(inputs.monthly).toEqual({ group: "model", from: bounds.monthFrom, to: bounds.to, timeZone: "Asia/Bangkok", limit: 200, sort: "cost", order: "desc" })
  expect(inputs.breakdown).toEqual({ group: "model", from: bounds.from, to: bounds.to, timeZone: "Asia/Bangkok", offset: 0, limit: 25, sort: "cost", order: "desc" })
  expect(usageReportInputs(morning, undefined, { group: "agent", offset: 25, sort: "tokens", order: "asc" }).breakdown).toEqual({
    group: "agent", from: usageBounds(morning).from, to: usageBounds(morning).to, offset: 25, limit: 25, sort: "tokens", order: "asc",
  })
})

test("older connectors reject new report groups and filters, which the page answers with an update prompt", () => {
  expect(reportNeedsNewerConnector({ group: "day", limit: 30 })).toBe(false)
  expect(reportNeedsNewerConnector({ group: "model", limit: 25 })).toBe(false)
  for (const input of [{ group: "prompt" as const }, { group: "task" as const }, { group: "provider-profile-model" as const }, { group: "model" as const, providerID: "openai" },
    { group: "model" as const, profile: "work" }, { group: "model" as const, modelID: "gpt" }, { group: "model" as const, selectedEffort: "high" }, { group: "day" as const, timeZone: "UTC" }])
    expect(reportNeedsNewerConnector(input)).toBe(true)
  expect(unsupportedReportMessage({ group: "task" })).toBe("Update YCoding on this machine to use this grouping or filter.")
  expect(unsupportedReportMessage({ group: "model", providerID: "openai", timeZone: "UTC" })).toBe("Update YCoding on this machine to use this grouping or filter.")
  expect(unsupportedReportMessage({ group: "day", timeZone: "UTC" })).toBe("Update YCoding on this machine to see Local usage. Switch to UTC to continue.")
  expect(unsupportedReportMessage({ group: "day" })).toBe("Update YCoding on this machine to see usage.")
})

test("a quota group heading appears once before its consecutive pivoted windows", () => {
  const windows = [
    { id: "overall", label: "Overall limit", unit: "percent" as const, used: 10 },
    { id: "Gemini Models/weekly", label: "Weekly limit", group: "Gemini Models", unit: "percent" as const, used: 25 },
    { id: "Gemini Models/five-hour", label: "Five hour limit", group: "Gemini Models", unit: "percent" as const, used: 100 },
    { id: "Claude and GPT models/weekly", label: "Weekly limit", group: "Claude and GPT models", unit: "percent" as const, used: 60 },
    { id: "Gemini 4 Argon/weekly", label: "Weekly limit", group: "Gemini 4 Argon", unit: "percent" as const, used: 0 },
  ]
  expect(windows.map((_, index) => quotaGroupHeading(windows, index))).toEqual([undefined, "Gemini Models", undefined, "Claude and GPT models", "Gemini 4 Argon"])
  expect(quotaGroupHeading([], 0)).toBeUndefined()
})

const ready = (asOf: number) =>
  ({ status: "ready", asOf, revision: `r${asOf}`, summary: {}, quota: { status: "ready", providers: [], forecast: { asOf, localScope: "backend" } } }) as unknown as UsageDashboardReady

test("a dashboard view separates preparing, error, unsupported, loading, and ready", () => {
  const current = ready(2)
  expect(usageDashboardView({ status: "idle" })).toEqual({ kind: "idle" })
  expect(usageDashboardView({ status: "loading" })).toEqual({ kind: "loading" })
  expect(usageDashboardView({ status: "unsupported" })).toEqual({ kind: "unsupported" })
  expect(usageDashboardView({ status: "ready", data: current })).toEqual({ kind: "ready", info: current, refreshing: false, stale: false })
  expect(usageDashboardView({ status: "loading", data: current })).toEqual({ kind: "ready", info: current, refreshing: true, stale: false })
  expect(usageDashboardView({ status: "ready", data: { status: "preparing" } })).toEqual({ kind: "preparing" })
  expect(usageDashboardView({ status: "ready", data: { status: "error", message: "Prepared read failed" } })).toEqual({ kind: "error", message: "Prepared read failed" })
})

test("a ready dashboard that goes Preparing or fails exposes no data from the invalidated envelope", () => {
  const cached = ready(1)
  const preparing = usageDashboardView({ status: "ready", data: { status: "preparing" } })
  expect("info" in preparing).toBe(false)
  const failed = usageDashboardView({ status: "error", data: cached, message: "Transport failed" })
  expect(failed).toEqual({ kind: "error", message: "Transport failed" })
  expect("info" in failed).toBe(false)
  const unsupported = usageDashboardView({ status: "unsupported", data: cached })
  expect("info" in unsupported).toBe(false)
  const switched = usageDashboardView({ status: "loading" })
  expect(switched).toEqual({ kind: "loading" })
})

test("a pending or failed different recipe keeps the last displayed accounting under its old identity, never the quota envelope after a failure", () => {
  const envelope = ready(1)
  const accounting = { daily: envelope.daily, monthly: envelope.monthly, breakdown: envelope.breakdown }
  expect(usageDashboardView({ status: "loading" }, { sameRecipe: false, accounting, envelope })).toEqual({ kind: "ready", info: envelope, refreshing: true, stale: true })
  expect(usageDashboardView({ status: "loading" }, { sameRecipe: false, accounting })).toEqual({ kind: "loading", retained: accounting })
  expect(usageDashboardView({ status: "error", message: "Page failed" }, { sameRecipe: false, accounting, envelope })).toEqual({ kind: "error", message: "Page failed", retained: accounting })
  expect(usageDashboardView({ status: "error", message: "Refresh failed" }, { sameRecipe: true, accounting, envelope })).toEqual({ kind: "error", message: "Refresh failed" })
  expect(usageDashboardView({ status: "ready", data: { status: "preparing" } }, { sameRecipe: false, accounting, envelope })).toEqual({ kind: "preparing" })
  expect(usageDashboardView({ status: "ready", data: { status: "error", message: "Envelope failed" } }, { sameRecipe: false, accounting, envelope })).toEqual({ kind: "error", message: "Envelope failed" })
  expect(usageDashboardView({ status: "unsupported" }, { sameRecipe: false, accounting, envelope })).toEqual({ kind: "unsupported" })
  expect(usageDashboardView({ status: "idle" }, { sameRecipe: false, accounting, envelope })).toEqual({ kind: "idle" })
})

test("accounting stays readable while quota is preparing, and quota arrival adds providers and forecast without changing the accounting sections", () => {
  const accounting = { daily: { group: "day", rows: [], total: {}, rowCount: 0 }, monthly: { group: "model", rows: [], total: {}, rowCount: 0 }, breakdown: { group: "model", rows: [], total: {}, rowCount: 0 } }
  const pending = { ...ready(1), ...accounting, quota: { status: "preparing" } } as unknown as UsageDashboardReady
  const arrived = { ...pending, quota: { status: "ready", providers: [], forecast: { asOf: 2, localScope: "backend" } } } as unknown as UsageDashboardReady
  const first = usageDashboardView({ status: "ready", data: pending })
  const second = usageDashboardView({ status: "ready", data: arrived })
  expect(first).toMatchObject({ kind: "ready", refreshing: false, stale: false })
  expect(usageQuotaView(pending)).toEqual({ kind: "preparing" })
  expect(usageQuotaView(arrived)).toEqual({ kind: "ready", providers: [], forecast: { asOf: 2, localScope: "backend" } })
  expect(usageQuotaView(undefined)).toEqual({ kind: "none" })
  if (first.kind !== "ready" || second.kind !== "ready") throw new Error("expected ready views")
  expect(second.info.daily).toBe(first.info.daily)
  expect(second.info.monthly).toBe(first.info.monthly)
  expect(second.info.breakdown).toBe(first.info.breakdown)
})

test("a quota error is its own quota state with the server message while accounting stays readable", () => {
  const failed = { ...ready(1), quota: { status: "error", message: "Provider quotas are unavailable right now." } } as unknown as UsageDashboardReady
  expect(usageQuotaView(failed)).toEqual({ kind: "error", message: "Provider quotas are unavailable right now." })
  expect(usageDashboardView({ status: "ready", data: failed })).toEqual({ kind: "ready", info: failed, refreshing: false, stale: false })
})

test("the daily report follows the provider and model selection and no other breakdown filter", () => {
  const now = Date.UTC(2026, 9, 28, 12)
  expect(usageReportInputs(now, undefined).daily).not.toHaveProperty("providerID")
  const filtered = usageReportInputs(now, undefined, { group: "model", offset: 0, sort: "cost", order: "desc", providerID: "openai", modelID: "gpt-6-sol", profile: "Work", selectedEffort: "high" })
  expect(filtered.daily).toMatchObject({ group: "day", providerID: "openai", modelID: "gpt-6-sol", limit: 30 })
  expect(filtered.daily).not.toHaveProperty("profile")
  expect(filtered.daily).not.toHaveProperty("selectedEffort")
  expect(reportKey(filtered.daily)).not.toBe(reportKey(usageReportInputs(now, undefined).daily))
  expect(filtered.monthly).not.toHaveProperty("providerID")
})
