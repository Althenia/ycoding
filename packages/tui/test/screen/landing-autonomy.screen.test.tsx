/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { SessionAutonomyView } from "@ycoding-ai/client"
import { json, type FetchHandler, sessionSnapshot } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const directory = "/tmp/ycoding/landing-autonomy"
const location = { directory, project: { id: "proj_landing_autonomy", directory } }
const model = { providerID: "openai", id: "gpt-5.6-terra" }
const agent = { id: "build", name: "Build", mode: "primary", hidden: false, permissions: [], request: { headers: {}, body: {} } }
const modelInfoBase = {
  ...model, modelID: "openai/gpt-5.6-terra", name: "GPT 5.6 Terra",
  capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [],
  time: { released: 0 }, cost: [], status: "active", enabled: true,
  limit: { context: 200_000, output: 32_000 },
}

function fixture(input: {
  enabled?: boolean
  profiles?: Array<{ name: string; active: boolean; variants: string[] }>
  selection?: { providerID: string; id: string; profile?: string; variant?: string }
  agentModel?: { providerID: string; id: string; profile?: string; variant?: string }
} = {}) {
  let sessionID: string | undefined
  let autonomyState: Omit<SessionAutonomyView, "effective"> = { mode: "normal", yolo: false }
  const autonomyView = (): SessionAutonomyView => {
    const asleep = autonomyState.sleep !== undefined && autonomyState.sleep !== null
    return {
      ...autonomyState,
      effective: {
        yolo: autonomyState.yolo === true,
        permissionsAuto: autonomyState.autoPermission === true,
        permissionModelReviews: true,
        asleep,
        ordinaryReviewsAuto: autonomyState.autoGuardrail === true && !asleep,
        guardrailsEnabled: true,
        modelReviews: false,
        hardModelReviews: false,
      },
    }
  }
  let failAutonomy = false
  let failGoal = false
  const mutations: string[] = []
  const creates: Record<string, unknown>[] = []
  const admissionStates: SessionAutonomyView[] = []
  const selection = input.selection ?? { providerID: model.providerID, id: model.id }
  const modelInfo = {
    ...modelInfoBase,
    enabled: input.enabled ?? modelInfoBase.enabled,
    ...(input.profiles === undefined ? {} : { profiles: input.profiles }),
  }
  const infoModel = {
    providerID: selection.providerID,
    id: selection.id,
    ...(selection.profile === undefined ? {} : { profile: selection.profile }),
    ...(selection.variant === undefined ? {} : { variant: selection.variant }),
  }
  const info = () => ({
    id: sessionID, projectID: location.project.id, title: "Landing autonomy", location: { directory },
    agent: "build", model: infoModel, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
  })
  const route: FetchHandler = async (url, request) => {
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/fs/list") return json({ location, data: [] })
    if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
    if (url.pathname === "/api/agent") return json({ location, data: [{ ...agent, ...(input.agentModel ? { model: input.agentModel } : {}) }] })
    if (url.pathname === "/api/model") return json({ location, data: [modelInfo] })
    if (url.pathname === "/api/model/default")
      return json({ location, data: { ...modelInfo, selection } })
    if (url.pathname === "/api/provider") return json({ location, data: [] })
    if (["/api/integration", "/api/command", "/api/skill", "/api/reference", "/api/permission/request", "/api/form/request"].includes(url.pathname))
      return json({ location, data: [] })
    if (url.pathname === "/api/session/active") return json({ data: {} })
    if (url.pathname === "/api/session" && request.method === "POST") {
      const body: unknown = await request.json()
      if (typeof body === "object" && body !== null) creates.push(structuredClone(body) as Record<string, unknown>)
      const id = typeof body === "object" && body !== null ? Reflect.get(body, "id") : undefined
      sessionID = typeof id === "string" ? id : "ses_landing_goal_new"
      autonomyState = { mode: "normal", yolo: false }
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
        const autoAnswer = Reflect.get(payload, "autoAnswer")
        const autoPermission = Reflect.get(payload, "autoPermission")
        const autoGuardrail = Reflect.get(payload, "autoGuardrail")
        const sleep = Reflect.get(payload, "sleep")
        mutations.push("autonomy")
        if (failAutonomy) {
          failAutonomy = false
          return new Response("autonomy rejected", { status: 500 })
        }
        if (failGoal && typeof goal === "string") {
          failGoal = false
          return new Response("goal rejected", { status: 500 })
        }
        autonomyState = {
          mode: "normal", yolo: typeof yolo === "boolean" ? yolo : autonomyState.yolo,
          ...(typeof autoPermission === "boolean" ? { autoPermission } : autonomyState.autoPermission === undefined ? {} : { autoPermission: autonomyState.autoPermission }),
          ...(typeof autoGuardrail === "boolean" ? { autoGuardrail } : autonomyState.autoGuardrail === undefined ? {} : { autoGuardrail: autonomyState.autoGuardrail }),
          ...(typeof autoAnswer === "boolean" ? { autoAnswer } : autonomyState.autoAnswer === undefined ? {} : { autoAnswer: autonomyState.autoAnswer }),
          ...(typeof sleep === "boolean" ? (sleep ? { sleep: {} } : {}) : autonomyState.sleep ? { sleep: autonomyState.sleep } : {}),
          ...(typeof goal === "string" ? { goal: { text: goal, status: "active" as const, iteration: 0, noProgress: 0, maxNoProgress: 3 } } : goal === null ? {} : autonomyState.goal ? { goal: autonomyState.goal } : {}),
        }
      }
      return json({ data: autonomyView() })
    }
    if (url.pathname === `/api/session/${sessionID}/prompt` && request.method === "POST") {
      const body: unknown = await request.json()
      if (typeof body !== "object" || body === null) throw new Error("Invalid prompt payload")
      const id = Reflect.get(body, "id")
      const text = Reflect.get(body, "text")
      const resume = Reflect.get(body, "resume")
      if (typeof id !== "string" || typeof text !== "string") throw new Error("Invalid prompt identity")
      mutations.push(resume === false ? "admit" : "wake")
      if (resume === false) admissionStates.push(structuredClone(autonomyView()))
      return json({ data: {
        id, sessionID, admittedSeq: 1, timeCreated: Date.now(), type: "user",
        data: { text }, delivery: "steer",
      } })
    }
    if (url.pathname === `/api/session/${sessionID}/snapshot`) return sessionSnapshot(sessionID, [], { session: info() })
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
  return { route, mutations, creates, admissionStates, current: () => autonomyView(), failNextAutonomy: () => { failAutonomy = true }, failNextGoal: () => { failGoal = true } }
}

