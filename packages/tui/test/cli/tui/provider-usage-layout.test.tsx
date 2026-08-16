/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ProviderUsageListOutput } from "@ycoding-ai/client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { ProviderUsageDialogContent } from "../../../src/routes/session/provider-usage"

type Snapshot = ProviderUsageListOutput["data"][number]

test("renders each provider quota window with its own reset and derivable progress bar", async () => {
  const [{ ConfigProvider }, { ThemeProvider }, { Keymap }, { DialogProvider }, { ToastProvider }] = await Promise.all([
    import("../../../src/config"),
    import("../../../src/context/theme"),
    import("../../../src/context/keymap"),
    import("../../../src/ui/dialog"),
    import("../../../src/ui/toast"),
  ])
  const now = 1_000_000
  const snapshots: Snapshot[] = [
    {
      providerID: "openrouter",
      label: "Openrouter",
      status: "available",
      source: "provider_api",
      stability: "stable",
      updatedAt: now,
      windows: [
        { id: "key", label: "Key limit", unit: "usd", used: 3.2, limit: 10, remaining: 6.8, resetAt: now + 60 * 60 * 1_000 },
        { id: "daily", label: "Daily", unit: "usd", used: 7.02 },
        { id: "weekly", label: "Weekly", unit: "usd", used: 11.22 },
        { id: "monthly", label: "Monthly", unit: "usd", used: 18.45 },
        { id: "later", label: "Later reset", unit: "percent", used: 25, resetAt: now + 4 * 60 * 60 * 1_000 },
        { id: "reset", label: "Sooner reset", unit: "percent", used: 91, resetAt: now + (2 * 60 + 3) * 60 * 1_000 },
      ],
    },
    {
      providerID: "openrouter",
      label: "OpenRouter uncapped",
      status: "available",
      source: "provider_api",
      stability: "stable",
      updatedAt: now,
      windows: [
        { id: "key", label: "Uncapped key", unit: "usd", used: 3.2 },
        { id: "daily", label: "Uncapped daily", unit: "usd", used: 7.02 },
        { id: "weekly", label: "Uncapped weekly", unit: "usd", used: 11.22 },
        { id: "monthly", label: "Uncapped monthly", unit: "usd", used: 18.45 },
      ],
    },
    {
      providerID: "meta",
      label: "Meta Model API",
      status: "available",
      source: "provider_api",
      stability: "stable",
      updatedAt: now,
      windows: [
        {
          id: "current-bill",
          label: "Current bill",
          unit: "usd",
          used: 12.34,
          resetAt: now + 4 * 60 * 60 * 1_000,
        },
      ],
    },
  ]
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ToastProvider>
                <DialogProvider>
                  <ProviderUsageDialogContent snapshots={() => snapshots} now={() => now} />
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
  await app.waitForFrame((frame) => frame.includes("Provider quota"))

  try {
    const frame = app.captureCharFrame()
    const rows = frame.split("\n")
    expect(rows.find((row) => row.includes("Openrouter"))).toContain("updated now")
    expect(rows.find((row) => row.includes("Key limit"))).toContain("███░░░░░░░ $3.20 / $10.00 ($6.80 left)")
    expect(rows.find((row) => row.includes("Daily"))).toContain("███████░░░ $7.02 / $10.00")
    expect(rows.find((row) => row.includes("Weekly"))).toContain("██████████ $11.22 / $10.00")
    expect(rows.find((row) => row.includes("Monthly"))).toContain("██████████ $18.45 / $10.00")
    expect(rows.find((row) => row.includes("Later reset"))).toContain("███░░░░░░░ 25% used · resets in 4h")
    expect(rows.find((row) => row.includes("Sooner reset"))).toContain("█████████░ 91% used · resets in 2h 3m")
    expect(rows.find((row) => row.includes("Uncapped daily"))).toContain("$7.02 used")
    expect(rows.find((row) => row.includes("Uncapped weekly"))).toContain("$11.22 used")
    expect(rows.find((row) => row.includes("Uncapped monthly"))).toContain("$18.45 used")
    expect(rows.find((row) => row.includes("Current bill"))).toContain("$12.34 used · bill due in 4h")
    expect(rows.find((row) => row.includes("Current bill"))).not.toContain("resets")
    expect(frame).not.toMatch(/^.*\sReset\s/m)
    expect(frame).not.toContain("Monupdated now")
    expect(frame).not.toContain("Weeklyupdated now")
    expect(frame).not.toMatch(/[\#-]{3,}/)
  } finally {
    app.renderer.destroy()
  }
})

test("preserves reported account tiers and renders each reported reset without invented quota lanes", async () => {
  const [{ ConfigProvider }, { ThemeProvider }, { Keymap }, { DialogProvider }, { ToastProvider }] = await Promise.all([
    import("../../../src/config"),
    import("../../../src/context/theme"),
    import("../../../src/context/keymap"),
    import("../../../src/ui/dialog"),
    import("../../../src/ui/toast"),
  ])
  const now = 1_000_000
  const snapshots: Snapshot[] = [
    {
      providerID: "anthropic",
      label: "Claude Max",
      status: "available",
      source: "response_headers",
      stability: "observed",
      updatedAt: now,
      windows: [
        { id: "session", label: "Session", unit: "percent", used: 12, resetAt: now + 60 * 60 * 1_000 },
        { id: "weekly", label: "Weekly all models", unit: "percent", used: 71, resetAt: now + 2 * 60 * 60 * 1_000 },
        { id: "experimental", label: "Experimental lane", unit: "percent", used: 91, resetAt: now + 3 * 60 * 60 * 1_000 },
      ],
    },
    {
      providerID: "openai",
      label: "Codex Pro",
      status: "available",
      source: "local_client_rpc",
      stability: "client_contract",
      updatedAt: now,
      windows: [
        { id: "five-hour", label: "5-hour", unit: "percent", used: 20, resetAt: now + 60 * 60 * 1_000 },
        { id: "weekly", label: "Weekly", unit: "percent", used: 30, resetAt: now + 2 * 60 * 60 * 1_000 },
        { id: "spark-weekly", label: "Spark weekly", unit: "percent", used: 40, resetAt: now + 3 * 60 * 60 * 1_000 },
        { id: "reset-credits", label: "Reset credits", unit: "count", used: 4 },
      ],
    },
    {
      providerID: "github-copilot",
      label: "GitHub Copilot",
      status: "available",
      source: "provider_api",
      stability: "stable",
      updatedAt: now,
      windows: [
        { id: "monthly-ai-credits", label: "Monthly AI credits", unit: "count", used: 45, resetAt: now + 4 * 60 * 60 * 1_000 },
        { id: "premium-requests", label: "Premium requests", unit: "percent", used: 91, limit: 100 },
        { id: "free-monthly", label: "Free monthly", unit: "count", remaining: 50 },
      ],
    },
  ]
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ToastProvider>
                <DialogProvider>
                  <ProviderUsageDialogContent snapshots={() => snapshots} now={() => now} />
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
  await app.waitForFrame((frame) => frame.includes("Claude Max") && frame.includes("Codex Pro"))

  try {
    const rows = app.captureCharFrame().split("\n")
    expect(rows.find((row) => row.includes("Claude Max"))).toContain("live")
    expect(rows.find((row) => row.includes("Session"))).toContain("resets in 1h")
    expect(rows.find((row) => row.includes("Weekly all models"))).toContain("resets in 2h")
    expect(rows.find((row) => row.includes("Experimental lane"))).toContain("resets in 3h")
    expect(rows.find((row) => row.includes("Codex Pro"))).toContain("updated now")
    expect(rows.find((row) => row.includes("5-hour"))).toContain("resets in 1h")
    expect(rows.find((row) => row.includes("Weekly") && !row.includes("all models"))).toContain("resets in 2h")
    expect(rows.find((row) => row.includes("Spark weekly"))).toContain("resets in 3h")
    expect(rows.find((row) => row.includes("Reset credits"))).toContain("4 count")
    expect(rows.find((row) => row.includes("Reset credits"))).not.toContain("resets")
    expect(rows.find((row) => row.includes("Monthly AI credits"))).toContain("45 count · resets in 4h")
    expect(rows.find((row) => row.includes("Monthly AI credits"))).not.toContain("#")
    expect(rows.find((row) => row.includes("Premium requests"))).toContain("█████████░ 91% used")
    expect(rows.find((row) => row.includes("Free monthly"))).toContain("50 remaining")
    expect(rows.find((row) => row.includes("Free monthly"))).not.toContain("#")
  } finally {
    app.renderer.destroy()
  }
})
