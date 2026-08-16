/** @jsxImportSource @opentui/solid */
import { TextRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { SessionAutonomyState, SessionTodoInfo } from "@ycoding-ai/client"
import { expect, test } from "bun:test"
import { createEffect, createSignal, type JSX } from "solid-js"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { DataProvider, useData } from "../src/context/data"
import { Keymap } from "../src/context/keymap"
import { LocationProvider, useLocation } from "../src/context/location"
import { RouteProvider } from "../src/context/route"
import { TuiLifecycleProvider } from "../src/context/runtime"
import { ThemeProvider, useTheme } from "../src/context/theme"
import { SkillsRailContent } from "../src/feature-plugins/sidebar/skills"
import { SubagentRailContent } from "../src/feature-plugins/sidebar/subagents"
import { TodoRailContent } from "../src/feature-plugins/sidebar/todo"
import { PluginProvider } from "../src/plugin/context"
import { createPluginRuntime, PluginRuntimeProvider } from "../src/plugin/runtime"
import { railWidth } from "../src/routes/session/rail"
import { Sidebar } from "../src/routes/session/sidebar"
import type { SessionSkill } from "../src/util/session-skills"
import { createApi, createEventStream, createFetch, json } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const sessionID = "ses_0085fc701234567890abcd"
const directory = "/tmp/ycoding/rail-live-fixes"
const location = { directory, project: { id: "proj_rail_live_fixes", directory } }
const session = {
  id: sessionID,
  title: "Provider cache audit",
  projectID: "proj_rail_live_fixes",
  location: { directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  cost: 9.08,
  tokens: { input: 1_411, output: 53, reasoning: 0, cache: { read: 220_672, write: 4_096 } },
  time: { created: 1, updated: 4 },
}

test("ellipsises an over-long rail row label and keeps a blank column before its value", async () => {
  const app = await mount(
    () => (
      <SubagentRailContent
        tasks={[
          {
            sessionID: "ses_research",
            description: "Research OpenAI cache/Responses contract for provider-efficient caching",
            state: "running",
            elapsed: "7m14s",
          },
        ]}
      />
    ),
    { width: 40, height: 12 },
  )
  await app.waitForFrame((frame) => frame.includes("7m14s"))

  try {
    const line = app.captureCharFrame().split("\n").find((row) => row.includes("7m14s"))
    expect(line?.trimEnd().endsWith("7m14s")).toBe(true)
    // The renderer elides the middle of an over-long label, so assert the contract that matters:
    // the label is elided, the value survives intact, and a blank column separates them. The live
    // defect was `contr7m14s`, a label printed straight into its value with no gap.
    expect(line).toContain("...")
    expect(line).toContain(" 7m14s")
    expect(line).not.toMatch(/\S7m14s/)
    expect(line).not.toContain("caching7m14s")
  } finally {
    app.renderer.destroy()
  }
})

test("renders each skill as a name row with a colour-coded status value", async () => {
  const skills: SessionSkill[] = [
    {
      id: "go-developer",
      name: "go-developer",
      activatedBy: "tool",
      activationMessageID: "msg_go",
      content: "",
      conflicts: [],
      declarations: {},
      state: "active",
    },
    {
      id: "code-review",
      name: "code-review",
      activatedBy: "tool",
      activationMessageID: "msg_review",
      content: "",
      conflicts: [{ type: "skill", id: "go-developer", name: "go-developer" }],
      declarations: {},
      state: "active",
    },
    {
      id: "docs-writer",
      name: "docs-writer",
      activatedBy: "tool",
      activationMessageID: "msg_docs",
      content: "",
      conflicts: [],
      declarations: {},
      state: "inactive",
      inactiveReason: "compacted",
    },
    {
      id: "reviewer",
      name: "reviewer",
      activatedBy: "tool",
      activationMessageID: "msg_reviewer",
      content: "",
      conflicts: [],
      declarations: {},
      state: "inactive",
      inactiveReason: "agent_switched",
    },
    {
      id: "writer",
      name: "writer",
      activatedBy: "tool",
      activationMessageID: "msg_writer",
      content: "",
      conflicts: [],
      declarations: {},
      state: "active",
    },
  ]
  const [themeV2, setThemeV2] = createSignal<ReturnType<typeof useTheme>["themeV2"]>()
  const app = await mount(
    () => {
      setThemeV2(useTheme().themeV2)
      return <SkillsRailContent skills={skills} />
    },
    { width: 40, height: 16 },
  )
  await app.waitForFrame((frame) => frame.includes("go-developer"))

  try {
    const frame = app.captureCharFrame()
    const rendered = texts(app.renderer.root)
    const lineOf = (value: string) => app.captureCharFrame().split("\n").find((row) => row.includes(value))
    const colorOf = (value: string) => rendered.find((item) => item.plainText === value)?.fg.toInts()

    expect(lineOf("go-developer")?.trimEnd().endsWith("CONFLICT")).toBe(true)
    expect(lineOf("code-review")?.trimEnd().endsWith("CONFLICT")).toBe(true)
    expect(lineOf("writer")?.trimEnd().endsWith("ACTIVE")).toBe(true)
    expect(lineOf("docs-writer")?.trimEnd().endsWith("INACTIVE")).toBe(true)
    expect(lineOf("reviewer")?.trimEnd().endsWith("INACTIVE")).toBe(true)
    expect(frame).not.toContain("COMPACTED")
    expect(frame).not.toContain("AGENT SWITCH")
    expect(colorOf("ACTIVE")).toEqual(themeV2()!.text.feedback.success.default.toInts())
    expect(colorOf("CONFLICT")).toEqual(themeV2()!.text.feedback.warning.default.toInts())
    expect(colorOf("INACTIVE")).toEqual(themeV2()!.text.subdued.toInts())
    expect(colorOf("writer")).toEqual(themeV2()!.text.subdued.toInts())
  } finally {
    app.renderer.destroy()
  }
})

test("colours every todo marker and label by status", async () => {
  const todos: SessionTodoInfo[] = [
    { content: "Verify baseline", status: "completed", priority: "medium" },
    { content: "Run verification", status: "in_progress", priority: "medium" },
    { content: "Drop stale probe", status: "cancelled", priority: "low" },
    { content: "Write report", status: "pending", priority: "low" },
  ]
  const [themeV2, setThemeV2] = createSignal<ReturnType<typeof useTheme>["themeV2"]>()
  const app = await mount(
    () => {
      setThemeV2(useTheme().themeV2)
      return <TodoRailContent list={todos} />
    },
    { width: 40, height: 20 },
  )
  await app.waitForFrame((frame) => frame.includes("Write report"))

  try {
    const rendered = texts(app.renderer.root)
    const row = (content: string) => {
      const index = rendered.findIndex((item) => item.plainText === content)
      return { marker: rendered[index - 1], content: rendered[index] }
    }
    const completed = row("Verify baseline")
    const active = row("Run verification")
    const cancelled = row("Drop stale probe")
    const pending = row("Write report")

    expect([completed.marker?.plainText, active.marker?.plainText, cancelled.marker?.plainText, pending.marker?.plainText]).toEqual([
      "ok",
      "..",
      "xx",
      "--",
    ])
    expect(completed.marker?.fg.toInts()).toEqual(themeV2()!.text.feedback.success.default.toInts())
    expect(completed.content?.fg.toInts()).toEqual(themeV2()!.text.subdued.toInts())
    expect(active.marker?.fg.toInts()).toEqual(themeV2()!.text.feedback.warning.default.toInts())
    expect(active.content?.fg.toInts()).toEqual(themeV2()!.text.feedback.warning.default.toInts())
    expect(cancelled.marker?.fg.toInts()).toEqual(themeV2()!.text.feedback.error.default.toInts())
    expect(cancelled.content?.fg.toInts()).toEqual(themeV2()!.text.feedback.error.default.toInts())
    expect(pending.marker?.fg.toInts()).toEqual(themeV2()!.text.subdued.toInts())
    expect(pending.content?.fg.toInts()).toEqual(themeV2()!.text.subdued.toInts())
  } finally {
    app.renderer.destroy()
  }
})

test("paints the rail on its own surface behind a left rule and drops the rail footer", async () => {
  const app = await mountSidebar({ width: 189, height: 69 })

  try {
    const frame = app.captureCharFrame()
    const railStart = 189 - Math.round(railWidth(189))
    const titleRows = frame.split("\n").flatMap((line, index) => (line.includes(session.title) ? [index] : []))
    const line = app.captureSpans().lines[titleRows[titleRows.length - 1]]
    const columns = line?.spans.flatMap((span) => Array.from({ length: span.text.length }, () => span.bg.toInts())) ?? []

    // The rail surface is the elevated surface, never the transcript canvas fill.
    expect(app.rail()!.background.default.toInts()).not.toEqual(app.canvas()!.background.default.toInts())
    expect(columns[railStart + 4]).toEqual(app.rail()!.background.default.toInts())

    // The left rule is drawn as a border glyph, so it carries the border colour in its foreground
    // over the rail surface rather than as a background fill.
    const cells = line?.spans.flatMap((span) =>
      Array.from(span.text, (character) => ({ character, fg: span.fg.toInts() })),
    ) ?? []
    expect(cells[railStart]?.character).toBe("\u2502")
    expect(cells[railStart]?.fg).toEqual(app.canvas()!.border.default.toInts())

    expect(frame).not.toContain("YCoding v")
    expect(frame).not.toContain(" · connected")
    expect(frame).not.toContain(directory)
  } finally {
    app.dispose()
  }
}, 30_000)

test("keeps the rail bottom padding across the responsive viewports", async () => {
  for (const viewport of [
    { width: 189, height: 69 },
    { width: 220, height: 69 },
    { width: 100, height: 30 },
    { width: 80, height: 24 },
  ]) {
    const app = await mountSidebar(viewport)
    try {
      const lines = app.captureCharFrame().split("\n")
      const railStart = viewport.width - Math.round(railWidth(viewport.width))
      if (viewport.width < 100) {
        continue
      }
      expect(lines[app.rowOf(session.title)]).toContain(session.title)
      // The left rule is a continuous border glyph down the whole rail, including the bottom
      // padding row, so the padding assertion covers the rail content beside the rule.
      expect(lines[viewport.height - 1]?.slice(railStart).replaceAll("\u2502", "").trim()).toBe("")
    } finally {
      app.dispose()
    }
  }
}, 60_000)

test("summarizes only connected and failed MCP servers at canonical rail width", async () => {
  const app = await mountSidebar(
    { width: 189, height: 69 },
    [
      { name: "context7", status: { status: "connected" } },
      { name: "playwright", status: { status: "failed", error: "Connection failed" } },
      { name: "atlassian", status: { status: "needs_auth" } },
      { name: "firecrawl", status: { status: "pending" } },
      { name: "disabled", status: { status: "disabled" } },
    ],
  )

  try {
    await app.waitForFrame((frame) => frame.includes("1/5 connected · 1 failed"))
    const header = app.captureCharFrame().split("\n").find((line) => line.includes("MCP"))
    expect(header).toContain("1/5 connected · 1 failed")
  } finally {
    app.dispose()
  }
})

test("omits the MCP failure exception when no server has failed", async () => {
  const app = await mountSidebar({ width: 189, height: 69 }, [{ name: "context7", status: { status: "connected" } }])

  try {
    await app.waitForFrame((frame) => frame.includes("1/1 connected"))
    const header = app.captureCharFrame().split("\n").find((line) => line.includes("MCP"))
    expect(header).toContain("1/1 connected")
    expect(header).not.toContain("failed")
  } finally {
    app.dispose()
  }
})

test("keeps the rail top below the header across autonomy modes and retained goals", async () => {
  const modes: ReadonlyArray<[string, SessionAutonomyState]> = [
    ["normal", { mode: "normal", yolo: false }],
    ["active goal", { mode: "normal", yolo: false, goal: { runID: "run_session_rail_live_fixes_fixture", text: "Finish audit", status: "active", iteration: 1, noProgress: 0, maxNoProgress: 5 } }],
    ["yolo", { mode: "normal", yolo: true }],
    ["yolo with completed goal", { mode: "normal", yolo: true, goal: { runID: "run_session_rail_live_fixes_fixture", text: "Finish audit", status: "completed", iteration: 1, noProgress: 0, maxNoProgress: 5 } }],
    ["yolo with stopped goal", { mode: "normal", yolo: true, goal: { runID: "run_session_rail_live_fixes_fixture", text: "Finish audit", status: "stopped", iteration: 1, noProgress: 0, maxNoProgress: 5 } }],
  ]
  const tops: number[] = []

  for (const [, autonomy] of modes) {
    const app = await mountSidebar({ width: 189, height: 69 }, [], autonomy)
    try {
      tops.push(app.rowOf(session.title))
    } finally {
      app.dispose()
    }
  }

  expect(tops).toEqual(Array.from({ length: modes.length }, () => tops[0]))
  expect(tops[0]).toBeGreaterThanOrEqual(0)

  const normal = await mountSidebar({ width: 100, height: 30 }, [], modes[0]![1])
  const retainedYolo = await mountSidebar({ width: 100, height: 30 }, [], modes[3]![1])
  try {
    expect(retainedYolo.rowOf(session.title)).toBe(normal.rowOf(session.title))
    expect(retainedYolo.rowOf(session.title)).toBeGreaterThanOrEqual(0)
  } finally {
    normal.dispose()
    retainedYolo.dispose()
  }
}, 60_000)

async function mount(body: () => JSX.Element, dimensions: { width: number; height: number }) {
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            {body()}
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { ...dimensions, useMouse: true },
  )
  app.renderer.start()
  return app
}

type McpFixture = {
  readonly name: string
  readonly status: {
    readonly status: "connected" | "disabled" | "failed" | "needs_auth" | "needs_client_registration" | "pending"
    readonly error?: string
  }
}

async function mountSidebar(
  viewport: { width: number; height: number },
  mcp: ReadonlyArray<McpFixture> = [],
  autonomy: SessionAutonomyState = { mode: "normal", yolo: false },
) {
  const events = createEventStream()
  const calls = createFetch((url) => route(url, mcp), events)
  const [canvas, setCanvas] = createSignal<ReturnType<typeof useTheme>["themeV2"]>()
  const [rail, setRail] = createSignal<ReturnType<typeof useTheme>["themeV2"]>()

  function Probe() {
    const theme = useTheme()
    setCanvas(theme.themeV2)
    setRail(theme.contextual("elevated").themeV2)
    return null
  }

  const app = await testRender(
    () => (
      <TuiLifecycleProvider value={{ add: () => () => {} }}>
        <TestTuiContexts directory={directory}>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <Keymap.Provider>
              <RouteProvider initialRoute={{ type: "session", sessionID }}>
                <PluginRuntimeProvider value={createPluginRuntime()}>
                  <ClientProvider api={createApi(calls.fetch)}>
                    <DataProvider>
                      <LocationProvider>
                        <SyncLocation />
                        <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                          <PluginProvider packages={{ resolve: async () => undefined }}>
                            <Probe />
                            <box width={viewport.width} height={viewport.height} alignItems="flex-end">
                              <Sidebar sessionID={sessionID} autonomy={autonomy} />
                            </box>
                          </PluginProvider>
                        </ThemeProvider>
                      </LocationProvider>
                    </DataProvider>
                  </ClientProvider>
                </PluginRuntimeProvider>
              </RouteProvider>
            </Keymap.Provider>
          </ConfigProvider>
        </TestTuiContexts>
      </TuiLifecycleProvider>
    ),
    viewport,
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(session.title))

  return Object.assign(app, {
    canvas,
    rail,
    rowOf: (value: string) => app.captureCharFrame().split("\n").findIndex((line) => line.includes(value)),
    dispose: () => {
      app.renderer.destroy()
      events.disconnect()
    },
  })
}

function SyncLocation() {
  const data = useData()
  const locationState = useLocation()
  createEffect(() => locationState.set(data.location.default()))
  return null
}

function texts(root: { getChildren(): readonly unknown[] }) {
  return descendants(root).filter((item): item is TextRenderable => item instanceof TextRenderable)
}

function descendants(root: { getChildren(): readonly unknown[] }): unknown[] {
  return root.getChildren().flatMap((child) => (hasChildren(child) ? [child, ...descendants(child)] : [child]))
}

function hasChildren(value: unknown): value is { getChildren(): readonly unknown[] } {
  return typeof value === "object" && value !== null && "getChildren" in value && typeof value.getChildren === "function"
}

function route(url: URL, mcp: ReadonlyArray<McpFixture> = []) {
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}/subagent`)
    return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
  if (
    [
      `/api/session/${sessionID}/pending`,
      `/api/session/${sessionID}/permission`,
      `/api/session/${sessionID}/todo`,
      `/api/session/${sessionID}/skills`,
      `/api/session/${sessionID}/guardrail/request`,
      "/api/shell",
    ].includes(url.pathname)
  )
    return json({ location, data: [] })
  if (url.pathname === "/api/mcp") return json({ location, data: mcp })
  if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
  if (url.pathname === `/api/session/${sessionID}/guardrail`)
    return json({
      data: {
        rootSessionID: sessionID,
        profile: "standard",
        customRules: 0,
        approvals: 0,
        blocked: 0,
        counters: [],
        invalidFiles: [],
      },
    })
  if (url.pathname === `/api/session/${sessionID}/diagnostics`)
    return json({
      data: {
        model: { providerID: "anthropic", id: "claude-opus-5" },
        context: { total: 1_464, percent: 56 },
        tokens: { uncachedInput: 1_411, output: 53, reasoning: 0, cacheRead: 220_672, cacheWrite: 4_096 },
        cache: {
          eligible: 220_672,
          hitRatio: 0.71,
          mechanism: "anthropic-cache-control",
          readReported: true,
          writeReported: true,
        },
        requests: {
          logical: 1,
          physical: 1,
          helpers: 0,
          continued: 0,
          fallback: 0,
          tokens: { input: 1_411, output: 53, reasoning: 0, cache: { read: 220_672, write: 4_096 } },
          latestInvalidation: "stable-hit",
        },
      },
    })
  if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
  if (url.pathname === "/api/model")
    return json({
      location,
      data: [
        {
          id: "claude-opus-5",
          modelID: "claude-opus-5",
          providerID: "anthropic",
          name: "Claude Opus 5",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          variants: [{ id: "max" }],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 200_000, output: 32_000 },
        },
      ],
    })
  if (url.pathname === "/api/provider") return json({ location, data: [{ id: "anthropic", name: "Claude" }] })
  if (url.pathname === "/api/agent")
    return json({
      location,
      data: [
        { id: "build", name: "Build", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] },
      ],
    })
  if (["/api/integration", "/api/command", "/api/skill", "/api/reference"].includes(url.pathname))
    return json({ location, data: [] })
  if (url.pathname === "/api/permission/request" || url.pathname === "/api/form/request")
    return json({ location, data: [] })
  return undefined
}
