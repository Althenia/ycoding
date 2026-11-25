import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { json, sessionSnapshot } from "../fixture/tui-client"
import { InputRenderable } from "@opentui/core"
import { DialogModel, type DialogModelResult } from "../../src/component/dialog-model"
import { useDialog } from "../../src/ui/dialog"
import { saveScreenCapture } from "../fixture/screen-capture"
import { renderScreen } from "./harness"
import type { useData } from "../../src/context/data"

const directory = "/tmp/ycoding/model-profile-selection"
const location = { directory, project: { id: "proj_model_profile_selection", directory } }
const model = {
  id: "claude-opus-5",
  modelID: "claude-opus-5",
  providerID: "anthropic",
  name: "Claude Opus 5",
  family: "",
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [{ id: "high" }],
  profiles: [{ name: "Work", active: true }, { name: "Personal", active: false }],
  time: { released: 1 },
  cost: [],
  status: "active" as const,
  enabled: true,
  limit: { context: 200_000, output: 32_000 },
}

function session(sessionID: string, profile?: string) {
  return {
    id: sessionID,
    title: sessionID,
    projectID: location.project.id,
    location: { directory },
    agent: "build",
    model: { providerID: "anthropic", id: model.id, variant: "high", ...(profile === undefined ? {} : { profile }) },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
  }
}

const workSession = session("ses_profile_work", "Work")
const personalSession = session("ses_profile_personal", "Personal")

test("interactive --model selects its named profile and variant in the rendered Home composer", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-model-argument-"))
  const screen = await renderScreen({
    width: 140,
    height: 48,
    state,
    args: { model: "Work#anthropic/claude-opus-5#high" },
    settle: "Message YCoding…",
    route: (url, request) => route({ requests: [], integrationWrites: [] })(url, request),
  })
  try {
    await waitFor(
      () => screen.frame().includes("Work · anthropic/Claude Opus 5") && screen.frame().includes("high"),
      "the CLI-selected Work/high model identity",
    )
    expect(screen.frame()).toContain("Work · anthropic/Claude Opus 5")
    expect(screen.frame()).toContain("high")
  } finally {
    await screen.dispose()
    await rm(state, { recursive: true, force: true })
  }
}, 30_000)

function route(input: {
  readonly sessions?: readonly ReturnType<typeof session>[]
  readonly modelProfile?: string
  readonly modelEnabled?: boolean
  readonly requests: Array<{ path: string; method: string; body?: Record<string, unknown> }>
  readonly integrationWrites: string[]
}) {
  return async (url: URL, request: Request) => {
    const sessions = input.sessions ?? [workSession]
    const body = request.method === "POST" ? await request.clone().json() as Record<string, unknown> : undefined
    input.requests.push({ path: url.pathname, method: request.method, body })
    if (url.pathname.includes("/integration") && request.method !== "GET") input.integrationWrites.push(url.pathname)
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/session") return json({ data: sessions, cursor: {} })
    if (url.pathname === "/api/session/active") return json({ data: {} })
    if (url.pathname === "/api/model") return json({ location, data: [{ ...model, enabled: input.modelEnabled ?? model.enabled, profiles: input.modelProfile === undefined ? model.profiles : [{ name: input.modelProfile, active: true }] }] })
    if (url.pathname === "/api/provider") return json({ location, data: [{ id: "anthropic", name: "Anthropic" }] })
    if (url.pathname === "/api/integration") return json({ location, data: [{ id: "anthropic", name: "Anthropic", methods: [], connections: [{ type: "credential", id: "cred_work", label: "Work", active: true }, { type: "credential", id: "cred_personal", label: "Personal", active: false }] }] })
    if (url.pathname === "/api/agent") return json({ location, data: [{ id: "build", name: "Build", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] }] })
    if (url.pathname === "/api/command") return json({ location, data: [] })
    if (url.pathname === "/api/fs/list") return json({ location, data: [] })
    const selectedSession = sessions.find((item) => url.pathname === `/api/session/${item.id}`)
    if (selectedSession) return json({ data: selectedSession })
    if (sessions.some((item) => url.pathname === `/api/session/${item.id}/snapshot`)) return sessionSnapshot(url.pathname.slice("/api/session/".length, -"/snapshot".length), [], { session: sessions.find((item) => url.pathname === `/api/session/${item.id}/snapshot`) })
    if (sessions.some((item) => url.pathname === `/api/session/${item.id}/subagent`)) return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
    if (/^\/api\/session\/[^/]+\/(pending|permission|form|todo|skills|guardrail\/request)$/.test(url.pathname)) return json({ data: [] })
    if (/^\/api\/session\/[^/]+\/guardrail$/.test(url.pathname)) return json({ data: { rootSessionID: sessions[0]?.id ?? workSession.id, profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [] } })
    if (url.pathname.endsWith("/model") && request.method === "POST") return new Response(null, { status: 204 })
    if (url.pathname.endsWith("/prompt") && request.method === "POST") {
      const sessionID = url.pathname.split("/")[3]!
      const inputText = body?.text
      return json({ data: { id: body?.id, sessionID, admittedSeq: 1, timeCreated: 1, type: "user", data: { text: typeof inputText === "string" ? inputText : "draft" }, delivery: "steer" } })
    }
    return undefined
  }
}

