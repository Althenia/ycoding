/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { BoxRenderable, type Renderable, ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { SessionInfo, SessionOrchestrationTask } from "@ycoding-ai/client"
import { createEffect } from "solid-js"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider } from "../../../src/context/data"
import { Keymap } from "../../../src/context/keymap"
import { LocationProvider } from "../../../src/context/location"
import { RouteProvider, useRoute } from "../../../src/context/route"
import { Composer } from "../../../src/routes/session/composer"
import { createApi, createFetch, json } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const module = await import("../../../src/routes/session/composer/subagents-tab")

function findScrollBox(root: Renderable): ScrollBoxRenderable | undefined {
  if (root instanceof ScrollBoxRenderable) return root
  return root.getChildren().map(findScrollBox).find(Boolean)
}

async function renderMetadata(input: { model?: string; status?: string; width?: number }) {
  const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([
    import("../../../src/config"),
    import("../../../src/context/theme"),
  ])

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <box flexDirection="row">
              <box flexGrow={1}>
                <text>Task</text>
              </box>
              <module.SubagentMetadata model={input.model} status={input.status} active={false} />
            </box>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: input.width ?? 80, height: 3 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Task"))
  return app
}

test("formats provider, model, and optional variant", () => {
  expect(
    module.formatSubagentModel({
      providerID: "openai",
      id: "gpt-5.6-luna",
      variant: "high",
    }),
  ).toBe("openai/gpt-5.6-luna#high")
  expect(module.formatSubagentModel({ providerID: "openai", id: "gpt-5.6-sol" })).toBe("openai/gpt-5.6-sol")
  expect(module.formatSubagentModel(undefined)).toBeUndefined()
})

