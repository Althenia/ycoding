import { describe, expect, test } from "bun:test"
import type { SessionCompletionsOutput, SessionInfo } from "@ycoding-ai/client/promise"
import { RemoteCloseCode, RemoteLimits, parseAgentMessage, parseChunkedValue } from "@ycoding-ai/remote"
import { RemoteAgent, type BridgeCredentials, type ConnectionInput, type RelayConnection } from "../src/remote-bridge"
import type { AllowlistSession } from "../src/remote-config"
import { DeviceAuthorizationError } from "../src/remote-credentials"
import { LocalFailure, type LocalEventStream, type LocalServer } from "../src/remote-local"

const entry: AllowlistSession = { sessionID: "ses_1", directory: "/work", workspaceID: undefined, title: "One" }
const second: AllowlistSession = { sessionID: "ses_2", directory: "/work", workspaceID: undefined, title: "Two" }

function sessionInfo(id: string, table: { updated?: number; directory?: string; title?: string } = {}): SessionInfo {
  return {
    id,
    projectID: "prj_1",
    cost: { amount: 0, currency: "USD" },
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    time: { created: table.updated ?? 1, updated: table.updated ?? 1 },
    title: table.title ?? id,
    location: { directory: table.directory ?? "/work", workspaceID: undefined },
  } as unknown as SessionInfo
}

type Call = { readonly method: string; readonly args: readonly unknown[] }

async function waitFor<Value>(check: () => Value | undefined, timeout = 1_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = check()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error("condition timed out")
    await Bun.sleep(5)
  }
}

function fakeLocal(results: Partial<Record<keyof LocalServer, unknown>> = {}) {
  const calls: Call[] = []
  const streams: Array<{ stream: LocalEventStream; stop: () => Promise<void>; stopped: boolean }> = []
  const local = new Proxy({} as LocalServer, {
    get(_target, property: PropertyKey) {
      if (property === "events") {
        const result = results.events
        if (typeof result === "function")
          return (stream: LocalEventStream) => {
            calls.push({ method: "events", args: [] })
            return Promise.resolve((result as (value: LocalEventStream) => unknown)(stream))
          }
        return async (stream: LocalEventStream) => {
          calls.push({ method: "events", args: [] })
          const record = { stream, stopped: false, stop: async () => void (record.stopped = true) }
          streams.push(record)
          return record.stop
        }
      }
      return (...args: unknown[]) => {
        calls.push({ method: String(property), args })
        const result = results[property as keyof LocalServer]
        if (typeof result === "function") return Promise.resolve((result as (...a: unknown[]) => unknown)(...args))
        if (result instanceof Error) return Promise.reject(result)
        return Promise.resolve(result)
      }
    },
  })
  return { local, calls, streams }
}

type ConnectionRecord = {
  readonly input: ConnectionInput
  readonly sent: string[]
  readonly deliver: (frame: unknown) => void
  readonly disconnected: boolean
  bufferedAmount: number
}

