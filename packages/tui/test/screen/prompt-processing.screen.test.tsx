/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { SessionMessageInfo, SessionPendingInfo, YCodingEvent } from "@ycoding-ai/client"
import { json, sessionSnapshot } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const sessionID = "ses_prompt_processing"
const directory = "/tmp/ycoding/prompt-processing"
const location = { directory, project: { id: "proj_prompt_processing", directory } }
const model = { providerID: "openai", id: "gpt-6.1-sol" }
const session = {
  id: sessionID,
  title: "Prompt processing",
  projectID: location.project.id,
  location,
  agent: "general",
  model,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 4 },
}

function user(id: string, text: string, created: number, consumed?: number): SessionMessageInfo {
  return { id, type: "user", text, time: consumed === undefined ? { created } : { created, consumed } }
}

function assistant(id: string, text: string): SessionMessageInfo {
  return {
    id,
    type: "assistant",
    agent: "general",
    model,
    content: [{ type: "text", text }],
    finish: "stop",
    time: { created: 2, completed: 3 },
  }
}

function pending(id: string, text: string, delivery: "steer" | "queue", timeCreated: number): SessionPendingInfo {
  return { id, sessionID, admittedSeq: timeCreated, timeCreated, type: "user", data: { text }, delivery }
}

function route(messages: SessionMessageInfo[], admitted: SessionPendingInfo[] = []) {
  return (url: URL) => {
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
    if (url.pathname === `/api/session/${sessionID}/snapshot`) return sessionSnapshot(sessionID, messages, { session })
    if (url.pathname === `/api/session/${sessionID}/pending`) return json({ data: admitted })
    if (url.pathname === `/api/session/${sessionID}/subagent`)
      return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
    if (url.pathname === "/api/model")
      return json({
        location,
        data: [
          {
            ...model,
            modelID: model.id,
            name: "GPT Sol",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            time: { released: 0 },
            cost: [],
            variants: [],
            status: "active",
            enabled: true,
            limit: { context: 200000, output: 32000 },
          },
        ],
      })
    if (url.pathname === "/api/provider") return json({ location, data: [{ id: "openai", name: "OpenAI" }] })
    if (url.pathname === "/api/agent")
      return json({
        location,
        data: [
          {
            id: "general",
            name: "General",
            request: { headers: {}, body: {} },
            mode: "primary",
            hidden: false,
            permissions: [],
          },
        ],
      })
    if (
      /\/(permission|skills|todo|guardrail\/request)$/.test(url.pathname) ||
      ["/api/shell", "/api/mcp", "/api/command", "/api/skill"].includes(url.pathname)
    )
      return json({ location, data: [] })
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
          model,
          context: { total: 0, percent: 0 },
          tokens: { uncachedInput: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          cache: { eligible: 0, mechanism: "none", readReported: false, writeReported: false },
          requests: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: session.tokens },
        },
      })
    return undefined
  }
}

async function mount(messages: SessionMessageInfo[], admitted: SessionPendingInfo[], settle: string) {
  const screen = await renderScreen({
    width: 120,
    height: 52,
    args: { sessionID },
    route: route(messages, admitted),
    settle,
    config: { animations: false },
  })
  await screen.waitForEventStream()
  return screen
}

