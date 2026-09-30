/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { ModelInfo, ModelRef, YCodingEvent } from "@ycoding-ai/client"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { json } from "./fixture/tui-client"
import { renderScreen } from "./screen/harness"
import { isRecord } from "../src/util/record"

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
  expect(await waitForFrameText(screen, text)).toBe(true)
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

async function renderModelAuthority(input: { state: string; initial?: ModelRef; unselected?: boolean }) {
  const state = path.resolve("../../.cache/tui-model-authority", input.state)
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "model.json"), JSON.stringify({ recent: [], favorite: [], variant: {} }))
  let selected: ModelRef | undefined = input.unselected ? undefined : input.initial ?? session.model
  let seq = 0
  const switches: ModelRef[] = []
  const prompts: { resume?: boolean; model: ModelRef | undefined }[] = []
  const plain: ModelInfo = { ...model, id: "model-without-effort", modelID: "model-without-effort", name: "Plain model", variants: [], status: "active" }
  const projected = new Map<string, unknown>()
  const screen = await renderScreen({ width: 120, height: 45, state, args: { sessionID }, settle: "Message YCoding…", route: async (url, request) => {
    if (url.pathname === "/api/session/active") return json({ data: {} })
    if (url.pathname === "/api/session") return json({ data: [{ ...session, model: selected }], cursor: {} })
    if (url.pathname === `/api/session/${sessionID}`) return json({ data: { ...session, model: selected } })
    if (url.pathname === "/api/model") return json({ location, data: [{ ...model, status: "active" }, plain] satisfies ModelInfo[] })
    if (url.pathname.startsWith(`/api/session/${sessionID}/message/`)) return json({ data: projected.get(url.pathname.split("/").at(-1)!) })
    if (url.pathname === `/api/session/${sessionID}/model` && request.method === "POST") {
      const body: unknown = await request.json()
      if (!isRecord(body) || !isRecord(body.model) || typeof body.model.providerID !== "string" || typeof body.model.id !== "string" || body.model.variant !== undefined && typeof body.model.variant !== "string") throw new Error("Invalid model selection request")
      selected = { providerID: body.model.providerID, id: body.model.id, ...(body.model.variant === undefined ? {} : { variant: body.model.variant }) }
      switches.push(selected)
      return new Response(null, { status: 204 })
    }
    if (url.pathname === `/api/session/${sessionID}/prompt` && request.method === "POST") {
      const body: unknown = await request.json()
      const prompt = promptBody(body)
      if (!isRecord(body) || typeof body.id !== "string" || !prompt) throw new Error("Invalid prompt admission request")
      prompts.push({ resume: prompt.resume, model: selected })
      return json({ data: { id: body.id, sessionID, admittedSeq: prompts.length, timeCreated: 1, type: "user", data: { text: prompt.text, files: [] }, delivery: "steer" } })
    }
    return route(url, request)
  } })
  await screen.waitForEventStream()
  return {
    screen, switches, prompts,
    selectExternal(next: ModelRef) {
      selected = next
      seq += 1
      const id = `evt_authority_${seq}`
      projected.set(id.replace(/^evt_/, "msg_"), { id: id.replace(/^evt_/, "msg_"), type: "model-switched", model: next, time: { created: seq + 3 } })
      screen.events.emit({ id, created: seq + 3, durable: { aggregateID: sessionID, seq, version: 1 }, type: "session.model.selected", location: { directory }, data: { sessionID, model: next } } satisfies YCodingEvent)
    },
  }
}

const externalTargets: readonly ModelRef[] = [{ ...session.model, variant: "low" }, { providerID: "openai", id: "model-without-effort" }]
for (const target of externalTargets) {
  test(`ordinary submit follows external durable ${target.id} ${target.variant ?? "base"} without silently reselecting`, async () => {
    const probe = await renderModelAuthority({ state: `external-${target.id}-${target.variant ?? "base"}` })
    try {
      probe.selectExternal(target)
      expect(await waitForFrameText(probe.screen, target.variant ? "GPT 5.6 Terra · low" : "Plain model")).toBe(true)
      if (!target.variant) expect(probe.screen.frame()).not.toContain("Plain model · high")
      expect(probe.switches).toEqual([])
      await typeAndSend(probe.screen, "follow the durable selection")
      expect(await waitForFrameText(probe.screen, "Message YCoding…")).toBe(true)
      expect(probe.switches).toEqual([])
      expect(probe.prompts).toEqual([{ resume: false, model: target }, { resume: true, model: target }])
    } finally { await probe.screen.dispose() }
  }, 30_000)
}

test("a genuine pending effort survives an external durable model update and switches before admission", async () => {
  const probe = await renderModelAuthority({ state: "pending-external" })
  try {
    await typeAndSend(probe.screen, "/variants")
    expect(await waitForFrameText(probe.screen, "Select variant")).toBe(true)
    probe.screen.input.pressKey("ARROW_DOWN")
    probe.screen.input.pressEnter()
    expect(await waitForFrameText(probe.screen, "Message YCoding…")).toBe(true)
    probe.selectExternal({ providerID: "openai", id: "model-without-effort" })
    expect(await waitForFrameText(probe.screen, "Plain model")).toBe(true)
    await typeAndSend(probe.screen, "use my pending choice")
    expect(await waitForFrameText(probe.screen, "Message YCoding…")).toBe(true)
    const desired = { ...session.model, variant: "low" }
    expect(probe.switches).toEqual([desired])
    expect(probe.prompts).toEqual([{ resume: false, model: desired }, { resume: true, model: desired }])
  } finally { await probe.screen.dispose() }
}, 30_000)

test("an unavailable durable effort retains the draft without silently repairing or admitting it", async () => {
  const probe = await renderModelAuthority({ state: "unavailable-effort", initial: { ...session.model, variant: "max" } })
  try {
    await typeAndSend(probe.screen, "keep this invalid selection draft")
    expect(await waitForFrameText(probe.screen, "Model selection needs attention")).toBe(true)
    expect(probe.screen.frame()).toContain("keep this invalid selection draft")
    expect(probe.switches).toEqual([])
    expect(probe.prompts).toEqual([])
  } finally { await probe.screen.dispose() }
}, 30_000)

test("an existing Session without a saved model admits on its default without persisting a UI fallback", async () => {
  const probe = await renderModelAuthority({ state: "default-without-selection", unselected: true })
  try {
    await typeAndSend(probe.screen, "use the Session default")
    expect(await waitForFrameText(probe.screen, "Message YCoding…")).toBe(true)
    expect(probe.switches).toEqual([])
    expect(probe.prompts).toEqual([{ resume: false, model: undefined }, { resume: true, model: undefined }])
  } finally { await probe.screen.dispose() }
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
