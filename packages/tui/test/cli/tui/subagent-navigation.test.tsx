/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { SessionOrchestrationTask } from "@ycoding-ai/client"
import { Keymap } from "../../../src/context/keymap"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const module = await import("../../../src/routes/session/subagent-footer")

const tasks = [
  {
    sessionID: "ses_first",
    parentID: "ses_parent",
    description: "Inspect first",
    agent: "explore",
    model: { providerID: "openai", id: "gpt-5.6" },
    background: true,
    state: "running",
    revision: 1,
    time: { created: 1, updated: 1 },
  },
  {
    sessionID: "ses_blocked",
    parentID: "ses_parent",
    description: "Need an answer",
    agent: "reviewer",
    model: { providerID: "openai", id: "gpt-5.6" },
    background: true,
    state: "waiting",
    question: { id: "qst_review", text: "Which migration should I use?", time: 2 },
    revision: 1,
    time: { created: 2, updated: 2 },
  },
] satisfies SessionOrchestrationTask[]

test("orders durable sibling sessions for arrow navigation", () => {
  const siblings = Reflect.get(module, "subagentSiblingSessionIDs") as
    | ((input: ReadonlyArray<SessionOrchestrationTask>) => string[])
    | undefined

  expect(siblings).toBeTypeOf("function")
  expect(siblings?.(tasks)).toEqual(["ses_first", "ses_blocked"])
})

test("renders the sibling strip, blocked footer chip, and existing arrow hints", async () => {
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
            <Keymap.Provider config={config}>
              <module.SubagentFooterContent
                title="Reviewer"
                usage={() => undefined}
                parentTitle="Parent session"
                siblings={tasks}
                currentSessionID="ses_blocked"
              />
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 8 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Which migration should I use?"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("↑ Parent session")
    expect(frame).toContain("◦ Explore")
    expect(frame).toContain("? ◦ Reviewer")
    expect(frame).toContain("Which migration should I use?")
    expect(frame).toContain("←")
    expect(frame).toContain("→")
  } finally {
    app.renderer.destroy()
  }
})
