/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { json } from "./fixture/tui-client"
import { renderScreen } from "./screen/harness"
import { materializeClipboardImage } from "../src/clipboard"
import { testRender } from "@opentui/solid"
import { createSignal, onMount } from "solid-js"
import { StartupGate } from "../src/component/startup-loading"
import { TextareaRenderable, type Renderable } from "@opentui/core"

const sessionID = "ses_composer_live_fixes"
const directory = "/tmp/ycoding/composer-live-fixes"
const INPUT_ROW_CAP = 6
const location = { directory, project: { id: "proj_composer_live_fixes", directory } }
const session = {
  id: sessionID,
  title: "Composer live fixes",
  projectID: "proj_composer_live_fixes",
  location: { directory },
  agent: "build",
  model: { providerID: "openai", id: "gpt-5.6-terra", variant: "high" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}
const tasks = [
  {
    sessionID: "ses_subagent_live_fixes",
    parentID: sessionID,
    description: "Inspect the deliberately long picker description without colliding with metadata",
    agent: "reviewer",
    model: { providerID: "openai", id: "gpt-5.6-terra", variant: "high" },
    background: true,
    state: "running",
    revision: 1,
    time: { created: 1, updated: 2 },
  },
] as const
const permission = {
  id: "permission_composer_blocked",
  sessionID,
  action: "shell",
  resources: ["git status"],
  metadata: {},
}
let submittedPrompt: string | undefined
let admissionFailure: (() => Response) | undefined
let conflictNextPrompt = false
let admissionGate: Promise<void> | undefined
let releaseAdmission: (() => void) | undefined
let admissionAbortObserved = false
let modelSwitchGate: Promise<void> | undefined
let releaseModelSwitch: (() => void) | undefined
let modelSwitchStarted = false
let sessionRunning = false
/** When set, the next `/model` request fails with this response instead of succeeding. */
let modelSwitchFailure: (() => Response) | undefined
const modelSwitchRequests: Array<{ providerID: string; id: string; variant?: string }> = []
const interruptRequests: string[] = []
const modelPromptOrder: string[] = []
const promptRequests: Array<{
  id: string
  text: string
  resume?: boolean
  files?: Array<{ uri: string; name?: string }>
}> = []
let failNextWake = false
let wakeGate: Promise<void> | undefined
let releaseWake: (() => void) | undefined
const submittedResumes: boolean[] = []
const skillRequests: Array<{ id: string; skill: string }> = []

function submittedText(): string | undefined {
  return submittedPrompt
}

function isPromptBody(value: unknown): value is {
  id: string
  text: string
  delivery?: "steer" | "queue"
  resume?: boolean
  files?: Array<{ uri: string; name?: string }>
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "text" in value &&
    typeof value.text === "string" &&
    (!("delivery" in value) || value.delivery === "steer" || value.delivery === "queue")
  )
}

function isSkillBody(value: unknown): value is { id: string; skill: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "skill" in value &&
    typeof value.skill === "string"
  )
}

