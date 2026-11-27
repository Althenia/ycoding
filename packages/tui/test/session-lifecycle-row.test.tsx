/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { foldLifecycleEvents } from "@ycoding-ai/client/lifecycle"
import { SessionLifecycleRow } from "../src/routes/session/lifecycle-row"
import { reduceSessionRows } from "../src/routes/session/rows"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const recorded = (id: string, created: number, decision: string, basis: string) => ({
  type: "session.lifecycle.recorded",
  id,
  created,
  data: { sessionID: "ses_a", step: 2, decision, basis, recovery: decision === "recover", recalled: false },
})
const entry = foldLifecycleEvents([recorded("life_1", 20, "recover", "silent")]).entries[0]!

async function render() {
  const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([import("../src/config"), import("../src/context/theme")])
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig({ animations: false })}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <SessionLifecycleRow entry={entry} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 40 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Retried for a reply"))
  return app
}

test("lifecycle row starts collapsed and expands to the recorded details", async () => {
  const app = await render()
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("↻")
    expect(frame).toContain("step 2 · no reply")
    expect(frame).not.toContain("recall injected")
    const line = frame.split("\n").findIndex((text) => text.includes("Retried for a reply"))
    await app.mockMouse.click(4, line)
    await app.waitForFrame((next) => next.includes("recall injected"))
    const expanded = app.captureCharFrame()
    for (const text of ["decision recover", "ending no reply", "recovery step yes", "recall injected no"]) expect(expanded).toContain(text)
  } finally {
    app.renderer.destroy()
  }
})

test("lifecycle rows interleave chronologically and drop invisible entries", () => {
  const messages = [
    { type: "user", id: "first", text: "Q", time: { created: 10 } },
    { type: "assistant", id: "reply", agent: "build", model: { providerID: "p", id: "m" }, content: [{ type: "text", text: "Answer", time: { created: 30 } }], time: { created: 30 } },
  ] as never
  const entries = foldLifecycleEvents([
    recorded("life_1", 20, "recover", "silent"),
    recorded("life_2", 21, "continue", "tool_results"),
    recorded("life_3", 22, "complete", "answered"),
  ]).entries
  const rows = reduceSessionRows(messages, new Set(), false, undefined, [], entries)
  expect(rows.map((row) => (row.type === "lifecycle" ? row.entry.id : row.type === "message" ? row.messageID : row.type))).toEqual([
    "first",
    "life_1",
    "part",
  ])
})
