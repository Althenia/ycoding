/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { SessionMessageInfo, SessionOrchestrationTask, YCodingEvent } from "@ycoding-ai/client"
import { ConfigProvider } from "../../../src/config"
import { ClientProvider, useClient } from "../../../src/context/client"
import { DataProvider, useData } from "../../../src/context/data"
import { ThemeProvider } from "../../../src/context/theme"
import { SessionRowView } from "../../../src/routes/session/index"
import { createSessionRows, type SessionRow } from "../../../src/routes/session/rows"
import { createApi, createEventStream, createFetch, directory, json, sessionSnapshot } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

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

function durableV1(sessionID: string, seq: number) {
  return { aggregateID: sessionID, seq, version: 1 as const }
}

async function mountRows(
  sessionID: string,
  subagentTasks: SessionOrchestrationTask[] = [],
  options: {
    messages?: () => Response | Promise<Response>
    compactionHistory?: (sessionID: string) => Response | Promise<Response>
    waitForMessages?: boolean
  } = {},
) {
  const events = createEventStream()
  const calls = createFetch((url) => {
    if (url.pathname === `/api/session/${sessionID}/snapshot`)
      return options.messages?.() ?? sessionSnapshot(sessionID, [])
    const compaction = /^\/api\/session\/([^/]+)\/compaction$/.exec(url.pathname)
    if (compaction) return options.compactionHistory?.(compaction[1])
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

test("projects live context observations once as resident chronological messages", async () => {
  const sessionID = "ses_context_observations"
  const mounted = await mountRows(sessionID)
  try {
    const state: YCodingEvent = {
      id: "evt_context_state",
      type: "session.context.observed",
      created: 1,
      location: { directory },
      durable: { aggregateID: sessionID, seq: 1, version: 1 },
      data: { sessionID, source: "session-state", text: "Current Session state" },
    }
    mounted.events.emit(state)
    await wait(() => mounted.data.session.message.get(sessionID, "msg_context_state") !== undefined)
    mounted.events.emit(state)
    mounted.events.emit({
      id: "evt_context_team",
      type: "session.context.observed",
      created: 2,
      location: { directory },
      durable: { aggregateID: sessionID, seq: 2, version: 1 },
      data: { sessionID, source: "team-view", text: "TeamView current tasks" },
    })
    await wait(() => mounted.rows.some((row) => row.type === "message" && row.messageID === "msg_context_team"))
    expect(mounted.data.session.message.get(sessionID, "msg_context_state")).toMatchObject({
      type: "system",
      text: "Current Session state",
      metadata: { contextSource: "session-state" },
    })
    expect(mounted.data.session.message.get(sessionID, "msg_context_team")).toMatchObject({
      type: "synthetic",
      text: "TeamView current tasks",
      description: "TeamView update",
      metadata: { contextSource: "team-view" },
    })
    expect(mounted.rows.filter((row) => row.type === "message").map((row) => row.messageID)).toEqual([
      "msg_context_state",
      "msg_context_team",
    ])
  } finally {
    mounted.destroy()
  }
})

test("reconciles compaction rows by jobID through terminal lifecycle events", async () => {
  const sessionID = "session-v2-compaction-rows"
  const jobID = "cmp_lifecycle"
  const pressure = { estimatedInputTokens: 600_000, safeInputTokens: 642_000 }
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
      data: { sessionID, jobID, pressure },
    })
    await wait(() => compaction()?.status === "pending")
    const pending = compaction()
    expect(compaction()?.pressure).toEqual(pressure)
    expect(compaction()).not.toHaveProperty("trigger")

    mounted.events.emit({
      id: "evt_compaction_started_v2",
      created: 2,
      type: "session.compaction.started",
      location: { directory },
      durable: durable(sessionID, 2),
      data: { sessionID, jobID },
    })
    await wait(() => compaction()?.status === "running")
    expect(compaction()?.pressure).toEqual(pressure)
    expect(compaction()).not.toHaveProperty("trigger")

    resolveMessages(
      sessionSnapshot(sessionID, [
        {
          id: "msg_compaction_lifecycle",
          type: "compaction",
          jobID,
          trigger: "advised",
          status: "running",
          time: { created: 1 },
        },
      ]),
    )
    await wait(() => compaction()?.messageID === "msg_compaction_lifecycle")
    expect(compaction()).toMatchObject({
      jobID,
      messageID: "msg_compaction_lifecycle",
      trigger: "advised",
      pressure,
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
    expect(compaction()).toMatchObject({ jobID, pressure, status: "completed", revision: 1 })
    expect(compaction()).not.toBe(pending)
    expect(row()).toBe(queued)

    mounted.events.emit({
      id: "evt_compaction_admitted_failed_v2",
      created: 4,
      type: "session.compaction.admitted",
      location: { directory },
      durable: durable(sessionID, 4),
      data: { sessionID, jobID: "cmp_failed" },
    })
    await wait(() => mounted.data.session.compaction.get(sessionID, "cmp_failed")?.status === "pending")
    const pendingFailed = mounted.rows.find((item) => item.type === "compaction" && item.jobID === "cmp_failed")
    expect(pendingFailed).toBeDefined()

    mounted.events.emit({
      id: "evt_compaction_started_failed_v2",
      created: 5,
      type: "session.compaction.started",
      location: { directory },
      durable: durable(sessionID, 5),
      data: { sessionID, jobID: "cmp_failed" },
    })
    await wait(() => mounted.data.session.compaction.get(sessionID, "cmp_failed")?.status === "running")
    expect(mounted.rows.find((item) => item.type === "compaction" && item.jobID === "cmp_failed")).toBe(pendingFailed)

    mounted.events.emit({
      id: "evt_compaction_failed_v2",
      created: 6,
      type: "session.compaction.failed",
      location: { directory },
      durable: durable(sessionID, 6),
      data: {
        sessionID,
        jobID: "cmp_failed",
        code: "context_limit_unresolved",
        error: { type: "context_limit_unresolved", message: "Unable to compact context" },
      },
    })
    await wait(() => mounted.data.session.compaction.get(sessionID, "cmp_failed")?.status === "failed")
    expect(mounted.rows.some((item) => item.type === "compaction" && item.jobID === "cmp_failed")).toBe(false)

    mounted.data.session.message.invalidate(sessionID)
    const failedReconcile = mounted.data.session.message.sync(sessionID)
    await wait(() => messageRequests === 2)
    resolveMessages(
      sessionSnapshot(sessionID, [
        {
          id: "msg_compaction_lifecycle",
          type: "compaction",
          jobID,
          trigger: "advised",
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
          status: "failed",
          code: "context_limit_unresolved",
          error: { type: "context_limit_unresolved", message: "Unable to compact context" },
          time: { created: 4 },
        },
      ]),
    )
    await failedReconcile
    expect(mounted.data.session.compaction.get(sessionID, "cmp_failed")).toMatchObject({
      jobID: "cmp_failed",
      messageID: "msg_compaction_failed",
      trigger: "mandatory",
      status: "failed",
      code: "context_limit_unresolved",
    })
    expect(mounted.rows.some((item) => item.type === "compaction" && item.jobID === "cmp_failed")).toBe(false)
  } finally {
    mounted.destroy()
  }
})

test("rehydrates one identity-stable compaction row when an event arrives before reconnect fetch", async () => {
  const sessionID = "session-v2-compaction-reconnect"
  const jobID = "cmp_reconnect"
  let requests = 0
  let resolveMessages!: (response: Response) => void
  const mounted = await mountRows(sessionID, [], {
    messages: () => {
      requests++
      if (requests === 1) return sessionSnapshot(sessionID, [])
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
    await wait(() => compaction()?.status === "pending")
    const provisional = row()
    expect(provisional).toBeDefined()

    resolveMessages(
      sessionSnapshot(sessionID, [
        {
          id: "msg_compaction_reconnect",
          type: "compaction",
          jobID,
          trigger: "advised",
          status: "pending",
          time: { created: 1 },
        },
        {
          id: "msg_after_compaction_reconnect",
          type: "user",
          text: "Newer chat after reconnect",
          files: [],
          agents: [],
          time: { created: 2 },
        },
      ]),
    )
    await wait(() => compaction()?.messageID === "msg_compaction_reconnect")
    const rehydrated = row()
    expect(rehydrated).toBe(provisional)
    expect(mounted.rows.filter((item) => item.type === "compaction" && item.jobID === jobID)).toHaveLength(1)
    expect(mounted.rows.indexOf(rehydrated!)).toBeLessThan(
      mounted.rows.findIndex((item) => item.type === "message" && item.messageID === "msg_after_compaction_reconnect"),
    )

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

    mounted.events.emit({
      id: "evt_compaction_failed_after_fetch_v2",
      created: 3,
      type: "session.compaction.failed",
      location: { directory },
      durable: durable(sessionID, 3),
      data: {
        sessionID,
        jobID,
        code: "provider_failed",
        error: { type: "provider_failed", message: "Diagnostic only" },
      },
    })
    await wait(() => compaction()?.status === "failed")
    expect(row()).toBeUndefined()
  } finally {
    mounted.destroy()
  }
})

test("keeps a persisted compaction failure diagnostic-only through reconnect hydration", async () => {
  const sessionID = "session-v2-compaction-failed-reconnect"
  const jobID = "cmp_failed_reconnect"
  let requests = 0
  let resolveMessages!: (response: Response) => void
  const mounted = await mountRows(sessionID, [], {
    messages: () => {
      requests++
      if (requests === 1) return sessionSnapshot(sessionID, [])
      return new Promise<Response>((resolve) => {
        resolveMessages = resolve
      })
    },
    waitForMessages: false,
  })

  try {
    await wait(() => requests === 1)
    mounted.events.disconnect()
    await wait(() => mounted.client.connection.status() === "reconnecting")
    await wait(() => requests === 2 && mounted.client.connection.status() === "connected", 4000)

    mounted.events.emit({
      id: "evt_compaction_admitted_failed_reconnect",
      created: 1,
      type: "session.compaction.admitted",
      location: { directory },
      durable: durable(sessionID, 1),
      data: { sessionID, jobID },
    })
    mounted.events.emit({
      id: "evt_compaction_started_failed_reconnect",
      created: 2,
      type: "session.compaction.started",
      location: { directory },
      durable: durable(sessionID, 2),
      data: { sessionID, jobID },
    })
    mounted.events.emit({
      id: "evt_compaction_failed_reconnect",
      created: 3,
      type: "session.compaction.failed",
      location: { directory },
      durable: durable(sessionID, 3),
      data: {
        sessionID,
        jobID,
        code: "provider_failed",
        error: { type: "provider_failed", message: "Diagnostic only" },
      },
    })
    await wait(() => mounted.data.session.compaction.get(sessionID, jobID)?.status === "failed")
    expect(mounted.rows.some((item) => item.type === "compaction" && item.jobID === jobID)).toBe(false)

    resolveMessages(
      sessionSnapshot(sessionID, [
        {
          id: "msg_compaction_failed_reconnect",
          type: "compaction",
          jobID,
          trigger: "advised",
          status: "failed",
          code: "provider_failed",
          error: { type: "provider_failed", message: "Persisted diagnostic" },
          time: { created: 1 },
        },
      ]),
    )
    await wait(() => {
      const message = mounted.data.session.message.get(sessionID, "msg_compaction_failed_reconnect")
      return message?.type === "compaction" && message.status === "failed"
    })
    expect(mounted.data.session.compaction.get(sessionID, jobID)).toMatchObject({
      jobID,
      messageID: "msg_compaction_failed_reconnect",
      status: "failed",
      code: "provider_failed",
    })
    expect(mounted.rows.some((item) => item.type === "compaction" && item.jobID === jobID)).toBe(false)
  } finally {
    mounted.destroy()
  }
})

test("keeps a resident background compaction before newer user and assistant chat", async () => {
  const sessionID = "session-v2-compaction-background-order"
  const jobID = "cmp_background_order"
  const mounted = await mountRows(sessionID, [], {
    messages: () =>
      sessionSnapshot(sessionID, [
        {
          id: "msg_before_compaction",
          type: "user",
          text: "Chat before compaction",
          files: [],
          agents: [],
          time: { created: 1 },
        },
        {
          id: "msg_compaction_background",
          type: "compaction",
          jobID,
          trigger: "advised",
          status: "pending",
          time: { created: 2 },
        },
      ]),
  })
  const compaction = () => mounted.rows.find((row) => row.type === "compaction" && row.jobID === jobID)
  const position = (type: "compaction" | "message" | "part", id: string) =>
    mounted.rows.findIndex((row) => {
      if (type === "compaction") return row.type === "compaction" && row.jobID === id
      if (type === "message") return row.type === "message" && row.messageID === id
      return row.type === "part" && row.ref.messageID === id
    })

  try {
    await wait(() => mounted.data.session.compaction.get(sessionID, jobID)?.messageID === "msg_compaction_background")
    const resident = compaction()

    mounted.events.emit({
      id: "evt_compaction_background_started",
      created: 3,
      type: "session.compaction.started",
      location: { directory },
      durable: durable(sessionID, 3),
      data: { sessionID, jobID },
    })
    mounted.events.emit({
      id: "evt_user_during_compaction",
      created: 4,
      type: "session.input.admitted",
      location: { directory },
      durable: durable(sessionID, 4),
      data: {
        sessionID,
        inputID: "msg_user_during_compaction",
        input: { type: "user", data: { text: "Newer user chat" }, delivery: "steer" },
      },
    } as unknown as YCodingEvent)
    mounted.events.emit({
      id: "evt_user_during_compaction_promoted",
      created: 5,
      type: "session.input.promoted",
      location: { directory },
      durable: durable(sessionID, 5),
      data: { sessionID, inputID: "msg_user_during_compaction" },
    } as unknown as YCodingEvent)
    mounted.events.emit({
      id: "evt_assistant_during_compaction_started",
      created: 6,
      type: "session.step.started",
      location: { directory },
      durable: durable(sessionID, 6),
      data: {
        sessionID,
        assistantMessageID: "msg_assistant_during_compaction",
        agent: "build",
        model: { providerID: "provider", id: "model" },
      },
    } as unknown as YCodingEvent)
    mounted.events.emit({
      id: "evt_assistant_during_compaction_text_started",
      created: 7,
      type: "session.text.started",
      location: { directory },
      durable: durableV1(sessionID, 7),
      data: { sessionID, assistantMessageID: "msg_assistant_during_compaction", ordinal: 0 },
    } as YCodingEvent)
    mounted.events.emit({
      id: "evt_assistant_during_compaction_text_ended",
      created: 8,
      type: "session.text.ended",
      location: { directory },
      durable: durableV1(sessionID, 8),
      data: {
        sessionID,
        assistantMessageID: "msg_assistant_during_compaction",
        ordinal: 0,
        text: "Newer assistant chat",
      },
    } as YCodingEvent)
    mounted.events.emit({
      id: "evt_assistant_during_compaction_ended",
      created: 9,
      type: "session.step.ended",
      location: { directory },
      durable: durable(sessionID, 9),
      data: {
        sessionID,
        assistantMessageID: "msg_assistant_during_compaction",
        finish: "stop",
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    } as unknown as YCodingEvent)

    await wait(() =>
      mounted.rows.some(
        (row) => row.type === "assistant-footer" && row.messageID === "msg_assistant_during_compaction",
      ),
    )
    expect(mounted.data.session.compaction.get(sessionID, jobID)?.status).toBe("running")
    expect(compaction()).toBe(resident)
    expect(position("compaction", jobID)).toBeLessThan(position("message", "msg_user_during_compaction"))
    expect(position("compaction", jobID)).toBeLessThan(position("part", "msg_assistant_during_compaction"))

    const rendered = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <box flexDirection="column">
                {mounted.rows.flatMap((row) => {
                  if (row.type === "compaction" && row.jobID === jobID)
                    return [
                      <SessionRowView
                        row={row}
                        message={(messageID) => mounted.data.session.message.get(sessionID, messageID)}
                        compaction={(currentJobID) => mounted.data.session.compaction.get(sessionID, currentJobID)}
                        history={() => mounted.data.session.compaction.history(sessionID)}
                      />,
                    ]
                  if (row.type === "message" && row.messageID === "msg_user_during_compaction")
                    return [<text>Newer user chat</text>]
                  if (row.type === "part" && row.ref.messageID === "msg_assistant_during_compaction")
                    return [<text>Newer assistant chat</text>]
                  return []
                })}
              </box>
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 84, height: 18 },
    )
    try {
      rendered.renderer.start()
      await rendered.waitForFrame((frame) => frame.includes("Newer assistant chat"))
      const frame = rendered.captureCharFrame()
      expect(frame.indexOf("~ compacting · advised")).toBeLessThan(frame.indexOf("Newer user chat"))
      expect(frame.indexOf("Newer user chat")).toBeLessThan(frame.indexOf("Newer assistant chat"))
    } finally {
      rendered.renderer.destroy()
    }

    const ended = {
      id: "evt_compaction_background_ended",
      created: 10,
      type: "session.compaction.ended" as const,
      location: { directory },
      durable: durable(sessionID, 10),
      data: {
        sessionID,
        jobID,
        revision: 1,
        boundary: { messageID: "msg_before_compaction", seq: 1 },
        metrics: { excludedMessages: 1, excludedParts: 0, inputTokens: 1_000, retainedTokens: 400 },
      },
    }
    mounted.events.emit(ended as unknown as YCodingEvent)
    mounted.events.emit(ended as unknown as YCodingEvent)
    await wait(() => mounted.data.session.compaction.get(sessionID, jobID)?.status === "completed")
    expect(compaction()).toBe(resident)
    expect(mounted.rows.filter((row) => row.type === "compaction" && row.jobID === jobID)).toHaveLength(1)
    expect(position("compaction", jobID)).toBeLessThan(position("message", "msg_user_during_compaction"))
  } finally {
    mounted.destroy()
  }
})

test("keeps a production compaction before newer assistant and tool rows after completion", async () => {
  const sessionID = "session-v2-compaction-production-order"
  const jobID = "cmp_production_order"
  const assistantMessageID = "msg_assistant_after_compaction"
  const callID = "call_after_compaction"
  const mounted = await mountRows(sessionID, [], {
    messages: () =>
      sessionSnapshot(sessionID, [
        {
          id: "msg_before_compaction",
          type: "user",
          text: "Compacted history",
          files: [],
          agents: [],
          time: { created: 1 },
        },
      ]),
  })
  const compaction = () => mounted.rows.find((row) => row.type === "compaction" && row.jobID === jobID)
  const order = () =>
    mounted.rows.flatMap((row) => {
      if (row.type === "compaction" && row.jobID === jobID) return [`compaction:${row.jobID}`]
      if (row.type === "part" && row.ref.messageID === assistantMessageID) return [`part:${row.ref.partID}`]
      return []
    })

  try {
    mounted.events.emit({
      id: "evt_compaction_production_admitted",
      created: 2,
      type: "session.compaction.admitted",
      location: { directory },
      durable: durable(sessionID, 2),
      data: { sessionID, jobID },
    })
    mounted.events.emit({
      id: "evt_compaction_production_started",
      created: 3,
      type: "session.compaction.started",
      location: { directory },
      durable: durable(sessionID, 3),
      data: { sessionID, jobID },
    })
    await wait(
      () => mounted.data.session.compaction.get(sessionID, jobID)?.status === "running" && compaction() !== undefined,
    )
    const resident = compaction()

    mounted.events.emit({
      id: "evt_assistant_after_compaction_started",
      created: 4,
      type: "session.step.started",
      location: { directory },
      durable: durable(sessionID, 4),
      data: {
        sessionID,
        assistantMessageID,
        agent: "build",
        model: { providerID: "provider", id: "model" },
      },
    } as unknown as YCodingEvent)
    mounted.events.emit({
      id: "evt_text_after_compaction_started",
      created: 5,
      type: "session.text.started",
      location: { directory },
      durable: durableV1(sessionID, 5),
      data: { sessionID, assistantMessageID, ordinal: 0 },
    } as YCodingEvent)
    mounted.events.emit({
      id: "evt_text_after_compaction_ended",
      created: 6,
      type: "session.text.ended",
      location: { directory },
      durable: durableV1(sessionID, 6),
      data: { sessionID, assistantMessageID, ordinal: 0, text: "Newer assistant chat" },
    } as YCodingEvent)
    mounted.events.emit({
      id: "evt_tool_after_compaction_started",
      created: 7,
      type: "session.tool.input.started",
      location: { directory },
      durable: durableV1(sessionID, 7),
      data: { sessionID, assistantMessageID, callID, name: "project_index" },
    } as YCodingEvent)
    await wait(() => order().length === 3)

    expect(mounted.data.session.compaction.get(sessionID, jobID)).not.toHaveProperty("messageID")
    expect(order()).toEqual([`compaction:${jobID}`, "part:text:0", `part:${callID}`])

    const rendered = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <box flexDirection="column">
                {mounted.rows.flatMap((row) => {
                  if (row.type === "compaction" && row.jobID === jobID)
                    return [
                      <SessionRowView
                        row={row}
                        message={(messageID) => mounted.data.session.message.get(sessionID, messageID)}
                        compaction={(currentJobID) => mounted.data.session.compaction.get(sessionID, currentJobID)}
                        history={() => mounted.data.session.compaction.history(sessionID)}
                      />,
                    ]
                  if (row.type === "part" && row.ref.messageID === assistantMessageID)
                    return [<text>{row.ref.partID === callID ? "Newer tool progress" : "Newer assistant chat"}</text>]
                  return []
                })}
              </box>
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 84, height: 18 },
    )
    try {
      rendered.renderer.start()
      await rendered.waitForFrame((frame) => frame.includes("Newer tool progress"))
      const running = rendered.captureCharFrame()
      expect(running.indexOf("~ compacting")).toBeLessThan(running.indexOf("Newer assistant chat"))
      expect(running.indexOf("Newer assistant chat")).toBeLessThan(running.indexOf("Newer tool progress"))

      mounted.events.emit({
        id: "evt_compaction_production_ended",
        created: 8,
        type: "session.compaction.ended",
        location: { directory },
        durable: durable(sessionID, 8),
        data: {
          sessionID,
          jobID,
          revision: 1,
          boundary: { messageID: "msg_before_compaction", seq: 1 },
          metrics: { excludedMessages: 1, excludedParts: 0, inputTokens: 1_000, retainedTokens: 400 },
        },
      } as unknown as YCodingEvent)
      await wait(() => mounted.data.session.compaction.get(sessionID, jobID)?.status === "completed")
      await rendered.waitForFrame((frame) => frame.includes("~ compacted"))

      expect(mounted.data.session.compaction.get(sessionID, jobID)).not.toHaveProperty("messageID")
      expect(compaction()).toBe(resident)
      expect(order()).toEqual([`compaction:${jobID}`, "part:text:0", `part:${callID}`])

      const completed = rendered.captureCharFrame()
      expect(completed.indexOf("~ compacted")).toBeLessThan(completed.indexOf("Newer assistant chat"))
      expect(completed.indexOf("Newer assistant chat")).toBeLessThan(completed.indexOf("Newer tool progress"))
    } finally {
      rendered.renderer.destroy()
    }
  } finally {
    mounted.destroy()
  }
})

test("renders only the latest completed compaction before later chat", async () => {
  const sessionID = "session-v2-repeated-compaction-order"
  const messages: SessionMessageInfo[] = [
    {
      id: "msg_compaction_one",
      type: "compaction",
      jobID: "cmp_one",
      trigger: "advised",
      status: "completed",
      revision: 1,
      boundary: { messageID: "msg_boundary_one", seq: 1 },
      metrics: { excludedMessages: 11, excludedParts: 2, inputTokens: 48_000, retainedTokens: 6_000 },
      time: { created: 1 },
    },
    {
      id: "msg_compaction_two",
      type: "compaction",
      jobID: "cmp_two",
      trigger: "advised",
      status: "completed",
      revision: 2,
      boundary: { messageID: "msg_boundary_two", seq: 2 },
      metrics: { excludedMessages: 19, excludedParts: 4, inputTokens: 92_000, retainedTokens: 6_000 },
      time: { created: 2 },
    },
    {
      id: "msg_compaction_three",
      type: "compaction",
      jobID: "cmp_three",
      trigger: "advised",
      status: "completed",
      revision: 3,
      boundary: { messageID: "msg_boundary_three", seq: 3 },
      metrics: { excludedMessages: 29, excludedParts: 7, inputTokens: 170_000, retainedTokens: 6_000 },
      time: { created: 3 },
    },
    {
      id: "msg_later_chat",
      type: "user",
      text: "Later chat after compactions",
      files: [],
      agents: [],
      time: { created: 4 },
    },
  ]
  const mounted = await mountRows(sessionID, [], {
    messages: () => sessionSnapshot(sessionID, messages),
    compactionHistory: () =>
      compactionHistory(
        ["cmp_one", "cmp_two", "cmp_three"].map((jobID, index) => ({
          jobID,
          trigger: "advised",
          status: "completed",
          created: index + 1,
        })),
      ),
  })
  const order = () =>
    mounted.rows.map((row) =>
      row.type === "compaction"
        ? `compaction:${row.jobID}`
        : row.type === "message"
          ? `message:${row.messageID}`
          : row.type,
    )

  try {
    await wait(() => mounted.data.session.compaction.list(sessionID).length === 3)
    await wait(() => mounted.rows.some((row) => row.type === "compaction" && row.jobID === "cmp_three"))
    const rendered = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <box flexDirection="column">
                {mounted.rows.flatMap((row) => {
                  if (row.type === "compaction")
                    return [
                      <SessionRowView
                        row={row}
                        message={(messageID) => mounted.data.session.message.get(sessionID, messageID)}
                        compaction={(jobID) => mounted.data.session.compaction.get(sessionID, jobID)}
                        history={() => mounted.data.session.compaction.history(sessionID)}
                      />,
                    ]
                  if (row.type === "message" && row.messageID === "msg_later_chat")
                    return [<text>Later chat after compactions</text>]
                  return []
                })}
              </box>
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 100, height: 40 },
    )
    try {
      rendered.renderer.start()
      await rendered.waitForFrame((frame) => frame.includes("Later chat after compactions"))

      expect(order()).toEqual(["compaction:cmp_three", "message:msg_later_chat"])
      await rendered.waitForFrame((frame) => frame.includes("Compression #3"))
      const numbered = rendered.captureCharFrame()
      expect(numbered).not.toContain("Compression #1")
      expect(numbered).not.toContain("Compression #2")
      expect(numbered.indexOf("Compression #3")).toBeGreaterThanOrEqual(0)
      expect(numbered.indexOf("Compression #3")).toBeLessThan(numbered.indexOf("Later chat after compactions"))
    } finally {
      rendered.renderer.destroy()
    }
  } finally {
    mounted.destroy()
  }
})

