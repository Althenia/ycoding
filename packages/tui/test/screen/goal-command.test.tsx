/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { SessionAutonomyState } from "@ycoding-ai/client"
import { materializeClipboardImage } from "../../src/clipboard"
import { json, type FetchHandler } from "../fixture/tui-client"
import { renderScreen } from "./harness"

// Distinct Location and Session from every other screen suite so the shared module mocks
// installed by renderScreen cannot collide with a concurrent lane.
const sessionID = "ses_goal_command"
const landingSessionID = "ses_goal_command_landing"
const directory = "/tmp/ycoding/goal-command"
const location = { directory, project: { id: "proj_goal_command", directory } }
const session = {
  id: sessionID,
  title: "Goal command",
  projectID: "proj_goal_command",
  location: { directory },
  agent: "build",
  model: { providerID: "openai", id: "gpt-5.6-terra", variant: "high" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}

const goalState = (
  status: NonNullable<SessionAutonomyState["goal"]>["status"],
  text: string,
): SessionAutonomyState => ({
  mode: "normal",
  yolo: 0,
  goal: { text, status, iteration: 2, noProgress: 1, maxNoProgress: 3 },
})

let autonomyState: SessionAutonomyState = { mode: "normal", yolo: 0 }
let autonomySets: Array<Record<string, unknown>> = []
let promptRequests: Array<{ id: string; text: string; resume?: boolean }> = []
let failNextAutonomySet = false
let modelSwitchStarted = false
let landingCreates = 0

function resetFixture(state: SessionAutonomyState) {
  autonomyState = state
  autonomySets = []
  promptRequests = []
  failNextAutonomySet = false
  modelSwitchStarted = false
  landingCreates = 0
}

const route: FetchHandler = async (url, request) => {
  if (url.pathname === "/api/session" && request.method === "POST") {
    landingCreates++
    return json({ data: { ...session, id: landingSessionID } })
  }
  if (url.pathname === `/api/session/${landingSessionID}`) return json({ data: { ...session, id: landingSessionID } })
  if (url.pathname === `/api/session/${landingSessionID}/autonomy`) {
    if (request.method === "PUT") {
      const body: unknown = await request.json()
      if (body && typeof body === "object" && "goal" in body) autonomySets.push({ goal: body.goal })
    }
    return json({ data: autonomyState })
  }
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/autonomy`) {
    if (request.method === "PUT") {
      const body = (await request.json()) as Record<string, unknown>
      autonomySets.push(body)
      if (failNextAutonomySet) {
        failNextAutonomySet = false
        return json({ error: "simulated goal calculation failure" }, { status: 500 })
      }
      return json({ data: autonomyState })
    }
    return json({ data: autonomyState })
  }
  if (url.pathname === `/api/session/${sessionID}/model` && request.method === "POST") {
    modelSwitchStarted = true
    return new Response(null, { status: 204 })
  }
  if (url.pathname === `/api/session/${sessionID}/prompt` && request.method === "POST") {
    const body = (await request.json()) as { id: string; text: string; resume?: boolean }
    promptRequests.push(body)
    return json({
      data: {
        id: body.id,
        sessionID,
        admittedSeq: 1,
        timeCreated: Date.now(),
        type: "user",
        data: { text: body.text },
        delivery: "steer",
      },
    })
  }
  if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}/subagent`)
    return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
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
        model: session.model,
        context: { total: 0, percent: 0 },
        tokens: { uncachedInput: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cache: { eligible: 0, hitRatio: 0.61, mechanism: "unreported", readReported: false, writeReported: false },
        requests: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: session.tokens },
      },
    })
  if (url.pathname === `/api/session/${sessionID}/usage`)
    return json({
      data: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, cost: 0, tokens: session.tokens },
    })
  if (
    [
      `/api/session/${sessionID}/pending`,
      `/api/session/${sessionID}/permission`,
      `/api/session/${sessionID}/todo`,
      `/api/session/${sessionID}/skills`,
      `/api/session/${sessionID}/guardrail/request`,
      "/api/shell",
      "/api/mcp",
      "/api/integration",
      "/api/command",
      "/api/reference",
      "/api/permission/request",
      "/api/form/request",
    ].includes(url.pathname)
  )
    return json({ location, data: [] })
  if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
  if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
  if (url.pathname === "/api/model")
    return json({
      location,
      data: [
        {
          id: session.model.id,
          modelID: session.model.id,
          providerID: session.model.providerID,
          name: "GPT 5.6 Terra",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          variants: [{ id: session.model.variant }, { id: "low" }],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 200_000, output: 32_000 },
        },
      ],
    })
  if (url.pathname === "/api/provider") return json({ location, data: [{ id: "openai", name: "OpenAI" }] })
  if (url.pathname === "/api/skill") return json({ location, data: [] })
  if (url.pathname === "/api/agent")
    return json({
      location,
      data: [
        { id: "build", name: "Build", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] },
      ],
    })
  return undefined
}

