/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import { json } from "./fixture/tui-client"
import { renderScreen } from "./screen/harness"

const parentID = "ses_btw_parent"
const ordinaryID = "ses_ordinary_child"
const btwID = "ses_btw_child"
const directory = "/tmp/ycoding/btw-phase-one"
const location = { directory, project: { id: "proj_btw_phase_one", directory } }
const model = { providerID: "openai", id: "gpt-5.6-sol", variant: "high" }
const parent = session(parentID, "Main implementation", "build")
const ordinary = session(ordinaryID, "Ordinary review", "reviewer", parentID)
const btw = session(btwID, "Investigate the side issue", "btw", parentID)

type PromptRequest = {
  id: string
  text: string
  delivery?: "steer" | "queue"
  resume?: boolean
}

function session(id: string, title: string, agent: string, parent?: string) {
  return {
    id,
    title,
    projectID: location.project.id,
    location: { directory },
    agent,
    ...(parent ? { parentID: parent } : {}),
    model,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
  }
}

function isPromptRequest(value: unknown): value is PromptRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "text" in value &&
    typeof value.text === "string"
  )
}

function fixture(options: { variant?: string } = { variant: "high" }) {
  const sessions = [parent, ordinary, { ...btw, model: { ...model, variant: options.variant } }]
  const prompts: Array<{ sessionID: string; body: PromptRequest }> = []
  const switches: Array<{ sessionID: string; kind: "agent" | "model"; body: unknown }> = []
  const generates: unknown[] = []
  const interrupts: unknown[] = []
  let failParentPrompt = false

  async function route(url: URL, request: Request) {
    if (url.pathname === "/api/fs/list") return json({ location, data: [] })
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/session") return json({ data: sessions, cursor: {} })
    const current = sessions.find((item) => url.pathname === `/api/session/${item.id}`)
    if (current) return json({ data: current })
    const messageSession = [parentID, ordinaryID, btwID].find(
      (sessionID) => url.pathname === `/api/session/${sessionID}/message`,
    )
    if (messageSession)
      return json({
        data:
          messageSession === parentID
            ? []
            : [
                {
                  id: `msg_${messageSession}_assistant`,
                  type: "assistant",
                  agent: messageSession === btwID ? "btw" : "reviewer",
                  model,
                  content: [{ type: "text", text: messageSession === btwID ? "Side-chat context loaded." : "Reviewing." }],
                  time: { created: 1, completed: 2 },
                },
              ],
        cursor: {},
      })
    const promptSession = [parentID, ordinaryID, btwID].find(
      (sessionID) => url.pathname === `/api/session/${sessionID}/prompt` && request.method === "POST",
    )
    if (promptSession) {
      const body: unknown = await request.json()
      if (!isPromptRequest(body)) return json({ error: "invalid prompt" }, { status: 400 })
      prompts.push({ sessionID: promptSession, body })
      if (promptSession === parentID && failParentPrompt) {
        failParentPrompt = false
        return json({ error: "simulated parent admission failure" }, { status: 500 })
      }
      return json({
        data: {
          id: body.id,
          sessionID: promptSession,
          admittedSeq: prompts.length,
          timeCreated: prompts.length,
          type: "user",
          data: { text: body.text },
          delivery: body.delivery ?? "steer",
        },
      })
    }
    const switched = [ordinaryID, btwID].find(
      (sessionID) =>
        (url.pathname === `/api/session/${sessionID}/agent` || url.pathname === `/api/session/${sessionID}/model`) &&
        request.method === "POST",
    )
    if (switched) {
      switches.push({
        sessionID: switched,
        kind: url.pathname.endsWith("/agent") ? "agent" : "model",
        body: await request.json(),
      })
      return new Response(null, { status: 204 })
    }
    if (url.pathname.endsWith("/generate") && request.method === "POST") {
      generates.push(await request.json())
      return json({ data: { text: "unexpected generated summary" } })
    }
    if (url.pathname.endsWith("/interrupt") && request.method === "POST") {
      interrupts.push(await request.json().catch(() => undefined))
      return new Response(null, { status: 204 })
    }
    if ([parentID, ordinaryID, btwID].some((sessionID) => url.pathname === `/api/session/${sessionID}/subagent`))
      return json({
        data: [
          {
            sessionID: ordinaryID,
            parentID,
            description: "Ordinary managed work",
            agent: "reviewer",
            model,
            background: true,
            state: "running",
            revision: 1,
            time: { created: 1, updated: 2 },
          },
        ],
        summary: { total: 1, active: 1, running: 1, waiting: 0 },
        cursor: {},
      })
    if (/^\/api\/session\/[^/]+\/(pending|permission|form|todo|skills|guardrail\/request)$/.test(url.pathname))
      return json({ data: [] })
    if (/^\/api\/session\/[^/]+\/diagnostics$/.test(url.pathname))
      return json({
        data: {
          model,
          context: { total: 0, percent: 0 },
          tokens: { uncachedInput: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          cache: { eligible: 0, hitRatio: 0, mechanism: "unreported", readReported: false, writeReported: false },
          requests: {
            logical: 0,
            physical: 0,
            helpers: 0,
            continued: 0,
            fallback: 0,
            tokens: btw.tokens,
          },
        },
      })
    if (/^\/api\/session\/[^/]+\/usage$/.test(url.pathname)) return json({ data: null })
    if (/^\/api\/session\/[^/]+\/guardrail$/.test(url.pathname))
      return json({
        data: {
          rootSessionID: parentID,
          profile: "standard",
          customRules: 0,
          approvals: 0,
          blocked: 0,
          counters: [],
          invalidFiles: [],
        },
      })
    if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
    if (url.pathname === "/api/model")
      return json({
        location,
        data: [
          {
            id: model.id,
            modelID: model.id,
            providerID: model.providerID,
            name: "GPT 5.6 Sol",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            variants: [{ id: model.variant }],
            time: { released: 0 },
            cost: [],
            status: "active",
            enabled: true,
            limit: { context: 200_000, output: 32_000 },
          },
        ],
      })
    if (url.pathname === "/api/provider") return json({ location, data: [{ id: "openai", name: "OpenAI" }] })
    if (url.pathname === "/api/agent")
      return json({
        location,
        data: [
          { id: "build", name: "Build", mode: "primary", hidden: false, permissions: [], request: { headers: {}, body: {} } },
          {
            id: "btw",
            name: "BTW",
            mode: "primary",
            hidden: false,
            permissions: [{ action: "*", resource: "*", effect: "deny" }],
            request: { headers: {}, body: {} },
          },
          { id: "reviewer", name: "Reviewer", mode: "subagent", hidden: false, permissions: [], request: { headers: {}, body: {} } },
        ],
      })
    if (
      [
        "/api/integration",
        "/api/command",
        "/api/skill",
        "/api/reference",
        "/api/mcp",
        "/api/shell",
        "/api/permission/request",
        "/api/form/request",
      ].includes(url.pathname)
    )
      return json({ location, data: [] })
    if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
    return undefined
  }

  return {
    route,
    prompts,
    switches,
    generates,
    interrupts,
    failNextParentPrompt() {
      failParentPrompt = true
    },
  }
}

async function waitFor(input: () => boolean, description: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (input()) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function focusEmptyBtwComposer(screen: Awaited<ReturnType<typeof renderScreen>>) {
  if (!screen.frame().includes("Message BTW…")) {
    screen.input.pressKey("c", { ctrl: true })
    await waitFor(() => screen.frame().includes("Message BTW…"), "empty BTW composer")
  }
  const promptRow = screen.lines().findIndex((line) => line.includes("Message BTW…"))
  expect(promptRow).toBeGreaterThan(-1)
  await screen.mouse.click(3, promptRow)
  return promptRow
}

async function clearBtwDraft(screen: Awaited<ReturnType<typeof renderScreen>>) {
  descendants(screen.renderer.root)
    .filter((item): item is TextareaRenderable => item instanceof TextareaRenderable)
    .forEach((textarea) => textarea.clear())
}

function descendants(root: Renderable): Renderable[] {
  return [root, ...root.getChildren().flatMap(descendants)]
}

test("mounts one ordinary composer only for the root and BTW child across collapsed and expanded layouts", async () => {
  const rootFixture = fixture()
  const root = await renderScreen({ width: 120, height: 40, args: { sessionID: parentID }, route: rootFixture.route, settle: "Message YCoding…" })
  try {
    expect(root.frame().match(/Message YCoding…/g)).toHaveLength(1)
  } finally {
    await root.dispose()
  }

  const ordinaryFixture = fixture()
  const ordinaryScreen = await renderScreen({
    width: 120,
    height: 40,
    args: { sessionID: ordinaryID },
    route: ordinaryFixture.route,
    settle: "REVIEWER SUBAGENT",
  })
  try {
    expect(ordinaryScreen.frame()).not.toContain("Message YCoding…")
    expect(ordinaryScreen.frame()).not.toContain("Message BTW…")
  } finally {
    await ordinaryScreen.dispose()
  }

  const btwFixture = fixture()
  const btwScreen = await renderScreen({
    width: 120,
    height: 40,
    args: { sessionID: btwID },
    route: btwFixture.route,
    settle: "BTW SIDE CHAT",
  })
  try {
    expect(btwScreen.frame().match(/Message BTW…/g)).toHaveLength(1)
    btwScreen.input.pressKey("ARROW_DOWN")
    await waitFor(() => btwScreen.frame().includes("Subagents"), "expanded BTW composer")
    expect(btwScreen.frame().match(/Message BTW…/g)).toHaveLength(1)
  } finally {
    await btwScreen.dispose()
  }
}, 120_000)

test.each(["high", undefined])("keeps repeated ordinary BTW messages on the read-only child agent and model (variant %s)", async (variant) => {
  const state = fixture({ variant })
  const screen = await renderScreen({
    width: 120,
    height: 40,
    args: { sessionID: btwID },
    route: state.route,
    settle: "BTW SIDE CHAT",
  })
  try {
    await focusEmptyBtwComposer(screen)
    await screen.input.typeText("first side question")
    screen.input.pressEnter()
    await waitFor(() => state.prompts.filter((request) => request.sessionID === btwID).length === 2, "first BTW admission and wake")
    await waitFor(() => screen.frame().includes("Message BTW…"), "cleared BTW composer")

    const secondPromptRow = screen.lines().findIndex((line) => line.includes("Message BTW…"))
    await screen.mouse.click(3, secondPromptRow)
    await screen.input.typeText("second side question")
    screen.input.pressEnter()
    await waitFor(() => state.prompts.filter((request) => request.sessionID === btwID).length === 4, "second BTW admission and wake")

    const childPrompts = state.prompts.filter((request) => request.sessionID === btwID)
    expect(childPrompts.map((request) => request.body.text)).toEqual([
      "first side question",
      "first side question",
      "second side question",
      "second side question",
    ])
    expect(new Set(childPrompts.slice(0, 2).map((request) => request.body.id)).size).toBe(1)
    expect(new Set(childPrompts.slice(2).map((request) => request.body.id)).size).toBe(1)
    expect(childPrompts[0]?.body.id).not.toBe(childPrompts[2]?.body.id)
    expect(state.prompts.some((request) => request.sessionID === parentID)).toBe(false)
    expect(state.switches).toEqual([])
    expect(state.generates).toEqual([])
    expect(state.interrupts).toEqual([])
  } finally {
    await clearBtwDraft(screen)
    await screen.dispose()
  }
}, 120_000)

test("opens an editable immediate-parent export preview and cancellation preserves the BTW draft", async () => {
  const state = fixture()
  const screen = await renderScreen({
    width: 120,
    height: 40,
    args: { sessionID: btwID },
    route: state.route,
    settle: "BTW SIDE CHAT",
  })
  try {
    await focusEmptyBtwComposer(screen)
    await screen.input.typeText("/btw-send keep this draft")
    screen.input.pressEnter()
    await waitFor(() => screen.frame().includes("Send to Main implementation"), "BTW export preview")
    expect(screen.frame()).toContain("Destination: Main implementation")
    expect(screen.frame()).toContain("Source: Investigate the side issue")
    screen.input.pressKey("ESCAPE")
    await waitFor(
      () =>
        !screen.frame().includes("Destination: Main implementation") &&
        screen.frame().includes("/btw-send keep this draft"),
      "closed export preview with restored BTW draft",
    )
    expect(state.prompts.filter((request) => request.sessionID === parentID)).toEqual([])
    expect(state.generates).toEqual([])
    expect(state.interrupts).toEqual([])
  } finally {
    await clearBtwDraft(screen)
    await screen.dispose()
  }
}, 120_000)

test("prevents an empty reviewed parent export", async () => {
  const state = fixture()
  const screen = await renderScreen({
    width: 120,
    height: 40,
    args: { sessionID: btwID },
    route: state.route,
    settle: "BTW SIDE CHAT",
  })
  try {
    await focusEmptyBtwComposer(screen)
    await screen.input.typeText("/btw-send ")
    screen.input.pressEnter()
    await waitFor(() => screen.frame().includes("Send to Main implementation"), "empty BTW export preview")
    screen.input.pressEnter()
    await waitFor(() => screen.frame().includes("Export text is required"), "empty export validation")
    expect(screen.frame()).toContain("Send to Main implementation")
    expect(state.prompts.filter((request) => request.sessionID === parentID)).toEqual([])
  } finally {
    await clearBtwDraft(screen)
    await screen.dispose()
  }
}, 120_000)

test("sends exact reviewed text to the immediate parent as one stable steer and stays in BTW", async () => {
  const state = fixture()
  const screen = await renderScreen({
    width: 120,
    height: 40,
    args: { sessionID: btwID },
    route: state.route,
    settle: "BTW SIDE CHAT",
  })
  try {
    await focusEmptyBtwComposer(screen)
    await screen.input.typeText("/btw-send Use the narrow fix")
    screen.input.pressEnter()
    await waitFor(() => screen.frame().includes("Send to Main implementation"), "BTW export preview")
    await screen.input.typeText(" exactly")
    screen.input.pressEnter()
    await waitFor(() => state.prompts.filter((request) => request.sessionID === parentID).length === 1, "parent steer")

    const exports = state.prompts.filter((request) => request.sessionID === parentID)
    expect(exports).toHaveLength(1)
    expect(exports[0]?.body).toMatchObject({ text: "Use the narrow fix exactly", delivery: "steer" })
    expect(exports[0]?.body.id).toMatch(/^msg_/)
    await waitFor(() => !screen.frame().includes("Destination: Main implementation"), "closed export preview")
    expect(screen.frame()).toContain("Side-chat context loaded.")
    expect(state.prompts.some((request) => request.sessionID === ordinaryID)).toBe(false)
    expect(state.generates).toEqual([])
    expect(state.interrupts).toEqual([])
  } finally {
    await clearBtwDraft(screen)
    await screen.dispose()
  }
}, 120_000)

test("retries a failed reviewed export with the exact same parent message id", async () => {
  const state = fixture()
  state.failNextParentPrompt()
  const screen = await renderScreen({
    width: 120,
    height: 40,
    args: { sessionID: btwID },
    route: state.route,
    settle: "BTW SIDE CHAT",
  })
  try {
    await focusEmptyBtwComposer(screen)
    await screen.input.typeText("/btw-send Retain this export")
    screen.input.pressEnter()
    await waitFor(() => screen.frame().includes("Send to Main implementation"), "BTW export preview")
    screen.input.pressEnter()
    await waitFor(() => screen.frame().includes("Failed to send to Main implementation"), "failed parent steer")
    screen.input.pressEnter()
    await waitFor(() => state.prompts.filter((request) => request.sessionID === parentID).length === 2, "retried parent steer")

    const exports = state.prompts.filter((request) => request.sessionID === parentID)
    expect(exports.map((request) => request.body.text)).toEqual(["Retain this export", "Retain this export"])
    expect(new Set(exports.map((request) => request.body.id)).size).toBe(1)
    expect(exports.every((request) => request.body.delivery === "steer")).toBe(true)
  } finally {
    await clearBtwDraft(screen)
    await screen.dispose()
  }
}, 120_000)