test("moves a completed compaction marker to its historical message position before later chat", async () => {
  const sessionID = "session-v2-compaction-order"
  const messages: SessionMessageInfo[] = [
    {
      id: "msg_boundary",
      type: "user",
      text: "Compacted history",
      files: [],
      agents: [],
      time: { created: 1 },
    },
    {
      id: "msg_compaction",
      type: "compaction",
      jobID: "cmp_ordered",
      trigger: "advised",
      status: "completed",
      revision: 1,
      boundary: { messageID: "msg_boundary", seq: 1 },
      metrics: { excludedMessages: 1, excludedParts: 0, inputTokens: 1_000, retainedTokens: 400 },
      time: { created: 2 },
    },
    {
      id: "msg_hidden_after_compaction",
      type: "synthetic",
      text: "Internal continuation that produces no transcript row",
      time: { created: 3 },
    },
    {
      id: "msg_after_compaction",
      type: "user",
      text: "Newer chat must follow the marker",
      files: [],
      agents: [],
      time: { created: 4 },
    },
  ]
  const mounted = await mountRows(sessionID, [], { messages: () => sessionSnapshot(sessionID, messages) })

  try {
    await wait(() => mounted.rows.some((row) => row.type === "compaction" && row.jobID === "cmp_ordered"))
    const compaction = mounted.rows.find((row) => row.type === "compaction" && row.jobID === "cmp_ordered")
    if (!compaction) throw new Error("expected the completed compaction row")
    const order = () =>
      mounted.rows.map((row) =>
        row.type === "compaction"
          ? `compaction:${row.jobID}`
          : row.type === "message"
            ? `message:${row.messageID}`
            : row.type,
      )

    expect(order()).toEqual(["compaction:cmp_ordered", "message:msg_after_compaction"])

    mounted.events.emit({
      id: "evt_user_after_compaction",
      created: 5,
      type: "session.input.admitted",
      location: { directory },
      durable: durable(sessionID, 2),
      data: {
        sessionID,
        inputID: "msg_live_after_compaction",
        input: { type: "user", data: { text: "Live chat also follows the marker" }, delivery: "steer" },
      },
    } as unknown as YCodingEvent)
    await wait(() =>
      mounted.rows.some((row) => row.type === "message" && row.messageID === "msg_live_after_compaction"),
    )

    expect(order()).toEqual([
      "compaction:cmp_ordered",
      "message:msg_after_compaction",
      "message:msg_live_after_compaction",
    ])
    expect(mounted.rows.filter((row) => row.type === "compaction" && row.jobID === "cmp_ordered")).toEqual([compaction])
  } finally {
    mounted.destroy()
  }
})

