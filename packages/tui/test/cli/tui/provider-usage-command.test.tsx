/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ProviderUsageListOutput, SessionCacheDiagnostics, SessionInfo } from "@ycoding-ai/client"
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

test("defines the command for provider quota or local request diagnostics", () => {
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
    { width: 60, height: 40 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Provider Usage"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Claude Max")
    expect(frame).toContain("#######---")
    expect(frame).toContain("68% used")
    expect(frame).toContain("Session")
    expect(frame).toContain("All models")
    expect(frame).toContain("Extra usage")
    expect(frame).toContain("Codex Pro")
    expect(frame).toContain("Weekly")
    expect(frame).toContain("Spark weekly")
    expect(frame).toContain("resets in 2h 17m")
    expect(frame).toContain("openrouter")
    expect(frame.match(/Usage unavailable/g)?.length).toBe(1)
    expect(frame).not.toContain("hidden")
    expect(frame).toContain("YCoding requests")
    expect(frame).toContain("Logical requests")
    expect(frame).toContain("Transport attempts")
    expect(frame).toContain("Helpers")
    expect(frame).toContain("Continued")
    expect(frame).toContain("Fallbacks")
    expect(frame).toContain("Raw cache read")
    expect(frame).toContain("18.2k tokens")
    expect(frame).toContain("Estimated cost")
    expect(frame).toContain("$0.0421")
    expect(frame).toContain("Last invalidation")
    expect(frame).toContain("Tool prefix changed")
    expect(frame).toContain("Namespace")
    expect(frame).toContain("a1b2c3d4")
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
  await app.waitForFrame((frame) => frame.includes("YCoding requests"))
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Estimated cost unavailable")
    expect(frame).not.toContain("$0.00")
  } finally {
    app.renderer.destroy()
  }
})
