/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { SessionCacheDiagnostics } from "@ycoding-ai/client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const module = await import("../../../src/feature-plugins/sidebar/context")

const diagnostics: SessionCacheDiagnostics = {
  model: { providerID: "openai", id: "gpt-5.6-terra", variant: "high" },
  context: { total: 54_015, limit: 1_050_000, remaining: 995_985, percent: 5 },
  tokens: { uncachedInput: 100, output: 20, reasoning: 10, cacheRead: 900, cacheWrite: 12 },
  cache: {
    eligible: 1_012,
    hitRatio: 900 / 1_012,
    mechanism: "openai-prefix-cache",
    readReported: true,
    writeReported: true,
  },
  estimatedCost: 0.0123,
}

const oldStepDiagnostics: SessionCacheDiagnostics = {
  ...diagnostics,
  model: { providerID: "anthropic", id: "claude-sonnet-4", variant: "thinking" },
  context: { total: 12_345, limit: 1_000_000, remaining: 987_655, percent: 1 },
}

test("renders provider prompt cache without application artifact diagnostics", async () => {
  expect(module.SidebarCacheContent).toBeDefined()

  const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([
    import("../../../src/config"),
    import("../../../src/context/theme"),
  ])
  const config = createTuiResolvedConfig()
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <module.SidebarCacheContent
              diagnostics={() => diagnostics}
              currentModel={() => ({ identity: "openai/gpt-5.6-sol", limit: 400_000 })}
              cost={() => diagnostics.estimatedCost}
            />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 48, height: 18 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Last step provider cache"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Last step context")
    expect(frame).toContain("openai/gpt-5.6-terra#high")
    expect(frame).toContain("Current model context")
    expect(frame).toContain("openai/gpt-5.6-sol")
    expect(frame).toContain("400,000 tokens")
    expect(frame).toContain("54,015 / 1,050,000 tokens")
    expect(frame).toContain("Last step provider cache")
    expect(frame).toContain("Prompt 89% · 900 read · 12 write · 100 uncached")
    expect(frame).toContain("openai-prefix-cache")
    expect(frame).not.toContain("Application artifact cache")
    expect(frame).not.toContain("App reuse")
  } finally {
    app.renderer.destroy()
  }
})

test("keeps a last-step model and limit when session selection changes", async () => {
  const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([
    import("../../../src/config"),
    import("../../../src/context/theme"),
  ])
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <module.SidebarCacheContent diagnostics={() => oldStepDiagnostics} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 48, height: 18 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("anthropic/claude-sonnet-4#thinking"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("anthropic/claude-sonnet-4#thinking")
    expect(frame).toContain("12,345 / 1,000,000 tokens")
  } finally {
    app.renderer.destroy()
  }
})