const retainedUser = (id: string, created: number): SessionMessageInfo => ({
  id,
  type: "user",
  text: id,
  files: [],
  agents: [],
  time: { created },
})

const completedCompaction = (jobID: string, boundaryID: string, created: number): SessionMessageInfo => ({
  id: `msg_${jobID}`,
  type: "compaction",
  jobID,
  trigger: "advised",
  status: "completed",
  revision: 1,
  boundary: { messageID: boundaryID, seq: 1 },
  metrics: { excludedMessages: 1, excludedParts: 0, inputTokens: 1_000, retainedTokens: 400 },
  time: { created },
})

const compactionHistory = (
  data: { jobID: string; trigger: string; status: string; created: number }[],
  completedBefore = 0,
  totalSavedTokens = 12_000,
) =>
  json({
    data,
    truncated: completedBefore > 0,
    completedBefore,
    completedCount: completedBefore + data.filter((job) => job.status === "completed").length,
    totalSavedTokens,
  })

const rowOrder = (rows: SessionRow[]) =>
  rows.map((row) =>
    row.type === "compaction"
      ? `compaction:${row.jobID}`
      : row.type === "message"
        ? `message:${row.messageID}`
        : row.type === "part"
          ? `part:${row.ref.partID}`
          : row.type,
  )

