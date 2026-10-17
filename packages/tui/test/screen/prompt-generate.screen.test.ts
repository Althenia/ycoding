import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { TextareaRenderable } from "@opentui/core"
import { json, sessionSnapshot } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const sessionID = "ses_prompt_generate"
const directory = "/tmp/ycoding/prompt-generate"
const location = { directory, project: { id: "proj_prompt_generate", directory } }
const model = { providerID: "openai", id: "fixture" }
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const generated = "Inspect the migration diff"
const modelInfo = {
  ...model,
  modelID: model.id,
  name: "Fixture",
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [],
  time: { released: 0 },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 200000, output: 32000 },
}

async function sessionFixture() {
  const generates: { path: string; body: unknown }[] = []
  const prompts: unknown[] = []
  const pending: Array<() => void> = []
  let result: unknown = { data: { status: "generated", text: generated } }
  const session = {
    id: sessionID,
    title: "Prompt generate",
    projectID: location.project.id,
    location: { directory },
    agent: "build",
    model,
    cost: 0,
    tokens,
    time: { created: 1, updated: 2 },
  }
  const screen = await renderScreen({
    width: 120,
    height: 36,
    kittyKeyboard: true,
    args: { sessionID },
    settle: "Message YCoding…",
    config: { animations: false, session: { sidebar: "hide" } },
    route: async (url, request) => {
      if (url.pathname.endsWith("/wait")) return new Response(null, { status: 204 })
      if (request.method === "POST" && url.pathname.endsWith("/prompt-generate")) {
        generates.push({ path: url.pathname, body: await request.json() })
        await new Promise<void>((resolve) => pending.push(resolve))
        return json(result)
      }
      if (request.method === "POST" && url.pathname.endsWith("/prompt")) {
        const body: unknown = await request.json()
        prompts.push(body)
        const id = typeof body === "object" && body !== null ? Reflect.get(body, "id") : "msg_prompt"
        const text = typeof body === "object" && body !== null ? Reflect.get(body, "text") : ""
        const delivery = typeof body === "object" && body !== null ? Reflect.get(body, "delivery") : "steer"
        return json({
          data: {
            id,
            sessionID,
            admittedSeq: 1,
            timeCreated: 1,
            type: "user",
            data: { text },
            delivery: delivery === "queue" ? "queue" : "steer",
          },
        })
      }
      if (request.method === "POST") return json({})
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
      if (url.pathname === `/api/session/${sessionID}/snapshot`) return sessionSnapshot(sessionID, [], { session })
      if (url.pathname === `/api/session/${sessionID}/subagent`)
        return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
      if (["pending", "permission", "todo", "skills"].some((resource) => url.pathname.endsWith(`/${resource}`)))
        return json({ data: [] })
      if (url.pathname === "/api/agent")
        return json({
          location,
          data: [{ id: "build", name: "Build", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] }],
        })
      if (url.pathname === "/api/model") return json({ location, data: [modelInfo] })
      if (url.pathname === "/api/model/default") return json({ location, data: { ...modelInfo, selection: model } })
      return undefined
    },
  })
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      await screen.renderOnce()
      if (predicate()) return
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    throw new Error(`Prompt generate transition did not occur:\n${screen.frame()}`)
  }
  const release = () => {
    for (const resolve of pending.splice(0)) resolve()
  }
  await screen.mouse.click(3, screen.lines().findIndex((line) => line.includes("Message YCoding…")))
  screen.renderer.clearSelection()
  const editor = screen.renderer.currentFocusedEditor
  if (!(editor instanceof TextareaRenderable)) throw new Error("Prompt composer is not focused")
  return {
    screen,
    editor,
    generates,
    prompts,
    release,
    wait,
    setResult: (value: unknown) => {
      result = value
    },
  }
}

