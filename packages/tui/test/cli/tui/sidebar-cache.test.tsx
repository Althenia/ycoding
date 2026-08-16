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

const longModelID = "claude-sonnet-4-5-20250929-extended-preview"

const spendDiagnostics: SessionCacheDiagnostics = {
  ...diagnostics,
  model: { providerID: "anthropic", id: longModelID, variant: "thinking" },
  context: { total: 54_015, limit: 400_000, remaining: 345_985, percent: 14 },
  requests: {
    logical: 4,
    physical: 4,
    helpers: 0,
    continued: 0,
    fallback: 0,
    models: [
      { model: { providerID: "anthropic", id: longModelID, variant: "thinking" }, requests: 3, cost: 1.25 },
      { model: { providerID: "openai", id: "gpt-5.6-terra", variant: "high" }, requests: 1 },
    ],
    tokens: { input: 100, output: 20, reasoning: 10, cache: { read: 900, write: 12 } },
  },
}

const oldStepDiagnostics: SessionCacheDiagnostics = {
  ...diagnostics,
  model: { providerID: "anthropic", id: "claude-sonnet-4", variant: "thinking" },
  context: { total: 12_345, limit: 1_000_000, remaining: 987_655, percent: 1 },
  requests: {
    logical: 0,
    physical: 0,
    helpers: 0,
    continued: 0,
    fallback: 0,
    models: [],
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  },
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
    { width: 48, height: 40 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Cache"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Model")
    expect(frame).toContain("gpt-5.6-terra#high")
    expect(frame).toContain("Context")
    expect(frame).toContain("54,015 / 1,050,000")
    expect(frame).toContain("Cache")
    expect(frame).toContain("89%")
    expect(frame).not.toContain("gpt-5.6-sol")
    expect(frame).not.toContain("400K")
    expect(frame).toContain("SPEND")
    expect(frame).toContain("Total")
    expect(frame).toContain("$0.01")
    expect(frame).toContain("CACHE")
    expect(frame).toContain("Reads")
    expect(frame).toContain("900")
    expect(frame).toContain("Writes")
    expect(frame).toContain("12")
    expect(frame).not.toContain("Prefix")
    expect(frame.indexOf("Model")).toBeLessThan(frame.indexOf("Context"))
    expect(frame.indexOf("Context")).toBeLessThan(frame.indexOf("Cache"))
    expect(frame.indexOf("Cache")).toBeLessThan(frame.indexOf("SPEND"))
    expect(frame.indexOf("SPEND")).toBeLessThan(frame.indexOf("Total"))
    expect(frame.indexOf("Total")).toBeLessThan(frame.indexOf("CACHE"))
    expect(frame.indexOf("CACHE")).toBeLessThan(frame.indexOf("Reads"))
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
    { width: 48, height: 40 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Cache"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Model")
    expect(frame).toContain("claude-sonnet-4#thinking")
    expect(frame).toContain("Context")
    expect(frame).toContain("12,345 / 1,000,000")
    expect(frame).toContain("Cache")
    expect(frame).toContain("89%")
    expect(frame).toContain("CACHE")
    expect(frame).toContain("Reads")
    expect(frame).toContain("900")
    expect(frame).toContain("Writes")
    expect(frame).toContain("12")
    expect(frame).toContain("SPEND")
    expect(frame).toContain("Total")
    expect(frame).toContain("unreported")
    expect(frame).not.toContain("$0.00")
    expect(frame).not.toContain("Prefix")
  } finally {
    app.renderer.destroy()
  }
})

test("renders aggregate fallback spend as a single total when diagnostics are unavailable", async () => {
  const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([
    import("../../../src/config"),
    import("../../../src/context/theme"),
  ])
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <module.SidebarCacheContent
              diagnostics={() => undefined}
              fallback={() => ({ tokens: { input: 1_411, output: 53 }, cost: 9.08 })}
            />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 48, height: 30 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("SPEND"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("SPEND")
    expect(frame).toContain("Total")
    expect(frame).toContain("$9.08")
    expect(frame).not.toContain("Model")
    expect(frame).not.toContain("Context")
    expect(frame).not.toContain("CACHE")
  } finally {
    app.renderer.destroy()
  }
})

test("groups spend by model under the measured model identity without colliding with rail values", async () => {
  const [{ ConfigProvider }, { ThemeProvider }, { RailProvider }] = await Promise.all([
    import("../../../src/config"),
    import("../../../src/context/theme"),
    import("../../../src/routes/session/rail-section"),
  ])
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            {/* The docked rail is 50 columns wide at the canonical 189-column terminal. */}
            <box width={50}>
              <RailProvider>
                <module.SidebarCacheContent
                  diagnostics={() => spendDiagnostics}
                  cost={() => 1.25}
                  subagentCost={() => 0.4}
                />
              </RailProvider>
            </box>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 189, height: 69 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("SPEND"))

  try {
    const frame = app.captureCharFrame()
    const lines = frame.split("\n")
    expect(frame).toContain("Model")
    expect(frame).toContain("Context")
    expect(frame).toContain("54,015 / 400,000")
    expect(frame).toContain("SPEND")
    expect(frame).toContain("gpt-5.6-terra#high")
    expect(frame).toContain("unreported")
    expect(frame).toContain("Total")
    expect(frame).toContain("· subagents")
    expect(frame).toContain("$0.40")
    expect(frame).not.toContain("$0.00")
    expect(frame.indexOf("Model")).toBeLessThan(frame.indexOf("Context"))
    expect(frame.indexOf("Context")).toBeLessThan(frame.indexOf("Cache"))
    expect(frame.indexOf("Cache")).toBeLessThan(frame.indexOf("SPEND"))
    expect(frame.indexOf("SPEND")).toBeLessThan(frame.indexOf("$1.25"))
    expect(frame.indexOf("$1.25")).toBeLessThan(frame.indexOf("unreported"))
    expect(frame.indexOf("unreported")).toBeLessThan(frame.indexOf("Total"))
    expect(frame.indexOf("SPEND")).toBeLessThan(frame.indexOf("Total"))
    expect(frame.indexOf("Total")).toBeLessThan(frame.indexOf("· subagents"))
    expect(frame.indexOf("· subagents")).toBeLessThan(frame.indexOf("CACHE"))

    // The long model identity is ellipsised on both rows and never touches the right-aligned value.
    const modelRow = lines.find((line) => line.trimStart().startsWith("Model"))
    expect(modelRow).toBeDefined()
    expect(modelRow?.trimEnd()).toMatch(/^ +Model +claude-sonnet-4-5-\S*…$/)
    expect(modelRow?.trimEnd().length).toBeLessThanOrEqual(47)

    const spendRow = lines.find((line) => line.includes("$1.25") && line.includes("…"))
    expect(spendRow).toBeDefined()
    expect(spendRow?.trimEnd()).toMatch(/^ +claude-sonnet-4-5-\S*… +\$1\.25$/)
    expect(spendRow?.trimEnd().length).toBeLessThanOrEqual(47)

    const unreportedRow = lines.find((line) => line.includes("unreported"))
    expect(unreportedRow?.trimEnd()).toMatch(/^ +gpt-5\.6-terra#high +unreported$/)
  } finally {
    app.renderer.destroy()
  }
})