test("renders a completed compaction before retained post-boundary messages from a snapshot", async () => {
  const sessionID = "session-compaction-retained-snapshot"
  const mounted = await mountRows(sessionID, [], {
    messages: () =>
      sessionSnapshot(sessionID, [
        retainedUser("msg_boundary", 1),
        retainedUser("msg_retained", 2),
        completedCompaction("cmp_retained", "msg_boundary", 3),
        retainedUser("msg_newer", 4),
      ]),
  })

  try {
    await wait(() => mounted.rows.some((row) => row.type === "compaction"))
    expect(rowOrder(mounted.rows)).toEqual(["compaction:cmp_retained", "message:msg_retained", "message:msg_newer"])

    const rendered = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <box flexDirection="column">
                {mounted.rows.flatMap((row) =>
                  row.type === "compaction"
                    ? [
                        <SessionRowView
                          row={row}
                          message={(messageID) => mounted.data.session.message.get(sessionID, messageID)}
                          compaction={(jobID) => mounted.data.session.compaction.get(sessionID, jobID)}
                          history={() => mounted.data.session.compaction.history(sessionID)}
                        />,
                      ]
                    : row.type === "message"
                      ? [<text>{`Retained ${row.messageID}`}</text>]
                      : [],
                )}
              </box>
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 84, height: 18 },
    )
    try {
      rendered.renderer.start()
      await rendered.waitForFrame((frame) => frame.includes("Retained msg_newer"))
      const frame = rendered.captureCharFrame()
      expect(frame.indexOf("~ compacted")).toBeGreaterThanOrEqual(0)
      expect(frame.indexOf("~ compacted")).toBeLessThan(frame.indexOf("Retained msg_retained"))
    } finally {
      rendered.renderer.destroy()
    }
  } finally {
    mounted.destroy()
  }
})

