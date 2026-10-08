import { expect, test } from "bun:test"
import { json } from "../fixture/tui-client"
import { renderScreen } from "./harness"

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
    if (sessions.some((item) => url.pathname === `/api/session/${item.id}/message`)) return json({ data: [], cursor: {} })
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
  const screen = await renderScreen({
    width: 120,
    height: 48,
    args: { sessionID: unavailableSession.id },
    settle: "Message YCoding…",
    route: (url, request) => route({ sessions: [unavailableSession], modelProfile: "Work", requests, integrationWrites })(url, request),
  })
  try {
    await screen.input.typeText("keep this profile-bound draft")
    await waitFor(() => screen.frame().includes("keep this profile-bound draft"), "the visible prompt draft")
    screen.input.pressEnter()
    await waitFor(() => screen.frame().includes("Profile Removed is unavailable"), "the unavailable-profile warning")
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
  const screen = await renderScreen({
    width: 120,
    height: 48,
    args: { sessionID: defaultSession.id },
    settle: "Message YCoding…",
    route: (url, request) => route({ sessions: [defaultSession], modelEnabled: false, requests, integrationWrites })(url, request),
  })
  try {
    await screen.input.typeText("keep this default-bound draft")
    await waitFor(() => screen.frame().includes("keep this default-bound draft"), "the visible default-bound draft")
    screen.input.pressEnter()
    await waitFor(
      () => screen.frame().includes("Model selection needs attention"),
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

async function waitFor(predicate: () => boolean, label: string, frame?: () => string) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error(`Timed out waiting for ${label}${frame ? `:\n${frame()}` : ""}`)
}
