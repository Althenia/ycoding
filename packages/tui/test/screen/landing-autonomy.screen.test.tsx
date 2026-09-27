/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { SessionAutonomyState } from "@ycoding-ai/client"
import { json, type FetchHandler } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const directory = "/tmp/ycoding/landing-autonomy"
const location = { directory, project: { id: "proj_landing_autonomy", directory } }
const model = { providerID: "openai", id: "gpt-5.6-terra" }
const agent = { id: "build", name: "Build", mode: "primary", hidden: false, permissions: [], request: { headers: {}, body: {} } }
const modelInfo = {
  ...model, modelID: "openai/gpt-5.6-terra", name: "GPT 5.6 Terra",
  capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [],
  time: { released: 0 }, cost: [], status: "active", enabled: true,
  limit: { context: 200_000, output: 32_000 },
}

function fixture() {
  let sessionID: string | undefined
  let autonomy: SessionAutonomyState = { mode: "normal", yolo: 0 }
  let failAutonomy = false
  let failGoal = false
  const mutations: string[] = []
  const admissionStates: SessionAutonomyState[] = []
  const info = () => ({
    id: sessionID, projectID: location.project.id, title: "Landing autonomy", location: { directory },
    agent: "build", model, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
  })
  const route: FetchHandler = async (url, request) => {
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/fs/list") return json({ location, data: [] })
    if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
    if (url.pathname === "/api/agent") return json({ location, data: [agent] })
    if (url.pathname === "/api/model") return json({ location, data: [modelInfo] })
    if (url.pathname === "/api/provider") return json({ location, data: [] })
    if (["/api/integration", "/api/command", "/api/skill", "/api/reference", "/api/permission/request", "/api/form/request"].includes(url.pathname))
      return json({ location, data: [] })
    if (url.pathname === "/api/session/active") return json({ data: {} })
    if (url.pathname === "/api/session" && request.method === "POST") {
      const body: unknown = await request.json()
      const id = typeof body === "object" && body !== null ? Reflect.get(body, "id") : undefined
      sessionID = typeof id === "string" ? id : "ses_landing_goal_new"
      autonomy = { mode: "normal", yolo: 0 }
      mutations.push("create")
      return json({ data: info() })
    }
    if (url.pathname === "/api/session") return json({ data: sessionID ? [info()] : [], cursor: {} })
    if (!sessionID) return undefined
    if (url.pathname === `/api/session/${sessionID}`) return json({ data: info() })
    if (url.pathname === `/api/session/${sessionID}/autonomy`) {
      if (request.method === "PUT") {
        const payload: unknown = await request.json()
        if (typeof payload !== "object" || payload === null) throw new Error("Invalid autonomy payload")
        const yolo = Reflect.get(payload, "yolo")
        const goal = Reflect.get(payload, "goal")
        mutations.push("autonomy")
        if (failAutonomy) {
          failAutonomy = false
          return new Response("autonomy rejected", { status: 500 })
        }
        if (failGoal && typeof goal === "string") {
          failGoal = false
          return new Response("goal rejected", { status: 500 })
        }
        autonomy = {
          mode: "normal", yolo: yolo === 0 || yolo === 1 || yolo === 2 || yolo === 3 ? yolo : autonomy.yolo,
          ...(typeof goal === "string" ? { goal: { text: goal, status: "active" as const, iteration: 0, noProgress: 0, maxNoProgress: 3 } } : autonomy.goal ? { goal: autonomy.goal } : {}),
        }
      }
      return json({ data: autonomy })
    }
    if (url.pathname === `/api/session/${sessionID}/prompt` && request.method === "POST") {
      const body: unknown = await request.json()
      if (typeof body !== "object" || body === null) throw new Error("Invalid prompt payload")
      const id = Reflect.get(body, "id")
      const text = Reflect.get(body, "text")
      const resume = Reflect.get(body, "resume")
      if (typeof id !== "string" || typeof text !== "string") throw new Error("Invalid prompt identity")
      mutations.push(resume === false ? "admit" : "wake")
      if (resume === false) admissionStates.push(structuredClone(autonomy))
      return json({ data: {
        id, sessionID, admittedSeq: 1, timeCreated: Date.now(), type: "user",
        data: { text }, delivery: "steer",
      } })
    }
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
    if (url.pathname === `/api/session/${sessionID}/subagent`)
      return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
    if (url.pathname === `/api/session/${sessionID}/guardrail`)
      return json({ data: { rootSessionID: sessionID, profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [] } })
    if (url.pathname === `/api/session/${sessionID}/diagnostics`)
      return json({ data: { model, context: { total: 0, percent: 0 }, tokens: { uncachedInput: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cache: { eligible: 0, hitRatio: 0, mechanism: "none", readReported: false, writeReported: false }, requests: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: info().tokens } } })
    if (url.pathname === `/api/session/${sessionID}/usage`)
      return json({ data: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, cost: 0, tokens: info().tokens } })
    if ([`/api/session/${sessionID}/pending`, `/api/session/${sessionID}/permission`, `/api/session/${sessionID}/todo`, `/api/session/${sessionID}/skills`, `/api/session/${sessionID}/guardrail/request`, "/api/shell", "/api/mcp"].includes(url.pathname))
      return json({ location, data: [] })
    if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
    return undefined
  }
  return { route, mutations, admissionStates, current: () => autonomy, failNextAutonomy: () => { failAutonomy = true }, failNextGoal: () => { failGoal = true } }
}

