/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ProviderRequestSummary } from "@ycoding-ai/client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { ProviderUsageScreenContent } from "../src/routes/session/provider-usage"

test("renders backend model tokens and costs without local model-price conversions", async () => {
  const [{ ConfigProvider }, { ThemeProvider }, { Keymap }, { DialogProvider }, { ToastProvider }] = await Promise.all([
    import("../src/config"),
    import("../src/context/theme"),
    import("../src/context/keymap"),
    import("../src/ui/dialog"),
    import("../src/ui/toast"),
  ])
  const usage: ProviderRequestSummary = {
    logical: 2,
    physical: 2,
    helpers: 0,
    continued: 0,
    fallback: 0,
    tokens: { input: 162_884, output: 1_417, reasoning: 87, cache: { read: 212_790, write: 1_000 } },
    cacheReadReported: true,
    cost: 0.43,
    models: [
      {
        model: { providerID: "github-copilot", id: "claude-sonnet-5" },
        requests: 1,
        tokens: { input: 100_000, output: 1_000, reasoning: 87, cache: { read: 200_000, write: 1_000 } },
        cacheReadReported: true,
        cost: 0.02,
        costProvenance: "recorded",
      },
      {
        model: { providerID: "openrouter", id: "deepseek-v4-flash-0731" },
        requests: 1,
        tokens: { input: 62_884, output: 417, reasoning: 0, cache: { read: 12_790, write: 0 } },
        cacheReadReported: true,
        cost: 0.41,
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
    { width: 160, height: 40 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("YCODING BACKEND"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("github-copilot/claude-sonnet-5")
    expect(frame).toContain("openrouter/deepseek-v4-flash-0731")
    expect(frame).toContain("162,884")
    expect(frame).toContain("1,417")
    expect(frame).toContain("212,790/1,000")
    expect(frame).toContain("$0.43")
    expect(frame).toContain("$0.02")
    expect(frame).toContain("$0.41")
  } finally {
    app.renderer.destroy()
  }
})