test("lists BTW children in stable creation order with independent model labels", () => {
  const sessions: SessionInfo[] = [
    {
      id: "ses_btw_second",
      parentID: "ses_parent",
      agent: "btw",
      title: "Second question",
      projectID: "project",
      location: { directory: "/workspace" },
      model: { providerID: "anthropic", id: "claude-sonnet", variant: "default" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 2, updated: 2 },
    },
    {
      id: "ses_btw_first",
      parentID: "ses_parent",
      agent: "btw",
      title: "First question",
      projectID: "project",
      location: { directory: "/workspace" },
      model: { providerID: "openai", id: "gpt-5.6", variant: "high" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    },
  ]

  expect(module.entriesFromBtwSessions(sessions, "ses_btw_second")).toEqual([
    expect.objectContaining({
      sessionID: "ses_btw_first",
      agent: "BTW",
      model: "openai/gpt-5.6#high",
      current: false,
    }),
    expect.objectContaining({
      sessionID: "ses_btw_second",
      agent: "BTW",
      model: "anthropic/claude-sonnet#default",
      current: true,
    }),
  ])
})

test("sections active tasks before inactive tasks and sorts each section deterministically", () => {
  const tasks: SessionOrchestrationTask[] = [
    {
      sessionID: "ses_waiting",
      parentID: "ses_parent",
      description: "Review implementation",
      agent: "reviewer",
      model: { providerID: "openai", id: "gpt-5.6", variant: "high" },
      background: true,
      state: "waiting",
      question: { id: "qst_review", text: "Proceed?", time: 1 },
      revision: 2,
      time: { created: 1, updated: 2 },
    },
    {
      sessionID: "ses_lost",
      parentID: "ses_parent",
      description: "Inspect runtime",
      agent: "explore",
      model: { providerID: "openai", id: "gpt-5.6-luna" },
      background: true,
      state: "lost",
      revision: 3,
      time: { created: 2, updated: 3 },
    },
    {
      sessionID: "ses_alpha",
      parentID: "ses_parent",
      description: "Report findings",
      agent: "general",
      model: { providerID: "openai", id: "gpt-5.6-sol" },
      background: true,
      state: "completed",
      revision: 3,
      time: { created: 2, updated: 3 },
    },
    {
      sessionID: "ses_running_old",
      parentID: "ses_parent",
      description: "Investigate regression",
      agent: "explore",
      model: { providerID: "openai", id: "gpt-5.6-luna" },
      background: true,
      state: "running",
      revision: 4,
      time: { created: 3, updated: 4 },
    },
    {
      sessionID: "ses_running_new",
      parentID: "ses_parent",
      description: "Run validation",
      agent: "general",
      model: { providerID: "openai", id: "gpt-5.6-sol" },
      background: true,
      state: "running",
      revision: 5,
      time: { created: 4, updated: 5 },
    },
  ]

  const entries = module.entriesFromTasks(tasks, "ses_waiting")

  expect(entries).toEqual([
    expect.objectContaining({
      sessionID: "ses_running_new",
      title: "Run validation",
      status: "running",
      current: false,
    }),
    expect.objectContaining({
      sessionID: "ses_running_old",
      title: "Investigate regression",
      status: "running",
      current: false,
    }),
    expect.objectContaining({
      sessionID: "ses_waiting",
      title: "Review implementation",
      status: "waiting",
      current: true,
    }),
    expect.objectContaining({
      sessionID: "ses_alpha",
      title: "Report findings",
      status: "completed",
      current: false,
    }),
    expect.objectContaining({
      sessionID: "ses_lost",
      title: "Inspect runtime",
      status: "lost",
      current: false,
    }),
  ])
  expect(module.subagentSections(entries)).toEqual([
    { label: "ACTIVE", entries: entries.slice(0, 3) },
    { label: "INACTIVE", entries: entries.slice(3) },
  ])
  expect(module.subagentSections(entries.slice(0, 3))).toEqual([{ label: "ACTIVE", entries: entries.slice(0, 3) }])
  expect(module.subagentSections(entries.slice(3))).toEqual([{ label: "INACTIVE", entries: entries.slice(3) }])
  expect(module.subagentScrollIndex(entries, 0)).toBe(1)
  expect(module.subagentScrollIndex(entries, 3)).toBe(6)
  expect(module.subagentScrollIndex(entries.slice(3), 0)).toBe(1)
  expect(module.taskStatusLabel("waiting")).toBe("Waiting")
  expect(module.taskStatusLabel("failed")).toBe("Failed")
  expect(module.taskStatusLabel("lost")).toBe("Lost")
  expect(module.taskStatusLabel("cancelled")).toBe("Cancelled")
})

test("classifies every non-terminal orchestration state as active", () => {
  expect(module.isActiveSubagent("starting")).toBe(true)
  expect(module.isActiveSubagent("running")).toBe(true)
  expect(module.isActiveSubagent("waiting")).toBe(true)
  expect(module.isActiveSubagent("cancelling")).toBe(true)
  expect(module.isActiveSubagent("cancelled")).toBe(false)
  expect(module.isActiveSubagent("completed")).toBe(false)
  expect(module.isActiveSubagent("failed")).toBe(false)
  expect(module.isActiveSubagent("lost")).toBe(false)
})

test("counts durable active tasks and live family sessions without duplicates", () => {
  const tasks = [
    { sessionID: "ses_running", state: "running" },
    { sessionID: "ses_waiting", state: "waiting" },
    { sessionID: "ses_completed", state: "completed" },
  ] as SessionOrchestrationTask[]

  expect(
    module.activeSubagentSessionIDs(
      tasks,
      ["ses_parent", "ses_running", "ses_live_only"],
      "ses_parent",
      (sessionID) => sessionID === "ses_running" || sessionID === "ses_live_only",
    ),
  ).toEqual(["ses_running", "ses_waiting", "ses_live_only"])
})

test("cancels waiting managed tasks through the durable endpoint", async () => {
  const calls: Array<{ parentID: string; childID: string }> = []
  let interrupted = false
  const client = {
    api: {
      session: {
        interrupt: async () => {
          interrupted = true
        },
        subagent: {
          cancel: async (input: { parentID: string; childID: string }) => {
            calls.push(input)
            return { state: "cancelled" }
          },
        },
      },
    },
  }

  expect(module.canCancelSubagent("waiting")).toBe(true)
  expect(module.canCancelSubagent("running")).toBe(true)
  expect(module.canCancelSubagent("completed")).toBe(false)
  await module.cancelManagedSubagent(client, "ses_parent", "ses_child")

  expect(calls).toEqual([{ parentID: "ses_parent", childID: "ses_child" }])
  expect(interrupted).toBe(false)
})

test("renders model and running status on one row", async () => {
  const app = await renderMetadata({
    model: "openai/gpt-5.6-luna#high",
    status: "Running",
  })
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("openai/gpt-5.6-luna#high · Running")
    expect(
      frame
        .split("\n")
        .find((line) => line.includes("Running"))
        ?.trimEnd()
        .endsWith("Running"),
    ).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("renders model metadata for a completed row without status", async () => {
  const app = await renderMetadata({ model: "openai/gpt-5.6-sol" })
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("openai/gpt-5.6-sol")
    expect(frame).not.toContain("Running")
  } finally {
    app.renderer.destroy()
  }
})

test("omits model metadata when the session has no model", async () => {
  const app = await renderMetadata({ status: "Running" })
  try {
    const frame = app.captureCharFrame()
    expect(frame).not.toContain("·")
    expect(
      frame
        .split("\n")
        .find((line) => line.includes("Running"))
        ?.trimEnd()
        .endsWith("Running"),
    ).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("clips a long model label while preserving running status", async () => {
  const model = `provider/${"model".repeat(16)}#variant`
  const app = await renderMetadata({ model, status: "Running", width: 48 })
  try {
    const frame = app.captureCharFrame()
    expect(frame).not.toContain(model)
    expect(frame).toContain(model.slice(0, 12))
    const contentRows = frame.split("\n").filter((line) => line.trim().length > 0)
    expect(contentRows).toHaveLength(1)
    expect(contentRows[0]).toContain("Task")
    expect(contentRows[0]).toContain(model.slice(0, 12))
    expect(contentRows[0]).toContain("Running")
    expect(
      frame
        .split("\n")
        .find((line) => line.includes("Running"))
        ?.trimEnd()
        .endsWith("Running"),
    ).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("renders section headings while keyboard navigation selects only task rows and keeps the selected row visible", async () => {
  const tasks: SessionOrchestrationTask[] = [
    {
      sessionID: "ses_active_first",
      parentID: "ses_parent",
      description: "Review implementation",
      agent: "reviewer",
      model: { providerID: "openai", id: "gpt-5.6", variant: "high" },
      background: true,
      state: "running",
      revision: 1,
      time: { created: 4, updated: 4 },
    },
    {
      sessionID: "ses_active_second",
      parentID: "ses_parent",
      description: "Inspect runtime",
      agent: "explore",
      model: { providerID: "openai", id: "gpt-5.6" },
      background: true,
      state: "waiting",
      revision: 1,
      time: { created: 3, updated: 3 },
    },
    {
      sessionID: "ses_inactive_first",
      parentID: "ses_parent",
      description: "Summarize findings",
      agent: "general",
      model: { providerID: "openai", id: "gpt-5.6" },
      background: true,
      state: "completed",
      revision: 1,
      time: { created: 2, updated: 2 },
    },
    {
      sessionID: "ses_inactive_second",
      parentID: "ses_parent",
      description: "Archive results",
      agent: "general",
      model: { providerID: "openai", id: "gpt-5.6" },
      background: true,
      state: "failed",
      revision: 1,
      time: { created: 1, updated: 1 },
    },
  ]
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/ses_parent/subagent") return json({ data: tasks })
    return undefined
  })
  const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([
    import("../../../src/config"),
    import("../../../src/context/theme"),
  ])
  const config = createTuiResolvedConfig()
  let routeSessionID: string | undefined

  function RouteProbe() {
    const route = useRoute().data
    createEffect(() => {
      routeSessionID = route.type === "session" ? route.sessionID : undefined
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <Keymap.Provider config={config}>
              <ClientProvider api={createApi(calls.fetch)}>
                <DataProvider>
                  <LocationProvider>
                    <RouteProvider
                      initialRoute={{
                        type: "session",
                        sessionID: "ses_parent",
                      }}
                    >
                      <RouteProbe />
                      <Composer sessionID="ses_parent" open defaultTab="subagents" />
                    </RouteProvider>
                  </LocationProvider>
                </DataProvider>
              </ClientProvider>
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 12 },
  )
  app.renderer.start()

  try {
    await app.waitForFrame((frame) => frame.includes("ACTIVE") && frame.includes("INACTIVE"))
    const initial = app.captureCharFrame()
    expect(initial).toContain("ACTIVE")
    expect(initial).toContain("INACTIVE")
    expect(initial).toContain("Reviewer: Review implementation")
    expect(initial).toContain("General: Archive results")
    const sectionRoots = findScrollBox(app.renderer.root)?.getChildren() ?? []
    expect(sectionRoots).toHaveLength(2)
    expect(sectionRoots.every((child) => child instanceof BoxRenderable)).toBe(true)

    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressKey("ARROW_DOWN")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("General: Archive results")
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(routeSessionID).toBe("ses_inactive_second")
  } finally {
    app.renderer.destroy()
  }
})