async function waitFor(check: () => boolean, label: string | (() => string)) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (check()) return
    await Bun.sleep(20)
  }
  throw new Error(`Timed out waiting for ${typeof label === "function" ? label() : label}`)
}

test("clean Home shows and creates a Session from the configured profile variant", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-landing-model-"))
  const selection = { providerID: "openai", id: "gpt-5.6-terra", profile: "Work", variant: "high" }
  const backend = fixture({
    enabled: false,
    profiles: [
      { name: "Work", active: true, variants: ["high"] },
      { name: "Personal", active: false, variants: ["low"] },
    ],
    selection,
  })
  const screen = await renderScreen({ width: 100, height: 40, state, route: backend.route, settle: "Work" })
  try {
    await waitFor(() => screen.frame().includes("Work") && screen.frame().includes("high"), "configured Work/high in Home header")
    const row = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, row)
    await screen.input.typeText("Use configured profile")
    screen.input.pressEnter()
    await waitFor(() => backend.creates.length === 1, "Session creation with the configured selection")
    expect(backend.creates[0]).toMatchObject({
      model: { providerID: "openai", id: "gpt-5.6-terra", profile: "Work", variant: "high" },
    })
  } finally {
    await screen.dispose()
    await rm(state, { recursive: true, force: true })
  }
}, 30_000)

