/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type {
  ProviderRequestSummary,
  ProviderUsageListOutput,
} from "@ycoding-ai/client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import {
  createProviderUsageGenerationGuard,
  ProviderUsageScreenContent,
  visibleProviderSnapshots,
} from "../../../src/routes/session/provider-usage"

type Snapshot = ProviderUsageListOutput["data"][number]

const snapshot = (providerID: string, status: Snapshot["status"]): Snapshot => ({
  providerID,
  label: providerID,
  status,
  source: "provider_api",
  stability: "stable",
  updatedAt: 1,
  windows: [],
})

test("keeps unsupported connected providers and de-duplicates visible failure states", () => {
  expect(
    visibleProviderSnapshots([
      snapshot("unsupported", "unsupported"),
      snapshot("available", "available"),
      snapshot("stale", "stale"),
      snapshot("unauthorized", "unauthorized"),
      snapshot("error", "error"),
      { ...snapshot("available", "stale"), updatedAt: 0 },
    ]).map((item) => item.providerID),
  ).toEqual(["available", "error", "stale", "unauthorized", "unsupported"])
})

test("invalidates stale asynchronous generations", () => {
  const guard = createProviderUsageGenerationGuard()
  const first = guard.next()
  const second = guard.next()

  expect(guard.current(first)).toBeFalse()
  expect(guard.current(second)).toBeTrue()

  guard.invalidate()
  expect(guard.current(second)).toBeFalse()
})

test("registers screen-only entry and back commands without a command palette item", async () => {
  const [footer, route] = await Promise.all([
    Bun.file(new URL("../../../src/routes/session/footer.tsx", import.meta.url)).text(),
    Bun.file(new URL("../../../src/context/route.tsx", import.meta.url)).text(),
  ])

  expect(footer).toContain("session.provider-usage.open")
  expect(footer).toContain("Open provider usage")
  expect(footer).toContain('bind: "<leader>shift+u"')
  expect(route).toContain('type: "provider-usage"')
  expect(footer).not.toContain("palette: true")
})

test("renders provider progress and unavailable states in a dedicated dialog", async () => {
  const [{ ConfigProvider }, { ThemeProvider }, { Keymap }, { DialogProvider }, { ToastProvider }] = await Promise.all([
    import("../../../src/config"),
    import("../../../src/context/theme"),
    import("../../../src/context/keymap"),
    import("../../../src/ui/dialog"),
    import("../../../src/ui/toast"),
  ])
  const snapshots: Snapshot[] = [
    {
      providerID: "anthropic",
      label: "Claude Max",
      status: "available",
      source: "response_headers",
      stability: "observed",
      updatedAt: 1_000,
      windows: [
        { id: "five-hour", label: "Session", unit: "percent", used: 68, resetAt: 8_200_000 },
        { id: "seven-day", label: "All models", unit: "percent", used: 24 },
        { id: "extra-usage", label: "Extra usage", unit: "usd", used: 12, limit: 50, remaining: 38 },
      ],
    },
    {
      providerID: "openai",
      label: "Codex Pro",
      status: "available",
      source: "local_client_rpc",
      stability: "client_contract",
      updatedAt: 1_000,
      windows: [
        { id: "codex-primary", label: "Weekly", unit: "percent", used: 31 },
        { id: "codex-spark-primary", label: "Spark weekly", unit: "percent", used: 7 },
      ],
    },
    snapshot("openrouter", "error"),
    snapshot("hidden", "unsupported"),
  ]
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ToastProvider>
                <DialogProvider>
                  <ProviderUsageScreenContent
                    snapshots={() => snapshots}
                    initialTab="usage"
                    now={() => 1_000}
                  />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 60, height: 60 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Usage"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Claude Max")
    expect(frame).toContain("68% used")
    expect(frame).toContain("Session")
    expect(frame).toContain("hidden · unsupported")
    expect(frame).toContain("Quota information is not reported.")
  } finally {
    app.renderer.destroy()
  }
})

test("renders unavailable local pricing without inventing zero cost", async () => {
  const [{ ConfigProvider }, { ThemeProvider }, { Keymap }, { DialogProvider }, { ToastProvider }] = await Promise.all([
    import("../../../src/config"),
    import("../../../src/context/theme"),
    import("../../../src/context/keymap"),
    import("../../../src/ui/dialog"),
    import("../../../src/ui/toast"),
  ])
  const usage: ProviderRequestSummary = {
    logical: 1,
    physical: 1,
    helpers: 0,
    continued: 0,
    fallback: 0,
    tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    models: [{
      model: { id: "custom", providerID: "custom" },
      requests: 1,
      tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    }],
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ToastProvider>
                <DialogProvider>
                  <ProviderUsageScreenContent snapshots={() => []} backendUsage={() => usage} />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 60, height: 24 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("YCODING BACKEND"))
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("custom/custom")
    expect(frame).toContain("Unreported/0")
    expect(frame).not.toContain("$0.00")
  } finally {
    app.renderer.destroy()
  }
})