async function landingFixture() {
  const state = await mkdtemp(path.join(os.tmpdir(), "ycoding-prompt-generate-"))
  const generates: { path: string; body: unknown }[] = []
  const creates: Record<string, unknown>[] = []
  const autonomy: unknown[] = []
  const pending: Array<() => void> = []
  let createdID: string | undefined
  const info = () => ({
    id: createdID,
    title: "Landing prompt",
    projectID: location.project.id,
    location: { directory },
    agent: "build",
    model,
    cost: 0,
    tokens,
    time: { created: 1, updated: 2 },
  })
  const screen = await renderScreen({
    width: 120,
    height: 40,
    kittyKeyboard: true,
    settle: "Fixture",
    state,
    config: { animations: false, session: { sidebar: "hide" } },
    route: async (url, request) => {
      if (url.pathname.endsWith("/wait")) return new Response(null, { status: 204 })
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/agent")
        return json({
          location,
          data: [{ id: "build", name: "Build", mode: "primary", hidden: false, permissions: [], request: { headers: {}, body: {} } }],
        })
      if (url.pathname === "/api/model") return json({ location, data: [modelInfo] })
      if (url.pathname === "/api/model/default") return json({ location, data: { ...modelInfo, selection: model } })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "openai", name: "OpenAI" }] })
      if (["/api/integration", "/api/command", "/api/skill", "/api/reference", "/api/permission/request", "/api/form/request"].includes(url.pathname))
        return json({ location, data: [] })
      if (url.pathname === "/api/session/active") return json({ data: {} })
      if (url.pathname === "/api/session" && request.method === "POST") {
        const body: unknown = await request.json()
        if (typeof body === "object" && body !== null) creates.push(structuredClone(body) as Record<string, unknown>)
        const id = typeof body === "object" && body !== null ? Reflect.get(body, "id") : undefined
        createdID = typeof id === "string" ? id : "ses_landing_prompt"
        return json({ data: info() })
      }
      if (url.pathname === "/api/session") return json({ data: createdID ? [info()] : [], cursor: {} })
      if (request.method === "POST" && url.pathname.endsWith("/prompt-generate")) {
        generates.push({ path: url.pathname, body: await request.json() })
        await new Promise<void>((resolve) => pending.push(resolve))
        return json({ data: { status: "generated", text: generated } })
      }
      if (createdID && url.pathname === `/api/session/${createdID}/autonomy` && request.method === "PUT") {
        const body: unknown = await request.json()
        autonomy.push(body)
        const yolo = typeof body === "object" && body !== null ? Reflect.get(body, "yolo") : 0
        return json({ data: { mode: "normal", yolo: yolo === 1 || yolo === 2 || yolo === 3 ? yolo : 0 } })
      }
      if (createdID && url.pathname === `/api/session/${createdID}`) return json({ data: info() })
      if (createdID && url.pathname === `/api/session/${createdID}/snapshot`) return sessionSnapshot(createdID, [], { session: info() })
      if (createdID && url.pathname === `/api/session/${createdID}/subagent`)
        return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
      if (createdID && url.pathname === `/api/session/${createdID}/autonomy`) return json({ data: { mode: "normal", yolo: autonomy.length ? 1 : 0, effective: { yolo: autonomy.length ? 1 : 0, asleep: false, ordinaryReviewsAuto: false, guardrailsEnabled: true, modelReviews: false, hardModelReviews: false } } })
      if (createdID && url.pathname === `/api/session/${createdID}/guardrail`)
        return json({ data: { rootSessionID: createdID, profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [] } })
      if (createdID && url.pathname === `/api/session/${createdID}/diagnostics`)
        return json({
          data: {
            model,
            context: { total: 0, percent: 0 },
            tokens: { uncachedInput: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
            cache: { eligible: 0, hitRatio: 0, mechanism: "none", readReported: false, writeReported: false },
            requests: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens },
          },
        })
      if (createdID && url.pathname === `/api/session/${createdID}/usage`)
        return json({ data: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, cost: 0, tokens } })
      if (createdID && url.pathname === `/api/session/${createdID}/form`) return json({ data: [] })
      if (createdID && ["pending", "permission", "todo", "skills", "guardrail/request"].some((resource) => url.pathname.endsWith(`/${resource}`)))
        return json({ data: [] })
      if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (["/api/shell", "/api/mcp"].includes(url.pathname)) return json({ location, data: [] })
      if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
      return undefined
    },
  })
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      await screen.renderOnce()
      if (predicate()) return
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    throw new Error(`Landing prompt generate transition did not occur:\n${screen.frame()}`)
  }
  const release = () => {
    for (const resolve of pending.splice(0)) resolve()
  }
  await wait(() => screen.frame().includes("Message YCoding…"))
  await screen.mouse.click(3, screen.lines().findIndex((line) => line.includes("Message YCoding…")))
  screen.renderer.clearSelection()
  const editor = () => {
    const current = screen.renderer.currentFocusedEditor
    if (!(current instanceof TextareaRenderable)) throw new Error(`Landing composer is not focused:\n${screen.frame()}`)
    return current
  }
  return { screen, editor, generates, creates, autonomy, release, wait, state }
}

