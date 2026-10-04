import { expect, test } from "bun:test"
import { InputRenderable, ScrollBoxRenderable, TextBufferRenderable, type Renderable } from "@opentui/core"
import type { SessionMessageInfo } from "@ycoding-ai/client"
import { DEFAULT_THEMES } from "../src/theme/builtins"
import { resolveThemeFile } from "../src/theme/v2/resolve"
import { json } from "./fixture/tui-client"
import { renderScreen } from "./screen/harness"

const sessionID = "ses_skill_render"
const directory = "/tmp/ycoding/skill-render"
const location = { directory, project: { id: "proj_skill_render", directory } }
const model = { providerID: "openai", id: "fixture" }
const session = {
  id: sessionID,
  title: "Skill rendering",
  projectID: location.project.id,
  location: { directory },
  agent: "build",
  model,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}
const content = Array.from({ length: 60 }, (_, index) => `detail-line-${index.toString().padStart(2, "0")}`).join("\n")
const skills = [
  {
    id: "review",
    name: "User review",
    activatedBy: "reference",
    activationMessageID: "msg_user_skill",
    content,
    conflicts: [],
    declarations: {},
    state: "active",
  },
]
const messages: SessionMessageInfo[] = [
  {
    id: "msg_user_skill",
    type: "skill",
    skill: "review",
    name: "User review",
    text: "hidden user skill instructions",
    time: { created: 1 },
  },
  {
    id: "msg_agent_skill",
    type: "assistant",
    agent: "build",
    model,
    content: [
      {
        type: "tool",
        id: "call_skill",
        name: "skill",
        state: {
          status: "completed",
          input: { id: "agent-review" },
          structured: { name: "Agent review" },
          content: [{ type: "text", text: content }],
        },
        time: { created: 2, ran: 2, completed: 3 },
      },
      {
        type: "tool",
        id: "call_duplicate_skill",
        name: "skill",
        state: {
          status: "completed",
          input: { id: "duplicate-review" },
          structured: { name: "Duplicate review", alreadyActive: true },
          content: [],
        },
        time: { created: 3, ran: 3, completed: 4 },
      },
    ],
    time: { created: 2, completed: 4 },
  },
]

async function route(url: URL) {
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: messages, cursor: {} })
  if (url.pathname === `/api/session/${sessionID}/skills`) return json({ data: skills })
  if (url.pathname === `/api/session/${sessionID}/subagent`)
    return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
  if (["pending", "permission", "todo"].some((resource) => url.pathname === `/api/session/${sessionID}/${resource}`))
    return json({ data: [] })
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
  if (url.pathname === "/api/agent")
    return json({
      location,
      data: [
        {
          id: "build",
          name: "Build",
          request: { headers: {}, body: {} },
          mode: "primary",
          hidden: false,
          permissions: [],
        },
      ],
    })
  if (url.pathname === "/api/model")
    return json({
      location,
      data: [
        {
          ...model,
          modelID: model.id,
          name: "Fixture",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 200000, output: 32000 },
        },
      ],
    })
  return undefined
}

async function until(screen: Awaited<ReturnType<typeof renderScreen>>, text: string, visible = true) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && screen.frame().includes(text) !== visible) {
    await screen.renderOnce()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  await screen.renderOnce()
  expect(screen.frame().includes(text)).toBe(visible)
}

function scrollboxes(node: Renderable): ScrollBoxRenderable[] {
  return [...(node instanceof ScrollBoxRenderable ? [node] : []), ...node.getChildren().flatMap(scrollboxes)]
}

function skillContent(node: Renderable): Renderable | undefined {
  if (node instanceof TextBufferRenderable && node.plainText === "+ Skill content") return node.parent ?? undefined
  return node.getChildren().map(skillContent).find(Boolean)
}

async function waitForEditor(screen: Awaited<ReturnType<typeof renderScreen>>, previous?: Renderable | null) {
  const deadline = Date.now() + 5000
  while (
    Date.now() < deadline &&
    (!(screen.renderer.currentFocusedEditor instanceof InputRenderable) ||
      screen.renderer.currentFocusedEditor === previous)
  )
    await new Promise<void>((resolve) => setImmediate(resolve))
  expect(screen.renderer.currentFocusedEditor).toBeInstanceOf(InputRenderable)
  expect(screen.renderer.currentFocusedEditor).not.toBe(previous)
  return screen.renderer.currentFocusedEditor
}