test("the rendered Session header uses each Session profile, not the provider's active default", async () => {
  const requests: Array<{ path: string; method: string; body?: Record<string, unknown> }> = []
  const integrationWrites: string[] = []
  for (const [selected, current] of [[workSession, "Work"], [personalSession, "Personal"]] as const) {
    const screen = await renderScreen({
      width: 140,
      height: 48,
      args: { sessionID: selected.id },
      settle: "Message YCoding…",
      route: (url, request) => route({ sessions: [workSession, personalSession], requests, integrationWrites })(url, request),
    })
    try {
      await waitFor(() => screen.frame().includes(`${current} · anthropic/Claude Opus 5`), `${current} Session header`)
      expect(screen.frame()).toContain(`${current} · anthropic/Claude Opus 5`)
      expect(screen.frame()).not.toContain("cred_")
      if (current === "Personal") expect(screen.frame()).not.toContain("Work · anthropic/Claude Opus 5")
    } finally {
      await screen.dispose()
    }
  }
  expect(integrationWrites).toEqual([])
})

test("an unavailable saved profile blocks the rendered prompt and retains its draft", async () => {
  const requests: Array<{ path: string; method: string; body?: Record<string, unknown> }> = []
  const integrationWrites: string[] = []
  const unavailableSession = session("ses_profile_removed", "Removed")
  let data!: ReturnType<typeof useData>
  const screen = await renderScreen({
    width: 120,
    height: 48,
    args: { sessionID: unavailableSession.id },
    settle: "Message YCoding…",
    data: (value) => { data = value },
    route: (url, request) => route({ sessions: [unavailableSession], modelProfile: "Work", requests, integrationWrites })(url, request),
  })
  try {
    await Promise.all([
      data.location.model.sync(unavailableSession.location),
      data.location.agent.sync(unavailableSession.location),
    ])
    await screen.input.typeText("keep this profile-bound draft")
    await waitFor(() => screen.frame().includes("keep this profile-bound draft"), "the visible prompt draft")
    screen.input.pressEnter()
    await waitFor(async () => {
      await screen.renderOnce()
      return screen.frame().includes("Profile Removed is unavailable")
    }, "the unavailable-profile warning")
    expect(screen.frame()).toContain("keep this profile-bound draft")
    expect(requests.filter((request) => request.method === "POST")).toEqual([])
    expect(integrationWrites).toEqual([])
  } finally {
    await screen.dispose()
  }
})

test("a disabled provider default blocks the rendered prompt and retains its draft", async () => {
  const requests: Array<{ path: string; method: string; body?: Record<string, unknown> }> = []
  const integrationWrites: string[] = []
  const defaultSession = session("ses_profile_default_disabled")
  let data!: ReturnType<typeof useData>
  const screen = await renderScreen({
    width: 120,
    height: 48,
    args: { sessionID: defaultSession.id },
    settle: "Message YCoding…",
    data: (value) => { data = value },
    route: (url, request) => route({ sessions: [defaultSession], modelEnabled: false, requests, integrationWrites })(url, request),
  })
  try {
    await Promise.all([
      data.location.model.sync(defaultSession.location),
      data.location.agent.sync(defaultSession.location),
    ])
    await screen.input.typeText("keep this default-bound draft")
    await waitFor(() => screen.frame().includes("keep this default-bound draft"), "the visible default-bound draft")
    screen.input.pressEnter()
    await waitFor(
      async () => {
        await screen.renderOnce()
        return screen.frame().includes("Model selection needs attention")
      },
      "the unavailable provider-default warning",
      () => screen.frame(),
    )
    expect(screen.frame()).toContain("keep this default-bound draft")
    expect(requests.filter((request) => request.method === "POST")).toEqual([])
    expect(integrationWrites).toEqual([])
  } finally {
    await screen.dispose()
  }
})

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, frame?: () => string) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (await predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error(`Timed out waiting for ${label}${frame ? `:\n${frame()}` : ""}`)
}

