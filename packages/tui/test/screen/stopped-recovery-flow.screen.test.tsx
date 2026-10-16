/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { SessionInfo, SessionOrchestrationTask, YCodingEvent } from "@ycoding-ai/client"
import { json, sessionSnapshot } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const parentID = "ses_flow_parent"
const childID = "ses_flow_child"
const otherID = "ses_flow_other"
const location = { directory: "/tmp/ycoding/restart-flow", project: { id: "proj_flow", directory: "/tmp/ycoding/restart-flow" } }
const model = { providerID: "openai", id: "gpt-6.1-sol" }

function session(id: string): SessionInfo {
  return {
    id,
    ...(id === childID ? { parentID } : {}),
    title: id === otherID ? "Unrelated family" : "Recovery flow",
    projectID: location.project.id,
    location,
    agent: "general",
    model,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 3 },
  } as SessionInfo
}

function fixture(itemID: string) {
  const stopped = {
    sessionID: childID,
    parentID,
    description: "Wire storage",
    agent: "general",
    model,
    background: true,
    state: "cancelled",
    stoppedRecovery: { itemID },
    revision: 4,
    time: { created: 1, updated: 4 },
  } as unknown as SessionOrchestrationTask
  const state = {
    task: stopped,
    decisions: [] as Array<{ pathname: string; body: unknown }>,
    posts: [] as string[],
    requests: [] as string[],
    decide: undefined as undefined | (() => Promise<Response>),
    refreshed() {
      return { ...stopped, state: "running", revision: 5, time: { created: 1, updated: 5 }, stoppedRecovery: undefined } as unknown as SessionOrchestrationTask
    },
    count(request: string) {
      return state.requests.filter((value) => value === request).length
    },
    async route(this: void, url: URL, request: Request) {
      state.requests.push(`${request.method} ${url.pathname}`)
      if (request.method !== "GET") state.posts.push(`${request.method} ${url.pathname}`)
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session(parentID), session(childID), session(otherID)], cursor: {} })
      if ([parentID, childID, otherID].some((id) => url.pathname === `/api/session/${id}`))
        return json({ data: session(url.pathname.split("/").at(-1)!) })
      if ([parentID, childID, otherID].some((id) => url.pathname === `/api/session/${id}/snapshot`))
        return sessionSnapshot(url.pathname.split("/")[3]!, [{ id: "msg_user", type: "user", text: "Work", time: { created: 1 } }], {
          session: session(url.pathname.split("/")[3]!),
        })
      if (url.pathname === `/api/session/${parentID}/subagent`) {
        const active = state.task.state === "running" ? 1 : 0
        return json({ data: [state.task], summary: { total: 1, active, running: active, waiting: 0 }, cursor: {} })
      }
      const decide = new RegExp(`^/api/session/${childID}/review/${itemID}/decide$`).test(url.pathname)
      if (decide && request.method === "POST") {
        state.decisions.push({ pathname: url.pathname, body: await request.json() })
        if (state.decide) return state.decide()
        return new Response(null, { status: 204 })
      }
      if (url.pathname.endsWith("/subagent"))
        return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
      if (/\/(pending|todo|skills|permission)$/.test(url.pathname)) return json({ data: [] })
      if (url.pathname === "/api/model")
        return json({
          location,
          data: [
            {
              ...model,
              modelID: model.id,
              name: "GPT Sol",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              time: { released: 0 },
              cost: [],
              variants: [],
              status: "active",
              enabled: true,
              limit: { context: 200000, output: 32000 },
            },
          ],
        })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "openai", name: "OpenAI" }] })
      if (url.pathname === "/api/agent")
        return json({
          location,
          data: [{ id: "general", name: "General", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] }],
        })
      return undefined
    },
  }
  return state
}