function harness(options: {
  sessions?: readonly AllowlistSession[]
  failStatusOnce?: boolean
  results?: Partial<Record<keyof LocalServer, unknown>>
  credentials?: () => Promise<BridgeCredentials>
  reloadSessions?: () => Promise<readonly AllowlistSession[]>
}) {
  const { local, calls, streams } = fakeLocal({
    listPage: async () => ({
      data: (options.sessions ?? [entry]).map((value) =>
        sessionInfo(value.sessionID, { directory: value.directory, title: value.title }),
      ),
    }),
    getSession: async (sessionID: string) => sessionInfo(sessionID),
    activeSessions: {}, outstandingSessions: { data: [], running: [], failed: [] }, completions: { data: [] }, permissionRequests: [], formRequests: [], guardrailRequestList: [],
    ...options.results,
  })
  const records: ConnectionRecord[] = []
  const diagnostics: string[] = []
  const terminal: string[] = []
  let clock = 1_000
  let tokens = 0
  let failStatus = options.failStatusOnce ?? false
  const bridge = new RemoteAgent({
    relayURL: "https://relay.example",
    local,
    credentials: options.credentials ?? (async () => ({ accessToken: `token_${++tokens}`, accessExpiresAt: clock + 600_000 })),
    createConnection: (input) => {
      const record = {
        input,
        sent: [] as string[],
        deliver: (frame: unknown) => handler?.(frame),
        disconnect: async () => {
          state.disconnected = true
        },
        disconnected: false,
        bufferedAmount: 0,
      }
      const state = { disconnected: false }
      let handler: ((frame: unknown) => void) | undefined
      const connection: RelayConnection = {
        connect: async () => input.onOpen(),
        send: async (value: string) => {
          if (state.disconnected) throw new Error("Relay connection is closed")
          if (failStatus && value.includes('"type":"status"')) {
            failStatus = false
            throw new Error("Status frame rejected")
          }
          record.sent.push(value)
        },
        onMessage: (next) => {
          handler = next
        },
        disconnect: async () => {
          state.disconnected = true
        },
      }
      Object.defineProperty(record, "disconnected", { get: () => state.disconnected })
      records.push(record as ConnectionRecord)
      void connection
      return {
        connect: connection.connect,
        send: connection.send,
        onMessage: connection.onMessage,
        disconnect: connection.disconnect,
        get bufferedAmount() {
          return record.bufferedAmount
        },
      }
    },
    refreshIntervalMs: 3_600_000,
    conflictRetryMs: 300,
    eventRetryInitialMs: 5,
    eventRetryMaxMs: 10,
    now: () => clock,
    onDiagnostic: (message) => diagnostics.push(message),
    onTerminal: (message) => terminal.push(message),
  })
  return {
    bridge,
    records,
    calls,
    streams,
    diagnostics,
    terminal,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

function sentFrames(record: ConnectionRecord) {
  return record.sent.map((frame) => parseAgentMessage(frame)).map((frame) => {
    expect(frame.ok).toBe(true)
    if (!frame.ok) throw new Error("unparseable agent frame")
    return frame.value
  })
}

function sentEvents(record: ConnectionRecord) {
  return sentFrames(record).flatMap((frame) =>
    frame.type === "events" ? frame.events.map((event) => ({ sessionID: frame.sessionID, event })) : [],
  )
}

const completion = (sessionID: string, seq = 12) => ({
  id: `evt_${sessionID}_${seq}`, seq, created: 1_000, sessionID, inputID: "msg_input", assistantMessageID: "msg_final",
})

test("pages explicit completion receipts without a browser subscription and refreshes on accepted completion", async () => {
  let seq = 12
  const test = harness({ results: {
    completions: (input: { after?: string; limit: number }) => input.after === undefined
      ? { data: [completion("ses_1", seq)], next: "ses_1" }
      : { data: [completion("ses_2", seq)] },
  } })
  try {
    await test.bridge.connect()
    await waitFor(() => sentFrames(test.records[0]).filter((frame) => frame.type === "completions").length >= 2 ? true : undefined)
    expect(sentFrames(test.records[0]).filter((frame) => frame.type === "completions").slice(0, 2)).toEqual([
      { type: "completions", data: [{ id: "evt_ses_1_12", seq: 12, created: 1_000, sessionID: "ses_1", title: "One" }], more: true },
      { type: "completions", data: [{ id: "evt_ses_2_12", seq: 12, created: 1_000, sessionID: "ses_2" }], more: false },
    ])
    expect(test.calls.filter((call) => call.method === "completions").slice(0, 2).map((call) => call.args)).toEqual([
      [{ limit: 200 }], [{ limit: 200, after: "ses_1" }],
    ])
    seq = 20
    test.streams[0].stream.onEvent({ type: "session.work.completed", data: { sessionID: "ses_1", inputID: "msg_input", assistantMessageID: "msg_final" } })
    await waitFor(() => sentFrames(test.records[0]).find((frame) => frame.type === "completions" && frame.data.some((item) => item.seq === 20)))
    expect(sentEvents(test.records[0])).toHaveLength(0)
  } finally { await test.bridge.close() }
})

test("retries a failed completion page without declaring a partial baseline complete", async () => {
  let failed = false
  const test = harness({ results: {
    completions: (input: { after?: string }) => {
      if (input.after === undefined) return { data: [completion("ses_1")], next: "ses_1" }
      if (!failed) { failed = true; throw new Error("private provider detail") }
      return { data: [completion("ses_2")] }
    },
  } })
  try {
    await test.bridge.connect()
    await waitFor(() => sentFrames(test.records[0]).find((frame) => frame.type === "completions" && !frame.more))
    expect(sentFrames(test.records[0]).filter((frame) => frame.type === "completions").slice(0, 3).map((frame) => [frame.data[0]?.sessionID, frame.more])).toEqual([
      ["ses_1", true], ["ses_1", true], ["ses_2", false],
    ])
    expect(test.diagnostics.some((message) => message.startsWith("could not synchronize work completions"))).toBe(true)
    expect(test.diagnostics.join(" ")).not.toContain("private provider detail")
  } finally { await test.bridge.close() }
})

test("discards a pending completion page from a prior opening of the same connection", async () => {
  let resolve!: (value: SessionCompletionsOutput) => void
  const pending = new Promise<SessionCompletionsOutput>((done) => { resolve = done })
  let reads = 0
  const test = harness({ results: { completions: () => ++reads === 1 ? pending : { data: [completion("ses_current")] } } })
  try {
    await test.bridge.connect()
    await waitFor(() => reads === 1 ? true : undefined)
    test.records[0].input.onClose(1006)
    test.records[0].input.onOpen()
    await waitFor(() => sentFrames(test.records[0]).find((frame) => frame.type === "completions" && frame.data[0]?.sessionID === "ses_current"))
    resolve({ data: [completion("ses_stale")], next: "ses_stale" })
    await Bun.sleep(50)
    expect(sentFrames(test.records[0]).filter((frame) => frame.type === "completions").flatMap((frame) => frame.data).every((item) => item.sessionID === "ses_current")).toBe(true)
    expect(test.calls.filter((call) => call.method === "completions").some((call) => (call.args[0] as { after?: string }).after === "ses_stale")).toBe(false)
  } finally { resolve({ data: [] }); await test.bridge.close() }
})

function sessionsFrame(record: ConnectionRecord) {
  const frames = sentFrames(record).filter((value) => value.type === "sessions")
  expect(frames.length).toBeGreaterThan(0)
  return frames.at(-1) as { type: "sessions" }
}

function requestFrame(operation: string, sessionID?: string, input?: Record<string, unknown>) {
  return { type: "request", id: "req_1", operation, ...(sessionID === undefined ? {} : { sessionID }), ...(input === undefined ? {} : { input }) }
}

describe("remote bridge", () => {
  test("settled activity invalidates an unsubscribed Session list without waiting for periodic refresh", async () => {
    let current = { ...sessionInfo("ses_1"), time: { created: 1, updated: 1, active: 2 } }
    const test = harness({ results: { listPage: async () => ({ data: [current] }), getSession: async () => current } })
    await test.bridge.connect()
    try {
      await waitFor(() => test.streams[0])
      const before = sentFrames(test.records[0]).filter((frame) => frame.type === "sessions").length
      current = { ...current, time: { ...current.time, active: 20 } }
      test.streams[0].stream.onEvent({ type: "session.step.ended", data: { sessionID: "ses_1" } })
      await waitFor(() => sentFrames(test.records[0]).filter((frame) => frame.type === "sessions").length > before ? true : undefined)
      expect(test.calls.filter((call) => call.method === "getSession").length).toBeGreaterThan(0)
      expect(sentEvents(test.records[0])).toHaveLength(0)
    } finally { await test.bridge.close() }
  })

  test("an inventory refresh rehydrates a failed Session that was not yet advertised", async () => {
    let registered = false
    const test = harness({ results: {
      listPage: async () => ({ data: registered ? [sessionInfo("ses_new")] : [] }),
      outstandingSessions: () => ({ data: [], running: [], failed: ["ses_new"] }),
    } })
    await test.bridge.connect()
    try {
      await waitFor(() => sentFrames(test.records[0]).find((frame) => frame.type === "status" && frame.attention.length === 0))
      registered = true
      test.streams[0].stream.onEvent({ type: "session.created", data: { sessionID: "ses_new" } })
      await waitFor(() => test.bridge.advertised.includes("ses_new") ? true : undefined)
      await waitFor(() => sentFrames(test.records[0]).find((frame) => frame.type === "status" && frame.attention.includes("ses_new")) ? true : undefined, 2_000)
    } finally { await test.bridge.close() }
  })
  test("stopping an idle goal through the relay refreshes outstanding work without waiting for a periodic poll", async () => {
    let outstanding = ["ses_1"]
    const test = harness({ results: {
      outstandingSessions: () => ({ data: outstanding, running: [], failed: [] }),
      autonomySet: () => ({ mode: "normal", yolo: 0, goal: { text: "Finish", status: "stopped" } }),
      getSession: async (sessionID: string) => sessionInfo(sessionID, { title: "One" }),
    } })
    await test.bridge.connect()
    try {
      await waitFor(() => sentFrames(test.records[0]).find((frame) => frame.type === "status" && frame.outstanding?.includes("ses_1")))
      const before = sentFrames(test.records[0]).filter((frame) => frame.type === "status").length
      outstanding = []
      test.records[0].deliver(requestFrame("session.goal.stop", "ses_1", { goal: null }))
      await waitFor(() => sentFrames(test.records[0]).find((frame) => frame.type === "response" && frame.ok))
      await waitFor(() => sentFrames(test.records[0]).filter((frame) => frame.type === "status").slice(before)
        .some((frame) => frame.outstanding === undefined) ? true : undefined, 2_000)
    } finally { await test.bridge.close() }
  })
  test("a failed family remains in attention until its next execution starts, including after reconnect", async () => {
    let persistedFailure = true
    const test = harness({ results: { outstandingSessions: () => ({ data: [], running: [], failed: persistedFailure ? ["ses_1"] : [] }) } })
    await test.bridge.connect()
    try {
      await waitFor(() => sentFrames(test.records[0]).find((frame) => frame.type === "status" && frame.attention.includes("ses_1")))
      test.records[0].input.onClose(1012)
      test.records[0].input.onOpen()
      await waitFor(() => sentFrames(test.records[0]).filter((frame) => frame.type === "status" && frame.attention.includes("ses_1")).length > 1 ? true : undefined)
      persistedFailure = false
      test.streams[0].stream.onEvent({ type: "session.execution.started.1", data: { sessionID: "ses_1" } })
      await waitFor(() => sentFrames(test.records[0]).find((frame) => frame.type === "status" && frame.attention.length === 0))
      persistedFailure = true
      test.streams[0].stream.onEvent({ type: "session.execution.failed.1", data: { sessionID: "ses_1" } })
      await waitFor(() => sentFrames(test.records[0]).filter((frame) => frame.type === "status" && frame.attention.includes("ses_1")).length > 2 ? true : undefined)
    } finally { await test.bridge.close() }
  })

  test("a guardrail block in a Session family reports its root with the root's title, and an allowed action reports nothing", async () => {
    const child = { ...sessionInfo("ses_child"), parentID: "ses_1" } as SessionInfo
    const test = harness({ results: { listPage: async () => ({ data: [sessionInfo("ses_1", { title: "One" }), child] }) } })
    await test.bridge.connect()
    try {
      await waitFor(() => test.streams[0])
      test.streams[0].stream.onEvent({ type: "guardrail.decided", data: { rootSessionID: "ses_1", sessionID: "ses_child", decision: "allow" } })
      test.streams[0].stream.onEvent({ type: "guardrail.decided", data: { rootSessionID: "ses_1", sessionID: "ses_child", decision: "deny" } })
      await waitFor(() => sentFrames(test.records[0]).find((frame) => frame.type === "blocked"))
      expect(sentFrames(test.records[0]).filter((frame) => frame.type === "blocked")).toEqual([{ type: "blocked", sessionID: "ses_1", title: "One" }])
    } finally { await test.bridge.close() }
  })

  test("a connector refused because another connector is live backs off instead of reconnecting at once", async () => {
    const test = harness({})
    await test.bridge.connect()
    try {
      test.records[0].input.onClose(RemoteCloseCode.agentConflict, "Another YCoding connector is connected for this device")
      await waitFor(() => test.records[0].disconnected ? true : undefined)
      await Bun.sleep(100)
      expect(test.records).toHaveLength(1)
      expect(test.diagnostics.at(-1)).toContain("another connector is live for this device; retrying in 0 s")
      await waitFor(() => test.records.length === 2 ? true : undefined, 2_000)
      expect(test.bridge.currentState).toBe("live")
    } finally { await test.bridge.close() }
  })

  test("a request event during the reconnect failure read never drops a failed family from attention", async () => {
    let held: { resolve: (value: unknown) => void } | undefined
    const test = harness({ results: { outstandingSessions: () => held === undefined
      ? { data: [], running: [], failed: ["ses_1"] }
      : new Promise((resolve) => { held!.resolve = resolve }) } })
    await test.bridge.connect()
    try {
      await waitFor(() => sentFrames(test.records[0]).find((frame) => frame.type === "status" && frame.attention.includes("ses_1")))
      const before = sentFrames(test.records[0]).length
      held = { resolve: () => undefined }
      test.records[0].input.onClose(1000)
      test.records[0].input.onOpen()
      await waitFor(() => test.calls.filter((call) => call.method === "outstandingSessions").length > 1 ? true : undefined)
      test.streams[0].stream.onEvent({ type: "guardrail.decided", data: { sessionID: "ses_1", decision: "allow" } })
      held.resolve({ data: [], running: [], failed: ["ses_1"] })
      held = undefined
      await waitFor(() => sentFrames(test.records[0]).slice(before).find((frame) => frame.type === "status"))
      await Bun.sleep(400)
      const statuses = sentFrames(test.records[0]).slice(before).filter((frame) => frame.type === "status")
      expect(statuses.length).toBeGreaterThan(0)
      expect(statuses.every((frame) => frame.attention.includes("ses_1"))).toBe(true)
    } finally { held?.resolve({ data: [], running: [], failed: ["ses_1"] }); await test.bridge.close() }
  })

  test("a failure-only family is in attention and failed, a family with a pending request too is in attention only, and the next execution clears both", async () => {
    let requests: unknown[] = []
    const test = harness({ sessions: [entry, second], results: {
      outstandingSessions: () => ({ data: ["ses_2"], running: ["ses_2"], failed: ["ses_1", "ses_2"] }),
      permissionRequests: () => requests,
    } })
    await test.bridge.connect()
    try {
      await waitFor(() => sentFrames(test.records[0]).find((frame) => frame.type === "status"))
      expect(sentFrames(test.records[0]).filter((frame) => frame.type === "status").at(-1)).toEqual({ type: "status", running: ["ses_2"], attention: ["ses_1", "ses_2"], failed: ["ses_1", "ses_2"],
        details: [{ sessionID: "ses_1", title: "One" }, { sessionID: "ses_2", title: "Two" }] })
      requests = [{ id: "per_1", sessionID: "ses_2" }]
      test.streams[0].stream.onEvent({ type: "permission.v2.asked", data: { sessionID: "ses_2" } })
      await waitFor(() => sentFrames(test.records[0]).find((frame) => frame.type === "status" && frame.failed?.join() === "ses_1"))
      expect(sentFrames(test.records[0]).filter((frame) => frame.type === "status").at(-1)).toEqual({ type: "status", running: ["ses_2"], attention: ["ses_1", "ses_2"], failed: ["ses_1"],
        details: [{ sessionID: "ses_1", title: "One" }, { sessionID: "ses_2", title: "Two", need: "permission" }] })
      test.streams[0].stream.onEvent({ type: "session.execution.started.1", data: { sessionID: "ses_1" } })
      test.streams[0].stream.onEvent({ type: "session.execution.started.1", data: { sessionID: "ses_2" } })
      await waitFor(() => sentFrames(test.records[0]).find((frame) => frame.type === "status" && frame.failed === undefined && frame.attention.join() === "ses_2"))
    } finally { await test.bridge.close() }
  })

  test("a shell or subagent change republishes the one outstanding family set", async () => {
    let outstanding: string[] = []
    const test = harness({ results: { outstandingSessions: () => ({ data: outstanding, running: [], failed: [] }) } })
    await test.bridge.connect()
    try {
      await waitFor(() => sentFrames(test.records[0]).some((frame) => frame.type === "status") ? true : undefined)
      outstanding = ["ses_1"]
      test.streams[0].stream.onEvent({ type: "session.task.updated", data: { sessionID: "ses_1" } })
      await waitFor(() => sentFrames(test.records[0]).some((frame) => frame.type === "status" && frame.outstanding?.includes("ses_1")) ? true : undefined)
      outstanding = []
      test.streams[0].stream.onEvent({ type: "session.shell.ended", data: { sessionID: "ses_1" } })
      await waitFor(() => sentFrames(test.records[0]).filter((frame) => frame.type === "status").at(-1)?.outstanding === undefined ? true : undefined)
    } finally { await test.bridge.close() }
  })
  test("a failed status send remains eligible for the next execution event", async () => {
    const test = harness({ failStatusOnce: true })
    await test.bridge.connect()
    try {
      await waitFor(() => test.diagnostics.some((message) => message.includes("frame was delivered")) ? true : undefined)
      await waitFor(() => test.streams[0])
      test.streams[0].stream.onEvent({ type: "session.execution.started.1", data: { sessionID: "ses_1" } })
      await waitFor(() => sentFrames(test.records[0]).some((frame) => frame.type === "status") ? true : undefined)
      expect(sentFrames(test.records[0]).filter((frame) => frame.type === "status")).toEqual([
        { type: "status", running: [], attention: [] },
      ])
    } finally { await test.bridge.close() }
  })
  test("a failed outstanding-work read retries the finished family without another event", async () => {
    let running = true
    let failNextRead = false
    const test = harness({ results: {
      outstandingSessions: () => {
        if (failNextRead) { failNextRead = false; throw new Error("transient status read") }
        return { data: running ? ["ses_1"] : [], running: running ? ["ses_1"] : [], failed: [] }
      },
    } })
    await test.bridge.connect()
    try {
      await waitFor(() => sentFrames(test.records[0]).find((frame) => frame.type === "status" && frame.running.includes("ses_1")))
      running = false
      failNextRead = true
      test.streams[0].stream.onEvent({ type: "session.execution.succeeded.1", data: { sessionID: "ses_1" } })
      await waitFor(() => test.diagnostics.find((message) => message.startsWith("could not read remote Session status")))
      expect(sentFrames(test.records[0]).filter((frame) => frame.type === "status").at(-1)?.running).toEqual(["ses_1"])
      await waitFor(() => sentFrames(test.records[0]).find((frame) => frame.type === "status" && frame.running.length === 0))
      expect(test.calls.filter((call) => call.method === "outstandingSessions")).toHaveLength(3)
    } finally { await test.bridge.close() }
  })
  test("repeated status failures back off and a successful read resets retries", async () => {
    let reads = 0
    let running = false
    const test = harness({ results: { outstandingSessions: () => {
      if ([1, 2, 3, 5].includes(++reads)) throw new Error("transient status read")
      return { data: running ? ["ses_1"] : [], running: running ? ["ses_1"] : [], failed: [] }
    } } })
    await test.bridge.connect()
    try {
      await waitFor(() => sentFrames(test.records[0]).find((frame) => frame.type === "status"))
      expect(reads).toBe(4)
      await Bun.sleep(30)
      expect(reads).toBe(4)
      running = true
      test.streams[0].stream.onEvent({ type: "session.execution.started.1", data: { sessionID: "ses_1" } })
      await waitFor(() => sentFrames(test.records[0]).find((frame) => frame.type === "status" && frame.running.includes("ses_1")))
      expect(reads).toBe(6)
    } finally { await test.bridge.close() }
  })
  test("disconnect cancels a pending status-read retry until the connection reopens", async () => {
    let reads = 0
    const test = harness({ results: { outstandingSessions: () => {
      if (++reads === 1) throw new Error("transient status read")
      return { data: [], running: [], failed: [] }
    } } })
    await test.bridge.connect()
    try {
      await waitFor(() => test.diagnostics.find((message) => message.startsWith("could not read remote Session status")))
      test.records[0].input.onClose(1012)
      await Bun.sleep(30)
      expect(reads).toBe(1)
      test.records[0].input.onOpen()
      await waitFor(() => sentFrames(test.records[0]).find((frame) => frame.type === "status"))
      await Bun.sleep(30)
      expect(reads).toBe(2)
    } finally { await test.bridge.close() }
  })
  test("connection replacement cancels the predecessor's status-read retry", async () => {
    let reads = 0
    const test = harness({ results: { outstandingSessions: () => {
      if (++reads === 1) throw new Error("transient status read")
      return { data: [], running: [], failed: [] }
    } } })
    await test.bridge.connect()
    try {
      await waitFor(() => test.diagnostics.find((message) => message.startsWith("could not read remote Session status")))
      test.records[0].input.onClose(RemoteCloseCode.unauthorized)
      await waitFor(() => test.records[1] && sentFrames(test.records[1]).find((frame) => frame.type === "status"))
      await Bun.sleep(30)
      expect(reads).toBe(2)
    } finally { await test.bridge.close() }
  })
  test("a read settling after the same connection reopens cannot release the new read", async () => {
    const first = Promise.withResolvers<unknown>()
    const second = Promise.withResolvers<unknown>()
    let reads = 0
    const test = harness({ results: { outstandingSessions: () => {
      if (++reads === 1) return first.promise
      if (reads === 2) return second.promise
      return { data: [], running: [], failed: [] }
    } } })
    await test.bridge.connect()
    try {
      await waitFor(() => reads === 1 ? true : undefined)
      test.records[0].input.onClose(1012)
      test.records[0].input.onOpen()
      await waitFor(() => reads === 2 ? true : undefined)
      first.reject(new Error("old read failed"))
      await waitFor(() => test.diagnostics.find((message) => message.startsWith("could not read remote Session status")))
      test.streams[0].stream.onEvent({ type: "session.execution.started.1", data: { sessionID: "ses_1" } })
      await Bun.sleep(300)
      expect(reads).toBe(2)
      second.resolve({ data: [], running: [], failed: [] })
      await waitFor(() => reads === 3 ? true : undefined)
      expect(sentFrames(test.records[0]).filter((frame) => frame.type === "status")).toHaveLength(1)
    } finally { second.resolve({ data: [], running: [], failed: [] }); await test.bridge.close() }
  })
  test("reports the relay's policy close reason without hiding its cause", async () => {
    const test = harness({})
    await test.bridge.connect()
    try {
      test.records[0].input.onClose(RemoteCloseCode.policyViolation, "Agent message rate exceeded")
      expect(test.diagnostics).toContain("relay connection closed (code 1008, reason: Agent message rate exceeded); reconnecting")
    } finally { await test.bridge.close() }
  })
  test("relay cancellation aborts the local indexed message read", async () => {
    let signal: AbortSignal | undefined
    let aborted = false
    const test = harness({ results: { messageRead: async (_id: string, _location: unknown, _messageID: string, current: AbortSignal) => {
      signal = current
      return new Promise((_, reject) => current.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")) }, { once: true }))
    } } })
    await test.bridge.connect()
    try {
      test.records[0].deliver(requestFrame("session.message.stream", "ses_1", { messageID: "msg_large" }))
      await waitFor(() => signal)
      test.records[0].deliver({ type: "cancel", id: "req_1" })
      await waitFor(() => aborted ? true : undefined)
      expect(sentFrames(test.records[0]).some((frame) => frame.type === "response" && frame.id === "req_1")).toBe(false)
    } finally { await test.bridge.close() }
  })
  test("unknown future operation returns an immediate error on the same connection", async () => {
    const test = harness({})
    await test.bridge.connect()
    try {
      test.records[0].deliver(requestFrame("session.future.unknown", "ses_1"))
      const response = await waitFor(() => sentFrames(test.records[0]).find((frame) => frame.type === "response" && frame.id === "req_1"))
      expect(response).toMatchObject({ type: "response", id: "req_1", ok: false, error: { code: "unknown_operation" } })
    } finally { await test.bridge.close() }
  })
  test("disconnect invalidates uploaded bytes before a replacement connection can admit a prompt", async () => {
    const test = harness({ results: { prompt: { id: "msg_1" } } })
    await test.bridge.connect()
    try {
      const uploadID = "4ab94d33-6e6b-41a3-a638-f0a6596854a9"
      test.records[0].deliver(requestFrame("session.attachment.upload", "ses_1", { uploadID, index: 0, last: true, data: "aGVsbG8=" }))
      await waitFor(() => sentFrames(test.records[0]).find((frame) => frame.type === "response" && frame.ok))
      test.records[0].input.onClose(RemoteCloseCode.unauthorized)
      await waitFor(() => test.records[1])
      test.records[1].deliver(requestFrame("session.prompt", "ses_1", { text: "Review", files: [{ uri: `ycoding-upload://${uploadID}` }] }))
      const refused = await waitFor(() => sentFrames(test.records[1]).find((frame) => frame.type === "response" && !frame.ok))
      expect(refused).toMatchObject({ error: { code: "invalid_message" } })
      expect(test.calls.some((call) => call.method === "prompt")).toBe(false)
    } finally { await test.bridge.close() }
  })
  test("a superseded relay connection cannot upload bytes into its replacement", async () => {
    const test = harness({ results: { prompt: { id: "msg_1" } } })
    await test.bridge.connect()
    try {
      test.records[0].input.onClose(RemoteCloseCode.unauthorized)
      await waitFor(() => test.records[1])
      const uploadID = "4ab94d33-6e6b-41a3-a638-f0a6596854a9"
      test.records[0].deliver(requestFrame("session.attachment.upload", "ses_1", { uploadID, index: 0, last: true, data: "aGVsbG8=" }))
      await Bun.sleep(10)
      test.records[1].deliver(requestFrame("session.prompt", "ses_1", { text: "Review", files: [{ uri: `ycoding-upload://${uploadID}` }] }))
      const refused = await waitFor(() => sentFrames(test.records[1]).find((frame) => frame.type === "response" && !frame.ok))
      expect(refused).toMatchObject({ error: { code: "invalid_message" } })
      expect(test.calls.some((call) => call.method === "prompt")).toBe(false)
    } finally { await test.bridge.close() }
  })
  test("late close from an old connection cannot clear the replacement upload", async () => {
    const test = harness({ results: { prompt: { id: "msg_1" } } })
    await test.bridge.connect()
    try {
      test.records[0].input.onClose(RemoteCloseCode.unauthorized)
      await waitFor(() => test.records[1])
      const uploadID = "4ab94d33-6e6b-41a3-a638-f0a6596854a9"
      test.records[1].deliver(requestFrame("session.attachment.upload", "ses_1", { uploadID, index: 0, last: true, data: "aGVsbG8=" }))
      await waitFor(() => sentFrames(test.records[1]).find((frame) => frame.type === "response" && frame.ok))
      test.records[0].input.onClose(RemoteCloseCode.unauthorized)
      test.records[1].deliver(requestFrame("session.prompt", "ses_1", { text: "Review", files: [{ uri: `ycoding-upload://${uploadID}` }] }))
      const admitted = await waitFor(() => sentFrames(test.records[1]).find((frame) => frame.type === "response" && frame.ok && typeof frame.value === "object" && frame.value !== null && "data" in frame.value))
      expect(admitted).toMatchObject({ ok: true, value: { data: { id: "msg_1" } } })
    } finally { await test.bridge.close() }
  })
  test("execution-only status changes read active state without rescanning pending requests", async () => {
    let active: readonly string[] = []
    const sessions = Array.from({ length: 100 }, (_, index) => ({ sessionID: `ses_${index}`, directory: "/work", title: "Session" }))
    const test = harness({ sessions, results: { outstandingSessions: () => ({ data: active, running: active, failed: [] }) } })
    await test.bridge.connect()
    try {
      await waitFor(() => sentFrames(test.records[0]).find((frame) => frame.type === "status"), 1_000)
      await waitFor(() => sentFrames(test.records[0]).filter((frame) => frame.type === "completions" && !frame.more).length >= 2 ? true : undefined)
      test.calls.length = 0
      active = ["ses_1"]
      test.streams[0].stream.onEvent({ type: "session.step.started", data: { sessionID: "ses_1" } })
      await waitFor(() => sentFrames(test.records[0]).some((frame) => frame.type === "status" && frame.running.includes("ses_1")) ? true : undefined, 1_000)
      expect(test.calls.map((call) => call.method)).toEqual(["outstandingSessions"])
    } finally { await test.bridge.close() }
  })

  test("a replaced connection sends its initial status while its predecessor read is held", async () => {
    const held = Promise.withResolvers<unknown>()
    let first = true
    const test = harness({ results: { outstandingSessions: () => first ? held.promise : { data: [], running: [], failed: [] } } })
    await test.bridge.connect()
    try {
      first = false
      test.records[0].input.onClose(RemoteCloseCode.unauthorized)
      await waitFor(() => test.records[1], 1_000)
      await waitFor(() => sentFrames(test.records[1]).find((frame) => frame.type === "status"), 200)
      expect(sentFrames(test.records[1]).filter((frame) => frame.type === "status")).toEqual([{ type: "status", running: [], attention: [] }])
    } finally { held.resolve({ data: [], running: [], failed: [] }); await test.bridge.close() }
  })

  test("sends an initial family status and coalesces transition bursts to the latest frame", async () => {
    let active: readonly string[] = []
    let permissions: unknown[] = []
    const test = harness({ results: {
      outstandingSessions: () => ({ data: active, running: active, failed: [] }),
      permissionRequests: () => permissions,
    } })
    await test.bridge.connect()
    try {
      await waitFor(() => sentFrames(test.records[0]).find((frame) => frame.type === "status"))
      expect(sentFrames(test.records[0]).filter((frame) => frame.type === "status")).toEqual([{ type: "status", running: [], attention: [] }])
      const stream = test.streams[0].stream
      for (let index = 0; index < 30; index += 1) {
        active = index % 2 === 0 || index === 29 ? ["ses_1"] : []
        permissions = index === 29 ? [{ id: "per_1", sessionID: "ses_1" }] : []
        stream.onEvent({ type: index % 2 === 0 ? "session.step.started" : "permission.v2.asked", data: { sessionID: "ses_1" } })
      }
      await waitFor(() => sentFrames(test.records[0]).filter((frame) => frame.type === "status").length === 2 ? true : undefined, 1_000)
      expect(sentFrames(test.records[0]).filter((frame) => frame.type === "status")).toEqual([
        { type: "status", running: [], attention: [] },
        { type: "status", running: ["ses_1"], attention: ["ses_1"], details: [{ sessionID: "ses_1", title: "One", need: "permission" }] },
      ])
    } finally { await test.bridge.close() }
  })

  test("invalidates Session lists on connect and refuses backend-unknown IDs", async () => {
    const { bridge, records, calls, diagnostics } = harness({})
    await bridge.connect()

    expect(records).toHaveLength(1)
    expect(sessionsFrame(records[0])).toEqual({ type: "sessions" })

    records[0].deliver(requestFrame("session.messages", "ses_9"))
    await waitFor(() => sentFrames(records[0]).some((frame) => frame.type === "response") ? true : undefined)
    const refused = sentFrames(records[0]).filter((frame) => frame.type === "response")[0]
    expect(refused).toMatchObject({ ok: false, error: { code: "session_not_allowed" } })
    expect(calls.some((call) => call.method === "messages")).toBe(false)

    const before = records[0].sent.length
    records[0].deliver({ type: "not-a-frame" })
    records[0].deliver("not json")
    await Bun.sleep(5)
    expect(records[0].sent.length).toBe(before)
    expect(diagnostics.filter((message) => message.startsWith("ignored an inbound frame"))).toHaveLength(2)

    await bridge.close()
  })

  test("answers each request once, chunking large responses in order", async () => {
    const large = { data: Array.from({ length: 20_000 }, (_, index) => ({ index, text: `line ${index} "quoted"` })) }
    const { bridge, records } = harness({ results: { messages: async () => large.data } })
    await bridge.connect()
    records[0].sent.length = 0

    records[0].deliver(requestFrame("session.messages", "ses_1"))
    await waitFor(() => sentFrames(records[0]).some((frame) => frame.type === "response" && frame.ok && frame.chunk?.last) ? true : undefined, 5_000)

    const responses = sentFrames(records[0]).filter((frame) => frame.type === "response")
    expect(responses.length).toBeGreaterThan(1)
    const parts: string[] = []
    for (const [index, frame] of responses.entries()) {
      const chunked = frame as { ok: true; value: string; chunk: { index: number; last: boolean } }
      expect(chunked.chunk.index).toBe(index)
      expect(chunked.chunk.last).toBe(index === responses.length - 1)
      expect(JSON.stringify(frame).length).toBeLessThanOrEqual(RemoteLimits.maxAgentMessageChars)
      parts.push(chunked.value)
    }
    const reassembled = parseChunkedValue(parts)
    expect(reassembled.ok).toBe(true)
    if (reassembled.ok) expect(reassembled.value).toEqual(large)

    await bridge.close()
  })

  test("keeps one local event stream for many subscribers and never unsubscribes another client's session", async () => {
    const { bridge, records, streams } = harness({ sessions: [entry, second] })
    await bridge.connect()
    const connection = records[0]

    connection.deliver({ type: "subscriptions", clientID: "client-1", sessionIDs: ["ses_1"] })
    connection.deliver({ type: "subscriptions", clientID: "client-2", sessionIDs: ["ses_1", "ses_2"] })
    await Bun.sleep(5)
    expect(streams).toHaveLength(1)

    connection.deliver({ type: "subscriptions", clientID: "client-1", sessionIDs: [] })
    await Bun.sleep(5)
    expect(streams[0].stopped).toBe(false)

    streams[0].stream.onEvent({ type: "message.updated", data: { sessionID: "ses_2", text: "two" } })
    await waitFor(() => sentEvents(connection).length > 0 ? true : undefined)
    expect(sentEvents(connection)).toHaveLength(1)

    connection.deliver({ type: "subscriptions", clientID: "client-2", sessionIDs: [] })
    await Bun.sleep(5)
    expect(streams[0].stopped).toBe(false)

    // A redundant unsubscribe for an unknown session must not disturb the stream.
    connection.deliver({ type: "subscriptions", clientID: "client-2", sessionIDs: ["ses_2"] })
    await Bun.sleep(5)
    connection.deliver({ type: "subscriptions", clientID: "client-1", sessionIDs: [] })
    await Bun.sleep(5)
    expect(streams[0].stopped).toBe(false)

    await bridge.close()
  })

  test("forwards only relay-synchronized session events, in arrival order", async () => {
    const { bridge, records, streams } = harness({ sessions: [entry, second] })
    await bridge.connect()
    const connection = records[0]
    connection.deliver({ type: "subscriptions", clientID: "client-1", sessionIDs: ["ses_1"] })
    await Bun.sleep(5)

    connection.sent.length = 0
    const stream = streams[0].stream
    stream.onEvent({ type: "session.created", data: { sessionID: "ses_1" } })
    stream.onEvent({ type: "session.created", data: { sessionID: "ses_3" } })
    stream.onEvent({ type: "form.created", data: { sessionID: "ses_other", form: { id: "frm_1", sessionID: "ses_1" } } })
    stream.onEvent({ type: "form.replied", data: { id: "frm_1", sessionID: "ses_1", answer: { approved: true } } })
    stream.onEvent({ type: "form.cancelled", data: { id: "frm_2", sessionID: "ses_1" } })
    stream.onEvent({ type: "server.connected", data: {} })
    stream.onEvent({ type: "session.created", data: { sessionID: "ses_1" } })
    await waitFor(() => sentEvents(connection).length === 5 ? true : undefined, 2_000)

    const events = sentEvents(connection)
    expect(events).toEqual([
      { sessionID: "ses_1", event: { type: "session.created", data: { sessionID: "ses_1" } } },
      {
        sessionID: "ses_1",
        event: { type: "form.created", data: { sessionID: "ses_other", form: { id: "frm_1", sessionID: "ses_1" } } },
      },
      {
        sessionID: "ses_1",
        event: { type: "form.replied", data: { id: "frm_1", sessionID: "ses_1", answer: { approved: true } } },
      },
      {
        sessionID: "ses_1",
        event: { type: "form.cancelled", data: { id: "frm_2", sessionID: "ses_1" } },
      },
      { sessionID: "ses_1", event: { type: "session.created", data: { sessionID: "ses_1" } } },
    ])

    await bridge.close()
  })

  test("clears derived subscription interest on relay reconnect until fresh snapshots arrive", async () => {
    const { bridge, records, streams } = harness({})
    await bridge.connect()
    const connection = records[0]
    connection.deliver({ type: "subscriptions", clientID: "client-1", sessionIDs: ["ses_1"] })
    await Bun.sleep(5)

    connection.sent.length = 0
    streams[0].stream.onEvent({ type: "message.updated", data: { sessionID: "ses_1" } })
    await waitFor(() => sentEvents(connection).length > 0 ? true : undefined)
    expect(sentEvents(connection)).toHaveLength(1)

    connection.sent.length = 0
    connection.input.onClose(1012)
    connection.input.onOpen()
    streams[0].stream.onEvent({ type: "message.updated", data: { sessionID: "ses_1" } })
    await Bun.sleep(5)
    expect(sentEvents(connection)).toHaveLength(0)

    connection.deliver({ type: "subscriptions", clientID: "client-1", sessionIDs: ["ses_1"] })
    streams[0].stream.onEvent({ type: "message.updated", data: { sessionID: "ses_1" } })
    await waitFor(() => sentEvents(connection).length > 0 ? true : undefined)
    expect(sentEvents(connection)).toHaveLength(1)
    await bridge.close()
  })

  test("reports each relay close code and whether it will reconnect", async () => {
    const test = harness({})
    await test.bridge.connect()
    try {
      test.records[0].input.onClose(1012)
      expect(test.diagnostics.filter((message) => message.includes("relay connection closed"))).toEqual([
        "relay connection closed (code 1012); reconnecting",
      ])
    } finally { await test.bridge.close() }
  })

  test("diagnostics never include raw Error or string details from local failures", async () => {
    for (const cause of [new Error("Bearer synthetic-token payload=private"), "Bearer synthetic-token payload=private"]) {
      const test = harness({ results: { outstandingSessions: () => Promise.reject(cause) } })
      await test.bridge.connect()
      try {
        await waitFor(() => test.diagnostics.find((message) => message.startsWith("could not read remote Session status")))
        expect(test.diagnostics.join(" ")).not.toContain("synthetic-token")
        expect(test.diagnostics.join(" ")).not.toContain("payload=private")
      } finally { await test.bridge.close() }
    }
  })

  test("retries the inventory event stream with zero subscriptions and stops retrying after close", async () => {
    let created = false
    const { bridge, records, streams } = harness({ results: {
      listPage: async () => ({ data: created ? [sessionInfo("ses_1"), sessionInfo("ses_new")] : [sessionInfo("ses_1")] }),
    } })
    await bridge.connect()
    expect(streams).toHaveLength(1)
    records[0].sent.length = 0

    streams[0].stream.onEnd()
    await waitFor(() => (streams.length === 2 ? true : undefined))
    created = true
    streams[1].stream.onEvent({ type: "session.created", data: { sessionID: "ses_new" } })
    await waitFor(() => (sentFrames(records[0]).some((frame) => frame.type === "sessions") ? true : undefined))

    streams[1].stream.onFailure(new LocalFailure("transport", "ended"))
    await bridge.close()
    await Bun.sleep(15)
    expect(streams).toHaveLength(2)
  })

  test("retries when the event stream ends before its start promise resolves", async () => {
    let starts = 0
    let stops = 0
    const { bridge } = harness({
      results: {
        events: async (stream: LocalEventStream) => {
          starts++
          if (starts === 1) stream.onEnd()
          return async () => {
            stops++
          }
        },
      },
    })
    await bridge.connect()
    await waitFor(() => (starts === 2 ? true : undefined))
    expect(stops).toBe(1)
    await bridge.close()
    expect(stops).toBe(2)
  })

  test("invalidates an oversized event without closing the connection or forwarding its payload", async () => {
    const { bridge, records, streams, diagnostics } = harness({})
    await bridge.connect()
    records[0].deliver({ type: "subscriptions", clientID: "client-1", sessionIDs: ["ses_1"] })
    await Bun.sleep(5)
    const before = records.length

    streams[0].stream.onEvent({ id: "evt_big", type: "session.tool.progress", durable: { aggregateID: "ses_1", seq: 7, version: 2 }, data: { sessionID: "ses_1", assistantMessageID: "msg_large", text: "x".repeat(300_000) } })
    await waitFor(() => sentEvents(records[0]).length > 0 ? true : undefined)

    expect(sentEvents(records[0])).toMatchObject([{ sessionID: "ses_1", event: { id: "evt_big", type: "session.remote.oversized", durable: { aggregateID: "ses_1", seq: 7, version: 2 }, data: { sessionID: "ses_1", messageID: "msg_large", truncated: true } } }])
    const replacement = sentEvents(records[0])[0]
    const data = typeof replacement?.event === "object" && replacement.event !== null ? Reflect.get(replacement.event, "data") : undefined
    const omitted: unknown = data && typeof data === "object" ? Reflect.get(data, "omittedChars") : undefined
    expect(typeof omitted).toBe("number")
    if (typeof omitted !== "number") throw new Error("Oversized marker lacks an omitted character count")
    expect(omitted).toBeGreaterThan(262_144)
    expect(records[0].disconnected).toBe(false)
    expect(records.length).toBe(before)
    expect(diagnostics.some((message) => message.includes("oversized"))).toBe(true)

    await bridge.close()
  })

  test("re-invalidates on reconnect and after the backend inventory changes", async () => {
    let available = true
    const { bridge, records } = harness({
      results: {
        listPage: async () => ({ data: available ? [sessionInfo("ses_1")] : [] }),
        getSession: async (sessionID: string) => {
          if (!available) throw new LocalFailure("not_found", "gone")
          return sessionInfo(sessionID)
        },
      },
    })
    await bridge.connect()
    const connection = records[0]

    connection.sent.length = 0
    connection.input.onClose(1012)
    connection.input.onOpen()
    await Bun.sleep(5)
    expect(sessionsFrame(connection)).toEqual({ type: "sessions" })

    available = false
    await bridge.republish()
    expect(sessionsFrame(connection)).toEqual({ type: "sessions" })
    expect(bridge.advertised).toEqual([])

    await bridge.close()
  })

  test("does not re-advertise unchanged inventory and re-advertises same-ID metadata changes", async () => {
    let title = "Initial"
    let pinned: number | undefined
    let directory = "/work"
    const { bridge, records } = harness({
      results: { listPage: async () => ({ data: [{ ...sessionInfo("ses_1", { directory }), title, time: { created: 1, updated: 1, ...(pinned === undefined ? {} : { pinned }) } }] }) },
    })
    await bridge.connect()
    const connection = records[0]
    connection.sent.length = 0
    await bridge.republish()
    expect(connection.sent.filter((frame) => frame.includes('"type":"sessions"'))).toHaveLength(0)
    title = "Renamed"
    await bridge.republish()
    await waitFor(() => connection.sent.filter((frame) => frame.includes('"type":"sessions"')).length === 1 ? true : undefined)
    expect(connection.sent.filter((frame) => frame.includes('"type":"sessions"'))).toHaveLength(1)
    pinned = 2
    await bridge.republish()
    await waitFor(() => connection.sent.filter((frame) => frame.includes('"type":"sessions"')).length === 2 ? true : undefined)
    expect(connection.sent.filter((frame) => frame.includes('"type":"sessions"'))).toHaveLength(2)
    directory = "/work/moved"
    await bridge.republish()
    await waitFor(() => connection.sent.filter((frame) => frame.includes('"type":"sessions"')).length === 3 ? true : undefined)
    expect(connection.sent.filter((frame) => frame.includes('"type":"sessions"'))).toHaveLength(3)
    await bridge.close()
  })

  test("rotates the device credential once after an unauthorized close, then stops when the relay refuses it again", async () => {
    let credentials = 0
    const { bridge, records, diagnostics, terminal } = harness({
      credentials: async () => {
        credentials++
        return { accessToken: `token_${credentials}`, accessExpiresAt: 1_000_000 }
      },
    })
    await bridge.connect()
    expect(records[0].input.accessToken).toBe("token_1")

    records[0].input.onClose(RemoteCloseCode.unauthorized)
    await Bun.sleep(5)
    expect(records).toHaveLength(2)
    expect(records[1].input.accessToken).toBe("token_2")
    expect(records[0].disconnected).toBe(true)
    expect(bridge.currentState).toBe("live")

    records[1].input.onClose(RemoteCloseCode.unauthorized)
    await Bun.sleep(5)
    expect(records).toHaveLength(2)
    expect(bridge.currentState).toBe("terminal")
    expect(terminal).toHaveLength(1)
    expect(diagnostics.filter((message) => message.includes("relay connection closed"))).toEqual([
      `relay connection closed (code ${RemoteCloseCode.unauthorized}); reconnecting`,
      `relay connection closed (code ${RemoteCloseCode.unauthorized}); not reconnecting`,
    ])

    await bridge.close()
  })

  test("stops when the relay reports the device as revoked during rotation", async () => {
    let calls = 0
    const { bridge, records, terminal } = harness({
      credentials: async () => {
        calls++
        if (calls > 1) throw new DeviceAuthorizationError(401)
        return { accessToken: "token_1", accessExpiresAt: 1_000_000 }
      },
    })
    await bridge.connect()
    records[0].input.onClose(RemoteCloseCode.forbidden)
    await Bun.sleep(5)

    expect(records).toHaveLength(1)
    expect(bridge.currentState).toBe("terminal")
    expect(terminal[0]).toContain("enroll")
    await bridge.close()
  })

  test("stops on an expired credential when rotation cannot mint a new one", async () => {
    let calls = 0
    const { bridge, records, diagnostics, terminal } = harness({
      credentials: async () => {
        calls++
        if (calls > 1) throw new Error("network down")
        return { accessToken: "token_1", accessExpiresAt: 1_000_000 }
      },
    })
    await bridge.connect()
    records[0].input.onClose(RemoteCloseCode.unauthorized)
    await Bun.sleep(5)

    expect(bridge.currentState).toBe("live")
    expect(diagnostics.some((message) => message.startsWith("could not rotate"))).toBe(true)
    expect(terminal).toEqual([])
    await bridge.close()
  })

  test("never replays an indeterminate mutation across reconnects", async () => {
    let calls = 0
    const { bridge, records } = harness({
      results: {
        prompt: async () => {
          calls++
          throw new LocalFailure("transport", "no answer")
        },
      },
    })
    await bridge.connect()
    const connection = records[0]
    connection.deliver(requestFrame("session.prompt", "ses_1", { text: "hello", id: "msg_1" }))
    await waitFor(() => sentFrames(connection).some((frame) => frame.type === "response") ? true : undefined)

    const response = sentFrames(connection).find((frame) => frame.type === "response")
    expect(response).toMatchObject({ ok: false, error: { code: "outcome_unknown" } })
    expect(calls).toBe(1)

    connection.sent.length = 0
    connection.input.onClose(1012)
    connection.input.onOpen()
    await Bun.sleep(5)
    expect(calls).toBe(1)
    expect(sentFrames(connection).filter((frame) => frame.type === "response")).toHaveLength(0)

    await bridge.close()
  })

  test("passes a prompt message id through unchanged for exact-retry reconciliation", async () => {
    const { bridge, records, calls } = harness({ results: { prompt: async () => ({ data: {} }) } })
    await bridge.connect()
    records[0].deliver(requestFrame("session.prompt", "ses_1", { text: "retry me", id: "msg_retry" }))
    await Bun.sleep(5)

    expect(calls.at(-1)).toEqual({
      method: "prompt",
      args: ["ses_1", { directory: "/work" }, { text: "retry me", id: "msg_retry" }],
    })
    await bridge.close()
  })
})

describe("remote bridge multiplexed delivery", () => {
  const messageEvent = (sessionID: string, index: number) => ({ type: "message.updated", data: { sessionID, index } })
  const eventFrames = (record: ConnectionRecord) => sentFrames(record).flatMap((frame) => (frame.type === "events" ? [frame] : []))
  const chunkIndexes = (record: ConnectionRecord) =>
    sentFrames(record).flatMap((frame) => (frame.type === "response" && frame.ok && frame.chunk !== undefined ? [frame.chunk.index] : []))
  const largeMessages = { messages: async () => Array.from({ length: 40_000 }, (_, index) => ({ index, text: `line ${index} "quoted"` })) }
  const unknownOperation = { ...requestFrame("session.future.unknown", "ses_1"), id: "req_2" }

  async function subscribed(options: Parameters<typeof harness>[0] = {}) {
    const test = harness({ sessions: [entry, second], ...options })
    await test.bridge.connect()
    const connection = test.records[0]
    connection.deliver({ type: "subscriptions", clientID: "client-1", sessionIDs: ["ses_1", "ses_2"] })
    await Bun.sleep(5)
    connection.sent.length = 0
    return { ...test, connection, emit: test.streams[0].stream.onEvent }
  }

  test("coalesces a burst for one session into one ordered events frame", async () => {
    const test = await subscribed()
    try {
      for (let index = 0; index < 10; index++) test.emit(messageEvent("ses_1", index))
      await waitFor(() => (eventFrames(test.connection).length > 0 ? true : undefined))
      await Bun.sleep(120)
      const frames = eventFrames(test.connection)
      expect(frames).toHaveLength(1)
      expect(frames[0].sessionID).toBe("ses_1")
      expect(frames[0].events).toEqual(Array.from({ length: 10 }, (_, index) => messageEvent("ses_1", index)))
    } finally { await test.bridge.close() }
  })

  test("splits a session burst at the shared batch bound and keeps its order", async () => {
    const test = await subscribed()
    try {
      const total = RemoteLimits.maxEventBatch + 6
      for (let index = 0; index < total; index++) test.emit(messageEvent("ses_1", index))
      await waitFor(() => (sentEvents(test.connection).length === total ? true : undefined), 2_000)
      const frames = eventFrames(test.connection)
      expect(frames.map((frame) => frame.events.length)).toEqual([RemoteLimits.maxEventBatch, 6])
      expect(sentEvents(test.connection).map((item) => Reflect.get(Reflect.get(item.event as object, "data") as object, "index"))).toEqual(Array.from({ length: total }, (_, index) => index))
    } finally { await test.bridge.close() }
  })

  test("serves control frames and event batches between bulk chunks without head-of-line blocking", async () => {
    const test = await subscribed({ results: largeMessages })
    try {
      test.connection.deliver(requestFrame("session.messages", "ses_1"))
      await waitFor(() => (chunkIndexes(test.connection).length > 0 ? true : undefined))
      test.connection.deliver(unknownOperation)
      for (let index = 0; index < 3; index++) {
        test.emit(messageEvent("ses_1", index))
        test.emit(messageEvent("ses_2", index))
      }
      await waitFor(() => sentFrames(test.connection).some((frame) => frame.type === "response" && frame.ok && frame.chunk?.last) ? true : undefined, 5_000)

      const frames = sentFrames(test.connection)
      const lastChunk = frames.findIndex((frame) => frame.type === "response" && frame.ok && frame.chunk?.last)
      const controlAt = frames.findIndex((frame) => frame.type === "response" && frame.id === "req_2")
      const eventSessions = frames.flatMap((frame, index) => (frame.type === "events" && index < lastChunk ? [frame.sessionID] : []))
      expect(controlAt).toBeGreaterThan(-1)
      expect(controlAt).toBeLessThan(lastChunk)
      expect(eventSessions.sort()).toEqual(["ses_1", "ses_2"])
      const indexes = chunkIndexes(test.connection)
      expect(indexes.length).toBeGreaterThan(4)
      expect(indexes).toEqual(indexes.map((_, index) => index))
    } finally { await test.bridge.close() }
  })

  test("uses the longer window while every subscribed client is background and restores 40 ms when one is interactive", async () => {
    const test = await subscribed()
    try {
      test.connection.deliver({ type: "priority", clientID: "client-1", mode: "background" })
      const started = Date.now()
      test.emit(messageEvent("ses_1", 0))
      await Bun.sleep(150)
      expect(eventFrames(test.connection)).toHaveLength(0)
      await waitFor(() => (eventFrames(test.connection).length > 0 ? true : undefined), 2_000)
      expect(Date.now() - started).toBeGreaterThanOrEqual(700)

      test.connection.sent.length = 0
      test.emit(messageEvent("ses_1", 1))
      const interactiveAt = Date.now()
      test.connection.deliver({ type: "subscriptions", clientID: "client-2", sessionIDs: ["ses_1"] })
      await waitFor(() => (eventFrames(test.connection).length > 0 ? true : undefined), 400)
      expect(Date.now() - interactiveAt).toBeLessThan(400)

      test.connection.sent.length = 0
      test.emit(messageEvent("ses_1", 2))
      await waitFor(() => (eventFrames(test.connection).length > 0 ? true : undefined), 400)
    } finally { await test.bridge.close() }
  })

  test("a client's priority stops applying once its subscriptions snapshot is empty", async () => {
    const test = await subscribed()
    try {
      test.connection.deliver({ type: "priority", clientID: "client-1", mode: "background" })
      test.connection.deliver({ type: "subscriptions", clientID: "client-1", sessionIDs: [] })
      test.connection.deliver({ type: "subscriptions", clientID: "client-1", sessionIDs: ["ses_1"] })
      test.emit(messageEvent("ses_1", 0))
      await waitFor(() => (eventFrames(test.connection).length > 0 ? true : undefined), 400)
    } finally { await test.bridge.close() }
  })

  test("defers bulk slices while the socket buffer is above the bound and resumes below it", async () => {
    const test = await subscribed({ results: largeMessages })
    try {
      test.connection.bufferedAmount = 256 * 1024 + 1
      test.connection.deliver(requestFrame("session.messages", "ses_1"))
      test.connection.deliver(unknownOperation)
      test.emit(messageEvent("ses_1", 0))
      await waitFor(() => (eventFrames(test.connection).length > 0 && sentFrames(test.connection).some((frame) => frame.type === "response" && frame.id === "req_2") ? true : undefined))
      await Bun.sleep(150)
      expect(chunkIndexes(test.connection)).toEqual([])

      test.connection.bufferedAmount = 256 * 1024
      await waitFor(() => sentFrames(test.connection).some((frame) => frame.type === "response" && frame.ok && frame.chunk?.last) ? true : undefined, 5_000)
      const indexes = chunkIndexes(test.connection)
      expect(indexes).toEqual(indexes.map((_, index) => index))
    } finally { await test.bridge.close() }
  })

  test("drops queued batches and bulk slices when the relay connection is replaced", async () => {
    const test = await subscribed({ results: largeMessages })
    try {
      test.connection.deliver({ type: "priority", clientID: "client-1", mode: "background" })
      test.connection.bufferedAmount = 256 * 1024 + 1
      test.connection.deliver(requestFrame("session.messages", "ses_1"))
      test.emit(messageEvent("ses_1", 99))
      await Bun.sleep(100)
      test.connection.sent.length = 0

      test.connection.input.onClose(1012)
      test.connection.input.onOpen()
      test.connection.bufferedAmount = 0
      test.connection.deliver({ type: "subscriptions", clientID: "client-1", sessionIDs: ["ses_1"] })
      test.emit(messageEvent("ses_1", 100))
      await waitFor(() => (sentEvents(test.connection).some((item) => Reflect.get(Reflect.get(item.event as object, "data") as object, "index") === 100) ? true : undefined))
      await Bun.sleep(900)
      expect(chunkIndexes(test.connection)).toEqual([])
      expect(sentEvents(test.connection).map((item) => Reflect.get(Reflect.get(item.event as object, "data") as object, "index"))).toEqual([100])
    } finally { await test.bridge.close() }
  })
})
