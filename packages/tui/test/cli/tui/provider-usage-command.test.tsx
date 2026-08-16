/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ProviderRequestSummary, ProviderUsageListOutput, SessionCacheDiagnostics, SessionInfo } from "@ycoding-ai/client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import {
  createProviderUsageGenerationGuard,
  loadProviderUsageSnapshots,
  ProviderUsageDialogContent,
  providerUsageCommandDefinition,
  selectedProviderIDs,
  visibleProviderSnapshots,
} from "../../../src/routes/session/provider-usage"

type Snapshot = ProviderUsageListOutput["data"][number]

type SessionFixture = Pick<SessionInfo, "model">

const snapshot = (providerID: string, status: Snapshot["status"]): Snapshot => ({
  providerID,
  label: providerID,
  status,
  source: "provider_api",
  stability: "stable",
  updatedAt: 1,
  windows: [],
})

test("selects unique providers from every selected session, including idle sessions", () => {
  const sessions: Record<string, SessionFixture> = {
    root: { model: { providerID: "anthropic", id: "claude" } },
    "child-a": { model: { providerID: "anthropic", id: "claude" } },
    "child-b": { model: { providerID: "openai", id: "gpt" } },
    idle: { model: { providerID: "openrouter", id: "router" } },
  }
  expect(
    selectedProviderIDs(
      ["root", "child-a", "child-b", "idle"],
      (sessionID) => sessions[sessionID],
    ),
  ).toEqual(["anthropic", "openai", "openrouter"])
})

