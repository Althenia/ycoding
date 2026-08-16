/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { SessionOrchestrationTask } from "@ycoding-ai/client"
import { Keymap } from "../../../src/context/keymap"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const module = await import("../../../src/routes/session/subagent-footer")
const switcher = await import("../../../src/routes/session/subagent-sibling-switcher")

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

test("budgets whole sibling chips before the fixed navigation block", () => {
  const siblings = Array.from({ length: 10 }, (_, index) => ({
    sessionID: `ses_${index}`,
    state: index === 8 ? ("waiting" as const) : ("running" as const),
    question: index === 8 ? { id: "qst_8", text: "Need input", time: 1 } : undefined,
    label: `${index === 8 ? "?" : "◦"} ${["zeus", "omoikane", "wittgenstein", "zeus", "occam"][index % 5]} #${index + 1}`,
  }))

  for (const width of [80, 100, 189, 220]) {
    const layout = switcher.subagentSwitcherLayout({
      width,
      parentTitle: "Penpot command palette and sidebar design fixes",
      currentSessionID: "ses_0",
      siblings,
    })

    expect(layout.right).toBe("1 of 10  ·  ↑ parent  ← prev  → next")
    // Ten siblings do not fit at any supported width, but assert the budget rather than assuming:
    // an overflow indicator is required exactly when a sibling had to be dropped.
    if (layout.visible.length < siblings.length) expect(layout.overflow).toContain("more")
    else expect(layout.overflow).toBeUndefined()
    expect(
      layout.visible.some((sibling) => sibling.sessionID === "ses_8" && sibling.label.startsWith("?")) || layout.overflow?.startsWith("?"),
    ).toBe(true)
    expect(layout.parentWidth + 11 + layout.chipWidth + layout.right.length).toBe(width)
    expect(layout.visible[0]?.sessionID).toBe("ses_0")
    expect(layout.visible.every((sibling) => siblings.some((item) => item.sessionID === sibling.sessionID))).toBe(true)
    expect(layout.visible.map((sibling) => sibling.label)).toEqual(
      siblings.slice(0, layout.visible.length).map((sibling) => sibling.label),
    )
  }
})

test("retains the board-15 three-sibling identity layout", () => {
  const layout = switcher.subagentSwitcherLayout({
    width: 189,
    parentTitle: "Provider cache audit",
    currentSessionID: "ses_docs",
    siblings: [
      { sessionID: "ses_docs", state: "running", label: "◦ docs-sync" },
      { sessionID: "ses_tests", state: "waiting", question: { id: "qst_1", text: "Fix?", time: 1 }, label: "? test-triage" },
      { sessionID: "ses_keymap", state: "running", label: "◦ keymap-audit" },
    ],
  })

  expect(layout.parentTitle).toBe("Provider cache audit")
  expect(layout.visible.map((sibling) => sibling.label)).toEqual(["◦ docs-sync", "? test-triage", "◦ keymap-audit"])
  expect(layout.overflow).toBeUndefined()
  expect(layout.right).toBe("1 of 3  ·  ↑ parent  ← prev  → next")
})

test("labels a direct child on an older page with its exact sibling position", () => {
  const layout = switcher.subagentSwitcherLayout({
    width: 189,
    parentTitle: "Parent session",
    currentSessionID: "ses_11",
    offset: 10,
    total: 12,
    siblings: [
      { sessionID: "ses_10", state: "completed", label: "◦ tenth" },
      { sessionID: "ses_11", state: "completed", label: "◦ eleventh" },
    ],
  })

  expect(layout.right).toBe("12 of 12  ·  ↑ parent  ← prev  → next")
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

test("hydrates an absent child and crosses bounded sibling pages deterministically", async () => {
  const siblings = Array.from({ length: 12 }, (_, index) => ({
    sessionID: `ses_${index}`,
    parentID: "ses_parent",
    description: `Child ${index}`,
    agent: "reviewer",
    model: { providerID: "openai", id: "gpt-5.6" },
    background: true,
    state: "completed" as const,
    revision: index,
    time: { created: index, updated: 12 - index },
  })) satisfies SessionOrchestrationTask[]
  let page: { data: SessionOrchestrationTask[]; offset: number; position: "top" | "older" } = {
    data: siblings.slice(0, 10),
    offset: 0,
    position: "top",
  }
  const pagination = {
    page: () => page,
    navigation: () => ({ older: page.position === "top", newer: page.position === "older" }),
    sync: async () => {
      page = { data: siblings.slice(0, 10), offset: 0, position: "top" }
    },
    loadOlder: async () => {
      page = { data: siblings.slice(10), offset: 10, position: "older" }
    },
    loadNewer: async () => {
      page = { data: siblings.slice(0, 10), offset: 0, position: "top" }
    },
  }

  await expect(
    module.navigateSubagentSibling({ pagination, parentID: "ses_parent", currentSessionID: "ses_11", direction: -1 }),
  ).resolves.toBe("ses_10")
  expect(page.data.map((task) => task.sessionID)).toEqual(["ses_10", "ses_11"])

  page = { data: siblings.slice(0, 10), offset: 0, position: "top" }
  await expect(
    module.navigateSubagentSibling({ pagination, parentID: "ses_parent", currentSessionID: "ses_9", direction: 1 }),
  ).resolves.toBe("ses_10")
  await expect(
    module.navigateSubagentSibling({ pagination, parentID: "ses_parent", currentSessionID: "ses_10", direction: -1 }),
  ).resolves.toBe("ses_9")

  await expect(
    module.navigateSubagentSibling({ pagination, parentID: "ses_parent", currentSessionID: "ses_0", direction: -1 }),
  ).resolves.toBe("ses_11")
})
