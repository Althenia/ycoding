/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { KeyEvent } from "@opentui/core"
import type { SessionAutonomyView, SessionMessageInfo } from "@ycoding-ai/client"
import { json, sessionSnapshot } from "../fixture/tui-client"
import { localAutonomyView } from "../../src/util/session-autonomy"
import { renderScreen } from "./harness"
import { saveScreenCapture } from "../fixture/screen-capture"
import { autonomyState } from "../fixture/autonomy"

const sessionID = "ses_review_box"
const directory = "/tmp/ycoding/session-review-box"
const location = { directory, project: { id: "proj_review_box", directory } }
const session = {
  id: sessionID,
  title: "Review box",
  projectID: "proj_review_box",
  location: { directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 9 },
}
const fingerprint = "c".repeat(64)
const guardrailItem = {
  itemID: "rvw_guardrail",
  kind: "guardrail",
  reason: "escalated",
  choice: "escalate",
  confidence: 0.42,
  grades: [
    { choice: "approve", confidence: 0.1, evidence: "The repository state needs inspection" },
    { choice: "reject", confidence: 0.01, evidence: "Target risk is not established" },
    { choice: "escalate", confidence: 0.42, evidence: "A human should verify the target" },
  ],
  origin: { requestID: "grq_1" },
  payload: {
    type: "guardrail",
    action: "shell",
    resources: ["git reset --hard"],
    ruleIDs: ["standard.review.git-destructive"],
    reason: "Destructive Git operation",
    hardReview: true,
    directories: [],
    fingerprint,
    requestID: "grq_1",
  },
  sessionID,
  rootSessionID: sessionID,
  sessionTitle: "Review box",
  created: 2,
}
const questionItem = {
  itemID: "rvw_question",
  kind: "question",
  reason: "free_text",
  origin: { messageID: "msg_1", callID: "call_1" },
  payload: {
    type: "form",
    title: "Pick a target",
    questionTool: true,
    fields: [
      {
        key: "target",
        type: "string",
        title: "Target",
        required: true,
        options: [
          { value: "staging", label: "Staging" },
          { value: "prod", label: "Production" },
        ],
      },
    ],
  },
  sessionID,
  rootSessionID: sessionID,
  sessionTitle: "Review box",
  created: 3,
}
const messages: SessionMessageInfo[] = [
  { id: "msg_user", type: "user", text: "Ship it", time: { created: 1 } },
  {
    id: "msg_assistant",
    type: "assistant",
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    content: [{ type: "text", text: "Working on it." }],
    time: { created: 2, completed: 3 },
  },
]