async function route(url: URL, request: Request) {
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === "/api/session/active")
    return json({ data: sessionRunning ? { [sessionID]: { type: "running" } } : {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/prompt` && request.method === "POST") {
    const body: unknown = await request.json()
    if (!isPromptBody(body)) return json({ error: "invalid prompt" }, { status: 400 })
    promptRequests.push(body)
    submittedResumes.push(body.resume === true)
    modelPromptOrder.push(body.resume ? "resume" : "admit")
    if (admissionGate && !body.resume) {
      request.signal.addEventListener(
        "abort",
        () => {
          admissionAbortObserved = true
        },
        { once: true },
      )
      await admissionGate
    }
    if (conflictNextPrompt) {
      conflictNextPrompt = false
      return json(
        { _tag: "ConflictError", message: "Prompt message ID conflicts with an existing durable record" },
        { status: 409 },
      )
    }
    if (admissionFailure) {
      const response = admissionFailure()
      admissionFailure = undefined
      return response
    }
    if (body.resume && wakeGate) await wakeGate
    if (body.resume && failNextWake) {
      failNextWake = false
      return json({ error: "simulated wake failure" }, { status: 500 })
    }
    submittedPrompt = body.text
    const files = body.files?.map((file) => ({
      name: file.name,
      content: { digest: file.uri.split("/").at(-1)?.padEnd(64, "c").slice(0, 64) ?? "c".repeat(64) },
    }))
    return json({
      data: {
        id: body.id,
        sessionID,
        admittedSeq: 1,
        timeCreated: Date.now(),
        type: "user",
        data: { text: body.text, files },
        delivery: body.delivery ?? "steer",
      },
    })
  }
  if (url.pathname === `/api/session/${sessionID}/model` && request.method === "POST") {
    const body = (await request.json()) as { model: { providerID: string; id: string; variant?: string } }
    modelSwitchRequests.push(body.model)
    modelPromptOrder.push("model")
    modelSwitchStarted = true
    if (modelSwitchGate) await modelSwitchGate
    if (modelSwitchFailure) {
      const response = modelSwitchFailure()
      modelSwitchFailure = undefined
      return response
    }
    return new Response(null, { status: 204 })
  }
  if (url.pathname === `/api/session/${sessionID}/interrupt` && request.method === "POST") {
    interruptRequests.push(sessionID)
    modelPromptOrder.push("interrupt")
    return new Response(null, { status: 204 })
  }
  if (url.pathname === `/api/session/${sessionID}/skill` && request.method === "POST") {
    const body: unknown = await request.json()
    if (!isSkillBody(body)) return json({ error: "invalid skill" }, { status: 400 })
    skillRequests.push(body)
    return new Response(null, { status: 204 })
  }
  if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}/subagent`)
    return json({ data: tasks, summary: { total: 1, active: 1, running: 1, waiting: 0 }, cursor: {} })
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
      data: {
        logical: 0,
        physical: 0,
        helpers: 0,
        continued: 0,
        fallback: 0,
        cost: 0,
        tokens: session.tokens,
      },
    })
  if (url.pathname === "/api/session/ses_subagent_live_fixes/diagnostics")
    return json({
      data: {
        model: tasks[0].model,
        context: { total: 0, percent: 0 },
        tokens: { uncachedInput: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cache: { eligible: 0, hitRatio: 0.61, mechanism: "unreported", readReported: false, writeReported: false },
        requests: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: session.tokens },
      },
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
        {
          id: "gpt-5.6-luna",
          modelID: "gpt-5.6-luna",
          providerID: "openai",
          name: "GPT 5.6 Luna",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          variants: [],
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
      data: [{ id: "review", name: "Review", location: "project", content: "Review carefully" }],
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

test("keeps resident content mounted after one-time startup loading completes", async () => {
  let setReady!: (ready: boolean) => void
  let mounts = 0

  function Resident() {
    onMount(() => mounts++)
    return <text>resident session content</text>
  }

  function Fixture() {
    const [ready, update] = createSignal(false)
    setReady = update
    return (
      <StartupGate ready={ready}>
        <Resident />
      </StartupGate>
    )
  }

  const app = await testRender(() => <Fixture />)
  app.renderer.start()
  try {
    expect(app.captureCharFrame()).not.toContain("resident session content")
    setReady(true)
    await app.waitForFrame((frame) => frame.includes("resident session content"))
    setReady(false)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("resident session content")
    expect(mounts).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

async function permissionRoute(url: URL, request: Request) {
  if (url.pathname === `/api/session/${sessionID}/permission`) return json({ location, data: [permission] })
  return route(url, request)
}

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error("Expected composer transition did not occur")
}

async function waitForFrameText(screen: Awaited<ReturnType<typeof renderScreen>>, text: string) {
  await until(() => screen.frame().includes(text))
  await screen.renderOnce()
  expect(screen.frame()).toContain(text)
}

async function waitForPromptRequests(count: number) {
  await until(() => promptRequests.length >= count)
  expect(promptRequests).toHaveLength(count)
}

function composer(node: Renderable): TextareaRenderable | undefined {
  if (node instanceof TextareaRenderable) return node
  return node.getChildren().map(composer).find(Boolean)
}

async function retryReceipt(screen: Awaited<ReturnType<typeof renderScreen>>) {
  const row = screen.lines().findIndex((line) => line.includes("Retry send"))
  expect(row).toBeGreaterThan(-1)
  await screen.mouse.click(screen.lines()[row].indexOf("Retry send"), row)
}

function composerRuleRow(lines: string[], contentRow: number) {
  return lines.findLastIndex((line, index) => index < contentRow && line.includes("─"))
}

test("keeps the composer subagent picker hidden during a permission review", async () => {
  const screen = await renderScreen({
    width: 220,
    height: 69,
    args: { sessionID },
    route: permissionRoute,
    settle: "Permission required",
  })
  try {
    expect(screen.frame()).toContain("bash wants to run")
    screen.input.pressKey("ARROW_DOWN")
    await screen.renderOnce()
    expect(screen.frame()).toContain("Permission required")
    expect(screen.frame()).not.toContain("Subagents")
    expect(screen.frame()).not.toContain("reviewer")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("insets the input, caps natural wrapping at six rows, and keeps autocomplete above the rule", async () => {
  const screen = await renderScreen({ width: 100, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    const initial = screen.lines()
    const promptRow = initial.findIndex((line) => line.includes("Message YCoding…"))
    const ruleRow = composerRuleRow(initial, promptRow)
    // The session composer carries no hint row at all: the user asked for a shorter composer without
    // it. Placing the hints beside the input was reverted because any sibling in the input's
    // container crashes TextBuffer allocation on the next keystroke.
    expect(promptRow).toBeGreaterThan(-1)
    expect(ruleRow).toBeGreaterThan(-1)
    expect(promptRow - ruleRow).toBe(3)
    expect(initial.slice(ruleRow + 1, promptRow).every((line) => line.trim() === "")).toBe(true)
    expect(initial.some((line) => line.includes("Enter send"))).toBe(false)
    // `⌃p commands` still belongs to the footer band, so assert on a hint-row-only affordance.
    expect(initial.some((line) => line.includes("⌃x b sidebar"))).toBe(false)

    // The composer sits directly above the footer band with no hint row between them.
    const footerRow = initial.findIndex((line) => line.includes("goal off"))
    expect(footerRow).toBeGreaterThan(promptRow)
    expect(footerRow - promptRow).toBeLessThanOrEqual(6)

    await screen.mouse.click(3, promptRow)
    await screen.input.typeText("session")
    await waitForFrameText(screen, "session")
    await screen.input.typeText(" draft")
    await waitForFrameText(screen, "session draft")
    const typed = screen.lines().findIndex((line) => line.includes("session draft"))
    expect(typed).toBe(promptRow)
    expect(typed - composerRuleRow(screen.lines(), typed)).toBe(3)

    // Every paste stays below the prompt's large-paste virtualization threshold, producing one
    // naturally wrapped logical line rather than explicit newline rows. Await each deferred
    // Textarea layout before dispatching the next synthetic paste; a real terminal cannot deliver
    // several separate paste gestures in the same render frame.
    for (let chunk = 0; chunk < 5; chunk++) {
      await screen.input.pasteBracketedText(`wrap-${chunk}-${"x".repeat(130)}`)
      await waitForFrameText(screen, `wrap-${chunk}-`)
    }
    await screen.input.pasteBracketedText("cap-tail")
    await waitForFrameText(screen, "cap-tail")
    const capped = screen.lines()
    const cappedTail = capped.findIndex((line) => line.includes("cap-tail"))
    const cappedRule = composerRuleRow(capped, cappedTail)
    expect(ruleRow - cappedRule).toBe(INPUT_ROW_CAP - 1)
    expect(cappedTail).toBeGreaterThan(cappedRule)
    expect(cappedTail).toBeLessThanOrEqual(cappedRule + 2 + INPUT_ROW_CAP)

    for (let chunk = 5; chunk < 11; chunk++) {
      await screen.input.pasteBracketedText(`wrap-${chunk}-${"y".repeat(130)}`)
      await waitForFrameText(screen, `wrap-${chunk}-`)
    }
    await screen.input.pasteBracketedText("cursor-tail")
    await waitForFrameText(screen, "cursor-tail")
    const scrolled = screen.lines()
    const cursorTail = scrolled.findIndex((line) => line.includes("cursor-tail"))
    expect(composerRuleRow(scrolled, cursorTail)).toBe(cappedRule)
    expect(scrolled.join("\n")).not.toContain("cap-tail")

    screen.input.pressKey("c", { ctrl: true })
    await waitForFrameText(screen, "Message YCoding…")
    await screen.input.typeText("/")
    await waitForFrameText(screen, "/ COMMANDS")
    const autocomplete = screen.lines()
    const slashRow = autocomplete.findIndex((line) => line.trim() === "/")
    const autocompleteFooter = autocomplete.findIndex((line) => line.includes("Enter accept"))
    const autocompleteRule = composerRuleRow(autocomplete, slashRow)
    expect(autocompleteRule - autocompleteFooter).toBe(2)
    expect(autocomplete[autocompleteFooter + 1]?.trim()).toBe("")
    screen.input.pressKey("ESCAPE")
    screen.input.pressKey("BACKSPACE")
    await waitForFrameText(screen, "Message YCoding…")
    // Bracketed paste schedules one zero-delay layout invalidation after insertion. Let the final
    // invalidation paint before destroying this renderer so it cannot leak into the next screen.
    await screen.renderOnce()
  } finally {
    await screen.dispose()
  }
})

test("blocks a dead clipboard image until the user explicitly removes it and sends", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-tui-clipboard-regression-"))
  const image = await materializeClipboardImage(root, async (file) => {
    await Bun.write(file, "png")
  })
  submittedPrompt = undefined
  const screen = await renderScreen({
    width: 100,
    height: 69,
    args: { sessionID },
    route,
    clipboard: { read: async () => image },
    settle: "Message YCoding…",
  })
  try {
    const promptRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, promptRow)
    await screen.input.pasteBracketedText("")
    await waitForFrameText(screen, "[Image 1]")
    await screen.input.pasteBracketedText("keep this text")
    await waitForFrameText(screen, "keep this text")

    await Bun.file(image.temporary.path).delete()
    screen.input.pressEnter()
    await waitForFrameText(screen, "Re-paste or press Enter again to remove and send")
    expect(submittedPrompt).toBeUndefined()
    expect(screen.frame()).toContain("keep this text")

    screen.input.pressEnter()
    await until(() => submittedText() === "keep this text")
    expect(submittedText()).toBe("keep this text")
  } finally {
    await screen.dispose()
    await image.temporary.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test("shows cancellable clipboard progress and disposes a late image without touching the edited draft", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-tui-clipboard-cancel-"))
  const image = await materializeClipboardImage(root, async (file) => {
    await Bun.write(file, "png")
  })
  let releaseRead!: () => void
  const readGate = new Promise<void>((resolve) => (releaseRead = resolve))
  const screen = await renderScreen({
    width: 80,
    height: 24,
    args: { sessionID },
    route,
    clipboard: {
      read: async () => {
        await readGate
        return image
      },
    },
    settle: "Message YCoding…",
  })
  try {
    const promptRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, promptRow)
    const paste = screen.input.pasteBracketedText("")
    await waitForFrameText(screen, "Reading clipboard…")
    await screen.input.typeText("edited while reading 中文")
    await waitForFrameText(screen, "edited while reading 中文")

    screen.input.pressKey("ESCAPE")
    await waitForFrameText(screen, "Cancelled · draft retained")
    releaseRead()
    await paste
    await until(async () => !(await Bun.file(image.temporary.path).exists()))

    expect(screen.frame()).toContain("edited while reading 中文")
    expect(screen.frame()).not.toContain("[Image 1]")
    expect(await Bun.file(image.temporary.path).exists()).toBe(false)
  } finally {
    releaseRead()
    await screen.dispose()
    await image.temporary.cleanup()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("keeps the managed receipt and stable prompt ID when wake fails, then retries exactly", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-tui-wake-retry-"))
  const image = await materializeClipboardImage(root, async (file) => {
    await Bun.write(file, "png")
  })
  promptRequests.length = 0
  submittedPrompt = undefined
  failNextWake = true
  wakeGate = new Promise<void>((resolve) => (releaseWake = resolve))
  const screen = await renderScreen({
    width: 120,
    height: 40,
    args: { sessionID },
    route,
    clipboard: { read: async () => image },
    settle: "Message YCoding…",
  })
  try {
    const promptRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, promptRow)
    await screen.input.pasteBracketedText("")
    await waitForFrameText(screen, "[Image 1]")
    await screen.input.typeText("retry this image")
    screen.input.pressEnter()

    await waitForPromptRequests(2)
    await screen.renderOnce()
    expect(screen.frame()).toContain("retry this image")
    expect(composer(screen.renderer.root)?.plainText).toBe("")
    expect(promptRequests).toHaveLength(2)
    expect(promptRequests[0]?.resume).toBe(false)
    expect(promptRequests[1]?.resume).toBe(true)
    expect(promptRequests[1]?.files?.[0]?.uri).toStartWith("ycoding-attachment://sha256/")
    expect(await Bun.file(image.temporary.path).exists()).toBe(false)

    releaseWake?.()
    await waitForFrameText(screen, "Prompt admitted · wake unresolved · Retry send")
    expect(screen.frame()).toContain("retry this image")
    await screen.input.typeText("new attachment-independent draft")
    await retryReceipt(screen)
    await waitForPromptRequests(3)
    await waitForFrameText(screen, "new attachment-independent draft")

    expect(promptRequests).toHaveLength(3)
    expect(new Set(promptRequests.map((request) => request.id)).size).toBe(1)
    expect(promptRequests[2]?.files?.[0]?.uri).toStartWith("ycoding-attachment://sha256/")
    expect(promptRequests.map((request) => request.resume)).toEqual([false, true, true])
    expect(composer(screen.renderer.root)?.plainText).toBe("new attachment-independent draft")
  } finally {
    releaseWake?.()
    wakeGate = undefined
    releaseWake = undefined
    failNextWake = false
    await screen.dispose()
    await image.temporary.cleanup()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("distinguishes attachment rejection and discards only its recovery before a new prompt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-tui-attachment-rejected-"))
  const image = await materializeClipboardImage(root, async (file) => {
    await Bun.write(file, "png")
  })
  promptRequests.length = 0
  admissionFailure = () =>
    json(
      { _tag: "InvalidRequestError", field: "files", message: "Attachment exceeds the 20 MiB limit" },
      { status: 400 },
    )
  const screen = await renderScreen({
    width: 120,
    height: 40,
    args: { sessionID },
    route,
    clipboard: { read: async () => image },
    settle: "Message YCoding…",
  })
  try {
    const promptRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, promptRow)
    await screen.input.pasteBracketedText("")
    await waitForFrameText(screen, "[Image 1]")
    await screen.input.typeText("first attachment")
    screen.input.pressEnter()
    await waitForFrameText(screen, "Attachment rejected · Retry send")
    expect(screen.frame()).toContain("[Image 1]")
    expect(screen.frame()).toContain("first attachment")
    expect(promptRequests).toHaveLength(1)
    expect(await Bun.file(image.temporary.path).exists()).toBe(true)

    await screen.input.typeText("next plain prompt")
    screen.input.pressKey("p", { ctrl: true })
    await waitForFrameText(screen, "Commands")
    await screen.input.typeText("Discard previous submission recovery")
    await waitForFrameText(screen, "Discard previous submission recovery:")
    screen.input.pressEnter()
    await until(async () => !(await Bun.file(image.temporary.path).exists()))
    expect(composer(screen.renderer.root)?.plainText).toBe("next plain prompt")
    screen.input.pressEnter()
    await waitForPromptRequests(3)
    expect(promptRequests.map((request) => request.text)).toEqual([
      "[Image 1] first attachment",
      "next plain prompt",
      "next plain prompt",
    ])
    expect(promptRequests[1]?.files).toEqual([])
    expect(promptRequests[1]?.id).not.toBe(promptRequests[0]?.id)
  } finally {
    admissionFailure = undefined
    await screen.dispose()
    await image.temporary.cleanup()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("keeps an uncertain attachment admission intact for an exact retry instead of asking to remove it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-tui-attachment-uncertain-"))
  const image = await materializeClipboardImage(root, async (file) => {
    await Bun.write(file, "png")
  })
  promptRequests.length = 0
  admissionFailure = () => json({ error: "upstream unavailable" }, { status: 503 })
  const screen = await renderScreen({
    width: 120,
    height: 40,
    args: { sessionID },
    route,
    clipboard: { read: async () => image },
    settle: "Message YCoding…",
  })
  try {
    const promptRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, promptRow)
    await screen.input.pasteBracketedText("")
    await waitForFrameText(screen, "[Image 1]")
    await screen.input.typeText("uncertain image")
    screen.input.pressEnter()
    await waitForFrameText(screen, "Sending prompt unresolved · Retry send")
    expect(screen.frame()).toContain("[Image 1]")
    expect(screen.frame()).not.toContain("An attachment could not be prepared or admitted")
    expect(await Bun.file(image.temporary.path).exists()).toBe(true)
    expect(promptRequests).toHaveLength(1)

    await retryReceipt(screen)
    await waitForPromptRequests(3)
    await until(async () => !(await Bun.file(image.temporary.path).exists()))
    expect(promptRequests).toHaveLength(3)
    expect(new Set(promptRequests.map((request) => request.id)).size).toBe(1)
    expect(promptRequests[1]?.files?.[0]?.uri).toStartWith("file:")
    expect(promptRequests[2]?.files?.[0]?.uri).toStartWith("ycoding-attachment://sha256/")
    expect(await Bun.file(image.temporary.path).exists()).toBe(false)
  } finally {
    admissionFailure = undefined
    await screen.dispose()
    await image.temporary.cleanup()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("never mints a fresh prompt ID after a durable conflict", async () => {
  promptRequests.length = 0
  conflictNextPrompt = true
  const screen = await renderScreen({
    width: 120,
    height: 40,
    args: { sessionID },
    route,
    settle: "Message YCoding…",
  })
  try {
    const promptRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, promptRow)
    await screen.input.typeText("stable conflict retry")
    screen.input.pressEnter()
    await waitForFrameText(screen, "Prompt ID conflict · Retry send")
    expect(promptRequests).toHaveLength(1)

    await retryReceipt(screen)
    await waitForPromptRequests(3)
    expect(promptRequests).toHaveLength(3)
    expect(new Set(promptRequests.map((request) => request.id)).size).toBe(1)
    expect(promptRequests.map((request) => request.resume)).toEqual([false, false, true])
  } finally {
    conflictNextPrompt = false
    await screen.dispose()
  }
}, 30_000)

test("Escape leaves owned admission running and its completion preserves the new draft", async () => {
  promptRequests.length = 0
  admissionAbortObserved = false
  admissionGate = new Promise<void>((resolve) => {
    releaseAdmission = resolve
  })
  const screen = await renderScreen({
    width: 80,
    height: 24,
    args: { sessionID },
    route,
    settle: "Message YCoding…",
  })
  try {
    const promptRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, promptRow)
    await screen.input.typeText("cancel this admission")
    screen.input.pressEnter()
    await waitForPromptRequests(1)
    expect(composer(screen.renderer.root)?.plainText).toBe("")
    await screen.input.typeText("new draft during admission")

    screen.input.pressKey("ESCAPE")
    await screen.renderOnce()
    expect(admissionAbortObserved).toBe(false)
    expect(composer(screen.renderer.root)?.plainText).toBe("new draft during admission")
    expect(promptRequests).toHaveLength(1)

    releaseAdmission?.()
    await waitForPromptRequests(2)
    await screen.renderOnce()
    expect(admissionAbortObserved).toBe(false)
    expect(screen.frame()).toContain("cancel this admission")
    expect(composer(screen.renderer.root)?.plainText).toBe("new draft during admission")
    expect(promptRequests).toHaveLength(2)
    expect(new Set(promptRequests.map((request) => request.id)).size).toBe(1)
  } finally {
    releaseAdmission?.()
    admissionGate = undefined
    releaseAdmission = undefined
    await screen.dispose()
  }
}, 30_000)

test("submits virtualized large pastes at full length without blocking the composer", async () => {
  const pasted = Array.from({ length: 12 }, (_, index) => `large-paste-line-${index}-${"x".repeat(80)}`).join("\n")
  submittedPrompt = undefined
  const screen = await renderScreen({ width: 100, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    const promptRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, promptRow)
    await screen.input.pasteBracketedText(pasted)
    await waitForFrameText(screen, "[Pasted ~12 lines]")
    expect(screen.frame()).not.toContain("large-paste-line-0-")

    screen.input.pressEnter()
    await until(() => submittedText() === pasted)
    const submitted = submittedText()
    if (submitted === undefined) throw new Error("large paste was not submitted")
    expect(submitted).toBe(pasted)
  } finally {
    await screen.dispose()
  }
})

test("defers a running Session's model selection until the next prompt, then switches before admission", async () => {
  submittedPrompt = undefined
  submittedResumes.length = 0
  promptRequests.length = 0
  modelSwitchRequests.length = 0
  interruptRequests.length = 0
  modelPromptOrder.length = 0
  modelSwitchStarted = false
  modelSwitchGate = undefined
  sessionRunning = true
  const screen = await renderScreen({ width: 100, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    let promptRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, promptRow)
    await screen.input.typeText("/variants")
    screen.input.pressEnter()
    await waitForFrameText(screen, "Select variant")
    screen.input.pressKey("ARROW_DOWN")
    screen.input.pressEnter()
    await waitForFrameText(screen, "Message YCoding…")
    await screen.renderOnce()
    expect(modelSwitchRequests).toEqual([])
    expect(interruptRequests).toEqual([])
    expect(promptRequests).toEqual([])

    modelSwitchGate = new Promise<void>((resolve) => {
      releaseModelSwitch = resolve
    })

    promptRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, promptRow)
    await screen.input.typeText("steer on the selected variant")
    screen.input.pressEnter()
    await until(() => modelSwitchStarted)

    expect(modelSwitchStarted).toBe(true)
    // The switch is awaited before any admission: nothing is admitted while it is in flight.
    expect(submittedText()).toBeUndefined()
    expect(modelSwitchRequests).toEqual([{ providerID: "openai", id: "gpt-5.6-terra", variant: "low" }])
    expect(interruptRequests).toEqual([])
    expect(modelPromptOrder).toEqual(["model"])
    releaseModelSwitch?.()
    await waitForPromptRequests(2)

    expect(submittedText()).toBe("steer on the selected variant")
    // Admission precedes the explicit resume, and the resume keeps the same submission.
    expect(submittedResumes).toEqual([false, true])
    expect(modelPromptOrder).toEqual(["model", "admit", "resume"])
  } finally {
    releaseModelSwitch?.()
    modelSwitchGate = undefined
    releaseModelSwitch = undefined
    sessionRunning = false
    await screen.dispose()
  }
})

test("a failed in-flight selection admits nothing and retains the draft", async () => {
  submittedPrompt = undefined
  submittedResumes.length = 0
  promptRequests.length = 0
  modelSwitchStarted = false
  modelSwitchRequests.length = 0
  modelSwitchFailure = () => json({ error: "simulated switch failure" }, { status: 500 })
  modelSwitchGate = undefined
  const screen = await renderScreen({ width: 100, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    let promptRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, promptRow)
    // `/variants` records a desired target without touching the Session.
    await screen.input.typeText("/variants")
    screen.input.pressEnter()
    await waitForFrameText(screen, "Select variant")
    screen.input.pressKey("ARROW_DOWN")
    screen.input.pressEnter()
    await waitForFrameText(screen, "Message YCoding…")
    expect(modelSwitchStarted).toBe(false)
    expect(modelSwitchRequests).toEqual([])

    modelSwitchGate = new Promise<void>((resolve) => {
      releaseModelSwitch = resolve
    })

    promptRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, promptRow)
    await screen.input.typeText("draft survives failed selection")
    screen.input.pressEnter()
    await until(() => modelSwitchStarted)
    expect(modelSwitchStarted).toBe(true)
    // Submission is waiting on the prompt-time switch; nothing has been admitted on the old model.
    expect(promptRequests).toHaveLength(0)

    releaseModelSwitch?.()
    await waitForFrameText(screen, "Switching model unresolved · Retry send")
    // The failed selection admits nothing and keeps the draft for retry.
    expect(promptRequests).toHaveLength(0)
    expect(submittedText()).toBeUndefined()
    expect(screen.frame()).toContain("draft survives failed selection")
  } finally {
    releaseModelSwitch?.()
    modelSwitchGate = undefined
    releaseModelSwitch = undefined
    modelSwitchFailure = undefined
    await screen.dispose()
  }
}, 30_000)

test("a blocked model switch retains the draft and admits nothing", async () => {
  const blocked = {
    _tag: "ModelSwitchBlockedError",
    status: "blocked",
    currentModel: { providerID: "openai", id: "gpt-5.6-terra", variant: "high" },
    targetModel: { providerID: "openai", id: "gpt-5.6-terra", variant: "low" },
    currentContextTokens: 120000,
    targetSafeInputTokens: 80000,
    requiredReductionTokens: 40000,
    maximumSafeSummaryBoundary: "msg_boundary_1",
    reason: "context-window-exceeded",
  }
  async function blockedRoute(url: URL, request: Request) {
    if (url.pathname === `/api/session/${sessionID}/model` && request.method === "POST")
      return json(blocked, { status: 409 })
    return route(url, request)
  }
  submittedPrompt = undefined
  submittedResumes.length = 0
  promptRequests.length = 0
  modelSwitchGate = undefined
  releaseModelSwitch = undefined
  const screen = await renderScreen({
    width: 100,
    height: 69,
    args: { sessionID },
    route: blockedRoute,
    settle: "Message YCoding…",
  })
  try {
    let promptRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, promptRow)
    await screen.input.typeText("/variants")
    screen.input.pressEnter()
    await waitForFrameText(screen, "Select variant")
    screen.input.pressKey("ARROW_DOWN")
    screen.input.pressEnter()
    await waitForFrameText(screen, "Message YCoding…")

    promptRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, promptRow)
    await screen.input.typeText("prompt survives blocked switch")
    screen.input.pressEnter()
    await waitForFrameText(screen, "Switching model unresolved · Retry send")

    // No admission and no wake: the failed switch performs neither.
    expect(promptRequests).toHaveLength(0)
    expect(submittedText()).toBeUndefined()
    expect(screen.frame()).toContain("prompt survives blocked switch")
    expect(screen.frame()).not.toContain("Failed to send prompt or activate skill")
  } finally {
    await screen.dispose()
  }
})

test("stacks the full-width subagent picker above the prompt with legible model metadata", async () => {
  const width = 220
  const screen = await renderScreen({ width, height: 69, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    await waitForFrameText(screen, "1/1 running")
    const promptRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    expect(promptRow).toBeGreaterThan(-1)
    await screen.mouse.click(3, promptRow)
    screen.input.pressKey("ARROW_DOWN")
    await waitForFrameText(screen, "reviewer")
    expect(screen.frame()).toContain("reviewer")
    const lines = screen.lines()
    const tabs = lines.findIndex((line) => line.includes("Subagents"))
    const prompt = lines.findIndex((line) => line.includes("Message YCoding…"))
    const row = lines.findIndex((line) => line.includes("reviewer"))
    const frame = lines.join("\n")
    const spans = screen.spans().lines.flatMap((line) => line.spans)
    const selectedAgent = spans.find((span) => span.text.includes("reviewer"))
    const status = spans.find((span) => span.text.includes("running"))
    const description = spans.find((span) => span.text.includes("· Inspect"))

    expect(tabs).toBeLessThan(prompt)
    expect(lines[tabs]).not.toContain("Prompt")
    expect(lines[tabs]?.indexOf("Subagents")).toBe(3)
    expect(lines[tabs]?.indexOf("Subagents")).toBeLessThan(lines[tabs].indexOf("Shell"))
    expect(row).toBeGreaterThan(tabs)
    expect(frame).toContain("openai/gpt-5.6-terra#high")
    expect(frame).toContain("attached")
    expect(selectedAgent?.fg.toInts()).not.toEqual(selectedAgent?.bg.toInts())
    expect(selectedAgent?.bg.toInts()).not.toEqual([50, 130, 255, 255])
    expect(status?.fg.toInts()).not.toEqual(selectedAgent?.fg.toInts())
    expect(description?.fg.toInts()).not.toEqual(description?.bg.toInts())
    expect(lines[row]?.length).toBeLessThanOrEqual(width)
  } finally {
    await screen.dispose()
  }
}, 120_000)
