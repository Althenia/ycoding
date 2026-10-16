/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { SessionCacheDiagnostics } from "@ycoding-ai/client"
import { Keymap } from "../../../src/context/keymap"
import { SubagentEconomicsSurface } from "../../../src/routes/session/subagent-economics"
import { SubagentFooterContent, subagentEconomics } from "../../../src/routes/session/subagent-footer"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const model = { providerID: "openai", id: "child-model", variant: "high" }
const diagnostics: SessionCacheDiagnostics = {
  model, context: { total: 100, limit: 1_000 },
  tokens: { uncachedInput: 80, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  cache: { eligible: 80, mechanism: "none", readReported: false, writeReported: false },
  generationSpeed: { model, recent: [], latest: { model, tokens: 100, durationNs: 1_000_000_000, tokensPerSecond: 100, estimated: true } },
}
const session = { model: { ...model, variant: "low", profile: "work" }, cost: 0.1,
  tokens: { input: 80, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } }

test("child economics retains model-wide speed and never borrows another model", () => {
  expect(subagentEconomics(session, diagnostics, "Parent")?.speed).toBe("≈ 100 tok/s")
  expect(subagentEconomics(session, diagnostics, "Parent")?.strip).toContain("≈ 100 tok/s")
  expect(subagentEconomics(session, undefined, "Parent")?.speed).toBeUndefined()
  expect(subagentEconomics({ ...session, model: { ...model, id: "other" } }, diagnostics, "Parent")?.speed).toBeUndefined()
})

for (const width of [48, 80, 189]) test(`child economics and footer display speed within ${width} columns`, async () => {
  const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([import("../../../src/config"), import("../../../src/context/theme")])
  const config = createTuiResolvedConfig()
  const economics = subagentEconomics(session, diagnostics, "Parent")
  const app = await testRender(() => <TestTuiContexts><ConfigProvider config={config}>
    <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}><Keymap.Provider config={config}>
      <box flexDirection="column">
        <SubagentEconomicsSurface economics={economics} />
        <SubagentFooterContent title="Child" usage={() => undefined} economics={economics} />
      </box>
    </Keymap.Provider></ThemeProvider></ConfigProvider></TestTuiContexts>, { width, height: 45 })
  app.renderer.start()
  try {
    await app.waitForFrame((frame) => frame.includes("SUBAGENT ECONOMICS") && frame.includes("≈ 100 tok/s"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("Speed")
    expect(frame.match(/≈ 100 tok\/s/g)?.length).toBeGreaterThanOrEqual(2)
    expect(frame).toContain("Rolls up to")
    expect(frame.split("\n").every((line) => line.length <= width)).toBe(true)
  } finally { app.renderer.destroy() }
})
