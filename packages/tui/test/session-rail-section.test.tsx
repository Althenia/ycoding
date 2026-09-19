/** @jsxImportSource @opentui/solid */
import { TextRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { GuardrailStatusOutput, SessionAutonomyState, SessionCacheDiagnostics, SessionTodoInfo } from "@ycoding-ai/client"
import { expect, test, beforeEach } from "bun:test"
import { createSignal, type JSX } from "solid-js"
import { useTheme } from "../src/context/theme"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

beforeEach(async () => {
  const { resetRailExpansion } = await import("../src/routes/session/rail-section")
  resetRailExpansion()
})

async function mount(body: () => JSX.Element, dimensions = { width: 40, height: 20 }) {
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
    { ...dimensions, useMouse: true },
  )
  app.renderer.start()
  return app
}

test("keeps every section toggleable with others collapsed by default", async () => {
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

  try {
    expect(app.captureCharFrame()).toContain("todo body")
    expect(app.captureCharFrame()).toContain("3 connected")
    expect(app.captureCharFrame()).not.toContain("mcp body")

    // Every section expands: MCP opens when its header is clicked.
    const mcpRow = app.captureCharFrame().split("\n").findIndex((line) => line.includes("MCP"))
    await app.mockMouse.click(2, mcpRow)
    await app.waitForFrame((frame) => frame.includes("mcp body"))
    expect(app.captureCharFrame()).toContain("mcp body")

    const todoRow = app.captureCharFrame().split("\n").findIndex((line) => line.includes("TODO"))
    await app.mockMouse.click(2, todoRow)
    await app.waitForFrame((frame) => !frame.includes("todo body"))
    await app.mockMouse.click(2, todoRow)
    await app.waitForFrame((frame) => frame.includes("todo body"))
  } finally {
    app.renderer.destroy()
  }
})