test("places a live-completed compaction like a snapshot-hydrated one", async () => {
  const sessionID = "session-compaction-retained-live"
  const mounted = await mountRows(sessionID, [], {
    messages: () => sessionSnapshot(sessionID, [retainedUser("msg_boundary", 1), retainedUser("msg_retained", 2)]),
  })

  try {
    mounted.events.emit({
      id: "evt_compaction_live_admitted",
      created: 3,
      type: "session.compaction.admitted",
      location: { directory },
      durable: durable(sessionID, 3),
      data: { sessionID, jobID: "cmp_live" },
    })
    mounted.events.emit({
      id: "evt_compaction_live_ended",
      created: 4,
      type: "session.compaction.ended",
      location: { directory },
      durable: durable(sessionID, 4),
      data: {
        sessionID,
        jobID: "cmp_live",
        revision: 1,
        boundary: { messageID: "msg_boundary", seq: 1 },
        metrics: { excludedMessages: 1, excludedParts: 0, inputTokens: 1_000, retainedTokens: 400 },
      },
    } as unknown as YCodingEvent)
    await wait(() => mounted.data.session.compaction.get(sessionID, "cmp_live")?.status === "completed")
    await wait(() => mounted.rows.some((row) => row.type === "compaction"))
    expect(mounted.data.session.compaction.get(sessionID, "cmp_live")).not.toHaveProperty("messageID")
    expect(rowOrder(mounted.rows)).toEqual(["compaction:cmp_live", "message:msg_retained"])
  } finally {
    mounted.destroy()
  }
})

