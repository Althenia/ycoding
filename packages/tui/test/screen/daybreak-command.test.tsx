/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { ModelDaybreak, YCodingEvent } from "@ycoding-ai/client"
import { json, type FetchHandler } from "../fixture/tui-client"
import { renderScreen } from "./harness"

// Distinct Location and Session from every other screen suite so the shared module mocks
// installed by renderScreen cannot collide with a concurrent lane.
const sessionID = "ses_daybreak_command"
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
let sessionDaybreak: ModelDaybreak | undefined
let daybreakSets: Array<{ daybreak: ModelDaybreak | null }> = []
let promptRequests: Array<{ id: string; text: string }> = []
let eventSeq = 0

function resetFixture(input: { advertised: ModelDaybreak[]; daybreak?: ModelDaybreak }) {
  advertised = input.advertised
  sessionDaybreak = input.daybreak
  daybreakSets = []
  promptRequests = []
  eventSeq = 0
}

const route: FetchHandler = async (url, request) => {
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [{ ...baseSession, daybreak: sessionDaybreak }], cursor: {} })
  if (url.pathname === "/api/session/active") return json({ data: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: { ...baseSession, daybreak: sessionDaybreak } })
  if (url.pathname === `/api/session/${sessionID}/daybreak` && request.method === "POST") {
    const body = (await request.json()) as { daybreak: ModelDaybreak | null }
    daybreakSets.push(body)
    sessionDaybreak = body.daybreak === null ? undefined : body.daybreak
    return json({ data: { ...baseSession, daybreak: sessionDaybreak } })
  }
  if (url.pathname === `/api/session/${sessionID}/autonomy`) return json({ data: { mode: "normal", yolo: 0 } })
  if (url.pathname === `/api/session/${sessionID}/model` && request.method === "POST") {
    return new Response(null, { status: 204 })
  }
  if (url.pathname === `/api/session/${sessionID}/prompt` && request.method === "POST") {
    const body = (await request.json()) as { id: string; text: string }
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
        {
          id: baseSession.model.id,
          modelID: baseSession.model.id,
          providerID: baseSession.model.providerID,
          name: "GPT 5.6 Terra",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          variants: [{ id: baseSession.model.variant }, { id: "low" }],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          ...(advertised.length > 0 ? { daybreak: advertised } : {}),
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

type Screen = Awaited<ReturnType<typeof renderScreen>>

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

function boot(advertisedPrograms: ModelDaybreak[], daybreak?: ModelDaybreak) {
  resetFixture({ advertised: advertisedPrograms, daybreak })
  return renderScreen({ width: 120, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
}

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