test("an unavailable named Home preference remains visible and blocks submission", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-landing-model-"))
  await Bun.write(
    path.join(state, "model.json"),
    JSON.stringify({ recent: [{ providerID: "openai", modelID: "gpt-5.6-terra", profile: "Work" }], favorite: [], variant: {} }),
  )
  const backend = fixture({
    enabled: false,
    profiles: [{ name: "Personal", active: true, variants: ["low"] }],
    selection: { providerID: "openai", id: "gpt-5.6-terra", profile: "Personal", variant: "low" },
  })
  const screen = await renderScreen({ width: 100, height: 40, state, route: backend.route, settle: "Work" })
  try {
    await waitFor(() => screen.frame().includes("Work"), "the unavailable named Work preference")
    const row = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, row)
    await screen.input.typeText("Keep this unavailable-profile draft")
    screen.input.pressEnter()
    await waitFor(() => screen.frame().includes("Model selection needs attention"), "the unavailable profile warning")
    expect(screen.frame()).toContain("Keep this unavailable-profile draft")
    expect(backend.creates).toEqual([])
  } finally {
    await screen.dispose()
    await rm(state, { recursive: true, force: true })
  }
}, 30_000)

test("an unavailable configured agent profile remains visible and blocks submission", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-landing-model-"))
  const backend = fixture({
    enabled: false,
    profiles: [{ name: "Personal", active: true, variants: ["low"] }],
    selection: { providerID: "openai", id: "gpt-5.6-terra", profile: "Personal", variant: "low" },
    agentModel: { providerID: "openai", id: "gpt-5.6-terra", profile: "Work", variant: "high" },
  })
  const screen = await renderScreen({ width: 100, height: 40, state, route: backend.route, settle: "Work" })
  try {
    await waitFor(() => screen.frame().includes("Work"), "the unavailable configured agent profile")
    const row = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, row)
    await screen.input.typeText("Keep the agent-profile draft")
    screen.input.pressEnter()
    await waitFor(() => screen.frame().includes("Model selection needs attention"), "the unavailable agent profile warning")
    expect(screen.frame()).toContain("Keep the agent-profile draft")
    expect(backend.creates).toEqual([])
  } finally {
    await screen.dispose()
    await rm(state, { recursive: true, force: true })
  }
}, 30_000)

test("landing yolo and auto flags are durable before the first prompt and shown in chat", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-landing-autonomy-"))
  const backend = fixture()
  const screen = await renderScreen({ width: 100, height: 40, state, route: backend.route, settle: "Message YCoding…" })
  try {
    const row = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, row)
    await screen.input.typeText("/yolo on ")
    screen.input.pressEnter()
    await waitFor(() => !screen.frame().includes("YOLO off"), "landing yolo chip")
    await screen.input.typeText("/auto-permission on ")
    screen.input.pressEnter()
    await waitFor(() => screen.frame().includes("permissions auto"), "landing permissions chip")
    await screen.input.typeText("/auto-guardrail on ")
    screen.input.pressEnter()
    await waitFor(() => screen.frame().includes("guardrails auto"), "landing guardrails chip")
    expect(backend.mutations).toEqual([])
    await screen.input.typeText("Ship with toggles")
    screen.input.pressEnter()
    await waitFor(() => backend.admissionStates.length > 0, "first prompt admission")
    expect(backend.mutations.slice(0, 5)).toEqual(["create", "autonomy", "autonomy", "autonomy", "admit"])
    expect(backend.admissionStates[0]).toMatchObject({ mode: "normal", yolo: true, autoPermission: true, autoGuardrail: true })
    await waitFor(() => screen.lines()[1]?.includes("ready") ?? false, () => `chat header:\n${screen.frame()}`)
    expect(screen.lines()[1]).not.toMatch(/YOLO|permissions auto|guardrails auto/)
    screen.input.pressKey("x", { ctrl: true })
    screen.input.pressKey("n")
    await waitFor(() => screen.frame().includes("YOLO off") && screen.frame().includes("subagents 0") && !screen.frame().includes("shells 0"), "fresh landing state")
    const nextRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, nextRow)
    await screen.input.typeText("Unrelated work")
    screen.input.pressEnter()
    await waitFor(() => backend.admissionStates.length === 2, "unrelated prompt admission")
    expect(backend.admissionStates[1]).toMatchObject({ mode: "normal", yolo: false })
    const secondCreate = backend.mutations.lastIndexOf("create")
    expect(backend.mutations.slice(secondCreate, backend.mutations.indexOf("admit", secondCreate) + 1)).toEqual(["create", "admit"])
  } finally {
    await screen.dispose()
    await rm(state, { recursive: true, force: true })
  }
}, 30_000)

