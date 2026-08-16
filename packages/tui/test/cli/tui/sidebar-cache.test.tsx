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
  await app.waitForFrame((frame) => frame.includes("Hit ratio"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Input")
    expect(frame).toContain("100")
    expect(frame).toContain("Output")
    expect(frame).toContain("20")
    expect(frame).toContain("Used")
    expect(frame).toContain("5%")
    expect(frame).toContain("Spent")
    expect(frame).toContain("$0.01")
    expect(frame).toContain("CACHE")
    expect(frame).toContain("Hit ratio")
    expect(frame).toContain("89%")
    expect(frame).toContain("Reads")
    expect(frame).toContain("900")
    expect(frame).toContain("Writes")
    expect(frame).toContain("12")
    expect(frame).not.toContain("Prefix")
    expect(frame.indexOf("Input")).toBeLessThan(frame.indexOf("Output"))
    expect(frame.indexOf("Output")).toBeLessThan(frame.indexOf("Used"))
    expect(frame.indexOf("Used")).toBeLessThan(frame.indexOf("Spent"))
    expect(frame.indexOf("Spent")).toBeLessThan(frame.indexOf("CACHE"))
    expect(frame.indexOf("CACHE")).toBeLessThan(frame.indexOf("Hit ratio"))
    expect(frame.indexOf("Hit ratio")).toBeLessThan(frame.indexOf("Reads"))
    expect(frame.indexOf("Reads")).toBeLessThan(frame.indexOf("Writes"))
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
  await app.waitForFrame((frame) => frame.includes("Hit ratio"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Input")
    expect(frame).toContain("100")
    expect(frame).toContain("Output")
    expect(frame).toContain("20")
    expect(frame).toContain("Used")
    expect(frame).toContain("1%")
    expect(frame).toContain("CACHE")
    expect(frame).toContain("Hit ratio")
    expect(frame).toContain("89%")
    expect(frame).toContain("Reads")
    expect(frame).toContain("900")
    expect(frame).toContain("Writes")
    expect(frame).toContain("12")
    expect(frame).not.toContain("Spent")
    expect(frame).not.toContain("Prefix")
  } finally {
    app.renderer.destroy()
  }
})