const lightRoutes = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-flash-thinking", "gemini-3.5-flash-lite"]
const hydrogen = "gemini-4-hydrogen"
const tiered = "gemini-4-hydrogen-tiered"

function catalogRow(id: string, name: string, context = 1_048_576, efforts: string[] = [], target = id) {
  return { ...model, providerID: "antigravity", id, modelID: target, name, limit: { context, output: 65_536 },
    profiles: [{ name: "Lab", active: true, variants: efforts }], variants: efforts.map(id => ({ id })) }
}

for (const choice of ["saved favorite", "search"] as const) {
  test(`same-name model routes remain distinct through ${choice}`, async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-model-routes-"))
    const providerID = "antigravity"
    const favorite = { providerID, modelID: tiered, profile: "Lab" }
    await Bun.write(path.join(state, "model.json"), JSON.stringify({ favorite: [favorite], recent: [], variant: { [`${providerID}/${tiered}#profile=Lab`]: "high" } }))
    const catalog = [
      ...lightRoutes.map(id => catalogRow(id, "Gemini 3.5 Flash Lite")),
      catalogRow("gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite"),
      catalogRow(hydrogen, "Gemini 4 Hydrogen", 500_000, ["low", "medium", "high", "xhigh"], `${hydrogen}-medium`),
      catalogRow(tiered, "Gemini 4 Hydrogen", 1_048_576, ["high", "xhigh"], `${tiered}-high`),
    ]
    let open!: () => void
    let result: DialogModelResult | undefined
    const fallback = route({ requests: [], integrationWrites: [] })
    const screen = await renderScreen({ width: 120, height: 42, state, settle: "Message YCoding…",
      data: () => { const dialog = useDialog(); open = () => dialog.replace(() => DialogModel({ onComplete: value => { result = value } })) },
      route: (url, request) => url.pathname === "/api/model" ? json({ location, data: catalog })
        : url.pathname === "/api/provider" ? json({ location, data: [{ id: providerID, name: "Antigravity" }] })
        : url.pathname === "/api/integration" ? json({ location, data: [{ id: providerID, name: "Antigravity", methods: [], connections: [{ type: "credential", id: "cred_lab", label: "Lab", active: true }] }] })
        : fallback(url, request),
    })
    const visible = (text: string) => waitFor(async () => { await screen.renderOnce(); return screen.frame().includes(text) }, text, screen.frame)
    const click = async (text: string) => {
      const rows = screen.lines()
      const y = rows.findIndex(line => line.includes(text))
      expect(y).toBeGreaterThanOrEqual(0)
      await screen.mouse.click(rows[y].indexOf(text) + 1, y)
    }
    try {
      open()
      await visible("Favorites")
      await visible("Gemini 3.1 Flash Lite")
      for (const id of [...lightRoutes, hydrogen, tiered]) expect(screen.frame()).toMatch(new RegExp(`\\b${id.replaceAll(".", "\\.")}(?![\\w-])`))
      const saved = screen.lines().find(line => line.includes(tiered))!
      expect(saved).toContain("Lab")
      expect(saved).toContain("1.048576m")
      expect(screen.lines().find(line => line.includes("500k"))).toContain(hydrogen)
      if (choice === "saved favorite") {
        await saveScreenCapture("same-name-model-routes", screen)
        await click(tiered)
        await visible("Provider profile")
        await click("Lab")
        await waitFor(() => result !== undefined, "saved model selection")
        expect(result).toEqual({ type: "selected", selection: { ...favorite, variant: "high" } })
      } else {
        await waitFor(() => screen.renderer.currentFocusedEditor instanceof InputRenderable, "picker search focus")
        await screen.input.typeText(hydrogen)
        await visible(tiered)
        await waitFor(async () => { await screen.renderOnce(); return !screen.frame().includes("Favorites") && !screen.frame().includes("Gemini 3.1 Flash Lite") }, "filtered routes", screen.frame)
        expect(screen.lines().filter(line => line.includes("Gemini 4 Hydrogen ·"))).toHaveLength(2)
        await click(`Gemini 4 Hydrogen · ${hydrogen} `)
        await visible("Provider profile")
        await click("Lab")
        await visible("Select variant")
        await click("medium")
        await waitFor(() => result !== undefined, "standard route selection")
        expect(result).toEqual({ type: "selected", selection: { providerID, modelID: hydrogen, profile: "Lab", variant: "medium" } })
      }
    } finally {
      await screen.dispose()
      await rm(state, { recursive: true, force: true })
    }
  }, 30_000)
}