test("explicit landing goal creates a Session with the displayed YOLO toggle before its first prompt", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-landing-autonomy-"))
  const backend = fixture()
  const screen = await renderScreen({ width: 100, height: 40, state, route: backend.route, settle: "Message YCoding…" })
  try {
    const row = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, row)
    await screen.input.typeText("/yolo on ")
    screen.input.pressEnter()
    await waitFor(() => !screen.frame().includes("YOLO off"), "landing yolo chip")
    await screen.input.typeText("/goal Validate every branch ")
    screen.input.pressEnter()
    await waitFor(() => backend.current().goal?.status === "active", "durable goal")
    expect(backend.mutations.slice(0, 3)).toEqual(["create", "autonomy", "autonomy"])
    expect(backend.current()).toMatchObject({ yolo: true, goal: { text: "Validate every branch", status: "active" } })
    await waitFor(() => screen.frame().includes(" goal ") && !screen.frame().includes("shells 0"), "landing goal chip after durable set")
    await waitFor(() => screen.frame().includes("shells 0"), "chat footer")
    await waitFor(() => screen.lines()[1]?.includes("ready") ?? false, "chat header")
    expect(screen.lines()[1]).not.toMatch(/YOLO|goal/)
    await waitFor(() => screen.lines()[1]?.includes("ready") ?? false, "chat history ready")
    await screen.input.typeText("Start the work")
    screen.input.pressEnter()
    await waitFor(() => backend.admissionStates.length > 0, () => `first goal prompt admission:\n${screen.frame()}`)
    expect(backend.admissionStates[0]).toMatchObject({ yolo: true, goal: { text: "Validate every branch", status: "active" } })
    screen.input.pressKey("x", { ctrl: true })
    screen.input.pressKey("n")
    await waitFor(() => screen.frame().includes("goal off") && screen.frame().includes("YOLO off") && !screen.frame().includes("shells 0"), "fresh landing goal state")
  } finally {
    await screen.dispose()
    await rm(state, { recursive: true, force: true })
  }
}, 30_000)

test("an autonomy-set failure retains the submitted input for receipt retry and prevents the first drain", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-landing-autonomy-"))
  const backend = fixture()
  backend.failNextAutonomy()
  const screen = await renderScreen({ width: 100, height: 40, state, route: backend.route, settle: "Message YCoding…" })
  try {
    const row = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, row)
    await screen.input.typeText("/yolo on ")
    screen.input.pressEnter()
    await waitFor(() => !screen.frame().includes("YOLO off"), "landing yolo chip")
    await screen.input.typeText("Needs durable autonomy")
    screen.input.pressEnter()
    await waitFor(() => backend.mutations.includes("autonomy"), "rejected autonomy set")
    await waitFor(() => screen.frame().includes("Setting autonomy unresolved · Retry send"), "retained submission receipt")
    expect(backend.mutations).toEqual(["create", "autonomy"])
    expect(backend.admissionStates).toEqual([])
    expect(screen.frame()).toContain("Needs durable autonomy")
    const retryRow = screen.lines().findIndex((line) => line.includes("Retry send"))
    await screen.mouse.click(screen.lines()[retryRow].indexOf("Retry send"), retryRow)
    await waitFor(() => backend.admissionStates.length > 0, "retried prompt admission")
    expect(backend.mutations.slice(0, 4)).toEqual(["create", "autonomy", "autonomy", "admit"])
    expect(backend.admissionStates[0]).toMatchObject({ yolo: true })
  } finally {
    await screen.dispose()
    await rm(state, { recursive: true, force: true })
  }
}, 30_000)