test("omits unsupported snapshots and preserves visible failure states", () => {
  expect(
    visibleProviderSnapshots([
      snapshot("unsupported", "unsupported"),
      snapshot("available", "available"),
      snapshot("stale", "stale"),
      snapshot("unauthorized", "unauthorized"),
      snapshot("error", "error"),
    ]).map((item) => item.providerID),
  ).toEqual(["available", "error", "stale", "unauthorized"])
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

test("loads each provider once and removes unsupported results", async () => {
  const calls: string[] = []
  const result = await loadProviderUsageSnapshots(["openai", "anthropic", "openai"], async (providerID) => {
    calls.push(providerID)
    return snapshot(providerID, providerID === "openai" ? "unsupported" : "available")
  })

  expect(calls).toEqual(["anthropic", "openai"])
  expect(result.map((item) => item.providerID)).toEqual(["anthropic"])
})

test("defines the command for provider quota or local durable request usage", () => {
  const run = () => undefined
  expect(providerUsageCommandDefinition([], run)).toBeUndefined()
  expect(providerUsageCommandDefinition([snapshot("hidden", "unsupported")], run)).toBeUndefined()
  expect(providerUsageCommandDefinition([], run, true)).toMatchObject({ id: "session.provider-usage", run })
  for (const status of ["available", "stale", "unauthorized", "error"] as const) {
    expect(providerUsageCommandDefinition([snapshot(status, status)], run)).toMatchObject({
      id: "session.provider-usage",
      title: "Provider Usage",
      group: "Session",
      palette: true,
      bind: false,
      run,
    })
  }
})

test("mounts provider usage as a command and removes the sidebar builtin", async () => {
  const [builtins, session] = await Promise.all([
    Bun.file(new URL("../../../src/plugin/builtins.ts", import.meta.url)).text(),
    Bun.file(new URL("../../../src/routes/session/index.tsx", import.meta.url)).text(),
  ])

  expect(builtins).not.toContain("SidebarProviderUsage")
  expect(builtins).not.toContain("sidebar/provider-usage")
  expect(session).toContain('import { ProviderUsageCommand } from "./provider-usage"')
  expect(session).toContain("<ProviderUsageCommand />")
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
  const diagnostics = {
    model: { id: "gpt-5.6", providerID: "openai" },
    context: { total: 32_600 },
    tokens: { uncachedInput: 12_000, output: 900, reasoning: 300, cacheRead: 18_200, cacheWrite: 1_200 },
    cache: {
      eligible: 31_400,
      mechanism: "openai-prefix-cache",
      readReported: true,
      writeReported: true,
    },
    estimatedCost: 0.01,
    requests: {
      logical: 6,
      physical: 7,
      helpers: 1,
      continued: 3,
      fallback: 1,
      cost: 0.0421,
      tokens: { input: 12_000, output: 900, reasoning: 300, cache: { read: 18_200, write: 1_200 } },
      latestInvalidation: "tool-prefix-changed",
      latestNamespace: "a1b2c3d4",
    },
  } as unknown as SessionCacheDiagnostics
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ToastProvider>
                <DialogProvider>
                  <ProviderUsageDialogContent snapshots={() => snapshots} diagnostics={() => diagnostics} now={() => 1_000} />
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
  await app.waitForFrame((frame) => frame.includes("Provider usage"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Claude Max")
    expect(frame).toContain("68% used")
    expect(frame).toContain("Session")
    expect(frame).toContain("This session")
    expect(frame).toContain("Raw input")
    expect(frame).toContain("Raw output")
    expect(frame).toContain("Cache read")
    expect(frame).toContain("Cache write")
    expect(frame).toContain("18,200")
    expect(frame).toContain("$0.01")
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
  const diagnostics = {
    model: { id: "custom", providerID: "custom" },
    context: { total: 12 },
    tokens: { uncachedInput: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cache: { eligible: 10, mechanism: "none", readReported: false, writeReported: false },
    requests: {
      logical: 1,
      physical: 1,
      helpers: 0,
      continued: 0,
      fallback: 0,
      tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  } as unknown as SessionCacheDiagnostics
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ToastProvider>
                <DialogProvider>
                  <ProviderUsageDialogContent snapshots={() => []} diagnostics={() => diagnostics} />
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
  await app.waitForFrame((frame) => frame.includes("This session"))
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("custom/custom")
    expect(frame).not.toContain("$0.00")
  } finally {
    app.renderer.destroy()
  }
})

test("renders durable request usage after diagnostics request details are compacted", async () => {
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
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ToastProvider>
                <DialogProvider>
                  <ProviderUsageDialogContent
                    snapshots={() => []}
                    usage={() => usage}
                    sessionID="ses_compacted"
                    getSession={() => ({ model: { providerID: "openai", id: "gpt-5.6" }, title: "Compacted" })}
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
  await app.waitForFrame((frame) => frame.includes("Raw input"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("12,000")
    expect(frame).toContain("900")
    expect(frame).toContain("18,200")
    expect(frame).toContain("1,200")
    expect(frame).toContain("Unreported")
    expect(frame).not.toContain("$0.00")
  } finally {
    app.renderer.destroy()
  }
})

test("renders aggregate usage as aligned total and model table rows", async () => {
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
    cost: 6.5,
    models: [
      {
        model: { providerID: "anthropic", id: "claude-sonnet-4-5", variant: "thinking" },
        requests: 2,
        tokens: { input: 1_000, output: 40, reasoning: 0, cache: { read: 300, write: 0 } },
      },
      {
        model: { providerID: "openai", id: "gpt-5.6-terra", variant: "high" },
        requests: 1,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
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
                  <ProviderUsageDialogContent snapshots={() => []} usage={() => usage} />
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
    const rows = frame.split("\n")
    const header = rows.find((row) => row.includes("Input") && row.includes("Output") && row.includes("Spent"))
    const total = rows.find((row) => row.includes("Total"))
    const anthropic = rows.find((row) => row.includes("anthropic/claude"))
    const openai = rows.find((row) => row.includes("openai/gpt"))
    expect(frame).toContain("Usage")
    expect(frame).not.toContain("Family spend")
    expect(header).not.toContain("Hit")
    expect(frame).not.toContain("Unreported")
    expect(header).toContain("Read")
    expect(header).toContain("Write")
    expect(total).toContain("9,000")
    expect(total).toContain("600")
    expect(total).toContain("4,000")
    expect(total).toContain("300")
    expect(total).toContain("$6.50")
    expect(anthropic).toContain("1,000")
    expect(anthropic).toContain("40")
    expect(anthropic).toContain("300")
    expect(anthropic).not.toContain("Not reported")
    expect(openai).toContain("$0.00")
    expect((total?.indexOf("9,000") ?? 0) + "9,000".length).toBe((anthropic?.indexOf("1,000") ?? 0) + "1,000".length)
    expect((total?.indexOf("600") ?? 0) + "600".length).toBe((anthropic?.indexOf("40") ?? 0) + "40".length)
    expect((total?.indexOf("4,000") ?? 0) + "4,000".length).toBe((anthropic?.indexOf("300") ?? 0) + "300".length)
    expect((total?.indexOf("$6.50") ?? 0) + "$6.50".length).toBe((openai?.indexOf("$0.00") ?? 0) + "$0.00".length)
    const spentEnd = (header?.indexOf("Spent") ?? 0) + "Spent".length
    expect(anthropic?.slice(spentEnd - 12, spentEnd).trim()).toBe("")
    expect(frame).not.toContain("Estimated (current catalog)")
    expect(frame).not.toContain("This session")
    expect(frame).not.toContain("Subagents")
  } finally {
    app.renderer.destroy()
  }
})

test("truncates long model identifiers while preserving compact usage columns", async () => {
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
    models: [
      {
        model: {
          providerID: "very-long-provider-name",
          id: "very-long-model-identifier-that-wraps-across-terminal-lines",
          variant: "special-variant",
        },
        requests: 1,
        tokens: { input: 20, output: 5, reasoning: 0, cache: { read: 10, write: 0 } },
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
                  <ProviderUsageDialogContent snapshots={() => []} usage={() => usage} />
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
    const rows = app.captureCharFrame().split("\n")
    const header = rows.find((row) => row.includes("Input") && row.includes("Output"))
    const usageRows = rows.filter((row) => row.includes("20") && row.includes("10"))
    expect(header).not.toContain("Hit")
    expect(header).not.toContain("Spent")
    expect(rows.join("\n")).not.toContain("Unreported")
    expect(rows.join("\n")).not.toContain("Not reported")
    expect(usageRows).toHaveLength(2)
    expect(usageRows.every((row) => row.includes("5") && row.includes("10"))).toBeTrue()
    expect(rows.some((row) => row.includes("identifier-that-wraps-across-terminal-"))).toBeFalse()
  } finally {
    app.renderer.destroy()
  }
})
