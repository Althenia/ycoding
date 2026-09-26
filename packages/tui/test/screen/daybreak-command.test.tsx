/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { ModelDaybreak, ModelRef, SessionCreateInput, SessionMessageModelSelected, YCodingEvent } from "@ycoding-ai/client"
import { json, type FetchHandler } from "../fixture/tui-client"
import { renderScreen } from "./harness"

// Distinct Location and Session from every other screen suite so the shared module mocks
// installed by renderScreen cannot collide with a concurrent lane.
let sessionID = "ses_daybreak_command"
const directory = "/tmp/ycoding/daybreak-command"
const location = { directory, project: { id: "proj_daybreak_command", directory } }
const baseSession = {
  id: sessionID,
  title: "Daybreak command",
  projectID: "proj_daybreak_command",
  location: { directory },
  agent: "build",
  model: { providerID: "openai", id: "gpt-5.6-terra", variant: "high" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}

let advertised: ModelDaybreak[] = []
let sessionModel: ModelRef = baseSession.model
let sessionDaybreak: ModelDaybreak | undefined
let daybreakSets: Array<{ daybreak: ModelDaybreak | null }> = []
let promptRequests: Array<{ id: string; text: string; resume?: boolean }> = []
let eventSeq = 0
const modelMessages = new Map<string, SessionMessageModelSelected>()
let sessionExists = true
let failDaybreak = false
let mutations: string[] = []
let createdIDs: string[] = []

function resetFixture(input: { advertised: ModelDaybreak[]; daybreak?: ModelDaybreak; landing?: boolean }) {
  sessionID = baseSession.id
  sessionExists = !input.landing
  failDaybreak = false
  mutations = []
  createdIDs = []
  advertised = input.advertised
  sessionModel = baseSession.model
  sessionDaybreak = input.daybreak
  daybreakSets = []
  promptRequests = []
  eventSeq = 0
  modelMessages.clear()
}

function sessionInfo() {
  return { ...baseSession, id: sessionID, model: sessionModel, daybreak: sessionDaybreak }
}

const route: FetchHandler = async (url, request) => {
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session" && request.method === "POST") {
    const body = await request.json() as SessionCreateInput
    sessionID = body.id ?? "ses_daybreak_landing_goal"
    sessionModel = body.model ?? baseSession.model
    sessionExists = true
    createdIDs.push(sessionID)
    mutations.push("create")
    return json({ data: sessionInfo() })
  }
  if (url.pathname === "/api/session") return json({ data: sessionExists ? [sessionInfo()] : [], cursor: {} })
  if (url.pathname === "/api/session/active") return json({ data: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: sessionInfo() })
  if (url.pathname === `/api/session/${sessionID}/daybreak` && request.method === "POST") {
    const body = (await request.json()) as { daybreak: ModelDaybreak | null }
    daybreakSets.push(body)
    mutations.push("daybreak")
    if (failDaybreak) return new Response("Daybreak selection failed", { status: 500 })
    sessionDaybreak = body.daybreak === null ? undefined : body.daybreak
    return json({ data: sessionInfo() })
  }
  if (url.pathname === `/api/session/${sessionID}/autonomy` && request.method === "PUT") {
    mutations.push("goal")
    return json({ data: { mode: "normal", yolo: 0 } })
  }
  if (url.pathname === `/api/session/${sessionID}/autonomy`) return json({ data: { mode: "normal", yolo: 0 } })
  if (url.pathname === `/api/session/${sessionID}/model` && request.method === "POST") {
    return new Response(null, { status: 204 })
  }
  if (url.pathname === `/api/session/${sessionID}/prompt` && request.method === "POST") {
    const body = (await request.json()) as { id: string; text: string; resume?: boolean }
    promptRequests.push(body)
    mutations.push(body.resume === false ? "admit" : "wake")
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
  if (url.pathname.startsWith(`/api/session/${sessionID}/message/`))
    return json({ data: modelMessages.get(url.pathname.split("/").at(-1)!) })
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
        model: baseSession.model,
        context: { total: 0, percent: 0 },
        tokens: { uncachedInput: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cache: { eligible: 0, hitRatio: 0.61, mechanism: "unreported", readReported: false, writeReported: false },
        requests: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: baseSession.tokens },
      },
    })
  if (url.pathname === `/api/session/${sessionID}/usage`)
    return json({ data: { logical: 0, physical: 0, continued: 0, helpers: 0, fallback: 0, cost: 0, tokens: baseSession.tokens } })
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
        { ...baseSession.model, name: "GPT 5.6 Terra", daybreak: advertised },
        ...unsupportedModels,
      ].map((model) => ({
        id: model.id,
        modelID: model.id,
        providerID: model.providerID,
        name: model.name,
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        variants: [{ id: baseSession.model.variant }, { id: "low" }],
        time: { released: 0 },
        cost: [],
        status: "active",
        enabled: true,
        ...("daybreak" in model && model.daybreak.length > 0 ? { daybreak: model.daybreak } : {}),
        limit: { context: 200_000, output: 32_000 },
      })),
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