async function waitFor(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (check()) return
    await Bun.sleep(20)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

test.each([1, 2, 3] as const)("landing YOLO %d is durable before its first prompt and shown in chat", async (level) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-landing-autonomy-"))
  const backend = fixture()
  const screen = await renderScreen({ width: 100, height: 40, state, route: backend.route, settle: "Message YCoding…" })
  try {
    const row = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, row)
    await screen.input.typeText(`/yolo ${level} `)
    screen.input.pressEnter()
    await waitFor(() => screen.frame().includes(`YOLO ${level}`), "landing YOLO chip")
    expect(backend.mutations).toEqual([])
    await screen.input.typeText(`Ship with level ${level}`)
    screen.input.pressEnter()
    await waitFor(() => backend.admissionStates.length > 0, "first prompt admission")
    expect(backend.mutations.slice(0, 3)).toEqual(["create", "autonomy", "admit"])
    expect(backend.admissionStates[0]).toMatchObject({ mode: "normal", yolo: level })
    await waitFor(() => screen.frame().includes(`YOLO ${level}`) && screen.frame().includes("shells 0"), "chat autonomy chip")
    if (level === 3) {
      screen.input.pressKey("x", { ctrl: true })
      screen.input.pressKey("n")
      await waitFor(() => screen.frame().includes("YOLO off") && screen.frame().includes("subagents 0") && !screen.frame().includes("shells 0"), "fresh landing state")
      const nextRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
      await screen.mouse.click(3, nextRow)
      await screen.input.typeText("Unrelated work")
      screen.input.pressEnter()
      await waitFor(() => backend.admissionStates.length === 2, "unrelated prompt admission")
      expect(backend.admissionStates[1]).toMatchObject({ mode: "normal", yolo: 0 })
      const secondCreate = backend.mutations.lastIndexOf("create")
      expect(backend.mutations.slice(secondCreate, backend.mutations.indexOf("admit", secondCreate) + 1)).toEqual(["create", "admit"])
    }
  } finally {
    await screen.dispose()
    await rm(state, { recursive: true, force: true })
  }
}, 30_000)

test("explicit landing goal creates a Session with the displayed YOLO level before its first prompt", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-landing-autonomy-"))
  const backend = fixture()
  const screen = await renderScreen({ width: 100, height: 40, state, route: backend.route, settle: "Message YCoding…" })
  try {
    const row = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, row)
    await screen.input.typeText("/yolo 3 ")
    screen.input.pressEnter()
    await waitFor(() => screen.frame().includes("YOLO 3"), "landing YOLO chip")
    await screen.input.typeText("/goal Validate every branch ")
    screen.input.pressEnter()
    await waitFor(() => backend.current().goal?.status === "active", "durable goal")
    expect(backend.mutations.slice(0, 2)).toEqual(["create", "autonomy"])
    expect(backend.current()).toMatchObject({ yolo: 3, goal: { text: "Validate every branch", status: "active" } })
    await waitFor(() => screen.frame().includes(" goal ") && !screen.frame().includes("shells 0"), "landing goal chip after durable set")
    await waitFor(() => screen.frame().includes("shells 0") && screen.frame().includes("YOLO 3") && screen.frame().includes(" goal "), "chat autonomy state")
    await screen.input.typeText("Start the work")
    screen.input.pressEnter()
    await waitFor(() => backend.admissionStates.length > 0, "first goal prompt admission")
    expect(backend.admissionStates[0]).toMatchObject({ yolo: 3, goal: { text: "Validate every branch", status: "active" } })
    screen.input.pressKey("x", { ctrl: true })
    screen.input.pressKey("n")
    await waitFor(() => screen.frame().includes("goal off") && screen.frame().includes("YOLO off") && !screen.frame().includes("shells 0"), "fresh landing goal state")
  } finally {
    await screen.dispose()
    await rm(state, { recursive: true, force: true })
  }
}, 30_000)

