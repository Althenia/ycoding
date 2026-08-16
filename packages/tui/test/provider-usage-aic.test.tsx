/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ModelInfo, SessionCacheDiagnostics } from "@ycoding-ai/client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { ProviderUsageDialogContent } from "../src/routes/session/provider-usage"

test("renders Copilot AI credits beside tokens without changing non-Copilot rows", async () => {
  const [{ ConfigProvider }, { ThemeProvider }, { Keymap }, { DialogProvider }, { ToastProvider }] = await Promise.all([
    import("../src/config"),
    import("../src/context/theme"),
    import("../src/context/keymap"),
    import("../src/ui/dialog"),
    import("../src/ui/toast"),
  ])
  const diagnostics = {
    root: usage("github-copilot", "claude-sonnet-5"),
    child: usage("openrouter", "deepseek-v4-flash-0731"),
  }
  const models = [
    model("github-copilot", "claude-sonnet-5"),
    model("openrouter", "deepseek-v4-flash-0731"),
  ]
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
                    sessionID="root"
                    sessionFamily={["root", "child"]}
                    diagnostics={() => diagnostics.root}
                    getSession={(sessionID) =>
                      sessionID === "root"
                        ? { model: diagnostics.root.model, title: "Root" }
                        : { model: diagnostics.child.model, title: "Child" }}
                    getDiagnostics={(sessionID) => diagnostics[sessionID as keyof typeof diagnostics]}
                    getModel={(sessionID) => {
                      const value = diagnostics[sessionID as keyof typeof diagnostics]
                      return models.find((item) => item.providerID === value.model.providerID && item.id === value.model.id)
                    }}
                  />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 40 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Raw input"))

  try {
    const rows = app.captureCharFrame().split("\n")
    const rawInput = rows.filter((row) => row.includes("Raw input"))
    const rawOutput = rows.filter((row) => row.includes("Raw output"))
    const cacheRead = rows.filter((row) => row.includes("Cache read"))
    const cacheWrite = rows.filter((row) => row.includes("Cache write"))
    expect(rawInput.some((row) => row.includes("162,884") && row.includes("1,000"))).toBe(true)
    expect(rawOutput.some((row) => row.includes("1,417") && row.includes("87"))).toBe(true)
    expect(cacheRead.some((row) => row.includes("212,790") && row.includes("213"))).toBe(true)
    expect(cacheWrite.some((row) => row.includes("0") && row.endsWith("0      "))).toBe(true)
    expect(rawInput.some((row) => row.includes("162,884") && !row.includes("1,000"))).toBe(true)
    expect(rawInput.filter((row) => row.includes("1,000"))).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})

function usage(providerID: string, id: string): SessionCacheDiagnostics {
  return {
    model: { providerID, id },
    context: { total: 377_091 },
    tokens: { uncachedInput: 162_884, output: 1_417, reasoning: 0, cacheRead: 212_790, cacheWrite: 0 },
    cache: { eligible: 212_790, hitRatio: 1, mechanism: "openai-prefix-cache", readReported: true, writeReported: true },
    estimatedCost: 0.02,
  }
}

function model(providerID: string, id: string): ModelInfo {
  return {
    id,
    modelID: id,
    providerID,
    name: id,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [{ input: 61.4, output: 614, cache: { read: 10, write: 0 } }],
    status: "active",
    enabled: true,
    limit: { context: 1_000_000, output: 8_192 },
  }
}