async function waitFor(predicate: () => boolean, label: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for ${label}; sets=${JSON.stringify(autonomySets)} prompts=${JSON.stringify(promptRequests)}`)
}

async function focusComposer(screen: Awaited<ReturnType<typeof renderScreen>>) {
  const promptRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
  expect(promptRow).toBeGreaterThan(-1)
  await screen.mouse.click(3, promptRow)
}

/** Enter selects a visible slash option and submits otherwise; both are the real user action. */
async function submit(screen: Awaited<ReturnType<typeof renderScreen>>) {
  screen.input.pressEnter()
}

/**
 * A trailing space hides the slash menu, so Enter reaches the composer's own `/goal` branch.
 * Bare `/goal` without it stays in the menu and Enter selects the `session.autonomy.goal` palette
 * command. Both are real user paths and must agree.
 */
async function submitComposer(screen: Awaited<ReturnType<typeof renderScreen>>) {
  await screen.input.typeText(" ")
  screen.input.pressEnter()
}

test("replaces an active goal with the exact /goal text and never admits a prompt", async () => {
  resetFixture(goalState("active", "Old objective"))
  const screen = await renderScreen({ width: 100, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    await focusComposer(screen)
    await screen.input.typeText("/goal replace the migration plan")
    await submit(screen)
    await waitFor(() => autonomySets.length > 0, "goal replacement request")

    expect(autonomySets).toEqual([{ goal: "replace the migration plan" }])
    expect(promptRequests).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("creates a landing session and sets its goal with the returned session ID", async () => {
  resetFixture({ mode: "normal", yolo: 0 })
  const screen = await renderScreen({ width: 100, height: 69, route, settle: "Message YCoding…" })
  try {
    await focusComposer(screen)
    await screen.input.typeText("/goal Investigate $reviewer and /command references")
    await submitComposer(screen)
    await waitFor(() => autonomySets.length > 0 || screen.frame().includes("Failed to create a session with the goal"), "landing goal result")

    expect(landingCreates).toBe(1)
    expect(autonomySets).toEqual([{ goal: "Investigate $reviewer and /command references" }])
    expect(screen.frame()).not.toContain("Invalid session ID")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("expands a tracked long paste after /goal and keeps the surrounding text", async () => {
  resetFixture(goalState("active", "Old objective"))
  const pasted = Array.from({ length: 12 }, (_, index) => `paste-line-${index}-${"x".repeat(80)}`).join("\n")
  const screen = await renderScreen({ width: 100, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    await focusComposer(screen)
    await screen.input.typeText("/goal ")
    await screen.input.pasteBracketedText(pasted)
    await waitFor(() => screen.frame().includes("[Pasted ~12 lines]"), "virtualized paste marker")
    await screen.input.typeText(" trailing context")
    await submit(screen)
    await waitFor(() => autonomySets.length > 0, "goal replacement request")

    expect(autonomySets).toEqual([{ goal: `${pasted} trailing context` }])
    expect(promptRequests).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("keeps the draft and attachment and reports an error when goal calculation fails", async () => {
  resetFixture(goalState("active", "Old objective"))
  failNextAutonomySet = true
  const attachment = await materializeClipboardImage(await mkdtemp(path.join(tmpdir(), "ycoding-goal-command-")), async (file) => {
    await Bun.write(file, "png")
  })
  const screen = await renderScreen({
    width: 100,
    height: 69,
    args: { sessionID },
    route,
    clipboard: { read: async () => attachment },
    settle: "Message YCoding…",
  })
  try {
    await focusComposer(screen)
    await screen.input.typeText("/goal replace the migration plan")
    await screen.input.pressKey("v", { ctrl: true })
    await waitFor(() => screen.frame().includes("[Image 1]"), "pasted attachment")
    await submit(screen)
    await waitFor(() => screen.frame().includes("✗ Error"), "goal failure toast")

    expect(screen.frame()).toContain("replace the migration plan")
    expect(screen.frame()).toContain("[Image 1]")
    expect(promptRequests).toEqual([])
  } finally {
    await screen.dispose()
    await attachment.temporary.cleanup()
  }
}, 30_000)

test("keeps a model selection pending while an explicit /goal changes autonomy", async () => {
  resetFixture(goalState("active", "Old objective"))
  const screen = await renderScreen({ width: 100, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    await focusComposer(screen)
    await screen.input.typeText("/variants")
    await submit(screen)
    await waitFor(() => screen.frame().includes("Select variant"), "the variant dialog")
    screen.input.pressKey("ARROW_DOWN")
    screen.input.pressEnter()
    await waitFor(() => screen.frame().includes("Message YCoding…"), "the composer after selection")
    expect(modelSwitchStarted).toBe(false)

    await screen.input.typeText("/goal replace the migration plan")
    await submit(screen)
    await waitFor(() => autonomySets.length > 0, "the goal replacement")
    expect(autonomySets).toEqual([{ goal: "replace the migration plan" }])
    expect(modelSwitchStarted).toBe(false)
    expect(promptRequests).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("stops an active goal on a bare /goal without admitting a prompt", async () => {
  resetFixture(goalState("active", "Old objective"))
  const screen = await renderScreen({ width: 100, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    await focusComposer(screen)
    await screen.input.typeText("/goal")
    await submitComposer(screen)
    await waitFor(() => autonomySets.length > 0, "goal stop request")

    expect(autonomySets).toEqual([{ goal: null }])
    expect(promptRequests).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("resumes a retained goal on a bare /goal without synthesis or prompt admission", async () => {
  resetFixture(goalState("completed", "Retained objective"))
  const screen = await renderScreen({ width: 100, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    await focusComposer(screen)
    await screen.input.typeText("/goal")
    await submitComposer(screen)
    await waitFor(() => autonomySets.length > 0, "goal resume request")

    expect(autonomySets).toEqual([{ goal: true }])
    expect(promptRequests).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("agrees with the composer branch when the slash menu selects the goal command", async () => {
  resetFixture(goalState("active", "Old objective"))
  const screen = await renderScreen({ width: 100, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    await focusComposer(screen)
    await screen.input.typeText("/goal")
    await waitFor(() => screen.frame().includes("Enter accept"), "slash menu")
    // Enter with the menu visible selects `session.autonomy.goal`; it must reach the same
    // applyGoalCommand semantics as the composer branch instead of inventing an objective.
    submit(screen)
    await waitFor(() => autonomySets.length > 0, "goal command from the slash menu")

    expect(autonomySets).toEqual([{ goal: null }])
    expect(promptRequests).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("opens the explicit objective dialog when a bare /goal has no retained goal", async () => {
  resetFixture({ mode: "normal", yolo: 0 })
  const screen = await renderScreen({ width: 100, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    await focusComposer(screen)
    await screen.input.typeText("/goal")
    await submitComposer(screen)
    for (let attempt = 0; attempt < 100; attempt++) {
      if (autonomySets.length > 0 || screen.frame().includes("Set autonomous goal")) break
      await Bun.sleep(20)
    }

    expect(autonomySets).toEqual([])
    expect(promptRequests).toEqual([])
    expect(screen.frame()).toContain("Set autonomous goal")
  } finally {
    await screen.dispose()
  }
}, 30_000)
