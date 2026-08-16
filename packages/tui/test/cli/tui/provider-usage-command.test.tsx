/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ProviderUsageListOutput, SessionInfo } from "@ycoding-ai/client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import {
  createProviderUsageGenerationGuard,
  loadProviderUsageSnapshots,
  ProviderUsageDialogContent,
  providerUsageCommandDefinition,
  runningProviderIDs,
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

test("selects unique providers from running sessions only", () => {
  const sessions: Record<string, SessionFixture> = {
    root: { model: { providerID: "anthropic", id: "claude" } },
    "child-a": { model: { providerID: "anthropic", id: "claude" } },
    "child-b": { model: { providerID: "openai", id: "gpt" } },
    idle: { model: { providerID: "openrouter", id: "router" } },
  }
  const statuses: Record<string, string> = {
    root: "running",
    "child-a": "running",
    "child-b": "running",
    idle: "idle",
  }

  expect(
    runningProviderIDs(
      ["root", "child-a", "child-b", "idle"],
      (sessionID) => sessions[sessionID],
      (sessionID) => statuses[sessionID] ?? "idle",
    ),
  ).toEqual(["anthropic", "openai"])
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

test("defines the command only for visible provider snapshots", () => {
  const run = () => undefined
  expect(providerUsageCommandDefinition([], run)).toBeUndefined()
  expect(providerUsageCommandDefinition([snapshot("hidden", "unsupported")], run)).toBeUndefined()
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
  const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([
    import("../../../src/config"),
    import("../../../src/context/theme"),
  ])
  const snapshots: Snapshot[] = [
    {
      providerID: "anthropic",
      label: "Claude",
      status: "available",
      source: "response_headers",
      stability: "observed",
      updatedAt: 1_000,
      windows: [{ id: "five-hour", label: "5-hour", unit: "percent", used: 68, resetAt: 8_200_000 }],
    },
    snapshot("codex", "unauthorized"),
    snapshot("openrouter", "error"),
    snapshot("hidden", "unsupported"),
  ]
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <ProviderUsageDialogContent snapshots={() => snapshots} now={() => 1_000} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 60, height: 28 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Provider Usage"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Claude")
    expect(frame).toContain("███████░░░")
    expect(frame).toContain("68% used")
    expect(frame).toContain("resets in 2h 17m")
    expect(frame).toContain("codex")
    expect(frame).toContain("openrouter")
    expect(frame.match(/Usage unavailable/g)?.length).toBe(2)
    expect(frame).not.toContain("hidden")
  } finally {
    app.renderer.destroy()
  }
})