test("registers sidebar content in the rail design order", async () => {
  const { builtins } = await import("../src/plugin/builtins")

  expect(
    builtins
      .map((plugin) => plugin.id)
      .filter((id) => id.startsWith("internal:sidebar-")),
  ).toEqual([
    "internal:sidebar-context",
    "internal:sidebar-todo",
    "internal:sidebar-subagents",
    "internal:sidebar-shells",
    "internal:sidebar-mcp",
  ])
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

test("renders the session title only inside the section body", async () => {
  const { SessionRailContent } = await import("../src/routes/session/sidebar")
  const app = await mount(() => <SessionRailContent sessionID="ses_0085fc701234567" title="New session — cache audit" />)
  await app.waitForFrame((frame) => frame.includes("New session — cache audit"))

  try {
    const rows = app.captureCharFrame().split("\n")
    // A long title on the header row squeezed the label down to "S", because the summary never shrinks.
    expect(rows[0]).toMatch(/^− SESSION *$/)
    expect(rows.slice(1).join("\n")).toContain("New session — cache audit")
  } finally {
    app.renderer.destroy()
  }
})

test("renders guardrail auto-approval only at effective YOLO 3", async () => {
  const { AutonomyRailContent } = await import("../src/routes/session/sidebar")
  const cases = [
    { name: "normal", autonomy: { mode: "normal", yolo: 0 }, expected: "enforced" },
    { name: "YOLO 0", autonomy: { mode: "normal", yolo: 0 }, expected: "enforced" },
    { name: "YOLO 1", autonomy: { mode: "normal", yolo: 1 }, expected: "enforced" },
    { name: "YOLO 2", autonomy: { mode: "normal", yolo: 2 }, expected: "enforced" },
    {
      name: "active goal below YOLO 3",
      autonomy: {
        mode: "normal",
        yolo: 2,
        goal: { text: "Ship safely", status: "active", iteration: 1, noProgress: 0, maxNoProgress: 3 },
      },
      expected: "enforced",
    },
    { name: "YOLO 3", autonomy: { mode: "normal", yolo: 3 }, expected: "auto · YOLO 3" },
  ] satisfies { name: string; autonomy: SessionAutonomyState; expected: string }[]

  for (const item of cases) {
    const app = await mount(() => <AutonomyRailContent autonomy={item.autonomy} />, { width: 40, height: 24 })
    await app.waitForFrame((frame) => frame.includes("Guardrails"))

    try {
      const row = app.captureCharFrame().split("\n").find((line) => line.includes("Guardrails"))
      expect(row?.trimEnd(), item.name).toEndWith(item.expected)
      const hard = app.captureCharFrame().split("\n").find((line) => line.includes("Hard reviews"))
      expect(hard?.trimEnd(), item.name).toEndWith("human only")
    } finally {
      app.renderer.destroy()
    }
  }
})

test("keeps autonomy semantics out of generic rail sections", async () => {
  const { RailSection } = await import("../src/routes/session/rail-section")
  const app = await mount(() => <RailSection section="autonomy" title="AUTONOMY" />)
  await app.waitForFrame((frame) => frame.includes("AUTONOMY"))

  try {
    expect(app.captureCharFrame()).not.toContain("Guardrails")
  } finally {
    app.renderer.destroy()
  }
})

test("renders aggregate context rows when diagnostics are unavailable", async () => {
  const [{ RailProvider }, { SidebarCacheContent }] = await Promise.all([
    import("../src/routes/session/rail-section"),
    import("../src/feature-plugins/sidebar/context"),
  ])
  const app = await mount(() => (
    <RailProvider>
      <SidebarCacheContent
        diagnostics={() => undefined}
        fallback={() => ({ tokens: { input: 1_411, output: 53 }, cost: 9.08 })}
      />
    </RailProvider>
  ))
  await app.waitForFrame((frame) => frame.includes("CONTEXT"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("SPEND")
    expect(frame).toContain("Total")
    expect(frame).toContain("$9.08")
    expect(frame).not.toContain("Spent")
    expect(frame).not.toContain("CACHE")
    expect(frame).not.toContain("Context")
  } finally {
    app.renderer.destroy()
  }
})

test("renders a summary on both expanded and collapsed headers", async () => {
  const { RailProvider, RailSection } = await import("../src/routes/session/rail-section")
  const app = await mount(() => (
    <RailProvider>
      <RailSection section="context" title="EXPANDED" summary="56% · 71% hit">
        <text>expanded body</text>
      </RailSection>
      <RailSection section="mcp" title="COLLAPSED" summary="3 connected" />
    </RailProvider>
  ))
  await app.waitForFrame((frame) => frame.includes("3 connected"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("56% · 71% hit")
    expect(frame).toContain("3 connected")
  } finally {
    app.renderer.destroy()
  }
})

test("renders compact operational rail summaries from live component state", async () => {
  const [{ RailProvider }, { SessionRailContent, AutonomyRailContent }, { TodoRailContent }, { SubagentRailContent }, { ShellRailContent }] =
    await Promise.all([
      import("../src/routes/session/rail-section"),
      import("../src/routes/session/sidebar"),
      import("../src/feature-plugins/sidebar/todo"),
      import("../src/feature-plugins/sidebar/subagents"),
      import("../src/feature-plugins/sidebar/shells"),
    ])
  const autonomy: SessionAutonomyState = { mode: "normal", yolo: true, goal: { text: "Ship summaries", status: "active", iteration: 1, noProgress: 0, maxNoProgress: 5 },
  }
  const app = await mount(
    () => (
      <box width={50}>
        <RailProvider allExpanded goal autonomy>
          <SessionRailContent sessionID="ses_summary" title="Summary session" />
          <AutonomyRailContent autonomy={autonomy} />
          <TodoRailContent list={[{ content: "Done", status: "completed", priority: "low" }, { content: "Open", status: "pending", priority: "low" }]} />
          <SubagentRailContent
            tasks={[
              { sessionID: "ses_running", description: "running", state: "running", elapsed: "2m" },
              { sessionID: "ses_waiting", description: "waiting", state: "waiting", question: { id: "question_ses_waiting", text: "Need input", time: 60_000 }, elapsed: "1m" },
            ]}
            summary={{ total: 12, active: 5, running: 3, waiting: 2 }}
            position="top"
            onLoadOlder={() => undefined}
          />
          <ShellRailContent
            groups={[
              { owner: { label: "Main chat" }, shells: [{ id: "running", status: "running" }] },
              { owner: { label: "Unknown session" }, shells: [{ id: "orphan", status: "failed" }] },
            ]}
            terminalCount={1}
          />
        </RailProvider>
      </box>
    ),
    { width: 189, height: 69 },
  )
  await app.waitForFrame((frame) => frame.includes("Summary session"))

  try {
    const frame = app.captureCharFrame()
    const expectations = [
      ["GOAL", "active"],
      ["AUTONOMY", "YOLO"],
      ["TODO LIST", "1/2 open"],
      ["SUBAGENTS", "3/12 running · 2 waiting"],
      ["SHELLS", "1/2 running · 1 orphaned"],
    ]
    for (const [title, summary] of expectations) {
      const header = frame.split("\n").find((line) => line.includes(title))
      expect(header).toContain(summary)
    }
    // Headers carry summaries; attention-owned sections may expand their bodies.
  } finally {
    app.renderer.destroy()
  }
})

test("keeps guardrail profile identity and surfaces only its highest-priority exception", async () => {
  const { guardrailSummary } = await import("../src/feature-plugins/sidebar/guardrails")
  const base: GuardrailStatusOutput = {
    rootSessionID: "ses_guardrail",
    profile: "standard",
    customRules: 0,
    approvals: 0,
    blocked: 0,
    counters: [],
    invalidFiles: [],
  }
  expect(guardrailSummary({ ...base, blocked: 2, invalidFiles: ["bad.md"] }).header).toBe("Standard · 2 blocked")
  expect(guardrailSummary({ ...base, invalidFiles: ["bad.md"] }).header).toBe("Standard · 1 invalid")
  expect(guardrailSummary(base).header).toBe("Standard")
})

test("leaves one blank row after expanded TODO content", async () => {
  const [{ RailProvider, RailSection }, { TodoRailContent }] = await Promise.all([
    import("../src/routes/session/rail-section"),
    import("../src/feature-plugins/sidebar/todo"),
  ])
  const app = await mount(() => (
    <RailProvider>
      <TodoRailContent
        list={[
          { content: "Running task", status: "pending", priority: "medium" },
          { content: "Completed task", status: "completed", priority: "low" },
        ]}
      />
      <RailSection section="mcp" title="NEXT" summary="next" />
    </RailProvider>
  ))
  await app.waitForFrame((frame) => frame.includes("TODO LIST"))

  try {
    await app.waitForFrame((frame) => frame.includes("Completed task"))

    const lines = app.captureCharFrame().split("\n")
    const completed = lines.findIndex((line) => line.includes("Completed task"))
    const next = lines.findIndex((line) => line.includes("NEXT"))
    expect(lines[completed + 1]?.trim()).toBe("")
    // The next section's three-row band vertically centers its title, so the title appears two rows
    // after the single separator. There is no second component-owned spacer.
    expect(next - completed).toBe(3)
  } finally {
    app.renderer.destroy()
  }
})

test("applies one outer surface row around populated expandable rail sections", async () => {
  const { RailProvider, RailRow, RailSection } = await import("../src/routes/session/rail-section")
  const app = await mount(() => (
    <RailProvider allExpanded>
      <RailSection section="session" title="SESSION" summary="audit">
        <RailRow label="session row" value="Active" />
      </RailSection>
      <RailSection section="context" title="CONTEXT" summary="56%">
        <RailRow label="context row" value="56%" />
      </RailSection>
      <RailSection section="todo" title="TODO LIST" summary="1/1 open">
        <RailRow label="todo row" value="Open" />
      </RailSection>
    </RailProvider>
  ))
  await app.waitForFrame((frame) => frame.includes("SESSION") && frame.includes("TODO LIST"))

  try {
    // session/context/todo expand by default, so all three bodies are already visible.
    await app.waitForFrame((frame) => frame.includes("session row"))

    const lines = app.captureCharFrame().split("\n")
    const pairs: Array<[string, string, string]> = [
      ["SESSION", "session row", "CONTEXT"],
      ["CONTEXT", "context row", "TODO LIST"],
    ]
    for (const [header, content, nextHeader] of pairs) {
      const headerRow = lines.findIndex((line) => line.includes(header))
      const contentRow = lines.findIndex((line) => line.includes(content))
      const nextRow = lines.findIndex((line) => line.includes(nextHeader))
      expect(contentRow - headerRow).toBe(3)
      expect(nextRow - contentRow).toBe(3)
      expect(lines[contentRow + 1]?.trim()).toBe("")
    }
  } finally {
    app.renderer.destroy()
  }
})

test("renders RailRow values right-aligned on a single line with custom value color", async () => {
  const { RailRow } = await import("../src/routes/session/rail-section")
  const [themeV2, setThemeV2] = createSignal<ReturnType<typeof useTheme>["themeV2"]>()
  const app = await mount(() => {
    setThemeV2(useTheme().themeV2)
    return <RailRow label="Hit ratio" value="71%" valueColor={themeV2()!.text.feedback.success.default} />
  })
  await app.waitForFrame((frame) => frame.includes("Hit ratio"))

  try {
    const rendered = descendants(app.renderer.root).filter(
      (item): item is TextRenderable => item instanceof TextRenderable,
    )
    const value = rendered.find((item) => item.plainText === "71%")
    const line = app.captureCharFrame().split("\n").find((item) => item.includes("Hit ratio"))

    expect(line?.endsWith("71%")).toBe(true)
    expect(value?.fg.toInts()).toEqual(themeV2()!.text.feedback.success.default.toInts())
  } finally {
    app.renderer.destroy()
  }
})

test("renders the CONTEXT design rows and omits unreported cache telemetry", async () => {
  const [{ RailProvider }, { SidebarCacheContent }] = await Promise.all([
    import("../src/routes/session/rail-section"),
    import("../src/feature-plugins/sidebar/context"),
  ])
  const [themeV2, setThemeV2] = createSignal<ReturnType<typeof useTheme>["themeV2"]>()
  const diagnostics: SessionCacheDiagnostics = {
    model: { providerID: "openai", id: "gpt-5.6" },
    context: { total: 1_464, limit: 200_000, percent: 56 },
    tokens: { uncachedInput: 1_411, output: 53, reasoning: 0, cacheRead: 220_672, cacheWrite: 4_096 },
    cache: {
      eligible: 220_672,
      hitRatio: 0.71,
      mechanism: "openai-prefix-cache",
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
  }
  const app = await mount(
    () => {
      setThemeV2(useTheme().themeV2)
      return (
        <RailProvider>
          <SidebarCacheContent diagnostics={() => diagnostics} cost={() => 9.08} />
        </RailProvider>
      )
    },
    { width: 40, height: 32 },
  )
  await app.waitForFrame((frame) => frame.includes("220,672"))

  try {
    const frame = app.captureCharFrame()
    const indexes = [
      "Model",
      "Context",
      "Cache",
      "SPEND",
      "Total",
      "CACHE",
      "Reads",
      "Writes",
    ].map((label) => frame.indexOf(label))
    const rendered = descendants(app.renderer.root).filter(
      (item): item is TextRenderable => item instanceof TextRenderable,
    )

    expect(indexes.every((index) => index >= 0)).toBe(true)
    expect(indexes).toEqual([...indexes].toSorted((left, right) => left - right))
    expect(rendered.find((item) => item.plainText === "71%")?.fg.toInts()).toEqual(
      themeV2()!.text.feedback.success.default.toInts(),
    )
    expect(rendered.find((item) => item.plainText === "220,672")?.fg.toInts()).toEqual(themeV2()!.text.default.toInts())
    expect(rendered.find((item) => item.plainText === "4,096")?.fg.toInts()).toEqual(themeV2()!.text.default.toInts())
    expect(frame).not.toContain("Prefix")
    expect(frame).not.toContain("prefix stable")
    expect(frame).not.toContain("Last step context")
    expect(frame).not.toContain("Cached tokens still occupy context.")
    expect(frame).not.toContain("Current model context")
    expect(frame).not.toContain("Last step provider cache")
    expect(frame).not.toContain("Limit")
    expect(frame).not.toContain("Input")
    expect(frame).not.toContain("Output")
    expect(frame).not.toContain("Used")
    expect(frame).not.toContain("Hit ratio")
  } finally {
    app.renderer.destroy()
  }

  const noReadOrPrefix = {
    ...diagnostics,
    tokens: { ...diagnostics.tokens, cacheWrite: 7 },
    cache: { ...diagnostics.cache, hitRatio: undefined, readReported: false },
    requests: undefined,
  }
  const missing = await mount(() => (
    <RailProvider>
      <SidebarCacheContent diagnostics={() => noReadOrPrefix} />
    </RailProvider>
  ))
  await missing.waitForFrame((frame) => frame.includes("CONTEXT"))
  try {
    const frame = missing.captureCharFrame()
    expect(frame.split("\n").find((line) => line.includes("Cache"))?.trimEnd()).toMatch(/^ +Cache +unreported$/)
    expect(frame).not.toContain("Reads")
    expect(frame).not.toContain("Prefix")
    // Unreported telemetry must never be coerced to zero. Match a standalone 0 value rather than the
    // digit anywhere, so a legitimate figure such as the 200K context limit does not trip it.
    expect(frame).not.toMatch(/\b0\b/)
  } finally {
    missing.renderer.destroy()
  }
})

test("renders the Profile row above Provider inside the Context section", async () => {
  const [{ RailProvider }, { SidebarCacheContent }] = await Promise.all([
    import("../src/routes/session/rail-section"),
    import("../src/feature-plugins/sidebar/context"),
  ])
  const diagnostics: SessionCacheDiagnostics = {
    model: { providerID: "openai", id: "gpt-5.6" },
    context: { total: 1_464, limit: 200_000, percent: 56 },
    tokens: { uncachedInput: 1_411, output: 53, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cache: { eligible: 0, hitRatio: undefined, mechanism: "none", readReported: false, writeReported: false },
    requests: undefined,
  }
  const app = await mount(
    () => (
      <RailProvider>
        <SidebarCacheContent diagnostics={() => diagnostics} profile={() => "Work"} />
      </RailProvider>
    ),
    { width: 40, height: 32 },
  )
  await app.waitForFrame((frame) => frame.includes("Work"))

  try {
    const frame = app.captureCharFrame()
    const profile = frame.indexOf("Profile")
    const provider = frame.indexOf("Provider")
    const model = frame.indexOf("Model")
    // Profile is credential identity and sits above the provider identity it resolves through.
    expect(profile).toBeGreaterThan(-1)
    expect(profile).toBeLessThan(provider)
    expect(provider).toBeLessThan(model)
  } finally {
    app.renderer.destroy()
  }
})

test("omits the Profile row when the provider has a single stored profile", async () => {
  const [{ RailProvider }, { SidebarCacheContent }] = await Promise.all([
    import("../src/routes/session/rail-section"),
    import("../src/feature-plugins/sidebar/context"),
  ])
  const diagnostics: SessionCacheDiagnostics = {
    model: { providerID: "openai", id: "gpt-5.6" },
    context: { total: 1_464, limit: 200_000, percent: 56 },
    tokens: { uncachedInput: 1_411, output: 53, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cache: { eligible: 0, hitRatio: undefined, mechanism: "none", readReported: false, writeReported: false },
    requests: undefined,
  }
  const app = await mount(() => (
    <RailProvider>
      <SidebarCacheContent diagnostics={() => diagnostics} />
    </RailProvider>
  ))
  await app.waitForFrame((frame) => frame.includes("CONTEXT"))

  try {
    expect(app.captureCharFrame()).not.toContain("Profile")
  } finally {
    app.renderer.destroy()
  }
})

test("renders a non-toggleable CACHE sub-heading inside the toggleable CONTEXT section", async () => {
  const { RailProvider, RailSection, RailSubheading } = await import("../src/routes/session/rail-section")
  const [themeV2, setThemeV2] = createSignal<ReturnType<typeof useTheme>["themeV2"]>()
  const app = await mount(() => {
    setThemeV2(useTheme().themeV2)
    return (
      <RailProvider>
        <RailSection section="context" title="CONTEXT">
          <RailSubheading>CACHE</RailSubheading>
          <text>cache body</text>
        </RailSection>
      </RailProvider>
    )
  })
  await app.waitForFrame((frame) => frame.includes("cache body"))

  try {
    const rendered = descendants(app.renderer.root).filter(
      (item): item is TextRenderable => item instanceof TextRenderable,
    )
    const heading = rendered.find((item) => item.plainText === "CONTEXT")
    const subheading = rendered.find((item) => item.plainText === "CACHE")
    const lines = app.captureCharFrame().split("\n")
    const headingRow = lines.findIndex((line) => line.includes("CONTEXT"))
    const subheadingRow = lines.findIndex((line) => line.includes("CACHE"))

    expect(heading?.fg.toInts()).toEqual(themeV2()!.text.feedback.success.default.toInts())
    expect(subheading?.fg.toInts()).toEqual(themeV2()!.text.label.toInts())
    expect(lines[subheadingRow]?.trim()).toBe("CACHE")

    await app.mockMouse.click(1, subheadingRow)
    await app.waitForFrame((frame) => frame.includes("cache body"))

    await app.mockMouse.click(2, headingRow)
    await app.waitForFrame((frame) => !frame.includes("cache body"))
    expect(heading?.fg.toInts()).toEqual(themeV2()!.text.feedback.info.default.toInts())

    await app.mockMouse.click(2, headingRow)
    await app.waitForFrame((frame) => frame.includes("cache body"))
  } finally {
    app.renderer.destroy()
  }
})

test("renders rail header glyphs and colors for expanded, collapsed, and attention states", async () => {
  const { RailProvider, RailSection } = await import("../src/routes/session/rail-section")
  const [themeV2, setThemeV2] = createSignal<ReturnType<typeof useTheme>["themeV2"]>()
  const app = await mount(() => {
    setThemeV2(useTheme().themeV2)
    return (
      <RailProvider>
        <RailSection section="todo" title="EXPANDED" />
        <RailSection section="mcp" title="COLLAPSED" />
        <RailSection section="context" title="ATTENTION EXPANDED" attention />
        <RailSection section="session" title="ATTENTION COLLAPSED" attention />
      </RailProvider>
    )
  })
  await app.waitForFrame((frame) => frame.includes("ATTENTION COLLAPSED"))

  try {
    const rendered = descendants(app.renderer.root).filter(
      (item): item is TextRenderable => item instanceof TextRenderable,
    )
    const header = (title: string) => {
      const index = rendered.findIndex((item) => item.plainText === title)
      return [rendered[index - 1], rendered[index]]
    }
    const expanded = header("EXPANDED")
    const collapsed = header("COLLAPSED")
    const attentionExpanded = header("ATTENTION EXPANDED")
    const attentionCollapsed = header("ATTENTION COLLAPSED")

    expect(expanded[0]?.plainText).toBe("\u2212")
    expect(expanded[0]?.fg.toInts()).toEqual(themeV2()!.text.feedback.success.default.toInts())
    expect(expanded[1]?.fg.toInts()).toEqual(themeV2()!.text.feedback.success.default.toInts())
    expect(collapsed[0]?.plainText).toBe("+")
    expect(collapsed[0]?.fg.toInts()).toEqual(themeV2()!.text.feedback.info.default.toInts())
    expect(collapsed[1]?.fg.toInts()).toEqual(themeV2()!.text.feedback.info.default.toInts())
    expect(attentionExpanded[0]?.plainText).toBe("\u2212")
    expect(attentionExpanded[0]?.fg.toInts()).toEqual(themeV2()!.text.feedback.warning.default.toInts())
    expect(attentionExpanded[1]?.fg.toInts()).toEqual(themeV2()!.text.feedback.warning.default.toInts())
    expect(attentionCollapsed[0]?.plainText).toBe("\u2212")
    expect(attentionCollapsed[0]?.fg.toInts()).toEqual(themeV2()!.text.feedback.warning.default.toInts())
    expect(attentionCollapsed[1]?.fg.toInts()).toEqual(themeV2()!.text.feedback.warning.default.toInts())
  } finally {
    app.renderer.destroy()
  }
})

test("auto-expands an expandable section on attention and re-collapses once it clears", async () => {
  const { RailProvider, RailSection } = await import("../src/routes/session/rail-section")
  const [waiting, setWaiting] = createSignal(false)
  const app = await mount(() => (
    <RailProvider>
      <RailSection section="todo" title="TODO" summary="1 open" attention={waiting()}>
        <text>todo body</text>
      </RailSection>
    </RailProvider>
  ))
  await app.waitForFrame((frame) => frame.includes("TODO"))
  // TODO starts expanded; collapse it first so attention ownership is observable.
  const headingRow = app.captureCharFrame().split("\n").findIndex((line) => line.includes("TODO"))
  await app.mockMouse.click(2, headingRow)
  await app.waitForFrame((frame) => !frame.includes("todo body"))

  setWaiting(true)
  await app.waitForFrame((frame) => frame.includes("todo body"))

  setWaiting(false)
  await app.waitForFrame((frame) => !frame.includes("todo body"))
  app.renderer.destroy()
})

test("expands every section on attention", async () => {
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
  try {
    expect(app.captureCharFrame()).not.toContain("subagent body")
    setWaiting(true)
    await app.waitForFrame((frame) => frame.includes("subagent body"))
    expect(app.captureCharFrame()).toContain("subagent body")
    setWaiting(false)
    await app.waitForFrame((frame) => !frame.includes("subagent body"))
    expect(app.captureCharFrame()).not.toContain("subagent body")
  } finally {
    app.renderer.destroy()
  }
})

test("renders distinct GOAL and AUTONOMY sections, SUBAGENTS and SHELLS rail rows, and a TODO LIST in the correct order", async () => {
  const [{ SessionRailContent, AutonomyRailContent }, { TodoRailContent }, { SubagentRailContent }, { ShellRailContent }] =
    await Promise.all([
      import("../src/routes/session/sidebar"),
      import("../src/feature-plugins/sidebar/todo"),
      import("../src/feature-plugins/sidebar/subagents"),
      import("../src/feature-plugins/sidebar/shells"),
    ])
  const [themeV2, setThemeV2] = createSignal<ReturnType<typeof useTheme>["themeV2"]>()
  const autonomy: SessionAutonomyState = { mode: "normal", yolo: true, goal: {
      text: "Fix provider cache accounting",
      status: "active",
      iteration: 3,
      noProgress: 3,
      maxNoProgress: 5,
    },
  }
  const todos: SessionTodoInfo[] = [{ content: "Verify baseline", status: "completed", priority: "medium" }]
  const app = await mount(() => {
    setThemeV2(useTheme().themeV2)
    return (
      <>
        <SessionRailContent sessionID="ses_0085fc701234567" title="Provider cache audit" />
        <AutonomyRailContent autonomy={autonomy} />
        <TodoRailContent list={todos} />
        <SubagentRailContent tasks={[{ sessionID: "ses_docs", description: "docs-sync", state: "running", elapsed: "2m14s" }]} />
        <ShellRailContent groups={[{ owner: { label: "docs-sync" }, shells: [{ id: "running" }] }]} terminalCount={0} />
      </>
    )
  }, { width: 40, height: 60 })
  await app.waitForFrame((frame) => frame.includes("Fix provider cache accounting"))

  try {
    const frame = app.captureCharFrame()
    const rendered = descendants(app.renderer.root).filter(
      (item): item is TextRenderable => item instanceof TextRenderable,
    )
    const sectionHeaders = [
      "SESSION",
      "GOAL",
      "AUTONOMY",
      "TODO LIST",
      "SUBAGENTS",
      "SHELLS",
    ]
    const indexes = sectionHeaders.map((label) => frame.indexOf(label))
    expect(indexes.every((index) => index >= 0)).toBe(true)
    expect(indexes).toEqual([...indexes].toSorted((left, right) => left - right))

    // The GOAL no-progress count is hidden by explicit user instruction.
    expect(frame).not.toContain("3 / 5")
    expect(frame).toContain("Fix provider cache accounting")
    expect(frame).toContain("Status")
    expect(frame).toContain("active")
    expect(frame).toContain("Approvals")
    expect(frame).toContain("auto")
    expect(frame).toContain("Guardrails")
    expect(frame).toContain("enforced")
    expect(frame).not.toContain("ses_0085fc701234567")
    expect(frame).not.toContain("workspace")
    expect(frame).toContain("docs-sync")
    const subagentHeader = frame.split("\n").find((line) => line.includes("SUBAGENTS"))
    expect(subagentHeader).toContain("1/1 running")
    expect(subagentHeader).not.toContain("subagents")
    expect(rendered.find((item) => item.plainText === "2m14s")?.fg.toInts()).toEqual(
      themeV2()!.text.feedback.info.default.toInts(),
    )
    expect(rendered.find((item) => item.plainText === "docs-sync")?.fg.toInts()).toEqual(
      themeV2()!.text.subdued.toInts(),
    )
  } finally {
    app.renderer.destroy()
  }
})

function descendants(root: { getChildren(): readonly unknown[] }): unknown[] {
  return root.getChildren().flatMap((child) => (hasChildren(child) ? [child, ...descendants(child)] : [child]))
}

function hasChildren(value: unknown): value is { getChildren(): readonly unknown[] } {
  return typeof value === "object" && value !== null && "getChildren" in value && typeof value.getChildren === "function"
}

test("an attention event preserves default-expanded sections and releases its own section", async () => {
  const { RailProvider, RailSection } = await import("../src/routes/session/rail-section")
  const [contextAttention, setContextAttention] = createSignal(false)
  const [todoAttention, setTodoAttention] = createSignal(false)
  const app = await mount(
    () => (
      <RailProvider goal autonomy>
        <RailSection section="context" title="CONTEXT" attention={contextAttention()}>
          <text>context body</text>
        </RailSection>
        <RailSection section="session" title="SESSION">
          <text>session body</text>
        </RailSection>
        <RailSection section="todo" title="TODO" attention={todoAttention()}>
          <text>todo body</text>
        </RailSection>
      </RailProvider>
    ),
    { width: 40, height: 60 },
  )
  await app.waitForFrame((frame) => frame.includes("context body"))
  expect(app.captureCharFrame()).toContain("todo body")

  // Collapse TODO so attention ownership is observable; CONTEXT stays expanded throughout.
  const todoRow = app.captureCharFrame().split("\n").findIndex((line) => line.includes("TODO"))
  await app.mockMouse.click(2, todoRow)
  await app.waitForFrame((frame) => !frame.includes("todo body"))

  setTodoAttention(true)
  await app.waitForFrame((frame) => frame.includes("todo body"))

  const frame = app.captureCharFrame()
  expect(frame).toContain("context body")
  expect(frame).toContain("session body")
  expect(frame).toContain("todo body")

  setContextAttention(true)
  await app.waitForFrame((value) => value.includes("context body"))
  setContextAttention(false)
  await app.waitForFrame((value) => value.includes("context body"))

  setTodoAttention(false)
  await app.waitForFrame((value) => !value.includes("todo body"))
  const cleared = app.captureCharFrame()
  expect(cleared).toContain("context body")
  expect(cleared).toContain("session body")
  expect(cleared).not.toContain("todo body")
  app.renderer.destroy()
})

test("a user can toggle an expandable section from its header", async () => {
  const { RailProvider, RailSection } = await import("../src/routes/session/rail-section")
  const app = await mount(() => (
    <RailProvider>
      <RailSection section="todo" title="TODO" summary="1 open">
        <text>todo body</text>
      </RailSection>
    </RailProvider>
  ))
  await app.waitForFrame((frame) => frame.includes("TODO"))

  try {
    expect(app.captureCharFrame()).toContain("todo body")
    const headingRow = app.captureCharFrame().split("\n").findIndex((line) => line.includes("TODO"))
    await app.mockMouse.click(2, headingRow)
    await app.waitForFrame((frame) => !frame.includes("todo body"))
    await app.mockMouse.click(2, headingRow)
    await app.waitForFrame((frame) => frame.includes("todo body"))
  } finally {
    app.renderer.destroy()
  }
})

test("every section toggles from its header", async () => {
  const { RailProvider, RailSection } = await import("../src/routes/session/rail-section")
  const app = await mount(() => (
    <RailProvider>
      <RailSection section="mcp" title="MCP" summary="1 active">
        <text>mcp body</text>
      </RailSection>
    </RailProvider>
  ))
  await app.waitForFrame((frame) => frame.includes("1 active"))

  try {
    expect(app.captureCharFrame()).not.toContain("mcp body")
    const headingRow = app.captureCharFrame().split("\n").findIndex((line) => line.includes("MCP"))
    await app.mockMouse.click(2, headingRow)
    await app.waitForFrame((frame) => frame.includes("mcp body"))
    expect(app.captureCharFrame()).toContain("mcp body")
    await app.mockMouse.click(2, headingRow)
    await app.waitForFrame((frame) => !frame.includes("mcp body"))
    expect(app.captureCharFrame()).not.toContain("mcp body")
  } finally {
    app.renderer.destroy()
  }
})

test("preserves user toggles across session prop changes", async () => {
  const { RailProvider, RailSection } = await import("../src/routes/session/rail-section")
  const [goal, setGoal] = createSignal(false)
  const app = await mount(() => (
    <RailProvider goal={goal()} autonomy={goal()}>
      <RailSection section="context" title="CONTEXT">
        <text>context body</text>
      </RailSection>
      <RailSection section="todo" title="TODO">
        <text>todo body</text>
      </RailSection>
    </RailProvider>
  ))
  await app.waitForFrame((frame) => frame.includes("context body"))

  try {
    expect(app.captureCharFrame()).toContain("todo body")
    const headingRow = app.captureCharFrame().split("\n").findIndex((line) => line.includes("TODO"))
    await app.mockMouse.click(2, headingRow)
    await app.waitForFrame((frame) => !frame.includes("todo body"))
    // Simulate navigating to a subagent chat and back by changing session-driven props.
    setGoal(true)
    await app.waitForFrame((frame) => frame.includes("CONTEXT"))
    expect(app.captureCharFrame()).toContain("context body")
    expect(app.captureCharFrame()).not.toContain("todo body")
    setGoal(false)
    await app.waitForFrame((frame) => frame.includes("CONTEXT"))
    expect(app.captureCharFrame()).not.toContain("todo body")
  } finally {
    app.renderer.destroy()
  }
})

test("preserves expand/collapse across Session remounts (main <-> subagent)", async () => {
  const { RailProvider, RailSection } = await import("../src/routes/session/rail-section")
  const app = await mount(() => (
    <RailProvider>
      <RailSection section="context" title="CONTEXT">
        <text>context body</text>
      </RailSection>
      <RailSection section="todo" title="TODO">
        <text>todo body</text>
      </RailSection>
    </RailProvider>
  ))
  await app.waitForFrame((frame) => frame.includes("todo body"))
  try {
    const headingRow = app.captureCharFrame().split("\n").findIndex((line) => line.includes("TODO"))
    await app.mockMouse.click(2, headingRow)
    await app.waitForFrame((frame) => !frame.includes("todo body"))
  } finally {
    app.renderer.destroy()
  }

  // Remount simulates navigating to a subagent chat and back; the Session route is keyed by
  // sessionID so the whole provider remounts.
  const next = await mount(() => (
    <RailProvider>
      <RailSection section="context" title="CONTEXT">
        <text>context body</text>
      </RailSection>
      <RailSection section="todo" title="TODO">
        <text>todo body</text>
      </RailSection>
    </RailProvider>
  ))
  await next.waitForFrame((frame) => frame.includes("CONTEXT"))
  try {
    expect(next.captureCharFrame()).toContain("context body")
    expect(next.captureCharFrame()).not.toContain("todo body")
  } finally {
    next.renderer.destroy()
  }
})

test("renders accurate shell summaries and expands on orphaned-shell attention", async () => {
  const [{ RailProvider }, { ShellRailContent }] = await Promise.all([
    import("../src/routes/session/rail-section"),
    import("../src/feature-plugins/sidebar/shells"),
  ])
  const [orphaned, setOrphaned] = createSignal(false)
  const app = await mount(() => (
    <RailProvider>
      <ShellRailContent
        groups={
          orphaned()
            ? [
                { owner: { label: "Main chat" }, shells: [{ id: "running" }] },
                { owner: { label: "Unknown session" }, shells: [{ id: "orphan", status: "failed" }] },
              ]
            : [{ owner: { label: "Main chat" }, shells: [{ id: "running" }] }]
        }
        terminalCount={1}
      />
    </RailProvider>
  ))
  await app.waitForFrame((frame) => frame.includes("SHELLS"))

  try {
    let frame = app.captureCharFrame()
    expect(frame).toContain("1/2 running")
    expect(frame).not.toContain("orphaned")
    expect(frame).not.toContain("Main chat")

    // Orphaned attention expands SHELLS to show its bodies.
    setOrphaned(true)
    await app.waitForFrame((value) => value.includes("1 orphaned"))
    await app.waitForFrame((value) => value.includes("Main chat"))
    expect(app.captureCharFrame()).toContain("Unknown session 1")

    setOrphaned(false)
    await app.waitForFrame((value) => !value.includes("orphaned"))
    await app.waitForFrame((value) => !value.includes("Main chat"))
    frame = app.captureCharFrame()
    expect(frame).toContain("1/2 running")
  } finally {
    app.renderer.destroy()
  }
})

test("expands SHELLS when its header is toggled", async () => {
  const [{ RailProvider }, { SessionRailContent }, { ShellRailContent }] = await Promise.all([
    import("../src/routes/session/rail-section"),
    import("../src/routes/session/sidebar"),
    import("../src/feature-plugins/sidebar/shells"),
  ])
  const app = await mount(() => (
    <RailProvider shellSurface>
      <SessionRailContent sessionID="ses_0085fc701234567" title="Provider cache audit" />
      <ShellRailContent
        groups={[
          { owner: { label: "Main chat" }, shells: [{ id: "main" }] },
          { owner: { label: "docs-sync" }, shells: [{ id: "docs" }] },
        ]}
        terminalCount={1}
      />
    </RailProvider>
  ))
  await app.waitForFrame((frame) => frame.includes("SHELLS"))

  try {
    expect(app.captureCharFrame()).toContain("SHELLS")
    expect(app.captureCharFrame()).not.toContain("Main chat")
    const headingRow = app.captureCharFrame().split("\n").findIndex((line) => line.includes("SHELLS"))
    await app.mockMouse.click(2, headingRow)
    await app.waitForFrame((frame) => frame.includes("Main chat"))
    const frame = app.captureCharFrame()

    expect(frame).toContain("SHELLS")
    expect(frame).toContain("Main chat")
    expect(frame).toContain("docs-sync")
  } finally {
    app.renderer.destroy()
  }
})
