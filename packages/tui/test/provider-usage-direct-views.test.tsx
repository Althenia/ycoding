/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ProviderRequestReport, ProviderRequestSummary, ProviderUsageListOutput } from "@ycoding-ai/client"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
import { ProviderUsageScreenContent } from "../src/routes/session/provider-usage"
import { DialogProvider } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

type ReportInput = {
  group: ProviderRequestReport["group"]
  from?: number
  to?: number
  offset?: number
  limit?: number
  sort?: "key" | "tokens" | "cost"
  order?: "asc" | "desc"
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
}) {
  return {
    logical: input.logical,
    physical: input.logical + 1,
    helpers: 0,
    continued: 0,
    fallback: 0,
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
  group: ProviderRequestReport["group"],
  rows: Array<{ key: string; label: string } & ReturnType<typeof metrics>>,
  rowCount = rows.length,
  nextOffset?: number,
): ProviderRequestReport {
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
  load: (query: ReportInput) => Promise<ProviderRequestReport>
  onBack?: () => void
}) {
  const config = createTuiResolvedConfig()
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <Keymap.Provider config={config}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ToastProvider>
                <DialogProvider>
                  <ProviderUsageScreenContent
                    snapshots={() => snapshots}
                    backendUsage={() => usage}
                    now={() => Date.UTC(2026, 8, 22, 12)}
                    loadReport={input.load}
                    onBack={input.onBack}
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
    let frame = await waitFor(app, (value) => value.includes("Alpha") && value.includes("Beta"), "the Models report")
    expect(calls.map((call) => ({ group: call.group, offset: call.offset, limit: call.limit, sort: call.sort, order: call.order }))).toEqual([
      { group: "model", offset: 0, limit: 100, sort: "key", order: "asc" },
    ])
    expect(frame.split("\n").every((line) => line.length <= 80)).toBe(true)

    app.mockInput.pressKey("d")
    await waitFor(app, (value) => value.includes("> Delta"), "key descending sort")
    expect(calls.at(-1)).toMatchObject({ group: "model", offset: 0, sort: "key", order: "desc" })
    app.mockInput.pressKey("d")
    await waitFor(app, (value) => value.includes("> Alpha"), "key ascending sort")
    expect(calls.at(-1)).toMatchObject({ group: "model", offset: 0, sort: "key", order: "asc" })
    app.mockInput.pressKey("c")
    frame = await waitFor(app, (value) => value.includes("> Gamma"), "global cost descending sort")
    expect(calls.at(-1)).toMatchObject({ group: "model", offset: 0, sort: "cost", order: "desc" })
    expect(frame).toContain("$20.00 est.")
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
    expect(frame).toContain("Cache read -")
    expect(frame).toContain("Total tokens -")
    expect(frame).toContain("$20.00 estimated")
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

test("derives Stats from complete daily retained usage and labels retention coverage honestly", async () => {
  const calls: ReportInput[] = []
  const app = await renderUsage({
    load: async (query) => {
      calls.push(query)
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
      (value) =>
        calls.at(-1)?.group === "day" &&
        value.includes("Activity graph") &&
        value.toLowerCase().includes("retained") &&
        value.toLowerCase().includes("coverage"),
      "Stats retained coverage",
    )
    expect(frame).toContain("2026-09-21")
    expect(frame).toContain("2026-09-22")
    expect(frame.split("\n").find((line) => /^\s*Mon /.test(line))).toContain("▓")
    expect(frame.split("\n").find((line) => /^\s*Tue /.test(line))).toContain("█")
    expect(frame.split("\n").find((line) => /^\s*Wed /.test(line))?.indexOf("▒"))
      .toBe(frame.split("\n").find((line) => /^\s*Mon /.test(line))!.indexOf("▓") - 1)
    expect(frame).toContain("Unreported")
    expect(calls.filter((call) => call.limit === 200).map((call) => ({ group: call.group, offset: call.offset, limit: call.limit }))).toEqual([
      { group: "day", offset: 0, limit: 200 },
      { group: "day", offset: 200, limit: 200 },
    ])
  } finally {
    app.renderer.destroy()
  }
}, 30_000)