async function open(state: ReturnType<typeof fixture>) {
  const screen = await renderScreen({
    width: 140,
    height: 50,
    args: { sessionID: parentID },
    config: { keybinds: { session_child_first: "ctrl+t" } },
    route: state.route,
    settle: "Message YCoding…",
  })
  await screen.waitForEventStream()
  screen.input.pressKey("t", { ctrl: true })
  await until(screen, (frame) => frame.includes("INACTIVE") && frame.includes("stopped"))
  return screen
}

async function until(screen: Awaited<ReturnType<typeof renderScreen>>, check: (frame: string) => boolean, label = "frame") {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (check(screen.frame())) return
    await screen.renderOnce()
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${label}\n${screen.frame()}`)
}

function taskUpdated(change: { type: "resumed" }, seq: number): YCodingEvent {
  return {
    id: `evt_flow_task_${seq}`,
    created: 10 + seq,
    durable: { aggregateID: childID, seq, version: 1 },
    type: "session.task.updated",
    data: { sessionID: childID, change },
  } as unknown as YCodingEvent
}

const resumedNotice = {
  id: "evt_flow_resumed",
  created: 20,
  durable: { aggregateID: parentID, seq: 20, version: 1 },
  type: "session.synthetic",
  data: {
    sessionID: parentID,
    text: "Child resumed after restart.",
    description: "Child resumed after restart.",
    metadata: { source: "subagent_notification", childID, type: "resumed", revision: 5 },
  },
} as unknown as YCodingEvent

test("Continue on a hydrated stopped task clears the marker on the resumed update and leaves one resumed row", async () => {
  const state = fixture("rvw_flow_continue")
  const screen = await open(state)
  try {
    expect(screen.frame()).toContain("Stopped after restart")
    expect(screen.frame()).not.toContain("cancelled")
    screen.input.pressKey("c", { shift: true })
    await until(screen, () => state.decisions.length === 1, "continue decision")
    expect(state.decisions).toEqual([
      { pathname: `/api/session/${childID}/review/rvw_flow_continue/decide`, body: { decision: { kind: "recovery", choice: "continue" } } },
    ])

    state.task = state.refreshed()
    screen.events.emit(taskUpdated({ type: "resumed" }, 1))
    screen.events.emit(resumedNotice)
    screen.events.emit(resumedNotice)
    await until(screen, (frame) => !frame.includes("stopped") && frame.includes("1/1 running"), "marker cleared")
    expect(screen.frame()).not.toContain("stopped")
    expect(screen.frame()).not.toContain("⇧c continue")
    expect(screen.lines().filter((line) => line.includes("subagent") && line.includes("resumed"))).toHaveLength(1)

    screen.input.pressKey("c", { shift: true })
    await screen.renderOnce()
    expect(state.decisions).toHaveLength(1)
    expect(state.posts).toEqual([`POST /api/session/${childID}/review/rvw_flow_continue/decide`])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("a late successful reply after the tab closes refreshes only the original family and never sends again", async () => {
  const state = fixture("rvw_flow_late")
  const gate = Promise.withResolvers<Response>()
  state.decide = () => gate.promise
  const screen = await open(state)
  try {
    screen.input.pressKey("c", { shift: true })
    await until(screen, () => state.decisions.length === 1, "pending decision")
    await until(screen, (frame) => frame.includes("Continuing…"), "sending note")
    screen.input.pressKey("c", { shift: true })
    screen.input.pressKey("ESCAPE")
    await until(screen, (frame) => !frame.includes("INACTIVE"), "closed tab")
    const parentReads = state.count(`GET /api/session/${parentID}/subagent`)
    const childReads = state.count(`GET /api/session/${childID}/subagent`)
    state.task = state.refreshed()
    gate.resolve(new Response(null, { status: 204 }))
    await until(screen, () => state.count(`GET /api/session/${parentID}/subagent`) > parentReads, "parent family refresh")
    expect(state.count(`GET /api/session/${childID}/subagent`)).toBe(childReads)
    expect(state.decisions).toHaveLength(1)
    expect(state.posts).toEqual([`POST /api/session/${childID}/review/rvw_flow_late/decide`])

    screen.input.pressKey("t", { ctrl: true })
    await until(screen, (frame) => frame.includes("ACTIVE") && !frame.includes("stopped"), "refreshed task")
    expect(screen.frame()).not.toContain("Stopped after restart")
    screen.input.pressKey("c", { shift: true })
    await screen.renderOnce()
    expect(state.decisions).toHaveLength(1)
  } finally {
    gate.resolve(new Response(null, { status: 204 }))
    await screen.dispose()
  }
}, 30_000)

test("a late failed reply after the tab closes keeps the marker, refreshes nothing, and never replays", async () => {
  const state = fixture("rvw_flow_failed")
  const gate = Promise.withResolvers<Response>()
  state.decide = () => gate.promise
  const screen = await open(state)
  try {
    screen.input.pressKey("c", { shift: true })
    await until(screen, () => state.decisions.length === 1, "pending decision")
    screen.input.pressKey("ESCAPE")
    await until(screen, (frame) => !frame.includes("INACTIVE"), "closed tab")
    const reads = state.requests.filter((request) => request.startsWith("GET")).length
    gate.resolve(json({ message: "Decision outcome unknown" }, { status: 503 }))
    await Bun.sleep(100)
    await screen.renderOnce()
    expect(state.requests.filter((request) => request.startsWith("GET")).length).toBe(reads)

    screen.input.pressKey("t", { ctrl: true })
    await until(screen, (frame) => frame.includes("Continue unresolved") && frame.includes("stopped"), "unresolved note")
    screen.input.pressKey("c", { shift: true })
    screen.input.pressKey("c", { shift: true })
    await screen.renderOnce()
    expect(state.decisions).toHaveLength(1)
    expect(state.posts).toEqual([`POST /api/session/${childID}/review/rvw_flow_failed/decide`])
  } finally {
    gate.resolve(new Response(null, { status: 503 }))
    await screen.dispose()
  }
}, 30_000)

test("switching away and back while a decision is pending keeps the guard and never sends a second decision", async () => {
  const state = fixture("rvw_flow_switch")
  const gate = Promise.withResolvers<Response>()
  state.decide = () => gate.promise
  const screen = await open(state)
  const switchTo = async (title: string) => {
    screen.input.pressKey("x", { ctrl: true })
    screen.input.pressKey("l")
    await until(screen, (frame) => frame.includes("Switch session") && frame.includes(title), "session list")
    await screen.input.typeText(title)
    await screen.renderOnce()
    screen.input.pressEnter()
    await until(screen, (frame) => !frame.includes("Switch session") && frame.includes(`SESSION`) && frame.includes(title), `${title} opened`)
  }
  try {
    screen.input.pressKey("c", { shift: true })
    await until(screen, () => state.decisions.length === 1, "pending decision")
    screen.input.pressKey("ESCAPE")
    await until(screen, (frame) => !frame.includes("INACTIVE"), "closed tab")
    await switchTo("Unrelated family")
    await switchTo("Recovery flow")
    screen.input.pressKey("t", { ctrl: true })
    await until(screen, (frame) => frame.includes("INACTIVE") && frame.includes("Continuing…"), "guard survives remount")
    screen.input.pressKey("c", { shift: true })
    await screen.renderOnce()
    expect(state.decisions).toHaveLength(1)

    const otherReads = state.count(`GET /api/session/${otherID}/subagent`)
    state.task = state.refreshed()
    gate.resolve(new Response(null, { status: 204 }))
    await until(screen, (frame) => !frame.includes("stopped") && frame.includes("ACTIVE"), "refreshed original family")
    expect(state.count(`GET /api/session/${otherID}/subagent`)).toBe(otherReads)
    expect(state.posts).toEqual([`POST /api/session/${childID}/review/rvw_flow_switch/decide`])
  } finally {
    gate.resolve(new Response(null, { status: 204 }))
    await screen.dispose()
  }
}, 30_000)
