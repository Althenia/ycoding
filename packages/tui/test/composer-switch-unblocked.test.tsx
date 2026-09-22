/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { json } from "./fixture/tui-client"
import { renderScreen } from "./screen/harness"

const sessionID = "ses_composer_switch"
const directory = "/tmp/ycoding/composer-switch"
const location = { directory, project: { id: "proj_composer_switch", directory } }
const session = {
  id: sessionID,
  title: "Composer switch",
  projectID: "proj_composer_switch",
  location: { directory },
  agent: "build",
  model: { providerID: "openai", id: "gpt-5.6-terra", variant: "high" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}
const model = {
  id: "gpt-5.6-terra",
  modelID: "gpt-5.6-terra",
  providerID: "openai",
  name: "GPT 5.6 Terra",
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [{ id: "high" }, { id: "low" }],
  time: { released: 0 },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 200_000, output: 32_000 },
}

/** Admissions only: one send posts an admission and then a resume for the same message. */
const admitted: string[] = []
const resumed: string[] = []
let switchStarted = false
let releaseSwitch!: () => void
let switchGate: Promise<void> | undefined

async function route(url: URL, request: Request) {
  if (url.pathname === "/api/location") return json(location)
  // The bug only occurs while a drain owns the Session: the switch waits for that drain's boundary.
  if (url.pathname === "/api/session/active") return json({ data: { [sessionID]: {} } })
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/prompt` && request.method === "POST") {
    const body = promptBody(await request.json())
    if (!body) return json({ error: "invalid prompt" }, { status: 400 })
    if (body.resume) resumed.push(body.text)
    else admitted.push(body.text)
    return json({
      data: {
        id: `msg_admitted_${admitted.length}`,
        sessionID,
        admittedSeq: admitted.length,
        timeCreated: Date.now(),
        type: "user",
        data: { text: body.text, files: [] },
        delivery: "steer",
      },
    })
  }
  if (url.pathname === `/api/session/${sessionID}/model` && request.method === "POST") {
    switchStarted = true
    if (switchGate) await switchGate
    return new Response(null, { status: 204 })
  }
  if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}/subagent`)
    return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
  if (url.pathname === `/api/session/${sessionID}/guardrail`)
    return json({
      data: { rootSessionID: sessionID, profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [] },
    })
  if (url.pathname === `/api/session/${sessionID}/diagnostics`)
    return json({
      data: {
        model: session.model,
        context: { total: 0, percent: 0 },
        tokens: { uncachedInput: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cache: { eligible: 0, hitRatio: 0, mechanism: "unreported", readReported: false, writeReported: false },
        requests: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: session.tokens },
      },
    })
  if (url.pathname === "/api/model") return json({ location, data: [model] })
  if (url.pathname === "/api/provider") return json({ location, data: [{ id: "openai", name: "OpenAI" }] })
  if (url.pathname === "/api/agent")
    return json({
      location,
      data: [{ id: "build", name: "Build", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] }],
    })
  if (url.pathname === "/api/skill") return json({ location, data: [] })
  if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
  if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
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
  return undefined
}

function promptBody(value: unknown): { text: string; resume?: boolean } | undefined {
  if (typeof value !== "object" || value === null) return undefined
  if (!("text" in value) || typeof value.text !== "string") return undefined
  return { text: value.text, ...("resume" in value && typeof value.resume === "boolean" ? { resume: value.resume } : {}) }
}

async function waitForFrameText(screen: { frame(): string }, text: string, attempts = 150) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (screen.frame().includes(text)) return true
    await Bun.sleep(20)
  }
  return screen.frame().includes(text)
}

async function waitForSwitchStart(screen: { frame(): string }) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (switchStarted) return
    await Bun.sleep(20)
  }
  expect(screen.frame()).toContain("switch")
}

async function typeAndSend(screen: Awaited<ReturnType<typeof renderScreen>>, text: string) {
  const promptRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
  expect(promptRow).toBeGreaterThan(-1)
  await screen.mouse.click(3, promptRow)
  await screen.input.typeText(text)
  screen.input.pressEnter()
}

test("steers immediately by interrupting the active step before the wake", async () => {
  admitted.length = 0
  resumed.length = 0
  switchStarted = false
  switchGate = undefined
  const interrupts: string[] = []
  const calls: string[] = []
  async function steerRoute(url: URL, request: Request) {
    if (url.pathname === "/api/session/active") return json({ data: { [sessionID]: {} } })
    if (url.pathname === `/api/session/${sessionID}/interrupt` && request.method === "POST") {
      interrupts.push(sessionID)
      calls.push("interrupt")
      return new Response(null, { status: 204 })
    }
    if (url.pathname === `/api/session/${sessionID}/prompt` && request.method === "POST") {
      const body = promptBody(await request.json())
      if (!body) return json({ error: "invalid prompt" }, { status: 400 })
      calls.push(body.resume ? "resume" : "admit")
      if (body.resume) resumed.push(body.text)
      else admitted.push(body.text)
      return json({
        data: {
          id: `msg_admitted_${admitted.length}`,
          sessionID,
          admittedSeq: admitted.length,
          timeCreated: Date.now(),
          type: "user",
          data: { text: body.text, files: [] },
          delivery: "steer",
        },
      })
    }
    return route(url, request)
  }
  const screen = await renderScreen({
    width: 110,
    height: 45,
    args: { sessionID },
    route: steerRoute,
    kittyKeyboard: true,
    settle: "Message YCoding…",
  })
  try {
    const promptRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, promptRow)
    await screen.input.typeText("stop and read this")
    screen.input.pressKey("p", { ctrl: true })
    await waitForFrameText(screen, "COMMANDS")
    await screen.input.typeText("steer")
    await waitForFrameText(screen, "steer now")
    screen.input.pressEnter()
    for (let attempt = 0; attempt < 150 && !calls.includes("resume"); attempt++) await Bun.sleep(20)
    expect(admitted).toEqual(["stop and read this"])
    expect(interrupts).toEqual([sessionID])
    // The step must end before the wake, or the admitted steer still waits for the running step.
    expect(calls).toEqual(["admit", "interrupt", "resume"])
  } finally {
    switchGate = undefined
    await screen.dispose()
  }
}, 30_000)

test("holds the composer behind an awaited model switch and admits on the selected variant", async () => {
  admitted.length = 0
  resumed.length = 0
  switchStarted = false
  switchGate = new Promise<void>((resolve) => (releaseSwitch = resolve))
  const screen = await renderScreen({ width: 110, height: 45, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    let promptRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, promptRow)
    await screen.input.typeText("/variants")
    screen.input.pressEnter()
    await waitForFrameText(screen, "Select variant")
    screen.input.pressKey("ARROW_DOWN")
    screen.input.pressEnter()
    await waitForFrameText(screen, "Message YCoding…")

    await typeAndSend(screen, "steer on the selected variant")
    await waitForSwitchStart(screen)
    expect(switchStarted).toBe(true)
    // The approved ordering is switch -> admit -> resume. Nothing is admitted while the switch is
    // still in flight.
    expect(admitted).toEqual([])

    releaseSwitch?.()
    for (let attempt = 0; attempt < 150 && admitted.length < 1; attempt++) await Bun.sleep(20)
    expect(admitted).toEqual(["steer on the selected variant"])
  } finally {
    releaseSwitch?.()
    switchGate = undefined
    await screen.dispose()
  }
}, 30_000)
