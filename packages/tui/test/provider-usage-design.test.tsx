/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ProviderRequestReport, ProviderRequestSummary } from "@ycoding-ai/client"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
import { ProviderUsageScreenContent } from "../src/routes/session/provider-usage"
import { ToastProvider } from "../src/ui/toast"
import { DialogProvider } from "../src/ui/dialog"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const chrome = [15, 17, 21, 255] as const
const mint = [103, 215, 164, 255] as const
const blue = [121, 184, 255, 255] as const
const canvas = [21, 24, 29, 255] as const
const longModelID = "deepseek/deepseek-v4-pro-extended-context-preview"

const usage: ProviderRequestSummary = {
  logical: 3,
  physical: 3,
  helpers: 0,
  continued: 0,
  fallback: 0,
  tokens: { input: 9_000, output: 600, reasoning: 0, cache: { read: 4_000, write: 300 } },
  cacheReadReported: true,
  cost: 6.5,
  models: [
    {
      model: { providerID: "openrouter", id: longModelID, variant: "thinking" },
      requests: 2,
      cacheReadReported: true,
      tokens: { input: 9_000, output: 600, reasoning: 0, cache: { read: 4_000, write: 300 } },
    },
    {
      model: { providerID: "openai", id: "gpt-5.6-terra", variant: "high" },
      requests: 1,
      cacheReadReported: true,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
      costProvenance: "current_catalog",
    },
  ],
}

test.each([
  { width: 80, height: 24 },
  { width: 100, height: 32 },
  { width: 108, height: 32 },
  { width: 189, height: 69 },
  { width: 220, height: 69 },
])("renders approved Overview geometry and complete metrics at $width×$height", async ({ width, height }) => {
  const config = createTuiResolvedConfig()
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <Keymap.Provider config={config}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ToastProvider>
                <ProviderUsageScreenContent snapshots={() => []} backendUsage={() => usage} />
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width, height },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("LIFETIME MODEL BREAKDOWN"))

  try {
    const frame = app.captureCharFrame()
    const lines = frame.split("\n")
    const spans = app.captureSpans().lines
    const header = spans.slice(0, 3)
    const footer = spans.slice(-4, -1)
    const row = lines.find((line) => line.includes("LIFETIME MODEL BREAKDOWN"))

    expect(lines).toHaveLength(height + 1)
    expect(lines.every((line) => line.length <= width)).toBe(true)
    expect(header).toHaveLength(3)
    expect(footer).toHaveLength(3)
    expect(header.flatMap((line) => line.spans).some((span) => span.fg.toInts().every((value, index) => value === mint[index]))).toBe(true)
    expect(header.flatMap((line) => line.spans).some((span) => span.text.includes("Usage") && span.bg.toInts().every((value, index) => value === chrome[index]))).toBe(true)
    expect(footer.slice(1).flatMap((line) => line.spans).every((span) => span.bg.toInts().every((value, index) => value === chrome[index]))).toBe(true)
    expect(app.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("Overview"))?.fg.toInts()).toEqual([...blue])
    expect(row?.indexOf("LIFETIME MODEL BREAKDOWN")).toBe(3)
    const navigation = lines.slice(3, 6).find((line) => line.includes("Overview"))!
    expect(navigation).toMatch(/Overview {2,}│ {2,}Usage/)
    const separators = [...navigation.matchAll(/│/g)].map((match) => match.index)
    expect(separators.length).toBeGreaterThan(0)
    expect(separators.slice(1).every((column, index) => column - separators[index] === 13)).toBe(true)
    expect(spans[height - 4].spans.every((span) => span.bg.toInts().every((value, index) => value === canvas[index]))).toBe(true)
    if (width < 108) expect(frame).toContain("steps 3")
    if (width >= 108) expect(frame).toContain("STEPS")
    if (width >= 189) {
      expect(frame).toContain(longModelID)
      const heading = lines.find((line) => line.includes("MODEL") && line.includes("STEPS"))!
      const total = lines.find((line) => /^\s*Total\s/.test(line))!
      expect(heading.indexOf("STEPS") + "STEPS".length).toBe(total.indexOf("3") + 1)
      expect(heading.indexOf("INPUT") + "INPUT".length).toBe(total.indexOf("9,000") + "9,000".length)
    }

    for (const metric of ["3", "9,000", "600", "0", "4,000/300", "$6.50", "Not reported", "$0.00"]) {
      expect(frame).toContain(metric)
    }
  } finally {
    app.renderer.destroy()
  }
})

