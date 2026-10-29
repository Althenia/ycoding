/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { ProviderRequestSummary } from "@ycoding-ai/client"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
import { ProviderUsageScreenContent } from "../src/routes/session/provider-usage"
import type { UsageLive } from "../src/routes/session/usage-dashboard"
import { DialogProvider } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const usage: ProviderRequestSummary = {
  logical: 3,
  physical: 3,
  helpers: 0,
  continued: 0,
  fallback: 0,
  tokens: { input: 9_000, output: 600, reasoning: 0, cache: { read: 4_000, write: 300 } },
  cacheReadReported: true,
  cost: 6.5,
  models: [{
    model: { providerID: "openai", id: "gpt-5.6-terra", variant: "high" },
    requests: 3,
    cacheReadReported: true,
    tokens: { input: 9_000, output: 600, reasoning: 0, cache: { read: 4_000, write: 300 } },
  }],
}

const busy: UsageLive = {
  asOf: 100,
  active: 3,
  streaming: 2,
  outputTokensPerSecond: 142.4,
  models: [
    { model: { providerID: "openai", id: "gpt-5.6-terra", variant: "high" }, active: 2, streaming: 2, outputTokensPerSecond: 120 },
    { model: { providerID: "anthropic", id: "claude-opus-5" }, active: 1, streaming: 0 },
  ],
  history: [
    { at: 70, active: 1 },
    { at: 75, active: 2, outputTokensPerSecond: 40 },
    { at: 80, active: 3, outputTokensPerSecond: 80 },
  ],
}

async function render(input: {
  live: () => UsageLive | undefined
  failed?: () => boolean
  width?: number
  height?: number
}) {
  const config = createTuiResolvedConfig()
  const app = await testRender(() => <TestTuiContexts><ConfigProvider config={config}>
    <Keymap.Provider config={config}><ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
      <ToastProvider><DialogProvider>
        <ProviderUsageScreenContent snapshots={() => []} backendUsage={() => usage} live={input.live} liveFailed={input.failed} />
      </DialogProvider></ToastProvider>
    </ThemeProvider></Keymap.Provider>
  </ConfigProvider></TestTuiContexts>, { width: input.width ?? 160, height: input.height ?? 40 })
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("RETAINED MODEL BREAKDOWN"))
  return app
}

test("Overview shows active and streaming attempts, the labelled aggregate rate, models and history", async () => {
  const app = await render({ live: () => busy })
  try {
    await app.waitForFrame((frame) => frame.includes("LIVE · YCODING BACKEND"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("3 active · 2 streaming · ≈ 142 tok/s aggregate ▁▄█")
    expect(frame).toContain("openai/gpt-5.6-terra · selected effort high · 2 active · 2 streaming · ≈ 120 tok/s")
    expect(frame).toContain("anthropic/claude-opus-5 · 1 active · 0 streaming")
    expect(frame).not.toContain("N/A")
    expect(frame.indexOf("LIVE · YCODING BACKEND")).toBeLessThan(frame.indexOf("RETAINED MODEL BREAKDOWN"))
    expect(frame).not.toContain("Live updates paused")
  } finally { app.renderer.destroy() }
})

test("Overview follows live updates, reports idle without a rate, and flags paused updates", async () => {
  const [live, setLive] = createSignal<UsageLive | undefined>(busy)
  const [failed, setFailed] = createSignal(false)
  const app = await render({ live, failed })
  try {
    await app.waitForFrame((frame) => frame.includes("3 active"))
    setLive({ asOf: 200, active: 0, streaming: 0, models: [], history: [] })
    await app.waitForFrame((frame) => frame.includes("0 active · 0 streaming"))
    expect(app.captureCharFrame()).not.toContain("N/A")
    expect(app.captureCharFrame()).not.toContain("aggregate")
    expect(app.captureCharFrame()).not.toContain("142")
    expect(app.captureCharFrame()).not.toContain("▁")
    setFailed(true)
    await app.waitForFrame((frame) => frame.includes("Live updates paused · refresh to resume"))
    setLive(undefined)
    await app.waitForFrame((frame) => !frame.includes("LIVE · YCODING BACKEND"))
    expect(app.captureCharFrame()).toContain("RETAINED MODEL BREAKDOWN")
  } finally { app.renderer.destroy() }
})

test("the live block stays within a narrow terminal and is absent from other tabs", async () => {
  const app = await render({ live: () => busy, width: 80, height: 40 })
  try {
    await app.waitForFrame((frame) => frame.includes("3 active"))
    expect(app.captureCharFrame().split("\n").every((line) => line.length <= 80)).toBe(true)
    app.mockInput.pressKey("TAB")
    await app.waitForFrame((frame) => !frame.includes("3 active"))
  } finally { app.renderer.destroy() }
})