test("renders durable backend request usage after detailed records are compacted", async () => {
  const [{ ConfigProvider }, { ThemeProvider }, { Keymap }, { DialogProvider }, { ToastProvider }] = await Promise.all([
    import("../../../src/config"),
    import("../../../src/context/theme"),
    import("../../../src/context/keymap"),
    import("../../../src/ui/dialog"),
    import("../../../src/ui/toast"),
  ])
  const usage: ProviderRequestSummary = {
    logical: 2,
    physical: 2,
    helpers: 0,
    continued: 0,
    fallback: 0,
    tokens: { input: 12_000, output: 900, reasoning: 0, cache: { read: 18_200, write: 1_200 } },
    cacheReadReported: true,
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ToastProvider>
                <DialogProvider>
                  <ProviderUsageScreenContent
                    snapshots={() => []}
                    backendUsage={() => usage}
                  />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 60, height: 40 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("YCODING BACKEND"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("12,000")
    expect(frame).toContain("900")
    expect(frame).toContain("1,200")
    expect(frame).toContain("Not reported")
    expect(frame).not.toContain("$0.00")
  } finally {
    app.renderer.destroy()
  }
})

test("renders aggregate provider request usage on the screen", async () => {
  const [{ ConfigProvider }, { ThemeProvider }, { Keymap }, { DialogProvider }, { ToastProvider }] = await Promise.all([
    import("../../../src/config"),
    import("../../../src/context/theme"),
    import("../../../src/context/keymap"),
    import("../../../src/ui/dialog"),
    import("../../../src/ui/toast"),
  ])
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
        model: { providerID: "anthropic", id: "claude-sonnet-4-5", variant: "thinking" },
        requests: 2,
        tokens: { input: 1_000, output: 40, reasoning: 0, cache: { read: 300, write: 0 } },
        cacheReadReported: true,
      },
      {
        model: { providerID: "openai", id: "gpt-5.6-terra", variant: "high" },
        requests: 1,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        cacheReadReported: true,
        cost: 0,
        costProvenance: "current_catalog",
      },
    ],
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ToastProvider>
                <DialogProvider>
                  <ProviderUsageScreenContent snapshots={() => []} backendUsage={() => usage} />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 60 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Usage"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Usage")
    expect(frame).toContain("Total · 9,000 in")
    expect(frame).toContain("cache 4,000/300")
    expect(frame).toContain("Total · 9,000 in · 600 out · $6.50")
    expect(frame).toContain("anthropic/claude-sonnet-4-5#thinking")
    expect(frame).toContain("openai/gpt-5.6-terra#high")
    expect(frame).toContain("0/0")
  } finally {
    app.renderer.destroy()
  }
})

test("renders usage in a narrow screen without horizontal layout assumptions", async () => {
  const [{ ConfigProvider }, { ThemeProvider }, { Keymap }, { DialogProvider }, { ToastProvider }] = await Promise.all([
    import("../../../src/config"),
    import("../../../src/context/theme"),
    import("../../../src/context/keymap"),
    import("../../../src/ui/dialog"),
    import("../../../src/ui/toast"),
  ])
  const usage: ProviderRequestSummary = {
    logical: 1,
    physical: 1,
    helpers: 0,
    continued: 0,
    fallback: 0,
    tokens: { input: 20, output: 5, reasoning: 0, cache: { read: 10, write: 0 } },
    cacheReadReported: true,
    models: [
      {
        model: {
          providerID: "very-long-provider-name",
          id: "very-long-model-identifier-that-wraps-across-terminal-lines",
          variant: "special-variant",
        },
        requests: 1,
        tokens: { input: 20, output: 5, reasoning: 0, cache: { read: 10, write: 0 } },
        cacheReadReported: true,
      },
    ],
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ToastProvider>
                <DialogProvider>
                  <ProviderUsageScreenContent snapshots={() => []} backendUsage={() => usage} />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 60, height: 40 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Usage"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Usage")
    expect(frame).toContain("Total · 20 in")
    expect(frame).toContain("cache 10/0")
  } finally {
    app.renderer.destroy()
  }
})
