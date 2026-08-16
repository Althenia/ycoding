/** @jsxImportSource @opentui/solid */
import { TextRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { SessionAutonomyState, SessionCacheDiagnostics, SessionTodoInfo } from "@ycoding-ai/client"
import { expect, test } from "bun:test"
import { createSignal, type JSX } from "solid-js"
import { useTheme } from "../src/context/theme"
import type { SessionSkill } from "../src/util/session-skills"
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
    { width: 40, height: 20, useMouse: true },
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

test("keeps the SESSION header separate from its session title", async () => {
  const { SessionRailContent } = await import("../src/routes/session/sidebar")
  const app = await mount(() => <SessionRailContent sessionID="ses_0085fc701234567" title="New session — cache audit" />)
  await app.waitForFrame((frame) => frame.includes("New session — cache audit"))

  try {
    const [header] = app.captureCharFrame().split("\n")
    expect(header?.trim()).toBe("− SESSION")
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
    expect(frame).toContain("Input")
    expect(frame).toContain("1,411")
    expect(frame).toContain("Output")
    expect(frame).toContain("53")
    expect(frame).toContain("Spent")
    expect(frame).toContain("$9.08")
    expect(frame).toContain("CACHE")
    expect(frame).not.toContain("Used")
    expect(frame).not.toContain("Hit ratio")
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
    context: { total: 1_464, percent: 56 },
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
  const app = await mount(() => {
    setThemeV2(useTheme().themeV2)
    return (
      <RailProvider>
        <SidebarCacheContent diagnostics={() => diagnostics} cost={() => 9.08} subagentCost={() => 1.24} />
      </RailProvider>
    )
  })
  await app.waitForFrame((frame) => frame.includes("220,672"))

  try {
    const frame = app.captureCharFrame()
    const indexes = ["Input", "Output", "Used", "Spent", "· subagents", "CACHE", "Hit ratio", "Prefix", "Reads", "Writes"].map(
      (label) => frame.indexOf(label),
    )
    const rendered = descendants(app.renderer.root).filter(
      (item): item is TextRenderable => item instanceof TextRenderable,
    )

    expect(indexes.every((index) => index >= 0)).toBe(true)
    expect(indexes).toEqual([...indexes].toSorted((left, right) => left - right))
    expect(rendered.find((item) => item.plainText === "71%")?.fg.toInts()).toEqual(
      themeV2()!.text.feedback.success.default.toInts(),
    )
    expect(rendered.find((item) => item.plainText === "stable")?.fg.toInts()).toEqual(
      themeV2()!.text.feedback.success.default.toInts(),
    )
    expect(rendered.find((item) => item.plainText === "220,672")?.fg.toInts()).toEqual(themeV2()!.text.default.toInts())
    expect(rendered.find((item) => item.plainText === "4,096")?.fg.toInts()).toEqual(themeV2()!.text.default.toInts())
    expect(frame).not.toContain("Last step context")
    expect(frame).not.toContain("Cached tokens still occupy context.")
    expect(frame).not.toContain("Current model context")
    expect(frame).not.toContain("Last step provider cache")
  } finally {
    app.renderer.destroy()
  }

  const noReadOrPrefix = {
    ...diagnostics,
    tokens: { ...diagnostics.tokens, cacheWrite: 7 },
    cache: { ...diagnostics.cache, readReported: false },
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
    expect(frame).not.toContain("Reads")
    expect(frame).not.toContain("Prefix")
    expect(frame).not.toContain("0")
  } finally {
    missing.renderer.destroy()
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

    expect(heading?.fg.toInts()).toEqual(themeV2()!.text.feedback.success.default.toInts())
    expect(subheading?.fg.toInts()).toEqual(themeV2()!.text.label.toInts())
    expect(app.captureCharFrame().split("\n").find((line) => line.includes("CACHE"))?.trim()).toBe("CACHE")

    await app.mockMouse.click(1, 1)
    await app.waitForFrame((frame) => frame.includes("cache body"))

    await app.mockMouse.click(2, 0)
    await app.waitForFrame((frame) => !frame.includes("cache body"))
    expect(heading?.fg.toInts()).toEqual(themeV2()!.text.feedback.info.default.toInts())

    await app.mockMouse.click(2, 0)
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
        <RailSection section="subagents" title="ATTENTION EXPANDED" attention />
        <RailSection section="shells" title="ATTENTION COLLAPSED" attention />
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

test("renders distinct GOAL and AUTONOMY sections, SUBAGENTS and SHELLS rail rows, and a TODO LIST in the correct order", async () => {
  const [{ SessionRailContent, AutonomyRailContent }, { TodoRailContent }, { SubagentRailContent }, { ShellRailContent }, { SkillsRailContent }] =
    await Promise.all([
      import("../src/routes/session/sidebar"),
      import("../src/feature-plugins/sidebar/todo"),
      import("../src/feature-plugins/sidebar/subagents"),
      import("../src/feature-plugins/sidebar/shells"),
      import("../src/feature-plugins/sidebar/skills"),
    ])
  const [themeV2, setThemeV2] = createSignal<ReturnType<typeof useTheme>["themeV2"]>()
  const autonomy: SessionAutonomyState = {
    mode: "yolo",
    goal: {
      text: "Fix provider cache accounting",
      status: "active",
      iteration: 3,
      noProgress: 3,
      maxNoProgress: 5,
    },
  }
  const todos: SessionTodoInfo[] = [{ content: "Verify baseline", status: "completed", priority: "medium" }]
  const skills: SessionSkill[] = [
    {
      id: "review",
      name: "Code Review",
      activatedBy: "tool",
      activationMessageID: "msg_skill",
      content: "Review the change.",
      conflicts: [],
      declarations: {},
      state: "active",
    },
  ]
  const app = await mount(() => {
    setThemeV2(useTheme().themeV2)
    return (
      <>
        <SessionRailContent sessionID="ses_0085fc701234567" title="Provider cache audit" />
        <AutonomyRailContent autonomy={autonomy} />
        <SubagentRailContent tasks={[{ sessionID: "ses_docs", description: "docs-sync", elapsed: "2m14s" }]} />
        <ShellRailContent groups={[{ owner: { label: "docs-sync" }, shells: [{ id: "running" }] }]} terminalCount={0} />
        <SkillsRailContent skills={skills} />
        <TodoRailContent list={todos} />
      </>
    )
  })
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
      "SUBAGENTS",
      "SHELLS",
      "SKILLS",
      "TODO LIST",
    ]
    const indexes = sectionHeaders.map((label) => frame.indexOf(label))
    expect(indexes.every((index) => index >= 0)).toBe(true)
    expect(indexes).toEqual([...indexes].toSorted((left, right) => left - right))

    expect(frame).toContain("3 / 5")
    expect(frame).toContain("Fix provider cache accounting")
    expect(frame).toContain("Status")
    expect(frame).toContain("active")
    expect(frame).toContain("Approvals")
    expect(frame).toContain("auto")
    expect(frame).not.toContain("Guardrails")
    expect(frame).toContain("ses_0085fc701…")
    expect(frame).not.toContain("workspace")
    expect(frame).toContain("docs-sync")
    expect(frame).toContain("1 active")
    expect(rendered.find((item) => item.plainText === "2m14s")?.fg.toInts()).toEqual(
      themeV2()!.text.feedback.info.default.toInts(),
    )
    expect(rendered.find((item) => item.plainText === "1")?.fg.toInts()).toEqual(themeV2()!.text.feedback.info.default.toInts())
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

test("renders a five-segment meter in the GOAL section with correct filled/empty counts and colours", async () => {
  const { RailProvider } = await import("../src/routes/session/rail-section")
  const { AutonomyRailContent } = await import("../src/routes/session/sidebar")
  const [themeV2, setThemeV2] = createSignal<ReturnType<typeof useTheme>["themeV2"]>()
  const autonomy: SessionAutonomyState = {
    mode: "yolo",
    goal: {
      text: "Fix provider cache accounting",
      status: "active",
      iteration: 3,
      noProgress: 3,
      maxNoProgress: 5,
    },
  }
  const app = await mount(() => {
    setThemeV2(useTheme().themeV2)
    return (
      <RailProvider goal>
        <AutonomyRailContent autonomy={autonomy} />
      </RailProvider>
    )
  })
  await app.waitForFrame((frame) => frame.includes("Fix provider cache accounting"))

  try {
    const frame = app.captureCharFrame()
    // The section header summary shows "3 / 5"
    expect(frame).toContain("3 / 5")
    // The meter renders as 5 segments — 3 filled (success) and 2 empty (dim)
    const rendered = descendants(app.renderer.root).filter(
      (item): item is TextRenderable => item instanceof TextRenderable,
    )
    const filledSegments = rendered.filter(
      (item) => item.plainText === "█" && item.fg.toInts().every((v, i) => v === themeV2()!.text.feedback.success.default.toInts()[i]),
    )
    const emptySegments = rendered.filter(
      (item) => item.plainText === "█" && item.fg.toInts().every((v, i) => v === themeV2()!.border.default.toInts()[i]),
    )
    expect(filledSegments).toHaveLength(3)
    expect(emptySegments).toHaveLength(2)
  } finally {
    app.renderer.destroy()
  }
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

test("a user can toggle a collapsed section from its header", async () => {
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
    await app.mockMouse.click(2, 0)
    await app.waitForFrame((frame) => frame.includes("mcp body"))
    await app.mockMouse.click(2, 0)
    await app.waitForFrame((frame) => !frame.includes("mcp body"))
  } finally {
    app.renderer.destroy()
  }
})

test("renders accurate shell and skills summaries and releases orphaned-shell attention", async () => {
  const [{ RailProvider }, { ShellRailContent }, { SkillsRailContent }] = await Promise.all([
    import("../src/routes/session/rail-section"),
    import("../src/feature-plugins/sidebar/shells"),
    import("../src/feature-plugins/sidebar/skills"),
  ])
  const [orphaned, setOrphaned] = createSignal(false)
  const skills: SessionSkill[] = [
    {
      id: "review",
      name: "Code Review",
      activatedBy: "tool",
      activationMessageID: "msg_skill",
      content: "Review the change.",
      conflicts: [],
      declarations: {},
      state: "active",
    },
  ]
  const app = await mount(() => (
    <RailProvider>
      <ShellRailContent
        groups={
          orphaned()
            ? [
                { owner: { label: "Main chat" }, shells: [{ id: "running" }] },
                { owner: { label: "Unknown session" }, shells: [{ id: "orphan" }] },
              ]
            : [{ owner: { label: "Main chat" }, shells: [{ id: "running" }] }]
        }
        terminalCount={1}
      />
      <SkillsRailContent skills={skills} />
    </RailProvider>
  ))
  await app.waitForFrame((frame) => frame.includes("SHELLS"))

  try {
    let frame = app.captureCharFrame()
    expect(frame).toContain("1 running, 1 terminal")
    expect(frame).toContain("1 active")

    setOrphaned(true)
    await app.waitForFrame((value) => value.includes("Unknown session 1"))

    setOrphaned(false)
    await app.waitForFrame((value) => !value.includes("Unknown session 1"))
    frame = app.captureCharFrame()
    expect(frame).toContain("1 running, 1 terminal")
  } finally {
    app.renderer.destroy()
  }
})

test("prioritizes and expands SHELLS only while the Shell composer surface is active", async () => {
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
    const frame = app.captureCharFrame()

    expect(frame).toContain("− SHELLS")
    expect(frame).toContain("Main chat")
    expect(frame).toContain("docs-sync")
  } finally {
    app.renderer.destroy()
  }
})
