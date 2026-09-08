/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { json } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const sessionID = "ses_picker_layout"
const directory = "/tmp/ycoding/subagent-picker-layout"
const location = { directory, project: { id: "proj_picker_layout", directory } }
const session = {
  id: sessionID,
  title: "Subagent picker layout",
  projectID: "proj_picker_layout",
  location: { directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5", variant: "high" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}
const tasks = [
  {
    sessionID: "ses_picker_running",
    parentID: sessionID,
    description: "Core summarization policy and TOON repair across the runtime packages",
    agent: "zeus",
    model: { providerID: "anthropic", id: "claude-opus-5", variant: "high" },
    background: true,
    state: "running",
    revision: 1,
    time: { created: 1, updated: 2 },
  },
  {
    sessionID: "ses_picker_done",
    parentID: sessionID,
    description: "Audit duplicate keybinds",
    agent: "keymap-audit",
    model: { providerID: "anthropic", id: "claude-haiku-4-5" },
    background: true,
    state: "completed",
    revision: 1,
    time: { created: 1, updated: 2 },
  },
] as const

function promptRow(lines: string[]) {
  return lines.findIndex((line) => line.includes("Message YCoding…"))
}

/** The prompt band starts at its own rule, so the band height is footer minus rule. */
function composerBand(lines: string[]) {
  const prompt = promptRow(lines)
  const rule = lines.findLastIndex((line, index) => index < prompt && line.includes("─"))
  const footer = lines.findIndex((line) => line.includes("goal off"))
  expect(prompt).toBeGreaterThan(-1)
  expect(rule).toBeGreaterThan(-1)
  expect(footer).toBeGreaterThan(prompt)
  return { rule, prompt, footer, height: footer - rule }
}

async function waitForFrameText(screen: { frame(): string }, text: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (screen.frame().includes(text)) return
    await Bun.sleep(20)
  }
  expect(screen.frame()).toContain(text)
}

test("keeps every picker task on one row, orders Subagents before Shell, and never resizes the composer", async () => {
  const width = 220
  const screen = await renderScreen({ width, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    await waitForFrameText(screen, "1/2 running")
    const closed = composerBand(screen.lines())

    await screen.mouse.click(3, closed.prompt)
    screen.input.pressKey("ARROW_DOWN")
    await waitForFrameText(screen, "zeus")

    const lines = screen.lines()
    const open = composerBand(lines)

    // Defect 3: the picker must not change the composer's resting height, and dropping the
    // half-viewport reservation must still leave the list and its hint row rendered.
    expect(open.height).toBe(closed.height)
    const frame = lines.join("\n")
    expect(frame).toContain("ACTIVE")
    expect(frame).toContain("INACTIVE")
    const hints = lines.findIndex((line) => line.includes("Enter attach"))
    expect(hints).toBeGreaterThan(-1)
    expect(hints).toBeLessThan(open.rule)
    expect(lines[hints]).toContain("↑↓ move")
    expect(lines[hints]).toContain("⌃x k cancel")
    expect(lines[hints]).toContain("r answer")
    expect(lines[hints]).toContain("Esc close")

    // Defect 2: Subagents leads the tab strip.
    const tabs = lines.findIndex((line) => line.includes("Subagents"))
    expect(tabs).toBeGreaterThan(-1)
    expect(lines[tabs]?.indexOf("Subagents")).toBeLessThan(lines[tabs]!.indexOf("Shell"))
    expect(lines[tabs]?.indexOf("Subagents")).toBe(3)

    // Defect 1: one row per task carrying state, agent, description and metadata together.
    const running = lines.findIndex((line) => line.includes("zeus"))
    expect(running).toBeGreaterThan(tabs)
    expect(lines[running]).toContain("running")
    expect(lines[running]).toContain("· Core summarization policy")
    expect(lines[running]).toContain("anthropic/claude-opus-5#high")
    expect(lines[running]).toContain("attached")
    expect(lines[running + 1]).not.toContain("anthropic/")
    const completed = lines.findIndex((line) => line.includes("keymap-audit"))
    expect(lines[completed]).toContain("completed")
    expect(lines[completed]).toContain("anthropic/claude-haiku-4-5")
    expect(lines[completed + 1]).not.toContain("anthropic/")
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(width)

    screen.input.pressKey("ESCAPE")
    await waitForFrameText(screen, "Message YCoding…")
    await Bun.sleep(100)
    expect(composerBand(screen.lines()).height).toBe(closed.height)
  } finally {
    await screen.dispose()
  }
}, 120_000)

async function route(url: URL) {
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
  if (tasks.some((task) => url.pathname === `/api/session/${task.sessionID}/message`)) return json({ data: [], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}/subagent`)
    return json({ data: tasks, summary: { total: 2, active: 1, running: 1, waiting: 0 }, cursor: {} })
  if (url.pathname.startsWith("/api/session/") && url.pathname.endsWith("/diagnostics"))
    return json({
      data: {
        model: session.model,
        context: { total: 0, percent: 0 },
        tokens: { uncachedInput: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cache: { eligible: 0, hitRatio: 1, mechanism: "anthropic-cache-control", readReported: true, writeReported: true },
        requests: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: session.tokens },
      },
    })
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
  if (
    [
      `/api/session/${sessionID}/pending`,
      `/api/session/${sessionID}/permission`,
      `/api/session/${sessionID}/todo`,
      `/api/session/${sessionID}/skills`,
      `/api/session/${sessionID}/form`,
      `/api/session/${sessionID}/guardrail/request`,
      "/api/shell",
      "/api/mcp",
      "/api/integration",
      "/api/command",
      "/api/skill",
      "/api/reference",
      "/api/permission/request",
      "/api/form/request",
    ].includes(url.pathname)
  )
    return json({ location, data: [] })
  if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
  if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
  if (url.pathname === "/api/provider") return json({ location, data: [{ id: "anthropic", name: "Claude" }] })
  if (url.pathname === "/api/agent")
    return json({
      location,
      data: [{ id: "build", name: "Build", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] }],
    })
  if (url.pathname === "/api/model")
    return json({
      location,
      data: ["claude-opus-5", "claude-haiku-4-5"].map((id) => ({
        id,
        modelID: id,
        providerID: "anthropic",
        name: id,
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        variants: [{ id: "high" }],
        time: { released: 0 },
        cost: [],
        status: "active",
        enabled: true,
        limit: { context: 200_000, output: 32_000 },
      })),
    })
  return undefined
}