async function openGenerate(view: Awaited<ReturnType<typeof sessionFixture>>, text: string) {
  await view.screen.input.typeText(text)
  view.screen.input.pressEnter()
  const opened = () => view.screen.frame().includes("[ ] Project memory (this repository)")
  await view.wait(() => opened() || view.editor.plainText === "/prompt ")
  if (opened()) return
  view.screen.input.pressEnter()
  await view.wait(opened)
}

test("an empty /prompt shows an info toast and sends nothing", async () => {
  const view = await sessionFixture()
  try {
    await view.screen.input.typeText("/prompt ")
    view.screen.input.pressEnter()
    await view.wait(() => view.screen.frame().includes("Add what you want after /prompt"))
    expect(view.generates).toEqual([])
    expect(view.prompts).toEqual([])
  } finally {
    view.release()
    await view.screen.dispose()
  }
}, 30000)

test("the dialog lists Steer and Queue follow-up only when a Session exists", async () => {
  const session = await sessionFixture()
  try {
    await openGenerate(session, "/prompt focus the diff ")
    expect(session.screen.frame()).toContain("Generate prompt")
    expect(session.screen.frame()).toContain("Start a task")
    expect(session.screen.frame()).toContain("Steer")
    expect(session.screen.frame()).toContain("Queue follow-up")
    expect(session.screen.frame()).toContain("Goal objective")
    expect(session.screen.frame()).toContain("[ ] Project memory (this repository)")
    expect(session.screen.frame()).toContain("[ ] Global memory (shared knowledge)")
    expect(session.screen.frame()).not.toContain("[x]")
    session.screen.input.pressEscape()
    await session.wait(() => !session.screen.frame().includes("Generate prompt"))
    expect(session.generates).toEqual([])
  } finally {
    session.release()
    await session.screen.dispose()
  }
  const landing = await landingFixture()
  try {
    await landing.screen.input.typeText("/prompt focus the diff ")
    landing.screen.input.pressEnter()
    await landing.wait(() => landing.screen.frame().includes("Generate prompt"))
    expect(landing.screen.frame()).toContain("Start a task")
    expect(landing.screen.frame()).toContain("Goal objective")
    expect(landing.screen.frame()).not.toContain("Steer")
    expect(landing.screen.frame()).not.toContain("Queue follow-up")
    landing.screen.input.pressEscape()
    await landing.wait(() => !landing.screen.frame().includes("Generate prompt"))
    expect(landing.generates).toEqual([])
    expect(landing.creates).toEqual([])
  } finally {
    landing.release()
    await landing.screen.dispose()
    await rm(landing.state, { recursive: true, force: true })
  }
}, 30000)

test("generated text fills the empty composer and can include project memory", async () => {
  const view = await sessionFixture()
  try {
    await openGenerate(view, "/prompt focus the diff ")
    expect(view.editor.plainText).toBe("")
    view.screen.input.pressArrow("up")
    view.screen.input.pressArrow("up")
    view.screen.input.pressKey(" ")
    await view.wait(() => view.screen.frame().includes("[x] Project memory (this repository)"))
    view.screen.input.pressEnter()
    await view.wait(() => view.generates.length === 1)
    expect(view.generates).toEqual([
      {
        path: `/api/session/${sessionID}/prompt-generate`,
        body: { mode: "start", intent: "focus the diff", memory: ["repository"] },
      },
    ])
    expect(view.screen.frame()).toContain("Generating prompt…")
    view.release()
    await view.wait(() => view.editor.plainText === generated)
    expect(view.prompts).toEqual([])
  } finally {
    view.release()
    await view.screen.dispose()
  }
}, 30000)

test("goal mode fills /goal plus the generated text", async () => {
  const view = await sessionFixture()
  try {
    await openGenerate(view, "/prompt set the objective ")
    for (let index = 0; index < 3; index++) view.screen.input.pressArrow("down")
    await view.wait(() => view.screen.frame().includes("● Goal objective"))
    view.screen.input.pressEnter()
    await view.wait(() => view.generates.length === 1)
    expect(view.generates[0]?.body).toMatchObject({ mode: "goal", intent: "set the objective", memory: [] })
    view.release()
    await view.wait(() => view.editor.plainText === `/goal ${generated}`)
    expect(view.prompts).toEqual([])
  } finally {
    view.release()
    await view.screen.dispose()
  }
}, 30000)

