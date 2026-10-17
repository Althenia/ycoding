/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ScrollBoxRenderable } from "@opentui/core"
import type { UsageReportOutput, ProviderRequestSummary, ProviderUsageListOutput, ProviderUsageForecastOutput } from "@ycoding-ai/client"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
import { ProviderUsageScreenContent } from "../src/routes/session/provider-usage"
import type { ProviderUsageView } from "../src/routes/session/provider-usage-reports"
import { DialogProvider } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { stringWidth } from "../src/util/string-width"

type ReportInput = {
  group: UsageReportOutput["group"]
  from?: number
  to?: number
  offset?: number
  limit?: number
  sort?: "key" | "tokens" | "cost" | "steps" | "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite"
  order?: "asc" | "desc"
  providerID?: string
  profile?: string
  modelID?: string
  selectedEffort?: string
}

const usage: ProviderRequestSummary = {
  logical: 6,
  physical: 7,
  helpers: 1,
  continued: 1,
  fallback: 0,
  tokens: { input: 12_000, output: 2_000, reasoning: 400, cache: { read: 8_000, write: 500 } },
  cacheReadReported: true,
  cost: 3.25,
}

const snapshots: ProviderUsageListOutput["data"] = [
  {
    providerID: "openai",
    label: "OpenAI plan",
    status: "available",
    source: "provider_api",
    stability: "stable",
    updatedAt: Date.UTC(2026, 8, 22),
    windows: [],
  },
]

function metrics(input: {
  logical: number
  tokens: number
  cost?: number
  provenance?: "recorded" | "current_catalog"
  cacheReadReported?: boolean
  unpriced?: number
}) {
  return {
    logical: input.logical,
    physical: input.logical + 1,
    helpers: 0,
    continued: 0,
    fallback: 0,
    costCoverage: { pricedRequests: input.cost === undefined ? 0 : input.logical + 1 - (input.unpriced ?? 0), unpricedRequests: input.cost === undefined ? input.logical + 1 : input.unpriced ?? 0 },
    tokens: {
      input: input.tokens,
      output: Math.floor(input.tokens / 10),
      reasoning: Math.floor(input.tokens / 40),
      cache: { read: Math.floor(input.tokens / 5), write: Math.floor(input.tokens / 20) },
    },
    ...(input.cost === undefined ? {} : { cost: input.cost }),
    ...(input.provenance === undefined ? {} : { costProvenance: input.provenance }),
    ...(input.cacheReadReported === undefined ? {} : { cacheReadReported: input.cacheReadReported }),
  }
}

function page(
  group: UsageReportOutput["group"],
  rows: Array<{ key: string; label: string } & ReturnType<typeof metrics>>,
  rowCount = rows.length,
  nextOffset?: number,
): UsageReportOutput {
  return {
    group,
    rows,
    rowCount,
    total: metrics({
      logical: rows.reduce((total, row) => total + row.logical, 0),
      tokens: rows.reduce((total, row) => total + row.tokens.input, 0),
      cost: rows.every((row) => row.cost !== undefined) ? rows.reduce((total, row) => total + (row.cost ?? 0), 0) : undefined,
      provenance: rows.some((row) => row.costProvenance === "current_catalog") ? "current_catalog" : "recorded",
      cacheReadReported: rows.every((row) => row.cacheReadReported === true),
    }),
    ...(nextOffset === undefined ? {} : { nextOffset }),
  }
}

async function renderUsage(input: {
  width?: number
  height?: number
  summary?: ProviderRequestSummary
  load: (query: ReportInput) => Promise<UsageReportOutput>
  onBack?: () => void
  initialTab?: ProviderUsageView
  forecast?: ProviderUsageForecastOutput["data"]
  snapshots?: ProviderUsageListOutput["data"]
  mode?: "dark" | "light"
  refreshing?: boolean
}) {
  const config = createTuiResolvedConfig()
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <Keymap.Provider config={config}>
            <ThemeProvider mode={input.mode ?? "dark"} source={{ discover: () => Promise.resolve({}) }}>
              <ToastProvider>
                <DialogProvider>
                  <ProviderUsageScreenContent
                    snapshots={() => input.snapshots ?? snapshots}
                    backendUsage={() => input.summary ?? usage}
                    now={() => Date.UTC(2026, 8, 22, 12)}
                    loadReport={input.load}
                    onBack={input.onBack}
                    initialTab={input.initialTab}
                    forecast={() => input.forecast}
                    refreshing={() => input.refreshing ?? false}
                  />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: input.width ?? 189, height: input.height ?? 40 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Usage"))
  return app
}

