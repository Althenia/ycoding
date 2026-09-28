/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { SessionAutonomyState, YCodingEvent } from "@ycoding-ai/client"
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
let autonomyAfterSet: SessionAutonomyState | undefined
let releaseAutonomySet: (() => void) | undefined
let autonomySets: Array<Record<string, unknown>> = []
let promptRequests: Array<{ id: string; text: string; resume?: boolean }> = []
let failNextAutonomySet = false
let modelSwitchStarted = false
let failNextModelSwitch = false
let switchRequests: unknown[] = []
let requestOrder: string[] = []
let landingCreates = 0

function resetFixture(state: SessionAutonomyState) {
  autonomyState = state
  autonomyAfterSet = undefined
  releaseAutonomySet = undefined
  autonomySets = []
  promptRequests = []
  failNextAutonomySet = false
  modelSwitchStarted = false
  failNextModelSwitch = false
  switchRequests = []
  requestOrder = []
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
      requestOrder.push("goal")
      autonomySets.push(body)
      if (releaseAutonomySet) await new Promise<void>((resolve) => { releaseAutonomySet = resolve })
      if (failNextAutonomySet) {
        failNextAutonomySet = false
        return json({ error: "simulated goal calculation failure" }, { status: 500 })
      }
      autonomyState = autonomyAfterSet ?? autonomyState
      return json({ data: autonomyState })
    }
    return json({ data: autonomyState })
  }
  if (url.pathname === `/api/session/${sessionID}/model` && request.method === "POST") {
    modelSwitchStarted = true
    requestOrder.push("model")
    const body: unknown = await request.json()
    if (!body || typeof body !== "object" || !("model" in body)) throw new Error("missing model")
    switchRequests.push(body.model)
    if (failNextModelSwitch) {
      failNextModelSwitch = false
      return json({ error: "simulated model switch failure" }, { status: 500 })
    }
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

test("clears the composer after an explicit /goal starts goal mode from normal", async () => {
  resetFixture({ mode: "normal", yolo: 0 })
  autonomyAfterSet = { mode: "normal", yolo: 0, goal: { text: "finish product.", status: "active", iteration: 0, noProgress: 0, maxNoProgress: 3 } }
  const screen = await renderScreen({ width: 100, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    await focusComposer(screen)
    await screen.input.typeText("/goal finish product.")
    await submit(screen)
    await waitFor(() => autonomySets.length > 0, "goal activation request")
    await waitFor(() => !screen.lines().some((line) => line.includes("/goal finish product.")), "cleared composer")

    expect(autonomySets).toEqual([{ goal: "finish product." }])
    expect(promptRequests).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

for (const { name, running, direct } of [
  { name: "idle with slash menu open", running: false, direct: false },
  { name: "idle with direct Enter", running: false, direct: true },
  { name: "running with slash menu open", running: true, direct: false },
  { name: "running with direct Enter", running: true, direct: true },
]) test(`clears a goal draft after ${name} and steer events before the autonomy response`, async () => {
  resetFixture({ mode: "normal", yolo: 0 })
  autonomyAfterSet = { mode: "normal", yolo: 0, goal: { text: "finish product.", status: "active", iteration: 0, noProgress: 0, maxNoProgress: 3 } }
  releaseAutonomySet = () => {}
  const screen = await renderScreen({ width: 100, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    await screen.waitForEventStream()
    if (running) screen.events.emit({
      id: "evt_goal_already_running", created: 9, type: "session.execution.started",
      durable: { aggregateID: sessionID, seq: 1, version: 1 }, location: { directory }, data: { sessionID },
    } satisfies YCodingEvent)
    await focusComposer(screen)
    await screen.input.typeText("/goal finish product.")
    if (direct) await submitComposer(screen)
    else await submit(screen)
    await waitFor(() => autonomySets.length > 0, "goal activation request")
    for (const id of ["synthesis", "steer"]) screen.events.emit({
      id: `evt_goal_usage_${id}`, created: 10, type: "session.usage.updated", location: { directory },
      data: { sessionID, cost: 0, tokens: session.tokens },
    } satisfies YCodingEvent)
    screen.events.emit({
      id: "evt_goal_admitted", created: 10, type: "session.input.admitted",
      durable: { aggregateID: sessionID, seq: running ? 2 : 1, version: 1 }, location: { directory },
      data: { sessionID, inputID: "msg_goal_123", input: { type: "synthetic", data: { text: "Goal steer", description: "Goal · steer", metadata: { autonomy: { yolo: 0, goal: true, iteration: 0 } } }, delivery: "steer" } },
    } satisfies YCodingEvent)
    await waitFor(() => screen.frame().includes("Goal · steer"), "projected goal steer")
    if (!running) screen.events.emit({
      id: "evt_goal_execution", created: 11, type: "session.execution.started",
      durable: { aggregateID: sessionID, seq: 2, version: 1 }, location: { directory }, data: { sessionID },
    } satisfies YCodingEvent)
    screen.events.emit({
      id: "evt_goal_promoted", created: 12, type: "session.input.promoted",
      durable: { aggregateID: sessionID, seq: 3, version: 1 }, location: { directory }, data: { sessionID, inputID: "msg_goal_123" },
    } satisfies YCodingEvent)
    if (running && direct) {
      screen.events.emit({
        id: "evt_goal_permission", created: 13, type: "permission.v2.asked",
        data: { id: "per_goal_running", sessionID, action: "shell", resources: [directory] }, location: { directory },
      } satisfies YCodingEvent)
      await waitFor(() => screen.frame().includes("Permission required"), "running Session permission")
      screen.events.emit({
        id: "evt_goal_permission_reply", created: 14, type: "permission.v2.replied",
        data: { sessionID, requestID: "per_goal_running", reply: "once" }, location: { directory },
      } satisfies YCodingEvent)
      await waitFor(() => screen.frame().includes("/goal finish product."), "restored draft after permission")
    }
    releaseAutonomySet?.()
    await waitFor(() => screen.frame().includes("Goal activated"), "goal success toast")
    expect(screen.frame()).not.toContain("/goal finish product.")
    expect(promptRequests).toEqual([])
    if (running && direct) {
      screen.events.emit({
        id: "evt_goal_permission_again", created: 15, type: "permission.v2.asked",
        data: { id: "per_goal_again", sessionID, action: "shell", resources: [directory] }, location: { directory },
      } satisfies YCodingEvent)
      await waitFor(() => screen.frame().includes("Permission required"), "second permission")
      screen.events.emit({
        id: "evt_goal_permission_again_reply", created: 16, type: "permission.v2.replied",
        data: { sessionID, requestID: "per_goal_again", reply: "once" }, location: { directory },
      } satisfies YCodingEvent)
      await waitFor(() => screen.frame().includes("Message YCoding…"), "empty composer after second remount")
      expect(screen.frame()).not.toContain("/goal finish product.")
    }
  } finally {
    releaseAutonomySet?.()
    await screen.dispose()
  }
}, 30_000)

test("retains the goal draft after a failed PUT across a permission remount", async () => {
  resetFixture({ mode: "normal", yolo: 0 })
  releaseAutonomySet = () => {}
  failNextAutonomySet = true
  const screen = await renderScreen({ width: 100, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    await screen.waitForEventStream()
    await focusComposer(screen)
    await screen.input.typeText("/goal finish product.")
    await submitComposer(screen)
    await waitFor(() => autonomySets.length > 0, "goal activation request")
    screen.events.emit({
      id: "evt_failed_goal_permission", created: 17, type: "permission.v2.asked",
      data: { id: "per_failed_goal", sessionID, action: "shell", resources: [directory] }, location: { directory },
    } satisfies YCodingEvent)
    await waitFor(() => screen.frame().includes("Permission required"), "permission prompt")
    screen.events.emit({
      id: "evt_failed_goal_permission_reply", created: 18, type: "permission.v2.replied",
      data: { sessionID, requestID: "per_failed_goal", reply: "once" }, location: { directory },
    } satisfies YCodingEvent)
    await waitFor(() => screen.frame().includes("/goal finish product."), "restored goal draft")
    releaseAutonomySet?.()
    await waitFor(() => screen.frame().includes("Failed to set goal"), "goal error toast")
    expect(screen.frame()).toContain("/goal finish product.")
    expect(promptRequests).toEqual([])
  } finally {
    releaseAutonomySet?.()
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

test("switches the selected variant before an explicit /goal activates its steer", async () => {
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
    expect(requestOrder).toEqual(["model", "goal"])
    expect(switchRequests).toEqual([{ providerID: "openai", id: "gpt-5.6-terra", variant: "low" }])
    expect(autonomySets).toEqual([{ goal: "replace the migration plan" }])
    expect(promptRequests).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("a rejected selected variant keeps /goal editable and does not activate a steer", async () => {
  resetFixture(goalState("active", "Old objective"))
  failNextModelSwitch = true
  const screen = await renderScreen({ width: 100, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    await focusComposer(screen)
    await screen.input.typeText("/variants")
    await submit(screen)
    await waitFor(() => screen.frame().includes("Select variant"), "the variant dialog")
    screen.input.pressKey("ARROW_DOWN")
    screen.input.pressEnter()
    await waitFor(() => screen.frame().includes("Message YCoding…"), "the composer after selection")

    await screen.input.typeText("/goal replace the migration plan")
    await submit(screen)
    await waitFor(() => screen.frame().includes("Model switch needs attention"), "model rejection")
    expect(switchRequests).toEqual([{ providerID: "openai", id: "gpt-5.6-terra", variant: "low" }])
    expect(requestOrder).toEqual(["model"])
    expect(autonomySets).toEqual([])
    expect(promptRequests).toEqual([])
    expect(screen.frame()).toContain("replace the migration plan")

    await submit(screen)
    await waitFor(() => autonomySets.length > 0, "the retried goal replacement")
    expect(requestOrder).toEqual(["model", "model", "goal"])
    expect(switchRequests).toHaveLength(2)
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
