/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ProviderUsageListOutput } from "@ycoding-ai/client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { ProviderUsageScreenContent } from "../../../src/routes/session/provider-usage"

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
        { id: "balance", label: "Balance", unit: "usd", remaining: 50 },
        { id: "daily", label: "Daily", unit: "usd", used: 7.02 },
        { id: "weekly", label: "Weekly", unit: "usd", used: 11.22 },
        { id: "monthly", label: "Monthly", unit: "usd", used: 18.45 },
        { id: "later", label: "Later reset", unit: "percent", used: 25, resetAt: now + 4 * 60 * 60 * 1_000 },
        { id: "reset", label: "Sooner reset", unit: "percent", used: 91, resetAt: now + (2 * 60 + 3) * 60 * 1_000 },
      ],
    },
    {
      providerID: "github-copilot", label: "Copilot", status: "available", source: "provider_internal_api",
      stability: "best_effort", updatedAt: now,
      windows: [
        { id: "credits", label: "AI credits", unit: "percent", used: 42, resetAt: now + 60 * 60 * 1_000 },
        { id: "extra-usage", label: "Extra usage", unit: "count", used: 3 },
        { id: "org-credits", label: "Org credits", unit: "count", used: 125 },
        { id: "org-spend", label: "Org spend", unit: "usd", used: 1.25 },
      ],
    },
    {
      providerID: "xai", label: "Grok", status: "available", source: "provider_internal_api",
      stability: "best_effort", updatedAt: now,
      windows: [{ id: "extra-usage", label: "Extra usage", unit: "count", limit: 2500 }],
    },
    {
      providerID: "zai", label: "Z.ai", status: "available", source: "provider_internal_api",
      stability: "best_effort", updatedAt: now,
      windows: [{ id: "web-searches", label: "Web Searches", unit: "count", used: 12, limit: 100 }],
    },
    {
      providerID: "openai", label: "Codex", profile: "YCoding local", status: "available",
      source: "local_session", stability: "stable", updatedAt: now,
      windows: [{ id: "today", label: "Today", unit: "usd", used: 0 }],
    },
    {
      providerID: "openrouter-uncapped",
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
                  <ProviderUsageScreenContent snapshots={() => snapshots} initialTab="usage" now={() => now} />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 100 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Usage"))

  try {
    const frame = app.captureCharFrame()
    const rows = frame.split("\n")
    expect(rows.find((row) => row.includes("Openrouter"))).toContain("updated now")
    expect(rows.find((row) => row.includes("Key limit"))).toContain("███░░░░░░░ $3.20 / $10.00 ($6.80 left)")
    expect(rows.find((row) => /^\s*Daily\s/.test(row))).toContain("$7.02 used")
    expect(rows.find((row) => row.includes("Balance"))).toContain("$50.00 left")
    expect(rows.find((row) => row.includes("AI credits"))).toContain("42% used")
    expect(rows.find((row) => row.includes("Org credits"))).toContain("125 credits")
    expect(rows.find((row) => row.includes("Org spend"))).toContain("$1.25 billed")
    expect(rows.find((row) => row.includes("2,500 cap"))).toContain("Extra usage")
    expect(rows.find((row) => row.includes("Extra usage") && !row.includes("cap"))).toContain("3 used")
    expect(rows.find((row) => row.includes("Web Searches"))).toContain("12 / 100 used")
    expect(rows.some((row) => /\d count\b/.test(row))).toBe(false)
    expect(rows.find((row) => row.includes("Codex · YCoding local"))).toContain("local_session · stable")
    expect(rows.find((row) => /^\s*Today\s/.test(row))).toContain("$0.00 used")
    expect(rows.find((row) => /^\s*Weekly\s/.test(row))).toContain("$11.22 used")
    expect(rows.find((row) => /^\s*Monthly\s/.test(row))).toContain("$18.45 used")
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
    expect(frame).not.toMatch(/[#-]{3,}/)
  } finally {
    app.renderer.destroy()
  }
})

test("lists every provider quota before YCoding local Today spend", async () => {
  const [{ ConfigProvider }, { ThemeProvider }, { Keymap }, { DialogProvider }, { ToastProvider }] = await Promise.all([
    import("../../../src/config"),
    import("../../../src/context/theme"),
    import("../../../src/context/keymap"),
    import("../../../src/ui/dialog"),
    import("../../../src/ui/toast"),
  ])
  const now = 1_000_000
  const localSpend = (providerID: string, label: string, used: number): Snapshot => ({
    providerID, label, profile: "YCoding local", status: "available", source: "local_session", stability: "stable",
    updatedAt: now, windows: [{ id: "today", label: "Today", unit: "usd", used }],
  })
  const snapshots: Snapshot[] = [
    localSpend("anthropic", "Claude", 231.11),
    {
      providerID: "anthropic", label: "Claude Max", status: "available", source: "provider_internal_api",
      stability: "best_effort", updatedAt: now,
      windows: [{ id: "session", label: "Session", unit: "percent", used: 44, resetAt: now + 60 * 60 * 1_000 }],
    },
    {
      providerID: "openai", label: "Codex Pro", status: "available", source: "provider_internal_api",
      stability: "best_effort", updatedAt: now,
      windows: [{ id: "weekly", label: "Weekly", unit: "percent", used: 27, resetAt: now + 2 * 60 * 60 * 1_000 }],
    },
    localSpend("openai", "Openai", 601.67),
  ]
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ToastProvider>
                <DialogProvider>
                  <ProviderUsageScreenContent snapshots={() => snapshots} initialTab="usage" now={() => now} />
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
  await app.waitForFrame((frame) => frame.includes("Openai · YCoding local"))

  try {
    const rows = app.captureCharFrame().split("\n")
    const headers = ["Claude Max · updated now", "Codex Pro · updated now", "Claude · YCoding local", "Openai · YCoding local"]
      .map((header) => rows.findIndex((row) => row.includes(header)))
    expect(headers.every((index) => index >= 0)).toBe(true)
    expect(headers).toEqual(headers.toSorted((left, right) => left - right))
    expect(rows[headers[2]! + 1]).toContain("Today $231.11 used")
    expect(rows[headers[3]! + 1]).toContain("Today $601.67 used")
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
                  <ProviderUsageScreenContent snapshots={() => snapshots} initialTab="usage" now={() => now} />
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
    expect(rows.find((row) => /^\s*Session\s/.test(row))).toContain("resets in 1h")
    expect(rows.find((row) => row.includes("Weekly all models"))).toContain("resets in 2h")
    expect(rows.find((row) => row.includes("Experimental lane"))).toContain("resets in 3h")
    expect(rows.find((row) => row.includes("Codex Pro"))).toContain("updated now")
    expect(rows.find((row) => row.includes("5-hour"))).toContain("resets in 1h")
    expect(rows.find((row) => row.includes("Weekly") && !row.includes("all models"))).toContain("resets in 2h")
    expect(rows.find((row) => row.includes("Spark weekly"))).toContain("resets in 3h")
    expect(rows.find((row) => row.includes("Reset credits"))).toContain("4 used")
    expect(rows.find((row) => row.includes("Reset credits"))).not.toContain("resets")
    expect(rows.find((row) => row.includes("Monthly AI credits"))).toContain("45 used · resets in 4h")
    expect(rows.find((row) => row.includes("Monthly AI credits"))).not.toContain("#")
    expect(rows.find((row) => row.includes("Premium requests"))).toContain("█████████░ 91% used")
    expect(rows.find((row) => row.includes("Free monthly"))).toContain("50 remaining")
    expect(rows.find((row) => row.includes("Free monthly"))).not.toContain("#")
  } finally {
    app.renderer.destroy()
  }
})
