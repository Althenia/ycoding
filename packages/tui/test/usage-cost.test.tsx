/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { onMount } from "solid-js"
import { ConfigProvider } from "../src/config"
import { ThemeProvider } from "../src/context/theme"
import { PromptCostBlock, QuotaForecastBlock, TaskCostDetails, TaskCostDialog, UsageSpeedDetails } from "../src/routes/session/usage-cost"
import { Keymap } from "../src/context/keymap"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

test("prompt costs render unknown pricing, child tails and helper breakdown in narrow and wide themes", async () => {
  for (const width of [40, 80, 120]) for (const mode of ["dark", "light"] as const) {
    const app = await testRender(() => <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig()}><ThemeProvider mode={mode} source={{ discover: () => Promise.resolve({}) }}>
      <box flexDirection="column"><PromptCostBlock unit={{ inputID: "msg_first", settled: false, complete: false,
        cost: { known: 2, pricedRequests: 2, unpricedRequests: 1 }, main: { total: 0, known: 0, pricedRequests: 1, unpricedRequests: 0 },
        children: { known: 2, pricedRequests: 1, unpricedRequests: 1 }, helpers: [{ label: "Decision", cost: { pricedRequests: 0, unpricedRequests: 1 } }] }} />
      <UsageSpeedDetails speed={{ generationSamples: 4, generationP50TokensPerSecond: 20, generationP90TokensPerSecond: 50, providerTimedSamples: 1, observedSamples: 3, samples: 2 }} />
      <QuotaForecastBlock now={600_000} forecast={{ state: "insufficient", unit: "percent", evidence: "insufficient", updatedAt: 600_000, reason: "Warming up after restart" }} /></box>
    </ThemeProvider></ConfigProvider></TestTuiContexts>, { width, height: 20 })
    try {
      app.renderer.start()
      await app.waitForFrame((frame) => frame.includes("Prompt cost"))
      const frame = app.captureCharFrame().replace(/\s+/g, " ")
      expect(frame).toContain("Known $2.00 + unreported")
      expect(frame).toContain("so far")
      expect(frame).toContain("incomplete")
      expect(frame).toContain("Main $0.00")
      expect(frame).toContain("Children Known $2.00")
      expect(frame).toContain("Decision unreported")
      expect(frame).toContain("2 priced · 1 unpriced")
      expect(frame).toContain("median 20.0 tok/s")
      expect(frame).toContain("p90 50.0 tok/s")
      expect(frame).toContain("4 measured requests")
      expect(frame).toContain("Forecast unavailable")
      expect(frame).toContain("Warming up after restart")
      await mkdir(new URL("../../../.cache/tmp/", import.meta.url), { recursive: true })
      await Bun.write(new URL(`../../../.cache/tmp/usage-cost-${width}-${mode}.txt`, import.meta.url), app.captureCharFrame())
    } finally { app.renderer.destroy() }
  }
})

test("recursive task details display the supplied inclusive total and warn against additive rows", async () => {
  const app = await testRender(() => <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig()}><ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
    <TaskCostDetails unit={{ settled: true, complete: true, cost: { total: 23, known: 23, pricedRequests: 6, unpricedRequests: 0 },
      main: { total: 13, known: 13, pricedRequests: 4, unpricedRequests: 0 }, children: { total: 10, known: 10, pricedRequests: 2, unpricedRequests: 0 }, helpers: [] }} />
  </ThemeProvider></ConfigProvider></TestTuiContexts>, { width: 80, height: 12 })
  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Task cost (inclusive)"))
    const frame = app.captureCharFrame().replace(/\s+/g, " ")
    expect(frame).toContain("Task cost (inclusive) $23.00")
    expect(frame).toContain("Main $13.00 · Children $10.00")
    expect(frame).toContain("Inclusive task rows overlap; do not add them for a family total.")
    await mkdir(new URL("../../../.cache/tmp/", import.meta.url), { recursive: true })
    await Bun.write(new URL("../../../.cache/tmp/usage-task-cost-80-dark.txt", import.meta.url), app.captureCharFrame())
  } finally { app.renderer.destroy() }
})

test.each([599_999, 600_000])("an exhaustion ETA at %i renders now at the observation time", async (exhaustionAt) => {
  const app = await testRender(() => <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig()}><ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
    <QuotaForecastBlock now={300_000} asOf={600_000} forecast={{ state: "estimated", unit: "percent", evidence: "medium", updatedAt: 600_000, exhaustionAt }} />
  </ThemeProvider></ConfigProvider></TestTuiContexts>, { width: 80, height: 10 })
  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Estimated exhaustion now"))
    expect(app.captureCharFrame()).not.toContain(new Date(exhaustionAt).toISOString())
  } finally { app.renderer.destroy() }
})

test("narrow recursive-cost dialogs keep keyboard paging, refresh and close reachable", async () => {
  let refreshes = 0
  function Open() {
    const dialog = useDialog()
    onMount(() => dialog.replace(() => <TaskCostDialog loading={false} onRefresh={() => refreshes++} unit={{ settled: true, complete: true,
      cost: { total: 8, known: 8, pricedRequests: 8, unpricedRequests: 0 }, main: { pricedRequests: 0, unpricedRequests: 0 }, children: { pricedRequests: 0, unpricedRequests: 0 },
      helpers: Array.from({ length: 8 }, (_, index) => ({ label: `Helper ${index + 1}`, cost: { total: 1, known: 1, pricedRequests: 1, unpricedRequests: 0 } })) }} />))
    return <text>Session background</text>
  }
  const config = createTuiResolvedConfig()
  const app = await testRender(() => <TestTuiContexts><ConfigProvider config={config}><Keymap.Provider config={config}><ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}><ToastProvider><DialogProvider><Open /></DialogProvider></ToastProvider></ThemeProvider></Keymap.Provider></ConfigProvider></TestTuiContexts>, { width: 40, height: 24 })
  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Recursive task cost") && frame.includes("Task cost"))
    app.renderer.stdin.emit("data", Buffer.from("\u001b[6~"))
    await app.waitForFrame((frame) => frame.replace(/\s+/g, " ").includes("family total."))
    app.mockInput.pressKey("r")
    await app.waitForFrame(() => refreshes === 1)
    expect(refreshes).toBe(1)
    app.mockInput.pressKey("ESCAPE")
    await app.waitForFrame((frame) => !frame.includes("Recursive task cost"))
    expect(app.captureCharFrame()).toContain("Session background")
  } finally { app.renderer.destroy() }
})
