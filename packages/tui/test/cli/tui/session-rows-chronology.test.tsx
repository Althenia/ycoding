/** @jsxImportSource @opentui/solid */
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { testRender } from "@opentui/solid"
import type { SessionMessageInfo, YCodingEvent } from "@ycoding-ai/client"
import { ClientProvider, useClient } from "../../../src/context/client"
import { DataProvider, useData } from "../../../src/context/data"
import { createSessionRows, type SessionRow } from "../../../src/routes/session/rows"
import { createApi, createEventStream, createFetch, directory, sessionSnapshot } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"

const root = mkdtempSync(path.join(tmpdir(), "ycoding-chronology-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const sessionID = "ses_16d3a1000000ChronologyRoot"
const step = "msg_16d3a1000001ChronoStepOne"
const escalation = "16d3a1000002ChronoReview01"
const notice = "16d3a1000003ChronoNotice01"
const next = "msg_16d3a1000004ChronoStepTwo"
let durableSequence = 0

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mountRows(messages: readonly unknown[] = []) {
  durableSequence = 0
  const events = createEventStream()
  const calls = createFetch((url) => {
    if (url.pathname === `/api/session/${sessionID}/snapshot`) return sessionSnapshot(sessionID, messages)
    return undefined
  }, events)
  let rows!: ReturnType<typeof createSessionRows>
  let client!: ReturnType<typeof useClient>
  let data!: ReturnType<typeof useData>

  function Probe() {
    client = useClient()
    data = useData()
    rows = createSessionRows(() => sessionID)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts paths={{ state: path.join(root, "state"), home: path.join(root, "home") }}>
      <ClientProvider api={createApi(calls.fetch)}>
        <DataProvider>
          <Probe />
        </DataProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))
  app.renderer.start()
  await app.waitForFrame((frame) => frame.length > 0)
  await wait(() => client.connection.status() === "connected")
  await data.session.message.sync(sessionID)
  return { rows, data, events, destroy: () => app.renderer.destroy() }
}

function keys(rows: SessionRow[]) {
  return rows.map((row) => (row as SessionRow & { key?: string }).key)
}

function find(rows: SessionRow[], key: string) {
  return rows.find((row) => (row as SessionRow & { key?: string }).key === key)
}

function event(id: string, seq: number, type: string, data: Record<string, unknown>) {
  return {
    id,
    type,
    created: 1_000 + seq,
    location: { directory },
    ...(type.endsWith(".delta") ? {} : { durable: { aggregateID: sessionID, seq: ++durableSequence, version: 1 } }),
    data: { sessionID, ...data },
  } as unknown as YCodingEvent
}

const interleaved = [
  "part:" + step + ":text:0",
  "part:" + step + ":call_review",
  "message:msg_" + escalation,
  "part:" + step + ":call_followup",
  "assistant-footer:" + step,
]

test("rows that arrive while a step is open keep their live chronology through reconcile, settlement and new output", async () => {
  const mounted = await mountRows()
  try {
    const emit = (item: YCodingEvent) => mounted.events.emit(item)
    const model = { providerID: "provider", id: "model" }
    emit(event("evt_chrono_execution_started", 0, "session.execution.started", {}))
    emit(event("evt_16d3a1000001ChronoStepOne", 1, "session.step.started", { assistantMessageID: step, agent: "build", model }))
    emit(event("evt_chrono_text_delta_started", 2, "session.text.started", { assistantMessageID: step, ordinal: 0 }))
    emit(event("evt_chrono_text_delta", 3, "session.text.delta", { assistantMessageID: step, ordinal: 0, delta: "Checking the release lane" }))
    emit(event("evt_chrono_text_ended", 4, "session.text.ended", { assistantMessageID: step, ordinal: 0, text: "Checking the release lane" }))
    emit(event("evt_chrono_review_input", 5, "session.tool.input.started", { assistantMessageID: step, callID: "call_review", name: "project_escalate" }))
    emit(event("evt_chrono_review_called", 6, "session.tool.called", { assistantMessageID: step, callID: "call_review", input: {}, executed: true }))
    emit(event("evt_" + escalation, 7, "session.guardrail.escalated", { requestID: "grq_chrono", choice: "escalate", confidence: 0.4 }))
    await wait(() => find(mounted.rows, "message:msg_" + escalation) !== undefined)
    emit(event("evt_chrono_followup_input", 8, "session.tool.input.started", { assistantMessageID: step, callID: "call_followup", name: "task" }))
    emit(event("evt_chrono_followup_called", 9, "session.tool.called", { assistantMessageID: step, callID: "call_followup", input: {}, executed: true }))
    emit(event("evt_chrono_review_settled", 10, "session.tool.success", { assistantMessageID: step, callID: "call_review", structured: {}, content: [], executed: true }))
    emit(event("evt_chrono_followup_settled", 11, "session.tool.success", { assistantMessageID: step, callID: "call_followup", structured: {}, content: [], executed: true }))
    emit(event("evt_chrono_step_ended", 12, "session.step.ended", {
      assistantMessageID: step, finish: "stop", cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }))
    await wait(() => find(mounted.rows, "assistant-footer:" + step) !== undefined)
    const projected = mounted.data.session.message.get(sessionID, step)
    expect(projected?.type === "assistant" ? projected.content.map((part) => part.type === "tool" ? part.id : part.type) : []).toEqual(["text", "call_review", "call_followup"])
    expect(keys(mounted.rows)).toEqual(interleaved)
    const followup = find(mounted.rows, "part:" + step + ":call_followup")
    const review = find(mounted.rows, "part:" + step + ":call_review")

    emit(event("evt_" + notice, 13, "session.synthetic", { text: "Background task finished", description: "Subagent completed" }))
    await wait(() => find(mounted.rows, "message:msg_" + notice) !== undefined)
    expect(keys(mounted.rows)).toEqual([...interleaved, "message:msg_" + notice])
    expect(find(mounted.rows, "part:" + step + ":call_followup")).toBe(followup)
    expect(find(mounted.rows, "part:" + step + ":call_review")).toBe(review)

    emit(event("evt_16d3a1000004ChronoStepTwo", 14, "session.step.started", { assistantMessageID: next, agent: "build", model }))
    emit(event("evt_chrono_next_delta_started", 15, "session.text.started", { assistantMessageID: next, ordinal: 0 }))
    emit(event("evt_chrono_next_delta", 16, "session.text.delta", { assistantMessageID: next, ordinal: 0, delta: "Fresh answer" }))
    await wait(() => find(mounted.rows, "part:" + next + ":text:0") !== undefined)
    expect(keys(mounted.rows)).toEqual([...interleaved, "message:msg_" + notice, "part:" + next + ":text:0"])
  } finally {
    mounted.destroy()
  }
})

test("a reloaded transcript replays a mid-step notice in the position it arrived", async () => {
  const live = await mountRows()
  let projected: SessionMessageInfo[] = []
  try {
    const emit = (item: YCodingEvent) => live.events.emit(item)
    const model = { providerID: "provider", id: "model" }
    emit(event("evt_chrono_replay_execution_started", 0, "session.execution.started", {}))
    emit(event("evt_16d3a1000001ChronoStepOne", 1, "session.step.started", { assistantMessageID: step, agent: "build", model }))
    emit(event("evt_chrono_text_started", 2, "session.text.started", { assistantMessageID: step, ordinal: 0 }))
    emit(event("evt_chrono_text_ended", 3, "session.text.ended", { assistantMessageID: step, ordinal: 0, text: "Checking the release lane" }))
    emit(event("evt_chrono_review_input", 4, "session.tool.input.started", { assistantMessageID: step, callID: "call_review", name: "project_escalate" }))
    emit(event("evt_" + escalation, 5, "session.guardrail.escalated", { requestID: "grq_chrono", choice: "escalate", confidence: 0.4 }))
    emit(event("evt_chrono_followup_input", 6, "session.tool.input.started", { assistantMessageID: step, callID: "call_followup", name: "task" }))
    emit(event("evt_chrono_step_ended", 7, "session.step.ended", {
      assistantMessageID: step, finish: "stop", cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }))
    emit(event("evt_" + notice, 8, "session.synthetic", { text: "Background task finished", description: "Subagent completed" }))
    await wait(() => find(live.rows, "message:msg_" + notice) !== undefined)
    projected = JSON.parse(JSON.stringify(live.data.session.message.list(sessionID)))
  } finally {
    live.destroy()
  }

  const reloaded = await mountRows(projected.toSorted((left, right) => left.id.localeCompare(right.id)))
  try {
    await wait(() => find(reloaded.rows, "message:msg_" + notice) !== undefined)
    expect(keys(reloaded.rows)).toEqual([...interleaved, "message:msg_" + notice])
  } finally {
    reloaded.destroy()
  }
})