test("queue mode shows a composer hint and submits delivery queue", async () => {
  const view = await sessionFixture()
  try {
    await openGenerate(view, "/prompt queue the follow-up ")
    view.screen.input.pressArrow("down")
    view.screen.input.pressArrow("down")
    await view.wait(() => view.screen.frame().includes("● Queue follow-up"))
    view.screen.input.pressEnter()
    await view.wait(() => view.generates.length === 1)
    expect(view.generates[0]?.body).toMatchObject({ mode: "queue", intent: "queue the follow-up", memory: [] })
    view.release()
    await view.wait(() => view.editor.plainText === generated && view.screen.frame().includes("will queue"))
    view.screen.input.pressEnter()
    await view.wait(() => view.prompts.some((item) => {
      if (typeof item !== "object" || item === null) return false
      return Reflect.get(item, "text") === generated && Reflect.get(item, "delivery") === "queue"
    }))
    expect(view.editor.plainText).toBe("")
    expect(view.screen.frame()).not.toContain("will queue")
  } finally {
    view.release()
    await view.screen.dispose()
  }
}, 30000)

test("an unavailable result tells the user no prompt could be generated", async () => {
  const view = await sessionFixture()
  try {
    view.setResult({ data: { status: "unavailable" } })
    await openGenerate(view, "/prompt nothing useful ")
    view.screen.input.pressEnter()
    await view.wait(() => view.generates.length === 1)
    view.release()
    await view.wait(() => view.screen.frame().includes("No prompt could be generated"))
    expect(view.editor.plainText).toBe("")
  } finally {
    view.release()
    await view.screen.dispose()
  }
}, 30000)

test("a nonempty draft keeps its text and discards the generated prompt", async () => {
  const view = await sessionFixture()
  try {
    await openGenerate(view, "/prompt focus the diff ")
    view.screen.input.pressEnter()
    await view.wait(() => view.generates.length === 1)
    await view.screen.input.typeText("keep this")
    await view.wait(() => view.editor.plainText === "keep this")
    view.release()
    await view.wait(() => view.screen.frame().includes("Draft not empty; generated prompt discarded"))
    expect(view.editor.plainText).toBe("keep this")
  } finally {
    view.release()
    await view.screen.dispose()
  }
}, 30000)

test("the landing screen creates a Session, keeps the approval-level draft, and fills the new composer", async () => {
  const view = await landingFixture()
  try {
    await view.screen.input.typeText("/yolo 1 ")
    view.screen.input.pressEnter()
    await view.wait(() => view.screen.frame().includes("Approval level 1 · Allow tools (landing)"))
    await view.screen.input.typeText("/prompt Draft the landing task ")
    view.screen.input.pressEnter()
    await view.wait(() => view.screen.frame().includes("Generate prompt") && !view.screen.frame().includes("Steer"))
    expect(view.screen.frame()).not.toContain("Queue follow-up")
    view.screen.input.pressEnter()
    await view.wait(() => view.creates.length === 1 && view.generates.length === 1)
    expect(view.creates[0]).toMatchObject({ agent: "build", model: { providerID: "openai", id: "fixture" } })
    expect(view.autonomy).toEqual([{ yolo: 1 }])
    expect(view.generates[0]?.body).toMatchObject({ mode: "start", intent: "Draft the landing task", memory: [] })
    expect(view.generates[0]?.path).toBe(`/api/session/${Reflect.get(view.creates[0] ?? {}, "id")}/prompt-generate`)
    view.release()
    await view.wait(() => view.editor().plainText === generated)
  } finally {
    view.release()
    await view.screen.dispose()
    await rm(view.state, { recursive: true, force: true })
  }
}, 30000)

test("Generate prompt in the palette drafts /prompt into the composer", async () => {
  const view = await landingFixture()
  try {
    view.screen.input.pressKey("p", { ctrl: true })
    await view.wait(() => view.screen.frame().includes("Commands") && view.screen.frame().includes("Search"))
    await view.screen.mouse.click(12, view.screen.lines().findIndex((line) => line.includes("Search")))
    await view.screen.input.typeText("Generate prompt")
    await view.wait(() => {
      const frame = view.screen.frame()
      return frame.includes("Draft a prompt from a rough intent") && !frame.includes("Switch session")
    })
    view.screen.input.pressEnter()
    await view.wait(() => view.editor().plainText === "/prompt ")
    expect(view.generates).toEqual([])
    expect(view.creates).toEqual([])
  } finally {
    view.release()
    await view.screen.dispose()
    await rm(view.state, { recursive: true, force: true })
  }
}, 30000)
