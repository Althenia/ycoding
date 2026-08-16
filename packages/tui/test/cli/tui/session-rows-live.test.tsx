/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { SessionOrchestrationTask, YCodingEvent } from "@ycoding-ai/client"
import { ClientProvider, useClient } from "../../../src/context/client"
import { DataProvider, useData } from "../../../src/context/data"
import { createSessionRows, type SessionRow } from "../../../src/routes/session/rows"
import { createApi, createEventStream, createFetch, directory, json } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function durable(sessionID: string, seq: number) {
  return { aggregateID: sessionID, seq, version: 2 as const }
}

async function mountRows(
  sessionID: string,
  subagentTasks: SessionOrchestrationTask[] = [],
  options: { messages?: () => Response | Promise<Response>; waitForMessages?: boolean } = {},
) {
  const events = createEventStream()
  const calls = createFetch((url) => {
    if (url.pathname === `/api/session/${sessionID}/message`)
      return options.messages?.() ?? json({ data: [], cursor: {} })
    if (url.pathname === `/api/session/${sessionID}/subagent`)
      return json({
        data: subagentTasks,
        summary: {
          total: subagentTasks.length,
          active: subagentTasks.filter((task) => ["starting", "running", "waiting", "cancelling"].includes(task.state))
            .length,
          running: subagentTasks.filter((task) => task.state === "running").length,
          waiting: subagentTasks.filter((task) => task.state === "waiting").length,
        },
        cursor: {},
      })
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
    <TestTuiContexts>
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
  // Let the initial data.session.message.sync() settle so a later, unrelated
  // full reconcile does not incidentally mask a row appended for a message
  // that was never created.
  if (options.waitForMessages !== false) await data.session.message.sync(sessionID)
  return { rows, data, events, client, destroy: () => app.renderer.destroy() }
}

test("reconciles V2 compaction rows by jobID through terminal lifecycle events", async () => {
  const sessionID = "session-v2-compaction-rows"
  const jobID = "cmp_lifecycle"
  let messageRequests = 0
  let resolveMessages!: (response: Response) => void
  const mounted = await mountRows(sessionID, [], {
    messages: () => {
      messageRequests++
      return new Promise<Response>((resolve) => {
        resolveMessages = resolve
      })
    },
    waitForMessages: false,
  })
  const compaction = () => mounted.data.session.compaction.get(sessionID, jobID)
  const row = () => mounted.rows.find((item) => item.type === "compaction" && item.jobID === jobID)

  try {
    await wait(() => messageRequests === 1)
    mounted.events.emit({
      id: "evt_compaction_admitted_v2",
      created: 1,
      type: "session.compaction.admitted",
      location: { directory },
      durable: durable(sessionID, 1),
      data: { sessionID, jobID },
    })
    await wait(() => compaction()?.status === "pending")
    expect(compaction()).not.toHaveProperty("trigger")
    expect(compaction()).not.toHaveProperty("admissionMode")

    mounted.events.emit({
      id: "evt_compaction_started_v2",
      created: 2,
      type: "session.compaction.started",
      location: { directory },
      durable: durable(sessionID, 2),
      data: { sessionID, jobID },
    })
    await wait(() => compaction()?.status === "running")
    expect(compaction()).not.toHaveProperty("trigger")
    expect(compaction()).not.toHaveProperty("admissionMode")

    resolveMessages(
      json({
        data: [
          {
            id: "msg_compaction_lifecycle",
            type: "compaction",
            jobID,
            trigger: "advised",
            admissionMode: "background",
            status: "running",
            time: { created: 1 },
          },
        ],
        cursor: {},
      }),
    )
    await wait(() => compaction()?.messageID === "msg_compaction_lifecycle")
    expect(compaction()).toMatchObject({
      jobID,
      messageID: "msg_compaction_lifecycle",
      trigger: "advised",
      admissionMode: "background",
      status: "running",
    })
    const queued = row()
    expect(row()).toBe(queued)

    mounted.events.emit({
      id: "evt_compaction_ended_v2",
      created: 3,
      type: "session.compaction.ended",
      location: { directory },
      durable: durable(sessionID, 3),
      data: {
        sessionID,
        jobID,
        revision: 1,
        boundary: { messageID: "msg_boundary", seq: 9 },
        metrics: { excludedMessages: 42, excludedParts: 7, inputTokens: 121_000, retainedTokens: 68_000 },
      },
    })

    await wait(() => compaction()?.status === "completed")
    expect(compaction()).toMatchObject({ jobID, status: "completed", revision: 1 })
    expect(row()).toBe(queued)

    mounted.events.emit({
      id: "evt_compaction_admitted_failed_v2",
      created: 4,
      type: "session.compaction.admitted",
      location: { directory },
      durable: durable(sessionID, 4),
      data: { sessionID, jobID: "cmp_failed" },
    })
    mounted.events.emit({
      id: "evt_compaction_failed_v2",
      created: 5,
      type: "session.compaction.failed",
      location: { directory },
      durable: durable(sessionID, 5),
      data: {
        sessionID,
        jobID: "cmp_failed",
        code: "context_limit_unresolved",
        error: { type: "context_limit_unresolved", message: "Unable to compact context" },
      },
    })

    mounted.data.session.message.invalidate(sessionID)
    const failedReconcile = mounted.data.session.message.sync(sessionID)
    await wait(() => messageRequests === 2)
    resolveMessages(
      json({
        data: [
          {
            id: "msg_compaction_lifecycle",
            type: "compaction",
            jobID,
            trigger: "advised",
            admissionMode: "background",
            status: "completed",
            revision: 1,
            boundary: { messageID: "msg_boundary", seq: 9 },
            metrics: { excludedMessages: 42, excludedParts: 7, inputTokens: 121_000, retainedTokens: 68_000 },
            time: { created: 1 },
          },
          {
            id: "msg_compaction_failed",
            type: "compaction",
            jobID: "cmp_failed",
            trigger: "mandatory",
            admissionMode: "mandatory",
            status: "failed",
            code: "context_limit_unresolved",
            error: { type: "context_limit_unresolved", message: "Unable to compact context" },
            time: { created: 4 },
          },
        ],
        cursor: {},
      }),
    )
    await failedReconcile
    expect(mounted.data.session.compaction.get(sessionID, "cmp_failed")).toMatchObject({
      jobID: "cmp_failed",
      messageID: "msg_compaction_failed",
      trigger: "mandatory",
      admissionMode: "mandatory",
      status: "failed",
      code: "context_limit_unresolved",
    })
  } finally {
    mounted.destroy()
  }
})

test("rehydrates one identity-stable V2 compaction row when an event arrives before reconnect fetch", async () => {
  const sessionID = "session-v2-compaction-reconnect"
  const jobID = "cmp_reconnect"
  let requests = 0
  let resolveMessages!: (response: Response) => void
  const mounted = await mountRows(sessionID, [], {
    messages: () => {
      requests++
      if (requests === 1) return json({ data: [], cursor: {} })
      return new Promise<Response>((resolve) => {
        resolveMessages = resolve
      })
    },
    waitForMessages: false,
  })
  const compaction = () => mounted.data.session.compaction.get(sessionID, jobID)
  const row = () => mounted.rows.find((item) => item.type === "compaction" && item.jobID === jobID)

  try {
    await wait(() => requests === 1)
    mounted.events.disconnect()
    await wait(() => mounted.client.connection.status() === "reconnecting")
    await wait(() => requests === 2 && mounted.client.connection.status() === "connected", 4000)

    mounted.events.emit({
      id: "evt_compaction_admitted_before_fetch_v2",
      created: 1,
      type: "session.compaction.admitted",
      location: { directory },
      durable: durable(sessionID, 1),
      data: { sessionID, jobID },
    })

    resolveMessages(
      json({
        data: [
          {
            id: "msg_compaction_reconnect",
            type: "compaction",
            jobID,
            trigger: "advised",
            admissionMode: "background",
            status: "pending",
            time: { created: 1 },
          },
        ],
        cursor: {},
      }),
    )
    await wait(() => compaction()?.messageID === "msg_compaction_reconnect")
    const rehydrated = row()
    expect(mounted.rows.filter((item) => item.type === "compaction" && item.jobID === jobID)).toHaveLength(1)

    mounted.events.emit({
      id: "evt_compaction_started_after_fetch_v2",
      created: 2,
      type: "session.compaction.started",
      location: { directory },
      durable: durable(sessionID, 2),
      data: { sessionID, jobID },
    })

    await wait(() => compaction()?.status === "running")
    expect(compaction()).toMatchObject({ jobID, status: "running" })
    expect(row()).toBe(rehydrated)
  } finally {
    mounted.destroy()
  }
})

test("an initial instructions.updated event that never becomes a message never renders a row", async () => {
  const sessionID = "session-instructions-initial"
  const mounted = await mountRows(sessionID)

  try {
    // data.tsx skips creating a local message for this event when
    // metadata.instructions.initial === true (see data.tsx's
    // "session.instructions.updated" case), so no message for this ID ever exists.
    mounted.events.emit({
      id: "evt_instructions_initial",
      created: 1,
      type: "session.instructions.updated",
      location: { directory },
      durable: durable(sessionID, 0),
      metadata: { instructions: { initial: true } },
      data: { sessionID, delta: { "core/date": "0".repeat(64) } },
    } as YCodingEvent)
    await Bun.sleep(50)

    expect(mounted.data.session.message.get(sessionID, "msg_instructions_initial")).toBeUndefined()
    expect(mounted.rows.some((row: SessionRow) => row.type === "message")).toBe(false)
  } finally {
    mounted.destroy()
  }
})

test("streaming text and tool deltas preserve transcript row identity", async () => {
  const sessionID = "session-stable-stream-rows"
  const mounted = await mountRows(sessionID)

  try {
    mounted.events.emit({
      id: "evt_step_started",
      created: 1,
      type: "session.step.started",
      durable: durable(sessionID, 1),
      data: {
        sessionID,
        assistantMessageID: "msg_assistant",
        agent: "build",
        model: { providerID: "provider", id: "model" },
      },
    } as unknown as YCodingEvent)
    mounted.events.emit({
      id: "evt_text_started",
      created: 2,
      type: "session.text.started",
      data: { sessionID, assistantMessageID: "msg_assistant", ordinal: 0 },
    } as YCodingEvent)
    mounted.events.emit({
      id: "evt_text_delta_first",
      created: 3,
      type: "session.text.delta",
      data: { sessionID, assistantMessageID: "msg_assistant", ordinal: 0, delta: "first" },
    } as YCodingEvent)
    await wait(() => mounted.rows.some((row) => row.type === "part" && row.ref.partID === "text:0"))
    const textRow = mounted.rows.find((row) => row.type === "part" && row.ref.partID === "text:0")

    mounted.events.emit({
      id: "evt_tool_started",
      created: 4,
      type: "session.tool.input.started",
      data: { sessionID, assistantMessageID: "msg_assistant", callID: "call_running", name: "project_index" },
    } as YCodingEvent)
    await wait(() => mounted.rows.some((row) => row.type === "part" && row.ref.partID === "call_running"))
    const toolRow = mounted.rows.find((row) => row.type === "part" && row.ref.partID === "call_running")

    mounted.events.emit({
      id: "evt_text_delta_second",
      created: 5,
      type: "session.text.delta",
      data: { sessionID, assistantMessageID: "msg_assistant", ordinal: 0, delta: " second" },
    } as YCodingEvent)
    mounted.events.emit({
      id: "evt_tool_delta",
      created: 6,
      type: "session.tool.input.delta",
      data: { sessionID, assistantMessageID: "msg_assistant", callID: "call_running", delta: "{}" },
    } as YCodingEvent)
    await Bun.sleep(50)

    expect(mounted.rows.find((row) => row.type === "part" && row.ref.partID === "text:0")).toBe(textRow)
    expect(mounted.rows.find((row) => row.type === "part" && row.ref.partID === "call_running")).toBe(toolRow)
  } finally {
    mounted.destroy()
  }
})

test("a live subagent activity row retains its object identity when a normal message arrives", async () => {
  const sessionID = "session-subagent-activity-stable"
  const task: SessionOrchestrationTask = {
    sessionID: "ses_child",
    parentID: sessionID,
    description: "Review implementation",
    agent: "reviewer",
    model: { providerID: "openai", id: "gpt-5.6" },
    background: true,
    state: "running",
    revision: 0,
    time: { created: 1, updated: 1 },
  }
  const mounted = await mountRows(sessionID, [task])

  try {
    await mounted.data.session.subagent.sync(sessionID)
    // A compaction boundary is required for transcript activity rows to render at the tail.
    mounted.events.emit({
      id: "evt_compaction_started",
      created: 2,
      type: "session.compaction.started",
      durable: durable(sessionID, 1),
      data: { sessionID, jobID: "cmp_activity" },
    })
    await wait(() => mounted.rows.some((row) => row.type === "subagent"))
    const subagentRow = mounted.rows.find((row) => row.type === "subagent")
    expect(subagentRow?.type).toBe("subagent")

    // Ordinary chat progress re-reduces the transcript; it must not replace the
    // already-resident tail subagent row (keyed reuse, not positional rebuild).
    mounted.events.emit({
      id: "evt_user_admitted",
      created: 3,
      type: "session.input.admitted",
      durable: durable(sessionID, 2),
      data: {
        sessionID,
        inputID: "msg_user",
        input: { type: "user", data: { text: "continue" }, delivery: "steer" },
      },
    } as unknown as YCodingEvent)
    await wait(() => mounted.rows.some((row) => row.type === "message" && row.messageID === "msg_user"))

    expect(mounted.rows.find((row) => row.type === "message" && row.messageID === "msg_user")).toBeTruthy()
    expect(mounted.rows.find((row) => row.type === "subagent")).toBe(subagentRow)
  } finally {
    mounted.destroy()
  }
})
