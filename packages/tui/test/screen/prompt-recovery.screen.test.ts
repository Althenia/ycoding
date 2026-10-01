import { expect, test } from "bun:test"
import { json, type FetchHandler } from "../fixture/tui-client"
import { renderScreen } from "./harness"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import { SPINNER_FRAMES } from "../../src/component/spinner"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { materializeClipboardImage } from "../../src/clipboard"

// Distinct Location and Session from every other screen suite so the shared module mocks
// installed by renderScreen cannot collide with a concurrent lane.
const sessionID = "ses_prompt_recovery"
const directory = "/tmp/ycoding/prompt-recovery"
const location = { directory, project: { id: "proj_prompt_recovery", directory } }
const session = {
  id: sessionID,
  title: "Prompt recovery",
  projectID: "proj_prompt_recovery",
  location: { directory },
  agent: "build",
  model: { providerID: "openai", id: "gpt-5.6-terra", variant: "high" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}

let promptRequests: Array<{
  id: string
  text: string
  resume?: boolean
  metadata?: { skills?: Array<{ id: string; name: string }> }
  files?: Array<{ uri: string; name?: string }>
}> = []
let failFirstPrompt = false
let firstRequestGate: Promise<void> | undefined
let firstRequestStarted: (() => void) | undefined
let skillGate: Promise<void> | undefined
let skillStarted: (() => void) | undefined
let skillRequests: Array<{ id: string; skill: string; resume: boolean }> = []
let catalogSkill = false
let catalogCommand = false
let managedReceipt = false
let commandGate: Promise<void> | undefined
let commandStarted: (() => void) | undefined
let commandRequests: Array<{ id: string; command: string; arguments: string; resume?: boolean }> = []

function resetFixture() {
  promptRequests = []
  failFirstPrompt = true
  catalogSkill = false
  skillRequests = []
  catalogCommand = false
  commandRequests = []
  managedReceipt = false
}

const route: FetchHandler = async (url, request) => {
  if (url.pathname === "/api/command")
    return json({ location, data: catalogCommand ? [{ name: "report", description: "Configured report" }] : [] })
  if (url.pathname === `/api/session/${sessionID}/command` && request.method === "POST") {
    const body = (await request.json()) as { id: string; command: string; arguments: string; resume?: boolean }
    commandRequests.push(body)
    if (commandRequests.length === 1 && commandGate) {
      commandStarted?.()
      await commandGate
    }
    return json({
      data: {
        id: body.id,
        sessionID,
        admittedSeq: 1,
        timeCreated: 1,
        type: "user",
        data: { text: `Resolved report: ${body.arguments}` },
        delivery: "steer",
      },
    })
  }
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/model` && request.method === "POST")
    return new Response(null, { status: 204 })
  if (url.pathname === `/api/session/${sessionID}/skill` && request.method === "POST") {
    skillRequests.push((await request.json()) as { id: string; skill: string; resume: boolean })
    skillStarted?.()
    await skillGate
    return new Response(null, { status: 204 })
  }
  if (url.pathname === `/api/session/${sessionID}/prompt` && request.method === "POST") {
    const body = (await request.json()) as {
      id: string
      text: string
      resume?: boolean
      metadata?: { skills?: Array<{ id: string; name: string }> }
      files?: Array<{ uri: string; name?: string }>
    }
    promptRequests.push(body)
    if (promptRequests.length === 1 && firstRequestGate) {
      firstRequestStarted?.()
      await firstRequestGate
    }
    if (failFirstPrompt) {
      failFirstPrompt = false
      return json({ message: "prompt admission failed" }, { status: 500 })
    }
    return json({
      data: {
        id: body.id,
        sessionID,
        admittedSeq: promptRequests.length,
        timeCreated: Date.now(),
        type: "user",
        data: {
          text: body.text,
          ...(managedReceipt && body.files?.length
            ? {
                files: [
                  {
                    name: "clipboard.png",
                    mime: "image/png",
                    content: {
                      type: "managed",
                      digest: "a".repeat(64),
                      bytes: 1,
                      path: `attachments/sha256/aa/${"a".repeat(64)}`,
                    },
                  },
                ],
              }
            : {}),
        },
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
        model: session.model,
        context: { total: 0, percent: 0 },
        tokens: { uncachedInput: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cache: { eligible: 0, hitRatio: 0.61, mechanism: "unreported", readReported: false, writeReported: false },
        requests: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: session.tokens },
      },
    })
  if (url.pathname === `/api/session/${sessionID}/usage`)
    return json({
      data: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, cost: 0, tokens: session.tokens },
    })
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
          id: session.model.id,
          modelID: session.model.id,
          providerID: session.model.providerID,
          name: "GPT 5.6 Terra",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          variants: [{ id: session.model.variant }, { id: "low" }],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 200_000, output: 32_000 },
        },
      ],
    })
  if (url.pathname === "/api/provider") return json({ location, data: [{ id: "openai", name: "OpenAI" }] })
  if (url.pathname === "/api/skill")
    return json({
      location,
      data: catalogSkill
        ? [{ id: "review", name: "Review", description: "Review code", content: "Review instructions", slash: true }]
        : [],
    })
  if (url.pathname === "/api/agent")
    return json({
      location,
      data: [
        {
          id: "build",
          name: "Build",
          request: { headers: {}, body: {} },
          mode: "primary",
          hidden: false,
          permissions: [],
        },
      ],
    })
  return undefined
}

async function waitFor(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error(`timed out waiting for ${label}; prompts=${JSON.stringify(promptRequests)}`)
}

async function focusComposer(screen: Awaited<ReturnType<typeof renderScreen>>) {
  const promptRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
  expect(promptRow).toBeGreaterThan(-1)
  await screen.mouse.click(3, promptRow)
}

function composer(node: Renderable): TextareaRenderable | undefined {
  if (node instanceof TextareaRenderable) return node
  return node.getChildren().map(composer).find(Boolean)
}

test("dispatch releases the composer for a second send while the first acknowledgement is unresolved", async () => {
  resetFixture()
  failFirstPrompt = false
  let release!: () => void
  firstRequestGate = new Promise<void>((resolve) => (release = resolve))
  const started = new Promise<void>((resolve) => (firstRequestStarted = resolve))
  const screen = await renderScreen({ width: 100, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    await focusComposer(screen)
    await screen.input.typeText("first pending send")
    screen.input.pressEnter()
    await started
    await screen.renderOnce()
    expect(composer(screen.renderer.root)?.plainText).toBe("")
    const bubble = screen.lines().find((line) => line.includes("first pending send"))
    expect(bubble).toBeDefined()
    expect(SPINNER_FRAMES.some((glyph) => bubble?.includes(glyph))).toBe(false)
    expect(bubble).not.toContain("◷")
    await screen.input.typeText("second pending send")
    expect(composer(screen.renderer.root)?.plainText).toBe("second pending send")
    screen.input.pressEnter()
    await waitFor(() => composer(screen.renderer.root)?.plainText === "", "second dispatch")
    await screen.input.typeText("third unsent draft")
    release()
    await waitFor(() => promptRequests.length === 4, "both ordered sends")
    expect(promptRequests.map((request) => request.text)).toEqual([
      "first pending send",
      "first pending send",
      "second pending send",
      "second pending send",
    ])
    expect(promptRequests[0].id).toBe(promptRequests[1].id)
    expect(promptRequests[2].id).toBe(promptRequests[3].id)
    expect(promptRequests[0].id).not.toBe(promptRequests[2].id)
    expect(composer(screen.renderer.root)?.plainText).toBe("third unsent draft")
  } finally {
    release()
    firstRequestGate = undefined
    firstRequestStarted = undefined
    await screen.dispose()
  }
}, 30_000)

test("enhanced Enter release never submits a draft while an earlier send is pending", async () => {
  resetFixture()
  failFirstPrompt = false
  let release!: () => void
  firstRequestGate = new Promise<void>((resolve) => (release = resolve))
  const started = new Promise<void>((resolve) => (firstRequestStarted = resolve))
  const screen = await renderScreen({
    width: 100,
    height: 69,
    kittyKeyboard: true,
    args: { sessionID },
    route,
    settle: "Message YCoding…",
  })
  try {
    await focusComposer(screen)
    await screen.input.typeText("pressed once")
    screen.input.pressEnter()
    await started
    await screen.input.typeText("not released as submit")
    screen.renderer.stdin.emit("data", Buffer.from("\u001b[13;1:3u"))
    await screen.renderOnce()
    expect(composer(screen.renderer.root)?.plainText).toBe("not released as submit")
    expect(promptRequests).toHaveLength(1)
    release()
    await waitFor(() => promptRequests.length === 2, "only the first wake")
    expect(composer(screen.renderer.root)?.plainText).toBe("not released as submit")
  } finally {
    release()
    firstRequestGate = undefined
    firstRequestStarted = undefined
    await screen.dispose()
  }
}, 30_000)

test("route disposal does not cancel owned transport or attach its late failure to the home draft", async () => {
  resetFixture()
  let release!: () => void
  firstRequestGate = new Promise<void>((resolve) => (release = resolve))
  const started = new Promise<void>((resolve) => (firstRequestStarted = resolve))
  const screen = await renderScreen({ width: 100, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    await focusComposer(screen)
    await screen.input.typeText("owned after navigation")
    screen.input.pressEnter()
    await started
    screen.input.pressKey("x", { ctrl: true })
    screen.input.pressKey("n")
    await waitFor(
      () => !screen.frame().includes("shells 0") && screen.frame().includes("Message YCoding…"),
      "home route",
    )
    await focusComposer(screen)
    await screen.input.typeText("new home draft")
    release()
    await screen.renderOnce()
    expect(composer(screen.renderer.root)?.plainText).toBe("new home draft")
    expect(screen.frame()).not.toContain("Retry send")
    screen.input.pressKey("x", { ctrl: true })
    screen.input.pressKey("l")
    await waitFor(() => screen.frame().includes("Switch session"), "session picker")
    screen.input.pressEnter()
    await waitFor(
      () => screen.frame().includes("Sending prompt unresolved · Retry send"),
      "retained Session outcome after remount",
    )
    expect(screen.frame()).toContain("owned after navigation")
    expect(promptRequests).toHaveLength(1)
  } finally {
    release()
    firstRequestGate = undefined
    firstRequestStarted = undefined
    await screen.dispose()
  }
}, 30_000)

test("direct skill metadata reaches admission without preactivation while the editor accepts another send", async () => {
  resetFixture()
  failFirstPrompt = false
  catalogSkill = true
  let release!: () => void
  firstRequestGate = new Promise<void>((resolve) => (release = resolve))
  const started = new Promise<void>((resolve) => (firstRequestStarted = resolve))
  const screen = await renderScreen({ width: 100, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    await focusComposer(screen)
    await screen.input.typeText("$review first skill prompt")
    screen.input.pressEnter()
    await started
    expect(composer(screen.renderer.root)?.plainText).toBe("")
    expect(promptRequests).toHaveLength(1)
    expect(promptRequests[0].metadata?.skills).toEqual([{ id: "review", name: "Review" }])
    expect(skillRequests).toHaveLength(0)
    await screen.input.typeText("second skill-independent prompt")
    screen.input.pressEnter()
    await waitFor(() => composer(screen.renderer.root)?.plainText === "", "second skill-gated dispatch")
    await screen.input.typeText("editable during skill load")
    expect(promptRequests).toHaveLength(1)
    expect(skillRequests).toHaveLength(0)
    release()
    await waitFor(() => promptRequests.length === 4, "skill then both prompts")
    expect(promptRequests.map((request) => request.text)).toEqual([
      "$review first skill prompt",
      "$review first skill prompt",
      "second skill-independent prompt",
      "second skill-independent prompt",
    ])
    expect(composer(screen.renderer.root)?.plainText).toBe("editable during skill load")
  } finally {
    release()
    firstRequestGate = undefined
    firstRequestStarted = undefined
    await screen.dispose()
  }
}, 30_000)

test("a late admission failure retains the submitted input without erasing a new draft or queued send", async () => {
  resetFixture()
  const screen = await renderScreen({ width: 100, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    await focusComposer(screen)
    await screen.input.typeText("first draft admission")
    screen.input.pressEnter()
    await waitFor(() => screen.frame().includes("Sending prompt unresolved · Retry send"), "admission failure feedback")
    expect(promptRequests).toHaveLength(1)
    expect(promptRequests[0]?.text).toBe("first draft admission")

    expect(composer(screen.renderer.root)?.plainText).toBe("")
    await screen.input.typeText("independent second draft")
    screen.input.pressEnter()
    await waitFor(() => composer(screen.renderer.root)?.plainText === "", "second dispatch")
    await screen.input.typeText("third untouched draft")
    expect(promptRequests).toHaveLength(1)
    await screen.renderOnce()
    const row = screen.lines().findIndex((line) => line.includes("Retry send"))
    expect(row).toBeGreaterThan(-1)
    await screen.mouse.click(screen.lines()[row].indexOf("Retry send"), row)
    await waitFor(() => promptRequests.length === 5, "retry and queued send")
    expect(promptRequests.map((request) => request.text)).toEqual([
      "first draft admission",
      "first draft admission",
      "first draft admission",
      "independent second draft",
      "independent second draft",
    ])
    expect(promptRequests.map((request) => request.resume)).toEqual([false, false, true, false, true])
    expect(new Set(promptRequests.slice(0, 3).map((request) => request.id)).size).toBe(1)
    expect(promptRequests[3].id).toBe(promptRequests[4].id)
    expect(promptRequests[3].id).not.toBe(promptRequests[0].id)
    expect(composer(screen.renderer.root)?.plainText).toBe("third untouched draft")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("standalone skill loading stays owned while the real composer accepts a second draft", async () => {
  resetFixture()
  failFirstPrompt = false
  catalogSkill = true
  let release!: () => void
  skillGate = new Promise<void>((resolve) => (release = resolve))
  const started = new Promise<void>((resolve) => (skillStarted = resolve))
  const screen = await renderScreen({ width: 100, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    await focusComposer(screen)
    await screen.input.typeText("/review ")
    screen.input.pressEnter()
    await started
    expect(composer(screen.renderer.root)?.plainText).toBe("")
    await screen.input.typeText("after standalone skill")
    screen.input.pressEnter()
    await waitFor(() => composer(screen.renderer.root)?.plainText === "", "second dispatch during skill loading")
    await screen.input.typeText("new draft during skill loading")
    expect(promptRequests).toHaveLength(0)
    expect(skillRequests).toHaveLength(1)
    release()
    await waitFor(() => promptRequests.length === 2, "queued prompt after standalone skill")
    expect(promptRequests.map((request) => request.text)).toEqual(["after standalone skill", "after standalone skill"])
    expect(composer(screen.renderer.root)?.plainText).toBe("new draft during skill loading")
  } finally {
    release()
    skillGate = undefined
    skillStarted = undefined
    await screen.dispose()
  }
}, 30_000)

test("receipt retry uses the retained prompt identity and leaves an editable draft untouched", async () => {
  resetFixture()
  const screen = await renderScreen({ width: 100, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    await focusComposer(screen)
    await screen.input.typeText("stable identity retry")
    screen.input.pressEnter()
    await waitFor(() => screen.frame().includes("Sending prompt unresolved · Retry send"), "admission failure feedback")
    expect(promptRequests).toHaveLength(1)

    await screen.input.typeText("unsent draft")
    await screen.renderOnce()
    const row = screen.lines().findIndex((line) => line.includes("Retry send"))
    await screen.mouse.click(screen.lines()[row].indexOf("Retry send"), row)
    await waitFor(() => promptRequests.length >= 3, "the exact retry to complete")
    expect(promptRequests.map((request) => request.text)).toEqual([
      "stable identity retry",
      "stable identity retry",
      "stable identity retry",
    ])
    expect(new Set(promptRequests.map((request) => request.id)).size).toBe(1)
    expect(promptRequests.map((request) => request.resume)).toEqual([false, false, true])
    expect(composer(screen.renderer.root)?.plainText).toBe("unsent draft")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("configured command admission releases editing and queues the next prompt without repeating command processing", async () => {
  resetFixture()
  failFirstPrompt = false
  catalogCommand = true
  let release!: () => void
  commandGate = new Promise<void>((resolve) => (release = resolve))
  const started = new Promise<void>((resolve) => (commandStarted = resolve))
  const screen = await renderScreen({ width: 100, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    await focusComposer(screen)
    await screen.input.typeText("/report first argument")
    screen.input.pressEnter()
    await started
    expect(composer(screen.renderer.root)?.plainText).toBe("")
    expect(commandRequests[0].id).toMatch(/^msg_/)
    expect(commandRequests[0].resume).toBe(false)
    await screen.input.typeText("next plain prompt")
    screen.input.pressEnter()
    await waitFor(() => composer(screen.renderer.root)?.plainText === "", "next prompt dispatch")
    await screen.input.typeText("new unsent draft")
    release()
    await waitFor(() => promptRequests.length === 3, "command wake and next prompt")
    expect(commandRequests).toHaveLength(1)
    expect(promptRequests.map((request) => request.text)).toEqual([
      "Resolved report: first argument",
      "next plain prompt",
      "next plain prompt",
    ])
    expect(promptRequests[0].id).toBe(commandRequests[0].id)
    expect(promptRequests[0].resume).toBe(true)
    expect(composer(screen.renderer.root)?.plainText).toBe("new unsent draft")
  } finally {
    release()
    commandGate = undefined
    commandStarted = undefined
    await screen.dispose()
  }
}, 30_000)

test("explicit local recovery discard releases a failed head without replaying it or erasing the new draft", async () => {
  resetFixture()
  const screen = await renderScreen({ width: 100, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    await focusComposer(screen)
    await screen.input.typeText("discard failed send")
    screen.input.pressEnter()
    await waitFor(() => screen.frame().includes("Retry send"), "failed head")
    await screen.input.typeText("queued after discard")
    screen.input.pressEnter()
    await waitFor(() => composer(screen.renderer.root)?.plainText === "", "queued second")
    await screen.input.typeText("keep current draft")
    screen.input.pressKey("p", { ctrl: true })
    await waitFor(() => screen.frame().includes("Commands"), "command palette")
    await screen.input.typeText("Discard previous submission recovery")
    await waitFor(() => screen.frame().includes("Discard previous submission recovery:"), "owned discard command")
    screen.input.pressEnter()
    await waitFor(() => promptRequests.length === 3, "next send after local discard")
    expect(promptRequests.map((request) => request.text)).toEqual([
      "discard failed send",
      "queued after discard",
      "queued after discard",
    ])
    expect(composer(screen.renderer.root)?.plainText).toBe("keep current draft")
    await waitFor(() => screen.frame().includes("Local recovery discarded"), "discard warning")
    expect(screen.frame().replace(/\s+/g, " ")).toContain("backend input is unchanged")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("successful delayed clipboard admission reconciles recalled history to its managed attachment before cleanup", async () => {
  resetFixture()
  failFirstPrompt = false
  managedReceipt = true
  const state = await mkdtemp(path.join(tmpdir(), "ycoding-managed-history-"))
  const attachment = await materializeClipboardImage(state, async (file) => {
    await Bun.write(
      file,
      await Bun.file(new URL("../../../../assets/brand/ycoding-mark-256.png", import.meta.url)).bytes(),
    )
  })
  let release!: () => void
  firstRequestGate = new Promise<void>((resolve) => (release = resolve))
  const started = new Promise<void>((resolve) => (firstRequestStarted = resolve))
  const screen = await renderScreen({
    width: 100,
    height: 69,
    state,
    clipboard: { read: async () => attachment },
    args: { sessionID },
    route,
    settle: "Message YCoding…",
  })
  try {
    await focusComposer(screen)
    screen.input.pressKey("v", { ctrl: true })
    await waitFor(() => screen.frame().includes("[Image 1]"), "clipboard attachment")
    screen.input.pressEnter()
    await started
    expect(composer(screen.renderer.root)?.plainText).toBe("")
    release()
    await waitFor(() => promptRequests.length === 2, "canonical receipt and wake")
    expect(await Bun.file(attachment.temporary.path).exists()).toBe(false)
    screen.input.pressKey("ARROW_UP")
    await waitFor(() => composer(screen.renderer.root)?.plainText.includes("[Image 1]") === true, "history recall")
    screen.input.pressEnter()
    await waitFor(
      () => promptRequests.length === 4 || screen.frame().includes("attachment unavailable"),
      "managed recalled attachment resend",
    )
    expect(promptRequests).toHaveLength(4)
    expect(promptRequests[2].files?.[0].uri).toBe(`ycoding-attachment://sha256/${"a".repeat(64)}`)
    const saved = await Bun.file(path.join(state, "prompt-history.jsonl")).text()
    expect(saved).toContain(`ycoding-attachment://sha256/${"a".repeat(64)}`)
    expect(saved).not.toContain(attachment.uri)
  } finally {
    release()
    firstRequestGate = undefined
    firstRequestStarted = undefined
    await screen.dispose()
    await attachment.temporary.cleanup()
    await rm(state, { recursive: true, force: true })
  }
}, 30_000)