test("renders user and agent-invoked completed Skill titles with the same treatment", async () => {
  const screen = await renderScreen({
    width: 100,
    height: 40,
    args: { sessionID },
    route,
    config: { animations: false },
    settle: 'Skill "Agent review"',
  })
  const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")
  try {
    expect(screen.frame()).toContain('Skill "User review"')
    expect(screen.frame()).not.toContain("Duplicate review")
    expect(screen.frame()).not.toContain("hidden user skill instructions")
    expect(screen.frame()).not.toContain("detail-line-00")
    expect(screen.frame().match(/Loaded/g)).toHaveLength(2)
    expect(screen.colorOf('Skill "User review"')).toEqual(theme.text.default.toInts())
    expect(screen.colorOf('Skill "Agent review"')).toEqual(theme.text.default.toInts())
    const badges = screen
      .spans()
      .lines.flatMap((line) => line.spans)
      .filter((span) => span.text.includes("Loaded"))
    expect(badges).toHaveLength(2)
    expect(badges.every((badge) => badge.fg.toInts().join(",") === theme.hue.accent[200].toInts().join(","))).toBe(true)
  } finally {
    await screen.dispose()
  }
}, 30000)

test("skill details keyboard expansion keeps long content bounded and pageable", async () => {
  const screen = await renderScreen({
    width: 100,
    height: 40,
    args: { sessionID },
    route,
    config: { animations: false },
    settle: "Message YCoding…",
  })
  try {
    screen.input.pressKey("p", { ctrl: true })
    await until(screen, "Commands")
    const filter = await waitForEditor(screen)
    await screen.input.typeText("skills")
    expect(filter instanceof InputRenderable ? filter.value : undefined).toBe("skills")
    await until(screen, "Session skills")
    expect(screen.lines().filter((line) => line.includes("Session skills"))).toHaveLength(1)
    screen.input.pressKey("ARROW_DOWN")
    screen.input.pressEnter()
    await until(screen, "✓  User review")
    await waitForEditor(screen, filter)
    screen.input.pressEnter()
    await until(screen, "Session skill: User review")
    expect(screen.frame()).not.toContain("detail-line-00")
    screen.input.pressEnter()
    await until(screen, "detail-line-00")
    expect(screen.frame()).not.toContain("detail-line-59")
    const scroll = scrollboxes(screen.renderer.root).find((box) => box.scrollHeight > 50)
    expect(scroll).toBeDefined()
    expect(scroll?.height).toBeLessThanOrEqual(15)
    screen.input.pressKey("END")
    await until(screen, "detail-line-59")
    expect(screen.frame()).not.toContain("detail-line-00")
    screen.input.pressKey(" ")
    await until(screen, "detail-line-59", false)
    expect(screen.frame()).not.toContain("detail-line-59")
  } finally {
    await screen.dispose()
  }
}, 30000)

test("agent skill content expands from its focusable row into a bounded pageable transcript region", async () => {
  const screen = await renderScreen({
    width: 100,
    height: 40,
    args: { sessionID },
    route,
    config: { animations: false },
    settle: "Message YCoding…",
  })
  try {
    const row = skillContent(screen.renderer.root)
    expect(row?.focusable).toBe(true)
    row?.focus()
    screen.input.pressEnter()
    await until(screen, "detail-line-00")
    expect(row?.focused).toBe(true)
    expect(screen.frame()).not.toContain("detail-line-59")
    const scroll = scrollboxes(screen.renderer.root).find((box) => box.scrollHeight > 50)
    expect(scroll).toBeDefined()
    expect(scroll?.height).toBeLessThanOrEqual(13)
    screen.input.pressKey("END")
    await until(screen, "detail-line-59")
    expect(screen.frame()).not.toContain("detail-line-00")
    screen.input.pressEnter()
    await until(screen, "detail-line-59", false)
  } finally {
    await screen.dispose()
  }
}, 30000)