test("renders no compaction row when its message is no longer resident and appends live rows last", async () => {
  const sessionID = "session-compaction-not-resident"
  let snapshots = 0
  const mounted = await mountRows(sessionID, [], {
    messages: () => {
      snapshots++
      return snapshots === 1
        ? sessionSnapshot(sessionID, [
            retainedUser("msg_boundary", 1),
            completedCompaction("cmp_gone", "msg_boundary", 2),
            retainedUser("msg_before_resync", 3),
          ])
        : sessionSnapshot(sessionID, [retainedUser("msg_newest", 4)])
    },
  })

  try {
    await wait(() => mounted.rows.some((row) => row.type === "compaction"))
    mounted.data.session.message.invalidate(sessionID)
    await mounted.data.session.message.sync(sessionID)
    await wait(() => !mounted.rows.some((row) => row.type === "compaction"))

    mounted.events.emit({
      id: "evt_text_after_resync",
      created: 5,
      type: "session.text.delta",
      data: { sessionID, assistantMessageID: "msg_assistant_live", ordinal: 0, delta: "live" },
    } as YCodingEvent)
    await wait(() => mounted.rows.some((row) => row.type === "part"))
    expect(rowOrder(mounted.rows)).toEqual(["message:msg_newest", "part:text:0"])
  } finally {
    mounted.destroy()
  }
})

test("releases compaction lifecycles when a Session transcript is evicted", async () => {
  const sessionID = "session-compaction-evict"
  const mounted = await mountRows(sessionID, [], {
    messages: () =>
      sessionSnapshot(sessionID, [
        retainedUser("msg_boundary", 1),
        completedCompaction("cmp_evicted", "msg_boundary", 2),
      ]),
  })

  try {
    await wait(() => mounted.data.session.compaction.list(sessionID).length === 1)
    mounted.data.session.message.evict(sessionID)
    expect(mounted.data.session.compaction.list(sessionID)).toEqual([])
  } finally {
    mounted.destroy()
  }
})