test.each([
  { width: 80, height: 24 },
  { width: 120, height: 32 },
  { width: 123, height: 32 },
  { width: 189, height: 69 },
  { width: 220, height: 69 },
])("renders direct Models navigation and a full-width selected table row at $width×$height", async ({ width, height }) => {
  const metrics = {
    logical: 2, physical: 3, helpers: 0, continued: 1, fallback: 0,
    tokens: { input: 1_000, output: 200, reasoning: 50, cache: { read: 300, write: 40 } },
    cost: 0.02, costProvenance: "recorded" as const, cacheReadReported: true,
  }
  const report: ProviderRequestReport = {
    group: "model", rowCount: 1,
    rows: [{ key: "model-a", label: `openrouter/${longModelID}`, ...metrics }],
    total: metrics,
  }
  const config = createTuiResolvedConfig()
  const app = await testRender(() => (
    <TestTuiContexts>
      <ConfigProvider config={config}>
        <Keymap.Provider config={config}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <ToastProvider>
              <DialogProvider>
                <ProviderUsageScreenContent initialTab="models" snapshots={() => []} loadReport={async () => report} />
              </DialogProvider>
            </ToastProvider>
          </ThemeProvider>
        </Keymap.Provider>
      </ConfigProvider>
    </TestTuiContexts>
  ), { width, height })
  app.renderer.start()
  try {
    await app.waitForFrame((frame) => frame.includes("openrouter/"))
    const frame = app.captureCharFrame()
    const lines = frame.split("\n")
    const spans = app.captureSpans().lines
    const selectedRow = lines.findIndex((line) => line.includes("openrouter/"))
    expect(lines).toHaveLength(height + 1)
    expect(lines.every((line) => line.length <= width)).toBe(true)
    expect(lines[selectedRow].indexOf("openrouter/")).toBeGreaterThanOrEqual(3)
    expect(lines.slice(selectedRow, selectedRow + 3).join("\n")).toContain("$0.02")
    expect(frame).not.toContain("Selected:")
    expect(frame).not.toContain("Group:")
    expect(frame).not.toContain("Reports")
    expect(spans.flatMap((line) => line.spans).some((span) => span.text.includes("Models") && span.fg.toInts().every((value, index) => value === blue[index]))).toBe(true)
    const selectedWidth = spans[selectedRow].spans
      .filter((span) => span.bg.toInts().every((value, index) => value === [29, 33, 40, 255][index]))
      .reduce((total, span) => total + span.text.length, 0)
    expect(selectedWidth).toBeGreaterThanOrEqual(width - 6)
    if (width >= 189) {
      expect(frame).toContain(longModelID)
      const metricColors = new Set(spans[selectedRow].spans.filter((span) => /\d/.test(span.text)).map((span) => span.fg.toInts().join(",")))
      expect(metricColors.size).toBeGreaterThanOrEqual(3)
      expect(Math.abs(lines[selectedRow].trimEnd().length - (width - 3))).toBeLessThanOrEqual(1)
      for (const tab of ["Overview", "Usage", "Models", "Daily", "Hourly", "Monthly", "Sessions", "Projects", "Stats", "Agents"]) {
        expect(lines.slice(3, 6).join("\n")).toContain(tab)
      }
      for (const column of ["INPUT", "OUTPUT", "CACHE", "COST"]) expect(frame.toUpperCase()).toContain(column)
    }
    expect(lines.slice(-5).join("\n").toLowerCase()).toContain("tab")
    expect(lines.slice(-5).join("\n").toLowerCase()).toContain("refresh")
  } finally {
    app.renderer.destroy()
  }
})
