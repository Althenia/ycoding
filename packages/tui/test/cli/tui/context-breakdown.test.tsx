/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { SessionCacheDiagnostics, SessionInfo } from "@ycoding-ai/client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { ContextBreakdownContent, contextBarCells } from "../../../src/routes/session/context-breakdown"
import { Footer } from "../../../src/routes/session/footer"

const session = {
  title: "Demo session", model: { providerID: "openai", id: "gpt" },
  tokens: { input: 7, output: 3, reasoning: 1, cache: { read: 2, write: 4 } },
  time: { created: 1000, updated: 2000 }, cost: 0,
} satisfies Pick<SessionInfo, "title" | "model" | "tokens" | "cost" | "time">
const breakdown = { system: 10, tools: 10, user: 1, assistant: 976, reasoning: 1, toolCalls: 1, other: 1 }
const diagnostics = {
  model: { providerID: "openai", id: "gpt" },
  context: { total: 1100, limit: 2000, percent: 55 },
  tokens: { uncachedInput: 100, output: 20, reasoning: 5, cacheRead: 900, cacheWrite: 2 },
  cache: { eligible: 1000, mechanism: "none", readReported: true, writeReported: true },
  contextBreakdown: breakdown,
} satisfies SessionCacheDiagnostics

test("allocates a full bar proportionally and keeps tiny nonzero categories visible", () => {
  const cells = contextBarCells(breakdown, 40)
  expect(cells.reduce((sum, count) => sum + count, 0)).toBe(40)
  expect(cells[3]).toBeGreaterThan(30)
  expect(cells.filter((count) => count === 1).length).toBeGreaterThanOrEqual(5)
  expect(contextBarCells({ ...breakdown, assistant: 0 }, 12)[3]).toBe(0)
})

async function render(width: number, value?: SessionCacheDiagnostics, usage?: Parameters<typeof ContextBreakdownContent>[0]["usage"], cost = 0, height = 55) {
  const config = createTuiResolvedConfig()
  const [{ ConfigProvider }, { ThemeProvider }, { Keymap }] = await Promise.all([
    import("../../../src/config"), import("../../../src/context/theme"), import("../../../src/context/keymap"),
  ])
  const app = await testRender(() => (
    <TestTuiContexts><ConfigProvider config={config}><ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
      <Keymap.Provider config={config}>
        <ContextBreakdownContent session={{ ...session, cost }} diagnostics={value} messages={[
          { type: "user" }, { type: "assistant" }, { type: "user" },
        ]} usage={usage} onBack={() => {}} />
      </Keymap.Provider>
    </ThemeProvider></ConfigProvider></TestTuiContexts>
  ), { width, height })
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Context breakdown"))
  return app
}

test("renders session stats, percentages, tokens and total in a two-column grid", async () => {
  const app = await render(120, diagnostics)
  try {
    const frame = app.captureCharFrame()
    for (const label of ["Session", "Messages", "Provider", "Model", "Context Limit", "Total Tokens", "Usage %", "Input Tokens", "Output Tokens", "Reasoning Tokens", "Cache Tokens read/write", "User Messages", "Assistant Messages", "Total Cost", "Session Created", "Last Activity", "Category", "Tokens", "Total"])
      expect(frame).toContain(label)
    expect(frame).toContain("Demo session")
    expect(frame).toContain("$0.00")
    expect(frame).toContain("97.6%")
    expect(frame).toContain("1,000")
    expect(frame).toContain("2,000")
    expect(frame).toContain("976")
    expect(frame).toContain("2")
    expect(frame).toContain("● User")
    expect(frame).toContain("█")
    expect(frame.split("\n").some((line) => line.includes("Session") && line.includes("Messages"))).toBe(true)
    expect(frame).toMatch(/Input Tokens\s+100\b/)
    expect(frame).toMatch(/Output Tokens\s+20\b/)
    expect(frame).toMatch(/Reasoning Tokens\s+5\b/)
    expect(frame).toMatch(/Cache Tokens read\/write\s+900 \/ 2\b/)
    const header = frame.split("\n").find((line) => line.includes("Category") && line.includes("Tokens"))!
    const assistant = frame.split("\n").find((line) => line.includes("Assistant") && line.includes("976"))!
    expect(header.indexOf("Category")).toBe(assistant.indexOf("Assistant"))
    expect(header.indexOf("Tokens") + "Tokens".length).toBe(assistant.indexOf("976") + "976".length)
    expect(header.lastIndexOf("%") + 1).toBe(assistant.lastIndexOf("97.6%") + "97.6%".length)
  } finally { app.renderer.destroy() }
})

