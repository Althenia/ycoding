/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { json } from "./fixture/tui-client"
import { renderScreen } from "./screen/harness"

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

function submittedText(): string | undefined {
  return submittedPrompt
}

function isPromptBody(value: unknown): value is { id: string; text: string; delivery?: "steer" | "queue" } {
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

async function route(url: URL, request: Request) {
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/prompt` && request.method === "POST") {
    const body: unknown = await request.json()
    if (!isPromptBody(body)) return json({ error: "invalid prompt" }, { status: 400 })
    submittedPrompt = body.text
    return json({
      data: {
        id: body.id,
        sessionID,
        admittedSeq: 1,
        timeCreated: Date.now(),
        type: "user",
        data: { text: body.text },
        delivery: body.delivery ?? "steer",
      },
    })
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
      "/api/skill",
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
          variants: [{ id: session.model.variant }],
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
      data: [{ id: "build", name: "Build", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] }],
    })
  return undefined
}

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
    // naturally wrapped logical line rather than explicit newline rows.
    for (let chunk = 0; chunk < 5; chunk++) {
      await screen.input.pasteBracketedText(`wrap-${chunk}-${"x".repeat(130)}`)
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
    expect(lines[tabs]?.indexOf("Subagents")).toBeLessThan(lines[tabs]!.indexOf("Shell"))
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