function routeFor(state: {
  autonomy: SessionAutonomyView
  items: unknown[]
  decisions: unknown[]
  decide?: () => Promise<Response>
}) {
  return async (url: URL, request: Request) => {
    if (url.pathname === "/api/fs/list") return json({ location, data: [] })
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
    if (url.pathname === `/api/session/${sessionID}/snapshot`) return sessionSnapshot(sessionID, messages, { session })
    if (url.pathname === `/api/session/${sessionID}/pending`) return json({ data: [] })
    if (url.pathname === `/api/session/${sessionID}/guardrail/request`) return json({ location, data: [] })
    if (url.pathname === `/api/session/${sessionID}/review`) return json({ data: state.items })
    const decide = /^\/api\/session\/[^/]+\/review\/([^/]+)\/decide$/.exec(url.pathname)
    if (decide && request.method === "POST") {
      state.decisions.push({ itemID: decide[1], body: await request.json() })
      if (state.decide) return state.decide()
      state.items = state.items.filter((item) => (item as { itemID: string }).itemID !== decide[1])
      return new Response(null, { status: 204 })
    }
    if (url.pathname === `/api/session/${sessionID}/subagent`)
      return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
    if (
      [
        `/api/session/${sessionID}/permission`,
        `/api/session/${sessionID}/skills`,
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
    if (url.pathname === `/api/session/${sessionID}/todo`) return json({ location, data: [] })
    if (url.pathname === `/api/session/${sessionID}/autonomy`) {
      if (request.method === "PUT") {
        const value = (await request.json()) as { sleep?: boolean }
        if (value.sleep === false) state.autonomy = localAutonomyView(autonomyState())
        if (value.sleep === true)
          state.autonomy = {
            ...state.autonomy,
            sleep: {},
          }
      }
      return json({ location, data: state.autonomy })
    }
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
    if (url.pathname === `/api/session/${sessionID}/diagnostics`)
      return json({
        data: {
          model: session.model,
          context: { total: 0, percent: 0 },
          tokens: { uncachedInput: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          cache: { eligible: 0, mechanism: "unreported", readReported: false, writeReported: false },
          requests: {
            logical: 0,
            physical: 0,
            helpers: 0,
            continued: 0,
            fallback: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      })
    if (url.pathname === `/api/session/${sessionID}/usage`)
      return json({
        data: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, cost: 0, tokens: session.tokens },
      })
    if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
    if (url.pathname === "/api/model")
      return json({
        location,
        data: [
          {
            id: "claude-opus-5",
            modelID: "claude-opus-5",
            providerID: "anthropic",
            name: "Claude Opus 5",
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
    if (url.pathname === "/api/provider") return json({ location, data: [{ id: "anthropic", name: "Claude" }] })
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
}

async function waitFor(check: () => boolean, label: string) {
  const deadline = Date.now() + 5000
  while (!check() && Date.now() < deadline) await Bun.sleep(10)
  if (!check()) throw new Error(`Timed out waiting for ${label}`)
}

function pageDown(screen: Awaited<ReturnType<typeof renderScreen>>) {
  screen.renderer.keyInput.emit(
    "keypress",
    new KeyEvent({
      name: "pagedown",
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      sequence: "\u001b[6~",
      number: false,
      raw: "\u001b[6~",
      eventType: "press",
      source: "raw",
    }),
  )
}

test("review box lists deferred items with counts and decides a hard guardrail item", async () => {
  const state = {
    autonomy: localAutonomyView(autonomyState()),
    items: [guardrailItem, questionItem] as unknown[],
    decisions: [] as unknown[],
  }
  const screen = await renderScreen({
    width: 200,
    height: 50,
    args: { sessionID },
    settle: "Review · 2 waiting",
    route: routeFor(state),
  })
  try {
    const frame = screen.frame()
    expect(frame).toContain("review 2")
    expect(frame).toContain("waiting for your review")
    expect(frame).toContain("Guardrail review")
    expect(frame).toContain("decision model escalated · escalate · 0.42")
    expect(frame).toContain("grade approve 0.1 · The repository state needs inspection")
    expect(frame).toContain("grade escalate (selected) 0.42 · A human should verify the target")
    expect(frame).toContain("Pick a target")
    expect(frame).toContain("2 waiting")
    await saveScreenCapture("review-box-awake-200", screen)

    const lines = screen.lines()
    const decideRow = lines.findIndex((line) => line.includes("Decide"))
    await screen.mouse.click(lines[decideRow]!.indexOf("Decide") + 1, decideRow)
    await waitFor(() => screen.frame().includes("Guardrail blocked"), "guardrail editor")
    expect(screen.frame()).toContain("git reset --hard")
    expect(screen.frame()).toContain("grade approve 0.1 · The repository state needs inspection")
    expect(screen.frame()).toContain("grade escalate (selected) 0.42 · A human should verify the target")
    expect(screen.frame()).not.toContain("Allow for this session")
    expect(screen.frame()).not.toContain("Guardrail review")
    await saveScreenCapture("review-box-hard-editor-200", screen)

    screen.input.pressKey("l")
    screen.input.pressEnter()
    await waitFor(() => state.decisions.length === 1, "review decide request")
    expect(state.decisions).toEqual([
      { itemID: "rvw_guardrail", body: { decision: { kind: "guardrail", reply: "once" } } },
    ])
    await waitFor(() => screen.frame().includes("Review · 1 waiting"), "box after decide")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("long grades remain scrollable with hard-review controls at 80 by 24", async () => {
  const state = {
    autonomy: localAutonomyView(autonomyState()),
    items: [
      {
        ...guardrailItem,
        grades: [
          { choice: "approve", confidence: 0.1, evidence: "The target needs verification" },
          { choice: "reject", confidence: 0.01, evidence: "Target risk is not established" },
          { choice: "escalate", confidence: 0.42, evidence: "bounded ".repeat(61) + "GRADE-END!!!" },
        ],
      },
    ] as unknown[],
    decisions: [] as unknown[],
  }
  const screen = await renderScreen({
    width: 80,
    height: 24,
    args: { sessionID },
    settle: "Review · 1 waiting",
    route: routeFor(state),
  })
  try {
    expect(screen.frame()).toContain("Message YCoding…")
    const row = screen.lines().findIndex((line) => line.includes("Decide"))
    await screen.mouse.click(screen.lines()[row]!.indexOf("Decide") + 1, row)
    await waitFor(() => screen.frame().includes("Guardrail blocked"), "graded guardrail editor")
    expect(screen.frame()).toContain("Allow once")
    expect(screen.frame()).toContain("Deny")
    expect(screen.frame()).toContain("Not now")
    expect(screen.frame()).not.toContain("Allow for this session")
    expect(screen.frame()).toContain("grade escalate (selected)")
    await saveScreenCapture("guardrail-grades-selected-80x24", screen)
    for (let index = 0; index < 4 && !screen.frame().includes("GRADE-END!!!"); index++) {
      pageDown(screen)
      await screen.renderOnce()
    }
    await waitFor(() => screen.frame().includes("GRADE-END!!!"), "the last grade evidence line")
    expect(screen.frame()).toContain("Allow once")
    expect(screen.frame()).toContain("Not now")
    expect(state.decisions).toEqual([])
    await saveScreenCapture("guardrail-grades-80x24", screen)
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("waking with open review items expands the box and notifies once", async () => {
  const state = {
    autonomy: localAutonomyView(autonomyState({ sleep: {} })),
    items: [guardrailItem, questionItem] as unknown[],
    decisions: [] as unknown[],
  }
  const screen = await renderScreen({
    width: 200,
    height: 50,
    args: { sessionID },
    settle: "Review · 2 waiting",
    route: routeFor(state),
  })
  try {
    await waitFor(() => /Answers\s+review box/.test(screen.frame()) && !screen.frame().includes("Guardrail review"), "asleep autonomy with a collapsed review box")
    expect(screen.frame()).toMatch(/Answers\s+review box/)
    expect(screen.frame()).not.toContain("Guardrail review")
    await screen.waitForEventStream()
    state.autonomy = localAutonomyView(autonomyState())
    screen.events.emit({
      id: "evt_family_wake",
      created: 100,
      type: "session.context.observed",
      durable: { aggregateID: sessionID, seq: 100, version: 1 },
      data: { sessionID, source: "session-state", text: "The user is back. Sleep mode is off." },
    } as never)
    await waitFor(() => screen.frame().includes("2 items waiting for your review"), "wake toast")
    expect(screen.frame()).toContain("Guardrail review")
    await saveScreenCapture("review-box-wake-200", screen)
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("review items rehydrate after remount without making decisions", async () => {
  const state = {
    autonomy: localAutonomyView(autonomyState()),
    items: [guardrailItem, questionItem],
    decisions: [],
  }
  for (const width of [80, 120]) {
    const screen = await renderScreen({
      width,
      height: 50,
      args: { sessionID },
      settle: "Review · 2 waiting",
      route: routeFor(state),
    })
    try {
      expect(screen.frame()).toContain("Guardrail review")
      expect(screen.frame()).toContain("Pick a target")
      expect(state.decisions).toEqual([])
      await saveScreenCapture(`review-box-reload-${width}`, screen)
    } finally {
      await screen.dispose()
    }
  }
}, 30_000)

test("an uncertain review decision stays visible and repeated input never replays it", async () => {
  const pending = Promise.withResolvers<Response>()
  const state = {
    autonomy: localAutonomyView(autonomyState()),
    items: [guardrailItem],
    decisions: [] as unknown[],
    decide: () => pending.promise,
  }
  const screen = await renderScreen({
    width: 120,
    height: 50,
    args: { sessionID },
    settle: "Review · 1 waiting",
    route: routeFor(state),
  })
  try {
    const lines = screen.lines()
    const row = lines.findIndex((line) => line.includes("Decide"))
    await screen.mouse.click(lines[row]!.indexOf("Decide") + 1, row)
    await waitFor(() => screen.frame().includes("Guardrail blocked"), "review editor")
    screen.input.pressEnter()
    await waitFor(() => screen.frame().includes("Decision controls unavailable"), "pending decision")
    screen.input.pressEnter()
    expect(state.decisions).toHaveLength(1)
    pending.resolve(json({ message: "Decision outcome unknown" }, { status: 503 }))
    await waitFor(() => screen.frame().includes("Decision unresolved"), "failed decision")
    expect(screen.frame()).toContain("Review · 1 waiting")
    screen.input.pressKey("l")
    screen.input.pressEnter()
    await screen.renderOnce()
    expect(state.decisions).toHaveLength(1)
    await saveScreenCapture("review-box-uncertain-120", screen)
  } finally {
    pending.resolve(new Response(null, { status: 503 }))
    await screen.dispose()
  }
}, 30_000)

for (const exit of ["escape", "not-now", "header"] as const) {
  test(`failed review keeps its ${exit} exit without replaying the decision`, async () => {
    const state = {
      autonomy: localAutonomyView(autonomyState()),
      items: [guardrailItem],
      decisions: [] as unknown[],
      decide: async () => json({ message: "Decision outcome unknown" }, { status: 503 }),
    }
    const screen = await renderScreen({
      width: 120,
      height: 50,
      args: { sessionID },
      settle: "Review · 1 waiting",
      route: routeFor(state),
    })
    try {
      const row = screen.lines().findIndex((line) => line.includes("Decide"))
      await screen.mouse.click(screen.lines()[row]!.indexOf("Decide") + 1, row)
      await waitFor(() => screen.frame().includes("Guardrail blocked"), "failed review editor")
      screen.input.pressEnter()
      await waitFor(() => screen.frame().includes("Decision unresolved"), "uncertain outcome")
      const feedback = screen.frame().match(/Decision unresolved · [^\n│]+/)?.[0].trim()
      expect(feedback).toBeDefined()
      screen.input.pressEnter()
      await screen.renderOnce()
      expect(state.decisions).toHaveLength(1)
      if (exit === "escape") screen.input.pressKey("ESCAPE")
      if (exit === "not-now") {
        const line = screen.lines().findIndex((value) => value.includes("Not now"))
        await screen.mouse.click(screen.lines()[line]!.indexOf("Not now") + 1, line)
      }
      if (exit === "header") {
        const line = screen.lines().findIndex((value) => value.includes("Guardrail blocked"))
        await screen.mouse.click(screen.lines()[line]!.lastIndexOf("esc") + 1, line)
      }
      await waitFor(
        () => !screen.frame().includes("Guardrail blocked") && screen.frame().includes("Message YCoding…"),
        "non-mutating review exit",
      )
      expect(screen.frame()).toContain("Decision unresolved")
      expect(screen.frame()).toContain(feedback!)
      expect(state.decisions).toHaveLength(1)
      if (exit === "escape") {
        const details = screen.lines().findIndex((line) => line.includes("Details"))
        await screen.mouse.click(screen.lines()[details]!.indexOf("Details") + 1, details)
        await waitFor(() => screen.frame().includes("Guardrail blocked"), "read-only failed review details")
        screen.input.pressEnter()
        await screen.renderOnce()
        expect(state.decisions).toHaveLength(1)
        screen.input.pressKey("ESCAPE")
        await waitFor(() => screen.frame().includes("Message YCoding…"), "read-only details exit")
      }
    } finally {
      await screen.dispose()
    }
  }, 30_000)
}

test("failed child review answer can close without resubmission", async () => {
  const state = {
    autonomy: localAutonomyView(autonomyState()),
    items: [
      {
        ...guardrailItem,
        kind: "subagent_question",
        origin: { questionID: "qst_review_child" },
        payload: { type: "subagent_question", text: "Choose a deployment target" },
      },
    ],
    decisions: [] as unknown[],
    decide: async () => json({ message: "Answer outcome unknown" }, { status: 503 }),
  }
  const screen = await renderScreen({
    width: 120,
    height: 40,
    args: { sessionID },
    settle: "Review · 1 waiting",
    route: routeFor(state),
  })
  try {
    const row = screen.lines().findIndex((line) => line.includes("Answer"))
    await screen.mouse.click(screen.lines()[row]!.indexOf("Answer") + 1, row)
    await waitFor(() => screen.frame().includes("Enter answer"), "child review editor")
    await screen.input.typeText("Use staging")
    screen.input.pressEnter()
    await waitFor(() => screen.frame().includes("Decision unresolved"), "failed child answer")
    screen.input.pressKey("ESCAPE")
    await waitFor(() => screen.frame().includes("Message YCoding…"), "child review exit")
    expect(screen.frame()).toContain("Decision unresolved")
    expect(state.decisions).toHaveLength(1)
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("focused review owner opens by keyboard without editing or deciding", async () => {
  const child = { ...session, id: "ses_review_owner", parentID: sessionID, title: "Review owner child" }
  const state = {
    autonomy: localAutonomyView(autonomyState()),
    items: [{ ...guardrailItem, sessionID: child.id, sessionTitle: child.title }],
    decisions: [] as unknown[],
  }
  let snapshots = 0
  const base = routeFor(state)
  const screen = await renderScreen({
    width: 120,
    height: 40,
    args: { sessionID },
    settle: "Review · 1 waiting",
    route: async (url, request) => {
      if (url.pathname === `/api/session/${child.id}`) return json({ data: child })
      if (url.pathname === `/api/session/${child.id}/snapshot`) {
        snapshots++
        return sessionSnapshot(child.id, [], { session: child })
      }
      return base(new URL(url.href.replace(`/api/session/${child.id}/`, `/api/session/${sessionID}/`)), request)
    },
  })
  try {
    const prompt = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(4, prompt)
    await screen.input.typeText("o")
    await screen.renderOnce()
    expect(snapshots).toBe(0)
    const row = screen.lines().findIndex((line) => line.includes("Guardrail review"))
    expect(screen.frame()).toContain("o Open")
    await screen.mouse.click(6, row)
    screen.input.pressKey("o")
    await waitFor(() => snapshots > 0, "review owner keyboard navigation")
    expect(screen.frame()).not.toContain("Guardrail blocked")
    expect(state.decisions).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("a full review box preserves the composer at a short viewport", async () => {
  const state = {
    autonomy: localAutonomyView(autonomyState()),
    items: Array.from({ length: 16 }, (_, index) => ({
      ...guardrailItem,
      itemID: `rvw_${index}`,
      created: index + 1,
      payload: { ...guardrailItem.payload, resources: [`echo deferred-${index}`] },
    })),
    decisions: [],
  }
  const screen = await renderScreen({
    width: 80,
    height: 24,
    args: { sessionID },
    settle: "Review · 16 waiting",
    route: routeFor(state),
  })
  try {
    expect(screen.frame()).toContain("Message YCoding…")
    expect(screen.frame()).toContain("Review · 16 waiting")
    expect(screen.lines().findIndex((line) => line.includes("Review · 16 waiting"))).toBeGreaterThan(2)
    expect(state.decisions).toEqual([])
    await saveScreenCapture("review-box-full-80x24", screen)
    const heading = screen.lines().findIndex((line) => line.includes("Review · 16 waiting"))
    await screen.mouse.click(4, heading)
    await waitFor(() => !screen.frame().includes("Guardrail review"), "collapsed review list")
    screen.input.pressEnter()
    await waitFor(() => screen.frame().includes("echo deferred-0"), "keyboard-expanded review list")
    for (let index = 0; index < 20; index++) {
      screen.renderer.keyInput.emit(
        "keypress",
        new KeyEvent({
          name: "pagedown",
          ctrl: false,
          meta: false,
          shift: false,
          option: false,
          sequence: "\u001b[6~",
          number: false,
          raw: "\u001b[6~",
          eventType: "press",
          source: "raw",
        }),
      )
    }
    await waitFor(() => screen.frame().includes("echo deferred-15"), "last deferred item after paging").catch(() => {
      throw new Error(`Review paging focus: ${screen.renderer.currentFocusedRenderable?.id}\n${screen.frame()}`)
    })
    expect(screen.frame()).toContain("Message YCoding…")
    expect(state.decisions).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 30_000)

const recoveryItem = {
  itemID: "rvw_recovery",
  kind: "recovery",
  reason: "restart",
  origin: { requestID: "rec_1" },
  payload: {
    type: "recovery",
    tools: [{ messageID: "msg_tools", callID: "call_edit", name: "edit" }],
  },
  sessionID,
  rootSessionID: sessionID,
  sessionTitle: "Review box",
  created: 4,
  child: { agent: "build", description: "Wire storage" },
}

test("a recovery item decides Continue exactly once and never replays an uncertain decision", async () => {
  const pending = Promise.withResolvers<Response>()
  const state = {
    autonomy: localAutonomyView(autonomyState()),
    items: [recoveryItem] as unknown[],
    decisions: [] as unknown[],
    decide: () => pending.promise,
  }
  const screen = await renderScreen({ width: 120, height: 50, args: { sessionID }, settle: "Review · 1 waiting", route: routeFor(state) })
  try {
    expect(screen.frame()).toContain("Restart recovery")
    expect(screen.frame()).toContain("child restarted during tool execution")
    const lines = screen.lines()
    const row = lines.findIndex((line) => line.includes("Decide"))
    await screen.mouse.click(lines[row]!.indexOf("Decide") + 1, row)
    await waitFor(() => screen.frame().includes("outcome is unknown"), "recovery editor")
    expect(screen.frame()).toContain("call_edit")
    screen.input.pressKey("h")
    screen.input.pressKey("h")
    screen.input.pressEnter()
    await waitFor(() => screen.frame().includes("Decision controls unavailable"), "pending decision")
    screen.input.pressEnter()
    expect(state.decisions).toEqual([{ itemID: "rvw_recovery", body: { decision: { kind: "recovery", choice: "continue" } } }])
    pending.resolve(json({ message: "Decision outcome unknown" }, { status: 503 }))
    await waitFor(() => screen.frame().includes("Decision unresolved"), "failed decision")
    screen.input.pressKey("h")
    screen.input.pressEnter()
    await screen.renderOnce()
    expect(state.decisions).toHaveLength(1)
  } finally {
    pending.resolve(new Response(null, { status: 503 }))
    await screen.dispose()
  }
}, 30_000)

test("a recovery item hydrates from the durable review list and Stop settles it out of the open list", async () => {
  const state = {
    autonomy: localAutonomyView(autonomyState()),
    items: [recoveryItem] as unknown[],
    decisions: [] as unknown[],
  }
  const screen = await renderScreen({ width: 120, height: 50, args: { sessionID }, settle: "Review · 1 waiting", route: routeFor(state) })
  try {
    const lines = screen.lines()
    const row = lines.findIndex((line) => line.includes("Decide"))
    await screen.mouse.click(lines[row]!.indexOf("Decide") + 1, row)
    await waitFor(() => screen.frame().includes("outcome is unknown"), "recovery editor")
    screen.input.pressKey("h")
    screen.input.pressEnter()
    await waitFor(() => state.decisions.length === 1, "stop request")
    expect(state.decisions).toEqual([{ itemID: "rvw_recovery", body: { decision: { kind: "recovery", choice: "stop" } } }])
    await waitFor(() => !screen.frame().includes("Review · 1 waiting"), "box after stop")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("an asleep family shows a disabled guardrail review with its configuration reason and no model attribution", async () => {
  const disabledItem = {
    ...guardrailItem,
    itemID: "rvw_disabled",
    reason: "disabled",
    choice: undefined,
    confidence: undefined,
    grades: undefined,
  }
  const state = {
    autonomy: localAutonomyView(autonomyState({ sleep: {} })),
    items: [disabledItem] as unknown[],
    decisions: [] as unknown[],
  }
  const screen = await renderScreen({ width: 200, height: 50, args: { sessionID }, settle: "Review · 1 waiting", route: routeFor(state) })
  try {
    await screen.waitForEventStream()
    screen.events.emit({
      id: "evt_disabled_wake",
      created: 100,
      type: "session.context.observed",
      durable: { aggregateID: sessionID, seq: 100, version: 1 },
      data: { sessionID, source: "session-state", text: "The user is back. Sleep mode is off." },
    } as never)
    state.autonomy = localAutonomyView(autonomyState())
    await waitFor(() => screen.frame().includes("automatic decisions are disabled"), "disabled reason")
    expect(screen.frame()).toContain("Guardrail review")
    expect(screen.frame()).not.toContain("decision model")
    expect(screen.frame()).not.toContain("escalate")
    const lines = screen.lines()
    const row = lines.findIndex((line) => line.includes("Decide"))
    await screen.mouse.click(lines[row]!.indexOf("Decide") + 1, row)
    await waitFor(() => screen.frame().includes("Guardrail blocked"), "guardrail editor")
    expect(screen.frame()).toContain("automatic decisions are disabled")
    expect(screen.frame()).not.toContain("decision model")
    expect(screen.frame()).not.toContain("(selected)")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("the Sleep palette title and notice keep their review-box qualifier fully visible at 80 by 24", async () => {
  const state = { autonomy: localAutonomyView(autonomyState()), items: [] as unknown[], decisions: [] as unknown[] }
  const screen = await renderScreen({ width: 80, height: 24, args: { sessionID }, settle: "Message YCoding…", route: routeFor(state) })
  try {
    await screen.waitForEventStream()
    screen.input.pressKey("p", { ctrl: true })
    await waitFor(() => screen.frame().includes("Commands"), "palette")
    await screen.input.typeText("Sleep")
    await waitFor(() => screen.frame().includes("Sleep (configured automation, rest to review box)"), "full palette title")
    expect(screen.frame()).not.toContain("…")
    screen.input.pressEnter()
    await waitFor(() => screen.frame().includes("Configured automation applies; rest go to review box."), "full notice sentence")
    expect(screen.frame()).toContain("Sleep on")
    expect(screen.frame()).not.toContain("Decision model answers")
  } finally {
    await screen.dispose()
  }
}, 30_000)
