/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { json } from "./fixture/tui-client"
import { renderScreen } from "./screen/harness"
import { materializeClipboardImage } from "../src/clipboard"
import { testRender } from "@opentui/solid"
import { createSignal, onMount } from "solid-js"
import { StartupGate } from "../src/component/startup-loading"

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
let submittedResume: boolean | undefined
let failNextPrompt = false
let conflictNextPrompt = false
let holdAdmissionUntilCancelled = false
let admissionAbortObserved = false
let modelSwitchGate: Promise<void> | undefined
let releaseModelSwitch: (() => void) | undefined
let modelSwitchStarted = false
const promptRequests: Array<{
  id: string
  text: string
  resume?: boolean
  files?: Array<{ uri: string; name?: string }>
}> = []
let failNextWake = false
let wakeGate: Promise<void> | undefined
let releaseWake: (() => void) | undefined
const skillRequests: Array<{ id: string; skill: string }> = []
let failNextSkill = false
let skillGate: Promise<void> | undefined
let releaseSkill: (() => void) | undefined

function submittedText(): string | undefined {
  return submittedPrompt
}

function submittedResumeValue(): boolean | undefined {
  return submittedResume
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
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/prompt` && request.method === "POST") {
    const body: unknown = await request.json()
    if (!isPromptBody(body)) return json({ error: "invalid prompt" }, { status: 400 })
    promptRequests.push(body)
    if (holdAdmissionUntilCancelled && !body.resume) {
      return new Promise<Response>((_resolve, reject) => {
        const cancel = () => {
          admissionAbortObserved = true
          reject(request.signal.reason)
        }
        if (request.signal.aborted) return cancel()
        request.signal.addEventListener("abort", cancel, { once: true })
      })
    }
    if (conflictNextPrompt) {
      conflictNextPrompt = false
      return json({ message: "Prompt message ID conflicts with an existing durable record" }, { status: 409 })
    }
    if (failNextPrompt) {
      failNextPrompt = false
      return json({ error: "simulated admission failure" }, { status: 500 })
    }
    if (body.resume && wakeGate) await wakeGate
    if (body.resume && failNextWake) {
      failNextWake = false
      return json({ error: "simulated wake failure" }, { status: 500 })
    }
    submittedPrompt = body.text
    submittedResume = body.resume
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
    modelSwitchStarted = true
    if (modelSwitchGate) await modelSwitchGate
    return new Response(null, { status: 204 })
  }
  if (url.pathname === `/api/session/${sessionID}/skill` && request.method === "POST") {
    const body: unknown = await request.json()
    if (!isSkillBody(body)) return json({ error: "invalid skill" }, { status: 400 })
    skillRequests.push(body)
    if (skillGate) await skillGate
    if (failNextSkill) {
      failNextSkill = false
      return json({ error: "simulated skill rejection" }, { status: 400 })
    }
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
    await Bun.sleep(20)
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

async function waitForFrameText(screen: { frame(): string }, text: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (screen.frame().includes(text)) return
    await Bun.sleep(20)
  }
  expect(screen.frame()).toContain(text)
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
    await Bun.sleep(100)
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

    screen.input.pressEnter()
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
    await Bun.sleep(50)
  } finally {
    await screen.dispose()
  }
})

test("blocks a dead clipboard image until the user explicitly removes it and sends", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ycoding-tui-clipboard-regression-"))
  const image = await materializeClipboardImage(root, async (file) => {
    await Bun.write(file, "png")
  })
  failNextPrompt = false
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
    await waitForFrameText(screen, "Message YCoding…")
    expect(submittedText()).toBe("keep this text")
  } finally {
    await screen.dispose()
    await image.temporary.cleanup()
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
    await Bun.sleep(50)

    expect(screen.frame()).toContain("edited while reading 中文")
    expect(screen.frame()).not.toContain("[Image 1]")
    expect(await Bun.file(image.temporary.path).exists()).toBe(false)
  } finally {
    releaseRead()
    await screen.dispose()
    await image.temporary.cleanup()
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

    await waitForFrameText(screen, "Prompt admitted · waking session…")
    expect(promptRequests).toHaveLength(2)
    expect(promptRequests[0]?.resume).toBe(false)
    expect(promptRequests[1]?.resume).toBe(true)
    expect(promptRequests[1]?.files?.[0]?.uri).toStartWith("ycoding-attachment://sha256/")
    expect(await Bun.file(image.temporary.path).exists()).toBe(false)

    releaseWake?.()
    await waitForFrameText(screen, "Prompt admitted but the wake failed")
    expect(screen.frame()).toContain("retry this image")
    screen.input.pressEnter()
    await waitForFrameText(screen, "Message YCoding…")

    expect(promptRequests).toHaveLength(4)
    expect(new Set(promptRequests.map((request) => request.id)).size).toBe(1)
    expect(promptRequests[2]?.files?.[0]?.uri).toStartWith("ycoding-attachment://sha256/")
    expect(promptRequests[3]?.resume).toBe(true)
  } finally {
    releaseWake?.()
    wakeGate = undefined
    releaseWake = undefined
    failNextWake = false
    await screen.dispose()
    await image.temporary.cleanup()
  }
}, 30_000)

test("shows skill progress and lets a plain next draft send after a rejected activation", async () => {
  promptRequests.length = 0
  skillRequests.length = 0
  failNextSkill = true
  skillGate = new Promise<void>((resolve) => (releaseSkill = resolve))
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
    await screen.input.typeText("$review first")
    screen.input.pressEnter()
    await waitForFrameText(screen, "Loading skill 1/1…")
    expect(promptRequests).toHaveLength(0)

    releaseSkill?.()
    await waitForFrameText(screen, "Skill activation failed · draft retained")
    expect(screen.frame()).toContain("$review first")
    expect(skillRequests).toHaveLength(1)
    for (let index = 0; index < "$review first".length; index++) screen.input.pressKey("BACKSPACE")
    await screen.input.typeText("plain next")
    screen.input.pressEnter()
    await waitForFrameText(screen, "Message YCoding…")

    expect(skillRequests).toHaveLength(1)
    expect(promptRequests).toHaveLength(2)
    expect(promptRequests.every((request) => request.text === "plain next")).toBe(true)
    expect(new Set(promptRequests.map((request) => request.id)).size).toBe(1)
  } finally {
    releaseSkill?.()
    skillGate = undefined
    releaseSkill = undefined
    failNextSkill = false
    await screen.dispose()
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
    await waitForFrameText(screen, "Checking whether sent · retry keeps the same prompt ID")
    expect(promptRequests).toHaveLength(1)

    screen.input.pressEnter()
    await waitForFrameText(screen, "Message YCoding…")
    expect(promptRequests).toHaveLength(3)
    expect(new Set(promptRequests.map((request) => request.id)).size).toBe(1)
    expect(promptRequests.map((request) => request.resume)).toEqual([false, false, true])
  } finally {
    conflictNextPrompt = false
    await screen.dispose()
  }
}, 30_000)

test("cancels the owned Client admission request and keeps its stable retry identity", async () => {
  promptRequests.length = 0
  admissionAbortObserved = false
  holdAdmissionUntilCancelled = true
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
    await waitForFrameText(screen, "Preparing attachments / sending…")

    screen.input.pressKey("ESCAPE")
    await waitForFrameText(screen, "Cancelled · draft retained")
    expect(admissionAbortObserved).toBe(true)
    expect(screen.frame()).toContain("cancel this admission")
    expect(promptRequests).toHaveLength(1)

    holdAdmissionUntilCancelled = false
    screen.input.pressEnter()
    await waitForFrameText(screen, "Message YCoding…")
    expect(promptRequests).toHaveLength(3)
    expect(new Set(promptRequests.map((request) => request.id)).size).toBe(1)
  } finally {
    holdAdmissionUntilCancelled = false
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
    await waitForFrameText(screen, "Message YCoding…")
    const submitted = submittedText()
    if (submitted === undefined) throw new Error("large paste was not submitted")
    expect(submitted).toBe(pasted)
  } finally {
    await screen.dispose()
  }
})

test("admits a steer before an in-flight model variant switch and reuses the composer", async () => {
  submittedPrompt = undefined
  submittedResume = undefined
  modelSwitchStarted = false
  modelSwitchGate = new Promise<void>((resolve) => {
    releaseModelSwitch = resolve
  })
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

    promptRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, promptRow)
    await screen.input.typeText("steer on the selected variant")
    screen.input.pressEnter()
    for (let attempt = 0; attempt < 100; attempt++) {
      if (modelSwitchStarted) break
      await Bun.sleep(10)
    }

    expect(modelSwitchStarted).toBe(true)
    expect(submittedText()).toBe("steer on the selected variant")
    expect(submittedResumeValue()).toBe(false)
    releaseModelSwitch?.()
    await waitForFrameText(screen, "Message YCoding…")

    promptRow = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, promptRow)
    await screen.input.typeText("second steer")
    screen.input.pressEnter()
    for (let attempt = 0; attempt < 100 && submittedText() !== "second steer"; attempt++) await Bun.sleep(10)
    expect(submittedText()).toBe("second steer")
  } finally {
    releaseModelSwitch?.()
    modelSwitchGate = undefined
    releaseModelSwitch = undefined
    await screen.dispose()
  }
})

test("submits the prompt when a model switch is blocked and warns instead of failing", async () => {
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
  submittedResume = undefined
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
    await waitForFrameText(screen, "Model switch needs attention")
    expect(submittedText()).toBe("prompt survives blocked switch")
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
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline && !screen.frame().includes("reviewer")) await Bun.sleep(50)
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