async function waitFor(app: Awaited<ReturnType<typeof renderUsage>>, predicate: (frame: string) => boolean, label: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const frame = app.captureCharFrame()
    if (predicate(frame)) return frame
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${label}\n${app.captureCharFrame()}`)
}

test.each([{ local: false, quota: false }, { local: true, quota: true }, { local: true, quota: false }, { local: false, quota: true }])("forecast populations distinguish unavailable from successful empty reads: %j", async (available) => {
  const app = await renderUsage({ initialTab: "usage", forecast: { asOf: Date.UTC(2026, 8, 22, 12), localScope: "backend", ...(available.local ? { localRates: [] } : {}), ...(available.quota ? { quotas: [] } : {}) }, load: async (input) => page(input.group, []) })
  try {
    await waitFor(app, (frame) => frame.includes(available.local ? "No recorded consumption" : "Recorded consumption unavailable"), "forecast population state")
    const frame = app.captureCharFrame()
    expect(frame.includes("Quota forecasts unavailable")).toBe(!available.quota)
    expect(frame.includes("Recorded consumption unavailable")).toBe(!available.local)
    expect(frame.includes("No recorded consumption")).toBe(available.local)
  } finally { app.renderer.destroy() }
})

test("usage grouping, selected effort, measured populations and missing Session titles render from frozen report fields", async () => {
  const calls: ReportInput[] = []
  const app = await renderUsage({ width: 100, height: 32, initialTab: "models", load: async (query) => {
    calls.push(query)
    const result = page(query.group, [{ key: query.group === "session" ? "ses_deleted" : "typed-group", label: query.group === "session" ? "" : "Measured model", ...metrics({ logical: 2, tokens: 100, cost: 10, provenance: "recorded", unpriced: 1 }) }])
    return { ...result, rows: result.rows.map((row) => ({ ...row, ...(query.group === "provider-profile-model" ? { dimensions: { group: "provider-profile-model" as const, providerID: "openai", modelID: "shared", profileState: "provider-default" as const } } : {}),
      speed: { generationSamples: 4, generationP50TokensPerSecond: 30, generationP90TokensPerSecond: 60, providerTimedSamples: 1, observedSamples: 3, samples: 2 } })) }
  } })
  try {
    await waitFor(app, (frame) => frame.includes("Measured model"), "model row")
    app.mockInput.pressEnter()
    await waitFor(app, (frame) => frame.includes("Usage details"), "measured details")
    expect(app.captureCharFrame()).toContain("median 30.0 tok/s")
    expect(app.captureCharFrame()).toContain("4 measured requests")
    expect(app.captureCharFrame()).toContain("Known $10.00 + unreported")
    app.mockInput.pressEscape()
    await waitFor(app, (frame) => !frame.includes("Usage details"), "first details dismissal")
    app.mockInput.pressKey("e")
    await waitFor(app, (frame) => frame.includes("Leave empty for all"), "effort filter")
    await app.mockInput.typeText("high")
    app.mockInput.pressEnter()
    await waitFor(app, () => calls.at(-1)?.selectedEffort === "high", "filtered request")
    app.mockInput.pressKey("b")
    await waitFor(app, (frame) => frame.includes("Usage group"), "group picker")
    await app.mockInput.typeText("Provider / profile / model")
    app.mockInput.pressEnter()
    await waitFor(app, (frame) => calls.at(-1)?.group === "provider-profile-model" && frame.includes("Measured model") && !frame.includes("Usage group"), "typed grouping")
    app.mockInput.pressEnter()
    await waitFor(app, (frame) => frame.includes("Provider default at request time"), "historical profile identity")
    app.mockInput.pressEscape()
    await waitFor(app, (frame) => !frame.includes("Usage details"), "profile details dismissal")
    app.mockInput.pressKey("b")
    await waitFor(app, (frame) => frame.includes("Usage group"), "second group picker")
    await app.mockInput.typeText("Sessions")
    await waitFor(app, (frame) => frame.includes("Sessions") && !frame.includes("Provider / profile / model"), "filtered Session group")
    app.mockInput.pressEnter()
    await waitFor(app, (frame) => frame.includes("Session ses_deleted · title unreported"), "retained deleted Session")
    expect(calls.at(-1)?.group).toBe("session")
  } finally { app.renderer.destroy() }
})

test("overview distinguishes recorded profile selections without changing total spend", async () => {
  const tokens = { input: 6_000, output: 1_000, reasoning: 200, cache: { read: 4_000, write: 250 } }
  const app = await renderUsage({
    summary: {
      ...usage,
      models: [
        { model: { providerID: "openai", id: "shared", variant: "high", profile: "Work" }, requests: 3, tokens, cost: 1, cacheReadReported: true },
        { model: { providerID: "openai", id: "shared", variant: "high", profile: "Personal" }, requests: 3, tokens, cost: 2.25, cacheReadReported: true },
      ],
    },
    load: async (query) => page(query.group, []),
  })
  try {
    await app.waitForFrame((frame) => frame.includes("openai/shared"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("openai/shared · selected effort high · profile Work")
    expect(frame).toContain("openai/shared · selected effort high · profile Personal")
    expect(frame).toContain("Total")
    expect(frame).toContain("$3.25")
  } finally {
    app.renderer.destroy()
  }
})

test("cycles ten direct views by arrows and tabs and opens views by mouse", async () => {
  const calls: ReportInput[] = []
  const app = await renderUsage({
    load: async (query) => {
      calls.push(query)
      return page(query.group, [{ key: query.group, label: `${query.group} row`, ...metrics({ logical: 2, tokens: 2_000, cost: 1, provenance: "recorded", cacheReadReported: true }) }])
    },
  })
  try {
    let frame = await waitFor(app, (value) => value.includes("Total") && value.includes("12,000"), "Overview")
    expect(frame).not.toContain("1 Overview")
    expect(frame).not.toContain("2 Reports")
    expect(frame).not.toContain("3 Provider quotas")

    app.mockInput.pressKey("ARROW_RIGHT")
    await waitFor(app, (value) => value.includes("OpenAI plan"), "Usage provider quotas")
    app.mockInput.pressKey("TAB")
    await waitFor(app, () => calls.at(-1)?.group === "model", "Models")
    app.mockInput.pressKey("TAB")
    await waitFor(app, () => calls.at(-1)?.group === "day", "Daily")
    app.mockInput.pressKey("ARROW_RIGHT")
    await waitFor(app, () => calls.at(-1)?.group === "hour", "Hourly")
    app.mockInput.pressKey("ARROW_RIGHT")
    await waitFor(app, () => calls.at(-1)?.group === "month", "Monthly")
    app.mockInput.pressKey("ARROW_RIGHT")
    await waitFor(app, () => calls.at(-1)?.group === "session", "Sessions")
    app.mockInput.pressKey("ARROW_RIGHT")
    await waitFor(app, () => calls.at(-1)?.group === "project", "Projects")
    app.mockInput.pressKey("TAB")
    await waitFor(app, (value) => calls.at(-1)?.group === "day" && value.includes("Activity graph"), "Stats")
    app.mockInput.pressKey("ARROW_RIGHT")
    await waitFor(app, () => calls.at(-1)?.group === "agent", "Agents")
    app.mockInput.pressKey("TAB", { shift: true })
    await waitFor(app, (value) => calls.at(-1)?.group === "day" && value.includes("Activity graph"), "shift-tab previous view")
    app.mockInput.pressKey("ARROW_LEFT")
    await waitFor(app, () => calls.at(-1)?.group === "project", "left previous view")

    frame = app.captureCharFrame()
    const agentsRow = frame.split("\n").findIndex((line) => line.includes("Agents"))
    await app.mockMouse.click(frame.split("\n")[agentsRow].indexOf("Agents") + 1, agentsRow)
    await waitFor(app, () => calls.at(-1)?.group === "agent", "mouse Agents view")
  } finally {
    app.renderer.destroy()
  }
}, 30_000)

test("requests server sorting before bounded pagination and gives selection, details, and escape precedence", async () => {
  const calls: ReportInput[] = []
  let backs = 0
  const firstRows = [
    { key: "alpha", label: "Alpha", ...metrics({ logical: 2, tokens: 2_000, cost: 10, provenance: "recorded", cacheReadReported: true }) },
    { key: "beta", label: "Beta", ...metrics({ logical: 5, tokens: 1_000, cost: 1, provenance: "recorded", cacheReadReported: true }) },
  ]
  const finalRows = [
    { key: "gamma", label: "Gamma", ...metrics({ logical: 3, tokens: 5_000, cost: 20, provenance: "current_catalog", cacheReadReported: false }) },
  ]
  const unknown = { key: "delta", label: "Delta", ...metrics({ logical: 1, tokens: 500, cacheReadReported: false }) }
  const app = await renderUsage({
    width: 80,
    height: 24,
    onBack: () => backs++,
    load: async (query) => {
      calls.push(query)
      if (query.sort === "cost" && query.order === "desc") return page(query.group, [finalRows[0], firstRows[0], firstRows[1], unknown], 4)
      if (query.sort === "cost" && query.order === "asc") return page(query.group, [firstRows[1], firstRows[0], finalRows[0], unknown], 4)
      if (query.sort === "tokens" && query.order === "desc") return page(query.group, [finalRows[0], firstRows[0], firstRows[1], unknown], 4)
      if (query.sort === "tokens" && query.order === "asc") return page(query.group, [unknown, firstRows[1], firstRows[0], finalRows[0]], 4)
      if (query.sort === "key" && query.order === "desc") return page(query.group, [unknown, finalRows[0], firstRows[1], firstRows[0]], 4)
      return page(query.group, firstRows, 4, 2)
    },
  })
  try {
    app.mockInput.pressKey("ARROW_RIGHT")
    app.mockInput.pressKey("ARROW_RIGHT")
    let frame = await waitFor(app, (value) => value.includes("Alpha") && value.includes("Gamma"), "the Models report")
    expect(calls.map((call) => ({ group: call.group, offset: call.offset, limit: call.limit, sort: call.sort, order: call.order }))).toEqual([
      { group: "model", offset: 0, limit: 100, sort: "tokens", order: "desc" },
    ])
    expect(frame).toContain("> Gamma")
    expect(frame.split("\n").every((line) => line.length <= 80)).toBe(true)

    app.mockInput.pressKey("d")
    await waitFor(app, (value) => value.includes("> Alpha"), "key ascending sort")
    expect(calls.at(-1)).toMatchObject({ group: "model", offset: 0, sort: "key", order: "asc" })
    app.mockInput.pressKey("d")
    await waitFor(app, (value) => value.includes("> Delta"), "key descending sort")
    expect(calls.at(-1)).toMatchObject({ group: "model", offset: 0, sort: "key", order: "desc" })
    app.mockInput.pressKey("c")
    frame = await waitFor(app, (value) => value.includes("> Gamma"), "global cost descending sort")
    expect(calls.at(-1)).toMatchObject({ group: "model", offset: 0, sort: "cost", order: "desc" })
    expect(frame).toContain("$20.00")
    expect(frame).not.toContain("est.")
    app.mockInput.pressKey("c")
    await waitFor(app, (value) => value.includes("> Beta"), "global cost ascending sort")
    expect(calls.at(-1)).toMatchObject({ group: "model", offset: 0, sort: "cost", order: "asc" })
    app.mockInput.pressKey("t")
    await waitFor(app, (value) => value.includes("> Gamma"), "global token descending sort")
    expect(calls.at(-1)).toMatchObject({ group: "model", offset: 0, sort: "tokens", order: "desc" })
    app.mockInput.pressKey("t")
    await waitFor(app, (value) => value.includes("> Delta"), "global token ascending sort")
    expect(calls.at(-1)).toMatchObject({ group: "model", offset: 0, sort: "tokens", order: "asc" })
    app.mockInput.pressKey("t")
    await waitFor(app, (value) => value.includes("> Gamma"), "global token descending sort restored")
    app.mockInput.pressKey("RETURN")
    frame = await waitFor(app, (value) => value.includes("Usage details") && value.includes("Gamma"), "unknown token details")
    expect(frame).not.toContain("output subset")
    expect(frame).toContain("Visible output")
    expect(frame).toContain("Cache read ≥1,000")
    expect(frame).toContain("Total tokens ≥6,875 · Cost $20.00")
    expect(frame).not.toContain("estimated")
    app.mockInput.pressKey("ESCAPE")
    await waitFor(app, (value) => !value.includes("Usage details"), "unknown details dismissal")
    app.mockInput.pressKey("ARROW_DOWN")
    await waitFor(app, (value) => value.includes("> Alpha"), "reported token row")
    app.mockInput.pressKey("RETURN")
    frame = await waitFor(app, (value) => value.includes("Usage details") && value.includes("Alpha"), "reported token details")
    expect(frame).toContain("Total tokens 2,750")
    app.mockInput.pressKey("ESCAPE")
    await waitFor(app, (value) => !value.includes("Usage details"), "reported details dismissal")
    app.mockInput.pressKey("HOME")
    app.mockInput.pressKey("END")
    await waitFor(app, (value) => value.includes("> Delta"), "End selection")
    app.mockInput.pressKey("HOME")
    await waitFor(app, (value) => value.includes("> Gamma"), "Home selection")
    app.renderer.stdin.emit("data", Buffer.from("\u001b[6~"))
    await waitFor(app, (value) => value.includes("> Delta"), "PageDown selection")
    app.renderer.stdin.emit("data", Buffer.from("\u001b[5~"))
    await waitFor(app, (value) => value.includes("> Gamma"), "PageUp selection")
    app.mockInput.pressKey("RETURN")
    await waitFor(app, (value) => value.includes("Usage details") && value.includes("Gamma"), "row details")
    app.mockInput.pressKey("ESCAPE")
    await waitFor(app, (value) => !value.includes("Usage details"), "details dismissal")
    expect(backs).toBe(0)
    app.mockInput.pressKey("ESCAPE")
    await waitFor(app, () => backs === 1, "back after details")
    expect(backs).toBe(1)
  } finally {
    app.renderer.destroy()
  }
}, 30_000)

test("derives a full-width colored Stats graph and summary from daily, model, and session reports", async () => {
  const calls: ReportInput[] = []
  const app = await renderUsage({
    load: async (query) => {
      calls.push(query)
      if (query.group === "model")
        return page("model", [{ key: "openai/gpt-6-luna", label: "openai/gpt-6-luna", ...metrics({ logical: 7, tokens: 7_000, cacheReadReported: true }) }], 3)
      if (query.group === "session") return page("session", [], 7)
      if ((query.offset ?? 0) === 0)
        return page(
          query.group,
          [
            { key: "2026-09-16", label: "2026-09-16", ...metrics({ logical: 1, tokens: 1_000, cost: 0.5, provenance: "recorded", cacheReadReported: true }) },
            { key: "2026-09-21", label: "2026-09-21", ...metrics({ logical: 2, tokens: 2_000, cost: 1, provenance: "recorded", cacheReadReported: true }) },
          ],
          201,
          200,
        )
      return page(
        query.group,
        [{ key: "2026-09-22", label: "2026-09-22", ...metrics({ logical: 4, tokens: 4_000, cacheReadReported: false }) }],
        201,
      )
    },
  })
  try {
    for (let index = 0; index < 8; index++) app.mockInput.pressKey("ARROW_RIGHT")
    const frame = await waitFor(
      app,
      (value) => value.includes("Activity graph · last 52 weeks") && value.includes("Busiest day"),
      "Stats graph and summary",
    )
    const lines = frame.split("\n")
    const spans = app.captureSpans().lines
    const row = (label: string) => lines.findIndex((line) => new RegExp(`^\\s*${label} `).test(line))
    const origin = lines[row("Sun")].indexOf("Sun") + 4
    const cellColor = (label: string, week: number) => {
      const column = origin + week * 3
      const found = spans[row(label)].spans.reduce<{ start: number; color?: string }>(
        (state, span) => ({
          start: state.start + span.text.length,
          color: state.color ?? (column >= state.start && column < state.start + span.text.length ? span.fg.toInts().join(",") : undefined),
        }),
        { start: 0 },
      )
      return found.color
    }
    expect(lines[row("Tue")].trimEnd()).toHaveLength(origin + 52 * 3)
    expect(lines[row("Sun") - 1]).toContain("Sep")
    expect(lines[row("Sun") - 1]).toContain("Oct")
    const colors = [cellColor("Mon", 0), cellColor("Wed", 50), cellColor("Mon", 51), cellColor("Tue", 51)]
    expect(new Set(colors).size).toBe(4)
    expect(cellColor("Thu", 0)).toBe(colors[0])
    expect(lines[row("Wed")].slice(origin + 51 * 3).trim()).toBe("")
    expect(frame).toContain("Favorite model: openai/gpt-6-luna")
    expect(frame).toContain("Sessions: 7")
    expect(frame).toContain("Current streak: 2 days")
    expect(frame).toContain("Longest streak: 2 days")
    expect(frame).toContain("Active days: 3/360")
    expect(frame).toContain("Total tokens: 4,125")
    expect(frame).toContain("Total cost: $1.50")
    expect(frame).toContain("Busiest day: 2026-09-22 · ≥5,500 tokens")
    expect(frame).not.toContain("Usage before 2026-09-16")
    expect(frame).not.toContain("est.")
    expect(calls.filter((call) => call.limit === 200).map((call) => ({ group: call.group, offset: call.offset, limit: call.limit }))).toEqual([
      { group: "day", offset: 0, limit: 200 },
      { group: "day", offset: 200, limit: 200 },
    ])
    expect(calls.filter((call) => call.limit === 1).map((call) => ({ group: call.group, sort: call.sort, order: call.order }))).toEqual([
      { group: "model", sort: "tokens", order: "desc" },
      { group: "session", sort: "key", order: "asc" },
    ])
  } finally {
    app.renderer.destroy()
  }
}, 30_000)

const quotaUpdatedAt = Date.UTC(2026, 8, 22, 11, 30)
const quotaSnapshots: ProviderUsageListOutput["data"] = [{
  providerID: "openai", label: "OpenAI plan", profile: "Work", status: "available", source: "provider_api", stability: "stable", updatedAt: quotaUpdatedAt,
  windows: ["five", "weekly", "monthly", "flat", "stale", "bare"].map((id) => ({ id, label: `Window ${id}`, unit: "percent" as const, used: id === "monthly" ? 100 : id === "five" ? 80 : 40 })),
}]
const quotaForecast = (windowID: string, extra: Partial<NonNullable<ProviderUsageForecastOutput["data"]["quotas"]>[number]>) => ({
  providerID: "openai", profile: "Work", windowID, unit: "percent" as const, source: "provider_api" as const, stability: "stable" as const, updatedAt: quotaUpdatedAt,
  state: "insufficient" as const, evidence: "insufficient" as const, ...extra,
})
const detailForecast: ProviderUsageForecastOutput["data"] = {
  asOf: Date.UTC(2026, 8, 22, 12), localScope: "backend",
  quotas: [
    quotaForecast("five", { state: "estimated", method: "quota-delta-ema", evidence: "medium", ratePerHour: 20, exhaustionAt: Date.UTC(2026, 8, 22, 15), observedFrom: quotaUpdatedAt - 3_600_000, observedTo: quotaUpdatedAt }),
    quotaForecast("weekly", { reason: "Warming up after restart, 3 samples" }),
    quotaForecast("monthly", { state: "exhausted", evidence: "low" }),
    quotaForecast("flat", { reason: "No increase observed" }),
    quotaForecast("stale", { reason: "Observation stale: 2h old" }),
  ],
  localRates: [
    { providerID: "openai", profile: "Work", modelID: "gpt-5", observedFrom: Date.UTC(2026, 8, 22, 11), observedTo: Date.UTC(2026, 8, 22, 12), tokensPerMinute: 1234.567, tokensPerMinute5: 1500, tokensPerMinute60: 1100, estimatedUSDPerHour: 0.42, coverage: { pricedRequests: 3, unpricedRequests: 1 } },
    { providerID: "openai", modelID: "mini", observedFrom: Date.UTC(2026, 8, 22, 11), observedTo: Date.UTC(2026, 8, 22, 12), tokensPerMinute: 0.04, coverage: { pricedRequests: 0, unpricedRequests: 2 } },
  ],
}

const longModel = "claudesonnet45extendedthinkingpreview20250929xyz"
const boundaryForecast: ProviderUsageForecastOutput["data"] = {
  ...detailForecast,
  localRates: [
    ...detailForecast.localRates!,
    { providerID: "anthropic", profile: "研究チーム", modelID: longModel, observedFrom: Date.UTC(2026, 8, 22, 11), observedTo: Date.UTC(2026, 8, 22, 12), tokensPerMinute: 2_500_000.5, tokensPerMinute5: 2_600_000, tokensPerMinute60: 2_400_000, estimatedUSDPerHour: 1234.5, coverage: { pricedRequests: 9, unpricedRequests: 2 } },
    { providerID: "xai", modelID: "grok-mini", observedFrom: Date.UTC(2026, 8, 22, 11), observedTo: Date.UTC(2026, 8, 22, 12), tokensPerMinute: 3, estimatedUSDPerHour: 0.004, coverage: { pricedRequests: 2, unpricedRequests: 0 } },
  ],
}
const compactText = [
  "OpenAI plan · Work · updated 30m", "Window five ████████░░ 80% used", "Estimated exhaustion 2026-09-22T15:00:00.000Z · medium evidence",
  "Window weekly ████░░░░░░ 40% used", "Forecast unavailable", "Window monthly ██████████ 100% used", "Exhausted", "No increase observed", "Forecast stale",
  "Forecast unavailable · No matching quota observation", "Recorded consumption · Backend",
  "openai · Work · gpt-5", "1,235 tok/min", "~$0.42/hour partial", "openai · provider default · mini", "<0.1 tok/min", "$/hour unreported",
  `anthropic · 研究チーム · ${longModel}`, "2,500,001 tok/min", "~$1234.50/hour partial", "xai · provider default · grok-mini", "3 tok/min", "<$0.01/hour",
]
const detailText = [
  "Source provider API · Stability stable", "Recent quota deltas · 15m half-life · 1h horizon · medium evidence", "Quota burn 20 percentage points/hour",
  "Observed 2026-09-22T10:30:00.000Z – 2026-09-22T11:30:00.000Z", "Updated 30m ago", "Warming up after restart, 3 samples", "Observation stale: 2h old",
  "Recorded consumption 1234.567 tokens/min · 5m 1500 · 60m 1100", "Estimated cost $0.42/hour · 3 priced / 1 unpriced", "60m unreported", "provider default at request time",
  `anthropic · profile 研究チーム · ${longModel}`, "Recorded consumption 2500000.5 tokens/min · 5m 2600000 · 60m 2400000", "Estimated cost $1234.5/hour · 9 priced / 2 unpriced",
  "Estimated cost $0.004/hour · 2 priced / 0 unpriced", "Observed 2026-09-22T11:00:00.000Z – 2026-09-22T12:00:00.000Z", "Local recorded consumption · not provider quota",
]
const strip = (value: string) => value.replace(/\s/g, "")

async function scrolledUsage(app: Awaited<ReturnType<typeof renderUsage>>) {
  const walk = (node: { getChildren?: () => unknown[] }): unknown[] => [node, ...(node.getChildren?.() ?? []).flatMap((child) => walk(child as { getChildren?: () => unknown[] }))]
  const scroll = walk(app.renderer.root).find((node): node is ScrollBoxRenderable => node instanceof ScrollBoxRenderable)!
  expect(scroll.verticalScrollBar.visible).toBe(true)
  const cells = (row: string, from: number, to: number) => {
    let column = 0
    return [...row].filter((character) => {
      const start = column
      column += Math.max(1, stringWidth(character))
      return start >= from && column <= to
    }).join("")
  }
  const viewport = () => app.captureCharFrame().split("\n").slice(scroll.viewport.screenY, scroll.viewport.screenY + scroll.viewport.height).map((row) => cells(row, scroll.viewport.screenX, scroll.viewport.screenX + scroll.viewport.width))
  scroll.scrollTo(0)
  await app.renderOnce()
  const rows = viewport()
  for (let step = 0; step < 400; step++) {
    const top = scroll.scrollTop
    scroll.scrollBy(1)
    await app.renderOnce()
    if (scroll.scrollTop === top) break
    rows.push(viewport().at(-1)!)
  }
  scroll.scrollTo(0)
  await app.renderOnce()
  return strip(rows.join(""))
}

test.each([{ width: 60, mode: "dark" as const }, { width: 40, mode: "dark" as const }, { width: 189, mode: "light" as const }])("usage view keeps every character within the scrolling column, compact by default and one Details toggle away at $width $mode", async ({ width, mode }) => {
  const app = await renderUsage({ width, height: 24, mode, initialTab: "usage", snapshots: quotaSnapshots, forecast: boundaryForecast, load: async (input) => page(input.group, []) })
  try {
    await waitFor(app, (frame) => frame.includes("Details"), "compact usage")
    await app.renderOnce()
    const compact = await scrolledUsage(app)
    for (const text of compactText) expect(compact).toContain(strip(text))
    for (const text of ["provider_api", "providerAPI", "Recentquotadeltas", "Warmingupafterrestart", "Observationstale", "Updated", "5m", "60m", "unpriced", "Observed", "generationspeed"])
      expect(compact).not.toContain(text)
    app.mockInput.pressKey("d")
    await waitFor(app, (frame) => frame.includes("Hide details"), "details")
    await app.renderOnce()
    const expanded = await scrolledUsage(app)
    for (const text of [...compactText.filter((text) => !/^Estimated exhaustion|^Forecast (unavailable|stale)$|^No increase observed$/.test(text)), ...detailText]) expect(expanded).toContain(strip(text))
    app.mockInput.pressKey("d")
    await waitFor(app, (frame) => frame.includes("Details · d") && !frame.includes("Hide details"), "details collapsed")
    const frame = app.captureCharFrame()
    const detailsRow = frame.split("\n").findIndex((row) => row.includes("Details · d"))
    await app.mockMouse.click(frame.split("\n")[detailsRow]!.indexOf("Details") + 1, detailsRow)
    await waitFor(app, (next) => next.includes("Hide details"), "details by mouse")
  } finally { app.renderer.destroy() }
})

test("recorded consumption rows align token and cost columns and keep the unavailable and empty states", async () => {
  const app = await renderUsage({ width: 120, height: 90, initialTab: "usage", snapshots: quotaSnapshots, forecast: detailForecast, load: async (input) => page(input.group, []) })
  try {
    await waitFor(app, (frame) => frame.includes("tok/min"), "rate rows")
    const rows = app.captureCharFrame().split("\n").filter((row) => row.includes("tok/min"))
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.indexOf("tok/min"))).size).toBe(1)
    expect(new Set(rows.map((row) => row.search(/~\$|\$\/hour/))).size).toBe(1)
  } finally { app.renderer.destroy() }
})

test.each(["dark", "light"] as const)("exhausted and warning forecasts use the severity ink of their quota bars in %s", async (mode) => {
  const app = await renderUsage({ width: 100, height: 60, mode, initialTab: "usage", snapshots: quotaSnapshots, forecast: detailForecast, load: async (input) => page(input.group, []) })
  try {
    await waitFor(app, (frame) => frame.includes("Exhausted"), "forecast states")
    const spans = app.captureSpans().lines.flatMap((line) => line.spans)
    const ink = (text: string) => spans.find((span) => span.text.includes(text))!.fg.toInts()
    const rows = app.captureCharFrame().split("\n")
    const barInk = (label: string) => app.captureSpans().lines[rows.findIndex((row) => row.includes(label))]!.spans.find((span) => span.text.includes("█"))!.fg.toInts()
    expect(ink("Exhausted")).toEqual(barInk("Window monthly"))
    expect(ink("Estimated exhaustion")).toEqual(barInk("Window five"))
    expect(ink("Exhausted")).not.toEqual(ink("Estimated exhaustion"))
    expect(ink("No increase observed")).not.toEqual(ink("Exhausted"))
    expect(ink("No increase observed")).not.toEqual(ink("Estimated exhaustion"))
    expect(ink("partial")).toEqual(ink("Estimated exhaustion"))
    expect(ink("partial")).not.toEqual(ink("~$0.42/hour"))
  } finally { app.renderer.destroy() }
})

test("loading, failed and unreported usage states stay explicit without forecasts", async () => {
  const loading = await renderUsage({ width: 80, height: 30, initialTab: "usage", snapshots: [], refreshing: true, load: async (input) => page(input.group, []) })
  try {
    await waitFor(loading, (frame) => frame.includes("Loading provider quotas..."), "loading")
    expect(loading.captureCharFrame()).toContain("Quota forecasts unavailable")
    expect(loading.captureCharFrame()).toContain("Recorded consumption unavailable")
  } finally { loading.renderer.destroy() }
  const unreported = await renderUsage({ width: 80, height: 40, initialTab: "usage", snapshots: [{ ...quotaSnapshots[0]!, windows: [{ id: "bare", label: "Window bare", unit: "percent" }] }, { ...quotaSnapshots[0]!, providerID: "empty", label: "Empty plan", profile: undefined, windows: [] }], load: async (input) => page(input.group, []) })
  try {
    await waitFor(unreported, (frame) => frame.includes("Quota information is not reported."), "unreported")
    const frame = unreported.captureCharFrame()
    expect(frame).toContain("Not reported")
    expect(frame).toContain("Forecast unavailable · Not loaded")
    expect(frame).not.toContain("Exhausted")
  } finally { unreported.renderer.destroy() }
})