test("stacks stats at narrow width and still shows missing breakdown guidance", async () => {
  const app = await render(54)
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("The breakdown appears after this Session's next")
    expect(frame).toContain("model step.")
    expect(frame).toContain("Demo session")
    expect(frame).toMatch(/Input Tokens\s+7\b/)
    expect(frame).toMatch(/Output Tokens\s+3\b/)
    expect(frame).toMatch(/Reasoning Tokens\s+1\b/)
    expect(frame).toMatch(/Cache Tokens read\/write\s+2 \/ 4\b/)
    expect(frame.split("\n").some((line) => line.includes("Session") && line.includes("Messages"))).toBe(false)
  } finally { app.renderer.destroy() }
})

test("keeps the complete token table inside a narrow terminal", async () => {
  const app = await render(54, diagnostics, undefined, 0, 75)
  try {
    const frame = app.captureCharFrame()
    expect(frame).toMatch(/Total\s+1,000\s+100\.0%/)
    expect(frame).toMatch(/Assistant\s+976\s+97\.6%/)
  } finally { app.renderer.destroy() }
})

test("shows zero dollars when request summary has no reported cost", async () => {
  const app = await render(120, diagnostics, {
    logical: 1, physical: 1, helpers: 0, continued: 0, fallback: 0,
    tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }, 12)
  try { expect(app.captureCharFrame()).toContain("$0.00") } finally { app.renderer.destroy() }
})

test("palette command opens the context route for the current session", async () => {
  const config = createTuiResolvedConfig()
  const [{ ConfigProvider }, { ThemeProvider }, { Keymap }, { RouteProvider, useRoute }, { ClientProvider }, { DataProvider }] = await Promise.all([
    import("../../../src/config"), import("../../../src/context/theme"), import("../../../src/context/keymap"),
    import("../../../src/context/route"), import("../../../src/context/client"), import("../../../src/context/data"),
  ])
  let dispatch: (id: string) => void = () => {}
  let palette: () => readonly { id?: string; palette?: boolean }[] = () => []
  function Probe() {
    const keymap = Keymap.use()
    palette = Keymap.useCommands()
    dispatch = (id) => keymap.dispatch(id)
    const route = useRoute()
    return <box flexDirection="column"><Footer sessionID="ses_context" autonomy={{ mode: "normal", yolo: false }} />
      <text>{route.data.type === "session-context" ? `${route.data.type}:${route.data.sessionID}` : route.data.type}</text>
    </box>
  }
  const { createApi, createFetch } = await import("../../fixture/tui-client")
  const app = await testRender(() => <TestTuiContexts><ConfigProvider config={config}>
    <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}><Keymap.Provider config={config}>
      <ClientProvider api={createApi(createFetch().fetch)}><DataProvider><RouteProvider initialRoute={{ type: "session", sessionID: "ses_context" }}>
        <Probe />
      </RouteProvider></DataProvider></ClientProvider>
    </Keymap.Provider></ThemeProvider>
  </ConfigProvider></TestTuiContexts>, { width: 90, height: 8 })
  app.renderer.start()
  try {
    await app.waitForFrame((frame) => frame.includes("session"))
    expect(palette().find((command) => command.id === "session.context-breakdown.open")?.palette).toBe(true)
    dispatch("session.context-breakdown.open")
    await app.waitForFrame((frame) => frame.includes("session-context:ses_context"))
    expect(app.captureCharFrame()).toContain("session-context:ses_context")
  } finally { app.renderer.destroy() }
})