type Screen = Awaited<ReturnType<typeof renderScreen>>

const unsupportedModels = [
  { providerID: "openai", id: "gpt-6-astra", name: "GPT 6 Astra" },
  { providerID: "openrouter", id: "openai/gpt-6-luna", name: "GPT 6 Luna" },
  { providerID: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
  { providerID: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat" },
]

async function waitUntil(screen: Screen, predicate: () => boolean, label: string) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (predicate()) return
    await Bun.sleep(20)
  }
  throw new Error(
    `timed out waiting for ${label}; sets=${JSON.stringify(daybreakSets)} prompts=${JSON.stringify(promptRequests)}`,
  )
}

async function focusComposer(screen: Screen) {
  const row = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
  expect(row).toBeGreaterThan(-1)
  await screen.mouse.click(3, row)
}

/** A trailing space hides the slash menu, so Enter reaches the composer's slash dispatch. */
async function submitDaybreak(screen: Screen, argument?: string) {
  await focusComposer(screen)
  await screen.input.typeText(argument === undefined ? "/daybreak " : `/daybreak ${argument}`)
  screen.input.pressEnter()
}

function emitDaybreak(screen: Screen, daybreak?: ModelDaybreak) {
  eventSeq += 1
  screen.events.emit({
    id: `evt_daybreak_${eventSeq}`,
    created: eventSeq,
    type: "session.daybreak.set",
    durable: { aggregateID: sessionID, seq: eventSeq, version: 1 },
    data: { sessionID, ...(daybreak === undefined ? {} : { daybreak }) },
    location: { directory },
  } satisfies YCodingEvent)
}

function emitModel(screen: Screen, model: typeof baseSession.model) {
  const previous = sessionModel
  sessionModel = model
  eventSeq += 1
  const messageID = `msg_daybreak_model_${eventSeq}`
  modelMessages.set(messageID, { id: messageID, type: "model-switched", model, previous, time: { created: eventSeq } })
  screen.events.emit({
    id: `evt_daybreak_model_${eventSeq}`,
    created: eventSeq,
    type: "session.model.selected",
    durable: { aggregateID: sessionID, seq: eventSeq, version: 1 },
    data: { sessionID, model },
    location: { directory },
  } satisfies YCodingEvent)
}

/** Syncs on the durable patch by reading the palette's reactive title, then closes it. */
async function expectPaletteTitle(screen: Screen, title: string) {
  screen.input.pressKey("p", { ctrl: true })
  await waitUntil(screen, () => screen.frame().includes("Commands") || screen.frame().includes("COMMANDS"), "palette")
  await screen.input.typeText("daybreak")
  await waitUntil(screen, () => screen.frame().includes(title), `palette title "${title}"`)
  screen.input.pressKey("ESCAPE")
  await waitUntil(
    screen,
    () => !screen.frame().includes("Commands") && !screen.frame().includes("COMMANDS"),
    "palette closed",
  )
}

async function boot(advertisedPrograms: ModelDaybreak[], daybreak?: ModelDaybreak, landing = false) {
  resetFixture({ advertised: advertisedPrograms, daybreak, landing })
  const screen = await renderScreen({ width: 120, height: 69, args: landing ? {} : { sessionID }, route, settle: "Message YCoding…" })
  await waitUntil(screen, () => screen.lines()[1].includes("openai/GPT 5.6 Terra"), "the resolved model").catch(async (error) => {
    await screen.dispose()
    throw error
  })
  return screen
}

