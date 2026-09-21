import { describe, expect, test } from "bun:test"
import type { SessionInfo } from "@ycoding-ai/client/promise"
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
}

function harness(options: {
  sessions?: readonly AllowlistSession[]
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
    ...options.results,
  })
  const records: ConnectionRecord[] = []
  const diagnostics: string[] = []
  const terminal: string[] = []
  let clock = 1_000
  let tokens = 0
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
      }
      const state = { disconnected: false }
      let handler: ((frame: unknown) => void) | undefined
      const connection: RelayConnection = {
        connect: async () => input.onOpen(),
        send: async (value: string) => {
          if (state.disconnected) throw new Error("Relay connection is closed")
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
      }
    },
    refreshIntervalMs: 3_600_000,
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

function sessionsFrame(record: ConnectionRecord) {
  const frames = sentFrames(record).filter((value) => value.type === "sessions")
  expect(frames.length).toBeGreaterThan(0)
  return frames.at(-1) as { type: "sessions" }
}

function requestFrame(operation: string, sessionID?: string, input?: Record<string, unknown>) {
  return { type: "request", id: "req_1", operation, ...(sessionID === undefined ? {} : { sessionID }), ...(input === undefined ? {} : { input }) }
}

describe("remote bridge", () => {
  test("invalidates Session lists on connect and refuses backend-unknown IDs", async () => {
    const { bridge, records, calls, diagnostics } = harness({})
    await bridge.connect()

    expect(records).toHaveLength(1)
    expect(sessionsFrame(records[0])).toEqual({ type: "sessions" })

    records[0].deliver(requestFrame("session.messages", "ses_9"))
    await Bun.sleep(5)
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
    await Bun.sleep(5)

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
    await Bun.sleep(5)
    expect(sentFrames(connection).filter((frame) => frame.type === "event")).toHaveLength(1)

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
    await Bun.sleep(5)

    const events = sentFrames(connection).filter((frame) => frame.type === "event")
    expect(events).toEqual([
      { type: "event", sessionID: "ses_1", event: { type: "session.created", data: { sessionID: "ses_1" } } },
      {
        type: "event",
        sessionID: "ses_1",
        event: { type: "form.created", data: { sessionID: "ses_other", form: { id: "frm_1", sessionID: "ses_1" } } },
      },
      {
        type: "event",
        sessionID: "ses_1",
        event: { type: "form.replied", data: { id: "frm_1", sessionID: "ses_1", answer: { approved: true } } },
      },
      {
        type: "event",
        sessionID: "ses_1",
        event: { type: "form.cancelled", data: { id: "frm_2", sessionID: "ses_1" } },
      },
      { type: "event", sessionID: "ses_1", event: { type: "session.created", data: { sessionID: "ses_1" } } },
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
    await Bun.sleep(5)
    expect(sentFrames(connection).filter((frame) => frame.type === "event")).toHaveLength(1)

    connection.sent.length = 0
    connection.input.onClose(1012)
    connection.input.onOpen()
    streams[0].stream.onEvent({ type: "message.updated", data: { sessionID: "ses_1" } })
    await Bun.sleep(5)
    expect(sentFrames(connection).filter((frame) => frame.type === "event")).toHaveLength(0)

    connection.deliver({ type: "subscriptions", clientID: "client-1", sessionIDs: ["ses_1"] })
    streams[0].stream.onEvent({ type: "message.updated", data: { sessionID: "ses_1" } })
    await Bun.sleep(5)
    expect(sentFrames(connection).filter((frame) => frame.type === "event")).toHaveLength(1)
    await bridge.close()
  })

  test("retries the inventory event stream with zero subscriptions and stops retrying after close", async () => {
    const { bridge, records, streams } = harness({})
    await bridge.connect()
    expect(streams).toHaveLength(1)
    records[0].sent.length = 0

    streams[0].stream.onEnd()
    await waitFor(() => (streams.length === 2 ? true : undefined))
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

  test("closes the connection for an oversized event frame and reconnects instead of truncating", async () => {
    const { bridge, records, streams, diagnostics } = harness({})
    await bridge.connect()
    records[0].deliver({ type: "subscriptions", clientID: "client-1", sessionIDs: ["ses_1"] })
    await Bun.sleep(5)
    const before = records.length

    streams[0].stream.onEvent({ type: "message.updated", data: { sessionID: "ses_1", text: "x".repeat(300_000) } })
    await Bun.sleep(10)

    expect(sentFrames(records[0]).filter((frame) => frame.type === "event")).toHaveLength(0)
    expect(records[0].disconnected).toBe(true)
    expect(records.length).toBe(before + 1)
    expect(sessionsFrame(records[1])).toEqual({ type: "sessions" })
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

  test("rotates the device credential once after an unauthorized close, then stops when the relay refuses it again", async () => {
    let credentials = 0
    const { bridge, records, terminal } = harness({
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
    await Bun.sleep(5)

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
