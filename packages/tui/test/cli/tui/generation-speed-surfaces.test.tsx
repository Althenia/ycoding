/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { SessionCacheDiagnostics } from "@ycoding-ai/client"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { Keymap } from "../../../src/context/keymap"
import { SidebarCacheContent } from "../../../src/feature-plugins/sidebar/context"
import { SubagentEconomicsSurface } from "../../../src/routes/session/subagent-economics"
import { SubagentFooterContent, subagentEconomics } from "../../../src/routes/session/subagent-footer"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

type Live = NonNullable<NonNullable<SessionCacheDiagnostics["generationSpeed"]>["live"]>

const model = { providerID: "openai", id: "child-model", variant: "high" }
const speed = (tokensPerSecond: number) => ({ model, tokens: 100, durationNs: 2_000_000_000, tokensPerSecond, estimated: true })
const diagnostics = (live?: Partial<Live> & Pick<Live, "phase">): SessionCacheDiagnostics => ({
  model,
  context: { total: 100, limit: 1_000 },
  tokens: { uncachedInput: 80, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  cache: { eligible: 80, mechanism: "none", readReported: false, writeReported: false },
  generationSpeed: {
    model,
    recent: [],
    latest: speed(5_000),
    ...(live ? { live: { requestID: ProviderRequest.ID.make("prq_live"), attempt: 1, ...live } } : {}),
  },
})
const session = { model: { ...model, variant: "low" }, cost: 0.1, tokens: { input: 80, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } }

const states: Array<[string, SessionCacheDiagnostics, string]> = [
  ["waiting with TTFT", diagnostics({ phase: "waiting", firstOutputMs: 1_250 }), "≈ 5,000 tok/s"],
  ["streaming without a sample", diagnostics({ phase: "streaming" }), "≈ 5,000 tok/s"],
  ["streaming", diagnostics({ phase: "streaming", sample: speed(42) }), "≈ 42 tok/s"],
  ["reasoning", diagnostics({ phase: "reasoning", sample: speed(18) }), "≈ 18 tok/s reasoning"],
  ["tool", diagnostics({ phase: "tool", sample: speed(42) }), "≈ 42 tok/s tool"],
  ["completed", diagnostics({ phase: "completed", final: speed(37) }), "≈ 37 tok/s"],
  ["failed", diagnostics({ phase: "failed", sample: speed(42) }), "≈ 42 tok/s · failed"],
  ["cancelled without data", diagnostics({ phase: "cancelled" }), "≈ 5,000 tok/s"],
  ["settled", diagnostics(), "≈ 5,000 tok/s"],
]

const count = (frame: string, text: string) => frame.split(text).length - 1

test("sidebar, child economics and child footer show identical speed text for every state", async () => {
  const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([import("../../../src/config"), import("../../../src/context/theme")])
  const config = createTuiResolvedConfig()
  const [value, update] = createSignal<SessionCacheDiagnostics>(states[0][1])
  const app = await testRender(() => <TestTuiContexts><ConfigProvider config={config}>
    <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}><Keymap.Provider config={config}>
      <box flexDirection="column">
        <SidebarCacheContent diagnostics={value} selectedModel={() => session.model} />
        <SubagentEconomicsSurface economics={subagentEconomics(session, value(), "Parent")} />
        <SubagentFooterContent title="Child" usage={() => undefined} economics={subagentEconomics(session, value(), "Parent")} />
      </box>
    </Keymap.Provider></ThemeProvider></ConfigProvider></TestTuiContexts>, { width: 200, height: 60 })
  app.renderer.start()
  try {
    for (const [name, state, expected] of states) {
      update(state)
      await app.waitForFrame((frame) => count(frame, expected) >= 3)
      const frame = app.captureCharFrame()
      expect({ name, surfaces: count(frame, expected) }).toEqual({ name, surfaces: 3 })
      expect(frame).toContain("Speed")
      expect(frame).not.toMatch(/Waiting|N\/A|measuring/)
    }
  } finally { app.renderer.destroy() }
})

test("a fallback-rerouted live attempt shows on every surface, while the settled rate of another model stays hidden", async () => {
  const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([import("../../../src/config"), import("../../../src/context/theme")])
  const config = createTuiResolvedConfig()
  const other = { providerID: "anthropic", id: "claude-opus-5" }
  const [value, update] = createSignal<SessionCacheDiagnostics>(diagnostics({ phase: "streaming", sample: { ...speed(42), model: other } }))
  const app = await testRender(() => <TestTuiContexts><ConfigProvider config={config}>
    <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}><Keymap.Provider config={config}>
      <box flexDirection="column">
        <SidebarCacheContent diagnostics={value} selectedModel={() => session.model} />
        <SubagentEconomicsSurface economics={subagentEconomics(session, value(), "Parent")} />
        <SubagentFooterContent title="Child" usage={() => undefined} economics={subagentEconomics(session, value(), "Parent")} />
      </box>
    </Keymap.Provider></ThemeProvider></ConfigProvider></TestTuiContexts>, { width: 200, height: 60 })
  app.renderer.start()
  try {
    await app.waitForFrame((frame) => count(frame, "≈ 42 tok/s") >= 3)
    update({ ...diagnostics(), generationSpeed: { model, recent: [], latest: { ...speed(5_000), model: other } } })
    await app.waitForFrame((frame) => count(frame, "≈ 42 tok/s") === 0)
    expect(app.captureCharFrame()).not.toContain("tok/s")
    update(diagnostics({ phase: "completed", firstOutputMs: 120 }))
    await app.waitForFrame((frame) => count(frame, "≈ 5,000 tok/s") >= 3)
    expect(app.captureCharFrame()).not.toMatch(/Waiting|N\/A|measuring/)
  } finally { app.renderer.destroy() }
})
