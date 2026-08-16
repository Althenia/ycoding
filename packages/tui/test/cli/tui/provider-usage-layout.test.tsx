/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ProviderUsageListOutput } from "@ycoding-ai/client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { ProviderUsageDialogContent } from "../../../src/routes/session/provider-usage"

type Snapshot = ProviderUsageListOutput["data"][number]

test("renders provider quota windows and reset on separate rows", async () => {
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
        { id: "key", label: "Key limit", unit: "usd", remaining: 3.78 },
        { id: "daily", label: "Daily", unit: "usd", used: 7.02 },
        { id: "weekly", label: "Weekly", unit: "usd", used: 11.22 },
        { id: "monthly", label: "Monthly", unit: "usd", used: 18.45 },
        { id: "later", label: "Later reset", unit: "percent", resetAt: now + 4 * 24 * 60 * 60 * 1_000 },
        { id: "reset", label: "Sooner reset", unit: "percent", resetAt: now + (2 * 24 + 3) * 60 * 60 * 1_000 },
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
    { width: 80, height: 40 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Provider quota"))

  try {
    const frame = app.captureCharFrame()
    const rows = frame.split("\n")
    expect(rows.find((row) => row.includes("Openrouter"))).toContain("updated now")
    expect(rows.find((row) => row.includes("Key limit"))).toContain("$3.78 left")
    expect(rows.find((row) => row.includes("Daily"))).toContain("$7.02 used")
    expect(rows.find((row) => row.includes("Weekly"))).toContain("$11.22 used")
    expect(rows.find((row) => row.includes("Monthly"))).toContain("$18.45 used")
    expect(rows.find((row) => row.includes("Later reset"))).toContain("Not reported")
    expect(rows.find((row) => row.includes("Sooner reset"))).toContain("Not reported")
    expect(rows.find((row) => row.includes("Reset"))).toContain("in 2d 3h")
    expect(frame).not.toContain("Monupdated now")
    expect(frame).not.toContain("Weeklyupdated now")
  } finally {
    app.renderer.destroy()
  }
})