test("reads full compaction history after hydrating a completed lifecycle and again after it ends", async () => {
  const sessionID = "session-compaction-history-reads"
  let reads = 0
  const mounted = await mountRows(sessionID, [], {
    messages: () =>
      sessionSnapshot(sessionID, [
        retainedUser("msg_boundary", 1),
        completedCompaction("cmp_first", "msg_boundary", 2),
      ]),
    compactionHistory: () => {
      reads++
      return reads === 1
        ? compactionHistory([{ jobID: "cmp_first", trigger: "advised", status: "completed", created: 2 }], 41, 5_000)
        : compactionHistory(
            [
              { jobID: "cmp_first", trigger: "advised", status: "completed", created: 2 },
              { jobID: "cmp_second", trigger: "advised", status: "completed", created: 3 },
            ],
            41,
            9_000,
          )
    },
  })

  try {
    await wait(() => mounted.data.session.compaction.history(sessionID) !== undefined)
    expect(reads).toBe(1)
    expect(mounted.data.session.compaction.history(sessionID)).toMatchObject({
      completedBefore: 41,
      totalSavedTokens: 5_000,
    })

    mounted.events.emit({
      id: "evt_compaction_second_admitted",
      created: 3,
      type: "session.compaction.admitted",
      location: { directory },
      durable: durable(sessionID, 3),
      data: { sessionID, jobID: "cmp_second" },
    })
    mounted.events.emit({
      id: "evt_compaction_second_ended",
      created: 4,
      type: "session.compaction.ended",
      location: { directory },
      durable: durable(sessionID, 4),
      data: {
        sessionID,
        jobID: "cmp_second",
        revision: 2,
        boundary: { messageID: "msg_boundary", seq: 1 },
        metrics: { excludedMessages: 1, excludedParts: 0, inputTokens: 1_000, retainedTokens: 400 },
      },
    } as unknown as YCodingEvent)
    await wait(() => mounted.data.session.compaction.history(sessionID)?.totalSavedTokens === 9_000)
    expect(reads).toBe(2)
  } finally {
    mounted.destroy()
  }
})

test("refreshes compaction history after ended only for a resident transcript", async () => {
  const sessionID = "session-compaction-history-resident"
  const backgroundID = "session-compaction-history-background"
  const reads: string[] = []
  const mounted = await mountRows(sessionID, [], {
    messages: () =>
      sessionSnapshot(sessionID, [
        retainedUser("msg_boundary", 1),
        completedCompaction("cmp_resident", "msg_boundary", 2),
      ]),
    compactionHistory: (id) => {
      reads.push(id)
      return compactionHistory([])
    },
  })
  const ended = (id: string, seq: number) =>
    ({
      id: `evt_history_ended_${id}`,
      created: seq,
      type: "session.compaction.ended",
      location: { directory },
      durable: durable(id, seq),
      data: {
        sessionID: id,
        jobID: `cmp_${id}`,
        revision: 1,
        boundary: { messageID: "msg_boundary", seq: 1 },
        metrics: { excludedMessages: 1, excludedParts: 0, inputTokens: 1_000, retainedTokens: 400 },
      },
    }) as unknown as YCodingEvent

  try {
    await wait(() => reads.length === 1)
    mounted.events.emit(ended(backgroundID, 7))
    await wait(() => mounted.data.session.compaction.get(backgroundID, `cmp_${backgroundID}`)?.status === "completed")
    mounted.events.emit(ended(sessionID, 8))
    await wait(() => reads.length === 2)
    expect(reads).toEqual([sessionID, sessionID])
    expect(mounted.data.session.compaction.history(backgroundID)).toBeUndefined()
  } finally {
    mounted.destroy()
  }
})

test("does not read compaction history for a Session without a visible compaction lifecycle", async () => {
  const sessionID = "session-compaction-history-none"
  let reads = 0
  const mounted = await mountRows(sessionID, [], {
    messages: () => sessionSnapshot(sessionID, [retainedUser("msg_only", 1)]),
    compactionHistory: () => {
      reads++
      return compactionHistory([])
    },
  })

  try {
    await mounted.data.session.compaction.sync(sessionID)
    expect(reads).toBe(0)
    expect(mounted.data.session.compaction.history(sessionID)).toBeUndefined()
  } finally {
    mounted.destroy()
  }
})

test("leaves compaction history unavailable when the read fails and keeps the divider", async () => {
  const sessionID = "session-compaction-history-failed"
  let reads = 0
  const mounted = await mountRows(sessionID, [], {
    messages: () =>
      sessionSnapshot(sessionID, [
        retainedUser("msg_boundary", 1),
        completedCompaction("cmp_failed_read", "msg_boundary", 2),
      ]),
    compactionHistory: () => {
      reads++
      return json({ error: "unavailable" }, { status: 500 })
    },
  })

  try {
    await wait(() => reads === 1)
    await wait(() => mounted.rows.some((row) => row.type === "compaction"))
    await Bun.sleep(20)
    expect(mounted.data.session.compaction.history(sessionID)).toBeUndefined()
  } finally {
    mounted.destroy()
  }
})

