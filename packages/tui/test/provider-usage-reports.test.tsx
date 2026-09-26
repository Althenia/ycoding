/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ProviderRequestReport } from "@ycoding-ai/client"
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

const now = Date.UTC(2026, 8, 22, 12)
const metrics = (logical: number, input = logical * 1_000) => ({
  logical,
  physical: logical + 1,
  helpers: 1,
  continued: 2,
  fallback: 1,
  tokens: { input, output: logical * 100, reasoning: logical * 25, cache: { read: logical * 80, write: logical * 10 } },
  cost: logical / 10,
  costProvenance: "current_catalog" as const,
  cacheReadReported: true,
})

function report(
  group: ProviderRequestReport["group"],
  rows: Array<{ key: string; label: string; logical: number }> = [
    { key: "alpha", label: "Alpha", logical: 4 },
    { key: "beta", label: "Beta", logical: 3 },
  ],
  options?: { rowCount?: number; nextOffset?: number },
): ProviderRequestReport {
  const values = rows.map((row) => ({ key: row.key, label: row.label, ...metrics(row.logical) }))
  return {
    group,
    rows: values,
    total: metrics(values.reduce((total, row) => total + row.logical, 0)),
    rowCount: options?.rowCount ?? values.length,
    ...(options?.nextOffset === undefined ? {} : { nextOffset: options.nextOffset }),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((pass, fail) => {
    resolve = pass
    reject = fail
  })
  return { promise, resolve, reject }
}

async function renderReports(input: {
  width?: number
  height?: number
  load: (query: ReportInput) => Promise<ProviderRequestReport>
  onRefresh?: () => void
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
                    snapshots={() => []}
                    now={() => now}
                    initialTab="models"
                    loadReport={input.load}
                    onRefresh={input.onRefresh}
                  />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: input.width ?? 189, height: input.height ?? 38 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Models"))
  return app
}

async function waitFor(app: Awaited<ReturnType<typeof renderReports>>, predicate: (frame: string) => boolean, label: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const frame = app.captureCharFrame()
    if (predicate(frame)) return frame
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${label}\n${app.captureCharFrame()}`)
}

test("defaults tables to all retained history and exposes normalized metrics plus explicit custom dates", async () => {
  const calls: ReportInput[] = []
  const app = await renderReports({
    load: async (query) => {
      calls.push(query)
      const value = report(query.group)
      value.rows[0] = {
        ...value.rows[0],
        tokens: { input: 4_000, output: 1_200, reasoning: 300, cache: { read: 0, write: 40 } },
        cost: undefined,
        costProvenance: undefined,
        cacheReadReported: undefined,
      }
      return value
    },
  })
  try {
    let frame = await waitFor(app, (value) => value.includes("All retained history") && value.includes("Alpha"), "the initial table")
    expect(calls[0]).toEqual({ group: "model", offset: 0, limit: 100, sort: "tokens", order: "desc" })
    for (const column of ["STEPS", "INPUT", "OUTPUT", "REASON", "CACHE READ", "CACHE WRITE", "TOTAL", "COST"]) expect(frame).toContain(column)
    expect(frame).toContain("STEPS model calls")
    expect(frame.split("\n").find((line) => line.includes("Alpha"))).toMatch(/\s-\s.*\s≥5,540\s/)
    expect(frame.split("\n").find((line) => line.includes("Beta"))).toContain("$0.30")
    expect(frame).not.toContain("est.")
    expect(frame).not.toContain("output subset")

    app.mockInput.pressKey("RETURN")
    frame = await waitFor(app, (value) => value.includes("Usage details") && value.includes("Alpha"), "usage details")
    expect(frame).toContain("Visible output 1,200")
    expect(frame).toContain("Reasoning 300")
    expect(frame).toContain("Cache read -")
    expect(frame).toContain("Total tokens ≥5,540 · Cost unreported")
    expect(frame).toContain("≥ marks a lower bound")
    app.mockInput.pressKey("ESCAPE")
    await waitFor(app, (value) => !value.includes("Usage details"), "details dismissal")

    app.mockInput.pressKey("f")
    await waitFor(app, (value) => value.includes("Usage range") && value.includes("Custom UTC range"), "range chooser")
    app.mockInput.pressKey("END")
    app.mockInput.pressKey("RETURN")
    await waitFor(app, (value) => value.includes("Date range (UTC)"), "custom range prompt")
    await app.mockInput.typeText("2026-09-01..2026-10-01")
    app.mockInput.pressKey("RETURN")
    await waitFor(
      app,
      (value) =>
        calls.at(-1)?.from === Date.UTC(2026, 8, 1) &&
        calls.at(-1)?.to === Date.UTC(2026, 9, 1) &&
        value.includes("2026-09-01 → 2026-10-01"),
      "custom retained range",
    )
  } finally {
    app.renderer.destroy()
  }
}, 30_000)

test("preserves selected identity on refresh and fences stale, failed, and changed-query results", async () => {
  const requests: Array<{ query: ReportInput; result: ReturnType<typeof deferred<ProviderRequestReport>> }> = []
  let refreshes = 0
  const app = await renderReports({
    load: (query) => {
      const result = deferred<ProviderRequestReport>()
      requests.push({ query, result })
      return result.promise
    },
    onRefresh: () => refreshes++,
  })
  try {
    await waitFor(app, () => requests.length === 1, "initial request")
    requests[0].result.resolve(report("model"))
    await waitFor(app, (value) => value.includes("> Alpha"), "initial selection")
    app.mockInput.pressKey("ARROW_DOWN")
    await waitFor(app, (value) => value.includes("> Beta"), "selected row")

    app.mockInput.pressKey("r")
    await waitFor(app, (value) => requests.length === 2 && value.includes("Refreshing · showing previous data") && value.includes("> Beta"), "stale refresh")
    app.mockInput.pressKey("r")
    await waitFor(app, () => requests.length === 3, "newer refresh")
    requests[2].result.resolve(report("model", [
      { key: "beta", label: "Beta refreshed", logical: 8 },
      { key: "charlie", label: "Charlie", logical: 2 },
    ]))
    await waitFor(app, (value) => value.includes("> Beta refreshed"), "identity-preserving result")
    requests[1].result.resolve(report("model", [{ key: "stale", label: "Stale result", logical: 99 }]))
    await Bun.sleep(50)
    expect(app.captureCharFrame()).not.toContain("Stale result")

    app.mockInput.pressKey("r")
    await waitFor(app, () => requests.length === 4, "failing refresh")
    requests[3].result.reject(new Error("offline"))
    await waitFor(app, (value) => value.includes("Refresh failed · showing stale data") && value.includes("Beta refreshed"), "stale error")

    app.mockInput.pressKey("ARROW_RIGHT")
    await waitFor(app, (value) => requests.length === 5 && value.includes("Loading usage") && !value.includes("Beta refreshed"), "changed-query loading")
    requests[4].result.resolve(report("day", [{ key: "2026-09-22", label: "2026-09-22", logical: 5 }]))
    await waitFor(app, (value) => value.includes("> 2026-09-22"), "changed-query result")
    expect(refreshes).toBe(3)
  } finally {
    app.renderer.destroy()
  }
}, 30_000)

test("pages bounded rows and keeps keyboard or mouse selection visible without a permanent detail block", async () => {
  const calls: ReportInput[] = []
  const app = await renderReports({
    width: 80,
    height: 24,
    load: async (query) => {
      calls.push(query)
      const start = query.offset ?? 0
      const rows = Array.from({ length: 100 }, (_, index) => ({
        key: `row-${start + index + 1}`,
        label: `2026-09-${String(start + index + 1).padStart(3, "0")}`,
        logical: start + index + 1,
      }))
      return report(query.group, rows, { rowCount: 205, nextOffset: start < 100 ? 100 : start < 200 ? 200 : undefined })
    },
  })
  try {
    let frame = await waitFor(app, (value) => value.includes("Rows 1–100 of 205") && value.includes("> 2026-09-001"), "first page")
    expect(frame.split("\n").every((line) => line.length <= 80)).toBe(true)
    expect(frame).not.toContain("Usage details")

    for (let index = 0; index < 12; index++) app.mockInput.pressKey("ARROW_DOWN")
    frame = await waitFor(app, (value) => value.includes("> 2026-09-013"), "scrolled selection")
    const visibleRow = frame.split("\n").findIndex((line) => line.includes("2026-09-012"))
    await app.mockMouse.click(4, visibleRow)
    await waitFor(app, (value) => value.includes("> 2026-09-012"), "mouse selection")

    app.mockInput.pressKey("RETURN")
    frame = await waitFor(app, (value) => value.includes("Usage details") && value.includes("2026-09-012"), "selected details")
    expect(frame).toContain("Visible output 1,200")
    expect(frame).toContain("Reasoning 300")
    expect(frame).toContain("Total tokens 14,580")
    app.mockInput.pressKey("ESCAPE")
    await waitFor(app, (value) => !value.includes("Usage details"), "details dismissal")

    app.mockInput.pressKey("]")
    await waitFor(app, (value) => value.includes("Rows 101–200 of 205"), "second page")
    expect(calls.at(-1)?.offset).toBe(100)
    app.mockInput.pressKey("[")
    frame = await waitFor(app, (value) => value.includes("Rows 1–100 of 205"), "previous page")
    const nextRow = frame.split("\n").findIndex((line) => line.includes("[ next ]"))
    await app.mockMouse.click(frame.split("\n")[nextRow].indexOf("[ next ]") + 1, nextRow)
    await waitFor(app, (value) => value.includes("Rows 101–200 of 205"), "mouse paging")
    expect(calls.at(-1)?.offset).toBe(100)
    app.mockInput.pressKey("ARROW_RIGHT")
    await waitFor(app, () => calls.at(-1)?.group === "day", "the Daily view after paging Models")
    expect(calls.at(-1)?.offset).toBe(0)
  } finally {
    app.renderer.destroy()
  }
}, 30_000)

test("invalidates late report work when the screen unmounts", async () => {
  const requests: Array<ReturnType<typeof deferred<ProviderRequestReport>>> = []
  const app = await renderReports({
    load: () => {
      const result = deferred<ProviderRequestReport>()
      requests.push(result)
      return result.promise
    },
  })
  await waitFor(app, () => requests.length === 1, "pending report")
  app.renderer.destroy()
  requests[0].resolve(report("model", [{ key: "late", label: "Late after unmount", logical: 4 }]))
  await Bun.sleep(30)
}, 30_000)

test("keeps large-value rows on one line with compact token columns", async () => {
  const large = {
    logical: 295,
    physical: 296,
    helpers: 0,
    continued: 0,
    fallback: 0,
    tokens: { input: 2_773, output: 271_369, reasoning: 0, cache: { read: 103_554_080, write: 553_293 } },
    cost: 1_711.29,
    costProvenance: "current_catalog" as const,
    cacheReadReported: true,
  }
  const app = await renderReports({
    load: async (query) => ({
      group: query.group,
      rows: [{ key: "large", label: "Investigate YCoding macOS Safari window inspection in a separate worktree", ...large }],
      total: large,
      rowCount: 1,
    }),
  })
  try {
    const frame = await waitFor(app, (value) => value.includes("Investigate YCoding"), "large row")
    const lines = frame.split("\n")
    const row = lines.find((line) => line.includes("Investigate YCoding"))!
    expect(lines.every((line) => line.length <= 189)).toBe(true)
    for (const value of ["295", "2,773", "271.4K", "103.6M", "553.3K", "104.4M", "$1711.29"]) expect(row).toContain(value)
    expect(lines[lines.indexOf(row) + 1].trim()).not.toMatch(/^\d/)
  } finally {
    app.renderer.destroy()
  }
}, 30_000)