test("the landing palette toggles YOLO without creating a Session", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-landing-autonomy-"))
  const backend = fixture()
  const screen = await renderScreen({ width: 100, height: 40, state, route: backend.route, settle: "Message YCoding…" })
  try {
    for (const on of [true, false, true]) {
      screen.input.pressKey("p", { ctrl: true })
      await waitFor(() => screen.frame().includes("Commands"), "command palette")
      await screen.input.typeText("Toggle YOLO")
      screen.input.pressEnter()
      await waitFor(
        () => (on ? !screen.frame().includes("YOLO off") : screen.frame().includes("YOLO off")),
        `landing yolo ${on ? "on" : "off"}`,
      )
      expect(backend.mutations).toEqual([])
    }
    const row = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, row)
    await screen.input.typeText("Palette-selected autonomy")
    screen.input.pressEnter()
    await waitFor(() => backend.admissionStates.length === 1, "palette-selected prompt admission")
    expect(backend.admissionStates[0]).toMatchObject({ yolo: true })
    expect(backend.mutations.slice(0, 3)).toEqual(["create", "autonomy", "admit"])
  } finally {
    await screen.dispose()
    await rm(state, { recursive: true, force: true })
  }
}, 30_000)

test("a failed landing goal still carries its displayed YOLO toggle to the created Session", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-landing-autonomy-"))
  const backend = fixture()
  backend.failNextGoal()
  const screen = await renderScreen({ width: 100, height: 40, state, route: backend.route, settle: "Message YCoding…" })
  try {
    const row = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, row)
    await screen.input.typeText("/yolo on ")
    screen.input.pressEnter()
    await waitFor(() => !screen.frame().includes("YOLO off"), "landing yolo chip")
    await screen.input.typeText("/goal Keep this draft ")
    screen.input.pressEnter()
    await waitFor(() => backend.mutations.includes("autonomy"), "goal rejection")
    expect(backend.mutations.slice(0, 3)).toEqual(["create", "autonomy", "autonomy"])
    expect(backend.current()).toMatchObject({ yolo: true })
    expect(backend.current().goal).toBeUndefined()
    expect(backend.admissionStates).toEqual([])
    expect(screen.frame()).toContain("YOLO")
    expect(screen.frame()).toContain("goal off")
  } finally {
    await screen.dispose()
    await rm(state, { recursive: true, force: true })
  }
}, 30_000)

test("landing /auto-answer draft is durable before the first prompt and shown in chat", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-landing-autonomy-"))
  const backend = fixture()
  const screen = await renderScreen({ width: 100, height: 40, state, route: backend.route, settle: "Message YCoding…" })
  try {
    const row = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, row)
    await screen.input.typeText("/auto-answer ")
    screen.input.pressEnter()
    await waitFor(() => screen.frame().includes("answers auto"), "landing answers-auto chip")
    expect(backend.mutations).toEqual([])
    await screen.input.typeText("Ship with answers")
    screen.input.pressEnter()
    await waitFor(() => backend.admissionStates.length > 0, "first prompt admission")
    expect(backend.mutations.slice(0, 3)).toEqual(["create", "autonomy", "admit"])
    expect(backend.admissionStates[0]).toMatchObject({ autoAnswer: true })
    await waitFor(() => (screen.lines()[1]?.includes("ready") ?? false) && screen.frame().includes("shells 0"), () => `chat header:\n${screen.frame()}`)
    expect(screen.lines()[1]).not.toMatch(/YOLO|answers auto/)
  } finally {
    await screen.dispose()
    await rm(state, { recursive: true, force: true })
  }
}, 30_000)