test("renders the server-provided compression number and releases history on eviction", async () => {
  const sessionID = "session-compaction-history-number"
  const mounted = await mountRows(sessionID, [], {
    messages: () =>
      sessionSnapshot(sessionID, [
        retainedUser("msg_boundary", 1),
        completedCompaction("cmp_numbered", "msg_boundary", 2),
      ]),
    compactionHistory: () =>
      compactionHistory([{ jobID: "cmp_numbered", trigger: "advised", status: "completed", created: 2 }], 41, 64_000),
  })

  try {
    await wait(() => mounted.data.session.compaction.history(sessionID) !== undefined)
    const rendered = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <box flexDirection="column">
                {mounted.rows.flatMap((row) =>
                  row.type === "compaction"
                    ? [
                        <SessionRowView
                          row={row}
                          message={(messageID) => mounted.data.session.message.get(sessionID, messageID)}
                          compaction={(jobID) => mounted.data.session.compaction.get(sessionID, jobID)}
                          history={() => mounted.data.session.compaction.history(sessionID)}
                        />,
                      ]
                    : [],
                )}
              </box>
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 100, height: 12 },
    )
    try {
      rendered.renderer.start()
      await rendered.waitForFrame((frame) => frame.includes("Compression #42"))
    } finally {
      rendered.renderer.destroy()
    }

    mounted.data.session.message.evict(sessionID)
    expect(mounted.data.session.compaction.history(sessionID)).toBeUndefined()
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
      location: { directory },
      durable: durableV1(sessionID, 2),
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
      location: { directory },
      durable: durableV1(sessionID, 4),
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

test("a full reconcile after streaming preserves incremental part row identity", async () => {
  const sessionID = "session-reconcile-stream-identity"
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
      location: { directory },
      durable: durableV1(sessionID, 2),
      data: { sessionID, assistantMessageID: "msg_assistant", ordinal: 0 },
    } as YCodingEvent)
    mounted.events.emit({
      id: "evt_text_ended",
      created: 3,
      type: "session.text.ended",
      location: { directory },
      durable: durableV1(sessionID, 3),
      data: { sessionID, assistantMessageID: "msg_assistant", ordinal: 0, text: "streamed answer" },
    } as YCodingEvent)
    mounted.events.emit({
      id: "evt_tool_started",
      created: 4,
      type: "session.tool.input.started",
      location: { directory },
      durable: durableV1(sessionID, 4),
      data: { sessionID, assistantMessageID: "msg_assistant", callID: "call_x", name: "project_index" },
    } as YCodingEvent)
    await wait(() => mounted.rows.some((row) => row.type === "part" && row.ref.partID === "text:0"))
    await wait(() => mounted.rows.some((row) => row.type === "part" && row.ref.partID === "call_x"))

    const textRow = mounted.rows.find((row) => row.type === "part" && row.ref.partID === "text:0")
    const toolRow = mounted.rows.find((row) => row.type === "part" && row.ref.partID === "call_x")

    // A user prompt during or after streaming changes the message list, which triggers a full
    // reconcile(reduce(), { key }). Incremental rows must carry the same key reduce() assigns so
    // reconcile reuses them instead of tearing down and recreating their renderables (and the
    // native text buffers behind them).
    mounted.events.emit({
      id: "evt_user_next",
      created: 5,
      type: "session.input.admitted",
      location: { directory },
      durable: durable(sessionID, 5),
      data: {
        sessionID,
        inputID: "msg_user_next",
        input: { type: "user", data: { text: "next" }, delivery: "steer" },
      },
    } as unknown as YCodingEvent)
    await wait(() => mounted.rows.some((row) => row.type === "message" && row.messageID === "msg_user_next"))

    expect(mounted.rows.find((row) => row.type === "part" && row.ref.partID === "text:0")).toBe(textRow)
    expect(mounted.rows.find((row) => row.type === "part" && row.ref.partID === "call_x")).toBe(toolRow)
  } finally {
    mounted.destroy()
  }
})

test("an active subagent does not create a transcript row", async () => {
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
    expect(mounted.rows.some((row) => row.type === "subagent")).toBe(false)

    mounted.events.emit({
      id: "evt_compaction_started",
      created: 2,
      type: "session.compaction.started",
      durable: durable(sessionID, 1),
      data: { sessionID, jobID: "cmp_activity" },
    })
    await wait(() => mounted.rows.some((row) => row.type === "compaction"))
    expect(mounted.rows.some((row) => row.type === "subagent")).toBe(false)
  } finally {
    mounted.destroy()
  }
})

test("shows an invoked skill block live, directly after the prompt that requested it", async () => {
  const sessionID = "ses_live_skill_invocation"
  const mounted = await mountRows(sessionID)
  try {
    mounted.events.emit({
      id: "evt_skill_prompt_admitted",
      created: 1,
      type: "session.input.admitted",
      location: { directory },
      durable: durable(sessionID, 1),
      data: {
        sessionID,
        inputID: "msg_skill_prompt",
        input: {
          type: "user",
          data: {
            text: "$performance-optimization profile startup",
            metadata: { skills: [{ id: "performance-optimization" }] },
          },
          delivery: "steer",
        },
      },
    } as unknown as YCodingEvent)
    mounted.events.emit({
      id: "evt_skill_prompt_promoted",
      created: 2,
      type: "session.input.promoted",
      location: { directory },
      durable: durable(sessionID, 2),
      data: { sessionID, inputID: "msg_skill_prompt" },
    } as unknown as YCodingEvent)
    mounted.events.emit({
      id: "evt_skill_block",
      created: 3,
      type: "session.skill.activated",
      location: { directory },
      durable: durable(sessionID, 3),
      data: {
        sessionID,
        id: "performance-optimization",
        name: "performance-optimization",
        text: '<skill_content name="performance-optimization">\n# Skill: performance-optimization\n</skill_content>',
      },
    } as unknown as YCodingEvent)
    await wait(() => mounted.rows.some((row) => row.type === "message" && row.messageID === "msg_skill_block"))
    expect(mounted.data.session.message.get(sessionID, "msg_skill_block")).toMatchObject({
      type: "skill",
      skill: "performance-optimization",
      name: "performance-optimization",
    })
    expect(
      mounted.rows
        .filter((row) => row.type === "message")
        .map((row) => row.messageID)
        .filter((id) => id === "msg_skill_prompt" || id === "msg_skill_block"),
    ).toEqual(["msg_skill_prompt", "msg_skill_block"])
    mounted.events.emit({
      id: "evt_skill_block_deactivated",
      created: 4,
      type: "session.skill.deactivated",
      location: { directory },
      durable: durable(sessionID, 4),
      data: {
        sessionID,
        id: "performance-optimization",
        activationMessageID: "msg_skill_block",
        reason: "conflict_resolved",
      },
    } as unknown as YCodingEvent)
    await wait(() => {
      const block = mounted.data.session.message.get(sessionID, "msg_skill_block")
      return block?.type === "skill" && block.skillDeactivations !== undefined
    })
    expect(JSON.parse(JSON.stringify(mounted.data.session.message.get(sessionID, "msg_skill_block")))).toMatchObject({
      skillDeactivations: [{ skill: "performance-optimization", reason: "conflict_resolved" }],
    })
  } finally {
    mounted.destroy()
  }
})