async function text(screen: Awaited<ReturnType<typeof renderScreen>>, value: string) {
  if (screen.frame().includes(value)) return
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      screen.renderer.off("frame", check)
    }
    const check = () => {
      if (!screen.frame().includes(value)) return
      cleanup()
      resolve()
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Missing ${value}:\n${screen.frame()}`))
    }, 4000)
    screen.renderer.on("frame", check)
    screen.renderer.requestRender()
  })
}

async function absent(screen: Awaited<ReturnType<typeof renderScreen>>, value: string) {
  const deadline = Date.now() + 4000
  while (screen.frame().includes(value) && Date.now() < deadline) {
    await screen.renderOnce()
    await Bun.sleep(20)
  }
  if (screen.frame().includes(value)) throw new Error(`still showing ${value}:\n${screen.frame()}`)
}

function receipt(lines: string[], prompt: string) {
  const body = lines.findIndex((line) => line.includes(prompt))
  if (body < 0) throw new Error(`missing ${prompt}`)
  const bottomOffset = lines.slice(body + 1).findIndex((line) => line.includes("╰") && line.includes("╯"))
  if (bottomOffset < 0) throw new Error(`missing bubble for ${prompt}`)
  return lines.slice(body + bottomOffset + 2, body + bottomOffset + 4).join("\n")
}

let sequence = 0
function execution(
  type: "session.execution.started" | "session.execution.interrupted" | "session.execution.failed",
): YCodingEvent {
  sequence += 1
  return {
    id: `evt_execution_${sequence}`,
    created: 10 + sequence,
    type,
    durable: { aggregateID: sessionID, seq: sequence, version: 1 },
    location: { directory },
    data:
      type === "session.execution.failed"
        ? { sessionID, error: { type: "provider.error", message: "Provider failed" } }
        : type === "session.execution.interrupted"
          ? { sessionID, reason: "user" }
          : { sessionID },
  } as YCodingEvent
}

const settled = [
  user("msg_older", "Older prompt", 1, 2),
  assistant("msg_reply", "Older reply"),
  user("msg_latest", "Latest prompt", 3, 4),
  user("msg_promoted", "Promoted prompt", 5),
]

function expectRead(value: string) {
  expect(value).toContain("✓✓")
  expect(value).not.toContain("Processing")
  expect(value).not.toContain("Queued")
  expect(value).not.toContain("Sending")
  expect(value).not.toContain("◷")
}

function expectSent(value: string) {
  expect(value).toContain("✓")
  expect(value).not.toContain("✓✓")
  expect(value).not.toContain("Processing")
  expect(value).not.toContain("Queued")
  expect(value).not.toContain("Sending")
  expect(value).not.toContain("◷")
}

test("a consumed prompt stays read and a promoted prompt shows one check while running", async () => {
  const screen = await mount(settled, [pending("msg_latest", "Latest prompt", "queue", 3)], "Promoted prompt")
  try {
    const lines = () => screen.lines()
    const bubble = (prompt: string) => lines().find((line) => line.includes(prompt)) ?? ""
    expectRead(receipt(lines(), "Latest prompt"))
    expectRead(receipt(lines(), "Older prompt"))
    expectSent(receipt(lines(), "Promoted prompt"))
    screen.events.emit(execution("session.execution.started"))
    await text(screen, "cooking")
    expectRead(receipt(lines(), "Latest prompt"))
    expectRead(receipt(lines(), "Older prompt"))
    expectSent(receipt(lines(), "Promoted prompt"))
    expect(bubble("Latest prompt")).not.toContain("✓")
    expect(bubble("Promoted prompt")).not.toContain("✓")
    expect(bubble("Latest prompt")).not.toContain("Processing")
    expect(bubble("Promoted prompt")).not.toContain("Processing")
    expect(bubble("Latest prompt")).not.toContain("◷")
    expect(bubble("Promoted prompt")).not.toContain("◷")
    screen.events.emit(execution("session.execution.interrupted"))
    await absent(screen, "cooking")
    expectRead(receipt(lines(), "Latest prompt"))
    expectSent(receipt(lines(), "Promoted prompt"))
    screen.events.emit(execution("session.execution.started"))
    await text(screen, "cooking")
    screen.events.emit(execution("session.execution.failed"))
    await absent(screen, "cooking")
    expectRead(receipt(lines(), "Latest prompt"))
    expectSent(receipt(lines(), "Promoted prompt"))
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("admitted steer shows one check and a pending queue shows a queued check", async () => {
  const screen = await mount(
    [user("msg_sent", "Promoted prompt", 1)],
    [pending("msg_steer", "Steer prompt", "steer", 2), pending("msg_queue", "Queue prompt", "queue", 3)],
    "Queue prompt",
  )
  try {
    const lines = () => screen.lines()
    const bubble = (prompt: string) => lines().find((line) => line.includes(prompt)) ?? ""
    expectSent(receipt(lines(), "Steer prompt"))
    expect(receipt(lines(), "Queue prompt")).toContain("✓ Queued")
    expect(receipt(lines(), "Queue prompt")).not.toContain("✓✓")
    expect(receipt(lines(), "Queue prompt")).not.toContain("Processing")
    expect(receipt(lines(), "Queue prompt")).not.toContain("◷")
    expectSent(receipt(lines(), "Promoted prompt"))
    screen.events.emit(execution("session.execution.started"))
    await text(screen, "cooking")
    expectSent(receipt(lines(), "Steer prompt"))
    expect(receipt(lines(), "Queue prompt")).toContain("✓ Queued")
    expect(receipt(lines(), "Queue prompt")).not.toContain("Processing")
    expect(receipt(lines(), "Queue prompt")).not.toContain("◷")
    expectSent(receipt(lines(), "Promoted prompt"))
    expect(bubble("Queue prompt")).not.toContain("Queued")
    expect(bubble("Queue prompt")).not.toContain("✓")
    expect(bubble("Steer prompt")).not.toContain("✓")
    expect(bubble("Steer prompt")).not.toContain("Processing")
    expect(bubble("Steer prompt")).not.toContain("◷")
  } finally {
    await screen.dispose()
  }
}, 30_000)
