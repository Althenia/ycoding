/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal, type JSX } from "solid-js"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

async function mount(body: () => JSX.Element) {
  const config = createTuiResolvedConfig()
  const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([
    import("../src/config"),
    import("../src/context/theme"),
  ])
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            {body()}
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 40, height: 20 },
  )
  app.renderer.start()
  return app
}

test("expands the default sections and collapses the summarised ones", async () => {
  const { RailProvider, RailSection } = await import("../src/routes/session/rail-section")
  const app = await mount(() => (
    <RailProvider>
      <RailSection section="todo" title="TODO">
        <text>todo body</text>
      </RailSection>
      <RailSection section="mcp" title="MCP" summary="3 connected">
        <text>mcp body</text>
      </RailSection>
    </RailProvider>
  ))
  await app.waitForFrame((frame) => frame.includes("TODO"))

  const frame = app.captureCharFrame()
  expect(frame).toContain("todo body")
  // MCP summarises itself on the header row, so collapsing it costs no information.
  expect(frame).toContain("3 connected")
  expect(frame).not.toContain("mcp body")
  app.renderer.destroy()
})

test("renders expanded when no rail provider is mounted", async () => {
  const { RailSection } = await import("../src/routes/session/rail-section")
  const app = await mount(() => (
    <RailSection section="mcp" title="MCP" summary="3 connected">
      <text>mcp body</text>
    </RailSection>
  ))
  await app.waitForFrame((frame) => frame.includes("MCP"))
  expect(app.captureCharFrame()).toContain("mcp body")
  app.renderer.destroy()
})

test("auto-expands on attention and re-collapses once it clears", async () => {
  const { RailProvider, RailSection } = await import("../src/routes/session/rail-section")
  const [waiting, setWaiting] = createSignal(false)
  const app = await mount(() => (
    <RailProvider>
      <RailSection section="subagents" title="SUBAGENTS" summary="2 running" attention={waiting()}>
        <text>subagent body</text>
      </RailSection>
    </RailProvider>
  ))
  await app.waitForFrame((frame) => frame.includes("SUBAGENTS"))
  expect(app.captureCharFrame()).not.toContain("subagent body")

  setWaiting(true)
  await app.waitForFrame((frame) => frame.includes("subagent body"))

  setWaiting(false)
  await app.waitForFrame((frame) => !frame.includes("subagent body"))
  app.renderer.destroy()
})

test("an attention event past the cap collapses the least recently expanded section", async () => {
  const { RailProvider, RailSection } = await import("../src/routes/session/rail-section")
  const [waiting, setWaiting] = createSignal(false)
  const app = await mount(() => (
    <RailProvider goal autonomy>
      <RailSection section="context" title="CONTEXT">
        <text>context body</text>
      </RailSection>
      <RailSection section="goal" title="GOAL">
        <text>goal body</text>
      </RailSection>
      <RailSection section="autonomy" title="AUTONOMY">
        <text>autonomy body</text>
      </RailSection>
      <RailSection section="todo" title="TODO">
        <text>todo body</text>
      </RailSection>
      <RailSection section="subagents" title="SUBAGENTS" summary="1 waiting" attention={waiting()}>
        <text>subagent body</text>
      </RailSection>
    </RailProvider>
  ))
  await app.waitForFrame((frame) => frame.includes("context body"))

  setWaiting(true)
  await app.waitForFrame((frame) => frame.includes("subagent body"))

  const frame = app.captureCharFrame()
  // CONTEXT was the least recently expanded of the four defaults, so it yields its slot.
  expect(frame).not.toContain("context body")
  expect(frame).toContain("goal body")
  expect(frame).toContain("todo body")
  app.renderer.destroy()
})