test("an autonomy-set failure retains the landing draft and prevents the first drain", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-landing-autonomy-"))
  const backend = fixture()
  backend.failNextAutonomy()
  const screen = await renderScreen({ width: 100, height: 40, state, route: backend.route, settle: "Message YCoding…" })
  try {
    const row = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, row)
    await screen.input.typeText("/yolo 2 ")
    screen.input.pressEnter()
    await waitFor(() => screen.frame().includes("YOLO 2"), "landing YOLO chip")
    await screen.input.typeText("Needs durable autonomy")
    screen.input.pressEnter()
    await waitFor(() => backend.mutations.includes("autonomy"), "rejected autonomy set")
    expect(backend.mutations).toEqual(["create", "autonomy"])
    expect(backend.admissionStates).toEqual([])
    expect(screen.frame()).toContain("Needs durable autonomy")
    screen.input.pressEnter()
    await waitFor(() => backend.admissionStates.length > 0, "retried prompt admission")
    expect(backend.mutations.slice(0, 4)).toEqual(["create", "autonomy", "autonomy", "admit"])
    expect(backend.admissionStates[0]).toMatchObject({ yolo: 2 })
  } finally {
    await screen.dispose()
    await rm(state, { recursive: true, force: true })
  }
}, 30_000)

test("the landing palette cycles visible YOLO levels without creating a Session", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-landing-autonomy-"))
  const backend = fixture()
  const screen = await renderScreen({ width: 100, height: 40, state, route: backend.route, settle: "Message YCoding…" })
  try {
    for (const level of [1, 2, 3]) {
      screen.input.pressKey("p", { ctrl: true })
      await waitFor(() => screen.frame().includes("Commands"), "command palette")
      await screen.input.typeText("Toggle YOLO")
      screen.input.pressEnter()
      await waitFor(() => screen.frame().includes(`YOLO ${level}`), `landing YOLO ${level}`)
      expect(backend.mutations).toEqual([])
    }
    const row = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, row)
    await screen.input.typeText("Palette-selected autonomy")
    screen.input.pressEnter()
    await waitFor(() => backend.admissionStates.length === 1, "palette-selected prompt admission")
    expect(backend.admissionStates[0]).toMatchObject({ yolo: 3 })
    expect(backend.mutations.slice(0, 3)).toEqual(["create", "autonomy", "admit"])
  } finally {
    await screen.dispose()
    await rm(state, { recursive: true, force: true })
  }
}, 30_000)

test("a failed landing goal still carries its displayed YOLO level to the created Session", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-landing-autonomy-"))
  const backend = fixture()
  backend.failNextGoal()
  const screen = await renderScreen({ width: 100, height: 40, state, route: backend.route, settle: "Message YCoding…" })
  try {
    const row = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, row)
    await screen.input.typeText("/yolo 3 ")
    screen.input.pressEnter()
    await waitFor(() => screen.frame().includes("YOLO 3"), "landing YOLO chip")
    await screen.input.typeText("/goal Keep this draft ")
    screen.input.pressEnter()
    await waitFor(() => backend.mutations.includes("autonomy"), "goal rejection")
    expect(backend.mutations.slice(0, 3)).toEqual(["create", "autonomy", "autonomy"])
    expect(backend.current()).toMatchObject({ yolo: 3 })
    expect(backend.current().goal).toBeUndefined()
    expect(backend.admissionStates).toEqual([])
    expect(screen.frame()).toContain("YOLO 3")
    expect(screen.frame()).toContain("goal off")
  } finally {
    await screen.dispose()
    await rm(state, { recursive: true, force: true })
  }
}, 30_000)