test("toggles Daybreak from the landing palette and slash command without creating a Session", async () => {
  const screen = await boot(["daybreak_blue", "daybreak_red"], undefined, true)
  try {
    screen.input.pressKey("p", { ctrl: true })
    await waitUntil(screen, () => screen.frame().includes("Commands"), "the landing palette")
    await screen.input.typeText("daybreak")
    await waitUntil(screen, () => screen.frame().includes("Daybreak: off"), "the Daybreak option")
    screen.input.pressEnter()
    await waitUntil(screen, () => screen.lines()[1].includes("Daybreak Blue"), "the landing blue indicator")
    expect(screen.frame()).toContain("What should we build?")

    await submitDaybreak(screen, "red")
    await waitUntil(screen, () => screen.lines()[1].includes("Daybreak Red"), "the landing red indicator")
    await expectPaletteTitle(screen, "Daybreak: red (cycle off→blue→red, /daybreak blue|red|off)")
    await submitDaybreak(screen, "off")
    await waitUntil(screen, () => screen.frame().includes("Daybreak disabled"), "the landing off toast")
    expect(screen.lines()[1]).not.toContain("Daybreak")
    expect(mutations).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("saves landing Daybreak before the first prompt and rehydrates its Session indicator", async () => {
  const screen = await boot(["daybreak_blue"], undefined, true)
  try {
    await submitDaybreak(screen, "blue")
    await waitUntil(screen, () => screen.lines()[1].includes("Daybreak Blue"), "the landing indicator")
    await focusComposer(screen)
    await screen.input.typeText("Check the application")
    screen.input.pressEnter()
    await waitUntil(
      screen,
      () => mutations.includes("wake") && !screen.frame().includes("What should we build?") && screen.lines()[1].includes("Daybreak Blue"),
      "the new Session",
    )
    expect(mutations).toEqual(["create", "daybreak", "admit", "wake"])
    expect(daybreakSets).toEqual([{ daybreak: "daybreak_blue" }])
    expect(promptRequests).toMatchObject([
      { text: "Check the application", resume: false },
      { text: "Check the application", resume: true },
    ])
    expect(promptRequests[1].id).toBe(promptRequests[0].id)
    expect(screen.lines()[1]).toContain("Daybreak Blue")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("retains the landing draft and retries the same Session when saving Daybreak fails", async () => {
  const screen = await boot(["daybreak_blue"], undefined, true)
  try {
    await submitDaybreak(screen, "blue")
    await waitUntil(screen, () => screen.lines()[1].includes("Daybreak Blue"), "the landing indicator")
    failDaybreak = true
    await focusComposer(screen)
    await screen.input.typeText("Check the application")
    screen.input.pressEnter()
    await waitUntil(screen, () => screen.frame().includes("Daybreak selection failed · draft retained"), "the failure")
    expect(screen.frame()).toContain("Check the application")
    expect(screen.frame()).toContain("What should we build?")
    expect(promptRequests).toEqual([])
    const created = createdIDs[0]

    failDaybreak = false
    screen.input.pressEnter()
    await waitUntil(
      screen,
      () => mutations.includes("wake") && !screen.frame().includes("What should we build?") && screen.lines()[1].includes("Daybreak Blue"),
      "the retried Session",
    )
    expect(createdIDs).toEqual([created])
    expect(mutations).toEqual(["create", "daybreak", "daybreak", "admit", "wake"])
    expect(promptRequests).toHaveLength(2)
    expect(promptRequests[1].id).toBe(promptRequests[0].id)
    expect(sessionDaybreak).toBe("daybreak_blue")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("rejects unsupported landing Daybreak without starting a Session", async () => {
  const screen = await boot([], undefined, true)
  try {
    await submitDaybreak(screen, "blue")
    await waitUntil(screen, () => screen.frame().includes("Daybreak blue is not available for this model"), "the rejection")
    expect(screen.lines()[1]).not.toContain("Daybreak")
    expect(mutations).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("applies landing Daybreak before an explicit goal starts the new Session", async () => {
  const screen = await boot(["daybreak_blue"], undefined, true)
  try {
    await submitDaybreak(screen, "blue")
    await waitUntil(screen, () => screen.lines()[1].includes("Daybreak Blue"), "the landing indicator")
    await focusComposer(screen)
    await screen.input.typeText("/goal Check the application")
    screen.input.pressEnter()
    await waitUntil(
      screen,
      () => mutations.includes("goal") && !screen.frame().includes("What should we build?") && screen.lines()[1].includes("Daybreak Blue"),
      "the goal Session",
    )
    expect(mutations).toEqual(["create", "daybreak", "goal"])
    expect(sessionDaybreak).toBe("daybreak_blue")
    expect(promptRequests).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("does not activate a landing goal when Daybreak persistence fails", async () => {
  const screen = await boot(["daybreak_blue"], undefined, true)
  try {
    await submitDaybreak(screen, "blue")
    await waitUntil(screen, () => screen.lines()[1].includes("Daybreak Blue"), "the landing indicator")
    failDaybreak = true
    await focusComposer(screen)
    await screen.input.typeText("/goal Check the application")
    screen.input.pressEnter()
    await waitUntil(screen, () => screen.frame().includes("Failed to create a session with the goal"), "the goal failure")
    expect(mutations).toEqual(["create", "daybreak"])
    expect(screen.frame()).toContain("/goal Check the application")
    expect(screen.frame()).toContain("What should we build?")
    expect(promptRequests).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("lists the Daybreak command in the palette with the Session's current state", async () => {
  const screen = await boot(["daybreak_blue", "daybreak_red"], "daybreak_blue")
  try {
    await screen.waitForEventStream()
    await expectPaletteTitle(screen, "Daybreak: blue (cycle off→blue→red, /daybreak blue|red|off)")

    emitDaybreak(screen, "daybreak_red")
    await expectPaletteTitle(screen, "Daybreak: red (cycle off→blue→red, /daybreak blue|red|off)")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("rehydrates and updates the header indicator from durable Daybreak state", async () => {
  const screen = await boot(["daybreak_blue", "daybreak_red"], "daybreak_blue")
  try {
    await screen.waitForEventStream()
    expect(screen.lines()[1]).toContain("openai/GPT 5.6 Terra · Daybreak Blue · high")

    emitDaybreak(screen, "daybreak_red")
    await waitUntil(screen, () => screen.lines()[1].includes("Daybreak Red"), "the red indicator")
    expect(screen.lines()[1]).toContain("openai/GPT 5.6 Terra · Daybreak Red · high")

    emitDaybreak(screen)
    await expectPaletteTitle(screen, "Daybreak: off (cycle off→blue→red, /daybreak blue|red|off)")
    expect(screen.lines()[1]).not.toContain("Daybreak")
    expect(daybreakSets).toEqual([])
    expect(promptRequests).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("marks a saved Daybreak program inactive on a model that does not advertise it", async () => {
  const screen = await boot([], "daybreak_blue")
  try {
    expect(screen.lines()[1]).toContain("openai/GPT 5.6 Terra · Daybreak Blue (inactive)")
    expect(daybreakSets).toEqual([])
    expect(promptRequests).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("keeps Daybreak inactive on unsupported models and providers, and restores it on the supported model", async () => {
  const screen = await boot(["daybreak_blue"], "daybreak_blue")
  try {
    await screen.waitForEventStream()
    for (const model of unsupportedModels) {
      emitModel(screen, { providerID: model.providerID, id: model.id, variant: "high" })
      await waitUntil(
        screen,
        () => screen.lines()[1].includes(`${model.providerID}/${model.name} · Daybreak Blue (inactive)`),
        `the inactive ${model.providerID}/${model.id} indicator`,
      )
    }
    emitModel(screen, baseSession.model)
    await waitUntil(
      screen,
      () => screen.lines()[1].includes("openai/GPT 5.6 Terra · Daybreak Blue · high"),
      "the restored indicator",
    )
    expect(sessionDaybreak).toBe("daybreak_blue")
    expect(daybreakSets).toEqual([])
    expect(promptRequests).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("refreshes Daybreak activity when the account's advertised programs change", async () => {
  const screen = await boot(["daybreak_blue"], "daybreak_blue")
  try {
    await screen.waitForEventStream()
    const programSets: ModelDaybreak[][] = [[], ["daybreak_blue"]]
    for (const programs of programSets) {
      advertised = programs
      eventSeq += 1
      screen.events.emit({
        id: `evt_daybreak_catalog_${eventSeq}`,
        type: "catalog.updated",
        created: eventSeq,
        data: {},
        location: { directory },
      } satisfies YCodingEvent)
      await waitUntil(
        screen,
        () => screen.lines()[1].includes(programs.includes("daybreak_blue")
          ? "Daybreak Blue · high"
          : "Daybreak Blue (inactive)"),
        "the refreshed catalog indicator",
      )
    }
    expect(sessionDaybreak).toBe("daybreak_blue")
    expect(daybreakSets).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("cycles off → blue → red → off across the advertised programs", async () => {
  const screen = await boot(["daybreak_blue", "daybreak_red"])
  try {
    await screen.waitForEventStream()

    await submitDaybreak(screen)
    await waitUntil(screen, () => daybreakSets.length === 1, "the blue payload")
    expect(daybreakSets).toEqual([{ daybreak: "daybreak_blue" }])
    await waitUntil(screen, () => screen.frame().includes("Daybreak blue enabled"), "the blue toast")

    emitDaybreak(screen, "daybreak_blue")
    await expectPaletteTitle(screen, "Daybreak: blue (cycle off→blue→red, /daybreak blue|red|off)")

    await submitDaybreak(screen)
    await waitUntil(screen, () => daybreakSets.length === 2, "the red payload")
    expect(daybreakSets[1]).toEqual({ daybreak: "daybreak_red" })
    await waitUntil(screen, () => screen.frame().includes("Daybreak red enabled"), "the red toast")

    emitDaybreak(screen, "daybreak_red")
    await expectPaletteTitle(screen, "Daybreak: red (cycle off→blue→red, /daybreak blue|red|off)")

    await submitDaybreak(screen)
    await waitUntil(screen, () => daybreakSets.length === 3, "the clear payload")
    expect(daybreakSets[2]).toEqual({ daybreak: null })
    await waitUntil(screen, () => screen.frame().includes("Daybreak disabled"), "the clear toast")

    expect(promptRequests).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("cycles a red-only model off → red → off", async () => {
  const screen = await boot(["daybreak_red"])
  try {
    await screen.waitForEventStream()

    await submitDaybreak(screen)
    await waitUntil(screen, () => daybreakSets.length === 1, "the red payload")
    expect(daybreakSets).toEqual([{ daybreak: "daybreak_red" }])

    emitDaybreak(screen, "daybreak_red")
    await expectPaletteTitle(screen, "Daybreak: red (cycle off→blue→red, /daybreak blue|red|off)")

    await submitDaybreak(screen)
    await waitUntil(screen, () => daybreakSets.length === 2, "the clear payload")
    expect(daybreakSets[1]).toEqual({ daybreak: null })
    expect(promptRequests).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("reports Daybreak as unavailable when the model advertises no program", async () => {
  const screen = await boot([])
  try {
    await submitDaybreak(screen)
    await waitUntil(screen, () => screen.frame().includes("Daybreak is not available for this model"), "the toast")
    expect(daybreakSets).toEqual([])
    expect(promptRequests).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("rejects an explicit program the active model does not advertise", async () => {
  const screen = await boot(["daybreak_red"])
  try {
    await submitDaybreak(screen, "blue")
    await waitUntil(
      screen,
      () => screen.frame().includes("Daybreak blue is not available for this model"),
      "the error toast",
    )
    expect(daybreakSets).toEqual([])
    expect(promptRequests).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("clears the program with an explicit off argument", async () => {
  const screen = await boot(["daybreak_blue"], "daybreak_blue")
  try {
    await submitDaybreak(screen, "off")
    await waitUntil(screen, () => daybreakSets.length === 1, "the clear payload")
    expect(daybreakSets).toEqual([{ daybreak: null }])
    expect(promptRequests).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)
